import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@libsql/client";
import {
  openTursoDatabase,
  openTursoDatabaseFromEnv,
} from "../src/database/connection.ts";
import { migrateTursoDatabase } from "../src/database/schema.ts";
import { createWorkerRepositories } from "../src/database/repositories.ts";
import { createBoardSnapshotReader } from "../src/database/boardSnapshot.ts";
import type {
  CollectedPost,
  AutomaticMatch,
  ImageCacheRecord,
  JobLease,
} from "../src/database/types";

async function withDatabase(
  run: (client: Client, url: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "board-turso-"));
  const url = pathToFileURL(join(directory, "board.db")).href;
  const client = openTursoDatabase({ url });
  try {
    await migrateTursoDatabase(client);
    await run(client, url);
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function post(id: string, time = 1000, title = "번역"): CollectedPost {
  return {
    id,
    source: id.startsWith("arca-") ? "arca" : "dc",
    sourceId: id.split("-")[1],
    title,
    url: `https://example.com/${id}`,
    author: null,
    authorId: null,
    publishedAt: new Date(time).toISOString(),
    viewCount: null,
    recommendCount: null,
  };
}

const match: AutomaticMatch = {
  firstPostId: "dc-1",
  secondPostId: "arca-1",
  sourceKeys: ["x:123"],
  imageEvidence: null,
  titleEvidence: null,
  creativeEvidence: null,
  algorithmVersion: "source-v1",
  matchedAt: 2000,
};

function lease(job: { id: string; leaseToken: string | null }): JobLease {
  assert.ok(job.leaseToken);
  return { jobId: job.id, token: job.leaseToken };
}

test("a new database gets the current schema, is durable and excludes browser-only records", async () => {
  await withDatabase(async (client, url) => {
    await migrateTursoDatabase(client);
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    assert.ok(tables.rows.some((row) => row.name === "posts"));
    assert.equal(
      tables.rows.some((row) => row.name === "board_backup_imports"),
      false,
    );
    assert.equal(
      tables.rows.some((row) =>
        /visited|manual|storage_entries|storage_values/.test(String(row.name)),
      ),
      false,
    );
    await createWorkerRepositories(client, "translation").posts.upsert([post("arca-1")]);
    const reopened = openTursoDatabase({ url });
    try {
      assert.equal(
        (await createWorkerRepositories(reopened, "translation").posts.get("arca-1"))?.id,
        "arca-1",
      );
    } finally {
      reopened.close();
    }
    assert.deepEqual(
      (await client.execute("SELECT version FROM board_schema_migrations")).rows.map(
        (row) => row.version,
      ),
      [8],
    );
  });
});

test("migration refuses databases older or newer than the current schema", async () => {
  await withDatabase(async (client) => {
    // 운영 DB처럼 1~8 기록이 모두 있어도 현재 버전이면 그대로 둔다.
    await client.execute(
      "INSERT INTO board_schema_migrations(version, applied_at) VALUES (1, 0), (7, 0)",
    );
    await migrateTursoDatabase(client);
    await client.execute("DELETE FROM board_schema_migrations WHERE version = 8");
    await assert.rejects(migrateTursoDatabase(client), /스키마 버전입니다: 7/);
    await client.execute(
      "INSERT INTO board_schema_migrations(version, applied_at) VALUES (8, 0), (9, 0)",
    );
    await assert.rejects(migrateTursoDatabase(client), /스키마 버전입니다: 9/);
  });
});

test("post refresh preserves automatic matches and comparisons are canonical and atomic", async () => {
  await withDatabase(async (client) => {
    const db = createWorkerRepositories(client, "translation");
    await db.posts.upsert([post("arca-1"), post("dc-1")], 1000);
    await db.grouping.commit({
      comparisons: [{ ...match, match }],
      processed: [
        { postId: "arca-1", algorithmVersion: "source-v1", processedAt: 2000 },
      ],
    });
    await db.posts.upsert(
      [{ ...post("arca-1"), viewCount: 30, recommendCount: 5 }],
      1000 + 30 * 60_000,
    );
    assert.equal((await db.posts.get("arca-1"))?.viewCount, 30);
    assert.deepEqual(await db.grouping.listMatches(), [
      { ...match, firstPostId: "arca-1", secondPostId: "dc-1" },
    ]);
    assert.deepEqual(
      (await db.posts.findUnprocessed(0, "source-v1", 10)).map((p) => p.id),
      ["dc-1"],
    );
    assert.equal(
      (await db.posts.findUnprocessed(0, "source-v2", 10)).length,
      2,
    );
    await assert.rejects(
      db.grouping.commit({
        comparisons: [{ ...match, match: null }],
        processed: [
          { postId: "arca-missing", algorithmVersion: "v1", processedAt: 1 },
        ],
      }),
    );
    assert.equal((await db.grouping.listMatches()).length, 1);
    await db.grouping.commit({
      comparisons: [{ ...match, match: null }],
      processed: [],
    });
    assert.deepEqual(await db.grouping.listMatches(), []);
  });
});

test("post counts wait thirty minutes per post across connections and skip identical values", async () => {
  await withDatabase(async (client, url) => {
    const db = createWorkerRepositories(client, "translation");
    const start = 1_800_000_000_000;
    const interval = 30 * 60_000;
    const first = { ...post("arca-1"), viewCount: 10, recommendCount: 1 };
    const second = { ...post("dc-1"), viewCount: 20, recommendCount: 2 };
    await db.posts.upsert([first], start);
    await db.posts.upsert([second], start + 10 * 60_000);
    const changed = { ...first, viewCount: 30, recommendCount: 3 };
    await db.posts.upsert([changed], start + interval - 1);
    assert.equal((await db.posts.get(first.id))?.viewCount, 10);
    const reopened = openTursoDatabase({ url });
    try {
      const other = createWorkerRepositories(reopened, "translation");
      await other.posts.upsert([changed], start + interval - 1);
      assert.equal((await other.posts.get(first.id))?.recommendCount, 1);
      await other.posts.upsert(
        [changed, { ...second, viewCount: 40 }],
        start + interval,
      );
      assert.equal((await other.posts.get(first.id))?.viewCount, 30);
      assert.equal((await other.posts.get(first.id))?.recommendCount, 3);
      assert.equal((await other.posts.get(second.id))?.viewCount, 20);
    } finally {
      reopened.close();
    }
    const before = await client.execute("SELECT total_changes() AS changes");
    await db.posts.upsert([changed], start + 2 * interval);
    const after = await client.execute("SELECT total_changes() AS changes");
    assert.equal(after.rows[0].changes, before.rows[0].changes);
    const timestamp = await client.execute({
      sql: "SELECT counts_updated_at FROM posts WHERE id = ?",
      args: [first.id],
    });
    assert.equal(timestamp.rows[0].counts_updated_at, start + interval);
    // 같은 값 확인으로 대기를 연장하지 않고, 다음에 달라진 숫자를 저장한다.
    await db.posts.upsert(
      [{ ...changed, recommendCount: 4 }],
      start + 2 * interval + 1,
    );
    assert.equal((await db.posts.get(first.id))?.recommendCount, 4);
  });
});

test("metadata changes are immediate and numeric refreshes do not rewrite the publication date", async () => {
  await withDatabase(async (client) => {
    const db = createWorkerRepositories(client, "translation");
    const start = 1_800_000_000_000;
    const initial = { ...post("arca-1"), viewCount: 10, recommendCount: 1 };
    await db.posts.upsert([initial], start);
    await client.execute("CREATE TABLE publication_updates (post_id TEXT)");
    await client.execute(`CREATE TRIGGER track_publication_updates AFTER UPDATE OF published_at ON posts
      BEGIN INSERT INTO publication_updates VALUES (NEW.id); END`);
    const edited = {
      ...initial,
      title: "수정된 제목",
      author: "작가",
      url: "https://example.com/edited",
      viewCount: 20,
    };
    await db.posts.upsert([edited], start + 1);
    const saved = await db.posts.get(initial.id);
    assert.equal(saved?.title, edited.title);
    assert.equal(saved?.author, edited.author);
    assert.equal(saved?.url, edited.url);
    assert.equal(saved?.viewCount, 20);
    await db.posts.upsert([{ ...edited, viewCount: 30 }], start + 30 * 60_000);
    assert.equal((await db.posts.get(initial.id))?.viewCount, 20);
    await db.posts.upsert([{ ...edited, viewCount: 30 }], start + 30 * 60_000 + 1);
    assert.equal((await db.posts.get(initial.id))?.viewCount, 30);
    assert.equal(
      (await client.execute("SELECT * FROM publication_updates")).rows.length,
      0,
    );
    const corrected = {
      ...edited,
      publishedAt: new Date(2000).toISOString(),
      viewCount: 40,
    };
    await db.posts.upsert([corrected], start + 30 * 60_000 + 2);
    assert.equal(
      (await db.posts.get(initial.id))?.publishedAt,
      corrected.publishedAt,
    );
    assert.equal((await db.posts.get(initial.id))?.viewCount, 40);
    assert.equal(
      (await client.execute("SELECT * FROM publication_updates")).rows.length,
      1,
    );
    await assert.rejects(db.posts.upsert(
      [
        { ...corrected, publishedAt: new Date(3000).toISOString() },
        { ...post("dc-2"), viewCount: -1 },
      ],
      start + 30 * 60_000 + 3,
    ));
    assert.equal(
      (await db.posts.get(initial.id))?.publishedAt,
      corrected.publishedAt,
    );
    assert.equal(
      (await client.execute("SELECT * FROM publication_updates")).rows.length,
      1,
    );
  });
});

test("count refreshes wait thirty minutes even between no count and a count", async () => {
  await withDatabase(async (client) => {
    const initial = post("arca-1");
    const db = createWorkerRepositories(client, "translation");
    const start = 1_800_000_000_000;
    await db.posts.upsert([initial], start);
    await db.posts.upsert([{ ...initial, viewCount: 1 }], start + 1);
    assert.equal((await db.posts.get(initial.id))?.viewCount, null);
    await db.posts.upsert([{ ...initial, viewCount: 1 }], start + 30 * 60_000);
    assert.equal((await db.posts.get(initial.id))?.viewCount, 1);
    await db.posts.upsert([initial], start + 30 * 60_000 + 1);
    assert.equal((await db.posts.get(initial.id))?.viewCount, 1);
  });
});

test("posts accept only known boards and board listings use the board index", async () => {
  await withDatabase(async (client) => {
    await createWorkerRepositories(client, "translation").posts.upsert([post("arca-1")]);
    await assert.rejects(
      client.execute("UPDATE posts SET board = 'other' WHERE id = 'arca-1'"),
    );
    const plan = await client.execute(
      "EXPLAIN QUERY PLAN SELECT * FROM posts WHERE board = 'translation' ORDER BY published_at DESC, id DESC",
    );
    assert.ok(
      plan.rows.some((row) => String(row.detail).includes("posts_by_board_date")),
    );
  });
});

test("automatic matches take the board of their posts", async () => {
  await withDatabase(async (client) => {
    const db = createWorkerRepositories(client, "translation");
    await db.posts.upsert([post("arca-1"), post("dc-1")], 1000);
    await client.execute("UPDATE posts SET board = 'creative'");
    await db.grouping.commit({ comparisons: [{ ...match, match }], processed: [] });
    assert.equal(
      (await client.execute("SELECT board FROM automatic_matches")).rows[0].board,
      "creative",
    );
    // 다른 카테고리로 옮겨진 글을 다시 수집해도 처음 board를 유지한다.
    await db.posts.upsert([{ ...post("arca-1"), title: "옮겨진 글" }], 2000);
    assert.equal(
      (await client.execute("SELECT board FROM posts WHERE id = 'arca-1'")).rows[0].board,
      "creative",
    );
  });
});

test("board repositories never read posts, sources or matches of the other board", async () => {
  await withDatabase(async (client) => {
    const translation = createWorkerRepositories(client, "translation");
    const creative = createWorkerRepositories(client, "creative");
    await translation.posts.upsert([post("arca-1"), post("dc-1")], 1000);
    await creative.posts.upsert([post("arca-2"), post("dc-2")], 1000);
    const ids = async (db: typeof translation) =>
      (await db.posts.listRecent(0)).map((entry) => entry.id).sort();
    assert.deepEqual(await ids(translation), ["arca-1", "dc-1"]);
    assert.deepEqual(await ids(creative), ["arca-2", "dc-2"]);
    assert.deepEqual(
      (await creative.posts.findUnprocessed(0, "v1", 10)).map((p) => p.id).sort(),
      ["arca-2", "dc-2"],
    );
    assert.equal(await creative.posts.get("arca-1"), null);

    // 같은 원작 출처라도 다른 board의 글은 일치 후보가 아니다.
    const sources = (postId: string) => ({
      postId,
      version: 1,
      checkedAt: 100,
      expiresAt: 200,
      imageUrl: null,
      sources: [{ key: "x:123" as const, url: "https://x.com/a/status/123" }],
    });
    await translation.caches.saveSources(sources("arca-1"));
    await creative.caches.saveSources(sources("arca-2"));
    const found = await translation.caches.findSourceMatches({
      source: "dc",
      sourceKeys: ["x:123"],
      since: 0,
      until: 2000,
      version: 1,
      now: 150,
    });
    assert.deepEqual(
      found.map((entry) => entry.post.id),
      ["arca-1"],
    );

    await translation.grouping.commit({
      comparisons: [{ ...match, match }],
      processed: [],
    });
    const creativeMatch = { ...match, firstPostId: "dc-2", secondPostId: "arca-2" };
    await creative.grouping.commit({
      comparisons: [{ ...creativeMatch, match: creativeMatch }],
      processed: [],
    });
    const pairs = async (db: typeof translation) =>
      (await db.grouping.listMatches()).map((m) => [m.firstPostId, m.secondPostId]);
    assert.deepEqual(await pairs(translation), [["arca-1", "dc-1"]]);
    assert.deepEqual(await pairs(creative), [["arca-2", "dc-2"]]);

    // 번역 글이 창작 목록에 다시 나와도 번역 board에 남는다.
    await creative.posts.upsert([{ ...post("arca-1"), title: "옮겨진 글" }], 2000);
    assert.deepEqual(await ids(creative), ["arca-2", "dc-2"]);
    assert.equal((await translation.posts.get("arca-1"))?.title, "옮겨진 글");
  });
});

test("collection checks only the listed ids by primary key and stays within its board", async () => {
  await withDatabase(async (client) => {
    const translation = createWorkerRepositories(client, "translation");
    const creative = createWorkerRepositories(client, "creative");
    await translation.posts.upsert([post("arca-1"), post("dc-1")], 1000);
    await creative.posts.upsert([post("arca-2")], 1000);
    assert.deepEqual(
      [...(await creative.posts.findStoredIds(["arca-1", "arca-2", "arca-9"]))],
      ["arca-2"],
    );
    assert.deepEqual([...(await creative.posts.findStoredIds([]))], []);
    assert.equal(await creative.posts.hasAny("arca"), true);
    assert.equal(await creative.posts.hasAny("dc"), false);
    assert.equal(await translation.posts.hasAny("dc"), true);
    // board 인덱스로 찾으면 board의 글 전체를 훑는다. 기본 키로 넘긴 ID만 찾아야 한다.
    const plan = await client.execute(
      "EXPLAIN QUERY PLAN SELECT id, board FROM posts WHERE id IN ('arca-1', 'arca-2')",
    );
    assert.match(String(plan.rows[0].detail), /sqlite_autoindex_posts_1|PRIMARY KEY/);
  });
});

test("matches for a few posts are read through the post indexes, not the whole table", async () => {
  await withDatabase(async (client) => {
    const db = createWorkerRepositories(client, "translation");
    await db.posts.upsert([post("arca-1"), post("dc-1"), post("arca-2"), post("dc-2")]);
    await db.grouping.commit({ comparisons: [{ ...match, match }], processed: [] });
    const other = { ...match, firstPostId: "arca-2", secondPostId: "dc-2" };
    await db.grouping.commit({ comparisons: [{ ...other, match: other }], processed: [] });
    assert.deepEqual(
      (await db.grouping.listMatchesInvolving(["dc-1", "arca-9"])).map((m) => [
        m.firstPostId,
        m.secondPostId,
      ]),
      [["arca-1", "dc-1"]],
    );
    assert.deepEqual(await db.grouping.listMatchesInvolving([]), []);
    const plan = await client.execute({
      sql: "EXPLAIN QUERY PLAN SELECT * FROM automatic_matches WHERE first_post_id IN (?) OR second_post_id IN (?)",
      args: ["dc-1", "dc-1"],
    });
    assert.ok(plan.rows.some((row) => String(row.detail).includes("MULTI-INDEX OR")));
  });
});

test("six ten-minute polls of one hundred changing counters perform two hundred updates", async () => {
  await withDatabase(async (client) => {
    const db = createWorkerRepositories(client, "translation");
    const start = 1_800_000_000_000;
    const posts = Array.from({ length: 100 }, (_, index) => ({
      ...post(`arca-${index + 1}`),
      viewCount: 0,
      recommendCount: 0,
    }));
    await db.posts.upsert(posts, start);
    const before = await client.execute("SELECT total_changes() AS changes");
    for (let poll = 1; poll <= 6; poll++) {
      await db.posts.upsert(
        posts.map((post) => ({ ...post, viewCount: poll, recommendCount: poll })),
        start + poll * 10 * 60_000,
      );
    }
    const after = await client.execute("SELECT total_changes() AS changes");
    assert.equal(
      Number(after.rows[0].changes) - Number(before.rows[0].changes),
      200,
    );
    assert.equal((await db.posts.get("arca-1"))?.viewCount, 6);
  });
});

test("source and image caches honor versions, expiry and transactional replacement", async () => {
  await withDatabase(async (client) => {
    const db = createWorkerRepositories(client, "translation");
    await db.posts.upsert([post("arca-1")]);
    const source = {
      postId: "arca-1",
      version: 1,
      checkedAt: 100,
      expiresAt: 200,
      imageUrl: null,
      sources: [{ key: "x:123" as const, url: "https://x.com/a/status/123" }],
    };
    await db.caches.saveSources(source);
    assert.deepEqual(await db.caches.readSources("arca-1", 1, 100), source);
    assert.equal(await db.caches.readSources("arca-1", 2, 100), null);
    assert.equal(await db.caches.readSources("arca-1", 1, 200), null);
    assert.equal(await db.caches.readSources("arca-1", 1, 99), null);
    await db.caches.saveSources({ ...source, sources: [] });
    assert.deepEqual(
      (await db.caches.readSources("arca-1", 1, 101))?.sources,
      [],
    );
    const image: ImageCacheRecord = {
      key: "https://example.com/image",
      version: "phash-v1",
      checkedAt: 100,
      expiresAt: 200,
      width: 100,
      height: 100,
      wholeHash: "0123456789abcdef",
      regions: Array.from({ length: 9 }, () => ({
        hash: "0123456789abcdef",
        contrast: 12,
      })),
    };
    await db.caches.saveImage(image);
    assert.deepEqual(
      await db.caches.readImage(image.key, image.version, 101),
      image,
    );
    await assert.rejects(
      db.caches.saveImage({
        ...image,
        width: 200,
        regions: image.regions.map((r, i) =>
          i === 8 ? { ...r, hash: "invalid" } : r,
        ),
      }),
    );
    assert.deepEqual(
      await db.caches.readImage(image.key, image.version, 101),
      image,
    );
    assert.equal(
      await db.caches.readImage(image.key, "other-version", 101),
      null,
    );
    await db.caches.saveSources(source);
    await db.caches.pruneExpired(200);
    assert.equal(
      await db.caches.readImage(image.key, image.version, 200),
      null,
    );
    assert.equal(
      (await client.execute("SELECT * FROM image_regions")).rows.length,
      0,
    );
    // 만료된 출처는 판정에 쓰지 않지만 행은 남긴다.
    assert.equal(await db.caches.readSources("arca-1", 1, 200), null);
    assert.deepEqual(
      (await client.execute("SELECT post_id, original_id FROM post_sources")).rows.map((row) => ({ ...row })),
      [{ post_id: "arca-1", original_id: "123" }],
    );
  });
});

test("artist queue lists unresolved artworks newest first, retries failures three times and prunes orphans", async () => {
  await withDatabase(async (client) => {
    const db = createWorkerRepositories(client, "translation");
    await db.posts.upsert([post("arca-1", 1000), post("dc-2", 2000), post("dc-3", 3000)]);
    const save = (postId: string, sources: { key: `pixiv:${string}` | `x:${string}`; url: string }[]) =>
      db.caches.saveSources({ postId, version: 1, checkedAt: 100, expiresAt: 200, imageUrl: null, sources });
    await save("arca-1", [{ key: "pixiv:10", url: "https://www.pixiv.net/artworks/10" }]);
    await save("dc-2", [{ key: "pixiv:20", url: "https://www.pixiv.net/artworks/20" }]);
    // 같은 작품이 두 글에 실려도 한 번만 조회한다.
    await save("dc-3", [
      { key: "pixiv:10", url: "https://www.pixiv.net/artworks/10" },
      { key: "x:30", url: "https://x.com/a/status/30" },
    ]);
    const pending = async (platform: "x" | "pixiv") =>
      (await db.artists.listPending(platform, 10)).map((a) => a.originalId);
    assert.deepEqual(await pending("pixiv"), ["10", "20"]);
    assert.deepEqual(await pending("x"), ["30"]);
    // 창작 board 글의 출처는 대상이 아니다.
    assert.deepEqual(
      await createWorkerRepositories(client, "creative").artists.listPending("pixiv", 10),
      [],
    );

    await db.artists.save(
      { platform: "pixiv", originalId: "10", status: "found", artistId: "7", artistName: "작가", checkedAt: 300 },
      { userId: "7", xHandle: "artist" },
    );
    assert.deepEqual(await db.artists.readPixivProfile("7"), { xHandle: "artist" });
    assert.equal(await db.artists.readPixivProfile("8"), null);
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.deepEqual(await pending("pixiv"), ["20"]);
      await db.artists.recordFailure("pixiv", "20", 300 + attempt);
    }
    assert.deepEqual(await pending("pixiv"), []);
    await assert.rejects(
      client.execute("INSERT INTO artwork_artists(platform, original_id, status, checked_at) VALUES ('x', '1', 'found', 1)"),
    );

    // 글이 지워져 출처가 사라지면 작품과 프로필도 정리한다. 다른 글에 남은 작품은 유지한다.
    await client.execute("DELETE FROM posts WHERE id IN ('arca-1', 'dc-2')");
    await db.artists.pruneOrphans();
    assert.deepEqual(
      (await client.execute("SELECT original_id FROM artwork_artists ORDER BY original_id")).rows.map((r) => r.original_id),
      ["10"],
    );
    assert.deepEqual(await db.artists.readPixivProfile("7"), { xHandle: "artist" });
    await client.execute("DELETE FROM posts WHERE id = 'dc-3'");
    await db.artists.pruneOrphans();
    assert.equal((await client.execute("SELECT * FROM artwork_artists")).rows.length, 0);
    assert.equal(await db.artists.readPixivProfile("7"), null);
  });
});

