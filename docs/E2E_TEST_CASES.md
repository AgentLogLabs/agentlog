# AgentLog E2E Test Cases

> 基于 `AGENTLOG_SPEC.md` v2.0 三条核心业务流（Flow A / B / C）及数据模型设计的端到端测试用例。
> 测试覆盖：MCP 主动记录 → Git Hook 自动绑定 → 上下文复活，以及各流程的异常与边界情况。

---

## 0. 测试环境与约定

| 项 | 说明 |
|---|---|
| 后端启动方式 | Fastify 实例监听随机端口，SQLite 使用 `:memory:` 内存数据库 |
| HTTP 客户端 | Node.js 内置 `fetch`（Node >= 18） |
| 测试框架 | `node:test` + `node:assert/strict` |
| 测试隔离 | 每个 Suite 独立的 Fastify + SQLite 实例，Suite 结束后 `app.close()` + `closeDatabase()` |
| 时间格式 | ISO 8601（`2026-03-25T12:00:00.000Z`） |
| 工作区路径 | 统一使用 `/tmp/e2e-test-project` |

### 公共测试数据（Fixture）

```typescript
const WORKSPACE = "/tmp/e2e-test-project";

const SESSION_FIXTURE = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  source: "cline",
  workspacePath: WORKSPACE,
  prompt: "帮我给 getUserById 加上 Redis 缓存",
  reasoning: "<think>需要引入 ioredis，在查询前检查缓存...</think>",
  response: "已完成，以下是修改后的代码...",
  affectedFiles: ["src/user/service.ts", "src/user/cache.ts"],
  durationMs: 4500,
  tags: ["缓存", "优化"],
};

const COMMIT_FIXTURE = {
  commitHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  message: "feat: add Redis cache for getUserById",
  authorName: "test-user",
  authorEmail: "test@example.com",
  changedFiles: ["src/user/service.ts", "src/user/cache.ts"],
  workspacePath: WORKSPACE,
};
```

---

## 1. Flow A: MCP Write Path（主动记录）

> 对应 Spec §4.1 — Agent 通过 MCP/API 主动上报工作会话，创建 Dangling Session（`commit_hash = NULL`）。

### Suite 1.1: Session 创建（MCP 写入核心路径）

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| A-001 | 完整字段创建 Session | 无 | `POST /api/sessions` 提交 `SESSION_FIXTURE` | 返回 201；`success: true`；`data.id` 非空；`data.commitHash` 为 `undefined/null`（Dangling State）；所有字段值与请求一致 | P0 |
| A-002 | 最小字段创建 Session | 无 | `POST /api/sessions` 仅提交 `provider`, `model`, `workspacePath`, `prompt`, `response` | 返回 201；缺省字段取默认值：`source="unknown"`, `durationMs=0`, `tags=[]`, `affectedFiles=[]`, `reasoning=null` | P0 |
| A-003 | 缺少必填字段 prompt | 无 | `POST /api/sessions` 不传 `prompt` | 返回 400；`success: false`；包含错误信息 | P0 |
| A-004 | 缺少必填字段 response | 无 | `POST /api/sessions` 不传 `response` | 返回 400；`success: false` | P0 |
| A-005 | 缺少必填字段 provider | 无 | `POST /api/sessions` 不传 `provider` | 返回 400；`success: false` | P0 |
| A-006 | 缺少必填字段 model | 无 | `POST /api/sessions` 不传 `model` | 返回 400；`success: false` | P0 |
| A-007 | 缺少必填字段 workspacePath | 无 | `POST /api/sessions` 不传 `workspacePath` | 返回 400；`success: false` | P0 |
| A-008 | 创建时 commitHash 强制为空 | 无 | `POST /api/sessions` 即使传入 `commitHash: "abc123"`，也不应被接受或应被忽略 | 返回 201；`data.commitHash` 为 `undefined/null`（确保新建 Session 始终为 Dangling 状态） | P1 |
| A-009 | affectedFiles 为非数组类型 | 无 | `POST /api/sessions` 传 `affectedFiles: "not-an-array"` | 返回 400 或自动转换为 `["not-an-array"]` | P2 |
| A-010 | 特殊字符处理 | 无 | `POST /api/sessions` 中 `prompt` 包含中文、emoji、换行符、SQL 注入字符串 | 返回 201；数据完整存储且回显一致 | P1 |

