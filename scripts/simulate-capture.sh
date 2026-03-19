#!/usr/bin/env bash
# =============================================================================
# AgentLog — 模拟 AI 捕获上报脚本
#
# 该脚本模拟"VS Code 插件拦截到一次 AI 交互后，向本地后台上报会话"的完整流程。
# 适用于在没有 Cline/Cursor 的情况下，手工验证后台接收、存储、查询是否正常。
#
# 用法：
#   bash scripts/simulate-capture.sh                      # 使用默认参数
#   bash scripts/simulate-capture.sh --provider qwen      # 指定模型提供商
#   bash scripts/simulate-capture.sh --model kimi         # 指定模型名称
#   bash scripts/simulate-capture.sh --port 7892          # 指定后台端口
#   bash scripts/simulate-capture.sh --count 5            # 连续上报 5 条会话
#   bash scripts/simulate-capture.sh --reasoning          # 包含推理过程（模拟 DeepSeek-R1）
#   bash scripts/simulate-capture.sh --workspace /my/proj # 指定工作区路径
#
# 依赖：curl（必须）、jq（可选，用于美化输出）
# =============================================================================

set -euo pipefail

# ─────────────────────────────────────────────
# 参数默认值
# ─────────────────────────────────────────────

PORT=7892
PROVIDER="deepseek"
MODEL="deepseek-r1"
SOURCE="cline"
WORKSPACE="$(pwd)"
COUNT=1
WITH_REASONING=false
VERBOSE=false

# ─────────────────────────────────────────────
# 参数解析
# ─────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)       PORT="$2";       shift 2 ;;
    --provider)   PROVIDER="$2";   shift 2 ;;
    --model)      MODEL="$2";      shift 2 ;;
    --source)     SOURCE="$2";     shift 2 ;;
    --workspace)  WORKSPACE="$2";  shift 2 ;;
    --count)      COUNT="$2";      shift 2 ;;
    --reasoning)  WITH_REASONING=true; shift ;;
    --verbose|-v) VERBOSE=true;    shift ;;
    --help|-h)
      sed -n '3,20p' "$0" | sed 's/^# //; s/^#//'
      exit 0
      ;;
    *) echo "未知参数: $1  (使用 --help 查看帮助)"; exit 1 ;;
  esac
done

BASE_URL="http://127.0.0.1:${PORT}"

# ─────────────────────────────────────────────
# 颜色
# ─────────────────────────────────────────────

if [[ -t 1 ]]; then
  C_RESET='\033[0m'
  C_GREEN='\033[0;32m'
  C_RED='\033[0;31m'
  C_YELLOW='\033[0;33m'
  C_CYAN='\033[0;36m'
  C_BOLD='\033[1m'
  C_DIM='\033[2m'
else
  C_RESET=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_CYAN=''; C_BOLD=''; C_DIM=''
fi

log()     { echo -e "${C_DIM}[$(date +%H:%M:%S)]${C_RESET} $*"; }
success() { echo -e "${C_GREEN}✔  $*${C_RESET}"; }
error()   { echo -e "${C_RED}✖  $*${C_RESET}"; }
info()    { echo -e "${C_CYAN}ℹ  $*${C_RESET}"; }
warn()    { echo -e "${C_YELLOW}⚠  $*${C_RESET}"; }

# ─────────────────────────────────────────────
# JSON 工具
# ─────────────────────────────────────────────

