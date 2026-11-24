#!/usr/bin/env node
'use strict';
// Real a6api gateway with actual dashboard map-writer seams in disposable files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test, after } = require('node:test');
const root = path.resolve(__dirname, '..');
const scratch = path.resolve(process.env.HERMES_TEST_SCRATCH || process.env.TMPDIR || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch') : path.join(os.homedir(), '.cache/hermes/scratch')));
fs.mkdirSync(scratch, { recursive: true });
const run = fs.mkdtempSync(path.join(scratch, 'a6api-map-preservation-'));
Object.assign(process.env, { HOME: path.join(run, 'home'), USERPROFILE: path.join(run, 'home'),
    TMPDIR: run, TMP: run, TEMP: run, ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(run, 'local-hop.key') });
const source = fs.readFileSync(path.join(root, 'routing/transparent-proxy.js'), 'utf8');
const { createGateway } = require('../routing/lib/a6api-gateway.js');
const { writeJsonSync: durableWriteJson } = require('../routing/lib/durable-write.js');
const model = 'family/exact-permitted';
const results = [];
function sourceFunction(name) {
    const start = source.indexOf('function ' + name + '('), end = source.indexOf('\n}', start);
    assert.ok(start >= 0 && end > start, 'actual source function ' + name);
    return source.slice(start, end + 2);
}
function fixture(name) {
    const dir = fs.mkdtempSync(path.join(run, name + '-'));
    const routing = path.join(dir, 'routing'), secrets = path.join(dir, 'home/.secrets');
    fs.mkdirSync(routing, { recursive: true }); fs.mkdirSync(secrets, { recursive: true });
    const provider = { default: 'native-default-before', opus: 'native-old-opus', sonnet: 'native-old-sonnet',
        haiku: 'native-old-haiku', gpt: 'preserved-native-gpt', futureField: { keep: [1, true] } };
    const routes = { default: 'independent-routes-default', opus: 'independent-route-opus', sonnet: 'independent-route-sonnet',
        haiku: 'independent-route-haiku', gpt: 'preserved-routes-gpt', futureField: { keep: 'routes' } };
    const providerPath = path.join(routing, 'a6api-modelmap.json'), routesPath = path.join(routing, 'a6api-routes-modelmap.json');
    fs.writeFileSync(providerPath, JSON.stringify(provider, null, 2) + '\n');
    fs.writeFileSync(routesPath, '\ufeff' + (JSON.stringify(routes, null, 2) + '\n').replaceAll('\n', '\r\n'));
    const api = { ownToken: async () => ({ id: 9, status: 1, expired_time: -1, unlimited_quota: true, model_limits_enabled: false }),
        models: async () => [model], reveal: async () => 'sk-local-fixture-not-a-live-key',
        state: async () => ({ account: {}, tokens: [{ id: 9, status: 1, expires: -1, unlimited: true, restricted: false, models: [model] }], models: [model] }) };
    const gateway = createGateway({ api, routingDir: routing, secretDir: secrets });
    const context = vm.createContext({ fs, path, __dirname: routing, ROUTE_TIERS: ['default', 'opus', 'sonnet', 'haiku', 'gpt'],
        CC_MODEL_PREFIX: { a6api: 'a6api' }, TIER_MIRROR_TIERS: ['opus', 'sonnet', 'haiku'], _tierMirrorBusy: false,
        a6Gateway: gateway, durableWriteJson, currentTarget: () => 'unrelated-provider', writeBackendsRegistry() {},
        a6CommitActivation() { throw new Error('no activation'); }, a6SyncMainModel() { throw new Error('no current model changes'); },
        logLine(message) { throw new Error('map writer unexpectedly failed: ' + message); } });
    for (const name of ['tierMapFile', 'routeTierMap', 'writeTierMap', 'mirrorTierMapPair', 'a6ReadMap']) {
        vm.runInContext(sourceFunction(name), context);
    }
    if (source.includes('function a6WriteMap(')) vm.runInContext(sourceFunction('a6WriteMap'), context);
    const start = source.indexOf('a6Gateway.setHub({'), end = source.indexOf('\n});', start);
    assert.ok(start > 0 && end > start, 'actual a6api production hook');
    vm.runInContext(source.slice(start, end + 4), context);
    return { gateway, provider, routes, providerPath, routesPath, context };
}

test('production a6api readMap preserves unknown fields for complete readback', async () => {
    const f = fixture('full-readback');
    const state = await f.gateway.state();
    assert.deepEqual(structuredClone(state.modelMap), f.provider);
    assert.deepEqual(structuredClone(state.routesMap), f.routes);
    results.push({ name: 'production-complete-readback', passed: true });
});

test('default-only a6api save does not reconcile unrelated tier drift in the paired file', async () => {
    const f = fixture('default-preserves-drift');
    await f.gateway.selectKey(9);
    const beforeRoutes = fs.readFileSync(f.routesPath);
    const saved = await f.gateway.saveModels(9, { default: model });
    assert.deepEqual(structuredClone(saved.modelMap), { ...f.provider, default: model });
    assert.deepEqual(structuredClone(saved.routesMap), f.routes);
    assert.deepEqual(fs.readFileSync(f.routesPath), beforeRoutes, 'the paired Routes file is not rewritten for a default-only edit');
    results.push({ name: 'default-only-preserves-drift-and-byte-exact-routes', passed: true });
});

test('Routes tier edits retain the shared mirror contract and each independent default', async () => {
    const f = fixture('route-mirror'); await f.gateway.selectKey(9);
    await f.gateway.saveRouteTier('opus', model);
    const provider = JSON.parse(fs.readFileSync(f.providerPath, 'utf8').replace(/^\ufeff/, ''));
    const routes = JSON.parse(fs.readFileSync(f.routesPath, 'utf8').replace(/^\ufeff/, ''));
    assert.equal(provider.opus, model); assert.equal(routes.opus, model);
    assert.equal(provider.default, f.provider.default); assert.equal(routes.default, f.routes.default);
    assert.equal(provider.gpt, f.provider.gpt); assert.equal(routes.gpt, f.routes.gpt);
    assert.deepEqual(provider.futureField, f.provider.futureField); assert.deepEqual(routes.futureField, f.routes.futureField);
    results.push({ name: 'routes-mirror-preserves-defaults-gpt-future-fields', passed: true });
});

after(() => {
    const receipt = path.join(run, 'receipt.json');
    fs.writeFileSync(receipt, JSON.stringify({ run, results, fixtureOnly: true, sourceLoadedInVm: true, productionLoaded: false }, null, 2) + '\n');
    console.log('a6api map-preservation receipt: ' + receipt);
});
