# AgentLog 自动日志 Hook 系统设计规格

## 1. 背景与目标

### 1.1 问题

当前 AgentLog 依赖 Agent **主动调用** MCP 工具（`log_turn`/`log_intent`）来记录编码过程。实际测试表明，即使用了再清晰的规则文本，Agent 仍然会跳过 MCP 调用，导致记录不全。

### 1.2 解决方案

在**框架层（IDE/Agent Runtime）拦截关键事件**，自动调用 AgentLog MCP Server，无需 Agent 主动参与。

### 1.3 目标

为 AgentLog 实现跨 IDE 的**零摩擦自动日志记录**，覆盖：OpenCode、Cursor、Cline、Qoder、OpenClaw。

---

## 2. 各 IDE Hook 机制汇总

### 2.1 横向对比表

| IDE | Hook 系统名称 | 实现方式 | 自动日志可行性 |
|-----|-------------|---------|--------------|
| **OpenCode** | Plugin System | `~/.config/opencode/plugins/*.js` | ✅ **可行** - 已有雏形 |
| **Cursor** | Hooks System | `~/.cursor/hooks.json` + 脚本 | ✅ **可行** - 完善 |
| **Cline** | Settings Hooks | `~/.claude/settings.json` | ✅ **可行** - 部分实现 |
| **Qoder** | Hooks System | `~/.qoder/settings.json` | ✅ **可行** - 完善 |
| **Trae** | VS Code Extension | VSIX 安装 | ⚠️ **有限** - 仅插件可见 |
| **OpenClaw** | Skill Hooks | `skills/agentlog-auto` | ✅ **可行** - 已有实现 |
| **Claude Code** | Settings Hooks | `~/.claude/settings.json` | ✅ **可行** - 已有实现 |

### 2.2 关键事件覆盖

| 事件 | OpenCode | Cursor | Cline | Qoder | OpenClaw | Claude Desktop |
|------|----------|--------|-------|-------|----------|---------------|
| `session_start` | `session.created` | `sessionStart` | `TaskStart` | `SessionStart` | `session:start` | `*` |
| `user_message` | `chat.message` | - | `UserPromptSubmit` | `UserPromptSubmit` | - | - |
| `tool_before` | `tool.execute.before` | `preToolUse` | `PreToolUse` | `PreToolUse` | `tool:before_call` | - |
| `tool_after` | `tool.execute.after` | `postToolUse` | `PostToolUse` | `PostToolUse` | `tool:after_call` | - |
| `session_end` | `session.status(idle)` | `sessionEnd` | `TaskComplete` | `Stop` | `agent:end` | `Stop` |
| `reasoning` | `chat.message` | `afterAgentThought` | - | - | `onAgentEnd` | - |

---

## 3. 各 IDE 实现设计

### 3.1 OpenCode

**文件位置**: `~/.config/opencode/plugins/agentlog-auto/index.js`

**核心 Hooks**:
- `chat.message` → 记录用户消息，建立 session
- `tool.execute.before` → 记录工具开始时间
- `tool.execute.after` → 记录工具执行结果
- `session.status(idle)` → 调用 log_intent

**实现架构**:
```javascript
export default async function agentlogPlugin(input) {
  return {
    "chat.message": async (input, output) => { /* log user */ },
    "tool.execute.before": async (input, output) => { /* store startTime */ },
    "tool.execute.after": async (input, output) => { /* log tool */ },
  };
}
```

**MCP 调用方式**: 直接 HTTP POST 到 `localhost:7892/mcp`

**状态管理**: 内存中维护 `currentSessionId`, `turnCount`

**已创建文件**: `~/.config/opencode/plugins/agentlog-auto/index.js`（雏形已就绪）

---

### 3.2 Cursor

**配置位置**: `~/.cursor/hooks.json`

**核心 Hooks**:
- `sessionStart` → 记录 session 开始
- `postToolUse` → 记录工具执行（含 input/output）
- `afterShellExecution` → 记录 shell 命令
- `afterFileEdit` → 记录文件修改
- `afterAgentThought` → 记录推理过程
- `sessionEnd` → 调用 log_intent

**实现方式**: Shell 脚本 + HTTP POST

**Hook 脚本示例** (`~/.cursor/hooks/agentlog-hook.sh`):
```bash
#!/bin/bash
json_input=$(cat)
curl -sf -X POST 'http://localhost:7892/api/hooks/cursor' \
  -H 'Content-Type: application/json' \
  -d "$json_input" 2>/dev/null || true
exit 0
```

**hooks.json 配置**:
```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "./hooks/agentlog-hook.sh" }],
    "sessionEnd": [{ "command": "./hooks/agentlog-hook.sh" }],
    "postToolUse": [{ "command": "./hooks/agentlog-hook.sh" }],
    "afterShellExecution": [{ "command": "./hooks/agentlog-hook.sh" }],
    "afterFileEdit": [{ "command": "./hooks/agentlog-hook.sh" }],
    "afterAgentThought": [{ "command": "./hooks/agentlog-hook.sh" }]
  }
}
```

