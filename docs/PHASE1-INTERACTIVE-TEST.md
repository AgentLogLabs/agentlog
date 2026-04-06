# AgentLog Phase 1 交互测试用例

> **测试版本**：v1.1.0  
> **测试日期**：2026-04-04  
> **测试范围**：OpenCode ↔ OpenClaw ↔ AgentLog Trace 完整链路  
> **前提条件**：AgentLog Backend 已启动 (`npm run dev`)

---

## 📋 测试用例总览

| 用例编号 | 测试场景 | 优先级 | 预计时间 |
|----------|----------|--------|----------|
| TC-001 | OpenCode 配置 AgentLog | P0 | 5 min |
| TC-002 | OpenCode Agent 交互生成 Trace | P0 | 10 min |
| TC-003 | OpenClaw Agent 接收 Trace | P0 | 10 min |
| TC-004 | VS Code Trace 树状视图验证 | P0 | 5 min |
| TC-005 | Git Hook 拦截人类提交 | P1 | 5 min |
| TC-006 | SSE 实时刷新验证 | P1 | 5 min |
| TC-007 | Trace Summary/Diff API | P2 | 5 min |

---

## 🔧 前置条件

### 1. 启动 AgentLog Backend

```bash
cd /home/hobo/Projects/agentlog/packages/backend
npm run dev
# 确认端口 7892 启动
curl http://localhost:7892/health
# 预期: {"status":"ok",...}
```

### 2. 确认 VS Code 扩展已安装并启用

在 VS Code 中：
1. 打开 Extensions (Ctrl+Shift+X)
2. 搜索 "AgentLog"
3. 确认已安装并启用

### 3. 配置 Backend URL

VS Code 设置中配置：
```json
{
  "agentlog.backendUrl": "http://localhost:7892"
}
```

---

## ✅ 测试用例详情

---

### TC-001：OpenCode 配置 AgentLog

**目的**：验证 OpenCode 能正确配置 AgentLog 作为 MCP 工具提供者

**前置条件**：
- AgentLog Backend 运行在 localhost:7892
- AgentLog VS Code 扩展已安装
- OpenCode 已安装

**测试步骤**：

1. **通过 VS Code 扩展自动配置**
   - 在 VS Code 中打开 Command Palette (`Cmd+Shift+P`)
   - 输入 `AgentLog: Configure MCP Client`
   - 在 QuickPick 中选择 **OpenCode**
   - 扩展会自动完成以下操作：
     - 写入 MCP 配置到 `~/.config/opencode/config.json`
     - 安装 `agentlog-auto` 插件到 `~/.config/opencode/plugins/agentlog-auto/`
     - 写入调用规则到 `~/.config/opencode/AGENTS.md`

2. **验证配置**
   ```bash
   cat ~/.config/opencode/config.json
   ```
   预期输出包含：
   ```json
   {
     "mcp": {
       "agentlog": {
         "type": "local",
         "command": ["node", "/path/to/agentlog-vscode/dist/backend/mcp.js"],
         "environment": {
           "AGENTLOG_GATEWAY_URL": "http://localhost:7892"
         },
         "enabled": true
       }
     }
   }
   ```

3. **重启 OpenCode 使配置生效**

4. **验证连接**
   - 重启 OpenCode
   - 检查 MCP 工具列表是否包含 AgentLog 工具

**预期结果**：
- [ ] AgentLog MCP Server 成功连接
- [ ] `agentlog-auto` 插件已安装到 `~/.config/opencode/plugins/agentlog-auto/`
- [ ] `AGENTS.md` 中包含 AgentLog 调用规则
- [ ] 可看到 `agentlog_*` 系列 MCP 工具

**实际结果**：

---

### TC-002：OpenCode Agent 交互生成 Trace

**目的**：验证 OpenCode Agent 执行任务时，AgentLog 自动捕获并生成 Trace

**前置条件**：
- TC-001 已完成
- AgentLog MCP Server 正常运行

**测试步骤**：

