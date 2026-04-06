/**
 * OpenClaw Agent Log Skill - Trace/Span Based Version
 *
 * 合并了:
 * - agentlog-auto: 自动存证 Hooks
 * - openclaw-agent: Trace Handoff 功能
 *
 * 使用 trace/span API 而非 sessions API：
 * - POST /api/traces - 创建 trace
 * - MCP log_turn - 创建 span
 * - PATCH /api/traces/:id - 更新 trace 状态
 *
 * 提供给 OpenClaw Agent 使用。
 */

import { randomUUID } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { PendingTraceEntry, ActiveSessionEntry, SessionsJson } from "@agentlog/shared";

// ─────────────────────────────────────────────
// Backend Configuration
// ─────────────────────────────────────────────

const BACKEND_URL = process.env.AGENTLOG_BACKEND_URL ?? "http://localhost:7892";
const MCP_URL = process.env.AGENTLOG_MCP_URL ?? "http://localhost:7892";

// ─────────────────────────────────────────────
// Trace/Span Types
// ─────────────────────────────────────────────

interface Trace {
  id: string;
  parentTraceId: string | null;
  taskGoal: string;
  status: "running" | "pending_handoff" | "in_progress" | "completed" | "failed" | "paused";
  workspacePath: string | null;
  affectedFiles: string[];
  createdAt: string;
  updatedAt: string;
  hasCommit: boolean;
}

interface TraceHandoffResult {
  success: boolean;
  traceId?: string;
  sessionId?: string;
  error?: string;
}

interface TraceSearchResult {
  traceId: string;
  taskGoal: string;
  targetAgent: string;
  createdAt: string;
  score?: number;
}

// ─────────────────────────────────────────────
// Agent Source Detection
// ─────────────────────────────────────────────

function detectAgentSource(): string {
  // 从 workspace 路径推断 agent 类型
  // 路径格式: /home/hobo/.openclaw/agents/<agent-name>/workspace
  const workspacePath = process.cwd();
  const match = workspacePath.match(/\/agents\/([^\/]+)\/workspace/);
  if (match) {
    return `openclaw:${match[1]}`;
  }

  // Fallback: 环境变量
  const agentId = process.env.AGENTLOG_AGENT_ID || process.env.AGENT || "";
  if (agentId) {
    return `openclaw:${agentId}`;
  }

  return "unknown";
}

function detectAgentType(): string {
  const workspacePath = process.cwd();
  const match = workspacePath.match(/\/agents\/([^\/]+)\/workspace/);
  if (match) {
    return match[1];
  }
  return process.env.AGENTLOG_AGENT_ID || "unknown";
}

// ─────────────────────────────────────────────
// Auto-Logging Types
// ─────────────────────────────────────────────

interface AgentLogConfig {
  mcpUrl: string;
  autoBindCommit: boolean;
  reasoningCapture: boolean;
  toolCallCapture: boolean;
  sessionTimeout: number;
}

interface SessionState {
  traceId: string;
  sessionId: string;
  startedAt: string;
  reasoning: string[];
  toolCalls: ToolCall[];
  responses: Response[];
  model: string;
  agentSource: string;
  workspacePath: string;
  taskGoal: string;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output?: string;
  durationMs: number;
  timestamp: string;
}

interface Response {
  content: string;
  timestamp: string;
}

// ─────────────────────────────────────────────
// Auto-Logging State
// ─────────────────────────────────────────────

let config: AgentLogConfig = {
  mcpUrl: MCP_URL,
  autoBindCommit: true,
  reasoningCapture: true,
  toolCallCapture: true,
  sessionTimeout: 600,
};

let currentSession: SessionState | null = null;
const sessionByTraceId: Map<string, SessionState> = new Map();
const toolCallTimings: Map<string, number> = new Map();

// Pre-flight trace ID：在 onSessionStart 同步阶段生成，写入 process.env.AGENTLOG_TRACE_ID
// 供 buildResetSessionNoticeText（dist）在发送飞书消息时读取。
// 当 startSession() 拿到真实后端 ULID 后会覆盖此值。
let preflightTraceId: string | null = null;

// ─────────────────────────────────────────────
// sessions.json Operations (for Trace Handoff)
// ─────────────────────────────────────────────

async function getSessionsJsonPath(workspacePath: string): Promise<string> {
  const { execSync } = await import("child_process");
  const gitCommonDir = execSync(
    "git rev-parse --git-common-dir",
    { cwd: workspacePath, encoding: "utf-8" }
  ).trim();
  return path.join(gitCommonDir, "agentlog", "sessions.json");
}

