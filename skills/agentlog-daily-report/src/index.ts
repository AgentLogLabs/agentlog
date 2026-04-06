/**
 * AgentLog Daily Report Skill
 *
 * Provides daily report functionality: submit, query, and generate daily reports.
 */

import { randomUUID } from 'crypto';

interface DailyReportData {
  date: string;
  summary: string;
  tasksCompleted: string[];
  tasksPlanned: string[];
  blockers: string[];
  notes?: string;
  agentId: string;
}

interface DailyReport extends DailyReportData {
  id: string;
  createdAt: string;
}

interface SubmitDailyReportParams {
  date: string;
  summary: string;
  tasksCompleted: string[];
  tasksPlanned: string[];
  blockers?: string[];
  notes?: string;
  agentId?: string;
}

interface QueryDailyReportsParams {
  startDate?: string;
  endDate?: string;
  agentId?: string;
  limit?: number;
  page?: number;
}

interface GenerateDailyReportParams {
  date?: string;
  agentId?: string;
  format?: 'markdown';
}

interface DailyReportQueryResult {
  data: DailyReport[];
  total: number;
  page: number;
  pageSize: number;
}

interface AgentSession {
  id: string;
  createdAt: string;
  provider: string;
  model: string;
  source: string;
  workspacePath: string;
  prompt: string;
  response: string;
  durationMs: number;
  affectedFiles: string[];
  tags?: string[];
  note?: string;
  metadata?: Record<string, unknown>;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
}

interface McpResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  sessionId?: string;
}

let config: {
  mcpUrl: string;
  defaultAgentId: string;
} = {
  mcpUrl: process.env.AGENTLOG_MCP_URL || 'http://localhost:7892',
  defaultAgentId: 'opencode',
};

function detectAgentSource(): string {
  const args = process.argv.join(' ');

  if (args.includes('opencode')) return 'opencode';
  if (args.includes('cline')) return 'cline';
  if (args.includes('cursor')) return 'cursor';
  if (args.includes('trae')) return 'trae';
  if (args.includes('claude')) return 'claude-code';
  if (args.includes('copilot')) return 'copilot';
  if (args.includes('continue')) return 'continue';

  return 'openclaw';
}

