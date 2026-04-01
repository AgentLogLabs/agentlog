# Changelog

All notable changes to the "AgentLog — AI 编程行车记录仪" extension will be documented in this file.

Check [Keep a Changelog](https://keepachangelog.com/) for recommendations on how to structure this file.

## [1.0.1] - 2026-04-01

### Added
- **关键字优化**：插件描述增加 DeepSeek、Git、编程助手等关键字，提升 marketplace 搜索曝光
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
