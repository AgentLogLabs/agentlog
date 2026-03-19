# AgentLog — AI Programming Dashcam 🚗📹

> A VS Code/Cursor plugin + lightweight local backend for mainstream domestic LLMs, automatically captures AI Agent interaction logs, binds them to Git commits, and exports weekly reports or PR descriptions with one click.

---

## Background & Pain Points

Domestic developers extensively use Cursor, Cline, or local Agents based on DeepSeek/Qwen APIs. Code gets written fast, but a few days later developers forget why the AI made those changes, and when bugs appear, there's no way to debug them.

**AgentLog** solves this exact problem: silently log everything in the background during your AI interactions, and automatically bind these logs to code changes when you `git commit`.

---

## Core Features

| Feature | Description |
|---------|-------------|
| 🎙️ **Auto Capture** | Intercept requests to DeepSeek / Qwen / Kimi and other APIs, extract Prompt + Response |
| 🧠 **Reasoning Process Storage** | Special support for DeepSeek-R1's `<think>` reasoning chain, fully store intermediate thinking steps |
| 🔗 **Git Commit Binding** | Via post-commit hook, automatically associate each commit with relevant AI sessions |
| 📊 **Sidebar Panel** | VS Code sidebar showing session list, commit bindings, and statistics |
| 📝 **One-Click Export** | Support exporting as Chinese weekly report, PR/Code Review explanation, JSONL raw data, CSV table |
| 🏠 **Local First** | All data stored in local SQLite (`~/.agentlog/agentlog.db`), completely offline capable |

---

## Supported Models & Tools

### Mainstream Domestic Models

| Model | Provider | Notes |
|-------|----------|-------|
| DeepSeek-V3 / R1 | DeepSeek | Full support for reasoning chain capture |
| Qwen / Qwen Max / Plus | Alibaba DashScope | OpenAI-compatible mode |
| Kimi / Moonshot | Moonshot | OpenAI-compatible mode |
| Doubao | ByteDance Ark | OpenAI-compatible mode |
| ChatGLM | Zhipu AI | OpenAI-compatible mode |
| Local Models | Ollama / LM Studio | Local HTTP interface |

### Supported AI Programming Tools

- **Cline** (VS Code Extension)
- **Cursor** (Built-in AI IDE)
- **Continue** (VS Code Extension)
- **Direct API Calls** (Via HTTP interception)

---

## Project Architecture

```
AgentLog/
├── packages/
│   ├── shared/                    # Shared type definitions (TypeScript)
│   │   └── src/
│   │       ├── index.ts
│   │       └── types.ts           # Core types: AgentSession, CommitBinding, etc.
│   │
│   ├── backend/                   # Lightweight local backend (Fastify + SQLite)
│   │   └── src/
│   │       ├── index.ts           # Service entry point, default port 7892
│   │       ├── db/
│   │       │   └── database.ts    # SQLite initialization + Schema + migration system
│   │       ├── routes/
│   │       │   ├── sessions.ts    # /api/sessions CRUD + query + stats
│   │       │   ├── commits.ts     # /api/commits binding + Git Hook management
│   │       │   └── export.ts      # /api/export (weekly report/PR/JSONL/CSV)
│   │       └── services/
│   │           ├── logService.ts  # AgentSession CRUD business logic
│   │           ├── gitService.ts  # Git integration (simple-git + hook injection)
│   │           └── exportService.ts # Report rendering (Markdown / CSV)
│   │
│   └── vscode-extension/          # VS Code/Cursor Extension
│       └── src/
│           ├── extension.ts       # Extension main entry (activate / deactivate)
│           ├── client/
│           │   └── backendClient.ts   # HTTP client for backend communication
│           ├── interceptors/
│           │   └── apiInterceptor.ts  # HTTP Monkey-patch interceptor
│           └── providers/
│               ├── sessionTreeProvider.ts    # Sidebar session list TreeView
│               └── sessionWebviewProvider.ts # Session details & dashboard Webview
│
├── package.json                   # pnpm monorepo root config
├── pnpm-workspace.yaml
└── README.md
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Monorepo | pnpm workspaces |
| Language | TypeScript 5.x (Full-stack) |
| Backend Framework | Fastify 4.x |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Git Integration | `simple-git` |
| VS Code API | `@types/vscode ^1.85` |
| Interception Mechanism | Node.js `http/https` Monkey-patch |
| ID Generation | `nanoid` |

---

## Quick Start

### Prerequisites

- Node.js >= 18
- pnpm >= 9
- Git

### Install Dependencies

```bash
pnpm install
```

### Development Mode

```bash
# Start backend service (hot reload)
pnpm dev

# Or start watch mode for each package separately
pnpm build:shared   # Build shared types first
pnpm dev:backend    # Start backend (tsx watch)
```

### Build Everything

```bash
pnpm build
```

### Debug Extension in VS Code

1. Open the project root with VS Code
2. Press `F5` to launch extension debugging (opens new Extension Development Host window)
3. In the new window, the backend service will auto-start

---

## Backend API Overview

Backend runs on `http://localhost:7892` by default, can be overridden via `AGENTLOG_PORT` environment variable.

