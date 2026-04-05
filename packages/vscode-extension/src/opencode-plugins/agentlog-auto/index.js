/**
 * AgentLog Auto Logging Plugin for OpenCode
 *
 * Automatically logs agent activities to AgentLog backend API.
 * Records: Trace, Span
 */

const PLUGIN_VERSION = "3.0.0";

const DEFAULT_BACKEND_URL = "http://localhost:7892";
const API_BASE = `${DEFAULT_BACKEND_URL}/api`;

let currentTraceId = null;
let currentSpanId = null;
let currentModel = null;
let turnCount = 0;
let workspacePath = null;
let isLogging = false;

async function apiPost(path, body) {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(`[agentlog-auto] API POST ${path} failed: HTTP ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.error(`[agentlog-auto] API POST ${path} error: ${err.message}`);
    return null;
  }
}

async function createTrace(taskGoal) {
  const result = await apiPost("/traces", {
    taskGoal: taskGoal || "OpenCode Session",
    workspacePath: workspacePath || process.cwd(),
  });

  if (result?.success && result.data?.id) {
    currentTraceId = result.data.id;
    turnCount = 0;
    return currentTraceId;
  }
  return null;
}

async function createSpan(actorType, actorName, payload, toolName, toolInput, toolResult) {
  if (!currentTraceId) {
    await createTrace("OpenCode Session");
  }

  if (!currentTraceId) {
    return null;
  }

  const span = await apiPost("/spans", {
    traceId: currentTraceId,
    parentSpanId: currentSpanId,
    actorType,
    actorName,
    payload: payload || {},
    toolName,
    toolInput,
    toolResult,
    cwd: workspacePath || process.cwd(),
  });

  if (span?.success && span.data?.id) {
    currentSpanId = span.data.id;
    turnCount++;
    return currentSpanId;
  }
  return null;
}

async function logUserMessage(content, model) {
  if (!currentTraceId) {
    await createTrace("OpenCode Session");
  }

  await createSpan(
    "agent",
    "user",
    { role: "user", content: content.slice(0, 10000) }
  );
}

async function logAssistantResponse(content) {
  if (!currentTraceId) return;

  await createSpan(
    "agent",
    "assistant",
    { role: "assistant", content: content.slice(0, 10000) }
  );
}

async function logToolCall(toolName, args, output) {
  if (!currentTraceId) {
    await createTrace("OpenCode Session");
  }

  const toolInput = typeof args === "object" ? args : { raw: String(args).slice(0, 500) };
  const toolResult = typeof output === "string" ? { output } : output;

  await createSpan(
    "agent",
    "tool",
    { toolName, result: output },
    toolName,
    toolInput,
    toolResult
  );
}

async function logIntent(task, affectedFiles = []) {
  if (!currentTraceId) return;
}

export const agentlogPlugin = async (ctx) => {
  workspacePath = ctx.directory;

  return {
    event: async ({ event }) => {
      const props = event.properties || {};
      const info = props.info || {};
      const part = props.part || {};

      switch (event.type) {
        case "session.created": {
          if (info?.id) {
            currentModel = null;
          }
          break;
        }

        case "message.updated": {
          const msg = info;
          if (msg?.role === "assistant") {
            if (msg?.modelID) {
              currentModel = msg.modelID;
            }
            if (msg?.content && currentTraceId) {
              await logAssistantResponse(msg.content);
            }
          }
          break;
        }

        case "message.part.updated": {
          const part = props.part;
          const msg = info;
          if (part?.type === "text" && part?.text && msg?.role === "user") {
            await logUserMessage(part.text, currentModel);
          } else if (part?.type === "text" && part?.text && msg?.role === "assistant") {
            await logAssistantResponse(part.text);
          }
          break;
        }

        case "message.part.delta": {
          const part = props.part;
          const msg = info;
          if (part?.delta && msg?.role === "assistant") {
            await logAssistantResponse(part.delta);
          }
          break;
        }

        case "session.status": {
          if (props?.status?.type === "idle" && currentTraceId) {
            await logIntent("Task completed", []);
          }
          break;
        }

        case "server.instance.disposed": {
          if (currentTraceId) {
            await logIntent("Session ended", []);
          }
          currentTraceId = null;
          currentSpanId = null;
          break;
        }
      }
    },

    "tool.execute.before": async (input, output) => {
      // No-op
    },

    "tool.execute.after": async (input, output) => {
      if (isLogging) return;
      isLogging = true;

      try {
        const { tool, args } = input;
        const { output: toolOutput, metadata } = output;

        if (!currentTraceId) {
          await createTrace("OpenCode Session");
        }

        let summary = "";
        if (metadata?.title) {
          summary = metadata.title;
        } else if (typeof toolOutput === "string") {
          summary = toolOutput.slice(0, 500);
        } else if (toolOutput) {
          summary = JSON.stringify(toolOutput).slice(0, 500);
        }

        await logToolCall(tool, args, summary || "(no output)");
      } finally {
        isLogging = false;
      }
    },
  };
};