1. **创建新任务触发 Trace**
   
   在 OpenCode 中向 Agent 发送任务：
   ```
   请用 JavaScript 写一个简单的 Hello World 函数，并解释它的作用。
   ```

2. **观察 AgentLog Backend 日志**
   ```bash
   # 观察是否有 span 上报
   curl http://localhost:7892/api/traces
   ```

3. **验证 Trace 生成**
   ```bash
   # 获取最新 trace
   TRACE_LIST=$(curl -s http://localhost:7892/api/traces?pageSize=5)
   echo "$TRACE_LIST"
   ```

4. **查看详细 Span**
   ```bash
   # 替换为实际 trace ID
   TRACE_ID="<从上面获取的 trace ID>"
   curl http://localhost:7892/api/traces/$TRACE_ID/summary
   ```

**预期结果**：
- [ ] OpenCode Agent 执行任务后，Backend 收到 span 上报
- [ ] `/api/traces` 返回新创建的 trace
- [ ] trace 包含 agent 类型的 span
- [ ] span 包含完整的 payload（toolName, event 等）

**实际结果**：

---

### TC-003：OpenClaw Agent 接收 Trace 并复水

**目的**：验证 OpenClaw Agent 能通过 MCP 工具获取之前的 Trace 上下文

**前置条件**：
- TC-002 已完成，有可查询的 trace
- OpenClaw Agent 已配置 AgentLog MCP

**测试步骤**：

1. **查询失败的交互**
   
   在 OpenClaw Agent 中调用 MCP 工具：
   ```
   使用 agentlog_get_failed_attempts 工具
   参数: limit=5
   ```

2. **获取特定 Trace 详情**
   ```
   使用 agentlog_get_trace 工具
   参数: trace_id=<TC-002 中的 trace ID>
   ```

3. **验证上下文复水**
   - 检查返回的 trace 是否包含完整的历史 span
   - 确认包含之前的错误信息和工具调用记录

4. **通过 Trace ID 跳转**
   ```
   使用 agentlog_jump_to_trace 工具
   参数: trace_id=<trace ID>
   ```

**预期结果**：
- [ ] MCP 工具返回历史 trace 数据
- [ ] 包含完整的 span 树结构
- [ ] 人类介入的 span (actor: human) 可见
- [ ] 错误栈信息完整

**实际结果**：

---

### TC-004：VS Code Trace 树状视图验证

**目的**：验证 VS Code 中 Trace 面板正确显示 trace 树状结构

**前置条件**：
- VS Code AgentLog 扩展已安装
- Backend 运行中

**测试步骤**：

1. **打开 Trace 视图**
   - 在 VS Code 侧边栏找到 AgentLog 图标
   - 点击 "Trace List" 视图

2. **执行任务生成 Trace**
   - 使用任意 Agent（OpenCode 或 OpenClaw）
   - 执行一个简单任务

3. **观察树状视图**
   - 检查是否显示新的 trace 条目
   - 点击 trace 展开 span 树
   - 验证 human/agent/system 不同类型 span 的图标区分

4. **点击具体 Span**
   - 查看 span 详情
   - 确认 payload 信息完整

5. **SSE 实时刷新测试**
   - 在 Agent 执行任务时
   - 观察 Trace 视图是否实时更新（无需手动刷新）

**预期结果**：
- [ ] Trace List 视图显示所有 traces
- [ ] 状态图标正确（running/completed/failed）
- [ ] 点击展开显示 span 树
- [ ] 不同 actor 类型有视觉区分
- [ ] 新数据出现时自动刷新

**实际结果**：

---

### TC-005：Git Hook 拦截人类提交

**目的**：验证 Git post-commit hook 正确拦截人类操作，读取 git config traceId 作为基准，绑定所有后续 traces

**前置条件**：
- Git Hook 已安装（通过 AgentLog）
- 处于 Git 仓库中
- git config 中已设置 agentlog.traceid

**测试步骤**：

