/**
 * AgentLog Auto Logging Skill - Trace/Span Based Version
 *
 * Implements automatic logging of agent activities to AgentLog MCP server.
 * Uses MCP protocol for trace/span storage:
 * 
 * Flow:
 * 1. log_turn(role="user") → creates trace, returns trace_id
 * 2. log_turn(role="tool", trace_id="xxx") → creates span
 * 3. log_intent(trace_id="xxx") → marks trace as completed
 */

import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────
// Backend Configuration
// ─────────────────────────────────────────────

const MCP_URL = process.env.AGENTLOG_MCP_URL || 'http://localhost:7892';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface AgentLogConfig {
  mcpUrl: string;
  autoBindCommit: boolean;
  reasoningCapture: boolean;
  toolCallCapture: boolean;
  sessionTimeout: number;
}

interface SessionState {
  traceId: string | null;
  sessionId: string;
  startedAt: string;
  reasoning: string[];
  toolCalls: ToolCall[];
  responses: Response[];
  model: string;
  agentSource: string;
  workspacePath: string;
  taskGoal: string;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output?: string;
  durationMs: number;
  timestamp: string;
}

interface Response {
  content: string;
  timestamp: string;
}

interface McpResponse {
  success: boolean;
  sessionId?: string;
  trace_id?: string;
  data?: unknown;
  error?: string;
}

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────

let config: AgentLogConfig = {
  mcpUrl: MCP_URL,
  autoBindCommit: true,
  reasoningCapture: true,
  toolCallCapture: true,
  sessionTimeout: 600,
};

let currentSession: SessionState | null = null;

// ─────────────────────────────────────────────
// MCP Client
// ─────────────────────────────────────────────

