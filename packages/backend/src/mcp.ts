/**
 * @agentlog/backend — MCP Server 入口（stdio 模式）
 *
 * 通过 Model Context Protocol 为 AI Agent（Cline / Roo Code / OpenCode 等）
 * 提供三个工具：
 *
 *  1. log_turn   — 逐轮上报每一条消息（user / assistant / tool），
 *                  首次调用自动创建会话，后续调用追加到同一会话。
 *                  这是推荐的主要调用方式，能记录完整的交互过程。
 *
 *  2. log_intent — 任务结束后调用一次，记录整体意图、决策逻辑、
 *                  受影响文件等汇总信息，并可携带完整 transcript。
 *                  若之前已通过 log_turn 建立了会话，可传入 session_id
 *                  将汇总信息合并到已有会话；否则创建新会话。
 *
 *  3. query_historical_interaction — 只读工具，允许其他 Agent 检索历史
 *                  交互记录。支持按文件名、关键字、时间范围、session_id、
 *                  commit_hash 等多维度过滤，返回原始交互记录。
 *
 * 数据通过 HTTP 提交给 AgentLog Backend（POST /api/sessions），
 * 由 Backend 统一写入 SQLite，避免多进程直接操作数据库导致 WAL 隔离问题。
 *
 * 启动方式：
 *   npx tsx src/mcp.ts          （开发）
 *   node dist/mcp.js            （生产）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { isGitRepo, setGitConfig } from "./services/gitService.js";
import {
  createErrorSpan,
  buildReasoningChain,
  transitionToHandoff,
  type ReasoningChainStep,
} from "./services/traceService.js";
import { getSessionsJsonPath, readSessionsJson, writeSessionsJson } from "./services/sessionsJsonService.js";

// ─────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────

const BACKEND_PORT = parseInt(process.env.AGENTLOG_PORT ?? "7892", 10);
const BACKEND_BASE = process.env.AGENTLOG_BACKEND_URL ?? `http://localhost:${BACKEND_PORT}`;

// ─────────────────────────────────────────────
// 客户端信息推断
// ─────────────────────────────────────────────

/**
 * 根据 MCP clientInfo.name 推断 source（调用工具的 Agent 名称）。
 * clientInfo 在 MCP initialize 握手阶段由客户端主动上报，工具调用时实时读取。
 * 
 * OpenClaw agents are identified via:
 * 1. Environment variable AGENTLOG_AGENT_ID (set by OpenClaw runtime)
 * 2. Environment variable AGENT (agent name)
 * 3. Client name pattern matching
 */
function inferSource(clientName: string): string {
  const name = clientName.toLowerCase();

  if (name.includes("opencode")) return "opencode";
  if (name.includes("cline") || name.includes("roo")) return "cline";
  if (name.includes("cursor")) return "cursor";
  if (name.includes("claude")) return "claude-code";
  if (name.includes("copilot") || name.includes("vscode")) return "copilot";
  if (name.includes("continue")) return "continue";
  if (name.includes("trae")) return "trae";
  if (name.includes("openclaw") || name.includes("agent")) return "openclaw";

  // Fallback to environment variables for OpenClaw agents (only if no client match)
  const agentId = process.env.AGENTLOG_AGENT_ID || process.env.AGENT || "";
  if (agentId) {
    return `openclaw:${agentId}`;
  }

  return "mcp-tool-call";
}

/**
 * 根据模型名称推断 provider。
 * model 由 Agent 在工具调用参数中传入，比 clientInfo 更能反映实际使用的服务商。
 */
function inferProvider(modelName: string): string {
  const m = modelName.toLowerCase();

  if (m.includes("claude")) return "anthropic";
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("o4")) return "openai";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("qwen") || m.includes("tongyi")) return "qwen";
  if (m.includes("minimax") || m.includes("abab") || m.startsWith("mini-")) return "minimax";
  if (m.includes("kimi") || m.includes("moonshot")) return "kimi";
  if (m.includes("doubao") || m.includes("skylark")) return "doubao";
  if (m.includes("glm") || m.includes("chatglm") || m.includes("zhipu")) return "zhipu";
  if (m.includes("gemini") || m.includes("gemma")) return "google";
  if (m.includes("llama") || m.includes("mistral") || m.includes("qwq") || m.includes("phi")) return "ollama";

  return "unknown";
}

/**
 * 估算文本的 token 数量（粗略：4 字符 ≈ 1 token）。
 * 用于在客户端未提供 token_usage 时进行估算。
 */
function estimateTokenCount(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  // 简单估算：4 字符 ≈ 1 token，向上取整
  return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────
// HTTP 工具函数
// ─────────────────────────────────────────────

interface BackendSessionResponse {
  success: boolean;
  data?: { id: string };
  error?: string;
}

interface BackendTraceResponse {
  success: boolean;
  data?: { id: string; parentTraceId: string | null; taskGoal: string; status: string };
  error?: string;
}

interface BackendSpanResponse {
  success: boolean;
  data?: { id: string };
  error?: string;
}

interface SearchTracesResult {
  success: boolean;
  data?: Array<{ trace: unknown; spans: unknown[] }>;
  total?: number;
  error?: string;
}

/**
 * 向 Backend 提交新会话。
 * 失败时抛出 Error，由调用方统一处理。
 */
async function postSession(body: Record<string, unknown>): Promise<string> {
  const url = `${BACKEND_BASE}/api/sessions`;

  process.stderr.write(`[agentlog-mcp] POST ${url}\n`);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Backend 返回 HTTP ${resp.status}：${text}`);
  }

  const json = (await resp.json()) as BackendSessionResponse;
  if (!json.success || !json.data?.id) {
    throw new Error(`Backend 返回业务错误：${json.error ?? "unknown"}`);
  }

  return json.data.id;
}

/**
 * 向 Backend 创建新 Trace。
 */
async function postTrace(taskGoal: string, workspacePath?: string): Promise<string> {
  const url = `${BACKEND_BASE}/api/traces`;

  process.stderr.write(`[agentlog-mcp] POST ${url}\n`);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskGoal, ...(workspacePath ? { workspacePath } : {}) }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Backend 返回 HTTP ${resp.status}：${text}`);
  }

  const json = (await resp.json()) as { success: boolean; data?: { id: string }; error?: string };
  if (!json.success || !json.data?.id) {
    throw new Error(`Backend 返回业务错误：${json.error ?? "unknown"}`);
  }

  return json.data.id;
}

