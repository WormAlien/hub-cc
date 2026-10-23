#!/usr/bin/env node
'use strict';
// Isolated actual tab markup/theme/assets. Every browser request is fulfilled here or blocked.
// This never opens the running dashboard or reads credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const routing = path.join(root, 'routing');
const html = fs.readFileSync(path.join(routing, 'proxy-dashboard.html'), 'utf8');
const origin = 'http://a6api-fixture.invalid';
const model = 'deepseek-v4.1-flash-1017';
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'a6api-ui-'));
const theme = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].find(m => m[1].includes('const THEMES ='))?.[0];
const tabMarkup = html.match(/<div data-tab-content="a6api"[^>]*><div id="a6api-root"><\/div><\/div>/)?.[0];
const baseStyles = html.match(/<style type="text\/tailwindcss">[\s\S]*?<\/style>/)?.[0];
const uiScript = html.match(/<script src="[^\"]*\/a6api-tab\.js"><\/script>/)?.[0];
const uiStyle = html.match(/<link rel="stylesheet" href="[^\"]*\/a6api-tab\.css">/)?.[0];
assert.ok(theme && tabMarkup && baseStyles && uiScript && uiStyle, 'actual dashboard tab registration missing');
const fixture = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script src="/vendor/tailwindcss-browser-4.js"></script><link rel="stylesheet" href="/vendor/fonts.css">${uiStyle}${baseStyles}${theme}
<style>body{margin:0;background:var(--color-bg);font-family:var(--font-sans)} [data-tab-content]{display:block}</style>
</head><body>${tabMarkup}${uiScript}</body></html>`;
const prices = (input, output) => ({ input_price_micros: input, output_price_micros: output, cache_read_price_micros: 20, cache_write_price_micros: 30, per_request_price_micros: 1 });
const state = { ok: true, canWrite: true, models: [model, 'another'], account: { balanceUsd: 5.58 }, tokens: [
    { id: 9, name: 'deepseek', mask: 'hidden', status: 1, unlimited: true, spentUsd: .000012, expires: -1, restricted: true, models: [model] },
] };
const seller = (channelId, supplier, input, output) => ({ channelId, listingId: channelId * 10, supplierId: channelId, supplier,
    channel: 'Fixture channel ' + channelId, model, inputUsd: input / 1e6, outputUsd: output / 1e6, cacheUsd: .00002,
    prices: prices(input, output), success24h: 99.7, recentSuccess: 100, samples: 100, rating: 5, reviews: 2, ttftMs: 2400, available: true });
const data = { ok: true, canWrite: true, catalog: { items: [seller(7, 'First seller', 1176, 4704), seller(8, 'Reserve', 14000, 56000),
    { ...seller(11, '<img src=x onerror=alert(1)>', 20000, 80000), success24h: null, recentSuccess: null, samples: null, rating: null, reviews: 0, available: false }], total: 3, stale: true, snapshot: 1792731600 },
    route: { id: 1, version: 2, strategy: 'price_asc', channels: [{ channelId: 7 }], caps: prices(1176, 4704) }, probes: { 7: { tools: true, vision: true, combined: false, at: 1792731600 } } };
const log = { ok: true, total: 85, items: [{ channelId: 7, at: 1792731600, input: 230, output: 32, usd: .000003, duration: 2.3 }] };
const requests = [], unexpected = [], browserErrors = [];
let releaseRoute, routeStarted, accept = false;
(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1365, height: 980 }, serviceWorkers: 'block' });
        await context.route('**/*', async route => {
            const request = route.request(), u = new URL(request.url());
            if (u.origin !== origin) { unexpected.push(u.origin); return route.abort('blockedbyclient'); }
            if (u.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
            if (u.pathname.startsWith('/vendor/')) {
                const name = path.basename(u.pathname);
                const allowed = ['tailwindcss-browser-4.js', 'a6api-tab.js', 'a6api-tab.css', 'fonts.css'].includes(name) || /^[\w.-]+\.woff2?$/.test(name);
                const p = path.join(routing, 'vendor', u.pathname.slice('/vendor/'.length));
                if (allowed && p.startsWith(path.join(routing, 'vendor') + path.sep) && fs.existsSync(p)) {
                    const contentType = name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'font/woff2';
                    return route.fulfill({ contentType, body: fs.readFileSync(p) });
                }
            }
            if (u.pathname.startsWith('/__switch/api/a6api/')) {
                const name = u.pathname.split('/').pop();
                const call = { name, method: request.method(), body: request.postDataJSON(), model: u.searchParams.get('model') };
                requests.push(call);
                let result;
                if (name === 'state') result = state;
                else if (name === 'model') result = data;
                else if (name === 'logs') result = log;
                else if (name === 'reviews') result = { ok: true, items: [{ rating: 5, user: 'anon', text: '<script>not executable</script>', at: 1792731600 }] };
                else if (name === 'route' && call.method === 'POST') {
                    if (routeStarted) routeStarted();
                    await new Promise(resolve => { releaseRoute = resolve; });
                    result = { ok: true, route: { ...data.route, strategy: call.body.strategy, version: 3, channels: call.body.channels.map(channelId => ({ channelId })), caps: call.body.caps } };
                } else if (name === 'enable-model' && call.method === 'POST') result = { ok: false, error: 'fixture-enable-denied' };
                else { unexpected.push(name); return route.abort('blockedbyclient'); }
                return route.fulfill({ status: result.ok === false ? 409 : 200, contentType: 'application/json', body: JSON.stringify(result) });
            }
            unexpected.push(u.pathname); return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        page.on('pageerror', e => browserErrors.push(e.message));
        page.on('dialog', d => accept ? d.accept() : d.dismiss());
        await page.goto(origin + '/', { waitUntil: 'load' });
        await page.evaluate(() => window.A6API.load());
        assert.equal(await page.locator('#a6api-root img').count(), 0, 'seller HTML was interpreted');
        assert.ok(requests.every(r => r.method === 'GET'), 'initial reads wrote state');
        assert.match(await page.locator('#a6-key-info').innerText(), /\$5\.58/);
        assert.match(await page.locator('#a6-log-rows').innerText(), /230 \/ 32/);
        await page.locator('input[data-channel="8"]').check();
        await page.locator('#a6-strategy').selectOption('user_priority_desc');
        assert.equal(await page.locator('#a6-pool [data-a6="up"]').count(), 2);
        await page.locator('#a6-pool [data-a6="up"][data-id="8"]').click();
        assert.match(await page.locator('#a6-pool .a6-chip').first().innerText(), /Reserve/);
        await page.locator('#a6-input-cap').fill('0.02');
        await page.evaluate(() => window.A6API.load());
        assert.equal(await page.locator('#a6-input-cap').inputValue(), '0.02');
        assert.match(await page.locator('#a6-pool .a6-chip').first().innerText(), /Reserve/);
        await page.locator('#a6-save').click();
        assert.ok(requests.every(r => r.method === 'GET'), 'cancelled save wrote state');
        for (const themeId of ['zen', 'daylight']) {
            await page.evaluate(id => applyTheme(id, false), themeId);
            for (const width of [1365, 1024, 768, 390, 320]) {
                await page.setViewportSize({ width, height: 980 });
                const layout = await page.evaluate(() => ({
                    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
                    panels: [...document.querySelectorAll('.a6-panel')].map(x => {
                        const r = x.getBoundingClientRect();
                        return { right: r.right, left: r.left, overflow: x.scrollWidth - x.clientWidth };
                    }),
                    scheme: document.documentElement.style.colorScheme,
                    panelBg: getComputedStyle(document.querySelector('.a6-panel')).backgroundColor,
                    surface: getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim(),
                }));
                assert.ok(layout.pageOverflow <= 1, `${themeId}/${width}: page horizontal overflow ${layout.pageOverflow}`);
                assert.ok(layout.panels.every(p => p.right <= width + 1 && p.left >= -1), `${themeId}/${width}: panel outside viewport`);
                assert.ok(layout.panels.slice(0, 2).every(p => p.overflow <= 1), `${themeId}/${width}: summary panel overflow`);
                assert.equal(layout.scheme, themeId === 'daylight' ? 'light' : 'dark');
                assert.notEqual(layout.panelBg, 'rgba(0, 0, 0, 0)'); assert.ok(layout.surface);
                if (width === 1365 || width === 390) await page.screenshot({ path: path.join(out, `${themeId}-${width}.png`), fullPage: true });
            }
        }
        await page.setViewportSize({ width: 1365, height: 980 });
        accept = true;
        const started = new Promise(resolve => { routeStarted = resolve; });
        await page.locator('#a6-save').click(); await started;
        try {
            for (const selector of ['#a6-token', '#a6-model', '#a6-strategy', '#a6-input-cap', '#a6-output-cap', '[data-a6="reset"]', '[data-a6="refresh"]']) {
                assert.equal(await page.locator(selector).isDisabled(), true, selector);
            }
            assert.equal(await page.locator('#a6-pool button:enabled, #a6-sellers input:enabled').count(), 0, 'route edit remains enabled while saving');
        } finally { releaseRoute(); }
        await page.waitForFunction(() => !document.getElementById('a6-model').disabled);
        await page.locator('#a6-model').fill('another'); await page.locator('#a6-model').press('Tab');
        await page.waitForFunction(() => !document.getElementById('a6-enable').disabled);
        await page.locator('#a6-enable').click();
        await page.waitForFunction(() => document.getElementById('a6-error').textContent.includes('fixture-enable-denied'));
        assert.equal(await page.locator('#a6-error').isVisible(), true);
        assert.equal(requests.filter(r => r.name === 'enable-model').length, 1);
        assert.equal(requests.filter(r => r.name === 'route').length, 1);
        assert.deepEqual(unexpected, [], 'unexpected requests were blocked'); assert.deepEqual(browserErrors, []);
        console.log('check-a6api-ui-browser: PASS (actual HTML registration/theme/assets, 10 responsive/theme layouts, real DOM interactions)');
        console.log('All API requests intercepted. No live dashboard, credentials or paid model calls.');
        console.log('Screenshots: ' + out);
        await context.close();
    } finally { await browser.close(); }
})().catch(e => { console.error(e.stack); console.error('Screenshots: ' + out); process.exitCode = 1; });
