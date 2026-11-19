import styled from "@emotion/styled";
import type { MouseEvent } from "react";
import { boardConfigs } from "../../shared/boards.ts";
import type { Board } from "../../shared/boards.ts";
import { searchForBoard } from "../hooks/useBoardTab.ts";
import { colors } from "../theme";

// 새 탭으로 열기와 링크 복사가 되도록 탭을 링크로 둔다. 같은 창에서 누르면 다시 불러오지 않고 바꾼다.
export function BoardTabs({
  board,
  onSelect,
}: {
  board: Board;
  onSelect: (board: Board) => void;
}) {
  return (
    <Tabs aria-label="게시판 탭">
      {Object.values(boardConfigs).map((config) => {
        const selected = config.board === board;
        const href = `/${searchForBoard("", config.board)}`;
        const select = (event: MouseEvent<HTMLAnchorElement>) => {
          const opensElsewhere =
            event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0;
          if (opensElsewhere) return;
          event.preventDefault();
          onSelect(config.board);
        };
        return (
          <Tab
            key={config.board}
            href={href}
            onClick={select}
            aria-current={selected ? "page" : undefined}
            $selected={selected}
          >
            {config.label}
          </Tab>
        );
      })}
    </Tabs>
  );
}

const Tabs = styled.nav`
  display: inline-flex;
  gap: 4px;
  margin-top: 20px;
  padding: 4px;
  border: 1px solid ${colors.border};
  border-radius: 12px;
  background: ${colors.surface};
`;

const Tab = styled.a<{ $selected: boolean }>`
  min-width: 72px;
  padding: 8px 16px;
  border-radius: 8px;
  background: ${({ $selected }) => ($selected ? colors.button : "transparent")};
  color: ${({ $selected }) => ($selected ? colors.textStrong : colors.textMuted)};
  font-size: 15px;
  font-weight: ${({ $selected }) => ($selected ? 700 : 500)};
  text-align: center;
  text-decoration: none;

  &:hover {
    color: ${colors.textStrong};
  }

  &:focus-visible {
    outline: 2px solid ${colors.accent};
    outline-offset: 2px;
  }
`;