/**
 * 向 Backend 创建新 Span。
 */
async function postSpan(
  traceId: string,
  actorType: "user" | "assistant" | "tool" | "human" | "agent" | "system",
  actorName: string,
  payload: Record<string, unknown>,
  parentSpanId?: string | null,
): Promise<string> {
  const url = `${BACKEND_BASE}/api/spans`;

  process.stderr.write(`[agentlog-mcp] POST ${url}\n`);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      traceId,
      actorType,
      actorName,
      payload,
      ...(parentSpanId ? { parentSpanId } : {}),
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Backend 返回 HTTP ${resp.status}：${text}`);
  }

  const json = (await resp.json()) as { success: boolean; data?: { id: string }; error?: string };
  if (!json.success || !json.data?.id) {
    throw new Error(`Backend 返回业务错误：${json.error ?? "unknown"}`);
  }

  return json.data.id;
}

/**
 * 向 Backend 更新 Trace 状态。
 */
async function patchTrace(
  traceId: string,
  status: "running" | "completed" | "failed" | "paused",
  affectedFiles?: string[],
): Promise<void> {
  const url = `${BACKEND_BASE}/api/traces/${traceId}`;

  process.stderr.write(`[agentlog-mcp] PATCH ${url}\n`);

  const body: Record<string, unknown> = { status };
  if (affectedFiles && affectedFiles.length > 0) {
    body.affectedFiles = affectedFiles;
  }

  const resp = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Backend 返回 HTTP ${resp.status}：${text}`);
  }
}

/**
 * 向 Backend 追加 transcript 消息到已有会话。
 */
async function patchTranscript(
  sessionId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const url = `${BACKEND_BASE}/api/sessions/${sessionId}/transcript`;

  process.stderr.write(`[agentlog-mcp] PATCH ${url}\n`);

  const resp = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Backend 返回 HTTP ${resp.status}：${text}`);
  }
}

/**
 * 向 Backend 回写 intent 字段（response / affectedFiles / durationMs）。
 * formatted_transcript 和 reasoning_summary 由后端从 transcript 自动生成，无需传入。
 */
async function patchIntent(
  sessionId: string,
  body: { response?: string; affectedFiles?: string[]; durationMs?: number },
): Promise<void> {
  const url = `${BACKEND_BASE}/api/sessions/${sessionId}/intent`;

  process.stderr.write(`[agentlog-mcp] PATCH ${url}\n`);

  const resp = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Backend 返回 HTTP ${resp.status}：${text}`);
  }
}

/**
 * 获取 trace 的状态。
 * @returns null if trace 不存在
 */
async function getTraceStatus(traceId: string): Promise<string | null> {
  const url = `${BACKEND_BASE}/api/traces/${encodeURIComponent(traceId)}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      return null;
    }
    const json = await resp.json() as { success: boolean; data?: { status: string } };
    if (!json.success || !json.data) {
      return null;
    }
    return json.data.status;
  } catch {
    return null;
  }
}

/**
 * 搜索 traces 和 spans（内部使用 spans 表搜索）
 */
async function searchTracesAndSpans(params: {
  keyword?: string;
  filename?: string;
  commitHash?: string;
  source?: string;
  workspacePath?: string;
  page?: number;
  pageSize?: number;
}): Promise<SearchTracesResult> {
  const query = new URLSearchParams();
  if (params.keyword) query.set("keyword", params.keyword);
  if (params.filename) query.set("keyword", params.filename);
  if (params.commitHash) query.set("commitHash", params.commitHash);
  if (params.source) query.set("source", params.source);
  if (params.workspacePath) query.set("workspacePath", params.workspacePath);
  query.set("page", String(params.page ?? 1));
  query.set("pageSize", String(Math.min(params.pageSize ?? 20, 100)));

  const url = `${BACKEND_BASE}/api/traces/search?${query.toString()}`;
  process.stderr.write(`[agentlog-mcp] searchTracesAndSpans: GET ${url}\n`);

  const resp = await fetch(url);
  if (!resp.ok) {
    return { success: false, error: `HTTP ${resp.status}` };
  }

  return resp.json() as Promise<SearchTracesResult>;
}

// ─────────────────────────────────────────────
// query_historical_interaction 专用类型与工具函数
// ─────────────────────────────────────────────

interface QuerySessionsResponse {
  success: boolean;
  data?: {
    data: unknown[];
    total: number;
    page: number;
    pageSize: number;
  };
  error?: string;
}

interface GetSessionResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * 向 Backend 查询历史会话列表（分页 + 多维过滤）。
 * 对应 GET /api/sessions
 */
async function fetchSessions(params: Record<string, string>): Promise<QuerySessionsResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BACKEND_BASE}/api/sessions${qs ? `?${qs}` : ""}`;

  process.stderr.write(`[agentlog-mcp] GET ${url}\n`);

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Backend 返回 HTTP ${resp.status}：${text}`);
  }
  return resp.json() as Promise<QuerySessionsResponse>;
}

/**
 * 向 Backend 查询单条会话详情（含完整 transcript）。
 * 对应 GET /api/sessions/:id
 */
async function fetchSessionById(sessionId: string): Promise<GetSessionResponse> {
  const url = `${BACKEND_BASE}/api/sessions/${encodeURIComponent(sessionId)}`;

  process.stderr.write(`[agentlog-mcp] GET ${url}\n`);

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Backend 返回 HTTP ${resp.status}：${text}`);
  }
  return resp.json() as Promise<GetSessionResponse>;
}

