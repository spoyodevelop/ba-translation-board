import type { RepositoryClient } from "./repositoryClient.ts";
import type { InStatement } from "@libsql/client";
import type { OriginalSource } from "../sources/types";
import type { ImageCacheRecord, SourceCacheRecord } from "./types";
import { postFromRow } from "./posts.ts";
import type { StoredPost } from "./types.ts";
import type { Source } from "../shared/post.ts";
import type { Board } from "../shared/boards.ts";
import { splitSourceKey } from "./grouping.ts";

export function createCacheRepository(client: RepositoryClient, board: Board) {
  return {
    async saveSources(entry: SourceCacheRecord): Promise<void> {
      const statements: InStatement[] = [
        {
          sql: `INSERT INTO source_cache VALUES (?, ?, ?, ?, ?) ON CONFLICT(post_id) DO UPDATE SET
          version = excluded.version, checked_at = excluded.checked_at, expires_at = excluded.expires_at, image_url = excluded.image_url`,
          args: [
            entry.postId,
            entry.version,
            entry.checkedAt,
            entry.expiresAt,
            entry.imageUrl,
          ],
        },
        {
          sql: "DELETE FROM post_sources WHERE post_id = ?",
          args: [entry.postId],
        },
      ];
      const sources = new Map(
        entry.sources.map((source) => [source.key, source]),
      );
      let position = 0;
      for (const source of sources.values()) {
        const [platform, id] = splitSourceKey(source.key);
        statements.push({
          sql: "INSERT INTO post_sources VALUES (?, ?, ?, ?, ?)",
          args: [entry.postId, position++, platform, id, source.url],
        });
      }
      await client.batch(statements, "write");
    },
    async readSources(
      postId: string,
      version: number,
      now: number,
    ): Promise<SourceCacheRecord | null> {
      const result = await client.execute({
        sql: `SELECT c.*, s.platform, s.original_id, s.url FROM source_cache c LEFT JOIN post_sources s USING(post_id)
          WHERE c.post_id = ? AND c.version = ? AND c.checked_at <= ? AND c.expires_at > ? ORDER BY s.position`,
        args: [postId, version, now, now],
      });
      const row = result.rows[0];
      if (!row) return null;
      return {
        postId,
        version,
        checkedAt: Number(row.checked_at),
        expiresAt: Number(row.expires_at),
        imageUrl: row.image_url as string | null,
        sources: result.rows
          .filter((row) => row.platform !== null)
          .map((row) => ({
            key: `${row.platform}:${row.original_id}` as OriginalSource["key"],
            url: String(row.url),
          })),
      };
    },
    async findSourceMatches(options: {
      source: Source;
      sourceKeys: OriginalSource["key"][];
      since: number;
      until: number;
      version: number;
      now: number;
    }): Promise<
      Array<{ post: StoredPost; sourceKeys: OriginalSource["key"][] }>
    > {
      const keys = [...new Set(options.sourceKeys)];
      if (keys.length === 0) return [];
      const result = await client.execute({
        sql: `SELECT p.*, s.platform, s.original_id FROM post_sources s
          JOIN source_cache c ON c.post_id = s.post_id
          JOIN posts p ON p.id = s.post_id
          WHERE (s.platform, s.original_id) IN (${keys.map(() => "(?, ?)").join(",")})
          AND p.board = ? AND p.source <> ? AND p.published_at >= ? AND p.published_at <= ?
          AND c.version = ? AND c.checked_at <= ? AND c.expires_at > ?
          ORDER BY p.id, s.platform, s.original_id`,
        args: [
          ...keys.flatMap(splitSourceKey),
          board,
          options.source,
          options.since,
          options.until,
          options.version,
          options.now,
          options.now,
        ],
      });
      const matches = new Map<
        string,
        { post: StoredPost; sourceKeys: OriginalSource["key"][] }
      >();
      for (const row of result.rows) {
        const id = String(row.id);
        let match = matches.get(id);
        if (!match) {
          match = { post: postFromRow(row), sourceKeys: [] };
          matches.set(id, match);
        }
        match.sourceKeys.push(
          `${row.platform}:${row.original_id}` as OriginalSource["key"],
        );
      }
      return [...matches.values()];
    },
    async saveImage(entry: ImageCacheRecord): Promise<void> {
      if (entry.regions.length !== 9)
        throw new Error("이미지 해시는 9개 구역이 필요합니다.");
      const statements: InStatement[] = [
        {
          sql: `INSERT INTO image_cache VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET
          version = excluded.version, checked_at = excluded.checked_at, expires_at = excluded.expires_at,
          width = excluded.width, height = excluded.height, whole_hash = excluded.whole_hash`,
          args: [
            entry.key,
            entry.version,
            entry.checkedAt,
            entry.expiresAt,
            entry.width,
            entry.height,
            entry.wholeHash,
          ],
        },
        {
          sql: "DELETE FROM image_regions WHERE cache_key = ?",
          args: [entry.key],
        },
      ];
      entry.regions.forEach((region, index) =>
        statements.push({
          sql: "INSERT INTO image_regions VALUES (?, ?, ?, ?)",
          args: [entry.key, index, region.hash, region.contrast],
        }),
      );
      await client.batch(statements, "write");
    },
    async readImage(
      key: string,
      version: string,
      now: number,
    ): Promise<ImageCacheRecord | null> {
      const result = await client.execute({
        sql: `SELECT c.*, r.hash, r.contrast FROM image_cache c JOIN image_regions r USING(cache_key)
          WHERE c.cache_key = ? AND c.version = ? AND c.checked_at <= ? AND c.expires_at > ? ORDER BY r.region_index`,
        args: [key, version, now, now],
      });
      const row = result.rows[0];
      if (!row || result.rows.length !== 9) return null;
      return {
        key,
        version,
        checkedAt: Number(row.checked_at),
        expiresAt: Number(row.expires_at),
        width: Number(row.width),
        height: Number(row.height),
        wholeHash: String(row.whole_hash),
        regions: result.rows.map((row) => ({
          hash: String(row.hash),
          contrast: Number(row.contrast),
        })),
      };
    },
    // 출처 캐시는 만료돼도 지우지 않는다. 묶음 판정은 expires_at까지만 새 결과로 쓰지만,
    // 원작 작가 모아보기가 글의 출처를 계속 읽으므로 글이 보관 기간을 넘겨 지워질 때 함께 지운다.
    async pruneExpired(now: number): Promise<void> {
      await client.execute({
        sql: "DELETE FROM image_cache WHERE expires_at <= ?",
        args: [now],
      });
    },
  };
}
