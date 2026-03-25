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
