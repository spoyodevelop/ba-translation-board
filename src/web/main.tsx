import React from "react";
import ReactDOM from "react-dom/client";
import { GlobalStyles } from "./GlobalStyles";
import { TursoBoard } from "./TursoBoard";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { startClientCrashReports } from "./crashReports.ts";

// 렌더링보다 먼저 시작해야 첫 화면을 그리는 중의 오류도 받는다.
const crashReports = startClientCrashReports();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <GlobalStyles />
    <AppErrorBoundary onError={crashReports.renderFailed}>
      <TursoBoard />
    </AppErrorBoundary>
  </React.StrictMode>,
);
