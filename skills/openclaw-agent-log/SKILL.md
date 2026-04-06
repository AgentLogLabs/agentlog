---
name: openclaw-agent-log
description: |
  OpenClaw Agent 自动存证与 Trace 生命周期管理 Skill。
  
  提供给 OpenClaw Agent 使用，实现：
  1. 自动会话存证 - 通过 OpenClaw Hooks 自动记录 agent 活动
  2. Trace 生命周期 - 管理 trace 的创建、认领、完成流程
  
  When to activate:
  - 所有 OpenClaw Agent 的自动存证需求
  - Agent 间任务交接（handoff）场景
  
  Features:
  - Automatic session management (无需手动 session_id)
  - Reasoning 过程捕获 (DeepSeek-R1, Claude 等)
  - Tool call 记录
  - Response 捕获
  - Trace handoff (任务交接)
  - Git Commit binding

---

# OpenClaw Agent Log Skill

## Overview

本 Skill 是 `agentlog-auto` 和 `openclaw-agent` 的合并版本，为 OpenClaw Agent 提供统一的存证和 Trace 管理能力。

## Architecture

```
OpenClaw Agent
      ↓
┌─────────────────────────────────┐
│   openclaw-agent-log Skill      │
├─────────────────────────────────┤
│  ┌───────────────────────────┐  │
│  │   Auto-Logging Module    │  │ ← Hooks 自动记录
│  │  - session_start         │  │
│  │  - before_tool_call      │  │
│  │  - after_tool_call       │  │
│  │  - agent_end             │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │   Trace Handoff Module   │  │ ← 任务交接
│  │  - checkAndClaimTrace    │  │
│  │  - claimTrace            │  │
│  │  - completeTrace         │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
      ↓
AgentLog Backend (MCP Server)
      ↓
   SQLite DB
```

## Configuration

### Environment Variables

```bash
AGENTLOG_BACKEND_URL=http://localhost:7892  # Backend API URL
AGENTLOG_MCP_URL=http://localhost:7892      # MCP Server URL
AGENTLOG_AGENT_ID=<agent-name>             # Agent 标识（自动设置）
```

### Optional Configuration

```yaml
agentlog:
  mcpUrl: "http://localhost:7892"
  autoBindCommit: true      # 自动绑定 Git Commit
  reasoningCapture: true    # 捕获推理过程
  toolCallCapture: true     # 捕获工具调用
  sessionTimeout: 600       # Session 超时(秒)
```

## Hook Events (Auto-Logging)

| Hook | Purpose |
|------|---------|
| `session_start` | 创建新 session，生成 session_id |
| `before_tool_call` | 记录工具调用参数 |
| `after_tool_call` | 记录工具执行结果 |
| `agent_end` | 调用 log_intent 归档 |
| `session_end` | 清理状态 |

## Trace Handoff API

### checkAndClaimTrace

启动时检查并认领 pending traces。

```typescript
import { checkAndClaimTrace } from 'openclaw-agent-log';

const result = await checkAndClaimTrace('/path/to/workspace', 'architect');
// result: { success: true, traceId: '...', sessionId: '...' }
```

### claimTrace

手动认领指定 trace。

```typescript
import { claimTrace } from 'openclaw-agent-log';

const result = await claimTrace('TRACE_ID', 'architect', '/path/to/workspace');
```

### completeActiveSession

完成当前 session。

```typescript
import { completeActiveSession } from 'openclaw-agent-log';

await completeActiveSession('/path/to/workspace');
```

## Skill Functions

| Function | Description |
|----------|-------------|
| `checkAndClaimTrace` | 启动时检查并认领 pending traces |
| `extractTraceIdFromMessage` | 从消息中提取 Trace ID |
| `queryPendingTraces` | 查询 pending traces |
| `claimTrace` | 认领 trace |
| `getActiveSession` | 获取当前 active session |
| `completeActiveSession` | 完成当前 session |

## Data Flow

```
1. Agent 启动
   ↓
2. checkAndClaimTrace() → 查找匹配的 pending trace
   ↓
3. 认领后 → 设置 AGENTLOG_TRACE_ID 环境变量
   ↓
4. Hooks 开始自动记录：
   - session_start → 创建 session
   - before_tool_call → 记录参数
   - after_tool_call → 记录结果
   ↓
5. Agent 完成任务 → agent_end → log_intent()
   ↓
6. completeActiveSession() → 清理
```

## Requirements

- OpenClaw Gateway 运行中
- AgentLog Backend 运行中 (port 7892)
- Git 仓库（用于 commit binding）

## Deprecation

本 Skill 替代以下已废弃的 Skills：
- `agentlog-auto`（与 OpenCode 插件重名）
- `openclaw-agent`（功能已合并）

## Troubleshooting

**Backend not reachable:**
```bash
curl http://localhost:7892/health
```

**Session not binding to commits:**
- 确保 git 仓库存在
- 确保在 session 结束后 5 分钟内有 commit

**Trace not found:**
- 检查 `sessions.json` 是否存在
- 确认 trace 处于 pending 状态
