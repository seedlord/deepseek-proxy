'use strict';

// ── Terminal UI ────────────────────────────────────────────────────
// Manages the header bar, scrolling log buffer, and throttled repaint.

const readline = require('readline');
const {
  C, TAGS, shortModel, onOff, hrColor, statusColor,
  formatThinking, padEnd, padStart, padNum,
} = require('./colors');
const { MAX_BUF, HEADER_ROWS } = require('./config');

// ── Internal state ─────────────────────────────────────────────────
let logBuf           = [];
let repaintScheduled = false;
let mainHits         = 0;
let mainInput        = 0;
let subHits          = 0;
let subInput         = 0;
let subCount         = 0;
let mainSessionKey   = null;     // detects session changes for MAIN
let inflight         = 0;
let startTime        = Date.now();
let lastWasSeparator = false;  // 6d: avoid double-separators

// ── Pager / scrollback state ────────────────────────────────────────
let pagerMode    = false;   // true while user is browsing history
let scrollOffset = 0;       // lines scrolled back from the end (0 = follow mode)

// ── Helpers ────────────────────────────────────────────────────────

/** Visible length of a string (ANSI escape sequences stripped) */
function visibleLen(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Truncate string to maxWidth visible chars, preserving ANSI codes.
 *  Appends reset code to prevent color bleed. */
function truncateVisible(str, maxW) {
  if (maxW <= 0) return C.reset;
  let out       = '';
  let visible   = 0;
  let inEscape  = false;
  for (const ch of str) {
    if (ch === '\x1b') inEscape = true;
    if (!inEscape) {
      if (visible >= maxW) break;
      visible++;
    }
    out += ch;
    if (inEscape && ch === 'm') inEscape = false;
  }
  return out + C.reset;
}

/** Write a line, truncated to terminal width so it never wraps.
 *  Wrapped lines cannot be cleared by clearLine(), causing ghost artifacts. */
function writeLine(str) {
  const maxW = (process.stdout.columns || 80) - 1;  // -1 safety margin
  const out  = visibleLen(str) > maxW ? truncateVisible(str, maxW) : str;
  process.stdout.write(out);
  readline.clearLine(process.stdout, 1);  // clear cursor → EOL
  process.stdout.write('\n');
}

// ── Repaint (5.6: throttled via setImmediate) ─────────────────────

function repaint() {
  repaintScheduled = false;
  try {
    const termH = process.stdout.rows || 40;
    const logH  = Math.max(1, termH - HEADER_ROWS);
    let visible;
    if (scrollOffset > 0) {
      const total = logH + scrollOffset;
      visible = logBuf.slice(logBuf.length > total ? -total : 0,
                             -scrollOffset || undefined);
    } else {
      visible = logBuf.slice(-logH);
    }
    readline.cursorTo(process.stdout, 0, HEADER_ROWS);
    readline.clearScreenDown(process.stdout);
    for (const line of visible) writeLine(line);
  } catch (_) { /* display error — proxy still works */ }
}

function scheduleRepaint() {
  // 5.6: at most one repaint per event-loop tick
  if (!repaintScheduled) {
    repaintScheduled = true;
    setImmediate(repaint);
  }
}

// ── Public logging ─────────────────────────────────────────────────

function logLine(s) {
  logBuf.push(s);
  if (logBuf.length > MAX_BUF) {
    logBuf.shift();
    if (scrollOffset > 0) scrollOffset--;
  }
  lastWasSeparator = false;
  if (scrollOffset > 0) scrollOffset++;  // new entry at bottom shifts view up
  scheduleRepaint();
}

/** 6d: thin separator line between request blocks */
function separator() {
  if (lastWasSeparator) return;
  lastWasSeparator = true;  // set early: logLine will clear it, we restore after
  const w = Math.min(60, (process.stdout.columns || 80) - 12);
  logLine(C.dim + '  ─' + '─'.repeat(w) + C.reset);
  lastWasSeparator = true;  // logLine set it to false — restore
}

// ── Header (6a: compact 4-line, 6b: avg hit rate, 6f: activity) ──

function paintHeader(state) {
  try {
    const w = process.stdout.columns || 80;
    const bar = C.bold + C.blue + '═'.repeat(w) + C.reset;
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const uptimeStr = Math.floor(uptimeSec / 3600) + 'h' +
      String(Math.floor((uptimeSec % 3600) / 60)).padStart(2, '0') + 'm';
    const mainHit = mainInput > 0
      ? ((mainHits / mainInput) * 100).toFixed(1)
      : '—';
    const subHit = subInput > 0
      ? ((subHits / subInput) * 100).toFixed(1)
      : null;
    // Build hit display: always show MAIN, append SUB only if requests exist
    const hitDisplay = C.gray + 'Hit:' + C.reset + ' ' +
      C.cyan + 'M:' + C.reset + hrColor(mainHit) +
      (subHit !== null
        ? C.gray + '  S:' + C.reset + hrColor(subHit)
        : '');
    // 6f: activity indicator
    const activity = inflight > 0
      ? C.green + ' ● active' + C.reset
      : C.dim   + ' ○ idle'   + C.reset;

    // Clear only header rows (0..HEADER_ROWS-1) — preserve log area
    for (let r = 0; r < HEADER_ROWS; r++) {
      readline.cursorTo(process.stdout, 0, r);
      readline.clearLine(process.stdout, 0);
    }
    readline.cursorTo(process.stdout, 0, 0);
    writeLine(bar);
    writeLine(
      ' ' + C.bold + C.cyan + 'DeepSeek Proxy' + C.reset +
      '  ' + C.gray + 'Port:'   + C.reset + ' ' + C.bold + state.port        + C.reset +
      '  ' + C.gray + 'Req:'    + C.reset + ' ' + C.yellow + state.reqCount  + C.reset +
      '  ' + C.gray + 'Model:'  + C.reset + ' ' + C.cyan + state.lastModel   + C.reset +
      '  ' + hitDisplay +
      '  ' + activity
    );
    writeLine(
      ' ' + C.gray + 'Think:'   + C.reset + ' ' + onOff(state.forceSubagentThinking) +
      '  ' + C.gray + 'Log:'    + C.reset + ' ' + onOff(state.fileLogging) +
      '  ' + C.gray + 'Debug:'  + C.reset + ' ' + onOff(state.debugLogging) +
      '  ' + C.gray + 'Up:'     + C.reset + ' ' + C.dim + uptimeStr + C.reset +
      (pagerMode
        ? '  ' + C.bold + C.yellow + '[PAGER]' + C.reset + ' ' +
          C.cyan + 'j' + C.reset + '↓ ' +
          C.cyan + 'k' + C.reset + '↑ ' +
          C.cyan + 'g' + C.reset + '⇑ ' +
          C.cyan + 'G' + C.reset + '⇓ ' +
          C.cyan + 'p/q' + C.reset + ' exit'
        : '  ' + C.gray + 'Keys ' + C.reset +
          C.cyan + 't' + C.reset + 'hink ' +
          C.cyan + 'l' + C.reset + 'og ' +
          C.cyan + 'd' + C.reset + 'bg ' +
          C.cyan + 'r' + C.reset + 'edraw ' +
          C.cyan + 'R' + C.reset + 'eset ' +
          C.cyan + 'p' + C.reset + 'ager ' +
          C.cyan + 's' + C.reset + 'tats ' +
          C.cyan + 'h' + C.reset + 'otload ' +
          C.cyan + 'q' + C.reset + 'uit')
    );
    writeLine(bar);
  } catch (_) { /* display error — ignore */ }
}

// ── Unified request logging (3.1: MAIN/SUB dedup) ─────────────────

/**
 * Log a request line. syncTag is:
 *   - for MAIN: a dim spacer  (C.dim + '----' + C.reset)
 *   - for SUB:  sync/off tag  (C.green+'sync'+C.reset or C.yellow+'off'+C.reset)
 */
function logRequest(tag, info, reqNum, syncTag) {
  // 6d: separator before each request block (not the very first)
  if (reqNum > 1) separator();

  const tokVal = info.maxTokens ? Math.round(info.maxTokens / 1000) + 'k' : '-';
  // effort controls reasoning depth (high/max) — only param DeepSeek actually respects
  const effortVal = info.effort && info.effort !== '?' ? info.effort : '-';

  // 6c: timestamp prefix
  const ts = C.gray + new Date().toLocaleTimeString('de-DE', { hour12: false }) + C.reset;

  logLine(
    ts + ' ' + tag + ' ' + C.cyan + '>' + C.reset + C.gray + '#' + padStart(reqNum, 3) + C.reset + ' ' +
    C.cyan   + padEnd(shortModel(info.model), 10) + C.reset + ' ' +
    // 3: expanded abbreviations
    C.gray   + 'msg:' + C.reset + C.yellow + padStart(info.msgCount, 3)   + C.reset + '  ' +
    C.gray   + 'think:' + C.reset + C.yellow + padEnd(info.thinkingType, 9) + C.reset + ' ' +
    C.gray   + 'eff:' + C.reset + C.magenta + padEnd(effortVal, 4)       + C.reset + '  ' +
    C.gray   + 'maxtok:' + C.reset + C.yellow + padEnd(tokVal, 5)         + C.reset + '  ' +
    syncTag + ' ' +
    C.gray   + 'tools:' + C.reset + C.cyan    + padEnd(info.lastAssistantTools, 18) + C.reset + ' ' +
    C.gray   + 'in:'    + C.reset + C.magenta + padEnd(info.lastUserHint, 27)       + C.reset
  );
}

// ── Metrics response line (6e: HTTP status color) ──────────────────

function logMetrics(reqNum, inputTokens, cacheHits, totalInput, outputTokens, calls, statusCode, reasoningTokens) {
  const hitRate = totalInput > 0 ? ((cacheHits / totalInput) * 100).toFixed(1) : '0.0';
  const indent  = '        ';  // aligns with tags above
  // 4: ctx = total context window size
  const ctxPart = C.gray + 'ctx:' + C.reset + C.cyan + padNum(totalInput, 7) + C.reset + '  ';
  // 5: reasoning tokens (only show if > 0)
  const reasonPart = reasoningTokens > 0
    ? C.gray + 'reason:' + C.reset + C.magenta + padNum(reasoningTokens, 6) + C.reset + '  '
    : '';
  logLine(
    indent + C.cyan + '<' + C.reset + C.gray + '#' + padStart(reqNum, 3) + C.reset + '  ' +
    // 6e: color-coded HTTP status
    statusColor(statusCode) + '  ' +
    ctxPart +
    C.gray + 'miss:' + C.reset + C.yellow + padNum(inputTokens,  7) + C.reset + '  ' +
    C.gray + 'hit:'  + C.reset + C.green  + padNum(cacheHits,    7) + C.reset +
    ' (' + hrColor(hitRate.padStart(6)) + ')  ' +
    C.gray + 'out:'   + C.reset + C.cyan   + padStart(outputTokens, 5) + C.reset + '  ' +
    C.gray + 'calls:' + C.reset + C.yellow + padEnd(calls, 18)         + C.reset + '  ' +
    reasonPart
  );
}

// ── Error helper (3.5) ─────────────────────────────────────────────

function logError(context, err) {
  logLine(TAGS.ERR + context + ': ' + (err ? err.message : 'unknown'));
}

// ── Stats tracking (6b) ────────────────────────────────────────────

function addCacheStats(isSub, hits, total) {
  if (isSub) {
    subHits  += hits;
    subInput += total;
    subCount++;
  } else {
    mainHits  += hits;
    mainInput += total;
  }
}

/** Called before a MAIN request. If sessionKey changed, log previous
 *  session stats and reset MAIN counters for the new session. */
function checkMainSession(sessionKey) {
  if (mainSessionKey !== null && sessionKey !== mainSessionKey) {
    const prevHit = mainInput > 0
      ? ((mainHits / mainInput) * 100).toFixed(1)
      : '—';
    logLine(
      TAGS.SYS + 'Session ended | MAIN hit: ' + hrColor(prevHit) +
      C.gray + ' (' + mainInput.toLocaleString('en') + ' input)' + C.reset
    );
    separator();
    mainHits  = 0;
    mainInput = 0;
  }
  mainSessionKey = sessionKey;
}

/** Manual reset of MAIN cache stats (no session-change log). */
function resetMainStats() {
  mainHits  = 0;
  mainInput = 0;
}

function inflightInc() { inflight++; }
function inflightDec() { inflight--; }

/** Force an immediate repaint (for terminal resize, manual refresh) */
function forceRepaint() {
  try {
    const termH = process.stdout.rows || 40;
    const logH  = Math.max(1, termH - HEADER_ROWS);
    let visible;
    if (scrollOffset > 0) {
      const total = logH + scrollOffset;
      visible = logBuf.slice(logBuf.length > total ? -total : 0,
                             -scrollOffset || undefined);
    } else {
      visible = logBuf.slice(-logH);
    }
    readline.cursorTo(process.stdout, 0, HEADER_ROWS);
    readline.clearScreenDown(process.stdout);
    for (const line of visible) writeLine(line);
  } catch (_) { /* ignore */ }
}

// ── Pager / scrollback ──────────────────────────────────────────────

function enterPager() {
  if (pagerMode) return;
  pagerMode    = true;
  scrollOffset = 0;
}

function exitPager() {
  pagerMode    = false;
  scrollOffset = 0;
  forceRepaint();
}

function isPagerMode() {
  return pagerMode;
}

function scrollUp(n) {
  if (!pagerMode) return;
  const termH = process.stdout.rows || 40;
  const logH  = Math.max(1, termH - HEADER_ROWS);
  const maxOff = Math.max(0, logBuf.length - logH);
  scrollOffset = Math.min(maxOff, scrollOffset + n);
  forceRepaint();
}

function scrollDown(n) {
  if (!pagerMode) return;
  scrollOffset = Math.max(0, scrollOffset - n);
  if (scrollOffset === 0) forceRepaint();  // back to follow — keep pager on
  else forceRepaint();
}

function scrollTop() {
  if (!pagerMode) return;
  const termH = process.stdout.rows || 40;
  const logH  = Math.max(1, termH - HEADER_ROWS);
  scrollOffset = Math.max(0, logBuf.length - logH);
  forceRepaint();
}

function scrollBottom() {
  if (!pagerMode) return;
  scrollOffset = 0;
  forceRepaint();
}

// ── Hot reload support ──────────────────────────────────────────────

function _saveState() {
  return {
    logBuf:           [...logBuf],
    mainHits,
    mainInput,
    subHits,
    subInput,
    subCount,
    mainSessionKey,
    inflight,
    startTime,
    lastWasSeparator,
    pagerMode,
    scrollOffset,
  };
}

function _restoreState(state) {
  logBuf           = state.logBuf || [];
  mainHits         = state.mainHits || 0;
  mainInput        = state.mainInput || 0;
  subHits          = state.subHits || 0;
  subInput         = state.subInput || 0;
  subCount         = state.subCount || 0;
  mainSessionKey   = state.mainSessionKey || null;
  inflight         = state.inflight || 0;
  startTime        = state.startTime || Date.now();
  lastWasSeparator = state.lastWasSeparator || false;
  pagerMode        = state.pagerMode || false;
  scrollOffset     = state.scrollOffset || 0;
  repaintScheduled = false;
}

// ── Export ─────────────────────────────────────────────────────────

module.exports = {
  paintHeader, logLine, logRequest, logMetrics, logError, separator,
  addCacheStats, checkMainSession, resetMainStats, inflightInc, inflightDec, forceRepaint,
  enterPager, exitPager, isPagerMode, scrollUp, scrollDown, scrollTop, scrollBottom,
  _saveState, _restoreState,
};
