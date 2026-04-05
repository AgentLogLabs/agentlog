# AgentLog Phase 1 完整测试用例

> **测试版本**：v1.1.0  
> **测试日期**：2026-04-04  
> **测试范围**：Phase 1 全场景覆盖  
> **核心链路**：OpenCode ↔ OpenClaw ↔ AgentLog ↔ Git Hook  
> **前提条件**：AgentLog Backend 已启动 (`npm run dev`)

---

## 📋 测试用例总览

### 一、基础功能测试（10个用例）

| 编号 | 测试场景 | 优先级 | 预计时间 |
|------|----------|--------|----------|
| TC-001 | OpenCode 配置 AgentLog MCP | P0 | 5 min |
| TC-002 | OpenCode Agent 交互生成 Trace | P0 | 10 min |
| TC-003 | OpenClaw Agent 接收 Trace 复水 | P0 | 10 min |
| TC-004 | VS Code Trace 树状视图验证 | P0 | 5 min |
| TC-005 | Git Hook 拦截人类提交 | P1 | 5 min |
| TC-006 | SSE 实时刷新验证 | P1 | 5 min |
| TC-007 | Trace Summary/Diff API | P2 | 5 min |
| TC-008 | OpenCode Plugin 自动 Hook 安装验证 | P0 | 5 min |
| TC-009 | OpenCode Plugin Hook 事件触发验证 | P0 | 10 min |
| TC-010 | OpenCode Plugin Session 管理验证 | P1 | 5 min |

### 二、Human Override 场景测试（5个用例）

| 编号 | 测试场景 | 优先级 | 预计时间 |
|------|----------|--------|----------|
| TC-HO-001 | OpenCode Agent 首次调用生成 TraceID | P0 | 5 min |
| TC-HO-002 | Agent 生成有 Bug 的代码 | P0 | 5 min |
| TC-HO-003 | 人类接管并修复代码 | P0 | 10 min |
| TC-HO-004 | Agent 通过 TraceID 恢复上下文 | P0 | 10 min |
| TC-HO-005 | 完整链路端到端验证 | P0 | 15 min |

**总计**：15 个测试用例

---

## 🎯 核心场景业务流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Phase 1 完整链路                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  【场景A：Agent 开发】                                                   │
│  ┌──────────┐      ┌──────────────┐      ┌────────────┐               │
│  │ OpenCode │ ───→ │ AgentLog MCP │ ───→ │   SQLite   │               │
│  │  Agent   │      │   Server     │      │   DB       │               │
│  └──────────┘      └──────────────┘      └────────────┘               │
│       │                  │                    │                        │
│       │ log_intent       │ POST /api/spans    │                        │
│       │ (生成TraceID)    │ (记录Span)         │                        │
│       └──────────────────┴────────────────────┘                        │
│                                    │                                     │
│                                    ▼                                     │
│  ┌──────────┐      ┌──────────────┐      ┌────────────┐               │
│  │  VS Code │ ←─── │ SSE /mcp/sse│ ←─── │ 实时推送   │               │
│  │  客户端  │      │              │      │            │               │
│  └──────────┘      └──────────────┘      └────────────┘               │
│                                                                         │
│  【场景B：Human Override】                                               │
│  ┌──────────┐      ┌──────────────┐      ┌────────────┐               │
│  │  人类    │ ───→ │ Git Hook     │ ───→ │  创建      │               │
│  │  接管    │      │ post-commit  │      │ Human Span │               │
│  └──────────┘      └──────────────┘      └────────────┘               │
│       │                                       │                        │
│       │ git commit                            │                        │
│       │ (AGENTLOG_TRACE_ID=xxx)               │                        │
│       └───────────────────────────────────────┘                        │
│                                    │                                     │
│                                    ▼                                     │
│  ┌──────────┐      ┌──────────────┐      ┌────────────┐               │
│  │ OpenClaw │ ←─── │ query_       │ ←─── │ 完整Span树 │               │
│  │  Agent   │      │ historical   │      │ (含Human) │               │
│  └──────────┘      └──────────────┘      └────────────┘               │
│       │                                                               │
│       │ Resume：基于完整上下文继续工作                                    │
│       └───────────────────────────────────────────────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 🔧 前置条件

### 1. 环境准备

```bash
# 1. 构建项目
cd /home/hobo/Projects/agentlog
pnpm build

# 2. 启动 Backend
cd packages/backend
npm run dev

# 3. 确认服务运行
curl http://localhost:7892/health
# 预期: {"status":"ok",...}
```

### 2. VS Code Extension 准备

- 安装 AgentLog VS Code 扩展
- 配置 Backend URL: `http://localhost:7892`

### 3. OpenCode MCP 配置

```bash
# 编辑 ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agentlog": {
      "type": "local",
      "command": [
        "node",
        "/absolute/path/to/agentlog/packages/backend/dist/mcp.js"
      ],
      "environment": {
        "AGENTLOG_GATEWAY_URL": "http://localhost:7892"
      },
      "enabled": true
    }
  },
  "plugin": ["file:///Users/hobo/.config/opencode/plugins/agentlog-auto.js"]
}
```

---

## ✅ 一、基础功能测试

---

### TC-001：OpenCode 配置 AgentLog MCP

**目的**：验证 OpenCode 能正确配置 AgentLog MCP 并连接

**前置条件**：
- AgentLog Backend 已构建并运行
- OpenCode 已安装

**测试步骤**：

1. **确认 MCP Server 文件存在**
   ```bash
   ls /home/hobo/Projects/agentlog/packages/backend/dist/mcp.js
   ```

2. **配置 OpenCode MCP**
   
   编辑 `~/.config/opencode/opencode.json`：
   ```json
   {
      "$schema": "https://opencode.ai/config.json",
      "mcp": {
         "agentlog": {
            "type": "local",
            "command": [
            "node",
            "/absolute/path/to/agentlog/packages/backend/dist/mcp.js"
            ],
            "environment": {
            "AGENTLOG_GATEWAY_URL": "http://localhost:7892"
            },
            "enabled": true
         }
      }
   }
   ```

3. **重启 OpenCode**

   4. **验证连接**
   ```bash
   # 在 OpenCode 中执行任务，观察 Backend 日志
   # 或直接调用（注意：必须先创建 trace，再用真实 traceId 创建 span）
   
   # 4.1 先创建 trace
   TRACE=$(curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"TC-001 连接测试"}')
   TRACE_ID=$(echo $TRACE | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   
   # 4.2 再用真实 traceId 创建 span
   curl -X POST http://localhost:7892/api/spans \
     -H "Content-Type: application/json" \
     -d "{\"traceId\":\"$TRACE_ID\",\"actorType\":\"agent\",\"actorName\":\"Test\",\"payload\":{}}"
   # 预期: {"success":true,"data":{"id":"...","traceId":"...","actorType":"agent",...}}
   ```

**预期结果**：
- [ ] MCP Server 启动成功
- [ ] AgentLog 工具可调用
- [ ] span 创建成功（返回 201）

---

### TC-002：OpenCode Agent 交互生成 Trace

**目的**：验证 OpenCode Agent 执行任务时自动生成 Trace

**前置条件**：TC-001 已完成

**测试步骤**：

1. **OpenCode Agent 发送任务**
   ```
   请用 JavaScript 写一个 Hello World 函数并保存到 /tmp/hello.js
   ```

2. **验证 Trace 生成**
   ```bash
   curl -s http://localhost:7892/api/traces?pageSize=5 | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   traces = d.get('data', [])
   if traces:
       t = traces[-1]
       print('TraceID:', t['id'])
       print('Status:', t['status'])
   "
   ```

3. **验证 Span 创建**
   ```bash
   TRACE_ID="<traceId>"
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary"
   ```

