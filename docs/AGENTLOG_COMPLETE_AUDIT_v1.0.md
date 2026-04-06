# AgentLog 全量存证完整性设计方案

**版本**: v2.0
**作者**: Architect
**日期**: 2026-04-06
**优先级**: P0（陈洪博指示）
**状态**: 讨论中

---

## 📌 1. 目标

**陈洪博指示**：
1. 首先完成 AgentLog 在当前 Agent 使用的设计
2. 确保所有 Agent 的会话存证**没有遗漏**
3. 然后再在此基础上完成每日日报的设计

### 1.1 核心目标

| 目标 | 说明 |
|------|------|
| **全量存证** | 所有 Agent 的所有会话都必须被记录 |
| **Trace/span 体系** | 使用 trace + span 而非 session |
| **标识准确** | 每个 Agent 的 source 标识正确 |
| **可查询** | 可按 source/agent 查询任意 Agent 的历史会话 |
| **无遗漏** | 短会话、异常退出的会话也能被捕获 |

---

## 🔍 2. 数据模型（v1.1.1 Trace/Span 体系）

### 2.1 Trace 表

```sql
CREATE TABLE traces (
  id                  TEXT PRIMARY KEY,      -- ULID
  task_goal           TEXT NOT NULL,         -- 任务目标
  status              TEXT NOT NULL DEFAULT 'running',  -- running|paused|completed|failed
  parent_trace_id     TEXT,                  -- Fork 关联
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
```

### 2.2 Span 表

```sql
CREATE TABLE spans (
  id                  TEXT PRIMARY KEY,      -- ULID
  trace_id            TEXT NOT NULL,         -- 所属 trace
  parent_span_id      TEXT,                  -- 父 span（顶级为 NULL）
  name                TEXT NOT NULL,         -- span 名称
  payload             TEXT NOT NULL DEFAULT '{}',  -- JSON 数据
  created_at          TEXT NOT NULL
);
```

### 2.3 Trace 状态机

| 状态 | 含义 | 触发条件 |
|------|------|---------|
| `running` | 任务进行中 | 默认初始状态 |
| `pending_handoff` | 等待交接 | 任务完成，等待交接给其他 Agent |
| `in_progress` | 进行中 | 从 pending_handoff 或 running 进入 |
| `completed` | 任务完成 | log_intent 被调用 |
| `failed` | 任务失败 | Agent 执行出错 |
| `paused` | 任务暂停 | 用户主动暂停或超时 |

### 2.4 状态转换

```
running → pending_handoff → in_progress → completed/failed
    ↓                                        ↑
paused ───────────────────────────────────────┘
```

### 2.5 数据存储说明

⚠️ **不再使用 `agent_sessions` 表**，统一使用 `traces` + `spans` 表。

| 旧（已废弃） | 新 |
|-------------|-----|
| `agent_sessions` 表 | `traces` + `spans` 表 |
| `session_id` | `trace_id` |

**关系**：Trace → Span
- 一个 Trace 包含多个 Span
- 每个 Span 对应一次操作（如工具调用）

---

## 🔍 3. API 接口

### 3.1 MCP Protocol（主推）✅

**MCP 协议已完整支持 trace/span 体系**，推荐使用。

| 方法 | 说明 | 写入表 |
|------|------|--------|
| `log_turn` (无 trace_id) | 创建新 trace | `traces` |
| `log_turn` (有 trace_id) | 追加 span | `spans` |
| `log_intent` | 更新 trace status = 'completed' | `traces` |

**优势**：
- ✅ 外部兼容性好（VSCode、OpenCode 等都使用 MCP）
- ✅ 已完整支持 trace/span
- ✅ 不需要 Builder 修改实现

