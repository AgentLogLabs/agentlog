# Stage 1 测试用例文档

> 更新时间：2026-04-05
> 文档链接：https://qcnqlyujx21n.feishu.cn/wiki/AQeJwcsJpipvvukWPPacq10pn5d

## 测试用例总览

总计：**20 个测试用例**

| 分类 | 数量 | 说明 |
|------|------|------|
| 一、基础功能测试 | 10个 | OpenCode 配置、Trace 生成、VS Code 视图、Git Hook、SSE 实时刷新等 |
| 二、Human Override 场景测试 | 5个 | 人类接管、OpenCode 传递 Context 等场景 |
| 三、Trace 接力场景测试 | 5个 | sessions.json 管理、VS Code→OpenCode 接力、Error Span 处理等 |

---

## 一、基础功能测试（10个用例）

### TC-001：OpenCode 配置 AgentLog MCP
- **目的**：验证 OpenCode 能正确配置 AgentLog MCP
- **优先级**：P0
- **预计时间**：5 min

### TC-002：OpenCode Agent 交互生成 Trace
- **目的**：验证 OpenCode Agent 交互时能正确生成 Trace
- **优先级**：P0
- **预计时间**：10 min

### TC-003：OpenClaw Agent 接收 Trace
- **目的**：验证 OpenClaw Agent 能接收并处理 Trace
- **优先级**：P0
- **预计时间**：10 min

### TC-004：VS Code Trace 树状视图
- **目的**：验证 VS Code 插件能正确显示 Trace 树状视图
- **优先级**：P0
- **预计时间**：10 min

### TC-005：Git Hook 拦截人类提交
- **目的**：验证 Git Hook 能正确拦截人类提交并记录
- **优先级**：P0
- **预计时间**：10 min

### TC-006：SSE 实时刷新
- **目的**：验证 SSE 能实时推送 Trace 更新
- **优先级**：P1
- **预计时间**：10 min

### TC-007：Trace Summary/Diff API
- **目的**：验证后端 API 正确返回 Trace Summary 和 Diff
- **优先级**：P0
- **预计时间**：10 min

### TC-008：OpenCode Plugin 自动 Hook 安装验证
- **目的**：验证 OpenCode Plugin 能自动安装 Git Hook
- **优先级**：P0
- **预计时间**：5 min

### TC-009：OpenCode Plugin Hook 事件触发验证
- **目的**：验证 OpenCode 执行命令时能触发 Hook 事件
- **优先级**：P0
- **预计时间**：10 min

### TC-010：OpenCode Plugin Context 传递验证
- **目的**：验证 OpenCode 能传递 Context 给 Agent
- **优先级**：P0
- **预计时间**：10 min

---

## 二、Human Override 场景测试（5个用例）

### TC-011：人类选择 OpenCode 继续修改
- **目的**：验证人类能在 VS Code 中选择 Trace 并分配给 OpenCode
- **优先级**：P0
- **预计时间**：10 min

### TC-012：OpenCode 传递 Context 给 Agent
- **目的**：验证 OpenCode 能传递 Context 给 AgentSwarm Agent
- **优先级**：P0
- **预计时间**：10 min

### TC-013：人类完成修改触发 Git Hook
- **目的**：验证人类完成修改后，Git Hook 能正确记录
- **优先级**：P0
- **预计时间**：10 min

### TC-014：Trace 状态更新
- **目的**：验证 Trace 状态能正确更新为 completed
- **优先级**：P0
- **预计时间**：5 min

### TC-015：Session 清理
- **目的**：验证 Session 能正确清理
- **优先级**：P0
- **预计时间**：5 min

---

## 三、Trace 接力场景测试（5个用例）

> 新增时间：2026-04-05
> 根据 Stage 1 设计文档新增

### TC-TR-001：sessions.json 创建与管理
- **目的**：验证 Git Hook 能正确创建和管理 `.git/agentlog/sessions.json` 文件
- **优先级**：P0
- **预计时间**：5 min

**测试步骤**：
1. 在 Git 仓库中触发任意 Git Hook
2. 验证 `.git/agentlog/sessions.json` 文件被创建
3. 验证文件格式正确，包含 `pending` 和 `active` 字段

**预期结果**：
- `.git/agentlog/sessions.json` 文件存在
- JSON 格式正确，包含必要的字段

---

### TC-TR-002：VS Code Trace 列表选择并分配给 OpenCode
- **目的**：验证人类能在 VS Code 中选择 Trace 并分配给 OpenCode 处理
- **优先级**：P0
- **预计时间**：10 min

**测试步骤**：
1. 在 VS Code 中打开 AgentLog 插件
2. 查看 Trace 列表，找到待接力的 Trace
3. 右键点击 Trace，选择 "继续修改 (OpenCode)"
4. 验证 sessions.json 中该 Trace 被添加到 pending

