# AgentLog 用户增长方案 - 技术设计方案

**版本**: v1.0  
**日期**: 2026-04-01  
**制定者**: Architect（架构设计师）  
**审批**: CEO（陈洪博）  
**状态**: 已批准，待执行  

---

## 一、项目概述

本方案针对 AgentLog 产品已上线 VS Code Marketplace 和 GitHub 的现状，制定下一阶段用户增长技术支持计划。涵盖：插件优化、Release 完善、Dashboard 增强、竞品监控集成四大模块。

---

## 二、工作分解结构（WBS）

### 模块 A：VS Code Marketplace 插件优化

| Task ID | 子任务 | 依赖 | 优先级 | 估算工时 |
|---------|--------|------|--------|----------|
| A.1 | 插件描述文案优化 | - | P0 | 1h |
| A.2 | 增加关键字（DeepSeek、Git、编程助手） | A.1 | P0 | 0.5h |
| A.3 | 插件截图/预览图更新 | - | P1 | 2h |
| A.4 | 发布 v1.0.1 小版本更新 | A.1, A.2, A.3 | P0 | 1h |

**技术要求**：
- marketplace.json 描述限制 1000 字符，需精简
- preview.png 尺寸 1280x800 或 900x600
- version 遵循 semver: major.minor.patch

---

### 模块 B：GitHub Release 完善

| Task ID | 子任务 | 依赖 | 优先级 | 估算工时 |
|---------|--------|------|--------|----------|
| B.1 | 检查 Release Note 完整性 | - | P0 | 0.5h |
| B.2 | 补充中文版本 Release Note | B.1 | P0 | 1h |
| B.3 | 验证下载链接可用性 | B.1 | P0 | 0.5h |
| B.4 | 添加 CHANGELOG.md 中文版 | B.1 | P1 | 1h |

**技术要求**：
- Release Note 路径: `RELEASE_NOTE.md` / `CHANGELOG.md`
- 需覆盖：新增功能（Features）、Bug修复、Breaking Changes
- 下载链接需覆盖：Windows(x64/arm64)、macOS(x64/arm64)、Linux(x64/arm64)

---

### 模块 C：Dashboard 增强

根据用户反馈，需要以下优化：

#### C.1 Agent 名称显示优化

| Task ID | 子任务 | 依赖 | 优先级 | 估算工时 |
|---------|--------|------|--------|----------|
| C.1.1 | 从 sessions.json 提取 Agent 真实名称 | - | P0 | 0.5h |
| C.1.2 | 替换 Dashboard 标头显示 | C.1.1 | P0 | 0.5h |
| C.1.3 | 添加 Agent emoji 标识 | C.1.2 | P1 | 0.5h |

#### C.2 当前任务简要介绍

| Task ID | 子任务 | 依赖 | 优先级 | 估算工时 |
|---------|--------|------|--------|----------|
| C.2.1 | 分析 sessions.json 中最新消息结构 | - | P0 | 1h |
| C.2.2 | 实现任务摘要提取逻辑 | C.2.1 | P0 | 2h |
| C.2.3 | UI 显示任务描述卡片 | C.2.2 | P0 | 1h |

**数据结构**：
```json
{
  "agent": "architect",
  "currentTask": {
    "brief": "设计 Dashboard 技术方案",
    "lastMessage": "已完成 SPEC.md 编写",
    "timestamp": "2026-04-01T16:00:00+08:00"
  }
}
```

#### C.3 中英文界面切换

| Task ID | 子任务 | 依赖 | 优先级 | 估算工时 |
|---------|--------|------|--------|----------|
| C.3.1 | 创建 i18n 国际化文件（en.json/zh.json） | - | P1 | 1h |
| C.3.2 | 实现语言切换逻辑 | C.3.1 | P1 | 1h |
| C.3.3 | 添加语言切换按钮 | C.3.2 | P1 | 0.5h |

#### C.4 页面刷新间隔优化

| Task ID | 子任务 | 依赖 | 优先级 | 估算工时 |
|---------|--------|------|--------|----------|
| C.4.1 | 移除 10 秒整页刷新动画 | - | P0 | 0.5h |
| C.4.2 | 改为增量更新 + 淡入淡出效果 | C.4.1 | P1 | 1h |
| C.4.3 | 添加 SSE 断线重连机制 | C.4.2 | P1 | 1h |

#### C.5 像素风格办公室虚拟场景（续）

| Task ID | 子任务 | 依赖 | 优先级 | 估算工时 |
|---------|--------|------|--------|----------|
| C.5.1 | 使用 MiniMax 文生图 API 生成角色头像 | - | P1 | 3h |
| C.5.2 | 角色头像透明背景处理 | C.5.1 | P1 | 1h |
| C.5.3 | 调整角色图标尺寸（放大 3x） | - | P0 | 0.5h |
| C.5.4 | 优化工位尺寸和布局 | - | P0 | 1h |
| C.5.5 | 调整角色移动速度 | - | P0 | 0.5h |
| C.5.6 | 去除圆形外框，不规则边框 | C.5.2 | P0 | 0.5h |
| C.5.7 | 全部文字显示放大 3 倍 | - | P0 | 0.5h |
| C.5.8 | 塞尔达像素风格（颗粒感）优化 | C.5.1 | P1 | 2h |