pretty_json() {
  if command -v jq &>/dev/null; then
    echo "$1" | jq -C . 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

jq_get() {
  local json="$1" field="$2"
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r "$field" 2>/dev/null
  else
    echo "$json" | grep -o "\"${field#.}\":\"[^\"]*\"" | cut -d'"' -f4 | head -1
  fi
}

# ─────────────────────────────────────────────
# 测试数据库（各种 Prompt / Response 示例）
# ─────────────────────────────────────────────

# 随机选取一个场景的数据
PROMPTS=(
  "帮我用 TypeScript 实现一个带 TTL 过期机制的本地缓存类"
  "重构 getUserById 函数，使其支持并发安全的缓存层"
  "为 Express 路由添加 JWT 鉴权中间件，支持白名单路径"
  "将下面这段 callback 风格的代码改写为 async/await"
  "帮我写一个 Git Hook，在 commit 前自动运行 lint 检查"
  "优化这个 SQL 查询，避免 N+1 问题：SELECT * FROM users JOIN orders"
  "给 React 组件添加错误边界（Error Boundary），捕获子组件渲染异常"
  "实现一个基于 EventEmitter 的轻量级发布订阅系统"
  "帮我把这段 Python 脚本翻译成 Node.js，保持相同的业务逻辑"
  "分析这段代码的时间复杂度，并给出优化建议"
)

RESPONSES=(
  "以下是带 TTL 的缓存类实现：\n\`\`\`ts\nclass TTLCache<K, V> {\n  private store = new Map<K, { value: V; expiredAt: number }>();\n  constructor(private ttlMs: number) {}\n  set(key: K, value: V) {\n    this.store.set(key, { value, expiredAt: Date.now() + this.ttlMs });\n  }\n  get(key: K): V | undefined {\n    const entry = this.store.get(key);\n    if (!entry) return undefined;\n    if (Date.now() > entry.expiredAt) { this.store.delete(key); return undefined; }\n    return entry.value;\n  }\n}\n\`\`\`"
  "重构后的 getUserById 使用 Map 缓存，key 为 userId，并用 Mutex 保证并发安全。主要改动：\n1. 引入 async-mutex 包\n2. 在缓存写入前加锁\n3. 添加缓存预热逻辑"
  "JWT 中间件实现如下，白名单通过数组配置：\n\`\`\`ts\nconst whitelist = ['/health', '/login', '/register'];\napp.use((req, res, next) => {\n  if (whitelist.includes(req.path)) return next();\n  // verify token...\n});\n\`\`\`"
  "将 callback 改为 async/await 后代码更清晰。关键点：\n1. 用 util.promisify 包装旧 API\n2. 用 try/catch 替换 error-first callback\n3. 注意 Promise.all 处理并发场景"
  "Git Hook 脚本（.git/hooks/pre-commit）：\n\`\`\`sh\n#!/bin/sh\nnpx eslint --ext .ts,.js src/ || exit 1\n\`\`\`\n记得 chmod +x .git/hooks/pre-commit"
  "N+1 优化方案：使用 JOIN 预加载关联数据，或用 DataLoader 做批量请求合并。推荐改写为：\nSELECT u.*, o.id as order_id FROM users u LEFT JOIN orders o ON u.id = o.user_id"
  "Error Boundary 实现：\n\`\`\`tsx\nclass ErrorBoundary extends React.Component {\n  state = { hasError: false };\n  static getDerivedStateFromError() { return { hasError: true }; }\n  render() { return this.state.hasError ? <Fallback /> : this.props.children; }\n}\n\`\`\`"
  "轻量发布订阅系统，基于 EventEmitter 扩展，新增 once 自动注销、通配符支持：\n\`\`\`ts\nclass PubSub extends EventEmitter {\n  subscribe(event: string, handler: Function) { this.on(event, handler); }\n  publish(event: string, data: unknown) { this.emit(event, data); }\n}\n\`\`\`"
  "Node.js 版本已翻译完成，主要差异：\n1. 同步 I/O 改为 fs.promises 异步\n2. time.sleep 改为 await new Promise(r => setTimeout(r, ms))\n3. dict 改为 Map/Object"
  "该算法当前时间复杂度为 O(n²)，主要瓶颈在嵌套循环。优化建议：\n1. 外层循环改为哈希表预处理 → O(n)\n2. 排序后双指针 → O(n log n)\n推荐方案一，空间换时间更划算。"
)

REASONING_EXAMPLES=(
  "<think>\n用户需要一个带 TTL 过期的缓存类。\n\n思路：\n1. 使用 Map 存储键值对\n2. 每个值附带过期时间戳\n3. get 时检查是否过期，过期则删除并返回 undefined\n4. 可选：定期清理过期条目（setInterval），避免内存泄漏\n\n考虑边界情况：\n- TTL 为 0 或负数时应立即过期\n- 并发读写需要考虑竞态（TypeScript 单线程，Web Worker 除外）\n\n最终决策：实现基础版本，TTL 在 get 时惰性检查，不做后台清理（保持简单）。\n</think>"
  "<think>\n用户希望重构 getUserById 使其支持缓存，且并发安全。\n\n分析当前问题：\n1. 多个并发请求可能同时发现缓存未命中，导致多次数据库查询（缓存击穿）\n2. 需要一种机制确保同一 key 同时只有一个查询在飞行中\n\n方案对比：\n- 方案 A：简单 Map 缓存 — 有竞态，不推荐\n- 方案 B：加互斥锁（async-mutex） — 适合 Node.js 单进程\n- 方案 C：Promise 合并（inflight） — 性能最好，但实现复杂\n\n选择方案 B，因为用户场景是单服务，互斥锁足够简单可靠。\n</think>"
  "<think>\n分析用户的 SQL 性能问题。\n\n当前 SQL：SELECT * FROM users JOIN orders\n典型的 N+1 问题表现：对每个 user 都单独查一次 orders。\n\n优化思路：\n1. 用一次 JOIN 取所有数据，在应用层分组\n2. 使用 DataLoader 批量合并请求（适合 GraphQL）\n3. 添加索引：orders.user_id 应有索引\n\n由于用户用的是 Express + SQL，推荐方案 1，最简单直接。\n需要注意：LEFT JOIN vs INNER JOIN 的区别，没有订单的用户用 LEFT JOIN 保留。\n</think>"
)

AFFECTED_FILES_SETS=(
  '["src/cache/TTLCache.ts","src/cache/index.ts"]'
  '["src/user/service.ts","src/user/repository.ts","package.json"]'
  '["src/middleware/auth.ts","src/routes/index.ts","src/config/whitelist.ts"]'
  '["src/utils/promisify.ts","src/services/legacy.ts"]'
  '[".git/hooks/pre-commit","package.json"]'
  '["src/db/queries/userOrders.sql","src/db/repositories/orderRepository.ts"]'
  '["src/components/ErrorBoundary.tsx","src/components/Fallback.tsx"]'
  '["src/lib/pubsub.ts","src/lib/index.ts"]'
  '["src/scripts/migrate.ts"]'
  '["src/algorithms/search.ts","src/algorithms/README.md"]'
)

TAGS_SETS=(
  '["缓存","TypeScript","TTL"]'
  '["重构","缓存","并发安全"]'
  '["中间件","JWT","鉴权"]'
  '["重构","async/await","callback"]'
  '["DevOps","Git Hook","lint"]'
  '["性能优化","SQL","N+1"]'
  '["React","错误处理","Error Boundary"]'
  '["设计模式","发布订阅","EventEmitter"]'
  '["翻译","Python","Node.js"]'
  '["算法","性能分析","优化"]'
)

# ─────────────────────────────────────────────
# 检查后台连通性
# ─────────────────────────────────────────────

check_backend() {
  local response
  response=$(curl -s --max-time 3 "${BASE_URL}/health" 2>/dev/null || echo "")

  if [[ -z "$response" ]]; then
    error "无法连接到后台服务：${BASE_URL}"
    echo ""
    echo "  请先启动后台服务："
    echo "    cd packages/backend"
    echo "    pnpm dev"
    echo ""
    echo "  或使用以下命令在后台运行："
    echo "    pnpm --filter @agentlog/backend dev &"
    echo ""
    exit 1
  fi

  local status
  status=$(jq_get "$response" ".status")
  if [[ "$status" != "ok" ]]; then
    error "后台服务响应异常：${response}"
    exit 1
  fi

  local version
  version=$(jq_get "$response" ".version")
  success "后台服务在线（版本：${version:-unknown}，端口：${PORT}）"
}

# ─────────────────────────────────────────────
# 上报单条会话
# ─────────────────────────────────────────────

simulate_one() {
  local index="${1:-0}"

  # 从预设数据中循环选取（取模）
  local arr_len=${#PROMPTS[@]}
  local pick=$((index % arr_len))

  local prompt="${PROMPTS[$pick]}"
  local response_text="${RESPONSES[$pick]}"
  local affected_files="${AFFECTED_FILES_SETS[$pick]}"
  local tags="${TAGS_SETS[$pick]}"
  local duration_ms=$((RANDOM % 5000 + 800))  # 800~5800ms 随机耗时

  # 推理过程（可选）
  local reasoning_json=""
  if [[ "$WITH_REASONING" == true ]]; then
    local reasoning_pick=$((index % ${#REASONING_EXAMPLES[@]}))
    local reasoning_text="${REASONING_EXAMPLES[$reasoning_pick]}"
    # 转义换行和引号以嵌入 JSON
    reasoning_text=$(echo "$reasoning_text" | python3 -c "
import sys, json
print(json.dumps(sys.stdin.read())[1:-1])  # strip outer quotes
" 2>/dev/null || echo "$reasoning_text" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n')
    reasoning_json="\"reasoning\": \"${reasoning_text}\","
  fi

  # 构建请求体
  local body
  body=$(cat <<EOF
{
  "provider": "${PROVIDER}",
  "model": "${MODEL}",
  "source": "${SOURCE}",
  "workspacePath": "${WORKSPACE}",
  "prompt": "${prompt}",
  ${reasoning_json}
  "response": "${response_text}",
  "affectedFiles": ${affected_files},
  "durationMs": ${duration_ms},
  "tags": ${tags},
  "metadata": {
    "simulatedBy": "simulate-capture.sh",
    "simulationIndex": ${index},
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  }
}
EOF
)

  if [[ "$VERBOSE" == true ]]; then
    echo ""
    log "上报请求体："
    pretty_json "$body"
  fi

  # 发送请求
  local http_response
  http_response=$(curl -s -w "\n__HTTP_CODE__%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$body" \
    --max-time 10 \
    "${BASE_URL}/api/sessions" 2>/dev/null)

  local http_code
  http_code=$(echo "$http_response" | grep '__HTTP_CODE__' | sed 's/__HTTP_CODE__//')
  local resp_body
  resp_body=$(echo "$http_response" | grep -v '__HTTP_CODE__')

  if [[ "$http_code" == "201" ]]; then
    local session_id
    session_id=$(jq_get "$resp_body" ".data.id")
    local short_id="${session_id:0:8}"
    local provider_display
    case "$PROVIDER" in
      deepseek) provider_display="🐋 DeepSeek" ;;
      qwen)     provider_display="🌊 通义千问" ;;
      kimi)     provider_display="🌙 Kimi" ;;
      doubao)   provider_display="🫘 豆包" ;;
      zhipu)    provider_display="🧠 智谱" ;;
      *)        provider_display="🤖 ${PROVIDER}" ;;
    esac

    success "会话已上报 [${short_id}] ${provider_display}/${MODEL} — ${duration_ms}ms"
    info    "  Prompt: ${prompt:0:50}…"

    if [[ "$WITH_REASONING" == true ]]; then
      info "  推理过程：已包含（DeepSeek-R1 格式）"
    fi

    if [[ "$VERBOSE" == true ]]; then
      echo ""
      log "后台响应："
      pretty_json "$resp_body"
    fi

    # 返回 session_id（用于后续操作）
    echo "$session_id"
    return 0
  else
    error "上报失败（HTTP ${http_code}）"
    if [[ -n "$resp_body" ]]; then
      echo "  响应：$(echo "$resp_body" | head -c 300)"
    fi
    echo ""
    return 1
  fi
}

