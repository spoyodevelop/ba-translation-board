import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import type { Client } from "@libsql/client";
import type { Source } from "../shared/post.ts";
import { boardConfigs } from "../shared/boards.ts";
import { sources } from "../shared/sites.ts";
import type { Board } from "../shared/boards.ts";
import { createJobRepository } from "../database/jobs.ts";
import { createWorkerStateRepository } from "../database/state.ts";
import type { JobLease, JobResult, WorkerJob } from "../database/types";
import { createWorkerRepositories } from "../database/repositories.ts";
import type { WorkerRepositories } from "../database/repositories.ts";
import type { WorkerLog } from "./log.ts";
import { candidateWindowMs } from "../grouping/findCandidates.ts";
import {
  createLeasedRepositoryClient,
  holdJobLease,
  LostJobLeaseError,
} from "./lease.ts";
import { createNodeRequest } from "./request.ts";
import { createRemoteCollector } from "./remote.ts";
import { createNodePostCollector } from "./collect.ts";
import type { TitleEvaluator } from "../grouping/evaluateWithJev.ts";
import { createBoardPipelines } from "./boardPipelines.ts";
import type { BoardJobContext } from "./boardPipelines.ts";
import type { AliasStore } from "../grouping/creativeAuthors.ts";
import { fetchArticleBody } from "../sources/fetchBody.ts";
import { describeError } from "./describeError.ts";
import { noCrashReports } from "./crashReports.ts";
import type { CrashReporter } from "./crashReports.ts";
import type { startArcaBrowser } from "./arcaBrowser.ts";

const collectionIntervalMs = 10 * 60_000;
const arcaEventDebounceMs = 1500;
const jobLeaseMs = 60_000;
const leaseRenewalIntervalMs = 10_000;
const recentGroupingLimit = 20;
const jobErrorSummaryLimit = 5;
const initialJobRetryDelayMs = 30_000;
const maxJobRetryDelayMs = 5 * 60_000;

// 실패한 작업은 30초 뒤에 다시 시도하고, 시도할 때마다 두 배로 늘려 5분에서 멈춘다.
function jobRetryDelayMs(attempt: number): number {
  return Math.min(
    maxJobRetryDelayMs,
    initialJobRetryDelayMs * 2 ** (attempt - 1),
  );
}
const finishedJobPruneIntervalMs = 24 * 60 * 60_000;

