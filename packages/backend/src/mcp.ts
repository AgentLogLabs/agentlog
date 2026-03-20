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

      try {
        process.stderr.write(`[agentlog-mcp] record_agent_intent 被调用\n`);
        process.stderr.write(`[agentlog-mcp]   task=${task}\n`);
        process.stderr.write(`[agentlog-mcp]   reasoning=${reasoning?.slice(0, 80)}...\n`);
        process.stderr.write(`[agentlog-mcp]   affected_files=${JSON.stringify(affectedFiles)}\n`);
        process.stderr.write(`[agentlog-mcp]   workspace_path=${workspacePath}\n`);

        const id = await postSession({
          provider: "mcp",
          model: "unknown",
          source: "mcp-tool-call",
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
