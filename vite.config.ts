import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/bundler-plugins/vite";
import { createBoardApiFromEnv } from "./src/server/boardApi.ts";

export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, process.cwd(), ""),
    ...process.env,
  };
  const boardApi = createBoardApiFromEnv(env);
  let siteUrl = env.VITE_SITE_URL;
  if (!siteUrl && env.VERCEL_PROJECT_PRODUCTION_URL) {
    siteUrl = `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  // 운영 오류의 스택을 읽을 수 있도록 소스맵을 Sentry에만 올린다. 토큰은 Vercel Production에만 둔다.
  // 업로드 뒤 .map 파일은 지워 배포본에 남기지 않는다. 토큰이 없으면 지금처럼 소스맵 없이 빌드한다.
  const sentryAuthToken = env.SENTRY_AUTH_TOKEN?.trim();
  const uploadsSourceMaps = env.VERCEL_ENV === "production" && Boolean(sentryAuthToken);
  let sourcemap: boolean | "hidden" = false;
  if (uploadsSourceMaps) sourcemap = "hidden";
  return {
    build: { sourcemap },
    plugins: [
      react(),
      {
        name: "google-analytics",
        apply: "build",
        transformIndexHtml() {
          const measurementId = env.VITE_GA_MEASUREMENT_ID?.trim();
          // 미리보기와 로컬 방문이 운영 통계에 섞이지 않도록 한다.
          if (env.VERCEL_ENV !== "production" || !measurementId) return [];
          // GA 관리 화면에서 Google 신호를 켜더라도 광고용 계정 연결과 개인 맞춤 신호는 보내지 않는다.
          // 사이트 하단 안내 문구의 수집 원칙을 코드로 보장한다.
          if (!/^G-[A-Z0-9]+$/.test(measurementId)) {
            throw new Error("VITE_GA_MEASUREMENT_ID must be a GA4 measurement ID (G-...).");
          }
          return [
            {
              tag: "script",
              attrs: {
                async: true,
                src: `https://www.googletagmanager.com/gtag/js?id=${measurementId}`,
              },
              injectTo: "head-prepend",
            },
            {
              tag: "script",
              children: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${measurementId}', { allow_google_signals: false, allow_ad_personalization_signals: false });`,
              injectTo: "head-prepend",
            },
          ];
        },
      },
      {
        name: "social-image-url",
        transformIndexHtml(html) {
          if (!siteUrl) return html;
          const imageUrl = new URL("/og-image.png", siteUrl).href;
          return html.replaceAll('content="/og-image.png"', `content="${imageUrl}"`);
        },
      },
      {
        name: "local-board-api",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url?.split("?")[0] !== "/api/board") return next();
            void boardApi(request, response);
          });
        },
      },
      // 다른 플러그인이 만든 결과까지 포함하도록 마지막에 둔다(Sentry 문서의 순서 요구).
      uploadsSourceMaps &&
        sentryVitePlugin({
          org: "spoyodevelop",
          project: "translation-board-frontend",
          authToken: sentryAuthToken,
          telemetry: false,
          sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
        }),
    ],
  };
});