function readSessionsJson(sessionsJsonPath: string): SessionsJson {
  if (!fs.existsSync(sessionsJsonPath)) {
    return { pending: {}, active: {} };
  }
  try {
    const content = fs.readFileSync(sessionsJsonPath, "utf-8");
    return JSON.parse(content) as SessionsJson;
  } catch {
    return { pending: {}, active: {} };
  }
}

function writeSessionsJson(sessionsJsonPath: string, data: SessionsJson): void {
  const dir = path.dirname(sessionsJsonPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${sessionsJsonPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, sessionsJsonPath);
}

// ─────────────────────────────────────────────
// Backend API Request
// ─────────────────────────────────────────────

async function apiRequest<T>(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const url = `${BACKEND_URL}${endpoint}`;
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`API 错误: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

// ─────────────────────────────────────────────
// MCP Request (for log_turn/log_intent spans)
// ─────────────────────────────────────────────

// Create span via REST API (replaces log_turn MCP call)
async function createSpan(traceId: string, span: {
  role: string;
  content: string;
  tool_name?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  duration_ms?: number;
  timestamp?: string;
}): Promise<boolean> {
  try {
    const result = await apiRequest<{ success: boolean }>(
      "POST",
      "/api/spans",
      {
        traceId,
        actorType: span.role === "tool" ? "agent" : span.role,
        actorName: span.tool_name || "agent",
        payload: {
          event: span.role,
          content: span.content,
          toolName: span.tool_name,
          durationMs: span.duration_ms,
          timestamp: span.timestamp || new Date().toISOString(),
        },
        toolName: span.tool_name,
        toolInput: span.toolInput,
        toolResult: span.toolResult,
      }
    );
    return result.success;
  } catch (error) {
    console.error("[openclaw-agentlog] Failed to create span:", error);
    return false;
  }
}

// Update trace status via REST API (replaces log_intent MCP call)
async function finalizeTrace(
  traceId: string,
  taskGoal: string,
  affectedFiles: string[],
  reasoning: string[]
): Promise<boolean> {
  try {
    const result = await apiRequest<{ success: boolean }>(
      "PATCH",
      `/api/traces/${traceId}`,
      {
        status: "completed",
        taskGoal,
        affectedFiles,
        reasoningSummary: reasoning.join("\n\n"),
      }
    );
    return result.success;
  } catch (error) {
    console.error("[openclaw-agentlog] Failed to finalize trace:", error);
    return false;
  }
}

// ─────────────────────────────────────────────
// Trace Operations (using REST API)
// ─────────────────────────────────────────────

async function createTrace(taskGoal: string, workspacePath: string): Promise<Trace | null> {
  try {
    const result = await apiRequest<{ success: boolean; data: Trace }>(
      "POST",
      "/api/traces",
      { taskGoal, workspacePath }
    );
    return result.data;
  } catch (error) {
    console.error("[openclaw-agentlog] Failed to create trace:", error);
    return null;
  }
}

async function updateTraceStatus(traceId: string, status: string): Promise<boolean> {
  try {
    const result = await apiRequest<{ success: boolean }>(
      "PATCH",
      `/api/traces/${traceId}`,
      { status }
    );
    return result.success;
  } catch (error) {
    console.error("[openclaw-agentlog] Failed to update trace status:", error);
    return false;
  }
}

// ─────────────────────────────────────────────
// Session Management (Auto-Logging with Traces)
// ─────────────────────────────────────────────

async function startSession(model: string, source: string, workspacePath: string): Promise<string> {
  const sessionId = `sess_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const taskGoal = `Agent session from ${source}`;

  // Create trace via REST API
  const trace = await createTrace(taskGoal, workspacePath);
  const traceId = trace?.id || `trace_${Date.now()}`;

  // 拿到真实后端 ULID 后，更新 env var 供调试使用（覆盖 onSessionStart 写入的 pre-flight ID）
  process.env.AGENTLOG_TRACE_ID = traceId;
  preflightTraceId = null;

  currentSession = {
    traceId,
    sessionId,
    startedAt: new Date().toISOString(),
    reasoning: [],
    toolCalls: [],
    responses: [],
    model,
    agentSource: source,
    workspacePath,
    taskGoal,
  };
  
  sessionByTraceId.set(traceId, currentSession);

  console.log(`[openclaw-agentlog] Session started: ${sessionId}, trace: ${traceId} (source: ${source})`);
  return sessionId;
}

// ─────────────────────────────────────────────
// OpenClaw Hooks Implementation (Auto-Logging)
// ─────────────────────────────────────────────

export async function onBeforeAgentStart(
  event: { sessionId?: string; sessionKey?: string },
  ctx: { agentId?: string; sessionId?: string; sessionKey?: string; traceId?: string }
): Promise<void> {
  console.log(`[openclaw-agentlog][DEBUG] before_agent_start hook fired! event=`, JSON.stringify(event), 'ctx=', JSON.stringify(ctx));
  const agentId = ctx.agentId || detectAgentType();
  const source = `openclaw:${agentId}`;
  const workspace = process.cwd();
  const model = agentId;
  
  // Check if we already have a session for this traceId
  if (ctx.traceId && sessionByTraceId.has(ctx.traceId)) {
    currentSession = sessionByTraceId.get(ctx.traceId) || null;
    return;
  }
  
  if (!currentSession) {
    await startSession(model, source, workspace);
    console.log(`[openclaw-agentlog] Created session via before_agent_start, agent: ${agentId}`);
  }
}

/**
 * session_start hook
 *
 * ⚠️  触发时机说明（与 before_agent_start 不同）：
 *
 * session_start 是一个 session 生命周期事件，仅在以下情况触发：
 *   1. 某个 sessionKey 的第一条消息（全新会话）
 *   2. 用户发送 /new 或 /reset 命令（主动重置）
 *   3. session 长时间空闲后超时重置的首条消息
 *
 * 对于正在进行中的会话，每条普通消息只触发 before_agent_start，
 * 不会再次触发 session_start。
 *
 * 因此本插件的主要 per-turn 记录逻辑在 before_agent_start 中实现。
 * session_start 此处仅做补充记录（例如覆盖 resumedFrom 信息）。
 *
 * 参考：openclaw src/auto-reply/reply/session.ts initSessionState()
 */
export async function onSessionStart(
  event: { sessionId: string; sessionKey?: string; resumedFrom?: string },
  ctx: { agentId?: string; sessionId: string; sessionKey?: string }
): Promise<void> {
  // ─── 同步区域（在第一个 await 之前）────────────────────────────────────────
  // 此处代码在 runSessionStart() 被 fire-and-forget 调用后、sendResetSessionNotice()
  // 执行之前同步运行，因此可以安全地向 process.env 写入 trace ID 供消息模板读取。
  const agentId = ctx.agentId || detectAgentType();
  const sessionKey = event.sessionKey || ctx.sessionKey || event.sessionId;
  if (!preflightTraceId && !currentSession) {
    // 生成短格式 pre-flight ID（可读性优先，后续会被真实 ULID 覆盖）
    preflightTraceId = `agentlog-${Date.now().toString(36).slice(-6)}`;
    process.env.AGENTLOG_TRACE_ID = preflightTraceId;
  }
  // ─────────────────────────────────────────────────────────────────────────

  console.log(`[openclaw-agentlog][DEBUG] session_start hook fired! event=`, JSON.stringify(event), 'ctx=', JSON.stringify(ctx));
  const source = `openclaw:${agentId}`;
  const workspace = process.cwd();
  const model = agentId;

  // session_start 触发时 before_agent_start 可能尚未执行（取决于调用时序）。
  // 若当前已有 session（before_agent_start 已建立），则跳过，避免重复创建 trace。
  if (!currentSession) {
    await startSession(model, source, workspace);
    // startSession() 完成后 AGENTLOG_TRACE_ID 已更新为真实 ULID
    console.log(`[openclaw-agentlog] Session started via session_start for ${sessionKey}, agent: ${agentId}, trace: ${process.env.AGENTLOG_TRACE_ID}`);
  } else {
    preflightTraceId = null; // 已有 session，清理 pre-flight ID
    console.log(`[openclaw-agentlog] session_start: session already exists (created by before_agent_start), skipping trace creation for ${sessionKey}`);
  }
}

export async function beforeToolCall(
  event: { toolName?: string; toolInput?: Record<string, unknown>; input?: Record<string, unknown> },
  ctx: { traceId?: string }
): Promise<void> {
  console.log(`[openclaw-agentlog][DEBUG] before_tool_call hook fired! event=`, JSON.stringify({toolName: event.toolName, hasInput: !!(event.toolInput || event.input)}));
  if (!config.toolCallCapture) return;
  const toolName = event.toolName || 'unknown';
  const key = `${toolName}:${Date.now()}`;
  toolCallTimings.set(key, Date.now());
  // Store the key in the event for afterToolCall to use
  (event as Record<string, unknown>)._agentlog_key = key;
  (event as Record<string, unknown>)._agentlog_traceId = ctx.traceId;
}

export async function afterToolCall(
  event: {
    toolName?: string;
    toolInput?: Record<string, unknown>;
    input?: Record<string, unknown>;
    toolOutput?: string;
    error?: string;
  },
  ctx: { sessionId?: string; traceId?: string }
): Promise<void> {
  console.log(`[openclaw-agentlog][DEBUG] after_tool_call hook fired! event=`, JSON.stringify({toolName: event.toolName, hasInput: !!(event.toolInput || event.input), hasOutput: !!(event.toolOutput || event.error)}));
  if (!config.toolCallCapture) return;

  const input = event.toolInput || event.input;
  const toolName = event.toolName || 'unknown';
  const timestamp = new Date().toISOString();
  
  // Get start time from Map using the key stored in beforeToolCall
  const key = (event as Record<string, unknown>)._agentlog_key as string || `${toolName}:unknown`;
  const startTime = toolCallTimings.get(key) || Date.now();
  toolCallTimings.delete(key); // Clean up
  const durationMs = Date.now() - startTime;

  // Try to find session
  let session = currentSession;
  if (!session && ctx.traceId) {
    session = sessionByTraceId.get(ctx.traceId) || null;
  }

  // If still no session, skip
  if (!session) {
    console.log(`[openclaw-agentlog][DEBUG] after_tool_call: no session found for traceId=${ctx.traceId}`);
    return;
  }

  const toolCallRecord: ToolCall = {
    name: toolName,
    input: input || {},
    output: event.error || event.toolOutput,
    durationMs,
    timestamp,
  };

  session.toolCalls.push(toolCallRecord);

  await createSpan(session.traceId, {
    role: "tool",
    content: JSON.stringify({ tool: event.toolName }),
    tool_name: event.toolName,
    toolInput: input || undefined,
    toolResult: event.error || event.toolOutput,
    duration_ms: durationMs,
    timestamp,
  });
}

function extractReasoningFromMessages(
  messages: Array<{ role: string; content: string | Array<unknown> }>
): void {
  if (!currentSession) return;

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;

    if (typeof msg.content === "string") {
      const reasoning = extractReasoningFromText(msg.content);
      if (reasoning) {
        currentSession.reasoning.push(reasoning);
      }
      continue;
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;

        if (b.type === "thinking" || b.type === "thought" || b.type === "reasoning") {
          const thinking =
            typeof b.thinking === "string"
              ? b.thinking
              : typeof b.content === "string"
              ? b.content
              : typeof b.text === "string"
              ? b.text
              : JSON.stringify(b);
          if (thinking) {
            currentSession.reasoning.push(thinking.slice(0, 4000));
          }
        }

        if (b.type === "text" && typeof b.text === "string") {
          const reasoning = extractReasoningFromText(b.text);
          if (reasoning) {
            currentSession.reasoning.push(reasoning);
          }
        }
      }
    }
  }
}

