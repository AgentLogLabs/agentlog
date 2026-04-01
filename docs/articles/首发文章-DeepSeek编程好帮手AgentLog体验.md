# DeepSeek 编程好帮手：AgentLog 体验

> 你是否有过这样的经历：让 AI 帮你改了几天代码，回头看 Commit 历史，完全想不起来"为什么这里要这样改"？

笔者最近体验了一款开源工具 **AgentLog**，它自称"AI 编程飞行记录仪"。顾名思义，就是把 AI 与你的每一次交互都记录下来，绑定到 Git Commit，让代码变更永远有据可查。

---

## 🎯 解决什么痛点

使用 AI 编程工具（如 Cline、Cursor、Continue）已经成了很多开发者的日常。但问题也随之而来：

- **上周让 AI 改了这段代码，为什么这样改来着？**
- **AI 的推理过程去哪了？** DeepSeek-R1 的 `<think>` 思考链跑完就消失了
- **不同 AI 工具的数据散落各处**，Cursor 的对话在 Cursor 里，Cline 的在 Cline 里

AgentLog 解决的就是这个问题：你在 VS Code 里装一个插件，后台自动运行一个本地服务，所有 AI 交互静默记录到本地 SQLite 数据库，每次 `git commit` 时自动绑定。

---

## ⚡ 核心功能一览

### 1. 自动捕获 AI 对话

支持拦截发往以下模型的 API 请求：

| 模型 | 提供商 | 推理链捕获 |
|------|--------|-----------|
| DeepSeek-V3 / R1 | DeepSeek | ✅ 完整支持 |
| 通义千问 Qwen-Max/Plus | 阿里云 | ✅ |
| Kimi / Moonshot | 月之暗面 | ✅ |
| 豆包 | 字节跳动 | ✅ |
| ChatGLM | 智谱 AI | ✅ |

特别值得一提的是，**DeepSeek-R1 的 `<think>` 推理过程会被完整保存**。这在以前是几乎不可能的——R1 跑完思考就输出结果，推理链作为中间过程被丢弃。AgentLog 通过拦截 API 响应，完整提取了这段珍贵的思考轨迹。

### 2. Git Commit 智能绑定

装好插件后，每次你执行 `git commit`，AgentLog 的 post-commit 钩子会自动：

1. 查找本次提交涉及的文件
2. 找到对应时间段内相关的 AI 会话
3. 自动绑定到该 Commit

绑定关系可在 VS Code 侧边栏直观查看。后续通过 `git log` 或 AgentLog 的 API，随时可以查看任意 Commit 对应的 AI 对话上下文。

### 3. 一键导出周报 / PR 说明

这是笔者最喜欢的功能。用 AI 编程了一周，导出周报时直接调 AgentLog 命令：

```bash
agentlog export --format weekly-report --lang zh
```

输出格式大致如下：

```
## 本周 AI 编程记录

### 2026-03-31
- **[Session #a3f8c2]** 添加用户认证模块
  - 模型：deepseek-r1
  - 工具：Cline
  - 涉及文件：src/auth/login.ts, src/auth/register.ts
  - Commit: 7f69806

- **[Session #b2d1e9]** 修复支付回调偶发性超时
  - 模型：qwen-plus
  - 工具：Cursor
  - 涉及文件：src/payment/callback.ts
  - Commit: 3c91ab4
```

PR Review 时也能一键生成 Code Review 说明，团队其他成员一眼就能看懂这次代码变更背后的 AI 推理逻辑。

### 4. Commit 上下文文档生成

这是面向未来的功能——通过 `/api/commits/:hash/context` 接口，可以将某个 Commit 关联的所有 AI 对话汇总成一份结构化文档，支持 Markdown / JSON / XML 三种格式，可控制是否包含推理过程、Prompt、Response 等细节。

生成的上下文文档可以直接粘贴进新的 AI 对话，让接手你代码的同事或者新启动的 AI Agent 快速了解："这段代码是怎么来的、为什么这样写"。

---

## 🛠️ 支持的工具

除了前文提到的模型，**AI 编程工具**方面目前支持：

- **Cline**（VS Code 插件）
- **Cursor**（IDE 内置 AI）
- **Continue**（VS Code 插件）
- 直接 API 调用（通过 HTTP 拦截）

最新的 v1.0.1 还新增了 **Trae IDE** 的 MCP Server 支持——字节跳动旗下的 Trae IDE 用户现在也能享受 AgentLog 的记录服务了。

---

## 🔒 隐私与安全

这是笔者在体验时特别关注的一点。AgentLog 的设计原则是**本地优先**：

- 所有数据存储在本机 `~/.agentlog/agentlog.db`，**不上传到任何云端**
- 后台服务仅监听 `127.0.0.1:7892`，不暴露到外网
- 不收集任何遥测数据
- 开源项目（Apache 2.0 License），代码完全透明

对于企业用户来说，本地存储这一点尤为重要——代码和 AI 交互记录都不离开公司网络。

---

## 🚀 如何安装

### 方式一：VS Code 插件（推荐）

直接在 VS Code 扩展商店搜索 **"AgentLog"** 安装，插件会自动配置后台服务。

### 方式二：手动安装

```bash
# 克隆仓库
git clone https://github.com/AgentLogLabs/agentlog.git
cd agentlog

# 安装依赖
pnpm install

# 构建并启动后台
pnpm dev
```

### Trae IDE 用户

参考官方文档《Trae IDE + AgentLog 快速上手》：
```bash
npx @agentlog/backend agentlog-mcp
```
然后在 Trae 的 MCP 设置中添加 Server 即可。

---

## 📊 使用感受

笔者使用了大约两周，总结一下感受：

**优点：**
- 安装简单，0 摩擦接入，Git Hook 自动安装
- 数据本地存储，隐私有保障
- DeepSeek-R1 推理链完整保存，这是独家能力
- 导出周报功能实测好用，节省了不少写文档的时间
- Git Worktree 多 Agent 并行支持，对多分支同时开发的团队很友好

**可以改进的地方：**
- 目前主要面向个人开发者，团队协作功能（共享 Session、代码审查集成）还在路线图上
- Webview 仪表板 UI 还可以更完善

---

## 📝 总结

**AgentLog 解决的是一个很实在的问题：AI 编程时代，代码变更的上下文去哪了？**

它不是又一个 AI 编程工具，而是一个**记录层**——在你不改变现有工作流的前提下，静默地把你与 AI 的每一次交互都记录下来，并在合适的时机（Git Commit）绑定到代码变更。

对于经常使用 AI 编程工具的开发者来说，这是一个值得一试的工具。毕竟，代码有版本控制（Git），AI 对话没有——现在有了。

**项目地址**：https://github.com/AgentLogLabs/agentlog  
**官网**：https://agentloglabs.github.io/

---

*欢迎在评论区分享你的 AI 编程体验，你有什么好的方式记住"这段代码为什么这样改"吗？*
