/**
 * @agentlog/backend — Traces & Spans 单元测试
 *
 * 使用 Node.js 内置的 node:test + node:assert。
 * SQLite 使用内存数据库（:memory:），测试间完全隔离。
 *
 * 运行方式：
 *   node --import tsx --test test/traces.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// ── 重置模块级 DB 单例 ──────────────────────────────────────────────────
process.env.AGENTLOG_DB_PATH = ":memory:";

import {
  createTrace,
  createSpan,
  getTraceById,
  getSpanById,
  getSpansByTraceId,
  updateTrace,
  deleteTrace,
  deleteSpan,
  deleteSpansByTraceId,
  buildSpanTree,
  getSpanTree,
  getFullSpanTree,
  queryTraces,
  type TraceStatus,
} from "../src/services/traceService.js";
import { closeDatabase } from "../src/db/database.js";

describe("Trace CRUD", () => {
  after(() => {
    closeDatabase();
  });

  it("createTrace 创建 trace → 返回完整实体", () => {
    const trace = createTrace({ taskGoal: "实现用户登录功能" });
    assert.ok(trace.id, "应有 id");
    assert.ok(trace.taskGoal, "实现用户登录功能");
    assert.equal(trace.status, "running");
    assert.ok(trace.createdAt, "应有 createdAt");
    assert.ok(trace.updatedAt, "应有 updatedAt");
    assert.ok(trace.id.length > 10, "ULID 应有一定长度");
  });

  it("createTrace 支持指定 status", () => {
    const trace = createTrace({ taskGoal: "测试任务", status: "paused" });
    assert.equal(trace.status, "paused");
  });

  it("getTraceById 获取存在的 trace → 返回实体", () => {
    const created = createTrace({ taskGoal: "查询测试" });
    const found = getTraceById(created.id);
    assert.ok(found, "应能找到");
    assert.equal(found!.id, created.id);
    assert.equal(found!.taskGoal, "查询测试");
  });

  it("getTraceById 获取不存在的 id → 返回 null", () => {
    const found = getTraceById("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert.equal(found, null);
  });

  it("updateTrace 更新 taskGoal → 返回更新后实体", () => {
    const original = createTrace({ taskGoal: "原始目标" });
    const updated = updateTrace(original.id, { taskGoal: "新目标" });
    assert.ok(updated);
    assert.equal(updated!.taskGoal, "新目标");
    assert.equal(updated!.status, "running");
  });

  it("updateTrace 更新 status → 返回更新后实体", () => {
    const original = createTrace({ taskGoal: "测试状态更新" });
    const updated = updateTrace(original.id, { status: "completed" });
    assert.ok(updated);
    assert.equal(updated!.status, "completed");
    assert.ok(updated!.updatedAt >= original.createdAt);
  });

  it("updateTrace 更新不存在的 id → 返回 null", () => {
    const result = updateTrace("01ARZ3NDEKTSV4RRFFQ69G5FAV", { status: "failed" });
    assert.equal(result, null);
  });

  it("deleteTrace 删除存在的 trace → 返回 true", () => {
    const trace = createTrace({ taskGoal: "待删除" });
    const deleted = deleteTrace(trace.id);
    assert.equal(deleted, true);
    assert.equal(getTraceById(trace.id), null);
  });

  it("deleteTrace 删除不存在的 trace → 返回 false", () => {
    const deleted = deleteTrace("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert.equal(deleted, false);
  });

  it("queryTraces 无过滤条件 → 返回分页列表", () => {
    createTrace({ taskGoal: "任务1" });
    createTrace({ taskGoal: "任务2" });
    createTrace({ taskGoal: "任务3" });

    const result = queryTraces();
    assert.ok(result.total >= 3);
    assert.ok(result.data.length <= result.pageSize);
    assert.equal(result.page, 1);
  });

  it("queryTraces 按 status 过滤 → 仅返回匹配项", () => {
    createTrace({ taskGoal: "running任务", status: "running" });
    createTrace({ taskGoal: "completed任务", status: "completed" });

    const running = queryTraces({ status: "running" as TraceStatus });
    const completed = queryTraces({ status: "completed" as TraceStatus });

    for (const t of running.data) {
      assert.equal(t.status, "running");
    }
    for (const t of completed.data) {
      assert.equal(t.status, "completed");
    }
  });
});

describe("Span CRUD", () => {
  let traceId: string;

  before(() => {
    const trace = createTrace({ taskGoal: "Span 测试 trace" });
    traceId = trace.id;
  });

  after(() => {
    closeDatabase();
  });

  it("createSpan 创建 span → 返回完整实体", () => {
    const span = createSpan({
      traceId,
      actorType: "agent",
      actorName: "test-agent",
      payload: { action: "read_file", path: "/tmp/test.ts" },
    });

    assert.ok(span.id, "应有 id");
    assert.equal(span.traceId, traceId);
    assert.equal(span.parentSpanId, null);
    assert.equal(span.actorType, "agent");
    assert.equal(span.actorName, "test-agent");
    assert.deepEqual(span.payload, { action: "read_file", path: "/tmp/test.ts" });
    assert.ok(span.createdAt);
  });

  it("createSpan 带 parentSpanId → 正确关联父子关系", () => {
    const parent = createSpan({
      traceId,
      actorType: "agent",
      actorName: "parent-agent",
    });

    const child = createSpan({
      traceId,
      parentSpanId: parent.id,
      actorType: "system",
      actorName: "child-system",
    });

    assert.equal(child.parentSpanId, parent.id);
  });

  it("getSpanById 获取存在的 span → 返回实体", () => {
    const created = createSpan({
      traceId,
      actorType: "human",
      actorName: "test-human",
    });

    const found = getSpanById(created.id);
    assert.ok(found);
    assert.equal(found!.id, created.id);
  });

  it("getSpanById 获取不存在的 id → 返回 null", () => {
    const found = getSpanById("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert.equal(found, null);
  });

  it("getSpansByTraceId → 返回该 trace 下所有 span（按时序）", () => {
    const span1 = createSpan({ traceId, actorType: "agent", actorName: "span1" });
    const span2 = createSpan({ traceId, actorType: "agent", actorName: "span2" });

    const spans = getSpansByTraceId(traceId);
    assert.ok(spans.length >= 2);

    const ids = spans.map(s => s.id);
    assert.ok(ids.indexOf(span1.id) < ids.indexOf(span2.id));
  });

  it("deleteSpan 删除存在的 span → 返回 true", () => {
    const span = createSpan({ traceId, actorType: "system", actorName: "待删除" });
    const deleted = deleteSpan(span.id);
    assert.equal(deleted, true);
    assert.equal(getSpanById(span.id), null);
  });

  it("deleteSpan 删除不存在的 span → 返回 false", () => {
    const deleted = deleteSpan("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert.equal(deleted, false);
  });

  it("deleteSpansByTraceId → 删除该 trace 下所有 span", () => {
    const newTrace = createTrace({ taskGoal: "待删除子 spans" });
    createSpan({ traceId: newTrace.id, actorType: "agent", actorName: "span-a" });
    createSpan({ traceId: newTrace.id, actorType: "agent", actorName: "span-b" });

    const count = deleteSpansByTraceId(newTrace.id);
    assert.ok(count >= 2);
    assert.equal(getSpansByTraceId(newTrace.id).length, 0);
  });
});

describe("Span Tree 构建", () => {
  let traceId: string;

  before(() => {
    const trace = createTrace({ taskGoal: "Tree 构建测试" });
    traceId = trace.id;
  });

  after(() => {
    closeDatabase();
  });

  it("buildSpanTree 空 trace → 返回空数组", () => {
    const newTrace = createTrace({ taskGoal: "空 trace" });
    const tree = buildSpanTree(newTrace.id);
    assert.deepEqual(tree, []);
  });

  it("buildSpanTree 扁平 spans（无父子） → 全部为根节点", () => {
    const newTrace = createTrace({ taskGoal: "扁平 spans" });
    const span1 = createSpan({ traceId: newTrace.id, actorType: "agent", actorName: "a1" });
    const span2 = createSpan({ traceId: newTrace.id, actorType: "agent", actorName: "a2" });

    const tree = buildSpanTree(newTrace.id);
    assert.equal(tree.length, 2);

    const rootIds = tree.map(n => n.id);
    assert.ok(rootIds.includes(span1.id));
    assert.ok(rootIds.includes(span2.id));
  });

  it("buildSpanTree 有父子关系 → 正确构建树状结构", () => {
    const newTrace = createTrace({ taskGoal: "树状结构测试" });

    const root1 = createSpan({ traceId: newTrace.id, actorType: "agent", actorName: "root1" });
    const root2 = createSpan({ traceId: newTrace.id, actorType: "human", actorName: "root2" });

    const child1a = createSpan({ traceId: newTrace.id, parentSpanId: root1.id, actorType: "agent", actorName: "child1a" });
    const child1b = createSpan({ traceId: newTrace.id, parentSpanId: root1.id, actorType: "system", actorName: "child1b" });
    const child2a = createSpan({ traceId: newTrace.id, parentSpanId: root2.id, actorType: "agent", actorName: "child2a" });

    const tree = buildSpanTree(newTrace.id);
    assert.equal(tree.length, 2);

    const root1Node = tree.find(n => n.id === root1.id)!;
    const root2Node = tree.find(n => n.id === root2.id)!;

    assert.equal(root1Node.children.length, 2);
    assert.equal(root2Node.children.length, 1);

    const child1aNode = root1Node.children.find(n => n.id === child1a.id);
    const child1bNode = root1Node.children.find(n => n.id === child1b.id);
    const child2aNode = root2Node.children.find(n => n.id === child2a.id);

    assert.ok(child1aNode);
    assert.ok(child1bNode);
    assert.ok(child2aNode);
    assert.equal(child1aNode!.children.length, 0);
  });

  it("buildSpanTree 深层嵌套 → 递归构建正确", () => {
    const newTrace = createTrace({ taskGoal: "深层嵌套测试" });

    const level0 = createSpan({ traceId: newTrace.id, actorType: "agent", actorName: "L0" });
    const level1 = createSpan({ traceId: newTrace.id, parentSpanId: level0.id, actorType: "agent", actorName: "L1" });
    const level2 = createSpan({ traceId: newTrace.id, parentSpanId: level1.id, actorType: "agent", actorName: "L2" });
    const level3 = createSpan({ traceId: newTrace.id, parentSpanId: level2.id, actorType: "agent", actorName: "L3" });

    const tree = buildSpanTree(newTrace.id);
    assert.equal(tree.length, 1);

    let current = tree[0];
    assert.equal(current.id, level0.id);

    current = current.children[0];
    assert.equal(current.id, level1.id);

    current = current.children[0];
    assert.equal(current.id, level2.id);

    current = current.children[0];
    assert.equal(current.id, level3.id);
    assert.equal(current.children.length, 0);
  });

  it("getSpanTree 等价于 buildSpanTree", () => {
    const newTrace = createTrace({ taskGoal: "等价测试" });
    const span = createSpan({ traceId: newTrace.id, actorType: "agent", actorName: "test" });

    const byFunc = buildSpanTree(newTrace.id);
    const byGetter = getSpanTree(newTrace.id);

    assert.equal(byFunc.length, byGetter.length);
    assert.equal(byFunc[0]?.id, span.id);
  });

  it("getFullSpanTree 返回 trace 和完整树", () => {
    const newTrace = createTrace({ taskGoal: "完整树测试", status: "running" });
    createSpan({ traceId: newTrace.id, actorType: "agent", actorName: "span-1" });

    const result = getFullSpanTree(newTrace.id);

    assert.ok(result.trace);
    assert.equal(result.trace!.id, newTrace.id);
    assert.equal(result.trace!.taskGoal, "完整树测试");
    assert.equal(result.trace!.status, "running");
    assert.equal(result.tree.length, 1);
  });

  it("getFullSpanTree 不存在的 trace → 返回 null trace 和空树", () => {
    const result = getFullSpanTree("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert.equal(result.trace, null);
    assert.deepEqual(result.tree, []);
  });
});

describe("ULID 特性验证", () => {
  it("ULID 唯一性 → 连续生成的 ID 均不同", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const trace = createTrace({ taskGoal: `ULID-唯一性-${i}` });
      ids.add(trace.id);
    }
    assert.equal(ids.size, 100);
  });

  it("ULID 时间排序 → 后创建的 trace ID 字典序大于先创建的", () => {
    const trace1 = createTrace({ taskGoal: "先创建" });
    const trace2 = createTrace({ taskGoal: "后创建" });
    assert.ok(trace2.id > trace1.id, "后创建的 trace ID 应大于先创建的");
  });
});

describe("跨层级回溯关联", () => {
  it("完整 Span Tree 可跨层级回溯关联", () => {
    const newTrace = createTrace({ taskGoal: "跨层级回溯测试" });

    const root = createSpan({ traceId: newTrace.id, actorType: "agent", actorName: "root" });
    const child = createSpan({ traceId: newTrace.id, parentSpanId: root.id, actorType: "agent", actorName: "child" });
    const grandchild = createSpan({ traceId: newTrace.id, parentSpanId: child.id, actorType: "agent", actorName: "grandchild" });

    const tree = buildSpanTree(newTrace.id);
    assert.equal(tree.length, 1);

    const rootNode = tree[0];
    assert.equal(rootNode.actorName, "root");
    assert.equal(rootNode.children.length, 1);

    const childNode = rootNode.children[0];
    assert.equal(childNode.actorName, "child");
    assert.equal(childNode.children.length, 1);

    const grandchildNode = childNode.children[0];
    assert.equal(grandchildNode.actorName, "grandchild");
    assert.equal(grandchildNode.children.length, 0);

    assert.equal(grandchildNode.parentSpanId, child.id);
    assert.equal(childNode.parentSpanId, root.id);
    assert.equal(rootNode.parentSpanId, null);
  });

  it("删除中间节点 → 子节点成为新的根节点（孤立节点处理）", () => {
    const newTrace = createTrace({ taskGoal: "删除中间节点测试" });

    const root = createSpan({ traceId: newTrace.id, actorType: "agent", actorName: "root" });
    const child = createSpan({ traceId: newTrace.id, parentSpanId: root.id, actorType: "agent", actorName: "child" });
    const grandchild = createSpan({ traceId: newTrace.id, parentSpanId: child.id, actorType: "agent", actorName: "grandchild" });

    deleteSpan(child.id);

    const tree = buildSpanTree(newTrace.id);
    assert.equal(tree.length, 2);

    const rootIds = tree.map(n => n.id);
    assert.ok(rootIds.includes(root.id));
    assert.ok(rootIds.includes(grandchild.id));
    assert.ok(!rootIds.includes(child.id));
  });
});


