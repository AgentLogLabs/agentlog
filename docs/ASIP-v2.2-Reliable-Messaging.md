# ASIP v2.2 可靠消息传递协议

> 设计时间：2026-04-11
> 设计者：Architect
> 状态：**待 CEO 审批**

---

## 一、问题回顾

**ASIP v2.1 异步方案的问题：**

```
发送方 ──→ sessions_send (timeoutSeconds: 0) ──→ 立即返回
                                                  ↓
                        目标 Agent session = done → 消息丢失 ❌
```

- 异步发送解决了发送方阻塞问题
- 但目标 Agent session done 时，消息仍然无法送达
- 需要消息持久化和唤醒机制

---

## 二、设计目标

1. **消息可靠传递**：即使目标 Agent 暂时不可用，消息也不丢失
2. **利用 OpenClaw 原生机制**：减少自研负担
3. **低复杂度**：不过度设计

---

## 三、OpenClaw 原生机制分析

### 3.1 已有的消息传递机制

| 机制 | 说明 | 适用场景 |
|------|------|---------|
| `sessions_send` | 实时发送，需要目标 active | 紧急/同步场景 |
| `sessions_spawn` | 派生子 Agent | 新任务创建 |
| Gateway RPC | Agent 间通信基础设施 | 已内置 |
| **Heartbeat** | 定期 ping，保持 session 活跃 | 保持连接 |
| **Session 持久化** | done 的 session 仍然保留在 Gateway | 消息不丢失 |

### 3.2 关键发现：Session 持久化

OpenClaw Gateway 不会立即删除 done 的 session：
- Session 在 Gateway 中保留一段时间
- `sessions_send` 到一个 done 的 session 会入队
- 当 Agent 重启并连接时，会收到排队的消息

**这意味着：如果我们能让 Builder 定期重连，消息就能送达！**

---

## 四、ASIP v2.2 方案：Feishu @mention 唤醒 + 异步发送

### 4.1 核心思路

**发现：** OpenClaw 的 session done 后消息不会入队。但 Builder 发现了一个有效的唤醒机制：**Feishu @mention** 在群里 @Builder 会唤醒其 session。

```
Architect ──→ sessions_send (timeoutSeconds: 0) ──→ 立即返回
              ↓
              同时在 Feishu 群 @Builder
              ↓
              Builder 被唤醒，变为 active
              ↓
              处理消息
```

### 4.2 消息发送模式

**异步模式（普通消息，推荐）：**
```javascript
// 1. 异步发送（不等待）
sessions_send({
  sessionKey: "builder", 
  message: JSON.stringify(packet),
  timeoutSeconds: 0  // 立即返回
});

// 2. 同时 @Builder 在群里提醒
// 发送消息：@AgentLog工程师 有新任务
```

**同步模式（紧急消息）：**
```javascript
sessions_send({
  sessionKey: "builder",
  message: JSON.stringify(urgentPacket),
  timeoutSeconds: 30  // 等待响应
});
// 紧急情况才用，会阻塞
```

### 4.3 已知限制

| 限制 | 说明 |
|------|------|
| 需要 Feishu 群 | 必须有群可以 @ |
| @mention 触发 | Builder 需要被 @ 才唤醒 |
| 非实时 | 中间可能有延迟 |

### 4.4 适用场景

| 场景 | 方式 | 说明 |
|------|------|------|
| 普通 Ticket 下发 | 异步 + @ | 不阻塞，可接受延迟 |
| 紧急告警 | 同步 | 等待响应 |
| 非 Feishu 渠道 | 待定 | 后续扩展 |

---

## 五、Session 状态与消息传递

### 5.1 Session 状态机

```
active ──→ idle ──→ done
  ↑           ↓
  ←←←←← reconnect ←←←←←
```

- **active**：正在处理消息
- **idle**：空闲，但 session 保留
- **done**：Agent 断开，但 Gateway 保留 session 一段时间
- **reconnect**：Agent 重新连接，恢复到 active

### 5.2 消息传递保证

| 发送时目标状态 | 消息处理 |
|--------------|---------|
| active | 直接送达 ✅ |
| idle | 直接送达 ✅ |
| done（短时间） | Gateway 入队，Agent 重连后收到 ✅ |
| done（长时间） | 可能需要 Agent 主动拉取 ❌ |

---

## 六、实现步骤

### 6.1 步骤 1：配置 Heartbeat

在 `openclaw.json` 中为 Builder 配置 heartbeat：

```json
{
  "agents": {
    "builder": {
      "heartbeat": {
        "intervalSeconds": 60,
        "enabled": true
      }
    }
  }
}
```

### 6.2 步骤 2：更新 ASIP 协议

在 SOUL.md 中明确消息分类：

```markdown
## 消息分类

| 消息类型 | 发送模式 | 超时 |
|---------|---------|------|
| TICKET（紧急） | 同步 | 30s |
| ACK/RESULT | 异步 | 0（立即返回） |
| 非紧急通知 | 异步 | 0 |

## 重试机制

- 首次发送失败后，等待 30s 重试
- 最多重试 3 次
- 3 次后标记为 failed，通过 Dashboard 告警
```

### 6.3 步骤 3：监控未送达消息

在 Dashboard 中显示：
- pending 消息数量
- failed 消息数量
- 帮助及时发现通信问题

---

## 七、ASIP v2.2 vs v2.1

| 特性 | v2.1（异步） | v2.2（心跳保活） |
|------|------------|----------------|
| 发送方阻塞 | ✅ 不阻塞 | ✅ 不阻塞 |
| 目标 done 时送达 | ❌ 丢失 | ✅ 通过 Gateway 入队 |
| 需要 Agent 配合 | ❌ | ✅ 定期 heartbeat |
| 复杂度 | 低 | 中 |
| 消息可靠性 | 低 | 高 |

---

## 八、Ticket 拆解

| # | Ticket | 描述 | 负责人 |
|---|--------|------|--------|
| 1 | **更新 ASIP 协议文档** | 明确消息分类：异步+@mention 唤醒 | Architect |
| 2 | **更新 Architect SOUL.md** | 实现异步发送 + @mention 唤醒逻辑 | Builder |
| 3 | **E2E 测试** | 验证异步发送 + @mention 能唤醒 Builder | Auditor |

### TICKET-2026-0411-02: 更新 Architect SOUL.md

```javascript
// ASIP v2.2 发送模式
async function sendToBuilder(packet) {
  // 1. 异步发送（不等待）
  sessions_send({
    sessionKey: "builder",
    message: JSON.stringify(packet),
    timeoutSeconds: 0  // 立即返回
  });

  // 2. 同时在 Feishu 群 @Builder 提醒
  await sendFeishuMessage(
    "@AgentLog工程师 有新任务: " + packet.Base_Ticket
  );
}
```

---

## 九、决策项

1. **Heartbeat 间隔**：60s 还是 30s？（越短越可靠，但资源消耗越大）
2. **是否需要消息持久化**（Backend 存储）作为备份？
3. **失败消息的处理策略**：重试 3 次后如何处理？

---

## 十、下一步

确认后下发 Ticket 给 Builder 执行。
