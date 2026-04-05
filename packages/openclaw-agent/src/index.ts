/**
 * @agentlog/openclaw-agent — AgentLog Handoff Skill
 *
 * 提供给 OpenClaw Agent 使用的 skill，实现 trace 交接功能：
 * 1. checkAndClaimTrace - 启动时检查并认领 pending traces
 * 2. extractTraceIdFromMessage - 从消息中提取 Trace ID
 * 3. queryPendingTraces - 查询 pending traces
 * 4. claimTrace - 认领 trace
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type {
  PendingTraceEntry,
  ActiveSessionEntry,
  SessionsJson,
} from "@agentlog/shared";

// Backend API 配置
const BACKEND_URL = process.env.AGENTLOG_BACKEND_URL ?? "http://localhost:7892";

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

export interface HandoffResult {
  success: boolean;
  traceId?: string;
  sessionId?: string;
  error?: string;
}

export interface TraceSearchResult {
  traceId: string;
  taskGoal: string;
  targetAgent: string;
  createdAt: string;
  score?: number;
}

// ─────────────────────────────────────────────
// sessions.json 操作
// ─────────────────────────────────────────────

/**
 * 获取 sessions.json 路径（通过 git-common-dir）。
 */
async function getSessionsJsonPath(workspacePath: string): Promise<string> {
  // 使用同步命令简化处理
  const { execSync } = await import("child_process");
  const gitCommonDir = execSync(
    "git rev-parse --git-common-dir",
    { cwd: workspacePath, encoding: "utf-8" }
  ).trim();
  return path.join(gitCommonDir, "agentlog", "sessions.json");
}

/**
 * 读取 sessions.json。
 */
function readSessionsJson(sessionsJsonPath: string): SessionsJson {
  if (!fs.existsSync(sessionsJsonPath)) {
    return { pending: {}, active: {} };
  }
  try {
    const content = fs.readFileSync(sessionsJsonPath, "utf-8");
    return JSON.parse(content) as SessionsJson;
  } catch {
    return { pending: {}, active: {} };
  }
}

/**
 * 写入 sessions.json。
 */
