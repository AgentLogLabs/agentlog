# AgentLog MCP 数据记录质量评估报告

**评估日期**: 2026-04-02  
**评估者**: Architect（架构设计师）  
**MCP Server 状态**: ✅ 运行正常（uptime: 343s）

---

## 一、现状数据

### 1.1 会话统计

```json
{
  "total": 6,
  "boundToCommit": 0,
  "unbound": 6,
  "byProvider": { "minimax": 6 },
  "bySource": { "mcp-tool-call": 6 },
  "avgDurationMs": 0
}
```

### 1.2 记录内容分析

| Session ID | Agent | 内容 | reasoning 字段 | tool 记录 |
|------------|-------|------|----------------|-----------|
| YBEoukSDTmrToiOCwaNp7 | Architect | 确认存证通知 | ❌ 未填 | ❌ 无 |
| EgM0chIrZxZlzvR59Ca_v | Strategist | 确认通知 + 战略摘要 | ❌ 未填 | ❌ 无 |
| TRRg-aRigPhY25K-LIHNI | Auditor | 确认通知 | ❌ 未填 | ❌ 无 |
| gSWP0jAU9bmYuQvq1oIDz | Evangelist | 确认通知 | ❌ 未填 | ❌ 无 |
| m33RCuVfHniRbsXAqRH61 | Sentinel | 情报报告 | ❌ 未填 | ❌ 无 |
| 2_tF3usqwCY1Gyv0ztBVn | Growth Hacker | 任务指令 | ❌ 未填 | ❌ 无 |

---

## 二、问题诊断

### 2.1 核心问题

| 问题 | 严重程度 | 说明 |
|------|----------|------|
| **仅记录确认消息** | 🔴 严重 | 6 条记录全是"确认收到通知"，非实际工作内容 |
| **reasoning 未填充** | 🔴 严重 | 0 条记录包含推理过程 |
| **tool 调用未记录** | 🔴 严重 | 0 条记录包含工具调用 |
| **session 未绑定 Commit** | 🟡 中等 | 0/6 条绑定 Git Commit |
| **durationMs 全为 0** | 🟡 中等 | 无实际耗时统计 |

### 2.2 根因分析

```
┌─────────────────────────────────────────────────────────────────┐
│                    当前存证流程（问题流程）                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Agent 收到消息                                                  │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────┐                                                │
│  │  手动调用    │  ← 问题：需要主动调用 mcporter                 │
│  │  mcporter   │     繁琐，Agent 容易忘记                        │
│  └─────────────┘                                                │
│       │                                                          │
│       ▼                                                          │
│  仅记录当前消息                                                   │
│       │                                                          │
│       ▼                                                          │
│  丢失：推理过程、工具调用、中间步骤                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**问题本质**：
1. **mcporter 是手动 CLI 工具**，不是自动拦截机制
2. Agent 需要**主动记得调用**，且需要传 session_id
3. **推理 content（`<think>`）未捕获**
4. **工具调用（bash/read/edit 等）未记录**

---

## 三、解决方案设计

### 方案 1：OpenClaw Skill 自动存证（推荐）

**原理**：封装为 Skill，OpenClaw 自动调用

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw Agent Lifecycle                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Agent 收到消息                                                  │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────────────┐                │
│  │  OpenClaw AgentLog Skill (自动触发)        │                │
│  │  - onMessage: log_turn(role='user')        │                │
│  │  - onThinking: log_turn(reasoning=...)     │ ← 新增        │
│  │  - onToolCall: log_turn(role='tool')       │ ← 新增        │
│  │  - onResponse: log_turn(role='assistant')   │                │
│  │  - onEnd: log_intent()                      │ ← 新增        │
│  └─────────────────────────────────────────────┘                │
│       │                                                          │
│       ▼                                                          │
│  AgentLog MCP Server                                             │
│       │                                                          │
│       ▼                                                          │
│  SQLite 完整记录（reasoning + tool + content）                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Skill 设计**：

```typescript
// agentlog-skill/SKILL.md

# AgentLog Auto-Logging Skill

## 自动存证机制

### 触发时机
- `onAgentMessage`: 用户消息到达时 → `log_turn(role='user')`
- `onAgentThinking`: Agent 推理时 → `log_turn(reasoning='...')`  ← 关键
- `onToolExecution`: 工具执行时 → `log_turn(role='tool')`  ← 关键
- `onAgentResponse`: Agent 回复时 → `log_turn(role='assistant')`
- `onSessionEnd`: 会话结束时 → `log_intent()`

### 数据结构
```json
{
  "session_id": "auto-generated-uuid",
  "role": "assistant",
  "reasoning": "用户问的是 Trae IDE 支持，我需要设计 MCP 集成方案...",
  "content": "以下是技术方案...",
  "tool_name": "read",
  "tool_input": "path=~/Projects/agentlog/package.json"
}
```

### 与 OpenClaw 的集成点
- 利用 OpenClaw 的 `skills` hook
- 无需修改 OpenClaw 核心代码
- 通过 skill 配置自动触发
```

### 优点
- ✅ 自动拦截，无需手动调用
- ✅ 捕获推理过程（reasoning）
- ✅ 捕获工具调用
- ✅ 通过 skill 机制，非侵入式

### 缺点
- ⚠️ 需要 OpenClaw 支持 skill hooks（需确认）
- ⚠️ 需要测试验证

---

### 方案 2：MCP Server 中间件模式

**原理**：在 MCP Server 层添加拦截中间件

```typescript
// mcp-logging-middleware.ts

interface LoggingMiddleware {
  // 拦截所有工具调用
  onToolCall: (tool: string, input: any) => void;
  // 拦截所有消息
  onMessage: (role: string, content: string) => void;
  // 拦截推理内容
  onReasoning: (reasoning: string) => void;
}

