# OpenClaw Agent Log E2E 测试用例

> 更新时间：2026-04-06
> 版本：v1.0
> Skill：openclaw-agent-log

---

## 测试环境

| 组件 | 要求 |
|------|------|
| Backend | http://localhost:7892 |
| Git 仓库 | 已初始化 |
| Node.js | v22+ |
| pnpm | 最新版 |

---

## 前置条件

1. Backend 已启动：`curl http://localhost:7892/health` 返回 200
2. Git 仓库已初始化
3. 已安装 Skill：`skills/openclaw-agent-log/`

---

## 测试用例

### TC-OAL-001：Backend 健康检查

**目的**：验证 Backend 服务正常运行

**测试步骤**：
```bash
curl -s http://localhost:7892/health
```

**预期结果**：
```json
{
  "status": "ok",
  "version": "1.1.1",
  "timestamp": "..."
}
```

**优先级**：P0

---

### TC-OAL-002：创建 Trace

**目的**：验证 Trace 创建功能正常

**测试步骤**：
```bash
curl -X POST http://localhost:7892/api/traces \
  -H "Content-Type: application/json" \
  -d '{
    "source": "openclaw:auditor",
    "workspacePath": "/test/workspace",
    "taskGoal": "E2E Test Trace"
  }'
```

**预期结果**：
- 返回 `{"success": true, "data": {...}}`
- `data.id` 为 ULID 格式（如 `01KNH...`）
- `data.status` 为 `running`

**优先级**：P0

---

### TC-OAL-003：创建 Span（人类交互）

**目的**：验证 Span 创建功能正常

**前置条件**：已创建 Trace

**测试步骤**：
```bash
TRACE_ID=$(curl -s -X POST http://localhost:7892/api/traces \
  -H "Content-Type: application/json" \
  -d '{"source": "openclaw:test", "workspacePath": "/test", "taskGoal": "Test"}' | \
  grep -o '"id":"[^"]*"' | cut -d'"' -f4)

curl -X POST http://localhost:7892/api/spans \
  -H "Content-Type: application/json" \
  -d "{
    \"traceId\": \"$TRACE_ID\",
    \"actorType\": \"human\",
    \"actorName\": \"auditor\",
    \"content\": \"Test span from human\"
  }"
```

**预期结果**：
- 返回 `{"success": true, "data": {...}}`
- `data.traceId` 与请求一致
- `data.actorType` 为 `human`

**优先级**：P0

---

### TC-OAL-004：创建 Span（Agent 推理）

**目的**：验证 Agent reasoning 过程记录

**测试步骤**：
```bash
TRACE_ID=$(curl -s -X POST http://localhost:7892/api/traces \
  -H "Content-Type: application/json" \
  -d '{"source": "openclaw:builder", "workspacePath": "/test", "taskGoal": "Build feature"}' | \
  grep -o '"id":"[^"]*"' | cut -d'"' -f4)

curl -X POST http://localhost:7892/api/spans \
  -H "Content-Type: application/json" \
  -d "{
    \"traceId\": \"$TRACE_ID\",
    \"actorType\": \"agent\",
    \"actorName\": \"builder\",
    \"payload\": {
      \"reasoning\": \"思考过程...需要检查数据库连接...\",
      \"model\": \"deepseek-r1\"
    }
  }"
```

**预期结果**：
- `payload.reasoning` 字段正确保存

**优先级**：P1

---

### TC-OAL-005：创建 Span（工具调用）

**目的**：验证工具调用记录

**测试步骤**：
```bash
TRACE_ID=$(curl -s -X POST http://localhost:7892/api/traces \
  -H "Content-Type: application/json" \
  -d '{"source": "openclaw:test", "workspacePath": "/test", "taskGoal": "Tool test"}' | \
  grep -o '"id":"[^"]*"' | cut -d'"' -f4)

curl -X POST http://localhost:7892/api/spans \
  -H "Content-Type: application/json" \
  -d "{
    \"traceId\": \"$TRACE_ID\",
    \"actorType\": \"agent\",
    \"actorName\": \"builder\",
    \"payload\": {
      \"toolCall\": {
        \"name\": \"bash\",
        \"args\": \"ls -la\",
        \"result\": \"file1.txt\"
      }
    }
  }"
```

**预期结果**：
- `payload.toolCall` 正确保存

**优先级**：P1

---

### TC-OAL-006：更新 Trace 状态

**目的**：验证 Trace 状态更新

**测试步骤**：
```bash
TRACE_ID=$(curl -s -X POST http://localhost:7892/api/traces \
  -H "Content-Type: application/json" \
  -d '{"source": "openclaw:test", "workspacePath": "/test", "taskGoal": "Status test"}' | \
  grep -o '"id":"[^"]*"' | cut -d'"' -f4)

curl -X PATCH "http://localhost:7892/api/traces/$TRACE_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

**预期结果**：
- `data.status` 变为 `completed`

**优先级**：P0

---

### TC-OAL-007：按 source 查询 Traces

**目的**：验证 source 标识推断和查询

**测试步骤**：
```bash
# 创建多个不同 source 的 traces
curl -X POST http://localhost:7892/api/traces \
  -H "Content-Type: application/json" \
  -d '{"source": "openclaw:architect", "workspacePath": "/test", "taskGoal": "Architect task"}'

curl -X POST http://localhost:7892/api/traces \
  -H "Content-Type: application/json" \
  -d '{"source": "openclaw:builder", "workspacePath": "/test", "taskGoal": "Builder task"}'

