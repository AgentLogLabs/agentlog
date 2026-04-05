# Trace 生命周期管理方案

**版本**：v1.0
**日期**：2026-04-04
**状态**：待实现

---

## 一、Trace 状态定义

```sql
CREATE TABLE traces (
  id                  TEXT PRIMARY KEY,
  task_goal           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'running',  -- running | paused | completed | failed
  parent_trace_id     TEXT,                              -- Fork 关联
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
```

**状态说明**：

| 状态 | 含义 | 触发条件 |
|------|------|---------|
| `running` | 任务进行中 | 默认初始状态 |
| `paused` | 任务暂停 | 用户主动暂停或超时 |
| `completed` | 任务完成 | log_intent 被调用 |
| `failed` | 任务失败 | Agent 执行出错 |

---

## 二、Trace 结束判断

### 2.1 结束时机

**自动结束**：
- 调用 `log_intent` 时 → 设置 `status: 'completed'`
- Agent 报错退出 → 设置 `status: 'failed'`

**手动结束**：
- 用户说"任务完成"、"结束" → 设置 `status: 'completed'`
- 用户说"放弃"、"取消" → 设置 `status: 'failed'`

### 2.2 实现逻辑

```javascript
// MCP log_intent 工具
async function handleLogIntent(args) {
  const { task, trace_id } = args;
  
  if (trace_id) {
    // 更新已有 trace
    updateTrace(trace_id, { 
      status: 'completed',
      taskGoal: task 
    });
  } else {
    // 创建新 trace
    const trace = createTrace({ taskGoal: task });
    return { trace_id: trace.id };
  }
}
```

### 2.3 超时机制

```javascript
// 每小时检查一次
async function checkTimeout() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  
  // 将 24 小时无活动的 running trace 标记为 paused
  db.prepare(`
    UPDATE traces 
    SET status = 'paused', updated_at = ?
    WHERE status = 'running' 
    AND updated_at < ?
  `).run(new Date().toISOString(), oneDayAgo);
}
```

---

## 三、新 Trace 判断逻辑

### 3.1 判断规则

| 条件 | 行为 |
|------|------|
| 没有 `TRACE_ID` 环境变量 | → 创建新 trace |
| 有 `TRACE_ID` 但 trace 不存在 | → 创建新 trace |
| 有 `TRACE_ID` 且 trace.status = 'running' | → 继续用同一个 trace |
| 有 `TRACE_ID` 且 trace.status = 'completed/failed' | → Fork 新 trace（继承原 trace） |
| 用户说"开始新任务" | → Fork 新 trace |

### 3.2 实现逻辑

```javascript
async function ensureTrace(traceId?: string) {
  // 1. 没有 traceId → 创建新 trace
  if (!traceId) {
    return createTrace();
  }
  
  // 2. 检查 trace 是否存在且 running
  const existing = getTraceById(traceId);
  
  if (!existing) {
    // 不存在 → 创建新 trace
    return createTrace();
  }
  
  if (existing.status === 'running') {
    // 3. 正在运行 → 继续用
    return existing;
  }
  
  // 4. 已结束 → Fork 新 trace
  return forkTrace({
    parentTraceId: existing.id,
    taskGoal: `继续: ${existing.task_goal}`
  });
}
```

---

## 四、Fork 机制

### 4.1 Fork 场景

- 原 trace 已 `completed/failed`，用户继续任务
- 用户说"基于 XXX 继续"
- 需要追踪任务间的继承关系

### 4.2 Fork 实现

```javascript
// Fork 新 trace
function forkTrace({ parentTraceId, taskGoal }) {
  const parent = getTraceById(parentTraceId);
  
  // 创建新 trace
  const child = createTrace({
    taskGoal: taskGoal || `继续: ${parent.task_goal}`,
    parentTraceId: parentTraceId
  });
  
  // 创建 fork 事件 span
  createSpan({
    traceId: child.id,
    actorType: 'system',
    actorName: 'system:fork',
    payload: {
      event: 'trace_fork',
      parent_trace_id: parentTraceId,
      parent_task_goal: parent.task_goal,
      fork_reason: '用户继续任务'
    }
  });
  
  return child;
}
```

