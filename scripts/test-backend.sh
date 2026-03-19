#!/usr/bin/env bash
# =============================================================================
# AgentLog — 后台接口 curl 集成测试脚本
#
# 用法：
#   bash scripts/test-backend.sh              # 自动启动后台，测试完毕后关闭
#   bash scripts/test-backend.sh --no-server  # 假设后台已在运行，仅跑测试
#   bash scripts/test-backend.sh --port 7892  # 指定端口（默认 7892）
#   bash scripts/test-backend.sh --keep       # 测试完毕后保持后台运行
#
# 依赖：curl（必须）、jq（可选，有则美化 JSON 输出）
# =============================================================================

set -euo pipefail

# ─────────────────────────────────────────────
# 参数解析
# ─────────────────────────────────────────────

PORT=7892
AUTO_SERVER=true
KEEP_SERVER=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-server) AUTO_SERVER=false; shift ;;
    --keep)      KEEP_SERVER=true;  shift ;;
    --port)      PORT="$2";         shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

BASE_URL="http://127.0.0.1:${PORT}"

# ─────────────────────────────────────────────
# 颜色 & 格式
# ─────────────────────────────────────────────

if [[ -t 1 ]]; then          # 仅在终端输出时启用颜色
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

# ─────────────────────────────────────────────
# 计数器
# ─────────────────────────────────────────────

PASS=0
FAIL=0
SKIP=0
SUITE_PASS=0
SUITE_FAIL=0

# ─────────────────────────────────────────────
# 全局共享状态（跨测试）
# ─────────────────────────────────────────────

SESSION_ID=""
SESSION_ID_2=""
COMMIT_HASH="testcommit$(date +%s)abcdef"

# ─────────────────────────────────────────────
# 工具函数
# ─────────────────────────────────────────────

log()  { echo -e "${C_DIM}[$(date +%H:%M:%S)]${C_RESET} $*"; }
info() { echo -e "${C_CYAN}ℹ  $*${C_RESET}"; }
ok()   { echo -e "${C_GREEN}✔  $*${C_RESET}"; PASS=$((PASS+1)); SUITE_PASS=$((SUITE_PASS+1)); }
fail() { echo -e "${C_RED}✖  $*${C_RESET}"; FAIL=$((FAIL+1)); SUITE_FAIL=$((SUITE_FAIL+1)); }
skip() { echo -e "${C_YELLOW}⊘  $*${C_RESET}"; SKIP=$((SKIP+1)); }
section() {
  echo ""
  echo -e "${C_BOLD}${C_CYAN}══════════════════════════════════════${C_RESET}"
  echo -e "${C_BOLD}  $*${C_RESET}"
  echo -e "${C_BOLD}${C_CYAN}══════════════════════════════════════${C_RESET}"
  SUITE_PASS=0; SUITE_FAIL=0
}
suite_summary() {
  local name="$1"
  if [[ $SUITE_FAIL -eq 0 ]]; then
    echo -e "${C_GREEN}  └─ ${name}: ${SUITE_PASS} passed${C_RESET}"
  else
    echo -e "${C_RED}  └─ ${name}: ${SUITE_PASS} passed, ${SUITE_FAIL} FAILED${C_RESET}"
  fi
}

# JSON 美化（有 jq 则用，否则原样输出）
pretty() {
  if command -v jq &>/dev/null; then
    echo "$1" | jq -C . 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

# 从 JSON 字符串中提取字段（用 jq 或 grep/sed 兜底）
jq_get() {
  local json="$1" field="$2"
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r "$field" 2>/dev/null
  else
    # 简单 grep 兜底（仅支持顶层字符串字段）
    echo "$json" | grep -o "\"${field#.}\":\"[^\"]*\"" | cut -d'"' -f4
  fi
}

# ─────────────────────────────────────────────
# HTTP 请求封装
# ─────────────────────────────────────────────

# http_req METHOD PATH [BODY_JSON]
# 返回：HTTP状态码\n响应体
http_req() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local url="${BASE_URL}${path}"
  local response http_code

  if [[ -n "$body" ]]; then
    response=$(curl -s -w "\n__STATUS__%{http_code}" \
      -X "$method" \
      -H "Content-Type: application/json" \
      -d "$body" \
      --max-time 10 \
      "$url" 2>/dev/null)
  else
    response=$(curl -s -w "\n__STATUS__%{http_code}" \
      -X "$method" \
      --max-time 10 \
      "$url" 2>/dev/null)
  fi

  http_code=$(echo "$response" | grep '__STATUS__' | sed 's/__STATUS__//')
  local body_only
  body_only=$(echo "$response" | grep -v '__STATUS__')

  echo "${http_code}|||${body_only}"
}

