# Issue #15 修复方案：Node.js 版本不兼容

**问题**：better-sqlite3 原生模块在 Node.js 23.x 编译，但用户环境是 Node.js 18.x，导致 ERR_DLOPEN_FAILED

---

## 根因分析

```
┌─────────────────────────────────────────────────────────┐
│ 问题链路                                             │
├─────────────────────────────────────────────────────────┤
│ 1. CI 构建机器：Node.js 23.x                         │
│ 2. better-sqlite3 用 Node.js 23.x 编译（.node 文件）│
│ 3. VSCode 插件内置 Node.js 18.x                      │
│ 4. 运行时报错：ERR_DLOPEN_FAILED                    │
└─────────────────────────────────────────────────────────┘
```

`build.mjs` 虽然有交叉编译逻辑，但：
- `target: 'node18'` 只影响 JS 代码，不影响原生模块编译
- CI 可能没有设置 `npm_config_arch` 环境变量

---

## 解决方案

### 方案 A：明确 Node.js 版本要求（快速修复）

**原理**：在 VSCode 插件 package.json 中明确 `engines`，并在 README 中说明。

**修改**：

```json
// packages/vscode-extension/package.json
{
  "engines": {
    "vscode": "^1.96.0",
    "node": ">=18.0.0 <24.0.0"  // 新增
  },
  "scripts": {
    "postinstall": "node scripts/check-node-version.js"  // 新增
  }
}
```

**check-node-version.js**：

```javascript
const version = process.version.match(/^v(\d+)/)[1];
if (parseInt(version) < 18 || parseInt(version) >= 24) {
  console.error('AgentLog requires Node.js 18.x or higher.');
  process.exit(1);
}
```

---

### 方案 B：交叉编译 better-sqlite3（推荐）

**原理**：在 CI workflow 中设置正确的目标架构，确保编译版本与 VSCode 内置 Node.js 兼容。

**修改 `.github/workflows/build.yml`**：

```yaml
jobs:
  build:
    strategy:
      matrix:
        node-version: ['18.x', '20.x', '22.x']  # 覆盖 VSCode 可能的所有版本
    
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          architecture: x64
      
      # 构建时强制使用 VSCode 同款 Node ABI
      - name: Build native modules
        env:
          npm_config_arch: x64
          npm_config_runtime: node
          npm_config_target_arch: x64
        run: |
          pnpm install
          cd packages/backend
          node build.mjs
```

---

### 方案 C：使用 sql.js 替代 better-sqlite3（彻底解决）

**原理**：sql.js 是 WebAssembly 版本，无需原生编译。

**优点**：
- ✅ 完全避免原生模块问题
- ✅ 跨平台兼容
- ✅ 无需担心 Node.js 版本

**缺点**：
- ⚠️ 需要修改数据库访问代码
- ⚠️ 性能可能略低（但可接受）

**修改依赖**：

```json
// packages/backend/package.json
{
  "dependencies": {
    "sql.js": "^1.10.0",  // 替代 better-sqlite3
    "better-sqlite3": "^9.4.3"  // 保留，用于性能敏感场景
  }
}
```

**架构选择逻辑**：

```javascript
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let db;
try {
  // 尝试 better-sqlite3（优先，性能好）
  db = new (require('better-sqlite3'))(path);
} catch (err) {
  if (err.code === 'ERR_DLOPEN_FAILED') {
    // 回退到 sql.js（WASM 版本）
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    db = new SQL.Database();
  } else {
    throw err;
  }
}
```

---

## 推荐方案

| 方案 | 工时 | 效果 | 风险 |
|------|------|------|------|
| **A: 版本要求** | 1h | 快速，但用户体验差 | 低 |
| **B: 交叉编译** | 4h | 彻底解决 CI 问题 | 中 |
| **C: sql.js** | 8h | 彻底解决兼容问题 | 中 |

**建议**：先方案 A 快速修复，再逐步实现方案 C。

---

## 快速修复（方案 A）

**修改文件**：
1. `packages/vscode-extension/package.json` - 添加 engines
2. `README.md` - 添加 Node.js 版本要求说明

---

**Architect**: 🏗️  
**Date**: 2026-04-02
