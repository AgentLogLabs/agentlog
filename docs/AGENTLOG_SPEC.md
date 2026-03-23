
# 📄 AgentLog Product & Technical Specification (Open Spec v2.0)

## 1. 🎯 Project Overview & Vision (项目愿景)
**AgentLog** 是一款面向 AI 时代的“代码治理与上下文恢复（AI Code Governance & Context Recovery）”的本地开发者工具。

### 1.1 Core Problem & Solution (核心痛点与解法)
*   **痛点**: AI 生成代码速度远超人类审查速度，且 AI 的“意图与推理过程”在代码提交后会永远丢失。当人类开发者或新 Agent 接手时，面临“缺乏上下文”的黑盒灾难。
*   **解法 (极简认知模型)**: 拒绝创造诸如 "Checkpoint" 等脱离开发者习惯的新概念。**Git Commit 就是唯一的检查点**。我们将 AI 在编码过程中的所有对话和思考（`Session`），无感地打包挂载到原生的 `Git Commit` 上。

### 1.2 Core Principles (核心原则)
1.  **Local-First (纯本地化)**: 所有上下文、对话日志强制保存在本地 SQLite (`~/.agentlog/agentlog.db`)，满足企业最高数据隐私要求。
2.  **Standardized Protocol (标准协议驱动)**: 彻底抛弃 IDE 底层 API 拦截与网络嗅探（No Hack / No Monkey-patch）。使用 **MCP (Model Context Protocol)** 让 AI 主动上报工作状态，使用 **Git Hook** 作为闭源生态的底层兜底。
3.  **Context Recoverability (一键复活)**: 核心杀手锏功能。允许开发者在 VS Code 侧边栏回溯历史 Commit，一键提取并复活当时 AI 的上下文到当前剪贴板或对话框（Attach / Resume）。

---

## 2. 🏗️ System Architecture (系统架构)
采用 `pnpm` Monorepo 架构，严格前后端分离：
*   **`packages/shared`**: 核心类型定义（TypeScript DTOs）。
*   **`packages/backend`**: 独立 Node.js 进程。包含 SQLite 数据库操作、提供给前端的 Fastify REST API，以及暴露给 AI Agent 调用的本地 MCP Server。
*   **`packages/vscode-extension`**: 纯前端展现与生命周期管理。负责拉起 backend 进程，提供 TreeView 侧边栏面板和 Webview 详情页。

---

## 3. 📊 Data Models (数据模型 Schema v2)
> ⚠️ **Agent Notice**: 当前采用双向绑定结构，在写入时请注意同时更新 `commit_bindings` 和 `agent_sessions`，隐患暂不在此版本处理。

底层使用 SQLite (`better-sqlite3`)。

### 3.1 `agent_sessions` (AI 交互过程)
记录 AI 一次或多轮完整的工作会话。
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

### 3.2 `commit_bindings` (结果绑定)
记录 Git Commit 与一系列 AI 会话的映射关系。
*   `commit_hash`: TEXT PRIMARY KEY
*   `session_ids`: TEXT (JSON Array, e.g., `["session_1", "session_2"]`)
*   `message`: TEXT (Commit Message)
*   `committed_at`: TEXT
*   `author_name`: TEXT
*   `author_email`: TEXT
*   `changed_files`: TEXT (JSON Array)
*   `workspace_path`: TEXT

---

## 4. 🔄 Core Workflows (核心业务流)

### 4.1 Flow A: The MCP Write Path (主动记录)
1.  支持 MCP 的 Agent (如 Cline, Roo) 连接到我们 backend 的 MCP Server。
2.  Agent 在修改完代码后，主动调用 MCP Tool `record_session_intent`。
3.  Backend 接收数据，创建一条 `agent_sessions` 记录（此时 `commit_hash` 留空，表示这是一个 "Uncommitted / Dangling Session"）。

### 4.2 Flow B: The Git Hook Bind Path (自动绑定)
1.  用户在终端或 VS Code 中执行 `git commit`。
2.  触发预先安装的 `.git/hooks/prepare-commit-msg`，该脚本向后台发起 `POST /api/hooks/commit` 请求。
3.  **Backend 绑定逻辑 (事务操作)**:
    *   查找当前工作区所有 `commit_hash` 为空且时间相近的 `agent_sessions`。
    *   将这些 Session 的 ID 打包，创建或更新一条 `commit_bindings` 记录。
    *   同时，将这些 `agent_sessions` 的 `commit_hash` 字段更新为当前的 Git Hash。
    *   *(兜底)*: 如果没找到任何挂起的 Session，则读取 `git diff`，调用轻量大模型生成简要意图，补写一条 Session 并绑定。

### 4.3 Flow C: The Context Resume Path (上下文复活)
1.  用户在 VS Code 侧边栏看到 "📦 未提交的 AI 会话" 或 "📚 历史 Commit 记录"。
2.  用户点击某个 Session，在 Webview 中查看详细的 `reasoning` 和 `transcript`。
3.  用户点击界面上的 **"Resume Context (复活上下文)"** 按钮。
4.  VS Code 扩展提取该 Session 的历史数据，格式化为 Markdown 提示词，并调用 VS Code API 写入系统剪贴板（或直接插入活动编辑器），让人类/新 Agent 瞬间接管历史记忆。

