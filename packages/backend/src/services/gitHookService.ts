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
} from "./gitService.js";
import { createSpan, getTraceById } from "./traceService.js";
import type { ActorType } from "./traceService.js";

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

// ─────────────────────────────────────────────
// Hook 脚本模板
// ─────────────────────────────────────────────

const POST_COMMIT_HOOK_TEMPLATE = `#!/bin/bash
# AgentLog Git Post-Commit Hook
# 自动生成，请勿手动修改

AGENTLOG_GATEWAY_URL="\${AGENTLOG_GATEWAY_URL:-http://localhost:7892}"
WORKSPACE_PATH="\${AGENTLOG_WORKSPACE_PATH:-$(pwd)}"
TRACE_ID="\${AGENTLOG_TRACE_ID:-}"
COMMIT_HASH="\${GIT_COMMIT_HASH:-$(git rev-parse HEAD 2>/dev/null || echo "")}"
PARENT_HASH="\${GIT_PARENT_COMMIT_HASH:-$(git rev-parse HEAD^ 2>/dev/null || echo "")}"

if [ -z "$COMMIT_HASH" ]; then
  exit 0
fi

# 构建请求体
REQUEST_BODY="{\\"workspacePath\\":\\"\${WORKSPACE_PATH}\\",\\"commitHash\\":\\"\${COMMIT_HASH}\\",\\"parentCommitHash\\":\\"\${PARENT_HASH}\\"}"

# 如果有 TRACE_ID，添加到请求体
if [ -n "$TRACE_ID" ]; then
  REQUEST_BODY="{\\"workspacePath\\":\\"\${WORKSPACE_PATH}\\",\\"commitHash\\":\\"\${COMMIT_HASH}\\",\\"parentCommitHash\\":\\"\${PARENT_HASH}\\",\\"traceId\\":\\"\${TRACE_ID}\\"}"
fi

# 异步调用 AgentLog 网关，不阻塞 git 流程
curl -s -X POST "\${AGENTLOG_GATEWAY_URL}/api/hooks/post-commit" \\
  -H "Content-Type: application/json" \\
  -d "$REQUEST_BODY" \\
  > /dev/null 2>&1 &

exit 0
`;

// ─────────────────────────────────────────────
// Hook 安装
// ─────────────────────────────────────────────

/**
 * 在指定工作区安装 Git post-commit 钩子
 */
export async function installGitHook(workspacePath: string): Promise<GitHookInstallResult> {
  const gitDir = path.join(workspacePath, ".git");
  const hooksDir = path.join(gitDir, "hooks");
  const hookPath = path.join(hooksDir, "post-commit");

  try {
    // 验证目录存在
    if (!fs.existsSync(gitDir)) {
      return { success: false, error: "不是 Git 仓库" };
    }

    // 创建 hooks 目录
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    // 检查是否已安装（检查是否包含 AgentLog 标记）
    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, "utf-8");
      if (existing.includes("AgentLog")) {
        return { success: true, hookPath };
      }
      // 备份原有钩子
      const backup = `${hookPath}.agentlog.backup`;
      fs.writeFileSync(backup, existing);
    }

    // 写入新钩子
    fs.writeFileSync(hookPath, POST_COMMIT_HOOK_TEMPLATE, { mode: 0o755 });

    return { success: true, hookPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * 卸载 Git post-commit 钩子
 */
export async function uninstallGitHook(workspacePath: string): Promise<GitHookInstallResult> {
  const hookPath = path.join(workspacePath, ".git", "hooks", "post-commit");

  try {
    if (fs.existsSync(hookPath)) {
      const content = fs.readFileSync(hookPath, "utf-8");
      if (content.includes("AgentLog")) {
        fs.unlinkSync(hookPath);
        return { success: true };
      }
    }
    return { success: false, error: "未找到 AgentLog 钩子" };
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
  return content.includes("AgentLog");
}

// ─────────────────────────────────────────────
// Post-Commit 回调处理
// ─────────────────────────────────────────────

/**
 * 处理 post-commit 回调：
 * 1. 提取 commit 信息
 * 2. 创建 Human Override Span
 * 3. 记录变更文件
 */
export async function handlePostCommitCallback(
  params: PostCommitCallback
): Promise<{ success: boolean; spanId?: string; error?: string }> {
  const { workspacePath, commitHash, parentCommitHash, agentId, sessionId, traceId: paramTraceId } = params;

  // 优先级：参数 traceId > 环境变量 > git config > agentId > "system"
  let traceId = paramTraceId ?? process.env.AGENTLOG_TRACE_ID ?? agentId ?? null;

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
