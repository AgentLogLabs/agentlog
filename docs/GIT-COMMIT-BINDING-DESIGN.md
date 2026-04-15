# Git Commit Binding 设计方案

> 版本：v1.0  
> 作者：Architect  
> 日期：2026-04-15  
> 状态：✅ 已确认

---

## 一、场景（Use Case）

### 场景 1：AI 开始工作时绑定
```
用户："帮我实现登录功能"
  ↓
AI 收到任务，开始工作
  ↓
OpenClaw AgentLog Hook: onBeforeAgentStart
  ↓
写入 git config agentlog.traceId=<当前trace_id>
  ↓
记录到 .git/agentlog/sessions.json
```

### 场景 2：开发者手动提交
```
开发者：git commit -m "feat: 添加登录功能"
  ↓
post-commit hook 触发
  ↓
读取 git config agentlog.traceId
  ↓
将 commit hash 与 traceId 关联写入 Backend
```

### 场景 3：AI Agent 自主提交（双重保险）
```
AI Agent 决策要提交代码
  ↓
AI 调用 git commit 工具
  ↓
beforeToolCall 拦截，修改 commit message 加入 [trace:xxx]
  ↓
post-commit hook 触发（双重保险）
  ↓
关联 commit hash 到 trace
```

### 场景 4：跨 session 续接
```
用户：/resume
  ↓
系统读取上一个 session 的 traceId
  ↓
继续在新 session 工作
  ↓
绑定到同一个 trace
```

---

## 二、现有代码分析

**当前实现问题：**

| 问题 | 位置 | 说明 |
|------|------|------|
| `tryBindCommit()` 只在 onAgentEnd 调用 | index.ts | 只能绑定已存在的 commit，无法主动写入 traceId |
| 无 post-commit hook 注册 | 缺失 | 需要用户手动配置 |
| traceId 未写入 git config | 缺失 | AI 工作中无法被 hook 读取 |
| 无 AI commit 拦截 | 缺失 | AI 自主提交时无法保证绑定 |

---

## 三、软件结构

```
openclaw-agentlog/
├── src/
│   ├── index.ts                    # 主入口（修改）
│   ├── git-hooks.ts                # Git Hook 管理（新增）
│   ├── git-config.ts               # Git config 读写（新增）
│   └── types/
│       └── index.ts                # 类型定义
├── scripts/
│   ├── install-hooks.sh            # 安装 git hooks（新增）
│   └── uninstall-hooks.sh         # 卸载 git hooks（新增）
└── README.md
```

---

## 四、详细设计

### 4.1 Git Config 模块 (`git-config.ts`)

```typescript
export async function writeTraceIdToGitConfig(traceId: string, cwd: string): Promise<void> {
  // 写入 git config agentlog.traceId
  execSync(`git config agentlog.traceId ${traceId}`, { cwd, encoding: 'utf-8' });
}

export async function readTraceIdFromGitConfig(cwd: string): Promise<string | null> {
  try {
    return execSync('git config --get agentlog.traceId', { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export async function clearTraceIdFromGitConfig(cwd: string): Promise<void> {
  try {
    execSync('git config --unset agentlog.traceId', { cwd, encoding: 'utf-8' });
  } catch {
    // ignore
  }
}
```

### 4.2 Git Hooks 模块 (`git-hooks.ts`)

```typescript
// post-commit hook 内容
const POST_COMMIT_HOOK_CONTENT = `#!/bin/bash
TRACE_ID=$(git config --get agentlog.traceId)
COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --format=%B)
if [ -n "$TRACE_ID" ]; then
  curl -s -X POST http://localhost:7892/api/traces/$TRACE_ID/commit \\
    -H "Content-Type: application/json" \\
    -d "{\\"commitHash\\": \\"$COMMIT_HASH\\", \\"commitMessage\\": \\"$COMMIT_MSG\\"}" 2>/dev/null || true
fi
`;

export async function installPostCommitHook(gitDir: string): Promise<void> {
  const hookPath = path.join(gitDir, 'hooks', 'post-commit');
  fs.writeFileSync(hookPath, POST_COMMIT_HOOK_CONTENT, 'utf-8');
  fs.chmodSync(hookPath, 0o755);
}
```

### 4.3 AI Commit 拦截 (`git-commit-interceptor.ts`)

```typescript
// 修改 git commit message 加入 traceId
export function enhanceGitCommitCommand(cmd: string, traceId: string): string {
  // 匹配 git commit -m "xxx" 或 git commit -am "xxx" 等模式
  const pattern = /(git\s+commit\s*)(-a?\s*)?(-m\s*["'])(.*)(["'])/i;
  const match = cmd.match(pattern);
  
  if (!match) return cmd;
  
  const [, prefix, aFlag, mFlag, message, quote] = match;
  
  // 如果 message 中已有 traceId，不重复添加
  if (message.includes('[trace:') || message.includes(traceId)) {
    return cmd;
  }
  
  return `${prefix}${aFlag || ''}${mFlag}${message} [trace:${traceId}]${quote}`;
}

// 从 commit message 中提取 traceId
export function extractTraceIdFromCommitMessage(message: string): string | null {
  const patterns = [
    /\[trace:([A-Z0-9]+)\]/i,
    /trace[:\s]+([A-Z0-9]{26,})/i,
  ];
  
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) return match[1];
  }
  return null;
}
```

