import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCrashReporter } from "../src/worker/crashReports.ts";

function recordingSink() {
  const sent: string[] = [];
  return {
    sent,
    sink: {
      captureException: (error: unknown, hint?: unknown) => {
        const tags = (hint as { tags?: Record<string, string> })?.tags;
        sent.push(`${tags?.event}:${(error as Error).message}`);
        return "";
      },
      captureMessage: (message: string) => {
        sent.push(message);
        return "";
      },
      flush: async () => true,
    },
  };
}

test("crash reports send the same grouping failure at most once a day per post", () => {
  let clock = 0;
  const { sent, sink } = recordingSink();
  const reports = createCrashReporter(sink, () => clock);
  for (let attempt = 0; attempt < 563; attempt++)
    reports.groupingFailed("dc-1", new Error("bad image"));
  reports.groupingFailed("dc-2", new Error("bad image"));
  assert.deepEqual(sent, ["grouping-error:bad image", "grouping-error:bad image"]);
  clock += 24 * 60 * 60_000;
  reports.groupingFailed("dc-1", new Error("bad image"));
  assert.equal(sent.length, 3);
});

test("crash reports throttle job and loop failures hourly by job kind", () => {
  let clock = 0;
  const { sent, sink } = recordingSink();
  const reports = createCrashReporter(sink, () => clock);
  const arca = { type: "collect", board: "translation", source: "arca" } as const;
  const dc = { type: "collect", board: "translation", source: "dc" } as const;
  reports.jobFailed(arca, "blocked");
  reports.jobFailed(arca, "blocked");
  reports.jobFailed(dc, "blocked");
  reports.loopFailed(new Error("fetch failed"));
  reports.loopFailed(new Error("fetch failed"));
  assert.equal(sent.length, 3);
  clock += 60 * 60_000;
  reports.jobFailed(arca, "blocked");
  reports.loopFailed(new Error("fetch failed"));
  assert.equal(sent.length, 5);
});

test("fatal crash reports without a state file are not throttled and wait for delivery", async () => {
  const { sent, sink } = recordingSink();
  let flushed = 0;
  const reports = createCrashReporter({
    ...sink,
    flush: async () => {
      flushed++;
      return true;
    },
  });
  await reports.fatal(new Error("getaddrinfo EAI_AGAIN"));
  await reports.fatal(new Error("getaddrinfo EAI_AGAIN"));
  assert.equal(sent.length, 2);
  assert.equal(flushed, 2);
});

test("fatal crash reports send the same startup failure once an hour across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crash-reports-"));
  try {
    const file = join(directory, "state.json");
    let clock = 0;
    const { sent, sink } = recordingSink();
    const dns = () =>
      new TypeError("fetch failed", { cause: new Error("getaddrinfo EAI_AGAIN db") });
    // PM2 재시작마다 새 프로세스가 reporter를 새로 만든다.
    for (let restart = 0; restart < 360; restart++) {
      await createCrashReporter(sink, () => clock, file).fatal(dns());
      clock += 10_000;
    }
    assert.equal(sent.length, 1);
    await createCrashReporter(sink, () => clock, file).fatal(new Error("JEV_KEY를 설정하세요."));
    assert.equal(sent.length, 2);
    clock += 1;
    await createCrashReporter(sink, () => clock, file).fatal(dns());
    assert.equal(sent.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fatal crash reports are still sent when the state file is unusable", async () => {
  const { sent, sink } = recordingSink();
  const reports = createCrashReporter(sink, Date.now, "/nonexistent/dir/state.json");
  await reports.fatal(new Error("boom"));
  await reports.fatal(new Error("boom"));
  assert.equal(sent.length, 2);
});
