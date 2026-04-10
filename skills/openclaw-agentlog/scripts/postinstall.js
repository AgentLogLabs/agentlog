#!/usr/bin/env node
/**
 * postinstall script for openclaw-agentlog
 *
 * 在 npm install 后自动执行以下操作：
 * 1. 检测 OpenClaw dist 目录位置
 * 2. 备份 dist 文件
 * 3. 应用热补丁
 * 4. 提示重启 Gateway
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const DIST_DIRS = [
  '/home/hobo/.npm-global/lib/node_modules/openclaw/dist',
  '/usr/local/lib/node_modules/openclaw/dist',
  path.join(os.homedir(), '.npm-global/lib/node_modules/openclaw/dist'),
];

const BACKUP_BASE_DIR = '/home/hobo/.npm-global/lib/node_modules/openclaw';

const OLD_PATTERN = 'return modelLabel === defaultLabel ? `\u2705 New session started \u00b7 model: ${modelLabel}` : `\u2705 New session started \u00b7 model: ${modelLabel} (default: ${defaultLabel})`;';

const NEW_CODE = `const _agentlogTraceId = process.env.AGENTLOG_TRACE_ID;
	const _agentlogTraceSuffix = _agentlogTraceId ? " \\u00b7 trace: " + _agentlogTraceId : "";
	return modelLabel === defaultLabel ? "\\u2705 New trace started \\u00b7 model: " + modelLabel + _agentlogTraceSuffix : "\\u2705 New trace started \\u00b7 model: " + modelLabel + " (default: " + defaultLabel + ")" + _agentlogTraceSuffix;`;

function log(msg, type = 'info') {
  const colors = {
    info: '\x1b[32m',   // green
    warn: '\x1b[33m',   // yellow
    error: '\x1b[31m', // red
    reset: '\x1b[0m',
  };
  console.log(`${colors[type]}[${type.toUpperCase()}]${colors.reset} ${msg}`);
}

function findDistDir() {
  for (const dir of DIST_DIRS) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

function createBackupDir() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = `${BACKUP_BASE_DIR}/dist_backup_${timestamp}`;
  fs.mkdirSync(backupDir, { recursive: true });
  return backupDir;
}

function getJsFiles(distDir) {
  return fs.readdirSync(distDir)
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(distDir, f));
}

function isAlreadyPatched(content) {
  return content.includes('New trace started') && !content.includes('New session started');
}

function patchFile(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');

  if (!content.includes(OLD_PATTERN)) {
    return { patched: false, reason: 'pattern not found' };
  }

  const newContent = content.replace(OLD_PATTERN, NEW_CODE, 1);
  fs.writeFileSync(filepath, newContent, 'utf-8');
  return { patched: true };
}

function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   openclaw-agentlog postinstall                   ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  const distDir = findDistDir();

  if (!distDir) {
    log('未找到 OpenClaw dist 目录，跳过补丁应用', 'warn');
    log('请确保 OpenClaw 已安装，或手动运行 install.sh', 'warn');
    return;
  }

  log(`找到 OpenClaw dist: ${distDir}`);

  // 创建备份
  const backupDir = createBackupDir();
  log(`创建备份目录: ${backupDir}`);

  const files = getJsFiles(distDir);
  let patched = 0;
  let skipped = 0;
  let alreadyPatched = 0;

  for (const file of files) {
    const filename = path.basename(file);

    try {
      const content = fs.readFileSync(file, 'utf-8');

      if (isAlreadyPatched(content)) {
        alreadyPatched++;
        continue;
      }

      if (!content.includes(OLD_PATTERN)) {
        skipped++;
        continue;
      }

      // 备份原文件
      fs.copyFileSync(file, path.join(backupDir, filename));

      // 应用补丁
      const result = patchFile(file);
      if (result.patched) {
        patched++;
        console.log(`  ✓ ${filename}`);
      } else {
        skipped++;
      }
    } catch (err) {
      log(`跳过 ${filename}: ${err.message}`, 'error');
    }
  }

  console.log('');
  log(`补丁应用完成!`);
  log(`  已补丁: ${patched} 文件`);
  log(`  已完成: ${alreadyPatched} 文件`);
  log(`  跳过: ${skipped} 文件`);
  console.log('');
  log(`备份位置: ${backupDir}`);
  console.log('');
  log('请重启 OpenClaw Gateway 以应用更改:');
  log('  systemctl --user restart openclaw-gateway.service');
  console.log('');
}

main();