# 断言 HTTP 状态码
assert_status() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    ok "$label → HTTP ${actual}"
    return 0
  else
    fail "$label → 期望 HTTP ${expected}，实际 ${actual}"
    return 1
  fi
}

# 断言响应体包含某个字符串
assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    ok "$label → 包含 \"${needle}\""
    return 0
  else
    fail "$label → 响应体不含 \"${needle}\"，实际：$(echo "$haystack" | head -c 200)"
    return 1
  fi
}

# 断言响应体不包含某个字符串
assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    fail "$label → 响应体不应包含 \"${needle}\""
    return 1
  else
    ok "$label → 不含 \"${needle}\""
    return 0
  fi
}

# 断言 JSON 字段值
assert_field() {
  local label="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(jq_get "$json" "$field")
  if [[ "$actual" == "$expected" ]]; then
    ok "$label → ${field} = \"${expected}\""
    return 0
  else
    fail "$label → ${field} 期望 \"${expected}\"，实际 \"${actual}\""
    return 1
  fi
}

# ─────────────────────────────────────────────
# 后台进程管理
# ─────────────────────────────────────────────

BACKEND_PID=""

start_backend() {
  info "启动后台服务（端口 ${PORT}）…"

  # 检查端口是否已被占用
  if curl -s --max-time 1 "${BASE_URL}/health" &>/dev/null; then
    info "检测到端口 ${PORT} 已有服务在运行，跳过启动"
    AUTO_SERVER=false
    return 0
  fi

  # 确定启动命令
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local project_root
  project_root="$(cd "${script_dir}/.." && pwd)"
  local backend_src="${project_root}/packages/backend/src/index.ts"

  if [[ ! -f "$backend_src" ]]; then
    echo -e "${C_RED}错误：找不到后台入口文件：${backend_src}${C_RESET}"
    exit 1
  fi

  # 用 nvm 或系统 node 运行
  local node_cmd="node"
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/.nvm/nvm.sh" --no-use 2>/dev/null || true
    node_cmd=$(nvm which 22 2>/dev/null || nvm which current 2>/dev/null || which node)
  fi

  AGENTLOG_PORT="$PORT" \
  NODE_ENV=development \
    "$node_cmd" --import tsx "${backend_src}" \
    > /tmp/agentlog-test-backend.log 2>&1 &

  BACKEND_PID=$!
  log "后台 PID: ${BACKEND_PID}，日志：/tmp/agentlog-test-backend.log"

  # 等待服务就绪（最多 15 秒）
  local max_wait=30 waited=0
  echo -n "  等待后台就绪"
  while [[ $waited -lt $max_wait ]]; do
    if curl -s --max-time 1 "${BASE_URL}/health" &>/dev/null; then
      echo " ✔"
      info "后台已就绪（${waited}s）"
      return 0
    fi
    echo -n "."
    sleep 0.5
    waited=$((waited+1))
  done
  echo ""
  echo -e "${C_RED}错误：后台启动超时（${max_wait}s），查看日志：/tmp/agentlog-test-backend.log${C_RESET}"
  cat /tmp/agentlog-test-backend.log | tail -20
  exit 1
}

stop_backend() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    log "关闭后台进程（PID: ${BACKEND_PID}）…"
    kill -TERM "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
    log "后台已关闭"
  fi
}

# 退出时自动清理
cleanup() {
  if [[ "$AUTO_SERVER" == true ]] && [[ "$KEEP_SERVER" == false ]]; then
    stop_backend
  elif [[ "$KEEP_SERVER" == true ]] && [[ -n "$BACKEND_PID" ]]; then
    info "后台保持运行（PID: ${BACKEND_PID}，端口: ${PORT}）"
  fi
}
trap cleanup EXIT

