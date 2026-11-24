#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const SCRATCH = path.resolve(process.env.TMPDIR || os.tmpdir());
assert.equal(path.resolve(os.tmpdir()), SCRATCH, 'os.tmpdir must use the isolated scratch root');
const RUN_ROOT = fs.mkdtempSync(path.join(SCRATCH, 'api-gateway-publication-'));
const ENV_KEYS = ['HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME',
    'API_GATEWAY_WIKI_ROOT', 'ABUSE_HUB_LOCAL_HOP_KEY_FILE'];
const ORIGINAL_ENV = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
const fixtureHome = path.join(RUN_ROOT, 'home');
fs.mkdirSync(fixtureHome, { recursive: true });
Object.assign(process.env, {
    HOME: fixtureHome,
    USERPROFILE: fixtureHome,
    TMPDIR: RUN_ROOT,
    TMP: RUN_ROOT,
    TEMP: RUN_ROOT,
    XDG_CONFIG_HOME: path.join(RUN_ROOT, 'xdg'),
    API_GATEWAY_WIKI_ROOT: path.join(RUN_ROOT, 'wiki'),
    ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(RUN_ROOT, 'fixture-local-hop.key'),
});

const ROOT = path.resolve(__dirname, '..');
const manifestApi = require('../routing/lib/api-gateway.js');
const { createOpenCodeService } = require('../routing/lib/api-gateway-opencode.js');
const { createProductionApiGateway } = require('../routing/lib/api-gateway-integration.js');
const PREFIX = '/__switch/api/api-gateway';
const NEW_ID = 'fixturevendor/family/nested/model';
const KEEP_ID = 'fixtureother/retained-model';
const FIXTURE_SECRET = 'token-fixture-secret-never-return';
const checks = [];
const fixtures = [];

function writeJson(file, value, styled = false) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let text = JSON.stringify(value, null, styled ? 4 : 2) + '\n';
    if (styled) text = '\ufeff' + text.replace(/\n/g, '\r\n');
    fs.writeFileSync(file, text, 'utf8');
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
}

function metadata(overrides = {}) {
    return {
        displayName: 'Owner fixture label',
        claudeBehavesAs: 'claude-sonnet-5',
        contextTokens: 234567,
        outputTokens: 12345,
        publishedAt: '2026-11-01T12:34:56.000Z',
        ...overrides,
    };
}

function withoutPicker(value) {
    const copy = structuredClone(value);
    delete copy.modelPicker;
    return copy;
}

function providerFor(manifest, native) {
    const models = Object.fromEntries(Object.entries(manifest.enabled ? manifest.models : {})
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([id, row]) => [id, {
            name: row.displayName,
            limit: { context: row.contextTokens, output: row.outputTokens },
        }]));
    const settings = {
        baseURL: 'http://127.0.0.1:20100/openai/v1',
        apiKey: 'dummy',
        timeout: 600000,
    };
    return native
        ? { package: 'aisdk:@ai-sdk/openai-compatible', name: 'ABUSE HUB', settings, models }
        : { npm: '@ai-sdk/openai-compatible', name: 'ABUSE HUB', options: settings, models };
}

