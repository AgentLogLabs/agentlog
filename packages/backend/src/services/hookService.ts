/**
 * @agentlog/backend — hookService
 *
 * 处理来自 Claude Code 的 Lifecycle Hook 事件。
 *
 * 核心流程（以 Stop 事件为例）：
 *   1. 接收 Hook payload（包含 transcript_path 和 cwd）
 *   2. 读取并解析 transcript JSONL 文件
 *   3. 提取最后一轮的 prompt / reasoning / response / model
 *   4. 调用 createSession 持久化到数据库
 */

import fs from "fs";
import type {
  ClaudeCodeHookPayload,
  TranscriptEntry,
  TranscriptContentBlock,
  AgentSession,
  ModelProvider,
} from "@agentlog/shared";
import { createSession } from "./logService";

// ─────────────────────────────────────────────
// Transcript 解析
// ─────────────────────────────────────────────

/**
 * 从 transcript_path 读取 JSONL 文件并解析为条目列表。
 * 容忍格式不规范的行（忽略解析失败的行）。
 */
export function readTranscript(transcriptPath: string): TranscriptEntry[] {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return [];
  }

  const raw = fs.readFileSync(transcriptPath, "utf-8");
  const entries: TranscriptEntry[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch {
      // 忽略无法解析的行
    }
  }

  return entries;
}

/**
 * 从单个 TranscriptEntry 中解析出 role 和内容块列表。
 * 兼容多种格式：
 *   - 直接 { role, content }
 *   - 嵌套 { message: { role, content } }
 *   - 带 type 字段的包装格式
 */
function normalizeEntry(entry: TranscriptEntry): {
  role: "user" | "assistant" | null;
  blocks: TranscriptContentBlock[];
  model?: string;
} {
  // 优先取 message 嵌套对象
  const msg = entry.message ?? entry;
  const role = (msg.role ?? null) as "user" | "assistant" | null;
  const model = entry.message?.model;

  const rawContent = msg.content ?? entry.content;

  if (!rawContent) {
    return { role, blocks: [], model };
  }

  // 统一转为 blocks 数组
  if (typeof rawContent === "string") {
    return { role, blocks: [{ type: "text", text: rawContent }], model };
  }

  return { role, blocks: rawContent as TranscriptContentBlock[], model };
}

/** 从 content blocks 中提取纯文本（text 类型块拼接） */
function extractText(blocks: TranscriptContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n")
    .trim();
}

/** 从 content blocks 中提取 thinking 内容（推理过程） */
function extractThinking(blocks: TranscriptContentBlock[]): string | undefined {
  const thinkingParts = blocks
    .filter((b) => b.type === "thinking" && typeof b.thinking === "string")
    .map((b) => b.thinking!);

  return thinkingParts.length > 0 ? thinkingParts.join("\n").trim() : undefined;
}

/**
 * 解析 transcript 条目列表，返回最后一轮完整对话：
 * - prompt：最后一条 user 消息
 * - response：最后一条 assistant 消息
 * - reasoning：assistant 消息中的 thinking 内容
 * - model：模型名称（从 assistant 消息推断）
 */
export interface ParsedConversationTurn {
  prompt: string;
  response: string;
  reasoning?: string;
  model?: string;
}

export function parseLastTurn(
  entries: TranscriptEntry[],
): ParsedConversationTurn | null {
  let lastUserText = "";
  let lastAssistantText = "";
  let lastReasoning: string | undefined;
  let lastModel: string | undefined;

  for (const entry of entries) {
    const { role, blocks, model } = normalizeEntry(entry);

    if (role === "user") {
      const text = extractText(blocks);
      if (text) lastUserText = text;
    } else if (role === "assistant") {
      const text = extractText(blocks);
      const thinking = extractThinking(blocks);
      if (text) {
        lastAssistantText = text;
        lastReasoning = thinking;
        if (model) lastModel = model;
      }
    }
  }

  if (!lastUserText && !lastAssistantText) return null;

  return {
    prompt: lastUserText || "(no prompt)",
    response: lastAssistantText || "(no response)",
    reasoning: lastReasoning,
    model: lastModel,
  };
}

// ─────────────────────────────────────────────
// 模型提供商推断
// ─────────────────────────────────────────────