---

### 模块 D：竞品监控集成

| Task ID | 子任务 | 依赖 | 优先级 | 估算工时 |
|---------|--------|------|--------|----------|
| D.1 | 与 Sentinel 协作获取 Claude Code 动态 | - | P1 | 1h |
| D.2 | 设计竞品数据存储结构 | - | P1 | 1h |
| D.3 | Dashboard 竞品动态展示 | D.1, D.2 | P2 | 2h |
| D.4 | 定期自动抓取竞品更新 | D.3 | P2 | 3h |

---

## 三、优先级排序

### P0 - 立即执行（24小时内）

| Task ID | 任务 |
|---------|------|
| A.1 | 插件描述文案优化 |
| A.2 | 增加关键字 |
| A.4 | 发布 v1.0.1 |
| B.1 | 检查 Release Note |
| B.2 | 中文 Release Note |
| B.3 | 验证下载链接 |
| C.1.1 | 提取 Agent 真实名称 |
| C.1.2 | 替换 Dashboard 标头 |
| C.2.1 | 分析消息结构 |
| C.2.2 | 任务摘要提取 |
| C.2.3 | 任务描述卡片 |
| C.4.1 | 移除刷新动画 |
| C.5.3 | 放大图标 3x |
| C.5.4 | 优化工位尺寸 |
| C.5.5 | 调整移动速度 |
| C.5.6 | 去除圆形外框 |
| C.5.7 | 文字放大 3 倍 |

### P1 - 本周执行

| Task ID | 任务 |
|---------|------|
| A.3 | 更新插件截图 |
| B.4 | CHANGELOG 中文版 |
| C.1.3 | Agent emoji |
| C.3 | 中英文切换 |
| C.4.2 | 增量更新效果 |
| C.4.3 | SSE 断线重连 |
| C.5.1 | MiniMax 文生图 |
| C.5.2 | 透明背景处理 |
| C.5.8 | 塞尔达像素风格 |
| D.1 | Sentinel 协作 |
| D.2 | 竞品数据存储 |

### P2 - 规划中

| Task ID | 任务 |
|---------|------|
| D.3 | Dashboard 竞品展示 |
| D.4 | 定期自动抓取 |

---

## 四、工时估算汇总

| 模块 | P0 工时 | P1 工时 | P2 工时 | 合计 |
|------|---------|---------|---------|------|
| A. VS Code 插件 | 2.5h | 2h | - | 4.5h |
| B. GitHub Release | 2h | 1h | - | 3h |
| C. Dashboard | 7.5h | 8.5h | - | 16h |
| D. 竞品监控 | - | 2h | 5h | 7h |
| **合计** | 12h | 13.5h | 5h | **30.5h** |

---

## 五、技术方案详细设计

### 5.1 VS Code 插件发布流程

```
1. 修改 marketplace.json 描述
2. 更新 preview.png
3. 更新 version 至 1.0.1
4. 执行: npm run build
5. 执行: vsce publish
6. 验证: marketplace.visualstudio.com
```

### 5.2 Dashboard 消息结构分析

sessions.json 中的消息结构：
```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "用户消息内容"
    }
  ],
  "timestamp": 1775013629800
}
```

任务摘要提取策略：
1. 取最新一条 user 消息作为 `currentTask.brief`
2. 取最新一条 assistant 消息作为 `currentTask.response`
3. 时间戳转换：`new Date(timestamp).toISOString()`

### 5.3 MiniMax 文生图集成

```javascript
// API Endpoint
POST https://api.minimaxi.com/v1/image_generation

// Request
{
  "model": "image-01",
  "prompt": "Zelda-like pixel art character, different professions, transparent background, retro game sprite style, 16-bit RPG, distinct outfits for each role",
  "aspect_ratio": "1:1",
  "response_format": "url"
}

// 角色 Prompt 模板
const AGENT_PROMPTS = {
  architect: "Zelda-like pixel art, male architect with tool belt, transparent background, 16-bit RPG sprite style",
  builder: "Zelda-like pixel art, male builder/carpenter with hammer, transparent background, 16-bit RPG sprite style",
  growth_hacker: "Zelda-like pixel art, female marketer with megaphone, transparent background, 16-bit RPG sprite style",
  // ... 其他角色
}
```

### 5.4 i18n 国际化结构

```
public/
├── i18n/
│   ├── en.json
│   └── zh.json
└── app.js

// 切换逻辑
function setLanguage(lang) {
  const translations = require(`./i18n/${lang}.json`);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = translations[el.dataset.i18n];
  });
}
```