**后端需要新增**: `/api/hooks/cursor` 路由

---

### 3.3 Cline (VSCode 扩展)

**配置位置**: `~/.claude/settings.json`（与 Claude Code CLI 共享同一配置格式）

**现状**: AgentLog 已有 `Stop` hook 实现（`hookInstaller.ts`），但仅在任务结束时触发。

**核心 Hooks**:
- `TaskStart` → 记录 session 开始
- `PreToolUse` / `PostToolUse` → 记录工具执行
- `UserPromptSubmit` → 记录用户消息
- `Stop` → 调用 log_intent（已有）

**扩展方案**: 在现有 hook 系统上增加 `PostToolUse` 事件

**当前实现** (`hookInstaller.ts`):
```typescript
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/Stop' ..."
      }]
    }]
  }
}
```

**扩展后**:
```json
{
  "hooks": {
    "TaskStart": [...],
    "PreToolUse": [...],
    "PostToolUse": [...],
    "Stop": [...]
  }
}
```

**后端已有**: `/api/hooks/claude-code/:event` 路由（需扩展支持更多事件）

---

### 3.4 Qoder

**配置位置**: `~/.qoder/settings.json`

**核心 Hooks**:
- `SessionStart` → 记录 session 开始
- `UserPromptSubmit` → 记录用户消息
- `PreToolUse` → 记录工具调用前（可阻断）
- `PostToolUse` → 记录工具执行结果
- `Stop` → 调用 log_intent

**实现方式**: Shell 脚本 + HTTP POST

**Hook 脚本** (`~/.qoder/hooks/agentlog-hook.sh`):
```bash
#!/bin/bash
jq -n \
  --arg event "$HOOK_EVENT_NAME" \
  --arg session "$SESSION_ID" \
  --arg tool "$TOOL_NAME" \
  --argjson input "$TOOL_INPUT" \
  --argjson output "$TOOL_OUTPUT" \
  '{"event": $event, "session_id": $session, ...}' | \
curl -sf -X POST 'http://localhost:7892/api/hooks/qoder' \
  -H 'Content-Type: application/json' \
  -d @- 2>/dev/null || true
exit 0
```

**settings.json 配置**:
```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "~/.qoder/hooks/agentlog-hook.sh" }] }],
    "UserPromptSubmit": [...],
    "PreToolUse": [{ "matcher": ".*", "hooks": [...] }],
    "PostToolUse": [...],
    "Stop": [...]
  }
}
```

**后端需要**: `/api/hooks/qoder` 路由

---

### 3.5 OpenClaw

**已有实现**: `skills/agentlog-auto/src/index.ts`

**Hook 类型**: Skill-based hooks

**核心 Hooks**:
- `session:start` → startSession()
- `tool:before_call` → beforeToolCall()
- `tool:after_call` → afterToolCall()
- `agent:end` → onAgentEnd() → logIntent()
- `session:end` → onSessionEnd()

**实现状态**: ✅ 已有完整实现

**skill export**:
```typescript
export const skill = {
  name: 'agentlog-auto',
  version: '1.0.0',
  hooks: {
    'session:start': onSessionStart,
    'tool:before_call': beforeToolCall,
    'tool:after_call': afterToolCall,
    'agent:end': onAgentEnd,
    'session:end': onSessionEnd,
  },
};
```

---

### 3.6 Trae

**架构**: 基于 VS Code (engine ^1.96.0)

**问题**: Trae 没有自身的 Hook 系统，仅依赖标准 VS Code Extension API

**可行性**: ⚠️ 有限

**方案**:
1. VS Code Extension 可安装到 Trae（已验证兼容）
2. Extension 可拦截 VS Code 事件，但**无法拦截 Trae 内部 AI 执行**
3. Git Hook 绑定方案仍然有效

---

## 4. 各 IDE 配置使用指南

本节说明如何在各 IDE/Agent 中启用 AgentLog 自动日志功能。

### 4.1 OpenCode

**前置条件**：
- AgentLog MCP Server 已配置（`~/.config/opencode/config.json` 中的 `mcp.agentlog-mcp`）
- OpenCode 版本支持 Plugin 系统

**安装步骤**：

1. 确保 MCP Server 已配置：
```bash
cat ~/.config/opencode/config.json
# 确认 mcp.agentlog-mcp 已配置
```

2. Plugin 文件已放置于：
```
~/.config/opencode/plugins/agentlog-auto/index.js
```

3. 重启 OpenCode 使 Plugin 生效

**验证方法**：
- 启动 OpenCode，执行任意操作
- 检查 `~/.agentlog/agentlog.db` 中是否有新的 session 记录
- 查看 OpenCode 控制台输出 `[agentlog-auto]` 前缀的日志

**卸载方法**：
- 删除 `~/.config/opencode/plugins/agentlog-auto/` 目录
- 重启 OpenCode

---

### 4.2 Cursor

