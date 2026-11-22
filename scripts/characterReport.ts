import { writeFile } from "node:fs/promises";
import { characters } from "../src/characters/characterList.ts";
import { createCharacterMatcher } from "../src/characters/matchCharacters.ts";
import { openTursoDatabase } from "../src/database/connection.ts";
import { mergePostGroups } from "../src/grouping/postGroups.ts";
import type { Post } from "../src/shared/post.ts";

// 운영 DB의 제목으로 캐릭터 판정이 얼마나 붙는지 잰다. 읽기만 하므로 읽기 전용 토큰을 쓴다.
// 결과 JSON을 남겨 두면 규칙을 바꾼 뒤 어떤 글의 판정이 달라졌는지 비교할 수 있다.

const help = "사용법: characters:report [결과 JSON 경로]";
const unmatchedSampleSize = 30;
const inWordListSize = 40;

type Row = Omit<Post, "duplicateGroupId"> & { board: string };

async function main() {
  const [outFile, ...extra] = process.argv.slice(2);
  if (extra.length > 0) throw new Error(help);
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL을 설정하세요.");
  const client = openTursoDatabase({ url, authToken: process.env.TURSO_READ_TOKEN });
  try {
    const posts = await client.execute(
      "SELECT id, board, source, source_id, title, url, author, published_at FROM posts",
    );
    const edges = await client.execute(
      "SELECT first_post_id, second_post_id FROM automatic_matches",
    );
    const rows: Row[] = posts.rows.map((row) => ({
      id: String(row.id),
      board: String(row.board),
      source: row.source === "dc" ? "dc" : "arca",
      sourceId: String(row.source_id),
      title: String(row.title),
      url: String(row.url),
      author: row.author === null ? null : String(row.author),
      publishedAt: new Date(Number(row.published_at)).toISOString(),
    }));
    const groupEdges = edges.rows.map((row) => ({
      firstId: String(row.first_post_id),
      secondId: String(row.second_post_id),
    }));
    const report = measure(rows, groupEdges);
    if (outFile) await writeFile(outFile, JSON.stringify(report.byPost, null, 1));
  } finally {
    client.close();
  }
}

function measure(rows: Row[], edges: { firstId: string; secondId: string }[]) {
  const match = createCharacterMatcher(characters);
  const nameOf = new Map(characters.map((c) => [c.id, c.name]));
  const byPost = rows.map(({ id, board, title }) => ({
    id,
    board,
    title,
    characterIds: match(title),
  }));

  // 묶음은 한쪽 제목에만 이름이 있어도 묶음 전체에 뱃지를 붙인다고 보고 잰다.
  const grouped = mergePostGroups(rows, edges);
  const groupOf = new Map(grouped.map((post) => [post.id, post.duplicateGroupId || post.id]));
  const groupIds = new Map<string, Set<string>>();
  for (const post of byPost) {
    const key = groupOf.get(post.id)!;
    const ids = groupIds.get(key) || new Set<string>();
    for (const id of post.characterIds) ids.add(id);
    groupIds.set(key, ids);
  }

  for (const board of ["translation", "creative"]) {
    const posts = byPost.filter((post) => post.board === board);
    const matched = posts.filter((post) => post.characterIds.length > 0).length;
    const groups = new Set(posts.map((post) => groupOf.get(post.id)!));
    const matchedGroups = [...groups].filter((key) => groupIds.get(key)!.size > 0).length;
    console.log(
      `${board}: 글 ${matched}/${posts.length} (${percent(matched, posts.length)}), ` +
        `묶음 ${matchedGroups}/${groups.size} (${percent(matchedGroups, groups.size)})`,
    );
  }

  const counts = new Map<string, number>();
  for (const post of byPost)
    for (const id of post.characterIds) counts.set(id, (counts.get(id) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  console.log("\n많이 나온 캐릭터");
  console.log(ranked.slice(0, 30).map(([id, n]) => `${nameOf.get(id)} ${n}`).join(", "));
  const unseen = characters.filter((c) => !counts.has(c.id)).map((c) => c.name);
  console.log(`\n한 번도 안 나온 캐릭터 ${unseen.length}명: ${unseen.join(", ")}`);

  // 이름이 다른 글자와 붙어 나온 낱말이다. 애칭이면 그대로 두고, 다른 단어면 매칭기의 막는 단어나
  // 경계를 엄격히 보는 이름에 더한다.
  const inWord = new Map<string, number>();
  for (const post of byPost)
    for (const id of post.characterIds)
      for (const word of wordsAround(post.title, nameOf.get(id)!))
        inWord.set(`${nameOf.get(id)}: ${word}`, (inWord.get(`${nameOf.get(id)}: ${word}`) || 0) + 1);
  const repeated = [...inWord].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  console.log(`\n낱말 속에 붙어 나온 이름 (2번 이상, 상위 ${inWordListSize}개)`);
  console.log(repeated.slice(0, inWordListSize).map(([key, n]) => `${key}×${n}`).join(", "));

  const unmatched = byPost.filter((post) => post.characterIds.length === 0);
  console.log(`\n이름을 못 찾은 제목 (${unmatchedSampleSize}개 표본)`);
  for (const post of sample(unmatched, unmatchedSampleSize)) console.log(`  ${post.title}`);
  return { byPost };
}

// 이름 뒤에 조사나 호칭만 붙은 낱말은 이름이 맞으므로 보여 주지 않는다.
const particleOnly =
  /^(?:쨩|짱|쟝|님|양|씨|선배)?(?:이|가|의|은|는|을|를|와|과|랑|이랑|도|한테|에게|에|로|으로|만|께서|이가|야|아)?$/u;

// 이름 앞이나 뒤에 한글이 붙어 있으면 이름을 품은 낱말 전체를 돌려준다.
function wordsAround(title: string, name: string): string[] {
  const hangul = /\p{Script=Hangul}/u;
  const words: string[] = [];
  for (let index = title.indexOf(name); index >= 0; index = title.indexOf(name, index + name.length)) {
    let start = index;
    let end = index + name.length;
    while (start > 0 && hangul.test(title[start - 1])) start -= 1;
    while (end < title.length && hangul.test(title[end])) end += 1;
    const before = title.slice(start, index);
    const after = title.slice(index + name.length, end);
    if (before === "" && particleOnly.test(after)) continue;
    if (end - start > name.length) words.push(title.slice(start, end));
  }
  return words;
}

function percent(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

// 실행할 때마다 같은 표본을 보도록 id 순서로 고르게 뽑는다.
function sample<T extends { id: string }>(items: T[], size: number): T[] {
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const step = Math.max(1, Math.floor(sorted.length / size));
  return sorted.filter((_, index) => index % step === 0).slice(0, size);
}

await main();
