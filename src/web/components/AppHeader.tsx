import styled from "@emotion/styled";
import { colors } from "../theme";
import type { BoardConfig } from "../../shared/boards.ts";

export function AppHeader({ board }: { board: BoardConfig }) {
  return (
    <header>
      <Eyebrow>{board.eyebrow}</Eyebrow>
      <Title>블아 {board.label} 탭 모아보기</Title>
      <FeedbackLink
        href="https://docs.google.com/forms/d/e/1FAIpQLSftlkmTksHwXPbK2RoSLwCRtPJXwMLnxS_fE62yh7EByvEH5Q/viewform"
        target="_blank"
        rel="noopener noreferrer"
      >
        피드백 보내기 ↗
      </FeedbackLink>
    </header>
  );
}

const FeedbackLink = styled.a`
  display: inline-block;
  margin-top: 12px;
  color: ${colors.accent};
  font-size: 14px;
  text-underline-offset: 4px;

  &:hover {
    color: ${colors.textStrong};
  }

  &:focus-visible {
    outline: 2px solid ${colors.accent};
    outline-offset: 4px;
    border-radius: 2px;
  }
`;

const Eyebrow = styled.div`
  color: ${colors.accent};
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.16em;
`;

const Title = styled.h1`
  margin: 14px 0 10px;
  font-size: clamp(32px, 5vw, 48px);
  letter-spacing: -0.04em;
  color: ${colors.textStrong};
`;
