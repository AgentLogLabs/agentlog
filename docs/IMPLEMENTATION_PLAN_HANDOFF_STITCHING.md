# Stage 1 - 断点接管与人机混合接力赛 (Handoff & Stitching) 实现计划

## 概述

基于 `STAGE1_HANDOFF_STITCHING_DESIGN_V2.md` 设计文档，实现以下功能：
- sessions.json 文件管理
- Error Span 增强（包含 reasoningChain）
- Git Hook post-commit 集成
- OpenCode 启动时认领 pending traces
- AgentSwarm Agent Trace ID 接收（3 种方式）
- Trace 状态机（pending_handoff / in_progress）
- VS Code "Resume with..." 右键菜单
- Embedding 语义搜索

## 核心决策

| 决策项 | 选择 |
|--------|------|
| sessions.json 位置 | `.git/agentlog/sessions.json`（通过 `git rev-parse --git-common-dir` 定位） |
| Error Span 触发标准 | `tool_response` 包含 `error` 字段 |
| Trace ID 格式 | ULID（保持不变） |
| Embedding 模型 | all-MiniLM-L6-v2 |
| 向量存储 | 内存存储（未来升级 ChromaDB） |
| OpenClaw Agent 集成 | 独立 package + Skill |

---

## 状态机定义

```
                    Error 检测
                  ┌──────────────┐
                  │    running   │
                  └──────┬───────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
     用户主动暂停    pending_handoff    失败
          │              │              │
          ▼              ▼              ▼
       paused      in_progress        failed
          │              │              │
          │              ├──────────────┤
          │              │              │
          │         commit + 继续       │
          │              ▼              │
          │        (loop back)         │
          │              │              │
          └──────────────┴──────────────┘
                         │
                      completed
```

### 状态语义

| 状态 | 语义 | 触发场景 |
|------|------|----------|
| `running` | 进行中 | 正常任务执行 |
| `pending_handoff` | 等待交接 | Agent 报错卡死、需要人类接手 |
| `in_progress` | 进行中（交接后） | 人类/新 Agent 接手继续 |
| `paused` | 暂停 | 用户主动暂停（等待外部资源） |
| `failed` | 失败 | 任务执行失败 |
| `completed` | 已完成 | 任务正常结束 |

---

## 三种 Trace ID 获取流程

### Flow 1: Agent 读取 sessions.json（方式 A）

```
OpenClaw Agent 启动/轮询
    ↓
读取 .git/agentlog/sessions.json
    ↓
找到 targetAgent 匹配自己的 pending trace
    ↓
claim pending → active（更新 sessions.json）
    ↓
设置 AGENTLOG_TRACE_ID 环境变量
    ↓
继续工作
```

### Flow 2: 人类在飞书消息中提及 Trace ID（方式 B）

```
人类在飞书发送消息: "Trace: 01ARZ6N... 请继续处理"
    ↓
OpenClaw Agent 通过 WebSocket 接收消息
    ↓
正则匹配提取 Trace ID
    ↓
Agent 继续工作
```

### Flow 3: Agent 查询 API（方式 D）

```
OpenClaw Agent 调用 GET /api/traces/pending?agentType=openclaw
    ↓
返回 pending traces 列表
    ↓
人类/Agent 选择要恢复的 trace
    ↓
Agent 调用 POST /api/traces/:id/resume 认领
    ↓
继续工作
```

---

## API 端点清单

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/traces/pending` | 查询 pending traces（支持 agentType 过滤） |
| GET | `/api/traces/pending/search` | 语义搜索 pending traces |
| POST | `/api/traces/:id/handoff` | 创建 pending_handoff trace |
| POST | `/api/traces/:id/resume` | Agent 认领 trace |
| POST | `/api/traces/:id/pause` | 暂停 trace（paused） |
| POST | `/api/traces/:id/resume-from-pause` | 从 paused 恢复 |
| POST | `/api/traces/:id/complete` | 标记完成 |
| GET | `/api/sessions/active` | 获取当前 active session |

---

## 实现阶段

### Phase 1: 类型定义（1-2h）

**文件：** `packages/shared/src/types.ts`

```typescript
// Trace 状态机扩展（支持 handoff 场景）
export type TraceHandoffStatus = 'running' | 'pending_handoff' | 'in_progress' | 'completed' | 'failed' | 'paused';

// pending trace 条目
export interface PendingTraceEntry {
  createdAt: string;
  targetAgent: 'opencode' | 'cursor' | 'claude-code' | string;
  taskGoal?: string;
}

// active session 条目
export interface ActiveSessionEntry {
  sessionId: string;
  traceId: string;
  agentType: string;
  status: 'active';
  startedAt: string;
  worktree?: string;
}

// sessions.json 完整结构
export interface SessionsJson {
  pending: Record<string, PendingTraceEntry>;
  active: Record<string, ActiveSessionEntry>;
}

