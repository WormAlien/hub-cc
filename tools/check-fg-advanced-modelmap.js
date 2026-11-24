#!/usr/bin/env node
'use strict';
// FreeGG only: run the actual dashboard and local assets in a browser with
// intercepted fixture data. No owner maps, settings, providers or live sockets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const routing = path.join(root, 'routing');
const sourcePath = path.join(routing, 'proxy-dashboard.html');
const html = fs.readFileSync(sourcePath, 'utf8');
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, ...value] = arg.replace(/^--/, '').split('=');
    return [key, value.length ? value.join('=') : true];
}));
const scratch = process.env.HERMES_TEST_SCRATCH || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch')
    : path.join(os.homedir(), '.cache/hermes/scratch'));
const evidence = args.evidence ? path.resolve(args.evidence) : fs.mkdtempSync(path.join(scratch, 'fg-advanced-'));
fs.mkdirSync(evidence, { recursive: true });
const phase = args.phase || 'verify';
const origin = 'http://127.0.0.1:46193'; // Intercepted; no listener is started.
const results = [];
const tests = [];
const test = (name, run, width = 1440) => tests.push({ name, run, width });
const savedSeed = { opus: 'saved/opus-outside-catalog', sonnet: 'gpt-6.1-sol', haiku: '' };
const modelSeed = [{ id: 'gpt-6.1-sol' }, { id: 'draft/nested-model' }, { id: 'catalog/other' }];

function compileScripts() {
    let count = 0;
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/\bsrc\s*=/.test(match[1]) || !match[2].trim()) continue;
        new vm.Script(match[2], { filename: 'proxy-dashboard.inline-' + (++count) + '.js' });
    }
    assert.ok(count > 0, 'actual dashboard inline scripts must be compiled');
    return count;
}

async function fixture(browser, width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, serviceWorkers: 'block' });
    const state = {
        saved: structuredClone(savedSeed), models: structuredClone(modelSeed), activeModel: 'gpt-6.1-sol',
        current: 'official', requests: [], mutations: [], errors: [], blocked: [], unexpectedMutations: [],
        saveMode: 'success', saveDelay: 0,
    };
    await context.addInitScript(() => {
        localStorage.setItem('opencode_active_tab', 'claude');
        window.__fgCopied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: async text => window.__fgCopied.push(text) } });
    });
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) {
            state.blocked.push(url.origin);
            return route.abort('blockedbyclient');
        }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        if (url.pathname.startsWith('/vendor/')) {
            const file = path.resolve(routing, 'vendor', url.pathname.slice('/vendor/'.length));
            if (file.startsWith(path.resolve(routing, 'vendor') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                const type = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)];
                if (type) return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
            }
        }
        const row = { method: request.method(), path: url.pathname, search: url.search };
        if (request.postData()) row.body = request.postDataJSON();
        state.requests.push(row);
        if (row.method !== 'GET') state.mutations.push(row);
        let status = 200, body = { ok: false };
        if (url.pathname === '/__switch/api/status') {
            body = { current: state.current, backends: { freegg: { label: 'FreeGG', base_url: origin } }, oauth: {} };
        } else if (url.pathname === '/__switch/api/fg/sessions') {
            body = { ok: true, sessions: [{ id: 'fg-fixture', email: 'fg@example.test', api_key: 'fg-fixture-key-not-live',
                name: 'Изолированный аккаунт', active: false, status: 'live', balance: 25, granted: 25 }] };
        } else if (url.pathname === '/__switch/api/fg/models') {
            body = { ok: true, models: state.models };
        } else if (url.pathname === '/__switch/api/fg/active-model') {
            body = { ok: true, model: state.activeModel };
        } else if (url.pathname === '/__switch/api/fg/modelmap') {
            if (row.method === 'POST') {
                if (state.saveDelay) await new Promise(resolve => setTimeout(resolve, state.saveDelay));
                if (state.saveMode === 'failure') { status = 500; body = { ok: false, error: 'fixture save failed' }; }
                else if (state.saveMode === 'http-failure') { status = 503; body = { ok: true, modelMap: structuredClone(row.body), error: 'fixture HTTP rejection' }; }
                else { state.saved = structuredClone(row.body); body = { ok: true, modelMap: state.saved }; }
            } else body = { ok: true, modelMap: state.saved };
        } else if (url.pathname === '/__switch/api/fg/set-model' && row.method === 'POST') {
            state.activeModel = row.body.model;
            body = { ok: true, model: state.activeModel, settingsModel: 'freegg/' + state.activeModel + '[1m]' };
        } else if (url.pathname === '/__switch/api/fg/keepalive/state') {
            const cfg = { hedgeMs: 20000, maxHedges: 0, maxAttempts: 3, preCommitMs: 10000 };
            body = { ok: true, cfg, defaults: cfg, stats: {}, latency: {}, port: 0 };
        } else if (url.pathname === '/__switch/api/grok/sessions') {
            body = { ok: true, sessions: [], active: null };
        } else if (url.pathname === '/__switch/api/gemini/list') {
            // Background read is permitted; avoid the unrelated auto-start path.
            body = { ok: true, accounts: [], tiers: [], server: { up: true } };
        } else if (url.pathname === '/__switch/api/gemini/modelmap') {
            body = { ok: true, modelMap: {}, activeModel: null };
        } else if (url.pathname === '/__switch/api/api-gateway') {
            body = { ok: true, canWrite: true, providers: ['freegg'], manifest: { version: 1, revision: 7, enabled: true },
                models: [], candidatesLoaded: false, public: { anthropicBaseUrl: origin, openaiBaseUrl: origin + '/openai/v1' } };
        } else {
            status = 404;
            if (row.method !== 'GET') state.unexpectedMutations.push(row);
        }
        await route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => state.errors.push(error.message));
    await page.goto(origin + '/', { waitUntil: 'load' });
    // Use the existing navigation, session load, model renderer and map read.
    await page.locator('.nav-btn[data-tab="freegg"]').click();
    await page.waitForFunction(() => document.querySelector('#fg-mm-opus')?.value === 'saved/opus-outside-catalog'
        && document.querySelector('#fg-models-list')?.textContent.includes('draft/nested-model'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#fg-models')).paddingLeft !== '0px');
    return { context, page, state };
}

async function values(page) {
    return page.evaluate(() => Object.fromEntries(['opus', 'sonnet', 'haiku'].map(tier =>
        [tier, document.getElementById('fg-mm-' + tier).value])));
}
async function open(page) {
    await page.locator('#fg-modelmap > summary').click();
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), true);
}

