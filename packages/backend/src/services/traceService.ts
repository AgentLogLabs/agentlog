import { ulid } from 'ulid';
import {
  closeDatabase,
  fromJson,
  getDatabase,
  toJson,
  type SpanRow,
  type TraceRow,
} from '../db/database';

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

export type TraceStatus = 'running' | 'pending_handoff' | 'in_progress' | 'completed' | 'failed' | 'paused';

export interface Trace {
  id: string;
  parentTraceId: string | null;
  taskGoal: string;
  status: TraceStatus;
  workspacePath: string | null;
  affectedFiles: string[];
  createdAt: string;
  updatedAt: string;
  hasCommit: boolean;
  commitHash?: string;
}

export interface CreateTraceRequest {
  taskGoal: string;
  status?: TraceStatus;
  parentTraceId?: string;
  workspacePath?: string;
}

export interface UpdateTraceRequest {
  taskGoal?: string;
  status?: TraceStatus;
  affectedFiles?: string[];
}

export type ActorType = 'human' | 'agent' | 'system';

export interface Span {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  actorType: ActorType;
  actorName: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateSpanRequest {
  traceId: string;
  parentSpanId?: string | null;
  actorType: ActorType;
  actorName: string;
  payload?: Record<string, unknown>;
}

export interface SpanTreeNode extends Span {
  children: SpanTreeNode[];
}

// Error Span types (Stage 1 新增)
export interface ReasoningChainStep {
  step: number;
  thought: string;
  action: string;
}

export interface ErrorSpanPayload {
  errorType: string;
  stackTrace?: string;
  memorySnapshot?: {
    workspacePath: string;
    currentFiles: string[];
    gitStatus: 'clean' | 'modified' | 'staged' | 'untracked';
  };
  diff?: {
    changedFiles: string[];
    additions: number;
    deletions: number;
  };
  reasoningChain?: ReasoningChainStep[];
}

export interface CreateErrorSpanRequest {
  traceId: string;
  errorType: string;
  stackTrace?: string;
  memorySnapshot?: {
    workspacePath: string;
    currentFiles: string[];
    gitStatus: 'clean' | 'modified' | 'staged' | 'untracked';
  };
  diff?: {
    changedFiles: string[];
    additions: number;
    deletions: number;
  };
  reasoningChain?: ReasoningChainStep[];
}

// ─────────────────────────────────────────────
// 行 → 实体 映射
// ─────────────────────────────────────────────

function rowToTrace(row: TraceRow): Trace {
  return {
    id: row.id,
    parentTraceId: (row as unknown as { parent_trace_id: string | null }).parent_trace_id ?? null,
    taskGoal: row.task_goal,
    status: row.status as TraceStatus,
    workspacePath: row.workspace_path ?? null,
    affectedFiles: fromJson<string[]>((row as unknown as { affected_files?: string }).affected_files ?? '[]', []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasCommit: false,
  };
}

function rowToSpan(row: SpanRow): Span {
  return {
    id: row.id,
    traceId: row.trace_id,
    parentSpanId: row.parent_span_id,
    actorType: row.actor_type as ActorType,
    actorName: row.actor_name,
    payload: fromJson<Record<string, unknown>>(row.payload, {}),
    createdAt: row.created_at,
  };
}

// ─────────────────────────────────────────────
// Trace CRUD
// ─────────────────────────────────────────────

export function createTrace(req: CreateTraceRequest): Trace {
  const db = getDatabase();
  const id = ulid();
  const now = new Date().toISOString();
  const status = req.status ?? 'running';
  const parentTraceId = req.parentTraceId ?? null;

  db.prepare(`
    INSERT INTO traces (id, parent_trace_id, task_goal, status, workspace_path, affected_files, created_at, updated_at)
    VALUES (@id, @parent_trace_id, @task_goal, @status, @workspace_path, @affected_files, @created_at, @updated_at)
  `).run({
    id,
    parent_trace_id: parentTraceId,
    task_goal: req.taskGoal,
    status,
    workspace_path: req.workspacePath ?? null,
    affected_files: '[]',
    created_at: now,
    updated_at: now,
  });

  const created = getTraceById(id);
  if (!created) {
    throw new Error(`[traceService] Trace 创建失败，id=${id}`);
  }
  return created;
}

export function getTraceById(id: string): Trace | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM traces WHERE id = ?').get(id) as TraceRow | undefined;
  return row ? rowToTrace(row) : null;
}

export function updateTrace(id: string, req: UpdateTraceRequest): Trace | null {
  const db = getDatabase();
  const existing = getTraceById(id);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const taskGoal = req.taskGoal ?? existing.taskGoal;
  const status = req.status ?? existing.status;

  // Merge affected_files: union of existing and new, deduplicated
  const mergedFiles = req.affectedFiles !== undefined
    ? [...new Set([...existing.affectedFiles, ...req.affectedFiles])]
    : existing.affectedFiles;

  db.prepare(`
    UPDATE traces SET task_goal = @task_goal, status = @status, affected_files = @affected_files, updated_at = @updated_at
    WHERE id = @id
  `).run({
    id,
    task_goal: taskGoal,
    status,
    affected_files: toJson(mergedFiles),
    updated_at: now,
  });

  return getTraceById(id);
}

export function deleteTrace(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM traces WHERE id = ?').run(id);
  return result.changes > 0;
}

export function queryTraces(filter: {
  status?: TraceStatus;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
  workspacePath?: string;
} = {}): { data: Trace[]; total: number; page: number; pageSize: number } {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter.workspacePath) {
    conditions.push('workspace_path = @workspacePath');
    params.workspacePath = filter.workspacePath;
  }

