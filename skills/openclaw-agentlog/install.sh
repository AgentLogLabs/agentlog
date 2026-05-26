#!/usr/bin/env bash
#
# openclaw-agentlog 安装脚本
# 用于在 OpenClaw Gateway 主机上安装/更新 openclaw-agentlog 插件
#
# 功能:
# 1. 备份 OpenClaw 配置
# 2. 同步 openclaw-agentlog 插件到远程
# 3. 执行热补丁 (patch_dist.py)
# 4. 重启 OpenClaw Gateway
#
# 用法:
#   ./install.sh [--remote HOST] [--skip-restart]
#
# 选项:
#   --remote HOST     远程主机 (默认: myclaw)
#   --skip-restart   跳过 Gateway 重启
#   --rollback        回滚到备份版本
#

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 默认配置
REMOTE_HOST="myclaw"
SKIP_RESTART=false
ROLLBACK=false
PLUGIN_NAME="openclaw-agentlog"
OPENCLAW_EXTENSIONS_DIR="~/.openclaw/extensions"
OPENCLAW_DIST_DIR="/home/hobo/.npm-global/lib/node_modules/openclaw/dist"
PATCH_SCRIPT="/tmp/patch_dist.py"
BACKUP_BASE_DIR="/home/hobo/.npm-global/lib/node_modules/openclaw"

# 解析命令行参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --remote)
            REMOTE_HOST="$2"
            shift 2
            ;;
        --skip-restart)
            SKIP_RESTART=true
            shift
            ;;
        --rollback)
            ROLLBACK=true
            shift
            ;;
        *)
            echo "未知选项: $1"
            echo "用法: $0 [--remote HOST] [--skip-restart] [--rollback]"
            exit 1
            ;;
    esac
done

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查本地插件目录
check_local_plugin() {
    local plugin_dir="$(cd "$(dirname "$0")" && pwd)"
    if [[ ! -d "$plugin_dir" ]]; then
        log_error "插件目录不存在: $plugin_dir"
        exit 1
    fi
    
    if [[ ! -f "$plugin_dir/patch_dist.py" ]]; then
        log_error "patch_dist.py 不存在于: $plugin_dir"
        exit 1
    fi
    
    echo "$plugin_dir"
}

# 备份 OpenClaw 配置
backup_openclaw_config() {
    log_info "备份 OpenClaw 配置..."
    
    ssh "$REMOTE_HOST" "mkdir -p ~/.openclaw/backup && cp ~/.openclaw/openclaw.json ~/.openclaw/backup/openclaw.json.bak_\$(date +%Y%m%d_%H%M%S)"
    
    log_info "配置已备份到 ~/.openclaw/backup/"
}

# 备份 OpenClaw dist 文件
backup_openclaw_dist() {
    log_info "备份 OpenClaw dist 文件..."
    
    local backup_dir="${BACKUP_BASE_DIR}/dist_backup_$(date +%Y%m%d_%H%M%S)"
    ssh "$REMOTE_HOST" "cp -r ${OPENCLAW_DIST_DIR} ${backup_dir}"
    
    log_info "Dist 文件已备份到: $backup_dir"
}

# 同步插件到远程
sync_plugin() {
    log_info "同步 $PLUGIN_NAME 插件到远程..."
    
    ssh "$REMOTE_HOST" "mkdir -p ${OPENCLAW_EXTENSIONS_DIR}"
    
    rsync -avz --exclude='node_modules' --exclude='dist' --exclude='.git' \
        "$(check_local_plugin)/" \
        "${REMOTE_HOST}:${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_NAME}/"
    
    log_info "插件同步完成"
}

# 安装依赖
install_dependencies() {
    log_info "安装插件依赖..."
    
    ssh "$REMOTE_HOST" "cd ${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_NAME} && npm install 2>&1"
    
    log_info "依赖安装完成"
}

