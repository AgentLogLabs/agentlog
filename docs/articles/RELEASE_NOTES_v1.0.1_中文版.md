# AgentLog v1.0.1 发布说明

> 📅 发布日期：2026-04-01  
> 🔖 版本：v1.0.1  
> 📦 下载地址：https://github.com/AgentLogLabs/agentlog/releases

---

## 📥 下载安装

### VS Code 插件安装（推荐）
直接在 VS Code 扩展商店搜索 **"AgentLog"** 一键安装。

### GitHub 手动下载
从 [GitHub Releases](https://github.com/AgentLogLabs/agentlog/releases) 下载对应平台的 VSIX 文件：

| 平台 | 架构 | 下载格式 |
|------|------|----------|
| Windows | x64 / ARM64 | `.vsix` |
| macOS | x64 / ARM64 (Apple Silicon) | `.vsix` |
| Linux | x64 / ARM64 | `.vsix` |

> 💡 VS Code 会根据你的系统自动选择合适的架构版本

---

## ✨ 新功能

### v1.0.1 更新
- ✅ **插件描述优化**：Marketplace 关键字增强，搜索曝光提升
- ✅ **关键字覆盖**：DeepSeek、Git、编程助手等国内用户高频搜索词全覆盖

---

## 🎯 核心功能

### 🤖 AI 交互自动捕获
- 拦截 DeepSeek / 通义千问 / Kimi 等国内主流模型 API 请求
- 完整记录 Prompt、Response 及推理过程（DeepSeek-R1 `<think>` 内容）
- 支持 Cline、Cursor、Continue、Trae IDE 等主流 AI 编程工具

### 🔗 Git Commit 智能绑定
- 通过 Git post-commit 钩子自动关联 AI 会话与代码变更
- 手动绑定/解绑 Commit，灵活控制
- VS Code 侧边栏展示 Commit 绑定关系树

### 📊 可视化面板与导出
- VS Code 侧边栏面板：会话列表 + Commit 绑定视图
- 一键导出中文周报、PR/Code Review 说明
- 支持 JSONL（原始数据）、CSV 表格格式

### 🧠 Commit 上下文与解释
- 生成 Commit 的 AI 交互上下文文档（Markdown / JSON / XML）
- AI 交互解释摘要，快速理解代码变更背景
- 支持中英文输出

### 🏠 本地优先架构
- 所有数据存储在本机 SQLite（`~/.agentlog/agentlog.db`）
- 完全离线可用，无云端依赖
- 后台服务仅监听 localhost，保障隐私安全

### 🔌 MCP 服务器集成
- 内置 MCP Server，支持 OpenCode / Cursor / Trae IDE 等 AI 客户端自动上报
- 完整对话记录、工具调用、Token 统计
- 会话持久化，支持跨工具连续记录

---

## 🚀 快速开始

1. 在 VS Code 扩展商店搜索 **"AgentLog"** 安装
2. 扩展自动启动本地后台服务（端口 7892）
3. 开始使用 Cline、Cursor、Continue 等 AI 工具进行开发
4. AI 交互自动记录，`git commit` 时自动绑定
5. 通过侧边栏面板查看记录、导出报告

### Trae IDE 用户

```bash
# 启动 MCP Server
npx @agentlog/backend agentlog-mcp

# 在 Trae 设置 → MCP Server 中添加 AgentLog
```

---

## 🔒 隐私与安全

- 🔐 **完全本地存储**：所有数据存于本机 SQLite，不发送到任何云端
- 🔐 **本地网络限制**：后台仅监听 `127.0.0.1`，CORS 限制为 localhost
- 🔐 **无遥测收集**：不收集任何使用统计数据
- 🔐 **开源透明**：Apache 2.0 许可证，代码完全开放

---

## 📝 版本历史

| 版本 | 日期 | 主要更新 |
|------|------|----------|
| v1.0.1 | 2026-04-01 | Marketplace 关键字优化 |
| v0.1.6 | 2026-03-31 | GitHub Feedback 命令、Issue 模板 |
| v0.1.5 | 2026-03-30 | 多平台架构支持修复 |
| v0.1.0 | 2026-03-29 | 首次公开发布 |

---

## 🌟 后续计划

- VS Code Webview 仪表板 UI 完善（React + VS Code UI Toolkit）
- 基于 AI 的会话自动打标签（bugfix / 重构 / 新功能）
- 支持 Cline 扩展的 API 调用深度集成
- 本地向量化搜索（语义检索历史 Prompt）
- 团队协作功能（共享导出、代码审查集成）

---

## 📞 反馈与支持

- 🐛 GitHub Issues：https://github.com/AgentLogLabs/agentlog/issues
- 📖 文档：https://github.com/AgentLogLabs/agentlog#readme
- 🌐 官网：https://agentloglabs.github.io/

---

**AgentLog — 让每一次 AI 交互都有迹可循，让每一行代码变更都有上下文可追溯。**