function writeSessionsJson(sessionsJsonPath: string, data: SessionsJson): void {
  const dir = path.dirname(sessionsJsonPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${sessionsJsonPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, sessionsJsonPath);
}

// ─────────────────────────────────────────────
// API 调用
// ─────────────────────────────────────────────

/**
 * 调用 Backend API。
 */
async function apiRequest<T>(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const url = `${BACKEND_URL}${endpoint}`;
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`API 错误: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

// ─────────────────────────────────────────────
// Skill Functions
// ─────────────────────────────────────────────

/**
 * 启动时检查并认领 pending traces。
 * 读取 sessions.json，找到匹配当前 agent 类型的 pending trace 并认领。
 *
 * @param workspacePath 工作区路径
 * @param agentType Agent 类型（如 "opencode", "cursor" 等）
 * @returns 认领结果
 */
export async function checkAndClaimTrace(
  workspacePath: string,
  agentType: string
): Promise<HandoffResult> {
  try {
    const sessionsJsonPath = await getSessionsJsonPath(workspacePath);
    const sessions = readSessionsJson(sessionsJsonPath);

    // 查找匹配的 pending trace
    for (const [traceId, entry] of Object.entries(sessions.pending)) {
      // 检查 worktree 是否匹配（如果 pending trace 指定了 worktree）
      if (entry.worktree && entry.worktree !== workspacePath) {
        continue;
      }

      if (entry.targetAgent === agentType) {
        // 认领：移动到 active
        const sessionId = nanoid();
        const activeEntry: ActiveSessionEntry = {
          sessionId,
          traceId,
          agentType,
          status: "active",
          startedAt: new Date().toISOString(),
          worktree: workspacePath,
        };

        delete sessions.pending[traceId];
        sessions.active[sessionId] = activeEntry;
        writeSessionsJson(sessionsJsonPath, sessions);

        // 设置环境变量
        process.env.AGENTLOG_TRACE_ID = traceId;

        console.log(`[AgentLog] 认领 trace: ${traceId} (agent: ${agentType})`);

        return {
          success: true,
          traceId,
          sessionId,
        };
      }
    }

    return { success: false, error: "没有找到匹配的 pending trace" };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 从消息中提取 Trace ID。
 * 支持格式: "Trace: XXXX", "trace:XXXX", "Trace XXXX"
 *
 * @param message 消息文本
 * @returns 提取的 Trace ID 或 null
 */
export function extractTraceIdFromMessage(message: string): string | null {
  // 匹配多种格式: "Trace: XXXX", "trace:XXXX", "Trace XXXX"
  const patterns = [
    /Trace[:\s]+([A-Z0-9]+)/i,
    /trace[-_]?id[:\s]+([A-Z0-9]+)/i,
    /\[([A-Z0-9]{26})\]/, // ULID 格式
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * 查询 pending traces。
 *
 * @param workspacePath 工作区路径
 * @param agentType 可选，按 agent 类型过滤
 * @returns pending traces 列表
 */
export async function queryPendingTraces(
  workspacePath: string,
  agentType?: string
): Promise<TraceSearchResult[]> {
  try {
    const params = new URLSearchParams({ workspacePath });
    if (agentType) params.set("agentType", agentType);

    const response = await apiRequest<{
      success: boolean;
      data: Array<{ traceId: string; entry: PendingTraceEntry }>;
    }>("GET", `/api/traces/pending?${params.toString()}`);

    return response.data.map((item) => ({
      traceId: item.traceId,
      taskGoal: item.entry.taskGoal ?? "",
      targetAgent: item.entry.targetAgent,
      createdAt: item.entry.createdAt,
    }));
  } catch (err) {
    console.error(`[AgentLog] 查询 pending traces 失败: ${err}`);
    return [];
  }
}

/**
 * 认领 trace。
 *
 * @param traceId Trace ID
 * @param agentType Agent 类型
 * @param workspacePath 工作区路径
 * @returns 认领结果
 */
export async function claimTrace(
  traceId: string,
  agentType: string,
  workspacePath: string
): Promise<HandoffResult> {
  try {
    const sessionsJsonPath = await getSessionsJsonPath(workspacePath);
    const sessions = readSessionsJson(sessionsJsonPath);

    // 检查 trace 是否在 pending 中
    if (!sessions.pending[traceId]) {
      return { success: false, error: "Trace 不在 pending 状态" };
    }

    // 认领
    const sessionId = nanoid();
    const activeEntry: ActiveSessionEntry = {
      sessionId,
      traceId,
      agentType,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    delete sessions.pending[traceId];
    sessions.active[sessionId] = activeEntry;
    writeSessionsJson(sessionsJsonPath, sessions);

    // 设置环境变量
    process.env.AGENTLOG_TRACE_ID = traceId;

    // 同时调用 API 更新状态
    try {
      await apiRequest("POST", `/api/traces/${traceId}/resume`, {
        agentType,
        workspacePath,
      });
    } catch {
      // API 调用失败不影响本地状态
    }

    console.log(`[AgentLog] 认领 trace: ${traceId} (agent: ${agentType})`);

    return { success: true, traceId, sessionId };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 获取当前 active session。
 *
 * @param workspacePath 工作区路径
 * @returns active session 或 null
 */
export async function getActiveSession(
  workspacePath: string
): Promise<ActiveSessionEntry | null> {
  try {
    const sessionsJsonPath = await getSessionsJsonPath(workspacePath);
    const sessions = readSessionsJson(sessionsJsonPath);
    const activeEntries = Object.values(sessions.active);
    return activeEntries.length > 0 ? activeEntries[0] : null;
  } catch {
    return null;
  }
}

/**
 * 完成当前 session。
 *
 * @param workspacePath 工作区路径
 * @returns 是否成功
 */
export async function completeActiveSession(
  workspacePath: string
): Promise<boolean> {
  try {
    const sessionsJsonPath = await getSessionsJsonPath(workspacePath);
    const sessions = readSessionsJson(sessionsJsonPath);

    const activeEntries = Object.values(sessions.active);
    if (activeEntries.length === 0) {
      return false;
    }

    const sessionId = activeEntries[0].sessionId;
    delete sessions.active[sessionId];
    writeSessionsJson(sessionsJsonPath, sessions);

    console.log(`[AgentLog] 完成 session: ${sessionId}`);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Skill Metadata
// ─────────────────────────────────────────────

export const skillMetadata = {
  name: "agentlog-handoff",
  description: "AgentLog trace handoff and management skill",
  version: "1.0.0",
  functions: [
    {
      name: "checkAndClaimTrace",
      description: "启动时检查并认领 pending traces",
      parameters: {
        type: "object",
        properties: {
          workspacePath: { type: "string", description: "工作区路径" },
          agentType: { type: "string", description: "Agent 类型" },
        },
        required: ["workspacePath", "agentType"],
      },
    },
    {
      name: "extractTraceIdFromMessage",
      description: "从消息中提取 Trace ID",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "消息文本" },
        },
        required: ["message"],
      },
    },
    {
      name: "queryPendingTraces",
      description: "查询 pending traces",
      parameters: {
        type: "object",
        properties: {
          workspacePath: { type: "string", description: "工作区路径" },
          agentType: { type: "string", description: "Agent 类型（可选）" },
        },
        required: ["workspacePath"],
      },
    },
    {
      name: "claimTrace",
      description: "认领 trace",
      parameters: {
        type: "object",
        properties: {
          traceId: { type: "string", description: "Trace ID" },
          agentType: { type: "string", description: "Agent 类型" },
          workspacePath: { type: "string", description: "工作区路径" },
        },
        required: ["traceId", "agentType", "workspacePath"],
      },
    },
  ],
};

export default skillMetadata;
