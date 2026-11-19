import type { RepositoryClient } from "./repositoryClient.ts";
import { randomUUID } from "node:crypto";
import type { Row } from "@libsql/client";
import type { JobRequest, JobResult, WorkerJob, JobLease } from "./types";
import { boardConfigs, legacyBoard } from "../shared/boards.ts";
import { sources } from "../shared/sites.ts";
import type { Board } from "../shared/boards.ts";

// 재검사 한 번에 다시 판정할 글 수의 상한이다. 작업 등록 명령도 같은 값으로 입력을 거른다.
export const maxBackfillRequestCount = 1000;
const defaultJobListLimit = 20;
const maxJobListLimit = 100;
const defaultJobMaxAttempts = 3;
// 끝난 작업은 `worker status`가 최근 것만 보여 주므로 오래 둘 필요가 없다.
// 실패 기록은 장애를 되짚는 단서라서 완료 기록보다 오래 둔다.
const completedJobRetentionMs = 7 * 24 * 60 * 60_000;
const failedJobRetentionMs = 30 * 24 * 60 * 60_000;

const listRecentJobsSql =
  "SELECT * FROM worker_jobs ORDER BY created_at DESC, id DESC LIMIT ?";

// 동시 등록에도 같은 작업이 늘어나지 않도록 active_key의 부분 유니크 인덱스를 사용한다.
const enqueueJobIfInactiveSql = `INSERT INTO worker_jobs(id, type, board, source, backfill_limit, active_key, state, created_at, available_at, max_attempts)
            VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
            ON CONFLICT(active_key) WHERE state IN ('queued', 'running') DO NOTHING`;

const findActiveJobSql =
  "SELECT * FROM worker_jobs WHERE active_key = ? AND state IN ('queued', 'running')";

const findJobByIdSql = "SELECT * FROM worker_jobs WHERE id = ?";

// 재시도 한도에 도달한 만료 작업은 실패로 끝내고, 나머지는 다시 대기열에 넣는다.
const recoverExpiredJobsSql = `UPDATE worker_jobs SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            worker_id = NULL, lease_token = NULL, lease_until = NULL, available_at = ?,
            finished_at = CASE WHEN attempts >= max_attempts THEN ? ELSE NULL END, error = '작업 임대 시간 만료'
            WHERE state = 'running' AND lease_until <= ?`;

const claimNextJobIfIdleSql = `UPDATE worker_jobs SET state = 'running', worker_id = ?, lease_token = ?, lease_until = ?,
            attempts = attempts + 1, started_at = ?, finished_at = NULL
            WHERE id = (SELECT id FROM worker_jobs WHERE state = 'queued' AND available_at <= ?
              AND attempts < max_attempts ORDER BY available_at, created_at, id LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM worker_jobs WHERE state = 'running') RETURNING *`;

// 대기·실행 중인 작업은 상태 조건으로 제외되므로 건드리지 않는다.
const pruneFinishedJobsSql = `DELETE FROM worker_jobs
          WHERE (state = 'completed' AND finished_at < ?) OR (state = 'failed' AND finished_at < ?)`;
// 갱신·완료·실패는 만료되지 않은 토큰의 소유자만 기록할 수 있다.
const renewOwnedJobSql = `UPDATE worker_jobs SET lease_until = MAX(lease_until, ?) WHERE id = ? AND state = 'running'
          AND lease_token = ? AND lease_until > ?`;

const completeOwnedJobSql = `UPDATE worker_jobs SET state = 'completed', finished_at = ?, result_json = ?, error = NULL,
          worker_id = NULL, lease_token = NULL, lease_until = NULL
          WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_until > ?`;

const failOrRetryOwnedJobSql = `UPDATE worker_jobs SET state = CASE WHEN ? IS NOT NULL AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
          available_at = COALESCE(?, available_at),
          finished_at = CASE WHEN ? IS NOT NULL AND attempts < max_attempts THEN NULL ELSE ? END,
          error = ?, worker_id = NULL, lease_token = NULL, lease_until = NULL
          WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_until > ?`;

function jobFromRow(row: Row): WorkerJob {
  let request: JobRequest;
  const board = row.board as Board;
  if (row.type === "collect")
    request = {
      type: "collect",
      board,
      source: row.source as "arca" | "dc" | "all",
    };
  else request = { type: "backfill", board, limit: Number(row.backfill_limit) };
  return {
    id: String(row.id),
    request,
    state: row.state as WorkerJob["state"],
    createdAt: Number(row.created_at),
    availableAt: Number(row.available_at),
    startedAt: row.started_at as number | null,
    finishedAt: row.finished_at as number | null,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    workerId: row.worker_id as string | null,
    leaseToken: row.lease_token as string | null,
    leaseUntil: row.lease_until as number | null,
    error: row.error as string | null,
    result: row.result_json
      ? (JSON.parse(String(row.result_json)) as JobResult)
      : null,
  };
}