**预期结果**：
- [ ] Trace 自动创建
- [ ] Span 包含 agent 类型记录

---

### TC-003：OpenClaw Agent 接收 Trace

**目的**：验证 OpenClaw Agent 能查询历史 Trace

**前置条件**：TC-002 已完成，有可查询的 Trace

**测试步骤**：

1. **查询历史 Trace**
   ```
   使用 query_historical_interaction 工具
   参数: limit=5
   ```

2. **获取特定 Trace**
   ```
   调用 GET /api/traces/{traceId}/summary
   ```

3. **验证上下文完整**
   - [ ] 包含完整 span 树
   - [ ] 包含工具调用记录
   - [ ] 包含时间线信息

**预期结果**：
- [ ] Agent 能查询到历史 Trace
- [ ] 数据结构完整

---

### TC-004：VS Code Trace 树状视图

**目的**：验证 VS Code 中 Trace 面板正确显示

**前置条件**：
- VS Code AgentLog 扩展已安装
- Backend 运行中

**测试步骤**：

1. **打开 Trace 视图**
   - VS Code 侧边栏 → AgentLog 图标 → Trace List

2. **执行任务生成 Trace**

3. **观察树状视图**
   - [ ] 新 Trace 出现
   - [ ] 点击展开显示 Span
   - [ ] 不同 actor 类型有区分（🤖/👤/⚙️）

4. **SSE 实时刷新**
   - 执行新任务
   - 观察是否自动出现新条目（无需手动刷新）

**预期结果**：
- [ ] Trace List 正常显示
- [ ] 实时刷新功能正常

---

### TC-005：Git Hook 拦截人类提交

**目的**：验证 Git Hook 能拦截人类提交并创建 Span

**前置条件**：Git Hook 已安装

**测试步骤**：

1. **安装 Git Hook（如未安装）**
   ```bash
   curl -X POST http://localhost:7892/api/hooks/install \
     -H "Content-Type: application/json" \
     -d '{"workspacePath":"/path/to/repo"}'
   ```

2. **人类手动修改并提交**
   ```bash
   cd /path/to/repo
   echo "# test" > test.txt
   git add . && git commit -m "Human commit"
   ```

3. **验证 Human Override Span**
   ```bash
   # 检查是否有新的 actor=human span
   curl -s "http://localhost:7892/api/traces?pageSize=1" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   print(json.dumps(d.get('data', [])[0] if d.get('data') else {}, indent=2))
   "
   ```

**预期结果**：
- [ ] Git Hook 触发
- [ ] 创建 actor=human 的 Span
- [ ] 包含 commitHash

---

### TC-006：SSE 实时刷新

**目的**：验证 SSE 推送功能

**测试步骤**：

1. **建立 SSE 连接**
   ```bash
   curl -N http://localhost:7892/mcp/sse -H "Accept: text/event-stream"
   ```

2. **触发 Span 创建**
   ```bash
   # 先创建 trace
   TRACE=$(curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"SSE Test"}')
   TRACE_ID=$(echo $TRACE | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   
   # 再创建 span
   curl -X POST http://localhost:7892/api/spans \
     -H "Content-Type: application/json" \
     -d "{\"traceId\":\"$TRACE_ID\",\"actorType\":\"agent\",\"actorName\":\"Test\",\"payload\":{}}"
   ```

3. **观察 SSE 推送**
   - 应该收到 `span_created` 事件

**预期结果**：
- [ ] SSE 连接正常
- [ ] 推送事件到达

---

### TC-007：Trace Summary/Diff API

**目的**：验证 T6、T7 API 功能

**测试步骤**：

1. **创建测试数据**
   ```bash
   TRACE=$(curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"API Test"}')
   TRACE_ID=$(echo $TRACE | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   
   curl -s -X POST http://localhost:7892/api/spans \
     -H "Content-Type: application/json" \
     -d "{\"traceId\":\"$TRACE_ID\",\"actorType\":\"agent\",\"actorName\":\"Test\",\"payload\":{\"seq\":1}}"
   ```

2. **测试 Summary API**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary"
   ```

3. **测试 Diff API**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/diff"
   ```

**预期结果**：
- [ ] Summary 返回完整统计
- [ ] Diff 返回完整 Span 树

---

### TC-008：OpenCode Plugin 自动 Hook 安装验证

**目的**：验证 OpenCode Plugin 自动 Hook 机制已正确安装并加载

**前置条件**：
- AgentLog Backend 已构建并运行
- OpenCode 已安装

**测试步骤**：

1. **确认 Plugin 文件存在（单文件形式）**
   ```bash
   ls ~/.config/opencode/plugins/agentlog-auto.js
   ```

2. **确认 opencode.json 配置正确**
   ```bash
   cat ~/.config/opencode/opencode.json
   ```
   预期内容应包含：
   ```json
   {
     "mcp": { "agentlog": { ... } },
     "plugin": ["file:///Users/hobo/.config/opencode/plugins/agentlog-auto.js"]
   }
   ```

3. **确认 Plugin 源码结构正确**
   ```bash
   # 验证包含必要的 Hook 处理函数
   grep -E "event:|message\.updated|tool\.execute\.before|tool\.execute\.after" \
     ~/.config/opencode/plugins/agentlog-auto.js
   ```
   预期输出应包含：
   - `event` - 监听 session.idle 等事件
   - `message.updated` - 记录用户/助手消息
   - `tool.execute.before` - 记录工具开始时间
   - `tool.execute.after` - 记录工具执行结果

4. **验证 OpenCode 控制台输出**
   ```bash
   opencode debug config 2>&1 | grep agentlog
   ```
   应看到：
   ```
   [agentlog-auto] Plugin loaded (v2.0.0)
   [agentlog-auto] Backend API: http://localhost:7892/api
   ```

5. **验证 Backend API 连接**
   ```bash
   curl -s http://localhost:7892/health
   # 预期: {"status":"ok","version":"..."}
   ```

**预期结果**：
- [ ] `agentlog-auto.js` 文件存在于 `~/.config/opencode/plugins/`
- [ ] `opencode.json` 包含正确的 `plugin` 数组配置
- [ ] `opencode.json` 包含 `mcp.agentlog` 配置
- [ ] `opencode debug config` 输出显示 Plugin loaded
- [ ] Backend API 可访问

**插件安装方式**：

```bash
# 方式一：手动安装（单文件）
cp /path/to/agentlog/packages/vscode-extension/src/opencode-plugins/agentlog-auto/index.js \
   ~/.config/opencode/plugins/agentlog-auto.js

# 方式二：通过 VS Code 扩展自动安装
# 扩展会调用 installOpenCodePlugin() 函数自动复制并配置

# 方式三：项目级安装
cp /path/to/agentlog/packages/vscode-extension/src/opencode-plugins/agentlog-auto/index.js \
   /path/to/project/.opencode/plugins/agentlog-auto.js
```

**配置文件说明**：
- OpenCode 使用 `opencode.json` 而不是 `config.json`
- 插件必须放在 `plugins/` 目录下（单文件，不能是子目录）
- 插件需要在 `plugin` 数组中声明才能被加载

**卸载方法**：
```bash
rm ~/.config/opencode/plugins/agentlog-auto.js
# 并从 opencode.json 中移除 plugin 数组中的引用
```

---

### TC-009：OpenCode Plugin Hook 事件触发验证

**目的**：验证 OpenCode Plugin 各 Hook 事件能正确拦截并上报数据

**前置条件**：
- TC-008 已完成
- OpenCode 重启以加载 Plugin

**测试步骤**：