// First vertical slice: write/run RED before converting or moving production HTML.
test('closed-below-catalog', async ({ page, state }) => {
    const structure = await page.locator('#fg-modelmap').evaluate(node => ({
        tag: node.tagName, open: node.open, previous: node.previousElementSibling?.id,
        summary: node.querySelector(':scope > summary')?.textContent.trim(),
        summaries: node.querySelectorAll(':scope > summary').length,
        count: document.querySelectorAll('#fg-modelmap').length,
    }));
    assert.equal(structure.tag, 'DETAILS', 'FreeGG tier mapping must be an advanced details disclosure');
    assert.equal(structure.open, false, 'advanced mapping must be closed after initial page load');
    assert.equal(structure.previous, 'fg-models', 'advanced mapping must be directly below the existing catalog');
    assert.equal(structure.summary, 'Дополнительно - маппинг тиров');
    assert.equal(structure.summaries, 1);
    assert.equal(structure.count, 1);
    const before = JSON.stringify({ saved: state.saved, activeModel: state.activeModel, mutations: state.mutations });
    await open(page);
    assert.deepEqual(await values(page), savedSeed, 'opening must show saved tier targets, including targets outside the catalog');
    assert.equal(await page.locator('#fg-modelmap select').count(), 3);
    assert.equal(await page.locator('#fg-modelmap button[onclick="fgSaveModelMap()"]').count(), 1);
    assert.equal(await page.locator('#fg-modelmap button[onclick="loadFgModels(false)"]').count(), 1);
    await page.locator('#fg-modelmap > summary').click();
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), false);
    assert.equal(JSON.stringify({ saved: state.saved, activeModel: state.activeModel, mutations: state.mutations }), before,
        'opening and closing must not save maps, change models, or activate providers');
});

