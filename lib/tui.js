'use strict';

// ── Terminal UI ────────────────────────────────────────────────────
// Manages the header bar, scrolling log buffer, and throttled repaint.
// Session-based cache tracking — each API-key fingerprint gets
// its own MAIN/SUB stats bucket. Concurrent sessions supported.

const readline = require('readline');
const {
  C, TAGS, shortModel, onOff, hrColor, statusColor,
  formatThinking, padEnd, padStart, padNum,
} = require('./colors');
const { MAX_BUF, HEADER_ROWS } = require('./config');

// ── Internal state ─────────────────────────────────────────────────
let logBuf           = [];
let repaintScheduled = false;
let sessions         = new Map();  // fingerprint → { id, key, mainHits, mainInput, subHits, subInput, subCount, model, startTime, reqCount }
let sessionOrder     = [];         // fingerprints in order of first appearance
let currentKey       = null;       // fingerprint of the most recent MAIN request
let sessionCounter   = 0;          // monotonically increasing session number
let inflight         = 0;
let startTime        = Date.now();
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
 *  Wrapped lines cannot be cleared by clearLine(), causing ghost artifacts.
 *  Pass knownLen to skip the regex-based visibleLen scan (cached for repaint). */
function writeLine(str, knownLen) {
  const maxW = (process.stdout.columns || 80) - 1;  // -1 safety margin
  const vLen  = knownLen !== undefined ? knownLen : visibleLen(str);
  const out   = vLen > maxW ? truncateVisible(str, maxW) : str;
  process.stdout.write(out);
  readline.clearLine(process.stdout, 1);  // clear cursor → EOL
  process.stdout.write('\n');
}

// ── Session helpers ────────────────────────────────────────────────

/** Get or create a session for the given auth fingerprint. */
function ensureSession(fp) {
  if (!sessions.has(fp)) {
    sessionCounter++;
    sessions.set(fp, {
      id: sessionCounter,
      key: fp,
      mainHits: 0, mainInput: 0,
      subHits: 0, subInput: 0, subCount: 0,
      model: '?', startTime: Date.now(), reqCount: 0,
      projectDir: '', appType: '', isGit: false,
    });
    sessionOrder.push(fp);
    const shortKey = fp.length > 4 ? fp.slice(-4) : fp;
    logLine(TAGS.SYS + 'New session #' + sessionCounter + ' ' + C.gray + '…' + shortKey + C.reset);
  }
  return sessions.get(fp);
}

/** Called on every MAIN request: sets this fingerprint as current and
 *  updates the session's model + request counter. */
