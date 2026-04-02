#!/usr/bin/env node
/**
 * AgentLog - Node.js Version Check
 * 
 * Ensures the environment is running Node.js 18.x-23.x
 * (VSCode 内置 Node.js 18.x-22.x)
 */

const version = process.version.match(/^v(\d+)/);
if (!version) {
  console.error('AgentLog: Cannot determine Node.js version');
  process.exit(1);
}

const majorVersion = parseInt(version[1]);
const minVersion = 18;
const maxVersion = 24; // exclusive

if (majorVersion < minVersion || majorVersion >= maxVersion) {
  console.error(`AgentLog: Requires Node.js ${minVersion}.x - ${maxVersion - 1}.x`);
  console.error(`AgentLog: Current version: ${process.version}`);
  console.error(`AgentLog: Please use nvm to switch to a compatible Node.js version`);
  console.error(`AgentLog: See https://github.com/nvm-sh/nvm`);
  process.exit(1);
}

console.log(`AgentLog: Node.js version check passed (${process.version})`);
