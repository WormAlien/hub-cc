'use strict';
// Real Chromium + production runtime/GitHub-login with synthetic credentials only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { runProvider } = require('../routing/lib/newapi-onboarding');
const { totpCode } = require('../routing/lib/totp');
const scratch = process.env.HERMES_TEST_SCRATCH || 'C:/Users/WormAlien/AppData/Local/hermes/cache/scratch';

test('GitHub identity stored as an email still completes OAuth consent without reloading the login page', async () => {
    // Живой регресс 24.11 (freegg/ciciaidiltaslim): в записи менеджера login=<почта>,
    // GitHub в dotcom_user отдаёт имя пользователя. Проба личности отвергала успешный вход,
    // и прогон вместо согласия дважды перезагружал /login. Здесь проверяется вся цепочка:
    // пароль -> 2FA -> страница согласия -> колбэк панели -> ключ.
    const root = fs.mkdtempSync(path.join(scratch, 'newapi-email-login-'));
    const moduleDir = path.join(root, 'freegg');
    fs.mkdirSync(moduleDir, { recursive: true });
    const account = { id: 'gh_fixture', login: 'ciciaidiltaslim@gmail.com', nickname: 'ciciaidiltaslim',
        password: 'fixture-password', totpSecret: 'JBSWY3DPEHPK3PXP' };
    const rows = [{ id: 'fg_fixture', ghId: 'gh_fixture', api_key: 'no-key-fixture', active: false }];
    let loginPageLoads = 0, consents = 0, keyWrites = 0, totpPosts = 0;
    const hub = http.createServer((req, res) => {
        let body = ''; req.on('data', c => body += c); req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            // Штатный шов watchPanelAuth: завершение OAuth уходит на callback-транспорт.
            if (req.url === '/callback') {
                return res.end(JSON.stringify({ success: true, data: { id: 41, username: 'ciciaidiltaslim' } }));
            }
            const payload = JSON.parse(body);
            rows[0].api_key = payload.api_key; keyWrites++;
            res.end('{"ok":true}');
        });
    });
    hub.listen(0, '127.0.0.1'); await once(hub, 'listening');
    const logs = [];
    const launch = async (dir, options) => {
        const context = await chromium.launchPersistentContext(dir, { ...options, headless: true, channel: undefined });
        const originalRoute = context.route.bind(context);
        context.route = (matcher, handler) => {
            if (typeof matcher !== 'function') return originalRoute(matcher, handler);
            return originalRoute(matcher, route => handler({
                request: () => route.request(),
                fetch: options => route.fetch({ ...options, url: hubOrigin + '/callback' }),
                fulfill: options => route.fulfill(options),
                abort: () => route.abort(),
            }));
        };
        await originalRoute('**/*', async route => {
            const req = route.request();
            const u = new URL(req.url());
            if (u.hostname === 'github.com') {
                if (u.pathname === '/login') {
                    loginPageLoads++;
                    return route.fulfill({ contentType: 'text/html', body:
                        '<form action="/session" method="post"><input id="login_field" name="login"><input id="password" name="password" type="password"><input name="commit" type="submit" value="Sign in"></form>' });
                }
                if (u.pathname === '/session') {
                    const form = new URLSearchParams(req.postData());
                    assert.equal(form.get('login'), account.login, 'в GitHub уходит то, что в записи');
                    // 🔴 Вход принят: GitHub кладёт в куку ИМЯ, а не адрес из формы.
                    await context.addCookies([{ name: 'dotcom_user', value: 'ciciaidiltaslim', domain: '.github.com', path: '/' }]);
                    return route.fulfill({ contentType: 'text/html', body:
                        '<script>location.href="https://github.com/sessions/two-factor/app"</script>' });
                }
                if (u.pathname === '/sessions/two-factor/app') return route.fulfill({ contentType: 'text/html', body:
                    '<form id="otp" action="/sessions/two-factor" method="post"><input id="app_totp" name="app_otp" oninput="if(this.value.length===6)document.getElementById(\'otp\').submit()"></form>' });
                if (u.pathname === '/sessions/two-factor') {
                    totpPosts++;
                    await context.addCookies([{ name: 'user_session', value: 'fixture-session', domain: '.github.com', path: '/' },
                        { name: 'dotcom_user', value: 'ciciaidiltaslim', domain: '.github.com', path: '/' }]);
                    return route.fulfill({ contentType: 'text/html', body:
                        '<script>location.href="https://github.com/login/oauth/authorize"</script>' });
                }
                if (u.pathname === '/login/oauth/authorize') return route.fulfill({ contentType: 'text/html', body:
                    '<button name="authorize" value="1" onclick="location.href=\'https://freegg.app/oauth/github?code=fixture\'">Authorize</button>' });
                throw new Error('unexpected GitHub route ' + u.pathname);
            }
            if (u.hostname !== 'freegg.app') throw new Error('unexpected network ' + u.hostname);
            if (u.pathname === '/sign-up') return route.fulfill({ contentType: 'text/html', body:
                '<script>localStorage.setItem("aff","nVhs")</script>'
                + '<button onclick="location.href=\'https://github.com/login\'">Continue with GitHub</button>' });
            if (u.pathname === '/oauth/github') {
                consents++; localStorageMarker = true;
                return route.fulfill({ contentType: 'text/html', body:
                    '<script>fetch("/api/oauth/github?code=fixture").then(r=>r.json()).then(j=>{localStorage.setItem("user",JSON.stringify(j.data));location.href="/console/token"})</script>' });
            }
            if (u.pathname === '/console/token') return route.fulfill({ contentType: 'text/html', body: 'Token console' });
            let data;
            // Панель не знает этого GitHub, пока OAuth не завершён: иначе прогон
            // «доказывает» сессию без входа и тест перестаёт проверять цепочку.
            if (u.pathname === '/api/user/self') {
                if (!totpPosts) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"success":false}' });
                data = { id: 41, username: 'ciciaidiltaslim' };
            }
            else if (u.pathname === '/api/token/' && req.method() === 'GET') data = { items: [{ id: 8, name: '1', status: 1, key: 'fixture-email-full-key' }] };
            else throw new Error('unexpected panel route ' + u.pathname);
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
        });
        return context;
    };
    let localStorageMarker = false;
    const hubOrigin = `http://127.0.0.1:${hub.address().port}`;
    try {
        const result = await runProvider({ provider: 'freegg', moduleDir, label: 'acct_fg_fixture', mode: 'provision',
            config: { full: 'freegg', p: 'fg', HOST: 'freegg.app', github: true, ref: true,
                onboarding: { kind: 'newapi-github', consolePath: '/console/token', callbackPath: '/api/oauth/github', tokenName: '1' } },
            readPool: () => rows, account, launch, hubOrigin, timeoutMs: 60000,
            log: line => logs.push(line),
            // Сессия доказывается тем же способом, что в бою: кука + согласие.
            githubLoginOptions: {} });
        assert.equal(result.ok, true);
        assert.equal(loginPageLoads, 1, 'страницу входа загружали РОВНО раз, без перезагрузок');
        assert.equal(totpPosts, 1, '2FA принят с первого кода');
        assert.equal(consents, 1, 'согласие GitHub пройдено');
        assert.equal(keyWrites, 1);
        assert.equal(rows[0].api_key, 'sk-' + 'fixture-email-full-key');
        assert.ok(!logs.join('\n').includes('перезагружаю'), 'перезагрузки страницы входа не было');
    } finally {
        hub.closeAllConnections(); await new Promise(resolve => hub.close(resolve));
    }
});

