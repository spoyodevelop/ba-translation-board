import { parse, type HTMLElement } from "node-html-parser";
import type { Post } from "../shared/post";
import { arcaChannelUrl, arcaPostIdFromPath } from "../shared/sites.ts";

const rowSelector = [
  ".list-table .vrow.column:not(.notice):not(.head)",
  ".list-table .vrow.hybrid:not(.notice):not(.head)",
  ".article-list .vrow.column:not(.notice):not(.head)",
  ".article-list .vrow.hybrid:not(.notice):not(.head)",
].join(", ");

export function parseArcaPosts(html: string): Post[] {
  const doc = parse(html);
  const posts: Post[] = [];
  for (const row of Array.from(doc.querySelectorAll(rowSelector))) {
    const link =
      row.tagName === "A" && row.hasAttribute("href")
        ? row
        : row.querySelector("a.title[href], a.hybrid-title[href]");
    if (!link) continue;

    const url = new URL(link.getAttribute("href")!, arcaChannelUrl.href);
    const sourceId = arcaPostIdFromPath(url.pathname);
    if (!sourceId) continue;

    const title =
      (
        row.querySelector(".col-title .title, .title, .hybrid-title") || link
      ).textContent
        ?.trim()
        .replace(/\s+/g, " ") || "";
    if (!title) continue;

    const rawTime =
      row.querySelector("time[datetime]")?.getAttribute("datetime") ||
      row.querySelector('[data-tooltip="date"]')?.getAttribute("title");
    if (!rawTime) continue;
    const parsedTime = new Date(rawTime);
    if (Number.isNaN(parsedTime.getTime())) continue;

    posts.push({
      id: `arca-${sourceId}`,
      source: "arca",
      sourceId,
      title,
      url: url.href,
      author:
        row.querySelector(".user-info, .member-info")?.textContent?.trim() ||
        "",
      publishedAt: parsedTime.toISOString(),
      viewCount: parseCount(row, ".col-view"),
      recommendCount: parseCount(row, ".col-rate"),
      duplicateGroupId: null,
    });
  }
  return posts;
}

function parseCount(row: HTMLElement, selector: string): number | null {
  const value = row
    .querySelector(selector)
    ?.textContent?.trim()
    .replace(/,/g, "");
  return value && /^\d+$/.test(value) ? Number(value) : null;
}
