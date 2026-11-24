#!/usr/bin/env node
'use strict';
// External a6api panel data is an explicit LOCAL fixture, never live provider evidence.
// HTTP routes, gateway, manifest/Claude transaction and OpenCode writers below are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { after, test } = require('node:test');

assert.ok(process.env.TMPDIR, 'Run with an explicit scratch-local TMPDIR/TEMP/TMP');
const SCRATCH = path.resolve(process.env.TMPDIR);
assert.equal(path.resolve(os.tmpdir()), SCRATCH, 'TEMP/TMP must match the injected scratch root');
const RUN_ROOT = fs.mkdtempSync(path.join(SCRATCH, 'a6api-publication-fixture-'));
const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    HOME: path.join(RUN_ROOT, 'home'), USERPROFILE: path.join(RUN_ROOT, 'home'),
    TMPDIR: RUN_ROOT, TEMP: RUN_ROOT, TMP: RUN_ROOT,
    XDG_CONFIG_HOME: path.join(RUN_ROOT, 'xdg'), API_GATEWAY_WIKI_ROOT: path.join(RUN_ROOT, 'wiki'),
    ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(RUN_ROOT, 'fixture-local-hop.key'),
});
fs.mkdirSync(process.env.HOME, { recursive: true });

// The Node Permission Model forbids fsync entirely, so it cannot exercise the real
// durable writer. Guard fixture mutations here instead; never replace fsync with a mock.
const fsOriginals = new Map();
let writeViolations = 0;
function fixturePath(file) {
    if (typeof file === 'number') return;
    const resolved = path.resolve(file instanceof URL ? require('node:url').fileURLToPath(file) : String(file));
    const relative = path.relative(RUN_ROOT, resolved);
    if (!(relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))) {
        writeViolations += 1;
        throw new Error('writes must stay inside this disposable fixture run');
    }
}
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'truncateSync', 'chmodSync']) {
    const original = fs[name]; fsOriginals.set(name, original);
    fs[name] = (file, ...args) => { fixturePath(file); return original.call(fs, file, ...args); };
}
for (const name of ['renameSync', 'copyFileSync', 'linkSync', 'symlinkSync']) {
    const original = fs[name]; fsOriginals.set(name, original);
    fs[name] = (from, to, ...args) => { fixturePath(from); fixturePath(to); return original.call(fs, from, to, ...args); };
}
const openSync = fs.openSync; fsOriginals.set('openSync', openSync);
fs.openSync = (file, flags, ...args) => {
    if (typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
        : /[wa+]/.test(flags)) fixturePath(file);
    return openSync.call(fs, file, flags, ...args);
};

const ports = new Set();
let networkViolations = 0;
const actualFetch = globalThis.fetch.bind(globalThis);
function localUrl(url) {
    const value = new URL(url);
    if (value.protocol !== 'http:' || value.hostname !== '127.0.0.1' || !ports.has(Number(value.port))) {
        networkViolations += 1;
        throw new Error('Only owned dynamic fixture loopback endpoints are permitted');
    }
    return value;
}
globalThis.fetch = (url, options) => actualFetch(localUrl(url), options);
const realRequest = http.request;
http.request = (options, ...args) => {
    localUrl(`http://${options.hostname}:${options.port}${options.path || '/'}`);
    return realRequest.call(http, options, ...args);
};
const realHttpsRequest = https.request;
https.request = () => { networkViolations += 1; throw new Error('External HTTPS is prohibited in fixture tests'); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const raw = args[0];
    const options = Array.isArray(raw) ? raw[0] : raw;
    const host = typeof options === 'object' ? options.host : args[1];
    const port = typeof options === 'object' ? Number(options.port) : Number(options);
    if (!(host === '127.0.0.1' && ports.has(port))) {
        networkViolations += 1;
        throw new Error('only owned dynamic fixture sockets are allowed');
    }
    return connect.apply(this, args);
};

const manifestApi = require('../routing/lib/api-gateway.js');
const durable = require('../routing/lib/durable-write.js');
const { createClient } = require('../routing/lib/a6api-api.js');
const { createGateway } = require('../routing/lib/a6api-gateway.js');
const { createRoutes: createA6Routes } = require('../routing/lib/a6api-routes.js');
const { createOpenCodeService } = require('../routing/lib/api-gateway-opencode.js');
const { createProductionApiGateway } = require('../routing/lib/api-gateway-integration.js');
const PREFIX = '/__switch/api/api-gateway';
const MODEL = 'family/exact-model-1017';
const ID = `a6api/${MODEL}`;
const OTHER_ID = 'fixtureother/retained-model';
const OLD_ID = 'a6api/old-unavailable-model';
const FIXTURE_PRIVATE = 'fixture-private-canary-never-public';
const FIXTURE_KEY = 'sk-local-fixture-model-credential';
const checks = [];
const fixtures = [];
const finalResponses = [];
// Execute only these existing pure map-writer seams, never load the hub/dashboard.
const proxySource = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8');
function sourceFunction(name) {
    const start = proxySource.indexOf(`function ${name}(`);
    const end = proxySource.indexOf('\n}', start);
    assert.ok(start >= 0 && end > start, `production map writer seam ${name} exists`);
    return proxySource.slice(start, end + 2);
}