# ─────────────────────────────────────────────
# 显示上报后的验证结果
# ─────────────────────────────────────────────

verify_session() {
  local session_id="$1"

  if [[ -z "$session_id" || "$session_id" == "null" ]]; then
    return
  fi

  echo ""
  info "验证：查询刚上报的会话…"

  local response
  response=$(curl -s --max-time 5 "${BASE_URL}/api/sessions/${session_id}" 2>/dev/null)

  local provider model source reasoning_len
  provider=$(jq_get "$response" ".data.provider")
  model=$(jq_get "$response" ".data.model")
  source=$(jq_get "$response" ".data.source")

  if command -v jq &>/dev/null; then
    reasoning_len=$(echo "$response" | jq -r '.data.reasoning // "" | length' 2>/dev/null || echo "0")
  else
    reasoning_len="?"
  fi

  echo ""
  echo -e "  ${C_BOLD}会话详情${C_RESET}"
  echo -e "  ├── ID         : ${C_CYAN}${session_id}${C_RESET}"
  echo -e "  ├── Provider   : ${provider}"
  echo -e "  ├── Model      : ${model}"
  echo -e "  ├── Source     : ${source}"
  echo -e "  ├── Workspace  : ${WORKSPACE}"
  if [[ "$WITH_REASONING" == true ]]; then
    echo -e "  ├── Reasoning  : ${C_YELLOW}${reasoning_len} 字符${C_RESET}"
  fi
  echo -e "  └── Commit     : ${C_DIM}未绑定（可用 PATCH /api/sessions/:id/commit 绑定）${C_RESET}"
}

