import styled from "@emotion/styled";
import type { Badge } from "../badges";
import { colors } from "../theme";

type Props = {
  badge: Badge;
  onClear: () => void;
};

export function BadgeFilterBar({ badge, onClear }: Props) {
  return (
    <Bar>
      <span>
        <strong>{badge.name}</strong> 글만 보는 중
      </span>
      <button type="button" onClick={onClear}>
        전체 보기
      </button>
    </Bar>
  );
}

const Bar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 24px;
  border-bottom: 1px solid ${colors.border};
  background: ${colors.surfaceRaised};
  color: ${colors.textMuted};
  font-size: 14px;

  strong {
    color: ${colors.textStrong};
  }
  button {
    flex: none;
    padding: 6px 10px;
    border: 1px solid ${colors.border};
    border-radius: 6px;
    background: ${colors.button};
    color: ${colors.textStrong};
    font: inherit;
    cursor: pointer;
  }

  @media (max-width: 560px) {
    padding: 10px 16px;
  }
`;