function writeJson(file, value, styled = false) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let text = JSON.stringify(value, null, 2) + '\n';
    if (styled) text = '\ufeff' + text.replace(/\n/g, '\r\n');
    fs.writeFileSync(file, text, 'utf8');
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '')); }
function metadata(overrides = {}) {
    return { displayName: 'Preserved fixture label', claudeBehavesAs: 'claude-sonnet-5',
        contextTokens: 234567, outputTokens: 12345, publishedAt: '2026-11-01T12:34:56.000Z', ...overrides };
}
function diskSnapshot(dir) {
    const result = {};
    function walk(base) {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            const file = path.join(base, entry.name);
            if (entry.isDirectory()) walk(file);
            else { assert.ok(entry.isFile(), 'fixture artifacts must be ordinary files'); result[path.relative(dir, file)] = fs.readFileSync(file).toString('base64'); }
        }
    }
    walk(dir);
    return result;
}
function omitPicker(value) { const copy = structuredClone(value); delete copy.modelPicker; return copy; }
function providerFor(manifest, native) {
    const models = Object.fromEntries(Object.entries(manifest.enabled ? manifest.models : {})
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([id, row]) => [id, { name: row.displayName, limit: { context: row.contextTokens, output: row.outputTokens } }]));
    const options = { baseURL: 'http://127.0.0.1:20100/openai/v1', apiKey: 'dummy', timeout: 600000 };
    return native ? { package: 'aisdk:@ai-sdk/openai-compatible', name: 'ABUSE HUB', settings: options, models }
        : { npm: '@ai-sdk/openai-compatible', name: 'ABUSE HUB', options, models };
}
async function listen(t, server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    ports.add(port);
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        ports.delete(port);
    });
    return port;
}
function send(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
}
async function fixture(t, name, options = {}) {
    const dir = fs.mkdtempSync(path.join(RUN_ROOT, `${name}-`));
    const home = path.join(dir, 'home');
    const repoRoot = path.join(dir, 'hub');
    const wikiRoot = path.join(dir, 'wiki');
    const secretDir = path.join(home, '.secrets');
    const routingDir = path.join(repoRoot, 'routing');
    const paths = { manifestPath: path.join(routingDir, 'api-gateway.json'),
        defaultManifestPath: path.join(routingDir, 'api-gateway.default.json'),
        backendsPath: path.join(home, '.claude', 'backends.json'), settingsPath: path.join(home, '.claude', 'settings.json') };
    const initial = { version: 1, revision: 7, enabled: options.enabled ?? true,
        models: { [OTHER_ID]: metadata(), [OLD_ID]: metadata({ displayName: 'Unavailable retained publication' }), ...(options.models || {}) } };
    const settings = { model: 'fixtureother/unchanged-current[1m]', env: { FIXTURE_CANARY: FIXTURE_PRIVATE },
        modelPicker: manifestApi.buildModelPicker(initial), permissions: { allow: ['Read'], deny: ['Network'] },
        modelSettings: { effort: 'high' }, unknownFutureField: { keep: [true, 1] } };
    const maps = { provider: { default: '', opus: 'stale-opus', sonnet: '', haiku: 'stale-haiku', gpt: 'preserved-gpt' },
        routes: { default: 'independent-routes-default', opus: 'stale-opus', sonnet: '', haiku: 'stale-haiku', gpt: 'routes-gpt' } };
    const mapPaths = { provider: path.join(routingDir, 'a6api-modelmap.json'), routes: path.join(routingDir, 'a6api-routes-modelmap.json') };
    writeJson(paths.manifestPath, initial); writeJson(paths.defaultManifestPath, initial);
    writeJson(paths.backendsPath, { providers: { a6api: {}, fixtureother: {} }, aliases: { a6: 'a6api' }, activeProvider: 'fixtureother' });
    writeJson(paths.settingsPath, settings, true);
    writeJson(mapPaths.provider, maps.provider); writeJson(mapPaths.routes, maps.routes);
    writeJson(path.join(secretDir, 'a6api-config.json'), { userId: 314, panelToken: FIXTURE_PRIVATE });
    const schemas = ['native', 'legacy', 'missing'];
    const opencodeTargets = ['User config', 'Wiki config', 'Hub config'].map((label, index) => ({ label,
        path: path.join(dir, ['user-opencode', 'wiki-opencode', 'hub-opencode'][index], 'opencode.json') }));
    const configs = schemas.map((schema, index) => {
        if (schema === 'missing') return null;
        const config = { model: 'fixtureother/unchanged-current', small_model: 'fixtureother/unchanged-small',
            agents: { build: { model: 'fixtureother/unchanged-agent' } }, permission: { edit: 'ask' },
            mcp: { fixture: { command: ['never-run'] } }, futureField: { keep: true },
            [schema === 'native' ? 'providers' : 'provider']: {
                other: { name: 'Retained', settings: { apiKey: FIXTURE_PRIVATE } }, 'abuse-hub': providerFor(initial, schema === 'native') } };
        writeJson(opencodeTargets[index].path, config, index === 0); return config;
    });
    const panel = { token: { id: 9, name: 'local-fixture', key: FIXTURE_KEY, status: 1, expired_time: -1,
        unlimited_quota: true, remain_quota: 0, used_quota: 3, model_limits_enabled: true, model_limits: MODEL },
        catalog: [MODEL, 'family/exact-model', 'gpt-image-2'], calls: [], failTokens: null, failCatalog: null, tokenMissing: false,
        afterCatalog: null };
    const panelServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        panel.calls.push(`${req.method} ${url.pathname}`);
        if (req.method === 'GET' && url.pathname === '/api/token/') {
            if (panel.failTokens) return send(res, panel.failTokens, { success: false, message: FIXTURE_PRIVATE });
            return send(res, 200, { success: true, data: { total: panel.tokenMissing ? 0 : 1, items: panel.tokenMissing ? [] : [panel.token] } });
        }
        if (req.method === 'GET' && url.pathname === '/api/pricing') {
            if (panel.failCatalog) return send(res, panel.failCatalog, { success: false, message: FIXTURE_PRIVATE });
            if (panel.afterCatalog) await panel.afterCatalog();
            return send(res, 200, { success: true, data: panel.catalog.map(model_name => ({ model_name })) });
        }
        if (req.method === 'GET' && url.pathname === '/api/user/self') return send(res, 200, { success: true, data: { id: 314, quota: 5, used_quota: 1 } });
        if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { success: true, data: { quota_per_unit: 1 } });
        if (req.method === 'POST' && url.pathname === '/api/token/9/key') return send(res, 200, { success: true, data: { key: FIXTURE_KEY } });
        return send(res, 404, { success: false, message: 'Only explicit panel fixture endpoints exist' });
    });
    const panelPort = await listen(t, panelServer);
    const api = createClient({ secretDir, token: FIXTURE_PRIVATE, userId: 314, timeoutMs: 3000,
        fetchImpl: (url, request) => {
            const parsed = new URL(url);
            assert.equal(parsed.origin, 'https://api.a6api.vip', 'real panel client must retain its production origin');
            return globalThis.fetch(`http://127.0.0.1:${panelPort}${parsed.pathname}${parsed.search}`, request);
        } });
    const hubCalls = [];
    let nativeActive = false;
    const mapWriter = vm.createContext({ fs, path,
        TIER_MIRROR_TIERS: ['opus', 'sonnet', 'haiku'], _tierMirrorBusy: false,
        logLine() { throw new Error('production mirror must not fail in a fixture'); } });
    vm.runInContext(sourceFunction('writeTierMap') + '\n' + sourceFunction('mirrorTierMapPair'), mapWriter);
    const hub = { readMap: routes => readJson(mapPaths[routes ? 'routes' : 'provider']),
        writeMap(patch, routes) {
            hubCalls.push('writeMap');
            const result = mapWriter.writeTierMap(mapPaths[routes ? 'routes' : 'provider'], patch, '');
            if (options.afterMapWrite) options.afterMapWrite({ mapPaths, patch, routes });
            return result;
        },
        isActive: () => nativeActive,
        ensure: async () => { hubCalls.push('ensure'); return { ok: true }; },
        activate: async () => { hubCalls.push('activate'); nativeActive = true; },
        syncModel: async model => { hubCalls.push('syncModel'); const next = readJson(paths.settingsPath); next.model = model; durable.writeJsonSync(paths.settingsPath, next); },
        publish: () => { hubCalls.push('publish'); } };
    const gateway = createGateway({ api, secretDir, routingDir, hub });
    let saves = 0, syncs = 0, validations = 0;
    const product = createProductionApiGateway({ repoRoot, home, wikiRoot, paths,
        xdgConfigHome: path.join(dir, 'xdg'), localAppData: path.join(dir, 'local'), pathEnv: '',
        manifestApi: { ...manifestApi, saveManifestAndPicker(input) { saves += 1; return manifestApi.saveManifestAndPicker(input); } },
        validatePublication: async input => { validations += 1; return options.validatePublication
            ? options.validatePublication(input) : gateway.validatePublication(input); },
        candidateOptions: { providers: [] },
        resolveModelCandidates: async () => { throw new Error('publication must not discover provider health'); },
        sidecarStatus: async () => { throw new Error('publication must not probe sidecars'); },
        readPassive: async () => { throw new Error('publication must not read inference health'); },
        readProbes: async () => { throw new Error('publication must not probe paid models'); },
        opencodeTargets, opencodeJournalPath: path.join(routingDir, 'runtime', 'opencode.txn'),
        openCodeFactory: serviceOptions => {
            const real = createOpenCodeService({ ...serviceOptions, ...(options.openCodeOptions || {}) });
            return { ...real, sync(manifest) { syncs += 1; return real.sync(manifest); } };
        },
        hermesFactory: () => ({ status() { throw new Error('must not inspect current Hermes model'); }, sync() { throw new Error('must not mutate current Hermes model'); } }) });
    const a6Routes = createA6Routes({ gateway, secretDir });
    const server = http.createServer((req, res) => {
        if (!product.routes.handle(req, res) && !a6Routes.handle(req, res)) send(res, 404, {});
    });
    const port = await listen(t, server);
    const post = async (body, overrides = {}) => {
        const pathname = overrides.pathname || `${PREFIX}/publication`;
        const response = await globalThis.fetch(`http://127.0.0.1:${port}${pathname}`, {
            method: overrides.method || 'POST', headers: { origin: `http://127.0.0.1:${port}`,
                'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(overrides.headers || {}) },
            ...(overrides.method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
        const text = await response.text();
        assert.equal(text.includes(FIXTURE_PRIVATE), false, 'responses never disclose the panel fixture canary');
        assert.equal(text.includes(FIXTURE_KEY), false, 'responses never disclose the model fixture credential');
        assert.equal(text.includes(dir), false, 'responses never disclose injected private paths');
        finalResponses.push({ name, pathname, status: response.status, dto: JSON.parse(text) });
        return { status: response.status, dto: JSON.parse(text), text };
    };
    const f = { dir, home, secretDir, routingDir, mapPaths, maps, paths, initial, settings, configs, schemas,
        panel, gateway, hubCalls, product, opencodeTargets, post,
        saves: () => saves, syncs: () => syncs, validations: () => validations,
        async prepare() {
            const result = await post({ tokenId: 9 }, { pathname: '/__switch/api/a6api/key' });
            assert.equal(result.status, 200); assert.equal(result.dto.selectedTokenId, 9);
            panel.calls.length = 0; hubCalls.length = 0;
        },
        setActive(value) { nativeActive = value; } };
    fixtures.push(f);
    return f;
}
function assertNoCommit(f, before) {
    assert.equal(f.saves(), 0, 'denied enable must not call the manifest/picker transaction');
    assert.equal(f.syncs(), 0, 'denied enable must not call OpenCode Sync');
    assert.deepEqual(diskSnapshot(f.dir), before, 'denied enable preserves every fixture artifact byte-for-byte');
    assert.deepEqual(f.hubCalls, [], 'publication never mutates native/current state');
}
function assertProjection(f, manifest) {
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(manifest));
    assert.deepEqual(omitPicker(readJson(f.paths.settingsPath)), omitPicker(f.settings));
    for (const [index, target] of f.opencodeTargets.entries()) {
        const expected = structuredClone(f.configs[index] || {});
        const native = f.schemas[index] === 'native';
        const block = native ? 'providers' : 'provider';
        expected[block] ||= {}; expected[block]['abuse-hub'] = providerFor(manifest, native);
        assert.deepEqual(readJson(target.path), expected, `${target.label}: only abuse-hub publication changes`);
    }
    assert.equal(f.product.openCodeService.status(manifest).status, 'synced');
    assert.deepEqual(readJson(f.mapPaths.provider), f.maps.provider);
    assert.deepEqual(readJson(f.mapPaths.routes), f.maps.routes);
    assert.deepEqual(f.hubCalls, []);
}
function check(name, run) {
    test(name, { concurrency: false }, async t => {
        const row = { name, passed: false }; checks.push(row);
        try { await run(t); row.passed = true; }
        catch (error) { row.failure = String(error.message); throw error; }
    });
}

check('shared publication denies a new a6api model when no key is prepared', async t => {
    const f = await fixture(t, 'missing-key');
    const before = diskSnapshot(f.dir);
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 409, 'new a6api publication requires the currently prepared selected key');
    assert.equal(response.dto.code, 'a6api_key_not_selected');
    assert.deepEqual(f.panel.calls, [], 'missing preparation must fail before panel/catalog reads');
    assertNoCommit(f, before);
});

check('shared publication denies an exact model absent from selected key permissions', async t => {
    const f = await fixture(t, 'restricted-model');
    await f.prepare();
    const before = diskSnapshot(f.dir);
    const response = await f.post({ expectedRevision: 7, id: 'a6api/family/exact-model', published: true });
    assert.equal(response.status, 409, 'a similar permitted dated model must not allow a different exact ID');
    assert.equal(response.dto.code, 'a6api_model_unavailable');
    assertNoCommit(f, before);
});

check('prepared permitted exact publication persists all real pickers with empty or stale native CC maps', async t => {
    const f = await fixture(t, 'valid-exact-no-maps');
    await f.prepare();
    const selectionBefore = fs.readFileSync(path.join(f.secretDir, 'a6api-gateway.json'));
    const keyBefore = fs.readFileSync(path.join(f.secretDir, 'a6api-active-key.txt'));
    const backendsBefore = fs.readFileSync(f.paths.backendsPath);
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 200, 'allowed exact model must not require native default or opus/sonnet/haiku maps');
    assert.equal(response.dto.ok, true); assert.equal(response.dto.opencode.ok, true);
    const current = readJson(f.paths.manifestPath);
    assert.equal(current.revision, 8);
    assert.deepEqual(current.models[OLD_ID], f.initial.models[OLD_ID]);
    assert.deepEqual(current.models[OTHER_ID], f.initial.models[OTHER_ID]);
    assert.equal(current.models[ID].displayName, `a6api / ${MODEL}`);
    assert.equal(current.models[ID].contextTokens, 1000000);
    assert.equal(current.models[ID].outputTokens, 32000);
    assert.equal(current.models[ID].claudeBehavesAs, 'claude-opus-5');
    assert.equal(f.saves(), 1); assert.equal(f.syncs(), 1);
    assertProjection(f, current);
    assert.deepEqual(fs.readFileSync(path.join(f.secretDir, 'a6api-gateway.json')), selectionBefore);
    assert.deepEqual(fs.readFileSync(path.join(f.secretDir, 'a6api-active-key.txt')), keyBefore);
    assert.deepEqual(fs.readFileSync(f.paths.backendsPath), backendsBefore);
    assert.ok(f.panel.calls.length > 0 && f.panel.calls.every(call => call === 'GET /api/token/' || call === 'GET /api/pricing'),
        'enable validation reads panel/catalog only; never reveals a key, probes inference or activates');
    const refreshed = await f.post({}, { method: 'GET', pathname: PREFIX });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.dto.models.find(row => row.id === ID).published, true);
    assert.deepEqual(manifestApi.readPublishedManifest(f.paths), current, 'reload reads the durable committed state');
});

