/**
 * @agentlog/backend — SQLite 数据库初始化与 Schema 定义
 *
 * 使用 better-sqlite3（同步 API），保持轻量、无异步复杂度。
 * 数据库文件默认存放于 ~/.agentlog/agentlog.db，可通过环境变量 AGENTLOG_DB_PATH 覆盖。
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─────────────────────────────────────────────
// 数据库路径解析
// ─────────────────────────────────────────────

function resolveDbPath(): string {
  if (process.env.AGENTLOG_DB_PATH) {
    return process.env.AGENTLOG_DB_PATH;
  }
  const dir = path.join(os.homedir(), '.agentlog');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'agentlog.db');
}

// ─────────────────────────────────────────────
// Schema DDL
// ─────────────────────────────────────────────

/**
 * 当前 Schema 版本。
 * 每次变更 DDL 时递增，迁移系统据此判断是否需要升级。
 */
const SCHEMA_VERSION = 2;

const DDL_SCHEMA_VERSION = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER NOT NULL,
    applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

/**
 * agent_sessions — 每一次 AI 交互会话的完整记录。
 *
 * 字段说明：
 *  - reasoning   : DeepSeek-R1 等模型的 <think> 推理过程（可为 NULL）
 *  - affected_files : JSON 数组字符串，例如 '["src/foo.ts","src/bar.ts"]'
 *  - tags        : JSON 数组字符串，例如 '["bugfix","重构"]'
 *  - metadata    : JSON 对象字符串，存放 provider 特定扩展字段
 */
const DDL_AGENT_SESSIONS = `
  CREATE TABLE IF NOT EXISTS agent_sessions (
    id              TEXT    NOT NULL PRIMARY KEY,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    provider        TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    source          TEXT    NOT NULL DEFAULT 'unknown',
    workspace_path  TEXT    NOT NULL,
    prompt          TEXT    NOT NULL,
    reasoning       TEXT,
    response        TEXT    NOT NULL,
    commit_hash     TEXT,
    affected_files  TEXT    NOT NULL DEFAULT '[]',
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    tags            TEXT    NOT NULL DEFAULT '[]',
    note            TEXT,
    metadata        TEXT    NOT NULL DEFAULT '{}'
  );
`;

const DDL_AGENT_SESSIONS_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_sessions_created_at    ON agent_sessions (created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_workspace     ON agent_sessions (workspace_path);
  CREATE INDEX IF NOT EXISTS idx_sessions_provider      ON agent_sessions (provider);
  CREATE INDEX IF NOT EXISTS idx_sessions_commit_hash   ON agent_sessions (commit_hash);
`;

/**
 * commit_bindings — Git Commit 与若干 AgentSession 的绑定关系。
 *
 * 一个 commit_hash 对应一条记录，session_ids 以 JSON 数组存储。
 * changed_files 同样以 JSON 数组存储（来自 git diff --name-only）。
 */
const DDL_COMMIT_BINDINGS = `
  CREATE TABLE IF NOT EXISTS commit_bindings (
    commit_hash     TEXT    NOT NULL PRIMARY KEY,
    session_ids     TEXT    NOT NULL DEFAULT '[]',
    message         TEXT    NOT NULL DEFAULT '',
    committed_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    author_name     TEXT    NOT NULL DEFAULT '',
    author_email    TEXT    NOT NULL DEFAULT '',
    changed_files   TEXT    NOT NULL DEFAULT '[]',
    workspace_path  TEXT    NOT NULL
  );
`;

const DDL_COMMIT_BINDINGS_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_commits_committed_at  ON commit_bindings (committed_at);
  CREATE INDEX IF NOT EXISTS idx_commits_workspace     ON commit_bindings (workspace_path);
`;

// ─────────────────────────────────────────────
// 迁移系统（简易版）
// ─────────────────────────────────────────────

type MigrationFn = (db: Database.Database) => void;

/**
 * 迁移列表，按版本号升序排列。
 * version 表示"应用此迁移后，数据库达到的 schema_version"。
 */
const MIGRATIONS: Array<{ version: number; up: MigrationFn }> = [
  {
    version: 1,
    up: (db) => {
      db.exec(DDL_AGENT_SESSIONS);
      db.exec(DDL_AGENT_SESSIONS_INDEXES);
      db.exec(DDL_COMMIT_BINDINGS);
      db.exec(DDL_COMMIT_BINDINGS_INDEXES);
    },
  },
  {
    version: 2,
    up: (db) => {
      // transcript：逐轮对话记录（JSON 数组，每条为 TranscriptTurn）
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN transcript TEXT NOT NULL DEFAULT '[]';`);
      // token_usage：Token 用量统计（JSON 对象，含 inputTokens/outputTokens/cache 等）
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN token_usage TEXT;`);
    },
  },
];

function getCurrentSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT MAX(version) as v FROM schema_version')
    .get() as { v: number | null };
  return row?.v ?? 0;
}

function runMigrations(db: Database.Database): void {
  const current = getCurrentSchemaVersion(db);
  if (current >= SCHEMA_VERSION) {
    return; // 已是最新版本
  }

  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;

  console.log(
    `[AgentLog DB] 运行 ${pending.length} 条待执行迁移（当前版本: ${current} → 目标版本: ${SCHEMA_VERSION}）`,
  );

  for (const migration of pending) {
    const applyMigration = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
        migration.version,
      );
    });
    applyMigration();
    console.log(`[AgentLog DB] 迁移 v${migration.version} 完成`);
  }
}

// ─────────────────────────────────────────────
// 数据库单例
// ─────────────────────────────────────────────

let _db: Database.Database | null = null;

/**
 * 获取（或初始化）数据库单例。
 *
 * @param dbPath 可选，覆盖默认路径（主要用于测试）
 */
export function getDatabase(dbPath?: string): Database.Database {
  if (_db) return _db;

  const resolvedPath = dbPath ?? resolveDbPath();

  const db = new Database(resolvedPath, {
    // 打开 WAL 模式可大幅提升并发读取性能
    // WAL 在首次 pragma 调用时生效，此处通过 verbose 传入即可
  });

  // 基础 PRAGMA 调优
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -16000'); // 约 16 MB

  // 初始化 schema_version 表（始终需要存在）
  db.exec(DDL_SCHEMA_VERSION);

  // 执行待定迁移
  runMigrations(db);

  _db = db;
  console.log(`[AgentLog DB] 数据库已就绪：${resolvedPath}`);
  return db;
}

/**
 * 关闭数据库连接（主要用于测试和优雅退出）。
 */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
    console.log('[AgentLog DB] 数据库连接已关闭');
  }
}

// ─────────────────────────────────────────────
// 工具函数（供 routes/services 使用）
// ─────────────────────────────────────────────

/** 将 JS 数组/对象序列化为 JSON 字符串存入数据库 */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** 从数据库读取 JSON 字符串并反序列化，出错时返回 fallback */
export function fromJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 将数据库行（snake_case）映射为 AgentSession（camelCase）的辅助函数。
 * 实际 mapping 逻辑在 services/logService.ts 中，此处仅提供类型参考。
 */
export type SessionRow = {
  id: string;
  created_at: string;
  provider: string;
  model: string;
  source: string;
  workspace_path: string;
  prompt: string;
  reasoning: string | null;
  response: string;
  commit_hash: string | null;
  affected_files: string; // JSON
  duration_ms: number;
  tags: string; // JSON
  note: string | null;
  metadata: string; // JSON
  transcript: string; // JSON array of TranscriptTurn
  token_usage: string | null; // JSON object of TokenUsage
};

export type CommitRow = {
  commit_hash: string;
  session_ids: string; // JSON
  message: string;
  committed_at: string;
  author_name: string;
  author_email: string;
  changed_files: string; // JSON
  workspace_path: string;
};
