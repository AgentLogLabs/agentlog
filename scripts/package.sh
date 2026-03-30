#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$ROOT_DIR/packages/vscode-extension"
SHARED_DIR="$ROOT_DIR/packages/shared"

export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"

# ── 解析参数 ──────────────────────────────────────────────────────────────────
# 用法: ./package.sh [--target <vsce-target>]
# 示例: ./package.sh --target darwin-x64
#       ./package.sh --target darwin-arm64
#       ./package.sh               # 不指定 target，打通用包

TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# ── 根据 target 推断 npm_config_arch / npm_config_platform ───────────────────
case "$TARGET" in
  darwin-x64)
    export npm_config_arch=x64
    export npm_config_platform=darwin
    ;;
  darwin-arm64)
    export npm_config_arch=arm64
    export npm_config_platform=darwin
    ;;
  linux-x64)
    export npm_config_arch=x64
    export npm_config_platform=linux
    ;;
  win32-x64)
    export npm_config_arch=x64
    export npm_config_platform=win32
    ;;
  "")
    # 不指定 target，使用当前机器架构
    ;;
  *)
    echo "Unknown target: $TARGET"
    echo "Supported: darwin-x64, darwin-arm64, linux-x64, win32-x64"
    exit 1
    ;;
esac

echo "==> Using Node.js: $(node --version)"
if [[ -n "$TARGET" ]]; then
  echo "==> Target: $TARGET (arch=${npm_config_arch}, platform=${npm_config_platform})"
else
  echo "==> Target: (native)"
fi
echo "==> Building and packaging AgentLog VSCode extension..."

# ── 构建 shared ──────────────────────────────────────────────────────────────
echo ""
echo "==> Building shared..."
(cd "$SHARED_DIR" && pnpm build)

# ── 强制 rebuild native modules（避免 pnpm store 缓存残留导致架构错误）─────────
if [[ -n "$TARGET" ]]; then
  echo ""
  echo "==> Cleaning native modules for ${TARGET}..."
  PNPM_STORE="$ROOT_DIR/node_modules/.pnpm"
  for entry in "$PNPM_STORE"/better-sqlite3@*/node_modules/better-sqlite3; do
    if [[ -d "$entry" ]]; then
      rm -rf "$entry/build"
      echo "  cleaned: $entry"
    fi
  done
fi

# ── 构建 extension（内部会自动构建 backend，含原生模块）────────────────────────
# npm_config_arch 已 export，子进程 node-gyp 会继承
echo ""
echo "==> Building extension + backend..."
(cd "$EXT_DIR" && node build.mjs)

# ── 打包 vsix ──────────────────────────────────────────────────────────────────
echo ""
echo "==> Packaging VSIX..."
cd "$EXT_DIR"

if [[ -n "$TARGET" ]]; then
  npx vsce package --no-dependencies --target "$TARGET"
else
  npx vsce package --no-dependencies
fi

echo ""
echo "==> Package complete!"
echo "    Output: $EXT_DIR/agentlog-vscode-*.vsix"
ls -lh "$EXT_DIR"/*.vsix 2>/dev/null | tail -5
