import { parse } from "node-html-parser";
import type { OriginalSource, SourceLookupResult } from "./types";
import { articleImageSite } from "../shared/sites.ts";

export function extractBodyImage(
  bodyHtml: string,
  articleUrl: string,
): string | undefined {
  const document = parse(bodyHtml);
  document
    .querySelectorAll("script, style")
    .forEach((element) => element.remove());
  for (const image of document.querySelectorAll("img")) {
    const value = image.getAttribute("src") || image.getAttribute("data-src");
    if (!value) continue;
    try {
      const url = new URL(value, articleUrl);
      // Only article image CDNs; exclude avatars, stickers and arbitrary external URLs.
      if (
        url.protocol === "https:" &&
        articleImageSite(url) !== null &&
        !/dccon/i.test(url.pathname)
      )
        return url.href;
    } catch {
      /* Ignore malformed image URLs. */
    }
  }
  return undefined;
}

export function normalizeSourceUrl(value: string): OriginalSource | null {
  let url: URL;
  try {
    url = new URL(value.trim());
    if (url.hostname === "unsafelink.com") {
      url = new URL(decodeURIComponent(url.pathname.slice(1)));
    }
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^www\./, "");

  if (host === "x.com" || host === "twitter.com") {
    const match = url.pathname.match(/^\/([^/]+)\/status\/([1-9]\d*)(?:\/|$)/);
    if (!match) return null;
    return {
      key: `x:${match[2]}`,
      url: `https://x.com/${match[1]}/status/${match[2]}`,
    };
  }
  if (host === "pixiv.net") {
    const match = url.pathname.match(/^\/artworks\/([1-9]\d*)\/?$/);
    if (!match) return null;
    return {
      key: `pixiv:${match[1]}`,
      url: `https://www.pixiv.net/artworks/${match[1]}`,
    };
  }
  return null;
}

// Call only after the collector has verified that this is an article body.
// An empty challenge/error page must not become a successful "no source" result.
export function extractSources(
  bodyHtml: string,
): Exclude<SourceLookupResult, { kind: "failed" }> {
  const document = parse(bodyHtml);
  document
    .querySelectorAll("script, style")
    .forEach((element) => element.remove());
  const candidates = document
    .querySelectorAll("a[href]")
    .map((link) => link.getAttribute("href") || "");
  const textUrls =
    document.structuredText.match(/https?:\/\/[^\s<>"'\u00a0]+/gi) || [];
  candidates.push(
    ...textUrls.map((url) => url.replace(/[.,;!?)\]}>。、）]+$/, "")),
  );
  const sources = new Map<string, OriginalSource>();
  for (const candidate of candidates) {
    const source = normalizeSourceUrl(candidate);
    if (source) sources.set(source.key, source);
  }
  if (sources.size === 0) return { kind: "none", sources: [] };
  return { kind: "found", sources: [...sources.values()] };
}
