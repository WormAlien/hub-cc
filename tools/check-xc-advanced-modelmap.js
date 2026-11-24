#!/usr/bin/env node
'use strict';

// Focused acceptance against the current dashboard source. No live hub,
// provider, settings, keys or model-map files are read or written.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ROUTING = path.join(ROOT, 'routing');
const SOURCE = path.join(ROUTING, 'proxy-dashboard.html');
const DASHBOARD = fs.readFileSync(SOURCE, 'utf8');
const SCRATCH = process.env.HERMES_TEST_SCRATCH || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch')
    : path.join(os.homedir(), '.cache/hermes/scratch'));
fs.mkdirSync(SCRATCH, { recursive: true });
const EVIDENCE = fs.mkdtempSync(path.join(SCRATCH, 'xc-advanced-modelmap-'));
const STAGE = process.env.XC_ADVANCED_STAGE || 'all';
const tests = [], results = [], observations = [];
let browser;
const test = (stage, name, run) => tests.push({ stage, name, run });

async function markupPage() {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort('blockedbyclient'));
    const page = await context.newPage();
    // Remove executable scripts, not markup. Structural assertions below use
    // the actual dashboard HTML rather than an invented copy of the card.
    await page.setContent(DASHBOARD.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''), { waitUntil: 'domcontentloaded' });
    return { context, page };
}

