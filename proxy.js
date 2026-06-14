'use strict';

// ── DeepSeek Cache-Safe Proxy ─────────────────────────────────────
// Orchestrator: HTTP server, proxy forwarding, keyboard control.
// All display logic → lib/tui.js
// All metrics/CSV   → lib/metrics.js
// All payload insp. → lib/inspector.js

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const readline = require('readline');

let config = require('./lib/config');
let colors = require('./lib/colors');
let { C, TAGS, onOff } = colors;
let tui = require('./lib/tui');
let inspector = require('./lib/inspector');
let { inspectPayload } = inspector;
let metrics = require('./lib/metrics');
let { initCsv, extractMetrics, writeCsvLine } = metrics;

/** Derive a stable session fingerprint from the authorization header.
 *  Uses last 8 chars of the token — different API keys → different sessions. */
function sessionFingerprint(authHeader) {
  if (!authHeader) return 'anon';
  const parts = authHeader.split(' ');
  const token = parts.length === 2 ? parts[1] : authHeader;
  return token.slice(-8);
}

// ── Application state ──────────────────────────────────────────────
let forceSubagentThinking = true;
let fileLogging           = true;
let debugLogging          = false;
let reqCount              = 0;
let lastModel             = '?';
let lastMainThinking      = { type: 'adaptive' };
let lastMainOutputConfig  = { effort: 'high' };

const keepAliveAgent = new https.Agent({
  keepAlive: true, maxSockets: 150, keepAliveMsecs: 5000,
});

// ── Helpers ────────────────────────────────────────────────────────

function isSubagent(req) {
  return !!req.headers['x-claude-code-agent-id'];
}

/** Build the state snapshot for the TUI header */
function getState() {
  return {
    reqCount, lastModel, forceSubagentThinking, fileLogging, debugLogging,
    port: config.PORT,
  };
}

/** Mask Authorization header value for safe logging (2f) */
function maskAuth(headers) {
  const masked = { ...headers };
  if (masked.authorization) {
    const parts = masked.authorization.split(' ');
    if (parts.length === 2) masked.authorization = parts[0] + ' ***';
    else masked.authorization = '***';
  }
  // Also mask any x-api-key style headers
  for (const k of Object.keys(masked)) {
    if (/^(x-)?api[_-]?key$/i.test(k)) masked[k] = '***';
  }
  return masked;
}

// ── Toggle routes (3.3: unified map) ───────────────────────────────

const TOGGLES = {
  '/toggle':       { get: () => forceSubagentThinking, set: (v) => { forceSubagentThinking = v; }, name: 'thinking' },
  '/toggle-log':   { get: () => fileLogging,           set: (v) => { fileLogging = v; },           name: 'file logging' },
  '/toggle-debug': { get: () => debugLogging,          set: (v) => { debugLogging = v; },          name: 'debug logging' },
};

// ── Forward request to DeepSeek ────────────────────────────────────

