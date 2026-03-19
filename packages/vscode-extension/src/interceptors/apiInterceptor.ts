/**
 * @agentlog/vscode-extension — API 拦截器
 *
 * 职责：在开发者使用 Cline、Cursor 等 AI 工具时，
 * 拦截对国内大模型（DeepSeek、Qwen、Kimi 等）的 HTTP/HTTPS 请求，
 * 提取 Prompt、Reasoning（推理过程）和 Response，
 * 并通过 BackendClient 上报到本地后台存储。
 *
 * 实现策略：
 *  - 通过 Monkey-patch Node.js 内置的 http.request / https.request，
 *    在 VS Code 扩展进程层面全局拦截所有出站 HTTP(S) 请求。
 *  - 对匹配到的 AI API 端点，拦截请求体与响应体（含 SSE 流式响应）。
 *  - 支持 OpenAI-Compatible 接口规范（DeepSeek / Qwen / Kimi / Doubao 均兼容）。
 *
 * ⚠️  注意事项：
 *  - Monkey-patch 会影响整个扩展进程，使用时务必保证幂等性（不重复 patch）。
 *  - 仅拦截匹配 AI_HOST_PATTERNS 的域名，不拦截无关请求。
 *  - 拦截器采集数据后异步上报，不阻塞原始请求链路。
 */

import http from "http";
import https from "https";
import { EventEmitter } from "events";
import * as vscode from "vscode";
import type {
  AgentSource,
  ModelProvider,
  CreateSessionRequest,
} from "@agentlog/shared";
import {
  getBackendClient,
  BackendUnreachableError,
} from "../client/backendClient";

// ─────────────────────────────────────────────
// 常量：需要拦截的 AI API 域名 / 路径规则
// ─────────────────────────────────────────────

/**
 * 需要拦截的 AI API 主机名模式（正则）。
 * 命中后才会进入拦截逻辑，避免影响其他网络请求。
 */
const AI_HOST_PATTERNS: RegExp[] = [
  /api\.deepseek\.com/i,
  /api\.openai\.com/i,
  /dashscope\.aliyuncs\.com/i, // 通义千问（DashScope）
  /api\.moonshot\.cn/i, // Kimi（月之暗面）
  /ark\.cn-beijing\.volces\.com/i, // 字节豆包（Ark）
  /open\.bigmodel\.cn/i, // 智谱 ChatGLM
  /localhost/i, // 本地 Ollama / LM Studio
  /127\.0\.0\.1/,
  /0\.0\.0\.0/,
];

/**
 * 仅拦截 Chat Completions 端点路径（精确匹配）。
 * 避免拦截鉴权、文件上传等无关接口。
 */
const COMPLETION_PATH_PATTERNS: RegExp[] = [
  /\/chat\/completions/i,
  /\/v1\/chat\/completions/i,
  /\/api\/chat/i,
  /\/v1\/messages/i, // Anthropic-style
  /\/compatible-mode\/v1\/chat\/completions/i, // 通义千问兼容模式
];

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

/** OpenAI-Compatible 请求体（简化版） */
interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

/** OpenAI-Compatible 响应体（非流式） */
interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
      reasoning_content?: string; // DeepSeek-R1 推理字段
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}

/** SSE 流式 chunk（delta 格式） */
interface StreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string; // DeepSeek-R1 流式推理字段
    };
    finish_reason?: string | null;
  }>;
}

/** 一次完整的拦截事件（用于内部流转） */
export interface InterceptedSession {
  /** 请求发起时间戳（ms） */
  startedAt: number;
  /** 目标主机 */
  host: string;
  /** 请求路径 */
  path: string;
  /** 解析后的请求体 */
  requestBody: ChatCompletionRequest;
  /** 最终组装的完整响应内容 */
  responseContent: string;
  /** 推理过程内容（DeepSeek-R1 等） */
  reasoningContent: string;
  /** 响应中报告的模型名称（可能与请求中不同） */
  responseModel: string;
  /** 请求是否为流式（SSE） */
  isStream: boolean;
  /** 响应 HTTP 状态码 */
  statusCode: number;
  /** 总耗时（ms） */
  durationMs: number;
}

