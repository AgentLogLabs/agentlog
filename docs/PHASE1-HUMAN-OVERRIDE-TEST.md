# AgentLog Phase 1 Human Override 场景测试用例

> **测试版本**：v1.1.0  
> **测试日期**：2026-04-04  
> **场景**：Agent改代码有问题 → 人类通过OpenCode外部接管修复 → Agent继续修改  
> **核心链路**：OpenCode Agent → AgentLog Trace → Human Override → Agent Resume

---

## 🎯 场景描述

### 业务流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Human Override 完整链路                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1️⃣ [OpenCode Agent]                                                │
│      Agent 生成代码 → 有 Bug                                         │
│      ↓                                                              │
│      Agent 调用 log_intent 上报，traceId=T-001 生成                   │
│      ↓                                                              │
│  2️⃣ [Git Hook]                                                     │
│      Agent commit → 创建 commitHash=C1                               │
│      ↓                                                              │
│  3️⃣ [人类接管]                                                      │
│      人类发现 Bug → 用 OpenCode 打开文件 → 手动修改代码                │
│      ↓                                                              │
│  4️⃣ [Git Hook - Human Override]                                     │
│      人类 git commit → post-commit 触发                              │
│      → 创建 span: actor=human, actorName=git:human-override          │
│      → 携带 traceId=T-001, commitHash=C2                            │
│      ↓                                                              │
│  5️⃣ [OpenClaw Agent Resume]                                         │
│      Agent 查询 traceId=T-001                                        │
│      → 获取完整 span 树（包括 human override 的 diff）                │
│      → Agent 知道人类修改了什么，继续修复                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 关键技术验证点

| 验证点 | 说明 |
|--------|------|
| **T-001: TraceID 生成** | OpenCode Agent 首次调用 log_intent 时生成全局 TraceID |
| **T-002: TraceID 透传** | Git Hook 能接收环境变量中的 TraceID |
| **T-003: Human Override Span** | 人类 commit 时创建 actor=human 的 span |
| **T-004: Span 树完整性** | trace 包含 agent spans + human spans 的完整时间线 |
| **T-005: Agent Resume** | Agent 能通过 traceId 拉取完整上下文继续工作 |

---

## 📋 测试用例

---

### TC-HO-001：OpenCode Agent 首次调用生成 TraceID

**目的**：验证 OpenCode Agent 调用 log_intent 时正确生成 TraceID

**前置条件**：
- AgentLog Backend 运行在 localhost:7892
- MCP Server 运行在 localhost:7892
- OpenCode 已配置 AgentLog MCP

**测试步骤**：

1. **启动 OpenCode + AgentLog MCP**
   ```bash
   # 确认 MCP Server 运行
   curl http://localhost:7892/health
   ```

2. **触发 Agent 首次调用 log_intent**
   
   在 OpenCode 中，向 Agent 发送任务：
   ```
   请用 Python 写一个函数，计算斐波那契数列第 N 项，要求使用递归。
   ```

3. **验证 TraceID 生成**
   ```bash
   # 列出所有 traces
   curl -s http://localhost:7892/api/traces | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   traces = d.get('data', [])
   if traces:
       t = traces[-1]
       print('✅ TraceID:', t['id'])
       print('   Status:', t['status'])
       print('   Task:', t['taskGoal'][:50])
   else:
       print('❌ No traces found')
   "
   ```

4. **验证 Span 创建**
   ```bash
   TRACE_ID="<上一步获取的 traceId>"
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary"
   ```

**预期结果**：
- [ ] log_intent 调用成功
- [ ] 生成唯一的 TraceID（ULID 格式）
- [ ] trace status = "running"
- [ ] 包含至少 1 个 agent span

**实际结果**：

---

### TC-HO-002：Agent 生成有 Bug 的代码

**目的**：验证 Agent 生成的代码存在问题，为人类接管埋点

**前置条件**：
- TC-HO-001 已完成
- 已获取 traceId

**测试步骤**：

1. **触发 Agent 生成代码**
   ```
   请写一个 Python 函数，接受一个字符串，返回反转后的字符串。例如：
   输入 "hello" 返回 "olleh"
   ```

2. **注入 Bug（模拟 Agent 错误）**
   
   故意让 Agent 生成的代码有问题，例如：
   ```python
   def reverse_string(s):
       return s[::-1]  # 正确版本
   
   # 但 Agent 写成了：
   def reverse_string(s):
       return s  # Bug: 没有反转
   ```

3. **Agent 提交代码**
   ```
   请把这个函数保存到 /tmp/test_reverse.py 并 git commit
   ```

4. **验证 commit 创建**
   ```bash
   cd /tmp
   git log --oneline -1
   ```