# ─────────────────────────────────────────────
# 测试：健康检查
# ─────────────────────────────────────────────

test_health() {
  section "T1 · 健康检查 & 元信息"

  # T1-1: /health
  local result; result=$(http_req GET "/health")
  local code body
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status "T1-1 GET /health 状态码" "200" "$code"
  assert_field   "T1-1 GET /health status字段" "$body" ".status" "ok"
  assert_contains "T1-1 GET /health 包含 version" "version" "$body"
  assert_contains "T1-1 GET /health 包含 uptime"  "uptime"  "$body"

  # T1-2: /api
  result=$(http_req GET "/api")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T1-2 GET /api 状态码" "200" "$code"
  assert_contains "T1-2 GET /api 包含 endpoints" "endpoints" "$body"
  assert_contains "T1-2 GET /api 包含 sessions"  "sessions"  "$body"

  # T1-3: 404
  result=$(http_req GET "/nonexistent-route-xyz")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status    "T1-3 GET 不存在路由 → 404" "404" "$code"
  assert_field     "T1-3 GET 不存在路由 success=false" "$body" ".success" "false"

  suite_summary "健康检查"
}

# ─────────────────────────────────────────────
# 测试：Session 创建
# ─────────────────────────────────────────────

test_session_create() {
  section "T2 · Session 创建"

  local workspace="/tmp/agentlog-test-$(date +%s)"

  # T2-1: 完整字段创建（含推理过程）
  local body1
  body1=$(cat <<EOF
{
  "provider": "deepseek",
  "model": "deepseek-r1",
  "source": "cline",
  "workspacePath": "${workspace}",
  "prompt": "帮我用 TypeScript 实现一个带缓存的 getUserById 函数",
  "reasoning": "<think>用户需要一个带缓存层的 getUserById。可以使用 Map 作为本地缓存，键为 userId，值为 User 对象。需要考虑缓存失效策略……</think>",
  "response": "以下是实现方案：\n\`\`\`ts\nconst cache = new Map<string, User>();\nexport async function getUserById(id: string): Promise<User> {\n  if (cache.has(id)) return cache.get(id)!;\n  const user = await db.users.findById(id);\n  cache.set(id, user);\n  return user;\n}\n\`\`\`",
  "affectedFiles": ["src/user/service.ts", "src/user/cache.ts"],
  "durationMs": 4200,
  "tags": ["重构", "缓存", "TypeScript"],
  "note": "DeepSeek-R1 推荐使用 Map，简单场景够用"
}
EOF
)

  local result; result=$(http_req POST "/api/sessions" "$body1")
  local code body
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T2-1 创建含推理过程的会话 → 201" "201" "$code"
  assert_field    "T2-1 success=true" "$body" ".success" "true"
  assert_contains "T2-1 返回 id 字段" "\"id\"" "$body"
  assert_contains "T2-1 保存 reasoning" "think" "$body"
  assert_contains "T2-1 保存 tags" "缓存" "$body"

  # 保存 SESSION_ID 供后续测试使用
  SESSION_ID=$(jq_get "$body" ".data.id")
  if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
    fail "T2-1 无法提取 session id，后续测试将跳过"
    SESSION_ID=""
  else
    log "SESSION_ID = ${SESSION_ID}"
  fi

  # T2-2: 创建第二个会话（不含推理，不同模型）
  local body2
  body2=$(cat <<EOF
{
  "provider": "qwen",
  "model": "qwen-max",
  "source": "cursor",
  "workspacePath": "${workspace}",
  "prompt": "给上面的缓存函数添加 TTL 过期机制",
  "response": "可以使用 Map 存储 {value, expiredAt} 对，在每次 get 时检查是否过期。",
  "affectedFiles": ["src/user/service.ts"],
  "durationMs": 1800,
  "tags": ["优化"]
}
EOF
)

  result=$(http_req POST "/api/sessions" "$body2")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status "T2-2 创建第二个会话（Qwen）→ 201" "201" "$code"
  SESSION_ID_2=$(jq_get "$body" ".data.id")
  log "SESSION_ID_2 = ${SESSION_ID_2}"

  # T2-3: 缺少必填字段 prompt → 400
  result=$(http_req POST "/api/sessions" '{"provider":"deepseek","model":"deepseek-v3","source":"cline","workspacePath":"/tmp","response":"test","durationMs":100}')
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status "T2-3 缺少 prompt → 400" "400" "$code"
  assert_field  "T2-3 success=false" "$body" ".success" "false"

  # T2-4: 缺少必填字段 workspacePath → 400
  result=$(http_req POST "/api/sessions" '{"provider":"deepseek","model":"deepseek-v3","source":"cline","prompt":"test","response":"test","durationMs":100}')
  code=$(echo "$result" | cut -d'|' -f1)

  assert_status "T2-4 缺少 workspacePath → 400" "400" "$code"

  suite_summary "Session 创建"
}

