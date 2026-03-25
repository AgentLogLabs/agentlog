# AgentLog Developer Guide

This document provides guidelines for AI coding agents working on the AgentLog codebase.

## Project Overview

AgentLog is a VS Code/Cursor extension with a local Fastify + SQLite backend that captures AI agent interaction logs and binds them to Git commits. It's a pnpm monorepo with three packages:

- `@agentlog/shared` - Shared TypeScript types and utilities
- `@agentlog/backend` - Fastify server with SQLite storage (port 7892)
- `agentlog-vscode` - VS Code extension

## Build / Lint / Test Commands

### Root Commands (from project root)

```bash
# Install dependencies
pnpm install

# Build all packages (shared → backend → vscode-extension)
pnpm build

# Build individual packages
pnpm build:shared
pnpm build:backend
pnpm build:ext

# Start backend in dev mode with hot reload
pnpm dev

# Type check all packages
pnpm lint

# Clean all dist folders
pnpm clean
```

### Backend Commands

```bash
cd packages/backend

# Start dev server (tsx watch)
pnpm dev

# Build TypeScript
pnpm build

# Type check (lint)
pnpm lint

# Run all tests
pnpm test

# Run a single test file
node --import tsx --test test/integration.test.ts

# Clean dist
pnpm clean
```

### VSCode Extension Commands

```bash
cd packages/vscode-extension

# Compile TypeScript
pnpm compile

# Watch mode
pnpm watch

# Build for publishing
pnpm build

# Package as .vsix
pnpm package

# Type check
pnpm lint

# Run fetch interception tests
pnpm test:fetch
```

## Code Style Guidelines

### TypeScript Configuration

- Target: ES2020
- Module: CommonJS
- Strict mode: enabled
- Use `tsc --noEmit` for linting

### Imports

- Use path aliases: `@agentlog/shared` for shared types
- Use `import type` for type-only imports
- Order imports: external → internal → types

```typescript
import { nanoid } from 'nanoid';
import type { AgentSession, CreateSessionRequest } from '@agentlog/shared';
import { getDatabase, closeDatabase } from '../db/database';
```

### Naming Conventions

- **Files**: camelCase (e.g., `logService.ts`, `sessionTreeProvider.ts`)
- **Interfaces/Types**: PascalCase (e.g., `AgentSession`, `SessionQueryFilter`)
- **Functions/Variables**: camelCase
- **Constants**: camelCase or UPPER_SNAKE_CASE for config
- **Database columns**: snake_case (enforced in database.ts)
- **Database row types**: `SessionRow`, `CommitRow` (suffix with `Row`)

### Type Usage

- Use TypeScript strict mode
- Use `interface` for public APIs and data shapes
- Use `type` for unions, primitives, and utility types
- Always type function parameters and return values
- Use `Record<string, unknown>` for extensible objects
- Use optional properties (`?`) for nullable fields

### Error Handling

- Throw errors with descriptive messages: `throw new Error(\`[logService] 会话写入失败，id=\${id}\`)`
- Use try-catch in route handlers with proper HTTP status codes
- Return `{ success: boolean; error?: string }` for API responses
- Use proper HTTP status codes: 200 (OK), 201 (Created), 400 (Bad Request), 404 (Not Found), 500 (Server Error)

### Database Patterns

- Use `better-sqlite3` with prepared statements
- Use parameterized queries: `db.prepare('SELECT * FROM users WHERE id = ?')`
- Use transactions for batch operations: `db.transaction(() => { ... })()`
- Map snake_case database rows to camelCase entities via dedicated functions (`rowToSession`)
- Use `toJson()` / `fromJson()` for JSON columns (tags, metadata, affectedFiles)

### Code Organization

- Use section dividers for major code blocks:

```typescript
// ─────────────────────────────────────────────
// 创建
// ─────────────────────────────────────────────
```

- Add JSDoc comments for public functions describing purpose, params, and return value
- Keep functions focused and under 100 lines when possible

### VS Code Extension Specifics

- Use VS Code API from `@types/vscode`
- Register commands in `package.json` contributes section
- Use TreeView for sidebar panels
- Use Webview for detailed views and dashboards
- Activate on `onStartupFinished` and chat participants

### Testing

- Tests use Node.js native test runner with `--import tsx`
- Use `describe` / `it` blocks
- Use `assert` for assertions
- Create test fixtures for reusable test data
- Test both success and error cases

### Git Commit Hooks