test('catalog-rerender-preserves-draft', async ({ page, state }) => {
    await open(page);
    await page.locator('#fg-mm-opus').selectOption('draft/nested-model');
    await page.locator('#fg-mm-sonnet').selectOption('');
    const draft = { opus: 'draft/nested-model', sonnet: '', haiku: '' };
    state.models = [{ id: 'catalog/other' }];
    await page.evaluate(async models => { await renderFgModels(models); }, state.models);
    assert.deepEqual(await values(page), draft, 'catalog rerender must retain user-changed targets even after removal from catalog');
    await page.evaluate(async () => { await renderFgModels(); await renderFgModelMap(); });
    assert.deepEqual(await values(page), draft, 'repeated ordinary model and map renders must retain the same draft');
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), true);
    assert.deepEqual(state.saved, savedSeed, 'draft values must not rewrite the saved provider map');
    assert.equal(state.mutations.length, 0, 'ordinary rerenders must not write maps or select/activate models');
    const options = await page.locator('#fg-mm-opus option').evaluateAll(nodes => nodes.map(node => node.value));
    assert.ok(options.includes('draft/nested-model'), 'an unsaved disappeared target remains a selectable exact ID');
    assert.ok(options.includes('saved/opus-outside-catalog'), 'saved targets outside the catalog remain available too');
});

test('http-failure-retains-draft', async ({ page, state }) => {
    await open(page);
    await page.locator('#fg-mm-opus').selectOption('draft/nested-model');
    const before = structuredClone(state.saved);
    state.saveMode = 'http-failure';
    await page.evaluate(() => fgSaveModelMap());
    assert.deepEqual(state.saved, before, 'rejected HTTP request did not commit the fixture map');
    assert.deepEqual(await page.evaluate(() => state.fgModelMap), before, 'ok:true JSON cannot override a rejected HTTP status');
    assert.match(await page.locator('#toasts').textContent(), /fixture HTTP rejection/);
    await page.evaluate(() => loadFgModelMap());
    assert.equal((await values(page)).opus, 'draft/nested-model', 'rejection cannot acknowledge or discard the draft');
    assert.equal(state.activeModel, 'gpt-6.1-sol');
});

test('success-acknowledges-draft', async ({ page, state }) => {
    await open(page);
    await page.locator('#fg-mm-opus').selectOption('draft/nested-model');
    await page.locator('#fg-mm-sonnet').selectOption('');
    await page.locator('#fg-mm-haiku').selectOption('catalog/other');
    const submitted = { opus: 'draft/nested-model', sonnet: '', haiku: 'catalog/other' };
    await page.locator('#fg-modelmap button[onclick="fgSaveModelMap()"]').click();
    await page.waitForFunction(() => document.getElementById('toasts')?.textContent.includes('✓ маппинг сохранён'));
    assert.deepEqual(state.saved, submitted, 'explicit save must send the exact three tier values, including empty values');
    assert.deepEqual(state.mutations.map(row => ({ method: row.method, path: row.path, body: row.body })), [
        { method: 'POST', path: '/__switch/api/fg/modelmap', body: submitted },
    ], 'explicit save must keep the existing endpoint, JSON payload and mutation boundary');
    assert.equal(state.activeModel, 'gpt-6.1-sol', 'saving tiers must not change the main selected model');
    assert.equal(state.current, 'official', 'saving tiers must not activate FreeGG');
    const nextSaved = { opus: 'external/new-opus', sonnet: 'external/new-sonnet', haiku: 'external/new-haiku' };
    state.saved = nextSaved;
    await page.evaluate(async () => { await loadFgModelMap(); });
    assert.deepEqual(await values(page), nextSaved,
        'successful save must acknowledge the submitted draft so later saved-state refresh can update those fields');
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), true);
});

test('pending-save-preserves-newer-edit', async ({ page, state }) => {
    await open(page);
    await page.locator('#fg-mm-opus').selectOption('draft/nested-model');
    state.saveDelay = 250;
    const saving = page.evaluate(async () => { await fgSaveModelMap(); });
    await page.waitForTimeout(75);
    await page.locator('#fg-mm-opus').selectOption('catalog/other');
    await saving;
    assert.equal(state.saved.opus, 'draft/nested-model', 'save response acknowledges only the submitted value');
    state.saved = { opus: 'external/new-opus', sonnet: 'external/new-sonnet', haiku: '' };
    await page.evaluate(async () => { await loadFgModelMap(); });
    assert.equal((await values(page)).opus, 'catalog/other',
        'a newer edit made during save must stay dirty and survive the later saved-state refresh');
    assert.equal((await values(page)).sonnet, 'external/new-sonnet', 'untouched submitted fields read the newest saved map');
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), true);
});

