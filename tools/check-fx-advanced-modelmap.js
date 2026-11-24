#!/usr/bin/env node
'use strict';
// Exercises the actual dashboard and vendor assets in an isolated browser.
// All HTTP is intercepted; no hub, provider, owner map or settings are touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const routing = path.join(root, 'routing');
const source = fs.readFileSync(path.join(routing, 'proxy-dashboard.html'), 'utf8');
const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) || 'all';
assert.ok(['markup', 'refresh', 'all'].includes(phase), 'phase is markup, refresh or all');
const scratch = process.env.HERMES_TEST_SCRATCH || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch') : path.join(os.homedir(), '.cache/hermes/scratch'));
fs.mkdirSync(scratch, { recursive: true });
const out = fs.mkdtempSync(path.join(scratch, 'fx-advanced-modelmap-'));
const origin = 'http://127.0.0.1:45937';
const observations = [], errors = [], blocked = [], violations = [];
let passed = 0, failed = 0;
let compiled = 0;
for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(match[1]) || /\btype\s*=\s*['"](?:application\/json|importmap)['"]/.test(match[1])) continue;
    new vm.Script(match[2], { filename: 'proxy-dashboard-inline-' + (++compiled) + '.js' });
}
console.log('PASS compile real dashboard inline scripts: ' + compiled);

