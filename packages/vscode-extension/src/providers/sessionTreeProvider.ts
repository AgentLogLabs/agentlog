/**
 * @agentlog/vscode-extension — SessionTreeProvider
 *
 * VS Code TreeView 提供者，在侧边栏「AI 交互记录」面板中展示 AgentSession 列表。
 *
 * 树形结构：
 *  ├── 📅 今天
 *  │   ├── 🤖 [deepseek/deepseek-r1] 重构登录逻辑... (已绑定 abc1234)
 *  │   └── 🤖 [qwen/qwen-max] 优化数据库查询...
 *  ├── 📅 昨天
 *  │   └── 🤖 [kimi/moonshot-v1-8k] 添加单元测试...
 *  └── 📅 更早
 *      └── ...
 *
 * 支持：
 *  - 按日期分组
 *  - 标注绑定状态（已绑定 Commit / 未绑定）
 *  - 右键菜单（查看详情、绑定 Commit、删除）
 *  - 刷新（手动 + 定时自动刷新）
 *  - 工作区切换时重新加载
 */

import * as vscode from "vscode";
import type { AgentSession, ModelProvider } from "@agentlog/shared";
import {
  getBackendClient,
  BackendUnreachableError,
} from "../client/backendClient";

// ─────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────

/** 每次加载的最大会话条数 */
const PAGE_SIZE = 50;

/** 自动刷新间隔（毫秒）*/
const AUTO_REFRESH_INTERVAL_MS = 30_000;

/** 模型提供商对应的 Emoji 图标 */
const PROVIDER_EMOJI: Record<ModelProvider | "unknown", string> = {
  deepseek: "🐋",
  qwen: "🌊",
  kimi: "🌙",
  doubao: "🫘",
  zhipu: "🧠",
  openai: "🤖",
  anthropic: "🅰️",
  ollama: "🦙",
  unknown: "❓",
};

// ─────────────────────────────────────────────
// 树节点类型
// ─────────────────────────────────────────────

/**
 * 树节点类型标识，用于 VS Code when 子句条件（viewItem）
 */
export type TreeItemType =
  | "date-group" // 日期分组节点（今天 / 昨天 / YYYY-MM-DD）
  | "session" // 单条 AI 会话节点
  | "load-more" // "加载更多"节点
  | "empty" // 空状态节点
  | "error" // 错误状态节点
  | "loading"; // 加载中节点

// ─────────────────────────────────────────────
// TreeItem 节点定义
// ─────────────────────────────────────────────

/**
 * 基类：AgentLog 树节点
 */
export abstract class AgentLogTreeItem extends vscode.TreeItem {
  abstract readonly type: TreeItemType;
}

// ── 日期分组节点 ──────────────────────────────

export class DateGroupItem extends AgentLogTreeItem {
  readonly type = "date-group" as const;

  constructor(
    public readonly dateLabel: string,
    public readonly sessions: AgentSession[],
  ) {
    super(dateLabel, vscode.TreeItemCollapsibleState.Expanded);

    this.contextValue = "date-group";
    this.description = `${sessions.length} 条记录`;
    this.iconPath = new vscode.ThemeIcon("calendar");
    this.tooltip = `${dateLabel}：共 ${sessions.length} 条 AI 交互记录`;
  }
}

// ── 单条 Session 节点 ─────────────────────────

export class SessionItem extends AgentLogTreeItem {
  readonly type = "session" as const;

  constructor(public readonly session: AgentSession) {
    super(
      SessionItem.buildLabel(session),
      vscode.TreeItemCollapsibleState.None,
    );

    this.contextValue = session.commitHash ? "session-bound" : "session";
    this.description = SessionItem.buildDescription(session);
    this.tooltip = SessionItem.buildTooltip(session);
    this.iconPath = SessionItem.buildIcon(session);

    // 点击时触发"查看详情"命令
    this.command = {
      command: "agentlog.viewSessionDetail",
      title: "查看会话详情",
      arguments: [session],
    };
  }

  // ── 静态工厂方法 ──

