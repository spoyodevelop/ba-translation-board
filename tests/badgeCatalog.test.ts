import assert from "node:assert/strict";
import { test } from "node:test";
import type { TitleBadges } from "../src/characters/matchBadges.ts";
import type { Post } from "../src/shared/post.ts";
import { createBadgeCatalog } from "../src/web/badges.ts";
import { badgeFromSearch, searchForBadge } from "../src/web/hooks/useBadgeFilter.ts";

const results: Record<string, TitleBadges> = {
  "히나와 미카": { characterIds: ["hina", "mika"], clubIds: [] },
  "티파티의 미카": { characterIds: ["mika"], clubIds: ["tea-party"] },
  "그림 모음": { characterIds: [], clubIds: [] },
};

function catalogWithCalls() {
  const calls: string[] = [];
  const catalog = createBadgeCatalog({
    matchTitle: (title) => {
      calls.push(title);
      return results[title];
    },
    characters: [
      { id: "hina", name: "히나" },
      { id: "mika", name: "미카" },
    ],
    clubs: [{ id: "tea-party", name: "티파티" }],
  });
  return { catalog, calls };
}

function post(id: string, title: string): Post {
  return {
    id,
    source: "dc",
    sourceId: id,
    title,
    url: `https://example.test/${id}`,
    author: null,
    publishedAt: "2026-11-23T00:00:00.000Z",
    duplicateGroupId: null,
  };
}

test("a group gets the badges of every title, characters before clubs", () => {
  const { catalog } = catalogWithCalls();
  const badges = catalog.findBadges([post("1", "티파티의 미카"), post("2", "히나와 미카")]);
  assert.deepEqual(
    badges.map((b) => `${b.kind}:${b.id}`),
    ["character:mika", "character:hina", "club:tea-party"],
  );
});

test("each title is matched once across refreshes", () => {
  const { catalog, calls } = catalogWithCalls();
  catalog.findBadges([post("1", "히나와 미카"), post("2", "그림 모음")]);
  catalog.findBadges([post("1", "히나와 미카"), post("2", "그림 모음")]);
  assert.deepEqual(calls, ["히나와 미카", "그림 모음"]);
});

test("the badge in the address survives a round trip", () => {
  const { catalog } = catalogWithCalls();
  const mika = catalog.lookup("character", "mika")!;
  const search = searchForBadge("?board=translation", mika);
  assert.equal(search, "?board=translation&badge=character%3Amika");
  assert.deepEqual(badgeFromSearch(search, catalog), mika);
  assert.equal(searchForBadge(search, null), "?board=translation");
});

test("links shared before clubs were renamed still open", () => {
  const { catalog } = catalogWithCalls();
  assert.deepEqual(badgeFromSearch("?badge=group:tea-party", catalog), {
    kind: "club",
    id: "tea-party",
    name: "티파티",
  });
});

test("unknown badges in the address are ignored", () => {
  const { catalog } = catalogWithCalls();
  assert.equal(badgeFromSearch("?badge=character:nobody", catalog), null);
  assert.equal(badgeFromSearch("?badge=school:gehenna", catalog), null);
  assert.equal(badgeFromSearch("?badge=character", catalog), null);
});
