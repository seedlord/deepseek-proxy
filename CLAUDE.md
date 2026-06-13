# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

A Node.js HTTP proxy that sits between the Claude Code VS Code extension and the DeepSeek API. It inspects, displays, and logs API traffic in a terminal TUI while forwarding requests unchanged (or with subagent thinking overrides applied).

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

No build step, no package.json, no dependencies — uses only Node.js built-ins (`http`, `https`, `fs`, `readline`).

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
  ├── lib/tui.js       — terminal UI: header bar, pager/scrollback, cache stats, throttled repaint
  ├── lib/inspector.js — parses Claude API JSON payloads to extract model/thinking/tool info
  └── lib/metrics.js   — extracts token usage from streaming response buffers, writes CSV
```

**Request flow:** Client → HTTP server (`proxy.js`) → body read with size cap → JSON parse → `inspectPayload()` → session detection (`checkMainSession()` via auth header fingerprint) → subagent thinking override (if applicable) → `forwardToDeepSeek()` via HTTPS keep-alive agent → streaming response → `extractMetrics()` on tail buffer → TUI log + MAIN/SUB-separated cache stats + CSV append.

**Subagent thinking override:** When `forceSubagentThinking` is on, subagent requests (`x-claude-code-agent-id` header present) get the latest main-agent `thinking` and `output_config` injected before forwarding. When off, subagent thinking is set to `{ type: 'disabled' }`. Display always shows original payload info.

**TUI:** A 4-line header bar showing port, request count, model, MAIN and SUB cache hit rates (separately), toggle states, uptime, and keyboard shortcuts. Below it, a scrollable log area with request/response lines. Repaint is throttled via `setImmediate` — at most one per event-loop tick. Lines are truncated to terminal width to prevent wrapping artifacts.

**Pager / scrollback:** Press `p` to enter pager mode. The header stays live while the log area freezes at a scroll position. Navigate with `j`/`k` (or arrow keys) for line-by-line, `g` to jump to top, `G` to jump to bottom. Press `p`, `q`, or `Esc` to exit and return to follow mode. New log lines arriving during pager mode auto-adjust the scroll offset so the view stays on the same content.

**Cache stats:** Cache hits and input tokens are tracked separately for MAIN and SUB roles (`mainHits`/`mainInput`, `subHits`/`subInput`). The header shows `M:XX%` always, plus `S:XX%` only when sub-agent requests have occurred. This matters because MAIN and SUB have completely separate context caches — aggregating them would produce a meaningless blended rate.

**Session detection:** Before each MAIN request, `checkMainSession()` compares a fingerprint of the Authorization header (last 8 chars of token) against the stored `mainSessionKey`. When the key changes (new API key = new Claude Code session), it logs the previous session's hit rate and resets MAIN counters. Manual reset via `R` (Shift+R) or `h` (hot reload) also zeroes MAIN stats.

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
| `d` | Toggle debug logging |
| `r` | Redraw screen |
| `R` | Reset MAIN cache stats (no reload) |
| `p` | Enter/exit pager mode (scrollback) |
| `s` | Print stats line to log |
| `h` | Reset MAIN stats + hot reload all `lib/*` modules |
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

`h` key triggers `reloadModules()`: resets MAIN cache stats, saves TUI state (log buffer, cache stats, pager state), closes the server, clears the require cache for `lib/*` modules, re-requires them (picking up file changes), restores TUI state into the fresh modules, and restarts the server on the same port. The process never exits — log buffer and terminal session are preserved.

## Notes

- No Windows/PowerShell-specific quirks in the code itself; ANSI escape codes work on Windows 10 1511+.
- The code handles SIGINT and SIGTERM for clean terminal restoration (raw mode exit).
- Response metrics are extracted from a sliding 1 MB tail buffer (`config.MAX_RESPONSE_BUF`) — only the last N bytes of streaming responses are kept.
- In pager mode, the header (rows 0–3) is still updated live via `paintHeader()` independently of the frozen log viewport.
- MAIN cache stats reset automatically on session change (auth key fingerprint mismatch) or manually via `R`/`h`.