# ─────────────────────────────────────────────
# 显示统计信息
# ─────────────────────────────────────────────

show_stats() {
  echo ""
  info "当前数据库统计信息："

  local response
  response=$(curl -s --max-time 5 "${BASE_URL}/api/sessions/stats" 2>/dev/null)

  if command -v jq &>/dev/null; then
    local total bound unbound avg_ms
    total=$(echo "$response" | jq -r '.data.total // 0')
    bound=$(echo "$response" | jq -r '.data.boundToCommit // 0')
    unbound=$(echo "$response" | jq -r '.data.unbound // 0')
    avg_ms=$(echo "$response" | jq -r '.data.avgDurationMs // 0')

    echo ""
    echo -e "  ${C_BOLD}会话统计${C_RESET}"
    echo -e "  ├── 总会话数   : ${C_GREEN}${total}${C_RESET}"
    echo -e "  ├── 已绑定     : ${bound}"
    echo -e "  ├── 未绑定     : ${C_YELLOW}${unbound}${C_RESET}"
    echo -e "  └── 平均耗时   : ${avg_ms}ms"

    # 按 provider 分组
    local by_provider
    by_provider=$(echo "$response" | jq -r '.data.byProvider // {} | to_entries[] | "  │   \(.key): \(.value)" ' 2>/dev/null)
    if [[ -n "$by_provider" ]]; then
      echo ""
      echo -e "  ${C_BOLD}按模型提供商${C_RESET}"
      echo "$by_provider"
    fi
  else
    echo "  $(echo "$response" | head -c 200)"
  fi
}

