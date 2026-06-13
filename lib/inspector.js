'use strict';

// ── Payload inspection ────────────────────────────────────────────

function inspectPayload(json) {
  try {
    const info = {};
    info.model         = json.model || '?';
    info.maxTokens     = json.max_tokens || 0;
    info.thinkingType    = (json.thinking && json.thinking.type) || 'none';
    info.thinkingBudget  = (json.thinking && json.thinking.budget_tokens) || 0;
    info.effort        = (json.output_config && json.output_config.effort) || '?';
    info.stream        = json.stream !== false;
    info.msgCount      = json.messages ? json.messages.length : 0;
    info.systemLen     = 0;
    info.toolCount     = 0;

    // System prompt length
    if (json.system) {
      if (typeof json.system === 'string') {
        info.systemLen = json.system.length;
      } else if (Array.isArray(json.system)) {
        info.systemLen = JSON.stringify(json.system).length;
      }
    }

    // ── Last assistant message (5.5: only scan last 5) ────────────
    info.lastAssistantTools = '-';
    if (json.messages) {
      const start = Math.max(0, json.messages.length - 5);
      for (let i = json.messages.length - 1; i >= start; i--) {
        const m = json.messages[i];
        if (m.role === 'assistant' && m.content && Array.isArray(m.content)) {
          const tools = [];
          for (const b of m.content) {
            if (b.type === 'tool_use') tools.push(b.name);
          }
          info.lastAssistantTools = tools.length ? tools.join(',') : 'text';
          break;
        }
      }
    }

    // ── Last user message (5.5: only scan last 5) ──────────────────
    info.lastUserHint = '?';
    if (json.messages) {
      const start = Math.max(0, json.messages.length - 5);
      for (let i = json.messages.length - 1; i >= start; i--) {
        const m = json.messages[i];
        if (m.role === 'user') {
          const content = m.content;
          if (typeof content === 'string') {
            const trCount = (content.match(/<tool_result>/g) || []).length;
            if (trCount > 0) {
              info.toolCount = trCount;
              info.lastUserHint = trCount + ' tool_result' + (trCount > 1 ? 's' : '');
            } else if (content.includes('<system-reminder>')) {
              info.lastUserHint = 'system';
            } else {
              // Sanitize: collapse whitespace, trim to 60 chars
              const preview = content.replace(/\s+/g, ' ').trim().substring(0, 60);
              info.lastUserHint = preview || '(empty)';
            }
          } else if (Array.isArray(content)) {
            const types = [...new Set(content.map(b => b.type || '?'))];
            info.lastUserHint = types.join(',');
          }
          break;
        }
      }
    }

    return info;
  } catch (e) {
    return {
      model: json.model || '?', maxTokens: 0, thinkingType: '?', thinkingBudget: 0, effort: '?',
      stream: true, msgCount: 0, systemLen: 0, toolCount: 0,
      lastAssistantTools: 'err', lastUserHint: 'err: ' + e.message,
    };
  }
}

module.exports = { inspectPayload };
