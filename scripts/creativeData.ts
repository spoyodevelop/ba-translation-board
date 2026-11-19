import { readFile, rename, writeFile } from "node:fs/promises";
import { openTursoDatabaseFromEnv } from "../src/database/connection.ts";
import { siteAddresses } from "../src/shared/sites.ts";
import { createWorkerRepositories } from "../src/database/repositories.ts";
import { isAnonymousDcAuthor } from "../src/grouping/creativeAuthors.ts";
import type { AliasStore, DcAuthor } from "../src/grouping/creativeAuthors.ts";
export {
  authorPairKey,
  createAuthorRelation,
  isSameAuthor,
  normalizeNick,
} from "../src/grouping/creativeAuthors.ts";
export type { AliasStore, DcAuthor } from "../src/grouping/creativeAuthors.ts";

// 창작 검토 스크립트들이 함께 쓰는 글 목록과 작가 별칭 파일이다.
// worker가 창작 글을 작가 아이디와 함께 저장하므로 사이트를 다시 읽지 않고 DB에서 가져온다.
// DB 접근 권한과 별칭 파일이 있는 운영 worker 서버의 worker 폴더에서 실행한다.

type ListedPost = { id: string; title: string; url: string; publishedAt: number };
export type DcPost = ListedPost & { author: DcAuthor; anonymous: boolean };
export type ArcaPost = ListedPost & { author: string };
export type Listing = { dc: DcPost[]; arca: ArcaPost[] };
export type ListingRange = { since: number; until: number };

// 작가 별칭은 worker가 읽는 파일 하나만 원본으로 둔다. 닉네임과 디시 아이디가 들어 있어 저장소에 절대 올리지 않는다.
export function aliasFile() {
  const file = process.env.CREATIVE_AUTHOR_ALIASES_FILE?.trim();
  if (!file)
    throw new Error(
      "CREATIVE_AUTHOR_ALIASES_FILE을 설정하세요. 운영 worker 서버의 worker 폴더에서 실행해야 합니다.",
    );
  return file;
}

export async function loadCreativeListing(
  range: ListingRange,
): Promise<Listing> {
  const client = openTursoDatabaseFromEnv(process.env);
  try {
    const posts = await createWorkerRepositories(
      client,
      "creative",
    ).posts.listRecent(range.since);
    const listing: Listing = { dc: [], arca: [] };
    for (const post of posts) {
      const publishedAt = Date.parse(post.publishedAt);
      if (publishedAt >= range.until || !post.author) continue;
      const base = { id: post.id, title: post.title, publishedAt };
      if (post.source === "dc") {
        const author = { uid: post.authorId, nick: post.author };
        listing.dc.push({
          ...base,
          url: post.url,
          author,
          anonymous: isAnonymousDcAuthor(author),
        });
        continue;
      }
      // 목록 링크의 카테고리·페이지 파라미터는 글 확인에 필요 없다.
      listing.arca.push({
        ...base,
        url: siteAddresses.arca.postUrl(post.sourceId),
        author: post.author,
      });
    }
    return listing;
  } finally {
    client.close();
  }
}

export async function readAliasStore(): Promise<AliasStore> {
  try {
    return JSON.parse(await readFile(aliasFile(), "utf8")) as AliasStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { aliases: [], rejected: [] };
    throw error;
  }
}

// 쓰는 도중 끊겨도 worker가 반쯤 쓴 파일을 읽지 않도록 임시 파일에 쓴 뒤 바꾼다.
export async function writeAliasStore(store: AliasStore) {
  const file = aliasFile();
  await writeFile(`${file}.tmp`, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(`${file}.tmp`, file);
}

// 판정 칸을 채운 뒤 스프레드시트에서 다시 저장한 CSV를 읽는다.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell || row.length > 0) rows.push([...row, cell]);
  return rows;
}


export type JudgedPair = {
  dc: DcPost;
  arca: ArcaPost;
  decision: "same" | "different";
};

// creative:review가 만든 JSON과, 사람이 판정 칸을 채운 같은 날 CSV를 함께 읽는다.
export async function readJudgedSample(
  csvFile: string,
  jsonFile: string,
): Promise<{ listing: Listing; decisions: JudgedPair[] }> {
  const [header, ...rows] = parseCsv(
    (await readFile(csvFile, "utf8")).replace(/^\uFEFF/, ""),
  );
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`CSV에 "${name}" 열이 없습니다.`);
    return index;
  };
  const decisionColumn = column("판정");
  const dcUrlColumn = column("디시 URL");
  const arcaUrlColumn = column("아카 URL");
  const { listing } = JSON.parse(await readFile(jsonFile, "utf8")) as {
    listing: Listing;
  };
  const dcByUrl = new Map(listing.dc.map((post) => [post.url, post]));
  const arcaByUrl = new Map(listing.arca.map((post) => [post.url, post]));
  const decisions: JudgedPair[] = [];
  for (const row of rows) {
    const decision = row[decisionColumn]?.trim();
    if (decision !== "same" && decision !== "different") continue;
    const dc = dcByUrl.get(row[dcUrlColumn]);
    const arca = arcaByUrl.get(row[arcaUrlColumn]);
    if (!dc || !arca)
      throw new Error(`JSON 목록에 없는 글: ${row[dcUrlColumn]}`);
    decisions.push({ dc, arca, decision });
  }
  return { listing, decisions };
}
