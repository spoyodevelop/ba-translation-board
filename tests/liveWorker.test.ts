import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openTursoDatabase } from "../src/database/connection.ts";
import { migrateTursoDatabase } from "../src/database/schema.ts";
import { createWorkerRepositories } from "../src/database/repositories.ts";
import { createNodeRequest } from "../src/worker/request.ts";
import { createRemoteCollector } from "../src/worker/remote.ts";
import { createNodeSourceCollector } from "../src/worker/sources.ts";
import { createNodeImageCollector } from "../src/worker/images.ts";
import { createImageDownloader } from "../src/worker/imageDownload.ts";
import { startArcaBrowser } from "../src/worker/arcaBrowser.ts";
import { boardConfigs } from "../src/shared/boards.ts";

const postsToCheck = 3;

// Real site responses vary, so run this separately from the fixed-input test suite.
for (const source of ["arca", "dc"] as const) {
  test(`${source}: live listing, article collection and body image fingerprint`, async (t) => {
    const executablePath = process.env.ARCA_CHROME_EXECUTABLE;
    if (source === "arca" && !executablePath) {
      t.skip("아카 진단에는 ARCA_CHROME_EXECUTABLE이 필요합니다.");
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "board-live-worker-"));
    const client = openTursoDatabase({
      url: pathToFileURL(join(directory, "board.db")).href,
    });
    let arca: Awaited<ReturnType<typeof startArcaBrowser>> | undefined;
    try {
      if (source === "arca")
        arca = await startArcaBrowser({
          executablePath: executablePath!,
          initialBoard: boardConfigs.translation,
          onNewArticles: () => {},
          onExit: () => {},
          log: () => {},
        });
      await migrateTursoDatabase(client);
      const repositories = createWorkerRepositories(client, "translation");
      const nodeRequest = createNodeRequest();
      const request: typeof fetch = (input, init) => {
        const original = new Request(input, init);
        if (arca && new URL(original.url).hostname === "arca.live")
          return arca.request(original);
        return nodeRequest(original);
      };
      const remote = createRemoteCollector(request);
      const sources = createNodeSourceCollector({
        repositories,
        request,
        fetchBody:
          arca &&
          ((post) => arca!.fetchBody(post, AbortSignal.timeout(15_000))),
      });
      const images = createNodeImageCollector({
        repositories,
        download: createImageDownloader(request),
      });
      const posts = (await remote.list(source, 1, boardConfigs.translation)).slice(0, postsToCheck);
      assert.ok(posts.length > 0, "번역 목록에 글이 있어야 합니다.");
      await repositories.posts.upsert(
        posts.map((post) => ({
          ...post,
          viewCount: post.viewCount ?? null,
          recommendCount: post.recommendCount ?? null,
        })),
      );

      // Use worker collectors directly so cooldowns, retries and caches follow the same policy.
      const results = await sources.lookup(posts);
      for (const post of posts) {
        const result = results[post.id];
        assert.ok(result, `${post.id}: 본문 조회 결과가 없습니다.`);
        if (result.kind === "failed") {
          if (result.status === 404) {
            t.diagnostic(`${post.id}: 삭제되거나 비공개인 글은 건너뜁니다.`);
            continue;
          }
          assert.fail(
            `${post.id}: 본문 조회 실패 (${result.status ?? "unknown"}): ${result.error}`,
          );
        }
        t.diagnostic(
          `${post.id}: 출처 ${result.sources.length}개, 본문 이미지 ${Boolean(result.imageUrl)}`,
        );
      }

      const imagePost = posts.find((post) => {
        const result = results[post.id];
        return result.kind !== "failed" && Boolean(result.imageUrl);
      });
      await t.test("body image download and fingerprint", async (imageTest) => {
        if (!imagePost) {
          imageTest.skip(
            `최신 ${postsToCheck}개 글에서 본문 이미지를 찾지 못해 이미지 검증을 생략합니다.`,
          );
          return;
        }
        const result = await images.lookup(
          imagePost,
          results[imagePost.id],
          AbortSignal.timeout(10_000),
        );
        if (result.kind === "failed") {
          assert.fail(
            `${imagePost.id}: 이미지 조회 실패 (${result.status ?? "unknown"}): ${result.error}`,
          );
        }
        assert.equal(result.kind, "found");
        assert.equal(result.fingerprint.regions.length, 9);
        imageTest.diagnostic(
          `${imagePost.id}: ${result.fingerprint.width}×${result.fingerprint.height}`,
        );
      });
    } finally {
      try {
        await arca?.close();
      } finally {
        client.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
}
