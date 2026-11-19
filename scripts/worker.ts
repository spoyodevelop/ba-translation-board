import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import type { Client } from "@libsql/client";
import type { Source } from "../src/shared/post.ts";
import { openTursoDatabaseFromEnv } from "../src/database/connection.ts";
import { migrateTursoDatabase } from "../src/database/schema.ts";
import {
  createJobRepository,
  maxBackfillRequestCount,
} from "../src/database/jobs.ts";
import { createWorkerStateRepository } from "../src/database/state.ts";
import { createWorkerRuntime } from "../src/worker/runtime.ts";
import { createJevTitleEvaluator } from "../src/grouping/evaluateWithJev.ts";
import type { WorkerLog } from "../src/worker/log.ts";
import { startArcaBrowser } from "../src/worker/arcaBrowser.ts";
import { boardConfigs } from "../src/shared/boards.ts";
import { isSource } from "../src/shared/sites.ts";
import type { Board } from "../src/shared/boards.ts";
import type { AliasStore } from "../src/grouping/creativeAuthors.ts";
import { describeError } from "../src/worker/describeError.ts";
import { noCrashReports, startCrashReports } from "../src/worker/crashReports.ts";
import type { CrashReporter } from "../src/worker/crashReports.ts";

const defaultBackfillCount = 50;
const idlePollIntervalMs = 5000;
const healthcheckTimeoutMs = 5000;

const help =
  `사용법: worker run | run-once | collect [all|arca|dc] [translation|creative] | backfill [1~${maxBackfillRequestCount}] [translation|creative] | status\n` +
  "  run의 수집 board는 WORKER_BOARDS(쉼표 구분, 기본 translation)로 정한다.";

type WorkerCommand =
  | { type: "run" }
  | { type: "run-once" }
  | { type: "collect"; board: Board; source: Source | "all" }
  | { type: "backfill"; board: Board; limit: number }
  | { type: "status" };

function parseBoard(value: string | undefined): Board {
  const board = value || "translation";
  if (!(board in boardConfigs)) throw new Error(help);
  return board as Board;
}

// 창작 수집은 운영에서 명시적으로 켤 때까지 일정에 올리지 않는다.
function boardsFromEnv(value: string | undefined): Board[] {
  const names = (value || "translation").split(",").map((name) => name.trim());
  return [...new Set(names.filter(Boolean).map(parseBoard))];
}

// 별칭 파일은 git에 넣지 않고 운영 서버에만 둔다. 경로를 정하지 않으면 별칭 없이 닉네임·아이디로만 판정한다.
async function loadCreativeAliases(): Promise<AliasStore> {
  const file = process.env.CREATIVE_AUTHOR_ALIASES_FILE?.trim();
  if (!file) return { aliases: [], rejected: [] };
  return JSON.parse(await readFile(file, "utf8")) as AliasStore;
}

// board·사이트마다 Healthchecks 감시를 따로 둔다. 주소를 정하지 않은 감시는 ping을 보내지 않는다.
function createHealthcheckPinger(env: NodeJS.ProcessEnv) {
  // 번역 주소의 이름은 창작 감시를 더하기 전과 같게 두어 운영 서버 설정을 그대로 쓴다.
  const urls: Record<Board, Record<Source, string | undefined>> = {
    translation: {
      arca: env.HEALTHCHECKS_ARCA_PING_URL,
      dc: env.HEALTHCHECKS_DC_PING_URL,
    },
    creative: {
      arca: env.HEALTHCHECKS_CREATIVE_ARCA_PING_URL,
      dc: env.HEALTHCHECKS_CREATIVE_DC_PING_URL,
    },
  };
  return async (board: Board, source: Source, signal: AbortSignal) => {
    const url = urls[board][source]?.trim();
    if (!url) return;
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(healthcheckTimeoutMs)]),
    });
    await response.body?.cancel();
    if (!response.ok)
      throw new Error(`Healthchecks ping: HTTP ${response.status}`);
  };
}

function parseWorkerCommand(args: string[]): WorkerCommand {
  const [command, argument, boardArgument, ...extra] = args;
  if (extra.length > 0) throw new Error(help);

  switch (command) {
    case "run":
    case "run-once":
    case "status":
      if (argument !== undefined || boardArgument !== undefined)
        throw new Error(help);
      return { type: command };
    case "collect": {
      const source = argument || "all";
      const validSource =
        source === "all" || isSource(source);
      if (!validSource) throw new Error(help);
      return { type: command, board: parseBoard(boardArgument), source };
    }
    case "backfill": {
      const limit = Number(argument || defaultBackfillCount);
      const validLimit =
        Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= maxBackfillRequestCount;
      if (!validLimit) throw new Error(help);
      return { type: command, board: parseBoard(boardArgument), limit };
    }
    default:
      throw new Error(help);
  }
}