**前置条件**：
- Cursor IDE 已安装
- AgentLog MCP Server 正在运行（端口 7892）

**安装步骤**：

1. 创建 hook 脚本目录：
```bash
mkdir -p ~/.cursor/hooks
```

2. 创建 hook 脚本 `~/.cursor/hooks/agentlog-hook.sh`：
```bash
#!/bin/bash
json_input=$(cat)
curl -sf -X POST 'http://localhost:7892/api/hooks/cursor' \
  -H 'Content-Type: application/json' \
  -d "$json_input" 2>/dev/null || true
exit 0
```

3. 设置执行权限：
```bash
chmod +x ~/.cursor/hooks/agentlog-hook.sh
```

4. 创建/编辑 `~/.cursor/hooks.json`：
```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "./hooks/agentlog-hook.sh" }],
    "sessionEnd": [{ "command": "./hooks/agentlog-hook.sh" }],
    "postToolUse": [{ "command": "./hooks/agentlog-hook.sh" }],
    "afterShellExecution": [{ "command": "./hooks/agentlog-hook.sh" }],
    "afterFileEdit": [{ "command": "./hooks/agentlog-hook.sh" }],
    "afterAgentThought": [{ "command": "./hooks/agentlog-hook.sh" }]
  }
}
```

5. 重启 Cursor IDE

**验证方法**：
- 在 Cursor 中启动 Agent 模式（Cmd+K）
- 执行任意操作
- 检查 `~/.agentlog/agentlog.db`

**注意事项**：
- Hook 脚本需要在 Cursor 启动前存在
- 脚本执行有 30 秒超时限制
- 网络不可达时脚本静默失败，不影响 Cursor 正常工作

---

### 4.3 Cline (VSCode 扩展)

**前置条件**：
- Cline VSCode 扩展已安装
- AgentLog MCP Server 正在运行

**安装步骤**：

Cline 使用 `~/.claude/settings.json` 存储 hook 配置。可以通过 AgentLog VSCode 扩展的 UI 自动安装：

1. 在 VSCode/Cursor 中打开 AgentLog 侧边栏
2. 点击"配置 Hook"或"Install Hooks"
3. 选择"Claude Code / Cline"并确认

**手动安装**：

编辑 `~/.claude/settings.json`，添加：
```json
{
  "hooks": {
    "TaskStart": [{
      "hooks": [{
        "type": "command",
        "command": "curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/TaskStart' -H 'Content-Type: application/json' -d @- 2>/dev/null || true"
      }]
    }],
    "PreToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/PreToolUse' -H 'Content-Type: application/json' -d @- 2>/dev/null || true"
      }]
    }],
    "PostToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/PostToolUse' -H 'Content-Type: application/json' -d @- 2>/dev/null || true"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/Stop' -H 'Content-Type: application/json' -d @- 2>/dev/null || true"
      }]
    }]
  }
}
```

**验证方法**：
- 在 Cline 中启动任务
- 执行任意操作
- 检查 `~/.agentlog/agentlog.db`

---

### 4.4 Qoder

**前置条件**：
- Qoder IDE 已安装
- AgentLog MCP Server 正在运行

**安装步骤**：

1. 创建 hook 脚本目录：
```bash
mkdir -p ~/.qoder/hooks
```

2. 创建 hook 脚本 `~/.qoder/hooks/agentlog-hook.sh`：
```bash
#!/bin/bash
# 读取环境变量和 stdin
event="${HOOK_EVENT_NAME:-unknown}"
session="${SESSION_ID:-unknown}"
tool="${TOOL_NAME:-}"
input_json="${TOOL_INPUT:-'{}'}"
output_json="${TOOL_OUTPUT:-'{}'}"

# 构建 JSON payload
payload=$(jq -n \
  --arg event "$event" \
  --arg session "$session" \
  --arg tool "$tool" \
  --argjson input "$input_json" \
  --argjson output "$output_json" \
  '{
    event: $event,
    session_id: $session,
    tool_name: $tool,
    tool_input: $input,
    tool_output: $output
  }')

curl -sf -X POST 'http://localhost:7892/api/hooks/qoder' \
  -H 'Content-Type: application/json' \
  -d "$payload" 2>/dev/null || true
exit 0
```

3. 设置执行权限：
```bash
chmod +x ~/.qoder/hooks/agentlog-hook.sh
```

