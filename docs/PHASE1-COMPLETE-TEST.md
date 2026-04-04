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

### TC-HO-004：Agent 通过 TraceID 恢复上下文

**目的**：验证 Agent 能获取完整上下文（包含 Human Override）

**前置条件**：TC-HO-003 已完成

**测试步骤**：

1. **Agent 查询 Trace**
   ```
   使用 query_historical_interaction 工具
   参数: limit=5
   ```
   验证返回包含 TC-HO-003 的 trace

2. **Agent 获取完整详情**
   ```
   获取 traceId = <traceId> 的完整信息
   ```

3. **验证 Agent 能看到 Human Override**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/diff" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   tree = d.get('data', {}).get('spanTree', [])
   human = [s for s in tree if s.get('actorType') == 'human']
   agent = [s for s in tree if s.get('actorType') == 'agent']
   
   print('Span Tree:')
   print(f'  🤖 Agent Spans: {len(agent)}')
   print(f'  👤 Human Spans: {len(human)}')
   
   if human and agent:
       print('✅ Complete context: Agent + Human Override')
   "
   ```

4. **Agent 基于上下文继续工作**
   ```
   已知 traceId <traceId> 中人类修复了一个 bug。
   请继续完成剩余任务。
   ```

**预期结果**：
- [ ] Agent 能查询完整 Trace
- [ ] Agent 能识别 Human Override 内容
- [ ] Agent 能基于完整上下文继续

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
