// Node의 fetch는 DNS·연결 실패를 모두 "fetch failed"로 감싸고 실제 원인은 cause에 둔다.
// 로그 한 줄만 보고 원인(예: getaddrinfo EAI_AGAIN)을 알 수 있도록 cause를 함께 남긴다.
const maxCauseDepth = 3;

function label(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  // 기본 Error는 이름이 정보가 되지 않는다. TypeError·TimeoutError처럼 종류가 드러날 때만 붙인다.
  let text = error.message;
  if (error.name !== "Error") text = `${error.name}: ${text}`;
  if (typeof code === "string" && !text.includes(code)) text += ` [${code}]`;
  return text;
}

export function describeError(error: unknown): string {
  const parts = [label(error)];
  let cause = error instanceof Error ? error.cause : undefined;
  while (cause !== undefined && parts.length <= maxCauseDepth) {
    parts.push(label(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return parts.join(" ← ");
}
