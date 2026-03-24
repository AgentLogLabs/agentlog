/**
 * @agentlog/vscode-extension — SessionWebviewProvider
 *
 * 提供两类 Webview 面板：
 *  1. SessionDetailPanel  — 单条 AgentSession 的详情查看与编辑面板
 *  2. DashboardPanel      — 全量会话列表 + 搜索 + 统计 + 导出的综合仪表板
 *
 * 通信协议：
 *  VS Code Extension (host) <──── postMessage ────> Webview (guest)
 *  - host → guest: { type: string; payload: unknown }
 *  - guest → host: { command: string; data: unknown }
 *
 * 安全性：
 *  - 所有外部内容通过 CSP 限制
 *  - nonce 用于内联脚本白名单
 *  - 不加载任何外部网络资源
 */

import * as vscode from "vscode";
import type {
  AgentSession,
  AgentSource,
  ExportFormat,
  ExportLanguage,
  ModelProvider,
  SessionQueryFilter,
} from "@agentlog/shared";
import {
  getBackendClient,
  BackendUnreachableError,
} from "../client/backendClient";

// ─────────────────────────────────────────────
// 工具：生成 CSP nonce
// ─────────────────────────────────────────────

function generateNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
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
  | { type: "loadSession"; payload: AgentSession }
  | {
      type: "loadSessions";
      payload: {
        sessions: AgentSession[];
        total: number;
        page: number;
        pageSize: number;
      };
    }
  | { type: "loadStats"; payload: Record<string, unknown> }
  | { type: "updateSession"; payload: AgentSession }
  | {
      type: "exportResult";
      payload: { content: string; format: ExportFormat; filename: string };
    }
  | { type: "error"; payload: { message: string } }
  | { type: "loading"; payload: { loading: boolean } }
  | { type: "backendStatus"; payload: { alive: boolean } };

// ─────────────────────────────────────────────
// Webview → Host 消息类型
// ─────────────────────────────────────────────

type FromWebviewMessage =
  | { command: "ready" }
  | { command: "debug"; data: { message: string } }
  | { command: "updateTags"; data: { sessionId: string; tags: string[] } }
  | { command: "updateNote"; data: { sessionId: string; note: string } }
  | { command: "bindCommit"; data: { sessionId: string; commitHash: string } }
  | { command: "unbindCommit"; data: { sessionId: string } }
  | { command: "deleteSession"; data: { sessionId: string } }
  | { command: "viewSessionDetail"; data: { sessionId: string } }
  | {
      command: "exportSession";
      data: {
        sessionId: string;
        format: ExportFormat;
        language: ExportLanguage;
      };
    }
  | {
      command: "querySessions";
      data: {
        page: number;
        pageSize: number;
        keyword?: string;
        /** 文件名模糊匹配（客户端侧过滤 affectedFiles） */
        filename?: string;
        startDate?: string;
        endDate?: string;
        tags?: string[];
        provider?: string;
        source?: string;
        /** true = 仅未绑定 Commit 的会话 */
        onlyUnbound?: boolean;
      };
    }
  | {
      command: "exportAll";
      data: {
        format: ExportFormat;
        language: ExportLanguage;
        startDate?: string;
        endDate?: string;
      };
    }
  | { command: "copyToClipboard"; data: { text: string } }
  | { command: "openInEditor"; data: { content: string; language: string } }
  | { command: "checkBackend" }
  | { command: "openSettings" };

// ─────────────────────────────────────────────
// SessionDetailPanel — 单条会话详情面板
// ─────────────────────────────────────────────

/**
 * 每个 sessionId 最多开一个面板，重复打开时聚焦到已有面板。
 */
export class SessionDetailPanel implements vscode.Disposable {
  private static readonly _openPanels = new Map<string, SessionDetailPanel>();