// Error Span payload (增强的错误信息)
export interface ErrorSpanPayload {
  errorType: string;
  stackTrace?: string;
  memorySnapshot?: {
    workspacePath: string;
    currentFiles: string[];
    gitStatus: 'clean' | 'modified' | 'staged' | 'untracked';
  };
  diff?: {
    changedFiles: string[];
    additions: number;
    deletions: number;
  };
  reasoningChain?: ReasoningChainStep[];
}

export interface ReasoningChainStep {
  step: number;
  thought: string;
  action: string;
}
```

**文件：** `packages/backend/src/db/database.ts`
- Schema 版本：9 → 10（无重大变更，仅记录迁移）

---

### Phase 2: sessions.json 服务（2-3h）

**新建：** `packages/backend/src/services/sessionsJsonService.ts`

| 函数 | 说明 |
|------|------|
| `getSessionsJsonPath(workspacePath)` | 通过 git-common-dir 获取 sessions.json 路径 |
| `readSessionsJson(workspacePath)` | 读取 sessions.json，不存在返回空结构 |
| `writeSessionsJson(workspacePath, data)` | 原子写入 sessions.json |
| `createPendingTrace(workspacePath, traceId, targetAgent, taskGoal?)` | 创建待认领 entry |
| `claimPendingTrace(workspacePath, traceId, agentType)` | Agent 认领 trace |
| `completeActiveSession(workspacePath, sessionId)` | 完成 session |
| `getPendingTraces(workspacePath, agentType?)` | 获取待认领列表 |
| `getActiveSession(workspacePath)` | 获取当前活跃 session |

**sessions.json 结构：**
```json
{
  "pending": {
    "01ARZ6NDEKTSV4RRFFQ69G5FAV": {
      "createdAt": "2026-04-05T09:50:00Z",
      "targetAgent": "opencode",
      "taskGoal": "重构支付网关"
    }
  },
  "active": {
    "session-uuid-1": {
      "sessionId": "session-uuid-1",
      "traceId": "01ARZ6NDEKTSV4RRFFQ69G5FAV",
      "agentType": "opencode",
      "status": "active",
      "startedAt": "2026-04-05T10:00:00Z"
    }
  }
}
```

---

### Phase 3: Trace 服务增强（3-4h）

**文件：** `packages/backend/src/services/traceService.ts`

- 扩展 `TraceStatus` 类型
- 新增函数：
  - `createErrorSpan(traceId, errorInfo)` - 创建 error span
  - `transitionToHandoff(traceId, targetAgent, workspacePath)` - pending_handoff
  - `transitionToInProgress(traceId)` - in_progress

**Error Span Payload：**
```json
{
  "errorType": "DeadlockError",
  "stackTrace": "at StripeClient.connect (...)",
  "memorySnapshot": {
    "workspacePath": "/path/to/project",
    "currentFiles": ["src/stripe.ts", "src/payment.ts"],
    "gitStatus": "modified"
  },
  "diff": {
    "changedFiles": ["src/stripe.ts", "src/payment.ts"],
    "additions": 150,
    "deletions": 30
  },
  "reasoningChain": [
    {"step": 1, "thought": "分析Stripe API...", "action": "修改stripe.ts"},
    {"step": 2, "thought": "检测到死锁...", "action": "尝试修复#1"}
  ]
}
```

---

### Phase 4: Git Hook 增强（1-2h）

**文件：** `packages/backend/src/services/gitHookService.ts`

更新 `POST_COMMIT_HOOK_TEMPLATE`：
```bash
# 1. 优先读取 sessions.json 中的 active session
SESSIONS_FILE="$(git rev-parse --git-common-dir)/agentlog/sessions.json"
if [ -f "$SESSIONS_FILE" ]; then
  ACTIVE=$(jq -r ".active[] | select(.status==\"active\")" "$SESSIONS_FILE" 2>/dev/null)
  if [ -n "$ACTIVE" ]; then
    SESSION_ID=$(echo "$ACTIVE" | jq -r '.sessionId')
    TRACE_ID=$(echo "$ACTIVE" | jq -r '.traceId')
    jq "del(.active[\"$SESSION_ID\"])" "$SESSIONS_FILE" > "$SESSIONS_FILE.tmp"
    mv "$SESSIONS_FILE.tmp" "$SESSIONS_FILE"
  fi
fi

# 2. 如果没有 active session，读取 git config
if [ -z "$TRACE_ID" ]; then
  TRACE_ID=$(git config agentlog.traceId)
fi
```

---

### Phase 5: 后端 API（2-3h）

**新建：** `packages/backend/src/routes/handoff.ts`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/traces/pending` | 列表（支持 agentType 过滤） |
| GET | `/api/traces/pending/search` | 语义搜索 |
| POST | `/api/traces/:id/handoff` | 创建 pending_handoff |
| POST | `/api/traces/:id/resume` | 认领 |
| POST | `/api/traces/:id/pause` | 暂停 |
| POST | `/api/traces/:id/resume-from-pause` | 恢复 |
| POST | `/api/traces/:id/complete` | 完成 |