// ─────────────────────────────────────────────
// 模型识别工具
// ─────────────────────────────────────────────

/**
 * 根据主机名推断 ModelProvider。
 */
function inferProvider(host: string): ModelProvider {
  if (/deepseek/.test(host)) return "deepseek";
  if (/aliyun|dashscope|qwen/.test(host)) return "qwen";
  if (/moonshot|kimi/.test(host)) return "kimi";
  if (/volces|doubao/.test(host)) return "doubao";
  if (/bigmodel|zhipu|chatglm/.test(host)) return "zhipu";
  if (/openai/.test(host)) return "openai";
  if (/anthropic/.test(host)) return "anthropic";
  return "unknown";
}

/**
 * 从请求 Authorization header 或请求体推断调用来源（Cline / Cursor / Continue 等）。
 * 目前通过 User-Agent 或特定 header 辅助判断，大多数情况下返回 'unknown'。
 * 实际来源在更高层（InterceptorManager）根据注册顺序标记。
 */
function inferSource(
  headers:
    | http.IncomingHttpHeaders
    | Record<string, string | string[] | undefined>,
): AgentSource {
  const ua = String(headers["user-agent"] ?? "").toLowerCase();
  if (ua.includes("cline")) return "cline";
  if (ua.includes("cursor")) return "cursor";
  if (ua.includes("continue")) return "continue";
  if (ua.includes("copilot")) return "copilot";
  return "unknown";
}

/**
 * 从消息列表中提取用户最后一条 Prompt 文本。
 * 若有多条 user 消息，取最后一条（最贴近当前交互）。
 */
function extractPrompt(messages: ChatCompletionRequest["messages"]): string {
  if (!messages || messages.length === 0) return "";
  // 取最后一条 user 或 human 角色的消息
  const userMessages = messages.filter(
    (m) => m.role === "user" || m.role === "human",
  );
  if (userMessages.length > 0) {
    return userMessages[userMessages.length - 1].content ?? "";
  }
  // 回退：取最后一条消息
  return messages[messages.length - 1].content ?? "";
}

/**
 * 从 DeepSeek-R1 的 reasoning_content 或响应文本中提取 <think>...</think> 推理块。
 *
 * DeepSeek-R1 通过两种方式暴露推理过程：
 *  1. 非流式：choices[0].message.reasoning_content 字段（最可靠）
 *  2. 流式：delta.reasoning_content 累积
 *  3. 兜底：在 content 中查找 <think>...</think> 标签
 */
function extractReasoning(
  content: string,
  reasoningContent?: string,
): string | undefined {
  if (reasoningContent && reasoningContent.trim()) {
    return reasoningContent.trim();
  }
  // 从 content 中提取 <think> 块
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    return thinkMatch[1].trim();
  }
  return undefined;
}

// ─────────────────────────────────────────────
// SSE 流解析
// ─────────────────────────────────────────────

/**
 * 解析 SSE（Server-Sent Events）流数据，累积 content 和 reasoning_content。
 * 每次收到新 chunk 时调用，返回当前累积的内容。
 */
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

// ─────────────────────────────────────────────
// 工具：解析 http.request 的各种重载签名，统一提取请求元信息
// ─────────────────────────────────────────────

/**
 * 将 http.request / https.request 的多态参数统一解析为
 * { host, path, method, headers } 结构。
 *
 * Node.js http.request 支持三种调用形式：
 *  1. request(url: string, callback?)
 *  2. request(url: URL, options?, callback?)
 *  3. request(options: RequestOptions, callback?)
 */
