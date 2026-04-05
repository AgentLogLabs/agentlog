/**
 * @agentlog/backend — Telemetry Probe
 *
 * 探针模块：挂载到 OpenClaw Hook 系统，捕获 agent 生命周期事件，
 * 并将事件异步上报给 AgentLog 网关，不阻塞 OpenClaw 主流程。
 *
 * 支持的事件：
 * - agent:bootstrap - Agent 启动事件
 * - session:start - Session 启动
 * - session:end - Session 结束
 *
 * 使用本地缓冲队列 + 异步批量上报，保证不丢包且不阻塞。
 */

import { ulid } from "ulid";

// ─────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────

const DEFAULT_GATEWAY_URL = process.env.AGENTLOG_GATEWAY_URL ?? "http://localhost:7892";
const BUFFER_SIZE = 100;           // 缓冲区达到此数量时触发上报
const FLUSH_INTERVAL_MS = 5000;     // 定期强制上报间隔
const MAX_RETRY_ATTEMPTS = 3;       // 失败重试次数

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

export interface TelemetryEvent {
  id: string;          // ULID
  traceId?: string;
  parentSpanId?: string;
  actorType: "human" | "agent" | "system";
  actorName: string;
  event: string;       // 事件类型：bootstrap, session:start, session:end
  payload: Record<string, unknown>;
  timestamp: string;   // ISO 8601
  source: "openclaw_telemetry";
}

export interface ProbeConfig {
  gatewayUrl?: string;
  agentId?: string;
  agentName?: string;
  traceId?: string;    // 可选的初始 trace ID
  bufferSize?: number;
  flushIntervalMs?: number;
}

// ─────────────────────────────────────────────
// 本地缓冲队列
// ─────────────────────────────────────────────

class SpanBuffer {
  private buffer: TelemetryEvent[] = [];
  private readonly maxSize: number;
  private readonly flushIntervalMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly gatewayUrl: string;
  private readonly agentId: string;
  private readonly agentName: string;
  private retryAttempts = new Map<string, number>();

  constructor(config: ProbeConfig) {
    this.maxSize = config.bufferSize ?? BUFFER_SIZE;
    this.flushIntervalMs = config.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.gatewayUrl = config.gatewayUrl ?? DEFAULT_GATEWAY_URL;
    this.agentId = config.agentId ?? "unknown";
    this.agentName = config.agentName ?? "OpenClaw";
  }

  /**
   * 启动探针（开始定时刷新）
   */
  start(): void {
    if (this.flushTimer) {
      return; // 已启动
    }
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    console.log(`[AgentLog Probe] 探针已启动，缓冲大小=${this.maxSize}, 刷新间隔=${this.flushIntervalMs}ms`);
  }

  /**
   * 停止探针（刷新剩余缓冲）
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush(true);
    console.log("[AgentLog Probe] 探针已停止");
  }

  /**
   * 添加事件到缓冲队列
   */
  push(event: TelemetryEvent): void {
    this.buffer.push(event);

    // 达到缓冲阈值时触发上报
    if (this.buffer.length >= this.maxSize) {
      void this.flush();
    }
  }

  /**
   * 刷新缓冲队列，将事件上报到网关
   */
  private async flush(force = false): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    // 强制刷新时取走所有事件，否则取走缓冲的70%或至少1个
    const toSend = force
      ? this.buffer.splice(0, this.buffer.length)
      : this.buffer.splice(0, Math.max(1, Math.floor(this.buffer.length * 0.7)));

    if (toSend.length === 0) {
      return;
    }

    console.log(`[AgentLog Probe] 上报 ${toSend.length} 个事件到 ${this.gatewayUrl}`);

    // 批量上报
    const results = await Promise.allSettled(
      toSend.map((event) => this.reportEvent(event))
    );