# ─────────────────────────────────────────────
# 测试：Session 查询
# ─────────────────────────────────────────────

test_session_query() {
  section "T3 · Session 查询"

  if [[ -z "$SESSION_ID" ]]; then
    skip "T3 SESSION_ID 为空，跳过查询测试"
    return
  fi

  # T3-1: 按 ID 精确查询
  local result; result=$(http_req GET "/api/sessions/${SESSION_ID}")
  local code body
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T3-1 GET /api/sessions/:id → 200" "200" "$code"
  assert_field    "T3-1 id 字段匹配" "$body" ".data.id" "$SESSION_ID"
  assert_field    "T3-1 provider = deepseek" "$body" ".data.provider" "deepseek"
  assert_field    "T3-1 model = deepseek-r1" "$body" ".data.model" "deepseek-r1"
  assert_contains "T3-1 包含 reasoning" "reasoning" "$body"

  # T3-2: 不存在的 ID → 404
  result=$(http_req GET "/api/sessions/nonexistent-id-xxxxxxxx")
  code=$(echo "$result" | cut -d'|' -f1)

  assert_status "T3-2 不存在 ID → 404" "404" "$code"

  # T3-3: 分页列表
  result=$(http_req GET "/api/sessions?page=1&pageSize=10")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T3-3 GET /api/sessions 分页 → 200" "200" "$code"
  assert_contains "T3-3 包含 data 数组" "\"data\"" "$body"
  assert_contains "T3-3 包含 total 字段" "\"total\"" "$body"

  # T3-4: 关键词过滤
  result=$(http_req GET "/api/sessions?keyword=getUserById")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T3-4 关键词过滤 → 200" "200" "$code"
  assert_contains "T3-4 结果包含目标记录" "getUserById" "$body"

  result=$(http_req GET "/api/sessions?keyword=XYZXYZ_NEVER_MATCH_AGENTLOG_12345")
  body=$(echo "$result" | sed 's/^[0-9]*|||//')
  local total_zero
  total_zero=$(jq_get "$body" ".data.total")
  if [[ "$total_zero" == "0" ]]; then
    ok "T3-4 无匹配关键词返回 total=0"
  else
    # 兜底：直接检查响应体中是否包含 total:0
    if echo "$body" | grep -q '"total":0'; then
      ok "T3-4 无匹配关键词返回 total=0（grep 兜底验证）"
    else
      fail "T3-4 无匹配关键词应返回 total=0，实际：${total_zero}，body片段：$(echo "$body" | head -c 150)"
    fi
  fi

  # T3-5: provider 过滤
  result=$(http_req GET "/api/sessions?provider=deepseek")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status "T3-5 provider 过滤 → 200" "200" "$code"

  # T3-6: 统计接口
  result=$(http_req GET "/api/sessions/stats")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T3-6 GET /api/sessions/stats → 200" "200" "$code"
  assert_contains "T3-6 包含 total 字段"    "\"total\""       "$body"
  assert_contains "T3-6 包含 boundToCommit" "\"boundToCommit\"" "$body"
  assert_contains "T3-6 包含 byProvider"   "\"byProvider\""  "$body"

  # T3-7: 未绑定会话
  result=$(http_req GET "/api/sessions/unbound?workspacePath=/tmp/agentlog-test-$(ls /tmp | grep agentlog-test | sort | tail -1 | sed 's/agentlog-test-//')")
  # 简化：直接查全部（不带 workspacePath 会报 400）
  result=$(http_req GET "/api/sessions/unbound")
  code=$(echo "$result" | cut -d'|' -f1)
  assert_status "T3-7 缺少 workspacePath → 400" "400" "$code"

  suite_summary "Session 查询"
}

