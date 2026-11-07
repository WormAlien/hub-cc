#!/usr/bin/env node
'use strict';
// Local gateway tests. The panel and process launcher are fixtures, never production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.join(__dirname, '..');
const file = path.join(root, 'routing/lib/a6api-gateway.js');
const API_ORIGIN = 'https://api.a6api.vip';
const WEB_ORIGIN = 'https://a6api.vip';
const OLD_ORIGINS = /https:\/\/(?:api\.)?a6api\.com/;
const A6_DOMAIN_FILES = [
    'routing/lib/a6api-api.js',
    'routing/lib/a6api-gateway.js',
    'routing/lib/a6api-probe.js',
    'routing/vendor/a6api-tab.js',
    'tools/check-a6api-gateway.js',
    'tools/probe-pro-full.js',
    'tools/probe-pro-vision.js',
];
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
    const { ApiError } = require(path.join(root, 'routing/lib/a6api-api.js'));
    await test('account connection verifies identity before durable local storage', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-connect-ok-'));
        const calls = [];
        try {
            fs.writeFileSync(path.join(dir, 'a6api-active-key.txt'), 'sk-old-account-key');
            fs.writeFileSync(path.join(dir, 'a6api-gateway.json'), JSON.stringify({ tokenId: 9, keyHash: 'old' }));
            const gateway = createGateway({ secretDir: dir, routingDir: dir,
                api: { state: async () => ({ account: {}, tokens: [], models: [] }) },
                clientFactory: options => {
                    assert.equal(options.token, 'fixture-panel-token'); assert.equal(options.userId, 314);
                    return { request: async p => { calls.push(p); return { id: 314, username: 'friend' }; } };
                } });
            const result = await gateway.connect({ panelToken: '  fixture-panel-token  ', userId: '314' });
            assert.deepEqual(result, { ok: true, configured: true });
            assert.deepEqual(calls, ['/api/user/self']);
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'a6api-config.json'), 'utf8')),
                { userId: 314, panelToken: 'fixture-panel-token' });
            assert.equal(fs.readFileSync(path.join(dir, 'a6api-active-key.txt'), 'utf8').trim(), '');
            assert.equal(gateway.readSelection(), null);
            assert.ok(!JSON.stringify(result).includes('fixture-panel-token'));
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    await test('credential write failure cannot leave the previous model key prepared for a new account', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-connect-disk-fail-'));
        const durable = require(path.join(root, 'routing/lib/durable-write.js'));
        const originalWriteJson = durable.writeJsonSync;
        try {
            fs.writeFileSync(path.join(dir, 'a6api-config.json'), JSON.stringify({ userId: 7, panelToken: 'old-token' }) + '\n');
            fs.writeFileSync(path.join(dir, 'a6api-active-key.txt'), 'sk-old-account-key\n');
            fs.writeFileSync(path.join(dir, 'a6api-gateway.json'), JSON.stringify({ tokenId: 9, keyHash: 'old' }) + '\n');
            durable.writeJsonSync = (target, value) => {
                if (target === path.join(dir, 'a6api-config.json')) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
                return originalWriteJson(target, value);
            };
            const gateway = createGateway({ secretDir: dir, routingDir: dir,
                api: { state: async () => ({ account: {}, tokens: [], models: [] }) },
                clientFactory: () => ({ request: async () => ({ id: 314 }) }) });
            await assert.rejects(gateway.connect({ panelToken: 'new-token', userId: 314 }), /fixture disk failure/);
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'a6api-config.json'), 'utf8')), { userId: 7, panelToken: 'old-token' });
            assert.equal(gateway.readSelection(), null);
            assert.equal(fs.readFileSync(path.join(dir, 'a6api-active-key.txt'), 'utf8').trim(), '');
        } finally {
            durable.writeJsonSync = originalWriteJson;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    await test('invalid account credentials never change files or reach unrelated endpoints', async () => {
        const cases = [
            { input: { panelToken: '', userId: 314 }, code: 'panel_token_invalid' },
            { input: { panelToken: 'bad\nheader', userId: 314 }, code: 'panel_token_invalid' },
            { input: { panelToken: 'x'.repeat(8193), userId: 314 }, code: 'panel_token_invalid' },
            { input: { panelToken: 'fixture-secret', userId: 0 }, code: 'invalid_id' },
        ];
        for (const c of cases) {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-connect-invalid-')); let calls = 0;
            try {
                const gateway = createGateway({ secretDir: dir, routingDir: dir,
                    api: { state: async () => ({ account: {}, tokens: [], models: [] }) },
                    clientFactory: () => { calls++; return { request: async () => ({ id: 314 }) }; } });
                await assert.rejects(gateway.connect(c.input), e => e.code === c.code && !e.message.includes('fixture-secret'));
                assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(dir), []);
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        }
    });
    await test('rejected or mismatched panel identity leaves the previous local state untouched', async () => {
        for (const mode of ['mismatch', 'unauthorized']) {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-connect-reject-'));
            const old = JSON.stringify({ userId: 7, panelToken: 'old-token' }) + '\n';
            try {
                fs.writeFileSync(path.join(dir, 'a6api-config.json'), old);
                const gateway = createGateway({ secretDir: dir, routingDir: dir,
                    api: { state: async () => ({ account: {}, tokens: [], models: [] }) },
                    clientFactory: () => ({ request: async p => {
                        assert.equal(p, '/api/user/self');
                        if (mode === 'unauthorized') throw new ApiError('upstream_http', 'a6api: HTTP 401', 401, 401);
                        return { id: 999 };
                    } }) });
                await assert.rejects(gateway.connect({ panelToken: 'new-secret-token', userId: 314 }), e => {
                    assert.ok(['account_mismatch', 'credentials_rejected'].includes(e.code));
                    return !e.message.includes('new-secret-token');
                });
                assert.equal(fs.readFileSync(path.join(dir, 'a6api-config.json'), 'utf8'), old);
                assert.deepEqual(fs.readdirSync(dir), ['a6api-config.json']);
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        }
    });
    await test('state distinguishes a fresh install from saved but disconnected credentials', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-setup-state-'));
        try {
            const missing = createGateway({ secretDir: dir, routingDir: dir,
                api: { state: async () => { throw new ApiError('panel_token_missing', 'missing', 503); } } });
            let state = await missing.state();
            assert.equal(state.configured, false); assert.equal(state.connected, false);
            assert.deepEqual(state.tokens, []); assert.ok(!JSON.stringify(state).includes('missing'));
            fs.writeFileSync(path.join(dir, 'a6api-config.json'), JSON.stringify({ userId: 314, panelToken: 'saved-secret' }));
            const rejected = createGateway({ secretDir: dir, routingDir: dir,
                api: { state: async () => { throw new ApiError('upstream_http', 'saved-secret', 401, 401); } } });
            state = await rejected.state();
            assert.equal(state.configured, true); assert.equal(state.connected, false);
            assert.match(state.setupError, /токен|ID/i); assert.ok(!JSON.stringify(state).includes('saved-secret'));
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    await test('legacy split credentials are still recognized as configured when the panel rejects them', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-legacy-state-'));
        try {
            fs.writeFileSync(path.join(dir, 'a6api-config.json'), JSON.stringify({ userId: 314 }));
            fs.writeFileSync(path.join(dir, 'a6api.token'), 'legacy-panel-token\n');
            const gateway = createGateway({ secretDir: dir, routingDir: dir,
                api: { state: async () => { throw new ApiError('upstream_http', 'legacy-panel-token', 401, 401); } } });
            const state = await gateway.state();
            assert.equal(state.configured, true); assert.equal(state.connected, false);
            assert.ok(!JSON.stringify(state).includes('legacy-panel-token'));
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
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
    await test('all a6api links use the announced vip domains', () => {
        const sources = Object.fromEntries(A6_DOMAIN_FILES.map(rel => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]));
        for (const [rel, source] of Object.entries(sources)) assert.doesNotMatch(source, OLD_ORIGINS, rel + ' still uses an old a6api domain');
        assert.match(sources['routing/lib/a6api-api.js'], new RegExp(`const ORIGIN = '${API_ORIGIN.replaceAll('.', '\\.')}'`));
        assert.match(sources['routing/lib/a6api-probe.js'], new RegExp(`${API_ORIGIN.replaceAll('.', '\\.')}\\/v1\\/chat\\/completions`));
        const tab = sources['routing/vendor/a6api-tab.js'];
        assert.doesNotMatch(tab, /https:\/\/a6api\.vip\/console/);
        assert.equal((tab.match(/https:\/\/a6api\.vip\/\?auth=register&amp;aff=9eKT/g) || []).length, 2,
            'both a6api site links must use the owner referral');
        for (const rel of ['tools/probe-pro-full.js', 'tools/probe-pro-vision.js']) assert.match(sources[rel], /hostname: 'api\.a6api\.vip'/, rel + ' does not use the new API hostname');
    });
    await test('new runtime is isolated, private, non-rotating and single-attempt', () => {
        const x = buildRuntimeConfig({ secretDir: '/private', routingDir: '/routing' });
        assert.equal(x.converter.strictToolsVision, true); assert.deepEqual(x.converter.modelMap, {});
        assert.equal(x.converter.upstream, API_ORIGIN + '/v1');
        assert.equal(x.keepaliveEnv.KEY_FILE, path.join('/private', 'a6api-active-key.txt'));
        assert.equal(x.keepaliveEnv.UPSTREAM, 'http://127.0.0.1:20192');
        assert.equal(x.keepaliveEnv.SESSIONS_FILE, ''); assert.equal(x.keepaliveEnv.PAID_SINGLE_KEY, '1');
        assert.equal(x.keepaliveEnv.MODELMAP_FILE, path.join('/routing', 'a6api-modelmap.json'));
        assert.equal(x.keepaliveEnv.POOL_FALLBACK_MODEL, '');
    });
    console.log(`check-a6api-gateway: ${passed} passed`);
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
