import type { BoardSnapshot } from "../database/boardSnapshot";
import type { Board } from "../shared/boards.ts";

export function createBoardClient(request: typeof fetch = fetch) {
  return {
    async load(board: Board): Promise<BoardSnapshot> {
      const response = await request(`/api/board?board=${board}`);
      if (!response.ok)
        throw new Error("목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
      return response.json();
    },
  };
}