1. **安装 Git Hook**
   ```bash
   curl -X POST http://localhost:7892/api/hooks/install \
     -H "Content-Type: application/json" \
     -d '{"workspacePath":"/path/to/repo"}'
   ```

2. **验证 Hook 安装**
   ```bash
   curl "http://localhost:7892/api/hooks/status?workspacePath=/path/to/repo"
   # 确认 hookInstalled: true
   ```

3. **设置 git config traceId（作为基准）**
   ```bash
   cd /path/to/repo
   # 创建一个 trace 并设置为基准
   TRACE=$(curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"Base trace for binding test"}')
   TRACE_ID=$(echo $TRACE | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   git config agentlog.traceid $TRACE_ID
   echo "基准 traceId: $TRACE_ID"
   ```

4. **创建额外 traces（模拟 AI 工作）**
   ```bash
   # 模拟 AI 创建新的 trace
   curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"Second AI task"}' > /dev/null
   ```

5. **执行人类操作并提交**
   ```bash
   # 手动修改一个文件
   echo "# Test" > test.md
   git add test.md
   git commit -m "Human intervention test"
   sleep 2
   ```

6. **验证所有 traces 被绑定到 commit**
   ```bash
   COMMIT_HASH=$(git rev-parse HEAD)
   curl -s "http://localhost:7892/api/commits/$COMMIT_HASH" | python3 -c "
   import sys,json
   d=json.load(sys.stdin)
   if d.get('success'):
       data = d.get('data', {})
       trace_ids = data.get('traceIds', [])
       print('Bound traces:', len(trace_ids))
       for tid in trace_ids:
           print('  -', tid)
   "
   ```

**预期结果**：
- [ ] Git Hook 安装成功
- [ ] git config traceId 已设置
- [ ] 人类提交后，commit_bindings 包含基准 trace + 所有后续 traces（共 2 个）
- [ ] 每个 trace 都有 actor:human 类型的 span
- [ ] span payload 包含 commit hash 和 diff 信息

**实际结果**：

---

### TC-006：SSE 实时刷新验证

**目的**：验证 SSE 推送机制正常工作

**测试步骤**：

1. **建立 SSE 连接**
   ```bash
   curl -N http://localhost:7892/mcp/sse \
     -H "Accept: text/event-stream"
   # 保持连接不关闭
   ```

2. **触发数据上报**
   ```bash
   curl -X POST http://localhost:7892/api/spans \
     -H "Content-Type: application/json" \
     -d '{
       "traceId": "<任意 trace ID>",
       "actorType": "agent",
       "actorName": "Test",
       "payload": {"event": "sse-test"}
     }'
   ```

3. **观察 SSE 推送**
   - 检查 SSE 连接是否收到 `span_created` 事件
   - 验证 JSON 数据结构正确

**预期结果**：
- [ ] SSE 连接建立成功 (HTTP 200)
- [ ] 新 span 创建后，SSE 推送即时到达
- [ ] 推送数据格式: `{"type":"span_created","data":{...}}`

**实际结果**：

---

### TC-007：Trace Summary/Diff API

**目的**：验证 T6、T7 API 功能正确性

**测试步骤**：

1. **准备测试数据**
   ```bash
   # 创建 trace
   TRACE=$(curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"API Test"}')
   TRACE_ID=$(echo $TRACE | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   
   # 添加多个 spans
   for i in {1..3}; do
     curl -s -X POST http://localhost:7892/api/spans \
       -H "Content-Type: application/json" \
       -d "{\"traceId\":\"$TRACE_ID\",\"actorType\":\"agent\",\"actorName\":\"TestAgent\",\"payload\":{\"seq\":$i}}"
   done
   ```

2. **测试 Summary API**
   ```bash
   curl http://localhost:7892/api/traces/$TRACE_ID/summary
   ```

3. **验证 Summary 响应**
   - [ ] `statistics.totalSpans == 3`
   - [ ] `statistics.agentSpans == 3`
   - [ ] `timeline.earliestEvent` 和 `timeline.latestEvent` 存在
   - [ ] `performance.processingTimeMs` 存在

