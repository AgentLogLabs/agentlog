# AgentLog Phase 1 完整测试用例

> **测试版本**：v1.1.0  
> **测试日期**：2026-04-04  
> **测试范围**：Phase 1 全场景覆盖  
> **核心链路**：OpenCode ↔ OpenClaw ↔ AgentLog ↔ Git Hook  
> **前提条件**：AgentLog Backend 已启动 (`npm run dev`)

---

## 📋 测试用例总览

### 一、基础功能测试（7个用例）

| 编号 | 测试场景 | 优先级 | 预计时间 |
|------|----------|--------|----------|
| TC-001 | OpenCode 配置 AgentLog MCP | P0 | 5 min |
| TC-002 | OpenCode Agent 交互生成 Trace | P0 | 10 min |
| TC-003 | OpenClaw Agent 接收 Trace 复水 | P0 | 10 min |
| TC-004 | VS Code Trace 树状视图验证 | P0 | 5 min |
| TC-005 | Git Hook 拦截人类提交 | P1 | 5 min |
| TC-006 | SSE 实时刷新验证 | P1 | 5 min |
| TC-007 | Trace Summary/Diff API | P2 | 5 min |

### 二、Human Override 场景测试（5个用例）

| 编号 | 测试场景 | 优先级 | 预计时间 |
|------|----------|--------|----------|
| TC-HO-001 | OpenCode Agent 首次调用生成 TraceID | P0 | 5 min |
| TC-HO-002 | Agent 生成有 Bug 的代码 | P0 | 5 min |
| TC-HO-003 | 人类接管并修复代码 | P0 | 10 min |
| TC-HO-004 | Agent 通过 TraceID 恢复上下文 | P0 | 10 min |
| TC-HO-005 | 完整链路端到端验证 | P0 | 15 min |

**总计**：12 个测试用例

---

## 🎯 核心场景业务流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Phase 1 完整链路                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  【场景A：Agent 开发】                                                   │
│  ┌──────────┐      ┌──────────────┐      ┌────────────┐               │
│  │ OpenCode │ ───→ │ AgentLog MCP │ ───→ │   SQLite   │               │
│  │  Agent   │      │   Server     │      │   DB       │               │
│  └──────────┘      └──────────────┘      └────────────┘               │
│       │                  │                    │                        │
│       │ log_intent       │ POST /api/spans    │                        │
│       │ (生成TraceID)    │ (记录Span)         │                        │
│       └──────────────────┴────────────────────┘                        │
│                                    │                                     │
│                                    ▼                                     │
│  ┌──────────┐      ┌──────────────┐      ┌────────────┐               │
│  │  VS Code │ ←─── │ SSE /mcp/sse│ ←─── │ 实时推送   │               │
│  │  客户端  │      │              │      │            │               │
│  └──────────┘      └──────────────┘      └────────────┘               │
│                                                                         │
│  【场景B：Human Override】                                               │
│  ┌──────────┐      ┌──────────────┐      ┌────────────┐               │
│  │  人类    │ ───→ │ Git Hook     │ ───→ │  创建      │               │
│  │  接管    │      │ post-commit  │      │ Human Span │               │
│  └──────────┘      └──────────────┘      └────────────┘               │
│       │                                       │                        │
│       │ git commit                            │                        │
│       │ (AGENTLOG_TRACE_ID=xxx)               │                        │
│       └───────────────────────────────────────┘                        │
│                                    │                                     │
│                                    ▼                                     │
│  ┌──────────┐      ┌──────────────┐      ┌────────────┐               │
│  │ OpenClaw │ ←─── │ query_       │ ←─── │ 完整Span树 │               │
│  │  Agent   │      │ historical   │      │ (含Human) │               │
│  └──────────┘      └──────────────┘      └────────────┘               │
│       │                                                               │
│       │ Resume：基于完整上下文继续工作                                    │
│       └───────────────────────────────────────────────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 🔧 前置条件

### 1. 环境准备

```bash
# 1. 构建项目
cd /home/hobo/Projects/agentlog
pnpm build

# 2. 启动 Backend
cd packages/backend
npm run dev

# 3. 确认服务运行
curl http://localhost:7892/health
# 预期: {"status":"ok",...}
```

### 2. VS Code Extension 准备

- 安装 AgentLog VS Code 扩展
- 配置 Backend URL: `http://localhost:7892`

### 3. OpenCode MCP 配置

```bash
# 编辑 ~/.config/opencode/config.json
{
  "mcpServers": {
    "agentlog-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/agentlog/packages/backend/dist/mcp.js"],
      "env": {
        "AGENTLOG_PORT": "7892"
      }
    }
  }
}
```

---

## ✅ 一、基础功能测试

---

### TC-001：OpenCode 配置 AgentLog MCP

**目的**：验证 OpenCode 能正确配置 AgentLog MCP 并连接

**前置条件**：
- AgentLog Backend 已构建并运行
- OpenCode 已安装

**测试步骤**：