### 4.4 修改 onBeforeAgentStart

```typescript
export async function onBeforeAgentStart(params: {...}) {
  // 创建 session 和 trace
  await startSession(...);
  
  // 新增：写入 traceId 到 git config
  if (config.autoBindCommit && currentSession) {
    await writeTraceIdToGitConfig(currentSession.traceId, currentSession.workspacePath);
  }
}
```

### 4.5 修改 beforeToolCall

```typescript
export async function beforeToolCall(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
}): Promise<void> {
  // 拦截 git commit 命令
  if (params.toolName === 'exec' || params.toolName === 'bash') {
    const cmd = params.toolInput.command as string;
    if (cmd && cmd.includes('git commit')) {
      // 修改 commit message 加入 traceId
      if (currentSession?.traceId) {
        const enhancedCmd = enhanceGitCommitCommand(cmd, currentSession.traceId);
        params.toolInput.command = enhancedCmd;
      }
    }
  }
  
  params.toolInput._agentlog_startTime = Date.now();
}
```

---

## 五、数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                     Git Commit Binding 数据流                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. AI 开始工作                                                   │
│     onBeforeAgentStart()                                         │
│          ↓                                                        │
│     writeTraceIdToGitConfig(traceId)                             │
│          ↓                                                        │
│     .git/config 写入 agentlog.traceId=<trace_id>                 │
│                                                                  │
│  2. AI 自主提交（beforeToolCall 拦截）                            │
│     git commit -m "xxx"                                          │
│          ↓                                                        │
│     enhanceGitCommitCommand() → "xxx [trace:xxx]"                 │
│          ↓                                                        │
│     实际执行 commit                                               │
│                                                                  │
│  3. post-commit hook 触发（所有 commit）                          │
│     读取 git config agentlog.traceId                             │
│     或者从 commit message 提取 traceId                            │
│          ↓                                                        │
│     POST /api/traces/{traceId}/commit { commitHash, commitMsg }   │
│                                                                  │
│  4. Backend 存储                                                  │
│     traces 表更新 hasCommit=true                                 │
│     commits 表新增记录                                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 六、Backend API 变更

| API | 方法 | 说明 |
|-----|------|------|
| `/api/traces/:id/commit` | POST | 关联 commit hash 到 trace |

**请求体：**
```json
{
  "commitHash": "abc123def456...",
  "commitMessage": "feat: 添加登录功能 [trace:01KNXE8ACM854CMY7X076QV88H]"
}
```

**traces 表新增字段：**
```typescript
interface Trace {
  // ... existing fields
  commits: Array<{
    hash: string;
    message: string;
    author: string;
    timestamp: string;
  }>;
  hasCommit: boolean;
}
```

---

## 七、配置项

```typescript
interface AgentLogConfig {
  // ... existing
  autoBindCommit: boolean;        // 默认 true
  autoInstallHooks: boolean;      // 默认 false（需要用户确认）
  hookInstallPrompt: boolean;     // 首次使用提示安装 hooks
}
```

---

## 八、Ticket 拆解

| Ticket | 任务 | 负责人 |
|--------|------|--------|
| TICKET-GCB-01 | Git Config 模块开发 (`git-config.ts`) | Builder |
| TICKET-GCB-02 | Git Hooks 安装脚本 (`git-hooks.ts`, `install-hooks.sh`) | Builder |
| TICKET-GCB-03 | Git Commit 拦截器 (`git-commit-interceptor.ts`) | Builder |
| TICKET-GCB-04 | onBeforeAgentStart 修改（写入 traceId 到 git config）| Builder |
| TICKET-GCB-05 | beforeToolCall 修改（拦截 git commit 命令）| Builder |
| TICKET-GCB-06 | Backend API `/api/traces/:id/commit` | Builder |
| TICKET-GCB-07 | E2E 测试 | Auditor |

---

## 九、依赖关系

```
TICKET-GCB-01 (git-config)
      ↓
TICKET-GCB-04 (onBeforeAgentStart 依赖 git-config)
      ↓
TICKET-GCB-03 (commit interceptor 独立)
      ↓
TICKET-GCB-05 (beforeToolCall 依赖 commit interceptor)
      ↓
TICKET-GCB-02 (hooks 安装脚本 独立)
      ↓
TICKET-GCB-06 (Backend API 独立)
      ↓
TICKET-GCB-07 (E2E 测试依赖所有)
```

---

## 十、风险与应对

| 风险 | 等级 | 应对 |
|------|------|------|
| hook 未安装 | 中 | commit message 嵌入 traceId 作为备用方案 |
| git config 写入失败 | 低 | 降级到仅 commit message 方式 |
| commit message 被修改丢失 traceId | 低 | post-commit hook 仍可从 git config 读取 |