// 使用方式：在 MCP Server 入口包装
const server = new Server({
  onCall: (tool, input) => {
    middleware.onToolCall(tool, input);
    return originalHandler(tool, input);
  }
});
```

**优点**：
- ✅ MCP Server 层面拦截，通用性强
- ✅ 可捕获所有通过 MCP 的调用

**缺点**：
- ⚠️ 需要修改 AgentLog MCP Server
- ⚠️ 无法捕获非 MCP 调用的内容

---

### 方案 3：OpenClaw Core 原生集成（长期）

**原理**：OpenClaw Core 直接集成 AgentLog 存证

```yaml
# openclaw.config.yml
agentlog:
  enabled: true
  server: localhost:7892
  autoLogging:
    reasoning: true      # 自动捕获推理过程
    toolCalls: true      # 自动捕获工具调用
    messages: true       # 自动捕获消息
  sessionBinding:
    autoBindCommit: true # 自动绑定 Git Commit
```

**优点**：
- ✅ 最完整的自动存证
- ✅ 用户无感知

**缺点**：
- ⚠️ 需要 OpenClaw 团队支持
- ⚠️ 改动较大

---

## 四、推荐方案与实施路径

### 4.1 立即可行（方案 1 简化版）

**目标**：先让 reasoning 和 tool 调用被记录

```bash
# 创建 agentlog-auto-skill
mkdir -p ~/.openclaw/skills/agentlog-auto/
```

**Skill 实现伪代码**：
```javascript
// skill.js
module.exports = {
  name: 'agentlog-auto',
  
  // 当 Agent 产生推理时
  onThinking: async ({ agent, reasoning, model }) => {
    await mcporter.call('agentlog.log_turn', {
      session_id: getOrCreateSession(agent),
      role: 'assistant',
      reasoning: reasoning,  // 关键：捕获推理
      content: '',          // reasoning 已包含在 reasoning 字段
      model: model
    });
  },
  
  // 当 Agent 调用工具时
  onToolCall: async ({ agent, tool, input }) => {
    await mcporter.call('agentlog.log_turn', {
      session_id: getOrCreateSession(agent),
      role: 'tool',
      tool_name: tool,
      tool_input: JSON.stringify(input).substring(0, 500),
      content: `调用工具: ${tool}`
    });
  },
  
  // 当会话结束时
  onSessionEnd: async ({ agent, session_id }) => {
    await mcporter.call('agentlog.log_intent', {
      session_id: session_id,
      task: 'Agent 工作会话',
      model: 'MiniMax-M2.7'
    });
  }
};
```

---

### 4.2 工作量估算

| 阶段 | 任务 | 工时 | 依赖 |
|------|------|------|------|
| **Phase 1** | OpenClaw Skill 自动存证核心实现 | 8h | OpenClaw skill hooks |
| **Phase 2** | reasoning 捕获逻辑 | 4h | Phase 1 |
| **Phase 3** | tool call 捕获逻辑 | 4h | Phase 1 |
| **Phase 4** | session 与 Git Commit 绑定 | 6h | Phase 1 |
| **Phase 5** | E2E 测试 | 4h | Phase 1-4 |

**Phase 4 详细设计：Git Commit 自动绑定机制**

```
核心场景：
1. Agent 在工作区执行 git commit
2. post-commit hook 自动触发
3. 最近的 session 与该 commit 绑定

实现流程：
Agent 执行任务 → session 记录 → git commit → post-commit hook → 自动绑定 session
```

**绑定算法**：
```typescript
// 自动绑定：根据 workspacePath + 时间窗口匹配
async function autoBindCommit(commitHash: string, workspacePath: string) {
  // 1. 获取 commit 变更的文件
  const changedFiles = await execGitDiff(commitHash);
  
  // 2. 查找同一工作区、24小时内的未绑定 session
  const sessions = await querySessions({
    workspacePath,
    unboundOnly: true,
    withinHours: 24
  });
  
  // 3. 根据文件交集计算置信度
  for (const session of sessions) {
    const affectedFiles = extractAffectedFiles(session.transcript);
    const overlap = changedFiles.filter(f => affectedFiles.includes(f));
    if (overlap.length > 0) {
      await bindSessionToCommit(session.id, commitHash, {
        file_patterns: overlap,
        confidence: overlap.length / changedFiles.length
      });
    }
  }
}
```

**post-commit Hook**：
```bash
#!/bin/bash
# .git/hooks/post-commit
agentlog-cli bind-commit --commit $(git rev-parse HEAD) --workspace $(pwd)
```

**总工时**：~26h

---

## 五、验收标准

优化后目标：

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| 每日新增 Session | ~6 | >100 |
| reasoning 填充率 | 0% | >80% |
| tool 调用记录率 | 0% | >80% |
| Commit 绑定率 | 0% | >50% |
| 数据完整性 | 10% | >70% |

---

## 六、风险与缓解

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| OpenClaw 不支持自动 hooks | 🔴 高 | 改用方案 2（MCP 中间件） |
| reasoning 格式不标准 | 🟡 中 | 要求模型输出时填充 reasoning 字段 |
| 数据量大导致存储膨胀 | 🟡 中 | 实现数据归档/压缩策略 |

---

## 七、结论

1. **当前问题**：仅记录确认消息，实际工作内容未捕获
2. **根本原因**：mcporter 需要手动调用，非自动拦截
3. **推荐方案**：OpenClaw Skill 自动存证
4. **实施路径**：Phase 1 快速落地 → Phase 2-5 完善

---

**Architect 签署**: 🏗️ Architect  
**评估日期**: 2026-04-02
