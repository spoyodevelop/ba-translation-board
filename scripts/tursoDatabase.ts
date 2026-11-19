import { openTursoDatabaseFromEnv } from "../src/database/connection.ts";
import { migrateTursoDatabase } from "../src/database/schema.ts";

const client = openTursoDatabaseFromEnv();
try {
  await migrateTursoDatabase(client);
  console.log("번역 보드 DB 스키마를 준비했습니다.");
} finally {
  client.close();
}
