'use strict';
// One persistent profile per dashboard account. GitHub consent stays with the user.
const fs = require('fs');
const path = require('path');
const api = require('../routing/lib/premier-api');
const { writeJsonSync } = require('../routing/lib/durable-write');
const { makeCapture } = require('../routing/lib/gh-live-capture');
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// Реф-ссылка: код владельца в routing/ref-codes.default.json, свой — через 💩 или поле
// на вкладке Premier. `url('premier')` без кода отдаёт корень сайта — тогда регистрация
// идёт как раньше, без рефки (регистрировать «с пустым кодом» нельзя: битый параметр
// панель может принять за код и потерять кредит).
const refUrl = (label) => {
    // Своя ссылка аккаунта с вкладки Premier важнее общей: у каждого аккаунта свой код,
    // и тиры набираются на одном реферере. Запись пула читаем каждым запуском — профиль
    // Chromium снаружи не читается, а файл пула да.
    let own = null;
    try {
        const pool = JSON.parse(fs.readFileSync(api.POOL_FILE, 'utf8'));
        const id = String(label || '').replace(/^acct_/, '');
        own = (Array.isArray(pool) ? pool : []).find(s => String(s.id) === id)?.ref || null;
    } catch {}
    return own
        ? `https://ide.kgpix.bond/r/${encodeURIComponent(own)}`
        : require('../routing/lib/ref-codes.js').url('premier');
};
// Сайт кладёт код сюда и снимает его после входа (см. `/login` inline-скрипт).
const REF_KEY = 'premier:ref';

// Fresh account with no key: open the referral link first so the site stores the code
// before the GitHub OAuth round-trip. One navigation is enough (measured: the code lands
// in localStorage immediately); a second goto after the site already jumped to GitHub
// would break OAuth state.
async function openRegisterViaRef(page, label) {
    const link = refUrl(label);
    const coded = /\/r\/[A-Za-z0-9_-]+/.test(link);
    await page.goto(link, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1200);
    if (!coded) {
        console.log('Premier: реф-код не задан — регистрация без реферальной привязки');
        return;
    }
    const stored = await page.evaluate(k => { try { return localStorage.getItem(k); } catch { return null; } }, REF_KEY).catch(() => null);
    console.log(stored ? `Premier: реф-код сохранён в профиль: ${stored}` : 'Premier: ⚠ реф-код не осел в localStorage — бинд может не зачесться');
}

