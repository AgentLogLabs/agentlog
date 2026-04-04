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

  // Check environment variables first (OpenClaw agents)
  const agentId = process.env.AGENTLOG_AGENT_ID || process.env.AGENT || "";
  if (agentId) {
    return `openclaw:${agentId}`;
  }

  if (name.includes("opencode")) return "opencode";
  if (name.includes("cline") || name.includes("roo")) return "cline";
  if (name.includes("cursor")) return "cursor";
  if (name.includes("claude")) return "claude-code";
  if (name.includes("copilot") || name.includes("vscode")) return "copilot";
  if (name.includes("continue")) return "continue";
  if (name.includes("trae")) return "trae";
  if (name.includes("openclaw") || name.includes("agent")) return "openclaw";

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
 * 失败时抛出 Error，由调用方统一处理。
 */
async function postTrace(body: Record<string, unknown>): Promise<{ id: string; parentTraceId: string | null; taskGoal: string; status: string }> {
  const url = `${BACKEND_BASE}/api/traces`;

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

  const json = (await resp.json()) as BackendTraceResponse;
  if (!json.success || !json.data?.id) {
    throw new Error(`Backend 返回业务错误：${json.error ?? "unknown"}`);
  }

  return json.data;
}

interface BackendSpanResponse {
  success: boolean;
  data?: { id: string };
  error?: string;
}

/**
 * 向 Backend 创建新 Span。
 */
async function postSpan(body: Record<string, unknown>): Promise<string> {
  const url = `${BACKEND_BASE}/api/spans`;

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

  const json = (await resp.json()) as BackendSpanResponse;
  if (!json.success || !json.data?.id) {
    throw new Error(`Backend 返回业务错误：${json.error ?? "unknown"}`);
  }

  return json.data.id;
}

/**
 * 向 Backend 更新 trace 状态。
 */
