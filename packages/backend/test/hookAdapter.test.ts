/**
 * @agentlog/backend — HookEventAdapter 单元测试
 *
 * 使用 Node.js 内置的 node:test + node:assert。
 *
 * 运行方式：
 *   node --import tsx --test test/hookAdapter.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HookEventAdapter,
  adaptHookEvent,
  type CursorHookEvent,
  type ClineHookEvent,
  type OpenCodeHookEvent,
  type AdaptedSpanRequest,
} from "../src/utils/hookAdapter.js";

describe("HookEventAdapter", () => {
  describe("adaptHookEvent", () => {
    it("Cursor preToolUse 事件 → 映射为 agent 类型", () => {
      const event: CursorHookEvent = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolName: "cursor.edit",
        toolInput: { filePath: "/src/app.ts", content: "hello" },
        sessionId: "session-123",
        cwd: "/workspace",
      };

      const result = adaptHookEvent(event);

      assert.ok(result, "应返回有效结果");
      assert.equal(result!.traceId, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
      assert.equal(result!.actorType, "agent");
      assert.equal(result!.actorName, "cursor.edit");
      assert.equal(result!.payload.source, "cursor");
      assert.equal(result!.payload.event, "preToolUse");
      assert.equal(result!.payload.toolName, "cursor.edit");
      assert.deepEqual(result!.payload.toolInput, { filePath: "/src/app.ts", content: "hello" });
      assert.equal(result!.payload.sessionId, "session-123");
    });

    it("Cline tool.execute.before 事件 → 映射为 agent 类型", () => {
      const event: ClineHookEvent = {
        source: "cline",
        event: "tool.execute.before",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolName: "cline.read",
        toolInput: { path: "/tmp/test.ts" },
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.actorType, "agent");
      assert.equal(result!.actorName, "cline.read");
      assert.equal(result!.payload.source, "cline");
    });

    it("OpenCode preToolUse 事件 → 映射为 agent 类型", () => {
      const event: OpenCodeHookEvent = {
        source: "opencode",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolName: "bash",
        toolInput: { command: "ls -la" },
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.actorType, "agent");
      assert.equal(result!.actorName, "bash");
      assert.equal(result!.payload.source, "opencode");
    });

    it("postToolUse 事件 → 映射为 system 类型", () => {
      const event: CursorHookEvent = {
        source: "cursor",
        event: "postToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolName: "cursor.edit",
        toolResult: { success: true },
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.actorType, "system");
      assert.deepEqual(result!.payload.toolResult, { success: true });
    });

    it("tool.result 事件 → 映射为 system 类型", () => {
      const event: ClineHookEvent = {
        source: "cline",
        event: "tool.result",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolResult: { output: "file content" },
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.actorType, "system");
    });

    it("事件无 toolName → 使用 source 作为 actorName", () => {
      const event: OpenCodeHookEvent = {
        source: "opencode",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.actorName, "opencode");
    });

    it("事件指定 actorType → 使用指定值", () => {
      const event: CursorHookEvent = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolName: "cursor.edit",
        actorType: "human",
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.actorType, "human");
    });

    it("事件指定 actorName → 使用指定值", () => {
      const event: CursorHookEvent = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolName: "cursor.edit",
        actorName: "custom-agent",
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.actorName, "custom-agent");
    });

    it("traceId 为空 → 返回 null", () => {
      const event: CursorHookEvent = {
        source: "cursor",
        event: "preToolUse",
        traceId: "",
      };

      const result = adaptHookEvent(event);

      assert.equal(result, null);
    });

    it("traceId 缺失 → 返回 null", () => {
      const event = {
        source: "cursor",
        event: "preToolUse",
      } as unknown as CursorHookEvent;

      const result = adaptHookEvent(event);

      assert.equal(result, null);
    });

    it("携带 timestamp → 透传到 payload", () => {
      const event: CursorHookEvent = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        timestamp: "2025-01-15T10:30:00.000Z",
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.payload.timestamp, "2025-01-15T10:30:00.000Z");
    });

    it("携带 cwd → 透传到 payload", () => {
      const event: CursorHookEvent = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        cwd: "/home/user/project",
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.payload.cwd, "/home/user/project");
    });

    it("携带 sessionId → 透传到 payload", () => {
      const event: CursorHookEvent = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sessionId: "sess-abc-123",
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.payload.sessionId, "sess-abc-123");
    });
  });

  describe("HookEventAdapter 实例方法", () => {
    it("canAdapt 识别有效的 Cursor 事件", () => {
      const adapter = new HookEventAdapter();
      const body = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      };

      assert.equal(adapter.canAdapt(body), true);
    });

    it("canAdapt 识别有效的 Cline 事件", () => {
      const adapter = new HookEventAdapter();
      const body = {
        source: "cline",
        event: "tool.execute.before",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      };

      assert.equal(adapter.canAdapt(body), true);
    });

    it("canAdapt 识别有效的 OpenCode 事件", () => {
      const adapter = new HookEventAdapter();
      const body = {
        source: "opencode",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      };

      assert.equal(adapter.canAdapt(body), true);
    });

    it("canAdapt 拒绝无效 source", () => {
      const adapter = new HookEventAdapter();
      const body = {
        source: "invalid-agent",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      };

      assert.equal(adapter.canAdapt(body), false);
    });

    it("canAdapt 拒绝缺失 source", () => {
      const adapter = new HookEventAdapter();
      const body = {
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      };

      assert.equal(adapter.canAdapt(body), false);
    });

    it("canAdapt 拒绝缺失 traceId", () => {
      const adapter = new HookEventAdapter();
      const body = {
        source: "cursor",
        event: "preToolUse",
      };

      assert.equal(adapter.canAdapt(body), false);
    });

    it("canAdapt 拒绝非 object body", () => {
      const adapter = new HookEventAdapter();

      assert.equal(adapter.canAdapt(null), false);
      assert.equal(adapter.canAdapt(undefined), false);
      assert.equal(adapter.canAdapt("string"), false);
      assert.equal(adapter.canAdapt(123), false);
      assert.equal(adapter.canAdapt([]), false);
    });

    it("adapt 方法成功适配有效事件", () => {
      const adapter = new HookEventAdapter();
      const body = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolName: "cursor.edit",
      };

      const result = adapter.adapt(body);

      assert.ok(result);
      assert.equal(result!.actorName, "cursor.edit");
    });

    it("adapt 方法对无效 body 返回 null", () => {
      const adapter = new HookEventAdapter();
      const body = {
        source: "cursor",
        event: "preToolUse",
      };

      const result = adapter.adapt(body);

      assert.equal(result, null);
    });

    it("自定义 defaultActorType", () => {
      const adapter = new HookEventAdapter({ defaultActorType: "human" });
      const body = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolName: "cursor.edit",
      };

      const result = adapter.adapt(body);

      assert.ok(result);
      assert.equal(result!.actorType, "human");
    });

    it("自定义 defaultActorName", () => {
      const adapter = new HookEventAdapter({ defaultActorName: "my-agent" });
      const body = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      };

      const result = adapter.adapt(body);

      assert.ok(result);
      assert.equal(result!.actorName, "my-agent");
    });

    it("事件已有 actorType 时忽略 defaultActorType", () => {
      const adapter = new HookEventAdapter({ defaultActorType: "human" });
      const body = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolName: "cursor.edit",
        actorType: "system",
      };

      const result = adapter.adapt(body);

      assert.ok(result);
      assert.equal(result!.actorType, "system");
    });
  });

  describe("TraceID 透传", () => {
    it("原始 traceId 原样传递到结果", () => {
      const event: CursorHookEvent = {
        source: "cursor",
        event: "preToolUse",
        traceId: "CUSTOM_TRACE_ID_12345",
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.traceId, "CUSTOM_TRACE_ID_12345");
    });

    it("不同来源事件的 traceId 均正确透传", () => {
      const traceId = "TRACE_ID_UNIQUE";

      const cursorEvent: CursorHookEvent = {
        source: "cursor",
        event: "preToolUse",
        traceId,
      };

      const clineEvent: ClineHookEvent = {
        source: "cline",
        event: "preToolUse",
        traceId,
      };

      const opencodeEvent: OpenCodeHookEvent = {
        source: "opencode",
        event: "preToolUse",
        traceId,
      };

      assert.equal(adaptHookEvent(cursorEvent)!.traceId, traceId);
      assert.equal(adaptHookEvent(clineEvent)!.traceId, traceId);
      assert.equal(adaptHookEvent(opencodeEvent)!.traceId, traceId);
    });
  });

  describe("payload 结构完整性", () => {
    it("所有可选字段为空时 payload 仍包含 source 和 event", () => {
      const event: CursorHookEvent = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.deepEqual(result!.payload, {
        source: "cursor",
        event: "preToolUse",
      });
    });

    it("完整事件包含所有字段", () => {
      const event: CursorHookEvent = {
        source: "cursor",
        event: "preToolUse",
        traceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sessionId: "sess-123",
        timestamp: "2025-01-15T10:30:00.000Z",
        toolName: "cursor.edit",
        toolInput: { filePath: "/app.ts", content: "hello" },
        toolResult: { success: true },
        cwd: "/workspace",
      };

      const result = adaptHookEvent(event);

      assert.ok(result);
      assert.equal(result!.payload.source, "cursor");
      assert.equal(result!.payload.event, "preToolUse");
      assert.equal(result!.payload.sessionId, "sess-123");
      assert.equal(result!.payload.timestamp, "2025-01-15T10:30:00.000Z");
      assert.equal(result!.payload.toolName, "cursor.edit");
      assert.deepEqual(result!.payload.toolInput, { filePath: "/app.ts", content: "hello" });
      assert.deepEqual(result!.payload.toolResult, { success: true });
      assert.equal(result!.payload.cwd, "/workspace");
    });
  });
});