function resolveRequestOptions(
  urlOrOptions: string | URL | http.RequestOptions | https.RequestOptions,
  extraOptions?: http.RequestOptions | https.RequestOptions,
): {
  host: string;
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
} {
  let host = "";
  let urlPath = "/";
  let method = "GET";
  let headers: Record<string, string | string[] | undefined> = {};

  if (typeof urlOrOptions === "string") {
    try {
      const u = new URL(urlOrOptions);
      host = u.hostname;
      urlPath = u.pathname + u.search;
    } catch {
      host = urlOrOptions;
    }
  } else if (
    typeof urlOrOptions === "object" &&
    urlOrOptions !== null &&
    "hostname" in urlOrOptions &&
    "pathname" in urlOrOptions
  ) {
    // URL instance
    const u = urlOrOptions as URL;
    host = u.hostname;
    urlPath = u.pathname + u.search;
  } else {
    // http.RequestOptions
    const opts = urlOrOptions as http.RequestOptions;
    host = (opts.hostname ?? opts.host ?? "").replace(/:\d+$/, "");
    urlPath = opts.path ?? "/";
    method = opts.method ?? "GET";
    headers =
      (opts.headers as Record<string, string | string[] | undefined>) ?? {};
  }

  if (extraOptions) {
    if (extraOptions.method) method = extraOptions.method;
    if (extraOptions.headers) {
      headers = extraOptions.headers as Record<
        string,
        string | string[] | undefined
      >;
    }
  }

  return { host, path: urlPath, method: method.toUpperCase(), headers };
}

// ─────────────────────────────────────────────
// 核心拦截器：HTTP Monkey-Patch
// ─────────────────────────────────────────────

/**
 * HttpApiInterceptor
 *
 * 通过 Monkey-patch Node.js 内置的 http.request / https.request 实现全局请求拦截。
 * 只拦截命中 AI_HOST_PATTERNS + COMPLETION_PATH_PATTERNS 的请求。
 *
 * 采用 EventEmitter 发布拦截到的会话数据，解耦采集与上报逻辑。
 */
export class HttpApiInterceptor extends EventEmitter {
  private _active = false;
  private _patchedHttp = false;
  private _patchedHttps = false;

  /** 原始（未 patch）的 http.request */
  private _originalHttpRequest?: typeof http.request;
  /** 原始（未 patch）的 https.request */
  private _originalHttpsRequest?: typeof https.request;

  /** 当前工作区路径（用于上报时标注来源） */
  private _workspacePath: string;

  /** 用于 VS Code 状态栏 / 输出面板的日志频道 */
  private _outputChannel: vscode.OutputChannel;

  /** 是否开启调试日志 */
  private _debug = false;

  constructor(options: {
    workspacePath: string;
    outputChannel: vscode.OutputChannel;
    debug?: boolean;
  }) {
    super();
    this._workspacePath = options.workspacePath;
    this._outputChannel = options.outputChannel;
    this._debug = options.debug ?? false;
  }

  /** 已上报的会话数（用于外部状态展示） */
  public reportedCount = 0;

  // ─── 生命周期 ───────────────────────────────

  /**
   * 激活拦截器：注入 Monkey-patch。
   * 幂等操作，重复调用无副作用。
   */
  activate(): void {
    if (this._active) return;

    this._patchHttp();
    this._patchHttps();
    this._active = true;
    this._log("API 拦截器已激活");
  }

  /**
   * 停用拦截器：还原原始 http.request / https.request。
   */
  deactivate(): void {
    if (!this._active) return;

    this._restoreHttp();
    this._restoreHttps();
    this._active = false;
    this._log("API 拦截器已停用");
  }

  get isActive(): boolean {
    return this._active;
  }

  /**
   * 更新工作区路径（工作区切换时调用）。
   */
  setWorkspacePath(path: string): void {
    this._workspacePath = path;
  }

  // ─── HTTP Patch ─────────────────────────────

  private _patchHttp(): void {
    if (this._patchedHttp) return;
    this._originalHttpRequest = http.request.bind(http);
    const self = this;

    (http as unknown as { request: unknown }).request =
      function patchedHttpRequest(
        urlOrOptions: string | URL | http.RequestOptions,
        optionsOrCallback?:
          | http.RequestOptions
          | ((res: http.IncomingMessage) => void),
        maybeCallback?: (res: http.IncomingMessage) => void,
      ) {
        return self._intercept(
          false,
          self._originalHttpRequest!,
          urlOrOptions,
          optionsOrCallback,
          maybeCallback,
        );
      };

    this._patchedHttp = true;
  }

