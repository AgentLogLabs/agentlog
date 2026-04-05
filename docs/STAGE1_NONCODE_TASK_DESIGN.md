# Stage 1 - 非代码任务的会话记录

## 场景目标

当 OpenClaw Agent 通过飞书等通道接收非代码任务时（如分析、写作、咨询等），仍然需要完整记录会话过程，以便后续追溯和审计。

**核心区别**：
| 场景 | 存储位置 | 说明 |
|------|----------|------|
| 有代码仓库 | `.git/agentlog/sessions.json` | 基于 Git 工作树 |
| **无代码仓库** | `~/.agentlog/sessions/` | 全局存储 |

---

## 完整流程

```
用户（飞书）: "帮我分析这个问题并写一篇文章"
    ↓
OpenClaw Agent 收到任务
    ↓
检测到 taskType = 'non-code'（非代码任务）
    ↓
创建 Trace（数据库）：
  - id = ULID
  - task_goal = 任务描述
  - task_type = 'non-code'
  - channel = 'feishu'
  - workspace_path = NULL
  - transcript_path = ~/.agentlog/transcripts/{id}.json
    ↓
实时写入 transcript 文件
    ↓
每个关键节点创建 Span（数据库）：
  - 指向 transcript 中的消息索引
    ↓
任务完成时：
  - 更新 Trace status = 'completed'
  - 计算摘要统计
```

---

## 数据库结构

### traces 表（新增字段）

```sql
-- 非代码任务的 Trace
CREATE TABLE traces (
  id              TEXT PRIMARY KEY,
  task_goal       TEXT,           -- 任务目标描述
  task_type       TEXT DEFAULT 'non-code',  -- 'code' | 'non-code'
  channel         TEXT,           -- 'feishu' | 'telegram' | etc
  workspace_path  TEXT,           -- 代码任务时有值，非代码任务时为 NULL
  status          TEXT DEFAULT 'running',
  created_at      TEXT,
  updated_at      TEXT,
  
  -- 外部存储关联
  transcript_path TEXT,           -- ~/.agentlog/transcripts/{id}.json
  transcript_size INTEGER
);
```

### spans 表

```sql
CREATE TABLE spans (
  id              TEXT PRIMARY KEY,
  trace_id        TEXT REFERENCES traces(id),
  parent_span_id  TEXT,
  actor_type      TEXT,           -- 'human' | 'agent' | 'system' | 'error'
  actor_name      TEXT,
  payload         TEXT,           -- JSON，摘要信息
  created_at      TEXT
);
```

---

## 外部 transcript 文件格式

文件位置：`~/.agentlog/transcripts/{traceId}.json`

### 完整 JSON 结构

```json
{
  "traceId": "01KXXX",
  "taskGoal": "帮我分析这个问题并写一篇文章",
  "taskType": "non-code",
  "channel": "feishu",
  "createdAt": "2026-04-05T13:44:00Z",
  "completedAt": "2026-04-05T13:50:00Z",
  
  "messages": [
    {
      "role": "human",
      "content": "帮我分析这个问题...",
      "messageId": "om_xxx",
      "timestamp": "2026-04-05T13:44:00Z"
    },
    {
      "role": "agent",
      "content": "我来分析这个问题...",
      "reasoning": "用户想要我分析...首先我需要理解问题的背景...",
      "timestamp": "2026-04-05T13:44:30Z"
    },
    {
      "role": "agent",
      "content": "基于以上分析，我给出以下结论...",
      "reasoning": "经过深入思考，我认为...",
      "toolCalls": [
        {
          "tool": "web_search",
          "input": "...",
          "output": "..."
        }
      ],
      "timestamp": "2026-04-05T13:45:00Z"
    }
  ],
  
  "metadata": {
    "model": "MiniMax-M2.7",
    "totalInputTokens": 30000,
    "totalOutputTokens": 20000,
    "durationMs": 90000,
    "status": "completed"
  }
}
```

### messages 字段说明

| 字段 | 说明 |
|------|------|
| `role` | `human` 或 `agent` |
| `content` | 对话内容 |
| `reasoning` | Agent 的推理过程（仅 agent 角色有） |
| `toolCalls` | 工具调用记录（如果有） |
| `timestamp` | 时间戳 |
| `messageId` | 来源消息 ID（仅 human 角色有） |

