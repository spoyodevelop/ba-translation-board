import type { RepositoryClient } from "./repositoryClient.ts";
import type { InStatement, Row } from "@libsql/client";
import type { Source } from "../shared/post.ts";
import { postRetentionMonths } from "../shared/post.ts";
import { boardConfigs } from "../shared/boards.ts";
import type { Board } from "../shared/boards.ts";
import type { CollectedPost, StoredPost } from "./types.ts";

const maxUnprocessedQueryLimit = 1000;
const postCountsRefreshIntervalMs = 30 * 60_000;

const koreanTimeOffsetMs = 9 * 60 * 60_000;

function retentionDates(now: number) {
  const today = new Date(now + koreanTimeOffsetMs);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() - postRetentionMonths;
  // 대상 월에 같은 날짜가 없으면 그 달의 마지막 날부터 보관한다.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(today.getUTCDate(), lastDay);
  return {
    today: today.toISOString().slice(0, 10),
    cutoff: Date.UTC(year, month, day) - koreanTimeOffsetMs,
  };
}

export function postFromRow(row: Row): StoredPost {
  return {
    id: String(row.id),
    source: row.source as Source,
    sourceId: String(row.source_id),
    title: String(row.title),
    url: String(row.url),
    author: row.author as string | null,
    authorId: row.author_id as string | null,
    publishedAt: new Date(Number(row.published_at)).toISOString(),
    viewCount: row.view_count as number | null,
    recommendCount: row.recommend_count as number | null,
    duplicateGroupId: null,
  };
}

export function createPostRepository(client: RepositoryClient, board: Board) {
  return {
    async upsert(
      posts: CollectedPost[],
      collectedAt = Date.now(),
    ): Promise<void> {
      if (posts.length === 0) return;
      if (!Number.isSafeInteger(collectedAt) || collectedAt < 0)
        throw new Error("글의 수집 시각이 올바르지 않습니다.");
      const statements = posts.flatMap((post): InStatement[] => {
        const publishedAt = Date.parse(post.publishedAt);
        if (!Number.isFinite(publishedAt))
          throw new Error("글의 작성 시각이 올바르지 않습니다.");
        return [
          {
            // 메타데이터 변경은 즉시 반영하고, 숫자만 달라졌을 때는 마지막 저장 후 30분을 기다린다.
            // 다른 카테고리로 옮겨진 글이 다시 수집돼도 처음 저장한 board는 바꾸지 않는다.
            sql: `INSERT INTO posts(id, source, source_id, title, url, author, published_at, view_count, recommend_count, counts_updated_at, board, author_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET title = excluded.title, url = excluded.url, author = excluded.author,
                author_id = excluded.author_id,
                view_count = excluded.view_count, recommend_count = excluded.recommend_count,
                counts_updated_at = excluded.counts_updated_at
              WHERE posts.title IS NOT excluded.title OR posts.url IS NOT excluded.url
                OR posts.author IS NOT excluded.author OR posts.author_id IS NOT excluded.author_id
                OR posts.published_at IS NOT excluded.published_at
                OR (posts.counts_updated_at <= ?
                  AND (posts.view_count IS NOT excluded.view_count OR posts.recommend_count IS NOT excluded.recommend_count))`,
            args: [
              post.id,
              post.source,
              post.sourceId,
              post.title,
              post.url,
              post.author,
              publishedAt,
              post.viewCount,
              post.recommendCount,
              collectedAt,
              board,
              post.authorId,
              collectedAt - postCountsRefreshIntervalMs,
            ],
          },
          {
            // 작성 시각 보정을 분리해 숫자 갱신이 날짜 인덱스를 재작성하지 않도록 한다.
            sql: "UPDATE posts SET published_at = ? WHERE id = ? AND published_at IS NOT ?",
            args: [publishedAt, post.id, publishedAt],
          },
        ];
      });
      await client.batch(statements, "write");
    },
    // 보관 기간은 board와 상관없이 모든 글에 같게 적용한다.
    // 모든 board를 조건에 적어, 날짜만 앞에 둔 인덱스 없이 board를 앞에 둔 날짜 인덱스로 찾게 한다.
    async pruneExpired(now: number): Promise<number> {
      const boards = Object.keys(boardConfigs);
      const { today, cutoff } = retentionDates(now);
      const state = await client.execute(
        "SELECT last_cleanup_day FROM post_retention WHERE id = 1",
      );
      const lastDay = state.rows[0]?.last_cleanup_day;
      if (typeof lastDay === "string" && lastDay >= today) return 0;

      // 날짜 선점과 삭제가 함께 커밋되어야 실패 후 같은 날 다시 시도할 수 있다.
      const results = await client.batch(
        [
          {
            sql: `INSERT INTO post_retention(id, last_cleanup_day) VALUES (1, ?)
              ON CONFLICT(id) DO UPDATE SET last_cleanup_day = excluded.last_cleanup_day
              WHERE post_retention.last_cleanup_day < excluded.last_cleanup_day`,
            args: [today],
          },
          {
            sql: `DELETE FROM posts WHERE board IN (${boards.map(() => "?").join(", ")})
              AND published_at < ? AND changes() = 1`,
            args: [...boards, cutoff],
          },
        ],
        "write",
      );
      return results[1].rowsAffected;
    },
    async get(id: string): Promise<StoredPost | null> {
      const result = await client.execute({
        sql: "SELECT * FROM posts WHERE id = ? AND board = ?",
        args: [id, board],
      });
      if (!result.rows[0]) return null;
      return postFromRow(result.rows[0]);
    },
    // 수집이 목록 페이지에서 이미 저장한 글을 찾을 때 쓴다. 읽는 행이 넘긴 ID 수를 넘지 않게 기본 키로 찾는다.
    // board를 조건에 넣으면 플래너가 board 인덱스로 그 board의 글 전체를 훑으므로, board는 읽은 뒤에 거른다.
    async findStoredIds(ids: string[]): Promise<Set<string>> {
      if (ids.length === 0) return new Set();
      const result = await client.execute({
        sql: `SELECT id, board FROM posts WHERE id IN (${ids.map(() => "?").join(", ")})`,
        args: ids,
      });
      const stored = new Set<string>();
      for (const row of result.rows) {
        if (row.board === board) stored.add(String(row.id));
      }
      return stored;
    },
    async hasAny(source: Source): Promise<boolean> {
      const result = await client.execute({
        sql: "SELECT 1 FROM posts WHERE board = ? AND source = ? LIMIT 1",
        args: [board, source],
      });
      return result.rows.length > 0;
    },
    async listRecent(
      since: number,
      source: Source | null = null,
    ): Promise<StoredPost[]> {
      const result = await client.execute({
        sql: "SELECT * FROM posts WHERE board = ? AND published_at >= ? AND (? IS NULL OR source = ?) ORDER BY published_at DESC, id DESC",
        args: [board, since, source, source],
      });
      return result.rows.map(postFromRow);
    },
    async findUnprocessed(
      since: number,
      algorithmVersion: string,
      limit: number,
    ): Promise<StoredPost[]> {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > maxUnprocessedQueryLimit
      )
        throw new Error("조회 개수는 1~1000이어야 합니다.");
      const result = await client.execute({
        sql: `SELECT p.* FROM posts p LEFT JOIN grouping_processed g ON g.post_id = p.id
          WHERE p.board = ? AND p.published_at >= ? AND (g.post_id IS NULL OR g.algorithm_version != ?)
          ORDER BY p.published_at DESC, p.id DESC LIMIT ?`,
        args: [board, since, algorithmVersion, limit],
      });
      return result.rows.map(postFromRow);
    },
  };
}
