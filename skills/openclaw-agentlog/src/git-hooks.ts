/**
 * Git Hooks Utilities
 *
 * Provides utilities for managing git hooks, specifically:
 * - Installing post-commit hooks that notify AgentLog backend
 * - Removing installed hooks
 * - Checking hook installation status
 */

import fs from "node:fs";
import path from "path";
import { execSync } from "child_process";
import { getCurrentCommitHash, getRepoRoot } from "./git-config";

const HOOK_MARKER = "# agentlog-hook";

interface HookInstallResult {
  success: boolean;
  hookPath?: string;
  error?: string;
}

async function getHooksDir(workspacePath: string): Promise<string> {
  try {
    const hooksPath = execSync("git rev-parse --git-path hooks", {
      encoding: "utf-8",
      cwd: workspacePath,
    }).trim();
    if (path.isAbsolute(hooksPath)) {
      return hooksPath;
    }
    return path.resolve(workspacePath, hooksPath);
  } catch {
    const rootPath = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      cwd: workspacePath,
    }).trim();
    return path.join(rootPath, ".git", "hooks");
  }
}

function buildPostCommitScript(backendUrl: string): string {
  const endpoint = `${backendUrl}/api/commits/hook`;

  return `${HOOK_MARKER}
AGENTLOG_COMMIT_HASH=$(git rev-parse HEAD)
AGENTLOG_WORKSPACE=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
AGENTLOG_LOG="\${TMPDIR:-/tmp}/agentlog-hook.log"
echo "[$(date '+%Y-%m-%dT%H:%M:%S')] post-commit fired: hash=$AGENTLOG_COMMIT_HASH workspace=$AGENTLOG_WORKSPACE" >> "$AGENTLOG_LOG" 2>/dev/null
curl -s -X POST '${endpoint}' \\
  -H 'Content-Type: application/json' \\
  -d "{\\\"commitHash\\\":\\\"$AGENTLOG_COMMIT_HASH\\\",\\\"workspacePath\\\":\\\"$AGENTLOG_WORKSPACE\\\"}" \\
  --max-time 3 >> "$AGENTLOG_LOG" 2>&1 || true
echo "" >> "$AGENTLOG_LOG" 2>/dev/null`;
}

export async function installPostCommitHook(
  workspacePath: string,
  backendUrl = "http://localhost:7892"
): Promise<HookInstallResult> {
  try {
    const hooksDir = await getHooksDir(workspacePath);
    const hookFile = path.join(hooksDir, "post-commit");

    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    if (fs.existsSync(hookFile)) {
      const existing = fs.readFileSync(hookFile, "utf-8");
      if (existing.includes(HOOK_MARKER)) {
        const endpoint = `${backendUrl}/api/commits/hook`;
        if (existing.includes(endpoint)) {
          return { success: true, hookPath: hookFile };
        }
        await removePostCommitHook(workspacePath);
      }
    }

    const hookScript = buildPostCommitScript(backendUrl);

    if (fs.existsSync(hookFile)) {
      fs.appendFileSync(hookFile, `\n${hookScript}\n`, "utf-8");
    } else {
      fs.writeFileSync(hookFile, `#!/bin/sh\n${hookScript}\n`, "utf-8");
    }

    fs.chmodSync(hookFile, 0o755);

    return { success: true, hookPath: hookFile };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

export async function removePostCommitHook(
  workspacePath: string
): Promise<HookInstallResult> {
  try {
    const hooksDir = await getHooksDir(workspacePath);
    const hookFile = path.join(hooksDir, "post-commit");

    if (!fs.existsSync(hookFile)) {
      return { success: true };
    }

    const content = fs.readFileSync(hookFile, "utf-8");
    if (!content.includes(HOOK_MARKER)) {
      return { success: true };
    }

    const cleaned = content
      .split("\n")
      .reduce<{ lines: string[]; inBlock: boolean }>(
        (acc, line) => {
          if (line.trim() === HOOK_MARKER) {
            return { ...acc, inBlock: true };
          }
          if (acc.inBlock && line.trim() === "") {
            return { lines: acc.lines, inBlock: false };
          }
          if (!acc.inBlock) {
            acc.lines.push(line);
          }
          return acc;
        },
        { lines: [], inBlock: false }
      )
      .lines.join("\n");

    fs.writeFileSync(hookFile, cleaned, "utf-8");

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

export function isPostCommitHookInstalled(workspacePath: string): boolean {
  try {
    const hooksDir = execSync("git rev-parse --git-path hooks", {
      encoding: "utf-8",
      cwd: workspacePath,
    }).trim();
    const absoluteHooksDir = path.isAbsolute(hooksDir)
      ? hooksDir
      : path.resolve(workspacePath, hooksDir);
    const hookFile = path.join(absoluteHooksDir, "post-commit");

    if (!fs.existsSync(hookFile)) {
      return false;
    }
    const content = fs.readFileSync(hookFile, "utf-8");
    return content.includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

export async function triggerPostCommit(
  workspacePath: string,
  backendUrl = "http://localhost:7892"
): Promise<void> {
  const commitHash = await getCurrentCommitHash(workspacePath);
  if (!commitHash) {
    throw new Error("No commit to bind");
  }

  const endpoint = `${backendUrl}/api/commits/hook`;
  const payload = JSON.stringify({
    commitHash,
    workspacePath,
  });

  execSync(`curl -s -X POST '${endpoint}' -H 'Content-Type: application/json' -d '${payload}' --max-time 3`, {
    encoding: "utf-8",
    cwd: workspacePath,
  });
}