# 执行热补丁
apply_patch() {
    log_info "执行热补丁..."
    
    # 先同步最新的 patch_dist.py
    rsync -avz "$(check_local_plugin)/patch_dist.py" "${REMOTE_HOST}:${PATCH_SCRIPT}"
    
    # 执行补丁脚本
    ssh "$REMOTE_HOST" "python3 ${PATCH_SCRIPT}"
    
    log_info "热补丁应用完成"
}

# 重启 Gateway
restart_gateway() {
    if [[ "$SKIP_RESTART" == true ]]; then
        log_warn "跳过 Gateway 重启"
        return
    fi
    
    log_info "重启 OpenClaw Gateway..."
    
    ssh "$REMOTE_HOST" "systemctl --user restart openclaw-gateway.service"
    sleep 3
    
    # 检查状态
    local status=$(ssh "$REMOTE_HOST" "systemctl --user is-active openclaw-gateway.service")
    if [[ "$status" == "active" ]]; then
        log_info "Gateway 重启成功"
    else
        log_error "Gateway 重启失败，状态: $status"
        exit 1
    fi
}

# 回滚功能
rollback() {
    log_warn "执行回滚..."
    
    # 查找最新的备份
    local latest_backup=$(ssh "$REMOTE_HOST" "ls -td ${BACKUP_BASE_DIR}/dist_backup_* 2>/dev/null | head -1")
    
    if [[ -z "$latest_backup" ]]; then
        log_error "未找到备份目录"
        exit 1
    fi
    
    log_info "使用备份: $latest_backup"
    
    # 停止 Gateway
    ssh "$REMOTE_HOST" "systemctl --user stop openclaw-gateway.service 2>/dev/null || true"
    
    # 恢复 dist
    ssh "$REMOTE_HOST" "rm -rf ${OPENCLAW_DIST_DIR} && cp -r ${latest_backup} ${OPENCLAW_DIST_DIR}"
    
    # 重启 Gateway
    ssh "$REMOTE_HOST" "systemctl --user start openclaw-gateway.service"
    
    log_info "回滚完成"
}

# 验证安装
verify_installation() {
    log_info "验证安装..."
    
    # 检查 Gateway 健康状态
    local health=$(ssh "$REMOTE_HOST" "curl -s http://127.0.0.1:18789/health 2>/dev/null" || echo "failed")
    
    if [[ "$health" == *"ok"* ]]; then
        log_info "Gateway 健康检查通过"
    else
        log_warn "Gateway 健康检查失败，请手动检查"
    fi
    
    # 检查补丁状态
    local patched_count=$(ssh "$REMOTE_HOST" "grep -l 'New trace started' ${OPENCLAW_DIST_DIR}/*.js 2>/dev/null | wc -l")
    log_info "已补丁文件数: $patched_count"
    
    if [[ "$patched_count" -gt 0 ]]; then
        log_info "补丁验证通过"
    else
        log_error "补丁验证失败"
        exit 1
    fi
}

# 主流程
main() {
    echo "============================================"
    echo "  openclaw-agentlog 安装脚本"
    echo "============================================"
    echo ""
    
    if [[ "$ROLLBACK" == true ]]; then
        rollback
        exit 0
    fi
    
    log_info "目标主机: $REMOTE_HOST"
    log_info "插件目录: ${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_NAME}"
    echo ""
    
    # 1. 备份
    backup_openclaw_config
    backup_openclaw_dist
    
    # 2. 同步插件
    sync_plugin
    
    # 3. 安装依赖
    install_dependencies
    
    # 4. 执行热补丁
    apply_patch
    
    # 5. 重启 Gateway
    restart_gateway
    
    # 6. 验证
    verify_installation
    
    echo ""
    echo "============================================"
    log_info "安装完成!"
    echo "============================================"
    echo ""
    echo "提示:"
    echo "  - 发送飞书消息测试 'New trace started' 显示"
    echo "  - 回滚命令: $0 --rollback --remote $REMOTE_HOST"
    echo "  - 查看日志: ssh $REMOTE_HOST 'tail -f /tmp/openclaw/openclaw-\$(date +%Y-%m-%d).log'"
}

main "$@"
