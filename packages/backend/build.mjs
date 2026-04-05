/**
 * esbuild 构建脚本 — @agentlog/backend
 *
 * 将 index.ts 和 mcp.ts 各自打包为独立的 CJS bundle。
 *
 * 标记为 external 的模块需要复制到 dist/node_modules/：
 *  - better-sqlite3  — 原生模块（含 .node 文件）
 *  - pino / pino-pretty — 使用 worker_threads 动态加载内部文件，路径在 bundle 后会错误
 */

import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PNPM_STORE = join(__dirname, '..', '..', 'node_modules', '.pnpm');

/** 递归复制目录（跳过符号链接，避免 pnpm store 的循环链接） */
function copyDir(src, dst) {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

/** 在 pnpm store 或本地 node_modules 中查找包的实际路径 */
function findPkg(pkgName) {
  // 1. 本地 node_modules（symlink 解析后）
  const local = join(__dirname, 'node_modules', pkgName);
  if (existsSync(local)) return local;

  // 2. pnpm store
  // 目录名规则：
  //   普通包:  pkgname@version          (e.g. pino@9.14.0)
  //   作用域包: @scope+pkgname@version   (e.g. @pinojs+redact@0.4.0)
  if (existsSync(PNPM_STORE)) {
    const prefix = pkgName.startsWith('@')
      ? '@' + pkgName.slice(1).replace('/', '+') + '@'  // @pinojs/redact → @pinojs+redact@
      : pkgName + '@';                                    // pino → pino@
    for (const entry of readdirSync(PNPM_STORE, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(prefix)) {
        const candidate = join(PNPM_STORE, entry.name, 'node_modules', pkgName);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** 复制一个包到 dist/node_modules/ */
function copyPkg(pkgName) {
  const src = findPkg(pkgName);
  if (src) {
    const dst = join(__dirname, 'dist', 'node_modules', pkgName);
    copyDir(src, dst);
    console.log(`  ✓ ${pkgName}`);
  } else {
    console.warn(`  ✗ ${pkgName} NOT FOUND`);
  }
}

// ── 1. esbuild bundle ────────────────────────────────────────────────────────

const { version: APP_VERSION } = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

const sharedOptions = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  external: [
    'better-sqlite3',
    'pino',
    'pino-pretty',
  ],
};

await Promise.all([
  esbuild.build({ ...sharedOptions, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' }),
  esbuild.build({ ...sharedOptions, entryPoints: ['src/mcp.ts'],   outfile: 'dist/mcp.js'   }),
]);

// ── 2. 复制 external 依赖到 dist/node_modules/ ───────────────────────────────

console.log('\nCopying external packages to dist/node_modules/...');

// 优先使用 npm_config_arch 环境变量（CI 多平台构建时由 workflow 注入）
// 否则回退到当前进程架构
const targetArch = process.env.npm_config_arch || process.arch;

// 确保 better-sqlite3 原生模块已构建
// 若目标架构与当前进程架构不同，强制 rebuild（交叉编译场景）
const bsqlitePkg = findPkg('better-sqlite3');
const nodeFile = bsqlitePkg ? join(bsqlitePkg, 'build', 'Release', 'better_sqlite3.node') : null;

const shouldRebuild = process.env.CI || !nodeFile || !existsSync(nodeFile) || targetArch !== process.arch;

if (shouldRebuild) {
  console.log(`Building better-sqlite3 native module (arch=${targetArch})...`);
  try {
    if (bsqlitePkg && existsSync(bsqlitePkg)) {
      // 删除旧产物强制重编译
      const buildDir = join(bsqlitePkg, 'build');
      if (existsSync(buildDir)) {
        execSync('rm -rf build', { cwd: bsqlitePkg, stdio: 'ignore' });
      }
      // 显式传入 --arch，避免在 arm64 runner 上交叉编译时使用宿主架构
      execSync(`npx --yes node-gyp rebuild --arch=${targetArch}`, { cwd: bsqlitePkg, stdio: 'inherit' });
    } else {
      execSync('pnpm rebuild better-sqlite3', { cwd: join(__dirname, '..', '..'), stdio: 'inherit' });
    }
  } catch (err) {
    console.warn('Failed to rebuild better-sqlite3, attempting to continue:', err.message);
  }
} else {
  console.log(`better-sqlite3 native module already built (arch=${targetArch}), skipping rebuild.`);
}

// better-sqlite3 依赖链
copyPkg('better-sqlite3');
copyPkg('bindings');
copyPkg('file-uri-to-path');

// pino 及其完整依赖树
const pinoPkgs = [
  'pino',
  'pino-pretty',
  'pino-abstract-transport',
  'pino-std-serializers',
  // pino deps
  'atomic-sleep',
  'on-exit-leak-free',
  'process-warning',
  'quick-format-unescaped',
  'real-require',
  'safe-stable-stringify',
  '@pinojs/redact',
  'sonic-boom',
  'thread-stream',
  // pino-pretty deps
  'colorette',
  'dateformat',
  'fast-copy',
  'fast-safe-stringify',
  'help-me',
  'joycon',
  'minimist',
  'pump',
  'end-of-stream',        // pump dependency
  'once',                 // pump & end-of-stream dependency
  'wrappy',               // once dependency
  'readable-stream',
  'inherits',             // readable-stream dependency
  'string_decoder',       // readable-stream dependency
  'util-deprecate',       // readable-stream dependency
  'safe-buffer',          // string_decoder dependency
  'secure-json-parse',
  'strip-json-comments',
  'split2',
];

for (const pkg of pinoPkgs) {
  copyPkg(pkg);
}

console.log('\nBackend build complete.');
