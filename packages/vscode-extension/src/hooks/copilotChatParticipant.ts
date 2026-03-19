/**
 * @agentlog/vscode-extension — Copilot Chat Participant
 *
 * 注册一个 @agentlog Chat Participant，借助 Copilot 提供的语言模型
 * （如 Claude Haiku 4.5、GPT-4o 等）转发用户请求、捕获完整对话，
 * 并自动上报到 AgentLog 后端。
 *
 * 用法：
 *   在 VS Code Copilot Chat 中输入 @agentlog <你的问题>
 *   对话将通过当前选中的模型处理，同时被 AgentLog 记录。
 *
 * 依赖：
 *   - VS Code >= 1.93（Chat Participant + Language Model API）
 *   - GitHub Copilot 扩展已激活
 */

import * as vscode from "vscode";
import { getBackendClient } from "../client/backendClient";
import type { ModelProvider } from "@agentlog/shared";

// ─────────────────────────────────────────────
// Chat Participant 注册
// ─────────────────────────────────────────────

const PARTICIPANT_ID = "agentlog.chat";

/**
 * 注册 @agentlog Chat Participant 并返回 Disposable。
 *
 * 调用方在 extension.ts 的 activate() 中调用此函数，
 * 并将返回值推入 context.subscriptions 即可。
 */
export function registerCopilotChatParticipant(
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const startTime = Date.now();
    const prompt = request.prompt;
    const model = request.model;

    outputChannel.appendLine(
      `[AgentLog] @agentlog 收到请求 — model=${model.name} family=${model.family} prompt="${truncate(prompt, 80)}"`,
    );

    try {
      // ── 构建消息历史（多轮上下文） ──────────────
      const messages = buildMessages(chatContext, prompt);

      // ── 调用模型 ──────────────────────────────
      const chatResponse = await model.sendRequest(messages, {}, token);

      // ── 流式输出并捕获完整响应 ─────────────────
      let fullResponse = "";
      for await (const chunk of chatResponse.text) {
        fullResponse += chunk;
        response.markdown(chunk);
      }

      const durationMs = Date.now() - startTime;

      outputChannel.appendLine(
        `[AgentLog] 模型响应完成 (${durationMs}ms, ${fullResponse.length} chars)`,
      );

      // ── 上报到后端 ────────────────────────────
      await reportSession({
        model,
        prompt,
        fullResponse,
        durationMs,
        outputChannel,
      });
    } catch (err) {
      const durationMs = Date.now() - startTime;

      if (err instanceof vscode.LanguageModelError) {
        outputChannel.appendLine(
          `[AgentLog] 模型调用失败 (${durationMs}ms): ${err.message}`,
        );
        response.markdown(
          `\n\n❌ **模型调用失败**: ${err.message}\n\n请检查 Copilot 订阅状态或切换模型后重试。`,
        );
        return;
      }

      // CancellationError — 用户主动取消
      if (
        err instanceof Error &&
        err.name === "CancellationError"
      ) {
        outputChannel.appendLine(`[AgentLog] 用户取消请求 (${durationMs}ms)`);
        return;
      }

      // 未知错误，重新抛出让 VS Code 处理
      throw err;
    }
  };

  // ── 创建 Participant ───────────────────────
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    handler,
  );
  participant.iconPath = new vscode.ThemeIcon("history");

  outputChannel.appendLine("[AgentLog] @agentlog Chat Participant 已注册");

  return participant;
}

// ─────────────────────────────────────────────
// 消息构建（多轮上下文）
// ─────────────────────────────────────────────

/**
 * 从 ChatContext.history 构建 LanguageModelChatMessage 数组，
 * 保留多轮对话上下文。
 */
function buildMessages(
  chatContext: vscode.ChatContext,
  currentPrompt: string,
): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];

  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = extractResponseText(turn);
      if (text) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      }
    }
  }

  // 当前提问
  messages.push(vscode.LanguageModelChatMessage.User(currentPrompt));

  return messages;
}

/**
 * 从 ChatResponseTurn 中提取纯文本（仅 Markdown 部分）。
 */
function extractResponseText(turn: vscode.ChatResponseTurn): string {
  const parts: string[] = [];
  for (const part of turn.response) {
    if (part instanceof vscode.ChatResponseMarkdownPart) {
      parts.push(part.value.value);
    }
  }
  return parts.join("");
}

// ─────────────────────────────────────────────
// 后端上报
// ─────────────────────────────────────────────

interface ReportParams {
  model: vscode.LanguageModelChat;
  prompt: string;
  fullResponse: string;
  durationMs: number;
  outputChannel: vscode.OutputChannel;
}

async function reportSession(params: ReportParams): Promise<void> {
  const { model, prompt, fullResponse, durationMs, outputChannel } = params;

  const workspacePath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  try {
    const client = getBackendClient();
    const session = await client.createSession({
      provider: inferProvider(model.family),
      model: model.name || model.family || "copilot-unknown",
      source: "copilot",
      workspacePath,
      prompt,
      response: fullResponse,
      durationMs,
      metadata: {
        chatParticipant: PARTICIPANT_ID,
        vendor: model.vendor,
        family: model.family,
        modelId: model.id,
      },
    });

    outputChannel.appendLine(
      `[AgentLog] 会话已记录 → id=${session.id}`,
    );
  } catch (err) {
    // 上报失败不应阻断用户交互，仅记日志
    outputChannel.appendLine(
      `[AgentLog] 上报失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/**
 * 从模型 family 推断 ModelProvider。
 *
 * Copilot 提供的模型 family 示例：
 *   - "claude-3.5-haiku" / "claude-sonnet-4" → anthropic
 *   - "gpt-4o" / "o3-mini" → openai
 *   - "deepseek-..." → deepseek
 */
function inferProvider(family: string): ModelProvider {
  const f = family.toLowerCase();
  if (f.includes("claude") || f.includes("anthropic")) return "anthropic";
  if (
    f.includes("gpt") ||
    f.includes("o1") ||
    f.includes("o3") ||
    f.includes("o4") ||
    f.includes("openai")
  )
    return "openai";
  if (f.includes("deepseek")) return "deepseek";
  if (f.includes("qwen") || f.includes("tongyi")) return "qwen";
  if (f.includes("kimi") || f.includes("moonshot")) return "kimi";
  if (f.includes("doubao") || f.includes("skylark")) return "doubao";
  if (f.includes("glm") || f.includes("zhipu")) return "zhipu";
  return "unknown";
}

/** 截断文本用于日志输出 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}
