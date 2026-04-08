# AgentLog × Growth-Hacker 每日工作日报自动填充方案

**版本**: v1.0
**作者**: Architect
**日期**: 2026-04-06
**状态**: 待 Librarian 确认后生效

---

## 📌 1. 需求背景

Growth-Hacker 每天 9:30 通过 `daily-report.sh` 生成工作汇报发送到飞书群，但目前存在以下问题：

1. **大量占位符未填充**：`[请填写]` 占位符导致日报内容不完整
2. **数据来源不明确**：未充分利用 AgentLog 会话记录
3. **解析逻辑简单**：仅提取最后一条 assistant 消息，内容有限

---

## 🔍 2. 现状分析

### 2.1 现有架构

```
Growth-Hacker 工作 → agentlog-auto（OpenClaw Hooks）
                           ↓
                    AgentLog MCP Server
                           ↓
                      SQLite DB
                           ↓
        daily-report.sh → /api/sessions（按 workspacePath 查询）
                           ↓
                      生成日报 → 发飞书
```

### 2.2 当前问题

| 问题 | 说明 |
|------|------|
| workspacePath 查询不稳定 | 工作区路径可能变化 |
| 内容解析太简单 | 仅取最后 150 字符 |
| 手动字段过多 | GitHub Stars、下载量等需人工填写 |
| 任务类型判断简单 | 仅靠关键词匹配 |

### 2.3 现有数据流

**agentlog-auto** 通过 OpenClaw Hooks 自动记录：
- `session_start` → 创建 session
- `before_tool_call` → 记录工具调用
- `after_tool_call` → 记录工具结果
- `agent_end` → 调用 log_intent

**source 标识**：`openclaw:growth-hacker`（通过 `AGENTLOG_AGENT_ID` 环境变量）

---

## 🏗️ 3. 技术方案

### 3.1 目标

让 `daily-report.sh` 通过 AgentLog MCP 查询**真实工作记录**，自动填充日报中 80% 以上的字段。

### 3.2 对接架构（改进后）

```
Growth-Hacker 工作 → agentlog-auto（source=openclaw:growth-hacker）
                           ↓
                    AgentLog MCP Server（存证）
                           ↓
        daily-report.sh → query_historical_interaction
                           ↓
              source=openclaw:growth-hacker
              start_date=昨天 00:00:00
              end_date=今天 00:00:00
              include_transcript=true
                           ↓
                    解析 transcript
                           ↓
                提取：任务类型、工作内容、决策、文件改动
                           ↓
                      填充模板
                           ↓
                         发飞书
```

### 3.3 MCP 接口确认

**接口**：`query_historical_interaction`（已存在于 mcp.ts）

**推荐调用参数**：
```json
{
  "source": "openclaw:growth-hacker",
  "start_date": "2026-04-05T00:00:00+08:00",
  "end_date": "2026-04-06T00:00:00+08:00",
  "include_transcript": true
}
```

**返回数据结构**：
```json
{
  "success": true,
  "data": {
    "data": [
      {
        "id": "session_id",
        "source": "openclaw:growth-hacker",
        "created_at": "2026-04-05T10:30:00+08:00",
        "model": "MiniMax-M2.7",
        "transcript": [...],
        "response": "任务完成摘要",
        "reasoning_summary": "推理过程摘要",
        "workspacePath": "/path/to/workspace"
      }
    ],
    "total": 5,
    "page": 1,
    "pageSize": 20
  }
}
```

### 3.4 日报模板填充规则

| 占位符 | 数据来源 | 填充逻辑 |
|--------|----------|----------|
| `[任务类型]` | transcript 关键词 | 更新→文档更新，review→Code Review，commit→Git操作 |
| `[状态]` | 会话 duration_ms | >5min=完成，<5min=进行中 |
| `[内容摘要]` | transcript 最后一条 assistant 消息 | 提取前 150 字符 |
| `[推理过程]` | reasoning_summary | 直接填充 |
| `[GitHub Stars]` | GitHub API | curl 获取（可保留 [请填写] 如果 API 失败） |
| `[VS Code 下载量]` | 外部数据源 | 建议保持手动 |