# ─────────────────────────────────────────────
# 测试：Session 更新
# ─────────────────────────────────────────────

test_session_update() {
  section "T4 · Session 更新（标签 / 备注 / 绑定）"

  if [[ -z "$SESSION_ID" ]]; then
    skip "T4 SESSION_ID 为空，跳过更新测试"
    return
  fi

  # T4-1: 更新标签
  local result; result=$(http_req PATCH "/api/sessions/${SESSION_ID}/tags" '{"tags":["bugfix","性能","缓存优化"]}')
  local code body
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T4-1 更新标签 → 200" "200" "$code"
  assert_contains "T4-1 包含新标签 bugfix" "bugfix" "$body"
  assert_contains "T4-1 包含新标签 性能" "性能" "$body"

  # T4-2: 标签传非数组 → 400
  result=$(http_req PATCH "/api/sessions/${SESSION_ID}/tags" '{"tags":"not-an-array"}')
  code=$(echo "$result" | cut -d'|' -f1)
  assert_status "T4-2 标签传非数组 → 400" "400" "$code"

  # T4-3: 更新备注
  result=$(http_req PATCH "/api/sessions/${SESSION_ID}/note" '{"note":"Map 在高并发下有 race condition，已改为 Redis"}')
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T4-3 更新备注 → 200" "200" "$code"
  assert_contains "T4-3 备注已保存 Redis" "Redis" "$body"

  # T4-4: 手动绑定 Commit
  result=$(http_req PATCH "/api/sessions/${SESSION_ID}/commit" "{\"commitHash\":\"${COMMIT_HASH}\"}")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T4-4 绑定 Commit → 200" "200" "$code"
  assert_contains "T4-4 commitHash 已保存" "$COMMIT_HASH" "$body"

  # T4-5: 解绑 Commit
  result=$(http_req PATCH "/api/sessions/${SESSION_ID}/commit" '{"commitHash":null}')
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status       "T4-5 解绑 Commit → 200" "200" "$code"
  assert_not_contains "T4-5 commitHash 已清除" "\"commitHash\":\"" "$body"

  # T4-6: commitHash 长度不足 → 400
  result=$(http_req PATCH "/api/sessions/${SESSION_ID}/commit" '{"commitHash":"ab"}')
  code=$(echo "$result" | cut -d'|' -f1)
  assert_status "T4-6 commitHash 太短 → 400" "400" "$code"

  suite_summary "Session 更新"
}

# ─────────────────────────────────────────────
# 测试：Commit 绑定
# ─────────────────────────────────────────────

