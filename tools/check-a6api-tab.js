#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const file = path.join(root, 'routing/vendor/a6api-tab.js');
const model = 'deepseek-v4.1-flash-1017';
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; } }
function fixture() {
    const els = new Map(), calls = [], handlers = {};
    function el(id) {
        if (!els.has(id)) {
            const listeners = {};
            els.set(id, { id, innerHTML: '', textContent: '', value: '', disabled: false, hidden: false, dataset: {},
                addEventListener(name, fn) { listeners[name] = fn; },
                emit(name, event) { return listeners[name]?.(event || { target: this }); },
                querySelectorAll: () => [], querySelector: () => null,
                classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, focus() {} });
        }
        return els.get(id);
    }
    const rows = [{ channelId: 7, listingId: 70, supplierId: 9, supplier: '<img src=x onerror=alert(1)>', channel: 'one', model,
        inputUsd: .001176, outputUsd: .004704, cacheUsd: .00003,
        prices: { input_price_micros: 1176, output_price_micros: 4704, cache_read_price_micros: 30, cache_write_price_micros: null, per_request_price_micros: 0 },
        success24h: null, recentSuccess: 100, samples: 100, rating: null, reviews: 0, ttftMs: 2000, available: true },
    { channelId: 8, listingId: 80, supplierId: 10, supplier: 'Reserve', channel: 'two', model, inputUsd: .014, outputUsd: .056,
        prices: { input_price_micros: 14000, output_price_micros: 56000, cache_read_price_micros: 100, cache_write_price_micros: 0, per_request_price_micros: null },
        success24h: 99.7, recentSuccess: 100, samples: 100, rating: 5, reviews: 1, available: true }];
    const state = { ok: true, canWrite: true, models: [model, 'another'], account: { balanceUsd: 5.58 },
        tokens: [{ id: 9, name: 'deepseek', mask: 'hidden', status: 1, unlimited: true, spentUsd: .000012, expires: -1, restricted: true, models: [model] }] };
    const modelData = { ok: true, canWrite: true, catalog: { items: rows, total: 2, stale: true }, probes: {},
        route: { id: 1, version: 2, strategy: 'price_asc', caps: { input_price_micros: 1176, output_price_micros: 4704 }, channels: [{ channelId: 7 }] } };
    const window = { toast() {}, confirm: () => false };
    const ctx = { window, document: { readyState: 'complete', getElementById: el, querySelector: () => null, addEventListener() {} },
        console, URL, URLSearchParams, Date, JSON, Set, Map, Intl, Promise, clearTimeout, setTimeout,
        navigator: { clipboard: { writeText: async () => {} } },
        fetch: async (url, options = {}) => {
            const u = new URL(url, 'http://fixture.invalid');
            const name = u.pathname.split('/').pop();
            const call = { url, name, params: u.searchParams, method: options.method || 'GET', body: options.body && JSON.parse(options.body) };
            calls.push(call);
            const d = handlers[name] ? await handlers[name](call)
                : name === 'state' ? state : name === 'logs' ? { ok: true, total: 0, items: [] }
                : name === 'reviews' ? { ok: true, items: [] }
                : name === 'route' ? { ok: true, route: { ...modelData.route, ...call.body, version: 3, channels: call.body.channels.map(channelId => ({ channelId })) } }
                : name === 'enable-model' ? { ok: true } : modelData;
            return { ok: d.ok !== false, status: d.ok === false ? 409 : 200, json: async () => clone(d) };
        } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx);
    const tab = window.A6API;
    const input = (id, value) => { el(id).value = value; return el(id).emit('input'); };
    const select = (id, value) => { el(id).value = value; return el(id).emit('change'); };
    const click = async (action, data = {}) => {
        el('a6api-root').emit('click', { target: { closest: () => ({ disabled: false, dataset: { a6: action, ...data } }) } });
        await tick();
    };
    return { el, calls, handlers, rows, state, modelData, window, tab, input, select, click };
}
(async () => {
    await test('load selects a model without writes or paid probes', async () => {
        const f = fixture(); await f.tab.load();
        assert.ok(f.calls.length >= 2); assert.ok(f.calls.every(x => x.method === 'GET'));
        assert.ok(!f.calls.some(x => /completions|probe/.test(x.url)));
    });
    await test('seller text is escaped and missing telemetry stays unknown', async () => {
        const f = fixture(); await f.tab.load(); const html = f.el('a6-sellers').innerHTML;
        assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;img'));
        assert.ok(html.includes('нет данных')); assert.ok(html.includes('нет отзывов'));
        assert.ok(html.includes('0.001176')); assert.ok(html.includes('100'));
        assert.ok(f.el('a6-key-info').innerHTML.includes('$5.58'));
        assert.ok(f.el('a6-key-info').innerHTML.includes('$0.000012'));
    });
    await test('manual strategy immediately renders priority controls', async () => {
        const f = fixture(); await f.tab.load(); f.tab.toggleChannel(8, true);
        f.input('a6-strategy', 'user_priority_desc');
        assert.match(f.el('a6-pool').innerHTML, /data-a6="up"/);
        await f.click('up', { id: '8' });
        assert.ok(f.el('a6-pool').innerHTML.indexOf('Reserve') < f.el('a6-pool').innerHTML.indexOf('&lt;img'));
        assert.ok(f.calls.every(x => x.method === 'GET'));
    });
    await test('persisted manual priority is restored descending with stable ties', async () => {
        const f = fixture();
        f.modelData.route.strategy = 'user_priority_desc';
        f.modelData.route.channels = [{ channelId: 7, priority: 1 }, { channelId: 8, priority: 10 }, { channelId: 11, priority: 10, supplier: 'Tied seller' }];
        await f.tab.load();
        const pool = f.el('a6-pool').innerHTML;
        assert.ok(pool.indexOf('Reserve') < pool.indexOf('Tied seller'));
        assert.ok(pool.indexOf('Tied seller') < pool.indexOf('&lt;img'));
        assert.ok(f.calls.every(x => x.method === 'GET'));
    });
    await test('refresh preserves an unsaved pool, strategy, caps and confirmed prices', async () => {
        const f = fixture(); await f.tab.load(); f.tab.toggleChannel(8, true);
        f.input('a6-strategy', 'user_priority_desc'); f.input('a6-input-cap', '0.02');
        const prices = clone(f.rows[1].prices); f.modelData.catalog.items[1].prices.input_price_micros = 50000;
        await f.tab.load();
        assert.ok(f.el('a6-pool').innerHTML.includes('Reserve')); assert.match(f.el('a6-draft-status').textContent, /Не сохранено/);
        assert.equal(f.el('a6-strategy').value, 'user_priority_desc'); assert.equal(Number(f.el('a6-input-cap').value), .02);
        f.window.confirm = () => true; await f.tab.save();
        assert.deepEqual(f.calls.find(x => x.name === 'route').body.confirmedPrices[8], prices);
    });
    await test('cancelled confirmation sends neither route nor enable nor reveal', async () => {
        const f = fixture(); await f.tab.load(); f.tab.toggleChannel(8, true);
        await f.tab.save(); await f.click('copy-key');
        await f.select('a6-model', 'another'); await f.click('enable');
        assert.ok(f.calls.every(x => x.method === 'GET'));
    });
    await test('route editors and selection are disabled while a write is pending', async () => {
        const f = fixture(); await f.tab.load(); f.tab.toggleChannel(8, true);
        f.input('a6-strategy', 'user_priority_desc'); f.window.confirm = () => true;
        const pending = deferred(); f.handlers.route = () => pending.promise;
        const saving = f.tab.save();
        try {
            for (const id of ['a6-token', 'a6-model', 'a6-strategy', 'a6-input-cap', 'a6-output-cap']) assert.equal(f.el(id).disabled, true, id);
            f.input('a6-input-cap', '99');
            assert.match(f.el('a6-pool').innerHTML, /data-a6="down"[^>]*disabled/);
        } finally { pending.resolve({ ok: true, route: f.modelData.route }); await saving; }
    });
    await test('invalid model input restores the actual selected model', async () => {
        const f = fixture(); await f.tab.load(); const n = f.calls.length;
        await f.select('a6-model', 'unknown-model');
        assert.equal(f.el('a6-model').value, model); assert.equal(f.el('a6-error').hidden, false);
        assert.equal(f.calls.length, n);
    });
    await test('refresh after token removal never reuses its dirty draft for another token', async () => {
        const f = fixture(); await f.tab.load(); f.tab.toggleChannel(8, true);
        const original = clone(f.state.tokens[0]); f.state.tokens = [{ ...original, id: 10, name: 'other' }];
        await f.tab.load();
        assert.ok(!f.el('a6-pool').innerHTML.includes('Reserve'), 'old token draft was shown on new token');
        assert.equal(f.el('a6-save').disabled, true);
        f.state.tokens.push(original); await f.tab.load(); await f.select('a6-token', '9');
        assert.ok(f.el('a6-pool').innerHTML.includes('Reserve'), 'old token draft was lost');
    });
    await test('refresh after model removal preserves the draft only for its original model', async () => {
        const f = fixture(); await f.tab.load(); f.tab.toggleChannel(8, true);
        f.state.models = ['another']; await f.tab.load();
        assert.ok(!f.el('a6-pool').innerHTML.includes('Reserve'));
        f.state.models.push(model); await f.tab.load(); await f.select('a6-model', model);
        assert.ok(f.el('a6-pool').innerHTML.includes('Reserve'));
    });
    await test('selection loading clears stale data and disables old route controls', async () => {
        const f = fixture(); await f.tab.load(); const pending = deferred(); f.handlers.model = () => pending.promise;
        const selecting = f.select('a6-model', 'another');
        try {
            assert.equal(f.el('a6-strategy').disabled, true);
            assert.ok(!f.el('a6-sellers').innerHTML.includes('Reserve'));
            assert.ok(!f.el('a6-pool').innerHTML.includes('#7'));
        } finally { pending.resolve(f.modelData); await selecting; }
    });
    await test('out-of-order model responses cannot replace the newest selection', async () => {
        const f = fixture(); await f.tab.load(); f.tab.toggleChannel(8, true);
        const pending = deferred(); f.handlers.model = c => c.params.get('model') === 'another' ? pending.promise : f.modelData;
        const older = f.select('a6-model', 'another'); await f.select('a6-model', model);
        pending.resolve({ ...f.modelData, catalog: { items: [], total: 0 } }); await older;
        assert.equal(f.el('a6-model').value, model); assert.ok(f.el('a6-pool').innerHTML.includes('Reserve'));
        assert.ok(f.el('a6-sellers').innerHTML.includes('Reserve'));
    });
    await test('a stale log error cannot overwrite the current model journal', async () => {
        const f = fixture(); await f.tab.load(); const pending = deferred();
        f.handlers.logs = c => c.params.get('model') === model ? pending.promise : { ok: true, items: [{ channelId: 80, at: 1720000000, input: 4, output: 2, usd: .000001 }] };
        await f.click('logs'); await f.select('a6-model', 'another');
        pending.reject(new Error('old-model-failure')); await tick();
        assert.match(f.el('a6-log-rows').innerHTML, /#80/); assert.ok(!f.el('a6-log-rows').innerHTML.includes('old-model-failure'));
    });
    await test('enable failure remains visible instead of being cleared by refresh', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model', 'another'); f.window.confirm = () => true;
        f.handlers['enable-model'] = () => ({ ok: false, error: 'enable-denied' });
        await f.click('enable');
        assert.equal(f.el('a6-error').hidden, false); assert.match(f.el('a6-error').textContent, /enable-denied/);
        assert.equal(f.calls.filter(x => x.name === 'enable-model').length, 1);
    });
    await test('no remaining tokens clears stale routes and usage without null-ID requests', async () => {
        const f = fixture(); await f.tab.load(); f.state.tokens = []; const n = f.calls.length; await f.tab.load();
        assert.ok(!f.el('a6-sellers').innerHTML.includes('Reserve'));
        assert.ok(!f.el('a6-pool').innerHTML.includes('#7')); assert.equal(f.el('a6-save').disabled, true);
        await f.click('logs');
        assert.ok(f.calls.slice(n).every(x => !/tokenId=(null|0|undefined)/.test(x.url)));
        assert.match(f.el('a6-key-info').innerHTML, /Создайте ключ/);
    });
    await test('review responses are scoped to the latest requested listing', async () => {
        const f = fixture(); await f.tab.load(); const pending = deferred();
        f.handlers.reviews = c => c.params.get('listingId') === '70' ? pending.promise : { ok: true, items: [{ rating: 5, text: 'latest-listing', user: 'anon' }] };
        await f.click('reviews', { id: '70' }); await f.click('reviews', { id: '80' });
        pending.resolve({ ok: true, items: [{ rating: 1, text: 'stale-listing', user: 'anon' }] }); await tick();
        assert.match(f.el('a6-review-items').innerHTML, /latest-listing/);
        assert.ok(!f.el('a6-review-items').innerHTML.includes('stale-listing'));
    });
    await test('empty model catalog hides enable and leaves no writable route', async () => {
        const f = fixture(); await f.tab.load(); f.state.models = []; await f.tab.load();
        assert.equal(f.el('a6-model').value, ''); assert.equal(f.el('a6-model').disabled, true);
        assert.equal(f.el('a6-enable').hidden, true); assert.equal(f.el('a6-save').disabled, true);
        f.window.confirm = () => true; const n = f.calls.length; await f.click('enable');
        assert.equal(f.calls.length, n);
    });
    await test('model failure remains visible without retry or stale seller data', async () => {
        const f = fixture(); await f.tab.load(); f.tab.toggleChannel(8, true);
        f.handlers.model = () => ({ ok: false, error: 'fixture-model-failed' }); const n = f.calls.length;
        await f.select('a6-model', 'another');
        assert.equal(f.el('a6-error').hidden, false); assert.match(f.el('a6-error').textContent, /fixture-model-failed/);
        assert.ok(!f.el('a6-sellers').innerHTML.includes('Reserve')); assert.equal(f.el('a6-save').disabled, true);
        assert.equal(f.calls.slice(n).filter(x => x.name === 'model').length, 1);
        delete f.handlers.model; await f.select('a6-model', model);
        assert.ok(f.el('a6-pool').innerHTML.includes('Reserve'));
    });
    await test('failed save retains edits and does not retry a possibly accepted write', async () => {
        const f = fixture(); await f.tab.load(); f.tab.toggleChannel(8, true); f.window.confirm = () => true;
        f.handlers.route = () => ({ ok: false, error: 'readback-unavailable', writeAccepted: true });
        await f.tab.save();
        assert.equal(f.calls.filter(x => x.name === 'route').length, 1);
        assert.match(f.el('a6-error').textContent, /readback-unavailable/);
        assert.match(f.el('a6-error').textContent, /Запись была принята/);
        assert.match(f.el('a6-draft-status').textContent, /Не сохранено/);
        assert.ok(f.el('a6-pool').innerHTML.includes('Reserve'));
    });
    await test('read-only clients cannot save a draft or reveal a key', async () => {
        const f = fixture(); f.state.canWrite = false; f.modelData.canWrite = false; await f.tab.load();
        f.window.confirm = () => true; f.tab.toggleChannel(8, true); await f.tab.save(); await f.click('copy-key');
        assert.equal(f.el('a6-save').disabled, true); assert.equal(f.el('a6-local').hidden, false);
        assert.ok(f.calls.every(x => x.method === 'GET'));
    });
    await test('HTML registers sidebar, visibility, refresh and module assets', () => {
        const html = fs.readFileSync(path.join(root, 'routing/proxy-dashboard.html'), 'utf8');
        assert.ok(html.includes('data-tab="a6api"')); assert.ok(html.includes('id="a6api-root"'));
        assert.match(html, /const DEFAULT_TABS_VISIBLE = \[[^;]*'a6api'/);
        assert.ok(html.includes('a6api-tab.js')); assert.ok(html.includes('a6api-tab.css'));
        assert.ok(html.includes("name === 'a6api'")); assert.ok(html.includes("case 'a6api':"));
        const backend = fs.readFileSync(path.join(root, 'routing/transparent-proxy.js'), 'utf8');
        assert.ok(backend.includes("require('./lib/a6api-routes').handle(req, res)"));
        assert.match(backend, /FRESH_PREFIXES = \[[^;]*'a6api-tab'/);
    });
    console.log(`check-a6api-tab: ${passed} passed`);
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
