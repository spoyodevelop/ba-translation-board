import type { Post } from "../shared/post.ts";
import type { Board } from "../shared/boards.ts";
import type { StoredPost } from "../database/types";
import type { WorkerRepositories } from "../database/repositories.ts";
import type { AliasStore } from "../grouping/creativeAuthors.ts";
import { LostJobLeaseError } from "./lease.ts";
import { createNodeSourceCollector } from "./sources.ts";
import { createNodeImageCollector } from "./images.ts";
import { createImageDownloader } from "./imageDownload.ts";
import { createNodeTitleMatcher } from "./titles.ts";
import type { TitleEvaluator } from "../grouping/evaluateWithJev.ts";
import { createNodeArtistResolver } from "./artists.ts";
import { createNodeGrouper, NODE_GROUPING_VERSION } from "./grouping.ts";
import {
  createCreativeGrouper,
  CREATIVE_GROUPING_VERSION,
} from "./creativeGrouping.ts";
import { describeError } from "./describeError.ts";
import type { WorkerLog } from "./log.ts";

// 한 작업 안에서 board와 상관없이 같은 협력자다. 요청은 작업 중단 신호와 아카 우회가 이미 적용되어 있다.
export type BoardJobContext = {
  repositories: WorkerRepositories;
  request: typeof fetch;
  fetchBody: (post: Post) => Promise<string>;
  signal: AbortSignal;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  // 작업 ID가 붙은 로그다.
  log: WorkerLog;
};

export type BoardGrouper = {
  process(
    target: StoredPost,
  ): Promise<{ comparedCount: number; groupedCount: number }>;
};

// board마다 달라지는 판정 방식과 후처리를 한곳에 둔다. runtime은 board 이름으로 분기하지 않는다.
export type BoardPipeline = {
  // 이 버전으로 판정하지 않은 글을 다시 판정한다.
  groupingVersion: string;
  createGrouper(context: BoardJobContext): Promise<BoardGrouper>;
  // 판정을 마친 뒤 실행한다. 실패를 작업 실패로 올릴지는 단계마다 정한다.
  afterGrouping?(context: BoardJobContext): Promise<void>;
};

export function createBoardPipelines(deps: {
  evaluateTitles: TitleEvaluator;
  // 창작 작가 별칭이다. 사람이 운영 서버의 파일을 고치면 다음 작업부터 반영되도록 작업마다 읽는다.
  loadCreativeAliases: () => Promise<AliasStore>;
}): Record<Board, BoardPipeline> {
  return {
    translation: {
      groupingVersion: NODE_GROUPING_VERSION,
      async createGrouper(context) {
        const sources = createNodeSourceCollector({
          repositories: context.repositories,
          request: context.request,
          fetchBody: context.fetchBody,
          now: context.now,
          sleep: context.sleep,
        });
        const images = createNodeImageCollector({
          repositories: context.repositories,
          download: createImageDownloader(context.request),
          refreshSource: async (post) =>
            (await sources.lookup([post], { refresh: true }))[post.id],
          now: context.now,
        });
        const titles = createNodeTitleMatcher({
          repositories: context.repositories,
          evaluate: deps.evaluateTitles,
          signal: context.signal,
          now: context.now,
          log: context.log,
        });
        return createNodeGrouper({
          repositories: context.repositories,
          sources,
          images,
          titles,
          log: context.log,
          signal: context.signal,
          now: context.now,
        });
      },
      // 원작 작가 모아보기 PoC의 작가 조회다. 실패해도 수집·판정 작업을 다시 돌리지 않고 다음 작업에서 이어 간다.
      async afterGrouping(context) {
        try {
          const artists = await createNodeArtistResolver({
            repositories: context.repositories,
            request: context.request,
            now: context.now,
            sleep: context.sleep,
          }).resolve(context.signal);
          context.log({ event: "artists-resolved", ...artists });
        } catch (error) {
          context.signal.throwIfAborted();
          if (error instanceof LostJobLeaseError) throw error;
          context.log({ event: "artists-error", error: describeError(error) });
        }
      },
    },
    creative: {
      groupingVersion: CREATIVE_GROUPING_VERSION,
      async createGrouper(context) {
        return createCreativeGrouper({
          repositories: context.repositories,
          aliases: await deps.loadCreativeAliases(),
          now: context.now,
        });
      },
    },
  };
}
