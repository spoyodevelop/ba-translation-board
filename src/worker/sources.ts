import type { WorkerRepositories } from "../database/repositories.ts";
import { createSourceCollector } from "../sources/collector.ts";
import { fetchArticleBody } from "../sources/fetchBody.ts";
import {
  sourceCacheVersion,
  sourceCacheTtlMs,
} from "../sources/sourceCache.ts";
import type { SourceLookupResult } from "../sources/types";
import type { Post } from "../shared/post.ts";

export function createNodeSourceCollector(deps: {
  repositories: WorkerRepositories;
  request: typeof fetch;
  fetchBody?: (post: Post) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const now = deps.now || Date.now;
  const { caches, state } = deps.repositories;
  return createSourceCollector({
    cache: {
      async read(postId) {
        const entry = await caches.readSources(
          postId,
          sourceCacheVersion,
          now(),
        );
        if (!entry) return undefined;
        let result: Exclude<SourceLookupResult, { kind: "failed" }>;
        if (entry.sources.length === 0) result = { kind: "none", sources: [] };
        else result = { kind: "found", sources: entry.sources };
        if (entry.imageUrl) result.imageUrl = entry.imageUrl;
        return result;
      },
      async save(postId, result) {
        if (result.kind === "failed") return;
        const checkedAt = now();
        await caches.saveSources({
          postId,
          version: sourceCacheVersion,
          checkedAt,
          expiresAt: checkedAt + sourceCacheTtlMs,
          imageUrl: result.imageUrl ?? null,
          sources: result.sources,
        });
      },
    },
    fetchBody:
      deps.fetchBody || ((post) => fetchArticleBody(post, deps.request)),
    readNextRequestAt: () => state.nextRequestAt("sources"),
    saveNextRequestAt: (time) => state.deferRequests("sources", time),
    now,
    sleep: deps.sleep,
  });
}