5. **验证 Agent Span 包含 commit 信息**
   ```bash
   TRACE_ID="<traceId>"
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   s = d.get('data', {}).get('statistics', {})
   print('Agent Spans:', s.get('agentSpans'))
   print('Human Spans:', s.get('humanSpans'))
   "
   ```

**预期结果**：
- [ ] Agent 创建了 trace
- [ ] Agent 创建了至少 1 个 span
- [ ] commit hash 被记录

**实际结果**：

---

### TC-HO-003：人类通过 OpenCode 接管并修复

**目的**：验证人类接管流程，人类修改被正确记录

**前置条件**：
- TC-HO-001, TC-HO-002 已完成
- 已安装 Git Hook（POST /api/hooks/install）

**测试步骤**：

1. **安装 Git Hook（如果未安装）**
   ```bash
   curl -X POST http://localhost:7892/api/hooks/install \
     -H "Content-Type: application/json" \
     -d '{"workspacePath":"/path/to/your/repo"}'
   ```

2. **设置环境变量让 Git Hook 知道 TraceID**
   ```bash
   export AGENTLOG_TRACE_ID="<traceId from TC-HO-001>"
   export AGENTLOG_GATEWAY_URL="http://localhost:7892"
   export AGENTLOG_WORKSPACE_PATH="/path/to/your/repo"
   ```

3. **人类手动修改代码（模拟接管）**
   ```bash
   cd /path/to/your/repo
   
   # 假设 Agent 写了错误的版本
   cat > test_reverse.py << 'EOF'
   def reverse_string(s):
       return s  # Bug 版本
   EOF
   
   # 人类修复
   cat > test_reverse.py << 'EOF'
   def reverse_string(s):
       return s[::-1]  # 修复后的正确版本
   EOF
   
   # 人类提交
   git add test_reverse.py
   git commit -m "Fix: reverse string function"
   ```

4. **验证 Human Override Span 创建**
   ```bash
   sleep 2  # 等待异步处理
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   s = d.get('data', {}).get('statistics', {})
   print('=== After Human Override ===')
   print('Total Spans:', s.get('totalSpans'))
   print('Human Spans:', s.get('humanSpans'))
   print('Agent Spans:', s.get('agentSpans'))
   "
   ```

5. **验证 Human Span 详情**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/diff" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   tree = d.get('data', {}).get('spanTree', [])
   human_spans = [s for s in tree if s.get('actorType') == 'human']
   print('Human Spans:')
   for hs in human_spans:
       print('  - ID:', hs['id'][:16])
       print('    ActorName:', hs.get('actorName'))
       print('    Payload:', hs.get('payload'))
   "
   ```

**预期结果**：
- [ ] Git Hook 触发（post-commit hook 调用）
- [ ] 创建新的 span，actorType = "human"
- [ ] actorName = "git:human-override"
- [ ] span payload 包含 commitHash, diff 信息
- [ ] span 绑定到同一个 traceId

**实际结果**：

---

### TC-HO-004：Agent 通过 TraceID 恢复上下文继续工作

**目的**：验证 Agent 能查询到人类的修改，基于完整上下文继续工作

**前置条件**：
- TC-HO-003 已完成
- Agent 能访问 AgentLog MCP 工具

**测试步骤**：

1. **Agent 查询历史 Trace**
   ```
   使用 query_historical_interaction 工具
   参数：limit=5
   ```
   
   验证返回包含 TC-HO-003 的 trace

2. **Agent 获取完整 Trace 详情**
   ```
   使用 agentlog_get_trace 工具（如果 MCP 提供）
   或调用 GET /api/traces/{traceId}/summary
   ```

3. **验证 Agent 能看到 Human Override**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   data = d.get('data', {})
   
   print('=== Trace Summary ===')
   print('TraceID:', data.get('traceId'))
   print('Status:', data.get('status'))
   print()
   print('Statistics:')
   s = data.get('statistics', {})
   print('  Total Spans:', s.get('totalSpans'))
   print('  Human Spans:', s.get('humanSpans'))
   print('  Agent Spans:', s.get('agentSpans'))
   print()
   print('Timeline:')
   t = data.get('timeline', {})
   print('  Earliest:', t.get('earliestEvent'))
   print('  Latest:', t.get('latestEvent'))
   "
   ```

4. **Agent 基于上下文继续工作**
   
   向 Agent 发送：
   ```
   traceId 是 <traceId> 的任务中，人类修复了一个 bug。
   请查看这个 trace 的完整历史，理解人类修复了什么，
   然后继续完成剩余的任务（如果有的话）。
   ```

5. **验证 Agent 能正确解读 Human Override**
   
   Agent 应该：
   - 能识别出人类的修改
   - 知道修复前后的差异
   - 基于新上下文继续工作

