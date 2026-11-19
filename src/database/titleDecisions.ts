import type { RepositoryClient } from "./repositoryClient.ts";
import { postPairKey } from "../grouping/findCandidates.ts";
import {
  JEV_TITLE_CACHE_TTL_MS,
  JEV_TITLE_POLICY_VERSION,
} from "../grouping/evaluateWithJev.ts";
import type {
  JevTitleDecision,
  TitlePair,
} from "../grouping/evaluateWithJev.ts";

export function createTitleDecisionRepository(client: RepositoryClient) {
  return {
    async read(
      pairs: TitlePair[],
      now: number,
    ): Promise<Map<string, JevTitleDecision>> {
      const decisions = new Map<string, JevTitleDecision>();
      if (pairs.length === 0) return decisions;
      // 후보별 왕복 요청 대신 제목 쌍의 캐시를 한 번에 읽는다.
      const result = await client.execute({
        sql: `SELECT * FROM jev_title_decisions WHERE
          (first_post_id, second_post_id) IN (${pairs.map(() => "(?, ?)").join(",")})
          AND policy_version = ? AND evaluated_at > ? AND evaluated_at <= ?`,
        args: [
          ...pairs.flatMap((pair) => [pair.first.id, pair.second.id]),
          JEV_TITLE_POLICY_VERSION,
          now - JEV_TITLE_CACHE_TTL_MS,
          now,
        ],
      });
      const requested = new Map(
        pairs.map((pair) => [postPairKey(pair.first.id, pair.second.id), pair]),
      );
      for (const row of result.rows) {
        const key = postPairKey(
          String(row.first_post_id),
          String(row.second_post_id),
        );
        const pair = requested.get(key)!;
        if (
          row.first_title !== pair.first.title ||
          row.second_title !== pair.second.title
        )
          continue;
        decisions.set(key, {
          firstPostId: pair.first.id,
          secondPostId: pair.second.id,
          firstTitle: String(row.first_title),
          secondTitle: String(row.second_title),
          probability: Number(row.probability),
          model: String(row.model),
          evaluatedAt: Number(row.evaluated_at),
        });
      }
      return decisions;
    },
    async save(decisions: JevTitleDecision[], now: number): Promise<void> {
      if (decisions.length === 0) return;
      await client.batch(
        [
          ...decisions.map((decision) => ({
            sql: `INSERT INTO jev_title_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(first_post_id, second_post_id) DO UPDATE SET
            first_title = excluded.first_title, second_title = excluded.second_title,
            probability = excluded.probability, model = excluded.model,
            policy_version = excluded.policy_version, evaluated_at = excluded.evaluated_at`,
            args: [
              decision.firstPostId,
              decision.secondPostId,
              decision.firstTitle,
              decision.secondTitle,
              decision.probability,
              decision.model,
              JEV_TITLE_POLICY_VERSION,
              decision.evaluatedAt,
            ],
          })),
          {
            sql: "DELETE FROM jev_title_decisions WHERE evaluated_at <= ?",
            args: [now - JEV_TITLE_CACHE_TTL_MS],
          },
        ],
        "write",
      );
    },
  };
}
