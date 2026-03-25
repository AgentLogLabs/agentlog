#!/usr/bin/env node

/**
 * AgentLog MCP 合规性验证脚本（简化版）
 * 使用 Node.js 18+ 内置 fetch API
 */

const BACKEND_URL = 'http://localhost:7892';
const TEST_WORKSPACE = process.cwd();

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function colorize(color, text) {
  return colors[color] + text + colors.reset;
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

// 分析会话合规性
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
      complianceIssues: [],
    };
    
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
async function main() {
  console.log(colorize('bold', '🔍 AgentLog MCP 协议合规性验证（简化版）'));
  console.log(colorize('cyan', '='.repeat(60)));
  console.log(`后端地址: ${BACKEND_URL}`);
  console.log(`工作目录: ${TEST_WORKSPACE}`);
  console.log(`Node 版本: ${process.version}`);
  console.log();
  
  // 测试后端连接
  console.log(colorize('bold', '1. 后端服务检查'));
  try {
    const health = await callBackend('/health');
    console.log(`  ${colorize('green', '✓')} 后端服务可访问 (${health.status})`);
  } catch {
    console.log(colorize('red', '❌ 后端服务不可用，无法继续验证'));
    console.log('请确保 AgentLog 后端正在运行：');
    console.log('  - 在 VS Code 中执行 "AgentLog: 启动本地后台服务"');
    console.log('  - 或运行: pnpm --filter @agentlog/backend dev');
    process.exit(1);
  }
  
  // 获取最近会话
  console.log(colorize('bold', '\n2. 最近会话合规性分析'));
  
  try {
    const sessions = await callBackend('/api/sessions?pageSize=10&source=opencode');
    
    if (sessions.success && sessions.data?.data?.length > 0) {
      const recentSessions = sessions.data.data;
      
      console.log(`找到 ${recentSessions.length} 个 OpenCode 会话`);
      
      for (let i = 0; i < Math.min(5, recentSessions.length); i++) {
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
        
        console.log(`  消息统计: ${analysis.totalMessages} 条`);
        console.log(`    user: ${analysis.userMessages}, assistant: ${analysis.assistantMessages}, tool: ${analysis.toolMessages}`);
        
        if (analysis.totalMessages > 0) {
          const userRatio = (analysis.userMessages / analysis.totalMessages * 100).toFixed(1);
          const assistantRatio = (analysis.assistantMessages / analysis.totalMessages * 100).toFixed(1);
          const toolRatio = (analysis.toolMessages / analysis.totalMessages * 100).toFixed(1);
          console.log(`    比例: ${userRatio}% / ${assistantRatio}% / ${toolRatio}%`);
        }
        
        if (analysis.hasReasoning) {
          console.log(`  ${colorize('green', '✓')} 包含推理内容`);
        }
        
        if (analysis.toolInputsWithFilePath > 0) {
          console.log(`  ${colorize('green', '✓')} ${analysis.toolInputsWithFilePath} 条工具消息包含文件路径`);
        }
      }
    } else {
      console.log('  未找到 OpenCode 会话记录');
    }
  } catch (error) {
    console.log(`  分析会话失败: ${error.message}`);
  }
  
  // 重点分析问题会话
  console.log(colorize('bold', '\n3. 重点问题分析'));
  
  const problemSessionId = 'zs_-oCWpzC0KkKRUBfFiv';
  const workingSessionId = 'k8ZPlqC8kSRJQxQvXYsLo';
  
  console.log(`\n对比分析：`);
  console.log(`  A. 问题会话: ${problemSessionId}`);
  console.log(`  B. 正常会话: ${workingSessionId}`);
  
  const problemAnalysis = await analyzeSessionCompliance(problemSessionId);
  const workingAnalysis = await analyzeSessionCompliance(workingSessionId);
  
  console.log(`\n问题会话 ${problemSessionId}:`);
  console.log(`  总消息: ${problemAnalysis.totalMessages}, user: ${problemAnalysis.userMessages}, assistant: ${problemAnalysis.assistantMessages}, tool: ${problemAnalysis.toolMessages}`);
  console.log(`  工具消息: ${problemAnalysis.toolMessages === 0 ? colorize('red', '❌ 无') : colorize('green', '✓ 有')}`);
  
  console.log(`\n正常会话 ${workingSessionId}:`);
  console.log(`  总消息: ${workingAnalysis.totalMessages}, user: ${workingAnalysis.userMessages}, assistant: ${workingAnalysis.assistantMessages}, tool: ${workingAnalysis.toolMessages}`);
  console.log(`  工具消息: ${workingAnalysis.toolMessages === 0 ? colorize('red', '❌ 无') : colorize('green', '✓ 有')}`);
  
  console.log(colorize('bold', '\n4. 诊断结论'));
  console.log(`问题会话 ${problemSessionId} 缺少工具消息记录，而正常会话 ${workingSessionId} 有完整的工具记录。`);
  console.log(`这表明 OpenCode 的 MCP 客户端在某些会话中未能正确调用 agentlog_log_turn(role="tool")。`);
  console.log(`可能的原因：`);
  console.log(`  1. MCP 连接在会话中途断开或失败`);
  console.log(`  2. OpenCode 对不同类型工具的处理不一致`);
  console.log(`  3. 会话期间的网络或配置问题`);
  console.log(`  4. OpenCode MCP 客户端实现有缺陷`);
  
  console.log(colorize('bold', '\n5. 解决方案建议'));
  console.log(`1. 检查 OpenCode 日志，查看 MCP 工具调用失败记录`);
  console.log(`2. 验证 ~/.config/opencode/config.json 中的 MCP 配置`);
  console.log(`3. 在 OpenCode 中启用调试模式，查看工具执行后的 log_turn 调用`);
  console.log(`4. 确保 OpenCode 读取了 ~/.config/opencode/AGENTS.md 规则文件`);
  console.log(`5. 如果问题持续，考虑向 OpenCode 团队报告此 MCP 客户端缺陷`);
  
  console.log(colorize('bold', '\n6. 立即验证步骤'));
  console.log(`1. 在 VS Code 中执行 "AgentLog: 验证 MCP 连接"`);
  console.log(`2. 使用 OpenCode 执行一个简单任务（包含文件读取和编辑）`);
  console.log(`3. 检查新会话是否完整记录了所有工具调用`);
  console.log(`4. 如果仍有问题，检查 AgentLog 后端日志`);
  
  console.log(colorize('cyan', '\n' + '='.repeat(60)));
  console.log('验证完成');
}

// 执行
main().catch(error => {
  console.error(colorize('red', `验证过程出错: ${error.message}`));
  console.error(error.stack);
  process.exit(1);
});