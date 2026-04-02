# AgentLog 产品开发计划 v3.0

**版本**: v3.0  
**日期**: 2026-04-01  
**制定者**: Architect（架构设计师）  
**战略锚定**: `STRATEGY.md v3.0`（待 CEO 审批）  
**状态**: **P0 - Audit Log 企业接口**  

---

## 一、战略重定位（v3.0）

### 核心调整

| 维度 | 旧（v1.x） | 新（v3.0） |
|------|------------|------------|
| **产品定位** | AI 编程效率工具 | **AI 研发合规审查系统** |
| **目标客户** | 开发者（自下而上） | **企业安全/合规管理者（自上而下）** |
| **核心卖点** | 协同、上下文复用 | **治理、安全、合规审计** |
| **商业模式** | Freemium（SaaS） | **Enterprise First + 私有化部署** |

### 目标客户分层

| 梯队 | 客户 | 产品 | 部署方式 |
|------|------|------|----------|
| **第一梯队** | 金融机构、政务单位、国企 | AgentLog Enterprise | 私有化部署 |
| **第二梯队** | 互联网大厂、中大型企业 | AgentLog Pro | 团队版 |
| **第三梯队** | 中小开发者 | AgentLog Free | SaaS |

---

## 二、P0 紧急任务：Audit Log 企业接口

**战略价值**：企业市场敲门砖，v1.2（+6周）必须完成

### 2.1 技术方案

#### 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    AgentLog Enterprise                           │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐ │
│  │  MCP Server   │───▶│   Audit Log    │───▶│  Compliance    │ │
│  │  (会话捕获)    │    │   Engine       │    │  Report Gen   │ │
│  └───────────────┘    └───────────────┘    └───────────────┘ │
│         │                    │                      │           │
│         ▼                    ▼                      ▼           │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐ │
│  │  SQLite       │    │  Enterprise    │    │  Export       │ │
│  │  (本地存储)    │    │  API Server    │    │  (PDF/Excel)  │ │
│  └───────────────┘    └───────────────┘    └───────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

#### 数据模型扩展

```sql
-- 企业审计日志表
CREATE TABLE enterprise_audit_log (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  timestamp       DATETIME NOT NULL,
  user_id         TEXT NOT NULL,           -- 企业用户 ID
  user_name       TEXT,
  agent_source    TEXT NOT NULL,           -- opencode/cline/trae/...
  model_provider  TEXT NOT NULL,           -- deepseek/openai/qwen/...
  model_name      TEXT NOT NULL,           -- deepseek-v3/r1/qwen-max/...
  action_type     TEXT NOT NULL,           -- log_turn/log_intent/query/...
  content_hash    TEXT NOT NULL,           -- 内容哈希（完整性）
  ip_address      TEXT,                    -- 请求 IP
  workspace_path  TEXT,                    -- 工作区路径
  commit_hash     TEXT,                    -- 关联的 Git Commit
  metadata        JSON,                    -- 扩展字段
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 合规报告表
CREATE TABLE compliance_reports (
  id              TEXT PRIMARY KEY,
  report_type     TEXT NOT NULL,           -- weekly/monthly/incident/...
  period_start    DATETIME NOT NULL,
  period_end      DATETIME NOT NULL,
  generated_by    TEXT NOT NULL,           -- 报告生成者
  status          TEXT NOT NULL,           -- draft/approved/published
  content         JSON NOT NULL,           -- 报告内容
  exported_file   TEXT,                    -- 导出文件路径
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 用户操作追溯表
CREATE TABLE user_operations (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  operation_type  TEXT NOT NULL,           -- login/query/export/...
  target_resource TEXT,                    -- 操作的资源
  result          TEXT NOT NULL,           -- success/failure
  detail          JSON,
  timestamp       DATETIME NOT NULL
);
```

#### API 端点设计