async function fixture(t, name, options = {}) {
    const dir = fs.mkdtempSync(path.join(RUN_ROOT, `${name}-`));
    const home = path.join(dir, 'home');
    const repoRoot = path.join(dir, 'hub');
    const wikiRoot = path.join(dir, 'wiki');
    const paths = {
        manifestPath: path.join(repoRoot, 'routing', 'api-gateway.json'),
        defaultManifestPath: path.join(repoRoot, 'routing', 'api-gateway.default.json'),
        backendsPath: path.join(home, '.claude', 'backends.json'),
        settingsPath: path.join(home, '.claude', 'settings.json'),
    };
    const initial = {
        version: 1,
        revision: 7,
        enabled: options.enabled ?? true,
        models: { [KEEP_ID]: metadata(), ...(options.models || {}) },
    };
    const settings = {
        model: `${NEW_ID}[1m]`,
        env: { FIXTURE_SENTINEL: FIXTURE_SECRET },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'never-run-fixture' }] }] },
        plugins: { fixture: true },
        modelSettings: { effort: 'high' },
        permissions: { allow: ['Read'], deny: ['Network'] },
        modelPicker: manifestApi.buildModelPicker(initial),
        unknownFutureField: { retained: [1, true] },
    };
    writeJson(paths.manifestPath, initial);
    writeJson(paths.defaultManifestPath, initial);
    writeJson(paths.backendsPath, {
        providers: { fixturevendor: {}, fixtureother: {} },
        aliases: { fv: 'fixturevendor' },
        activeProvider: 'fixtureother',
    });
    writeJson(paths.settingsPath, settings, true);
    const opencodeTargets = ['User config', 'Wiki config', 'Hub config'].map((label, index) => ({
        label,
        path: path.join(dir, ['user', 'wiki', 'hub'][index], 'opencode.json'),
    }));
    const schemas = options.schemas || ['native', 'legacy', 'missing'];
    const configs = schemas.map((schema, index) => {
        if (schema === 'missing') return null;
        const config = {
            model: `abuse-hub/${NEW_ID}`,
            small_model: 'fixtureother/unchanged-small',
            agents: { build: { model: `abuse-hub/${NEW_ID}`, instructions: 'unchanged' } },
            mcp: { servers: { fixture: { command: ['never-run-fixture'] } } },
            permission: { edit: 'ask' },
            unknownFutureField: { keep: true },
            [schema === 'native' ? 'providers' : 'provider']: {
                other: { name: 'Untouched provider', settings: { apiKey: FIXTURE_SECRET } },
                'abuse-hub': providerFor(initial, schema === 'native'),
            },
        };
        writeJson(opencodeTargets[index].path, config, index === 0);
        return config;
    });
    let syncCalls = 0;
    const product = createProductionApiGateway({
        repoRoot, home, wikiRoot, paths,
        ...(options.manifestApi ? { manifestApi: options.manifestApi } : {}),
        xdgConfigHome: path.join(dir, 'xdg'),
        candidateOptions: { providers: [] },
        resolveModelCandidates: async () => { throw new Error('publication must not discover providers'); },
        opencodeTargets,
        opencodeJournalPath: path.join(repoRoot, 'routing', 'runtime', 'opencode.txn'),
        openCodeFactory: serviceOptions => {
            const real = createOpenCodeService({ ...serviceOptions, ...(options.openCodeOptions || {}) });
            return {
                ...real,
                status(manifest) {
                    const result = real.status(manifest);
                    return options.statusResult ? options.statusResult(result) : result;
                },
                async sync(manifest) {
                    syncCalls += 1;
                    assert.deepEqual(manifest, readJson(paths.manifestPath), 'Sync must receive the read-back manifest');
                    assert.deepEqual(readJson(paths.settingsPath).modelPicker, manifestApi.buildModelPicker(manifest),
                        'Claude transaction must finish before OpenCode Sync');
                    const result = real.sync(manifest);
                    if (options.afterSync) await options.afterSync(result, { manifest, paths, opencodeTargets, real });
                    return options.syncResult ? options.syncResult(result) : result;
                },
            };
        },
        hermesFactory: () => ({
            status() { throw new Error('publication must not touch Hermes'); },
            sync() { throw new Error('publication must not configure Hermes'); },
        }),
    });
    const server = http.createServer((req, res) => {
        if (!product.routes.handle(req, res)) { res.writeHead(404); res.end('{}'); }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const port = server.address().port;
    const post = (body, overrides = {}) => new Promise((resolve, reject) => {
        const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        const req = http.request({
            hostname: '127.0.0.1', port,
            method: overrides.method || 'POST',
            path: overrides.pathname || `${PREFIX}/publication`,
            headers: {
                host: `127.0.0.1:${port}`,
                origin: `http://127.0.0.1:${port}`,
                'sec-fetch-site': 'same-origin',
                'content-type': 'application/json',
                'content-length': bytes.length,
                ...(overrides.headers || {}),
            },
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, headers: res.headers, dto: JSON.parse(text), text });
            });
        });
        req.setTimeout(5000, () => req.destroy(new Error('isolated HTTP request timed out')));
        req.on('error', reject);
        req.end(bytes);
    });
    const f = { dir, paths, initial, settings, schemas, configs, opencodeTargets, product, post,
        syncCalls: () => syncCalls };
    fixtures.push(f);
    return f;
}

function assertProjection(f, manifest) {
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(manifest));
    assert.deepEqual(withoutPicker(readJson(f.paths.settingsPath)), withoutPicker(f.settings));
    for (const [index, target] of f.opencodeTargets.entries()) {
        const expected = structuredClone(f.configs[index] || {});
        const native = f.schemas[index] === 'native';
        const block = native ? 'providers' : 'provider';
        expected[block] ||= {};
        expected[block]['abuse-hub'] = providerFor(manifest, native);
        assert.deepEqual(readJson(target.path), expected, `${target.label}: only the existing provider block changes`);
    }
    assert.equal(f.product.openCodeService.status(manifest).status, 'synced');
}

function check(name, run) {
    test(name, { concurrency: false }, async t => {
        const row = { name, passed: false };
        checks.push(row);
        await run(t);
        row.passed = true;
    });
}