---

## 5. 🚀 Action Items (Agent 任务执行清单)

**AI Agent 请注意：请严格按照以下 Step 顺序执行，每完成一个 Step 必须输出运行结果并与人类确认。**

### Step 1: 🧹 彻底清理旧架构 (Clean Slate)
*   **目标**: 移除所有 IDE 强绑定与网络拦截代码。
*   **行动**: 
    1. 删除 `vscode-extension` 下所有 `interceptors/` (如 HTTP Patch, Copilot Hook) 相关的代码和文件。
    2. 清理 `package.json` 中相关的无用依赖。
    3. 确保前端只保留纯净的 UI 渲染和 VS Code API 桥接逻辑。

### Step 2: 🗄️ 巩固数据层 (Data Access Layer)
*   **目标**: 确保 SQLite 严格按照 v2 Schema 运行，并支持双表事务。
*   **行动**:
    1. 检查 `backend/src/db/database.ts`，确保 `agent_sessions` 和 `commit_bindings` 表结构与 Spec 完全一致，并支持 JSON 字段的自动序列化/反序列化。
    2. 在 Database service 中实现一个事务函数 `bindSessionsToCommit(commitHash, sessionIds, commitMeta)`，确保两张表的数据一致性。

### Step 3: 🔌 实现 MCP Server (基建核心)
*   **目标**: 允许 Agent 主动汇报。
*   **行动**:
    1. 在 backend 中使用 `@modelcontextprotocol/sdk` 初始化本地 Server。
    2. 暴露 Tool: `record_session_intent`。
    3. 参数 Schema: `prompt` (string), `reasoning` (string, 可选), `response` (string), `affected_files` (array of strings)。
    4. 业务逻辑：接收到 Tool 调用后，生成一个新的 UUID，将上述信息连同 `provider="mcp"` 等默认字段写入 `agent_sessions` 表。关键点：此时 `commit_hash` 必须设置为 `NULL` 或空字符串。

### Step 4: 🪝 实现 Git Hook 兜底与绑定机制 (The Git Hook)
*   **目标**: 在 `git commit` 时自动打包游离的 Sessions。
*   **行动**:
    1. 在 `backend/src/routes/hooks.ts` 中实现一个 `POST /api/hooks/commit` 接口。
    2. 接口逻辑：
       - 接收参数：`commit_hash`, `message`, `author_name`, `author_email`, `changed_files`, `workspace_path`。
       - 查找该 `workspace_path` 下所有 `commit_hash` 为空的 `agent_sessions`。
       - **分支 A (有游离 Session)**：调用 Step 2 中的事务函数，将这些 Session 的 ID 写入 `commit_bindings`，并更新这些 Session 的 `commit_hash`。
       - **分支 B (无游离 Session - 兜底逻辑)**：如果没找到，且配置了兜底 LLM，则读取 Git Diff，调用极轻量的本地/云端 API 生成一份简短的 `intent` 和 `reasoning`，创建一条新的 `agent_sessions` 记录，然后执行绑定。
    1. 在 VS Code 插件中提供一个命令：`"AgentLog: Install Git Hook"`，向当前工作区的 `.git/hooks/prepare-commit-msg` 注入调用该 API 的 Bash/Node 脚本。

### Step 5: 🖥️ VS Code UI 与核心交互 (The Attach/Resume Feature)
*   **目标**: 打造超越 Entire CLI 的用户体验，让开发者能够一键复活 AI 记忆。
*   **行动**:
    1. **视图重构**：实现 `SessionTreeProvider`，侧边栏分为两组：
       - 📦 **Uncommitted Sessions (暂存区)**: 查询 `commit_hash` 为空的记录。
       - 📚 **Commit History (历史记录)**: 按时间倒序展示 `commit_bindings`，展开可看到关联的 `agent_sessions`。
    2. **详情查看**：点击节点触发 `SessionWebviewProvider`，在右侧大屏用精美的 Markdown 渲染 `reasoning`, `prompt` 和 `transcript`。
    3. **杀手级功能实现**：注册 VS Code Command `agentlog.resumeContext`。
       - 逻辑：读取指定的 Session 数据，将其组装为高质量的上下文 Prompt（例如：`"【历史 AI 上下文复活】\n原始任务：{prompt}\n历史推理：{reasoning}\n请基于此上下文继续工作..."`）。
       - 动作：将这段文本写入系统剪贴板 (`vscode.env.clipboard.writeText`)，并在 VS Code 右下角弹出 Toast 提示："✅ 上下文已复制，请将其粘贴到 Cline/Cursor 的聊天框中继续工作。"
## 6. 注意事项
如果代码已经实现了Spec功能，请确认不要改动错了。
---
*END OF SPEC. Agent, please confirm you have read and understood this spec completely before proceeding to Step 1. Output "ACK" and a brief summary of your first move.*