  if (filter.status) {
    conditions.push('status = @status');
    params.status = filter.status;
  }
  if (filter.startDate) {
    conditions.push('created_at >= @startDate');
    params.startDate = filter.startDate;
  }
  if (filter.endDate) {
    conditions.push('created_at <= @endDate');
    params.endDate = filter.endDate;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const page = filter.page ?? 1;
  const pageSize = filter.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const { total } = db.prepare(`SELECT COUNT(*) as total FROM traces ${where}`).get(params) as { total: number };

  const rows = db.prepare(`
    SELECT * FROM traces ${where}
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset }) as TraceRow[];

  const traceIds = rows.map(r => r.id);
  const commitMap = new Map<string, string>();

  if (traceIds.length > 0) {
    const placeholders = traceIds.map(() => '?').join(',');
    const bindings = db.prepare(`
      SELECT commit_hash, trace_ids FROM commit_bindings
      WHERE trace_ids != '[]' AND trace_ids != ''
    `).all() as { commit_hash: string; trace_ids: string }[];

    for (const binding of bindings) {
      const traceIdsArr: string[] = fromJson(binding.trace_ids, []);
      for (const tid of traceIdsArr) {
        if (traceIds.includes(tid) && !commitMap.has(tid)) {
          commitMap.set(tid, binding.commit_hash);
        }
      }
    }
  }

  const traces = rows.map(row => {
    const trace = rowToTrace(row);
    const commitHash = commitMap.get(row.id);
    trace.hasCommit = !!commitHash;
    if (commitHash) trace.commitHash = commitHash;
    return trace;
  });

  return { data: traces, total, page, pageSize };
}

// ─────────────────────────────────────────────
// Span CRUD
// ─────────────────────────────────────────────

/**
 * 从 span payload 中提取被操作的文件路径列表。
 *
 * 支持的字段（来自 toolInput）：
 *   filePath / path / file_path — write/edit/read 等工具
 *
 * 路径处理：若 trace 有 workspacePath，则转为相对路径（与 git hook 保持一致）；
 * 否则保留绝对路径兜底。
 */
export function extractFilesFromPayload(
  payload: Record<string, unknown>,
  workspacePath?: string | null,
): string[] {
  const toolInput = payload.toolInput as Record<string, unknown> | undefined;
  if (!toolInput) return [];

  const raw = new Set<string>();
  for (const key of ['filePath', 'path', 'file_path']) {
    const val = toolInput[key];
    if (typeof val === 'string' && val.trim()) raw.add(val.trim());
  }

  const result: string[] = [];
  for (const p of raw) {
    // 过滤掉明显不是文件路径的值（如 URL、纯文件名无路径分隔符）
    if (!p.includes('/') && !p.includes('\\')) continue;
    if (workspacePath && p.startsWith(workspacePath)) {
      // 转为相对路径，去掉前缀斜杠
      result.push(p.slice(workspacePath.length).replace(/^\//, ''));
    } else {
      result.push(p);
    }
  }
  return result;
}

export function createSpan(req: CreateSpanRequest): Span {
  const db = getDatabase();
  const id = ulid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO spans (id, trace_id, parent_span_id, actor_type, actor_name, payload, created_at)
    VALUES (@id, @trace_id, @parent_span_id, @actor_type, @actor_name, @payload, @created_at)
  `).run({
    id,
    trace_id: req.traceId,
    parent_span_id: req.parentSpanId ?? null,
    actor_type: req.actorType,
    actor_name: req.actorName,
    payload: toJson(req.payload ?? {}),
    created_at: now,
  });

  const created = getSpanById(id);
  if (!created) {
    throw new Error(`[traceService] Span 创建失败，id=${id}`);
  }

  // 方案B：从 tool span payload 自动提取文件路径，合并写入 traces.affected_files
  if (req.payload) {
    try {
      const trace = getTraceById(req.traceId);
      const files = extractFilesFromPayload(req.payload, trace?.workspacePath);
      if (files.length > 0) {
        updateTrace(req.traceId, { affectedFiles: files });
      }
    } catch (err) {
      // 非关键路径，失败不影响 span 写入
      console.warn(`[traceService] 提取 affected_files 失败: ${err}`);
    }
  }

  return created;
}

/**
 * 创建 Error Span。
 * 用于在 Agent 报错时记录错误详情、推理链、内存快照等信息。
 */
export function createErrorSpan(req: CreateErrorSpanRequest): Span {
  const db = getDatabase();
  const id = ulid();
  const now = new Date().toISOString();

  const payload: ErrorSpanPayload = {
    errorType: req.errorType,
    ...(req.stackTrace ? { stackTrace: req.stackTrace } : {}),
    ...(req.memorySnapshot ? { memorySnapshot: req.memorySnapshot } : {}),
    ...(req.diff ? { diff: req.diff } : {}),
    ...(req.reasoningChain ? { reasoningChain: req.reasoningChain } : {}),
  };

  db.prepare(`
    INSERT INTO spans (id, trace_id, parent_span_id, actor_type, actor_name, payload, created_at)
    VALUES (@id, @trace_id, @parent_span_id, @actor_type, @actor_name, @payload, @created_at)
  `).run({
    id,
    trace_id: req.traceId,
    parent_span_id: null,
    actor_type: 'error',
    actor_name: 'error',
    payload: toJson(payload),
    created_at: now,
  });

  const created = getSpanById(id);
  if (!created) {
    throw new Error(`[traceService] Error Span 创建失败，id=${id}`);
  }
  return created;
}

/**
 * 从 trace 的历史 spans 中构建推理链。
 */
export function buildReasoningChain(traceId: string): ReasoningChainStep[] {
  const spans = getSpansByTraceId(traceId);
  const reasoningChain: ReasoningChainStep[] = [];
  let step = 1;

  for (const span of spans) {
    if (span.actorType === 'agent' && span.payload) {
      const content = span.payload.content as string | undefined;
      const reasoning = span.payload.reasoning as string | undefined;
      if (content || reasoning) {
        reasoningChain.push({
          step: step++,
          thought: reasoning || content || '',
          action: (span.payload.toolName as string | undefined) || '思考',
        });
      }
    }
  }

  return reasoningChain;
}

export function getSpanById(id: string): Span | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM spans WHERE id = ?').get(id) as SpanRow | undefined;
  return row ? rowToSpan(row) : null;
}