test("jobs keep their board and deduplicate per board", async () => {
  await withDatabase(async (client) => {
    const jobs = createWorkerRepositories(client, "translation").jobs;
    const translation = await jobs.enqueue(
      { type: "collect", board: "translation", source: "arca" },
      1,
    );
    const creative = await jobs.enqueue(
      { type: "collect", board: "creative", source: "arca" },
      1,
    );
    assert.notEqual(translation.id, creative.id);
    assert.deepEqual(creative.request, {
      type: "collect",
      board: "creative",
      source: "arca",
    });
    const again = await jobs.enqueue(
      { type: "collect", board: "creative", source: "arca" },
      2,
    );
    assert.equal(again.id, creative.id);
    // 번역 작업 키는 board를 넣기 전과 같아야 배포 전에 쌓인 작업과 겹친다.
    assert.deepEqual(
      (
        await client.execute(
          "SELECT active_key FROM worker_jobs ORDER BY active_key",
        )
      ).rows.map((row) => row.active_key),
      ["collect:arca", "collect:creative:arca"],
    );
    const backfill = await jobs.enqueue(
      { type: "backfill", board: "creative", limit: 5 },
      1,
    );
    assert.deepEqual(backfill.request, {
      type: "backfill",
      board: "creative",
      limit: 5,
    });
  });
});