  public static readonly VIEW_TYPE = "agentlog.sessionDetail";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _sessionId: string;
  private readonly _outputChannel: vscode.OutputChannel;
  private readonly _context: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];
  private _readyReceived = false;

  // ─── 静态工厂 ───────────────────────────────

  /**
   * 打开（或聚焦）指定会话的详情面板。
   */
  static async open(
    sessionId: string,
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
  ): Promise<SessionDetailPanel> {
    outputChannel.appendLine(
      `[Debug][SessionDetailPanel.open] sessionId=${sessionId}`,
    );

    // 已有面板：聚焦并刷新数据
    const existing = SessionDetailPanel._openPanels.get(sessionId);
    if (existing) {
      outputChannel.appendLine(
        `[Debug][SessionDetailPanel.open] 复用已有面板，触发刷新`,
      );
      existing._panel.reveal(vscode.ViewColumn.Beside);
      await existing._loadSession();
      return existing;
    }

    // 创建新面板
    outputChannel.appendLine(`[Debug][SessionDetailPanel.open] 创建新面板`);
    const panel = new SessionDetailPanel(sessionId, context, outputChannel);
    SessionDetailPanel._openPanels.set(sessionId, panel);
    return panel;
  }

  // ─── 构造函数 ───────────────────────────────

  private constructor(
    sessionId: string,
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
  ) {
    this._sessionId = sessionId;
    this._outputChannel = outputChannel;
    this._context = context;
    this._outputChannel.appendLine(
      `[Debug][SessionDetailPanel.constructor] 初始化，sessionId=${sessionId}`,
    );

    this._panel = vscode.window.createWebviewPanel(
      SessionDetailPanel.VIEW_TYPE,
      "AgentLog — 会话详情",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist"),
          vscode.Uri.joinPath(context.extensionUri, "assets"),
        ],
      },
    );

    // 渲染初始 HTML（含 loading 状态）
    const html = this._buildHtml();
    this._panel.webview.html = html;
    this._outputChannel.appendLine(
      `[Debug][SessionDetailPanel.constructor] HTML 已写入 webview，前300字符：\n${html.slice(0, 300)}`,
    );
    this._outputChannel.appendLine(
      `[Debug][SessionDetailPanel.constructor] 提示：若脚本未执行，请在调试窗口执行命令 "Developer: Open Webview Developer Tools" 查看控制台报错`,
    );

    // 监听 Webview 消息
    this._disposables.push(
      this._panel.webview.onDidReceiveMessage((msg: FromWebviewMessage) => {
        this._outputChannel.appendLine(
          `[Debug][SessionDetailPanel.onMessage] 收到消息 command=${msg.command}`,
        );
        return this._handleMessage(msg);
      }),
    );

    // 3 秒内若未收到 ready，说明 webview 脚本未执行，打印告警
    setTimeout(() => {
      if (!this._readyReceived) {
        this._outputChannel.appendLine(
          `[Debug][SessionDetailPanel] ⚠️ 超时：3 秒内未收到 webview 的 ready 消息！` +
            `\n  可能原因：JS 语法错误 / CSP 阻止脚本 / webview 未可见` +
            `\n  请在调试窗口按 Cmd+Shift+P → "Developer: Open Webview Developer Tools" 查看控制台`,
        );
      }
    }, 3000);

    // 面板关闭时清理
    this._disposables.push(
      this._panel.onDidDispose(() => {
        this._outputChannel.appendLine(
          `[Debug][SessionDetailPanel] 面板已关闭，执行 dispose`,
        );
        this.dispose();
      }),
    );
  }

  // ─── 数据加载 ───────────────────────────────

  private async _loadSession(): Promise<void> {
    this._outputChannel.appendLine(
      `[Debug][_loadSession] 开始加载，sessionId=${this._sessionId}`,
    );
    this._postMessage({ type: "loading", payload: { loading: true } });
    try {
      const client = getBackendClient();
      this._outputChannel.appendLine(
        `[Debug][_loadSession] 发起 HTTP 请求 GET /api/sessions/${this._sessionId}`,
      );
      const session = await client.getSession(this._sessionId);
      this._outputChannel.appendLine(
        `[Debug][_loadSession] 请求成功，model=${session.model} id=${session.id}`,
      );

      this._panel.title = `AgentLog — ${session.model} · ${session.id.slice(0, 8)}`;
      this._postMessage({ type: "loadSession", payload: session });
      this._outputChannel.appendLine(
        `[Debug][_loadSession] 已发送 loadSession 消息`,
      );
    } catch (err) {
      const message =
        err instanceof BackendUnreachableError
          ? "后台服务不可达，请确认 AgentLog 服务已启动"
          : err instanceof Error
            ? err.message
            : String(err);
      this._outputChannel.appendLine(
        `[Debug][_loadSession] 请求失败：${message}，错误类型：${(err as object)?.constructor?.name ?? typeof err}`,
      );
      this._postMessage({ type: "error", payload: { message } });
      this._outputChannel.appendLine(`[AgentLog] 加载会话失败：${message}`);
    } finally {
      this._outputChannel.appendLine(
        `[Debug][_loadSession] finally 块执行，发送 loading:false`,
      );
      this._postMessage({ type: "loading", payload: { loading: false } });
    }
  }

  // ─── 消息处理 ───────────────────────────────

  private async _handleMessage(msg: FromWebviewMessage): Promise<void> {
    this._outputChannel.appendLine(
      `[Debug][_handleMessage] 处理消息 command=${msg.command}`,
    );
    const client = getBackendClient();

    try {
      switch (msg.command) {
        case "ready":
          this._readyReceived = true;
          this._outputChannel.appendLine(
            `[Debug][_handleMessage] webview 已就绪，触发 _loadSession`,
          );
          await this._loadSession();
          break;

        case "debug":
          this._outputChannel.appendLine(msg.data.message);
          break;

        case "updateTags": {
          const updated = await client.updateSessionTags(
            msg.data.sessionId,
            msg.data.tags,
          );
          this._postMessage({ type: "updateSession", payload: updated });
          break;
        }

        case "updateNote": {
          const updated = await client.updateSessionNote(
            msg.data.sessionId,
            msg.data.note,
          );
          this._postMessage({ type: "updateSession", payload: updated });
          break;
        }

        case "bindCommit": {
          const updated = await client.bindSessionToCommit(
            msg.data.sessionId,
            msg.data.commitHash,
          );
          this._postMessage({ type: "updateSession", payload: updated });
          vscode.window.showInformationMessage(
            `✅ 已绑定到 Commit ${msg.data.commitHash.slice(0, 8)}`,
          );
          break;
        }

        case "unbindCommit": {
          const updated = await client.bindSessionToCommit(
            msg.data.sessionId,
            null,
          );
          this._postMessage({ type: "updateSession", payload: updated });
          vscode.window.showInformationMessage("✅ 已解除 Commit 绑定");
          break;
        }

        case "deleteSession": {
          const confirm = await vscode.window.showWarningMessage(
            "确定要删除此会话记录吗？此操作不可撤销。",
            { modal: true },
            "确认删除",
          );
          if (confirm === "确认删除") {
            await client.deleteSession(msg.data.sessionId);
            vscode.window.showInformationMessage("✅ 会话记录已删除");
            this._panel.dispose();
          }
          break;
        }

        case "exportSession": {
          const result = await client.exportSessions({
            format: msg.data.format,
            language: msg.data.language,
            workspacePath: undefined,
          });
          const filename = `agentlog_${msg.data.sessionId.slice(0, 8)}_${Date.now()}.${msg.data.format === "jsonl" ? "jsonl" : "md"}`;
          this._postMessage({
            type: "exportResult",
            payload: {
              content: result.content,
              format: msg.data.format,
              filename,
            },
          });
          break;
        }

        case "copyToClipboard":
          await vscode.env.clipboard.writeText(msg.data.text);
          vscode.window.showInformationMessage("✅ 已复制到剪贴板");
          break;

        case "openInEditor": {
          const doc = await vscode.workspace.openTextDocument({
            content: msg.data.content,
            language: msg.data.language,
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
          break;
        }

        case "openSettings":
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "agentlog",
          );
          break;

        case "checkBackend": {
          const status = await client.ping(true);
          this._postMessage({
            type: "backendStatus",
            payload: { alive: status.status === "ok" },
          });
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._postMessage({ type: "error", payload: { message } });
      this._outputChannel.appendLine(`[AgentLog] 操作失败：${message}`);
    }
  }

  // ─── 工具方法 ───────────────────────────────

  private _postMessage(msg: ToWebviewMessage): void {
    this._outputChannel.appendLine(
      `[Debug][_postMessage] → type=${msg.type} payload=${JSON.stringify((msg as { payload?: unknown }).payload ?? null)}`,
    );
    this._panel.webview.postMessage(msg);
  }

  // ─── HTML 构建 ──────────────────────────────

  private _buildHtml(title: string = "AgentLog"): string {
    const nonce = generateNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline' https://*.vscode-cdn.net; script-src 'unsafe-inline' 'unsafe-eval' https://*.vscode-cdn.net; img-src data: https://*.vscode-cdn.net;`;

    // 使用 webview.asWebviewUri() 将扩展目录下的文件转换为 vscode-webview-resource:// 协议
    const extensionUri = this._context.extensionUri;
    const webviewDir = vscode.Uri.joinPath(extensionUri, "dist", "webview");

    const scriptUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, "detail.js"),
    );
    const styleUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, "detail.css"),
    );

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="app">
    <div class="loading-screen">
      <div class="spinner"></div>
      <p>正在加载会话数据…</p>
    </div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  // ─── vscode.Disposable ──────────────────────

  dispose(): void {
    SessionDetailPanel._openPanels.delete(this._sessionId);
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }
}

