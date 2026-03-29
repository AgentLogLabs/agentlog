/**
 * @agentlog/backend — Commit 绑定路由
 *
 * 端点列表：
 *  POST   /api/commits/hook           post-commit 钩子接收端（由 git hook 调用）
 *  POST   /api/commits/bind           手动绑定会话到 Commit
 *  DELETE /api/commits/unbind/:sessionId  解绑单条会话
 *  GET    /api/commits/:hash          查询指定 Commit 的绑定信息
 *  GET    /api/commits/:hash/sessions 获取 Commit 关联的所有会话
 *  GET    /api/commits/:hash/context  生成 Commit 的 AI 交互上下文文档
 *  POST   /api/commits/:hash/context  生成 Commit 的 AI 交互上下文文档（带选项）
 *  GET    /api/commits/:hash/explain  生成 Commit 的 AI 交互解释摘要
 *  POST   /api/commits/:hash/explain  生成 Commit 的 AI 交互解释摘要（带选项）
 *  GET    /api/commits                列出所有已记录的 Commit 绑定（分页）
 *  POST   /api/commits/hook/install   向指定工作区注入 post-commit 钩子
 *  DELETE /api/commits/hook/remove    移除指定工作区的 post-commit 钩子
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type {
  BindCommitRequest,
  CommitBinding,
  CommitContextOptions,
  CommitContextResult,
  CommitExplainResult,
  ContextFormat,
  ExportLanguage,
  ApiResponse,
  PaginatedResponse,
} from "@agentlog/shared";
import {
  bindSessionsToCommit,
  createSession,
  getUnboundSessions,
  getUnboundSessionsByRepoRoot,
  getSessionsForNewCommit,
  getSessionsByCommitHash,
  getSessionById,
} from "../services/logService";
import {
  getCommitInfo,
  getRepoInfo,
  getRepoRoot,
  injectPostCommitHook,
  removePostCommitHook,
  isGitRepo,
} from "../services/gitService";
import { getDatabase, fromJson, toJson, type CommitRow } from "../db/database";
import {
  generateCommitContext,
  generateCommitExplain,
} from "../services/contextService";

// ─────────────────────────────────────────────
// 行 → 实体 映射
// ─────────────────────────────────────────────

function rowToCommitBinding(row: CommitRow): CommitBinding {
  return {
    commitHash: row.commit_hash,
    sessionIds: fromJson<string[]>(row.session_ids, []),
    message: row.message,
    committedAt: row.committed_at,
    authorName: row.author_name,
    authorEmail: row.author_email,
    changedFiles: fromJson<string[]>(row.changed_files, []),
    workspacePath: row.workspace_path,
  };
}

// ─────────────────────────────────────────────
// 数据库操作（commit_bindings 表）
// ─────────────────────────────────────────────

/**
 * 插入或更新一条 Commit 绑定记录。
 * 若已存在相同 commitHash，则合并 sessionIds（去重）。
 */
