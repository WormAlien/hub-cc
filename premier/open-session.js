'use strict';
// One persistent profile per dashboard account. GitHub consent stays with the user.
const fs = require('fs');
const path = require('path');
const api = require('../routing/lib/premier-api');
const { writeJsonSync } = require('../routing/lib/durable-write');
const { makeCapture } = require('../routing/lib/gh-live-capture');
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

function permittedHost(host, githubOnly) {
    const h = String(host || '').replace(/^\./, '').toLowerCase();
    return h === 'github.com' || h.endsWith('.github.com') || (!githubOnly && h === api.HOST);
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
async function authenticatedState(context) {
    const me = await context.request.get(api.ORIGIN + '/api/auth/me', { timeout: 12000, maxRedirects: 0 });
    if (!me.ok() || !api.isAuthenticated(await me.json())) return null;
    const response = await context.request.get(api.ORIGIN + '/api/dev/state', { timeout: 12000, maxRedirects: 0 });
    if (!response.ok()) return null;
    const state = await response.json();
    return api.isAuthenticated(state) ? state : null;
}
async function main() {
    const label = String(process.argv[2] || '');
    if (!/^acct_[A-Za-z0-9_-]+$/.test(label)) throw new Error('Expected dashboard account label');
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
        // Do not navigate or call GitHub APIs during its OAuth flow.
        if (!context.pages().some(p => p.url().startsWith(api.ORIGIN + '/'))) return;
        busy = true; lastCheck = Date.now();
        try {
            const state = await authenticatedState(context);
            if (!state) return;
            const quota = api.normalizeState(state);
            const storage = await context.storageState();
            writeJsonSync(sessionFile, {
                ...storage, seed: null, savedAt: new Date().toISOString(),
                premierQuota: quota, premierUserId: api.accountIdentity(state),
                // Key masks let the proxy prove which key the reading belongs to.
                premierKeys: (Array.isArray(state.keys) ? state.keys : [])
                    .map(k => ({ id: k && k.id != null ? String(k.id) : null, hint: k && k.hint || null })),
            });
            await capture.captureOnce(context, { quiet: true });
            if (!loggedIn) {
                loggedIn = true;
                console.log('Premier login verified. Session saved; open Developers to copy the API key.');
                await page.goto(api.ORIGIN + '/developers', { waitUntil: 'domcontentloaded' });
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
        await page.goto(api.ORIGIN + '/developers', { waitUntil: 'domcontentloaded' });
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
