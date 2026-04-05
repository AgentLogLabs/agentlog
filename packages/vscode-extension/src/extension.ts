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
 *  5. 维护状态栏徽章（服务在线状态）
 *  6. 监听配置变更，热更新相关模块
 *
 * 注意：AI 交互数据通过 MCP Server（stdio）由 Agent 主动上报，
 *       不再使用 HTTP 拦截方式。
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type {
  AgentLogConfig,
  ContextFormat,
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
import {
  CommitBindingsTreeProvider,
  CommitGroupItem,
  CommitSessionItem,
  CommitTraceItem,
} from "./providers/sessionTreeProvider";
import {
  DashboardPanel,
} from "./providers/sessionWebviewProvider";
import {
  TraceTreeProvider,
  TraceItem,
} from "./providers/traceTreeProvider";
import {
  TracePanel,
} from "./providers/traceWebviewProvider";
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

/** 本地 MCP 服务子进程句柄 */
let mcpServerProcess: cp.ChildProcess | null = null;

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
    mcp: {
      clientConfigPath: cfg.get<string>("mcp.clientConfigPath") || undefined,
    },
    autoBindOnCommit:
      cfg.get<boolean>("autoBindOnCommit") ?? DEFAULT_CONFIG.autoBindOnCommit,
    retentionDays:
      cfg.get<number>("retentionDays") ?? DEFAULT_CONFIG.retentionDays,
    debug: cfg.get<boolean>("debug") ?? DEFAULT_CONFIG.debug,
    exportLanguage:
      cfg.get<ExportLanguage>("exportLanguage") ?? DEFAULT_CONFIG.exportLanguage,
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
  | "backend-offline"
  | "backend-starting";

function updateStatusBar(state: StatusBarState, count?: number): void {
  switch (state) {
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
    updateStatusBar("idle");
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
    updateStatusBar("idle");
    commitBindingsProvider?.refresh();
    traceTreeProvider?.refresh();
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
 * 启动 MCP 服务子进程
 */
async function startMcpServerProcess(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (mcpServerProcess && !mcpServerProcess.killed) {
    log("[MCP] 进程已在运行，跳过重启");
    return;
  }

  const isDevMode = context.extensionMode === vscode.ExtensionMode.Development;
  const mcpEntry = isDevMode
    ? path.join(context.extensionPath, "..", "backend", "src", "mcp.ts")
    : path.join(context.extensionPath, "dist", "backend", "mcp.js");

  if (isDevMode && !fs.existsSync(mcpEntry)) {
    log(`[MCP] 开发模式下未找到入口文件，跳过启动：${mcpEntry}`);
    return;
  }

  const command = isDevMode ? "npx" : "node";
  const args = isDevMode ? ["tsx", mcpEntry] : [mcpEntry];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // AGENTLOG_PORT / AGENTLOG_BACKEND_URL 由 mcp.ts 内部读取
  };

  log(`[MCP] 启动命令: ${command} ${args.join(" ")}`);

  mcpServerProcess = cp.spawn(command, args, {
    env,
    stdio: "pipe",
    detached: false,
  });

  mcpServerProcess.stdout?.on("data", (data: Buffer) => {
    log(`[MCP] ${data.toString().trimEnd()}`);
  });

  mcpServerProcess.stderr?.on("data", (data: Buffer) => {
    log(`[MCP][ERR] ${data.toString().trimEnd()}`);
  });

  mcpServerProcess.on("close", (code) => {
    log(`[MCP] 进程退出，退出码：${code}`);
    mcpServerProcess = null;
  });

  mcpServerProcess.on("error", (err) => {
    log(`[MCP] 进程启动失败：${err.message}`);
    mcpServerProcess = null;
    vscode.window.showErrorMessage(`AgentLog MCP 服务启动失败: ${err.message}`);
  });
}

/**
 * 停止 MCP 服务子进程
 */
function stopMcpServerProcess(): void {
  if (mcpServerProcess && !mcpServerProcess.killed) {
    mcpServerProcess.kill("SIGTERM");
    log("[MCP] 进程已停止");
    mcpServerProcess = null;
  }
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
// MCP 客户端自动配置
// ─────────────────────────────────────────────

/** 支持的 MCP 客户端定义 */
interface McpClientProfile {
  /** 客户端唯一标识（用于持久化记录） */
  id: string;
  /** 用户可见的客户端名称 */
  label: string;
  /** 配置文件路径（支持 ~ 展开） */
  configPath: string;
  /** 配置文件格式 */
  format:
    | "opencode"   // { mcpServers: { "agentlog-mcp": { command, args } } }
    | "mcpServers" // { mcpServers: { "agentlog-mcp": { command, args } } }
    | "cline"      // { mcpServers: { "agentlog-mcp": { command, args, disabled } } }
    | "qoder"      // { mcpServers: { "agentlog-mcp": { type, command, args } } }
    | "trae";      // { mcpServers: { "agentlog-mcp": { command: "node /path/to/mcp.js" } } }
  /** 客户端说明（显示在 QuickPick detail） */
  detail: string;
}

const MCP_CLIENT_PROFILES: McpClientProfile[] = [
  {
    id: "opencode",
    label: "OpenCode",
    configPath: "~/.config/opencode/opencode.json",
    format: "opencode",
    detail: "OpenCode CLI — ~/.config/opencode/opencode.json",
  },
  {
    id: "cursor",
    label: "Cursor",
    configPath: "~/.cursor/mcp.json",
    format: "mcpServers",
    detail: "Cursor IDE (全局) — ~/.cursor/mcp.json",
  },
  {
    id: "trae",
    label: "Trae",
    configPath:
      process.platform === "win32"
        ? path.join(os.homedir(), "AppData", "Roaming", "Trae", "User", "mcp.json")
        : path.join(os.homedir(), "Library", "Application Support", "Trae", "User", "mcp.json"),
    format: "trae",
    detail: "Trae IDE (全局) — ~/Library/Application Support/Trae/User/mcp.json",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    configPath:
      process.platform === "win32"
        ? path.join(
            process.env.APPDATA ?? os.homedir(),
            "Claude",
            "claude_desktop_config.json",
          )
        : "~/Library/Application Support/Claude/claude_desktop_config.json",
    format: "mcpServers",
    detail:
      process.platform === "win32"
        ? "Claude Desktop — %APPDATA%\\Claude\\claude_desktop_config.json"
        : "Claude Desktop — ~/Library/Application Support/Claude/claude_desktop_config.json",
  },
  {
    id: "cline",
    label: "Cline (VS Code 插件)",
    configPath:
      process.platform === "win32"
        ? path.join(
            process.env.APPDATA ?? os.homedir(),
            "Code",
            "User",
            "globalStorage",
            "saoudrizwan.claude-dev",
            "settings",
            "cline_mcp_settings.json",
          )
        : process.platform === "darwin"
          ? "~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"
          : "~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
    format: "cline",
    detail: "Cline VS Code 插件 — cline_mcp_settings.json",
  },
  {
    id: "qoder",
    label: "Qoder IDE",
    configPath:
      process.platform === "win32"
        ? path.join(
            process.env.APPDATA ?? os.homedir(),
            "Qoder",
            "SharedClientCache",
            "mcp.json",
          )
        : process.platform === "darwin"
          ? "~/Library/Application Support/Qoder/SharedClientCache/mcp.json"
          : "~/.config/Qoder/SharedClientCache/mcp.json",
    format: "qoder",
    detail:
      process.platform === "win32"
        ? "Qoder IDE — %APPDATA%\\Qoder\\SharedClientCache\\mcp.json"
        : process.platform === "darwin"
          ? "Qoder IDE — ~/Library/Application Support/Qoder/SharedClientCache/mcp.json"
          : "Qoder IDE — ~/.config/Qoder/SharedClientCache/mcp.json",
  },
];

/**
 * 将 ~ 开头的路径展开为绝对路径
 */
function resolveTilde(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * 将 agentlog-mcp 写入指定格式的 JSON 配置文件。
 * 若文件不存在，自动创建；若已存在，幂等更新。
 */
async function writeMcpEntryToConfig(
  configFilePath: string,
  format: McpClientProfile["format"],
  mcpCommand: string,
  mcpArgs: string[],
  backendUrl: string,
): Promise<void> {
  const dir = path.dirname(configFilePath);
  await fs.promises.mkdir(dir, { recursive: true });

  // 读取现有配置（不存在则用空对象）
  let configJson: Record<string, unknown> = {};
  if (fs.existsSync(configFilePath)) {
    const raw = await fs.promises.readFile(configFilePath, "utf-8");
    configJson = JSON.parse(raw);
  }

  if (format === "opencode") {
    // OpenCode uses { mcp: { "agentlog": { type, command, environment, enabled } }, plugin: [...] }
    if (!configJson.mcp || typeof configJson.mcp !== "object" || Array.isArray(configJson.mcp)) {
      configJson.mcp = {};
    }
    const servers = configJson.mcp as Record<string, unknown>;
    servers["agentlog"] = {
      type: "local",
      command: [mcpCommand, ...mcpArgs],
      environment: {
        AGENTLOG_GATEWAY_URL: backendUrl,
      },
      enabled: true,
    };
    // Add agentlog-auto plugin if not already present
    const pluginPath = path.join(os.homedir(), ".config", "opencode", "plugins", "agentlog-auto.js");
    const existingPlugin = configJson.plugin as string[] | undefined;
    if (!existingPlugin || !existingPlugin.some(p => p.includes("agentlog-auto"))) {
      configJson.plugin = [...(existingPlugin || []), pluginPath];
    }
  } else if (format === "mcpServers" || format === "cline") {
    // { mcpServers: { "agentlog-mcp": { command, args, ... } } }
    if (
      !configJson.mcpServers ||
      typeof configJson.mcpServers !== "object" ||
      Array.isArray(configJson.mcpServers)
    ) {
      configJson.mcpServers = {};
    }
    const servers = configJson.mcpServers as Record<string, unknown>;
    const entry: Record<string, unknown> = {
      command: mcpCommand,
      args: mcpArgs,
    };
    if (format === "cline") {
      entry.disabled = false;
    }
    servers["agentlog-mcp"] = entry;
  } else if (format === "qoder") {
    // { mcpServers: { "agentlog-mcp": { type, command, args } } }
    if (
      !configJson.mcpServers ||
      typeof configJson.mcpServers !== "object" ||
      Array.isArray(configJson.mcpServers)
    ) {
      configJson.mcpServers = {};
    }
    const servers = configJson.mcpServers as Record<string, unknown>;
    servers["agentlog-mcp"] = {
      type: "stdio",
      command: mcpCommand,
      args: mcpArgs,
    };
  } else if (format === "trae") {
    // { mcpServers: { "agentlog-mcp": { command: "node /path/to/mcp.js" } } }
    if (
      !configJson.mcpServers ||
      typeof configJson.mcpServers !== "object" ||
      Array.isArray(configJson.mcpServers)
    ) {
      configJson.mcpServers = {};
    }
    const servers = configJson.mcpServers as Record<string, unknown>;
    servers["agentlog-mcp"] = {
      command: `${mcpCommand} ${mcpArgs.join(" ")}`,
    };
  }

  await fs.promises.writeFile(
    configFilePath,
    JSON.stringify(configJson, null, 2),
    "utf-8",
  );
}

// AgentLog MCP 规则块的起止注释标记
const AGENTS_MD_RULE_START = "<!-- agentlog-mcp-rules-start -->";
const AGENTS_MD_RULE_END = "<!-- agentlog-mcp-rules-end -->";

type AgentClientType = "opencode" | "cline" | "qoder" | "other";

function buildAgentRulesBlock(clientType: AgentClientType = "other"): string {
  if (clientType === "opencode") {
    return `${AGENTS_MD_RULE_START}
## AgentLog 自动监听说明

你已接入 AgentLog MCP Server。由于 OpenCode 已安装 agentlog-auto 插件，**编码过程会被自动监听和记录**，无需手动调用 log_turn/log_intent。

插件会自动：
- 在每次用户消息、助手回复、工具调用时创建 trace
- 在任务完成后自动归档
- 绑定 Git commit 到会话

**正常对话即可，所有操作都会被自动记录。**

### Agent 接力（Handoff）

当用户发送「继续」「接力」「恢复」「接着做」等指令时，直接调用 \`query_traces()\` 即可获取当前活动的 Trace 详情。

**MCP 会自动从 \`.git/agentlog/sessions.json\` 读取当前 active 的 trace_id 并查询。**

\`query_traces()\`

${AGENTS_MD_RULE_END}`;
  }

  if (clientType === "cline") {
    return `${AGENTS_MD_RULE_START}
## AgentLog MCP 调用规则（必须遵守）

你已接入 AgentLog MCP Server，**必须在每个对话中按以下流程调用**，记录完整的编码交互过程。

---

## ⚠️ 核心原则：log_turn 必须在做任何其他操作之前调用

**错误做法（不要这样做）：**
❌ 收到用户消息 → 直接读取文件 → 直接编辑文件 → 然后才调用 log_turn
→ 这样在 log_turn 之前的操作都**不会被记录**

**正确做法（必须这样做）：**
✅ 收到用户消息 → **先调用 log_turn** → 再读取文件 → 再编辑文件 → 再调用 log_turn
→ 所有操作都被完整记录

---

## 调用流程

**第 1 步（最先）：收到用户消息后，立即调用 log_turn，不传 trace_id：**
\`log_turn(role="user", content="用户消息", model="模型名", workspace_path="工作目录")\`
→ 返回 JSON，提取 trace_id 并缓存

**第 2 步（每次工具执行后）：**
\`log_turn(trace_id="trace_id", role="tool", content="结果摘要", tool_name="edit", tool_input="filePath=...")\`

**第 3 步（每次回复后）：**
\`log_turn(trace_id="trace_id", role="assistant", content="回复内容")\`

**第 4 步（任务完成后）：**
\`log_intent(trace_id="trace_id", task="任务描述", model="模型名", affected_files=["file1.ts"])\`

---

## 强制约束

⚠️ **log_turn 必须在 read/edit/write/webfetch 等任何操作之前调用**
⚠️ **trace_id 丢失 = 每条消息创建独立 Trace（对话碎片化）**
⚠️ **跳过 log_turn = 那部分编码过程无法记录**
⚠️ **不调用 log_intent = 任务无法归档**

### Agent 接力（Handoff）

当用户发送「继续」「接力」「恢复」「接着做」等指令时，调用 \`query_traces()\` 即可获取当前活动的 Trace 详情。
${AGENTS_MD_RULE_END}`;
  }

  return `${AGENTS_MD_RULE_START}
## AgentLog MCP 调用规则（必须遵守）

你已接入 AgentLog MCP Server，**必须在每个对话中按以下流程调用**，记录完整的编码交互过程。

---

## ⚠️ 核心原则：log_turn 必须在做任何其他操作之前调用

**错误做法（不要这样做）：**
❌ 收到用户消息 → 直接读取文件 → 直接编辑文件 → 然后才调用 log_turn
→ 这样在 log_turn 之前的操作都**不会被记录**

**正确做法（必须这样做）：**
✅ 收到用户消息 → **先调用 log_turn** → 再读取文件 → 再编辑文件 → 再调用 log_turn
→ 所有操作都被完整记录

---

## 调用流程

**第 1 步（最先）：收到用户消息后，立即调用 log_turn，不传 trace_id：**
\`log_turn(role="user", content="用户消息", model="模型名", workspace_path="工作目录")\`
→ 返回 JSON，提取 trace_id 并缓存

**第 2 步（每次工具执行后）：**
\`log_turn(trace_id="trace_id", role="tool", content="结果摘要", tool_name="edit", tool_input="filePath=...")\`

**第 3 步（每次回复后）：**
\`log_turn(trace_id="trace_id", role="assistant", content="回复内容")\`

**第 4 步（任务完成后）：**
\`log_intent(trace_id="trace_id", task="任务描述", model="模型名", affected_files=["file1.ts"])\`

---

## 强制约束

⚠️ **log_turn 必须在 read/edit/write/webfetch 等任何操作之前调用**
⚠️ **trace_id 丢失 = 每条消息创建独立 Trace（对话碎片化）**
⚠️ **跳过 log_turn = 那部分编码过程无法记录**
⚠️ **不调用 log_intent = 任务无法归档**
${AGENTS_MD_RULE_END}`;
}

/**
 * 转义字符串中的正则特殊字符，用于构造 RegExp。
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 幂等地将 AgentLog MCP 调用规则写入 OpenCode 全局规则文件。
 *
 * - 若 ~/.config/opencode/AGENTS.md 不存在，自动创建。
 * - 若规则块已存在（由起止注释标记识别），则替换为最新版本。
 * - 若规则块不存在，追加到文件末尾。
 */
async function injectOpenCodeAgentRules(): Promise<void> {
  const agentsMdPath = path.join(
    os.homedir(),
    ".config",
    "opencode",
    "AGENTS.md",
  );

  log(`[MCP-CFG] 开始写入 OpenCode 规则文件: ${agentsMdPath}`);

  try {
    await fs.promises.mkdir(path.dirname(agentsMdPath), { recursive: true });
    log(`[MCP-CFG] 目录已创建/验证: ${path.dirname(agentsMdPath)}`);
  } catch (err) {
    log(`[MCP-CFG] 创建目录失败: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  let content = "";
  if (fs.existsSync(agentsMdPath)) {
    try {
      content = await fs.promises.readFile(agentsMdPath, "utf-8");
      log(`[MCP-CFG] 读取现有文件成功，长度: ${content.length} 字符`);
    } catch (err) {
      log(`[MCP-CFG] 读取现有文件失败: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  } else {
    log(`[MCP-CFG] 文件不存在，将创建新文件`);
  }

  const rulesBlock = buildAgentRulesBlock("opencode");
  log(`[MCP-CFG] 规则块大小: ${rulesBlock.length} 字符`);

  if (
    content.includes(AGENTS_MD_RULE_START) &&
    content.includes(AGENTS_MD_RULE_END)
  ) {
    // 替换已有规则块（支持跨行匹配）
    const pattern = new RegExp(
      `${escapeRegExp(AGENTS_MD_RULE_START)}[\\s\\S]*?${escapeRegExp(AGENTS_MD_RULE_END)}`,
    );
    content = content.replace(pattern, rulesBlock);
    log("[MCP-CFG] 已更新 OpenCode 全局 AGENTS.md 中的 AgentLog 规则块");
  } else {
    // 追加到末尾，保证前后各有一个空行
    const trimmed = content.trimEnd();
    content =
      trimmed.length > 0 ? `${trimmed}\n\n${rulesBlock}\n` : `${rulesBlock}\n`;
    log("[MCP-CFG] 已追加 AgentLog 规则块到 OpenCode 全局 AGENTS.md");
  }

  try {
    await fs.promises.writeFile(agentsMdPath, content, "utf-8");
    log(`[MCP-CFG] 文件写入成功: ${agentsMdPath}`);
  } catch (err) {
    log(`[MCP-CFG] 文件写入失败: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * 将 AgentLog MCP 规则块注入到 Qoder 项目级 AGENTS.md。
 * - 目标路径：${workspaceRoot}/AGENTS.md
 * - 若文件不存在，自动创建。
 * - 若规则块已存在（由起止注释标记识别），则替换为最新版本。
 * - 若规则块不存在，追加到文件末尾。
 */
async function injectQoderAgentRules(workspaceRoot: string): Promise<void> {
  const agentsMdPath = path.join(workspaceRoot, "AGENTS.md");

  log(`[MCP-CFG] 开始写入 Qoder 规则文件: ${agentsMdPath}`);

  try {
    await fs.promises.mkdir(path.dirname(agentsMdPath), { recursive: true });
    log(`[MCP-CFG] 目录已创建/验证: ${path.dirname(agentsMdPath)}`);
  } catch (err) {
    log(`[MCP-CFG] 创建目录失败: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  let content = "";
  if (fs.existsSync(agentsMdPath)) {
    try {
      content = await fs.promises.readFile(agentsMdPath, "utf-8");
      log(`[MCP-CFG] 读取现有文件成功，长度: ${content.length} 字符`);
    } catch (err) {
      log(`[MCP-CFG] 读取现有文件失败: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  } else {
    log("[MCP-CFG] 文件不存在，将创建新文件");
  }

  const rulesBlock = buildAgentRulesBlock("qoder");
  log(`[MCP-CFG] 规则块大小: ${rulesBlock.length} 字符`);

  if (
    content.includes(AGENTS_MD_RULE_START) &&
    content.includes(AGENTS_MD_RULE_END)
  ) {
    const pattern = new RegExp(
      `${escapeRegExp(AGENTS_MD_RULE_START)}[\\s\\S]*?${escapeRegExp(AGENTS_MD_RULE_END)}`,
    );
    content = content.replace(pattern, rulesBlock);
    log("[MCP-CFG] 已更新 Qoder 项目 AGENTS.md 中的 AgentLog 规则块");
  } else {
    const trimmed = content.trimEnd();
    content =
      trimmed.length > 0 ? `${trimmed}\n\n${rulesBlock}\n` : `${rulesBlock}\n`;
    log("[MCP-CFG] 已追加 AgentLog 规则块到 Qoder 项目 AGENTS.md");
  }

  try {
    await fs.promises.writeFile(agentsMdPath, content, "utf-8");
    log(`[MCP-CFG] 文件写入成功: ${agentsMdPath}`);
  } catch (err) {
    log(`[MCP-CFG] 文件写入失败: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * 将 AgentLog MCP 调用规则写入 Cline 全局规则目录。
 * - 目标路径：~/Documents/Cline/Rules/agentlog.md（macOS）
 * - 若文件已存在，替换规则块；否则创建新文件。
 */
async function injectClineAgentRules(): Promise<string> {
  const rulesDir = path.join(os.homedir(), "Documents", "Cline", "Rules");
  const rulesPath = path.join(rulesDir, "agentlog.md");

  log(`[MCP-CFG] 开始写入 Cline 规则文件: ${rulesPath}`);

  try {
    await fs.promises.mkdir(rulesDir, { recursive: true });
  } catch (err) {
    log(`[MCP-CFG] 创建目录失败: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  let content = "";
  if (fs.existsSync(rulesPath)) {
    try {
      content = await fs.promises.readFile(rulesPath, "utf-8");
    } catch (err) {
      log(`[MCP-CFG] 读取现有文件失败: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  const rulesBlock = buildAgentRulesBlock("cline");

  if (content.includes(AGENTS_MD_RULE_START) && content.includes(AGENTS_MD_RULE_END)) {
    const pattern = new RegExp(
      `${escapeRegExp(AGENTS_MD_RULE_START)}[\\s\\S]*?${escapeRegExp(AGENTS_MD_RULE_END)}`,
    );
    content = content.replace(pattern, rulesBlock);
    log("[MCP-CFG] 已更新 Cline 规则文件中的 AgentLog 规则块");
  } else {
    const trimmed = content.trimEnd();
    content = trimmed.length > 0 ? `${trimmed}\n\n${rulesBlock}\n` : `${rulesBlock}\n`;
    log("[MCP-CFG] 已写入 AgentLog 规则块到 Cline 规则文件");
  }

  try {
    await fs.promises.writeFile(rulesPath, content, "utf-8");
    log(`[MCP-CFG] 文件写入成功: ${rulesPath}`);
  } catch (err) {
    log(`[MCP-CFG] 文件写入失败: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  return rulesPath;
}

/**
 * 将 agentlog-auto 插件安装到用户 OpenCode 插件目录。
 * - 源路径：extension/dist/opencode-plugins/agentlog-auto/index.js
 * - 目标路径：~/.config/opencode/plugins/agentlog-auto.js
 * - 若目标已存在，替换旧版本（幂等操作）
 */
async function installOpenCodePlugin(context: vscode.ExtensionContext): Promise<void> {
  const isDevMode = context.extensionMode === vscode.ExtensionMode.Development;
  const srcPluginPath = isDevMode
    ? path.join(context.extensionPath, "src", "opencode-plugins", "agentlog-auto", "index.js")
    : path.join(context.extensionPath, "dist", "opencode-plugins", "agentlog-auto", "index.js");
  const dstPluginPath = path.join(os.homedir(), ".config", "opencode", "plugins", "agentlog-auto.js");

  log(`[MCP-CFG] 安装 OpenCode 插件: ${srcPluginPath} -> ${dstPluginPath}`);

  const dstPluginDir = path.dirname(dstPluginPath);
  try {
    await fs.promises.mkdir(dstPluginDir, { recursive: true });
  } catch (err) {
    log(`[MCP-CFG] 创建插件目录失败: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  if (!fs.existsSync(srcPluginPath)) {
    throw new Error(`插件源文件不存在: ${srcPluginPath}`);
  }

  await fs.promises.copyFile(srcPluginPath, dstPluginPath);
  log(`[MCP-CFG] 插件已复制到: ${dstPluginPath}`);
}

/**
 * QuickPick 向导：引导用户选择 AI 客户端并自动完成 MCP 配置注册。
 */
async function configureMcpClient(
  context: vscode.ExtensionContext,
): Promise<void> {
  const isDevMode = context.extensionMode === vscode.ExtensionMode.Development;
  const mcpEntry = path.join(context.extensionPath, "dist", "backend", "mcp.js");
  const mcpCommand = "node";
  const mcpArgs = [mcpEntry];

  // 读取已配置的客户端列表
  const vsConfig = vscode.workspace.getConfiguration("agentlog");
  const configuredClients: string[] = vsConfig.get("mcp.configuredClients", []);
  const backendUrl: string = vsConfig.get<string>("backendUrl") ?? "http://localhost:7892";

  // 构建 QuickPick 条目
  const items: (vscode.QuickPickItem & { profile?: McpClientProfile; isCustom?: boolean })[] = [
    ...MCP_CLIENT_PROFILES.map((p) => {
      const isConfigured = configuredClients.includes(p.id);
      return {
        label: `$(${isConfigured ? "check" : "plug"}) ${p.label}`,
        description: isConfigured ? "已配置" : "",
        detail: p.detail,
        profile: p,
      };
    }),
    {
      label: "$(folder-opened) 手动选择配置文件…",
      description: "",
      detail: "浏览文件系统，选择任意 MCP 客户端的 JSON 配置文件",
      isCustom: true,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: "AgentLog — 配置 AI Agent MCP 接入",
    placeHolder: "选择您当前使用的 AI 编码客户端",
    matchOnDetail: true,
  });

  if (!picked) return;

  let targetPath: string;
  let format: McpClientProfile["format"] = "mcpServers";

  if (picked.isCustom) {
    // 用户手动选择文件
    const uris = await vscode.window.showOpenDialog({
      title: "选择 MCP 客户端配置文件",
      filters: { "JSON 配置文件": ["json"] },
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
    });
    if (!uris || uris.length === 0) return;
    targetPath = uris[0].fsPath;

    // 根据路径尝试自动推断格式
    const basename = path.basename(targetPath).toLowerCase();
    if (basename.includes("opencode") || targetPath.includes("opencode")) {
      format = "opencode";
    } else if (basename.includes("cline")) {
      format = "cline";
    } else if (basename.includes("qoder")) {
      format = "qoder";
    } else {
      format = "mcpServers";
    }
  } else if (picked.profile) {
    targetPath = resolveTilde(picked.profile.configPath);
    format = picked.profile.format;
  } else {
    return;
  }

  try {
    await writeMcpEntryToConfig(targetPath, format, mcpCommand, mcpArgs, backendUrl);
    log(`[MCP-CFG] 已写入配置文件: ${targetPath}`);

    // OpenCode 专项：额外写入全局 AGENTS.md 调用规则并安装 auto 插件
    const isOpenCode = picked.profile?.id === "opencode" ||
      (!picked.profile && (targetPath.includes("opencode")));
    const opencodeAgentsMdPath = path.join(os.homedir(), ".config", "opencode", "AGENTS.md");
    if (isOpenCode) {
      await injectOpenCodeAgentRules();
      await installOpenCodePlugin(context);
    }

    // Qoder 专项：额外写入项目级 AGENTS.md 调用规则
    const isQoder = picked.profile?.id === "qoder" ||
      (!picked.profile && (targetPath.includes("qoder")));
    let qoderAgentsMdPath = "";
    if (isQoder) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        qoderAgentsMdPath = path.join(workspaceRoot, "AGENTS.md");
        await injectQoderAgentRules(workspaceRoot);
      }
    }

    // Cline 专项：将调用规则写入 ~/Documents/Cline/Rules/agentlog.md
    const isCline = picked.profile?.id === "cline" ||
      (!picked.profile && (targetPath.includes("cline")));
    let clineRulesPath = "";
    if (isCline) {
      clineRulesPath = await injectClineAgentRules();
    }

    // 记录已配置的客户端 ID
    if (picked.profile) {
      const newConfigured = Array.from(
        new Set([...configuredClients, picked.profile.id]),
      );
      await vsConfig.update(
        "mcp.configuredClients",
        newConfigured,
        vscode.ConfigurationTarget.Global,
      );
    }

    const clientName = picked.profile?.label ?? path.basename(targetPath);

    // 根据客户端类型定制成功提示
    let message: string;
    const actions: string[] = ["查看配置文件"];
    if (isOpenCode) {
      message = `AgentLog MCP 已配置到 ${clientName}，Auto 插件已安装，调用规则已写入 AGENTS.md，请重启 OpenCode 生效。`;
      actions.push("查看 AGENTS.md");
    } else if (isQoder) {
      message = `AgentLog MCP 已配置到 ${clientName}，调用规则已写入项目 AGENTS.md，请重启 Qoder 生效。`;
      actions.push("查看 AGENTS.md");
    } else if (isCline) {
      message = `AgentLog MCP 已配置到 ${clientName}，调用规则已写入 Cline Rules，请重启 Cline 生效。`;
      actions.push("查看 MCP 规则");
    } else {
      message = `AgentLog MCP 已成功注册到 ${clientName}，请重启该 AI 客户端使配置生效。`;
    }

    const action = await vscode.window.showInformationMessage(message, ...actions);

    if (action === "查看配置文件") {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
      await vscode.window.showTextDocument(doc);
    } else if (action === "查看 AGENTS.md") {
      const agentsPath = isOpenCode ? opencodeAgentsMdPath : qoderAgentsMdPath;
      if (agentsPath) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(agentsPath));
        await vscode.window.showTextDocument(doc);
      }
    } else if (action === "查看 MCP 规则" && clineRulesPath) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(clineRulesPath));
      await vscode.window.showTextDocument(doc);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[MCP-CFG] 写入配置文件失败: ${msg}`);
    vscode.window.showErrorMessage(`AgentLog MCP 配置失败: ${msg}`);
  }
}



/**
 * 验证当前 MCP 配置状态，检查 OpenCode 规则文件和后端连接。
 * 用于诊断为什么 AI Agent 回复未记录到后台。
 */
async function verifyMcpConnection(): Promise<void> {
  const results: string[] = [];
  const errors: string[] = [];
  
  log("[MCP-VERIFY] 开始验证 MCP 配置连接");

  // 1. 检查后端连接
  results.push("1. 检查 AgentLog 后端服务...");
  try {
    const client = getBackendClient();
    const health = await client.ping(true);
    if (health.status === "ok") {
      results.push("   ✓ 后端服务正常运行");
    } else {
      errors.push(`   后端服务不可达`);
      results.push("   ✗ 后端服务不可达");
    }
  } catch (err) {
    errors.push(`   后端连接失败: ${err instanceof Error ? err.message : String(err)}`);
    results.push("   ✗ 后端连接失败");
  }

  // 2. 检查 OpenCode MCP 配置文件
  results.push("2. 检查 OpenCode MCP 配置文件...");
  const opencodeConfigPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
  if (fs.existsSync(opencodeConfigPath)) {
    try {
      const configContent = await fs.promises.readFile(opencodeConfigPath, "utf-8");
      const config = JSON.parse(configContent);
      
      if (config.mcp?.["agentlog"]) {
        results.push("   ✓ OpenCode opencode.json 包含 agentlog 条目");
        const entry = config.mcp["agentlog"];
        results.push(`     类型: ${entry.type || "unknown"}, 启用: ${entry.enabled !== false ? "是" : "否"}`);
        if (entry.command) {
          results.push(`     命令: ${JSON.stringify(entry.command)}`);
        }
      } else {
        errors.push(`   OpenCode opencode.json 缺少 agentlog 条目`);
        results.push("   ✗ 缺少 agentlog 条目");
      }
    } catch (err) {
      errors.push(`   读取 OpenCode 配置文件失败: ${err instanceof Error ? err.message : String(err)}`);
      results.push("   ✗ 配置文件读取失败");
    }
  } else {
    errors.push(`   OpenCode 配置文件不存在: ${opencodeConfigPath}`);
    results.push("   ✗ 配置文件不存在");
  }

  // 3. 检查 AGENTS.md 规则文件
  results.push("3. 检查 OpenCode AGENTS.md 规则文件...");
  const agentsMdPath = path.join(os.homedir(), ".config", "opencode", "AGENTS.md");
  if (fs.existsSync(agentsMdPath)) {
    try {
      const content = await fs.promises.readFile(agentsMdPath, "utf-8");
      
      if (content.includes(AGENTS_MD_RULE_START) && content.includes(AGENTS_MD_RULE_END)) {
        results.push("   ✓ AGENTS.md 包含 AgentLog 规则块");
        
        // 检查规则块是否完整
        const pattern = new RegExp(
          `${escapeRegExp(AGENTS_MD_RULE_START)}[\\s\\S]*?${escapeRegExp(AGENTS_MD_RULE_END)}`,
        );
        const match = content.match(pattern);
        if (match && match[0].length > 100) {
          results.push(`   ✓ 规则块完整 (${match[0].length} 字符)`);
        } else {
          errors.push(`   AGENTS.md 规则块可能不完整`);
          results.push("   ✗ 规则块可能不完整");
        }
      } else {
        errors.push(`   AGENTS.md 缺少 AgentLog 规则块标记`);
        results.push("   ✗ 缺少规则块标记");
      }
    } catch (err) {
      errors.push(`   读取 AGENTS.md 失败: ${err instanceof Error ? err.message : String(err)}`);
      results.push("   ✗ 文件读取失败");
    }
  } else {
    errors.push(`   AGENTS.md 文件不存在: ${agentsMdPath}`);
    results.push("   ✗ 文件不存在");
  }

  // 4. 检查 VS Code 配置
  results.push("4. 检查 VS Code 插件配置...");
  const vsConfig = vscode.workspace.getConfiguration("agentlog");
  const configuredClients: string[] = vsConfig.get("mcp.configuredClients", []);
  if (configuredClients.includes("opencode")) {
    results.push("   ✓ 插件已记录 OpenCode 为已配置客户端");
  } else {
    results.push("   ⚠  OpenCode 未在插件配置中标记为已配置（不影响功能）");
  }

  // 总结报告
  log("[MCP-VERIFY] 验证完成");
  
  const summary = results.join("\n");
  const errorCount = errors.length;
  
  if (errorCount === 0) {
    vscode.window.showInformationMessage(
      "✅ AgentLog MCP 配置验证通过",
      "查看详细报告",
    ).then((choice) => {
      if (choice === "查看详细报告") {
        const panel = vscode.window.createWebviewPanel(
          "agentlog-mcp-verify",
          "AgentLog MCP 配置验证报告",
          vscode.ViewColumn.One,
          { enableScripts: false },
        );
        panel.webview.html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; }
    .success { color: var(--vscode-editorInfo-foreground); }
    .error { color: var(--vscode-editorError-foreground); }
    .warning { color: var(--vscode-editorWarning-foreground); }
    pre { background: var(--vscode-textBlockQuote-background); padding: 10px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>✅ AgentLog MCP 配置验证通过</h1>
  <p>所有配置项检查正常，OpenCode 应能正确记录 AI 交互。</p>
  <h2>详细报告</h2>
  <pre>${summary.replace(/✓/g, '<span class="success">✓</span>')
            .replace(/✗/g, '<span class="error">✗</span>')
            .replace(/⚠/g, '<span class="warning">⚠</span>')}</pre>
  <h2>下一步</h2>
  <ul>
    <li>重启 OpenCode 使配置生效</li>
    <li>在 OpenCode 中执行一次代码修改任务，查看 AgentLog 后台是否完整记录</li>
    <li>如有问题，执行 <code>AgentLog: 配置 AI Agent MCP 接入</code> 重新配置</li>
  </ul>
</body>
</html>`;
      }
    });
  } else {
    const errorDetails = errors.join("\n");
    vscode.window.showErrorMessage(
      `❌ AgentLog MCP 配置发现 ${errorCount} 个问题`,
      "查看详细报告",
      "重新配置 MCP",
    ).then((choice) => {
      if (choice === "查看详细报告") {
        const panel = vscode.window.createWebviewPanel(
          "agentlog-mcp-verify",
          "AgentLog MCP 配置验证报告",
          vscode.ViewColumn.One,
          { enableScripts: false },
        );
        panel.webview.html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; }
    .success { color: var(--vscode-editorInfo-foreground); }
    .error { color: var(--vscode-editorError-foreground); }
    .warning { color: var(--vscode-editorWarning-foreground); }
    pre { background: var(--vscode-textBlockQuote-background); padding: 10px; border-radius: 4px; }
    .errors { background: var(--vscode-inputValidation-errorBackground); padding: 10px; border-radius: 4px; margin-top: 20px; }
  </style>
</head>
<body>
  <h1>❌ AgentLog MCP 配置发现问题</h1>
  <p>发现 ${errorCount} 个配置问题，可能导致 AI Agent 回复未记录到后台。</p>
  
  <div class="errors">
    <h3>问题列表</h3>
    <pre>${errorDetails}</pre>
  </div>
  
  <h2>详细检查报告</h2>
  <pre>${summary.replace(/✓/g, '<span class="success">✓</span>')
            .replace(/✗/g, '<span class="error">✗</span>')
            .replace(/⚠/g, '<span class="warning">⚠</span>')}</pre>
  
  <h2>解决方案</h2>
  <ul>
    <li>点击"重新配置 MCP"按钮修复配置问题</li>
    <li>确保 OpenCode 已重启使配置生效</li>
    <li>检查 ~/.config/opencode/ 目录权限</li>
    <li>确保 AgentLog 后端服务正在运行 (端口 7892)</li>
  </ul>
</body>
</html>`;
      } else if (choice === "重新配置 MCP") {
        vscode.commands.executeCommand("agentlog.configureMcpClient");
      }
    });
  }
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
        updateStatusBar("idle");

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

  // ── 会话管理 ──────────────────────────────
  // Session 视图已废弃（2026-04-04），迁移到 Trace 视图
  // 以下命令已禁用

  // register("agentlog.refreshSessionList", () => {
  //   sessionTreeProvider.refresh();
  //   commitBindingsProvider.refresh();
  // });

  // register("agentlog.loadMoreSessions", async (page: unknown) => {
  //   const pageNum = typeof page === "number" ? page : 2;
  //   await sessionTreeProvider.loadPage(pageNum);
  // });

  // Session 视图已废弃，viewSessionDetail 命令已禁用
  // register("agentlog.viewSessionDetail", async (sessionOrId: unknown) => {
  //   ...
  // });

  // ── Trace 列表刷新 ─────────────────────────
  register("agentlog.refreshTraceList", async () => {
    traceTreeProvider.refresh();
    commitBindingsProvider?.refresh();
  });

  // Session 视图已废弃，删除会话功能已禁用
  // register("agentlog.deleteSession", async (item: unknown) => {
  //   let sessionId: string | undefined;
  //   if (item instanceof SessionItem) {
  //     sessionId = item.session.id;
  //   }
  //   if (!sessionId) {
  //     vscode.window.showErrorMessage("无法解析要删除的会话 ID");
  //     return;
  //   }
  //   const confirm = await vscode.window.showWarningMessage(
  //     "确定要删除此会话记录吗？此操作不可撤销。",
  //     { modal: true },
  //     "确认删除",
  //   );
  //   if (confirm !== "确认删除") return;
  //   try {
  //     const client = getBackendClient();
  //     await client.deleteSession(sessionId);
  //     vscode.window.showInformationMessage("✅ 会话记录已删除");
  //   } catch (err) {
  //     vscode.window.showErrorMessage(
  //       `删除失败：${err instanceof Error ? err.message : String(err)}`,
  //     );
  //   }
  // });

  // ── 上下文复活（Resume Context）──────────

  register("agentlog.resumeContext", async (item: unknown) => {
    let traceId: string | undefined;

    if (item instanceof TraceItem) {
      traceId = item.trace.id;
    } else if (item instanceof CommitSessionItem) {
      // CommitSessionItem has traceId via session, but for now we handle trace
      traceId = (item as unknown as { traceId?: string }).traceId;
    } else if (
      typeof item === "object" &&
      item !== null &&
      "id" in item &&
      typeof (item as { id: unknown }).id === "string"
    ) {
      traceId = (item as { id: string }).id;
    } else if (typeof item === "string") {
      traceId = item;
    }

    if (!traceId) {
      traceId = await vscode.window.showInputBox({
        prompt: "请输入要复活上下文的 Trace ID",
        placeHolder: "ULID（例如：01ARZ3NDEKTSV4RRFFQ69G5FAV）",
      });
      if (!traceId) return;
    }

    // 2. 从后台获取完整 Trace 数据
    try {
      const client = getBackendClient();
      const trace = await client.getTrace(traceId) as { taskGoal: string; status: string };
      const spans = (await client.getTraceSpans(traceId)) as Array<{ payload: Record<string, unknown> }>;

      // 3. 组装上下文 Prompt
      const parts: string[] = [];

      parts.push("【历史 AI 上下文复活 — Resume Context】");
      parts.push("");
      parts.push(`## 任务目标 (Task Goal)`);
      parts.push(trace.taskGoal);
      parts.push("");

      if (spans && spans.length > 0) {
        parts.push(`## 逐轮执行记录 (Spans)`);
        for (const span of spans) {
          const payload = span.payload;
          const role = (payload.role as string) || "unknown";
          const content = (payload.content as string) || "";
          const reasoning = (payload.reasoning as string) || "";
          const toolName = payload.toolName as string | undefined;
          
          const roleLabel = role === "user" ? "User" : role === "assistant" ? "Assistant" : `Tool(${toolName ?? "unknown"})`;
          parts.push(`### ${roleLabel}`);
          if (content) parts.push(content);
          if (reasoning) {
            parts.push("");
            parts.push("**推理过程:**");
            parts.push(reasoning);
          }
          parts.push("");
        }
      }

      parts.push("---");
      parts.push("请基于以上历史上下文继续工作。");

      const contextText = parts.join("\n");

      // 4. 写入系统剪贴板
      await vscode.env.clipboard.writeText(contextText);

      // 5. 弹出 Toast 提示
      const promptPreview = trace.taskGoal.replace(/\n/g, " ").slice(0, 40);
      vscode.window.showInformationMessage(
        `上下文已复制到剪贴板，请粘贴到 Cline / Cursor / Copilot 的聊天框中继续工作。\nTrace：${promptPreview}${trace.taskGoal.length > 40 ? "…" : ""}`,
      );

      log(
        `[resumeContext] 已将该 Trace ${traceId} 的上下文复制到剪贴板（${contextText.length} 字符）`,
      );
    } catch (err) {
      if (err instanceof BackendUnreachableError) {
        vscode.window
          .showErrorMessage(
            "AgentLog 后台服务未启动，无法复活上下文",
            "启动服务",
          )
          .then((action) => {
            if (action === "启动服务") {
              vscode.commands.executeCommand("agentlog.startBackend");
            }
          });
      } else {
        vscode.window.showErrorMessage(
          `复活上下文失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });

  // ── Commit 绑定 ───────────────────────────

  register("agentlog.bindCommit", async (item: unknown) => {
    let traceId: string | undefined;

    if (item instanceof TraceItem) {
      traceId = item.trace.id;
    }

    if (!traceId) {
      // 若无上下文，弹出输入框
      traceId = await vscode.window.showInputBox({
        prompt: "请输入要绑定的 Trace ID",
        placeHolder: "ULID（例如：01ARZ3NDEKTSV4RRFFQ69G5FAV）",
      });
      if (!traceId) return;
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
      await client.bindTracesToCommit([traceId], commitHash.trim(), workspacePath);

      commitBindingsProvider.refresh();

      vscode.window.showInformationMessage(
        `✅ 已将 Trace 绑定到 Commit ${commitHash.slice(0, 8)}`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `绑定失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  register("agentlog.unbindCommit", async (item: unknown) => {
    let traceId: string | undefined;

    if (item instanceof TraceItem) {
      traceId = item.trace.id;
    }

    if (!traceId) {
      vscode.window.showErrorMessage("无法解析要解除绑定的 Trace ID");
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `确定要解除此 Trace 的所有 Commit 绑定吗？`,
      { modal: true },
      "确认解除",
    );

    if (confirm !== "确认解除") return;

    try {
      const client = getBackendClient();
      await client.unbindSession(traceId);
      commitBindingsProvider.refresh();
      vscode.window.showInformationMessage("✅ 已解除所有 Commit 绑定");
    } catch (err) {
      vscode.window.showErrorMessage(
        `解除绑定失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  register("agentlog.unbindTraceFromCommit", async (item: unknown) => {
    if (!(item instanceof CommitTraceItem)) {
      vscode.window.showErrorMessage("请在 Commit 列表中右键点击 Trace 条目使用此功能");
      return;
    }

    const { trace, commitHash } = item;
    const confirm = await vscode.window.showWarningMessage(
      `确定要将 Trace "${trace.taskGoal.slice(0, 40)}" 从 Commit ${commitHash.slice(0, 8)} 解绑吗？`,
      { modal: true },
      "确认解绑",
    );
    if (confirm !== "确认解绑") return;

    try {
      const client = getBackendClient();
      await client.unbindTraceFromCommit(trace.id, commitHash);
      commitBindingsProvider.refresh();
      vscode.window.showInformationMessage(
        `✅ 已将 Trace 从 Commit ${commitHash.slice(0, 8)} 解绑`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `解绑失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ── MCP 客户端配置 ──────────────────────────

  register("agentlog.configureMcpClient", async () => {
    await configureMcpClient(context);
  });

  register("agentlog.verifyMcpConnection", async () => {
    await verifyMcpConnection();
  });

  register("agentlog.openGitHub", async () => {
    await vscode.env.openExternal(
      vscode.Uri.parse("https://github.com/AgentLogLabs/agentlog/issues"),
    );
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
        `Git 钩子已安装（仓库：${result.repoRootPath}，分支：${result.currentBranch}）。支持多 worktree：同仓库下的所有 worktree 提交均会自动绑定到正确的会话。`,
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

  // ── Trace 面板 ────────────────────────────

  register("agentlog.openTracePanel", () => {
    TracePanel.createOrShow(context.extensionUri);
  });

  register("agentlog.refreshTraceTree", () => {
    traceTreeProvider?.refresh();
  });

  register("agentlog.refreshCommitBindings", () => {
    commitBindingsProvider?.refresh();
  });

  register("agentlog.exportWeeklyReport", async () => {
    await exportInteractive("weekly-report", config);
  });

  register("agentlog.exportPrDescription", async () => {
    await exportInteractive("pr-description", config);
  });

  // ── Commit 上下文 & 解释 ──────────────────

  register("agentlog.generateCommitContext", async (item: unknown) => {
    // 1. 解析 commitHash — 可能来自 TreeView 右键菜单，也可能手动输入
    let commitHash: string | undefined;

    if (item instanceof CommitGroupItem) {
      commitHash = item.commitHash;
    }

    if (!commitHash) {
      commitHash = await vscode.window.showInputBox({
        prompt: "请输入 Git Commit Hash",
        placeHolder: "完整或短 SHA（例如：abc1234）",
        validateInput: (v) =>
          v.trim().length < 4 ? "Commit Hash 至少需要 4 位" : undefined,
      });
    }

    if (!commitHash) return;
    commitHash = commitHash.trim();

    // 2. 选择输出格式
    const formatOptions: Array<{
      label: string;
      value: ContextFormat;
      description: string;
    }> = [
      {
        label: "Markdown",
        value: "markdown",
        description: "适合直接粘贴到 AI 对话或文档中",
      },
      {
        label: "JSON",
        value: "json",
        description: "结构化 JSON，适合程序处理",
      },
      {
        label: "XML",
        value: "xml",
        description: "XML 格式，适合作为 AI 上下文标签",
      },
    ];

    const pickedFormat = await vscode.window.showQuickPick(formatOptions, {
      placeHolder: "选择上下文文档的输出格式",
    });
    if (!pickedFormat) return;

    // 3. 读取语言配置
    const currentConfig = readConfig();
    const language: ExportLanguage = currentConfig.exportLanguage ?? "zh";

    // 4. 调用后台生成
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "正在生成 Commit 上下文文档…",
        cancellable: false,
      },
      async () => {
        try {
          const client = getBackendClient();
          const workspacePath = resolveWorkspacePath();

          const result = await client.generateCommitContext(
            commitHash!,
            workspacePath,
            {
              format: pickedFormat.value,
              language,
            },
          );

          if (result.sessionCount === 0) {
            vscode.window.showWarningMessage(
              `Commit ${commitHash!.slice(0, 8)} 没有关联的 AI 交互记录`,
            );
            return;
          }

          // 在编辑器中打开结果
          const langMap: Record<ContextFormat, string> = {
            markdown: "markdown",
            json: "json",
            xml: "xml",
          };

          const doc = await vscode.workspace.openTextDocument({
            content: result.content,
            language: langMap[pickedFormat.value] ?? "plaintext",
          });

          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

          vscode.window
            .showInformationMessage(
              `✅ 上下文文档已生成：Commit ${commitHash!.slice(0, 8)}，包含 ${result.sessionCount} 条 AI 会话`,
              "复制到剪贴板",
              "保存到文件",
            )
            .then(async (action) => {
              if (action === "复制到剪贴板") {
                await vscode.env.clipboard.writeText(result.content);
                vscode.window.showInformationMessage("✅ 已复制到剪贴板");
              } else if (action === "保存到文件") {
                const ext =
                  pickedFormat.value === "markdown"
                    ? "md"
                    : pickedFormat.value === "json"
                      ? "json"
                      : "xml";
                const defaultName = `agentlog_context_${commitHash!.slice(0, 8)}.${ext}`;
                const uri = await vscode.window.showSaveDialog({
                  defaultUri: vscode.Uri.file(defaultName),
                  filters: { 上下文文档: [ext] },
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
              .showErrorMessage(
                "AgentLog 后台服务未启动，无法生成上下文",
                "启动服务",
              )
              .then((action) => {
                if (action === "启动服务") {
                  vscode.commands.executeCommand("agentlog.startBackend");
                }
              });
          } else {
            vscode.window.showErrorMessage(
              `生成上下文失败：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      },
    );
  });

  register("agentlog.generateCommitExplain", async (item: unknown) => {
    // 1. 解析 commitHash
    let commitHash: string | undefined;

    if (item instanceof CommitGroupItem) {
      commitHash = item.commitHash;
    }

    if (!commitHash) {
      commitHash = await vscode.window.showInputBox({
        prompt: "请输入 Git Commit Hash",
        placeHolder: "完整或短 SHA（例如：abc1234）",
        validateInput: (v) =>
          v.trim().length < 4 ? "Commit Hash 至少需要 4 位" : undefined,
      });
    }

    if (!commitHash) return;
    commitHash = commitHash.trim();

    // 2. 读取语言配置
    const currentConfig = readConfig();
    const language: ExportLanguage = currentConfig.exportLanguage ?? "zh";

    // 3. 调用后台生成
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "正在生成 Commit AI 交互解释…",
        cancellable: false,
      },
      async () => {
        try {
          const client = getBackendClient();
          const workspacePath = resolveWorkspacePath();

          const result = await client.generateCommitExplain(
            commitHash!,
            workspacePath,
            language,
          );

          if (result.sessions.length === 0) {
            vscode.window.showWarningMessage(
              `Commit ${commitHash!.slice(0, 8)} 没有关联的 AI 交互记录`,
            );
            return;
          }

          // 在编辑器中打开结果（解释始终为 Markdown）
          const doc = await vscode.workspace.openTextDocument({
            content: result.content,
            language: "markdown",
          });

          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

          vscode.window
            .showInformationMessage(
              `✅ 解释摘要已生成：Commit ${commitHash!.slice(0, 8)}，包含 ${result.sessions.length} 条 AI 会话`,
              "复制到剪贴板",
              "保存到文件",
            )
            .then(async (action) => {
              if (action === "复制到剪贴板") {
                await vscode.env.clipboard.writeText(result.content);
                vscode.window.showInformationMessage("✅ 已复制到剪贴板");
              } else if (action === "保存到文件") {
                const defaultName = `agentlog_explain_${commitHash!.slice(0, 8)}.md`;
                const uri = await vscode.window.showSaveDialog({
                  defaultUri: vscode.Uri.file(defaultName),
                  filters: { 解释摘要: ["md"] },
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
              .showErrorMessage(
                "AgentLog 后台服务未启动，无法生成解释",
                "启动服务",
              )
              .then((action) => {
                if (action === "启动服务") {
                  vscode.commands.executeCommand("agentlog.startBackend");
                }
              });
          } else {
            vscode.window.showErrorMessage(
              `生成解释失败：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      },
    );
  });

  // ── Handoff 命令 ────────────────────────────

  const AGENT_OPTIONS = [
    { label: "$(person) 人工接管", value: "human", description: "转交给人工处理" },
    { label: "$(code) OpenCode", value: "opencode", description: "转交给 OpenCode Agent" },
    { label: "$(debug-alt) Cursor", value: "cursor", description: "转交给 Cursor IDE" },
    { label: "$(person) Claude Code", value: "claude-code", description: "转交给 Claude Code" },
    { label: "$(bracket) Cline", value: "cline", description: "转交给 Cline" },
    { label: "$(symbol-misc) 其他 Agent...", value: "other", description: "手动输入 Agent 类型" },
  ];

  register("agentlog.createHandoff", async (item: unknown) => {
    let traceId: string | undefined;

    if (item instanceof TraceItem) {
      traceId = item.trace.id;
    }

    if (!traceId) {
      traceId = await vscode.window.showInputBox({
        prompt: "请输入要创建交接的 Trace ID",
        placeHolder: "ULID（例如：01ARZ3NDEKTSV4RRFFQ69G5FAV）",
      });
      if (!traceId) return;
    }

    const picked = await vscode.window.showQuickPick(AGENT_OPTIONS, {
      placeHolder: "选择交接目标",
    });

    if (!picked) return;

    let targetAgent = picked.value;

    if (targetAgent === "other") {
      const input = await vscode.window.showInputBox({
        prompt: "请输入目标 Agent 类型",
        placeHolder: "例如：opencode, cursor, claude-code",
        validateInput: (v) => (v.trim().length > 0 ? undefined : "不能为空"),
      });
      if (!input) return;
      targetAgent = input.trim();
    }

    try {
      const client = getBackendClient();
      const workspacePath = resolveWorkspacePath() ?? "";
      await client.createHandoff(traceId, targetAgent, workspacePath);
      traceTreeProvider.refresh();
      vscode.window.showInformationMessage(`✅ 交接请求已创建给 ${picked.label}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("409")) {
        vscode.window.showWarningMessage(
          `⚠️ 当前工作区已有一个待认领的 Trace，请切换到其他 Git Worktree 再进行交接。`,
        );
      } else {
        vscode.window.showErrorMessage(
          `创建交接失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });

  register("agentlog.resumeTraceWith", async (item: unknown) => {
    let traceId: string | undefined;

    if (item instanceof TraceItem) {
      traceId = item.trace.id;
    } else if (typeof item === "string") {
      traceId = item;
    }

    if (!traceId) {
      traceId = await vscode.window.showInputBox({
        prompt: "请输入要恢复的 Trace ID",
        placeHolder: "ULID（例如：01ARZ3NDEKTSV4RRFFQ69G5FAV）",
      });
      if (!traceId) return;
    }

    const picked = await vscode.window.showQuickPick(AGENT_OPTIONS.filter(o => o.value !== "other" && o.value !== "human"), {
      placeHolder: "选择要恢复的 Agent 类型",
    });

    if (!picked) return;

    try {
      const client = getBackendClient();
      const workspacePath = resolveWorkspacePath() ?? "";
      await client.resumeTrace(traceId, picked.value, workspacePath);
      traceTreeProvider.refresh();
      vscode.window.showInformationMessage(`✅ 已认领 Trace，由 ${picked.label} 接管`);
    } catch (err) {
      vscode.window.showErrorMessage(
        `认领失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  register("agentlog.pauseTrace", async (item: unknown) => {
    let traceId: string | undefined;

    if (item instanceof TraceItem) {
      traceId = item.trace.id;
    }

    if (!traceId) {
      vscode.window.showErrorMessage("无法解析 Trace ID");
      return;
    }

    try {
      const client = getBackendClient();
      await client.pauseTrace(traceId);
      traceTreeProvider.refresh();
      vscode.window.showInformationMessage("✅ Trace 已暂停");
    } catch (err) {
      vscode.window.showErrorMessage(
        `暂停失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  register("agentlog.resumeFromPause", async (item: unknown) => {
    let traceId: string | undefined;

    if (item instanceof TraceItem) {
      traceId = item.trace.id;
    }

    if (!traceId) {
      vscode.window.showErrorMessage("无法解析 Trace ID");
      return;
    }

    try {
      const client = getBackendClient();
      await client.resumeFromPause(traceId);
      traceTreeProvider.refresh();
      vscode.window.showInformationMessage("✅ Trace 已从暂停恢复");
    } catch (err) {
      vscode.window.showErrorMessage(
        `恢复失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  register("agentlog.completeTrace", async (item: unknown) => {
    let traceId: string | undefined;

    if (item instanceof TraceItem) {
      traceId = item.trace.id;
    }

    if (!traceId) {
      vscode.window.showErrorMessage("无法解析 Trace ID");
      return;
    }

    try {
      const client = getBackendClient();
      await client.completeTrace(traceId);
      traceTreeProvider.refresh();
      vscode.window.showInformationMessage("✅ Trace 已标记完成");
    } catch (err) {
      vscode.window.showErrorMessage(
        `完成失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  register("agentlog.deleteTrace", async (item: unknown) => {
    let traceId: string | undefined;

    if (item instanceof TraceItem) {
      traceId = item.trace.id;
    }

    if (!traceId) {
      vscode.window.showErrorMessage("无法解析 Trace ID");
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `确定要删除此 Trace 吗？此操作不可撤销。`,
      { modal: true },
      "删除",
    );

    if (confirm !== "删除") return;

    try {
      const client = getBackendClient();
      await client.deleteTrace(traceId);
      traceTreeProvider.refresh();
      vscode.window.showInformationMessage("✅ Trace 已删除");
    } catch (err) {
      vscode.window.showErrorMessage(
        `删除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  const language: ExportLanguage = currentConfig.exportLanguage ?? "zh";

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
  // Session 视图已废弃（2026-04-04）
  // 只保留 Commit Bindings 视图
  commitBindingsProvider = new CommitBindingsTreeProvider();

  disposables.push(
    vscode.window.registerTreeDataProvider(
      "agentlog.commitBindings",
      commitBindingsProvider,
    ),
    commitBindingsProvider,
  );
}

// ─────────────────────────────────────────────
// Trace TreeView 注册
// ─────────────────────────────────────────────

let traceTreeProvider: TraceTreeProvider;

function registerTraceTreeView(context: vscode.ExtensionContext): void {
  traceTreeProvider = new TraceTreeProvider();

  disposables.push(
    vscode.window.registerTreeDataProvider(
      "agentlog.traceList",
      traceTreeProvider,
    ),
    traceTreeProvider,
  );

  // 注册查看 trace 详情的命令
  disposables.push(
    vscode.commands.registerCommand("agentlog.viewTraceDetail", async (arg: unknown) => {
      let traceId: string | undefined;
      if (arg instanceof TraceItem) {
        traceId = arg.trace.id;
      } else if (typeof arg === "string") {
        traceId = arg;
      }
      if (!traceId) {
        vscode.window.showErrorMessage("无效的 Trace ID");
        return;
      }
      await TracePanel.open(traceId, context);
    }),
  );
}

// ─────────────────────────────────────────────
// 配置变更监听
// ─────────────────────────────────────────────

function registerConfigWatcher(context: vscode.ExtensionContext): void {
  disposables.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration("agentlog")) return;

      const newConfig = readConfig();
      log("[配置] 检测到 agentlog 配置变更，重新初始化模块…");

      // 重建 BackendClient（backendUrl 可能已变更）
      initBackendClient(newConfig);

      // 刷新视图
      commitBindingsProvider?.refresh();

      // 更新状态栏
      const health = await getBackendClient().ping(true);
      if (health.status === "ok") {
        updateStatusBar("idle");
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

  // 4. 从 git config 读取 agentlog.traceId 并设置到环境变量
  await initTraceIdFromGitConfig();

  // 5. 初始化状态栏
  initStatusBar();
  disposables.push(outputChannel, statusBarItem);

  // ── 启动后台服务 ────────────────────────────
  // 延迟 1 秒启动，避免阻塞 VS Code 启动
  setTimeout(async () => {
    const config = readConfig();
    if ((config as any).autoStartBackend ?? true) {
      await startBackendProcess(context, config);
    } else {
      // 不自动启动，但检查是否已有运行中的后台
      const health = await getBackendClient().ping(true);
      updateStatusBar(health.status === "ok" ? "idle" : "backend-offline");
    }
    await startMcpServerProcess(context);
  }, 1000);

  // ── 注册命令 ────────────────────────────────
  registerCommands(context, config);

  // ── 注册 TreeView ────────────────────────────
  registerTreeViews();
  registerTraceTreeView(context);

  // ── 监听配置变更 ────────────────────────────
  registerConfigWatcher(context);

  // ── 监听工作区切换，自动读取 git config traceId ────────────────────
  disposables.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await initTraceIdFromGitConfig();
    }),
  );

  // ── 注册 @agentlog Chat Participant（通过 Copilot 模型捕获对话）
  try {
    const chatParticipant = registerCopilotChatParticipant(outputChannel);
    disposables.push(chatParticipant);
    log("[激活] @agentlog Chat Participant 注册成功");
  } catch (err) {
    log(
      `[激活] Chat Participant 注册失败（VS Code 版本可能不支持 Chat API）：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 10. 将所有可 dispose 的资源交给 context 管理
  context.subscriptions.push(...disposables);

  log("AgentLog 插件激活完成");
}

// ─────────────────────────────────────────────
// 插件停用入口
// ─────────────────────────────────────────────

export function deactivate(): void {
  stopBackendProcess();
  stopMcpServerProcess();
  destroyBackendClient();
  disposables.forEach((d) => d.dispose());
}

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

/**
 * 从工作区的 .git/config 读取 agentlog.traceId
 */
async function readGitConfigTraceId(workspacePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const gitConfigPath = path.join(workspacePath, ".git", "config");
    // 检查 .git/config 是否存在
    if (!fs.existsSync(gitConfigPath)) {
      resolve(null);
      return;
    }
    // 读取 git config
    cp.exec(
      `git config --local --get agentlog.traceId`,
      { cwd: workspacePath, timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
          return;
        }
        const traceId = stdout.trim();
        resolve(traceId || null);
      },
    );
  });
}

/**
 * 初始化 AgentLog Trace ID
 * 从工作区的 .git/config 读取 agentlog.traceId 并设置到环境变量
 */
async function initTraceIdFromGitConfig(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;

  for (const folder of folders) {
    const workspacePath = folder.uri.fsPath;
    const traceId = await readGitConfigTraceId(workspacePath);
    if (traceId) {
      // 设置到环境变量，供 MCP Server 使用
      process.env.AGENTLOG_TRACE_ID = traceId;
      log(`[激活] 从 git config 读取 agentlog.traceId: ${traceId}`);
      break; // 只处理第一个工作区
    }
  }
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
