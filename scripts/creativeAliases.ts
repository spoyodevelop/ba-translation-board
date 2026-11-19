import { createInterface } from "node:readline/promises";
import { titleSimilarity } from "../src/grouping/titleSimilarity.ts";
import {
  aliasFile,
  authorPairKey,
  loadCreativeListing,
  normalizeNick,
  readAliasStore,
  writeAliasStore,
} from "./creativeData.ts";
import type {
  AliasStore,
  ArcaPost,
  DcAuthor,
  DcPost,
  Listing,
} from "./creativeData.ts";

// 창작 탭의 글쓴이 별칭을 사람이 하루 한 번 확인한다. 운영 worker 서버의 worker 폴더에서 실행한다.

// 하루 한 번 실행하므로 이틀치를 읽으면 빠지는 글이 없다.
const listingDays = 2;
const pairWindowMs = 6 * 60 * 60_000;
const minimumTitleSimilarity = 0.5;
const exampleLimit = 3;
const defaultNick = "ㅇㅇ";

type Candidate = {
  dc: DcAuthor;
  arca: string;
  examples: {
    dc: DcPost;
    arca: ArcaPost;
    similarity: number;
  }[];
};

function findCandidates(listing: Listing, store: AliasStore) {
  const decided = new Set(
    [...store.aliases, ...store.rejected].map((entry) =>
      authorPairKey(entry.dc, entry.arca),
    ),
  );
  const candidates = new Map<string, Candidate>();
  for (const dc of listing.dc) {
    if (dc.anonymous) continue;
    for (const arca of listing.arca) {
      // 아카의 ㅇㅇ은 익명 사용자 이름이라 한 사람으로 이을 수 없다.
      if (arca.author === defaultNick) continue;
      const sameNick = normalizeNick(dc.author.nick) === normalizeNick(arca.author);
      const tooFar = Math.abs(dc.publishedAt - arca.publishedAt) > pairWindowMs;
      if (sameNick || tooFar) continue;
      const key = authorPairKey(dc.author, arca.author);
      if (decided.has(key)) continue;
      const similarity = titleSimilarity(dc.title, arca.title);
      if (similarity < minimumTitleSimilarity) continue;
      const candidate = candidates.get(key) || {
        dc: dc.author,
        arca: arca.author,
        examples: [],
      };
      candidate.examples.push({ dc, arca, similarity });
      candidates.set(key, candidate);
    }
  }
  // 여러 번 함께 나온 짝일수록 같은 사람일 가능성이 높아 먼저 묻는다.
  return [...candidates.values()].sort(
    (a, b) =>
      b.examples.length - a.examples.length ||
      Math.max(...b.examples.map((e) => e.similarity)) -
        Math.max(...a.examples.map((e) => e.similarity)),
  );
}

async function review(candidates: Candidate[], store: AliasStore) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  // question()은 미리 들어온 입력 줄을 놓칠 수 있어 줄 단위로 읽는다.
  const lines = prompt[Symbol.asyncIterator]();
  // 터미널은 입력할 때마다 readline 프롬프트로 줄을 다시 그리므로 질문을 프롬프트로 등록한다.
  prompt.setPrompt("같은 사람? [y]예 [n]아니오 [s]넘김 [q]저장 후 종료: ");
  let decidedCount = 0;
  try {
    for (const [index, candidate] of candidates.entries()) {
      const uid = candidate.dc.uid ? ` (${candidate.dc.uid})` : "";
      console.log(
        `\n[${index + 1}/${candidates.length}] 디시 ${candidate.dc.nick}${uid}  ↔  아카 ${candidate.arca}  · ${candidate.examples.length}건`,
      );
      for (const example of candidate.examples.slice(0, exampleLimit)) {
        const gapMinutes = Math.round(
          Math.abs(example.dc.publishedAt - example.arca.publishedAt) / 60_000,
        );
        console.log(
          `  제목 ${example.similarity.toFixed(2)} · 작성 ${gapMinutes}분 차이`,
        );
        console.log(`    디시「${example.dc.title}」 ${example.dc.url}`);
        console.log(`    아카「${example.arca.title}」 ${example.arca.url}`);
      }
      prompt.prompt();
      const line = await lines.next();
      if (line.done) break;
      const answer = line.value.trim().toLowerCase();
      if (answer === "q") break;
      if (answer !== "y" && answer !== "n") continue;
      const entry = {
        dc: candidate.dc,
        arca: candidate.arca,
        decidedAt: new Date().toISOString(),
      };
      // 거절한 짝도 남겨야 다음 날 같은 후보를 다시 묻지 않는다.
      if (answer === "y") store.aliases.push(entry);
      else store.rejected.push(entry);
      decidedCount += 1;
    }
  } finally {
    prompt.close();
  }
  return decidedCount;
}

async function main() {
  if (process.argv.length > 2) throw new Error("사용법: creative:aliases");
  const now = Date.now();
  const listing = await loadCreativeListing({
    since: now - listingDays * 24 * 60 * 60_000,
    until: now,
  });
  console.log(`목록: 디시 ${listing.dc.length}개, 아카 ${listing.arca.length}개`);

  const store = await readAliasStore();
  const candidates = findCandidates(listing, store);
  if (candidates.length === 0) {
    console.log("새로 확인할 별칭 후보가 없습니다.");
    return;
  }
  const decidedCount = await review(candidates, store);
  if (decidedCount > 0) await writeAliasStore(store);
  console.log(
    `\n${decidedCount}건 저장. 별칭 ${store.aliases.length}개, 거절 ${store.rejected.length}개 (${aliasFile()})`,
  );
}

await main();