1. **验证 message.updated Hook**
   
   在 OpenCode 中执行任务：
   ```
   请用 JavaScript 写一个 Hello World 函数并保存到 /tmp/hello.js
   ```
   
   观察 OpenCode 控制台输出，应看到：
   ```
   [agentlog-auto] Session started: sess_xxx
   [agentlog-auto] Tool logged: bash (turns: x)
   ```

2. **验证 tool.execute.before Hook**
   
   执行一个工具操作：
   ```
   读取 /tmp/hello.js 的内容
   ```
   
   验证工具开始时间被记录

3. **验证 tool.execute.after Hook**
   
   工具执行后，验证：
   ```bash
   # 检查是否创建了 session
   curl -s http://localhost:7892/api/sessions?pageSize=5 | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   sessions = d.get('data', [])
   if sessions:
       s = sessions[-1]
       print('Session ID:', s.get('id'))
       print('Source:', s.get('source'))
       print('Provider:', s.get('provider'))
   "
   ```

4. **验证 session.idle Hook（event 类型）**
   
   完成一个任务后（OpenCode 变为 idle 状态）：
   ```bash
   # 验证 session 已结束
   curl -s http://localhost:7892/api/sessions?pageSize=5 | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   sessions = d.get('data', [])
   if sessions:
       s = sessions[-1]
       print('Last Session:', s.get('id'))
       print('Response (task):', s.get('response', '')[:100])
   "
   ```

5. **验证 Transcript 内容**
   ```bash
   SESSION_ID="<从上面查询获取的 session ID>"
   curl -s "http://localhost:7892/api/sessions/$SESSION_ID" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   if d.get('success'):
       s = d.get('data', {})
       print('Transcript entries:', len(s.get('transcript', [])))
       print('First turn role:', s.get('transcript', [{}])[0].get('role', 'N/A'))
   "
   ```

**预期结果**：
- [ ] `chat.message` 触发时创建新 Session
- [ ] `tool.execute.before` 记录工具开始时间
- [ ] `tool.execute.after` 记录工具调用结果
- [ ] `session.idle` 调用 log_intent 更新 session
- [ ] Session 的 `source` 字段为 `opencode`
- [ ] Transcript 包含正确的 role 序列（user → assistant → tool）

**OpenCode Plugin Hook 事件说明**：

| Hook 事件 | 触发时机 | Plugin 中的处理 |
|-----------|---------|----------------|
| `event` | 监听所有事件 | 根据 `event.type` 处理，如 `session.idle` |
| `message.updated` | 用户/助手消息更新 | 根据 `message.role` 判断是 user 还是 assistant |
| `tool.execute.before` | 工具执行前 | 在 `output.args` 中注入时间戳 |
| `tool.execute.after` | 工具执行后 | 调用 `logToolCall()` 记录工具调用 |

**Backend Session API 端点**：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/sessions` | POST | 创建新 session |
| `/api/sessions` | GET | 查询 session 列表 |
| `/api/sessions/:id` | GET | 获取单个 session |
| `/api/sessions/:id/transcript` | PATCH | 追加 transcript |
| `/api/sessions/:id/intent` | PATCH | 更新 intent/response |

---

### TC-010：OpenCode Plugin Session 管理验证

**目的**：验证 OpenCode Plugin 的 Session 生命周期管理正确

**前置条件**：
- TC-009 已完成
- 有可查询的 OpenCode Session 数据

**测试步骤**：

1. **验证 Session 创建**
   ```bash
   # 查看最新的 OpenCode Session
   curl -s http://localhost:7892/api/sessions?pageSize=10 | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   sessions = [s for s in d.get('data', []) if s.get('source') == 'opencode']
   if sessions:
       s = sessions[-1]
       print('=== Latest OpenCode Session ===')
       print('ID:', s.get('id'))
       print('Provider:', s.get('provider'))
       print('Model:', s.get('model'))
       print('Workspace:', s.get('workspacePath'))
       print('Prompt preview:', s.get('prompt', '')[:80])
   "
   ```

2. **验证 Transcript 完整性**
   ```bash
   SESSION_ID="<上一步获取的 session ID>"
   curl -s "http://localhost:7892/api/sessions/$SESSION_ID" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   if d.get('success'):
       s = d.get('data', {})
       transcript = s.get('transcript', [])
       print('=== Transcript Analysis ===')
       print('Total turns:', len(transcript))
       
       # 统计各 role 数量
       roles = {}
       for t in transcript:
           r = t.get('role', 'unknown')
           roles[r] = roles.get(r, 0) + 1
       print('Role breakdown:', roles)
       
       # 显示前 3 条
       print('First 3 turns:')
       for i, t in enumerate(transcript[:3]):
           print(f'  {i+1}. [{t.get(\"role\")}] {t.get(\"content\", \"\")[:60]}...')
   "
   ```

3. **验证工具调用记录**
   ```bash
   curl -s "http://localhost:7892/api/sessions/$SESSION_ID" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   if d.get('success'):
       s = d.get('data', {})
       transcript = s.get('transcript', [])
       
       tool_calls = [t for t in transcript if t.get('role') == 'tool']
       print('=== Tool Calls ===')
       print('Total:', len(tool_calls))
       for t in tool_calls[:5]:
           content = t.get('content', '')
           tool_name = t.get('toolName', 'unknown')
           print(f'  - {tool_name}: {content[:80]}...')
   "
   ```

4. **验证 Provider 推断**
   ```bash
   # 根据模型名推断 provider
   curl -s http://localhost:7892/api/sessions?pageSize=5 | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   for s in d.get('data', [])[:5]:
       model = s.get('model', '')
       provider = s.get('provider', '')
       print(f'{model} -> {provider}')
   "
   ```
   
   预期推断规则：
   - 包含 `claude` → `anthropic`
   - 包含 `gpt` / `o1` / `o3` / `o4` → `openai`
   - 包含 `deepseek` → `deepseek`
   - 包含 `qwen` → `qwen`
   - 其他 → `unknown` 或基于模型名的合理推断

**预期结果**：
- [ ] Session 的 `source` 为 `opencode`
- [ ] Session 包含正确的 `provider` 和 `model`
- [ ] Transcript 包含完整的 user/assistant/tool 序列
- [ ] 工具调用记录包含正确的 toolName
- [ ] Provider 推断正确

**Plugin 与 MCP 方式的区别**：

| 对比项 | MCP 方式 | Plugin 方式 |
|--------|---------|------------|
| 实现位置 | MCP Server (`mcp.js`) | Plugin (`~/.config/opencode/plugins/agentlog-auto/index.js`) |
| 调用方式 | Agent 主动调用 `log_turn`/`log_intent` | Plugin 自动拦截事件 |
| 数据目标 | `/api/traces` + `/api/spans` | `/api/sessions` + `/api/sessions/:id/transcript` |
| 数据结构 | Trace + Span 树 | Session + Transcript |
| 依赖 | 需要在 prompt 中引导 Agent 调用 | 自动触发，无需 Agent 配合 |

---

## ✅ 二、Human Override 场景测试

---

### TC-HO-001：OpenCode Agent 首次调用生成 TraceID

**目的**：验证 TraceID 自动生成

**前置条件**：TC-001 已完成

**测试步骤**：

1. **触发 Agent 首次调用**
   ```
   请用 Python 写一个斐波那契数列函数
   ```

2. **验证 TraceID 生成**
   ```bash
   curl -s http://localhost:7892/api/traces?pageSize=1 | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   traces = d.get('data', [])
   if traces:
       t = traces[-1]
       print('✅ TraceID:', t['id'])
       print('   Status:', t['status'])
   "
   ```

**预期结果**：
- [ ] TraceID 生成（ULID 格式）
- [ ] Trace status = "running"

---

### TC-HO-002：Agent 生成有 Bug 的代码

**目的**：验证 Agent 生成代码并提交

**前置条件**：TC-HO-001 已完成

**测试步骤**：

1. **Agent 生成有 Bug 的代码**
   ```
   请写一个 Python 函数，接受数字列表返回求和结果，但故意写错（用减法代替加法）
   ```

2. **Agent 提交**
   ```
   保存到 /tmp/buggy.py 并 git commit
   ```

3. **记录 TraceID**
   ```bash
   # 从上一步获取的 traceId
   export TRACE_ID="<traceId>"
   ```

4. **验证 Span 创建**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   s = d.get('data', {}).get('statistics', {})
   print('Agent Spans:', s.get('agentSpans'))
   "
   ```