export function getSpansByTraceId(traceId: string): Span[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM spans WHERE trace_id = ? ORDER BY created_at ASC
  `).all(traceId) as SpanRow[];
  return rows.map(rowToSpan);
}

export function deleteSpan(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM spans WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteSpansByTraceId(traceId: string): number {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM spans WHERE trace_id = ?').run(traceId);
  return result.changes;
}

// ─────────────────────────────────────────────
// Span Tree 构建
// ─────────────────────────────────────────────

export function buildSpanTree(traceId: string): SpanTreeNode[] {
  const spans = getSpansByTraceId(traceId);
  const spanMap = new Map<string, SpanTreeNode>();

  for (const span of spans) {
    spanMap.set(span.id, { ...span, children: [] });
  }

  const roots: SpanTreeNode[] = [];

  for (const span of spans) {
    const node = spanMap.get(span.id)!;
    if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
      const parent = spanMap.get(span.parentSpanId)!;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export function getSpanTree(traceId: string): SpanTreeNode[] {
  return buildSpanTree(traceId);
}

export function getFullSpanTree(traceId: string): {
  trace: Trace | null;
  tree: SpanTreeNode[];
} {
  const trace = getTraceById(traceId);
  if (!trace) {
    return { trace: null, tree: [] };
  }
  return { trace, tree: buildSpanTree(traceId) };
}

export function associateCommitsToTrace(
  traceId: string,
  commits: Array<{ commitHash: string; parentCommitHash?: string; workspacePath: string }>
): { success: boolean; spanIds: string[]; errors: string[] } {
  const db = getDatabase();
  const trace = getTraceById(traceId);
  if (!trace) {
    return { success: false, spanIds: [], errors: [`Trace ${traceId} 不存在`] };
  }

  const spanIds: string[] = [];
  const errors: string[] = [];

  for (const commit of commits) {
    try {
      const now = new Date().toISOString();
      const id = ulid();

      db.prepare(`
        INSERT INTO spans (id, trace_id, parent_span_id, actor_type, actor_name, payload, created_at)
        VALUES (@id, @trace_id, @parent_span_id, @actor_type, @actor_name, @payload, @created_at)
      `).run({
        id,
        trace_id: traceId,
        parent_span_id: null,
        actor_type: 'human',
        actor_name: 'git:human-override',
        payload: toJson({
          source: 'manual-associate',
          event: 'post-commit',
          commitHash: commit.commitHash,
          parentCommitHash: commit.parentCommitHash ?? null,
          workspacePath: commit.workspacePath,
          isHumanOverride: true,
        }),
        created_at: now,
      });

      spanIds.push(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Commit ${commit.commitHash}: ${msg}`);
    }
  }

  return { success: spanIds.length > 0, spanIds, errors };
}

