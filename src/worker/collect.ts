import type { Source } from "../shared/post";
import type { BoardConfig } from "../shared/boards.ts";
import type { WorkerRepositories } from "../database/repositories.ts";
import type { createRemoteCollector } from "./remote.ts";
import { SourceRequestError } from "../sources/requestError.ts";
import { siteAdapters } from "../sources/siteAdapters.ts";

const maxCollectionPages = 10;
const forbiddenListCooldownMs = 20 * 60_000;

type Dependencies = {
  repositories: WorkerRepositories;
  remote: Pick<ReturnType<typeof createRemoteCollector>, "list">;
  board: BoardConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function createNodePostCollector(deps: Dependencies) {
  const now = deps.now || Date.now;
  const sleep =
    deps.sleep ||
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function collect(source: Source): Promise<number> {
    const { posts, state } = deps.repositories;
    const previous = (await state.list()).find(
      (entry) => entry.source === source && entry.board === deps.board.board,
    );
    if (!previous)
      throw new Error("DB 수집 상태가 없습니다. 먼저 스키마를 초기화하세요.");
    const site = siteAdapters[source].list;
    const scope = site.cooldownScope;
    const nextRequestAt = await state.nextRequestAt(scope);
    if (nextRequestAt > now())
      throw new SourceRequestError(
        "목록 요청 대기 중입니다.",
        "cooldown",
        null,
        nextRequestAt - now(),
      );
    const current = {
      ...previous,
      state: "running" as const,
      lastAttemptAt: now(),
      error: null,
    };
    await state.saveCollection(current);
    try {
      const known = new Set(
        (await posts.listRecent(0, source)).map((post) => post.id),
      );
      const needsHistory = !previous.historyBackfilled || known.size === 0;
      const collected = new Map<
        string,
        Awaited<ReturnType<typeof deps.remote.list>>[number]
      >();
      for (let page = 1; page <= maxCollectionPages; page++) {
        // 첫 페이지가 비면 목록 형식이 바뀐 것이므로 remote가 오류로 올린다. 여기서는 뒷 페이지의 끝만 다룬다.
        const pagePosts = await deps.remote.list(source, page, deps.board);
        if (pagePosts.length === 0) break;
        for (const post of pagePosts) collected.set(post.id, post);
        if (!needsHistory && pagePosts.some((post) => known.has(post.id)))
          break;
        if (page < maxCollectionPages) await sleep(site.pagePauseMs);
      }
      await posts.upsert(
        [...collected.values()].map((post) => ({
          ...post,
          viewCount: post.viewCount ?? null,
          recommendCount: post.recommendCount ?? null,
        })),
        now(),
      );
      await state.saveCollection({
        ...current,
        state: "idle",
        historyBackfilled: true,
        lastSuccessAt: now(),
        lastCount: collected.size,
      });
      return collected.size;
    } catch (error) {
      if (error instanceof SourceRequestError && error.status === 403) {
        await state.deferRequests(scope, now() + forbiddenListCooldownMs);
      }
      if (error instanceof SourceRequestError && error.status === 429) {
        await state.deferRequests(scope, now() + error.retryAfterMs);
      }
      await state.saveCollection({
        ...current,
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // 작업과 출처별 수집 순서는 runtime이 직렬로 실행한다.
  return { collect };
}
