# Trace 功能交互测试用例

## 测试目标

验证 **OpenCode → OpenClaw Agent → AgentLog → VSCode Trace View** 完整链路

## 前置条件

### 1. 服务启动
```bash
# 终端 1: 启动 AgentLog Backend
cd /Users/hobo/Projects/AgentLog
pnpm dev

# 确认后端运行在 http://localhost:7892
```

### 2. VSCode Extension
- AgentLog VSCode 扩展已安装并激活
- 侧边栏显示 **"Trace 列表"** 视图

---

## 测试用例

### TC-001: OpenCode 配置 AgentLog MCP

**目的**: 验证 OpenCode 能正确配置并连接 AgentLog MCP Server

**步骤**:
1. 在 OpenCode 中打开 AgentLog workspace:
   ```bash
   cd /Users/hobo/Projects/AgentLog
   opencode .
   ```

2. 配置 AgentLog MCP（如果尚未配置）:
   - 打开 OpenCode 设置 → MCP Servers
   - 添加 AgentLog MCP:
     ```
     Name: agentlog
     Command: /Users/hobo/.nvm/versions/node/v22.22.0/bin/node
     Args: /Users/hobo/Projects/AgentLog/packages/backend/dist/mcp.js
     Env: 
       AGENTLOG_DB_PATH=~/.agentlog/agentlog.db
       AGENTLOG_PORT=7892
     ```

3. 验证 MCP 连接:
   ```bash
   # 在 OpenCode 中执行 MCP test 或 health check
   /mcp-tools agentlog-mcp_query_historical_interaction
   ```

**预期结果**:
- MCP 连接成功
- 能查询到之前创建的测试数据（5条 traces）

---

### TC-002: OpenCode Agent 交互生成 Trace

**目的**: 验证 OpenCode Agent 执行任务时能生成 Trace 数据

**步骤**:
1. 在 OpenCode 中发起一个新任务:
   ```
   请帮我创建一个简单的测试文件 src/test-demo.ts，内容是输出 "Hello Trace"
   ```

2. 观察 OpenCode 的响应和日志

3. 验证 Trace 是否生成:
   ```bash
   # 查询最新创建的 trace
   curl -s http://localhost:7892/api/traces?page=1\&pageSize=5 | jq '.data[0]'
   ```

**预期结果**:
- OpenCode Agent 完成任务
- 新 Trace 被创建（可通过 API 查询到）
- Trace 状态为 `running`

**验证 Span 生成**:
```bash
# 获取最新 trace ID 并查看其 spans
TRACE_ID=$(curl -s http://localhost:7892/api/traces?page=1\&pageSize=1 | jq -r '.data[0].id')
curl -s http://localhost:7892/api/traces/$TRACE_ID | jq '.data'
```

---

### TC-003: OpenCode log_turn 调用记录到 Trace

**目的**: 验证 `log_turn` 调用能生成 Span 并关联到 Trace

**步骤**:
1. 在 OpenCode 中执行 log_turn 调用:
   ```bash
   # 模拟 log_turn 调用（通过 MCP）
   log_turn(role="user", content="创建一个新组件 UserCard.tsx", model="claude-sonnet-4-20250514")
   ```

2. 执行工具操作:
   ```bash
   # 模拟工具执行
   log_turn(role="tool", content="已创建文件 UserCard.tsx", tool_name="write", tool_input="path=src/UserCard.tsx")
   ```

3. 查询 Trace 和 Span:
   ```bash
   # 查看最新的 spans
   curl -s http://localhost:7892/api/spans | jq '.data | length'
   ```

**预期结果**:
- log_turn 调用成功
- 对应的 Span 被创建
- Span 通过 traceId 关联到 Trace

---

### TC-004: OpenClaw Agent 传递 Trace 到 AgentLog

**目的**: 验证 OpenClaw Agent 的 hook 事件能正确传递到 AgentLog

**前置条件**:
- OpenClaw Gateway 运行中
- agentlog-auto skill 已配置

**步骤**:
1. 启动 OpenClaw Agent（带有 AgentLog skill）:
   ```bash
   openclaw agents create --name test-agent --skills agentlog-auto
   openclaw agents run test-agent
   ```

2. 在 OpenClaw Agent 中执行简单任务:
   ```
   > 你好，请介绍一下自己
   ```

3. 检查 AgentLog Backend 日志:
   ```
   [AgentLog Probe] 上报 X 个事件到 http://localhost:7892
   ```

4. 查询 Trace:
   ```bash
   curl -s http://localhost:7892/api/traces | jq '.data[] | {id, taskGoal, status}'
   ```

**预期结果**:
- OpenClaw Agent 生命周期事件被捕获（bootstrap, session:start, session:end）
- TelemetryProbe 将事件上报到 `/api/spans`
- 新 Trace 被创建或更新

---

### TC-005: VSCode Trace 列表视图显示 Trace

**目的**: 验证 VSCode 侧边栏能正确显示 Trace 列表

**步骤**:
1. 打开 VSCode
2. 点击左侧 **"AgentLog"** 视图容器
3. 展开 **"Trace 列表"** 节点