1. **确认 MCP Server 文件存在**
   ```bash
   ls /home/hobo/Projects/agentlog/packages/backend/dist/mcp.js
   ```

2. **配置 OpenCode MCP**
   
   编辑 `~/.config/opencode/config.json`：
   ```json
   {
     "mcpServers": {
       "agentlog-mcp": {
         "command": "node",
         "args": ["/absolute/path/to/agentlog/packages/backend/dist/mcp.js"],
         "env": {
           "AGENTLOG_PORT": "7892"
         }
       }
     }
   }
   ```

3. **重启 OpenCode**

4. **验证连接**
   ```bash
   # 在 OpenCode 中执行任务，观察 Backend 日志
   # 或直接调用
   curl -X POST http://localhost:7892/api/spans \
     -H "Content-Type: application/json" \
     -d '{"traceId":"test","actorType":"agent","actorName":"Test","payload":{}}'
   ```

**预期结果**：
- [ ] MCP Server 启动成功
- [ ] AgentLog 工具可调用

---

### TC-002：OpenCode Agent 交互生成 Trace

**目的**：验证 OpenCode Agent 执行任务时自动生成 Trace

**前置条件**：TC-001 已完成

**测试步骤**：

1. **OpenCode Agent 发送任务**
   ```
   请用 JavaScript 写一个 Hello World 函数并保存到 /tmp/hello.js
   ```

2. **验证 Trace 生成**
   ```bash
   curl -s http://localhost:7892/api/traces?pageSize=5 | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   traces = d.get('data', [])
   if traces:
       t = traces[-1]
       print('TraceID:', t['id'])
       print('Status:', t['status'])
   "
   ```

3. **验证 Span 创建**
   ```bash
   TRACE_ID="<traceId>"
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary"
   ```

**预期结果**：
- [ ] Trace 自动创建
- [ ] Span 包含 agent 类型记录

---

### TC-003：OpenClaw Agent 接收 Trace

**目的**：验证 OpenClaw Agent 能查询历史 Trace

**前置条件**：TC-002 已完成，有可查询的 Trace

**测试步骤**：

1. **查询历史 Trace**
   ```
   使用 query_historical_interaction 工具
   参数: limit=5
   ```

2. **获取特定 Trace**
   ```
   调用 GET /api/traces/{traceId}/summary
   ```

3. **验证上下文完整**
   - [ ] 包含完整 span 树
   - [ ] 包含工具调用记录
   - [ ] 包含时间线信息

**预期结果**：
- [ ] Agent 能查询到历史 Trace
- [ ] 数据结构完整

---

### TC-004：VS Code Trace 树状视图

**目的**：验证 VS Code 中 Trace 面板正确显示

**前置条件**：
- VS Code AgentLog 扩展已安装
- Backend 运行中

**测试步骤**：

1. **打开 Trace 视图**
   - VS Code 侧边栏 → AgentLog 图标 → Trace List

2. **执行任务生成 Trace**

3. **观察树状视图**
   - [ ] 新 Trace 出现
   - [ ] 点击展开显示 Span
   - [ ] 不同 actor 类型有区分（🤖/👤/⚙️）

4. **SSE 实时刷新**
   - 执行新任务
   - 观察是否自动出现新条目（无需手动刷新）

**预期结果**：
- [ ] Trace List 正常显示
- [ ] 实时刷新功能正常

---

### TC-005：Git Hook 拦截人类提交

**目的**：验证 Git Hook 能拦截人类提交并创建 Span

**前置条件**：Git Hook 已安装

**测试步骤**：

1. **安装 Git Hook（如未安装）**
   ```bash
   curl -X POST http://localhost:7892/api/hooks/install \
     -H "Content-Type: application/json" \
     -d '{"workspacePath":"/path/to/repo"}'
   ```

2. **人类手动修改并提交**
   ```bash
   cd /path/to/repo
   echo "# test" > test.txt
   git add . && git commit -m "Human commit"
   ```

3. **验证 Human Override Span**
   ```bash
   # 检查是否有新的 actor=human span
   curl -s "http://localhost:7892/api/traces?pageSize=1" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   print(json.dumps(d.get('data', [])[0] if d.get('data') else {}, indent=2))
   "
   ```

**预期结果**：
- [ ] Git Hook 触发
- [ ] 创建 actor=human 的 Span
- [ ] 包含 commitHash

---

### TC-006：SSE 实时刷新

**目的**：验证 SSE 推送功能

**测试步骤**：

1. **建立 SSE 连接**
   ```bash
   curl -N http://localhost:7892/mcp/sse -H "Accept: text/event-stream"
   ```

2. **触发 Span 创建**
   ```bash
   curl -X POST http://localhost:7892/api/spans \
     -H "Content-Type: application/json" \
     -d '{"traceId":"sse-test","actorType":"agent","actorName":"Test","payload":{}}'
   ```

3. **观察 SSE 推送**
   - 应该收到 `span_created` 事件

