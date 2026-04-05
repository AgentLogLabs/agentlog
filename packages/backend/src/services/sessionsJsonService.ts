/**
 * @agentlog/backend — sessions.json Service
 *
 * 管理 .git/agentlog/sessions.json 文件，实现 trace 的 pending 和 active session 管理。
 *
 * 文件位置：.git/agentlog/sessions.json（通过 git-common-dir 确保跨 worktree 共享）
 */

import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import simpleGit from "simple-git";
import type {
  SessionsJson,
  PendingTraceEntry,
  ActiveSessionEntry,
} from "@agentlog/shared";

const AGENTLOG_DIR = "agentlog";
const SESSIONS_FILE = "sessions.json";

/**
 * 获取 sessions.json 文件的绝对路径。
 * 通过 git rev-parse --git-common-dir 确保跨 worktree 共享。
 *
 * @param workspacePath 工作区路径（可以是主仓库或 worktree 路径）
 * @returns sessions.json 文件的绝对路径
 */
export async function getSessionsJsonPath(workspacePath: string): Promise<string> {
  const gitCommonDir = (await simpleGit(workspacePath).revparse(["--git-common-dir"])).trim();
  const absoluteGitCommonDir = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(workspacePath, gitCommonDir);
  return path.join(absoluteGitCommonDir, AGENTLOG_DIR, SESSIONS_FILE);
}

/**
 * 获取 sessions.json 所在目录的绝对路径。
 */
export async function getSessionsDir(workspacePath: string): Promise<string> {
  const gitCommonDir = (await simpleGit(workspacePath).revparse(["--git-common-dir"])).trim();
  const absoluteGitCommonDir = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(workspacePath, gitCommonDir);
  return path.join(absoluteGitCommonDir, AGENTLOG_DIR);
}

/**
 * 读取 sessions.json 内容。
 * 如果文件不存在，返回空的 SessionsJson 结构。
 */