test("DC author ids are stored for judging but left out of the public snapshot", async () => {
  await withDatabase(async (client) => {
    const db = createWorkerRepositories(client, "translation");
    await db.posts.upsert([{ ...post("dc-1"), author: "작가", authorId: "uid1" }]);
    assert.equal((await db.posts.get("dc-1"))?.authorId, "uid1");
    const snapshot = await createBoardSnapshotReader(client).load("translation");
    assert.equal("authorId" in snapshot.posts[0], false);
  });
});

test("jobs deduplicate requests and serialize claims across independent clients", async () => {
  await withDatabase(async (client, url) => {
    const jobs = createWorkerRepositories(client, "translation").jobs;
    const second = openTursoDatabase({ url });
    try {
      const other = createWorkerRepositories(second, "translation").jobs;
      const first = await jobs.enqueue({ type: "collect", board: "translation", source: "all" }, 100);
      assert.equal(
        (await other.enqueue({ type: "collect", board: "translation", source: "all" }, 101)).id,
        first.id,
      );
      await jobs.enqueue({ type: "backfill", board: "translation", limit: 50 }, 200);
      const claimed = await jobs.claim("worker-a", 300, 1000);
      assert.ok(claimed);
      assert.equal(claimed.id, first.id);
      assert.equal(await other.claim("worker-b", 300, 1000), null);
      assert.equal(
        await other.complete(
          { jobId: claimed.id, token: "wrong" },
          { collectedCount: 1, comparedCount: 0, groupedCount: 0 },
          400,
        ),
        false,
      );
      assert.equal(
        await jobs.complete(
          lease(claimed),
          { collectedCount: 1, comparedCount: 0, groupedCount: 0 },
          400,
        ),
        true,
      );
      assert.equal(
        (await other.claim("worker-b", 400, 1000))?.request.type,
        "backfill",
      );
    } finally {
      second.close();
    }
  });
});