**预期结果**:
- 显示所有 traces（之前测试创建的）
- 每个 trace 显示:
  - 图标: `running`(暂停图标) / `completed`(勾选) / `failed`(错误) / `paused`(圆圈)
  - 名称: taskGoal 或截断的 ID
  - 描述: status 状态

**验证 Trace 详情**:
1. 点击某个 Trace Item
2. 应该展开显示子节点（Spans）
3. 每个 Span 显示:
   - 图标: `human`(用户) / `agent`(机器人) / `system`(齿轮)
   - 名称: actorName
   - 描述: event 类型

---

### TC-006: VSCode Trace Webview 查看详情

**目的**: 验证点击 Trace 能打开详情 Webview 并显示完整信息

**步骤**:
1. 在 VSCode Trace 列表中，右键点击一个 Trace
2. 选择 **"Open in Trace View"** 或双击

**预期结果**:
- 打开 Trace Webview Panel
- 显示:
  - **Header**: Trace ID, Task Goal, Status, 创建时间
  - **Statistics**: 
    - Total Spans
    - Human / Agent / System spans 数量
    - Root Span 数量
  - **Timeline**: 最早/最新事件时间
  - **Span Tree**: 可展开的树状结构

**验证失败 Trace**:
1. 选择状态为 `failed` 的 Trace
2. 应显示 **Failure Summary**:
   - failedAt
   - failedActor
   - errorMessage
   - stackTrace

---

### TC-007: SSE 实时刷新

**目的**: 验证新增 Span 时，VSCode 能实时接收并刷新显示

**前置条件**:
- VSCode 已连接 Backend
- Backend SSE 端点 `/mcp/sse` 可用

**步骤**:
1. 打开 VSCode Trace 列表（确保连接建立）
2. 通过 API 手动创建一个 Span:
   ```bash
   # 获取一个 running trace 的 ID
   TRACE_ID=$(curl -s http://localhost:7892/api/traces?status=running | jq -r '.data[0].id')
   
   # 创建新 Span
   curl -X POST http://localhost:7892/api/spans \
     -H "Content-Type: application/json" \
     -d '{
       "traceId": "'$TRACE_ID'",
       "actorType": "agent",
       "actorName": "test-agent",
       "payload": {"event": "manual_test", "message": "SSE real-time test"}
     }'
   ```

3. 观察 VSCode Trace 列表

**预期结果**:
- 新的 Span 自动出现在 Trace 树中
- 无需手动刷新

---

### TC-008: Trace 状态更新

**目的**: 验证 Trace 状态能正确更新

**步骤**:
1. 创建一个新 Trace:
   ```bash
   curl -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal": "测试状态更新"}'
   ```

2. 获取返回的 trace_id

3. 更新为 completed:
   ```bash
   curl -X PATCH http://localhost:7892/api/traces/{trace_id} \
     -H "Content-Type: application/json" \
     -d '{"status": "completed"}'
   ```

4. 更新为 failed:
   ```bash
   curl -X PATCH http://localhost:7892/api/traces/{trace_id} \
     -H "Content-Type: application/json" \
     -d '{"status": "failed"}'
   ```

**预期结果**:
- 每次状态更新返回更新后的 Trace
- VSCode 列表中图标随状态变化

---

## 测试数据清理

测试完成后，清理测试数据:

```bash
# 删除所有测试 traces
curl -s http://localhost:7892/api/traces | jq -r '.data[].id' | while read id; do
  curl -X DELETE http://localhost:7892/api/traces/$id
done

# 或通过 SQLite 直接清理
sqlite3 ~/.agentlog/agentlog.db "DELETE FROM spans; DELETE FROM traces;"
```

---

## 预期测试结果汇总

| 用例 | 功能 | 预期结果 |
|------|------|----------|
| TC-001 | OpenCode MCP 配置 | MCP 成功连接，能查询数据 |
| TC-002 | OpenCode 生成 Trace | 新 Trace 被创建 |
| TC-003 | log_turn 生成 Span | Span 正确关联到 Trace |
| TC-004 | OpenClaw Hook 事件 | TelemetryProbe 上报事件 |
| TC-005 | VSCode Trace List | 列表正确显示所有 Traces |
| TC-006 | Trace Webview | 详情页面显示完整信息 |
| TC-007 | SSE 实时刷新 | 新 Span 自动出现 |
| TC-008 | 状态更新 | 状态变更正确反映 |

---

## 故障排查

### Backend 未启动
```bash
curl http://localhost:7892/health
# 预期: {"status":"ok","version":"..."}
```

### Trace 列表为空
1. 检查 Backend 日志是否有错误
2. 手动创建测试数据:
   ```bash
   node /Users/hobo/Projects/AgentLog/packages/backend/scripts/seed-trace-data.ts
   ```

### SSE 未推送
1. 检查 SSE 客户端数量:
   ```bash
   curl http://localhost:7892/mcp/sse/clients
   ```
2. 检查 VSCode Output Channel "AgentLog" 的日志