// ─────────────────────────────────────────────
// Trace 调用状态追踪器（进程级）
// ─────────────────────────────────────────────

interface TraceState {
  /** 创建时间 */
  createdAt: number;
  /** log_turn 调用次数 */
  turnCount: number;
  /** 是否已调用 log_intent */
  intentCalled: boolean;
  /** 上次活动时间 */
  lastActivityAt: number;
  /** 已记录的角色类型集合 */
  recordedRoles: Set<"user" | "assistant" | "tool">;
  /** 当前活跃的 parent span ID（用于构建 span tree） */
  activeSpanId: string | null;
  /** 最近一次有效的 model 名称（用于 tool/assistant turn 继承） */
  lastModel: string | null;
}

/**
 * 追踪当前 MCP 进程中所有活跃 trace 的调用状态。
 */
const traceTracker = new Map<string, TraceState>();

/** 最近一次创建的 trace_id（用于检测 Agent 是否忘记传 trace_id） */
let lastCreatedTraceId: string | null = null;
let lastCreatedAt: number = 0;

/** 清理超过 2 小时不活跃的 trace 记录，防止内存泄漏 */
function cleanupStaleTraceStates(): void {
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [id, state] of traceTracker) {
    if (now - state.lastActivityAt > twoHoursMs) {
      traceTracker.delete(id);
    }
  }
}

