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
- AgentLog Backend 已构建：`cd /home/hobo/Projects/agentlog && pnpm build`
- AgentLog Backend 运行在 localhost:7892
- OpenCode 已安装

**测试步骤**：

1. **确认 MCP Server 文件位置**
   ```bash
   # MCP Server 位于 backend 包的 dist 目录
   ls /home/hobo/Projects/agentlog/packages/backend/dist/mcp.js
   ```

2. **配置 OpenCode MCP**
   
   编辑 `~/.config/opencode/config.json`：
   
   ```json
   {
     "mcpServers": {
       "agentlog-mcp": {
         "command": "node",
         "args": [
           "/absolute/path/to/agentlog/packages/backend/dist/mcp.js"
         ],
         "env": {
           "AGENTLOG_PORT": "7892"
         }
       }
     }
   }
   ```
   
   **⚠️ 重要**：
   - 路径必须是**绝对路径**
   - 应指向 `packages/backend/dist/mcp.js`，**不是** VS Code extension 路径
   - VS Code extension 路径（`~/.vscode/extensions/...`）**不适用于 OpenCode**

3. **验证连接**
   - 重启 OpenCode
   - 执行任意任务，观察 Backend 日志是否有 MCP 请求到达

4. **验证 MCP 工具可用**
   在 OpenCode 中执行任务时，检查 Backend 是否收到 `log_turn` / `log_intent` 调用。

**预期结果**：
- [ ] OpenCode MCP 配置正确加载
- [ ] Backend 收到来自 OpenCode 的 MCP 请求
- [ ] `log_turn` / `log_intent` / `query_historical_interaction` 工具可调用

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

**目的**：验证 Git post-commit hook 正确拦截人类操作并创建 span

**前置条件**：
- Git Hook 已安装（通过 AgentLog）
- 处于 Git 仓库中

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

3. **执行人类操作并提交**
   ```bash
   # 手动修改一个文件
   echo "# Test" > test.md
   git add test.md
   git commit -m "Human intervention test"
   ```

4. **验证 Human Override Span**
   ```bash
   # 查询包含 human actor 的 trace
   TRACE_ID="<当前活跃的 trace ID>"
   curl http://localhost:7892/api/traces/$TRACE_ID/summary
   # 检查 humanSpans 计数是否增加
   ```

**预期结果**：
- [ ] Git Hook 安装成功
- [ ] 人类提交后，系统创建 actor:human 类型的 span
- [ ] span payload 包含 commit hash 和 diff 信息
- [ ] Summary API 显示 humanSpans 数量增加

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

## 🐛 问题记录

| Bug ID | 描述 | 严重程度 | 状态 |
|--------|------|----------|------|
| | | | |

---

## 📊 测试总结

| 项目 | 结果 |
|------|------|
| 测试用例总数 | 7 |
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
| `/api/traces` | POST | 创建 trace |
| `/api/traces/:id` | GET | 获取单个 trace |
| `/api/traces/:id/summary` | GET | 获取 trace 摘要 |
| `/api/traces/:id/diff` | GET | 获取 trace diff |
| `/api/spans` | POST | 创建 span |
| `/api/hooks/post-commit` | POST | post-commit 回调 |
| `/api/hooks/install` | POST | 安装 git hook |
| `/mcp/sse` | GET | SSE 实时推送 |

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