### Suite 1.2: 逐轮对话记录（Transcript 追加）

> MCP `log_turn` 工具的底层行为：首次调用创建 Session，后续追加 transcript。

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| A-020 | 追加 user+assistant 对话轮 | Session S1 已创建 | `PATCH /api/sessions/:id/transcript` 传 `turns: [{role:"user", content:"..."}, {role:"assistant", content:"..."}]` | 返回 200；`data.transcript` 包含追加的 2 条记录 | P0 |
| A-021 | 追加 tool 角色消息 | Session S1 已创建 | `PATCH /api/sessions/:id/transcript` 传 `turns: [{role:"tool", content:"执行结果...", toolName:"bash", toolInput:"ls -la"}]` | 返回 200；`data.transcript` 中包含 tool 角色记录，`toolName` 和 `toolInput` 字段保留 | P1 |
| A-022 | 追加时更新 tokenUsage | Session S1 已创建 | `PATCH /api/sessions/:id/transcript` 传 `turns: [...]` 及 `tokenUsage: {inputTokens:500, outputTokens:200}` | 返回 200；`data.tokenUsage` 已更新为传入值 | P1 |
| A-023 | 对不存在的 Session 追加 | 无 | `PATCH /api/sessions/nonexistent-id/transcript` | 返回 404 | P1 |
| A-024 | 多次追加保持顺序 | Session S1 已有 2 条 transcript | 再追加 2 条 | `data.transcript.length >= 4`；顺序与追加顺序一致 | P0 |

### Suite 1.3: Intent 写回

> MCP `log_intent` 工具的底层行为：任务完成后写回 response 和 affectedFiles。

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| A-030 | 写回 response 和 affectedFiles | Session S1 已创建（含 transcript） | `PATCH /api/sessions/:id/intent` 传 `{response: "任务完成", affectedFiles: ["a.ts"]}` | 返回 200；`data.response` 已更新；`data.affectedFiles` 已更新；`data.reasoning` 从 transcript 自动生成 | P0 |
| A-031 | 对不存在的 Session 写回 | 无 | `PATCH /api/sessions/nonexistent-id/intent` | 返回 404 | P1 |

---

## 2. Flow B: Git Hook Bind Path（自动绑定）

> 对应 Spec §4.2 — `git commit` 触发 Hook，Backend 将 Dangling Sessions 绑定到 Commit。

### Suite 2.1: POST /api/commits/hook（Post-Commit Hook 入口）

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| B-001 | 有游离 Session 时自动绑定 | 已创建 2 个 Dangling Session（同 workspacePath） | `POST /api/commits/hook` 提交 `COMMIT_FIXTURE` | 返回 200/201；`commit_bindings` 表新增一条记录，`sessionIds` 包含这 2 个 Session ID；对应 `agent_sessions` 的 `commit_hash` 已更新为 `COMMIT_FIXTURE.commitHash` | P0 |
| B-002 | 无游离 Session 时兜底创建 | 无 Dangling Session | `POST /api/commits/hook` 提交 `COMMIT_FIXTURE`（使用新 hash） | 返回 200/201；应创建一条兜底 Session 并绑定（如果兜底 LLM 已配置），或仅创建空绑定 | P0 |
| B-003 | 绑定后双表一致性 | 已创建 3 个 Dangling Session | `POST /api/commits/hook` | 验证：(1) `GET /api/commits/:hash` 的 `sessionIds` 包含 3 个 ID；(2) 每个 Session 的 `GET /api/sessions/:id` 的 `commitHash` 均为当前 hash | P0 |
| B-004 | 不同 workspacePath 隔离 | workspace A 有 2 个 Dangling，workspace B 有 1 个 Dangling | `POST /api/commits/hook` 仅指定 workspace A | 仅 workspace A 的 2 个 Session 被绑定；workspace B 的 Session 仍为 Dangling | P0 |
| B-005 | 重复 commitHash 处理 | 已执行过一次 hook 绑定（hash X） | 再次对同一 hash X 调用 hook | 应更新已有 binding（追加新的 sessionIds）或返回冲突错误，不应产生重复记录 | P1 |
| B-006 | 缺少必填参数 commitHash | 无 | `POST /api/commits/hook` 不传 `commitHash` | 返回 400 | P1 |

