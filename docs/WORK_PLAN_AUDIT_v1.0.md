# AgentLog 全量存证完整性 - 工作计划

**版本**: v1.0
**日期**: 2026-04-06
**状态**: 待实施
**CEO审批**: SIGNED_BY_CEO_20260406

---

## 📋 工作分解

### Ticket 1: 创建 openclaw-agent-log Plugin

**Base_Ticket**: 创建 `skills/openclaw-agent-log/` plugin，实现：
1. 合并 auto-logging hooks（session_start, before_tool_call, after_tool_call, agent_end）
2. 合并 trace handoff 功能（checkAndClaimTrace, claimTrace, completeSession）
3. **source 从 workspace 路径自动推断**

**Acceptance_Criteria**:
- [ ] `skills/openclaw-agent-log/` 目录结构完整
- [ ] `openclaw.plugin.json` 配置正确
- [ ] `detectAgentSource()` 从 `process.cwd()` 推断 source
- [ ] Hooks 正确注册

---

### Ticket 2: 配置 openclaw-agent-log Plugin

**Base_Ticket**: 更新 `/home/hobo/.openclaw/openclaw.json`

**Acceptance_Criteria**:
- [ ] `plugins.entries.openclaw-agent-log.enabled: true`
- [ ] `plugins.installs.openclaw-agent-log` 配置正确

---

### Ticket 3: 验证 MCP Protocol 存证流程

**Base_Ticket**: 确认 MCP `log_turn` / `log_intent` 正确写入 traces/spans

**MCP 调用方式**:
```
log_turn(role="user", content="...") → 创建 trace (traces 表)
log_turn(role="tool", trace_id="xxx") → 创建 span (spans 表)
log_intent(trace_id="xxx") → 更新 status = 'completed' (traces 表)
```

**Acceptance_Criteria**:
- [ ] `log_turn` (无 trace_id) 创建 trace
- [ ] `log_turn` (有 trace_id) 创建 span
- [ ] `log_intent` 更新 trace status
- [ ] 6 种状态转换函数正确

---

### Ticket 4: 配置所有 Agent 启用存证

**Base_Ticket**: 验证并配置所有 8 个 Agent 的存证

| Agent | Workspace |
|-------|-----------|
| growth-hacker | /home/hobo/.openclaw/agents/growth-hacker/workspace |
| architect | /home/hobo/.openclaw/agents/architect/workspace |
| builder | /home/hobo/.openclaw/agents/builder/workspace |
| auditor | /home/hobo/.openclaw/agents/auditor/workspace |
| librarian | /home/hobo/.openclaw/agents/librarian/workspace |
| strategist | /home/hobo/.openclaw/agents/strategist/workspace |
| sentinel | /home/hobo/.openclaw/agents/sentinel/workspace |
| evangelist | /home/hobo/.openclaw/agents/evangelist/workspace |

**Acceptance_Criteria**:
- [ ] 所有 8 个 Agent 都能正确识别 source
- [ ] 存证数据可按 source 查询

---

## 🚀 实施顺序

1. Ticket 1 → 2 → 3 → 4（顺序执行）

---

## ✅ 验收标准

- [ ] 所有 8 个 Agent 启用了 openclaw-agent-log skill
- [ ] source 标识通过 workspace 路径自动推断
- [ ] AgentLog backend 正常运行
- [ ] MCP log_turn/log_intent 写入 traces/spans 表
- [ ] 可查询到所有 Agent 的历史 trace

---

## 📎 附录

### 设计文档
- `docs/AGENTLOG_COMPLETE_AUDIT_v1.0.md` (v2.0)

### 废弃说明
| 废弃项 | 替代项 |
|--------|--------|
| agent_sessions 表 | traces + spans 表 |
| /api/sessions | MCP log_turn/log_intent |
| agentlog-auto skill | openclaw-agent-log |