4. 编辑 `~/.qoder/settings.json`，添加 hooks 配置：
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "~/.qoder/hooks/agentlog-hook.sh"
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "~/.qoder/hooks/agentlog-hook.sh"
      }]
    }],
    "PreToolUse": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "~/.qoder/hooks/agentlog-hook.sh"
      }]
    }],
    "PostToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "~/.qoder/hooks/agentlog-hook.sh"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "~/.qoder/hooks/agentlog-hook.sh"
      }]
    }]
  }
}
```

5. 重启 Qoder IDE

**验证方法**：
- 在 Qoder 中启动 AI 任务
- 执行任意操作
- 检查 `~/.agentlog/agentlog.db`

---

### 4.5 OpenClaw

**前置条件**：
- OpenClaw agent 已安装
- AgentLog MCP Server 正在运行

**安装步骤**：

OpenClaw 通过 Skill 机制加载自动日志功能：

1. 确认 Skill 文件存在于：
```
~/.openclaw/skills/agentlog-auto/
# 或项目内的 .openclaw/skills/agentlog-auto/
```

2. 在 OpenClaw 中启用 Skill：
```bash
openclaw skill enable agentlog-auto
# 或在 OpenClaw 配置文件中添加
```

3. 配置 MCP Server URL（如果非默认端口）：
```bash
export AGENTLOG_MCP_URL=http://localhost:7892
```

**验证方法**：
- 启动 OpenClaw session
- 执行任意操作
- 检查 `~/.agentlog/agentlog.db`

---

### 4.6 Claude Code CLI

**前置条件**：
- Claude Code CLI 已安装（`npm install -g @anthropic-ai/claude-code`）
- AgentLog MCP Server 正在运行

**安装步骤**：

Claude Code 使用 `~/.claude/settings.json`，与 Cline 相同：

1. 创建/编辑 `~/.claude/settings.json`：
```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/Stop' -H 'Content-Type: application/json' -d @- 2>/dev/null || true"
      }]
    }]
  }
}
```

2. 可选：添加更多事件以支持完整日志：
```json
{
  "hooks": {
    "TaskStart": [{
      "hooks": [{
        "type": "command",
        "command": "curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/TaskStart' -H 'Content-Type: application/json' -d @- 2>/dev/null || true"
      }]
    }],
    "PreToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/PreToolUse' -H 'Content-Type: application/json' -d @- 2>/dev/null || true"
      }]
    }],
    "PostToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/PostToolUse' -H 'Content-Type: application/json' -d @- 2>/dev/null || true"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/Stop' -H 'Content-Type: application/json' -d @- 2>/dev/null || true"
      }]
    }]
  }
}
```

**验证方法**：
- 运行 `claude` 启动 CLI
- 执行任意操作
- 检查 `~/.agentlog/agentlog.db`

---

### 4.7 Trae

**前置条件**：
- Trae IDE 已安装
- AgentLog VSCode 扩展已安装（Trae 基于 VSCode 引擎）

**安装步骤**：

Trae 没有自身的 Hook 系统，但可以安装 AgentLog VSCode 扩展：

1. 安装 AgentLog VSCode 扩展：
```bash
code --install-extension ~/.vscode/extensions/agentloglabs.agentlog-vscode-*.vsix
# 或在 Trae 中通过 .vsix 文件安装
```

2. 在 Trae 中启用扩展并启动 AgentLog Backend

3. 通过 VSCode 命令面板配置 MCP：
- 按 `Cmd+Shift+P`
- 输入 "AgentLog: Configure MCP"
- 选择 Trae

**限制**：
- Trae 的 AI 执行事件无法被 VSCode Extension 拦截
- 仅能通过 AgentLog VSCode 扩展的 UI 查看和管理历史记录
- 自动日志功能依赖 Agent 主动调用 MCP（与当前 OpenCode 相同问题）

**建议**：使用 Git Hook 绑定作为 Trae 的兜底方案

---

## 5. Hook 机制实现原理

本节详细说明各 IDE Hook 系统的工作原理，帮助理解自动日志的技术基础。

### 5.1 OpenCode Plugin 系统

#### 架构

OpenCode 的 Plugin 系统是其核心扩展机制，插件以 JavaScript/TypeScript 模块形式存在：

```
~/.config/opencode/plugins/    # 全局插件目录
.opencode/plugins/            # 项目级插件目录
```

#### 加载流程

```
OpenCode 启动
    ↓
扫描插件目录（.js/.ts 文件）
    ↓
加载每个插件：执行默认导出函数
    ↓
Plugin 函数被调用，传入 context（project, client, $, directory, worktree）
    ↓
Plugin 返回 Hooks 对象
    ↓
OpenCode 将 Hooks 注册到事件总线
```

#### Plugin 函数签名

```typescript
import type { Plugin } from "@opencode-ai/plugin";

export default async function myPlugin(
  input: PluginInput,   // { client, project, directory, worktree, serverUrl, $ }
  options?: PluginOptions
): Promise<Hooks>
```

#### Hook 触发机制

OpenCode 的事件总线广播各类事件，Plugin 返回的 Hook 对象中的方法会被调用：

| 事件类型 | 触发时机 | Input |
|---------|---------|-------|
| `event` | 任何事件 | `{ event: Event }` |
| `chat.message` | 用户消息到达 | `{ sessionID, agent, model, messageID, variant }` + output `{ message, parts }` |
| `tool.execute.before` | 工具执行前 | `{ tool, sessionID, callID }` + output `{ args }` |
| `tool.execute.after` | 工具执行后 | `{ tool, sessionID, callID, args }` + output `{ title, output, metadata }` |
| `session.status` | Session 状态变化 | `{ sessionID, status }` |
| `config` | 配置加载时 | `{ config }` |

#### 会话跟踪实现

Plugin 通过内存变量跟踪当前 session：

```javascript
let currentSessionId = null;
let currentModel = null;
let turnCount = 0;

