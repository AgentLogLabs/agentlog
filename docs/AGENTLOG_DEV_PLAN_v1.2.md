# AgentLog 产品开发计划 v1.2

**版本**: v1.2  
**日期**: 2026-04-01  
**制定者**: Architect（架构设计师）  
**战略锚定**: `STRATEGY.md v1.0`  
**审批**: CEO（陈洪博）待审批  

---

## 一、战略对齐

**核心定位**：
> AgentLog = **本地隐私 + Git as Checkpoint + Context Resume**
> 差异化：*"复活"而非"同步"*

| 时间轴 | 战略目标 | 技术支撑 |
|--------|----------|----------|
| **短期 0-3月** | 稳定性 + 体验优化 | MCP Server 稳定性、Git Hook 兜底、VS Code UI 优化、中文文档 |
| **中期 3-6月** | 杀手级功能 | Context Resume（复活历史上下文）、DeepSeek R1 推理链可视化 |
| **长期 6-12月** | 平台化 | Agent 共享记忆协议、MCP Registry |

**对抗 Entire 策略**：
- Entire = 云端同步 → AgentLog = 本地隐私 + Git 绑定
- Entire = 跨设备 → AgentLog = 跨时间回溯
- 核心信息：**"Context Resume" = 一键复活 AI 历史上下文**

---

## 二、任务优先级 v1.2

### 🔴 P0 - 立即执行（审批后 24h 内）

| Task ID | 任务 | 战略对齐 | 工时 |
|---------|------|----------|------|
| **#V1** | VS Code 插件截图更新 | 短期：UI 优化 | 1h |
| **#R1** | GitHub Release Note 中文版 | 短期：中文文档 | 2h |
| **#R2** | CHANGELOG.md 中文版 | 短期：中文文档 | 1h |

---

### 🟡 P1 - 本周执行

| Task ID | 任务 | 战略对齐 | 工时 |
|---------|------|----------|------|
| **#D1** | GitHub README 优化（中文版） | 短期：中文文档 + 差异化定位 | 3h |
| **#D2** | GitHub Discussions 启用 | 短期：社区建设 | 1h |
| **#C1** | 竞品动态监控（与 Sentinel 协作） | 战略情报支持 | 2h |
| **#D3** | VS Code Marketplace 评论管理 | 短期：用户反馈收集 | 每周1h |

---

### 🟢 P2 - 中期规划（3-6 个月）

#### Feature #M1: Context Resume（杀手级功能）

**战略价值**：
- 对抗 Entire 的核心杀手锏
- "一键复活"历史上下文，无需重新启动 AI 会话

**技术方案**：
```
用户场景：
1. 用户 3 天前在项目 X 与 DeepSeek R1 讨论了 auth 模块重构
2. 今天继续工作时，执行 "agentlog resume <session_id>"
3. AI 自动加载历史上下文，继续上次讨论

技术实现：
├── Session 持久化
│   ├── 存储：SQLite (`~/.agentlog/sessions/`)
│   └── 结构：session_id, project_path, model, messages[], commit_hash, created_at
├── Context 重建协议
│   ├── 提取：最近 N 条消息（可配置上限，如 50 条）
│   ├── 注入：System Prompt + 历史上下文
│   └── 限制：Token 预算内（预留 20% 给新内容）
├── 一键 Resume CLI
│   └── `agentlog resume <session_id>` 或 VS Code 侧边栏按钮
└── Git Commit 关联
    ├── 自动绑定：resume 的 session → 新的 commit
    └── diff 可追溯：两个 commit 之间的 AI 讨论变更
```

**子任务分解**：

| Sub Task | 内容 | 工时 |
|----------|------|------|
| M1.1 | Session 存储结构设计 | 1h |
| M1.2 | SQLite 会话持久化实现 | 4h |
| M1.3 | Context 重建逻辑（Token 预算控制） | 4h |
| M1.4 | `agentlog resume` CLI 命令 | 2h |
| M1.5 | VS Code 侧边栏 Resume 按钮 | 2h |
| M1.6 | 与 Git Commit 绑定逻辑 | 3h |
| M1.7 | E2E 测试 | 3h |

**总工时**: ~19h

---

#### Feature #M2: DeepSeek R1 推理链可视化

**战略价值**：
- 差异化核心竞争力
- 完整展示 DeepSeek R1 的 `<think>` 推理过程

**技术方案**：
```
数据结构：
{
  "session_id": "xxx",
  "reasoning_chain": [
    {
      "step": 1,
      "thought": "用户想要实现登录功能...",
      "timestamp": "2026-04-01T10:00:00",
      "code_ref": "src/auth/login.ts:15-20"
    }
  ],
  "final_answer": "..."
}

可视化：
├── 折叠式推理展示
│   ├── 默认折叠，显示摘要
│   └── 点击展开，查看完整推理步骤
├── 推理步骤 → 代码引用
│   └── 每个推理步骤可跳转对应代码位置
└── 导出支持
    └── Markdown 格式保留推理链格式
```

