import { JEV_MATCH_THRESHOLD } from "../grouping/evaluateWithJev.ts";
import type { JevTitleEvidence } from "../grouping/evaluateWithJev.ts";
import type { RepositoryClient } from "./repositoryClient.ts";
import type { Board } from "../shared/boards.ts";
import type { InStatement, Row } from "@libsql/client";
import type { OriginalSource } from "../sources/types";
import type {
  AutomaticMatch,
  CreativeEvidence,
  GroupingUpdate,
  MatchChange,
} from "./types";
import type { ImageComparison } from "../sources/imageHash";

export function splitSourceKey(key: OriginalSource["key"]): [string, string] {
  const match = /^(x|pixiv):([1-9]\d*)$/.exec(key);
  if (!match) throw new Error("원작 출처 ID가 올바르지 않습니다.");
  return [match[1], match[2]];
}

function normalizePostPair(first: string, second: string): [string, string] {
  if (first === second) throw new Error("서로 다른 글이 필요합니다.");
  if (first < second) return [first, second];
  return [second, first];
}

function buildMatchChangeStatements(comparison: MatchChange): InStatement[] {
  const statements: InStatement[] = [];
  const [first, second] = normalizePostPair(
    comparison.firstPostId,
    comparison.secondPostId,
  );
  const match = comparison.match;
  if (match) {
    const [matchFirst, matchSecond] = normalizePostPair(
      match.firstPostId,
      match.secondPostId,
    );
    if (matchFirst !== first || matchSecond !== second)
      throw new Error("판정 대상 글이 일치하지 않습니다.");
    const title = match.titleEvidence;
    if (
      title &&
      (!Number.isFinite(title.probability) ||
        title.probability < JEV_MATCH_THRESHOLD ||
        title.probability > 1)
    )
      throw new Error("Jev 자동 판정에는 0.95 이상의 확률이 필요합니다.");
    const hasEvidence =
      match.sourceKeys.length > 0 ||
      match.imageEvidence ||
      title ||
      match.creativeEvidence;
    if (!hasEvidence)
      throw new Error(
        "자동 판정에는 제목, 출처, 이미지 또는 창작 판정 근거가 필요합니다.",
      );
  }
  statements.push({
    sql: "DELETE FROM match_sources WHERE first_post_id = ? AND second_post_id = ?",
    args: [first, second],
  });
  if (!match) {
    statements.push({
      sql: "DELETE FROM automatic_matches WHERE first_post_id = ? AND second_post_id = ?",
      args: [first, second],
    });
    return statements;
  }
  statements.push({
    // board는 글에서 가져와 판정 코드가 board를 따로 넘기다 틀리지 않게 한다.
    sql: `INSERT INTO automatic_matches(first_post_id, second_post_id, algorithm_version, matched_at, image_evidence_json, title_evidence_json, creative_evidence_json, board)
      VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT board FROM posts WHERE id = ?)) ON CONFLICT(first_post_id, second_post_id) DO UPDATE SET
      algorithm_version = excluded.algorithm_version, matched_at = excluded.matched_at, image_evidence_json = excluded.image_evidence_json,
      title_evidence_json = excluded.title_evidence_json, creative_evidence_json = excluded.creative_evidence_json`,
    args: [
      first,
      second,
      match.algorithmVersion,
      match.matchedAt,
      match.imageEvidence ? JSON.stringify(match.imageEvidence) : null,
      match.titleEvidence ? JSON.stringify(match.titleEvidence) : null,
      match.creativeEvidence ? JSON.stringify(match.creativeEvidence) : null,
      first,
    ],
  });
  for (const key of new Set(match.sourceKeys)) {
    const [platform, id] = splitSourceKey(key);
    statements.push({
      sql: "INSERT INTO match_sources VALUES (?, ?, ?, ?)",
      args: [first, second, platform, id],
    });
  }
  return statements;
}

function buildProcessedStatements(
  processedPosts: GroupingUpdate["processed"],
): InStatement[] {
  const statements: InStatement[] = [];
  for (const processed of processedPosts) {
    statements.push({
      sql: `INSERT INTO grouping_processed VALUES (?, ?, ?) ON CONFLICT(post_id) DO UPDATE SET
        algorithm_version = excluded.algorithm_version, processed_at = excluded.processed_at`,
      args: [
        processed.postId,
        processed.algorithmVersion,
        processed.processedAt,
      ],
    });
  }
  return statements;
}

function matchesFromRows(rows: Row[]): AutomaticMatch[] {
  const matches: AutomaticMatch[] = [];
  for (const row of rows) {
    let match = matches[matches.length - 1];
    if (
      !match ||
      match.firstPostId !== row.first_post_id ||
      match.secondPostId !== row.second_post_id
    ) {
      match = {
        firstPostId: String(row.first_post_id),
        secondPostId: String(row.second_post_id),
        algorithmVersion: String(row.algorithm_version),
        matchedAt: Number(row.matched_at),
        sourceKeys: [],
        titleEvidence: row.title_evidence_json
          ? (JSON.parse(String(row.title_evidence_json)) as JevTitleEvidence)
          : null,
        imageEvidence: row.image_evidence_json
          ? (JSON.parse(String(row.image_evidence_json)) as ImageComparison)
          : null,
        creativeEvidence: row.creative_evidence_json
          ? (JSON.parse(String(row.creative_evidence_json)) as CreativeEvidence)
          : null,
      };
      matches.push(match);
    }
    if (row.platform !== null)
      match.sourceKeys.push(
        `${row.platform}:${row.original_id}` as OriginalSource["key"],
      );
  }
  return matches;
}

export function createGroupingRepository(client: RepositoryClient, board: Board) {
  return {
    async commit(update: GroupingUpdate): Promise<void> {
      const statements = [
        ...update.comparisons.flatMap(buildMatchChangeStatements),
        ...buildProcessedStatements(update.processed),
      ];
      if (statements.length === 0) return;
      await client.batch(statements, "write");
    },
    // 몇 개 글에 걸린 연결만 읽는다. 연결 전체를 읽으면 글마다 판정할 때 읽기 비용이 연결 수만큼 커진다.
    // 글 ID는 이 board 저장소에서 읽은 글이다. board 조건을 붙이면 board 인덱스로 연결 전체를 훑으므로 붙이지 않는다.
    async listMatchesInvolving(postIds: string[]): Promise<AutomaticMatch[]> {
      const ids = [...new Set(postIds)];
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(",");
      const result = await client.execute({
        sql: `SELECT m.*, s.platform, s.original_id FROM automatic_matches m
          LEFT JOIN match_sources s USING(first_post_id, second_post_id)
          WHERE m.first_post_id IN (${placeholders}) OR m.second_post_id IN (${placeholders})
          ORDER BY m.first_post_id, m.second_post_id, s.platform, s.original_id`,
        args: [...ids, ...ids],
      });
      return matchesFromRows(result.rows);
    },
    async listMatches(): Promise<AutomaticMatch[]> {
      const result = await client.execute({
        sql: `SELECT m.*, s.platform, s.original_id FROM automatic_matches m
          LEFT JOIN match_sources s USING(first_post_id, second_post_id)
          WHERE m.board = ?
          ORDER BY m.first_post_id, m.second_post_id, s.platform, s.original_id`,
        args: [board],
      });
      return matchesFromRows(result.rows);
    },
  };
}
