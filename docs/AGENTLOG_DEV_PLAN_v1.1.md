# AgentLog 产品开发计划 v1.1

**版本**: v1.1  
**日期**: 2026-04-01  
**制定者**: Architect（架构设计师）  
**审批**: CEO（陈洪博）待审批  
**状态**: 新增 P0/P1 任务，待 CEO 批准后执行  

---

## 一、计划变更说明

**v1.0 废弃内容（Dashboard 测试任务，已暂停）**：
- ❌ Dashboard Agent 名称显示
- ❌ Dashboard 任务简介卡片
- ❌ Dashboard 刷新动画优化
- ❌ Dashboard 像素风格修复
- ❌ Dashboard 中英文切换

**v1.1 保留内容**：
- ✅ VS Code 插件 v1.0.1 更新（已上线）
- ✅ GitHub Release 完善（待完成）

**v1.1 新增内容**（基于 CEO 确认的产品范围）：
- GitHub 产品文档完善
- VS Code Marketplace 插件截图更新
- 竞品动态监控（与 Sentinel 协作）

---

## 二、任务详细说明

### 🔴 P0 - 立即执行（审批后 24 小时内）

---

#### Task #V1: VS Code 插件截图更新

**任务描述**：
更新 VS Code Marketplace 插件的 preview.png 截图，展示最新功能界面。

**具体操作**：
1. 打开 VS Code + AgentLog 插件
2. 截取侧边栏面板完整截图（1280x800 或 900x600）
3. 替换 `packages/vscode-extension/assets/preview.png`
4. 验证 marketplace 页面显示效果

**验收标准**：
- 截图清晰显示 AgentLog 核心功能
- 包含中文界面元素
- 无敏感信息泄露

**工时估算**: 1h

---

#### Task #R1: GitHub Release Note 中文版

**任务描述**：
在 GitHub Release 页面添加中文版本 Release Note，方便国内开发者阅读。

**具体操作**：
1. 创建 `RELEASE_NOTE.md` 文件
2. 双语结构：English Version → 中文版本
3. 内容覆盖：
   - v1.0.1: 插件发布、支持的模型列表
   - v1.0.0: 首发版本核心功能
4. 验证下载链接（三平台六架构）

**文件结构**：
```markdown
# Release Note | v1.0.1

## English
### New Features
- ...
### Bug Fixes
- ...

## 中文版
### 新增功能
- ...
### Bug 修复
- ...
```

**验收标准**：
- 中英双语完整
- 下载链接覆盖：Windows(x64/arm64)、macOS(x64/arm64)、Linux(x64/arm64)
- GitHub Release 页面可正常显示

**工时估算**: 2h

---

#### Task #R2: CHANGELOG.md 中文版

**任务描述**：
创建中文版 CHANGELOG.md，记录产品版本迭代历史。

**具体操作**：
1. 创建 `CHANGELOG.md`
2. 格式遵循 Keep a Changelog 标准
3. 包含版本号、日期、变更类型（Added/Changed/Fixed/Security）

**验收标准**：
- 覆盖 v1.0.0 和 v1.0.1
- 使用中文描述变更内容
- 可被 GitHub 自动关联到 Release

**工时估算**: 1h

---

### 🟡 P1 - 本周执行

---

#### Task #D1: GitHub README 优化

**任务描述**：
优化 GitHub 仓库首页 README，增加功能展示图、安装指引、Logo。

**具体操作**：
1. 添加功能演示 GIF/PNG（侧边栏、周报导出、Commit 绑定流程）
2. 优化安装步骤（VS Code Marketplace 一键安装）
3. 添加 Badge（Version、License、Downloads）
4. 补充国产大模型 Logo（DeepSeek、Qwen、Kimi 等）

**验收标准**：
- README 首屏展示产品核心价值
- 安装流程清晰，3 步以内
- 支持的模型/工具列表完整

**工时估算**: 3h

---

#### Task #D2: GitHub Discussions 启用

**任务描述**：
启用 GitHub Discussions 功能，建立开发者社区。

**具体操作**：
1. 启用 GitHub Discussions
2. 配置讨论分类：General / Q&A / Feature Requests / Bug Reports
3. 添加置顶帖：欢迎使用 AgentLog
4. 制定社区规范（礼貌、禁止广告）

**验收标准**：
- Discussions 页面可访问
- 至少 3 个讨论分类
- 有置顶欢迎帖

**工时估算**: 1h

---

#### Task #C1: 竞品动态监控（与 Sentinel 协作）

**任务描述**：
与 Sentinel 协作，监控 Claude Code、Cursor 等竞品动态，为产品迭代提供情报支持。