function extractReasoningFromText(text: string): string | null {
  const thinkingMatch = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (thinkingMatch && thinkingMatch[1].trim()) {
    return thinkingMatch[1].trim().slice(0, 4000);
  }
  const reasoningMatch = text.match(/\[REASONING\]([\s\S]*?)\[\/REASONING\]/i);
  if (reasoningMatch && reasoningMatch[1].trim()) {
    return reasoningMatch[1].trim().slice(0, 4000);
  }
  return null;
}

async function tryBindCommit(): Promise<void> {
  if (!config.autoBindCommit || !currentSession) return;

  try {
    const { execSync } = await import("child_process");
    const commitHash = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      cwd: currentSession.workspacePath,
    }).trim();

    if (commitHash) {
      console.log(`[openclaw-agentlog] Bound session to commit ${commitHash.slice(0, 7)}`);
    }
  } catch {
    console.log("[openclaw-agentlog] No git commit to bind");
  }
}

export async function onAgentEnd(
  event: {
    messages: Array<{ role: string; content: string | Array<unknown> }>;
    usage?: { promptTokens?: number; completionTokens?: number };
  },
  ctx: { traceId?: string }
): Promise<void> {
  console.log(`[openclaw-agentlog][DEBUG] agent_end hook fired! hasMessages=${event.messages?.length}, hasUsage=${!!event.usage}`);
  
  // Try to find session
  let session = currentSession;
  if (!session && ctx.traceId) {
    session = sessionByTraceId.get(ctx.traceId) || null;
  }
  
  if (!session) {
    console.log(`[openclaw-agentlog][DEBUG] agent_end skipped: no currentSession`);
    return;
  }

  if (config.reasoningCapture) {
    extractReasoningFromMessages(event.messages);
  }

  await tryBindCommit();

  await finalizeTrace(
    session.traceId,
    session.taskGoal,
    session.toolCalls.map((t) => String(t.input._agentlog_file || "")),
    session.reasoning
  );

  console.log(`[openclaw-agentlog] Session ${session.sessionId} finalized, trace ${session.traceId} marked completed`);
  
  // Clean up
  sessionByTraceId.delete(session.traceId);
  if (currentSession === session) {
    currentSession = null;
  }
}

