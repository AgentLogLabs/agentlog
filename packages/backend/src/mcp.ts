/**
 * @agentlog/backend — MCP Server 入口（stdio 模式）
 *
 * 通过 Model Context Protocol 为 AI Agent（Cline / Roo Code / OpenCode 等）
 * 提供 record_agent_intent 工具，Agent 主动上报重构意图与决策逻辑。
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

// ─────────────────────────────────────────────
// MCP Server 主流程
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new Server(
    {
      name: "agentlog-mcp",
      version: "0.2.0",
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
        {
          name: "record_agent_intent",
          description:
            "记录 AI 重构或编写代码的上下文意图。在完成一项任务后调用此工具，将决策逻辑持久化到本地数据库。",
          inputSchema: {
            type: "object" as const,
            properties: {
              task: {
                type: "string",
                description: "当前执行的任务或目标（简要概述）",
              },
              reasoning: {
                type: "string",
                description:
                  "重构或修改代码的深度决策逻辑和原因（越详细越好）",
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
                  "当前 Agent 使用的模型名称（如 claude-sonnet-4-5）。调用时应传入实际使用的模型 ID。",
              },
            },
            required: ["task", "reasoning"],
          },
        },
      ],
    };
  });

  // ── 工具调用处理 ────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "record_agent_intent") {
      const task = request.params.arguments?.task as string;
      const reasoning = request.params.arguments?.reasoning as string;
      const affectedFiles =
        (request.params.arguments?.affected_files as string[]) || [];
      const workspacePath =
        (request.params.arguments?.workspace_path as string) || process.cwd();
      const model =
        (request.params.arguments?.model as string) ||
        process.env.AGENTLOG_MODEL ||
        "unknown";
      // source：从握手时的 clientInfo.name 实时推断（工具调用时读，握手已完成）
      const clientName = server.getClientVersion()?.name ?? "";
      const source =
        process.env.AGENTLOG_SOURCE ||
        inferSource(clientName);
      // provider：从 model 名称推断，比 clientInfo 更能反映实际使用的服务商
      const provider =
        process.env.AGENTLOG_PROVIDER ||
        inferProvider(model);

      try {
        process.stderr.write(`[agentlog-mcp] record_agent_intent 被调用\n`);
        process.stderr.write(`[agentlog-mcp]   task=${task}\n`);
        process.stderr.write(`[agentlog-mcp]   reasoning=${reasoning?.slice(0, 80)}...\n`);
        process.stderr.write(`[agentlog-mcp]   affected_files=${JSON.stringify(affectedFiles)}\n`);
        process.stderr.write(`[agentlog-mcp]   workspace_path=${workspacePath}\n`);
        process.stderr.write(`[agentlog-mcp]   model=${model}\n`);
        process.stderr.write(`[agentlog-mcp]   provider=${provider}\n`);
        process.stderr.write(`[agentlog-mcp]   source=${source}\n`);

        const id = await postSession({
          provider,
          model,
          source,
          workspacePath,
          prompt: task,
          reasoning,
          response: `[MCP] ${task}`,
          affectedFiles,
          durationMs: 0,
        });

        process.stderr.write(`[agentlog-mcp] 写入成功 id=${id}\n`);

        return {
          content: [
            {
              type: "text" as const,
              text: `意图记录成功（id=${id}），请继续工作。`,
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
