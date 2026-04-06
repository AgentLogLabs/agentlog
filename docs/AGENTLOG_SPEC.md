
# 📄 AgentLog Product & Technical Specification (Open Spec v2.1)

> ⚠️ **版本说明**: v2.0 描述 session-based 架构；v2.1 升级为 **Trace/Span 层级化架构**，支持更细粒度的 AI 操作追溯。

## 1. 🎯 Project Overview & Vision (项目愿景)
**AgentLog** 是一款面向 AI 时代的"代码治理与上下文恢复（AI Code Governance & Context Recovery）"的本地开发者工具。

### 1.1 Core Problem & Solution (核心痛点与解法)
*   **痛点**: AI 生成代码速度远超人类审查速度，且 AI 的"意图与推理过程"在代码提交后会永远丢失。当人类开发者或新 Agent 接手时，面临"缺乏上下文"的黑盒灾难。
*   **解法 (极简认知模型)**: 拒绝创造诸如 "Checkpoint" 等脱离开发者习惯的新概念。**Git Commit 就是唯一的检查点**。我们将 AI 在编码过程中的所有对话和思考（`Trace`），无感地打包挂载到原生的 `Git Commit` 上。

### 1.2 Core Principles (核心原则)
1.  **Local-First (纯本地化)**: 所有上下文、对话日志强制保存在本地 SQLite (`~/.agentlog/agentlog.db`)，满足企业最高数据隐私要求。
2.  **Standardized Protocol (标准协议驱动)**: 彻底抛弃 IDE 底层 API 拦截与网络嗅探（No Hack / No Monkey-patch）。使用 **MCP (Model Context Protocol)** 让 AI 主动上报工作状态，使用 **Git Hook** 作为闭源生态的底层兜底。
3.  **Hierarchical Tracing (层级化追溯)**: 引入 **Trace/Span** 数据模型，将 AI 工作流拆解为层级化的操作单元，支持细粒度的操作回溯与性能分析。
4.  **Context Recoverability (一键复活)**: 核心杀手锏功能。允许开发者在 VS Code 侧边栏回溯历史 Commit，一键提取并复活当时 AI 的上下文到当前剪贴板或对话框（Attach / Resume）。

---

## 2. 🏗️ System Architecture (系统架构)
采用 `pnpm` Monorepo 架构，严格前后端分离：
*   **`packages/shared`**: 核心类型定义（TypeScript DTOs）。
*   **`packages/backend`**: 独立 Node.js 进程。包含 SQLite 数据库操作、提供给前端的 Fastify REST API，以及暴露给 AI Agent 调用的本地 MCP Server。
*   **`packages/vscode-extension`**: 纯前端展现与生命周期管理。负责拉起 backend 进程，提供 TreeView 侧边栏面板和 Webview 详情页。
*   **`packages/openclaw-agent`**: OpenClaw Agent 集成包，包含 `agentlog-auto` skill（自动记录）和 `agentlog-daily-report` skill（日报生成）。

---

## 3. 📊 Data Models (数据模型 Schema v2.1)
> ⚠️ **Agent Notice**: v2.1 采用 Trace/Span 层级化架构，同时保留 `agent_sessions` 表用于向后兼容。新增功能请优先使用 Trace/Span API。

底层使用 SQLite (`better-sqlite3`)。

### 3.1 `traces` (AI 工作轨迹主表)
记录一次完整的 AI 工作任务，包含多个 span。
*   `id`: TEXT PRIMARY KEY (ULID)
*   `parent_trace_id`: TEXT (可选，支持 trace 分叉)
*   `task_goal`: TEXT (任务目标描述)
*   `status`: TEXT (`running` | `completed` | `failed` | `paused`)
*   `affected_files`: TEXT (JSON Array `["src/a.ts"]`)
*   `workspace_path`: TEXT (工作区路径)
*   `created_at`: TEXT (ISO 8601)
*   `updated_at`: TEXT (ISO 8601)

### 3.2 `spans` (操作单元)
Trace 下的层级化操作单元，构成完整的 Span Tree。
*   `id`: TEXT PRIMARY KEY (ULID)
*   `trace_id`: TEXT (FK → traces.id)
*   `parent_span_id`: TEXT (FK → spans.id，顶级 span 为 NULL)
*   `actor_type`: TEXT (`human` | `agent` | `system`)
*   `actor_name`: TEXT (执行者名称)
*   `payload`: TEXT (JSON Object，包含 event, toolName, toolInput, toolResult, timestamp, tokenUsage 等)
*   `created_at`: TEXT (ISO 8601)

### 3.3 `agent_sessions` (AI 交互过程 - 兼容保留)
记录 AI 一次或多轮完整的工作会话（向后兼容）。
*   `id`: TEXT PRIMARY KEY
*   `created_at`: TEXT (ISO 8601)
*   `provider`: TEXT (e.g., openai, anthropic, local)
*   `model`: TEXT
*   `source`: TEXT (e.g., mcp, git_hook)
*   `workspace_path`: TEXT
*   `prompt`: TEXT (用户提示)
*   `reasoning`: TEXT (模型推理过程，可为 NULL)
*   `response`: TEXT (模型最终响应)
*   `commit_hash`: TEXT (关联的 Git Commit，未提交时为 NULL/空)
*   `affected_files`: TEXT (JSON Array `["src/a.ts"]`)
*   `duration_ms`: INTEGER
*   `tags`: TEXT (JSON Array)
*   `metadata`: TEXT (JSON Object)
*   `transcript`: TEXT (JSON Array, 逐轮对话记录 `[{role: "user", content: "..."}]`)
*   `token_usage`: TEXT (JSON Object `{"inputTokens": 100, ...}`)

