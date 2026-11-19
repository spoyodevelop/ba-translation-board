import type { Post, Source } from "../shared/post";
import type { Board } from "../shared/boards.ts";
import type { OriginalSource } from "../sources/types";
import type { JevTitleEvidence } from "../grouping/evaluateWithJev.ts";
import type { ImageComparison } from "../sources/imageHash";
import type { CreativeReason } from "../grouping/creativeMatch.ts";

export type StoredPost = Post & {
  viewCount: number | null;
  recommendCount: number | null;
  authorId: string | null;
};
export type CollectedPost = Omit<StoredPost, "duplicateGroupId">;

// 창작 글은 목록 정보로 판정하거나, 창작 탭을 열기 전에 사람이 판정한 결과를 넣는다.
export type CreativeEvidence =
  | {
      kind: "rule";
      reason: CreativeReason;
      similarity: number;
      gapMinutes: number;
      sameAuthor: boolean;
    }
  | { kind: "manual" };

export type AutomaticMatch = {
  firstPostId: string;
  secondPostId: string;
  sourceKeys: OriginalSource["key"][];
  imageEvidence: ImageComparison | null;
  titleEvidence: JevTitleEvidence | null;
  creativeEvidence: CreativeEvidence | null;
  algorithmVersion: string;
  matchedAt: number;
};
export type MatchChange = {
  firstPostId: string;
  secondPostId: string;
  match: AutomaticMatch | null;
};
export type GroupingUpdate = {
  comparisons: MatchChange[];
  processed: {
    postId: string;
    algorithmVersion: string;
    processedAt: number;
  }[];
};

export type SourceCacheRecord = {
  postId: string;
  version: number;
  checkedAt: number;
  expiresAt: number;
  imageUrl: string | null;
  sources: OriginalSource[];
};
export type ImageCacheRecord = {
  key: string;
  version: string;
  checkedAt: number;
  expiresAt: number;
  width: number;
  height: number;
  wholeHash: string;
  regions: { hash: string; contrast: number }[];
};

export type JobRequest =
  | { type: "collect"; board: Board; source: Source | "all" }
  | { type: "backfill"; board: Board; limit: number };
export type JobResult = {
  collectedCount: number;
  comparedCount: number;
  groupedCount: number;
};
export type WorkerJob = {
  id: string;
  request: JobRequest;
  state: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  availableAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  attempts: number;
  maxAttempts: number;
  workerId: string | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  error: string | null;
  result: JobResult | null;
};
export type JobLease = { jobId: string; token: string };

export type CollectionState = {
  source: Source;
  board: Board;
  state: "idle" | "running" | "error";
  historyBackfilled: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastCount: number;
  error: string | null;
};
export type RequestScope = "arca-list" | "dc-list" | "sources" | "images";