check('new exact nested ID publishes over HTTP and automatically syncs native legacy and absent targets', async t => {
    const f = await fixture(t, 'new-nested');
    const backendsBefore = fs.readFileSync(f.paths.backendsPath);
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 200, 'the strict publication route must be installed');
    assert.equal(response.dto.ok, true);
    assert.equal(response.headers['cache-control'], 'no-store');
    const actual = readJson(f.paths.manifestPath);
    assert.equal(actual.revision, 8);
    assert.equal(actual.enabled, true);
    const added = actual.models[NEW_ID];
    assert.equal(added.displayName, 'fixturevendor / family/nested/model');
    assert.equal(added.claudeBehavesAs, 'claude-opus-5');
    assert.equal(added.contextTokens, 1000000);
    assert.equal(added.outputTokens, 32000);
    assert.equal(new Date(added.publishedAt).toISOString(), added.publishedAt);
    assert.deepEqual(actual.models[KEEP_ID], f.initial.models[KEEP_ID]);
    assert.deepEqual(response.dto.manifest, { version: 1, revision: 8, enabled: true });
    assert.deepEqual(response.dto.model, { id: NEW_ID, published: true });
    assert.deepEqual(response.dto.opencode, {
        ok: true, status: 'synced', changed: 3,
        targets: f.opencodeTargets.map(({ label }) => ({ label, status: 'synced', synced: true })),
    });
    assert.equal(f.syncCalls(), 1);
    assertProjection(f, actual);
    assert.deepEqual(fs.readFileSync(f.paths.backendsPath), backendsBefore);
    assert.equal(response.text.includes(FIXTURE_SECRET), false);
    assert.equal(response.text.includes(f.dir), false);
});

check('OpenCode commit failure returns committed publication with a safe explicit sync warning', async t => {
    let commits = 0;
    const durable = require('../routing/lib/durable-write.js');
    const f = await fixture(t, 'sync-commit-failure', {
        schemas: ['native', 'legacy', 'native'],
        openCodeOptions: { durableImpl: {
            ...durable,
            commitAtomicSync(stage) {
                commits += 1;
                if (commits === 2) throw new Error(`fixture failure ${FIXTURE_SECRET}`);
                return durable.commitAtomicSync(stage);
            },
        } },
    });
    const beforeTargets = f.opencodeTargets.map(target => fs.readFileSync(target.path));
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 200, 'committed publication must not be disguised as generic failure');
    assert.equal(response.dto.ok, true);
    assert.deepEqual(response.dto.manifest, { version: 1, revision: 8, enabled: true });
    assert.deepEqual(response.dto.model, { id: NEW_ID, published: true });
    assert.deepEqual(response.dto.opencode, { ok: false, code: 'api_gateway_opencode_transaction_failed' });
    const actual = readJson(f.paths.manifestPath);
    assert.equal(actual.revision, 8);
    assert.ok(Object.hasOwn(actual.models, NEW_ID));
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(actual));
    assert.deepEqual(withoutPicker(readJson(f.paths.settingsPath)), withoutPicker(f.settings));
    assert.deepEqual(f.opencodeTargets.map(target => fs.readFileSync(target.path)), beforeTargets,
        'existing OpenCode transaction restores every target');
    assert.equal(f.syncCalls(), 1);
    assert.equal(response.text.includes(FIXTURE_SECRET), false);
    const retry = await f.post({}, { pathname: `${PREFIX}/opencode/sync` });
    assert.equal(retry.status, 200);
    assert.equal(retry.dto.ok, true);
    assert.equal(readJson(f.paths.manifestPath).revision, 8, 'manual retry does not rewrite the publication');
    assertProjection(f, actual);
});

check('fast state providers are exact sorted registry keys without secrets or discovery', async t => {
    const f = await fixture(t, 'canonical-providers');
    const registry = readJson(f.paths.backendsPath);
    registry.providers.fixturez = { token: FIXTURE_SECRET, path: f.dir };
    registry.providers.fixtureA = { headers: { authorization: FIXTURE_SECRET } };
    registry.aliases.aliasOnly = 'fixturevendor';
    writeJson(f.paths.backendsPath, registry);
    const response = await f.post({}, { method: 'GET', pathname: PREFIX });
    assert.equal(response.status, 200);
    assert.deepEqual(response.dto.providers, ['fixtureA', 'fixtureother', 'fixturevendor', 'fixturez'],
        'canonical names must come from the existing registry, not publication or aliases');
    assert.equal(response.dto.candidatesLoaded, false);
    assert.equal(f.syncCalls(), 0);
    assert.equal(response.text.includes(FIXTURE_SECRET), false);
    assert.equal(response.text.includes(f.dir), false);
    const { createApiGatewayDashboardService } = require('../routing/lib/api-gateway-dashboard.js');
    const legacyInjected = createApiGatewayDashboardService({
        readPublishedManifest: () => f.initial,
        saveManifestAndPicker: () => { throw new Error('no write expected'); },
        paths: { backendsPath: path.join(f.dir, 'intentionally-absent.json') },
    });
    assert.equal((await legacyInjected.state()).providers, null,
        'missing registry dependency must not guess canonical names from manifest IDs');
});

