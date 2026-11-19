// 사이트 요청 실패를 한 모양으로 나타낸다. 목록·본문·이미지 요청이 같은 규칙으로 대기 시간과 차단을 판단한다.

export type SourceFailureKind =
  | "http"
  | "blocked"
  | "missing-body"
  | "invalid-response"
  | "timeout"
  | "network"
  | "storage"
  | "cooldown";

export class SourceRequestError extends Error {
  kind: SourceFailureKind;
  status: number | null;
  retryAfterMs: number;
  constructor(
    message: string,
    kind: SourceFailureKind,
    status: number | null = null,
    retryAfterMs = 0,
  ) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// 429는 Retry-After가 없거나 짧아도 최소 이만큼 쉰다. 짧게 다시 보내면 차단이 길어진다.
const minimumRateLimitDelayMs = 10_000;

// 다른 실패 상태는 서버가 Retry-After를 준 경우에만 그 시각까지 기다린다.
export function retryDelayMs(response: Response, now: number): number {
  const header = response.headers.get("retry-after");
  let delayMs = 0;
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) delayMs = Math.max(0, seconds * 1000);
    else delayMs = Math.max(0, Date.parse(header) - now) || 0;
  }
  if (response.status === 429)
    return Math.max(minimumRateLimitDelayMs, delayMs);
  return delayMs;
}

export function httpError(message: string, response: Response): SourceRequestError {
  return new SourceRequestError(
    `${message}: HTTP ${response.status}`,
    "http",
    response.status,
    retryDelayMs(response, Date.now()),
  );
}

// Cloudflare 확인 화면이나 사이트의 접근 제한 안내를 정상 페이지로 읽지 않도록 거른다.
export function isBlockedPage(html: string): boolean {
  const title = html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1] || "";
  return (
    /\/cdn-cgi\/challenge-platform\//i.test(html) ||
    /just a moment|접근.*차단|too many requests/i.test(title)
  );
}
