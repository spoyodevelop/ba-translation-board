import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openTursoDatabase } from "../src/database/connection.ts";
import { migrateTursoDatabase } from "../src/database/schema.ts";
import { createWorkerRepositories } from "../src/database/repositories.ts";
import type { WorkerRepositories } from "../src/database/repositories.ts";
import {
  createCreativeGrouper,
  CREATIVE_GROUPING_VERSION,
  CREATIVE_MANUAL_VERSION,
} from "../src/worker/creativeGrouping.ts";
import {
  createAuthorRelation,
  isAnonymousDcAuthor,
} from "../src/grouping/creativeAuthors.ts";
import type { AliasStore } from "../src/grouping/creativeAuthors.ts";
import type { CollectedPost } from "../src/database/types";

const time = Date.parse("2026-11-05T00:00:00Z");
const minute = 60_000;

function post(
  id: string,
  title: string,
  author: string,
  minutes = 0,
  authorId: string | null = null,
): CollectedPost {
  return {
    id,
    source: id.startsWith("arca-") ? "arca" : "dc",
    sourceId: id.split("-")[1],
    title,
    url: `https://example.com/${id}`,
    author,
    authorId,
    publishedAt: new Date(time + minutes * minute).toISOString(),
    viewCount: null,
    recommendCount: null,
  };
}

async function withCreative(
  aliases: AliasStore,
  run: (
    db: WorkerRepositories,
    grouper: ReturnType<typeof createCreativeGrouper>,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "creative-grouping-"));
  const client = openTursoDatabase({
    url: pathToFileURL(join(directory, "board.db")).href,
  });
  try {
    await migrateTursoDatabase(client);
    const db = createWorkerRepositories(client, "creative");
    await run(db, createCreativeGrouper({ repositories: db, aliases, now: () => time }));
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const noAliases: AliasStore = { aliases: [], rejected: [] };
const pairs = async (db: WorkerRepositories) =>
  (await db.grouping.listMatches()).map((m) => [m.firstPostId, m.secondPostId]);

test("an aliased author is the same author and the match keeps rule evidence", async () => {
  const aliases: AliasStore = {
    aliases: [
      { dc: { uid: "writer1", nick: "디시작가1" }, arca: "아카작가1", decidedAt: "" },
    ],
    rejected: [],
  };
  await withCreative(aliases, async (db, grouper) => {
    await db.posts.upsert([
      post("dc-1", "레이사는 안울어", "디시작가1", 0, "writer1"),
      post("arca-1", "레이사는 안 울어!", "아카작가1", 10),
    ]);
    const target = (await db.posts.get("dc-1"))!;
    assert.deepEqual(await grouper.process(target), {
      comparedCount: 1,
      groupedCount: 1,
    });
    const [match] = await db.grouping.listMatches();
    assert.deepEqual(match.creativeEvidence, {
      kind: "rule",
      reason: "same-author-recent",
      similarity: 1,
      gapMinutes: 10,
      sameAuthor: true,
    });
    assert.deepEqual(
      (await db.posts.findUnprocessed(0, CREATIVE_GROUPING_VERSION, 10)).map(
        (p) => p.id,
      ),
      ["arca-1"],
    );
  });
});

test("a post already paired with another post is not a candidate", async () => {
  await withCreative(noAliases, async (db, grouper) => {
    await db.posts.upsert([
      post("dc-1", "카즈사 피규어 만들어왔습니다", "디시작가3"),
      post("arca-1", "카즈사 피규어 만들어왔습니다", "아카작가3", 5),
      post("dc-2", "카즈사 피규어 만들어왔습니다", "다른사람", 6),
    ]);
    await grouper.process((await db.posts.get("arca-1"))!);
    assert.deepEqual(await pairs(db), [["arca-1", "dc-2"]]);
    // dc-1을 판정할 때 arca-1은 이미 dc-2와 짝이라 후보가 아니다.
    const result = await grouper.process((await db.posts.get("dc-1"))!);
    assert.equal(result.groupedCount, 0);
    assert.deepEqual(await pairs(db), [["arca-1", "dc-2"]]);
  });
});

test("human-judged pairs survive later judging", async () => {
  await withCreative(noAliases, async (db, grouper) => {
    await db.posts.upsert([
      post("dc-1", "에리다요", "디시작가4", 0, "writer4"),
      post("arca-1", "전혀 다른 제목", "다른사람", 3),
    ]);
    await db.grouping.commit({
      comparisons: [
        {
          firstPostId: "dc-1",
          secondPostId: "arca-1",
          match: {
            firstPostId: "dc-1",
            secondPostId: "arca-1",
            sourceKeys: [],
            imageEvidence: null,
            titleEvidence: null,
            creativeEvidence: { kind: "manual" },
            algorithmVersion: CREATIVE_MANUAL_VERSION,
            matchedAt: time,
          },
        },
      ],
      processed: [],
    });
    await grouper.process((await db.posts.get("dc-1"))!);
    assert.deepEqual(await pairs(db), [["arca-1", "dc-1"]]);
    assert.equal(
      (await db.grouping.listMatches())[0].algorithmVersion,
      CREATIVE_MANUAL_VERSION,
    );
  });
});

test("pairs that need an image check stay apart", async () => {
  await withCreative(noAliases, async (db, grouper) => {
    await db.posts.upsert([
      post("dc-1", "라나 두번째 그림 그리기", "ㅇㅇ"),
      post("arca-1", "라나 그리기 두번째", "아카작가5", 2),
    ]);
    const result = await grouper.process((await db.posts.get("dc-1"))!);
    assert.deepEqual(result, { comparedCount: 1, groupedCount: 0 });
    assert.deepEqual(await pairs(db), []);
  });
});

test("a DC account named with the default nick is still identified by its id", () => {
  const relationOf = createAuthorRelation({
    aliases: [
      { dc: { uid: "writer2", nick: "ㅇㅇ" }, arca: "아카작가2", decidedAt: "" },
    ],
    rejected: [],
  });
  const dc = (uid: string | null, nick: string) => {
    const author = { uid, nick };
    return { author, anonymous: isAnonymousDcAuthor(author) };
  };
  assert.equal(relationOf(dc("writer2", "ㅇㅇ"), "아카작가2"), "alias");
  assert.equal(relationOf(dc("writer6", "ㅇㅇ"), "writer6"), "uid-nick");
  // 아카의 ㅇㅇ은 익명 사용자라 닉네임이 같아도 같은 사람이 아니다.
  assert.equal(relationOf(dc("someone", "ㅇㅇ"), "ㅇㅇ"), "different");
  assert.equal(relationOf(dc(null, "야옹"), "야옹"), "different");
  assert.equal(relationOf(dc("cat", "야옹"), "야옹"), "same-nick");
});