### 3.2 REST API（辅助）

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/traces` | 创建 trace |
| GET | `/api/traces` | 查询 trace 列表 |
| GET | `/api/traces/:id` | 获取 trace 详情 |
| POST | `/api/traces/:id/spans` | 创建 span |
| GET | `/api/traces/:id/spans` | 获取 trace 的所有 span |
| PATCH | `/api/traces/:id/status` | 更新 trace 状态 |

⚠️ **注意**：旧的 `/api/sessions` 写入 `agent_sessions` 表，**已废弃**，不要使用。

---

## 🔍 4. 现状分析

### 3.1 当前 Agent 列表

| Agent | workspace | source 预期值 |
|-------|-----------|--------------|
| growth-hacker | `/home/hobo/.openclaw/agents/growth-hacker/workspace` | `openclaw:growth-hacker` |
| architect | `/home/hobo/.openclaw/agents/architect/workspace` | `openclaw:architect` |
| builder | `/home/hobo/.openclaw/agents/builder/workspace` | `openclaw:builder` |
| auditor | `/home/hobo/.openclaw/agents/auditor/workspace` | `openclaw:auditor` |
| librarian | `/home/hobo/.openclaw/agents/librarian/workspace` | `openclaw:librarian` |
| strategist | `/home/hobo/.openclaw/agents/strategist/workspace` | `openclaw:strategist` |
| sentinel | `/home/hobo/.openclaw/agents/sentinel/workspace` | `openclaw:sentinel` |
| evangelist | `/home/hobo/.openclaw/agents/evangelist/workspace` | `openclaw:evangelist` |

### 3.2 当前配置检查

**mcporter.json 配置**（每个 Agent）：
```json
{
  "mcpServers": {
    "agentlog": {
      "command": "node /home/hobo/Projects/agentlog/packages/backend/dist/mcp.js"
    }
  }
}
```

**问题**：
- 仅配置了 MCP client 连接到 AgentLog backend
- 但**不确定 openclaw-agent-log skill 是否启用**
- 不确定 OpenClaw hooks 是否正确注册

### 3.3 潜在遗漏风险

| 风险点 | 说明 | 影响 |
|--------|------|------|
| **openclaw-agent-log 未全局启用** | 每个 Agent 需要单独配置 | 某些 Agent 可能没有存证 |
| **source 标识不统一** | 各 Agent 的 AGENTLOG_AGENT_ID 可能不一致 | 查询时无法准确过滤 |
| **短会话丢失** | 如果 agent 快速退出，存证可能不完整 | 数据缺失 |
| **异常退出未捕获** | 未调用 log_intent 就退出的会话 | 无法追溯完整逻辑 |
| **MCP 连接失败** | 如果 backend 不可用，存证失败 | 无降级机制 |

---

## 🏗️ 4. 存证完整性设计方案

### 4.1 统一技能包：openclaw-agent-log

本 Skill 是 `agentlog-auto` 和 `openclaw-agent` 的**合并版本**，为 OpenClaw Agent 提供统一的存证和 Trace 管理能力。

**包含模块**：

| 模块 | 功能 |
|------|------|
| **Auto-Logging** | 通过 OpenClaw Hooks 自动记录 agent 活动 |
| **Trace Handoff** | Agent 间任务交接（claim/resume trace） |

**目录**：`skills/openclaw-agent-log/`

### 4.2 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenClaw Runtime                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │Architect │ │ Builder  │ │Growth-   │ │ Auditor  │       │
│  │          │ │          │ │Hacker    │ │          │       │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘       │
│       │              │              │              │        │
│       └──────────────┴──────────────┴──────────────┘        │
│                              │                               │
│                    ┌─────────▼─────────┐                    │
│                    │  openclaw-agent-log │                    │
│                    │  (统一技能包)       │                    │
│                    ├───────────────────┤                    │
│                    │ Auto-Logging      │                    │
│                    │ - session_start   │                    │
│                    │ - before_tool_call│                    │
│                    │ - after_tool_call │                    │
│                    │ - agent_end       │                    │
│                    ├───────────────────┤                    │
│                    │ Trace Handoff     │                    │
│                    │ - checkAndClaim   │                    │
│                    │ - claimTrace      │                    │
│                    │ - completeSession │                    │
│                    └───────────────────┘                    │
│                              │                               │
└──────────────────────────────┼───────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  AgentLog Backend   │
                    │  (MCP Server)        │
                    │  port: 7892          │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │    SQLite DB         │
                    │  traces + spans      │
                    │  ~/.agentlog/        │
                    └─────────────────────┘
```

