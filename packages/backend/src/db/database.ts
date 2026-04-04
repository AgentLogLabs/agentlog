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
const SCHEMA_VERSION = 8;

const DDL_SCHEMA_VERSION = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER NOT NULL,
    applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

/**
 * agent_sessions — 每一次 AI 交互会话的完整记录。
 * 初始 v1 schema，后续通过迁移添加新字段。
 *
 * 字段说明：
 *  - reasoning      : DeepSeek-R1 等模型的 <think> 推理过程（可为 NULL）
 *  - affected_files : JSON 数组字符串，例如 '["src/foo.ts","src/bar.ts"]'
 *  - tags           : JSON 数组字符串，例如 '["bugfix","重构"]'
 *  - metadata       : JSON 对象字符串，存放 provider 特定扩展字段
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

/**
 * session_commits — Session 与 Commit 的多对多关联，含 transcript 分段信息。
 *
 * 字段说明：
 *  - session_id         AgentSession.id 外键
 *  - commit_hash        Commit Hash（短 SHA 或完整 SHA）
 *  - transcript_length  绑定时的 transcript 条数（用于分段展示）
 *  - created_at         绑定创建时间
 */
const DDL_SESSION_COMMITS = `
  CREATE TABLE IF NOT EXISTS session_commits (
    session_id         TEXT    NOT NULL,
    commit_hash        TEXT    NOT NULL,
    transcript_length  INTEGER NOT NULL,
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (session_id, commit_hash),
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
  );
`;

const DDL_SESSION_COMMITS_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_session_commits_session_id ON session_commits (session_id);
  CREATE INDEX IF NOT EXISTS idx_session_commits_commit_hash ON session_commits (commit_hash);
