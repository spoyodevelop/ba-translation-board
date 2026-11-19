import type { Post } from "../shared/post";
import { siteAddresses, sources } from "../shared/sites.ts";
import type { SourceLookupSuccess, SourceLookupResult } from "./types";
import { extractBodyImage, extractSources } from "./extractSources.ts";
import { SourceRequestError } from "./requestError.ts";
import { decideFailure, type FailureDecision } from "./failurePolicy.ts";
import { siteAdapters } from "./siteAdapters.ts";

const maxInlineRequestWaitMs = 20_000;

type Source = Post["source"];

type Dependencies = {
  cache: {
    read: (id: string) => Promise<SourceLookupSuccess | undefined>;
    save: (id: string, result: SourceLookupResult) => Promise<void>;
  };
  fetchBody: (post: Post) => Promise<string>;
  readNextRequestAt: () => Promise<number>;
  saveNextRequestAt: (time: number) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type RequestOutcome = {
  post: Post;
  result: SourceLookupResult;
  // 성공이면 없다.
  failure?: FailureDecision;
};

type Results = Record<string, SourceLookupResult>;

function failedResult(error: string): SourceLookupResult {
  return { kind: "failed", error };
}

export function createSourceCollector(deps: Dependencies) {
  const now = deps.now || Date.now;
  const sleep =
    deps.sleep ||
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let queue: Promise<unknown> = Promise.resolve();

  async function parseAndCache(post: Post, body: string) {
    const result = extractSources(body);
    const imageUrl = extractBodyImage(body, siteAddresses[post.source].origin);
    if (imageUrl) result.imageUrl = imageUrl;
    try {
      await deps.cache.save(post.id, result);
    } catch {
      throw new SourceRequestError("출처 캐시 저장에 실패했습니다.", "storage");
    }
    return result;
  }

  async function requestOne(post: Post, attempt: number): Promise<RequestOutcome> {
    try {
      const body = await deps.fetchBody(post);
      return { post, result: await parseAndCache(post, body) };
    } catch (error) {
      const failure = decideFailure(
        error,
        siteAdapters[post.source].body,
        attempt,
      );
      return {
        post,
        failure,
        result: {
          kind: "failed",
          error: failure.detail.message,
          status: failure.detail.status,
        },
      };
    }
  }

  // A long server Retry-After survives worker restart; do not hold a message
  // open waiting for minutes or ignore the server's deadline.
  async function waitForRequestSlot(): Promise<"ready" | "too-long"> {
    const wait = Math.max(0, (await deps.readNextRequestAt()) - now());
    if (wait > maxInlineRequestWaitMs) return "too-long";
    if (wait > 0) await sleep(wait);
    return "ready";
  }

  function markFailed(posts: Post[], message: string, results: Results) {
    for (const post of posts) results[post.id] = failedResult(message);
  }

  // 배치 하나를 재시도 포함해 끝까지 처리한다. 수집을 중단해야 하면 true.
  async function collectBatch(
    batch: Post[],
    source: Source,
    results: Results,
  ): Promise<boolean> {
    const { batchPauseMs, maxAttempts } = siteAdapters[source].body;
    let remaining = batch;
    for (
      let attempt = 1;
      attempt <= maxAttempts && remaining.length > 0;
      attempt += 1
    ) {
      const slot = await waitForRequestSlot();
      if (slot === "too-long") {
        markFailed(
          remaining,
          "요청 대기 중입니다. 나중에 다시 확인해 주세요.",
          results,
        );
        return true;
      }
      const outcomes = await Promise.all(
        remaining.map((post) => requestOne(post, attempt)),
      );
      let pauseMs = batchPauseMs;
      let stopped = false;
      const retry: Post[] = [];
      for (const { post, result, failure } of outcomes) {
        results[post.id] = result;
        if (!failure) continue;
        pauseMs = Math.max(pauseMs, failure.pauseMs);
        if (failure.shouldRetry) retry.push(post);
        if (failure.stopsCollection) stopped = true;
      }
      await deps.saveNextRequestAt(now() + pauseMs);
      if (stopped) return true;
      remaining = retry;
    }
    return false;
  }

  async function collectSource(
    posts: Post[],
    source: Source,
    results: Results,
    refresh: boolean,
  ) {
    const pending: Post[] = [];
    for (const post of posts.filter((post) => post.source === source)) {
      const cached = refresh ? undefined : await deps.cache.read(post.id);
      if (cached) results[post.id] = cached;
      else pending.push(post);
    }
    const { batchSize } = siteAdapters[source].body;
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const stopped = await collectBatch(batch, source, results);
      if (stopped) {
        markFailed(
          pending.slice(offset + batchSize),
          "차단 또는 반복 오류로 이번 수집을 중단했습니다.",
          results,
        );
        return;
      }
    }
  }

  async function lookup(posts: Post[], refresh: boolean): Promise<Results> {
    const results: Results = {};
    for (const source of sources) {
      await collectSource(posts, source, results, refresh);
    }
    return results;
  }

  return {
    lookup(posts: Post[], options: { refresh?: boolean } = {}) {
      const unique = [
        ...new Map(posts.map((post) => [post.id, post])).values(),
      ];
      const work = queue
        .catch(() => {})
        .then(() => lookup(unique, options.refresh === true));
      queue = work;
      return work;
    },
  };
}
