# AgentLog Developer Guide

Guidelines for AI coding agents working on the AgentLog codebase.

## Project Overview

AgentLog is a VS Code/Cursor extension with a local Fastify + SQLite backend that captures AI agent interaction logs and binds them to Git commits. It's a pnpm monorepo with three packages:
- `@agentlog/shared` - Shared TypeScript types and utilities
- `@agentlog/backend` - Fastify server with SQLite storage (port 7892)
- `agentlog-vscode` - VS Code extension

## Build / Lint / Test Commands

### Root Commands
```bash
# Install dependencies
pnpm install

# Build all packages (shared → backend → vscode-extension)
pnpm build

# Build individual packages
pnpm build:shared    # Must be built first (other packages depend on it)
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
- Use path aliases: `@agentlog/shared` for shared types

### Imports Order
1. External dependencies
2. Type-only imports (`import type`)
3. Internal modules with path aliases
4. Relative imports

```typescript
import { nanoid } from 'nanoid';
import type { AgentSession, CreateSessionRequest } from '@agentlog/shared';
import { getDatabase, closeDatabase } from '../db/database';
```

### Naming Conventions
- **Files**: camelCase (`logService.ts`, `sessionTreeProvider.ts`)
- **Interfaces/Types**: PascalCase (`AgentSession`, `SessionQueryFilter`)
- **Functions/Variables**: camelCase
- **Constants**: camelCase or UPPER_SNAKE_CASE for config
- **Database columns**: snake_case (enforced in database.ts)
- **Database row types**: `SessionRow`, `CommitRow` (suffix with `Row`)

### Type Usage
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

### Testing
- Tests use Node.js native test runner with `--import tsx`
- Use `describe` / `it` blocks
- Use `assert` for assertions
- Create test fixtures for reusable test data
- Test both success and error cases

## AgentLog MCP Interaction Logging (MANDATORY)

This project has an AgentLog MCP server configured. You MUST use it to record every conversation.

### Essential Rules
1. **First user message**: Call `agentlog_log_turn` with `role: "user"`, user's message as `content`, and your model name. Do NOT pass `session_id` — store the returned one.
2. **Subsequent user messages**: Call `agentlog_log_turn` with `role: "user"`, `content`, and the `session_id`.
3. **Every assistant response**: Call `agentlog_log_turn` with `role: "assistant"`, your complete response as `content`, and reasoning content in `reasoning` (if applicable).
4. **Tool executions**: Call `agentlog_log_turn` with `role: "tool"`, result summary as `content`, `tool_name`, and `tool_input` (include `filePath=` for file operations).
5. **Task completion**: Call `agentlog_log_intent` with brief `task` summary, `affected_files` list, and your `model` name.

### Critical Requirements
- **Never skip logging**: Every user message, assistant response, and tool execution must be recorded.
- **Session persistence**: Reuse the same `session_id` throughout the entire conversation.
- **Complete content**: Pass FULL response text, not summaries or abbreviations.
- **File paths**: Always include `filePath=` in `tool_input` for file operations.
- **Reasoning**: For reasoning models (DeepSeek-R1, Claude), pass complete thinking process in `reasoning` field.

### Quick Validation
```bash
# Verify MCP compliance
node scripts/verify-mcp-compliance.js
```

## Common Issues & Solutions
- **Rebuild order**: Always rebuild `@agentlog/shared` first before other packages.
- **Database location**: `~/.agentlog/agentlog.db`
- **Backend port**: Default 7892 (configurable via `AGENTLOG_PORT`)
- **CORS**: Restricted to localhost origins only
- **Token count mismatch**: OpenCode/Cursor shows context tokens; AgentLog records model API tokens

## VS Code Extension Specifics
- Use VS Code API from `@types/vscode`
- Register commands in `package.json` contributes section
- Use TreeView for sidebar panels
- Use Webview for detailed views and dashboards
- Activate on `onStartupFinished` and chat participants