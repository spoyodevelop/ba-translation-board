import { parse } from "node-html-parser";
import type { ListedPost } from "../shared/post";
import type { BoardConfig } from "../shared/boards.ts";
import { siteAddresses } from "../shared/sites.ts";

function parseKoreanTime(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+09:00`,
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseCount(value: string | undefined): number | null {
  const normalized = value?.trim().replace(/,/g, "");
  return normalized && /^\d+$/.test(normalized) ? Number(normalized) : null;
}

export function parseDcListing(html: string, board: BoardConfig): ListedPost[] {
  const document = parse(html);
  const posts: ListedPost[] = [];

  for (const row of document.querySelectorAll("tr.us-post[data-no]")) {
    const head = row.querySelector(".gall_subject")?.textContent || "";
    if (!head.includes(board.dcHeadLabel)) continue;

    const sourceId = row.getAttribute("data-no");
    const link = row
      .querySelectorAll(".gall_tit > a")
      .find((a) => a.getAttribute("href")?.includes("/mgallery/board/view/"));
    const title = link?.textContent.trim().replace(/\s+/g, " ") || "";
    const publishedAt = parseKoreanTime(
      row.querySelector(".gall_date")?.getAttribute("title") || "",
    );
    if (!sourceId || !/^\d+$/.test(sourceId) || !title || !publishedAt)
      continue;

    posts.push({
      id: `dc-${sourceId}`,
      source: "dc",
      sourceId,
      title,
      url: siteAddresses.dc.postUrl(sourceId),
      author:
        row.querySelector(".gall_writer")?.getAttribute("data-nick") || null,
      authorId:
        row.querySelector(".gall_writer")?.getAttribute("data-uid") || null,
      publishedAt,
      viewCount: parseCount(row.querySelector(".gall_count")?.textContent),
      recommendCount: parseCount(
        row.querySelector(".gall_recommend")?.textContent,
      ),
      duplicateGroupId: null,
    });
  }

  return posts;
}
