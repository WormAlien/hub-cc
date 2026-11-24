#!/usr/bin/env node
'use strict';
// a6api model-publication controls, with an explicit panel fixture and no network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const model = 'deepseek-v4.1-flash-1017';
const other = 'vendor/nested-model';
const clone = value => structuredClone(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fixture() {
    const elements = new Map(), requests = [], handlers = {}, events = new Map(), copied = [], tabs = [];
    const el = id => {
        if (!elements.has(id)) {
            const listeners = new Map();
            elements.set(id, { id, innerHTML: '', textContent: '', value: '', disabled: false, hidden: false, open: false, dataset: {},
                addEventListener(name, fn) { listeners.set(name, fn); },
                emit(name, event) { return listeners.get(name)?.(event || { target: this }); },
                querySelectorAll: () => [], querySelector: () => null,
                classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                setAttribute() {}, scrollIntoView() {}, focus() {} });
        }
        return elements.get(id);
    };
    const token = { id: 9, name: 'Основной', mask: 'hidden-9', status: 1, unlimited: true, expires: -1,
        spentUsd: .01, restricted: true, models: [model, other] };
    const state = { ok: true, configured: true, connected: true, setupError: null, canWrite: true,
        account: { balanceUsd: 5.58, spentUsd: .42 }, tokens: [token, { ...token, id: 10, name: 'Другой', models: ['secondary-only'] }],
        selectedTokenId: 9, prepared: true, active: false, models: [model, other],
        modelMap: { default: model, opus: 'unchanged-opus', sonnet: 'unchanged-sonnet', haiku: 'unchanged-haiku', gpt: 'unchanged-gpt' },
        routesMap: { default: 'independent-route-default', opus: 'unchanged-opus', sonnet: 'unchanged-sonnet', haiku: 'unchanged-haiku', gpt: 'independent-route-gpt' } };
    const publications = { ok: true, canWrite: true, manifest: { version: 1, revision: 7, enabled: true }, providers: ['a6api'],
        models: [{ id: 'a6api/' + model, provider: 'a6api', model, published: true, displayName: 'Existing custom label',
            contextTokens: 200000, outputTokens: 24000, claudeBehavesAs: 'claude-sonnet-5' }] };
    const catalogs = new Map([[9, [model, other]], [10, ['secondary-only']]]);
    const window = { toast() {}, confirm: () => false, showTab: name => tabs.push(name) };
    const document = { readyState: 'complete', getElementById: el, querySelector: () => null,
        addEventListener(name, fn) { events.set(name, fn); } };
    const html = fs.readFileSync(path.join(root, 'routing/proxy-dashboard.html'), 'utf8');
    const chip = html.match(/function modelPublicationChip\([^]*?\n\}/)?.[0];
    assert.ok(chip, 'existing shared publication wrapper is required');
    const ctx = { window, document, esc: escape, console, URL, URLSearchParams, Date, JSON, Map, Set, Intl, Promise, clearTimeout,
        setTimeout: (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return timer; },
        navigator: { clipboard: { writeText: async text => copied.push(text) } },
        fetch: async (url, options = {}) => {
            const parsed = new URL(url, 'http://explicit-panel-fixture.invalid');
            const name = parsed.pathname.split('/').pop();
            const call = { name, method: options.method || 'GET', params: parsed.searchParams,
                body: options.body === undefined ? undefined : JSON.parse(options.body) };
            requests.push(call);
            let data;
            if (handlers[name]) data = await handlers[name](call);
            else if (name === 'state') data = state;
            else if (name === 'api-gateway') data = publications;
            else if (name === 'models') {
                const tokenId = Number(call.params.get('tokenId'));
                data = { ok: true, tokenId, models: catalogs.get(tokenId) || [] };
            } else if (name === 'key') {
                state.selectedTokenId = call.body.tokenId; state.prepared = true;
                state.models = catalogs.get(call.body.tokenId) || [];
                data = { ok: true, selectedTokenId: state.selectedTokenId };
            } else if (name === 'modelmap') {
                Object.assign(state.modelMap, call.body.modelMap);
                data = { ok: true, modelMap: state.modelMap, routesMap: state.routesMap };
            } else data = { ok: false, error: 'Unexpected fixture endpoint' };
            return { ok: data.ok !== false, status: data.ok === false ? 409 : 200, json: async () => clone(data) };
        } };
    vm.runInNewContext(chip + '\nwindow.modelPublicationChip = modelPublicationChip;', ctx);
    vm.runInNewContext(fs.readFileSync(path.join(root, 'routing/vendor/a6api-tab.js'), 'utf8'), ctx);
    const load = async opts => { await window.A6API.load(opts); await new Promise(resolve => setImmediate(resolve)); };
    const select = async (id, value) => { el(id).value = value; await el(id).emit('change'); };
    const click = async (action, data = {}) => el('a6api-root').emit('click', {
        target: { closest: () => ({ disabled: false, dataset: { a6: action, ...data } }) },
    });
    const publishEvent = () => events.get('abuse-hub:model-publications')?.({ detail: clone(publications) });
    return { el, state, publications, catalogs, handlers, requests, copied, window, load, select, click, publishEvent,
        writes: () => requests.filter(call => call.method !== 'GET') };
}

test('a6api makes model publication primary and leaves one optional native default editor', async () => {
    const f = fixture(); await f.load();
    const html = f.el('a6api-root').innerHTML;
    assert.match(html, /Модели для Claude Code, Hermes и OpenCode/);
    assert.match(html, /id="a6-model-search"/);
    assert.match(html, /<details[^>]*id="a6-compatibility"/);
    assert.ok(html.indexOf('id="a6-publication-list"') < html.indexOf('id="a6-compatibility"'));
    assert.ok(!/<details[^>]*class="a6-publications"/.test(html), 'publication cannot be hidden in compatibility details');
    assert.ok(!/id="a6-model-(opus|sonnet|haiku)"/.test(html), 'Routes is the only tier editor');
    assert.match(html, /Ключ a6api/);
    assert.match(html, /data-a6="routes"/);
    assert.equal(f.writes().length, 0, 'opening the catalog does not change provider or session models');
});

test('catalog displays the shared published metadata and filters exact IDs without model writes', async () => {
    const f = fixture();
    f.state.models = [other, model];
    await f.load();
    const initial = f.el('a6-publication-list').innerHTML;
    assert.ok(initial.includes('Existing custom label'), 'published display name comes from the shared manifest');
    assert.match(initial, /200[\s,]?000/);
    assert.match(initial, /24[\s,]?000/);
    assert.ok(initial.includes('data-publication-slot="a6api/' + other + '"'), 'nested wire IDs are never rewritten');
    assert.ok(initial.indexOf('data-a6-model-id="a6api/' + model + '"') < initial.indexOf('data-a6-model-id="a6api/' + other + '"'), 'published models precede unpublished models');
    f.el('a6-model-search').value = 'vendor/nested';
    await f.el('a6-model-search').emit('input');
    const filtered = f.el('a6-publication-list').innerHTML;
    assert.ok(filtered.includes('a6api/' + other));
    assert.ok(!filtered.includes('a6api/' + model));
    assert.equal(f.writes().length, 0, 'search is not native model selection or publication');
});

test('unavailable publications stay visible for removal and key readiness is not native activation', async () => {
    const f = fixture();
    f.state.prepared = false; f.state.models = [];
    f.publications.models.push({ ...f.publications.models[0], id: 'a6api/no-longer-permitted', model: 'no-longer-permitted' });
    await f.load();
    assert.ok(f.el('a6-publication-list').innerHTML.includes('a6api/no-longer-permitted'));
    assert.match(f.el('a6-publication-list').innerHTML, /не разрешена|Каталог|ключ/i);
    assert.match(f.el('a6-catalog-note').textContent, /сохранены|не удалены/i);
    f.state.prepared = true; f.state.models = [model, other]; await f.load();
    assert.equal(f.el('a6-connection').textContent, 'Ключ подготовлен');
    assert.doesNotMatch(f.el('a6-connection').textContent, /актив/i);
    f.state.connected = false; f.state.configured = true; await f.load();
    assert.ok(f.el('a6-publication-list').innerHTML.includes('a6api/no-longer-permitted'), 'a disconnected cabinet must not hide removal controls');
    assert.equal(f.writes().length, 0);
});

test('optional native default saves only that field and checks both unchanged maps', async () => {
    const f = fixture(); await f.load();
    const before = clone(f.state);
    await f.select('a6-model-default', other);
    assert.equal(f.writes().length, 0);
    await f.click('save');
    assert.deepEqual(f.writes().map(call => call.name), ['modelmap']);
    assert.deepEqual(f.writes()[0].body, { tokenId: 9, modelMap: { default: other } });
    assert.deepEqual(f.state.routesMap, before.routesMap);
    for (const tier of ['opus', 'sonnet', 'haiku', 'gpt']) assert.equal(f.state.modelMap[tier], before.modelMap[tier]);
    assert.equal(f.el('a6-error').hidden, true, 'default-only response preserves unchanged fields');
    assert.equal(f.el('a6-save').disabled, true);
    const broken = fixture(); await broken.load(); await broken.select('a6-model-default', other);
    broken.handlers.modelmap = call => ({ ok: true, modelMap: { ...broken.state.modelMap, ...call.body.modelMap, opus: other }, routesMap: broken.state.routesMap });
    await broken.click('save');
    assert.equal(broken.el('a6-error').hidden, false, 'unexpected tier changes must not claim success');
    assert.match(broken.el('a6-draft-status').textContent, /Не сохранено/);
});

test('a failed manifest read retains the last rows but does not claim confirmed publication', async () => {
    const f = fixture(); await f.load();
    f.handlers['api-gateway'] = () => ({ ok: false, error: 'explicit fixture read failed' });
    await f.load();
    assert.match(f.el('a6-publication-list').innerHTML, /Existing custom label/);
    assert.match(f.el('a6-publication-list').innerHTML, /Статус не проверен/);
    assert.match(f.el('a6-published-count').textContent, /не прочитаны/);
    assert.equal(f.writes().length, 0);
});

test('key status explains expiry and a removed selected token without silently claiming a new key', async () => {
    const f = fixture(); f.state.prepared = false; f.state.keyStatus = 'a6api_token_expired';
    f.state.tokens[0].expires = 1; await f.load();
    assert.equal(f.el('a6-connection').textContent, 'Ключ истёк');
    assert.match(f.el('a6-key-note').textContent, /срок|другой ключ/i);
    f.state.keyStatus = 'a6api_token_missing'; f.state.tokens = [f.state.tokens[1]]; f.state.models = [];
    await f.load();
    assert.equal(f.el('a6-connection').textContent, 'Ключ не найден');
    assert.match(f.el('a6-active-key').textContent, /#9.*не найден/);
    assert.equal(f.state.selectedTokenId, 9);
    assert.equal(f.writes().length, 0);
});

test('default readback preserves future nested JSON fields rather than comparing object identity', async () => {
    const f = fixture();
    f.state.modelMap.futureField = { keep: [1, true] };
    f.state.routesMap.futureField = { keep: { flag: true } };
    await f.load(); await f.select('a6-model-default', other);
    await f.click('save');
    assert.equal(f.el('a6-error').hidden, true, 'equal future JSON values survive HTTP readback');
    assert.equal(f.el('a6-save').disabled, true);
    const broken = fixture(); broken.state.routesMap.futureField = { keep: { flag: true } };
    await broken.load(); await broken.select('a6-model-default', other);
    broken.handlers.modelmap = call => ({ ok: true, modelMap: { ...broken.state.modelMap, ...call.body.modelMap },
        routesMap: { ...broken.state.routesMap, futureField: { keep: { flag: false } } } });
    await broken.click('save');
    assert.equal(broken.el('a6-error').hidden, false, 'unexpected nested field change cannot claim a saved default');
});
