import { judgeCreativePairs } from "../src/grouping/creativeMatch.ts";
import {
  createAuthorRelation,
  isSameAuthor,
  readAliasStore,
  readJudgedSample,
} from "./creativeData.ts";

// creative:review 결과에 사람이 채운 판정과 현재 판정 규칙을 비교한다.
// 같은 표본으로 문턱값을 맞췄다면 새 날짜의 표본으로 다시 확인해야 의미가 있다.

const help =
  "사용법: creative:check <판정한 CSV> <같은 날 creative:review JSON>";

async function main() {
  const [csvFile, jsonFile, ...extra] = process.argv.slice(2);
  if (!csvFile || !jsonFile || extra.length > 0) throw new Error(help);
  const { decisions } = await readJudgedSample(csvFile, jsonFile);
  const relationOf = createAuthorRelation(await readAliasStore());
  const pairs = decisions.map(({ dc, arca, decision }) => ({
    dc,
    arca,
    sameAuthor: isSameAuthor(relationOf(dc, arca.author)),
    decision,
  }));

  const results = judgeCreativePairs(pairs);
  const counts = new Map<string, number>();
  for (const result of results) {
    const key = `${result.verdict} → ${result.decision}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const wrong = results.filter(
    (result) =>
      result.verdict !== "image" && result.verdict !== result.decision,
  );
  const image = results.filter((result) => result.verdict === "image");
  console.log(
    `판정 ${results.length}쌍: 맞음 ${results.length - wrong.length - image.length}, 틀림 ${wrong.length}, 이미지 비교 ${image.length}`,
  );
  for (const [key, count] of [...counts].sort())
    console.log(`  규칙 ${key}(사람): ${count}`);
  const describe = (result: (typeof results)[number]) =>
    `${Math.round(result.gapMs / 60_000)}분 · 제목 ${result.similarity.toFixed(2)} · ${result.reason}\n` +
    `    디시 ${result.dc.author.nick}「${result.dc.title}」 ${result.dc.url}\n` +
    `    아카 ${result.arca.author}「${result.arca.title}」 ${result.arca.url}`;
  for (const result of wrong) {
    const label = result.verdict === "same" ? "잘못 묶음" : "놓침";
    console.log(`\n${label} · ${describe(result)}`);
  }
  for (const result of image)
    console.log(
      `\n이미지 비교(사람: ${result.decision}) · ${describe(result)}`,
    );
}

await main();
