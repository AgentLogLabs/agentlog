
# Track B — HTTP Interceptor 技术设计文档

> AgentLog 通过全局 Monkey-patch Node.js 内置的 `http`/`https` 模块，作为“安全底网”（Safety Net），
> 拦截并记录那些未提供生命周期钩子（如 Cline、Continue、Roo Code 等长尾开源 Agent）的 AI 编程对话。

---

## 目录

- [Track B — HTTP Interceptor 技术设计文档](#track-b--http-interceptor-技术设计文档)
  - [目录](#目录)
  - [1. 方案概览](#1-方案概览)
  - [2. 架构与数据流](#2-架构与数据流)
  - [3. 拦截规则与数据解析](#3-拦截规则与数据解析)
    - [3.1 拦截触发条件](#31-拦截触发条件)
    - [3.2 响应流 (SSE) 解析与推理提取](#32-响应流-sse-解析与推理提取)
  - [4. 核心类说明](#4-核心类说明)
  - [5. 与 Track A 的协同策略](#5-与-track-a-的协同策略)
  - [6. 测试步骤](#6-测试步骤)
  - [7. 局限性与后续演进](#7-局限性与后续演进)
    - [已知局限性](#已知局限性)
    - [后续升级计划](#后续升级计划)

---

## 1. 方案概览

Track B 的核心思路是 **全局流量劫持**。
在 VS Code 扩展宿主进程（Extension Host）中，大部分 AI 辅助编程插件底层仍依赖 Node.js 原生的 `http`/`https` 模块向大模型 API 发起请求。通过重写 `http.request` 和 `https.request`，我们可以在请求头和响应流中透明地提取出 Prompt、Reasoning 和 Response，并将其异步上报给 AgentLog 后端。

**核心价值**：零侵入、广覆盖。用户无需敲击特定前缀（如 `@agentlog`），也不需要 Agent 提供官方 Hook，即可实现静默记录。

---

## 2. 架构与数据流

```text
┌──────────────────────────────────────────────────────────────┐
│ VS Code Extension Host (扩展宿主进程)                        │
│                                                              │
│  [Cline / Continue / 自定义脚本]                             │
│         │                                                    │
│         ▼ 发起 HTTP(S) 请求 (如 fetch / axios)               │
│         │                                                    │
│  [AgentLog apiInterceptor] (已 Patch http.request)           │
│         │ 1. 拦截请求，解析 Host 与 Path                     │
│         │ 2. 若命中规则，截获 Request Body (提取 Prompt)     │
│         ▼                                                    │
│  [真实 Node.js http/https 底层]                              │
│         │                                                    │
│         ▼                                                    │
│  [大模型服务 API (OpenAI / DeepSeek / 阿里云等)]             │
│         │                                                    │
│         ▼ 返回响应 (通常为 SSE Stream)                       │
│         │                                                    │
│  [AgentLog apiInterceptor]                                   │
│         │ 3. 监听 res.on('data')，拼接 Chunk 解析 SSE        │
│         │ 4. 提取 Content 与 Reasoning Content               │
│         │ 5. 触发 'session' 事件 (异步上报)                  │
│         ▼                                                    │
│  [调用方原本的回调函数]                                      │
└─────────│────────────────────────────────────────────────────┘
          │
          ▼ 异步上报
┌──────────────────────────────────────────────────────────────┐
│ AgentLog Backend (Fastify :7892)                             │
│  POST /api/sessions → SQLite agent_sessions 表               │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. 拦截规则与数据解析

为了避免影响 VS Code 中海量的普通网络请求（如插件下载、遥测等），拦截器使用了白名单和正则匹配机制。

### 3.1 拦截触发条件

必须同时满足以下三个条件才会被真正拦截并解析：
1. **Method**: 必须是 `POST` 请求。
2. **Host**: 命中 `AI_HOST_PATTERNS`。包含常见的主流模型 API 域名（如 `api.deepseek.com`, `api.openai.com`, `dashscope.aliyuncs.com` 等）以及本地地址（用于 Ollama / LM Studio）。
3. **Path**: 命中 `COMPLETION_PATH_PATTERNS`。仅拦截大模型对话接口（如 `/v1/chat/completions`, `/v1/messages` 等），跳过鉴权或文件上传接口。

### 3.2 响应流 (SSE) 解析与推理提取

大模型的响应分为**非流式（JSON）**和**流式（SSE）**两种。

- **流式组装**：通过拦截 `res.on('data')`，按 `\n` 切分 `data: {...}` 块，提取 `choices[0].delta.content` 并进行累加计算。
- **推理过程 (Reasoning) 提取**：
  由于 DeepSeek-R1 等推理模型的兴起，拦截器针对性做了优化：
  1. 优先提取规范的 `reasoning_content` 字段。
  2. 若无该字段，则正则提取全量文本中的 `<think>...</think>` 标签内容。
  3. 入库时，会将已剥离的 `<think>` 标签从最终的正文（Response）中剔除，保持数据的纯净性。

---

## 4. 核心类说明

主要逻辑集中在 apiInterceptor.ts。

| 类 / 方法 | 职责说明 |
|-----------|----------|
| `HttpApiInterceptor` | 继承自 `EventEmitter`。核心拦截器。负责执行 Monkey-patch 并处理 HTTP 报文。上报成功后对外 `emit('reported')`。 |
| `_intercept()` | **核心拦截逻辑**。代理了原本的 `req.write()` 和 `res.on('data')`，从而在请求发送时截获入参，在响应返回时截获出参。 |
| `InterceptorManager` | 管理拦截器生命周期。负责根据活动窗口推断 `workspacePath`，并在插件禁用时执行 `restoreHttp` 还原 Patch，防止内存泄漏。 |
| `inferSource()` | 尽力而为推断调用来源。当前通过读取 HTTP 头的 `User-Agent` 区分来源（如 `cline`, `cursor`, `continue` 等）。 |

---

## 5. 与 Track A 的协同策略

由于 Track A（Lifecycle Hooks）覆盖了原生 Copilot Chat 和 Claude Code，而 Track B（HTTP 拦截）作为全局兜底。在后续演进中需要注意**防重处理**：
- **主动避让**：如果检测到请求头中存在 Copilot 的特殊凭证，或者 Header 中存在某种能证明是由 `agentlog.chat` participant 发起的标志，拦截器应直接 `return original(...)` 透传，避免同一条数据被 Track A 和 Track B 重复记录。

---

## 6. 测试步骤

在开发模式下验证 HTTP 拦截器的工作状态：

1. **启动测试环境**：
   - 启动 AgentLog Backend (`npm run start` in backend).
   - 启动 AgentLog VS Code 插件 (F5).

2. **触发拦截**：
   - 在新打开的 VS Code (Extension Development Host) 中，安装一个支持自定义 API Key 的开源大模型插件（如 **Cline** 或 **Continue**）。
   - 配置该插件使用 DeepSeek API（`api.deepseek.com`）或本地 Ollama（`http://127.0.0.1:11434`）。
   - 向 AI 发起一次普通的对话（例如：“解释一下冒泡排序”）。

3. **验证结果**：
   - 观察 VS Code 输出面板的 **AgentLog** 频道，预期看到类似：
     `[AgentLog][DEBUG] [拦截] https://api.deepseek.com/v1/chat/completions`
     `[AgentLog] 会话已记录 → id=xxxx`
   - 查询本地数据库，确认记录中包含完整的 `prompt`，如果是 DeepSeek-R1，还应包含 `reasoning` 字段。

---

## 7. 局限性与后续演进

### 已知局限性
1. **Fetch API 与预编译扩展**：Monkey-patch 只能拦截原生 Node.js 的 `http` 模块。如果某个插件使用了基于 libcurl 编译的二进制网络请求库，或是最新 Node.js 的原生 `fetch`（未通过 http 模块桥接），则 Track B 无法拦截。
2. **Patch 冲突风险**：若其他扩展（如代理插件）强行冻结或覆写了 `http.request` 且未调用上游链路，可能导致拦截失败或 VS Code 网络崩溃。

### 后续升级计划
- [ ] **增强 Headers 追踪**：将 HTTP 拦截时的 Headers 原样持久化到数据库的 `metadata.headers`，用于在后端复盘哪些未知的 Agent 在进行频繁请求。
- [ ] **支持原生 Fetch Patch**：研究全局替换 `globalThis.fetch` 的可行性，以应对越来越多改用 Fetch API 发起请求的新一代 AI 扩展。
- [ ] **拦截请求白名单配置**：允许用户在 VS Code 设置中增加自定义的内网模型域名 `agentlog.intercept.customHosts`，使其也能被记录。
- [ ] **性能监控告警**：监控因为拦截拼接带来的内存占用情况（对于超长响应流），必要时引入流式写入本地临时文件的降级策略。
```