#!/usr/bin/env node
/**
 * install.mjs
 * One-step installer that registers agent-bridge (MCP Server + Shared Skill)
 * across Claude Code, OpenAI Codex, and Google Antigravity (AGY).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBin } from './bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';

const bridgePath = path.join(__dirname, 'bridge.mjs').replace(/\\/g, '/');
const skillSource = path.join(__dirname, 'skills', 'agent-bridge');

function linkSkill(targetPath) {
  try {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }
    symlinkSync(skillSource, targetPath, IS_WIN ? 'junction' : 'dir');
    console.log(`✔ Linked skill -> ${targetPath}`);
  } catch (err) {
    console.warn(`⚠ Could not link skill at ${targetPath}: ${err.message}`);
  }
}

function registerMcp(agentKey, args, removeArgs) {
  const bin = resolveBin(agentKey);
  if (!bin) {
    console.log(`- Skipping ${agentKey} MCP registration (CLI not found)`);
    return;
  }
  if (removeArgs) {
    try {
      execFileSync(bin, removeArgs, { stdio: 'ignore' });
    } catch {}
  }
  try {
    execFileSync(bin, args, { stdio: 'inherit' });
    console.log(`✔ Registered MCP server in ${agentKey}`);
  } catch (err) {
    console.warn(`⚠ Failed to register MCP in ${agentKey}: ${err.message}`);
  }
}

console.log('=== Installing agent-bridge ===');

// 1. Link skills into Claude, Codex, .agents, and AGY
linkSkill(path.join(HOME, '.claude', 'skills', 'agent-bridge'));
linkSkill(path.join(HOME, '.codex', 'skills', 'agent-bridge'));
linkSkill(path.join(HOME, '.agents', 'skills', 'agent-bridge'));

const agyPluginDir = path.join(HOME, '.gemini', 'config', 'plugins', 'agent-bridge');
mkdirSync(path.join(agyPluginDir, 'skills'), { recursive: true });
writeFileSync(
  path.join(agyPluginDir, 'plugin.json'),
  JSON.stringify(
    {
      name: 'agent-bridge',
      description: 'Connects Claude Code, OpenAI Codex, and Google Antigravity via MCP and Skill orchestration.',
      version: '1.0.0',
    },
    null,
    2
  )
);
linkSkill(path.join(agyPluginDir, 'skills', 'agent-bridge'));

// 2. Register MCP Server in each installed CLI
registerMcp('agy', ['mcp', 'add', 'agent-bridge', '--', 'node', bridgePath, '--mcp']);
registerMcp(
  'codex',
  ['mcp', 'add', 'agent-bridge', '--', 'node', bridgePath, '--mcp'],
  ['mcp', 'remove', 'agent-bridge']
);
registerMcp(
  'claude',
  ['mcp', 'add', '-s', 'user', 'agent-bridge', '--', 'node', bridgePath, '--mcp'],
  ['mcp', 'remove', '-s', 'user', 'agent-bridge']
);

console.log('\n🎉 agent-bridge installation complete!');
