/**
 * @agentlog/vscode-extension — 插件主入口
 *
 * 生命周期：
 *  activate()   — VS Code 启动时（onStartupFinished）调用
 *  deactivate() — 插件停用 / 窗口关闭时调用
 *
 * 职责：
 *  1. 读取配置，初始化 BackendClient
 *  2. 按需启动本地后台子进程（@agentlog/backend）
 *  3. 注册所有 VS Code Command
 *  4. 注册侧边栏 TreeView（会话列表 + Commit 绑定）
 *  5. 启动 HTTP 拦截器，自动捕获 AI 交互
 *  6. 维护状态栏徽章（捕获状态 / 服务在线状态）
 *  7. 监听配置变更，热更新相关模块
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import type {
  AgentLogConfig,
  ExportFormat,
  ExportLanguage,
} from "@agentlog/shared";
import { DEFAULT_CONFIG } from "@agentlog/shared";
import {
  initBackendClient,
  destroyBackendClient,
  getBackendClient,
  BackendUnreachableError,
} from "./client/backendClient";
import { InterceptorManager } from "./interceptors/apiInterceptor";
import {
  SessionTreeProvider,
  CommitBindingsTreeProvider,
  SessionItem,
} from "./providers/sessionTreeProvider";
import {
  SessionDetailPanel,
  DashboardPanel,
} from "./providers/sessionWebviewProvider";
import {
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
  getClaudeCodeHookStatus,
} from "./hooks/hookInstaller";
import { registerCopilotChatParticipant } from "./hooks/copilotChatParticipant";

// ─────────────────────────────────────────────
// 模块级状态（插件生命周期内持久）
// ─────────────────────────────────────────────

/** 输出频道（用于调试日志） */
let outputChannel: vscode.OutputChannel;

/** 状态栏：显示捕获状态与会话数量 */
let statusBarItem: vscode.StatusBarItem;

/** 本地后台子进程句柄 */
let backendProcess: cp.ChildProcess | null = null;

/** HTTP 拦截器管理器 */
let interceptorManager: InterceptorManager;

/** 会话列表 TreeView 提供者 */
let sessionTreeProvider: SessionTreeProvider;

/** Commit 绑定 TreeView 提供者 */
let commitBindingsProvider: CommitBindingsTreeProvider;

/** 所有需要在 deactivate 时清理的 Disposable */
const disposables: vscode.Disposable[] = [];

// ─────────────────────────────────────────────
// 配置读取
// ─────────────────────────────────────────────

/**
 * 从 VS Code 设置中读取 AgentLog 配置，
 * 缺失的字段自动回退到 DEFAULT_CONFIG。
 */
function readConfig(): AgentLogConfig {
  const cfg = vscode.workspace.getConfiguration("agentlog");
  return {
    backendUrl: cfg.get<string>("backendUrl") ?? DEFAULT_CONFIG.backendUrl,
    autoCapture: cfg.get<boolean>("autoCapture") ?? DEFAULT_CONFIG.autoCapture,
    captureReasoning:
      cfg.get<boolean>("captureReasoning") ?? DEFAULT_CONFIG.captureReasoning,
    autoBindOnCommit:
      cfg.get<boolean>("autoBindOnCommit") ?? DEFAULT_CONFIG.autoBindOnCommit,
    retentionDays:
      cfg.get<number>("retentionDays") ?? DEFAULT_CONFIG.retentionDays,
    debug: cfg.get<boolean>("debug") ?? DEFAULT_CONFIG.debug,
  };
}

// ─────────────────────────────────────────────
// 状态栏管理
// ─────────────────────────────────────────────

function initStatusBar(): void {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "agentlog.showBackendStatus";
  updateStatusBar("idle");
  statusBarItem.show();
  disposables.push(statusBarItem);
}

type StatusBarState =
  | "idle"
  | "capturing"
  | "backend-offline"
  | "backend-starting";

