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
      }
    );
    return result.success;
  } catch (error) {
    console.error("[openclaw-agent-log] Failed to create span:", error);
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
    console.error("[openclaw-agent-log] Failed to finalize trace:", error);
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
    console.error("[openclaw-agent-log] Failed to create trace:", error);
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
    console.error("[openclaw-agent-log] Failed to update trace status:", error);
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

  console.log(`[openclaw-agent-log] Session started: ${sessionId}, trace: ${traceId} (source: ${source})`);
  return sessionId;
}

// ─────────────────────────────────────────────
// OpenClaw Hooks Implementation (Auto-Logging)
// ─────────────────────────────────────────────

export async function onSessionStart(params: {
  sessionKey: string;
  model: string;
  workspacePath?: string;
}): Promise<void> {
  const source = detectAgentSource();
  const workspace = params.workspacePath || process.cwd();
  await startSession(params.model, source, workspace);
  console.log(`[openclaw-agent-log] Session started for ${params.sessionKey}`);
}

export async function beforeToolCall(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
}): Promise<void> {
  if (!config.toolCallCapture) return;
  params.toolInput._agentlog_startTime = Date.now();
}

export async function afterToolCall(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: string;
  error?: string;
}): Promise<void> {
  if (!config.toolCallCapture) return;
  if (!currentSession) return;

  const startTime = params.toolInput._agentlog_startTime as number || Date.now();
  const durationMs = Date.now() - startTime;

  const toolCall: ToolCall = {
    name: params.toolName,
    input: params.toolInput,
    output: params.error || params.toolOutput,
    durationMs,
    timestamp: new Date().toISOString(),
  };

  currentSession.toolCalls.push(toolCall);

  // Create span via REST API
  await createSpan(currentSession.traceId, {
    role: "tool",
    content: JSON.stringify({ tool: params.toolName, input: params.toolInput, output: params.toolOutput }),
    tool_name: params.toolName,
    duration_ms: durationMs,
    timestamp: toolCall.timestamp,
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
      console.log(`[openclaw-agent-log] Bound session to commit ${commitHash.slice(0, 7)}`);
    }
  } catch {
    console.log("[openclaw-agent-log] No git commit to bind");
  }
}

export async function onAgentEnd(params: {
  messages: Array<{ role: string; content: string | Array<unknown> }>;
  usage?: { promptTokens?: number; completionTokens?: number };
}): Promise<void> {
  if (!currentSession) return;

  if (config.reasoningCapture) {
    extractReasoningFromMessages(params.messages);
  }

  await tryBindCommit();

  // Finalize trace via REST API (replaces log_intent)
  await finalizeTrace(
    currentSession.traceId,
    currentSession.taskGoal,
    currentSession.toolCalls.map((t) => String(t.input._agentlog_file || "")),
    currentSession.reasoning
  );

  console.log(`[openclaw-agent-log] Session ${currentSession.sessionId} finalized, trace ${currentSession.traceId} marked completed`);
  currentSession = null;
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

        console.log(`[openclaw-agent-log] Claimed trace: ${traceId} (agent: ${agentType})`);

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
    console.error(`[openclaw-agent-log] Query pending traces failed: ${err}`);
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

    console.log(`[openclaw-agent-log] Claimed trace: ${traceId} (agent: ${agentType})`);

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

    console.log(`[openclaw-agent-log] Completed session: ${sessionId}`);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Skill Metadata
// ─────────────────────────────────────────────

export const skillMetadata = {
  name: "openclaw-agent-log",
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

export default skillMetadata;
