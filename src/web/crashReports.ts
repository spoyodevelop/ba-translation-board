// 화면이 멈춘 원인만 받는다. GA와 같은 원칙으로 누가 무엇을 읽었는지는 보내지 않는다.
// 브레드크럼(클릭·이동한 주소·콘솔), 세션 추적, 리플레이, 성능 추적은 모두 끈다.
const excludedIntegrations = ["Breadcrumbs", "Console", "BrowserSession"];

type Sentry = typeof import("./sentryClient.ts");

export type ClientCrashReporter = {
  renderFailed(error: Error, componentStack: string | null | undefined): void;
};

const noClientCrashReports: ClientCrashReporter = { renderFailed() {} };

function initSentry(sentry: Sentry, dsn: string) {
  sentry.init({
    dsn,
    environment: "production",
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    integrations: (defaults) =>
      defaults.filter(
        (integration) => !excludedIntegrations.includes(integration.name),
      ),
    beforeBreadcrumb: () => null,
    // 확장 프로그램 코드에서 난 오류는 이 사이트가 고칠 수 없다.
    denyUrls: [
      /^chrome-extension:\/\//,
      /^moz-extension:\/\//,
      /^safari-web-extension:\/\//,
    ],
  });
}

export function startClientCrashReports(): ClientCrashReporter {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  // 로컬 개발 중 오류가 운영 보고에 섞이지 않게 한다. Preview 제외는 Vercel 환경 변수 범위로 정한다.
  if (!dsn || import.meta.env.DEV) return noClientCrashReports;

  // SDK는 gzip 약 32KB라 첫 화면과 함께 받지 않고 페이지가 뜬 뒤 불러온다.
  // 그 전에 경계에서 잡은 렌더링 오류는 모아 두었다가 보낸다. 전역 오류는 불러온 뒤부터 받는다.
  let sentry: Sentry | null = null;
  const pending: Parameters<ClientCrashReporter["renderFailed"]>[] = [];
  function send(...[error, componentStack]: (typeof pending)[number]) {
    sentry?.captureException(error, {
      contexts: { react: { componentStack: componentStack || "" } },
      tags: { event: "render-error" },
    });
  }
  function load() {
    import("./sentryClient.ts")
      .then((loaded) => {
        initSentry(loaded, dsn!);
        sentry = loaded;
        for (const report of pending.splice(0)) send(...report);
      })
      .catch(() => {
        // 광고 차단기가 Sentry를 막으면 보고 없이 사이트만 계속 동작한다.
      });
  }
  if (document.readyState === "complete") load();
  else window.addEventListener("load", load, { once: true });

  return {
    renderFailed(error, componentStack) {
      if (!sentry) {
        pending.push([error, componentStack]);
        return;
      }
      send(error, componentStack);
    },
  };
}
