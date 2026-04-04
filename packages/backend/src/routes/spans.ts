import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createSpan, type CreateSpanRequest, type ActorType } from '../services/traceService';
import { HookEventAdapter } from '../utils/hookAdapter';
import { broadcastEvent } from '../utils/sseManager';

interface CreateSpanBody {
  traceId: string;
  parentSpanId?: string | null;
  actorType?: ActorType;
  actorName?: string;
  payload?: Record<string, unknown>;
  source?: string;
  event?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
}

const hookAdapter = new HookEventAdapter();

async function spansRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateSpanBody }>(
    '/spans',
    {
      schema: {
        body: {
          type: 'object',
          required: ['traceId'],
          properties: {
            traceId: { type: 'string', minLength: 1 },
            parentSpanId: { type: ['string', 'null'] },
            actorType: { type: 'string', enum: ['human', 'agent', 'system'] },
            actorName: { type: 'string', minLength: 1 },
            payload: { type: 'object' },
            source: { type: 'string' },
            event: { type: 'string' },
            toolName: { type: 'string' },
            toolInput: { type: 'object' },
            toolResult: {},
            sessionId: { type: 'string' },
            cwd: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: CreateSpanBody }>, reply: FastifyReply) => {
      const isHook = hookAdapter.canAdapt(req.body);
      let spanReq: CreateSpanRequest;

      if (isHook) {
        const adapted = hookAdapter.adapt(req.body);
        if (adapted) {
          spanReq = {
            traceId: adapted.traceId,
            parentSpanId: adapted.parentSpanId ?? null,
            actorType: adapted.actorType,
            actorName: adapted.actorName,
            payload: adapted.payload,
          };
        } else {
          const body = req.body as CreateSpanBody;
          spanReq = {
            traceId: body.traceId ?? '',
            parentSpanId: body.parentSpanId ?? null,
            actorType: body.actorType ?? 'agent',
            actorName: body.actorName ?? 'unknown',
            payload: body.payload ?? {},
          };
        }
      } else {
        const body = req.body as CreateSpanBody;
        if (!body.actorType || !body.actorName) {
          return reply.status(400).send({
            success: false,
            error: 'actorType and actorName are required for non-hook events',
          });
        }
        spanReq = {
          traceId: body.traceId ?? '',
          parentSpanId: body.parentSpanId ?? null,
          actorType: body.actorType,
          actorName: body.actorName,
          payload: body.payload ?? {},
        };
      }

      const span = createSpan(spanReq);

      // SSE 实时推送：广播新 Span 事件到所有连接的客户端
      broadcastEvent({
        type: "span_created",
        data: span,
        timestamp: new Date().toISOString(),
      });

      return reply.status(201).send({
        success: true,
        data: span,
      });
    }
  );
}

export default spansRoutes;
