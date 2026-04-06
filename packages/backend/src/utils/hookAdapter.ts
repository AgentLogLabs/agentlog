/**
 * @agentlog/backend — HookEventAdapter
 *
 * 将 Cursor、Cline、OpenCode 等异构事件统一映射为 Span 结构。
 * 支持的事件类型：preToolUse、tool.execute.before 等。
 */

import type { ActorType } from '../services/traceService.js';

/**
 * 支持的 Agent 来源（与 @agentlog/shared 的 AgentSource 保持一致）
 */
export type HookAgentSource = 'cursor' | 'cline' | 'opencode';

/**
 * 原始 Hook 事件的并集类型（来自各 Agent 的 webhook/hook 回调）
 */
export interface CursorHookEvent {
  source: 'cursor';
  event: 'preToolUse' | 'tool.execute.before' | 'tool.result' | 'postToolUse';
  traceId: string;
  sessionId?: string;
  timestamp?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  cwd?: string;
  actorType?: ActorType;
  actorName?: string;
}

export interface ClineHookEvent {
  source: 'cline';
  event: 'preToolUse' | 'tool.execute.before' | 'tool.result' | 'postToolUse';
  traceId: string;
  sessionId?: string;
  timestamp?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  cwd?: string;
  actorType?: ActorType;
  actorName?: string;
}

export interface OpenCodeHookEvent {
  source: 'opencode';
  event: 'preToolUse' | 'tool.execute.before' | 'tool.result' | 'postToolUse';
  traceId: string;
  sessionId?: string;
  timestamp?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  cwd?: string;
  actorType?: ActorType;
  actorName?: string;
}

export type HookEvent = CursorHookEvent | ClineHookEvent | OpenCodeHookEvent;

/**
 * Span 创建请求（与 traceService.CreateSpanRequest 兼容）
 */
export interface AdaptedSpanRequest {
  traceId: string;
  parentSpanId?: string | null;
  actorType: ActorType;
  actorName: string;
  payload: Record<string, unknown>;
}

/**
 * HookEventAdapter 配置项
 */
export interface HookEventAdapterOptions {
  /**
   * 默认 actorType（当事件未指定时使用）
   * @default 'agent'
   */
  defaultActorType?: ActorType;

  /**
   * 默认 actorName（当事件未指定时使用）
   * @default 'unknown'
   */
  defaultActorName?: string;
}

const DEFAULT_OPTIONS: HookEventAdapterOptions = {
  defaultActorType: undefined,
  defaultActorName: undefined,
};

/**
 * 事件名到 ActorType 的默认映射
 * 工具执行类事件 → agent，用户交互类事件 → human
 */
function inferActorTypeFromEvent(event: string): ActorType {
  switch (event) {
    case 'preToolUse':
    case 'tool.execute.before':
      return 'agent';
    case 'postToolUse':
    case 'tool.result':
      return 'system';
    default:
      return 'agent';
  }
}

/**
 * 从工具名推断 actorName
 * 工具名格式通常为 namespace.name，如 cursor.edit, cline.read
 */
function inferActorName(source: HookAgentSource, toolName?: string): string {
  if (toolName) {
    return toolName;
  }
  return source;
}

/**
 * 将原始 Hook 事件适配为 Span 创建请求
 *
 * @param rawEvent 原始事件（来自 Cursor/Cline/OpenCode 的 hook 回调）
 * @param options 适配器配置
 * @returns AdaptedSpanRequest | null（无法适配时返回 null）
 */
interface ResolvedOptions {
  defaultActorType: ActorType | undefined;
  defaultActorName: string | undefined;
}

export function adaptHookEvent(
  rawEvent: HookEvent,
  options: HookEventAdapterOptions = {}
): AdaptedSpanRequest | null {
  const opts: ResolvedOptions = {
    defaultActorType: options.defaultActorType ?? DEFAULT_OPTIONS.defaultActorType,
    defaultActorName: options.defaultActorName ?? DEFAULT_OPTIONS.defaultActorName,
  };

  if (!rawEvent.traceId) {
    return null;
  }

  const inferredActorType = inferActorTypeFromEvent(rawEvent.event);
  const actorType: ActorType = rawEvent.actorType ?? opts.defaultActorType ?? inferredActorType;
  const inferredActorName = inferActorName(rawEvent.source, rawEvent.toolName);
  const actorName: string = rawEvent.actorName ?? opts.defaultActorName ?? inferredActorName;

  const payload: Record<string, unknown> = {
    source: rawEvent.source,
    event: rawEvent.event,
  };

  if (rawEvent.toolName) {
    payload.toolName = rawEvent.toolName;
  }

  if (rawEvent.toolInput) {
    payload.toolInput = rawEvent.toolInput;
  }

  if (rawEvent.toolResult !== undefined) {
    payload.toolResult = rawEvent.toolResult;
  }

  if (rawEvent.sessionId) {
    payload.sessionId = rawEvent.sessionId;
  }

  if (rawEvent.cwd) {
    payload.cwd = rawEvent.cwd;
  }

  if (rawEvent.timestamp) {
    payload.timestamp = rawEvent.timestamp;
  }

  return {
    traceId: rawEvent.traceId,
    actorType,
    actorName,
    payload,
  };
}

/**
 * HookEventAdapter 类
 *
 * 提供中间件能力，可嵌入 Fastify 预处理管道。
 * 在 POST /api/spans 接收数据前，将异构 hook 事件转换为统一 Span 结构。
 */
export class HookEventAdapter {
  private opts: ResolvedOptions;

  constructor(options: HookEventAdapterOptions = {}) {
    this.opts = {
      defaultActorType: options.defaultActorType ?? DEFAULT_OPTIONS.defaultActorType,
      defaultActorName: options.defaultActorName ?? DEFAULT_OPTIONS.defaultActorName,
    };
  }

  /**
   * 将请求体中的 hook 事件适配为 Span 请求
   *
   * @param body Fastify 请求体（原始 hook 事件）
   * @returns AdaptedSpanRequest | null（无法适配时返回 null，调用方应使用原始 body）
   */
  adapt(body: unknown): AdaptedSpanRequest | null {
    if (!isHookEvent(body)) {
      return null;
    }
    return adaptHookEvent(body as HookEvent, this.opts);
  }

  /**
   * 检查给定的 body 是否为可适配的 HookEvent
   */
  canAdapt(body: unknown): body is HookEvent {
    return isHookEvent(body);
  }
}

/**
 * 类型守卫：判断 body 是否为 HookEvent 形状
 */
function isHookEvent(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return false;
  }

  const obj = body as Record<string, unknown>;

  if (typeof obj.source !== 'string') {
    return false;
  }

  const validSources: HookAgentSource[] = ['cursor', 'cline', 'opencode'];
  if (!validSources.includes(obj.source as HookAgentSource)) {
    return false;
  }

  if (typeof obj.event !== 'string') {
    return false;
  }

  if (typeof obj.traceId !== 'string') {
    return false;
  }

  return true;
}

export const defaultAdapter = new HookEventAdapter();
