/**
 * AgentLog Telemetry Hook Handler
 *
 * This handler captures OpenClaw agent lifecycle events and reports them
 * to the AgentLog gateway via HTTP POST /api/spans.
 *
 * Installation:
 * Add to OpenClaw config:
 * ```json
 * {
 *   "hooks": {
 *     "internal": {
 *       "enabled": true,
 *       "handlers": [
 *         {
 *           "event": "agent",
 *           "module": "path/to/agentlog-telemetry/handler.js"
 *         }
 *       ]
 *     }
 *   }
 * }
 * ```
 */

import { ulid } from "ulid";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

const GATEWAY_URL = process.env.AGENTLOG_GATEWAY_URL ?? "http://localhost:7892";
const BUFFER_SIZE = parseInt(process.env.AGENTLOG_PROBE_BUFFER_SIZE ?? "100", 10);
const FLUSH_INTERVAL_MS = parseInt(process.env.AGENTLOG_PROBE_FLUSH_MS ?? "5000", 10);

// ─────────────────────────────────────────────
// Telemetry Event Interface
// ─────────────────────────────────────────────

interface TelemetryEvent {
  id: string;
  traceId: string;
  actorType: "human" | "agent" | "system";
  actorName: string;
  event: string;
  payload: Record<string, unknown>;
  timestamp: string;
  source: "openclaw_telemetry";
}

// ─────────────────────────────────────────────
// Simple Buffer
// ─────────────────────────────────────────────

const eventBuffer: TelemetryEvent[] = [];
let traceId: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getTraceId(): string {
  if (!traceId) {
    traceId = ulid();
  }
  return traceId;
}

async function reportEvent(event: TelemetryEvent): Promise<void> {
  try {
    const resp = await fetch(`${GATEWAY_URL}/api/spans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        traceId: event.traceId,
        actorType: event.actorType,
        actorName: event.actorName,
        payload: {
          source: event.source,
          event: event.event,
          ...event.payload,
        },
      }),
    });

    if (!resp.ok) {
      console.error(`[AgentLog] Failed to report event: HTTP ${resp.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[AgentLog] Report error: ${msg}`);
  }
}

async function flushBuffer(): Promise<void> {
  if (eventBuffer.length === 0) {
    return;
  }

  const events = eventBuffer.splice(0, eventBuffer.length);
  console.log(`[AgentLog] Flushing ${events.length} events`);

  await Promise.all(events.map((e) => reportEvent(e)));
}

function scheduleFlush(): void {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushBuffer();
    scheduleFlush();
  }, FLUSH_INTERVAL_MS);
}

function pushEvent(event: TelemetryEvent): void {
  eventBuffer.push(event);
  if (eventBuffer.length >= BUFFER_SIZE) {
    void flushBuffer();
  }
}

// ─────────────────────────────────────────────
// Hook Handler
// ─────────────────────────────────────────────

interface InternalHookEvent {
  type: "command" | "session" | "agent" | "gateway" | "message";
  action: string;
  timestamp: Date;
  sessionKey?: string;
  context?: Record<string, unknown>;
}

type HookHandler = (event: InternalHookEvent) => Promise<void> | void;

const agentlogTelemetryHook: HookHandler = async (event: InternalHookEvent): Promise<void> => {
  // Start flush timer on first event
  scheduleFlush();

  switch (event.type) {
    case "agent":
      if (event.action === "bootstrap") {
        const ctx = event.context ?? {};
        pushEvent({
          id: ulid(),
          traceId: getTraceId(),
          actorType: "agent",
          actorName: (ctx.agentId as string) ?? "OpenClaw",
          event: "agent:bootstrap",
          payload: {
            agentId: (ctx.agentId as string) ?? "unknown",
            workspaceDir: (ctx.workspaceDir as string) ?? process.cwd(),
            sessionKey: event.sessionKey,
          },
          timestamp: event.timestamp.toISOString(),
          source: "openclaw_telemetry",
        });
      }
      break;

    case "session":
      if (event.action === "start") {
        pushEvent({
          id: ulid(),
          traceId: getTraceId(),
          actorType: "system",
          actorName: "OpenClaw-Session",
          event: "session:start",
          payload: {
            sessionKey: event.sessionKey ?? "unknown",
            sessionId: (event.context?.sessionId as string) ?? "unknown",
          },
          timestamp: event.timestamp.toISOString(),
          source: "openclaw_telemetry",
        });
      } else if (event.action === "end") {
        pushEvent({
          id: ulid(),
          traceId: getTraceId(),
          actorType: "system",
          actorName: "OpenClaw-Session",
          event: "session:end",
          payload: {
            sessionKey: event.sessionKey ?? "unknown",
            sessionId: (event.context?.sessionId as string) ?? "unknown",
            durationMs: event.context?.durationMs as number | undefined,
          },
          timestamp: event.timestamp.toISOString(),
          source: "openclaw_telemetry",
        });
      }
      break;
  }
};

// Graceful shutdown
process.on("SIGTERM", async () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushBuffer();
  process.exit(0);
});

export default agentlogTelemetryHook;
