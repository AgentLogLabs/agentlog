/**
 * esbuild 构建脚本 — agentlog-vscode
 *
 * 将 extension.ts 及所有依赖（含 @agentlog/shared）打包为单文件 CJS bundle。
 * vscode 模块标记为 external（由 VS Code 运行时提供）。
 *
 * 同时负责：
 *  1. 先触发 backend 的 esbuild 打包（含 node_modules 复制）
 *  2. 将 backend/dist/ 整体复制到 dist/backend/
 *  3. 将 webview 静态资源复制到 dist/webview/
 */

import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** 递归复制目录（跳过符号链接） */
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

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],   // 由 VS Code 运行时提供，不打包
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('esbuild watching...');
} else {
  // 1. 先构建 backend（含 node_modules 复制）
  console.log('\nBuilding backend...');
  const backendDir = join(__dirname, '..', 'backend');
  execSync('node build.mjs', { cwd: backendDir, stdio: 'inherit' });

  // 2. 打包 extension
  await esbuild.build(buildOptions);

  // 3. 复制 webview 静态资源
  const webviewSrc = 'src/webview';
  const webviewDst = 'dist/webview';
  if (existsSync(webviewSrc)) {
    copyDir(webviewSrc, webviewDst);
    console.log('webview assets copied.');
  }

  // 4. 复制 backend 编译产物（含 node_modules）到 dist/backend/
  const backendSrc = join(__dirname, '..', 'backend', 'dist');
  const backendDst = join(__dirname, 'dist', 'backend');
  if (existsSync(backendSrc)) {
    copyDir(backendSrc, backendDst);
    console.log('backend dist copied (with node_modules).');
  }

  // 5. 复制 OpenCode 插件到 dist/
  const opencodePluginsSrc = 'src/opencode-plugins';
  const opencodePluginsDst = 'dist/opencode-plugins';
  if (existsSync(opencodePluginsSrc)) {
    copyDir(opencodePluginsSrc, opencodePluginsDst);
    console.log('OpenCode plugins copied.');
  }
}
