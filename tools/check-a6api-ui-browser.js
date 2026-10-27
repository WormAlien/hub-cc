#!/usr/bin/env node
'use strict';
// Actual tab registration, theme and local assets. Every request is fulfilled here or blocked.
// The live dashboard, provider, secrets and converter are never contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..'), routing = path.join(root, 'routing');
const html = fs.readFileSync(path.join(routing, 'proxy-dashboard.html'), 'utf8');
const origin = 'http://a6api-fixture.invalid';
const model = 'deepseek-v4.1-flash-1017', alternate = 'deepseek-v4-pro', other = 'fixture-permitted-secondary-model';
const slots = ['default', 'opus', 'sonnet', 'haiku'];
const mapOf = value => Object.fromEntries(slots.map(slot => [slot, value]));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'a6api-cc-ui-'));
const theme = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].find(m => m[1].includes('const THEMES ='))?.[0];
const tabMarkup = html.match(/<div data-tab-content="a6api"[^>]*><div id="a6api-root"><\/div><\/div>/)?.[0];
const baseStyles = html.match(/<style type="text\/tailwindcss">[\s\S]*?<\/style>/)?.[0];
const uiScript = html.match(/<script src="[^\"]*\/a6api-tab\.js"><\/script>/)?.[0];
const uiStyle = html.match(/<link rel="stylesheet" href="[^\"]*\/a6api-tab\.css">/)?.[0];
assert.ok(theme && tabMarkup && baseStyles && uiScript && uiStyle, 'actual dashboard tab registration missing');
const fixture = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script src="/vendor/tailwindcss-browser-4.js"></script><link rel="stylesheet" href="/vendor/fonts.css">${uiStyle}${baseStyles}${theme}
<style>body{margin:0;background:var(--color-bg);font-family:var(--font-sans)} [data-tab-content]{display:block}</style>
</head><body>${tabMarkup}<div id="routes-box" hidden></div>${uiScript}</body></html>`;
const token = { id: 9, name: 'Основной', mask: 'hidden-9', status: 1, unlimited: true, spentUsd: .000012, expires: -1, restricted: true, models: [model, alternate] };
const state = { ok: true, canWrite: true, account: { balanceUsd: 5.58, spentUsd: .42 }, tokens: [token,
    { ...token, id: 10, name: 'Дополнительный <img src=x>', mask: 'hidden-10', models: [other], unlimited: false, remainingUsd: 1 }],
    selectedTokenId: 9, models: [model, alternate], modelMap: { ...mapOf(model), gpt: 'server-owned' },
    routesMap: { ...mapOf(model), default: 'independent-routes-default', gpt: 'server-owned' }, prepared: true, active: false };
const catalogs = new Map([[9, [model, alternate]], [10, [other]]]);
const requests = [], unexpected = [], browserErrors = [];
let accept = false, releaseWrite, writeStarted, blockSave = false, failSave = false, failModels = false;
let scenarios = 0, layouts = 0;
(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block' });
        await context.route('**/*', async route => {
            const request = route.request(), u = new URL(request.url());
            if (u.origin !== origin) { unexpected.push(u.origin); return route.abort('blockedbyclient'); }
            if (u.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
            if (u.pathname.startsWith('/vendor/')) {
                const name = path.basename(u.pathname), p = path.join(routing, 'vendor', u.pathname.slice('/vendor/'.length));
                const allowed = ['tailwindcss-browser-4.js', 'a6api-tab.js', 'a6api-tab.css', 'fonts.css'].includes(name) || /^[\w.-]+\.woff2?$/.test(name);
                if (allowed && p.startsWith(path.join(routing, 'vendor') + path.sep) && fs.existsSync(p)) return route.fulfill({
                    contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'font/woff2', body: fs.readFileSync(p) });
            }
            if (u.pathname.startsWith('/__switch/api/a6api/')) {
                const name = u.pathname.split('/').pop();
                const call = { name, method: request.method(), body: request.postDataJSON(), tokenId: Number(u.searchParams.get('tokenId')) };
                requests.push(call);
                let result;
                if (name === 'state' && call.method === 'GET') result = state;
                else if (name === 'models' && call.method === 'GET') result = failModels ? { ok: false, error: 'fixture-models-failed' } : { ok: true, tokenId: call.tokenId, models: catalogs.get(call.tokenId) || [] };
                else if (name === 'key' && call.method === 'POST') {
                    state.selectedTokenId = call.body.tokenId; state.prepared = true; state.models = catalogs.get(call.body.tokenId) || [];
                    result = { ok: true, selectedTokenId: state.selectedTokenId };
                } else if (name === 'modelmap' && call.method === 'POST') {
                    if (blockSave) {
                        await new Promise(resolve => { releaseWrite = resolve; writeStarted(); });
                        blockSave = false;
                    }
                    if (failSave) result = { ok: false, error: 'fixture-save-failed' };
                    else {
                        state.modelMap = { ...state.modelMap, ...call.body.modelMap };
                        for (const slot of ['opus', 'sonnet', 'haiku']) state.routesMap[slot] = call.body.modelMap[slot];
                        result = { ok: true, modelMap: state.modelMap, routesMap: state.routesMap };
                    }
                } else if (name === 'activate' && call.method === 'POST') { state.active = true; result = { ok: true, active: true }; }
                else { unexpected.push(name + ':' + call.method); return route.abort('blockedbyclient'); }
                return route.fulfill({ status: result.ok === false ? 409 : 200, contentType: 'application/json', body: JSON.stringify(result) });
            }
            unexpected.push(u.pathname); return route.abort('blockedbyclient');
        });
        const page = await context.newPage(); page.setDefaultTimeout(6000);
        page.on('pageerror', e => browserErrors.push(e.message)); page.on('dialog', d => accept ? d.accept() : d.dismiss());
        await page.goto(origin + '/', { waitUntil: 'load' });
        await page.evaluate(() => {
            window.fixtureCopied = [];
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.fixtureCopied.push(text) } });
            window.fixtureTabs = [];
            window.showTab = name => {
                window.fixtureTabs.push(name);
                const generation = window.fixtureTabs.length;
                const box = document.getElementById('routes-box'); box.hidden = false;
                setTimeout(() => { box.innerHTML = '<div id="routes-row-a6api">a6api route fixture ' + generation + '</div>'; }, 25);
            };
        });
        await page.evaluate(() => window.A6API.load());
        assert.ok(requests.every(r => r.method === 'GET')); assert.deepEqual(unexpected, []);
        assert.equal(await page.locator('#a6api-root table, #a6-sellers, #a6-pool, #a6-reviews').count(), 0);
        assert.equal(await page.locator('#a6api-root img').count(), 0);
        assert.equal(await page.locator('#a6-balance').innerText(), '$5.58');
        assert.equal(await page.locator('#a6-account-spent').innerText(), '$0.42');
        assert.match(await page.locator('#a6-key-info').innerText(), /\$0\.000012/);
        assert.equal(await page.locator('#a6-model-default').inputValue(), model);
        scenarios++;
        await page.locator('#a6-model-default').selectOption(alternate);
        await page.locator('#a6-model-haiku').selectOption(alternate);
        await page.locator('#a6-refresh').click();
        await page.waitForFunction(() => !document.getElementById('a6-refresh').disabled);
        assert.equal(await page.locator('#a6-model-default').inputValue(), alternate);
        assert.equal(await page.locator('#a6-model-haiku').inputValue(), alternate);
        assert.match(await page.locator('#a6-draft-status').innerText(), /Не сохранено/);
        assert.ok(requests.every(r => r.method === 'GET')); scenarios++;
        for (const themeId of ['zen', 'daylight']) {
            await page.evaluate(id => applyTheme(id, false), themeId);
            for (const width of [1365, 1024, 768, 390, 320]) {
                await page.setViewportSize({ width, height: 900 });
                const layout = await page.evaluate(() => {
                    const main = document.getElementById('a6-model-default'), tier = document.getElementById('a6-model-opus');
                    return { overflow: document.documentElement.scrollWidth - innerWidth,
                        panels: [...document.querySelectorAll('.a6-panel')].map(x => ({ right: x.getBoundingClientRect().right, left: x.getBoundingClientRect().left, overflow: x.scrollWidth - x.clientWidth })),
                        mainHeight: main.getBoundingClientRect().height, tierHeight: tier.getBoundingClientRect().height,
                        mainFont: parseFloat(getComputedStyle(main).fontSize), tierFont: parseFloat(getComputedStyle(tier).fontSize),
                        mainBottom: main.getBoundingClientRect().bottom, tiersTop: document.querySelector('.a6-subagents').getBoundingClientRect().top,
                        scheme: document.documentElement.style.colorScheme,
                        panelBg: getComputedStyle(document.querySelector('.a6-panel')).backgroundColor,
                        totalHeight: document.getElementById('a6api-root').getBoundingClientRect().height };
                });
                assert.ok(layout.overflow <= 1, `${themeId}/${width}: page overflow ${layout.overflow}`);
                assert.ok(layout.panels.every(p => p.left >= -1 && p.right <= width + 1 && p.overflow <= 1), `${themeId}/${width}: panel overflow`);
                assert.ok(layout.mainHeight > layout.tierHeight && layout.mainFont > layout.tierFont, `${themeId}/${width}: main-window hierarchy missing`);
                assert.ok(layout.mainBottom < layout.tiersTop, `${themeId}/${width}: subagents must be below main window`);
                assert.equal(layout.scheme, themeId === 'daylight' ? 'light' : 'dark'); assert.notEqual(layout.panelBg, 'rgba(0, 0, 0, 0)');
                if (width === 1365) assert.ok(layout.totalHeight < 850, 'desktop control surface is not compact');
                if (width === 1365 || width === 390) await page.screenshot({ path: path.join(out, `${themeId}-${width}.png`), fullPage: true });
                layouts++;
            }
        }
        await page.setViewportSize({ width: 1365, height: 900 });
        await page.locator('#a6-token').selectOption('10');
        await page.waitForFunction(() => !document.getElementById('a6-model-default').disabled);
        assert.equal(state.selectedTokenId, 9); assert.ok(requests.every(r => r.method === 'GET'));
        assert.deepEqual(await page.locator('#a6-model-default option:not([disabled])').evaluateAll(nodes => nodes.map(n => n.value).filter(Boolean)), [other]);
        for (const slot of slots) await page.locator('#a6-model-' + slot).selectOption(other);
        assert.equal(await page.locator('#a6-save').isDisabled(), true); assert.equal(await page.locator('#a6-activate').isDisabled(), true);
        scenarios++;
        await page.locator('#a6-use-key').click();
        assert.equal(requests.filter(r => r.name === 'key').length, 0, 'cancelled key replacement wrote selection');
        accept = true; await page.locator('#a6-use-key').click(); accept = false;
        await page.waitForFunction(() => !document.getElementById('a6-token').disabled);
        assert.equal(state.selectedTokenId, 10); assert.equal(state.active, false);
        assert.deepEqual(requests.filter(r => r.method === 'POST').map(r => r.name), ['key']);
        assert.equal(await page.locator('#a6-model-default').inputValue(), other); scenarios++;
        failSave = true; await page.locator('#a6-save').click();
        await page.waitForFunction(() => document.getElementById('a6-error').textContent.includes('fixture-save-failed'));
        assert.equal(await page.locator('#a6-error').isVisible(), true); assert.equal(await page.locator('#a6-model-default').inputValue(), other);
        assert.match(await page.locator('#a6-draft-status').innerText(), /Не сохранено/); scenarios++;
        failSave = false; blockSave = true; const saving = new Promise(resolve => { writeStarted = resolve; });
        await page.locator('#a6-save').click(); await saving;
        try {
            for (const id of ['a6-token', ...slots.map(s => 'a6-model-' + s), 'a6-use-key', 'a6-save', 'a6-activate', 'a6-refresh']) assert.equal(await page.locator('#' + id).isDisabled(), true, id);
        } finally { releaseWrite(); }
        await page.waitForFunction(() => !document.getElementById('a6-token').disabled);
        const saved = requests.filter(r => r.name === 'modelmap').at(-1).body;
        assert.deepEqual(saved, { tokenId: 10, modelMap: mapOf(other) });
        assert.equal(state.modelMap.gpt, 'server-owned'); assert.equal(state.routesMap.default, 'independent-routes-default'); scenarios++;
        await page.locator('#a6-activate').click();
        assert.equal(requests.filter(r => r.name === 'activate').length, 0);
        accept = true; await page.locator('#a6-activate').click();
        await page.waitForFunction(() => document.getElementById('a6-connection').textContent.includes('Активен'));
        assert.equal(requests.filter(r => r.name === 'activate').length, 1); scenarios++;
        await page.locator('[data-a6="copy-command"]').click();
        assert.deepEqual(await page.evaluate(() => window.fixtureCopied), ['/model a6api[1m]']); scenarios++;
        await page.locator('[data-a6="routes"]').click();
        await page.waitForFunction(() => document.getElementById('routes-row-a6api')?.classList.contains('a6-route-focus'));
        assert.deepEqual(await page.evaluate(() => window.fixtureTabs), ['routes']); scenarios++;
        await page.locator('[data-a6="routes"]').click();
        await page.waitForFunction(() => document.getElementById('routes-row-a6api')?.textContent.endsWith('2'));
        assert.equal(await page.locator('#routes-row-a6api').evaluate(row => row.classList.contains('a6-route-focus')), true, 'Routes rerender lost provider highlight');
        scenarios++;
        failModels = true; await page.locator('#a6-token').selectOption('9');
        await page.waitForFunction(() => document.getElementById('a6-error').textContent.includes('fixture-models-failed'));
        assert.equal(await page.locator('#a6-model-default').isDisabled(), true);
        assert.equal(await page.locator('#a6-model-default').inputValue(), alternate);
        failModels = false; await page.evaluate(() => window.A6API.load());
        assert.equal(await page.locator('#a6-model-default').inputValue(), alternate); scenarios++;
        state.canWrite = false; const writesBefore = requests.filter(r => r.method === 'POST').length;
        await page.evaluate(() => window.A6API.load());
        for (const id of ['a6-use-key', 'a6-save', 'a6-activate', ...slots.map(s => 'a6-model-' + s)]) assert.equal(await page.locator('#' + id).isDisabled(), true, id);
        assert.equal(await page.locator('#a6-local').isVisible(), true);
        assert.equal(requests.filter(r => r.method === 'POST').length, writesBefore); scenarios++;
        assert.deepEqual(unexpected, [], 'unexpected requests were blocked'); assert.deepEqual(browserErrors, []);
        console.log(`check-a6api-ui-browser: PASS (${scenarios} real-DOM scenarios, ${layouts} responsive/theme layouts)`);
        console.log('All endpoint responses intercepted; zero live dashboard/provider calls.');
        console.log('Screenshots: ' + out);
        await context.close();
    } finally { await browser.close(); }
})().catch(e => { console.error(e.stack); console.error('Screenshots: ' + out); process.exitCode = 1; });
