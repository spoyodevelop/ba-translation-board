// 한 사이트 안의 게시판 카테고리(번역 등)별로 달라지는 수집 대상과 안내를 한곳에 둔다.
// 사이트 주소는 이 값을 받아 shared/sites.ts에서 만든다.

export type Board = "translation" | "creative";

// board를 나누기 전부터 있던 board다. 그때 만든 작업 키·조회 API 주소·웹 주소(/)는 board 이름 없이
// 이 board를 가리킨다. 대기 중인 작업, CDN 캐시, 공유된 링크가 그대로 동작하도록 바꾸지 않는다.
export const legacyBoard: Board = "translation";

export type BoardConfig = {
  board: Board;
  label: string;
  eyebrow: string;
  arcaCategory: string;
  dcSearchHead: string;
  // 디시 목록은 말머리 ID로 거른 뒤에도 행의 말머리 이름을 다시 확인한다.
  dcHeadLabel: string;
  // 원작 작가 보기·팔로우를 보여 줄지다. 작가는 번역 글에 실린 원작 출처에서만 찾는다.
  showsOriginalArtists: boolean;
};

export const boardConfigs: Record<Board, BoardConfig> = {
  translation: {
    board: "translation",
    label: "번역",
    eyebrow: "BLUE ARCHIVE TRANSLATIONS",
    arcaCategory: "번역",
    dcSearchHead: "120",
    dcHeadLabel: "번역",
    showsOriginalArtists: true,
  },
  creative: {
    board: "creative",
    label: "창작",
    eyebrow: "BLUE ARCHIVE CREATIONS",
    arcaCategory: "창작",
    dcSearchHead: "40",
    dcHeadLabel: "창작",
    // 창작 글은 직접 그린 작품이라 원작 작가가 없다.
    showsOriginalArtists: false,
  },
};
