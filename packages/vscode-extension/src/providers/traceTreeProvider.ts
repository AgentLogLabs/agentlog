/**
 * @agentlog/vscode-extension — TraceTreeProvider
 *
 * 提供 Trace 列表的 TreeView 数据。
 * 显示所有 traces，支持按状态筛选。
 */

import * as vscode from "vscode";
import { getBackendClient } from "../client/backendClient";

export class TraceTreeProvider implements vscode.TreeDataProvider<TraceItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<TraceItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private traces: TraceSummary[] = [];

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(): Promise<TraceItem[]> {
    await this.loadTraces();
    return this.traces.map((t) => new TraceItem(t));
  }

  private async loadTraces(): Promise<void> {
    try {
      const client = getBackendClient();
      const response = await client.getTraces({ pageSize: 50 });
      if (response && typeof response === "object" && "data" in response) {
        const resp = response as { data: TraceSummary[] };
        this.traces = resp.data ?? [];
      }
    } catch (err) {
      console.error("[TraceTreeProvider] 加载失败:", err);
    }
  }

  getTreeItem(element: TraceItem): vscode.TreeItem {
    return element;
  }
}

export interface TraceSummary {
  id: string;
  taskGoal: string;
  status: "running" | "paused" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export class TraceItem extends vscode.TreeItem {
  constructor(public readonly trace: TraceSummary) {
    super(
      trace.taskGoal || `Trace ${trace.id.slice(0, 8)}`,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    this.description = trace.status;
    this.tooltip = `${trace.id}\n状态: ${trace.status}\n创建: ${trace.createdAt}`;

    switch (trace.status) {
      case "running":
        this.iconPath = new vscode.ThemeIcon("debug-pause");
        this.contextValue = "trace-running";
        break;
      case "failed":
        this.iconPath = new vscode.ThemeIcon("error");
        this.contextValue = "trace-failed";
        break;
      case "completed":
        this.iconPath = new vscode.ThemeIcon("check");
        this.contextValue = "trace-completed";
        break;
      default:
        this.iconPath = new vscode.ThemeIcon("circle-outline");
        this.contextValue = "trace";
    }
  }

  id = this.trace.id;
}
