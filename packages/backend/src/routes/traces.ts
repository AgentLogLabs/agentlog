/**
 * @agentlog/backend — Traces 路由
 *
 * 提供 Trace 相关 API：
 * - GET /api/traces - 查询 trace 列表
 * - GET /api/traces/:id - 获取单个 trace
 * - GET /api/traces/:id/summary - 获取 trace 摘要（UC-002）
 * - GET /api/traces/:id/diff - 获取 trace diff（UC-003）
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  queryTraces,
  getTraceById,
  getFullSpanTree,
  getSpansByTraceId,
  deleteTrace,
  buildSpanTree,
  createTrace,
  updateTrace,
  searchTraces,
} from "../services/traceService.js";

interface TraceParams {
  id: string;
}

interface QueryParams {
  status?: string;
  page?: string;
  pageSize?: string;
}

interface SearchParams {
  keyword?: string;
  workspacePath?: string;
  commitHash?: string;
  source?: string;
  page?: string;
  pageSize?: string;
}

interface CreateTraceBody {
  taskGoal?: string;
}

async function tracesRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/traces
   * 创建新的 Trace
   */
  app.post<{ Body: CreateTraceBody }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            taskGoal: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: CreateTraceBody }>, reply: FastifyReply) => {
      const { taskGoal } = req.body;

      const trace = createTrace({ taskGoal: taskGoal ?? "Untitled Trace" });

      return reply.status(201).send({
        success: true,
        data: trace,
      });
    }
  );

  /**
   * GET /api/traces
   * 查询 trace 列表
   */
  app.get<{ Querystring: QueryParams }>(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: { type: "string" },
            page: { type: "string" },
            pageSize: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Querystring: QueryParams }>, reply: FastifyReply) => {
      const { status, page, pageSize } = req.query;

      const result = await queryTraces({
        status: status as "running" | "paused" | "completed" | "failed" | undefined,
        page: page ? parseInt(page, 10) : 1,
        pageSize: pageSize ? parseInt(pageSize, 10) : 20,
      });

      return reply.send(result);
    }
  );

  /**
   * GET /api/traces/search
   * 搜索 traces 和 spans（基于 keyword、workspace、commit_hash）
   */
  app.get<{ Querystring: SearchParams }>(
    "/search",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            keyword: { type: "string" },
            workspacePath: { type: "string" },
            commitHash: { type: "string" },
            source: { type: "string" },
            page: { type: "string" },
            pageSize: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Querystring: SearchParams }>, reply: FastifyReply) => {
      const { keyword, workspacePath, commitHash, source, page, pageSize } = req.query;

      const result = searchTraces({
        keyword,
        workspacePath,
        commitHash,
        source,
        page: page ? parseInt(page, 10) : 1,
        pageSize: pageSize ? parseInt(pageSize, 10) : 20,
      });

      return reply.send({
        success: true,
        data: result.data,
        total: result.total,
      });
    }
  );

  /**
   * GET /api/traces/:id
   * 获取单个 trace
   */
  app.get<{ Params: TraceParams }>(
    "/:id",
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
    async (req: FastifyRequest<{ Params: TraceParams }>, reply: FastifyReply) => {
      const trace = await getTraceById(req.params.id);

      if (!trace) {
        return reply.status(404).send({
          success: false,
          error: "Trace not found",
        });
      }

      return reply.send({
        success: true,
        data: trace,
      });
    }
  );

  /**
   * PATCH /api/traces/:id
   * 更新 trace（状态、taskGoal）
   */
  app.patch<{ Params: TraceParams; Body: { status?: string; taskGoal?: string } }>(
    "/:id",
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
          properties: {
            status: { type: "string" },
            taskGoal: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Params: TraceParams; Body: { status?: string; taskGoal?: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const { status, taskGoal } = req.body;

      const updated = updateTrace(id, {
        ...(status ? { status: status as "running" | "paused" | "completed" | "failed" } : {}),
        ...(taskGoal ? { taskGoal } : {}),
      });

      if (!updated) {
        return reply.status(404).send({
          success: false,
          error: "Trace not found",
        });
      }

      return reply.send({
        success: true,
        data: updated,
      });
    }
  );

  /**
   * GET /api/traces/:id/summary
   * UC-002: 获取 trace 摘要
   *
   * 返回 trace 的汇总信息：
   * - 基本信息（ID、状态、创建时间）
   * - Span 统计（总数、human/agent/system 分布）
   * - 时间线（最早/最新事件时间）
   * - 失败摘要（如果状态为 failed）
   */
  app.get<{ Params: TraceParams }>(
    "/:id/summary",
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
    async (req: FastifyRequest<{ Params: TraceParams }>, reply: FastifyReply) => {
      const traceId = req.params.id;
      const startTime = Date.now();

      // 获取 trace 和完整 span 树
      const traceResult = await getFullSpanTree(traceId);

      if (!traceResult.trace) {
        return reply.status(404).send({
          success: false,
          error: "Trace not found",
        });
      }

      const { trace, tree } = traceResult;

      // 统计 span 数量
      const totalSpans = tree.length;
      const humanSpans = tree.filter((s) => s.actorType === "human").length;
      const agentSpans = tree.filter((s) => s.actorType === "agent").length;
      const systemSpans = tree.filter((s) => s.actorType === "system").length;

      // 提取根 span（无父节点的 span）
      const rootSpans = tree.filter((s) => !s.parentSpanId);

      // 计算时间范围
      let earliestTime: string | null = null;
      let latestTime: string | null = null;
      let failedSpan: { actorName: string; payload: Record<string, unknown> } | null = null;

      for (const span of tree) {
        const ts = (span.payload as Record<string, unknown>)?.timestamp as string | undefined;
        if (ts) {
          if (!earliestTime || ts < earliestTime) {
            earliestTime = ts;
          }
          if (!latestTime || ts > latestTime) {
            latestTime = ts;
          }
        }
        // 检查是否有失败标记
        if ((span.payload as Record<string, unknown>)?.error || (span.payload as Record<string, unknown>)?.status === "failed") {
          failedSpan = { actorName: span.actorName, payload: span.payload };
        }
      }

      // 计算处理时间
      const processingTimeMs = Date.now() - startTime;

      // 构建响应
      const summary = {
        traceId: trace.id,
        taskGoal: trace.taskGoal,
        status: trace.status,
        createdAt: trace.createdAt,
        updatedAt: trace.updatedAt,
        statistics: {
          totalSpans,
          humanSpans,
          agentSpans,
          systemSpans,
          rootSpanCount: rootSpans.length,
        },
        timeline: {
          earliestEvent: earliestTime,
          latestEvent: latestTime,
          durationMs: earliestTime && latestTime
            ? new Date(latestTime).getTime() - new Date(earliestTime).getTime()
            : null,
        },
        ...(trace.status === "failed" && failedSpan
          ? {
              failureSummary: {
                failedAt: latestTime,
                failedActor: failedSpan.actorName,
                errorMessage: (failedSpan.payload as Record<string, unknown>)?.error as string | undefined,
                stackTrace: (failedSpan.payload as Record<string, unknown>)?.stack as string | undefined,
              },
            }
          : {}),
        performance: {
          processingTimeMs,
        },
      };

      return reply.send({
        success: true,
        data: summary,
      });
    }
  );

  /**
   * GET /api/traces/:id/diff
   * UC-003: 获取 trace diff
   *
   * 返回 trace 的变更对比信息：
   * - trace 基本信息
   * - 完整的 span 树结构
   * - 变更摘要（新增、修改的 span）
   */
  app.get<{ Params: TraceParams }>(
    "/:id/diff",
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
    async (req: FastifyRequest<{ Params: TraceParams }>, reply: FastifyReply) => {
      const traceId = req.params.id;

      // 获取 trace 和完整 span 树
      const traceResult = await getFullSpanTree(traceId);

      if (!traceResult.trace) {
        return reply.status(404).send({
          success: false,
          error: "Trace not found",
        });
      }

      const { trace, tree } = traceResult;

      // 构建 diff 信息
      const diff = {
        trace: {
          id: trace.id,
          taskGoal: trace.taskGoal,
          status: trace.status,
          createdAt: trace.createdAt,
          updatedAt: trace.updatedAt,
        },
        spanTree: tree,
        summary: {
          totalSpans: tree.length,
          rootSpanCount: tree.filter((s) => !s.parentSpanId).length,
          uniqueActors: [...new Set(tree.map((s) => s.actorName))],
          actorTypeBreakdown: {
            human: tree.filter((s) => s.actorType === "human").length,
            agent: tree.filter((s) => s.actorType === "agent").length,
            system: tree.filter((s) => s.actorType === "system").length,
          },
        },
        changes: tree.map((span) => ({
          spanId: span.id,
          parentSpanId: span.parentSpanId,
          actorType: span.actorType,
          actorName: span.actorName,
          event: (span.payload as Record<string, unknown>)?.event as string | undefined,
          toolName: (span.payload as Record<string, unknown>)?.toolName as string | undefined,
          timestamp: (span.payload as Record<string, unknown>)?.timestamp as string | undefined,
        })),
      };

      return reply.send({
        success: true,
        data: diff,
      });
    }
  );

  /**
   * DELETE /api/traces/:id
   * 删除 trace
   */
  app.delete<{ Params: TraceParams }>(
    "/:id",
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
    async (req: FastifyRequest<{ Params: TraceParams }>, reply: FastifyReply) => {
      const success = await deleteTrace(req.params.id);

      if (!success) {
        return reply.status(404).send({
          success: false,
          error: "Trace not found",
        });
      }

      return reply.send({
        success: true,
        message: "Trace deleted",
      });
    }
  );
}

export default tracesRoutes;
