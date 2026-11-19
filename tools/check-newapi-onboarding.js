'use strict';
// Local fixtures only: never accesses a real account or vendor.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const runtimePath = '../routing/lib/newapi-onboarding.js';

test('selected account reuses its named key without creating a second token', async () => {
    const { createPanelClient, ensurePanelKey } = require(runtimePath);
    const calls = [];
    const server = http.createServer((req, res) => {
        calls.push([req.method, req.url]);
        assert.equal(req.headers.authorization, 'Bearer fixture-panel-session');
        assert.equal(req.headers['new-api-user'], '41');
        res.setHeader('content-type', 'application/json');
        if (req.url.startsWith('/api/token/?')) return res.end(JSON.stringify({ success: true,
            data: { items: [{ id: 7, name: '1', status: 1, key: 'masked*****' }] } }));
        if (req.url === '/api/token/7/key') return res.end(JSON.stringify({ success: true, data: { key: 'fixture-generated-key' } }));
        res.writeHead(404); res.end('{}');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
        const client = createPanelClient({ origin: `http://127.0.0.1:${server.address().port}`, bearer: 'fixture-panel-session', userId: 41,
            request: async (url, opts) => { const r = await fetch(url, opts); return { status: r.status, json: await r.json() }; } });
        const key = await ensurePanelKey(client, { name: '1', keyPrefix: 'sk-' });
        assert.equal(key, 'sk-fixture-generated-key');
        assert.equal(calls.filter(([method, url]) => method === 'POST' && url === '/api/token/').length, 0);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('OAuth callback network failure never replays the one-time code', async () => {
    const { watchPanelAuth } = require(runtimePath);
    let handler, fetches = 0, continues = 0, aborts = 0;
    const context = { route: async (pattern, cb) => { handler = cb; } };
    const auth = await watchPanelAuth(context, { origin: 'https://panel.example', callbackPath: '/api/oauth/github' });
    await handler({ request: () => ({ url: () => 'https://panel.example/api/oauth/github?code=private' }),
        fetch: async () => { fetches++; throw new Error('private callback'); },
        abort: async () => { aborts++; }, continue: async () => { continues++; } });
    assert.equal(fetches, 1); assert.equal(continues, 0); assert.equal(aborts, 1);
    assert.equal(auth.error.code, 'oauth_transport_failed');
});

test('classic New API OAuth callback captures flat identity without confusing an API key with bearer auth', async () => {
    const { watchPanelAuth } = require(runtimePath);
    let handler;
    const auth = await watchPanelAuth({ route: async (_pattern, cb) => { handler = cb; } },
        { origin: 'https://panel.example', callbackPath: '/api/oauth/github' });
    await handler({ request: () => ({ url: () => 'https://panel.example/api/oauth/github?code=fixture' }),
        fetch: async () => ({ text: async () => JSON.stringify({ success: true, data: { id: 41, username: 'alice' } }), status: () => 200 }),
        fulfill: async () => {}, abort: async () => {} });
    assert.equal(auth.user?.id, 41);
    assert.equal(auth.user?.source, 'oauth');
    assert.equal(auth.bearer, '');
});

test('ambiguous active tokens with the same name are refused before reveal or create', async () => {
    const { ensurePanelKey } = require(runtimePath);
    let writes = 0;
    const client = async (_route, method = 'GET') => {
        if (method !== 'GET') writes++;
        return { items: [{ id: 7, name: '1', status: 1 }, { id: 8, name: '1', status: 1 }] };
    };
    await assert.rejects(ensurePanelKey(client, { name: '1' }), /token_name_ambiguous/);
    assert.equal(writes, 0);
});

test('only the exact existing row is updated and read back', async () => {
    const { saveSelectedKey } = require(runtimePath);
    const rows = [{ id: 'fg_1', email: 'alice', api_key: 'no-key' }, { id: 'fg_2', email: 'bob', api_key: 'untouched' }];
    let writes = 0;
    const request = async (url, opts) => {
        writes++; const body = JSON.parse(opts.body);
        rows.find(r => r.id === body.id).api_key = body.api_key;
        return { status: 200, json: { ok: true } };
    };
    const result = await saveSelectedKey({ id: 'fg_1', key: 'fixture-generated-key', p: 'fg',
        hubOrigin: 'http://127.0.0.1:8200', readPool: () => rows, request });
    assert.equal(result.ok, true); assert.equal(writes, 1); assert.equal(rows[1].api_key, 'untouched');
    await assert.rejects(saveSelectedKey({ id: 'missing', key: 'fixture-generated-key', p: 'fg', readPool: () => rows, request }), /pool_target_missing/);
});

test('GitHub TOTP recovery works on an existing two-factor page even without a stored password', async () => {
    const { recoverGithubLogin } = require(runtimePath);
    let received;
    const result = await recoverGithubLogin({ url: () => 'https://github.com/sessions/two-factor/app' },
        { login: 'alice', totpSecret: 'fixture-totp' }, {
            fillLogin: async (_page, account, opts) => { received = { account, opts }; return { ok: true }; },
            sessionProbe: async () => true, log: () => {},
        });
    assert.equal(result.ok, true);
    assert.equal(received.account.totpSecret, 'fixture-totp');
    assert.equal(received.account.password, undefined);
    assert.equal(typeof received.opts.sessionProbe, 'function');
});

test('TOTP-only recovery waits for the exact GitHub 2FA page instead of failing the login page', () => {
    const { canRecoverGithubLogin } = require(runtimePath);
    assert.equal(canRecoverGithubLogin('https://github.com/login', { password: 'fixture-password' }), true);
    assert.equal(canRecoverGithubLogin('https://github.com/login', { totpSecret: 'fixture-totp' }), false);
    assert.equal(canRecoverGithubLogin('https://github.com/sessions/two-factor/app', { totpSecret: 'fixture-totp' }), true);
    assert.equal(canRecoverGithubLogin('https://github.com/login', {}), false);
});

test('New API GitHub onboarding without a referral reaches launch using common defaults', async () => {
    const { runProvider } = require(runtimePath);
    let launches = 0;
    await assert.rejects(runProvider({ provider: 'examplegw', moduleDir: '/fixture/examplegw', label: 'acct_chosen',
        config: { full: 'examplegw', p: 'zz', HOST: 'example.invalid', github: true, ref: false,
            onboarding: { kind: 'newapi-github' } },
        readPool: () => [{ id: 'chosen', ghId: 'alice' }], account: { id: 'alice', login: 'alice' },
        launch: async () => { launches++; throw new Error('fixture-launch-marker'); },
    }), /fixture-launch-marker/);
    assert.equal(launches, 1);
});

test('referral bootstrap retries once when the panel stores aff after the first navigation', async () => {
    const { persistReferral } = require(runtimePath);
    let visits = 0, reads = 0;
    const page = {
        goto: async url => { assert.equal(url, 'https://freegg.app/sign-up?aff=nVhs'); visits++; },
        waitForTimeout: async () => {},
        evaluate: async () => (++reads === 1 ? null : 'nVhs'),
    };
    assert.equal(await persistReferral(page, 'https://freegg.app/sign-up?aff=nVhs'), 'nVhs');
    assert.equal(visits, 2, 'the same referral is revisited once before failing');
});

test('runtime validates selected id and bound GitHub before opening a browser', async () => {
    const { runProvider } = require(runtimePath);
    let launches = 0;
    await assert.rejects(runProvider({ provider: 'freegg', moduleDir: '/fixture/freegg', label: '../escape',
        config: { full: 'freegg' }, launch: async () => { launches++; } }), /profile_label_invalid/);
    assert.equal(launches, 0);
});

test('existing classic token list full key is reused without unsupported reveal', async () => {
    const { ensurePanelKey } = require(runtimePath);
    let calls = 0;
    const key = await ensurePanelKey(async () => {
        calls++;
        return [{ id: 7, name: '1', status: 1, key: 'fixture-classic-full-key' }];
    }, { name: '1', keyPrefix: 'sk-' });
    assert.equal(key, 'sk-' + 'fixture-classic-full-key');
    assert.equal(calls, 1, 'a full key does not need a reveal API');
});

test('real common GitHub login completes a TOTP-only page with explicit opt-in', async () => {
    const { recoverGithubLogin } = require(runtimePath);
    let filled = false, submits = 0;
    const page = {
        url: () => 'https://github.com/sessions/two-factor/app',
        evaluate: async () => ({ text: '', iframes: [] }),
        waitForTimeout: async () => {},
        locator: selector => ({ first: () => ({
            count: async () => selector === '#app_totp' && !filled ? 1 : 0,
            isVisible: async () => selector === '#app_totp' && !filled,
            fill: async value => { assert.match(value, /^\d{6}$/); filled = true; },
            click: async () => { submits++; },
        }) }),
    };
    const result = await recoverGithubLogin(page, { login: 'alice', totpSecret: 'JBSWY3DPEHPK3PXP' },
        { sessionProbe: async () => filled, log: () => {} });
    assert.equal(result.ok, true);
    assert.equal(submits, 0, 'auto-submitted TOTP form is not submitted twice');
});

test('wrong GitHub identity is rejected before granting OAuth consent', async () => {
    const { verifyGithubIdentity } = require(runtimePath);
    const context = { cookies: async () => [{ name: 'dotcom_user', value: 'bob', domain: '.github.com' }] };
    await assert.rejects(verifyGithubIdentity(context, 'alice'), /github_identity_mismatch/);
});

test('browser cookie list is converted to the common jar dictionary', () => {
    const { cookieDictionary } = require(runtimePath);
    assert.deepEqual(cookieDictionary([{ name: 'new_api_refresh', value: 'fixture-refresh', domain: 'freegg.app' },
        { name: 'user_session', value: 'fixture-github', domain: '.github.com' }], 'freegg.app'), { new_api_refresh: 'fixture-refresh' });
});

test('an unrelated existing panel session cannot be attributed to the selected GitHub', () => {
    const { verifyPanelIdentity } = require(runtimePath);
    assert.throws(() => verifyPanelIdentity({ id: 41, username: 'bob' }, { login: 'alice' }, null), /panel_identity_mismatch/);
    assert.throws(() => verifyPanelIdentity({ id: 41, username: 'bob' }, { login: 'alice' }, { id: 41, source: 'refresh' }), /panel_identity_mismatch/);
    assert.doesNotThrow(() => verifyPanelIdentity({ id: 41, username: 'alice' }, { login: 'alice' }, null));
});

test('new named token is created once, persisted only after reveal readback', async () => {
    const { ensurePanelKey } = require(runtimePath);
    const writes = []; let created = false;
    const client = async (route, method = 'GET', body) => {
        if (method === 'POST' && route === '/api/token/') { writes.push(body); created = true; return null; }
        if (route.startsWith('/api/token/?')) return { items: created ? [{ id: 8, name: '1', status: 1 }] : [] };
        if (route === '/api/token/8/key') return { key: 'fixture-generated-key' };
        throw new Error('unexpected route');
    };
    assert.equal(await ensurePanelKey(client, { name: '1' }), 'fixture-generated-key');
    assert.equal(writes.length, 1); assert.equal(writes[0].name, '1'); assert.equal(writes[0].expired_time, -1);
    assert.equal(writes[0].unlimited_quota, true); assert.equal(writes[0].cross_group_retry, false);
});

test('429 is terminal, secret errors are not echoed and cross-origin is rejected', async () => {
    const { createPanelClient } = require(runtimePath);
    let calls = 0;
    const client = createPanelClient({ origin: 'https://panel.example', bearer: 'fixture-private', userId: 1,
        request: async () => { calls++; return { status: 429, json: { message: 'fixture-private' } }; } });
    await assert.rejects(client('/api/token/'), e => e.status === 429 && !e.message.includes('fixture-private'));
    assert.equal(calls, 1);
    await assert.rejects(client('https://evil.example/api/token/'), /panel_origin_rejected/);
    assert.equal(calls, 1);
});

test('full runtime proves panel session, creates key and saves only selected row in a real browser fixture', async () => {
    const fs = require('node:fs'), path = require('node:path');
    const { chromium } = require('playwright');
    const { runProvider } = require(runtimePath);
    const root = fs.mkdtempSync(path.join('C:/Users/WormAlien/AppData/Local/hermes/cache/scratch', 'onboarding-'));
    const moduleDir = path.join(root, 'freegg'); fs.mkdirSync(moduleDir, { recursive: true });
    const rows = [{ id: 'fg_fixture', email: 'alice', ghId: 'gh_fixture', api_key: 'sk-' + 'fixture-existing-key' }];
    let created = false, creations = 0, hubWrites = 0;
    const hub = http.createServer((req, res) => {
        let body = ''; req.on('data', c => body += c); req.on('end', () => {
            assert.equal(req.url, '/__switch/api/fg/key');
            const payload = JSON.parse(body); assert.equal(payload.id, 'fg_fixture');
            rows[0].api_key = payload.api_key; hubWrites++;
            res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
        });
    });
    hub.listen(0, '127.0.0.1'); await once(hub, 'listening');
    const logs = [];
    const launch = async (dir, options) => {
        const context = await chromium.launchPersistentContext(dir, { ...options, headless: true, channel: undefined });
        await context.addCookies([{ name: 'dotcom_user', value: 'alice', domain: '.github.com', path: '/' }]);
        await context.route('**/*', async route => {
            const u = new URL(route.request().url());
            if (u.hostname !== 'freegg.app') throw new Error('unexpected network');
            if (u.pathname === '/sign-up') return route.fulfill({ contentType: 'text/html', body: '<script>localStorage.setItem("aff","nVhs")</script>' });
            let data;
            if (u.pathname === '/api/user/self') data = { id: 41, username: 'alice' };
            else if (u.pathname === '/api/token/' && route.request().method() === 'GET') data = { items: created ? [{ id: 8, name: '1', status: 1 }] : [] };
            else if (u.pathname === '/api/token/' && route.request().method() === 'POST') {
                assert.equal(route.request().postDataJSON().name, '1'); created = true; creations++;
            }
            else if (u.pathname === '/api/token/8/key') data = { key: 'fixture-generated-key' };
            else throw new Error('unexpected route ' + u.pathname);
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
        });
        return context;
    };
    try {
        const result = await runProvider({ provider: 'freegg', moduleDir, label: 'acct_fg_fixture', mode: 'provision',
            config: { full: 'freegg', p: 'fg', HOST: 'freegg.app', github: true, ref: true,
                onboarding: { kind: 'newapi-github', consolePath: '/console/token', callbackPath: '/api/oauth/github', tokenName: '1' } },
            readPool: () => rows, account: { id: 'gh_fixture', login: 'alice' }, launch,
            hubOrigin: `http://127.0.0.1:${hub.address().port}`, log: line => logs.push(line) });
        assert.equal(result.ok, true); assert.equal(result.userId, 41);
        assert.equal(creations, 1); assert.equal(hubWrites, 1);
        assert.equal(rows[0].api_key, 'sk-' + 'fixture-generated-key');
        assert.ok(!logs.join('\n').includes('fixture-generated-key'));
    } finally { await new Promise(resolve => hub.close(resolve)); }
});