check('automatic Sync rechecks exact target state instead of trusting the success return', async t => {
    const f = await fixture(t, 'target-drift', {
        schemas: ['native', 'legacy', 'native'],
        afterSync(_result, { opencodeTargets }) {
            const file = opencodeTargets[1].path;
            const value = readJson(file);
            delete value.provider['abuse-hub'].models[NEW_ID];
            writeJson(file, value);
        },
    });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 200);
    assert.equal(response.dto.ok, true, 'manifest publication was committed');
    assert.deepEqual(response.dto.opencode, { ok: false, code: 'api_gateway_opencode_readback_failed' },
        'target readback must override a returned synced result');
    const actual = readJson(f.paths.manifestPath);
    assert.deepEqual(response.dto.manifest, { version: 1, revision: 8, enabled: true });
    assert.deepEqual(response.dto.model, { id: NEW_ID, published: true });
    assert.equal(f.product.openCodeService.status(actual).status, 'changes');
    assert.equal(f.syncCalls(), 1);
});

check('automatic Sync rejects an incomplete returned target receipt even when disk readback is synced', async t => {
    const f = await fixture(t, 'incomplete-sync-result', {
        schemas: ['native', 'native', 'native'],
        syncResult(result) { return { ...result, targets: result.targets.slice(0, 2) }; },
    });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 200);
    assert.equal(response.dto.ok, true);
    assert.deepEqual(response.dto.opencode, { ok: false, code: 'api_gateway_opencode_sync_failed' },
        'all three targets and synced status are mandatory, not plausible partial success');
    assertProjection(f, readJson(f.paths.manifestPath));
});

check('automatic Sync verifies the same complete three target labels during status readback', async t => {
    const f = await fixture(t, 'mismatched-readback', {
        statusResult(result) {
            return { ...result, targets: result.targets.map((row, index) => index === 2
                ? { ...row, label: 'Unrelated target' } : row) };
        },
    });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 200);
    assert.deepEqual(response.dto.opencode, { ok: false, code: 'api_gateway_opencode_readback_failed' },
        'readback must verify exactly the same targets, not just a synced aggregate');
});

check('manifest drift during Sync returns the actual final publication rather than false completion', async t => {
    const f = await fixture(t, 'manifest-drift', {
        schemas: ['native', 'legacy', 'native'],
        afterSync(_result, { paths }) {
            const current = readJson(paths.manifestPath);
            const models = structuredClone(current.models);
            delete models[NEW_ID];
            manifestApi.saveManifestAndPicker({ ...paths, expectedRevision: current.revision,
                draft: { enabled: current.enabled, models } });
        },
    });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 200);
    assert.equal(response.dto.ok, true, 'the initial publication transaction did commit');
    assert.deepEqual(response.dto.manifest, { version: 1, revision: 9, enabled: true },
        'the final DTO must reflect the observed manifest revision');
    assert.deepEqual(response.dto.model, { id: NEW_ID, published: false });
    assert.deepEqual(response.dto.opencode, { ok: false, code: 'api_gateway_publication_changed' });
    const actual = readJson(f.paths.manifestPath);
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(actual));
    assert.equal(f.product.openCodeService.status(actual).status, 'changes');
    assert.equal(f.syncCalls(), 1, 'do not silently reapply or retry over an external publication edit');
});

check('publication mutations are serialized through verified automatic Sync before the next write', async t => {
    let release;
    let entered;
    const barrier = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let syncCount = 0;
    const f = await fixture(t, 'publication-serialization', {
        afterSync: async () => {
            syncCount += 1;
            if (syncCount === 1) { entered(); await barrier; }
        },
    });
    const first = f.product.service.setPublication({ expectedRevision: 7, id: NEW_ID, published: true });
    await started;
    const second = f.product.service.setPublication({ expectedRevision: 8, id: NEW_ID, published: false });
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(readJson(f.paths.manifestPath).revision, 8,
            'a second publication must wait for the first Sync and readback');
        assert.equal(f.syncCalls(), 1);
    } finally { release(); }
    const one = await first;
    const two = await second;
    assert.deepEqual(one.manifest, { version: 1, revision: 8, enabled: true });
    assert.deepEqual(one.model, { id: NEW_ID, published: true });
    assert.equal(one.opencode.ok, true);
    assert.deepEqual(two.manifest, { version: 1, revision: 9, enabled: true });
    assert.deepEqual(two.model, { id: NEW_ID, published: false });
    assert.equal(two.opencode.ok, true);
    assertProjection(f, readJson(f.paths.manifestPath));
});

