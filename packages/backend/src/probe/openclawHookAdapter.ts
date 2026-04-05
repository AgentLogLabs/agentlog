/**
 * @agentlog/backend — OpenClaw Hook 适配器
 *
 * 将 OpenClaw Hook 事件转换为 AgentLog Span 格式，
 * 并通过 TelemetryProbe 异步上报。
 *
 * 此模块供 OpenClaw Hook handler 使用：
 * - 导出 default handler 函数供 OpenClaw 加载
 * - 支持 agent:bootstrap, session:start, session:end 等事件
 */

import {
  captureAgentBootstrap,
  captureSessionStart,
  captureSessionEnd,
  initProbe,
  shutdownProbe,
  type ProbeConfig,
} from "./telemetryProbe.js";

// ─────────────────────────────────────────────
// 初始化探针
// ─────────────────────────────────────────────

let initialized = false;

function ensureProbe(): void {
  if (initialized) {
    return;
  }

  const config: ProbeConfig = {
    gatewayUrl: process.env.AGENTLOG_GATEWAY_URL ?? "http://localhost:7892",
    agentId: process.env.AGENTLOG_AGENT_ID ?? "openclaw",
    agentName: process.env.AGENT || "OpenClaw",
    bufferSize: parseInt(process.env.AGENTLOG_PROBE_BUFFER_SIZE ?? "100", 10),
    flushIntervalMs: parseInt(process.env.AGENTLOG_PROBE_FLUSH_MS ?? "5000", 10),
  };

  initProbe(config);
  initialized = true;
}

// ─────────────────────────────────────────────
// OpenClaw Hook Handler 签名
// ─────────────────────────────────────────────

interface InternalHookEvent {
  type: "command" | "session" | "agent" | "gateway" | "message";
  action: string;
  timestamp: Date;
  sessionKey?: string;
  context?: Record<string, unknown>;
}

type HookHandler = (event: InternalHookEvent) => Promise<void> | void;

/**
 * OpenClaw Telemetry Hook Handler
 *
 * 导出为 default handler 供 OpenClaw 加载。
 * 事件映射：
 * - agent:bootstrap → captureAgentBootstrap
 * - session:start → captureSessionStart
 * - session:end → captureSessionEnd
 */
const agentlogTelemetryHook: HookHandler = async (event: InternalHookEvent): Promise<void> => {
  // 确保探针已初始化
  ensureProbe();

  try {
    switch (event.type) {
      case "agent":
        if (event.action === "bootstrap") {
          const ctx = event.context ?? {};
          captureAgentBootstrap({
            agentId: (ctx.agentId as string) ?? "unknown",
            agentName: (ctx.agentId as string) ?? "OpenClaw",
            sessionKey: event.sessionKey,
            workspaceDir: (ctx.workspaceDir as string) ?? process.cwd(),
            cfg: ctx.cfg as Record<string, unknown>,
          });
        }
        break;

      case "session":
        if (event.action === "start") {
          captureSessionStart({
            sessionKey: event.sessionKey ?? "unknown",
            sessionId: (event.context?.sessionId as string) ?? "unknown",
            agentId: event.context?.agentId as string | undefined,
          });
        } else if (event.action === "end") {
          captureSessionEnd({
            sessionKey: event.sessionKey ?? "unknown",
            sessionId: (event.context?.sessionId as string) ?? "unknown",
            durationMs: event.context?.durationMs as number | undefined,
          });
        }
        break;

      default:
        // 忽略其他事件类型
        break;
    }
  } catch (err) {
    // 捕获所有错误，确保不阻塞 OpenClaw 主流程
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[AgentLog Hook] 事件处理失败: ${msg}`);
  }
};

/**
 * 优雅关闭钩子
 */
async function shutdown(): Promise<void> {
  if (initialized) {
    await shutdownProbe();
    initialized = false;
    console.log("[AgentLog Hook] 钩子已关闭");
  }
}

// 导出为 default
export default agentlogTelemetryHook;

// 导出关闭函数（供外部调用）
export { shutdown };