function permittedHost(host, githubOnly) {
    const h = String(host || '').replace(/^\./, '').toLowerCase();
    // Premier lives on two domains (29.10.2026): old cabinet and eide.pro where new
    // sign-ins land. Both carry the session cookie, so accept either.
    return h === 'github.com' || h.endsWith('.github.com') || (!githubOnly && api.HOSTS.includes(h));
}
async function applyImportedSession(context, session) {
    if (!session) return false;
    const githubOnly = session.seed === 'github';
    const cookies = (session.cookies || []).filter(c => permittedHost(c.domain, githubOnly));
    if (cookies.length) await context.addCookies(cookies);
    const origins = (session.origins || []).filter(o => {
        try { const u = new URL(o.origin); return u.protocol === 'https:' && permittedHost(u.hostname, githubOnly); }
        catch { return false; }
    });
    if (origins.length) await context.addInitScript(entries => {
        const own = entries.find(o => o.origin === location.origin);
        if (!own) return;
        for (const item of own.localStorage || []) {
            try { localStorage.setItem(item.name, item.value); } catch {}
        }
    }, origins);
    return cookies.length > 0;
}
// Which Premier domain is the browser actually signed in to? The session cookie is
// domain-scoped, so probing /api/auth/me on each origin is the only honest answer.
async function activeOrigin(context) {
    for (const origin of api.ORIGINS.slice().reverse()) {
        try {
            const me = await context.request.get(origin + '/api/auth/me', { timeout: 12000, maxRedirects: 0 });
            if (me.ok() && api.isAuthenticated(await me.json())) return origin;
        } catch {}
    }
    return null;
}
async function authenticatedState(context) {
    const origin = await activeOrigin(context);
    if (!origin) return null;
    const response = await context.request.get(origin + '/api/dev/state', { timeout: 12000, maxRedirects: 0 });
    if (!response.ok()) return null;
    const state = await response.json();
    return api.isAuthenticated(state) ? state : null;
}
// Счётчик рефералки живёт в `/api/billing` (`ref.code/active/pending/next`), не в
// `/api/dev/state`. Чтение бесплатно (квоту не тратит) и нужно максимум раз за открытие
// окна: тир набирается днями, а не секундами. Ошибка не влияет на вход.
async function referralState(context) {
    try {
        const origin = await activeOrigin(context);
        if (!origin) return null;
        const r = await context.request.get(origin + '/api/billing', { timeout: 12000, maxRedirects: 0 });
        if (!r.ok()) return null;
        const ref = (await r.json() || {}).ref;
        return ref && ref.on ? ref : null;
    } catch { return null; }
}
async function main() {
    const label = String(process.argv[2] || '');
    if (!/^acct_[A-Za-z0-9_-]+$/.test(label)) throw new Error('Expected dashboard account label');
    const mode = String(process.argv[3] || 'auto');
    const profileDir = path.join(PROFILES_DIR, label);
    const sessionFile = path.join(SESSIONS_DIR, label + '.json');
    let imported = null;
    try { imported = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch {}
    const { chromium } = require('playwright');
    const context = await chromium.launchPersistentContext(profileDir, {
        headless: false, channel: 'chrome', viewport: null,
        ignoreDefaultArgs: ['--disable-extensions'], args: ['--window-size=600,1000'],
    });
    const page = context.pages()[0] || await context.newPage();
    const capture = makeCapture({ label, moduleDir: __dirname, poolFile: api.POOL_FILE });
    let closed = false, busy = false, loggedIn = false, lastCheck = 0;
    const done = new Promise(resolve => context.once('close', () => { closed = true; resolve(); }));
    const save = async () => {
        if (busy || closed || Date.now() - lastCheck < 4000) return;
        // Do not navigate or call GitHub APIs during its OAuth flow. Either Premier
        // domain counts: new sign-ins land on eide.pro, not only the old cabinet.
        if (!api.ORIGINS.some(o => context.pages().some(p => p.url().startsWith(o + '/')))) return;
        busy = true; lastCheck = Date.now();
        try {
            const state = await authenticatedState(context);
            if (!state) return;
            const quota = api.normalizeState(state);
            const storage = await context.storageState();
            const prevRef = (() => { try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')).premierReferral || null; } catch { return null; } })();
            const ref = prevRef || await referralState(context);
            writeJsonSync(sessionFile, {
                ...storage, seed: null, savedAt: new Date().toISOString(),
                premierQuota: quota, premierUserId: api.accountIdentity(state),
                ...(ref ? { premierReferral: ref } : {}),
                // Key masks let the proxy prove which key the reading belongs to.
                premierKeys: (Array.isArray(state.keys) ? state.keys : [])
                    .map(k => ({ id: k && k.id != null ? String(k.id) : null, hint: k && k.hint || null })),
            });
            await capture.captureOnce(context, { quiet: true });
            if (!loggedIn) {
                loggedIn = true;
                console.log('Premier login verified. Session saved; open Developers to copy the API key.');
                const origin = await activeOrigin(context) || api.ORIGIN;
                await page.goto(origin + '/developers', { waitUntil: 'domcontentloaded' });
            }
        } catch (e) {
            if (!closed) console.error('Premier session check: ' + e.message);
        } finally { busy = false; }
    };
    try {
        const existing = await context.cookies();
        // Retry a failed import without overwriting a newer live GitHub cookie.
        const hasGithub = existing.some(c => permittedHost(c.domain, true) && c.name === 'user_session' && c.value);
        const hasSite = !!api.siteCookieHeader(existing);
        if (imported && !hasSite && (imported.seed !== 'github' || !hasGithub)) {
            await applyImportedSession(context, imported);
            console.log('Selected session imported. Complete Continue with GitHub if the site asks.');
        }
        capture.holdOpen(context);
        // No key yet → registration via the referral link; otherwise straight to the cabinet.
        const wantRegister = mode === 'register' || (mode !== 'console' && !api.siteCookieHeader(existing));
        if (wantRegister) {
            await openRegisterViaRef(page, label);
        } else {
            await page.goto(api.ORIGIN + '/developers', { waitUntil: 'domcontentloaded' });
        }
        console.log('Premier browser opened. No login success is assumed until /api/auth/me confirms it.');
        // Start only the site's advertised login flow, never submit OAuth consent.
        if (new URL(page.url()).origin === api.ORIGIN && new URL(page.url()).pathname === '/login'
            && imported && imported.seed === 'github') {
            await page.locator('a[href="/api/auth/github"]').click();
        }
        await save();
        const watch = p => p.on('framenavigated', () => { save().catch(() => {}); });
        context.pages().forEach(watch);
        context.on('page', watch);
        const timer = setInterval(() => { save().catch(() => {}); }, 15000);
        const stop = async () => { await save(); await context.close().catch(() => {}); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        await done;
        clearInterval(timer);
    } finally { await context.close().catch(() => {}); }
}

module.exports = { applyImportedSession, authenticatedState };
if (require.main === module) main().catch(e => { console.error('Premier: ' + e.message); process.exitCode = 1; });