---

## 六、Ticket 拆解（Ready for Builder）

### Ticket #GP-A1: VS Code 插件描述优化
```json
{
  "From": "Architect",
  "To": "Builder",
  "Context_Anchor": "GROWTH_PLAN_v1.0_TECH_DESIGN.md",
  "Base_Ticket": "优化 VS Code 插件 marketplace 描述，增加关键字：DeepSeek、Git、编程助手",
  "Compliance_Rule": "描述限制 1000 字符，需包含所有目标关键字",
  "CEO_Approval_Stamp": "SIGNED_BY_CEO_20260401"
}
```

### Ticket #GP-B1: GitHub Release 完善
```json
{
  "From": "Architect",
  "To": "Builder",
  "Context_Anchor": "GROWTH_PLAN_v1.0_TECH_DESIGN.md",
  "Base_Ticket": "补充完整中文 Release Note，验证所有下载链接",
  "Compliance_Rule": "覆盖三平台六架构下载链接",
  "CEO_Approval_Stamp": "SIGNED_BY_CEO_20260401"
}
```

### Ticket #GP-C1: Dashboard Agent 名称显示
```json
{
  "From": "Architect",
  "To": "Builder",
  "Context_Anchor": "GROWTH_PLAN_v1.0_TECH_DESIGN.md",
  "Base_Ticket": "修改 Dashboard 标头显示 Agent 真实名称而非 session 名字，添加 emoji 标识",
  "Compliance_Rule": "名称从 agent 目录结构提取，显示效果清晰",
  "CEO_Approval_Stamp": "SIGNED_BY_CEO_20260401"
}
```

### Ticket #GP-C2: Dashboard 任务描述卡片
```json
{
  "From": "Architect",
  "To": "Builder",
  "Context_Anchor": "GROWTH_PLAN_v1.0_TECH_DESIGN.md",
  "Base_Ticket": "实现 Agent 当前任务简要介绍显示，从 sessions.json 提取最新消息",
  "Compliance_Rule": "显示任务描述 + 时间，支持中英文",
  "CEO_Approval_Stamp": "SIGNED_BY_CEO_20260401"
}
```

### Ticket #GP-C3: Dashboard 刷新优化
```json
{
  "From": "Architect",
  "To": "Builder",
  "Context_Anchor": "GROWTH_PLAN_v1.0_TECH_DESIGN.md",
  "Base_Ticket": "移除 10 秒整页刷新，改为增量更新 + 淡入淡出效果",
  "Compliance_Rule": "SSE 实时推送，添加断线重连机制",
  "CEO_Approval_Stamp": "SIGNED_BY_CEO_20260401"
}
```

### Ticket #GP-C4: Dashboard 像素风格优化
```json
{
  "From": "Architect",
  "To": "Builder",
  "Context_Anchor": "GROWTH_PLAN_v1.0_TECH_DESIGN.md",
  "Base_Ticket": "使用 MiniMax 文生图生成各 Agent 塞尔达像素风格头像（透明背景），放大图标和文字 3 倍，优化工位和移动速度",
  "Compliance_Rule": "去除圆形外框，风格统一有颗粒感",
  "CEO_Approval_Stamp": "SIGNED_BY_CEO_20260401"
}
```

### Ticket #GP-C5: Dashboard 中英文切换
```json
{
  "From": "Architect",
  "To": "Builder",
  "Context_Anchor": "GROWTH_PLAN_v1.0_TECH_DESIGN.md",
  "Base_Ticket": "实现 Dashboard 中英文界面切换功能",
  "Compliance_Rule": "i18n 架构，语言切换无刷新",
  "CEO_Approval_Stamp": "SIGNED_BY_CEO_20260401"
}
```

---

## 七、验收标准

| 模块 | 验收条件 |
|------|----------|
| VS Code | marketplace 显示正确版本 1.0.1，关键字可见 |
| GitHub | Release Note 中英双语，链接全部可用 |
| Dashboard | Agent 名称正确、任务描述显示、中英文切换正常 |
| 像素风格 | 头像透明、风格一致、文字清晰可读 |
| 竞品监控 | Sentinel 协作流程打通，数据结构定义 |

---

## 八、风险提示

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| MiniMax 文生图 API 限流 | C.5.1 延迟 | 预生成缓存本地 |
| VS Code marketplace 审核 | 发布延迟 | 提前准备申诉材料 |
| 竞品数据源反爬 | D.4 受阻 | 人工 + 自动混合模式 |

---

## 九、附录

- Dashboard 项目路径: `~/Projects/agent-status-dashboard/`
- AgentLog 主项目路径: `~/Projects/agentlog/`
- MiniMax API Key: 已在 Builder 会话中提供

---

**CEO 审批印记**: SIGNED_BY_CEO_20260401
**Architect 签署**: 🏗️ Architect
