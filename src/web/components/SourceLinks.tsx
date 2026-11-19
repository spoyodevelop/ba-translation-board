import styled from "@emotion/styled";
import { sources } from "../config";
import { siteAddresses } from "../../shared/sites.ts";
import type { BoardConfig } from "../../shared/boards.ts";
import { colors } from "../theme";

export function SourceLinks({ board }: { board: BoardConfig }) {
  return (
    <Links aria-label="원본 게시판">
      {Object.entries(sources).map(([key, source]) => (
        <SourceLink
          key={key}
          href={siteAddresses[key as keyof typeof siteAddresses].listUrl(board).href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {source.label} {board.label} 게시판 ↗
        </SourceLink>
      ))}
    </Links>
  );
}

const Links = styled.nav`
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 32px 0;
`;

const SourceLink = styled.a`
  padding: 11px 15px;
  border: 1px solid ${colors.border};
  border-radius: 10px;
  background: ${colors.surface};
  color: ${colors.text};
  font-size: 14px;
  text-decoration: none;

  &:hover {
    border-color: ${colors.disabled};
    background: ${colors.surfaceRaised};
    color: ${colors.textStrong};
  }
`;
