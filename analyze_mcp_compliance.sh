#!/bin/bash

echo "🔍 AgentLog MCP 协议合规性分析"
echo "================================"

# 获取最近5个OpenCode会话
echo "获取最近5个OpenCode会话..."
SESSIONS=$(curl -s "http://localhost:7892/api/sessions?source=opencode&pageSize=5")

if [ $? -ne 0 ]; then
  echo "❌ 无法连接到AgentLog后端"
  exit 1
fi

echo "✅ 后端连接成功"
echo

# 提取会话ID列表
SESSION_IDS=$(echo "$SESSIONS" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

for SESSION_ID in $SESSION_IDS; do
  echo "分析会话: $SESSION_ID"
  echo "------------------------------------------------"
  
  # 获取会话详情
  SESSION_DETAIL=$(curl -s "http://localhost:7892/api/sessions/$SESSION_ID")
  
  # 提取transcript数组长度
  TRANS_COUNT=$(echo "$SESSION_DETAIL" | grep -o '"role":"[^"]*"' | wc -l)
  USER_COUNT=$(echo "$SESSION_DETAIL" | grep -o '"role":"user"' | wc -l)
  ASSISTANT_COUNT=$(echo "$SESSION_DETAIL" | grep -o '"role":"assistant"' | wc -l)
  TOOL_COUNT=$(echo "$SESSION_DETAIL" | grep -o '"role":"tool"' | wc -l)
  
  echo "总消息数: $TRANS_COUNT"
  echo "  user: $USER_COUNT, assistant: $ASSISTANT_COUNT, tool: $TOOL_COUNT"
  
  # 计算比例
  if [ $TRANS_COUNT -gt 0 ]; then
    USER_PERCENT=$((USER_COUNT * 100 / TRANS_COUNT))
    ASSISTANT_PERCENT=$((ASSISTANT_COUNT * 100 / TRANS_COUNT))
    TOOL_PERCENT=$((TOOL_COUNT * 100 / TRANS_COUNT))
    echo "  比例: ${USER_PERCENT}% / ${ASSISTANT_PERCENT}% / ${TOOL_PERCENT}%"
  fi
  
  # 检查合规性问题
  echo "合规性检查:"
  
  if [ $USER_COUNT -eq 0 ]; then
    echo "  ❌ 缺少 user 消息"
  else
    echo "  ✅ 有 user 消息"
  fi
  
  if [ $ASSISTANT_COUNT -eq 0 ] && [ $TRANS_COUNT -gt 0 ]; then
    echo "  ❌ 缺少 assistant 消息"
  elif [ $ASSISTANT_COUNT -gt 0 ]; then
    echo "  ✅ 有 assistant 消息"
    
    # 检查是否有reasoning字段
    HAS_REASONING=$(echo "$SESSION_DETAIL" | grep -c '"reasoning"')
    if [ $HAS_REASONING -gt 0 ]; then
      echo "    ✅ assistant 消息包含 reasoning 字段"
    else
      echo "    ⚠  assistant 消息缺少 reasoning 字段"
    fi
  fi
  
  if [ $TOOL_COUNT -eq 0 ] && [ $ASSISTANT_COUNT -gt 0 ]; then
    echo "  ⚠  缺少 tool 消息（可能存在工具执行未记录）"
  elif [ $TOOL_COUNT -gt 0 ]; then
    echo "  ✅ 有 tool 消息"
    
    # 检查是否有tool_input字段
    HAS_TOOL_INPUT=$(echo "$SESSION_DETAIL" | grep -c '"toolInput"')
    if [ $HAS_TOOL_INPUT -gt 0 ]; then
      echo "    ✅ tool 消息包含 tool_input 字段"
    else
      echo "    ⚠  tool 消息缺少 tool_input 字段"
    fi
  fi
  
  # 检查消息比例平衡（理想情况 user ≈ assistant）
  if [ $TRANS_COUNT -ge 3 ]; then
    DIFF=$((USER_COUNT > ASSISTANT_COUNT ? USER_COUNT - ASSISTANT_COUNT : ASSISTANT_COUNT - USER_COUNT))
    MAX=$((USER_COUNT > ASSISTANT_COUNT ? USER_COUNT : ASSISTANT_COUNT))
    if [ $MAX -gt 0 ]; then
      RATIO_DIFF=$((DIFF * 100 / MAX))
      if [ $RATIO_DIFF -gt 30 ]; then
        echo "  ⚠  user/assistant 消息比例失衡（相差 $DIFF 条）"
      fi
    fi
  fi
  
  echo
done

echo "分析完成！"
echo
echo "建议:"
echo "1. 确保 OpenCode 在每次消息产生后立即调用 agentlog_log_turn"
echo "2. 检查 ~/.config/opencode/AGENTS.md 规则文件是否被正确读取"
echo "3. 验证 MCP 连接: 在 VS Code 中执行 'AgentLog: 验证 MCP 连接'"
echo "4. 如果问题持续，请检查 OpenCode 的 MCP 客户端实现"