async function mcpRequest(tool: string, args: Record<string, unknown>): Promise<McpResponse> {
  try {
    const response = await fetch(`${config.mcpUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: {
          name: tool,
          arguments: args,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return { success: true, data, sessionId: data.sessionId };
  } catch (error) {
    console.error('[agentlog-daily-report] MCP request failed:', error);
    return { success: false, error: String(error) };
  }
}

async function mcpRequestRaw(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${config.mcpUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: {
        name: tool,
        arguments: args,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

function getStartOfDay(dateStr: string): string {
  return `${dateStr}T00:00:00.000Z`;
}

function getEndOfDay(dateStr: string): string {
  return `${dateStr}T23:59:59.999Z`;
}

function parseSessionsResponse(response: unknown): AgentSession[] {
  if (!response || typeof response !== 'object') return [];

  const resp = response as Record<string, unknown>;

  if (resp.result && typeof resp.result === 'object' && !Array.isArray(resp.result)) {
    const result = resp.result as Record<string, unknown>;
    if (Array.isArray(result.data)) {
      return result.data as AgentSession[];
    }
  }

  if (Array.isArray(response)) {
    return response as AgentSession[];
  }

  return [];
}

async function submitDailyReport(params: SubmitDailyReportParams): Promise<{ success: boolean; reportId?: string; error?: string }> {
  const agentId = params.agentId || detectAgentSource();
  const sessionId = `dr_${Date.now()}_${randomUUID().slice(0, 8)}`;

  const reportData: DailyReportData = {
    date: params.date,
    summary: params.summary,
    tasksCompleted: params.tasksCompleted,
    tasksPlanned: params.tasksPlanned,
    blockers: params.blockers || [],
    notes: params.notes,
    agentId,
  };

  const prompt = `Daily Report for ${params.date}\nSummary: ${params.summary}\nTasks Completed: ${params.tasksCompleted.join(', ')}\nTasks Planned: ${params.tasksPlanned.join(', ')}\nBlockers: ${(params.blockers || []).join(', ')}`;
  const response = `Daily Report Submitted\nAgent: ${agentId}\nDate: ${params.date}`;

  try {
    const result = await mcpRequest('create_session', {
      session_id: sessionId,
      provider: 'unknown',
      model: 'daily-report',
      source: 'daily-report',
      workspace_path: process.cwd(),
      prompt,
      response,
      duration_ms: 0,
      affected_files: [],
      tags: ['daily-report', params.date],
      note: JSON.stringify(reportData),
      metadata: {
        dailyReport: reportData,
        reportType: 'daily-report',
      },
    });

    if (result.success) {
      return { success: true, reportId: sessionId };
    } else {
      return { success: false, error: result.error };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function queryDailyReports(params: QueryDailyReportsParams): Promise<DailyReportQueryResult> {
  const page = params.page || 1;
  const pageSize = Math.min(params.limit || 20, 100);

  const queryParams: Record<string, unknown> = {
    source: 'daily-report',
    page,
    page_size: pageSize,
  };

  if (params.startDate) {
    queryParams.start_date = getStartOfDay(params.startDate);
  }

  if (params.endDate) {
    queryParams.end_date = getEndOfDay(params.endDate);
  }

  if (params.agentId) {
    queryParams.keyword = params.agentId;
  }

  try {
    const response = await mcpRequestRaw('query_sessions', queryParams);
    const sessions = parseSessionsResponse(response);

    const reports: DailyReport[] = sessions.map((session) => {
      let reportData: DailyReportData | null = null;

      if (session.metadata?.dailyReport) {
        reportData = session.metadata.dailyReport as DailyReportData;
      } else if (session.note) {
        try {
          reportData = JSON.parse(session.note) as DailyReportData;
        } catch {
          reportData = null;
        }
      }

      return {
        id: session.id,
        createdAt: session.createdAt,
        date: reportData?.date || session.createdAt.split('T')[0],
        summary: reportData?.summary || session.prompt,
        tasksCompleted: reportData?.tasksCompleted || [],
        tasksPlanned: reportData?.tasksPlanned || [],
        blockers: reportData?.blockers || [],
        notes: reportData?.notes,
        agentId: reportData?.agentId || 'unknown',
      };
    });

    return {
      data: reports,
      total: reports.length,
      page,
      pageSize,
    };
  } catch (error) {
    console.error('[agentlog-daily-report] Query failed:', error);
    return {
      data: [],
      total: 0,
      page,
      pageSize,
    };
  }
}

async function generateDailyReport(params: GenerateDailyReportParams): Promise<string> {
  const targetDate = params.date || getTodayDate();
  const agentId = params.agentId;

  const queryParams: Record<string, unknown> = {
    start_date: getStartOfDay(targetDate),
    end_date: getEndOfDay(targetDate),
    page: 1,
    page_size: 100,
  };

  if (agentId) {
    queryParams.workspace_path = agentId;
  }

  let sessions: AgentSession[] = [];
  try {
    const response = await mcpRequestRaw('query_sessions', queryParams);
    sessions = parseSessionsResponse(response);
    sessions = sessions.filter((s) => s.source !== 'daily-report');
  } catch (error) {
    console.error('[agentlog-daily-report] Failed to fetch sessions:', error);
  }

  const totalDuration = sessions.reduce((sum, s) => sum + s.durationMs, 0);
  const totalInputTokens = sessions.reduce((sum, s) => sum + (s.tokenUsage?.inputTokens || 0), 0);
  const totalOutputTokens = sessions.reduce((sum, s) => sum + (s.tokenUsage?.outputTokens || 0), 0);

  const allFiles = new Set<string>();
  sessions.forEach((s) => {
    (s.affectedFiles || []).forEach((f) => allFiles.add(f));
  });

  const markdown = generateMarkdownReport(targetDate, {
    sessionCount: sessions.length,
    totalDuration,
    totalInputTokens,
    totalOutputTokens,
    affectedFiles: Array.from(allFiles),
    sessions,
  });

  return markdown;
}

interface ReportSummary {
  sessionCount: number;
  totalDuration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  affectedFiles: string[];
  sessions: AgentSession[];
}

function generateMarkdownReport(date: string, summary: ReportSummary): string {
  const lines: string[] = [];

  lines.push(`# Daily Report - ${date}`);
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Total Sessions:** ${summary.sessionCount}`);
  lines.push(`- **Total Duration:** ${Math.round(summary.totalDuration / 1000)}s`);
  lines.push(`- **Input Tokens:** ${summary.totalInputTokens.toLocaleString()}`);
  lines.push(`- **Output Tokens:** ${summary.totalOutputTokens.toLocaleString()}`);
  lines.push(`- **Files Modified:** ${summary.affectedFiles.length}`);
  lines.push('');

  if (summary.affectedFiles.length > 0) {
    lines.push('## Files Modified');
    lines.push('');
    summary.affectedFiles.forEach((file) => {
      lines.push(`- \`${file}\``);
    });
    lines.push('');
  }

  if (summary.sessions.length > 0) {
    lines.push('## Sessions');
    lines.push('');
    summary.sessions.forEach((session, index) => {
      lines.push(`### ${index + 1}. ${session.model || 'Unknown Model'} (${session.provider || 'unknown'})`);
      lines.push('');
      lines.push(`- **Time:** ${new Date(session.createdAt).toLocaleTimeString()}`);
      lines.push(`- **Duration:** ${Math.round(session.durationMs / 1000)}s`);
      lines.push(`- **Source:** ${session.source}`);
      if (session.affectedFiles && session.affectedFiles.length > 0) {
        lines.push(`- **Files:** ${session.affectedFiles.join(', ')}`);
      }
      lines.push('');
      lines.push(`**Prompt:** ${session.prompt.slice(0, 200)}${session.prompt.length > 200 ? '...' : ''}`);
      lines.push('');
      lines.push(`**Response:** ${session.response.slice(0, 200)}${session.response.length > 200 ? '...' : ''}`);
      lines.push('');
    });
  }

  return lines.join('\n');
}