### 3.5 transcript 解析增强

**当前逻辑问题**：
- 仅取最后一条 assistant 消息
- 不处理多轮对话

**改进解析逻辑**：
```python
# 伪代码
def extract_work_items(transcript):
    work_items = []
    for msg in transcript:
        if msg['role'] == 'assistant':
            content = extract_text(msg['content'])
            # 判断是否为有效工作内容
            if contains_task_markers(content):
                work_items.append({
                    'type': classify_task(content),
                    'content': content[:200],
                    'time': msg.get('timestamp')
                })
    return work_items[:5]  # 最多5条
```

---

## 📁 4. Skill 实现

### 4.1 新增 Skill 目录

```
skills/agentlog-daily-report/
├── SKILL.md                    # Skill 定义
├── query_and_parse.mjs        # 核心查询解析脚本
└── TEMPLATE_FIELDS.yaml       # 模板字段映射配置
```

### 4.2 query_and_parse.mjs 核心功能

```javascript
// 伪代码
async function main() {
  const yesterday = getYesterdayRange();  // 计算昨日时间范围
  
  // 1. 调用 MCP query_historical_interaction
  const result = await callMCP('query_historical_interaction', {
    source: 'openclaw:growth-hacker',
    start_date: yesterday.start,
    end_date: yesterday.end,
    include_transcript: true
  });
  
  // 2. 解析 transcript，提取工作项
  const workItems = parseTranscript(result.data);
  
  // 3. 填充模板
  const report = fillTemplate(workItems);
  
  // 4. 输出 JSON 供 shell 调用
  console.log(JSON.stringify(report));
}
```

---

## ⚠️ 5. 待确认事项（Librarian）

| # | 问题 | 状态 |
|---|------|------|
| 1 | agentlog-auto 的 source 标识是否为 `openclaw:growth-hacker`？ | ⏳ 待确认 |
| 2 | reasoning_summary 字段内容格式？ | ⏳ 待确认 |
| 3 | daily-report.sh 中的 workspacePath 查询是否可改为 source 查询？ | ⏳ 待确认 |
| 4 | 每日 9:30 cron 是否正确配置？ | ⏳ 待确认 |

---

## 📋 6. 实现计划

| 阶段 | 内容 | 依赖 |
|------|------|------|
| Phase 1 | 确认 Librarian 存证配置 | Librarian 确认 source 参数 |
| Phase 2 | 实现 query_and_parse.mjs | Phase 1 完成 |
| Phase 3 | 修改 daily-report.sh 调用新脚本 | Phase 2 完成 |
| Phase 4 | 本地测试验证 | Phase 3 完成 |
| Phase 5 | 提交 PR，合流 dev | Phase 4 完成 |

---

## 🧪 7. 验收标准

- [ ] `query_and_parse.mjs` 可正确调用 MCP 接口
- [ ] 返回结果包含至少 3 条有效工作记录
- [ ] 日报中 `[请填写]` 字段减少 50%
- [ ] 飞书群收到的日报内容为真实数据
- [ ] 通过 Auditor E2E 测试

---

## 📎 附录

### A. 相关文件路径

| 文件 | 路径 |
|------|------|
| daily-report.sh | `/home/hobo/.openclaw/agents/growth-hacker/workspace/scripts/daily-report.sh` |
| MCP Server | `/home/hobo/Projects/agentlog/packages/backend/dist/mcp.js` |
| agentlog-auto SKILL | `/home/hobo/Projects/agentlog/skills/agentlog-auto/SKILL.md` |
| 数据库 | `~/.agentlog/agentlog.db` |

### B. API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/sessions` | GET | 查询会话列表 |
| `/api/sessions/:id` | GET | 获取单条会话详情 |
| `/health` | GET | 健康检查 |
