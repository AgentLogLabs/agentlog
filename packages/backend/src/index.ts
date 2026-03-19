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
import { getDatabase, closeDatabase } from "./db/database";

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
    await app.close();
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
        health: "/health",
      },
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