**预期结果**：
- [ ] SSE 连接正常
- [ ] 推送事件到达

---

### TC-007：Trace Summary/Diff API

**目的**：验证 T6、T7 API 功能

**测试步骤**：

1. **创建测试数据**
   ```bash
   TRACE=$(curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"API Test"}')
   TRACE_ID=$(echo $TRACE | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   
   curl -s -X POST http://localhost:7892/api/spans \
     -H "Content-Type: application/json" \
     -d "{\"traceId\":\"$TRACE_ID\",\"actorType\":\"agent\",\"actorName\":\"Test\",\"payload\":{\"seq\":1}}"
   ```

2. **测试 Summary API**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary"
   ```

3. **测试 Diff API**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/diff"
   ```

**预期结果**：
- [ ] Summary 返回完整统计
- [ ] Diff 返回完整 Span 树

---

## ✅ 二、Human Override 场景测试

---

### TC-HO-001：OpenCode Agent 首次调用生成 TraceID

**目的**：验证 TraceID 自动生成

**前置条件**：TC-001 已完成

**测试步骤**：

1. **触发 Agent 首次调用**
   ```
   请用 Python 写一个斐波那契数列函数
   ```

2. **验证 TraceID 生成**
   ```bash
   curl -s http://localhost:7892/api/traces?pageSize=1 | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   traces = d.get('data', [])
   if traces:
       t = traces[-1]
       print('✅ TraceID:', t['id'])
       print('   Status:', t['status'])
   "
   ```

**预期结果**：
- [ ] TraceID 生成（ULID 格式）
- [ ] Trace status = "running"

---

### TC-HO-002：Agent 生成有 Bug 的代码

**目的**：验证 Agent 生成代码并提交

**前置条件**：TC-HO-001 已完成

**测试步骤**：

1. **Agent 生成有 Bug 的代码**
   ```
   请写一个 Python 函数，接受数字列表返回求和结果，但故意写错（用减法代替加法）
   ```

2. **Agent 提交**
   ```
   保存到 /tmp/buggy.py 并 git commit
   ```

3. **记录 TraceID**
   ```bash
   # 从上一步获取的 traceId
   export TRACE_ID="<traceId>"
   ```

4. **验证 Span 创建**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   s = d.get('data', {}).get('statistics', {})
   print('Agent Spans:', s.get('agentSpans'))
   "
   ```

**预期结果**：
- [ ] Agent 创建了 Span
- [ ] 包含 commit 信息

---

### TC-HO-003：人类切到 VS Code 手工接管并 commit

**目的**：验证 traceId 在 OpenCode Agent → VS Code 人类操作之间保持不丢失

**关键理解**：
- **Step 1**：OpenCode Agent（装 AgentLog MCP）生成代码，创建 traceId=T-001
- **Step 2**：人类**退出 OpenCode**，切换到 **VS Code**（也装了 AgentLog 插件）手工编写代码并 commit
- **Step 3**：traceId=T-001 **继续有效**，VS Code 的 AgentLog 插件继续记录人类的操作
- 核心验证：**traceId 在跨 IDE 切换时保持不丢失**

**前置条件**：
- TC-HO-002 已完成
- VS Code 已安装 AgentLog 扩展
- Git Hook 已安装

**测试步骤**：

1. **确认 OpenCode Agent 留下的 traceId**
   ```bash
   # 从 OpenCode Agent 任务中获取 traceId
   # 或查询最新的 trace
   curl -s http://localhost:7892/api/traces?pageSize=1 | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   traces = d.get('data', [])
   if traces:
       t = traces[-1]
       print('OpenCode Agent TraceId:', t['id'])
       print('Status:', t['status'])
   "
   ```
   **记录下这个 traceId**

2. **人类切换到 VS Code**
   
   - 退出 OpenCode
   - 打开 VS Code
   - 打开同一个项目目录

3. **在 VS Code 中设置 traceId（保持连续）**
   
   在 VS Code 终端中设置环境变量：
   ```bash
   export AGENTLOG_TRACE_ID="<traceId from Step 1>"
   export AGENTLOG_GATEWAY_URL="http://localhost:7892"
   export AGENTLOG_WORKSPACE_PATH="/path/to/project"
   ```

4. **人类手工修复代码**
   
   在 VS Code 中直接编辑 `buggy.py`：
   ```python
   # 修复前（有 Bug）
   def sum_list(nums):
       return 0  # Bug!
   
   # 修复后（正确）
   def sum_list(nums):
       return sum(nums)  # Fixed!
   ```

5. **人类提交（通过 VS Code 终端）**
   
   在 VS Code 终端中执行：
   ```bash
   git add .
   git commit -m "fix: correct sum function by human in VS Code"
   ```

6. **等待异步处理**
   ```bash
   sleep 2
   ```

7. **验证 Human Override Span 创建**
   
   ```bash
   TRACE_ID="<traceId from Step 1>"
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   s = d.get('data', {}).get('statistics', {})
   print('=== After Human Override (VS Code) ===')
   print('TraceId:', '$TRACE_ID')
   print('Total Spans:', s.get('totalSpans'))
   print('Human Spans:', s.get('humanSpans'))
   print('Agent Spans:', s.get('agentSpans'))
   "
   ```

8. **验证 Human Span 详情**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/diff" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   tree = d.get('data', {}).get('spanTree', [])
   human = [s for s in tree if s.get('actorType') == 'human']
   agent = [s for s in tree if s.get('actorType') == 'agent']
   
   print()
   print('✅ Complete Context Across IDEs:')
   print(f'   🤖 Agent Spans (OpenCode): {len(agent)}')
   print(f'   👤 Human Spans (VS Code): {len(human)}')
   
   if human:
       h = human[-1]
       print()
       print('Latest Human Override:')
       print('   IDE: VS Code')
       print('   ActorName:', h.get('actorName'))
       print('   Event:', h.get('payload', {}).get('event'))
       print('   Commit:', h.get('payload', {}).get('commitHash', 'N/A')[:12])
   "
   ```

