# OpenClaw Agent Log MCP E2E 测试用例（完整链路）

> 更新时间：2026-04-06
> 版本：v1.0
> 测试范围：MCP Client → Backend → Database（完整链路）

---

## 测试范围

真正的 E2E 测试需要覆盖完整链路：

```
┌─────────────────────────────────────────────────────────────────┐
│                      完整 E2E 测试链路                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  OpenClaw Agent                                                 │
│       ↓                                                          │
│  openclaw-agentlog Skill (MCP Client)                           │
│       ↓  HTTP/MCP Request                                        │
│  AgentLog Backend (/mcp endpoint)                               │
│       ↓                                                          │
│  SQLite Database                                                 │
│       ↓                                                          │
│  查询验证                                                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 前置条件

1. Backend 已启动：`curl http://localhost:7892/health` 返回 200
2. Backend MCP 端点可用：`POST http://localhost:7892/mcp`
3. Git 仓库已初始化
4. openclaw-agentlog Skill 已安装

---

## MCP 接口说明

### 核心 MCP 工具

| 工具 | 用途 |
|------|------|
| `log_turn` | 逐轮记录每条消息（user/assistant/tool） |
| `log_intent` | 任务结束时记录整体意图 |
| `query_traces` | 查询历史 traces |
| `query_historical_interaction` | 语义查询历史交互 |
| `claim_pending_trace` | 认领待处理的 trace |

### log_turn 参数

```typescript
{
  role: "user" | "assistant" | "tool",
  content: string,
  metadata?: {
    toolName?: string,
    toolArgs?: string,
    toolResult?: string,
    reasoning?: string,
    model?: string,
    tokenUsage?: { input: number, output: number }
  }
}
```

### log_intent 参数

```typescript
{
  traceId: string,
  sessionId: string,
  intent: string,
  summary?: string,
  affectedFiles?: string[],
  metadata?: Record<string, unknown>
}
```

---

## 测试用例

### TC-E2E-MCP-001：完整会话链路（log_turn + log_intent）

**目的**：验证从会话开始到结束的完整 MCP 链路

**测试步骤**：

```bash
# 1. 启动会话 (user role)
curl -X POST http://localhost:7892/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-001",
    "method": "tools/call",
    "params": {
      "name": "log_turn",
      "arguments": {
        "role": "user",
        "content": "帮我创建一个简单的 Hello World 函数"
      }
    }
  }'

# 从返回中提取 trace_id 和 session_id

# 2. Agent 思考 (assistant role with reasoning)
curl -X POST http://localhost:7892/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-002",
    "method": "tools/call",
    "params": {
      "name": "log_turn",
      "arguments": {
        "role": "assistant",
        "content": "我将创建一个简单的 JavaScript 函数",
        "metadata": {
          "reasoning": "用户需要一个简单的 Hello World 函数，这是基础任务。我将创建一个 hello.js 文件，包含一个 greet 函数。"
        }
      }
    }
  }'

# 3. 创建文件 (tool role)
curl -X POST http://localhost:7892/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-003",
    "method": "tools/call",
    "params": {
      "name": "log_turn",
      "arguments": {
        "role": "tool",
        "content": "文件 hello.js 已创建",
        "metadata": {
          "toolName": "write",
          "toolArgs": "hello.js",
          "toolResult": "文件写入成功"
        }
      }
    }
  }'

# 4. 完成会话 (log_intent)
curl -X POST http://localhost:7892/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-004",
    "method": "tools/call",
    "params": {
      "name": "log_intent",
      "arguments": {
        "traceId": "<上面获取的trace_id>",
        "sessionId": "<上面获取的session_id>",
        "intent": "完成 Hello World 函数创建",
        "summary": "创建了 greet 函数并导出",
        "affectedFiles": ["hello.js"]
      }
    }
  }'

# 5. 验证 trace 状态
curl -s http://localhost:7892/api/traces/<trace_id>
```

**预期结果**：
- trace 状态为 `completed`
- 包含 3 个 spans（user, assistant, tool）
- assistant span 包含 `reasoning` 元数据
- tool span 包含 `toolName`, `toolArgs`, `toolResult`

**优先级**：P0

---

### TC-E2E-MCP-002：MCP log_turn reasoning 捕获

**目的**：验证 DeepSeek-R1 reasoning 过程被正确捕获

**测试步骤**：

```bash
curl -X POST http://localhost:7892/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-101",
    "method": "tools/call",
    "params": {
      "name": "log_turn",
      "arguments": {
        "role": "assistant",
        "content": "<thinking>让我分析这个需求...</thinking>\n\n我将创建一个 Python 函数",
        "metadata": {
          "reasoning": "用户需要一个函数来打印 Hello World。考虑使用 Python 的 def 关键字创建一个 greet 函数，返回 'Hello, World!' 字符串。",
          "model": "deepseek-r1"
        }
      }
    }
  }'
```

**预期结果**：
- span 的 `metadata.reasoning` 字段包含完整推理过程
- `metadata.model` 为 `deepseek-r1`

**优先级**：P0

---

### TC-E2E-MCP-003：MCP tool call 记录

**目的**：验证工具调用参数和结果被完整记录

**测试步骤**：

