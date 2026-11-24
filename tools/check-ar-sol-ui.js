#!/usr/bin/env node
'use strict';

// Real dashboard/browser with local fixtures only. Backend policy is tested separately.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { test, after } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const ROUTING = path.join(ROOT, 'routing');
const SCRATCH = process.env.HERMES_TEST_SCRATCH || 'C:/Users/WormAlien/AppData/Local/hermes/cache/scratch';
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = SCRATCH;
fs.mkdirSync(SCRATCH, { recursive: true });
const RUN = fs.mkdtempSync(path.join(SCRATCH, 'ar-sol-ui-'));
const ORIGIN = 'http://127.0.0.1:45391';
const evidence = { run: RUN, scenarios: [] };
const SOL = ['gpt-6.1-sol', 'gpt-5.6-sol'];
const stage = process.env.AR_UI_STAGE || 'all';
let browser;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(width = 1440, legacyMap = false) {
    browser ||= await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const record = { width, requests: [], errors: [], external: [], screenshots: [] };
    evidence.scenarios.push(record);
    const session = { id: 'fixture-ar', name: 'Sol fixture', email: 'fixture@example.test',
        api_key: 'sk-fixture-ar-not-a-real-secret', active: true, status: 'live',
        balance: 42, granted: 100, balanceSource: 'self', balanceCheckedAt: new Date().toISOString() };
    const cfg = { hedgeMs: 20000, maxHedges: 0, maxAttempts: 3, preCommitMs: 10000,
        poolFallbackModel: 'deepseek-v4-flash', poolDeadMs: 900000 };
    let active = SOL[1];
    let modelMap = { opus: SOL[0], sonnet: SOL[1], haiku: SOL[1], gpt: '' };
    if (legacyMap) modelMap = { opus: 'gpt-6-astra', sonnet: 'gpt-6-astra', haiku: 'gpt-6-astra', gpt: '' };
    let mode = 'catalog';
    const publications = SOL.map(id => ({ id: 'agentrouter/' + id, provider: 'agentrouter', model: id,
        published: true, displayName: id, contextTokens: 1000000, outputTokens: 32000,
        claudeBehavesAs: 'claude-opus-5', health: { state: 'unknown' } }));
    await context.addInitScript(() => {
        if (!localStorage.getItem('opencode_active_tab')) localStorage.setItem('opencode_active_tab', 'claude');
        localStorage.setItem('ar-quota-state', JSON.stringify({ state: 'exhausted', checkedAt: new Date().toISOString() }));
        window.__copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: async text => window.__copied.push(text) } });
    });
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== ORIGIN) { record.external.push(url.origin); return route.abort('blockedbyclient'); }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8',
            body: fs.readFileSync(path.join(ROUTING, 'proxy-dashboard.html'), 'utf8') });
        if (url.pathname.startsWith('/vendor/')) {
            const file = path.resolve(ROUTING, 'vendor', url.pathname.slice('/vendor/'.length));
            if (file.startsWith(path.resolve(ROUTING, 'vendor') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                const ext = path.extname(file);
                return route.fulfill({ contentType: ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'font/woff2', body: fs.readFileSync(file) });
            }
        }
        const input = req.method() === 'POST' ? req.postDataJSON() : undefined;
        record.requests.push({ method: req.method(), path: url.pathname, query: url.search, body: input });
        let body = { ok: true }, status = 200;
        if (url.pathname === '/__switch/api/status') body = { current: 'agentRouter',
            backends: { agentrouter: { label: 'AgentRouter', base_url: ORIGIN } }, oauth: {} };
        else if (url.pathname === '/__switch/api/ar/sessions') body = { ok: true, sessions: [session] };
        else if (url.pathname === '/__switch/api/ar/models') {
            if (mode === 'error') { status = 503; body = { ok: false, note: 'fixture catalog unavailable' }; }
            else body = { ok: true, models: mode === 'empty' ? [] : [...SOL.map(id => ({ id, supported_endpoint_types: ['openai'] })),
                { id: 'gpt-6-astra' }, { id: 'claude-opus-5-5' }, { id: 'deepseek-v4-flash' }] };
        } else if (url.pathname === '/__switch/api/ar/active-model') body = { ok: true, model: active };
        else if (url.pathname === '/__switch/api/ar/set-model') { active = input.model; body = { ok: true, model: active }; }
        else if (url.pathname === '/__switch/api/ar/modelmap') {
            if (input) modelMap = input;
            body = { ok: true, modelMap };
        } else if (url.pathname === '/__switch/api/keepalive/state' || url.pathname === '/__switch/api/ar/keepalive/state')
            body = { ok: true, port: 45392, cfg, defaults: cfg, stats: {}, latency: {} };
        else if (url.pathname === '/__switch/api/keepalive/config') { Object.assign(cfg, input); body = { ok: true, cfg, defaults: cfg }; }
        else if (url.pathname.endsWith('/keepalive/latency')) body = { ok: true, points: [], window_sec: Number(url.searchParams.get('window') || 86400),
            now: Date.now(), total_all: 0, proxy_state: 'up', source: 'proxy' };
        else if (url.pathname === '/__switch/api/ar/checkin-config') body = { ok: true, checkin: { resetHhmmMsk: '20:30', bonusUsd: 25 } };
        else if (url.pathname === '/__switch/api/ar/checkin-events') body = { ok: true, seq: 1,
            events: url.searchParams.get('since') === '0' ? [{ t: new Date().toISOString(), kind: 'done', text: 'fixture check-in complete' }] : [] };
        else if (url.pathname === '/__switch/api/routes') body = { ok: true, providers: [{ name: 'agentrouter',
            gatewayTiers: modelMap, tiers: modelMap, pooldrop: { deadModel: 'gpt-6-astra', fallback: 'deepseek-v4-flash', droppedAt: new Date().toISOString() } }] };
        else if (url.pathname === '/__switch/api/api-gateway') body = { ok: true, canWrite: true, providers: ['agentrouter'],
            manifest: { version: 1, revision: 1, enabled: true }, models: publications, candidatesLoaded: false,
            public: { anthropicBaseUrl: ORIGIN, openaiBaseUrl: ORIGIN + '/openai/v1' } };
        else if (url.pathname === '/__switch/api/gemini/list') body = { ok: true, accounts: [], server: { up: true }, tiers: [] };
        else if (url.pathname === '/__switch/api/gemini/modelmap') body = { ok: true, modelMap: {}, activeModel: null };
        else if (url.pathname.includes('quota')) body = { ok: true, pools: {}, state: 'exhausted', tz: 'Asia/Shanghai', times: ['10:00', '19:00'] };
        else if (url.pathname.startsWith('/__switch/api/ar/')) body = { ok: true, source: 'direct', sources: ['direct'], entries: [], runs: [], shared: [] };
        else { body = { ok: false }; status = 404; }
        return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => record.errors.push(error.message));
    await page.goto(ORIGIN + '/', { waitUntil: 'load' });
    await page.locator('.nav-btn[data-tab="agentrouter"]').click();
    await page.waitForFunction(() => document.getElementById('ar-models-list')?.textContent.includes('gpt-6.1-sol'));
    await sleep(1200);
    return { context, page, record, setMode(value) { mode = value; }, modelMap: () => modelMap, active: () => active };
}