**预期结果**：
- [ ] **traceId 在跨 IDE 切换后仍然有效**（T-001 未丢失）
- [ ] VS Code 中人类 commit 被记录为 actor=human span
- [ ] span 绑定到同一个 traceId=T-001
- [ ] payload 包含 commitHash、diff 信息
- [ ] 完整的 span 树包含 OpenCode Agent spans + VS Code Human spans

**⚠️ 关键验证点**：
- 验证 VS Code AgentLog 插件支持 `AGENTLOG_TRACE_ID` 环境变量
- 验证 Git Hook 能接收并传递 traceId
- 验证 traceId 在 OpenCode → VS Code 切换后不丢失

---

### TC-HO-004：传递到 OpenClaw Agent 继续编辑（方案B：语义查询）

**目的**：验证 OpenClaw Agent 通过语义查询获取 traceId 并继续工作

**关键理解（方案B）**：
- **Step 3**：OpenClaw Agent（运行在 Gateway/云端）接收任务
- OpenClaw Agent **不依赖手动传递 traceId**，而是通过语义查询自动获取
- 用户在飞书说"继续之前的任务"时，Agent 自动调用 `query_historical_interaction` 搜索
- 最终 span 树包含：**OpenCode Agent** + **VS Code Human** + **OpenClaw Agent**

**方案B 实现流程**：

```
用户（飞书）：继续完善之前的斐波那契函数
       ↓
OpenClaw Agent 收到消息
       ↓
检测到"继续"意图 → 调用 query_historical_interaction
       ↓
Agent 分析返回结果 → 选择对应的 trace
       ↓
获取完整上下文 → 继续完成剩余任务
```

**前置条件**：
- TC-HO-003 已完成
- OpenClaw Agent 已配置 AgentLog MCP 工具
- `query_historical_interaction` 工具支持 keyword 搜索

**测试步骤**：

1. **确认当前 trace 的内容**
   ```bash
   # 先获取一个已存在的 trace
   curl -s http://localhost:7892/api/traces?pageSize=3 | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   traces = d.get('data', [])
   for t in traces[-3:]:
       print('Trace:', t['id'], '|', t['taskGoal'][:40])
   "
   ```

2. **用户在飞书发送语义消息**
   
   假设上一步获取的 trace 包含"斐波那契函数"任务，用户在飞书发送：
   ```
   @OpenClaw 继续完善之前的斐波那契函数
   ```

3. **OpenClaw Agent 执行语义搜索**
   
   OpenClaw Agent 内部调用：
   ```javascript
   // 检测到"继续"意图，自动执行搜索
   const results = await query_historical_interaction({
     keyword: "斐波那契 函数",
     source: "opencode",  // 限定来自 OpenCode 的 trace
     page_size: 5,
     include_transcript: true
   });
   
   // 如果返回多个结果，Agent 选择最相关的一个
   // 或向用户确认：找到了 X 个相关任务，选哪个？
   ```

4. **OpenClaw Agent 获取完整 trace 上下文**
   
   根据返回的 trace 信息，Agent 获取完整 span 树：
   ```bash
   TRACE_ID="<搜索返回的 traceId>"
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/diff" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   tree = d.get('data', {}).get('spanTree', [])
   
   agent = [s for s in tree if s.get('actorType') == 'agent']
   human = [s for s in tree if s.get('actorType') == 'human']
   
   print('=== Context Retrieved ===')
   print(f'🤖 OpenCode Agent Spans: {len(agent)}')
   print(f'👤 Human Override Spans: {len(human)}')
   "
   ```

5. **OpenClaw Agent 继续工作 + TelemetryProbe 记录**
   ```bash
   # OpenClaw Agent 继续完成任务
   # TelemetryProbe 自动上报新的 spans
   sleep 10
   ```

