/**
 * @agentlog/backend — logService
 *
 * AgentSession 的 CRUD 服务层。
 * 负责数据库行（snake_case）与共享类型（camelCase）之间的双向映射，
 * 以及分页、过滤、批量操作等业务逻辑。
 */

import { nanoid } from 'nanoid';
import type {
  AgentSession,
  CreateSessionRequest,
  PaginatedResponse,
  SessionQueryFilter,
} from '@agentlog/shared';
import {
  closeDatabase,
  fromJson,
  getDatabase,
  toJson,
  type SessionRow,
} from '../db/database';

// ─────────────────────────────────────────────
// 行 → 实体 映射
// ─────────────────────────────────────────────

function rowToSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    createdAt: row.created_at,
    provider: row.provider as AgentSession['provider'],
    model: row.model,
    source: row.source as AgentSession['source'],
    workspacePath: row.workspace_path,
    prompt: row.prompt,
    reasoning: row.reasoning ?? undefined,
    response: row.response,
    commitHash: row.commit_hash ?? undefined,
    affectedFiles: fromJson<string[]>(row.affected_files, []),
    durationMs: row.duration_ms,
    tags: fromJson<string[]>(row.tags, []),
    note: row.note ?? undefined,
    metadata: fromJson<Record<string, unknown>>(row.metadata, {}),
  };
}

// ─────────────────────────────────────────────
// 创建
// ─────────────────────────────────────────────

/**
 * 持久化一条新的 AgentSession。
 * 返回已写入数据库的完整实体（含自动生成的 id 与 createdAt）。
 */
export function createSession(req: CreateSessionRequest): AgentSession {
  const db = getDatabase();

  const id = nanoid();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_sessions (
      id, created_at, provider, model, source, workspace_path,
      prompt, reasoning, response, affected_files,
      duration_ms, tags, note, metadata
    ) VALUES (
      @id, @created_at, @provider, @model, @source, @workspace_path,
      @prompt, @reasoning, @response, @affected_files,
      @duration_ms, @tags, @note, @metadata
    )
  `).run({
    id,
    created_at: createdAt,
    provider: req.provider,
    model: req.model,
    source: req.source,
    workspace_path: req.workspacePath,
    prompt: req.prompt,
    reasoning: req.reasoning ?? null,
    response: req.response,
    affected_files: toJson(req.affectedFiles ?? []),
    duration_ms: req.durationMs,
    tags: toJson(req.tags ?? []),
    note: req.note ?? null,
    metadata: toJson(req.metadata ?? {}),
  });

  // 重新读取以确保返回值与数据库完全一致
  const created = getSessionById(id);
  if (!created) {
    throw new Error(`[logService] 会话写入失败，id=${id}`);
  }
  return created;
}

// ─────────────────────────────────────────────
// 读取
// ─────────────────────────────────────────────

/** 按 ID 查询单条会话，不存在时返回 null */
export function getSessionById(id: string): AgentSession | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM agent_sessions WHERE id = ?')
    .get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

/**
 * 带过滤条件的分页查询。
 *
 * 支持过滤字段：
 *  - workspacePath  精确匹配
 *  - provider       精确匹配
 *  - source         精确匹配
 *  - startDate      createdAt >= startDate
 *  - endDate        createdAt <= endDate
 *  - tags           JSON 包含（逐个 LIKE）
 *  - keyword        prompt / response / note 全文模糊匹配
 *  - onlyBoundToCommit  commit_hash IS NOT NULL
 */
export function querySessions(
  filter: SessionQueryFilter = {},
): PaginatedResponse<AgentSession> {
  const db = getDatabase();

  const {
    workspacePath,
    provider,
    source,
    startDate,
    endDate,
    tags,
    keyword,
    onlyBoundToCommit,
    page = 1,
    pageSize = 20,
  } = filter;

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (workspacePath) {
    conditions.push('workspace_path = @workspacePath');
    params.workspacePath = workspacePath;
  }

  if (provider) {
    conditions.push('provider = @provider');
    params.provider = provider;
  }

  if (source) {
    conditions.push('source = @source');
    params.source = source;
  }

  if (startDate) {
    conditions.push('created_at >= @startDate');
    params.startDate = startDate;
  }

  if (endDate) {
    // endDate 含当天末尾，需补足时间戳
    const end = endDate.length === 10 ? `${endDate}T23:59:59.999Z` : endDate;
    conditions.push('created_at <= @endDate');
    params.endDate = end;
  }

  if (onlyBoundToCommit) {
    conditions.push('commit_hash IS NOT NULL');
  }

  // tags 使用 JSON LIKE 模糊匹配（简单但够用的 MVP 方案）
  if (tags && tags.length > 0) {
    tags.forEach((tag, i) => {
      const key = `tag_${i}`;
      conditions.push(`tags LIKE @${key}`);
      params[key] = `%"${tag}"%`;
    });
  }

  // keyword 全文搜索
  if (keyword) {
    conditions.push(
      '(prompt LIKE @keyword OR response LIKE @keyword OR note LIKE @keyword)',
    );
    params.keyword = `%${keyword}%`;
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // 总数
  const { total } = db
    .prepare(`SELECT COUNT(*) as total FROM agent_sessions ${where}`)
    .get(params) as { total: number };

  // 分页数据（按创建时间倒序，最新在前）
  const offset = (page - 1) * pageSize;
  const rows = db
    .prepare(
      `SELECT * FROM agent_sessions ${where}
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: pageSize, offset }) as SessionRow[];

  return {
    data: rows.map(rowToSession),
    total,
    page,
    pageSize,
  };
}

