export type Source = "arca" | "dc";

// 글은 작성일(KST) 기준으로 이 개월 수만큼 보관한다. worker의 정리와 웹의 안내 문구가 같은 값을 쓴다.
export const postRetentionMonths = 3;

export type Post = {
  id: string;
  source: Source;
  sourceId: string;
  title: string;
  url: string;
  author: string | null;
  publishedAt: string;
  viewCount?: number | null;
  recommendCount?: number | null;
  duplicateGroupId: string | null;
};

// 목록에서 읽은 글이다. 디시 고정 아이디는 창작 중복 판정에만 쓰고 조회 API에는 내보내지 않는다.
// 유동과 아카 글은 아이디가 없다.
export type ListedPost = Post & { authorId: string | null };
