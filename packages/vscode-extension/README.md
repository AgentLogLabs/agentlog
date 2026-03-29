# AgentLog — AI 编程飞行记录仪

> VS Code/Cursor 插件，自动捕获 AI Agent 交互日志，与 Git Commit 绑定，一键导出周报或 PR 说明。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| 自动捕获 | 拦截发往 DeepSeek / Qwen / Kimi 等 API 的请求，完整记录 Prompt + Response |
| 推理过程保存 | 专项支持 DeepSeek-R1 的推理链，完整存储中间思考步骤 |
| Git Commit 绑定 | 通过 post-commit 钩子，自动将每次提交与相关 AI 会话关联 |
| 侧边栏面板 | VS Code 侧边栏显示会话列表、Commit 绑定关系、统计数据 |
| 一键导出 | 支持导出中文周报、PR/Code Review 说明、JSONL 原始数据 |
| 本地优先 | 所有数据存储在本机 SQLite，完全离线可用 |

---

## 支持的模型

- **DeepSeek-V3 / R1** — 完整支持推理链捕获
- **通义千问 Qwen-Max** — 阿里云 DashScope
- **Kimi / Moonshot** — 月之暗面
- **豆包** — 字节跳动 Ark
- **ChatGLM** — 智谱 AI
- **本地模型** — Ollama / LM Studio

---

## 支持的 AI 编程工具

- **Cline**（VS Code 插件）
- **Cursor**（IDE 内置 AI）
- **Continue**（VS Code 插件）
- **直接 API 调用**（通过 HTTP 拦截）

---

## 快速开始

### 1. 启动后台服务

VS Code 启动时会自动启动本地后台服务（端口 7892）。也可手动点击 `AgentLog: 启动本地后台服务` 命令。

### 2. 配置 MCP 客户端

点击命令 `AgentLog: 配置 AI Agent MCP 接入`，选择你使用的 AI 客户端（Cline / Cursor 等），插件会自动配置 MCP 集成。

### 3. 查看交互记录

点击侧边栏的 AgentLog 图标，即可查看 AI 交互日志列表。双击会话可查看详情。

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `AgentLog: 打开交互日志面板` | 打开 Web 仪表盘 |
| `AgentLog: 启动本地后台服务` | 手动启动后端服务 |
| `AgentLog: 查看后台服务状态` | 检查服务运行状态 |
| `AgentLog: 导出本周 AI 开发周报` | 导出 Markdown 周报 |
| `AgentLog: 导出 PR / Code Review 说明` | 导出 PR 描述 |
| `AgentLog: 安装 Git post-commit 钩子` | 自动绑定 Commit |
| `AgentLog: 生成 Commit 上下文文档` | 生成代码变更上下文 |
| `AgentLog: 配置 AI Agent MCP 接入` | 配置 MCP 客户端 |

---

## 数据存储

- 数据库位置：`~/.agentlog/agentlog.db`
- 后端服务端口：`7892`（可配置）
- 所有数据本地存储，完全离线可用

---

## 配置选项

在 VS Code 设置中可配置以下选项：

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `agentlog.backendUrl` | `http://localhost:7892` | 后端服务地址 |
| `agentlog.autoBindOnCommit` | `true` | 自动绑定 Commit |
| `agentlog.retentionDays` | `90` | 记录保留天数 |
| `agentlog.autoStartBackend` | `true` | 自动启动后端 |
| `agentlog.debug` | `false` | 调试日志 |
| `agentlog.exportLanguage` | `zh` | 导出语言 |

---

## 问题排查

### 服务未启动

执行 `AgentLog: 启动本地后台服务` 命令，或检查端口 7892 是否被占用。

### 会话列表为空

1. 确认后台服务已启动
2. 执行 `AgentLog: 配置 AI Agent MCP 接入`
3. 开始使用 Cline/Cursor 等 AI 工具进行开发

### 无法查看详情

1. 执行 `AgentLog: 验证 MCP 连接`
2. 打开「输出」面板 → 选择「AgentLog」频道查看日志
3. 若 webview 空白，可在调试窗口执行 `Developer: Open Webview Developer Tools` 查看控制台报错

---

## 相关链接

- [GitHub](https://github.com/agentlog/agentlog)
- [问题反馈](https://github.com/agentlog/agentlog/issues)