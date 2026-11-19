import type { Client, InStatement, Transaction } from "@libsql/client";
import type { RepositoryClient } from "../database/repositoryClient.ts";
import type { JobLease } from "../database/types";

export class LostJobLeaseError extends Error {
  constructor() {
    super("작업 소유권이 만료되었습니다.");
  }
}

// Ownership and domain writes share a transaction so an expired worker cannot overwrite its successor.
export function createLeasedRepositoryClient(
  client: Client,
  lease: JobLease,
  now = Date.now,
): RepositoryClient {
  let queue: Promise<unknown> = Promise.resolve();
  async function check(transaction: Transaction) {
    const result = await transaction.execute({
      sql: "SELECT 1 FROM worker_jobs WHERE id = ? AND lease_token = ? AND state = 'running' AND lease_until > ?",
      args: [lease.jobId, lease.token, now()],
    });
    if (result.rows.length === 0) throw new LostJobLeaseError();
  }
  async function transactionWork<T>(
    work: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    const transaction = await client.transaction("write");
    try {
      await check(transaction);
      const result = await work(transaction);
      await check(transaction);
      await transaction.commit();
      return result;
    } finally {
      transaction.close();
    }
  }
  function guarded<T>(
    work: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    const result = queue.catch(() => {}).then(() => transactionWork(work));
    queue = result;
    return result;
  }
  return {
    execute: (statement) =>
      guarded((transaction) => transaction.execute(statement)),
    batch: (statements) => {
      const normalized: InStatement[] = statements.map((statement) => {
        if (Array.isArray(statement))
          return { sql: statement[0], args: statement[1] };
        return statement;
      });
      return guarded((transaction) => transaction.batch(normalized));
    },
  };
}

// 작업을 실행하는 동안 소유권을 주기적으로 연장한다.
// 연장이 거절되면 바로, 연장 요청이 실패하면 마지막으로 연장한 만료 시각이 지난 뒤에 signal을 중단한다.
// 일시적인 DB 오류만으로 아직 유효한 소유권을 버리지 않기 위해서다.
export function holdJobLease(deps: {
  lease: JobLease;
  leaseUntil: number;
  leaseMs: number;
  renewalIntervalMs: number;
  renew: (lease: JobLease, now: number, leaseMs: number) => Promise<boolean>;
  now: () => number;
  onRenewalError: (error: unknown) => void;
}) {
  const controller = new AbortController();
  let leaseUntil = deps.leaseUntil;
  let renewing: Promise<void> | null = null;

  async function renewOnce() {
    try {
      if (await deps.renew(deps.lease, deps.now(), deps.leaseMs))
        leaseUntil = deps.now() + deps.leaseMs;
      else controller.abort(new LostJobLeaseError());
    } catch (error) {
      deps.onRenewalError(error);
      if (deps.now() >= leaseUntil) controller.abort(new LostJobLeaseError());
    }
  }

  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = renewOnce().finally(() => {
      renewing = null;
    });
  }, deps.renewalIntervalMs);

  return {
    signal: controller.signal,
    // 연장을 멈추고 진행 중인 연장이 끝나길 기다린다. 완료·실패 기록이 연장과 겹치지 않게 한다.
    async release() {
      clearInterval(heartbeat);
      if (renewing) await renewing;
    },
  };
}
