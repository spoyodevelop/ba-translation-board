import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Sentry from "@sentry/node";
import type { JobRequest } from "../database/types";
import { describeError } from "./describeError.ts";

// Sentry 무료 플랜은 월 5천 건이다. 같은 실패가 작업마다 반복되면(예: 글 하나가 이틀간 563번 실패)
// 하루 만에 다 쓰므로, 같은 원인은 정해진 간격에 한 번만 보낸다.
const groupingReportIntervalMs = 24 * 60 * 60_000;
const jobReportIntervalMs = 60 * 60_000;
const loopReportIntervalMs = 60 * 60_000;
const fatalReportIntervalMs = 60 * 60_000;
const fatalFlushTimeoutMs = 2000;
// 시작 실패는 PM2가 10초마다 재시작하며 반복되므로 간격을 프로세스 밖 파일에 남긴다.
// 무료 플랜에는 클라이언트 키 rate limit이 없어 Sentry 쪽에서 막을 수 없다.
// 재부팅하면 지워지는 임시 폴더에 둔다. 재부팅 뒤 첫 실패는 보내는 것이 맞다.
const fatalStateFile = join(tmpdir(), "translation-board-crash-reports.json");

export type CrashReporter = {
  // 같은 글의 그룹핑이 계속 실패하는지 알기 위한 보고다. 일시적인 요청 실패도 함께 온다.
  groupingFailed(postId: string, error: unknown): void;
  // 재시도를 모두 쓴 작업만 보고한다. 중간 재시도는 로그로만 남긴다.
  jobFailed(request: JobRequest, message: string): void;
  // 작업 바깥(일정 등록·작업 가져오기)의 실패다. DB 장애 동안 5초마다 반복된다.
  loopFailed(error: unknown): void;
  // 프로세스를 끝내는 실패다. 종료 전에 전송을 기다린다.
  fatal(error: unknown): Promise<void>;
};

export const noCrashReports: CrashReporter = {
  groupingFailed() {},
  jobFailed() {},
  loopFailed() {},
  async fatal() {},
};

function jobKey(request: JobRequest): string {
  if (request.type === "collect")
    return `${request.type}:${request.board}:${request.source}`;
  return `${request.type}:${request.board}`;
}

type CrashSink = Pick<
  typeof Sentry,
  "captureException" | "captureMessage" | "flush"
>;

export function startCrashReports(env: NodeJS.ProcessEnv): CrashReporter {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return noCrashReports;
  Sentry.init({
    dsn,
    environment: env.NODE_ENV || "development",
    // 오류만 받는다. 성능 추적은 무료 할당량과 관계없이 지금 필요하지 않다.
    tracesSampleRate: 0,
    // 지역 변수에는 글 제목·작성자·토큰이, 브레드크럼에는 Healthchecks 비밀 URL과 로그 줄이 담길 수 있다.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeBreadcrumb: () => null,
    // SDK 기본값("warn")은 처리되지 않은 rejection 뒤에도 프로세스를 살려 둔다.
    // Node 기본 동작처럼 종료해야 PM2가 깨끗한 상태로 다시 띄운다.
    integrations: [Sentry.onUnhandledRejectionIntegration({ mode: "strict" })],
  });
  return createCrashReporter(Sentry, Date.now, fatalStateFile);
}

// 파일을 읽거나 쓰지 못하면 그냥 보낸다. 이 제한 때문에 보고가 빠지면 안 된다.
function readFatalState(file: string): Record<string, number> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (value && typeof value === "object") return value as Record<string, number>;
  } catch {}
  return {};
}

function writeFatalState(file: string, state: Record<string, number>) {
  try {
    writeFileSync(file, JSON.stringify(state));
  } catch {}
}

export function createCrashReporter(
  sink: CrashSink,
  now: () => number = Date.now,
  // 없으면 치명적 오류를 제한 없이 보낸다. 한 프로세스는 한 번만 보내고 종료한다.
  fatalStatePath?: string,
): CrashReporter {
  const lastSentAt = new Map<string, number>();
  function due(key: string, intervalMs: number): boolean {
    const last = lastSentAt.get(key);
    if (last !== undefined && now() - last < intervalMs) return false;
    lastSentAt.set(key, now());
    return true;
  }

  return {
    groupingFailed(postId, error) {
      if (!due(`grouping:${postId}`, groupingReportIntervalMs)) return;
      sink.captureException(error, {
        fingerprint: ["grouping-error", postId],
        tags: { event: "grouping-error", postId },
      });
    },
    jobFailed(request, message) {
      const key = jobKey(request);
      if (!due(`job:${key}`, jobReportIntervalMs)) return;
      sink.captureMessage(`작업 최종 실패 (${key}): ${message}`, {
        level: "error",
        fingerprint: ["job-failed", key],
        tags: { event: "job-failed", job: key },
      });
    },
    loopFailed(error) {
      if (!due("loop", loopReportIntervalMs)) return;
      sink.captureException(error, {
        fingerprint: ["worker-error"],
        tags: { event: "worker-error" },
      });
    },
    async fatal(error) {
      const key = describeError(error);
      if (fatalStatePath) {
        const state = readFatalState(fatalStatePath);
        const last = state[key];
        const recentlySent =
          typeof last === "number" && now() - last < fatalReportIntervalMs;
        if (recentlySent) return;
        // 오래된 항목은 버려 파일이 커지지 않게 한다.
        const kept = Object.entries(state).filter(
          ([, sentAt]) => now() - sentAt < fatalReportIntervalMs,
        );
        writeFatalState(fatalStatePath, {
          ...Object.fromEntries(kept),
          [key]: now(),
        });
      }
      sink.captureException(error, {
        level: "fatal",
        tags: { event: "worker-fatal" },
      });
      await sink.flush(fatalFlushTimeoutMs);
    },
  };
}
