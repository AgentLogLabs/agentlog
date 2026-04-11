# AgentLog 技术方案讨论 - 2026-04-10

**作者**: Architect  
**日期**: 2026-04-10  
**参与**: CEO（陈洪博）、Strategist、Architect  

---

## 一、战略定位确认

**CEO 确认**：AgentLog 定位为**效率工具**，不是审计工具。核心差异化：**"让 AI 编程记忆永不丢失"**

### 效率工具 vs 审计工具

| 维度 | 审计工具思维 | 效率工具思维 |
|------|------------|------------|
| **Git Binding** | 记录谁提交了什么 | **快速找到这段代码的上下文，省去回忆时间** |
| **Context Resume** | 存档备查 | **无缝续接，省去重复描述上下文的时间** |
| **Trace** | 完整记录日志 | **让 AI 记住之前做了什么，用户不用重复 prompt** |

---

## 二、P0 功能技术方案

### 2.1 Git Commit Binding（代码溯源）

**用户故事**：开发者看到一段代码，不确定是 AI 写的还是自己写的，想追溯来源。

**用户使用流程**：
1. AI 开始工作 → 自动写入 `git config agentlog.traceId=<trace_id>`（无感知）
2. 开发者 `git commit` → post-commit hook 自动关联
3. 开发者想要溯源 → 在 AgentLog Dashboard 输入 commit hash 或使用 VS Code 命令

**技术实现**：
- OpenClaw AgentLog Skill 端：onAgentStart 时执行 `git config agentlog.traceId <trace_id>`
- Git post-commit hook：读取 git config 中的 traceId，回调 Backend 绑定
- Backend：traces 表已有 commitHash 字段

**Resource Estimate**：3-5 人天

### 2.2 Context Resume（记忆续接）

**用户故事**：开发者关闭了 VS Code，第二天回来想继续昨天未完成的 AI 编程任务。

**用户使用流程**：
1. AI 完成工作 → Backend 自动保存 context summary（Task 完成后自动生成）
2. 用户回来 → 输入 `/resume`
3. 显示最近任务列表（带摘要）
4. 用户确认后，AI 加载上下文继续工作

**技术实现**：
- Context Summary 生成：task 标记 completed 时自动生成，包含 task_goal、files、conclusion、duration、model
- Resume 流程：用户 /resume → 显示列表 → 用户选择 → 加载 context + spans

**Resource Estimate**：3-5 人天（基础版），7-10 人天（增强版）

### 2.3 Context Resume 与 Handoff 的关系

**不是重复，是互补**：

| 维度 | Handoff（交接） | Context Resume（记忆续接） |
|------|----------------|--------------------------|
| **场景** | 实时交接（人与人、AI与AI） | 跨时间续接（今天→明天） |
| **触发** | 显式命令 /handoff | 输入 /resume 或重新打开 session |
| **目的** | 把任务转交给另一个 Agent/用户 | 让 AI "记住"之前的上下文 |
| **数据传递** | 通过 trace_id 继承上下文 | 从 Backend 加载历史 context |
| **时间跨度** | 实时（秒/分钟级） | 长期（天/周级） |

---

## 三、CEO 确认的设计决策

| # | 问题 | 决策 |
|---|------|------|
| 1 | Context Summary 生成时机 | **A - Task 完成后自动生成** |
| 2 | Resume 时是否需要用户确认 | **B - 显示摘要，用户确认后恢复** |
| 3 | Git Binding 触发时机 | **A - AI 开始工作时自动写入 git config** |

---

## 四、TICKET 下发

已下发两个 Ticket 给 Builder：

### TICKET-2026-0410-01: Git Commit Binding 闭环
- AI 开始时自动写入 git config
- commit 时 hook 自动关联 trace
- 可通过 commit hash 查询 AI session

### TICKET-2026-0410-02: Context Resume 基础版
- Task 完成时自动生成 context summary
- 用户 /resume 时显示列表，用户确认后恢复

---

## 五、待确认的技术问题

1. **VSCode Extension 与 Backend 连接问题**：当前配置为 localhost:7892，需修改为树莓派 IP
2. **OpenClaw Skill vs Plugin**：AgentLog 最终形态确认（当前是 Skill）
3. **Context Resume 存储策略**：Session 结束后 context summary 存在 Backend

---

## 六、与 Entire 的差异化竞争

| 维度 | Entire | AgentLog |
|------|--------|----------|
| **定位** | CLI + Slack 自动化 | OpenClaw Skill + 编程记忆 |
| **核心场景** | 团队协作日志 | **个人/团队效率工具** |
| **差异化** | 集成 Vercel 工作流 | OpenClaw 原生集成 + Context Resume |
| **技术优势** | 已有 500+ Stars | Trace 链路完整 + Skill 生态 |

---

## 七、短期技术目标

```
Phase 1（1-2周）：
- 完成 Git Commit Binding 闭环
- Context Resume 基础版

Phase 2（3-4周）：
- Context Resume 自动版
- OpenClaw AgentLog Skill 发布到 clawhub

Phase 3（持续迭代）：
- Trace Handoff 增强
- Solo 方冷启动优化
```

---

## 八、下一步

1. Builder 接收并执行 TICKET-2026-0410-01 和 TICKET-2026-0410-02
2. Auditor 进行 E2E 测试
3. 验证 Git Commit Binding 和 Context Resume 功能
4. 评估是否需要调整战略方向
