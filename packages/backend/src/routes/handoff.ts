/**
 * @agentlog/backend — Handoff 路由
 *
 * 提供 Trace 交接相关 API：
 * - GET /api/traces/pending - 查询待认领 traces
 * - POST /api/traces/:id/handoff - 创建 pending_handoff trace
 * - POST /api/traces/:id/resume - Agent 认领 trace
 * - POST /api/traces/:id/pause - 暂停 trace
 * - POST /api/traces/:id/resume-from-pause - 从暂停恢复
 * - POST /api/traces/:id/complete - 标记完成
 * - GET /api/sessions/active - 获取当前 active session
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getTraceById,
  updateTrace,
  queryTraces,
  transitionToHandoff,
  transitionToInProgress,
  transitionToCompleted,
  transitionToPaused,
  transitionFromPaused,
  type Trace,
} from "../services/traceService.js";
import {
  createPendingTrace,
  claimPendingTrace,
  completeActiveSession,
  getPendingTraces,
  getActiveSession,
  readSessionsJsonByWorkspace,
} from "../services/sessionsJsonService.js";

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

interface TraceParams {
  id: string;
}

interface HandoffBody {
  targetAgent: string;
  taskGoal?: string;
  workspacePath?: string;
}

interface ResumeBody {
  agentType: string;
  workspacePath?: string;
}

interface PauseResumeParams {
  id: string;
}

interface ActiveSessionQuery {
  workspacePath: string;
}

interface PendingTracesQuery {
  workspacePath: string;
  agentType?: string;
}

// ─────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────

function getWorkspacePath(body: { workspacePath?: string }, workspaceHeader?: string): string {
  return body.workspacePath ?? workspaceHeader ?? process.cwd() ?? "";
}

// ─────────────────────────────────────────────
// 路由
// ─────────────────────────────────────────────

async function handoffRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/traces/pending
   * 查询待认领的 traces
   */
  app.get<{ Querystring: PendingTracesQuery }>(
    "/pending",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["workspacePath"],
          properties: {
            workspacePath: { type: "string" },
            agentType: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Querystring: PendingTracesQuery }>, reply: FastifyReply) => {
      const { workspacePath, agentType } = req.query;

      const pendingList = await getPendingTraces(workspacePath, agentType);

      return reply.send({
        success: true,
        data: pendingList,
        total: pendingList.length,
      });
    }
  );

  /**
   * POST /api/traces/:id/handoff
   * 创建 pending_handoff trace
   */
  app.post<{ Params: TraceParams; Body: HandoffBody }>(
    "/:id/handoff",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["targetAgent"],
          properties: {
            targetAgent: { type: "string" },
            taskGoal: { type: "string" },
            workspacePath: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Params: TraceParams; Body: HandoffBody }>, reply: FastifyReply) => {
      const traceId = req.params.id;
      const { targetAgent, taskGoal, workspacePath } = req.body;

      const trace = getTraceById(traceId);
      if (!trace) {
        return reply.status(404).send({
          success: false,
          error: "Trace not found",
        });
      }

      const wsPath = workspacePath ?? trace.workspacePath ?? process.cwd() ?? "";

      // 检查是否已有分配给相同 agent 的 pending trace
      const existingPending = await getPendingTraces(wsPath, targetAgent);
      if (existingPending.length > 0) {
        return reply.status(409).send({
          success: false,
          error: `当前工作区已有一个待认领的 Trace（${existingPending[0].traceId}）分配给 ${targetAgent}，请切换到其他 Git Worktree 再进行交接。`,
          existingPendingTraceId: existingPending[0].traceId,
        });
      }

      // 1. 更新 trace 状态为 pending_handoff
      const updatedTrace = transitionToHandoff(traceId, targetAgent, wsPath);
      if (!updatedTrace) {
        return reply.status(400).send({
          success: false,
          error: "Failed to transition to pending_handoff",
        });
      }

      // 2. 创建 pending trace 条目（带上当前 worktree 标识）
      const entry = await createPendingTrace(wsPath, traceId, targetAgent, taskGoal ?? trace.taskGoal, wsPath);

      return reply.send({
        success: true,
        data: {
          trace: updatedTrace,
          pendingEntry: entry,
        },
      });
    }
  );

  /**
   * POST /api/traces/:id/resume
   * Agent 认领 trace
   */
  app.post<{ Params: TraceParams; Body: ResumeBody }>(
    "/:id/resume",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["agentType"],
          properties: {
            agentType: { type: "string" },
            workspacePath: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Params: TraceParams; Body: ResumeBody }>, reply: FastifyReply) => {
      const traceId = req.params.id;
      const { agentType, workspacePath } = req.body;

      const trace = getTraceById(traceId);
      if (!trace) {
        return reply.status(404).send({
          success: false,
          error: "Trace not found",
        });
      }

      const wsPath = workspacePath ?? trace.workspacePath ?? process.cwd() ?? "";

      // 1. 认领 pending trace（从 sessions.json）
      const activeSession = await claimPendingTrace(wsPath, traceId, agentType);
      if (!activeSession) {
        return reply.status(400).send({
          success: false,
          error: "Failed to claim pending trace. Trace may not be in pending state.",
        });
      }

      // 2. 更新 trace 状态为 in_progress
      const updatedTrace = transitionToInProgress(traceId);

      return reply.send({
        success: true,
        data: {
          trace: updatedTrace,
          activeSession,
        },
      });
    }
  );

  /**
   * POST /api/traces/:id/pause
   * 暂停 trace（用户主动暂停）
   */
  app.post<{ Params: PauseResumeParams }>(
    "/:id/pause",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Params: PauseResumeParams }>, reply: FastifyReply) => {
      const traceId = req.params.id;

      const trace = getTraceById(traceId);
      if (!trace) {
        return reply.status(404).send({
          success: false,
          error: "Trace not found",
        });
      }

      const updatedTrace = transitionToPaused(traceId);
      if (!updatedTrace) {
        return reply.status(400).send({
          success: false,
          error: "Cannot pause trace in current state",
        });
      }

      return reply.send({
        success: true,
        data: updatedTrace,
      });
    }
  );

  /**
   * POST /api/traces/:id/resume-from-pause
   * 从暂停状态恢复
   */
  app.post<{ Params: PauseResumeParams }>(
    "/:id/resume-from-pause",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Params: PauseResumeParams }>, reply: FastifyReply) => {
      const traceId = req.params.id;

      const trace = getTraceById(traceId);
      if (!trace) {
        return reply.status(404).send({
          success: false,
          error: "Trace not found",
        });
      }

      const updatedTrace = transitionFromPaused(traceId);
      if (!updatedTrace) {
        return reply.status(400).send({
          success: false,
          error: "Cannot resume trace from current state",
        });
      }

      return reply.send({
        success: true,
        data: updatedTrace,
      });
    }
  );

  /**
   * POST /api/traces/:id/complete
   * 标记 trace 为完成
   */
  app.post<{ Params: PauseResumeParams }>(
    "/:id/complete",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Params: PauseResumeParams }>, reply: FastifyReply) => {
      const traceId = req.params.id;

      const trace = getTraceById(traceId);
      if (!trace) {
        return reply.status(404).send({
          success: false,
          error: "Trace not found",
        });
      }

      const updatedTrace = transitionToCompleted(traceId);
      if (!updatedTrace) {
        return reply.status(400).send({
          success: false,
          error: "Cannot complete trace from current state",
        });
      }

      return reply.send({
        success: true,
        data: updatedTrace,
      });
    }
  );
}

/**
 * 获取当前工作区的 active session
 * 路径: GET /api/sessions/active?workspacePath=xxx
 */
async function activeSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ActiveSessionQuery }>(
    "/active",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["workspacePath"],
          properties: {
            workspacePath: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Querystring: ActiveSessionQuery }>, reply: FastifyReply) => {
      const { workspacePath } = req.query;

      const activeSession = await getActiveSession(workspacePath);

      return reply.send({
        success: true,
        data: activeSession,
      });
    }
  );
}

export default handoffRoutes;
export { activeSessionRoutes };