**预期结果**：
- [ ] Agent 创建了 Span
- [ ] 包含 commit 信息

---

### TC-HO-003：人类切到 VS Code 手工接管并 commit（自动化流程）

**目的**：验证 VS Code 打开项目后**自动读取** git config 中的 traceId，无需人工设置

**关键理解（简化设计）**：

```
OpenCode Agent 操作
    ↓
MCP 自动写入 .git/config: agentlog.traceId=<traceId>
    ↓
人类切换到 VS Code，打开同一项目
    ↓
VS Code AgentLog 插件自动读取 git config 中的 traceId（无需人工干预）
    ↓
人类 commit → Git Hook 自动绑定到同一 traceId
```

**VS Code AgentLog 插件自动读取逻辑**：
```typescript
// VS Code 插件启动时自动执行
async function autoRestoreTraceId() {
  // 1. 检查当前 git 仓库的 config
  const traceId = await git.config.get('agentlog.traceId');
  
  if (traceId) {
    // 2. 找到正在进行的 trace，自动关联
    process.env.AGENTLOG_TRACE_ID = traceId;
    console.log(`[AgentLog] 已自动恢复 trace: ${traceId}`);
  }
}
```

**前置条件**：
- TC-HO-002 已完成
- VS Code 已安装 AgentLog 扩展
- Git Hook 已安装
- VS Code AgentLog 插件已实现自动读取 git config

**测试步骤**：

1. **Step 1: OpenCode Agent 创建 trace 并写入 git config**
   
   ```bash
   cd /path/to/project
   # OpenCode Agent 调用 MCP
   # MCP log_intent 后自动写入:
   # git config agentlog.traceId=<traceId>
   
   # 验证写入
   git config agentlog.traceId
   # 预期输出: <traceId>
   ```

2. **Step 2: 人类切换到 VS Code（无需任何操作）**
   
   - 退出 OpenCode
   - 打开 VS Code
   - 打开同一个项目目录
   - **不需要手动设置环境变量**
   - VS Code AgentLog 插件启动时自动读取 git config

3. **验证 VS Code 自动读取**
   
   在 VS Code 命令面板中执行 `AgentLog: Show Status`：
   ```
   输出应显示:
   - 当前 traceId: <traceId>（从 git config 读取）
   - 状态: 已关联
   ```

4. **人类修复代码并 commit**
   
   在 VS Code 中直接编辑文件：
   ```python
   def sum_list(nums):
       return sum(nums)  # 修复后的正确版本
   ```
   
   使用 VS Code Source Control 面板 commit：
   ```
   1. Stage changes
   2. Commit message: "fix: correct sum function"
   3. 点击 Commit
   ```

5. **验证 Human Override 自动记录**
   
   ```bash
   sleep 2
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/summary" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   s = d.get('data', {}).get('statistics', {})
   print('=== Human Override 自动记录 ===')
   print('TraceId:', '$TRACE_ID')
   print('Total Spans:', s.get('totalSpans'))
   print('Human Spans:', s.get('humanSpans'))
   print('Agent Spans:', s.get('agentSpans'))
   "
   ```

**预期结果**：
- [ ] **VS Code 打开后自动显示当前 traceId**（无需人工干预）
- [ ] 人类 commit 后自动创建 actor=human span
- [ ] span 绑定到 git config 中读取的同一个 traceId
- [ ] 无需手动设置任何环境变量

**⚠️ 关键验证点**：
- VS Code AgentLog 插件启动时**自动**从 git config 读取 traceId
- 不需要用户手动 export AGENTLOG_TRACE_ID
- Git Hook post-commit 时**自动**使用 git config 中的 traceId

---

### TC-HO-004：传递到 OpenClaw Agent 继续编辑（方案B：语义查询）

**目的**：验证 OpenClaw Agent 通过语义查询获取 traceId 并继续工作

**关键理解（方案B）**：
- **Step 3**：OpenClaw Agent（运行在 Gateway/云端）接收任务
- OpenClaw Agent **不依赖手动传递 traceId**，而是通过语义查询自动获取
- 用户在飞书说"继续之前的任务"时，Agent 自动调用 `query_historical_interaction` 搜索
- 最终 span 树包含：**OpenCode Agent** + **VS Code Human** + **OpenClaw Agent**

**方案B 实现流程**：

```
用户（飞书）：继续完善之前的斐波那契函数
       ↓
OpenClaw Agent 收到消息
       ↓
检测到"继续"意图 → 调用 query_historical_interaction
       ↓
Agent 分析返回结果 → 选择对应的 trace
       ↓
获取完整上下文 → 继续完成剩余任务
```

**前置条件**：
- TC-HO-003 已完成
- OpenClaw Agent 已配置 AgentLog MCP 工具
- `query_historical_interaction` 工具支持 keyword 搜索

**测试步骤**：

1. **确认当前 trace 的内容**
   ```bash
   # 先获取一个已存在的 trace
   curl -s http://localhost:7892/api/traces?pageSize=3 | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   traces = d.get('data', [])
   for t in traces[-3:]:
       print('Trace:', t['id'], '|', t['taskGoal'][:40])
   "
   ```

2. **用户在飞书发送语义消息**
   
   假设上一步获取的 trace 包含"斐波那契函数"任务，用户在飞书发送：
   ```
   @OpenClaw 继续完善之前的斐波那契函数
   ```

3. **OpenClaw Agent 执行语义搜索**
   
   OpenClaw Agent 内部调用：
   ```javascript
   // 检测到"继续"意图，自动执行搜索
   const results = await query_historical_interaction({
     keyword: "斐波那契 函数",
     source: "opencode",  // 限定来自 OpenCode 的 trace
     page_size: 5,
     include_transcript: true
   });
   
   // 如果返回多个结果，Agent 选择最相关的一个
   // 或向用户确认：找到了 X 个相关任务，选哪个？
   ```

4. **OpenClaw Agent 获取完整 trace 上下文**
   
   根据返回的 trace 信息，Agent 获取完整 span 树：
   ```bash
   TRACE_ID="<搜索返回的 traceId>"
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/diff" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   tree = d.get('data', {}).get('spanTree', [])
   
   agent = [s for s in tree if s.get('actorType') == 'agent']
   human = [s for s in tree if s.get('actorType') == 'human']
   
   print('=== Context Retrieved ===')
   print(f'🤖 OpenCode Agent Spans: {len(agent)}')
   print(f'👤 Human Override Spans: {len(human)}')
   "
   ```

5. **OpenClaw Agent 继续工作 + TelemetryProbe 记录**
   ```bash
   # OpenClaw Agent 继续完成任务
   # TelemetryProbe 自动上报新的 spans
   sleep 10
   ```

6. **验证完整 span 树（三方合并）**
   ```bash
   curl -s "http://localhost:7892/api/traces/$TRACE_ID/diff" | python3 -c "
   import sys, json
   d = json.load(sys.stdin)
   tree = d.get('data', {}).get('spanTree', [])
   
   agent_spans = [s for s in tree if s.get('actorType') == 'agent']
   human_spans = [s for s in tree if s.get('actorType') == 'human']
   
   print('=== Complete Span Tree (3 Sources) ===')
   print(f'🤖 Agent Spans: {len(agent_spans)}')
   print(f'👤 Human Spans: {len(human_spans)}')
   print()
   
   if len(agent_spans) >= 2 and len(human_spans) >= 1:
       print('✅ Semantic search SUCCESS: Found context across OpenCode + Human + OpenClaw')
   "
   ```

