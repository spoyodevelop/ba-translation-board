import type { RepositoryClient } from "./repositoryClient.ts";
import type { Row } from "@libsql/client";
import type { Source } from "../shared/post";
import type { Board } from "../shared/boards.ts";
import type { CollectionState, RequestScope } from "./types";

function collectionFromRow(row: Row): CollectionState {
  return {
    source: row.source as Source,
    board: row.board as Board,
    state: row.state as CollectionState["state"],
    historyBackfilled: row.history_backfilled === 1,
    lastAttemptAt: row.last_attempt_at as number | null,
    lastSuccessAt: row.last_success_at as number | null,
    lastCount: Number(row.last_count),
    error: row.error as string | null,
  };
}

export function createCollectionReader(
  client: Pick<RepositoryClient, "execute">,
) {
  return {
    async list(): Promise<CollectionState[]> {
      const result = await client.execute(
        "SELECT * FROM collection_state ORDER BY source, board",
      );
      return result.rows.map(collectionFromRow);
    },
  };
}

export function createWorkerStateRepository(client: RepositoryClient) {
  return {
    ...createCollectionReader(client),
    async saveCollection(state: CollectionState): Promise<void> {
      await client.execute({
        sql: `UPDATE collection_state SET state = ?, history_backfilled = ?, last_attempt_at = ?,
          last_success_at = ?, last_count = ?, error = ? WHERE source = ? AND board = ?`,
        args: [
          state.state,
          Number(state.historyBackfilled),
          state.lastAttemptAt,
          state.lastSuccessAt,
          state.lastCount,
          state.error,
          state.source,
          state.board,
        ],
      });
    },
    async deferRequests(
      scope: RequestScope,
      nextRequestAt: number,
    ): Promise<void> {
      // A short wait must never overwrite a longer server Retry-After.
      await client.execute({
        sql: `INSERT INTO request_cooldowns VALUES (?, ?) ON CONFLICT(scope) DO UPDATE
          SET next_request_at = MAX(next_request_at, excluded.next_request_at)`,
        args: [scope, nextRequestAt],
      });
    },
    async nextRequestAt(scope: RequestScope): Promise<number> {
      const result = await client.execute({
        sql: "SELECT next_request_at FROM request_cooldowns WHERE scope = ?",
        args: [scope],
      });
      return Number(result.rows[0]?.next_request_at ?? 0);
    },
  };
}
