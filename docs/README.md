# AgentLog 文档索引

> 工程所有文档的统一入口，按类别组织。
> **状态标识**：⚠️ 已废弃 | ✅ 已完成 | 🔄 讨论中

---

## 📋 规范与标准

| 文档 | 说明 | 状态 |
|------|------|------|
| [AGENTLOG_SPEC.md](./AGENTLOG_SPEC.md) | AgentLog 核心规范 | ✅ 已完成 |
| [DATA-MODEL.md](./DATA-MODEL.md) | 数据模型文档（v10 Schema） | ✅ 已完成 |

---

## 🛠️ 开发计划

| 文档 | 说明 | 状态 |
|------|------|------|
| [AGENTLOG_DEV_PLAN_v1.1.md](./AGENTLOG_DEV_PLAN_v1.1.md) | 开发计划 v1.1 | ⚠️ 已废弃 |
| [AGENTLOG_DEV_PLAN_v1.2.md](./AGENTLOG_DEV_PLAN_v1.2.md) | 开发计划 v1.2 | ⚠️ 已废弃 |
| [AGENTLOG_DEV_PLAN_v3.0.md](./AGENTLOG_DEV_PLAN_v3.0.md) | 开发计划 v3.0 | ✅ 已完成（v1.1.1 发布） |

---

## 📊 技术设计与方案

| 文档 | 说明 | 状态 |
|------|------|------|
| [AUTO_HOOK_SPEC.md](./AUTO_HOOK_SPEC.md) | 自动 Hook 规范 | ✅ 已完成 |
| [MCP-CLIENT-GUIDE.md](./MCP-CLIENT-GUIDE.md) | MCP 客户端指南 | ✅ 已完成 |
| [MCP_DATA_QUALITY_ASSESSMENT.md](./MCP_DATA_QUALITY_ASSESSMENT.md) | MCP 数据质量评估 | ✅ 已完成 |
| [GROWTH_PLAN_v1.0_TECH_DESIGN.md](./GROWTH_PLAN_v1.0_TECH_DESIGN.md) | 增长计划技术设计 | ✅ 已完成 |
| [Change_arch.md](./Change_arch.md) | 架构变更记录 | ✅ 已完成 |

---

## 📊 Trace & Span 设计（v1.1 新增）

| 文档 | 说明 | 状态 |
|------|------|------|
| [TRACE-LIFECYCLE.md](./TRACE-LIFECYCLE.md) | Trace 生命周期管理方案 | ✅ 已完成（已实现） |
| [TRACE_TEST_CASES.md](./TRACE_TEST_CASES.md) | Trace 测试用例 | ✅ 已完成 |
| [STAGE1_HANDOFF_STITCHING_DESIGN.md](./STAGE1_HANDOFF_STITCHING_DESIGN.md) | 任务交接设计 | ✅ 已完成 |
| [STAGE1_HANDOFF_STITCHING_DESIGN_V2.md](./STAGE1_HANDOFF_STITCHING_DESIGN_V2.md) | 任务交接设计 v2 | ✅ 已完成 |
| [STAGE1_NONCODE_TASK_DESIGN.md](./STAGE1_NONCODE_TASK_DESIGN.md) | 非代码任务设计 | ✅ 已完成 |
| [STAGE1_MISSING_TICKETS.md](./STAGE1_MISSING_TICKETS.md) | 缺失 Ticket 补充 | ✅ 已完成 |
| [PHASE1-COMPLETE-TEST.md](./PHASE1-COMPLETE-TEST.md) | Phase1 完整测试 | ✅ 已完成 |
| [PHASE1-INTERACTIVE-TEST.md](./PHASE1-INTERACTIVE-TEST.md) | Phase1 交互测试 | ✅ 已完成 |
| [PHASE1-HUMAN-OVERRIDE-TEST.md](./PHASE1-HUMAN-OVERRIDE-TEST.md) | Phase1 人工override测试 | ✅ 已完成 |
| [st age1_test_cases.md](./stage1_test_cases.md) | Stage1 测试用例 | ✅ 已完成 |