function updateStatusBar(state: StatusBarState, count?: number): void {
  switch (state) {
    case "capturing":
      statusBarItem.text = `$(record) AgentLog ${count !== undefined ? `(${count})` : ""}`;
      statusBarItem.tooltip = `AgentLog 正在捕获 AI 交互 · 共 ${count ?? 0} 条记录\n点击查看后台状态`;
      statusBarItem.backgroundColor = undefined;
      break;
    case "backend-offline":
      statusBarItem.text = `$(warning) AgentLog 离线`;
      statusBarItem.tooltip = "AgentLog 后台服务未连接，点击查看详情";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
      break;
    case "backend-starting":
      statusBarItem.text = `$(sync~spin) AgentLog 启动中…`;
      statusBarItem.tooltip = "AgentLog 后台服务正在启动";
      statusBarItem.backgroundColor = undefined;
      break;
    case "idle":
    default:
      statusBarItem.text = `$(history) AgentLog`;
      statusBarItem.tooltip = "AgentLog — AI 编程行车记录仪\n点击查看后台状态";
      statusBarItem.backgroundColor = undefined;
      break;
  }
}

// ─────────────────────────────────────────────
// 后台进程管理
// ─────────────────────────────────────────────

/**
 * 启动本地后台子进程。
 * 若已在运行则跳过。
 * 子进程的 stdout / stderr 重定向到 VS Code 输出频道。
 */
async function startBackendProcess(
  context: vscode.ExtensionContext,
  config: AgentLogConfig,
): Promise<void> {
  if (backendProcess && !backendProcess.killed) {
    log("[后台] 进程已在运行，跳过重启");
    return;
  }

  updateStatusBar("backend-starting");

  // 尝试先 ping 一次，避免重复启动已有的后台实例
  const client = getBackendClient();
  const health = await client.ping(true);
  if (health.status === "ok") {
    log(
      `[后台] 检测到已有运行中的后台实例（v${health.version}），跳过本地启动`,
    );
    updateStatusBar("capturing");
    return;
  }

  // 确定后台入口文件路径
  // 在打包的插件中，后台以预编译 JS 存在于 dist/ 目录
  const backendEntry = path.join(
    context.extensionPath,
    "dist",
    "backend",
    "index.js",
  );

  // 开发模式下，使用源码路径（通过 tsx 运行）
  const devEntry = path.join(
    context.extensionPath,
    "..",
    "backend",
    "src",
    "index.ts",
  );

  const isDevMode = context.extensionMode === vscode.ExtensionMode.Development;

  let command: string;
  let args: string[];

  if (isDevMode) {
    command = "npx";
    args = ["tsx", devEntry];
  } else {
    command = "node";
    args = [backendEntry];
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENTLOG_PORT: new URL(config.backendUrl).port || "7892",
    NODE_ENV: isDevMode ? "development" : "production",
  };

  log(`[后台] 启动命令：${command} ${args.join(" ")}`);

  backendProcess = cp.spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  backendProcess.stdout?.on("data", (data: Buffer) => {
    log(`[后台] ${data.toString().trimEnd()}`);
  });

  backendProcess.stderr?.on("data", (data: Buffer) => {
    log(`[后台][ERR] ${data.toString().trimEnd()}`);
  });

  backendProcess.on("close", (code) => {
    log(`[后台] 进程退出，退出码：${code}`);
    backendProcess = null;
    updateStatusBar("backend-offline");
  });

  backendProcess.on("error", (err) => {
    log(`[后台] 进程启动失败：${err.message}`);
    backendProcess = null;
    updateStatusBar("backend-offline");
    vscode.window
      .showErrorMessage(`AgentLog 后台服务启动失败：${err.message}`, "查看日志")
      .then((action) => {
        if (action === "查看日志") outputChannel.show();
      });
  });

  // 等待服务就绪（最多 10 秒，每 500ms 轮询一次）
  const ready = await waitForBackend(config.backendUrl, 10_000, 500);
  if (ready) {
    log("[后台] 服务已就绪");
    updateStatusBar(config.autoCapture ? "capturing" : "idle");
    vscode.window.showInformationMessage("✅ AgentLog 后台服务已启动");
  } else {
    log("[后台] 服务启动超时");
    updateStatusBar("backend-offline");
    vscode.window
      .showWarningMessage("AgentLog 后台服务启动超时，请检查日志", "查看日志")
      .then((action) => {
        if (action === "查看日志") outputChannel.show();
      });
  }
}

