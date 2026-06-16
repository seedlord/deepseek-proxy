# DeepSeek Cache-Safe Proxy

A zero-dependency Node.js HTTP proxy that sits between the Claude Code VS Code extension and the DeepSeek API. It inspects, displays, and logs API traffic in a terminal TUI while forwarding requests — with optional subagent thinking overrides.

![Platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-lightgrey)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-orange)
![License](https://img.shields.io/badge/license-MIT-blue)
<br>🌐 [中文文档](README.cn.md)

![Screenshot](screenshot.png)

## Features

- **Live TUI** — Real-time header bar showing port, request count, model, session badge (project path, app type, git status), separate MAIN/SUB cache hit rates, toggle states (including debug TUI print), uptime, and keyboard shortcuts. Color-coded request/response lines with aligned columns.
- **Session metadata** — Extracts project directory, app type (`[vscode]` / `[cli]`), and git-repo status from the system prompt and request headers. Displayed as compact badges in the header.
- **Subagent thinking override** — Automatically injects the main agent's `thinking` and `output_config` into subagent requests so they inherit the main session's reasoning budget. Toggle on/off with a single keypress.
- **CSV metrics logging** — Records token usage (input, cache hits, output, reasoning), model info, thinking config, tool calls, and more per request. Async, non-blocking writes.
- **Compressed response support** — Transparently decompresses gzip/deflate/brotli responses (used by DeepSeek for `think:none` requests) before metrics extraction.
- **Separate cache tracking** — MAIN and SUB cache hit rates tracked independently per session (they have completely separate context caches).
- **Debug logging** — `d` enables comprehensive debug output to `proxy-debug.log`. `D` (Shift+D) toggles TUI visibility of debug lines independently.
- **Hot reload** — Reload all `lib/*` modules without restarting the process. Log buffer, session stats, and terminal state are preserved.
- **Pager mode** — Freeze the log and scroll through history with vim-like keys (`j`/`k`, `g`/`G`, `PgUp`/`PgDn`). Header stays live.
- **Session detection** — Automatically detects API key changes and creates separate session buckets with independent cache tracking.

## Quick Start

```bash
# Start the proxy (default port 4000)
node proxy.js

# Custom port
$env:PROXY_PORT=3000; node proxy.js   # PowerShell
PROXY_PORT=3000 node proxy.js         # bash
```

Then configure Claude Code to use `http://localhost:4000` as its API endpoint.

## Environment Variables

| Variable | Default | Description |
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
  ├── lib/config.js    — constants, env-var overrides, CSV header
  ├── lib/colors.js    — ANSI escapes, log tags, formatting helpers
  ├── lib/tui.js       — terminal UI: header bar, pager/scrollback, session/cache stats, throttled repaint
  ├── lib/inspector.js — parses Claude API JSON payloads to extract model/thinking/tool info
  └── lib/metrics.js   — extracts token usage from streaming response buffers, writes CSV
Output:
  ├── proxy-metrics.csv  — per-request token metrics
  └── proxy-debug.log    — full debug output (when debug mode is on)
```

**Request flow:** Client → HTTP server → body read with size cap → JSON parse → payload inspection + session metadata extraction (project dir, app type, git status) → session activation (via auth header fingerprint) → subagent thinking override (if applicable) → forward to DeepSeek via HTTPS keep-alive → streaming response → gzip decompression (if compressed) → metrics extraction from tail buffer → TUI log + per-session cache stats + CSV append + debug file log.

## HTTP Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/*` | Forward to DeepSeek (JSON body required) |
| `GET` | `/toggle` | Toggle subagent thinking override |
| `GET` | `/toggle-log` | Toggle CSV file logging |
| `GET` | `/toggle-debug` | Toggle debug logging |
| `GET` | `/health` | Health check (uptime, request count, toggle states) |
| `GET` | `/status` | Brief status (toggles + request count) |
| `GET` | `/metrics` | Download CSV log (503 if logging disabled) |

## Keyboard Controls

| Key | Action |
|---|---|
| `t` | Toggle subagent thinking override |
| `l` | Toggle CSV file logging |
| `d` | Toggle debug logging (file always, TUI off by default) |
| `D` | Toggle debug TUI print (only when debug mode is on) |
| `r` | Redraw screen |
| `R` | Reset MAIN cache stats (no reload) |
| `p` | Enter/exit pager mode (scrollback) |
| `s` | Print stats line to log |
| `h` | Reset MAIN stats + hot reload all `lib/*` modules |
| `q` | Quit |

### Pager Mode Keys

| Key | Action |
|---|---|
| `j` / `↓` | Scroll down one line |
| `k` / `↑` | Scroll up one line |
| `PageUp` | Scroll up 10 lines |
| `PageDown` | Scroll down 10 lines |
| `g` | Jump to top of log buffer |
| `G` | Jump to bottom (resume follow) |
| `p` / `q` / `Esc` | Exit pager, return to follow mode |

## CSV Output

Each request appends one row to the CSV log. Columns:

`timestamp, role, agentId, model, thinkingType, thinkingBudget, maxTokens, msgCount, systemLen, lastTools, lastUserHint, callTools, missTokens, cacheHitTokens, cacheHitPct, outputTokens, reasoningTokens`

- **role** — `MAIN` or `SUB` (subagent)
- **agentId** — first 8 chars of the agent ID
- **cacheHitPct** — cache hit rate for this individual request
- **reasoningTokens** — DeepSeek reasoning tokens (chain-of-thought)

## Requirements

- Node.js ≥ 18
- No npm dependencies — uses only `http`, `https`, `fs`, `readline`, `zlib` built-ins
- Terminal with ANSI support (Windows 10 1511+, macOS, Linux)

## License

MIT