// ─────────────────────────────────────────────
// DashboardPanel — 综合仪表板（单例）
// ─────────────────────────────────────────────

export class DashboardPanel implements vscode.Disposable {
  private static _instance: DashboardPanel | undefined;
  public static readonly VIEW_TYPE = "agentlog.dashboard";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _outputChannel: vscode.OutputChannel;
  private readonly _context: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];

  // ─── 静态工厂（单例） ───────────────────────

  static open(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
  ): DashboardPanel {
    if (DashboardPanel._instance) {
      DashboardPanel._instance._panel.reveal(vscode.ViewColumn.One);
      DashboardPanel._instance._loadDashboard();
      return DashboardPanel._instance;
    }

    DashboardPanel._instance = new DashboardPanel(context, outputChannel);
    return DashboardPanel._instance;
  }

  // ─── 构造函数 ───────────────────────────────

  private constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
  ) {
    this._context = context;
    this._outputChannel = outputChannel;

    this._panel = vscode.window.createWebviewPanel(
      DashboardPanel.VIEW_TYPE,
      "AgentLog 仪表板",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist"),
          vscode.Uri.joinPath(context.extensionUri, "assets"),
        ],
      },
    );

    this._panel.webview.html = this._buildHtml();

    this._disposables.push(
      this._panel.webview.onDidReceiveMessage((msg: FromWebviewMessage) =>
        this._handleMessage(msg),
      ),
    );

    this._disposables.push(this._panel.onDidDispose(() => this.dispose()));
  }

  // ─── 数据加载 ───────────────────────────────

  private async _loadDashboard(): Promise<void> {
    this._postMessage({ type: "loading", payload: { loading: true } });

    try {
      const client = getBackendClient();

      // 并行加载：会话列表 + 统计数据
      const [sessionsResult, stats] = await Promise.allSettled([
        client.querySessions({ page: 1, pageSize: 20 }),
        client.getSessionStats(this._resolveWorkspacePath()),
      ]);

      if (sessionsResult.status === "fulfilled") {
        const { data, total, page, pageSize } = sessionsResult.value;
        this._postMessage({
          type: "loadSessions",
          payload: { sessions: data, total, page, pageSize },
        });
      }

      if (stats.status === "fulfilled") {
        this._postMessage({ type: "loadStats", payload: stats.value });
      }

      // 更新后台连接状态
      const health = await client.ping();
      this._postMessage({
        type: "backendStatus",
        payload: { alive: health.status === "ok" },
      });
    } catch (err) {
      const message =
        err instanceof BackendUnreachableError
          ? "后台服务不可达，请确认 AgentLog 服务已启动"
          : err instanceof Error
            ? err.message
            : String(err);
      this._postMessage({ type: "error", payload: { message } });
    } finally {
      this._postMessage({ type: "loading", payload: { loading: false } });
    }
  }

  // ─── 消息处理 ───────────────────────────────

  private async _handleMessage(msg: FromWebviewMessage): Promise<void> {
    const client = getBackendClient();

    try {
      switch (msg.command) {
        case "ready":
          await this._loadDashboard();
          break;

        case "viewSessionDetail": {
          // 仪表板列表点击"详情"——在侧边打开详情面板
          const { sessionId } = msg.data;
          const context = this._context;
          const outputChannel = this._outputChannel;
          // 异步打开，不阻塞仪表板响应
          SessionDetailPanel.open(sessionId, context, outputChannel).catch(
            (err) =>
              this._outputChannel.appendLine(
                `[AgentLog Dashboard] 打开详情失败：${err}`,
              ),
          );
          break;
        }

        case "querySessions": {
          const workspacePath = this._resolveWorkspacePath();
          const { filename, onlyUnbound, provider, source, ...rest } =
            msg.data;

          // 构建传给 backend 的查询过滤参数
          const filter: SessionQueryFilter = {
            page: rest.page,
            pageSize: rest.pageSize,
            keyword: rest.keyword,
            startDate: rest.startDate,
            endDate: rest.endDate,
            tags: rest.tags,
            provider: provider as ModelProvider | undefined,
            source: source as AgentSource | undefined,
            workspacePath,
          };

          let result = await client.querySessions(filter);

          // 客户端侧：按 filename 过滤 affectedFiles
          if (filename && filename.trim()) {
            const lower = filename.trim().toLowerCase();
            const filtered = result.data.filter(
              (s) =>
                Array.isArray(s.affectedFiles) &&
                s.affectedFiles.some((f) =>
                  f.toLowerCase().includes(lower),
                ),
            );
            result = {
              ...result,
              data: filtered,
              total: filtered.length,
            };
          }

          // 客户端侧：仅未绑定
          if (onlyUnbound) {
            const filtered = result.data.filter((s) => !s.commitHash);
            result = {
              ...result,
              data: filtered,
              total: filtered.length,
            };
          }

          this._postMessage({
            type: "loadSessions",
            payload: {
              sessions: result.data,
              total: result.total,
              page: result.page,
              pageSize: result.pageSize,
            },
          });
          break;
        }

        case "exportAll": {
          this._postMessage({ type: "loading", payload: { loading: true } });
          const workspacePath = this._resolveWorkspacePath();
          const result = await client.exportSessions({
            format: msg.data.format,
            language: msg.data.language,
            startDate: msg.data.startDate,
            endDate: msg.data.endDate,
            workspacePath,
          });

          // 在编辑器中打开导出结果
          const langMap: Record<ExportFormat, string> = {
            "weekly-report": "markdown",
            "pr-description": "markdown",
            jsonl: "json",
            csv: "csv",
          };
          const doc = await vscode.workspace.openTextDocument({
            content: result.content,
            language: langMap[msg.data.format] ?? "plaintext",
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

          vscode.window
            .showInformationMessage(
              `✅ 导出完成：共 ${result.sessionCount} 条会话记录`,
              "保存到文件",
            )
            .then(async (action) => {
              if (action === "保存到文件") {
                const ext = {
                  "weekly-report": "md",
                  "pr-description": "md",
                  jsonl: "jsonl",
                  csv: "csv",
                }[msg.data.format];
                const uri = await vscode.window.showSaveDialog({
                  defaultUri: vscode.Uri.file(
                    `agentlog_export_${Date.now()}.${ext}`,
                  ),
                  filters: { 导出文件: [ext] },
                });
                if (uri) {
                  await vscode.workspace.fs.writeFile(
                    uri,
                    Buffer.from(result.content, "utf-8"),
                  );
                  vscode.window.showInformationMessage(
                    `✅ 已保存到：${uri.fsPath}`,
                  );
                }
              }
            });
          break;
        }

        case "deleteSession": {
          const confirm = await vscode.window.showWarningMessage(
            "确定要删除此会话记录吗？此操作不可撤销。",
            { modal: true },
            "确认删除",
          );
          if (confirm === "确认删除") {
            await client.deleteSession(msg.data.sessionId);
            vscode.window.showInformationMessage("✅ 会话记录已删除");
            await this._loadDashboard(); // 刷新列表
          }
          break;
        }

        case "copyToClipboard":
          await vscode.env.clipboard.writeText(msg.data.text);
          vscode.window.showInformationMessage("✅ 已复制到剪贴板");
          break;

        case "openInEditor": {
          const doc = await vscode.workspace.openTextDocument({
            content: msg.data.content,
            language: msg.data.language,
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
          break;
        }

        case "openSettings":
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "agentlog",
          );
          break;

        case "checkBackend": {
          const status = await client.ping(true);
          this._postMessage({
            type: "backendStatus",
            payload: { alive: status.status === "ok" },
          });
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._postMessage({ type: "error", payload: { message } });
      this._outputChannel.appendLine(
        `[AgentLog Dashboard] 操作失败：${message}`,
      );
    } finally {
      this._postMessage({ type: "loading", payload: { loading: false } });
    }
  }

  // ─── 公开方法（供 extension.ts 调用） ───────

  /**
   * 收到新会话上报时，通知仪表板刷新统计徽章。
   * 不触发全量重新加载，避免打断用户操作。
   */
  async notifyNewSession(): Promise<void> {
    if (!this._panel.visible) return;
    try {
      const stats = await getBackendClient().getSessionStats(
        this._resolveWorkspacePath(),
      );
      this._postMessage({ type: "loadStats", payload: stats });
    } catch {
      // 静默失败
    }
  }

  // ─── 工具方法 ───────────────────────────────

  private _postMessage(msg: ToWebviewMessage): void {
    this._panel.webview.postMessage(msg);
  }

  private _resolveWorkspacePath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  // ─── HTML 构建 ──────────────────────────────

  private _buildHtml(): string {
    const nonce = generateNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline' https://*.vscode-cdn.net; script-src 'unsafe-inline' 'unsafe-eval' https://*.vscode-cdn.net; img-src data: https://*.vscode-cdn.net;`;

    // 使用 webview.asWebviewUri() 将扩展目录下的文件转换为 vscode-webview-resource:// 协议
    const extensionUri = this._context.extensionUri;
    const webviewDir = vscode.Uri.joinPath(extensionUri, "dist", "webview");

    const scriptUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, "dashboard.js"),
    );
    const styleUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, "dashboard.css"),
    );

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>AgentLog 仪表板</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="app">
    <div class="loading-screen">
      <div class="spinner"></div>
      <p>正在加载仪表板…</p>
    </div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  // ─── vscode.Disposable ──────────────────────

  dispose(): void {
    DashboardPanel._instance = undefined;
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }
}

// ─────────────────────────────────────────────
// CSS 样式（内联，遵守 CSP 限制）
// ─────────────────────────────────────────────

function getDetailStyles(): string {
  return `
    :root {
      --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      --font-mono: 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace;
      --radius: 6px;
      --gap: 16px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font-sans);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.6;
      padding: 20px;
    }

    .loading-screen {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 80vh;
      gap: 16px;
      color: var(--vscode-descriptionForeground);
    }

    .spinner {
      width: 32px; height: 32px;
      border: 3px solid var(--vscode-widget-border);
      border-top-color: var(--vscode-focusBorder);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .session-detail { max-width: 900px; margin: 0 auto; }

    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--gap);
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }

    .header-left h1 {
      font-size: 16px;
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 6px;
    }

    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 500;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .badge.provider-deepseek { background: #1a6bb5; color: #fff; }
    .badge.provider-qwen     { background: #7b2feb; color: #fff; }
    .badge.provider-kimi     { background: #0ea5e9; color: #fff; }
    .badge.provider-doubao   { background: #f97316; color: #fff; }
    .badge.provider-ollama   { background: #4b5563; color: #fff; }

    .badge.source-cline   { background: var(--vscode-terminal-ansiBrightGreen); color: #000; }
    .badge.source-cursor  { background: var(--vscode-terminal-ansiBrightBlue);  color: #000; }

    .badge.commit { background: var(--vscode-gitDecoration-addedResourceForeground); color: #000; }
    .badge.unbound { background: var(--vscode-editorWarning-foreground); color: #000; }

    .header-actions { display: flex; gap: 8px; flex-shrink: 0; }

    button {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 12px;
      border-radius: var(--radius);
      border: 1px solid var(--vscode-button-border, transparent);
      cursor: pointer;
      font-size: 12px;
      font-family: var(--font-sans);
      transition: opacity 0.15s;
    }

    button:hover { opacity: 0.85; }

    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    button.danger {
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-errorForeground);
      border-color: var(--vscode-inputValidation-errorBorder);
    }

    button:disabled { opacity: 0.45; cursor: not-allowed; }

    .section {
      margin-bottom: 20px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      cursor: pointer;
      user-select: none;
    }

    .section-header h2 {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    }

    .section-body {
      padding: 14px;
      background: var(--vscode-editor-background);
    }

    pre, code {
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
    }

    pre {
      padding: 10px 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 400px;
      overflow-y: auto;
    }

    code { padding: 1px 4px; }

    .tag {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      cursor: pointer;
    }

    .tag:hover { opacity: 0.75; }

    .tag-remove {
      font-size: 10px;
      opacity: 0.6;
    }

    input[type="text"], textarea {
      width: 100%;
      padding: 5px 8px;
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--radius);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--font-sans);
      font-size: 12px;
      outline: none;
    }

    input[type="text"]:focus, textarea:focus {
      border-color: var(--vscode-focusBorder);
    }

    textarea { resize: vertical; min-height: 60px; }

    .error-banner {
      padding: 10px 14px;
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: var(--radius);
      color: var(--vscode-errorForeground);
      margin-bottom: 16px;
    }

    .reasoning-block {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      max-height: 300px;
      overflow-y: auto;
    }
  `;
}

// ─────────────────────────────────────────────
// JavaScript（内联，Webview 端运行）
// ─────────────────────────────────────────────

function getDetailScript(): string {
  return `
    const vscode = acquireVsCodeApi();
    let currentSession = null;

    function dbg(msg) {
      vscode.postMessage({ command: 'debug', data: { message: '[Webview] ' + msg } });
    }

    dbg('脚本开始执行');

    // ── 接收来自 Extension Host 的消息 ──
    window.addEventListener('message', (event) => {
      const msg = event.data;
      dbg('收到消息 type=' + msg.type + ' payload=' + JSON.stringify(msg.payload ?? null).slice(0, 120));
      switch (msg.type) {
        case 'loadSession':
          currentSession = msg.payload;
          dbg('调用 renderSession，id=' + (msg.payload && msg.payload.id));
          renderSession(msg.payload);
          dbg('renderSession 执行完毕');
          break;
        case 'updateSession':
          currentSession = msg.payload;
          renderSession(msg.payload);
          break;
        case 'loading':
          if (msg.payload.loading) {
            dbg('显示 loading 遮罩');
            document.getElementById('app').innerHTML = '<div class="loading-screen"><div class="spinner"></div><p>加载中…</p></div>';
          } else {
            dbg('loading:false，跳过清空（内容保留）');
          }
          break;
        case 'error':
          dbg('显示错误：' + (msg.payload && msg.payload.message));
          document.getElementById('app').innerHTML =
            '<div class="error-banner">⚠️ ' + escHtml(msg.payload.message) + '</div>';
          break;
        case 'exportResult':
          vscode.postMessage({ command: 'openInEditor', data: { content: msg.payload.content, language: 'markdown' } });
          break;
        case 'backendStatus':
          updateStatusIndicator(msg.payload.alive);
          break;
        default:
          dbg('未知消息类型: ' + msg.type);
      }
    });

    // 页面就绪后通知 Host
    dbg('发送 ready 消息');
    vscode.postMessage({ command: 'ready' });
    dbg('ready 消息已发送');

    function renderSession(s) {
      const commitBadge = s.commitHash
        ? '<span class="badge commit">✓ ' + escHtml(s.commitHash.slice(0, 8)) + '</span>'
        : '<span class="badge unbound">未绑定</span>';

      const tags = (s.tags || []).map(t =>
        '<span class="tag">' + escHtml(t) + ' <span class="tag-remove" onclick="removeTag(\'' + escHtml(t) + '\')">×</span></span>'
      ).join(' ');

      const reasoningBlock = s.reasoning
        ? '<div class="section"><div class="section-header" onclick="toggleSection(this)"><h2>💡 推理过程 (' + s.reasoning.length + ' 字符)</h2><span>▼</span></div>' +
          '<div class="section-body"><pre class="reasoning-block">' + escHtml(s.reasoning) + '</pre></div></div>'
        : '';

      document.getElementById('app').innerHTML = \`
        <div class="session-detail">
          <div class="header">
            <div class="header-left">
              <h1>\${escHtml(s.model)} <span id="status-dot" class="status-dot"></span></h1>
              <div class="meta-row">
                <span class="badge provider-\${escHtml(s.provider)}">\${escHtml(s.provider)}</span>
                <span class="badge source-\${escHtml(s.source)}">\${escHtml(s.source)}</span>
                \${commitBadge}
                <span style="color:var(--vscode-descriptionForeground);font-size:11px">\${escHtml(formatTime(s.createdAt))} · \${formatDuration(s.durationMs)}</span>
              </div>
            </div>
            <div class="header-actions">
              <button class="secondary" onclick="copyContent()">复制回复</button>
              <button class="secondary" onclick="openInEditor()">在编辑器打开</button>
              <button class="danger" onclick="deleteSession()">删除</button>
            </div>
          </div>

          <div class="section">
            <div class="section-header" onclick="toggleSection(this)"><h2>📝 Prompt</h2><span>▼</span></div>
            <div class="section-body"><pre>\${escHtml(s.prompt)}</pre></div>
          </div>

          \${reasoningBlock}

          <div class="section">
            <div class="section-header" onclick="toggleSection(this)"><h2>🤖 AI 回复</h2><span>▼</span></div>
            <div class="section-body"><pre>\${escHtml(s.response)}</pre></div>
          </div>

          <div class="section">
            <div class="section-header"><h2>🏷️ 标签 & 备注</h2></div>
            <div class="section-body">
              <div style="margin-bottom:10px">\${tags || '<span style="color:var(--vscode-descriptionForeground)">暂无标签</span>'}</div>
              <div style="display:flex;gap:6px;margin-bottom:12px">
                <input type="text" id="tag-input" placeholder="输入标签后按 Enter" style="flex:1" onkeydown="addTagOnEnter(event)">
                <button class="secondary" onclick="addTag()">添加</button>
              </div>
              <textarea id="note-input" placeholder="添加备注说明…" onblur="saveNote()">\${escHtml(s.note || '')}</textarea>
            </div>
          </div>

          <div class="section">
            <div class="section-header"><h2>🔗 Commit 绑定</h2></div>
            <div class="section-body" style="display:flex;gap:8px;align-items:center">
              <input type="text" id="commit-input" placeholder="输入 Git Commit Hash" value="\${escHtml(s.commitHash || '')}" style="flex:1">
              <button class="primary" onclick="bindCommit()">绑定</button>
              \${s.commitHash ? '<button class="secondary" onclick="unbindCommit()">解绑</button>' : ''}
            </div>
          </div>

          \${s.affectedFiles && s.affectedFiles.length > 0 ? \`
          <div class="section">
            <div class="section-header"><h2>📁 涉及文件</h2></div>
            <div class="section-body">\${s.affectedFiles.map(f => '<code>' + escHtml(f) + '</code>').join('  ')}</div>
          </div>\` : ''}
        </div>
      \`;

      vscode.postMessage({ command: 'checkBackend' });
    }

    function toggleSection(header) {
      const body = header.nextElementSibling;
      const arrow = header.querySelector('span:last-child');
      if (body.style.display === 'none') {
        body.style.display = '';
        if (arrow) arrow.textContent = '▼';
      } else {
        body.style.display = 'none';
        if (arrow) arrow.textContent = '▶';
      }
    }

    function addTag() {
      const input = document.getElementById('tag-input');
      const tag = (input.value || '').trim();
      if (!tag || !currentSession) return;
      const newTags = [...(currentSession.tags || [])];
      if (!newTags.includes(tag)) newTags.push(tag);
      input.value = '';
      vscode.postMessage({ command: 'updateTags', data: { sessionId: currentSession.id, tags: newTags } });
    }

    function addTagOnEnter(e) { if (e.key === 'Enter') addTag(); }

    function removeTag(tag) {
      if (!currentSession) return;
      const newTags = (currentSession.tags || []).filter(t => t !== tag);
      vscode.postMessage({ command: 'updateTags', data: { sessionId: currentSession.id, tags: newTags } });
    }

    function saveNote() {
      const note = document.getElementById('note-input').value;
      if (!currentSession) return;
      vscode.postMessage({ command: 'updateNote', data: { sessionId: currentSession.id, note } });
    }

    function bindCommit() {
      const hash = (document.getElementById('commit-input').value || '').trim();
      if (!hash || !currentSession) return;
      vscode.postMessage({ command: 'bindCommit', data: { sessionId: currentSession.id, commitHash: hash } });
    }

    function unbindCommit() {
      if (!currentSession) return;
      vscode.postMessage({ command: 'unbindCommit', data: { sessionId: currentSession.id } });
    }

    function deleteSession() {
      if (!currentSession) return;
      vscode.postMessage({ command: 'deleteSession', data: { sessionId: currentSession.id } });
    }

    function copyContent() {
      if (!currentSession) return;
      vscode.postMessage({ command: 'copyToClipboard', data: { text: currentSession.response } });
    }

    function openInEditor() {
      if (!currentSession) return;
      vscode.postMessage({ command: 'openInEditor', data: { content: currentSession.response, language: 'markdown' } });
    }

    function updateStatusIndicator(alive) {
      const dot = document.getElementById('status-dot');
      if (dot) { dot.className = 'status-dot ' + (alive ? 'online' : 'offline'); }
    }

    function escHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatTime(iso) {
      try {
        const d = new Date(iso);
        const p = n => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      } catch { return iso; }
    }

    function formatDuration(ms) {
      if (!ms) return '';
      return ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's';
    }
  `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