// ─────────────────────────────────────────────
// MCP Server 主流程
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new Server(
    {
      name: "agentlog-mcp",
      version: "0.5.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // 定期清理不活跃的 session 状态
  setInterval(cleanupStaleTraceStates, 30 * 60 * 1000);

  // ── 工具列表 ────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        // ── log_turn ──────────────────────────────────────────────────────
        {
          name: "log_turn",
          description:
            "⚠️ 【强制协议 - 禁止跳过】⚠️\n" +
            "每轮对话必须按以下顺序调用本工具，记录完整的 AI 编码过程！\n\n" +
            "调用流程：\n" +
            "  Step 1. log_turn(role=\"user\", ...)         ← 对话开始时调用（禁止省略）\n" +
            "  Step 2. log_turn(role=\"tool\", ...)         ← 每次工具执行后调用\n" +
            "  Step 3. log_turn(role=\"assistant\", ...)     ← 每次回复后调用\n" +
            "  循环 Step 2-3 直到任务完成\n" +
            "  Step 4. log_intent(...)                     ← 任务完成时调用一次\n\n" +
            "⚠️ 禁止行为：\n" +
            "  ✗ 不调用 log_turn 就直接执行 read/edit/bash（将导致编码过程无法记录）\n" +
            "  ✗ 省略 trace_id（会导致每条消息创建独立 Trace，对话碎片化）\n" +
            "  ✗ 在 log_turn 之前调用 log_intent（将导致存证数据不完整）\n" +
            "  ✗ 批量延迟上报（必须实时逐条调用）\n" +
            "  ✗ role=assistant 时省略 model（会导致模型归因不准，尤其是多模型切换场景）\n\n" +
            "【trace_id 获取方式】\n" +
            "首次调用时不传 trace_id，从返回 JSON 中提取 trace_id 字段并缓存，\n" +
            "后续所有调用必须传入。",
          inputSchema: {
            type: "object" as const,
            properties: {
              trace_id: {
                type: "string",
                description:
                  "Trace ID（由首次 log_turn 返回的 JSON 中的 trace_id 字段获取）。" +
                  "首次调用时省略，后续每次调用必须传入。" +
                  "不传此参数将创建新 Trace，导致对话记录碎片化。",
              },
              role: {
                type: "string",
                enum: ["user", "assistant", "tool"],
                description: "消息角色：user（用户输入）、assistant（模型回复）、tool（工具执行结果）",
              },
              content: {
                type: "string",
                description: "消息内容。tool 角色可填执行结果摘要（过长时截断）。",
              },
              tool_name: {
                type: "string",
                description: "role=tool 时的工具名称（如 bash、read、edit）",
              },
              tool_input: {
                type: "string",
                description: "role=tool 时的工具输入参数摘要（可选）",
              },
              reasoning: {
                type: "string",
                description:
                  "推理模型本轮的思考过程（role=assistant 时可选）。" +
                  "DeepSeek-R1 对应 delta.reasoning_content；" +
                  "Claude extended thinking 对应 thinking content block。" +
                  "请将完整思考文本传入，不要截断。",
              },
              // 首次调用时的会话元数据
              model: {
                type: "string",
                description:
                  "调用此工具的 AI 模型完整名称（如实填写）。" +
                  "role=assistant 时必须传入，用于准确记录本轮回复使用的模型；" +
                  "role=tool 时可省略（自动继承同 trace 内最近一次有效 model）；" +
                  "role=user 时建议传入，尤其是切换模型后的第一条 user 消息。" +
                  "同一 trace 中切换模型时，须在新模型的 assistant turn 中传入新 model 名称。",
              },
              workspace_path: {
                type: "string",
                description: "工作区根目录绝对路径（可选，默认当前目录）。仅首次调用时有效。",
              },
              // Token 用量（可选，每轮累计值）
              token_usage: {
                type: "object",
                description: "当前累计 Token 用量（可选）",
                properties: {
                  input_tokens: { type: "number" },
                  output_tokens: { type: "number" },
                  cache_creation_tokens: { type: "number" },
                  cache_read_tokens: { type: "number" },
                  api_call_count: { type: "number" },
                },
              },
            },
            required: ["role", "content"],
          },
        },

        // ── query_historical_interaction ──────────────────────────────────
        {
          name: "query_historical_interaction",
          description:
            "【只读】从 AgentLog 数据库检索历史 AI 交互记录，供其他 Agent 分析或调试使用。\n" +
            "支持多维过滤：\n" +
            "  - session_id   精确查询单条会话（返回完整 transcript）\n" +
            "  - filename     查找涉及指定文件的会话（模糊匹配 affected_files）\n" +
            "  - keyword      在 prompt / response / note 中全文搜索\n" +
            "  - start_date   时间范围起始（ISO 8601，含）\n" +
            "  - end_date     时间范围截止（ISO 8601，含）\n" +
            "  - commit_hash  查找绑定到指定 Commit 的会话\n" +
            "  - provider     按模型提供商过滤（如 anthropic / openai / deepseek）\n" +
            "  - source       按 Agent 来源过滤（如 opencode / cline / cursor）\n" +
            "  - page / page_size 分页控制（默认第 1 页，每页 20 条）\n" +
            "  - include_transcript 是否在列表结果中包含完整 transcript（默认 false，可能较大）\n" +
            "不传任何参数时返回最近 20 条记录。",
          inputSchema: {
            type: "object" as const,
            properties: {
              session_id: {
                type: "string",
                description:
                  "精确查询指定会话 ID。传入后忽略其他过滤参数，返回该会话的完整详情（含 transcript）。",
              },
              filename: {
                type: "string",
                description:
                  "文件名或路径片段（部分匹配）。例如传入 'logService.ts' 可找到所有涉及该文件的会话。",
              },
              keyword: {
                type: "string",
                description:
                  "全文关键字，在 prompt、response、note 三个字段中模糊搜索。",
              },
              start_date: {
                type: "string",
                description:
                  "查询起始时间（ISO 8601，例如 '2025-01-01' 或 '2025-01-01T00:00:00Z'）。",
              },
              end_date: {
                type: "string",
                description:
                  "查询截止时间（ISO 8601，例如 '2025-12-31' 或 '2025-12-31T23:59:59Z'）。",
              },
              commit_hash: {
                type: "string",
                description:
                  "Git Commit Hash（完整 SHA 或短 SHA），查找绑定到该 Commit 的会话。",
              },
              provider: {
                type: "string",
                description:
                  "模型提供商，例如 'anthropic'、'openai'、'deepseek'、'qwen'。",
              },
              source: {
                type: "string",
                description:
                  "Agent 来源，例如 'opencode'、'cline'、'cursor'、'claude-code'。",
              },
              page: {
                type: "number",
                description: "分页页码，从 1 开始（默认 1）。",
              },
              page_size: {
                type: "number",
                description: "每页返回条数，最大 100（默认 20）。",
              },
              include_transcript: {
                type: "boolean",
                description:
                  "在列表结果中是否包含每条会话的完整 transcript（逐轮对话记录）。" +
                  "默认 false（仅列表时省略 transcript 以减少响应体积）。" +
                  "使用 session_id 精确查询时始终返回 transcript。",
              },
            },
            required: [],
          },
        },

        // ── claim_pending_trace ──────────────────────────────────────────
        {
          name: "claim_pending_trace",
          description:
            "认领一个待处理的 Trace。\n\n" +
            "启动时自动调用，检查并认领分配给当前 Agent 的 pending trace。\n" +
            "成功认领后，trace 会从 pending 移动到 active 状态。",
          inputSchema: {
            type: "object" as const,
            properties: {
              workspace_path: {
                type: "string",
                description: "工作区路径（默认使用 MCP 服务当前目录）",
              },
            },
            required: [],
          },
        },

        // ── query_traces ─────────────────────────────────────────────────
        {
          name: "query_traces",
          description:
            "查询 Trace 列表（语义检索）或直接获取单个 Trace。\n\n" +
            "【使用方式】\n" +
            "  - 传入 trace_id：直接获取指定 Trace 的详情（推荐用于 Handoff 场景）\n" +
            "  - 不传 trace_id：语义搜索 traces.task_goal 和 spans.payload\n\n" +
            "【搜索范围（无 trace_id 时）】\n" +
            "  - traces.task_goal：任务目标\n" +
            "  - spans.payload：包含 content、tool_name、commit_hash 等",
          inputSchema: {
            type: "object" as const,
            properties: {
              trace_id: {
                type: "string",
                description: "Trace ID（直接获取详情，用于 Handoff 后恢复上下文）",
              },
              keyword: {
                type: "string",
                description: "搜索关键字（匹配 task_goal 和 span payload）",
              },
              workspace_path: {
                type: "string",
                description: "工作区路径（过滤同一项目）",
              },
              status: {
                type: "string",
                enum: ["running", "paused", "completed", "failed"],
                description: "按状态过滤",
              },
              limit: {
                type: "number",
                description: "返回数量（默认 10）",
              },
              page: {
                type: "number",
                description: "页码（默认 1）",
              },
            },
            required: [],
          },
        },

        // ── log_intent ────────────────────────────────────────────────────
        {
          name: "log_intent",
          description:
            "⚠️ 【强制协议 - 禁止跳过】⚠️\n" +
            "本工具必须在 log_turn 之后调用，是整个记录流程的最后一步。\n\n" +
            "正确调用顺序：\n" +
            "  Step 1. log_turn(role=\"user\", ...)           ← 建立 Trace\n" +
            "  Step 2. log_turn(role=\"tool\"/\"assistant\")   ← 逐条记录（循环）\n" +
            "  Step 3. log_intent(...)                      ← 任务归档（仅一次）\n\n" +
            "⚠️ 如果你省略了中间的 log_turn(tool/assistant) 调用，\n" +
            "   仅仅在最后调用 log_intent，将导致存证数据不完整，\n" +
            "   无法追溯 AI 的实际编码过程！\n\n" +
            "【trace_id 获取方式】\n" +
            "从首次 log_turn 返回的 JSON 中获取 trace_id，后续传入。\n\n" +
            "reasoning_summary 和 formatted_transcript 由系统自动生成，无需手动填写。",
          inputSchema: {
            type: "object" as const,
            properties: {
              task: {
                type: "string",
                description: "当前执行的任务或目标（简要概述）",
              },
              affected_files: {
                type: "array",
                items: { type: "string" },
                description: "受影响的文件路径列表（相对于工作区根目录）",
              },
              workspace_path: {
                type: "string",
                description:
                  "工作区根目录的绝对路径（可选，默认使用 MCP 进程工作目录）",
              },
              model: {
                type: "string",
                description:
                  "调用此工具的 AI 模型的完整名称（如实填写，不得使用示例值）。",
              },
              trace_id: {
                type: "string",
                description:
                  "已有 Trace 的 ID（由首次 log_turn 返回的 JSON 中 trace_id 字段获取）。" +
                  "⚠️ 强烈建议传入：不传将无法关联之前的 log_turn 记录。",
              },
              transcript: {
                type: "array",
                description:
                  "完整的逐轮对话记录（未使用 log_turn 时一次性提交）。" +
                  "每条消息包含 role、content，以及 tool 角色的 tool_name。",
                items: {
                  type: "object",
                  properties: {
                    role: { type: "string", enum: ["user", "assistant", "tool"] },
                    content: { type: "string" },
                    tool_name: { type: "string" },
                    tool_input: { type: "string" },
                    timestamp: { type: "string" },
                  },
                  required: ["role", "content"],
                },
              },
              token_usage: {
                type: "object",
                description: "本次会话的最终 Token 用量统计（可选）",
                properties: {
                  input_tokens: { type: "number" },
                  output_tokens: { type: "number" },
                  cache_creation_tokens: { type: "number" },
                  cache_read_tokens: { type: "number" },
                  api_call_count: { type: "number" },
                },
              },
              duration_ms: {
                type: "number",
                description:
                  "本次交互总耗时（毫秒）。可选——若不传，系统将根据 Trace 首条 span 时间戳自动计算。",
              },
            },
            required: ["task", "model"],
          },
        },
      ],
    };
  });

  // ── 工具调用处理 ────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const clientVersion = server.getClientVersion();
    const clientName = clientVersion?.name ?? "";
    const source =
      process.env.AGENTLOG_SOURCE ||
      inferSource(clientName);

    // ── query_historical_interaction ────────────────────────────────────
    if (request.params.name === "query_historical_interaction") {
      const args = request.params.arguments ?? {};

      try {
        // 精确查询单条 trace（复用 session_id 参数作为 trace_id，向后兼容）
        const traceId = args.session_id as string | undefined;
        if (traceId) {
          process.stderr.write(`[agentlog-mcp] query_historical_interaction: trace_id=${traceId}\n`);

          // 获取 trace 详情
          const traceUrl = `${BACKEND_BASE}/api/traces/${encodeURIComponent(traceId)}`;
          const traceResp = await fetch(traceUrl);
          if (!traceResp.ok) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `未找到 Trace：${traceId}` }],
            };
          }
          const traceJson = await traceResp.json() as { success: boolean; data?: unknown; error?: string };
          if (!traceJson.success || !traceJson.data) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `未找到 Trace：${traceId}` }],
            };
          }

          // 获取该 trace 的所有 spans
          const spansUrl = `${BACKEND_BASE}/api/traces/${encodeURIComponent(traceId)}/summary`;
          const spansResp = await fetch(spansUrl);
          let spans: unknown[] = [];
          if (spansResp.ok) {
            const spansJson = await spansResp.json() as { success: boolean; data?: { spanTree?: unknown[] } };
            spans = spansJson.data?.spanTree ?? [];
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    total: 1,
                    page: 1,
                    pageSize: 1,
                    records: [{ trace: traceJson.data, spans }],
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // 列表查询：使用 spans 搜索
        const filename = args.filename as string | undefined;
        const keyword = args.keyword as string | undefined;
        const commitHash = args.commit_hash as string | undefined;
        const source = args.source as string | undefined;
        const page = (args.page as number | undefined) ?? 1;
        const pageSize = Math.min((args.page_size as number | undefined) ?? 20, 100);

        const result = await searchTracesAndSpans({
          keyword,
          filename,
          commitHash,
          source,
          page,
          pageSize,
        });

        if (!result.success) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `查询失败：${result.error ?? "unknown"}` }],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  total: result.total ?? 0,
                  page,
                  pageSize: result.data?.length ?? 0,
                  records: result.data ?? [],
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agentlog-mcp] query_historical_interaction 失败：${msg}\n`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `查询失败：${msg}` }],
        };
      }
    }

    // ── claim_pending_trace ─────────────────────────────────────────────
    if (request.params.name === "claim_pending_trace") {
      const args = request.params.arguments ?? {};
      const workspacePath = (args.workspace_path as string | undefined) ?? process.cwd();

      try {
        const sessionsPath = await getSessionsJsonPath(workspacePath);
        const sessions = readSessionsJson(sessionsPath);

        // 查找匹配的 pending trace
        for (const [traceId, entry] of Object.entries(sessions.pending)) {
          if (entry.targetAgent === source || entry.targetAgent === "*") {
            // 认领：移动到 active
            const { nanoid } = await import("nanoid");
            const sessionId = nanoid();
            const activeEntry: { sessionId: string; traceId: string; agentType: string; status: "active"; startedAt: string } = {
              sessionId,
              traceId,
              agentType: source,
              status: "active",
              startedAt: new Date().toISOString(),
            };

            delete sessions.pending[traceId];
            sessions.active[sessionId] = activeEntry;
            writeSessionsJson(sessionsPath, sessions);

            process.stderr.write(`[agentlog-mcp] claim_pending_trace: 认领 trace_id=${traceId}, session_id=${sessionId}\n`);

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      success: true,
                      claimed: true,
                      traceId,
                      sessionId,
                      message: `成功认领 Trace ${traceId}`,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
        }

        // 没有找到匹配的 pending trace
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  claimed: false,
                  message: `当前无待认领的 Trace（pending）分配给 ${source}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agentlog-mcp] claim_pending_trace 失败：${msg}\n`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `认领失败：${msg}` }],
        };
      }
    }

    // ── query_traces ────────────────────────────────────────────────────
    if (request.params.name === "query_traces") {
      const args = request.params.arguments ?? {};
      const traceId = (args.trace_id as string | undefined) ?? "";
      const keyword = (args.keyword as string | undefined) ?? "";
      const workspacePath = (args.workspace_path as string | undefined) ?? process.cwd();
      const status = (args.status as string | undefined);
      const limit = (args.limit as number | undefined) ?? 10;
      const page = (args.page as number | undefined) ?? 1;

      try {
        // 优先用 trace_id 直接查询
        if (traceId) {
          const url = `${BACKEND_BASE}/api/traces/${encodeURIComponent(traceId)}`;
          process.stderr.write(`[agentlog-mcp] query_traces: GET ${url}\n`);

          const resp = await fetch(url);
          if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            return {
              isError: true,
              content: [{ type: "text" as const, text: `查询失败：HTTP ${resp.status} - ${text}` }],
            };
          }

          const json = await resp.json() as { success?: boolean; data?: unknown; error?: string };
          if (!json.success) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `查询失败：${json.error ?? "unknown"}` }],
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: true, trace: json.data }, null, 2),
              },
            ],
          };
        }

        // 无 trace_id 时，从 sessions.json 的 active 中获取当前工作区的活跃 trace
        let foundTraceId = "";
        let traceSource = "";
        if (!keyword) {
          try {
            const sessionsPath = await getSessionsJsonPath(workspacePath);
            const sessions = readSessionsJson(sessionsPath);

            // 从 active 中查找当前 Agent 的 trace
            for (const entry of Object.values(sessions.active)) {
              if (entry.agentType === source || entry.agentType === "*") {
                foundTraceId = entry.traceId;
                traceSource = "active_session";
                process.stderr.write(`[agentlog-mcp] query_traces: 从 active 获取 trace_id=${foundTraceId}, agentType=${entry.agentType}\n`);
                break;
              }
            }
          } catch (e) {
            process.stderr.write(`[agentlog-mcp] query_traces: 读取 sessions.json 失败: ${e instanceof Error ? e.message : String(e)}\n`);
          }
        }

        // 如果获取到 trace_id，直接查询
        if (foundTraceId) {
          const url = `${BACKEND_BASE}/api/traces/${encodeURIComponent(foundTraceId)}`;
          process.stderr.write(`[agentlog-mcp] query_traces: GET ${url}\n`);

          const resp = await fetch(url);
          if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            return {
              isError: true,
              content: [{ type: "text" as const, text: `查询失败：HTTP ${resp.status} - ${text}` }],
            };
          }

          const json = await resp.json() as { success?: boolean; data?: unknown; error?: string };
          if (!json.success) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `查询失败：${json.error ?? "unknown"}` }],
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: true, trace: json.data, source: traceSource }, null, 2),
              },
            ],
          };
        }

        // 无 active trace 且无 keyword 时，返回提示
        if (!keyword) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    message: "当前无活跃 Trace（active），也未提供 keyword 参数进行搜索。可传入 keyword 进行语义搜索。",
                    hint: "query_traces() 会自动从 .git/agentlog/sessions.json 的 active 中查找当前 Agent 的 trace，或传入 keyword 搜索",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // 语义搜索
        const params = new URLSearchParams();
        if (keyword) params.set("keyword", keyword);
        if (workspacePath) params.set("workspacePath", workspacePath);
        if (status) params.set("status", status);
        params.set("page", String(page));
        params.set("pageSize", String(limit));

        const url = `${BACKEND_BASE}/api/traces/search?${params.toString()}`;
        process.stderr.write(`[agentlog-mcp] query_traces: GET ${url}\n`);

        const resp = await fetch(url);
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          return {
            isError: true,
            content: [{ type: "text" as const, text: `搜索失败：HTTP ${resp.status} - ${text}` }],
          };
        }

        const json = await resp.json() as { success?: boolean; data?: unknown[]; total?: number; error?: string };
        if (!json.success) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `搜索失败：${json.error ?? "unknown"}` }],
          };
        }

        const traces = json.data ?? [];
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  total: json.total ?? traces.length,
                  count: traces.length,
                  page,
                  traces: traces.map((t) => ({
                    trace_id: (t as { trace: { id: string; taskGoal: string; status: string; createdAt: string } }).trace?.id,
                    task_goal: (t as { trace: { id: string; taskGoal: string; status: string; createdAt: string } }).trace?.taskGoal,
                    status: (t as { trace: { id: string; taskGoal: string; status: string; createdAt: string } }).trace?.status,
                    created_at: (t as { trace: { id: string; taskGoal: string; status: string; createdAt: string } }).trace?.createdAt,
                  })),
                  message: traces.length > 0
                    ? `找到 ${traces.length} 个匹配的 trace`
                    : "未找到匹配的 trace",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agentlog-mcp] query_traces 失败: ${msg}\n`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `搜索失败：${msg}` }],
        };
      }
    }

    // ── log_turn ────────────────────────────────────────────────────────
    if (request.params.name === "log_turn") {
      const args = request.params.arguments ?? {};
      const traceId = args.trace_id as string | undefined;
      const role = args.role as "user" | "assistant" | "tool";
      // DeepSeek-R1 推理模型在推理阶段 content 可能为空字符串，需兜底处理
      const rawContent = args.content as string | undefined;
      const content = (rawContent ?? "").trim() !== "" ? (rawContent as string) : "(pending)";
      const toolName = args.tool_name as string | undefined;
      const toolInput = args.tool_input as string | undefined;
      // reasoning：推理模型本轮的思考过程（DeepSeek-R1 reasoning_content / Claude extended thinking）
      const reasoning = (args.reasoning as string | undefined) || undefined;
      const rawModel = (args.model as string | undefined) ?? "unknown";
      const workspacePath = (args.workspace_path as string | undefined) ?? process.cwd();
      const tokenUsage = args.token_usage as Record<string, number> | undefined;

      // 存入 transcript 时保留原始内容（含空字符串），兜底值仅用于 prompt/response 字段
      const turnContent = rawContent ?? "";
      const turn = {
        role,
        content: turnContent,
        timestamp: new Date().toISOString(),
        ...(toolName ? { toolName } : {}),
        ...(toolInput ? { toolInput } : {}),
        ...(reasoning ? { reasoning } : {}),
      };

      try {
        process.stderr.write(`[agentlog-mcp] log_turn: role=${role}, trace_id=${traceId ?? "(new)"}, content_len=${turnContent.length}\n`);

        // 获取 traceId：优先使用传入的 trace_id，其次使用最近创建的 trace
        let currentTraceId = traceId ?? lastCreatedTraceId;

        // 重复创建检测：如果没有传 trace_id 但最近创建过，说明 Agent 丢失了 trace_id
        let duplicateWarning: string | undefined;
        if (!traceId && lastCreatedTraceId) {
          const timeSinceLastCreate = Date.now() - lastCreatedAt;
          if (timeSinceLastCreate < 5 * 60 * 1000) {
            duplicateWarning =
              `⚠️ 警告：${Math.round(timeSinceLastCreate / 1000)}秒前刚创建过 trace ${lastCreatedTraceId}，` +
              `现在又在创建新 trace。这通常意味着你丢失了 trace_id。` +
              `如果这是同一个对话，请在后续调用中传入 trace_id="${lastCreatedTraceId}"。`;
            process.stderr.write(`[agentlog-mcp] ⚠️ 重复创建检测：上次=${lastCreatedTraceId} (${timeSinceLastCreate}ms前)\n`);
          }
        }

        const isNewTrace = !currentTraceId;

        if (!currentTraceId) {
          // 创建新 Trace（首条消息）
          currentTraceId = await postTrace(role === "user" ? content : "Untitled Task", workspacePath);
          lastCreatedTraceId = currentTraceId;
          lastCreatedAt = Date.now();

          // 设置环境变量供 Git Hook 使用
          process.env.AGENTLOG_TRACE_ID = currentTraceId;

          // 写入 git config（如果当前是 git 仓库），供跨进程 Git Hook 读取
          if (workspacePath && (await isGitRepo(workspacePath))) {
            setGitConfig(workspacePath, "agentlog.traceId", currentTraceId).catch((err) => {
              process.stderr.write(`[agentlog-mcp] 写入 git config 失败: ${err}\n`);
            });
          }

          // 初始化 trace 追踪器
          traceTracker.set(currentTraceId, {
            createdAt: Date.now(),
            turnCount: 1,
            intentCalled: false,
            lastActivityAt: Date.now(),
            recordedRoles: new Set([role]),
            activeSpanId: null,
            lastModel: rawModel !== "unknown" ? rawModel : null,
          });
        } else {
          // 已有 trace：追加新 span
          const state = traceTracker.get(currentTraceId);
          if (state) {
            state.turnCount++;
            state.lastActivityAt = Date.now();
            state.recordedRoles.add(role);
          } else {
            // 可能从之前的进程恢复
            traceTracker.set(currentTraceId, {
              createdAt: Date.now(),
              turnCount: 1,
              intentCalled: false,
              lastActivityAt: Date.now(),
              recordedRoles: new Set([role]),
              activeSpanId: null,
              lastModel: rawModel !== "unknown" ? rawModel : null,
            });
          }
        }

        // 解析最终 model：优先使用本次传入的，否则从 trace state 继承
        const state = traceTracker.get(currentTraceId);
        const model = (rawModel !== "unknown")
          ? rawModel
          : (state?.lastModel ?? "unknown");

        // 若本次获得了有效 model，更新 state 以便后续 turn 继承
        if (model !== "unknown" && state) {
          state.lastModel = model;
        }

        // 构建 span payload
        const spanPayload: Record<string, unknown> = {
          role,
          content: turnContent,
          timestamp: new Date().toISOString(),
          ...(toolName ? { toolName } : {}),
          ...(toolInput ? { toolInput } : {}),
          ...(reasoning ? { reasoning } : {}),
          model,
          source,
          ...(tokenUsage ? { tokenUsage } : {}),
        };

        // 获取当前 trace 的活跃 span ID 作为 parent
        const parentSpanId = state?.activeSpanId ?? null;

        // 创建 span
        const spanId = await postSpan(
          currentTraceId,
          role === "user" ? "agent" : role === "assistant" ? "agent" : "agent",
          model,
          spanPayload,
          parentSpanId,
        );

        // 更新活跃 span（用于树状构建）
        if (state) {
          state.activeSpanId = spanId;
        }

        process.stderr.write(`[agentlog-mcp] log_turn 写入成功 trace_id=${currentTraceId}, span_id=${spanId}\n`);

        // 返回结构化 JSON
        const responsePayload: Record<string, unknown> = {
          trace_id: currentTraceId,
          span_id: spanId,
          status: "ok",
          is_new_trace: isNewTrace,
          message: isNewTrace
            ? `新 Trace 已创建，trace_id=${currentTraceId}。请在后续调用中传入 trace_id="${currentTraceId}"。`
            : `Span 已追加到 Trace ${currentTraceId}。`,
        };

        // ── Error 检测 ────────────────────────────────────────────────────
        // 检测 tool_response 中的 error 字段，自动创建 Error Span
        const toolResponse = args.tool_response as Record<string, unknown> | undefined;
        if (toolResponse && "error" in toolResponse && toolResponse.error) {
          process.stderr.write(`[agentlog-mcp] 检测到错误: ${toolResponse.error}\n`);

          // 构建推理链
          const reasoningChain = buildReasoningChain(currentTraceId);

          // 创建 Error Span
          const errorSpan = createErrorSpan({
            traceId: currentTraceId,
            errorType: String(toolResponse.error),
            stackTrace: toolResponse.stackTrace as string | undefined,
            reasoningChain,
          });

          process.stderr.write(`[agentlog-mcp] Error Span 已创建: ${errorSpan.id}\n`);

          // 提示可以转换为 pending_handoff
          responsePayload.hint = `检测到错误。如果需要交接给人类，可以调用 create_handoff 或设置 status=pending_handoff。`;
        }

        if (isNewTrace) {
          responsePayload.next_steps = [
            `每次工具调用完成后：log_turn(trace_id="${currentTraceId}", role="tool", ...)`,
            `每次生成回复后：log_turn(trace_id="${currentTraceId}", role="assistant", ...)`,
            `任务完成后：log_intent(trace_id="${currentTraceId}", task="...", ...)`,
          ];
        }

        if (duplicateWarning) {
          responsePayload.warning = duplicateWarning;
        }

        // 附加 call_reminder
        if (state) {
          const callReminder: Record<string, unknown> = {
            total_turns_recorded: state.turnCount,
            recorded_roles: Array.from(state.recordedRoles),
          };

          const allRoles = ["user", "assistant", "tool"] as const;
          const missingRoles = allRoles.filter(r => !state.recordedRoles.has(r));
          if (missingRoles.length > 0) {
            callReminder.missing_roles = missingRoles;
            callReminder.hint = `当前已记录 ${callReminder.recorded_roles}，缺少 ${missingRoles}。请补充记录。`;
          }

          if (!state.recordedRoles.has("user") && (state.recordedRoles.has("assistant") || state.recordedRoles.has("tool"))) {
            callReminder.warning = "⚠️ 你还没有调用 log_turn(role='user') 建立 Trace。正确流程必须从 user 开始。";
          }

          responsePayload.call_reminder = callReminder;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(responsePayload, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agentlog-mcp] log_turn 失败：${msg}\n`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `记录失败：${msg}` }],
        };
      }
    }

    // ── log_intent ──────────────────────────────────────────────────────
    if (request.params.name === "log_intent") {
      const args = request.params.arguments ?? {};
      const task = args.task as string;
      const affectedFiles = (args.affected_files as string[]) || [];
      const model = (args.model as string) || "unknown";
      const traceId = (args.trace_id as string | undefined) ?? lastCreatedTraceId;

      try {
        process.stderr.write(`[agentlog-mcp] log_intent 被调用\n`);
        process.stderr.write(`[agentlog-mcp]   task=${task}\n`);
        process.stderr.write(`[agentlog-mcp]   trace_id=${traceId ?? "(missing)"}\n`);

        // ── 调用顺序验证 ──
        const intentWarnings: string[] = [];

        if (!traceId) {
          intentWarnings.push(
            `⚠️ 调用 log_intent 时未传入 trace_id，且无法从上下文推断最近创建的 trace。` +
            `请在调用时传入 trace_id。`
          );
        }

        if (intentWarnings.length > 0) {
          process.stderr.write(`[agentlog-mcp] log_intent 警告：${intentWarnings.join(" | ")}\n`);
        }

        if (traceId) {
          // 更新 Trace 状态为 completed，同时写入 affected_files
          await patchTrace(traceId, "completed", affectedFiles.length > 0 ? affectedFiles : undefined);

          // 确保环境变量指向当前 trace，供 Git Hook 使用
          process.env.AGENTLOG_TRACE_ID = traceId;

          // 更新追踪器中的状态
          const state = traceTracker.get(traceId);
          if (state) {
            state.intentCalled = true;
            state.lastActivityAt = Date.now();
          }
        }

        process.stderr.write(`[agentlog-mcp] log_intent 完成 trace_id=${traceId}\n`);

        const intentResponsePayload: Record<string, unknown> = {
          trace_id: traceId,
          status: "ok",
          message: `任务记录完成（trace_id=${traceId}）。Trace 已归档。`,
        };
        if (intentWarnings.length > 0) {
          intentResponsePayload.warnings = intentWarnings;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(intentResponsePayload, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agentlog-mcp] log_intent 失败：${msg}\n`);

        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `记录失败：${msg}`,
            },
          ],
        };
      }
    }

    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `未知工具：${request.params.name}`,
        },
      ],
    };
  });

  // ── 启动 stdio 传输 ────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`[agentlog-mcp] MCP Server 已启动（backend=${BACKEND_BASE}）\n`);

  // ── 优雅退出 ────────────────────────────────

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  // stderr 供 MCP 客户端收集错误信息
  process.stderr.write(`[agentlog-mcp] 启动失败：${err}\n`);
  process.exit(1);
});