function forwardToDeepSeek(req, res, body, clientPath, meta) {
  const isTokenCount = clientPath.includes('count_tokens');

  // Guard against double inflightDec (timeout → destroy → error chain)
  let inflightDecd = false;
  function decInflight() {
    if (!inflightDecd) {
      inflightDecd = true;
      tui.inflightDec();
    }
  }

  tui.inflightInc();
  tui.paintHeader(getState());

  // 2d / 4.2: inbound request timeout
  req.setTimeout(config.SERVER_TIMEOUT, () => {
    if (!res.headersSent) {
      res.writeHead(408, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request timeout' }));
    }
    req.destroy();
  });

  // Mask auth for header forwarding (2f: never log raw key)
  const fwdHeaders = { ...req.headers, host: config.DEEPSEEK_HOST };
  fwdHeaders['content-length'] = Buffer.byteLength(body);

  // Strip Claude-specific hop-by-hop headers that confuse DeepSeek
  delete fwdHeaders['x-claude-code-agent-id'];

  const proxyReq = https.request({
    host: config.DEEPSEEK_HOST,
    port: 443,
    path: clientPath,
    method: 'POST',
    headers: fwdHeaders,
    agent: keepAliveAgent,
  }, (proxyRes) => {
    const statusCode = proxyRes.statusCode || 502;

    // 6e: log non-200 status prominently
    if (statusCode >= 400 && !isTokenCount) {
      tui.logLine(TAGS.ERR + 'Upstream responded ' + statusCode);
    }

    // Strip hop-by-hop headers from upstream response
    const HOP_BY_HOP = new Set([
      'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
      'upgrade', 'proxy-authenticate', 'proxy-authorization',
    ]);
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) {
        fwdHeaders[k] = v;
      }
    }
    res.writeHead(statusCode, fwdHeaders);

    // ── Response accumulation (5.2: capped buffer) ─────────────────
    let buf          = '';
    const toolNames  = new Set();
    const MAX_BUF    = config.MAX_RESPONSE_BUF;

    proxyRes.on('data', (chunk) => {
      res.write(chunk);

      if (isTokenCount) return;

      // Incrementally capture tool names
      const chunkStr = chunk.toString('utf8');
      for (const m of chunkStr.matchAll(/"type":"tool_use"[^}]*"name":"(\w+)"/g)) {
        toolNames.add(m[1]);
      }

      // 5.2: true sliding window — always append, keep only last MAX_BUF bytes
      buf += chunkStr;
      if (buf.length > MAX_BUF) {
        buf = buf.slice(buf.length - MAX_BUF);
      }
    });

    proxyRes.on('end', () => {
      res.end();
      decInflight();

      if (isTokenCount) {
        tui.paintHeader(getState());
        return;
      }

      try {
        // Extract metrics from the buffered tail
        const m = metrics.extractMetrics(buf);

        // Merge incrementally captured tool names
        const allTools = new Set(toolNames);
        if (m.calls !== '-') {
          m.calls.split(',').forEach(n => allTools.add(n));
        }
        const calls = allTools.size > 0 ? [...allTools].sort().join(',') : '-';

        const totalInput = m.inputTokens + m.cacheHits;
        const hitRate = totalInput > 0
          ? ((m.cacheHits / totalInput) * 100).toFixed(1)
          : '0.0';

        // TUI output
        tui.logMetrics(meta.reqNum, m.inputTokens, m.cacheHits,
          totalInput, m.outputTokens, calls, statusCode, m.reasoningTokens);
        tui.addCacheStats(meta.fingerprint, meta.isSub, m.cacheHits, totalInput);
        tui.paintHeader(getState());

        // Debug: usage blocks without output
        if (debugLogging && totalInput > 0 && m.outputTokens === 0) {
          const ub = buf.match(/"usage"\s*:\s*\{[^}]+\}/g);
          if (ub && ub.length > 0) {
            tui.logLine(TAGS.DEBUG + ' usage blocks without output: ' + ub.join(' | '));
          }
        }

        // CSV logging (2a: async, non-blocking)
        if (fileLogging) {
          metrics.writeCsvLine({
            role: meta.isSub ? 'SUB' : 'MAIN',
            agentId: meta.agentId.substring(0, 8),
            model: meta.info.model,
            thinkingType: meta.info.thinkingType,
            thinkingBudget: meta.info.thinkingBudget,
            maxTokens: meta.info.maxTokens,
            msgCount: meta.info.msgCount,
            systemLen: meta.info.systemLen,
            lastTools: meta.info.lastAssistantTools,
            lastUserHint: meta.info.lastUserHint,
            callTools: calls,
            inputTokens: m.inputTokens,
            cacheHits: m.cacheHits,
            hitRate: hitRate,
            outputTokens: m.outputTokens,
            reasoningTokens: m.reasoningTokens,
          });
        }
      } catch (e) {
        tui.logError('Metrics', e);
      }
    });

    proxyRes.on('error', (err) => {
      tui.logError('Response stream', err);
      if (!res.writableEnded) res.end();
      decInflight();
      tui.paintHeader(getState());
    });
  });

  // 2d / 4.3: outbound request timeout
  proxyReq.setTimeout(config.REQUEST_TIMEOUT, () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream timeout' }));
    } else {
      // 2c: headers already sent — destroy so client doesn't hang
      res.destroy();
    }
    decInflight();
    tui.logError('Upstream', new Error('Request timeout after ' + (config.REQUEST_TIMEOUT / 1000) + 's'));
    tui.paintHeader(getState());
  });

  // 2c: proxy request error (connection refused, DNS, etc.)
  proxyReq.on('error', (err) => {
    tui.logError('Proxy request', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Gateway: ' + err.message }));
    } else {
      // 2c: headers already sent — destroy connection so client doesn't hang
      res.destroy();
    }
    decInflight();
    tui.paintHeader(getState());
  });

  proxyReq.write(body);
  proxyReq.end();
}

