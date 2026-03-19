/**
 * @agentlog/backend — 集成测试
 *
 * 使用 Node.js 内置的 node:test + node:assert，无需额外测试框架。
 * 每个 suite 启动一个独立的 Fastify 实例（随机端口），测试完毕后关闭。
 * SQLite 使用内存数据库（:memory:），测试间完全隔离。
 *
 * 运行方式：
 *   pnpm --filter @agentlog/backend test
 *   # 或直接：
 *   node --import tsx/esm --test test/integration.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";

// ── 重置模块级 DB 单例，让每个 suite 使用独立内存 DB ──────────────────────
// 必须在导入 routes 之前设置，保证 getDatabase() 使用 :memory:
process.env.AGENTLOG_DB_PATH = ":memory:";

import sessionsRoutes from "../src/routes/sessions.js";
import commitsRouter from "../src/routes/commits.js";
import { exportRoutes } from "../src/routes/export.js";
import { getDatabase, closeDatabase } from "../src/db/database.js";

// ─────────────────────────────────────────────
// 工厂：构建并启动一个独立 Fastify 实例
// ─────────────────────────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  app.get("/health", async (_req, reply) => {
    return reply.send({
      status: "ok",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    });
  });

  app.get("/api", async (_req, reply) => {
    return reply.send({
      name: "AgentLog Backend",
      version: "0.1.0",
      description: "AI 编程行车记录仪 — 本地轻量后台服务",
      endpoints: {
        sessions: "/api/sessions",
        commits: "/api/commits",
        export: "/api/export",
        health: "/health",
      },
    });
  });

  await app.register(sessionsRoutes);
  await app.register(commitsRouter, { prefix: "/api/commits" });
  await exportRoutes(app);

  app.setErrorHandler((error, _req, reply) => {
    if (error.validation) {
      return reply
        .status(400)
        .send({ success: false, error: "校验失败", details: error.validation });
    }
    return reply
      .status(error.statusCode ?? 500)
      .send({ success: false, error: error.message });
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send({ success: false, error: "接口不存在" });
  });

  await app.listen({ port: 0, host: "127.0.0.1" }); // port: 0 → 随机可用端口
  return app;
}

// ─────────────────────────────────────────────
// 轻量 HTTP 请求助手（使用 Node 内置 fetch，Node ≥ 18）
// ─────────────────────────────────────────────

function baseUrl(app: FastifyInstance): string {
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("无法获取服务地址");
  return `http://127.0.0.1:${addr.port}`;
}

async function req<T = unknown>(
  app: FastifyInstance,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const url = `${baseUrl(app)}${path}`;
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    parsed = text as unknown as T;
  }
  return { status: res.status, body: parsed };
}

// ─────────────────────────────────────────────
// 共享测试数据
// ─────────────────────────────────────────────

const SAMPLE_SESSION = {
  provider: "deepseek",
  model: "deepseek-r1",
  source: "cline",
  workspacePath: "/tmp/test-project",
  prompt: "帮我重构 getUserById 函数，使其支持缓存",
  reasoning:
    "<think>用户希望在 getUserById 中加入缓存层，可以使用 Map 或 Redis……</think>",
  response:
    "好的，以下是重构后的 getUserById 函数，使用了 Map 作为本地缓存：\n```ts\nconst cache = new Map();\n```",
  affectedFiles: ["src/user/service.ts", "src/user/cache.ts"],
  durationMs: 3200,
  tags: ["重构", "缓存"],
  note: "这次 AI 建议使用 Map，性能不错",
};

// ─────────────────────────────────────────────
// 测试 Suite 1：Health Check
// ─────────────────────────────────────────────

describe("Health Check", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp();
  });

  after(async () => {
    await app.close();
    closeDatabase();
  });

  it("GET /health 返回 200 和 status: ok", async () => {
    const { status, body } = await req<{ status: string; version: string }>(
      app,
      "GET",
      "/health",
    );
    assert.equal(status, 200);
    assert.equal((body as any).status, "ok");
    assert.ok((body as any).version, "应该包含 version 字段");
    assert.ok(typeof (body as any).uptime === "number", "uptime 应为数字");
  });

  it("GET /api 返回 API 元信息", async () => {
    const { status, body } = await req<any>(app, "GET", "/api");
    assert.equal(status, 200);
    assert.ok((body as any).name, "应包含服务名称");
    assert.ok((body as any).endpoints, "应包含端点列表");
  });

  it("GET /nonexistent 返回 404", async () => {
    const { status, body } = await req<any>(app, "GET", "/nonexistent");
    assert.equal(status, 404);
    assert.equal((body as any).success, false);
  });
});

// ─────────────────────────────────────────────
// 测试 Suite 2：Session CRUD
// ─────────────────────────────────────────────

describe("Session CRUD", () => {
  let app: FastifyInstance;
  let createdSessionId: string;

  before(async () => {
    app = await buildApp();
  });

  after(async () => {
    await app.close();
    closeDatabase();
  });

  it("POST /api/sessions 创建会话 → 返回 201 和完整实体", async () => {
    const { status, body } = await req<any>(
      app,
      "POST",
      "/api/sessions",
      SAMPLE_SESSION,
    );

    assert.equal(
      status,
      201,
      `预期 201，实际 ${status}，响应：${JSON.stringify(body)}`,
    );
    assert.equal(body.success, true);

    const session = body.data;
    assert.ok(session.id, "应该有 id");
    assert.ok(session.createdAt, "应该有 createdAt");
    assert.equal(session.provider, "deepseek");
    assert.equal(session.model, "deepseek-r1");
    assert.equal(session.source, "cline");
    assert.equal(session.workspacePath, "/tmp/test-project");
    assert.equal(session.prompt, SAMPLE_SESSION.prompt);
    assert.ok(session.reasoning, "应该保存 reasoning");
    assert.equal(session.durationMs, 3200);
    assert.deepEqual(session.tags, ["重构", "缓存"]);
    assert.equal(session.note, SAMPLE_SESSION.note);
    assert.deepEqual(session.affectedFiles, SAMPLE_SESSION.affectedFiles);
    assert.equal(session.commitHash, undefined, "新建会话不应绑定 commit");

    createdSessionId = session.id;
  });

  it("POST /api/sessions 缺少必填字段 prompt → 400", async () => {
    const { status, body } = await req<any>(app, "POST", "/api/sessions", {
      provider: "deepseek",
      model: "deepseek-r1",
      source: "cline",
      workspacePath: "/tmp/test",
      response: "some response",
      durationMs: 100,
    });
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });

  it("GET /api/sessions/:id 获取刚创建的会话", async () => {
    const { status, body } = await req<any>(
      app,
      "GET",
      `/api/sessions/${createdSessionId}`,
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.id, createdSessionId);
    assert.equal(body.data.model, "deepseek-r1");
  });

  it("GET /api/sessions/:id 不存在的 ID → 404", async () => {
    const { status, body } = await req<any>(
      app,
      "GET",
      "/api/sessions/nonexistent-id-xyz",
    );
    assert.equal(status, 404);
    assert.equal(body.success, false);
  });

  it("GET /api/sessions 返回分页列表", async () => {
    const { status, body } = await req<any>(app, "GET", "/api/sessions");
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data.data), "data.data 应为数组");
    assert.ok(body.data.total >= 1, "total 应 >= 1");
    assert.equal(body.data.page, 1);
  });

  it("GET /api/sessions?keyword= 关键词过滤生效", async () => {
    const { status, body } = await req<any>(
      app,
      "GET",
      "/api/sessions?keyword=getUserById",
    );
    assert.equal(status, 200);
    assert.equal(body.data.data.length, 1, "应命中 1 条");

    const none = await req<any>(
      app,
      "GET",
      "/api/sessions?keyword=绝对不存在的内容xyz",
    );
    assert.equal(none.body.data.total, 0);
  });

  it("GET /api/sessions?workspacePath= 路径过滤生效", async () => {
    const { status, body } = await req<any>(
      app,
      "GET",
      "/api/sessions?workspacePath=/tmp/test-project",
    );
    assert.equal(status, 200);
    assert.ok(body.data.total >= 1);

    const other = await req<any>(
      app,
      "GET",
      "/api/sessions?workspacePath=/tmp/other-project",
    );
    assert.equal(other.body.data.total, 0);
  });

  it("PATCH /api/sessions/:id/tags 更新标签", async () => {
    const { status, body } = await req<any>(
      app,
      "PATCH",
      `/api/sessions/${createdSessionId}/tags`,
      { tags: ["bugfix", "性能优化", "重构"] },
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.data.tags, ["bugfix", "性能优化", "重构"]);
  });

  it("PATCH /api/sessions/:id/tags 传非数组 → 400", async () => {
    const { status, body } = await req<any>(
      app,
      "PATCH",
      `/api/sessions/${createdSessionId}/tags`,
      { tags: "not-an-array" },
    );
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });

  it("PATCH /api/sessions/:id/note 更新备注", async () => {
    const { status, body } = await req<any>(
      app,
      "PATCH",
      `/api/sessions/${createdSessionId}/note`,
      {
        note: "经过测试，Map 缓存在高并发场景下有 race condition，需要改为 Redis",
      },
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(body.data.note.includes("Redis"));
  });

  it("PATCH /api/sessions/:id/commit 绑定 Commit Hash", async () => {
    const hash = "abc1234def567";
    const { status, body } = await req<any>(
      app,
      "PATCH",
      `/api/sessions/${createdSessionId}/commit`,
      { commitHash: hash },
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.commitHash, hash);
  });

  it("PATCH /api/sessions/:id/commit 传 null 解绑", async () => {
    const { status, body } = await req<any>(
      app,
      "PATCH",
      `/api/sessions/${createdSessionId}/commit`,
      { commitHash: null },
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(
      body.data.commitHash,
      undefined,
      "解绑后 commitHash 应为 undefined",
    );
  });

  it("GET /api/sessions/stats 返回统计数据", async () => {
    const { status, body } = await req<any>(app, "GET", "/api/sessions/stats");
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(typeof body.data.total === "number");
    assert.ok(typeof body.data.boundToCommit === "number");
    assert.ok(typeof body.data.unbound === "number");
    assert.ok(typeof body.data.avgDurationMs === "number");
    assert.ok(body.data.byProvider, "应包含 byProvider 字段");
  });

  it("GET /api/sessions/unbound 返回未绑定会话列表", async () => {
    const { status, body } = await req<any>(
      app,
      "GET",
      `/api/sessions/unbound?workspacePath=/tmp/test-project`,
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data));
    // 刚才解绑了，所以应该有 1 条
    assert.ok(body.data.length >= 1);
    // 每条都不应有 commitHash
    for (const s of body.data) {
      assert.ok(!s.commitHash, "unbound 接口返回的会话不应有 commitHash");
    }
  });

  it("GET /api/sessions/unbound 缺少 workspacePath → 400", async () => {
    const { status, body } = await req<any>(
      app,
      "GET",
      "/api/sessions/unbound",
    );
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });

  it("DELETE /api/sessions/:id 删除会话", async () => {
    // 先创建一个临时会话
    const createRes = await req<any>(app, "POST", "/api/sessions", {
      ...SAMPLE_SESSION,
      prompt: "临时会话，用于测试删除",
    });
    const tmpId = createRes.body.data.id;

    const { status, body } = await req<any>(
      app,
      "DELETE",
      `/api/sessions/${tmpId}`,
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);

    // 确认已删除
    const getRes = await req<any>(app, "GET", `/api/sessions/${tmpId}`);
    assert.equal(getRes.status, 404);
  });
});

// ─────────────────────────────────────────────
// 测试 Suite 3：Commit 绑定
// ─────────────────────────────────────────────

describe("Commit 绑定", () => {
  let app: FastifyInstance;
  let sessionId1: string;
  let sessionId2: string;

  before(async () => {
    app = await buildApp();

    // 预先创建两条会话
    const r1 = await req<any>(app, "POST", "/api/sessions", {
      ...SAMPLE_SESSION,
      prompt: "会话1：实现用户登录接口",
    });
    sessionId1 = r1.body.data.id;

    const r2 = await req<any>(app, "POST", "/api/sessions", {
      ...SAMPLE_SESSION,
      prompt: "会话2：添加 JWT 鉴权中间件",
    });
    sessionId2 = r2.body.data.id;
  });

  after(async () => {
    await app.close();
    closeDatabase();
  });

  it("POST /api/commits/bind 批量绑定会话到 Commit", async () => {
    const { status, body } = await req<any>(app, "POST", "/api/commits/bind", {
      sessionIds: [sessionId1, sessionId2],
      commitHash: "feed1234abcd5678",
      workspacePath: "/tmp/test-project",
    });

    assert.equal(
      status,
      200,
      `预期 200，实际 ${status}，响应：${JSON.stringify(body)}`,
    );
    assert.equal(body.success, true);

    const binding = body.data;
    assert.equal(binding.commitHash, "feed1234abcd5678");
    assert.ok(binding.sessionIds.includes(sessionId1));
    assert.ok(binding.sessionIds.includes(sessionId2));
  });

  it("绑定后 GET /api/sessions/:id 的 commitHash 字段已更新", async () => {
    const { body } = await req<any>(app, "GET", `/api/sessions/${sessionId1}`);
    assert.equal(body.data.commitHash, "feed1234abcd5678");
  });

  it("GET /api/commits/:hash 查询 Commit 绑定记录", async () => {
    const { status, body } = await req<any>(
      app,
      "GET",
      "/api/commits/feed1234abcd5678",
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.commitHash, "feed1234abcd5678");
    assert.ok(body.data.sessionIds.length === 2);
  });

  it("GET /api/commits/:hash 支持短 hash 前缀匹配", async () => {
    const { status, body } = await req<any>(
      app,
      "GET",
      "/api/commits/feed1234",
    );
    assert.equal(status, 200);
    assert.equal(body.data.commitHash, "feed1234abcd5678");
  });

  it("GET /api/commits/:hash 不存在的 hash → 404", async () => {
    const { status, body } = await req<any>(
      app,
      "GET",
      "/api/commits/0000000000000000",
    );
    assert.equal(status, 404);
    assert.equal(body.success, false);
  });

  it("GET /api/commits 列出所有 Commit 绑定（分页）", async () => {
    const { status, body } = await req<any>(app, "GET", "/api/commits/");
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(body.data.total >= 1);
    assert.ok(Array.isArray(body.data.data));
  });

  it("DELETE /api/commits/unbind/:sessionId 解绑单条会话", async () => {
    const { status, body } = await req<any>(
      app,
      "DELETE",
      `/api/commits/unbind/${sessionId1}`,
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);

    // 验证 agent_sessions 中 commitHash 已清除
    const sessionRes = await req<any>(
      app,
      "GET",
      `/api/sessions/${sessionId1}`,
    );
    assert.equal(
      sessionRes.body.data.commitHash,
      undefined,
      "解绑后 commitHash 应为 undefined",
    );
  });

  it("DELETE /api/commits/unbind/:sessionId 对未绑定会话 → 400", async () => {
    // sessionId1 已经被解绑，再解绑应报错
    const { status, body } = await req<any>(
      app,
      "DELETE",
      `/api/commits/unbind/${sessionId1}`,
    );
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });

  it("POST /api/commits/bind 传不存在的 sessionId → 404", async () => {
    const { status, body } = await req<any>(app, "POST", "/api/commits/bind", {
      sessionIds: ["nonexistent-session-id"],
      commitHash: "deadbeef12345678",
    });
    assert.equal(status, 404);
    assert.equal(body.success, false);
  });
});

// ─────────────────────────────────────────────
// 测试 Suite 4：导出
// ─────────────────────────────────────────────

describe("导出（Export）", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp();

    // 预先插入若干条会话
    for (let i = 1; i <= 3; i++) {
      await req<any>(app, "POST", "/api/sessions", {
        ...SAMPLE_SESSION,
        prompt: `测试导出 #${i}：帮我优化第 ${i} 个函数`,
        model:
          i === 1 ? "deepseek-r1" : i === 2 ? "qwen-max" : "moonshot-v1-8k",
        provider: i === 1 ? "deepseek" : i === 2 ? "qwen" : "kimi",
        tags: [`tag-${i}`],
      });
    }
  });

  after(async () => {
    await app.close();
    closeDatabase();
  });

  it("GET /api/export/formats 返回支持的格式列表", async () => {
    const { status, body } = await req<any>(app, "GET", "/api/export/formats");
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data));
    const formats = (body.data as any[]).map((f: any) => f.value);
    assert.ok(formats.includes("weekly-report"), "应支持 weekly-report");
    assert.ok(formats.includes("pr-description"), "应支持 pr-description");
    assert.ok(formats.includes("jsonl"), "应支持 jsonl");
    assert.ok(formats.includes("csv"), "应支持 csv");
  });

  it("POST /api/export 导出 JSONL 格式", async () => {
    const { status, body } = await req<any>(app, "POST", "/api/export", {
      format: "jsonl",
      language: "zh",
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);

    const result = body.data;
    assert.equal(result.format, "jsonl");
    assert.ok(
      result.sessionCount >= 3,
      `应至少有 3 条，实际 ${result.sessionCount}`,
    );
    assert.ok(result.content.length > 0, "content 不应为空");
    assert.ok(result.generatedAt, "应包含生成时间");

    // 验证每行是合法 JSON
    const lines = result.content.trim().split("\n");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.id, "每行应有 id 字段");
      assert.ok(parsed.prompt, "每行应有 prompt 字段");
    }
  });

  it("POST /api/export 导出中文周报（Markdown）", async () => {
    const { status, body } = await req<any>(app, "POST", "/api/export", {
      format: "weekly-report",
      language: "zh",
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);

    const { content } = body.data;
    assert.ok(content.includes("## AI 辅助开发周报"), "应包含周报标题");
    assert.ok(content.includes("### 概览"), "应包含概览章节");
    assert.ok(content.includes("### 交互详情"), "应包含详情章节");
    assert.ok(content.includes("AgentLog"), "应包含署名");
  });

  it("POST /api/export 导出英文周报", async () => {
    const { status, body } = await req<any>(app, "POST", "/api/export", {
      format: "weekly-report",
      language: "en",
    });
    assert.equal(status, 200);
    const { content } = body.data;
    assert.ok(
      content.includes("Weekly Report"),
      "英文周报应包含 Weekly Report",
    );
  });

  it("POST /api/export 导出 PR 说明（Markdown）", async () => {
    const { status, body } = await req<any>(app, "POST", "/api/export", {
      format: "pr-description",
      language: "zh",
    });
    assert.equal(status, 200);
    const { content } = body.data;
    assert.ok(content.includes("## PR 说明"), "应包含 PR 说明标题");
    assert.ok(content.includes("### 背景与目标"), "应包含背景章节");
    assert.ok(content.includes("### 主要改动"), "应包含主要改动章节");
  });

  it("POST /api/export 导出 CSV 格式", async () => {
    const { status, body } = await req<any>(app, "POST", "/api/export", {
      format: "csv",
      language: "zh",
    });
    assert.equal(status, 200);
    const { content } = body.data;

    const lines = content.trim().split("\n");
    // 第一行是 header
    assert.ok(lines[0].includes("id"), "CSV 第一行应为表头，包含 id");
    assert.ok(lines[0].includes("provider"), "CSV 表头应包含 provider");
    assert.ok(lines[0].includes("prompt"), "CSV 表头应包含 prompt");
    // 数据行
    assert.ok(lines.length >= 4, "应至少有 header + 3 条数据");
  });

  it("POST /api/export 按 workspacePath 过滤", async () => {
    const { body: allBody } = await req<any>(app, "POST", "/api/export", {
      format: "jsonl",
      workspacePath: "/tmp/test-project",
    });
    const { body: noneBody } = await req<any>(app, "POST", "/api/export", {
      format: "jsonl",
      workspacePath: "/tmp/other-project",
    });

    assert.ok(allBody.data.sessionCount >= 3, "匹配路径应有数据");
    assert.equal(noneBody.data.sessionCount, 0, "不匹配路径应返回 0 条");
  });

  it("POST /api/export 按日期范围过滤", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000)
      .toISOString()
      .slice(0, 10);

    const { status, body } = await req<any>(app, "POST", "/api/export", {
      format: "jsonl",
      startDate: today,
      endDate: tomorrow,
    });
    assert.equal(status, 200);
    assert.ok(body.data.sessionCount >= 3, "今天的数据应被包含");
  });

  it("POST /api/export startDate 晚于 endDate → 400", async () => {
    const { status, body } = await req<any>(app, "POST", "/api/export", {
      format: "jsonl",
      startDate: "2030-01-01",
      endDate: "2020-01-01",
    });
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });

  it("POST /api/export 无效日期格式 → 400", async () => {
    const { status, body } = await req<any>(app, "POST", "/api/export", {
      format: "jsonl",
      startDate: "not-a-date",
    });
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });

  it("POST /api/export 不支持的 format → 400", async () => {
    const { status, body } = await req<any>(app, "POST", "/api/export", {
      format: "pdf",
    });
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });

  it("POST /api/export/preview 返回截断内容和 isTruncated 字段", async () => {
    const { status, body } = await req<any>(
      app,
      "POST",
      "/api/export/preview",
      {
        format: "weekly-report",
        language: "zh",
      },
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok("isTruncated" in body.data, "应包含 isTruncated 字段");
  });
});

// ─
