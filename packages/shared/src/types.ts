/**
 * @agentlog/shared — 核心类型定义
 *
 * 供 backend 和 vscode-extension 两个包共同使用。
 */

// ─────────────────────────────────────────────
// 枚举 / 联合类型
// ─────────────────────────────────────────────

/** 支持的国内主流模型提供商 */
export type ModelProvider =
  | "deepseek" // DeepSeek（含 R1 推理模型）
  | "qwen" // 阿里通义千问
  | "kimi" // 月之暗面 Kimi
  | "doubao" // 字节跳动豆包
  | "zhipu" // 智谱 ChatGLM
  | "openai" // OpenAI（兼容模式）
  | "anthropic" // Anthropic Claude（兼容模式）
  | "ollama" // 本地 Ollama
  | "unknown";

/** 调用来源（从哪个工具发起的 AI 请求） */
export type AgentSource =
  | "claude-code" // Claude Code（GitHub 默认 AI Agent）
  | "cline" // Cline VSCode 插件
  | "cursor" // Cursor IDE 内置 AI
  | "copilot" // GitHub Copilot
  | "continue" // Continue 插件
  | "direct-api" // 直接调用 HTTP API
  | "unknown";

/** 导出格式 */
export type ExportFormat =
  | "weekly-report" // 周报（Markdown）
  | "pr-description" // PR / Code Review 说明（Markdown）
  | "jsonl" // 原始 JSONL 数据
  | "csv"; // 结构化表格

/** 导出语言 */
export type ExportLanguage = "zh" | "en";

// ─────────────────────────────────────────────
// 核心实体
// ─────────────────────────────────────────────

/**
 * 一次 AI Agent 交互会话。
 * 捕获范围：从用户发出 Prompt 到收到完整 Response 为止。
 */
export interface AgentSession {
  /** 唯一 ID（nanoid 生成） */
  id: string;

  /** 会话创建时间（ISO 8601） */
  createdAt: string;

  /** 模型提供商 */
  provider: ModelProvider;

  /** 实际使用的模型名称，例如 "deepseek-r1"、"qwen-max" */
  model: string;

  /** 调用来源工具 */
  source: AgentSource;

  /** 工作区根路径（绝对路径） */
  workspacePath: string;

  /** 用户输入的完整 Prompt */
  prompt: string;

  /**
   * 模型的中间推理过程（Chain-of-Thought / Thinking）。
   * DeepSeek-R1 的 <think>...</think> 内容会存放在这里。
   * 不支持推理输出的模型此字段为 undefined。
   */
  reasoning?: string;

  /** 模型最终返回的完整响应文本 */
  response: string;

  /**
   * 与此次 AI 修改绑定的 Git Commit Hash（短 SHA 或完整 SHA）。
   * 在用户执行 git commit 后由插件自动或手动关联。
   */
  commitHash?: string;

  /**
   * 本次 AI 涉及修改的文件路径列表（相对于 workspacePath）。
   * 由插件通过 diff 或 workspace 变更事件推断。
   */
  affectedFiles: string[];

  /** 本次交互耗时（毫秒） */
  durationMs: number;

  /**
   * 用户为本次会话打的标签，方便后续检索。
   * 例如 ["bugfix", "重构", "性能优化"]
   */
  tags?: string[];

  /** 用户手动添加的备注说明 */
  note?: string;

  /**
   * 用于存放 provider 特定的扩展字段，不纳入核心模型。
   * 例如 DeepSeek 的 usage tokens、Qwen 的 request_id 等。
   */
  metadata?: Record<string, unknown>;
}

/**
 * Git Commit 与若干 AgentSession 的绑定关系。
 * 一个 Commit 可以关联多次 AI 交互（例如先问了几次再提交）。
 */
export interface CommitBinding {
  /** Git Commit 完整 SHA-1 */
  commitHash: string;

  /** 与此 Commit 关联的 AgentSession ID 列表 */
  sessionIds: string[];

  /** Commit message */
  message: string;

  /** 提交时间（ISO 8601） */
  committedAt: string;

  /** 提交者姓名 */
  authorName: string;

  /** 提交者邮箱 */
  authorEmail: string;

  /** 变更文件列表（来自 git diff --name-only） */
  changedFiles: string[];

  /** 所在仓库的工作区根路径 */
  workspacePath: string;
}

// ─────────────────────────────────────────────
// 导出相关
// ─────────────────────────────────────────────

/** 导出请求参数 */
export interface ExportOptions {
  /** 导出格式 */
  format: ExportFormat;