---

## Span 与 Transcript 的对应关系

```
数据库 spans 表：
┌────┬─────────┬───────────┬──────────────────────┐
│ id │ trace_id│ actor     │ payload (摘要)       │
├────┼─────────┼───────────┼──────────────────────┤
│ 1  │ 01KXXX  │ human     │ {msg_idx: 0}        │  ← 指向 transcript
│ 2  │ 01KXXX  │ agent     │ {msg_idx: 1}        │
│ 3  │ 01KXXX  │ agent     │ {msg_idx: 2}        │
└────┴─────────┴───────────┴──────────────────────┘
                    ↓
外部 transcript 文件：
messages[0] = 人类消息
messages[1] = Agent 第一次回复
messages[2] = Agent 第二次回复
```

**设计理由**：
- 数据库只存摘要，完整内容放外部文件
- 支持快速查询关键节点
- 支持查看完整对话细节

---

## OpenClaw Agent 调用流程

### 1. 初始化时检测任务类型

```typescript
// OpenClaw Agent 启动时
async function initTraceForNonCodeTask(message: string, channel: string) {
  // 检测是否有代码仓库
  const workspacePath = process.cwd();
  const isGitRepo = await checkGitRepo(workspacePath);
  
  if (!isGitRepo) {
    // 非代码任务，创建全局 Trace
    const traceId = generateULID();
    const transcriptPath = path.join(
      os.homedir(),
      '.agentlog',
      'transcripts',
      `${traceId}.json`
    );
    
    // 创建数据库记录
    await db.traces.create({
      id: traceId,
      task_goal: extractTaskGoal(message),
      task_type: 'non-code',
      channel: channel,
      workspace_path: null,
      status: 'running',
      transcript_path: transcriptPath,
      created_at: new Date().toISOString()
    });
    
    // 初始化 transcript 文件
    await fs.ensureFile(transcriptPath);
    await fs.writeJson(transcriptPath, {
      traceId,
      taskGoal: extractTaskGoal(message),
      taskType: 'non-code',
      channel,
      messages: [],
      createdAt: new Date().toISOString()
    });
    
    return traceId;
  }
}
```

### 2. 实时记录消息

```typescript
// 记录每条消息到 transcript 文件
async function logMessage(traceId: string, message: Message) {
  const trace = await db.traces.get(traceId);
  const transcript = await fs.readJson(trace.transcript_path);
  
  // 添加消息
  transcript.messages.push({
    role: message.role,
    content: message.content,
    reasoning: message.reasoning,
    toolCalls: message.toolCalls,
    timestamp: new Date().toISOString(),
    messageId: message.messageId
  });
  
  // 写回文件
  await fs.writeJson(trace.transcript_path, transcript, { spaces: 2 });
  
  // 同时创建 Span
  await db.spans.create({
    id: generateULID(),
    trace_id: traceId,
    actor_type: message.role,
    actor_name: message.agentName || 'unknown',
    payload: JSON.stringify({
      msg_idx: transcript.messages.length - 1,
      preview: message.content.slice(0, 100)
    }),
    created_at: new Date().toISOString()
  });
}
```

### 3. 任务完成

```typescript
// 任务完成时
async function completeTrace(traceId: string, status: 'completed' | 'failed') {
  const trace = await db.traces.get(traceId);
  const transcript = await fs.readJson(trace.transcript_path);
  
  // 更新 transcript metadata
  transcript.metadata = {
    ...transcript.metadata,
    status,
    completedAt: new Date().toISOString()
  };
  await fs.writeJson(trace.transcript_path, transcript);
  
  // 更新数据库
  await db.traces.update(traceId, {
    status,
    updated_at: new Date().toISOString()
  });
}
```

---

## 与代码任务的主要区别

| 方面 | 代码任务 | 非代码任务 |
|------|----------|-----------|
| 存储位置 | `.git/agentlog/` | `~/.agentlog/sessions/` |
| Git Hook | 绑定 commit | 无（任务完成后直接结束） |
| Trace 续接 | 通过 Git config | 不适用 |
| 完成标志 | git commit | 人类确认或 Agent 标记完成 |
| transcript | 无需外部文件 | 需要外部文件存储完整对话 |

---

## 技术实现清单

