# Stage 1 - 断点接管与人机混合接力赛 (Handoff & Stitching)

## 场景目标

解决痛点：AI Agent 报错卡死，人类接手时"一脸懵逼"，只能去翻长达几千行的聊天记录，且修复后 Git Commit 割裂。

场景标签：单物理节点、人机混合协作、上下文缝合

---

## 完整流程详解

### 第一阶段：AgentSwarm Agent 出错 → Trace Ticket 生成

**参与者**：AgentSwarm Agent（Builder）

**流程**：
1. Builder Agent 启动，负责重构支付网关
2. Agent 运行中遇到 Stripe 死锁报错，尝试 3 次修复失败后抛出异常（Panic）
3. OpenClaw Hook 捕获 error 事件
4. AgentLog 自动生成 Error Span（包含：
   - errorType：错误类型
   - stackTrace：堆栈信息
   - memorySnapshot：workspacePath、当前文件
   - diff：变更文件列表
   - reasoningChain：连续推理过程）
5. 该 Error Span 归属到 Trace A-999（A-999 状态变为 `pending_handoff`）

**技术实现**：
- OpenClaw Hook 捕获 `error` 事件（需扩展，当前只有 bootstrap/start/end）
- AgentLog 探针订阅并创建 Error Span
- Span payload 包含完整错误上下文

**当前实现状态**：❌ error 事件捕获未实现

---

### 第二阶段：VS Code 认领 Trace

**参与者**：人类

**流程**：
1. 人类收到通知，打开 VS Code AgentLog 面板
2. 在 Trace 树状视图中找到 Trace A-999
3. 右键选择 "Resume with..." → 选择目标 Agent 类型（OpenCode / Cursor / Claude Code 等）
4. 系统将 Trace A-999 写入 `.git/agentlog/sessions.json` 的 `pending` 字段

**sessions.json 结构**：
```json
{
  "pending": {
    "A-999": {
      "createdAt": "2026-04-05T09:50:00Z",
      "targetAgent": "opencode"
    }
  },
  "active": {}
}
```

**VS Code 菜单设计**：
```
右键 Trace A-999 → Resume with...
├── 🤖 OpenCode
├── 🎯 Cursor
├── 🧠 Claude Code
└── 📋 Other Agent...
```

---

### 第三阶段：OpenCode 接管并继续工作

**参与者**：OpenCode Agent

**流程**：
1. OpenCode 新 Session 启动
2. MCP Client 读取 `.git/agentlog/sessions.json`
3. 发现 `pending[A-999].targetAgent === "opencode"`
4. 认领该 Trace，加入 A-999
5. sessions.json 更新：
   ```json
   {
     "pending": { "A-999": null },
     "active": {
       "session-uuid-1": {
         "traceId": "A-999",
         "agentType": "opencode",
         "status": "active",
         "startedAt": "2026-04-05T10:00:00Z"
       }
     }
   }
   ```
6. OpenCode 可通过两种方式获取上下文：
   - 读取该 Trace 的历史 Span，构建上下文提示词
   - 用户在 VS Code 点击 "Copy Context" 复制到剪贴板，手动粘贴到 OpenCode

**文件存储位置**：`.git/agentlog/sessions.json`

**原子性保证**：多 Session 并发时使用文件锁保证原子写入

---

### 第四阶段：OpenCode 完成并 git commit

**参与者**：OpenCode Agent / 人类

**Git Hook 统一处理**（两种 commit 方式都会触发）：
- OpenCode Agent 调用 git commit
- 人类手工 git commit

**流程**：
1. git commit 执行
2. Git Hook post-commit 触发
3. Git Hook 读取 sessions.json，找到 active session（A-999）
4. 调用 `log_intent` 完成 Trace A-999
5. 创建 Human Override Span，关联到 A-999
6. sessions.json 清理该 session 的 active 记录
7. **VS Code 弹出菜单**：
   ```
   ┌─────────────────────────────────────┐
   │ Trace A-999 已完成 commit           │
   │                                     │
   │ 任务完成了吗？                       │
   │                                     │
   │ [✅ 完成]  [🔄 继续修改]            │
   └─────────────────────────────────────┘
   ```

**两种选择**：
- **点击"完成"**：Trace A-999 保持 completed 状态
- **点击"继续修改"**：Trace A-999 状态改为 in_progress，Trace ID 复制到剪贴板

---

### 第五阶段：AgentSwarm Agent 继续工作

**参与者**：AgentSwarm Agent（通过飞书等通道）

