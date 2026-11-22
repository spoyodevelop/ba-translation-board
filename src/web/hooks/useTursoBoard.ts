import { useEffect, useState } from "react";
import type { BoardSnapshot } from "../../database/boardSnapshot";
import { createBoardClient } from "../boardClient.ts";
import type { Board } from "../../shared/boards.ts";

// 서버 응답은 CDN에 5분 캐시되므로 더 자주 받아도 같은 목록을 다시 내려받을 뿐이다.
// 다른 탭에 있다 돌아오면 간격과 상관없이 바로 다시 받는다.
const boardRefreshIntervalMs = 5 * 60_000;

const emptySnapshot: BoardSnapshot = {
  posts: [],
  automaticEdges: [],
  artists: [],
  updatedAt: null,
};

export function useTursoBoard(board: Board) {
  const [snapshot, setSnapshot] = useState<BoardSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // 다른 탭의 목록이 잠깐이라도 이 탭 글처럼 보이지 않게 비우고 다시 불러온다.
    setSnapshot(emptySnapshot);
    setLoading(true);
    setError(null);
    let active = true;
    let inFlight = false;
    const client = createBoardClient();
    async function refresh() {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const next = await client.load(board);
        if (active) {
          setSnapshot(next);
          setError(null);
        }
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    }
    void refresh();
    const timer = window.setInterval(
      () => void refresh(),
      boardRefreshIntervalMs,
    );
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [board]);
  return { snapshot, loading, error };
}