test("expired jobs recover with a new lease and old owners cannot finish them", async () => {
  await withDatabase(async (client) => {
    const jobs = createWorkerRepositories(client, "translation").jobs;
    const queued = await jobs.enqueue(
      { type: "collect", board: "translation", source: "arca" },
      0,
      2,
    );
    const first = await jobs.claim("a", 0, 100);
    assert.ok(first);
    assert.equal(await jobs.renew(lease(first), 50, 100), true);
    assert.equal(await jobs.claim("b", 149, 100), null);
    const resumed = await jobs.claim("b", 150, 100);
    assert.ok(resumed);
    assert.equal(resumed.id, first.id);
    assert.notEqual(resumed.leaseToken, first.leaseToken);
    assert.equal(resumed.attempts, 2);
    assert.equal(await jobs.renew(lease(first), 160, 100), false);
    assert.equal(await jobs.fail(lease(first), "stale", 160, null), false);
    assert.equal(
      await jobs.complete(
        lease(first),
        { collectedCount: 1, comparedCount: 0, groupedCount: 0 },
        160,
      ),
      false,
    );
    assert.equal(await jobs.claim("c", 250, 100), null);
    assert.equal((await jobs.get(queued.id))?.state, "failed");
  });
});

test("finished jobs are pruned after 7 days when completed and 30 days when failed", async () => {
  await withDatabase(async (client) => {
    const jobs = createWorkerRepositories(client, "translation").jobs;
    const day = 24 * 60 * 60_000;
    async function finish(source: "arca" | "dc", at: number, failed: boolean) {
      const queued = await jobs.enqueue({ type: "collect", board: "translation", source }, at, 1);
      const claimed = await jobs.claim("a", at, 100);
      assert.ok(claimed);
      if (failed) assert.equal(await jobs.fail(lease(claimed), "실패", at, null), true);
      else
        assert.equal(
          await jobs.complete(lease(claimed), { collectedCount: 0, comparedCount: 0, groupedCount: 0 }, at),
          true,
        );
      return queued.id;
    }
    const now = 40 * day;
    const oldCompleted = await finish("arca", now - 8 * day, false);
    const recentCompleted = await finish("arca", now - 6 * day, false);
    const oldFailed = await finish("dc", now - 31 * day, true);
    const recentFailed = await finish("dc", now - 8 * day, true);
    const waiting = await jobs.enqueue({ type: "collect", board: "translation", source: "all" }, 0);

    assert.equal(await jobs.pruneFinished(now), 2);
    assert.equal(await jobs.get(oldCompleted), null);
    assert.equal(await jobs.get(oldFailed), null);
    assert.equal((await jobs.get(recentCompleted))?.state, "completed");
    assert.equal((await jobs.get(recentFailed))?.state, "failed");
    // 오래 기다린 작업이라도 끝나지 않았으면 지우지 않는다.
    assert.equal((await jobs.get(waiting.id))?.state, "queued");
  });
});

