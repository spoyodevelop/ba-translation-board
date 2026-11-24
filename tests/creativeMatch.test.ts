import assert from "node:assert/strict";
import { test } from "node:test";
import {
  judgeCreativePair,
  judgeCreativePairs,
} from "../src/grouping/creativeMatch.ts";

const time = Date.parse("2026-11-05T00:00:00Z");
const minute = 60_000;

function pair(
  dcTitle: string,
  arcaTitle: string,
  gapMinutes: number,
  sameAuthor: boolean,
) {
  return {
    dc: { id: "dc-1", title: dcTitle, publishedAt: time },
    arca: {
      id: "arca-1",
      title: arcaTitle,
      publishedAt: time + gapMinutes * minute,
    },
    sameAuthor,
  };
}

test("different episode numbers are different posts", () => {
  const result = judgeCreativePair(
    pair("소설) 야인선생 10화", "소설)야인선생 9화", 10, true),
  );
  assert.equal(result.verdict, "different");
  assert.equal(result.reason, "episode-conflict");
});

test("same author within an hour needs a half-similar title", () => {
  assert.equal(judgeCreativePair(pair("말랑", "말랑", 1, true)).verdict, "same");
  assert.equal(
    judgeCreativePair(pair("오늘도 수고 ㅅㄱ~", "오늘도 수고 ㄳ~", 5, true)).verdict,
    "same",
  );
  // 같은 작가가 같은 캐릭터를 연달아 올린 다른 그림이 많았다.
  assert.equal(
    judgeCreativePair(pair("사츠키 완성함", "사츠키 그림", 0, true)).verdict,
    "different",
  );
  assert.equal(
    judgeCreativePair(pair("에리다요", "에리그림", 15, true)).verdict,
    "different",
  );
});

test("same author reposting the same title later is the same post", () => {
  assert.equal(
    judgeCreativePair(pair("말랑", "말랑", 90, true)).reason,
    "same-author-repost",
  );
  assert.equal(
    judgeCreativePair(pair("말랑", "말랑", 7 * 60, true)).verdict,
    "different",
  );
});

test("other authors need a close title within two hours", () => {
  const title = "카즈사 피규어 만들어왔습니다";
  assert.equal(judgeCreativePair(pair(title, title, 78, false)).verdict, "same");
  assert.equal(
    judgeCreativePair(pair(title, title, 150, false)).verdict,
    "different",
  );
});

test("other authors with a partly similar title need an image check", () => {
  const result = judgeCreativePair(
    pair("라나 두번째 그림 그리기", "라나 그리기 두번째", 2, false),
  );
  assert.equal(result.verdict, "image");
});

test("a post is matched with only its best counterpart", () => {
  const results = judgeCreativePairs([
    pair("레이싱 히후미 그렸음", "레이싱 히후미 그렸음", 5, false),
    {
      ...pair("레이싱 히후미 그렸어", "레이싱 히후미 그렸음", 20, false),
      dc: { id: "dc-2", title: "레이싱 히후미 그렸어", publishedAt: time },
    },
  ]);
  assert.deepEqual(
    results.map((result) => result.verdict),
    ["same", "different"],
  );
  assert.equal(results[1].reason, "better-pair-exists");
});

test("a matched post is not sent to an image check with other posts", () => {
  const sameAuthor = pair("카노에 생일 그림", "카노에 생일 그림", 5, true);
  const otherAuthor = {
    ...pair("카노에 생일 그림", "카노에 생일 축하해~", 6, false),
    arca: { id: "arca-2", title: "카노에 생일 축하해~", publishedAt: time },
  };
  assert.equal(judgeCreativePair(otherAuthor).verdict, "image");
  const results = judgeCreativePairs([otherAuthor, sameAuthor]);
  assert.deepEqual(
    results.map((result) => result.verdict),
    ["different", "same"],
  );
});
