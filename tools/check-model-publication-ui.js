#!/usr/bin/env node
'use strict';
// Browser fixtures exercise the real dashboard and local assets. No live hub or
// provider is contacted; backend transaction acceptance is a separate test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const routing = path.join(root, 'routing');
const html = fs.readFileSync(process.env.PUBLICATION_DASH || path.join(routing, 'proxy-dashboard.html'), 'utf8');
const scratch = process.env.HERMES_TEST_SCRATCH || 'C:/Users/WormAlien/AppData/Local/hermes/cache/scratch';
fs.mkdirSync(scratch, { recursive: true });
const out = fs.mkdtempSync(path.join(scratch, 'model-publication-ui-'));
const origin = 'http://127.0.0.1:45321';
const observations = [], errors = [], unexpected = [];
let passed = 0, failed = 0;

async function scenario(browser, width) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const models = [
        { id: 'gpt-5.6-sol', supported_endpoint_types: ['openai'] },
        { id: 'gpt-6.1-sol', supported_endpoint_types: ['openai'] },
    ];
    const publications = new Map([['agentrouter/gpt-5.6-sol', {
        id: 'agentrouter/gpt-5.6-sol', provider: 'agentrouter', model: 'gpt-5.6-sol', published: true,
        displayName: 'Preserved fixture label', claudeBehavesAs: 'claude-sonnet-5',
        contextTokens: 200000, outputTokens: 24000, publishedAt: '2026-11-20T00:00:00.000Z',
        health: { state: 'unknown' }, catalog: { present: true, source: 'live' },
    }]]);
    let revision = 7, mode = 'success';
    const requests = [];
    const state = () => ({ ok: true, canWrite: true, providers: ['agentrouter', 'gorouter', 'gemini', 'a6api'],
        manifest: { version: 1, revision, enabled: true }, models: [...publications.values()], candidatesLoaded: false,
        public: { anthropicBaseUrl: origin, openaiBaseUrl: origin + '/openai/v1' } });
    const sessions = [{ id: 'fixture-ar', name: 'Browser fixture', email: 'fixture@example.test',
        api_key: 'fixture-key-not-a-secret', active: true, status: 'live', balance: 25, grant: 25 }];
    await context.addInitScript(() => {
        if (!localStorage.getItem('opencode_active_tab')) localStorage.setItem('opencode_active_tab', 'claude');
        window.__copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: async text => window.__copied.push(text) } });
    });
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== origin) { unexpected.push(url.origin); return route.abort('blockedbyclient'); }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        if (url.pathname.startsWith('/vendor/')) {
            const file = path.resolve(routing, 'vendor', url.pathname.slice('/vendor/'.length));
            if (file.startsWith(path.resolve(routing, 'vendor') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                const ext = path.extname(file);
                return route.fulfill({ contentType: ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'font/woff2', body: fs.readFileSync(file) });
            }
        }
        let body = { ok: false }, status = 404;
        if (url.pathname === '/__switch/api/status') {
            body = { current: 'agentRouter',
                backends: { agentrouter: { label: 'AgentRouter', base_url: origin }, gorouter: { label: 'GoRouter', base_url: origin } }, oauth: {} }; status = 200;
        } else if (url.pathname === '/__switch/api/ar/sessions') { body = { ok: true, sessions }; status = 200; }
        else if (url.pathname === '/__switch/api/ar/models') { body = { ok: true, models }; status = 200; }
        else if (url.pathname === '/__switch/api/ar/active-model') { body = { ok: true, model: 'gpt-5.6-sol' }; status = 200; }
        else if (url.pathname === '/__switch/api/ar/modelmap') { body = { ok: true, modelMap: { opus: 'gpt-5.6-sol' } }; status = 200; }
        else if (url.pathname === '/__switch/api/go/sessions') { body = { ok: true, sessions: [] }; status = 200; }
        else if (url.pathname === '/__switch/api/go/active-model') { body = { ok: true, model: 'fixture-model' }; status = 200; }
        else if (url.pathname === '/__switch/api/svrtr/models') { body = { ok: true, models: [{ id: 'fixture-sr' }] }; status = 200; }
        else if (url.pathname === '/__switch/api/helpcoder/models') { body = { ok: true, models: [{ id: 'fixture-hc' }] }; status = 200; }
        else if (url.pathname === '/__switch/api/freemodel/models') { body = { ok: true, models: [{ id: 'fixture-fm', source: 'openai' }] }; status = 200; }
        else if (url.pathname === '/__switch/api/vyceai/models') { body = { ok: true, models: ['fixture-vy'] }; status = 200; }
        else if (url.pathname === '/__switch/api/a6api/state') {
            body = { ok: true, canWrite: true, configured: true, connected: true, prepared: true, selectedTokenId: 1, account: {},
                tokens: [{ id: 1, name: 'Fixture key', status: 1, unlimited: true }], models: ['fixture-a6'], modelMap: { default: 'fixture-a6', opus: 'fixture-a6', sonnet: 'fixture-a6', haiku: 'fixture-a6' } }; status = 200;
        } else if (url.pathname === '/__switch/api/a6api/models') { body = { ok: true, tokenId: 1, models: ['fixture-a6'] }; status = 200; }
        else if (url.pathname === '/__switch/api/gemini/list') {
            body = { ok: true, accounts: [{ email: 'fixture@example.test', enabled: true, quota: { models: ['fixture-gm'] } }], tiers: [], server: { up: true } }; status = 200;
        } else if (url.pathname === '/__switch/api/gemini/models') { body = { ok: true, models: ['fixture-gm'] }; status = 200; }
        else if (url.pathname === '/__switch/api/gemini/modelmap') { body = { ok: true, modelMap: { opus: 'fixture-gm' }, activeModel: 'fixture-gm' }; status = 200; }
        else if (url.pathname === '/__switch/api/gemini/active-model') { body = { ok: true, model: 'fixture-gm' }; status = 200; }
        else if (url.pathname === '/__switch/api/ar/keepalive/state') {
            const cfg = { hedgeMs: 20000, maxHedges: 0, maxAttempts: 3, preCommitMs: 10000, poolFallbackModel: '' };
            body = { ok: true, port: 45322, cfg, defaults: cfg, stats: {}, latency: {} }; status = 200;
        } else if (url.pathname === '/__switch/api/api-gateway') { body = state(); status = 200; requests.push({ method: 'GET', name: 'state' }); }
        else if (url.pathname === '/__switch/api/api-gateway/clients') {
            body = { claude: { status: 'managed-on-save' }, opencode: { status: 'current' }, hermes: { installed: true } }; status = 200;
        } else if (url.pathname === '/__switch/api/api-gateway/sidecar') { body = { status: 'ready', installed: true, verified: true }; status = 200; }
        else if (url.pathname === '/__switch/api/api-gateway/publication' && req.method() === 'POST') {
            const input = req.postDataJSON(); requests.push({ method: 'POST', name: 'publication', body: input });
            assert.deepEqual(Object.keys(input).sort(), ['expectedRevision', 'id', 'published']);
            if (mode === 'failure') { body = { ok: false, code: 'api_gateway_transaction_failed', error: 'fixture save failed' }; status = 500; }
            else if (mode === 'conflict') { revision++; body = { ok: false, code: 'api_gateway_revision_conflict', error: 'revision_conflict' }; status = 409; }
            else {
                assert.equal(input.expectedRevision, revision);
                if (input.published && !publications.has(input.id)) {
                    const slash = input.id.indexOf('/');
                    publications.set(input.id, { id: input.id, provider: input.id.slice(0, slash), model: input.id.slice(slash + 1), published: true,
                        displayName: input.id.slice(0, slash) + ' / ' + input.id.slice(slash + 1), claudeBehavesAs: 'claude-opus-5',
                        contextTokens: 1000000, outputTokens: 32000, publishedAt: '2026-11-23T00:00:00.000Z', health: { state: 'unknown' } });
                } else if (!input.published) publications.delete(input.id);
                revision++;
                body = { ok: true, manifest: state().manifest, model: { id: input.id, published: input.published },
                    opencode: mode === 'sync-failure' ? { ok: false, code: 'api_gateway_opencode_target_invalid' } : { ok: true, status: 'synced', changed: 3 } };
                status = 200;
            }
        } else if (url.pathname === '/__switch/api/api-gateway/opencode/sync' && req.method() === 'POST') {
            requests.push({ method: 'POST', name: 'retry-sync' }); body = { ok: true, changed: 3, status: 'synced' }; status = 200;
        } else if (url.pathname.endsWith('/set-model') && req.method() === 'POST') {
            requests.push({ method: 'POST', name: 'set-model' }); body = { ok: true, model: req.postDataJSON().model }; status = 200;
        }
        else if (url.pathname === '/__switch/api/ar/models' || url.pathname.startsWith('/__switch/api/ar/')) { body = { ok: true, runs: [], entries: [], shared: [] }; status = 200; }
        return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push({ width, error: e.message }));
    const toggle = id => page.locator((id.startsWith('agentrouter/') ? '#ar-models-list ' : '') + 'input[data-publication-id="' + id + '"]');
    try {
        await page.goto(origin + '/', { waitUntil: 'load' });
        await page.locator('.nav-btn[data-tab="agentrouter"]').click();
        await page.waitForFunction(() => document.getElementById('ar-models-list')?.textContent.includes('gpt-6.1-sol'));
        assert.equal(await toggle('agentrouter/gpt-6.1-sol').count(), 1, 'AgentRouter needs a separate API Gateway toggle beside each model');
        await page.waitForFunction(() => !document.querySelector('input[data-publication-id="agentrouter/gpt-6.1-sol"]').disabled);
        assert.equal(await toggle('agentrouter/gpt-5.6-sol').isChecked(), true);
        assert.equal(await toggle('agentrouter/gpt-6.1-sol').isChecked(), false);
        assert.equal(await toggle('agentrouter/gpt-6.1-sol').getAttribute('role'), 'switch');
        await page.locator('.nav-btn[data-tab="api-gateway"]').click();
        await page.waitForFunction(() => document.getElementById('api-gateway-root')?.textContent.includes('agentrouter/gpt-5.6-sol'));
        assert.equal(await page.locator('#api-gateway-root input[data-publication-id="agentrouter/gpt-5.6-sol"]').count(), 1, 'Gateway uses the same immediate switch outside Edit');
        await page.locator('.nav-btn[data-tab="agentrouter"]').click();
        await page.waitForFunction(() => !document.querySelector('input[data-publication-id="agentrouter/gpt-6.1-sol"]').disabled);
        await page.locator('#ar-models').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, 'before-' + width + '.png') });
        await toggle('agentrouter/gpt-6.1-sol').click();
        await page.waitForFunction(() => document.querySelector('input[data-publication-id="agentrouter/gpt-6.1-sol"]').checked && !document.querySelector('input[data-publication-id="agentrouter/gpt-6.1-sol"]').disabled);
        assert.equal(publications.has('agentrouter/gpt-6.1-sol'), true);
        assert.equal(requests.filter(r => r.name === 'set-model').length, 0, 'publishing must not activate or select a model');
        assert.equal(publications.get('agentrouter/gpt-5.6-sol').displayName, 'Preserved fixture label');
        const mutations = requests.filter(r => r.name === 'publication');
        assert.equal(mutations.length, 1, 'one click causes one publication');
        assert.equal(mutations[0].body.id, 'agentrouter/gpt-6.1-sol');
        const chip = page.locator('[data-publication-chip="agentrouter/gpt-6.1-sol"]');
        await chip.locator('button[title^="Копировать"]').click();
        assert.deepEqual(await page.evaluate(() => window.__copied), ['/model agentrouter/gpt-6.1-sol[1m]']);
        assert.equal(requests.filter(r => r.name === 'publication').length, 1, 'copy remains separate from publication');
        await page.locator('.nav-btn[data-tab="api-gateway"]').click();
        await page.waitForFunction(() => document.getElementById('api-gateway-root')?.textContent.includes('agentrouter/gpt-6.1-sol'));
        await page.locator('.nav-btn[data-tab="agentrouter"]').click();
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => !!document.querySelector('input[data-publication-id="agentrouter/gpt-6.1-sol"]')?.checked);
        assert.equal(await toggle('agentrouter/gpt-6.1-sol').isChecked(), true, 'F5 must read persisted publication');
        await page.waitForFunction(() => !document.querySelector('input[data-publication-id="agentrouter/gpt-6.1-sol"]').disabled);
        await toggle('agentrouter/gpt-6.1-sol').click();
        await page.waitForFunction(() => !document.querySelector('input[data-publication-id="agentrouter/gpt-6.1-sol"]').disabled);
        assert.equal(publications.has('agentrouter/gpt-6.1-sol'), false);
        mode = 'failure';
        await toggle('agentrouter/gpt-6.1-sol').click();
        await page.waitForFunction(() => !document.querySelector('input[data-publication-id="agentrouter/gpt-6.1-sol"]').disabled);
        assert.equal(await toggle('agentrouter/gpt-6.1-sol').isChecked(), false, 'failed write cannot look published');
        mode = 'conflict';
        await toggle('agentrouter/gpt-6.1-sol').click();
        await page.waitForFunction(() => !document.querySelector('input[data-publication-id="agentrouter/gpt-6.1-sol"]').disabled);
        assert.equal(await toggle('agentrouter/gpt-6.1-sol').isChecked(), false, 'conflict restores authoritative state');
        mode = 'sync-failure';
        await toggle('agentrouter/gpt-6.1-sol').click();
        await page.waitForFunction(() => document.querySelector('input[data-publication-id="agentrouter/gpt-6.1-sol"]').checked && !document.querySelector('input[data-publication-id="agentrouter/gpt-6.1-sol"]').disabled);
        assert.equal(publications.has('agentrouter/gpt-6.1-sol'), true, 'committed publication remains despite separate sync failure');
        await page.locator('#ar-models').scrollIntoViewIfNeeded();
        assert.match(await chip.textContent(), /OpenCode/, 'partial sync failure must be visible beside the model');
        await page.screenshot({ path: path.join(out, 'sync-failure-' + width + '.png') });
        mode = 'success';
        await chip.locator('[data-publication-retry]').click();
        await page.waitForFunction(() => !document.querySelector('[data-publication-chip="agentrouter/gpt-6.1-sol"] [data-publication-retry]'));
        assert.equal(requests.filter(r => r.name === 'retry-sync').length, 1);
        assert.equal(requests.filter(r => r.name === 'set-model').length, 0);
        await page.waitForFunction(() => document.querySelectorAll('#toasts > *').length === 0, null, { timeout: 25000 });
        await page.locator('#ar-models').scrollIntoViewIfNeeded();
        const layout = await page.evaluate(() => ({ viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
            chips: [...document.querySelectorAll('#ar-models-list [data-publication-chip]')].map(e => {
                const r = e.getBoundingClientRect(); return { id: e.dataset.publicationChip, left: r.left, right: r.right, width: r.width };
            }) }));
        assert.ok(layout.chips.every(c => c.width > 0 && c.right <= width), 'model and switch must fit the viewport');
        const header = await page.locator('#ar-models > div:first-child').evaluate(node => {
            const right = node.getBoundingClientRect().right;
            return { right, childRights: [...node.children].map(child => child.getBoundingClientRect().right) };
        });
        assert.ok(header.childRights.every(right => right <= header.right + 1), 'model header actions must stay inside the card');
        assert.equal(errors.filter(e => e.width === width).length, 0, 'whole-flow browser errors');
        await page.screenshot({ path: path.join(out, 'after-' + width + '.png') });
        await page.evaluate(() => { renderCunModels([{ id: 'fixture-cun' }]); renderOtModels([{ id: 'fixture-ot' }]); state.cdtModels = [{ id: 'fixture-cdt' }]; renderCdtModels(); });
        for (const id of ['cun/fixture-cun', 'ourtoken/fixture-ot', 'conduit/fixture-cdt']) {
            assert.equal(await toggle(id).count(), 1, 'secondary catalog publication: ' + id);
        }
        await page.evaluate(async () => {
            state.svrtr = [{ apiKey: 'fixture-local' }]; state.helpcoder = [{ apiKey: 'fixture-local' }];
            await loadSvrtrModels(true); await loadHelpcoderModels(true); await loadFmModels(true); await loadVyceaiModels(true);
        });
        for (const id of ['svrtr/fixture-sr', 'helpcoder/fixture-hc', 'fm_openai/fixture-fm', 'vyce_openai/fixture-vy']) {
            assert.equal(await toggle(id).count(), 1, 'copy-only catalog publication: ' + id);
        }
        await page.locator('.nav-btn[data-tab="a6api"]').click();
        await page.waitForFunction(() => document.getElementById('a6-model-default')?.textContent.includes('fixture-a6'));
        assert.equal(await toggle('a6api/fixture-a6').count(), 1, 'a6api uses the shared publication catalog once, not once per tier');
        await page.locator('.nav-btn[data-tab="gemini"]').click();
        await page.locator('button[onclick="GEMINI.showModels()"]', { hasText: 'модели и тиры' }).click();
        await page.waitForFunction(() => document.getElementById('gemini-root')?.textContent.includes('fixture-gm'));
        assert.equal(await toggle('gemini/fixture-gm').count(), 1, 'Gemini main catalog publication');
        observations.push({ width, layout, requests, finalIds: [...publications.keys()], scope: 'UI fixture, not provider inference' });
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const width of [1440, 390]) {
            try { await scenario(browser, width); passed++; console.log('PASS publication whole-flow, width=' + width); }
            catch (e) { failed++; console.error('FAIL publication whole-flow, width=' + width + '\n' + e.stack); }
        }
    } finally {
        await browser.close();
        fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ passed, failed, observations, errors, blockedOrigins: [...new Set(unexpected)], scope: 'intercepted real dashboard; no live requests' }, null, 2) + '\n');
    }
    console.log('check-model-publication-ui: ' + passed + ' passed, ' + failed + ' failed');
    console.log('evidence: ' + out);
    process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