- Commit messages follow conventional format
- Post-commit hooks auto-bind sessions to commits
- Use `simple-git` for Git operations

### Logging

- Backend uses `pino-pretty` for dev logging
- Use `[serviceName]` prefix in log messages: `[logService] 会话创建成功`
- Support debug mode via configuration

### Common Issues

- Rebuild `@agentlog/shared` first before other packages (other packages depend on it)
- Database file stored at `~/.agentlog/agentlog.db`
- Backend default port: 7892 (configurable via `AGENTLOG_PORT`)
- CORS restricted to localhost origins only

## AgentLog MCP Interaction Logging (MANDATORY)

This project has an AgentLog MCP server configured. You MUST use it to record every conversation.

### Rules

1. **On receiving the user's FIRST message**: Call `agentlog_log_turn` with `role: "user"` and the user's message as `content`. Pass your model name in the `model` parameter. Do NOT pass `session_id` on the first call — the tool will return one. Store it for all subsequent calls.
2. **On every subsequent user message**: Call `agentlog_log_turn` with `role: "user"`, the user's `content`, and the `session_id` from step 1.
3. **On every assistant response you produce**: Call `agentlog_log_turn` with `role: "assistant"` and your **COMPLETE, FULL response** as `content`, using the same `session_id`. If you have reasoning/thinking content, pass it in the `reasoning` parameter.
4. **On tool executions (optional but recommended)**: Call `agentlog_log_turn` with `role: "tool"`, the tool result summary as `content`, `tool_name`, and optionally `tool_input`.
5. **When a task is completed**: Call `agentlog_log_intent` with a brief `task` summary, `affected_files` list, your `model` name, and the `session_id`. This finalizes the session record.
6. **To look up past context**: Use `agentlog_query_historical_interaction` to search previous sessions by keyword, filename, date range, commit hash, etc.

### Important Notes

- NEVER skip logging. Every user message and every assistant response must be recorded.
- The `session_id` returned by the first `agentlog_log_turn` call must be reused for the entire conversation.
- **CRITICAL: Pass your FULL, COMPLETE response text** to `agentlog_log_turn` — NOT a summary or abbreviation. The transcript must faithfully reproduce the entire conversation. If your response is very long, still pass the complete text.
- Logging calls should NOT block or delay your response to the user — make them in parallel with other tool calls when possible.
  - If an `agentlog_log_turn` call fails, log a warning to stderr but continue working normally. Do not let logging failures interrupt the user's workflow.

## MCP Protocol Compliance Checklist and Examples

This section provides detailed examples and checklists to ensure OpenCode (and other MCP clients) fully comply with the AgentLog MCP protocol as defined in `@docs/MCP-CLIENT-GUIDE.md`.

### Complete Call Sequence Example

A standard multi-turn conversation should follow this exact pattern:

```json
// Step 1: First user message (creates session automatically)
{
  "role": "user",
  "content": "Refactor the parseData function in utils.ts to follow single responsibility principle",
  "model": "deepseek-r1",
  "workspace_path": "/Users/dev/my-project"
}
// → Returns: "消息已记录（session_id=abc123xyz）"

// Step 2: Assistant reply with reasoning (must include complete thinking process)
{
  "session_id": "abc123xyz",
  "role": "assistant",
  "content": "I'll split the function into three separate responsibilities...",
  "reasoning": "The current parseData function handles validation, transformation, and error handling. This violates SRP.\n\nAnalysis:\n1. Validation should check input format and constraints\n2. Transformation should convert data structure\n3. Error handling should provide meaningful messages\n\nImplementation plan:\n- create validateInput()\n- create transformData()\n- create handleParseError()\n- Keep parseData() as a facade for backward compatibility"
}

// Step 3: Tool execution (file creation)
{
  "session_id": "abc123xyz",
  "role": "tool",
  "content": "Created src/utils/validateInput.ts (45 lines)",
  "tool_name": "write",
  "tool_input": "filePath=src/utils/validateInput.ts"
}

// Step 4: Tool execution (file edit)
{
  "session_id": "abc123xyz",
  "role": "tool",
  "content": "Updated src/utils/parseData.ts to use new functions",
  "tool_name": "edit",
  "tool_input": "filePath=src/utils/parseData.ts"
}

// Step 5: Assistant reply (after tools executed)
{
  "session_id": "abc123xyz",
  "role": "assistant",
  "content": "Refactoring complete. The parseData function now delegates to three specialized functions.",
  "reasoning": "All three new functions have been created and integrated. Backward compatibility maintained."
}

// Step 6: Task completion (called once at the end)
{
  "session_id": "abc123xyz",
  "role": "assistant",
  "content": "Task completed successfully.",
  "reasoning": "Final verification shows all tests pass and code is cleaner."
}

// Step 7: Intent logging (final summary)
{
  "session_id": "abc123xyz",
  "task": "Refactor parseData function into three single-responsibility functions",
  "model": "deepseek-r1",
  "affected_files": [
    "src/utils/validateInput.ts",
    "src/utils/transformData.ts",
    "src/utils/handleParseError.ts",
    "src/utils/parseData.ts"
  ]
}
```

