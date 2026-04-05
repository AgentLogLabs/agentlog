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
  associateCommitsToTrace,
  type UpdateTraceRequest,
  type TraceStatus,
} from "../services/traceService.js";

interface TraceParams {
  id: string;
}

interface UpdateTraceBody {
  taskGoal?: string;
  status?: TraceStatus;
  affectedFiles?: string[];
}

interface QueryParams {
  status?: string;
  page?: string;
  pageSize?: string;
  workspacePath?: string;
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
  workspacePath?: string;
}

interface AssociateCommitsBody {
  commits: Array<{
    commitHash: string;
    parentCommitHash?: string;
    workspacePath: string;
  }>;
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
      const { taskGoal, workspacePath } = req.body;

      const trace = createTrace({ taskGoal: taskGoal ?? "Untitled Trace", workspacePath });

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
            workspacePath: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Querystring: QueryParams }>, reply: FastifyReply) => {
      const { status, page, pageSize, workspacePath } = req.query;

      const result = await queryTraces({
        status: status as "running" | "paused" | "completed" | "failed" | undefined,
        page: page ? parseInt(page, 10) : 1,
        pageSize: pageSize ? parseInt(pageSize, 10) : 20,
        workspacePath,
      });

      return reply.send(result);
    }
  );

  /**
   * GET /api/traces/search
   * 搜索 traces 和 spans
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

      return reply.send({ success: true, ...result });
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

      // 获取扁平 span 列表用于统计
      const allSpans = getSpansByTraceId(traceId);

      // 统计 span 数量（使用扁平列表）
      const totalSpans = allSpans.length;
      const humanSpans = allSpans.filter((s) => s.actorType === "human").length;
      const agentSpans = allSpans.filter((s) => s.actorType === "agent").length;
      const systemSpans = allSpans.filter((s) => s.actorType === "system").length;

      // 提取根 span（无父节点的 span）
      const rootSpans = allSpans.filter((s) => !s.parentSpanId);

      // 计算时间范围
      let earliestTime: string | null = null;
      let latestTime: string | null = null;
      let failedSpan: { actorName: string; payload: Record<string, unknown> } | null = null;

      for (const span of allSpans) {
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

      // 聚合所有 span 的 tokenUsage
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheCreationTokens = 0;
      let totalCacheReadTokens = 0;
      let totalApiCallCount = 0;

      for (const span of allSpans) {
        const tu = (span.payload as Record<string, unknown>)?.tokenUsage as
          | { inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number; apiCallCount?: number }
          | undefined;
        if (tu) {
          totalInputTokens += tu.inputTokens ?? 0;
          totalOutputTokens += tu.outputTokens ?? 0;
          totalCacheCreationTokens += tu.cacheCreationTokens ?? 0;
          totalCacheReadTokens += tu.cacheReadTokens ?? 0;
          totalApiCallCount += tu.apiCallCount ?? 0;
        }
      }

      const tokenUsage =
        totalInputTokens > 0 || totalOutputTokens > 0
          ? {
              totalInputTokens,
              totalOutputTokens,
              totalTokens: totalInputTokens + totalOutputTokens,
              ...(totalCacheCreationTokens > 0 ? { totalCacheCreationTokens } : {}),
              ...(totalCacheReadTokens > 0 ? { totalCacheReadTokens } : {}),
              ...(totalApiCallCount > 0 ? { totalApiCallCount } : {}),
            }
          : undefined;

      // 计算处理时间
      const processingTimeMs = Date.now() - startTime;

      // 构建响应
      const summary = {
        traceId: trace.id,
        taskGoal: trace.taskGoal,
        status: trace.status,
        createdAt: trace.createdAt,
        updatedAt: trace.updatedAt,
        affectedFiles: trace.affectedFiles,
        spanTree: allSpans,
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
        ...(tokenUsage ? { tokenUsage } : {}),
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
   * GET /api/traces/:id/spans
   * 获取 trace 下的所有 spans
   */
  app.get<{ Params: TraceParams }>(
    "/:id/spans",
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

      const spans = getSpansByTraceId(req.params.id);

      return reply.send({
        success: true,
        data: spans,
      });
    }
  );

  /**
   * PATCH /api/traces/:id
   * 更新 trace（状态或任务目标）
   */
  app.patch<{ Params: TraceParams; Body: UpdateTraceBody }>(
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
            taskGoal: { type: "string" },
            status: { type: "string", enum: ["running", "completed", "failed", "paused"] },
            affectedFiles: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Params: TraceParams; Body: UpdateTraceBody }>, reply: FastifyReply) => {
      const updated = updateTrace(req.params.id, req.body);

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

  /**
   * POST /api/traces/:id/associate-commits
   * 批量关联历史 commits 到指定 trace
   *
   * 用于解决"先 commit 后装 hook"场景，将已有 commits 补关联到 trace
   */
  app.post<{ Params: TraceParams; Body: AssociateCommitsBody }>(
    "/:id/associate-commits",
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
          required: ["commits"],
          properties: {
            commits: {
              type: "array",
              items: {
                type: "object",
                required: ["commitHash", "workspacePath"],
                properties: {
                  commitHash: { type: "string", minLength: 1 },
                  parentCommitHash: { type: "string" },
                  workspacePath: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Params: TraceParams; Body: AssociateCommitsBody }>, reply: FastifyReply) => {
      const traceId = req.params.id;
      const { commits } = req.body;

      const result = associateCommitsToTrace(traceId, commits);

      if (result.success) {
        return reply.status(200).send({
          success: true,
          data: {
            traceId,
            associatedCount: result.spanIds.length,
            spanIds: result.spanIds,
          },
          ...(result.errors.length > 0 ? { warnings: result.errors } : {}),
        });
      }

      return reply.status(400).send({
        success: false,
        error: result.errors.join("; "),
      });
    }
  );
}

export default tracesRoutes;
