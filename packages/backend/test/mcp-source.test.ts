/**
 * Unit Test: MCP inferSource Function - Trae IDE Support
 * 
 * 测试 inferSource 函数正确识别 Trae IDE 客户端名称
 */

import { describe, it } from "node:test";
import assert from "node:assert";

// 从 mcp.ts 提取的 inferSource 函数（复刻）
function inferSource(clientName: string | undefined): string {
  if (!clientName) return "unknown";
  const name = clientName.toLowerCase();
  if (name.includes("opencode")) return "opencode";
  if (name.includes("cline") || name.includes("roo")) return "cline";
  if (name.includes("cursor")) return "cursor";
  if (name.includes("claude")) return "claude-code";
  if (name.includes("copilot") || name.includes("vscode")) return "copilot";
  if (name.includes("continue")) return "continue";
  if (name.includes("trae")) return "trae";
  return "unknown";
}

// ─────────────────────────────────────────────
// 测试 Suite: inferSource Trae IDE 识别
// ─────────────────────────────────────────────

describe("inferSource - Trae IDE Support", () => {

  // Trae IDE 变体名称测试
  it('inferSource("trae") → "trae"', () => {
    assert.equal(inferSource("trae"), "trae");
  });

  it('inferSource("Trae IDE") → "trae"', () => {
    assert.equal(inferSource("Trae IDE"), "trae");
  });

  it('inferSource("trae-builder") → "trae"', () => {
    assert.equal(inferSource("trae-builder"), "trae");
  });

  it('inferSource("TRAE") → "trae" (case insensitive)', () => {
    assert.equal(inferSource("TRAE"), "trae");
  });

  it('inferSource("Trae AI") → "trae"', () => {
    assert.equal(inferSource("Trae AI"), "trae");
  });

  it('inferSource("ByteDance Trae") → "trae"', () => {
    assert.equal(inferSource("ByteDance Trae"), "trae");
  });

  // 其他已知来源保持正常工作
  it('inferSource("opencode") → "opencode"', () => {
    assert.equal(inferSource("opencode"), "opencode");
  });

  it('inferSource("cline") → "cline"', () => {
    assert.equal(inferSource("cline"), "cline");
  });

  it('inferSource("cursor") → "cursor"', () => {
    assert.equal(inferSource("cursor"), "cursor");
  });

  it('inferSource("claude-code") → "claude-code"', () => {
    assert.equal(inferSource("claude-code"), "claude-code");
  });

  it('inferSource("copilot") → "copilot"', () => {
    assert.equal(inferSource("copilot"), "copilot");
  });

  it('inferSource("continue") → "continue"', () => {
    assert.equal(inferSource("continue"), "continue");
  });

  // 未知来源返回 unknown
  it('inferSource("unknown-tool") → "unknown"', () => {
    assert.equal(inferSource("unknown-tool"), "unknown");
  });

  it('inferSource(undefined) → "unknown"', () => {
    assert.equal(inferSource(undefined), "unknown");
  });

  it('inferSource("") → "unknown"', () => {
    assert.equal(inferSource(""), "unknown");
  });

  // 边界情况：包含 "trae" 但不是主要名称
  it('inferSource("my-trae-client") → "trae"', () => {
    assert.equal(inferSource("my-trae-client"), "trae");
  });

  it('inferSource("agent-trae-mode") → "trae"', () => {
    assert.equal(inferSource("agent-trae-mode"), "trae");
  });
});

// ─────────────────────────────────────────────
// 运行说明
// ─────────────────────────────────────────────

console.log("\n🧪 Running MCP inferSource Trae IDE Tests...\n");
console.log("Test file: packages/backend/test/mcp-source.test.ts\n");
console.log("Run with: node --test packages/backend/test/mcp-source.test.ts\n");
