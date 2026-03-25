#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")/packages/vscode-extension"

export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"

echo "==> Using Node.js: $(node --version)"
echo "==> Building and packaging AgentLog VSCode extension..."

cd "$EXT_DIR"

npx vsce package --no-dependencies

echo ""
echo "==> Package complete!"
echo "    Output: $EXT_DIR/agentlog-vscode-*.vsix"
ls -lh "$EXT_DIR"/*.vsix 2>/dev/null | tail -1