| 端点 | 方法 | 描述 | 权限 |
|------|------|------|------|
| `/api/enterprise/audit/logs` | GET | 查询审计日志 | Admin |
| `/api/enterprise/audit/logs/:id` | GET | 获取单条日志详情 | Admin |
| `/api/enterprise/audit/export` | POST | 导出审计报告 | Admin |
| `/api/enterprise/compliance/report` | POST | 生成合规报告 | Admin |
| `/api/enterprise/compliance/report/:id` | GET | 获取报告详情 | Admin |
| `/api/enterprise/users` | GET | 获取企业用户列表 | Admin |
| `/api/enterprise/users/:id/activity` | GET | 获取用户活动记录 | Admin |
| `/api/enterprise/code-origin/:commit` | GET | 追溯代码 AI 来源 | Developer |

#### 核心功能

**1. 完整操作审计日志**
```json
{
  "id": "audit_20260401_001",
  "session_id": "sess_abc123",
  "timestamp": "2026-04-01T10:00:00Z",
  "user": {
    "id": "user_enterprise_001",
    "name": "张三",
    "department": "研发部"
  },
  "ai_interaction": {
    "agent_source": "trae",
    "model_provider": "deepseek",
    "model_name": "DeepSeek-R1",
    "prompt_tokens": 1500,
    "completion_tokens": 3000,
    "reasoning_content_length": 4500
  },
  "code_impact": {
    "files_modified": ["src/auth.ts", "src/middleware.ts"],
    "commit_hash": "a1b2c3d4",
    "lines_added": 150,
    "lines_deleted": 30
  },
  "compliance": {
    "data_classification": "internal",
    "requires_review": true,
    "reviewed_by": null
  }
}
```

**2. AI 代码来源追溯**
```json
{
  "commit_hash": "a1b2c3d4",
  "files": [
    {
      "file": "src/auth.ts",
      "ai_generated_lines": "45-120",
      "confidence": 0.95,
      "source_session": "sess_abc123",
      "model": "DeepSeek-R1",
      "timestamp": "2026-04-01T09:30:00Z",
      "user": "张三"
    }
  ],
  "compliance_status": "approved"
}
```

**3. 合规报告生成**
```json
{
  "report_id": "report_202604_w1",
  "type": "weekly",
  "period": "2026-03-25 ~ 2026-04-01",
  "summary": {
    "total_sessions": 156,
    "total_users": 23,
    "models_used": ["DeepSeek-V3", "DeepSeek-R1", "Qwen-Max"],
    "files_modified": 342,
    "commits": 89
  },
  "compliance_flags": [
    {
      "type": "sensitive_data_access",
      "count": 3,
      "details": "检测到访问敏感文件"
    }
  ],
  "generated_at": "2026-04-01T10:00:00Z",
  "generated_by": "system",
  "status": "draft"
}
```

### 2.2 子任务分解

| Task ID | 子任务 | 工时 | 依赖 |
|---------|--------|------|------|
| E1.1 | 数据库 schema 扩展（审计日志表） | 2h | - |
| E1.2 | Enterprise API Server 实现 | 8h | E1.1 |
| E1.3 | Audit Log 查询接口（分页/过滤） | 4h | E1.2 |
| E1.4 | 代码来源追溯算法 | 6h | E1.1 |
| E1.5 | 合规报告生成器 | 5h | E1.3 |
| E1.6 | PDF/Excel 导出功能 | 4h | E1.5 |
| E1.7 | 企业用户管理模块 | 4h | E1.2 |
| E1.8 | 权限控制（RBAC） | 5h | E1.7 |
| E1.9 | E2E 测试 | 6h | E1.1~E1.8 |
| E1.10 | 部署文档与运维手册 | 3h | E1.9 |

**P0 Audit Log 总工时**：~47h（约 6 周单人）

---

## 三、私有化部署架构设计

### 3.1 部署模式

