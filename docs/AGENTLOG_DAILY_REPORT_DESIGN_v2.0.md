# AgentLog × All Agents 每日工作日报自动填充方案

**版本**: v2.0
**作者**: Architect
**日期**: 2026-04-06
**状态**: 设计中（泛化为通用方案）

---

## 📌 1. 需求背景

**CEO指示**：需要一份通用方案，支持所有 Agent 进行工作过程记录存储和获取，用于各自的每日工作日报汇报。

### 1.1 现状问题

| 问题 | 说明 |
|------|------|
| 日报占位符未填充 | `[请填写]` 导致日报不完整 |
| 数据来源不统一 | 各 Agent 可能使用不同的查询方式 |
| 不可扩展 | 如果只针对单个 Agent，其他 Agent 无法复用 |

### 1.2 目标

**一套通用架构，支持所有 Agent：**
- Growth-Hacker → 增长工作日报
- Architect → 技术方案日报
- Builder → 开发进度日报
- Auditor → 测试报告日报
- ... 其他 Agent 同理

---

## 🔍 2. 通用架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      AgentLog 存证体系                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐  │
│  │Architect │   │ Builder  │   │Growth-   │   │ Auditor  │  │
│  │          │   │          │   │Hacker    │   │          │  │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘   └────┬─────┘  │
│       │              │              │              │        │
│       ▼              ▼              ▼              ▼        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         openclaw-agentlog（统一存证，source 自动标识）       │   │
│  └─────────────────────────────────────────────────────┘   │
│                            │                               │
│                            ▼                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              AgentLog MCP Server                      │   │
│  │         query_historical_interaction                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                            │                               │
│                            ▼                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  SQLite DB                            │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────────────────────┐
        │           Agent 通用日报查询脚本                      │
        │     agent-daily-report.sh --agent <AGENT_NAME>      │
        └───────────────────────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────────────────────┐
        │           各 Agent 飞书群推送                        │
        │   Architect → 技术架构群                            │
        │   Builder → 开发进度群                              │
        │   Growth-Hacker → 增长日报群                        │
        │   ...                                              │
        └───────────────────────────────────────────────────┘
```

### 2.2 source 标识体系

所有 OpenClaw Agent 通过 `AGENTLOG_AGENT_ID` 环境变量自动标识：

| Agent | source 值 | 说明 |
|-------|----------|------|
| Growth-Hacker | `openclaw:growth-hacker` | 增长工作 |
| Architect | `openclaw:architect` | 技术设计 |
| Builder | `openclaw:builder` | 开发实现 |
| Auditor | `openclaw:auditor` | 测试验证 |
| Librarian | `openclaw:librarian` | 存证管理 |
| Strategist | `openclaw:strategist` | 战略分析 |
| Sentinel | `openclaw:sentinel` | 竞品监控 |

### 2.3 MCP 查询接口（通用）

**接口**：`query_historical_interaction`

**通用调用参数**：
```json
{
  "source": "openclaw:<agent-name>",  // 动态传入
  "start_date": "2026-04-05T00:00:00+08:00",
  "end_date": "2026-04-06T00:00:00+08:00",
  "include_transcript": true,
  "page_size": 20
}
```

**通用返回结构**：
```json
{
  "success": true,
  "data": {
    "data": [
      {
        "id": "session_id",
        "source": "openclaw:<agent-name>",
        "created_at": "2026-04-05T10:30:00+08:00",
        "model": "MiniMax-M2.7",
        "transcript": [...],
        "response": "任务完成摘要",
        "reasoning_summary": "推理过程摘要",
        "affected_files": ["file1.ts", "file2.md"],
        "duration_ms": 300000
      }
    ],
    "total": 5,
    "page": 1,
    "pageSize": 20
  }
}
```

---

## 🏗️ 3. 通用日报脚本设计

### 3.1 命令行接口

```bash
# 通用调用方式
./agent-daily-report.sh --agent <AGENT_NAME> [--date YYYY-MM-DD]

# 示例
./agent-daily-report.sh --agent growth-hacker
./agent-daily-report.sh --agent architect
./agent-daily-report.sh --agent builder --date 2026-04-05
```

### 3.2 脚本参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--agent` | Agent 名称（必填） | - |
| `--date` | 查询日期 | 昨天 |
| `--output` | 输出格式（json/markdown） | markdown |
| `--dry-run` | 仅查询不发送 | false |

### 3.3 核心逻辑

```bash
# 1. 解析参数
AGENT_NAME="${ARG_AGENT:-growth-hacker}"
QUERY_DATE="${ARG_DATE:-$(date -d yesterday +%Y-%m-%d)}"
SOURCE="openclaw:${AGENT_NAME}"

# 2. 计算时间范围
START_DATE="${QUERY_DATE}T00:00:00+08:00"
END_DATE="$(date -d "${QUERY_DATE} +1 day" +%Y-%m-%d)T00:00:00+08:00"

# 3. 调用 MCP 查询
RESULT=$(mcporter call agentlog.query_historical_interaction \
  source="${SOURCE}" \
  start_date="${START_DATE}" \
  end_date="${END_DATE}" \
  include_transcript=true)

# 4. 解析结果
WORK_ITEMS=$(parse_transcript "$RESULT")

# 5. 填充模板
REPORT=$(fill_template "$AGENT_NAME" "$WORK_ITEMS")

# 6. 发送到对应飞书群
send_to_feishu "$AGENT_NAME" "$REPORT"
```

