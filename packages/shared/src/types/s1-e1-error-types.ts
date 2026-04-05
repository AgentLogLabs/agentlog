/**
 * @agentlog/shared — S1-E1 Error Span Types
 *
 * Error Span 捕获机制相关类型定义。
 * 用于在 Agent 遇到错误时自动生成包含完整上下文的 Span。
 */

/**
 * 推理过程中的单步记录。
 * 用于构建连续推理链条（reasoningChain）。
 */
export interface ReasoningStep {
  /** 步骤序号 */
  step: number;

  /** 当前步骤的思考内容 */
  thought: string;

  /** 步骤时间戳（ISO 8601） */
  timestamp: string;
}

/**
 * Git 仓库状态信息。
 */
export interface GitStatus {
  /** 当前分支名 */
  currentBranch: string;

  /** 暂存区文件列表 */
  stagedFiles: string[];

  /** 未暂存的修改文件列表 */
  modifiedFiles: string[];

  /** 新增文件列表 */
  createdFiles: string[];

  /** 已删除文件列表 */
  deletedFiles: string[];

  /** 有未提交变更 */
  isDirty: boolean;
}

/**
 * 单个文件的变更统计。
 */
export interface FileDiffStats {
  /** 文件路径（相对于仓库根目录） */
  filePath: string;

  /** 文件变更状态 */
  status: "added" | "modified" | "deleted" | "renamed";

  /** 增行数 */
  additions: number;

  /** 删行数 */
  deletions: number;
}

/**
 * 内存快照信息。
 * 捕获错误发生时的关键内存状态。
 */
export interface MemorySnapshot {
  /** 工作区根路径 */
  workspacePath: string;

  /** 当前文件变更列表 */
  changedFiles: string[];

  /** Git 仓库状态 */
  gitStatus?: GitStatus;

  /** 当前工作目录 */
  cwd?: string;

  /** 环境变量快照（敏感信息已过滤） */
  env?: Record<string, string>;

  /** 当前会话 ID（若有） */
  sessionId?: string;
}

/**
 * Diff 统计信息。
 */
export interface DiffStats {
  /** 变更文件列表 */
  changedFiles: FileDiffStats[];

  /** 总增行数 */
  totalAdditions: number;

  /** 总删行数 */
  totalDeletions: number;
}

/**
 * Error Span 的完整数据结构。
 * 在 Agent 遇到错误时自动生成并上报。
 */
export interface ErrorSpan {
  /** ULID 唯一标识 */
  id: string;

  /** 关联的 Trace ID */
  traceId: string;

  /** 父 Span ID（若有） */
  parentSpanId?: string;

  /** 错误类型（如 "ReferenceError", "TypeError"） */
  errorType: string;

  /** 错误消息 */
  message: string;

  /** 堆栈信息 */
  stackTrace: string;

  /** 内存快照 */
  memorySnapshot: MemorySnapshot;

  /** Diff 统计信息 */
  diff: DiffStats;

  /** 连续推理过程链条 */
  reasoningChain: ReasoningStep[];

  /** 错误发生时间（ISO 8601） */
  timestamp: string;

  /** Agent 名称 */
  actorName: string;

  /** 事件来源 */
  source: "openclaw_telemetry";
}

/**
 * captureError 函数的输入参数。
 */
export interface CaptureErrorParams {
  /** 错误类型 */
  errorType: string;

  /** 错误消息 */
  message: string;

  /** 堆栈信息 */
  stackTrace: string;

  /** 内存快照 */
  memorySnapshot: MemorySnapshot;

  /** 变更文件列表（兼容旧格式）或完整 DiffStats） */
  diff?: string[] | DiffStats;

  /** 推理链条（可选） */
  reasoningChain?: ReasoningStep[];

  /** 父 Span ID（可选） */
  parentSpanId?: string;
}