check('legacy metadata writes wait for publication Sync while preserving their original response contract', async t => {
    let release;
    let entered;
    const barrier = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const f = await fixture(t, 'metadata-serialization', {
        afterSync: async () => { entered(); await barrier; },
    });
    const first = f.product.service.setPublication({ expectedRevision: 7, id: NEW_ID, published: true });
    await started;
    const second = f.product.service.updateModel({
        expectedRevision: 8, id: KEEP_ID, published: true,
        displayName: 'Edited metadata label', claudeBehavesAs: 'claude-haiku-5',
        contextTokens: 345678, outputTokens: 23456,
    });
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(readJson(f.paths.manifestPath).revision, 8,
            'metadata write must not overtake a verified publication transaction');
    } finally { release(); }
    assert.equal((await first).opencode.ok, true);
    assert.deepEqual(await second, { ok: true, revision: 9, enabled: true, publishedModelCount: 2 });
    assert.equal(f.syncCalls(), 1, 'legacy Save keeps manual OpenCode Sync behavior');
    const actual = readJson(f.paths.manifestPath);
    assert.equal(actual.models[KEEP_ID].displayName, 'Edited metadata label');
    assert.equal(actual.models[KEEP_ID].publishedAt, f.initial.models[KEEP_ID].publishedAt);
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(actual));
});

check('manual OpenCode retry waits behind automatic publication Sync without reading a stale manifest', async t => {
    let release;
    let entered;
    const barrier = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let count = 0;
    const f = await fixture(t, 'manual-sync-serialization', {
        afterSync: async () => {
            count += 1;
            if (count === 1) { entered(); await barrier; }
        },
    });
    const first = f.product.service.setPublication({ expectedRevision: 7, id: NEW_ID, published: true });
    await started;
    const retry = f.product.service.openCodeSync();
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.syncCalls(), 1, 'manual retry must share the publication mutation queue');
    } finally { release(); }
    assert.equal((await first).opencode.ok, true);
    assert.deepEqual(await retry, {
        ok: true, status: 'synced', changed: 0,
        targets: f.opencodeTargets.map(({ label }) => ({ label, status: 'synced', synced: true })),
    });
    assert.equal(readJson(f.paths.manifestPath).revision, 8);
    assertProjection(f, readJson(f.paths.manifestPath));
});

check('unknown canonical providers are rejected when hiding before any publication or Sync write', async t => {
    const f = await fixture(t, 'unknown-hide');
    const before = [f.paths.manifestPath, f.paths.settingsPath, ...f.opencodeTargets.map(row => row.path)]
        .map(file => fs.existsSync(file) ? fs.readFileSync(file) : null);
    const response = await f.post({ expectedRevision: 7, id: 'missingfixture/model', published: false });
    assert.equal(response.status, 404, 'hiding an unknown provider must not silently create a new revision');
    assert.equal(response.dto.code, 'api_gateway_unknown_provider');
    assert.equal(f.syncCalls(), 0);
    assert.deepEqual([f.paths.manifestPath, f.paths.settingsPath, ...f.opencodeTargets.map(row => row.path)]
        .map(file => fs.existsSync(file) ? fs.readFileSync(file) : null), before);
});

check('postcommit OpenCode exceptions expose only allowlisted safe codes while retaining committed state', async t => {
    const unsafeCode = 'token_fixture_secret_never_return';
    const f = await fixture(t, 'unsafe-sync-code', {
        afterSync() {
            throw Object.assign(new Error(`unsafe ${FIXTURE_SECRET}`), { code: unsafeCode });
        },
    });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 200);
    assert.deepEqual(response.dto.opencode, { ok: false, code: 'api_gateway_opencode_transaction_failed' },
        'syntactic code validation must not leak arbitrary provider or private strings');
    assert.equal(response.text.includes(unsafeCode), false);
    assertProjection(f, readJson(f.paths.manifestPath));
});

check('publication of an existing exact ID preserves every metadata value and publishedAt', async t => {
    const previous = metadata({ displayName: 'Owner / unusual  label', claudeBehavesAs: 'owner-custom-behavior',
        contextTokens: 876543, outputTokens: 43210, publishedAt: '2026-10-01T01:02:03.004Z' });
    const f = await fixture(t, 'preserve-metadata', {
        models: { [NEW_ID]: previous }, schemas: ['native', 'native', 'legacy'],
    });
    const beforeTargets = f.opencodeTargets.map(row => fs.readFileSync(row.path));
    const input = { expectedRevision: 7, id: NEW_ID, published: true };
    const unchangedInput = structuredClone(input);
    const result = await f.product.service.setPublication(input);
    assert.deepEqual(input, unchangedInput, 'service must not rewrite the exact input');
    assert.deepEqual(readJson(f.paths.manifestPath).models, f.initial.models);
    assert.deepEqual(readJson(f.paths.manifestPath).models[NEW_ID], previous);
    assert.equal(result.opencode.ok, true);
    assert.equal(result.opencode.changed, 0, 'already correct OpenCode targets must be byte-idempotent');
    assert.deepEqual(f.opencodeTargets.map(row => fs.readFileSync(row.path)), beforeTargets);
    assertProjection(f, readJson(f.paths.manifestPath));
});