if (stage === 'all' || stage === 'retirement') test('AgentRouter loads without quota controls or quota requests', async () => {
    const f = await fixture();
    try {
        assert.equal(await f.page.locator('#arq-mini, #arq-big, #arq-sched, #ar-keepalive-pooldrop, #ar-keepalive-pooldrop-state').count(), 0,
            'quota clocks, schedule and fallback controls must be removed, not hidden');
        assert.equal(f.record.requests.filter(r => /\/ar\/quota/.test(r.path)).length, 0, 'loading must not poll legacy quota');
        for (const id of ['ar-energy', 'ar-checkin', 'ar-journal', 'ar-models', 'ar-keepalive', 'ar-list'])
            assert.equal(await f.page.locator('#' + id).count(), 1, 'preserve ' + id);
        assert.doesNotMatch(await f.page.locator('#ar-keepalive-status').innerText(), /фолбэк|пул/i,
            'AgentRouter summary must not advertise retired fallback from an old runtime');
        assert.deepEqual(f.record.errors, []);
    } finally { await f.context.close(); }
});

if (stage === 'all' || stage === 'models') test('AgentRouter shows only Sol from actual catalog and separates copy from selection', async () => {
    const f = await fixture();
    try {
        const list = f.page.locator('#ar-models-list');
        assert.doesNotMatch(await list.innerText(), /astra|claude-opus|deepseek/i, 'legacy cached models cannot reappear');
        assert.equal(await list.locator('[data-publication-chip]').count(), 2, 'preserve one publication control per Sol');
        await list.locator('[data-publication-chip="agentrouter/gpt-6.1-sol"] button[title^="Копировать"]').click();
        assert.deepEqual(await f.page.evaluate(() => window.__copied), ['/model agentrouter/gpt-6.1-sol[1m]']);
        assert.equal(f.record.requests.filter(r => r.path.endsWith('/set-model')).length, 0);
        await list.locator('[onclick^="arSelectModel"]').filter({ hasText: 'gpt-6.1-sol' }).click();
        await f.page.waitForFunction(() => document.querySelector('#ar-models-list .text-emerald')?.textContent.includes('gpt-6.1-sol'));
        assert.equal(f.active(), SOL[0]);
        assert.equal(f.record.requests.filter(r => r.path.endsWith('/set-model')).length, 1);
        f.setMode('empty');
        await f.page.evaluate(() => loadArModels(true));
        assert.match(await list.innerText(), /нет доступных Sol/i);
        assert.equal(await list.locator('[data-publication-chip]').count(), 0);
        f.setMode('error');
        await f.page.evaluate(() => loadArModels(true));
        assert.match(await list.innerText(), /ошибка.*каталог|каталог.*недоступен/i);
    } finally { await f.context.close(); }
});

