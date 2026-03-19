/**
 * @agentlog/backend — /api/hooks/:agent/:event 路由
 *
 * 接收 Claude Code 通过 HTTP 发送的 Lifecycle Hook 事件，
 * 解析 payload 后调用 hookService 创建会话记录。
 *
 * 路由：
 *   POST /api/hooks/:agent/:event
 *
 * 示例：
 *   POST /api/hooks/claude-code/Stop
 *
 * Claude Code 通过 curl 命令将 JSON payload（含 transcript_path）发送到此端点：
 *   curl -s -X POST http://localhost:7892/api/hooks/claude-code/Stop \
 *        -H 'Content-Type: application/json' -d @-
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { dispatchHookEvent } from '../services/hookService';

/** 当前支持的 Agent（MVP 仅 Claude Code） */
const SUPPORTED_AGENTS = new Set(['claude-code']);

export default async function hooksRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/hooks/:agent/:event
   *
   * Claude Code 的 hook command 通过 `curl ... -d @-` 将 JSON payload 发到此处。
   * payload 中包含 transcript_path、session_id、cwd 等字段。
   */
  app.post(
    '/api/hooks/:agent/:event',
    async (
      req: FastifyRequest<{
        Params: { agent: string; event: string };
        Body: Record<string, unknown>;
      }>,
      reply: FastifyReply,
    ) => {
      const { agent, event } = req.params;
      const payload = req.body ?? {};

      app.log.debug(
        { agent, event, sessionId: payload.session_id },
        '[hooks] 收到 Hook 事件',
      );

      // 校验 agent
      if (!SUPPORTED_AGENTS.has(agent)) {
        return reply.status(400).send({
          success: false,
          error: `不支持的 Agent：${agent}。当前仅支持：${[...SUPPORTED_AGENTS].join(', ')}`,
        });
      }

      try {
        const session = dispatchHookEvent(agent, event, payload);

        if (session) {
          app.log.info(
            { agent, event, sessionId: session.id },
            '[hooks] 会话已记录',
          );
          return reply.status(201).send({ success: true, data: session });
        }

        // 事件被接收但不需要创建会话（如 UserPromptSubmit 在 MVP 阶段跳过）
        app.log.debug(
          { agent, event },
          '[hooks] 事件已接收，无需创建会话',
        );
        return reply.status(200).send({
          success: true,
          data: null,
          message: `事件 ${agent}/${event} 已接收`,
        });
      } catch (err) {
        app.log.error(
          { err, agent, event },
          '[hooks] 处理 Hook 事件失败',
        );
        return reply.status(500).send({
          success: false,
          error: `处理失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  );
}
