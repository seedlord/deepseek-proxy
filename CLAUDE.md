# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

A Node.js HTTP proxy that sits between the Claude Code VS Code extension and the DeepSeek API. It inspects, displays, and logs API traffic in a terminal TUI while forwarding requests unchanged (or with subagent thinking overrides applied). Handles compressed responses (gzip/deflate/brotli) transparently and extracts per-session metadata (project path, app type, git status) from system prompts.

## Commands

```bash
# Start the proxy (default port 4000)
node proxy.js

# Start with custom port/host
$env:PROXY_PORT=3000; node proxy.js
$env:DEEPSEEK_HOST='api.deepseek.com'; node proxy.js

# Syntax check (no test suite exists)
node --check proxy.js
node --check lib/config.js
node --check lib/colors.js
node --check lib/metrics.js
node --check lib/inspector.js
node --check lib/tui.js
```

No build step, no package.json, no dependencies — uses only Node.js built-ins (`http`, `https`, `fs`, `readline`, `zlib`).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PROXY_PORT` | `4000` | Listening port |
| `DEEPSEEK_HOST` | `api.deepseek.com` | Upstream API host |
| `PROXY_LOG_FILE` | `./proxy-metrics.csv` | CSV output path |
| `PROXY_MAX_BODY` | `52428800` (50 MB) | Max request body size |
| `PROXY_REQ_TIMEOUT` | `120000` (120s) | Outbound request timeout |
| `PROXY_SRV_TIMEOUT` | `130000` (130s) | Inbound/server timeout |

## Architecture

```
proxy.js ── orchestrator (HTTP server, forwarding, keyboard input)
  ├── lib/config.js    — all constants, env-var overrides, CSV header
  ├── lib/colors.js    — ANSI escapes, log tags, formatting helpers (shortModel, onOff, hrColor, etc.)
  ├── lib/tui.js       — terminal UI: header bar, pager/scrollback, session/cache stats, throttled repaint
  ├── lib/inspector.js — parses Claude API JSON payloads to extract model/thinking/tool info
  └── lib/metrics.js   — extracts token usage from streaming response buffers, writes CSV
Output files:
  ├── proxy-metrics.csv  — per-request token metrics (CSV)
  └── proxy-debug.log    — full debug output when debug mode is on
```

**Request flow:** Client → HTTP server (`proxy.js`) → body read with size cap → JSON parse → `inspectPayload()` → session metadata extraction (project dir, app type, git status from system prompt + user-agent) → session activation via auth header fingerprint → subagent thinking override (if applicable) → `forwardToDeepSeek()` via HTTPS keep-alive agent → streaming response → gzip decompression (if `Content-Encoding` detected) → `extractMetrics()` on tail buffer → TUI log + per-session cache stats + CSV append + debug file log.

**Subagent thinking override:** When `forceSubagentThinking` is on, subagent requests (`x-claude-code-agent-id` header present) get the latest main-agent `thinking` and `output_config` injected before forwarding. When off, subagent thinking is set to `{ type: 'disabled' }`. Display always shows original payload info.

**TUI:** A 4-line header bar showing port, request count, model, session badge (`#1*048a deepseekproxy [vscode][git]` — session ID, last 4 of API key, full project path, app type, git-repo indicator), MAIN and SUB cache hit rates (separately), toggle states (including debug TUI print), uptime, and keyboard shortcuts. Below it, a scrollable log area with request/response lines. Response `<#` aligns with request `>#`, and `calls:` aligns with `tools:`. Repaint is throttled via `setImmediate` — at most one per event-loop tick. Lines are truncated to terminal width to prevent wrapping artifacts.

**Pager / scrollback:** Press `p` to enter pager mode. The header stays live while the log area freezes at a scroll position. Navigate with `j`/`k` (or arrow keys) for line-by-line, `g` to jump to top, `G` to jump to bottom. Press `p`, `q`, or `Esc` to exit and return to follow mode. New log lines arriving during pager mode auto-adjust the scroll offset so the view stays on the same content.

**Cache stats:** Cache hits and input tokens are tracked separately for MAIN and SUB roles (`mainHits`/`mainInput`, `subHits`/`subInput`) per session. The header shows `M:XX%` always, plus `S:XX%` only when sub-agent requests have occurred. This matters because MAIN and SUB have completely separate context caches — aggregating them would produce a meaningless blended rate.

