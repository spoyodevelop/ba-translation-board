import { useCallback, useEffect, useState } from "react";
import { boardConfigs, legacyBoard } from "../../shared/boards.ts";
import type { Board } from "../../shared/boards.ts";
import { artistParam } from "./useArtistFilter.ts";

// 탭을 주소에 남겨 새로고침과 공유한 링크가 같은 탭을 연다. 기존 board 탭은 예전 주소(/) 그대로 둔다.
const tabParam = "tab";
const defaultBoard = legacyBoard;

export function boardFromSearch(search: string): Board {
  const value = new URLSearchParams(search).get(tabParam);
  if (value && value in boardConfigs) return value as Board;
  return defaultBoard;
}

export function searchForBoard(search: string, board: Board): string {
  const params = new URLSearchParams(search);
  // 작가는 탭마다 다르므로 탭을 바꾸면 작가 필터를 지운다.
  params.delete(artistParam);
  if (board === defaultBoard) params.delete(tabParam);
  else params.set(tabParam, board);
  const query = params.toString();
  if (!query) return "";
  return `?${query}`;
}

export function useBoardTab() {
  const [board, setBoard] = useState(() =>
    boardFromSearch(window.location.search),
  );
  useEffect(() => {
    const onPopState = () => setBoard(boardFromSearch(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const selectBoard = useCallback((next: Board) => {
    const search = searchForBoard(window.location.search, next);
    if (search !== window.location.search)
      window.history.pushState(null, "", `${window.location.pathname}${search}`);
    setBoard(next);
  }, []);
  return { board, selectBoard };
}