```
┌─────────────────────────────────────────────────────────────────┐
│                    企业内网私有化部署                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────┐      ┌─────────────┐      ┌─────────────┐    │
│   │  VPN/专线   │─────▶│  AgentLog   │─────▶│  企业 GitLab │    │
│   │  (可选)     │      │  Enterprise │      │  /Gitea     │    │
│   └─────────────┘      └─────────────┘      └─────────────┘    │
│          │                   │                     │            │
│          │                   ▼                     │            │
│          │           ┌─────────────┐              │            │
│          │           │  SQLite     │◀─────────────┘            │
│          │           │  (本地存储)  │                           │
│          │           └─────────────┘                           │
│          │                   │                                 │
│          │                   ▼                                 │
│          │           ┌─────────────┐                           │
│          └──────────▶│  审计日志   │                           │
│                      │  (本地留存) │                           │
│                      └─────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 核心组件

| 组件 | 职责 | 部署要求 |
|------|------|----------|
| `agentlog-enterprise-server` | 主服务 | 2CPU/4GB 内存 |
| `agentlog-mcp` | 会话捕获代理 | 每开发者机器部署 |
| `agentlog-git-hook` | Commit 绑定 | Git Server 端钩子 |
| SQLite | 数据存储 | 加密存储 |
| Nginx/Traefik | 反向代理 + SSL | 标准 LB |

### 3.3 私有化部署检查清单

- [ ] Docker Compose 一键部署脚本
- [ ] Kubernetes Helm Chart
- [ ] 配置加密（敏感信息）
- [ ] 数据备份策略
- [ ] 监控告警（Prometheus + Grafana）
- [ ] 灾难恢复手册

---

## 四、国产大模型深度适配

### 4.1 优先级评估

| 模型 | 合作优先级 | 适配工作 | 战略价值 |
|------|------------|----------|----------|
| **DeepSeek R1** | ⭐⭐⭐⭐⭐ | 推理链完整捕获 + 可视化 | 官方推荐记忆层 |
| **DeepSeek V3** | ⭐⭐⭐⭐ | 标准 OpenAI 兼容 | 主力模型 |
| **Qwen Max** | ⭐⭐⭐⭐ | 通义千问 API 适配 | 阿里云生态 |
| **Kimi** | ⭐⭐⭐ | Moonshot API 适配 | 月之暗面生态 |

### 4.2 DeepSeek R1 深度适配方案

**核心目标**：成为 DeepSeek 官方推荐的 AI 编程记忆层

```typescript
// DeepSeek R1 推理链捕获增强
interface DeepSeekReasoningChain {
  session_id: string;
  model: "deepseek-r1";
  reasoning_steps: Array<{
    step: number;
    thought: string;          // 完整推理过程
    code_reference?: string;  // 引用的代码位置
    timestamp: string;
  }>;
  final_answer: string;
  dependencies: string[];    // 依赖的 session
  exported_to: string[];      // 导出到的 commit
}

// 可视化展示
interface DeepSeekR1Visualization {
  session_id: string;
  timeline: ReasoningTimelineItem[];
  code_map: CodeLocationMap;
  compliance_status: "pending" | "approved" | "flagged";
}
```

---

## 五、工作量估算 v3.0

### 5.1 P0 任务（6 周内完成）

| Task ID | 任务 | 工时 | 里程碑 |
|---------|------|------|--------|
| E1.1~E1.10 | Audit Log 企业接口 | 47h | Week 6 |
| T1~T3 | Trae IDE 支持 | 4h | Week 1 |
| M3 | MCP 稳定性（95%+） | 9h | Week 2 |

### 5.2 P1 任务（3 个月内）

| Task ID | 任务 | 工时 |
|---------|------|------|
| E2 | 私有化部署方案 | 20h |
| E3 | DeepSeek R1 深度适配 | 15h |
| D1~D2 | GitHub 文档优化 + Discussions | 4h |

### 5.3 P2 任务（6 个月）

| Task ID | 任务 | 工时 |
|---------|------|------|
| E4 | 私有化部署检查清单 | 30h |
| E5 | Gitee 插件 | 15h |
| E6 | 华为云/阿里云 OEM | 40h |

---

## 六、审批状态

| 版本 | 日期 | 审批状态 |
|------|------|----------|
| v1.2 | 2026-04-01 | ⏳ 待 CEO 审批 |
| v3.0 | 2026-04-01 | ⏳ **待 CEO 审批（紧急）** |

**CEO 审批印记**: ⏳ PENDING_APPROVAL_20260401_v3.0

---

**Architect 签署**: 🏗️ Architect  
**战略锚定**: 📋 STRATEGY.md v3.0（待 CEO 审批）
