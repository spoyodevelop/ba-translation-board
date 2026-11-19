import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createNodeRequest } from "../src/worker/request.ts";
import { createRemoteCollector } from "../src/worker/remote.ts";
import { createImageDownloader } from "../src/worker/imageDownload.ts";
import { createNodePostCollector } from "../src/worker/collect.ts";
import { createNodeSourceCollector } from "../src/worker/sources.ts";
import { arcaAppUserAgent } from "../src/arca/constants.ts";
import { boardConfigs } from "../src/shared/boards.ts";

const translation = boardConfigs.translation;
import {
  retryDelayMs,
  SourceRequestError,
} from "../src/sources/requestError.ts";
import { openTursoDatabase } from "../src/database/connection.ts";
import { migrateTursoDatabase } from "../src/database/schema.ts";
import { createWorkerRepositories } from "../src/database/repositories.ts";
import type { WorkerRepositories } from "../src/database/repositories.ts";
import { sourceCacheVersion } from "../src/sources/sourceCache.ts";
import type { ListedPost, Source } from "../src/shared/post";
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

function post(source: Source, id: number): ListedPost {
  return {
    id: `${source}-${id}`,
    source,
    sourceId: String(id),
    title: "번역",
    url: `https://example.com/${id}`,
    author: null,
    authorId: null,
    publishedAt: "2026-10-02T00:00:00Z",
    duplicateGroupId: null,
    viewCount: 1,
    recommendCount: 2,
  };
}

