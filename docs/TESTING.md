# AgentLog 测试说明文档

> 本文档面向开发者，涵盖**自动化测试**、**手工接口测试**、**VS Code 插件端到端测试**三个层次，并提供可直接执行的测试脚本和 curl 命令示例。

---

## 目录

1. [测试概览](#1-测试概览)
2. [前置条件](#2-前置条件)
3. [自动化测试（Backend）](#3-自动化测试backend)
4. [手工接口测试（curl 脚本）](#4-手工接口测试curl-脚本)
5. [模拟 AI 捕获上报](#5-模拟-ai-捕获上报)
6. [逐场景手工测试](#6-逐场景手工测试)
   - [场景 A：健康检查](#场景-a健康检查)
   - [场景 B：Session 完整生命周期](#场景-b-session-完整生命周期)
   - [场景 C：Commit 绑定工作流](#场景-c-commit-绑定工作流)
   - [场景 D：导出功能](#场景-d-导出功能)
   - [场景 E：Git Hook 安装与触发](#场景-e-git-hook-安装与触发)
7. [VS Code 插件手工测试](#7-vs-code-插件手工测试)
8. [测试数据速查表](#8-测试数据速查表)
9. [常见问题排查](#9-常见问题排查)

---

## 1. 测试概览

| 层次 | 工具 | 覆盖范围 | 运行时长 |
|------|------|----------|----------|
| 单元 + 集成（自动） | `node:test` + `tsx` | Backend 全部 API 端点（40 个用例） | ~500ms |
| 接口回归（手工脚本） | `bash` + `curl` | Backend 全部端点 + 异常分支 | ~15s |
| 模拟 AI 捕获 | `bash` + `curl` | Session 上报 + 验证完整链路 | ~3s |
| 插件端到端（手工） | VS Code Extension Host | 拦截器 / 侧边栏 / Webview / 命令 | 手工，约 20min |

---

## 2. 前置条件

### 2.1 环境要求

```bash
node --version   # >= 18.0.0（推荐 22.x）
pnpm --version   # >= 9.0.0
curl --version   # >= 7.x
jq --version     # 可选，用于 JSON 格式化输出；安装：brew install jq
git --version    # >= 2.x，用于 Git Hook 测试
```

### 2.2 激活 Node.js 环境

```bash
# 使用 nvm（推荐）
nvm use 22

# 验证
node --version   # 应输出 v22.x.x
pnpm --version   # 应输出 10.x.x
```

### 2.3 安装依赖并构建 shared 包

```bash
# 项目根目录
cd AgentLog

# 安装全部依赖（首次运行）
pnpm install

# 构建 shared 类型包（其他包依赖此包的 dist/）
pnpm build:shared
```

---

## 3. 自动化测试（Backend）

### 3.1 运行测试

```bash
# 方式一：通过 pnpm（推荐）
pnpm --filter @agentlog/backend test

# 方式二：直接运行（在 packages/backend 目录下）
cd packages/backend
node --import tsx --test test/integration.test.ts
```

### 3.2 预期输出

```
▶ Health Check
  ✔ GET /health 返回 200 和 status: ok (19ms)
  ✔ GET /api 返回 API 元信息 (2ms)
  ✔ GET /nonexistent 返回 404 (1ms)
✔ Health Check (61ms)

▶ Session CRUD
  ✔ POST /api/sessions 创建会话 → 返回 201 和完整实体 (15ms)
  ✔ POST /api/sessions 缺少必填字段 prompt → 400 (2ms)
  ✔ GET /api/sessions/:id 获取刚创建的会话 (1ms)
  ... (共 16 个用例)
✔ Session CRUD (45ms)

▶ Commit 绑定
  ... (共 9 个用例)
✔ Commit 绑定 (18ms)

▶ 导出（Export）
  ... (共 12 个用例)
✔ 导出（Export） (21ms)

ℹ tests 40
ℹ pass  40
ℹ fail  0
ℹ duration_ms 462
```

### 3.3 测试隔离说明

- 每个 `describe` 块启动独立的 Fastify 实例，监听随机端口
- SQLite 使用 `:memory:` 内存数据库，测试间完全隔离
- 无需启动真实后台进程，可在 CI 中直接运行

---

## 4. 手工接口测试（curl 脚本）

### 4.1 快速启动

```bash
# 步骤 1：在一个终端启动后台服务
pnpm --filter @agentlog/backend dev
# 输出：[AgentLog] 后台服务已启动：http://127.0.0.1:7892

# 步骤 2：在另一个终端运行测试脚本
bash scripts/test-backend.sh
```

### 4.2 脚本参数说明

```bash
# 自动启动后台 + 测试完毕后关闭（默认）
bash scripts/test-backend.sh

# 假设后台已在运行，仅跑测试（不启动也不关闭后台）
bash scripts/test-backend.sh --no-server

# 测试完毕后保持后台运行
bash scripts/test-backend.sh --keep

# 指定后台端口（后台需以同一端口启动）
bash scripts/test-backend.sh --no-server --port 7892
```

### 4.3 预期输出示例

```
╔══════════════════════════════════════════════╗
║   AgentLog Backend — curl 集成测试            ║
║   目标：http://127.0.0.1:7892               ║
╚══════════════════════════════════════════════╝

══════════════════════════════════════
  T1 · 健康检查 & 元信息
══════════════════════════════════════
✔  T1-1 GET /health 状态码 → HTTP 200
✔  T1-1 GET /health status字段 → .status = "ok"
✔  T1-2 GET /api 状态码 → HTTP 200
...

══════════════════════════════════════
  测试结果汇总
══════════════════════════════════════
  总计：58 项
  通过：58
  失败：0

  ✔ 全部通过！
```

### 4.4 给脚本添加执行权限

```bash
chmod +x scripts/test-backend.sh
chmod +x scripts/simulate-capture.sh
```

---

## 5. 模拟 AI 捕获上报

当没有 Cline/Cursor 等 AI 工具时，使用此脚本模拟"插件拦截到 AI 请求后向后台上报会话"的完整链路。

### 5.1 基本用法

```bash
# 前提：后台服务已运行
pnpm --filter @agentlog/backend dev &

# 上报 1 条 DeepSeek 会话（默认）
bash scripts/simulate-capture.sh

# 上报 1 条含 R1 推理过程的会话
bash scripts/simulate-capture.sh --reasoning

# 上报 5 条来自不同场景的会话
bash scripts/simulate-capture.sh --count 5

# 指定模型和来源
bash scripts/simulate-capture.sh --provider qwen --model qwen-max --source cursor

# 指定工作区路径（用于后续按工作区过滤测试）
bash scripts/simulate-capture.sh --workspace /path/to/your/project --count 3

# 查看详细请求/响应内容
bash scripts/simulate-capture.sh --verbose
```

### 5.2 支持的参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--provider` | `deepseek` | 模型提供商（deepseek/qwen/kimi/doubao/zhipu） |
| `--model` | `deepseek-r1` | 模型名称 |
| `--source` | `cline` | 调用来源（cline/cursor/continue/direct-api） |
| `--workspace` | 当前目录 | 工作区路径 |
| `--count` | `1` | 连续上报条数 |
| `--reasoning` | 关闭 | 是否包含 DeepSeek-R1 推理过程（`<think>` 格式） |
| `--port` | `7892` | 后台端口 |
| `--verbose` | 关闭 | 打印完整请求/响应 JSON |

### 5.3 上报后的验证

脚本执行成功后，会自动输出：
- 会话 ID（短格式）
- 当前数据库统计（总数、已绑定、未绑定、平均耗时）
- 后续操作的 curl 命令示例（绑定 Commit、更新标签、导出等）

---

## 6. 逐场景手工测试

> 以下所有 curl 命令均假设后台运行在 `http://127.0.0.1:7892`。

### 准备工作

```bash
# 启动后台（在独立终端）
pnpm --filter @agentlog/backend dev

# 确认后台就绪
curl http://127.0.0.1:7892/health
# 期望：{"status":"ok","version":"0.1.0",...}
```

---

### 场景 A：健康检查

**测试目标**：验证服务正常启动、API 入口可访问、404 处理正常。

```bash
# A-1：健康检查
curl -s http://127.0.0.1:7892/health | jq .

# 期望输出：
# {
#   "status": "ok",
#   "version": "0.1.0",
#   "timestamp": "2025-...",
#   "uptime": 5
# }

# A-2：API 元信息
curl -s http://127.0.0.1:7892/api | jq .

# 期望输出：
# {
#   "name": "AgentLog Backend",
#   "endpoints": { "sessions": "/api/sessions", ... }
# }

# A-3：404 处理
curl -s http://127.0.0.1:7892/nonexistent | jq .

# 期望输出：
# { "success": false, "error": "接口不存在：GET /nonexistent" }
```

**✅ 通过标准**：
- `/health` 返回 HTTP 200，`status` 字段为 `"ok"`
- `/api` 返回 HTTP 200，包含 `endpoints` 字段
- 不存在的路由返回 HTTP 404，`success` 为 `false`

---

### 场景 B：Session 完整生命周期

**测试目标**：验证会话的创建、读取、更新（标签/备注/Commit 绑定）、删除。

#### B-1：创建会话（含 DeepSeek-R1 推理过程）

```bash
SESSION=$(curl -s -X POST http://127.0.0.1:7892/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "deepseek",
    "model": "deepseek-r1",
    "source": "cline",
    "workspacePath": "/tmp/my-project",
    "prompt": "帮我用 TypeScript 实现一个带 TTL 的缓存类",
    "reasoning": "<think>\n分析需求：需要一个支持 TTL 过期的缓存。\n选用 Map 存储，过期时间戳附加到 value 上，get 时惰性检查。\n</think>",
    "response": "以下是 TTLCache 实现：\n```ts\nclass TTLCache<K, V> { ... }\n```",
    "affectedFiles": ["src/cache/TTLCache.ts"],
    "durationMs": 3500,
    "tags": ["缓存", "TypeScript"],
    "note": "DeepSeek 推荐用 Map，简单够用"
  }')

echo $SESSION | jq .

# 保存 session ID 供后续使用
SESSION_ID=$(echo $SESSION | jq -r '.data.id')
echo "SESSION_ID = $SESSION_ID"
```

**✅ 期望**：HTTP 201，响应体 `success: true`，`data.id` 非空，`data.reasoning` 包含 `<think>` 内容。

#### B-2：创建会话（参数校验 — 缺少 prompt）

```bash
curl -s -X POST http://127.0.0.1:7892/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "qwen",
    "model": "qwen-max",
    "source": "cursor",
    "workspacePath": "/tmp/test",
    "response": "some response",
    "durationMs": 100
  }' | jq .
```

**✅ 期望**：HTTP 400，`success: false`，`error` 包含"prompt"。

#### B-3：按 ID 查询会话

```bash
curl -s "http://127.0.0.1:7892/api/sessions/$SESSION_ID" | jq .
```

**✅ 期望**：HTTP 200，`data.id` 与 `SESSION_ID` 一致，`data.provider` 为 `deepseek`。

#### B-4：分页查询会话列表

```bash
# 查询第 1 页，每页 10 条
curl -s "http://127.0.0.1:7892/api/sessions?page=1&pageSize=10" | jq .

# 按关键词过滤
curl -s "http://127.0.0.1:7892/api/sessions?keyword=TTL" | jq .

# 按 provider 过滤
curl -s "http://127.0.0.1:7892/api/sessions?provider=deepseek" | jq .

# 按工作区过滤
curl -s "http://127.0.0.1:7892/api/sessions?workspacePath=/tmp/my-project" | jq .
```

**✅ 期望**：均返回 HTTP 200，响应包含 `data.data`（数组）、`data.total`、`data.page`。

#### B-5：查询统计信息

```bash
curl -s "http://127.0.0.1:7892/api/sessions/stats" | jq .

# 期望输出示例：
# {
#   "success": true,
#   "data": {
#     "total": 3,
#     "boundToCommit": 0,
#     "unbound": 3,
#     "avgDurationMs": 2800,
#     "byProvider": { "deepseek": 1, "qwen": 2 },
#     "bySource": { "cline": 2, "cursor": 1 }
#   }
# }
```

#### B-6：更新标签

```bash
curl -s -X PATCH "http://127.0.0.1:7892/api/sessions/$SESSION_ID/tags" \
  -H "Content-Type: application/json" \
  -d '{"tags": ["bugfix", "已验证", "缓存"]}' | jq .
```

**✅ 期望**：HTTP 200，`data.tags` 为 `["bugfix","已验证","缓存"]`。

#### B-7：更新备注

```bash
curl -s -X PATCH "http://127.0.0.1:7892/api/sessions/$SESSION_ID/note" \
  -H "Content-Type: application/json" \
  -d '{"note": "已在生产环境验证，Map 方案在单进程场景下稳定运行"}' | jq .
```

**✅ 期望**：HTTP 200，`data.note` 包含"生产环境"。

#### B-8：删除会话

```bash
# 先创建一个临时会话
TMP=$(curl -s -X POST http://127.0.0.1:7892/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "provider":"kimi","model":"moonshot-v1-8k","source":"direct-api",
    "workspacePath":"/tmp","prompt":"临时测试","response":"ok","durationMs":100
  }')
TMP_ID=$(echo $TMP | jq -r '.data.id')

# 删除
curl -s -X DELETE "http://127.0.0.1:7892/api/sessions/$TMP_ID" | jq .
# 期望：{"success": true}

# 验证已删除
curl -s "http://127.0.0.1:7892/api/sessions/$TMP_ID" | jq .
# 期望：HTTP 404，{"success": false, ...}
```

---

### 场景 C：Commit 绑定工作流

**测试目标**：验证会话与 Git Commit 的手动绑定、自动绑定、解绑流程。

#### 准备：创建两条会话

```bash
# 先多创建一条，用于批量绑定测试
SESSION2=$(curl -s -X POST http://127.0.0.1:7892/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "qwen",
    "model": "qwen-max",
    "source": "cursor",
    "workspacePath": "/tmp/my-project",
    "prompt": "给缓存类添加 TTL 统计功能",
    "response": "新增 getStats() 方法返回命中率。",
    "affectedFiles": ["src/cache/TTLCache.ts"],
    "durationMs": 1200,
    "tags": ["功能增强"]
  }')
SESSION2_ID=$(echo $SESSION2 | jq -r '.data.id')

COMMIT_HASH="a1b2c3d4e5f678901234567890abcdef12345678"
```

#### C-1：手动单条绑定（PATCH 方式）

```bash
curl -s -X PATCH "http://127.0.0.1:7892/api/sessions/$SESSION_ID/commit" \
  -H "Content-Type: application/json" \
  -d "{\"commitHash\": \"$COMMIT_HASH\"}" | jq .
```

**✅ 期望**：HTTP 200，`data.commitHash` 等于 `$COMMIT_HASH`。

#### C-2：批量绑定（POST /api/commits/bind）

```bash
curl -s -X POST http://127.0.0.1:7892/api/commits/bind \
  -H "Content-Type: application/json" \
  -d "{
    \"sessionIds\": [\"$SESSION_ID\", \"$SESSION2_ID\"],
    \"commitHash\": \"$COMMIT_HASH\",
    \"workspacePath\": \"/tmp/my-project\"
  }" | jq .
```

**✅ 期望**：HTTP 200，`data.sessionIds` 包含两个 ID，`data.commitHash` 正确。

#### C-3：查询 Commit 绑定记录

```bash
# 完整 hash 查询
curl -s "http://127.0.0.1:7892/api/commits/$COMMIT_HASH" | jq .

# 短 hash 前缀查询（前 8 位）
curl -s "http://127.0.0.1:7892/api/commits/${COMMIT_HASH:0:8}" | jq .

# 查询 Commit 关联的所有会话详情
curl -s "http://127.0.0.1:7892/api/commits/$COMMIT_HASH/sessions" | jq .

# 列出所有 Commit 绑定记录
curl -s "http://127.0.0.1:7892/api/commits/?page=1&pageSize=10" | jq .
```

**✅ 期望**：
- 完整/短 hash 查询均返回 HTTP 200，`data.commitHash` 正确
- `/sessions` 端点返回关联会话列表数组
- 列表接口返回分页格式

#### C-4：解绑会话

```bash
# 解绑单条会话（DELETE 方式）
curl -s -X DELETE "http://127.0.0.1:7892/api/commits/unbind/$SESSION_ID" | jq .
# 期望：{"success": true}

# 验证 commitHash 已清除
curl -s "http://127.0.0.1:7892/api/sessions/$SESSION_ID" | jq '.data.commitHash'
# 期望：null

# 对未绑定的会话再次解绑 → 应报错
curl -s -X DELETE "http://127.0.0.1:7892/api/commits/unbind/$SESSION_ID" | jq .
# 期望：HTTP 400，{"success": false, ...}
```

#### C-5：PATCH 方式解绑（传 null）

```bash
curl -s -X PATCH "http://127.0.0.1:7892/api/sessions/$SESSION2_ID/commit" \
  -H "Content-Type: application/json" \
  -d '{"commitHash": null}' | jq .
# 期望：HTTP 200，data.commitHash 为 null
```

---

### 场景 D：导出功能

**测试目标**：验证四种导出格式、日期过滤、工作区过滤、参数校验。

> **前提**：已通过场景 B/C 创建了若干会话。

#### D-1：获取支持的格式列表

```bash
curl -s http://127.0.0.1:7892/api/export/formats | jq .
# 期望：包含 weekly-report / pr-description / jsonl / csv 四种格式
```

#### D-2：导出 JSONL（原始数据）

```bash
curl -s -X POST http://127.0.0.1:7892/api/export \
  -H "Content-Type: application/json" \
  -d '{"format": "jsonl", "language": "zh"}' | jq .

# 只提取文本内容，查看每行是否是合法 JSON
curl -s -X POST http://127.0.0.1:7892/api/export \
  -H "Content-Type: application/json" \
  -d '{"format": "jsonl"}' \
  | jq -r '.data.content' | head -3
```

**✅ 期望**：每行是独立的 JSON 对象，包含 `id`、`prompt`、`provider` 等字段。

#### D-3：导出中文周报（Markdown）

```bash
curl -s -X POST http://127.0.0.1:7892/api/export \
  -H "Content-Type: application/json" \
  -d '{"format": "weekly-report", "language": "zh"}' \
  | jq -r '.data.content'
```

**✅ 期望**：输出 Markdown 文本，包含：
- `## AI 辅助开发周报` 标题
- `### 概览` 统计表格
- `### 交互详情` 按日期分组的会话记录
- DeepSeek-R1 的推理过程以 `<details>` 折叠展示

#### D-4：导出英文周报

```bash
curl -s -X POST http://127.0.0.1:7892/api/export \
  -H "Content-Type: application/json" \
  -d '{"format": "weekly-report", "language": "en"}' \
  | jq -r '.data.content'
```

**✅ 期望**：Markdown 文本以英文撰写，标题为 `## AI-Assisted Development Weekly Report`。

#### D-5：导出 PR / Code Review 说明

```bash
curl -s -X POST http://127.0.0.1:7892/api/export \
  -H "Content-Type: application/json" \
  -d '{"format": "pr-description", "language": "zh"}' \
  | jq -r '.data.content'
```

**✅ 期望**：包含 `## PR 说明`、`### 背景与目标`、`### 主要改动`、`### AI 推理摘要`（若有 reasoning）章节。

#### D-6：导出 CSV

```bash
curl -s -X POST http://127.0.0.1:7892/api/export \
  -H "Content-Type: application/json" \
  -d '{"format": "csv"}' \
  | jq -r '.data.content'
```

**✅ 期望**：第一行为 CSV 表头（含 `id`、`provider`、`model`、`prompt`、`hasReasoning` 等字段），其后每行为一条会话记录。

#### D-7：按日期范围导出

```bash
TODAY=$(date +%Y-%m-%d)
TOMORROW=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d '+1 day' +%Y-%m-%d)

curl -s -X POST http://127.0.0.1:7892/api/export \
  -H "Content-Type: application/json" \
  -d "{\"format\": \"jsonl\", \"startDate\": \"$TODAY\", \"endDate\": \"$TOMORROW\"}" \
  | jq '{sessionCount: .data.sessionCount, format: .data.format}'
```

**✅ 期望**：`sessionCount` 等于今天已创建的会话数量。

#### D-8：日期和格式参数校验

```bash
# startDate 晚于 endDate → 400
curl -s -X POST http://127.0.0.1:7892/api/export \
  -H "Content-Type: application/json" \
  -d '{"format": "jsonl", "startDate": "2030-01-01", "endDate": "2020-01-01"}' | jq .
# 期望：HTTP 400，success: false

# 无效日期格式 → 400
curl -s -X POST http://127.0.0.1:7892/api/export \
  -H "Content-Type: application/json" \
  -d '{"format": "jsonl", "startDate": "not-a-date"}' | jq .
# 期望：HTTP 400

# 不支持的格式 → 400
curl -s -X POST http://127.0.0.1:7892/api/export \
  -H "Content-Type: application/json" \
  -d '{"format": "pdf"}' | jq .
# 期望：HTTP 400
```

#### D-9：预览接口（截取前 50 行）

```bash
curl -s -X POST http://127.0.0.1:7892/api/export/preview \
  -H "Content-Type: application/json" \
  -d '{"format": "weekly-report", "language": "zh"}' \
  | jq '{sessionCount: .data.sessionCount, isTruncated: .data.isTruncated}'
```

**✅ 期望**：响应包含 `isTruncated` 字段（布尔值）。

---

### 场景 E：Git Hook 安装与触发

**测试目标**：验证 post-commit Hook 的注入、自动绑定触发、移除流程。

> **前提**：需要一个真实的 Git 仓库，且后台服务正在运行。

#### E-1：准备测试 Git 仓库

```bash
# 创建测试仓库
mkdir -p /tmp/agentlog-git-test
cd /tmp/agentlog-git-test
git init
git config user.email "test@example.com"
git config user.name "Test User"

# 创建初始提交（建立 HEAD）
echo "# Test" > README.md
git add README.md
git commit -m "init"
```

#### E-2：上报几条未绑定的会话

```bash
# 回到项目根目录，上报 2 条会话
bash AgentLog/scripts/simulate-capture.sh \
  --workspace /tmp/agentlog-git-test \
  --count 2

# 验证会话已存在且未绑定
curl -s "http://127.0.0.1:7892/api/sessions/unbound?workspacePath=/tmp/agentlog-git-test" | jq .
```

**✅ 期望**：返回 2 条未绑定会话。

#### E-3：安装 Git Hook

```bash
curl -s -X POST http://127.0.0.1:7892/api/commits/hook/install \
  -H "Content-Type: application/json" \
  -d '{"workspacePath": "/tmp/agentlog-git-test"}' | jq .
```

**✅ 期望**：HTTP 200，响应包含 `repoRootPath` 和 `currentBranch`。

验证钩子文件已写入：

```bash
cat /tmp/agentlog-git-test/.git/hooks/post-commit
# 期望：包含 "agentlog-hook" 标记和 curl 命令
```

#### E-4：触发 Hook（执行 git commit）

```bash
cd /tmp/agentlog-git-test

# 做一次修改并提交
echo "change $(date)" >> README.md
git add README.md
git commit -m "feat: 测试 AgentLog Git Hook 自动绑定"

# 等待 Hook 异步回调（约 1 秒）
sleep 2
```

验证会话已自动绑定到刚才的 Commit：

```bash
# 获取最新 Commit Hash
LATEST_HASH=$(git -C /tmp/agentlog-git-test rev-parse HEAD)
echo "最新 Commit: $LATEST_HASH"

# 查询该 Commit 的绑定信息
curl -s "http://127.0.0.1:7892/api/commits/$LATEST_HASH" | jq .

# 期望：sessionIds 包含之前上报的 2 条未绑定会话的 ID
```

**✅ 期望**：`data.sessionIds` 非空，`data.message` 为刚才的 commit message。

#### E-5：验证会话已更新 commitHash

```bash
# 查询未绑定会话（应已清空）
curl -s "http://127.0.0.1:7892/api/sessions/unbound?workspacePath=/tmp/agentlog-git-test" | jq .
# 期望：data 为空数组 []

# 随机查询一条之前的会话，确认 commitHash 已填入
curl -s "http://127.0.0.1:7892/api/sessions/stats?workspacePath=/tmp/agentlog-git-test" | jq .
# 期望：boundToCommit >= 2, unbound = 0
```

#### E-6：移除 Git Hook

```bash
curl -s -X DELETE http://127.0.0.1:7892/api/commits/hook/remove \
  -H "Content-Type: application/json" \
  -d '{"workspacePath": "/tmp/agentlog-git-test"}' | jq .
# 期望：{"success": true}

# 验证钩子已清除
cat /tmp/agentlog-git-test/.git/hooks/post-commit
# 期望：文件内容不再包含 "agentlog-hook"（或文件已被删除）
```

---

## 7. VS Code 插件手工测试

### 7.1 环境准备

```bash
# 步骤 1：构建插件
pnpm build:shared
pnpm --filter agentlog-vscode build

# 步骤 2：在单独终端启动后台（供插件连接）
pnpm --filter @agentlog/backend dev

# 步骤 3：用 VS Code 打开项目根目录
code AgentLog/
```

### 7.2 启动插件调试宿主

1. 在 VS Code 中按 **`F5`**（或菜单 → 运行 → 启动调试）
2. 选择 `Launch Extension`（若有多个配置）
3. 会弹出一个新的 **Extension Development Host** 窗口
4. 在新窗口中打开任意包含代码的文件夹

> 插件日志可在新窗口的 **输出面板**（`Ctrl+Shift+U`）→ 下拉选择 `AgentLog` 频道查看。

---

### 7.3 测试清单

#### ☐ T-EXT-01：插件激活与状态栏

| 步骤 | 操作 | 期望结果 |
|------|------|----------|
| 1 | 打开 Extension Development Host 窗口 | 右下角状态栏出现 `$(history) AgentLog` 图标 |
| 2 | 等待 3~5 秒（后台自动启动） | 状态栏变为 `$(record) AgentLog` 并显示捕获状态 |
| 3 | 点击状态栏图标 | 弹出消息框，显示后台在线状态和版本号 |
| 4 | 打开输出面板 → AgentLog 频道 | 可见"插件激活完成"和后台连接日志 |

---

#### ☐ T-EXT-02：侧边栏 TreeView

| 步骤 | 操作 | 期望结果 |
|------|------|----------|
| 1 | 点击活动栏的 AgentLog 图标（或 `Ctrl+Shift+P` → `AgentLog: 打开交互日志面板`） | 侧边栏展开，显示「AI 交互记录」和「Commit 绑定」两个视图 |
| 2 | 若后台已有数据 | 「AI 交互记录」视图按日期分组显示会话列表 |
| 3 | 若无数据 | 显示欢迎文案和「启动后台服务」按钮链接 |
| 4 | 点击视图标题栏的刷新按钮 | 列表重新加载，显示最新数据 |
| 5 | 将鼠标悬停在某条会话上 | Tooltip 显示 Provider、Model、耗时、Prompt 预览等信息 |

---

#### ☐ T-EXT-03：AI 请求拦截（使用 simulate-capture.sh 模拟）

> 由于拦截器通过 Monkey-patch Node.js http 模块实现，在 Extension Development Host 进程中有效。  
> 使用模拟脚本从**外部**向后台上报会话，验证侧边栏能正确接收并刷新。

```bash
# 在终端连续上报 3 条会话
bash scripts/simulate-capture.sh --count 3 --reasoning
```

| 步骤 | 操作 | 期望结果 |
|------|------|----------|
| 1 | 执行上方脚本 | 终端输出 3 条绿色"✔ 会话已上报"消息 |
| 2 | 观察 VS Code 侧边栏 | 自动刷新，新增 3 条会话记录（最多 30 秒内） |
| 3 | 观察状态栏 | `$(record) AgentLog (3)` 数字递增 |

---

#### ☐ T-EXT-04：会话详情 Webview

| 步骤 | 操作 | 期望结果 |
|------|------|----------|
| 1 | 在侧边栏点击任意一条会话 | 右侧打开会话详情面板 |
| 2 | 检查详情面板顶部 | 显示 Provider、Model、耗时、Commit 状态徽章 |
| 3 | 检查"Prompt"区域 | 显示完整 Prompt 文本 |
| 4 | 若会话含推理 | 显示"💡 推理过程"可折叠区域，内容为 `<think>...</think>` 正文 |
| 5 | 在"标签 & 备注"区域输入新标签 `测试标签` 并回车 | 标签徽章即时更新 |
| 6 | 在备注文本框输入内容并点击区域外（blur） | 备注自动保存 |
| 7 | 在"Commit 绑定"区域输入 `abc1234` 并点击"绑定" | 顶部 Commit 徽章从"未绑定"变为 `✓ abc1234` |
| 8 | 点击"复制回复"按钮 | 剪贴板内容更新，右下角弹出"已复制到剪贴板"通知 |
| 9 | 点击"在编辑器打开"按钮 | 新建临时文件，内容为 AI 回复文本 |

---

#### ☐ T-EXT-05：仪表板（Dashboard Webview）

| 步骤 | 操作 | 期望结果 |
|------|------|----------|
| 1 | 命令面板 → `AgentLog: 打开交互日志面板` | 打开全屏仪表板 |
| 2 | 检查顶部统计卡片 | 显示总会话数、已绑定、未绑定、平均耗时 |
| 3 | 检查状态指示点 | 绿点 + "后台在线" |
| 4 | 在搜索框输入关键词并回车 | 表格数据按关键词过滤 |
| 5 | 点击"导出周报"按钮 | 弹出进度通知，完成后在右侧打开 Markdown 文件 |
| 6 | 点击"导出 PR 说明"按钮 | 同上，内容不同 |
| 7 | 点击表格中某行的"详情"按钮 | 侧边打开该会话的详情面板 |
| 8 | 点击"删除"按钮 | 弹出确认对话框，确认后该行从表格消失 |

---

#### ☐ T-EXT-06：命令面板功能

在 Extension Development Host 中按 `Ctrl+Shift+P`，逐一测试以下命令：

| 命令 | 期望结果 |
|------|----------|
| `AgentLog: 开始捕获 AI 交互` | 状态栏变为"捕获中"样式，输出面板记录"拦截器已激活" |
| `AgentLog: 停止捕获 AI 交互` | 状态栏恢复普通样式 |
| `AgentLog: 导出本周 AI 开发周报` | 弹出时间范围选择 → 选择"本周" → 新建 Markdown 文件 |
| `AgentLog: 导出 PR / Code Review 说明` | 弹出时间范围选择 → 完成后新建 Markdown 文件 |
| `AgentLog: 安装 Git post-commit 钩子` | 弹出成功通知，`.git/hooks/post-commit` 文件被创建 |
| `AgentLog: 移除 Git post-commit 钩子` | 弹出确认对话框 → 确认后钩子脚本被清理 |
| `AgentLog: 查看后台服务状态` | 弹出对话框，显示版本、运行时间；提供"打开仪表板"和"停止服务"选项 |
| `AgentLog: 刷新会话列表` | 侧边栏会话列表立即重新加载 |

---

#### ☐ T-EXT-07：设置项生效

1. 打开 VS Code 设置（`Ctrl+,`），搜索 `agentlog`
2. 逐项验证设置项：

| 设置项 | 修改为 | 验证方式 |
|--------|--------|----------|
| `agentlog.debug` | `true` | 输出面板出现 `[DEBUG]` 前缀日志 |
| `agentlog.autoCapture` | `false` | 状态栏显示普通样式（非捕获中） |
| `agentlog.backendUrl` | `http://localhost:7892` | 服务正常连接（与默认等效） |
| `agentlog.exportLanguage` | `en` | 导出周报命令生成英文内容 |

---

#### ☐ T-EXT-08：后台离线处理

| 步骤 | 操作 | 期望结果 |
|------|------|----------|
| 1 | 停止后台进程（Ctrl+C） | 状态栏在 10~30 秒内变为 `$(warning) AgentLog 离线`（黄底） |
| 2 | 点击状态栏"离线"图标 | 弹出"后台服务未连接"警告，提供"立即启动"按钮 |
| 3 | 刷新侧边栏 | 显示"后台服务未启动，点击此处启动"错误节点 |
| 4 | 重新启动后台 | 状态栏自动恢复为正常/捕获状态 |

---

## 8. 测试数据速查表

### 8.1 有效 Provider / Model 组合

| Provider | 示例 Model | 说明 |
|----------|-----------|------|
| `deepseek` | `deepseek-r1`, `deepseek-v3`, `deepseek-chat` | 支持 reasoning 字段 |
| `qwen` | `qwen-max`, `qwen-plus`, `qwen-turbo` | 阿里云通义千问 |
| `kimi` | `moonshot-v1-8k`, `moonshot-v1-32k` | 月之暗面 Kimi |
| `doubao` | `doubao-pro-32k`, `doubao-lite-4k` | 字节豆包 |
| `zhipu` | `glm-4`, `glm-4-air` | 智谱 ChatGLM |
| `openai` | `gpt-4o`, `gpt-4-turbo` | OpenAI（兼容模式） |
| `ollama` | `llama3`, `qwen2.5`, `deepseek-r1:7b` | 本地 Ollama |
| `unknown` | 任意 | 兜底值 |

### 8.2 有效 Source 值

| Source | 说明 |
|--------|------|
| `cline` | Cline VS Code 插件 |
| `cursor` | Cursor IDE |
| `continue` | Continue 插件 |
| `copilot` | GitHub Copilot |
| `direct-api` | 直接 API 调用 |
| `unknown` | 未识别来源 |

### 8.3 导出格式参数

| format | language | Content-Type 返回 |
|--------|----------|-------------------|
| `weekly-report` | `zh` / `en` | `text/markdown` |
| `pr-description` | `zh` / `en` | `text/markdown` |
| `jsonl` | 无影响 | `application/x-ndjson` |
| `csv` | 无影响 | `text/csv` |

### 8.4 常用 curl 速查

```bash
# 查看所有会话（最新 20 条）
curl -s "http://127.0.0.1:7892/api/sessions" | jq '.data.data[] | {id: .id[0:8], model, prompt: .prompt[0:40]}'

# 查看统计
curl -s "http://127.0.0.1:7892/api/sessions/stats" | jq .data

# 查看所有 Commit 绑定
curl -s "http://127.0.0.1:7892/api/commits/" | jq '.data.data[] | {hash: .commitHash[0:8], sessions: (.sessionIds | length), message}'

# 导出并保存为文件
curl -s -X POST http://127.0.0.1:7892/api/export \
  -H "Content-Type: application/json" \
  -d '{"format":"weekly-report","language":"zh"}' \
  | jq -r '.data.content' > ~/weekly-report.md

# 清空测试数据（删除 90 天前的记录；或直接删库）
rm -f ~/.agentlog/agentlog.db
```

---

## 9. 常见问题排查

### ❓ pnpm install 报 Node.js 版本错误

```
ERROR: This version of pnpm requires at least Node.js v16.14
```

**解决**：
```bash
nvm use 22        # 或 nvm use 20 / nvm use 18
node --version    # 确认 >= 18
pnpm install
```

---

### ❓ better-sqlite3 编译失败

```
node_modules/.pnpm/better-sqlite3@9.x.x/...  Running install script, failed
```

**解决**：

```bash
# 方式一：重新允许构建（pnpm v9+）
pnpm approve-builds

# 方式二：手动重建
cd node_modules/.pnpm/better-sqlite3*/node_modules/better-sqlite3
node-pre-gyp install --fallback-to-build

# 方式三：检查 Xcode Command Line Tools（macOS）
xcode-select --install
```

---

### ❓ 后台启动后端口已被占用

```
Error: listen EADDRINUSE :::7892
```

**解决**：
```bash
# 查找占用端口的进程
lsof -i :7892

# 终止该进程
kill -9 <PID>

# 或使用其他端口
AGENTLOG_PORT=7893 pnpm --filter @agentlog/backend dev
# 同时修改设置：agentlog.backendUrl = "http://localhost:7893"
```

---

### ❓ 测试脚本报 `curl: (7) Failed to connect`

**原因**：后台服务未启动或端口不对。

**解决**：
```bash
# 确认后台运行
curl http://127.0.0.1:7892/health

# 若用了非默认端口
bash scripts/test-backend.sh --no-server --port 7893
```

---

### ❓ `jq` 未安装导致断言失败

脚本提供了 `grep/sed` 兜底逻辑，但复杂断言可能不准确。  
**建议安装 jq**：

```bash
brew install jq       # macOS
apt install jq        # Ubuntu/Debian
winget install jqlang.jq  # Windows
```

---

### ❓ VS Code 插件激活后状态栏一直显示"离线"

**排查步骤**：

1. 确认后台已启动：`curl http://127.0.0.1:7892/health`
2. 检查配置：VS Code 设置 → `agentlog.backendUrl` 是否为 `http://localhost:7892`
3. 查看插件输出日志：输出面板 → `AgentLog` 频道
4. 尝试手动启动：命令面板 → `AgentLog: 启动本地后台服务`

---

### ❓ Git Hook 安装后 commit 未触发自动绑定

**排查步骤**：

1. 确认钩子文件存在且可执行：
   ```bash
   ls -la .git/hooks/post-commit
   cat .git/hooks/post-commit
   ```
2. 确认后台正在运行：`curl http://127.0.0.1:7892/health`
3. 手动触发钩子测试：
   ```bash
   bash .git/hooks/post-commit
   ```
4. 检查 curl 是否可用：`which curl`

---

### ❓ 自动化测试报 `Cannot find module '@agentlog/shared'`

**原因**：`shared` 包未构建。

**解决**：
```bash
pnpm build:shared
# 然后重新运行测试
pnpm --filter @agentlog/backend test
```

---

## 附录：测试文件索引

| 文件 | 类型 | 说明 |
|------|------|------|
| `packages/backend/test/integration.test.ts` | 自动化（node:test） | 40 个后台集成用例，使用内存 DB |
| `scripts/test-backend.sh` | Shell 脚本 | 58 个 curl 手工接口测试，含完整 pass/fail 统计 |
| `scripts/simulate-capture.sh` | Shell 脚本 | 模拟 AI 会话上报，支持多种参数组合 |
| `docs/TESTING.md` | 文档 | 本文件，完整测试说明 |

---

*最后更新：由 AgentLog 开发团队维护*