| Ticket | 功能 | 说明 |
|--------|------|------|
| S1-N1 | 非代码 Trace 创建 | 在无 Git 仓库时创建全局 Trace |
| S1-N2 | transcript 文件管理 | 创建、写入、读取 transcript JSON |
| S1-N3 | Span 与 transcript 关联 | Span.payload 指向 transcript 消息索引 |
| S1-N4 | 非代码任务完成 | 更新 Trace status，完成 transcript |
| S1-N5 | OpenClaw 插件集成 | 通过 MCP/Skill 调用 AgentLog |

---

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 存储方式 | 数据库 + 外部文件 | 平衡查询性能与完整记录 |
| transcript 格式 | JSON 文件 | 结构化、可读性好 |
| Span 内容 | 摘要 | 完整内容在 transcript 中 |
| 完成标志 | 人类确认或 Agent 标记 | 非代码任务无 Git commit |

---

## Agent 间交接时 Trace 传递

### 场景描述

当一个 Agent 把任务转交给另一个 Agent 时（如 Strategist → Builder），交接过程需要携带 Trace ID，确保所有协作过程都在同一个 Trace 中记录。

### 场景示例

```
用户 → Strategist: "做一个用户登录功能"
           ↓
        Strategist 分析后，转给 Builder: "请实现用户登录功能。Trace: 01KXXX"
           ↓
        Builder 接收任务，自动继承 Trace 01KXXX
           ↓
        最终 Trace 包含: Strategist 分析 + Builder 实现
```

### 传递方式

| 交接类型 | Trace 传递方式 |
|----------|---------------|
| Agent 间交接（Strategist → Builder） | **消息中携带 Trace ID** |
| OpenCode 接管（Handoff） | 通过 `sessions.json` 文件 |
| 非代码任务 | 通过 transcript 文件路径 |

### 实现方式

#### 1. 消息中携带 Trace ID

```
飞书消息：
"请实现用户登录功能。Trace: 01KXXX"
    或
"请实现用户登录功能。"
    + Trace ID 通过上下文隐式传递
```

#### 2. Builder 接收时的处理

```typescript
// Builder 收到消息后
async function handleBuilderTask(message: string, originalTraceId?: string) {
  // 方式1: 直接从消息中提取 Trace ID
  const traceIdMatch = message.match(/Trace[:\s]+([A-Z0-9]+)/i);
  
  if (traceIdMatch) {
    // 有 Trace ID，继承它
    const traceId = traceIdMatch[1];
    await joinTrace(traceId);  // 写入 .git/config 或环境变量
  } else if (originalTraceId) {
    // 方式2: 从父任务继承（如果是嵌套任务）
    const traceId = originalTraceId;
    await joinTrace(traceId);
  } else {
    // 没有 Trace ID，创建新 Trace
    const traceId = await createNewTrace();
  }
}
```

#### 3. Trace 继承后的完整记录

```
┌──────────────────────────────────────────────────────────────┐
│                    Trace A-999                              │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Span #1: Strategist 分析任务                         │  │
│  │ Span #2: Strategist 规划方案                        │  │
│  │ Span #3: Strategist 转发给 Builder                   │  │
│  │                                                      │  │
│  │         ↓ 消息携带 Trace ID: A-999                  │  │
│  │                                                      │  │
│  │ Span #4: Builder 接收任务（继承 A-999）              │  │
│  │ Span #5: Builder 实现登录功能                        │  │
│  │ Span #6: Builder 提交 git commit                    │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 三种 Trace 传递方式对比

| 场景 | 传递方式 | 存储位置 |
|------|----------|----------|
| Agent 间交接（飞书消息） | 消息携带 Trace ID | 消息内容 |
| OpenCode 接管（代码任务） | `sessions.json` 文件 | `.git/agentlog/` |
| 非代码任务 | transcript 文件路径 | `~/.agentlog/transcripts/` |

### 关键设计原则

1. **Trace ID 显式携带**：交接时在消息中明确标注 Trace ID
2. **接收方写入配置**：收到后写入 `.git/config` 或环境变量
3. **所有 Span 归属同一 Trace**：确保完整追溯
4. **跨 Agent 协作透明**：最终 Trace 包含所有 Agent 的工作过程

---

*文档创建时间：2026-04-05*
*最后更新：2026-04-05 14:30*
