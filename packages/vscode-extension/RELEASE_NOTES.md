# AgentLog — AI 编程行车记录仪 v0.1.0 发布说明

## 概述
AgentLog 是一款面向国内主流大模型的 VS Code/Cursor 插件 + 本地轻量后台，自动捕获 AI Agent 交互日志，与 Git Commit 绑定，一键导出周报或 PR 说明。

## 核心功能亮点

### 🎙️ 自动 AI 交互捕获
- 拦截 DeepSeek / Qwen / Kimi 等国内主流模型的 API 请求
- 完整记录 Prompt、Response 及推理过程（DeepSeek-R1 `<think>` 内容）
- 支持 Cline、Cursor、Continue 等主流 AI 编程工具

### 🔗 Git Commit 智能绑定
- 通过 Git post-commit 钩子自动关联 AI 会话与代码变更
- 手动绑定/解绑 Commit，灵活控制
- 侧边栏展示 Commit 绑定关系树

### 📊 可视化面板与导出
- VS Code 侧边栏面板：会话列表 + Commit 绑定视图
- 一键导出中文周报、PR/Code Review 说明
- 支持 JSONL（原始数据）、CSV 表格格式

### 🧠 Commit 上下文与解释
- 生成 Commit 的 AI 交互上下文文档（Markdown/JSON/XML）
- AI 交互解释摘要，快速理解代码变更背景
- 支持中英文输出，内容长度控制

### 🏠 本地优先架构
- 所有数据存储在本机 SQLite (`~/.agentlog/agentlog.db`)
- 完全离线可用，无云端依赖
- 后台服务仅监听 localhost，保障隐私安全

### 🔌 MCP 服务器集成
- 内置 MCP 服务器，支持 OpenCode/Cursor 等 AI 客户端自动上报
- 完整的对话记录、工具调用、Token 统计
- 会话持久化，支持跨工具连续记录

## 技术特性
- **Monorepo 架构**：pnpm workspaces，TypeScript 全栈
- **后台服务**：Fastify + SQLite (better-sqlite3)，默认端口 7892
- **VS Code 扩展**：Sidebar TreeView、Webview 仪表板、Chat Participant 集成
- **Git 集成**：simple-git + 钩子注入
- **拦截机制**：Node.js http/https Monkey-patch，支持流式 SSE

## 支持的模型与工具

### 国内主流模型
- DeepSeek-V3 / R1（完整推理链支持）
- 通义千问 Qwen-Max / Plus（阿里云 DashScope）
- Kimi / Moonshot（月之暗面）
- 豆包（字节跳动 Ark）
- ChatGLM（智谱 AI）
- 本地模型（Ollama / LM Studio）

### AI 编程工具
- Cline（VS Code 插件）
- Cursor（IDE 内置 AI）
- Continue（VS Code 插件）
- 直接 API 调用（HTTP 拦截）

## 快速开始

### 前置要求
- Node.js ≥ 18
- Git
- VS Code ≥ 1.93.0 或 Cursor

### 安装与使用
1. 在 VS Code 扩展商店搜索 "AgentLog" 安装
2. 扩展会自动启动本地后台服务（端口 7892）
3. 开始使用 Cline、Cursor 等 AI 工具进行开发
4. AI 交互自动记录，Git Commit 时自动绑定
5. 通过侧边栏面板查看记录、导出报告

## 配置选项
- `agentlog.backendUrl`：后台服务地址（默认 http://localhost:7892）
- `agentlog.autoBindOnCommit`：Commit 时自动绑定（默认 true）
- `agentlog.retentionDays`：数据保留天数（默认 90，0=永久）
- `agentlog.exportLanguage`：导出语言（zh/en，默认 zh）
- `agentlog.debug`：调试日志输出（默认 false）

## 隐私与安全
- **完全本地存储**：所有数据存于本机 SQLite，不发送到任何云端
- **本地网络限制**：后台仅监听 127.0.0.1，CORS 限制为 localhost
- **无遥测收集**：不收集任何使用统计数据
- **开源透明**：MIT 许可证，代码完全开放

## 已知限制
- 需要 Node.js ≥ 18 环境
- 某些 Node.js 原生模块（如 better-sqlite3）可能需要编译
- 首次安装需编译后台服务，可能耗时 1-2 分钟

## 后续计划
- VS Code Webview 仪表板 UI 完善（React + VS Code UI Toolkit）
- 基于 AI 的会话自动打标签（bugfix / 重构 / 新功能）
- 支持 Cline 扩展的 API 调用深度集成
- 本地向量化搜索（语义检索历史 Prompt）
- 团队协作功能（共享导出、代码审查集成）

## 反馈与支持
- GitHub 仓库：https://github.com/agentlog/agentlog
- 问题反馈：GitHub Issues
- 文档：项目 README 与内置帮助

---

**AgentLog — 让每一次 AI 交互都有迹可循，让每一行代码变更都有上下文可追溯。**