/**
 * 搜索 traces 和 spans。
 * - keyword: 搜索 task_goal 和 payload 内容
 * - workspacePath: 过滤特定工作区
 * - limit: 返回最多 limit 条 trace
 */
export function searchTraces(filter: {
  keyword?: string;
  workspacePath?: string;
  commitHash?: string;
  source?: string;
  page?: number;
  pageSize?: number;
}): { data: Array<{ trace: Trace; spans: Span[] }>; total: number } {
  const db = getDatabase();
  const page = filter.page ?? 1;
  const pageSize = Math.min(filter.pageSize ?? 20, 100);
  const offset = (page - 1) * pageSize;

  let conditions: string[] = [];
  let params: Record<string, unknown> = {};

  // keyword 搜索：task_goal 和 payload JSON 内容
  if (filter.keyword) {
    // 搜索 task_goal 或 payload 中包含 keyword 的 trace
    conditions.push(`(
      traces.task_goal LIKE @keyword 
      OR EXISTS (
        SELECT 1 FROM spans 
        WHERE spans.trace_id = traces.id 
        AND spans.payload LIKE @keyword
      )
    )`);
    params.keyword = `%${filter.keyword}%`;
  }

  // workspacePath 过滤
  if (filter.workspacePath) {
    conditions.push(`EXISTS (
      SELECT 1 FROM spans 
      WHERE spans.trace_id = traces.id 
      AND spans.payload LIKE @workspacePath
    )`);
    params.workspacePath = `%${filter.workspacePath}%`;
  }

  // commitHash 过滤
  if (filter.commitHash) {
    conditions.push(`EXISTS (
      SELECT 1 FROM spans 
      WHERE spans.trace_id = traces.id 
      AND spans.payload LIKE @commitHash
    )`);
    params.commitHash = `%${filter.commitHash}%`;
  }

  // source 过滤
  if (filter.source) {
    conditions.push(`EXISTS (
      SELECT 1 FROM spans 
      WHERE spans.trace_id = traces.id 
      AND spans.payload LIKE @source
    )`);
    params.source = `%${filter.source}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // 查询匹配的 traces
  const countResult = db.prepare(`
    SELECT COUNT(DISTINCT traces.id) as total 
    FROM traces 
    LEFT JOIN spans ON spans.trace_id = traces.id 
    ${where}
  `).get(params) as { total: number };

  const traceRows = db.prepare(`
    SELECT DISTINCT traces.* 
    FROM traces 
    LEFT JOIN spans ON spans.trace_id = traces.id 
    ${where}
    ORDER BY traces.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset }) as TraceRow[];

  const traces = traceRows.map(rowToTrace);

  // 查询每个 trace 关联的 spans
  const results = traces.map((trace) => ({
    trace,
    spans: getSpansByTraceId(trace.id),
  }));

  return { data: results, total: countResult.total };
}

