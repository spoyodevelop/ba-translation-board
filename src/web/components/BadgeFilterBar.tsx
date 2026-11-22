import styled from "@emotion/styled";
import type { Badge } from "../badges";
import { colors } from "../theme";

type Props = {
  badge: Badge;
  onClear: () => void;
};

// 뱃지 하나로 거른 목록을 보고 있다는 것을 알리고 풀 수 있게 한다.
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

// 작가 필터 줄과 같은 모양으로 둔다.
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