### 4.3 Fork 链条查询

```javascript
// 获取完整 fork 链条
function getForkChain(traceId) {
  const chain = [];
  let current = getTraceById(traceId);
  
  while (current) {
    chain.unshift(current);
    if (current.parent_trace_id) {
      current = getTraceById(current.parent_trace_id);
    } else {
      break;
    }
  }
  
  return chain;
}
```

---

## 五、MCP 工具设计

### 5.1 新增/修改工具

| 工具名 | 用途 |
|--------|------|
| `create_trace` | 创建新 trace（已有，支持 fork） |
| `log_turn` | 追加 span 到当前 trace |
| `log_intent` | 结束当前 trace |
| `query_traces` | 查询 trace 列表（支持 fork 链条） |
| `get_trace_summary` | 获取 trace 摘要 |

### 5.2 create_trace 参数

```javascript
{
  name: "create_trace",
  description: "创建或 fork 一个 trace",
  inputSchema: {
    type: "object",
    properties: {
      task_goal: {
        type: "string",
        description: "任务描述"
      },
      parent_trace_id: {
        type: "string", 
        description: "父 trace ID（可选，不填则创建全新 trace）"
      }
    }
  }
}
```

### 5.3 query_traces 参数

```javascript
{
  name: "query_traces",
  description: "查询 trace 列表",
  inputSchema: {
    type: "object",
    properties: {
      workspace_path: {
        type: "string",
        description: "工作区路径（可选）"
      },
      status: {
        type: "string",
        enum: ["running", "paused", "completed", "failed"],
        description: "按状态过滤"
      },
      include_fork_chain: {
        type: "boolean",
        description: "是否返回 fork 链条"
      }
    }
  }
}
```

---

## 六、使用流程

### 6.1 首次任务

```
用户：帮我写一个斐波那契函数
       ↓
Agent 调用 create_trace(task_goal="斐波那契函数")
       ↓
返回 trace_id=T-001，状态=running
       ↓
后续 log_turn 追加 spans
```

### 6.2 继续已有任务

```
用户：继续之前的任务
       ↓
Agent 检查环境变量 TRACE_ID=T-001
       ↓
调用 ensureTrace(T-001)
       ↓
T-001 状态=running → 继续用 T-001
       ↓
log_turn 追加 spans 到 T-001
```

### 6.3 Fork 场景（任务已结束）

```
用户：继续之前的斐波那契任务
       ↓
Agent 检查 TRACE_ID=T-001
       ↓
T-001 状态=completed → 调用 forkTrace(T-001)
       ↓
返回 trace_id=T-002，parent_trace_id=T-001
       ↓
log_turn 追加 spans 到 T-002
```

### 6.4 超时恢复

```
背景：T-001 任务 running，但 24 小时无活动

系统：凌晨检查超时任务
       ↓
UPDATE traces SET status='paused' WHERE updated_at < 24h ago
       ↓

用户：继续任务
       ↓
Agent 发现 T-001 status='paused'
       ↓
询问用户："这个任务已暂停，是否继续？"
       ↓
用户确认 → forkTrace(T-001) 创建 T-002
```

---

## 七、API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/traces` | POST | 创建/fork trace |
| `/api/traces` | GET | 查询 trace 列表 |
| `/api/traces/:id` | GET | 获取单个 trace |
| `/api/traces/:id/spans` | GET | 获取 trace 下所有 span |
| `/api/traces/:id/fork` | POST | Fork trace（显式） |

---

## 八、测试用例

### TC-LC-001：首次任务创建 trace
### TC-LC-002：继续 running trace
### TC-LC-003：completed trace 自动 fork
### TC-LC-004：手动 fork 新 trace
### TC-LC-005：超时自动标记 paused
### TC-LC-006：fork 链条查询

---

**文档状态**：待 Builder 实现