**子任务分解**：

| Sub Task | 内容 | 工时 |
|----------|------|------|
| M2.1 | R1 reasoning 拦截器增强 | 3h |
| M2.2 | reasoning_chain 数据结构设计 | 1h |
| M2.3 | VS Code 推理可视化面板 | 4h |
| M2.4 | 折叠/展开 UI 交互 | 2h |
| M2.5 | 代码位置跳转（Peek Definition） | 3h |
| M2.6 | Markdown 导出格式支持 | 2h |

**总工时**: ~15h

---

#### Feature #M3: MCP Server 稳定性强化

**战略价值**：
- 日志捕获率目标 95%+
- 竞品对标：稳定性是 Enter 的优势

**子任务分解**：

| Sub Task | 内容 | 工时 |
|----------|------|------|
| M3.1 | MCP 日志拦截成功率测试 | 2h |
| M3.2 | 失败重试机制实现 | 3h |
| M3.3 | 断线自动恢复 | 2h |
| M3.4 | 稳定性测试报告 | 2h |

**总工时**: ~9h

---

#### Feature #M4: Git Hook 兜底逻辑强化

**战略价值**：
- 确保 Git Commit 100% 绑定 AI Session
- 兜底用户忘记手动绑定的场景

**子任务分解**：

| Sub Task | 内容 | 工时 |
|----------|------|------|
| M4.1 | post-commit hook 兜底检查 | 2h |
| M4.2 | 未绑定 Session 提醒通知 | 1h |
| M4.3 | 手动绑定补救 CLI | 1h |

**总工时**: ~4h

---

## 三、工时汇总

| 阶段 | Task | 工时 |
|------|------|------|
| **P0（本周）** | V1 + R1 + R2 | 4h |
| **P1（本周）** | D1 + D2 + C1 + D3 | 7h + 持续 |
| **P2-M1（中期）** | Context Resume | 19h |
| **P2-M2（中期）** | R1 可视化 | 15h |
| **P2-M3（中期）** | MCP 稳定性 | 9h |
| **P2-M4（中期）** | Git Hook 兜底 | 4h |
| **长期** | Agent 共享记忆协议 | 规划中 |
| **长期** | MCP Registry | 规划中 |

**已确认工时**: P0(4h) + P1(7h) + P2(47h) = **58h**

---

## 四、Ticket 清单 v1.2

### 立即可下发

| Ticket ID | 任务 | Compliance Rule |
|-----------|------|-----------------|
| #AG-V1 | VS Code 截图更新 | 1280x800 或 900x600 |
| #AG-R1 | Release Note 中文版 | 三平台六架构链接可用 |
| #AG-R2 | CHANGELOG 中文版 | Keep a Changelog 标准 |
| #AG-D1 | README 中文优化 | 首屏 30 秒理解产品 |
| #AG-D2 | Discussions 启用 | 3+ 讨论分类 |

### 中期待下发

| Ticket ID | 任务 | 依赖 |
|-----------|------|------|
| #AG-M1 | Context Resume | M1.1~M1.7 完整实现 + E2E |
| #AG-M2 | R1 可视化 | M2.1~M2.6 完整实现 |
| #AG-M3 | MCP 稳定性 | 95%+ 捕获率目标 |
| #AG-M4 | Git Hook 兜底 | 100% 绑定目标 |

---

## 五、审批状态

| 版本 | 日期 | 审批状态 |
|------|------|----------|
| v1.0 | 2026-04-01 16:00 | ✅ 已批准（已废弃 Dashboard） |
| v1.1 | 2026-04-01 17:00 | ⏳ 待 CEO 审批 |
| v1.2 | 2026-04-01 17:07 | ⏳ 待 CEO 审批（对齐 STRATEGY v1.0） |

**CEO 审批印记**: ⏳ PENDING_APPROVAL_20260401

---

## 六、战略关键词对齐

| 战略关键词 | AgentLog 关键词 | 展示位置 |
|------------|-----------------|----------|
| 本地隐私 | Local-First, Privacy | README、 marketplace 描述 |
| Git as Checkpoint | Git Commit Binding | 核心功能、截图 |
| Context Resume | 一键复活 AI 历史 | VS Code 侧边栏、CLI |
| DeepSeek R1 | 推理链可视化 | 差异化功能 |
| 跨时间回溯 | Session History | Dashboard 原型（未来） |

---

**Architect 签署**: 🏗️ Architect  
**战略锚定**: 📋 STRATEGY.md v1.0