### Suite 2.2: POST /api/commits/bind（手动批量绑定）

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| B-010 | 批量绑定 2 个 Session | 已创建 Session S1, S2（Dangling） | `POST /api/commits/bind` 传 `{sessionIds: [S1, S2], commitHash: "..."}` | 返回 200；`data.sessionIds` 包含 S1, S2；`data.commitHash` 正确 | P0 |
| B-011 | 绑定不存在的 Session → 404 | 无 | `POST /api/commits/bind` 传不存在的 sessionId | 返回 404；`success: false` | P0 |
| B-012 | 绑定后 Session commitHash 已更新 | B-010 完成 | `GET /api/sessions/:S1` | `data.commitHash` 等于绑定时传入的 hash | P0 |

### Suite 2.3: Commit 查询与解绑

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| B-020 | 按完整 hash 查询 binding | 已绑定 commit X | `GET /api/commits/:fullHash` | 返回 200；`data.commitHash`, `data.sessionIds`, `data.message` 等字段正确 | P0 |
| B-021 | 按短 hash 前缀查询 | 已绑定 commit X (hash=feed1234abcd) | `GET /api/commits/feed1234` | 返回 200；匹配到完整 hash 的记录 | P1 |
| B-022 | 不存在的 hash → 404 | 无 | `GET /api/commits/0000000000` | 返回 404；`success: false` | P0 |
| B-023 | 列出所有 bindings（分页） | 已绑定多个 commit | `GET /api/commits?page=1&pageSize=10` | 返回 200；`data.data` 为数组；`data.total` >= 预期数量 | P1 |
| B-024 | 按 workspacePath 过滤 bindings | 多个 workspace 有绑定 | `GET /api/commits?workspacePath=/tmp/e2e-test-project` | 仅返回指定 workspace 的绑定 | P1 |
| B-025 | 解绑单条 Session | Session S1 已绑定到 commit X | `DELETE /api/commits/unbind/:S1` | 返回 200；`GET /api/sessions/:S1` 的 `commitHash` 为 `undefined`；`GET /api/commits/:X` 的 `sessionIds` 不再包含 S1 | P0 |
| B-026 | 解绑未绑定的 Session → 400 | Session S1 未绑定 | `DELETE /api/commits/unbind/:S1` | 返回 400；`success: false` | P1 |
| B-027 | 查询 commit 关联的所有 sessions | commit X 绑定了 S1, S2 | `GET /api/commits/:hash/sessions` | 返回 200；数组包含 S1, S2 的完整 Session 数据 | P0 |

---

## 3. Flow C: Context Resume Path（上下文复活）

> 对应 Spec §4.3 — 用户在 VS Code 侧边栏回溯历史，提取 Session 数据用于上下文复活。

### Suite 3.1: 未提交会话查询（Uncommitted / Dangling）

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| C-001 | 查询指定 workspace 的 Dangling Sessions | 已创建 3 个 Dangling Session（同 workspace） | `GET /api/sessions/unbound?workspacePath=/tmp/e2e-test-project` | 返回 200；数组长度 >= 3；每条 `commitHash` 为 undefined/null | P0 |
| C-002 | 不同 workspace 隔离 | workspace A 有 Dangling，workspace B 无 | `GET /api/sessions/unbound?workspacePath=<B>` | 返回 200；数组长度为 0 | P0 |
| C-003 | 缺少 workspacePath → 400 | 无 | `GET /api/sessions/unbound` | 返回 400；`success: false` | P0 |
| C-004 | 绑定后不再出现在 unbound 列表 | Session S1 为 Dangling | 绑定 S1 到 commit → 再查 unbound | S1 不在 unbound 结果中 | P0 |