**预期结果**：
- [ ] OpenClaw Agent 能通过语义搜索找到对应的 trace
- [ ] 返回结果包含 OpenCode Agent 和 Human Override 的 span
- [ ] OpenClaw Agent 能理解之前的工作上下文
- [ ] TelemetryProbe 创建新的 agent span（OpenClaw 内部活动）
- [ ] 最终 span 树包含三个来源：OpenCode Agent + VS Code Human + OpenClaw Agent

**⚠️ 关键验证点**：
- 验证 `query_historical_interaction` 支持按任务描述语义搜索
- 验证搜索结果能关联到 OpenCode Agent 和 Human Override spans
- 验证 OpenClaw Agent 能正确解读返回的历史上下文

---

### TC-HO-005：完整链路端到端验证

**目的**：从零开始完整验证 Human Override 全链路

**测试步骤**：

```bash
#!/bin/bash
# TC-HO-005 E2E 脚本

set -e
BASE_URL="http://localhost:7892"
REPO_DIR="/tmp/e2e-ho-test"

# 1. 准备环境
rm -rf $REPO_DIR
mkdir -p $REPO_DIR && cd $REPO_DIR
git init

# 2. 安装 Git Hook
curl -s -X POST "$BASE_URL/api/hooks/install" \
  -H "Content-Type: application/json" \
  -d "{\"workspacePath\":\"$REPO_DIR\"}"

# 3. Step 1: Agent 首次任务（有 Bug）
mkdir -p task1 && cd task1

cat > buggy.py << 'EOF'
def add(a, b):
    return a - b  # Bug!
EOF

# 创建 Trace
TRACE_RESP=$(curl -s -X POST "$BASE_URL/api/traces" \
  -H "Content-Type: application/json" \
  -d '{"taskGoal":"Implement add function"}')
TRACE_ID=$(echo $TRACE_RESP | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
echo "✅ Created Trace: $TRACE_ID"

# 设置环境变量
export AGENTLOG_TRACE_ID=$TRACE_ID
export AGENTLOG_GATEWAY_URL=$BASE_URL
export AGENTLOG_WORKSPACE_PATH=$REPO_DIR/task1

# Agent commit（模拟）
git add .
git commit -m "feat: add function"

sleep 1
echo "✅ Step 1: Agent committed (with bug)"

# 4. Step 2: 人类接管修复
cat > buggy.py << 'EOF'
def add(a, b):
    return a + b  # Fixed!
EOF

git add .
git commit -m "fix: correct add function"

sleep 2
echo "✅ Step 2: Human override committed"

# 5. 验证完整 Trace
echo ""
echo "=========================================="
echo "Trace Summary for $TRACE_ID"
echo "=========================================="

curl -s "$BASE_URL/api/traces/$TRACE_ID/summary" | python3 -c "
import sys, json
d = json.load(sys.stdin)
data = d.get('data', {})
s = data.get('statistics', {})

print(f'TraceID: {data.get(\"traceId\")}')
print(f'Status: {data.get(\"status\")}')
print()
print('📊 Statistics:')
print(f'   Total Spans: {s.get(\"totalSpans\")}')
print(f'   🤖 Agent:    {s.get(\"agentSpans\")}')
print(f'   👤 Human:     {s.get(\"humanSpans\")}')
print(f'   ⚙️  System:  {s.get(\"systemSpans\")}')
"

echo ""
echo "🌲 Span Tree:"
curl -s "$BASE_URL/api/traces/$TRACE_ID/diff" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tree = d.get('data', {}).get('spanTree', [])
for span in tree:
    actor = span.get('actorType', '?')
    icon = '🤖' if actor == 'agent' else '👤' if actor == 'human' else '⚙️'
    print(f'  {icon} {span.get(\"actorName\")} ({actor})')
"

# 6. 验证结论
echo ""
HUMAN_COUNT=$(curl -s "$BASE_URL/api/traces/$TRACE_ID/summary" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['statistics'].get('humanSpans', 0))")
if [ "$HUMAN_COUNT" -ge "1" ]; then
    echo "✅ TC-HO-005 PASSED: Human Override detected"
else
    echo "❌ TC-HO-005 FAILED: No human span found"
fi
```

**预期结果**：
- [ ] Trace 包含 Agent commit span
- [ ] Trace 包含 Human commit span
- [ ] Agent 能查询完整上下文
- [ ] Human Override 时间在 Agent commit 之后

---

## 🐛 问题记录

| Bug ID | 描述 | 严重程度 | 状态 |
|--------|------|----------|------|
| | | | |

---

## 📊 测试总结

| 项目 | 结果 |
|------|------|
| 测试用例总数 | 15 |
| 通过 | X |
| 失败 | X |
| 阻塞 | X |

**测试结论**：

---

## 📝 附录

### A. API 端点速查

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/api/traces` | GET | 查询 trace 列表 |
| `/api/traces` | POST | 创建 trace |
| `/api/traces/:id` | GET | 获取单个 trace |
| `/api/traces/:id/summary` | GET | 获取 trace 摘要 |
| `/api/traces/:id/diff` | GET | 获取 trace diff |
| `/api/spans` | POST | 创建 span |
| `/api/hooks/post-commit` | POST | post-commit 回调 |
| `/api/hooks/install` | POST | 安装 git hook |
| `/api/hooks/status` | GET | 查询 hook 状态 |
| `/api/sessions` | GET | 查询 session 列表 (Plugin 方式) |
| `/api/sessions` | POST | 创建 session (Plugin 方式) |
| `/api/sessions/:id` | GET | 获取单个 session |
| `/api/sessions/:id/transcript` | PATCH | 追加 transcript |
| `/api/sessions/:id/intent` | PATCH | 更新 intent/response |
| `/mcp/sse` | GET | SSE 实时推送 |

### B. MCP 工具列表

| 工具名 | 读写 | 说明 |
|--------|------|------|
| `log_turn` | 写 | 逐轮记录 |
| `log_intent` | 写 | 任务汇总（生成 traceId）|
| `query_historical_interaction` | 只读 | 历史查询 |

### C. Human Override Span 结构

```json
{
  "id": "01KNBB21CQCP26K7S48NSTVQAA",
  "traceId": "<traceId>",
  "parentSpanId": null,
  "actorType": "human",
  "actorName": "git:human-override",
  "payload": {
    "event": "post-commit",
    "commitHash": "abc123...",
    "diff": "...",
    "changedFiles": ["buggy.py"]
  },
  "createdAt": "2026-04-04T..."
}
```

### D. 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `AGENTLOG_TRACE_ID` | 当前 trace ID | `01KNBB1NSXTX...` |
| `AGENTLOG_GATEWAY_URL` | AgentLog 网关地址 | `http://localhost:7892` |
| `AGENTLOG_WORKSPACE_PATH` | 工作区路径 | `/home/user/project` |
| `AGENTLOG_PORT` | 端口号 | `7892` |

### E. 相关文件

| 文件 | 说明 |
|------|------|
| `packages/backend/src/mcp.ts` | MCP Server 实现 |
| `packages/backend/src/routes/traces.ts` | Trace API |
| `packages/backend/src/routes/spans.ts` | Span API |
| `packages/backend/src/services/gitHookService.ts` | Git Hook 处理 |
| `packages/backend/src/utils/sseManager.ts` | SSE 管理 |
| `packages/vscode-extension/src/providers/traceWebviewProvider.ts` | VS Code Trace 视图 |
| `packages/vscode-extension/src/opencode-plugins/agentlog-auto/index.js` | OpenCode Plugin 自动 Hook |
| `packages/backend/src/routes/sessions.ts` | Session API (Plugin 方式数据) |