# 查询
curl -s "http://localhost:7892/api/traces?source=openclaw:architect"
```

**预期结果**：
- 只返回 `source=openclaw:architect` 的 traces

**优先级**：P0

---

### TC-OAL-008：Trace 完整生命周期

**目的**：验证从创建到完成的完整流程

**测试步骤**：
```bash
# 1. 创建 Trace
TRACE_ID=$(curl -s -X POST http://localhost:7892/api/traces \
  -H "Content-Type: application/json" \
  -d '{"source": "openclaw:lifecycle-test", "workspacePath": "/test", "taskGoal": "Full lifecycle test"}' | \
  grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "Created Trace: $TRACE_ID"

# 2. 创建 Span（人类）
curl -X POST http://localhost:7892/api/spans \
  -H "Content-Type: application/json" \
  -d "{
    \"traceId\": \"$TRACE_ID\",
    \"actorType\": \"human\",
    \"actorName\": \"auditor\",
    \"content\": \"Started task\"
  }"

# 3. 创建 Span（Agent 推理）
curl -X POST http://localhost:7892/api/spans \
  -H "Content-Type: application/json" \
  -d "{
    \"traceId\": \"$TRACE_ID\",
    \"actorType\": \"agent\",
    \"actorName\": \"builder\",
    \"payload\": {\"reasoning\": \"Analyzing requirements...\"}
  }"

# 4. 创建 Span（工具调用）
curl -X POST http://localhost:7892/api/spans \
  -H "Content-Type: application/json" \
  -d "{
    \"traceId\": \"$TRACE_ID\",
    \"actorType\": \"agent\",
    \"actorName\": \"builder\",
    \"payload\": {\"toolCall\": {\"name\": \"bash\", \"args\": \"pwd\"}}
  }"

# 5. 完成 Trace
curl -X PATCH "http://localhost:7892/api/traces/$TRACE_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'

# 6. 验证结果
echo -e "\n=== Final Trace ==="
curl -s "http://localhost:7892/api/traces/$TRACE_ID"
```

**预期结果**：
- Trace 包含 3 个 Spans
- 最后一个 Span 是工具调用
- Trace 状态为 `completed`

**优先级**：P0

---

### TC-OAL-009：8 个 Agent Source 标识验证

**目的**：验证所有 Agent 的 source 标识格式

**测试步骤**：
```bash
AGENTS=("architect" "auditor" "builder" "growth-hacker" "strategist" "engineer" "market-person" "存证员")

for agent in "${AGENTS[@]}"; do
  SOURCE="openclaw:$agent"
  RESULT=$(curl -s -X POST http://localhost:7892/api/traces \
    -H "Content-Type: application/json" \
    -d "{\"source\": \"$SOURCE\", \"workspacePath\": \"/test/$agent\", \"taskGoal\": \"Test $agent\"}")
  
  if echo "$RESULT" | grep -q '"success":true'; then
    echo "✅ $SOURCE"
  else
    echo "❌ $SOURCE: $RESULT"
  fi
done
```

**预期结果**：
- 所有 8 个 Agent 都创建成功

**优先级**：P0

---

### TC-OAL-010：sessions.json 管理（Trace Handoff）

**目的**：验证 pending/active sessions 管理

**前置条件**：
- 已安装 `sessionsJsonService.ts`
- Git 仓库已初始化

**测试步骤**：
```bash
# 1. 创建 pending trace
curl -X POST http://localhost:7892/api/traces/pending \
  -H "Content-Type: application/json" \
  -d '{
    "traceId": "TEST-001",
    "targetAgent": "builder",
    "workspacePath": "/test"
  }'

# 2. 验证 sessions.json 写入
cat .git/agentlog/sessions.json 2>/dev/null || echo "File not found (expected in real test)"

# 3. Claim trace
curl -X POST http://localhost:7892/api/traces/claim \
  -H "Content-Type: application/json" \
  -d '{
    "traceId": "TEST-001",
    "agentType": "builder"
  }'
```

**预期结果**：
- pending trace 创建成功
- sessions.json 正确更新

**优先级**：P1

---

## 测试报告模板

```markdown
## 测试执行报告

**日期**：[YYYY-MM-DD]
**执行人**：[Agent Name]
**环境**：Backend v1.1.1

### 执行结果

| 测试用例 | 状态 | 备注 |
|----------|------|------|
| TC-OAL-001 | ✅/❌ | |
| TC-OAL-002 | ✅/❌ | |
| ... | ... | |

### 问题记录

- [ ] 问题 1
- [ ] 问题 2

### 总结

- 通过：X/Y
- 失败：X/Y
```

---

## 附录：API 参考

### POST /api/traces

创建新 Trace。

```json
{
  "source": "openclaw:<agent-name>",
  "workspacePath": "/path/to/workspace",
  "taskGoal": "任务目标描述"
}
```

### POST /api/spans

创建 Span。

```json
{
  "traceId": "01KNH...",
  "actorType": "human|agent|hook",
  "actorName": "auditor",
  "content": "内容描述",
  "payload": {
    "reasoning": "推理过程",
    "toolCall": { "name": "...", "args": "...", "result": "..." }
  }
}
```

### PATCH /api/traces/:id

更新 Trace。

```json
{
  "status": "running|completed|pending_handoff|in_progress"
}
```

### GET /api/traces?source=<source>

按 source 查询 Traces。
