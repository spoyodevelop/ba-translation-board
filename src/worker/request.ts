import { arcaAppUserAgent } from "../arca/constants.ts";
import {
  imageReferer,
  isArcaAppArticle,
  isArcaBoardList,
} from "../shared/sites.ts";

const browserUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function createNodeRequest(request: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const original = new Request(input, init);
    const url = new URL(original.url);
    const headers = new Headers(original.headers);
    if (!headers.has("User-Agent")) headers.set("User-Agent", browserUserAgent);
    const arcaArticle = isArcaAppArticle(url);
    const arcaBoardList = isArcaBoardList(url);
    if (url.hostname === "arca.live" && (arcaArticle || arcaBoardList)) {
      headers.set("User-Agent", arcaAppUserAgent);
    }
    const referer = imageReferer(url);
    if (referer) headers.set("Referer", referer);
    return request(new Request(original, { headers }));
  };
}