test('session-map-refresh-keeps-dirty-only', async ({ page, state }) => {
    await open(page);
    await page.locator('#fg-mm-opus').selectOption('draft/nested-model');
    await page.locator('#fg-mm-sonnet').selectOption('');
    state.saved = { opus: 'external/new-opus', sonnet: 'external/new-sonnet', haiku: 'external/new-haiku' };
    state.models = [{ id: 'catalog/other' }];
    const expected = { opus: 'draft/nested-model', sonnet: '', haiku: 'external/new-haiku' };
    await page.evaluate(async () => { await loadFgModelMap(); });
    assert.deepEqual(await values(page), expected, 'map refresh preserves only dirty fields; untouched tiers read saved state');
    const readCount = state.requests.filter(row => row.path === '/__switch/api/fg/modelmap').length;
    await page.locator('[data-tab-content="freegg"] button[onclick="loadFgSessions(false)"]').click();
    await page.waitForFunction(() => state.fgModelMap?.haiku === 'external/new-haiku');
    await page.evaluate(async () => { await loadFgModelMap(); await renderFgModelMap(); });
    assert.ok(state.requests.filter(row => row.path === '/__switch/api/fg/modelmap').length > readCount);
    assert.deepEqual(await values(page), expected, 'ordinary session refresh and repeated map renders retain the draft');
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), true);
    await page.locator('.nav-btn[data-tab="api-gateway"]').click();
    await page.locator('.nav-btn[data-tab="freegg"]').click();
    assert.deepEqual(await values(page), expected, 'returning to FreeGG does not discard the draft');
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), true);
    assert.equal(state.mutations.length, 0);
});

test('failure-keeps-dirty-draft', async ({ page, state }) => {
    await open(page);
    await page.locator('#fg-mm-opus').selectOption('draft/nested-model');
    await page.locator('#fg-mm-sonnet').selectOption('');
    state.saveMode = 'failure';
    await page.locator('#fg-modelmap button[onclick="fgSaveModelMap()"]').click();
    await page.waitForFunction(() => document.getElementById('toasts')?.textContent.includes('Ошибка: fixture save failed'));
    assert.deepEqual(state.saved, savedSeed, 'failed save must not look committed');
    assert.equal(state.mutations.length, 1, 'failure must not auto-retry or activate a provider');
    state.models = [{ id: 'catalog/other' }];
    state.saved = { opus: 'external/opus', sonnet: 'external/sonnet', haiku: 'external/haiku' };
    await page.evaluate(async models => { await loadFgModelMap(); await renderFgModels(models); }, state.models);
    assert.deepEqual(await values(page), { opus: 'draft/nested-model', sonnet: '', haiku: 'external/haiku' },
        'failed save leaves user changes dirty across saved-map and missing-catalog refreshes');
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), true);
    assert.equal(state.activeModel, 'gpt-6.1-sol');
});

test('reload-reads-saved-and-closes', async ({ page, state }) => {
    await open(page);
    await page.locator('#fg-mm-opus').selectOption('draft/nested-model');
    const nextSaved = { opus: 'external/reloaded-opus', sonnet: 'catalog/other', haiku: '' };
    state.saved = nextSaved;
    await page.reload({ waitUntil: 'load' });
    await page.locator('.nav-btn[data-tab="freegg"]').click();
    await page.waitForFunction(() => document.getElementById('fg-mm-opus')?.value === 'external/reloaded-opus');
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), false,
        'F5 starts a new closed disclosure, not a persisted open/draft UI');
    await open(page);
    assert.deepEqual(await values(page), nextSaved, 'F5 discards only unsaved UI state and reads the saved provider map');
    assert.equal(state.mutations.length, 0);
});

test('catalog-copy-select-publication-boundary', async ({ page, state }) => {
    await open(page);
    await page.locator('#fg-mm-opus').selectOption('draft/nested-model');
    const chip = page.locator('#fg-models-list [data-publication-chip="freegg/catalog/other"]');
    await chip.locator('button[title^="Копировать"]').click();
    await page.waitForFunction(() => window.__fgCopied.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__fgCopied), ['/model catalog/other[1m]'],
        'copy retains the existing exact model command; it does not add a new provider prefix');
    assert.equal(state.mutations.length, 0, 'copy cannot select the main model or publish it');
    await page.waitForFunction(() => !!document.querySelector('#fg-models-list input[data-publication-id="freegg/catalog/other"]'));
    assert.equal(await chip.locator('input[data-publication-id="freegg/catalog/other"]').count(), 1);
    assert.equal(await chip.locator('input[data-publication-id="freegg/catalog/other"]').getAttribute('role'), 'switch');
    await chip.locator('span[onclick^="fgSelectModel("]').click();
    await page.waitForFunction(() => state.fgActiveModel === 'catalog/other');
    assert.deepEqual(state.mutations.map(row => ({ method: row.method, path: row.path, body: row.body })), [
        { method: 'POST', path: '/__switch/api/fg/set-model', body: { model: 'catalog/other', modelMap: savedSeed } },
    ], 'main selection retains its existing saved-map payload and is not a draft tier save or publication');
    await page.evaluate(async () => { await renderFgModels(); });
    assert.equal((await values(page)).opus, 'draft/nested-model', 'main selection rerender cannot discard the tier draft');
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), true);
});

