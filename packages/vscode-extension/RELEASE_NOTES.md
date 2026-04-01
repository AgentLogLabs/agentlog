# AgentLog v1.0.1 发布说明 | Release Notes

> 📅 发布日期：2026-04-01  
> 🔖 版本：v1.0.1  
> 📦 下载地址：https://github.com/AgentLogLabs/agentlog/releases

---

## 📥 下载安装 | Download & Install

### VS Code 插件安装（推荐）
直接在 VS Code 扩展商店搜索 **"AgentLog"** 一键安装：

| 平台 | 下载链接 |
|------|----------|
| Windows | VS Code 扩展商店自动适配 |
| macOS | VS Code 扩展商店自动适配 |
| Linux | VS Code 扩展商店自动适配 |

### GitHub 直接下载
如需手动安装，可从 [GitHub Releases](https://github.com/AgentLogLabs/agentlog/releases) 下载对应平台的 VSIX 文件：

| 平台 | 架构 | 下载格式 |
|------|------|----------|
| Windows x64 | `x64` | `.vsix` |
| Windows ARM64 | `arm64` | `.vsix` |
| macOS x64 | `x64` | `.vsix` |
| macOS ARM64 (Apple Silicon) | `arm64` | `.vsix` |
| Linux x64 | `x64` | `.vsix` |
| Linux ARM64 | `arm64` | `.vsix` |

> 💡 VS Code 会根据你的系统自动选择合适的架构版本

---

## ✨ 新功能 | What's New

### v1.0.1 更新
- ✅ **插件描述优化**： marketplace 关键字增强，搜索曝光提升
- ✅ **关键字优化**：DeepSeek、Git、编程助手等关键字全覆盖

---

## 🎯 核心功能 | Core Features

### 🤖 AI 交互自动捕获
- 拦截 DeepSeek / Qwen / Kimi 等国内主流模型 API 请求
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
- 支持中英文输出

### 🏠 本地优先架构
- 所有数据存储在本机 SQLite (`~/.agentlog/agentlog.db`)
- 完全离线可用，无云端依赖
- 后台服务仅监听 localhost，保障隐私安全

### 🔌 MCP 服务器集成
- 内置 MCP 服务器，支持 OpenCode/Cursor 等 AI 客户端自动上报
- 完整的对话记录、工具调用、Token 统计
- 会话持久化，支持跨工具连续记录

---

## 🛠️ 支持的模型与工具 | Supported Models & Tools

### 国内主流模型
- ✅ DeepSeek-V3 / R1（完整推理链支持）
- ✅ 通义千问 Qwen-Max / Plus（阿里云 DashScope）
- ✅ Kimi / Moonshot（月之暗面）
- ✅ 豆包（字节跳动 Ark）
- ✅ ChatGLM（智谱 AI）
- ✅ 本地模型（Ollama / LM Studio）

### AI 编程工具
- ✅ Cline（VS Code 插件）
- ✅ Cursor（IDE 内置 AI）
- ✅ Continue（VS Code 插件）
- ✅ 直接 API 调用（HTTP 拦截）

---

## 🚀 快速开始 | Quick Start

### 前置要求
- Node.js ≥ 18
- Git
- VS Code ≥ 1.93.0 或 Cursor

### 安装步骤
1. 在 VS Code 扩展商店搜索 **"AgentLog"** 安装
2. 扩展会自动启动本地后台服务（端口 7892）
3. 开始使用 Cline、Cursor 等 AI 工具进行开发
4. AI 交互自动记录，Git Commit 时自动绑定
5. 通过侧边栏面板查看记录、导出报告

### 配置选项
| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `agentlog.backendUrl` | `http://localhost:7892` | 后台服务地址 |
| `agentlog.autoBindOnCommit` | `true` | Commit 时自动绑定 |
| `agentlog.retentionDays` | `90` | 数据保留天数（0=永久）|
| `agentlog.exportLanguage` | `zh` | 导出语言（zh/en）|
| `agentlog.debug` | `false` | 调试日志 |

---

## 🔒 隐私与安全 | Privacy & Security

- 🔐 **完全本地存储**：所有数据存于本机 SQLite，不发送到任何云端
- 🔐 **本地网络限制**：后台仅监听 127.0.0.1，CORS 限制为 localhost
- 🔐 **无遥测收集**：不收集任何使用统计数据
- 🔐 **开源透明**：Apache 2.0 许可证，代码完全开放

---

## 📝 版本历史 | Version History

| 版本 | 日期 | 主要更新 |
|------|------|----------|
| v1.0.1 | 2026-04-01 | marketplace 关键字优化 |
| v0.1.6 | 2026-03-31 | GitHub feedback 命令、Issue 模板 |
| v0.1.5 | 2026-03-30 | 多平台架构支持修复 |
| v0.1.0 | 2026-03-29 | 首次公开发布 |

---

## 🐛 已知限制 | Known Limitations

- 需要 Node.js ≥ 18 环境
- 某些 Node.js 原生模块（如 better-sqlite3）可能需要编译
- 首次安装需编译后台服务，可能耗时 1-2 分钟

---

## 🌟 后续计划 | Roadmap

- VS Code Webview 仪表板 UI 完善（React + VS Code UI Toolkit）
- 基于 AI 的会话自动打标签（bugfix / 重构 / 新功能）
- 支持 Cline 扩展的 API 调用深度集成
- 本地向量化搜索（语义检索历史 Prompt）
- 团队协作功能（共享导出、代码审查集成）

---

## 📞 反馈与支持 | Feedback & Support

- 🐛 GitHub Issues：https://github.com/AgentLogLabs/agentlog/issues
- 📖 文档：https://github.com/AgentLogLabs/agentlog#readme
- 🌐 官网：https://agentloglabs.github.io/

---

**AgentLog — 让每一次 AI 交互都有迹可循，让每一行代码变更都有上下文可追溯。**

*AgentLog — Making Every AI Interaction Traceable, Every Code Change Understandable.*
