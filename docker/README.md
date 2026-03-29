-# AgentLog Docker 部署指南

本目录提供 Docker 部署方案，支持多平台（Linux/macOS/Windows），无需安装 Node.js 即可运行 AgentLog 后台服务。

## 快速开始

### 1. 构建镜像

```bash
# 在项目根目录执行
docker build -t agentlog:latest -f docker/Dockerfile .
```

### 2. 启动服务（HTTP API）

```bash
# 创建数据目录
mkdir -p docker/data

# 启动服务
docker run -d \
  --name agentlog \
  -p 7892:7892 \
  -v $(pwd)/docker/data:/data \
  agentlog:latest
```

### 3. 验证服务

```bash
curl http://localhost:7892/health
```

预期输出：
```json
{
  "status": "ok",
  "version": "0.1.0",
  "timestamp": "2026-03-29T12:00:00.000Z",
  "uptime": 10
}
```

## 使用 Docker Compose

### 启动服务

```bash
cd docker
cp .env.example .env
docker-compose up -d
```

### 查看日志

```bash
docker-compose logs -f
```

### 停止服务

```bash
docker-compose down
```

### 完全清除数据

```bash
docker-compose down -v
rm -rf data
```

## MCP Server 使用

MCP Server 通过 stdio 模式与 AI Agent 通信，适用于 Cline、Cursor、OpenCode 等 MCP 客户端。

### 方式一：直接运行

```bash
docker run --rm -i agentlog:latest mcp
```

### 方式二：配置到 Agent

在 AI Agent 的 MCP 配置文件中添加：

**Cline (settings.json)**
```json
{
  "mcpServers": {
    "agentlog": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "agentlog:latest", "mcp"],
      "env": {
        "AGENTLOG_HOST": "host.docker.internal:7892"
      }
    }
  }
}
```

**OpenCode (mcp-servers.json)**
```json
{
  "mcpServers": {
    "agentlog": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "agentlog:latest", "mcp"],
      "env": {
        "AGENTLOG_HOST": "host.docker.internal:7892"
      }
    }
  }
}
```

### 方式三：使用 Docker Compose（推荐）

```bash
cd docker
docker-compose --profile mcp run --rm agentlog-mcp
```

## 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENTLOG_PORT` | 7892 | HTTP API 监听端口 |
| `AGENTLOG_HOST` | 0.0.0.0 | HTTP API 监听地址 |
| `AGENTLOG_DB_PATH` | /data/agentlog.db | SQLite 数据库路径 |
| `AGENTLOG_DATA_PATH` | ./data | 宿主机数据目录（docker-compose） |

### 数据持久化

数据存储在 Docker Volume 中，容器删除后数据不会丢失。

```bash
# 查看数据卷
docker volume ls | grep agentlog

# 备份数据
docker run --rm -v agentlog_agentlog-data:/data -v $(pwd):/backup alpine tar czf /backup/agentlog-backup.tar.gz -C /data .

# 恢复数据
docker run --rm -v agentlog_agentlog-data:/data -v $(pwd):/backup alpine tar xzf /backup/agentlog-backup.tar.gz -C /data
```

## 多平台构建

### 本地构建多平台镜像

需要启用 Docker BuildKit：

```bash
export DOCKER_BUILDKIT=1

docker buildx create --use
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t agentlog:latest \
  -f docker/Dockerfile ..
```

### 推送到镜像仓库

```bash
# 登录 GitHub Container Registry
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# 推送镜像
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/USERNAME/agentlog:latest \
  -f docker/Dockerfile \
  --push ..
```

## 健康检查

服务健康状态可通过以下端点检查：

```bash
# HTTP API 健康检查
curl http://localhost:7892/health

# 服务状态（包含内存使用）
curl http://localhost:7892/api/status
```

## 故障排查

### 端口冲突

如果 7892 端口已被占用：

```bash
# 使用其他端口
docker run -d -p 8899:7892 agentlog:latest
# 然后配置 Agent 使用 8899 端口
```

### 查看日志

```bash
# 实时日志
docker logs -f agentlog

# 最近 100 行
docker logs --tail 100 agentlog
```

### 进入容器调试

```bash
docker exec -it agentlog sh
```

### 权限问题

如果遇到数据目录权限问题：

```bash
# 修改数据目录权限
sudo chown -R 1000:1000 docker/data
```

## 卸载

```bash
# 停止并删除容器
docker stop agentlog && docker rm agentlog

# 删除镜像
docker rmi agentlog:latest

# 删除数据（可选）
rm -rf docker/data
```
