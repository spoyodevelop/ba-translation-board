import { titleSimilarity } from "./titleSimilarity.ts";

// 창작 글은 작가가 양쪽에 직접 올리는 경우가 많아 목록 정보(작가·시각·제목)만으로 대부분 판정한다.
// 문턱값은 2026-11-01~04, 11-04~07 창작 글 523쌍의 수동 판정에 맞췄다.
// 캐릭터 이름은 목록을 완성할 수 없고 잘못 뽑으면 판정을 흔들어 쓰지 않는다. 11-04~07 표본에서 빼도 5쌍 차이였다.

export const creativePairWindowMs = 6 * 60 * 60_000;
const sameAuthorWindowMs = 60 * 60_000;
const sameAuthorTitleSimilarity = 0.5;
const repostTitleSimilarity = 0.9;
const otherAuthorWindowMs = 120 * 60_000;
const otherAuthorTitleSimilarity = 0.7;
const imageCheckTitleSimilarity = 0.5;

export type CreativeVerdict = "same" | "different" | "image";
export type CreativeReason =
  | "episode-conflict"
  | "same-author-recent"
  | "same-author-repost"
  | "similar-title"
  | "ambiguous"
  | "better-pair-exists"
  | "no-evidence";

type ListedPost = { id: string; title: string; publishedAt: number };
export type CreativePair = {
  dc: ListedPost;
  arca: ListedPost;
  // 별칭 목록 등 작가 판단은 호출하는 쪽이 정한다.
  sameAuthor: boolean;
};
export type JudgedPair<Pair extends CreativePair> = Pair & {
  verdict: CreativeVerdict;
  reason: CreativeReason;
  similarity: number;
  gapMs: number;
  score: number;
};

// "9화"와 "10화"처럼 회차가 다르면 같은 연재의 다른 글이다.
function episodeNumbers(title: string): string[] {
  const numbers = [
    ...title.matchAll(/(\d+)\s*(?:화|편|부|장|话|話)/g),
    ...title.matchAll(/(?:#|ep\.?\s*)(\d+)/gi),
  ].map((match) => String(Number(match[1])));
  return [...new Set(numbers)];
}

function episodesConflict(first: string, second: string) {
  const a = episodeNumbers(first);
  const b = episodeNumbers(second);
  if (a.length === 0 || b.length === 0) return false;
  return !a.some((number) => b.includes(number));
}

export function judgeCreativePair<Pair extends CreativePair>(
  pair: Pair,
): JudgedPair<Pair> {
  const gapMs = Math.abs(pair.dc.publishedAt - pair.arca.publishedAt);
  const similarity = titleSimilarity(pair.dc.title, pair.arca.title);

  let verdict: CreativeVerdict = "different";
  let reason: CreativeReason = "no-evidence";
  const recentSameAuthor = pair.sameAuthor && gapMs <= sameAuthorWindowMs;
  if (gapMs > creativePairWindowMs) {
    reason = "no-evidence";
  } else if (episodesConflict(pair.dc.title, pair.arca.title)) {
    reason = "episode-conflict";
  } else if (recentSameAuthor && similarity >= sameAuthorTitleSimilarity) {
    verdict = "same";
    reason = "same-author-recent";
  } else if (pair.sameAuthor && similarity >= repostTitleSimilarity) {
    verdict = "same";
    reason = "same-author-repost";
  } else if (
    gapMs <= otherAuthorWindowMs &&
    similarity >= otherAuthorTitleSimilarity
  ) {
    verdict = "same";
    reason = "similar-title";
  } else if (
    gapMs <= otherAuthorWindowMs &&
    similarity >= imageCheckTitleSimilarity
  ) {
    verdict = "image";
    reason = "ambiguous";
  }
  // 한 글을 여러 글과 묶지 않도록 고를 때 쓰는 점수다.
  const score =
    (pair.sameAuthor ? 1 : 0) + similarity - gapMs / (1000 * 60_000);
  return { ...pair, verdict, reason, similarity, gapMs, score };
}

// 한 글은 반대 사이트의 한 글하고만 같다. 점수가 높은 같음부터 짝을 정하고,
// 짝이 정해진 글이 들어간 나머지 쌍은 같음·이미지 비교 모두 다름으로 돌린다.
// 같은 날 같은 캐릭터 그림이 몰리면(생일 등) 이미 짝이 정해진 글이 다른 글과 계속 엮이기 때문이다.
export function judgeCreativePairs<Pair extends CreativePair>(pairs: Pair[]) {
  const results = pairs.map(judgeCreativePair);
  const matched = new Set<string>();
  const confident = results
    .filter((result) => result.verdict === "same")
    .sort((a, b) => b.score - a.score);
  for (const result of confident) {
    const alreadyMatched =
      matched.has(result.dc.id) || matched.has(result.arca.id);
    if (alreadyMatched) {
      result.verdict = "different";
      result.reason = "better-pair-exists";
      continue;
    }
    matched.add(result.dc.id);
    matched.add(result.arca.id);
  }
  for (const result of results) {
    if (result.verdict !== "image") continue;
    if (!matched.has(result.dc.id) && !matched.has(result.arca.id)) continue;
    result.verdict = "different";
    result.reason = "better-pair-exists";
  }
  return results;
}
