/**
 * AgentLog Auto Logging Skill - OpenClaw Hooks
 * 
 * Implements automatic logging of agent activities to AgentLog MCP server.
 */

import { randomUUID } from 'crypto';

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
  sessionId: string;
  startedAt: string;
  reasoning: string[];
  toolCalls: ToolCall[];
  responses: Response[];
  model: string;
  agentSource: string;
  workspacePath: string;
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

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────

let config: AgentLogConfig = {
  mcpUrl: process.env.AGENTLOG_MCP_URL || 'http://localhost:7892',
  autoBindCommit: true,
  reasoningCapture: true,
  toolCallCapture: true,
  sessionTimeout: 600,
};

let currentSession: SessionState | null = null;
let pendingLogs: Array<() => Promise<void>> = [];

// ─────────────────────────────────────────────
// MCP Client
// ─────────────────────────────────────────────

async function mcpRequest(tool: string, args: Record<string, unknown>): Promise<{ sessionId?: string; success: boolean; error?: string }> {
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
    return { success: true, sessionId: data.sessionId };
  } catch (error) {
    console.error('[agentlog-auto] MCP request failed:', error);
    return { success: false, error: String(error) };
  }
}

// ─────────────────────────────────────────────
// Session Management
// ─────────────────────────────────────────────

function startSession(model: string, source: string, workspacePath: string): string {
  const sessionId = `sess_${Date.now()}_${randomUUID().slice(0, 8)}`;
  
  currentSession = {
    sessionId,
    startedAt: new Date().toISOString(),
    reasoning: [],
    toolCalls: [],
    responses: [],
    model,
    agentSource: source,
    workspacePath,
  };

  console.log(`[agentlog-auto] Session started: ${sessionId}`);
  return sessionId;
}

async function logTurn(role: 'user' | 'assistant' | 'tool', content: string, reasoning?: string): Promise<void> {
  if (!currentSession) {
    startSession('unknown', 'opencl sweep', process.cwd());
  }

  const payload: Record<string, unknown> = {
    session_id: currentSession!.sessionId,
    role,
    content,
    model: currentSession!.model,
    timestamp: new Date().toISOString(),
  };

  if (reasoning) {
    currentSession!.reasoning.push(reasoning);
    payload.reasoning = reasoning;
  }

  await mcpRequest('log_turn', payload);
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

  currentSession!.toolCalls.push(toolCall);

  await mcpRequest('log_turn', {
    session_id: currentSession!.sessionId,
    role: 'tool',
    content: JSON.stringify({ tool: toolName, input: toolInput, output: toolOutput }),
    tool_name: toolName,
    duration_ms: durationMs,
    timestamp: toolCall.timestamp,
  });
}

async function logIntent(task: string, model: string): Promise<void> {
  if (!currentSession) return;

  const summary = currentSession!.reasoning.length > 0
    ? `Reasoning steps: ${currentSession!.reasoning.length}, Tool calls: ${currentSession!.toolCalls.length}, Responses: ${currentSession!.responses.length}`
    : `Tool calls: ${currentSession!.toolCalls.length}, Responses: ${currentSession!.responses.length}`;

  await mcpRequest('log_intent', {
    session_id: currentSession!.sessionId,
    task,
    model,
    summary,
    tool_calls: currentSession!.toolCalls.map(t => t.name),
    duration_ms: Date.now() - new Date(currentSession!.startedAt).getTime(),
    completed_at: new Date().toISOString(),
  });

  console.log(`[agentlog-auto] Session ended: ${currentSession!.sessionId}`);
  currentSession = null;
}

// ─────────────────────────────────────────────
// Git Commit Binding
// ─────────────────────────────────────────────

