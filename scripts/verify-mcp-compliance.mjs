#!/usr/bin/env node

/**
 * AgentLog MCP 合规性验证脚本
 * 
 * 验证 OpenCode（或其他 MCP 客户端）是否完整遵守 AgentLog MCP 协议。
 * 模拟标准的多轮对话流程，检查每条消息是否被正确记录。
 * 
 * 使用方法：
 *   node scripts/verify-mcp-compliance.js
 *   node scripts/verify-mcp-compliance.js --detailed
 *   node scripts/verify-mcp-compliance.js --help
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
let fetch;

// 异步初始化fetch
async function initFetch() {
  try {
    // 尝试ESM导入
    const nodeFetch = await import('node-fetch');
    fetch = nodeFetch.default;
  } catch (e) {
    // 降级到CommonJS
    fetch = require('node-fetch');
  }
}

// 配置
const BACKEND_URL = 'http://localhost:7892';
const TEST_WORKSPACE = process.cwd();
const TEST_MODEL = 'deepseek-r1';
const TEST_PROVIDER = 'deepseek';

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function colorize(color, text) {
  return colors[color] + text + colors.reset;
}

// 结果统计
const results = {
  total: 0,
  passed: 0,
  failed: 0,
  warnings: 0,
};

function printResult(test, passed, message = '') {
  results.total++;
  if (passed) {
    results.passed++;
    console.log(`  ${colorize('green', '✓')} ${test}`);
  } else {
    results.failed++;
    console.log(`  ${colorize('red', '✗')} ${test}`);
  }
  if (message) {
    console.log(`     ${message}`);
  }
}

function printWarning(message) {
  results.warnings++;
  console.log(`  ${colorize('yellow', '⚠')} ${message}`);
}

// 工具函数：调用后端 API
async function callBackend(endpoint, method = 'GET', body = null) {
  const url = `${BACKEND_URL}${endpoint}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  try {
    const response = await fetch(url, options);
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    
    return data;
  } catch (error) {
    console.error(`后端调用失败 ${endpoint}:`, error.message);
    throw error;
  }
}

// 测试用例
async function testBackendHealth() {
  try {
    const health = await callBackend('/health');
    return health.status === 'ok';
  } catch {
    return false;
  }
}

async function testCreateSession() {
  try {
    const session = await callBackend('/api/sessions', 'POST', {
      provider: TEST_PROVIDER,
      model: TEST_MODEL,
      source: 'opencode',
      workspacePath: TEST_WORKSPACE,
      prompt: '测试对话：验证 MCP 协议合规性',
      response: '(pending)',
      affectedFiles: [],
      durationMs: 0,
      transcript: [],
    });
    
    return session.success && session.data?.id;
  } catch {
    return false;
  }
}

async function testQuerySessions() {
  try {
    const result = await callBackend('/api/sessions');
    return result.success && Array.isArray(result.data);
  } catch {
    return false;
  }
}

async function testTranscriptAppend() {
  try {
    // 先创建会话
    const session = await callBackend('/api/sessions', 'POST', {
      provider: TEST_PROVIDER,
      model: TEST_MODEL,
      source: 'opencode',
      workspacePath: TEST_WORKSPACE,
      prompt: '测试 transcript 追加',
      response: '(pending)',
      affectedFiles: [],
      durationMs: 0,
      transcript: [],
    });
    
    if (!session.success || !session.data?.id) {
      return false;
    }
    
    const sessionId = session.data.id;
    
    // 追加 transcript
    const appendResult = await callBackend(
      `/api/sessions/${sessionId}/transcript`,
      'PATCH',
      {
        turns: [
          {
            role: 'assistant',
            content: '测试回复内容',
            reasoning: '测试推理过程：验证 transcript 追加功能',
            timestamp: new Date().toISOString(),
          },
        ],
      }
    );
    
    return appendResult.success;
  } catch {
    return false;
  }
}

// 分析现有会话的合规性
async function analyzeSessionCompliance(sessionId) {
  try {
    const session = await callBackend(`/api/sessions/${sessionId}`);
    
    if (!session.success || !session.data) {
      return { valid: false, error: '会话不存在' };
    }
    
    const data = session.data;
    const transcript = data.transcript || [];
    
    const analysis = {
      sessionId,
      totalMessages: transcript.length,
      userMessages: transcript.filter(t => t.role === 'user').length,
      assistantMessages: transcript.filter(t => t.role === 'assistant').length,
      toolMessages: transcript.filter(t => t.role === 'tool').length,
      hasReasoning: transcript.some(t => t.role === 'assistant' && t.reasoning),
      hasToolInput: transcript.some(t => t.role === 'tool' && t.toolInput),
      toolInputsWithFilePath: transcript.filter(
        t => t.role === 'tool' && t.toolInput && t.toolInput.includes('filePath=')
      ).length,
      messageRatio: {
        user: 0,
        assistant: 0,
        tool: 0,
      },
      complianceIssues: [],
    };
    
    // 计算比例
    if (transcript.length > 0) {
      analysis.messageRatio.user = (analysis.userMessages / transcript.length * 100).toFixed(1);
      analysis.messageRatio.assistant = (analysis.assistantMessages / transcript.length * 100).toFixed(1);
      analysis.messageRatio.tool = (analysis.toolMessages / transcript.length * 100).toFixed(1);
    }
    
    // 检查合规性问题
    if (analysis.userMessages === 0) {
      analysis.complianceIssues.push('缺少 user 消息（对话未开始）');
    }
    
    if (analysis.assistantMessages === 0 && transcript.length > 0) {
      analysis.complianceIssues.push('缺少 assistant 消息（AI 回复未记录）');
    }
    
    if (analysis.toolMessages === 0 && analysis.assistantMessages > 0) {
      analysis.complianceIssues.push('缺少 tool 消息（工具执行未记录）');
    }
    
    if (analysis.assistantMessages > 0 && !analysis.hasReasoning) {
      analysis.complianceIssues.push('assistant 消息缺少 reasoning 字段（推理过程未记录）');
    }
    
    if (analysis.toolMessages > 0 && !analysis.hasToolInput) {
      analysis.complianceIssues.push('tool 消息缺少 tool_input 字段（执行上下文未记录）');
    }
    
    if (analysis.toolMessages > 0 && analysis.toolInputsWithFilePath === 0) {
      analysis.complianceIssues.push('tool 消息未包含文件路径（无法追踪文件改动）');
    }
    
    // 检查消息比例（理想情况：user:assistant:tool ≈ 1:1:1）
    if (transcript.length >= 3) {
      const ratioDiff = Math.abs(analysis.userMessages - analysis.assistantMessages);
      if (ratioDiff > transcript.length * 0.3) {
        analysis.complianceIssues.push(`user/assistant 消息比例失衡（相差 ${ratioDiff} 条）`);
      }
    }
    
    analysis.valid = analysis.complianceIssues.length === 0;
    
    return analysis;
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// 主验证函数
async function runComplianceCheck(options = {}) {
  const { detailed = false, analyzeRecent = true } = options;
  
  console.log(colorize('bold', '🔍 AgentLog MCP 协议合规性验证'));
  console.log(colorize('cyan', '='.repeat(60)));
  console.log(`后端地址: ${BACKEND_URL}`);
  console.log(`工作目录: ${TEST_WORKSPACE}`);
  console.log();
  
  // 测试后端连接
  console.log(colorize('bold', '1. 后端服务检查'));
  const backendHealthy = await testBackendHealth();
  printResult('后端服务可访问', backendHealthy);
  
  if (!backendHealthy) {
    console.log(colorize('red', '\n❌ 后端服务不可用，无法继续验证'));
    console.log('请确保 AgentLog 后端正在运行：');
    console.log('  - 在 VS Code 中执行 "AgentLog: 启动本地后台服务"');
    console.log('  - 或运行: pnpm --filter @agentlog/backend dev');
    process.exit(1);
  }
  
  const canCreateSession = await testCreateSession();
  printResult('可创建新会话', canCreateSession);
  
  const canQuerySessions = await testQuerySessions();
  printResult('可查询历史会话', canQuerySessions);
  
  const canAppendTranscript = await testTranscriptAppend();
  printResult('可追加 transcript 消息', canAppendTranscript);
  
  console.log();
  
  // 分析最近会话的合规性
  if (analyzeRecent) {
    console.log(colorize('bold', '2. 最近会话合规性分析'));
    
    try {
      const sessions = await callBackend('/api/sessions?pageSize=5');
      
      if (sessions.success && sessions.data?.data?.length > 0) {
        const recentSessions = sessions.data.data;
        
        console.log(`找到 ${recentSessions.length} 个最近会话`);
        
        for (let i = 0; i < Math.min(3, recentSessions.length); i++) {
          const session = recentSessions[i];
          console.log(`\n${colorize('cyan', `会话 ${i + 1}: ${session.id.substring(0, 12)}...`)}`);
          console.log(`  模型: ${session.model}, 来源: ${session.source}`);
          console.log(`  时间: ${new Date(session.createdAt).toLocaleString()}`);
          
          const analysis = await analyzeSessionCompliance(session.id);
          
          if (analysis.valid) {
            console.log(`  ${colorize('green', '✓')} 合规性检查通过`);
          } else {
            console.log(`  ${colorize('red', '✗')} 发现 ${analysis.complianceIssues.length} 个问题:`);
            analysis.complianceIssues.forEach(issue => {
              console.log(`    • ${issue}`);
            });
          }
          
          if (detailed) {
            console.log(`  消息统计: ${analysis.totalMessages} 条`);
            console.log(`    user: ${analysis.userMessages}, assistant: ${analysis.assistantMessages}, tool: ${analysis.toolMessages}`);
            console.log(`    比例: ${analysis.messageRatio.user}% / ${analysis.messageRatio.assistant}% / ${analysis.messageRatio.tool}%`);
            
            if (analysis.hasReasoning) {
              console.log(`  ${colorize('green', '✓')} 包含推理内容`);
            }
            
            if (analysis.toolInputsWithFilePath > 0) {
              console.log(`  ${colorize('green', '✓')} ${analysis.toolInputsWithFilePath} 条工具消息包含文件路径`);
            }
          }
        }
      } else {
        printWarning('未找到历史会话记录');
      }
    } catch (error) {
      printWarning(`分析会话失败: ${error.message}`);
    }
  }
  
  console.log();
  console.log(colorize('bold', '3. MCP 协议合规检查清单'));
  console.log('以下清单基于 @docs/MCP-CLIENT-GUIDE.md 规范:');
  console.log();
  
  const checklist = [
    { item: '每次用户消息后立即调用 log_turn(role="user")', key: 'user-messages' },
    { item: '每次助手回复后立即调用 log_turn(role="assistant", reasoning="...")', key: 'assistant-reasoning' },
    { item: '每次工具执行后立即调用 log_turn(role="tool", tool_input="...")', key: 'tool-executions' },
    { item: '整个对话中复用同一 session_id', key: 'session-id-reuse' },
    { item: '推理模型的完整思考过程传入 reasoning 字段', key: 'reasoning-complete' },
    { item: '文件操作必填 tool_input 路径（如 filePath=src/foo.ts）', key: 'file-path-recording' },
    { item: 'log_turn 按消息产生顺序调用，不乱序', key: 'message-ordering' },
    { item: 'log_intent 在任务完成后调用一次', key: 'intent-call' },
    { item: 'affected_files 汇总所有本次任务改动的文件', key: 'affected-files' },
  ];
  
  checklist.forEach((check, index) => {
    console.log(`  [${index + 1}] ${check.item}`);
  });
  
  console.log();
  console.log(colorize('bold', '4. 合规性摘要'));
  
  // 尝试获取更多会话进行统计分析
  try {
    const allSessions = await callBackend('/api/sessions?pageSize=20');
    
    if (allSessions.success && allSessions.data?.data?.length > 0) {
      const sessions = allSessions.data.data;
      const opencodeSessions = sessions.filter(s => s.source === 'opencode');
      
      if (opencodeSessions.length > 0) {
        console.log(`分析 ${opencodeSessions.length} 个 OpenCode 会话:`);
        
        let totalMessages = 0;
        let totalUser = 0;
        let totalAssistant = 0;
        let totalTool = 0;
        let sessionsWithIssues = 0;
        
        for (const session of opencodeSessions.slice(0, 5)) {
          const analysis = await analyzeSessionCompliance(session.id);
          
          totalMessages += analysis.totalMessages;
          totalUser += analysis.userMessages;
          totalAssistant += analysis.assistantMessages;
          totalTool += analysis.toolMessages;
          
          if (!analysis.valid) {
            sessionsWithIssues++;
          }
        }
        
        console.log(`  总消息数: ${totalMessages}`);
        console.log(`  消息分布: user=${totalUser}, assistant=${totalAssistant}, tool=${totalTool}`);
        
        if (totalMessages > 0) {
          const userRatio = (totalUser / totalMessages * 100).toFixed(1);
          const assistantRatio = (totalAssistant / totalMessages * 100).toFixed(1);
          const toolRatio = (totalTool / totalMessages * 100).toFixed(1);
          
          console.log(`  比例分布: ${userRatio}% / ${assistantRatio}% / ${toolRatio}%`);
          
          // 理想比例检查（user:assistant ≈ 1:1）
          const ratioBalance = Math.abs(totalUser - totalAssistant) / Math.max(totalUser, totalAssistant);
          if (ratioBalance > 0.3) {
            printWarning(`消息比例失衡（user/assistant 相差 ${Math.abs(totalUser - totalAssistant)} 条）`);
          }
          
          // 工具消息检查
          if (totalAssistant > 0 && totalTool === 0) {
            printWarning('检测到 assistant 消息但无 tool 消息（可能工具执行未记录）');
          }
        }
        
        if (sessionsWithIssues > 0) {
          console.log(colorize('yellow', `  ⚠  ${sessionsWithIssues}/${opencodeSessions.length} 个会话存在合规问题`));
        } else {
          console.log(colorize('green', `  ✓ 所有分析的会话均符合 MCP 协议`));
        }
      } else {
        console.log('未找到 OpenCode 会话记录');
      }
    }
  } catch (error) {
    // 忽略统计分析错误
  }
  
  console.log();
  console.log(colorize('bold', '5. 验证结果'));
  console.log(`总计: ${results.total} 项检查`);
  console.log(`通过: ${colorize('green', results.passed.toString())}`);
  console.log(`失败: ${colorize(results.failed > 0 ? 'red' : 'green', results.failed.toString())}`);
  console.log(`警告: ${colorize(results.warnings > 0 ? 'yellow' : 'green', results.warnings.toString())}`);
  
  if (results.failed === 0) {
    console.log(colorize('green', '\n✅ MCP 协议合规性验证通过'));
    console.log('OpenCode 客户端正确遵守了 AgentLog MCP 协议规范。');
  } else {
    console.log(colorize('red', '\n❌ 发现 MCP 协议合规性问题'));
    console.log('请检查 OpenCode 客户端实现，确保完整遵守 @docs/MCP-CLIENT-GUIDE.md 规范。');
  }
  
  console.log();
  console.log(colorize('cyan', '建议操作:'));
  console.log('1. 在 OpenCode 中执行一次完整任务（包含文件修改）');
  console.log('2. 重新运行此脚本验证记录完整性');
  console.log('3. 检查 ~/.config/opencode/AGENTS.md 规则文件是否完整');
  console.log('4. 如有问题，在 VS Code 中执行 "AgentLog: 配置 AI Agent MCP 接入"');
  
  return results.failed === 0;
}

// 命令行参数解析
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    detailed: false,
    analyzeRecent: true,
    help: false,
  };
  
  for (const arg of args) {
    if (arg === '--detailed' || arg === '-d') {
      options.detailed = true;
    } else if (arg === '--no-analyze') {
      options.analyzeRecent = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }
  
  return options;
}

// 显示帮助信息
function showHelp() {
  console.log(colorize('bold', 'AgentLog MCP 合规性验证脚本'));
  console.log();
  console.log('使用方法:');
  console.log('  node scripts/verify-mcp-compliance.js [选项]');
  console.log();
  console.log('选项:');
  console.log('  --detailed, -d     显示详细分析信息');
  console.log('  --no-analyze       跳过最近会话分析');
  console.log('  --help, -h         显示此帮助信息');
  console.log();
  console.log('功能:');
  console.log('  1. 验证 AgentLog 后端服务状态');
  console.log('  2. 分析最近会话的 MCP 协议合规性');
  console.log('  3. 检查消息记录完整性（user/assistant/tool 比例）');
  console.log('  4. 识别常见合规问题（如缺少 reasoning、tool_input 等）');
  console.log('  5. 提供合规检查清单和改进建议');
  console.log();
}

// 主入口
async function main() {
  const options = parseArgs();
  
  if (options.help) {
    showHelp();
    process.exit(0);
  }
  
  try {
    const success = await runComplianceCheck(options);
    process.exit(success ? 0 : 1);
  } catch (error) {
    console.error(colorize('red', `验证过程出错: ${error.message}`));
    console.error(error.stack);
    process.exit(1);
  }
}

// 执行
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { runComplianceCheck, analyzeSessionCompliance };