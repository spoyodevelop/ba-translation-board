import type { RepositoryClient } from "./repositoryClient.ts";
import type { Board } from "../shared/boards.ts";
import { createTitleDecisionRepository } from "./titleDecisions.ts";
import { createPostRepository } from "./posts.ts";
import { createGroupingRepository } from "./grouping.ts";
import { createCacheRepository } from "./caches.ts";
import { createArtistRepository } from "./artists.ts";
import { createJobRepository } from "./jobs.ts";
import { createWorkerStateRepository } from "./state.ts";

export type WorkerRepositories = ReturnType<typeof createWorkerRepositories>;

// 글·연결·출처 검색은 한 board 안에서만 다룬다. 작업·수집 상태·로그는 board와 무관하게 공유한다.
export function createWorkerRepositories(client: RepositoryClient, board: Board) {
  return {
    posts: createPostRepository(client, board),
    titles: createTitleDecisionRepository(client),
    grouping: createGroupingRepository(client, board),
    caches: createCacheRepository(client, board),
    artists: createArtistRepository(client, board),
    jobs: createJobRepository(client),
    state: createWorkerStateRepository(client),
  };
}