---

## 📝 附录D：Trace 生命周期设计决策（Phase 1 补充）

### D1. git config traceId 的作用

**问题**：git config 中的 traceId 和数据库中的 traceId 是什么关系？

**答案**：git config 中的 traceId 是"基准 trace"，用于标记绑定起点。Git commit 时，会绑定**该基准 trace 创建时间点之后的所有 traces**。

| 存储位置 | 存储内容 | 作用 |
|----------|----------|------|
| **数据库 traces 表** | traceId + task_goal + status | 主要存储，所有查询都基于此 |
| **git config** | agentlog.traceId = traceId | 基准 trace，Git Hook 读取后查询该时间点之后的所有 traces 并绑定 |

**git config 写入时机**：
1. OpenCode Agent 调用 `log_intent` / `log_turn` / `create_trace` 时，MCP 自动写入
2. 人类手动执行 `git config agentlog.traceid <trace-id>` 设置

**Git Hook 绑定逻辑**：
```
人类 → git commit → Git Hook → 读取 .git/config agentlog.traceId
                                → 获取基准 trace 的创建时间
                                → 查询该时间点之后的所有 traces（包括基准 trace）
                                → 为每个 trace 创建 Human Override span
                                → 将所有 traceIds 写入 commit_bindings 表
```

**示例**：
1. 用户设置 `git config agentlog.traceid T-base`（创建时间 T0）
2. AI 工作创建 trace `T-1`（创建时间 T1 > T0）
3. AI 工作创建 trace `T-2`（创建时间 T2 > T1 > T0）
4. 用户 git commit → Git Hook 绑定 T-base、T-1、T-2 到这次 commit

---

### D2. Trace 结束判断

**问题**：如何判断一个 Trace 是否结束？

**当前方案**：主动 + 被动结合

| 判断方式 | 触发条件 | 说明 |
|----------|----------|------|
| **主动结束** | 用户/Agent 调用 `log_intent` | 任务明确完成 |
| **被动结束** | `log_intent` 时传入 `explicit_status: "completed"` | Agent 任务完成 |
| **超时结束** | trace 创建后超过 N 天无新 span | 兜底策略 |
| **永不结束** | 持续活跃的任务 | 通过 git commit 持续关联 |

---

### D3. 新 Trace 启动判断（方案C）

**问题**：一个月前的 trace 想继续，是延续还是继承？

**选择方案C**：

| 方案 | 描述 | 选择 |
|------|------|------|
| A | 在原 trace 上延续 | ❌ |
| B | 继承原 trace，但保持原 trace 不变 | ❌ |
| **C** | **继承原 trace，获取压缩语义，启动新 trace** | ✅ |

**方案C 流程**：
```
1. 用户：想继续一个月前的 trace T-old
2. Agent：调用 `query_historical_interaction({ keyword: "..." })` 语义搜索
3. Agent：找到 T-old，分析其压缩语义（task_goal + summary）
4. Agent：创建新 trace T-new，携带 parent_trace_id = T-old
5. Agent：在 T-new 上继续工作
6. 结果：
   - T-old 保持不变（历史记录）
   - T-new 继承 T-old 的上下文
   - 可追溯：T-new.parent_trace_id → T-old
```

**字段设计**：
```sql
ALTER TABLE traces ADD COLUMN parent_trace_id TEXT REFERENCES traces(id);
ALTER TABLE traces ADD COLUMN inherited_from TEXT;  -- 继承自哪个 trace
```

---

### D4. OpenClaw Agent 接管流程（修正）

**问题**：OpenClaw Agent 接管后去哪里读取？

**正确理解**：
- OpenClaw Agent **不在自己的工作目录**工作
- OpenClaw Agent 需要去**指定代码区**（用户指定的目录）操作
- 通过 `workspacePath` 参数指定目标目录

**修正后的流程**：
```
【Step 1-2】：OpenCode Agent → 人类 VS Code commit（保持不变）

【Step 3】：OpenClaw Agent 接管
  1. Agent 接收任务 + workspacePath（如 /home/user/project-abc）
  2. Agent 调 MCP 查询 trace（语义搜索或直接传 traceId）
  3. Agent 在 workspacePath 目录继续开发
  4. TelemetryProbe 记录到同一 traceId
```

---

### D5. 语义检索增强（Phase 1 补充）

**问题**：当前 keyword 搜索基于 SQL LIKE，精度有限

**建议方案**：在 MCP 侧实现语义检索

**实现方式**：
1. 使用开源 embedding 模型（如 bge-small-zh）
2. 在创建 trace 时，生成 task_goal 的 embedding 存储
3. 查询时，计算用户输入的 embedding，做向量相似度搜索

**数据结构**：
```sql
ALTER TABLE traces ADD COLUMN task_embedding TEXT;  -- task_goal 的 embedding
```

**MCP 工具新增**：
```javascript
// 语义搜索
semantic_search({
  query: "用户描述的任务",  // 如"继续之前的斐波那契函数"
  limit: 5
})
// 返回：最相关的 trace 列表（按语义相似度排序）
```

---

### D6. Trace 和 Span 关系总结

