// crashReports.ts가 나중에 불러오는 모듈이다. 필요한 함수만 이름으로 가져와야
// 번들러가 리플레이·피드백 같은 쓰지 않는 기능을 지연 로딩 청크에서 뺄 수 있다.
export { captureException, init } from "@sentry/react";