test('markup', 'Xingchi compatibility is a closed details after the original model catalog', async () => {
    const { context, page } = await markupPage();
    try {
        const state = await page.evaluate(() => {
            const card = document.getElementById('xc-modelmap');
            const models = document.getElementById('xc-models');
            return {
                tag: card?.tagName, open: card?.hasAttribute('open'),
                summary: card?.querySelector(':scope > summary')?.textContent.trim(),
                afterModels: !!(models?.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
                container: card?.closest('[data-tab-content]')?.dataset.tabContent,
                preserved: ['xc-modelmap', 'xc-modelmap-sel', 'xc-models', 'xc-models-list'].map(id => document.querySelectorAll('#' + id).length),
                refresh: card?.querySelector('button[onclick="loadXcModels(false)"]')?.getAttribute('onclick'),
                obsoleteDescription: /opus-only|ставить сюда sonnet\/gpt\s+нельзя/i.test(card?.textContent || ''),
            };
        });
        assert.equal(state.tag, 'DETAILS', 'advanced compatibility must use native details, not an always-visible div');
        assert.equal(state.open, false, 'closed by default without a persisted open attribute');
        assert.equal(state.summary, 'Дополнительно - маппинг тиров');
        assert.equal(state.afterModels, true, 'ordinary model catalog precedes advanced compatibility');
        assert.equal(state.container, 'xingchi');
        assert.deepEqual(state.preserved, [1, 1, 1, 1]);
        assert.equal(state.refresh, 'loadXcModels(false)');
        assert.equal(state.obsoleteDescription, false);
        observations.push({ name: 'markup', state });
    } finally { await context.close(); }
});

async function fixture(width = 1440) {
    const origin = 'http://127.0.0.1:45379';
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const record = { width, requests: [], errors: [], blocked: [], screenshots: [] };
    observations.push(record);
    const sessions = [{ id: 'isolated-xc-account', email: 'fixture@example.test',
        api_key: 'isolated-xc-key-not-a-secret', active: true, status: 'live',
        balance: 42, granted: 100, balanceSource: 'self' }];
    let catalog = [{ id: 'claude-opus-5' }, { id: 'gpt-6-astra' }, { id: 'vendor/nested/model' }];
    let modelMap = { opus: 'vendor/saved/opus-outside-catalog', sonnet: 'claude-opus-5', haiku: '' };
    let active = 'claude-opus-5';
    let saveStatus = 200, saveReply = null, saveGate = null, releaseSave = null, saveBodyOk = false;
    const cfg = { hedgeMs: 20000, maxHedges: 0, maxAttempts: 3, preCommitMs: 10000 };
    await context.addInitScript(() => {
        if (!localStorage.getItem('opencode_active_tab')) localStorage.setItem('opencode_active_tab', 'claude');
        window.__copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: async text => window.__copied.push(text) } });
    });
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== origin) { record.blocked.push(url.origin); return route.abort('blockedbyclient'); }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: DASHBOARD });
        if (url.pathname.startsWith('/vendor/')) {
            const file = path.resolve(ROUTING, 'vendor', url.pathname.slice('/vendor/'.length));
            if (file.startsWith(path.resolve(ROUTING, 'vendor') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                const ext = path.extname(file);
                return route.fulfill({ contentType: ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'font/woff2', body: fs.readFileSync(file) });
            }
        }
        const input = req.method() === 'POST' ? req.postDataJSON() : undefined;
        record.requests.push({ method: req.method(), path: url.pathname, query: url.search, body: input });
        let body = { ok: false, error: 'isolated fixture only' }, status = 404;
        if (url.pathname === '/__switch/api/status') { status = 200; body = { current: 'xingchi',
            backends: { xingchi: { label: 'Xingchi', base_url: origin } }, oauth: {} }; }
        else if (url.pathname === '/__switch/api/xc/sessions') { status = 200; body = { ok: true, sessions }; }
        else if (url.pathname === '/__switch/api/xc/models') { status = 200; body = { ok: true, models: catalog }; }
        else if (url.pathname === '/__switch/api/xc/active-model') { status = 200; body = { ok: true, model: active }; }
        else if (url.pathname === '/__switch/api/xc/set-model') { active = input.model; status = 200; body = { ok: true, model: active }; }
        else if (url.pathname === '/__switch/api/xc/modelmap') {
            if (input) {
                if (saveGate) await saveGate;
                status = saveStatus;
                if (status >= 400) body = { ok: saveBodyOk, error: 'isolated save failure', modelMap: saveReply || input };
                else { modelMap = saveReply || input; body = { ok: true, modelMap }; }
            } else { status = 200; body = { ok: true, modelMap }; }
        } else if (url.pathname === '/__switch/api/xc/model-tests') { status = 200; body = { ok: true, results: {} }; }
        else if (url.pathname.endsWith('/keepalive/state')) { status = 200; body = { ok: true, port: 45380, cfg, defaults: cfg, stats: {}, latency: {} }; }
        else if (url.pathname.endsWith('/keepalive/latency')) { status = 200; body = { ok: true, points: [],
            window_sec: Number(url.searchParams.get('window') || 86400), now: Date.now(), total_all: 0, proxy_state: 'up', source: 'proxy' }; }
        else if (url.pathname === '/__switch/api/ar/sessions') { status = 200; body = { ok: true, sessions: [] }; }
        else if (url.pathname === '/__switch/api/api-gateway') { status = 200; body = { ok: true, canWrite: true, providers: ['xingchi'],
            manifest: { version: 1, revision: 1, enabled: true }, models: [], candidatesLoaded: false,
            public: { anthropicBaseUrl: origin, openaiBaseUrl: origin + '/openai/v1' } }; }
        else if (url.pathname === '/__switch/api/gemini/list') { status = 200; body = { ok: true, accounts: [], server: { up: true }, tiers: [] }; }
        else if (url.pathname === '/__switch/api/gemini/modelmap') { status = 200; body = { ok: true, modelMap: {}, activeModel: null }; }
        return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => record.errors.push(error.message));
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.locator('.nav-btn[data-tab="xingchi"]').click();
    await page.waitForFunction(() => document.getElementById('xc-models-list')?.textContent.includes('gpt-6-astra') &&
        document.getElementById('xc-mm-opus')?.value === 'vendor/saved/opus-outside-catalog');
    return { context, page, record, catalog: () => catalog,
        setCatalog(value) { catalog = value; }, modelMap: () => modelMap, setModelMap(value) { modelMap = value; }, active: () => active,
        setSaveStatus(value) { saveStatus = value; }, setSaveReply(value) { saveReply = value; },
        setSaveBodyOk(value) { saveBodyOk = value; },
        holdSave() { saveGate = new Promise(resolve => { releaseSave = resolve; }); },
        releaseSave() { releaseSave?.(); saveGate = null; } };
}

