#!/usr/bin/env node
'use strict';
// Local gateway tests. The panel and process launcher are fixtures, never production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.join(__dirname, '..');
const file = path.join(root, 'routing/lib/a6api-gateway.js');
const MODEL = 'deepseek-v4.1-flash-1017';
let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; } }
function fixture(createGateway) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-gateway-'));
    const routing = path.join(dir, 'routing'); fs.mkdirSync(routing);
    const maps = { provider: { default: MODEL, opus: MODEL, sonnet: MODEL, haiku: MODEL, gpt: 'kept-value' },
        routes: { default: 'another', opus: MODEL, sonnet: MODEL, haiku: MODEL, gpt: '' } };
    const calls = [];
    const tokens = [{ id: 9, name: 'main', status: 1, expired_time: -1, model_limits_enabled: true, model_limits: MODEL + ',another', unlimited_quota: true },
        { id: 10, name: 'second', status: 1, expired_time: -1, model_limits_enabled: true, model_limits: MODEL + ',another', unlimited_quota: true },
        { id: 11, name: 'disabled', status: 2, expired_time: -1, model_limits_enabled: false },
        { id: 12, name: 'limited', status: 1, expired_time: -1, model_limits_enabled: true, model_limits: 'another' }];
    const api = {
        ownToken: async id => { calls.push('token'); const t = tokens.find(x => x.id === id); if (!t) throw new Error('not owned'); return t; },
        models: async () => [MODEL, 'another', 'gpt-image-2'],
        state: async () => ({ account: { balanceUsd: 5 }, tokens: tokens.map(t => ({ id: t.id, name: t.name, status: t.status, models: (t.model_limits || '').split(','), restricted: t.model_limits_enabled })), models: [MODEL, 'another'] }),
        reveal: async id => { calls.push('reveal'); return 'sk-fixture-key-' + id; },
    };
    let active = false, failPrepare = false;
    const hub = {
        readMap: routes => ({ ...maps[routes ? 'routes' : 'provider'] }),
        writeMap: (patch, routes) => { calls.push('map'); const kind = routes ? 'routes' : 'provider'; Object.assign(maps[kind], patch); for (const k of ['opus', 'sonnet', 'haiku']) if (k in patch) maps[routes ? 'provider' : 'routes'][k] = patch[k]; return { ...maps[kind] }; },
        isActive: () => active,
        ensure: async () => { calls.push('ensure'); if (failPrepare) throw new Error('port occupied'); return { ok: true }; },
        activate: async model => { calls.push('activate:' + model); active = true; },
        syncModel: async model => { calls.push('sync:' + model); },
        publish: () => { calls.push('publish'); },
    };
    const gateway = createGateway({ api, secretDir: dir, routingDir: routing, hub });
    return { dir, routing, calls, maps, tokens, api, gateway, setFail: v => { failPrepare = v; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
(async () => {
    await test('local gateway module exists', () => assert.ok(fs.existsSync(file), 'a6api-gateway.js is missing'));
    if (!fs.existsSync(file)) return;
    const { createGateway, buildRuntimeConfig } = require(file);
    await test('reading state caches only the non-secret account balance for the statusline', async () => {
        const f = fixture(createGateway); try {
            const s = await f.gateway.state();
            assert.equal(s.selectedTokenId, null); assert.equal(s.prepared, false); assert.deepEqual(s.models, []); assert.deepEqual(f.calls, []);
            assert.deepEqual(fs.readdirSync(f.dir).sort(), ['a6api-balance.json', 'routing']);
            const cache = JSON.parse(fs.readFileSync(path.join(f.dir, 'a6api-balance.json'), 'utf8'));
            assert.equal(cache.balanceUsd, 5); assert.ok(cache.checkedAt);
            assert.ok(!JSON.stringify(cache).toLowerCase().includes('key'));
        } finally { f.cleanup(); }
    });
    await test('key choice is private and does not globally activate or spawn', async () => {
        const f = fixture(createGateway); try {
            await f.gateway.selectKey(9); const s = await f.gateway.state();
            assert.equal(s.selectedTokenId, 9); assert.equal(s.prepared, true); assert.equal(s.active, false);
            assert.ok(!JSON.stringify(s).includes('sk-fixture')); assert.ok(!f.calls.includes('ensure'));
            assert.ok(!f.calls.some(x => x.startsWith('activate:')));
            assert.equal(fs.readFileSync(path.join(f.dir, 'a6api-active-key.txt'), 'utf8').trim(), 'sk-fixture-key-9');
        } finally { f.cleanup(); }
    });
    await test('disabled keys preserve previous selection while restricted keys can be prepared', async () => {
        const f = fixture(createGateway); try {
            await f.gateway.selectKey(9);
            await assert.rejects(f.gateway.selectKey(11), /выключен|недоступен/);
            assert.equal((await f.gateway.state()).selectedTokenId, 9);
            await f.gateway.selectKey(12);
            await f.gateway.saveModels(12, { default: 'another', opus: 'another', sonnet: 'another', haiku: 'another' });
            assert.equal((await f.gateway.state()).selectedTokenId, 12);
        } finally { f.cleanup(); }
    });
    await test('provider map saves and activates independently of routes default', async () => {
        const f = fixture(createGateway); try {
            f.maps.routes.default = 'only-in-other-key';
            await f.gateway.selectKey(9);
            await f.gateway.saveModels(9, { default: MODEL, opus: MODEL, sonnet: MODEL, haiku: MODEL });
            await f.gateway.activate(9); assert.equal((await f.gateway.state()).active, true);
            assert.equal(f.maps.routes.default, 'only-in-other-key');
        } finally { f.cleanup(); }
    });
    await test('selected key can change manually without process restart', async () => {
        const f = fixture(createGateway); try { await f.gateway.selectKey(9); await f.gateway.selectKey(10); assert.equal((await f.gateway.state()).selectedTokenId, 10); assert.ok(!f.calls.includes('ensure')); } finally { f.cleanup(); }
    });
    await test('models are restricted to the selected key and text capabilities', async () => {
        const f = fixture(createGateway); try { assert.deepEqual(await f.gateway.models(9), [MODEL, 'another']); assert.deepEqual(await f.gateway.models(12), ['another']); assert.ok(!f.calls.includes('reveal')); } finally { f.cleanup(); }
    });
    await test('model save uses the shared map writer, preserves gpt and routes default', async () => {
        const f = fixture(createGateway); try {
            await f.gateway.selectKey(9); await f.gateway.saveModels(9, { default: 'another', opus: MODEL, sonnet: 'another', haiku: MODEL });
            assert.equal(f.maps.provider.default, 'another'); assert.equal(f.maps.provider.gpt, 'kept-value');
            assert.equal(f.maps.routes.default, 'another'); assert.equal(f.maps.routes.sonnet, 'another'); assert.ok(f.calls.includes('map'));
            assert.ok(!f.calls.some(x => x.startsWith('activate:')));
        } finally { f.cleanup(); }
    });
    await test('unselected token and prohibited model cannot change maps', async () => {
        const f = fixture(createGateway); try {
            await f.gateway.selectKey(9); const before = JSON.stringify(f.maps);
            await assert.rejects(f.gateway.saveModels(10, { default: MODEL }), /ключ/);
            await assert.rejects(f.gateway.saveModels(9, { default: 'gpt-image-2' }), /модел/);
            assert.equal(JSON.stringify(f.maps), before);
        } finally { f.cleanup(); }
    });
    await test('activation happens only after successful process readiness', async () => {
        const f = fixture(createGateway); try {
            await f.gateway.selectKey(9); f.setFail(true); await assert.rejects(f.gateway.activate(9), /occupied/);
            assert.equal((await f.gateway.state()).active, false); assert.ok(!f.calls.some(x => x.startsWith('activate:')));
            f.setFail(false); await f.gateway.activate(9);
            assert.ok(f.calls.indexOf('ensure') < f.calls.indexOf('activate:' + MODEL)); assert.equal((await f.gateway.state()).active, true);
        } finally { f.cleanup(); }
    });
    await test('selected metadata cannot conceal a replaced key file', async () => {
        const f = fixture(createGateway); try {
            await f.gateway.selectKey(9); fs.writeFileSync(path.join(f.dir, 'a6api-active-key.txt'), 'sk-unrelated');
            assert.equal((await f.gateway.state()).prepared, false);
            await assert.rejects(f.gateway.activate(9), /ключ/);
        } finally { f.cleanup(); }
    });
    await test('route editor validates the selected key and mirrors only shared tiers', async () => {
        const f = fixture(createGateway); try {
            await f.gateway.selectKey(9);
            const r = await f.gateway.saveRouteTier('default', 'another');
            assert.equal(r.tiers.default, 'another'); assert.equal(f.maps.provider.default, MODEL);
            await f.gateway.saveRouteTier('sonnet', 'another'); assert.equal(f.maps.provider.sonnet, 'another');
            const before = JSON.stringify(f.maps);
            await assert.rejects(f.gateway.saveRouteTier('opus', 'not-permitted'), e => e.code === 'model_unavailable');
            assert.equal(JSON.stringify(f.maps), before);
        } finally { f.cleanup(); }
    });
    await test('missing model files are not reported as a saved default map', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-empty-map-'));
        try {
            const gateway = createGateway({ secretDir: dir, routingDir: dir, api: { state: async () => ({ tokens: [], models: [] }) } });
            const s = await gateway.state(); assert.equal(s.modelMap.default, ''); assert.equal(s.routesMap.opus, '');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    await test('shared fallback launcher has a guarded command entrypoint', () => {
        const source = fs.readFileSync(file, 'utf8');
        assert.match(source, /require\.main === module/); assert.match(source, /process\.argv\[2\]/);
        assert.match(source, /restart/);
    });
    await test('new runtime is isolated, private, non-rotating and single-attempt', () => {
        const x = buildRuntimeConfig({ secretDir: '/private', routingDir: '/routing' });
        assert.equal(x.converter.strictToolsVision, true); assert.deepEqual(x.converter.modelMap, {});
        assert.equal(x.converter.upstream, 'https://api.a6api.com/v1');
        assert.equal(x.keepaliveEnv.KEY_FILE, path.join('/private', 'a6api-active-key.txt'));
        assert.equal(x.keepaliveEnv.UPSTREAM, 'http://127.0.0.1:20192');
        assert.equal(x.keepaliveEnv.SESSIONS_FILE, ''); assert.equal(x.keepaliveEnv.PAID_SINGLE_KEY, '1');
        assert.equal(x.keepaliveEnv.MODELMAP_FILE, path.join('/routing', 'a6api-modelmap.json'));
        assert.equal(x.keepaliveEnv.POOL_FALLBACK_MODEL, '');
    });
    console.log(`check-a6api-gateway: ${passed} passed`);
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