### 3.4 `commit_bindings` (结果绑定)
记录 Git Commit 与 AI 会话/Trace 的映射关系。
*   `commit_hash`: TEXT PRIMARY KEY
*   `session_ids`: TEXT (JSON Array, 兼容旧数据)
*   `trace_ids`: TEXT (JSON Array, v2.1 新增)
*   `message`: TEXT (Commit Message)
*   `committed_at`: TEXT
*   `author_name`: TEXT
*   `author_email`: TEXT
*   `changed_files`: TEXT (JSON Array)
*   `workspace_path`: TEXT

---

## 4. 🔄 Core Workflows (核心业务流)

### 4.1 Flow A: The Trace/Span Write Path (主动记录)
1.  OpenClaw Agent 启动时，`agentlog-auto` skill 自动创建 Trace (`POST /api/traces`)
2.  Agent 在修改完代码后，调用 `POST /api/spans` 记录操作单元
3.  Backend 接收数据，创建 span 记录（此时 trace 状态为 `running`）
4.  Agent 完成任务后，调用 `PATCH /api/traces/:id` 更新状态为 `completed` 或 `failed`

**REST API 端点**:
*   `POST /api/traces` - 创建新 Trace
*   `GET /api/traces` - 查询 Trace 列表
*   `GET /api/traces/:id` - 获取单个 Trace
*   `PATCH /api/traces/:id` - 更新 Trace 状态/任务目标
*   `POST /api/spans` - 创建 Span
*   `GET /api/traces/:id/spans` - 获取 Trace 下的所有 Span

### 4.2 Flow B: The Git Hook Bind Path (自动绑定)
1.  用户在终端或 VS Code 中执行 `git commit`。
2.  触发预先安装的 `.git/hooks/prepare-commit-msg`，该脚本向后台发起 `POST /api/hooks/commit` 请求。
3.  **Backend 绑定逻辑 (事务操作)**:
    *   查找当前工作区所有状态为 `running` 且时间相近的 `traces`。
    *   将这些 Trace 的 ID 打包，创建或更新一条 `commit_bindings` 记录。
    *   同时，将这些 `traces` 的状态保持不变（Trace 独立于 Commit）。
    *   *(兜底)*: 如果没找到任何挂起的 Trace，则读取 `git diff`，调用轻量大模型生成简要意图，补写一条 Trace 并绑定。

### 4.3 Flow C: The Context Resume Path (上下文复活)
1.  用户在 VS Code 侧边栏看到 "📦 进行中的 Trace" 或 "📚 历史 Commit 记录"。
2.  用户点击某个 Trace，在 Webview 中查看详细的 Span Tree 和操作历史。
3.  用户点击界面上的 **"Resume Context (复活上下文)"** 按钮。
4.  VS Code 扩展提取该 Trace 的历史数据，格式化为 Markdown 提示词，并调用 VS Code API 写入系统剪贴板（或直接插入活动编辑器），让人类/新 Agent 瞬间接管历史记忆。

### 4.4 Flow D: The Daily Report Path (日报生成)
1.  `agentlog-daily-report` skill 定时触发（或手动调用）
2.  调用 `GET /api/traces/search` 查询当日所有 traces
3.  调用 `GET /api/traces/:id/summary` 获取每个 trace 的统计信息
4.  组装日报内容，输出到指定位置

---

## 5. ✅ Implementation Status (实施状态)

> v2.1 更新日期: 2026-04-06 (PR #18 合并后)

### 已完成
- [x] **Trace/Span 数据模型** - `packages/backend/src/db/database.ts` (Schema v7-v10)
- [x] **REST API 路由** - `packages/backend/src/routes/traces.ts`, `spans.ts`
- [x] **Git Hook 绑定** - `packages/backend/src/routes/hooks.ts` (支持 trace_ids)
- [x] **MCP Server** - `packages/backend/src/mcp.ts` (保留兼容)
- [x] **OpenClaw Agent Skills**:
  - `agentlog-auto` - 自动 trace/span 记录
  - `agentlog-daily-report` - 日报生成
  - `openclaw-agent-log` - MCP 协议支持

### 进行中
- [ ] **VS Code UI 更新** - Trace Tree View 支持（当前 UI 仍基于 session）

### 待开发
- [ ] **Context Resume 增强** - 基于 Trace/Span 的上下文复活
- [ ] **Span Tree 可视化** - Webview 中的树状结构展示

---

## 6. 📚 Changelog

### v2.1 (2026-04-06)
- **破坏性变更**: 引入 Trace/Span 层级化架构
- 新增 `traces` 表 (Schema v7)
- 新增 `spans` 表 (Schema v7)
- 新增 Trace/Span REST API (`/api/traces`, `/api/spans`)
- `commit_bindings` 新增 `trace_ids` 字段
- `agentlog-auto` skill 升级为 trace/span API
- 新增 `agentlog-daily-report` skill
- 新增 `openclaw-agent-log` skill (MCP 协议支持)

### v2.0 (初始版本)
- Session-based 架构
- `agent_sessions` + `commit_bindings` 双表绑定
- MCP `record_session_intent` Tool

---

*END OF SPEC. When making changes, ensure backward compatibility with `agent_sessions` table or document migration path.*