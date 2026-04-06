# AgentLog 全量存证完整性 - Ticket 拆解

**方案文档**: `docs/AGENTLOG_COMPLETE_AUDIT_v1.0.md` (v2.0)
**评审状态**: ✅ Librarian 评审通过
**日期**: 2026-04-06

---

## Ticket 1: 创建 openclaw-agent-log Plugin

### 概述
将 `agentlog-auto` 和 `openclaw-agent` 合并为一个统一的 plugin `openclaw-agent-log`

### Base_Ticket
创建 `skills/openclaw-agent-log/` plugin，实现：
1. 合并 auto-logging hooks（session_start, before_tool_call, after_tool_call, agent_end）
2. 合并 trace handoff 功能（checkAndClaimTrace, claimTrace, completeSession）
3. 实现 source 标识从 workspace 路径自动推断

### Compliance_Rule
必须通过 Auditor E2E 测试集 #存证完整性

### Acceptance_Criteria
- [ ] `skills/openclaw-agent-log/` 目录结构完整
- [ ] `openclaw.plugin.json` 配置正确
- [ ] `detectAgentSource()` 从 `process.cwd()` 推断 source
- [ ] Hooks 正确注册：session_start, before_tool_call, after_tool_call, agent_end
- [ ] Trace handoff API 可用：checkAndClaimTrace, claimTrace, completeSession

### 技术细节
```typescript
// source 推断逻辑
function detectAgentSource(): string {
  const workspacePath = process.cwd();
  const match = workspacePath.match(/\/agents\/([^\/]+)\/workspace/);
  if (match) {
    return `openclaw:${match[1]}`;
  }
  // Fallback
  const agentId = process.env.AGENTLOG_AGENT_ID || "";
  return agentId ? `openclaw:${agentId}` : "unknown";
}
```

---

## Ticket 2: 配置 openclaw-agent-log Plugin

### 概述
在 `openclaw.json` 中配置 `openclaw-agent-log` plugin 启用

### Base_Ticket
更新 `/home/hobo/.openclaw/openclaw.json`，添加 `openclaw-agent-log` plugin 配置

### Compliance_Rule
必须通过 Auditor E2E 测试集 #存证完整性

### Acceptance_Criteria
- [ ] `plugins.entries.openclaw-agent-log.enabled: true`
- [ ] `plugins.installs.openclaw-agent-log` 配置正确
- [ ] plugin 可被 OpenClaw 加载

### 技术细节
```json
{
  "plugins": {
    "entries": {
      "openclaw-agent-log": {
        "enabled": true
      }
    },
    "installs": {
      "openclaw-agent-log": {
        "source": "path",
        "sourcePath": "/home/hobo/Projects/agentlog/skills/openclaw-agent-log",
        "installPath": "/home/hobo/.openclaw/skills/openclaw-agent-log",
        "version": "1.0.0"
      }
    }
  }
}
```

---

## Ticket 3: 验证 Trace/Span 数据流

### 概述
验证 MCP `log_turn` 和 `log_intent` 正确写入 traces/spans 表

### Base_Ticket
确认 MCP server 的 log_turn/log_intent 写入 traces/spans，并验证数据流

### Compliance_Rule
必须通过 Auditor E2E 测试集 #traces-spans

### Acceptance_Criteria
- [ ] `log_turn` 调用创建/更新 trace 和 span
- [ ] `log_intent` 更新 trace status 为 'completed'
- [ ] 6 种状态转换函数可被正确调用
- [ ] traces 表和 spans 表数据正确

### 技术细节
- `log_turn` → traceService.createTrace / createSpan
- `log_intent` → traceService.updateTrace(status: 'completed')
- 状态转换: running → pending_handoff → in_progress → completed/failed

---

## Ticket 4: 配置所有 Agent 启用存证

### 概述
确保所有 8 个 Agent 都启用了 openclaw-agent-log plugin

### Base_Ticket
验证并配置所有 Agent 的存证

### Compliance_Rule
必须通过 Auditor E2E 测试集 #全量存证

### Acceptance_Criteria
- [ ] 所有 8 个 Agent 都能正确识别 source
- [ ] 所有 Agent 的 workspace 路径格式正确
- [ ] 存证数据可按 source 查询

### Agent 列表
| Agent | Workspace 路径 |
|-------|---------------|
| growth-hacker | `/home/hobo/.openclaw/agents/growth-hacker/workspace` |
| architect | `/home/hobo/.openclaw/agents/architect/workspace` |
| builder | `/home/hobo/.openclaw/agents/builder/workspace` |
| auditor | `/home/hobo/.openclaw/agents/auditor/workspace` |
| librarian | `/home/hobo/.openclaw/agents/librarian/workspace` |
| strategist | `/home/hobo/.openclaw/agents/strategist/workspace` |
| sentinel | `/home/hobo/.openclaw/agents/sentinel/workspace` |
| evangelist | `/home/hobo/.openclaw/agents/evangelist/workspace` |

---

## Ticket 5: 验证存证完整性

### 概述
验证所有 Agent 的会话都被正确存证

### Base_Ticket
运行存证完整性检查脚本

### Compliance_Rule
必须通过 Auditor E2E 测试集 #存证完整性

### Acceptance_Criteria
- [ ] 可查询到所有 8 个 Agent 的 trace 记录
- [ ] trace 包含完整的 spans
- [ ] 6 种状态都有出现
- [ ] 无异常短的 session

### 检查脚本
```bash
# 验证所有 Agent 的存证
for agent in growth-hacker architect builder auditor librarian strategist sentinel evangelist; do
  echo "=== $agent ==="
  curl -s "localhost:7892/api/traces?source=openclaw:$agent&pageSize=5" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Traces: {d.get(\"total\",0)}')"
done
```

---

## 实施顺序

1. **Ticket 1**: 创建 openclaw-agent-log Plugin（基础）
2. **Ticket 2**: 配置 Plugin（依赖 Ticket 1）
3. **Ticket 3**: 验证数据流（独立）
4. **Ticket 4**: 配置所有 Agent（依赖 Ticket 2）
5. **Ticket 5**: 验证完整性（依赖 Ticket 3+4）

---

## CEO_Approval_Stamp
SIGNED_BY_CEO_20260406