async function runWorkerLoop(
  runtime: ReturnType<typeof createWorkerRuntime>,
  signal: AbortSignal,
  crashReports: CrashReporter,
) {
  while (!signal.aborted) {
    try {
      await runtime.schedule();
      if (await runtime.runOne(signal)) continue;
    } catch (error) {
      if (signal.aborted) break;
      crashReports.loopFailed(error);
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          event: "worker-error",
          error: describeError(error),
        }),
      );
    }
    await pause(idlePollIntervalMs, undefined, { signal });
  }
}

async function executeWorkerCommand(
  command: WorkerCommand,
  client: Client,
  signal: AbortSignal,
  stop: () => void,
  crashReports: CrashReporter,
) {
  switch (command.type) {
    case "collect":
    case "backfill": {
      const job = await createJobRepository(client).enqueue(command, Date.now());
      console.log(
        JSON.stringify({
          jobId: job.id,
          state: job.state,
          request: job.request,
        }),
      );
      return;
    }
    case "status": {
      console.log(
        JSON.stringify(
          {
            collection: await createWorkerStateRepository(client).list(),
            jobs: await createJobRepository(client).list(),
          },
          null,
          2,
        ),
      );
      return;
    }
    case "run-once":
    case "run":
      await runWithBrowser(command.type, client, signal, stop, crashReports);
      return;
  }
}

async function runWithBrowser(
  command: "run" | "run-once",
  client: Client,
  signal: AbortSignal,
  stop: () => void,
  crashReports: CrashReporter,
) {
  // 키가 없으면 Chrome을 띄우기 전에 멈춘다.
  const evaluateTitles = createJevTitleEvaluator(process.env.JEV_KEY?.trim() ?? "");
  const executablePath = process.env.ARCA_CHROME_EXECUTABLE;
  if (!executablePath) throw new Error("ARCA_CHROME_EXECUTABLE을 설정하세요.");
  const log: WorkerLog = (event) =>
    console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
  let runtime: ReturnType<typeof createWorkerRuntime> | undefined;
  let browserExited = false;
  const arca = await startArcaBrowser({
    executablePath,
    initialBoard: boardConfigs.translation,
    profileDirectory: process.env.ARCA_CHROME_PROFILE_DIR,
    signal,
    onNewArticles: () => runtime?.requestArcaCollection(),
    onExit: () => {
      browserExited = true;
      log({ event: "arca-browser-exited" });
      stop();
    },
    log,
  });
  try {
    signal.throwIfAborted();
    runtime = createWorkerRuntime({
      client,
      boards: boardsFromEnv(process.env.WORKER_BOARDS),
      loadCreativeAliases,
      arca,
      log,
      evaluateTitles,
      crashReports,
      reportCollectionSuccess: createHealthcheckPinger(process.env),
    });
    // 시작 중 받은 알림과 재시작 사이의 새 글을 한 번에 보충한다.
    runtime.requestArcaCollection();
    if (command === "run-once") await runtime.runOne(signal);
    else await runWorkerLoop(runtime, signal, crashReports);
  } finally {
    await arca.close();
    if (browserExited) process.exitCode = 1;
  }
}

async function main(command: WorkerCommand, crashReports: CrashReporter) {
  const client = openTursoDatabaseFromEnv(process.env);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  try {
    await migrateTursoDatabase(client);
    await executeWorkerCommand(
      command,
      client,
      controller.signal,
      () => controller.abort(),
      crashReports,
    );
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    client.close();
  }
  // 외부 연결이 남아 있어도 브라우저·DB 정리가 끝나면 종료한다.
  if (controller.signal.aborted) process.exit(process.exitCode || 0);
}

// 설정 오류(DB 주소·토큰 누락 등)도 보고하도록 DB를 열기 전에 시작한다.
let crashReports = noCrashReports;
try {
  const command = parseWorkerCommand(process.argv.slice(2));
  // 상주 worker만 보고한다. 작업 등록·상태 조회 명령의 오류는 실행한 사람이 바로 본다.
  const runsWorker = command.type === "run" || command.type === "run-once";
  if (runsWorker) crashReports = startCrashReports(process.env);
  await main(command, crashReports);
} catch (error) {
  await crashReports.fatal(error);
  console.error(error);
  process.exit(1);
}