check('advanced metadata add cannot bypass the a6api preparation gate', async t => {
    const f = await fixture(t, 'advanced-missing-key');
    const before = diskSnapshot(f.dir);
    const response = await f.post({ expectedRevision: 7, id: ID, published: true,
        displayName: 'Advanced fixture label', claudeBehavesAs: 'claude-haiku-5', contextTokens: 987654, outputTokens: 7890 },
    { pathname: `${PREFIX}/model` });
    assert.equal(response.status, 409, 'the advanced model add path must enforce the same provider gate');
    assert.equal(response.dto.code, 'a6api_key_not_selected');
    assertNoCommit(f, before);
});

check('expired selected keys fail both add paths with a safe stable provider error', async t => {
    for (const pathname of [`${PREFIX}/publication`, `${PREFIX}/model`]) {
        const f = await fixture(t, pathname.endsWith('/model') ? 'expired-advanced' : 'expired-shared');
        await f.prepare();
        f.panel.token.expired_time = 1;
        const before = diskSnapshot(f.dir);
        const body = { expectedRevision: 7, id: ID, published: true,
            ...(pathname.endsWith('/model') ? { displayName: 'Fixture', claudeBehavesAs: 'claude-opus-5', contextTokens: 111111, outputTokens: 2222 } : {}) };
        const response = await f.post(body, { pathname });
        assert.equal(response.status, 409);
        assert.equal(response.dto.code, 'a6api_token_expired', 'provider-specific stable expiry code must survive the shared API');
        assert.equal(response.dto.error, 'Срок выбранного ключа a6api истёк. Измените срок в кабинете или используйте другой ключ.');
        assertNoCommit(f, before);
    }
});

