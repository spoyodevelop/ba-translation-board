import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import puppeteer, { type Browser } from "puppeteer-core";

const browserStartupTimeoutMs = 30_000;
const browserCloseTimeoutMs = 5000;
const virtualScreen = "1280x800x24";

async function availableDebuggingPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("포트 할당 실패");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export async function openChromeSession(deps: {
  executablePath: string;
  profileDirectory?: string;
  onExit: () => void;
}) {
  // Chrome은 root에서 sandbox를 켤 수 없어 --no-sandbox가 필요하다. 광고·사용자 콘텐츠가 섞인
  // 아카 페이지를 렌더링하므로, 렌더러 취약점 하나가 곧 root 장악(DB 쓰기 토큰·쿠키·집 LAN)이
  // 되지 않도록 sandbox 없는 실행은 허용하지 않는다.
  if (process.getuid?.() === 0)
    throw new Error(
      "root로 Chrome을 실행하지 않습니다. 전용 사용자로 worker를 실행하세요.",
    );
  let displayProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let closing = false;
  let closed: Promise<void> | undefined;
  const temporaryProfile = !deps.profileDirectory;
  const profile =
    deps.profileDirectory ||
    (await mkdtemp(join(tmpdir(), "translation-board-chrome-")));

  function close() {
    closing = true;
    closed ||= (async () => {
      // PM2가 Chrome에도 종료 신호를 보내면 CDP 종료 응답이 오지 않을 수 있다.
      const timeout = setTimeout(() => {
        void browser?.disconnect();
      }, browserCloseTimeoutMs);
      try {
        await browser?.close();
      } finally {
        clearTimeout(timeout);
        displayProcess?.kill("SIGTERM");
        if (temporaryProfile)
          await rm(profile, { recursive: true, force: true });
      }
    })();
    return closed;
  }

  try {
    let display = process.env.DISPLAY;
    if (process.platform === "linux" && !display) {
      displayProcess = spawn(
        "Xvfb",
        ["-displayfd", "1", "-screen", "0", virtualScreen, "-nolisten", "tcp"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const child = displayProcess;
      display = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Xvfb 시작 시간이 초과했습니다.")),
          browserStartupTimeoutMs,
        );
        let output = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (!output.includes("\n")) return;
          clearTimeout(timer);
          resolve(`:${Number(output.trim())}`);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Xvfb가 종료됐습니다."));
          if (!closing) deps.onExit();
        });
      });
    }
    const args = [
      `--remote-debugging-port=${await availableDebuggingPort()}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "about:blank",
    ];
    browser = await puppeteer.launch({
      executablePath: deps.executablePath,
      headless: false,
      // 진단에 성공한 일반 Chrome과 같은 실행 옵션을 유지한다.
      ignoreDefaultArgs: true,
      args,
      env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
      timeout: browserStartupTimeoutMs,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    browser.on("disconnected", () => {
      if (!closing) deps.onExit();
    });
    return { browser, close };
  } catch (error) {
    await close();
    throw error;
  }
}
