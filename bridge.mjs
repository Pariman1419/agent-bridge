#!/usr/bin/env node
/**
 * agent-bridge (bridge.mjs)
 * Unified MCP Server + CLI Bridge connecting Claude Code, OpenAI Codex, and Google Antigravity (AGY).
 * Zero external dependencies — Node.js standard library only.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
const MAX_DEPTH = Number(process.env.AGENT_BRIDGE_MAX_DEPTH || 3);
const DEFAULT_TIMEOUT_MS = Number(process.env.AGENT_BRIDGE_TIMEOUT_MS || 240_000);

export const AGENTS = {
  claude: {
    key: 'claude',
    name: 'Claude Code',
    cli: 'claude',
    fallbackPaths: IS_WIN
      ? [
          path.join(HOME, '.local', 'bin', 'claude.exe'),
          path.join(HOME, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        ]
      : [path.join(HOME, '.local', 'bin', 'claude')],
  },
  codex: {
    key: 'codex',
    name: 'OpenAI Codex',
    cli: 'codex',
    fallbackPaths: IS_WIN
      ? [
          path.join(HOME, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
          path.join(HOME, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
        ]
      : [],
  },
  agy: {
    key: 'agy',
    name: 'Google Antigravity',
    cli: 'agy',
    fallbackPaths: IS_WIN
      ? [
          path.join(HOME, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
          path.join(HOME, '.local', 'bin', 'agy.exe'),
        ]
      : [path.join(HOME, '.local', 'bin', 'agy')],
  },
};

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

export function resolveBin(agentKey) {
  const def = AGENTS[agentKey];
  if (!def) return null;

  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, def.cli + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // ignore permission errors
      }
    }
  }

  for (const fb of def.fallbackPaths) {
    try {
      if (existsSync(fb) && statSync(fb).isFile()) return fb;
    } catch {
      // ignore
    }
  }
  return null;
}

function runSubprocess(bin, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, PYTHONUTF8: '1', ...extraEnv };
    // Avoid Claude nested-session block when calling headless claude -p
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const useShell = IS_WIN && /\.(cmd|bat)$/i.test(bin);
    let child;
    try {
      child = spawn(bin, args, {
        cwd: cwd && existsSync(cwd) ? cwd : process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: String(err), error: 'spawn_failed' });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {}
      resolve({
        ok: false,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        error: `timeout_after_${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8') + '\n' + String(err),
        error: 'process_error',
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        error: code === 0 ? undefined : `exit_code_${code}`,
      });
    });
  });
}

function parseCodexOutput(stdout, stderr) {
  const lines = stdout.split(/\r?\n/);
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
        messages.push(ev.item.text.trim());
      } else if (ev.type === 'message' && typeof ev.content === 'string') {
        messages.push(ev.content.trim());
      }
    } catch {
      // not JSONL event
    }
  }
  if (messages.length > 0) return messages[messages.length - 1];
  const cleanOut = stripAnsi(stdout).trim();
  if (cleanOut) return cleanOut;
  return stripAnsi(stderr).trim();
}

function parseClaudeOutput(stdout, stderr) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.result === 'string') {
        return {
          text: parsed.result.trim(),
          cost_usd: parsed.total_cost_usd,
          session_id: parsed.session_id,
        };
      }
    } catch {
      // fallback to plain text
    }
  }
  return { text: stripAnsi(stdout || stderr).trim() };
}

function parseAgyOutput(stdout, stderr) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.response === 'string') return parsed.response.trim();
      if (typeof parsed.result === 'string') return parsed.result.trim();
    } catch {}
  }
  return stripAnsi(stdout || stderr).trim();
}

export async function askAgent({
  agent,
  prompt,
  cwd = process.cwd(),
  allow_write = false,
  resume = false,
  model,
  timeout_ms = DEFAULT_TIMEOUT_MS,
}) {
  const key = String(agent || '').toLowerCase().trim();
  if (!AGENTS[key]) {
    return {
      ok: false,
      agent: key,
      error: `Unknown agent "${agent}". Supported: claude, codex, agy`,
    };
  }

  const currentDepth = Number(process.env.AGENT_BRIDGE_DEPTH || 0);
  if (currentDepth >= MAX_DEPTH) {
    return {
      ok: false,
      agent: key,
      error: `Max recursion depth (${MAX_DEPTH}) reached. Refusing to spawn nested agent.`,
    };
  }

  const bin = resolveBin(key);
  if (!bin) {
    return {
      ok: false,
      agent: key,
      error: `CLI for "${key}" is not installed or not found on PATH.`,
    };
  }

  const extraEnv = { AGENT_BRIDGE_DEPTH: String(currentDepth + 1) };
  const startedAt = Date.now();

  if (key === 'codex') {
    const sandboxMode = allow_write ? 'workspace-write' : 'read-only';
    const args = resume
      ? ['exec', 'resume', '--last', '--json', '--skip-git-repo-check', '-s', sandboxMode]
      : ['exec', '--json', '--skip-git-repo-check', '-s', sandboxMode, '-C', cwd];
    if (model) args.push('-m', model);
    args.push(prompt);

    const res = await runSubprocess(bin, args, { cwd, timeoutMs: timeout_ms, extraEnv });
    const text = parseCodexOutput(res.stdout, res.stderr);
    return {
      ok: res.ok || Boolean(text),
      agent: key,
      duration_ms: Date.now() - startedAt,
      response: text || '(no output)',
      error: res.ok ? undefined : res.error,
    };
  }

  if (key === 'claude') {
    const args = [];
    if (resume) args.push('-c');
    if (model) args.push('--model', model);
    if (allow_write) {
      args.push('--allowedTools', 'Edit,Write,Bash');
    }
    args.push('-p', prompt, '--output-format', 'json');

    const res = await runSubprocess(bin, args, { cwd, timeoutMs: timeout_ms, extraEnv });
    const parsed = parseClaudeOutput(res.stdout, res.stderr);
    return {
      ok: res.ok || Boolean(parsed.text),
      agent: key,
      duration_ms: Date.now() - startedAt,
      cost_usd: parsed.cost_usd,
      session_id: parsed.session_id,
      response: parsed.text || '(no output)',
      error: res.ok ? undefined : res.error,
    };
  }

  if (key === 'agy') {
    const args = [];
    if (resume) args.push('-c');
    if (model) args.push('--model', model);
    if (allow_write) {
      args.push('--mode', 'accept-edits');
    } else {
      args.push('--sandbox');
    }
    // Note: --print must come right before prompt because Go flag parser consumes next arg
    args.push('--print', prompt);

    const res = await runSubprocess(bin, args, { cwd, timeoutMs: timeout_ms, extraEnv });
    const text = parseAgyOutput(res.stdout, res.stderr);
    return {
      ok: res.ok || Boolean(text),
      agent: key,
      duration_ms: Date.now() - startedAt,
      response: text || '(no output)',
      error: res.ok ? undefined : res.error,
    };
  }
}

export async function listAgents() {
  const entries = await Promise.all(
    Object.keys(AGENTS).map(async (key) => {
      const bin = resolveBin(key);
      if (!bin) {
        return { agent: key, name: AGENTS[key].name, installed: false, path: null, version: null };
      }
      const res = await runSubprocess(bin, ['--version'], { timeoutMs: 8000 });
      const version = stripAnsi(res.stdout || res.stderr).trim().split(/\r?\n/)[0] || 'unknown';
      return {
        agent: key,
        name: AGENTS[key].name,
        installed: true,
        path: bin,
        version,
      };
    })
  );
  return entries;
}

// ============================================================================
// MCP Server (Stdio JSON-RPC 2.0)
// ============================================================================

const MCP_TOOLS = [
  {
    name: 'ask_agent',
    description:
      'Delegate a prompt or coding task to another AI CLI agent (claude, codex, or agy) running in headless mode and return its response.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: ['claude', 'codex', 'agy'],
          description: 'Target agent CLI to invoke: "claude" (Claude Code), "codex" (OpenAI Codex), or "agy" (Antigravity).',
        },
        prompt: {
          type: 'string',
          description: 'The instructions, question, or task for the target agent.',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory path for the agent to run in.',
        },
        allow_write: {
          type: 'boolean',
          description: 'Set true to allow the target agent to edit/write files in cwd. Defaults to false (read-only/safe).',
        },
        resume: {
          type: 'boolean',
          description: 'Set true to resume/continue the most recent session of that agent.',
        },
        model: {
          type: 'string',
          description: 'Optional model override for the target agent.',
        },
      },
      required: ['agent', 'prompt'],
    },
  },
  {
    name: 'fanout_agents',
    description:
      'Run tasks across multiple AI CLI agents (claude, codex, agy) in parallel and collect all their responses for comparison or synthesis.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Shared prompt to send to all selected agents (if per-agent tasks are not specified).',
        },
        agents: {
          type: 'array',
          items: { type: 'string', enum: ['claude', 'codex', 'agy'] },
          description: 'List of agents to query in parallel. Defaults to ["claude", "codex"].',
        },
        tasks: {
          type: 'object',
          description:
            'Optional map of per-agent custom prompts, e.g. {"claude": "Review architecture", "codex": "Find race conditions"}.',
          additionalProperties: { type: 'string' },
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory path.',
        },
      },
    },
  },
  {
    name: 'list_agents',
    description: 'Check installation status, binary paths, and versions of claude, codex, and agy on this machine.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

async function handleMcpRequest(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-bridge', version: '1.0.0' },
      },
    };
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    return null; // notification, no response
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      if (toolName === 'list_agents') {
        const list = await listAgents();
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(list, null, 2) }],
          },
        };
      }

      if (toolName === 'ask_agent') {
        const res = await askAgent(args);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: !res.ok,
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          },
        };
      }

      if (toolName === 'fanout_agents') {
        const tasksMap = args.tasks && typeof args.tasks === 'object' ? args.tasks : null;
        const targetAgents = tasksMap
          ? Object.keys(tasksMap)
          : Array.isArray(args.agents) && args.agents.length > 0
            ? args.agents
            : ['claude', 'codex'];

        const results = await Promise.all(
          targetAgents.map((ag) =>
            askAgent({
              agent: ag,
              prompt: tasksMap ? tasksMap[ag] : args.prompt,
              cwd: args.cwd,
              allow_write: false,
            })
          )
        );

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }],
          },
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `Error executing ${toolName}: ${String(err)}` }],
        },
      };
    }
  }

  if (id !== undefined) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }
  return null;
}

function startMcpServer() {
  let buffer = Buffer.alloc(0);
  let useContentLength = false;

  const sendResponse = (obj) => {
    if (!obj) return;
    const body = JSON.stringify(obj);
    if (useContentLength) {
      const byteLen = Buffer.byteLength(body, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${body}`);
    } else {
      process.stdout.write(body + '\n');
    }
  };

  process.stdin.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const preview = buffer.subarray(0, Math.min(buffer.length, 32)).toString('utf8');
      if (preview.startsWith('Content-Length:')) {
        useContentLength = true;
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const headerStr = buffer.subarray(0, headerEnd).toString('utf8');
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const len = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + len) break;
        const rawMsg = buffer.subarray(bodyStart, bodyStart + len).toString('utf8');
        buffer = buffer.subarray(bodyStart + len);
        try {
          const msg = JSON.parse(rawMsg);
          const reply = await handleMcpRequest(msg);
          sendResponse(reply);
        } catch {}
      } else {
        const nlIndex = buffer.indexOf('\n');
        if (nlIndex === -1) break;
        const line = buffer.subarray(0, nlIndex).toString('utf8').trim();
        buffer = buffer.subarray(nlIndex + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const reply = await handleMcpRequest(msg);
          sendResponse(reply);
        } catch {}
      }
    }
  });
}

// ============================================================================
// CLI Entrypoint
// ============================================================================

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--mcp') || argv.length === 0) {
    startMcpServer();
    return;
  }

  const cmd = argv[0];

  if (cmd === '--self-test') {
    const status = await listAgents();
    const initReply = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    const toolsReply = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const ok =
      Array.isArray(status) &&
      initReply?.result?.serverInfo?.name === 'agent-bridge' &&
      toolsReply?.result?.tools?.length === 3;
    console.log(JSON.stringify({ self_test: ok ? 'PASSED' : 'FAILED', agents: status }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  if (cmd === 'status' || cmd === 'list') {
    const status = await listAgents();
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (cmd === 'ask') {
    const agent = argv[1];
    const rest = argv.slice(2);
    let cwd = process.cwd();
    let allow_write = false;
    let resume = false;
    let model;
    const promptParts = [];

    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--cwd' && rest[i + 1]) {
        cwd = rest[++i];
      } else if (a === '--write') {
        allow_write = true;
      } else if (a === '--resume' || a === '-c') {
        resume = true;
      } else if (a === '--model' && rest[i + 1]) {
        model = rest[++i];
      } else {
        promptParts.push(a);
      }
    }

    const prompt = promptParts.join(' ').trim();
    if (!agent || !prompt) {
      console.error('Usage: node bridge.mjs ask <claude|codex|agy> "<prompt>" [--cwd <dir>] [--write] [--resume] [--model <m>]');
      process.exit(1);
    }

    const res = await askAgent({ agent, prompt, cwd, allow_write, resume, model });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }

  if (cmd === 'fanout') {
    const rest = argv.slice(1);
    let agents = ['claude', 'codex', 'agy'];
    let cwd = process.cwd();
    const promptParts = [];

    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--agents' && rest[i + 1]) {
        agents = rest[++i].split(',').map((s) => s.trim()).filter(Boolean);
      } else if (a === '--cwd' && rest[i + 1]) {
        cwd = rest[++i];
      } else {
        promptParts.push(a);
      }
    }

    const prompt = promptParts.join(' ').trim();
    if (!prompt) {
      console.error('Usage: node bridge.mjs fanout "<prompt>" [--agents claude,codex,agy] [--cwd <dir>]');
      process.exit(1);
    }

    const results = await Promise.all(
      agents.map((ag) => askAgent({ agent: ag, prompt, cwd, allow_write: false }))
    );
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }

  console.error(`Unknown command: ${cmd}. Use --mcp, status, ask, fanout, or --self-test.`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