async function patchTrace(
  traceId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const url = `${BACKEND_BASE}/api/traces/${encodeURIComponent(traceId)}`;

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

interface SearchTracesResult {
  success: boolean;
  data?: Array<{ trace: unknown; spans: unknown[] }>;
  total?: number;
  error?: string;
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
// Session 调用状态追踪器（进程级）
// ─────────────────────────────────────────────

interface SessionState {
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
}

/**
 * 追踪当前 MCP 进程中所有活跃 session 的调用状态。
 * 用于：
 * 1. 检测 Agent 未传 session_id 导致重复创建 session
 * 2. 检测 log_intent 在 log_turn 之前被调用
 * 3. 提醒 Agent 正确的调用顺序
 */
const sessionTracker = new Map<string, SessionState>();

/** 最近一次创建的 session_id（用于检测 Agent 是否忘记传 session_id） */
let lastCreatedSessionId: string | null = null;
let lastCreatedSessionAt: number = 0;

/** 清理超过 2 小时不活跃的 session 记录，防止内存泄漏 */
function cleanupStaleSessionStates(): void {
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [id, state] of sessionTracker) {
    if (now - state.lastActivityAt > twoHoursMs) {
      sessionTracker.delete(id);
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
  setInterval(cleanupStaleSessionStates, 30 * 60 * 1000);

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
            "  ✗ 省略 session_id（会导致每条消息创建独立会话，对话碎片化）\n" +
            "  ✗ 在 log_turn 之前调用 log_intent（将导致存证数据不完整）\n" +
            "  ✗ 批量延迟上报（必须实时逐条调用）\n\n" +
            "【session_id 获取方式】\n" +
            "首次调用时不传 session_id，从返回 JSON 中提取 session_id 字段并缓存，\n" +
            "后续所有调用必须传入。",
          inputSchema: {
            type: "object" as const,
            properties: {
              session_id: {
                type: "string",
                description:
                  "会话 ID（由首次 log_turn 返回的 JSON 中的 session_id 字段获取）。" +
                  "首次调用时省略，后续每次调用必须传入。" +
                  "不传此参数将创建新会话，导致对话记录碎片化。",
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
                  "调用此工具的 AI 模型完整名称（如实填写）。仅首次调用时需要。",
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

        // ── log_intent ────────────────────────────────────────────────────
        {
          name: "log_intent",
          description:
            "⚠️ 【强制协议 - 禁止跳过】⚠️\n" +
            "本工具必须在 log_turn 之后调用，是整个记录流程的最后一步。\n\n" +
            "正确调用顺序：\n" +
            "  Step 1. log_turn(role=\"user\", ...)           ← 建立会话\n" +
            "  Step 2. log_turn(role=\"tool\"/\"assistant\")   ← 逐条记录（循环）\n" +
            "  Step 3. log_intent(...)                      ← 任务归档（仅一次）\n\n" +
            "⚠️ 如果你省略了中间的 log_turn(tool/assistant) 调用，\n" +
            "   仅仅在最后调用 log_intent，将导致存证数据不完整，\n" +
            "   无法追溯 AI 的实际编码过程！\n\n" +
            "【session_id 获取方式】\n" +
            "从首次 log_turn 返回的 JSON 中获取 session_id，后续传入。\n\n" +
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
              session_id: {
                type: "string",
                description:
                  "已有会话的 ID（由首次 log_turn 返回的 JSON 中 session_id 字段获取）。" +
                  "⚠️ 强烈建议传入：不传将创建孤立会话，丢失之前 log_turn 记录的对话上下文。",
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
                  "本次交互总耗时（毫秒）。可选——若不传，系统将根据会话首条 transcript 时间戳自动计算。",
              },
            },
            required: ["task", "model"],
          },
        },

        // ── create_trace ─────────────────────────────────────────────────
        {
          name: "create_trace",
          description:
            "创建一个新的 Trace（全局任务追踪）。\n\n" +
            "建议在开始一个新任务时优先调用，返回的 trace_id 需要保存，\n" +
            "后续的 log_turn 调用可以传入 trace_id 以关联到该 Trace。\n\n" +
            "【使用场景】\n" +
            "  - 开始一个全新的开发任务时\n" +
            "  - 需要追踪一个跨多个会话的完整任务流程时\n" +
            "  - 作为父级 Trace 关联多个子任务时\n\n" +
            "【trace_id 传递方式】\n" +
            "将返回的 trace_id 存入环境变量或工具调用上下文，\n" +
            "后续 log_turn 调用时传入 trace_id 参数。",
          inputSchema: {
            type: "object" as const,
            properties: {
              task_goal: {
                type: "string",
                description: "任务目标描述（可选，默认 'Untitled Trace'）",
              },
              trace_id: {
                type: "string",
                description: "指定 trace ID（可选，默认自动生成 ULID）",
              },
              parent_trace_id: {
                type: "string",
                description: "父 trace ID（可选，用于 fork 场景）",
              },
            },
            required: [],
          },
        },

        // ── fork_trace ───────────────────────────────────────────────────
        {
          name: "fork_trace",
          description:
            "Fork 一个已有的 Trace，创建新的子 trace。\n\n" +
            "当需要基于已有任务继续开发时，使用 fork_trace 创建子 trace，\n" +
            "新 trace 会保留对父 trace 的引用。\n\n" +
            "【使用场景】\n" +
            "  - 继续之前的开发任务时\n" +
            "  - 需要在同一个父任务下创建子任务时\n\n" +
            "【Fork 与 Create 的区别】\n" +
            "create_trace: 创建全新 trace\n" +
            "fork_trace: 基于已有 trace 创建子 trace，保留关联",
          inputSchema: {
            type: "object" as const,
            properties: {
              parent_trace_id: {
                type: "string",
                description: "父 trace ID（必填）",
              },
              task_goal: {
                type: "string",
                description: "新 trace 的任务目标（可选，默认 'Forked Task'）",
              },
            },
            required: ["parent_trace_id"],
          },
        },

        {
          name: "suggest_trace",
          description:
            "根据任务描述，语义搜索相似的 Trace。\n\n" +
            "当需要继续之前的任务时，调用此工具搜索相似的 trace，\n" +
            "根据返回的 trace_id 决定是继续现有 trace 还是 fork 新 trace。\n\n" +
            "【使用场景】\n" +
            "  - 开始新任务前，先搜索是否有相似的历史 trace\n" +
            "  - 人类说「继续之前的任务」时，Agent 自动搜索\n" +
            "  - 发现历史任务有问题，想基于它继续\n\n" +
            "【返回】\n" +
            "返回最相似的 trace 列表，每个包含 trace_id、task_goal、状态等。\n" +
            "如果找到相似的 trace，建议使用 fork_trace 基于它创建新 trace。",
          inputSchema: {
            type: "object" as const,
            properties: {
              task_goal: {
                type: "string",
                description: "任务目标描述（用于语义搜索）",
              },
              workspace_path: {
                type: "string",
                description: "工作区路径（用于过滤同一项目的 trace）",
              },
              limit: {
                type: "number",
                description: "返回数量（默认 5）",
              },
            },
            required: ["task_goal"],
          },
        },

        {
          name: "query_traces",
          description:
            "查询 Trace 列表（语义检索）。\n\n" +
            "搜索 traces.task_goal 和 spans.payload 中的内容，\n" +
            "找到与关键词最匹配的 trace。\n\n" +
            "【使用场景】\n" +
            "  - OpenClaw Agent 接手任务时，先搜索相似 trace\n" +
            "  - 按关键字查找历史 trace\n" +
            "  - 按工作区过滤 trace\n\n" +
            "【搜索范围】\n" +
            "  - traces.task_goal：任务目标\n" +
            "  - spans.payload：包含 content、tool_name、commit_hash 等\n" +
            "  - workspace_path：过滤同一项目的 trace",
          inputSchema: {
            type: "object" as const,
            properties: {
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


    // ── create_trace ────────────────────────────────────────────────────
    if (request.params.name === "create_trace") {
      const args = request.params.arguments ?? {};
      const taskGoal = (args.task_goal as string | undefined) ?? "Untitled Trace";
      const traceId = (args.trace_id as string | undefined) ?? undefined;
      const parentTraceId = (args.parent_trace_id as string | undefined) ?? undefined;
      const workspacePath = (args.workspace_path as string | undefined) ?? process.cwd();

      try {
        const body: Record<string, unknown> = { taskGoal };
        if (traceId) {
          body.id = traceId;
        }
        if (parentTraceId) {
          body.parentTraceId = parentTraceId;
        }

        const result = await postTrace(body);

        // 将 trace_id 写入环境变量（供后续 log_turn 使用）
        process.env.AGENTLOG_TRACE_ID = result.id;

        // T-A: 将 trace_id 写入 git config
        try {
          if (await isGitRepo(workspacePath)) {
            await setGitConfig(workspacePath, "agentlog.traceId", result.id);
            process.stderr.write(`[agentlog-mcp] create_trace: 已写入 git config agentlog.traceId=${result.id}\n`);
          }
        } catch (gitErr) {
          process.stderr.write(`[agentlog-mcp] create_trace: 写入 git config 失败（忽略）: ${gitErr}\n`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  trace_id: result.id,
                  parent_trace_id: result.parentTraceId,
                  task_goal: result.taskGoal,
                  status: result.status,
                  env_var_set: "AGENTLOG_TRACE_ID",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agentlog-mcp] create_trace 失败: ${msg}\n`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `创建 Trace 失败：${msg}` }],
        };
      }
    }

    // ── fork_trace ───────────────────────────────────────────────────────
    if (request.params.name === "fork_trace") {
      const args = request.params.arguments ?? {};
      const parentTraceId = (args.parent_trace_id as string | undefined);
      const taskGoal = (args.task_goal as string | undefined) ?? "Forked Task";
      const workspacePath = (args.workspace_path as string | undefined) ?? process.cwd();

      if (!parentTraceId) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "fork_trace 需要传入 parent_trace_id 参数" }],
        };
      }

      try {
        // 创建新的子 trace，关联到父 trace
        const result = await postTrace({
          taskGoal,
          parentTraceId,
        });

        // 将新的 trace_id 写入环境变量和 git config
        process.env.AGENTLOG_TRACE_ID = result.id;

        try {
          if (await isGitRepo(workspacePath)) {
            await setGitConfig(workspacePath, "agentlog.traceId", result.id);
          }
        } catch (gitErr) {
          // ignore git config errors
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  trace_id: result.id,
                  parent_trace_id: result.parentTraceId,
                  task_goal: result.taskGoal,
                  status: result.status,
                  message: `Fork 成功。新 trace ${result.id} 已从 parent trace ${parentTraceId} 创建。`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agentlog-mcp] fork_trace 失败: ${msg}\n`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Fork Trace 失败：${msg}` }],
        };
      }
    }

    // ── suggest_trace ──────────────────────────────────────────────────
    if (request.params.name === "suggest_trace") {
      const args = request.params.arguments ?? {};
      const taskGoal = (args.task_goal as string | undefined) ?? "";
      const workspacePath = (args.workspace_path as string | undefined);
      const limit = (args.limit as number | undefined) ?? 5;

      if (!taskGoal) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "suggest_trace 需要传入 task_goal 参数" }],
        };
      }

      try {
        // 使用现有的 searchTracesAndSpans 函数搜索相似的 trace
        const result = await searchTracesAndSpans({
          keyword: taskGoal,
          workspacePath,
          pageSize: limit,
        });

        if (!result.success || !result.data) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `搜索失败：${result.error ?? "unknown"}` }],
          };
        }

        // 格式化返回结果
        const suggestions = result.data.slice(0, limit).map(({ trace, spans }) => {
          const t = trace as { id: string; parentTraceId: string | null; taskGoal: string; status: string; createdAt: string };
          return {
            trace_id: t.id,
            parent_trace_id: t.parentTraceId,
            task_goal: t.taskGoal,
            status: t.status,
            created_at: t.createdAt,
            span_count: (spans as unknown[]).length,
            suggestion: `找到相似 trace: ${t.id} (${t.status})`,
          };
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  total: result.total ?? suggestions.length,
                  suggestions,
                  message: suggestions.length > 0
                    ? `找到 ${suggestions.length} 个相似 trace。建议使用 fork_trace 继续任务。`
                    : "未找到相似 trace。可以使用 create_trace 创建新 trace。",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agentlog-mcp] suggest_trace 失败: ${msg}\n`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `搜索失败：${msg}` }],
        };
      }
    }

    // ── query_traces ───────────────────────────────────────────────────
    if (request.params.name === "query_traces") {
      const args = request.params.arguments ?? {};
      const keyword = (args.keyword as string | undefined) ?? "";
      const workspacePath = (args.workspace_path as string | undefined);
      const status = (args.status as string | undefined);
      const limit = (args.limit as number | undefined) ?? 10;
      const page = (args.page as number | undefined) ?? 1;

      try {
        // 调用后端 API 搜索 traces
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
      const sessionId = args.session_id as string | undefined;
      const role = args.role as "user" | "assistant" | "tool";
      // DeepSeek-R1 推理模型在推理阶段 content 可能为空字符串，需兜底处理
      const rawContent = args.content as string | undefined;
      const content = (rawContent ?? "").trim() !== "" ? (rawContent as string) : "(pending)";
      const toolName = args.tool_name as string | undefined;
      const toolInput = args.tool_input as string | undefined;
      // reasoning：推理模型本轮的思考过程（DeepSeek-R1 reasoning_content / Claude extended thinking）
      const reasoning = (args.reasoning as string | undefined) || undefined;
      const model = (args.model as string | undefined) ?? "unknown";
      const workspacePath = (args.workspace_path as string | undefined) ?? process.cwd();

      // 解析 token_usage（snake_case → camelCase）
      const rawTokenUsage = args.token_usage as Record<string, number> | undefined;
      const tokenUsage = rawTokenUsage
        ? {
            inputTokens: rawTokenUsage.input_tokens ?? 0,
            outputTokens: rawTokenUsage.output_tokens ?? 0,
            cacheCreationTokens: rawTokenUsage.cache_creation_tokens,
            cacheReadTokens: rawTokenUsage.cache_read_tokens,
            apiCallCount: rawTokenUsage.api_call_count,
          }
        : undefined;

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
        process.stderr.write(`[agentlog-mcp] log_turn: role=${role}, session_id=${sessionId ?? "(new)"}, content_len=${turnContent.length}, has_reasoning=${!!reasoning}\n`);

        let resultSessionId: string;

        // 新的 trace 架构：直接使用客户端传入的 token_usage，不再从 sessions 获取
        const finalTokenUsage = tokenUsage;

        // ── 重复创建检测 ──
        // 如果 Agent 没有传 session_id，但最近刚创建过 session，说明 Agent 可能丢失了 session_id
        let duplicateWarning: string | undefined;
        if (!sessionId && lastCreatedSessionId) {
          const timeSinceLastCreate = Date.now() - lastCreatedSessionAt;
          // 5 分钟内重复创建 → 大概率是同一对话中 Agent 忘记传 session_id
          if (timeSinceLastCreate < 5 * 60 * 1000) {
            duplicateWarning =
              `⚠️ 警告：${Math.round(timeSinceLastCreate / 1000)}秒前刚创建过会话 ${lastCreatedSessionId}，` +
              `现在又在创建新会话。这通常意味着你丢失了 session_id。` +
              `如果这是同一个对话，请在后续调用中传入 session_id="${lastCreatedSessionId}"。`;
            process.stderr.write(`[agentlog-mcp] ⚠️ 重复创建检测：上次=${lastCreatedSessionId} (${timeSinceLastCreate}ms前)\n`);
          }
        }

        // ── 新的 Span 架构：直接创建 Span ───────────────────────────────
        // 优先使用 session_id 作为 trace_id（向后兼容）
        let traceId = sessionId ?? process.env.AGENTLOG_TRACE_ID ?? null;

        // 检查现有 trace 的状态，决定是继续还是 fork
        if (traceId) {
          const status = await getTraceStatus(traceId);
          if (status === "completed" || status === "failed") {
            // Trace 已结束，自动 fork 新 trace
            const parentTraceId = traceId;
            try {
              const forkResult = await postTrace({
                taskGoal: `Continued from ${parentTraceId}`,
                parentTraceId,
              });
              traceId = forkResult.id;
              process.env.AGENTLOG_TRACE_ID = traceId;

              // 写入 git config
              try {
                if (await isGitRepo(workspacePath)) {
                  await setGitConfig(workspacePath, "agentlog.traceId", traceId);
                }
              } catch (gitErr) {
                // ignore
              }

              process.stderr.write(`[agentlog-mcp] log_turn: Trace ${parentTraceId} 已${status}，自动 Fork 新 trace ${traceId}\n`);
            } catch (err) {
              process.stderr.write(`[agentlog-mcp] log_turn: 自动 Fork 失败: ${err}，继续使用原 trace\n`);
            }
          } else if (status === null) {
            // Trace 不存在，创建新 trace
            process.stderr.write(`[agentlog-mcp] log_turn: Trace ${traceId} 不存在，创建新 trace\n`);
            traceId = null;
          } else {
            // status === "running" or "paused"，继续使用同一 trace
            process.stderr.write(`[agentlog-mcp] log_turn: 继续使用 trace ${traceId} (status=${status})\n`);
          }
        }

        // 如果没有 trace_id，创建新 trace
        if (!traceId) {
          try {
            const traceResult = await postTrace({
              taskGoal: `Task started by ${source || "agent"}`,
              status: "running",
            });
            traceId = traceResult.id;
            process.env.AGENTLOG_TRACE_ID = traceId;

            // T-A: 写入 git config
            try {
              if (await isGitRepo(workspacePath)) {
                await setGitConfig(workspacePath, "agentlog.traceId", traceId);
                process.stderr.write(`[agentlog-mcp] log_turn: 已写入 git config agentlog.traceId=${traceId}\n`);
              }
            } catch (gitErr) {
              process.stderr.write(`[agentlog-mcp] log_turn: 写入 git config 失败（忽略）: ${gitErr}\n`);
            }

            process.stderr.write(`[agentlog-mcp] log_turn: 自动创建 Trace ${traceId}\n`);
          } catch (err) {
            process.stderr.write(`[agentlog-mcp] log_turn: 自动创建 Trace 失败: ${err}\n`);
            throw err;
          }
        }

        // 创建 Span（每次 log_turn 调用都创建一个 Span）
        const spanPayload = {
          role,
          content: turnContent,
          timestamp: new Date().toISOString(),
          ...(toolName ? { toolName } : {}),
          ...(toolInput ? { toolInput } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(finalTokenUsage ? { tokenUsage: finalTokenUsage } : {}),
          model,
          source,
          workspacePath,
        };

        const spanId = await postSpan({
          traceId,
          actorType: role === "user" ? "human" : role === "assistant" ? "agent" : "agent",
          actorName: source || "unknown",
          payload: spanPayload,
        });

        process.stderr.write(`[agentlog-mcp] log_turn: 创建 Span ${spanId} 关联到 trace=${traceId}\n`);

        resultSessionId = traceId;

        // 更新 session 状态追踪（内存中，用于向后兼容和 call_reminder）
        if (traceId) {
          const state = sessionTracker.get(traceId);
          if (state) {
            state.turnCount++;
            state.lastActivityAt = Date.now();
            state.recordedRoles.add(role);
          } else {
            sessionTracker.set(traceId, {
              createdAt: Date.now(),
              turnCount: 1,
              intentCalled: false,
              lastActivityAt: Date.now(),
              recordedRoles: new Set([role]),
            });
          }
          lastCreatedSessionId = traceId;
          lastCreatedSessionAt = Date.now();
        }

        process.stderr.write(`[agentlog-mcp] log_turn 写入成功 trace_id=${resultSessionId}, span_id=${spanId}\n`);

        // 返回结构化 JSON，便于 Agent 可靠解析 session_id
        const isNewSession = !sessionId;
        const responsePayload: Record<string, unknown> = {
          session_id: resultSessionId,
          trace_id: resultSessionId,
          span_id: spanId,
          status: "ok",
          is_new_session: isNewSession,
          message: isNewSession
            ? `新会话已创建。请在后续每次调用 log_turn 和最终调用 log_intent 时都传入 session_id="${resultSessionId}"。`
            : `消息已追加到会话 ${resultSessionId}。`,
        };

        if (isNewSession) {
          responsePayload.next_steps = [
            `每次工具调用完成后：log_turn(session_id="${resultSessionId}", role="tool", ...)`,
            `每次生成回复后：log_turn(session_id="${resultSessionId}", role="assistant", ...)`,
            `任务完成后：log_intent(session_id="${resultSessionId}", task="...", ...)`,
          ];
        }

        if (duplicateWarning) {
          responsePayload.warning = duplicateWarning;
        }

        // 附加 call_reminder，帮助 Agent 确认调用状态
        const state = sessionTracker.get(resultSessionId);
        if (state) {
          const callReminder: Record<string, unknown> = {
            total_turns_recorded: state.turnCount,
            recorded_roles: Array.from(state.recordedRoles),
          };

          // 检测遗漏的角色
          const allRoles = ["user", "assistant", "tool"] as const;
          const missingRoles = allRoles.filter(r => !state.recordedRoles.has(r));
          if (missingRoles.length > 0) {
            callReminder.missing_roles = missingRoles;
            callReminder.hint = `当前已记录 ${callReminder.recorded_roles}，缺少 ${missingRoles}。请补充记录。`;
          }

          // 如果还没有 user 就已经是 assistant/tool，说明跳过了第一步
          if (!state.recordedRoles.has("user") && (state.recordedRoles.has("assistant") || state.recordedRoles.has("tool"))) {
            callReminder.warning = "⚠️ 你还没有调用 log_turn(role='user') 建立会话。正确流程必须从 user 开始。";
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
      const workspacePath = (args.workspace_path as string) || process.cwd();
      const model = (args.model as string) || "unknown";
      const existingSessionId = args.session_id as string | undefined;
      const explicitDurationMs = args.duration_ms as number | undefined;

      // transcript（可选，未使用 log_turn 时一次性提交）
      const rawTranscript = args.transcript as Array<Record<string, string>> | undefined;
      const transcript = rawTranscript?.map((t) => ({
        role: t.role as "user" | "assistant" | "tool",
        content: t.content,
        ...(t.tool_name ? { toolName: t.tool_name } : {}),
        ...(t.tool_input ? { toolInput: t.tool_input } : {}),
        ...(t.timestamp ? { timestamp: t.timestamp } : {}),
      }));

      // token_usage（snake_case → camelCase）
      const rawTokenUsage = args.token_usage as Record<string, number> | undefined;
      const tokenUsage = rawTokenUsage
        ? {
            inputTokens: rawTokenUsage.input_tokens ?? 0,
            outputTokens: rawTokenUsage.output_tokens ?? 0,
            cacheCreationTokens: rawTokenUsage.cache_creation_tokens,
            cacheReadTokens: rawTokenUsage.cache_read_tokens,
            apiCallCount: rawTokenUsage.api_call_count,
          }
        : undefined;

      const provider =
        process.env.AGENTLOG_PROVIDER || inferProvider(model);

      try {
        process.stderr.write(`[agentlog-mcp] log_intent 被调用\n`);
        process.stderr.write(`[agentlog-mcp]   task=${task}\n`);
        process.stderr.write(`[agentlog-mcp]   affected_files=${JSON.stringify(affectedFiles)}\n`);
        process.stderr.write(`[agentlog-mcp]   workspace_path=${workspacePath}\n`);
        process.stderr.write(`[agentlog-mcp]   model=${model}\n`);
        process.stderr.write(`[agentlog-mcp]   session_id=${existingSessionId ?? "(new)"}\n`);
        process.stderr.write(`[agentlog-mcp]   transcript_turns=${transcript?.length ?? 0}\n`);
        process.stderr.write(`[agentlog-mcp]   provider=${provider}\n`);
        process.stderr.write(`[agentlog-mcp]   source=${source}\n`);

        // ── 新的 trace 架构 ─────────────────────────────────
        // session_id 现在作为 trace_id 使用，不再操作 sessions 表

        // 优先使用 existingSessionId 作为 traceId（向后兼容）
        let traceId = existingSessionId ?? process.env.AGENTLOG_TRACE_ID ?? null;

        // 如果没有 traceId，创建一个新 trace
        if (!traceId) {
          try {
            const traceResult = await postTrace({ taskGoal: task || "Untitled Trace" });
            traceId = traceResult.id;
            process.env.AGENTLOG_TRACE_ID = traceId;
            process.stderr.write(`[agentlog-mcp] log_intent: 自动创建 Trace ${traceId}\n`);
          } catch (err) {
            process.stderr.write(`[agentlog-mcp] log_intent: 自动创建 Trace 失败: ${err}\n`);
          }
        }

        // T-A: 将 traceId 写入 git config
        if (traceId) {
          try {
            if (await isGitRepo(workspacePath)) {
              await setGitConfig(workspacePath, "agentlog.traceId", traceId);
              process.stderr.write(`[agentlog-mcp] log_intent: 已写入 git config agentlog.traceId=${traceId}\n`);
            }
          } catch (gitErr) {
            process.stderr.write(`[agentlog-mcp] log_intent: 写入 git config 失败（忽略）: ${gitErr}\n`);
          }
        }

        // 更新 trace 状态为 completed
        if (traceId) {
          await patchTrace(traceId, {
            status: "completed",
            ...(task ? { taskGoal: task } : {}),
          });
          process.stderr.write(`[agentlog-mcp] log_intent: 更新 trace ${traceId} 状态为 completed\n`);
        }

        const resultId = traceId ?? "unknown";

        process.stderr.write(`[agentlog-mcp] log_intent 完成 trace_id=${resultId}\n`);

        const intentResponsePayload: Record<string, unknown> = {
          session_id: resultId,
          status: "ok",
          trace_id: process.env.AGENTLOG_TRACE_ID ?? null,
          message: `任务记录完成。Trace ${resultId} 状态已更新为 completed。` +
            (process.env.AGENTLOG_TRACE_ID ? ` 关联到 trace_id=${process.env.AGENTLOG_TRACE_ID}` : ""),
        };

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
        process.stderr.write(`[agentlog-mcp] 写入失败：${msg}\n`);

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