**具体操作**：
1. 与 Sentinel 建立情报共享机制
2. 设计竞品数据结构（竞品名称、版本、功能更新、发布日期）
3. 创建 `docs/COMPETITORS.md` 记录竞品分析
4. 定期更新（每月或重大版本发布时）

**验收标准**：
- 覆盖竞品：Claude Code、Cursor、Cline、Continue
- 包含功能对比表
- 可导出为产品规划参考

**工时估算**: 2h（与 Sentinel 协作）

---

#### Task #D3: VS Code Marketplace 评论区管理

**任务描述**：
管理 VS Code Marketplace 评论区，回复用户问题，收集反馈。

**具体操作**：
1. 定期检查评论区（每周一次）
2. 回复用户问题（安装问题、兼容性问题）
3. 收集 5 星好评邀请语
4. 记录用户反馈到 GitHub Issues

**验收标准**：
- 评论区回复率 100%
- 用户问题解决时长 < 48h
- 积累 10+ 有效用户反馈

**工时估算**: 持续运营，每周 1h

---

## 三、优先级汇总

| Task ID | 任务 | 优先级 | 工时 | 依赖 |
|---------|------|--------|------|------|
| #V1 | VS Code 插件截图更新 | P0 | 1h | - |
| #R1 | GitHub Release Note 中文版 | P0 | 2h | - |
| #R2 | CHANGELOG.md 中文版 | P0 | 1h | - |
| #D1 | GitHub README 优化 | P1 | 3h | - |
| #D2 | GitHub Discussions 启用 | P1 | 1h | - |
| #C1 | 竞品动态监控 | P1 | 2h | Sentinel |
| #D3 | Marketplace 评论管理 | P1 | 每周1h | - |

**总工时**: P0 = 4h，P1 = 7h + 持续运营

---

## 四、Ticket 清单（待审批后下发）

```json
{
  "From": "Architect",
  "To": "Builder",
  "Context_Anchor": "AGENTLOG_DEV_PLAN_v1.1.md",
  "CEO_Approval_Stamp": "PENDING_APPROVAL_20260401"
}
```

### Ticket #AG-V1: VS Code 插件截图更新
- Base_Ticket: 更新 marketplace 预览图
- Compliance_Rule: 尺寸 1280x800 或 900x600，清晰展示功能
- Acceptance_Criteria: 截图替换后 marketplace 显示正常

### Ticket #AG-R1: GitHub Release Note 中文版
- Base_Ticket: 创建双语 Release Note，验证下载链接
- Compliance_Rule: 三平台六架构下载链接全部可用
- Acceptance_Criteria: GitHub Release 页面正常显示

### Ticket #AG-R2: CHANGELOG.md 中文版
- Base_Ticket: 创建符合 Keep a Changelog 标准的文档
- Compliance_Rule: 覆盖 v1.0.0 和 v1.0.1
- Acceptance_Criteria: GitHub 自动关联到 Release

### Ticket #AG-D1: GitHub README 优化
- Base_Ticket: 优化仓库首页展示效果
- Compliance_Rule: 首屏展示产品价值，安装 3 步以内
- Acceptance_Criteria: 新用户 30 秒内理解产品用途

### Ticket #AG-D2: GitHub Discussions 启用
- Base_Ticket: 启用社区讨论功能
- Compliance_Rule: 至少 3 个讨论分类
- Acceptance_Criteria: Discussions 页面可访问

### Ticket #AG-C1: 竞品动态监控
- Base_Ticket: 与 Sentinel 协作建立竞品监控机制
- Compliance_Rule: 覆盖 Claude Code、Cursor、Cline、Continue
- Acceptance_Criteria: 竞品数据结构完整，更新及时

---

## 五、已废弃任务（Dashboard 测试，不属于产品范围）

| Task ID | 原任务 | 废弃原因 |
|---------|--------|----------|
| #GP-C1 | Dashboard Agent 名称显示 | 测试任务，非产品功能 |
| #GP-C2 | Dashboard 任务描述卡片 | 测试任务，非产品功能 |
| #GP-C3 | Dashboard 刷新动画优化 | 测试任务，非产品功能 |
| #GP-C4 | Dashboard 像素风格修复 | 测试任务，非产品功能 |
| #GP-C5 | Dashboard 中英文切换 | 测试任务，非产品功能 |

---

## 六、审批状态

| 版本 | 日期 | 审批状态 |
|------|------|----------|
| v1.0 | 2026-04-01 16:00 | ✅ 已批准（包含 Dashboard） |
| v1.1 | 2026-04-01 17:00 | ⏳ 待 CEO 审批 |

**CEO 审批印记**: ⏳ PENDING_APPROVAL

---

**Architect 签署**: 🏗️ Architect
