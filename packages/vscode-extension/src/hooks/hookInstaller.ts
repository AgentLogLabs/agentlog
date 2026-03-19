/**
 * @agentlog/vscode-extension — hookInstaller
 *
 * 读写 ~/.claude/settings.json，为 Claude Code 安装 / 卸载
 * AgentLog 的 Lifecycle Hook 配置。
 *
 * 安装后 Claude Code 在 Stop 事件触发时，会通过 curl 将 payload
 * （含 transcript_path）POST 到本地后台的 /api/hooks/claude-code/Stop。
 *
 * 用法：
 *   import { installClaudeCodeHooks, uninstallClaudeCodeHooks, getClaudeCodeHookStatus } from './hooks/hookInstaller';
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────

/** AgentLog 在 hook command 中的标识，用于安装/卸载时匹配 */
const AGENTLOG_MARKER = "agentlog";

/** Claude Code 全局设置文件路径 */
function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

/** 我们关注的 Claude Code hook 事件（MVP 仅 Stop） */
const HOOK_EVENTS = ["Stop"] as const;

// ─────────────────────────────────────────────
// 类型（仅描述 settings.json 中 hooks 相关结构）
// ─────────────────────────────────────────────

interface ClaudeHookEntry {
  type: string;
  command: string;
}

interface ClaudeHookMatcher {
  matcher: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookMatcher[]>;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────
// 安装状态
// ─────────────────────────────────────────────

export interface HookStatus {
  /** Claude Code settings.json 是否存在 */
  settingsExists: boolean;
  /** 各事件是否已安装 AgentLog hook */
  installed: Record<string, boolean>;
  /** 全部事件均已安装 */
  allInstalled: boolean;
}

/**
 * 检查当前 Claude Code hook 安装状态。
 */
export function getClaudeCodeHookStatus(): HookStatus {
  const filePath = claudeSettingsPath();
  const settingsExists = fs.existsSync(filePath);
  const installed: Record<string, boolean> = {};

  if (settingsExists) {
    const settings = readSettings(filePath);
    for (const event of HOOK_EVENTS) {
      installed[event] = hasAgentLogHook(settings, event);
    }
  } else {
    for (const event of HOOK_EVENTS) {
      installed[event] = false;
    }
  }

  const allInstalled = HOOK_EVENTS.every((e) => installed[e]);
  return { settingsExists, installed, allInstalled };
}

// ─────────────────────────────────────────────
// 安装
// ─────────────────────────────────────────────

/**
 * 往 ~/.claude/settings.json 写入 AgentLog 的 hook 配置。
 *
 * 如果 settings.json 不存在，会自动创建（含父目录）。
 * 如果已有 AgentLog 的 hook 条目，会先移除再重新写入（确保 URL 最新）。
 *
 * @param backendUrl 后端地址，默认 http://localhost:7892
 */
export function installClaudeCodeHooks(
  backendUrl = "http://localhost:7892",
): void {
  const filePath = claudeSettingsPath();

  // 确保目录存在
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const settings = fs.existsSync(filePath) ? readSettings(filePath) : {};

  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const event of HOOK_EVENTS) {
    // 先清除旧的 AgentLog hook（如果有）
    removeAgentLogHookFromEvent(settings, event);

    // 构建 curl 命令
    const hookUrl = `${backendUrl}/api/hooks/claude-code/${event}`;
    const command = buildCurlCommand(hookUrl);

    const newEntry: ClaudeHookMatcher = {
      matcher: "",
      hooks: [
        {
          type: "command",
          command,
        },
      ],
    };

    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }
    settings.hooks[event].push(newEntry);
  }

  writeSettings(filePath, settings);
}

// ─────────────────────────────────────────────
// 卸载
// ─────────────────────────────────────────────

/**
 * 从 ~/.claude/settings.json 中移除 AgentLog 的 hook 配置。
 * 其他 hook 不受影响。
 *
 * @returns 是否实际移除了内容
 */
export function uninstallClaudeCodeHooks(): boolean {
  const filePath = claudeSettingsPath();
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const settings = readSettings(filePath);
  let changed = false;

  for (const event of HOOK_EVENTS) {
    if (removeAgentLogHookFromEvent(settings, event)) {
      changed = true;
    }
  }

  if (changed) {
    writeSettings(filePath, settings);
  }
  return changed;
}

// ─────────────────────────────────────────────
// 内部工具函数
// ─────────────────────────────────────────────

function readSettings(filePath: string): ClaudeSettings {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    return {};
  }
}

function writeSettings(filePath: string, settings: ClaudeSettings): void {
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

/**
 * 构建 curl 命令，将 stdin（Claude Code 传入的 JSON payload）POST 到 hookUrl。
 *
 * 关键 flag 说明：
 *   -s  静默模式（不输出进度条）
 *   -f  HTTP 错误时静默失败（不污染 Claude Code 输出）
 *   -X POST  显式 POST
 *   -d @-    从 stdin 读取 body
 */
function buildCurlCommand(hookUrl: string): string {
  return `curl -sf -X POST '${hookUrl}' -H 'Content-Type: application/json' -d @- 2>/dev/null || true # agentlog`;
}

/** 检查指定事件下是否已有 AgentLog 的 hook */
function hasAgentLogHook(settings: ClaudeSettings, event: string): boolean {
  const matchers = settings.hooks?.[event];
  if (!Array.isArray(matchers)) return false;

  return matchers.some((m) =>
    m.hooks?.some(
      (h) =>
        typeof h.command === "string" && h.command.includes(AGENTLOG_MARKER),
    ),
  );
}

/**
 * 从某个事件的 hook 列表中移除包含 AgentLog 标记的条目。
 * @returns 是否实际移除了条目
 */
function removeAgentLogHookFromEvent(
  settings: ClaudeSettings,
  event: string,
): boolean {
  const matchers = settings.hooks?.[event];
  if (!Array.isArray(matchers)) return false;

  const before = matchers.length;

  // 过滤掉包含 agentlog 标记的 matcher
  settings.hooks![event] = matchers.filter(
    (m) =>
      !m.hooks?.some(
        (h) =>
          typeof h.command === "string" && h.command.includes(AGENTLOG_MARKER),
      ),
  );

  // 如果事件下已无 hook，清理空数组
  if (settings.hooks![event].length === 0) {
    delete settings.hooks![event];
  }

  // 如果 hooks 对象为空，也清理
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  return settings.hooks?.[event]?.length !== before;
}