async function mcpRequest(tool: string, args: Record<string, unknown>): Promise<McpResponse> {
  try {
    const response = await fetch(`${config.mcpUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: `tools/call`,
        params: {
          name: tool,
          arguments: args,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    
    // Extract trace_id from MCP response if present
    // The MCP returns trace_id in the content text or in the result
    let traceId: string | undefined;
    if (typeof data.result?.content === 'string') {
      const match = data.result.content.match(/trace[_-]?id[:\s=]+([A-Z0-9]+)/i);
      if (match) traceId = match[1];
    }
    if (data.result?.trace_id) traceId = data.result.trace_id;
    
    return { 
      success: true, 
      sessionId: data.sessionId,
      trace_id: traceId,
      data: data.result 
    };
  } catch (error) {
    console.error('[agentlog-auto] MCP request failed:', error);
    return { success: false, error: String(error) };
  }
}

// ─────────────────────────────────────────────
// Session Management with MCP Protocol
// ─────────────────────────────────────────────

async function startSession(model: string, source: string, workspacePath: string): Promise<string> {
  const sessionId = `sess_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const taskGoal = `Agent session from ${source}`;

  currentSession = {
    traceId: null,  // Will be set by first log_turn call
    sessionId,
    startedAt: new Date().toISOString(),
    reasoning: [],
    toolCalls: [],
    responses: [],
    model,
    agentSource: source,
    workspacePath,
    taskGoal,
  };

  // First log_turn(role="user") creates the trace and returns trace_id
  const result = await mcpRequest('log_turn', {
    role: 'user',
    content: taskGoal,
    model: model,
    workspace_path: workspacePath,
  });

  // Extract trace_id from response
  if (result.trace_id) {
    currentSession.traceId = result.trace_id;
  } else if (typeof result.data === 'object' && result.data !== null) {
    const data = result.data as Record<string, unknown>;
    if (data.trace_id) currentSession.traceId = String(data.trace_id);
  }

  console.log(`[agentlog-auto] Session started: ${sessionId}, trace: ${currentSession.traceId || '(pending)'} (source: ${source})`);
  return sessionId;
}

async function logToolCall(toolName: string, toolInput: Record<string, unknown>, toolOutput?: string, durationMs?: number): Promise<void> {
  if (!currentSession) return;

  const toolCall: ToolCall = {
    name: toolName,
    input: toolInput,
    output: toolOutput,
    durationMs: durationMs || 0,
    timestamp: new Date().toISOString(),
  };

  currentSession.toolCalls.push(toolCall);

  // Call MCP log_turn with trace_id (span creation)
  await mcpRequest('log_turn', {
    trace_id: currentSession.traceId,
    role: 'tool',
    content: JSON.stringify({ tool: toolName, input: toolInput, output: toolOutput }),
    tool_name: toolName,
    duration_ms: durationMs,
    timestamp: toolCall.timestamp,
    workspace_path: currentSession.workspacePath,
  });
}

// ─────────────────────────────────────────────
// Git Commit Binding
// ─────────────────────────────────────────────

async function tryBindCommit(): Promise<void> {
  if (!config.autoBindCommit || !currentSession) return;

  try {
    const { execSync } = await import('child_process');
    
    const commitHash = execSync('git rev-parse HEAD 2>/dev/null', { encoding: 'utf8' }).trim();
    const commitMessage = execSync('git log -1 --format=%s 2>/dev/null', { encoding: 'utf8' }).trim();
    
    if (commitHash) {
      console.log(`[agentlog-auto] Bound session ${currentSession.sessionId} to commit ${commitHash.slice(0, 7)}`);
    }
  } catch (error) {
    console.log('[agentlog-auto] No git commit to bind (or not a git repo)');
  }
}

// ─────────────────────────────────────────────
// OpenClaw Hooks Implementation
// ─────────────────────────────────────────────

/**
 * Session start hook - initialize new session with trace
 */
export async function onSessionStart(params: {
  sessionKey: string;
  model: string;
  workspacePath?: string;
}): Promise<void> {
  const source = detectAgentSource();
  const workspace = params.workspacePath || process.cwd();
  await startSession(params.model, source, workspace);
  console.log(`[agentlog-auto] Session started for ${params.sessionKey}`);
}

/**
 * Before tool call hook - log tool parameters
 */
export async function beforeToolCall(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
}): Promise<void> {
  if (!config.toolCallCapture) return;
  params.toolInput._agentlog_startTime = Date.now();
}

/**
 * After tool call hook - log tool results with trace_id
 */
export async function afterToolCall(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: string;
  error?: string;
}): Promise<void> {
  if (!config.toolCallCapture) return;

  const startTime = params.toolInput._agentlog_startTime as number || Date.now();
  const durationMs = Date.now() - startTime;

  await logToolCall(
    params.toolName,
    params.toolInput,
    params.error || params.toolOutput,
    durationMs
  );
}

/**
 * Phase 2: Extract reasoning from message content
 */
function extractReasoningFromMessages(
  messages: Array<{ role: string; content: string | Array<unknown> }>,
): void {
  if (!currentSession) return;

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    if (typeof msg.content === 'string') {
      const reasoning = extractReasoningFromText(msg.content);
      if (reasoning) {
        currentSession.reasoning.push(reasoning);
      }
      continue;
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'thinking' || b.type === 'thought' || b.type === 'reasoning') {
          const thinking = typeof b.thinking === 'string' ? b.thinking
            : typeof b.content === 'string' ? b.content
            : typeof b.text === 'string' ? b.text
            : JSON.stringify(b);
          if (thinking) {
            currentSession.reasoning.push(thinking.slice(0, 4000));
          }
        }
        if (b.type === 'text' && typeof b.text === 'string') {
          const reasoning = extractReasoningFromText(b.text);
          if (reasoning) {
            currentSession.reasoning.push(reasoning);
          }
        }
      }
    }
  }

  if (currentSession.reasoning.length > 0) {
    console.log(`[agentlog-auto] Captured ${currentSession.reasoning.length} reasoning blocks`);
  }
}

/**
 * Extract <thinking>...</thinking> tags from text content
 */
