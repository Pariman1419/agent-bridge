---
name: agent-bridge
description: >-
  Connects Claude Code (claude), OpenAI Codex (codex), and Google Antigravity (agy) for multi-agent orchestration.
  Use when asked to delegate tasks to another AI agent, get a second opinion/code review from Claude/Codex/AGY,
  or fan out subtasks in parallel across multiple CLI agents.
---

# Agent Bridge (`claude` ↔ `codex` ↔ `agy`)

Unified bridge that lets **Claude Code**, **OpenAI Codex**, and **Google Antigravity (AGY)** call and orchestrate each other via either **MCP tools** or the **CLI runner**.

## 1. Using the MCP Tools (Preferred when loaded)

If the `agent-bridge` MCP server is active in your session, call its tools directly:

- **`ask_agent`**:
  - `agent`: `"claude"` | `"codex"` | `"agy"`
  - `prompt`: Task or question to send
  - `cwd`: Working directory path (optional)
  - `allow_write`: `false` (default, read-only/safe) or `true` (allow file edits)
  - `resume`: `true` to continue the most recent session of that agent
  - `model`: Optional model override
- **`fanout_agents`**:
  - Run a shared `prompt` across `agents: ["claude", "codex", "agy"]` **in parallel**, or pass `tasks: { "claude": "...", "codex": "..." }` for custom per-agent subtasks.
- **`list_agents`**:
  - Check installed versions and paths of `claude`, `codex`, and `agy`.

## 2. Using the CLI Bridge (Fallback / Shell Execution)

You can always invoke the zero-dependency bridge script directly via shell:

```bash
# Check status & versions of all 3 agents
node C:/Users/kamprm/.agent-bridge/bridge.mjs status

# Ask a single agent (read-only by default)
node C:/Users/kamprm/.agent-bridge/bridge.mjs ask codex "Review src/ for race conditions" --cwd "D:/path/to/project"
node C:/Users/kamprm/.agent-bridge/bridge.mjs ask claude "Summarize the architecture"
node C:/Users/kamprm/.agent-bridge/bridge.mjs ask agy "Check edge cases in this module"

# Allow the target agent to edit/write files
node C:/Users/kamprm/.agent-bridge/bridge.mjs ask codex "Fix the failing test" --cwd "D:/path/to/project" --write

# Continue the previous session of that agent
node C:/Users/kamprm/.agent-bridge/bridge.mjs ask codex "Now add unit tests for that fix" --resume --write

# Fan out to multiple agents in parallel
node C:/Users/kamprm/.agent-bridge/bridge.mjs fanout "Compare approaches for this feature" --agents claude,codex
```

## 3. Orchestration Guidelines

1. **Don't call yourself unnecessarily**: If you are already running in `agy`, delegate to `claude` and/or `codex` (and vice versa) unless you specifically want an isolated sub-session.
2. **Read-only by default**: Keep `allow_write: false` (omit `--write`) for code reviews, architecture second opinions, and parallel fan-out so multiple agents do not overwrite the same files simultaneously.
3. **Pass explicit context**: Headless agents start with a fresh context unless `resume` is enabled. Include relevant file paths and constraints in `prompt` and set `cwd` to the target workspace.