---

## 📊 每日日报自动填充方案

| 文档 | 说明 | 状态 |
|------|------|------|
| [AGENTLOG_DAILY_REPORT_DESIGN_v2.0.md](./AGENTLOG_DAILY_REPORT_DESIGN_v2.0.md) | 每日日报自动填充方案（通用版） | 🔄 讨论中 |
| [AGENTLOG_DAILY_REPORT_DESIGN_v1.0.md](./AGENTLOG_DAILY_REPORT_DESIGN_v1.0.md) | 每日日报自动填充方案（Growth-Hacker 专用版） | ⚠️ 已废弃（v2.0 替代） |

---

## 🔍 存证完整性

| 文档 | 说明 | 状态 |
|------|------|------|
| [AGENTLOG_COMPLETE_AUDIT_v1.0.md](./AGENTLOG_COMPLETE_AUDIT_v1.0.md) | 全量存证完整性设计方案（P0） | 🔄 讨论中 |

---

## 🛠️ Skills

| Skill | 说明 | 状态 |
|-------|------|------|
| [openclaw-agent-log](../skills/openclaw-agent-log/) | OpenClaw Agent 统一存证 + Trace Handoff | ✅ 已完成（合并后） |
| [agentlog-auto](../skills/agentlog-auto/) | 自动存证 Hooks | ⚠️ 已废弃（合并到 openclaw-agent-log） |
| [agentlog-daily-report](../skills/agentlog-daily-report/) | 每日日报自动填充 | 🔄 开发中 |

---

## 🔍 生命周期追踪

| 文档 | 说明 | 状态 |
|------|------|------|
| [TRACK-A-LIFECYCLE-HOOKS.md](./TRACK-A-LIFECYCLE-HOOKS.md) | 生命周期 Hooks 追踪 | ✅ 已完成 |
| [TRACK-B-HTTP-INTERCEPTOR.md](./TRACK-B-HTTP-INTERCEPTOR.md) | HTTP 拦截器追踪 | ✅ 已完成 |

---

## 🧪 测试

| 文档 | 说明 | 状态 |
|------|------|------|
| [E2E_TEST_CASES.md](./E2E_TEST_CASES.md) | 端到端测试用例 | ✅ 已完成 |
| [TESTING.md](./TESTING.md) | 测试文档 | ✅ 已完成 |

---

## 🔧 Issue 修复

| 文档 | 说明 | 状态 |
|------|------|------|
| [ISSUE_FIX_15.md](./ISSUE_FIX_15.md) | Issue #15 修复记录 | ✅ 已完成 |
| [ISSUE_FIX_COMBINED.md](./ISSUE_FIX_COMBINED.md) | Issue 修混合并记录 | ✅ 已完成 |
| [ISSUE_FIX_COMBINED_v2.md](./ISSUE_FIX_COMBINED_v2.md) | Issue 修混合并记录 v2 | ✅ 已完成 |

---

## 🔍 Code Review

| 文档 | 说明 | 状态 |
|------|------|------|
| [CODE_REVIEW_PR1.md](./CODE_REVIEW_PR1.md) | PR #1 Code Review | ✅ 已完成 |

---

## 🚀 IDE 支持

| 文档 | 说明 | 状态 |
|------|------|------|
| [TRAE_IDE_QUICKSTART.md](./TRAE_IDE_QUICKSTART.md) | Trae IDE 快速入门 | ✅ 已完成 |
| [TRAE_IDE_SUPPORT_v1.0.md](./TRAE_IDE_SUPPORT_v1.0.md) | Trae IDE 支持方案 | ✅ 已完成 |

---

## 📊 状态汇总

| 状态 | 数量 |
|------|------|
| ✅ 已完成 | 28 |
| 🔄 讨论中 | 2 |
| ⚠️ 已废弃 | 4 |

---

*最后更新：2026-04-06*