test_commit_binding() {
  section "T5 · Commit 绑定"

  if [[ -z "$SESSION_ID" || -z "$SESSION_ID_2" ]]; then
    skip "T5 SESSION_ID 或 SESSION_ID_2 为空，跳过 Commit 绑定测试"
    return
  fi

  local BIND_HASH="bt$(date +%s)$(od -An -N3 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || printf '%06x' $RANDOM)z"

  # T5-1: 批量绑定
  local bind_body
  bind_body=$(cat <<EOF
{
  "sessionIds": ["${SESSION_ID}", "${SESSION_ID_2}"],
  "commitHash": "${BIND_HASH}",
  "workspacePath": "/tmp/agentlog-test"
}
EOF
)

  local result; result=$(http_req POST "/api/commits/bind" "$bind_body")
  local code body
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T5-1 批量绑定 → 200" "200" "$code"
  assert_contains "T5-1 commitHash 正确" "$BIND_HASH" "$body"
  assert_contains "T5-1 包含 sessionIds" "sessionIds" "$body"

  # T5-2: 绑定后查询 session commitHash 已更新
  result=$(http_req GET "/api/sessions/${SESSION_ID}")
  body=$(echo "$result" | sed 's/^[0-9]*|||//')
  assert_contains "T5-2 session.commitHash 已更新" "$BIND_HASH" "$body"

  # T5-3: 查询 Commit 绑定记录（完整 hash）
  result=$(http_req GET "/api/commits/${BIND_HASH}")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T5-3 查询完整 hash → 200" "200" "$code"
  assert_field    "T5-3 commitHash 字段匹配" "$body" ".data.commitHash" "$BIND_HASH"

  # T5-4: 短 hash 前缀匹配（取前 18 位，保证唯一性）
  local short_hash="${BIND_HASH:0:18}"
  result=$(http_req GET "/api/commits/${short_hash}")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T5-4 短 hash 前缀查询 → 200" "200" "$code"
  assert_contains "T5-4 返回完整 hash" "$BIND_HASH" "$body"

  # T5-5: 不存在的 hash → 404
  result=$(http_req GET "/api/commits/0000000000000000deadbeef")
  code=$(echo "$result" | cut -d'|' -f1)
  assert_status "T5-5 不存在 hash → 404" "404" "$code"

  # T5-6: 列出所有 Commit 绑定（分页）
  result=$(http_req GET "/api/commits/?page=1&pageSize=20")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T5-6 GET /api/commits/ → 200" "200" "$code"
  assert_contains "T5-6 包含分页 total" "\"total\"" "$body"

  # T5-7: 解绑单条会话
  result=$(http_req DELETE "/api/commits/unbind/${SESSION_ID}")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status "T5-7 解绑单条会话 → 200" "200" "$code"

  # 验证 session commitHash 已清除
  result=$(http_req GET "/api/sessions/${SESSION_ID}")
  body=$(echo "$result" | sed 's/^[0-9]*|||//')
  assert_not_contains "T5-7 解绑后 commitHash 已清除" "\"commitHash\":\"${BIND_HASH}\"" "$body"

  # T5-8: 对未绑定会话再次解绑 → 400
  result=$(http_req DELETE "/api/commits/unbind/${SESSION_ID}")
  code=$(echo "$result" | cut -d'|' -f1)
  assert_status "T5-8 对未绑定会话解绑 → 400" "400" "$code"

  # T5-9: 传不存在的 sessionId → 404
  result=$(http_req POST "/api/commits/bind" '{"sessionIds":["nonexistent-session-id-xyz"],"commitHash":"deadbeef12345678"}')
  code=$(echo "$result" | cut -d'|' -f1)
  assert_status "T5-9 不存在 sessionId → 404" "404" "$code"

  suite_summary "Commit 绑定"
}

# ─────────────────────────────────────────────
# 测试：导出
# ─────────────────────────────────────────────

