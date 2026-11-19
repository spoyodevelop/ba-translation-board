import type { Board } from "../shared/boards.ts";
import type { Post } from "../shared/post";

declare global {
  interface Window {
    // 운영 빌드에서만 index.html에 Google 태그가 들어간다(vite.config.ts).
    gtag?: (...args: unknown[]) => void;
  }
}

// 사이트를 어떻게 쓰는지만 집계한다. 누가 무엇을 읽고 찾았는지 드러나는 값
// (글 ID, 제목, 검색어, 방문 기록, 작가, 팔로우한 작가)은 보내지 않는다.
// 열린 글 주소는 GA 향상된 측정의 외부 클릭(link_url)이 따로 수집한다.
// 파라미터 이름은 GA4 맞춤 측정기준으로 등록하므로, 바꾸면 GA 관리 화면의 등록도 함께 바꾼다.

// 목록이 아는 정보다. 탭은 목록 바깥에서 채운다.
export type OpenedPost = {
  post: Post;
  groupSize: number;
  position: number;
  page: number;
  filtered: boolean;
};

export type OpenPostEvent = OpenedPost & { board: Board };

export function openPostParams(event: OpenPostEvent) {
  return {
    board: event.board,
    post_source: event.post.source,
    group_size: event.groupSize,
    list_position: event.position,
    page: event.page,
    filtered: event.filtered,
  };
}

// 추천컷은 목록에서 고른 값만 보낸다. 직접 입력한 숫자는 "custom"으로 묶는다.
export type SearchEvent = {
  board: Board;
  hasQuery: boolean;
  minRecommend: string;
};

export function searchParams(event: SearchEvent) {
  return {
    board: event.board,
    has_query: event.hasQuery,
    min_recommend: event.minRecommend || "none",
  };
}

// 어느 작가인지는 보내지 않는다. 작가 하나를 봤는지 팔로우한 작가 전부를 봤는지와 보인 묶음 수만 본다.
export type ArtistFilterEvent = {
  board: Board;
  mode: "artist" | "followed";
  groupCount: number;
};

export function artistFilterParams(event: ArtistFilterEvent) {
  return {
    board: event.board,
    filter_mode: event.mode,
    group_count: event.groupCount,
  };
}

// 팔로우한 작가도 보내지 않는다. 팔로우 기능을 쓰는지만 본다.
export type FollowArtistEvent = { board: Board; action: "follow" | "unfollow" };

export function followArtistParams(event: FollowArtistEvent) {
  return { board: event.board, action: event.action };
}

// 태그가 없으면(로컬·Preview·광고 차단) 보내지 않는다. 링크 이동이나 화면 동작은 막지 않는다.
function send(name: string, params: Record<string, string | number | boolean>) {
  window.gtag?.("event", name, params);
}

export function trackOpenPost(event: OpenPostEvent) {
  send("open_post", openPostParams(event));
}

export function trackSearch(event: SearchEvent) {
  send("search", searchParams(event));
}


export function trackArtistFilter(event: ArtistFilterEvent) {
  send("filter_artist", artistFilterParams(event));
}

export function trackFollowArtist(event: FollowArtistEvent) {
  send("follow_artist", followArtistParams(event));
}
