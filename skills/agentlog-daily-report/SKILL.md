---
name: agentlog-daily-report
description: |
  AgentLog Daily Report Skill for OpenClaw agents. Allows agents to submit, query, and generate daily work reports.
  
  When to activate:
  - Any OpenClaw agent that needs to track daily work progress
  - When generating periodic work summaries
  - For tracking tasks completed, planned, and blockers
  
  Features:
  - Submit daily work reports (submit-daily-report)
  - Query historical daily reports (query-daily-reports)
  - Generate daily report from sessions data (generate-daily-report)
---

# AgentLog Daily Report Skill

## Overview

This skill provides daily report functionality for OpenClaw agents. It stores daily reports as special sessions in AgentLog with source='daily-report'.

## Configuration

### Required Environment Variables

```bash
AGENTLOG_MCP_URL=http://localhost:7892  # AgentLog MCP Server URL
```

### Optional Configuration

```yaml
agentlog-daily-report:
  mcpUrl: "http://localhost:7892"
  defaultAgentId: "opencode"  # Default agent identifier
```

## Commands

### query-and-fill

Generate a daily report by querying AgentLog sessions and filling a template.

**Standalone Script:** `query_and_fill.mjs` (ES Module, no external dependencies)

**Parameters:**
```bash
node query_and_fill.mjs [options]

Options:
  --workspace-path <path>    Workspace path to filter sessions
  --start-date <YYYY-MM-DD>  Start date (required)
  --end-date <YYYY-MM-DD>    End date (required)
  --source <source>          Agent source filter (e.g., opencode, cursor)
  --template <file>          Template file path (default: stdin)
  --output <file>            Output file path (default: stdout)
  --dry-run                  Only output parsed results, don't generate file
  --help                     Show this help message
```

**Environment Variables:**
```bash
AGENTLOG_BACKEND_URL=http://localhost:7892  # Backend URL (optional)
```

**Template Placeholders:**
| Placeholder | Description | Fill Logic |
|-------------|-------------|------------|
| `{{TASK_TYPE}}` | Task type with emoji | Auto-detected: 📋任务 / 🔧文档更新 / ✅Code Review / 🚀Git操作 |
| `{{TASK_STATUS}}` | Task completion status | > 5min = ✅完成, otherwise 🔄进行中 |
| `{{TASK_SUMMARY}}` | Task summary | Extracted from transcript/response |
| `{{AFFECTED_FILES}}` | Changed files | From `affectedFiles` field (up to 20) |
| `{{DATE_RANGE}}` | Date range | `startDate ~ endDate` |
| `{{SESSION_COUNT}}` | Number of sessions | Count of queried sessions |
| Other `{{...}}` | Other placeholders | Stay unchanged |

**Task Type Detection:**
- 🚀Git操作: Contains git commit/push/pull/merge/rebase or git commands (git add, git status, git diff)
- ✅Code Review: Contains code review, PR review, approve, or comment on PR keywords
- 🔧文档更新: Contains doc/md/readme/changelog/docs/document in combination with read/write/edit
- 📋任务: Default type for other tasks (implement, feature, fix, bug, analyze, etc.)

**Usage:**
```bash
# Query sessions and output to stdout (uses default template)
node query_and_fill.mjs --start-date 2026-04-06 --end-date 2026-04-06

# With custom template file
node query_and_fill.mjs --start-date 2026-04-06 --end-date 2026-04-06 --template my-template.md

# Dry run to see parsed results
node query_and_fill.mjs --start-date 2026-04-06 --end-date 2026-04-06 --dry-run

# Filter by workspace and source
node query_and_fill.mjs --start-date 2026-04-06 --end-date 2026-04-06 --workspace-path /path/to/project --source opencode

# Output to file
node query_and_fill.mjs --start-date 2026-04-06 --end-date 2026-04-06 --output daily-report.md

# Pipe template from stdin
cat template.md | node query_and_fill.mjs --start-date 2026-04-06 --end-date 2026-04-06
```

**Exit Codes:**
- 0: Success
- 1: Error (missing required params, API error, etc.)

**Errors:**
- Backend not running: `Cannot connect to AgentLog backend at http://localhost:7892. Is the server running?`
- Missing dates: `Error: --start-date and --end-date are required`

### submit-daily-report

Submit a daily work report.

**Parameters:**
```typescript
{
  date: string;              // Report date (YYYY-MM-DD)
  summary: string;            // Overall summary of the day
  tasksCompleted: string[];   // List of completed tasks
  tasksPlanned: string[];     // List of planned tasks for tomorrow
  blockers?: string[];         // Any blockers or issues
  notes?: string;             // Additional notes
  agentId?: string;           // Agent identifier (default: auto-detected)
}
```

**Usage:**
```bash
/agentlog-daily-report submit \
  --date "2026-04-06" \
  --summary "Completed feature X, started feature Y" \
  --tasks-completed "Implemented login" \
  --tasks-planned "Write tests" \
  --blockers "None"
```

### query-daily-reports

Query historical daily reports with filters.

**Parameters:**
```typescript
{
  startDate?: string;   // Start date (YYYY-MM-DD)
  endDate?: string;     // End date (YYYY-MM-DD)
  agentId?: string;    // Filter by agent ID
  limit?: number;      // Max results (default: 20)
  page?: number;       // Page number (default: 1)
}
```

**Usage:**
```bash
/agentlog-daily-report query \
  --start-date "2026-04-01" \
  --end-date "2026-04-06"

/agentlog-daily-report query --agent-id opencode
```

### generate-daily-report

Generate a daily report based on sessions data from the current day.

**Parameters:**
```typescript
{
  date?: string;        // Target date (YYYY-MM-DD), defaults to today
  agentId?: string;     // Filter by agent ID
  format?: "markdown";  // Output format (default: markdown)
}
```

**Output:**
Returns a formatted Markdown report containing:
- Date and agent info
- Summary of sessions
- Tasks completed (inferred from session activity)
- Files modified
- Token usage statistics

**Usage:**
```bash
/agentlog-daily-report generate

/agentlog-daily-report generate --date "2026-04-06" --format markdown
```

## Data Model

Daily reports are stored as special sessions with:
- `source`: 'daily-report'
- `metadata`: Contains the report data (date, summary, tasksCompleted, tasksPlanned, blockers, notes)

## Examples

### Submit a Report
```typescript
await skill.commands.submitDailyReport({
  date: "2026-04-06",
  summary: "Implemented user authentication feature",
  tasksCompleted: [
    "Added login endpoint",
    "Implemented JWT token generation",
    "Added password hashing"
  ],
  tasksPlanned: [
    "Write unit tests",
    "Add logout endpoint"
  ],
  blockers: [],
  notes: "Need to review PR tomorrow"
});
```

### Query Reports
```typescript
const reports = await skill.commands.queryDailyReports({
  startDate: "2026-04-01",
  endDate: "2026-04-06",
  limit: 10
});
```

### Generate Report
```typescript
const report = await skill.commands.generateDailyReport({
  date: "2026-04-06",
  format: "markdown"
});
console.log(report);
```

## Requirements

- OpenClaw Gateway running
- AgentLog MCP Server running on configured port
- Network access to MCP server (localhost by default)

## Troubleshooting

**MCP Server not reachable:**
- Check if `agentlog-mcp` is running: `curl http://localhost:7892/health`
- Verify AGENTLOG_MCP_URL is correct

**Reports not found:**
- Ensure dates are in YYYY-MM-DD format
- Check if sessions exist for the specified date range