async function scenario(browser, width) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    let catalog = ['fixture/opus', 'fixture/sonnet', 'fixture/haiku', 'fixture/draft-target'].map(id => ({ id }));
    let saved = { opus: 'fixture/saved-outside-catalog', sonnet: 'fixture/sonnet', haiku: 'fixture/haiku' };
    let activeModel = 'fixture/opus', saveMode = 'success';
    const requests = [];
    const session = { id: 'fx-browser-fixture', email: 'fx@example.test', name: 'Browser fixture',
        api_key: 'fixture-not-a-live-key', active: true, status: 'live', balance: 5, grant: 5, created: '2026-01-01T00:00:00Z' };
    const checkpoint = (name, detail = {}) => observations.push({ width, name, ...detail });
    const tabs = [...new Set([...source.matchAll(/\bdata-tab="([a-z0-9-]+)"/g)].map(match => match[1]))];
    await context.addInitScript(tabs => {
        if (!localStorage.getItem('opencode_active_tab')) localStorage.setItem('opencode_active_tab', 'claude');
        localStorage.setItem('dashboard-tabs-config-v1', JSON.stringify({ order: ['fxqidian', 'claude'],
            hidden: tabs.filter(tab => !['fxqidian', 'claude'].includes(tab)), shown: [] }));
        window.__fxCopied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: async text => window.__fxCopied.push(text) } });
    }, tabs);
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== origin) { blocked.push({ width, origin: url.origin }); return route.abort('blockedbyclient'); }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: source });
        if (url.pathname.startsWith('/vendor/')) {
            const file = path.resolve(routing, 'vendor', url.pathname.slice('/vendor/'.length));
            if (file.startsWith(path.resolve(routing, 'vendor') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                const type = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
                return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
            }
        }
        const entry = { method: req.method(), path: url.pathname, query: url.search };
        if (req.method() !== 'GET') entry.body = req.postData() ? req.postDataJSON() : null;
        requests.push(entry);
        let body = { ok: false, error: 'isolated fixture endpoint unavailable' }, status = 404;
        if (req.method() !== 'GET' && !['/__switch/api/fx/modelmap', '/__switch/api/fx/set-model'].includes(url.pathname)) {
            violations.push({ width, ...entry }); return route.abort('blockedbyclient');
        }
        if (url.pathname === '/__switch/api/status') {
            body = { current: 'official', backends: {}, oauth: { loggedIn: false } }; status = 200;
        } else if (url.pathname === '/__switch/api/fx/sessions') { body = { ok: true, sessions: [session] }; status = 200; }
        else if (url.pathname === '/__switch/api/fx/models') { body = { ok: true, models: catalog }; status = 200; }
        else if (url.pathname === '/__switch/api/fx/active-model') { body = { ok: true, model: activeModel }; status = 200; }
        else if (url.pathname === '/__switch/api/fx/modelmap' && req.method() === 'GET') { body = { ok: true, modelMap: saved }; status = 200; }
        else if (url.pathname === '/__switch/api/fx/modelmap' && req.method() === 'POST') {
            assert.deepEqual(Object.keys(entry.body).sort(), ['haiku', 'opus', 'sonnet'], 'existing tier-only save payload');
            if (saveMode === 'failure') { body = { ok: false, error: 'fixture save rejected' }; status = 500; }
            else { saved = { ...entry.body }; body = { ok: true, modelMap: saved }; status = 200; }
        } else if (url.pathname === '/__switch/api/fx/set-model' && req.method() === 'POST') {
            activeModel = entry.body.model; body = { ok: true, model: activeModel, settingsModel: activeModel }; status = 200;
        } else if (url.pathname === '/__switch/api/fx/keepalive/state') {
            const cfg = { hedgeMs: 20000, maxHedges: 0, maxAttempts: 3, preCommitMs: 10000 };
            body = { ok: true, cfg, defaults: cfg, stats: {}, latency: {}, port: 0 }; status = 200;
        } else if (url.pathname === '/__switch/api/fx/keepalive/latency') { body = { ok: true, buckets: [], windows: {} }; status = 200; }
        else if (url.pathname === '/__switch/api/api-gateway') {
            body = { ok: true, canWrite: false, providers: ['fxqidian'], manifest: { version: 1, revision: 1, enabled: true }, models: [] }; status = 200;
        } else if (url.pathname.endsWith('/sessions')) { body = { ok: true, sessions: [] }; status = 200; }
        else if (url.pathname.endsWith('/auto/status')) { body = { ok: true, enabled: false, switches: 0, poolReady: 0, poolBalance: 0 }; status = 200; }
        else if (url.pathname.endsWith('/rotate/history')) { body = { ok: true, entries: [] }; status = 200; }
        return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(18000);
    page.on('pageerror', error => errors.push({ width, message: error.message }));
    const mapping = page.locator('#fx-modelmap');
    const select = tier => page.locator('#fx-mm-' + tier);
    const readValues = () => page.evaluate(() => Object.fromEntries(['opus', 'sonnet', 'haiku'].map(tier => [tier, document.getElementById('fx-mm-' + tier)?.value])));
    const count = pathName => requests.filter(r => r.path === pathName && r.method === 'GET').length;
    const mutateCount = () => requests.filter(r => r.method !== 'GET').length;
    const settleCatalog = async expected => page.waitForFunction(value => document.getElementById('fx-models-list')?.textContent.includes(value), expected);
    const save = async () => {
        const before = requests.filter(r => r.path === '/__switch/api/fx/modelmap' && r.method === 'POST').length;
        await mapping.locator('button[onclick="fxSaveModelMap()"]', { hasText: 'Сохранить' }).click();
        await page.waitForFunction(() => state.toastLog.some(t => /маппинг сохранён|fixture save rejected/.test(t.text)));
        assert.equal(requests.filter(r => r.path === '/__switch/api/fx/modelmap' && r.method === 'POST').length, before + 1);
    };
    try {
        await page.goto(origin + '/', { waitUntil: 'load' });
        await page.locator('.nav-btn[data-tab="fxqidian"]').click();
        await settleCatalog('fixture/draft-target');
        await page.waitForFunction(() => document.getElementById('fx-mm-opus')?.value === 'fixture/saved-outside-catalog');
        assert.equal(await mapping.evaluate(node => node.tagName), 'DETAILS', 'Fxqidian mapping must be a native disclosure');
        assert.equal(await mapping.evaluate(node => node.open), false, 'mapping is closed on a fresh page');
        assert.equal(await mapping.evaluate(node => node.previousElementSibling?.id), 'fx-models', 'advanced mapping is immediately BELOW the catalog');
        assert.equal((await mapping.locator('summary').textContent()).trim(), 'Дополнительно - маппинг тиров');
        assert.doesNotMatch(await mapping.textContent(), /opus-only|все три тира смотрят в Opus|таких моделей на шлюзе нет/, 'obsolete mapping-only claims are removed');
        assert.equal(await select('opus').count(), 1);
        assert.equal(await select('sonnet').count(), 1);
        assert.equal(await select('haiku').count(), 1);
        assert.equal(await select('opus').isVisible(), false);
        await page.locator('#fx-models').scrollIntoViewIfNeeded();
        await page.waitForTimeout(800);
        await page.evaluate(() => {
            const r = document.getElementById('fx-models').getBoundingClientRect();
            window.scrollBy({ top: r.top - 30, behavior: 'instant' });
        });
        await page.screenshot({ path: path.join(out, 'closed-' + width + '.png') });
        const beforeOpen = mutateCount();
        await mapping.locator('summary').click();
        assert.equal(await select('opus').isVisible(), true);
        assert.equal(mutateCount(), beforeOpen, 'opening advanced mapping must not write');
        assert.equal(await mapping.locator('button[onclick="loadFxModels(false)"]').count(), 1, 'existing mapping refresh is preserved');
        await page.waitForTimeout(800); // Tailwind runtime compiler is deliberately throttled by the real page.
        const layout = await page.evaluate(() => {
            const card = document.getElementById('fx-models'), header = card.firstElementChild, advanced = document.getElementById('fx-modelmap');
            const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
            return { viewport: innerWidth, card: rect(card), header: rect(header), headerChildren: [...header.children].map(rect),
                advanced: rect(advanced), controls: [...advanced.querySelectorAll('select, button')].map(rect) };
        });
        assert.ok(layout.headerChildren.every(r => r.right <= layout.card.right + 1), 'catalog header actions fit the card on desktop/mobile');
        assert.ok(layout.controls.every(r => r.width > 0 && r.left >= layout.advanced.left && r.right <= layout.advanced.right + 1), 'advanced controls fit the card');
        await mapping.scrollIntoViewIfNeeded();
        await page.evaluate(() => {
            const r = document.getElementById('fx-models').getBoundingClientRect();
            window.scrollBy({ top: r.top - 30, behavior: 'instant' });
        });
        await page.screenshot({ path: path.join(out, 'open-' + width + '.png') });
        await mapping.screenshot({ path: path.join(out, 'advanced-card-' + width + '.png') });
        checkpoint('markup', { layout, values: await readValues(), mutations: mutateCount() });
        if (phase === 'markup') return;

        await select('sonnet').selectOption('fixture/draft-target');
        const beforeRefresh = count('/__switch/api/fx/models');
        await mapping.locator('button[onclick="loadFxModels(false)"]').click();
        await page.waitForFunction(value => document.getElementById('fx-models-list')?.textContent.includes(value), 'fixture/draft-target');
        await page.waitForTimeout(200);
        assert.ok(count('/__switch/api/fx/models') > beforeRefresh, 'ordinary refresh invokes real catalog loading');
        assert.equal(await select('sonnet').inputValue(), 'fixture/draft-target', 'ordinary catalog refresh preserves an unsaved changed tier');
        assert.equal(await mapping.evaluate(node => node.open), true, 'ordinary refresh preserves disclosure open state');
        assert.equal(mutateCount(), beforeOpen, 'refresh does not save or select');
        checkpoint('ordinary-refresh', { values: await readValues() });
        if (phase === 'refresh') return;

        catalog = catalog.filter(model => model.id !== 'fixture/draft-target');
        saved = { opus: 'fixture/new-saved-outside-catalog', sonnet: 'fixture/sonnet', haiku: 'fixture/new-haiku-outside-catalog' };
        await page.evaluate(async () => { await loadFxModels(false); await loadFxModelMap(); });
        await page.waitForFunction(() => document.getElementById('fx-mm-haiku')?.value === 'fixture/new-haiku-outside-catalog');
        assert.deepEqual(await readValues(), { ...saved, sonnet: 'fixture/draft-target' }, 'dirty missing target survives; untouched tiers follow authoritative saved map');
        const missingOption = select('sonnet').locator('option[value="fixture/draft-target"]');
        assert.equal(await missingOption.count(), 1, 'dirty target outside catalog remains an option');
        assert.equal(await select('opus').locator('option:checked').textContent(), saved.opus, 'current saved target outside catalog stays visibly selected');
        assert.equal(await select('sonnet').locator('option:checked').textContent(), 'fixture/draft-target', 'dirty missing target stays visibly selected');
        await page.evaluate(async () => { await renderFxModels(state.fxModels); await renderFxModelMap(); });
        assert.deepEqual(await readValues(), { ...saved, sonnet: 'fixture/draft-target' }, 'repeated catalog and modelmap rerenders retain dirty values');
        await page.evaluate(async () => { await loadFxSessions(false); });
        await page.waitForTimeout(300);
        assert.deepEqual(await readValues(), { ...saved, sonnet: 'fixture/draft-target' }, 'session refresh does not discard draft');
        assert.equal(await mapping.evaluate(node => node.open), true);
        await page.locator('.nav-btn[data-tab="claude"]').click();
        await page.locator('.nav-btn[data-tab="fxqidian"]').click();
        assert.deepEqual(await readValues(), { ...saved, sonnet: 'fixture/draft-target' }, 'tab return preserves draft');
        checkpoint('missing-target-and-session-refresh', { values: await readValues() });

        const mainBeforeSave = activeModel;
        const expectedSave = await readValues();
        await page.evaluate(() => { state.toastLog = []; });
        await save();
        assert.deepEqual(requests.findLast(r => r.path === '/__switch/api/fx/modelmap' && r.method === 'POST').body, expectedSave, 'Save payload exactly matches current tier values');
        assert.equal(saved.sonnet, 'fixture/draft-target', 'explicit Save uses preserved values');
        assert.equal(activeModel, mainBeforeSave, 'tier Save does not switch main model');
        saved = { ...saved, sonnet: 'fixture/sonnet' };
        await page.evaluate(async () => { await loadFxModelMap(); });
        assert.equal(await select('sonnet').inputValue(), 'fixture/sonnet', 'successful save reconciles draft: untouched subsequent refresh follows server');
        await select('haiku').selectOption('fixture/haiku');
        saveMode = 'failure';
        await page.evaluate(() => { state.toastLog = []; });
        await save();
        await page.evaluate(async () => { await loadFxModelMap(); await renderFxModels(state.fxModels); });
        assert.equal(await select('haiku').inputValue(), 'fixture/haiku', 'failed Save retains unsaved value through rerender');
        assert.equal(saved.haiku, 'fixture/new-haiku-outside-catalog', 'failed Save does not pretend server map changed');
        assert.equal(activeModel, mainBeforeSave);
        await mapping.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, 'failed-save-' + width + '.png') });
        checkpoint('save-success-and-failure', { values: await readValues(), saved: { ...saved }, mainModel: activeModel });

        await select('opus').selectOption('');
        await mapping.locator('summary').click();
        const beforeClosedRefresh = mutateCount();
        await page.evaluate(async () => { await loadFxSessionsLight(); await loadFxModelMap(); await renderFxModels(state.fxModels); });
        assert.equal(await select('opus').inputValue(), '', 'an explicitly cleared dirty tier remains empty after refresh');
        assert.equal(await select('haiku').inputValue(), 'fixture/haiku', 'closed refresh retains other dirty tiers');
        assert.equal(await mapping.evaluate(node => node.open), false, 'refresh does not reopen a closed disclosure');
        assert.equal(mutateCount(), beforeClosedRefresh, 'closed refresh does not write');
        await mapping.locator('summary').click();
        checkpoint('empty-draft-and-closed-refresh', { values: await readValues() });

        const chip = page.locator('#fx-models-list [data-publication-chip="fxqidian/fixture/sonnet"]');
        assert.equal(await chip.count(), 1, 'catalog keeps publication wrapper');
        const copyBefore = mutateCount();
        await chip.locator('button[title^="Копировать"]').click();
        await page.waitForFunction(() => window.__fxCopied.length === 1);
        assert.deepEqual(await page.evaluate(() => window.__fxCopied), ['/model fixture/sonnet[1m]'], 'existing exact provider model clipboard behavior');
        assert.equal(mutateCount(), copyBefore, 'copy is not tier save, model select or publication');
        await chip.locator('[onclick^="fxSelectModel"]').click();
        await page.waitForFunction(() => state.fxActiveModel === 'fixture/sonnet');
        const selection = requests.findLast(r => r.path === '/__switch/api/fx/set-model');
        assert.deepEqual(selection.body, { model: 'fixture/sonnet', modelMap: saved }, 'main model selection still sends saved server map, not unsaved draft');
        await page.waitForTimeout(200);
        assert.equal(await select('haiku').inputValue(), 'fixture/haiku', 'model selection rerender preserves tier draft');
        assert.equal(await mapping.evaluate(node => node.open), true);
        checkpoint('main-catalog-select-copy-separation', { selection, draft: await readValues() });

        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(value => document.getElementById('fx-mm-haiku')?.value === value, saved.haiku);
        assert.equal(await mapping.evaluate(node => node.open), false, 'F5 restores the default closed disclosure');
        assert.deepEqual(await readValues(), saved, 'F5 discards only unsaved UI draft and reloads saved map');
        assert.equal(activeModel, 'fixture/sonnet');
        assert.equal(violations.filter(v => v.width === width).length, 0);
        assert.equal(requests.filter(r => r.method !== 'GET').length, 3, 'only two explicit tier saves and one explicit main-model selection write');
        assert.deepEqual(errors.filter(error => error.width === width), [], 'no uncaught real dashboard browser errors');
        checkpoint('F5', { values: await readValues(), requests, mainModel: activeModel });
    } catch (error) {
        await page.screenshot({ path: path.join(out, 'failure-' + width + '.png') }).catch(() => {});
        checkpoint('failure', { message: error.message, requests, values: await readValues() });
        throw error;
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const width of [1440, 393]) {
            try { await scenario(browser, width); passed++; console.log('PASS Fxqidian ' + phase + ' real-source whole-flow width=' + width); }
            catch (error) { failed++; console.error('FAIL Fxqidian ' + phase + ' width=' + width + '\n' + error.stack); }
        }
    } finally {
        await browser.close();
        fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ phase, passed, failed, compiledInlineScripts: compiled,
            observations, errors, blocked, violations, scope: 'real-source UI; intercepted APIs; no live provider or production writes' }, null, 2) + '\n');
    }
    console.log('check-fx-advanced-modelmap: ' + passed + ' passed, ' + failed + ' failed');
    console.log('evidence: ' + out);
    process.exitCode = failed || violations.length || errors.length ? 1 : 0;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
