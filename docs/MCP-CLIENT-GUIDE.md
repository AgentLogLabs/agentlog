# AgentLog MCP 客户端接入指南

> 适用版本：AgentLog MCP Server v0.4.0+  
> 协议：Model Context Protocol (MCP) stdio 模式

本文档面向需要接入 AgentLog MCP Server 的 AI 编码客户端（如 Cline、Cursor、OpenCode、Continue 等），说明三个工具的完整调用规范、调用时机、字段语义，以及针对不同模型类型的特殊处理规则。

---

## 目录

1. [概述](#1-概述)
2. [工具列表](#2-工具列表)
3. [log_turn — 逐轮记录](#3-log_turn--逐轮记录)
4. [log_intent — 任务汇总](#4-log_intent--任务汇总)
5. [query_historical_interaction — 历史查询](#5-query_historical_interaction--历史查询)
6. [完整调用流程](#6-完整调用流程)
7. [推理模型特殊处理](#7-推理模型特殊处理)
   - [7.0 每轮必须记录的两件事](#70-每轮必须记录的两件事)
8. [字段速查表](#8-字段速查表)
9. [常见错误处理](#9-常见错误处理)

---

## 1. 概述

AgentLog MCP Server 以 **stdio** 模式运行，由 VS Code 插件在启动时自动拉起。客户端通过标准 MCP 协议与其通信，调用以下三个工具将 AI 交互过程实时记录到本地 SQLite 数据库。

**设计原则**

- 每条消息产生后**立即**调用 `log_turn`，不要批量延迟上报
- 首次调用 `log_turn` 时**不传** `session_id`，服务端自动创建会话并返回 `session_id`
- 后续所有调用**必须**传入同一个 `session_id`，确保消息追加到同一会话
- 任务完成后调用 `log_intent` 汇总结果；若不调用 `log_intent` 也不影响 transcript 完整性
- `query_historical_interaction` 为只读工具，不产生任何副作用

**source 自动推断规则**

MCP Server 在 initialize 握手阶段读取客户端的 `clientInfo.name`，自动推断 `source` 字段：

| clientInfo.name 包含 | source 值      |
|----------------------|----------------|
| `opencode`           | `opencode`     |
| `cline` / `roo`      | `cline`        |
| `cursor`             | `cursor`       |
| `claude`             | `claude-code`  |
| `copilot` / `vscode` | `copilot`      |
| `continue`           | `continue`     |
| 其他                 | `mcp-tool-call`|

也可通过环境变量 `AGENTLOG_SOURCE` 强制指定，优先级高于自动推断。

---

## 2. 工具列表

| 工具名                         | 读写 | 调用时机             |
|-------------------------------|------|----------------------|
| `log_turn`                    | 写   | 每轮消息产生后立即调用 |
| `log_intent`                  | 写   | 任务整体完成后调用一次 |
| `query_historical_interaction`| 只读 | 需要检索历史记录时调用 |

---

## 3. log_turn — 逐轮记录

### 3.1 用途

记录单条消息（user / assistant / tool），构建完整的多轮对话 transcript。

- **首次调用**（无 `session_id`）：自动创建新会话，返回 `session_id`
- **后续调用**（有 `session_id`）：将消息追加到已有会话的 transcript 末尾

### 3.2 参数

| 参数             | 类型     | 必填 | 说明 |
|-----------------|----------|------|------|
| `role`          | `string` | **是** | 消息角色：`user` / `assistant` / `tool` |
| `content`       | `string` | **是** | 消息正文。推理模型推理阶段 content 可为空字符串（见第 7 节） |
| `session_id`    | `string` | 否   | 首次调用时省略；后续调用必须传入 |
| `reasoning`     | `string` | 否   | 推理模型本轮的完整思考过程，仅 `role=assistant` 时有意义（见第 7 节） |
| `tool_name`     | `string` | 否   | `role=tool` 时的工具名称，如 `bash`、`read`、`edit` |
| `tool_input`    | `string` | 否   | `role=tool` 时的工具输入摘要，过长时截断 |
| `model`         | `string` | 否   | AI 模型完整名称，**仅首次调用时有效**，如实填写 |
| `workspace_path`| `string` | 否   | 工作区根目录绝对路径，**仅首次调用时有效**，默认当前目录 |
| `token_usage`   | `object` | 否   | 当前累计 Token 用量（见 3.3 节） |

#### token_usage 对象结构

```json
{
  "input_tokens": 1024,
  "output_tokens": 512,
  "cache_creation_tokens": 256,
  "cache_read_tokens": 128,
  "api_call_count": 3
}
```

> 传入的 token_usage 应为**累计值**（截至本轮的总计），非本轮增量。

### 3.3 返回值

成功时返回包含 `session_id` 的文本消息：

```
消息已记录（session_id=abc123xyz）。后续调用请传入此 session_id。
```

**客户端必须解析并保存返回的 `session_id`**，用于后续所有 `log_turn` 和 `log_intent` 调用。

失败时 `isError: true`，消息内容为错误描述。

### 3.4 调用示例

**首次调用（创建会话，记录 user 消息）**

```json
{
  "role": "user",
  "content": "帮我用 TypeScript 实现一个带 TTL 的 LRU 缓存类",
  "model": "deepseek-r1",
  "workspace_path": "/Users/dev/my-project"
}
```

**记录 assistant 消息（普通模型）**

```json
{
  "session_id": "abc123xyz",
  "role": "assistant",
  "content": "好的，我来实现一个 TTL + LRU 缓存...",
  "token_usage": {
    "input_tokens": 512,
    "output_tokens": 1024
  }
}
```

**记录 assistant 消息（推理模型，附带 reasoning）**

```json
{
  "session_id": "abc123xyz",
  "role": "assistant",
  "content": "好的，我来实现一个 TTL + LRU 缓存...",
  "reasoning": "用户需要一个支持 TTL 过期和容量限制的 LRU 缓存。Map 天然保持插入顺序，可以利用这一特性模拟 LRU...",
  "token_usage": {
    "input_tokens": 512,
    "output_tokens": 1024
  }
}
```

**记录 tool 执行结果**

```json
{
  "session_id": "abc123xyz",
  "role": "tool",
  "content": "文件写入成功：src/cache/LRUCache.ts（128 行）",
  "tool_name": "write",
  "tool_input": "filePath=src/cache/LRUCache.ts"
}
```

---

## 4. log_intent — 任务汇总

### 4.1 用途

在一项任务完成后调用一次，记录任务目标和受影响文件。`reasoning` 字段由服务端从 transcript 自动生成，客户端无需传入。

**推荐模式**：先用 `log_turn` 逐轮记录，任务结束后再调用 `log_intent` 汇总。两者配合使用时传入 `session_id` 以关联到同一会话。

### 4.2 参数

| 参数              | 类型            | 必填 | 说明 |
|------------------|-----------------|------|------|
| `task`           | `string`        | **是** | 本次任务的目标描述（一两句话） |
| `model`          | `string`        | **是** | AI 模型完整名称，如实填写，不得使用占位符 |
| `session_id`     | `string`        | 否   | 已有会话 ID（由 log_turn 返回）；不传则新建会话 |
| `affected_files` | `string[]`      | 否   | 受影响的文件路径列表（相对于 workspace_path） |
| `workspace_path` | `string`        | 否   | 工作区根目录绝对路径，默认 MCP 进程工作目录 |
| `transcript`     | `object[]`      | 否   | 完整对话记录（未使用 log_turn 时一次性提交，见 4.3 节） |
| `token_usage`    | `object`        | 否   | 最终累计 Token 用量 |

### 4.3 transcript 一次性提交格式

仅在**未使用 log_turn** 的情况下，可通过 `transcript` 参数一次性提交完整对话记录：

```json
{
  "transcript": [
    { "role": "user", "content": "帮我重构这个函数" },
    {
      "role": "assistant",
      "content": "已完成重构...",
      "reasoning": "分析原函数的职责...",
      "timestamp": "2026-03-25T10:00:00Z"
    },
    {
      "role": "tool",
      "content": "文件已更新",
      "tool_name": "edit",
      "tool_input": "filePath=src/utils.ts"
    }
  ]
}
```

每条消息支持的字段：`role`（必填）、`content`（必填）、`reasoning`、`tool_name`、`tool_input`、`timestamp`。

### 4.4 调用示例

```json
{
  "task": "实现带 TTL 的 LRU 缓存类，支持自动过期和容量限制",
  "model": "deepseek-r1",
  "session_id": "abc123xyz",
  "affected_files": [
    "src/cache/LRUCache.ts",
    "src/cache/LRUCache.test.ts"
  ]
}
```

---

## 5. query_historical_interaction — 历史查询

### 5.1 用途

只读工具，从本地数据库检索历史 AI 交互记录，供 Agent 参考历史决策、避免重复工作，或用于调试分析。

### 5.2 参数

所有参数均为可选，不传任何参数时返回最近 20 条记录。

| 参数                  | 类型      | 说明 |
|----------------------|-----------|------|
| `session_id`         | `string`  | 精确查询单条会话（传入后忽略其他过滤参数，返回含完整 transcript） |
| `filename`           | `string`  | 文件名或路径片段（模糊匹配 affected_files） |
| `keyword`            | `string`  | 在 prompt / response / note 中全文搜索 |
| `start_date`         | `string`  | 时间范围起始，ISO 8601，如 `"2026-03-01"` |
| `end_date`           | `string`  | 时间范围截止，ISO 8601，如 `"2026-03-31"` |
| `commit_hash`        | `string`  | 查找绑定到指定 Commit 的会话（支持短 SHA） |
| `provider`           | `string`  | 按模型提供商过滤，如 `"deepseek"`、`"anthropic"` |
| `source`             | `string`  | 按 Agent 来源过滤，如 `"cline"`、`"cursor"` |
| `page`               | `number`  | 页码，从 1 开始，默认 1 |
| `page_size`          | `number`  | 每页条数，最大 100，默认 20 |
| `include_transcript` | `boolean` | 列表结果是否包含完整 transcript，默认 false |

### 5.3 返回结构

```json
{
  "total": 42,
  "page": 1,
  "pageSize": 20,
  "records": [
    {
      "id": "abc123xyz",
      "createdAt": "2026-03-25T10:00:00.000Z",
      "provider": "deepseek",
      "model": "deepseek-r1",
      "source": "cline",
      "workspacePath": "/Users/dev/my-project",
      "prompt": "帮我实现...",
      "response": "已完成...",
      "reasoning": "[User]\n...\n\n[Assistant]\n<think>\n...\n</think>\n...",
      "commitHash": "a1b2c3d4",
      "affectedFiles": ["src/cache/LRUCache.ts"],
      "tags": [],
      "durationMs": 3500
    }
  ]
}
```

---

## 6. 完整调用流程

### 6.1 标准多轮对话流程

```
用户发送消息
    │
    ▼
log_turn(role="user", content="...", model="...", workspace_path="...")
    │ 返回 session_id="abc123"
    ▼
模型推理 + 生成回复
    │
    ▼
log_turn(session_id="abc123", role="assistant", content="...", reasoning="...")
    │  ← 推理模型必须传 reasoning；每轮 assistant 均需记录
    ▼
执行工具调用（如写文件、读文件、执行命令等）
    │
    ▼
log_turn(session_id="abc123", role="tool", content="执行结果摘要",
         tool_name="write", tool_input="filePath=src/foo.ts")
    │  ← 每次工具调用单独记录一次，tool_input 须含文件路径
    ▼
（继续下一轮对话，重复 assistant + tool 步骤...）
    │
    ▼
任务完成
    │
    ▼
log_intent(session_id="abc123", task="...", model="...",
           affected_files=["src/foo.ts", "src/bar.ts"])
    │  ← 汇总所有本次任务改动过的文件路径
```

### 6.2 调用时序约束

- `log_turn` 调用**必须**按消息产生顺序进行，不可乱序
- 同一轮的多次工具调用，每次均需单独调用一次 `log_turn(role="tool", ...)`
- `log_intent` 在整个任务结束后**只调用一次**
- 若任务因错误中断，仍应调用 `log_intent` 记录中断状态

### 6.3 会话生命周期

```
创建                  追加                        汇总
  │                    │                            │
  ▼                    ▼                            ▼
log_turn          log_turn ×N                  log_intent
(无 session_id)   (有 session_id)              (有 session_id)
                  assistant → reasoning         affected_files
                  tool      → tool_name/input
```

---

## 7. 推理模型特殊处理

`reasoning` 字段在 `TranscriptTurn` 和 `AgentSession` 中均表示推理过程，语义完全一致：
- `TranscriptTurn.reasoning`：单轮 assistant 消息的推理内容
- `AgentSession.reasoning`：会话级别的推理汇总（由服务端从 transcript 中各轮 reasoning 聚合生成）

### 7.0 每轮必须记录的两件事

对于推理模型（DeepSeek-R1、Claude extended thinking 等），**每完成一轮推理**，客户端必须完整记录以下两件事：

**① 推理过程（reasoning）**

在 `log_turn(role="assistant")` 中传入本轮完整的推理文本，**不得截断、不得省略**。这是 AgentLog 的核心价值所在——当开发者日后需要理解 AI 当时的决策逻辑时，完整的推理链路是唯一可依赖的证据。

```json
{
  "session_id": "abc123xyz",
  "role": "assistant",
  "content": "已完成修改，将原函数拆分为三个独立职责...",
  "reasoning": "原函数承担了数据获取、格式转换、错误处理三个职责，违反单一职责原则。\n拆分方案：\n1. fetchData() 负责网络请求\n2. transform() 负责格式转换\n3. handleError() 统一处理异常\n考虑到调用方不需要感知内部拆分，对外仍保留原函数名作为门面..."
}
```

**② 改动的文件（tool 轮次中的 tool_input）**

每次执行写文件、编辑文件、删除文件等操作时，在 `log_turn(role="tool")` 中通过 `tool_input` 记录涉及的文件路径。多个文件操作分别记录，不合并。

```json
{
  "session_id": "abc123xyz",
  "role": "tool",
  "content": "已写入 src/utils/fetchData.ts（42 行）",
  "tool_name": "write",
  "tool_input": "filePath=src/utils/fetchData.ts"
}
```

任务结束时在 `log_intent` 的 `affected_files` 中汇总本次任务所有改动过的文件：

```json
{
  "session_id": "abc123xyz",
  "task": "将 processData 函数按职责拆分为三个独立函数",
  "model": "deepseek-r1",
  "affected_files": [
    "src/utils/fetchData.ts",
    "src/utils/transform.ts",
    "src/utils/handleError.ts",
    "src/utils/index.ts"
  ]
}
```

> **为什么这两件事缺一不可？**  
> - 只有 `reasoning` 而无 `affected_files`：知道 AI 怎么想，但不知道改了哪里，无法做代码审查  
> - 只有 `affected_files` 而无 `reasoning`：知道改了哪里，但不知道为什么这样改，日后维护仍是黑盒

---

### 7.1 DeepSeek-R1

DeepSeek-R1 的流式 API 响应分两个阶段：

| 阶段     | `delta.content` | `delta.reasoning_content` |
|---------|-----------------|---------------------------|
| 推理阶段 | `""` (空字符串)  | 推理文本（非空）            |
| 回答阶段 | 回答文本（非空）  | `""` (空字符串)             |

**正确做法**：等待两个阶段的流式输出均结束后，合并为一次 `log_turn` 调用，将 `delta.reasoning_content` 的累积内容传入 `reasoning`：

```json
{
  "session_id": "abc123xyz",
  "role": "assistant",
  "content": "根据分析，建议使用 Map 实现 LRU...",
  "reasoning": "用户需要一个 TTL+LRU 缓存。Map 天然保持插入顺序，可以用来模拟 LRU...",
  "token_usage": {
    "input_tokens": 1024,
    "output_tokens": 768
  }
}
```

> **注意**：`content` 为空时，服务端会用 `"(pending)"` 占位，不会报错。但建议等到 `content` 非空后再调用，以确保记录的完整性。

### 7.2 Claude Extended Thinking

Claude 3.7+ 开启 extended thinking 时，响应中包含 `thinking` 类型的 content block，将其 `thinking` 字段内容传入 `reasoning`：

```json
{
  "session_id": "abc123xyz",
  "role": "assistant",
  "content": "以下是实现方案...",
  "reasoning": "让我逐步分析这个问题...\n首先考虑边界条件..."
}
```

### 7.3 其他支持推理输出的模型

同样适用，将模型的推理/思考内容映射到 `reasoning` 参数传入即可。`reasoning` 字段**不要截断**，完整保存有助于后续上下文恢复。

### 7.4 不支持推理输出的模型

普通模型（GPT-4o、Qwen-Max 等）不需要传 `reasoning`，省略该参数即可：

```json
{
  "session_id": "abc123xyz",
  "role": "assistant",
  "content": "以下是实现方案..."
}
```

---

## 8. 字段速查表

### 8.1 provider 枚举值

| 值           | 对应模型               |
|-------------|----------------------|
| `deepseek`  | DeepSeek-R1 / V3 系列 |
| `anthropic` | Claude 系列            |
| `openai`    | GPT / o 系列           |
| `qwen`      | 通义千问系列             |
| `kimi`      | Kimi / Moonshot 系列   |
| `doubao`    | 豆包系列                |
| `zhipu`     | GLM / ChatGLM 系列    |
| `minimax`   | MiniMax 系列           |
| `google`    | Gemini / Gemma 系列   |
| `ollama`    | 本地 Ollama 模型        |
| `unknown`   | 兜底值                 |

> provider 由服务端根据 `model` 名称自动推断，客户端通常无需关心。

### 8.2 source 枚举值

| 值             | 说明                   |
|---------------|----------------------|
| `cline`       | Cline VSCode 插件       |
| `cursor`      | Cursor IDE            |
| `opencode`    | OpenCode CLI          |
| `claude-code` | Claude Code           |
| `copilot`     | GitHub Copilot        |
| `continue`    | Continue 插件           |
| `mcp-tool-call`| 其他 MCP 客户端         |

### 8.3 role 枚举值

| 值           | 适用场景                                  |
|-------------|------------------------------------------|
| `user`      | 用户输入的每条消息                          |
| `assistant` | 模型生成的每条回复（含推理模型的最终回答）     |
| `tool`      | 每次工具调用的执行结果（bash / read / edit 等）|

---

## 9. 常见错误处理

### 9.1 session_id 丢失

**现象**：每次 `log_turn` 都不传 `session_id`，导致每条消息创建独立会话。

**原因**：未保存首次调用返回的 `session_id`。

**解决**：客户端应在对话开始时解析首次 `log_turn` 的返回文本，提取 `session_id=<value>` 并缓存，直到对话结束。

### 9.2 content 为空导致会话创建失败（历史问题，已修复）

**现象**（v0.4.0 之前）：DeepSeek-R1 推理阶段 `content` 为空字符串，首次 `log_turn` 返回错误，后续轮次全部丢失。

**现状**：v0.4.0 起服务端已对空 content 做兜底处理，空字符串不再触发 400 错误。推荐做法仍是等待 content 非空后再调用。

### 9.3 后端服务未启动

**现象**：`log_turn` 返回 `isError: true`，错误消息包含 `ECONNREFUSED` 或 `fetch failed`。

**解决**：确认 AgentLog 后端已启动（默认端口 7892）：

```bash
curl http://localhost:7892/health
```

若未启动，在 VS Code 中执行命令 `AgentLog: 启动本地后台服务`，或手动运行：

```bash
pnpm --filter @agentlog/backend dev
```

### 9.4 重复记录同一消息

**现象**：transcript 中出现内容相同的重复消息。

**原因**：流式响应的每个 chunk 都触发了 `log_turn`，而非等待完整消息。

**解决**：`log_turn` 应在**完整消息生成结束后**调用，传入聚合后的完整 content，而非流式 chunk。

### 9.5 工具调用遗漏

**现象**：transcript 中只有 user / assistant 消息，缺少 tool 执行记录。

**解决**：每次工具调用（无论成功或失败）执行完毕后，均调用一次 `log_turn(role="tool", ...)`，`content` 填入执行结果摘要（失败时填错误信息）。

---

*文档版本：v0.4.1 | 最后更新：2026-03-25*
