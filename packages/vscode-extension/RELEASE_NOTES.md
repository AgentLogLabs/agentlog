# AgentLog v1.1.0 发布说明 | Release Notes

> 📅 发布日期：2026-04-04  
> 🔖 版本：v1.1.0  
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
如需手动安装，可从 [GitHub Releases](https://github.com/AgentLogLabs/agentlog/releases) 下载对应平台的 VSIX 文件。

---

## 🚀 Phase 1 新功能 | Phase 1 What's New

> **重大架构升级** — AgentLog v1.1.0 是 Phase 1 的核心发布，引入了全新的 Trace/Span 可观测性架构。

### ✨ 核心新功能

| Ticket | 功能 | 说明 |
|--------|------|------|
| **T1** | traces/spans 表 + ULID 主键 | 工业级可观测性标准，分布式时序特征 |
| **T2** | SSE 广播 + MCP 双轨通信 | 支持大模型 IDE 持久化连接 |
| **T3** | POST /api/spans 高性能写入 | 高频无阻塞接口，专供无头探针调用 |
| **T4** | OpenClaw Hook 探针（TelemetryProbe） | 旁路拦截 Agent 原生 Hook，自动 TraceID 上报 |
| **T5** | Git Hook post-commit 拦截 | 捕获人类开发者提交流程，关联 AI 会话 |
| **T6** | Trace summary API | get_trace_summary MCP 工具，返回 Trace 概览 |
| **T7** | Trace diff API | 对比两个 Trace 的差异 |
| **T8** | SSE 实时刷新 + VS Code 树状视图 | 探针数据实时推送，UI 即刻刷新 |

---

## 🎯 核心功能 | Core Features

### 🤖 AI 交互自动捕获
- 拦截 DeepSeek / Qwen / Kimi 等国内主流模型 API 请求
- 完整记录 Prompt、Response 及推理过程（DeepSeek-R1 `<think>` 内容）
- 支持 Cline、Cursor、Continue 等主流 AI 编程工具

### 🔗 Git Commit 智能绑定
- 自动关联 AI 会话与 Git 提交记录
- 一键生成 Commit 上下文文档
- 支持 Git Worktree 多 worktree 并行追踪

### 📊 推理过程保存
- DeepSeek-R1 完整思维链记录
- Claude / GPT 等模型的推理过程存档
- 支持回溯和分析 AI 决策逻辑

### 🌐 MCP 协议支持
- 标准 Model Context Protocol 实现
- 主动上报模式，无需拦截配置
- 支持 `log_turn`、`log_interaction` 等标准接口

### 💾 本地优先
- SQLite 本地存储，数据完全可控
- 完全离线可用，不上传任何数据
- 支持导出 JSONL / CSV / Markdown 格式

---

## 🏗️ 架构升级 | Architecture Upgrade

### Phase 1 双流采集引擎

| 流 | 来源 | 采集方式 | Span 类型 |
|----|------|----------|-----------|
| **内部流** | OpenClaw / AI Agent | Telemetry Probe 无侵入拦截 | `actor: agent` |
| **外部流** | 人类开发者 | Git Hook + 编辑器插件 | `actor: human` |

### JIT Context Hydration
- 跨 Agent 急诊交接：传递 TraceID 即可复水完整上下文
- 无需传递完整日志
- 结构化错误栈、输入参数、历史状态即时获取

---

## 📝 更新日志 | Changelog

### Added
- **T1**: traces/spans 表 + ULID 主键机制
- **T2**: SSE 广播 + MCP 双轨通信层
- **T3**: POST /api/spans 高性能写入接口
- **T4**: OpenClaw Hook 探针（TelemetryProbe）
- **T5**: Git Hook post-commit 拦截脚本
- **T6**: Trace summary API (`get_trace_summary`)
- **T7**: Trace diff API (`get_trace_diff`)
- **T8**: SSE 实时刷新 + VS Code 树状视图

### Changed
- 版本升级至 v1.1.0
- 底层数据模型重构（废弃 agent_sessions 表）

### Fixed
- 修复多 worktree 场景下的会话绑定问题

---

## 🔮 未来规划 | Roadmap

- **Phase 2**: 团队协作增强 + 多 Agent 协调协议
- **Phase 3**: 云端同步 + 团队共享视图

---

## 🐛 问题反馈 | Feedback

如遇问题或功能建议，欢迎：
- [提交 Issue](https://github.com/agentloglabs/agentlog/issues)
- [加入微信群](/docs/intro#微信群)