**预期结果**：
- Trace 列表正确显示
- 右键菜单包含 OpenCode/Cursor/Claude Code 选项
- sessions.json 中 pending 字段包含该 Trace ID

---

### TC-TR-003：OpenCode Agent 启动时读取 sessions.json
- **目的**：验证 OpenCode Agent 启动时能读取 pending 中的 Trace 并认领
- **优先级**：P0
- **预计时间**：10 min

**测试步骤**：
1. 在 sessions.json 的 pending 中添加一个 Trace
2. 启动 OpenCode Agent
3. 验证 OpenCode 能读取并认领该 Trace
4. 验证 sessions.json 中该 Trace 从 pending 移动到 active

**预期结果**：
- OpenCode 启动时检测 pending 中的 Trace
- Trace 从 pending 移动到 active
- active 中包含 traceId、agentType、status、startedAt 等字段

---

### TC-TR-004：OpenCode Agent 完成任务并触发 Git Hook 清理
- **目的**：验证 OpenCode Agent 完成工作后，Git Hook 能正确清理 sessions.json 中的记录并绑定 Commit
- **优先级**：P0
- **预计时间**：10 min

**测试步骤**：
1. OpenCode Agent 认领 Trace A-999 并完成工作
2. 执行 git commit
3. 验证 Git Hook 触发
4. 验证 sessions.json 中该 Trace 被清理
5. 验证 Commit 与 Trace 绑定

**预期结果**：
- Git Hook post-commit 触发
- sessions.json 中 active 的该 Trace 被移除
- Trace 状态更新为 completed
- Commit Hash 绑定到 Trace

---

### TC-TR-005：Builder Agent 失败时 Error Span 处理
- **目的**：验证 Builder Agent 遇到错误时，Hawk 能正确识别并生成 Error Span，状态标记为 interrupted
- **优先级**：P0
- **预计时间**：10 min

**测试步骤**：
1. 启动 Builder Agent 执行任务
2. 模拟 Agent 遇到错误（死锁、超时等）
3. 验证 Hawk 捕获错误
4. 验证生成 Error Span 包含：
   - `actorType: "error"`
   - `payload.errorType`
   - `payload.stackTrace`
   - `payload.memorySnapshot`
   - `payload.diff`
   - `payload.reasoningChain`
5. 验证 Trace 状态标记为 `pending_handoff` 或 `interrupted`

**预期结果**：
- Error Span 正确生成
- 包含完整的错误信息
- Trace 状态正确标记

---

## sessions.json 完整格式

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

### 字段说明

| 字段 | 说明 |
|------|------|
| pending | 待认领的 Trace，key 为 TraceId |
| pending[].targetAgent | 目标 Agent 类型 (opencode/cursor/claude-code 等) |
| pending[].createdAt | 创建时间 |
| active | 当前活跃的 Session，key 为 SessionUuid |
| active[].traceId | 该 Session 正在处理的 Trace |
| active[].agentType | Agent 类型 |
| active[].status | 状态 (always active) |
| active[].worktree | Git worktree 路径 |

---

## Error Span 完整格式

```json
{
  "actorType": "error",
  "payload": {
    "errorType": "DeadlockError",
    "stackTrace": "...",
    "memorySnapshot": {
      "workspacePath": "/path/to/project",
      "currentFiles": ["file1.ts", "file2.ts"]
    },
    "diff": {
      "changedFiles": 15,
      "details": [...]
    },
    "reasoningChain": "..."
  }
}
```

### Error Span 字段说明

| 字段 | 说明 |
|------|------|
| actorType | 标识这是一个错误 Span，值为 "error" |
| payload.errorType | 错误类型（如 DeadlockError） |
| payload.stackTrace | 堆栈信息 |
| payload.memorySnapshot | 内存快照（workspacePath、当前文件） |
| payload.diff | 变更文件列表及统计 |
| payload.reasoningChain | 连续推理过程 |

---

## Trace 状态机

```json
{
  "running": "进行中",
  "pending_handoff": "等待交接 (Agent 出错或等待认领)",
  "in_progress": "进行中 (人类选择继续修改)",
  "completed": "已完成"
}
```

---

## 设计决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| Trace 管理 | .git/agentlog/sessions.json | 利用 Git 工作树特性，支持多 worktree |
| Session 模式 | 单一 Trace | 简化实现 |
| 多 Agent 支持 | targetAgent 字段 | 良好扩展性 |
| 纯人类 commit | 记录 (human-direct) | 审计功能需要 |
| 任务完成判断 | 人类决定 | commit 后由人类选择 |
| Agent 获取 Trace | 直接 ID + 语义查询 | 灵活适应不同场景 |

---

## 文档信息

- 创建时间：2026-04-05
- 目标：让 AgentLog 成为 Agent 编程时代的基础工具
