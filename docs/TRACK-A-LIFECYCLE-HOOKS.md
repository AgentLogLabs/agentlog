# Track A — Lifecycle Hooks 技术设计文档

> AgentLog 通过 AI Agent 提供的生命周期钩子（而非 HTTP 拦截）捕获 Prompt / Reasoning / Response，
> 实现对 AI 编程会话的完整记录。

---

## 目录

- [Track A — Lifecycle Hooks 技术设计文档](#track-a--lifecycle-hooks-技术设计文档)
  - [目录](#目录)
  - [1. 方案概览](#1-方案概览)
  - [2. 架构与数据流](#2-架构与数据流)
    - [2.1 链路 A：Claude Code Hooks（命令行 Agent）](#21-链路-aclaude-code-hooks命令行-agent)
    - [2.2 链路 B：Copilot Chat Participant（VS Code 内置 Agent）](#22-链路-bcopilot-chat-participantvs-code-内置-agent)
  - [3. Shared Types 扩展](#3-shared-types-扩展)
  - [4. 后端实现](#4-后端实现)
    - [4.1 Hook 路由 — `/api/hooks/:agent/:event`](#41-hook-路由--apihooksagentevent)
    - [4.2 hookService — Transcript 解析与入库](#42-hookservice--transcript-解析与入库)
  - [5. VS Code Extension 实现](#5-vs-code-extension-实现)
    - [5.1 hookInstaller — Claude Code Hook 安装器](#51-hookinstaller--claude-code-hook-安装器)
    - [5.2 copilotChatParticipant — `@agentlog` Chat Participant](#52-copilotchatparticipant--agentlog-chat-participant)
  - [6. 文件清单](#6-文件清单)
    - [新增](#新增)
    - [修改](#修改)
  - [7. 测试步骤](#7-测试步骤)
    - [7.1 后端 Hook 端点（Claude Code 链路）](#71-后端-hook-端点claude-code-链路)
      - [准备](#准备)
      - [步骤 1：创建模拟 Transcript 文件](#步骤-1创建模拟-transcript-文件)
      - [步骤 2：模拟 Claude Code Stop Hook 调用](#步骤-2模拟-claude-code-stop-hook-调用)
      - [步骤 3：验证数据入库](#步骤-3验证数据入库)
      - [步骤 4：测试 hookInstaller（可选）](#步骤-4测试-hookinstaller可选)
    - [7.2 Copilot Chat Participant 链路](#72-copilot-chat-participant-链路)
      - [前置条件](#前置条件)
      - [步骤 1：编译并启动插件](#步骤-1编译并启动插件)
      - [步骤 2：在 Copilot Chat 中使用 @agentlog](#步骤-2在-copilot-chat-中使用-agentlog)
      - [步骤 3：检查输出日志](#步骤-3检查输出日志)
      - [步骤 4：验证数据入库](#步骤-4验证数据入库)
      - [步骤 5：验证多轮对话（可选）](#步骤-5验证多轮对话可选)
  - [8. 与 Track B（HTTP 拦截）的对比](#8-与-track-bhttp-拦截的对比)
  - [9. 后续规划](#9-后续规划)

---

## 1. 方案概览

Track A 的核心思路是 **不做 HTTP 请求拦截，而是利用 Agent 自身提供的钩子机制** 来获取对话数据。

当前落地了两条链路：

| 链路 | 目标 Agent | 触发方式 | 数据来源 |
|------|-----------|---------|---------|
| **A — Claude Code Hooks** | Claude Code CLI | Claude Code 在 Stop 事件时通过 `curl` POST 到后端 | `transcript_path` JSONL 文件 |
| **B — Copilot Chat Participant** | VS Code Copilot（Claude Haiku 4.5 等） | 用户在 Chat 面板输入 `@agentlog` | `request.model.sendRequest()` 实时流 |

两条链路最终都将数据写入同一个后端的 `agent_sessions` 表。

---

## 2. 架构与数据流

### 2.1 链路 A：Claude Code Hooks（命令行 Agent）

```text
┌─────────────────────────────────────────────────────────┐
│ Claude Code CLI                                         │
│                                                         │
│  用户对话 → 模型响应 → 触发 Stop 事件                     │
│                │                                        │
│                ▼                                        │
│  读取 ~/.claude/settings.json 中的 hooks 配置             │
│                │                                        │
│                ▼                                        │
│  执行 hook command:                                      │
│  curl -sf -X POST                                       │
│    'http://localhost:7892/api/hooks/claude-code/Stop'    │
│    -H 'Content-Type: application/json'                  │
│    -d @-                   ◄── stdin: JSON payload      │
│         │                       (含 transcript_path,    │
│         │                        session_id, cwd)       │
└─────────│───────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────┐
│ AgentLog Backend (Fastify :7892)                        │
│                                                         │
│  POST /api/hooks/claude-code/Stop                       │
│         │                                               │
│         ▼                                               │
│  hookService.dispatchHookEvent()                        │
│         │                                               │
│         ▼                                               │
│  handleClaudeCodeStop(payload)                          │
│    1. readTranscript(payload.transcript_path)            │
│    2. parseLastTurn(entries)                             │
│       → 提取 prompt / response / reasoning / model      │
│    3. createSession({ source: 'claude-code', ... })     │
│         │                                               │
│         ▼                                               │
│  SQLite agent_sessions 表                               │
└─────────────────────────────────────────────────────────┘
```

**关键细节：**

- Claude Code 的 hook 配置写在 `~/.claude/settings.json` 的 `hooks.Stop` 数组中。
- hook command 使用 `curl -d @-` 从 stdin 接收 Claude Code 传入的 JSON payload。
- payload 中的 `transcript_path` 指向一个 JSONL 文件，每行是对话中的一条消息。
- `parseLastTurn()` 遍历所有条目，取最后一条 user 消息作为 prompt，最后一条 assistant 消息作为 response，thinking 块作为 reasoning。

### 2.2 链路 B：Copilot Chat Participant（VS Code 内置 Agent）

```text
┌─────────────────────────────────────────────────────────┐
│ VS Code Copilot Chat 面板                                │
│                                                         │
│  用户输入:  @agentlog 帮我重构这个函数                     │
│         │                                               │
│         ▼                                               │
│  路由到 agentlog.chat participant handler                │
└─────────│───────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────┐
│ copilotChatParticipant.ts (扩展进程内)                    │
│                                                         │
│  1. 从 chatContext.history 构建多轮消息                    │
│  2. request.model.sendRequest(messages)                  │
│     └─ model = 用户在 Chat 面板选的模型                   │
│        (如 Claude Haiku 4.5 / GPT-4o)                   │
│  3. for await (chunk of chatResponse.text)              │
│     ├─ response.markdown(chunk)  → 流式输出到 Chat 面板   │
│     └─ fullResponse += chunk     → 捕获完整响应          │
│  4. getBackendClient().createSession({                  │
│       source: 'copilot',                                │
│       model: model.name,                                │
│       prompt, response: fullResponse, durationMs        │
│     })                                                  │
│         │                                               │
│         ▼                                               │
│  POST /api/sessions → SQLite agent_sessions 表           │
└─────────────────────────────────────────────────────────┘
```

**关键细节：**

- Chat Participant 通过 `vscode.chat.createChatParticipant('agentlog.chat', handler)` 注册。
- `request.model` 是用户在 Copilot Chat 下拉菜单中选择的模型，无需手动 `selectChatModels()`。
- `isSticky: true` 使用户一旦开始 `@agentlog` 对话，后续消息自动路由到此 participant。
- 上报走 `BackendClient.createSession()` 直连后端（扩展进程内调用，无需 curl）。
- 上报失败不阻断用户交互，仅写日志。

---

## 3. Shared Types 扩展

在 `packages/shared/src/types.ts` 中新增：

| 类型 | 用途 |
|------|------|
| `AgentSource` 新增 `'claude-code'` | 标识来自 Claude Code Hook 的会话 |
| `ClaudeCodeEvent` | Claude Code 支持的 Hook 事件名枚举 |
| `ClaudeCodeHookPayload` | Stop 事件 payload 的完整结构 |
| `TranscriptEntry` | JSONL 文件中每行记录的结构 |
| `TranscriptContentBlock` | 消息中的内容块（text / thinking / tool_use） |

已有的 `'copilot'` 在 `AgentSource` 中本就存在，无需额外添加。

---

## 4. 后端实现

### 4.1 Hook 路由 — `/api/hooks/:agent/:event`

**文件**: `packages/backend/src/routes/hooks.ts`

```text
POST /api/hooks/:agent/:event

参数:
  :agent — AI Agent 标识（MVP 仅支持 'claude-code'）
  :event — Hook 事件名（如 'Stop', 'SubagentStop'）

请求体: Claude Code 的 hook payload JSON

响应:
  201 — 会话创建成功，返回 AgentSession
  200 — 事件已接收但无需创建会话（如 UserPromptSubmit）
  400 — 不支持的 agent
  500 — 处理失败
```

路由注册在 `packages/backend/src/index.ts`，与 sessions / commits / export 并列。

### 4.2 hookService — Transcript 解析与入库

**文件**: `packages/backend/src/services/hookService.ts`

核心函数：

| 函数 | 职责 |
|------|------|
| `readTranscript(path)` | 读取 JSONL 文件，逐行 `JSON.parse`，容忍格式错误的行 |
| `parseLastTurn(entries)` | 遍历所有条目，提取最后一轮的 prompt / response / reasoning / model |
| `handleClaudeCodeStop(payload)` | 读取 transcript → parseLastTurn → createSession 入库 |
| `dispatchHookEvent(agent, event, payload)` | 根据 agent + event 分发到具体 handler |

**Transcript JSONL 格式兼容**：

`normalizeEntry()` 函数兼容两种常见格式：

```text
格式 1 (扁平):  {"role":"user","content":"..."}
格式 2 (嵌套):  {"message":{"role":"user","content":[...],"model":"claude-sonnet-4-20250514"}}
```

content 字段支持纯字符串和 ContentBlock 数组两种形式。

---

## 5. VS Code Extension 实现

### 5.1 hookInstaller — Claude Code Hook 安装器

**文件**: `packages/vscode-extension/src/hooks/hookInstaller.ts`

| 导出函数 | 职责 |
|---------|------|
| `installClaudeCodeHooks(backendUrl)` | 写入 `~/.claude/settings.json` 的 hooks.Stop 配置 |
| `uninstallClaudeCodeHooks()` | 移除包含 `agentlog` 标记的 hook 条目 |
| `getClaudeCodeHookStatus()` | 返回各事件的安装状态 |

**安装后 `~/.claude/settings.json` 的变化**：

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/Stop' -H 'Content-Type: application/json' -d @- 2>/dev/null || true # agentlog"
          }
        ]
      }
    ]
  }
}
```

**识别机制**：curl 命令末尾的 `# agentlog` 注释作为标记，供 status check 和 uninstall 时匹配。

**VS Code 命令**：

| 命令 ID | 标题 |
|---------|------|
| `agentlog.installHooks` | AgentLog: 安装 Claude Code Hook（自动上报 AI 会话） |
| `agentlog.uninstallHooks` | AgentLog: 移除 Claude Code Hook |

### 5.2 copilotChatParticipant — `@agentlog` Chat Participant

**文件**: `packages/vscode-extension/src/hooks/copilotChatParticipant.ts`

| 导出函数 | 职责 |
|---------|------|
| `registerCopilotChatParticipant(outputChannel)` | 注册 Chat Participant 并返回 Disposable |

**`package.json` 声明**：

```json
{
  "contributes": {
    "chatParticipants": [
      {
        "id": "agentlog.chat",
        "fullName": "AgentLog AI 记录仪",
        "name": "agentlog",
        "description": "通过 AgentLog 记录 AI 对话（使用当前选中的 Copilot 模型）",
        "isSticky": true
      }
    ]
  }
}
```

**多轮上下文**：`buildMessages()` 从 `chatContext.history` 中提取历史的 `ChatRequestTurn`（user）和 `ChatResponseTurn`（assistant），拼接为 `LanguageModelChatMessage[]` 传给模型。

**模型推断**：`inferProvider(model.family)` 根据 family 字符串（如 `"claude-3.5-haiku"`、`"gpt-4o"`）推断 `ModelProvider`。

**最低 VS Code 版本**：`^1.93.0`（Chat Participant API + Language Model API 稳定版要求）。

---

## 6. 文件清单

### 新增

| 文件 | 说明 |
|------|------|
| `packages/backend/src/routes/hooks.ts` | Hook 路由 `POST /api/hooks/:agent/:event` |
| `packages/backend/src/services/hookService.ts` | Transcript 解析 + Claude Code 事件处理 |
| `packages/vscode-extension/src/hooks/hookInstaller.ts` | Claude Code `~/.claude/settings.json` 读写 |
| `packages/vscode-extension/src/hooks/copilotChatParticipant.ts` | `@agentlog` Chat Participant |

### 修改

| 文件 | 变更 |
|------|------|
| `packages/shared/src/types.ts` | AgentSource 加 `'claude-code'`；新增 Hook 相关类型 |
| `packages/backend/src/index.ts` | 注册 hooksRoutes；/api 元信息加 hooks 端点 |
| `packages/vscode-extension/src/extension.ts` | import hookInstaller + copilotChatParticipant；注册命令和 participant |
| `packages/vscode-extension/package.json` | engines.vscode → ^1.93.0；新增 commands + chatParticipants |

---

## 7. 测试步骤

### 7.1 后端 Hook 端点（Claude Code 链路）

#### 准备

```bash
# 启动后端（使用临时数据库）
cd packages/backend
AGENTLOG_DB_PATH=/tmp/agentlog-test.db npx tsx src/index.ts
```

#### 步骤 1：创建模拟 Transcript 文件

```bash
cat > /tmp/test-transcript.jsonl << 'EOF'
{"role":"user","content":"请帮我写一个 hello world 函数"}
{"role":"assistant","content":[{"type":"thinking","thinking":"用户要一个 hello world，我用 TypeScript 写"},{"type":"text","text":"好的：\n\n```typescript\nfunction hello() {\n  console.log('Hello!');\n}\n```"}],"model":"claude-sonnet-4-20250514"}
EOF
```

#### 步骤 2：模拟 Claude Code Stop Hook 调用

```bash
echo '{
  "session_id": "test-001",
  "hook_event_name": "Stop",
  "transcript_path": "/tmp/test-transcript.jsonl",
  "cwd": "/tmp/my-project"
}' | curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/Stop' \
     -H 'Content-Type: application/json' -d @-
```

#### 步骤 3：验证数据入库

```bash
curl -s 'http://localhost:7892/api/sessions?pageSize=1' | python3 -m json.tool
```

**预期结果**：

- `source` = `"claude-code"`
- `provider` = `"anthropic"`
- `prompt` = `"请帮我写一个 hello world 函数"`
- `reasoning` = `"用户要一个 hello world，我用 TypeScript 写"`
- `response` 包含 TypeScript 代码块
- `metadata.claudeSessionId` = `"test-001"`
- `metadata.transcriptPath` = `"/tmp/test-transcript.jsonl"`

#### 步骤 4：测试 hookInstaller（可选）

```bash
# 验证安装
node -e "
const fs = require('fs'), os = require('os'), path = require('path');
const p = path.join(os.homedir(), '.claude', 'settings.json');
// 若文件已存在，先备份
if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');
"

# 在 VS Code 命令面板中执行: AgentLog: 安装 Claude Code Hook
# 然后检查文件内容:
cat ~/.claude/settings.json
# 应包含 hooks.Stop 数组，其中有 curl ... # agentlog 的条目

# 卸载:
# 在 VS Code 命令面板中执行: AgentLog: 移除 Claude Code Hook
cat ~/.claude/settings.json
# hooks.Stop 应已移除
```

### 7.2 Copilot Chat Participant 链路

#### 前置条件

- VS Code >= 1.93
- GitHub Copilot 扩展已安装并激活
- AgentLog 后端已启动（`http://localhost:7892`）

#### 步骤 1：编译并启动插件

```bash
cd packages/shared && npm run build
cd ../vscode-extension && npm run build
```

按 **F5** 启动 Extension Development Host。

#### 步骤 2：在 Copilot Chat 中使用 @agentlog

1. 打开 Copilot Chat 面板（`Ctrl+Shift+I` / `Cmd+Shift+I`）
2. 在模型选择器中切换到 **Claude 3.5 Haiku**（或其他可用模型）
3. 输入：`@agentlog 帮我写一个 TypeScript 的快速排序函数`
4. 等待响应完成

#### 步骤 3：检查输出日志

打开 VS Code 输出面板 → 选择 **AgentLog** 频道，应看到：

```text
[AgentLog] @agentlog 收到请求 — model=Claude 3.5 Haiku family=claude-3.5-haiku prompt="帮我写一个 TypeScript 的快速排序函数"
[AgentLog] 模型响应完成 (2345ms, 1234 chars)
[AgentLog] 会话已记录 → id=xxxxx
```

#### 步骤 4：验证数据入库

```bash
curl -s 'http://localhost:7892/api/sessions?source=copilot&pageSize=1' | python3 -m json.tool
```

**预期结果**：

- `source` = `"copilot"`
- `provider` = `"anthropic"`（由 family 推断）
- `model` = `"Claude 3.5 Haiku"` 或类似
- `prompt` = `"帮我写一个 TypeScript 的快速排序函数"`
- `response` 包含快速排序实现代码
- `durationMs` > 0
- `metadata.chatParticipant` = `"agentlog.chat"`
- `metadata.family` = `"claude-3.5-haiku"`

#### 步骤 5：验证多轮对话（可选）

在同一个 Chat 会话中继续输入（无需再次 `@agentlog`，因为 `isSticky: true`）：

```text
能加上泛型支持吗？
```

验证：
- Chat 面板正常输出
- 后端多了一条新的 session 记录
- 新记录的 prompt 为 `"能加上泛型支持吗？"`

---

## 8. 与 Track B（HTTP 拦截）的对比

| 维度 | Track A（Lifecycle Hooks） | Track B（HTTP 拦截） |
|------|--------------------------|---------------------|
| **实现方式** | Agent 主动推送 / Chat Participant 代理 | Monkey-patch http/https 模块 |
| **数据完整性** | 高：可获取完整 transcript、thinking | 中：依赖请求/响应拆包 |
| **稳定性** | 高：使用官方 API | 低：受插件加载顺序、引用缓存影响 |
| **侵入性** | 低：不修改其他扩展行为 | 高：全局 patch |
| **覆盖范围** | 需要 Agent 逐个适配 | 理论上覆盖所有 HTTP 请求 |
| **当前状态** | ✅ Claude Code + Copilot 已实现 | ⚠️ 原有代码保留，作为补充 |

---

## 9. 后续规划

- [ ] **Cursor Hook 适配** — 调研 Cursor 的 Hook 机制，在 hookService 中增加 `handleCursorStop()` 分支
- [ ] **Cline Hook 适配** — 调研 Cline 的任务事件，在 hookService 中增加支持
- [ ] **Copilot Chat 被动监听** — 关注 VS Code 后续版本是否开放 Chat 事件监听 API（免去 `@agentlog` 前缀）
- [ ] **Reasoning 提取增强** — 支持 DeepSeek-R1 的 `<think>` 标签解析（Copilot 链路中模型可能返回推理内容）
- [ ] **会话去重** — Claude Code Stop 事件可能重复触发，需基于 `session_id` 去重
- [ ] **安全与隐私** — transcript 文件敏感内容脱敏、本地数据清理策略
- [ ] **性能** — Hook command 添加超时（避免后端不可达时阻塞 Claude Code）；Chat Participant 上报改异步队列