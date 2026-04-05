/**
 * @agentlog/shared — 核心类型定义
 *
 * 供 backend 和 vscode-extension 两个包共同使用。
 */

// ─────────────────────────────────────────────
// 枚举 / 联合类型
// ─────────────────────────────────────────────

// 支持的国内主流模型提供商
// ─────────────────────────────────────────────

/** 支持的国内主流模型提供商 */
export type ModelProvider =
  | "deepseek" // DeepSeek（含 R1 推理模型）
  | "qwen" // 阿里通义千问
  | "kimi" // 月之暗面 Kimi
  | "doubao" // 字节跳动豆包
  | "zhipu" // 智谱 ChatGLM
  | "minimax" // MiniMax（mini-max 系列模型）
  | "openai" // OpenAI（兼容模式）
  | "anthropic" // Anthropic Claude（兼容模式）
  | "ollama" // 本地 Ollama
  | "mcp" // MCP 工具调用（Agent 主动上报）
  | "unknown";

/** 调用来源（从哪个工具发起的 AI 请求） */
export type AgentSource =
  | "claude-code" // Claude Code（GitHub 默认 AI Agent）
  | "cline" // Cline VSCode 插件
  | "cursor" // Cursor IDE 内置 AI
  | "copilot" // GitHub Copilot
  | "continue" // Continue 插件
  | "opencode" // OpenCode CLI AI Agent
  | "trae" // Trae IDE（字节跳动 AI 编程 IDE）
  | "direct-api" // 直接调用 HTTP API
  | "mcp-tool-call" // MCP 工具主动上报（Agent 意图记录）
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
// Trace Handoff 状态与类型（Stage 1 新增）
// ─────────────────────────────────────────────

/** Trace 状态机（支持 handoff 场景） */
export type TraceHandoffStatus = 'running' | 'pending_handoff' | 'in_progress' | 'completed' | 'failed' | 'paused';

/** pending trace 条目 */
export interface PendingTraceEntry {
  createdAt: string;
  targetAgent: 'opencode' | 'cursor' | 'claude-code' | string;
  taskGoal?: string;
}

/** active session 条目 */
export interface ActiveSessionEntry {
  sessionId: string;
  traceId: string;
  agentType: string;
  status: 'active';
  startedAt: string;
  worktree?: string;
}

/** sessions.json 完整结构 */
export interface SessionsJson {
  pending: Record<string, PendingTraceEntry>;
  active: Record<string, ActiveSessionEntry>;
}

/** Error Span payload（增强的错误信息） */
export interface ErrorSpanPayload {
  errorType: string;
  stackTrace?: string;
  memorySnapshot?: {
    workspacePath: string;
    currentFiles: string[];
    gitStatus: 'clean' | 'modified' | 'staged' | 'untracked';
  };
  diff?: {
    changedFiles: string[];
    additions: number;
    deletions: number;
  };
  reasoningChain?: ReasoningChainStep[];
}

/** 推理链步骤 */
export interface ReasoningChainStep {
  step: number;
  thought: string;
  action: string;
}

// ─────────────────────────────────────────────
// Transcript（逐轮对话记录）
// ─────────────────────────────────────────────

/**
 * 对话 transcript 中的单条消息。
 * 对应 entire CLI 的 SessionEntry，记录每一轮 user/assistant/tool 交互。
 */
export interface TranscriptTurn {
  /** 消息角色 */
  role: "user" | "assistant" | "tool";

  /**
   * 消息内容文本。
   * - user / assistant：纯文本
   * - tool：工具执行结果摘要
   */
  content: string;

  /**
   * 推理模型本轮的思考过程（Chain-of-Thought / Thinking）。
   * - DeepSeek-R1：来自流式响应的 delta.reasoning_content
   * - Claude 3.7+ extended thinking：来自 thinking content block
   * - 其他支持推理输出的模型同理
   * 仅 role=assistant 时有意义；不支持推理输出的模型此字段为 undefined。
   * 对应 AgentSession.reasoning（会话级别的推理汇总由 transcriptToReasoning 从此字段聚合生成）。
   */
  reasoning?: string;

  /** 消息时间戳（ISO 8601，可选） */
  timestamp?: string;

  /** role=tool 时的工具名称（如 "bash"、"read"、"edit"） */
  toolName?: string;

  /** role=tool 时的工具输入参数摘要（可选，避免过大） */
  toolInput?: string;
}

// ─────────────────────────────────────────────
// Token 用量
// ─────────────────────────────────────────────

/**
 * 本次会话的 Token 用量统计。
 * 对应 entire CLI 的 TokenUsage，支持缓存分别计量。
 */
export interface TokenUsage {
  /** 新鲜输入 tokens（非缓存命中部分） */
  inputTokens: number;

  /** 缓存写入 tokens（本次写入提示缓存，按缓存写入价格计费） */
  cacheCreationTokens?: number;

  /** 缓存命中 tokens（从提示缓存读取，按折扣价计费） */
  cacheReadTokens?: number;

  /** 输出 tokens */
  outputTokens: number;

  /** API 调用次数（含工具调用轮次） */
  apiCallCount?: number;
}

// ─────────────────────────────────────────────
// Session-Commit 多对多绑定
// ─────────────────────────────────────────────