test('draft', 'catalog render preserves a changed tier even when its exact target disappears', async () => {
    const f = await fixture();
    try {
        const detail = f.page.locator('#xc-modelmap');
        assert.equal(await detail.evaluate(node => node.open), false);
        await detail.locator('summary').click();
        await f.page.locator('#xc-mm-sonnet').selectOption('gpt-6-astra');
        const next = f.catalog().filter(model => model.id !== 'gpt-6-astra');
        f.setCatalog(next);
        await f.page.evaluate(models => renderXcModels(models), next);
        assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), 'gpt-6-astra',
            'a normal model catalog render must not replace an unsaved selection with the saved map');
        assert.equal(await f.page.locator('#xc-mm-sonnet option[value="gpt-6-astra"]').count(), 1,
            'keep an option for the dirty target even outside the latest catalog');
        assert.equal(await detail.evaluate(node => node.open), true);
        assert.deepEqual(f.modelMap(), { opus: 'vendor/saved/opus-outside-catalog', sonnet: 'claude-opus-5', haiku: '' });
        assert.equal(f.record.requests.filter(row => row.method === 'POST').length, 0,
            'opening or rendering compatibility cannot write or select a model');
        assert.deepEqual(f.record.errors, []);
    } finally { await f.context.close(); }
});

test('save', 'successful explicit save commits the sent draft so subsequent saved-map refresh can reconcile it', async () => {
    const f = await fixture();
    try {
        await f.page.locator('#xc-modelmap summary').click();
        await f.page.locator('#xc-mm-sonnet').selectOption('gpt-6-astra');
        await f.page.locator('#xc-modelmap button[onclick="xcSaveModelMap()"] ').click();
        await f.page.waitForFunction(() => document.getElementById('toasts')?.textContent.includes('маппинг сохранён'));
        const posts = f.record.requests.filter(row => row.method === 'POST');
        assert.deepEqual(posts.map(row => ({ path: row.path, body: row.body })), [{
            path: '/__switch/api/xc/modelmap', body: { opus: 'vendor/saved/opus-outside-catalog', sonnet: 'gpt-6-astra', haiku: '' },
        }], 'preserve the existing exact tier payload and endpoint; saving compatibility does not set a main model');
        assert.equal(f.active(), 'claude-opus-5');
        const latest = { ...f.modelMap(), sonnet: 'vendor/latest/saved-sonnet' };
        f.setModelMap(latest);
        await f.page.evaluate(() => loadXcModelMap());
        assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), latest.sonnet,
            'a committed draft is no longer dirty and follows the next saved modelMap');
        assert.equal(await f.page.locator('#xc-modelmap').evaluate(node => node.open), true);
        assert.deepEqual(f.record.errors, []);
    } finally { await f.context.close(); }
});