// chat.message 触发时建立/更新 session
"chat.message": async (input, output) => {
  currentSessionId = input.sessionID;
  currentModel = input.model?.modelID;
  await logUserMessage(output.parts, currentSessionId, currentModel);
}

// tool.execute.after 触发时记录工具调用
"tool.execute.after": async (input, output) => {
  if (!currentSessionId) {
    // 可能在 chat.message 之前触发，此时隐式创建 session
    currentSessionId = input.sessionID || `implicit_${Date.now()}`;
  }
  await logToolCall(input.tool, input.args, output.output, currentSessionId);
}
```

#### MCP 调用方式

Plugin 通过 HTTP 直接调用 AgentLog MCP Server：

```javascript
async function mcpCall(tool, args) {
  const response = await fetch("http://localhost:7892/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  return await response.json();
}
```

#### 状态持久化问题

OpenCode Plugin 进程与 OpenCode 主进程分离：
- Plugin 进程生命周期与 OpenCode 进程绑定
- OpenCode 重启后 Plugin 状态丢失
- 解决方案：每次 session start 都重新初始化状态

---

### 5.2 Cursor Hooks 系统

#### 架构

Cursor 基于 VS Code 引擎构建了独立的 Hook 系统，配置文件位于：

```
~/.cursor/hooks.json        # 全局 hooks 配置
~/.cursor/hooks/           # Hook 脚本目录
```

#### Hook 配置结构

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "./hooks/agentlog-hook.sh" }],
    "postToolUse": [{ "command": "./hooks/agentlog-hook.sh" }],
    ...
  }
}
```

#### 执行流程

```
用户操作触发 Hook 事件
    ↓
Cursor 读取 hooks.json 中对应事件的配置
    ↓
执行 command 指定的脚本（通过 shell）
    ↓
脚本接收 JSON payload（通过 stdin）
    ↓
脚本处理后通过 HTTP POST 发送
    ↓
Cursor 等待脚本执行完成（最多 30 秒）
    ↓
脚本退出码决定是否重试
```

#### 数据传递机制

Cursor 通过 **stdin** 传递 JSON payload：

```javascript
// Cursor hook 脚本接收数据的方式
const json_input = process.stdin.read();  // Node.js
// 或 bash: json_input=$(cat)
```

Hook payload 结构（根据事件类型不同）：

**sessionStart**:
```json
{
  "conversation_id": "xxx",
  "session_id": "xxx",
  "is_background_agent": false,
  "composer_mode": "agent",
  "model": "claude-3-5-sonnet",
  "workspace_roots": ["/path/to/project"]
}
```

**postToolUse**:
```json
{
  "conversation_id": "xxx",
  "session_id": "xxx",
  "tool_name": "Bash",
  "tool_input": { "command": "ls -la" },
  "tool_output": "total 24\ndrwxrwxrwxr-x  9 user staff  288 Apr  4 10:00 .\n...",
  "duration_ms": 45,
  "model": "claude-3-5-sonnet"
}
```

#### Shell 脚本实现

```bash
#!/bin/bash
# 读取 stdin 的 JSON
json_input=$(cat)

# 转发到 AgentLog 后端
curl -sf -X POST 'http://localhost:7892/api/hooks/cursor' \
  -H 'Content-Type: application/json' \
  -d "$json_input" \
  2>/dev/null || true

# 静默忽略错误，不影响 Cursor 正常工作
exit 0
```

#### 关键特性

| 特性 | 说明 |
|------|------|
| 同步执行 | Hook 脚本同步执行，Cursor 等待完成 |
| 超时限制 | 默认 30 秒超时 |
| 阻塞能力 | 可通过 exit code 2 阻塞后续操作（部分事件） |
| JSON via stdin | 数据通过标准输入传递 |
| 环境变量 | 部分事件会传递环境变量（如 `HOOK_EVENT_NAME`） |

---

### 5.3 Cline / Claude Code Hook 系统

#### 架构

Cline 和 Claude Code CLI 共享同一套 Hook 系统，配置位于：

```
~/.claude/settings.json
```

#### 与 Cursor 的区别

| 特性 | Cursor | Cline/Claude Code |
|------|--------|-------------------|
| 配置格式 | `hooks.json` | `settings.json` 内的 `hooks` 字段 |
| 事件数量 | 20+ 事件 | 8 个核心事件 |
| 脚本输入 | stdin JSON | stdin JSON |
| 阻塞能力 | 部分事件支持 | `PreToolUse` 可配置阻塞 |
| MCP 工具 Hook | 不支持 | 不支持 |

#### Hook 配置结构

```json
{
  "hooks": {
    "TaskStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "curl ..."
      }]
    }],
    "PreToolUse": [{
      "matcher": "read_file|write_to_file",  // 可选：过滤工具
      "hooks": [{
        "type": "command",
        "command": "curl ..."
      }]
    }],
    "Stop": [{ ... }]
  }
}
```

#### 事件详解

| 事件 | 触发时机 | 可用数据 |
|------|---------|---------|
| `TaskStart` | 任务开始 | `session_id`, `cwd`, `model` |
| `TaskResume` | 任务恢复 | `session_id`, `cwd` |
| `TaskCancel` | 任务取消 | `session_id`, `cwd` |
| `TaskComplete` | 任务完成 | `session_id`, `cwd`, `duration_ms` |
| `PreToolUse` | 工具执行前 | `session_id`, `tool_name`, `tool_input`, `cwd` |
| `PostToolUse` | 工具执行后 | `session_id`, `tool_name`, `tool_input`, `tool_output`, `duration_ms` |
| `UserPromptSubmit` | 用户消息提交 | `session_id`, `message`, `cwd` |
| `Stop` | Agent 停止响应 | `session_id`, `transcript_path` |

#### transcript_path 的使用

Claude Code/Cline 在 `Stop` 事件中提供 `transcript_path`，指向 JSONL 文件：

```json
{
  "session_id": "xxx",
  "hook_event_name": "Stop",
  "transcript_path": "/path/to/.claude/transcripts/xxx.jsonl",
  "cwd": "/path/to/project"
}
```

Hook 脚本可以读取该文件获取完整对话记录：

```bash
#!/bin/bash
payload=$(cat)
transcript_path=$(echo "$payload" | jq -r '.transcript_path // empty')

if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  # 读取 transcript 内容
  transcript=$(cat "$transcript_path")
  # 追加到 payload
  payload=$(echo "$payload" | jq --arg t "$transcript" '.transcript = $t')
fi

curl -sf -X POST 'http://localhost:7892/api/hooks/claude-code/Stop' \
  -H 'Content-Type: application/json' \
  -d "$payload"
```

---

### 5.4 Qoder Hook 系统

#### 架构

Qoder 的 Hook 系统设计受到 Claude Code 启发，配置位于：

```
~/.qoder/settings.json    # 全局配置（含 hooks）
~/.qoder/hooks/           # Hook 脚本目录
```

#### 与 Claude Code 的对比

| 特性 | Qoder | Claude Code |
|------|-------|------------|
| 配置格式 | `settings.json` 内的 `hooks` 字段 | 同 |
| 阻塞事件 | `PreToolUse`, `UserPromptSubmit`, `Stop` | 仅部分事件 |
| 环境变量 | `HOOK_EVENT_NAME`, `SESSION_ID`, `TOOL_NAME` 等 | 部分环境变量 |
| 超时限制 | 默认 30 秒 | 默认 30 秒 |

#### Hook 配置结构

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "~/.qoder/hooks/agentlog-hook.sh"
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "~/.qoder/hooks/agentlog-hook.sh"
      }]
    }],
    "PreToolUse": [{
      "matcher": ".*",  // 支持工具名过滤
      "hooks": [{
        "type": "command",
        "command": "~/.qoder/hooks/agentlog-hook.sh"
      }]
    }],
    "PostToolUse": [{ ... }],
    "Stop": [{ ... }]
  }
}
```

#### 环境变量机制

Qoder 通过环境变量传递上下文，Hook 脚本可直接读取：

```bash
#!/bin/bash

