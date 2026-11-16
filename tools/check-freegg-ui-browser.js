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
            const errors = [], writes = [];
            const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
            await context.addInitScript(() => { localStorage.setItem('opencode_active_tab', 'freegg'); });
            await context.route('**/*', async route => {
                const req = route.request(), url = new URL(req.url());
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
                if (url.pathname.includes('/fg/')) {
                    if (req.method() === 'POST') writes.push(url.pathname);
                    if (url.pathname.endsWith('/sessions')) result = { sessions, activeModel: 'gpt-6.1-sol', modelMap: map };
                    else if (url.pathname.endsWith('/models')) result = { ok: true, data: [{ id: 'gpt-6.1-sol' }], models: [{ id: 'gpt-6.1-sol' }] };
                    else if (url.pathname.endsWith('/modelmap')) result = { ok: true, modelMap: map };
                    else if (url.pathname.includes('/keepalive/state')) result = { ok: true, up: true, config: { hedgeMs: 0, maxHedges: 0, maxAttempts: 1 }, stats: {} };
                    else if (url.pathname.endsWith('/session/open')) result = { ok: true, label: 'acct_fg_ui', pid: 1, mode: 'register' };
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
            await panel.locator('button').filter({ hasText: '➕ Добавить' }).click();
            await panel.locator('#fg-add-form').waitFor({ state: 'visible' });
            await panel.locator('#fg-add-email').fill('WormAlien');
            await page.screenshot({ path: path.join(out, `freegg-${width}-add.png`), fullPage: true });
            await panel.locator('button').filter({ hasText: 'Отмена' }).first().click();
            await panel.locator('button[onclick*=fgOpenLk]').click();
            assert.ok(writes.includes('/__switch/api/fg/session/open'), 'account browser action is wired');
            await page.screenshot({ path: path.join(out, `freegg-${width}-tab.png`), fullPage: true });
            assert.deepEqual(errors, [], 'dashboard JS errors');
            console.log(`UI ${width}px: full tab, add/cancel, selected account open PASS`);
            await context.close();
        }
        console.log('SCREENSHOTS ' + out);
    } finally { await browser.close(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
