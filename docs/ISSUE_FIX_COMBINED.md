# Issue #10 修复方案：A+B 组合

**问题**：log_intent 和 log_turn 调用顺序混乱，导致 prompt/response 显示 "(pending)"

**组合方案**：方案 A（流程约束）+ 方案 B（兜底逻辑）

---

## 方案 A：强制 log_turn 先于 log_intent

### 逻辑

```
1. Agent 开始任务
2. 立即调用 log_turn（首次）→ 建立 session，返回 session_id
3. 工作中多次 log_turn → 追加 transcript
4. 任务结束 log_intent → 汇总
```

### 实现

在 log_intent 中检测：如果没有 transcript 且没有 session_id，则拒绝创建 session

```typescript
// log_intent 入口检查
if (!existingSessionId && (!transcript || transcript.length === 0)) {
  // 错误：没有 session_id 且没有 transcript，无法创建有意义的 session
  return {
    isError: true,
    content: [{
      type: "text",
      text: "错误：log_intent 需要先通过 log_turn 建立 session，或传入完整 transcript"
    }]
  };
}
```

---

## 方案 B：log_intent 创建 session 时直接使用 task 作为 prompt

### 逻辑

当 log_intent 没有 session_id 且有 transcript 时：
- 直接用 task 作为 prompt（不占位）
- 用 transcript 生成 formattedTranscript

### 实现

```typescript
// log_intent 创建新 session
if (!existingSessionId) {
  const finalPrompt = task || "Untitled Task";
  
  // 从 transcript 生成 summary
  let summary = "";
  if (transcript && transcript.length > 0) {
    summary = transcript
      .filter(t => t.role === "assistant")
      .map(t => t.content?.slice(0, 100))
      .join("; ");
  }
  
  resultId = await postSession({
    provider: provider || "unknown",
    model: model || "unknown",
    source: source || "unknown",
    prompt: finalPrompt,           // 直接用 task，不占位
    response: summary || finalPrompt,  // 用 summary 作为 response
    ...
  });
}
```

---

## A+B 组合效果

| 场景 | 方案 A | 方案 B |
|------|--------|--------|
| 先 log_turn 后 log_intent | ✅ 正常工作 | ✅ 使用 transcript summary |
| 直接 log_intent（无 session_id） | ❌ 拒绝创建 | ✅ 用 task 作为 prompt |
| 有 session_id 但无 transcript | ✅ 拒绝 | ✅ 创建 session |
| log_turn 首次调用 | - | ✅ 自动更新 prompt/response |

---

## 修改文件

`packages/backend/src/mcp.ts`

### 1. log_intent 入口检查（方案 A）

```typescript
// log_intent 入口
if (request.params.name === "log_intent") {
  // ... 参数解析 ...
  
  // 新增：入口检查
  if (!existingSessionId && (!transcript || transcript.length === 0)) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: "错误：log_intent 需要先通过 log_turn 建立 session，或传入完整 transcript"
      }]
    };
  }
}
```

### 2. log_intent 创建 session 时直接用 task（方案 B）

```typescript
// 当 existingSessionId 不存在时
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
    provider,
    model,
    source,
    workspacePath: workspacePath || "",
    prompt: finalPrompt,  // 直接用 task，不占位
    response: summary || finalPrompt,
    affectedFiles: affectedFiles || [],
    durationMs: explicitDurationMs || 0,
    ...(transcript && transcript.length > 0 ? { transcript } : {}),
  });
}
```

---

## 测试用例

| 用例 | 输入 | 预期输出 |
|------|------|----------|
| 1 | log_intent 无 session_id，无 transcript | 拒绝创建，返回错误 |
| 2 | log_intent 无 session_id，有 transcript | 创建 session，prompt=task |
| 3 | log_intent 有 session_id | 正常更新 |
| 4 | log_turn 首次调用 | 建立 session，prompt=首条消息 |

---

**Architect**: 🏗️  
**Date**: 2026-04-02
