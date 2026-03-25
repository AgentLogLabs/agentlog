/**
 * @agentlog/backend — /api/sessions 路由
 *
 * 提供 AgentSession 的 CRUD + 查询 + 统计接口。
 *
 * 路由列表：
 *  POST   /api/sessions              创建新会话
 *  GET    /api/sessions              分页查询会话列表
 *  GET    /api/sessions/stats        获取统计数据
 *  GET    /api/sessions/unbound      查询未绑定 Commit 的会话
 *  GET    /api/sessions/:id          获取单条会话详情
 *  PATCH  /api/sessions/:id/tags       更新会话标签
 *  PATCH  /api/sessions/:id/note       更新会话备注
 *  PATCH  /api/sessions/:id/commit     手动绑定 Commit
 *  PATCH  /api/sessions/:id/intent     回写 response/reasoning/affectedFiles
 *  PATCH  /api/sessions/:id/transcript 追加 transcript 消息
 *  DELETE /api/sessions/:id            删除单条会话
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  CreateSessionRequest,
  AppendTranscriptRequest,
  SessionQueryFilter,
  ModelProvider,
  AgentSource,
} from '@agentlog/shared';
import {
  createSession,
  getSessionById,
  querySessions,
  getUnboundSessions,
  updateSessionTags,
  updateSessionNote,
  updateSessionIntent,
  bindSessionsToCommit,
  unbindSessionFromCommit,
  deleteSession,
  getSessionStats,
  pruneOldSessions,
  appendTranscript,
} from '../services/logService';

// ─────────────────────────────────────────────
// 插件注册
// ─────────────────────────────────────────────

export default async function sessionsRoutes(app: FastifyInstance) {
  // ── POST /api/sessions ──────────────────────────────────────────────────
  // 创建新会话（插件捕获到 AI 交互后调用此接口上报）
  app.post(
    '/api/sessions',
    async (
      req: FastifyRequest<{ Body: CreateSessionRequest }>,
      reply: FastifyReply,
    ) => {
      const body = req.body;

      // 基础校验
      // prompt 允许空字符串（DeepSeek-R1 等推理模型首条消息 content 可能为空，用空串占位）
      if (body?.prompt === undefined || body?.prompt === null || typeof body.prompt !== 'string') {
        return reply.status(400).send({
          success: false,
          error: '缺少必填字段：prompt',
        });
      }
      // response 允许为空字符串（log_turn 首条消息时为 "(pending)"）
      if (body?.response !== undefined && typeof body.response !== 'string') {
        return reply.status(400).send({
          success: false,
          error: 'response 字段必须为字符串',
        });
      }
      if (!body?.provider || typeof body.provider !== 'string') {
        return reply.status(400).send({
          success: false,
          error: '缺少必填字段：provider',
        });
      }
      if (!body?.model || typeof body.model !== 'string') {
        return reply.status(400).send({
          success: false,
          error: '缺少必填字段：model',
        });
      }
      if (!body?.workspacePath || typeof body.workspacePath !== 'string') {
        return reply.status(400).send({
          success: false,
          error: '缺少必填字段：workspacePath',
        });
      }

      try {
        const session = createSession({
          provider: body.provider as ModelProvider,
          model: body.model,
          source: (body.source as AgentSource) ?? 'unknown',
          workspacePath: body.workspacePath,
          prompt: body.prompt,
          reasoning: body.reasoning,
          response: body.response ?? '',
          affectedFiles: body.affectedFiles ?? [],
          durationMs: body.durationMs ?? 0,
          tags: body.tags ?? [],
          note: body.note,
          transcript: body.transcript,
          tokenUsage: body.tokenUsage,
          metadata: body.metadata,
        });

        return reply.status(201).send({ success: true, data: session });
      } catch (err) {
        app.log.error(err, '[sessions] createSession 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误，会话创建失败',
        });
      }
    },
  );

  // ── GET /api/sessions ───────────────────────────────────────────────────
  // 分页查询会话列表，支持多维度过滤
  app.get(
    '/api/sessions',
    async (
      req: FastifyRequest<{
        Querystring: {
          page?: string;
          pageSize?: string;
          workspacePath?: string;
          provider?: string;
          source?: string;
          startDate?: string;
          endDate?: string;
          tags?: string | string[];
          keyword?: string;
          onlyBoundToCommit?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const q = req.query;

      const page = clampInt(q.page, 1, 1);
      const pageSize = clampInt(q.pageSize, 20, 1, 100);

      // tags 支持逗号分隔字符串或多次传参（?tags=a&tags=b）
      let tags: string[] | undefined;
      if (q.tags) {
        if (Array.isArray(q.tags)) {
          tags = q.tags.flatMap((t) => t.split(',').map((s) => s.trim())).filter(Boolean);
        } else {
          tags = q.tags.split(',').map((t) => t.trim()).filter(Boolean);
        }
        if (tags.length === 0) tags = undefined;
      }

      const filter: SessionQueryFilter = {
        page,
        pageSize,
        workspacePath: q.workspacePath || undefined,
        provider: (q.provider as ModelProvider) || undefined,
        source: (q.source as AgentSource) || undefined,
        startDate: q.startDate || undefined,
        endDate: q.endDate || undefined,
        tags,
        keyword: q.keyword || undefined,
        onlyBoundToCommit: q.onlyBoundToCommit === 'true' ? true : undefined,
      };

      try {
        const result = querySessions(filter);
        return reply.send({ success: true, data: result });
      } catch (err) {
        app.log.error(err, '[sessions] querySessions 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误，查询失败',
        });
      }
    },
  );

  // ── GET /api/sessions/stats ─────────────────────────────────────────────
  // 获取统计数据（需在 /:id 路由之前注册，防止被 id 参数匹配）
  app.get(
    '/api/sessions/stats',
    async (
      req: FastifyRequest<{ Querystring: { workspacePath?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const stats = getSessionStats(req.query.workspacePath || undefined);
        return reply.send({ success: true, data: stats });
      } catch (err) {
        app.log.error(err, '[sessions] getSessionStats 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误，获取统计失败',
        });
      }
    },
  );

  // ── GET /api/sessions/unbound ───────────────────────────────────────────
  // 查询指定工作区内尚未绑定 Commit 的会话
  app.get(
    '/api/sessions/unbound',
    async (
      req: FastifyRequest<{
        Querystring: { workspacePath?: string; limit?: string };
      }>,
      reply: FastifyReply,
    ) => {
      if (!req.query.workspacePath) {
        return reply.status(400).send({
          success: false,
          error: '缺少必填查询参数：workspacePath',
        });
      }

      const limit = clampInt(req.query.limit, 50, 1, 200);

      try {
        const sessions = getUnboundSessions(req.query.workspacePath, limit);
        return reply.send({ success: true, data: sessions });
      } catch (err) {
        app.log.error(err, '[sessions] getUnboundSessions 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误',
        });
      }
    },
  );

  // ── GET /api/sessions/:id ───────────────────────────────────────────────
  // 获取单条会话详情
  app.get(
    '/api/sessions/:id',
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const session = getSessionById(req.params.id);
        if (!session) {
          return reply.status(404).send({
            success: false,
            error: `会话不存在：${req.params.id}`,
          });
        }
        return reply.send({ success: true, data: session });
      } catch (err) {
        app.log.error(err, '[sessions] getSessionById 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误',
        });
      }
    },
  );

  // ── PATCH /api/sessions/:id/tags ────────────────────────────────────────
  // 更新会话标签
  app.patch(
    '/api/sessions/:id/tags',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: { tags: string[] };
      }>,
      reply: FastifyReply,
    ) => {
      const { tags } = req.body ?? {};

      if (!Array.isArray(tags)) {
        return reply.status(400).send({
          success: false,
          error: '请求体必须包含 tags 数组',
        });
      }

      // 过滤非字符串或空字符串
      const cleanedTags = tags
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        .map((t) => t.trim());

      try {
        const updated = updateSessionTags(req.params.id, cleanedTags);
        if (!updated) {
          return reply.status(404).send({
            success: false,
            error: `会话不存在：${req.params.id}`,
          });
        }
        return reply.send({ success: true, data: updated });
      } catch (err) {
        app.log.error(err, '[sessions] updateSessionTags 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误',
        });
      }
    },
  );

  // ── PATCH /api/sessions/:id/note ────────────────────────────────────────
  // 更新会话备注
  app.patch(
    '/api/sessions/:id/note',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: { note: string };
      }>,
      reply: FastifyReply,
    ) => {
      const note = req.body?.note;

      if (typeof note !== 'string') {
        return reply.status(400).send({
          success: false,
          error: '请求体必须包含字符串字段 note',
        });
      }

      try {
        const updated = updateSessionNote(req.params.id, note);
        if (!updated) {
          return reply.status(404).send({
            success: false,
            error: `会话不存在：${req.params.id}`,
          });
        }
        return reply.send({ success: true, data: updated });
      } catch (err) {
        app.log.error(err, '[sessions] updateSessionNote 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误',
        });
      }
    },
  );

  // ── PATCH /api/sessions/:id/commit ─────────────────────────────────────
  // 手动将单条会话绑定到指定 Commit（或解绑）
  app.patch(
    '/api/sessions/:id/commit',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: { commitHash: string | null };
      }>,
      reply: FastifyReply,
    ) => {
      const { commitHash } = req.body ?? {};

      if (commitHash !== null && typeof commitHash !== 'string') {
        return reply.status(400).send({
          success: false,
          error: 'commitHash 必须为字符串或 null（null 表示解绑）',
        });
      }

      try {
        // null 表示解绑
        if (commitHash === null) {
          const success = unbindSessionFromCommit(req.params.id);
          if (!success) {
            return reply.status(404).send({
              success: false,
              error: `会话不存在：${req.params.id}`,
            });
          }
          const session = getSessionById(req.params.id);
          return reply.send({ success: true, data: session });
        }

        // 非空 SHA 校验（允许短 SHA，至少 7 位）
        if (commitHash.trim().length < 7) {
          return reply.status(400).send({
            success: false,
            error: 'commitHash 长度不足（至少 7 位）',
          });
        }

        const affected = bindSessionsToCommit([req.params.id], commitHash.trim());
        if (affected === 0) {
          return reply.status(404).send({
            success: false,
            error: `会话不存在：${req.params.id}`,
          });
        }

        const session = getSessionById(req.params.id);
        return reply.send({ success: true, data: session });
      } catch (err) {
        app.log.error(err, '[sessions] patch commit 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误',
        });
      }
    },
  );

  // ── PATCH /api/sessions/:id/intent ──────────────────────────────────────
  // log_intent 完成任务后回写 response / affectedFiles
  // reasoning 由后端从当前 transcript 自动生成，不接受外部传入
  app.patch(
    '/api/sessions/:id/intent',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: { response?: string; affectedFiles?: string[] };
      }>,
      reply: FastifyReply,
    ) => {
      const { response, affectedFiles } = req.body ?? {};

      try {
        const updated = updateSessionIntent(req.params.id, {
          response,
          affectedFiles,
        });
        if (!updated) {
          return reply.status(404).send({
            success: false,
            error: `会话不存在：${req.params.id}`,
          });
        }
        return reply.send({ success: true, data: updated });
      } catch (err) {
        app.log.error(err, '[sessions] updateSessionIntent 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误，intent 回写失败',
        });
      }
    },
  );

  // ── PATCH /api/sessions/:id/transcript ─────────────────────────────────
  // 向已有会话追加 transcript 消息，并可选更新 token_usage
  app.patch(
    '/api/sessions/:id/transcript',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: AppendTranscriptRequest;
      }>,
      reply: FastifyReply,
    ) => {
      const { turns, tokenUsage } = req.body ?? {};

      if (!Array.isArray(turns)) {
        return reply.status(400).send({
          success: false,
          error: '请求体必须包含 turns 数组',
        });
      }

      try {
        const updated = appendTranscript(req.params.id, { turns, tokenUsage });
        if (!updated) {
          return reply.status(404).send({
            success: false,
            error: `会话不存在：${req.params.id}`,
          });
        }
        return reply.send({ success: true, data: updated });
      } catch (err) {
        app.log.error(err, '[sessions] appendTranscript 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误，追加 transcript 失败',
        });
      }
    },
  );

  // ── DELETE /api/sessions/:id ────────────────────────────────────────────
  // 删除单条会话
  app.delete(
    '/api/sessions/:id',
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const deleted = deleteSession(req.params.id);
        if (!deleted) {
          return reply.status(404).send({
            success: false,
            error: `会话不存在：${req.params.id}`,
          });
        }
        return reply.send({ success: true });
      } catch (err) {
        app.log.error(err, '[sessions] deleteSession 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误',
        });
      }
    },
  );

  // ── DELETE /api/sessions (批量清理) ─────────────────────────────────────
  // 按保留天数清理过期会话（管理接口）
  app.delete(
    '/api/sessions',
    async (
      req: FastifyRequest<{ Querystring: { retentionDays?: string } }>,
      reply: FastifyReply,
    ) => {
      const retentionDays = clampInt(req.query.retentionDays, 90, 1);

      try {
        const count = pruneOldSessions(retentionDays);
        return reply.send({
          success: true,
          data: {
            deleted: count,
            retentionDays,
            message: `已清理 ${count} 条超过 ${retentionDays} 天的会话记录`,
          },
        });
      } catch (err) {
        app.log.error(err, '[sessions] pruneOldSessions 失败');
        return reply.status(500).send({
          success: false,
          error: '服务器内部错误',
        });
      }
    },
  );
}

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/**
 * 将字符串解析为整数，超出范围时截断到 [min, max]。
 *
 * @param raw      原始字符串
 * @param fallback 解析失败时的默认值
 * @param min      最小值（含）
 * @param max      最大值（含），不传则不限上界
 */
function clampInt(
  raw: string | undefined,
  fallback: number,
  min = 0,
  max?: number,
): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) return fallback;
  const clamped = Math.max(min, parsed);
  return max !== undefined ? Math.min(max, clamped) : clamped;
}
