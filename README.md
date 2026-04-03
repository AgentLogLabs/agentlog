# AgentLog — AI 编程飞行记录仪

<img src="packages/vscode-extension/assets/logo.png" width="128" />

> 一款面向国内主流大模型的 VS Code/Cursor 插件 + 本地轻量后台，自动捕获 AI Agent 交互日志，与 Git Commit 绑定，一键导出周报或 PR 说明。

[![Version](https://img.shields.io/badge/version-v0.5.0-blue.svg)](https://github.com/AgentLogLabs/agentlog)
[![License](https://img.shields.io/badge/license-Apache%202.0-green.svg)](./LICENSE)

---

## 📑 索引

[核心功能](#核心功能) · [快速开始](#快速开始) · [后台 API](#后台-api-一览) · [数据模型](#数据模型) · [配置项](#配置项) · [Git Worktree](#git-worktree-多-agent-并行支持) · [路线图](#路线图) · [FAQ](#常见问题faq) · [开发贡献](#开发贡献)

---

## 背景与痛点

国内开发者大量使用 Cursor、Cline 或基于 DeepSeek/Qwen API 的本地 Agent。代码虽然写得快，但过几天开发者自己都忘了当时 AI 为什么这么改，出了 Bug 无从下手。

**AgentLog** 解决的就是这个问题：在你与 AI 交互时，静默地在后台记录一切，并在你 `git commit` 时自动将这些记录与代码变更绑定。

---

## 核心功能

| 功能 | 说明 |
|------|------|
| 🎙️ **自动捕获** | 拦截发往 DeepSeek / Qwen / Kimi 等 API 的请求，提取 Prompt + Response |
| 🧠 **推理过程保存** | 专项支持 DeepSeek-R1 的 `<think>` 推理链，完整存储中间思考步骤 |
| 🔗 **Git Commit 绑定** | 通过 post-commit 钩子，自动将每次提交与相关 AI 会话关联 |
| 🌿 **Git Worktree 支持** | 多个 AI Agent 可同时在不同 worktree 上并行工作，各自会话精准绑定到对应 Commit，互不干扰 |
| 📊 **侧边栏面板** | VS Code 侧边栏显示会话列表、Commit 绑定关系、统计数据 |
| 📝 **一键导出** | 支持导出为中文周报、PR/Code Review 说明、JSONL 原始数据、CSV 表格 |
| 🏠 **本地优先** | 所有数据存储在本机 SQLite（`~/.agentlog/agentlog.db`），完全离线可用 |

---

## 支持的模型与工具

### 国内主流模型

| 模型 | 提供商 | 说明 |
|------|--------|------|
| DeepSeek-V3 / R1 | DeepSeek | 完整支持推理链捕获 |
| 通义千问 Qwen-Max / Plus | 阿里云 DashScope | OpenAI 兼容模式 |
| Kimi / Moonshot | 月之暗面 | OpenAI 兼容模式 |
| 豆包 | 字节跳动 Ark | OpenAI 兼容模式 |
| ChatGLM | 智谱 AI | OpenAI 兼容模式 |
| 本地模型 | Ollama / LM Studio | 本地 HTTP 接口 |

### 支持的 AI 编程工具

- **Cline**（VS Code 插件）
- **Cursor**（IDE 内置 AI）
- **Continue**（VS Code 插件）
- **直接 API 调用**（通过 HTTP 拦截）

---

## 技术栈

| 层次 | 技术 |
|------|------|
| Monorepo | pnpm workspaces |
| 语言 | TypeScript 5.x（全栈） |
| 后台框架 | Fastify 4.x |
| 数据库 | SQLite via `better-sqlite3`（WAL 模式） |
| Git 集成 | `simple-git` |
| VS Code API | `@types/vscode ^1.85` |
| 拦截机制 | Node.js `http/https` Monkey-patch |
| ID 生成 | `nanoid` |

---

## 快速开始

```bash
# 克隆并安装依赖
git clone https://github.com/AgentLogLabs/agentlog.git && cd agentlog && pnpm install

# 构建全部
pnpm build

# 启动后台开发服务
pnpm dev

# 在 VS Code 中按 F5 调试扩展
```

---

## 后台 API 一览

后台默认运行在 `http://localhost:7892`，可通过环境变量 `AGENTLOG_PORT` 覆盖。

### 会话接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sessions` | 上报新会话 |
| `GET` | `/api/sessions` | 分页查询（支持多维过滤） |
| `GET` | `/api/sessions/stats` | 统计数据 |
| `GET` | `/api/sessions/unbound` | 查询未绑定 Commit 的会话 |
| `GET` | `/api/sessions/:id` | 获取单条会话详情 |
| `PATCH` | `/api/sessions/:id/tags` | 更新标签 |
| `PATCH` | `/api/sessions/:id/note` | 更新备注 |
| `PATCH` | `/api/sessions/:id/commit` | 手动绑定/解绑 Commit |
| `DELETE` | `/api/sessions/:id` | 删除会话 |

### Commit 绑定接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/commits/hook` | Git post-commit 钩子接收端 |
| `POST` | `/api/commits/bind` | 手动批量绑定 |
| `DELETE` | `/api/commits/unbind/:sessionId` | 解绑 |
| `GET` | `/api/commits` | 列出所有绑定记录 |
| `GET` | `/api/commits/:hash` | 查询指定 Commit 的绑定信息 |
| `GET` | `/api/commits/:hash/sessions` | 获取 Commit 关联的所有会话 |
| `GET` | `/api/commits/:hash/context` | 生成 Commit 的 AI 交互上下文文档（Query 传参） |
| `POST` | `/api/commits/:hash/context` | 生成 Commit 的 AI 交互上下文文档（Body 传参） |
| `GET` | `/api/commits/:hash/explain` | 生成 Commit 的 AI 交互解释摘要（Query 传参） |
| `POST` | `/api/commits/:hash/explain` | 生成 Commit 的 AI 交互解释摘要（Body 传参） |
| `POST` | `/api/commits/hook/install` | 注入 Git 钩子 |
| `DELETE` | `/api/commits/hook/remove` | 移除 Git 钩子 |

### 导出接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/export/formats` | 获取支持的导出格式列表 |
| `POST` | `/api/export` | 生成导出内容 |
| `POST` | `/api/export/preview` | 预览（前 50 行） |

---

## 数据模型

### AgentSession（AI 交互会话）

```typescript
interface AgentSession {
  id: string;              // nanoid
  createdAt: string;       // ISO 8601
  provider: ModelProvider; // 'deepseek' | 'qwen' | 'kimi' | ...
  model: string;           // 实际模型名，例如 "deepseek-r1"
  source: AgentSource;     // 'cline' | 'cursor' | 'continue' | ...
  workspacePath: string;   // 工作区绝对路径（多 worktree 场景下为各 worktree 路径）
  gitRepoRoot?: string;    // Git 仓库根目录（多 worktree 共享，用于跨 worktree 绑定）
  prompt: string;          // 用户输入的完整 Prompt
  reasoning?: string;      // AI 推理过程（DeepSeek-R1 的 <think> 内容）
  response: string;        // AI 最终回复
  commitHash?: string;     // 绑定的 Git Commit SHA
  affectedFiles: string[]; // 涉及的文件列表
  durationMs: number;      // 交互耗时（毫秒）
  tags?: string[];         // 用户标签
  note?: string;           // 用户备注
  metadata?: Record<string, unknown>; // 扩展字段
}
```

### CommitBinding（Commit 绑定）

```typescript
interface CommitBinding {
  commitHash: string;      // Git 完整 SHA-1
  sessionIds: string[];    // 关联的会话 ID 列表
  message: string;         // Commit message
  committedAt: string;     // 提交时间
  authorName: string;      // 提交者
  authorEmail: string;
  changedFiles: string[];  // 变更文件列表
  workspacePath: string;
}
```

### Commit 上下文与解释

通过 `/api/commits/:hash/context` 和 `/api/commits/:hash/explain` 接口，可以将指定 Commit 关联的所有 AI 交互记录汇总为结构化文档，直接用于新 AI 对话的上下文注入。

**Context（上下文文档）**支持 Markdown / JSON / XML 三种格式输出，可通过以下选项控制内容：

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `format` | `'markdown' \| 'json' \| 'xml'` | `'markdown'` | 输出格式 |
| `language` | `'zh' \| 'en'` | `'zh'` | 输出语言 |
| `includePrompts` | `boolean` | `true` | 是否包含用户 Prompt |
| `includeResponses` | `boolean` | `true` | 是否包含模型 Response |
| `includeReasoning` | `boolean` | `true` | 是否包含推理过程 |
| `includeChangedFiles` | `boolean` | `true` | 是否包含变更文件列表 |
| `maxContentLength` | `number` | `2000` | 单条内容最大字符数（0 = 不截断） |
| `maxSessions` | `number` | `0` | 最多包含的会话数量（0 = 不限制） |

**Explain（解释摘要）**输出 Markdown 格式，包含总体概述、逐条会话要点（用户意图 / AI 回应 / 是否包含推理）以及涉及文件汇总。

---

## 配置项

在 VS Code 设置（`settings.json`）中，所有配置项以 `agentlog.` 为前缀：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `backendUrl` | `http://localhost:7892` | 后台服务地址 |
| `autoCapture` | `true` | 是否自动捕获 AI 交互 |
| `captureReasoning` | `true` | 是否捕获推理过程 |
| `autoBindOnCommit` | `true` | commit 时自动绑定最近未绑定的会话 |
| `retentionDays` | `90` | 数据保留天数（0 = 永久） |
| `autoStartBackend` | `true` | VS Code 启动时自动启动后台 |
| `debug` | `false` | 开启调试日志 |
| `exportLanguage` | `zh` | 导出语言（`zh` / `en`） |
| `interceptors.cline` | `true` | 是否捕获 Cline 的请求 |
| `interceptors.cursor` | `true` | 是否捕获 Cursor 的请求 |

---

## Git Worktree 多 Agent 并行支持

AgentLog 完整支持 `git worktree` 场景，多个 AI Agent 可以同时在同一仓库的不同 worktree 上独立工作，所有会话记录精准绑定到各自的 Commit，互不干扰。

### 工作原理

```
主仓库                     Worktree A               Worktree B
my-repo/                   my-repo-feat-login/       my-repo-fix-bug/
  .git/                      (共享同一 .git)           (共享同一 .git)
  src/                       src/                     src/
    ...                        ...                      ...

Agent-1 在此工作            Agent-2 在此工作          Agent-3 在此工作
→ session.workspacePath     → session.workspacePath   → session.workspacePath
  = "my-repo"                 = "my-repo-feat-login"    = "my-repo-fix-bug"
→ session.gitRepoRoot       → session.gitRepoRoot     → session.gitRepoRoot
  = "my-repo"                 = "my-repo"               = "my-repo"
```

**关键改进（Schema v4）**：

1. **`gitRepoRoot` 字段**：`agent_sessions` 表新增此字段，存储 Git 仓库根目录路径。无论会话发生在哪个 worktree，同一仓库下的所有会话共享相同的 `gitRepoRoot`。

2. **动态钩子脚本**：post-commit 钩子不再硬编码工作区路径，改为通过 `git rev-parse --show-toplevel` 在运行时动态获取当前 worktree 的真实路径，一次安装，所有 worktree 均生效。

3. **三级匹配策略**：post-commit 触发时，后端按以下顺序查找未绑定会话：
   - **Level 1（精确）**：按当前 worktree 的 `workspace_path` 精确匹配
   - **Level 2（跨 worktree）**：按 `git_repo_root` 匹配同仓库其他 worktree 的会话
   - **Level 3（兜底）**：生成自动摘要 Session（原有逻辑）

4. **会话自动推断**：创建 Session 时后端自动通过 `git rev-parse --show-toplevel` 填充 `gitRepoRoot`，Agent 无需手动传入。

### 使用方式

只需在**任意一个** worktree（通常是主仓库）安装 Git 钩子，所有 worktree 均自动支持：

```bash
# 在 VS Code 中执行命令：AgentLog: Install Git Hook
# 或通过 API：
curl -X POST http://localhost:7892/api/commits/hook/install \
  -H "Content-Type: application/json" \
  -d '{"workspacePath": "/path/to/my-repo"}'
```

---

## 隐私与安全

- **所有数据均存储在本机**，默认路径 `~/.agentlog/agentlog.db`
- 后台服务仅监听 `127.0.0.1`，不对外网暴露
- CORS 策略仅允许 `localhost` 和 VS Code Webview 来源
- 不收集任何遥测数据，不联网上报

---

## 路线图

### MVP（当前）

- [x] 基础脚手架（monorepo + 类型定义 + 后台 + 插件）
- [x] SQLite 数据库 + 迁移系统
- [x] REST API（会话 CRUD + 导出 + Commit 绑定）
- [x] HTTP 拦截器（支持流式 SSE 响应）
- [x] VS Code 侧边栏 TreeView
- [x] 会话详情 Webview + 仪表板
- [x] Git post-commit 钩子注入
- [x] 中文周报 / PR 说明导出

### 已完成

- [x] Commit 上下文文档生成（Markdown / JSON / XML）
- [x] Commit AI 交互解释摘要生成
- [x] Context & Explain REST API（GET/POST）
- [x] 中英文国际化支持
- [x] 内容截断 / 会话数量限制等精细控制选项
- [x] **Git Worktree 多 Agent 并行支持**（多个 AI Agent 同时在不同 worktree 上工作，各自会话精准绑定，不互相干扰）

### 后续计划

- [x] VS Code 扩展集成：新增「生成 Commit 上下文」「生成 Commit 解释」命令
- [x] 侧边栏 / Webview 中展示上下文文档与解释摘要，支持一键复制
- [ ] 将上下文文档无缝注入新 AI 对话（粘贴到 Cline / Cursor / Continue 对话框）
- [ ] Context & Explain 单元测试与集成测试
- [ ] Webview 仪表板 UI 完善（React + VS Code UI Toolkit）
- [ ] 支持 Cline 扩展的 API 调用深度集成
- [ ] 基于 AI 的会话自动打标签（bugfix / 重构 / 新功能）
- [ ] 数据可视化（按模型 / 按时间的 AI 使用量统计）
- [ ] 支持团队协作（共享导出、代码审查集成）
- [ ] 本地向量化搜索（语义检索历史 Prompt）

---

## 常见问题（FAQ）

### ❓ 为什么 OpenCode/Cursor 显示的 token 数量（例如 58,809）与 AgentLog 记录的 token 数量（例如 685）不一致？

这是**统计范围不同**导致的正常现象，两者均正确但反映不同维度的信息：

| 统计维度 | OpenCode/Cursor 显示 | AgentLog 记录 |
|----------|---------------------|---------------|
| **统计范围** | 整个上下文窗口 **所有内容** | 仅 **用户消息 + 助理回复** |
| **包含内容** | 系统提示 + 历史消息 + 工具结果 + 文件内容 + 模型输入输出 | 模型输入输出（API 返回的 `usage` 数据） |
| **典型值** | 数万 tokens | 数百 tokens |

#### 📊 详细解释

**OpenCode/Cursor 的 ~58,809 tokens 包含**：
1. **系统提示**：AGENTS.md、项目文档、指令等（约 7,283 tokens）
2. **工具调用结果**：读取的文件内容、命令输出、代码片段等（约 50,000 tokens）
3. **历史消息**：所有 user/assistant/tool 消息的完整文本（约 1,421 tokens）
4. **当前模型输入**：上述所有内容的聚合上下文

**AgentLog 的 ~685 tokens 仅包含**：
- `input_tokens`：模型实际消耗的输入 token（约 285）
- `output_tokens`：模型实际生成的输出 token（约 400）
- 符合 MCP 协议 `token_usage` 字段的定义

#### 🎯 核心结论

1. **OpenCode/Cursor 显示的是「上下文窗口总负载」**：反映 AI 处理的实际上下文大小和工作复杂度。
2. **AgentLog 记录的是「模型实际消耗」**：反映模型 API 的成本和资源消耗。
3. **两者互补**：前者帮助评估上下文复杂度，后者帮助核算 API 成本。

#### 🔧 建议

- **无需担心**：这是预期行为，并非数据缺失或错误。
- **统一统计**：如需统一，可在 `log_turn(role='tool')` 中传入工具内容的实际 token 数。
- **界面区分**：建议在界面中明确标注「上下文 tokens」vs「模型 tokens」。

### ❓ 为什么 token_usage 字段有时不更新？如何解决？

**问题**：OpenCode/Cursor 等 MCP 客户端有时未在 `log_turn` 调用中传入 `token_usage` 参数，导致会话的 token 消耗统计停滞。

**原因**：
- MCP 协议要求 `token_usage` 为累计值，需每次调用时传入
- 客户端实现可能遗漏该参数，尤其当工具调用频繁时
- 若不传入，AgentLog 后端保持原有 `token_usage` 不变

**解决方案**：
1. **客户端改进**：确保每次 `log_turn` 调用都传入累计 `token_usage`
2. **服务端估算（已实现）**：AgentLog MCP 服务器 v0.4.0+ 在未收到 `token_usage` 时会自动估算：
   - 从现有会话读取当前 `token_usage`
   - 按 4 字符 ≈ 1 token 估算新消息的 token 数
   - 用户/工具消息计入 `inputTokens`，助理消息计入 `outputTokens`
   - 更新后写回会话
3. **手动补全**：对已有会话运行脚本补全 token 统计

**验证方法**：
```bash
# 检查会话的 token_usage 是否自动更新
curl -s http://localhost:7892/api/sessions/你的会话ID | jq '.data.tokenUsage'
```

**注意事项**：
- 自动估算基于字符数，与模型实际消耗可能有 ±20% 误差
- 如需精确统计，仍需客户端传入准确的 `token_usage`
- 重启 OpenCode/Cursor 后 MCP 服务器重新加载，新逻辑生效

---

## 开发贡献

### 环境要求

- Node.js >= 18
- pnpm >= 9

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/AgentLogLabs/agentlog.git
cd agentlog

# 安装依赖
pnpm install

# 构建全部（按顺序：shared → backend → vscode-extension）
pnpm build

# 启动后台开发服务（热重载）
pnpm dev
```

### 分包构建

```bash
pnpm build:shared   # 必须先构建（其他包依赖共享类型）
pnpm build:backend  # 构建后端服务
pnpm build:ext      # 构建 VS Code 扩展
```

### 开发调试

```bash
# 后端热重载开发
pnpm dev

# 后端 MCP 服务器开发（tsx watch）
cd packages/backend && pnpm dev:mcp

# 在 VS Code 中调试扩展
# 1. 用 VS Code 打开项目根目录
# 2. 按 F5 启动扩展调试（Extension Development Host）
```

### 代码检查

```bash
# 类型检查（所有包）
pnpm lint

# 后端单独检查
cd packages/backend && pnpm lint

# 扩展单独检查
cd packages/vscode-extension && pnpm lint
```

### 测试

```bash
# 后端集成测试
cd packages/backend && pnpm test
```

### Docker 部署

```bash
# 构建镜像
pnpm docker:build

# 运行容器
pnpm docker:run

# 查看日志
pnpm docker:logs

# Docker Compose
pnpm docker:compose:up
pnpm docker:compose:logs
pnpm docker:compose:down
```

### 清理

```bash
# 清理所有 dist 和 node_modules
pnpm clean
```

---

## 社区交流 / Community

欢迎加入 AgentLog 微信社区，与开发者和其他用户交流心得。

<img src="docs/assert/AgentLog-wechat-QR.png" width="200" alt="AgentLog WeChat QR Code" />

---

## License

Apache 2.0 © AgentLog Contributors