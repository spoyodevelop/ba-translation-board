import type { RepositoryClient } from "./repositoryClient.ts";
import { postFromRow } from "./posts.ts";
import type { StoredPost } from "./types.ts";
import type { GroupEdge } from "../grouping/postGroups.ts";
import type { Board } from "../shared/boards.ts";
import { artistIdentity } from "../sources/originalArtists.ts";

// 디시 고닉 아이디는 판정에만 쓰므로 누구나 받는 조회 응답에서 뺀다.
export type PublicPost = Omit<StoredPost, "authorId">;

// 글에 실린 원작의 작가다. 한 글에 같은 작가의 작품이 여러 개여도 한 번만 싣는다.
export type PostArtist = { postId: string; key: string; name: string };

export type BoardSnapshot = {
  posts: PublicPost[];
  automaticEdges: GroupEdge[];
  artists: PostArtist[];
  updatedAt: string | null;
};

export function createBoardSnapshotReader(
  client: Pick<RepositoryClient, "batch">,
) {
  return {
    async load(board: Board): Promise<BoardSnapshot> {
      // 검색·작가 필터가 모든 글을 대상으로 하므로 글과 연결을 한 번에 읽고 화면에서 나눠 보여 준다.
      // 탭마다 그 board의 글·연결·수집 시각만 읽어 다른 탭의 글 수가 읽기 비용에 더해지지 않게 한다.
      const results = await client.batch(
        [
          {
            sql: "SELECT * FROM posts WHERE board = ? ORDER BY published_at DESC, id DESC",
            args: [board],
          },
          {
            sql: "SELECT first_post_id, second_post_id FROM automatic_matches WHERE board = ? ORDER BY first_post_id, second_post_id",
            args: [board],
          },
          {
            sql: "SELECT MAX(last_success_at) AS updated_at FROM collection_state WHERE board = ?",
            args: [board],
          },
          {
            // 작가를 알아낸 작품만 읽는다. 출처 순서대로 읽어 글의 첫 작가가 먼저 오게 한다.
            // Turso는 읽은 행 수로 과금한다. 그냥 JOIN하면 플래너가 board 인덱스로 글 표를 훑어
            // (2026-11-18 기준 4,994행) CROSS JOIN으로 출처 표부터 읽게 고정한다(1,068행).
            sql: `SELECT s.post_id, s.platform, a.artist_id, a.artist_name, pp.x_handle
              FROM post_sources s
              CROSS JOIN posts p
              JOIN artwork_artists a ON a.platform = s.platform AND a.original_id = s.original_id AND a.status = 'found'
              LEFT JOIN pixiv_profiles pp ON s.platform = 'pixiv' AND pp.user_id = a.artist_id
              WHERE p.id = s.post_id AND p.board = ?
              ORDER BY s.post_id, s.position`,
            args: [board],
          },
        ],
        "read",
      );
      const updatedAt = results[2].rows[0].updated_at;
      return {
        posts: results[0].rows.map((row) => {
          const { authorId: _authorId, ...post } = postFromRow(row);
          return post;
        }),
        automaticEdges: results[1].rows.map((row) => ({
          firstId: String(row.first_post_id),
          secondId: String(row.second_post_id),
        })),
        artists: postArtistsFromRows(results[3].rows),
        updatedAt:
          updatedAt === null ? null : new Date(Number(updatedAt)).toISOString(),
      };
    },
  };
}

function postArtistsFromRows(rows: Record<string, unknown>[]): PostArtist[] {
  const artists: PostArtist[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const postId = String(row.post_id);
    const identity = artistIdentity({
      platform: row.platform as "x" | "pixiv",
      artistId: String(row.artist_id),
      artistName: row.artist_name as string | null,
      xHandle: row.x_handle as string | null,
    });
    const seenKey = `${postId} ${identity.key}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    artists.push({ postId, ...identity });
  }
  return artists;
}
