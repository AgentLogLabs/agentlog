---
name: agentlog-telemetry
description: "Capture OpenClaw agent lifecycle events and report to AgentLog gateway for traceability"
homepage: https://github.com/AgentLogLabs/AgentLog
metadata:
  {
    "openclaw":
      {
        "emoji": "🔍",
        "events": ["agent", "session"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with AgentLog" }],
      },
  }
---

# AgentLog Telemetry Hook

Captures OpenClaw agent lifecycle events and reports them to the AgentLog gateway for comprehensive traceability.

## What It Does

1. **Agent Bootstrap** - Captures when agents start up
2. **Session Lifecycle** - Tracks session start and end events
3. **Async Reporting** - Non-blocking telemetry that doesn't impact agent performance

## Events Captured

| Event | Description |
|-------|-------------|
| `agent:bootstrap` | Agent startup with workspace context |
| `session:start` | New agent session begins |
| `session:end` | Agent session completes |

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTLOG_GATEWAY_URL` | `http://localhost:7892` | AgentLog gateway URL |
| `AGENTLOG_AGENT_ID` | `openclaw` | Agent identifier |
| `AGENTLOG_PROBE_BUFFER_SIZE` | `100` | Telemetry buffer threshold |
| `AGENTLOG_PROBE_FLUSH_MS` | `5000` | Flush interval (ms) |

## Architecture

```
OpenClaw Hook System
    │
    ├── agent:bootstrap → TelemetryProbe
    │                           │
    ├── session:start → (buffered) ──→ POST /api/spans
    │                           │
    └── session:end → (flush) ──→ AgentLog Gateway
```

## Requirements

- AgentLog backend running and accessible
- Network connectivity to gateway URL
