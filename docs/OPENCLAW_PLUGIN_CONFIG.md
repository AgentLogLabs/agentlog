# openclaw-agentlog 插件配置与追踪原理

本文档说明如何在 OpenClaw 上安装和配置 `openclaw-agentlog` 插件，以及用户通过飞书与 bot 交互时，trace 和 span 是如何被记录和跟踪的。

---

## 目录

1. [插件安装](#插件安装)
2. [openclaw.json 配置](#openclawjson-配置)
3. [飞书群组命令权限配置](#飞书群组命令权限配置)
4. [Trace / Span 追踪原理](#trace--span-追踪原理)
5. [飞书消息与 Trace ID](#飞书消息与-trace-id)
6. [Hook 行为说明](#hook-行为说明)
7. [故障排查](#故障排查)

---

## 插件安装

将插件目录复制到 OpenClaw 的 extensions 目录，并在 `openclaw.json` 中注册：

```bash
# 复制插件到 extensions 目录
cp -r skills/openclaw-agentlog ~/.openclaw/extensions/openclaw-agentlog

# 安装依赖
cd ~/.openclaw/extensions/openclaw-agentlog && npm install
```

---

## openclaw.json 配置

配置文件位于 `~/.openclaw/openclaw.json`。

### 1. 注册插件

在 `plugins.entries` 中启用插件：

```json
{
  "plugins": {
    "entries": {
      "openclaw-agentlog": {
        "enabled": true
      }
    },
    "installs": {
      "openclaw-agentlog": {
        "source": "path",
        "sourcePath": "/home/hobo/.openclaw/extensions/openclaw-agentlog",
        "installPath": "/home/hobo/.openclaw/extensions/openclaw-agentlog",
        "version": "1.0.0",
        "installedAt": "2026-04-06T06:00:00.000Z"
      }
    }
  }
}
```

### 2. 启用内部 Hook 系统

`session_start` / `session_end` 等 hook 依赖内部 hook 系统开启：

```json
{
  "hooks": {
    "internal": {
      "enabled": true
    }
  }
}
```

### 3. 环境变量（可选）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENTLOG_BACKEND_URL` | `http://localhost:7892` | AgentLog 后端地址 |
| `AGENTLOG_MCP_URL` | `http://localhost:7892` | MCP 服务地址（当前与后端共用） |
| `AGENTLOG_AGENT_ID` | 从 workspace 路径自动推断 | Agent 名称，用于 source 字段 |
| `AGENTLOG_TRACE_ID` | 由插件运行时写入 | 当前活跃 trace 的 ID，供 OpenClaw dist 消息模板读取 |

---

## 飞书群组命令权限配置

### 背景

OpenClaw 的飞书 channel 默认启用 `commands.useAccessGroups: true`。在此模式下：

- 若群组未配置 `allowFrom`，则**所有用户的命令（`/new`、`/reset` 等）均被拒绝**
- 被拒绝的命令会被静默丢弃（`replies=0`），不会产生任何回复或错误提示
- 普通消息（非命令）不受此限制影响

这会导致 `session_start` hook **永远不触发**，因为 `/new` 命令在到达 session 处理逻辑之前就被权限检查过滤掉了。

### 配置 allowFrom

在 `channels.feishu.groups` 下为每个群组配置允许发送命令的用户 ID：

```json
{
  "channels": {
    "feishu": {
      "groups": {
        "<群组 ID>": {
          "allowFrom": ["<Feishu User ID>", "<另一个 User ID>"]
        }
      }
    }
  }
}
```

**示例：**

```json
{
  "channels": {
    "feishu": {
      "groups": {
        "oc_ba17b4591be3cfa0837065e8cf63368d": {
          "allowFrom": ["ou_9259f92212b33c6b606454e516a7a090"]
        }
      }
    }
  }
}
```

### 如何获取 Feishu User ID 和群组 ID

从 OpenClaw 日志中查找：

```bash
grep 'received message from' /tmp/openclaw/openclaw-2026-04-07.log | head -5
# 输出示例：
# feishu[architect]: received message from ou_9259f92212b33c6b606454e516a7a090
#                    in oc_ba17b4591be3cfa0837065e8cf63368d (group)
#                    ↑ 用户 ID (ou_xxx)       ↑ 群组 ID (oc_xxx)
```

### 通配符（允许群组内所有人发命令）

仅建议在受信任的私有群组使用：

```json
{
  "channels": {
    "feishu": {
      "groups": {
        "oc_ba17b4591be3cfa0837065e8cf63368d": {
          "allowFrom": ["*"]
        }
      }
    }
  }
}
```

### 全局关闭 Access Groups（不推荐）

```json
{
  "commands": {
    "useAccessGroups": false
  }
}
```

> ⚠️ 此选项对所有 channel 和群组生效，任何人均可发送命令，仅限内部测试环境。

### 配置生效

修改 `openclaw.json` 后重启 gateway：

```bash
pkill -f openclaw-gateway
nohup openclaw-gateway > /tmp/openclaw-restart.log 2>&1 &
```

---

## Trace / Span 追踪原理

### 整体流程概览

用户通过飞书向 bot 发送一条消息，到 AgentLog 完成记录，完整流程如下：

```
用户飞书消息
    │
    ▼
飞书 Webhook → OpenClaw Gateway (feishu channel plugin)
    │
    ▼  [检查 @mention、群组 allowFrom 等]
    │
    ▼
initSessionState()
    │
    ├─ 若 isNewSession=true（/new 或首次 session）：
    │    └─ session_start hook（fire-and-forget）
    │         ├─ [同步] 生成 pre-flight trace ID → process.env.AGENTLOG_TRACE_ID
    │         └─ [异步] POST /api/traces，拿到真实 ULID 后更新 env
    │
    ▼
get-reply-run.ts
    │
    ├─ 若 resetTriggered：sendResetSessionNotice()
    │    └─ 读取 process.env.AGENTLOG_TRACE_ID → 发送至飞书
    │         "✅ New trace started · model: xxx · trace: agentlog-m7k3p9"
    │
    ▼
pi-embedded-runner/run.ts
    │
    ├─ before_agent_start hook ──────────────────────────► [1] 创建 Trace
    │                                                       POST /api/traces
    │                                                       更新 AGENTLOG_TRACE_ID = 真实 ULID
    │
    ├─ LLM 推理循环
    │    │
    │    ├─ before_tool_call hook ──────────────────────► [2] 记录工具调用开始时间
    │    │
    │    ├─ [工具实际执行]
    │    │
    │    └─ after_tool_call hook ───────────────────────► [3] 写入 Span
    │                                                       POST /api/spans
    │
    └─ agent_end hook ──────────────────────────────────► [4] 归档 Trace
                                                           PATCH /api/traces/:id
                                                           status → "completed"
```

---

### [1] Trace 创建：`before_agent_start`

**触发时机**：每次 agent 开始处理消息之前（每条用户消息触发一次）。

**插件行为**（`src/index.ts: onBeforeAgentStart`）：

```
before_agent_start 触发
    │
    ├─ 检查 currentSession 是否已存在
    │    └─ 存在 → 跳过（同一 session 内重入保护）
    │
    └─ 不存在 → startSession()
         │
         ├─ 生成 sessionId: sess_{timestamp}_{uuid}
         │
         ├─ POST /api/traces
         │    body: { taskGoal: "Agent session from openclaw:{agentId}",
         │            workspacePath: process.cwd() }
         │
         ├─ 更新 process.env.AGENTLOG_TRACE_ID = 真实 ULID
         │
         ├─ 初始化 currentSession 状态:
         │    { traceId, sessionId, startedAt, reasoning: [],
         │      toolCalls: [], responses: [], model, agentSource,
         │      workspacePath, taskGoal }
         │
         └─ sessionByTraceId.set(traceId, currentSession)
```

**`agentId` 推断逻辑**：

优先从 workspace 路径解析：
```
/home/hobo/.openclaw/agents/architect/workspace
                              ↑
                         agentId = "architect"
                         source  = "openclaw:architect"
```

**AgentLog 后端写入**：

```
traces 表:
  id          = "01KNXXX..."  (ULID)
  task_goal   = "Agent session from openclaw:architect"
  status      = "running"
  workspace_path = "/home/hobo/.openclaw/agents/architect/workspace"
  created_at  = "2026-04-07T..."
```

---

### [2] 工具调用开始：`before_tool_call`

**触发时机**：agent 每次调用工具（bash、read、write 等）之前。

**插件行为**：

```
before_tool_call 触发
    │
    ├─ 若 config.toolCallCapture = false → 跳过
    │
    ├─ 生成计时 key: "{toolName}:{timestamp}"
    ├─ toolCallTimings.set(key, Date.now())   ← 记录开始时间
    └─ 将 key 挂载到 event 对象供 after_tool_call 读取:
         event._agentlog_key = key
```

此时不写入 AgentLog，仅在内存中记录计时。

---

### [3] 工具调用结束：`after_tool_call`

**触发时机**：工具执行完成后（无论成功还是失败）。

**插件行为**：

```
after_tool_call 触发
    │
    ├─ 从 toolCallTimings 取出开始时间，计算 durationMs
    ├─ 清理计时 Map（防内存泄漏）
    │
    ├─ 查找 session：currentSession → ctx.traceId → sessionByTraceId
    │    └─ 找不到 → 跳过（无 session 时不记录）
    │
    ├─ 将 ToolCall 记录追加到 session.toolCalls[]
    │    { name, input, output, durationMs, timestamp }
    │
    └─ POST /api/spans
         body: {
           traceId,
           actorType: "agent",
           actorName: toolName,
           payload: {
             event: "tool",
             content: JSON.stringify({ tool, input, output }),
             toolName,
             durationMs,
             timestamp
           }
         }
```

**AgentLog 后端写入**：

```
spans 表:
  trace_id   = "01KNXXX..."
  actor_type = "agent"
  actor_name = "bash"         ← 工具名
  payload    = {
    event: "tool",
    content: '{"tool":"bash","input":{...},"output":"..."}',
    durationMs: 1234
  }
```

---

### [4] Agent 运行结束：`agent_end`

**触发时机**：agent 完成本轮所有 LLM 推理和工具调用，返回最终回复后。

**插件行为**：

```
agent_end 触发
    │
    ├─ 查找 session（同 after_tool_call 的逻辑）
    │
    ├─ 若 config.reasoningCapture = true：
    │    extractReasoningFromMessages(event.messages)
    │    ├─ 提取 <thinking>...</thinking> 标签内容
    │    ├─ 提取 [REASONING]...[/REASONING] 标签内容
    │    └─ 提取 role=assistant 消息中 type=thinking 的 content block
    │
    ├─ tryBindCommit()
    │    └─ git rev-parse HEAD → 记录当前 commit hash（日志级别，暂未写入 trace）
    │
    ├─ PATCH /api/traces/:traceId
    │    body: {
    │      status: "completed",
    │      taskGoal: session.taskGoal,
    │      affectedFiles: [...],        ← 从 toolCalls 中提取文件路径
    │      reasoningSummary: reasoning.join("\n\n")
    │    }
    │
    └─ 清理内存状态:
         sessionByTraceId.delete(traceId)
         currentSession = null           ← 为下一轮 before_agent_start 做准备
```

**AgentLog 后端写入**：

```
traces 表（更新）:
  status            = "completed"
  task_goal         = "Agent session from openclaw:architect"
  affected_files    = ["src/foo.ts", ...]
  reasoning_summary = "<thinking>...</thinking>"
  updated_at        = "2026-04-07T..."
```

---

### session_start 与 before_agent_start 的区别

两个 hook 的触发点不同，在代码调用栈中处于不同层次：

```
feishu 消息到达
    │
    ▼
get-reply.ts
    └─ initSessionState()
         └─ 若 isNewSession=true ──► session_start  ← session 层（低频）
              │
              ▼
         get-reply-run.ts
              └─ pi-embedded-runner/run.ts
                   └─ 调用 LLM 前 ──────────────► before_agent_start  ← agent run 层（每次）
```

| 对比项 | `session_start` | `before_agent_start` |
|--------|-----------------|----------------------|
| 触发频率 | 低频（session 首次创建或 `/new`/`/reset`） | 每次 agent 运行（每条用户消息） |
| 所在层次 | gateway session 管理层 | agent runner 层 |
| 传入的 `event` | `{ sessionId, sessionKey, resumedFrom? }` | `{ prompt, messages? }` |
| 传入的 `ctx` | `{ agentId?, sessionKey? }` | `{ agentId?, sessionKey?, sessionId?, workspaceDir?, trigger? }` |
| 本插件用途 | 兜底 + 写入 pre-flight trace ID 到飞书消息 | **主要** trace 创建入口 |

**设计原则**：

- `before_agent_start` 是主要的 trace 创建入口，覆盖所有 agent 运行场景
- `session_start` 作为兜底，并在其同步阶段写入 pre-flight trace ID 到 `process.env.AGENTLOG_TRACE_ID`，使 `/new` 的飞书回复中可展示 trace ID
- `agent_end` 对应 `before_agent_start`，每次 agent 运行结束后归档 trace

---

### 多轮对话的追踪模型

每条用户消息对应一个独立的 trace（而不是整个对话共享一个 trace）：

```
用户发消息 1 ──► Trace A (running → completed)
用户发消息 2 ──► Trace B (running → completed)
用户发消息 3 ──► Trace C (running → completed)
用户发 /new  ──► session_start（重置 session，飞书回复显示 trace ID）
用户发消息 4 ──► Trace D (running → completed)
```

这是因为 `agent_end` 会将 `currentSession = null`，下一条消息的 `before_agent_start` 检测到 `!currentSession` 后重新创建 trace。

---

### Trace Handoff（Agent 接力）

当一个 trace 需要由另一个 agent 继续处理时，通过 `sessions.json` 文件传递上下文：

```
Agent A 创建 trace → 写入 .git/agentlog/sessions.json (pending)
    │
    ▼
Agent B 启动 → checkAndClaimTrace()
    ├─ 读取 sessions.json，找到匹配的 pending trace
    ├─ 将 pending → active
    ├─ PATCH /api/traces/:id { status: "in_progress" }
    └─ 设置 process.env.AGENTLOG_TRACE_ID = traceId
```

---

## 飞书消息与 Trace ID

### 重置消息格式

发送 `/new` 或 `/reset` 后，飞书会收到如下格式的回复（需配置好 `allowFrom` 权限）：

```
✅ New trace started · model: minimax/MiniMax-M2.7 · trace: agentlog-m7k3p9
```

> **注意**：消息中的 trace ID 为 pre-flight 短格式，真实后端 ULID 记录在 OpenClaw 日志中（见下方）。

### Trace ID 的两个阶段

插件在 `/new` 触发时分两阶段生成 trace ID：

| 阶段 | 格式 | 时机 | 用途 |
|------|------|------|------|
| **Pre-flight ID** | `agentlog-xxxxxx`（短格式） | `session_start` 同步部分，在飞书消息发送之前 | 展示在飞书消息中，便于用户肉眼识别 |
| **真实 ULID** | `01KNXXX...`（26 位） | `startSession()` 异步完成，后端返回后 | AgentLog 数据库中的真实主键，用于 API 查询 |

### 为什么使用两阶段

`session_start` hook 是 fire-and-forget（不阻塞主流程），而 `sendResetSessionNotice`（发送飞书消息）在其之后同步执行。整个时序如下：

```
session_start 被调用（非 await）
    │
    ├─ [同步，立即执行] 生成 preflightTraceId = "agentlog-m7k3p9"
    │                   写入 process.env.AGENTLOG_TRACE_ID
    │
    │   ← 控制权返回主流程 →
    │
    ▼
sendResetSessionNotice()  ← 读取 process.env.AGENTLOG_TRACE_ID
    └─ 发送飞书消息："... · trace: agentlog-m7k3p9"
    │
    │   ← 后续异步继续执行 →
    │
    ▼
session_start 异步部分: POST /api/traces
    └─ 拿到真实 ULID → process.env.AGENTLOG_TRACE_ID = "01KNXXX..."
```

### 在日志中查找真实 ULID

```bash
ssh myclaw "grep 'Session started via session_start' /tmp/openclaw/openclaw-2026-04-07.log | tail -5"
# 输出示例：
# [openclaw-agentlog] Session started via session_start for agent:architect:...,
#                     agent: architect, trace: 01KNXXX...
```

### 实现细节

相关代码位于 `skills/openclaw-agentlog/src/index.ts`：

- `preflightTraceId`（模块级变量）：暂存 pre-flight ID，`startSession()` 完成后置 null
- `onSessionStart` 同步区域（第一个 `await` 之前）：生成并写入 pre-flight ID
- `startSession()`：`POST /api/traces` 完成后覆盖 `process.env.AGENTLOG_TRACE_ID`

OpenClaw dist 修改位于：
`~/.npm-global/lib/node_modules/openclaw/dist/reply-Bm8VrLQh.js`（`buildResetSessionNoticeText` 函数）

> ⚠️ 此 dist 修改在 OpenClaw npm 包升级时会被覆盖，需重新应用。原始文件已备份为 `reply-Bm8VrLQh.js.bak`。

---

## Hook 行为说明

### 触发时机汇总

| Hook | 触发时机 | AgentLog 操作 |
|------|----------|---------------|
| `before_agent_start` | 每次 agent 开始处理消息 | `POST /api/traces`（创建 trace），更新 `AGENTLOG_TRACE_ID` |
| `session_start` | session 首次创建或 `/new`/`/reset` | 同步写入 pre-flight trace ID；兜底创建 trace |
| `before_tool_call` | 每次工具调用前 | 内存计时（不写后端） |
| `after_tool_call` | 每次工具调用后 | `POST /api/spans`（写入 span） |
| `agent_end` | agent 完成本轮运行 | `PATCH /api/traces/:id`（归档，status → completed） |
| `session_end` | session 结束（与 `session_start` 对应） | 兜底清理残留 `currentSession` |

---

## 故障排查

### session_start 不触发

**排查步骤：**

**1. 确认 `/new` 命令是否被接收：**
```bash
grep 'Feishu.*message.*new\|dispatching' /tmp/openclaw/openclaw-2026-04-07.log | tail -10
```

**2. 确认 dispatch 返回结果：**
```bash
grep 'dispatch complete' /tmp/openclaw/openclaw-2026-04-07.log | tail -10
```
- `replies=1` → 命令被处理，session 已重置
- `replies=0` → 命令被拦截（权限不足），检查 `allowFrom` 配置

**3. 验证 `allowFrom` 配置是否正确：**
- 确认用户 ID（`ou_xxx`）和群组 ID（`oc_xxx`）写在 `channels.feishu.groups` 下，**不是**顶层 `feishu`
- 修改后重启 gateway

### 飞书消息中没有 trace ID

1. 确认 `session_start` hook 已触发：
   ```bash
   grep 'session_start hook fired' /tmp/openclaw/openclaw-2026-04-07.log | tail -3
   ```

2. 确认 dist 补丁是否存在：
   ```bash
   grep 'AGENTLOG_TRACE_ID' ~/.npm-global/lib/node_modules/openclaw/dist/reply-Bm8VrLQh.js
   ```
   若无输出，说明 dist 被覆盖（npm 升级），需重新应用补丁。

3. 确认 `process.env.AGENTLOG_TRACE_ID` 是否被写入：
   ```bash
   grep 'agentlog-' /tmp/openclaw/openclaw-2026-04-07.log | tail -5
   ```

### 插件未加载

```bash
grep 'openclaw-agentlog' /tmp/openclaw/openclaw-2026-04-07.log | head -5
```

正常输出应包含：
```
[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load:
..., openclaw-agentlog (/home/hobo/.openclaw/extensions/openclaw-agentlog/src/index.ts)
```

### Config invalid 错误（gateway 启动失败）

```
Config invalid
Problem: <root>: Unrecognized key: "feishu"
```

`feishu` 配置写到了顶层，需移至 `channels.feishu`：

```json
// ❌ 错误
{
  "feishu": { "groups": { ... } }
}

// ✅ 正确
{
  "channels": {
    "feishu": { "groups": { ... } }
  }
}
```

### before_agent_start 触发但没有创建 trace

检查 AgentLog 后端是否运行：

```bash
curl http://localhost:7892/health
```

若后端未运行，`POST /api/traces` 会静默失败（插件用 `try/catch` 包裹，不影响 agent 运行），`traceId` 会降级为 `trace_{timestamp}`。

### 实时监控 hook 触发

```bash
# 监控所有 hook 触发
ssh myclaw "tail -f /tmp/openclaw/openclaw-2026-04-07.log | grep --line-buffered 'agentlog.*DEBUG'"

# 仅监控 session_start 及 trace ID
ssh myclaw "tail -f /tmp/openclaw/openclaw-2026-04-07.log | grep --line-buffered 'session_start hook fired\|Session started via session_start'"

# 监控 trace 创建和归档
ssh myclaw "tail -f /tmp/openclaw/openclaw-2026-04-07.log | grep --line-buffered 'Session started\|finalized'"
```
