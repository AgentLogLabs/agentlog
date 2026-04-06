import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import path from 'path';
import os from 'os';

const dbPath = path.join(os.homedir(), '.agentlog', 'agentlog.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

const now = new Date().toISOString();

function createTrace(taskGoal: string, status: string) {
  const id = ulid();
  db.prepare(`
    INSERT INTO traces (id, task_goal, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, taskGoal, status, now, now);
  return id;
}

function createSpan(traceId: string, parentSpanId: string | null, actorType: string, actorName: string, payload: object) {
  const id = ulid();
  db.prepare(`
    INSERT INTO spans (id, trace_id, parent_span_id, actor_type, actor_name, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, traceId, parentSpanId, actorType, actorName, JSON.stringify(payload), now);
  return id;
}

function createCommitBinding(commitHash: string, traceIds: string[], workspacePath: string) {
  // 检查表结构是否有 trace_ids 列
  const tableInfo = db.prepare("PRAGMA table_info(commit_bindings)").all() as Array<{name: string}>;
  const hasTraceIds = tableInfo.some(col => col.name === 'trace_ids');
  
  if (hasTraceIds) {
    db.prepare(`
      INSERT OR REPLACE INTO commit_bindings (commit_hash, trace_ids, session_ids, message, committed_at, author_name, author_email, changed_files, workspace_path)
      VALUES (?, ?, '[]', ?, ?, ?, ?, '[]', ?)
    `).run(
      commitHash,
      JSON.stringify(traceIds),
      `feat: ${traceIds.length} traces bound`,
      now,
      'Test User',
      'test@example.com',
      workspacePath
    );
  } else {
    console.warn('警告: commit_bindings 表没有 trace_ids 列，跳过创建绑定');
  }
}

console.log('创建 Trace 测试数据...\n');

const trace1Id = createTrace('实现用户登录功能', 'completed');
const span1 = createSpan(trace1Id, null, 'agent', 'coder-agent', { action: 'read_file', path: 'src/auth/login.ts' });
const span2 = createSpan(trace1Id, span1, 'system', 'linter', { action: 'lint', errors: 0 });
const span3 = createSpan(trace1Id, span1, 'agent', 'coder-agent', { action: 'write_file', path: 'src/auth/login.ts' });
console.log(`Trace 1: ${trace1Id} - 实现用户登录功能 (completed)`);

const trace2Id = createTrace('修复购物车结算bug', 'failed');
const span4 = createSpan(trace2Id, null, 'agent', 'debug-agent', { action: 'search', query: 'cart checkout error' });
const span5 = createSpan(trace2Id, span4, 'system', 'error-analyzer', { error: 'TypeError: Cannot read property subtotal' });
const span6 = createSpan(trace2Id, span4, 'agent', 'debug-agent', { action: 'read_file', path: 'src/cart/checkout.ts' });
console.log(`Trace 2: ${trace2Id} - 修复购物车结算bug (failed)`);

const trace3Id = createTrace('重构数据库访问层', 'running');
const span7 = createSpan(trace3Id, null, 'agent', 'refactor-agent', { action: 'analyze', target: 'database layer' });
const span8 = createSpan(trace3Id, span7, 'agent', 'refactor-agent', { action: 'read_file', path: 'src/db/models.ts' });
const span9 = createSpan(trace3Id, span7, 'system', 'code-analysis', { complexity: 'high', lines: 1500 });
const span10 = createSpan(trace3Id, null, 'human', 'developer', { action: 'review', comment: '需要优化查询性能' });
console.log(`Trace 3: ${trace3Id} - 重构数据库访问层 (running)`);

const trace4Id = createTrace('添加单元测试覆盖率', 'completed');
const span11 = createSpan(trace4Id, null, 'agent', 'test-agent', { action: 'coverage_report', current: '45%', target: '80%' });
const span12 = createSpan(trace4Id, span11, 'agent', 'test-agent', { action: 'write_tests', files: ['auth.test.ts', 'cart.test.ts'] });
console.log(`Trace 4: ${trace4Id} - 添加单元测试覆盖率 (completed)`);

const trace5Id = createTrace('优化首页加载性能', 'paused');
const span13 = createSpan(trace5Id, null, 'agent', 'perf-agent', { action: 'measure', metric: 'LCP', value: '4.2s' });
const span14 = createSpan(trace5Id, span13, 'system', 'insights', { suggestion: 'lazy load images below fold' });
console.log(`Trace 5: ${trace5Id} - 优化首页加载性能 (paused)`);

// 创建 Commit Binding（使用 AgentLogTest 项目路径）
const agentLogTestPath = path.join(os.homedir(), 'Projects', 'AgentLogTest');
createCommitBinding('a1b2c3d4', [trace1Id, trace2Id], agentLogTestPath);
createCommitBinding('e5f6g7h8', [trace3Id], agentLogTestPath);
console.log(`\nCommit 绑定: a1b2c3d4 -> [${trace1Id}, ${trace2Id}]`);
console.log(`Commit 绑定: e5f6g7h8 -> [${trace3Id}]`);

console.log('\n✅ 测试数据创建完成！共 5 条 traces');
console.log(`数据库路径: ${dbPath}`);

db.close();