  private static buildLabel(session: AgentSession): string {
    const emoji = PROVIDER_EMOJI[session.provider] ?? "🤖";
    const promptPreview = session.prompt
      .replace(/\n/g, " ")
      .slice(0, 40)
      .trim();
    const ellipsis = session.prompt.length > 40 ? "…" : "";
    return `${emoji} ${promptPreview}${ellipsis}`;
  }

  private static buildDescription(session: AgentSession): string {
    const parts: string[] = [];

    // 模型名称
    parts.push(session.model);

    // 耗时
    if (session.durationMs > 0) {
      parts.push(formatDuration(session.durationMs));
    }

    // 绑定状态
    if (session.commitHash) {
      parts.push(`✓ ${session.commitHash.slice(0, 7)}`);
    }

    return parts.join(" · ");
  }

  private static buildTooltip(session: AgentSession): vscode.MarkdownString {
    const md = new vscode.MarkdownString("", true);
    md.isTrusted = true;
    md.supportHtml = false;

    // 标题
    md.appendMarkdown(
      `**${PROVIDER_EMOJI[session.provider] ?? "🤖"} ${session.model}**\n\n`,
    );

    // 基本信息
    md.appendMarkdown(`- **时间**：${formatDateTime(session.createdAt)}\n`);
    md.appendMarkdown(`- **来源**：${session.source}\n`);
    md.appendMarkdown(`- **耗时**：${formatDuration(session.durationMs)}\n`);

    if (session.commitHash) {
      md.appendMarkdown(
        `- **Commit**：\`${session.commitHash.slice(0, 8)}\`\n`,
      );
    } else {
      md.appendMarkdown(`- **Commit**：未绑定\n`);
    }

    if (session.affectedFiles.length > 0) {
      md.appendMarkdown(
        `- **文件**：${session.affectedFiles
          .slice(0, 5)
          .map((f) => `\`${f}\``)
          .join(
            ", ",
          )}${session.affectedFiles.length > 5 ? ` 等 ${session.affectedFiles.length} 个` : ""}\n`,
      );
    }

    if (session.tags && session.tags.length > 0) {
      md.appendMarkdown(
        `- **标签**：${session.tags.map((t) => `\`${t}\``).join(" ")}\n`,
      );
    }

    // Prompt 预览
    md.appendMarkdown(`\n---\n\n`);
    md.appendMarkdown(`**Prompt 预览**：\n\n`);
    md.appendMarkdown(
      `> ${session.prompt.slice(0, 200).replace(/\n/g, "\n> ")}${session.prompt.length > 200 ? "…" : ""}\n`,
    );

    // 推理标识
    if (session.reasoning) {
      md.appendMarkdown(
        `\n_💡 包含 AI 推理过程（${session.reasoning.length} 字符）_\n`,
      );
    }

    if (session.note) {
      md.appendMarkdown(`\n**备注**：${session.note}\n`);
    }

    return md;
  }

  private static buildIcon(session: AgentSession): vscode.ThemeIcon {
    if (session.commitHash) {
      // 已绑定 Commit：绿色 git-commit 图标
      return new vscode.ThemeIcon(
        "git-commit",
        new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
      );
    }
    if (session.reasoning) {
      // 包含推理过程：特殊标记
      return new vscode.ThemeIcon(
        "lightbulb",
        new vscode.ThemeColor("list.warningForeground"),
      );
    }
    return new vscode.ThemeIcon("comment-discussion");
  }
}

// ── 加载更多节点 ──────────────────────────────

export class LoadMoreItem extends AgentLogTreeItem {
  readonly type = "load-more" as const;

  constructor(public readonly currentPage: number) {
    super("加载更多…", vscode.TreeItemCollapsibleState.None);
    this.contextValue = "load-more";
    this.iconPath = new vscode.ThemeIcon("chevron-down");
    this.command = {
      command: "agentlog.loadMoreSessions",
      title: "加载更多会话",
      arguments: [currentPage + 1],
    };
    this.tooltip = "点击加载下一页会话记录";
  }
}

// ── 空状态节点 ────────────────────────────────

export class EmptyStateItem extends AgentLogTreeItem {
  readonly type = "empty" as const;

  constructor(message = "暂无 AI 交互记录") {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "empty";
    this.iconPath = new vscode.ThemeIcon(
      "info",
      new vscode.ThemeColor("descriptionForeground"),
    );
  }
}

// ── 错误节点 ──────────────────────────────────

export class ErrorStateItem extends AgentLogTreeItem {
  readonly type = "error" as const;

  constructor(
    message: string,
    public readonly isUnreachable = false,
  ) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = isUnreachable ? "error-unreachable" : "error";
    this.iconPath = new vscode.ThemeIcon(
      "error",
      new vscode.ThemeColor("list.errorForeground"),
    );
    this.tooltip = isUnreachable
      ? "后台服务未启动，请运行「AgentLog: 启动本地后台服务」"
      : message;

    if (isUnreachable) {
      this.command = {
        command: "agentlog.startBackend",
        title: "启动后台服务",
        arguments: [],
      };
    }
  }
}

// ── 加载中节点 ────────────────────────────────

export class LoadingStateItem extends AgentLogTreeItem {
  readonly type = "loading" as const;

  constructor() {
    super("正在加载…", vscode.TreeItemCollapsibleState.None);
    this.contextValue = "loading";
    this.iconPath = new vscode.ThemeIcon("loading~spin");
  }
}

// ─────────────────────────────────────────────
// SessionTreeProvider 主类
// ─────────────────────────────────────────────

/**
 * AgentSession 的 TreeDataProvider 实现。
 *
 * 数据流：
 *  1. 插件激活时调用 refresh() 拉取首页数据
 *  2. 定时每 30 秒自动刷新
 *  3. 外部（extension.ts）在捕获到新会话后调用 refresh()
 *  4. 用户点击"加载更多"时，追加下一页数据
 */
export class SessionTreeProvider
  implements vscode.TreeDataProvider<AgentLogTreeItem>, vscode.Disposable
{
  // ─── 事件 ──────────────────────────────────

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    AgentLogTreeItem | undefined | null | void
  >();

  readonly onDidChangeTreeData: vscode.Event<
    AgentLogTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  // ─── 状态 ──────────────────────────────────

  /** 当前加载的所有会话（跨页累积） */
  private _sessions: AgentSession[] = [];

  /** 当前页码（1 起）*/
  private _currentPage = 1;

  /** 服务端总记录数 */
  private _totalCount = 0;

  /** 是否正在加载 */
  private _loading = false;

  /** 最近一次加载的错误信息 */
  private _error: { message: string; isUnreachable: boolean } | null = null;

  /** 当前工作区路径过滤 */
  private _workspacePath: string | undefined;

  /** 定时刷新 timer */
  private _refreshTimer: ReturnType<typeof setInterval> | null = null;

  /** 注册的 Disposable 列表 */
  private _disposables: vscode.Disposable[] = [];

  /** 过滤关键词 */
  private _filterKeyword: string | undefined;

  /** 是否只显示未绑定会话 */
  private _filterUnboundOnly = false;

  constructor() {
    // 监听配置变更（backendUrl 等），触发刷新
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentlog")) {
        this.refresh();
      }
    });
    this._disposables.push(configWatcher);

    // 监听工作区文件夹变更
    const wsWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this._workspacePath = resolveWorkspacePath();
      this.refresh();
    });
    this._disposables.push(wsWatcher);

    // 监听活动编辑器切换，更新工作区路径
    const editorWatcher = vscode.window.onDidChangeActiveTextEditor(() => {
      const newPath = resolveActiveEditorWorkspacePath();
      if (newPath && newPath !== this._workspacePath) {
        this._workspacePath = newPath;
        this.refresh();
      }
    });
    this._disposables.push(editorWatcher);

    // 初始化工作区路径
    this._workspacePath = resolveWorkspacePath();
  }

  // ─── 公开 API ──────────────────────────────

  /**
   * 刷新整个列表（重置到第 1 页）。
   * 外部在"捕获到新会话"或"手动刷新"时调用。
   */
  refresh(): void {
    this._currentPage = 1;
    this._sessions = [];
    this._error = null;
    this._onDidChangeTreeData.fire();
  }

  /**
   * 加载指定页的数据（追加到现有列表）。
   * 由"加载更多"节点的 command 调用。
   */
  async loadPage(page: number): Promise<void> {
    if (this._loading) return;
    this._currentPage = page;
    // 触发重新渲染（getChildren 中会按新页码拉取）
    this._onDidChangeTreeData.fire();
  }

  /**
   * 设置关键词过滤。
   */
  setFilter(keyword: string | undefined): void {
    this._filterKeyword = keyword || undefined;
    this.refresh();
  }

  /**
   * 切换"只显示未绑定"过滤器。
   */
  toggleUnboundFilter(): void {
    this._filterUnboundOnly = !this._filterUnboundOnly;
    this.refresh();
  }

  get filterUnboundOnly(): boolean {
    return this._filterUnboundOnly;
  }

  /**
   * 当前展示的会话总数。
   */
  get sessionCount(): number {
    return this._sessions.length;
  }

  /**
   * 服务端总记录数（用于状态栏展示）。
   */
  get totalCount(): number {
    return this._totalCount;
  }

  /**
   * 启动定时自动刷新。
   */
  startAutoRefresh(): void {
    this.stopAutoRefresh();
    this._refreshTimer = setInterval(() => {
      this.refresh();
    }, AUTO_REFRESH_INTERVAL_MS);
  }

  /**
   * 停止定时自动刷新。
   */
  stopAutoRefresh(): void {
    if (this._refreshTimer !== null) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  // ─── TreeDataProvider 接口实现 ──────────────

  getTreeItem(element: AgentLogTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AgentLogTreeItem): Promise<AgentLogTreeItem[]> {
    // ── 子节点：日期分组 → 会话列表 ──
    if (element instanceof DateGroupItem) {
      return element.sessions.map((s) => new SessionItem(s));
    }

    // ── 根节点 ──
    if (this._loading) {
      return [new LoadingStateItem()];
    }

    // 首次加载（_sessions 为空且无错误）
    if (this._sessions.length === 0 && !this._error) {
      await this._fetchSessions();
    }

    // 加载出错
    if (this._error) {
      return [
        new ErrorStateItem(this._error.message, this._error.isUnreachable),
      ];
    }

    // 空状态
    if (this._sessions.length === 0) {
      return [
        new EmptyStateItem(
          this._filterKeyword
            ? `没有找到匹配「${this._filterKeyword}」的记录`
            : this._filterUnboundOnly
              ? "没有未绑定 Commit 的 AI 交互记录"
              : "尚无 AI 交互记录",
        ),
      ];
    }

    // 按日期分组
    const groups = groupByDate(this._sessions);
    const items: AgentLogTreeItem[] = [];

    for (const [dateLabel, sessions] of groups) {
      items.push(new DateGroupItem(dateLabel, sessions));
    }

    // 若还有更多数据，追加"加载更多"节点
    if (this._sessions.length < this._totalCount) {
      items.push(new LoadMoreItem(this._currentPage));
    }

    return items;
  }

  // ─── 数据获取 ──────────────────────────────

  /**
   * 从后台拉取会话数据。
   * - 首页（page=1）：替换 _sessions
   * - 后续页：追加到 _sessions
   */
  private async _fetchSessions(): Promise<void> {
    if (this._loading) return;

    this._loading = true;
    this._error = null;

    try {
      const client = getBackendClient();

      const result = await client.querySessions({
        page: this._currentPage,
        pageSize: PAGE_SIZE,
        workspacePath: this._workspacePath,
        keyword: this._filterKeyword,
        onlyBoundToCommit: this._filterUnboundOnly ? false : undefined,
      });

      if (this._currentPage === 1) {
        this._sessions = result.data;
      } else {
        this._sessions = [...this._sessions, ...result.data];
      }

      this._totalCount = result.total;
    } catch (err) {
      const isUnreachable = err instanceof BackendUnreachableError;
      this._error = {
        message: isUnreachable
          ? "后台服务未启动，点击此处启动"
          : `加载失败：${err instanceof Error ? err.message : String(err)}`,
        isUnreachable,
      };
      this._sessions = [];
      this._totalCount = 0;
    } finally {
      this._loading = false;
    }
  }

  // ─── Disposable ────────────────────────────

  dispose(): void {
    this.stopAutoRefresh();
    this._onDidChangeTreeData.dispose();
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }
}

// ─────────────────────────────────────────────
// CommitBindingsTreeProvider — Commit 绑定视图
// ─────────────────────────────────────────────

/**
 * Commit 绑定视图的树节点类型
 */
export type CommitTreeItemType =
  | "commit"
  | "commit-session"
  | "empty"
  | "error"
  | "loading";

export abstract class CommitTreeItem extends vscode.TreeItem {
  abstract readonly type: CommitTreeItemType;
}

export class CommitGroupItem extends CommitTreeItem {
  readonly type = "commit" as const;

  constructor(
    public readonly commitHash: string,
    public readonly message: string,
    public readonly sessionCount: number,
    public readonly committedAt: string,
    public readonly sessions: AgentSession[],
  ) {
    super(
      `${commitHash.slice(0, 8)} — ${message.slice(0, 50)}${message.length > 50 ? "…" : ""}`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = "commit";
    this.description = `${sessionCount} 条会话 · ${formatDateTime(committedAt)}`;
    this.iconPath = new vscode.ThemeIcon(
      "git-commit",
      new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
    );
    this.tooltip = new vscode.MarkdownString(
      `**Commit** \`${commitHash.slice(0, 8)}\`\n\n${message}\n\n_${formatDateTime(committedAt)}_`,
    );
  }
}

