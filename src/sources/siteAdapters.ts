// 사이트마다 다른 수집 방식을 한곳에 둔다. 목록·본문 수집과 재시도 정책은 사이트 이름으로 분기하지 않고 이 값을 쓴다.
// 주소는 shared/sites.ts가 만든다.
import { parse } from "node-html-parser";
import type { ListedPost, Post, Source } from "../shared/post.ts";
import type { BoardConfig } from "../shared/boards.ts";
import { arcaAppArticleUrl, isArcaChannelSlug, siteAddresses } from "../shared/sites.ts";
import type { RequestScope } from "../database/types";
import { parseArcaPosts } from "../arca/parseArcaPosts.ts";
import { parseDcListing } from "../dc/listing.ts";
import { isBlockedPage, SourceRequestError } from "./requestError.ts";

export type SiteAdapter = {
  list: {
    // 차단·429 뒤의 대기 시각을 사이트마다 따로 기록한다.
    cooldownScope: RequestScope;
    pagePauseMs: number;
    parse(html: string, board: BoardConfig): ListedPost[];
  };
  body: {
    batchSize: number;
    batchPauseMs: number;
    maxAttempts: number;
    requestUrl(sourceId: string): string;
    // 응답 본문에서 글 본문 HTML을 꺼낸다. 형식이 맞지 않으면 SourceRequestError를 던진다.
    read(text: string, post: Post, status: number): string;
    // 실패한 본문 요청을 다시 보내기 전에 쉬는 시간이다. 404·429·Retry-After는 failurePolicy가 따로 다룬다.
    retryPauseMs(attempt: number): number;
  };
};

const defaultRetryPauseMs = 10_000;
const dcInitialRetryPauseMs = 1000;
const dcMaxRetryBackoffExponent = 2;

export const siteAdapters: Record<Source, SiteAdapter> = {
  arca: {
    list: {
      cooldownScope: "arca-list",
      pagePauseMs: 1000,
      // 아카 목록에서는 작가 아이디를 읽지 않는다.
      parse: (html) =>
        parseArcaPosts(html).map((post) => ({ ...post, authorId: null })),
    },
    body: {
      // 아카는 한 번에 한 글씩 보내고, 성공한 요청 사이의 쉬는 시간만 줄인다.
      batchSize: 1,
      batchPauseMs: 200,
      maxAttempts: 2,
      requestUrl: arcaAppArticleUrl,
      read(text, post, status) {
        let article;
        try {
          article = JSON.parse(text);
        } catch {
          throw new SourceRequestError(
            "아카 본문 응답이 JSON이 아닙니다.",
            "invalid-response",
            status,
          );
        }
        const correctArticle =
          article &&
          String(article.id) === post.sourceId &&
          isArcaChannelSlug(article.boardSlug);
        if (!correctArticle || typeof article.content !== "string") {
          throw new SourceRequestError(
            "아카 응답에 요청한 글의 본문이 없습니다.",
            "missing-body",
            status,
          );
        }
        return article.content;
      },
      retryPauseMs: () => defaultRetryPauseMs,
    },
  },
  dc: {
    list: {
      cooldownScope: "dc-list",
      pagePauseMs: 500,
      parse: parseDcListing,
    },
    body: {
      batchSize: 5,
      batchPauseMs: 50,
      maxAttempts: 4,
      requestUrl: (sourceId) => siteAddresses.dc.postUrl(sourceId),
      read(text, _post, status) {
        if (isBlockedPage(text))
          throw new SourceRequestError(
            "차단 안내 응답을 받았습니다.",
            "blocked",
            status,
          );
        const body = parse(text).querySelector(".write_div");
        if (!body)
          throw new SourceRequestError(
            "디시 응답에 글 본문이 없습니다.",
            "missing-body",
            status,
          );
        return body.innerHTML;
      },
      // 디시는 짧게 시작해 두 배씩 늘리고, 4초에서 멈춘다.
      retryPauseMs: (attempt) =>
        dcInitialRetryPauseMs *
        2 ** Math.min(attempt - 1, dcMaxRetryBackoffExponent),
    },
  },
};
