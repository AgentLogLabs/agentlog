# Stage 1 - 断点接管与人机混合接力赛 (Handoff & Stitching)

## 场景目标

解决痛点：AI Agent 报错卡死，人类接手时"一脸懵逼"，只能去翻长达几千行的聊天记录，且修复后 Git Commit 割裂。

场景标签：单物理节点、人机混合协作、上下文缝合

---

## 场景过程

场景一：断点接管与人机混合接力赛 (Handoff & Stitching)
解决痛点：AI Agent 报错卡死，人类接手时“一脸懵逼”，只能去翻长达几千行的聊天记录，且修复后 Git Commit 割裂。
场景标签：单物理节点、人机混合协作、上下文缝合
🎬 场景还原：
自动驾驶碰壁：周五下午，开发者启动了 OpenClaw 的 Builder Agent 负责重构支付网关。Agent 跑了 20 分钟，改了 15 个文件，但在对接第三方 Stripe 接口时遇到死锁报错，尝试 3 次修复失败后，主动抛出异常（Panic）。
生成 Trace Ticket：此时，AgentLog 自动介入。它没有机械地记录错误，而是生成了一个包含了当前内存快照、变更 Diff、连续推理过程的 Ticket (Span ID: 101)，归属在这个重构任务的 Trace ID: A-999 下。
人类携重武器入场：开发者收到通知，打开 VS Code/Cursor（外部工具）。通过 AgentLog 插件，一键点击 "Resume Ticket #101"。AgentLog 瞬间将之前 Builder Agent 的核心决策逻辑和死锁原因，作为 Context 注入到 Cursor 的对话框中。
修复与无缝缝合：开发者在 Cursor 中与 AI 协同，花了 5 分钟手动修复了死锁问题，并执行 git commit -m "fix: resolve stripe deadlock"。
黑匣子归档：AgentLog 的 Git Hook 触发。系统自动将 Span ID 101 (Agent的努力与失败) + Span ID 102 (人类与Cursor的修复过程) + 最终的 Git Commit Hash 完美缝合在 Trace ID A-999 的时间线上。
💡 产品价值：实现了真正的“上下文不掉线”。代码有出处，接盘无痛苦。

---

## 核心流程概览

完整链路涉及三个角色：
1. AgentSwarm Agent（OpenClaw Builder）
2. 人类（通过VS Code/OpenCode/Cursor等工具）
3. AgentSwarm Agent（继续完成工作）

**注解：这里说的AgentSwarm 当前的实现是Openclaw下部署的多个Agent组成测系统**

---

## sessions.json 完整格式

文件位置：`.git/agentlog/sessions.json`

### 完整JSON内容

```json
{
  "pending": {
    "A-999": {
      "createdAt": "2026-04-05T09:50:00Z",
      "targetAgent": "opencode"
    },
    "B-888": {
      "createdAt": "2026-04-05T10:00:00Z",
      "targetAgent": "cursor"
    }
  },
  "active": {
    "session-uuid-1": {
      "traceId": "A-999",
      "agentType": "opencode",
      "status": "active",
      "startedAt": "2026-04-05T10:00:00Z",
      "worktree": "/path/to/main"
    }
  }
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `pending` | 待认领的Trace，key为TraceId |
| `pending[].targetAgent` | 目标Agent类型(opencode/cursor/claude-code等) |
| `pending[].createdAt` | 创建时间 |
| `active` | 当前活跃的Session，key为SessionUuid |
| `active[].traceId` | 该Session正在处理的Trace |
| `active[].agentType` | Agent类型 |
| `active[].status` | 状态(always active) |
| `active[].worktree` | Git worktree路径 |

---

## VS Code UI 设计

### 右键菜单设计

```
右键 Trace A-999 → Resume with...
├── 🤖 OpenCode
├── 🎯 Cursor
├── 🧠 Claude Code
└── 📋 Other Agent...
```

### 选择后写入的 sessions.json

```json
{
  "pending": {
    "A-999": {
      "targetAgent": "opencode",
      "createdAt": "2026-04-05T10:00:00Z"
    }
  }
}
```

### 各 Agent 的行为

| Agent类型 | 启动时检查 | 认领条件 |
|-----------|-----------|----------|
| OpenCode | 读取 `pending[].targetAgent` | === opencode |
| Cursor | 读取 `pending[].targetAgent` | === cursor |
| Claude Code | 读取 `pending[].targetAgent` | === claude-code |

**设计原则**：每种 Agent 只关心自己类型的 pending 项，互不干扰，具备良好扩展性。

---

## Error Span 完整格式

当Agent遇到错误时，生成的Error Span包含以下payload：

```json
{
  "id": "span-101",
  "traceId": "A-999",
  "parentSpanId": null,
  "actorType": "error",
  "actorName": "Builder-Agent",
  "payload": {
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
      {"step": 2, "thought": "检测到死锁...", "action": "尝试修复#1"},
      {"step": 3, "thought": "修复失败...", "action": "尝试修复#2"},
      {"step": 4, "thought": "再次失败...", "action": "尝试修复#3"},
      {"step": 5, "thought": "三次失败...", "action": "抛出Panic"}
    ]
  },
  "createdAt": "2026-04-05T10:30:00Z"
}
```

### Error Span 字段说明

| 字段 | 说明 |
|------|------|
| `actorType: "error"` | 标识这是一个错误Span |
| `payload.errorType` | 错误类型（如DeadlockError） |
| `payload.stackTrace` | 堆栈信息 |
| `payload.memorySnapshot` | 内存快照（workspacePath、当前文件） |
| `payload.diff` | 变更文件列表及统计 |
| `payload.reasoningChain` | 连续推理过程 |

---

## Git Hook post-commit 脚本

```bash
#!/bin/bash
# .git/hooks/post-commit
# AgentLog 自动绑定脚本