  /** 筛选起始日期（ISO 8601，含） */
  startDate?: string;

  /** 筛选截止日期（ISO 8601，含） */
  endDate?: string;

  /** 输出语言，默认 'zh' */
  language?: ExportLanguage;

  /** 仅导出包含指定标签的会话 */
  tags?: string[];

  /** 仅导出指定工作区的数据（绝对路径） */
  workspacePath?: string;

  /** 仅导出已绑定 Commit 的会话 */
  onlyBoundToCommit?: boolean;
}

/** 导出结果 */
export interface ExportResult {
  /** 导出格式 */
  format: ExportFormat;

  /** 导出内容（文本） */
  content: string;

  /** 包含的会话数量 */
  sessionCount: number;

  /** 生成时间（ISO 8601） */
  generatedAt: string;
}

// ─────────────────────────────────────────────
// API 协议（backend <-> extension 通信）
// ─────────────────────────────────────────────

/** 插件向后台上报一条新会话的请求体 */
export interface CreateSessionRequest {
  provider: ModelProvider;
  model: string;
  source: AgentSource;
  workspacePath: string;
  prompt: string;
  reasoning?: string;
  response: string;
  affectedFiles?: string[];
  durationMs: number;
  tags?: string[];
  note?: string;
  metadata?: Record<string, unknown>;
}

/** 绑定 Commit 的请求体 */
export interface BindCommitRequest {
  sessionIds: string[];
  commitHash: string;
}

/** 分页查询参数 */
export interface PaginationParams {
  page?: number;
  pageSize?: number;
}

/** 会话查询过滤器 */
export interface SessionQueryFilter extends PaginationParams {
  workspacePath?: string;
  provider?: ModelProvider;
  source?: AgentSource;
  startDate?: string;
  endDate?: string;
  tags?: string[];
  keyword?: string;
  onlyBoundToCommit?: boolean;
}

/** 通用分页响应 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 通用 API 响应包装 */
export interface ApiResponse<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

// ─────────────────────────────────────────────
// 插件配置
// ─────────────────────────────────────────────

/** 插件在 VS Code settings.json 中的配置项 */
export interface AgentLogConfig {
  /** 本地后台监听地址，默认 "http://localhost:7892" */
  backendUrl: string;

  /** 是否自动捕获 AI 交互（默认 true） */
  autoCapture: boolean;

  /** 是否捕获 Reasoning 字段（默认 true） */
  captureReasoning: boolean;

  /**
   * 是否在 git commit 时自动关联最近的未绑定会话。
   * 默认 true。
   */
  autoBindOnCommit: boolean;

  /** 数据保留天数（0 = 永久），默认 90 */
  retentionDays: number;

  /** 是否启用调试日志输出，默认 false */
  debug: boolean;
}

/** AgentLogConfig 的默认值 */
export const DEFAULT_CONFIG: AgentLogConfig = {
  backendUrl: "http://localhost:7892",
  autoCapture: true,
  captureReasoning: true,
  autoBindOnCommit: true,
  retentionDays: 90,
  debug: false,
};

// ─────────────────────────────────────────────
// Lifecycle Hooks — Claude Code
// ─────────────────────────────────────────────

/** Claude Code 支持的 Hook 事件名 */
export type ClaudeCodeEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop"
  | "SessionStart"
  | "SessionEnd"
  | "Notification"
  | "InstructionsLoaded";

/** Claude Code 通过 stdin / HTTP 传递给 hook 的 JSON payload */
export interface ClaudeCodeHookPayload {
  /** Claude Code 内部会话 ID */
  session_id?: string;
  /** 触发的事件名 */
  hook_event_name: string;
  /** 本次对话完整历史的 JSONL 文件路径 */
  transcript_path?: string;
  /** 当前工作目录 */
  cwd?: string;
  /** Stop 事件：是否仍有活跃的 stop hook */
  stop_hook_active?: boolean;
  /** PreToolUse / PostToolUse：工具名 */
  tool_name?: string;
  /** PreToolUse：工具输入参数 */
  tool_input?: Record<string, unknown>;
  /** PostToolUse：工具执行结果 */
  tool_response?: unknown;
  /** UserPromptSubmit：当前提交的消息 */
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
  /** SubagentStop：最终的 assistant 消息文本 */
  last_assistant_message?: string;
}