check('hiding removes only the exact publication and all client picker projections not current models', async t => {
    const f = await fixture(t, 'hide-nested', {
        models: { [NEW_ID]: metadata({ contextTokens: 1000000 }) }, schemas: ['legacy', 'native', 'legacy'],
    });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: false });
    assert.equal(response.status, 200);
    assert.deepEqual(response.dto.model, { id: NEW_ID, published: false });
    assert.equal(response.dto.opencode.ok, true);
    const actual = readJson(f.paths.manifestPath);
    assert.deepEqual(actual, { version: 1, revision: 8, enabled: true, models: { [KEEP_ID]: f.initial.models[KEEP_ID] } });
    assertProjection(f, actual);
    assert.deepEqual(manifestApi.recognizeCallableModel(NEW_ID, f.paths),
        { id: NEW_ID, provider: 'fixturevendor', model: 'family/nested/model' },
        'hiding never creates a callability denylist');
    assert.equal(manifestApi.toOpenAiModels(actual).some(row => row.id === NEW_ID), false);
});

check('disabled manifest stays disabled when the exact publication is added', async t => {
    const f = await fixture(t, 'disabled-publication', { enabled: false });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 200);
    assert.deepEqual(response.dto.manifest, { version: 1, revision: 8, enabled: false });
    assert.deepEqual(response.dto.model, { id: NEW_ID, published: true });
    assert.equal(readJson(f.paths.manifestPath).enabled, false, 'a model switch does not activate the gateway');
    assertProjection(f, readJson(f.paths.manifestPath));
});

check('strict publication input rejects malformed values without normalization or writes', async t => {
    const f = await fixture(t, 'invalid-input');
    const before = fs.readFileSync(f.paths.manifestPath);
    const good = { expectedRevision: 7, id: NEW_ID, published: true };
    const cases = [null, [], {}, { ...good, extra: true }, { id: NEW_ID, published: true },
        { ...good, expectedRevision: 0 }, { ...good, expectedRevision: -1 },
        { ...good, expectedRevision: 1.5 }, { ...good, expectedRevision: '7' },
        { ...good, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
        { ...good, published: 'true' }, { ...good, published: 1 }, { ...good, published: null },
        ...['', 'no-slash', '/model', 'fixturevendor/', ` ${NEW_ID}`, `${NEW_ID} `,
            'fixturevendor/model with spaces', 'fixturevendor/model\u0000', 'fixturevendor/model\n']
            .map(id => ({ ...good, id })),
    ];
    for (const input of cases) {
        const response = await f.post(input);
        assert.equal(response.status, 400, JSON.stringify(input));
        assert.equal(response.dto.ok, false);
    }
    assert.deepEqual(fs.readFileSync(f.paths.manifestPath), before);
    assert.equal(f.syncCalls(), 0);
    for (const id of ['fv/model', 'missingfixture/model', 'custom/model']) {
        const response = await f.post({ ...good, id });
        assert.equal(response.status, 404);
        assert.equal(response.dto.code, 'api_gateway_unknown_provider');
    }
    assert.deepEqual(fs.readFileSync(f.paths.manifestPath), before);
    assert.equal(f.syncCalls(), 0);
});

check('publication route keeps same-origin loopback JSON body limits and exact path ownership', async t => {
    const f = await fixture(t, 'route-guards');
    const good = { expectedRevision: 7, id: NEW_ID, published: true };
    for (const headers of [{ origin: 'http://foreignfixture.invalid' }, { host: 'foreignfixture.invalid' },
        { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
        const response = await f.post(good, { headers });
        assert.equal(response.status, 403);
        assert.equal(response.dto.code, 'local_only');
    }
    assert.equal((await f.post(good, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await f.post(Buffer.alloc(65537, 0x20))).status, 413);
    assert.equal((await f.post(Buffer.from('{'))).dto.code, 'invalid_json');
    assert.equal((await f.post({}, { method: 'PUT' })).status, 405);
    assert.equal((await f.post(good, { pathname: `${PREFIX}/publication-extra` })).status, 404);
    assert.equal(f.syncCalls(), 0);
    assert.deepEqual(readJson(f.paths.manifestPath), f.initial);
});

check('stale optimistic revisions fail before Sync and the failed write does not poison the queue', async t => {
    const f = await fixture(t, 'revision-conflict');
    const before = fs.readFileSync(f.paths.manifestPath);
    const response = await f.post({ expectedRevision: 6, id: NEW_ID, published: true });
    assert.equal(response.status, 409);
    assert.equal(response.dto.code, 'api_gateway_revision_conflict');
    assert.deepEqual(fs.readFileSync(f.paths.manifestPath), before);
    assert.equal(f.syncCalls(), 0);
    assert.equal((await f.post({ expectedRevision: 7, id: NEW_ID, published: true })).dto.opencode.ok, true);
    assertProjection(f, readJson(f.paths.manifestPath));
});

check('direct invalid publication calls reject asynchronously before any filesystem work', async t => {
    const f = await fixture(t, 'invalid-service-contract');
    await assert.rejects(f.product.service.setPublication({ expectedRevision: 7, id: 'invalid', published: true }),
        error => error.code === 'api_gateway_dashboard_invalid_input' && error.status === 400);
    assert.equal(f.syncCalls(), 0);
    assert.deepEqual(readJson(f.paths.manifestPath), f.initial);
});

check('a reported successful save without a revision advance cannot trigger automatic Sync', async t => {
    const f = await fixture(t, 'save-without-commit', {
        manifestApi: {
            ...manifestApi,
            saveManifestAndPicker(args) { return { ok: true, revision: args.expectedRevision }; },
        },
    });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: false });
    assert.equal(response.status, 409, 'readback must prove exactly one committed revision even for a hidden no-op ID');
    assert.equal(response.dto.code, 'api_gateway_publication_readback_failed');
    assert.equal(f.syncCalls(), 0);
    assert.deepEqual(readJson(f.paths.manifestPath), f.initial);
});

check('unreadable final manifest after an OpenCode failure returns explicit uncertainty not generic failure', async t => {
    const f = await fixture(t, 'unreadable-final-manifest', {
        afterSync(_result, { paths }) {
            fs.writeFileSync(paths.manifestPath, '{', 'utf8');
            throw new Error('fixture postcommit OpenCode failure');
        },
    });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 200, 'a known committed publication must not become a generic thrown failure');
    assert.equal(response.dto.ok, true);
    assert.equal(response.dto.manifest, null, 'unreadable current revision must not be invented');
    assert.deepEqual(response.dto.model, { id: NEW_ID, published: null });
    assert.deepEqual(response.dto.opencode, { ok: false, code: 'api_gateway_publication_readback_failed' });
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker.options.map(row => row.model).sort(),
        [KEEP_ID, `${NEW_ID}[1m]`].sort(), 'actual committed Claude picker is not rolled back by a Sync failure');
});

