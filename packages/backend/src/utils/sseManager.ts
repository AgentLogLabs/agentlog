/**
 * @agentlog/backend — SSE 客户端管理器
 *
 * 追踪所有连接到 /mcp/sse 的客户端，
 * 提供广播接口供其他模块推送事件。
 */

import type { ServerResponse } from "node:http";

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

export interface SseClient {
  id: string;
  reply: ServerResponse;
  connectedAt: string;
}

export interface SseEvent {
  type: string;
  data: unknown;
  timestamp: string;
}

// ─────────────────────────────────────────────
// SSE 客户端存储
// ─────────────────────────────────────────────

const clients = new Map<string, SseClient>();

/**
 * 注册一个新的 SSE 客户端
 */
export function addSseClient(id: string, reply: ServerResponse): void {
  clients.set(id, {
    id,
    reply,
    connectedAt: new Date().toISOString(),
  });
}

/**
 * 移除 SSE 客户端
 */
export function removeSseClient(id: string): void {
  clients.delete(id);
}

/**
 * 获取当前活跃客户端数量
 */
export function getSseClientCount(): number {
  return clients.size;
}

/**
 * 向所有客户端广播事件
 */
export function broadcastEvent(event: SseEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  let successCount = 0;
  let failCount = 0;

  for (const [id, client] of clients) {
    try {
      if (client.reply.writable) {
        client.reply.write(payload);
        successCount++;
      } else {
        // 不可写的连接，标记待移除
        failCount++;
      }
    } catch (err) {
      console.error(`[SSE Manager] 广播到客户端 ${id} 失败:`, err);
      failCount++;
    }
  }

  console.log(
    `[SSE Manager] 广播 ${event.type}: 成功 ${successCount}, 失败 ${failCount}, 总计 ${clients.size}`
  );

  // 清理不可用的连接
  if (failCount > 0) {
    cleanupInactiveClients();
  }
}

/**
 * 向指定客户端发送事件
 */
export function sendEventToClient(clientId: string, event: SseEvent): boolean {
  const client = clients.get(clientId);
  if (!client) {
    return false;
  }

  try {
    if (client.reply.writable) {
      client.reply.write(`data: ${JSON.stringify(event)}\n\n`);
      return true;
    }
  } catch (err) {
    console.error(`[SSE Manager] 发送事件到客户端 ${clientId} 失败:`, err);
  }

  return false;
}

/**
 * 清理不可用的客户端连接
 */
function cleanupInactiveClients(): void {
  for (const [id, client] of clients) {
    try {
      if (!client.reply.writable) {
        clients.delete(id);
        console.log(`[SSE Manager] 移除失效客户端: ${id}`);
      }
    } catch {
      clients.delete(id);
    }
  }
}

/**
 * 清理所有客户端（服务关闭时调用）
 */
export async function closeAllClients(): Promise<void> {
  for (const [id, client] of clients) {
    try {
      await client.reply.end();
    } catch (err) {
      console.error(`[SSE Manager] 关闭客户端 ${id} 失败:`, err);
    }
  }
  clients.clear();
  console.log("[SSE Manager] 所有 SSE 客户端已关闭");
}