// ── HTTP Server ────────────────────────────────────────────────────

let server;

function createServer() {
  return http.createServer((req, res) => {
  // Handle client socket errors to prevent process crash
  req.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Request' }));
    }
  });
  res.on('error', (_) => { /* client disconnected — ignore */ });

  // ── GET routes ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    // 3.3: unified toggle handling
    const toggle = TOGGLES[req.url];
    if (toggle) {
      const newVal = !toggle.get();
      toggle.set(newVal);
      tui.logLine(TAGS.API + 'Toggle ' + toggle.name + ': ' + onOff(newVal));
      tui.paintHeader(getState());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, [toggle.name]: newVal }));
    }

    // 4.4: health endpoint
    if (req.url === '/health') {
      const uptime = Math.floor(process.uptime());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        reqCount,
        forceSubagentThinking,
        fileLogging,
        debugLogging,
      }));
    }

    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        forceSubagentThinking, fileLogging, debugLogging, reqCount,
      }));
    }

    // CSV download — async to avoid blocking event loop
    if (req.url === '/metrics') {
      if (!fileLogging) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'File logging is disabled' }));
      }
      fs.readFile(config.LOG_FILE, 'utf8', (err, csv) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Could not read metrics file' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(csv);
        }
      });
      return;
    }

    // Fallback 404 for unknown GET routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not Found' }));
  }

  // ── Only POST beyond this point ──────────────────────────────────
  if (req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not Found' }));
  }

  // ── Read body with size limit (2b, 4.5) ──────────────────────────
  const chunks = [];
  let totalSize = 0;

  req.on('data', (chunk) => {
    totalSize += chunk.length;
    // 2b: enforce max body size
    if (totalSize > config.MAX_BODY_SIZE) {
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large', maxBytes: config.MAX_BODY_SIZE }));
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    // If request was destroyed (size limit), stop
    if (req.destroyed) return;

    // 4.5: Buffer.concat instead of string +=
    const body = Buffer.concat(chunks).toString('utf8');
    const clientPath = req.url;
    const isTokenCount = clientPath.includes('count_tokens');
    const sub = isSubagent(req);
    const agentId = req.headers['x-claude-code-agent-id'] || 'main';

    // ── Token count: forward directly, no inspection ───────────────
    if (isTokenCount) {
      tui.logLine(TAGS.SYS + 'Token count forwarded');
      forwardToDeepSeek(req, res, body, clientPath, {
        isSub: sub, reqNum: 0, info: null, agentId,
      });
      return;
    }

    // ── Parse & inspect (3.4: parse always needed for display) ─────
    let jsonPayload;
    try {
      jsonPayload = JSON.parse(body);
    } catch (e) {
      tui.logError('JSON parse', e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

    reqCount++;
    const reqNum = reqCount;
    const info = inspectPayload(jsonPayload);
    const fp = sessionFingerprint(req.headers.authorization);

    if (!sub) {
      lastModel = info.model;
      // Route MAIN request to its session bucket (lookup-or-create by fingerprint)
      tui.activateSession(fp, info.model);
    }

    // ── Subagent thinking override ──────────────────────────────────
    // 3.4: only stringify when payload was actually modified
    let modifiedBody = body;
    if (!sub) {
      // MAIN: capture current thinking config for future SUB requests
      if (jsonPayload.thinking)     lastMainThinking     = jsonPayload.thinking;
      if (jsonPayload.output_config) lastMainOutputConfig = jsonPayload.output_config;

      // Log MAIN request (3.1: unified via logRequest)
      tui.logRequest(TAGS.MAIN, info, reqNum, C.dim + '----' + C.reset + ' ');

    } else {
      // SUB: optionally override thinking for FORWARDING only (display shows original)
      if (forceSubagentThinking) {
        jsonPayload.thinking      = lastMainThinking;
        jsonPayload.output_config = lastMainOutputConfig;
      } else {
        jsonPayload.thinking = { type: 'disabled' };
        if (jsonPayload.output_config) delete jsonPayload.output_config;
      }
      modifiedBody = JSON.stringify(jsonPayload);

      // Log SUB request — ORIGINAL info + what we forwarded
      let fwdTag;
      if (forceSubagentThinking) {
        const ft = (lastMainThinking && lastMainThinking.type) || '?';
        const fe = (lastMainOutputConfig && lastMainOutputConfig.effort) || '?';
        fwdTag = C.green + '→' + ft + '/' + fe + C.reset;
      } else {
        fwdTag = C.yellow + '→disabled' + C.reset;
      }
      tui.logRequest(TAGS.SUB, info, reqNum, fwdTag + ' ');
    }

    // ── Debug: log masked headers ──────────────────────────────────
    if (debugLogging && !isTokenCount) {
      const masked = maskAuth(req.headers);
      tui.logLine(TAGS.DEBUG + ' headers: ' +
        JSON.stringify(masked).substring(0, 200));
    }

    // ── Forward ────────────────────────────────────────────────────
    forwardToDeepSeek(req, res, modifiedBody, clientPath, {
      isSub: sub, reqNum, info, agentId, fingerprint: fp,
    });
  });
});
}