check('disabled selected keys report a stable safe provider code before any write', async t => {
    const f = await fixture(t, 'disabled-key'); await f.prepare();
    f.panel.token.status = 2;
    const before = diskSnapshot(f.dir);
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 409);
    assert.equal(response.dto.code, 'a6api_token_disabled');
    assert.equal(response.dto.error, 'Выбранный ключ a6api выключен или недоступен. Используйте рабочий ключ.');
    assertNoCommit(f, before);
});

check('exhausted finite selected key quota reports a stable safe provider error', async t => {
    const f = await fixture(t, 'quota-key'); await f.prepare();
    f.panel.token.unlimited_quota = false; f.panel.token.remain_quota = 0;
    const before = diskSnapshot(f.dir);
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 409);
    assert.equal(response.dto.code, 'a6api_token_quota');
    assert.equal(response.dto.error, 'Лимит выбранного ключа a6api исчерпан. Измените лимит в кабинете или используйте другой ключ.');
    assertNoCommit(f, before);
});

check('unavailable catalog denies enable with a safe distinct provider error', async t => {
    const f = await fixture(t, 'catalog-failure'); await f.prepare();
    f.panel.failCatalog = 504;
    const before = diskSnapshot(f.dir);
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 503);
    assert.equal(response.dto.code, 'a6api_catalog_unavailable');
    assert.equal(response.dto.error, 'Не удалось проверить разрешённый каталог a6api. Публикации сохранены; повторите позже.');
    assertNoCommit(f, before);
});

check('deleted selected token reports a stable missing-key reason before writes', async t => {
    const f = await fixture(t, 'deleted-token'); await f.prepare();
    f.panel.tokenMissing = true;
    const before = diskSnapshot(f.dir);
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 409);
    assert.equal(response.dto.code, 'a6api_token_missing');
    assert.equal(response.dto.error, 'Выбранный ключ a6api больше не найден в кабинете. Используйте другой ключ.');
    assertNoCommit(f, before);
});

check('stale advanced add revision fails before provider-key or catalog validation', async t => {
    const f = await fixture(t, 'advanced-revision-conflict');
    const before = diskSnapshot(f.dir);
    const response = await f.post({ expectedRevision: 6, id: ID, published: true,
        displayName: 'Fixture', claudeBehavesAs: 'claude-opus-5', contextTokens: 111111, outputTokens: 2222 },
    { pathname: `${PREFIX}/model` });
    assert.equal(response.status, 409);
    assert.equal(response.dto.code, 'api_gateway_revision_conflict');
    assert.equal(f.validations(), 0, 'optimistic lock conflict precedes provider availability checks');
    assert.deepEqual(f.panel.calls, []);
    assertNoCommit(f, before);
});

