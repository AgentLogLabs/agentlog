#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# AgentLog MCP Server 启动脚本（stdio 模式）
# ─────────────────────────────────────────────────────────────────────────────
# MCP Server 通过 stdin/stdout 与 AI Agent 通信
# 
# 配置（通过环境变量）：
#   AGENTLOG_PORT      HTTP API 端口（默认 7892）
#   AGENTLOG_HOST      HTTP API 主机（默认 localhost:7892）
#   AGENTLOG_DB_PATH   SQLite 数据库路径（默认 /data/agentlog.db）
#
# 使用方式：
#   docker run --rm -i agentlog-mcp mcp
#   或在 AI Agent 的 MCP 配置中：
#   {
#     "command": "docker",
#     "args": ["run", "--rm", "-i", "agentlog:latest", "mcp"]
#   }
# ─────────────────────────────────────────────────────────────────────────────

set -e

# MCP Server 通过 HTTP 与 Backend 通信
export AGENTLOG_PORT="${AGENTLOG_PORT:-7892}"
export AGENTLOG_HOST="${AGENTLOG_HOST:-localhost:7892}"
export AGENTLOG_DB_PATH="${AGENTLOG_DB_PATH:-/data/agentlog.db}"
export AGENTLOG_BACKEND_URL="http://${AGENTLOG_HOST}"
export NODE_ENV="${NODE_ENV:-production}"

# 确保数据目录存在
mkdir -p "$(dirname "$AGENTLOG_DB_PATH")"

echo "[AgentLog MCP] 启动 MCP Server..."
echo "[AgentLog MCP] Backend: $AGENTLOG_BACKEND_URL"
echo "[AgentLog MCP] 数据库: $AGENTLOG_DB_PATH"

# MCP Server 不需要健康检查，直接启动
exec agentlog-mcp