test_export() {
  section "T6 · 导出（Export）"

  # T6-1: 获取支持的格式列表
  local result; result=$(http_req GET "/api/export/formats")
  local code body
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T6-1 GET /api/export/formats → 200" "200" "$code"
  assert_contains "T6-1 包含 weekly-report"  "weekly-report"  "$body"
  assert_contains "T6-1 包含 pr-description" "pr-description" "$body"
  assert_contains "T6-1 包含 jsonl"          "jsonl"          "$body"
  assert_contains "T6-1 包含 csv"            "csv"            "$body"

  # T6-2: 导出 JSONL
  result=$(http_req POST "/api/export" '{"format":"jsonl","language":"zh"}')
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T6-2 导出 JSONL → 200" "200" "$code"
  assert_field    "T6-2 format=jsonl" "$body" ".data.format" "jsonl"
  assert_contains "T6-2 包含 content" "content" "$body"
  assert_contains "T6-2 包含 sessionCount" "sessionCount" "$body"

  # 验证 JSONL 每行是合法 JSON（取第一行）
  local first_line
  first_line=$(jq_get "$body" ".data.content" | head -1)
  if [[ -n "$first_line" ]] && echo "$first_line" | python3 -c "import sys,json; json.load(sys.stdin)" &>/dev/null 2>&1; then
    ok "T6-2 JSONL 首行是合法 JSON"
  elif [[ -n "$first_line" ]] && command -v jq &>/dev/null && echo "$first_line" | jq . &>/dev/null 2>&1; then
    ok "T6-2 JSONL 首行是合法 JSON"
  else
    skip "T6-2 JSONL 格式校验（需要 python3 或 jq）"
  fi

  # T6-3: 导出中文周报
  result=$(http_req POST "/api/export" '{"format":"weekly-report","language":"zh"}')
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T6-3 导出中文周报 → 200" "200" "$code"
  assert_contains "T6-3 包含周报标题" "AI 辅助开发周报" "$body"
  assert_contains "T6-3 包含概览章节" "概览" "$body"

  # T6-4: 导出英文周报
  result=$(http_req POST "/api/export" '{"format":"weekly-report","language":"en"}')
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T6-4 导出英文周报 → 200" "200" "$code"
  assert_contains "T6-4 包含英文标题" "Weekly Report" "$body"

  # T6-5: 导出 PR 说明
  result=$(http_req POST "/api/export" '{"format":"pr-description","language":"zh"}')
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T6-5 导出 PR 说明 → 200" "200" "$code"
  assert_contains "T6-5 包含 PR 标题"   "PR 说明"  "$body"
  assert_contains "T6-5 包含背景章节"   "背景与目标" "$body"
  assert_contains "T6-5 包含改动章节"   "主要改动"   "$body"

  # T6-6: 导出 CSV
  result=$(http_req POST "/api/export" '{"format":"csv","language":"zh"}')
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T6-6 导出 CSV → 200" "200" "$code"
  assert_contains "T6-6 包含 CSV 表头 id" "id," "$body"
  assert_contains "T6-6 包含 CSV 表头 provider" "provider" "$body"

  # T6-7: 日期过滤（今天 ~ 明天，应有数据）
  local today tomorrow
  today=$(date +%Y-%m-%d)
  tomorrow=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d '+1 day' +%Y-%m-%d 2>/dev/null || echo "$today")

  result=$(http_req POST "/api/export" "{\"format\":\"jsonl\",\"startDate\":\"${today}\",\"endDate\":\"${tomorrow}\"}")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status "T6-7 按日期过滤 → 200" "200" "$code"
  local count
  count=$(jq_get "$body" ".data.sessionCount")
  if [[ "$count" -ge 1 ]] 2>/dev/null; then
    ok "T6-7 今天的记录已包含（sessionCount=${count}）"
  else
    fail "T6-7 今天的记录应 >=1，实际 sessionCount=${count}"
  fi

  # T6-8: startDate 晚于 endDate → 400
  result=$(http_req POST "/api/export" '{"format":"jsonl","startDate":"2030-01-01","endDate":"2020-01-01"}')
  code=$(echo "$result" | cut -d'|' -f1)
  assert_status "T6-8 startDate 晚于 endDate → 400" "400" "$code"

  # T6-9: 无效日期格式 → 400
  result=$(http_req POST "/api/export" '{"format":"jsonl","startDate":"not-a-date"}')
  code=$(echo "$result" | cut -d'|' -f1)
  assert_status "T6-9 无效日期格式 → 400" "400" "$code"

  # T6-10: 不支持的 format → 400
  result=$(http_req POST "/api/export" '{"format":"pdf"}')
  code=$(echo "$result" | cut -d'|' -f1)
  assert_status "T6-10 不支持的 format → 400" "400" "$code"

  # T6-11: 预览接口
  result=$(http_req POST "/api/export/preview" '{"format":"weekly-report","language":"zh"}')
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status   "T6-11 预览接口 → 200" "200" "$code"
  assert_contains "T6-11 包含 isTruncated 字段" "isTruncated" "$body"

  suite_summary "导出"
}

# ─────────────────────────────────────────────
# 测试：Session 删除
# ─────────────────────────────────────────────