export function createWorkerRuntime(deps: {
  client: Client;
  // 일정에 올릴 board다. 창작 수집은 운영에서 켤 때까지 빼 둘 수 있다.
  boards: Board[];
  request?: typeof fetch;
  // 번역 글의 제목 쌍을 판정한다. 운영에서는 JEV_KEY로 만든 Jev 평가기다.
  evaluateTitles: TitleEvaluator;
  arca?: Pick<
    Awaited<ReturnType<typeof startArcaBrowser>>,
    "request" | "fetchBody"
  >;
  now?: () => number;
  log?: WorkerLog;
  // 창작 작가 별칭이다. 사람이 운영 서버의 파일을 고치면 다음 작업부터 반영되도록 작업마다 읽는다.
  loadCreativeAliases: () => Promise<AliasStore>;
  // 감시는 board·사이트마다 따로다. 한 board의 성공이 다른 board의 장애를 가리지 않게 한다.
  reportCollectionSuccess?: (
    board: Board,
    source: Source,
    signal: AbortSignal,
  ) => Promise<void>;
  crashReports?: CrashReporter;
  execute?: (
    job: WorkerJob,
    repositories: WorkerRepositories,
    signal: AbortSignal,
  ) => Promise<JobResult>;
}) {
  const now = deps.now || Date.now;
  const crashReports = deps.crashReports || noCrashReports;
  const log =
    deps.log ||
    ((event) =>
      console.log(
        JSON.stringify({ at: new Date(now()).toISOString(), ...event }),
      ));
  if (deps.boards.length === 0) throw new Error("수집할 board가 없습니다.");
  const jobs = createJobRepository(deps.client);
  const collectionState = createWorkerStateRepository(deps.client);
  const pipelines = createBoardPipelines({
    evaluateTitles: deps.evaluateTitles,
    loadCreativeAliases: deps.loadCreativeAliases,
  });
  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  let arcaRequestedAt: number | null = null;
  // 하루 한 번이면 충분하므로 마지막 정리 시각을 메모리에만 둔다. 재시작하면 한 번 더 정리할 뿐이다.
  let finishedJobsPrunedAt: number | null = null;

  async function execute(
    job: WorkerJob,
    scoped: WorkerRepositories,
    signal: AbortSignal,
  ): Promise<JobResult> {
    const board = boardConfigs[job.request.board];
    const pipeline = pipelines[job.request.board];
    const base = createNodeRequest(deps.request);
    const request: typeof fetch = (input, init) => {
      const original = new Request(input, init);
      const options = { signal: AbortSignal.any([signal, original.signal]) };
      if (deps.arca && new URL(original.url).hostname === "arca.live")
        return deps.arca.request(original, options);
      return base(original, options);
    };
    const sleep = async (ms: number) => {
      await pause(ms, undefined, { signal });
    };
    const collector = createNodePostCollector({
      repositories: scoped,
      remote: createRemoteCollector(request),
      board,
      now,
      sleep,
    });
    const context: BoardJobContext = {
      repositories: scoped,
      request,
      fetchBody: (post) => {
        if (deps.arca && post.source === "arca")
          return deps.arca.fetchBody(post, signal);
        return fetchArticleBody(post, request);
      },
      signal,
      now,
      sleep,
      log: (event) => log({ ...event, jobId: job.id }),
    };
    const result = { collectedCount: 0, comparedCount: 0, groupedCount: 0 };
    const errors: string[] = [];
    if (job.request.type === "collect") {
      const sourcesToCollect =
        job.request.source === "all"
          ? sources
          : [job.request.source];
      for (const source of sourcesToCollect) {
        signal.throwIfAborted();
        const state = (await scoped.state.list()).find(
          (entry) =>
            entry.source === source && entry.board === board.board,
        );
        const alreadyCollected =
          job.attempts > 1 &&
          state?.state === "idle" &&
          state.lastSuccessAt !== null &&
          state.lastSuccessAt >= job.createdAt;
        // 판정만 실패한 재시도에서는 성공한 목록을 다시 요청하지 않는다.
        if (alreadyCollected) {
          result.collectedCount += state.lastCount;
          continue;
        }
        try {
          result.collectedCount += await collector.collect(source);
          log({
            event: "collected",
            jobId: job.id,
            board: board.board,
            source,
            count: result.collectedCount,
          });
          // 감시 서비스 장애가 성공한 수집을 재시도로 바꾸면 안 된다.
          try {
            await deps.reportCollectionSuccess?.(board.board, source, signal);
          } catch (error) {
            log({
              event: "healthcheck-ping-error",
              jobId: job.id,
              board: board.board,
              source,
              error: describeError(error),
            });
          }
        } catch (error) {
          signal.throwIfAborted();
          errors.push(describeError(error));
          log({
            event: "collection-error",
            jobId: job.id,
            source,
            error: errors[errors.length - 1],
          });
        }
      }
      const deletedCount = await scoped.posts.pruneExpired(now());
      if (deletedCount > 0)
        log({ event: "posts-pruned", jobId: job.id, deletedCount });
    }
    const grouper = await pipeline.createGrouper(context);
    let since = now() - candidateWindowMs;
    let limit = recentGroupingLimit;
    if (job.request.type === "backfill") {
      since = 0;
      limit = job.request.limit;
    }
    const targets = await scoped.posts.findUnprocessed(
      since,
      pipeline.groupingVersion,
      limit,
    );
    for (const target of targets) {
      signal.throwIfAborted();
      try {
        const grouped = await grouper.process(target);
        result.comparedCount += grouped.comparedCount;
        result.groupedCount += grouped.groupedCount;
        log({ event: "grouped", jobId: job.id, postId: target.id, ...grouped });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof LostJobLeaseError) throw error;
        errors.push(describeError(error));
        crashReports.groupingFailed(target.id, error);
        log({
          event: "grouping-error",
          jobId: job.id,
          postId: target.id,
          error: errors[errors.length - 1],
        });
      }
    }
    await pipeline.afterGrouping?.(context);
    await scoped.caches.pruneExpired(now());
    await scoped.artists.pruneOrphans();
    if (errors.length > 0)
      throw new Error(errors.slice(0, jobErrorSummaryLimit).join("; "));
    return result;
  }

  // 실패한 작업은 대기열로 돌려 다음 시도를 예약한다. 글마다 커밋한 판정은 남고, 끝내지 못한 글은 다음 시도에서 다시 고른다.
  async function recordJobFailure(
    job: WorkerJob,
    lease: JobLease,
    error: unknown,
    shutdown: AbortSignal,
  ) {
    const message = describeError(error);
    const saved = await jobs.fail(
      lease,
      message,
      now(),
      now() + jobRetryDelayMs(job.attempts),
    );
    const retryScheduled = saved && job.attempts < job.maxAttempts;
    log({ event: "job-error", jobId: job.id, error: message, retryScheduled });
    // 소유권을 잃은 작업은 다른 worker가 이어받으므로 최종 실패가 아니다.
    const finallyFailed = saved && !retryScheduled && !shutdown.aborted;
    if (finallyFailed) crashReports.jobFailed(job.request, message);
    shutdown.throwIfAborted();
  }

  return {
    requestArcaCollection() {
      if (arcaRequestedAt === null) arcaRequestedAt = now();
    },
    async schedule() {
      const jobPruneDue =
        finishedJobsPrunedAt === null ||
        now() - finishedJobsPrunedAt >= finishedJobPruneIntervalMs;
      if (jobPruneDue) {
        const deletedCount = await jobs.pruneFinished(now());
        finishedJobsPrunedAt = now();
        if (deletedCount > 0) log({ event: "jobs-pruned", deletedCount });
      }
      const arcaDue =
        arcaRequestedAt !== null &&
        now() - arcaRequestedAt >= arcaEventDebounceMs;
      if (arcaDue) {
        const cooldown = await collectionState.nextRequestAt("arca-list");
        if (cooldown <= now()) {
          // 아카 새 글 알림은 채널 전체 단위라 어느 카테고리 글인지 모른다. 켜진 board를 모두 수집한다.
          let allQueued = true;
          for (const board of deps.boards) {
            const job = await jobs.enqueue(
              { type: "collect", board, source: "arca" },
              now(),
            );
            if (job.state !== "queued" || job.attempts !== 0) allQueued = false;
          }
          // 실행 중 도착한 이벤트는 작업이 끝난 뒤 다음 수집으로 넘긴다.
          if (allQueued) arcaRequestedAt = null;
        }
      }
      const states = await collectionState.list();
      for (const state of states) {
        if (!deps.boards.includes(state.board)) continue;
        const due =
          state.lastAttemptAt === null ||
          now() - state.lastAttemptAt >= collectionIntervalMs;
        if (!due) continue;
        const cooldown = await collectionState.nextRequestAt(
          `${state.source}-list`,
        );
        if (cooldown > now()) continue;
        await jobs.enqueue(
          { type: "collect", board: state.board, source: state.source },
          now(),
        );
      }
    },
    async runOne(shutdown: AbortSignal): Promise<boolean> {
      shutdown.throwIfAborted();
      const job = await jobs.claim(workerId, now(), jobLeaseMs);
      if (!job) return false;
      if (!job.leaseToken || job.leaseUntil === null)
        throw new Error("작업 소유권 토큰이 없습니다.");
      const lease = { jobId: job.id, token: job.leaseToken };
      const held = holdJobLease({
        lease,
        leaseUntil: job.leaseUntil,
        leaseMs: jobLeaseMs,
        renewalIntervalMs: leaseRenewalIntervalMs,
        renew: jobs.renew,
        now,
        onRenewalError: (error) =>
          log({
            event: "lease-renewal-error",
            jobId: job.id,
            error: describeError(error),
          }),
      });
      const signal = AbortSignal.any([shutdown, held.signal]);
      log({
        event: "job-started",
        jobId: job.id,
        request: job.request,
        attempt: job.attempts,
      });
      try {
        const scoped = createWorkerRepositories(
          createLeasedRepositoryClient(deps.client, lease, now),
          job.request.board,
        );
        const result = await (deps.execute || execute)(job, scoped, signal);
        signal.throwIfAborted();
        await held.release();
        if (!(await jobs.complete(lease, result, now())))
          throw new LostJobLeaseError();
        log({ event: "job-completed", jobId: job.id, result });
      } catch (error) {
        await held.release();
        await recordJobFailure(job, lease, error, shutdown);
      }
      return true;
    },
  };
}
