/**
 * @agentlog/vscode-extension — Fetch 拦截逻辑独立测试
 *
 * 由于 apiInterceptor.ts 依赖 vscode 模块，无法在普通 Node.js 环境下直接导入。
 * 本测试将拦截核心逻辑（模式匹配、fetch monkey-patch、SSE 解析等）内联复制，
 * 在隔离环境中验证行为正确性。
 *
 * 运行方式：
 *   cd packages/vscode-extension && npx tsx --test test/fetchInterception.test.ts
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ═════════════════════════════════════════════
// 从 apiInterceptor.ts 内联的核心常量与类型
// ═════════════════════════════════════════════

const AI_HOST_PATTERNS: RegExp[] = [
  /api\.deepseek\.com/i,
  /api\.openai\.com/i,
  /dashscope\.aliyuncs\.com/i,
  /api\.moonshot\.cn/i,
  /ark\.cn-beijing\.volces\.com/i,
  /open\.bigmodel\.cn/i,
  /localhost/i,
  /127\.0\.0\.1/,
  /0\.0\.0\.0/,
];

const COMPLETION_PATH_PATTERNS: RegExp[] = [
  /\/chat\/completions/i,
  /\/v1\/chat\/completions/i,
  /\/api\/chat/i,
  /\/v1\/messages/i,
  /\/compatible-mode\/v1\/chat\/completions/i,
];

interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
  [key: string]: unknown;
}

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface StreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
}

interface FetchInterceptContext {
  startedAt: number;
  host: string;
  path: string;
  parsedRequest: ChatCompletionRequest;
  source: string;
  statusCode: number;
}

interface InterceptedSession {
  startedAt: number;
  host: string;
  path: string;
  requestBody: ChatCompletionRequest;
  responseContent: string;
  reasoningContent: string;
  responseModel: string;
  isStream: boolean;
  statusCode: number;
  durationMs: number;
}

// ═════════════════════════════════════════════
// 从 apiInterceptor.ts 内联的辅助函数
// ═════════════════════════════════════════════

function parseStreamChunk(
  raw: string,
  accContent: string,
  accReasoning: string,
): { content: string; reasoning: string; model: string } {
  let content = accContent;
  let reasoning = accReasoning;
  let model = "";
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") break;
    try {
      const chunk = JSON.parse(data) as StreamChunk;
      if (chunk.model) model = chunk.model;
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
      }
    } catch {
      // 忽略解析失败的 chunk
    }
  }
  return { content, reasoning, model };
}

function inferSource(
  headers: Record<string, string | string[] | undefined>,
): string {
  const ua = String(headers["user-agent"] ?? "").toLowerCase();
  if (ua.includes("cline")) return "cline";
  if (ua.includes("cursor")) return "cursor";
  if (ua.includes("continue")) return "continue";
  if (ua.includes("copilot")) return "copilot";
  return "unknown";
}

function extractPrompt(messages: ChatCompletionRequest["messages"]): string {
  if (!messages || messages.length === 0) return "";
  const userMsgs = messages.filter(
    (m) => m.role === "user" || m.role === "human",
  );
  if (userMsgs.length > 0) {
    return userMsgs[userMsgs.length - 1].content ?? "";
  }
  return messages[messages.length - 1].content ?? "";
}

function extractReasoning(
  content: string,
  reasoningContent?: string,
): string | undefined {
  if (reasoningContent && reasoningContent.trim()) {
    return reasoningContent.trim();
  }
  const m = content.match(/<think>([\s\S]*?)<\/think>/i);
  if (m) return m[1].trim();
  return undefined;
}

// ═════════════════════════════════════════════
// 轻量 FetchInterceptor — 模拟 HttpApiInterceptor 的 fetch 部分
// ═════════════════════════════════════════════

class FetchInterceptor {
  private _active = false;
  private _patchedFetch = false;
  private _originalFetch: typeof globalThis.fetch | null = null;
  public reportedSessions: InterceptedSession[] = [];

  activate(): void {
    if (this._active) return;
    this._active = true;
    this._patchFetch();
  }

  deactivate(): void {
    if (!this._active) return;
    this._active = false;
    this._restoreFetch();
  }

  get isActive(): boolean {
    return this._active;
  }

  private _patchFetch(): void {
    if (this._patchedFetch) return;
    if (typeof globalThis.fetch !== "function") return;
    this._originalFetch = globalThis.fetch;
    const self = this;
    globalThis.fetch = function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      return self._interceptFetch(input, init);
    };
    this._patchedFetch = true;
  }

  private _restoreFetch(): void {
    if (!this._patchedFetch || !this._originalFetch) return;
    globalThis.fetch = this._originalFetch;
    this._patchedFetch = false;
  }

  private async _interceptFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let url: URL;
    try {
      if (typeof input === "string") {
        url = new URL(input);
      } else if (input instanceof URL) {
        url = input;
      } else if (input instanceof Request) {
        url = new URL(input.url);
      } else {
        return this._originalFetch!(input, init);
      }
    } catch {
      return this._originalFetch!(input, init);
    }

    const host = url.hostname;
    const urlPath = url.pathname + url.search;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    const shouldIntercept =
      this._active &&
      method === "POST" &&
      AI_HOST_PATTERNS.some((re) => re.test(host)) &&
      COMPLETION_PATH_PATTERNS.some((re) => re.test(urlPath));

    if (!shouldIntercept) {
      return this._originalFetch!(input, init);
    }

    const startedAt = Date.now();

    let requestBodyText = "";
    try {
      if (init?.body) {
        if (typeof init.body === "string") {
          requestBodyText = init.body;
        } else if (init.body instanceof ArrayBuffer) {
          requestBodyText = new TextDecoder().decode(init.body);
        } else if (ArrayBuffer.isView(init.body)) {
          requestBodyText = new TextDecoder().decode(init.body);
        } else if (init.body instanceof URLSearchParams) {
          requestBodyText = init.body.toString();
        }
      } else if (input instanceof Request) {
        const clonedReq = input.clone();
        requestBodyText = await clonedReq.text();
      }
    } catch {
      /* ignore */
    }

    let headerRecord: Record<string, string | string[] | undefined> = {};
    try {
      const h = init?.headers
        ? new Headers(init.headers as HeadersInit)
        : input instanceof Request
          ? input.headers
          : new Headers();
      h.forEach((value, key) => {
        headerRecord[key] = value;
      });
    } catch {
      /* ignore */
    }
    const source = inferSource(headerRecord);

    let parsedRequest: ChatCompletionRequest = {};
    try {
      if (requestBodyText) parsedRequest = JSON.parse(requestBodyText);
    } catch {
      /* ignore */
    }

    let response: Response;
    try {
      response = await this._originalFetch!(input, init);
    } catch (err) {
      throw err;
    }

    const statusCode = response.status;
    if (statusCode >= 400) return response;

    const contentType = response.headers.get("content-type") ?? "";
    const isStream = contentType.includes("text/event-stream");
    const fetchCtx: FetchInterceptContext = {
      startedAt,
      host,
      path: urlPath,
      parsedRequest,
      source,
      statusCode,
    };

    if (!isStream) {
      const cloned = response.clone();
      await this._processFetchNonStream(cloned, fetchCtx);
      return response;
    }

    if (!response.body) return response;
    return this._wrapFetchStreamResponse(response, fetchCtx);
  }

  private async _processFetchNonStream(
    cloned: Response,
    ctx: FetchInterceptContext,
  ): Promise<void> {
    const text = await cloned.text();
    const durationMs = Date.now() - ctx.startedAt;
    let accContent = "";
    let accReasoning = "";
    let responseModel = "";
    try {
      const json = JSON.parse(text) as ChatCompletionResponse;
      accContent = json.choices?.[0]?.message?.content ?? "";
      accReasoning = json.choices?.[0]?.message?.reasoning_content ?? "";
      responseModel = json.model ?? "";
    } catch {
      accContent = text;
    }
    if (accContent) {
      this.reportedSessions.push({
        startedAt: ctx.startedAt,
        host: ctx.host,
        path: ctx.path,
        requestBody: ctx.parsedRequest,
        responseContent: accContent,
        reasoningContent: accReasoning,
        responseModel: responseModel || ctx.parsedRequest.model || "unknown",
        isStream: false,
        statusCode: ctx.statusCode,
        durationMs,
      });
    }
  }

  private _wrapFetchStreamResponse(
    response: Response,
    ctx: FetchInterceptContext,
  ): Response {
    const originalBody = response.body!;
    const decoder = new TextDecoder();
    const self = this;
    let accContent = "";
    let accReasoning = "";
    let responseModel = "";

    const wrappedStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = originalBody.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              const durationMs = Date.now() - ctx.startedAt;
              if (accContent) {
                self.reportedSessions.push({
                  startedAt: ctx.startedAt,
                  host: ctx.host,
                  path: ctx.path,
                  requestBody: ctx.parsedRequest,
                  responseContent: accContent,
                  reasoningContent: accReasoning,
                  responseModel:
                    responseModel || ctx.parsedRequest.model || "unknown",
                  isStream: true,
                  statusCode: ctx.statusCode,
                  durationMs,
                });
              }
              controller.close();
              break;
            }
            controller.enqueue(value);
            const text = decoder.decode(value, { stream: true });
            const parsed = parseStreamChunk(text, accContent, accReasoning);
            accContent = parsed.content;
            accReasoning = parsed.reasoning;
            if (parsed.model) responseModel = parsed.model;
          }
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(wrappedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

// ═════════════════════════════════════════════
// 测试辅助工具
// ═════════════════════════════════════════════

function makeCompletionResponse(opts: {
  content: string;
  model?: string;
  reasoning_content?: string;
}): string {
  return JSON.stringify({
    id: "chatcmpl-test-001",
    model: opts.model ?? "deepseek-chat",
    choices: [
      {
        message: {
          role: "assistant",
          content: opts.content,
          ...(opts.reasoning_content
            ? { reasoning_content: opts.reasoning_content }
            : {}),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

function makeSSEText(
  deltas: Array<{
    content?: string;
    reasoning_content?: string;
    model?: string;
    finish_reason?: string | null;
  }>,
): string {
  let out = "";
  for (const d of deltas) {
    const chunk: StreamChunk = {
      id: "chatcmpl-stream-001",
      model: d.model ?? "deepseek-chat",
      choices: [
        {
          delta: {
            ...(d.content !== undefined ? { content: d.content } : {}),
            ...(d.reasoning_content !== undefined
              ? { reasoning_content: d.reasoning_content }
              : {}),
          },
          finish_reason: d.finish_reason ?? null,
        },
      ],
    };
    out += `data: ${JSON.stringify(chunk)}\n\n`;
  }
  out += "data: [DONE]\n\n";
  return out;
}

function makeSSEStream(sseText: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(sseText);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function drainStream(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

const SAMPLE_REQUEST_BODY: ChatCompletionRequest = {
  model: "deepseek-chat",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "用 TypeScript 写一个快速排序" },
  ],
  stream: false,
};

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const QWEN_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const KIMI_URL = "https://api.moonshot.cn/v1/chat/completions";

// ═════════════════════════════════════════════
// 测试正文 — 模式匹配
// ═════════════════════════════════════════════

describe("模式匹配 — AI_HOST_PATTERNS", () => {
  it("匹配常见 AI API 域名", () => {
    const hosts = [
      "api.deepseek.com",
      "API.DEEPSEEK.COM",
      "api.openai.com",
      "dashscope.aliyuncs.com",
      "api.moonshot.cn",
      "ark.cn-beijing.volces.com",
      "open.bigmodel.cn",
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
    ];
    for (const h of hosts) {
      assert.ok(
        AI_HOST_PATTERNS.some((re) => re.test(h)),
        `应匹配: ${h}`,
      );
    }
  });

  it("不匹配无关域名", () => {
    const hosts = [
      "github.com",
      "registry.npmjs.org",
      "google.com",
      "cdn.jsdelivr.net",
    ];
    for (const h of hosts) {
      assert.ok(!AI_HOST_PATTERNS.some((re) => re.test(h)), `不应匹配: ${h}`);
    }
  });
});

describe("模式匹配 — COMPLETION_PATH_PATTERNS", () => {
  it("匹配 chat completions 路径", () => {
    const paths = [
      "/chat/completions",
      "/v1/chat/completions",
      "/api/chat",
      "/v1/messages",
      "/compatible-mode/v1/chat/completions",
      "/V1/Chat/Completions",
    ];
    for (const p of paths) {
      assert.ok(
        COMPLETION_PATH_PATTERNS.some((re) => re.test(p)),
        `应匹配路径: ${p}`,
      );
    }
  });

  it("不匹配无关路径", () => {
    const paths = ["/v1/models", "/v1/files", "/v1/embeddings", "/health"];
    for (const p of paths) {
      assert.ok(
        !COMPLETION_PATH_PATTERNS.some((re) => re.test(p)),
        `不应匹配路径: ${p}`,
      );
    }
  });

  it("域名 + 路径组合匹配", () => {
    const cases = [
      {
        host: "api.deepseek.com",
        path: "/v1/chat/completions",
        expected: true,
      },
      { host: "api.deepseek.com", path: "/v1/models", expected: false },
      { host: "github.com", path: "/v1/chat/completions", expected: false },
      { host: "api.moonshot.cn", path: "/api/chat", expected: true },
      {
        host: "dashscope.aliyuncs.com",
        path: "/compatible-mode/v1/chat/completions",
        expected: true,
      },
    ];
    for (const c of cases) {
      const hostOk = AI_HOST_PATTERNS.some((re) => re.test(c.host));
      const pathOk = COMPLETION_PATH_PATTERNS.some((re) => re.test(c.path));
      assert.equal(
        hostOk && pathOk,
        c.expected,
        `${c.host}${c.path} 组合匹配应为 ${c.expected}`,
      );
    }
  });
});

// ═════════════════════════════════════════════
// 测试正文 — 辅助函数
// ═════════════════════════════════════════════

describe("辅助函数 — parseStreamChunk", () => {
  it("解析单条 SSE data 行", () => {
    const line = `data: ${JSON.stringify({
      model: "deepseek-chat",
      choices: [{ delta: { content: "Hello" }, finish_reason: null }],
    })}\n`;
    const r = parseStreamChunk(line, "", "");
    assert.equal(r.content, "Hello");
    assert.equal(r.model, "deepseek-chat");
  });

  it("累积多条 delta content", () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "He" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "llo" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: " World" } }] })}`,
    ].join("\n");
    const r = parseStreamChunk(lines, "Pre-", "");
    assert.equal(r.content, "Pre-Hello World");
  });

  it("累积 reasoning_content（DeepSeek-R1 流式推理）", () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Step 1. " } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Step 2. " } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Answer" } }] })}`,
    ].join("\n");
    const r = parseStreamChunk(lines, "", "");
    assert.equal(r.reasoning, "Step 1. Step 2. ");
    assert.equal(r.content, "Answer");
  });

  it("遇到 [DONE] 标记停止解析", () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}`,
      "data: [DONE]",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "B" } }] })}`,
    ].join("\n");
    assert.equal(parseStreamChunk(lines, "", "").content, "A");
  });

  it("忽略无效 JSON 行", () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}`,
      "data: {invalid json",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "!" } }] })}`,
    ].join("\n");
    assert.equal(parseStreamChunk(lines, "", "").content, "OK!");
  });

  it("忽略非 data: 开头的行（注释、event 等）", () => {
    const lines = [
      ": comment",
      "event: message",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}`,
    ].join("\n");
    assert.equal(parseStreamChunk(lines, "", "").content, "Hi");
  });

  it("空字符串输入返回累积值不变", () => {
    const r = parseStreamChunk("", "existing", "reasoning");
    assert.equal(r.content, "existing");
    assert.equal(r.reasoning, "reasoning");
    assert.equal(r.model, "");
  });
});

describe("辅助函数 — extractPrompt", () => {
  it("提取最后一条 user 消息", () => {
    const msgs = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "First" },
      { role: "assistant", content: "Answer" },
      { role: "user", content: "Follow-up" },
    ];
    assert.equal(extractPrompt(msgs), "Follow-up");
  });

  it("无 user 消息时回退到最后一条", () => {
    const msgs = [
      { role: "system", content: "System" },
      { role: "assistant", content: "Greeting" },
    ];
    assert.equal(extractPrompt(msgs), "Greeting");
  });

  it("空消息列表返回空字符串", () => {
    assert.equal(extractPrompt([]), "");
    assert.equal(extractPrompt(undefined), "");
  });

  it("支持 human 角色（Anthropic 风格）", () => {
    const msgs = [{ role: "human", content: "Anthropic-style prompt" }];
    assert.equal(extractPrompt(msgs), "Anthropic-style prompt");
  });
});

describe("辅助函数 — extractReasoning", () => {
  it("优先使用 reasoning_content 字段", () => {
    assert.equal(
      extractReasoning("content", "Deep reasoning"),
      "Deep reasoning",
    );
  });

  it("从 <think> 标签中提取推理", () => {
    const c = "<think>Step by step...</think>The answer is 42.";
    assert.equal(extractReasoning(c), "Step by step...");
  });

  it("reasoning_content 优先于 <think> 标签", () => {
    assert.equal(
      extractReasoning("<think>from tag</think>", "from field"),
      "from field",
    );
  });

  it("无推理内容返回 undefined", () => {
    assert.equal(extractReasoning("plain answer"), undefined);
  });

  it("空白 reasoning_content 回退到 <think> 标签", () => {
    assert.equal(
      extractReasoning("<think>fallback</think>answer", "   "),
      "fallback",
    );
  });
});

describe("辅助函数 — inferSource", () => {
  it("识别 Cline", () => {
    assert.equal(inferSource({ "user-agent": "Cline/1.0" }), "cline");
  });
  it("识别 Cursor", () => {
    assert.equal(inferSource({ "user-agent": "cursor-editor/0.40" }), "cursor");
  });
  it("识别 Continue", () => {
    assert.equal(inferSource({ "user-agent": "Continue/2.0" }), "continue");
  });
  it("识别 Copilot", () => {
    assert.equal(
      inferSource({ "user-agent": "GitHub-Copilot/1.0" }),
      "copilot",
    );
  });
  it("无法识别时返回 unknown", () => {
    assert.equal(inferSource({ "user-agent": "node-fetch" }), "unknown");
    assert.equal(inferSource({}), "unknown");
  });
});

// ═════════════════════════════════════════════
// Fetch 拦截 — 非流式响应
// ═════════════════════════════════════════════

describe("Fetch 拦截 — 非流式响应", () => {
  let interceptor: FetchInterceptor;
  let savedFetch: typeof globalThis.fetch;

  before(() => {
    savedFetch = globalThis.fetch;
  });
  beforeEach(() => {
    interceptor = new FetchInterceptor();
  });
  afterEach(() => {
    interceptor.deactivate();
    globalThis.fetch = savedFetch;
  });

  it("拦截匹配 URL 的 POST 请求并解析 JSON 响应", async () => {
    const body = makeCompletionResponse({
      content: "快速排序实现...",
      model: "deepseek-chat",
    });
    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    interceptor.activate();
    const res = await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SAMPLE_REQUEST_BODY),
    });

    const json = await res.json();
    assert.equal(json.choices[0].message.content, "快速排序实现...");

    assert.equal(interceptor.reportedSessions.length, 1);
    const s = interceptor.reportedSessions[0];
    assert.equal(s.host, "api.deepseek.com");
    assert.equal(s.path, "/v1/chat/completions");
    assert.equal(s.responseContent, "快速排序实现...");
    assert.equal(s.responseModel, "deepseek-chat");
    assert.equal(s.isStream, false);
    assert.equal(s.statusCode, 200);
    assert.ok(s.durationMs >= 0);
    assert.equal(s.requestBody.model, "deepseek-chat");
  });

  it("DeepSeek-R1 非流式响应提取 reasoning_content", async () => {
    const body = makeCompletionResponse({
      content: "答案是 42",
      model: "deepseek-reasoner",
      reasoning_content: "让我推理...所以答案是 42",
    });
    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    interceptor.activate();
    await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      body: JSON.stringify({
        ...SAMPLE_REQUEST_BODY,
        model: "deepseek-reasoner",
      }),
    });

    assert.equal(interceptor.reportedSessions.length, 1);
    const s = interceptor.reportedSessions[0];
    assert.equal(s.responseContent, "答案是 42");
    assert.equal(s.reasoningContent, "让我推理...所以答案是 42");
    assert.equal(s.responseModel, "deepseek-reasoner");
  });

  it("不匹配的 URL 直接透传，不触发拦截", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response("ok");
    };
    interceptor.activate();

    await globalThis.fetch("https://github.com/api/repos", { method: "POST" });
    await globalThis.fetch("https://api.deepseek.com/v1/models", {
      method: "GET",
    });
    await globalThis.fetch(DEEPSEEK_URL, { method: "GET" });
    assert.equal(callCount, 3);
    assert.equal(
      interceptor.reportedSessions.length,
      0,
      "不匹配的请求不应产生 session",
    );
  });

  it("4xx 响应不触发拦截", async () => {
    globalThis.fetch = async () =>
      new Response("Unauthorized", {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    interceptor.activate();
    const res = await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      body: JSON.stringify(SAMPLE_REQUEST_BODY),
    });
    assert.equal(res.status, 401);
    assert.equal(interceptor.reportedSessions.length, 0);
  });

  it("5xx 响应不触发拦截", async () => {
    globalThis.fetch = async () =>
      new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    interceptor.activate();
    const res = await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      body: JSON.stringify(SAMPLE_REQUEST_BODY),
    });
    assert.equal(res.status, 500);
    assert.equal(interceptor.reportedSessions.length, 0);
  });

  it("网络错误向调用方正常抛出", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    interceptor.activate();
    await assert.rejects(
      () =>
        globalThis.fetch(DEEPSEEK_URL, {
          method: "POST",
          body: JSON.stringify(SAMPLE_REQUEST_BODY),
        }),
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.equal((err as TypeError).message, "fetch failed");
        return true;
      },
    );
    assert.equal(interceptor.reportedSessions.length, 0);
  });

  it("支持 URL 对象作为 input", async () => {
    const body = makeCompletionResponse({ content: "URL 对象测试" });
    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    interceptor.activate();
    await globalThis.fetch(new URL(DEEPSEEK_URL), {
      method: "POST",
      body: JSON.stringify(SAMPLE_REQUEST_BODY),
    });
    assert.equal(interceptor.reportedSessions.length, 1);
    assert.equal(
      interceptor.reportedSessions[0].responseContent,
      "URL 对象测试",
    );
  });

  it("支持 Request 对象作为 input", async () => {
    const body = makeCompletionResponse({ content: "Request 对象测试" });
    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    interceptor.activate();
    const req = new Request(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SAMPLE_REQUEST_BODY),
    });
    await globalThis.fetch(req);
    assert.equal(interceptor.reportedSessions.length, 1);
    const s = interceptor.reportedSessions[0];
    assert.equal(s.responseContent, "Request 对象测试");
    assert.equal(s.requestBody.model, "deepseek-chat");
  });

  it("支持多种 AI 提供商 URL（OpenAI / Qwen / Kimi）", async () => {
    const body = makeCompletionResponse({ content: "multi-provider" });
    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    interceptor.activate();

    for (const url of [OPENAI_URL, QWEN_URL, KIMI_URL]) {
      await globalThis.fetch(url, {
        method: "POST",
        body: JSON.stringify(SAMPLE_REQUEST_BODY),
      });
    }
    assert.equal(interceptor.reportedSessions.length, 3);
    assert.equal(interceptor.reportedSessions[0].host, "api.openai.com");
    assert.equal(
      interceptor.reportedSessions[1].host,
      "dashscope.aliyuncs.com",
    );
    assert.equal(interceptor.reportedSessions[2].host, "api.moonshot.cn");
  });

  it("空 content 的响应不产生 session", async () => {
    const body = JSON.stringify({
      id: "chatcmpl-empty",
      model: "deepseek-chat",
      choices: [
        { message: { role: "assistant", content: "" }, finish_reason: "stop" },
      ],
    });
    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    interceptor.activate();
    await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      body: JSON.stringify(SAMPLE_REQUEST_BODY),
    });
    assert.equal(interceptor.reportedSessions.length, 0);
  });

  it("非 JSON 响应文本作为 responseContent 兜底", async () => {
    globalThis.fetch = async () =>
      new Response("plain text fallback", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    interceptor.activate();
    await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      body: JSON.stringify(SAMPLE_REQUEST_BODY),
    });
    assert.equal(interceptor.reportedSessions.length, 1);
    assert.equal(
      interceptor.reportedSessions[0].responseContent,
      "plain text fallback",
    );
  });
});

// ═════════════════════════════════════════════
// Fetch 拦截 — 流式 SSE 响应
// ═════════════════════════════════════════════

describe("Fetch 拦截 — 流式 SSE 响应", () => {
  let interceptor: FetchInterceptor;
  let savedFetch: typeof globalThis.fetch;

  before(() => {
    savedFetch = globalThis.fetch;
  });
  beforeEach(() => {
    interceptor = new FetchInterceptor();
  });
  afterEach(() => {
    interceptor.deactivate();
    globalThis.fetch = savedFetch;
  });

  it("流式 SSE 响应透传 chunk 给调用方，同时拦截内容", async () => {
    const sseText = makeSSEText([
      { content: "Hello", model: "deepseek-chat" },
      { content: " World" },
    ]);
    globalThis.fetch = async () =>
      new Response(makeSSEStream(sseText), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    interceptor.activate();
    const res = await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      body: JSON.stringify({ ...SAMPLE_REQUEST_BODY, stream: true }),
    });

    // 调用方可以完整读取 SSE 流
    const text = await drainStream(res.body!);
    assert.ok(text.includes("Hello"));
    assert.ok(text.includes("World"));
    assert.ok(text.includes("[DONE]"));

    // 拦截器汇总了完整内容
    assert.equal(interceptor.reportedSessions.length, 1);
    const s = interceptor.reportedSessions[0];
    assert.equal(s.responseContent, "Hello World");
    assert.equal(s.responseModel, "deepseek-chat");
    assert.equal(s.isStream, true);
    assert.equal(s.statusCode, 200);
  });

  it("DeepSeek-R1 流式响应提取 reasoning_content", async () => {
    const sseText = makeSSEText([
      { reasoning_content: "思考步骤1...", model: "deepseek-reasoner" },
      { reasoning_content: "思考步骤2...", model: "deepseek-reasoner" },
      { content: "最终答案", model: "deepseek-reasoner" },
    ]);
    globalThis.fetch = async () =>
      new Response(makeSSEStream(sseText), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    interceptor.activate();
    const res = await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      body: JSON.stringify({
        ...SAMPLE_REQUEST_BODY,
        model: "deepseek-reasoner",
        stream: true,
      }),
    });
    await drainStream(res.body!);

    assert.equal(interceptor.reportedSessions.length, 1);
    const s = interceptor.reportedSessions[0];
    assert.equal(s.reasoningContent, "思考步骤1...思考步骤2...");
    assert.equal(s.responseContent, "最终答案");
    assert.equal(s.responseModel, "deepseek-reasoner");
    assert.equal(s.isStream, true);
  });

  it("SSE 流无 content 不产生 session", async () => {
    const sseText = "data: [DONE]\n\n";
    globalThis.fetch = async () =>
      new Response(makeSSEStream(sseText), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    interceptor.activate();
    const res = await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      body: JSON.stringify({ ...SAMPLE_REQUEST_BODY, stream: true }),
    });
    await drainStream(res.body!);

    assert.equal(interceptor.reportedSessions.length, 0);
  });

  it("流式响应保留原始 status 和 headers", async () => {
    const sseText = makeSSEText([{ content: "ok" }]);
    globalThis.fetch = async () =>
      new Response(makeSSEStream(sseText), {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "req-12345",
        },
      });

    interceptor.activate();
    const res = await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      body: JSON.stringify({ ...SAMPLE_REQUEST_BODY, stream: true }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-request-id"), "req-12345");
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    await drainStream(res.body!);
  });
});

// ═════════════════════════════════════════════
// Fetch 拦截 — activate / deactivate 幂等性
// ═════════════════════════════════════════════

describe("Fetch 拦截 — activate / deactivate 幂等性", () => {
  let interceptor: FetchInterceptor;
  let savedFetch: typeof globalThis.fetch;

  before(() => {
    savedFetch = globalThis.fetch;
  });
  afterEach(() => {
    interceptor.deactivate();
    globalThis.fetch = savedFetch;
  });

  it("多次 activate 不重复 patch", () => {
    interceptor = new FetchInterceptor();
    interceptor.activate();
    const afterFirst = globalThis.fetch;
    interceptor.activate();
    interceptor.activate();
    assert.strictEqual(
      globalThis.fetch,
      afterFirst,
      "多次 activate 不应替换已 patch 的 fetch",
    );
    assert.equal(interceptor.isActive, true);
  });

  it("多次 deactivate 不报错", () => {
    interceptor = new FetchInterceptor();
    interceptor.activate();
    interceptor.deactivate();
    interceptor.deactivate();
    interceptor.deactivate();
    assert.equal(interceptor.isActive, false);
  });

  it("deactivate 后恢复原始 fetch", async () => {
    const body = makeCompletionResponse({ content: "test" });
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = mockFetch;

    interceptor = new FetchInterceptor();
    interceptor.activate();
    assert.notStrictEqual(
      globalThis.fetch,
      mockFetch,
      "activate 后 fetch 应被 patch",
    );

    interceptor.deactivate();
    assert.strictEqual(
      globalThis.fetch,
      mockFetch,
      "deactivate 后 fetch 应恢复原始",
    );
  });

  it("deactivate 后请求不再被拦截", async () => {
    const body = makeCompletionResponse({ content: "should not intercept" });
    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    interceptor = new FetchInterceptor();
    interceptor.activate();
    interceptor.deactivate();

    await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      body: JSON.stringify(SAMPLE_REQUEST_BODY),
    });
    assert.equal(
      interceptor.reportedSessions.length,
      0,
      "deactivate 后不应拦截",
    );
  });

  it("activate -> deactivate -> activate 重新生效", async () => {
    const body = makeCompletionResponse({ content: "re-activated" });
    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    interceptor = new FetchInterceptor();
    interceptor.activate();
    interceptor.deactivate();
    interceptor.activate();

    await globalThis.fetch(DEEPSEEK_URL, {
      method: "POST",
      body: JSON.stringify(SAMPLE_REQUEST_BODY),
    });
    assert.equal(interceptor.reportedSessions.length, 1);
    assert.equal(
      interceptor.reportedSessions[0].responseContent,
      "re-activated",
    );
  });
});
