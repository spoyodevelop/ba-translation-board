interface ImportMetaEnv {
  // Sentry 클라이언트 키(DSN)는 브라우저에 공개되는 값이다. Vercel의 Production 환경에만 설정한다.
  readonly VITE_SENTRY_DSN?: string;
}