**预期结果**：
- [ ] Agent 能查询到包含 Human Override 的 trace
- [ ] Agent 能看到完整 span 树（agent + human）
- [ ] Agent 能识别 Human Override 的内容
- [ ] Agent 能基于完整上下文继续工作

**实际结果**：

---

### TC-HO-005：完整链路端到端验证

**目的**：从零开始，完整验证 Human Override 全链路

**测试步骤**：

1. **准备环境**
   ```bash
   cd /tmp/e2e-human-override-test
   mkdir -p test_repo && cd test_repo
   git init
   export AGENTLOG_GATEWAY_URL="http://localhost:7892"
   curl -X POST http://localhost:7892/api/hooks/install \
     -H "Content-Type: application/json" \
     -d '{"workspacePath":"/tmp/e2e-human-override-test/test_repo"}'
   ```

2. **Step 1: Agent 首次任务（有 Bug）**
   ```bash
   # 创建任务目录
   mkdir -p task1 && cd task1
   
   # 模拟 Agent 创建有 Bug 的代码
   cat > buggy_code.py << 'EOF'
   def add(a, b):
       return a - b  # Bug: 应该是 a + b
   EOF
   
   git add .
   TRACE_ID=$(curl -s http://localhost:7892/api/traces -X POST \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"Add function implementation"}' | \
     python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   
   export AGENTLOG_TRACE_ID=$TRACE_ID
   git commit -m "feat: add add function"
   
   sleep 1
   ```

3. **Step 2: 人类接管修复**
   ```bash
   cd /tmp/e2e-human-override-test/test_repo/task1
   
   # 人类修复 bug
   cat > buggy_code.py << 'EOF'
   def add(a, b):
       return a + b  # Fixed!
   EOF
   
   git add .
   git commit -m "fix: correct add function"
   
   sleep 2
   ```

4. **Step 3: 验证完整 Trace**
   ```bash
   echo "=== Trace $TRACE_ID Summary ==="
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   data = d.get('data', {})
   
   print('Trace ID:', data.get('traceId'))
   print('Status:', data.get('status'))
   print()
   
   s = data.get('statistics', {})
   print('📊 Span Statistics:')
   print('   Total:', s.get('totalSpans'))
   print('   Agent:', s.get('agentSpans'))
   print('   Human:', s.get('humanSpans'))
   print('   System:', s.get('systemSpans'))
   print()
   
   t = data.get('timeline', {})
   print('⏱️ Timeline:')
   print('   Earliest:', t.get('earliestEvent'))
   print('   Latest:', t.get('latestEvent'))
   "
   
   echo ""
   echo "=== Trace $TRACE_ID Diff ==="
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/diff" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   tree = d.get('data', {}).get('spanTree', [])
   
   print('🌲 Span Tree:')
   for span in tree:
       actor = span.get('actorType', '?')
       icon = '🤖' if actor == 'agent' else '👤' if actor == 'human' else '⚙️'
       name = span.get('actorName', '?')
       span_id = span.get('id', '?')[:12]
       print(f'   {icon} [{span_id}] {name}')
   "
   ```

**预期结果**：
- [ ] Trace 包含至少 2 个 commit（1 agent + 1 human）
- [ ] humanSpans >= 1
- [ ] agentSpans >= 1
- [ ] 时间线上 human commit 在 agent commit 之后

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
| 测试用例总数 | 5 |
| 通过 | X |
| 失败 | X |
| 阻塞 | X |

**测试结论**：

---

## 📝 附录

### A. API 端点速查

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/traces` | POST | 创建 trace |
| `/api/traces/:id/summary` | GET | 获取摘要（含 humanSpans 统计）|
| `/api/traces/:id/diff` | GET | 获取完整 span 树 |
| `/api/spans` | POST | 创建 span |
| `/api/hooks/install` | POST | 安装 Git Hook |
| `/api/hooks/post-commit` | POST | post-commit 回调 |

### B. MCP 工具

| 工具名 | 说明 |
|--------|------|
| `log_turn` | 逐轮记录 |
| `log_intent` | 任务汇总（生成 traceId）|
| `query_historical_interaction` | 历史查询 |

### C. 关键数据结构

**Human Override Span 示例**：
```json
{
  "id": "01KNBB21CQCP26K7S48NSTVQAA",
  "traceId": "<traceId>",
  "actorType": "human",
  "actorName": "git:human-override",
  "payload": {
    "event": "post-commit",
    "commitHash": "abc123...",
    "diff": "...",
    "changedFiles": ["buggy_code.py"]
  }
}
```

### D. 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `AGENTLOG_TRACE_ID` | 当前 trace ID | `01KNBB1NSXTX85C5GP4QZR289Y` |
| `AGENTLOG_GATEWAY_URL` | AgentLog 网关地址 | `http://localhost:7892` |
| `AGENTLOG_WORKSPACE_PATH` | 工作区路径 | `/home/user/project` |