export function readSessionsJson(sessionsJsonPath: string): SessionsJson {
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
 * 原子写入 sessions.json。
 * 先写入临时文件，再 rename（原子操作）。
 */
export function writeSessionsJson(sessionsJsonPath: string, data: SessionsJson): void {
  const dir = path.dirname(sessionsJsonPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${sessionsJsonPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, sessionsJsonPath);
}

/**
 * 读取 sessions.json（异步版本，通过 workspacePath 自动定位）。
 */
export async function readSessionsJsonByWorkspace(
  workspacePath: string
): Promise<SessionsJson> {
  const sessionsJsonPath = await getSessionsJsonPath(workspacePath);
  return readSessionsJson(sessionsJsonPath);
}

/**
 * 写入 sessions.json（异步版本）。
 */
export async function writeSessionsJsonByWorkspace(
  workspacePath: string,
  data: SessionsJson
): Promise<void> {
  const sessionsJsonPath = await getSessionsJsonPath(workspacePath);
  writeSessionsJson(sessionsJsonPath, data);
}

/**
 * 创建待认领的 pending trace。
 *
 * @param workspacePath 工作区路径
 * @param traceId Trace ID
 * @param targetAgent 目标 Agent 类型
 * @param taskGoal 任务目标（可选）
 * @returns 更新后的 pending 条目
 */
export async function createPendingTrace(
  workspacePath: string,
  traceId: string,
  targetAgent: string,
  taskGoal?: string
): Promise<PendingTraceEntry> {
  const sessions = await readSessionsJsonByWorkspace(workspacePath);

  const entry: PendingTraceEntry = {
    createdAt: new Date().toISOString(),
    targetAgent,
    ...(taskGoal ? { taskGoal } : {}),
  };

  sessions.pending[traceId] = entry;
  await writeSessionsJsonByWorkspace(workspacePath, sessions);

  console.log(`[sessionsJson] Created pending trace: ${traceId} -> ${targetAgent}`);
  return entry;
}

/**
 * Agent 认领一个 pending trace。
 * 将 pending 条目移动到 active。
 *
 * @param workspacePath 工作区路径
 * @param traceId Trace ID
 * @param agentType Agent 类型
 * @returns 创建的 active session 条目，如果 trace 不存在或已被认领则返回 null
 */
export async function claimPendingTrace(
  workspacePath: string,
  traceId: string,
  agentType: string
): Promise<ActiveSessionEntry | null> {
  const sessions = await readSessionsJsonByWorkspace(workspacePath);

  if (!sessions.pending[traceId]) {
    console.log(`[sessionsJson] Pending trace not found: ${traceId}`);
    return null;
  }

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
  await writeSessionsJsonByWorkspace(workspacePath, sessions);

  console.log(`[sessionsJson] Claimed trace: ${traceId} -> ${agentType} (session: ${sessionId})`);
  return activeEntry;
}

/**
 * 完成一个 active session。
 * 从 active 中移除条目。
 *
 * @param workspacePath 工作区路径
 * @param sessionId Session ID
 * @returns 是否成功完成
 */
export async function completeActiveSession(
  workspacePath: string,
  sessionId: string
): Promise<boolean> {
  const sessions = await readSessionsJsonByWorkspace(workspacePath);

  if (!sessions.active[sessionId]) {
    console.log(`[sessionsJson] Active session not found: ${sessionId}`);
    return false;
  }

  delete sessions.active[sessionId];
  await writeSessionsJsonByWorkspace(workspacePath, sessions);

  console.log(`[sessionsJson] Completed session: ${sessionId}`);
  return true;
}

/**
 * 获取所有 pending traces。
 *
 * @param workspacePath 工作区路径
 * @param agentType 可选，按 Agent 类型过滤
 * @returns 匹配的 pending traces
 */
export async function getPendingTraces(
  workspacePath: string,
  agentType?: string
): Promise<Array<{ traceId: string; entry: PendingTraceEntry }>> {
  const sessions = await readSessionsJsonByWorkspace(workspacePath);
  const result: Array<{ traceId: string; entry: PendingTraceEntry }> = [];

  for (const [traceId, entry] of Object.entries(sessions.pending) as [string, PendingTraceEntry][]) {
    if (!agentType || entry.targetAgent === agentType) {
      result.push({ traceId, entry });
    }
  }

  return result;
}

/**
 * 获取当前活跃的 session。
 *
 * @param workspacePath 工作区路径
 * @returns 当前 active session，如果没有则返回 null
 */
export async function getActiveSession(
  workspacePath: string
): Promise<ActiveSessionEntry | null> {
  const sessions = await readSessionsJsonByWorkspace(workspacePath);
  const activeEntries = Object.values(sessions.active);
  return activeEntries.length > 0 ? activeEntries[0] : null;
}

/**
 * 获取指定 traceId 对应的 session。
 *
 * @param workspacePath 工作区路径
 * @param traceId Trace ID
 * @returns 对应的 active session，如果没有则返回 null
 */
export async function getActiveSessionByTraceId(
  workspacePath: string,
  traceId: string
): Promise<ActiveSessionEntry | null> {
  const sessions = await readSessionsJsonByWorkspace(workspacePath);

  for (const entry of Object.values(sessions.active) as ActiveSessionEntry[]) {
    if (entry.traceId === traceId) {
      return entry;
    }
  }

  return null;
}

/**
 * 删除一个 pending trace。
 *
 * @param workspacePath 工作区路径
 * @param traceId Trace ID
 * @returns 是否成功删除
 */
export async function deletePendingTrace(
  workspacePath: string,
  traceId: string
): Promise<boolean> {
  const sessions = await readSessionsJsonByWorkspace(workspacePath);

  if (!sessions.pending[traceId]) {
    return false;
  }

  delete sessions.pending[traceId];
  await writeSessionsJsonByWorkspace(workspacePath, sessions);

  console.log(`[sessionsJson] Deleted pending trace: ${traceId}`);
  return true;
}

/**
 * 清除所有 active sessions。
 * 通常在系统重启或初始化时调用。
 *
 * @param workspacePath 工作区路径
 */
export async function clearActiveSessions(workspacePath: string): Promise<void> {
  const sessions = await readSessionsJsonByWorkspace(workspacePath);
  sessions.active = {};
  await writeSessionsJsonByWorkspace(workspacePath, sessions);
  console.log(`[sessionsJson] Cleared all active sessions`);
}
