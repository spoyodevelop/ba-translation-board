import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidateWindowMs,
  findTitleCandidates,
  titleCandidateLimit,
} from "../src/grouping/findCandidates.ts";
import type { Post } from "../src/shared/post";

const time = Date.parse("2026-10-03T00:00:00Z");
function post(
  id: number,
  seconds: number,
  title = "케이와 승부게임",
  source: "arca" | "dc" = "dc",
): Post {
  return {
    id: `${source}-${id}`,
    source,
    sourceId: String(id),
    title,
    url: "",
    author: null,
    publishedAt: new Date(time + seconds * 1000).toISOString(),
    duplicateGroupId: null,
  };
}
const target = post(1, 0, "케이와 승부게임", "arca");

test("candidates come from the opposite source within an inclusive 48-hour window", () => {
  const boundary = post(2, candidateWindowMs / 1000);
  const old = post(3, -candidateWindowMs / 1000 - 1);
  const future = post(4, candidateWindowMs / 1000 + 1);
  const sameSource = post(5, 0, target.title, "arca");
  const invalid = { ...post(6, 0), publishedAt: "invalid" };
  assert.deepEqual(
    findTitleCandidates(target, [
      target,
      boundary,
      old,
      future,
      sameSource,
      invalid,
    ]),
    [boundary],
  );
  assert.deepEqual(
    findTitleCandidates({ ...target, publishedAt: "invalid" }, [boundary]),
    [],
  );
});

test("title ranking picks ten candidates and breaks equal title scores by time distance", () => {
  const nearby = post(2, 1, "관련 없는 제목");
  const exact = post(3, 60);
  assert.deepEqual(findTitleCandidates(target, [nearby, exact]), [
    exact,
    nearby,
  ]);
  const all = Array.from({ length: 12 }, (_, i) => post(i + 2, 12 - i));
  const candidates = findTitleCandidates(target, all);
  assert.equal(candidates.length, titleCandidateLimit);
  assert.deepEqual(
    candidates.map((p) => p.id),
    [...all]
      .reverse()
      .slice(0, 10)
      .map((p) => p.id),
  );
});

test("only the hundred nearest eligible posts enter title ranking", () => {
  const nearby = Array.from({ length: 100 }, (_, i) =>
    post(i + 2, i + 1, "다른 글"),
  );
  const distantExact = post(102, 101);
  assert.equal(
    findTitleCandidates(target, [...nearby, distantExact]).some(
      (p) => p.id === distantExact.id,
    ),
    false,
  );
});