// 기존 board의 작업 키는 board를 추가하기 전과 같게 둔다. 배포 전에 대기 중이던 작업과 겹쳐야 같은 작업이 두 번 쌓이지 않는다.
function boardKey(board: Board) {
  if (!(board in boardConfigs)) throw new Error("작업 board가 올바르지 않습니다.");
  if (board === legacyBoard) return "";
  return `:${board}`;
}

function activeKey(request: JobRequest): string {
  if (request.type === "collect") {
    if (!["all", ...sources].includes(request.source))
      throw new Error("수집 출처가 올바르지 않습니다.");
    return `collect${boardKey(request.board)}:${request.source}`;
  }
  if (
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > maxBackfillRequestCount
  )
    throw new Error(`재검사 개수는 1~${maxBackfillRequestCount}이어야 합니다.`);
  return `backfill${boardKey(request.board)}`;
}

export function createJobRepository(client: RepositoryClient) {
  return {
    async list(limit = defaultJobListLimit): Promise<WorkerJob[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > maxJobListLimit)
        throw new Error("작업 조회 개수는 1~100이어야 합니다.");
      const result = await client.execute({
        sql: listRecentJobsSql,
        args: [limit],
      });
      return result.rows.map(jobFromRow);
    },
    async enqueue(
      request: JobRequest,
      now: number,
      maxAttempts = defaultJobMaxAttempts,
    ): Promise<WorkerJob> {
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
        throw new Error("최대 시도 횟수는 양의 정수여야 합니다.");
      const key = activeKey(request);
      // 등록과 조회 사이에 다른 worker가 작업을 완료해도 결과가 사라지지 않도록 함께 실행한다.
      const [, activeJobResult] = await client.batch(
        [
          {
            sql: enqueueJobIfInactiveSql,
            args: [
              randomUUID(),
              request.type,
              request.board,
              request.type === "collect" ? request.source : null,
              request.type === "backfill" ? request.limit : null,
              key,
              now,
              now,
              maxAttempts,
            ],
          },
          {
            sql: findActiveJobSql,
            args: [key],
          },
        ],
        "write",
      );
      return jobFromRow(activeJobResult.rows[0]);
    },
    async get(id: string): Promise<WorkerJob | null> {
      const result = await client.execute({
        sql: findJobByIdSql,
        args: [id],
      });
      if (!result.rows[0]) return null;
      return jobFromRow(result.rows[0]);
    },
    async claim(
      workerId: string,
      now: number,
      leaseMs: number,
    ): Promise<WorkerJob | null> {
      if (!workerId || !Number.isInteger(leaseMs) || leaseMs < 1)
        throw new Error("worker ID와 양의 임대 시간이 필요합니다.");
      const leaseToken = randomUUID();
      const leaseUntil = now + leaseMs;
      // 복구와 소유권 획득을 함께 실행해 다른 worker가 중간에 작업을 가져가지 못하게 한다.
      const [, claimedJobResult] = await client.batch(
        [
          {
            sql: recoverExpiredJobsSql,
            args: [now, now, now],
          },
          {
            sql: claimNextJobIfIdleSql,
            args: [workerId, leaseToken, leaseUntil, now, now],
          },
        ],
        "write",
      );
      const claimedJob = claimedJobResult.rows[0];
      if (!claimedJob) return null;
      return jobFromRow(claimedJob);
    },
    async renew(
      lease: JobLease,
      now: number,
      leaseMs: number,
    ): Promise<boolean> {
      if (!Number.isInteger(leaseMs) || leaseMs < 1)
        throw new Error("임대 시간은 양의 정수여야 합니다.");
      const result = await client.execute({
        sql: renewOwnedJobSql,
        args: [now + leaseMs, lease.jobId, lease.token, now],
      });
      return result.rowsAffected === 1;
    },
    async complete(
      lease: JobLease,
      result: JobResult,
      now: number,
    ): Promise<boolean> {
      const saved = await client.execute({
        sql: completeOwnedJobSql,
        args: [now, JSON.stringify(result), lease.jobId, lease.token, now],
      });
      return saved.rowsAffected === 1;
    },
    async fail(
      lease: JobLease,
      error: string,
      now: number,
      retryAt: number | null,
    ): Promise<boolean> {
      if (retryAt !== null && retryAt < now)
        throw new Error("재시도 시각은 현재 이후여야 합니다.");
      const saved = await client.execute({
        sql: failOrRetryOwnedJobSql,
        args: [
          retryAt,
          retryAt,
          retryAt,
          now,
          error,
          lease.jobId,
          lease.token,
          now,
        ],
      });
      return saved.rowsAffected === 1;
    },
    async pruneFinished(now: number): Promise<number> {
      const result = await client.execute({
        sql: pruneFinishedJobsSql,
        args: [now - completedJobRetentionMs, now - failedJobRetentionMs],
      });
      return result.rowsAffected;
    },
  };
}