// ── Terminal resize (debounced) ────────────────────────────────────

let resizeTimer = null;
function handleResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    try {
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      tui.paintHeader(getState());
      tui.forceRepaint();
    } catch (_) { /* ignore */ }
  }, 250);
}

// ── Keyboard handler ────────────────────────────────────────────────

function handleKey(key) {
  const raw = key.toString();
  const k = raw.toLowerCase();

  // ── Pager mode keys (capture first, before normal keys) ──────────
  if (tui.isPagerMode()) {
    if (k === 'q' || k === 'p' || raw === '\x1b') {  // q/p/Esc → exit pager
      tui.exitPager();
      tui.paintHeader(getState());
      return;
    }
    if (k === 'j')      { tui.scrollDown(1); tui.paintHeader(getState()); return; }
    if (k === 'k')      { tui.scrollUp(1);   tui.paintHeader(getState()); return; }
    if (raw === 'G')    { tui.scrollBottom(); tui.paintHeader(getState()); return; }  // Shift+g
    if (k === 'g')      { tui.scrollTop();    tui.paintHeader(getState()); return; }
    // Arrow keys (escape sequences) — Up/Down for scroll
    if (raw === '\x1b[A') { tui.scrollUp(1);   tui.paintHeader(getState()); return; }
    if (raw === '\x1b[B') { tui.scrollDown(1); tui.paintHeader(getState()); return; }
    if (raw === '\x1b[5~') { tui.scrollUp(10);  tui.paintHeader(getState()); return; }  // PageUp
    if (raw === '\x1b[6~') { tui.scrollDown(10); tui.paintHeader(getState()); return; }  // PageDown
    return;  // swallow all other keys in pager mode
  }

  // ── Normal mode keys ─────────────────────────────────────────────
  if (raw === 'R') {
    // Shift+R: manual MAIN cache stats reset (no reload)
    tui.resetMainStats();
    tui.logLine(TAGS.CLI + 'MAIN cache stats reset');
    tui.paintHeader(getState());
    return;
  }
  if (k === 'p') {
    tui.enterPager();
    tui.paintHeader(getState());
    return;
  }
  if (k === 't') {
    forceSubagentThinking = !forceSubagentThinking;
    tui.logLine(TAGS.CLI + 'Subagent Thinking > ' + onOff(forceSubagentThinking));
    tui.paintHeader(getState());
  } else if (k === 'l') {
    fileLogging = !fileLogging;
    tui.logLine(TAGS.CLI + 'File Logging > ' + onOff(fileLogging));
    tui.paintHeader(getState());
  } else if (k === 'd') {
    debugLogging = !debugLogging;
    tui.logLine(TAGS.CLI + 'Debug Logging > ' + onOff(debugLogging));
    tui.paintHeader(getState());
  } else if (k === 'r') {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    tui.paintHeader(getState());
    tui.forceRepaint();
  } else if (k === 's') {
    tui.logLine(TAGS.CLI +
      'Req#: ' + reqCount +
      ' | Thinking: ' + onOff(forceSubagentThinking) +
      ' | FileLog: ' + onOff(fileLogging) +
      ' | Debug: ' + onOff(debugLogging));
    tui.paintHeader(getState());
  } else if (k === 'h') {
    // Hot reload: reload code modules, preserve all session stats
    reloadModules();
  } else if (k === 'q') {
    tui.logLine(TAGS.CLI + 'Shutting down.');
    shutdown();
  }
}

