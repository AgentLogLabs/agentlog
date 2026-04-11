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

let currentAgentId: string | null = null;
let currentAgentType: string | null = null;

function setAgentContext(agentId?: string, agentType?: string): void {
  if (agentId) currentAgentId = agentId;
  if (agentType) currentAgentType = agentType;
}

async function getGitRemoteUrl(cwd: string): Promise<string> {
  try {
    const { execSync } = await import("child_process");
    const remoteUrl = execSync("git remote get-url origin", {
      encoding: "utf-8",
      cwd,
    }).trim();
    return remoteUrl;
  } catch {
    return cwd;
  }
}

async function detectAgentSource(): Promise<string> {
  if (currentAgentType) {
    return `openclaw:${currentAgentType}`;
  }

  const workspacePath = process.cwd();
  const gitRemoteUrl = await getGitRemoteUrl(workspacePath);
  const match = gitRemoteUrl.match(/\/agents\/([^\/]+)\.git$/);
  if (match) {
    return `openclaw:${match[1]}`;
  }

  const agentId = process.env.AGENTLOG_AGENT_ID || process.env.AGENT || "";
  if (agentId) {
    return `openclaw:${agentId}`;
  }

  return "unknown";
}

function detectAgentType(): string {
  if (currentAgentType) return currentAgentType;
  
  const workspacePath = process.cwd();
  const match = workspacePath.match(/\/agents\/([^\/]+)\/workspace/);
  if (match) {
    return match[1];
  }
  return process.env.AGENTLOG_AGENT_ID || "unknown";
}

/**
 * 获取工作区的唯一标识符。
 * - 优先使用 git remote URL（支持跨机器协作）
 * - 非 git 仓库 fallback 到 cwd
 */