`;

/**
 * enterprise_audit_log — 企业审计日志表（v6 新增）
 *
 * 用于存储完整的 AI 操作审计记录，支持合规审查和代码来源追溯。
 */
const DDL_ENTERPRISE_AUDIT_LOG = `
  CREATE TABLE IF NOT EXISTS enterprise_audit_log (
    id              TEXT    NOT NULL PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    timestamp       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    user_id         TEXT    NOT NULL,
    user_name       TEXT,
    user_department TEXT,
    agent_source    TEXT    NOT NULL DEFAULT 'unknown',
    model_provider  TEXT    NOT NULL,
    model_name      TEXT    NOT NULL,
    action_type     TEXT    NOT NULL DEFAULT 'log_turn',
    content_hash    TEXT    NOT NULL,
    ip_address      TEXT,
    workspace_path  TEXT,
    git_repo_root   TEXT,
    commit_hash     TEXT,
    affected_files  TEXT    NOT NULL DEFAULT '[]',
    prompt_tokens   INTEGER,
    completion_tokens INTEGER,
    reasoning_length INTEGER,
    metadata        TEXT    NOT NULL DEFAULT '{}',
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

const DDL_ENTERPRISE_AUDIT_LOG_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON enterprise_audit_log (timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_user_id ON enterprise_audit_log (user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_session_id ON enterprise_audit_log (session_id);
  CREATE INDEX IF NOT EXISTS idx_audit_commit_hash ON enterprise_audit_log (commit_hash);
  CREATE INDEX IF NOT EXISTS idx_audit_agent_source ON enterprise_audit_log (agent_source);
  CREATE INDEX IF NOT EXISTS idx_audit_model_provider ON enterprise_audit_log (model_provider);
`;

/**
 * compliance_reports — 合规报告表（v6 新增）
 *
 * 存储生成的合规报告，支持周报、月报、事件报告等类型。
 */
const DDL_COMPLIANCE_REPORTS = `
  CREATE TABLE IF NOT EXISTS compliance_reports (
    id              TEXT    NOT NULL PRIMARY KEY,
    report_type     TEXT    NOT NULL,
    period_start    TEXT    NOT NULL,
    period_end      TEXT    NOT NULL,
    generated_by    TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'draft',
    summary         TEXT    NOT NULL DEFAULT '{}',
    total_sessions  INTEGER NOT NULL DEFAULT 0,
    total_users     INTEGER NOT NULL DEFAULT 0,
    models_used     TEXT    NOT NULL DEFAULT '[]',
    files_modified  INTEGER NOT NULL DEFAULT 0,
    commits_count   INTEGER NOT NULL DEFAULT 0,
    compliance_flags TEXT   NOT NULL DEFAULT '[]',
    content         TEXT    NOT NULL DEFAULT '{}',
    exported_file   TEXT,
    approved_by     TEXT,
    approved_at     TEXT,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

const DDL_COMPLIANCE_REPORTS_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_reports_status ON compliance_reports (status);
  CREATE INDEX IF NOT EXISTS idx_reports_type ON compliance_reports (report_type);
  CREATE INDEX IF NOT EXISTS idx_reports_period ON compliance_reports (period_start, period_end);
  CREATE INDEX IF NOT EXISTS idx_reports_generated_by ON compliance_reports (generated_by);
`;

/**
 * user_operations — 用户操作追溯表（v6 新增）
 *
 * 记录用户在 AgentLog 系统中的关键操作，用于安全审计。
 */
const DDL_USER_OPERATIONS = `
  CREATE TABLE IF NOT EXISTS user_operations (
    id              TEXT    NOT NULL PRIMARY KEY,
    user_id         TEXT    NOT NULL,
    user_name       TEXT,
    operation_type  TEXT    NOT NULL,
    target_resource TEXT,
    result          TEXT    NOT NULL,
    detail          TEXT    NOT NULL DEFAULT '{}',
    ip_address      TEXT,
    user_agent      TEXT,
    timestamp       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

const DDL_USER_OPERATIONS_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_ops_user_id ON user_operations (user_id);
  CREATE INDEX IF NOT EXISTS idx_ops_timestamp ON user_operations (timestamp);
  CREATE INDEX IF NOT EXISTS idx_ops_operation_type ON user_operations (operation_type);
`;

/**
 * traces — 层级化树状流转体系的主 trace 表。
 *
 * 字段说明：
 *  - task_goal : 本次 trace 的任务目标描述
 *  - status     : trace 状态（running|completed|failed|paused）
 */
const DDL_TRACES = `
  CREATE TABLE IF NOT EXISTS traces (
    id                TEXT    NOT NULL PRIMARY KEY,
    parent_trace_id   TEXT,
    task_goal         TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'running',
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

const DDL_TRACES_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_traces_status ON traces (status);
  CREATE INDEX IF NOT EXISTS idx_traces_created_at ON traces (created_at);
`;

/**
 * spans — trace 下的层级化操作单元。
 *
 * 字段说明：
 *  - trace_id      : 所属 trace 的 ULID
 *  - parent_span_id : 父 span 的 ULID（顶级 span 此字段为 NULL）
 *  - actor_type    : 执行者类型（human|agent|system）
 *  - actor_name    : 执行者名称
 *  - payload       : JSON 对象，存储 span 相关的详细数据
 *
 * 通过 trace_id 和 parent_span_id 可构建完整的 Span Tree。
 */
const DDL_SPANS = `
  CREATE TABLE IF NOT EXISTS spans (
    id            TEXT    NOT NULL PRIMARY KEY,
    trace_id      TEXT    NOT NULL,
    parent_span_id TEXT,
    actor_type    TEXT    NOT NULL,
    actor_name    TEXT    NOT NULL,
    payload       TEXT    NOT NULL DEFAULT '{}',
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
  );
`;

const DDL_SPANS_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON spans (trace_id);
  CREATE INDEX IF NOT EXISTS idx_spans_parent_span_id ON spans (parent_span_id);
  CREATE INDEX IF NOT EXISTS idx_spans_actor_type ON spans (actor_type);
  CREATE INDEX IF NOT EXISTS idx_spans_created_at ON spans (created_at);
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
  {
    version: 3,
    up: (db) => {
      // 创建 session_commits 多对多关联表
      db.exec(DDL_SESSION_COMMITS);
      db.exec(DDL_SESSION_COMMITS_INDEXES);
      
      // 为 agent_sessions 添加 last_activity_at 字段（用于检测活跃会话）
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN last_activity_at TEXT;`);
      
      // 初始化 last_activity_at：默认为 created_at
      db.exec(`UPDATE agent_sessions SET last_activity_at = created_at WHERE last_activity_at IS NULL`);
      
      // 将现有绑定从 agent_sessions.commit_hash 迁移到 session_commits 表
      db.exec(`
        INSERT INTO session_commits (session_id, commit_hash, transcript_length, created_at)
        SELECT 
          id AS session_id, 
          commit_hash, 
          (
            SELECT json_array_length(transcript) 
            FROM agent_sessions s2 
            WHERE s2.id = agent_sessions.id
          ) AS transcript_length,
          created_at
        FROM agent_sessions 
        WHERE commit_hash IS NOT NULL
      `);
      
      // 更新 commit_bindings.session_ids 以保持兼容性（可选，后续可移除）
      // 注意：这里只是确保数据一致性，实际查询应使用 session_commits 表
    },
  },
  {
    version: 4,
    up: (db) => {
      // 新增 git_repo_root 字段：存储 Git 仓库根目录绝对路径。
      // 在多 worktree 场景下，workspace_path 为具体的 worktree 路径，
      // 而 git_repo_root 为所有 worktree 共享的仓库主目录路径。
      // 通过此字段可将不同 worktree 的会话归一化到同一仓库，支持跨 worktree 绑定匹配。
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN git_repo_root TEXT;`);
      // 为新字段创建索引，加速 hook 端点按仓库根目录查询未绑定会话
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_git_repo_root ON agent_sessions (git_repo_root);`);
      // 存量数据：git_repo_root 暂不填充（历史数据无 worktree 信息），保持 NULL 即可
    },
  },
  {
    version: 5,
    up: (db) => {
      // 语义清晰化：重命名 reasoning -> formatted_transcript，新增 reasoning_summary 字段
      // SQLite 3.25+ 支持 RENAME COLUMN
      db.exec(`ALTER TABLE agent_sessions RENAME COLUMN reasoning TO formatted_transcript;`);
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN reasoning_summary TEXT;`);
      // 将现有 formatted_transcript 内容作为格式化对话记录，reasoning_summary 暂为 NULL
      // reasoning_summary 后续可由业务逻辑填充纯推理摘要
    },
  },
  {
    version: 6,
    up: (db) => {
      // 企业审计日志表：支持完整的 AI 操作审计和代码来源追溯
      db.exec(DDL_ENTERPRISE_AUDIT_LOG);
      db.exec(DDL_ENTERPRISE_AUDIT_LOG_INDEXES);

      // 合规报告表：支持周报、月报、事件报告等
      db.exec(DDL_COMPLIANCE_REPORTS);
      db.exec(DDL_COMPLIANCE_REPORTS_INDEXES);

      // 用户操作追溯表：记录用户在系统中的关键操作
      db.exec(DDL_USER_OPERATIONS);
      db.exec(DDL_USER_OPERATIONS_INDEXES);
    },
  },
  {
    version: 7,
    up: (db) => {
      // 层级化树状流转体系：traces 和 spans
      db.exec(DDL_TRACES);
      db.exec(DDL_TRACES_INDEXES);
      db.exec(DDL_SPANS);
      db.exec(DDL_SPANS_INDEXES);
    },
  },
  {
    version: 8,
    up: (db) => {
      // Trace Fork 支持：新增 parent_trace_id 字段支持 trace 分叉
      db.exec(`ALTER TABLE traces ADD COLUMN parent_trace_id TEXT`);
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
  /** Git 仓库根目录路径，多 worktree 场景下与 workspace_path 不同 (v4 新增) */
  git_repo_root: string | null;
  prompt: string;
  formatted_transcript: string | null;
  reasoning_summary: string | null;
  response: string;
  commit_hash: string | null;
  affected_files: string; // JSON
  duration_ms: number;
  tags: string; // JSON
  note: string | null;
  metadata: string; // JSON
  transcript: string; // JSON array of TranscriptTurn
  last_activity_at: string | null;
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

export type AuditLogRow = {
  id: string;
  session_id: string;
  timestamp: string;
  user_id: string;
  user_name: string | null;
  user_department: string | null;
  agent_source: string;
  model_provider: string;
  model_name: string;
  action_type: string;
  content_hash: string;
  ip_address: string | null;
  workspace_path: string | null;
  git_repo_root: string | null;
  commit_hash: string | null;
  affected_files: string; // JSON
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_length: number | null;
  metadata: string; // JSON
  created_at: string;
};

export type ComplianceReportRow = {
  id: string;
  report_type: string;
  period_start: string;
  period_end: string;
  generated_by: string;
  status: string;
  summary: string; // JSON
  total_sessions: number;
  total_users: number;
  models_used: string; // JSON
  files_modified: number;
  commits_count: number;
  compliance_flags: string; // JSON
  content: string; // JSON
  exported_file: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
};

export type UserOperationRow = {
  id: string;
  user_id: string;
  user_name: string | null;
  operation_type: string;
  target_resource: string | null;
  result: string;
  detail: string; // JSON
  ip_address: string | null;
  user_agent: string | null;
  timestamp: string;
  created_at: string;
};

export type TraceRow = {
  id: string;
  parent_trace_id: string | null;
  task_goal: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type SpanRow = {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  actor_type: string;
  actor_name: string;
  payload: string; // JSON
  created_at: string;
};
