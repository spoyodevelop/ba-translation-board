# 번역 모아보기

아카라이브 블루아카이브 번역 카테고리와 디시인사이드 projectmx 번역 말머리를 한 목록으로 보여줍니다.

- 집의 LXC에서 아카·디시는 10분마다 수집하고, 아카는 Chrome 웹소켓 새 글 알림 때도 수집하여 본문 출처 ID를 먼저 판정하고, 출처가 없는 글만 Jev 제목 판정(0.95 이상)·이미지 해시로 보완합니다.
- 글, 자동 연결 근거, 출처·이미지 해시 캐시와 작업 상태는 Turso에 저장합니다. 이미지 파일은 저장하지 않습니다.
- 웹 클라이언트는 Vercel의 `GET /api/board`로 목록을 조회하며 25묶음씩 표시합니다.
- 방문 기록과 팔로우한 원작 작가는 현재 브라우저의 localStorage에 저장합니다.
- 수집·과거 글 재검사는 worker CLI로 요청합니다. 외부 작업 요청 API는 없습니다.

## 웹 실행

Node.js 22.12 이상이 필요합니다. `.env.client.local`에 DB 주소와 **읽기 전용** 토큰을 설정합니다.

```env
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_READ_TOKEN=your-read-only-token
```

```sh
npm ci
npm run dev
npm run build
```

빌드 결과는 `dist`에 저장됩니다. Vercel은 `vercel.json`의 설정과 위 두 서버 환경 변수를 사용합니다.

## Worker 실행

worker 환경의 `.env.local`에는 `TURSO_DATABASE_URL`, 쓰기용 `TURSO_AUTH_TOKEN`, `JEV_KEY`, `ARCA_CHROME_EXECUTABLE`을 설정합니다. LXC에는 일반 Chrome과 Xvfb가 필요합니다. 쓰기 토큰을 `VITE_` 환경 변수에 넣지 않습니다.

```sh
npm run turso:migrate
npm run worker -- run
npm run worker -- collect
npm run worker -- backfill 50
npm run worker -- status
```

`collect`와 `backfill`은 DB 대기열에 작업을 등록합니다. 실행 중인 worker가 처리하며, 중단된 작업은 소유권 만료 후 복구합니다. 상시 실행은 `pm2 start ecosystem.config.cjs`로 관리합니다.

기존 JSON 이관은 완료되어 일회성 이관 도구와 임시 SQLite 호환 저장소를 제거했습니다. DB 스키마는 버전 8을 한 번에 만드는 정의로 합쳤고, 1~8의 단계별 변경은 Git 이력에 있습니다. 버전 8보다 오래된 DB는 지원하지 않습니다. 확장·로컬 미러 코드도 제거했습니다. 과거 구현은 Git 이력에 남아 있습니다.

## 검증

```sh
npm test
npm run build
npm run test:live
```

`test:live`는 임시 DB와 실제 worker 수집기로 아카·디시의 목록·본문·본문 이미지 해시를 검사합니다. 아카는 `ARCA_CHROME_EXECUTABLE` 환경 변수로 지정한 Chrome을 사용하며, 설정하지 않으면 아카 진단을 생략합니다. 실제 사이트에 요청하므로 기본 `npm test`와 분리되어 있습니다. 최신 3개 글에 본문 이미지가 없으면 이미지 검증만 생략합니다. 나머지 테스트는 임시 DB와 고정 입력을 사용합니다.

주요 코드는 `src/worker`(수집·판정·작업 실행), `src/database`(Turso 저장·조회), `src/web`(목록·개인 판정), `src/sources`(본문 출처와 이미지 비교), `src/grouping`(후보 선정과 묶음), `src/arca`·`src/dc`(목록 파서)에 있습니다.
