import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { openTursoDatabase } from "../src/database/connection.ts";
import { migrateTursoDatabase } from "../src/database/schema.ts";
import { createWorkerRepositories } from "../src/database/repositories.ts";
import type { WorkerRepositories } from "../src/database/repositories.ts";
import {
  createLeasedRepositoryClient,
  holdJobLease,
  LostJobLeaseError,
} from "../src/worker/lease.ts";
import { fingerprintNodeImage } from "../src/worker/fingerprint.ts";
import { createNodeImageCollector } from "../src/worker/images.ts";
import { createImageDownloader } from "../src/worker/imageDownload.ts";
import { createNodeSourceCollector } from "../src/worker/sources.ts";
import {
  createNodeGrouper,
  NODE_GROUPING_VERSION,
} from "../src/worker/grouping.ts";
import { createNodeTitleMatcher } from "../src/worker/titles.ts";
import { createNodeArtistResolver } from "../src/worker/artists.ts";
import {
  createJevTitleEvaluator,
  evaluateTitlePairs,
  makeTitlePair,
  JEV_TITLE_CACHE_TTL_MS,
} from "../src/grouping/evaluateWithJev.ts";
import type { TitleEvaluator } from "../src/grouping/evaluateWithJev.ts";
import { createNodeRequest } from "../src/worker/request.ts";
import { createWorkerRuntime } from "../src/worker/runtime.ts";
import type { WorkerEvent } from "../src/worker/log.ts";
import { noCrashReports } from "../src/worker/crashReports.ts";
import { CREATIVE_GROUPING_VERSION } from "../src/worker/creativeGrouping.ts";
import {
  compareFingerprints,
  isImageMatch,
  NODE_IMAGE_FINGERPRINT_VERSION,
} from "../src/sources/imageHash.ts";
import { sourceCacheVersion } from "../src/sources/sourceCache.ts";
import { SourceRequestError } from "../src/sources/requestError.ts";
import type { StoredPost, AutomaticMatch } from "../src/database/types";
import type { SourceLookupResult } from "../src/sources/types";
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

// 출처 없는 글의 이미지 경로는 Jev가 불일치한 뒤에 검증한다.
const noTitleMatches = { lookup: async () => [] };
const rejectTitlePairs: TitleEvaluator = async (pairs) =>
  pairs.map((pair) => ({
    firstPostId: pair.first.id,
    secondPostId: pair.second.id,
    firstTitle: pair.first.title,
    secondTitle: pair.second.title,
    probability: 0,
    model: "test-jev",
    evaluatedAt: time,
  }));