4. **测试 Diff API**
   ```bash
   curl http://localhost:7892/api/traces/$TRACE_ID/diff
   ```

5. **验证 Diff 响应**
   - [ ] `spanTree` 数组包含 3 个 span
   - [ ] `summary.actorTypeBreakdown` 正确
   - [ ] `changes` 数组映射所有 span

**预期结果**：
- [ ] Summary 返回完整统计信息
- [ ] Diff 返回完整 span 树
- [ ] 两个 API 响应时间 < 100ms

**实际结果**：

---

### TC-008：人机混合微操接管完整链路（Use Case 1）

**目的**：验证 Agent 陷入死循环后，CEO 手动修复并提交，Agent 恢复时能感知到人类干预并继续执行

**对应方案**：
> Use Case 1: 人机混合微操接管 (Handoff Tracing)
> - CEO 在 VS Code 修复 Bug，执行 `git commit`
> - AgentLog Git Hook 捕获 Diff，封装为 `Span (actor: human)`
> - 重新唤醒 Agent 时，Agent 自动拉取该 TraceID 的最新上下文

**前置条件**：
- TC-001、TC-002 已完成
- AgentLog Backend 运行中
- Git Hook 已安装

**测试步骤**：

1. **启动 Agent 执行会失败的任务**
   ```bash
   # 假设有一个会触发死循环或报错的任务
   # 例如：让 Agent 修复一个不存在的文件
   ```

2. **观察 Agent 失败或陷入循环**
   - 记录当前的 `trace_id`

3. **CEO 手动介入修复**
   ```bash
   # 手动修复问题
   echo "# Fixed" > task.md
   git add task.md
   git commit -m "fix: CEO manual intervention"
   ```

4. **验证 Human Span 已创建**
   ```bash
   TRACE_ID="<上一步的 trace_id>"
   curl http://localhost:7892/api/traces/$TRACE_ID/summary
   # 确认 humanSpans >= 1
   ```

5. **Agent 恢复并拉取上下文**
   ```bash
   # 在 OpenCode/OpenClaw 中唤醒 Agent
   # 传入 trace_id 环境变量或通过 MCP 工具指定
   ```

6. **验证 Agent 感知到人类修改**
   - Agent 调用 `agentlog_get_trace` 获取完整上下文
   - Agent 的回复中应体现对 human span 的理解（如提到 "我看到之前的修改"）

**预期结果**：
- [ ] Git Hook 成功创建 `actor:human` 类型的 span
- [ ] span payload 包含 commit hash 和 diff 信息
- [ ] Agent resume 后能通过 API 获取到 human span
- [ ] Agent 的行为体现出对人类干预上下文的理解

**实际结果**：

---

### TC-009：跨 Agent 急诊交接链路（Use Case 2）

**目的**：验证 Builder Agent 失败后，Reviewer Agent 能通过 TraceID 接手并基于完整上下文修复问题

**对应方案**：
> Use Case 2: 跨 Agent 的"急诊交接" (JIT Context Hydration)
> - Builder 失败时只传递 `TraceID: T-888`
> - Reviewer 收到后调用 `get_failed_attempts(trace_id)`
> - 获取结构化的历史报错栈、输入参数及环境状态，零信息损耗接手

**前置条件**：
- TC-002 已完成（有可查询的 trace）
- OpenClaw Agent 已配置 AgentLog MCP

**测试步骤**：

1. **模拟 Builder Agent 执行失败**
   ```bash
   # 创建一个会失败的任务 trace
   RESP=$(curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"Builder task that will fail"}')
   BUILDER_TRACE_ID=$(echo $RESP | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   
   # 添加一些 agent spans（模拟 Builder 执行）
   curl -s -X POST http://localhost:7892/api/spans \
     -H "Content-Type: application/json" \
     -d "{\"traceId\":\"$BUILDER_TRACE_ID\",\"actorType\":\"agent\",\"actorName\":\"BuilderAgent\",\"payload\":{\"event\":\"error\",\"message\":\"Configuration failed\"}}"
   
   echo "Builder Trace ID: $BUILDER_TRACE_ID"
   ```

