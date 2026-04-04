/**
 * @agentlog/backend — Git 集成服务
 *
 * 职责：
 *  1. 检测工作区是否为 Git 仓库
 *  2. 获取最新 / 指定 Commit 的元信息
 *  3. 获取 Commit 的变更文件列表
 *  4. 监听 post-commit 钩子（写入钩子脚本），实现自动绑定触发
 *  5. 为"自动绑定"场景提供"最近未绑定会话"的 Commit 候选列表
 */

import fs from "fs";
import path from "path";
import simpleGit, {
  DefaultLogFields,
  ListLogLine,
  SimpleGit,
} from "simple-git";

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

export interface CommitInfo {
  /** 完整 SHA-1 */
  hash: string;
  /** 短 SHA-1（前 8 位） */
  shortHash: string;
  /** Commit message（第一行） */
  message: string;
  /** 完整 message（含正文和 trailer） */
  body: string;
  /** 提交者姓名 */
  authorName: string;
  /** 提交者邮箱 */
  authorEmail: string;
  /** 提交时间（ISO 8601） */
  committedAt: string;
  /** 变更文件列表（相对于仓库根目录） */
  changedFiles: string[];
}

export interface GitRepoInfo {
  /** 仓库根目录的绝对路径 */
  rootPath: string;
  /** 当前分支名 */
  currentBranch: string;
  /** 远程 origin URL（若存在） */
  remoteOriginUrl?: string;
}

// ─────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────

/**
 * 为指定工作区路径创建 SimpleGit 实例。
 * 每次按需创建，不缓存，避免多工作区状态混淆。
 */
function git(workspacePath: string): SimpleGit {
  return simpleGit(workspacePath, {
    binary: "git",
    maxConcurrentProcesses: 4,
    trimmed: true,
  });
}

/**
 * 将 simple-git 的 log 条目映射为 CommitInfo（不含 changedFiles）。
 */
function mapLogEntry(
  entry: DefaultLogFields & ListLogLine,
): Omit<CommitInfo, "changedFiles"> {
  return {
    hash: entry.hash,
    shortHash: entry.hash.slice(0, 8),
    message: entry.message,
    body: entry.body ?? "",
    authorName: entry.author_name,
    authorEmail: entry.author_email,
    committedAt: new Date(entry.date).toISOString(),
  };
}

// ─────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────

/**
 * 判断指定路径是否处于一个 Git 仓库中。
 */
export async function isGitRepo(workspacePath: string): Promise<boolean> {
  try {
    const result = await git(workspacePath).checkIsRepo();
    return result;
  } catch {
    return false;
  }
}

/**
 * 获取仓库基本信息（根目录、当前分支、远程地址）。
 *
 * @throws 若不是 Git 仓库则抛出 Error
 */
export async function getRepoInfo(workspacePath: string): Promise<GitRepoInfo> {
  const g = git(workspacePath);

  const [rootPath, remotes] = await Promise.all([
    g.revparse(["--show-toplevel"]),
    g.getRemotes(true),
  ]);

  // 获取当前分支名：优先用 rev-parse（需要至少一个 commit），
  // 若失败（空仓库）则回退到 symbolic-ref（即使无 commit 也能工作）。
  let branch: string;
  try {
    branch = await g.revparse(["--abbrev-ref", "HEAD"]);
  } catch {
    try {
      branch = (await g.raw(["symbolic-ref", "--short", "HEAD"])).trim();
    } catch {
      branch = "unknown";
    }
  }

  const originRemote = remotes.find((r) => r.name === "origin");

  return {
    rootPath: rootPath.trim(),
    currentBranch: branch.trim(),
    remoteOriginUrl: originRemote?.refs?.fetch,
  };
}

/**
 * 获取指定 commit（或 HEAD）的详细信息，含变更文件列表。
 *
 * @param workspacePath 工作区路径
 * @param commitRef     Commit SHA 或引用，默认为 "HEAD"
 */
export async function getCommitInfo(
  workspacePath: string,
  commitRef = "HEAD",
): Promise<CommitInfo> {
  const g = git(workspacePath);

  // 获取 log 条目
  // 注意：不能用 { from: commitRef, to: commitRef }，因为 simple-git 会生成
  // git log commitRef..commitRef 范围查询，而 X..X 永远是空集。
  // 正确做法：将 commitRef 作为位置参数传入，等价于 git log -1 <commitRef>。
  const log = await g.log([commitRef, "--max-count=1"]);

  if (!log.latest) {
    throw new Error(`[GitService] 找不到 commit：${commitRef}`);
  }

  const base = mapLogEntry(log.latest);

  // 获取变更文件列表
  const changedFiles = await getChangedFiles(workspacePath, commitRef);

  return { ...base, changedFiles };
}

