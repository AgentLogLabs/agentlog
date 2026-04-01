# Trae IDE 支持 - 技术可行性评估与方案

**版本**: v1.0  
**日期**: 2026-04-01  
**制定者**: Architect（架构设计师）  
**状态**: 已整合至 AGENTLOG_DEV_PLAN_v1.2  

---

## 一、情报摘要

| 项目 | 内容 |
|------|------|
| 产品 | Trae IDE（字节跳动） |
| 定位 | AI Native IDE，Builder Mode |
| 特性 | MCP 原生支持 |
| 市场 | 国内用户增长迅猛 |

---

## 二、技术可行性评估

### 2.1 现有架构分析

AgentLog 支持 AI 工具的方式：

| 方式 | 原理 | 覆盖范围 |
|------|------|----------|
| **Track A: MCP Server** | AI Agent 主动调用 `log_turn` 工具 | Cline、Continue、OpenCode 等 MCP Client |
| **Track B: HTTP Interceptor** | Monkey-patch Node.js http/https | 非 MCP 工具的 HTTP API 调用 |

### 2.2 Trae IDE 集成方式推断

基于公开情报（字节跳动、MCP Native）：

```
┌─────────────────────────────────────────────────────────────┐
│ Trae IDE                                                    │
│  ├── Builder Mode → 任务分解 + 执行                         │
│  ├── MCP Native → 原生 MCP Client 支持                     │
│  └── AI API → OpenAI 兼容格式（推断）                       │
│                                                              │
│  集成路径选择：                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 方案 1（推荐）：MCP Server 集成                       │   │
│  │ - Trae 内置 MCP Client → 调用 AgentLog MCP Server    │   │
│  │ - log_turn / log_intent 工具可用                     │   │
│  │ - 需要：确认 Trae 支持自定义 MCP Server              │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 方案 2：HTTP Interceptor（兜底）                      │   │
│  │ - 如果 Trae 使用 HTTP API 调用大模型                  │   │
│  │ - Track B 可以拦截并记录                              │   │
│  │ - 需要：确认 Trae 的 API Endpoint                     │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、技术方案

### 3.1 方案 1: MCP Server 集成（主路径）

**前提**：Trae IDE 支持配置自定义 MCP Server

**操作步骤**：
1. **确认 Trae MCP 配置方式**
   - 查找 Trae 文档或社区
   - 确认 MCP Server URL 配置入口

2. **测试 MCP Server 连接**
   - Trae → AgentLog MCP Server (`npx agentlog-mcp`)
   - 验证 `log_turn` / `log_intent` 工具调用

3. **用户指引文档**
   - 编写《Trae IDE + AgentLog 快速上手》
   - 截图：Trae MCP 配置步骤

**MCP Server 现状**：
```typescript
// packages/backend/src/mcp.ts — 已有 trae 映射
function inferSource(clientName: string): string {
  if (name.includes("trae")) return "trae";  // ✅ 已有
  // ...
}
```

**结论**：MCP Server **已支持** Trae（source 字段），仅需用户侧配置。

---

### 3.2 方案 2: VS Code 插件兼容性（备选）

**如果 Trae 基于 VS Code 扩展生态**：
- AgentLog VS Code 插件可直接安装到 Trae
- Track A（MCP）和 Track B（HTTP Interceptor）自动生效

**验证步骤**：
1. 在 Trae 中尝试安装 AgentLog VS Code 插件
2. 确认 `.vsix` 格式兼容性

---

### 3.3 方案 3: HTTP Interceptor 扩展（兜底）

**扩展拦截规则**（如 Trae 使用私有 API）：

```typescript
// packages/vscode-extension/src/hooks/apiInterceptor.ts

// 新增 Trae API Host（如已知）
const TRAE_API_PATTERNS = [
  /api\.trae\.ai/i,
  /trae\-api\./i,
];

const AI_HOST_PATTERNS = [
  // ... 现有 DeepSeek, OpenAI, 阿里云 ...
  ...TRAE_API_PATTERNS,  // 新增
];
```

---

## 四、工作量估算

| 方案 | Task | 工时 | 风险 |
|------|------|------|------|
| **方案 1** | MCP Server 已支持 | 1h（文档 + 测试） | 低 |
| **方案 2** | VS Code 插件兼容性测试 | 1h | 低 |
| **方案 3** | HTTP Interceptor 扩展 | 4h（等待 Trae API 信息） | 中 |

**推荐路径**：方案 1 → 方案 2 → 方案 3（按顺序尝试）

---

## 五、Ticket 分解

### Ticket #AG-T1: Trae IDE MCP 集成验证

**Base_Ticket**：
1. 确认 Trae IDE 支持自定义 MCP Server 配置
2. 测试 AgentLog MCP Server 在 Trae 中的调用
3. 验证 `log_turn` / `log_intent` 工具正常工作

**Compliance_Rule**：
- MCP Server 响应正常
- Trae 侧可看到 AgentLog 工具列表

**Acceptance_Criteria**：
- Trae 能成功调用 `agentlog.log_turn`
- 会话数据正确写入 SQLite

**工时估算**：2h

---

### Ticket #AG-T2: Trae IDE 用户指引文档

**Base_Ticket**：
编写《Trae IDE + AgentLog 快速上手》文档

**内容要求**：
- Trae MCP 配置步骤截图
- 验证连接成功的标志
- 常见问题排查

**Compliance_Rule**：
- 中文文档
- 截图清晰
- 3 步以内完成配置

**工时估算**：1h

---

### Ticket #AG-T3: Trae 插件市场发布（如支持）

**Base_Ticket**：
如果 Trae 有独立插件市场，发布 AgentLog Trae 版本

**前提**：
- 确认 Trae 插件市场存在
- 确认 AgentLog VS Code 插件兼容

**工时估算**：3h（待确认）

---

## 六、优先级建议

| 优先级 | 理由 |
|--------|------|
| **P0** | Trae 是重要新平台，国内用户增长快 |
| **2 周内 Alpha** | Strategy v1.1 明确的 OKR |

---

## 七、结论

1. **MCP Server 已支持 Trae**（`inferSource` 已有映射）
2. **工作量小**：主要是文档 + 兼容性测试（2-4h）
3. **风险低**：方案 1 不可行则尝试方案 2
4. **建议立即执行**：下发给 Builder 进行验证

---

**Architect 签署**: 🏗️ Architect
