/**
 * @agentlog/backend — Git Hook Service
 *
 * 提供 Git Hook 安装和回调处理能力：
 * 1. 自动安装 post-commit 钩子
 * 2. 回调处理：提取 commit diff 并记录为 Human Override Span
 * 3. 触发 JIT Context Hydration（UC-003）
 */

import fs from "node:fs";
import path from "node:path";
import {
  getCommitInfo,
  getRecentCommits,
  getStagedFiles,
  getModifiedFiles,
  getRepoInfo,
  isGitRepo,
  getGitConfig,
  injectPostCommitHook,
  removePostCommitHook,
} from "./gitService.js";
import { createSpan, getTraceById, transitionToInProgress } from "./traceService.js";
import type { ActorType } from "./traceService.js";
import {
  getActiveSessionByTraceId,
  completeActiveSession,
} from "./sessionsJsonService.js";
import {
  upsertCommitBinding,
  getSessionsForNewCommit,
  bindSessionsToCommit,
} from "./logService.js";

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

export interface GitHookInstallResult {
  success: boolean;
  hookPath?: string;
  error?: string;
}

export interface PostCommitCallback {
  workspacePath: string;
  commitHash: string;
  parentCommitHash?: string;
  agentId?: string;
  sessionId?: string;
  traceId?: string;
}

// POST_COMMIT_HOOK_TEMPLATE 已废弃，统一使用 gitService.injectPostCommitHook

// ─────────────────────────────────────────────
// Hook 安装
// ─────────────────────────────────────────────

/**
 * 在指定工作区安装 Git post-commit 钩子。
 * 统一委托给 gitService.injectPostCommitHook，使用 /api/commits/hook 端点。
 */