test('selected GitHub password and TOTP flow creates classic named key once and reuses it', async () => {
    const root = fs.mkdtempSync(path.join(scratch, 'newapi-login-e2e-'));
    const moduleDir = path.join(root, 'fxqidian');
    fs.mkdirSync(moduleDir, { recursive: true });
    const rows = [{ id: 'fx_fixture', ghId: 'gh_fixture', api_key: 'no-key-fixture', active: false },
        { id: 'untouched', ghId: 'other', api_key: 'fixture-other', active: true }];
    const account = { id: 'gh_fixture', login: 'alice', password: 'fixture-password', totpSecret: 'JBSWY3DPEHPK3PXP' };
    const fixtureTotps = ['111111', '222222'];
    let tokenCreated = false, creates = 0, writes = 0, loginPosts = 0, totpPosts = 0, consents = 0;
    const submittedTotps = [];
    const logs = [];
    const api = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/callback') return res.end(JSON.stringify({ success: true, data: { id: 41, username: 'alice' } }));
            assert.equal(req.url, '/__switch/api/fx/key');
            const body = JSON.parse(raw);
            assert.equal(body.id, 'fx_fixture');
            rows[0].api_key = body.api_key;
            writes++;
            res.end('{"ok":true}');
        });
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const hubOrigin = `http://127.0.0.1:${api.address().port}`;
    const contexts = [];
    const launch = async (dir, options) => {
        const context = await chromium.launchPersistentContext(dir, { ...options, headless: true, channel: undefined });
        contexts.push(context);
        // Authentication callback still executes watchPanelAuth/route.fetch, but the
        // fixture transport targets a local server instead of the real OAuth host.
        const originalRoute = context.route.bind(context);
        context.route = (matcher, handler) => {
            if (typeof matcher !== 'function') return originalRoute(matcher, handler);
            return originalRoute(matcher, route => handler({
                request: () => route.request(),
                fetch: options => route.fetch({ ...options, url: hubOrigin + '/callback' }),
                fulfill: options => route.fulfill(options),
                abort: () => route.abort(),
            }));
        };
        await originalRoute('**/*', async route => {
            const req = route.request();
            const url = new URL(req.url());
            if (url.hostname === 'github.com') {
                if (url.pathname === '/login') return route.fulfill({ contentType: 'text/html', body:
                    '<form action="/sessions" method="post"><input id="login_field" name="login"><input id="password" name="password" type="password"><input name="commit" type="submit" value="Sign in"></form>' });
                if (url.pathname === '/sessions') {
                    const form = new URLSearchParams(req.postData());
                    assert.equal(form.get('login'), account.login);
                    assert.equal(form.get('password'), account.password);
                    loginPosts++;
                    return route.fulfill({ contentType: 'text/html', body: '<script>location.href="https://github.com/sessions/two-factor/app"</script>' });
                }
                if (url.pathname === '/sessions/two-factor/app') return route.fulfill({ contentType: 'text/html', body:
                    '<form id="otp" action="/sessions/two-factor" method="post"><input id="app_totp" name="app_otp" oninput="if(this.value.length===6)document.getElementById(\'otp\').submit()"></form>' });
                if (url.pathname === '/sessions/two-factor') {
                    const submitted = new URLSearchParams(req.postData()).get('app_otp');
                    assert.equal(submitted, fixtureTotps[totpPosts]);
                    submittedTotps.push(submitted); totpPosts++;
                    await context.addCookies([{ name: 'dotcom_user', value: 'alice', domain: '.github.com', path: '/' },
                        { name: 'user_session', value: 'fixture-session', domain: '.github.com', path: '/' }]);
                    if (totpPosts === 1) return route.fulfill({ contentType: 'text/html', body:
                        '<script>location.href="https://github.com/sessions/sudo"</script>' });
                    return route.fulfill({ contentType: 'text/html', body:
                        '<script>location.href="https://github.com/login/oauth/authorize"</script>' });
                }
                if (url.pathname === '/sessions/sudo') return route.fulfill({ contentType: 'text/html', body:
                    '<a href="/sessions/two-factor/app">Authenticator app</a>' });
                if (url.pathname === '/login/oauth/authorize') return route.fulfill({ contentType: 'text/html', body:
                    '<button name="authorize" value="1" onclick="location.href=\'https://fxqidian.de5.net/oauth/github?code=fixture\'">Authorize</button>' });
                throw new Error('unexpected GitHub fixture route ' + url.pathname);
            }
            if (url.hostname !== 'fxqidian.de5.net') return route.abort();
            if (url.pathname === '/sign-up') return route.fulfill({ contentType: 'text/html', body:
                '<script>localStorage.setItem("aff","9BEo")</script><button onclick="location.href=\'https://github.com/login\'">Continue with GitHub</button>' });
            if (url.pathname === '/oauth/github') {
                consents++;
                await context.addCookies([{ name: 'session', value: 'fixture-classic-session', domain: 'fxqidian.de5.net', path: '/' }]);
                return route.fulfill({ contentType: 'text/html', body:
                    '<script>fetch("/api/oauth/github?code=fixture").then(r=>r.json()).then(j=>{localStorage.setItem("user",JSON.stringify(j.data));location.href="/keys"})</script>' });
            }
            if (url.pathname === '/keys') return route.fulfill({ contentType: 'text/html', body: 'Token console' });
            let data;
            if (url.pathname === '/api/user/self') {
                if (req.headers()['new-api-user'] !== '41') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"success":false}' });
                data = { id: 41, username: 'alice' };
            } else if (url.pathname === '/api/token/' && req.method() === 'GET') {
                assert.equal(req.headers()['new-api-user'], '41');
                data = tokenCreated ? [{ id: 7, name: '1', status: 1, key: 'fixture-classic-full-key' }] : [];
            } else if (url.pathname === '/api/token/' && req.method() === 'POST') {
                assert.equal(req.postDataJSON().name, '1');
                tokenCreated = true; creates++;
            } else throw new Error('unexpected vendor fixture route ' + url.pathname);
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
        });
        return context;
    };
    try {
        const opts = { provider: 'fxqidian', moduleDir, label: 'acct_fx_fixture', mode: 'provision',
            config: { full: 'fxqidian', p: 'fx', HOST: 'fxqidian.de5.net', github: true, ref: true,
                onboarding: { kind: 'newapi-github', consolePath: '/keys', callbackPath: '/api/oauth/github', tokenName: '1' } },
            readPool: () => rows, account, launch, hubOrigin, timeoutMs: 45000, log: line => logs.push(line),
            githubLoginOptions: { totpCode: () => fixtureTotps[Math.min(totpPosts, fixtureTotps.length - 1)] } };
        assert.equal((await runProvider(opts)).ok, true);
        assert.equal(creates, 1); assert.equal(writes, 1);
        assert.equal(loginPosts, 1); assert.equal(totpPosts, 2); assert.equal(consents, 1);
        assert.notEqual(submittedTotps[0], submittedTotps[1], 'sudo challenge waits for a fresh TOTP window');
        assert.equal(rows[0].api_key, 'sk-' + 'fixture-classic-full-key');
        assert.equal(rows[0].active, false); assert.equal(rows[1].api_key, 'fixture-other');
        assert.equal((await runProvider(opts)).ok, true);
        assert.equal(creates, 1, 'repeat does not create a duplicate key');
        assert.equal(loginPosts, 1, 'repeat preserves existing GitHub session');
        assert.equal(totpPosts, 2); assert.equal(consents, 1);
        assert.ok(!logs.join('\n').includes(account.password));
        assert.ok(!logs.join('\n').includes(account.totpSecret));
        assert.ok(!logs.join('\n').includes('fixture-classic-full-key'));
    } catch (error) {
        console.error('E2E_FAILURE', error.code || error.message, logs);
        throw error;
    } finally {
        for (const context of contexts) await Promise.race([context.close().catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 3000))]);
        api.closeAllConnections();
        await new Promise(resolve => api.close(resolve));
    }
});