test('save-inflight', 'save readback reconciles untouched refreshed fields while retaining a newer local edit', async () => {
    const f = await fixture();
    try {
        await f.page.locator('#xc-modelmap summary').click();
        await f.page.locator('#xc-mm-sonnet').selectOption('gpt-6-astra');
        f.holdSave();
        const sent = { opus: 'vendor/saved/opus-outside-catalog', sonnet: 'gpt-6-astra', haiku: '' };
        f.setSaveReply({ ...sent, sonnet: 'vendor/server/accepted-sonnet' });
        await f.page.locator('#xc-modelmap button[onclick="xcSaveModelMap()"] ').click();
        await f.page.waitForTimeout(100);
        assert.equal(f.record.requests.filter(row => row.method === 'POST' && row.path === '/__switch/api/xc/modelmap').length, 1);
        f.setModelMap({ ...f.modelMap(), opus: 'vendor/refreshed/clean-opus' });
        await f.page.evaluate(() => loadXcModelMap());
        assert.equal(await f.page.locator('#xc-mm-opus').inputValue(), 'vendor/refreshed/clean-opus');
        await f.page.locator('#xc-mm-haiku').selectOption('vendor/nested/model');
        f.releaseSave();
        await f.page.waitForFunction(() => document.getElementById('toasts')?.textContent.includes('маппинг сохранён'));
        assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), 'vendor/server/accepted-sonnet', 'submitted dirty field reconciles with server response');
        assert.equal(await f.page.locator('#xc-mm-haiku').inputValue(), 'vendor/nested/model', 'edit made after the submitted snapshot remains unsaved');
        assert.equal(await f.page.locator('#xc-mm-opus').inputValue(), sent.opus,
            'a clean field that followed a concurrent refresh is not misclassified as a new local draft at save completion');
        assert.deepEqual(await f.page.evaluate(() => state.xcModelMap), f.modelMap());
        assert.deepEqual(f.record.errors, []);
    } finally { f.releaseSave(); await f.context.close(); }
});

test('refresh', 'saved-map and session refresh preserve dirty exact IDs and empty choices while clean fields follow the saved map', async () => {
    const f = await fixture();
    try {
        const detail = f.page.locator('#xc-modelmap');
        await detail.locator('summary').click();
        await f.page.locator('#xc-mm-sonnet').selectOption('vendor/nested/model');
        await f.page.locator('#xc-mm-opus').selectOption('');
        const latest = { opus: 'vendor/latest/opus', sonnet: 'vendor/latest/sonnet', haiku: 'vendor/latest/clean-haiku' };
        f.setModelMap(latest);
        f.setCatalog([{ id: 'claude-opus-5' }]);
        await f.page.evaluate(() => loadXcModelMap());
        for (const refresh of ['render', 'catalog', 'session']) {
            await f.page.evaluate(async kind => {
                if (kind === 'render') await renderXcModelMap();
                if (kind === 'catalog') { await loadXcModels(false); await renderXcModels(state.xcModels); }
                if (kind === 'session') {
                    await loadXcSessions(false);
                    await loadXcModelMap();
                    await renderXcModels(state.xcModels);
                }
            }, refresh);
            assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), 'vendor/nested/model', refresh + ' preserves dirty nested slash ID');
            assert.equal(await f.page.locator('#xc-mm-opus').inputValue(), '', refresh + ' preserves an explicit empty draft');
            assert.equal(await f.page.locator('#xc-mm-haiku').inputValue(), latest.haiku, refresh + ' updates only a clean field');
            assert.equal(await detail.evaluate(node => node.open), true);
        }
        assert.deepEqual(await f.page.evaluate(() => state.xcModelMap), latest);
        await detail.locator('summary').click();
        await f.page.evaluate(() => loadXcModelMap());
        assert.equal(await detail.evaluate(node => node.open), false, 'refresh does not reopen a user-closed block');
        assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), 'vendor/nested/model');
        await f.page.locator('.nav-btn[data-tab="api-gateway"]').click();
        await f.page.locator('.nav-btn[data-tab="xingchi"]').click();
        assert.equal(await detail.evaluate(node => node.open), false);
        assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), 'vendor/nested/model', 'tab return retains the unsaved draft');
        assert.equal(f.record.requests.filter(row => row.method === 'POST').length, 0);
        assert.deepEqual(f.record.errors, []);
    } finally { await f.context.close(); }
});