---

## 📁 4. Skill 实现

### 4.1 目录结构

```
skills/agentlog-daily-report/
├── SKILL.md                    # Skill 定义（通用）
├── agent-daily-report.sh       # 通用日报脚本
├── lib/
│   ├── query.sh                # MCP 查询封装
│   ├── parser.sh               # transcript 解析
│   └── template.sh             # 模板填充
└── templates/
    ├── architect.md            # Architect 日报模板
    ├── builder.md              # Builder 日报模板
    ├── growth-hacker.md        # Growth-Hacker 日报模板
    └── auditor.md             # Auditor 日报模板
```

### 4.2 transcript 解析（通用逻辑）

```bash
parse_transcript() {
  local json="$1"
  
  # 提取所有 assistant 消息中的有效工作内容
  echo "$json" | python3 -c "
import sys, json

data = json.load(sys.stdin)
sessions = data.get('data', {}).get('data', [])

work_items = []
for session in sessions:
    transcript = session.get('transcript', [])
    for msg in transcript:
        if msg.get('role') == 'assistant':
            content = msg.get('content', '')
            if isinstance(content, list):
                for block in content:
                    if block.get('type') == 'text':
                        text = block.get('text', '')[:200]
                        if text:
                            work_items.append(text)
            elif isinstance(content, str) and content:
                work_items.append(content[:200])

# 输出前 5 条
for item in work_items[:5]:
    print(item)
"
}
```

---

## 📋 5. 各 Agent 日报模板

### 5.1 Architect 模板

```markdown
# 🏗️ Architect 技术方案日报

**日期**: ${DATE}
**Agent**: Architect

## 📐 今日技术方案

${WORK_ITEMS}

## 📊 方案状态

| 方案 | 状态 | 说明 |
|------|------|------|
| [请填写] | [请填写] | |

## 🎯 明日计划

- [请填写]
```

### 5.2 Builder 模板

```markdown
# 🔧 Builder 开发进度日报

**日期**: ${DATE}
**Agent**: Builder

## 💻 今日开发

${WORK_ITEMS}

## 📦 代码提交

| 仓库 | Commit | 说明 |
|------|--------|------|
| [请填写] | [请填写] | |

## 🎯 明日计划

- [请填写]
```

### 5.3 Growth-Hacker 模板（保持现有）

```markdown
# 🚀 Growth Hacker 每日工作汇报

**日期**: ${DATE}
**Agent**: Growth Hacker

## 📊 昨日任务完成情况

${WORK_ITEMS}

## 📈 产品数据

- GitHub Stars: ⭐ [请填写]
- VS Code 下载量: [请填写]

## 🔄 GitHub 最近动态

${GH_COMMITS}
```

---

## 🔧 6. 配置管理

### 6.1 各 Agent 配置

每个 Agent 的 workspace 中添加配置文件 `daily-report.conf`：

```bash
# Architect
AGENT_NAME="architect"
FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/xxx-architect"

# Builder
AGENT_NAME="builder"
FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/xxx-builder"

# Growth-Hacker（保持现有）
AGENT_NAME="growth-hacker"
FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/xxx-growth"
```

### 6.2 Cron 配置

```bash
# 每个 Agent 的 crontab
# Architect: 9:30
30 9 * * * /path/to/agent-daily-report.sh --agent architect

# Builder: 9:30
30 9 * * * /path/to/agent-daily-report.sh --agent builder

# Growth-Hacker: 9:30（保持现有）
30 9 * * * /home/hobo/.openclaw/agents/growth-hacker/workspace/scripts/daily-report.sh
```

---

## ✅ 7. 验收标准

- [ ] `agent-daily-report.sh` 支持 `--agent` 参数
- [ ] 支持所有 OpenClaw Agent 查询
- [ ] 日报内容为真实存证数据（非 `[请填写]`）
- [ ] 各 Agent 飞书群收到格式化日报
- [ ] 通过 Auditor E2E 测试

---

## 📎 附录

### A. 相关文件

| 文件 | 路径 |
|------|------|
| 通用日报脚本 | `skills/agentlog-daily-report/agent-daily-report.sh` |
| MCP Server | `/home/hobo/Projects/agentlog/packages/backend/dist/mcp.js` |
| openclaw-agentlog SKILL | `/home/hobo/Projects/agentlog/skills/openclaw-agentlog/SKILL.md` |

### B. source 参数对照表

| Agent | source | 飞书群 |
|-------|--------|--------|
| growth-hacker | `openclaw:growth-hacker` | 增长日报群 |
| architect | `openclaw:architect` | 技术架构群 |
| builder | `openclaw:builder` | 开发进度群 |
| auditor | `openclaw:auditor` | 测试验证群 |
| librarian | `openclaw:librarian` | 存证管理群 |
| strategist | `openclaw:strategist` | 战略分析群 |
| sentinel | `openclaw:sentinel` | 竞品监控群 |