# ─────────────────────────────────────────────
# 显示快速操作提示
# ─────────────────────────────────────────────

show_next_steps() {
  local last_id="$1"

  echo ""
  echo -e "${C_BOLD}${C_DIM}──────────────────────────────────────────────${C_RESET}"
  echo -e "${C_BOLD}  后续操作示例${C_RESET}"
  echo -e "${C_DIM}──────────────────────────────────────────────${C_RESET}"

  if [[ -n "$last_id" && "$last_id" != "null" ]]; then
    local short="${last_id:0:12}"
    echo ""
    echo -e "  ${C_BOLD}# 查询刚上报的会话${C_RESET}"
    echo -e "  ${C_DIM}curl ${BASE_URL}/api/sessions/${last_id}${C_RESET}"
    echo ""
    echo -e "  ${C_BOLD}# 绑定到一个假 Commit${C_RESET}"
    echo -e "  ${C_DIM}curl -X PATCH ${BASE_URL}/api/sessions/${last_id}/commit \\"
    echo -e "    -H 'Content-Type: application/json' \\"
    echo -e "    -d '{\"commitHash\":\"abc1234def5678\"}'${C_RESET}"
    echo ""
    echo -e "  ${C_BOLD}# 更新标签${C_RESET}"
    echo -e "  ${C_DIM}curl -X PATCH ${BASE_URL}/api/sessions/${last_id}/tags \\"
    echo -e "    -H 'Content-Type: application/json' \\"
    echo -e "    -d '{\"tags\":[\"bugfix\",\"已验证\"]}'${C_RESET}"
    echo ""
  fi

  echo -e "  ${C_BOLD}# 导出本周周报（Markdown）${C_RESET}"
  echo -e "  ${C_DIM}curl -s -X POST ${BASE_URL}/api/export \\"
  echo -e "    -H 'Content-Type: application/json' \\"
  echo -e "    -d '{\"format\":\"weekly-report\",\"language\":\"zh\"}' \\"
  echo -e "    | jq -r '.data.content'${C_RESET}"
  echo ""
  echo -e "  ${C_BOLD}# 导出 PR 说明${C_RESET}"
  echo -e "  ${C_DIM}curl -s -X POST ${BASE_URL}/api/export \\"
  echo -e "    -H 'Content-Type: application/json' \\"
  echo -e "    -d '{\"format\":\"pr-description\",\"language\":\"zh\"}' \\"
  echo -e "    | jq -r '.data.content'${C_RESET}"
  echo ""
  echo -e "  ${C_BOLD}# 安装 Git Hook（在当前仓库）${C_RESET}"
  echo -e "  ${C_DIM}curl -s -X POST ${BASE_URL}/api/commits/hook/install \\"
  echo -e "    -H 'Content-Type: application/json' \\"
  echo -e "    -d \"{\\\"workspacePath\\\":\\\"${WORKSPACE}\\\"}\"${C_RESET}"
  echo ""
  echo -e "  ${C_BOLD}# 查看全部会话列表（分页）${C_RESET}"
  echo -e "  ${C_DIM}curl '${BASE_URL}/api/sessions?page=1&pageSize=10' | jq .${C_RESET}"
  echo ""
}

