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

export type TraceStatus = 'running' | 'completed' | 'failed' | 'paused';

export interface Trace {
  id: string;
  taskGoal: string;
  status: TraceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTraceRequest {
  taskGoal: string;
  status?: TraceStatus;
}

export interface UpdateTraceRequest {
  taskGoal?: string;
  status?: TraceStatus;
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

// ─────────────────────────────────────────────
// 行 → 实体 映射
// ─────────────────────────────────────────────

function rowToTrace(row: TraceRow): Trace {
  return {
    id: row.id,
    taskGoal: row.task_goal,
    status: row.status as TraceStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

  db.prepare(`
    INSERT INTO traces (id, task_goal, status, created_at, updated_at)
    VALUES (@id, @task_goal, @status, @created_at, @updated_at)
  `).run({
    id,
    task_goal: req.taskGoal,
    status,
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

  db.prepare(`
    UPDATE traces SET task_goal = @task_goal, status = @status, updated_at = @updated_at
    WHERE id = @id
  `).run({
    id,
    task_goal: taskGoal,
    status,
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
} = {}): { data: Trace[]; total: number; page: number; pageSize: number } {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

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

  return { data: rows.map(rowToTrace), total, page, pageSize };
}

// ─────────────────────────────────────────────
// Span CRUD
// ─────────────────────────────────────────────

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
  return created;
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
