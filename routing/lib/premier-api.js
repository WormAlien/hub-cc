'use strict';
// Premier has a shared daily message allowance, not a New API money balance.
// Contract: /developers.js -> GET /api/dev/state with the account's site cookie.
const fs = require('fs');
const path = require('path');
const os = require('os');
const HOST = 'ide.kgpix.bond';
const ORIGIN = 'https://' + HOST;
const ROOT = path.join(__dirname, '..', '..', 'premier');
const POOL_FILE = path.join(os.homedir(), '.secrets', 'premier-sessions.json');
const CACHE_MS = 60_000;
const FRESH_MS = 5 * 60_000;

function isAuthenticated(data) {
    const u = data && data.user;
    return !!(u && (typeof u.id === 'number' || (typeof u.id === 'string' && u.id)));
}
function normalizeState(data, now = Date.now()) {
    const u = data && data.usage;
    if (!isAuthenticated(data) || !u || !Number.isFinite(u.used) || u.used < 0) return null;
    if (u.limit !== null && (!Number.isFinite(u.limit) || u.limit < 0)) return null;
    const reset = typeof u.resets_at === 'number' ? u.resets_at : Date.parse(u.resets_at);
    return {
        unit: 'messages', accountId: String(data.user.id), plan: data.plan && data.plan.name || null,
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
    if (result.quota) target.quota = result.quota;
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
async function fetchQuota(cookie, { fetchImpl = fetch, now = Date.now() } = {}) {
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
        return quota ? { quota } : { error: 'Сервер не вернул дневную квоту аккаунта' };
    } catch (e) { return { error: 'Не удалось прочитать квоту Premier: ' + e.message }; }
}
async function readQuota(target = {}, opts = {}) {
    const now = Date.now();
    if (!opts.force && !target.quotaError && quotaFresh(target.quota, now, CACHE_MS)) return { quota: target.quota };
    const snap = readSnapshot(target);
    if (!opts.force && snap && quotaFresh(snap.premierQuota, now, CACHE_MS)
        && (!target.quota || (snap.premierQuota.accountId === target.quota.accountId
            && Date.parse(snap.premierQuota.checkedAt) >= Date.parse(target.quota.checkedAt)))) {
        return { quota: snap.premierQuota };
    }
    let cookie = siteCookieHeader(snap && snap.cookies);
    const label = labelFor(target);
    if (!cookie && label) {
        const profile = path.join(ROOT, 'profiles', label);
        if (fs.existsSync(profile)) {
            try { cookie = siteCookieHeader(require('./newapi-account').readProfileCookies(profile)); } catch {}
        }
    }
    const result = await fetchQuota(cookie, opts);
    if (result.quota && target.quota && target.quota.accountId !== result.quota.accountId) {
        return { error: 'В профиле другой аккаунт Premier: проверь привязку' };
    }
    return result;
}

module.exports = {
    HOST, ORIGIN, ROOT, POOL_FILE, CACHE_MS, FRESH_MS,
    isAuthenticated, normalizeState, quotaFresh, applyResult, siteCookieHeader,
    labelFor, readSnapshot, fetchQuota, readQuota,
};
