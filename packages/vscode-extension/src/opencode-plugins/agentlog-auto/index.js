/**
 * AgentLog Auto Logging Plugin for OpenCode
 *
 * 自动监听 OpenCode 会话事件，记录 Agent 交互过程到 AgentLog 后端。
 *
 * 功能：
 * 1. Handoff 接力（session.created）
 *    - 新会话建立时自动认领 pending trace，或创建新 trace
 *
 * 2. 自动抓取 Agent 交互
 *    - session.status (idle) → 通过 client.session.messages() 获取完整消息（含 token）
 *    - tool.execute.after     → 工具调用
 */

const PLUGIN_VERSION = "6.6.0";

const DEFAULT_BACKEND_URL = process.env.AGENTLOG_GATEWAY_URL || "http://localhost:7892";
const API_BASE = `${DEFAULT_BACKEND_URL}/api`;

// ── 进程级状态 ────────────────────────────────────────────────────────────────

let currentTraceId = null;
let currentSpanId = null;
let currentSessionID = null;
let currentModel = null;
let currentAgentSource = "opencode";
let turnCount = 0;
let workspacePath = null;
let isLogging = false;
// 是否为接力认领的 trace（若是，则不覆盖原始 taskGoal）
let isResumedTrace = false;

// 防止并发创建 trace 的初始化锁
let traceInitPromise = null;

// 消息元数据缓存：从 message.updated 缓存，message.part.updated 时使用
const messageStore = new Map();
// 记录已通过 message.part.updated 实时尝试处理的 user message（防重复）
const seenUserMessages = new Set();
// 记录已成功写入 span 的消息 ID（供 syncSessionMessages 去重）
const syncedMessageIds = new Set();

// 当前正在处理的消息的额外元数据（model、tokens、reasoning 等）
let currentMessageMeta = {};

// ── 后端 API 工具函数 ─────────────────────────────────────────────────────────

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

async function apiPatch(path, body) {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(`[agentlog-auto] API PATCH ${path} failed: HTTP ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.error(`[agentlog-auto] API PATCH ${path} error: ${err.message}`);
    return null;
  }
}

async function apiGet(path) {
  try {
    const response = await fetch(`${API_BASE}${path}`);
    if (!response.ok) {
      console.error(`[agentlog-auto] API GET ${path} failed: HTTP ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.error(`[agentlog-auto] API GET ${path} error: ${err.message}`);
    return null;
  }
}

// ── Trace / Span 创建 ─────────────────────────────────────────────────────────

// ── 写入 git config agentlog.traceId，供 post-commit hook 绑定 trace ──────────
async function persistTraceIdToGitConfig(traceId, wsPath) {
  try {
    await apiPost("/hooks/config", {
      workspacePath: wsPath || workspacePath || process.cwd(),
      key: "agentlog.traceId",
      value: traceId,
    });
  } catch (err) {
    // 非致命错误，静默忽略
    console.error(`[agentlog-auto] persistTraceIdToGitConfig error: ${err?.message}`);
  }
}

async function createTrace(taskGoal) {
  const result = await apiPost("/traces", {
    taskGoal: taskGoal || "OpenCode Session",
    workspacePath: workspacePath || process.cwd(),
  });

  if (result?.success && result.data?.id) {
    currentTraceId = result.data.id;
    currentSpanId = null;
    turnCount = 0;
    await persistTraceIdToGitConfig(currentTraceId, workspacePath);
    return currentTraceId;
  }
  return null;
}

// ── Handoff：认领 pending trace，或创建新 trace ──────────────────────────────

async function claimOrCreateTrace(wsPath) {
  // 防止重复初始化：如果已有 trace，跳过
  if (currentTraceId) {
    return;
  }

  // 如果已有初始化在进行中，等待其完成（防止并发创建两个 trace）
  if (traceInitPromise) {
    return traceInitPromise;
  }

  traceInitPromise = (async () => {
    try {
      const ws = wsPath || process.cwd();
      const qs = new URLSearchParams({ workspacePath: ws, agentType: "opencode" }).toString();

      // 1. 查询当前工作区是否有 pending trace
      const pending = await apiGet(`/traces/pending?${qs}`);

      if (pending?.success && pending.data?.length) {
        // 2a. 有 pending trace → 认领
        const item = pending.data[0];
        const traceId = item.traceId || item.id;
        if (!traceId) return;

        const result = await apiPost(`/traces/${traceId}/resume`, {
          agentType: "opencode",
          workspacePath: ws,
        });

        if (result?.success) {
          currentTraceId = traceId;
          currentSpanId = null;
          isResumedTrace = true;
          await persistTraceIdToGitConfig(traceId, ws);
        }
      } else {
        // 2b. 无 pending trace → 创建新 trace
        isResumedTrace = false;
        await createTrace("OpenCode Session");
      }
    } catch (err) {
      console.error(`[agentlog-auto] claimOrCreateTrace error: ${err.message}`);
    } finally {
      traceInitPromise = null;
    }
  })();

  return traceInitPromise;
}