6. **验证完整 span 树（三方合并）**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/diff" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   tree = d.get('data', {}).get('spanTree', [])
   
   agent_spans = [s for s in tree if s.get('actorType') == 'agent']
   human_spans = [s for s in tree if s.get('actorType') == 'human']
   
   print('=== Complete Span Tree (3 Sources) ===')
   print(f'🤖 Agent Spans: {len(agent_spans)}')
   print(f'👤 Human Spans: {len(human_spans)}')
   print()
   
   if len(agent_spans) >= 2 and len(human_spans) >= 1:
       print('✅ Semantic search SUCCESS: Found context across OpenCode + Human + OpenClaw')
   "
   ```

**预期结果**：
- [ ] OpenClaw Agent 能通过语义搜索找到对应的 trace
- [ ] 返回结果包含 OpenCode Agent 和 Human Override 的 span
- [ ] OpenClaw Agent 能理解之前的工作上下文
- [ ] TelemetryProbe 创建新的 agent span（OpenClaw 内部活动）
- [ ] 最终 span 树包含三个来源：OpenCode Agent + VS Code Human + OpenClaw Agent

**⚠️ 关键验证点**：
- 验证 `query_historical_interaction` 支持按任务描述语义搜索
- 验证搜索结果能关联到 OpenCode Agent 和 Human Override spans
- 验证 OpenClaw Agent 能正确解读返回的历史上下文

---

### TC-HO-005：完整链路端到端验证

**目的**：从零开始完整验证 Human Override 全链路

**测试步骤**：

```bash
#!/bin/bash
# TC-HO-005 E2E 脚本

set -e
BASE_URL="http://localhost:7892"
REPO_DIR="/tmp/e2e-ho-test"

# 1. 准备环境
rm -rf $REPO_DIR
mkdir -p $REPO_DIR && cd $REPO_DIR
git init

# 2. 安装 Git Hook
curl -s -X POST "$BASE_URL/api/hooks/install" \
  -H "Content-Type: application/json" \
  -d "{\"workspacePath\":\"$REPO_DIR\"}"

# 3. Step 1: Agent 首次任务（有 Bug）
mkdir -p task1 && cd task1

cat > buggy.py << 'EOF'
def add(a, b):
    return a - b  # Bug!
EOF

# 创建 Trace
TRACE_RESP=$(curl -s -X POST "$BASE_URL/api/traces" \
  -H "Content-Type: application/json" \
  -d '{"taskGoal":"Implement add function"}')
