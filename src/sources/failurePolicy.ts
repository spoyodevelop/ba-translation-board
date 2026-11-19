import { SourceRequestError } from "./requestError.ts";
import type { SiteAdapter } from "./siteAdapters.ts";

type BodyRetryPolicy = Pick<SiteAdapter["body"], "maxAttempts" | "retryPauseMs">;

const defaultErrorPauseMs = 10_000;
const retryableKinds = [
  "network",
  "timeout",
  "missing-body",
  "invalid-response",
];

export type FailureDecision = {
  detail: SourceRequestError;
  pauseMs: number;
  shouldRetry: boolean;
  stopsCollection: boolean;
};

export function toSourceRequestError(error: unknown): SourceRequestError {
  if (error instanceof SourceRequestError) return error;
  const isTimeout =
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError");
  const message = error instanceof Error ? error.message : String(error);
  return new SourceRequestError(message, isTimeout ? "timeout" : "network");
}

function isRetryable(detail: SourceRequestError): boolean {
  const isRetryableHttp =
    detail.kind === "http" &&
    (detail.status === 429 || (detail.status || 0) >= 500);
  return isRetryableHttp || retryableKinds.includes(detail.kind);
}

function errorPauseMs(
  detail: SourceRequestError,
  policy: BodyRetryPolicy,
  attempt: number,
): number {
  // A hidden or missing article is not evidence of rate limiting.
  if (detail.status === 404) return 0;
  let pauseMs = policy.retryPauseMs(attempt);
  if (detail.status === 429) {
    pauseMs = detail.retryAfterMs || defaultErrorPauseMs;
  }
  return Math.max(pauseMs, detail.retryAfterMs);
}

export function decideFailure(
  error: unknown,
  policy: BodyRetryPolicy,
  attempt: number,
): FailureDecision {
  const detail = toSourceRequestError(error);
  const retryable = isRetryable(detail);
  const isLastAttempt = attempt >= policy.maxAttempts;
  const isBlocked = detail.kind === "blocked" || detail.status === 403;
  return {
    detail,
    pauseMs: errorPauseMs(detail, policy, attempt),
    shouldRetry: retryable && !isLastAttempt,
    stopsCollection: isBlocked || (retryable && isLastAttempt),
  };
}