async function tryBindCommit(): Promise<void> {
  if (!config.autoBindCommit || !currentSession) return;

  try {
    const { execSync } = await import('child_process');
    
    // Get recent commit hash
    const commitHash = execSync('git rev-parse HEAD 2>/dev/null', { encoding: 'utf8' }).trim();
    const commitMessage = execSync('git log -1 --format=%s 2>/dev/null', { encoding: 'utf8' }).trim();
    
    if (commitHash && currentSession.sessionId) {
      await mcpRequest('bind_session_commit', {
        session_id: currentSession.sessionId,
        commit_hash: commitHash,
        commit_message: commitMessage,
        workspace_path: currentSession.workspacePath,
      });
      
      console.log(`[agentlog-auto] Bound session ${currentSession.sessionId} to commit ${commitHash.slice(0, 7)}`);
    }
  } catch (error) {
    // Git not available or not a git repo - this is fine
    console.log('[agentlog-auto] No git commit to bind (or not a git repo)');
  }
}

// ─────────────────────────────────────────────
// OpenClaw Hooks Implementation
// ─────────────────────────────────────────────

/**
 * Session start hook - initialize new session
 */
export async function onSessionStart(params: {
  sessionKey: string;
  model: string;
  workspacePath?: string;
}): Promise<void> {
  const source = detectAgentSource();
  startSession(params.model, source, params.workspacePath || process.cwd());
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
  
  // Store tool call start time for duration calculation
  params.toolInput._agentlog_startTime = Date.now();
}

/**
 * After tool call hook - log tool results
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
 * Supports models with thinking blocks (DeepSeek-R1, Claude extended thinking, etc.)
 */
function extractReasoningFromMessages(
  messages: Array<{ role: string; content: string | Array<unknown> }>,
): void {
  if (!currentSession) return;

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    // Handle string content
    if (typeof msg.content === 'string') {
      const reasoning = extractReasoningFromText(msg.content);
      if (reasoning) {
        currentSession.reasoning.push(reasoning);
      }
      continue;
    }

    // Handle structured content (thinking blocks, etc.)
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        // Thinking block type (Anthropic, OpenAI, etc.)
        if (b.type === 'thinking' || b.type === 'thought' || b.type === 'reasoning') {
          const thinking = typeof b.thinking === 'string' ? b.thinking
            : typeof b.content === 'string' ? b.content
            : typeof b.text === 'string' ? b.text
            : JSON.stringify(b);
          if (thinking) {
            currentSession.reasoning.push(thinking.slice(0, 4000));
          }
        }
        // Text block that might contain <thinking> tags
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
  // Match XML-style thinking tags
  const thinkingMatch = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (thinkingMatch && thinkingMatch[1].trim()) {
    return thinkingMatch[1].trim().slice(0, 4000);
  }
  // Match [REASONING]...[/REASONING] tags
  const reasoningMatch = text.match(/\[REASONING\]([\s\S]*?)\[\/REASONING\]/i);
  if (reasoningMatch && reasoningMatch[1].trim()) {
    return reasoningMatch[1].trim().slice(0, 4000);
  }
  return null;
}

/**
 * Agent end hook - finalize and log intent
 */
export async function onAgentEnd(params: {
  messages: Array<{ role: string; content: string | Array<unknown> }>;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}): Promise<void> {
  if (!currentSession) return;

  // Phase 2: Extract reasoning from messages
  if (config.reasoningCapture) {
    extractReasoningFromMessages(params.messages);
  }

  // Try to bind the session to recent commit
  await tryBindCommit();

  // Generate task summary from messages
  const lastMessage = params.messages[params.messages.length - 1];
  const content = typeof lastMessage?.content === 'string'
    ? lastMessage.content
    : JSON.stringify(lastMessage?.content ?? '');
  const task = content.slice(0, 200) || 'Agent task completed';

  await logIntent(task, currentSession.model);
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
  // Detect agent source from environment or process.argv
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
  version: '1.0.0',
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
        return `Session: ${currentSession.sessionId}\nModel: ${currentSession.model}\nStarted: ${currentSession.startedAt}\nTool calls: ${currentSession.toolCalls.length}\nReasoning: ${currentSession.reasoning.length}`;
      },
    },
  ],
};

export default skill;