async function layoutSnapshot(page) {
    return page.locator('#fg-modelmap').evaluate(node => {
        const box = element => {
            const rect = element.getBoundingClientRect();
            return { id: element.id, tag: element.tagName, left: rect.left, right: rect.right,
                top: rect.top, bottom: rect.bottom, width: rect.width };
        };
        return { viewport: innerWidth, panel: box(node), summary: box(node.querySelector('summary')),
            controls: [...node.querySelectorAll('select, button')].map(box),
            overflow: node.scrollWidth > node.clientWidth };
    });
}
test('mobile393-mapping-fits', async ({ page, state }) => {
    state.saved = { opus: 'provider/' + 'very-long-saved-target-'.repeat(7), sonnet: 'gpt-6.1-sol', haiku: '' };
    await page.evaluate(async () => { await loadFgModelMap(); });
    await page.waitForFunction(() => document.querySelectorAll('#toasts > *').length === 0, null, { timeout: 20000 });
    await page.locator('#fg-models').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, phase + '-mobile393-closed.png') });
    await open(page);
    await page.locator('#fg-modelmap').scrollIntoViewIfNeeded();
    const layout = await layoutSnapshot(page);
    state.layout = layout;
    await page.screenshot({ path: path.join(evidence, phase + '-mobile393-open.png') });
    assert.ok(layout.controls.every(control => control.width > 0 && control.left >= layout.panel.left
        && control.right <= layout.panel.right + 1 && control.right <= 393),
    'mapping selects/save/refresh must fit their card and the 393px viewport, even for a long saved target');
    assert.equal(layout.overflow, false, 'the advanced mapping must not introduce horizontal overflow');
}, 393);

test('mobile393-long-target-readable', async ({ page, state }) => {
    const longId = 'provider/' + 'very-long-saved-target-'.repeat(7);
    state.saved = { ...savedSeed, opus: longId };
    await page.evaluate(async () => { await loadFgModelMap(); });
    await open(page);
    const select = page.locator('#fg-mm-opus');
    assert.equal(await select.getAttribute('title'), longId,
        'a clipped long target must expose its exact ID without changing the selected value');
    const style = await select.evaluate(node => ({
        ellipsis: getComputedStyle(node).textOverflow, paddingRight: parseFloat(getComputedStyle(node).paddingRight),
    }));
    assert.equal(style.ellipsis, 'ellipsis', 'long tier targets must truncate cleanly rather than collide with the dropdown arrow');
    assert.ok(style.paddingRight >= 24, 'reserve readable arrow space at393px');
}, 393);

