import type { Source } from "../shared/post";

export const sources: Record<Source, { label: string }> = {
  arca: { label: "아카라이브" },
  dc: { label: "디시인사이드" },
};

export const pageSize = 25;
