import { mkdir, readFile, writeFile } from "node:fs/promises";
import { titleSimilarity } from "../src/grouping/titleSimilarity.ts";
import {
  creativePairWindowMs,
  judgeCreativePairs,
} from "../src/grouping/creativeMatch.ts";
import {
  createAuthorRelation,
  loadCreativeListing,
  isSameAuthor,
  readAliasStore,
} from "./creativeData.ts";
import type { ArcaPost, DcPost, Listing } from "./creativeData.ts";

// 창작 탭을 열기 전 며칠치 글 쌍을 사람이 판정할 수 있도록 후보와 근거를 파일로 낸다.
// 결과에는 닉네임·uid가 들어가므로 git에서 제외된 .data에 둔다.

const outputDirectory = new URL("../.data/creative-review/", import.meta.url)
  .pathname;
const defaultDays = 3;
const minimumTitleSimilarity = 0.3;
const koreanTimeOffsetMs = 9 * 60 * 60_000;

const help =
  '사용법: creative:review [--days 3] [--until "2026-11-04 02:46"] [--from 목록.json]\n' +
  "  --days: 기간 끝에서 며칠 전 글까지 가져올지 정한다.\n" +
  "  --until: 기간 끝(KST). 없으면 지금이다.\n" +
  "  --from: DB를 읽지 않고 저장한 목록으로 다시 만든다.";

function koreanTime(ms: number) {
  return new Date(ms + koreanTimeOffsetMs)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

function parseKoreanTime(value: string) {
  const ms = Date.parse(`${value.trim().replace(" ", "T")}+09:00`);
  if (!Number.isFinite(ms)) throw new Error(help);
  return ms;
}

function parseArgs(args: string[]) {
  const options = {
    days: defaultDays,
    until: null as number | null,
    from: null as string | null,
  };
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (!value) throw new Error(help);
    if (args[index] === "--days") options.days = Number(value);
    else if (args[index] === "--until") options.until = parseKoreanTime(value);
    else if (args[index] === "--from") options.from = value;
    else throw new Error(help);
  }
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 7)
    throw new Error(help);
  return options;
}

function postSummary(post: DcPost | ArcaPost, author: string) {
  return {
    id: post.id,
    title: post.title,
    url: post.url,
    author,
    publishedAt: koreanTime(post.publishedAt),
  };
}

async function buildPairs(listing: Listing) {
  const relationOf = createAuthorRelation(await readAliasStore());
  const candidates = [];
  for (const dc of listing.dc) {
    for (const arca of listing.arca) {
      if (Math.abs(dc.publishedAt - arca.publishedAt) > creativePairWindowMs)
        continue;
      const relation = relationOf(dc, arca.author);
      const sameAuthor = isSameAuthor(relation);
      // 작가 근거가 없는 쌍은 제목이 어느 정도 비슷할 때만 검토 대상으로 둔다.
      if (
        !sameAuthor &&
        titleSimilarity(dc.title, arca.title) < minimumTitleSimilarity
      )
        continue;
      candidates.push({ dc, arca, sameAuthor, relation });
    }
  }
  return judgeCreativePairs(candidates)
    .map((result) => {
      const dcAuthor = result.dc.author.uid
        ? `${result.dc.author.nick} (${result.dc.author.uid})`
        : result.dc.author.nick;
      return {
        suggestion: result.verdict,
        reason: result.reason,
        // 사람이 same / different로 채운다.
        decision: null as "same" | "different" | null,
        similarity: Number(result.similarity.toFixed(2)),
        gapMinutes: Math.round(result.gapMs / 60_000),
        authorRelation: result.relation,
        dc: postSummary(result.dc, dcAuthor),
        arca: postSummary(result.arca, result.arca.author),
      };
    })
    .sort(
      (a, b) =>
        b.dc.publishedAt.localeCompare(a.dc.publishedAt) ||
        b.similarity - a.similarity,
    );
}

function csvCell(value: unknown) {
  const text = Array.isArray(value) ? value.join(" ") : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(pairs: Awaited<ReturnType<typeof buildPairs>>) {
  const header = [
    "추정",
    "근거",
    "판정",
    "제목 유사도",
    "작성 차이(분)",
    "작가 관계",
    "디시 작성",
    "디시 작가",
    "디시 제목",
    "디시 URL",
    "아카 작성",
    "아카 작가",
    "아카 제목",
    "아카 URL",
  ];
  const rows = pairs.map((pair) => [
    pair.suggestion,
    pair.reason,
    "",
    pair.similarity,
    pair.gapMinutes,
    pair.authorRelation,
    pair.dc.publishedAt,
    pair.dc.author,
    pair.dc.title,
    pair.dc.url,
    pair.arca.publishedAt,
    pair.arca.author,
    pair.arca.title,
    pair.arca.url,
  ]);
  // 엑셀·Numbers가 한글을 UTF-8로 읽도록 BOM을 붙인다.
  return `﻿${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = Date.now();
  let until = options.until ?? now;
  let since = until - options.days * 24 * 60 * 60_000;
  let listing: Listing;
  if (options.from) {
    // 이전 검토 결과 파일은 그 안의 목록과 기간으로 다시 만든다.
    const saved = JSON.parse(await readFile(options.from, "utf8")) as
      | Listing
      | {
          listing: Listing;
          since?: string;
          until?: string;
          fetchedAt?: string;
        };
    if ("listing" in saved) {
      listing = saved.listing;
      if (saved.since) since = parseKoreanTime(saved.since);
      const savedUntil = saved.until ?? saved.fetchedAt;
      if (savedUntil) until = parseKoreanTime(savedUntil);
    } else listing = saved;
  } else {
    listing = await loadCreativeListing({ since, until });
  }
  const pairs = await buildPairs(listing);

  await mkdir(outputDirectory, { recursive: true });
  // 기간이 다른 표본이 서로 덮어쓰지 않도록 기간으로 이름을 짓는다.
  const stamp = `${koreanTime(since).slice(0, 10)}_${koreanTime(until).slice(0, 10)}`;
  const jsonFile = `${outputDirectory}${stamp}.json`;
  const csvFile = `${outputDirectory}${stamp}.csv`;
  await writeFile(
    jsonFile,
    `${JSON.stringify({ fetchedAt: koreanTime(now), since: koreanTime(since), until: koreanTime(until), listing, pairs }, null, 2)}\n`,
  );
  await writeFile(csvFile, toCsv(pairs));

  const count = (suggestion: string) =>
    pairs.filter((pair) => pair.suggestion === suggestion).length;
  const pairedDc = new Set(pairs.map((pair) => pair.dc.id)).size;
  const pairedArca = new Set(pairs.map((pair) => pair.arca.id)).size;
  console.log(`기간: ${koreanTime(since)} ~ ${koreanTime(until)} (KST)`);
  console.log(`글: 디시 ${listing.dc.length}개, 아카 ${listing.arca.length}개`);
  console.log(
    `후보 쌍 ${pairs.length}개: 같음 추정 ${count("same")}, 다름 추정 ${count("different")}, 이미지 비교 ${count("image")}`,
  );
  console.log(
    `후보에 한 번도 안 나온 글: 디시 ${listing.dc.length - pairedDc}개, 아카 ${listing.arca.length - pairedArca}개`,
  );
  console.log(`JSON: ${jsonFile}\nCSV: ${csvFile}`);
}

await main();