async function getWorkspaceIdentifier(cwd: string): Promise<string> {
  const gitRemoteUrl = await getGitRemoteUrl(cwd);
  return gitRemoteUrl || cwd;
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
  pendingTokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
  pendingModel?: string;
  lastUserSpanTime?: number;
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
let lastProcessedMessageId: string | null = null;

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

  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
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
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
  model?: string;
  source?: string;
}): Promise<boolean> {
  const roleToActorType = (role: string): string => {
    switch (role) {
      case "user":
      case "human":
        return "human";
      case "assistant":
      case "tool":
      case "agent":
        return "agent";
      case "system":
        return "system";
      default:
        return "agent";
    }
  };

  try {
    const result = await apiRequest<{ success: boolean }>(
      "POST",
      "/api/spans",
      {
        traceId,
        actorType: roleToActorType(span.role),
        actorName: span.tool_name || "agent",
        payload: {
          event: span.role,
          content: span.content,
          toolName: span.tool_name,
          durationMs: span.duration_ms,
          timestamp: span.timestamp || new Date().toISOString(),
          tokenUsage: span.tokenUsage,
          model: span.model,
          source: span.source,
        },
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

async function startSession(model: string, source: string, workspacePath: string, taskGoal?: string): Promise<string> {
  const sessionId = `sess_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const goal = taskGoal || `Agent session from ${source}`;

  // Use git remote URL as workspace identifier (for cross-machine collaboration)
  const workspaceIdentifier = await getWorkspaceIdentifier(workspacePath);

  // Create trace via REST API - use git remote URL as workspace identifier
  const trace = await createTrace(goal, workspaceIdentifier);
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
    taskGoal: goal,
    pendingTokenUsage: undefined,
    pendingModel: undefined,
    lastUserSpanTime: undefined,
  };

  console.log(`[openclaw-agentlog] Session started: ${sessionId}, trace: ${traceId} (source: ${source})`);
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
  console.log(`[openclaw-agentlog] Session started for ${params.sessionKey}`);
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
    model: currentSession.model,
    source: currentSession.agentSource,
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

export async function onAgentEnd(params: {
  messages: Array<{ role: string; content: string | Array<unknown> }>;
  usage?: { promptTokens?: number; completionTokens?: number };
}): Promise<void> {
  if (!currentSession) return;

  if (config.reasoningCapture) {
    extractReasoningFromMessages(params.messages);
  }

  // 优先使用 onLlmOutput 传递的精确 token usage，否则使用 onAgentEnd 的
  const tokenUsage = currentSession.pendingTokenUsage || (params.usage ? {
    inputTokens: params.usage.promptTokens,
    outputTokens: params.usage.completionTokens,
  } : undefined);

  const model = currentSession.pendingModel || currentSession.model;

  // Create span for LLM output (even if no tools were called)
  await createLlmOutputSpan(params.messages, tokenUsage, model);

  await tryBindCommit();

  // Finalize trace via REST API (replaces log_intent)
  await finalizeTrace(
    currentSession.traceId,
    currentSession.taskGoal,
    currentSession.toolCalls.map((t) => String(t.input._agentlog_file || "")),
    currentSession.reasoning
  );

  console.log(`[openclaw-agentlog] Session ${currentSession.sessionId} finalized, trace ${currentSession.traceId} marked completed${tokenUsage ? `, tokens: in=${tokenUsage.inputTokens} out=${tokenUsage.outputTokens}` : ''}`);
  currentSession = null;
}

// Create span for LLM output
async function createLlmOutputSpan(
  messages: Array<{ role: string; content: string | Array<unknown> }>,
  tokenUsage?: { inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number },
  model?: string
): Promise<void> {
  if (!currentSession) return;

  // Get the last assistant message as the output
  let assistantContent = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        if (msg.content.trim() && !msg.content.includes("NO_REPLY")) {
          assistantContent = msg.content;
          break;
        }
      }
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content
          .filter((b): b is { type: string; text: string } =>
            typeof b === "object" && b !== null && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string"
          )
          .map(b => (b as { text: string }).text)
          .filter(t => t.trim() && !t.includes("NO_REPLY"));
        if (textBlocks.length > 0) {
          assistantContent = textBlocks.join("\n");
          break;
        }
      }
    }
  }

  if (!assistantContent) {
    console.log(`[openclaw-agentlog] Skipped assistant span - no valid content (messages count: ${messages.length})`);
    return;
  }

  // 确保 model 有有效值
  const effectiveModel = (model && model !== "unknown") 
    ? model 
    : (currentSession.model && currentSession.model !== "unknown")
      ? currentSession.model
      : currentSession.agentSource.replace("openclaw:", "") || "unknown";

  await createSpan(currentSession.traceId, {
    role: "assistant",
    content: assistantContent.slice(0, 2000),
    duration_ms: 0,
    timestamp: new Date().toISOString(),
    tokenUsage,
    model: effectiveModel,
    source: currentSession.agentSource,
  });
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

// onSessionEnd hook
export async function onSessionEnd(): Promise<void> {
  console.log('[openclaw-agentlog] Session cleanup completed');
}

export async function onBeforeAgentStart(params: {
  prompt: string;
  messages?: unknown[];
}): Promise<void> {
  const source = await detectAgentSource();
  const workspacePath = process.cwd();

  // 检测是否为由 OpenClaw 内部机制（如 boot check）触发的自动运行
  const lowerPrompt = params.prompt?.toLowerCase() || "";
  const isBootCheck = lowerPrompt.includes('boot check') || 
                      lowerPrompt.includes('boot.md') ||
                      lowerPrompt.includes('running a boot');
  
  if (isBootCheck) {
    console.log(`[openclaw-agentlog] Skipped auto-triggered session (boot check) for ${source}`);
    return;
  }

  // 从 prompt 中提取 message_id 进行去重
  const messageIdMatch = params.prompt?.match(/"message_id"\s*:\s*"([^"]+)"/);
  const currentMessageId = messageIdMatch ? messageIdMatch[1] : null;
  
  // 如果有之前处理过的 message_id 且与当前相同，跳过创建新 session
  if (currentMessageId && lastProcessedMessageId === currentMessageId) {
    console.log(`[openclaw-agentlog] Skipped duplicate session for message_id: ${currentMessageId}`);
    return;
  }

  // 更新 lastProcessedMessageId
  if (currentMessageId) {
    lastProcessedMessageId = currentMessageId;
  }

  // 调试日志：记录完整的 params 以分析触发原因
  console.log(`[openclaw-agentlog] before_agent_start called, prompt length: ${params.prompt?.length || 0}, messages count: ${params.messages?.length || 0}`);
  console.log(`[openclaw-agentlog] before_agent_start prompt preview: ${params.prompt?.slice(0, 200) || 'empty'}`);
  if (params.messages && params.messages.length > 0) {
    console.log(`[openclaw-agentlog] before_agent_start messages preview: ${JSON.stringify(params.messages.slice(0, 2)).slice(0, 300)}`);
  }

  // 复用已存在的 session（避免重复创建 trace）
  if (currentSession) {
    const userInput = extractUserInput(params.prompt);
    if (userInput && currentSession) {
      // 检查最近添加 user span 的时间，避免短时间内重复添加
      const now = Date.now();
      const lastUserSpanTime = currentSession.lastUserSpanTime || 0;
      if (now - lastUserSpanTime > 5000) { // 5秒内不重复添加
        // 确保 model 有有效值
        const effectiveModel = (currentSession.model && currentSession.model !== "unknown")
          ? currentSession.model
          : currentSession.agentSource.replace("openclaw:", "") || "unknown";
        await createSpan(currentSession.traceId, {
          role: "user",
          content: userInput.slice(0, 2000),
          duration_ms: 0,
          timestamp: new Date().toISOString(),
          model: effectiveModel,
          source: source,
        });
        currentSession.lastUserSpanTime = now;
        console.log(`[openclaw-agentlog] User input span added to existing session: ${currentSession.traceId}`);
      }
    }
    return;
  }

  const userInput = extractUserInput(params.prompt);
  const taskGoal = userInput ? summarizeUserInput(userInput) : `Agent session from ${source}`;

  await startSession("unknown", source, workspacePath, taskGoal);

  if (userInput && currentSession) {
    // 确保 model 有有效值
    const effectiveModel = (currentSession.model && currentSession.model !== "unknown")
      ? currentSession.model
      : currentSession.agentSource.replace("openclaw:", "") || "unknown";
    await createSpan(currentSession.traceId, {
      role: "user",
      content: userInput.slice(0, 2000),
      duration_ms: 0,
      timestamp: new Date().toISOString(),
      model: effectiveModel,
      source: source,
    });
    console.log(`[openclaw-agentlog] User input span created: ${userInput.slice(0, 50)}...`);
  }

  console.log(`[openclaw-agentlog] Created new session via before_agent_start, agent: ${source}, taskGoal: ${taskGoal.slice(0, 50)}...`);
}

function summarizeUserInput(input: string): string {
  const firstLine = input.split('\n')[0].trim();
  if (firstLine.length <= 100) {
    return firstLine;
  }
  return firstLine.slice(0, 97) + '...';
}

function extractUserInput(prompt: string): string | null {
  const lines = prompt.split('\n');
  let capture = false;
  const userLines: string[] = [];

  for (const line of lines) {
    if (capture) {
      if (line.startsWith('[System:') || line.startsWith('[message_id:')) {
        break;
      }
      userLines.push(line);
    } else if (line.includes(']') && (line.includes(':') || line.includes('[Replying'))) {
      capture = true;
    }
  }

  const content = userLines.join('\n').trim();
  return content || null;
}

export async function onLlmOutput(params: {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}): Promise<void> {
  // 只记录 token usage，不单独创建 span
  // span 的内容将在 onAgentEnd 时通过 createLlmOutputSpan 创建
  if (!currentSession || !params.usage) return;

  // 保存 token usage 供 onAgentEnd 使用
  currentSession.pendingTokenUsage = {
    inputTokens: params.usage.input,
    outputTokens: params.usage.output,
    cacheCreationTokens: params.usage.cacheWrite,
    cacheReadTokens: params.usage.cacheRead,
  };
  currentSession.pendingModel = params.model;

  // 不在这里创建 span，避免重复和 NO_REPLY 问题
  console.log(`[openclaw-agentlog] LLM output received, tokens: in=${params.usage.input}, out=${params.usage.output}, will create span at agent_end`);
}

export function register(api: {
  on(event: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }): void;
  registerHook(event: string, handler: (...args: unknown[]) => unknown, opts?: { name?: string; description?: string }): void;
}): void {
  // session_start 钩子 - 创建 session 并设置 agent context
  api.on('session_start', async (event: unknown, ctx: unknown) => {
    const hookCtx = ctx as { agentId?: string; sessionId?: string; sessionKey?: string } | undefined;
    if (hookCtx?.agentId) {
      setAgentContext(hookCtx.agentId, hookCtx.agentId);
    }
    // @ts-ignore - OpenClaw 传递的参数
    await onSessionStart(event);
  });
  
  // before_agent_start 钩子 - 复用已有 session
  api.on('before_agent_start', async (event: unknown, ctx: unknown) => {
    const hookCtx = ctx as { agentId?: string; agentType?: string; workspaceDir?: string } | undefined;
    if (hookCtx?.agentId) {
      setAgentContext(hookCtx.agentId, hookCtx.agentType || hookCtx.agentId);
    }
    // @ts-ignore - OpenClaw 传递的参数
    await onBeforeAgentStart(event);
  });
  
  api.on('before_tool_call', beforeToolCall);
  api.on('after_tool_call', afterToolCall);
  api.on('agent_end', onAgentEnd);
  api.on('session_end', onSessionEnd);
  api.on('llm_output', onLlmOutput);
}

export default { register, skillMetadata, hooks: {
  session_start: onSessionStart,
  before_tool_call: beforeToolCall,
  after_tool_call: afterToolCall,
  agent_end: onAgentEnd,
  session_end: onSessionEnd,
  before_agent_start: onBeforeAgentStart,
  llm_output: onLlmOutput,
}};
