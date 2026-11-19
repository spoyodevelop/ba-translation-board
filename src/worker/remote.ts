import type { ListedPost, Source } from "../shared/post";
import type { BoardConfig } from "../shared/boards.ts";
import { siteAddresses } from "../shared/sites.ts";
import {
  httpError,
  isBlockedPage,
  SourceRequestError,
} from "../sources/requestError.ts";
import { siteAdapters } from "../sources/siteAdapters.ts";

const maxListingPage = 10;
const listingRequestTimeoutMs = 15_000;

export function createRemoteCollector(request: typeof fetch) {
  return {
    async list(
      source: Source,
      page: number,
      board: BoardConfig,
    ): Promise<ListedPost[]> {
      if (!Number.isInteger(page) || page < 1 || page > maxListingPage)
        throw new Error("목록 페이지는 1~10이어야 합니다.");
      const url = siteAddresses[source].listUrl(board, page);
      const response = await request(url, {
        signal: AbortSignal.timeout(listingRequestTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw httpError("목록 요청 실패", response);
      }
      const html = await response.text();
      if (isBlockedPage(html))
        throw new SourceRequestError(
          "목록에서 차단 안내 응답을 받았습니다.",
          "blocked",
          response.status,
        );
      const posts = siteAdapters[source].list.parse(html, board);
      if (page === 1 && posts.length === 0)
        throw new SourceRequestError(
          `${board.label} 목록에서 글을 찾지 못했습니다.`,
          "missing-body",
          response.status,
        );
      return posts;
    }
  };
}