test('failure', 'failed explicit POST leaves saved map and the out-of-catalog draft unchanged through refresh', async () => {
    const f = await fixture();
    try {
        await f.page.locator('#xc-modelmap summary').click();
        await f.page.locator('#xc-mm-sonnet').selectOption('gpt-6-astra');
        f.setCatalog([{ id: 'claude-opus-5' }]);
        await f.page.evaluate(() => renderXcModels([{ id: 'claude-opus-5' }]));
        const original = structuredClone(f.modelMap());
        f.setSaveStatus(500);
        await f.page.locator('#xc-modelmap button[onclick="xcSaveModelMap()"] ').click();
        await f.page.waitForFunction(() => document.getElementById('toasts')?.textContent.includes('isolated save failure'));
        await f.page.evaluate(() => loadXcModelMap());
        assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), 'gpt-6-astra');
        assert.deepEqual(f.modelMap(), original);
        assert.deepEqual(await f.page.evaluate(() => state.xcModelMap), original);
        assert.equal(await f.page.locator('#xc-modelmap').evaluate(node => node.open), true);
        assert.deepEqual(f.record.requests.filter(row => row.method === 'POST').map(row => row.path), ['/__switch/api/xc/modelmap']);
        assert.equal(f.active(), 'claude-opus-5');
        assert.deepEqual(f.record.errors, []);
    } finally { await f.context.close(); }
});

test('http-failure', 'failed HTTP save cannot commit the draft even if the JSON body claims success', async () => {
    const f = await fixture();
    try {
        await f.page.locator('#xc-modelmap summary').click();
        await f.page.locator('#xc-mm-sonnet').selectOption('gpt-6-astra');
        f.setSaveStatus(500); f.setSaveBodyOk(true);
        await f.page.evaluate(() => xcSaveModelMap());
        assert.deepEqual(await f.page.evaluate(() => state.xcModelMap), f.modelMap(), 'HTTP failure must leave the saved state unchanged');
        await f.page.evaluate(() => loadXcModelMap());
        assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), 'gpt-6-astra', 'HTTP failure must not mark the draft committed');
        assert.deepEqual(f.record.errors, []);
    } finally { await f.context.close(); }
});

test('main-model', 'catalog copy and explicit main-model selection keep their original saved-map payload and do not submit compatibility drafts', async () => {
    const f = await fixture();
    try {
        await f.page.locator('#xc-modelmap summary').click();
        await f.page.locator('#xc-mm-sonnet').selectOption('gpt-6-astra');
        const model = f.page.locator('#xc-models-list [data-publication-chip="xingchi/gpt-6-astra"]');
        await model.locator('button[title^="Копировать"]').click();
        await f.page.waitForFunction(() => window.__copied.length === 1);
        assert.deepEqual(await f.page.evaluate(() => window.__copied), ['/model gpt-6-astra[1m]']);
        assert.equal(f.record.requests.filter(row => row.method === 'POST').length, 0, 'copy does not trigger main-model/save/test/publication');
        await model.locator('[onclick^="xcSelectModel"]').click();
        await f.page.waitForFunction(() => state.xcActiveModel === 'gpt-6-astra');
        assert.deepEqual(f.record.requests.filter(row => row.method === 'POST').map(row => ({ path: row.path, body: row.body })), [{
            path: '/__switch/api/xc/set-model', body: { model: 'gpt-6-astra', modelMap: f.modelMap() },
        }], 'existing main-model POST uses the saved map, not an unsaved compatibility selection');
        await f.page.evaluate(() => renderXcModels(state.xcModels));
        assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), 'gpt-6-astra');
        assert.equal(await f.page.locator('#xc-modelmap').evaluate(node => node.open), true);
        assert.equal(await model.locator('[data-publication-slot="xingchi/gpt-6-astra"]').count(), 1, 'preserve the external publication slot');
        assert.equal(await model.locator('[data-xc-test="gpt-6-astra"]').count(), 1, 'preserve external manual-test control');
        assert.deepEqual(f.record.errors, []);
    } finally { await f.context.close(); }
});