```
┌─────────────────────────────────────────────────────────────────┐
│                        Trace 生命周期                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  创建 ──────────────────────────────────────────────────────►  │
│    │                                                           │
│    ├─ MCP: log_intent / create_trace / log_turn              │
│    │      → 写入数据库 + 写入 git config                        │
│    │                                                           │
│  延续 ──────────────────────────────────────────────────────►  │
│    │                                                           │
│    ├─ Agent: 继续在同一个 trace 上创建 span                   │
│    │      → TelemetryProbe 自动上报                             │
│    │                                                           │
│    ├─ Human: git commit（不通过 MCP）                          │
│    │      → Git Hook 读取 git config → 创建 human span          │
│    │                                                           │
│  继承 ──────────────────────────────────────────────────────►  │
│    │                                                           │
│    ├─ 创建新 trace T-new                                       │
│    │      → parent_trace_id = T-old                            │
│    │      → 携带压缩语义                                        │
│    │                                                           │
│  结束 ──────────────────────────────────────────────────────►  │
│    │                                                           │
│    └─ log_intent(explicit_status="completed")                  │
│            → trace.status = "completed"                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

### D7. 当前实现状态 vs 设计决策

| 功能 | 设计决策 | 当前实现状态 |
|------|----------|-------------|
| git config traceId | 存储 traceId 供 Git Hook 读取 | ✅ 已实现 |
| Trace 结束 | log_intent 时更新 status=completed | ✅ 已实现 |
| 新 Trace 启动 | 调用 create_trace / log_intent | ✅ 已实现 |
| 继承（方案C） | parent_trace_id 字段 | ❌ 未实现 |
| 语义检索 | embedding + 向量搜索 | ❌ 未实现 |
| OpenClaw workspacePath | 去指定目录操作 | ⚠️ 待确认 |

---

## 📝 附录E：需要 Builder 补充的 Tickets（Phase 1 补充）

| Ticket | 描述 | 优先级 |
|--------|------|--------|
| T-E1 | 添加 `parent_trace_id` 字段支持 trace 继承 | P1 |
| T-E2 | 实现语义检索（embedding + 向量搜索） | P1 |
| T-E3 | 确认 OpenClaw Agent 的 workspacePath 处理逻辑 | P0 |

---

## ✅ 三、T-A & T-B 专项测试（git config traceId 透传）

### TC-T-A：MCP 创建 trace 时写入 git config

**目的**：验证 MCP (log_intent/log_turn/create_trace) 创建 trace 时同时写入 `.git/config`

**前置条件**：
- Backend 运行在 localhost:7892
- 处于 git 仓库中

**测试步骤**：

1. **确认 git 仓库状态**
   ```bash
   cd /tmp/test-repo-tc-ta
   rm -rf /tmp/test-repo-tc-ta
   mkdir -p /tmp/test-repo-tc-ta && cd /tmp/test-repo-tc-ta
   git init
   git config user.email "test@test.com"
   git config user.name "Test"
   ```

2. **调用 MCP create_trace（模拟）**
   ```bash
   # 直接调用 API 创建 trace
   TRACE=$(curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"T-A 测试任务"}')
   TRACE_ID=$(echo $TRACE | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   echo "Created Trace: $TRACE_ID"
   ```

3. **模拟 MCP 写入 git config（实际由 MCP 自动执行）**
   ```bash
   git config agentlog.traceId "$TRACE_ID"
   echo "✅ 写入 git config: agentlog.traceId=$TRACE_ID"
   ```

4. **验证 git config 写入成功**
   ```bash
   GIT_CONFIG_TRACE=$(git config agentlog.traceId)
   if [ "$GIT_CONFIG_TRACE" = "$TRACE_ID" ]; then
       echo "✅ git config 验证通过: $GIT_CONFIG_TRACE"
   else
       echo "❌ git config 验证失败"
   fi
   ```

**预期结果**：
- [ ] trace 创建成功
- [ ] git config agentlog.traceId 包含正确的 traceId

---

### TC-T-B：Git Hook 从 git config 读取 traceId 并绑定所有后续 traces

**目的**：验证 Git Hook post-commit 从 `.git/config` 读取 traceId，查询该基准时间点之后的所有 traces 并全部绑定

**前置条件**：
- TC-T-A 已完成
- Git Hook 已安装

**测试步骤**：

1. **安装 Git Hook**
   ```bash
   curl -s -X POST http://localhost:7892/api/hooks/install \
     -H "Content-Type: application/json" \
     -d '{"workspacePath":"/tmp/test-repo-tc-ta"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅ 安装成功' if d.get('success') else '❌ 失败')"
   ```

2. **确认 git config 有 traceId**
   ```bash
   cd /tmp/test-repo-tc-ta
   git config agentlog.traceid
   ```

3. **创建额外的 traces（模拟 AI 工作在基准 trace 之后创建新 traces）**
   ```bash
   # 创建 trace-2
   TRACE2=$(curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"Second task after base trace"}')
   TRACE2_ID=$(echo $TRACE2 | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   echo "Created trace-2: $TRACE2_ID"
   
   # 创建 trace-3
   TRACE3=$(curl -s -X POST http://localhost:7892/api/traces \
     -H "Content-Type: application/json" \
     -d '{"taskGoal":"Third task after base trace"}')
   TRACE3_ID=$(echo $TRACE3 | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
   echo "Created trace-3: $TRACE3_ID"
   ```

4. **人类 git commit（触发 Git Hook）**
   ```bash
   echo "test content" > test.txt
   git add . && git commit -m "Human commit via Git Hook"
   sleep 2
   ```

5. **验证所有 traces 被绑定到 commit**
   ```bash
   # 查询 commit 绑定记录
   COMMIT_HASH=$(cd /tmp/test-repo-tc-ta && git rev-parse HEAD)
   curl -s "http://localhost:7892/api/commits/$COMMIT_HASH" | python3 -c "
   import sys,json
   d=json.load(sys.stdin)
   if d.get('success'):
       data = d.get('data', {})
       trace_ids = data.get('traceIds', [])
       print('=== Commit Binding ===')
       print('Commit:', '$COMMIT_HASH'[:8])
       print('Bound traces:', len(trace_ids))
       for tid in trace_ids:
           print('  -', tid)
       if len(trace_ids) >= 3:
           print('✅ 所有 traces 绑定成功')
       else:
           print('❌ traces 绑定数量不足')
   "
   ```

6. **验证每个 trace 都有 human span**
   ```bash
   for tid in $GIT_CONFIG_TRACE $TRACE2_ID $TRACE3_ID; do
     curl -s "http://localhost:7892/api/traces/$tid/summary" | python3 -c "
     import sys,json
     d=json.load(sys.stdin)
     s=d.get('data',{}).get('statistics',{})
     print(f'Trace {d.get(\"data\",{}).get(\"traceId\")[:8]}...: humanSpans={s.get(\"humanSpans\",0)}')"
   done
   ```

**预期结果**：
- [ ] Git Hook 安装成功
- [ ] 人类 git commit 后，commit_bindings 表的 traceIds 包含基准 trace + 所有后续 traces
- [ ] 每个 trace 都有 actor=human 的 span
- [ ] commit 绑定了 3 个 traces（基准 + trace-2 + trace-3）

---

### TC-T-C：关键字搜索精度

**目的**：验证 `GET /api/traces/search?keyword=xxx` 返回正确结果

**前置条件**：
- Backend 运行中

**测试步骤**：

1. **创建多个不同 task_goal 的 traces**
   ```bash
   # 创建 3 个不同任务的 trace
   for task in "斐波那契数列实现" "Git Hook 测试" "用户登录功能"; do
     curl -s -X POST http://localhost:7892/api/traces \
       -H "Content-Type: application/json" \
       -d "{\"taskGoal\":\"$task\"}" > /dev/null
   done
   ```

2. **搜索"斐波那契"**
   ```bash
   RESULT=$(curl -s "http://localhost:7892/api/traces/search?keyword=%E6%96%AF%E6%B3%A2%E9%82%A3%E5%A5%87")
   echo "$RESULT" | python3 -c "
   import sys,json
   d=json.load(sys.stdin)
   results = d.get('data', [])
   print('搜索\"斐波那契\":', len(results), '条结果')
   for r in results:
       print(' -', r['trace']['taskGoal'])
   "
   ```

3. **搜索"登录"**
   ```bash
   RESULT=$(curl -s "http://localhost:7892/api/traces/search?keyword=%E7%99%BB%E5%BD%95")
   echo "$RESULT" | python3 -c "
   import sys,json
   d=json.load(sys.stdin)
   results = d.get('data', [])
   print('搜索\"登录\":', len(results), '条结果')
   "
   ```

**预期结果**：
- [ ] 搜索"斐波那契"返回相关 trace
- [ ] 搜索"登录"返回相关 trace
- [ ] 搜索结果不包含无关 trace

---

## 📊 T1-T10 功能覆盖总表

| Ticket | 功能 | 测试用例 | 状态 |
|--------|------|---------|------|
| T1 | traces/spans 表 + ULID | TC-002, TC-007 | ✅ |
| T2 | MCP Stdio + SSE | TC-001, TC-006 | ✅ |
| T3 | POST /api/spans | TC-002, TC-T-C | ✅ |
| T4 | OpenClaw Hook 探针 | TC-HO-004 | ✅ |
| T5 | Git Hook post-commit | TC-005, TC-T-B | ✅ |
| T6 | Trace summary API | TC-007 | ✅ |
| T7 | Trace diff API | TC-007 | ✅ |
| T8 | UI SSE 实时刷新 | TC-004, TC-006 | ✅ |
| T9 | OpenCode Plugin 安装 | TC-008 | ✅ |
| T10 | OpenCode Plugin Hook 事件 | TC-009, TC-010 | ✅ |

**覆盖率：10/10 = 100% ✅**

---

## ✅ 四、UI 交互测试脚本（VS Code 手动测试）

### TC-UI-1：VS Code Trace 树状视图完整交互

**目的**：完整验证 VS Code AgentLog 插件的 UI 功能

**前置条件**：
- VS Code 已安装 AgentLog 扩展
- Backend 运行在 localhost:7892
- 已有测试数据（traces 和 spans）

**手动测试步骤**：

#### 1. 打开 Trace 视图

```
1. 打开 VS Code
2. 打开包含 git 仓库的项目文件夹
3. 按 Ctrl+Shift+P 打开命令面板
4. 输入 "AgentLog: Open Dashboard"
5. 或点击左侧边栏的 AgentLog 图标
```

预期结果：
- [ ] AgentLog 面板打开
- [ ] 显示 "Trace List" 视图

#### 2. 验证 trace 显示

在 Trace List 中查看已有的 trace：
- [ ] 显示 trace ID（短格式）
- [ ] 显示 task_goal
- [ ] 显示状态图标（running/completed）
- [ ] 显示时间戳

#### 3. 展开 trace 查看 span 树

点击 trace 条目展开：
- [ ] 显示嵌套的 span 列表
- [ ] 不同 actor 类型有不同图标：
  - 🤖 = agent
  - 👤 = human  
  - ⚙️ = system
- [ ] 显示 span 的 actorName
- [ ] 显示创建时间

#### 4. 点击 span 查看详情

点击单个 span：
- [ ] 显示 span 详情面板
- [ ] 显示 payload 内容（JSON 格式化）

#### 5. SSE 实时刷新测试

在 VS Code 中执行以下操作观察实时更新：

```
操作步骤：
1. 保持 VS Code AgentLog 面板打开
2. 使用另一个终端发送请求创建新 span：
   # 先获取一个存在的 trace ID
   TRACE_ID=$(curl -s http://localhost:7892/api/traces?pageSize=1 | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['id'])")
   curl -X POST http://localhost:7892/api/spans \
     -H "Content-Type: application/json" \
     -d "{\"traceId\":\"$TRACE_ID\",\"actorType\":\"agent\",\"actorName\":\"TestAgent\",\"payload\":{\"event\":\"test\"}}"
3. 观察 VS Code 面板是否自动刷新显示新 span
```

预期结果：
- [ ] 新 span 自动出现在列表中（无需手动刷新）
- [ ] SSE 连接状态显示为已连接

---

### TC-UI-2：VS Code AgentLog 状态栏

**目的**：验证 VS Code 状态栏显示 AgentLog 连接状态

**手动测试步骤**：

```
1. 打开 VS Code
2. 查看底部状态栏
3. 找到 AgentLog 相关状态项
```

预期结果：
- [ ] 显示 Backend 连接状态（绿色=已连接，红色=未连接）
- [ ] 显示当前 traceId（如果已设置）
- [ ] 点击可打开 AgentLog 面板

---

### TC-UI-3：Git Hook 安装验证

**目的**：验证 Git Hook 安装功能

**手动测试步骤**：

```
1. 在 VS Code 中打开一个 git 仓库项目
2. 按 Ctrl+Shift+P
3. 输入 "AgentLog: Install Git Hook"
4. 执行命令
5. 检查 .git/hooks/post-commit 文件是否存在
```

预期结果：
- [ ] 命令执行成功
- [ ] .git/hooks/post-commit 文件已创建
- [ ] 文件内容包含 AgentLog 相关脚本

---

### TC-UI-4：OpenCode MCP 配置（命令面板）

**目的**：验证 OpenCode MCP 配置生成功能

**手动测试步骤**：

```
1. 按 Ctrl+Shift+P
2. 输入 "AgentLog: Configure OpenCode MCP"
3. 选择命令并执行
4. 查看生成的配置文件内容
```

预期结果：
- [ ] 生成正确的 JSON 配置
- [ ] 配置包含正确的路径和参数
- [ ] 可复制到 OpenCode 配置中使用

---

## 📊 UI 测试检查清单

### 必需手动测试（需人工操作 VS Code）

| 测试项 | 优先级 | 说明 |
|--------|--------|------|
| TC-UI-1: Trace 树状视图 | P0 | 核心 UI 功能 |
| TC-UI-2: 状态栏 | P1 | 显示连接状态 |
| TC-UI-3: Git Hook 安装 | P2 | 便捷功能 |
| TC-UI-4: OpenCode MCP 配置 | P2 | 便捷功能 |

### 可自动化测试（API 层）

| 测试项 | 对应测试用例 | 状态 |
|--------|-------------|------|
| SSE 连接 | TC-006 | ✅ |
| POST /api/spans | TC-002, TC-HO-001 | ✅ |
| GET /api/traces | TC-002 | ✅ |
| GET /api/traces/search | TC-T-C | ✅ |

---

## 📝 附录F：完整 E2E 验证脚本

### 快速验证脚本（API 层）

```bash
#!/bin/bash
# Phase 1 快速 E2E 验证脚本
# 用法: bash docs/scripts/e2e-quick-test.sh

set -e
BASE_URL="${AGENTLOG_URL:-http://localhost:7892}"
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }

echo "=== Phase 1 E2E 快速验证 ==="

# 1. Health
echo -e "\n📋 Health Check"
curl -s "$BASE_URL/health" | grep -q "ok" && pass "Backend 健康" || fail "Backend 无响应"

# 2. Create Trace
echo -e "\n📋 Create Trace"
TRACE=$(curl -s -X POST "$BASE_URL/api/traces" -H "Content-Type: application/json" \
  -d '{"taskGoal":"E2E Quick Test"}')
TRACE_ID=$(echo $TRACE | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[ -n "$TRACE_ID" ] && pass "Trace 创建成功: ${TRACE_ID:0:16}..." || fail "Trace 创建失败"

# 3. Create Span
echo -e "\n📋 Create Span"
SPAN=$(curl -s -X POST "$BASE_URL/api/spans" -H "Content-Type: application/json" \
  -d "{\"traceId\":\"$TRACE_ID\",\"actorType\":\"agent\",\"actorName\":\"Test\",\"payload\":{}}")
echo $SPAN | grep -q "success" && pass "Span 创建成功" || fail "Span 创建失败"

# 4. Summary
echo -e "\n📋 Trace Summary"
SUMMARY=$(curl -s "$BASE_URL/api/traces/$TRACE_ID/summary")
echo $SUMMARY | grep -q "agentSpans" && pass "Summary API 正常" || fail "Summary API 失败"

# 5. Diff
echo -e "\n📋 Trace Diff"
DIFF=$(curl -s "$BASE_URL/api/traces/$TRACE_ID/diff")
echo $DIFF | grep -q "spanTree" && pass "Diff API 正常" || fail "Diff API 失败"

# 6. Search
echo -e "\n📋 Search"
SEARCH=$(curl -s "$BASE_URL/api/traces/search?keyword=E2E")
echo $SEARCH | grep -q "success" && pass "Search API 正常" || fail "Search API 失败"

# 7. Git Hook Install
echo -e "\n📋 Git Hook Install"
mkdir -p /tmp/e2e-test-repo && cd /tmp/e2e-test-repo && git init -q 2>/dev/null
HOOK=$(curl -s -X POST "$BASE_URL/api/hooks/install" -H "Content-Type: application/json" \
  -d '{"workspacePath":"/tmp/e2e-test-repo"}')
echo $HOOK | grep -q "success" && pass "Git Hook 安装成功" || fail "Git Hook 安装失败"

echo -e "\n=========================================="
echo "📊 结果: $PASS 通过, $FAIL 失败"
[ $FAIL -eq 0 ] && echo "✅ 全部通过!" || echo "⚠️ 有失败项"
echo "=========================================="
```

将此脚本保存到 `docs/scripts/e2e-quick-test.sh` 并执行：
```bash
chmod +x docs/scripts/e2e-quick-test.sh
bash docs/scripts/e2e-quick-test.sh
```
