/**
 * @agentlog/vscode-extension — BackendClient
 *
 * 封装与本地后台（@agentlog/backend）的所有 HTTP 通信。
 * 使用 Node.js 内置的 http / https 模块，避免在 VS Code 插件中引入额外的网络依赖。
 *
 * 设计原则：
 *  - 所有方法均返回 Promise，失败时 reject（调用方统一 try/catch）
 *  - 请求超时默认 5 秒，可通过 BackendClientOptions 覆盖
 *  - 自动跟踪后台存活状态（isAlive），避免在后台未启动时大量报错
 */

import http from 'http';
import https from 'https';
import type {
  AgentSession,
  CommitBinding,
  CreateSessionRequest,
  ExportOptions,
  ExportResult,
  PaginatedResponse,
  SessionQueryFilter,
  ApiResponse,
  AgentLogConfig,
} from '@agentlog/shared';

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

export interface BackendClientOptions {
  /** 后台服务根地址，例如 "http://localhost:7892" */
  baseUrl: string;
  /** 请求超时（毫秒），默认 5000 */
  timeoutMs?: number;
}

export interface HealthStatus {
  status: 'ok' | 'unreachable';
  version?: string;
  uptime?: number;
  timestamp?: string;
}

/** 后台服务不可达时抛出的错误类型 */
export class BackendUnreachableError extends Error {
  constructor(baseUrl: string, cause?: unknown) {
    super(
      `AgentLog 后台服务不可达（${baseUrl}）。请确认服务已启动，或检查 agentlog.backendUrl 配置。`,
    );
    this.name = 'BackendUnreachableError';
    if (cause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

/** 后台返回非 2xx 状态码时抛出的错误类型 */
export class BackendApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(`[${statusCode}] ${endpoint} — ${message}`);
    this.name = 'BackendApiError';
  }
}

// ─────────────────────────────────────────────
// 核心客户端类
// ─────────────────────────────────────────────

export class BackendClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /** 最近一次 ping 的结果缓存，避免频繁请求 */
  private _lastPingAt = 0;
  private _isAlive = false;
  private readonly PING_CACHE_MS = 10_000; // 10 秒内不重复 ping

  constructor(options: BackendClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, ''); // 去掉末尾斜线
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  // ─────────────────────────────────────────────
  // 底层 HTTP 请求
  // ─────────────────────────────────────────────