test("retry waits and attempt limits survive reopen", async () => {
  await withDatabase(async (client, url) => {
    const jobs = createWorkerRepositories(client, "translation").jobs;
    const queued = await jobs.enqueue({ type: "backfill", board: "translation", limit: 50 }, 0, 2);
    const first = await jobs.claim("a", 0, 100);
    assert.ok(first);
    assert.equal(await jobs.fail(lease(first), "429", 10, 500), true);
    const reopened = openTursoDatabase({ url });
    try {
      const next = createWorkerRepositories(reopened, "translation").jobs;
      assert.equal(await next.claim("b", 499, 100), null);
      const retry = await next.claim("b", 500, 100);
      assert.ok(retry);
      assert.equal(await next.fail(lease(retry), "again", 510, 1000), true);
      assert.equal((await jobs.get(queued.id))?.state, "failed");
      assert.equal(await jobs.claim("c", 1000, 100), null);
    } finally {
      reopened.close();
    }
  });
});

test("collection state and the longest cooldown survive reopen", async () => {
  await withDatabase(async (client, url) => {
    const state = createWorkerRepositories(client, "translation").state;
    assert.equal((await state.list()).length, 4);
    const updated = {
      source: "arca" as const,
      board: "translation" as const,
      state: "idle" as const,
      historyBackfilled: true,
      lastAttemptAt: 100,
      lastSuccessAt: 150,
      lastCount: 12,
      error: null,
    };
    await state.saveCollection(updated);
    await state.deferRequests("images", 1000);
    await state.deferRequests("images", 500);
    const reopened = openTursoDatabase({ url });
    try {
      const read = createWorkerRepositories(reopened, "translation").state;
      assert.deepEqual(
        (await read.list()).find(
          (entry) => entry.source === "arca" && entry.board === "translation",
        ),
        updated,
      );
      assert.equal(await read.nextRequestAt("images"), 1000);
      assert.equal(await read.nextRequestAt("sources"), 0);
    } finally {
      reopened.close();
    }
  });
});

