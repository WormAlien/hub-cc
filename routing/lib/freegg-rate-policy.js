'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function accountId(row, key) {
    // Only provider-verified panel identity proves quota independence. Local row IDs,
    // GitHub IDs and emails may still point at the same FreeGG account.
    const stable = String((row && row.newApiUserId) || '').trim();
    const source = stable || String(key || '');
    return `acct-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
}

function parseRetryAfter(value, now = Date.now()) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function retryMsFromBody(value) {
    if (!value || typeof value !== 'object') return null;
    for (const node of [value, value.error, value.response && value.response.error].filter(Boolean)) {
        for (const field of ['retry_after_ms', 'retryAfterMs']) {
            if (node[field] === null || node[field] === undefined || String(node[field]).trim() === '') continue;
            const n = Number(node[field]);
            if (Number.isFinite(n) && n >= 0) return Math.round(n);
        }
        for (const field of ['retry_after', 'retryAfter']) {
            if (node[field] === null || node[field] === undefined || String(node[field]).trim() === '') continue;
            const n = Number(node[field]);
            if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
        }
        for (const field of ['reset_at', 'resetAt', 'resets_at', 'resetsAt']) {
            const t = Date.parse(String(node[field] || ''));
            if (Number.isFinite(t)) return Math.max(0, t - Date.now());
        }
    }
    return null;
}

function errorInfo(status, headers, body) {
    let doc = null;
    try { doc = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '')); } catch {}
    const error = doc && (doc.error || (doc.response && doc.response.error));
    const code = String((error && (error.code || error.type)) || (doc && doc.code) || '');
    const message = String((error && error.message) || (doc && doc.message) || '').slice(0, 500);
    const explicitRateCode = ['rate_limit_exceeded', 'too_many_requests', 'rate_limit_error'].includes(code);
    const tokenRateLimit = Number(status) === 429 && (explicitRateCode
        || (!code && /token rate limit|rate limit/i.test(message)));
    const retryMs = parseRetryAfter(headers && headers['retry-after']) ?? retryMsFromBody(doc);
    return { code, message, tokenRateLimit, retryMs };
}

function loadCandidates(file) {
    let rows = [];
    try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        rows = Array.isArray(doc) ? doc : Object.values(doc || {}).filter(x => x && typeof x === 'object');
    } catch { return []; }
    return rows.filter(row => row && row.status !== 'dead' && String(row.api_key || '').trim())
        .map(row => ({ key: String(row.api_key).trim(), accountId: accountId(row, row.api_key),
            verifiedAccount: String(row.newApiUserId || '').trim().length > 0, balance: Number(row.balance) || 0 }));
}

function createFreeggRatePolicy(options = {}) {
    const scope = ['account', 'key', 'shared'].includes(options.scope) ? options.scope : 'off';
    const enabled = !!options.enabled && scope !== 'off';
    const defaultCooldownMs = Math.max(1000, Number(options.defaultCooldownMs) || 60000);
    const jitterMs = Math.max(0, Number(options.jitterMs) || 0);
    const random = options.random || Math.random;
    const state = new Map();
    let sequence = 0;
    const groupOf = candidate => scope === 'shared' ? 'shared'
        : scope === 'key' ? `key:${crypto.createHash('sha256').update(candidate.key).digest('hex').slice(0, 16)}`
            : `account:${candidate.accountId}`;
    const get = group => {
        if (!state.has(group)) state.set(group, { cooldownUntil: 0, inflight: 0, sequence: 0 });
        return state.get(group);
    };
    const candidates = (preferredKey = '') => {
        const dedupe = new Map();
        const rows = loadCandidates(options.sessionsFile);
        if (scope === 'shared' && preferredKey) {
            const selected = rows.find(c => c.key === preferredKey);
            return selected ? [selected] : [];
        }
        for (const c of rows) {
            if (scope === 'account' && !c.verifiedAccount) continue;
            const group = groupOf(c);
            if (!dedupe.has(group)) dedupe.set(group, c);
        }
        return [...dedupe.values()];
    };
    function acquire(triedGroups = new Set(), preferredKey = '') {
        if (!enabled) return null;
        const now = Date.now();
        const available = candidates(preferredKey).filter(c => {
            const group = groupOf(c), s = get(group);
            return !triedGroups.has(group) && s.cooldownUntil <= now;
        });
        if (!available.length) return null;
        available.sort((a, b) => {
            const sa = get(groupOf(a)), sb = get(groupOf(b));
            if (sa.inflight !== sb.inflight) return sa.inflight - sb.inflight;
            if (sa.sequence !== sb.sequence) return sa.sequence - sb.sequence;
            if (a.key === preferredKey && b.key !== preferredKey) return -1;
            if (b.key === preferredKey && a.key !== preferredKey) return 1;
            return b.balance - a.balance;
        });
        const candidate = available[0], group = groupOf(candidate), s = get(group);
        s.inflight += 1; s.sequence = ++sequence;
        let released = false;
        return { ...candidate, group, release() { if (released) return; released = true; s.inflight = Math.max(0, s.inflight - 1); } };
    }
    function cooldown(candidate, retryMs) {
        if (!enabled || !candidate) return 0;
        const group = groupOf(candidate);
        const supplied = retryMs !== null && retryMs !== undefined && Number.isFinite(Number(retryMs));
        const delay = Math.max(0, supplied ? Number(retryMs) : defaultCooldownMs)
            + (jitterMs ? Math.floor(random() * (jitterMs + 1)) : 0);
        get(group).cooldownUntil = Math.max(get(group).cooldownUntil, Date.now() + delay);
        return delay;
    }
    function nearestRetryMs() {
        const now = Date.now();
        const future = [...state.values()].map(x => x.cooldownUntil).filter(t => t > now);
        return future.length ? Math.max(0, Math.min(...future) - now) : null;
    }
    function snapshot() {
        const now = Date.now(), groups = {};
        for (const [group, s] of state) groups[group] = { inflight: s.inflight, cooldownMs: Math.max(0, s.cooldownUntil - now) };
        return { enabled, scope, groups, nearestRetryMs: nearestRetryMs() };
    }
    function reset() { state.clear(); sequence = 0; }
    return { enabled, scope, acquire, cooldown, nearestRetryMs, snapshot, reset, groupOf, errorInfo };
}

module.exports = { accountId, createFreeggRatePolicy, errorInfo, parseRetryAfter, retryMsFromBody };
