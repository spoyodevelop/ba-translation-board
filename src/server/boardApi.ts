import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@libsql/client/web";
import { createBoardSnapshotReader } from "../database/boardSnapshot.ts";
import type { BoardSnapshot } from "../database/boardSnapshot.ts";
import { boardConfigs, legacyBoard } from "../shared/boards.ts";
import type { Board } from "../shared/boards.ts";

// board를 붙이기 전의 주소(/api/board)는 기존 board를 읽는다. 이미 열린 화면과 CDN 캐시를 위해 그대로 둔다.
// CDN은 쿼리 문자열 전체를 캐시 키로 쓰므로, 덧붙인 파라미터나 다른 인코딩을 받아주면
// 요청마다 캐시를 비켜 전체 글을 다시 읽게 된다. 웹이 보내는 주소와 글자 그대로 같을 때만 읽는다.
function boardFromRequest(request: IncomingMessage): Board | null {
  const search = new URL(request.url || "/", "http://localhost").search;
  if (search === "") return legacyBoard;
  const board = new URLSearchParams(search).get("board");
  if (board === null || !Object.hasOwn(boardConfigs, board)) return null;
  if (search !== `?board=${board}`) return null;
  return board as Board;
}

// 워커가 보드마다 10분 간격으로 수집하므로, 새 글이 최대 5분 늦게 보이는 대신 DB 읽기를 줄인다.
// 만료 뒤에는 기존 응답을 먼저 주고 뒤에서 갱신해 방문자가 쿼리를 기다리지 않게 한다.
const boardCdnCacheTtlSeconds = 300;
const boardCdnStaleSeconds = 600;

export function createBoardApi(reader: {
  load(board: Board): Promise<BoardSnapshot>;
}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "GET 요청만 지원합니다." }));
      return;
    }
    const board = boardFromRequest(request);
    if (!board) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "알 수 없는 탭입니다." }));
      return;
    }
    try {
      const snapshot = await reader.load(board);
      // Personal state stays in the browser, so every visitor can share this response.
      response.setHeader(
        "Vercel-CDN-Cache-Control",
        `public, s-maxage=${boardCdnCacheTtlSeconds}, stale-while-revalidate=${boardCdnStaleSeconds}`,
      );
      response.end(JSON.stringify(snapshot));
    } catch (cause) {
      console.error("Board snapshot query failed", cause);
      response.statusCode = 503;
      response.end(
        JSON.stringify({
          error: "목록을 불러오지 못했습니다. 잠시 후 다시 시도하세요.",
        }),
      );
    }
  };
}

export function createBoardApiFromEnv(env: NodeJS.ProcessEnv) {
  let reader: ReturnType<typeof createBoardSnapshotReader> | undefined;
  return createBoardApi({
    async load(board) {
      if (!reader) {
        const url = env.TURSO_DATABASE_URL;
        const authToken = env.TURSO_READ_TOKEN;
        if (!url || !authToken)
          throw new Error(
            "TURSO_DATABASE_URL과 TURSO_READ_TOKEN을 설정하세요.",
          );
        if (!["libsql:", "https:"].includes(new URL(url).protocol))
          throw new Error("원격 DB 주소가 필요합니다.");
        const claims = JSON.parse(
          Buffer.from(authToken.split(".")[1], "base64url").toString(),
        ) as { a?: string };
        // Catch accidental worker credentials; Turso verifies the signature and enforces permissions.
        if (claims.a !== "ro")
          throw new Error("조회 API에는 읽기 전용 토큰을 설정하세요.");
        reader = createBoardSnapshotReader(createClient({ url, authToken }));
      }
      return reader.load(board);
    },
  });
}
