# AgentLog 数据模型

> 基于 `packages/backend/src/db/database.ts` Schema 定义

## 概述

- **数据库**: SQLite (better-sqlite3)
- **存储路径**: `~/.agentlog/agentlog.db` (可通过 `AGENTLOG_DB_PATH` 环境变量覆盖)
- **当前 Schema 版本**: 2

## 表结构

### 1. agent_sessions

AI 交互会话的完整记录。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PRIMARY KEY | 会话唯一标识 |
| `created_at` | TEXT | 创建时间 (ISO 8601) |
| `provider` | TEXT | AI provider (如 openai, anthropic) |
| `model` | TEXT | 模型名称 |
| `source` | TEXT | 会话来源 (默认 unknown) |
| `workspace_path` | TEXT | 工作区路径 |
| `prompt` | TEXT | 用户提示 |
| `reasoning` | TEXT | 模型推理过程 (可为 NULL，如 DeepSeek-R1) |
| `response` | TEXT | 模型响应 |
| `commit_hash` | TEXT | 关联的 Git commit hash |
| `affected_files` | TEXT | JSON 数组，涉及的文件列表 |
| `duration_ms` | INTEGER | 会话耗时 (毫秒) |
| `tags` | TEXT | JSON 数组，标签 |
| `note` | TEXT | 备注 |
| `metadata` | TEXT | JSON 对象，provider 特定扩展字段 |
| `transcript` | TEXT | JSON 数组，每条为 TranscriptTurn (v2 新增) |
| `token_usage` | TEXT | JSON 对象，Token 用量统计 (v2 新增) |

**索引**:
- `idx_sessions_created_at` (created_at)
- `idx_sessions_workspace` (workspace_path)
- `idx_sessions_provider` (provider)
- `idx_sessions_commit_hash` (commit_hash)

---

### 2. commit_bindings

Git Commit 与 AgentSession 的绑定关系。

| 字段 | 类型 | 说明 |
|------|------|------|
| `commit_hash` | TEXT PRIMARY KEY | Git commit hash |
| `session_ids` | TEXT | JSON 数组，关联的 session IDs |
| `message` | TEXT | commit 消息 |
| `committed_at` | TEXT | 提交时间 |
| `author_name` | TEXT | 提交者名称 |
| `author_email` | TEXT | 提交者邮箱 |
| `changed_files` | TEXT | JSON 数组，变更的文件列表 |
| `workspace_path` | TEXT | 工作区路径 |

**索引**:
- `idx_commits_committed_at` (committed_at)
- `idx_commits_workspace` (workspace_path)

---

### 3. schema_version

Schema 版本管理。

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | INTEGER | 版本号 |
| `applied_at` | TEXT | 应用时间 |

---

## 迁移历史

| 版本 | 变更 |
|------|------|
| 1 | 初始版本：创建 agent_sessions, commit_bindings 表及索引 |
| 2 | 新增 `transcript` 列 (JSON 数组，存储逐轮对话) 和 `token_usage` 列 (JSON 对象，Token 用量统计) |

---

## JSON 字段格式

- **affected_files**: `["src/foo.ts", "src/bar.ts"]`
- **tags**: `["bugfix", "重构"]`
- **metadata**: `{}`
- **transcript**: `[{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]`
- **token_usage**: `{"inputTokens": 100, "outputTokens": 200, "cache": 50}`

---

## 工具函数

```typescript
toJson(value: unknown): string        // 序列化 JS 数组/对象为 JSON 字符串
fromJson<T>(raw: string, fallback: T): T  // 反序列化 JSON 字符串
```