function activateSession(fp, model, projectDir, appType, isGit) {
  currentKey = fp;
  const s = ensureSession(fp);
  s.model = model;
  s.reqCount++;
  if (projectDir && !s.projectDir) {
    s.projectDir = projectDir;
    const name = projectDir.split(/[\\\/]/).pop() || projectDir;
    logLine(TAGS.SYS + 'Session #' + s.id + ' project: ' + C.cyan + name + C.reset);
  }
  if (appType && !s.appType) s.appType = appType;
  if (isGit !== undefined && s.isGit !== true) s.isGit = isGit;
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
    // Use cached visLen — no regex per line. Falls back to raw string
    // for backward compat with hot-reload from older logBuf format.
    for (const line of visible) {
      if (typeof line === 'string') writeLine(line);
      else writeLine(line.raw, line.visLen);
    }
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

// Store { raw, visLen } to avoid regex on every repaint
function logLine(s) {
  logBuf.push({ raw: s, visLen: visibleLen(s) });
  if (logBuf.length > MAX_BUF) {
    logBuf.shift();
    if (scrollOffset > 0) scrollOffset--;
  }
  if (scrollOffset > 0) scrollOffset++;  // new entry at bottom shifts view up
  scheduleRepaint();
}

/** Write directly to stdout, bypassing truncation + log buffer.
 *  Used for debug lines that may be wider than the terminal. */
function logLineRaw(s) {
  process.stdout.write(s + '\n');
}

// ── Header (compact 4-line, avg hit rate, activity, per-session) ──

function paintHeader(state) {
  try {
    const w = process.stdout.columns || 80;
    const bar = C.bold + C.blue + '═'.repeat(w) + C.reset;
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const uptimeStr = Math.floor(uptimeSec / 3600) + 'h' +
      String(Math.floor((uptimeSec % 3600) / 60)).padStart(2, '0') + 'm';

    // ── Current session stats ──────────────────────────────────────
    const s = currentKey ? sessions.get(currentKey) : null;
    const mainHit = (s && s.mainInput > 0)
      ? ((s.mainHits / s.mainInput) * 100).toFixed(1)
      : '—';
    const subHit = (s && s.subInput > 0)
      ? ((s.subHits / s.subInput) * 100).toFixed(1)
      : null;
    const hitDisplay = C.gray + 'Hit:' + C.reset + ' ' +
      C.cyan + 'M:' + C.reset + hrColor(mainHit) +
      (subHit !== null
        ? C.gray + '  S:' + C.reset + hrColor(subHit)
        : '');
    // 6f: activity indicator
    const activity = inflight > 0
      ? C.green + ' ● active' + C.reset
      : C.dim   + ' ○ idle'   + C.reset;
    // Session badge: #id + last 4 chars of key + project + app + git badges
    let sessBadge;
    if (s) {
      const shortKey = C.dim + '#' + s.id + C.reset + C.gray + '*' + (s.key.length > 4 ? s.key.slice(-4) : s.key) + C.reset;
      const projName = s.projectDir ? C.cyan + ' ' + s.projectDir + C.reset : '';
      const appBadge = s.appType ? C.yellow + ' [' + s.appType + ']' + C.reset : '';
      const gitBadge = s.isGit ? C.magenta + '[git]' + C.reset : '';
      sessBadge = shortKey + projName + appBadge + gitBadge;
    } else {
      sessBadge = C.dim + '—' + C.reset;
    }

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
      '  ' + C.gray + 'Sess:'   + C.reset + ' ' + sessBadge +
      '  ' + hitDisplay +
      '  ' + activity
    );

    // ── Other active sessions (compact, only if >1 session exists) ──
    let otherPart = '';
    const otherKeys = sessionOrder.filter(k => k !== currentKey && sessions.has(k));
    if (otherKeys.length > 0) {
      const items = otherKeys.slice(0, 5).map(k => {
        const os = sessions.get(k);
        const pct = (os && os.mainInput > 0)
          ? ((os.mainHits / os.mainInput) * 100).toFixed(1)
          : '—';
        const hint = os.key.length > 4 ? os.key.slice(-4) : os.key;
        return C.dim + '#' + os.id + C.reset + C.gray + '*' + hint + C.reset + ' ' + hrColor(pct);
      });
      otherPart = '  ' + C.gray + 'Also:' + C.reset + ' ' + items.join(' ');
    }

    writeLine(
      ' ' + C.gray + 'Think:'   + C.reset + ' ' + onOff(state.forceSubagentThinking) +
      '  ' + C.gray + 'Log:'    + C.reset + ' ' + onOff(state.fileLogging) +
      '  ' + C.gray + 'Debug:'  + C.reset + ' ' + onOff(state.debugLogging) +
      (state.debugLogging
        ? ' ' + C.gray + 'TUI:' + C.reset + ' ' + onOff(state.debugTuiPrint)
        : '') +
      '  ' + C.gray + 'Up:'     + C.reset + ' ' + C.dim + uptimeStr + C.reset +
      otherPart +
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
          C.cyan + 'D' + C.reset + 'tui ' +
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

  const tokVal = info.maxTokens ? Math.round(info.maxTokens / 1000) + 'k' : '-';
  // effort controls reasoning depth (high/max) — only param DeepSeek actually respects
  const effortVal = info.effort && info.effort !== '?' ? info.effort : '-';

  // 6c: timestamp prefix
  const ts = C.gray + new Date().toLocaleTimeString('de-DE', { hour12: false }) + C.reset;

  // Pad syncTag to fixed visible width so tools:/in: columns stay aligned
  const SYNC_W = 16;
  const visLen = syncTag.replace(/\x1b\[[0-9;]*m/g, '').length;
  const syncPadded = syncTag + ' '.repeat(Math.max(0, SYNC_W - visLen));

  logLine(
    ts + ' ' + tag + ' ' + C.cyan + '>' + C.reset + C.gray + '#' + padStart(reqNum, 3) + C.reset + ' ' +
    C.cyan   + padEnd(shortModel(info.model), 10) + C.reset + ' ' +
    // 3: expanded abbreviations
    C.gray   + 'msg:' + C.reset + C.yellow + padStart(info.msgCount, 3)   + C.reset + '  ' +
    C.gray   + 'think:' + C.reset + C.yellow + padEnd(info.thinkingType, 9) + C.reset + ' ' +
    C.gray   + 'eff:' + C.reset + C.magenta + padEnd(effortVal.substring(0, 4), 4)       + C.reset + '  ' +
    C.gray   + 'maxtok:' + C.reset + C.yellow + padEnd(tokVal, 5)         + C.reset + '  ' +
    syncPadded + ' ' +
    C.gray   + 'tools:' + C.reset + C.cyan    + padEnd(info.lastAssistantTools.substring(0, 18), 18) + C.reset + ' ' +
    C.gray   + 'in:'    + C.reset + C.magenta + padEnd(info.lastUserHint.substring(0, 27), 27)       + C.reset
  );
}

// ── Metrics response line (6e: HTTP status color) ──────────────────

function logMetrics(reqNum, inputTokens, cacheHits, totalInput, outputTokens, calls, statusCode, reasoningTokens) {
  const hitRate = totalInput > 0 ? ((cacheHits / totalInput) * 100).toFixed(1) : '0.0';
  const indent  = '                ';  // 16 spaces — aligns <# with ># above
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
    C.gray + 'out:'   + C.reset + C.cyan   + padStart(outputTokens, 5) + C.reset + '            ' +
    C.gray + 'calls:' + C.reset + C.yellow + padEnd(calls.substring(0, 18), 18) + C.reset + '  ' +
    reasonPart
  );
}

// ── Error helper (3.5) ─────────────────────────────────────────────

function logError(context, err) {
  logLine(TAGS.ERR + context + ': ' + (err ? err.message : 'unknown'));
}

// ── Stats tracking (per-session via fingerprint) ───────────────────

/**
 * Add cache stats to the session identified by fingerprint.
 * fp: auth fingerprint (8-char suffix of API key)
 */
function addCacheStats(fp, isSub, hits, total) {
  const s = ensureSession(fp);
  if (isSub) {
    s.subHits  += hits;
    s.subInput += total;
    s.subCount++;
  } else {
    s.mainHits  += hits;
    s.mainInput += total;
  }
}

/**
 * Manual reset of MAIN cache stats for the most recent session.
 * Keeps SUB stats and session identity intact.
 */
function resetMainStats() {
  if (!currentKey) return;
  const s = sessions.get(currentKey);
  if (s) {
    s.mainHits  = 0;
    s.mainInput = 0;
  }
}

function inflightInc() { inflight++; }
function inflightDec() { inflight--; }

/** Force an immediate repaint (for terminal resize, manual refresh).
 *  Delegates to repaint() — identical logic, just unthrottled. */
function forceRepaint() {
  repaint();
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
    sessions:         [...sessions.entries()],  // [[fp, session], ...]
    sessionOrder:     [...sessionOrder],
    currentKey,
    sessionCounter,
    inflight,
    startTime,
    pagerMode,
    scrollOffset,
  };
}

function _restoreState(state) {
  logBuf           = state.logBuf || [];
  sessions         = new Map(state.sessions || []);
  sessionOrder     = state.sessionOrder || [];
  currentKey       = state.currentKey || null;
  sessionCounter   = state.sessionCounter || 0;
  inflight         = state.inflight || 0;
  startTime        = state.startTime || Date.now();
  pagerMode        = state.pagerMode || false;
  scrollOffset     = state.scrollOffset || 0;
  repaintScheduled = false;
}

// ── Export ─────────────────────────────────────────────────────────

module.exports = {
  paintHeader, logLine, logLineRaw, logRequest, logMetrics, logError,
  activateSession, addCacheStats, resetMainStats, inflightInc, inflightDec, forceRepaint,
  enterPager, exitPager, isPagerMode, scrollUp, scrollDown, scrollTop, scrollBottom,
  _saveState, _restoreState,
};