/**
 * 按 Commit Hash 查询关联的会话列表。
 */
export function getSessionsByCommitHash(
  commitHash: string,
): AgentSession[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      'SELECT * FROM agent_sessions WHERE commit_hash = ? ORDER BY created_at ASC',
    )
    .all(commitHash) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * 查询指定工作区内尚未绑定任何 Commit 的会话（按时间倒序）。
 * 在"自动绑定最近会话"场景中使用。
 */
export function getUnboundSessions(
  workspacePath: string,
  limit = 50,
): AgentSession[] {
  const db = getDatabase();
  const rows = db
    .prepare(`
      SELECT * FROM agent_sessions
      WHERE workspace_path = ? AND commit_hash IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(workspacePath, limit) as SessionRow[];
  return rows.map(rowToSession);
}

// ─────────────────────────────────────────────
// 更新
// ─────────────────────────────────────────────

/** 将一批会话绑定到同一个 Commit Hash */
export function bindSessionsToCommit(
  sessionIds: string[],
  commitHash: string,
): number {
  if (sessionIds.length === 0) return 0;

  const db = getDatabase();

  const bindAll = db.transaction(() => {
    const stmt = db.prepare(
      'UPDATE agent_sessions SET commit_hash = ? WHERE id = ?',
    );
    let affected = 0;
    for (const id of sessionIds) {
      const result = stmt.run(commitHash, id);
      affected += result.changes;
    }
    return affected;
  });

  return bindAll() as number;
}

/** 解绑会话与 Commit 的关联（将 commit_hash 置为 NULL） */
export function unbindSessionFromCommit(sessionId: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare('UPDATE agent_sessions SET commit_hash = NULL WHERE id = ?')
    .run(sessionId);
  return result.changes > 0;
}

/** 更新会话的标签 */
export function updateSessionTags(
  sessionId: string,
  tags: string[],
): AgentSession | null {
  const db = getDatabase();
  const result = db
    .prepare('UPDATE agent_sessions SET tags = ? WHERE id = ?')
    .run(toJson(tags), sessionId);

  if (result.changes === 0) return null;
  return getSessionById(sessionId);
}

/** 更新会话的备注 */
export function updateSessionNote(
  sessionId: string,
  note: string,
): AgentSession | null {
  const db = getDatabase();
  const result = db
    .prepare('UPDATE agent_sessions SET note = ? WHERE id = ?')
    .run(note || null, sessionId);

  if (result.changes === 0) return null;
  return getSessionById(sessionId);
}

// ─────────────────────────────────────────────
// 删除
// ─────────────────────────────────────────────

/** 按 ID 删除单条会话，返回是否成功删除 */
export function deleteSession(sessionId: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare('DELETE FROM agent_sessions WHERE id = ?')
    .run(sessionId);
  return result.changes > 0;
}

/**
 * 删除超过保留期限的会话（数据清理用）。
 *
 * @param retentionDays 保留天数，0 表示永久保留
 * @returns 删除的记录数
 */
export function pruneOldSessions(retentionDays: number): number {
  if (retentionDays <= 0) return 0;

  const db = getDatabase();
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const result = db
    .prepare("DELETE FROM agent_sessions WHERE created_at < ?")
    .run(cutoff);

  return result.changes;
}

// ─────────────────────────────────────────────
// 统计
// ─────────────────────────────────────────────

export interface SessionStats {
  total: number;
  boundToCommit: number;
  unbound: number;
  byProvider: Record<string, number>;
  bySource: Record<string, number>;
  avgDurationMs: number;
}

/**
 * 返回指定工作区（或全局）的会话统计数据。
 */
export function getSessionStats(workspacePath?: string): SessionStats {
  const db = getDatabase();

  const where = workspacePath ? 'WHERE workspace_path = ?' : '';
  const args = workspacePath ? [workspacePath] : [];

  const { total } = db
    .prepare(`SELECT COUNT(*) as total FROM agent_sessions ${where}`)
    .get(...args) as { total: number };

  const { bound } = db
    .prepare(
      `SELECT COUNT(*) as bound FROM agent_sessions ${where ? where + ' AND' : 'WHERE'} commit_hash IS NOT NULL`,
    )
    .get(...args) as { bound: number };

  const { avg_ms } = db
    .prepare(`SELECT AVG(duration_ms) as avg_ms FROM agent_sessions ${where}`)
    .get(...args) as { avg_ms: number | null };

  // 按 provider 分组
  const providerRows = db
    .prepare(
      `SELECT provider, COUNT(*) as cnt FROM agent_sessions ${where} GROUP BY provider`,
    )
    .all(...args) as Array<{ provider: string; cnt: number }>;

  // 按 source 分组
  const sourceRows = db
    .prepare(
      `SELECT source, COUNT(*) as cnt FROM agent_sessions ${where} GROUP BY source`,
    )
    .all(...args) as Array<{ source: string; cnt: number }>;

  return {
    total,
    boundToCommit: bound,
    unbound: total - bound,
    byProvider: Object.fromEntries(providerRows.map((r) => [r.provider, r.cnt])),
    bySource: Object.fromEntries(sourceRows.map((r) => [r.source, r.cnt])),
    avgDurationMs: Math.round(avg_ms ?? 0),
  };
}

// ─────────────────────────────────────────────
// JSONL 导出（原始数据备份）
// ─────────────────────────────────────────────

/**
 * 将符合 filter 条件的会话序列化为 JSONL 格式字符串。
 * 每行一个 JSON 对象，方便流式处理和 grep 检索。
 */
export function exportSessionsAsJsonl(
  filter: SessionQueryFilter = {},
): string {
  // 移除分页限制，全量导出
  const allFilter: SessionQueryFilter = { ...filter, page: 1, pageSize: 99999 };
  const { data } = querySessions(allFilter);
  return data.map((s) => JSON.stringify(s)).join('\n');
}

// ─────────────────────────────────────────────
// 生命周期
// ─────────────────────────────────────────────

/** 优雅退出时关闭数据库连接 */
export function shutdown(): void {
  closeDatabase();
}