  /**
   * 发送 HTTP 请求并解析 JSON 响应。
   *
   * @param method   HTTP 方法
   * @param path     相对路径，例如 "/api/sessions"
   * @param body     请求体（POST / PATCH 时使用）
   * @returns        解析后的 JSON 数据
   */
  private request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}${path}`);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
        timeout: this.timeoutMs,
      };

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));

        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');

          // 尝试解析 JSON
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // 非 JSON 响应（例如导出文件的纯文本）
            if ((res.statusCode ?? 200) < 400) {
              resolve(raw as unknown as T);
              return;
            }
            reject(
              new BackendApiError(
                res.statusCode ?? 0,
                path,
                `响应不是有效的 JSON：${raw.slice(0, 200)}`,
              ),
            );
            return;
          }

          const statusCode = res.statusCode ?? 200;

          if (statusCode >= 400) {
            const apiResp = parsed as ApiResponse;
            reject(
              new BackendApiError(
                statusCode,
                path,
                apiResp?.error ?? `HTTP ${statusCode}`,
              ),
            );
            return;
          }

          resolve(parsed as T);
        });
      });

      // 超时处理
      req.on('timeout', () => {
        req.destroy();
        this._isAlive = false;
        reject(
          new BackendUnreachableError(
            this.baseUrl,
            new Error(`请求超时（${this.timeoutMs}ms）：${method} ${path}`),
          ),
        );
      });

      // 连接错误（服务未启动）
      req.on('error', (err) => {
        this._isAlive = false;
        const isConnectionRefused =
          (err as NodeJS.ErrnoException).code === 'ECONNREFUSED';
        if (isConnectionRefused) {
          reject(new BackendUnreachableError(this.baseUrl, err));
        } else {
          reject(err);
        }
      });

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  // ─────────────────────────────────────────────
  // 健康检查
  // ─────────────────────────────────────────────

  /**
   * 检测后台服务是否在线。
   * 10 秒内重复调用会返回缓存结果，减少不必要的 HTTP 请求。
   *
   * @param force 强制忽略缓存，立即 ping
   */
  async ping(force = false): Promise<HealthStatus> {
    const now = Date.now();
    if (!force && now - this._lastPingAt < this.PING_CACHE_MS) {
      return {
        status: this._isAlive ? 'ok' : 'unreachable',
      };
    }

    try {
      const result = await this.request<HealthStatus>('GET', '/health');
      this._isAlive = true;
      this._lastPingAt = Date.now();
      return { ...result, status: 'ok' };
    } catch {
      this._isAlive = false;
      this._lastPingAt = Date.now();
      return { status: 'unreachable' };
    }
  }

  /** 返回最近一次 ping 缓存的存活状态（同步，不发起网络请求） */
  get isAlive(): boolean {
    return this._isAlive;
  }

  // ─────────────────────────────────────────────
  // Session API
  // ─────────────────────────────────────────────

  /**
   * 上报一条新的 AI 交互会话。
   * 插件捕获到完整的 Prompt + Response 后调用此方法。
   */
  async createSession(
    req: CreateSessionRequest,
  ): Promise<AgentSession> {
    const resp = await this.request<ApiResponse<AgentSession>>(
      'POST',
      '/api/sessions',
      req,
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, '/api/sessions', resp.error ?? '创建会话失败');
    }
    return resp.data;
  }

  /**
   * 按 ID 获取单条会话详情。
   */
  async getSession(id: string): Promise<AgentSession> {
    const resp = await this.request<ApiResponse<AgentSession>>(
      'GET',
      `/api/sessions/${encodeURIComponent(id)}`,
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, `/api/sessions/${id}`, resp.error ?? '会话不存在');
    }
    return resp.data;
  }

  /**
   * 分页查询会话列表。
   */
  async querySessions(
    filter: SessionQueryFilter = {},
  ): Promise<PaginatedResponse<AgentSession>> {
    const qs = buildQueryString(filter as Record<string, unknown>);
    const resp = await this.request<ApiResponse<PaginatedResponse<AgentSession>>>(
      'GET',
      `/api/sessions${qs}`,
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, '/api/sessions', resp.error ?? '查询失败');
    }
    return resp.data;
  }

  /**
   * 获取指定工作区内尚未绑定 Commit 的会话列表。
   */
  async getUnboundSessions(
    workspacePath: string,
    limit = 50,
  ): Promise<AgentSession[]> {
    const qs = buildQueryString({ workspacePath, limit });
    const resp = await this.request<ApiResponse<AgentSession[]>>(
      'GET',
      `/api/sessions/unbound${qs}`,
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, '/api/sessions/unbound', resp.error ?? '查询失败');
    }
    return resp.data;
  }

  /**
   * 更新会话标签。
   */
  async updateSessionTags(
    sessionId: string,
    tags: string[],
  ): Promise<AgentSession> {
    const resp = await this.request<ApiResponse<AgentSession>>(
      'PATCH',
      `/api/sessions/${encodeURIComponent(sessionId)}/tags`,
      { tags },
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, `/api/sessions/${sessionId}/tags`, resp.error ?? '更新失败');
    }
    return resp.data;
  }

  /**
   * 更新会话备注。
   */
  async updateSessionNote(
    sessionId: string,
    note: string,
  ): Promise<AgentSession> {
    const resp = await this.request<ApiResponse<AgentSession>>(
      'PATCH',
      `/api/sessions/${encodeURIComponent(sessionId)}/note`,
      { note },
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, `/api/sessions/${sessionId}/note`, resp.error ?? '更新失败');
    }
    return resp.data;
  }

  /**
   * 手动将单条会话绑定到指定 Commit（传 null 则解绑）。
   */
  async bindSessionToCommit(
    sessionId: string,
    commitHash: string | null,
  ): Promise<AgentSession> {
    const resp = await this.request<ApiResponse<AgentSession>>(
      'PATCH',
      `/api/sessions/${encodeURIComponent(sessionId)}/commit`,
      { commitHash },
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, `/api/sessions/${sessionId}/commit`, resp.error ?? '绑定失败');
    }
    return resp.data;
  }

  /**
   * 删除单条会话记录。
   */
  async deleteSession(sessionId: string): Promise<void> {
    const resp = await this.request<ApiResponse>(
      'DELETE',
      `/api/sessions/${encodeURIComponent(sessionId)}`,
    );
    if (!resp.success) {
      throw new BackendApiError(200, `/api/sessions/${sessionId}`, resp.error ?? '删除失败');
    }
  }

  /**
   * 获取会话统计信息。
   */
  async getSessionStats(workspacePath?: string): Promise<Record<string, unknown>> {
    const qs = workspacePath
      ? buildQueryString({ workspacePath })
      : '';
    const resp = await this.request<ApiResponse<Record<string, unknown>>>(
      'GET',
      `/api/sessions/stats${qs}`,
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, '/api/sessions/stats', resp.error ?? '获取统计失败');
    }
    return resp.data;
  }

  // ─────────────────────────────────────────────
  // Commit 绑定 API
  // ─────────────────────────────────────────────

  /**
   * 批量绑定多条会话到同一个 Commit。
   */
  async bindCommit(
    sessionIds: string[],
    commitHash: string,
    workspacePath?: string,
  ): Promise<CommitBinding> {
    const resp = await this.request<ApiResponse<CommitBinding>>(
      'POST',
      '/api/commits/bind',
      { sessionIds, commitHash, workspacePath },
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, '/api/commits/bind', resp.error ?? '绑定失败');
    }
    return resp.data;
  }

  /**
   * 解绑单条会话与 Commit 的关联。
   */
  async unbindSession(sessionId: string): Promise<void> {
    const resp = await this.request<ApiResponse>(
      'DELETE',
      `/api/commits/unbind/${encodeURIComponent(sessionId)}`,
    );
    if (!resp.success) {
      throw new BackendApiError(
        200,
        `/api/commits/unbind/${sessionId}`,
        resp.error ?? '解绑失败',
      );
    }
  }

  /**
   * 获取指定 Commit 的绑定信息。
   */
  async getCommitBinding(commitHash: string): Promise<CommitBinding> {
    const resp = await this.request<ApiResponse<CommitBinding>>(
      'GET',
      `/api/commits/${encodeURIComponent(commitHash)}`,
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(
        200,
        `/api/commits/${commitHash}`,
        resp.error ?? '未找到绑定记录',
      );
    }
    return resp.data;
  }

  /**
   * 列出所有 Commit 绑定记录（分页）。
   */
  async listCommitBindings(
    page = 1,
    pageSize = 20,
    workspacePath?: string,
  ): Promise<PaginatedResponse<CommitBinding>> {
    const qs = buildQueryString({ page, pageSize, workspacePath });
    const resp = await this.request<ApiResponse<PaginatedResponse<CommitBinding>>>(
      'GET',
      `/api/commits/${qs}`,
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, '/api/commits', resp.error ?? '查询失败');
    }
    return resp.data;
  }

  /**
   * 向指定工作区仓库注入 post-commit Git 钩子。
   */
  async installGitHook(
    workspacePath: string,
    backendUrl?: string,
  ): Promise<{ repoRootPath: string; currentBranch: string }> {
    const resp = await this.request<
      ApiResponse<{ repoRootPath: string; currentBranch: string; backendUrl: string }>
    >('POST', '/api/commits/hook/install', {
      workspacePath,
      backendUrl: backendUrl ?? this.baseUrl,
    });
    if (!resp.success || !resp.data) {
      throw new BackendApiError(
        200,
        '/api/commits/hook/install',
        resp.error ?? '安装钩子失败',
      );
    }
    return resp.data;
  }

  /**
   * 移除指定工作区仓库的 post-commit Git 钩子。
   */
  async removeGitHook(workspacePath: string): Promise<void> {
    const resp = await this.request<ApiResponse>(
      'DELETE',
      '/api/commits/hook/remove',
      { workspacePath },
    );
    if (!resp.success) {
      throw new BackendApiError(
        200,
        '/api/commits/hook/remove',
        resp.error ?? '移除钩子失败',
      );
    }
  }

  // ─────────────────────────────────────────────
  // 导出 API
  // ─────────────────────────────────────────────

  /**
   * 根据导出选项生成报告内容（内联模式，返回 ExportResult 对象）。
   */
  async exportSessions(options: ExportOptions): Promise<ExportResult> {
    const resp = await this.request<ApiResponse<ExportResult>>(
      'POST',
      '/api/export',
      { ...options, download: false },
    );
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, '/api/export', resp.error ?? '导出失败');
    }
    return resp.data;
  }

  /**
   * 获取导出内容预览（前 50 行）。
   */
  async previewExport(
    options: ExportOptions,
  ): Promise<ExportResult & { isTruncated: boolean }> {
    const resp = await this.request<
      ApiResponse<ExportResult & { isTruncated: boolean }>
    >('POST', '/api/export/preview', options);
    if (!resp.success || !resp.data) {
      throw new BackendApiError(200, '/api/export/preview', resp.error ?? '预览失败');
    }
    return resp.data;
  }
}

// ─────────────────────────────────────────────
// 工厂函数 & 单例管理
// ─────────────────────────────────────────────

let _defaultClient: BackendClient | null = null;

/**
 * 获取（或创建）默认 BackendClient 单例。
 * VS Code 插件激活时，通过 initBackendClient() 注入配置；
 * 此后所有模块可直接调用 getBackendClient() 取得实例。
 */
export function getBackendClient(): BackendClient {
  if (!_defaultClient) {
    // 兜底：使用默认地址，避免调用方 null check
    _defaultClient = new BackendClient({ baseUrl: 'http://localhost:7892' });
  }
  return _defaultClient;
}

/**
 * 使用最新配置初始化（或重建）默认 BackendClient 单例。
 * 应在插件激活时以及配置变更时调用。
 */
export function initBackendClient(config: Pick<AgentLogConfig, 'backendUrl' | 'debug'>): BackendClient {
  _defaultClient = new BackendClient({
    baseUrl: config.backendUrl,
    timeoutMs: config.debug ? 10_000 : 5_000,
  });
  return _defaultClient;
}

/**
 * 销毁默认单例（插件停用时调用）。
 */
export function destroyBackendClient(): void {
  _defaultClient = null;
}

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/**
 * 将对象序列化为 URL 查询字符串（以 "?" 开头）。
 * undefined / null / 空字符串的字段会被忽略。
 * 数组字段会展开为多个同名参数，例如 tags=a&tags=b。
 */
function buildQueryString(params: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') {
          parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
        }
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }

  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
