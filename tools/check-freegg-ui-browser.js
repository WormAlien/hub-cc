'use strict';
// Entire dashboard, intercepted local fixtures; no live accounts, no vendor network.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), routing = path.join(root, 'routing');
const out = fs.mkdtempSync(path.join('C:/Users/WormAlien/AppData/Local/hermes/cache/scratch', 'freegg-ui-'));
const html = fs.readFileSync(path.join(routing, 'proxy-dashboard.html'), 'utf8');
const sessions = [{ id: 'fg_ui', email: 'WormAlien', name: 'WormAlien', api_key: 'no-key-fixture', status: 'no_key', ghId: 'gh_ui', active: false }];
const map = { opus: 'gpt-6.1-sol', sonnet: 'gpt-6.1-sol', haiku: 'gpt-6.1-sol' };
(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const width of [1365, 390]) {
            const errors = [], writes = [], requests = [];
            let added = false, opened = false, rateEnabled = false;
            sessions.splice(1);
            sessions[0].api_key = 'no-key-fixture';
            const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
            await context.addInitScript(() => { localStorage.setItem('opencode_active_tab', 'freegg'); });
            await context.route('**/*', async route => {
                const req = route.request(), url = new URL(req.url());
                const headers = req.headers();
                requests.push({
                    method: req.method(), path: url.pathname,
                    contentType: headers['content-type'] || '', secFetchSite: headers['sec-fetch-site'] || '',
                });
                if (url.origin !== 'http://freegg-ui.invalid') return route.abort();
                if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
                const vendorAt = url.pathname.indexOf('/vendor/');
                if (vendorAt >= 0) {
                    const rel = url.pathname.slice(vendorAt + 8), file = path.resolve(routing, 'vendor', rel);
                    if (file.startsWith(path.join(routing, 'vendor') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                        return route.fulfill({ body: fs.readFileSync(file), contentType: rel.endsWith('.js') ? 'application/javascript' : rel.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
                    }
                }
                let result = { ok: true, sessions: [], data: [], models: [], accounts: [] };
                if (url.pathname.endsWith('/gh/keys')) result = { accounts: [{ id: 'gh_ui', login: 'alice', nickname: 'alice', status: 'live', hasPassword: true, hasTotp: true }] };
                if (url.pathname.endsWith('/gh/available')) result = { accounts: [{ id: 'gh_ui', login: 'alice', nickname: 'alice', status: 'live', hasPassword: true, hasTotp: true,
                    inPool: false, hasSession: false, allSourcesBusy: false, usedHere: false }], building: false };
                if (url.pathname.includes('/fg/')) {
                    if (req.method() === 'POST') writes.push(url.pathname);
                    if (url.pathname.endsWith('/rate-policy')) {
                        if (req.method() === 'POST') rateEnabled = !!req.postDataJSON().enabled;
                        result = { ok: true, enabled: rateEnabled, scope: rateEnabled ? 'account' : 'off', restarted: req.method() === 'POST' };
                    }
                    if (!url.pathname.endsWith('/rate-policy') && added && !sessions.some(row => row.id === 'fg_added')) sessions.push({ id: 'fg_added', email: 'alice', name: 'alice', api_key: 'no-key-fixture', status: 'no_key', ghId: 'gh_ui', active: false });
                    if (opened && sessions.some(row => row.id === 'fg_added')) sessions.find(row => row.id === 'fg_added').api_key = 'sk-' + 'fixture-created-key';
                    if (url.pathname.endsWith('/sessions')) result = { sessions, activeModel: 'gpt-6.1-sol', modelMap: map };
                    else if (url.pathname.endsWith('/models')) result = { ok: true, data: [{ id: 'gpt-6.1-sol' }], models: [{ id: 'gpt-6.1-sol' }] };
                    else if (url.pathname.endsWith('/modelmap')) result = { ok: true, modelMap: map };
                    else if (url.pathname.includes('/keepalive/state')) result = { ok: true, up: true, config: { hedgeMs: 0, maxHedges: 0, maxAttempts: 1 }, stats: {} };
                    else if (url.pathname.endsWith('/add-github')) {
                        assert.equal(req.postDataJSON().ghId, 'gh_ui'); added = true;
                        result = { ok: true, id: 'fg_added', label: 'acct_fg_added', ghLogin: 'alice', deadSession: true };
                    }
                    else if (url.pathname.endsWith('/session/open')) {
                        const body = req.postDataJSON();
                        if (body.id === 'fg_added') assert.deepEqual(body, { id: 'fg_added', mode: 'provision' });
                        opened = true; result = { ok: true, label: `acct_${body.id}`, pid: 1, mode: body.mode || 'register' };
                    }
                }
                await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
            });
            const page = await context.newPage();
            page.on('pageerror', e => errors.push(e.message));
            await page.goto('http://freegg-ui.invalid/', { waitUntil: 'domcontentloaded' });
            await page.locator('[data-tab-content="freegg"] h1').waitFor({ state: 'visible' });
            await page.waitForTimeout(2200);
            const panel = page.locator('[data-tab-content="freegg"]');
            await assert.doesNotReject(panel.getByText('gpt-6.1-sol', { exact: false }).first().waitFor());
            const rateToggle = panel.locator('#fg-rate-balance-toggle');
            await rateToggle.waitFor({ state: 'visible' });
            assert.equal(await rateToggle.getAttribute('role'), 'switch');
            assert.equal(await rateToggle.getAttribute('aria-label'), 'Распределять 429 между аккаунтами FreeGG');
            assert.equal(await rateToggle.getAttribute('aria-checked'), 'false');
            const hitBox = await rateToggle.boundingBox();
            assert.ok(hitBox && hitBox.height >= 44 && hitBox.width >= 44, 'rate-balance switch has a mobile-sized hit target');
            await rateToggle.click();
            await page.waitForFunction(() => document.querySelector('#fg-rate-balance-toggle')?.getAttribute('aria-checked') === 'true');
            assert.match(await panel.locator('#fg-rate-balance-state').innerText(), /включено.*account/);
            assert.ok(writes.includes('/__switch/api/fg/rate-policy'), 'rate-balance toggle persists through its API');
            const rateWrite = requests.find(row => row.path === '/__switch/api/fg/rate-policy' && row.method === 'POST');
            assert.equal(rateWrite && rateWrite.contentType, 'application/json', 'rate-balance write uses guarded JSON');
            assert.notEqual(rateWrite && rateWrite.secFetchSite, 'cross-site', 'rate-balance write is same-origin');
            const overflow = await page.evaluate(() => ({
                viewport: document.documentElement.clientWidth,
                body: document.body.scrollWidth,
                root: document.documentElement.scrollWidth,
            }));
            assert.ok(overflow.body <= overflow.viewport && overflow.root <= overflow.viewport,
                `FreeGG ${width}px has horizontal overflow: ${JSON.stringify(overflow)}`);
            await panel.locator('#fg-keepalive').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(out, `freegg-${width}-rate-toggle.png`) });
            await panel.locator('button').filter({ hasText: '➕ Добавить' }).click();
            await panel.locator('#fg-add-form').waitFor({ state: 'visible' });
            await panel.locator('#fg-add-email').fill('WormAlien');
            await page.screenshot({ path: path.join(out, `freegg-${width}-add.png`), fullPage: true });
            await panel.locator('button').filter({ hasText: 'Отмена' }).first().click();
            await page.evaluate(() => { state.github = [{ id: 'gh_ui', login: 'alice', nickname: 'alice', status: 'live', hasPassword: true, hasTotp: true }]; state.loaded.github = true; });
            await panel.locator('button').filter({ hasText: '➕ Добавить' }).click();
            await panel.locator('button[onclick*=newapiAddPickGithub]').click();
            await page.locator('#gh-bind-modal').waitFor({ state: 'visible' });
            await page.locator('[onclick*=newapiAddTakeGh]').filter({ hasText: 'alice' }).click();
            await page.waitForFunction(() => state.freegg.some(row => row.id === 'fg_added' && row.api_key.startsWith('sk-')));
            assert.ok(writes.includes('/__switch/api/fg/add-github'), 'manager creates one FreeGG row');
            assert.ok(writes.includes('/__switch/api/fg/session/open'), 'manager starts automatic provision');
            assert.equal(await page.locator('#gh-cred-pop').isVisible().catch(() => false), false, 'automatic onboarding does not open the credentials popup');
            await panel.locator('button[onclick*=fgOpenLk]').first().click();
            assert.ok(writes.includes('/__switch/api/fg/session/open'), 'account browser action is wired');
            await page.screenshot({ path: path.join(out, `freegg-${width}-tab.png`), fullPage: true });
            assert.deepEqual(errors, [], 'dashboard JS errors');
            console.log(`UI ${width}px: full tab, add/cancel, selected account open PASS`);
            await context.close();
        }
        console.log('SCREENSHOTS ' + out);
    } finally { await browser.close(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
