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
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 16px; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); line-height: 1.5; }
.loading { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }
.error-banner { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 12px; border-radius: 4px; margin-bottom: 16px; color: var(--vscode-errorForeground); }

/* ── Header ── */
.trace-header { background: var(--vscode-editorWidget-background); border-radius: 6px; padding: 14px 16px; margin-bottom: 16px; border: 1px solid var(--vscode-widget-border); }
.trace-goal { font-size: 16px; font-weight: 600; margin: 0 0 10px 0; }
.trace-meta-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.trace-time-row { font-size: 11px; color: var(--vscode-descriptionForeground); display: flex; gap: 16px; flex-wrap: wrap; }
.trace-id-row { font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }

/* ── Badges ── */
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; white-space: nowrap; }
.badge-status-running  { background: #1e8cff22; color: #1e8cff; border: 1px solid #1e8cff44; }
.badge-status-completed{ background: #4caf5022; color: #4caf50; border: 1px solid #4caf5044; }
.badge-status-failed   { background: #f4433622; color: #f44336; border: 1px solid #f4433644; }
.badge-status-paused   { background: #ff980022; color: #ff9800; border: 1px solid #ff980044; }
.badge-model  { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.badge-source-opencode    { background: #6366f122; color: #818cf8; border: 1px solid #6366f144; }
.badge-source-cline       { background: #22c55e22; color: #4ade80; border: 1px solid #22c55e44; }
.badge-source-cursor      { background: #3b82f622; color: #60a5fa; border: 1px solid #3b82f644; }
.badge-source-claude-code { background: #c97b3e22; color: #c97b3e; border: 1px solid #c97b3e44; }
.badge-source-mcp-tool-call { background: #a855f722; color: #c084fc; border: 1px solid #a855f744; }
.badge-source { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

/* ── Stats grid ── */
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 10px; margin-bottom: 16px; }
.stat-card { background: var(--vscode-editorWidget-background); border-radius: 4px; padding: 10px 12px; text-align: center; border: 1px solid var(--vscode-widget-border); }
.stat-value { font-size: 22px; font-weight: 700; }
.stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }

/* ── Info section ── */
.info-section { margin-bottom: 16px; }
.info-section h3 { margin: 0 0 8px 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
.info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
.info-card { background: var(--vscode-editorWidget-background); border-radius: 4px; padding: 10px 12px; border: 1px solid var(--vscode-widget-border); }
.info-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.info-value { font-size: 16px; font-weight: 600; }

/* ── Span tree ── */
.section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 0 0 10px 0; }
.span-tree { }
.span-item { padding: 10px 12px; margin: 6px 0; border-radius: 4px; border-left: 3px solid #888; background: var(--vscode-editorWidget-background); border-top: 1px solid var(--vscode-widget-border); border-right: 1px solid var(--vscode-widget-border); border-bottom: 1px solid var(--vscode-widget-border); }
.span-human  { border-left-color: #4caf50; }
.span-agent  { border-left-color: #1e8cff; }
.span-system { border-left-color: #ff9800; }

.span-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.span-toggle { cursor: pointer; user-select: none; font-size: 11px; padding: 1px 5px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); flex-shrink: 0; }
.span-toggle:hover { opacity: 0.8; }
.span-id { font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground); }
.span-name { font-weight: 600; font-size: 13px; }
.span-badges { display: flex; gap: 5px; flex-wrap: wrap; }

.span-meta-row { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.span-meta-item { display: flex; align-items: center; gap: 4px; }

.span-token { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.token-badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-family: monospace; }
.token-badge-total { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

/* ── Span content blocks ── */
.span-block { margin-top: 8px; }
.span-block-header { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); padding: 4px 0; }
.span-block-header:hover { color: var(--vscode-foreground); }
.span-block-toggle { font-size: 10px; }
.span-block-body { margin-top: 4px; }
.span-block-body.collapsed { display: none; }
.span-content-text { font-size: 13px; padding: 8px 10px; background: var(--vscode-editor-background); border-radius: 4px; color: var(--vscode-foreground); word-break: break-word; white-space: pre-wrap; border: 1px solid var(--vscode-widget-border); max-height: 400px; overflow-y: auto; }
.span-code-block { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); padding: 8px 10px; background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); border-radius: 4px; word-break: break-all; white-space: pre-wrap; border: 1px solid var(--vscode-widget-border); max-height: 300px; overflow-y: auto; }
.span-error-block { font-size: 12px; padding: 8px 10px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 4px; color: var(--vscode-errorForeground); white-space: pre-wrap; word-break: break-word; }
.expand-link { font-size: 11px; color: var(--vscode-textLink-foreground); cursor: pointer; margin-top: 4px; display: inline-block; }
.expand-link:hover { text-decoration: underline; }

/* ── Children ── */
.span-children { margin-left: 16px; margin-top: 8px; border-left: 2px solid var(--vscode-widget-border); padding-left: 10px; }
.span-children.collapsed { display: none; }

/* ── Empty ── */
.empty { text-align: center; padding: 60px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="app">
  <div class="empty"><p>${t.selectTrace}</p></div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const t = ${JSON.stringify(t)};

let state = { trace: null, loading: false };

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
  document.getElementById('app').innerHTML = '<div class="error-banner">⚠ ' + esc(msg) + '</div>';
}

// ── 格式化工具 ──
function fmtDuration(ms) {
  if (!ms) return '-';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  if (ms < 3600000) return (ms / 60000).toFixed(1) + 'm';
  return (ms / 3600000).toFixed(1) + 'h';
}

function fmtTime(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  } catch { return iso; }
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1) + 'k';
}

function statusLabel(s) {
  return { running:'运行中', completed:'已完成', failed:'失败', paused:'已暂停' }[s] || s;
}

function statusBadgeClass(s) {
  return 'badge badge-status-' + (s || 'unknown');
}

function sourceBadgeClass(src) {
  const known = ['opencode','cline','cursor','claude-code','mcp-tool-call'];
  return 'badge ' + (known.includes(src) ? 'badge-source-' + src : 'badge-source');
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = String(text || '');
  return d.innerHTML;
}

function jsonPretty(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  try { return JSON.stringify(val, null, 2); } catch { return String(val); }
}

// ── 主渲染 ──
function render() {
  if (!state.trace) {
    document.getElementById('app').innerHTML = '<div class="empty"><p>' + t.selectTrace + '</p></div>';
    return;
  }
  const trace = state.trace;
  const stats = trace.statistics || {};
  const tokenUsage = trace.tokenUsage || {};
  const timeline = trace.timeline || {};
  const allSpans = trace.spanTree || [];

  document.getElementById('app').innerHTML =
    renderHeader(trace) +
    renderStatsGrid(stats) +
    renderTimelineSection(timeline) +
    renderTokenSection(tokenUsage) +
    renderSpansSection(allSpans);

  setupEventListeners();
}

function renderHeader(trace) {
  return \`
    <div class="trace-header">
      <div class="trace-goal">\${esc(trace.taskGoal || '(无任务目标)')}</div>
      <div class="trace-meta-row">
        <span class="\${statusBadgeClass(trace.status)}">\${statusLabel(trace.status)}</span>
        \${trace.parentTraceId ? '<span class="badge badge-model">子 Trace</span>' : ''}
      </div>
      <div class="trace-time-row">
        <span>📅 创建：\${fmtTime(trace.createdAt)}</span>
        \${trace.updatedAt && trace.updatedAt !== trace.createdAt ? '<span>🔄 更新：' + fmtTime(trace.updatedAt) + '</span>' : ''}
      </div>
      <div class="trace-id-row">ID: \${esc(trace.traceId || trace.id || '')}</div>
    </div>
  \`;
}

function renderStatsGrid(stats) {
  if (!stats.totalSpans && stats.totalSpans !== 0) return '';
  return \`
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">\${stats.totalSpans || 0}</div>
        <div class="stat-label">Span 总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:#4caf50">\${stats.humanSpans || 0}</div>
        <div class="stat-label">用户</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:#1e8cff">\${stats.agentSpans || 0}</div>
        <div class="stat-label">Agent</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:#ff9800">\${stats.systemSpans || 0}</div>
        <div class="stat-label">系统</div>
      </div>
    </div>
  \`;
}

function renderTimelineSection(timeline) {
  if (!timeline.durationMs && !timeline.earliestEvent) return '';
  return \`
    <div class="info-section">
      <h3>时间线</h3>
      <div class="info-grid">
        <div class="info-card"><div class="info-label">总耗时</div><div class="info-value">\${fmtDuration(timeline.durationMs)}</div></div>
        <div class="info-card"><div class="info-label">开始</div><div class="info-value" style="font-size:13px">\${fmtTime(timeline.earliestEvent)}</div></div>
        <div class="info-card"><div class="info-label">结束</div><div class="info-value" style="font-size:13px">\${fmtTime(timeline.latestEvent)}</div></div>
      </div>
    </div>
  \`;
}

function renderTokenSection(tokenUsage) {
  if (!tokenUsage.totalTokens && !tokenUsage.totalInputTokens) return '';
  return \`
    <div class="info-section">
      <h3>Token 统计</h3>
      <div class="info-grid">
        <div class="info-card"><div class="info-label">输入</div><div class="info-value">\${fmtTokens(tokenUsage.totalInputTokens || 0)}</div></div>
        <div class="info-card"><div class="info-label">输出</div><div class="info-value">\${fmtTokens(tokenUsage.totalOutputTokens || 0)}</div></div>
        <div class="info-card"><div class="info-label">合计</div><div class="info-value">\${fmtTokens(tokenUsage.totalTokens || 0)}</div></div>
        \${tokenUsage.totalCacheCreationTokens ? '<div class="info-card"><div class="info-label">缓存创建</div><div class="info-value">' + fmtTokens(tokenUsage.totalCacheCreationTokens) + '</div></div>' : ''}
        \${tokenUsage.totalCacheReadTokens ? '<div class="info-card"><div class="info-label">缓存命中</div><div class="info-value">' + fmtTokens(tokenUsage.totalCacheReadTokens) + '</div></div>' : ''}
      </div>
    </div>
  \`;
}

function renderSpansSection(allSpans) {
  if (!allSpans.length) return '<div class="empty"><p>暂无 Span 记录</p></div>';
  return \`
    <div class="info-section">
      <h3>执行 Span（\${allSpans.length} 个）</h3>
      <div class="span-tree">
        \${allSpans.map(s => renderSpanFlat(s)).join('')}
      </div>
    </div>
  \`;
}

// ── Span 渲染 ──
let spanCounter = 0;

function renderSpan(span, allSpans) {
  const children = allSpans.filter(s => s.parentSpanId === span.id);
  const payload = span.payload || {};
  const actorType = span.actorType || 'system';
  const typeClass = 'span-' + actorType;

  const model = payload.model || payload.modelId || '';
  const source = payload.source || '';
  const toolName = payload.toolName || '';
  const event = payload.event || '';
  const content = payload.content || '';
  const toolInput = payload.toolInput;
  const toolOutput = payload.toolOutput || payload.result;
  const error = payload.error;
  const tokenInfo = payload.tokenUsage;
  const durationMs = payload.durationMs;
  const timeStr = span.createdAt ? fmtTime(span.createdAt) : '';

  const spanId = 'span-' + (spanCounter++);

  // 角色标签文字
  const actorLabel = { human: '👤 用户', agent: '🤖 Agent', system: '⚙ 系统' }[actorType] || actorType;

  // 徽章行
  let badges = '';
  if (model) badges += '<span class="badge badge-model">🧠 ' + esc(model) + '</span>';
  if (source) badges += '<span class="' + sourceBadgeClass(source) + '">📌 ' + esc(source) + '</span>';

  // meta 行
  let metaParts = [];
  metaParts.push('<span class="span-meta-item">' + actorLabel + '</span>');
  if (toolName) metaParts.push('<span class="span-meta-item">🔧 ' + esc(toolName) + '</span>');
  if (event && event !== toolName) metaParts.push('<span class="span-meta-item">📡 ' + esc(event) + '</span>');
  if (timeStr) metaParts.push('<span class="span-meta-item">⏰ ' + esc(timeStr) + '</span>');
  if (durationMs) metaParts.push('<span class="span-meta-item">⏱ ' + fmtDuration(durationMs) + '</span>');

  // Token 行
  let tokenHtml = '';
  if (tokenInfo) {
    const inp = tokenInfo.inputTokens || 0;
    const out = tokenInfo.outputTokens || 0;
    const cache = (tokenInfo.cacheCreationTokens || 0) + (tokenInfo.cacheReadTokens || 0);
    tokenHtml = '<div class="span-token">'
      + '<span class="token-badge">IN ' + fmtTokens(inp) + '</span>'
      + '<span class="token-badge">OUT ' + fmtTokens(out) + '</span>'
      + '<span class="token-badge token-badge-total">TOT ' + fmtTokens(inp + out) + '</span>'
      + (cache ? '<span class="token-badge">CACHE ' + fmtTokens(cache) + '</span>' : '')
      + '</div>';
  }

  // Content 块（全部 actorType 都展示）
  let contentHtml = '';
  if (content) {
    const LIMIT = 500;
    const truncated = content.length > LIMIT;
    const preview = truncated ? content.slice(0, LIMIT) : content;
    const blockId = spanId + '-content';
    const label = actorType === 'human' ? '💬 用户输入' : actorType === 'agent' ? '💡 Agent 回复' : '📋 内容';
    contentHtml = renderCollapsibleBlock(label, blockId, true,
      '<div class="span-content-text">' + esc(preview) + (truncated ? '<span id="' + blockId + '-more" style="color:var(--vscode-descriptionForeground)">…（已截断 ' + (content.length - LIMIT) + ' 字符）</span>' : '') + '</div>'
      + (truncated ? '<span class="expand-link" data-full-id="' + blockId + '" data-full="' + esc(content) + '">展开全文</span>' : '')
    );
  }

  // toolInput 块
  let toolInputHtml = '';
  if (toolInput !== undefined && toolInput !== null && toolInput !== '') {
    const blockId = spanId + '-input';
    toolInputHtml = renderCollapsibleBlock('🔧 Tool Input', blockId, false,
      '<div class="span-code-block">' + esc(jsonPretty(toolInput)) + '</div>'
    );
  }

  // toolOutput 块
  let toolOutputHtml = '';
  if (toolOutput !== undefined && toolOutput !== null && toolOutput !== '') {
    const blockId = spanId + '-output';
    toolOutputHtml = renderCollapsibleBlock('📤 Tool Output', blockId, false,
      '<div class="span-code-block">' + esc(jsonPretty(toolOutput)) + '</div>'
    );
  }

  // error 块
  let errorHtml = '';
  if (error) {
    errorHtml = '<div class="span-block"><div class="span-error-block">❌ ' + esc(jsonPretty(error)) + '</div></div>';
  }

  // 子节点折叠
  const hasChildren = children.length > 0;
  const toggleHtml = hasChildren
    ? '<span class="span-toggle" data-children-id="' + spanId + '-children">▼</span>'
    : '';
  const childrenHtml = hasChildren
    ? '<div class="span-children" id="' + spanId + '-children">'
      + children.map(c => renderSpan(c, allSpans)).join('')
      + '</div>'
    : '';

  return \`
    <div class="span-item \${typeClass}">
      <div class="span-header">
        \${toggleHtml}
        <div class="span-name">\${esc(span.actorName || actorType)}</div>
        <div class="span-id">\${esc(span.id.slice(0, 8))}…</div>
        <div class="span-badges">\${badges}</div>
      </div>
      <div class="span-meta-row">\${metaParts.join('')}</div>
      \${tokenHtml}
      \${errorHtml}
      \${contentHtml}
      \${toolInputHtml}
      \${toolOutputHtml}
      \${childrenHtml}
    </div>
  \`;
}

function renderSpanFlat(span) {
  const payload = span.payload || {};
  const actorType = span.actorType || 'system';
  const typeClass = 'span-' + actorType;

  const model = payload.model || payload.modelId || '';
  const source = payload.source || '';
  const toolName = payload.toolName || '';
  const event = payload.event || '';
  const content = payload.content || '';
  const reasoning = payload.reasoning || '';
  const toolInput = payload.toolInput;
  const toolOutput = payload.toolOutput || payload.result;
  const error = payload.error;
  const tokenInfo = payload.tokenUsage;
  const durationMs = payload.durationMs;
  const timeStr = span.createdAt ? fmtTime(span.createdAt) : '';

  const spanId = 'span-flat-' + (spanCounter++);

  const actorLabel = { human: '👤 用户', agent: '🤖 Agent', system: '⚙ 系统' }[actorType] || actorType;

  let badges = '';
  if (model) badges += '<span class="badge badge-model">🧠 ' + esc(model) + '</span>';
  if (source) badges += '<span class="' + sourceBadgeClass(source) + '">📌 ' + esc(source) + '</span>';

  let metaParts = [];
  metaParts.push('<span class="span-meta-item">' + actorLabel + '</span>');
  if (toolName) metaParts.push('<span class="span-meta-item">🔧 ' + esc(toolName) + '</span>');
  if (event && event !== toolName) metaParts.push('<span class="span-meta-item">📡 ' + esc(event) + '</span>');
  if (timeStr) metaParts.push('<span class="span-meta-item">⏰ ' + esc(timeStr) + '</span>');
  if (durationMs) metaParts.push('<span class="span-meta-item">⏱ ' + fmtDuration(durationMs) + '</span>');

  let tokenHtml = '';
  if (tokenInfo) {
    const inp = tokenInfo.inputTokens || 0;
    const out = tokenInfo.outputTokens || 0;
    const cache = (tokenInfo.cacheCreationTokens || 0) + (tokenInfo.cacheReadTokens || 0);
    tokenHtml = '<div class="span-token">'
      + '<span class="token-badge">IN ' + fmtTokens(inp) + '</span>'
      + '<span class="token-badge">OUT ' + fmtTokens(out) + '</span>'
      + '<span class="token-badge token-badge-total">TOT ' + fmtTokens(inp + out) + '</span>'
      + (cache ? '<span class="token-badge">CACHE ' + fmtTokens(cache) + '</span>' : '')
      + '</div>';
  }

  let contentHtml = '';
  if (content) {
    const LIMIT = 500;
    const truncated = content.length > LIMIT;
    const preview = truncated ? content.slice(0, LIMIT) : content;
    const blockId = spanId + '-content';
    const label = actorType === 'human' ? '💬 用户输入' : actorType === 'agent' ? '💡 Agent 回复' : '📋 内容';
    contentHtml = renderCollapsibleBlock(label, blockId, true,
      '<div class="span-content-text">' + esc(preview) + (truncated ? '<span id="' + blockId + '-more" style="color:var(--vscode-descriptionForeground)">…（已截断 ' + (content.length - LIMIT) + ' 字符）</span>' : '') + '</div>'
      + (truncated ? '<span class="expand-link" data-full-id="' + blockId + '" data-full="' + esc(content) + '">展开全文</span>' : '')
    );
  }

  let reasoningHtml = '';
  if (reasoning) {
    const LIMIT = 500;
    const truncated = reasoning.length > LIMIT;
    const preview = truncated ? reasoning.slice(0, LIMIT) : reasoning;
    const blockId = spanId + '-reasoning';
    reasoningHtml = renderCollapsibleBlock('🧠 推理过程', blockId, false,
      '<div class="span-content-text">' + esc(preview) + (truncated ? '<span id="' + blockId + '-more" style="color:var(--vscode-descriptionForeground)">…（已截断 ' + (reasoning.length - LIMIT) + ' 字符）</span>' : '') + '</div>'
      + (truncated ? '<span class="expand-link" data-full-id="' + blockId + '" data-full="' + esc(reasoning) + '">展开全文</span>' : '')
    );
  }

  let toolInputHtml = '';
  if (toolInput !== undefined && toolInput !== null && toolInput !== '') {
    const blockId = spanId + '-input';
    toolInputHtml = renderCollapsibleBlock('🔧 Tool Input', blockId, false,
      '<div class="span-code-block">' + esc(jsonPretty(toolInput)) + '</div>'
    );
  }

  let toolOutputHtml = '';
  if (toolOutput !== undefined && toolOutput !== null && toolOutput !== '') {
    const blockId = spanId + '-output';
    toolOutputHtml = renderCollapsibleBlock('📤 Tool Output', blockId, false,
      '<div class="span-code-block">' + esc(jsonPretty(toolOutput)) + '</div>'
    );
  }

  let errorHtml = '';
  if (error) {
    errorHtml = '<div class="span-block"><div class="span-error-block">❌ ' + esc(jsonPretty(error)) + '</div></div>';
  }

  return \`
    <div class="span-item \${typeClass}">
      <div class="span-header">
        <div class="span-name">\${esc(span.actorName || actorType)}</div>
        <div class="span-id">\${esc(span.id.slice(0, 8))}…</div>
        <div class="span-badges">\${badges}</div>
      </div>
      <div class="span-meta-row">\${metaParts.join('')}</div>
      \${tokenHtml}
      \${errorHtml}
      \${contentHtml}
      \${reasoningHtml}
      \${toolInputHtml}
      \${toolOutputHtml}
    </div>
  \`;
}

function renderCollapsibleBlock(label, id, defaultOpen, bodyHtml) {
  const openClass = defaultOpen ? '' : ' collapsed';
  return \`
    <div class="span-block">
      <div class="span-block-header" data-block-id="\${id}-body">
        <span class="span-block-toggle">\${defaultOpen ? '▼' : '▶'}</span>
        <span>\${label}</span>
      </div>
      <div class="span-block-body\${openClass}" id="\${id}-body">
        \${bodyHtml}
      </div>
    </div>
  \`;
}

// ── 事件绑定（委托，避免重复绑定）──
let _eventsSetup = false;
function setupEventListeners() {
  if (_eventsSetup) return;
  _eventsSetup = true;

  document.addEventListener('click', (e) => {
    // 子 span 折叠
    const toggle = e.target.closest('.span-toggle');
    if (toggle) {
      const childrenId = toggle.dataset.childrenId;
      if (childrenId) {
        const el = document.getElementById(childrenId);
        if (el) {
          el.classList.toggle('collapsed');
          toggle.textContent = el.classList.contains('collapsed') ? '▶' : '▼';
        }
      }
    }

    // 内容块折叠
    const blockHeader = e.target.closest('.span-block-header');
    if (blockHeader) {
      const bodyId = blockHeader.dataset.blockId;
      if (bodyId) {
        const body = document.getElementById(bodyId);
        if (body) {
          body.classList.toggle('collapsed');
          const togBtn = blockHeader.querySelector('.span-block-toggle');
          if (togBtn) togBtn.textContent = body.classList.contains('collapsed') ? '▶' : '▼';
        }
      }
    }

    // 展开全文
    const expandLink = e.target.closest('.expand-link');
    if (expandLink) {
      const fullId = expandLink.dataset.fullId;
      const fullText = expandLink.dataset.full;
      if (fullId && fullText) {
        const contentEl = document.getElementById(fullId + '-body');
        if (contentEl) {
          const textBox = contentEl.querySelector('.span-content-text');
          if (textBox) textBox.innerHTML = '<div class="span-content-text">' + esc(fullText) + '</div>';
        }
        expandLink.remove();
      }
    }
  });
}

vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
