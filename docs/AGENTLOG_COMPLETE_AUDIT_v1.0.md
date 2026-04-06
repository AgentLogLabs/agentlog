# AgentLog 全量存证完整性设计方案

**版本**: v1.0
**作者**: Architect
**日期**: 2026-04-06
**优先级**: P0（陈洪博指示）
**状态**: 设计中

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
| **标识准确** | 每个 Agent 的 source 标识正确 |
| **可查询** | 可按 source/agent 查询任意 Agent 的历史会话 |
| **无遗漏** | 短会话、异常退出的会话也能被捕获 |

---

## 🔍 2. 现状分析

### 2.1 当前 Agent 列表

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

### 2.2 当前配置检查

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
- 但**不确定 agentlog-auto skill 是否启用**
- 不确定 OpenClaw hooks 是否正确注册

### 2.3 潜在遗漏风险

| 风险点 | 说明 | 影响 |
|--------|------|------|
| **agentlog-auto 未全局启用** | 每个 Agent 需要单独配置 | 某些 Agent 可能没有存证 |
| **source 标识不统一** | 各 Agent 的 AGENTLOG_AGENT_ID 可能不一致 | 查询时无法准确过滤 |
| **短会话丢失** | 如果 agent 快速退出，存证可能不完整 | 数据缺失 |
| **异常退出未捕获** | 未调用 log_intent 就退出的会话 | 无法追溯完整逻辑 |
| **MCP 连接失败** | 如果 backend 不可用，存证失败 | 无降级机制 |

---

## 🏗️ 3. 存证完整性设计方案

### 3.1 架构设计

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
│                    │  agentlog-auto    │                    │
│                    │  (Global Skill)   │                    │
│                    └─────────┬─────────┘                    │
│                              │                               │
│                    ┌─────────▼─────────┐                    │
│                    │   OpenClaw Hooks   │                    │
│                    ├───────────────────┤                    │
│                    │ session_start     │                    │
│                    │ before_prompt     │                    │
│                    │ before_tool_call  │                    │
│                    │ after_tool_call   │                    │
│                    │ agent_end         │                    │
│                    │ session_end       │                    │
│                    └─────────┬─────────┘                    │
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
                    │  ~/.agentlog/        │
                    └─────────────────────┘
```

### 3.2 存证流程

```
1. Agent 启动
   ↓
2. agentlog-auto skill 加载
   ↓
3. session_start hook 触发
   → 创建新 session（首次 log_turn）
   ↓
4. 每次交互
   → before_prompt: 捕获 reasoning（如有）
   → before_tool_call: 记录工具调用参数
   → after_tool_call: 记录工具执行结果
   ↓
5. Agent 完成任务
   → agent_end hook: 调用 log_intent
   ↓
6. Session 结束
   → session_end hook: 清理状态
```

### 3.3 source 标识机制

**OpenClaw 自动设置**：
- 环境变量 `AGENTLOG_AGENT_ID` 由 OpenClaw runtime 自动设置
- 格式：`openclaw:<agent-name>`
- 示例：`openclaw:architect`, `openclaw:builder`

**MCP Server 推断逻辑**（mcp.ts）：
```typescript
function inferSource(clientName: string): string {
  // Check environment variables first (OpenClaw agents)
  const agentId = process.env.AGENTLOG_AGENT_ID || process.env.AGENT || "";
  if (agentId) {
    return `openclaw:${agentId}`;
  }
  // ... fallback to client name pattern matching
}
```

---

## ✅ 4. 存证完整性检查清单

### 4.1 配置检查

| # | 检查项 | 检查方法 | 预期结果 |
|---|--------|----------|----------|
| 1 | agentlog-auto skill 已安装 | `ls skills/agentlog-auto/` | 目录存在 |
| 2 | agentlog-auto skill 已启用 | `openclaw agents config list` | 显示 agentlog-auto |
| 3 | 所有 Agent 启用 agentlog-auto | 检查每个 Agent 配置 | 全部启用 |
| 4 | MCP client 配置正确 | `cat config/mcporter.json` | 包含 agentlog server |
| 5 | AGENTLOG_AGENT_ID 环境变量 | `echo $AGENTLOG_AGENT_ID` | `openclaw:<agent-name>` |
| 6 | AgentLog backend 运行中 | `curl localhost:7892/health` | 返回 200 |

### 4.2 数据完整性检查

| # | 检查项 | SQL 查询 | 预期结果 |
|---|--------|----------|----------|
| 1 | 各 Agent 都有 session 记录 | `SELECT source, COUNT(*) FROM agent_sessions GROUP BY source` | 每个 Agent 都有记录 |
| 2 | session 有完整的 transcript | `SELECT id, LENGTH(transcript) FROM agent_sessions` | transcript 非空 |
| 3 | session 有 reasoning_summary | `SELECT id, reasoning_summary FROM agent_sessions WHERE reasoning_summary IS NOT NULL` | 有记录 |
| 4 | 无异常短的 session | `SELECT id, duration_ms FROM agent_sessions WHERE duration_ms < 1000` | 应很少 |

---

## 🔧 5. 实施方案

### 5.1 第一步：检查当前状态

```bash
# 1. 检查 agentlog-auto skill 是否存在
ls /home/hobo/Projects/agentlog/skills/agentlog-auto/

# 2. 检查 OpenClaw agents 配置
openclaw agents config list

# 3. 检查 AgentLog backend 状态
curl localhost:7892/health

# 4. 查询当前存证数据
curl localhost:7892/api/sessions?pageSize=100
```

### 5.2 第二步：修复发现的问题

| 问题 | 解决方案 |
|------|----------|
| agentlog-auto 未启用 | `openclaw agents config set <agent> skills+=agentlog-auto` |
| MCP 配置缺失 | 创建/更新 `config/mcporter.json` |
| backend 未运行 | `cd /home/hobo/Projects/agentlog && node packages/backend/dist/index.js` |
| source 标识错误 | 检查 `AGENTLOG_AGENT_ID` 环境变量 |

### 5.3 第三步：验证存证完整性

```bash
# 验证所有 Agent 的存证
for agent in growth-hacker architect builder auditor librarian strategist sentinel evangelist; do
  echo "=== $agent ==="
  curl -s "localhost:7892/api/sessions?source=openclaw:$agent&pageSize=5" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Sessions: {d.get(\"total\",0)}')"
done
```

---

## 📊 6. 验收标准

- [ ] 所有 8 个 Agent 的 mcporter.json 配置 agentlog MCP server
- [ ] 所有 8 个 Agent 启用了 agentlog-auto skill
- [ ] 所有 8 个 Agent 的 source 标识为 `openclaw:<agent-name>`
- [ ] AgentLog backend 正常运行
- [ ] 可查询到所有 Agent 的历史 session
- [ ] session 包含完整的 transcript 和 reasoning_summary
- [ ] 存证数据无明显异常（如极短的 session）

---

## ⏭️ 7. 下一步

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
| agentlog-auto SKILL | `/home/hobo/Projects/agentlog/skills/agentlog-auto/SKILL.md` |
| MCP Server | `/home/hobo/Projects/agentlog/packages/backend/src/mcp.ts` |
| Backend Routes | `/home/hobo/Projects/agentlog/packages/backend/src/routes/sessions.ts` |
| 数据库 | `~/.agentlog/agentlog.db` |

### B. OpenClaw CLI 命令

```bash
# 查看所有 agent 配置
openclaw agents list

# 查看单个 agent 配置
openclaw agents config get <agent>

# 设置 agent skills
openclaw agents config set <agent> skills+="agentlog-auto"

# 查看运行状态
openclaw status
```
