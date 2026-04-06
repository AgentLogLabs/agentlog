# ⚠️ DEPRECATED - agentlog-auto

> **本 Skill 已废弃，请使用新 Skill：`openclaw-agent-log`**

---

## 废弃说明

本 Skill 名称 `agentlog-auto` 与 OpenCode VSCode 插件中的同名 Skill 冲突，容易混淆。

## 新 Skill

请使用合并后的新 Skill：

- **名称**: `openclaw-agent-log`
- **位置**: `skills/openclaw-agent-log/`
- **功能**: 合并了 `agentlog-auto` 和 `openclaw-agent` 的所有功能
  - 自动会话存证（Hooks）
  - Trace 生命周期管理（Hand off）

## 迁移指南

1. 更新 Agent 配置，将 `agentlog-auto` 替换为 `openclaw-agent-log`
2. 所有 API 接口保持兼容，无需修改代码

## 历史

- `agentlog-auto`: 自动存证 Hooks
- `openclaw-agent`: Trace Hand off 功能
- `openclaw-agent-log`: 两者合并（2026-04-06）