export class CommitSessionItem extends CommitTreeItem {
  readonly type = "commit-session" as const;

  constructor(public readonly session: AgentSession) {
    const emoji = PROVIDER_EMOJI[session.provider] ?? "🤖";
    const promptPreview = session.prompt.replace(/\n/g, " ").slice(0, 45);
    super(
      `${emoji} ${promptPreview}${session.prompt.length > 45 ? "…" : ""}`,
      vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "commit-session";
    this.description = session.model;
    this.iconPath = new vscode.ThemeIcon("comment-discussion");
    this.command = {
      command: "agentlog.viewSessionDetail",
      title: "查看会话详情",
      arguments: [session],
    };
  }
}

/**
 * Commit 绑定视图的 TreeDataProvider。
 * 以 Commit 为分组，展示每个 Commit 下关联的 AI 会话。
 */
export class CommitBindingsTreeProvider
  implements vscode.TreeDataProvider<CommitTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    CommitTreeItem | undefined | null | void
  >();

  readonly onDidChangeTreeData: vscode.Event<
    CommitTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private _commitGroups: Array<{
    hash: string;
    message: string;
    committedAt: string;
    sessions: AgentSession[];
  }> = [];

  private _loading = false;
  private _error: string | null = null;
  private _workspacePath: string | undefined;
  private _disposables: vscode.Disposable[] = [];