### 4.3 存证流程（基于 Trace/Span）

```
1. Agent 启动
   ↓
2. openclaw-agent-log skill 加载
   ↓
3. checkAndClaimTrace() → 检查是否有待认领的 trace
   ↓
4. 如果有待认领 trace → claimTrace() → 设置 AGENTLOG_TRACE_ID
   ↓
5. session_start hook 触发 → 创建新 span（关联到 trace）
   ↓
6. 每次交互
   → before_tool_call: 记录工具调用参数
   → after_tool_call: 记录工具执行结果
   ↓
7. Agent 完成任务
   → agent_end hook: 调用 log_intent → 更新 trace status = 'completed'
   ↓
8. Session 结束
   → completeActiveSession() → 清理状态
```

### 4.4 source 标识机制

**⚠️ 环境变量冲突问题**：
如果所有 Agent 共享同一主机，使用全局环境变量 `AGENTLOG_AGENT_ID` 会导致 source 冲突。

**✅ 推荐方案：从 workspace 路径自动推断**

```typescript
function detectAgentSource(): string {
  // 从 workspace 路径推断 agent 类型
  // 路径格式: /home/hobo/.openclaw/agents/<agent-name>/workspace
  const workspacePath = process.cwd();
  const match = workspacePath.match(/\/agents\/([^\/]+)\/workspace/);
  if (match) {
    return `openclaw:${match[1]}`;
  }

  // Fallback: 环境变量
  const agentId = process.env.AGENTLOG_AGENT_ID || process.env.AGENT || "";
  if (agentId) {
    return `openclaw:${agentId}`;
  }

  return "unknown";
}
```

**推断结果示例**：

| Workspace 路径 | 推断 source |
|----------------|-------------|
| `/home/hobo/.openclaw/agents/architect/workspace` | `openclaw:architect` |
| `/home/hobo/.openclaw/agents/builder/workspace` | `openclaw:builder` |
| `/home/hobo/.openclaw/agents/growth-hacker/workspace` | `openclaw:growth-hacker` |

**优势**：
- 无需手动配置环境变量
- 每个 Agent 自动使用正确的 source
- 不依赖 OpenClaw runtime 设置

---

## ✅ 5. 存证完整性检查清单

### 5.1 配置检查

| # | 检查项 | 检查方法 | 预期结果 |
|---|--------|----------|----------|
| 1 | openclaw-agent-log skill 已安装 | `ls skills/openclaw-agent-log/` | 目录存在 |
| 2 | openclaw-agent-log skill 已启用 | `openclaw agents config list` | 显示 openclaw-agent-log |
| 3 | 所有 Agent 启用 openclaw-agent-log | 检查每个 Agent 配置 | 全部启用 |
| 4 | MCP client 配置正确 | `cat config/mcporter.json` | 包含 agentlog server |
| 5 | AGENTLOG_AGENT_ID 环境变量 | `echo $AGENTLOG_AGENT_ID` | `openclaw:<agent-name>` |
| 6 | AgentLog backend 运行中 | `curl localhost:7892/health` | 返回 200 |

### 5.2 数据完整性检查

