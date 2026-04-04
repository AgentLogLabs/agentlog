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
  data?: { id: string; taskGoal: string; status: string };
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
async function postTrace(body: Record<string, unknown>): Promise<{ id: string; taskGoal: string; status: string }> {
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
        // 精确查询单条会话
        const sessionId = args.session_id as string | undefined;
        if (sessionId) {
          process.stderr.write(`[agentlog-mcp] query_historical_interaction: session_id=${sessionId}\n`);

          const result = await fetchSessionById(sessionId);
          if (!result.success || !result.data) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `未找到会话：${sessionId}` }],
            };
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
                    records: [result.data],
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // 列表查询：构造查询参数
        const queryParams: Record<string, string> = {};

        const filename = args.filename as string | undefined;
        const keyword = args.keyword as string | undefined;
        const startDate = args.start_date as string | undefined;
        const endDate = args.end_date as string | undefined;
        const commitHash = args.commit_hash as string | undefined;
        const provider = args.provider as string | undefined;
        const source = args.source as string | undefined;
        const page = (args.page as number | undefined) ?? 1;
        const pageSize = Math.min((args.page_size as number | undefined) ?? 20, 100);
        const includeTranscript = (args.include_transcript as boolean | undefined) ?? false;

        // filename → keyword 补充（affected_files 用 LIKE 模糊匹配，
        // Backend 现有 API 通过 keyword 覆盖 prompt/response/note，
        // affected_files 暂通过独立参数 affectedFile 传递）
        if (keyword) queryParams.keyword = keyword;
        if (startDate) queryParams.startDate = startDate;
        if (endDate) queryParams.endDate = endDate;
        if (provider) queryParams.provider = provider;
        if (source) queryParams.source = source;
        if (commitHash) queryParams.commitHash = commitHash;
        queryParams.page = String(page);
        queryParams.pageSize = String(pageSize);

        // commit_hash 过滤：onlyBoundToCommit 仅作布尔标记，具体 hash 需客户端过滤
        if (commitHash) {
          queryParams.onlyBoundToCommit = "true";
          // 增大 pageSize 以确保客户端有足够数据来过滤（最大 100 条/页）
          queryParams.pageSize = String(Math.min(pageSize * 5, 100));
        }

        process.stderr.write(
          `[agentlog-mcp] query_historical_interaction: params=${JSON.stringify(queryParams)}\n`,
        );

        const result = await fetchSessions(queryParams);
        if (!result.success || !result.data) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `查询失败：${result.error ?? "Backend 未返回数据"}`,
              },
            ],
          };
        }

        let records = result.data.data as Array<Record<string, unknown>>;

        // 客户端侧：按文件名过滤（affected_files 模糊匹配）
        if (filename) {
          const lowerFile = filename.toLowerCase();
          records = records.filter((s) => {
            const files = s.affectedFiles;
            if (!Array.isArray(files)) return false;
            return (files as string[]).some((f) =>
              f.toLowerCase().includes(lowerFile),
            );
          });
        }

        // 客户端侧：按 commit_hash 精确过滤
        if (commitHash) {
          records = records.filter((s) => {
            const ch = s.commitHash as string | undefined;
            return ch != null && ch.startsWith(commitHash);
          });
        }

        // 若不需要 transcript，从结果中删除（减少响应体积）
        if (!includeTranscript) {
          records = records.map((s) => {
            const { transcript: _t, ...rest } = s;
            return rest;
          });
        }

        // 若有客户端侧过滤，total 以过滤后结果为准
        const clientFiltered = !!(filename || commitHash);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  total: clientFiltered ? records.length : result.data.total,
                  page: result.data.page,
                  pageSize: result.data.pageSize,
                  records,
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
      const workspacePath = (args.workspace_path as string | undefined) ?? process.cwd();

      try {
        const body: Record<string, unknown> = { taskGoal };
        if (traceId) {
          body.id = traceId;
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

        let finalTokenUsage = tokenUsage;
        if (sessionId && !finalTokenUsage) {
          // 客户端未提供 token_usage，尝试从现有会话获取并估算增量
          try {
            const existingSession = await fetchSessionById(sessionId);
            if (existingSession.success && existingSession.data) {
              const sessionData = existingSession.data as any;
              const currentTokenUsage = sessionData.tokenUsage || { inputTokens: 0, outputTokens: 0 };
              const updatedTokenUsage = { ...currentTokenUsage };
              
              // 估算新消息的 token 数量
              const contentTokens = estimateTokenCount(turnContent);
              const reasoningTokens = reasoning ? estimateTokenCount(reasoning) : 0;
              
              if (role === "user" || role === "tool") {
                // 用户消息和工具结果计入输入 tokens
                updatedTokenUsage.inputTokens = (updatedTokenUsage.inputTokens || 0) + contentTokens;
              } else if (role === "assistant") {
                // 助理回复计入输出 tokens
                updatedTokenUsage.outputTokens = (updatedTokenUsage.outputTokens || 0) + contentTokens + reasoningTokens;
              }
              
              finalTokenUsage = updatedTokenUsage;
              process.stderr.write(`[agentlog-mcp] token_usage 自动估算：input=${updatedTokenUsage.inputTokens}, output=${updatedTokenUsage.outputTokens}\n`);
            }
          } catch (err) {
            // 获取现有会话失败，继续使用 undefined（保持原值）
            process.stderr.write(`[agentlog-mcp] 获取现有会话 token_usage 失败，跳过自动估算：${err}\n`);
          }
        }

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

        if (sessionId) {
          // 追加到已有会话
          await patchTranscript(sessionId, {
            turns: [turn],
            ...(finalTokenUsage ? { tokenUsage: finalTokenUsage } : {}),
          });
          resultSessionId = sessionId;

          // 更新 session 状态追踪
          const state = sessionTracker.get(sessionId);
          if (state) {
            state.turnCount++;
            state.lastActivityAt = Date.now();
            state.recordedRoles.add(role);
          } else {
            // 可能是从之前的进程恢复的 session
            sessionTracker.set(sessionId, {
              createdAt: Date.now(),
              turnCount: 1,
              intentCalled: false,
              lastActivityAt: Date.now(),
              recordedRoles: new Set([role]),
            });
          }
        } else {
          // 创建新会话（首条消息）
          // 注意：DeepSeek-R1 首条 assistant 消息 content 可能为空（仅有推理内容），
          // 此时用 "(pending)" 占位，后续通过 log_intent 或后续 log_turn 完善
          const provider = inferProvider(model);
          const traceId = process.env.AGENTLOG_TRACE_ID;
          resultSessionId = await postSession({
            provider,
            model,
            source,
            workspacePath,
            prompt: role === "user" ? content : "(pending)",
            response: role === "assistant" ? content : "(pending)",
            affectedFiles: [],
            durationMs: 0,
            transcript: [turn],
            ...(finalTokenUsage ? { tokenUsage: finalTokenUsage } : {}),
            ...(traceId ? { traceId } : {}),
          });

          // 记录新 session 到追踪器
          sessionTracker.set(resultSessionId, {
            createdAt: Date.now(),
            turnCount: 1,
            intentCalled: false,
            lastActivityAt: Date.now(),
            recordedRoles: new Set([role]),
          });
          lastCreatedSessionId = resultSessionId;
          lastCreatedSessionAt = Date.now();
        }

        process.stderr.write(`[agentlog-mcp] log_turn 写入成功 session_id=${resultSessionId}\n`);

        // 返回结构化 JSON，便于 Agent 可靠解析 session_id
        const isNewSession = !sessionId;
        const responsePayload: Record<string, unknown> = {
          session_id: resultSessionId,
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

        // ── 调用顺序验证 ──
        const intentWarnings: string[] = [];

        if (existingSessionId) {
          const state = sessionTracker.get(existingSessionId);
          if (state) {
            if (state.intentCalled) {
              intentWarnings.push(
                `⚠️ 此会话已经调用过 log_intent，重复调用将覆盖之前的记录。`
              );
            }
            // 标记 intent 已调用
            state.intentCalled = true;
            state.lastActivityAt = Date.now();
          }
        } else {
          // 没有 session_id 调用 log_intent → 可能遗漏了 log_turn 流程
          if (lastCreatedSessionId) {
            intentWarnings.push(
              `⚠️ 调用 log_intent 时未传入 session_id。` +
              `最近创建的会话是 ${lastCreatedSessionId}，` +
              `如果这是同一个任务，应传入 session_id="${lastCreatedSessionId}"。` +
              `未来请按正确顺序调用：log_turn(首次) → log_turn(后续) → log_intent(最后)。`
            );
          }
          if (!transcript || transcript.length === 0) {
            intentWarnings.push(
              `⚠️ 既没有 session_id 也没有 transcript，将创建一个仅有任务描述的空会话。` +
              `建议的完整流程：先用 log_turn 逐条记录对话，最后用 log_intent 归档。`
            );
          }
        }

        if (intentWarnings.length > 0) {
          process.stderr.write(`[agentlog-mcp] log_intent 警告：${intentWarnings.join(" | ")}\n`);
        }

        let resultId: string;

        if (existingSessionId) {
          // 已有会话：回写 response/affectedFiles/durationMs，formatted_transcript 和 reasoning_summary 由后端从 transcript 自动生成
          const intentBody: { response?: string; affectedFiles?: string[]; durationMs?: number } = {};
          if (task) intentBody.response = task;
          if (affectedFiles.length > 0) intentBody.affectedFiles = affectedFiles;

          // 耗时计算：优先使用外部传入值，否则从会话创建时间自动推算
          if (explicitDurationMs && explicitDurationMs > 0) {
            intentBody.durationMs = Math.round(explicitDurationMs);
          } else {
            // 从已有会话的 createdAt 时间戳推算耗时
            try {
              const sessionResp = await fetchSessionById(existingSessionId);
              const sessionData = sessionResp.data as Record<string, unknown> | undefined;
              const createdAt = sessionData?.createdAt as string | undefined;
              if (createdAt) {
                const created = new Date(createdAt).getTime();
                if (!isNaN(created)) {
                  intentBody.durationMs = Math.round(Date.now() - created);
                }
              }
            } catch {
              // 查询失败时跳过自动计算，不影响主流程
              process.stderr.write(`[agentlog-mcp] 自动计算耗时失败，跳过\n`);
            }
          }

          await patchIntent(existingSessionId, intentBody);

          // Auto-fill transcript from database if not provided
          let finalTranscript = transcript ?? [];
          if ((!finalTranscript || finalTranscript.length === 0) && existingSessionId) {
            try {
              const sessionResp = await fetchSessionById(existingSessionId);
              const sessionData = sessionResp.data as { transcript?: Array<Record<string, unknown>> } | undefined;
              if (sessionData?.transcript && sessionData.transcript.length > 0) {
                finalTranscript = sessionData.transcript.map((t) => ({
                  role: t.role as "user" | "assistant" | "tool",
                  content: t.content as string,
                  ...(t.toolName ? { toolName: t.toolName as string } : {}),
                  ...(t.toolInput ? { toolInput: JSON.stringify(t.toolInput) } : {}),
                  ...(t.timestamp ? { timestamp: t.timestamp as string } : {}),
                }));
                process.stderr.write(`[agentlog-mcp] log_intent: 自动从数据库填充 transcript (${finalTranscript.length} turns)\n`);
              }
            } catch {
              process.stderr.write(`[agentlog-mcp] log_intent: 自动填充 transcript 失败，继续\n`);
            }
          }

          if (finalTranscript && finalTranscript.length > 0) {
            await patchTranscript(existingSessionId, {
              turns: finalTranscript,
              ...(tokenUsage ? { tokenUsage } : {}),
            });
          } else if (tokenUsage) {
            await patchTranscript(existingSessionId, { turns: [], tokenUsage });
          }
          resultId = existingSessionId;
        } else {
          // ── 方案 A+B：兜底逻辑 ─────────────────────────────────
          // 没有 session_id 时，用 task 作为 prompt
          const finalPrompt = task || "Untitled Task";

          // 从 transcript 生成 summary（用于 response 字段）
          let summary = "";
          if (transcript && transcript.length > 0) {
            summary = transcript
              .filter(t => t.role === "assistant")
              .map(t => {
                const content = t.content || "";
                return content.length > 200 ? content.slice(0, 200) + "..." : content;
              })
              .join("; ");
          }

          // 耗时：优先使用外部传入值，其次从 transcript 首尾时间戳推算
          let newSessionDurationMs = explicitDurationMs && explicitDurationMs > 0
            ? Math.round(explicitDurationMs)
            : 0;
          if (newSessionDurationMs === 0 && transcript && transcript.length > 0) {
            const firstTs = transcript[0].timestamp;
            if (firstTs) {
              const firstTime = new Date(firstTs).getTime();
              if (!isNaN(firstTime)) {
                newSessionDurationMs = Math.round(Date.now() - firstTime);
              }
            }
          }

          // 确保有 trace_id：如果环境变量没有，自动创建一个
          let traceId = process.env.AGENTLOG_TRACE_ID;
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

          // T-A: 将 trace_id 写入 git config（如果存在 traceId 且在 git 仓库中）
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

          resultId = await postSession({
            provider,
            model,
            source,
            workspacePath,
            prompt: finalPrompt,                    // 直接用 task，不占位
            response: summary || finalPrompt,        // 用 summary 作为 response
            affectedFiles,
            durationMs: newSessionDurationMs,
            ...(transcript && transcript.length > 0 ? { transcript } : {}),
            ...(tokenUsage ? { tokenUsage } : {}),
            ...(traceId ? { traceId } : {}),
          });
        }

        process.stderr.write(`[agentlog-mcp] 写入成功 id=${resultId}\n`);

        const intentResponsePayload: Record<string, unknown> = {
          session_id: resultId,
          status: "ok",
          trace_id: process.env.AGENTLOG_TRACE_ID ?? null,
          message: `任务记录完成（session_id=${resultId}）。会话已归档。` +
            (process.env.AGENTLOG_TRACE_ID ? ` 关联到 trace_id=${process.env.AGENTLOG_TRACE_ID}` : ""),
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