### Suite 3.2: Session 详情查看（Reasoning + Transcript）

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| C-010 | 查看完整 Session 详情 | Session S1 含 reasoning, transcript | `GET /api/sessions/:S1` | 返回 200；包含 `reasoning`, `prompt`, `response`, `transcript`, `affectedFiles`, `tokenUsage` 等完整字段 | P0 |
| C-011 | transcript 包含多轮对话 | Session S1 已追加多轮 transcript | `GET /api/sessions/:S1` | `data.transcript` 为数组，每条含 `role`, `content`；顺序正确 | P0 |
| C-012 | reasoning 字段为 null 时正常返回 | Session S1 创建时未传 reasoning | `GET /api/sessions/:S1` | 返回 200；`data.reasoning` 为 null 或 undefined，不报错 | P1 |

### Suite 3.3: Commit 上下文生成（Context Resume 数据源）

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| C-020 | 生成 Commit 上下文文档（Markdown） | commit X 绑定了 2 个 Session | `GET /api/commits/:hash/context?format=markdown` | 返回 200；内容为 Markdown 格式；包含 commit message, session prompt/reasoning/response | P0 |
| C-021 | 生成 Commit 上下文文档（JSON） | commit X 绑定了 Session | `GET /api/commits/:hash/context?format=json` | 返回 200；内容为合法 JSON | P1 |
| C-022 | 生成 Commit 解释摘要 | commit X 绑定了 Session | `GET /api/commits/:hash/explain?language=zh` | 返回 200；包含 `overallSummary`, `sessions` 数组 | P1 |
| C-023 | 无绑定 Session 的 commit → 适当处理 | commit X 无关联 Session | `GET /api/commits/:hash/context` | 返回 200 但内容为空/提示无 Session；或返回 404 | P2 |

### Suite 3.4: 上下文复活格式化（Resume Context）

> 验证 Session 数据可被正确提取和格式化为上下文 Prompt。
> 注：实际的剪贴板写入由 VS Code Extension 完成，后端仅提供数据。

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| C-030 | Session 数据完整性验证 | Session S1 含完整字段 | `GET /api/sessions/:S1`，在客户端组装 Resume Prompt | 返回的 `prompt`, `reasoning`, `response`, `transcript`, `affectedFiles` 均非空，可格式化为 `【历史 AI 上下文复活】\n原始任务：{prompt}\n历史推理：{reasoning}\n...` | P0 |
| C-031 | 仅有 prompt+response 的最小 Session | Session S1 仅含必填字段 | `GET /api/sessions/:S1` | `prompt` 和 `response` 非空，`reasoning` 可为 null；仍能生成有效 Resume Prompt | P1 |

---

## 4. 跨 Flow 端到端场景（E2E 全链路）

> 将 Flow A → B → C 串联为完整业务场景。

### Suite 4.1: 完整生命周期

| TC-ID | 用例名称 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|--------|
| E2E-001 | MCP 记录 → Hook 绑定 → 查看上下文 | 1. `POST /api/sessions` 创建 Dangling Session S1<br>2. `PATCH /api/sessions/:S1/transcript` 追加 3 轮对话<br>3. `POST /api/commits/hook` 模拟 git commit<br>4. `GET /api/commits/:hash` 验证绑定<br>5. `GET /api/sessions/:S1` 验证 commitHash<br>6. `GET /api/commits/:hash/context` 获取上下文 | 每一步均成功；S1 从 Dangling 变为 Bound；上下文文档包含 S1 的 prompt/reasoning/response | P0 |
| E2E-002 | 多 Session → 单 Commit 绑定 → 批量查看 | 1. 创建 Session S1, S2, S3（同 workspace，均 Dangling）<br>2. `POST /api/commits/hook` 提交 commit<br>3. `GET /api/commits/:hash` 验证 3 个 sessionIds<br>4. `GET /api/commits/:hash/sessions` 获取 3 个完整 Session<br>5. `GET /api/sessions/unbound?workspacePath=...` 验证为空 | 三个 Session 全部绑定；unbound 列表清空；commit context 包含三个 Session | P0 |
| E2E-003 | 跨 workspace 隔离完整链路 | 1. workspace A 创建 S1, S2<br>2. workspace B 创建 S3<br>3. 对 workspace A 执行 hook commit<br>4. 验证 S1, S2 已绑定，S3 仍 Dangling<br>5. 对 workspace B 执行 hook commit<br>6. 验证 S3 已绑定 | 两个 workspace 互不影响；各自绑定正确 | P0 |
| E2E-004 | 解绑后重新绑定 | 1. 创建 S1 并绑定到 commit X<br>2. `DELETE /api/commits/unbind/:S1` 解绑<br>3. 验证 S1 回到 Dangling<br>4. 对新 commit Y 执行 hook<br>5. 验证 S1 绑定到 commit Y | S1 先绑定 X → 解绑 → 绑定 Y；全程数据一致 | P1 |
| E2E-005 | 大批量 Session 绑定性能 | 1. 循环创建 50 个 Dangling Session<br>2. `POST /api/commits/hook` 一次性绑定<br>3. `GET /api/commits/:hash` 验证 sessionIds 数量 | 绑定成功；`sessionIds.length === 50`；响应时间 < 5s | P2 |