if (stage === 'all' || stage === 'legacy') test('stale saved tiers require an explicit Sol choice without showing retired models', async () => {
    const f = await fixture(1440, true);
    try {
        const detail = f.page.locator('#ar-modelmap');
        await detail.locator('summary').click();
        assert.doesNotMatch(await detail.innerText(), /astra/i, 'retired models are not a visible choice or warning');
        await detail.locator('button[onclick="arSaveModelMap()"]').click();
        assert.equal(f.record.requests.filter(r => r.method === 'POST' && r.path === '/__switch/api/ar/modelmap').length, 0,
            'unavailable saved targets must not silently turn into an empty/default tier');
        assert.equal(f.modelMap().opus, 'gpt-6-astra', 'owner state remains untouched until an explicit choice');
        for (const tier of ['opus', 'sonnet', 'haiku']) await f.page.locator('#ar-mm-' + tier).selectOption(SOL[0]);
        await detail.locator('button[onclick="arSaveModelMap()"]').click();
        await f.page.waitForFunction(() => document.getElementById('toasts')?.textContent.includes('маппинг сохранён'));
        assert.equal(f.modelMap().opus, SOL[0]);
        assert.equal(f.active(), SOL[1]);
    } finally { await f.context.close(); }
});

if (stage === 'all' || stage === 'flow') for (const width of [1440, 393]) test('AgentRouter whole flow ' + width, async () => {
    const f = await fixture(width);
    try {
        const p = f.page, detail = p.locator('#ar-modelmap');
        assert.equal(await detail.evaluate(e => e.tagName), 'DETAILS');
        assert.equal(await detail.getAttribute('open'), null, 'client tier compatibility is advanced and collapsed');
        assert.equal(await p.locator('#ar-mm-opus').isVisible(), false);
        await detail.locator('summary').click();
        assert.equal(await p.locator('#ar-mm-opus').inputValue(), SOL[0]);
        await p.locator('#ar-mm-haiku').selectOption(SOL[0]);
        await detail.locator('button[onclick="arSaveModelMap()"], button[onclick="arSaveModelMap()" i]').click();
        await p.waitForFunction(() => document.getElementById('toasts')?.textContent.includes('маппинг сохранён'));
        assert.equal(f.modelMap().haiku, SOL[0]);
        assert.equal(f.active(), SOL[1], 'saving client tiers must not select a main model');
        await p.reload({ waitUntil: 'load' });
        await p.waitForFunction(() => document.getElementById('ar-models-list')?.textContent.includes('gpt-6.1-sol'));
        await p.waitForFunction(() => document.getElementById('ar-checkin')?.textContent.includes('Чек-ин')
            && document.getElementById('ar-journal')?.textContent.includes('Журнал')
            && document.getElementById('ar-list')?.textContent.includes('fixture@example'));
        await p.waitForFunction(() => !document.documentElement.classList.contains('tw-boot'));
        assert.equal(await detail.getAttribute('open'), null, 'F5 retains advanced default');
        assert.equal(await p.locator('#ar-models-list [data-publication-chip]').count(), 2);
        assert.match(await p.locator('#ar-checkin').innerText(), /Чек-ин/);
        assert.match(await p.locator('#ar-journal').innerText(), /Журнал/);
        assert.match(await p.locator('#ar-list').innerText(), /Sol fixture|fixture@example/);
        assert.doesNotMatch(await p.locator('[data-tab-content="agentrouter"]').innerText(), /astra|расписание партий|сброса квоты|пул пуст/i);
        await p.locator('#ar-keepalive').scrollIntoViewIfNeeded();
        const statusWidth = await p.locator('#ar-keepalive-status').evaluate(e => e.getBoundingClientRect().width);
        assert.ok(statusWidth >= 250, 'keepalive summary must be a readable full row, not a squeezed column');
        await p.waitForFunction(() => document.querySelectorAll('#toasts > *').length === 0, null, { timeout: 25000 });
        await p.locator('[data-tab-content="agentrouter"] header').scrollIntoViewIfNeeded();
        const headerShot = path.join(RUN, `${width}-ar-header.png`);
        await p.screenshot({ path: headerShot });
        f.record.screenshots.push(headerShot);
        for (const id of ['ar-energy', 'ar-checkin', 'ar-journal', 'ar-models', 'ar-keepalive', 'ar-list']) {
            await p.locator('#' + id).scrollIntoViewIfNeeded();
            await sleep(850);
            const shot = path.join(RUN, `${width}-${id}.png`);
            await p.screenshot({ path: shot });
            f.record.screenshots.push(shot);
        }
        const tableScroll = await p.locator('#ar-list').evaluate(e => {
            e.scrollLeft = e.scrollWidth;
            return { left: e.scrollLeft, width: e.clientWidth, total: e.scrollWidth };
        });
        if (width < 600 && tableScroll.total > tableScroll.width) assert.ok(tableScroll.left > 0, 'wide account table remains horizontally navigable');
        const accountShot = path.join(RUN, `${width}-ar-list-actions.png`);
        await p.screenshot({ path: accountShot });
        f.record.screenshots.push(accountShot);
        await p.locator('#ar-list').evaluate(e => { e.scrollLeft = Math.max(0, (e.scrollWidth - e.clientWidth) / 2); });
        const balanceShot = path.join(RUN, `${width}-ar-list-balance.png`);
        await p.screenshot({ path: balanceShot });
        f.record.screenshots.push(balanceShot);
        const summary = await p.locator('[data-tab-content="agentrouter"]').innerText();
        assert.doesNotMatch(summary, /NaN|base.*claude-\*/i, 'old provider footer and invalid fixture metric cannot be accepted');
        const layout = await p.locator('#ar-models').evaluate(e => ({ right: e.getBoundingClientRect().right, viewport: innerWidth }));
        assert.ok(layout.right <= width, 'model controls fit viewport');
        assert.equal(f.record.requests.filter(r => /\/ar\/quota|\/routes\/pool-(drop|restore)/.test(r.path)).length, 0);
        assert.deepEqual(f.record.errors, []);
        assert.ok(f.record.external.every(origin => origin === 'https://www.cbr-xml-daily.ru'),
            'only the unrelated FX fetch may be attempted; every external request is aborted');
    } catch (error) {
        f.record.failure = { message: error.message, state: await f.page.evaluate(() => ({
            tab: localStorage.getItem('opencode_active_tab'),
            active: [...document.querySelectorAll('[data-tab-content].active')].map(e => e.dataset.tabContent),
            checkinText: document.getElementById('ar-checkin')?.textContent,
            checkinDisplay: getComputedStyle(document.querySelector('[data-tab-content="agentrouter"]')).display,
        })) };
        const shot = path.join(RUN, width + '-failure.png');
        await f.page.screenshot({ path: shot });
        f.record.screenshots.push(shot);
        console.log(JSON.stringify(f.record.failure));
        throw error;
    } finally { await f.context.close(); }
});

after(async () => {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(RUN, 'receipt.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log('Evidence: ' + RUN);
});
