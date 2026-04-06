#!/bin/bash
# Phase 1 E2E 快速验证脚本
set -e
BASE_URL="${AGENTLOG_URL:-http://localhost:7892}"
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }

echo "=== Phase 1 E2E 快速验证 ==="

# 1. Health
echo -e "\n📋 Health Check"
curl -s "$BASE_URL/health" | grep -q "ok" && pass "Backend 健康" || fail "Backend 无响应"

# 2. Create Trace
echo -e "\n📋 Create Trace"
TRACE=$(curl -s -X POST "$BASE_URL/api/traces" -H "Content-Type: application/json" \
  -d '{"taskGoal":"E2E Quick Test"}')
TRACE_ID=$(echo $TRACE | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[ -n "$TRACE_ID" ] && pass "Trace 创建成功: ${TRACE_ID:0:16}..." || fail "Trace 创建失败"

# 3. Create Span
echo -e "\n📋 Create Span"
curl -s -X POST "$BASE_URL/api/spans" -H "Content-Type: application/json" \
  -d "{\"traceId\":\"$TRACE_ID\",\"actorType\":\"agent\",\"actorName\":\"Test\",\"payload\":{}}" | \
  grep -q "success" && pass "Span 创建成功" || fail "Span 创建失败"

# 4. Summary
echo -e "\n📋 Trace Summary"
curl -s "$BASE_URL/api/traces/$TRACE_ID/summary" | \
  grep -q "agentSpans" && pass "Summary API 正常" || fail "Summary API 失败"

# 5. Diff
echo -e "\n📋 Trace Diff"
curl -s "$BASE_URL/api/traces/$TRACE_ID/diff" | \
  grep -q "spanTree" && pass "Diff API 正常" || fail "Diff API 失败"

# 6. Search
echo -e "\n📋 Search"
curl -s "$BASE_URL/api/traces/search?keyword=E2E" | \
  grep -q "success" && pass "Search API 正常" || fail "Search API 失败"

# 7. Git Hook Install
echo -e "\n📋 Git Hook Install"
mkdir -p /tmp/e2e-test-repo && cd /tmp/e2e-test-repo && git init -q 2>/dev/null
curl -s -X POST "$BASE_URL/api/hooks/install" -H "Content-Type: application/json" \
  -d '{"workspacePath":"/tmp/e2e-test-repo"}' | \
  grep -q "success" && pass "Git Hook 安装成功" || fail "Git Hook 安装失败"

echo -e "\n=========================================="
echo "📊 结果: $PASS 通过, $FAIL 失败"
[ $FAIL -eq 0 ] && echo "✅ 全部通过!" || echo "⚠️ 有失败项"
echo "=========================================="