**Session detection / metadata:** On the first MAIN request, the proxy extracts per-session metadata from the system prompt and headers: project directory (from `primary working directory`), git-repo status (`is a git repository: true`), and app type (from `user-agent`: `claude-vscode` → `[vscode]`, `claude-cli` → `[cli]`). These are displayed as badges in the header. A fingerprint of the Authorization header (last 8 chars of token) identifies unique sessions. When the key changes (new API key = new Claude Code session), a new session bucket is created. Manual MAIN stats reset via `R` (Shift+R) or `h` (hot reload).

**Metrics extraction:** `extractMetrics()` handles two DeepSeek response formats: `think:adaptive` uses Anthropic-style field names (`input_tokens`/`output_tokens`/`cache_read_input_tokens`/`reasoning_tokens`), while `think:none` uses OpenAI-style names (`prompt_tokens`/`completion_tokens`). Both JSON parse and regex fallback paths support both conventions. Compressed responses (gzip/deflate/brotli — used by DeepSeek for short `think:none` responses) are decompressed via `zlib` before extraction.

**Debug logging:** Press `d` to enable debug mode, which writes comprehensive request/response data to `proxy-debug.log` (headers, full system prompt, response buffer, token counts). Press `D` (Shift+D) to toggle TUI visibility of debug lines — off by default to keep the log area clean. Debug lines in the TUI are truncated to terminal width; the file always has full content.

**CSV:** `initCsv()` auto-rotates the file if the header mismatches (e.g. schema changed). Writes are async (`fs.appendFile`), non-blocking. The `/metrics` GET endpoint serves the CSV for download. CSV records `role` (MAIN/SUB) and `agentId` per row for post-hoc per-session analysis.

## HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/*` | Forward to DeepSeek (JSON body required) |
| GET | `/toggle` | Toggle subagent thinking override |
| GET | `/toggle-log` | Toggle CSV file logging |
| GET | `/toggle-debug` | Toggle debug logging |
| GET | `/health` | Health check (uptime, request count, toggle states) |
| GET | `/status` | Brief status (toggles + request count) |
| GET | `/metrics` | Download CSV log (503 if file logging disabled) |

## Keyboard controls (in terminal)

| Key | Action |
|---|---|
| `t` | Toggle subagent thinking override |
| `l` | Toggle CSV file logging |
| `d` | Toggle debug logging (file always, TUI off by default) |
| `D` | Toggle debug TUI print (only when debug logging is on) |
| `r` | Redraw screen |
| `R` | Reset MAIN cache stats (no reload) |
| `p` | Enter/exit pager mode (scrollback) |
| `s` | Print stats line to log |
| `h` | Hot reload all `lib/*` modules (preserves session stats) |
| `q` | Quit |

### Pager mode keys (after pressing `p`)

| Key | Action |
|---|---|
| `j` / `↓` | Scroll down one line |
| `k` / `↑` | Scroll up one line |
| `PageUp` | Scroll up 10 lines |
| `PageDown` | Scroll down 10 lines |
| `g` | Jump to top of log buffer |
| `G` | Jump to bottom (resume follow) |
| `p` / `q` / `Esc` | Exit pager, return to follow mode |

## Hot reload

`h` key triggers `reloadModules()`: saves TUI state (log buffer, session stats, pager state), closes the server, clears the require cache for `lib/*` modules, re-requires them (picking up file changes), restores TUI state into the fresh modules, and restarts the server on the same port. The process never exits — log buffer and terminal session are preserved.

## Notes

- No Windows/PowerShell-specific quirks in the code itself; ANSI escape codes work on Windows 10 1511+.
- The code handles SIGINT and SIGTERM for clean terminal restoration (raw mode exit).
- Response metrics are extracted from a sliding 1 MB tail buffer (`config.MAX_RESPONSE_BUF`) for uncompressed responses. Compressed responses (gzip/deflate/brotli) are accumulated as raw Buffers and decompressed before extraction.
- In pager mode, the header (rows 0–3) is still updated live via `paintHeader()` independently of the frozen log viewport.
- MAIN cache stats reset automatically on session change (auth key fingerprint mismatch) or manually via `R`/`h`.
- Proxy request blocks have no separator lines — timestamps provide sufficient visual separation.
- Debug file `proxy-debug.log` grows unbounded; rotate manually if needed.
