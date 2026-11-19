import type { Client } from "@libsql/client";

// 지원하는 board다. board를 더하려면 CHECK를 바꾸는 새 버전이 필요하다.
const boardList = "'translation', 'creative'";

// 지금 스키마 버전이다. 1~8의 단계별 변경은 git 이력에 있고, 운영 DB는 2026-11-18에 8이 되었다.
// 새 DB는 아래 정의로 한 번에 만들고, 이후 변경은 이 숫자를 올리는 단계로 더한다.
const currentSchemaVersion = 8;

// 컬럼 순서는 단계별 변경을 거친 운영 DB와 같게 둔다. VALUES만 쓰는 INSERT가 이 순서에 기댄다.
const schema = [
  `CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('arca', 'dc')),
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    author TEXT,
    published_at INTEGER NOT NULL,
    view_count INTEGER CHECK (view_count >= 0),
    recommend_count INTEGER CHECK (recommend_count >= 0),
    -- 숫자 갱신 간격을 글마다 기록한다.
    counts_updated_at INTEGER NOT NULL DEFAULT 0,
    -- 처음 수집한 board를 유지한다. 글이 다른 카테고리로 옮겨져도 바꾸지 않는다.
    board TEXT NOT NULL DEFAULT 'translation' CHECK (board IN (${boardList})),
    -- 디시 고정 아이디다. 창작 중복 판정에만 쓰고 조회 API에는 내보내지 않는다. 유동과 아카 글은 없다.
    author_id TEXT,
    UNIQUE(source, source_id),
    CHECK (id = source || '-' || source_id)
  )`,
  // 모든 글 조회가 board부터 거르므로 board를 앞에 둔다.
  "CREATE INDEX posts_by_board_date ON posts(board, published_at DESC, id DESC)",
  "CREATE INDEX posts_by_board_source_date ON posts(board, source, published_at DESC)",
  `CREATE TABLE automatic_matches (
    first_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    second_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    algorithm_version TEXT NOT NULL,
    matched_at INTEGER NOT NULL,
    image_evidence_json TEXT CHECK (image_evidence_json IS NULL OR json_valid(image_evidence_json)),
    title_evidence_json TEXT CHECK (title_evidence_json IS NULL OR json_valid(title_evidence_json)),
    -- 양쪽 글의 board다. 다른 board의 글끼리는 연결하지 않는다.
    board TEXT NOT NULL DEFAULT 'translation' CHECK (board IN (${boardList})),
    -- 창작 판정은 출처·Jev·이미지 대신 작가·작성 시각·제목 유사도를 근거로 남긴다.
    creative_evidence_json TEXT CHECK (creative_evidence_json IS NULL OR json_valid(creative_evidence_json)),
    PRIMARY KEY(first_post_id, second_post_id),
    CHECK (first_post_id < second_post_id)
  )`,
  "CREATE INDEX automatic_matches_second ON automatic_matches(second_post_id)",
  "CREATE INDEX automatic_matches_by_board ON automatic_matches(board, first_post_id, second_post_id)",
  `CREATE TABLE match_sources (
    first_post_id TEXT NOT NULL,
    second_post_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('x', 'pixiv')),
    original_id TEXT NOT NULL,
    PRIMARY KEY(first_post_id, second_post_id, platform, original_id),
    FOREIGN KEY(first_post_id, second_post_id) REFERENCES automatic_matches(first_post_id, second_post_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE jev_title_decisions (
    first_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    second_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    first_title TEXT NOT NULL,
    second_title TEXT NOT NULL,
    probability REAL NOT NULL CHECK (probability >= 0 AND probability <= 1),
    model TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    evaluated_at INTEGER NOT NULL,
    PRIMARY KEY(first_post_id, second_post_id),
    CHECK (first_post_id < second_post_id)
  )`,
  `CREATE TABLE grouping_processed (
    post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    algorithm_version TEXT NOT NULL,
    processed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE source_cache (
    post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > checked_at),
    image_url TEXT
  )`,
  "CREATE INDEX source_cache_expiry ON source_cache(expires_at)",
  `CREATE TABLE post_sources (
    post_id TEXT NOT NULL REFERENCES source_cache(post_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('x', 'pixiv')),
    original_id TEXT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY(post_id, platform, original_id)
  )`,
  // 제목 후보 밖에서도 캐시된 출처 ID로 같은 작품의 글을 바로 찾는다.
  "CREATE INDEX post_sources_by_original ON post_sources(platform, original_id, post_id)",
  `CREATE TABLE image_cache (
    cache_key TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > checked_at),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    whole_hash TEXT NOT NULL CHECK (length(whole_hash) = 16 AND whole_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (width * height <= 12000000)
  )`,
  "CREATE INDEX image_cache_expiry ON image_cache(expires_at)",
  `CREATE TABLE image_regions (
    cache_key TEXT NOT NULL REFERENCES image_cache(cache_key) ON DELETE CASCADE,
    region_index INTEGER NOT NULL CHECK (region_index BETWEEN 0 AND 8),
    hash TEXT NOT NULL CHECK (length(hash) = 16 AND hash NOT GLOB '*[^0-9a-f]*'),
    contrast REAL NOT NULL CHECK (contrast >= 0),
    PRIMARY KEY(cache_key, region_index)
  )`,
  // 원작 작가다. 작품마다 작가를 한 번만 알아내 저장한다.
  `CREATE TABLE artwork_artists (
    platform TEXT NOT NULL CHECK (platform IN ('x', 'pixiv')),
    original_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('found', 'missing', 'failed')),
    artist_id TEXT,
    artist_name TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    checked_at INTEGER NOT NULL,
    PRIMARY KEY(platform, original_id),
    CHECK ((status = 'found') = (artist_id IS NOT NULL))
  )`,
  // 픽시브 작가는 프로필에 연결된 X 계정으로 X 작가와 같은 사람인지 판단한다.
  `CREATE TABLE pixiv_profiles (
    user_id TEXT PRIMARY KEY,
    x_handle TEXT,
    checked_at INTEGER NOT NULL
  )`,
  // 수집 진행 상태는 같은 사이트라도 board의 목록마다 따로다.
  `CREATE TABLE collection_state (
    source TEXT NOT NULL CHECK (source IN ('arca', 'dc')),
    board TEXT NOT NULL CHECK (board IN (${boardList})),
    state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'error')),
    history_backfilled INTEGER NOT NULL DEFAULT 0 CHECK (history_backfilled IN (0, 1)),
    last_attempt_at INTEGER,
    last_success_at INTEGER,
    last_count INTEGER NOT NULL DEFAULT 0 CHECK (last_count >= 0),
    error TEXT,
    PRIMARY KEY(source, board)
  )`,
  // 수집할 board는 worker 설정으로 고르므로 모든 board의 상태를 미리 만든다.
  `INSERT INTO collection_state(source, board) VALUES
    ('arca', 'translation'), ('dc', 'translation'), ('arca', 'creative'), ('dc', 'creative')`,
  `CREATE TABLE request_cooldowns (
    scope TEXT PRIMARY KEY CHECK (scope IN ('arca-list', 'dc-list', 'sources', 'images')),
    next_request_at INTEGER NOT NULL
  )`,
  `CREATE TABLE worker_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('collect', 'backfill')),
    source TEXT CHECK (source IN ('arca', 'dc', 'all')),
    backfill_limit INTEGER,
    active_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
    created_at INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
    worker_id TEXT,
    lease_token TEXT,
    lease_until INTEGER,
    error TEXT,
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    board TEXT NOT NULL DEFAULT 'translation' CHECK (board IN (${boardList})),
    CHECK ((type = 'collect' AND source IS NOT NULL AND backfill_limit IS NULL)
      OR (type = 'backfill' AND source IS NULL AND backfill_limit > 0)),
    CHECK ((state = 'running' AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
      OR (state != 'running' AND worker_id IS NULL AND lease_token IS NULL AND lease_until IS NULL))
  )`,
  "CREATE UNIQUE INDEX worker_jobs_active ON worker_jobs(active_key) WHERE state IN ('queued', 'running')",
  // There is one serial collector, even if two worker instances are accidentally started.
  "CREATE UNIQUE INDEX worker_jobs_single_running ON worker_jobs((1)) WHERE state = 'running'",
  "CREATE INDEX worker_jobs_ready ON worker_jobs(state, available_at, created_at)",
  `CREATE TABLE post_retention (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_cleanup_day TEXT NOT NULL
  )`,
];

export async function migrateTursoDatabase(client: Client): Promise<void> {
  const transaction = await client.transaction("write");
  try {
    await transaction.execute(`CREATE TABLE IF NOT EXISTS board_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`);
    const applied = await transaction.execute(
      "SELECT MAX(version) AS version FROM board_schema_migrations",
    );
    const version = applied.rows[0].version;
    if (version === null) {
      await transaction.batch(schema);
      await transaction.execute({
        sql: "INSERT INTO board_schema_migrations(version, applied_at) VALUES (?, ?)",
        args: [currentSchemaVersion, Date.now()],
      });
    } else if (version !== currentSchemaVersion) {
      // 8보다 오래된 DB는 git 이력의 단계별 변경으로 먼저 올린다. 더 새로운 DB는 이 코드가 모르는 구조다.
      throw new Error(
        `지원하지 않는 번역 보드 DB 스키마 버전입니다: ${version} (지원: ${currentSchemaVersion})`,
      );
    }
    await transaction.commit();
  } finally {
    transaction.close();
  }
}
