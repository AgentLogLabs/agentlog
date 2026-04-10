/**
 * @agentlog/vscode-extension — TraceTreeProvider
 *
 * 提供 Trace 列表的 TreeView 数据。
 * 树形结构：
 *  ├── 📅 今天（N 条记录）
 *  │   ├── ● 实现用户登录功能
 *  │   └── ✓ 修复购物车结算bug
 *  ├── 📅 昨天
 *  │   └── ...
 *  └── 📅 更早
 */

import * as vscode from "vscode";
import { getBackendClient, BackendUnreachableError } from "../client/backendClient";
import { SseClient } from "../client/sseClient";

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

export interface TraceSummary {
  id: string;
  taskGoal: string;
  status: "running" | "pending_handoff" | "in_progress" | "paused" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  hasCommit: boolean;
  commitHash?: string;
}

type TreeNode = TraceDateGroupItem | TraceItem | TraceStatusItem;

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

function resolveWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

function resolveActiveEditorWorkspacePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  return folder?.uri.fsPath;
}

function formatDateGroup(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const itemDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - itemDay.getTime()) / 86_400_000);

  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays <= 6) {
    const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return dayNames[date.getDay()];
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function formatDateTimeFull(isoDate: string): string {
  const d = new Date(isoDate);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function groupByDate(traces: TraceSummary[]): Map<string, TraceSummary[]> {
  const groups = new Map<string, TraceSummary[]>();
  for (const trace of traces) {
    const label = formatDateGroup(trace.createdAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(trace);
  }
  return groups;
}

function statusLabel(status: string): string {
  switch (status) {
    case "running": return "进行中";
    case "pending_handoff": return "等待接力";
    case "in_progress": return "继续修改";
    case "paused": return "已暂停";
    case "completed": return "已完成";
    case "failed": return "失败";
    default: return status;
  }
}

// ─────────────────────────────────────────────
// 树节点定义
// ─────────────────────────────────────────────

export class TraceDateGroupItem extends vscode.TreeItem {
  readonly type = "date-group" as const;

  constructor(
    public readonly label: string,
    public readonly traces: TraceSummary[],
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${traces.length} 条记录`;
    this.iconPath = new vscode.ThemeIcon("calendar");
    this.contextValue = "trace-date-group";
  }
}

export class TraceItem extends vscode.TreeItem {
  readonly type = "trace" as const;

  constructor(public readonly trace: TraceSummary) {
    super(
      trace.taskGoal || `Trace ${trace.id.slice(0, 8)}`,
      vscode.TreeItemCollapsibleState.None,
    );

    const commitTag = trace.hasCommit ? '🔗 已绑定' : '○ 未绑定';
    this.description = `${commitTag} · ${statusLabel(trace.status)} · ${relativeTime(trace.createdAt)}`;

    // Tooltip（MarkdownString）
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = true;
    tooltip.appendMarkdown(`**${trace.taskGoal || "(无任务目标)"}**\n\n`);
    tooltip.appendMarkdown(`- **ID**: \`${trace.id}\`\n`);
    tooltip.appendMarkdown(`- **状态**: ${statusLabel(trace.status)}\n`);
    tooltip.appendMarkdown(`- **创建**: ${formatDateTimeFull(trace.createdAt)}\n`);
    tooltip.appendMarkdown(`- **更新**: ${formatDateTimeFull(trace.updatedAt)}\n`);
    this.tooltip = tooltip;

    // 点击时打开详情
    this.command = {
      command: "agentlog.viewTraceDetail",
      title: "查看 Trace 详情",
      arguments: [trace.id],
    };

    switch (trace.status) {
      case "running":
        this.iconPath = new vscode.ThemeIcon(
          "debug-continue",
          new vscode.ThemeColor("charts.blue"),
        );
        this.contextValue = "trace-running";
        break;
      case "pending_handoff":
        this.iconPath = new vscode.ThemeIcon(
          "debug-pause",
          new vscode.ThemeColor("charts.orange"),
        );
        this.contextValue = "trace-pending-handoff";
        break;
      case "in_progress":
        this.iconPath = new vscode.ThemeIcon(
          "sync",
          new vscode.ThemeColor("charts.blue"),
        );
        this.contextValue = "trace-in-progress";
        break;
      case "failed":
        this.iconPath = new vscode.ThemeIcon(
          "error",
          new vscode.ThemeColor("list.errorForeground"),
        );
        this.contextValue = "trace-failed";
        break;
      case "completed":
        this.iconPath = new vscode.ThemeIcon(
          "pass",
          new vscode.ThemeColor("charts.green"),
        );
        this.contextValue = "trace-completed";
        break;
      case "paused":
        this.iconPath = new vscode.ThemeIcon(
          "debug-pause",
          new vscode.ThemeColor("charts.yellow"),
        );
        this.contextValue = "trace-paused";
        break;
      default:
        this.iconPath = new vscode.ThemeIcon("circle-outline");
        this.contextValue = "trace";
    }
  }

  // TreeItem.id 必须唯一
  id = `trace-item-${this.trace.id}`;
}

/** 特殊状态节点：加载中 / 空状态 / 错误 */
export class TraceStatusItem extends vscode.TreeItem {
  readonly type = "status" as const;

  static loading(): TraceStatusItem {
    const item = new TraceStatusItem("正在加载…", vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("loading~spin");
    item.contextValue = "trace-loading";
    return item;
  }

  static empty(): TraceStatusItem {
    const item = new TraceStatusItem("暂无 Trace 记录", vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(
      "info",
      new vscode.ThemeColor("descriptionForeground"),
    );
    item.contextValue = "trace-empty";
    return item;
  }

  static error(message: string): TraceStatusItem {
    const item = new TraceStatusItem(message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(
      "error",
      new vscode.ThemeColor("list.errorForeground"),
    );
    item.contextValue = "trace-error";
    return item;
  }
}

// ─────────────────────────────────────────────
// TraceTreeProvider
// ─────────────────────────────────────────────

export class TraceTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _traces: TraceSummary[] = [];
  private _loading = false;
  private _error: string | null = null;
  private _loaded = false;
  private _workspacePath: string | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _sseClient: SseClient | null = null;

  constructor() {
    const wsWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this._workspacePath = resolveWorkspacePath();
      this.refresh();
    });
    this._disposables.push(wsWatcher);

    const editorWatcher = vscode.window.onDidChangeActiveTextEditor(() => {
      const newPath = resolveActiveEditorWorkspacePath();
      if (newPath && newPath !== this._workspacePath) {
        this._workspacePath = newPath;
        this.refresh();
      }
    });
    this._disposables.push(editorWatcher);

    this._workspacePath = resolveWorkspacePath();

    this.connectSSE();
  }

  // ─── SSE 实时推送 ───────────────────────────

  private connectSSE(): void {
    this.disconnectSSE();

    const client = getBackendClient();
    if (!client) {
      console.log(`[AgentLog][TraceTree] BackendClient 不可用，跳过 SSE 连接`);
      return;
    }

    this._sseClient = new SseClient(client.getBaseUrl());

    this._sseClient.on("connected", () => {
      console.log(`[AgentLog][TraceTree] SSE 已连接，刷新`);
      this.refresh();
    });

    this._sseClient.on("trace_created", () => {
      console.log(`[AgentLog][TraceTree] 收到 trace_created 事件，刷新`);
      this.refresh();
    });

    this._sseClient.on("span_created", () => {
      console.log(`[AgentLog][TraceTree] 收到 span_created 事件，刷新`);
      this.refresh();
    });

    this._sseClient.connect();
  }

  private disconnectSSE(): void {
    if (this._sseClient) {
      this._sseClient.dispose();
      this._sseClient = null;
    }
  }

  dispose(): void {
    this.disconnectSSE();
    this._onDidChangeTreeData.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
  }

  refresh(): void {
    this._loaded = false;
    this._traces = [];
    this._error = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element instanceof TraceDateGroupItem) {
      return element.traces.map((t) => new TraceItem(t));
    }

    if (!this._loaded) {
      await this._loadTraces();
    }

    if (this._loading) {
      return [TraceStatusItem.loading()];
    }

    if (this._error) {
      return [TraceStatusItem.error(this._error)];
    }

    if (this._traces.length === 0) {
      return [TraceStatusItem.empty()];
    }

    const groups = groupByDate(this._traces);
    return Array.from(groups.entries()).map(
      ([label, traces]) => new TraceDateGroupItem(label, traces),
    );
  }

  private async _loadTraces(): Promise<void> {
    if (this._loading) return;
    this._loading = true;
    this._error = null;
    this._onDidChangeTreeData.fire(undefined);

    try {
      const client = getBackendClient();
      console.log(`[AgentLog][TraceTree] 正在加载 traces，backendUrl: ${(client as any).baseUrl}, workspacePath: ${this._workspacePath}`);
      const response = await client.getTraces({ pageSize: 200 });
      console.log(`[AgentLog][TraceTree] getTraces 响应:`, JSON.stringify(response).slice(0, 500));
      if (response && typeof response === "object" && "data" in response) {
        const resp = response as { data: TraceSummary[] };
        this._traces = resp.data ?? [];
        console.log(`[AgentLog][TraceTree] 加载到 ${this._traces.length} 条 traces`);
      }
      this._loaded = true;
    } catch (err) {
      console.log(`[AgentLog][TraceTree] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof BackendUnreachableError) {
        this._error = "后台服务未启动";
      } else {
        this._error = `加载失败：${err instanceof Error ? err.message : String(err)}`;
      }
    } finally {
      this._loading = false;
      this._onDidChangeTreeData.fire(undefined);
    }
  }
}
