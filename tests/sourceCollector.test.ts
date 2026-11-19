import assert from "node:assert/strict";
import { test } from "node:test";
import { createSourceCollector } from "../src/sources/collector.ts";
import { fetchArticleBody } from "../src/sources/fetchBody.ts";
import { SourceRequestError } from "../src/sources/requestError.ts";

import type { Post, Source } from "../src/shared/post";
import type { SourceLookupSuccess } from "../src/sources/types";

const post = (id: number, source: Source = "dc"): Post => ({
  id: `${source}-${id}`,
  source,
  sourceId: String(id),
  title: "본문",
  url: "",
  author: null,
  publishedAt: new Date().toISOString(),
  duplicateGroupId: null,
});

function harness(fetchBody: (post: Post) => Promise<string>) {
  let time = 1000;
  let next = 0;
  const stored = new Map<string, SourceLookupSuccess>();
  const waits: number[] = [];
  let calls = 0;
  const collector = createSourceCollector({
    cache: {
      async read(id) {
        return stored.get(id);
      },
      async save(id, result) {
        if (result.kind !== "failed") stored.set(id, result);
      },
    },
    fetchBody(post) {
      calls++;
      return fetchBody(post);
    },
    async readNextRequestAt() {
      return next;
    },
    async saveNextRequestAt(value) {
      next = value;
    },
    now: () => time,
    async sleep(ms) {
      waits.push(ms);
      time += ms;
    },
  });
  return { collector, waits, stored, calls: () => calls };
}

test("DC runs five at a time, waits between batches and reuses cache across queued callers", async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const h = harness(async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return "https://x.com/artist/status/12345";
  });
  const posts = Array.from({ length: 10 }, (_, i) => post(i + 1));
  const [first, second] = await Promise.all([
    h.collector.lookup(posts),
    h.collector.lookup(posts),
  ]);
  assert.equal(Object.keys(first).length, 10);
  assert.deepEqual(first, second);
  assert.equal(calls, 10);
  assert.equal(peak, 5);
  assert.deepEqual(h.waits, [50]);
});

test("DC failures retry three times with exponential backoff and are never cached", async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    throw new SourceRequestError("본문 누락", "missing-body", 200);
  });
  const results = await h.collector.lookup([post(1)]);
  assert.equal(calls, 4);
  assert.equal(results["dc-1"].kind, "failed");
  assert.equal(h.stored.size, 0);
  assert.deepEqual(h.waits, [1000, 2000, 4000]);
});

test("HTTP 403 stops subsequent batches without caching failures", async () => {
  const blocked = harness(async () => {
    throw new SourceRequestError("HTTP 403", "http", 403);
  });
  const results = await blocked.collector.lookup(
    Array.from({ length: 10 }, (_, i) => post(i + 1)),
  );
  assert.equal(blocked.calls(), 5);
  assert.equal(Object.keys(results).length, 10);
  assert.equal(blocked.stored.size, 0);
});

test("Arca requests are serial with a 200ms pause and articles without sources can be cached", async () => {
  let active = 0;
  const h = harness(async () => {
    active++;
    assert.equal(active, 1);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return "<p>본문</p>";
  });
  const result = await h.collector.lookup([post(1, "arca"), post(2, "arca")]);
  assert.equal(result["arca-1"].kind, "none");
  assert.equal(h.stored.size, 2);
  assert.deepEqual(h.waits, [200]);
});

test("429 delays retry and later DC batches using Retry-After", async () => {
  let attempts = 0;
  const h = harness(async (p) => {
    if (p.sourceId === "1" && attempts++ === 0) {
      throw new SourceRequestError("HTTP 429", "http", 429, 3000);
    }
    return "<p>출처 없음</p>";
  });
  const results = await h.collector.lookup(
    Array.from({ length: 6 }, (_, i) => post(i + 1)),
  );
  assert.equal(results["dc-1"].kind, "none");
  assert.equal(results["dc-6"].kind, "none");
  assert.deepEqual(h.waits, [3000, 50]);
  assert.equal(h.calls(), 7);
});

test("long 429 cooldown stops remaining batches and survives queued calls", async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    throw new SourceRequestError("HTTP 429", "http", 429, 60000);
  });
  const results = await h.collector.lookup(
    Array.from({ length: 11 }, (_, i) => post(i + 1)),
  );
  await h.collector.lookup([post(12)]);
  assert.equal(Object.keys(results).length, 11);
  assert.equal(calls, 5);
  assert.deepEqual(h.waits, []);
});

test("transport validates article identity and distinguishes block pages from missing sources", async () => {
  const request =
    (body: string, status = 200, headers: HeadersInit = {}): typeof fetch =>
    async () =>
      new Response(body, { status, headers });
  const article = JSON.stringify({
    id: 1,
    boardSlug: "bluearchive",
    content: "<p>본문</p>",
  });
  assert.equal(
    await fetchArticleBody(post(1, "arca"), request(article)),
    "<p>본문</p>",
  );
  await assert.rejects(
    fetchArticleBody(post(2, "arca"), request(article)),
    (error) =>
      error instanceof SourceRequestError && error.kind === "missing-body",
  );
  await assert.rejects(
    fetchArticleBody(post(1), request("<title>Just a moment</title>")),
    (error) => error instanceof SourceRequestError && error.kind === "blocked",
  );
  await assert.rejects(
    fetchArticleBody(post(1), request("<p>오류</p>")),
    (error) =>
      error instanceof SourceRequestError &&
      error.kind === "missing-body" &&
      error.status === 200,
  );
  await assert.rejects(
    fetchArticleBody(post(1), request("limit", 429, { "Retry-After": "60" })),
    (error) =>
      error instanceof SourceRequestError && error.retryAfterMs === 60000,
  );
  assert.equal(
    await fetchArticleBody(
      post(1),
      request('<div class="write_div">출처 없는 본문</div>'),
    ),
    "출처 없는 본문",
  );
});

test("404 skips caching and backoff while the next request batch continues", async () => {
  const called: string[] = [];
  const h = harness(async (post) => {
    called.push(post.id);
    if (post.sourceId === "1")
      throw new SourceRequestError("HTTP 404", "http", 404);
    return "https://x.com/artist/status/12345";
  });
  const results = await h.collector.lookup(
    Array.from({ length: 6 }, (_, i) => post(i + 1)),
  );
  assert.equal(called.length, 6);
  assert.equal(called.filter((id) => id === "dc-1").length, 1);
  assert.deepEqual(results["dc-1"], {
    kind: "failed",
    error: "HTTP 404",
    status: 404,
  });
  assert.equal(results["dc-6"].kind, "found");
  assert.equal(h.stored.has("dc-1"), false);
  assert.deepEqual(h.waits, [50]);
});