// ── 插件主体 ──────────────────────────────────────────────────────────────────

export const agentlogPlugin = async ({ worktree, directory, client }) => {
  workspacePath = worktree || directory || process.cwd();

  // 从 client 会话消息中提取文本内容
  function extractMessageContent(message) {
    const parts = message.parts || [];
    const contentParts = [];
    const reasoningParts = [];

    for (const p of parts) {
      // text 内容：兼容 p.text / p.content
      if (p.type === "text") {
        const t = p.text ?? p.content ?? "";
        if (t) contentParts.push(t);
      }
      // thinking/reasoning 内容：兼容多种字段名
      if (p.type === "thinking" || p.type === "reasoning") {
        const t = p.thinking ?? p.text ?? p.content ?? "";
        if (t) reasoningParts.push(t);
      }
    }

    return {
      content: contentParts.join("\n"),
      reasoning: reasoningParts.join("\n"),
    };
  }

  // 从 client 获取完整消息并创建/更新 spans
  async function syncSessionMessages(sessionID) {
    if (!currentTraceId || !client) {
      return;
    }

    try {
      // 调用 client.session.messages 获取完整消息（含 tokenUsage）
      const result = await client.session.messages({ path: { id: sessionID } });
      if (!result?.data) {
        return;
      }

      const messages = result.data;
      let lastSpanId = currentSpanId;

      // 先单独更新 taskGoal（第一条用户消息），不受 syncedMessageIds 影响
      // 接力认领的 trace 不覆盖原始 taskGoal
      if (!isResumedTrace) {
        for (const msgEntry of messages) {
          const msg = msgEntry?.info ?? msgEntry;
          if (msg?.role !== "user") continue;
          const partsSource = { parts: msgEntry.parts ?? msg.parts ?? [] };
          const { content } = extractMessageContent(partsSource);
          if (content) {
            await apiPatch(`/traces/${currentTraceId}`, { taskGoal: content.slice(0, 200) });
            // console.log(`[agentlog-auto] taskGoal 已更新: ${content.slice(0, 60)}`);
            break;
          }
        }
      }

      for (const msgEntry of messages) {
        // info 字段含消息元数据，parts 字段含内容分片（两者都在 msgEntry 顶层）
        const msg = msgEntry?.info ?? msgEntry;
        if (!msg?.id) continue;

        // 已成功记录过的消息跳过
        if (syncedMessageIds.has(msg.id)) continue;

        // parts 在 msgEntry.parts（不在 msgEntry.info 里）
        const partsSource = { parts: msgEntry.parts ?? msg.parts ?? [] };
        const { content, reasoning } = extractMessageContent(partsSource);
        if (!content && !reasoning) {
          const partsSummary = (partsSource.parts).map(p => `{type:${p.type},keys:${Object.keys(p).join(",")}}`).join(" | ");
          // console.log(`[agentlog-auto] 消息无内容 role=${msg.role} parts=${partsSummary || "(空)"}`);
          continue;
        }

        const model = msg.modelID || currentModel || "unknown";
        const source = currentAgentSource;

        // 将 OpenCode tokens 格式映射到后端期望的 TokenUsage 格式
        const rawTokens = msg.usage || msg.tokens || null;
        const tokenUsage = rawTokens ? {
          inputTokens: rawTokens.input ?? rawTokens.inputTokens ?? 0,
          outputTokens: rawTokens.output ?? rawTokens.outputTokens ?? 0,
          cacheCreationTokens: rawTokens.cache?.write ?? rawTokens.cacheCreationTokens ?? 0,
          cacheReadTokens: rawTokens.cache?.read ?? rawTokens.cacheReadTokens ?? 0,
        } : null;

        if (msg.role === "user") {
          const span = await apiPost("/spans", {
            traceId: currentTraceId,
            parentSpanId: lastSpanId,
            actorType: "agent",
            actorName: "user",
            payload: {
              role: "user",
              content: content.slice(0, 10000),
              model,
              source,
            },
            cwd: workspacePath,
          });
          if (span?.success && span.data?.id) {
            lastSpanId = span.data.id;
            turnCount++;
            syncedMessageIds.add(msg.id);
            // console.log(`[agentlog-auto] 同步用户消息 span: ${span.data.id}`);
          } else {
            console.error(`[agentlog-auto] 用户消息 span 记录失败 (msgId=${msg.id})`);
          }
        } else if (msg.role === "assistant") {
          const span = await apiPost("/spans", {
            traceId: currentTraceId,
            parentSpanId: lastSpanId,
            actorType: "agent",
            actorName: "assistant",
            payload: {
              role: "assistant",
              content: content ? content.slice(0, 10000) : undefined,
              reasoning: reasoning ? reasoning.slice(0, 10000) : undefined,
              tokenUsage,
              model,
              source,
            },
            cwd: workspacePath,
          });
          if (span?.success && span.data?.id) {
            lastSpanId = span.data.id;
            syncedMessageIds.add(msg.id);
            // console.log(`[agentlog-auto] 同步助手消息 span: ${span.data.id}`);
          } else {
            console.error(`[agentlog-auto] 助手消息 span 记录失败 (msgId=${msg.id})`);
          }
        }
      }

      currentSpanId = lastSpanId;
    } catch (err) {
      console.error(`[agentlog-auto] syncSessionMessages error: ${err.message}`);
    }
  }

  return {
    // ── 事件监听 ──────────────────────────────────────────────────────────────
    event: async ({ event }) => {
      const props = (event || {}).properties || {};
      const info = props.info || {};
      const part = props.part || {};

      switch (event.type) {
        // ── 新会话：认领 pending trace 或创建新 trace ─────────────────────
        case "session.created": {
          const session = info;
          if (session?.id) {
            // 重置 per-session 状态
            if (currentSessionID !== session.id) {
              seenUserMessages.clear();
              syncedMessageIds.clear();
              messageStore.clear();
              currentModel = null;
              currentSpanId = null;
            }
            currentSessionID = session.id;
          }
          await claimOrCreateTrace(workspacePath);
          break;
        }

        // ── 消息元数据更新：缓存消息 ────────────────────────────────────
        case "message.updated": {
          const msg = info;
          if (!msg?.id) break;
          messageStore.set(msg.id, msg);
          if (msg.role === "assistant" && msg.modelID) {
            currentModel = msg.modelID;
          }
          break;
        }

        // ── 消息分片更新：记录用户输入 ──────────────────────────────────
        case "message.part.updated": {
          const msg = messageStore.get(part.messageID);
          const sessionID = msg?.sessionID ?? currentSessionID;
          if (!sessionID) break;

          // 只处理 text 类型的用户消息
          if (msg?.role === "user" && part?.type === "text" && part?.text) {
            if (!seenUserMessages.has(msg.id)) {
              seenUserMessages.add(msg.id);
              // console.log(`[agentlog-auto] 用户消息: ${part.text.slice(0, 80)}...`);

              // 确保 trace 已初始化
              if (!currentTraceId) {
                await claimOrCreateTrace(workspacePath);
              }
              if (!currentTraceId) break;

              // 记录用户消息
              const span = await apiPost("/spans", {
                traceId: currentTraceId,
                parentSpanId: currentSpanId,
                actorType: "agent",
                actorName: "user",
                payload: {
                  role: "user",
                  content: part.text.slice(0, 10000),
                  model: currentModel || "unknown",
                  source: currentAgentSource,
                },
              });
              if (span?.success && span.data?.id) {
                currentSpanId = span.data.id;
                turnCount++;
                syncedMessageIds.add(msg.id);
              } else {
                // span 记录失败，从 seenUserMessages 移除以便 sync 重试
                seenUserMessages.delete(msg.id);
              }
            }
          }
          break;
        }

        // ── 会话空闲：同步完整消息（含 token）─────────────────────────
        case "session.status": {
          if (props?.status?.type === "idle" && currentTraceId && currentSessionID) {
            // console.log(`[agentlog-auto] 会话进入 idle，sync messages，trace: ${currentTraceId}`);
            await syncSessionMessages(currentSessionID);
          }
          break;
        }

        // ── 会话销毁时重置状态 ───────────────────────────────────────────
        case "server.instance.disposed": {
          currentTraceId = null;
          currentSpanId = null;
          currentSessionID = null;
          traceInitPromise = null;
          isResumedTrace = false;
          seenUserMessages.clear();
          syncedMessageIds.clear();
          messageStore.clear();
          turnCount = 0;
          break;
        }
      }
    },

    // ── 工具调用后记录 Span ────────────────────────────────────────────────
    "tool.execute.after": async (input, output) => {
      if (isLogging) return;
      isLogging = true;

      try {
        const { tool, args } = input;
        const { output: toolOutput, metadata } = output;

        if (!currentTraceId) {
          await claimOrCreateTrace(workspacePath);
        }

        if (!currentTraceId) return;

        let summary = "";
        if (metadata?.title) {
          summary = metadata.title;
        } else if (typeof toolOutput === "string") {
          summary = toolOutput.slice(0, 500);
        } else if (toolOutput) {
          summary = JSON.stringify(toolOutput).slice(0, 500);
        }

        const span = await apiPost("/spans", {
          traceId: currentTraceId,
          parentSpanId: currentSpanId,
          actorType: "agent",
          actorName: "tool",
          payload: {
            toolName: tool,
            toolInput: typeof args === "object" ? args : { raw: String(args).slice(0, 500) },
            result: summary || "(no output)",
            model: currentModel || "unknown",
            source: currentAgentSource,
          },
          cwd: workspacePath,
        });

        if (span?.success && span.data?.id) {
          currentSpanId = span.data.id;
        }
      } finally {
        isLogging = false;
      }
    },
  };
};

export default agentlogPlugin;