check('failed real manifest and Claude transaction never invokes automatic OpenCode Sync', async t => {
    const f = await fixture(t, 'manifest-transaction-failure', {
        manifestApi: {
            ...manifestApi,
            saveManifestAndPicker(args) {
                return manifestApi.saveManifestAndPicker({ ...args, onStep(step) {
                    if (step === 'afterManifestCommit') throw new Error('isolated writer fault');
                } });
            },
        },
    });
    const files = [f.paths.manifestPath, f.paths.settingsPath, ...f.opencodeTargets.map(row => row.path)];
    const before = files.map(file => fs.existsSync(file) ? fs.readFileSync(file) : null);
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 500);
    assert.equal(response.dto.code, 'api_gateway_transaction_failed');
    assert.equal(f.syncCalls(), 0);
    assert.deepEqual(files.map(file => fs.existsSync(file) ? fs.readFileSync(file) : null), before,
        'existing transaction rolls both manifest and Claude settings back byte-exact');
    assert.equal(fs.existsSync(`${f.paths.manifestPath}.txn`), false);
});

check('automatic Sync is blocked unless exact post-save manifest metadata and revision read back', async t => {
    let committed = false;
    const f = await fixture(t, 'pre-sync-readback-mismatch', {
        manifestApi: {
            ...manifestApi,
            saveManifestAndPicker(args) {
                const result = manifestApi.saveManifestAndPicker(args);
                committed = true;
                return result;
            },
            readPublishedManifest(args) {
                const actual = manifestApi.readPublishedManifest(args);
                if (committed) actual.models[NEW_ID].contextTokens -= 1;
                return actual;
            },
        },
    });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 409);
    assert.equal(response.dto.code, 'api_gateway_publication_readback_failed');
    assert.equal(f.syncCalls(), 0, 'a successful writer return is not proof of exact readback');
    const actual = readJson(f.paths.manifestPath);
    assert.equal(actual.models[NEW_ID].contextTokens, 1000000);
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(actual));
});

check('invalid Claude settings fail before publication write or automatic Sync', async t => {
    const f = await fixture(t, 'invalid-claude');
    fs.writeFileSync(f.paths.settingsPath, '{', 'utf8');
    const before = fs.readFileSync(f.paths.manifestPath);
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 400);
    assert.equal(response.dto.code, 'api_gateway_settings_invalid');
    assert.deepEqual(fs.readFileSync(f.paths.manifestPath), before);
    assert.equal(f.syncCalls(), 0);
});