| # | 检查项 | SQL 查询 | 预期结果 |
|---|--------|----------|----------|
| 1 | 各 Agent 都有 trace 记录 | `SELECT source, COUNT(*) FROM traces GROUP BY source` | 每个 Agent 都有记录 |
| 2 | trace 有完整的 spans | `SELECT trace_id, COUNT(*) FROM spans GROUP BY trace_id` | spans > 0 |
| 3 | trace 有正确的状态 | `SELECT id, status FROM traces WHERE status IN ('running','completed')` | 有 running/completed |
| 4 | 无异常短的 span | `SELECT id, duration_ms FROM spans WHERE duration_ms < 1000` | 应很少 |

---

## 🔧 6. 实施方案

### 6.1 第一步：检查当前状态

```bash
# 1. 检查 openclaw-agent-log skill 是否存在
ls /home/hobo/Projects/agentlog/skills/openclaw-agent-log/

# 2. 检查 OpenClaw agents 配置
openclaw agents config list

# 3. 检查 AgentLog backend 状态
curl localhost:7892/health

# 4. 查询当前存证数据
curl localhost:7892/api/traces?pageSize=100
```

### 6.2 第二步：修复发现的问题

| 问题 | 解决方案 |
|------|----------|
| openclaw-agent-log 未启用 | `openclaw agents config set <agent> skills+=openclaw-agent-log` |
| MCP 配置缺失 | 创建/更新 `config/mcporter.json` |
| backend 未运行 | `cd /home/hobo/Projects/agentlog && node packages/backend/dist/index.js` |
| source 标识错误 | 检查 `AGENTLOG_AGENT_ID` 环境变量 |

### 6.3 第三步：验证存证完整性

```bash
# 验证所有 Agent 的存证
for agent in growth-hacker architect builder auditor librarian strategist sentinel evangelist; do
  echo "=== $agent ==="
  curl -s "localhost:7892/api/traces?source=openclaw:$agent&pageSize=5" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Traces: {d.get(\"total\",0)}')"
done
```

---

## 📊 7. 验收标准

- [ ] 所有 8 个 Agent 的 mcporter.json 配置 agentlog MCP server
- [ ] 所有 8 个 Agent 启用了 openclaw-agent-log skill
- [ ] 所有 8 个 Agent 的 source 标识为 `openclaw:<agent-name>`
- [ ] AgentLog backend 正常运行
- [ ] 可查询到所有 Agent 的历史 trace
- [ ] trace 包含完整的 spans
- [ ] 存证数据无明显异常

---

## ⏭️ 8. 下一步

**Phase 1 完成后的工作**：
- 汇总存证完整性检查结果
- 修复发现的问题
- 确认各 Agent 存证无遗漏

**Phase 2**（在 Phase 1 完成后）：
- 基于存证设计每日日报自动填充
- 参考：`AGENTLOG_DAILY_REPORT_DESIGN_v2.0.md`

---

## 📎 附录

### A. 相关文件

| 文件 | 路径 |
|------|------|
| openclaw-agent-log SKILL | `/home/hobo/Projects/agentlog/skills/openclaw-agent-log/SKILL.md` |
| MCP Server | `/home/hobo/Projects/agentlog/packages/backend/src/mcp.ts` |
| Backend Routes | `/home/hobo/Projects/agentlog/packages/backend/src/routes/traces.ts` |
| Trace Service | `/home/hobo/Projects/agentlog/packages/backend/src/services/traceService.ts` |
| 数据库 | `~/.agentlog/agentlog.db` |

### B. OpenClaw CLI 命令

```bash
# 查看所有 agent 配置
openclaw agents list

# 查看单个 agent 配置
openclaw agents config get <agent>

# 设置 agent skills（启用统一技能包）
openclaw agents config set <agent> skills+="openclaw-agent-log"

# 查看运行状态
openclaw status
```

### C. 废弃说明

| 废弃项 | 替代项 |
|--------|--------|
| `agentlog-auto` skill | `openclaw-agent-log`（名称冲突） |
| `openclaw-agent` skill | `openclaw-agent-log`（功能已合并） |
| `agent_sessions` 表 | `traces` + `spans` 表（v1.1.1） |