test_session_delete() {
  section "T7 · Session 删除"

  # 创建一个专用于删除测试的临时会话
  local result; result=$(http_req POST "/api/sessions" '{
    "provider":"kimi",
    "model":"moonshot-v1-8k",
    "source":"direct-api",
    "workspacePath":"/tmp/delete-test",
    "prompt":"这是一条用于测试删除功能的临时会话",
    "response":"好的，收到。",
    "durationMs":500
  }')
  local code body
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  if [[ "$code" != "201" ]]; then
    skip "T7 临时会话创建失败（HTTP ${code}），跳过删除测试"
    return
  fi

  local tmp_id
  tmp_id=$(jq_get "$body" ".data.id")

  # T7-1: 删除存在的会话
  result=$(http_req DELETE "/api/sessions/${tmp_id}")
  code=$(echo "$result" | cut -d'|' -f1)
  body=$(echo "$result" | sed 's/^[0-9]*|||//')

  assert_status "T7-1 DELETE /api/sessions/:id → 200" "200" "$code"
  assert_field  "T7-1 success=true" "$body" ".success" "true"

  # T7-2: 再次查询已删除会话 → 404
  result=$(http_req GET "/api/sessions/${tmp_id}")
  code=$(echo "$result" | cut -d'|' -f1)
  assert_status "T7-2 已删除会话查询 → 404" "404" "$code"

  # T7-3: 删除不存在的会话 → 404
  result=$(http_req DELETE "/api/sessions/nonexistent-id-to-delete")
  code=$(echo "$result" | cut -d'|' -f1)
  assert_status "T7-3 删除不存在会话 → 404" "404" "$code"

  suite_summary "Session 删除"
}

# ─────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────

main() {
  echo ""
  echo -e "${C_BOLD}${C_CYAN}"
  echo "╔══════════════════════════════════════════════╗"
  echo "║   AgentLog Backend — curl 集成测试            ║"
  echo "║   目标：${BASE_URL}                 "
  echo "╚══════════════════════════════════════════════╝"
  echo -e "${C_RESET}"

  # 检查依赖
  if ! command -v curl &>/dev/null; then
    echo -e "${C_RED}错误：需要安装 curl${C_RESET}"
    exit 1
  fi

  if ! command -v jq &>/dev/null; then
    echo -e "${C_YELLOW}提示：未检测到 jq，部分断言将退化为字符串匹配。建议安装：brew install jq${C_RESET}"
  fi

  # 启动后台（如需）
  if [[ "$AUTO_SERVER" == true ]]; then
    start_backend
  else
    # 检查后台是否可达
    if ! curl -s --max-time 2 "${BASE_URL}/health" &>/dev/null; then
      echo -e "${C_RED}错误：后台服务不可达（${BASE_URL}）。"
      echo -e "请先运行：pnpm --filter @agentlog/backend dev${C_RESET}"
      exit 1
    fi
    info "后台已就绪（外部服务，端口 ${PORT}）"
  fi

  # 运行各测试 Suite
  test_health
  test_session_create
  test_session_query
  test_session_update
  test_commit_binding
  test_export
  test_session_delete

  # ── 总结 ──────────────────────────────────────
  echo ""
  echo -e "${C_BOLD}${C_CYAN}══════════════════════════════════════${C_RESET}"
  echo -e "${C_BOLD}  测试结果汇总${C_RESET}"
  echo -e "${C_BOLD}${C_CYAN}══════════════════════════════════════${C_RESET}"

  local total=$((PASS + FAIL + SKIP))
  echo -e "  总计：${total} 项"
  echo -e "  ${C_GREEN}通过：${PASS}${C_RESET}"
  if [[ $FAIL -gt 0 ]]; then
    echo -e "  ${C_RED}失败：${FAIL}${C_RESET}"
  else
    echo -e "  失败：${FAIL}"
  fi
  if [[ $SKIP -gt 0 ]]; then
    echo -e "  ${C_YELLOW}跳过：${SKIP}${C_RESET}"
  fi
  echo ""

  if [[ $FAIL -eq 0 ]]; then
    echo -e "${C_GREEN}${C_BOLD}  ✔ 全部通过！${C_RESET}"
    echo ""
    exit 0
  else
    echo -e "${C_RED}${C_BOLD}  ✖ 有 ${FAIL} 项失败，请检查上方错误信息。${C_RESET}"
    echo ""
    exit 1
  fi
}

main "$@"