/**
 * Session 与 Commit 的单个绑定关系（来自 session_commits 表）。
 */
export interface SessionCommit {
  /** Git Commit Hash（短 SHA 或完整 SHA） */
  commitHash: string;

  /** 绑定时的 transcript 条数（用于分段展示） */
  transcriptLength: number;

  /** 绑定创建时间（ISO 8601） */
  createdAt: string;
}

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

  /** 工作区根路径（绝对路径）。多 worktree 场景下为具体 worktree 的路径 */
  workspacePath: string;

  /**
   * Git 仓库根目录绝对路径（schema v4 新增）。
   *
   * 在多 worktree 场景下，同一仓库的不同 worktree 具有不同的 workspacePath，
   * 但共享同一个 gitRepoRoot。通过此字段可将所有 worktree 的会话归一化到同一仓库，
   * 支持 post-commit 钩子跨 worktree 正确匹配并绑定会话。
   *
   * 若未使用 git worktree，此值通常与 workspacePath 相同。
   * 历史数据（schema v4 之前）此字段为 undefined。
   */
  gitRepoRoot?: string;

  /** 用户输入的完整 Prompt */
  prompt: string;

  /**
   * 格式化后的完整对话记录，包含用户消息、AI回复、工具调用及推理过程。
   * 由 transcriptToReasoning() 函数生成，用于快速预览和导出。
   */
  formattedTranscript?: string;

  /**
   * 纯推理过程摘要，仅聚合 TranscriptTurn.reasoning 内容。
   * 用于分析 AI 思考链条，不包含用户消息和工具调用记录。
   */
  reasoning?: string;

  /** 模型最终返回的完整响应文本 */
  response: string;

  /**
   * 与此次 AI 修改绑定的 Git Commit Hash（短 SHA 或完整 SHA）。
   * 在用户执行 git commit 后由插件自动或手动关联。
   * 注意：在多对多绑定中，此字段存储最新绑定的 Commit Hash（向后兼容）。
   */
  commitHash?: string;

  /**
   * 本次会话与所有 Commit 的绑定关系（多对多）。
   * 每个元素对应 session_commits 表中的一条记录。
   * 按 createdAt 升序排列（最早的绑定在前）。
   */
  sessionCommits?: SessionCommit[];

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
   * 完整的逐轮对话记录（transcript）。
   * 每一条消息（user / assistant / tool）按时序追加。
   * 对应 entire CLI 的 full.jsonl 内容，以结构化 JSON 数组存储。
   */
  transcript?: TranscriptTurn[];

  /**
   * 会话最后活动时间（ISO 8601）。
   * 用于检测活跃会话，在 appendTranscript 或 updateSessionIntent 时更新。
   */
  lastActivityAt?: string;

  /**
   * 本次会话的 Token 用量统计。
   * 由 Agent 在调用 log_intent / log_turn 时上报，或由 hook 自动采集。
   */
  tokenUsage?: TokenUsage;

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

  /** 与此 Commit 关联的 Trace ID 列表（2026-04-04 新增，迁移到 Trace/Span 架构） */
  traceIds: string[];

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
  /**
   * Git 仓库根目录路径（可选，schema v4 新增）。
   * 多 worktree 场景下与 workspacePath 不同；单 worktree 场景下两者相同。
   * 若未提供，后端会尝试从 workspacePath 自动推断。
   */
  gitRepoRoot?: string;
  prompt: string;
  reasoning?: string;
  response: string;
  affectedFiles?: string[];
  durationMs: number;
  tags?: string[];
  note?: string;
  /** 逐轮对话记录（可选，MCP log_intent 或 log_turn 工具上报） */
  transcript?: TranscriptTurn[];
  /** Token 用量统计（可选） */
  tokenUsage?: TokenUsage;
  metadata?: Record<string, unknown>;
}

/** 追加 transcript 消息的请求体（用于逐轮记录） */
export interface AppendTranscriptRequest {
  turns: TranscriptTurn[];
  /** 同时更新 token 用量（可选，累计值） */
  tokenUsage?: TokenUsage;
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

  /**
   * MCP (Model Context Protocol) 相关配置
   */
  mcp?: {
    /**
     * 外部 AI Agent (MCP 客户端) 的配置文件绝对路径。
     * 若填写，插件将自动注册 AgentLog MCP 服务到此文件。
     * 例如 OpenCode: ~/.config/opencode/mcp-servers.json
     */
    clientConfigPath?: string;
  };

  /** 是否自动捕获 AI 交互（默认 true） */

  /** 是否捕获 Reasoning 字段（默认 true） */

  /**
   * 是否在 git commit 时自动关联最近的未绑定会话。
   * 默认 true。
   */
  autoBindOnCommit: boolean;

  /** 数据保留天数（0 = 永久），默认 90 */
  retentionDays: number;

  /** 是否启用调试日志输出，默认 false */
  debug: boolean;

  /** 导出语言（zh/en），默认 zh */
  exportLanguage?: ExportLanguage;
}

/** AgentLogConfig 的默认值 */
export const DEFAULT_CONFIG: AgentLogConfig = {
  backendUrl: "http://localhost:7892",
  mcp: {
    clientConfigPath: undefined,
  },
  autoBindOnCommit: true,
  retentionDays: 90,
  debug: false,
  exportLanguage: "zh",
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