AGENTLOG_DIR=".git/agentlog"
SESSIONS_FILE="$AGENTLOG_DIR/sessions.json"
TRACE_ID=""
SESSION_ID=""

# 1. 优先读取 sessions.json 中的 active session
if [ -f "$SESSIONS_FILE" ]; then
  ACTIVE=$(jq -r ".active[] | select(.status==\"active\")" "$SESSIONS_FILE" 2>/dev/null)
  if [ -n "$ACTIVE" ]; then
    SESSION_ID=$(echo "$ACTIVE" | jq -r '.sessionId')
    TRACE_ID=$(echo "$ACTIVE" | jq -r '.traceId')
    # 清理 sessions.json
    jq "del(.active[\"$SESSION_ID\"])" "$SESSIONS_FILE" > "$SESSIONS_FILE.tmp"
    mv "$SESSIONS_FILE.tmp" "$SESSIONS_FILE"
  fi
fi

# 2. 如果没有active session，读取 git config
if [ -z "$TRACE_ID" ]; then
  TRACE_ID=$(git config agentlog.traceId)
fi

# 3. 如果还是没有，创建 human-direct Trace
if [ -z "$TRACE_ID" ]; then
  TRACE_ID="human-direct-$(date +%s)"
fi

# 4. 调用 API 绑定 commit
curl -s -X POST "$AGENTLOG_GATEWAY/api/commit-bind" \
  -d "{\"traceId\": \"$TRACE_ID\", \"commitHash\": \"$GIT_COMMIT_HASH\"}" > /dev/null
```

---

## OpenCode 启动时读取 sessions.json

```typescript
// MCP Client 初始化时检查并认领 Trace
async function checkAndClaimTrace() {
  const sessionsFile = path.join(process.cwd(), '.git/agentlog/sessions.json');
  if (!fs.existsSync(sessionsFile)) return;

  const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
  const agentType = detectAgentType(); // opencode / cursor / claude-code

  for (const [traceId, pending] of Object.entries(sessions.pending)) {
    if (pending.targetAgent === agentType) {
      // 认领该 Trace
      delete sessions.pending[traceId];
      sessions.active[generateSessionId()] = {
        traceId,
        agentType,
        status: 'active',
        startedAt: new Date().toISOString()
      };
      fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2));
      process.env.AGENTLOG_TRACE_ID = traceId;
      break;
    }
  }
}
```

---

## AgentSwarm Agent 接收 Trace ID

```typescript
// 消息处理函数
async function handleMessage(message: string) {
  let traceId: string | null = null;

  // 方式1: 直接提取 Trace ID
  const match = message.match(/Trace[:\s]+([A-Z0-9]+)/i);
  if (match) {
    traceId = match[1];
  } else {
    // 方式2: 语义搜索
    const results = await query_historical_interaction({
      keyword: message,
      status: 'in_progress',
      page_size: 5
    });
    if (results.data.length > 0) {
      traceId = results.data[0].trace.id;
    }
  }

  if (traceId) {
    execSync(`git config agentlog.traceId "\${traceId}"`);
    process.env.AGENTLOG_TRACE_ID = traceId;
  }
}
```

---

## Trace 状态机

```
┌──────────────┐
│   running    │
└──────┬───────┘
       │
           Error / 认领 ↓
       │
┌──────▼───────┐
│pending_handoff│
└──────┬───────┘
       │
       │ commit + 选择"完成" → completed
       │ commit + 选择"继续修改" → in_progress
       ↓
┌──────────────┐
│ in_progress  │
└──────┬───────┘
       │
       commit ↓
       ↓
┌──────────────┐
│  completed   │
└──────────────┘
```

### 状态说明

| 状态 | 说明 |
|------|------|
| `running` | 进行中 |
| `pending_handoff` | 等待交接(Agent出错或等待认领) |
| `in_progress` | 进行中(人类选择继续修改) |
| `completed` | 已完成 |

---



## 设计决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| Trace 管理 | `.git/agentlog/sessions.json` | 利用Git工作树特性，支持多worktree |
| Session 模式 | 单一Trace | 简化实现 |
| 多Agent支持 | targetAgent字段 | 良好扩展性 |
| 纯人类commit | 记录（human-direct） | 审计功能需要 |
| 任务完成判断 | 人类决定 | commit后由人类选择 |
| Agent获取Trace | 直接ID + 语义查询 | 灵活适应不同场景 |

---

*文档创建时间：2026-04-05*
*目标：让 AgentLog 成为 Agent 编程时代的基础工具*