check('real invalid OpenCode target retains publication and returns a recoverable explicit sync warning', async t => {
    const f = await fixture(t, 'invalid-opencode-target');
    fs.writeFileSync(f.opencodeTargets[1].path, '{', 'utf8');
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 200);
    assert.equal(response.dto.ok, true);
    assert.deepEqual(response.dto.opencode, { ok: false, code: 'api_gateway_opencode_target_invalid' });
    assert.deepEqual(response.dto.model, { id: NEW_ID, published: true });
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(readJson(f.paths.manifestPath)));
    writeJson(f.opencodeTargets[1].path, f.configs[1]);
    const retry = await f.post({}, { pathname: `${PREFIX}/opencode/sync` });
    assert.equal(retry.status, 200);
    assert.equal(retry.dto.ok, true);
    assertProjection(f, readJson(f.paths.manifestPath));
});

check('successful publication response redacts extra returned OpenCode fields without altering exact model ID', async t => {
    const f = await fixture(t, 'redacted-opencode-result', {
        syncResult(result) {
            return { ...result, token: FIXTURE_SECRET, configPath: 'C:/FixturePrivate/config.json',
                raw: { private: FIXTURE_SECRET }, note: `Bearer ${FIXTURE_SECRET}`,
                targets: result.targets.map(row => ({ ...row, path: 'C:/FixturePrivate/target.json' })) };
        },
    });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 200);
    assert.equal(response.dto.opencode.ok, true);
    assert.equal(response.text.includes(FIXTURE_SECRET), false);
    assert.equal(response.text.includes('FixturePrivate'), false);
    assert.equal(Object.hasOwn(response.dto.opencode, 'token'), false);
    assert.equal(Object.hasOwn(response.dto.opencode, 'configPath'), false);
    assert.deepEqual(response.dto.model, { id: NEW_ID, published: true });
});

check('unreadable immediate publication readback is a distinct uncertainty and never starts Sync', async t => {
    let committed = false;
    const f = await fixture(t, 'unreadable-before-sync', {
        manifestApi: {
            ...manifestApi,
            saveManifestAndPicker(args) {
                const result = manifestApi.saveManifestAndPicker(args);
                committed = true;
                return result;
            },
            readPublishedManifest(args) {
                if (committed) throw new Error('isolated read failure');
                return manifestApi.readPublishedManifest(args);
            },
        },
    });
    const response = await f.post({ expectedRevision: 7, id: NEW_ID, published: true });
    assert.equal(response.status, 409, 'readback uncertainty must not look like ordinary generic server failure');
    assert.equal(response.dto.code, 'api_gateway_publication_readback_failed');
    assert.equal(f.syncCalls(), 0);
    const actual = readJson(f.paths.manifestPath);
    assert.equal(actual.revision, 8);
    assert.deepEqual(readJson(f.paths.settingsPath).modelPicker, manifestApi.buildModelPicker(actual));
});

check('optimistic revision must match the snapshot before provider reads can change the manifest', async t => {
    const externalId = 'fixtureother/concurrent-owner-publication';
    const f = await fixture(t, 'future-revision-conflict', {
        manifestApi: {
            ...manifestApi,
            readCanonicalProviders(file) {
                const paths = {
                    backendsPath: file,
                    settingsPath: path.join(path.dirname(file), 'settings.json'),
                    manifestPath: path.join(path.dirname(path.dirname(path.dirname(file))), 'hub', 'routing', 'api-gateway.json'),
                };
                const current = readJson(paths.manifestPath);
                manifestApi.saveManifestAndPicker({ ...paths, expectedRevision: current.revision,
                    draft: { enabled: current.enabled, models: { ...current.models, [externalId]: metadata() } } });
                return manifestApi.readCanonicalProviders(file);
            },
        },
    });
    const response = await f.post({ expectedRevision: 8, id: NEW_ID, published: true });
    assert.equal(response.status, 409, 'a future expected revision must not authorize a stale snapshot draft');
    assert.equal(response.dto.code, 'api_gateway_revision_conflict');
    assert.equal(f.syncCalls(), 0);
    assert.equal(Object.hasOwn(readJson(f.paths.manifestPath).models, NEW_ID), false);
});

after(() => {
    for (const [key, value] of ORIGINAL_ENV) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const environmentRestored = [...ORIGINAL_ENV].every(([key, value]) => process.env[key] === value);
    const receiptPath = path.join(RUN_ROOT, 'receipt.json');
    const hash = file => fs.existsSync(file)
        ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent';
    writeJson(receiptPath, {
        ok: checks.length > 0 && checks.every(row => row.passed) && environmentRestored,
        environmentRestored,
        tests: checks,
        fixtures: fixtures.map(f => ({
            dir: f.dir,
            syncCalls: f.syncCalls(),
            manifest: (() => {
                try { return readJson(f.paths.manifestPath); }
                catch { return null; }
            })(),
            targets: [f.paths.manifestPath, f.paths.settingsPath, f.paths.backendsPath,
                ...f.opencodeTargets.map(target => target.path)].map(file => ({ file, sha256: hash(file) })),
        })),
    });
    console.log(`API_GATEWAY_PUBLICATION_RECEIPT ${receiptPath}`);
    assert.equal(environmentRestored, true, 'fixture process environment must be restored');
});
