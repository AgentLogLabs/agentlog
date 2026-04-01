---
name: agentlog-auto
description: |
  AgentLog Auto Logging Skill for OpenClaw agents. Automatically captures agent reasoning, tool calls, and responses, then logs them to the AgentLog MCP server for compliance and audit purposes.
  
  When to activate:
  - Any OpenClaw agent session that needs automatic compliance logging
  - When CEO or Architect requires agent activity tracking
  - For the AgentLog Swarm agent system to maintain audit trail
  
  Features:
  - Automatic session management (no manual session_id required)
  - Reasoning process capture (DeepSeek-R1, Claude, etc.)
  - Tool call logging
  - Response capture
  - Automatic Git Commit binding when sessions end
---

# AgentLog Auto Logging Skill

## Overview

This skill automatically logs all agent activities to the AgentLog MCP server for compliance auditing and code source tracing.

## Configuration

### Required Environment Variables

```bash
AGENTLOG_MCP_URL=http://localhost:7892  # MCP Server URL
AGENTLOG_DB_PATH=~/.agentlog/agentlog.db  # Local SQLite for fallback
```

### Optional Configuration

```yaml
agentlog:
  mcpUrl: "http://localhost:7892"
  autoBindCommit: true  # Automatically bind sessions to Git commits
  reasoningCapture: true  # Capture reasoning process
  toolCallCapture: true  # Capture tool calls
  sessionTimeout: 600  # Session timeout in seconds
```

## Hook Events

The skill subscribes to the following OpenClaw lifecycle hooks:

| Hook | Purpose |
|------|----------|
| `session_start` | Create new session with auto-generated session_id |
| `before_prompt_build` | Capture reasoning if thinking is enabled |
| `before_tool_call` | Log tool call parameters |
| `after_tool_call` | Log tool call results |
| `agent_end` | Finalize session and call log_intent |
| `session_end` | Cleanup and final audit record |

## Usage

### Enable for an Agent

Add to the agent's workspace config:

```yaml
skills:
  - agentlog-auto
```

Or via OpenClaw CLI:

```bash
openclaw agents config set <agent-name> skills+="agentlog-auto"
```

### Manual Commands

The skill also provides manual commands:

- `/agentlog status` - Check MCP server connection status
- `/agentlog session` - Show current session info
- `/agentlog flush` - Force flush pending logs

## Data Flow

```
Agent Activity → Hook Triggered → MCP Client → AgentLog MCP Server → SQLite DB
                                      ↓
                              session_id managed
                              automatically
```

## Requirements

- OpenClaw Gateway running
- AgentLog MCP Server running on configured port
- Network access to MCP server (localhost by default)

## Troubleshooting

**MCP Server not reachable:**
- Check if `agentlog-mcp` is running: `curl http://localhost:7892/health`
- Verify AGENTLOG_MCP_URL is correct

**Session not binding to commits:**
- Ensure git repo exists in workspace
- Check git commit was made within 5 minutes of session end