function inferProvider(model?: string): ModelProvider {
  if (!model) return "anthropic";
  const m = model.toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("qwen") || m.includes("tongyi")) return "qwen";
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3"))
    return "openai";
  if (m.includes("kimi") || m.includes("moonshot")) return "kimi";
  if (m.includes("doubao") || m.includes("skylark")) return "doubao";
  if (m.includes("glm") || m.includes("zhipu")) return "zhipu";
  return "anthropic"; // Claude Code 默认
}

// ─────────────────────────────────────────────
// Claude Code Stop 事件
// ─────────────────────────────────────────────

/**
 * 处理 Claude Code 的 Stop / SubagentStop 事件。
 *
 * payload 包含 transcript_path（完整对话历史 JSONL）和 cwd（工作目录）。
 * 读取 transcript → 提取最后一轮对话 → createSession 入库。
 */
/**
 * 从 transcript 条目列表中估算会话耗时（毫秒）。
 * 优先使用条目的 timestamp 字段，否则使用 JSONL 文件修改时间。
 */
function estimateDurationFromEntries(
  entries: TranscriptEntry[],
  transcriptPath?: string,
): number {
  // 方式 1：从 transcript 条目的 timestamp 字段推算
  const timestamps = entries
    .map((e) => e.timestamp)
    .filter((t): t is string => !!t)
    .map((t) => new Date(t).getTime())
    .filter((t) => !isNaN(t));

  if (timestamps.length >= 2) {
    const first = Math.min(...timestamps);
    const last = Math.max(...timestamps);
    if (last > first) return last - first;
  }

  // 方式 2：使用 JSONL 文件的 birthtime → mtime 差值
  if (transcriptPath) {
    try {
      const stat = fs.statSync(transcriptPath);
      const birth = stat.birthtimeMs;
      const mod = stat.mtimeMs;
      if (mod > birth && mod - birth > 0) {
        return Math.round(mod - birth);
      }
    } catch {
      // 文件 stat 失败时忽略
    }
  }

  return 0;
}

export function handleClaudeCodeStop(
  payload: ClaudeCodeHookPayload,
): AgentSession | null {
  const workspacePath = payload.cwd ?? process.cwd();

  // 优先从 transcript_path 解析完整对话
  if (payload.transcript_path) {
    const entries = readTranscript(payload.transcript_path);
    const turn = parseLastTurn(entries);

    if (turn) {
      const durationMs = estimateDurationFromEntries(entries, payload.transcript_path);

      return createSession({
        provider: inferProvider(turn.model),
        model: turn.model ?? "claude",
        source: "claude-code",
        workspacePath,
        prompt: turn.prompt,
        reasoning: turn.reasoning,
        response: turn.response,
        affectedFiles: [],
        durationMs,
        metadata: {
          hookEvent: payload.hook_event_name,
          claudeSessionId: payload.session_id,
          transcriptPath: payload.transcript_path,
        },
      });
    }
  }

  // 回退：使用 last_assistant_message（SubagentStop 携带）
  if (payload.last_assistant_message) {
    return createSession({
      provider: "anthropic",
      model: "claude",
      source: "claude-code",
      workspacePath,
      prompt: "(prompt unavailable)",
      response: payload.last_assistant_message,
      affectedFiles: [],
      durationMs: 0,
      metadata: {
        hookEvent: payload.hook_event_name,
        claudeSessionId: payload.session_id,
      },
    });
  }

  return null;
}

// ─────────────────────────────────────────────
// 事件分发（仅 Claude Code）
// ─────────────────────────────────────────────

/**
 * 根据 agent + event 分发处理逻辑。
 * MVP 阶段仅处理 claude-code 的 Stop / SubagentStop 事件。
 */
export function dispatchHookEvent(
  agent: string,
  event: string,
  payload: Record<string, unknown>,
): AgentSession | null {
  if (agent !== "claude-code") {
    return null;
  }

  const p = payload as unknown as ClaudeCodeHookPayload;

  switch (event) {
    case "Stop":
    case "SubagentStop":
      return handleClaudeCodeStop(p);
    default:
      // 其他事件（UserPromptSubmit / SessionStart 等）暂不处理
      return null;
  }
}
