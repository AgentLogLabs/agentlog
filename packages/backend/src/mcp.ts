/**
 * @agentlog/backend — MCP Server 入口（stdio 模式）
 *
 * 通过 Model Context Protocol 为 AI Agent（Cline / Roo Code / OpenCode 等）
 * 提供两个工具：
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
 */
function inferSource(clientName: string): string {
  const name = clientName.toLowerCase();

  if (name.includes("opencode")) return "opencode";
  if (name.includes("cline") || name.includes("roo")) return "cline";
  if (name.includes("cursor")) return "cursor";
  if (name.includes("claude")) return "claude-code";
  if (name.includes("copilot") || name.includes("vscode")) return "copilot";
  if (name.includes("continue")) return "continue";

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

// ─────────────────────────────────────────────
// HTTP 工具函数
// ─────────────────────────────────────────────

interface BackendSessionResponse {
  success: boolean;
  data?: { id: string };
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
 * 向 Backend 回写 intent 字段（response / affectedFiles）。
 * reasoning 由后端从 transcript 自动生成，无需传入。
 */
async function patchIntent(
  sessionId: string,
  body: { response?: string; affectedFiles?: string[] },
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
// MCP Server 主流程
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new Server(
    {
      name: "agentlog-mcp",
      version: "0.3.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );



  // ── 工具列表 ────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        // ── log_turn ──────────────────────────────────────────────────────
        {
          name: "log_turn",
          description:
            "逐轮记录 AI 交互消息（user / assistant / tool）。" +
            "首次调用时自动创建会话并返回 session_id，后续每轮调用传入相同 session_id 持续追加。" +
            "请在每条消息产生后立即调用，以完整保留对话历史。",
          inputSchema: {
            type: "object" as const,
            properties: {
              session_id: {
                type: "string",
                description:
                  "会话 ID（由首次调用返回）。首次调用时省略此参数，后续调用必须传入。",
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

        // ── log_intent ────────────────────────────────────────────────────
        {
          name: "log_intent",
          description:
            "在完成一项任务后调用，记录任务目标和受影响文件。" +
            "推理过程（reasoning）由系统从 transcript 自动生成，无需手动填写。" +
            "推荐与 log_turn 配合：先用 log_turn 逐轮记录，最后调用此工具汇总。",
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
                  "已有会话的 ID（由 log_turn 首次调用返回）。" +
                  "传入时回写到该会话；不传时创建新会话。",
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

    // ── log_turn ────────────────────────────────────────────────────────
    if (request.params.name === "log_turn") {
      const args = request.params.arguments ?? {};
      const sessionId = args.session_id as string | undefined;
      const role = args.role as "user" | "assistant" | "tool";
      const content = args.content as string;
      const toolName = args.tool_name as string | undefined;
      const toolInput = args.tool_input as string | undefined;
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

      const turn = {
        role,
        content,
        timestamp: new Date().toISOString(),
        ...(toolName ? { toolName } : {}),
        ...(toolInput ? { toolInput } : {}),
      };

      try {
        process.stderr.write(`[agentlog-mcp] log_turn: role=${role}, session_id=${sessionId ?? "(new)"}\n`);

        let resultSessionId: string;

        if (sessionId) {
          // 追加到已有会话
          await patchTranscript(sessionId, {
            turns: [turn],
            ...(tokenUsage ? { tokenUsage } : {}),
          });
          resultSessionId = sessionId;
        } else {
          // 创建新会话（首条消息）
          const provider = inferProvider(model);
          resultSessionId = await postSession({
            provider,
            model,
            source,
            workspacePath,
            // prompt/response 用首条消息内容填充，后续通过 log_intent 或 transcript 完善
            prompt: role === "user" ? content : "(pending)",
            response: role === "assistant" ? content : "(pending)",
            affectedFiles: [],
            durationMs: 0,
            transcript: [turn],
            ...(tokenUsage ? { tokenUsage } : {}),
          });
        }

        process.stderr.write(`[agentlog-mcp] log_turn 写入成功 session_id=${resultSessionId}\n`);

        return {
          content: [
            {
              type: "text" as const,
              text: `消息已记录（session_id=${resultSessionId}）。后续调用请传入此 session_id。`,
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

        let resultId: string;

        if (existingSessionId) {
          // 已有会话：回写 response/affectedFiles，reasoning 由后端从 transcript 自动生成
          const intentBody: { response?: string; affectedFiles?: string[] } = {};
          if (task) intentBody.response = task;
          if (affectedFiles.length > 0) intentBody.affectedFiles = affectedFiles;

          await patchIntent(existingSessionId, intentBody);

          if (transcript && transcript.length > 0) {
            await patchTranscript(existingSessionId, {
              turns: transcript,
              ...(tokenUsage ? { tokenUsage } : {}),
            });
          } else if (tokenUsage) {
            await patchTranscript(existingSessionId, { turns: [], tokenUsage });
          }
          resultId = existingSessionId;
        } else {
          // 新建会话（reasoning 由 createSession 从 transcript 自动生成）
          resultId = await postSession({
            provider,
            model,
            source,
            workspacePath,
            prompt: task,
            response: task,
            affectedFiles,
            durationMs: 0,
            ...(transcript && transcript.length > 0 ? { transcript } : {}),
            ...(tokenUsage ? { tokenUsage } : {}),
          });
        }

        process.stderr.write(`[agentlog-mcp] 写入成功 id=${resultId}\n`);

        return {
          content: [
            {
              type: "text" as const,
              text: `意图记录成功（id=${resultId}），请继续工作。`,
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
