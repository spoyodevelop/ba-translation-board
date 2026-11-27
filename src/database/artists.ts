import type { RepositoryClient } from "./repositoryClient.ts";
import type { Board } from "../shared/boards.ts";

export type ArtworkPlatform = "x" | "pixiv";

export type PendingArtwork = {
  platform: ArtworkPlatform;
  originalId: string;
  url: string;
  attempts: number;
};

export type ArtworkArtist = {
  platform: ArtworkPlatform;
  originalId: string;
  checkedAt: number;
} & (
  | { status: "found"; artistId: string; artistName: string }
  | { status: "missing" }
);

// 같은 작품의 일시적 실패는 이 횟수까지만 다시 시도한다. 그 뒤로는 작가를 모르는 작품으로 둔다.
export const maxArtistAttempts = 3;

export function createArtistRepository(client: RepositoryClient, board: Board) {
  return {
    // 출처는 있지만 작가를 아직 모르는 작품이다. 새 글의 작품부터 처리한다.
    async listPending(
      platform: ArtworkPlatform,
      limit: number,
    ): Promise<PendingArtwork[]> {
      const result = await client.execute({
        sql: `SELECT s.platform, s.original_id, MIN(s.url) AS url, COALESCE(a.attempts, 0) AS attempts
          FROM post_sources s
          JOIN posts p ON p.id = s.post_id
          LEFT JOIN artwork_artists a ON a.platform = s.platform AND a.original_id = s.original_id
          WHERE p.board = ? AND s.platform = ?
            AND (a.platform IS NULL OR (a.status = 'failed' AND a.attempts < ?))
          GROUP BY s.platform, s.original_id
          ORDER BY MAX(p.published_at) DESC, s.original_id
          LIMIT ?`,
        args: [board, platform, maxArtistAttempts, limit],
      });
      return result.rows.map((row) => ({
        platform: row.platform as ArtworkPlatform,
        originalId: String(row.original_id),
        url: String(row.url),
        attempts: Number(row.attempts),
      }));
    },
    async readPixivProfile(
      userId: string,
    ): Promise<{ xHandle: string | null } | null> {
      const result = await client.execute({
        sql: "SELECT x_handle FROM pixiv_profiles WHERE user_id = ?",
        args: [userId],
      });
      const row = result.rows[0];
      if (!row) return null;
      return { xHandle: row.x_handle as string | null };
    },
    // 작가와, 픽시브라면 그 작가의 프로필을 함께 저장한다.
    async save(
      artist: ArtworkArtist,
      profile?: { userId: string; xHandle: string | null },
    ): Promise<void> {
      let artistId: string | null = null;
      let artistName: string | null = null;
      if (artist.status === "found") {
        artistId = artist.artistId;
        artistName = artist.artistName;
      }
      const statements = [
        {
          sql: `INSERT INTO artwork_artists(platform, original_id, status, artist_id, artist_name, attempts, checked_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT(platform, original_id) DO UPDATE SET status = excluded.status,
              artist_id = excluded.artist_id, artist_name = excluded.artist_name, checked_at = excluded.checked_at`,
          args: [
            artist.platform,
            artist.originalId,
            artist.status,
            artistId,
            artistName,
            artist.checkedAt,
          ],
        },
      ];
      if (profile)
        statements.push({
          sql: `INSERT INTO pixiv_profiles(user_id, x_handle, checked_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET x_handle = excluded.x_handle, checked_at = excluded.checked_at`,
          args: [profile.userId, profile.xHandle, artist.checkedAt],
        });
      await client.batch(statements, "write");
    },
    async recordFailure(
      platform: ArtworkPlatform,
      originalId: string,
      checkedAt: number,
    ): Promise<void> {
      await client.execute({
        sql: `INSERT INTO artwork_artists(platform, original_id, status, attempts, checked_at)
          VALUES (?, ?, 'failed', 1, ?)
          ON CONFLICT(platform, original_id) DO UPDATE SET status = 'failed',
            attempts = artwork_artists.attempts + 1, checked_at = excluded.checked_at`,
        args: [platform, originalId, checkedAt],
      });
    },
    // 출처 행은 글이 지워질 때 함께 지워진다. 어느 글에도 남지 않은 작품과 프로필을 정리한다.
    async pruneOrphans(): Promise<void> {
      await client.batch(
        [
          `DELETE FROM artwork_artists WHERE NOT EXISTS (
            SELECT 1 FROM post_sources s
            WHERE s.platform = artwork_artists.platform AND s.original_id = artwork_artists.original_id)`,
          // artwork_artists에는 artist_id 인덱스가 없어 NOT EXISTS로 쓰면 프로필마다 픽시브 작품을 전부 훑는다.
          // Turso는 읽은 행 수로 과금하므로, 살아 있는 작가 목록을 한 번만 만드는 NOT IN으로 둔다.
          `DELETE FROM pixiv_profiles WHERE user_id NOT IN (
            SELECT artist_id FROM artwork_artists
            WHERE platform = 'pixiv' AND artist_id IS NOT NULL)`,
        ],
        "write",
      );
    },
  };
}