check('native default-only save accepts permitted model while untouched native tiers are unavailable', async t => {
    const f = await fixture(t, 'default-only-save'); await f.prepare();
    const routesBefore = fs.readFileSync(f.mapPaths.routes);
    const settingsBefore = fs.readFileSync(f.paths.settingsPath);
    const manifestBefore = fs.readFileSync(f.paths.manifestPath);
    const selectionBefore = fs.readFileSync(path.join(f.secretDir, 'a6api-gateway.json'));
    const response = await f.post({ tokenId: 9, modelMap: { default: MODEL } }, { pathname: '/__switch/api/a6api/modelmap' });
    assert.equal(response.status, 200, 'a permitted default-only edit must not validate unchanged unavailable tiers');
    assert.deepEqual(response.dto.modelMap, { ...f.maps.provider, default: MODEL });
    assert.deepEqual(response.dto.routesMap, f.maps.routes);
    assert.deepEqual(readJson(f.mapPaths.provider), { ...f.maps.provider, default: MODEL });
    assert.deepEqual(fs.readFileSync(f.mapPaths.routes), routesBefore, 'entire routes map and independent default are byte-exact unchanged');
    assert.deepEqual(fs.readFileSync(f.paths.settingsPath), settingsBefore, 'inactive native compatibility save must not choose a current session model');
    assert.deepEqual(fs.readFileSync(f.paths.manifestPath), manifestBefore);
    assert.deepEqual(fs.readFileSync(path.join(f.secretDir, 'a6api-gateway.json')), selectionBefore);
    assert.equal(f.saves(), 0); assert.equal(f.syncs(), 0);
    assert.deepEqual(f.hubCalls, ['writeMap', 'publish']);
});

check('state does not advertise a finite exhausted selected key as prepared', async t => {
    const f = await fixture(t, 'state-quota'); await f.prepare();
    f.panel.token.unlimited_quota = false; f.panel.token.remain_quota = 0;
    const response = await f.post({}, { method: 'GET', pathname: '/__switch/api/a6api/state' });
    assert.equal(response.status, 200);
    assert.equal(response.dto.prepared, false, 'state and publication validation must agree on quota exhaustion');
    assert.equal(response.dto.keyStatus, 'a6api_token_quota');
    assert.deepEqual(response.dto.modelMap, f.maps.provider); assert.deepEqual(response.dto.routesMap, f.maps.routes);
    assert.deepEqual(readJson(f.paths.manifestPath), f.initial);
    assert.deepEqual(f.hubCalls, []);
});

check('state describes an unselected key without inferring native defaults or health', async t => {
    const f = await fixture(t, 'state-unselected');
    const response = await f.post({}, { method: 'GET', pathname: '/__switch/api/a6api/state' });
    assert.equal(response.status, 200);
    assert.equal(response.dto.keyStatus, 'a6api_key_not_selected');
    assert.equal(response.dto.selectedTokenId, null); assert.equal(response.dto.prepared, false);
    assert.deepEqual(response.dto.models, []); assert.deepEqual(f.hubCalls, []);
});

check('state reports expiry without clearing publication metadata or native maps', async t => {
    const f = await fixture(t, 'state-expired'); await f.prepare(); f.panel.token.expired_time = 1;
    const response = await f.post({}, { method: 'GET', pathname: '/__switch/api/a6api/state' });
    assert.equal(response.status, 200); assert.equal(response.dto.prepared, false);
    assert.equal(response.dto.keyStatus, 'a6api_token_expired');
    assert.deepEqual(response.dto.models, [MODEL]);
    assert.deepEqual(readJson(f.paths.manifestPath), f.initial);
    assert.deepEqual(response.dto.modelMap, f.maps.provider); assert.deepEqual(response.dto.routesMap, f.maps.routes);
});

check('state reports disabled selected token even when its quota remains usable', async t => {
    const f = await fixture(t, 'state-disabled'); await f.prepare(); f.panel.token.status = 2;
    const response = await f.post({}, { method: 'GET', pathname: '/__switch/api/a6api/state' });
    assert.equal(response.status, 200); assert.equal(response.dto.prepared, false);
    assert.equal(response.dto.keyStatus, 'a6api_token_disabled');
    assert.equal(response.dto.selectedTokenId, 9); assert.deepEqual(readJson(f.paths.manifestPath), f.initial);
});

check('state keeps the selected ID but identifies a token removed from the panel', async t => {
    const f = await fixture(t, 'state-deleted-token'); await f.prepare(); f.panel.tokenMissing = true;
    const response = await f.post({}, { method: 'GET', pathname: '/__switch/api/a6api/state' });
    assert.equal(response.status, 200); assert.equal(response.dto.prepared, false);
    assert.equal(response.dto.keyStatus, 'a6api_token_missing');
    assert.equal(response.dto.selectedTokenId, 9); assert.deepEqual(readJson(f.paths.manifestPath), f.initial);
});

check('state distinguishes unprepared key material from a valid saved token selection', async t => {
    const f = await fixture(t, 'state-unprepared'); await f.prepare();
    fs.writeFileSync(path.join(f.secretDir, 'a6api-active-key.txt'), 'sk-replaced-local-fixture');
    const response = await f.post({}, { method: 'GET', pathname: '/__switch/api/a6api/state' });
    assert.equal(response.status, 200); assert.equal(response.dto.prepared, false);
    assert.equal(response.dto.keyStatus, 'a6api_key_unprepared'); assert.equal(response.dto.selectedTokenId, 9);
    assert.deepEqual(readJson(f.paths.manifestPath), f.initial); assert.deepEqual(f.hubCalls, []);
});

