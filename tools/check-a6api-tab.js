#!/usr/bin/env node
'use strict';
// Contract tests for the a6api Claude Code controls. No real network or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const file = path.join(root, 'routing/vendor/a6api-tab.js');
const slots = ['default', 'opus', 'sonnet', 'haiku'];
const model = 'deepseek-v4.1-flash-1017', alternate = 'deepseek-v4-pro', other = 'fixture-other-model';
const clone = value => JSON.parse(JSON.stringify(value));
const mapOf = value => Object.fromEntries(slots.map(slot => [slot, value]));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; } }
function fixture() {
    const els = new Map(), calls = [], handlers = {}, copied = [], tabs = [];
    function el(id) {
        if (!els.has(id)) {
            const listeners = {}, classes = new Set();
            els.set(id, { id, innerHTML: '', textContent: '', value: '', disabled: false, hidden: false, dataset: {},
                addEventListener(name, fn) { listeners[name] = fn; },
                emit(name, event) { return listeners[name]?.(event || { target: this }); },
                querySelectorAll: () => [], querySelector: () => null,
                classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle() {} },
                setAttribute() {}, scrollIntoView() { this.scrolled = true; }, focus() {}, animate() {} });
        }
        return els.get(id);
    }
    const token = { id: 9, name: 'primary', mask: 'hidden-9', status: 1, unlimited: true, spentUsd: .000012, expires: -1, restricted: true, models: [model, alternate] };
    const state = { ok: true, canWrite: true, account: { balanceUsd: 5.58, spentUsd: .42 }, tokens: [token, { ...token, id: 10, name: 'secondary', mask: 'hidden-10', models: [other] }],
        selectedTokenId: 9, models: [model, alternate], modelMap: { ...mapOf(model), gpt: 'server-only-gpt' },
        routesMap: { ...mapOf(model), default: 'independent-routes-default', gpt: 'server-only-gpt' }, active: false, prepared: true };
    const catalogs = new Map([[9, [model, alternate]], [10, [other]]]);
    const window = { toast() {}, confirm: () => false, showTab: name => tabs.push(name) };
    const ctx = { window, document: { readyState: 'complete', getElementById: el, querySelector: () => null, addEventListener() {} },
        console, URL, URLSearchParams, Date, JSON, Set, Map, Intl, Promise, clearTimeout,
        setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
        navigator: { clipboard: { writeText: async text => copied.push(text) } },
        fetch: async (url, options = {}) => {
            const u = new URL(url, 'http://fixture.invalid');
            const name = u.pathname.split('/').pop();
            const call = { url, name, params: u.searchParams, method: options.method || 'GET', body: options.body && JSON.parse(options.body) };
            calls.push(call);
            let d;
            if (handlers[name]) d = await handlers[name](call);
            else if (name === 'state') d = state;
            else if (name === 'models') { const tokenId = Number(call.params.get('tokenId')); d = { ok: true, tokenId, models: catalogs.get(tokenId) || [] }; }
            else if (name === 'key') {
                state.selectedTokenId = call.body.tokenId; state.models = catalogs.get(call.body.tokenId) || []; state.prepared = true;
                d = { ok: true, selectedTokenId: state.selectedTokenId };
            } else if (name === 'modelmap') {
                state.modelMap = { ...state.modelMap, ...call.body.modelMap };
                for (const slot of ['opus', 'sonnet', 'haiku']) state.routesMap[slot] = call.body.modelMap[slot];
                d = { ok: true, modelMap: state.modelMap, routesMap: state.routesMap };
            } else if (name === 'activate') { state.active = true; d = { ok: true, active: true }; }
            else d = { ok: false, error: 'Unexpected fixture endpoint: ' + name };
            return { ok: d.ok !== false, status: d.ok === false ? 409 : 200, json: async () => clone(d) };
        } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx);
    const tab = window.A6API;
    const select = (id, value) => { el(id).value = value; return el(id).emit('change'); };
    const click = action => el('a6api-root').emit('click', { target: { closest: () => ({ disabled: false, dataset: { a6: action } }) } });
    const setMap = async value => { for (const slot of slots) await select('a6-model-' + slot, value); };
    const writes = () => calls.filter(c => c.method !== 'GET');
    return { el, calls, handlers, state, catalogs, window, tab, select, click, setMap, writes, copied, tabs };
}
(async () => {
    await test('renders Claude Code controls instead of seller management', async () => {
        const f = fixture(); await f.tab.load(); const html = f.el('a6api-root').innerHTML;
        for (const text of ['Основное окно', 'Субагенты', 'Использовать ключ', 'Сохранить модели', 'Активировать для Claude Code', '/model a6api[1m]', 'Маршруты']) assert.ok(html.includes(text), text);
        assert.ok(!/a6-sellers|a6-reviews|a6-pool|a6-input-cap|a6-log-rows|enable-model|reveal/.test(html));
        assert.ok(!/авторег|авторотаци|чек-ин/i.test(html));
    });
    await test('initial and refreshed reads never write or probe the provider', async () => {
        const f = fixture(); await f.tab.load(); await f.tab.load();
        assert.equal(f.writes().length, 0);
        assert.ok(f.calls.every(c => ['state', 'models'].includes(c.name)));
        assert.equal(f.el('a6-token').value, '9');
        assert.equal(f.el('a6-model-default').value, model);
    });
    await test('account balance and key facts remain distinct and escaped', async () => {
        const f = fixture(); f.state.tokens[0].name = '<img src=x>'; await f.tab.load();
        assert.equal(f.el('a6-balance').textContent, '$5.58');
        assert.equal(f.el('a6-account-spent').textContent, '$0.42');
        const info = f.el('a6-key-info').innerHTML;
        assert.match(info, /hidden-9/); assert.match(info, /\$0\.000012/); assert.match(info, /Без срока/);
        assert.match(f.el('a6-token').innerHTML, /&lt;img/); assert.ok(!f.el('a6-token').innerHTML.includes('<img'));
        f.state.account.balanceUsd = null; f.state.tokens[0].spentUsd = null; await f.tab.load();
        assert.equal(f.el('a6-balance').textContent, 'нет данных'); assert.match(f.el('a6-key-info').innerHTML, /нет данных/);
    });
    await test('candidate key selection only loads its permitted models', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-token', '10');
        assert.equal(f.state.selectedTokenId, 9); assert.equal(f.writes().length, 0);
        assert.ok(f.calls.some(c => c.name === 'models' && c.params.get('tokenId') === '10'));
        assert.match(f.el('a6-model-default').innerHTML, /fixture-other-model/);
        assert.ok(!f.el('a6-model-default').innerHTML.includes(model));
        assert.equal(f.el('a6-save').disabled, true); assert.equal(f.el('a6-activate').disabled, true);
    });
    await test('model choices stay local until Save models', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-default', alternate); await f.select('a6-model-haiku', alternate);
        assert.equal(f.writes().length, 0); assert.match(f.el('a6-draft-status').textContent, /Не сохранено/);
        await f.click('save');
        const writes = f.writes(); assert.equal(writes.length, 1); assert.equal(writes[0].name, 'modelmap');
        assert.deepEqual(writes[0].body, { tokenId: 9, modelMap: { default: alternate, opus: model, sonnet: model, haiku: alternate } });
        assert.equal(f.state.routesMap.default, 'independent-routes-default'); assert.equal(f.state.modelMap.gpt, 'server-only-gpt');
        assert.equal(f.el('a6-save').disabled, true);
    });
    await test('replacing the saved key requires a scoped confirmation', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-token', '10');
        let prompt = ''; f.window.confirm = text => { prompt = text; return false; };
        await f.click('use-key'); assert.equal(f.writes().length, 0); assert.equal(f.state.selectedTokenId, 9);
        assert.match(prompt, /всех запросов a6api/i); assert.match(prompt, /бэкенд Claude Code не переключится/i);
    });
    await test('first key preparation needs no global activation confirmation', async () => {
        const f = fixture(); f.state.selectedTokenId = null; f.state.prepared = false; f.state.models = [];
        f.window.confirm = () => { throw new Error('unexpected activation confirmation'); };
        await f.tab.load(); await f.click('use-key');
        assert.deepEqual(f.writes().map(c => c.name), ['key']); assert.equal(f.state.active, false);
    });
    await test('Use key prepares only the explicitly selected key', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-token', '10'); await f.setMap(other);
        f.window.confirm = () => true; await f.click('use-key');
        assert.equal(f.writes().length, 1); assert.deepEqual(f.writes()[0].body, { tokenId: 10 }); assert.equal(f.writes()[0].name, 'key');
        assert.equal(f.state.active, false); assert.equal(f.state.selectedTokenId, 10);
        assert.equal(f.el('a6-model-default').value, other); assert.match(f.el('a6-draft-status').textContent, /Не сохранено/);
    });
    await test('dirty maps survive refresh and are separate per token', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-default', alternate);
        await f.select('a6-token', '10'); await f.setMap(other); await f.tab.load();
        assert.equal(f.el('a6-token').value, '10'); assert.equal(f.el('a6-model-default').value, other);
        await f.select('a6-token', '9'); assert.equal(f.el('a6-model-default').value, alternate);
        assert.equal(f.el('a6-model-opus').value, model); assert.equal(f.writes().length, 0);
    });
    await test('refresh imports clean mirrored tiers while preserving edited slots', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-default', alternate);
        f.state.modelMap.opus = alternate; f.state.routesMap.opus = alternate; await f.tab.load();
        assert.equal(f.el('a6-model-default').value, alternate); assert.equal(f.el('a6-model-opus').value, alternate);
        assert.match(f.el('a6api-root').innerHTML, /Opus, Sonnet и Haiku/);
        assert.match(f.el('a6api-root').innerHTML, /Субагенты идут тирами Opus, Sonnet и Haiku/);
        assert.match(f.el('a6api-root').innerHTML, /через \/model multi там же/);
        assert.equal(f.state.routesMap.default, 'independent-routes-default');
    });
    await test('latest token wins over an older models reply', async () => {
        const f = fixture(); await f.tab.load(); const pending = deferred();
        f.handlers.models = c => Number(c.params.get('tokenId')) === 10 ? pending.promise : { ok: true, tokenId: 9, models: [model, alternate] };
        const old = f.select('a6-token', '10'); await f.select('a6-token', '9');
        pending.resolve({ ok: true, tokenId: 10, models: [other] }); await old;
        assert.equal(f.el('a6-token').value, '9'); assert.equal(f.el('a6-model-default').value, model);
        assert.ok(!f.el('a6-model-default').innerHTML.includes(other));
    });
    await test('stale model errors cannot overwrite current selection', async () => {
        const f = fixture(); await f.tab.load(); const pending = deferred();
        f.handlers.models = c => Number(c.params.get('tokenId')) === 10 ? pending.promise : { ok: true, tokenId: 9, models: [model, alternate] };
        const old = f.select('a6-token', '10'); await f.select('a6-token', '9');
        pending.reject(new Error('stale-catalog-failure')); await old;
        assert.equal(f.el('a6-error').hidden, true); assert.equal(f.el('a6-model-default').value, model);
    });
    await test('model failure is visible, never retried and does not discard drafts', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-token', '10'); await f.setMap(other); await f.select('a6-token', '9');
        f.handlers.models = () => ({ ok: false, error: 'fixture-models-failed' }); const n = f.calls.length;
        await f.select('a6-token', '10');
        assert.equal(f.calls.slice(n).filter(c => c.name === 'models').length, 1); assert.match(f.el('a6-error').textContent, /fixture-models-failed/);
        assert.equal(f.el('a6-save').disabled, true); assert.equal(f.el('a6-model-default').value, other);
        delete f.handlers.models; await f.tab.load(); assert.equal(f.el('a6-model-default').value, other);
    });
    await test('models reply for the wrong token is rejected', async () => {
        const f = fixture(); await f.tab.load(); f.handlers.models = () => ({ ok: true, tokenId: 9, models: [model] });
        await f.select('a6-token', '10'); assert.equal(f.el('a6-error').hidden, false); assert.equal(f.el('a6-model-default').disabled, true);
        assert.equal(f.writes().length, 0);
    });
    await test('invalid model changes neither draft nor server', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-default', other);
        assert.equal(f.el('a6-model-default').value, model); assert.equal(f.writes().length, 0);
        assert.equal(f.el('a6-error').hidden, false);
    });
    await test('removed allowed model keeps the draft visible but blocks save', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-default', alternate);
        f.state.models = [model]; await f.tab.load();
        assert.equal(f.el('a6-model-default').value, alternate); assert.equal(f.el('a6-save').disabled, true);
        assert.match(f.el('a6-model-default').innerHTML, /disabled/);
        assert.match(f.el('a6-model-note').textContent, /недоступн/i);
    });
    await test('failed model save retains the draft and makes only one attempt', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-default', alternate);
        f.handlers.modelmap = () => ({ ok: false, error: 'fixture-save-failed' }); await f.click('save');
        assert.equal(f.writes().length, 1); assert.equal(f.el('a6-model-default').value, alternate);
        assert.match(f.el('a6-draft-status').textContent, /Не сохранено/); assert.match(f.el('a6-error').textContent, /fixture-save-failed/);
    });
    await test('all editors and write actions are locked during a save', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-default', alternate); const pending = deferred();
        f.handlers.modelmap = () => pending.promise; const saving = f.click('save');
        try {
            for (const id of ['a6-token', ...slots.map(s => 'a6-model-' + s), 'a6-save', 'a6-use-key', 'a6-activate', 'a6-refresh']) assert.equal(f.el(id).disabled, true, id);
            await f.select('a6-token', '10'); await f.select('a6-model-default', model); await f.tab.load(); await f.click('use-key');
            assert.equal(f.writes().length, 1); assert.equal(f.el('a6-token').value, '9');
        } finally { pending.resolve({ ok: true, modelMap: { ...mapOf(model), default: alternate }, routesMap: f.state.routesMap }); await saving; }
        assert.equal(f.el('a6-model-default').value, alternate);
    });
    await test('activation requires confirmation and never implicitly saves models', async () => {
        const f = fixture(); await f.tab.load(); await f.click('activate'); assert.equal(f.writes().length, 0);
        f.window.confirm = () => true; await f.select('a6-model-default', alternate); await f.click('activate'); assert.equal(f.writes().length, 0);
        await f.click('save'); await f.click('activate');
        assert.deepEqual(f.writes().map(c => c.name), ['modelmap', 'activate']);
        assert.deepEqual(f.writes()[1].body, { tokenId: 9 }); assert.match(f.el('a6-connection').textContent, /Активен/);
    });
    await test('activation and key failures stay visible without automatic retries', async () => {
        const f = fixture(); await f.tab.load(); f.window.confirm = () => true;
        f.handlers.activate = () => ({ ok: false, error: 'fixture-activation-failed' }); await f.click('activate');
        assert.equal(f.writes().length, 1); assert.match(f.el('a6-error').textContent, /fixture-activation-failed/);
        await f.select('a6-token', '10'); f.handlers.key = () => ({ ok: false, error: 'fixture-key-failed' }); await f.click('use-key');
        assert.equal(f.writes().length, 2); assert.match(f.el('a6-error').textContent, /fixture-key-failed/); assert.equal(f.state.selectedTokenId, 9);
    });
    // 25.10: «кнопки тухнут сами». Дашборд дёргает вкладку раз в 15 с, а обычная
    // загрузка на время запроса ставила `locked()` - гасли все кнопки и селекты.
    // Тихий прогон обязан обновить цифры, ничего не заблокировав и не перечитав модели.
    await test('background refresh never blocks controls or reloads models', async () => {
        const f = fixture(); await f.tab.load();
        const before = f.calls.length;
        f.state.account.balanceUsd = 6.25;
        await f.tab.load({ quiet: true });
        assert.equal(f.el('a6-balance').textContent, '$6.25', 'цифра обновилась');
        const since = f.calls.slice(before);
        assert.deepEqual(since.map(c => c.name), ['state'], 'тихий прогон не перечитывает модели');
        // Проверяем ровно те ручки, которые в этой фикстуре обязаны быть живыми. «Использовать
        // ключ» и «Активировать» здесь выключены законно: ключ уже подготовлен и карта валидна,
        // а `busy`/`locked` к ним отношения не имеют.
        for (const id of ['a6-refresh', 'a6-token', 'a6-model-default', 'a6-model-opus']) {
            assert.equal(f.el(id).disabled, false, id + ' не должен гаснуть на фоне');
        }
    });
    await test('quiet refresh keeps the drafts and the selected key', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-default', alternate);
        f.state.selectedTokenId = 10;                 // сервер «переключился» мимо вкладки
        await f.tab.load({ quiet: true });
        assert.equal(f.el('a6-token').value, '9', 'тихий прогон не подменяет выбор пользователя');
        assert.equal(f.el('a6-model-default').value, alternate, 'черновик пережил фоновое обновление');
        assert.match(f.el('a6-draft-status').textContent, /Не сохранено/);
    });
    await test('quiet refresh failure stays silent and keeps the screen', async () => {
        const f = fixture(); await f.tab.load();
        f.handlers.state = () => { throw new Error('fixture-state-failed'); };
        await f.tab.load({ quiet: true });
        assert.equal(f.el('a6-error').hidden, true, 'фоновая ошибка не рисуется поверх экрана');
        assert.equal(f.el('a6-model-default').disabled, false, 'управление не заблокировано после сбоя');
        assert.equal(f.el('a6-token').disabled, false, 'селект ключа тоже живой');
    });
    await test('readonly clients may inspect keys but cannot edit or activate', async () => {
        const f = fixture(); f.state.canWrite = false; await f.tab.load(); await f.select('a6-token', '10');
        f.window.confirm = () => true; await f.setMap(other); await f.click('use-key'); await f.click('save'); await f.click('activate');
        assert.equal(f.writes().length, 0); assert.equal(f.el('a6-local').hidden, false);
        for (const id of ['a6-use-key', 'a6-save', 'a6-activate', 'a6-model-default']) assert.equal(f.el(id).disabled, true);
    });
    await test('no saved key never becomes prepared merely by loading', async () => {
        const f = fixture(); f.state.selectedTokenId = null; f.state.models = []; f.state.modelMap = {}; f.state.routesMap = {}; f.state.prepared = false;
        await f.tab.load(); assert.equal(f.state.selectedTokenId, null); assert.equal(f.writes().length, 0);
        assert.equal(f.el('a6-activate').disabled, true); assert.match(f.el('a6-connection').textContent, /Не подготовлен/);
    });
    await test('empty token list retains shared balance and clears controls', async () => {
        const f = fixture(); await f.tab.load(); f.state.tokens = []; f.state.selectedTokenId = null; f.state.models = []; const n = f.calls.length;
        await f.tab.load(); assert.equal(f.el('a6-balance').textContent, '$5.58'); assert.equal(f.el('a6-token').value, '');
        assert.equal(f.el('a6-model-default').value, ''); assert.equal(f.el('a6-save').disabled, true);
        assert.ok(!f.calls.slice(n).some(c => c.name === 'models')); assert.match(f.el('a6-key-info').innerHTML, /кабинет/i);
    });
    await test('inactive key cannot be prepared or activated', async () => {
        const f = fixture(); f.state.tokens[1].status = 2; await f.tab.load(); await f.select('a6-token', '10');
        f.window.confirm = () => true; await f.click('use-key'); await f.click('activate');
        assert.equal(f.writes().length, 0); assert.equal(f.el('a6-use-key').disabled, true);
    });
    // 25.10: владелец показал в селекте служебный ключ, которым пользоваться нельзя.
    // Выключенные ключи из списка уходят: строка, которую нельзя выбрать, читается как
    // предложение и заставляет гадать, почему кнопка серая.
    await test('disabled keys stay out of the picker', async () => {
        const f = fixture(); f.state.tokens[1].status = 2; await f.tab.load();
        const html = f.el('a6-token').innerHTML;
        assert.ok(html.includes('#9'), 'рабочий ключ остался в списке');
        assert.ok(!html.includes('#10'), 'выключенный ключ убран из списка');
        assert.equal(f.el('a6-token').value, '9');
    });
    // 🪤 Исключение: если выключили ИМЕННО выбранный ключ, он обязан остаться видимым,
    // иначе селект молча показал бы чужой ключ как действующий.
    await test('disabled but selected key stays visible and marked', async () => {
        const f = fixture(); f.state.tokens[0].status = 2; await f.tab.load();
        const html = f.el('a6-token').innerHTML;
        assert.ok(html.includes('#9'), 'действующий ключ остался в списке даже выключенным');
        assert.match(html, /выключен/, 'и помечен, чтобы не выглядел рабочим');
        assert.equal(f.el('a6-use-key').disabled, true, 'подготовить выключенный ключ нельзя');
    });
    await test('removed token drafts do not leak to the replacement key', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-default', alternate);
        const original = clone(f.state.tokens[0]); f.state.tokens = [f.state.tokens[1]]; f.state.selectedTokenId = null; f.state.models = [];
        await f.tab.load(); assert.equal(f.el('a6-token').value, '10'); assert.notEqual(f.el('a6-model-default').value, alternate);
        f.state.tokens.push(original); await f.tab.load(); await f.select('a6-token', '9');
        assert.equal(f.el('a6-model-default').value, alternate); assert.equal(f.writes().length, 0);
    });
    await test('Routes delegates to showTab and highlights the normal provider row', async () => {
        const f = fixture(); await f.tab.load(); await f.click('routes');
        assert.deepEqual(f.tabs, ['routes']); assert.equal(f.el('routes-row-a6api').scrolled, true);
        assert.equal(f.writes().length, 0);
    });
    await test('command copies exact per-window prefix without activation', async () => {
        const f = fixture(); await f.tab.load(); await f.click('copy-command');
        assert.deepEqual(f.copied, ['/model a6api[1m]']); assert.equal(f.writes().length, 0);
    });
    // 26.10: владелец попросил готовые строки под конкретную модель. Основное окно
    // адресуется явным именем, тир - формой в скобках. Форму `a6api/<тир>` не даём:
    // keepalive возвращает её эхом как `<тир>[1m]`, и [CC] рвёт поток.
    await test('each model row offers its own copyable /model command', async () => {
        const f = fixture(); await f.tab.load();
        const main = f.el('a6-cmd-default').innerHTML;
        assert.match(main, new RegExp('/model a6api/' + model), 'основное окно адресуется явным именем');
        for (const slot of ['opus', 'sonnet', 'haiku']) {
            const html = f.el('a6-cmd-' + slot).innerHTML;
            assert.match(html, new RegExp('/model a6api\\[' + slot + '\\]'), slot + ' адресуется тиром');
            assert.ok(!/a6api\/(opus|sonnet|haiku)/.test(html), slot + ': слэш с тиром не предлагаем');
        }
        assert.equal(f.writes().length, 0, 'рисование команд ничего не пишет');
    });
    await test('clicking a model command copies exactly its own text', async () => {
        const f = fixture(); await f.tab.load();
        const html = f.el('a6-cmd-sonnet').innerHTML;
        const cmd = html.match(/data-cmd="([^"]+)"/)[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"');
        await f.el('a6api-root').emit('click', { target: { closest: () => ({ disabled: false, dataset: { a6: 'copy-cmd', cmd } }) } });
        assert.deepEqual(f.copied, [cmd]);
        assert.equal(f.writes().length, 0);
    });
    await test('model command follows the draft selection', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-default', alternate);
        assert.match(f.el('a6-cmd-default').innerHTML, new RegExp('/model a6api/' + alternate));
    });
    await test('empty permitted catalog blocks key preparation without writes', async () => {
        const f = fixture(); f.catalogs.set(10, []); await f.tab.load(); await f.select('a6-token', '10');
        assert.equal(f.el('a6-use-key').disabled, true); assert.equal(f.el('a6-model-default').disabled, true);
        f.window.confirm = () => true; await f.click('use-key'); assert.equal(f.writes().length, 0);
    });
    await test('empty saved maps do not claim models are saved', async () => {
        const f = fixture(); f.state.modelMap = {}; await f.tab.load();
        assert.equal(f.el('a6-model-default').value, ''); assert.equal(f.el('a6-activate').disabled, true);
        assert.doesNotMatch(f.el('a6-draft-status').textContent, /Модели сохранены/);
    });
    await test('zero expiry means no expiry consistently with the panel contract', async () => {
        const f = fixture(); f.state.tokens[1].expires = 0; await f.tab.load(); await f.select('a6-token', '10');
        assert.equal(f.el('a6-use-key').disabled, false); assert.match(f.el('a6-key-info').innerHTML, /Без срока/);
    });
    await test('spent token quota blocks key preparation and activation', async () => {
        const f = fixture(); f.state.tokens[0].unlimited = false; f.state.tokens[0].remainingUsd = 0;
        await f.tab.load(); assert.equal(f.el('a6-activate').disabled, true); f.window.confirm = () => true; await f.click('activate');
        assert.equal(f.writes().length, 0);
        f.state.selectedTokenId = null; f.state.prepared = false; await f.tab.load();
        assert.equal(f.el('a6-use-key').disabled, true);
    });
    await test('returning edited field to saved value clears activation warning', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-default', alternate); await f.select('a6-model-default', model);
        assert.equal(f.el('a6-save').disabled, true); assert.equal(f.el('a6-activate').disabled, false);
        assert.doesNotMatch(f.el('a6-activation-note').textContent, /сохраните/);
    });
    await test('saving new models verifies all returned mirrored tiers', async () => {
        const f = fixture(); await f.tab.load(); await f.select('a6-model-opus', alternate);
        f.handlers.modelmap = c => ({ ok: true, modelMap: c.body.modelMap, routesMap: f.state.routesMap });
        await f.click('save'); assert.equal(f.el('a6-error').hidden, false);
        assert.match(f.el('a6-draft-status').textContent, /Не сохранено/);
    });
    await test('registered HTML and source use only the new fixed UI contract', () => {
        const html = fs.readFileSync(path.join(root, 'routing/proxy-dashboard.html'), 'utf8');
        assert.ok(html.includes('data-tab="a6api"')); assert.ok(html.includes('id="a6api-root"'));
        assert.ok(html.includes('a6api-tab.js')); assert.ok(html.includes('a6api-tab.css'));
        const source = fs.readFileSync(file, 'utf8');
        assert.ok(!/enable-model|reveal|toggleChannel|showReviews|loadLogs|confirmedPrices/.test(source));
    });
    console.log(`check-a6api-tab: ${passed} passed`);
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