async function withDatabase(
  run: (
    db: WorkerRepositories,
    url: string,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "board-worker-"));
  const url = pathToFileURL(join(directory, "board.db")).href;
  const client = openTursoDatabase({ url });
  try {
    await migrateTursoDatabase(client);
    await run(createWorkerRepositories(client, "translation"), url);
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("site-specific request headers preserve custom headers and cancellation", async () => {
  const seen: Request[] = [];
  const request = createNodeRequest(async (input) => {
    seen.push(input as Request);
    return new Response("");
  });
  const controller = new AbortController();
  await request(
    "https://arca.live/b/bluearchive?category=%EB%B2%88%EC%97%AD&p=1",
    { signal: controller.signal, headers: { "X-Test": "kept" } },
  );
  await request("https://arca.live/api/app/view/article/breaking/123");
  await request("https://arca.live/b/bluearchive?category=other");
  await request(
    "https://arca.live.evil.test/api/app/view/article/breaking/123",
  );
  for (const [host, referer] of [
    ["dcimg8.dcinside.co.kr", "https://gall.dcinside.com/"],
    ["ac-o.arca.live", "https://arca.live/"],
    ["ac.arca.live", "https://arca.live/"],
  ]) {
    await request(`https://${host}/image`);
    assert.equal(seen.at(-1)?.headers.get("Referer"), referer);
  }
  await request("https://dcimg8.dcinside.co.kr.evil.test/image");
  assert.equal(seen.at(-1)?.headers.get("Referer"), null);
  assert.equal(seen[0].headers.get("User-Agent"), arcaAppUserAgent);
  assert.equal(seen[1].headers.get("User-Agent"), arcaAppUserAgent);
  assert.notEqual(seen[2].headers.get("User-Agent"), arcaAppUserAgent);
  assert.notEqual(seen[3].headers.get("User-Agent"), arcaAppUserAgent);
  assert.equal(seen[0].headers.get("X-Test"), "kept");
  controller.abort();
  assert.equal(seen[0].signal.aborted, true);
});

test("Node list requests parse actual row structures and reject empty first pages or HTTP failures", async () => {
  const urls: URL[] = [];
  const remote = createRemoteCollector(
    createNodeRequest(async (input) => {
      const url = new URL((input as Request).url);
      urls.push(url);
      if (url.hostname === "arca.live")
        return new Response(`<div class="list-table"><a class="vrow column" href="/b/bluearchive/123">
      <span class="title">번역</span><time datetime="2026-10-02T00:00:00Z"></time></a></div>`);
      return new Response(`<table><tr class="us-post" data-no="456"><td class="gall_subject">번역</td>
      <td class="gall_tit"><a href="/mgallery/board/view/?id=projectmx&no=456">번역</a></td>
      <td class="gall_date" title="2026-10-02 09:00:00"></td></tr></table>`);
    }),
  );
  assert.equal((await remote.list("arca", 2, translation))[0].id, "arca-123");
  assert.equal((await remote.list("dc", 3, translation))[0].id, "dc-456");
  assert.equal(urls[0].searchParams.get("category"), "번역");
  assert.equal(urls[0].searchParams.get("p"), "2");
  assert.equal(urls[1].searchParams.get("search_head"), "120");
  assert.equal(urls[1].searchParams.get("page"), "3");
  const empty = createRemoteCollector(
    async () => new Response("<p>empty list</p>"),
  );
  await assert.rejects(empty.list("arca", 1, translation), /글을 찾지/);
  assert.deepEqual(await empty.list("arca", 2, translation), []);
  const challenge = createRemoteCollector(
    async () => new Response("<title>Just a moment</title>"),
  );
  await assert.rejects(challenge.list("arca", 2, translation), /차단 안내/);
  const blocked = createRemoteCollector(
    async () =>
      new Response("", { status: 429, headers: { "Retry-After": "60" } }),
  );
  await assert.rejects(
    blocked.list("dc", 1, translation),
    (error) =>
      error instanceof SourceRequestError &&
      error.status === 429 &&
      error.retryAfterMs === 60_000,
  );
  assert.equal(
    retryDelayMs(
      new Response("", {
        headers: { "Retry-After": new Date(100_000).toUTCString() },
      }),
      0,
    ),
    100_000,
  );
  // 429는 서버가 더 짧게 주거나 주지 않아도 최소 10초 쉰다.
  assert.equal(
    retryDelayMs(
      new Response("", { status: 429, headers: { "Retry-After": "1" } }),
      0,
    ),
    10_000,
  );
  assert.equal(retryDelayMs(new Response("", { status: 429 }), 0), 10_000);
  assert.equal(retryDelayMs(new Response("", { status: 503 }), 0), 0);
});

test("images validate file bytes rather than CDN MIME and enforce declared and streaming limits", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const download = createImageDownloader(
    async () =>
      new Response(png, {
        headers: { "Content-Type": "application/octet-stream" },
      }),
  );
  assert.equal(
    (await download("https://dcimg8.dcinside.co.kr/image")).contentType,
    "image/png",
  );
  const html = createImageDownloader(
    async () =>
      new Response("<html>blocked</html>", {
        headers: { "Content-Type": "image/png" },
      }),
  );
  await assert.rejects(html("https://example.com"), /이미지 형식/);
  const declared = createImageDownloader(
    async () => new Response(png, { headers: { "Content-Length": "8388609" } }),
  );
  await assert.rejects(declared("https://example.com"), /8MiB/);
  let cancelled = false;
  const streamed = createImageDownloader(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(streamed("https://example.com"), /8MiB/);
  assert.equal(cancelled, true);
});

test("initial collection reads ten pages; later collection stops at known posts and refreshes metadata", async () => {
  await withDatabase(async (db) => {
    let time = 1_800_000_000_000;
    const pages: number[] = [];
    let refreshed = false;
    const deps = {
      repositories: db,
      board: translation,
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
      remote: {
        async list(source: Source, page: number) {
          pages.push(page);
          if (refreshed)
            return [{ ...post(source, 20), viewCount: 99 }, post(source, 1)];
          return [post(source, page)];
        },
      },
    };
    const collector = createNodePostCollector(deps);
    assert.equal(await collector.collect("arca"), 10);
    assert.equal(pages.length, 10);
    assert.equal((await db.posts.listRecent(0, "arca")).length, 10);
    const saved = await translationState(db, "arca");
    assert.equal(saved.historyBackfilled, true);
    assert.equal(saved.state, "idle");
    refreshed = true;
    pages.length = 0;
    assert.equal(await collector.collect("arca"), 2);
    assert.deepEqual(pages, [1]);
    assert.equal((await db.posts.get("arca-20"))?.viewCount, 99);
  });
});

test("collection saves new posts immediately while existing counters keep their own thirty-minute interval", async () => {
  await withDatabase(async (db, url) => {
    const start = 1_800_000_000_000;
    let time = start;
    await db.posts.upsert(
      [{ ...post("arca", 1), viewCount: 1, recommendCount: 2 }],
      time,
    );
    const previous = await translationState(db, "arca");
    await db.state.saveCollection({ ...previous, historyBackfilled: true });
    let views = 20;
    const pages: number[] = [];
    const deps = {
      repositories: db,
      board: translation,
      now: () => time,
      sleep: async () => {},
      remote: {
        async list(source: Source, page: number) {
          pages.push(page);
          return [
            { ...post(source, 2), viewCount: views },
            { ...post(source, 1), viewCount: views, recommendCount: views },
          ];
        },
      },
    };
    time = start + 10 * 60_000;
    assert.equal(await createNodePostCollector(deps).collect("arca"), 2);
    assert.equal((await db.posts.get("arca-1"))?.viewCount, 1);
    assert.equal((await db.posts.get("arca-2"))?.viewCount, 20);
    const reopened = openTursoDatabase({ url });
    try {
      const collector = createNodePostCollector({
        ...deps,
        repositories: createWorkerRepositories(reopened, "translation"),
      });
      views = 30;
      time = start + 30 * 60_000 - 1;
      await collector.collect("arca");
      assert.equal((await db.posts.get("arca-1"))?.viewCount, 1);
      time += 1;
      await collector.collect("arca");
      assert.equal((await db.posts.get("arca-1"))?.viewCount, 30);
      assert.equal((await db.posts.get("arca-1"))?.recommendCount, 30);
      assert.equal((await db.posts.get("arca-2"))?.viewCount, 20);
      time = start + 40 * 60_000;
      await collector.collect("arca");
      assert.equal((await db.posts.get("arca-2"))?.viewCount, 30);
      assert.deepEqual(pages, [1, 1, 1, 1]);
    } finally {
      reopened.close();
    }
  });
});

test("failed catch-up preserves posts and success state; 429 cooldown survives restart", async () => {
  await withDatabase(async (db, url) => {
    const time = 1_800_000_000_000;
    await db.posts.upsert([
      { ...post("dc", 1), viewCount: 12, recommendCount: 3 },
    ]);
    const previous = await translationState(db, "dc");
    await db.state.saveCollection({
      ...previous,
      historyBackfilled: true,
      lastSuccessAt: 100,
      lastCount: 1,
    });
    const deps = {
      repositories: db,
      board: translation,
      now: () => time,
      sleep: async () => {},
      remote: {
        async list(_source: Source, page: number) {
          if (page === 1) return [post("dc", 2)];
          throw new SourceRequestError("HTTP 429", "http", 429, 60_000);
        },
      },
    };
    await assert.rejects(createNodePostCollector(deps).collect("dc"), /429/);
    assert.equal(await db.posts.get("dc-2"), null);
    assert.equal((await db.posts.get("dc-1"))?.viewCount, 12);
    const failed = await translationState(db, "dc");
    assert.equal(failed.state, "error");
    assert.equal(failed.lastSuccessAt, 100);
    assert.equal(failed.lastCount, 1);
    const reopened = openTursoDatabase({ url });
    try {
      await assert.rejects(
        createNodePostCollector({
          ...deps,
          repositories: createWorkerRepositories(reopened, "translation"),
        }).collect("dc"),
        /대기 중/,
      );
      assert.equal(await db.state.nextRequestAt("dc-list"), time + 60_000);
    } finally {
      reopened.close();
    }
  });
});

test("403 pauses listing requests for twenty minutes across restarts and resumes at the deadline", async () => {
  await withDatabase(async (db, url) => {
    let time = 1_800_000_000_000;
    let calls = 0;
    const savedPost = post("arca", 1);
    await db.posts.upsert([{ ...savedPost, viewCount: 1, recommendCount: 2 }]);
    const state = await translationState(db, "arca");
    await db.state.saveCollection({ ...state, historyBackfilled: true });
    const deps = {
      repositories: db,
      board: translation,
      now: () => time,
      sleep: async () => {},
      remote: {
        async list() {
          calls++;
          if (calls === 1)
            throw new SourceRequestError("HTTP 403", "http", 403);
          return [savedPost];
        },
      },
    };
    await assert.rejects(createNodePostCollector(deps).collect("arca"), /403/);
    assert.equal(await db.state.nextRequestAt("arca-list"), time + 20 * 60_000);
    assert.equal(await db.state.nextRequestAt("dc-list"), 0);
    const reopened = openTursoDatabase({ url });
    try {
      const collector = createNodePostCollector({
        ...deps,
        repositories: createWorkerRepositories(reopened, "translation"),
      });
      time += 20 * 60_000 - 1;
      await assert.rejects(collector.collect("arca"), /대기 중/);
      assert.equal(calls, 1);
      time += 1;
      assert.equal(await collector.collect("arca"), 1);
      assert.equal(calls, 2);
    } finally {
      reopened.close();
    }
  });
});

test("Node source collector uses domain caches across restarts and does not cache 404 failures", async () => {
  await withDatabase(async (db, url) => {
    let time = 1_800_000_000_000;
    let requests = 0;
    const posts = [post("arca", 1), post("dc", 2)];
    await db.posts.upsert(
      posts.map((p) => ({ ...p, viewCount: null, recommendCount: null })),
    );
    const deps = {
      repositories: db,
      board: translation,
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
      request: createNodeRequest(async (input) => {
        requests++;
        if ((input as Request).url.includes("arca.live"))
          return Response.json({
            id: 1,
            boardSlug: "bluearchive",
            content:
              '<a href="https://x.com/a/status/123">출처</a><img src="https://ac.arca.live/image.webp">',
          });
        return new Response("", { status: 404 });
      }),
    };
    const results = await createNodeSourceCollector(deps).lookup(posts);
    assert.equal(results["arca-1"].kind, "found");
    const cachedBody = await db.caches.readSources(
      "arca-1",
      sourceCacheVersion,
      time,
    );
    assert.deepEqual(
      cachedBody?.sources.map((source) => source.key),
      ["x:123"],
    );
    assert.equal(cachedBody?.imageUrl, "https://ac.arca.live/image.webp");
    assert.equal(results["dc-2"].kind, "failed");
    assert.equal(requests, 2);
    assert.equal(
      await db.caches.readSources("dc-2", sourceCacheVersion, time),
      null,
    );
    const reopened = openTursoDatabase({ url });
    try {
      const cached = await createNodeSourceCollector({
        ...deps,
        repositories: createWorkerRepositories(reopened, "translation"),
      }).lookup([posts[0]]);
      assert.equal(cached["arca-1"].kind, "found");
      assert.equal(requests, 2);
    } finally {
      reopened.close();
    }
  });
});
