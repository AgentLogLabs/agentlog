#!/usr/bin/env node
/**
 * query_and_fill.mjs — AgentLog Daily Report query_and_fill
 *
 * Queries AgentLog sessions for a given date range and fills daily report template placeholders.
 *
 * Usage:
 *   node query_and_fill.mjs [options]
 *
 * Options:
 *   --workspace-path <path>    Workspace path to filter sessions
 *   --start-date <YYYY-MM-DD>  Start date (required)
 *   --end-date <YYYY-MM-DD>    End date (required)
 *   --source <source>          Agent source filter (e.g., opencode, cursor)
 *   --template <file>          Template file path (default: stdin)
 *   --output <file>            Output file path (default: stdout)
 *   --dry-run                  Only output parsed results, don't generate file
 *   --help                     Show this help message
 *
 * Environment:
 *   AGENTLOG_BACKEND_URL      Backend URL (default: http://localhost:7892)
 *
 * Template placeholders:
 *   {{TASK_TYPE}}       Auto-determined (📋任务/🔧文档更新/✅Code Review/🚀Git操作等)
 *   {{TASK_STATUS}}      > 5min = ✅完成, otherwise 🔄进行中
 *   {{TASK_SUMMARY}}     Extracted from transcript/response
 *   {{AFFECTED_FILES}}   From affectedFiles field
 *   {{others}}           Stay unchanged
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { readFileSync } from 'fs';

const DEFAULT_PORT = 7892;
const DEFAULT_BACKEND_URL = `http://localhost:${DEFAULT_PORT}`;

function parseArgs(argv) {
  const args = {
    workspacePath: undefined,
    startDate: undefined,
    endDate: undefined,
    source: undefined,
    template: undefined,
    output: undefined,
    dryRun: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--workspace-path' && i + 1 < argv.length) {
      args.workspacePath = argv[++i];
    } else if (arg === '--start-date' && i + 1 < argv.length) {
      args.startDate = argv[++i];
    } else if (arg === '--end-date' && i + 1 < argv.length) {
      args.endDate = argv[++i];
    } else if (arg === '--source' && i + 1 < argv.length) {
      args.source = argv[++i];
    } else if (arg === '--template' && i + 1 < argv.length) {
      args.template = argv[++i];
    } else if (arg === '--output' && i + 1 < argv.length) {
      args.output = argv[++i];
    }
  }

  return args;
}

function showHelp() {
  console.log(`
query_and_fill.mjs — AgentLog Daily Report query_and_fill

Queries AgentLog sessions and fills daily report template placeholders.

Usage:
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

Environment:
  AGENTLOG_BACKEND_URL      Backend URL (default: http://localhost:7892)

Template placeholders:
  {{TASK_TYPE}}       Auto-determined (📋任务/🔧文档更新/✅Code Review/🚀Git操作等)
  {{TASK_STATUS}}      > 5min = ✅完成, otherwise 🔄进行中
  {{TASK_SUMMARY}}     Extracted from transcript/response
  {{AFFECTED_FILES}}   From affectedFiles field
  {{others}}           Stay unchanged
`);
}

function getBackendUrl() {
  return process.env.AGENTLOG_BACKEND_URL || DEFAULT_BACKEND_URL;
}

function httpRequest(url, options = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeout}ms`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function querySessions(params) {
  const backendUrl = getBackendUrl();
  const query = new URLSearchParams();

  if (params.workspacePath) query.set('workspacePath', params.workspacePath);
  if (params.startDate) query.set('startDate', params.startDate);
  if (params.endDate) query.set('endDate', params.endDate);
  if (params.source) query.set('source', params.source);
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));

  const url = `${backendUrl}/api/sessions?${query.toString()}`;

  try {
    const response = await httpRequest(url);
    if (response.status !== 200) {
      throw new Error(`API returned status ${response.status}: ${JSON.stringify(response.data)}`);
    }
    return response.data;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      throw new Error(`Cannot connect to AgentLog backend at ${backendUrl}. Is the server running?`);
    }
    throw error;
  }
}

function getStartOfDay(dateStr) {
  return `${dateStr}T00:00:00.000Z`;
}

function getEndOfDay(dateStr) {
  return `${dateStr}T23:59:59.999Z`;
}

function detectTaskType(session) {
  const prompt = (session.prompt || '').toLowerCase();
  const response = (session.response || '').toLowerCase();
  const transcriptText = (session.transcript || [])
    .map(t => t.content || '')
    .join(' ')
    .toLowerCase();

  const combined = `${prompt} ${response} ${transcriptText}`;

  if (/\b(git\s+(commit|push|pull|merge|rebase|checkout|branch|clone|fetch))\b/.test(combined) ||
      /\b(commit\s+-m|git\s+add|git\s+status|git\s+diff)\b/.test(combined)) {
    return '🚀Git操作';
  }

  if (/\b(code\s*review|pr\s*review|review\s+pull\s*request|CR\b)/.test(combined) ||
      /\b(approve|comment\s+on\s+pr|review\s+changes?)\b/.test(combined)) {
    return '✅Code Review';
  }

  if (/\b(read|write|edit|update|create|delete|modify|add|remove)\b/.test(combined) &&
      /\b(doc|md|markdown|readme|changelog|docs?|document|spec|specification)\b/.test(combined)) {
    return '🔧文档更新';
  }

  if (/\b(analyze|explain|describe|understand|what\s+does|how\s+does)\b/.test(combined)) {
    return '📋任务';
  }

  if (/\b(implement|feature|fix|bug|refactor|optimize|test|build|deploy)\b/.test(combined)) {
    return '📋任务';
  }

  return '📋任务';
}

function detectTaskStatus(durationMs) {
  const minutes = durationMs / 60000;
  if (minutes > 5) {
    return '✅完成';
  }
  return '🔄进行中';
}

function extractTaskSummary(session) {
  if (session.response && session.response.length > 0) {
    const summary = session.response
      .slice(0, 500)
      .replace(/\n+/g, ' ')
      .trim();
    return summary.length < session.response.length ? `${summary}...` : summary;
  }

  if (session.transcript && session.transcript.length > 0) {
    const lastAssistant = [...session.transcript]
      .reverse()
      .find(t => t.role === 'assistant');
    if (lastAssistant && lastAssistant.content) {
      const content = lastAssistant.content
        .slice(0, 500)
        .replace(/\n+/g, ' ')
        .trim();
      return content.length < lastAssistant.content.length ? `${content}...` : content;
    }
  }

  if (session.prompt) {
    return session.prompt
      .slice(0, 300)
      .replace(/\n+/g, ' ')
      .trim();
  }

  return '任务详情见会话记录';
}

function classifySessions(sessions) {
  const taskTypes = {
    '📋任务': [],
    '🔧文档更新': [],
    '✅Code Review': [],
    '🚀Git操作': [],
  };

  for (const session of sessions) {
    const type = detectTaskType(session);
    taskTypes[type].push(session);
  }

  return taskTypes;
}

function fillTemplate(template, { sessions, taskTypes, startDate, endDate }) {
  const allAffectedFiles = new Set();
  for (const session of sessions) {
    for (const file of session.affectedFiles || []) {
      allAffectedFiles.add(file);
    }
  }

  const taskTypeEmojis = [];
  for (const [type, typeSessions] of Object.entries(taskTypes)) {
    if (typeSessions.length > 0) {
      taskTypeEmojis.push(`${type} ×${typeSessions.length}`);
    }
  }

  const filled = template
    .replace(/\{\{TASK_TYPE\}\}/g, taskTypeEmojis.join(' ') || '📋任务')
    .replace(/\{\{TASK_STATUS\}\}/g, detectTaskStatus(
      sessions.reduce((sum, s) => sum + (s.durationMs || 0), 0)
    ))
    .replace(/\{\{TASK_SUMMARY\}\}/g, sessions.length > 0
      ? extractTaskSummary(sessions[0])
      : '无会话记录')
    .replace(/\{\{AFFECTED_FILES\}\}/g,
      allAffectedFiles.size > 0
        ? Array.from(allAffectedFiles).slice(0, 20).join('\n- ')
        : '无变更文件')
    .replace(/\{\{DATE_RANGE\}\}/g, `${startDate} ~ ${endDate}`)
    .replace(/\{\{SESSION_COUNT\}\}/g, String(sessions.length));

  return filled;
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    showHelp();
    return;
  }

  if (!args.startDate || !args.endDate) {
    console.error('Error: --start-date and --end-date are required');
    console.error('Use --help for usage information');
    process.exit(1);
  }

  const startDateISO = getStartOfDay(args.startDate);
  const endDateISO = getEndOfDay(args.endDate);

  console.error(`[query_and_fill] Querying sessions from ${args.startDate} to ${args.endDate}...`);

  let sessions;
  try {
    const response = await querySessions({
      workspacePath: args.workspacePath,
      startDate: startDateISO,
      endDate: endDateISO,
      source: args.source,
      page: 1,
      pageSize: 100,
    });

    sessions = response.data?.data || [];
    console.error(`[query_and_fill] Found ${sessions.length} sessions`);
  } catch (error) {
    console.error(`[query_and_fill] Failed to query sessions: ${error.message}`);
    process.exit(1);
  }

  const taskTypes = classifySessions(sessions);

  if (args.dryRun) {
    console.log('=== Dry Run Results ===\n');
    console.log(`Sessions: ${sessions.length}`);
    console.log('\nTask Types:');
    for (const [type, typeSessions] of Object.entries(taskTypes)) {
      if (typeSessions.length > 0) {
        console.log(`  ${type}: ${typeSessions.length}`);
      }
    }

    console.log('\nSession Details:');
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      console.log(`\n[${i + 1}] ${detectTaskType(s)} | ${detectTaskStatus(s.durationMs)} | ${s.durationMs}ms`);
      console.log(`    Prompt: ${(s.prompt || 'N/A').slice(0, 100)}...`);
      console.log(`    Files: ${(s.affectedFiles || []).slice(0, 5).join(', ')}${(s.affectedFiles || []).length > 5 ? '...' : ''}`);
    }
    return;
  }

  let template;
  if (args.template) {
    try {
      template = readFileSync(args.template, 'utf-8');
    } catch (error) {
      console.error(`[query_and_fill] Failed to read template file: ${error.message}`);
      process.exit(1);
    }
  } else {
    template = await new Promise((resolve) => {
      let data = '';
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { resolve(data); });
    });
  }

  if (!template || template.trim() === '') {
    template = `# Daily Report — {{DATE_RANGE}}

## Summary
- **Sessions**: {{SESSION_COUNT}}
- **Task Types**: {{TASK_TYPE}}
- **Status**: {{TASK_STATUS}}

## Affected Files
{{AFFECTED_FILES}}

## Task Summary
{{TASK_SUMMARY}}
`;
  }

  const filled = fillTemplate(template, { sessions, taskTypes, startDate: args.startDate, endDate: args.endDate });

  if (args.output) {
    const { writeFileSync } = await import('fs');
    writeFileSync(args.output, filled, 'utf-8');
    console.error(`[query_and_fill] Report written to ${args.output}`);
  } else {
    console.log(filled);
  }
}

main(process.argv).catch((error) => {
  console.error(`[query_and_fill] Fatal error: ${error.message}`);
  process.exit(1);
});
