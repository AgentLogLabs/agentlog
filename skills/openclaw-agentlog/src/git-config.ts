/**
 * Git Config Utilities
 *
 * Provides utilities for reading and writing git config values,
 * specifically for storing and retrieving the current traceId.
 */

import { execSync } from "child_process";
import path from "path";

const GIT_CONFIG_CACHE = new Map<string, string | null>();

export async function getGitConfig(
  workspacePath: string,
  key: string
): Promise<string | null> {
  const cacheKey = `${workspacePath}:${key}`;
  if (GIT_CONFIG_CACHE.has(cacheKey)) {
    return GIT_CONFIG_CACHE.get(cacheKey) ?? null;
  }

  try {
    const value = execSync(`git config --get ${key}`, {
      encoding: "utf-8",
      cwd: workspacePath,
    }).trim();
    const result = value || null;
    GIT_CONFIG_CACHE.set(cacheKey, result);
    return result;
  } catch {
    GIT_CONFIG_CACHE.set(cacheKey, null);
    return null;
  }
}

export async function setGitConfig(
  workspacePath: string,
  key: string,
  value: string
): Promise<void> {
  try {
    execSync(`git config ${key} "${value}"`, {
      encoding: "utf-8",
      cwd: workspacePath,
    });
    const cacheKey = `${workspacePath}:${key}`;
    GIT_CONFIG_CACHE.set(cacheKey, value);
  } catch (err) {
    throw new Error(`Failed to set git config ${key}: ${err}`);
  }
}

export async function unsetGitConfig(
  workspacePath: string,
  key: string
): Promise<void> {
  try {
    execSync(`git config --unset ${key}`, {
      encoding: "utf-8",
      cwd: workspacePath,
    });
    const cacheKey = `${workspacePath}:${key}`;
    GIT_CONFIG_CACHE.delete(cacheKey);
  } catch {
    // Ignore errors if key doesn't exist
  }
}

export function clearGitConfigCache(): void {
  GIT_CONFIG_CACHE.clear();
}

export async function getRepoRoot(workspacePath: string): Promise<string> {
  try {
    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf-8",
      cwd: workspacePath,
    }).trim();
    const absoluteGitCommonDir = path.isAbsolute(gitCommonDir)
      ? gitCommonDir
      : path.resolve(workspacePath, gitCommonDir);
    return path.dirname(absoluteGitCommonDir);
  } catch {
    return workspacePath;
  }
}

export async function getCurrentCommitHash(
  workspacePath: string
): Promise<string | null> {
  try {
    return execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      cwd: workspacePath,
    }).trim();
  } catch {
    return null;
  }
}

export async function isGitRepo(workspacePath: string): Promise<boolean> {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      encoding: "utf-8",
      cwd: workspacePath,
    });
    return true;
  } catch {
    return false;
  }
}
