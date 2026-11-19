import { randomUUID } from "node:crypto";
import { parse } from "node-html-parser";
import type { Post } from "../shared/post.ts";
import { siteAddresses } from "../shared/sites.ts";
import type { BoardConfig } from "../shared/boards.ts";
import {
  httpError,
  isBlockedPage,
  SourceRequestError,
} from "../sources/requestError.ts";
import { openChromeSession } from "./chromeSession.ts";
import type { WorkerLog } from "./log.ts";
import { describeError } from "./describeError.ts";

const browserReadyTimeoutMs = 45_000;
const browserRequestTimeoutMs = 15_000;

type BrowserWindow = typeof globalThis & {
  ArcaSocket?: WebSocket;
  arcaRequests?: Record<string, AbortController>;
};

export async function startArcaBrowser(deps: {
  executablePath: string;
  // 브라우저를 처음 띄울 목록이다. 이 목록의 첫 페이지는 첫 수집에 재사용한다.
  initialBoard: BoardConfig;
  profileDirectory?: string;
  signal?: AbortSignal;
  onNewArticles: () => void;
  onExit: () => void;
  log: WorkerLog;
}) {
  const session = await openChromeSession(deps);
  const stop = () => {
    void session
      .close()
      .catch((error) =>
        deps.log({
          event: "arca-browser-close-error",
          error: describeError(error),
        }),
      );
  };
  deps.signal?.addEventListener("abort", stop, { once: true });
  async function close() {
    deps.signal?.removeEventListener("abort", stop);
    await session.close();
  }
  try {
    deps.signal?.throwIfAborted();
    const pages = await session.browser.pages();
    const page = pages[0] || (await session.browser.newPage());
    // 복원된 탭이 뒤로 밀리면 사이트가 웹소켓 재연결을 멈춘다.
    for (const other of pages.slice(1)) await other.close();
    await page.bringToFront();
    const cdp = await page.createCDPSession();
    const socketIds = new Set<string>();
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
      if (url === "wss://arca.live/arcalive") socketIds.add(requestId);
    });
    cdp.on("Network.webSocketHandshakeResponseReceived", (event) => {
      if (!socketIds.has(event.requestId)) return;
      if (event.response.status !== 101) return;
      deps.log({ event: "arca-socket-connected" });
      // 연결이 끊긴 사이의 글도 다음 수집에서 보충한다.
      deps.onNewArticles();
    });
    cdp.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
      if (!socketIds.has(requestId)) return;
      if (response.payloadData.split("|")[0] !== "na") return;
      deps.log({ event: "arca-new-article" });
      deps.onNewArticles();
    });
    cdp.on("Network.webSocketClosed", ({ requestId }) => {
      socketIds.delete(requestId);
    });
    cdp.on("Network.webSocketFrameError", ({ requestId, errorMessage }) => {
      if (socketIds.has(requestId))
        deps.log({ event: "arca-socket-error", error: errorMessage });
    });
    const initialListUrl = siteAddresses.arca.listUrl(deps.initialBoard);
    await page.goto(initialListUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: browserReadyTimeoutMs,
    });
    await page.waitForFunction(
      () =>
        !!document.querySelector("a.vrow") &&
        (globalThis as BrowserWindow).ArcaSocket?.readyState === 1,
      { timeout: browserReadyTimeoutMs, polling: 200, signal: deps.signal },
    );
    // 시작할 때 이미 읽은 목록을 첫 수집에 재사용한다.
    let initialListing: string | null = await page.content();
    deps.log({ event: "arca-browser-ready" });

    const request: typeof fetch = async (input, init) => {
      const original = new Request(input, init);
      const url = new URL(original.url);
      if (url.origin !== "https://arca.live" || original.method !== "GET")
        throw new Error("아카 브라우저는 아카 GET 요청만 처리합니다.");
      original.signal.throwIfAborted();
      const firstListing =
        url.pathname === initialListUrl.pathname &&
        url.searchParams.get("category") === deps.initialBoard.arcaCategory &&
        (url.searchParams.get("p") || "1") === "1";
      if (firstListing && initialListing !== null) {
        const html = initialListing;
        initialListing = null;
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      }
      const key = randomUUID();
      const abort = () => {
        void page
          .evaluate(
            (id) => (globalThis as BrowserWindow).arcaRequests?.[id]?.abort(),
            key,
          )
          .catch(() => {});
      };
      original.signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await page.evaluate(
          async (href, id, timeoutMs) => {
            const requests = ((globalThis as BrowserWindow).arcaRequests ||=
              {});
            const controller = new AbortController();
            requests[id] = controller;
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            try {
              const response = await fetch(href, {
                credentials: "same-origin",
                signal: controller.signal,
              });
              return {
                status: response.status,
                headers: [...response.headers.entries()],
                body: await response.text(),
              };
            } finally {
              clearTimeout(timeout);
              delete requests[id];
            }
          },
          url.href,
          key,
          browserRequestTimeoutMs,
        );
        original.signal.throwIfAborted();
        return new Response(result.body, {
          status: result.status,
          headers: result.headers,
        });
      } finally {
        original.signal.removeEventListener("abort", abort);
      }
    };

    async function fetchBody(post: Post, signal: AbortSignal) {
      if (post.source !== "arca" || !/^\d+$/.test(post.sourceId))
        throw new Error("아카 글 번호가 필요합니다.");
      const response = await request(
        siteAddresses.arca.postUrl(post.sourceId),
        { signal },
      );
      if (!response.ok) throw httpError("아카 본문 요청 실패", response);
      const html = await response.text();
      if (isBlockedPage(html))
        throw new SourceRequestError(
          "아카 본문에서 차단 안내를 받았습니다.",
          "blocked",
          response.status,
        );
      const body = parse(html).querySelector(".article-content");
      if (!body)
        throw new SourceRequestError(
          "아카 글 페이지에 본문이 없습니다.",
          "missing-body",
          response.status,
        );
      return body.innerHTML;
    }

    return { request, fetchBody, close };
  } catch (error) {
    await close();
    throw error;
  }
}
