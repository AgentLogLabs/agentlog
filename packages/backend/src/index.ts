/**
 * @agentlog/backend — Fastify 服务入口
 *
 * 启动本地轻量后台，默认监听 http://localhost:7892
 * 可通过环境变量覆盖：
 *   AGENTLOG_PORT      监听端口（默认 7892）
 *   AGENTLOG_HOST      监听地址（默认 127.0.0.1）
 *   AGENTLOG_DB_PATH   SQLite 数据库文件路径
 *   NODE_ENV           production / development（影响日志级别）
 */

import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";

import sessionsRoutes from "./routes/sessions";
import commitsRouter from "./routes/commits";
import { exportRoutes } from "./routes/export";
import hooksRoutes from "./routes/hooks";
import spansRoutes from "./routes/spans";
import gitHooksRoutes from "./routes/gitHooks";
import tracesRoutes from "./routes/traces";
import { getDatabase, closeDatabase } from "./db/database";
import {
  addSseClient,
  removeSseClient,
  broadcastEvent,
  closeAllClients,
} from "./utils/sseManager";

// ─────────────────────────────────────────────
// 配置常量
// ─────────────────────────────────────────────

const PORT = parseInt(process.env.AGENTLOG_PORT ?? "7892", 10);
const HOST = process.env.AGENTLOG_HOST ?? "127.0.0.1";
const IS_DEV = process.env.NODE_ENV !== "production";

// ─────────────────────────────────────────────
// 数据库预热
// ─────────────────────────────────────────────

