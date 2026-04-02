# Issue #10 修复方案：A+B 组合（修正版）

**问题**：log_intent 和 log_turn 调用顺序混乱，导致 prompt/response 显示 "(pending)"

**修正说明**：方案 A 是**规范约束**（强制说明），不是代码拒绝

---

## 方案 A：规范约束（强制说明调用顺序）

### 原理

在 Agent 调用 log_intent 的工具描述中，明确**强制要求**先调用 log_turn 建立 session。

### 实现

修改 log_intent 的 description，添加强制说明：

```typescript
// mcp.ts - log_intent 工具定义
name: "log_intent",
description:
  "⚠️ 重要：必须先调用 log_turn 建立 session_id，再调用此工具汇总任务。" +
  "调用顺序：1) log_turn(首次) → 2) log_turn(后续) → 3) log_intent(最后)" +
  "违反此顺序将导致存证数据不完整。",
```

### 强制说明内容

```
【强制调用顺序】
1. 任务开始 → log_turn（首次）→ 返回 session_id
2. 任务进行 → log_turn（多次）→ 追加 transcript
3. 任务结束 → log_intent → 汇总

【禁止】
- 禁止在 log_turn 之前调用 log_intent
- 禁止不使用 log_turn 直接调用 log_intent
```

---

## 方案 B：log_intent 创建 session 时直接用 task 作为 prompt（兜底）

### 原理

如果 Agent 仍然违反顺序直接调用 log_intent（无 session_id），则用 task 作为 prompt 而非占位符。

### 实现

```typescript
// log_intent 创建新 session 时
if (!existingSessionId) {
  const finalPrompt = task || "Untitled Task";
  
  // 从 transcript 生成 summary
  let summary = "";
  if (transcript && transcript.length > 0) {
    summary = transcript
      .filter(t => t.role === "assistant")
      .map(t => t.content?.slice(0, 200))
      .join("; ");
  }
  
  resultId = await postSession({
    prompt: finalPrompt,  // 直接用 task，不占位
    response: summary || finalPrompt,
    ...
  });
}
```

---

## A+B 组合效果

| 场景 | 方案 A（规范） | 方案 B（兜底） |
|------|---------------|----------------|
| 先 log_turn 后 log_intent | ✅ 正常工作 | ✅ 使用 transcript |
| 违反顺序直接 log_intent | ⚠️ 警告 | ✅ 用 task 作为 prompt |
| 无 session_id 无 transcript | ⚠️ 警告 | ❌ 无法创建 |

---

## 修改文件

`packages/backend/src/mcp.ts`

---

## 修改内容

### 1. log_intent description（方案 A）

```typescript
name: "log_intent",
description:
  "⚠️ 强制调用顺序：1) log_turn(首次) → 2) log_turn(后续) → 3) log_intent(最后)" +
  "禁止在 log_turn 之前调用此工具，否则存证数据将不完整。",
```

### 2. log_intent 创建 session 逻辑（方案 B）

```typescript
if (!existingSessionId) {
  const finalPrompt = task || "Untitled Task";
  
  let summary = "";
  if (transcript && transcript.length > 0) {
    summary = transcript
      .filter(t => t.role === "assistant")
      .map(t => t.content?.slice(0, 200))
      .join("; ");
  }
  
  resultId = await postSession({
    prompt: finalPrompt,
    response: summary || finalPrompt,
    ...
  });
}
```

---

## 测试用例

| 用例 | 预期 |
|------|------|
| 正常顺序：log_turn → log_intent | ✅ 正常工作 |
| 违反顺序直接 log_intent | ⚠️ 警告 + 用 task 作为 prompt |
| log_intent 无 session_id 无 transcript | ⚠️ 警告 + 创建 session（task 作为 prompt） |

---

**Architect**: 🏗️  
**Date**: 2026-04-02  
**Version**: v2（修正版）