function extractReasoningFromText(text: string): string | null {
  const thinkingMatch = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (thinkingMatch && thinkingMatch[1].trim()) {
    return thinkingMatch[1].trim().slice(0, 4000);
  }
  const reasoningMatch = text.match(/\[REASONING\]([\s\S]*?)\[\/REASONING\]/i);
  if (reasoningMatch && reasoningMatch[1].trim()) {
    return reasoningMatch[1].trim().slice(0, 4000);
  }
  return null;
}

/**
 * Agent end hook - finalize and log intent
 * log_intent marks trace as completed via MCP
 */
export async function onAgentEnd(params: {
  messages: Array<{ role: string; content: string | Array<unknown> }>;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}): Promise<void> {
  if (!currentSession) return;

  if (config.reasoningCapture) {
    extractReasoningFromMessages(params.messages);
  }

  await tryBindCommit();

  const lastMessage = params.messages[params.messages.length - 1];
  const content = typeof lastMessage?.content === 'string'
    ? lastMessage.content
    : JSON.stringify(lastMessage?.content ?? '');
  const task = content.slice(0, 200) || 'Agent task completed';

  // Call log_intent with trace_id - this marks trace as completed
  await mcpRequest('log_intent', {
    trace_id: currentSession.traceId,
    task: currentSession.taskGoal,
    model: currentSession.model,
    session_id: currentSession.sessionId,
    tool_calls: currentSession.toolCalls.map(t => t.name),
    duration_ms: Date.now() - new Date(currentSession.startedAt).getTime(),
    completed_at: new Date().toISOString(),
  });

  console.log(`[agentlog-auto] Session ended: ${currentSession.sessionId}, trace: ${currentSession.traceId}`);
  currentSession = null;
}

/**
 * Session end hook - cleanup
 */
export async function onSessionEnd(): Promise<void> {
  if (currentSession) {
    await tryBindCommit();
    currentSession = null;
  }
  console.log('[agentlog-auto] Session cleanup completed');
}

// ─────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────

function detectAgentSource(): string {
  // Detect agent source from process.cwd() - matches openclaw agent workspace paths
  const workspacePath = process.cwd();
  const match = workspacePath.match(/\/agents\/([^\/]+)\/workspace/);
  if (match) {
    return `openclaw:${match[1]}`;
  }
  
  const args = process.argv.join(' ');
  
  if (args.includes('opencode')) return 'opencode';
  if (args.includes('cline')) return 'cline';
  if (args.includes('cursor')) return 'cursor';
  if (args.includes('trae')) return 'trae';
  if (args.includes('claude')) return 'claude-code';
  if (args.includes('copilot')) return 'copilot';
  if (args.includes('continue')) return 'continue';
  
  return 'openclaw';
}

// ─────────────────────────────────────────────
// Skill Registration
// ─────────────────────────────────────────────

export const skill = {
  name: 'agentlog-auto',
  version: '2.0.0',
  hooks: {
    'session:start': onSessionStart,
    'tool:before_call': beforeToolCall,
    'tool:after_call': afterToolCall,
    'agent:end': onAgentEnd,
    'session:end': onSessionEnd,
  },
  commands: [
    {
      name: 'agentlog-status',
      description: 'Check AgentLog MCP connection status',
      handler: async () => {
        const result = await mcpRequest('health', {});
        return result.success ? 'AgentLog MCP: Connected' : `AgentLog MCP: Error - ${result.error}`;
      },
    },
    {
      name: 'agentlog-session',
      description: 'Show current session info',
      handler: () => {
        if (!currentSession) return 'No active session';
        return `Trace: ${currentSession.traceId || '(pending)'}\nSession: ${currentSession.sessionId}\nModel: ${currentSession.model}\nStarted: ${currentSession.startedAt}\nTool calls: ${currentSession.toolCalls.length}\nReasoning: ${currentSession.reasoning.length}`;
      },
    },
  ],
};

export default skill;