**修改：** `packages/backend/src/routes/traces.ts`
- `status` 查询参数支持 `pending_handoff` 和 `in_progress`

---

### Phase 6: VS Code 扩展（3-4h）

**文件：** `packages/vscode-extension/src/providers/traceTreeProvider.ts`

新增右键菜单：
```
Trace → Resume with...
├── 🤖 OpenCode
├── 🎯 Cursor
├── 🧠 Claude Code
└── 📋 Other Agent...

Trace → ⏸ Pause
Trace → ▶️ Resume (from paused)
Trace → ✅ Complete
```

**文件：** `packages/vscode-extension/src/extension.ts`
- 注册新命令

**文件：** `packages/vscode-extension/src/client/backendClient.ts`
- 新增 API 方法

---

### Phase 7: MCP Error 检测（2-3h）

**文件：** `packages/backend/src/mcp.ts`

在 `log_turn` 处理中添加：
```typescript
// 检测 tool_response 中的 error 字段
const toolResponse = args.tool_response;
if (toolResponse && typeof toolResponse === 'object' && 'error' in toolResponse) {
  await createErrorSpan(currentTraceId, {
    errorType: String(toolResponse.error),
    stackTrace: toolResponse.stackTrace as string | undefined,
    reasoningChain: buildReasoningChain(traceId),
  });
  await transitionToHandoff(currentTraceId, 'human', workspacePath);
}
```

---

### Phase 8: Embedding 语义搜索（4-6h）

**新建：** `packages/backend/src/services/embeddingService.ts`

| 函数 | 说明 |
|------|------|
| `encodeText(text: string)` | 使用 all-MiniLM-L6-v2 编码 |
| `searchPendingTraces(query: string, workspacePath, limit?)` | 语义搜索 pending traces |

**向量存储：** 内存存储（`Map<traceId, embedding>`）

---

### Phase 9: OpenClaw Agent Package（3-4h）

**新建：** `packages/openclaw-agent/`

**功能：**
- `checkAndClaimTrace()` - 启动时读取 sessions.json 认领
- `extractTraceIdFromMessage(message)` - 正则匹配 Trace ID
- `queryPendingTraces(agentType)` - HTTP API 调用
- `claimTrace(traceId)` - HTTP API 调用

**Skill：** 封装为 `agentlog-handoff` skill，供 Agent 调用

---

## 文件变更清单

| Phase | 操作 | 文件路径 |
|-------|------|----------|
| 1 | 修改 | `packages/shared/src/types.ts` |
| 1 | 修改 | `packages/backend/src/db/database.ts` |
| 2 | 新建 | `packages/backend/src/services/sessionsJsonService.ts` |
| 3 | 修改 | `packages/backend/src/services/traceService.ts` |
| 4 | 修改 | `packages/backend/src/services/gitHookService.ts` |
| 5 | 新建 | `packages/backend/src/routes/handoff.ts` |
| 5 | 修改 | `packages/backend/src/routes/traces.ts` |
| 6 | 修改 | `packages/vscode-extension/src/providers/traceTreeProvider.ts` |
| 6 | 修改 | `packages/vscode-extension/src/extension.ts` |
| 6 | 修改 | `packages/vscode-extension/src/client/backendClient.ts` |
| 7 | 修改 | `packages/backend/src/mcp.ts` |
| 8 | 新建 | `packages/backend/src/services/embeddingService.ts` |
| 9 | 新建 | `packages/openclaw-agent/` |

---

## 工作量估算

| Phase | 内容 | 预估工时 |
|-------|------|----------|
| 1 | 类型定义 | 1-2h |
| 2 | sessions.json 服务 | 2-3h |
| 3 | Trace 服务 + Error Span | 3-4h |
| 4 | Git Hook 增强 | 1-2h |
| 5 | 后端 API | 2-3h |
| 6 | VS Code 扩展 | 3-4h |
| 7 | MCP Error 检测 | 2-3h |
| 8 | Embedding 语义搜索 | 4-6h |
| 9 | OpenClaw Agent Package | 3-4h |
| **总计** | | **21-31h** |

---

## 实现优先级

| 优先级 | 阶段 | 工作项 | 价值 |
|--------|------|--------|------|
| P0 | Phase 2, 3, 5 | sessions.json + 状态机核心 | 实现 handoff 闭环 |
| P1 | Phase 1 | 类型定义 | 支撑核心功能 |
| P2 | Phase 4 | Git Hook 增强 | 支持跨 Agent commit 绑定 |
| P2 | Phase 8 | Embedding 语义搜索 | 智能匹配 pending traces |
| P3 | Phase 6 | VS Code 扩展 | 提供 UI 操作入口 |
| P4 | Phase 7 | MCP Error Span | 自动化 error 捕获 |
| P4 | Phase 9 | OpenClaw Agent | Agent 集成 |
