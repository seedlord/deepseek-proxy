'use strict';

// ── Configuration ──────────────────────────────────────────────────
// All values can be overridden via environment variables.

const path = require('path');

module.exports = {
  PORT:            parseInt(process.env.PROXY_PORT, 10)        || 4000,
  DEEPSEEK_HOST:   process.env.DEEPSEEK_HOST                   || 'api.deepseek.com',
  LOG_FILE:        process.env.PROXY_LOG_FILE                  || path.join(__dirname, '..', 'proxy-metrics.csv'),
  MAX_BODY_SIZE:   parseInt(process.env.PROXY_MAX_BODY, 10)    || 50 * 1024 * 1024,   // 50 MB  (2b)
  REQUEST_TIMEOUT: parseInt(process.env.PROXY_REQ_TIMEOUT, 10) || 120000,             // 120s  (2d)
  SERVER_TIMEOUT:  parseInt(process.env.PROXY_SRV_TIMEOUT, 10) || 130000,             // 130s  (2d)
  HEADER_ROWS:     4,                  // compact header lines (6a)
  MAX_BUF:         500,                // max log lines in TUI buffer
  MAX_RESPONSE_BUF: 1024 * 1024,       // 1 MB sliding window for response (5.2)

  CSV_HDR:
    'timestamp,role,agentId,model,thinkingType,thinkingBudget,maxTokens,msgCount,systemLen,' +
    'lastTools,lastUserHint,callTools,missTokens,cacheHitTokens,cacheHitPct,outputTokens,reasoningTokens\n',
};