async function wholeFlow({ page, state }, width) {
    const capture = async label => {
        await page.locator('#fg-models').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, phase + '-flow-' + width + '-' + label + '.png'), fullPage: true });
    };
    await page.waitForFunction(() => document.querySelectorAll('#toasts > *').length === 0, null, { timeout: 20000 });
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), false);
    await capture('closed');
    await open(page);
    await page.locator('#fg-mm-opus').selectOption('draft/nested-model');
    await page.locator('#fg-mm-sonnet').selectOption('');
    state.models = [{ id: 'catalog/other' }];
    await page.locator('#fg-modelmap button[onclick="loadFgModels(false)"]').click();
    await page.evaluate(async () => { await loadFgModelMap(); await renderFgModelMap(); });
    assert.equal((await values(page)).opus, 'draft/nested-model');
    assert.equal((await values(page)).sonnet, '');
    await capture('draft-after-refresh');
    await page.locator('.nav-btn[data-tab="api-gateway"]').click();
    await page.locator('.nav-btn[data-tab="freegg"]').click();
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), true);
    assert.equal((await values(page)).opus, 'draft/nested-model');
    state.saveMode = 'failure';
    await page.locator('#fg-modelmap button[onclick="fgSaveModelMap()"]').click();
    await page.waitForFunction(() => document.getElementById('toasts')?.textContent.includes('Ошибка: fixture save failed'));
    assert.deepEqual(state.saved, savedSeed);
    await capture('failed-save');
    state.saveMode = 'success';
    await page.locator('#fg-modelmap button[onclick="fgSaveModelMap()"]').click();
    await page.waitForFunction(() => document.getElementById('toasts')?.textContent.includes('✓ маппинг сохранён'));
    assert.deepEqual(state.saved, { opus: 'draft/nested-model', sonnet: '', haiku: '' });
    assert.equal(state.activeModel, 'gpt-6.1-sol');
    await page.waitForFunction(() => document.querySelectorAll('#toasts > *').length === 0, null, { timeout: 20000 });
    await capture('saved');
    await page.reload({ waitUntil: 'load' });
    await page.locator('.nav-btn[data-tab="freegg"]').click();
    await page.waitForFunction(() => document.getElementById('fg-mm-opus')?.value === 'draft/nested-model');
    assert.equal(await page.locator('#fg-modelmap').evaluate(node => node.open), false);
    await capture('reloaded-closed');
    await open(page);
    assert.deepEqual(await values(page), state.saved);
    state.layout = await layoutSnapshot(page);
    assert.equal(state.layout.overflow, false);
    assert.ok(state.layout.controls.every(control => control.right <= width && control.width > 0));
    assert.equal(state.mutations.length, 2, 'only the two explicit map save attempts mutate the fixture');
    await capture('reloaded-saved');
}
test('whole-flow-desktop', app => wholeFlow(app, 1440));
test('whole-flow-mobile393', app => wholeFlow(app, 393), 393);

(async () => {
    const compiled = compileScripts();
    if (args['compile-only']) { console.log('PASS dashboard inline script compilation: ' + compiled); return; }
    const chosen = args.case ? tests.filter(item => item.name === args.case) : tests;
    assert.ok(chosen.length, 'unknown --case=' + args.case);
    const browser = await chromium.launch({ headless: true });
    try {
        for (const item of chosen) {
            let app;
            const result = { name: item.name, phase, ok: false, width: item.width || 1440 };
            results.push(result);
            try {
                app = await fixture(browser, result.width);
                await item.run(app);
                assert.deepEqual(app.state.errors, [], 'no browser errors in the actual dashboard scenario');
                assert.ok(app.state.blocked.every(origin => origin === 'https://www.cbr-xml-daily.ru'),
                    'only the existing exchange-rate read may be attempted; every external request is aborted');
                assert.deepEqual(app.state.unexpectedMutations, [], 'no unrelated mutations allowed');
                result.ok = true;
                console.log('PASS ' + item.name);
            } catch (error) {
                result.error = error.stack;
                console.error('FAIL ' + item.name + '\n' + error.stack);
            } finally {
                if (app) {
                    result.requests = app.state.requests;
                    result.mutations = app.state.mutations;
                    result.saved = app.state.saved;
                    result.activeModel = app.state.activeModel;
                    result.errors = app.state.errors;
                    result.blocked = app.state.blocked;
                    result.unexpectedMutations = app.state.unexpectedMutations;
                    if (app.state.layout) result.layout = app.state.layout;
                    await app.context.close();
                    result.contextClosed = true;
                }
            }
        }
    } finally {
        await browser.close();
        const receipt = { phase, sourcePath, compiled, passed: results.filter(row => row.ok).length,
            failed: results.filter(row => !row.ok).length, results,
            scope: 'actual dashboard source + local assets; intercepted FreeGG fixture; no owner files or live provider traffic' };
        const name = phase + '-' + (args.case || 'all') + '.json';
        fs.writeFileSync(path.join(evidence, name), JSON.stringify(receipt, null, 2) + '\n');
        fs.appendFileSync(path.join(evidence, 'worklog.jsonl'), JSON.stringify({ phase, case: args.case || 'all',
            command: [process.execPath, ...process.argv.slice(1)].join(' '), passed: receipt.passed, failed: receipt.failed,
            receipt: path.join(evidence, name) }) + '\n');
        console.log('FG_ADVANCED_RECEIPT ' + path.join(evidence, name));
        console.log('FG_ADVANCED_RESULT ' + receipt.passed + ' passed, ' + receipt.failed + ' failed');
        process.exitCode = receipt.failed ? 1 : 0;
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