/** Transcript JSONL 文件中的单条记录 */
export interface TranscriptEntry {
  role?: "user" | "assistant";
  content?: string | TranscriptContentBlock[];
  /** 嵌套 message 对象（部分格式） */
  message?: {
    id?: string;
    type?: string;
    role?: "user" | "assistant";
    content?: string | TranscriptContentBlock[];
    model?: string;
    usage?: Record<string, number>;
    stop_reason?: string;
  };
  type?: string;
  timestamp?: string;
}

/** Transcript 中的内容块 */
export interface TranscriptContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | TranscriptContentBlock[];
}

// ─────────────────────────────────────────────
// Commit 上下文与解释（Context & Explain）
// ─────────────────────────────────────────────

/** 上下文输出格式 */
export type ContextFormat = "markdown" | "json" | "xml";

/** 生成 Commit 上下文文档的选项 */
export interface CommitContextOptions {
  /** 输出格式，默认 'markdown' */
  format?: ContextFormat;

  /** 输出语言，默认 'zh' */
  language?: ExportLanguage;

  /** 是否包含用户 Prompt，默认 true */
  includePrompts?: boolean;

  /** 是否包含模型 Response，默认 true */
  includeResponses?: boolean;

  /** 是否包含推理过程（Reasoning / Thinking），默认 true */
  includeReasoning?: boolean;

  /** 是否包含变更文件列表，默认 true */
  includeChangedFiles?: boolean;

  /**
   * 单条 Prompt / Response / Reasoning 内容的最大字符长度。
   * 超出部分将被截断并标注。0 表示不截断。
   * 默认 2000。
   */
  maxContentLength?: number;

  /**
   * 最多包含的 AI 会话数量。
   * 0 表示不限制。默认 0。
   */
  maxSessions?: number;
}

/** 上下文文档中的单条会话摘要 */
export interface ContextSessionItem {
  /** 会话 ID */
  sessionId: string;

  /** 会话创建时间（ISO 8601） */
  createdAt: string;

  /** 模型名称 */
  model: string;

  /** 模型提供商 */
  provider: ModelProvider;

  /** 调用来源 */
  source: AgentSource;

  /** 用户 Prompt（可能被截断） */
  prompt?: string;

  /** 推理过程（可能被截断） */
  reasoning?: string;

  /** 模型 Response（可能被截断） */
  response?: string;

  /** 涉及的文件列表 */
  affectedFiles: string[];

  /** 标签 */
  tags?: string[];

  /** 备注 */
  note?: string;

  /** 耗时（毫秒） */
  durationMs: number;
}

/** Commit 上下文文档的生成结果 */
export interface CommitContextResult {
  /** Commit Hash */
  commitHash: string;

  /** Commit Message */
  commitMessage: string;

  /** 提交者 */
  authorName: string;

  /** 提交时间（ISO 8601） */
  committedAt: string;

  /** 变更文件列表 */
  changedFiles: string[];

  /** 输出格式 */
  format: ContextFormat;

  /** 关联的 AI 会话数量 */
  sessionCount: number;

  /** 渲染后的上下文文档内容（Markdown / JSON / XML 文本） */
  content: string;

  /** 生成时间（ISO 8601） */
  generatedAt: string;
}

/** 解释摘要中的单条会话要点 */
export interface SessionExplainItem {
  /** 会话 ID */
  sessionId: string;

  /** 会话创建时间（ISO 8601） */
  createdAt: string;

  /** 模型名称 */
  model: string;

  /** 调用来源 */
  source: AgentSource;

  /** Prompt 的一句话概括 */
  promptSummary: string;

  /** Response 的一句话概括 */
  responseSummary: string;

  /** 是否包含推理过程 */
  hasReasoning: boolean;

  /** 涉及的文件列表 */
  affectedFiles: string[];

  /** 标签 */
  tags?: string[];
}

/** Commit 解释摘要的生成结果 */
export interface CommitExplainResult {
  /** Commit Hash */
  commitHash: string;

  /** Commit Message */
  commitMessage: string;

  /** 提交者 */
  authorName: string;

  /** 提交时间（ISO 8601） */
  committedAt: string;

  /** 总体摘要：对本次 commit 的 AI 交互做一个简短总结 */
  overallSummary: string;

  /** 逐条会话的解释要点 */
  sessions: SessionExplainItem[];

  /** 涉及文件的聚合列表 */
  allAffectedFiles: string[];

  /** 输出语言 */
  language: ExportLanguage;

  /** 渲染后的解释文档内容（Markdown 文本） */
  content: string;

  /** 生成时间（ISO 8601） */
  generatedAt: string;
}