function initDatabase(): void {
  try {
    getDatabase();
  } catch (err) {
    console.error("[AgentLog] 数据库初始化失败，服务退出", err);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────
// 优雅退出
// ─────────────────────────────────────────────

async function gracefulShutdown(
  app: FastifyInstance,
  signal: string,
): Promise<void> {
  app.log.info(`[AgentLog] 收到信号 ${signal}，正在优雅退出…`);
  try {
    // 关闭所有 SSE 客户端连接
    await closeAllClients();
    // 关闭 Fastify 应用
    await app.close();
    // 关闭数据库
    closeDatabase();
    app.log.info("[AgentLog] 服务已正常关闭");
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "[AgentLog] 关闭时发生错误");
    process.exit(1);
  }
}

// ─────────────────────────────────────────────
// 应用构建 & 启动（全部在 async 函数内，无 top-level await）
// ─────────────────────────────────────────────

async function start(): Promise<void> {
  // 1. 初始化数据库（同步，失败则 exit）
  initDatabase();

  // 2. 创建 Fastify 实例
  //
  // pino-pretty 为可选依赖：开发模式下若已安装则启用彩色格式化输出，
  // 未安装时自动降级为普通 JSON 日志，不影响服务正常启动。
  const devLoggerConfig = (() => {
    if (!IS_DEV) return { level: "info" as const };
    try {
      require.resolve("pino-pretty");
      return {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
        level: "debug" as const,
      };
    } catch {
      // pino-pretty 未安装，降级为 JSON 日志
      return { level: "debug" as const };
    }
  })();

  const app = Fastify({ logger: devLoggerConfig });

  // 3. 注册插件

  /** CORS：仅允许本地来源（VS Code Webview / localhost 页面） */
  await app.register(cors, {
    origin: (
      origin: string | undefined,
      cb: (err: Error | null, allow: boolean) => void,
    ) => {
      if (
        !origin ||
        origin.startsWith("vscode-webview://") ||
        origin.startsWith("vscode-file://") ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        cb(null, true);
        return;
      }
      cb(new Error(`CORS: 不允许的来源 ${origin}`), false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  });

  // 4. 健康检查 / 元信息接口

  app.get("/health", async (_req, reply) => {
    return reply.send({
      status: "ok",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    });
  });

  app.get("/api", async (_req, reply) => {
    return reply.send({
      name: "AgentLog Backend",
      version: "0.1.0",
      description: "AI 编程行车记录仪 — 本地轻量后台服务",
      endpoints: {
        sessions: "/api/sessions",
        commits: "/api/commits",
        export: "/api/export",
        hooks: "/api/hooks/:agent/:event",
        spans: "/api/spans",
        mcpSse: "/mcp/sse",
        health: "/health",
        status: "/api/status",
      },
    });
  });

  app.get("/api/status", async (_req, reply) => {
    const memUsage = process.memoryUsage();
    return reply.send({
      status: "running",
      version: "0.1.0",
      uptime: Math.floor(process.uptime()),
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024) + " MB",
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + " MB",
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + " MB",
      },
      timestamp: new Date().toISOString(),
    });
  });

  // 5. 业务路由注册

  /** AgentSession CRUD + 查询 + 统计 */
  await app.register(sessionsRoutes);

  /** Commit 绑定 + Git Hook 管理 */
  await app.register(commitsRouter, { prefix: "/api/commits" });

  /** Lifecycle Hook 接收（Claude Code / Cursor / Cline 等 Agent 的 HTTP Hook） */
  await app.register(hooksRoutes);

  /** 导出（周报 / PR 描述 / JSONL / CSV） */
  await exportRoutes(app);

  /** 高频 Span 数据接收（探针专用） */
  await app.register(spansRoutes, { prefix: "/api" });

  /** Git Hook 路由（post-commit 回调等） */
  await app.register(gitHooksRoutes, { prefix: "/api/hooks" });

  /** Trace API（UC-002 summary, UC-003 diff） */
  await app.register(tracesRoutes, { prefix: "/api/traces" });

  /** MCP SSE 端点（供外部 IDE 接入） */
  app.get("/mcp/sse", async (req, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");

    const clientId = (req.query as { clientId?: string }).clientId ?? `client-${Date.now()}`;
    const sseClient = {
      id: clientId,
      timestamp: new Date().toISOString(),
    };

    req.log.info(`[MCP SSE] 客户端已连接: ${JSON.stringify(sseClient)}`);

    // 注册到 SSE 客户端管理器
    addSseClient(clientId, reply.raw);

    // 发送连接确认
    reply.raw.write(`data: ${JSON.stringify({ type: "connected", client: sseClient })}\n\n`);

    // 定期心跳
    const heartbeatInterval = setInterval(() => {
      if (reply.raw.writable) {
        reply.raw.write(`data: ${JSON.stringify({ type: "heartbeat", timestamp: new Date().toISOString() })}\n\n`);
      }
    }, 30000);

    req.raw.on("close", () => {
      clearInterval(heartbeatInterval);
      removeSseClient(clientId);
      req.log.info(`[MCP SSE] 客户端已断开: ${clientId}`);
    });
  });

  /**
   * MCP SSE 消息端点
   * 接收客户端的 MCP JSON-RPC 请求（POST）
   * 用于完整的 MCP over SSE 双轨通信
   */
  app.post("/mcp/messages", async (req, reply) => {
    const sessionId = (req.query as { sessionId?: string }).sessionId;
    const body = req.body as Record<string, unknown>;

    req.log.info(`[MCP Messages] 收到消息: method=${body.method ?? "unknown"}, sessionId=${sessionId ?? "none"}`);

    // 处理 JSON-RPC 请求
    if (body.method === "tools/list") {
      // 返回工具列表（与 stdio MCP 服务器相同）
      return reply.send({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "log_turn",
              description: "逐轮上报 AI 对话消息",
              inputSchema: {
                type: "object",
                properties: {
                  session_id: { type: "string" },
                  role: { type: "string", enum: ["user", "assistant", "tool"] },
                  content: { type: "string" },
                  tool_name: { type: "string" },
                  tool_input: { type: "string" },
                  model: { type: "string" },
                  workspace_path: { type: "string" },
                },
                required: ["role", "content"],
              },
            },
            {
              name: "log_intent",
              description: "任务结束后记录汇总信息",
              inputSchema: {
                type: "object",
                properties: {
                  session_id: { type: "string" },
                  response: { type: "string" },
                  affected_files: { type: "array", items: { type: "string" } },
                  duration_ms: { type: "number" },
                },
                required: ["response"],
              },
            },
            {
              name: "query_historical_interaction",
              description: "检索历史交互记录",
              inputSchema: {
                type: "object",
                properties: {
                  keyword: { type: "string" },
                  filename: { type: "string" },
                  session_id: { type: "string" },
                  start_date: { type: "string" },
                  end_date: { type: "string" },
                  page: { type: "number" },
                  page_size: { type: "number" },
                },
              },
            },
            {
              name: "create_trace",
              description: "创建新的 Trace（全局任务）",
              inputSchema: {
                type: "object",
                properties: {
                  task_goal: { type: "string" },
                  status: { type: "string", enum: ["running", "paused", "completed", "failed"] },
                },
                required: ["task_goal"],
              },
            },
            {
              name: "create_span",
              description: "创建新的 Span（执行单元）",
              inputSchema: {
                type: "object",
                properties: {
                  trace_id: { type: "string" },
                  parent_span_id: { type: ["string", "null"] },
                  actor_type: { type: "string", enum: ["human", "agent", "system"] },
                  actor_name: { type: "string" },
                  payload: { type: "object" },
                },
                required: ["trace_id", "actor_type", "actor_name"],
              },
            },
          ],
        },
      });
    }

    if (body.method === "tools/call") {
      const args = (body.params as { arguments?: Record<string, unknown> })?.arguments ?? {};
      const toolName = args.tool_name as string | undefined;

      if (toolName === "create_trace" || toolName === "log_turn" || toolName === "log_intent" || toolName === "create_span") {
        // 转发到内部 API 处理
        let apiPath = "/api/sessions";
        let method = "POST";

        if (toolName === "create_trace") {
          apiPath = "/api/traces";
        } else if (toolName === "create_span") {
          apiPath = "/api/spans";
        }

        try {
          const resp = await fetch(`http://localhost:${PORT}${apiPath}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(args),
          });

          const result = (await resp.json()) as { success?: boolean; data?: unknown; error?: string };

          // SSE 推送：广播新创建的 Span/Trace 事件
          if (toolName === "create_span" && result.success) {
            broadcastEvent({
              type: "span_created",
              data: result.data,
              timestamp: new Date().toISOString(),
            });
          }

          return reply.send({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.send({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32603, message: `Internal error: ${msg}` },
          });
        }
      }

      // query_historical_interaction
      if (toolName === "query_historical_interaction") {
        try {
          const queryParams = new URLSearchParams();
          for (const [key, value] of Object.entries(args)) {
            if (value !== undefined && value !== null) {
              queryParams.set(key, String(value));
            }
          }
          const resp = await fetch(`http://localhost:${PORT}/api/sessions?${queryParams.toString()}`);
          const result = (await resp.json()) as unknown;

          return reply.send({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.send({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32603, message: `Internal error: ${msg}` },
          });
        }
      }

      return reply.send({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
    }

    // 未知方法
    return reply.send({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: `Method not found: ${body.method}` },
    });
  });

  // 6. 全局错误处理

  app.setErrorHandler((error, _req, reply) => {
    app.log.error(error);

    if (error.validation) {
      return reply.status(400).send({
        success: false,
        error: "请求参数校验失败",
        details: error.validation,
      });
    }

    if (error.message?.startsWith("CORS:")) {
      return reply.status(403).send({
        success: false,
        error: error.message,
      });
    }

    return reply.status(error.statusCode ?? 500).send({
      success: false,
      error: IS_DEV ? error.message : "服务器内部错误",
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send({
      success: false,
      error: `接口不存在：${_req.method} ${_req.url}`,
    });
  });

  // 7. 注册优雅退出信号

  process.on("SIGTERM", () => gracefulShutdown(app, "SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown(app, "SIGINT"));

  // 8. 启动监听

  try {
    const address = await app.listen({ port: PORT, host: HOST });
    app.log.info(`[AgentLog] 后台服务已启动：${address}`);
    app.log.info(`[AgentLog] 健康检查：${address}/health`);
    app.log.info(`[AgentLog] API 入口：  ${address}/api`);

    if (IS_DEV) {
      app.log.debug("[AgentLog] 已启用开发模式（详细日志 + pino-pretty）");
    }
  } catch (err) {
    console.error("[AgentLog] 服务启动失败", err);
    process.exit(1);
  }
}

start();
