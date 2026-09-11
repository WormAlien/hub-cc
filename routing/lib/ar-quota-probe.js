'use strict';

const AR_QUOTA_BODY = Object.freeze({
    model: 'claude-opus-5',
    max_tokens: 1,
    messages: [{ role: 'user', content: '1' }],
});

function classifyArQuotaProbe(status, rawBody) {
    const code = Number(status) || 0;
    if (code >= 200 && code < 300) return { state: 'available' };
    const text = String(rawBody || '');
    if (code === 402 && /Budget pool quota has been exhausted/i.test(text)) {
        return { state: 'exhausted' };
    }
    let message = text.slice(0, 300) || `HTTP ${code || 0}`;
    try {
        const parsed = JSON.parse(text);
        message = parsed?.error?.message || parsed?.error || parsed?.message || message;
    } catch {}
    return { state: 'error', error: String(message) };
}

module.exports = { AR_QUOTA_BODY, classifyArQuotaProbe };