TRACE_ID=$(echo $TRACE_RESP | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
echo "✅ Created Trace: $TRACE_ID"

# 设置环境变量
export AGENTLOG_TRACE_ID=$TRACE_ID
export AGENTLOG_GATEWAY_URL=$BASE_URL
export AGENTLOG_WORKSPACE_PATH=$REPO_DIR/task1

# Agent commit（模拟）
git add .
git commit -m "feat: add function"

sleep 1
echo "✅ Step 1: Agent committed (with bug)"

# 4. Step 2: 人类接管修复
cat > buggy.py << 'EOF'
def add(a, b):
    return a + b  # Fixed!
EOF

git add .
git commit -m "fix: correct add function"

sleep 2
echo "✅ Step 2: Human override committed"

# 5. 验证完整 Trace
echo ""
echo "=========================================="
echo "Trace Summary for $TRACE_ID"
echo "=========================================="

curl -s "$BASE_URL/api/traces/$TRACE_ID/summary" | python3 -c "
import sys, json
d = json.load(sys.stdin)
data = d.get('data', {})
s = data.get('statistics', {})

print(f'TraceID: {data.get(\"traceId\")}')
print(f'Status: {data.get(\"status\")}')
print()
print('📊 Statistics:')
print(f'   Total Spans: {s.get(\"totalSpans\")}')
print(f'   🤖 Agent:    {s.get(\"agentSpans\")}')
print(f'   👤 Human:     {s.get(\"humanSpans\")}')
print(f'   ⚙️  System:  {s.get(\"systemSpans\")}')
"

echo ""
echo "🌲 Span Tree:"
curl -s "$BASE_URL/api/traces/$TRACE_ID/diff" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tree = d.get('data', {}).get('spanTree', [])
for span in tree:
    actor = span.get('actorType', '?')
    icon = '🤖' if actor == 'agent' else '👤' if actor == 'human' else '⚙️'
    print(f'  {icon} {span.get(\"actorName\")} ({actor})')
"

# 6. 验证结论
echo ""
HUMAN_COUNT=$(curl -s "$BASE_URL/api/traces/$TRACE_ID/summary" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['statistics'].get('humanSpans', 0))")
if [ "$HUMAN_COUNT" -ge "1" ]; then
    echo "✅ TC-HO-005 PASSED: Human Override detected"
else
    echo "❌ TC-HO-005 FAILED: No human span found"
fi
```

**预期结果**：
- [ ] Trace 包含 Agent commit span
- [ ] Trace 包含 Human commit span
- [ ] Agent 能查询完整上下文
- [ ] Human Override 时间在 Agent commit 之后

---

## 🐛 问题记录

| Bug ID | 描述 | 严重程度 | 状态 |
|--------|------|----------|------|
| | | | |

---

## 📊 测试总结

| 项目 | 结果 |
|------|------|
| 测试用例总数 | 12 |
| 通过 | X |
| 失败 | X |
| 阻塞 | X |

**测试结论**：

---

## 📝 附录

### A. API 端点速查

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
| `/api/hooks/status` | GET | 查询 hook 状态 |
| `/mcp/sse` | GET | SSE 实时推送 |

### B. MCP 工具列表

| 工具名 | 读写 | 说明 |
|--------|------|------|
| `log_turn` | 写 | 逐轮记录 |
| `log_intent` | 写 | 任务汇总（生成 traceId）|
| `query_historical_interaction` | 只读 | 历史查询 |

### C. Human Override Span 结构

```json
{
  "id": "01KNBB21CQCP26K7S48NSTVQAA",
  "traceId": "<traceId>",
  "parentSpanId": null,
  "actorType": "human",
  "actorName": "git:human-override",
  "payload": {
    "event": "post-commit",
    "commitHash": "abc123...",
    "diff": "...",
    "changedFiles": ["buggy.py"]
  },
  "createdAt": "2026-04-04T..."
}
```

### D. 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `AGENTLOG_TRACE_ID` | 当前 trace ID | `01KNBB1NSXTX...` |
| `AGENTLOG_GATEWAY_URL` | AgentLog 网关地址 | `http://localhost:7892` |
| `AGENTLOG_WORKSPACE_PATH` | 工作区路径 | `/home/user/project` |
| `AGENTLOG_PORT` | 端口号 | `7892` |

### E. 相关文件

| 文件 | 说明 |
|------|------|
| `packages/backend/src/mcp.ts` | MCP Server 实现 |
| `packages/backend/src/routes/traces.ts` | Trace API |
| `packages/backend/src/routes/spans.ts` | Span API |
| `packages/backend/src/services/gitHookService.ts` | Git Hook 处理 |
| `packages/backend/src/utils/sseManager.ts` | SSE 管理 |
| `packages/vscode-extension/src/providers/traceWebviewProvider.ts` | VS Code Trace 视图 |

---

## 📝 附录D：Trace 生命周期设计决策（Phase 1 补充）

### D1. git config traceId 的作用

**问题**：git config 中的 traceId 和数据库中的 traceId 是什么关系？

**答案**：它们是**同一个东西**的两种存储形式。

| 存储位置 | 存储内容 | 作用 |
|----------|----------|------|
| **数据库 traces 表** | traceId + task_goal + status | 主要存储，所有查询都基于此 |
| **git config** | agentlog.traceId = traceId | 辅助存储，供 Git Hook 在人类直接 commit 时读取 |

**git config 写入时机**：
1. OpenCode Agent 调用 `log_intent` / `log_turn` / `create_trace` 时，MCP 自动写入
2. 人类在终端直接执行 `git commit`（不通过 MCP）时，Git Hook 从 git config 读取

**流程图**：
```
【Agent 通过 MCP 操作】
OpenCode Agent → MCP log_intent → 写入 DB traces 表
                                → 写入 .git/config agentlog.traceId

【人类直接 git commit】
人类 → git commit → Git Hook → 读取 .git/config agentlog.traceId
                                → 创建 Human span（绑定到同一 traceId）
```

---

### D2. Trace 结束判断

**问题**：如何判断一个 Trace 是否结束？

**当前方案**：主动 + 被动结合

| 判断方式 | 触发条件 | 说明 |
|----------|----------|------|
| **主动结束** | 用户/Agent 调用 `log_intent` | 任务明确完成 |
| **被动结束** | `log_intent` 时传入 `explicit_status: "completed"` | Agent 任务完成 |
| **超时结束** | trace 创建后超过 N 天无新 span | 兜底策略 |
| **永不结束** | 持续活跃的任务 | 通过 git commit 持续关联 |

---

### D3. 新 Trace 启动判断（方案C）

**问题**：一个月前的 trace 想继续，是延续还是继承？

**选择方案C**：

| 方案 | 描述 | 选择 |
|------|------|------|
| A | 在原 trace 上延续 | ❌ |
| B | 继承原 trace，但保持原 trace 不变 | ❌ |
| **C** | **继承原 trace，获取压缩语义，启动新 trace** | ✅ |

**方案C 流程**：
```
1. 用户：想继续一个月前的 trace T-old
2. Agent：调用 `query_historical_interaction({ keyword: "..." })` 语义搜索
3. Agent：找到 T-old，分析其压缩语义（task_goal + summary）
4. Agent：创建新 trace T-new，携带 parent_trace_id = T-old
5. Agent：在 T-new 上继续工作
6. 结果：
   - T-old 保持不变（历史记录）
   - T-new 继承 T-old 的上下文
   - 可追溯：T-new.parent_trace_id → T-old
```

**字段设计**：
```sql
ALTER TABLE traces ADD COLUMN parent_trace_id TEXT REFERENCES traces(id);
ALTER TABLE traces ADD COLUMN inherited_from TEXT;  -- 继承自哪个 trace
```

---

### D4. OpenClaw Agent 接管流程（修正）

**问题**：OpenClaw Agent 接管后去哪里读取？

**正确理解**：
- OpenClaw Agent **不在自己的工作目录**工作
- OpenClaw Agent 需要去**指定代码区**（用户指定的目录）操作
- 通过 `workspacePath` 参数指定目标目录

**修正后的流程**：
```
【Step 1-2】：OpenCode Agent → 人类 VS Code commit（保持不变）

【Step 3】：OpenClaw Agent 接管
  1. Agent 接收任务 + workspacePath（如 /home/user/project-abc）
  2. Agent 调 MCP 查询 trace（语义搜索或直接传 traceId）
  3. Agent 在 workspacePath 目录继续开发
  4. TelemetryProbe 记录到同一 traceId
```

---

### D5. 语义检索增强（Phase 1 补充）

**问题**：当前 keyword 搜索基于 SQL LIKE，精度有限

**建议方案**：在 MCP 侧实现语义检索

**实现方式**：
1. 使用开源 embedding 模型（如 bge-small-zh）
2. 在创建 trace 时，生成 task_goal 的 embedding 存储
3. 查询时，计算用户输入的 embedding，做向量相似度搜索

**数据结构**：
```sql
ALTER TABLE traces ADD COLUMN task_embedding TEXT;  -- task_goal 的 embedding
```

**MCP 工具新增**：
```javascript
// 语义搜索
semantic_search({
  query: "用户描述的任务",  // 如"继续之前的斐波那契函数"
  limit: 5
})
// 返回：最相关的 trace 列表（按语义相似度排序）
```

---

### D6. Trace 和 Span 关系总结

```
┌─────────────────────────────────────────────────────────────────┐
│                        Trace 生命周期                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  创建 ──────────────────────────────────────────────────────►  │
│    │                                                           │
│    ├─ MCP: log_intent / create_trace / log_turn              │
│    │      → 写入数据库 + 写入 git config                        │
│    │                                                           │
│  延续 ──────────────────────────────────────────────────────►  │
│    │                                                           │
│    ├─ Agent: 继续在同一个 trace 上创建 span                   │
│    │      → TelemetryProbe 自动上报                             │
│    │                                                           │
│    ├─ Human: git commit（不通过 MCP）                          │
│    │      → Git Hook 读取 git config → 创建 human span          │
│    │                                                           │
│  继承 ──────────────────────────────────────────────────────►  │
│    │                                                           │
│    ├─ 创建新 trace T-new                                       │
│    │      → parent_trace_id = T-old                            │
│    │      → 携带压缩语义                                        │
│    │                                                           │
│  结束 ──────────────────────────────────────────────────────►  │
│    │                                                           │
│    └─ log_intent(explicit_status="completed")                  │
│            → trace.status = "completed"                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

### D7. 当前实现状态 vs 设计决策

| 功能 | 设计决策 | 当前实现状态 |
|------|----------|-------------|
| git config traceId | 存储 traceId 供 Git Hook 读取 | ✅ 已实现 |
| Trace 结束 | log_intent 时更新 status=completed | ✅ 已实现 |
| 新 Trace 启动 | 调用 create_trace / log_intent | ✅ 已实现 |
| 继承（方案C） | parent_trace_id 字段 | ❌ 未实现 |
| 语义检索 | embedding + 向量搜索 | ❌ 未实现 |
| OpenClaw workspacePath | 去指定目录操作 | ⚠️ 待确认 |

---

## 📝 附录E：需要 Builder 补充的 Tickets（Phase 1 补充）

| Ticket | 描述 | 优先级 |
|--------|------|--------|
| T-E1 | 添加 `parent_trace_id` 字段支持 trace 继承 | P1 |
| T-E2 | 实现语义检索（embedding + 向量搜索） | P1 |
| T-E3 | 确认 OpenClaw Agent 的 workspacePath 处理逻辑 | P0 |

---

## ✅ 三、T-A & T-B 专项测试（git config traceId 透传）

### TC-T-A：MCP 创建 trace 时写入 git config

**目的**：验证 MCP (log_intent/log_turn/create_trace) 创建 trace 时同时写入 `.git/config`

**前置条件**：
- Backend 运行在 localhost:7892
- 处于 git 仓库中

**测试步骤**：

1. **确认 git 仓库状态**
   ```bash
   cd /tmp/test-repo-tc-ta
   rm -rf /tmp/test-repo-tc-ta
   mkdir -p /tmp/test-repo-tc-ta && cd /tmp/test-repo-tc-ta
   git init
   git config user.email "test@test.com"
   git config user.name "Test"
   ```

2. **调用 MCP create_trace（模拟）**
   ```bash
   # 直接调用 API 创建 trace
   TRACE=$(curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"T-A 测试任务"}')
   TRACE_ID=$(echo $TRACE | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   echo "Created Trace: $TRACE_ID"
   ```

3. **模拟 MCP 写入 git config（实际由 MCP 自动执行）**
   ```bash
   git config agentlog.traceId "$TRACE_ID"
   echo "✅ 写入 git config: agentlog.traceId=$TRACE_ID"
   ```

4. **验证 git config 写入成功**
   ```bash
   GIT_CONFIG_TRACE=$(git config agentlog.traceId)
   if [ "$GIT_CONFIG_TRACE" = "$TRACE_ID" ]; then
       echo "✅ git config 验证通过: $GIT_CONFIG_TRACE"
   else
       echo "❌ git config 验证失败"
   fi
   ```

**预期结果**：
- [ ] trace 创建成功
- [ ] git config agentlog.traceId 包含正确的 traceId

---

### TC-T-B：Git Hook 从 git config 读取 traceId

**目的**：验证 Git Hook post-commit 从 `.git/config` 读取 traceId 并创建 human span

**前置条件**：
- TC-T-A 已完成
- Git Hook 已安装

**测试步骤**：

1. **安装 Git Hook**
   ```bash
   curl -s -X POST http://localhost:7892/api/hooks/install \
     -H "Content-Type: application/json" \
     -d '{"workspacePath":"/tmp/test-repo-tc-ta"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅ 安装成功' if d.get('success') else '❌ 失败')"
   ```

2. **确认 git config 有 traceId**
   ```bash
   cd /tmp/test-repo-tc-ta
   echo $GIT_CONFIG_TRACE
   ```

3. **人类 git commit（触发 Git Hook）**
   ```bash
   echo "test content" > test.txt
   git add . && git commit -m "Human commit via Git Hook"
   sleep 2
   ```

4. **验证 human span 创建**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary" | python3 -c "
   import sys,json
   d=json.load(sys.stdin)
   s=d.get('data',{}).get('statistics',{})
   print('=== Human Override ===')
   print('Total:', s.get('totalSpans'))
   print('Human:', s.get('humanSpans'))
   if s.get('humanSpans', 0) > 0:
       print('✅ Git Hook + git config 透传成功')
   "
   ```

**预期结果**：
- [ ] Git Hook 安装成功
- [ ] 人类 git commit 后创建 human span
- [ ] span 绑定到同一个 traceId

---

### TC-T-C：关键字搜索精度

**目的**：验证 `GET /api/traces/search?keyword=xxx` 返回正确结果

**前置条件**：
- Backend 运行中

**测试步骤**：

1. **创建多个不同 task_goal 的 traces**
   ```bash
   # 创建 3 个不同任务的 trace
   for task in "斐波那契数列实现" "Git Hook 测试" "用户登录功能"; do
     curl -s -X POST http://localhost:7892/api/traces \
       -H "Content-Type: application/json" \
       -d "{\"taskGoal\":\"$task\"}" > /dev/null
   done
   ```

2. **搜索"斐波那契"**
   ```bash
   RESULT=$(curl -s "http://localhost:7892/api/traces/search?keyword=%E6%96%AF%E6%B3%A2%E9%82%A3%E5%A5%87")
   echo "$RESULT" | python3 -c "
   import sys,json
   d=json.load(sys.stdin)
   results = d.get('data', [])
   print('搜索\"斐波那契\":', len(results), '条结果')
   for r in results:
       print(' -', r['trace']['taskGoal'])
   "
   ```

3. **搜索"登录"**
   ```bash
   RESULT=$(curl -s "http://localhost:7892/api/traces/search?keyword=%E7%99%BB%E5%BD%95")
   echo "$RESULT" | python3 -c "
   import sys,json
   d=json.load(sys.stdin)
   results = d.get('data', [])
   print('搜索\"登录\":', len(results), '条结果')
   "
   ```

**预期结果**：
- [ ] 搜索"斐波那契"返回相关 trace
- [ ] 搜索"登录"返回相关 trace
- [ ] 搜索结果不包含无关 trace

---

## 📊 T1-T8 功能覆盖总表

| Ticket | 功能 | 测试用例 | 状态 |
|--------|------|---------|------|
| T1 | traces/spans 表 + ULID | TC-002, TC-007 | ✅ |
| T2 | MCP Stdio + SSE | TC-001, TC-006 | ✅ |
| T3 | POST /api/spans | TC-002, TC-T-C | ✅ |
| T4 | OpenClaw Hook 探针 | TC-HO-004 | ✅ |
| T5 | Git Hook post-commit | TC-005, TC-T-B | ✅ |
| T6 | Trace summary API | TC-007 | ✅ |
| T7 | Trace diff API | TC-007 | ✅ |
| T8 | UI SSE 实时刷新 | TC-004, TC-006 | ✅ |

**覆盖率：8/8 = 100% ✅**