**获取 Trace ID 的方式**：

| 方式 | 描述 |
|------|------|
| **直接提供** | 人类粘贴 Trace ID（如 "请继续 Trace 01KXXX"） |
| **语义查询** | 人类描述任务（如 "继续之前的 Stripe 修复"），Agent 调用 query_historical_interaction 定位 |

**Agent 工作流程**：
1. 接收消息，提取 Trace ID 或描述
2. 将 Trace ID 写入 `.git/config`：`git config agentlog.traceId "01KXXX"`
3. 调用 MCP log_turn，传入 traceId="01KXXX"
4. 工作进行中，Span 归属到 Trace 01KXXX
5. Git commit 时，Git Hook 读取 `git config agentlog.traceId`
6. 绑定 commit 到 Trace 01KXXX

---

## 异常情况处理

### 异常 1：人类直接 commit（无 AI 上下文）

**场景**：人类直接在 VS Code 编辑并 commit，无 AI 介入

**处理**：
1. Git Hook 触发
2. 读取 sessions.json，无 active session
3. 创建新 Trace（`traceId = human-direct-xxx`）
4. 创建 `human-direct` Span
5. 无需清理 sessions.json

**目的**：产品定位是审计功能，需要完整记录谁在什么时候改了什么

---

### 异常 2：Session 超时未 commit

**场景**：Session active 但超过 24h 无活动

**处理**：
1. 定时任务检测 sessions.json 中的超时 active session
2. 自动清理 sessions.json
3. Trace 保持 in_progress（等待下次认领或人工处理）

---

### 异常 3：多 Session 并发

**场景**：多个 OpenCode Session 同时启动

**处理**：
1. sessions.json 使用文件锁保证原子写入
2. 先到先得，只有一个 Session 能认领成功
3. 其他 Session 读取时发现 pending 已清空，需人类重新认领

---

## 技术实现清单

### S1-E1: Error Span 捕获机制
- OpenClaw Hook 捕获 error 事件（需扩展，当前只有 bootstrap/start/end）
- 创建 actorType=error 的 Span
- 包含 errorType、stackTrace、memorySnapshot、diff、reasoningChain
- **状态**：❌ 未实现

### S1-E2: Memory Snapshot + Diff 打包
- Error Span 包含 memorySnapshot（workspacePath、当前文件）
- Error Span 包含 git diff 信息
- Error Span 包含 reasoningChain
- **状态**：❌ 未实现

### S1-E3: VS Code Resume 功能
- 右键菜单选择目标 Agent 类型
- 写入 sessions.json 的 pending 字段
- Copy Context 按钮（复制到剪贴板）
- commit 后弹出"完成/继续修改"菜单
- **状态**：❌ 未实现

### S1-E4: sessions.json 管理
- 文件存储位置：`.git/agentlog/sessions.json`
- 原子写入（文件锁）
- OpenCode 启动时读取并认领
- **状态**：❌ 未实现

### S1-E5: Git Hook 增强
- 读取 sessions.json 的 active session
- 读取 `.git/config agentlog.traceId`
- 触发 log_intent 完成 Trace
- 清理 sessions.json
- 创建 Human Override Span
- **状态**：⚠️ 部分实现（现有 Git Hook 只创建 human span，未读取 sessions.json）

### S1-E6: 纯人类 commit 记录
- Git Hook 检测无 active session 的情况
- 创建 human-direct Trace
- 记录 commit 信息供审计
- **状态**：⚠️ 部分实现

### S1-E7: AgentSwarm Agent Trace 续接
- 支持直接提供 Trace ID
- 支持语义查询定位 Trace
- 支持写入 `.git/config` 供 Git Hook 读取
- **状态**：⚠️ 部分实现（query_historical_interaction 已实现，但未接入 Git Hook 读取）

---

## 设计决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| Trace 管理 | `.git/agentlog/sessions.json` | 利用 Git 工作树特性，自然支持多 worktree |
| Session 模式 | 单一 Trace | 简化实现，一 Session 同时只 active 一个 Trace |
| 多 Agent 支持 | targetAgent 字段 | 支持 OpenCode、Cursor、Claude Code 等 |
| 纯人类 commit | 记录（human-direct） | 产品定位是审计功能，需完整记录 |
| 任务完成判断 | 人类决定 | commit 后由人类选择"完成"或"继续修改" |
| Agent 获取 Trace | 直接 ID + 语义查询 | 灵活，适应不同场景 |

---

## Trace 状态机

