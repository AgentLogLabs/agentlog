/**
 * @agentlog/vscode-extension — TracePanel Webview Provider
 *
 * 提供 Trace 树状视图的 Webview 面板，支持 SSE 实时刷新。
 *
 * 通信协议：
 *  VS Code Extension (host) <──── postMessage ────> Webview (guest)
 *  - host → guest: { type: string; payload: unknown }
 *  - guest → host: { command: string; data: unknown }
 */

import * as vscode from "vscode";
import { getBackendClient } from "../client/backendClient";

const SUPPORTED_LANGUAGES = ["en", "zh-CN", "zh-TW"];
const DEFAULT_LANGUAGE = "en";

function getLanguage(): string {
  const lang = vscode.env.language;
  if (SUPPORTED_LANGUAGES.includes(lang)) {
    return lang;
  }
  return DEFAULT_LANGUAGE;
}

function generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ─────────────────────────────────────────────
// Host → Webview 消息类型
// ─────────────────────────────────────────────

type ToWebviewMessage =
  | { type: "loadTrace"; payload: TraceDetail }
  | { type: "spanCreated"; payload: SpanItem }
  | { type: "error"; payload: { message: string } }
  | { type: "loading"; payload: { loading: boolean } }
  | { type: "backendStatus"; payload: { alive: boolean } };

// ─────────────────────────────────────────────
// Webview → Host 消息类型
// ─────────────────────────────────────────────

type FromWebviewMessage =
  | { command: "ready" }
  | { command: "queryTrace"; data: { traceId: string } }
  | { command: "queryTraces" };

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

export interface TraceDetail {
  id: string;
  taskGoal: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  spanTree: SpanItem[];
  summary: TraceSummary;
  tokenUsage?: TokenUsage;
  timeline?: TimelineInfo;
}

export interface SpanItem {
  id: string;
  parentSpanId: string | null;
  actorType: "human" | "agent" | "system";
  actorName: string;
  payload: Record<string, unknown>;
}

export interface TraceSummary {
  totalSpans: number;
  humanSpans: number;
  agentSpans: number;
  systemSpans: number;
}

export interface TokenUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalTokens: number;
}

export interface TimelineInfo {
  earliestEvent: string | null;
  latestEvent: string | null;
  durationMs: number | null;
}

// ─────────────────────────────────────────────
// TracePanel
// ─────────────────────────────────────────────