### Session Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sessions` | Report new session |
| `GET` | `/api/sessions` | Paginated query (supports multi-dimensional filtering) |
| `GET` | `/api/sessions/stats` | Statistics data |
| `GET` | `/api/sessions/unbound` | Query sessions unbound to commits |
| `GET` | `/api/sessions/:id` | Get single session details |
| `PATCH` | `/api/sessions/:id/tags` | Update tags |
| `PATCH` | `/api/sessions/:id/note` | Update note |
| `PATCH` | `/api/sessions/:id/commit` | Manual bind/unbind commit |
| `DELETE` | `/api/sessions/:id` | Delete session |

### Commit Binding Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/commits/hook` | Git post-commit hook receiver |
| `POST` | `/api/commits/bind` | Manual batch binding |
| `DELETE` | `/api/commits/unbind/:sessionId` | Unbind |
| `GET` | `/api/commits` | List all binding records |
| `GET` | `/api/commits/:hash` | Query binding info for specific commit |
| `GET` | `/api/commits/:hash/sessions` | Get all sessions associated with commit |
| `POST` | `/api/commits/hook/install` | Inject Git hook |
| `DELETE` | `/api/commits/hook/remove` | Remove Git hook |

### Export Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/export/formats` | Get list of supported export formats |
| `POST` | `/api/export` | Generate export content |
| `POST` | `/api/export/preview` | Preview (first 50 lines) |

---

## Data Models

### AgentSession (AI Interaction Session)

```typescript
interface AgentSession {
  id: string;              // nanoid
  createdAt: string;       // ISO 8601
  provider: ModelProvider; // 'deepseek' | 'qwen' | 'kimi' | ...
  model: string;           // Actual model name, e.g. "deepseek-r1"
  source: AgentSource;     // 'cline' | 'cursor' | 'continue' | ...
  workspacePath: string;   // Workspace absolute path
  prompt: string;          // Complete user prompt
  reasoning?: string;      // AI reasoning process (DeepSeek-R1 <think> content)
  response: string;        // AI final response
  commitHash?: string;     // Bound Git commit SHA
  affectedFiles: string[]; // List of affected files
  durationMs: number;      // Interaction duration (milliseconds)
  tags?: string[];         // User tags
  note?: string;           // User note
  metadata?: Record<string, unknown>; // Extension fields
}
```

### CommitBinding (Commit Binding)

```typescript
interface CommitBinding {
  commitHash: string;      // Git full SHA-1
  sessionIds: string[];    // List of associated session IDs
  message: string;         // Commit message
  committedAt: string;     // Commit timestamp
  authorName: string;      // Committer name
  authorEmail: string;
  changedFiles: string[];  // List of changed files
  workspacePath: string;
}
```

---

## Configuration

In VS Code settings (`settings.json`), all configuration items use `agentlog.` prefix:

| Configuration | Default | Description |
|---------------|---------|-------------|
| `backendUrl` | `http://localhost:7892` | Backend service URL |
| `autoCapture` | `true` | Whether to auto-capture AI interactions |
| `captureReasoning` | `true` | Whether to capture reasoning process |
| `autoBindOnCommit` | `true` | Auto-bind recent unbound sessions on commit |
| `retentionDays` | `90` | Data retention days (0 = permanent) |
| `autoStartBackend` | `true` | Auto-start backend when VS Code launches |
| `debug` | `false` | Enable debug logging |
| `exportLanguage` | `zh` | Export language (`zh` / `en`) |
| `interceptors.cline` | `true` | Whether to capture Cline requests |
| `interceptors.cursor` | `true` | Whether to capture Cursor requests |

---

## Privacy & Security

- **All data stored locally**, default path `~/.agentlog/agentlog.db`
- Backend service only listens on `127.0.0.1`, not exposed to the internet
- CORS policy only allows `localhost` and VS Code Webview origins
- No telemetry collection, no network reporting

---

## Roadmap

### MVP (Current)

- [x] Basic scaffolding (monorepo + type definitions + backend + extension)
- [x] SQLite database + migration system
- [x] REST API (session CRUD + export + commit binding)
- [x] HTTP interceptor (support streaming SSE responses)
- [x] VS Code sidebar TreeView
- [x] Session details Webview + dashboard
- [x] Git post-commit hook injection
- [x] Chinese weekly report / PR explanation export

### Future Plans

- [ ] Webview dashboard UI refinement (React + VS Code UI Toolkit)
- [ ] Deep integration with Cline extension API calls
- [ ] AI-powered auto-tagging for sessions (bugfix / refactor / new feature)
- [ ] Data visualization (AI usage statistics by model / time)
- [ ] Team collaboration support (shared export, code review integration)
- [ ] Local vectorized search (semantic retrieval of historical prompts)

---

## Contributing

```bash
# Clone repository
git clone https://github.com/agentlog/agentlog.git
cd agentlog

# Install dependencies
pnpm install

# Build shared types (other packages depend on this)
pnpm build:shared

# Start backend development service
pnpm dev

# Type checking
pnpm lint
```

---