### Suite 4.2: MCP 工具级联（log_turn → log_intent → 绑定）

| TC-ID | 用例名称 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|--------|
| E2E-010 | 模拟完整 MCP 交互流程 | 1. `POST /api/sessions` 创建 Session（模拟 `log_turn` 首次调用）<br>2. `PATCH /api/sessions/:id/transcript` 追加 user 消息<br>3. `PATCH /api/sessions/:id/transcript` 追加 assistant 回复<br>4. `PATCH /api/sessions/:id/transcript` 追加 tool 调用<br>5. `PATCH /api/sessions/:id/intent` 写回最终 response 和 affectedFiles<br>6. 验证 Session 的 reasoning 从 transcript 自动生成<br>7. `POST /api/commits/hook` 执行绑定<br>8. `GET /api/commits/:hash/context` 获取上下文 | 完整流程无报错；transcript 保留所有轮次；reasoning 自动生成；绑定成功；上下文可提取 | P0 |

---

## 5. 数据查询与过滤

> 对应 Spec §3 数据模型及 MCP `query_historical_interaction` 工具。

### Suite 5.1: 多维过滤

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| Q-001 | keyword 搜索 prompt | 多条 Session，prompt 含不同关键词 | `GET /api/sessions?keyword=Redis` | 仅返回 prompt/response/note 包含 "Redis" 的 Session | P0 |
| Q-002 | keyword 搜索 response | 同上 | `GET /api/sessions?keyword=缓存` | 命中 response 中包含 "缓存" 的记录 | P0 |
| Q-003 | provider 过滤 | Session 分属 anthropic, openai | `GET /api/sessions?provider=anthropic` | 仅返回 provider=anthropic 的记录 | P0 |
| Q-004 | source 过滤 | Session 分属 cline, cursor | `GET /api/sessions?source=cursor` | 仅返回 source=cursor 的记录 | P0 |
| Q-005 | 时间范围过滤 | Session 分布在不同日期 | `GET /api/sessions?startDate=2026-03-25&endDate=2026-03-26` | 仅返回指定范围内的记录 | P0 |
| Q-006 | onlyBoundToCommit 过滤 | 部分 Session 已绑定 | `GET /api/sessions?onlyBoundToCommit=true` | 仅返回 commitHash 非空的记录 | P0 |
| Q-007 | workspacePath 过滤 | 多 workspace | `GET /api/sessions?workspacePath=/tmp/e2e-test-project` | 仅返回匹配路径的记录 | P0 |
| Q-008 | 组合过滤 | 多条 Session | `GET /api/sessions?provider=anthropic&source=cline&keyword=Redis` | 结果同时满足三个条件 | P1 |

### Suite 5.2: 分页与边界

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| Q-010 | 分页基本功能 | 已有 10 条 Session | `GET /api/sessions?page=1&pageSize=3` | `data.length === 3`；`total === 10`；`page === 1`；`pageSize === 3` | P0 |
| Q-011 | 分页第二页 | 同上 | `GET /api/sessions?page=2&pageSize=3` | `data.length === 3`（或剩余条数）；`page === 2` | P0 |
| Q-012 | 超出范围的页码 | 同上 | `GET /api/sessions?page=999` | `data.length === 0`；`total` 仍为实际总数 | P1 |
| Q-013 | 默认分页参数 | 同上 | `GET /api/sessions` 不传分页参数 | 使用默认 page=1, pageSize=20 | P1 |

