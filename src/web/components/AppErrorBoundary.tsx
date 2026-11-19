import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import styled from "@emotion/styled";
import { colors } from "../theme";

// 렌더링 중 예외가 나면 React는 루트 전체를 내려 빈 화면만 남긴다. 브라우저 번역 기능이 DOM을
// 바꾸거나, 오래 열어 둔 탭이 배포 뒤 바뀐 응답을 받을 때 실제로 일어날 수 있다.
// 이벤트 핸들러와 비동기 코드의 예외는 여기서 잡히지 않는다.
type Props = {
  children: ReactNode;
  onError: (error: Error, componentStack: string | null | undefined) => void;
};
type State = { failed: boolean };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("화면 렌더링 실패", error, info.componentStack);
    this.props.onError(error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Fallback role="alert">
        <Title>화면을 표시하지 못했어요</Title>
        <Message>
          브라우저 번역 기능이나 확장 프로그램이 켜져 있다면 끄고 다시
          열어 주세요. 문제가 계속되면 잠시 후 다시 접속해 주세요.
        </Message>
        <ReloadButton type="button" onClick={() => window.location.reload()}>
          새로고침
        </ReloadButton>
      </Fallback>
    );
  }
}

const Fallback = styled.main`
  width: min(100%, 860px);
  margin: 0 auto;
  padding: 72px 24px;
  @media (max-width: 560px) {
    padding: 42px 14px;
  }
`;
const Title = styled.h1`
  margin: 0 0 12px;
  color: ${colors.textStrong};
  font-size: 24px;
  letter-spacing: -0.02em;
`;
const Message = styled.p`
  margin: 0 0 20px;
  color: ${colors.textMuted};
  font-size: 14px;
  line-height: 1.6;
`;
const ReloadButton = styled.button`
  padding: 8px 16px;
  border: 1px solid ${colors.border};
  border-radius: 6px;
  color: ${colors.text};
  background: ${colors.button};
  font: inherit;
  font-size: 14px;
  cursor: pointer;

  &:hover {
    background: ${colors.buttonHover};
  }

  &:focus-visible {
    outline: 2px solid ${colors.accent};
    outline-offset: 2px;
  }
`;
