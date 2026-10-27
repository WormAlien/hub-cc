'use strict';
// Premier has a shared daily message allowance, not a New API money balance.
// Contract: /developers.js -> GET /api/dev/state with the account's site cookie.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const HOST = 'ide.kgpix.bond';
const ORIGIN = 'https://' + HOST;
const ROOT = path.join(__dirname, '..', '..', 'premier');
const POOL_FILE = path.join(os.homedir(), '.secrets', 'premier-sessions.json');
const CACHE_MS = 60_000;
const FRESH_MS = 5 * 60_000;

// /api/dev/state has no user.id - only name and email (checked live 23.10.2026).
// Email is the identity both it and /api/auth/me agree on; id stays a fallback.
function accountIdentity(data) {
    const u = data && data.user;
    if (!u) return null;
    const email = typeof u.email === 'string' ? u.email.trim().toLowerCase() : '';
    if (email.includes('@')) return 'email:' + email;
    if (typeof u.id === 'number' && Number.isFinite(u.id)) return 'id:' + u.id;
    if (typeof u.id === 'string' && u.id.trim()) return 'id:' + u.id.trim();
    return null;
}
function isAuthenticated(data) {
    return !!accountIdentity(data);
}
function keyFingerprint(apiKey) {
    const k = String(apiKey || '');
    return k ? crypto.createHash('sha256').update(k).digest('hex').slice(0, 32) : null;
}
// The cabinet shows keys only as prm_XXX…XXXX; the same mask is what /api/dev/state returns.
function maskKey(apiKey) {
    const k = String(apiKey || '');
    return /^prm_[A-Za-z0-9_-]{20,}$/.test(k) ? k.slice(0, 7) + '\u2026' + k.slice(-4) : null;
}
// A link is evidence only when the authenticated account lists exactly one key with this mask.
function keyBindingFrom(identity, keys, apiKey, now = Date.now()) {
    const mask = maskKey(apiKey);
    if (!identity || !mask || !Array.isArray(keys)) return null;
    const hits = keys.filter(k => k && k.id != null && k.hint === mask);
    if (hits.length !== 1) return null;
    return {
        v: 1, accountId: identity, keyId: String(hits[0].id), hint: mask,
        fingerprint: keyFingerprint(apiKey), confirmedAt: new Date(now).toISOString(),
    };
}
function keyBinding(state, apiKey, now = Date.now()) {
    return keyBindingFrom(accountIdentity(state), state && state.keys, apiKey, now);
}
function bindingMatches(binding, apiKey, quota) {
    if (!binding || !quota) return false;
    const fp = keyFingerprint(apiKey);
    return !!fp && binding.fingerprint === fp && binding.accountId === quota.accountId;
}
function normalizeState(data, now = Date.now()) {
    const u = data && data.usage;
    const accountId = accountIdentity(data);
    if (!accountId || !u || !Number.isFinite(u.used) || u.used < 0) return null;
    if (u.limit !== null && (!Number.isFinite(u.limit) || u.limit < 0)) return null;
    const reset = typeof u.resets_at === 'number' ? u.resets_at : Date.parse(u.resets_at);
    return {
        unit: 'messages', accountId, plan: data.plan && data.plan.name || null,
        used: u.used, limit: u.limit, remaining: u.limit === null ? null : Math.max(0, u.limit - u.used),
        unlimited: u.limit === null,
        resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset).toISOString() : null,
        checkedAt: new Date(now).toISOString(),
    };
}
function quotaFresh(q, now = Date.now(), ttl = FRESH_MS) {
    if (!q || q.unit !== 'messages') return false;
    const checked = Date.parse(q.checkedAt), reset = Date.parse(q.resetAt);
    return Number.isFinite(checked) && now >= checked - 60_000 && now - checked < ttl
        && (!Number.isFinite(reset) || now < reset);
}
function applyResult(target, result, now = Date.now()) {
    if (!target || !result) return;
    // Never let copied money fields feed financial totals or USD rotation thresholds.
    for (const key of ['balance', 'balanceLocal', 'granted', 'spent', 'grantManual', 'bonus', 'referral']) delete target[key];
    target.balanceSource = 'messages';
    target.quotaCheckedAt = new Date(now).toISOString();
    if (result.unverified) {
        // Owner of the reading is not proven: keep the key, drop the number.
        delete target.quota; delete target.quotaBinding;
    } else if (result.quota) {
        target.quota = result.quota;
        if (result.binding) target.quotaBinding = result.binding;
    }
    if (result.error) target.quotaError = result.error; else delete target.quotaError;
    target.authRequired = !!result.authRequired;
}
function siteCookieHeader(cookies, now = Date.now()) {
    return (cookies || []).filter(c => {
        const domain = String(c.domain || c.host || '').replace(/^\./, '').toLowerCase();
        return domain === HOST && c.name && c.value && !/[\r\n;]/.test(c.name + c.value)
            && !(typeof c.expires === 'number' && c.expires > 0 && c.expires * 1000 <= now);
    }).map(c => c.name + '=' + c.value).join('; ');
}
function labelFor(target) {
    const id = String(target && target.id || '');
    return /^[A-Za-z0-9_-]+$/.test(id) ? 'acct_' + id : null;
}
function readSnapshot(target) {
    const label = labelFor(target);
    if (!label) return null;
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', label + '.json'), 'utf8')); }
    catch { return null; }
}
async function fetchQuota(cookie, { fetchImpl = fetch, now = Date.now(), apiKey = '' } = {}) {
    if (!cookie) return { authRequired: true, error: 'Войди в Premier через браузер аккаунта' };
    try {
        const r = await fetchImpl(ORIGIN + '/api/dev/state', {
            headers: { Accept: 'application/json', Cookie: cookie },
            redirect: 'error', signal: AbortSignal.timeout(15000),
        });
        if (r.status === 401) return { authRequired: true, error: 'Сессия Premier истекла, войди заново' };
        if (!r.ok) return { error: 'Квота недоступна: HTTP ' + r.status };
        const data = await r.json();
        const quota = normalizeState(data, now);
        if (!quota) return { unverified: true, error: 'Сервер не вернул дневную квоту аккаунта' };
        // A number without the key in this account's own list may belong to someone else.
        const binding = keyBinding(data, apiKey, now);
        if (!binding) {
            return { unverified: true, error: apiKey
                ? 'Ключ не найден в списке этого аккаунта: владелец квоты не подтверждён'
                : 'В записи нет key: владелец квоты не подтверждён' };
        }
        return { quota, binding };
    } catch (e) { return { error: 'Не удалось прочитать квоту Premier: ' + e.message }; }
}
async function readQuota(target = {}, opts = {}) {
    const now = Date.now();
    const apiKey = String((target && target.api_key) || '');
    // A replaced key or an unproven old reading must not keep its number.
    if (target.quotaBinding && target.quotaBinding.fingerprint !== keyFingerprint(apiKey)) {
        delete target.quota; delete target.quotaBinding;
    }
    if (target.quota && !bindingMatches(target.quotaBinding, apiKey, target.quota)) {
        delete target.quota; delete target.quotaBinding;
    }
    if (!opts.force && !target.quotaError && quotaFresh(target.quota, now, CACHE_MS)) {
        return { quota: target.quota, binding: target.quotaBinding };
    }
    const snap = readSnapshot(target);
    const snapBinding = snap && keyBindingFrom(snap.premierUserId, snap.premierKeys, apiKey, now);
    if (!opts.force && snap && snapBinding && quotaFresh(snap.premierQuota, now, CACHE_MS)
        && snapBinding.accountId === snap.premierQuota.accountId
        && (!target.quota || Date.parse(snap.premierQuota.checkedAt) >= Date.parse(target.quota.checkedAt))) {
        return { quota: snap.premierQuota, binding: snapBinding };
    }
    let cookie = siteCookieHeader(snap && snap.cookies);
    const label = labelFor(target);
    if (!cookie && label) {
        const profile = path.join(ROOT, 'profiles', label);
        if (fs.existsSync(profile)) {
            try { cookie = siteCookieHeader(require('./newapi-account').readProfileCookies(profile)); } catch {}
        }
    }
    const result = await fetchQuota(cookie, { ...opts, now, apiKey });
    if (result.quota && target.quota && target.quota.accountId !== result.quota.accountId) {
        return { unverified: true, error: 'В профиле другой аккаунт Premier: проверь привязку' };
    }
    return result;
}

module.exports = {
    HOST, ORIGIN, ROOT, POOL_FILE, CACHE_MS, FRESH_MS,
    accountIdentity, isAuthenticated, keyFingerprint, maskKey, keyBindingFrom, keyBinding,
    bindingMatches, normalizeState, quotaFresh, applyResult, siteCookieHeader,
    labelFor, readSnapshot, fetchQuota, readQuota,
};
