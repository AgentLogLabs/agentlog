/**
 * @agentlog/backend — Git Hooks 路由
 *
 * 提供 Git Hook 相关 API：
 * - POST /api/hooks/post-commit - post-commit 回调
 * - POST /api/hooks/install - 安装 Git Hook
 * - DELETE /api/hooks/uninstall - 卸载 Git Hook
 * - GET /api/hooks/status - 查询 Hook 安装状态
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  handlePostCommitCallback,
  installGitHook,
  uninstallGitHook,
  isGitHookInstalled,
  getGitStatusSummary,
} from "../services/gitHookService.js";
import { setGitConfig, isGitRepo } from "../services/gitService.js";

interface PostCommitBody {
  workspacePath: string;
  commitHash: string;
  parentCommitHash?: string;
  agentId?: string;
  sessionId?: string;
  traceId?: string;
}

interface InstallBody {
  workspacePath: string;
}

interface WorkspaceQuery {
  workspacePath: string;
}

async function gitHooksRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/hooks/post-commit
   * post-commit 钩子回调：提取 commit 信息并记录 Human Override
   */
  app.post<{ Body: PostCommitBody }>(
    "/post-commit",
    {
      schema: {
        body: {
          type: "object",
          required: ["workspacePath", "commitHash"],
          properties: {
            workspacePath: { type: "string", minLength: 1 },
            commitHash: { type: "string", minLength: 1 },
            parentCommitHash: { type: "string" },
            agentId: { type: "string" },
            sessionId: { type: "string" },
            traceId: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: PostCommitBody }>, reply: FastifyReply) => {
      const { workspacePath, commitHash, parentCommitHash, agentId, sessionId, traceId } = req.body;

      const result = await handlePostCommitCallback({
        workspacePath,
        commitHash,
        parentCommitHash,
        agentId,
        sessionId,
        traceId,
      });

      if (result.success) {
        return reply.status(200).send({
          success: true,
          spanId: result.spanId,
          message: "Human Override 已记录",
        });
      } else {
        return reply.status(500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  /**
   * POST /api/hooks/install
   * 在指定工作区安装 Git post-commit 钩子
   */
  app.post<{ Body: InstallBody }>(
    "/install",
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
    async (req: FastifyRequest<{ Body: InstallBody }>, reply: FastifyReply) => {
      const { workspacePath } = req.body;

      const result = await installGitHook(workspacePath);

      if (result.success) {
        return reply.status(200).send({
          success: true,
          hookPath: result.hookPath,
          message: "Git Hook 安装成功",
        });
      } else {
        return reply.status(400).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  /**
   * DELETE /api/hooks/uninstall
   * 卸载指定工作区的 Git post-commit 钩子
   */
  app.delete<{ Querystring: WorkspaceQuery }>(
    "/uninstall",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["workspacePath"],
          properties: {
            workspacePath: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Querystring: WorkspaceQuery }>, reply: FastifyReply) => {
      const { workspacePath } = req.query;

      const result = await uninstallGitHook(workspacePath);

      if (result.success) {
        return reply.status(200).send({
          success: true,
          message: "Git Hook 已卸载",
        });
      } else {
        return reply.status(400).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  /**
   * GET /api/hooks/status
   * 查询 Git Hook 安装状态
   */
  app.get<{ Querystring: WorkspaceQuery }>(
    "/status",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["workspacePath"],
          properties: {
            workspacePath: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Querystring: WorkspaceQuery }>, reply: FastifyReply) => {
      const { workspacePath } = req.query;

      const installed = isGitHookInstalled(workspacePath);
      const status = await getGitStatusSummary(workspacePath);

      return reply.status(200).send({
        hookInstalled: installed,
        gitStatus: status,
      });
    }
  );
  /**
   * POST /api/git/config
   * 写入 git config 键值（供插件在创建 trace 后设置 agentlog.traceId）
   */
  app.post<{ Body: { workspacePath: string; key: string; value: string } }>(
    "/config",
    {
      schema: {
        body: {
          type: "object",
          required: ["workspacePath", "key", "value"],
          properties: {
            workspacePath: { type: "string", minLength: 1 },
            key: { type: "string", minLength: 1 },
            value: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (
      req: FastifyRequest<{ Body: { workspacePath: string; key: string; value: string } }>,
      reply: FastifyReply
    ) => {
      const { workspacePath, key, value } = req.body;

      const isRepo = await isGitRepo(workspacePath);
      if (!isRepo) {
        return reply.status(400).send({ success: false, error: "不是 Git 仓库" });
      }

      try {
        await setGitConfig(workspacePath, key, value);
        return reply.status(200).send({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ success: false, error: message });
      }
    }
  );
}

export default gitHooksRoutes;