# Qoder 提供的环境变量
event="${HOOK_EVENT_NAME:-unknown}"
session="${SESSION_ID:-unknown}"
tool="${TOOL_NAME:-}"
cwd="${CWD:-}"

# stdin 传递详细信息
tool_input_json=$(cat)

# 组合 payload
payload=$(jq -n \
  --arg event "$event" \
  --arg session "$session" \
  --arg tool "$tool" \
  --arg cwd "$cwd" \
  --argjson input "$tool_input_json" \
  '{
    event: $event,
    session_id: $session,
    tool_name: $tool,
    cwd: $cwd,
    tool_input: $input
  }')

curl -sf -X POST 'http://localhost:7892/api/hooks/qoder' \
  -H 'Content-Type: application/json' \
  -d "$payload"
```

#### 阻塞机制

Qoder 的 `PreToolUse` 和 `UserPromptSubmit` 支持阻塞：

- 脚本 exit code 含义：
  - `0`: 继续执行
  - `2`: 阻塞操作（需配合 matcher）
- 阻塞时 Qoder 会等待脚本完成或超时

---

### 5.5 OpenClaw Skill Hook 系统

#### 架构

OpenClaw 采用 **Skill** 作为扩展单元，每个 Skill 可导出 Hook 函数：

```typescript
// skills/agentlog-auto/src/index.ts
export const skill = {
  name: 'agentlog-auto',
  version: '1.0.0',
  hooks: {
    'session:start': onSessionStart,
    'tool:before_call': beforeToolCall,
    'tool:after_call': afterToolCall,
    'agent:end': onAgentEnd,
    'session:end': onSessionEnd,
  },
};
```

#### 生命周期 Hook 与 MCP 的交互

```
OpenClaw Agent Loop
    ↓
