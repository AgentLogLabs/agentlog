# Changelog

All notable changes to the "AgentLog — AI 编程行车记录仪" extension will be documented in this file.

Check [Keep a Changelog](https://keepachangelog.com/) for recommendations on how to structure this file.

## [1.1.2] - 2026-04-08

### Added
- **Trace 详情视图**：完整展示 Trace 各 Span 内容、时间戳、Token 统计
- **affected_files 支持**：记录交互改动的文件列表，Trace 视图新增文件路径展示
- **Commit 绑定增强**：支持 Trace 与 Git Commit 绑定/解绑，新增删除 Trace 功能
- **OpenClaw Agent 集成**：自动读取 git config traceId，优化 OpenCode MCP 配置
- **agentlog.traceList View**：新增独立的 Trace 列表视图

### Changed
- 废弃 Session 视图，全面迁移到 Trace 视图
- Trace 视图增强：Token 统计、时间线、Human 内容高亮
- 每 Span 显示时间戳和 Token 消耗
- 导出功能优化：trace 导出时增加 toolInput 和 result 字段展示
- OpenCode MCP 配置格式修正
- 版本升级至 v1.1.2

### Fixed
- 修复 Phase1 测试用例失败项

## [1.1.1] - 2026-04-06

### Changed
- 版本升级至 v1.1.1

## [1.1.0] - 2026-04-04

### Added
- **Phase 1 架构升级** — 全新 Trace/Span 可观测性标准
- **T1**: traces/spans 表 + ULID 主键机制（工业级可观测性标准）
- **T2**: SSE 广播 + MCP 双轨通信层（支持大模型 IDE 持久化连接）
- **T3**: POST /api/spans 高性能写入接口（高频无阻塞，专供探针）
- **T4**: OpenClaw Hook 探针（TelemetryProbe，旁路拦截 Agent 原生 Hook）
- **T5**: Git Hook post-commit 拦截（捕获人类提交流程，关联 AI 会话）
- **T6**: Trace summary API（`get_trace_summary` MCP 工具）
- **T7**: Trace diff API（对比两个 Trace 差异）
- **T8**: SSE 实时刷新 + VS Code 树状视图（探针数据实时推送）

### Changed
- 底层数据模型重构（废弃 agent_sessions 表）
- 版本升级至 v1.1.0

### Fixed
- 修复多 worktree 场景下的会话绑定问题

## [1.0.1] - 2026-04-01

### Added
- **关键字优化**：插件描述增加 DeepSeek、Git、编程助手等关键字，提升 marketplace 搜索曝光
- **Trae IDE 支持**：新增对字节跳动 Trae AI 编程 IDE 的支持
- **用户增长支持**：优化产品说明文档

### Changed
- 版本升级至 v1.0.1

## [0.1.6]

### Added
- GitHub feedback command in sidebar (opens Issues page)
- Issue templates for bug reports and feature requests

## [0.1.5] - 2026-03-30

### Fixed
- Native module cross-arch build support
- darwin-x64 architecture detection for better-sqlite3
- macOS runner for darwin-x64 builds
- package.sh multi-target support

## [0.1.4] - 2026-03-30

### Changed
- License updated to Apache 2.0

## [0.1.3] - 2026-03-30

### Changed
- VSIX packaging workflow improvements

## [0.1.2] - 2026-03-30

### Fixed
- better-sqlite3 native module rebuild in CI (use Node.js 22 to match VS Code extension host)

## [0.1.1] - 2026-03-30

### Added
- Multi-platform VSIX build workflow (Windows, macOS, Linux)

### Fixed
- VSIX package workflow YAML indentation and vsce path
- vsce --target flag auto-detection
- macos-latest runner for darwin-x64 (macos-13 deprecated)
- vsce@2.24.0 to avoid macos runner bug

## [0.1.0] - 2026-03-29

### Added
- Initial public release of AgentLog AI Programming Driving Recorder
- Automatic capture of AI agent interaction logs (DeepSeek/Qwen/Kimi/etc.)
- Git Commit automatic binding and manual binding
- VS Code sidebar panel: session list + Commit binding view
- One-click export: Chinese weekly report, PR/Code Review description, JSONL, CSV
- Commit context document generation (Markdown/JSON/XML)
- Commit AI interaction explanation summary
- MCP server integration: supports automatic reporting from AI clients like OpenCode/Cursor
- Local SQLite storage, completely offline available
- Support for domestic mainstream models: DeepSeek, Qwen, Kimi, ChatGLM, etc.
- Support for AI programming tools: Cline, Cursor, Continue, etc.
- HTTP interceptor for API call interception
- Git post-commit hook injection
- VS Code chat participant integration
- Configuration options for backend URL, auto-capture, retention days, etc.
- Debug logging and output panel integration
