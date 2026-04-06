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