check('state keeps selected key identity and distinct catalog-unavailable status during catalog failure', async t => {
    const f = await fixture(t, 'state-catalog-unavailable'); await f.prepare(); f.panel.failCatalog = 504;
    const selectionBefore = fs.readFileSync(path.join(f.secretDir, 'a6api-gateway.json'));
    const response = await f.post({}, { method: 'GET', pathname: '/__switch/api/a6api/state' });
    assert.equal(response.status, 200); assert.equal(response.dto.prepared, false);
    assert.equal(response.dto.keyStatus, 'a6api_catalog_unavailable');
    assert.equal(response.dto.selectedTokenId, 9, 'a failed catalog must not masquerade as no saved key');
    assert.deepEqual(response.dto.models, []);
    assert.deepEqual(fs.readFileSync(path.join(f.secretDir, 'a6api-gateway.json')), selectionBefore);
    assert.deepEqual(readJson(f.paths.manifestPath), f.initial); assert.deepEqual(f.hubCalls, []);
});

check('hide always skips key catalog and health checks even with missing expired or disconnected credentials', async t => {
    for (const mode of ['missing-selection', 'expired', 'disconnected-catalog', 'replaced-key']) {
        const f = await fixture(t, `hide-${mode}`);
        if (mode !== 'missing-selection') await f.prepare();
        if (mode === 'expired') f.panel.token.expired_time = 1;
        if (mode === 'disconnected-catalog') { f.panel.failTokens = 401; f.panel.failCatalog = 504; }
        if (mode === 'replaced-key') fs.writeFileSync(path.join(f.secretDir, 'a6api-active-key.txt'), 'sk-replaced-local-fixture');
        const selectionBefore = diskSnapshot(f.secretDir);
        const response = await f.post({ expectedRevision: 7, id: OLD_ID, published: false });
        assert.equal(response.status, 200, mode); assert.equal(response.dto.model.published, false);
        assert.equal(response.dto.opencode.ok, true, mode);
        assert.deepEqual(f.panel.calls, [], 'hide must never call the provider panel');
        assert.equal(f.validations(), 0, 'hide skips the provider validation dependency itself');
        const current = readJson(f.paths.manifestPath);
        assert.equal(current.revision, 8); assert.equal(Object.hasOwn(current.models, OLD_ID), false);
        assert.deepEqual(current.models[OTHER_ID], f.initial.models[OTHER_ID]);
        assertProjection(f, current); assert.deepEqual(diskSnapshot(f.secretDir), selectionBefore);
    }
});

check('advanced metadata edits of already published models remain possible when credentials are unavailable', async t => {
    const f = await fixture(t, 'advanced-existing-metadata'); f.panel.failTokens = 401; f.panel.failCatalog = 504;
    const response = await f.post({ expectedRevision: 7, id: OLD_ID, published: true,
        displayName: 'Edited unavailable publication', claudeBehavesAs: 'claude-haiku-5', contextTokens: 1000000, outputTokens: 25000 },
    { pathname: `${PREFIX}/model` });
    assert.equal(response.status, 200); assert.equal(response.dto.revision, 8);
    assert.equal(f.validations(), 0); assert.deepEqual(f.panel.calls, []); assert.equal(f.syncs(), 0, 'advanced response/explicit sync contract is unchanged');
    const current = readJson(f.paths.manifestPath);
    assert.equal(current.models[OLD_ID].displayName, 'Edited unavailable publication');
    assert.equal(current.models[OLD_ID].publishedAt, f.initial.models[OLD_ID].publishedAt);
    assert.deepEqual(current.models[OTHER_ID], f.initial.models[OTHER_ID]);
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(current));
    assert.deepEqual(omitPicker(readJson(f.paths.settingsPath)), omitPicker(f.settings));
    assert.deepEqual(f.hubCalls, []);
});

check('another canonical provider can publish while a6api has no selected key', async t => {
    const f = await fixture(t, 'other-provider');
    const otherId = 'fixtureother/new-model';
    const response = await f.post({ expectedRevision: 7, id: otherId, published: true });
    assert.equal(response.status, 200); assert.equal(response.dto.opencode.ok, true);
    assert.deepEqual(f.panel.calls, []);
    const current = readJson(f.paths.manifestPath);
    assert.equal(Object.hasOwn(current.models, otherId), true);
    assert.deepEqual(current.models[OLD_ID], f.initial.models[OLD_ID]); assertProjection(f, current);
});

check('healthy unlimited selected key has an explicit ready code even with zero remaining quota', async t => {
    const f = await fixture(t, 'state-ready'); await f.prepare();
    const response = await f.post({}, { method: 'GET', pathname: '/__switch/api/a6api/state' });
    assert.equal(response.status, 200); assert.equal(response.dto.prepared, true);
    assert.equal(response.dto.keyStatus, 'a6api_key_ready');
    assert.deepEqual(response.dto.models, [MODEL]); assert.deepEqual(f.hubCalls, []);
});

check('known missing-key publication error exposes only a literal actionable message', async t => {
    const f = await fixture(t, 'missing-key-safe-message');
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 409); assert.equal(response.dto.code, 'a6api_key_not_selected');
    assert.equal(response.dto.error, 'Сначала выберите и подготовьте ключ a6api кнопкой «Использовать ключ».');
});

check('known exact-model permission error exposes an actionable literal message', async t => {
    const f = await fixture(t, 'model-safe-message'); await f.prepare();
    const response = await f.post({ expectedRevision: 7, id: 'a6api/family/exact-model', published: true });
    assert.equal(response.status, 409); assert.equal(response.dto.code, 'a6api_model_unavailable');
    assert.equal(response.dto.error, 'Эта exact модель не разрешена выбранному ключу a6api или отсутствует в текстовом каталоге.');
});

check('key material replaced during permission lookup cannot publish using the old selection', async t => {
    const f = await fixture(t, 'selection-race'); await f.prepare();
    let afterOwnerReplacement;
    f.panel.afterCatalog = () => {
        fs.writeFileSync(path.join(f.secretDir, 'a6api-active-key.txt'), 'sk-replacement');
        afterOwnerReplacement = diskSnapshot(f.dir);
    };
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 409, 'enable must recheck current prepared selection after asynchronous permitted catalog lookup');
    assert.equal(response.dto.code, 'a6api_key_not_selected');
    assertNoCommit(f, afterOwnerReplacement);
});

check('permitted catalog is necessary even for an unrestricted selected key', async t => {
    const f = await fixture(t, 'catalog-required'); await f.prepare(); f.panel.token.model_limits_enabled = false;
    f.panel.catalog = [];
    const before = diskSnapshot(f.dir);
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 409); assert.equal(response.dto.code, 'a6api_model_unavailable');
    assertNoCommit(f, before);
});