test("connection configuration rejects missing credentials before network requests", () => {
  assert.throws(() => openTursoDatabaseFromEnv({}), /TURSO_DATABASE_URL/);
  assert.throws(
    () => openTursoDatabase({ url: "libsql://example.turso.io" }),
    /인증 토큰/,
  );
  assert.throws(
    () => openTursoDatabase({ url: "http://example.com", authToken: "test" }),
    /DB URL/,
  );
});

test("post retention clamps months in Korea, rolls back failures and runs once per day", async () => {
  await withDatabase(async (client) => {
    const db = createWorkerRepositories(client, "translation");
    const today = Date.parse("2026-05-31T00:00:00+09:00");
    const cutoff = Date.parse("2026-02-28T00:00:00+09:00");
    await db.posts.upsert([post("arca-1", cutoff - 1), post("dc-1", cutoff)]);
    await db.grouping.commit({ comparisons: [{ ...match, match }], processed: [] });
    assert.equal((await db.grouping.listMatches()).length, 1);
    await db.caches.saveSources({
      postId: "arca-1",
      version: 1,
      checkedAt: 100,
      expiresAt: 200,
      imageUrl: null,
      sources: [{ key: "x:123", url: "https://x.com/a/status/123" }],
    });
    await client.execute(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON posts
      BEGIN SELECT RAISE(ABORT, 'test interruption'); END`);
    await assert.rejects(db.posts.pruneExpired(today), /test interruption/);
    assert.equal((await client.execute("SELECT * FROM post_retention")).rows.length, 0);
    assert.ok(await db.posts.get("arca-1"));
    await client.execute("DROP TRIGGER fail_cleanup");
    assert.equal(await db.posts.pruneExpired(today), 1);
    assert.equal(await db.posts.get("arca-1"), null);
    assert.ok(await db.posts.get("dc-1"));
    assert.equal((await client.execute("SELECT * FROM automatic_matches")).rows.length, 0);
    assert.equal((await client.execute("SELECT * FROM match_sources")).rows.length, 0);
    assert.equal((await client.execute("SELECT * FROM source_cache")).rows.length, 0);
    assert.equal((await client.execute("SELECT * FROM post_sources")).rows.length, 0);

    await db.posts.upsert([post("arca-2", cutoff - 1)]);
    const creative = createWorkerRepositories(client, "creative");
    await creative.posts.upsert([post("dc-9", cutoff - 1)]);
    const midnight = Date.parse("2026-06-01T00:00:00+09:00");
    assert.equal(await createWorkerRepositories(client, "translation").posts.pruneExpired(midnight - 1), 0);
    assert.ok(await db.posts.get("arca-2"));
    // 보관 기간은 board와 상관없이 적용되므로 창작 글도 함께 지운다.
    assert.equal(await db.posts.pruneExpired(midnight), 3);
    assert.equal(await creative.posts.get("dc-9"), null);
  });
});