```
                    ┌──────────────┐
                    │   running    │
                    └──────┬───────┘
                           │
              Error / 认领 ↓
                           │
                    ┌──────▼───────┐
            ┌───────│pending_handoff│
            │       └──────┬───────┘
            │              │
   commit   │      commit  │  人类选择"继续修改"
   (完成)   │              │
            │              ↓
            │       ┌──────────────┐
            └──────▶│ in_progress  │
                    └──────┬───────┘
                           │
                          commit
                           │
                           ↓
                    ┌──────────────┐
                    │  completed   │
                    └──────────────┘
```

---

## 关键技术细节

### Git Hook 如何读取 sessions.json

```bash
# .git/hooks/post-commit
#!/bin/bash

AGENTLOG_DIR=".git/agentlog"
SESSIONS_FILE="$AGENTLOG_DIR/sessions.json"
TRACE_ID=""

# 1. 优先读取 sessions.json 中的 active session
if [ -f "$SESSIONS_FILE" ]; then
    ACTIVE_TRACE=$(jq -r ".active[] | select(.status==\"active\") | .traceId" "$SESSIONS_FILE" 2>/dev/null)
    if [ -n "$ACTIVE_TRACE" ]; then
        TRACE_ID="$ACTIVE_TRACE"
    fi
fi

# 2. 如果没有，读取 git config
if [ -z "$TRACE_ID" ]; then
    TRACE_ID=$(git config agentlog.traceId)
fi

# 3. 如果还是没有，创建 human-direct Trace
if [ -z "$TRACE_ID" ]; then
    TRACE_ID="human-direct-$(date +%s)"
fi

# 4. 调用 API 绑定 commit
curl -s -X POST "$AGENTLOG_GATEWAY/api/commit-bind" \
  -d "{\"traceId\": \"$TRACE_ID\", \"commitHash\": \"$GIT_COMMIT_HASH\"}" > /dev/null
```

### OpenCode 启动时读取 sessions.json

```typescript
// MCP Client 初始化时
async function checkAndClaimTrace() {
  const sessionsFile = path.join(process.cwd(), '.git/agentlog/sessions.json');
  
  if (!fs.existsSync(sessionsFile)) return;
  
  const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
  
  // 查找 pending 中属于当前 Agent 类型的
  const agentType = detectAgentType(); // opencode / cursor / claude-code
  
  for (const [traceId, pending] of Object.entries(sessions.pending)) {
    if (pending.targetAgent === agentType) {
      // 认领该 Trace
      delete sessions.pending[traceId];
      sessions.active[generateSessionId()] = {
        traceId,
        agentType,
        status: 'active',
        startedAt: new Date().toISOString()
      };
      
      // 原子写入
      fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2));
      
      // 设置环境变量
      process.env.AGENTLOG_TRACE_ID = traceId;
      break;
    }
  }
}
```

### AgentSwarm Agent 接收 Trace ID

```typescript
// 消息处理
async function handleMessage(message: string) {
  let traceId: string | null = null;
  
  // 方式1: 直接提取 Trace ID
  const traceIdMatch = message.match(/Trace[:\s]+([A-Z0-9]+)/i);
  if (traceIdMatch) {
    traceId = traceIdMatch[1];
  } else {
    // 方式2: 语义搜索
    const results = await query_historical_interaction({
      keyword: message,
      status: 'in_progress',
      page_size: 5,
      include_transcript: true
    });
    
    if (results.data.length > 0) {
      traceId = results.data[0].trace.id;
    }
  }
  
  if (traceId) {
    // 写入 git config
    execSync(`git config agentlog.traceId "${traceId}"`);
    // 设置环境变量
    process.env.AGENTLOG_TRACE_ID = traceId;
  }
}
```

---

## 依赖关系

```
S1-E1 (Error Span 捕获)
    ↓
S1-E2 (Snapshot + Diff)  ← 依赖 E1 的 Error Span 结构
    ↓
S1-E3 (VS Code Resume)  ← 依赖 E1, E2
    ↓
S1-E4 (sessions.json)    ← 依赖 E3 的 VS Code 端
    ↓
S1-E5 (Git Hook 增强)   ← 依赖 E4
    ↓
S1-E6 (human-direct)     ← 独立，可并行实现
    ↓
S1-E7 (Agent 续接)       ← 依赖 E5 的 Git Hook 读取 git config
```

---

*文档创建时间：2026-04-05*
*最后更新时间：2026-04-05*
*目标：让 AgentLog 成为 Agent 编程时代的基础工具*