### Compliance Validation Checklist

Use the following checklist to verify MCP protocol compliance. Each item **must** be satisfied for complete logging:

#### ✅ Message Recording
- [ ] **Every** user message → `log_turn(role="user", content="...", model="...", workspace_path="...")`
- [ ] **Every** assistant response → `log_turn(role="assistant", content="...", reasoning="...")`
- [ ] **Every** tool execution → `log_turn(role="tool", content="...", tool_name="...", tool_input="...")`
- [ ] **Session persistence** → Same `session_id` reused throughout entire conversation

#### ✅ Reasoning Requirements
- [ ] **DeepSeek-R1** → Accumulate `delta.reasoning_content` from streaming response, pass as `reasoning`
- [ ] **Claude extended thinking** → Pass `thinking` content block as `reasoning`
- [ ] **Other reasoning models** → Map model's thinking output to `reasoning` field
- [ ] **No truncation** → Complete thinking process, no summaries or omissions

#### ✅ Tool Execution Tracking
- [ ] **File operations** → `tool_input` must contain `filePath=` parameter
- [ ] **Command execution** → `tool_input` should capture command and arguments
- [ ] **Read operations** → `tool_input` should note which file was read
- [ ] **Multiple tools** → Each tool call recorded separately, not batched

#### ✅ Timing and Ordering
- [ ] **Immediate calls** → `log_turn` called right after each message, no batching
- [ ] **Sequential ordering** → Calls follow message order: user → assistant → tool → assistant → ...
- [ ] **Single intent call** → `log_intent` called exactly once at task completion
- [ ] **Affected files** → All modified files listed in `affected_files`

### Common Compliance Failures

| Failure Pattern | Symptom | Root Cause | Fix |
|----------------|---------|------------|-----|
| **Missing tool messages** | transcript has user/assistant but no tool records | Tool executions not wrapped in `log_turn(role="tool")` | Call `log_turn` after **every** tool execution |
| **Empty reasoning** | assistant messages lack `reasoning` field | Thinking process not captured or passed | Ensure model's thinking output is mapped to `reasoning` |
| **Missing file paths** | `affected_files` empty despite file changes | `tool_input` missing `filePath=` parameter | Always include `filePath=` in tool_input for file operations |
| **Session ID loss** | Each message creates new session | `session_id` not saved/reused between calls | Parse and cache `session_id` from first response |
| **Message ratio imbalance** | user:assistant:tool ratio far from 1:1:1 | Selective logging (e.g., only logging some messages) | Log **every** message immediately after it's produced |

### Validation Script

Use the built-in validation script to check compliance:

```bash
# Run from project root
node scripts/verify-mcp-compliance.js

# Detailed output
node scripts/verify-mcp-compliance.js --detailed

# Skip recent session analysis
node scripts/verify-mcp-compliance.js --no-analyze
```

The script will:
1. Verify backend connectivity
2. Analyze recent session transcripts for compliance issues
3. Check message ratios (user:assistant:tool)
4. Identify missing reasoning or tool_input fields
5. Provide actionable recommendations

### Debugging Session zs_-oCWpzC0KkKRUBfFiv

The session `zs_-oCWpzC0KkKRUBfFiv` shows typical compliance failures:
- **11 total messages** (should be 20+ for this conversation)
- **4 assistant messages** (should be 8+)
- **0 tool messages** (should be 5+)
- **Missing reasoning** in assistant messages
- **Missing tool_input** for file operations

**Diagnosis**: OpenCode is not calling `log_turn` for every message, especially tool executions and reasoning content.

**Solution**: Ensure OpenCode's MCP client implementation follows the complete call sequence above, logging **every** user, assistant, and tool message with proper fields.
