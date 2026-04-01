# Trae IDE + AgentLog 快速上手

> 📅 更新时间：2026-04-01  
> 🔖 适用版本：AgentLog v1.0.1+

---

## 🚀 快速配置（3 步完成）

### 第一步：启动 AgentLog MCP Server

在终端运行以下命令启动 MCP Server：

```bash
npx @agentlog/backend agentlog-mcp
```

或使用完整命令：

```bash
agentlog-mcp
```

> 💡 MCP Server 默认端口：7892  
> 确认看到 `[agentlog-mcp] Server running` 即表示启动成功

---

### 第二步：在 Trae IDE 中配置 MCP

1. 打开 **Trae IDE**
2. 进入 **设置** → **MCP Server**（或搜索 "MCP"）
3. 点击 **添加 MCP Server**
4. 填写配置：

| 配置项 | 值 |
|--------|-----|
| **Server Name** | `AgentLog` |
| **Server Type** | `Command` |
| **Command** | `npx` |
| **Arguments** | `@agentlog/backend@latest agentlog-mcp` |

或者使用 **URL 方式**（如果 Trae 支持）：

| 配置项 | 值 |
|--------|-----|
| **Server URL** | `http://localhost:7892/mcp` |

5. 点击 **保存** / **确认**

---

### 第三步：验证连接成功

1. 在 Trae IDE 中打开 **Builder Mode** 或 **AI 对话**
2. 输入测试命令，例如：

```
你好，请介绍一下你自己
```

3. 验证 AgentLog 工具被调用：
   - 终端应显示 `[agentlog-mcp] log_turn called` 日志
   - 或者在 Trae 的 MCP 工具列表中能看到 `agentlog.log_turn` 和 `agentlog.log_intent`

---

## ✅ 验证成功的标志

| 检查项 | 预期结果 |
|--------|----------|
| MCP Server 终端 | 显示 `[agentlog-mcp] Server running` |
| Trae MCP 工具列表 | 能看到 `agentlog.log_turn` |
| 执行 AI 命令 | 终端显示 `log_turn called` |
| 查看会话记录 | VS Code 侧边栏或数据库有新记录 |

---

## 🔧 常见问题排查

### Q1: MCP Server 启动失败

**症状**：`npx: command not found` 或权限错误

**解决方案**：
```bash
# 安装 Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 或使用 nvm
nvm install 18
nvm use 18
```

### Q2: Trae 找不到 MCP 配置入口

**症状**：设置中没有 MCP 选项

**解决方案**：
- 确认 Trae 版本为最新（Builder Mode 需要支持）
- 尝试快捷键：`Ctrl+Shift+P` → 输入 `MCP`

### Q3: MCP 连接成功但无日志

**症状**：工具列表能看到，但调用没记录

**解决方案**：
1. 确认 AgentLog 后台服务已启动：
   ```bash
   agentlog-backend
   ```
2. 检查端口 7892 是否被占用：
   ```bash
   lsof -i :7892
   ```

### Q4: "Unknown tool" 错误

**症状**：Trae 提示找不到 `agentlog.log_turn`

**解决方案**：
- 重启 MCP Server
- 检查 Trae MCP 配置是否保存成功
- 尝试移除后重新添加 MCP Server

---

## 📊 Trae IDE 支持的功能

| 功能 | 支持状态 | 说明 |
|------|----------|------|
| MCP Server 连接 | ✅ 已支持 | AgentLog MCP Server 已完成 Trae 适配 |
| log_turn 工具 | ✅ 正常 | 记录对话轮次 |
| log_intent 工具 | ✅ 正常 | 记录 Agent 执行意图 |
| 会话持久化 | ✅ 正常 | 数据写入 SQLite |
| Commit 绑定 | ⏳ 待验证 | 需测试 Trae Git 集成 |

---

## 🎯 下一步

配置完成后，你可以：

1. **开始使用 Trae 进行 AI 编程**
2. **查看 AgentLog 侧边栏**（如已安装 VS Code 插件）
3. **导出周报**：`agentlog export --format weekly-report`
4. **绑定 Git Commit**：每次 git commit 时自动关联 AI 会话

---

## 📞 获取帮助

- 🐛 问题反馈：https://github.com/AgentLogLabs/agentlog/issues
- 📖 完整文档：https://github.com/AgentLogLabs/agentlog#readme
- 🌐 官网：https://agentloglabs.github.io/

---

**AgentLog — 让每一次 AI 交互都有迹可循。**