// ── Hot reload ──────────────────────────────────────────────────────

function reloadModules() {
  tui.logLine(TAGS.SYS + 'Hot reloading...');

  // Save TUI state so log buffer and stats survive the reload
  const tuiState = tui._saveState();

  // Remove listeners before restart
  process.stdin.removeListener('data', handleKey);
  process.stdout.removeListener('resize', handleResize);

  // Close old server (keep-alive sockets will time out naturally)
  server.close();

  // Clear require cache for project modules
  for (const key of Object.keys(require.cache)) {
    if (key.includes('deepseekproxy\\lib\\') || key.includes('deepseekproxy/lib/')) {
      delete require.cache[key];
    }
  }

  // Re-require all modules (picks up file changes)
  config    = require('./lib/config');
  colors    = require('./lib/colors');
  ({ C, TAGS, onOff } = colors);
  tui       = require('./lib/tui');
  inspector = require('./lib/inspector');
  ({ inspectPayload } = inspector);
  metrics   = require('./lib/metrics');
  ({ initCsv, extractMetrics, writeCsvLine } = metrics);

  // Restore TUI state into fresh module
  tui._restoreState(tuiState);

  // Restart
  startProxy();
}

// ── Startup ────────────────────────────────────────────────────────

function startProxy() {
  // Re-init CSV in case LOG_FILE changed via config reload
  metrics.initCsv();

  server = createServer();
  server.timeout = config.SERVER_TIMEOUT;
  server.on('error', (err) => {
    tui.logError('Server', err);
  });

  // Set up resize listener
  process.stdout.on('resize', handleResize);

  server.listen(config.PORT, () => {
    // Clear screen & paint TUI
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    tui.paintHeader(getState());

    // Set up keyboard controls (remove old listener first to avoid duplicates)
    process.stdin.removeListener('data', handleKey);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKey);

    tui.logLine(TAGS.SYS + 'Proxy listening on port ' + config.PORT);
    tui.logLine(TAGS.SYS + 'Forwarding to ' + config.DEEPSEEK_HOST);
    tui.logLine(TAGS.CLI + 'Keys: ' +
      C.cyan + 't' + C.reset + 'hink ' +
      C.cyan + 'l' + C.reset + 'og ' +
      C.cyan + 'd' + C.reset + 'bg ' +
      C.cyan + 'r' + C.reset + 'edraw ' +
      C.cyan + 'R' + C.reset + 'eset ' +
      C.cyan + 'p' + C.reset + 'ager ' +
      C.cyan + 's' + C.reset + 'tats ' +
      C.cyan + 'h' + C.reset + 'otload ' +
      C.cyan + 'q' + C.reset + 'uit');
  });
}

// ── Process lifecycle ───────────────────────────────────────────────

function cleanup(cb) {
  // 2e: restore terminal before exit
  try {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  } catch (_) { /* already cleaned up */ }
  server.close(cb || (() => {}));
}

/** Graceful shutdown: drain active connections, force-kill after 3 s */
function shutdown() {
  cleanup(() => {
    try { process.stdout.write('\n'); } catch (_) { /* ignore */ }
    process.exit(0);
  });
  // Safety net — force exit if graceful shutdown hangs
  setTimeout(() => process.exit(1), 3000).unref();
}

// Handle both SIGINT and SIGTERM gracefully
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// Kick off
startProxy();