export class TracePanel {
  public static current: TracePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private sseConnection: { close: () => void } | null = null;
  private currentTraceId: string | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage((msg: FromWebviewMessage) => {
      this.handleMessage(msg);
    });

    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  static createOrShow(extensionUri: vscode.Uri): TracePanel {
    if (TracePanel.current) {
      TracePanel.current.panel.reveal(vscode.ViewColumn.One);
      return TracePanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "agentlog.trace",
      "AgentLog Trace",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    TracePanel.current = new TracePanel(panel, extensionUri);
    return TracePanel.current;
  }

  /**
   * 打开指定 trace 的详情面板
   */
  static async open(traceId: string, context: vscode.ExtensionContext): Promise<void> {
    const panel = TracePanel.createOrShow(context.extensionUri);
    await panel.loadTrace(traceId);
  }

  private handleMessage(msg: FromWebviewMessage): void {
    switch (msg.command) {
      case "ready":
        this.postMessage({ type: "backendStatus", payload: { alive: true } });
        this.connectSSE();
        break;
      case "queryTraces":
        this.loadTraces();
        break;
      case "queryTrace":
        this.loadTrace(msg.data.traceId);
        break;
    }
  }

  async loadTraces(): Promise<void> {
    try {
      this.postMessage({ type: "loading", payload: { loading: true } });

      const client = getBackendClient();
      const response = await client.getTraces({ pageSize: 50 });

      this.panel.webview.postMessage({
        type: "loadTraces",
        payload: response,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: "error", payload: { message: msg } });
    } finally {
      this.postMessage({ type: "loading", payload: { loading: false } });
    }
  }

  async loadTrace(traceId: string): Promise<void> {
    this.currentTraceId = traceId;

    try {
      this.postMessage({ type: "loading", payload: { loading: true } });

      const client = getBackendClient();
      const response = await client.getTraceSummary(traceId);

      this.postMessage({ type: "loadTrace", payload: response as TraceDetail });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: "error", payload: { message: msg } });
    } finally {
      this.postMessage({ type: "loading", payload: { loading: false } });
    }
  }

  private connectSSE(): void {
    this.disconnectSSE();

    // Get backend URL from configuration
    const backendUrl = vscode.workspace.getConfiguration("agentlog").get<string>("backendUrl") ?? "http://localhost:7892";
    const eventSource = new EventSource(`${backendUrl}/mcp/sse`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "span_created" && data.data) {
          // 如果是当前 trace 的 span，则刷新
          if (
            this.currentTraceId &&
            data.data.traceId === this.currentTraceId
          ) {
            this.loadTrace(this.currentTraceId);
          }
          // 通知 webview 有新 span
          this.postMessage({ type: "spanCreated", payload: data.data });
        }
      } catch {
        // ignore parse errors
      }
    };

    eventSource.onerror = () => {
      console.log("[TracePanel] SSE 连接断开，5秒后重连...");
      setTimeout(() => this.connectSSE(), 5000);
    };

    this.sseConnection = eventSource;
  }

  private disconnectSSE(): void {
    if (this.sseConnection) {
      this.sseConnection.close();
      this.sseConnection = null;
    }
  }

  private postMessage(message: ToWebviewMessage): void {
    this.panel.webview.postMessage(message);
  }

  dispose(): void {
    this.disconnectSSE();
    TracePanel.current = undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = generateNonce();
    const lang = getLanguage();

    const labels = {
      en: {
        title: "AgentLog Trace",
        loading: "Loading...",
        noTrace: "No trace selected",
        selectTrace: "Select a trace from the sidebar",
        stats: "Statistics",
        spans: "Spans",
        timeline: "Timeline",
        human: "Human",
        agent: "Agent",
        system: "System",
        rootSpans: "Root Spans",
        totalSpans: "Total",
        duration: "Duration",
        effectiveTime: "Effective",
        startTime: "Start",
        endTime: "End",
        tokens: "Token Stats",
        input: "Input",
        output: "Output",
        cacheCreate: "Cache Create",
        cacheRead: "Cache Read",
        total: "Total",
        content: "Content",
      },
      "zh-CN": {
        title: "AgentLog Trace",
        loading: "加载中...",
        noTrace: "未选择 Trace",
        selectTrace: "请从侧边栏选择一个 Trace",
        stats: "统计",
        spans: "执行单元",
        timeline: "时间线",
        human: "人工",
        agent: "Agent",
        system: "系统",
        rootSpans: "根节点",
        totalSpans: "总计",
        duration: "总耗时",
        effectiveTime: "有效时间",
        startTime: "开始",
        endTime: "结束",
        tokens: "Token 统计",
        input: "输入",
        output: "输出",
        cacheCreate: "缓存创建",
        cacheRead: "缓存读取",
        total: "合计",
        content: "内容",
      },
    };

    const t = labels[lang as keyof typeof labels] || labels.en;

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline';">
<title>${t.title}</title>
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 16px; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); }
.loading { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }
.error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 12px; border-radius: 4px; margin-bottom: 16px; }
.trace-header { background: var(--vscode-editorWidget-background); border-radius: 4px; padding: 12px; margin-bottom: 16px; }
.trace-id { font-family: monospace; font-size: 12px; color: var(--vscode-descriptionForeground); }
.trace-goal { font-size: 16px; font-weight: 600; margin: 8px 0; }
.status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
.status-running { background: #1e8cff30; color: #1e8cff; }
.status-completed { background: #4caf5030; color: #4caf50; }
.status-failed { background: #f4433630; color: #f44336; }
.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.stat-card { background: var(--vscode-editorWidget-background); border-radius: 4px; padding: 12px; text-align: center; }
.stat-value { font-size: 24px; font-weight: 600; }
.stat-label { font-size: 12px; color: var(--vscode-descriptionForeground); }
.info-section { margin-bottom: 16px; }
.info-section h3 { margin: 0 0 8px 0; font-size: 14px; color: var(--vscode-foreground); }
.info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
.info-card { background: var(--vscode-editorWidget-background); border-radius: 4px; padding: 12px; }
.info-label { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.info-value { font-size: 18px; font-weight: 600; }
.span-tree { background: var(--vscode-editorWidget-background); border-radius: 4px; padding: 12px; }
.span-item { padding: 10px; margin: 4px 0; border-radius: 4px; cursor: pointer; border-left: 3px solid #888; }
.span-item:hover { background: var(--vscode-list-hoverBackground); }
.span-human { border-left-color: #4caf50; }
.span-agent { border-left-color: #1e8cff; }
.span-system { border-left-color: #ff9800; }
.span-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.span-id { font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground); }
.span-name { font-weight: 500; }
.span-meta { font-size: 12px; color: var(--vscode-descriptionForeground); }
.span-time { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
.span-token { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
.token-badge { font-size: 11px; padding: 2px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.token-badge.tot { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.span-content { font-size: 13px; margin-top: 6px; padding: 8px; background: var(--vscode-editor-background); border-radius: 4px; color: var(--vscode-foreground); word-break: break-word; white-space: pre-wrap; }
.span-children { margin-left: 20px; margin-top: 8px; border-left: 1px dashed var(--vscode-widget-border); padding-left: 8px; }
.empty { text-align: center; padding: 60px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="app">
  <div class="empty">
    <p>${t.selectTrace}</p>
  </div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const t = ${JSON.stringify(t)};

let state = {
  trace: null,
  loading: false,
};

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'loadTrace':
      state.trace = msg.payload;
      render();
      break;
    case 'spanCreated':
      if (state.trace && msg.payload.traceId === state.trace.traceId) {
        vscode.postMessage({ command: 'queryTrace', data: { traceId: state.trace.traceId } });
      }
      break;
    case 'loading':
      state.loading = msg.payload.loading;
      if (state.loading) renderLoading();
      break;
    case 'error':
      renderError(msg.payload.message);
      break;
  }
});

function renderLoading() {
  document.getElementById('app').innerHTML = '<div class="loading">' + t.loading + '</div>';
}

function renderError(msg) {
  document.getElementById('app').innerHTML = '<div class="error">' + msg + '</div>';
}

function formatDuration(ms) {
  if (!ms) return '-';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  if (ms < 3600000) return (ms / 60000).toFixed(1) + 'm';
  return (ms / 3600000).toFixed(1) + 'h';
}

function formatTime(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString();
  } catch {
    return isoString;
  }
}

function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return n.toString();
  return (n / 1000).toFixed(1) + 'k';
}

function render() {
  if (!state.trace) {
    document.getElementById('app').innerHTML = '<div class="empty"><p>' + t.selectTrace + '</p></div>';
    return;
  }

  const trace = state.trace;
  const stats = trace.statistics || {};
  const tokenUsage = trace.tokenUsage || {};
  const timeline = trace.timeline || {};
  const rootSpans = trace.spanTree?.filter(s => !s.parentSpanId) || [];

  const statusClass = 'status-' + (trace.status || 'unknown');
  const statusText = trace.status || 'unknown';

  document.getElementById('app').innerHTML = \`
    <div class="trace-header">
      <div class="trace-id">\${trace.traceId}</div>
      <div class="trace-goal">\${trace.taskGoal || '(无任务目标)'}</div>
      <span class="status-badge \${statusClass}">\${statusText}</span>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">\${stats.totalSpans || 0}</div>
        <div class="stat-label">\${t.totalSpans}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">\${stats.humanSpans || 0}</div>
        <div class="stat-label">\${t.human}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">\${stats.agentSpans || 0}</div>
        <div class="stat-label">\${t.agent}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">\${stats.systemSpans || 0}</div>
        <div class="stat-label">\${t.system}</div>
      </div>
    </div>

    <div class="info-section">
      <h3>\${t.timeline}</h3>
      <div class="info-grid">
        <div class="info-card">
          <div class="info-label">\${t.duration}</div>
          <div class="info-value">\${formatDuration(timeline.durationMs)}</div>
        </div>
        <div class="info-card">
          <div class="info-label">\${t.startTime}</div>
          <div class="info-value">\${formatTime(timeline.earliestEvent)}</div>
        </div>
        <div class="info-card">
          <div class="info-label">\${t.endTime}</div>
          <div class="info-value">\${formatTime(timeline.latestEvent)}</div>
        </div>
      </div>
    </div>

    <div class="info-section">
      <h3>\${t.tokens}</h3>
      <div class="info-grid">
        <div class="info-card">
          <div class="info-label">\${t.input}</div>
          <div class="info-value">\${formatTokens(tokenUsage.totalInputTokens || 0)}</div>
        </div>
        <div class="info-card">
          <div class="info-label">\${t.output}</div>
          <div class="info-value">\${formatTokens(tokenUsage.totalOutputTokens || 0)}</div>
        </div>
        <div class="info-card">
          <div class="info-label">\${t.total}</div>
          <div class="info-value">\${formatTokens(tokenUsage.totalTokens || 0)}</div>
        </div>
        <div class="info-card">
          <div class="info-label">\${t.cacheCreate}</div>
          <div class="info-value">\${formatTokens(tokenUsage.totalCacheCreationTokens || 0)}</div>
        </div>
        <div class="info-card">
          <div class="info-label">\${t.cacheRead}</div>
          <div class="info-value">\${formatTokens(tokenUsage.totalCacheReadTokens || 0)}</div>
        </div>
      </div>
    </div>

    <h3>\${t.rootSpans} (\${rootSpans.length})</h3>
    <div class="span-tree">
      \${rootSpans.map(span => renderSpan(span, trace.spanTree)).join('')}
    </div>
  \`;
}

function renderSpan(span, allSpans) {
  const children = allSpans.filter(s => s.parentSpanId === span.id);
  const typeClass = 'span-' + (span.actorType || 'system');
  const toolName = span.payload?.toolName || '';
  const event = span.payload?.event || '';
  const content = span.payload?.content || '';
  const tokenInfo = span.payload?.tokenUsage || '';
  const isHuman = span.actorType === 'human';

  // Span 时间戳
  const timeStr = span.createdAt ? formatTime(span.createdAt) : '-';
  const durationStr = span.payload?.durationMs ? formatDuration(span.payload.durationMs) : '';

  // 对于 human span，显示内容
  const contentHtml = (isHuman && content) ? \`<div class="span-content">\${escapeHtml(content.slice(0, 300))}\${content.length > 300 ? '...' : ''}</div>\` : '';

  // Token 统计
  let tokenHtml = '';
  if (tokenInfo) {
    const inTokens = tokenInfo.inputTokens || 0;
    const outTokens = tokenInfo.outputTokens || 0;
    const totalSpanTokens = inTokens + outTokens;
    tokenHtml = \`<div class="span-token">
      <span class="token-badge">IN: \${formatTokens(inTokens)}</span>
      <span class="token-badge">OUT: \${formatTokens(outTokens)}</span>
      <span class="token-badge">TOT: \${formatTokens(totalSpanTokens)}</span>
    </div>\`;
  }

  // 时间信息
  let timeHtml = \`<div class="span-time">⏱ \${timeStr}\${durationStr ? ' (' + durationStr + ')' : ''}</div>\`;

  return \`
    <div class="span-item \${typeClass}">
      <div class="span-header">
        <div class="span-id">\${span.id.slice(0, 12)}...</div>
        <div class="span-name">\${span.actorName} \${toolName ? '(' + toolName + ')' : ''}</div>
      </div>
      <div class="span-meta">\${span.actorType} | \${event || (isHuman ? 'user message' : '')}</div>
      \${timeHtml}
      \${tokenHtml}
      \${contentHtml}
      \${children.length > 0 ? '<div class="span-children">' + children.map(c => renderSpan(c, allSpans)).join('') + '</div>' : ''}
    </div>
  \`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
