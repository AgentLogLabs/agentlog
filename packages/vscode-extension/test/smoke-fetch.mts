#!/usr/bin/env node
/**
 * @agentlog/vscode-extension — Fetch 拦截 Smoke Test
 *
 * 快速验证 globalThis.fetch monkey-patch 在当前 Node.js 环境下是否正常工作。
 * 不依赖 vscode 模块，可直接在终端运行。
 *
 * 运行方式：
 *   node --experimental-vm-modules packages/vscode-extension/test/smoke-fetch.mts
 *   # 或使用 tsx：
 *   npx tsx packages/vscode-extension/test/smoke-fetch.mts
 *
 * 预期输出：所有检查项显示 ✅ PASS
 */

// ─────────────────────────────────────────────
// 颜色辅助
// ─────────────────────────────────────────────

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ${green("✅ PASS")}  ${label}`);
    passed++;
  } else {
    console.log(
      `  ${red("❌ FAIL")}  ${label}${detail ? `  ${dim(`(${detail})`)}` : ""}`,
    );
    failed++;
  }
}

// ─────────────────────────────────────────────
// 从 apiInterceptor.ts 复制的核心常量
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// SSE 解析（从 apiInterceptor.ts 复制）
// ─────────────────────────────────────────────

interface StreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
}

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
      // ignore
    }
  }
  return { content, reasoning, model };
}

// ─────────────────────────────────────────────
// 辅助：构造 mock 数据
// ─────────────────────────────────────────────

function makeJsonResponseBody(
  content: string,
  model = "deepseek-chat",
  reasoning?: string,
): string {
  return JSON.stringify({
    id: "chatcmpl-smoke",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
  });
}

function makeSSEData(
  content?: string,
  reasoning?: string,
  model?: string,
  finish?: string,
): string {
  const chunk: StreamChunk = {
    id: "chatcmpl-sse",
    model: model ?? "deepseek-chat",
    choices: [
      {
        delta: {
          ...(content !== undefined ? { content } : {}),
          ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: finish ?? null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx]));
        idx++;
      } else {
        controller.close();
      }
    },
  });
}

async function readStreamFully(
  body: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────
// 最小化 fetch 拦截器（模拟 HttpApiInterceptor 的 fetch 部分）
// ─────────────────────────────────────────────

interface InterceptedResult {
  host: string;
  path: string;
  model: string;
  content: string;
  reasoning: string;
  isStream: boolean;
  requestBody: string;
}

class MiniFetchInterceptor {
  private _active = false;
  private _patched = false;
  private _originalFetch?: typeof globalThis.fetch;
  public intercepted: InterceptedResult[] = [];

  activate(): void {
    if (this._active) return;
    if (typeof globalThis.fetch !== "function") return;
    this._originalFetch = globalThis.fetch;
    const self = this;
    globalThis.fetch = function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      return self._intercept(input, init);
    };
    this._patched = true;
    this._active = true;
  }

  deactivate(): void {
    if (!this._active) return;
    if (this._patched && this._originalFetch) {
      globalThis.fetch = this._originalFetch;
      this._patched = false;
    }
    this._active = false;
  }

  get isActive(): boolean {
    return this._active;
  }

  private async _intercept(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let url: URL;
    try {
      if (typeof input === "string") url = new URL(input);
      else if (input instanceof URL) url = input;
      else if (input instanceof Request) url = new URL(input.url);
      else return this._originalFetch!(input, init);
    } catch {
      return this._originalFetch!(input, init);
    }

    const host = url.hostname;
    const path = url.pathname + url.search;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    const shouldIntercept =
      this._active &&
      method === "POST" &&
      AI_HOST_PATTERNS.some((re) => re.test(host)) &&
      COMPLETION_PATH_PATTERNS.some((re) => re.test(path));

    if (!shouldIntercept) {
      return this._originalFetch!(input, init);
    }

    // Read request body
    let requestBodyText = "";
    try {
      if (init?.body) {
        if (typeof init.body === "string") requestBodyText = init.body;
        else if (init.body instanceof ArrayBuffer)
          requestBodyText = new TextDecoder().decode(init.body);
        else if (ArrayBuffer.isView(init.body))
          requestBodyText = new TextDecoder().decode(init.body);
      } else if (input instanceof Request) {
        const c = input.clone();
        requestBodyText = await c.text();
      }
    } catch {
      /* ignore */
    }

    // Call original fetch
    const response = await this._originalFetch!(input, init);

    if (response.status >= 400) return response;

    const contentType = response.headers.get("content-type") ?? "";
    const isStream = contentType.includes("text/event-stream");

    if (!isStream) {
      // Non-stream: clone + read
      const cloned = response.clone();
      cloned
        .text()
        .then((text) => {
          let content = "";
          let reasoning = "";
          let model = "";
          try {
            const json = JSON.parse(text);
            content = json.choices?.[0]?.message?.content ?? "";
            reasoning = json.choices?.[0]?.message?.reasoning_content ?? "";
            model = json.model ?? "";
          } catch {
            content = text;
          }
          if (content) {
            this.intercepted.push({
              host,
              path,
              model,
              content,
              reasoning,
              isStream: false,
              requestBody: requestBodyText,
            });
          }
        })
        .catch(() => {});
      return response;
    }

    // Stream: wrap body
    if (!response.body) return response;

    const originalBody = response.body;
    const decoder = new TextDecoder();
    const self = this;
    let accContent = "";
    let accReasoning = "";
    let responseModel = "";

    const wrapped = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = originalBody.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (accContent) {
                self.intercepted.push({
                  host,
                  path,
                  model: responseModel,
                  content: accContent,
                  reasoning: accReasoning,
                  isStream: true,
                  requestBody: requestBodyText,
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

    return new Response(wrapped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

// ═════════════════════════════════════════════
// Smoke Tests
// ═════════════════════════════════════════════

async function main() {
  console.log();
  console.log(bold("🔬 AgentLog Fetch 拦截 Smoke Test"));
  console.log(
    dim(`   Node.js ${process.version} | ${new Date().toISOString()}`),
  );
  console.log();

  // ─── 环境检查 ─────────────────────────────

  console.log(cyan("▸ 环境检查"));
  const nodeVer = parseInt(process.version.slice(1), 10);
  check("Node.js 版本 ≥ 18", nodeVer >= 18, `当前: ${process.version}`);
  check("globalThis.fetch 可用", typeof globalThis.fetch === "function");
  check("ReadableStream 可用", typeof ReadableStream === "function");
  check("Response 可用", typeof Response === "function");
  check("Request 可用", typeof Request === "function");
  check(
    "TextEncoder/TextDecoder 可用",
    typeof TextEncoder === "function" && typeof TextDecoder === "function",
  );
  console.log();

  if (nodeVer < 18) {
    console.log(
      red(
        "⚠️  Node.js 版本过低，无法运行 fetch 相关测试。请使用 Node.js 18+。",
      ),
    );
    console.log(dim("  提示: nvm use 22"));
    process.exit(1);
  }

  // ─── 模式匹配 ─────────────────────────────

  console.log(cyan("▸ 模式匹配"));
  const hostTestCases: [string, boolean][] = [
    ["api.deepseek.com", true],
    ["API.DEEPSEEK.COM", true],
    ["api.openai.com", true],
    ["dashscope.aliyuncs.com", true],
    ["api.moonshot.cn", true],
    ["ark.cn-beijing.volces.com", true],
    ["open.bigmodel.cn", true],
    ["localhost", true],
    ["127.0.0.1", true],
    ["api.github.com", false],
    ["google.com", false],
    ["example.com", false],
  ];
  for (const [host, expected] of hostTestCases) {
    const matched = AI_HOST_PATTERNS.some((re) => re.test(host));
    check(
      `Host "${host}" → ${expected ? "匹配" : "不匹配"}`,
      matched === expected,
    );
  }

  const pathTestCases: [string, boolean][] = [
    ["/v1/chat/completions", true],
    ["/chat/completions", true],
    ["/api/chat", true],
    ["/v1/messages", true],
    ["/compatible-mode/v1/chat/completions", true],
    ["/v1/models", false],
    ["/v1/files", false],
    ["/health", false],
  ];
  for (const [path, expected] of pathTestCases) {
    const matched = COMPLETION_PATH_PATTERNS.some((re) => re.test(path));
    check(
      `Path "${path}" → ${expected ? "匹配" : "不匹配"}`,
      matched === expected,
    );
  }
  console.log();

  // ─── SSE 解析 ─────────────────────────────

  console.log(cyan("▸ SSE 解析"));
  {
    const sse = makeSSEData("Hello", undefined, "deepseek-chat");
    const r = parseStreamChunk(sse, "", "");
    check(
      "解析单条 SSE delta",
      r.content === "Hello" && r.model === "deepseek-chat",
    );
  }
  {
    const sse1 = makeSSEData("Hello");
    const sse2 = makeSSEData(", world!");
    const r1 = parseStreamChunk(sse1, "", "");
    const r2 = parseStreamChunk(sse2, r1.content, r1.reasoning);
    check("累积多条 delta", r2.content === "Hello, world!");
  }
  {
    const sse = makeSSEData(undefined, "Step 1: think", "deepseek-reasoner");
    const r = parseStreamChunk(sse, "", "");
    check(
      "DeepSeek-R1 reasoning_content 累积",
      r.reasoning === "Step 1: think" && r.content === "",
    );
  }
  {
    const sse = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"NOPE"}}]}\n\n`;
    const r = parseStreamChunk(sse, "", "");
    check("[DONE] 后停止解析", r.content === "ok");
  }
  {
    const r = parseStreamChunk("data: {invalid json}\n\n", "prev", "");
    check("无效 JSON 不影响已累积内容", r.content === "prev");
  }
  console.log();

  // ─── Fetch Monkey-patch ───────────────────

  console.log(cyan("▸ Fetch Monkey-patch 基础"));

  const originalFetch = globalThis.fetch;
  const interceptor = new MiniFetchInterceptor();

  // Before activate
  check("初始状态 isActive === false", !interceptor.isActive);

  interceptor.activate();
  check("activate 后 isActive === true", interceptor.isActive);
  check("fetch 已被替换", globalThis.fetch !== originalFetch);
  check(
    "fetch 函数名为 patchedFetch",
    globalThis.fetch.name === "patchedFetch",
  );

  // Idempotent activate
  const patchedRef = globalThis.fetch;
  interceptor.activate();
  check("重复 activate 不重复 patch", globalThis.fetch === patchedRef);

  interceptor.deactivate();
  check("deactivate 后 isActive === false", !interceptor.isActive);
  check("deactivate 后 fetch 已还原", globalThis.fetch === originalFetch);

  interceptor.deactivate();
  check("重复 deactivate 不报错", true);
  console.log();

  // ─── 非流式拦截 ───────────────────────────

  console.log(cyan("▸ 非流式 fetch 拦截"));

  // Set up a mock fetch that returns controlled responses
  const mockCalls: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    mockCalls.push({ url, init });

    // Route different URLs to different responses
    // ⚠️ 顺序重要：更具体的规则必须在前，避免被宽泛规则吞掉
    if (url.includes("error401")) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (url.includes("github.com")) {
      return new Response(JSON.stringify({ repos: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("deepseek") && url.includes("reasoning")) {
      return new Response(
        makeJsonResponseBody("答案是 42", "deepseek-reasoner", "让我想想..."),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (url.includes("deepseek") && url.includes("chat/completions")) {
      return new Response(
        makeJsonResponseBody("DeepSeek 回复", "deepseek-chat"),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (url.includes("moonshot") && url.includes("stream-sse")) {
      const stream = createMockStream([
        makeSSEData("你好", undefined, "moonshot-v1-8k"),
        makeSSEData("，世界"),
        makeSSEData("！", undefined, undefined, "stop"),
        "data: [DONE]\n\n",
      ]);
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response("OK", { status: 200 });
  };

  // Install mock fetch, then activate interceptor on top of it
  globalThis.fetch = mockFetch;
  const interceptor2 = new MiniFetchInterceptor();
  interceptor2.activate();

  // Test 1: Intercept DeepSeek POST
  {
    const res = await globalThis.fetch(
      "https://api.deepseek.com/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "你好" }],
        }),
      },
    );
    const json = await res.json();
    check(
      "DeepSeek POST 被拦截，调用方仍能读取 response",
      json?.choices?.[0]?.message?.content === "DeepSeek 回复",
    );
    await delay(50);
    const last = interceptor2.intercepted[interceptor2.intercepted.length - 1];
    check("拦截记录包含正确 content", last?.content === "DeepSeek 回复");
    check("拦截记录包含正确 model", last?.model === "deepseek-chat");
    check("拦截记录 isStream === false", last?.isStream === false);
    check("拦截记录 host 正确", last?.host === "api.deepseek.com");
  }

  // Test 2: Non-matching URL passes through
  {
    const prevCount = interceptor2.intercepted.length;
    await globalThis.fetch("https://api.github.com/repos", {
      method: "POST",
      body: "{}",
    });
    await delay(50);
    check(
      "不匹配的 URL 不产生拦截记录",
      interceptor2.intercepted.length === prevCount,
    );
  }

  // Test 3: GET request not intercepted
  {
    const prevCount = interceptor2.intercepted.length;
    await globalThis.fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "GET",
    });
    await delay(50);
    check("GET 请求不被拦截", interceptor2.intercepted.length === prevCount);
  }

  // Test 4: 401 response not intercepted
  {
    const prevCount = interceptor2.intercepted.length;
    await globalThis.fetch(
      "https://api.deepseek.com/error401/chat/completions",
      { method: "POST", body: "{}" },
    );
    await delay(50);
    check(
      "4xx 错误响应不被拦截",
      interceptor2.intercepted.length === prevCount,
    );
  }

  // Test 5: DeepSeek-R1 reasoning
  {
    // We need a different URL to trigger reasoning response from our mock
    // Trick: add "reasoning" to path to trigger it in our mock
    const origMockFetch = (interceptor2 as any)._originalFetch;
    const savedFetch = (interceptor2 as any)._originalFetch;
    // Override mock for this specific call
    (interceptor2 as any)._originalFetch = async (input: any, init: any) => {
      return new Response(
        makeJsonResponseBody("答案是 42", "deepseek-reasoner", "让我想想..."),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
    await globalThis.fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-reasoner",
        messages: [{ role: "user", content: "1+1=?" }],
      }),
    });
    await delay(50);
    const last = interceptor2.intercepted[interceptor2.intercepted.length - 1];
    check(
      "DeepSeek-R1 提取 reasoning_content",
      last?.reasoning === "让我想想...",
    );
    check("DeepSeek-R1 提取 content", last?.content === "答案是 42");
    (interceptor2 as any)._originalFetch = savedFetch;
  }

  // Test 6: URL object input
  {
    const prevCount = interceptor2.intercepted.length;
    await globalThis.fetch(
      new URL("https://api.deepseek.com/v1/chat/completions"),
      {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "URL对象" }],
        }),
      },
    );
    await delay(50);
    check(
      "URL 对象作为 input 被正确拦截",
      interceptor2.intercepted.length === prevCount + 1,
    );
  }

  // Test 7: Request object input
  {
    const prevCount = interceptor2.intercepted.length;
    const req = new Request("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Request对象" }],
      }),
    });
    await globalThis.fetch(req);
    await delay(50);
    check(
      "Request 对象作为 input 被正确拦截",
      interceptor2.intercepted.length === prevCount + 1,
    );
    const last = interceptor2.intercepted[interceptor2.intercepted.length - 1];
    check(
      "Request 对象请求体被正确读取",
      last?.requestBody?.includes("Request对象") === true,
    );
  }

  console.log();

  // ─── 流式 SSE 拦截 ────────────────────────

  console.log(cyan("▸ 流式 SSE fetch 拦截"));

  {
    // Override mock to return SSE stream
    const savedFetch = (interceptor2 as any)._originalFetch;
    (interceptor2 as any)._originalFetch = async () => {
      const stream = createMockStream([
        makeSSEData("Hello", undefined, "deepseek-chat"),
        makeSSEData(", "),
        makeSSEData("world!"),
        makeSSEData(undefined, undefined, undefined, "stop"),
        "data: [DONE]\n\n",
      ]);
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Request-Id": "smoke-123",
        },
      });
    };

    const prevCount = interceptor2.intercepted.length;
    const res = await globalThis.fetch(
      "https://api.deepseek.com/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "stream test" }],
          stream: true,
        }),
      },
    );

    // Caller should be able to read the wrapped stream
    const streamText = await readStreamFully(res.body!);
    check(
      "SSE 流内容被透传给调用方",
      streamText.includes("Hello") && streamText.includes("world!"),
    );
    check(
      "SSE 响应 headers 保留",
      res.headers.get("x-request-id") === "smoke-123",
    );
    check("SSE 响应 status 保留", res.status === 200);

    // After stream is fully consumed, interceptor should have recorded it
    await delay(50);
    check(
      "SSE 流拦截记录已产生",
      interceptor2.intercepted.length === prevCount + 1,
    );
    const last = interceptor2.intercepted[interceptor2.intercepted.length - 1];
    check("SSE 累积 content 正确", last?.content === "Hello, world!");
    check("SSE isStream === true", last?.isStream === true);
    check("SSE model 正确", last?.model === "deepseek-chat");

    (interceptor2 as any)._originalFetch = savedFetch;
  }

  // SSE with reasoning_content
  {
    const savedFetch = (interceptor2 as any)._originalFetch;
    (interceptor2 as any)._originalFetch = async () => {
      const stream = createMockStream([
        makeSSEData(undefined, "Step 1: ", "deepseek-reasoner"),
        makeSSEData(undefined, "分析问题"),
        makeSSEData("最终答案"),
        "data: [DONE]\n\n",
      ]);
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const prevCount = interceptor2.intercepted.length;
    const res = await globalThis.fetch(
      "https://api.deepseek.com/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek-reasoner",
          messages: [{ role: "user", content: "think" }],
          stream: true,
        }),
      },
    );
    await readStreamFully(res.body!);
    await delay(50);

    const last = interceptor2.intercepted[interceptor2.intercepted.length - 1];
    check(
      "SSE DeepSeek-R1 reasoning 累积正确",
      last?.reasoning === "Step 1: 分析问题",
    );
    check("SSE DeepSeek-R1 content 累积正确", last?.content === "最终答案");

    (interceptor2 as any)._originalFetch = savedFetch;
  }

  console.log();

  // ─── 清理 ─────────────────────────────────

  interceptor2.deactivate();
  globalThis.fetch = originalFetch;

  // ─── 汇总 ─────────────────────────────────

  console.log(bold("━".repeat(50)));
  console.log(
    `  ${bold("结果:")} ${green(`${passed} passed`)}, ${failed > 0 ? red(`${failed} failed`) : dim("0 failed")}`,
  );
  console.log(bold("━".repeat(50)));
  console.log();

  if (failed > 0) {
    console.log(red("⚠️  有测试未通过，请检查上方 ❌ 项。"));
    process.exit(1);
  } else {
    console.log(green("🎉 所有检查通过！fetch 拦截逻辑工作正常。"));
    console.log();
    console.log(
      dim("  下一步：在 VS Code Extension Development Host 中进行端到端验证"),
    );
    console.log(dim("  1. 启用 agentlog.debug: true"));
    console.log(dim("  2. 使用 Cline 发起一次 AI 请求"));
    console.log(
      dim("  3. 查看「输出」→「AgentLog」面板中的 [Fetch 拦截] 日志"),
    );
    console.log();
  }
}

main().catch((err) => {
  console.error(red("Smoke test 运行失败:"), err);
  process.exit(1);
});