# ─────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────

main() {
  echo ""
  echo -e "${C_BOLD}${C_CYAN}"
  echo "╔══════════════════════════════════════════════╗"
  echo "║   AgentLog — AI 捕获模拟上报工具              ║"
  echo "╚══════════════════════════════════════════════╝"
  echo -e "${C_RESET}"

  # 显示当前配置
  echo -e "  ${C_BOLD}配置${C_RESET}"
  echo -e "  ├── 后台地址   : ${BASE_URL}"
  echo -e "  ├── 模型提供商 : ${PROVIDER}"
  echo -e "  ├── 模型名称   : ${MODEL}"
  echo -e "  ├── 来源工具   : ${SOURCE}"
  echo -e "  ├── 工作区     : ${WORKSPACE}"
  echo -e "  ├── 上报条数   : ${COUNT}"
  echo -e "  └── 含推理过程 : $([ "$WITH_REASONING" == true ] && echo '是（DeepSeek-R1 <think> 格式）' || echo '否')"
  echo ""

  # 检查依赖
  if ! command -v curl &>/dev/null; then
    error "需要安装 curl"
    exit 1
  fi

  if ! command -v jq &>/dev/null; then
    warn "未检测到 jq，输出将不会被格式化。安装：brew install jq"
  fi

  # 连通性检查
  check_backend
  echo ""

  # 开始上报
  info "开始模拟上报 ${COUNT} 条 AI 交互会话…"
  echo ""

  local last_id=""
  local success_count=0
  local fail_count=0

  for ((i=0; i<COUNT; i++)); do
    if [[ $COUNT -gt 1 ]]; then
      echo -e "${C_DIM}  ── 第 $((i+1))/${COUNT} 条 ──${C_RESET}"
    fi

    local session_id
    session_id=$(simulate_one "$i") && {
      last_id="$session_id"
      success_count=$((success_count+1))
    } || {
      fail_count=$((fail_count+1))
    }

    # 多条上报时稍作延迟，避免时间戳完全相同
    if [[ $COUNT -gt 1 && $i -lt $((COUNT-1)) ]]; then
      sleep 0.3
    fi
  done

  # 单条上报时显示详情验证
  if [[ $COUNT -eq 1 && -n "$last_id" && "$last_id" != "null" ]]; then
    verify_session "$last_id"
  fi

  # 统计
  show_stats

  # 汇总
  echo ""
  echo -e "${C_BOLD}${C_DIM}──────────────────────────────────────────────${C_RESET}"
  if [[ $fail_count -eq 0 ]]; then
    success "上报完成：${success_count}/${COUNT} 条成功"
  else
    warn "上报完成：${success_count} 成功，${fail_count} 失败"
  fi

  # 下一步操作提示
  show_next_steps "$last_id"
}

main "$@"