async function checkHealth(): Promise<string> {
  try {
    const response = await fetch(`${config.mcpUrl}/health`, {
      method: 'GET',
    });
    if (response.ok) {
      return 'AgentLog MCP: Connected';
    }
    return `AgentLog MCP: HTTP ${response.status}`;
  } catch (error) {
    return `AgentLog MCP: Error - ${String(error)}`;
  }
}

export const commands = {
  submitDailyReport,
  queryDailyReports,
  generateDailyReport,
  checkHealth,
};

export const skill = {
  name: 'agentlog-daily-report',
  version: '1.0.0',
  commands: [
    {
      name: 'submit-daily-report',
      description: 'Submit a daily work report',
      handler: async (params: SubmitDailyReportParams) => {
        const result = await submitDailyReport(params);
        if (result.success) {
          return `Daily report submitted successfully. Report ID: ${result.reportId}`;
        }
        return `Failed to submit daily report: ${result.error}`;
      },
    },
    {
      name: 'query-daily-reports',
      description: 'Query historical daily reports',
      handler: async (params: QueryDailyReportsParams) => {
        const result = await queryDailyReports(params);
        if (result.data.length === 0) {
          return 'No daily reports found for the specified criteria.';
        }
        const lines: string[] = [`Found ${result.total} daily reports:`];
        result.data.forEach((report) => {
          lines.push(`- [${report.date}] ${report.summary.slice(0, 50)}... (${report.agentId})`);
        });
        return lines.join('\n');
      },
    },
    {
      name: 'generate-daily-report',
      description: 'Generate a daily report from sessions data',
      handler: async (params: GenerateDailyReportParams) => {
        const report = await generateDailyReport(params);
        return report;
      },
    },
    {
      name: 'agentlog-daily-report-status',
      description: 'Check AgentLog MCP connection status',
      handler: async () => {
        return await checkHealth();
      },
    },
  ],
};

export default skill;