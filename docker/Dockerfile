# ─────────────────────────────────────────────────────────────────────────────
# AgentLog Backend Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# 多阶段构建：
#   1. builder — 构建 TypeScript、esbuild 打包
#   2. runtime — 运行阶段，基于 Alpine Linux（轻量 ~150MB）
#
# 构建方式：
#   docker build -t agentlog:latest -f docker/Dockerfile .
#
# 多平台构建（需要 BuildKit）：
#   docker buildx build --platform linux/amd64,linux/arm64 ...
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# 安装构建依赖
# - python3/g++: better-sqlite3 原生模块编译
# - git: pnpm 需要
RUN apk add --no-cache python3 make g++ git

# 复制 package 文件
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

# 安装 pnpm 并下载依赖
RUN corepack enable && pnpm install --frozen-lockfile

# 复制源代码
COPY packages/shared/src ./packages/shared/src/
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/backend/src ./packages/backend/src/
COPY packages/backend/tsconfig.json ./packages/backend/tsconfig.json
COPY packages/backend/build.mjs ./packages/backend/build.mjs

# 构建 shared 包
RUN pnpm build:shared

# 构建 backend 包（esbuild 打包 + native 模块）
RUN cd packages/backend && pnpm build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# 安装运行时依赖（SQLite 运行时）
RUN apk add --no-cache dumb-init sqlite

# 创建非 root 用户
RUN addgroup -g 1001 agentlog && \
    adduser -D -u 1001 -G agentlog agentlog

WORKDIR /app

# 从 builder 复制构建产物
COPY --from=builder /app/packages/backend/dist ./dist
COPY --from=builder /app/packages/shared/dist ./shared/dist

# 预装 native modules（better-sqlite3 等）
COPY --from=builder /app/node_modules ./node_modules

# 复制启动脚本
COPY docker/start.sh ./start.sh
COPY docker/mcp-start.sh ./mcp-start.sh
RUN chmod +x start.sh mcp-start.sh

# 安装 agentlog-mcp 全局命令
# 将 dist/mcp.js 链接到 PATH 中
RUN ln -s /app/dist/mcp.js /usr/local/bin/agentlog-mcp && \
    chmod +x /app/dist/mcp.js

# 创建数据目录
RUN mkdir -p /data && chown -R agentlog:agentlog /data

# 切换到非 root 用户
USER agentlog

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:7892/health || exit 1

# 默认端口
EXPOSE 7892

# 默认启动 HTTP API 服务
ENTRYPOINT ["./start.sh"]