  constructor() {
    this._workspacePath = resolveWorkspacePath();

    const wsWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this._workspacePath = resolveWorkspacePath();
      this.refresh();
    });
    this._disposables.push(wsWatcher);
  }

  refresh(): void {
    this._commitGroups = [];
    this._error = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CommitTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CommitTreeItem): Promise<CommitTreeItem[]> {
    if (element instanceof CommitGroupItem) {
      return element.sessions.map((s) => new CommitSessionItem(s));
    }

    if (this._loading) {
      return [
        new (class extends CommitTreeItem {
          readonly type = "loading" as const;
          constructor() {
            super("正在加载…", vscode.TreeItemCollapsibleState.None);
            this.iconPath = new vscode.ThemeIcon("loading~spin");
          }
        })(),
      ];
    }

    if (this._commitGroups.length === 0 && !this._error) {
      await this._fetchCommits();
    }

    if (this._error) {
      return [
        new (class extends CommitTreeItem {
          readonly type = "error" as const;
          constructor(msg: string) {
            super(msg, vscode.TreeItemCollapsibleState.None);
            this.iconPath = new vscode.ThemeIcon(
              "error",
              new vscode.ThemeColor("list.errorForeground"),
            );
          }
        })(this._error),
      ];
    }

    if (this._commitGroups.length === 0) {
      return [
        new (class extends CommitTreeItem {
          readonly type = "empty" as const;
          constructor() {
            super("尚无 Commit 绑定记录", vscode.TreeItemCollapsibleState.None);
            this.iconPath = new vscode.ThemeIcon(
              "info",
              new vscode.ThemeColor("descriptionForeground"),
            );
          }
        })(),
      ];
    }

    return this._commitGroups.map(
      (g) =>
        new CommitGroupItem(
          g.hash,
          g.message,
          g.sessions.length,
          g.committedAt,
          g.sessions,
        ),
    );
  }

  private async _fetchCommits(): Promise<void> {
    if (this._loading) return;
    this._loading = true;
    this._error = null;

    try {
      const client = getBackendClient();
      const result = await client.listCommitBindings(
        1,
        30,
        this._workspacePath,
      );

      const groups: typeof this._commitGroups = [];

      for (const binding of result.data) {
        // 为每个 Commit 加载关联的会话（简化版：使用 sessionIds 数量展示）
        const sessions: AgentSession[] = [];
        for (const sessionId of binding.sessionIds.slice(0, 10)) {
          try {
            const session = await client.getSession(sessionId);
            sessions.push(session);
          } catch {
            // 忽略已删除的会话
          }
        }

        groups.push({
          hash: binding.commitHash,
          message: binding.message,
          committedAt: binding.committedAt,
          sessions,
        });
      }

      this._commitGroups = groups;
    } catch (err) {
      this._error =
        err instanceof BackendUnreachableError
          ? "后台服务未启动"
          : `加载失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this._loading = false;
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }
}

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/**
 * 将 ISO 时间格式化为中文可读字符串（YYYY-MM-DD HH:mm）。
 */
function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

/**
 * 将毫秒耗时格式化为可读字符串（< 1s → "800ms"，>= 1s → "3.2s"）。
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 将 ISO 时间字符串截取为 YYYY-MM-DD 日期部分。
 */
function toDateStr(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * 将日期字符串（YYYY-MM-DD）转换为人类可读的分组标签。
 *
 * 今天    → "今天"
 * 昨天    → "昨天"
 * 本周内  → 星期几（例如 "周三"）
 * 更早    → 原始日期字符串（YYYY-MM-DD）
 */
function toGroupLabel(dateStr: string): string {
  const today = toDateStr(new Date().toISOString());
  if (dateStr === today) return `📅 今天`;

  const yesterday = toDateStr(new Date(Date.now() - 86_400_000).toISOString());
  if (dateStr === yesterday) return `📅 昨天`;

  const diffDays = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 86_400_000,
  );

  if (diffDays < 7) {
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const day = new Date(dateStr).getDay();
    return `📅 ${weekdays[day]}`;
  }

  return `📅 ${dateStr}`;
}

/**
 * 将会话列表按日期（YYYY-MM-DD）分组，返回有序 Map（最新日期在前）。
 */
function groupByDate(sessions: AgentSession[]): Map<string, AgentSession[]> {
  const map = new Map<string, AgentSession[]>();

  // 按时间倒序排列（最新在前）
  const sorted = [...sessions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  for (const session of sorted) {
    const dateStr = toDateStr(session.createdAt);
    const label = toGroupLabel(dateStr);
    const group = map.get(label) ?? [];
    group.push(session);
    map.set(label, group);
  }

  return map;
}

/**
 * 获取当前工作区第一个文件夹的路径。
 */
function resolveWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

/**
 * 获取当前活动编辑器所属工作区的路径。
 */
function resolveActiveEditorWorkspacePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  return folder?.uri.fsPath;
}
