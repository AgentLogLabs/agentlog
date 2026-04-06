# Stage 1 补全方案 - Handoff & Stitching（已确认）

> **确认时间**: 2026-04-05
> **确认人**: 陈洪博（Strategist） & Architect
> **场景**: 断点接管与人机混合接力赛

---

## 核心方案：`.git/agentlog/sessions.json`

### 文件结构

```json
{
  "pending": {
    "A-999": {
      "createdAt": "2026-04-05T09:50:00Z",
      "targetAgent": "opencode"
    },
    "B-888": {
      "createdAt": "2026-04-05T10:00:00Z",
      "targetAgent": "cursor"
    }
  },
  "active": {
    "session-uuid-1": {
      "traceId": "A-999",
      "agentType": "opencode",
      "status": "active",
      "startedAt": "2026-04-05T10:00:00Z",
      "worktree": "/path/to/main"
    }
  }
}
```

### 存储位置

```
.git/agentlog/sessions.json
```

---

## 完整流程

```
【Step 1: Builder Agent 出错】
OpenClaw Builder Agent 运行中遇到错误
    → 创建 Error Span（包含 memorySnapshot + diff + reasoningChain）
    → Trace A-999 状态: pending（A-999 在 pending 中等待）
    ↓

【Step 2: VS Code 认领 Trace】
人类在 VS Code AgentLog 面板
    → 右键 Trace A-999
    → 选择 "Resume with..." → 🤖 OpenCode
    → .git/agentlog/sessions.json 写入:
      {
        "pending": {
          "A-999": {
            "targetAgent": "opencode",
            "createdAt": "..."
          }
        }
      }
    ↓

【Step 3: OpenCode 启动并认领】
OpenCode 新 Session 启动
    → 读取 .git/agentlog/sessions.json
    → 发现 pending[A-999].targetAgent === "opencode"
    → 认领该 Trace，加入 A-999
    → sessions.json 更新:
      {
        "pending": { "A-999": null },  // 删除 pending
        "active": {
          "session-uuid": {
            "traceId": "A-999",
            "agentType": "opencode",
            "status": "active"
          }
        }
      }
    ↓

【Step 4: OpenCode 继续工作】
OpenCode Session 正常调用 log_turn
    → Span 归属到 Trace A-999
    ↓

【Step 5: git commit 触发清理】
OpenCode 执行 git commit（或人类手工 commit）
    → Git Hook post-commit 触发
    → 读取 sessions.json，找到 active session
    → 调用 log_intent 完成 Trace A-999
    → 清理 sessions.json 中该 session 的 active 记录
    → 创建 Human Override Span，关联到 A-999
```

---

## 关键设计决策

### 决策 1：单一 Trace 模式
**选择**: 一个 Session 同时只 active 一个 Trace

**原因**: 简化实现，避免多 Trace 绑定复杂性

**限制**: 如果 Session 要切换 Trace，需要先 commit 完成当前 Trace

**未来（Stage 2）**: 可扩展为基于文件变更的 Trace 关联

### 决策 2：多 Agent 类型支持
**选择**: VS Code 可选择目标 Agent 类型

**原因**: 支持 OpenCode、Cursor、Claude Code 等多种 Agent

**扩展性**: 新增 Agent 类型只需在 `targetAgent` 字段指定

### 决策 3：纯人类 commit 也要记录
**选择**: 所有 git commit 都记录，包括无 AI 上下文的纯人类 commit

**原因**: 产品定位是审计功能，需要完整记录谁在什么时候改了什么

**实现**: 
- 有 AI 上下文: 关联到对应 Trace
- 无 AI 上下文: 创建 `human-direct` Trace，供审计用

---

## 异常情况处理

### 异常 1: 人类直接 commit（无 AI 上下文）
```
人类直接在 VS Code 编辑并 commit
    → Git Hook 触发
    → 读取 sessions.json，无 active session
    → 创建新 Trace（traceId = human-direct-xxx）
    → 创建 human-direct Span
    → 无需清理 sessions.json
```

### 异常 2: Session 超时未 commit
```
Session active 但超过 24h 无活动
    → 定时任务检测
    → 自动清理 sessions.json
    → Trace 保持 running（等待下次认领或人工处理）
```

### 异常 3: 多 Session 并发
```
多个 OpenCode Session 同时启动
    → sessions.json 使用文件锁保证原子写入
    → 先到先得，只有一个 Session 能认领成功
    → 其他 Session 读取时发现 pending 已清空，需要人类重新认领
```

---

## 技术实现清单

### Ticket S1-E1: Error Span 捕获机制
- OpenClaw Hook 捕获 error 事件
- 创建 actorType=error 的 Span
- 包含 errorType、stackTrace

### Ticket S1-E2: Memory Snapshot + Diff 打包
- Error Span 包含 memorySnapshot（workspacePath、当前文件）
- Error Span 包含 git diff 信息
- Error Span 包含 reasoningChain

### Ticket S1-E3: VS Code Resume 功能
- 右键菜单选择目标 Agent
- 写入 sessions.json 的 pending 字段
- Copy Context 按钮（复制到剪贴板）

### Ticket S1-E4: sessions.json 管理
- 文件存储位置: `.git/agentlog/sessions.json`
- 原子写入（文件锁）
- OpenCode 启动时读取并认领

### Ticket S1-E5: Git Hook 增强
- 读取 sessions.json 的 active session
- 触发 log_intent 完成 Trace
- 清理 sessions.json
- 创建 Human Override Span

### Ticket S1-E6: 纯人类 commit 记录
- Git Hook 检测无 active session 的情况
- 创建 human-direct Trace
- 记录 commit 信息供审计

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
```

---

## 验收标准

1. ✅ Builder Agent 出错时自动创建 Error Span
2. ✅ VS Code 可右键认领 Trace 并选择目标 Agent 类型
3. ✅ OpenCode 启动时自动读取并认领 pending Trace
4. ✅ git commit 时完成 Trace 并清理 sessions.json
5. ✅ 纯人类 commit 也被记录（human-direct Trace）
6. ✅ 多 Agent 类型支持（opencode, cursor, claude-code 等）
