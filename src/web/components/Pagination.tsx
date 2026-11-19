import styled from "@emotion/styled";
import { colors } from "../theme";

type Props = {
  currentPage: number;
  totalPages: number;
  bottom?: boolean;
  onPageChange: (page: number) => void;
};

export function Pagination({
  currentPage,
  totalPages,
  bottom,
  onPageChange,
}: Props) {
  return (
    <Navigation $bottom={bottom} aria-label="게시물 페이지">
      <PageButton
        type="button"
        disabled={currentPage === 1}
        onClick={() => onPageChange(currentPage - 1)}
      >
        이전
      </PageButton>
      <span aria-live="polite">
        {currentPage} / {totalPages} 페이지
      </span>
      <PageButton
        type="button"
        disabled={currentPage === totalPages}
        onClick={() => onPageChange(currentPage + 1)}
      >
        다음
      </PageButton>
    </Navigation>
  );
}

const Navigation = styled.nav<{ $bottom?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: ${({ $bottom }) =>
    $bottom ? 0 : `1px solid ${colors.borderSoft}`};
  border-top: ${({ $bottom }) =>
    $bottom ? `1px solid ${colors.borderSoft}` : 0};
  color: ${colors.textMuted};
  font-size: 13px;
`;

const PageButton = styled.button`
  padding: 6px 12px;
  border: 1px solid ${colors.border};
  border-radius: 7px;
  background: ${colors.button};
  color: ${colors.text};
  cursor: pointer;
  font: inherit;

  &:disabled {
    color: ${colors.disabled};
    background: ${colors.surface};
    cursor: default;
  }

  &:not(:disabled):hover {
    background: ${colors.buttonHover};
  }
`;
