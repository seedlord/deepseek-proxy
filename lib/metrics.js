'use strict';

// ── Metrics extraction & CSV logging ──────────────────────────────

const fs   = require('fs');
const { LOG_FILE, CSV_HDR } = require('./config');

// ── CSV lifecycle (1.4, 4.7) ──────────────────────────────────────

function initCsv() {
  try {
    // 4.7: fs.accessSync instead of existsSync
    fs.accessSync(LOG_FILE, fs.constants.R_OK | fs.constants.W_OK);
    // File exists and is accessible — check header (1.4)
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(CSV_HDR.length);
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString('utf8').split('\n')[0];
    if (firstLine.trim() !== CSV_HDR.trim()) {
      // Header mismatch — rotate old file, create fresh
      const bak = LOG_FILE.replace(/\.csv$/, '.bak.csv');
      try { fs.renameSync(LOG_FILE, bak); } catch (_) { /* ignore */ }
      fs.writeFileSync(LOG_FILE, CSV_HDR, 'utf8');
    }
  } catch (_) {
    // File doesn't exist or inaccessible — create fresh
    try { fs.writeFileSync(LOG_FILE, CSV_HDR, 'utf8'); } catch (__) { /* best effort */ }
  }
}

// ── Metrics extraction (5.4: single usage-block parse, 5.7: iterator) ──

function extractMetrics(buffer) {
  let inputTokens     = 0;
  let cacheHits       = 0;
  let outputTokens    = 0;
  let reasoningTokens = 0;
  const toolNames     = new Set();

  // 5.7: use iterator directly (no intermediate array spread)
  for (const m of buffer.matchAll(/"type":"tool_use"[^}]*"name":"(\w+)"/g)) {
    toolNames.add(m[1]);
  }

  // 5.4: find "usage" JSON block and parse it directly (one scan)
  const usageIdx = buffer.lastIndexOf('"usage"');
  if (usageIdx !== -1) {
    let depth = 0, start = -1, end = -1;
    for (let i = usageIdx; i < buffer.length; i++) {
      if (buffer[i] === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (buffer[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (start !== -1 && end !== -1) {
      try {
        const usage = JSON.parse(buffer.slice(start, end));
        // DeepSeek uses input_tokens/output_tokens for thinking requests
        // but prompt_tokens/completion_tokens (OpenAI names) for think:none
        inputTokens    = usage.input_tokens || usage.prompt_tokens || 0;
        cacheHits      = usage.cache_read_input_tokens || usage.prompt_cache_hit_tokens
                      || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
        outputTokens   = usage.output_tokens || usage.completion_tokens || 0;
        reasoningTokens = usage.reasoning_tokens || 0;
      } catch (_) {
        // Fallback: regex extraction
        const im = buffer.match(/"input_tokens"\s*:\s*(\d+)/) ||
                   buffer.match(/"prompt_tokens"\s*:\s*(\d+)/);
        const cm = buffer.match(/"cache_read_input_tokens"\s*:\s*(\d+)/) ||
                   buffer.match(/"prompt_cache_hit_tokens"\s*:\s*(\d+)/);
        // 5.7: iterator for output_tokens
        let lastOut = 0;
        for (const om of buffer.matchAll(/"output_tokens"\s*:\s*(\d+)/g)) {
          lastOut = parseInt(om[1], 10);
        }
        if (lastOut > 0) outputTokens = lastOut;
        else {
          const x = buffer.match(/"completion_tokens"\s*:\s*(\d+)/);
          if (x) outputTokens = parseInt(x[1], 10);
        }
        if (im) inputTokens = parseInt(im[1], 10);
        if (cm) cacheHits   = parseInt(cm[1], 10);
      }
    }
  }

  const calls = toolNames.size > 0 ? [...toolNames].sort().join(',') : '-';
  return { inputTokens, cacheHits, outputTokens, reasoningTokens, calls };
}

// ── CSV escaping (4.6: RFC 4180) ──────────────────────────────────

function escapeCsv(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── Async CSV write (2a: non-blocking) ────────────────────────────

function writeCsvLine(fields) {
  const line = [
    new Date().toISOString(),
    escapeCsv(fields.role),
    escapeCsv(fields.agentId),
    escapeCsv(fields.model),
    escapeCsv(fields.thinkingType),
    escapeCsv(fields.thinkingBudget),
    escapeCsv(fields.maxTokens),
    escapeCsv(fields.msgCount),
    escapeCsv(fields.systemLen),
    escapeCsv(fields.lastTools),
    escapeCsv(fields.lastUserHint),
    escapeCsv(fields.callTools),
    fields.inputTokens,
    fields.cacheHits,
    fields.hitRate,
    fields.outputTokens,
    fields.reasoningTokens || 0,
  ].join(',') + '\n';

  // 2a: async append — never blocks the event loop
  fs.appendFile(LOG_FILE, line, 'utf8', (err) => {
    if (err) process.stderr.write('[csv] write error: ' + err.message + '\n');
  });
}

module.exports = { initCsv, extractMetrics, writeCsvLine };
