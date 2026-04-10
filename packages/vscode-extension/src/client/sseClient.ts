/**
 * @agentlog/vscode-extension — SSE Client (Node.js)
 *
 * 使用 http 模块连接后端 SSE 端点，接收实时事件推送。
 * 支持自动重连、心跳检测、事件分发。
 */

import * as http from "http";
import * as vscode from "vscode";

export interface SseEvent {
  type: string;
  data: unknown;
  timestamp: string;
}

export type SseEventHandler = (event: SseEvent) => void;

export class SseClient implements vscode.Disposable {
  private _req: http.ClientRequest | null = null;
  private _handlers: Map<string, Set<SseEventHandler>> = new Map();
  private _backendUrl: string;
  private _reconnectTimer: NodeJS.Timeout | null = null;
  private _heartbeatTimer: NodeJS.Timeout | null = null;
  private _lastHeartbeat = 0;
  private _disposed = false;
  private _manualDisconnect = false;
  private _buffer = "";
  private static readonly HEARTBEAT_TIMEOUT_MS = 60_000;
  private static readonly RECONNECT_DELAY_MS = 3_000;

  constructor(backendUrl: string) {
    this._backendUrl = backendUrl.replace(/\/+$/, "");
  }

  connect(): void {
    if (this._disposed) return;
    this._manualDisconnect = false;
    this._doConnect();
  }

  disconnect(): void {
    this._manualDisconnect = true;
    this._cleanup();
  }

  on(eventType: string, handler: SseEventHandler): vscode.Disposable {
    let handlers = this._handlers.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this._handlers.set(eventType, handlers);
    }
    handlers.add(handler);

    return {
      dispose: () => {
        handlers?.delete(handler);
      },
    };
  }

  dispose(): void {
    this._disposed = true;
    this._cleanup();
    this._handlers.clear();
  }

  private _doConnect(): void {
    if (this._disposed || this._manualDisconnect) return;

    this._cleanupRequest();

    const url = new URL(`${this._backendUrl}/mcp/sse`);
    console.log(`[AgentLog][SseClient] 连接 SSE: ${url.toString()}`);

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    };

    const httpModule = url.protocol === "https:" ? require("https") : http;

    try {
      this._req = httpModule.request(options, (res) => {
        this._lastHeartbeat = Date.now();
        this._startHeartbeatMonitor();

        res.on("data", (chunk: Buffer) => {
          this._buffer += chunk.toString();
          this._processBuffer();
        });

        res.on("end", () => {
          console.log(`[AgentLog][SseClient] SSE 连接结束`);
          this._scheduleReconnect();
        });

        res.on("error", (err: Error) => {
          console.error(`[AgentLog][SseClient] SSE 响应错误:`, err.message);
          this._scheduleReconnect();
        });
      });

      this._req.on("error", (err: Error) => {
        console.error(`[AgentLog][SseClient] SSE 请求错误:`, err.message);
        this._scheduleReconnect();
      });

      this._req.end();
    } catch (err) {
      console.error(`[AgentLog][SseClient] 创建 SSE 请求失败:`, err);
      this._scheduleReconnect();
    }
  }

  private _processBuffer(): void {
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop() ?? "";

    let eventData = "";
    let eventType = "message";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        eventData += line.slice(6);
      } else if (line.startsWith("event: ")) {
        eventType = line.slice(7);
      } else if (line === "") {
        if (eventData) {
          try {
            const data = JSON.parse(eventData) as SseEvent;
            this._lastHeartbeat = Date.now();

            if (data.type === "heartbeat") {
              console.log(`[AgentLog][SseClient] 收到心跳`);
              continue;
            }

            console.log(`[AgentLog][SseClient] 收到事件: ${data.type}`);
            this._dispatch(data);
          } catch (err) {
            console.error(`[AgentLog][SseClient] 解析事件失败:`, err);
          }
          eventData = "";
          eventType = "message";
        }
      }
    }
  }

  private _dispatch(event: SseEvent): void {
    const handlers = this._handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error(`[AgentLog][SseClient] 事件处理器错误:`, err);
        }
      }
    }
  }

  private _startHeartbeatMonitor(): void {
    this._stopHeartbeatMonitor();

    this._heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - this._lastHeartbeat;
      if (elapsed > SseClient.HEARTBEAT_TIMEOUT_MS) {
        console.warn(`[AgentLog][SseClient] 心跳超时 (${elapsed}ms)，重新连接`);
        this._scheduleReconnect();
      }
    }, 15_000);
  }

  private _stopHeartbeatMonitor(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this._disposed || this._manualDisconnect) return;

    this._cleanupRequest();
    this._stopHeartbeatMonitor();

    if (this._reconnectTimer) return;

    console.log(`[AgentLog][SseClient] ${SseClient.RECONNECT_DELAY_MS}ms 后尝试重连`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._doConnect();
    }, SseClient.RECONNECT_DELAY_MS);
  }

  private _cleanup(): void {
    this._stopHeartbeatMonitor();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._cleanupRequest();
  }

  private _cleanupRequest(): void {
    if (this._req) {
      this._req.removeAllListeners();
      this._req.destroy();
      this._req = null;
    }
    this._buffer = "";
  }
}
