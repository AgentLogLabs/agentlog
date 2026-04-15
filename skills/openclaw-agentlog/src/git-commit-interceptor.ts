/**
 * Git Commit Interceptor
 *
 * Intercepts git commit operations and binds traces to commits.
 * This module provides:
 * - Commit detection during tool calls
 * - Trace-to-commit binding via backend API
 */

import { execSync } from "child_process";
import { getGitConfig, getCurrentCommitHash, getRepoRoot } from "./git-config";

const BACKEND_URL = process.env.AGENTLOG_BACKEND_URL ?? "http://localhost:7892";

interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  changedFiles: string[];
}

interface BindResult {
  success: boolean;
  commitHash?: string;
  traceId?: string;
  error?: string;
}

export async function getCommitInfo(workspacePath: string): Promise<CommitInfo | null> {
  try {
    const hash = getCurrentCommitHash(workspacePath);
    if (!hash) {
      return null;
    }

    const logOutput = execSync(
      `git log -1 --format="%an|%ae|%ai|%s"`,
      { encoding: "utf-8", cwd: workspacePath }
    ).trim();

    const [authorName, authorEmail, committedAt, ...messageParts] = logOutput.split("|");
    const message = messageParts.join("|");

    let changedFiles: string[] = [];
    try {
      const diffOutput = execSync(`git diff --name-only HEAD^ HEAD`, {
        encoding: "utf-8",
        cwd: workspacePath,
      }).trim();
      changedFiles = diffOutput.split("\n").filter(Boolean);
    } catch {
      // Initial commit may not have parent
      try {
        const diffOutput = execSync(`git diff --name-only 4b825dc642cb6eb9a060e54bf8d69288fbee4904 HEAD`, {
          encoding: "utf-8",
          cwd: workspacePath,
        }).trim();
        changedFiles = diffOutput.split("\n").filter(Boolean);
      } catch {
        changedFiles = [];
      }
    }

    return {
      hash,
      shortHash: hash.slice(0, 8),
      message,
      authorName,
      authorEmail,
      committedAt,
      changedFiles,
    };
  } catch {
    return null;
  }
}

export async function isGitCommitTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<boolean> {
  const commitCommands = [
    "git commit",
    "git.commit",
    "commit",
    "git_commit",
    "GitCommit",
  ];

  if (!commitCommands.includes(toolName)) {
    return false;
  }

  const inputStr = JSON.stringify(toolInput).toLowerCase();
  const commitIndicators = ["-m ", "--message", "commit -m", "git commit -m", "git commit -am", "git commit --all"];
  return commitIndicators.some((indicator) => inputStr.includes(indicator));
}

export async function bindTraceToCommit(
  traceId: string,
  workspacePath: string
): Promise<BindResult> {
  try {
    const commitHash = await getCurrentCommitHash(workspacePath);
    if (!commitHash) {
      return { success: false, error: "No commit found" };
    }

    const repoRoot = await getRepoRoot(workspacePath);

    const response = await fetch(`${BACKEND_URL}/api/traces/${traceId}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commitHash,
        workspacePath: repoRoot,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `API error: ${response.status} ${errorText}` };
    }

    const result = await response.json() as { success: boolean; error?: string };
    return {
      success: result.success,
      commitHash,
      traceId,
      error: result.error,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

export async function writeTraceIdToGitConfig(
  traceId: string,
  workspacePath: string
): Promise<void> {
  try {
    await getGitConfig(workspacePath, "agentlog.traceId");
    execSync(`git config agentlog.traceId "${traceId}"`, {
      encoding: "utf-8",
      cwd: workspacePath,
    });
  } catch {
    // Ignore errors - git config write failure shouldn't break the flow
  }
}

export async function getTraceIdFromGitConfig(
  workspacePath: string
): Promise<string | null> {
  return getGitConfig(workspacePath, "agentlog.traceId");
}

export async function clearTraceIdFromGitConfig(
  workspacePath: string
): Promise<void> {
  try {
    execSync(`git config --unset agentlog.traceId`, {
      encoding: "utf-8",
      cwd: workspacePath,
    });
  } catch {
    // Ignore errors
  }
}

export async function interceptAndBind(
  traceId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  workspacePath: string
): Promise<BindResult | null> {
  const isCommit = await isGitCommitTool(toolName, toolInput);
  if (!isCommit) {
    return null;
  }

  await writeTraceIdToGitConfig(traceId, workspacePath);

  return bindTraceToCommit(traceId, workspacePath);
}
