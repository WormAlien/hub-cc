'use strict';
// Full real dashboard manager scenario; all network intercepted locally.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), routing = path.join(root, 'routing');
const out = fs.mkdtempSync(path.join('C:/Users/WormAlien/AppData/Local/hermes/cache/scratch', 'fx-manager-ui-'));
const html = fs.readFileSync(path.join(routing, 'proxy-dashboard.html'), 'utf8');
(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const width of [1365, 390]) {
            const errors = [], writes = [], sessions = [];
            let opened = false;
            const gh = [{ id: 'gh_ui', login: 'alice', nickname: 'alice', status: 'live', hasPassword: true, hasTotp: true }];
            const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
            await context.addInitScript(() => { localStorage.setItem('opencode_active_tab', 'fxqidian'); });
            await context.route('**/*', async route => {
                const req = route.request(), url = new URL(req.url());
                if (url.origin !== 'http://fx-manager.invalid') return route.abort();
                if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
                const vendorAt = url.pathname.indexOf('/vendor/');
                if (vendorAt >= 0) {
                    const rel = url.pathname.slice(vendorAt + 8), file = path.resolve(routing, 'vendor', rel);
                    if (file.startsWith(path.join(routing, 'vendor') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                        return route.fulfill({ body: fs.readFileSync(file), contentType: rel.endsWith('.js') ? 'application/javascript' : rel.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
                    }
                }
                let result = { ok: true, sessions: [], data: [], models: [], accounts: [] };
                if (url.pathname.endsWith('/gh/keys')) result = { accounts: gh };
                if (url.pathname.endsWith('/gh/available')) result = { accounts: [{ ...gh[0], inPool: false, hasSession: false, allSourcesBusy: false, usedHere: false }], building: false };
                if (url.pathname.includes('/fx/')) {
                    if (req.method() === 'POST') writes.push([url.pathname, req.postDataJSON()]);
                    if (url.pathname.endsWith('/sessions')) {
                        if (opened && sessions.length) sessions[0].api_key = 'sk-' + 'fixture-key-created';
                        result = { sessions, activeModel: 'deepseek-v4-flash', modelMap: { opus: 'deepseek-v4-flash', sonnet: 'deepseek-v4-flash', haiku: 'deepseek-v4-flash' } };
                    } else if (url.pathname.endsWith('/models')) result = { ok: true, models: [{ id: 'deepseek-v4-flash' }] };
                    else if (url.pathname.endsWith('/modelmap')) result = { ok: true, modelMap: { opus: 'deepseek-v4-flash' } };
                    else if (url.pathname.endsWith('/add-github')) {
                        assert.equal(req.postDataJSON().ghId, 'gh_ui');
                        assert.equal(sessions.length, 0, 'one manager click produces one provider record');
                        sessions.push({ id: 'fx_ui', email: 'alice', name: 'alice', api_key: 'no-key-fixture', status: 'no_key', ghId: 'gh_ui', active: false });
                        result = { ok: true, id: 'fx_ui', label: 'acct_fx_ui', ghLogin: 'alice', deadSession: true };
                    } else if (url.pathname.endsWith('/session/open')) {
                        assert.deepEqual(req.postDataJSON(), { id: 'fx_ui', mode: 'provision' });
                        opened = true;
                        result = { ok: true, label: 'acct_fx_ui', pid: 1, mode: 'provision' };
                    }
                }
                await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
            });
            const page = await context.newPage();
            page.on('pageerror', e => errors.push(e.message));
            await page.goto('http://fx-manager.invalid/', { waitUntil: 'domcontentloaded' });
            const panel = page.locator('[data-tab-content="fxqidian"]');
            await panel.locator('h1').waitFor({ state: 'visible' });
            await page.waitForTimeout(1500);
            await page.evaluate(() => { state.github = [{ id: 'gh_ui', login: 'alice', nickname: 'alice', status: 'live', hasPassword: true, hasTotp: true }]; state.loaded.github = true; });
            await panel.locator('button').filter({ hasText: '➕ Добавить' }).click();
            await panel.locator('button[onclick*=newapiAddPickGithub]').click();
            await page.locator('#gh-bind-modal').waitFor({ state: 'visible' });
            await page.locator('[onclick*=newapiAddTakeGh]').filter({ hasText: 'alice' }).click();
            await page.waitForFunction(() => state.fxqidian.some(r => r.id === 'fx_ui' && r.api_key.startsWith('sk-')));
            assert.equal(writes.filter(([u]) => u.endsWith('/add-github')).length, 1);
            assert.equal(writes.filter(([u]) => u.endsWith('/session/open')).length, 1);
            assert.equal(sessions.length, 1); assert.equal(sessions[0].active, false);
            const credPopup = page.locator('#gh-cred-pop');
            assert.equal(await credPopup.isVisible().catch(() => false), false, 'no credentials popup after automatic onboarding');
            await page.screenshot({ path: path.join(out, `fx-manager-${width}.png`), fullPage: true });
            assert.deepEqual(errors, [], 'dashboard JS errors');
            console.log(`UI ${width}px: full manager select -> exact account -> provision -> key readback PASS`);
            await context.close();
        }
        console.log('SCREENSHOTS ' + out);
    } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