  private _patchHttps(): void {
    if (this._patchedHttps) return;
    this._originalHttpsRequest = https.request.bind(https);
    const self = this;

    (https as unknown as { request: unknown }).request =
      function patchedHttpsRequest(
        urlOrOptions: string | URL | https.RequestOptions,
        optionsOrCallback?:
          | https.RequestOptions
          | ((res: http.IncomingMessage) => void),
        maybeCallback?: (res: http.IncomingMessage) => void,
      ) {
        return self._intercept(
          true,
          self._originalHttpsRequest!,
          urlOrOptions,
          optionsOrCallback,
          maybeCallback,
        );
      };

    this._patchedHttps = true;
  }

  private _restoreHttp(): void {
    if (!this._patchedHttp || !this._originalHttpRequest) return;
    http.request = this._originalHttpRequest;
    this._patchedHttp = false;
  }

  private _restoreHttps(): void {
    if (!this._patchedHttps || !this._originalHttpsRequest) return;
    https.request = this._originalHttpsRequest;
    this._patchedHttps = false;
  }

  // ─── 拦截核心逻辑 ───────────────────────────

  /**
   * 实际拦截逻辑：判断是否命中规则，若命中则截获请求/响应体。
   */
  private _intercept(
    isHttps: boolean,
    original: typeof http.request | typeof https.request,
    urlOrOptions: string | URL | http.RequestOptions | https.RequestOptions,
    optionsOrCallback?:
      | http.RequestOptions
      | https.RequestOptions
      | ((res: http.IncomingMessage) => void),
    maybeCallback?: (res: http.IncomingMessage) => void,
  ): http.ClientRequest {
    // 解析请求选项以判断是否需要拦截
    const { host, path, method, headers } = resolveRequestOptions(
      urlOrOptions,
      typeof optionsOrCallback === "function" ? undefined : optionsOrCallback,
    );

    const shouldIntercept =
      this._active &&
      method === "POST" &&
      AI_HOST_PATTERNS.some((re) => re.test(host)) &&
      COMPLETION_PATH_PATTERNS.some((re) => re.test(path));

    if (!shouldIntercept) {
      // 不需要拦截，直接透传原始调用
      // @ts-expect-error
      return original(urlOrOptions, optionsOrCallback, maybeCallback);
    }

    this._debugLog(`[拦截] ${isHttps ? "https" : "http"}://${host}${path}`);

    const startedAt = Date.now();
    const requestBodyChunks: Buffer[] = [];
    let accContent = "";
    let accReasoning = "";
    let responseModel = "";
    let statusCode = 200;
    let isStream = false;

    // 解析 source（尽力推断）
    const source = inferSource(headers);

    // ── 创建原始请求 ──
    // 使用原始函数发起真实请求，同时挂载监听器
    const callback =
      typeof optionsOrCallback === "function"
        ? optionsOrCallback
        : maybeCallback;

    const wrappedCallback = (res: http.IncomingMessage) => {
      statusCode = res.statusCode ?? 200;
      const contentType = String(res.headers["content-type"] ?? "");
      isStream = contentType.includes("text/event-stream");

      const responseChunks: Buffer[] = [];

      res.on("data", (chunk: Buffer) => {
        responseChunks.push(chunk);

        if (isStream) {
          // 流式：边收边解析，实时累积内容
          const text = chunk.toString("utf-8");
          const parsed = parseStreamChunk(text, accContent, accReasoning);
          accContent = parsed.content;
          accReasoning = parsed.reasoning;
          if (parsed.model) responseModel = parsed.model;
        }
      });

      res.on("end", () => {
        if (!isStream) {
          // 非流式：一次性解析完整响应
          const raw = Buffer.concat(responseChunks).toString("utf-8");
          try {
            const json = JSON.parse(raw) as ChatCompletionResponse;
            accContent = json.choices?.[0]?.message?.content ?? "";
            accReasoning = json.choices?.[0]?.message?.reasoning_content ?? "";
            responseModel = json.model ?? "";
          } catch {
            accContent = raw;
          }
        }

        const durationMs = Date.now() - startedAt;

        // 解析请求体
        const rawRequestBody =
          Buffer.concat(requestBodyChunks).toString("utf-8");
        let parsedRequest: ChatCompletionRequest = {};
        try {
          parsedRequest = JSON.parse(rawRequestBody);
        } catch {
          // 忽略解析失败
        }

        if (statusCode < 400 && accContent) {
          const session: InterceptedSession = {
            startedAt,
            host,
            path,
            requestBody: parsedRequest,
            responseContent: accContent,
            reasoningContent: accReasoning,
            responseModel: responseModel || parsedRequest.model || "unknown",
            isStream,
            statusCode,
            durationMs,
          };

          // 异步上报，不阻塞响应处理
          this._reportSession(session, source).catch((err) => {
            if (!(err instanceof BackendUnreachableError)) {
              this._log(
                `[上报失败] ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          });
        }

        // 触发事件（供外部监听，例如状态栏更新）
        this.emit("session", {
          host,
          path,
          durationMs,
          statusCode,
          model: responseModel || parsedRequest.model,
        });
      });

      // 将原始响应传递给上游 callback
      if (callback) callback(res);
    };

    const req: http.ClientRequest = (original as Function)(
      urlOrOptions,
      typeof optionsOrCallback === "function"
        ? wrappedCallback
        : optionsOrCallback,
      typeof optionsOrCallback === "function" ? undefined : wrappedCallback,
    );

    // 若 optionsOrCallback 不是 callback（即是 options），则手动绑定 wrappedCallback
    if (typeof optionsOrCallback !== "function") {
      req.removeAllListeners("response");
      req.on("response", wrappedCallback);
    }

    // 监听请求体写入
    const originalWrite = req.write.bind(req);
    req.write = function (
      chunk: string | Buffer | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean {
      if (chunk) {
        requestBodyChunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
        );
      }
      if (typeof encodingOrCb === "function") {
        return originalWrite(chunk, encodingOrCb);
      }
      return originalWrite(
        chunk,
        (encodingOrCb as BufferEncoding) ?? "utf-8",
        cb,
      );
    };

    return req;
  }

  // ─── 上报逻辑 ───────────────────────────────

  /**
   * 将拦截到的会话上报到 AgentLog 后台。
   */
  private async _reportSession(
    session: InterceptedSession,
    source: AgentSource,
  ): Promise<void> {
    const { requestBody, responseContent, reasoningContent, responseModel } =
      session;

    const prompt = extractPrompt(requestBody.messages);
    if (!prompt.trim()) {
      this._debugLog("[跳过] 无法提取有效 Prompt，跳过上报");
      return;
    }

    const reasoning = extractReasoning(
      responseContent,
      reasoningContent || undefined,
    );
    // 若 reasoning 已内嵌在 content 中，从 content 中去除 <think> 块
    const cleanedResponse = responseContent
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim();

    const provider = inferProvider(session.host);

    const createReq: CreateSessionRequest = {
      provider,
      model: responseModel,
      source,
      workspacePath: this._workspacePath,
      prompt,
      reasoning,
      response: cleanedResponse,
      affectedFiles: [], // 由插件层后续通过 workspace 变更事件填充
      durationMs: session.durationMs,
      tags: [],
      metadata: {
        host: session.host,
        path: session.path,
        isStream: session.isStream,
        statusCode: session.statusCode,
        usage: (requestBody as { usage?: unknown }).usage,
      },
    };

    const client = getBackendClient();
    const created = await client.createSession(createReq);

    this._debugLog(
      `[上报成功] 会话 ${created.id.slice(0, 8)} | ${provider}/${responseModel} | ${session.durationMs}ms`,
    );

    // 触发上报成功事件（供状态栏 / 通知等 UI 消费）
    this.emit("reported", created);
  }

  // ─── 日志 ────────────────────────────────────

  private _log(message: string): void {
    this._outputChannel.appendLine(`[AgentLog] ${message}`);
  }

  private _debugLog(message: string): void {
    if (this._debug) {
      this._outputChannel.appendLine(`[AgentLog][DEBUG] ${message}`);
    }
  }
}

// ─────────────────────────────────────────────
// InterceptorManager：统一管理多个拦截器实例
// ─────────────────────────────────────────────

/**
 * InterceptorManager
 *
 * 负责：
 *  1. 为每个工作区创建并管理 HttpApiInterceptor 实例
 *  2. 监听 VS Code 工作区变化，动态更新拦截器
 *  3. 在插件停用时统一清理所有 patch
 *  4. 向外暴露简洁的 start / stop / restart API
 */
export class InterceptorManager implements vscode.Disposable {
  /** workspacePath → 拦截器实例 */
  private _interceptors = new Map<string, HttpApiInterceptor>();
  private _outputChannel: vscode.OutputChannel;
  private _disposables: vscode.Disposable[] = [];
  private _debug: boolean;

  /** 全局单例的 HTTP 拦截器（所有工作区复用） */
  private _globalInterceptor: HttpApiInterceptor | null = null;

  constructor(outputChannel: vscode.OutputChannel, debug = false) {
    this._outputChannel = outputChannel;
    this._debug = debug;
  }

  /**
   * 启动拦截。
   *
   * 优先使用"全局单拦截器"模式：
   * 一个进程内只 patch 一次，所有工作区共享。
   * 工作区路径在上报时动态取当前活动工作区。
   */
  start(): void {
    if (this._globalInterceptor?.isActive) return;

    const workspacePath = this._resolveActiveWorkspace();

    this._globalInterceptor = new HttpApiInterceptor({
      workspacePath,
      outputChannel: this._outputChannel,
      debug: this._debug,
    });

    // 监听上报成功事件，更新状态栏徽章等
    this._globalInterceptor.on("reported", () => {
      // 外部（extension.ts）通过 onSessionReported 回调消费
      this._onSessionReported?.();
    });

    this._globalInterceptor.activate();

    // 监听工作区切换，动态更新拦截器的 workspacePath
    const wsWatcher = vscode.window.onDidChangeActiveTextEditor(() => {
      const newPath = this._resolveActiveWorkspace();
      this._globalInterceptor?.setWorkspacePath(newPath);
    });
    this._disposables.push(wsWatcher);

    this._outputChannel.appendLine("[AgentLog] InterceptorManager 已启动");
  }

  /**
   * 停止所有拦截。
   */
  stop(): void {
    this._globalInterceptor?.deactivate();
    this._globalInterceptor = null;
    this._outputChannel.appendLine("[AgentLog] InterceptorManager 已停止");
  }

  /**
   * 重启拦截器（配置变更后调用）。
   */
  restart(debug?: boolean): void {
    if (debug !== undefined) this._debug = debug;
    this.stop();
    this.start();
  }

  get isActive(): boolean {
    return this._globalInterceptor?.isActive ?? false;
  }

  /** 外部注册的"会话上报成功"回调（由 extension.ts 注入） */
  private _onSessionReported?: () => void;

  onSessionReported(cb: () => void): void {
    this._onSessionReported = cb;
  }

  // ─── vscode.Disposable ──────────────────────

  dispose(): void {
    this.stop();
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
    this._interceptors.clear();
  }

  // ─── 工具方法 ───────────────────────────────

  /**
   * 获取当前活动编辑器所属工作区的路径。
   * 若无活动编辑器，取第一个工作区文件夹。
   */
  private _resolveActiveWorkspace(): string {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const wsFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (wsFolder) return wsFolder.uri.fsPath;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return "";
  }
}
