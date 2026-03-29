#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# AgentLog HTTP API 服务启动脚本
# ─────────────────────────────────────────────────────────────────────────────
# 默认配置（可通过环境变量覆盖）：
#   AGENTLOG_PORT      监听端口（默认 7892）
#   AGENTLOG_HOST      监听地址（默认 127.0.0.1，生产环境应为 0.0.0.0）
#   AGENTLOG_DB_PATH   SQLite 数据库路径（默认 /data/agentlog.db）
#   NODE_ENV           运行环境（默认 production）
# ─────────────────────────────────────────────────────────────────────────────

set -e

# 默认值
export NODE_ENV="${NODE_ENV:-production}"
export AGENTLOG_PORT="${AGENTLOG_PORT:-7892}"
export AGENTLOG_HOST="${AGENTLOG_HOST:-0.0.0.0}"
export AGENTLOG_DB_PATH="${AGENTLOG_DB_PATH:-/data/agentlog.db}"

# 确保数据目录存在
mkdir -p "$(dirname "$AGENTLOG_DB_PATH")"

echo "[AgentLog] 启动 HTTP API 服务..."
echo "[AgentLog] 端口: $AGENTLOG_PORT"
echo "[AgentLog] 主机: $AGENTLOG_HOST"
echo "[AgentLog] 数据库: $AGENTLOG_DB_PATH"
echo "[AgentLog] 环境: $NODE_ENV"
echo ""

# 启动服务
exec node /app/dist/index.js
