# AgentLog 公众号文案

---

**📢 标题：让 AI 编程有"记忆"——AgentLog 让每一行代码变更都有迹可循**

---

**📌 开篇引导**

你是否有这样的困扰——

让 DeepSeek 改了三天代码，回头看 Commit 历史，完全想不起来"为什么这里要这样改"？

AI 时代，代码有版本控制，但 AI 对话没有。现在有了。

---

**🎯 AgentLog 是什么？**

AgentLog——AI 编程飞行记录仪。

一款开源的 VS Code / Trae IDE 插件 + 本地轻量后台，自动捕获你与 AI 的每一次交互，绑定到 Git Commit，一键导出周报和 PR 说明。

简单来说：**你写代码，AgentLog 帮你记"为什么这样写"。**

---

**✨ 核心功能**

**① 自动捕获，不打扰工作流**

- 静默记录 DeepSeek / 通义千问 / Kimi 等国内主流模型的 API 对话
- **独家支持 DeepSeek-R1 推理链完整保存**——那些跑完就消失的 `<think>` 思考过程，现在都能留住

**② Git Commit 智能绑定**

- 安装插件后，每次 `git commit` 自动关联 AI 会话
- VS Code 侧边栏直观查看 Commit 与 AI 对话的绑定关系
- 支持 Git Worktree，多 AI Agent 并行工作互不干扰

**③ 一键导出周报 / PR 说明**

- 告别"记流水账"，AI 编程成果自动整理成中文周报
- PR Review 时一键生成 Code Review 说明，团队沟通更高效
- 支持 Markdown / JSON / CSV 多种导出格式

---

**🔐 隐私优先**

- 所有数据存在本机（`~/.agentlog/agentlog.db`），不上传任何云端
- 后台仅监听本地端口，不暴露外网
- 开源透明（Apache 2.0），代码完全开放

---

**📦 支持环境**

**模型**：DeepSeek-V3 / R1、通义千问 Qwen、Kimi、豆包、ChatGLM、Ollama 本地模型

**工具**：Cline、Cursor、Continue、Trae IDE（新增）、直接 API 调用

**平台**：Windows / macOS / Linux，覆盖 x64 / ARM64 全架构

---

**🚀 快速上手**

**第一步**：VS Code 扩展商店搜索"AgentLog"一键安装

**第二步**：插件自动启动本地后台服务

**第三步**：正常使用 Cline / Cursor 等 AI 工具，交互自动记录

**第四步**：`git commit` 时自动绑定 AI 会话

**第五步**：侧边栏查看记录 / 一键导出周报

Trae IDE 用户：终端运行 `npx @agentlog/backend agentlog-mcp`，然后在 Trae MCP 设置中添加即可。

---

**📖 立即体验**

🌐 官网：https://agentloglabs.github.io/
💻 GitHub：https://github.com/AgentLogLabs/agentlog
📥 VS Code 扩展商店搜索"AgentLog"

---

**👇 互动话题**

你在使用 AI 编程时，有没有遇到过"这段代码为什么这样改"的困惑？欢迎留言分享！

---

*关注 AgentLog，让 AI 编程有记忆、让代码变更有温度。*