```bash
curl -X POST http://localhost:7892/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-201",
    "method": "tools/call",
    "params": {
      "name": "log_turn",
      "arguments": {
        "role": "tool",
        "content": "bash 执行结果",
        "metadata": {
          "toolName": "bash",
          "toolArgs": "ls -la /home/hobo/Projects/agentlog",
          "toolResult": "total 48\ndrwxr-xr-x 48 hobo hobo 4096 Apr  6 12:00 agentlog\ndrwxr-xr-x  2 hobo hobo 4096 Mar 28 17:30 logs",
          "duration": 150
        }
      }
    }
  }'
```

**预期结果**：
- span 包含完整的 `toolName`, `toolArgs`, `toolResult`
- 可选 `duration` 字段

**优先级**：P0

---

### TC-E2E-MCP-004：Trace Handoff 流程（MCP）

**目的**：验证通过 MCP 进行 trace 交接

**前置条件**：已存在 pending trace

**测试步骤**：

```bash
# 1. 创建 pending trace
curl -X POST http://localhost:7892/api/traces \
  -H "Content-Type: application/json" \
  -d '{
    "source": "openclaw:architect",
    "workspacePath": "/home/hobo/Projects/agentlog",
    "taskGoal": "设计文档完成，需要交接给 builder"
  }'

# 获取 trace_id，状态为 pending_handoff

# 2. Builder 通过 MCP 认领 trace
curl -X POST http://localhost:7892/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-301",
    "method": "tools/call",
    "params": {
      "name": "claim_pending_trace",
      "arguments": {
        "workspacePath": "/home/hobo/.openclaw/agents/builder/workspace"
      }
    }
  }'
```

**预期结果**：
- `claim_pending_trace` 返回被认领的 trace_id
- trace 状态变为 `in_progress`

**优先级**：P1

---

### TC-E2E-MCP-005：查询历史 Traces（MCP）

**目的**：验证 query_traces MCP 工具

**测试步骤**：

```bash
curl -X POST http://localhost:7892/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-401",
    "method": "tools/call",
    "params": {
      "name": "query_traces",
      "arguments": {
        "source": "openclaw:builder",
        "limit": 10
      }
    }
  }'
```

**预期结果**：
- 返回 builder 的所有 traces
- 包含 trace_id, task_goal, status, created_at

**优先级**：P0

---

### TC-E2E-MCP-006：多 Agent Source 标识

**目的**：验证每个 Agent 的 source 标识正确

**测试步骤**：

```bash
# 模拟 8 个不同 Agent 调用 log_turn
for agent in architect auditor builder growth-hacker strategist engineer "market-person" "存证员"; do
  curl -X POST http://localhost:7892/mcp \
    -H "Content-Type: application/json" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": \"test-$agent\",
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"log_turn\",
        \"arguments\": {
          \"role\": \"user\",
          \"content\": \"来自 $agent 的测试消息\"
        }
      }
    }"
  echo "✅ $agent"
done
```

**预期结果**：
- 所有 8 个 Agent 都能成功调用
- traces 表中 source 字段正确

**优先级**：P0

---

### TC-E2E-MCP-007：Session Stats 与 Traces 关联

**目的**：验证 Backend API 和 MCP 返回的数据一致

**测试步骤**：

```bash
# 1. 通过 MCP 创建多个 traces
for i in {1..3}; do
  curl -X POST http://localhost:7892/mcp \
    -H "Content-Type: application/json" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": \"stat-test-$i\",
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"log_turn\",
        \"arguments\": {
          \"role\": \"user\",
          \"content\": \"统计测试 $i\"
        }
      }
    }"
done

# 2. 通过 REST API 验证数据
curl -s http://localhost:7892/api/sessions/stats

# 3. 通过 MCP query_traces 验证
curl -X POST http://localhost:7892/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "stat-verify",
    "method": "tools/call",
    "params": {
      "name": "query_traces",
      "arguments": {}
    }
  }'
```

**预期结果**：
- REST API 和 MCP 返回的数据一致
- Session stats 中的 `openclaw:xxx` 计数正确

**优先级**：P1

---

## 测试报告模板

```markdown
## MCP E2E 测试执行报告

**日期**：[YYYY-MM-DD HH:mm]
**执行人**：Auditor
**环境**：Backend v1.1.1

### 执行结果

| 测试用例 | 状态 | MCP 返回 | 数据库验证 |
|----------|------|----------|------------|
| TC-E2E-MCP-001 | ✅/❌ | 有/无 trace_id | ✅/❌ |
| TC-E2E-MCP-002 | ✅/❌ | reasoning 捕获 | ✅/❌ |
| ... | ... | ... | ... |

### 问题记录

- [ ] 问题 1
- [ ] 问题 2

### 总结

- 通过：X/Y
- 失败：X/Y
- 核心问题：[描述]
```

---

## 附录：MCP 请求格式

### 标准 MCP 请求

```json
{
  "jsonrpc": "2.0",
  "id": "unique-id",
  "method": "tools/call",
  "params": {
    "name": "工具名",
    "arguments": { ... }
  }
}
```

### MCP 响应格式

```json
{
  "jsonrpc": "2.0",
  "id": "unique-id",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "..." 
      }
    ],
    "isError": false
  }
}
```

### log_turn 成功响应

```json
{
  "jsonrpc": "2.0",
  "id": "test-001",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"success\":true,\"trace_id\":\"01KNH...\",\"session_id\":\"...\",\"span_id\":\"...\"}"
      }
    ]
  }
}
```