check('text-only filtering rejects media even if selected token explicitly permits it', async t => {
    const f = await fixture(t, 'media-restriction'); await f.prepare();
    f.panel.token.model_limits = 'gpt-image-2';
    const before = diskSnapshot(f.dir);
    const response = await f.post({ expectedRevision: 7, id: 'a6api/gpt-image-2', published: true });
    assert.equal(response.status, 409); assert.equal(response.dto.code, 'a6api_model_unavailable');
    assertNoCommit(f, before);
});

check('advanced add validates exact permissions while keeping submitted metadata', async t => {
    const f = await fixture(t, 'advanced-permissions'); await f.prepare();
    const fields = { displayName: 'Explicit advanced label', claudeBehavesAs: 'claude-haiku-5', contextTokens: 543210, outputTokens: 4321 };
    const before = diskSnapshot(f.dir);
    const denied = await f.post({ expectedRevision: 7, id: 'a6api/family/exact-model', published: true, ...fields }, { pathname: `${PREFIX}/model` });
    assert.equal(denied.status, 409); assert.equal(denied.dto.code, 'a6api_model_unavailable'); assertNoCommit(f, before);
    const accepted = await f.post({ expectedRevision: 7, id: ID, published: true, ...fields }, { pathname: `${PREFIX}/model` });
    assert.equal(accepted.status, 200); assert.equal(accepted.dto.revision, 8);
    const current = readJson(f.paths.manifestPath);
    const added = { ...current.models[ID] }; delete added.publishedAt;
    assert.deepEqual(added, fields); assert.deepEqual(current.models[OLD_ID], f.initial.models[OLD_ID]);
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(current));
    assert.deepEqual(omitPicker(readJson(f.paths.settingsPath)), omitPicker(f.settings));
    assert.deepEqual(readJson(f.mapPaths.provider), f.maps.provider); assert.deepEqual(readJson(f.mapPaths.routes), f.maps.routes);
});

check('publication retry preserves already published metadata and never turns it into a native current model', async t => {
    const f = await fixture(t, 'existing-exact', { models: { [ID]: metadata({ displayName: 'Custom exact publication' }) } }); await f.prepare();
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 200); assert.equal(response.dto.opencode.ok, true);
    const current = readJson(f.paths.manifestPath); assert.deepEqual(current.models[ID], f.initial.models[ID]);
    assertProjection(f, current);
});

check('native activation still requires all four permitted maps after default-only save', async t => {
    const f = await fixture(t, 'activation-full-map'); await f.prepare();
    const saved = await f.post({ tokenId: 9, modelMap: { default: MODEL } }, { pathname: '/__switch/api/a6api/modelmap' });
    assert.equal(saved.status, 200); f.hubCalls.length = 0;
    const before = diskSnapshot(f.dir);
    const activation = await f.post({ tokenId: 9 }, { pathname: '/__switch/api/a6api/activate' });
    assert.equal(activation.status, 409); assert.equal(activation.dto.code, 'model_unavailable'); assertNoCommit(f, before);
});

check('native full four-tier patch is validated before shared production map writer runs', async t => {
    const f = await fixture(t, 'full-map-atomic'); await f.prepare();
    const before = diskSnapshot(f.dir);
    const invalid = await f.post({ tokenId: 9, modelMap: { default: MODEL, opus: MODEL, sonnet: 'not-permitted', haiku: MODEL } }, { pathname: '/__switch/api/a6api/modelmap' });
    assert.equal(invalid.status, 409); assertNoCommit(f, before);
    const valid = await f.post({ tokenId: 9, modelMap: { default: MODEL, opus: MODEL, sonnet: MODEL, haiku: MODEL } }, { pathname: '/__switch/api/a6api/modelmap' });
    assert.equal(valid.status, 200);
    assert.deepEqual(valid.dto.modelMap, { ...f.maps.provider, default: MODEL, opus: MODEL, sonnet: MODEL, haiku: MODEL });
    assert.deepEqual(valid.dto.routesMap, { ...f.maps.routes, opus: MODEL, sonnet: MODEL, haiku: MODEL });
    assert.equal(readJson(f.paths.settingsPath).model, f.settings.model); assert.equal(f.syncs(), 0);
});

check('active native default save retains the prior explicit current-model update semantics', async t => {
    const f = await fixture(t, 'active-default'); await f.prepare(); f.setActive(true);
    const response = await f.post({ tokenId: 9, modelMap: { default: MODEL } }, { pathname: '/__switch/api/a6api/modelmap' });
    assert.equal(response.status, 200); assert.equal(readJson(f.paths.settingsPath).model, MODEL);
    assert.deepEqual(f.hubCalls, ['writeMap', 'syncModel', 'publish']);
    assert.deepEqual(readJson(f.paths.manifestPath), f.initial);
});

check('actual OpenCode commit failure remains distinct from a successful a6api publication', async t => {
    let commits = 0;
    const f = await fixture(t, 'a6api-sync-failure', { openCodeOptions: { durableImpl: {
        ...durable, commitAtomicSync(stage) { commits += 1; if (commits === 2) throw new Error(FIXTURE_PRIVATE); return durable.commitAtomicSync(stage); },
    } } }); await f.prepare();
    const targetsBefore = f.opencodeTargets.map(target => fs.existsSync(target.path) ? fs.readFileSync(target.path).toString('base64') : null);
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 200); assert.equal(response.dto.ok, true); assert.equal(response.dto.model.published, true);
    assert.deepEqual(response.dto.opencode, { ok: false, code: 'api_gateway_opencode_transaction_failed' });
    const current = readJson(f.paths.manifestPath); assert.equal(current.revision, 8); assert.ok(Object.hasOwn(current.models, ID));
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(current));
    assert.deepEqual(f.opencodeTargets.map(target => fs.existsSync(target.path) ? fs.readFileSync(target.path).toString('base64') : null), targetsBefore);
});

check('known provider error code cannot smuggle secret prose or an invalid HTTP status to the browser', async t => {
    const f = await fixture(t, 'forged-provider-prose', { validatePublication() {
        throw Object.assign(new Error(FIXTURE_PRIVATE), { code: 'a6api_token_expired', status: 418 });
    } });
    const response = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(response.status, 409); assert.equal(response.dto.code, 'a6api_token_expired');
    assert.equal(response.dto.error, 'Срок выбранного ключа a6api истёк. Измените срок в кабинете или используйте другой ключ.');
    assert.equal(f.saves(), 0); assert.equal(f.syncs(), 0);
});