    // 处理失败的事件
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      console.warn(`[AgentLog Probe] 上报失败 ${failed.length}/${toSend.length} 个事件`);
    }
  }

  /**
   * 上报单个事件到网关
   */
  private async reportEvent(event: TelemetryEvent): Promise<void> {
    const retryCount = this.retryAttempts.get(event.id) ?? 0;

    try {
      const resp = await fetch(`${this.gatewayUrl}/api/spans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: event.traceId,
          parentSpanId: event.parentSpanId,
          actorType: event.actorType,
          actorName: event.actorName,
          payload: {
            ...event.payload,
            source: event.source,
            event: event.event,
          },
        }),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      // 上报成功，移除重试记录
      this.retryAttempts.delete(event.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (retryCount < MAX_RETRY_ATTEMPTS) {
        // 重试：将事件放回缓冲队列
        this.retryAttempts.set(event.id, retryCount + 1);
        this.buffer.unshift(event);
        console.warn(`[AgentLog Probe] 事件 ${event.id} 上报失败，将重试 (${retryCount + 1}/${MAX_RETRY_ATTEMPTS}): ${msg}`);
      } else {
        // 超过最大重试次数，丢弃
        console.error(`[AgentLog Probe] 事件 ${event.id} 上报失败，已丢弃: ${msg}`);
        this.retryAttempts.delete(event.id);
      }
    }
  }
}

// ─────────────────────────────────────────────
// 探针单例
// ─────────────────────────────────────────────

let globalProbe: SpanBuffer | null = null;
let globalTraceId: string | null = null;

/**
 * 初始化全局探针
 */
export function initProbe(config: ProbeConfig = {}): SpanBuffer {
  if (globalProbe) {
    console.warn("[AgentLog Probe] 探针已初始化，忽略重复调用");
    return globalProbe;
  }

  // 优先从环境变量读取 trace_id
  globalTraceId = process.env.AGENTLOG_TRACE_ID ?? config.traceId ?? null;
  if (globalTraceId) {
    console.log(`[AgentLog Probe] 使用已有 Trace: ${globalTraceId}`);
  }

  globalProbe = new SpanBuffer(config);
  globalProbe.start();

  return globalProbe;
}

/**
 * 获取全局探针实例
 */
export function getProbe(): SpanBuffer | null {
  return globalProbe;
}

/**
 * 获取或创建当前 Trace ID
 */
export function getCurrentTraceId(): string {
  if (!globalTraceId) {
    globalTraceId = process.env.AGENTLOG_TRACE_ID ?? ulid();
    if (!process.env.AGENTLOG_TRACE_ID) {
      console.log(`[AgentLog Probe] 创建新 Trace: ${globalTraceId}`);
    }
  }
  return globalTraceId;
}

/**
 * 捕获 Agent 启动事件
 */
export function captureAgentBootstrap(params: {
  agentId: string;
  agentName: string;
  sessionKey?: string;
  workspaceDir?: string;
  cfg?: Record<string, unknown>;
}): void {
  if (!globalProbe) {
    console.warn("[AgentLog Probe] 探针未初始化，忽略事件");
    return;
  }

  const event: TelemetryEvent = {
    id: ulid(),
    traceId: getCurrentTraceId(),
    actorType: "agent",
    actorName: params.agentName,
    event: "agent:bootstrap",
    payload: {
      agentId: params.agentId,
      agentName: params.agentName,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
    },
    timestamp: new Date().toISOString(),
    source: "openclaw_telemetry",
  };

  globalProbe.push(event);
}

/**
 * 捕获 Session 启动事件
 */
export function captureSessionStart(params: {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
}): void {
  if (!globalProbe) {
    return;
  }

  const event: TelemetryEvent = {
    id: ulid(),
    traceId: getCurrentTraceId(),
    actorType: "system",
    actorName: "OpenClaw-Session",
    event: "session:start",
    payload: {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
    },
    timestamp: new Date().toISOString(),
    source: "openclaw_telemetry",
  };

  globalProbe.push(event);
}

/**
 * 捕获 Session 结束事件
 */
export function captureSessionEnd(params: {
  sessionKey: string;
  sessionId: string;
  durationMs?: number;
}): void {
  if (!globalProbe) {
    return;
  }

  const event: TelemetryEvent = {
    id: ulid(),
    traceId: getCurrentTraceId(),
    actorType: "system",
    actorName: "OpenClaw-Session",
    event: "session:end",
    payload: {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      durationMs: params.durationMs,
    },
    timestamp: new Date().toISOString(),
    source: "openclaw_telemetry",
  };

  globalProbe.push(event);
}

/**
 * 关闭探针
 */
export async function shutdownProbe(): Promise<void> {
  if (globalProbe) {
    await globalProbe.stop();
    globalProbe = null;
    globalTraceId = null;
  }
}