// ─────────────────────────────────────────────
// Trace Handoff Functions (from openclaw-agent)
// ─────────────────────────────────────────────

export async function checkAndClaimTrace(
  workspacePath: string,
  agentType: string
): Promise<TraceHandoffResult> {
  try {
    const sessionsJsonPath = await getSessionsJsonPath(workspacePath);
    const sessions = readSessionsJson(sessionsJsonPath);

    for (const [traceId, entry] of Object.entries(sessions.pending)) {
      if (entry.worktree && entry.worktree !== workspacePath) {
        continue;
      }

      if (entry.targetAgent === agentType) {
        const sessionId = nanoid();
        const activeEntry: ActiveSessionEntry = {
          sessionId,
          traceId,
          agentType,
          status: "active",
          startedAt: new Date().toISOString(),
          worktree: workspacePath,
        };

        delete sessions.pending[traceId];
        sessions.active[sessionId] = activeEntry;
        writeSessionsJson(sessionsJsonPath, sessions);

        process.env.AGENTLOG_TRACE_ID = traceId;

        // Update trace status to in_progress
        await updateTraceStatus(traceId, "in_progress");

        console.log(`[openclaw-agentlog] Claimed trace: ${traceId} (agent: ${agentType})`);

        return { success: true, traceId, sessionId };
      }
    }

    return { success: false, error: "没有找到匹配的 pending trace" };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function extractTraceIdFromMessage(message: string): string | null {
  const patterns = [
    /Trace[:\s]+([A-Z0-9]+)/i,
    /trace[-_]?id[:\s]+([A-Z0-9]+)/i,
    /\[([A-Z0-9]{26})\]/,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

export async function queryPendingTraces(
  workspacePath: string,
  agentType?: string
): Promise<TraceSearchResult[]> {
  try {
    const params = new URLSearchParams({ workspacePath });
    if (agentType) params.set("agentType", agentType);

    const response = await apiRequest<{
      success: boolean;
      data: Array<{ traceId: string; entry: PendingTraceEntry }>;
    }>("GET", `/api/traces/pending?${params.toString()}`);

    return response.data.map((item) => ({
      traceId: item.traceId,
      taskGoal: item.entry.taskGoal ?? "",
      targetAgent: item.entry.targetAgent,
      createdAt: item.entry.createdAt,
    }));
  } catch (err) {
    console.error(`[openclaw-agentlog] Query pending traces failed: ${err}`);
    return [];
  }
}

export async function claimTrace(
  traceId: string,
  agentType: string,
  workspacePath: string
): Promise<TraceHandoffResult> {
  try {
    const sessionsJsonPath = await getSessionsJsonPath(workspacePath);
    const sessions = readSessionsJson(sessionsJsonPath);

    if (!sessions.pending[traceId]) {
      return { success: false, error: "Trace 不在 pending 状态" };
    }

    const sessionId = nanoid();
    const activeEntry: ActiveSessionEntry = {
      sessionId,
      traceId,
      agentType,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    delete sessions.pending[traceId];
    sessions.active[sessionId] = activeEntry;
    writeSessionsJson(sessionsJsonPath, sessions);

    process.env.AGENTLOG_TRACE_ID = traceId;

    // Update trace status to in_progress
    await updateTraceStatus(traceId, "in_progress");

    // Also notify backend via API
    try {
      await apiRequest("POST", `/api/traces/${traceId}/resume`, {
        agentType,
        workspacePath,
      });
    } catch {
      // API call failure doesn't affect local state
    }

    console.log(`[openclaw-agentlog] Claimed trace: ${traceId} (agent: ${agentType})`);

    return { success: true, traceId, sessionId };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getActiveSession(
  workspacePath: string
): Promise<ActiveSessionEntry | null> {
  try {
    const sessionsJsonPath = await getSessionsJsonPath(workspacePath);
    const sessions = readSessionsJson(sessionsJsonPath);
    const activeEntries = Object.values(sessions.active);
    return activeEntries.length > 0 ? activeEntries[0] : null;
  } catch {
    return null;
  }
}

export async function completeActiveSession(workspacePath: string): Promise<boolean> {
  try {
    const sessionsJsonPath = await getSessionsJsonPath(workspacePath);
    const sessions = readSessionsJson(sessionsJsonPath);

    const activeEntries = Object.values(sessions.active);
    if (activeEntries.length === 0) {
      return false;
    }

    const sessionId = activeEntries[0].sessionId;
    const traceId = activeEntries[0].traceId;
    delete sessions.active[sessionId];
    writeSessionsJson(sessionsJsonPath, sessions);

    // Update trace status to completed
    if (traceId) {
      await updateTraceStatus(traceId, "completed");
    }

    console.log(`[openclaw-agentlog] Completed session: ${sessionId}`);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Skill Metadata
// ─────────────────────────────────────────────

export const skillMetadata = {
  name: "openclaw-agentlog",
  description: "OpenClaw Agent 自动存证与 Trace 生命周期管理 - 使用 trace/span API",
  version: "2.0.0",
  functions: [
    {
      name: "checkAndClaimTrace",
      description: "启动时检查并认领 pending traces",
      parameters: {
        type: "object",
        properties: {
          workspacePath: { type: "string", description: "工作区路径" },
          agentType: { type: "string", description: "Agent 类型" },
        },
        required: ["workspacePath", "agentType"],
      },
    },
    {
      name: "claimTrace",
      description: "认领 trace",
      parameters: {
        type: "object",
        properties: {
          traceId: { type: "string", description: "Trace ID" },
          agentType: { type: "string", description: "Agent 类型" },
          workspacePath: { type: "string", description: "工作区路径" },
        },
        required: ["traceId", "agentType", "workspacePath"],
      },
    },
    {
      name: "completeActiveSession",
      description: "完成当前 session",
      parameters: {
        type: "object",
        properties: {
          workspacePath: { type: "string", description: "工作区路径" },
        },
        required: ["workspacePath"],
      },
    },
  ],
};

/**
 * session_end hook
 *
 * 在 session 生命周期结束时触发（与 session_start 对应）。
 * 触发时机：用户发送 /new 或 /reset、session 超时后，下一条消息开始前。
 *
 * 注意：agent_end 已经处理了 per-turn 的 trace 归档和 currentSession 清理。
 * session_end 主要用于处理 session 重置时 agent_end 未能清理的残留状态
 * （例如用户直接 /new 而 agent 尚未完成上一轮时）。
 */
export async function onSessionEnd(
  _event: unknown,
  _ctx: unknown
): Promise<void> {
  console.log('[openclaw-agentlog][DEBUG] session_end hook fired!');
  // 若 agent_end 未能清理（如 session 在 agent 运行中被重置），在此兜底清理
  if (currentSession) {
    console.log(`[openclaw-agentlog] session_end: cleaning up residual session ${currentSession.sessionId}`);
    sessionByTraceId.delete(currentSession.traceId);
    currentSession = null;
  }
}

export function register(api: {
  on(event: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }): void;
  registerHook(event: string, handler: (...args: unknown[]) => unknown, opts?: { name?: string; description?: string }): void;
}): void {
  api.on('before_agent_start', onBeforeAgentStart);
  api.on('session_start', onSessionStart);
  api.on('before_tool_call', beforeToolCall);
  api.on('after_tool_call', afterToolCall);
  api.on('agent_end', onAgentEnd);
  api.on('session_end', onSessionEnd);
}

export default { register, skillMetadata, hooks: {
  before_agent_start: onBeforeAgentStart,
  session_start: onSessionStart,
  before_tool_call: beforeToolCall,
  after_tool_call: afterToolCall,
  agent_end: onAgentEnd,
  session_end: onSessionEnd,
}};
