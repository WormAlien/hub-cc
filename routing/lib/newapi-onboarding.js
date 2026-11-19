'use strict';
const fs = require('node:fs');
const path = require('node:path');

function safeFailure(code, status = 0) {
    const error = new Error(`${code}${status ? ` (HTTP ${status})` : ''}`);
    error.code = code; error.status = status; return error;
}
function createPanelClient({ origin, bearer = '', userId, request }) {
    const base = new URL(origin);
    if (!Number.isSafeInteger(Number(userId)) || Number(userId) < 1) throw safeFailure('panel_identity_missing');
    return async (route, method = 'GET', body) => {
        const url = new URL(route, base);
        if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) throw safeFailure('panel_origin_rejected');
        const headers = { 'New-Api-User': String(userId), 'Content-Type': 'application/json' };
        if (bearer) headers.Authorization = 'Bearer ' + bearer;
        const result = await request(url.href, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (result.status !== 200 || !result.json || result.json.success !== true) throw safeFailure('panel_request_failed', result.status);
        return result.json.data;
    };
}
async function ensurePanelKey(client, { name, keyPrefix = '' }) {
    const data = await client('/api/token/?p=0&size=100');
    const items = Array.isArray(data) ? data : data?.items || data?.records;
    if (!Array.isArray(items)) throw safeFailure('token_list_invalid');
    const active = items.filter(t => t.name === name && Number(t.status) === 1);
    if (active.length > 1) throw safeFailure('token_name_ambiguous');
    let token = active[0];
    if (!token) {
        await client('/api/token/', 'POST', { name, expired_time: -1, remain_quota: 0, unlimited_quota: true,
            model_limits_enabled: false, model_limits: '', allow_ips: '', allow_user_quota_query: false,
            group: '', auto_groups: [], cross_group_retry: false });
        const after = await client('/api/token/?p=0&size=100');
        const rows = Array.isArray(after) ? after : after?.items || after?.records || [];
        const matches = rows.filter(t => t.name === name && Number(t.status) === 1);
        if (matches.length !== 1) throw safeFailure('created_token_not_verified');
        token = matches[0];
    }
    if (!Number.isSafeInteger(Number(token.id)) || Number(token.id) < 1) throw safeFailure('token_identity_invalid');
    if (typeof token.key === 'string' && token.key.length >= 16 && !token.key.includes('*') && !token.key.includes('…')) {
        return keyPrefix && !token.key.startsWith(keyPrefix) ? keyPrefix + token.key : token.key;
    }
    const revealed = await client(`/api/token/${token.id}/key`, 'POST', {});
    const raw = typeof revealed === 'string' ? revealed : revealed?.key;
    if (typeof raw !== 'string' || raw.length < 16 || raw.includes('*')) throw safeFailure('token_reveal_failed');
    return keyPrefix && !raw.startsWith(keyPrefix) ? keyPrefix + raw : raw;
}
async function watchPanelAuth(context, { origin, callbackPath }) {
    const auth = { bearer: '', user: null, key: '', error: null };
    await context.route(url => url.origin === origin && [callbackPath, '/api/user/auth/refresh'].includes(url.pathname), async route => {
        try {
            // Never continue() after fetch: the one-time OAuth code may already be consumed.
            const response = await route.fetch({ maxRetries: 0 });
            const body = await response.text();
            let json; try { json = JSON.parse(body); } catch {}
            if (response.status() === 200 && json?.success === true) {
                const data = json.data || {};
                auth.bearer = data.access_token || auth.bearer;
                if (new URL(route.request().url()).pathname === callbackPath) {
                    const user = data.user || (Number(data.id) > 0 ? data : null);
                    if (user) auth.user = { ...user, source: 'oauth' };
                }
                if (typeof data.sk === 'string' && data.sk.length >= 16 && !data.sk.includes('*')) auth.key = data.sk;
            } else if (new URL(route.request().url()).pathname === callbackPath) {
                auth.error = safeFailure('oauth_rejected', response.status());
            }
            await route.fulfill({ response, body });
        } catch {
            auth.error = safeFailure('oauth_transport_failed');
            await route.abort().catch(() => {});
        }
    });
    return auth;
}
async function saveSelectedKey({ id, key, p, hubOrigin = 'http://127.0.0.1:8200', readPool, request }) {
    if (!readPool().some(row => row.id === id)) throw safeFailure('pool_target_missing');
    const url = new URL(hubOrigin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw safeFailure('hub_origin_rejected');
    const result = await request(`${url.origin}/__switch/api/${p}/key`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url.origin },
        body: JSON.stringify({ id, api_key: key }),
    });
    if (result.status !== 200 || !result.json?.ok) throw safeFailure('hub_key_write_failed', result.status);
    const target = readPool().find(row => row.id === id);
    if (target?.api_key !== key) throw safeFailure('hub_key_readback_failed');
    return { ok: true, id };
}
async function verifyGithubIdentity(context, expected) {
    const cookies = await context.cookies('https://github.com');
    const login = cookies.find(c => c.name === 'dotcom_user')?.value || '';
    if (!login || login.toLowerCase() !== expected.toLowerCase()) throw safeFailure('github_identity_mismatch');
    return login;
}
function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function cookieDictionary(cookies, host) {
    return Object.fromEntries(cookies.filter(c => {
        const domain = String(c.domain || '').replace(/^\./, '');
        return domain === host || domain.endsWith('.' + host);
    }).map(c => [c.name, c.value]));
}
function verifyPanelIdentity(me, account, oauthUser) {
    if (oauthUser?.source === 'oauth' && oauthUser.id && Number(oauthUser.id) === Number(me.id)) return;
    if (String(me.username || '').toLowerCase() === String(account.login).toLowerCase()) return;
    throw safeFailure('panel_identity_mismatch');
}
async function fetchJson(url, options) {
    try {
        const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
        return { status: response.status, json: await response.json().catch(() => null) };
    } catch { throw safeFailure('request_transport_failed'); }
}
function githubRecoveryKind(url, account, { passwordAttempted = false, totpAttempts = 0 } = {}) {
    let current; try { current = new URL(url); } catch { return null; }
    if (current.hostname !== 'github.com' || current.protocol !== 'https:') return null;
    if (/^\/sessions\/(?:two-factor(?:\/app)?|sudo)(?:\/|$)/.test(current.pathname)
        && account.totpSecret) return 'totp';
    if (!passwordAttempted && account.password) return 'password';
    return null;
}
function canRecoverGithubLogin(url, account) {
    return githubRecoveryKind(url, account) !== null;
}
function providerOAuthCompletion(value, origin, callbackPath, browserCallbackPath) {
    try {
        const current = new URL(value);
        if (current.origin !== origin) return false;
        const browserCallback = callbackPath.replace(/^\/api(?=\/)/, '');
        const code = current.searchParams.get('code') || '';
        const state = current.searchParams.get('state') || '';
        if ([callbackPath, browserCallback].includes(current.pathname)) return code.length > 0;
        return browserCallbackPath !== undefined && current.pathname === browserCallbackPath
            && code.length > 0 && state.length > 0;
    } catch { return false; }
}
async function stableGithubAuthorize(page, proof) {
    const exact = () => {
        try {
            const current = new URL(page.url());
            return current.origin === 'https://github.com' && current.pathname === '/login/oauth/authorize';
        } catch { return false; }
    };
    if (!exact()) return false;
    if (proof && !await proof()) return false;
    return exact();
}
async function recoverGithubLogin(page, account, { fillLogin, sessionProbe, log, totpState, completionUrl } = {}) {
    const url = new URL(page.url());
    if (url.hostname !== 'github.com' || url.protocol !== 'https:') throw safeFailure('github_origin_rejected');
    const totpOnly = /^\/sessions\/(?:two-factor(?:\/app)?|sudo)(?:\/|$)/.test(url.pathname)
        && !!account.totpSecret;
    if (!account.password && !totpOnly) return { ok: false, wall: 'credentials_missing' };
    const challengeCleared = async () => {
        const current = new URL(page.url());
        if (current.origin === 'https://github.com') {
            if (require('./gh-login').githubChallengePending(current.href)) return false;
            if (current.pathname !== '/login/oauth/authorize') return false;
        } else if (!completionUrl || !completionUrl(current.href)) throw safeFailure('github_origin_rejected');
        return sessionProbe ? sessionProbe() : false;
    };
    return (fillLogin || require('./gh-login').fillGithubLogin)(page, account,
        { log, sessionProbe: challengeCleared, completionUrl, allowTotpOnly: !!account.totpSecret, totpState });
}
async function persistReferral(page, referral) {
    const expected = new URL(referral).searchParams.get('aff');
    for (let attempt = 0; attempt < 2; attempt++) {
        await page.goto(referral, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        const actual = await page.evaluate(() => localStorage.getItem('aff'));
        if (actual === expected) return actual;
    }
    throw safeFailure('referral_not_saved');
}
async function runProvider({ provider, moduleDir, label, mode = 'auto', config, launch, readPool, account,
    hubOrigin = process.env.NEWAPI_HUB_ORIGIN || 'http://127.0.0.1:8200', log = console.log,
    timeoutMs = 600000, githubLoginOptions = {}, beforeGithubAction } = {}) {
    if (!/^acct_[a-zA-Z0-9_-]+$/.test(String(label || ''))) throw safeFailure('profile_label_invalid');
    const root = path.dirname(moduleDir);
    config ||= readJson(path.join(root, 'tools', 'gateways.config.json'))[provider];
    if (config?.full !== provider || config?.onboarding?.kind !== 'newapi-github' || !config.github) {
        throw safeFailure('onboarding_not_configured');
    }
    config = { ...config, onboarding: { consolePath: '/console/token', callbackPath: '/api/oauth/github',
        tokenName: '1', ...config.onboarding } };
    const poolFile = path.join(root, 'routing', `${provider}-sessions.json`);
    readPool ||= () => { const data = readJson(poolFile); return Array.isArray(data) ? data : data.sessions; };
    const id = label.slice(5);
    const target = readPool().find(row => row.id === id);
    if (!target) throw safeFailure('pool_target_missing');
    if (!target.ghId) throw safeFailure('github_binding_missing');
    account ||= readJson(path.join(root, 'routing', 'github-accounts.json')).find(row => row.id === target.ghId);
    if (!account || !account.login) throw safeFailure('github_account_missing');
    const origin = `https://${config.HOST}`;
    const referral = config.ref ? require('./ref-codes').url(provider) : origin + '/sign-in';
    if (new URL(referral).origin !== origin || config.ref && !new URL(referral).searchParams.get('aff')) throw safeFailure('referral_not_configured');
    for (const route of [config.onboarding.consolePath, config.onboarding.callbackPath]) {
        if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || new URL(route, origin).origin !== origin) {
            throw safeFailure('onboarding_route_invalid');
        }
    }
    launch ||= (dir, opts) => require('playwright').chromium.launchPersistentContext(dir, opts);
    const profileDir = path.join(moduleDir, 'profiles', label);
    const context = await launch(profileDir, { headless: false, viewport: null, channel: 'chrome',
        args: ['--window-size=600,1000'], ignoreDefaultArgs: ['--disable-extensions'] });
    const capture = require('./gh-live-capture').makeCapture({ label, moduleDir, poolFile });
    const auth = await watchPanelAuth(context, { origin, callbackPath: config.onboarding.callbackPath });
    let stateStatus = 0, passwordAttempted = false, totpAttempts = 0, consentAttempted = false;
    const totpState = { usedCodes: new Set(), submissions: 0, maxSubmissions: 3 };
    context.on('response', response => {
        const url = new URL(response.url());
        if (url.origin === origin && url.pathname === '/api/oauth/state') stateStatus = response.status();
    });
    // Capture the panel's own auth header, never infer it from a model API key.
    context.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === origin && url.pathname === '/api/user/self') {
            const bearer = request.headers().authorization || '';
            if (bearer.startsWith('Bearer ')) auth.bearer = bearer.slice(7);
        }
    });
    const page = context.pages()[0] || await context.newPage();
    const browserRequest = async (url, opts) => {
        if (new URL(url).origin !== origin) throw safeFailure('panel_origin_rejected');
        return page.evaluate(async ({ url, opts }) => {
            const response = await fetch(url, { ...opts, credentials: 'include' });
            return { status: response.status, json: await response.json().catch(() => null) };
        }, { url, opts });
    };
    try {
        const seedFile = path.join(moduleDir, 'sessions', label + '.json');
        if (fs.existsSync(seedFile)) {
            const seed = readJson(seedFile);
            if (seed.seed === 'github' && seed.ghLogin && seed.ghLogin.toLowerCase() !== account.login.toLowerCase()) {
                throw safeFailure('github_seed_identity_mismatch');
            }
            // Import only into a profile without a live site session; never overwrite a current login.
            if (!(await context.cookies(origin)).some(c => /refresh|session|auth/.test(c.name))) {
                await context.addCookies(seed.cookies || []);
                for (const item of seed.origins || []) {
                    if (item.origin !== origin) continue;
                    await context.addInitScript(({ origin, entries }) => {
                        if (location.origin === origin && !sessionStorage.getItem('abuse-hub-seeded')) {
                            for (const { name, value } of entries) localStorage.setItem(name, value);
                            sessionStorage.setItem('abuse-hub-seeded', '1');
                        }
                    }, { origin, entries: item.localStorage || [] });
                }
            }
        }
        log(`GitHub ${account.login}: открываю страницу входа ${provider}`);
        if (config.ref) await persistReferral(page, referral);
        else {
            await page.goto(referral, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1200);
        }
        // Already logged in: prove identity through /self, no logout or new OAuth state.
        let me = null;
        const probeSelf = async () => {
            if (new URL(page.url()).origin !== origin) return null;
            const storedUserId = await page.evaluate(() => {
                try { return Number(JSON.parse(localStorage.getItem('user') || '{}').id) || null; } catch { return null; }
            });
            const userId = auth.user?.id || storedUserId;
            const headers = { ...(auth.bearer ? { Authorization: 'Bearer ' + auth.bearer } : {}),
                ...(Number(userId) > 0 ? { 'New-Api-User': String(userId) } : {}) };
            const r = await browserRequest(origin + '/api/user/self', { headers });
            return r.status === 200 && r.json?.success === true && Number(r.json.data?.id) > 0 ? r.json.data : null;
        };
        me = await probeSelf();
        if (!me) {
            const button = page.locator('button').filter({ hasText: /github/i }).first();
            await button.waitFor({ state: 'visible', timeout: 15000 });
            await button.click({ timeout: 10000 });
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (auth.error) throw auth.error;
                if (stateStatus === 429) throw safeFailure('oauth_rate_limited', 429);
                const ghPage = context.pages().find(p => {
                    if (p.isClosed()) return false;
                    try { return new URL(p.url()).origin === 'https://github.com'; } catch { return false; }
                });
                if (ghPage) {
                    const url = new URL(ghPage.url());
                    if (url.pathname === '/login/oauth/authorize') {
                        if (!await stableGithubAuthorize(ghPage,
                            () => verifyGithubIdentity(context, account.login).then(() => true))) {
                            throw safeFailure('github_origin_rejected');
                        }
                        const consent = ghPage.locator('button[name="authorize"][value="1"]');
                        if (!consentAttempted && await consent.isVisible().catch(() => false)) {
                            if (beforeGithubAction) await beforeGithubAction('consent', ghPage);
                            if (new URL(ghPage.url()).origin !== 'https://github.com'
                                || new URL(ghPage.url()).pathname !== '/login/oauth/authorize') throw safeFailure('github_origin_rejected');
                            if (!await require('./gh-login').guardedGithubClick(consent, ghPage)) {
                                throw safeFailure('github_origin_rejected');
                            }
                            consentAttempted = true;
                        }
                    } else {
                        const recovery = githubRecoveryKind(ghPage.url(), account, { passwordAttempted, totpAttempts });
                        if (recovery) {
                            if (recovery === 'password') passwordAttempted = true;
                            else totpAttempts++;
                        const result = await recoverGithubLogin(ghPage, account, { log, totpState,
                            fillLogin: (loginPage, creds, options) => require('./gh-login').fillGithubLogin(loginPage, creds,
                                { ...options, ...githubLoginOptions, beforeGithubAction }),
                            completionUrl: value => providerOAuthCompletion(value, origin,
                                config.onboarding.callbackPath, config.onboarding.browserCallbackPath),
                            sessionProbe: async () => {
                                try { await verifyGithubIdentity(context, account.login);
                                    return (await context.cookies('https://github.com')).some(c => c.name === 'user_session' && c.value); }
                                catch { return false; }
                            } });
                        if (result.wall === 'totp_exhausted') throw safeFailure('github_totp_exhausted');
                        if (!result.ok) throw safeFailure('github_login_requires_user');
                        } else if (!passwordAttempted && !totpAttempts) {
                            passwordAttempted = true;
                            log(`GitHub ${account.login}: сохранённой сессии нет, войдите в открытом окне. Пароль в лог не пишется.`);
                        }
                    }
                }
                if (auth.user?.id || auth.bearer) me = await probeSelf();
                if (me) break;
                if (page.isClosed()) throw safeFailure('browser_closed');
                await page.waitForTimeout(1000);
            }
        }
        if (!me) throw safeFailure('panel_login_unconfirmed');
        await verifyGithubIdentity(context, account.login);
        verifyPanelIdentity(me, account, auth.user);
        const client = createPanelClient({ origin, bearer: auth.bearer, userId: me.id, request: browserRequest });
        const existing = readPool().find(row => row.id === id);
        if (!existing) throw safeFailure('pool_target_missing');
        const key = mode !== 'provision' && /^sk-/.test(existing.api_key || '') ? existing.api_key : await ensurePanelKey(client,
            { name: config.onboarding.tokenName || '1', keyPrefix: 'sk-' });
        await saveSelectedKey({ id, key, p: config.p, hubOrigin, readPool, request: fetchJson });
        // Persist authenticated cookies for the common balance reader, without plaintext in logs.
        const cookies = await context.cookies(origin);
        require('./newapi-account').putJarCookies(config.HOST, profileDir, cookieDictionary(cookies, config.HOST));
        require('./durable-write').writeJsonSync(path.join(moduleDir, 'sessions', label + '.json'), await context.storageState());
        await capture.captureOnce(context, { quiet: true });
        log(`Ключ ${provider} сохранён в выбранную запись ${id}; аккаунт подтверждён через /api/user/self.`);
        if (mode !== 'provision') {
            await page.goto(origin + config.onboarding.consolePath, { waitUntil: 'domcontentloaded' });
            await new Promise(resolve => context.once('close', resolve));
        }
        return { ok: true, id, userId: me.id };
    } catch (error) {
        // Browser errors can contain URLs/codes/form data. Expose only our controlled code.
        const safe = error.code ? error : safeFailure('onboarding_failed');
        log(`${provider}: ${safe.code}${safe.status ? ` HTTP ${safe.status}` : ''}`);
        throw safe;
    } finally { await context.close().catch(() => {}); }
}
module.exports = { createPanelClient, ensurePanelKey, safeFailure, watchPanelAuth, saveSelectedKey,
    runProvider, verifyGithubIdentity, verifyPanelIdentity, cookieDictionary, githubRecoveryKind,
    canRecoverGithubLogin, providerOAuthCompletion, stableGithubAuthorize, recoverGithubLogin, persistReferral };
