// 수집하는 두 사이트의 주소를 한곳에서 만든다. worker의 요청·파서와 웹의 원본 링크가 같은 주소를 쓴다.
// 사이트마다 다른 수집 동작(파서·요청 간격·재시도)은 worker 쪽 sources/sites.ts가 맡는다.
import type { Source } from "./post.ts";
import { boardConfigs } from "./boards.ts";
import type { BoardConfig } from "./boards.ts";

export type SiteAddresses = {
  // 본문의 상대 주소를 풀 때 기준이 되는 주소다.
  origin: string;
  // page를 주지 않으면 사람이 여는 첫 페이지 주소다.
  listUrl(board: BoardConfig, page?: number): URL;
  postUrl(sourceId: string): string;
};

export const arcaChannelUrl = new URL("https://arca.live/b/bluearchive");
const arcaChannelSlug = "bluearchive";
const dcGalleryId = "projectmx";

export const siteAddresses: Record<Source, SiteAddresses> = {
  arca: {
    origin: "https://arca.live/",
    listUrl(board, page) {
      const url = new URL(arcaChannelUrl);
      url.searchParams.set("category", board.arcaCategory);
      if (page !== undefined) url.searchParams.set("p", String(page));
      return url;
    },
    postUrl(sourceId) {
      return `https://arca.live/b/${arcaChannelSlug}/${sourceId}`;
    },
  },
  dc: {
    origin: "https://gall.dcinside.com/",
    listUrl(board, page = 1) {
      const url = new URL("https://gall.dcinside.com/mgallery/board/lists/");
      url.search = new URLSearchParams({
        id: dcGalleryId,
        sort_type: "N",
        search_head: board.dcSearchHead,
        page: String(page),
      }).toString();
      return url;
    },
    postUrl(sourceId) {
      return `https://gall.dcinside.com/mgallery/board/view/?id=${dcGalleryId}&no=${sourceId}`;
    },
  },
};

// 사이트를 도는 순서다. 아카를 먼저 처리한다.
export const sources = Object.keys(siteAddresses) as Source[];

export function isSource(value: string): value is Source {
  return Object.hasOwn(siteAddresses, value);
}

// 아카 앱 API의 글 주소다. 브라우저 없이 본문을 읽을 때 쓴다.
export function arcaAppArticleUrl(sourceId: string): string {
  return `https://arca.live/api/app/view/article/breaking/${sourceId}`;
}

export function arcaPostIdFromPath(pathname: string): string | null {
  const match = new RegExp(`^/b/${arcaChannelSlug}/(\\d+)$`).exec(pathname);
  return match?.[1] ?? null;
}

export function isArcaBoardList(url: URL): boolean {
  if (url.pathname !== arcaChannelUrl.pathname) return false;
  const category = url.searchParams.get("category");
  return Object.values(boardConfigs).some(
    (config) => config.arcaCategory === category,
  );
}

export function isArcaAppArticle(url: URL): boolean {
  return /^\/api\/app\/view\/article\/breaking\/\d+$/.test(url.pathname);
}

const articleImageHosts: Record<Source, RegExp> = {
  arca: /^(ac|ac-o)\.arca\.live$/,
  dc: /^dcimg\d*\.dcinside\.co\.kr$/,
};

// 글 본문 이미지를 두는 서버의 사이트다. 프로필 사진·외부 이미지 주소는 null이다.
export function articleImageSite(url: URL): Source | null {
  return (
    sources.find((source) => articleImageHosts[source].test(url.hostname)) ??
    null
  );
}

// 이미지 서버는 글 주소에서 온 요청만 받는다. 본문 이미지를 받을 때 보낼 Referer다.
export function imageReferer(url: URL): string | null {
  const site = articleImageSite(url);
  if (site === null) return null;
  return siteAddresses[site].origin;
}

// 아카 이미지 주소는 서명과 만료 시각(expires, 초)을 담는다. 서명이 없는 주소는 만료되지 않는다.
export function imageUrlExpiresAt(url: URL): number | null {
  if (articleImageSite(url) !== "arca") return null;
  const expires = url.searchParams.get("expires");
  if (expires === null) return null;
  return Number(expires) * 1000;
}

// 아카 앱 API 응답이 이 채널의 글인지 확인할 때 쓴다.
export function isArcaChannelSlug(slug: unknown): boolean {
  return slug === arcaChannelSlug;
}