function upsertCommitBinding(binding: CommitBinding): CommitBinding {
  const db = getDatabase();

  // 从 session_commits 表获取当前 commit 绑定的所有 session_id
  const boundSessions = db
    .prepare(
      "SELECT session_id FROM session_commits WHERE commit_hash = ?",
    )
    .all(binding.commitHash) as Array<{ session_id: string }>;
  const sessionIdsFromJoin = boundSessions.map((row) => row.session_id);

  const existing = db
    .prepare("SELECT * FROM commit_bindings WHERE commit_hash = ?")
    .get(binding.commitHash) as CommitRow | undefined;

  // 合并 session_ids：来自 session_commits 表的记录 + 传入的 binding.sessionIds（去重）
  const allSessionIds = [
    ...new Set([...sessionIdsFromJoin, ...binding.sessionIds]),
  ];

  if (existing) {
    // 更新现有记录，使用 session_commits 中的完整列表
    db.prepare(
      `
      UPDATE commit_bindings
      SET session_ids = ?, message = ?, committed_at = ?,
          author_name = ?, author_email = ?, changed_files = ?
      WHERE commit_hash = ?
    `,
    ).run(
      toJson(allSessionIds),
      binding.message,
      binding.committedAt,
      binding.authorName,
      binding.authorEmail,
      toJson(binding.changedFiles),
      binding.commitHash,
    );
  } else {
    // 插入新记录
    db.prepare(
      `
      INSERT INTO commit_bindings (
        commit_hash, session_ids, message, committed_at,
        author_name, author_email, changed_files, workspace_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      binding.commitHash,
      toJson(allSessionIds),
      binding.message,
      binding.committedAt,
      binding.authorName,
      binding.authorEmail,
      toJson(binding.changedFiles),
      binding.workspacePath,
    );
  }

  const updated = db
    .prepare("SELECT * FROM commit_bindings WHERE commit_hash = ?")
    .get(binding.commitHash) as CommitRow;
  return rowToCommitBinding(updated);
}

/** 
 * 从 commit_bindings 中移除某个 sessionId 的关联
 * 
 * 多对多绑定下，此函数：
 * 1. 从 session_commits 表中删除指定的绑定记录
 * 2. 更新 commit_bindings.session_ids 以保持兼容性
 */
function removeSessionFromCommitBinding(
  sessionId: string,
  commitHash: string,
): void {
  const db = getDatabase();
  
  // 1. 从 session_commits 表中删除记录
  db.prepare(
    "DELETE FROM session_commits WHERE session_id = ? AND commit_hash = ?",
  ).run(sessionId, commitHash);
  
  // 2. 更新 commit_bindings.session_ids（向后兼容）
  const row = db
    .prepare("SELECT * FROM commit_bindings WHERE commit_hash = ?")
    .get(commitHash) as CommitRow | undefined;

  if (!row) return;

  const ids = fromJson<string[]>(row.session_ids, []).filter(
    (id) => id !== sessionId,
  );
  db.prepare(
    "UPDATE commit_bindings SET session_ids = ? WHERE commit_hash = ?",
  ).run(toJson(ids), commitHash);
}

/** 分页查询所有 commit_bindings，按提交时间倒序 */
function listCommitBindings(
  page: number,
  pageSize: number,
  workspacePath?: string,
  repoRoot?: string,
): PaginatedResponse<CommitBinding> {
  const db = getDatabase();
  
  let where = "";
  const params: Record<string, unknown> = {};
  
  if (workspacePath) {
    let effectiveRepoRoot = repoRoot;
    if (!effectiveRepoRoot) {
      // 查找与该 workspacePath 关联的 git_repo_root
      const repoRootRows = db
        .prepare(
          `SELECT DISTINCT git_repo_root 
           FROM agent_sessions 
           WHERE workspace_path = ? AND git_repo_root IS NOT NULL
           LIMIT 1`
        )
        .all(workspacePath) as Array<{ git_repo_root: string }>;
      effectiveRepoRoot = repoRootRows[0]?.git_repo_root;
    }
    
    if (effectiveRepoRoot && effectiveRepoRoot !== workspacePath) {
      // 匹配 workspace_path 或 git_repo_root
      where = "WHERE (workspace_path = @workspace_path OR workspace_path = @git_repo_root)";
      params.workspace_path = workspacePath;
      params.git_repo_root = effectiveRepoRoot;
    } else {
      // 仅匹配 workspace_path
      where = "WHERE workspace_path = @workspace_path";
      params.workspace_path = workspacePath;
    }
  }

  const { total } = db
    .prepare(`SELECT COUNT(*) as total FROM commit_bindings ${where}`)
    .get(params) as { total: number };

  const offset = (page - 1) * pageSize;
  const rows = db
    .prepare(
      `SELECT * FROM commit_bindings ${where}
       ORDER BY committed_at DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: pageSize, offset }) as CommitRow[];

  return {
    data: rows.map(rowToCommitBinding),
    total,
    page,
    pageSize,
  };
}

// ─────────────────────────────────────────────
// 路由注册
// ─────────────────────────────────────────────

