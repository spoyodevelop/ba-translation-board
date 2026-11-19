import { createClient } from "@libsql/client";

export function openTursoDatabase(config: { url: string; authToken?: string }) {
  const url = new URL(config.url);
  const local = url.protocol === "file:";
  if (!local && !["libsql:", "https:"].includes(url.protocol))
    throw new Error("DB URL은 file:, libsql: 또는 https: 형식이어야 합니다.");
  if (!local && !config.authToken)
    throw new Error("원격 Turso DB에는 인증 토큰이 필요합니다.");
  return createClient(config);
}

export function openTursoDatabaseFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const url = env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL을 설정하세요.");
  return openTursoDatabase({ url, authToken: env.TURSO_AUTH_TOKEN });
}