### Suite 5.3: 文件名关联查询

> 对应 MCP `query_historical_interaction` 的 filename 参数（客户端侧过滤）。

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| Q-020 | 按 filename 过滤 | Session S1 affectedFiles 含 `service.ts` | 取全量 Session，客户端过滤 `affectedFiles` 包含 `service.ts` | 结果包含 S1 | P0 |
| Q-021 | filename 模糊匹配 | Session affectedFiles 含 `src/user/service.ts` | 过滤 `service.ts`（不含路径前缀） | 仍能匹配（contains 语义） | P1 |
| Q-022 | 不存在的文件名 | 同上 | 过滤 `nonexistent.py` | 返回空列表 | P1 |

---

## 6. Session 更新操作

### Suite 6.1: 标签与备注

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| U-001 | 更新标签 | Session S1 已创建 | `PATCH /api/sessions/:S1/tags` 传 `{tags: ["bugfix", "urgent"]}` | 返回 200；`data.tags` 为 `["bugfix", "urgent"]` | P0 |
| U-002 | 标签非数组 → 400 | Session S1 已创建 | `PATCH /api/sessions/:S1/tags` 传 `{tags: "string"}` | 返回 400 | P0 |
| U-003 | 更新备注 | Session S1 已创建 | `PATCH /api/sessions/:S1/note` 传 `{note: "需要review"}` | 返回 200；`data.note` 正确 | P0 |
| U-004 | 不存在的 Session → 404 | 无 | `PATCH /api/sessions/fake-id/tags` | 返回 404 | P1 |

### Suite 6.2: Commit 绑定/解绑

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| U-010 | 通过 PATCH 绑定 commitHash | Session S1 Dangling | `PATCH /api/sessions/:S1/commit` 传 `{commitHash: "abc123"}` | 返回 200；`data.commitHash === "abc123"` | P0 |
| U-011 | 通过 PATCH 传 null 解绑 | Session S1 已绑定 | `PATCH /api/sessions/:S1/commit` 传 `{commitHash: null}` | 返回 200；`data.commitHash` 为 undefined | P0 |

---

## 7. 删除与清理

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| D-001 | 删除单个 Session | Session S1 已创建 | `DELETE /api/sessions/:S1` | 返回 200；再 GET 该 Session → 404 | P0 |
| D-002 | 删除不存在的 Session | 无 | `DELETE /api/sessions/nonexistent` | 返回 404（或 200 幂等） | P1 |
| D-003 | 按保留天数清理 | 有老旧 Session | `DELETE /api/sessions?retentionDays=0` | 返回 200；所有 Session 被清理 | P2 |
| D-004 | 删除已绑定的 Session | Session S1 绑定到 commit X | `DELETE /api/sessions/:S1` | 返回 200；Session 删除；commit binding 中 sessionIds 应自动移除 S1 或保持一致性 | P1 |

---

## 8. 导出功能

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| EX-001 | 获取支持格式列表 | 无 | `GET /api/export/formats` | 返回包含 `weekly-report`, `pr-description`, `jsonl`, `csv` 的数组 | P0 |
| EX-002 | 导出 JSONL | 有 Session 数据 | `POST /api/export` 传 `{format: "jsonl"}` | 返回 200；content 每行为合法 JSON；包含 id, prompt 等字段 | P0 |
| EX-003 | 导出中文周报 | 有 Session 数据 | `POST /api/export` 传 `{format: "weekly-report", language: "zh"}` | 返回 200；content 包含 Markdown 格式的中文周报 | P0 |
| EX-004 | 导出英文周报 | 有 Session 数据 | `POST /api/export` 传 `{format: "weekly-report", language: "en"}` | content 包含 "Weekly Report" | P1 |
| EX-005 | 导出 PR 描述 | 有 Session 数据 | `POST /api/export` 传 `{format: "pr-description"}` | content 包含 PR 说明结构 | P1 |
| EX-006 | 导出 CSV | 有 Session 数据 | `POST /api/export` 传 `{format: "csv"}` | content 第一行为 CSV header；含 id, provider, prompt 等列 | P0 |
| EX-007 | 不支持的格式 → 400 | 无 | `POST /api/export` 传 `{format: "pdf"}` | 返回 400 | P1 |
| EX-008 | 预览模式 | 有 Session 数据 | `POST /api/export/preview` | 返回 200；包含 `isTruncated` 字段 | P1 |
| EX-009 | workspacePath 过滤导出 | 多 workspace | `POST /api/export` 传 `{format: "jsonl", workspacePath: "/tmp/e2e-test-project"}` | 仅导出指定 workspace 的 Session | P1 |
| EX-010 | 日期范围过滤导出 | 有 Session 数据 | `POST /api/export` 传日期范围 | 仅导出范围内的 Session | P1 |

