import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { openTursoDatabase } from "../src/database/connection.ts";
import { migrateTursoDatabase } from "../src/database/schema.ts";
import { createWorkerRepositories } from "../src/database/repositories.ts";
import { createBoardSnapshotReader } from "../src/database/boardSnapshot.ts";
import { createBoardClient } from "../src/web/boardClient.ts";
import { createBoardApi } from "../src/server/boardApi.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  createPersonalStateStore,
  personalKeys,
} from "../src/web/personalState.ts";
import type { Post } from "../src/shared/post";
import { boardFromSearch, searchForBoard } from "../src/web/hooks/useBoardTab.ts";
import { artistFilterFromSearch, searchForArtistFilter } from "../src/web/hooks/useArtistFilter.ts";
import {
  artistFilterParams,
  followArtistParams,
  openPostParams,
  searchParams,
} from "../src/web/analytics.ts";
import type { GroupEdge } from "../src/grouping/postGroups";
import { mergePostGroups } from "../src/grouping/postGroups.ts";
import type { CollectionState } from "../src/database/types";

// 수집 상태에는 창작 행도 있으므로 번역 행을 골라 쓴다.
async function translationState(
  db: { state: { list(): Promise<CollectionState[]> } },
  source: "arca" | "dc",
) {
  const state = (await db.state.list()).find(
    (entry) => entry.source === source && entry.board === "translation",
  );
  assert.ok(state);
  return state;
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
function post(source: "arca" | "dc", id: number): Post {
  return {
    id: `${source}-${id}`,
    source,
    sourceId: String(id),
    title: `제목 ${id}`,
    url: `https://example.com/${id}`,
    author: null,
    publishedAt: "2026-10-03T00:00:00Z",
    duplicateGroupId: "automatic-group",
  };
}
const posts = [post("arca", 1), post("dc", 2), post("arca", 3), post("dc", 4)];
const edges: GroupEdge[] = [
  { firstId: "arca-1", secondId: "dc-2" },
  { firstId: "dc-2", secondId: "arca-3" },
  { firstId: "arca-3", secondId: "dc-4" },
];

test("client reads a consistent metadata and edge snapshot, without requesting private caches or writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "board-client-"));
  const client = openTursoDatabase({
    url: pathToFileURL(join(directory, "test.db")).href,
  });
  try {
    await migrateTursoDatabase(client);
    const db = createWorkerRepositories(client, "translation");
    await db.posts.upsert(
      posts.map((p) => ({
        ...p,
        viewCount: null,
        recommendCount: 2,
        authorId: null,
      })),
    );
    await db.grouping.commit({
      comparisons: [
        {
          firstPostId: "arca-1",
          secondPostId: "dc-2",
          match: {
            firstPostId: "arca-1",
            secondPostId: "dc-2",
            sourceKeys: ["pixiv:123"],
            imageEvidence: null,
            titleEvidence: null,
            creativeEvidence: null,
            algorithmVersion: "test",
            matchedAt: 1000,
          },
        },
      ],
      processed: [],
    });
    const state = await translationState(db, "arca");
    await db.state.saveCollection({ ...state, lastSuccessAt: 2000 });
    // 창작 글·연결·수집 시각은 번역 탭 응답에 섞이지 않는다.
    const creative = createWorkerRepositories(client, "creative");
    await creative.posts.upsert([
      { ...post("arca", 7), viewCount: null, recommendCount: null, authorId: null },
      { ...post("dc", 8), viewCount: null, recommendCount: null, authorId: null },
    ]);
    const creativeMatch = {
      firstPostId: "arca-7",
      secondPostId: "dc-8",
      sourceKeys: [],
      imageEvidence: null,
      titleEvidence: null,
      creativeEvidence: { kind: "manual" as const },
      algorithmVersion: "creative-manual-v1",
      matchedAt: 1,
    };
    await creative.grouping.commit({
      comparisons: [{ ...creativeMatch, match: creativeMatch }],
      processed: [],
    });
    const creativeState = (await db.state.list()).find(
      (entry) => entry.source === "dc" && entry.board === "creative",
    )!;
    await db.state.saveCollection({ ...creativeState, lastSuccessAt: 9000 });
    const reader = createBoardSnapshotReader(client);
    const snapshot = await reader.load("translation");
    assert.equal(snapshot.posts.length, 4);
    assert.deepEqual(snapshot.automaticEdges, [edges[0]]);
    assert.equal(snapshot.updatedAt, new Date(2000).toISOString());
    assert.equal(snapshot.posts[0].viewCount, null);
    assert.equal(snapshot.posts[0].recommendCount, 2);
    assert.deepEqual(snapshot.artists, []);
    assert.equal((await db.jobs.list()).length, 0);
    assert.equal((await db.posts.findUnprocessed(0, "test", 10)).length, 4);
    const creativeSnapshot = await reader.load("creative");
    assert.deepEqual(
      creativeSnapshot.posts.map((p) => p.id).sort(),
      ["arca-7", "dc-8"],
    );
    assert.deepEqual(creativeSnapshot.automaticEdges, [
      { firstId: "arca-7", secondId: "dc-8" },
    ]);
    assert.equal(creativeSnapshot.updatedAt, new Date(9000).toISOString());
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("board API exposes a shared read snapshot, rejects writes and hides query errors", async (context) => {
  const snapshot = { posts: [], automaticEdges: [], artists: [], updatedAt: null };
  let reads = 0;
  let fail = false;
  const boards: string[] = [];
  context.mock.method(console, "error", () => {});
  const server = createServer(
    createBoardApi({
      async load(board) {
        reads += 1;
        boards.push(board);
        if (fail) throw new Error("private database details");
        return snapshot;
      },
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/board`;
  const request: typeof fetch = (input, init) => {
    assert.equal(input, "/api/board?board=translation");
    return fetch(`${url}?board=translation`, init);
  };
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      response.headers.get("vercel-cdn-cache-control"),
      "public, s-maxage=300, stale-while-revalidate=600",
    );
    assert.deepEqual(
      await createBoardClient(request).load("translation"),
      snapshot,
    );
    // board 없이 오던 옛 주소는 번역 탭으로 둔다.
    assert.deepEqual(boards, ["translation", "translation"]);
    await fetch(`${url}?board=creative`);
    assert.equal(boards.at(-1), "creative");
    const unknown = await fetch(`${url}?board=other`);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.headers.get("vercel-cdn-cache-control"), null);
    // 캐시 키만 바꾸는 주소와 객체 기본 속성 이름은 DB를 읽지 않고 거절한다.
    for (const search of [
      "?board=translation&x=1",
      "?board=translation&",
      "?x=1",
      "?board=%74ranslation",
      "?board=translation&board=creative",
      "?board=__proto__",
      "?board=constructor",
      "?board=",
    ]) {
      const bypass = await fetch(`${url}${search}`);
      assert.equal(bypass.status, 400, search);
      assert.equal(bypass.headers.get("vercel-cdn-cache-control"), null);
    }
    const rejected = await fetch(url, { method: "POST" });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get("allow"), "GET");
    assert.equal(reads, 3);
    fail = true;
    const unavailable = await fetch(url);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("vercel-cdn-cache-control"), null);
    assert.doesNotMatch(await unavailable.text(), /private database/);
    await assert.rejects(
      createBoardClient(request).load("translation"),
      /목록을 불러오지/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});

test("visits stay local, merge other tabs and survive store recreation", () => {
  const browser = storage();
  const first = createPersonalStateStore(browser);
  assert.equal(first.readVisits().size, 0);
  first.visit("arca-1", new Set());
  const second = createPersonalStateStore(browser);
  second.visit("dc-2", new Set());
  first.visit("arca-3", new Set(["arca-1"]));
  assert.deepEqual([...createPersonalStateStore(browser).readVisits()].sort(), [
    "arca-1",
    "arca-3",
    "dc-2",
  ]);
  assert.equal(createPersonalStateStore(storage()).readVisits().size, 0);
  assert.throws(() => first.visit("unknown", new Set()), /ID/);
});

test("automatic edges join every connected post into one group and ignore posts the tab did not load", () => {
  const grouped = mergePostGroups(
    [...posts, post("arca", 9)],
    [...edges, { firstId: "dc-4", secondId: "dc-99" }],
  );
  const ids = new Set(grouped.slice(0, 4).map((p) => p.duplicateGroupId));
  assert.equal(ids.size, 1);
  assert.match([...ids][0]!, /^source:arca-1:arca-3$/);
  assert.equal(grouped[4].duplicateGroupId, null);
});

test("the tab lives in the address and the translation tab keeps the old address", () => {
  assert.equal(boardFromSearch(""), "translation");
  assert.equal(boardFromSearch("?tab=creative"), "creative");
  assert.equal(boardFromSearch("?tab=other"), "translation");
  assert.equal(searchForBoard("", "creative"), "?tab=creative");
  assert.equal(searchForBoard("?tab=creative", "translation"), "");
  assert.equal(searchForBoard("?utm=1", "creative"), "?utm=1&tab=creative");
});

test("the artist filter lives in the address and switching tabs clears it", () => {
  assert.equal(artistFilterFromSearch(""), null);
  assert.deepEqual(artistFilterFromSearch("?artist=x%3Akakapomilk"), {
    kind: "artist",
    key: "x:kakapomilk",
  });
  assert.deepEqual(artistFilterFromSearch("?artist=followed"), { kind: "followed" });
  assert.equal(
    searchForArtistFilter("", { kind: "artist", key: "x:kakapomilk" }),
    "?artist=x%3Akakapomilk",
  );
  assert.equal(searchForArtistFilter("?utm=1", { kind: "followed" }), "?utm=1&artist=followed");
  assert.equal(searchForArtistFilter("?artist=x%3Aa&utm=1", null), "?utm=1");
  assert.equal(searchForBoard("?artist=followed", "creative"), "?tab=creative");
  // 어느 작가인지, 누구를 팔로우했는지는 GA로 보내지 않는다.
  assert.deepEqual(
    artistFilterParams({ board: "translation", mode: "followed", groupCount: 4 }),
    { board: "translation", filter_mode: "followed", group_count: 4 },
  );
  assert.deepEqual(followArtistParams({ board: "translation", action: "follow" }), {
    board: "translation",
    action: "follow",
  });
});

test("followed artists persist per browser, ignore invalid entries and merge changes from other tabs", () => {
  const browser = storage();
  const first = createPersonalStateStore(browser);
  assert.deepEqual(first.readFollowedArtists(), []);
  first.follow({ key: "x:kakapomilk", name: "@kakapomilk" });
  // 다른 탭이 저장한 팔로우를 덮어쓰지 않는다.
  const second = createPersonalStateStore(browser);
  second.follow({ key: "pixiv:8", name: "작가" });
  assert.deepEqual(first.follow({ key: "x:kakapomilk", name: "@KakapoMilk" }), [
    { key: "pixiv:8", name: "작가" },
    { key: "x:kakapomilk", name: "@KakapoMilk" },
  ]);
  assert.deepEqual(first.unfollow("pixiv:8"), [{ key: "x:kakapomilk", name: "@KakapoMilk" }]);
  assert.throws(() => first.follow({ key: "followed", name: "x" }));
  browser.setItem(
    personalKeys.followedArtists,
    JSON.stringify([{ key: "x:ok", name: "@ok" }, { key: "bad", name: "x" }, { key: "x:noname" }, null]),
  );
  assert.deepEqual(first.readFollowedArtists(), [{ key: "x:ok", name: "@ok" }]);
  browser.setItem(personalKeys.followedArtists, "{}");
  assert.throws(() => first.readFollowedArtists());
});

test("analytics events carry usage only, never what a person read or searched for", () => {
  const post: Post = {
    id: "arca-188138125",
    source: "arca",
    sourceId: "188138125",
    title: "번역 제목",
    url: "https://arca.live/b/bluearchive/188138125",
    author: "작성자",
    publishedAt: "2026-11-07T00:00:00.000Z",
    duplicateGroupId: null,
  };
  const opened = openPostParams({
    post,
    board: "translation",
    groupSize: 2,
    position: 27,
    page: 2,
    filtered: false,
  });
  assert.deepEqual(opened, {
    board: "translation",
    post_source: "arca",
    group_size: 2,
    list_position: 27,
    page: 2,
    filtered: false,
  });
  const sent = JSON.stringify(opened);
  for (const personal of [post.id, post.sourceId, post.title, post.url, "작성자"])
    assert.ok(!sent.includes(personal), `open_post must not send ${personal}`);

  assert.deepEqual(
    searchParams({ board: "creative", hasQuery: true, minRecommend: "" }),
    { board: "creative", has_query: true, min_recommend: "none" },
  );
  assert.deepEqual(
    searchParams({ board: "translation", hasQuery: false, minRecommend: "custom" }),
    { board: "translation", has_query: false, min_recommend: "custom" },
  );
});

test("snapshot lists each post's original artists once, joining pixiv artists to their linked X account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "board-artists-"));
  const client = openTursoDatabase({
    url: pathToFileURL(join(directory, "test.db")).href,
  });
  try {
    await migrateTursoDatabase(client);
    const db = createWorkerRepositories(client, "translation");
    await db.posts.upsert(
      [post("arca", 1), post("dc", 2), post("arca", 3)].map((p) => ({
        ...p,
        viewCount: null,
        recommendCount: null,
        authorId: null,
      })),
    );
    const save = (postId: string, sources: { key: `x:${string}` | `pixiv:${string}`; url: string }[]) =>
      db.caches.saveSources({ postId, version: 1, checkedAt: 1, expiresAt: 2, imageUrl: null, sources });
    // 아카는 픽시브, 디시는 X로 출처를 달았지만 같은 작가다. 만료된 출처도 작가 표시에는 쓴다.
    await save("arca-1", [
      { key: "pixiv:10", url: "https://www.pixiv.net/artworks/10" },
      { key: "pixiv:11", url: "https://www.pixiv.net/artworks/11" },
    ]);
    await save("dc-2", [{ key: "x:20", url: "https://x.com/Kakapo/status/20" }]);
    await save("arca-3", [
      { key: "pixiv:30", url: "https://www.pixiv.net/artworks/30" },
      { key: "pixiv:31", url: "https://www.pixiv.net/artworks/31" },
    ]);
    await db.artists.save(
      { platform: "pixiv", originalId: "10", status: "found", artistId: "7", artistName: "カカポ", checkedAt: 1 },
      { userId: "7", xHandle: "kakapo" },
    );
    await db.artists.save({ platform: "pixiv", originalId: "11", status: "found", artistId: "7", artistName: "カカポ", checkedAt: 1 });
    await db.artists.save({ platform: "x", originalId: "20", status: "found", artistId: "kakapo", artistName: "Kakapo", checkedAt: 1 });
    await db.artists.save(
      { platform: "pixiv", originalId: "30", status: "found", artistId: "8", artistName: "작가", checkedAt: 1 },
      { userId: "8", xHandle: null },
    );
    await db.artists.save({ platform: "pixiv", originalId: "31", status: "missing", checkedAt: 1 });
    const snapshot = await createBoardSnapshotReader(client).load("translation");
    assert.deepEqual(snapshot.artists, [
      { postId: "arca-1", key: "x:kakapo", name: "@kakapo" },
      { postId: "arca-3", key: "pixiv:8", name: "작가" },
      { postId: "dc-2", key: "x:kakapo", name: "@Kakapo" },
    ]);
    assert.deepEqual((await createBoardSnapshotReader(client).load("creative")).artists, []);
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