/**
 * 获取指定 commit 的变更文件列表（相对于仓库根目录）。
 *
 * @param workspacePath 工作区路径
 * @param commitRef     Commit SHA 或引用，默认为 "HEAD"
 */
export async function getChangedFiles(
  workspacePath: string,
  commitRef = "HEAD",
): Promise<string[]> {
  const g = git(workspacePath);

  // --name-only：只列出文件名；HEAD^..HEAD 表示此 commit 的变更
  // 对于初始 commit（没有父节点），使用 4b825dc 空树
  let diffOutput: string;
  try {
    diffOutput = await g.diff(["--name-only", `${commitRef}^`, commitRef]);
  } catch {
    // 初始 commit 没有父节点，使用空树
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    diffOutput = await g.diff(["--name-only", emptyTree, commitRef]);
  }

  return diffOutput
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * 获取最近 N 条 commit 的信息列表（不含 changedFiles，保持轻量）。
 *
 * @param workspacePath 工作区路径
 * @param maxCount      最多返回条数，默认 20
 */
export async function getRecentCommits(
  workspacePath: string,
  maxCount = 20,
): Promise<Omit<CommitInfo, "changedFiles">[]> {
  const g = git(workspacePath);

  const log = await g.log({ maxCount });

  return log.all.map(mapLogEntry);
}

/**
 * 获取当前工作区暂存区（Staged）的文件列表。
 * 可在用户执行 git commit 之前，预判哪些文件即将被提交。
 */
export async function getStagedFiles(workspacePath: string): Promise<string[]> {
  const g = git(workspacePath);

  // --cached：只看暂存区 diff；--name-only：只列文件名
  const output = await g.diff(["--cached", "--name-only"]);

  return output
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * 获取当前工作区所有已修改（含暂存 + 未暂存）的文件列表。
 */
export async function getModifiedFiles(
  workspacePath: string,
): Promise<string[]> {
  const g = git(workspacePath);
  const status = await g.status();

  return [
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
    ...status.staged,
  ].filter((value, index, self) => self.indexOf(value) === index); // 去重
}

/**
 * 读取 Git 配置项。
 * @param workspacePath 工作区路径
 * @param key 配置键名
 * @returns 配置值（不存在返回 null）
 */
export async function getGitConfig(
  workspacePath: string,
  key: string,
): Promise<string | null> {
  const g = git(workspacePath);
  try {
    // 使用 git config --get 读取配置
    const output = await g.raw(["config", "--get", key]);
    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 写入 Git 配置项（local级别）。
 * @param workspacePath 工作区路径
 * @param key 配置键名
 * @param value 配置值
 */
export async function setGitConfig(
  workspacePath: string,
  key: string,
  value: string,
): Promise<void> {
  const g = git(workspacePath);
  // 使用 git config 设置本地配置
  await g.raw(["config", key, value]);
}

// ─────────────────────────────────────────────
// Git Hook 注入（post-commit 自动触发绑定）
// ─────────────────────────────────────────────

const HOOK_MARKER = "# agentlog-hook";

/**
 * 获取指定路径的 Git 仓库根目录（即 `git rev-parse --show-toplevel` 的结果）。
 *
 * 在多 worktree 场景下，worktree 路径与仓库根目录不同。
 * 通过此函数可将不同 worktree 归一化到同一仓库根目录，方便跨 worktree 会话匹配。
 *
 * @param workspacePath 工作区路径（可以是主仓库或 worktree 路径）
 * @returns 仓库根目录绝对路径
 * @throws 若路径不是 Git 仓库则抛出 Error
 */
export async function getRepoRoot(workspacePath: string): Promise<string> {
  const g = git(workspacePath);
  // 使用 --git-common-dir 获取主仓库的 .git 目录，然后返回其父目录
  // 这样无论在主仓库还是 worktree 中，都能返回一致的仓库根目录
  const gitCommonDir = (await g.revparse(["--git-common-dir"])).trim();
  // gitCommonDir 可能是绝对路径或相对路径（相对于仓库根目录）
  // 如果是相对路径，则基于当前工作目录解析为绝对路径
  const absoluteGitCommonDir = path.isAbsolute(gitCommonDir) 
    ? gitCommonDir 
    : path.resolve(workspacePath, gitCommonDir);
  // 返回 .git 目录的父目录
  return path.dirname(absoluteGitCommonDir);
}

/**
 * 获取仓库实际使用的 hooks 目录绝对路径。
 * 优先通过 git rev-parse --git-path hooks 解析（自动尊重 core.hooksPath），
 * 未配置时回退到默认的 .git/hooks。
 *
 * 适配 husky / lefthook 等工具将 core.hooksPath 指向自定义目录的场景。
 */
async function getHooksDir(workspacePath: string): Promise<string> {
  const g = git(workspacePath);

  try {
    // git rev-parse --git-path hooks 能正确处理 core.hooksPath
    const hooksPath = (
      await g.raw(["rev-parse", "--git-path", "hooks"])
    ).trim();
    if (path.isAbsolute(hooksPath)) {
      return hooksPath;
    }
    // 相对路径基于 simple-git 工作目录解析为绝对路径
    return path.resolve(workspacePath, hooksPath);
  } catch {
    // 兜底：使用默认 hooks 目录
    const rootPath = (await g.revparse(["--show-toplevel"])).trim();
    return path.join(rootPath, ".git", "hooks");
  }
}

/**
 * 向仓库注入 post-commit 钩子脚本。
 *
 * 钩子内容：在每次 git commit 完成后，向 AgentLog 后台发送通知，
 * 后台据此自动将最近的未绑定会话与新 Commit 关联。
 *
 * 多 worktree 支持：
 * - 钩子脚本通过 `git rev-parse --show-toplevel` 动态获取当前 worktree 路径，
 *   而非硬编码工作区路径。这样同一仓库下的多个 worktree 共用同一个钩子脚本，
 *   每次提交时均能正确上报各自的 worktree 路径。
 * - 若钩子文件已存在 AgentLog 标记且 backendUrl 相同，则跳过注入避免重复；
 *   若 backendUrl 已变更，则移除旧段落并重新注入。
 *
 * @param workspacePath 工作区路径（可以是主仓库或 worktree 路径）
 * @param backendUrl    AgentLog 后台地址，默认 http://localhost:7892
 */
export async function injectPostCommitHook(
  workspacePath: string,
  backendUrl = "http://localhost:7892",
): Promise<void> {
  const hooksDir = await getHooksDir(workspacePath);
  const hookFile = path.join(hooksDir, "post-commit");

  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // 如果钩子已经包含我们的标记且 backendUrl 相同，跳过
  if (fs.existsSync(hookFile)) {
    const existing = fs.readFileSync(hookFile, "utf-8");
    if (existing.includes(HOOK_MARKER)) {
      // 检查 backendUrl 是否变更
      const endpoint = `${backendUrl}/api/commits/hook`;
      if (existing.includes(endpoint)) {
        console.log("[GitService] post-commit 钩子已存在且 backendUrl 一致，跳过注入");
        return;
      }
      // backendUrl 已变更，移除旧段落后重新注入
      console.log("[GitService] 检测到 backendUrl 变更，重新注入 post-commit 钩子");
      await removePostCommitHook(workspacePath);
    }
  }

  const hookScript = buildPostCommitScript(backendUrl);

  // 若已有钩子文件，追加；否则新建
  if (fs.existsSync(hookFile)) {
    fs.appendFileSync(hookFile, `\n${hookScript}\n`, "utf-8");
  } else {
    fs.writeFileSync(hookFile, `#!/bin/sh\n${hookScript}\n`, "utf-8");
  }

  // 确保可执行
  fs.chmodSync(hookFile, 0o755);

  console.log(`[GitService] post-commit 钩子已注入：${hookFile}`);
}

/**
 * 从 post-commit 钩子中移除 AgentLog 注入的脚本段落。
 */
export async function removePostCommitHook(
  workspacePath: string,
): Promise<void> {
  const hooksDir = await getHooksDir(workspacePath);
  const hookFile = path.join(hooksDir, "post-commit");

  if (!fs.existsSync(hookFile)) return;

  const content = fs.readFileSync(hookFile, "utf-8");
  if (!content.includes(HOOK_MARKER)) return;

  // 移除 agentlog 注入的段落（从 marker 开始到下一个空行或文件结尾）
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
      { lines: [], inBlock: false },
    )
    .lines.join("\n");

  fs.writeFileSync(hookFile, cleaned, "utf-8");
  console.log(`[GitService] post-commit 钩子已移除：${hookFile}`);
}

/**
 * 构建注入到 post-commit 的 Shell 脚本片段。
 * 使用 curl 静默发送通知，失败时不影响正常 commit 流程。
 *
 * 多 worktree 支持：
 * - AGENTLOG_WORKSPACE 通过 `git rev-parse --show-toplevel` 动态获取，
 *   而非硬编码路径。这样同一钩子脚本在不同 worktree 下执行时，
 *   均能正确上报各自的 worktree 路径。
 */
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