---

## 9. 统计与元数据

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| M-001 | 获取 Session 统计 | 有多条 Session（部分已绑定） | `GET /api/sessions/stats` | 返回 `total`, `boundToCommit`, `unbound`, `avgDurationMs`, `byProvider`, `bySource` | P0 |
| M-002 | 按 workspace 过滤统计 | 多 workspace | `GET /api/sessions/stats?workspacePath=/tmp/e2e-test-project` | 统计数据仅反映指定 workspace | P1 |
| M-003 | Health Check | 无 | `GET /health` | 返回 200；包含 `status: "ok"`, `version`, `uptime` | P0 |
| M-004 | API 元信息 | 无 | `GET /api` | 返回 200；包含 `name`, `endpoints` | P0 |
| M-005 | 404 处理 | 无 | `GET /nonexistent-path` | 返回 404；`success: false` | P1 |

---

## 10. 外部 Agent Hook（Claude Code 集成）

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| H-001 | Claude Code Stop 事件 | 无 | `POST /api/hooks/claude-code/Stop` 传入合法 payload | 返回 200；创建一条 `source: "claude-code"` 的 Session | P1 |
| H-002 | Claude Code SubagentStop 事件 | 无 | `POST /api/hooks/claude-code/SubagentStop` | 返回 200；创建 Session | P1 |
| H-003 | 未知 agent 类型 | 无 | `POST /api/hooks/unknown-agent/Stop` | 返回 400 或 404 | P2 |
| H-004 | 未知 event 类型 | 无 | `POST /api/hooks/claude-code/UnknownEvent` | 返回 400 或忽略（200 空响应） | P2 |

---

## 11. Git Hook 安装/卸载

| TC-ID | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|-------|---------|---------|---------|---------|--------|
| GH-001 | 安装 post-commit hook | 真实 git repo | `POST /api/commits/hook/install` 传 `{workspacePath: "<repo>"}` | 返回 200；`.git/hooks/post-commit` 文件存在且包含 AgentLog 调用脚本 | P1 |
| GH-002 | 卸载 post-commit hook | hook 已安装 | `DELETE /api/commits/hook/remove` 传 `{workspacePath: "<repo>"}` | 返回 200；AgentLog 相关脚本已从 hook 文件中移除 | P1 |
| GH-003 | 对非 git 目录安装 → 错误 | `/tmp/not-a-repo` | `POST /api/commits/hook/install` | 返回 400/500；错误提示非 git 仓库 | P2 |

---

## 附录：测试用例统计

| 分类 | 用例数 | P0 | P1 | P2 |
|------|--------|-----|-----|-----|
| Flow A: MCP 写入 | 16 | 10 | 5 | 1 |
| Flow B: Hook 绑定 | 15 | 9 | 5 | 1 |
| Flow C: 上下文复活 | 11 | 6 | 3 | 2 |
| E2E 全链路 | 5 | 3 | 1 | 1 |
| 数据查询与过滤 | 15 | 8 | 6 | 1 |
| Session 更新 | 6 | 4 | 2 | 0 |
| 删除与清理 | 4 | 1 | 2 | 1 |
| 导出 | 10 | 4 | 6 | 0 |
| 统计与元数据 | 5 | 2 | 3 | 0 |
| Agent Hook | 4 | 0 | 2 | 2 |
| Git Hook 安装 | 3 | 0 | 2 | 1 |
| **合计** | **94** | **47** | **37** | **10** |