test('layout', 'moved mapping and original catalog header fit mobile with long exact target IDs', async () => {
    const f = await fixture(390);
    try {
        const longId = 'vendor/nested/' + 'long-exact-outside-catalog-target-'.repeat(5);
        f.setModelMap({ opus: longId, sonnet: 'claude-opus-5', haiku: '' });
        await f.page.evaluate(() => loadXcModelMap());
        await f.page.locator('#xc-modelmap summary').click();
        await f.page.locator('#xc-modelmap').scrollIntoViewIfNeeded();
        await f.page.waitForTimeout(1100); // Real throttled Tailwind compilation.
        const file = path.join(EVIDENCE, 'mapping-layout-390.png');
        await f.page.screenshot({ path: file }); f.record.screenshots.push(file);
        const layout = await f.page.evaluate(() => {
            const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
            const card = document.getElementById('xc-modelmap');
            return { card: rect(card), fields: [...card.querySelectorAll('select,button')].map(rect),
                header: rect(document.querySelector('#xc-models > div')),
                headerControls: [...document.querySelectorAll('#xc-models > div code, #xc-models > div button')].map(rect) };
        });
        f.record.layout = layout;
        assert.ok(layout.fields.every(field => field.width > 0 && field.left >= layout.card.left && field.right <= layout.card.right + 1),
            'long saved targets must not force tier selects or save/refresh outside the moved card');
        assert.ok(layout.headerControls.every(field => field.width > 0 && field.left >= layout.header.left && field.right <= layout.header.right + 1),
            'original catalog copy/refresh controls must wrap inside the mobile header');
        assert.equal(await f.page.locator('#xc-mm-opus').inputValue(), longId, 'layout cannot truncate or rewrite the exact option value');
        assert.deepEqual(f.record.errors, []);
    } finally { await f.context.close(); }
});

