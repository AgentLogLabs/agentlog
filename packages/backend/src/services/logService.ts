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
  AppendTranscriptRequest,
  PaginatedResponse,
  SessionQueryFilter,
  TranscriptTurn,
  TokenUsage,
  SessionCommit,
} from '@agentlog/shared';

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/**
 * 将 transcript 数组序列化为可读文本，作为 reasoning 字段存储。
 * 格式与 entire CLI 的 `entire explain` 输出对齐：
 *   [User] 消息内容
 *   [Assistant] 回复内容
 *   [Tool:bash] 执行结果
 */
function transcriptToReasoning(turns: TranscriptTurn[]): string {
  if (turns.length === 0) return '';
  return turns
    .map((t) => {
      const label =
        t.role === 'tool'
          ? `[Tool${t.toolName ? `:${t.toolName}` : ''}]`
          : t.role === 'user'
            ? '[User]'
            : '[Assistant]';
      const inputHint = t.toolInput ? `\n  Input: ${t.toolInput}` : '';
      // 推理模型本轮的思考过程（DeepSeek-R1 / Claude extended thinking 等）
      const thinkingBlock =
        t.reasoning && t.reasoning.trim()
          ? `\n<think>\n${t.reasoning.trim()}\n</think>`
          : '';
      return `${label}${inputHint}${thinkingBlock}\n${t.content}`;
    })
    .join('\n\n');
}
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
  const transcript = fromJson<TranscriptTurn[]>(row.transcript, []);
  const tokenUsage = row.token_usage
    ? fromJson<TokenUsage>(row.token_usage, undefined as unknown as TokenUsage)
    : undefined;

  // 查询该会话的所有 Commit 绑定（多对多）
  const db = getDatabase();
  const sessionCommitsRows = db
    .prepare(`
      SELECT commit_hash, transcript_length, created_at
      FROM session_commits
      WHERE session_id = ?
      ORDER BY created_at ASC
    `)
    .all(row.id) as Array<{commit_hash: string; transcript_length: number; created_at: string}>;

  const sessionCommits: SessionCommit[] = sessionCommitsRows.map(sc => ({
    commitHash: sc.commit_hash,
    transcriptLength: sc.transcript_length,
    createdAt: sc.created_at,
  }));

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
    sessionCommits: sessionCommits.length > 0 ? sessionCommits : undefined,
    affectedFiles: fromJson<string[]>(row.affected_files, []),
    durationMs: row.duration_ms,
    tags: fromJson<string[]>(row.tags, []),
    note: row.note ?? undefined,
    transcript: transcript.length > 0 ? transcript : undefined,
    lastActivityAt: row.last_activity_at ?? undefined,
    tokenUsage: tokenUsage ?? undefined,
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

  // 若创建时就携带了 transcript，自动从中生成 reasoning
  const transcriptTurns = req.transcript ?? [];
  const autoReasoning =
    transcriptTurns.length > 0
      ? transcriptToReasoning(transcriptTurns)
      : (req.reasoning ?? null);

  db.prepare(`
    INSERT INTO agent_sessions (
      id, created_at, provider, model, source, workspace_path,
      prompt, reasoning, response, affected_files,
      duration_ms, tags, note, metadata, transcript, token_usage
    ) VALUES (
      @id, @created_at, @provider, @model, @source, @workspace_path,
      @prompt, @reasoning, @response, @affected_files,
      @duration_ms, @tags, @note, @metadata, @transcript, @token_usage
    )
  `).run({
    id,
    created_at: createdAt,
    provider: req.provider,
    model: req.model,
    source: req.source,
    workspace_path: req.workspacePath,
    prompt: req.prompt,
    reasoning: autoReasoning,
    response: req.response,
    affected_files: toJson(req.affectedFiles ?? []),
    duration_ms: req.durationMs,
    tags: toJson(req.tags ?? []),
    note: req.note ?? null,
    metadata: toJson(req.metadata ?? {}),
    transcript: toJson(transcriptTurns),
    token_usage: req.tokenUsage ? toJson(req.tokenUsage) : null,
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
 * 按 Commit Hash 查询关联的会话列表（基于多对多绑定）。
 */
export function getSessionsByCommitHash(
  commitHash: string,
): AgentSession[] {
  const db = getDatabase();
  
  // 通过 session_commits 表查找关联的会话
  const rows = db
    .prepare(`
      SELECT s.* 
      FROM agent_sessions s
      INNER JOIN session_commits sc ON s.id = sc.session_id
      WHERE sc.commit_hash = ? 
      ORDER BY s.created_at ASC
    `)
    .all(commitHash) as SessionRow[];
    
  return rows.map(rowToSession);
}

/**
 * 查询指定工作区内尚未绑定任何 Commit 的会话（按时间倒序）。
 * 
 * 多对多绑定下，“未绑定”定义为在 session_commits 表中没有记录的会话。
 * 同时检查 commit_hash IS NULL 以保持向后兼容。
 */
export function getUnboundSessions(
  workspacePath: string,
  limit = 50,
): AgentSession[] {
  const db = getDatabase();
  const rows = db
    .prepare(`
      SELECT s.* 
      FROM agent_sessions s
      LEFT JOIN session_commits sc ON s.id = sc.session_id
      WHERE s.workspace_path = ? 
        AND sc.session_id IS NULL 
        AND s.commit_hash IS NULL
      ORDER BY s.created_at DESC
      LIMIT ?
    `)
    .all(workspacePath, limit) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * 获取需要绑定到新 Commit 的会话列表（包括未绑定和活跃会话）。
 * 
 * 活跃会话定义：自上次绑定后 transcript 长度增加或 affected_files 发生变化。
 * 查询逻辑：
 * 1. 未绑定会话（在 session_commits 中无记录）
 * 2. 已绑定会话，但当前 transcript 长度 > 上次绑定的 transcript_length
 * 3. 已绑定会话，但当前 affected_files 与上次绑定时有差异（TODO: 暂未实现）
 * 
 * @param workspacePath 工作区路径
 * @param limit 最多返回条数
 */
export function getSessionsForNewCommit(
  workspacePath: string,
  limit = 50,
): AgentSession[] {
  const db = getDatabase();
  
  const rows = db
    .prepare(`
      -- 未绑定会话
      SELECT s.* 
      FROM agent_sessions s
      LEFT JOIN session_commits sc ON s.id = sc.session_id
      WHERE s.workspace_path = ? 
        AND sc.session_id IS NULL 
        AND s.commit_hash IS NULL
      
      UNION
      
      -- 已绑定但 transcript 长度增加的会话
      SELECT s.*
      FROM agent_sessions s
      INNER JOIN (
        -- 每个会话的最新绑定（按 created_at 排序）
        SELECT 
          session_id, 
          MAX(created_at) as last_bound_at,
          transcript_length as last_transcript_length
        FROM session_commits
        GROUP BY session_id
      ) latest ON s.id = latest.session_id
      WHERE s.workspace_path = ?
        AND (
          -- 当前 transcript 长度 > 上次绑定的 transcript_length
          (SELECT json_array_length(s.transcript) FROM agent_sessions WHERE id = s.id) > latest.last_transcript_length
          -- 或 last_activity_at 晚于 last_bound_at（有新的活动）
          OR (s.last_activity_at IS NOT NULL AND s.last_activity_at > latest.last_bound_at)
        )
      
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(workspacePath, workspacePath, limit) as SessionRow[];
    
  return rows.map(rowToSession);
}

// ─────────────────────────────────────────────
// 更新
// ─────────────────────────────────────────────

/** 
 * 将一批会话绑定到同一个 Commit Hash（支持多对多绑定）
 * 
 * 更新逻辑：
 * 1. 将绑定关系插入 session_commits 表（多对多）
 * 2. 更新 agent_sessions.commit_hash 为当前 commitHash（最新绑定，向后兼容）
 * 3. 更新 agent_sessions.last_activity_at 为当前时间
 */
export function bindSessionsToCommit(
  sessionIds: string[],
  commitHash: string,
): number {
  if (sessionIds.length === 0) return 0;

  const db = getDatabase();
  const now = new Date().toISOString();

  const bindAll = db.transaction(() => {
    let affected = 0;
    
    for (const id of sessionIds) {
      // 获取当前 transcript 长度
      const session = getSessionById(id);
      const transcriptLength = session?.transcript?.length ?? 0;
      
      // 插入或替换 session_commits 记录（UPSERT）
      const upsertStmt = db.prepare(`
        INSERT OR REPLACE INTO session_commits 
          (session_id, commit_hash, transcript_length, created_at)
        VALUES (?, ?, ?, ?)
      `);
      upsertStmt.run(id, commitHash, transcriptLength, now);
      
      // 更新 agent_sessions 表（保持向后兼容）
      const updateStmt = db.prepare(`
        UPDATE agent_sessions 
        SET commit_hash = ?, last_activity_at = ?
        WHERE id = ?
      `);
      const result = updateStmt.run(commitHash, now, id);
      affected += result.changes;
    }
    
    return affected;
  });

  return bindAll() as number;
}

/** 
 * 解绑会话与所有 Commit 的关联
 * 
 * 多对多绑定下，此操作将：
 * 1. 从 session_commits 表中删除该 session 的所有绑定记录
 * 2. 将 agent_sessions.commit_hash 置为 NULL（向后兼容）
 * 
 * 若要解绑特定 commit，请使用 removeSessionFromCommit 函数。
 */
export function unbindSessionFromCommit(sessionId: string): boolean {
  const db = getDatabase();
  
  const unbindAll = db.transaction(() => {
    // 从 session_commits 表中删除所有该 session 的记录
    db.prepare('DELETE FROM session_commits WHERE session_id = ?').run(sessionId);
    
    // 将 agent_sessions.commit_hash 置为 NULL（保持向后兼容）
    const result = db
      .prepare('UPDATE agent_sessions SET commit_hash = NULL WHERE id = ?')
      .run(sessionId);
    
    return result.changes > 0;
  });
  
  return unbindAll() as boolean;
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

/**
 * 更新会话的核心内容字段（由 log_intent 在任务完成后回写）。
 *
 * - response：填入 task 描述（当前值为占位符时替换）
 * - reasoning：从该会话当前 transcript 自动生成，如实呈现完整交互过程
 * - affectedFiles：替换为传入的文件列表
 *
 * reasoning 不接受外部传入，始终由 transcript 生成，确保记录真实而非总结。
 */
export function updateSessionIntent(
  sessionId: string,
  fields: {
    response?: string;
    affectedFiles?: string[];
    durationMs?: number;
  },
): AgentSession | null {
  const db = getDatabase();

  const existing = getSessionById(sessionId);
  if (!existing) return null;

  const setClauses: string[] = [];
  const params: Record<string, unknown> = { id: sessionId };

  if (fields.response !== undefined && fields.response.trim() !== '') {
    setClauses.push('response = @response');
    params.response = fields.response;
  }

  // reasoning 始终从当前 transcript 生成
  const currentTranscript = existing.transcript ?? [];
  if (currentTranscript.length > 0) {
    setClauses.push('reasoning = @reasoning');
    params.reasoning = transcriptToReasoning(currentTranscript);
  }

  if (fields.affectedFiles !== undefined && fields.affectedFiles.length > 0) {
    setClauses.push('affected_files = @affected_files');
    params.affected_files = toJson(fields.affectedFiles);
  }

  if (fields.durationMs !== undefined && fields.durationMs > 0) {
    setClauses.push('duration_ms = @duration_ms');
    params.duration_ms = fields.durationMs;
  }

  // 总是更新 last_activity_at（用于检测活跃会话）
  setClauses.push('last_activity_at = @last_activity_at');
  params.last_activity_at = new Date().toISOString();

  if (setClauses.length === 0) return existing;

  db.prepare(
    `UPDATE agent_sessions SET ${setClauses.join(', ')} WHERE id = @id`,
  ).run(params);

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

/**
 * 向已有会话追加 transcript 消息，并可选更新 token 用量。
 *
 * transcript 以 JSON 数组存储，此函数将新 turns 合并到现有数组末尾。
 * token_usage 如传入则以传入值完整覆盖（调用方应传累计值）。
 *
 * @returns 更新后的会话，不存在时返回 null
 */
export function appendTranscript(
  sessionId: string,
  req: AppendTranscriptRequest,
): AgentSession | null {
  const db = getDatabase();

  const existing = getSessionById(sessionId);
  if (!existing) return null;

  const merged: TranscriptTurn[] = [
    ...(existing.transcript ?? []),
    ...req.turns,
  ];

  const tokenUsageJson = req.tokenUsage
    ? toJson(req.tokenUsage)
    : null;

  const now = new Date().toISOString();

  if (tokenUsageJson !== null) {
    db.prepare(
      'UPDATE agent_sessions SET transcript = ?, token_usage = ?, last_activity_at = ? WHERE id = ?',
    ).run(toJson(merged), tokenUsageJson, now, sessionId);
  } else {
    db.prepare(
      'UPDATE agent_sessions SET transcript = ?, last_activity_at = ? WHERE id = ?',
    ).run(toJson(merged), now, sessionId);
  }

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
