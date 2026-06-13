'use strict';

// ── ANSI colors (cmd.exe: 16-color support since Win 10 1511) ────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
};

// ── Log tags ───────────────────────────────────────────────────────
const TAGS = {
  MAIN:  C.bold + C.blue    + '[MAIN]' + C.reset,
  SUB:   C.bold + C.magenta + '[SUB ]' + C.reset,  // padded to 6 visible chars
  ERR:   C.bold + C.red     + '[ERR] ' + C.reset,
  CLI:   C.cyan  + '[CLI] ' + C.reset,
  API:   C.yellow + '[API] ' + C.reset,
  SYS:   C.gray  + '[SYS] ' + C.reset,
  DEBUG: C.dim   + '[DEBUG]' + C.reset,
};

// ── Helpers ────────────────────────────────────────────────────────
function shortModel(m) {
  if (m.startsWith('deepseek-')) m = m.slice(9); // 'deepseek-v4-pro' → 'v4-pro'
  return m.length > 10 ? m.slice(0, 10) : m;
}

function onOff(v) {
  return v ? C.green + 'ON' + C.reset : C.dim + 'OFF' + C.reset;
}

/** Color-code a hit-rate percentage: ≥80% green, ≥40% yellow, else red */
function hrColor(pct) {
  const n = parseFloat(pct);
  if (n >= 80) return C.green  + pct + '%' + C.reset;
  if (n >= 40) return C.yellow + pct + '%' + C.reset;
  return C.red + pct + '%' + C.reset;
}

/** Color-code HTTP status: 2xx green, 4xx yellow, 5xx red */
function statusColor(code) {
  if (code >= 200 && code < 300) return C.green  + code + C.reset;
  if (code >= 400 && code < 500) return C.yellow + code + C.reset;
  if (code >= 500)               return C.red    + code + C.reset;
  return C.gray + code + C.reset;
}

/** Format thinking type + budget for display (3.2) */
function formatThinking(type, budget) {
  const budgetStr = budget
    ? C.dim + '/' + Math.round(budget / 1000) + 'k' + C.reset
    : C.dim + '     ' + C.reset;
  return type + budgetStr;
}

// ── Padding (3.6 — renamed from confusing padL/padR) ──────────────
const padEnd   = (s, w) => String(s).padEnd(w);      // text left,  padding right
const padStart = (n, w) => String(n).padStart(w);    // text right, padding left
const padNum   = (n, w) => String(Number(n).toLocaleString('en')).padStart(w);

module.exports = { C, TAGS, shortModel, onOff, hrColor, statusColor, formatThinking, padEnd, padStart, padNum };