export async function installGitHook(workspacePath: string): Promise<GitHookInstallResult> {
  try {
    await injectPostCommitHook(workspacePath);
    const hookPath = path.join(workspacePath, ".git", "hooks", "post-commit");
    return { success: true, hookPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * 卸载 Git post-commit 钩子。
 * 统一委托给 gitService.removePostCommitHook。
 */
export async function uninstallGitHook(workspacePath: string): Promise<GitHookInstallResult> {
  try {
    await removePostCommitHook(workspacePath);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * 检查钩子是否已安装
 */
export function isGitHookInstalled(workspacePath: string): boolean {
  const hookPath = path.join(workspacePath, ".git", "hooks", "post-commit");
  if (!fs.existsSync(hookPath)) {
    return false;
  }
  const content = fs.readFileSync(hookPath, "utf-8");
  return content.toLowerCase().includes("agentlog");
}

// ─────────────────────────────────────────────
// Post-Commit 回调处理
// ─────────────────────────────────────────────

/**
 * 处理 post-commit 回调：
 * 1. 提取 commit 信息
 * 2. 创建 Human Override Span
 * 3. 记录变更文件
 * 4. 处理 sessions.json 中的 active session
 * 5. 状态转换：pending_handoff -> in_progress
 */
export async function handlePostCommitCallback(
  params: PostCommitCallback
): Promise<{ success: boolean; spanId?: string; error?: string }> {
  const { workspacePath, commitHash, parentCommitHash, agentId, sessionId, traceId: paramTraceId } = params;

  // 优先级：参数 traceId > 环境变量 > git config > sessions.json active > agentId > "system"
  let traceId = paramTraceId ?? process.env.AGENTLOG_TRACE_ID ?? agentId ?? null;

  // 尝试从 sessions.json 的 active session 获取 traceId
  if (!traceId) {
    try {
      const activeSession = await getActiveSessionByTraceId(workspacePath, traceId ?? "");
      if (activeSession) {
        traceId = activeSession.traceId;
        console.log(`[GitHook] 从 sessions.json active session 获取 traceId: ${traceId}`);
      }
    } catch (err) {
      console.log(`[GitHook] 读取 sessions.json active session 失败: ${err}`);
    }
  }

  // 如果还没有，尝试从 git config 读取
  if (!traceId) {
    try {
      const gitConfigTraceId = await getGitConfig(workspacePath, "agentlog.traceId");
      if (gitConfigTraceId) {
        traceId = gitConfigTraceId;
        console.log(`[GitHook] 从 git config 读取 traceId: ${traceId}`);
      }
    } catch (err) {
      console.log(`[GitHook] 读取 git config traceId 失败: ${err}`);
    }
  }

  // 兜底默认值
  traceId ??= "system";

  try {
    // 获取 commit 详细信息和仓库信息
    const [commitInfo, repoInfo] = await Promise.all([
      getCommitInfo(workspacePath, commitHash),
      getRepoInfo(workspacePath),
    ]);

    // 检查 trace 状态，如果是 pending_handoff 则转换为 in_progress
    const trace = getTraceById(traceId);
    if (trace && trace.status === "pending_handoff") {
      transitionToInProgress(traceId);
      console.log(`[GitHook] Trace ${traceId} 从 pending_handoff 转为 in_progress`);
    }

    // 如果有 active session，清理它
    if (traceId) {
      try {
        const activeSession = await getActiveSessionByTraceId(workspacePath, traceId);
        if (activeSession) {
          await completeActiveSession(workspacePath, activeSession.sessionId);
          console.log(`[GitHook] 清理 active session: ${activeSession.sessionId}`);
        }
      } catch (err) {
        console.log(`[GitHook] 清理 active session 失败: ${err}`);
      }
    }

    // 创建 Human Override Span
    const span = createSpan({
      traceId,
      parentSpanId: null,
      actorType: "human" as ActorType,
      actorName: "git:human-override",
      payload: {
        source: "git-hook",
        event: "post-commit",
        commitHash,
        parentCommitHash,
        branch: repoInfo.currentBranch,
        message: commitInfo.message,
        author: commitInfo.authorName,
        authorEmail: commitInfo.authorEmail,
        committedAt: commitInfo.committedAt,
        changedFiles: commitInfo.changedFiles,
        isHumanOverride: true,
        sessionId,
      },
    });

    console.log(
      `[GitHook] Human Override detected: commit=${commitHash}, files=${commitInfo.changedFiles.length}, span=${span.id}`
    );

    // 记录 commit 到 commit_bindings 表，并绑定当前工作区的 sessions
    try {
      const sessions = await getSessionsForNewCommit(workspacePath, 20);
      const sessionIds = sessions.map((s) => s.id);
      if (sessionIds.length > 0) {
        bindSessionsToCommit(sessionIds, commitHash);
      }
      upsertCommitBinding({
        commitHash,
        sessionIds,
        traceIds: traceId && traceId !== "system" ? [traceId] : [],
        message: commitInfo.message,
        committedAt: commitInfo.committedAt,
        authorName: commitInfo.authorName,
        authorEmail: commitInfo.authorEmail,
        changedFiles: commitInfo.changedFiles,
        workspacePath,
      });
      console.log(`[GitHook] Commit binding recorded: ${commitHash.slice(0, 8)}, sessions=${sessionIds.length}, traceId=${traceId}`);
    } catch (bindErr) {
      console.warn(`[GitHook] 记录 commit binding 失败: ${bindErr}`);
    }

    return { success: true, spanId: span.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[GitHook] Post-commit 处理失败: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * 获取工作区的 Git 状态摘要
 */
export async function getGitStatusSummary(
  workspacePath: string
): Promise<{
  isRepo: boolean;
  currentBranch: string | null;
  stagedFiles: string[];
  modifiedFiles: string[];
  recentCommits: Array<{ hash: string; message: string; date: string }>;
}> {
  const repoStatus = await isGitRepo(workspacePath);
  if (!repoStatus) {
    return {
      isRepo: false,
      currentBranch: null,
      stagedFiles: [],
      modifiedFiles: [],
      recentCommits: [],
    };
  }

  const [stagedFiles, modifiedFiles, recentCommits, repoInfo] = await Promise.all([
    getStagedFiles(workspacePath),
    getModifiedFiles(workspacePath),
    getRecentCommits(workspacePath, 5),
    getRepoInfo(workspacePath),
  ]);

  return {
    isRepo: true,
    currentBranch: repoInfo.currentBranch,
    stagedFiles,
    modifiedFiles,
    recentCommits: recentCommits.map((c) => ({
      hash: c.hash,
      message: c.message,
      date: c.committedAt,
    })),
  };
}