const commitsRouter: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // ──────────────────────────────────────────
  // POST /api/commits/hook
  // post-commit 钩子接收端
  //
  // 由 .git/hooks/post-commit 脚本在每次 commit 后自动调用。
  // 功能：
  //  1. 从 git 获取本次 commit 的详细信息
  //  2. 查询工作区中最近的未绑定会话
  //  3. 自动将这些会话绑定到新的 commit
  //  4. 将绑定关系写入 commit_bindings 表
  // ──────────────────────────────────────────
  fastify.post<{
    Body: { commitHash: string; workspacePath: string };
  }>(
    "/hook",
    {
      schema: {
        body: {
          type: "object",
          required: ["commitHash", "workspacePath"],
          properties: {
            commitHash: { type: "string", minLength: 4 },
            workspacePath: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { commitHash, workspacePath } = request.body;

      try {
        // 1. 确认是有效的 Git 仓库
        const isRepo = await isGitRepo(workspacePath);
        if (!isRepo) {
          return reply.code(400).send({
            success: false,
            error: `路径不是有效的 Git 仓库：${workspacePath}`,
          } satisfies ApiResponse);
        }

        // 2. 获取 commit 详细信息
        const commitInfo = await getCommitInfo(workspacePath, commitHash);

        // 3. 解析当前 worktree 的 Git 仓库根目录，用于跨 worktree 会话匹配
        let repoRoot: string = workspacePath;
        try {
          repoRoot = await getRepoRoot(workspacePath);
        } catch {
          fastify.log.warn(
            `[Commits Hook] 无法获取 repoRoot，fallback 使用 workspacePath=${workspacePath}`,
          );
        }

        // 4. 三级匹配策略，从精确到宽泛逐级回退：
        //
        //    Level 1（精确）：按当前 worktree 的 workspace_path 精确匹配
        //    Level 2（宽泛）：按仓库根目录 git_repo_root 匹配，覆盖同仓库其他 worktree
        //    Level 3（兜底）：生成自动摘要 Session
        //
        // 优先使用 Level 1，找不到时升级为 Level 2，两者均为空时触发兜底。
        let sessionsToBind = getSessionsForNewCommit(workspacePath, 20);
        let matchLevel = 1;

        if (sessionsToBind.length === 0 && repoRoot !== workspacePath) {
          // Level 2：尝试按 git_repo_root 匹配同仓库其他 worktree 的未绑定会话
          sessionsToBind = getUnboundSessionsByRepoRoot(repoRoot, 20);
          matchLevel = 2;
          if (sessionsToBind.length > 0) {
            fastify.log.info(
              `[Commits Hook] commit=${commitHash.slice(0, 8)} Level-1 未找到会话，` +
              `通过 git_repo_root=${repoRoot} 在其他 worktree 匹配到 ${sessionsToBind.length} 条`,
            );
          }
        }

        if (sessionsToBind.length === 0) {
          matchLevel = 3;
          fastify.log.info(
            `[Commits Hook] commit=${commitHash.slice(0, 8)} 无未绑定会话（Level-1/2 均为空），尝试兜底补写`,
          );

          // ── 兜底逻辑（Spec 4.2 分支 B）──
          // 当没有游离 Session 时，根据 Commit 信息生成一条简要的 Session 记录。
          const fallbackSession = createSession({
            provider: "unknown",
            model: "git-hook-fallback",
            source: "unknown",
            workspacePath,
            gitRepoRoot: repoRoot,
            prompt: commitInfo.message,
            response: `Auto-generated from git commit ${commitInfo.hash.slice(0, 8)}.\nChanged files: ${commitInfo.changedFiles.join(", ") || "(none)"}`,
            affectedFiles: commitInfo.changedFiles,
            durationMs: 0,
            tags: ["auto-generated", "git-hook-fallback"],
          });

          // 绑定这条兜底 Session
          bindSessionsToCommit([fallbackSession.id], commitInfo.hash);

          const binding = upsertCommitBinding({
            commitHash: commitInfo.hash,
            sessionIds: [fallbackSession.id],
            message: commitInfo.message,
            committedAt: commitInfo.committedAt,
            authorName: commitInfo.authorName,
            authorEmail: commitInfo.authorEmail,
            changedFiles: commitInfo.changedFiles,
            workspacePath,
          });

          fastify.log.info(
            `[Commits Hook] commit=${commitHash.slice(0, 8)} 兜底补写了 1 条会话并绑定（Level-3）`,
          );

          return reply.code(200).send({
            success: true,
            data: binding,
          } satisfies ApiResponse<CommitBinding>);
        }

        // 提取需要绑定的会话 ID
        const sessionIds = sessionsToBind.map((s: { id: string }) => s.id);
        fastify.log.info(
          `[Commits Hook] commit=${commitHash.slice(0, 8)} Level-${matchLevel} 匹配到 ${sessionIds.length} 条会话待绑定`,
        );

        // 5. 在 agent_sessions 表中更新 commit_hash
        const updatedCount = bindSessionsToCommit(sessionIds, commitInfo.hash);

        // 6. 写入 commit_bindings 表
        const binding = upsertCommitBinding({
          commitHash: commitInfo.hash,
          sessionIds,
          message: commitInfo.message,
          committedAt: commitInfo.committedAt,
          authorName: commitInfo.authorName,
          authorEmail: commitInfo.authorEmail,
          changedFiles: commitInfo.changedFiles,
          workspacePath,
        });

        fastify.log.info(
          `[Commits Hook] commit=${commitHash.slice(0, 8)} 自动绑定了 ${updatedCount} 条会话`,
        );

        return reply.code(200).send({
          success: true,
          data: binding,
        } satisfies ApiResponse<CommitBinding>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fastify.log.error(`[Commits Hook] 处理失败：${message}`);
        return reply.code(500).send({
          success: false,
          error: `自动绑定失败：${message}`,
        } satisfies ApiResponse);
      }
    },
  );

  // ──────────────────────────────────────────
  // POST /api/commits/bind
  // 手动绑定：将指定会话列表绑定到某个 Commit
  // ──────────────────────────────────────────
  fastify.post<{
    Body: BindCommitRequest & { workspacePath?: string };
  }>(
    "/bind",
    {
      schema: {
        body: {
          type: "object",
          required: ["sessionIds", "commitHash"],
          properties: {
            sessionIds: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
            },
            commitHash: { type: "string", minLength: 4 },
            workspacePath: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { sessionIds, commitHash, workspacePath } = request.body;

      // 校验所有 sessionId 是否存在
      const missing = sessionIds.filter((id) => !getSessionById(id));
      if (missing.length > 0) {
        return reply.code(404).send({
          success: false,
          error: `以下会话 ID 不存在：${missing.join(", ")}`,
        } satisfies ApiResponse);
      }

      try {
        // 尝试从 git 获取 commit 信息（若能获取则更丰富）
        let commitInfo: Awaited<ReturnType<typeof getCommitInfo>> | null = null;

        if (workspacePath) {
          try {
            commitInfo = await getCommitInfo(workspacePath, commitHash);
          } catch {
            // 无法从 git 获取，使用最小化信息
            fastify.log.warn(
              `[Commits Bind] 无法从 git 获取 commit 信息，将使用最小化记录`,
            );
          }
        }

        // 更新 agent_sessions 表
        const updatedCount = bindSessionsToCommit(sessionIds, commitHash);

        // 写入 commit_bindings 表
        const binding = upsertCommitBinding({
          commitHash,
          sessionIds,
          message: commitInfo?.message ?? "",
          committedAt: commitInfo?.committedAt ?? new Date().toISOString(),
          authorName: commitInfo?.authorName ?? "",
          authorEmail: commitInfo?.authorEmail ?? "",
          changedFiles: commitInfo?.changedFiles ?? [],
          workspacePath: workspacePath ?? "",
        });

        fastify.log.info(
          `[Commits Bind] 手动绑定 commit=${commitHash.slice(0, 8)}，共绑定 ${updatedCount} 条会话`,
        );

        return reply.code(200).send({
          success: true,
          data: binding,
        } satisfies ApiResponse<CommitBinding>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          success: false,
          error: `绑定失败：${message}`,
        } satisfies ApiResponse);
      }
    },
  );

  // ──────────────────────────────────────────
  // DELETE /api/commits/unbind/:sessionId
  // 解绑单条会话与 Commit 的关联
  // ──────────────────────────────────────────
  fastify.delete<{
    Params: { sessionId: string };
  }>("/unbind/:sessionId", async (request, reply) => {
    const { sessionId } = request.params;

    const session = getSessionById(sessionId);
    if (!session) {
      return reply.code(404).send({
        success: false,
        error: `会话不存在：${sessionId}`,
      } satisfies ApiResponse);
    }

    if (!session.commitHash) {
      return reply.code(400).send({
        success: false,
        error: `会话 ${sessionId} 尚未绑定任何 Commit`,
      } satisfies ApiResponse);
    }

    const commitHash = session.commitHash;

    // 从 agent_sessions 表解绑
    const db = getDatabase();
    db.prepare("UPDATE agent_sessions SET commit_hash = NULL WHERE id = ?").run(
      sessionId,
    );

    // 从 commit_bindings 表中移除此 sessionId
    removeSessionFromCommitBinding(sessionId, commitHash);

    fastify.log.info(
      `[Commits Unbind] 会话 ${sessionId.slice(0, 8)} 已从 commit ${commitHash.slice(0, 8)} 解绑`,
    );

    return reply.code(200).send({
      success: true,
    } satisfies ApiResponse);
  });

  // ──────────────────────────────────────────
  // GET /api/commits
  // 列出所有 commit 绑定记录（分页）
  // 支持 ?workspacePath=&page=&pageSize=
  // ──────────────────────────────────────────
  fastify.get<{
    Querystring: {
      workspacePath?: string;
      page?: string;
      pageSize?: string;
    };
  }>("/", async (request, reply) => {
    const { workspacePath, page = "1", pageSize = "20" } = request.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(
      100,
      Math.max(1, parseInt(pageSize, 10) || 20),
    );

    let repoRoot: string | undefined;
    if (workspacePath) {
      try {
        repoRoot = await getRepoRoot(workspacePath);
        // 如果 repoRoot 与 workspacePath 相同，则忽略
        if (repoRoot === workspacePath) {
          repoRoot = undefined;
        }
      } catch {
        // 忽略错误，保持 repoRoot 为 undefined
      }
    }

    const result = listCommitBindings(pageNum, pageSizeNum, workspacePath, repoRoot);

    return reply.code(200).send({
      success: true,
      data: result,
    } satisfies ApiResponse<PaginatedResponse<CommitBinding>>);
  });

  // ──────────────────────────────────────────
  // GET /api/commits/:hash
  // 查询指定 Commit 的绑定信息
  // ──────────────────────────────────────────
  fastify.get<{
    Params: { hash: string };
  }>("/:hash", async (request, reply) => {
    const { hash } = request.params;
    const db = getDatabase();

    // 支持短 hash 前缀匹配（至少 4 位）
    const row =
      hash.length >= 40
        ? (db
            .prepare("SELECT * FROM commit_bindings WHERE commit_hash = ?")
            .get(hash) as CommitRow | undefined)
        : (db
            .prepare("SELECT * FROM commit_bindings WHERE commit_hash LIKE ?")
            .get(`${hash}%`) as CommitRow | undefined);

    if (!row) {
      return reply.code(404).send({
        success: false,
        error: `未找到 Commit 绑定记录：${hash}`,
      } satisfies ApiResponse);
    }

    return reply.code(200).send({
      success: true,
      data: rowToCommitBinding(row),
    } satisfies ApiResponse<CommitBinding>);
  });

  // ──────────────────────────────────────────
  // GET /api/commits/:hash/sessions
  // 获取 Commit 关联的所有 AgentSession 详情
  // ──────────────────────────────────────────
  fastify.get<{
    Params: { hash: string };
  }>("/:hash/sessions", async (request, reply) => {
    const { hash } = request.params;

    const sessions = getSessionsByCommitHash(hash);

    return reply.code(200).send({
      success: true,
      data: sessions,
    } satisfies ApiResponse<typeof sessions>);
  });

  // ──────────────────────────────────────────
  // GET /api/commits/:hash/context
  // 生成 Commit 的 AI 交互上下文文档（使用默认选项）
  //
  // Query: workspacePath?, format?, language?, includePrompts?, includeResponses?,
  //        includeReasoning?, includeChangedFiles?, maxContentLength?, maxSessions?
  // ──────────────────────────────────────────
  fastify.get<{
    Params: { hash: string };
    Querystring: {
      workspacePath?: string;
      format?: ContextFormat;
      language?: ExportLanguage;
      includePrompts?: string;
      includeResponses?: string;
      includeReasoning?: string;
      includeChangedFiles?: string;
      maxContentLength?: string;
      maxSessions?: string;
    };
  }>("/:hash/context", async (request, reply) => {
    const { hash } = request.params;
    const q = request.query;

    const options: CommitContextOptions = {
      format: q.format,
      language: q.language,
      includePrompts:
        q.includePrompts !== undefined
          ? q.includePrompts !== "false"
          : undefined,
      includeResponses:
        q.includeResponses !== undefined
          ? q.includeResponses !== "false"
          : undefined,
      includeReasoning:
        q.includeReasoning !== undefined
          ? q.includeReasoning !== "false"
          : undefined,
      includeChangedFiles:
        q.includeChangedFiles !== undefined
          ? q.includeChangedFiles !== "false"
          : undefined,
      maxContentLength: q.maxContentLength
        ? parseInt(q.maxContentLength, 10)
        : undefined,
      maxSessions: q.maxSessions ? parseInt(q.maxSessions, 10) : undefined,
    };

    // 移除 undefined 值，让 service 层使用默认值
    const cleanOptions = Object.fromEntries(
      Object.entries(options).filter(([, v]) => v !== undefined),
    ) as CommitContextOptions;

    try {
      const result = await generateCommitContext(
        hash,
        q.workspacePath,
        cleanOptions,
      );

      return reply.code(200).send({
        success: true,
        data: result,
      } satisfies ApiResponse<CommitContextResult>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({
        success: false,
        error: `生成上下文失败：${message}`,
      } satisfies ApiResponse);
    }
  });

  // ──────────────────────────────────────────
  // POST /api/commits/:hash/context
  // 生成 Commit 的 AI 交互上下文文档（使用请求体传递选项）
  //
  // Body: { workspacePath?, format?, language?, includePrompts?, includeResponses?,
  //         includeReasoning?, includeChangedFiles?, maxContentLength?, maxSessions? }
  // ──────────────────────────────────────────
  fastify.post<{
    Params: { hash: string };
    Body: {
      workspacePath?: string;
      format?: ContextFormat;
      language?: ExportLanguage;
      includePrompts?: boolean;
      includeResponses?: boolean;
      includeReasoning?: boolean;
      includeChangedFiles?: boolean;
      maxContentLength?: number;
      maxSessions?: number;
    };
  }>(
    "/:hash/context",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            workspacePath: { type: "string" },
            format: { type: "string", enum: ["markdown", "json", "xml"] },
            language: { type: "string", enum: ["zh", "en"] },
            includePrompts: { type: "boolean" },
            includeResponses: { type: "boolean" },
            includeReasoning: { type: "boolean" },
            includeChangedFiles: { type: "boolean" },
            maxContentLength: { type: "integer", minimum: 0 },
            maxSessions: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { hash } = request.params;
      const { workspacePath, ...options } = request.body;

      try {
        const result = await generateCommitContext(
          hash,
          workspacePath,
          options,
        );

        return reply.code(200).send({
          success: true,
          data: result,
        } satisfies ApiResponse<CommitContextResult>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          success: false,
          error: `生成上下文失败：${message}`,
        } satisfies ApiResponse);
      }
    },
  );

  // ──────────────────────────────────────────
  // GET /api/commits/:hash/explain
  // 生成 Commit 的 AI 交互解释摘要（使用默认选项）
  //
  // Query: workspacePath?, language?
  // ──────────────────────────────────────────
  fastify.get<{
    Params: { hash: string };
    Querystring: {
      workspacePath?: string;
      language?: ExportLanguage;
    };
  }>("/:hash/explain", async (request, reply) => {
    const { hash } = request.params;
    const { workspacePath, language } = request.query;

    try {
      const result = await generateCommitExplain(hash, workspacePath, language);

      return reply.code(200).send({
        success: true,
        data: result,
      } satisfies ApiResponse<CommitExplainResult>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({
        success: false,
        error: `生成解释摘要失败：${message}`,
      } satisfies ApiResponse);
    }
  });

  // ──────────────────────────────────────────
  // POST /api/commits/:hash/explain
  // 生成 Commit 的 AI 交互解释摘要（使用请求体传递选项）
  //
  // Body: { workspacePath?, language? }
  // ──────────────────────────────────────────
  fastify.post<{
    Params: { hash: string };
    Body: {
      workspacePath?: string;
      language?: ExportLanguage;
    };
  }>(
    "/:hash/explain",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            workspacePath: { type: "string" },
            language: { type: "string", enum: ["zh", "en"] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { hash } = request.params;
      const { workspacePath, language } = request.body;

      try {
        const result = await generateCommitExplain(
          hash,
          workspacePath,
          language,
        );

        return reply.code(200).send({
          success: true,
          data: result,
        } satisfies ApiResponse<CommitExplainResult>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          success: false,
          error: `生成解释摘要失败：${message}`,
        } satisfies ApiResponse);
      }
    },
  );

  // ──────────────────────────────────────────
  // POST /api/commits/hook/install
  // 向指定工作区注入 post-commit Git 钩子
  //
  // Body: { workspacePath: string; backendUrl?: string }
  // ──────────────────────────────────────────
  fastify.post<{
    Body: { workspacePath: string; backendUrl?: string };
  }>(
    "/hook/install",
    {
      schema: {
        body: {
          type: "object",
          required: ["workspacePath"],
          properties: {
            workspacePath: { type: "string", minLength: 1 },
            backendUrl: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspacePath, backendUrl = "http://localhost:7892" } =
        request.body;

      try {
        const isRepo = await isGitRepo(workspacePath);
        if (!isRepo) {
          return reply.code(400).send({
            success: false,
            error: `路径不是有效的 Git 仓库：${workspacePath}`,
          } satisfies ApiResponse);
        }

        const repoInfo = await getRepoInfo(workspacePath);
        await injectPostCommitHook(workspacePath, backendUrl);

        fastify.log.info(
          `[Commits Hook] 已向仓库 ${repoInfo.rootPath} 注入 post-commit 钩子`,
        );

        return reply.code(200).send({
          success: true,
          data: {
            repoRootPath: repoInfo.rootPath,
            currentBranch: repoInfo.currentBranch,
            backendUrl,
          },
        } satisfies ApiResponse<{
          repoRootPath: string;
          currentBranch: string;
          backendUrl: string;
        }>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          success: false,
          error: `注入钩子失败：${message}`,
        } satisfies ApiResponse);
      }
    },
  );

  // ──────────────────────────────────────────
  // DELETE /api/commits/hook/remove
  // 移除指定工作区的 post-commit 钩子
  //
  // Body: { workspacePath: string }
  // ──────────────────────────────────────────
  fastify.delete<{
    Body: { workspacePath: string };
  }>(
    "/hook/remove",
    {
      schema: {
        body: {
          type: "object",
          required: ["workspacePath"],
          properties: {
            workspacePath: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { workspacePath } = request.body;

      try {
        await removePostCommitHook(workspacePath);

        fastify.log.info(
          `[Commits Hook] 已从工作区 ${workspacePath} 移除 post-commit 钩子`,
        );

        return reply.code(200).send({
          success: true,
        } satisfies ApiResponse);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          success: false,
          error: `移除钩子失败：${message}`,
        } satisfies ApiResponse);
      }
    },
  );
};

export default commitsRouter;