check('production options seam injects the exact guard on the existing a6api singleton without loading the dashboard', async t => {
    const f = await fixture(t, 'production-wiring');
    const start = proxySource.indexOf('const apiGatewayProduction = createProductionApiGateway({');
    const end = proxySource.indexOf('\n});', start);
    assert.ok(start >= 0 && end > start);
    let seen;
    const wired = vm.createContext({ createProductionApiGateway(options) { seen = options; }, a6Gateway: f.gateway,
        a6Routes: { canWrite() {} }, process: { env: {}, platform: 'win32' }, path, os: { homedir: () => f.home },
        __dirname: f.routingDir, routesCandidateLiveModels() {}, routesCandidateAccountModels() {}, routesCandidatePricingModels() {},
        routesCandidateSnapshotModels() {}, routesCandidateConfiguredModels() {}, resolveApiGatewayCandidates() {} });
    vm.runInContext(proxySource.slice(start, end + 4), wired);
    assert.equal(typeof seen.validatePublication, 'function');
    await assert.rejects(seen.validatePublication({ id: ID, published: true }), error => error.code === 'a6api_key_not_selected');
    assert.deepEqual(f.panel.calls, []); assert.equal(f.saves(), 0); assert.equal(f.syncs(), 0);
});

check('native default-only readback rejects writer drift in untouched provider or routes fields', async t => {
    for (const kind of ['provider', 'routes']) {
        const f = await fixture(t, `default-readback-${kind}`, { afterMapWrite({ mapPaths }) {
            const changed = readJson(mapPaths[kind]);
            changed[kind === 'provider' ? 'gpt' : 'default'] = 'unexpected-local-fixture-writer-drift';
            writeJson(mapPaths[kind], changed);
        } }); await f.prepare();
        const response = await f.post({ tokenId: 9, modelMap: { default: MODEL } }, { pathname: '/__switch/api/a6api/modelmap' });
        assert.equal(response.status, 409, 'default-only readback must verify both complete map responsibilities, not just the changed default');
        assert.equal(response.dto.code, 'model_readback');
        assert.equal(readJson(f.paths.settingsPath).model, f.settings.model);
        assert.equal(f.hubCalls.includes('publish'), false, 'failed map readback must not publish misleading registry state');
    }
});

check('hide on the advanced path removes only publication without provider validation', async t => {
    const f = await fixture(t, 'advanced-hide'); f.panel.failTokens = 401; f.panel.failCatalog = 504;
    const response = await f.post({ expectedRevision: 7, id: OLD_ID, published: false,
        displayName: 'Ignored when hiding', claudeBehavesAs: 'claude-opus-5', contextTokens: 1, outputTokens: 1 }, { pathname: `${PREFIX}/model` });
    assert.equal(response.status, 200); assert.equal(response.dto.revision, 8);
    assert.deepEqual(f.panel.calls, []); assert.equal(f.validations(), 0);
    const current = readJson(f.paths.manifestPath); assert.equal(Object.hasOwn(current.models, OLD_ID), false);
    assert.deepEqual(current.models[OTHER_ID], f.initial.models[OTHER_ID]);
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(current));
    assert.deepEqual(omitPicker(readJson(f.paths.settingsPath)), omitPicker(f.settings));
});

check('missing key file and malformed selection deny enable without credential or manifest side effects', async t => {
    for (const mode of ['missing-key-file', 'invalid-selection']) {
        const f = await fixture(t, mode); await f.prepare();
        if (mode === 'missing-key-file') fs.unlinkSync(path.join(f.secretDir, 'a6api-active-key.txt'));
        else fs.writeFileSync(path.join(f.secretDir, 'a6api-gateway.json'), '{invalid-local-fixture');
        const before = diskSnapshot(f.dir);
        const response = await f.post({ expectedRevision: 7, id: ID, published: true });
        assert.equal(response.status, 409); assert.equal(response.dto.code, 'a6api_key_not_selected');
        assert.deepEqual(f.panel.calls, []); assertNoCommit(f, before);
    }
});

check('shared stale revision and cross-origin guard reject before any a6api validation', async t => {
    const f = await fixture(t, 'shared-conflicts');
    const before = diskSnapshot(f.dir);
    const stale = await f.post({ expectedRevision: 6, id: ID, published: true });
    assert.equal(stale.status, 409); assert.equal(stale.dto.code, 'api_gateway_revision_conflict');
    const foreign = await f.post({ expectedRevision: 7, id: ID, published: true }, { headers: { origin: 'http://foreign.example.invalid' } });
    assert.equal(foreign.status, 403); assert.equal(foreign.dto.code, 'local_only');
    assert.equal(f.validations(), 0); assertNoCommit(f, before);
});

check('a denied enable leaves the serialized mutation queue usable for the next prepared publish', async t => {
    const f = await fixture(t, 'deny-then-publish');
    const denied = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(denied.status, 409); await f.prepare();
    const success = await f.post({ expectedRevision: 7, id: ID, published: true });
    assert.equal(success.status, 200); assert.equal(success.dto.opencode.ok, true);
    assert.equal(readJson(f.paths.manifestPath).revision, 8); assertProjection(f, readJson(f.paths.manifestPath));
});

after(() => {
    const receipt = path.join(RUN_ROOT, 'test-receipt.json');
    writeJson(receipt, { fixture: 'External a6api panel is LOCAL fixture data; gateway/routes/writers are real',
        runRoot: RUN_ROOT, checks, passed: checks.filter(row => row.passed).length,
        failed: checks.filter(row => !row.passed).length, networkViolations, writeViolations, remainingListeners: ports.size,
        fixtures: fixtures.map(f => ({ dir: f.dir, paths: f.paths, opencodeTargets: f.opencodeTargets,
            saves: f.saves(), syncs: f.syncs(), validations: f.validations(), hubCalls: f.hubCalls,
            panelCalls: f.panel.calls, observedManifest: readJson(f.paths.manifestPath) })), finalResponses });
    globalThis.fetch = actualFetch; http.request = realRequest; https.request = realHttpsRequest;
    net.Socket.prototype.connect = connect;
    for (const [name, original] of fsOriginals) fs[name] = original;
    console.log(`a6api-publication receipt: ${receipt}`);
    assert.equal(networkViolations, 0); assert.equal(writeViolations, 0); assert.equal(ports.size, 0, 'every fixture listener must close');
});