/**
 * 停止本地后台子进程。
 */
function stopBackendProcess(): void {
  if (!backendProcess || backendProcess.killed) {
    log("[后台] 没有运行中的进程");
    return;
  }

  backendProcess.kill("SIGTERM");

  // 3 秒后如果还未退出，强制 SIGKILL
  const forceKillTimer = setTimeout(() => {
    if (backendProcess && !backendProcess.killed) {
      backendProcess.kill("SIGKILL");
      log("[后台] 强制终止进程");
    }
  }, 3_000);

  backendProcess.once("close", () => {
    clearTimeout(forceKillTimer);
    backendProcess = null;
    updateStatusBar("backend-offline");
    log("[后台] 进程已停止");
  });
}

/**
 * 轮询等待后台服务就绪。
 *
 * @param backendUrl   后台地址
 * @param timeoutMs    超时时间（ms）
 * @param intervalMs   轮询间隔（ms）
 */
async function waitForBackend(
  backendUrl: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const client = getBackendClient();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const health = await client.ping(true);
    if (health.status === "ok") return true;
    await sleep(intervalMs);
  }

  return false;
}

// ─────────────────────────────────────────────
// Command 注册
// ─────────────────────────────────────────────

function registerCommands(
  context: vscode.ExtensionContext,
  config: AgentLogConfig,
): void {
  const register = (
    id: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    disposables.push(vscode.commands.registerCommand(id, handler));
  };

  // ── 后台服务 ──────────────────────────────

  register("agentlog.startBackend", async () => {
    const currentConfig = readConfig();
    await startBackendProcess(context, currentConfig);
  });

  register("agentlog.stopBackend", () => {
    stopBackendProcess();
    vscode.window.showInformationMessage("AgentLog 后台服务已停止");
  });

  register("agentlog.showBackendStatus", async () => {
    const client = getBackendClient();
    updateStatusBar("backend-starting");

    try {
      const health = await client.ping(true);

      if (health.status === "ok") {
        updateStatusBar("capturing");

        const action = await vscode.window.showInformationMessage(
          `✅ AgentLog 后台在线 | 版本 ${health.version ?? "unknown"} | 运行 ${formatUptime(health.uptime ?? 0)}`,
          "打开仪表板",
          "停止服务",
        );

        if (action === "打开仪表板") {
          await vscode.commands.executeCommand("agentlog.openDashboard");
        } else if (action === "停止服务") {
          stopBackendProcess();
        }
      } else {
        updateStatusBar("backend-offline");

        const action = await vscode.window.showWarningMessage(
          "⚠️ AgentLog 后台服务未连接",
          "立即启动",
          "查看配置",
        );

        if (action === "立即启动") {
          await vscode.commands.executeCommand("agentlog.startBackend");
        } else if (action === "查看配置") {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "agentlog.backendUrl",
          );
        }
      }
    } catch (err) {
      updateStatusBar("backend-offline");
      log(
        `[状态检查] 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ── 捕获控制 ──────────────────────────────

  register("agentlog.startCapture", () => {
    interceptorManager.start();
    updateStatusBar("capturing");
    vscode.window.showInformationMessage("✅ AgentLog 已开始捕获 AI 交互");
  });

  register("agentlog.stopCapture", () => {
    interceptorManager.stop();
    updateStatusBar("idle");
    vscode.window.showInformationMessage("AgentLog 已停止捕获 AI 交互");
  });

  // ── 会话管理 ──────────────────────────────

  register("agentlog.refreshSessionList", () => {
    sessionTreeProvider.refresh();
    commitBindingsProvider.refresh();
  });

  register("agentlog.loadMoreSessions", async (page: unknown) => {
    const pageNum = typeof page === "number" ? page : 2;
    await sessionTreeProvider.loadPage(pageNum);
  });

  register("agentlog.viewSessionDetail", async (sessionOrId: unknown) => {
    let sessionId: string;

    if (sessionOrId instanceof SessionItem) {
      sessionId = sessionOrId.session.id;
    } else if (
      typeof sessionOrId === "object" &&
      sessionOrId !== null &&
      "id" in sessionOrId &&
      typeof (sessionOrId as { id: unknown }).id === "string"
    ) {
      sessionId = (sessionOrId as { id: string }).id;
    } else if (typeof sessionOrId === "string") {
      sessionId = sessionOrId;
    } else {
      vscode.window.showErrorMessage("无法解析会话 ID");
      return;
    }

    await SessionDetailPanel.open(sessionId, context, outputChannel);
  });

  register("agentlog.deleteSession", async (item: unknown) => {
    let sessionId: string | undefined;

    if (item instanceof SessionItem) {
      sessionId = item.session.id;
    }

    if (!sessionId) {
      vscode.window.showErrorMessage("无法解析要删除的会话 ID");
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      "确定要删除此会话记录吗？此操作不可撤销。",
      { modal: true },
      "确认删除",
    );

    if (confirm !== "确认删除") return;

    try {
      const client = getBackendClient();
      await client.deleteSession(sessionId);
      sessionTreeProvider.refresh();
      vscode.window.showInformationMessage("✅ 会话记录已删除");
    } catch (err) {
      vscode.window.showErrorMessage(
        `删除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ── Commit 绑定 ───────────────────────────

  register("agentlog.bindCommit", async (item: unknown) => {
    let sessionId: string | undefined;

    if (item instanceof SessionItem) {
      sessionId = item.session.id;
    }

    if (!sessionId) {
      // 若无上下文，弹出输入框
      sessionId = await vscode.window.showInputBox({
        prompt: "请输入要绑定的会话 ID",
        placeHolder: "nanoid（例如：V1StGXR8_Z5j）",
      });
      if (!sessionId) return;
    }

    const commitHash = await vscode.window.showInputBox({
      prompt: "请输入 Git Commit Hash",
      placeHolder: "完整或短 SHA（例如：abc1234）",
      validateInput: (v) =>
        v.trim().length < 4 ? "Commit Hash 至少需要 4 位" : undefined,
    });

    if (!commitHash) return;

    try {
      const client = getBackendClient();
      const workspacePath = resolveWorkspacePath();
      await client.bindCommit([sessionId], commitHash.trim(), workspacePath);

      sessionTreeProvider.refresh();
      commitBindingsProvider.refresh();

      vscode.window.showInformationMessage(
        `✅ 已将会话绑定到 Commit ${commitHash.slice(0, 8)}`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `绑定失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ── Git Hook ──────────────────────────────

  register("agentlog.installGitHook", async () => {
    const workspacePath = resolveWorkspacePath();

    if (!workspacePath) {
      vscode.window.showErrorMessage(
        "未找到工作区，请先打开一个包含 Git 仓库的文件夹",
      );
      return;
    }

    try {
      const currentConfig = readConfig();
      const client = getBackendClient();
      const result = await client.installGitHook(
        workspacePath,
        currentConfig.backendUrl,
      );

      commitBindingsProvider.refresh();

      vscode.window.showInformationMessage(
        `✅ Git 钩子已安装\n仓库：${result.repoRootPath}\n分支：${result.currentBranch}`,
      );
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        vscode.window
          .showErrorMessage(
            "AgentLog 后台服务未启动，请先启动后台服务",
            "启动服务",
          )
          .then((action) => {
            if (action === "启动服务") {
              vscode.commands.executeCommand("agentlog.startBackend");
            }
          });
      } else {
        vscode.window.showErrorMessage(
          `Git 钩子安装失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });

  register("agentlog.removeGitHook", async () => {
    const workspacePath = resolveWorkspacePath();

    if (!workspacePath) {
      vscode.window.showErrorMessage("未找到工作区");
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      "确定要移除 AgentLog 的 Git post-commit 钩子吗？移除后将不再自动绑定 Commit。",
      { modal: true },
      "确认移除",
    );

    if (confirm !== "确认移除") return;

    try {
      const client = getBackendClient();
      await client.removeGitHook(workspacePath);
      vscode.window.showInformationMessage("✅ Git 钩子已移除");
    } catch (err) {
      vscode.window.showErrorMessage(
        `移除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ── Claude Code Hooks ─────────────────────

  register("agentlog.installHooks", async () => {
    const currentConfig = readConfig();
    const status = getClaudeCodeHookStatus();

    if (status.allInstalled) {
      const action = await vscode.window.showInformationMessage(
        "Claude Code 的 AgentLog Hook 已安装，是否重新安装（更新后端地址）？",
        "重新安装",
        "取消",
      );
      if (action !== "重新安装") return;
    }

    try {
      installClaudeCodeHooks(currentConfig.backendUrl);
      vscode.window.showInformationMessage(
        `✅ Claude Code Hook 已安装，Stop 事件将上报到 ${currentConfig.backendUrl}`,
      );
      log(
        `[Hooks] Claude Code hooks 已写入 ~/.claude/settings.json → ${currentConfig.backendUrl}`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Hook 安装失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  register("agentlog.uninstallHooks", async () => {
    const status = getClaudeCodeHookStatus();

    if (!status.settingsExists || !status.allInstalled) {
      vscode.window.showInformationMessage(
        "当前未检测到已安装的 AgentLog Hook，无需卸载。",
      );
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      "确定要移除 Claude Code 中的 AgentLog Hook 配置吗？",
      { modal: true },
      "确认移除",
    );
    if (confirm !== "确认移除") return;

    try {
      const removed = uninstallClaudeCodeHooks();
      if (removed) {
        vscode.window.showInformationMessage("✅ Claude Code Hook 已移除");
        log("[Hooks] Claude Code hooks 已从 ~/.claude/settings.json 移除");
      } else {
        vscode.window.showInformationMessage("未找到需要移除的 Hook 配置。");
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Hook 卸载失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ── 导出 ──────────────────────────────────

  register("agentlog.openDashboard", () => {
    DashboardPanel.open(context, outputChannel);
  });

  register("agentlog.exportWeeklyReport", async () => {
    await exportInteractive("weekly-report", config);
  });

  register("agentlog.exportPrDescription", async () => {
    await exportInteractive("pr-description", config);
  });
}

// ─────────────────────────────────────────────
// 导出交互流程
// ─────────────────────────────────────────────

async function exportInteractive(
  format: ExportFormat,
  config: AgentLogConfig,
): Promise<void> {
  const currentConfig = readConfig();
  const language: ExportLanguage =
    (currentConfig as AgentLogConfig & { exportLanguage?: ExportLanguage })
      .exportLanguage ?? "zh";

  // 选择时间范围
  const rangeOptions = [
    { label: "本周", startDaysAgo: 7 },
    { label: "本月", startDaysAgo: 30 },
    { label: "最近 3 天", startDaysAgo: 3 },
    { label: "全部", startDaysAgo: 0 },
    { label: "自定义范围…", startDaysAgo: -1 },
  ];

  const picked = await vscode.window.showQuickPick(
    rangeOptions.map((o) => o.label),
    { placeHolder: "选择导出的时间范围" },
  );

  if (!picked) return;

  const rangeOpt = rangeOptions.find((o) => o.label === picked)!;

  let startDate: string | undefined;
  let endDate: string | undefined;

  if (rangeOpt.startDaysAgo > 0) {
    startDate = toDateStr(
      new Date(Date.now() - rangeOpt.startDaysAgo * 86_400_000).toISOString(),
    );
    endDate = toDateStr(new Date().toISOString());
  } else if (rangeOpt.startDaysAgo === -1) {
    // 自定义范围
    const start = await vscode.window.showInputBox({
      prompt: "起始日期（YYYY-MM-DD）",
      placeHolder: "例如：2024-01-01",
      validateInput: (v) =>
        /^\d{4}-\d{2}-\d{2}$/.test(v) ? undefined : "请输入 YYYY-MM-DD 格式",
    });
    if (!start) return;

    const end = await vscode.window.showInputBox({
      prompt: "截止日期（YYYY-MM-DD，含当天）",
      placeHolder: "例如：2024-01-31",
      value: toDateStr(new Date().toISOString()),
      validateInput: (v) =>
        /^\d{4}-\d{2}-\d{2}$/.test(v) ? undefined : "请输入 YYYY-MM-DD 格式",
    });
    if (!end) return;

    startDate = start;
    endDate = end;
  }

  // 执行导出
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "正在生成导出内容…",
      cancellable: false,
    },
    async () => {
      try {
        const client = getBackendClient();
        const workspacePath = resolveWorkspacePath();

        const result = await client.exportSessions({
          format,
          language,
          startDate,
          endDate,
          workspacePath,
        });

        if (result.sessionCount === 0) {
          vscode.window.showWarningMessage("指定时间范围内没有 AI 交互记录");
          return;
        }

        // 在编辑器中打开导出结果
        const langMap: Record<ExportFormat, string> = {
          "weekly-report": "markdown",
          "pr-description": "markdown",
          jsonl: "json",
          csv: "csv",
        };

        const doc = await vscode.workspace.openTextDocument({
          content: result.content,
          language: langMap[format] ?? "plaintext",
        });

        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

        vscode.window
          .showInformationMessage(
            `✅ 导出完成：共 ${result.sessionCount} 条记录`,
            "保存到文件",
            "复制到剪贴板",
          )
          .then(async (action) => {
            if (action === "复制到剪贴板") {
              await vscode.env.clipboard.writeText(result.content);
              vscode.window.showInformationMessage("✅ 已复制到剪贴板");
            } else if (action === "保存到文件") {
              const ext = {
                "weekly-report": "md",
                "pr-description": "md",
                jsonl: "jsonl",
                csv: "csv",
              }[format];
              const dateStr = toDateStr(new Date().toISOString()).replace(
                /-/g,
                "",
              );
              const defaultName = `agentlog_${format}_${dateStr}.${ext}`;
              const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(defaultName),
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
      } catch (err) {
        if (err instanceof BackendUnreachableError) {
          vscode.window
            .showErrorMessage("AgentLog 后台服务未启动，无法导出", "启动服务")
            .then((action) => {
              if (action === "启动服务") {
                vscode.commands.executeCommand("agentlog.startBackend");
              }
            });
        } else {
          vscode.window.showErrorMessage(
            `导出失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  );
}

// ─────────────────────────────────────────────
// TreeView 注册
// ─────────────────────────────────────────────

function registerTreeViews(): void {
  sessionTreeProvider = new SessionTreeProvider();
  commitBindingsProvider = new CommitBindingsTreeProvider();

  disposables.push(
    vscode.window.registerTreeDataProvider(
      "agentlog.sessionList",
      sessionTreeProvider,
    ),
    vscode.window.registerTreeDataProvider(
      "agentlog.commitBindings",
      commitBindingsProvider,
    ),
    sessionTreeProvider,
    commitBindingsProvider,
  );

  // 启动会话列表的定时刷新
  sessionTreeProvider.startAutoRefresh();
}

// ─────────────────────────────────────────────
// 配置变更监听
// ─────────────────────────────────────────────

function registerConfigWatcher(): void {
  disposables.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration("agentlog")) return;

      const newConfig = readConfig();
      log("[配置] 检测到 agentlog 配置变更，重新初始化模块…");

      // 重建 BackendClient（backendUrl 可能已变更）
      initBackendClient(newConfig);

      // 重启拦截器（debug 级别可能变更）
      if (interceptorManager) {
        interceptorManager.restart(newConfig.debug);
        if (newConfig.autoCapture) {
          interceptorManager.start();
        } else {
          interceptorManager.stop();
        }
      }

      // 刷新视图
      sessionTreeProvider?.refresh();
      commitBindingsProvider?.refresh();

      // 更新状态栏
      const health = await getBackendClient().ping(true);
      if (health.status === "ok") {
        updateStatusBar(newConfig.autoCapture ? "capturing" : "idle");
      } else {
        updateStatusBar("backend-offline");
      }

      log("[配置] 模块重新初始化完成");
    }),
  );
}

// ─────────────────────────────────────────────
// 插件激活入口
// ─────────────────────────────────────────────

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // 1. 初始化输出频道
  outputChannel = vscode.window.createOutputChannel("AgentLog");
  disposables.push(outputChannel);
  log("AgentLog 插件正在激活…");

  // 2. 读取配置
  const config = readConfig();

  // 3. 初始化 BackendClient
  initBackendClient(config);

  // 4. 初始化状态栏
  initStatusBar();

  // 5. 注册 TreeView
  registerTreeViews();

  // 6. 注册所有命令
  registerCommands(context, config);

  // 7. 监听配置变更
  registerConfigWatcher();

  // 8. 注册 @agentlog Chat Participant（通过 Copilot 模型捕获对话）
  //    放在 InterceptorManager 之前，避免拦截器初始化失败时阻断注册
  try {
    const chatParticipant = registerCopilotChatParticipant(outputChannel);
    disposables.push(chatParticipant);
    log("[激活] @agentlog Chat Participant 注册成功");
  } catch (err) {
    log(
      `[激活] Chat Participant 注册失败（VS Code 版本可能不支持 Chat API）：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 9. 启动拦截器
  try {
    interceptorManager = new InterceptorManager(outputChannel, config.debug);
    interceptorManager.onSessionReported(() => {
      sessionTreeProvider?.refresh();
      const count = sessionTreeProvider?.totalCount;
      updateStatusBar(config.autoCapture ? "capturing" : "idle", count);
    });

    if (config.autoCapture) {
      interceptorManager.start();
    }
  } catch (err) {
    log(
      `[激活] 拦截器初始化失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 10. 按需自动启动后台
  const autoStart = vscode.workspace
    .getConfiguration("agentlog")
    .get<boolean>("autoStartBackend", true);

  if (autoStart) {
    startBackendProcess(context, config).catch((err) => {
      log(
        `[激活] 后台自动启动失败：${err instanceof Error ? err.message : String(err)}`,
      );
    });
  } else {
    // 不自动启动，但检查是否已有运行中的后台
    getBackendClient()
      .ping(true)
      .then((health) => {
        if (health.status === "ok") {
          updateStatusBar(config.autoCapture ? "capturing" : "idle");
        } else {
          updateStatusBar("backend-offline");
        }
      })
      .catch(() => updateStatusBar("backend-offline"));
  }

  // 11. 将所有可 dispose 的资源交给 context 管理
  context.subscriptions.push(...disposables);

  log("AgentLog 插件激活完成");
}

// ─────────────────────────────────────────────
// 插件停用入口
// ─────────────────────────────────────────────

export function deactivate(): void {
  log("AgentLog 插件正在停用…");

  interceptorManager?.dispose();
  stopBackendProcess();
  destroyBackendClient();

  for (const d of disposables) {
    try {
      d.dispose();
    } catch {
      // 忽略 dispose 时的错误
    }
  }
  disposables.length = 0;

  log("AgentLog 插件已停用");
}

// ─────────────────────────────────────────────
// 工具函数（模块私有）
// ─────────────────────────────────────────────

function log(message: string): void {
  outputChannel?.appendLine(`[AgentLog] ${message}`);
}

function resolveWorkspacePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder.uri.fsPath;
  }
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

function toDateStr(iso: string): string {
  return iso.slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