const time = Date.parse("2026-10-03T00:00:00Z");
const noAliases = async () => ({ aliases: [], rejected: [] });
function post(source: "arca" | "dc", id: number): StoredPost {
  return {
    id: `${source}-${id}`,
    source,
    sourceId: String(id),
    title: "같은 번역",
    author: null,
    authorId: null,
    publishedAt: new Date(time - 60_000).toISOString(),
    url: `https://example.com/${id}`,
    viewCount: 1,
    recommendCount: 2,
    duplicateGroupId: null,
  };
}
async function database(
  run: (
    client: ReturnType<typeof openTursoDatabase>,
    db: WorkerRepositories,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "worker-runtime-"));
  const client = openTursoDatabase({
    url: pathToFileURL(join(directory, "test.db")).href,
  });
  try {
    await migrateTursoDatabase(client);
    await run(client, createWorkerRepositories(client, "translation"));
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function image() {
  const width = 120,
    height = 180;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value =
        ((Math.floor(x / 7) + Math.floor(y / 11)) % 2) * 200 + ((x + y) % 55);
      pixels.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}
function match(firstPostId: string, secondPostId: string): AutomaticMatch {
  return {
    firstPostId,
    secondPostId,
    sourceKeys: ["x:123"],
    imageEvidence: null,
    titleEvidence: null,
    creativeEvidence: null,
    algorithmVersion: NODE_GROUPING_VERSION,
    matchedAt: time,
  };
}

test("Node image decoder handles PNG, WebP and transparency with separate hash versions and limits", async () => {
  const png = await image();
  const first = await fingerprintNodeImage(png);
  const webp = await sharp(png).webp({ lossless: true }).toBuffer();
  const second = await fingerprintNodeImage(webp);
  const evidence = compareFingerprints(
    first,
    second,
    12,
    NODE_IMAGE_FINGERPRINT_VERSION,
  );
  assert.equal(first.width, 120);
  assert.equal(first.height, 180);
  assert.equal(first.regions.length, 9);
  assert.equal(evidence.wholeDistance, 0);
  assert.equal(isImageMatch(evidence), true);
  assert.throws(
    () => compareFingerprints(first, { ...second, version: "other-version" }),
    /Incompatible/,
  );
  const blank = await sharp({
    create: { width: 30, height: 30, channels: 4, background: "#00000000" },
  })
    .png()
    .toBuffer();
  const blankHash = await fingerprintNodeImage(blank);
  assert.equal(
    isImageMatch(
      compareFingerprints(
        blankHash,
        blankHash,
        12,
        NODE_IMAGE_FINGERPRINT_VERSION,
      ),
    ),
    false,
  );
  const large = await sharp({
    create: { width: 4000, height: 3500, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  const largeHash = await fingerprintNodeImage(large);
  assert.equal(largeHash.width, 1024);
  assert.equal(largeHash.height, 896);
  assert.equal(largeHash.version, NODE_IMAGE_FINGERPRINT_VERSION);
  assert.equal(largeHash.regions.length, 9);
});

test("Jev 0.95 on source-less posts skips candidate bodies and images; cached titles survive restart and invalidate on edits or expiry", async () => {
  await database(async (client, db) => {
    let clock = time,
      requests = 0,
      probability = 0.95;
    const target = post("arca", 1),
      same = post("dc", 2),
      other = { ...post("dc", 3), title: "전혀 관련 없는 글" };
    await db.posts.upsert([target, same, other]);
    const signal = new AbortController().signal;
    const request: typeof fetch = async (input, init) => {
      requests++;
      assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-key",
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "jev-latest");
      return Response.json({
        model: "jev-1.13.0",
        answers: Object.fromEntries(
          Object.keys(body.questions).map((key, index) => [
            key,
            { type: "noul", noul: index === 0 ? probability : 0.949 },
          ]),
        ),
      });
    };
    const titles = () =>
      createNodeTitleMatcher({
        repositories: db,
        evaluate: createJevTitleEvaluator("test-key", {
          request,
          now: () => clock,
        }),
        signal,
        now: () => clock,
      });
    let sourceLookups = 0,
      imageLookups = 0;
    const deps = {
      repositories: db,
      titles: titles(),
      signal,
      now: () => clock,
      sources: {
        lookup: async () => {
          sourceLookups++;
          return Object.fromEntries(
            [target, same, other].map((p): [string, SourceLookupResult] => {
              return [p.id, { kind: "none", sources: [] }];
            }),
          );
        },
      },
      images: {
        lookup: async () => {
          imageLookups++;
          return { kind: "none" as const };
        },
      },
    };
    assert.equal(
      (await createNodeGrouper(deps).process(target)).groupedCount,
      1,
    );
    assert.equal(sourceLookups, 1);
    assert.equal(imageLookups, 0);
    assert.equal(requests, 1);
    const saved = (await db.grouping.listMatches())[0];
    assert.equal(saved.titleEvidence?.probability, 0.95);
    assert.equal(saved.titleEvidence?.model, "jev-1.13.0");
    assert.deepEqual(saved.sourceKeys, []);
    assert.equal(saved.imageEvidence, null);
    assert.equal(
      (await db.posts.findUnprocessed(0, NODE_GROUPING_VERSION, 10)).length,
      2,
    );

    // 새 matcher와 뒤집힌 글 순서에서도 긍정·부정 판정을 함께 재사용한다.
    await createNodeGrouper({ ...deps, titles: titles() }).process(same);
    assert.equal(requests, 1);
    const cached = await titles().lookup(target, [same, other]);
    assert.deepEqual(cached.map((d) => d.probability).sort(), [0.949, 0.95]);
    assert.equal(requests, 1);

    probability = 0.949;
    const edited = { ...target, title: "같은 번역 수정" };
    await db.posts.upsert([edited]);
    await createNodeGrouper(deps).process(edited);
    assert.equal(requests, 2);
    assert.equal(sourceLookups, 3);
    assert.equal(imageLookups, 1);
    assert.deepEqual(await db.grouping.listMatches(), []);

    await createNodeGrouper(deps).process(edited);
    assert.equal(requests, 2);
    assert.equal(imageLookups, 2);
    clock += JEV_TITLE_CACHE_TTL_MS;
    await titles().lookup(edited, [same, other]);
    assert.equal(requests, 3);

    const failed = createNodeTitleMatcher({
      repositories: db,
      evaluate: createJevTitleEvaluator("test-key", {
        request: async () => new Response("unavailable", { status: 503 }),
      }),
      signal,
      now: () => clock,
    });
    const changedOther = { ...other, title: "새 제목" };
    await db.posts.upsert([changedOther]);
    await assert.rejects(
      createNodeGrouper({ ...deps, titles: failed }).process(changedOther),
      /HTTP 503/,
    );
    assert.ok(
      (await db.posts.findUnprocessed(0, NODE_GROUPING_VERSION, 10)).some(
        (p) => p.id === other.id,
      ),
    );
    const pair = makeTitlePair(edited, same);
    assert.equal((await db.titles.read([pair], clock)).size, 1);
    // 같은 제목이어도 이전 질문의 확률을 새 정책에서 재사용하지 않는다.
    await client.execute(
      "UPDATE jev_title_decisions SET policy_version = policy_version - 1",
    );
    assert.equal((await db.titles.read([pair], clock)).size, 0);
  });
});

test("Jev rejects incomplete or invalid probabilities and HTTP errors instead of treating them as negative matches", async () => {
  const pairs = [{ first: post("arca", 1), second: post("dc", 2) }];
  const signal = new AbortController().signal;
  for (const noul of [undefined, -0.01, 1.01, "0.99"]) {
    await assert.rejects(
      evaluateTitlePairs(pairs, "test-key", {
        signal,
        request: async () =>
          Response.json({
            model: "jev-test",
            answers: { pair_0: { type: "noul", noul } },
          }),
      }),
      /올바른 확률/,
    );
  }
  await assert.rejects(evaluateTitlePairs(pairs, "", { signal }), /JEV_KEY/);
  // 키가 없으면 평가기를 만들 때 바로 실패한다.
  assert.throws(() => createJevTitleEvaluator(" "), /JEV_KEY/);
  await assert.rejects(
    evaluateTitlePairs(pairs, "test-key", {
      signal,
      request: async () => new Response("invalid key", { status: 401 }),
    }),
    /HTTP 401/,
  );
});

test("Node image caches survive collector recreation; 429 cooldown blocks later network requests", async () => {
  await database(async (_client, db) => {
    const bytes = await image();
    let count = 0;
    const request = createNodeRequest(async () => {
      count++;
      return new Response(bytes, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    });
    const deps = {
      repositories: db,
      download: createImageDownloader(request),
      now: () => time,
    };
    const source: SourceLookupResult = {
      kind: "none",
      sources: [],
      imageUrl: "https://dcimg8.dcinside.co.kr/image",
    };
    assert.equal(
      (
        await createNodeImageCollector(deps).lookup(
          post("dc", 1),
          source,
          AbortSignal.timeout(10_000),
        )
      ).kind,
      "found",
    );
    assert.equal(
      (
        await createNodeImageCollector(deps).lookup(
          post("dc", 1),
          source,
          AbortSignal.timeout(10_000),
        )
      ).kind,
      "found",
    );
    assert.equal(count, 1);
    const limited = createNodeImageCollector({
      ...deps,
      download: createImageDownloader(createNodeRequest(async () => {
        count++;
        return new Response("", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      })),
    });
    const failed = await limited.lookup(
      post("dc", 2),
      source,
      AbortSignal.timeout(10_000),
    );
    assert.equal(failed.kind, "failed");
    assert.equal(await db.state.nextRequestAt("images"), time + 60_000);
    assert.equal(
      (await limited.lookup(post("dc", 3), source, AbortSignal.timeout(10_000)))
        .kind,
      "failed",
    );
    assert.equal(count, 2);
    assert.equal(
      await db.caches.readImage(
        "body:dc-2",
        NODE_IMAGE_FINGERPRINT_VERSION,
        time,
      ),
      null,
    );
  });
});

test("an image that downloads but cannot be read counts as no image instead of a retryable failure", async () => {
  await database(async (_client, db) => {
    // 실제 장애는 디시 이미지 하나가 3px 미만으로 디코딩되어 번역 수집 작업이 14시간 실패했다.
    const tiny = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    let requests = 0;
    const images = createNodeImageCollector({
      repositories: db,
      now: () => time,
      download: createImageDownloader(createNodeRequest(async () => {
        requests++;
        return new Response(tiny, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      })),
    });
    const result = await images.lookup(
      post("dc", 1),
      { kind: "none", sources: [], imageUrl: "https://dcimg8.dcinside.co.kr/x" },
      AbortSignal.timeout(10_000),
    );
    assert.deepEqual(result, { kind: "none" });
    assert.equal(requests, 1);
  });
});

test("different original sources without body images finish grouping without external requests", async () => {
  await database(async (_client, db) => {
    const posts = [post("arca", 1), post("dc", 2)];
    await db.posts.upsert(posts);
    let requests = 0;
    const images = createNodeImageCollector({
      repositories: db,
      now: () => time,
      download: createImageDownloader(async () => {
        requests++;
        throw new Error("Unexpected original image request");
      }),
    });
    const results: Record<string, SourceLookupResult> = {
      "arca-1": {
        kind: "found",
        sources: [{ key: "x:123", url: "https://x.com/a/status/123" }],
      },
      "dc-2": {
        kind: "found",
        sources: [
          { key: "pixiv:456", url: "https://www.pixiv.net/artworks/456" },
        ],
      },
    };
    const signal = new AbortController().signal;
    for (const entry of posts) {
      assert.deepEqual(await images.lookup(entry, results[entry.id], signal), {
        kind: "none",
      });
    }
    const grouper = createNodeGrouper({
      titles: noTitleMatches,
      repositories: db,
      images,
      signal,
      now: () => time,
      sources: { lookup: async () => results },
    });
    assert.deepEqual(await grouper.process(posts[0]), {
      comparedCount: 0,
      groupedCount: 0,
    });
    assert.equal(requests, 0);
    assert.deepEqual(
      (await db.posts.findUnprocessed(0, NODE_GROUPING_VERSION, 10)).map(
        (p) => p.id,
      ),
      ["dc-2"],
    );
    assert.deepEqual(await db.grouping.listMatches(), []);
  });
});

test("cached source matches bypass title candidates within 48 hours and skip images", async () => {
  await database(async (client, db) => {
    const target = post("arca", 1);
    const publishedAt = Date.parse(target.publishedAt);
    const windowMs = 48 * 60 * 60_000;
    const titleCandidates = Array.from({ length: 10 }, (_, i) =>
      post("dc", i + 2),
    );
    const hidden = [
      {
        ...post("dc", 100),
        title: "zzzz",
        publishedAt: new Date(publishedAt - windowMs).toISOString(),
      },
      {
        ...post("dc", 101),
        title: "yyyy",
        publishedAt: new Date(publishedAt + windowMs).toISOString(),
      },
    ];
    const excluded = [
      {
        ...post("dc", 102),
        title: "xxxx",
        publishedAt: new Date(publishedAt - windowMs - 1).toISOString(),
      },
      {
        ...post("dc", 103),
        title: "wwww",
        publishedAt: new Date(publishedAt + windowMs + 1).toISOString(),
      },
      { ...post("dc", 104), title: "vvvv" },
      { ...post("dc", 105), title: "uuuu" },
      { ...post("dc", 106), title: "tttt" },
      { ...post("arca", 107), title: "ssss" },
    ];
    const originalSources = [
      { key: "x:123" as const, url: "https://x.com/a/status/123" },
      { key: "pixiv:456" as const, url: "https://www.pixiv.net/artworks/456" },
    ];
    await db.posts.upsert([target, ...titleCandidates, ...hidden, ...excluded]);
    for (const p of [...hidden, ...excluded]) {
      await db.caches.saveSources({
        postId: p.id,
        version: sourceCacheVersion,
        checkedAt: time - 1000,
        expiresAt: time + 60_000,
        imageUrl: null,
        sources: originalSources,
      });
    }
    await client.execute({
      sql: "UPDATE source_cache SET expires_at = ? WHERE post_id = ?",
      args: [time, "dc-104"],
    });
    await client.execute({
      sql: "UPDATE source_cache SET version = ? WHERE post_id = ?",
      args: [sourceCacheVersion - 1, "dc-105"],
    });
    await client.execute({
      sql: "UPDATE source_cache SET checked_at = ? WHERE post_id = ?",
      args: [time + 1, "dc-106"],
    });
    let imageLookups = 0;
    const grouper = createNodeGrouper({
      repositories: db,
      signal: new AbortController().signal,
      now: () => time,
      titles: {
        lookup: async () => {
          throw new Error("출처가 있으면 Jev를 호출하면 안 됩니다.");
        },
      },
      sources: {
        lookup: async (posts) => {
          assert.deepEqual(
            posts.map((p) => p.id),
            [target.id],
          );
          assert.equal(
            posts.some((p) => hidden.some((h) => h.id === p.id)),
            false,
          );
          return Object.fromEntries(
            posts.map((p): [string, SourceLookupResult] => {
              if (p.id === target.id)
                return [
                  p.id,
                  {
                    kind: "found",
                    sources: originalSources,
                    imageUrl: "https://example.com/image.png",
                  },
                ];
              return [
                p.id,
                {
                  kind: "none",
                  sources: [],
                  imageUrl: "https://example.com/image.png",
                },
              ];
            }),
          );
        },
      },
      images: {
        lookup: async () => {
          imageLookups++;
          return { kind: "none" as const };
        },
      },
    });
    assert.deepEqual(await grouper.process(target), {
      comparedCount: 2,
      groupedCount: 2,
    });
    assert.equal(imageLookups, 0);
    const matches = await db.grouping.listMatches();
    assert.deepEqual(
      matches.map((m) => m.secondPostId),
      ["dc-100", "dc-101"],
    );
    for (const match of matches) {
      assert.deepEqual([...match.sourceKeys].sort(), ["pixiv:456", "x:123"]);
      assert.equal(match.imageEvidence, null);
      assert.equal(match.titleEvidence, null);
    }
  });
});

test("image fallback keeps the 0.10 boundary, skips weaker candidates and clears excluded matches", async () => {
  await database(async (_client, db) => {
    const target = { ...post("arca", 1), title: "abcdefghijk" };
    const boundary = { ...post("dc", 2), title: "abmnopqrstx" };
    const below = { ...post("dc", 3), title: "abmnopqrstxy" };
    await db.posts.upsert([target, boundary, below]);
    const fingerprint = await fingerprintNodeImage(await image());
    const imageLookups: string[] = [];
    const bodyLookups: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const grouper = createNodeGrouper({
      titles: noTitleMatches,
      repositories: db,
      now: () => time,
      signal: new AbortController().signal,
      sources: {
        lookup: async (posts) => {
          bodyLookups.push(...posts.map((p) => p.id));
          return Object.fromEntries(
            posts.map((p) => [
              p.id,
              {
                kind: "none" as const,
                sources: [],
                imageUrl: "https://example.com/image.png",
              },
            ]),
          );
        },
      },
      images: {
        lookup: async (p) => {
          imageLookups.push(p.id);
          return { kind: "found" as const, fingerprint };
        },
      },
      log: (event) => {
        events.push(event);
      },
    });
    assert.deepEqual(await grouper.process(target), {
      comparedCount: 2,
      groupedCount: 1,
    });
    assert.deepEqual(imageLookups, [target.id, boundary.id]);
    assert.deepEqual(bodyLookups, [target.id, boundary.id]);
    assert.equal(events[0].imageCandidateCount, 1);
    assert.equal(events[0].imageSkippedCandidateCount, 1);
    imageLookups.length = 0;
    bodyLookups.length = 0;
    const edited = { ...target, title: "zzzzzzzzzzz" };
    await db.posts.upsert([edited]);
    assert.deepEqual(await grouper.process(edited), {
      comparedCount: 2,
      groupedCount: 0,
    });
    assert.deepEqual(imageLookups, []);
    assert.deepEqual(bodyLookups, [target.id]);
    assert.deepEqual(await db.grouping.listMatches(), []);
    assert.equal(events[1].stage, "jev");
    assert.equal(events[1].imageCandidateCount, 0);
    assert.equal(events[1].imageSkippedCandidateCount, 2);
  });
});

test("expired Arca image URLs preserve four-day source and hash caches; only missing hashes refresh the body", async () => {
  await database(async (client, db) => {
    const target = post("arca", 1);
    await db.posts.upsert([target]);
    const fourDays = 4 * 24 * 60 * 60_000;
    const expiredUrl = `https://ac.arca.live/image?expires=${Math.floor(time / 1000) - 1}`;
    await db.caches.saveSources({
      postId: target.id,
      version: sourceCacheVersion,
      checkedAt: time,
      expiresAt: time + fourDays,
      imageUrl: expiredUrl,
      sources: [{ key: "x:123", url: "https://x.com/a/status/123" }],
    });
    const bytes = await image();
    const fingerprint = await fingerprintNodeImage(bytes);
    await db.caches.saveImage({
      key: `body:${target.id}`,
      version: fingerprint.version,
      checkedAt: time,
      expiresAt: time + fourDays,
      width: fingerprint.width,
      height: fingerprint.height,
      wholeHash: fingerprint.whole,
      regions: fingerprint.regions,
    });
    let clock = time + 3 * 24 * 60 * 60_000;
    let bodyRequests = 0;
    let imageRequests = 0;
    const sources = createNodeSourceCollector({
      repositories: db,
      now: () => clock,
      sleep: async () => {},
      request: createNodeRequest(async () => {
        bodyRequests++;
        return Response.json({
          id: 1,
          boardSlug: "bluearchive",
          content:
            '<a href="https://x.com/a/status/123">출처</a><img src="https://ac.arca.live/new.png">',
        });
      }),
    });
    const images = createNodeImageCollector({
      repositories: db,
      now: () => clock,
      refreshSource: async (p) =>
        (await sources.lookup([p], { refresh: true }))[p.id],
      download: createImageDownloader(createNodeRequest(async (input) => {
        imageRequests++;
        assert.equal(new Request(input).url, "https://ac.arca.live/new.png");
        return new Response(bytes, {
          headers: { "Content-Type": "image/png" },
        });
      })),
    });
    const result = (await sources.lookup([target]))[target.id];
    assert.equal(result.kind, "found");
    assert.deepEqual(
      result.sources.map((s) => s.key),
      ["x:123"],
    );
    assert.equal(bodyRequests, 0);
    assert.equal(
      (await db.caches.readSources(target.id, sourceCacheVersion, clock))
        ?.expiresAt,
      time + fourDays,
    );
    const signal = new AbortController().signal;
    assert.equal((await images.lookup(target, result, signal)).kind, "found");
    assert.equal(bodyRequests, 0);
    assert.equal(imageRequests, 0);
    await client.execute({
      sql: "DELETE FROM image_cache WHERE cache_key = ?",
      args: [`body:${target.id}`],
    });
    assert.equal((await images.lookup(target, result, signal)).kind, "found");
    assert.equal(bodyRequests, 1);
    assert.equal(imageRequests, 1);
    assert.equal(
      (await db.caches.readSources(target.id, sourceCacheVersion, clock))
        ?.imageUrl,
      "https://ac.arca.live/new.png",
    );
    assert.equal((await images.lookup(target, result, signal)).kind, "found");
    assert.equal(bodyRequests, 1);
    assert.equal(imageRequests, 1);
    // 실제 갱신 이후에도 4일 전에는 재조회하지 않고, 만료 시점에만 다시 읽는다.
    clock += fourDays - 1;
    await sources.lookup([target]);
    assert.equal(bodyRequests, 1);
    clock++;
    await sources.lookup([target]);
    assert.equal(bodyRequests, 2);
  });
});

test("any source match skips all images even with unmatched candidates; rechecking removes stale edges and preserves unrelated matches", async () => {
  await database(async (_client, db) => {
    const posts = [
      post("arca", 1),
      post("dc", 2),
      post("arca", 3),
      post("dc", 4),
      post("dc", 5),
      post("dc", 6),
    ];
    await db.posts.upsert(posts);
    const sources: Record<string, SourceLookupResult> = Object.fromEntries(
      posts.map((p) => [
        p.id,
        {
          kind: "found",
          sources: [{ key: "x:123", url: "https://x.com/a/status/123" }],
        },
      ]),
    );
    sources["dc-5"] = {
      kind: "none",
      sources: [],
      imageUrl: "https://dcimg8.dcinside.co.kr/no-source.png",
    };
    sources["dc-6"] = {
      kind: "found",
      sources: [{ key: "x:456", url: "https://x.com/a/status/456" }],
      imageUrl: "https://dcimg8.dcinside.co.kr/other-source.png",
    };
    for (const p of posts.slice(1)) {
      const result = sources[p.id];
      if (result.kind === "failed") continue;
      await db.caches.saveSources({
        postId: p.id,
        version: sourceCacheVersion,
        checkedAt: time,
        expiresAt: time + 60_000,
        imageUrl: result.imageUrl ?? null,
        sources: result.sources,
      });
    }
    let imageRequests = 0;
    // 판정은 대상 글의 연결만 읽어야 한다. 연결 전체를 읽으면 글마다 연결 수만큼 읽기 비용이 든다.
    const grouping = {
      ...db.grouping,
      listMatches: async () => {
        throw new Error("판정 중에 연결 전체를 읽었습니다.");
      },
    };
    const grouper = createNodeGrouper({
      titles: noTitleMatches,
      repositories: { ...db, grouping },
      now: () => time,
      signal: new AbortController().signal,
      sources: { lookup: async () => sources },
      images: {
        lookup: async () => {
          imageRequests++;
          return { kind: "none" };
        },
      },
    });
    assert.equal((await grouper.process(posts[0])).groupedCount, 2);
    assert.equal(imageRequests, 0);
    assert.deepEqual(
      (await db.grouping.listMatches()).map((edge) => [
        edge.firstPostId,
        edge.secondPostId,
      ]),
      [
        ["arca-1", "dc-2"],
        ["arca-1", "dc-4"],
      ],
    );
    await db.grouping.commit({
      comparisons: [
        {
          firstPostId: "arca-3",
          secondPostId: "dc-4",
          match: match("arca-3", "dc-4"),
        },
      ],
      processed: [],
    });
    sources["arca-1"] = { kind: "none", sources: [] };
    await grouper.process(posts[0]);
    assert.deepEqual(
      (await db.grouping.listMatches()).map((edge) => [
        edge.firstPostId,
        edge.secondPostId,
      ]),
      [["arca-3", "dc-4"]],
    );
  });
});

test("image matches persist; transient failures preserve evidence while deleted articles remove it", async () => {
  await database(async (client, db) => {
    const posts = [post("arca", 1), post("dc", 2)];
    await db.posts.upsert(posts);
    const bytes = await image();
    const sources = {
      lookup: async () =>
        Object.fromEntries(
          posts.map((p) => [
            p.id,
            {
              kind: "none" as const,
              sources: [] as [],
              imageUrl: `https://ac.arca.live/${p.id}.png`,
            },
          ]),
        ),
    };
    let imageRequests = 0;
    const images = createNodeImageCollector({
      repositories: db,
      now: () => time,
      download: createImageDownloader(createNodeRequest(async () => {
        imageRequests++;
        return new Response(bytes);
      })),
    });
    const deps = {
      titles: noTitleMatches,
      repositories: db,
      sources,
      images,
      now: () => time,
      signal: new AbortController().signal,
    };
    assert.equal(
      (await createNodeGrouper(deps).process(posts[0])).groupedCount,
      1,
    );
    const saved = (await db.grouping.listMatches())[0];
    assert.deepEqual(saved.sourceKeys, []);
    assert.equal(saved.imageEvidence?.wholeDistance, 0);
    assert.equal(imageRequests, 2);
    await client.execute("DELETE FROM grouping_processed");
    const failing = createNodeGrouper({
      ...deps,
      sources: {
        lookup: async () => ({
          "arca-1": { kind: "failed", status: 503, error: "unavailable" },
          "dc-2": { kind: "none", sources: [] },
        }),
      },
    });
    await assert.rejects(failing.process(posts[0]), /본문 조회 실패/);
    assert.equal(
      (await db.posts.findUnprocessed(0, NODE_GROUPING_VERSION, 10)).length,
      2,
    );
    assert.equal((await db.grouping.listMatches()).length, 1);
    await createNodeGrouper(deps).process(posts[0]);
    assert.equal(imageRequests, 2);
    await client.execute("DELETE FROM grouping_processed");
    const deleted = createNodeGrouper({
      ...deps,
      sources: {
        lookup: async () => ({
          "arca-1": { kind: "failed", status: 404, error: "deleted" },
          "dc-2": { kind: "none", sources: [] },
        }),
      },
    });
    await deleted.process(posts[0]);
    assert.deepEqual(await db.grouping.listMatches(), []);
    assert.deepEqual(
      (await db.posts.findUnprocessed(0, NODE_GROUPING_VERSION, 10)).map(
        (post) => post.id,
      ),
      ["dc-2"],
    );
  });
});

test("expired job owners cannot write domain data; concurrent writes serialize under the active lease", async () => {
  await database(async (client, db) => {
    let clock = time;
    await db.jobs.enqueue({ type: "collect", board: "translation", source: "all" }, clock);
    const first = (await db.jobs.claim("first", clock, 1000))!;
    const firstClient = createLeasedRepositoryClient(
      client,
      { jobId: first.id, token: first.leaseToken! },
      () => clock,
    );
    const scoped = createWorkerRepositories(firstClient, "translation");
    await Promise.all([
      scoped.posts.upsert([post("arca", 1)]),
      scoped.posts.upsert([post("dc", 2)]),
    ]);
    clock += 1001;
    const second = (await db.jobs.claim("second", clock, 1000))!;
    assert.notEqual(first.leaseToken, second.leaseToken);
    await assert.rejects(
      scoped.posts.upsert([post("arca", 3)]),
      LostJobLeaseError,
    );
    assert.equal(await db.posts.get("arca-3"), null);
    const live = createWorkerRepositories(
      createLeasedRepositoryClient(
        client,
        { jobId: second.id, token: second.leaseToken! },
        () => clock,
      ),
      "translation",
    );
    await live.posts.upsert([post("arca", 3)]);
    assert.notEqual(await db.posts.get("arca-3"), null);
    await assert.rejects(
      live.posts.upsert([post("arca", 4), { ...post("dc", 5), viewCount: -1 }]),
      /CHECK constraint/,
    );
    assert.equal(await db.posts.get("arca-4"), null);
    let checks = 0;
    const expiring = createWorkerRepositories(
      createLeasedRepositoryClient(
        client,
        { jobId: second.id, token: second.leaseToken! },
        () => {
          checks++;
          if (checks > 1) return clock + 1001;
          return clock;
        },
      ),
      "translation",
    );
    await assert.rejects(
      expiring.posts.upsert([post("arca", 6)]),
      LostJobLeaseError,
    );
    assert.equal(await db.posts.get("arca-6"), null);
  });
});

test("scheduling prunes finished jobs at most once a day", async () => {
  await database(async (client, db) => {
    let clock = time;
    const events: WorkerEvent[] = [];
    const runtime = createWorkerRuntime({
      boards: ["translation"],
      loadCreativeAliases: noAliases,
      evaluateTitles: rejectTitlePairs,
      client,
      now: () => clock,
      log: (event) => events.push(event),
      execute: async () => ({ collectedCount: 0, comparedCount: 0, groupedCount: 0 }),
    });
    const prunes = () => events.filter((event) => event.event === "jobs-pruned");
    async function runAll() {
      while (await runtime.runOne(new AbortController().signal)) {}
    }
    const finishedCount = async () =>
      (await db.jobs.list()).filter((job) => job.state === "completed").length;

    await runtime.schedule();
    await runAll();
    assert.ok((await finishedCount()) > 0);
    clock += 8 * 24 * 60 * 60_000;
    await runtime.schedule();
    assert.equal(prunes().length, 1);
    assert.equal(await finishedCount(), 0);

    // 새로 끝난 작업을 오래된 것으로 만들어도 하루가 지나기 전에는 다시 지우지 않는다.
    await runAll();
    await client.execute("UPDATE worker_jobs SET finished_at = 0 WHERE state = 'completed'");
    clock += 24 * 60 * 60_000 - 1;
    await runtime.schedule();
    assert.equal(prunes().length, 1);
    clock += 1;
    await runtime.schedule();
    assert.equal(prunes().length, 2);
    assert.equal(await finishedCount(), 0);
  });
});

test("runtime recovers interrupted jobs, preserves completed writes across retries and schedules only one active job", async () => {
  await database(async (client, db) => {
    let clock = time,
      attempts = 0;
    const runtime = createWorkerRuntime({
      boards: ["translation"],
      loadCreativeAliases: noAliases,
      evaluateTitles: rejectTitlePairs,
      client,
      now: () => clock,
      log: () => {},
      execute: async (_job, scoped) => {
        attempts++;
        await scoped.posts.upsert([post("arca", attempts)]);
        if (attempts === 1) throw new Error("temporary failure");
        return { collectedCount: 1, comparedCount: 0, groupedCount: 0 };
      },
    });
    const arcaState = await translationState(db, "arca");
    await db.state.saveCollection({ ...arcaState, lastAttemptAt: clock });
    await runtime.schedule();
    await runtime.schedule();
    assert.equal((await db.jobs.list()).length, 1);
    const interrupted = (await db.jobs.claim("crashed", clock, 1000))!;
    assert.equal(await runtime.runOne(new AbortController().signal), false);
    clock += 1001;
    assert.equal(await runtime.runOne(new AbortController().signal), true);
    assert.equal((await db.jobs.get(interrupted.id))?.state, "queued");
    assert.notEqual(await db.posts.get("arca-1"), null);
    assert.equal(await runtime.runOne(new AbortController().signal), false);
    clock += 60_000;
    assert.equal(await runtime.runOne(new AbortController().signal), true);
    assert.equal((await db.jobs.get(interrupted.id))?.state, "completed");
    assert.equal((await db.jobs.get(interrupted.id))?.attempts, 3);
    assert.notEqual(await db.posts.get("arca-2"), null);

    for (const state of await db.state.list())
      await db.state.saveCollection({ ...state, lastAttemptAt: clock });
    clock += 10 * 60_000 - 1;
    await runtime.schedule();
    assert.equal((await db.jobs.list()).length, 1);
    clock += 1;
    await runtime.schedule();
    await runtime.schedule();
    const queued = (await db.jobs.list()).filter(
      (job) => job.state === "queued",
    );
    assert.equal((await db.jobs.list()).length, 3);
    assert.deepEqual(
      queued
        .map((job) => job.request)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      [
        { type: "collect", board: "translation", source: "arca" },
        { type: "collect", board: "translation", source: "dc" },
      ],
    );
  });
});

test("collection processes at most twenty recent unprocessed posts; backfill honors its limit without a date cutoff", async () => {
  await database(async (client, db) => {
    const recent = Array.from({ length: 22 }, (_, index) => ({
      ...post("arca", index + 1),
      publishedAt: new Date(time - (22 - index) * 60_000).toISOString(),
    }));
    const old = {
      ...post("arca", 30),
      publishedAt: new Date(time - 49 * 60 * 60_000).toISOString(),
    };
    const expired = { ...post("arca", 31), publishedAt: "2026-06-30T00:00:00Z" };
    await db.posts.upsert([...recent, old, expired]);
    await db.grouping.commit({
      comparisons: [],
      processed: [
        {
          postId: "arca-22",
          algorithmVersion: NODE_GROUPING_VERSION,
          processedAt: time,
        },
      ],
    });
    const state = await translationState(db, "arca");
    await db.state.saveCollection({ ...state, historyBackfilled: true });
    let requests = 0;
    const runtime = createWorkerRuntime({
      boards: ["translation"],
      loadCreativeAliases: noAliases,
      evaluateTitles: rejectTitlePairs,
      client,
      now: () => time,
      log: () => {},
      request: async (input) => {
        const url = new URL((input as Request).url);
        assert.equal(url.hostname, "arca.live");
        if (url.pathname !== "/b/bluearchive") {
          return Response.json({
            id: Number(url.pathname.split("/").pop()),
            boardSlug: "bluearchive",
            content: "본문",
          });
        }
        requests++;
        return new Response(
          `<div class="list-table"><a class="vrow column" href="/b/bluearchive/1"><span class="title">같은 번역</span><time datetime="${recent[0].publishedAt}"></time></a></div>`,
        );
      },
    });
    await db.jobs.enqueue({ type: "collect", board: "translation", source: "arca" }, time);
    await runtime.runOne(new AbortController().signal);
    assert.equal((await db.jobs.list())[0].state, "completed");
    assert.equal(await db.posts.get(expired.id), null);
    assert.deepEqual(
      (await db.posts.findUnprocessed(0, NODE_GROUPING_VERSION, 100)).map(
        (post) => post.id,
      ),
      ["arca-1", "arca-30"],
    );
    await db.jobs.enqueue({ type: "backfill", board: "translation", limit: 1 }, time);
    await runtime.runOne(new AbortController().signal);
    assert.deepEqual(
      (await db.posts.findUnprocessed(0, NODE_GROUPING_VERSION, 100)).map(
        (post) => post.id,
      ),
      ["arca-30"],
    );
    await db.jobs.enqueue({ type: "backfill", board: "translation", limit: 1 }, time);
    await runtime.runOne(new AbortController().signal);
    assert.deepEqual(
      await db.posts.findUnprocessed(0, NODE_GROUPING_VERSION, 100),
      [],
    );
    assert.equal(
      (await db.jobs.list()).every((job) => job.state === "completed"),
      true,
    );
    assert.equal(requests, 1);
  });
});

test("runtime renews its lease and shutdown preserves committed posts while leaving the job available for retry", async (context) => {
  await database(async (client, db) => {
    let clock = time;
    let renewLease!: () => void;
    const startInterval = globalThis.setInterval;
    context.mock.method(
      globalThis,
      "setInterval",
      (callback: () => void, intervalMs: number) => {
        assert.equal(intervalMs, 10_000);
        renewLease = callback;
        return startInterval(callback, intervalMs);
      },
    );
    const shutdown = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runtime = createWorkerRuntime({
      boards: ["translation"],
      loadCreativeAliases: noAliases,
      evaluateTitles: rejectTitlePairs,
      client,
      now: () => clock,
      log: () => {},
      execute: async (_job, scoped, signal) => {
        await scoped.posts.upsert([post("arca", 1)]);
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        throw new Error("종료 신호 이후 작업을 계속하면 안 됩니다.");
      },
    });
    const job = await db.jobs.enqueue({ type: "collect", board: "translation", source: "all" }, time);
    const running = runtime.runOne(shutdown.signal);
    const rejected = assert.rejects(running, { name: "AbortError" });
    await started;
    try {
      clock += 10_000;
      renewLease();
      let renewed = await db.jobs.get(job.id);
      for (
        let attempt = 0;
        attempt < 20 && renewed?.leaseUntil !== clock + 60_000;
        attempt++
      )
        renewed = await db.jobs.get(job.id);
      assert.equal(renewed?.leaseUntil, clock + 60_000);
      // 최초 임대가 만료된 뒤에도 갱신한 소유권으로 종료 상태를 저장할 수 있어야 한다.
      clock += 55_000;
    } finally {
      shutdown.abort();
      await rejected;
    }
    assert.ok(await db.posts.get("arca-1"));
    const saved = await db.jobs.get(job.id);
    assert.equal(saved?.state, "queued");
    assert.equal(saved?.leaseToken, null);
    assert.equal(saved?.availableAt, clock + 30_000);
  });
});

test("runtime schedules only enabled boards and Arca events reach every enabled board", async () => {
  await database(async (client, db) => {
    const options = {
      loadCreativeAliases: noAliases,
      evaluateTitles: rejectTitlePairs,
      client,
      now: () => time,
      log: () => {},
    };
    await createWorkerRuntime({ ...options, boards: ["translation"] }).schedule();
    const boards = async () =>
      (await db.jobs.list()).map((job) => job.request.board).sort();
    assert.deepEqual(await boards(), ["translation", "translation"]);
    const both = createWorkerRuntime({
      ...options,
      boards: ["translation", "creative"],
      loadCreativeAliases: noAliases,
    });
    await both.schedule();
    assert.deepEqual(await boards(), [
      "creative",
      "creative",
      "translation",
      "translation",
    ]);
    assert.throws(() => createWorkerRuntime({ ...options, boards: [] }));
  });
});

test("creative collection saves and judges creative posts without Jev and pings the creative checks", async () => {
  await database(async (client, db) => {
    const pings: string[] = [];
    const listUrls: URL[] = [];
    const runtime = createWorkerRuntime({
      boards: ["translation", "creative"],
      loadCreativeAliases: noAliases,
      evaluateTitles: async () => {
        throw new Error("Jev must not run for creative posts");
      },
      client,
      now: () => time,
      log: () => {},
      reportCollectionSuccess: async (board, source) => {
        pings.push(`${board}/${source}`);
      },
      request: async (input) => {
        const url = new URL((input as Request).url);
        listUrls.push(url);
        if (url.hostname === "arca.live")
          return new Response(`<div class="list-table"><a class="vrow column" href="/b/bluearchive/7"><span class="title">유우카 그림</span><time datetime="${new Date(time - 60_000).toISOString()}"></time></a></div>`);
        return new Response(`<table><tr class="us-post" data-no="8"><td class="gall_subject">🎨창작</td>
        <td class="gall_tit"><a href="/mgallery/board/view/?id=projectmx&no=8">유우카 그림</a></td>
        <td class="gall_writer" data-nick="작가" data-uid="uid8"></td><td class="gall_date" title="2026-10-03 08:59:00"></td></tr></table>`);
      },
    });
    await db.jobs.enqueue(
      { type: "collect", board: "creative", source: "all" },
      time,
    );
    assert.equal(await runtime.runOne(new AbortController().signal), true);
    assert.equal((await db.jobs.list())[0].state, "completed");
    const firstList = (host: string) =>
      listUrls.find((url) => url.hostname === host)!;
    assert.equal(firstList("arca.live").searchParams.get("category"), "창작");
    assert.equal(
      firstList("gall.dcinside.com").searchParams.get("search_head"),
      "40",
    );
    const creative = createWorkerRepositories(client, "creative");
    assert.deepEqual(
      (await creative.posts.listRecent(0)).map((p) => [p.id, p.authorId]).sort(),
      [
        ["arca-7", null],
        ["dc-8", "uid8"],
      ],
    );
    assert.equal((await db.posts.listRecent(0)).length, 0);
    assert.deepEqual(pings, ["creative/arca", "creative/dc"]);
    // 같은 제목이 같은 시각에 올라와 Jev 없이 목록 정보만으로 묶인다.
    const [match] = await creative.grouping.listMatches();
    assert.deepEqual([match.firstPostId, match.secondPostId], ["arca-7", "dc-8"]);
    assert.equal(match.algorithmVersion, CREATIVE_GROUPING_VERSION);
    assert.equal(
      (await creative.posts.findUnprocessed(0, CREATIVE_GROUPING_VERSION, 10))
        .length,
      0,
    );
    const creativeArca = (await db.state.list()).find(
      (entry) => entry.source === "arca" && entry.board === "creative",
    );
    assert.equal(creativeArca?.historyBackfilled, true);
    assert.equal((await translationState(db, "arca")).historyBackfilled, false);
  });
});

test("runtime collects metadata, caches sources and stores automatic edges without image requests", async () => {
  await database(async (client, db) => {
    const known = [post("arca", 1), post("dc", 2)];
    await db.posts.upsert(known);
    for (const entry of await db.state.list())
      await db.state.saveCollection({ ...entry, historyBackfilled: true });
    let imageRequests = 0;
    const runtime = createWorkerRuntime({
      boards: ["translation"],
      loadCreativeAliases: noAliases,
      evaluateTitles: rejectTitlePairs,
      client,
      now: () => time,
      log: () => {},
      request: async (input) => {
        const url = new URL((input as Request).url);
        if (url.hostname === "arca.live" && url.pathname === "/b/bluearchive")
          return new Response(`<div class="list-table">
        ${[3, 1].map((id) => `<a class="vrow column" href="/b/bluearchive/${id}"><span class="title">같은 번역</span><time datetime="${new Date(time - 60_000).toISOString()}"></time></a>`).join("")}</div>`);
        if (
          url.hostname === "gall.dcinside.com" &&
          url.pathname.includes("list")
        )
          return new Response(`<table><tr class="us-post" data-no="2"><td class="gall_subject">번역</td>
        <td class="gall_tit"><a href="/mgallery/board/view/?id=projectmx&no=2">같은 번역</a></td><td class="gall_date" title="2026-10-03 08:59:00"></td></tr></table>`);
        if (url.hostname === "arca.live")
          return Response.json({
            id: Number(url.pathname.split("/").pop()),
            boardSlug: "bluearchive",
            content: '<a href="https://www.pixiv.net/artworks/123">출처</a>',
          });
        if (url.hostname === "gall.dcinside.com")
          return new Response(
            '<div class="write_div"><a href="https://www.pixiv.net/artworks/123">출처</a></div>',
          );
        if (url.href === "https://www.pixiv.net/ajax/illust/123")
          return Response.json({ body: { userId: "7", userName: "작가" } });
        if (url.href === "https://www.pixiv.net/ajax/user/7?full=1")
          return Response.json({ body: { social: { twitter: { url: "https://twitter.com/artist" } } } });
        imageRequests++;
        throw new Error("Unexpected image request");
      },
    });
    await db.jobs.enqueue({ type: "collect", board: "translation", source: "all" }, time);
    assert.equal(await runtime.runOne(new AbortController().signal), true);
    const job = (await db.jobs.list())[0];
    assert.equal(job.state, "completed");
    assert.equal(job.result?.collectedCount, 3);
    assert.equal(imageRequests, 0);
    assert.equal((await db.posts.listRecent(0)).length, 3);
    assert.equal((await db.grouping.listMatches()).length, 2);
    assert.equal(
      (await db.posts.findUnprocessed(0, NODE_GROUPING_VERSION, 10)).length,
      0,
    );
    assert.equal(
      (await db.state.list()).every((entry) => entry.state === "idle"),
      true,
    );
    assert.notEqual(
      await db.caches.readSources("arca-3", sourceCacheVersion, time),
      null,
    );
    assert.deepEqual(
      (await client.execute("SELECT platform, original_id, status, artist_id FROM artwork_artists")).rows.map((row) => ({ ...row })),
      [{ platform: "pixiv", original_id: "123", status: "found", artist_id: "7" }],
    );
    assert.deepEqual(await db.artists.readPixivProfile("7"), { xHandle: "artist" });
  });
});

test("artist resolver reads X handles without requests, caches pixiv profiles and stops at the first pixiv failure", async () => {
  await database(async (client, db) => {
    const target = post("dc", 1);
    await db.posts.upsert([target]);
    await db.caches.saveSources({
      postId: target.id,
      version: sourceCacheVersion,
      checkedAt: time,
      expiresAt: time + 1,
      imageUrl: null,
      sources: [
        { key: "x:1", url: "https://x.com/Artist_A/status/1" },
        { key: "x:2", url: "https://x.com/i/status/2" },
        { key: "pixiv:10", url: "https://www.pixiv.net/artworks/10" },
        { key: "pixiv:11", url: "https://www.pixiv.net/artworks/11" },
        { key: "pixiv:12", url: "https://www.pixiv.net/artworks/12" },
        { key: "pixiv:13", url: "https://www.pixiv.net/artworks/13" },
      ],
    });
    const requests: string[] = [];
    let sleeps = 0;
    let blocked = true;
    const resolver = createNodeArtistResolver({
      repositories: db,
      now: () => time,
      sleep: async () => {
        sleeps++;
      },
      request: async (input, init) => {
        const url = String(input);
        requests.push(url.replace("https://www.pixiv.net/ajax/", "").replace("https://x.com/", "x:"));
        // 지워진 트윗이다.
        if (url === "https://x.com/i/status/2") return new Response(null, { status: 404 });
        assert.equal(new Headers(init?.headers).get("Referer"), "https://www.pixiv.net/");
        if (url.endsWith("/illust/12")) return new Response("{}", { status: 404 });
        if (url.endsWith("/illust/13") && blocked) return new Response("", { status: 429 });
        if (url.includes("/illust/"))
          return Response.json({ body: { userId: "7", userName: "작가" } });
        return Response.json({ body: { social: { twitter: { url: "https://twitter.com/Artist_A" } } } });
      },
    });
    const signal = new AbortController().signal;
    assert.deepEqual(await resolver.resolve(signal), {
      xFound: 1,
      xMissing: 1,
      pixivFound: 2,
      pixivMissing: 1,
      xError: null,
      pixivError: "픽시브 응답 429",
    });
    // 같은 작가의 두 번째 작품은 저장된 프로필을 쓴다.
    assert.deepEqual(requests, ["x:i/status/2", "illust/10", "user/7?full=1", "illust/11", "illust/12", "illust/13"]);
    assert.equal(sleeps, requests.length - 1);
    assert.deepEqual(
      (await client.execute("SELECT platform, original_id, status, artist_id, artist_name, attempts FROM artwork_artists ORDER BY platform, original_id")).rows.map((row) => ({ ...row })),
      [
        { platform: "pixiv", original_id: "10", status: "found", artist_id: "7", artist_name: "작가", attempts: 0 },
        { platform: "pixiv", original_id: "11", status: "found", artist_id: "7", artist_name: "작가", attempts: 0 },
        { platform: "pixiv", original_id: "12", status: "missing", artist_id: null, artist_name: null, attempts: 0 },
        { platform: "pixiv", original_id: "13", status: "failed", artist_id: null, artist_name: null, attempts: 1 },
        { platform: "x", original_id: "1", status: "found", artist_id: "artist_a", artist_name: "Artist_A", attempts: 0 },
        { platform: "x", original_id: "2", status: "missing", artist_id: null, artist_name: null, attempts: 0 },
      ],
    );
    assert.deepEqual(await db.artists.readPixivProfile("7"), { xHandle: "Artist_A" });

    // 다음 작업은 실패한 작품만 다시 조회한다.
    blocked = false;
    requests.length = 0;
    sleeps = 0;
    const retry = await resolver.resolve(signal);
    assert.equal(retry.pixivFound, 1);
    assert.equal(retry.pixivError, null);
    assert.deepEqual(requests, ["illust/13"]);
    assert.equal(sleeps, 0);
    assert.deepEqual(await db.artists.listPending("pixiv", 10), []);
  });
});

test("X links without a handle resolve through the x.com redirect, within a per-run limit, stopping X lookups at the first failure", async () => {
  await database(async (client, db) => {
    const target = post("dc", 1);
    await db.posts.upsert([target]);
    const iLinks = Array.from({ length: 33 }, (_, index) => `${100 + index}`);
    await db.caches.saveSources({
      postId: target.id,
      version: sourceCacheVersion,
      checkedAt: time,
      expiresAt: time + 1,
      imageUrl: null,
      sources: [
        ...iLinks.map((id) => ({ key: `x:${id}` as const, url: `https://x.com/i/status/${id}` })),
        { key: "x:999", url: "https://x.com/Named/status/999" },
      ],
    });
    const requests: string[] = [];
    let badRedirect = true;
    let blocked = false;
    const resolver = createNodeArtistResolver({
      repositories: db,
      now: () => time,
      sleep: async () => {},
      request: async (input, init) => {
        const url = String(input);
        const id = url.split("/").pop()!;
        requests.push(id);
        assert.equal(init?.method, "HEAD");
        assert.equal(init?.redirect, "manual");
        if (blocked) return new Response(null, { status: 429 });
        // 다른 트윗으로 보내는 리다이렉트는 받지 않는다.
        if (id === "101" && badRedirect)
          return new Response(null, { status: 307, headers: { Location: "https://x.com/Other/status/1" } });
        return new Response(null, {
          status: 307,
          headers: { Location: `https://x.com/Artist_${id}/status/${id}` },
        });
      },
    });
    const signal = new AbortController().signal;
    const rows = async () =>
      Object.fromEntries(
        (await client.execute("SELECT original_id, status, artist_id, attempts FROM artwork_artists WHERE platform = 'x'")).rows.map(
          (row) => [String(row.original_id), `${row.status}:${row.artist_id}:${row.attempts}`],
        ),
      );

    // 101은 계정명을 알 수 없는 리다이렉트라 실패로 세고 이번 X 조회를 멈춘다.
    // 요청을 멈춘 뒤에도 URL에 계정명이 있는 작품은 처리한다.
    const first = await resolver.resolve(signal);
    assert.deepEqual(requests, ["100", "101"]);
    assert.equal(first.xFound, 2);
    assert.equal(first.xError, "X 리다이렉트에 계정명이 없습니다.");
    assert.equal((await rows())["100"], "found:artist_100:0");
    assert.equal((await rows())["101"], "failed:null:1");
    assert.equal((await rows())["999"], "found:named:0");

    // 다음 작업은 실패한 작품부터 다시 묻고, 한 번에 30개까지만 요청한다.
    badRedirect = false;
    requests.length = 0;
    const second = await resolver.resolve(signal);
    assert.equal(requests.length, 30);
    assert.equal(requests[0], "101");
    assert.equal(second.xFound, 30);
    assert.equal(second.xError, null);
    assert.equal((await rows())["101"].startsWith("found:artist_101"), true);

    // 차단(429)도 실패로 세고 멈춘다.
    blocked = true;
    requests.length = 0;
    const third = await resolver.resolve(signal);
    assert.deepEqual(requests, ["131"]);
    assert.equal(third.xError, "X 응답 429");
    assert.deepEqual(
      (await db.artists.listPending("x", 10)).map((artwork) => artwork.originalId),
      ["131", "132"],
    );
  });
});

test("Arca events coalesce, survive a running job and respect cooldown", async () => {
  await database(async (client, db) => {
    let clock = time;
    const runtime = createWorkerRuntime({
      boards: ["translation"],
      loadCreativeAliases: noAliases,
      evaluateTitles: rejectTitlePairs,
      client,
      now: () => clock,
      log: () => {},
    });
    const arcaState = await translationState(db, "arca");
    await db.state.saveCollection({ ...arcaState, lastAttemptAt: clock });
    await runtime.schedule();
    assert.deepEqual(
      (await db.jobs.list()).map((job) => job.request),
      [{ type: "collect", board: "translation", source: "dc" }],
    );
    const dc = await translationState(db, "dc");
    await db.state.saveCollection({ ...dc, lastAttemptAt: clock });
    runtime.requestArcaCollection();
    runtime.requestArcaCollection();
    clock += 1499;
    await runtime.schedule();
    assert.equal((await db.jobs.list()).length, 1);
    clock++;
    await db.state.deferRequests("arca-list", clock + 5000);
    await runtime.schedule();
    assert.equal((await db.jobs.list()).length, 1);
    clock += 5000;
    await runtime.schedule();
    const arca = (await db.jobs.list()).find(
      (job) => job.request.type === "collect" && job.request.source === "arca",
    )!;
    assert.ok(arca);
    const dcJob = (await db.jobs.claim("test", clock, 60_000))!;
    await db.jobs.complete(
      { jobId: dcJob.id, token: dcJob.leaseToken! },
      { collectedCount: 0, comparedCount: 0, groupedCount: 0 },
      clock,
    );
    const running = (await db.jobs.claim("test", clock, 60_000))!;
    assert.equal(running.id, arca.id);
    runtime.requestArcaCollection();
    clock += 1500;
    await runtime.schedule();
    assert.equal((await db.jobs.list()).length, 2);
    await db.jobs.complete(
      { jobId: running.id, token: running.leaseToken! },
      { collectedCount: 0, comparedCount: 0, groupedCount: 0 },
      clock,
    );
    await runtime.schedule();
    assert.equal((await db.jobs.list()).length, 3);
    await runtime.schedule();
    assert.equal((await db.jobs.list()).length, 3);
  });
});

test("failed list collection does not send a healthcheck success ping", async () => {
  await database(async (client, db) => {
    const pings: string[] = [];
    const runtime = createWorkerRuntime({
      boards: ["translation"],
      evaluateTitles: rejectTitlePairs,
      loadCreativeAliases: noAliases,
      client,
      now: () => time,
      log: () => {},
      request: async () => new Response("Forbidden", { status: 403 }),
      reportCollectionSuccess: async (board, source) => {
        pings.push(`${board}/${source}`);
      },
    });
    const job = await db.jobs.enqueue(
      { type: "collect", board: "translation", source: "arca" },
      time,
    );
    await runtime.runOne(new AbortController().signal);
    assert.deepEqual(pings, []);
    assert.equal((await db.jobs.get(job.id))?.state, "queued");
    const state = await translationState(db, "arca");
    assert.equal(state.lastSuccessAt, null);
  });
});

test("browser transport handles Arca lists and bodies; grouping retries reuse successful collection", async () => {
  await database(async (client, db) => {
    const pings: string[] = [];
    const events: string[] = [];
    let clock = time,
      lists = 0,
      bodies = 0,
      failing = true;
    await db.posts.upsert([post("arca", 1), post("dc", 2)]);
    await db.caches.saveSources({
      postId: "dc-2",
      version: sourceCacheVersion,
      checkedAt: time,
      expiresAt: time + 4 * 24 * 60 * 60_000,
      imageUrl: null,
      sources: [{ key: "x:123", url: "https://x.com/a/status/123" }],
    });
    const state = await translationState(db, "arca");
    await db.state.saveCollection({ ...state, historyBackfilled: true });
    const runtime = createWorkerRuntime({
      boards: ["translation"],
      loadCreativeAliases: noAliases,
      evaluateTitles: rejectTitlePairs,
      client,
      now: () => clock,
      log: (entry) => events.push(entry.event),
      reportCollectionSuccess: async (board, source) => {
        const saved = await translationState(db, source);
        assert.equal(saved.lastSuccessAt, clock);
        pings.push(`${board}/${source}`);
        throw new Error("Healthchecks unavailable");
      },
      arca: {
        request: async (input) => {
          lists++;
          assert.equal(
            new URL((input as Request).url).pathname,
            "/b/bluearchive",
          );
          return new Response(
            `<div class="list-table"><a class="vrow column" href="/b/bluearchive/1"><span class="title">같은 번역</span><time datetime="${post("arca", 1).publishedAt}"></time></a></div>`,
          );
        },
        fetchBody: async () => {
          bodies++;
          if (failing)
            throw new SourceRequestError(
              "temporary body failure",
              "http",
              503,
              60_000,
            );
          return '<a href="https://x.com/a/status/123">출처</a>';
        },
      },
      request: async (input) => {
        assert.equal(
          new URL((input as Request).url).hostname,
          "gall.dcinside.com",
        );
        return new Response(
          '<div class="write_div"><a href="https://x.com/a/status/123">출처</a></div>',
        );
      },
    });
    const job = await db.jobs.enqueue(
      { type: "collect", board: "translation", source: "arca" },
      clock,
    );
    await runtime.runOne(new AbortController().signal);
    assert.equal((await db.jobs.get(job.id))?.state, "queued");
    assert.equal(lists, 1);
    const dc = await translationState(db, "dc");
    await db.state.saveCollection({ ...dc, lastAttemptAt: clock });
    runtime.requestArcaCollection();
    clock += 1500;
    await runtime.schedule();
    assert.equal((await db.jobs.list()).length, 1);
    failing = false;
    clock += 60_000;
    await runtime.runOne(new AbortController().signal);
    assert.equal((await db.jobs.get(job.id))?.state, "completed");
    assert.equal((await db.jobs.get(job.id))?.result?.collectedCount, 1);
    assert.equal(lists, 1);
    assert.ok(bodies > 1);
    assert.deepEqual(pings, ["translation/arca"]);
    assert.equal(
      events.filter((event) => event === "healthcheck-ping-error").length,
      1,
    );
    assert.equal(events.includes("collection-error"), false);
    assert.equal((await db.grouping.listMatches()).length, 1);
    await runtime.schedule();
    assert.equal((await db.jobs.list()).length, 2);
  });
});

test("new source IDs stop before Jev and images, then a later opposite post links through the dictionary", async () => {
  await database(async (_client, db) => {
    const target = post("arca", 1),
      later = post("dc", 2);
    await db.posts.upsert([target]);
    const bodies: string[] = [];
    const sources = createNodeSourceCollector({
      repositories: db,
      now: () => time,
      sleep: async () => {},
      request: async () => {
        throw new Error("Unexpected request");
      },
      fetchBody: async (p) => {
        bodies.push(p.id);
        return '<a href="https://x.com/a/status/123">출처</a><img src="https://example.com/image.png">';
      },
    });
    const grouper = createNodeGrouper({
      repositories: db,
      sources,
      now: () => time,
      signal: new AbortController().signal,
      titles: {
        lookup: async () => {
          throw new Error("Unexpected Jev evaluation");
        },
      },
      images: {
        lookup: async () => {
          throw new Error("Unexpected image lookup");
        },
      },
    });
    assert.deepEqual(await grouper.process(target), {
      comparedCount: 0,
      groupedCount: 0,
    });
    assert.deepEqual(bodies, [target.id]);
    assert.ok(await db.caches.readSources(target.id, sourceCacheVersion, time));
    await db.posts.upsert([later]);
    assert.equal((await grouper.process(later)).groupedCount, 1);
    assert.deepEqual(bodies, [target.id, later.id]);
    const saved = (await db.grouping.listMatches())[0];
    assert.deepEqual(saved.sourceKeys, ["x:123"]);
    assert.equal(saved.titleEvidence, null);
    assert.equal(saved.imageEvidence, null);
    await db.caches.saveSources({
      postId: later.id,
      version: sourceCacheVersion,
      checkedAt: time,
      expiresAt: time + 60_000,
      imageUrl: null,
      sources: [{ key: "x:456", url: "https://x.com/a/status/456" }],
    });
    assert.equal((await grouper.process(later)).groupedCount, 0);
    assert.deepEqual(await db.grouping.listMatches(), []);
    assert.deepEqual(bodies, [target.id, later.id]);
  });
});

test("runtime reports a job to crash reports only after its last attempt fails", async () => {
  await database(async (client, db) => {
    let clock = time;
    const reported: string[] = [];
    const runtime = createWorkerRuntime({
      boards: ["translation"],
      loadCreativeAliases: noAliases,
      evaluateTitles: rejectTitlePairs,
      client,
      now: () => clock,
      log: () => {},
      crashReports: {
        ...noCrashReports,
        jobFailed: (request, message) =>
          reported.push(`${request.type}:${request.board}: ${message}`),
      },
      execute: async () => {
        throw new Error("permanent failure");
      },
    });
    await db.jobs.enqueue({ type: "backfill", board: "translation", limit: 1 }, clock);
    const shutdown = new AbortController().signal;
    assert.equal(await runtime.runOne(shutdown), true);
    clock += 30_000;
    assert.equal(await runtime.runOne(shutdown), true);
    assert.deepEqual(reported, []);
    clock += 60_000;
    assert.equal(await runtime.runOne(shutdown), true);
    assert.deepEqual(reported, ["backfill:translation: permanent failure"]);
  });
});

test("job lease hold gives up only when renewal is refused or the last renewed lease has expired", async (context) => {
  let tick!: () => void;
  const startInterval = globalThis.setInterval;
  context.mock.method(globalThis, "setInterval", (callback: () => void) => {
    tick = callback;
    return startInterval(() => {}, 1_000_000);
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const lease = { jobId: "job-1", token: "token" };
  const errors: unknown[] = [];
  let clock = 0;
  let renewal: () => Promise<boolean> = async () => true;
  const hold = () =>
    holdJobLease({
      lease,
      leaseUntil: 60_000,
      leaseMs: 60_000,
      renewalIntervalMs: 10_000,
      renew: () => renewal(),
      now: () => clock,
      onRenewalError: (error) => errors.push(error),
    });

  // 연장이 거절되면 바로 중단한다.
  renewal = async () => false;
  const refused = hold();
  tick();
  await refused.release();
  assert.ok(refused.signal.reason instanceof LostJobLeaseError);

  // 연장에 성공하면 그 시각부터 만료를 다시 센다. 연장 오류는 그 만료 전까지 버틴다.
  renewal = async () => true;
  const held = hold();
  clock = 10_000;
  tick();
  await settle();
  renewal = async () => {
    throw new Error("DB 연결 끊김");
  };
  clock = 65_000;
  tick();
  await settle();
  assert.equal(held.signal.aborted, false);
  assert.equal(errors.length, 1);
  clock = 70_000;
  tick();
  await held.release();
  assert.ok(held.signal.reason instanceof LostJobLeaseError);
  assert.equal(errors.length, 2);
});