// ─────────────────────────────────────────────
// State Transitions (Stage 1 新增)
// ─────────────────────────────────────────────

/**
 * 将 trace 转为 pending_handoff 状态。
 * 用于 Agent 报错需要交接给人类的场景。
 */
export function transitionToHandoff(
  traceId: string,
  targetAgent: string,
  workspacePath?: string
): Trace | null {
  const trace = getTraceById(traceId);
  if (!trace) {
    console.log(`[traceService] transitionToHandoff: trace not found ${traceId}`);
    return null;
  }

  if (trace.status !== 'running' && trace.status !== 'in_progress') {
    console.log(`[traceService] transitionToHandoff: invalid status ${trace.status} for trace ${traceId}`);
    return null;
  }

  const updated = updateTrace(traceId, { status: 'pending_handoff' });
  console.log(`[traceService] transitionToHandoff: ${traceId} -> pending_handoff (target: ${targetAgent})`);
  return updated;
}

/**
 * 将 trace 转为 in_progress 状态。
 * 用于人类/新 Agent 接手继续工作的场景。
 */
export function transitionToInProgress(traceId: string): Trace | null {
  const trace = getTraceById(traceId);
  if (!trace) {
    console.log(`[traceService] transitionToInProgress: trace not found ${traceId}`);
    return null;
  }

  if (trace.status !== 'pending_handoff' && trace.status !== 'running') {
    console.log(`[traceService] transitionToInProgress: invalid status ${trace.status} for trace ${traceId}`);
    return null;
  }

  const updated = updateTrace(traceId, { status: 'in_progress' });
  console.log(`[traceService] transitionToInProgress: ${traceId} -> in_progress`);
  return updated;
}

/**
 * 将 trace 转为 completed 状态。
 */
export function transitionToCompleted(traceId: string): Trace | null {
  const trace = getTraceById(traceId);
  if (!trace) {
    return null;
  }

  const updated = updateTrace(traceId, { status: 'completed' });
  console.log(`[traceService] transitionToCompleted: ${traceId}`);
  return updated;
}

/**
 * 将 trace 转为 paused 状态。
 * 用于用户主动暂停的场景。
 */
export function transitionToPaused(traceId: string): Trace | null {
  const trace = getTraceById(traceId);
  if (!trace) {
    return null;
  }

  if (trace.status !== 'running' && trace.status !== 'in_progress') {
    return null;
  }

  const updated = updateTrace(traceId, { status: 'paused' });
  console.log(`[traceService] transitionToPaused: ${traceId}`);
  return updated;
}

/**
 * 从 paused 状态恢复为 running。
 */
export function transitionFromPaused(traceId: string): Trace | null {
  const trace = getTraceById(traceId);
  if (!trace || trace.status !== 'paused') {
    return null;
  }

  const updated = updateTrace(traceId, { status: 'running' });
  console.log(`[traceService] transitionFromPaused: ${traceId} -> running`);
  return updated;
}