2. **模拟 Builder 失败并传递 TraceID**
   ```bash
   # 模拟 Builder 输出：
   # "任务失败，请 Reviewer 接手。TraceID: $BUILDER_TRACE_ID"
   ```

3. **Reviewer Agent 获取失败详情**
   ```bash
   # 使用 MCP 工具获取失败上下文
   curl http://localhost:7892/api/traces/$BUILDER_TRACE_ID/summary
   
   # 验证返回完整的：
   # - 错误栈信息
   # - 之前的工具调用记录
   # - 输入参数和环境状态
   ```

4. **Reviewer 基于上下文修复**
   ```bash
   # 在 OpenClaw Agent 中使用 agentlog_get_failed_attempts
   # 验证 Reviewer 能获取到完整的历史记录
   
   # 验证 Reviewer 的修复是否基于完整的失败上下文
   ```

5. **验证上下文复水成功**
   ```bash
   # 查询 Reviewer 创建的新 span 是否正确挂载到原 trace
   curl http://localhost:7892/api/traces/$BUILDER_TRACE_ID/diff
   # 确认 spanTree 包含 Builder 的 error span + Reviewer 的修复 span
   ```

**预期结果**：
- [ ] Reviewer 通过 TraceID 获取到 Builder 的完整失败上下文
- [ ] 包含错误栈、输入参数、历史工具调用
- [ ] Reviewer 的修复 span 正确挂载到同一 trace
- [ ] 无需 Builder 提供额外总结，Reviewer 零信息损耗接手

**实际结果**：

---

## 🐛 问题记录

| Bug ID | 描述 | 严重程度 | 状态 |
|--------|------|----------|------|
| | | | |

---

## 📊 测试总结

| 项目 | 结果 |
|------|------|
| 测试用例总数 | 9 |
| 通过 | X |
| 失败 | X |
| 阻塞 | X |

**测试结论**：

---

## 📝 附录

### A. 相关文件路径

- Backend 代码：`/home/hobo/Projects/agentlog/packages/backend/src/`
- VS Code 扩展：`/home/hobo/Projects/agentlog/packages/vscode-extension/`
- OpenClaw Hook：`/home/hobo/Projects/agentlog/packages/backend/src/probe/openclaw-hook/`

### B. API 端点速查

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/api/traces` | GET | 查询 trace 列表 |
| `/api/traces` | POST | 创建 trace（log_turn 首次调用时自动创建） |
| `/api/traces/:id` | GET | 获取单个 trace |
| `/api/traces/:id` | PATCH | 更新 trace 状态（log_intent 调用） |
| `/api/traces/:id/summary` | GET | 获取 trace 摘要 |
| `/api/traces/:id/diff` | GET | 获取 trace diff |
| `/api/spans` | POST | 创建 span（log_turn 后续调用时创建） |
| `/api/hooks/post-commit` | POST | post-commit 回调 |
| `/api/hooks/install` | POST | 安装 git hook |
| `/mcp/sse` | GET | SSE 实时推送 |
| MCP: `log_turn` | 工具 | 逐轮记录（首次创建 trace，后续追加 span） |
| MCP: `log_intent` | 工具 | 任务归档（更新 trace 状态为 completed） |
| MCP: `query_historical_interaction` | 工具 | 查询历史 trace |

### C. 关键 Commit

| Commit | 功能 |
|--------|------|
| `7189503` | T2 MCP 双轨升级 |
| `c5fc7af` | T4 OpenClaw Hook 探针 |
| `039c60f` | T5 Git Hook |
| `c0859e0` | T6+T7 Trace summary/diff API |
| `6422cc8` | T8 UI SSE 实时刷新 |
| `2984932` | POST /api/traces 端点 |
| `fb2c9e2` | traceList View 注册 |
