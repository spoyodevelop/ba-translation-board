import type { Post } from "../shared/post";
import { httpError } from "./requestError.ts";
import { siteAdapters } from "./siteAdapters.ts";

const articleRequestTimeoutMs = 15_000;

// 브라우저 없이 글 본문을 받는다. 주소와 응답 해석은 사이트 어댑터가 정한다.
export async function fetchArticleBody(
  post: Post,
  request: typeof fetch = fetch,
): Promise<string> {
  if (!/^\d+$/.test(post.sourceId))
    throw new Error("올바른 글 번호가 필요합니다.");
  const { body } = siteAdapters[post.source];
  const response = await request(body.requestUrl(post.sourceId), {
    signal: AbortSignal.timeout(articleRequestTimeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw httpError("본문 요청 실패", response);
  return body.read(text, post, response.status);
}