for (const width of [1440, 390]) test('flow', 'Xingchi whole user flow including refresh, failed/successful save, tab return and F5 at ' + width, async () => {
    const f = await fixture(width);
    const detail = f.page.locator('#xc-modelmap');
    const shot = async label => {
        await f.page.waitForFunction(() => document.querySelectorAll('#toasts > *').length === 0, null, { timeout: 25000 });
        await f.page.locator('#xc-models').scrollIntoViewIfNeeded();
        await f.page.waitForTimeout(900);
        const file = path.join(EVIDENCE, 'flow-' + width + '-' + label + '.png');
        await f.page.screenshot({ path: file }); f.record.screenshots.push(file);
    };
    try {
        assert.equal(await detail.evaluate(node => node.open), false);
        await shot('closed');
        await detail.locator('summary').click();
        await f.page.locator('#xc-mm-sonnet').selectOption('gpt-6-astra');
        await f.page.locator('#xc-mm-opus').selectOption('');
        const latest = { opus: 'vendor/latest/saved-opus', sonnet: 'claude-opus-5', haiku: 'vendor/latest/saved-haiku' };
        f.setModelMap(latest);
        f.setCatalog([{ id: 'claude-opus-5' }, { id: 'vendor/nested/model' }]);
        await detail.locator('button[onclick="loadXcModels(false)"]').click();
        await f.page.evaluate(async () => { await loadXcModelMap(); await renderXcModels(state.xcModels); });
        await f.page.locator('button[onclick="loadXcSessions(false)"]').click();
        await f.page.evaluate(async () => { await loadXcModelMap(); await renderXcModels(state.xcModels); });
        assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), 'gpt-6-astra');
        assert.equal(await f.page.locator('#xc-mm-opus').inputValue(), '');
        assert.equal(await f.page.locator('#xc-mm-haiku').inputValue(), latest.haiku);
        assert.equal(await detail.evaluate(node => node.open), true);
        assert.equal(f.record.requests.filter(row => row.method === 'POST').length, 0);
        await shot('draft-refreshed');
        await f.page.locator('.nav-btn[data-tab="api-gateway"]').click();
        await f.page.locator('.nav-btn[data-tab="xingchi"]').click();
        assert.equal(await detail.evaluate(node => node.open), true);
        assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), 'gpt-6-astra');
        f.setSaveStatus(500);
        await detail.locator('button[onclick="xcSaveModelMap()"] ').click();
        await f.page.waitForFunction(() => document.getElementById('toasts')?.textContent.includes('isolated save failure'));
        assert.equal(await f.page.locator('#xc-mm-sonnet').inputValue(), 'gpt-6-astra');
        assert.deepEqual(f.modelMap(), latest);
        f.setSaveStatus(200);
        await detail.locator('button[onclick="xcSaveModelMap()"] ').click();
        await f.page.waitForFunction(() => document.getElementById('toasts')?.textContent.includes('маппинг сохранён'));
        const committed = { opus: '', sonnet: 'gpt-6-astra', haiku: latest.haiku };
        assert.deepEqual(f.modelMap(), committed);
        assert.equal(f.active(), 'claude-opus-5');
        await f.page.locator('#xc-mm-sonnet').selectOption('vendor/nested/model');
        await f.page.reload({ waitUntil: 'load' });
        await f.page.locator('.nav-btn[data-tab="xingchi"]').click();
        await f.page.waitForFunction(() => document.getElementById('xc-mm-sonnet')?.value === 'gpt-6-astra');
        assert.equal(await detail.evaluate(node => node.open), false, 'F5 closes details and drops only the local unsaved draft');
        await detail.locator('summary').click();
        assert.deepEqual(await f.page.evaluate(() => ['opus', 'sonnet', 'haiku'].map(name => document.getElementById('xc-mm-' + name).value)),
            [committed.opus, committed.sonnet, committed.haiku]);
        await shot('f5-saved-open');
        const posts = f.record.requests.filter(row => row.method === 'POST');
        assert.deepEqual(posts.map(row => row.path), ['/__switch/api/xc/modelmap', '/__switch/api/xc/modelmap']);
        assert.deepEqual(posts.map(row => row.body), [committed, committed]);
        assert.deepEqual(f.record.errors, []);
        assert.ok(f.record.blocked.every(origin => origin === 'https://www.cbr-xml-daily.ru'),
            'all networking is intercepted; only the existing background exchange-rate read may be attempted and blocked');
    } finally { await f.context.close(); }
});

test('syntax', 'all executable inline dashboard scripts compile without evaluating or booting the hub', async () => {
    const scripts = [...DASHBOARD.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
        .filter(match => !/\bsrc\s*=/i.test(match[1]) && !/\btype\s*=\s*["'](?:application\/json|application\/ld\+json)/i.test(match[1]));
    assert.ok(scripts.length > 0);
    for (const [index, match] of scripts.entries()) new vm.Script(match[2], { filename: SOURCE + ':inline-' + (index + 1) });
    observations.push({ inlineScriptsCompiled: scripts.length });
});

(async () => {
    browser = await chromium.launch({ headless: true });
    try {
        for (const item of tests.filter(item => STAGE === 'all' || item.stage === STAGE)) {
            try {
                await item.run(); results.push({ stage: item.stage, name: item.name, ok: true });
                console.log('PASS ' + item.name);
            } catch (error) {
                results.push({ stage: item.stage, name: item.name, ok: false, error: error.stack });
                console.error('FAIL ' + item.name + '\n' + error.stack);
            }
        }
        assert.ok(results.length, 'requested stage must select at least one test');
    } finally {
        await browser.close();
        const receipt = { ok: results.length > 0 && results.every(row => row.ok), source: SOURCE,
            stage: STAGE, scope: 'actual dashboard markup/functions with isolated browser HTTP fixtures; no live provider or owner file writes',
            results, observations };
        fs.writeFileSync(path.join(EVIDENCE, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
        console.log('XC_ADVANCED_EVIDENCE ' + EVIDENCE);
    }
    process.exitCode = results.length > 0 && results.every(row => row.ok) ? 0 : 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