session:start
    ↓ 创建 SessionState，初始化 MCP session
    ↓
tool:before_call
    ↓ 记录工具开始时间
    ↓
[工具实际执行]
    ↓
tool:after_call
    ↓ 调用 MCP log_turn(role="tool")
    ↓
agent:end
    ↓ 调用 MCP log_intent()
    ↓
session:end
    ↓ 清理 SessionState
```

#### 会话状态管理

```typescript
interface SessionState {
  sessionId: string;          // MCP session_id
  startedAt: string;          // ISO timestamp
  reasoning: string[];       // 推理过程
  toolCalls: ToolCall[];      // 工具调用记录
  responses: Response[];      // 回复记录
  model: string;
  agentSource: string;
  workspacePath: string;
}

// 内存中维护当前 session
let currentSession: SessionState | null = null;

function startSession(model: string, source: string, workspacePath: string): string {
  const sessionId = `sess_${Date.now()}_${randomUUID().slice(0, 8)}`;
  currentSession = { sessionId, startedAt: new Date().toISOString(), ... };
  return sessionId;
}
```

#### MCP 调用实现

```typescript
async function mcpRequest(tool: string, args: Record<string, unknown>) {
  const response = await fetch(`${config.mcpUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: `tools/call`,
      params: { name: tool, arguments: args },
    }),
  });
  // 解析响应，提取 session_id
}
```

#### reasoning 提取

OpenClaw 支持从消息内容中提取推理过程：

```typescript
function extractReasoningFromMessages(messages: Array<{ role: string; content: string | Array<unknown> }>) {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    if (typeof msg.content === 'string') {
      // 提取 <thinking>...</thinking> 标签
      const reasoning = extractReasoningFromText(msg.content);
      if (reasoning) currentSession.reasoning.push(reasoning);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'thinking' || block.type === 'thought') {
          // 结构化 reasoning block
          currentSession.reasoning.push(block.content.slice(0, 4000));
        }
      }
    }
  }
}
```

---

### 5.6 通用 Hook 处理流程

无论来源是哪种 IDE，Hook 事件到达后端后的处理流程是统一的：

```
HTTP POST { source, event_type, session_id, ... }
    ↓
后端 Router (/api/hooks/:source)
    ↓
HookService.processHook(event)
    ↓
┌─────────────────────────────────────────┐
│  Session 管理                            │
│  - 检查 session_id 是否已存在            │
│  - 新 session → 调用 log_turn(user)    │
│  - 已有 session → 追加记录               │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│  事件路由                                │
│  - user_message → log_turn(role=user)  │
│  - tool_after   → log_turn(role=tool)  │
│  - reasoning    → log_turn(..., reasoning=...) │
│  - session_end  → log_intent()         │
└─────────────────────────────────────────┘
    ↓
MCP Server (log_turn / log_intent)
    ↓
SQLite Database
```

---

### 5.7 关键设计决策

#### 为什么使用 HTTP 而非 STDIO？

| 考虑因素 | HTTP | STDIO |
|---------|------|-------|
| 跨进程通信 | ✅ 天然支持 | ❌ 需要父子进程 |
| 超时处理 | ✅ 简单 | ❌ 复杂 |
| 错误隔离 | ✅ 完全隔离 | ❌ 可能影响 IDE |
| 调试便利性 | ✅ 可用 curl 测试 | ❌ 需要 IDE 环境 |

#### 为什么静默忽略错误？

Hook 脚本的错误不应该影响 IDE 的正常工作：

```bash
# ✅ 正确：静默忽略
curl -sf -X POST ... 2>/dev/null || true
exit 0

# ❌ 错误：可能阻塞 IDE
curl -X POST ... || exit 1
```

#### session_id 如何跨事件传递？

| IDE | session_id 来源 | 传递方式 |
|-----|---------------|---------|
| OpenCode | Plugin 内存变量 | `currentSessionId` |
| Cursor | Hook payload | JSON 中的 `session_id` |
| Cline/Claude Code | Hook payload + transcript | JSON + 文件读取 |
| Qoder | 环境变量 + Hook payload | `SESSION_ID` 环境变量 |
| OpenClaw | Skill 内存变量 | `currentSession.sessionId` |

---

## 6. 后端扩展需求

### 6.1 新增 Hook 接收路由

| 路由 | 来源 | 事件 |
|------|------|------|
| `POST /api/hooks/cursor` | Cursor hooks | sessionStart, sessionEnd, postToolUse, ... |
| `POST /api/hooks/qoder` | Qoder hooks | SessionStart, UserPromptSubmit, PostToolUse, Stop |
| `POST /api/hooks/claude-code/:event` | Claude Code/Cline | Stop (已有，可扩展) |

### 6.2 统一 Hook 处理流程

```
Hook Script (bash)
    ↓ HTTP POST + JSON
Backend Router
    ↓
HookService
    ↓
┌─ session_start → log_turn(role="user") [首次调用建立 session]
├─ tool_after    → log_turn(role="tool")
├─ reasoning     → log_turn(role="assistant", reasoning=...)
└─ session_end   → log_intent()
```

### 6.3 数据流设计

```
IDE Hook Event
    ↓
Hook Script (读取环境变量/JSON)
    ↓
HTTP POST { session_id, event_type, tool_name, tool_input, tool_output, ... }
    ↓
Backend /api/hooks/:source
    ↓
HookService.processHook()
    ├─ 首次事件 → mcp.log_turn(role="user") 建立 session
    ├─ tool 事件 → mcp.log_turn(role="tool")
    ├─ reasoning 事件 → mcp.log_turn(role="assistant", reasoning=...)
    └─ end 事件 → mcp.log_intent()
```

---

## 7. MCP Server 增强

### 7.1 新增 Hook 工具（可选）

为支持不想改 IDE 配置的用户，提供一个 `log_hook_event` 工具：

```
log_hook_event(event_type, session_id, tool_name, tool_input, tool_output, reasoning, ...)
```

IDE hook script 直接调用此工具，无需理解 session 管理逻辑。

### 7.2 Session 管理增强

```typescript
interface HookSessionState {
  sessionId: string;
  hookSessionId: string;      // IDE 提供的 session ID
  turnCount: number;
  lastActivity: number;
  pendingTurns: HookEvent[];  // 缓冲未发送的事件
}
```

---

## 8. 实现优先级

| 优先级 | IDE | 工作内容 | 估计工作量 |
|-------|-----|---------|----------|
| P0 | **OpenCode** | 完成 `agentlog-auto` Plugin 实现并测试 | 4h |
| P0 | **OpenClaw** | 完善 `skills/agentlog-auto` 实现 | 2h |
| P1 | **Cursor** | 开发 hook script + 后端 `/api/hooks/cursor` 路由 | 4h |
| P1 | **Qoder** | 开发 hook script + 后端 `/api/hooks/qoder` 路由 | 4h |
| P2 | **Cline** | 扩展现有 hook 系统支持 PostToolUse | 2h |
| P2 | **Claude Desktop** | 复用 Cline 的 hook 实现 | 1h |
| P3 | **Trae** | VS Code Extension 方式（有限覆盖） | 4h |

---

## 9. 文件清单

### 7.1 需要新建

```
packages/backend/src/routes/hooks/
 ├── cursorHooks.ts      # Cursor hook 接收路由
 ├── qoderHooks.ts       # Qoder hook 接收路由
 └── hookService.ts      # 统一 hook 处理逻辑

~/.cursor/hooks/
 └── agentlog-hook.sh    # Cursor hook 脚本

~/.qoder/hooks/
 └── agentlog-hook.sh    # Qoder hook 脚本

~/.config/opencode/plugins/agentlog-auto/
 └── index.js            # OpenCode Plugin (已有雏形)
```

### 7.2 需要修改

```
packages/backend/src/mcp.ts           # 可选：新增 log_hook_event 工具
packages/backend/src/routes/hooks.ts   # 扩展现有 hook 路由
skills/agentlog-auto/src/index.ts      # OpenClaw skill 完善
```

---

## 10. 风险与限制

| 风险 | 说明 | 缓解措施 |
|------|------|---------|
| Hook 超时 | IDE hook 有 30s 超时限制 | 异步发送，不等待响应 |
| 插件加载失败 | OpenCode plugin 加载失败无声 | 添加诊断命令 |
| Session 映射 | IDE session ID 与 MCP session ID 可能不同 | 维护映射表 |
| 网络不可达 | localhost:7892 不可达 | Hook script 中静默忽略错误 |
| Trae 限制 | 无法拦截 Trae 内部 AI 事件 | 聚焦 Git Hook 兜底方案 |

---

## 11. 验证方案

### 9.1 单元测试

- `HookService` 处理各 IDE 事件 payload 的正确性
- Session 状态机转换
- Token 用量估算

### 9.2 集成测试

| IDE | 测试场景 | 验证点 |
|-----|---------|--------|
| OpenCode | 启动新 session，执行 edit/bash，关闭 session | DB 中有完整 transcript |
| Cursor | Cmd+K agent 模式操作 | Hook 事件正确发送 |
| Qoder | Qoder AI 操作 | Hook 事件正确发送 |
| OpenClaw | OpenClaw skill 加载 | 自动日志正常 |

### 9.3 人工验证清单

- [ ] OpenCode: `opencode` 启动，执行操作，检查 `~/.agentlog/agentlog.db`
- [ ] Cursor: 启用 hooks.json，执行操作，检查 DB
- [ ] Qoder: 配置 hooks，执行操作，检查 DB
- [ ] OpenClaw: 加载 skill，执行操作，检查 DB

---

**文档版本**: v1.0
**创建时间**: 2026-04-04
**状态**: 待实现
