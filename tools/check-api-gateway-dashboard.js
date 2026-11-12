#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'routing', 'lib', 'api-gateway-dashboard.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-dashboard-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_PROFILE = process.env.USERPROFILE;
const SECRET = 'sk-fixture-secret-never-return';
const EMAIL = 'private@example.test';
const PRIVATE_PATH = 'C:\\Users\\Private\\client.json';
const PRIVATE_SPACE_PATH = 'C:\\Users\\Private Person\\client.json';
const PRIVATE_QUOTED_PATH = 'C:\\Program Files\\Private Agent\\client.json';

process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

let publicUrls;

before(async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
    publicUrls = {
        anthropicBaseUrl: `http://127.0.0.1:${address.port}`,
        openaiBaseUrl: `http://127.0.0.1:${address.port}/openai/v1`,
    };
});

after(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_PROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = ORIGINAL_PROFILE;
    fs.rmSync(TMP, { recursive: true, force: true });
});

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function meta(label, publishedAt = '2026-11-10T00:00:00.000Z') {
    return {
        displayName: label,
        claudeBehavesAs: 'claude-opus-5',
        contextTokens: 1050000,
        outputTokens: 32000,
        publishedAt,
    };
}

function manifest(models = {}, extra = {}) {
    return {
        version: 1,
        revision: 7,
        enabled: true,
        models,
        ...extra,
    };
}

function paths(name) {
    const dir = path.join(TMP, name);
    fs.mkdirSync(dir, { recursive: true });
    return {
        manifestPath: path.join(dir, 'api-gateway.json'),
        defaultManifestPath: path.join(dir, 'api-gateway.default.json'),
        backendsPath: path.join(dir, 'backends.json'),
        settingsPath: path.join(dir, 'settings.json'),
    };
}

function load() {
    delete require.cache[require.resolve(LIB_PATH)];
    return require(LIB_PATH);
}

function baseDependencies(overrides = {}) {
    const current = manifest({
        'alpha/model-a': meta('Alpha / Model A'),
    });
    return {
        readPublishedManifest: async () => clone(current),
        saveManifestAndPicker: async () => ({ ok: true, revision: 8, enabled: true, publishedModelCount: 1 }),
        resolveModelCandidates: async () => [],
        readPassive: async () => ({}),
        readProbes: async () => ({}),
        getSidecarStatus: async () => ({ status: 'ready' }),
        openCodeService: {
            status: async () => ({ status: 'ready' }),
            preview: async () => ({ ok: true, targets: [] }),
            sync: async () => ({ ok: true, changed: 0 }),
        },
        hermesService: {
            status: async () => ({ status: 'absent' }),
            sync: async () => ({ ok: true, status: 'absent' }),
        },
        paths: paths(`base-${crypto.randomBytes(5).toString('hex')}`),
        publicUrls,
        now: () => Date.parse('2026-11-11T12:00:00.000Z'),
        freshMs: 24 * 60 * 60 * 1000,
        ...overrides,
    };
}

function byId(state, id) {
    const row = state.models.find(model => model.id === id);
    assert.ok(row, `missing model ${id}`);
    return row;
}

function jsonText(value) {
    return JSON.stringify(value);
}

test('exports the injected dashboard service interface', () => {
    assert.ok(fs.existsSync(LIB_PATH), 'routing/lib/api-gateway-dashboard.js must exist');
    const { createApiGatewayDashboardService } = load();
    assert.equal(typeof createApiGatewayDashboardService, 'function');
    const service = createApiGatewayDashboardService(baseDependencies());
    for (const name of [
        'state',
        'updateModel',
        'sidecarStatus',
        'clientsStatus',
        'openCodePreview',
        'openCodeSync',
        'hermesSync',
    ]) assert.equal(typeof service[name], 'function', `${name} must be a method`);
});

test('state emits the canonical DTO with published rows first and deduplicated candidates after', async () => {
    const current = manifest({
        'zeta/missing/model': meta('Zeta / Missing'),
        'alpha/model-a': meta('Alpha / Published'),
    });
    const candidateOptions = { providers: ['alpha', 'beta', 'zeta'], sentinel: 'candidate-options' };
    let resolverInput;
    const p = paths('state-order');
    const service = load().createApiGatewayDashboardService(baseDependencies({
        paths: p,
        readPublishedManifest: async received => {
            assert.strictEqual(received, p);
            return clone(current);
        },
        resolveModelCandidates: async received => {
            resolverInput = received;
            return [
                { id: 'beta/nested/model', provider: 'beta', model: 'nested/model', catalogSource: 'snapshot' },
                { id: 'alpha/model-a', provider: 'alpha', model: 'model-a', catalogSource: 'live' },
                { id: 'alpha/model-b', provider: 'alpha', model: 'model-b', catalogSource: 'accounts' },
                { id: 'alpha/model-b', provider: 'alpha', model: 'model-b', catalogSource: 'configured' },
            ];
        },
        candidateOptions,
    }));
    const state = await service.state();

    assert.strictEqual(resolverInput, candidateOptions);
    assert.deepEqual(state.public, publicUrls);
    assert.deepEqual(state.manifest, { version: 1, revision: 7, enabled: true });
    assert.deepEqual(state.models.map(row => row.id), [
        'alpha/model-a',
        'zeta/missing/model',
        'alpha/model-b',
        'beta/nested/model',
    ]);
    assert.equal(state.models.filter(row => row.id === 'alpha/model-a').length, 1);

    const published = byId(state, 'alpha/model-a');
    assert.deepEqual(published.catalog, { present: true, source: 'live' });
    assert.equal(published.published, true);
    assert.equal(published.displayName, 'Alpha / Published');
    assert.equal(published.publishedAt, '2026-11-10T00:00:00.000Z');

    const missing = byId(state, 'zeta/missing/model');
    assert.deepEqual(missing.catalog, { present: false, source: null });
    assert.equal(missing.published, true);

    const candidate = byId(state, 'beta/nested/model');
    assert.equal(candidate.provider, 'beta');
    assert.equal(candidate.model, 'nested/model');
    assert.equal(candidate.published, false);
    assert.equal(candidate.displayName, 'beta / nested/model');
    assert.equal(candidate.claudeBehavesAs, null);
    assert.ok(candidate.contextTokens > 0, 'неопубликованная строка показывает типовой контекст');
    assert.ok(candidate.outputTokens > 0, 'неопубликованная строка показывает типовой вывод');
    assert.equal(candidate.publishedAt, null);
    assert.deepEqual(Object.keys(candidate).sort(), [
        'catalog',
        'claudeBehavesAs',
        'contextTokens',
        'displayName',
        'health',
        'id',
        'limitsDefaulted',
        'model',
        'outputTokens',
        'passive',
        'probe',
        'provider',
        'published',
        'publishedAt',
    ].sort());
    // Пустые лимиты читались как «данные не пришли». У неопубликованной строки их никто не
    // задавал, поэтому сервер подставляет типовые значения и помечает их: подстановка не
    // должна выглядеть как прочитанные с провайдера числа.
    assert.deepEqual(candidate.limitsDefaulted, { contextTokens: true, outputTokens: true });
    assert.ok(candidate.contextTokens > 0 && candidate.outputTokens > 0);
    assert.deepEqual(published.limitsDefaulted, { contextTokens: false, outputTokens: false });
    assert.equal(state.ok, true);
});

test('health keeps publication independent and follows probe/passive timestamp semantics', async () => {
    const now = Date.parse('2026-11-11T12:00:00.000Z');
    const ids = [
        'p/catalog-only',
        'p/fresh-probe',
        'p/newer-traffic',
        'p/failed-probe',
        'p/stale-success',
        'p/stale-failure',
    ];
    const current = manifest(Object.fromEntries(ids.map(id => [id, meta(id)])));
    const candidates = ids.map(id => {
        const slash = id.indexOf('/');
        return { id, provider: id.slice(0, slash), model: id.slice(slash + 1), catalogSource: 'configured' };
    });
    const passive = {
        'p/newer-traffic': { lastSuccess: new Date(now - 30 * 60 * 1000).toISOString() },
        'p/failed-probe': { lastSuccess: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
        'p/stale-success': { lastSuccess: new Date(now - 25 * 60 * 60 * 1000).toISOString() },
    };
    const probes = {
        'p/fresh-probe': { ok: true, at: new Date(now - 60 * 60 * 1000).toISOString(), reason: null },
        'p/newer-traffic': { ok: false, at: new Date(now - 90 * 60 * 1000).toISOString(), reason: 'temporary failure' },
        'p/failed-probe': {
            ok: false,
            at: new Date(now - 60 * 60 * 1000).toISOString(),
            reason: `Bearer ${SECRET} for ${EMAIL} in ${PRIVATE_PATH}`,
        },
        'p/stale-failure': { ok: false, at: new Date(now - 25 * 60 * 60 * 1000).toISOString(), reason: 'old failure' },
    };
    const service = load().createApiGatewayDashboardService(baseDependencies({
        readPublishedManifest: async () => clone(current),
        resolveModelCandidates: async () => candidates,
        readPassive: async () => passive,
        readProbes: async () => probes,
        now: () => now,
    }));
    const state = await service.state();

    assert.equal(byId(state, 'p/catalog-only').health.state, 'unknown');
    assert.equal(byId(state, 'p/fresh-probe').health.state, 'healthy');
    assert.equal(byId(state, 'p/newer-traffic').health.state, 'healthy');
    assert.equal(byId(state, 'p/failed-probe').health.state, 'unhealthy');
    assert.equal(byId(state, 'p/stale-success').health.state, 'warning');
    assert.equal(byId(state, 'p/stale-failure').health.state, 'warning');
    assert.ok(ids.every(id => byId(state, id).published), 'health never changes publication');

    const failed = byId(state, 'p/failed-probe');
    assert.deepEqual(failed.passive, { lastSuccess: new Date(now - 2 * 60 * 60 * 1000).toISOString() });
    assert.equal(failed.probe.ok, false);
    assert.equal(failed.probe.at, new Date(now - 60 * 60 * 1000).toISOString());
    const text = jsonText(failed);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(EMAIL), false);
    assert.equal(text.includes(PRIVATE_PATH), false);
    assert.ok(failed.health.reason.length <= 160);
});

test('skipped probes are neutral health evidence', async () => {
    const now = Date.parse('2026-11-11T12:00:00.000Z');
    const current = manifest({
        'p/skipped-with-traffic': meta('Skipped with traffic'),
        'p/skipped-only': meta('Skipped only'),
    });
    const service = load().createApiGatewayDashboardService(baseDependencies({
        readPublishedManifest: async () => current,
        readPassive: async () => ({
            'p/skipped-with-traffic': {
                lastSuccess: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            },
        }),
        readProbes: async () => ({
            'p/skipped-with-traffic': {
                ok: false,
                skipped: 'low-balance',
                at: new Date(now - 60 * 60 * 1000).toISOString(),
                reason: 'low-balance',
            },
            'p/skipped-only': {
                ok: false,
                skipped: 'no-key',
                at: new Date(now - 60 * 60 * 1000).toISOString(),
                reason: 'no-key',
            },
        }),
        now: () => now,
    }));
    const state = await service.state();
    const withTraffic = byId(state, 'p/skipped-with-traffic');
    const skippedOnly = byId(state, 'p/skipped-only');
    assert.equal(withTraffic.probe.ok, null);
    assert.equal(withTraffic.health.state, 'healthy');
    assert.equal(skippedOnly.probe.ok, null);
    assert.equal(skippedOnly.health.state, 'unknown');
});

test('evidence keys split at the provider delimiter before nested model slashes', async () => {
    const now = Date.parse('2026-11-11T12:00:00.000Z');
    const id = 'nested/vendor/family/model';
    const service = load().createApiGatewayDashboardService(baseDependencies({
        readPublishedManifest: async () => manifest({ [id]: meta('Nested') }),
        resolveModelCandidates: async () => [{
            id,
            provider: 'nested',
            model: 'vendor/family/model',
            catalogSource: 'live',
        }],
        readPassive: async () => ({
            'nested|vendor/family/model': { last_seen: new Date(now - 30 * 60 * 1000).toISOString() },
        }),
        readProbes: async () => ({
            'nested|vendor/family/model': {
                ok: false,
                at: new Date(now - 90 * 60 * 1000).toISOString(),
                reason: 'older failure',
            },
        }),
        now: () => now,
    }));
    const row = byId(await service.state(), id);
    assert.deepEqual(row.passive, { lastSuccess: new Date(now - 30 * 60 * 1000).toISOString() });
    assert.equal(row.probe.ok, false);
    assert.equal(row.health.state, 'healthy');
});

test('state tolerates unavailable evidence and status readers without dropping published rows', async () => {
    const current = manifest({ 'p/retained': meta('Published and retained') });
    const service = load().createApiGatewayDashboardService(baseDependencies({
        readPublishedManifest: async () => clone(current),
        resolveModelCandidates: async () => { throw new Error('catalog unavailable'); },
        readPassive: async () => { throw new Error('passive unavailable'); },
        readProbes: async () => { throw new Error('probe unavailable'); },
        getSidecarStatus: async () => { throw new Error('sidecar unavailable'); },
        openCodeService: {
            status: async () => { throw new Error('opencode unavailable'); },
            preview: async () => ({ ok: true }),
            sync: async () => ({ ok: true }),
        },
        hermesService: {
            status: async () => { throw new Error('hermes unavailable'); },
            sync: async () => ({ ok: true }),
        },
    }));
    const state = await service.state();
    assert.equal(state.ok, true);
    assert.equal(byId(state, 'p/retained').published, true);
    assert.equal(byId(state, 'p/retained').health.state, 'unknown');
    assert.equal(state.sidecar.status, 'unavailable');
    assert.equal(state.clients.opencode.status, 'unavailable');
    assert.equal(state.clients.hermes.status, 'unavailable');
});

test('state passes paths to injected evidence and sidecar readers', async () => {
    const p = paths('reader-paths');
    const seen = {};
    const service = load().createApiGatewayDashboardService(baseDependencies({
        paths: p,
        readPassive: async received => { seen.passive = received; return {}; },
        readProbes: async received => { seen.probes = received; return {}; },
        getSidecarStatus: async received => { seen.sidecar = received; return { status: 'ready' }; },
    }));
    await service.state();
    assert.strictEqual(seen.passive, p);
    assert.strictEqual(seen.probes, p);
    assert.strictEqual(seen.sidecar, p);
});

test('updateModel uses the injected manifest transaction for publish, edit, and unpublish', async () => {
    const current = manifest({
        'alpha/existing': meta('Existing', '2026-11-01T00:00:00.000Z'),
        'beta/remove-me': meta('Remove me', '2026-11-02T00:00:00.000Z'),
    }, { revision: 11, enabled: false });
    const calls = [];
    const p = paths('update');
    const service = load().createApiGatewayDashboardService(baseDependencies({
        paths: p,
        readPublishedManifest: async received => {
            assert.strictEqual(received, p);
            return clone(current);
        },
        saveManifestAndPicker: async input => {
            calls.push(clone(input));
            return { ok: true, revision: input.expectedRevision + 1, enabled: input.draft.enabled, publishedModelCount: Object.keys(input.draft.models).length };
        },
        now: () => Date.parse('2026-11-11T12:34:56.000Z'),
    }));

    const publishInput = {
        expectedRevision: 11,
        id: 'alpha/new/nested-model',
        published: true,
        displayName: 'Alpha / New nested model',
        claudeBehavesAs: 'claude-sonnet-5',
        contextTokens: 200000,
        outputTokens: 16000,
    };
    const before = clone(publishInput);
    const published = await service.updateModel(publishInput);
    assert.deepEqual(publishInput, before, 'input is not mutated');
    assert.equal(published.revision, 12);
    assert.deepEqual(calls[0], {
        ...p,
        expectedRevision: 11,
        draft: {
            enabled: false,
            models: {
                ...current.models,
                'alpha/new/nested-model': {
                    displayName: 'Alpha / New nested model',
                    claudeBehavesAs: 'claude-sonnet-5',
                    contextTokens: 200000,
                    outputTokens: 16000,
                    publishedAt: '2026-11-11T12:34:56.000Z',
                },
            },
        },
    });

    await service.updateModel({
        expectedRevision: 11,
        id: 'alpha/existing',
        published: true,
        displayName: 'Renamed',
        claudeBehavesAs: 'claude-opus-5',
        contextTokens: 1000000,
        outputTokens: 64000,
    });
    assert.equal(calls[1].draft.models['alpha/existing'].publishedAt, '2026-11-01T00:00:00.000Z', 'edit keeps original publication timestamp');

    await service.updateModel({
        expectedRevision: 11,
        id: 'beta/remove-me',
        published: false,
        displayName: 'ignored',
        claudeBehavesAs: 'ignored',
        contextTokens: 1,
        outputTokens: 1,
    });
    assert.equal(Object.hasOwn(calls[2].draft.models, 'beta/remove-me'), false);
    assert.ok(Object.hasOwn(calls[2].draft.models, 'alpha/existing'));
    assert.equal(calls[2].draft.enabled, false);
    assert.equal(Object.hasOwn(calls[2], 'denylist'), false, 'unpublish never creates a callability denylist');
});

test('updateModel redacts the injected transaction result', async () => {
    const service = load().createApiGatewayDashboardService(baseDependencies({
        saveManifestAndPicker: async () => ({
            ok: true,
            revision: 8,
            token: SECRET,
            configPath: PRIVATE_PATH,
            note: `Bearer ${SECRET} ${EMAIL} "${PRIVATE_QUOTED_PATH}"`,
        }),
    }));
    const result = await service.updateModel({
        expectedRevision: 7,
        id: 'alpha/model-a',
        published: true,
        displayName: 'Alpha / Model A',
        claudeBehavesAs: 'claude-opus-5',
        contextTokens: 1000,
        outputTokens: 100,
    });
    const text = jsonText(result);
    assert.equal(result.ok, true);
    assert.equal(result.revision, 8);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(EMAIL), false);
    assert.equal(text.includes(PRIVATE_PATH), false);
    assert.equal(text.includes(PRIVATE_QUOTED_PATH), false);
    assert.equal(Object.hasOwn(result, 'token'), false);
    assert.equal(Object.hasOwn(result, 'configPath'), false);
});

test('updateModel rejects non-canonical input shape before the transaction', async () => {
    let saves = 0;
    const service = load().createApiGatewayDashboardService(baseDependencies({
        saveManifestAndPicker: async () => { saves += 1; return { ok: true }; },
    }));
    const good = {
        expectedRevision: 7,
        id: 'alpha/model-a',
        published: true,
        displayName: 'Alpha / Model A',
        claudeBehavesAs: 'claude-opus-5',
        contextTokens: 1000,
        outputTokens: 100,
    };
    for (const input of [
        null,
        { ...good, extra: true },
        { ...good, expectedRevision: 0 },
        { ...good, id: 'no-slash' },
        { ...good, published: 'true' },
        { ...good, displayName: '' },
        { ...good, claudeBehavesAs: '' },
        { ...good, contextTokens: 0 },
        { ...good, outputTokens: 1.5 },
    ]) {
        await assert.rejects(
            service.updateModel(input),
            error => error && error.code === 'api_gateway_dashboard_invalid_input' && error.status === 400,
        );
    }
    assert.equal(saves, 0);
});

test('sidecar and client methods delegate with one manifest snapshot and return redacted DTOs', async () => {
    const current = manifest({ 'alpha/model-a': meta('Alpha') }, { revision: 19 });
    let reads = 0;
    const seen = { status: [], preview: [], sync: [], hermesSyncArgs: null };
    const unsafe = {
        status: 'ready',
        token: SECRET,
        email: EMAIL,
        configPath: PRIVATE_PATH,
        note: `Bearer ${SECRET} ${EMAIL} ${PRIVATE_PATH} ${PRIVATE_SPACE_PATH} "${PRIVATE_QUOTED_PATH}"`,
    };
    const service = load().createApiGatewayDashboardService(baseDependencies({
        readPublishedManifest: async () => { reads += 1; return clone(current); },
        getSidecarStatus: async () => ({ ...unsafe, version: 'v2.5.0' }),
        openCodeService: {
            status: async value => { seen.status.push(value); return { ...unsafe, targets: [{ label: 'User', status: 'synced', path: PRIVATE_PATH }] }; },
            preview: async value => { seen.preview.push(value); return { ok: true, additions: ['alpha/model-a'], fullConfig: { secret: SECRET } }; },
            sync: async value => { seen.sync.push(value); return { ok: true, changed: 1, password: SECRET }; },
        },
        hermesService: {
            status: async () => ({ ...unsafe, status: 'absent', installCommand: 'uv tool install hermes-agent' }),
            sync: async (...args) => { seen.hermesSyncArgs = args; return { ok: true, status: 'absent', cookie: SECRET }; },
        },
    }));

    const sidecar = await service.sidecarStatus();
    assert.equal(sidecar.status, 'ready');
    assert.equal(sidecar.version, 'v2.5.0');

    const clients = await service.clientsStatus();
    assert.equal(reads, 1);
    assert.deepEqual(seen.status[0], current);
    assert.deepEqual(clients.claude, {
        status: 'managed-on-save',
        manifestRevision: 19,
        publishedModelCount: 1,
    });
    assert.equal(clients.opencode.status, 'ready');
    assert.equal(clients.hermes.status, 'absent');

    const preview = await service.openCodePreview();
    const sync = await service.openCodeSync();
    const hermes = await service.hermesSync();
    assert.deepEqual(seen.preview[0], current);
    assert.deepEqual(seen.sync[0], current);
    assert.deepEqual(seen.hermesSyncArgs, []);
    assert.deepEqual(preview.additions, ['alpha/model-a']);
    assert.equal(sync.changed, 1);
    assert.equal(hermes.status, 'absent');

    for (const dto of [sidecar, clients, preview, sync, hermes]) {
        const text = jsonText(dto);
        assert.equal(text.includes(SECRET), false);
        assert.equal(text.includes(EMAIL), false);
        assert.equal(text.includes(PRIVATE_PATH), false);
        assert.equal(text.includes(PRIVATE_SPACE_PATH), false);
        assert.equal(text.includes(PRIVATE_QUOTED_PATH), false);
        assert.equal(/"(?:token|password|cookie|path|configPath|fullConfig)"/i.test(text), false);
    }
});

test('state reuses one manifest snapshot for client cards and emits no private data', async () => {
    const current = manifest({ 'alpha/model-a': meta('Alpha') }, { revision: 23 });
    let reads = 0;
    let statusManifest;
    const service = load().createApiGatewayDashboardService(baseDependencies({
        readPublishedManifest: async () => { reads += 1; return clone(current); },
        getSidecarStatus: async () => ({
            status: 'ready',
            apiKey: SECRET,
            note: `Bearer ${SECRET} ${EMAIL} ${PRIVATE_PATH} ${PRIVATE_SPACE_PATH} "${PRIVATE_QUOTED_PATH}"`,
        }),
        openCodeService: {
            status: async value => { statusManifest = value; return { status: 'synced', email: EMAIL }; },
            preview: async () => ({ ok: true }),
            sync: async () => ({ ok: true }),
        },
        hermesService: {
            status: async () => ({ status: 'absent', root: PRIVATE_PATH }),
            sync: async () => ({ ok: true }),
        },
    }));
    const state = await service.state();
    assert.equal(reads, 1);
    assert.deepEqual(statusManifest, current);
    assert.equal(state.clients.claude.manifestRevision, 23);
    const text = jsonText(state);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(EMAIL), false);
    assert.equal(text.includes(PRIVATE_PATH), false);
    assert.equal(text.includes(PRIVATE_SPACE_PATH), false);
});

// Вкладка не должна показывать провайдеров, чью вкладку владелец спрятал: 12.11 на экране
// было 29 провайдеров и 1080 строк при одном опубликованном. Фильтр едет в самом запросе
// каталога, чтобы скрытый шлюз не опрашивался сетью, а опубликованная строка остаётся даже
// если её провайдер скрыт - иначе точный ID остаётся без ручки.
test('state discovers only the providers passed by the caller and always keeps published rows', async () => {
    const current = manifest({
        'alpha/model-a': meta('Alpha / Published'),
        'hidden/model-x': meta('Hidden / Published'),
    });
    const configured = { providers: ['alpha', 'beta'] };
    const seen = [];
    const service = load().createApiGatewayDashboardService(baseDependencies({
        readPublishedManifest: async () => clone(current),
        candidateOptions: configured,
        resolveModelCandidates: async options => {
            seen.push(options);
            return [
                { id: 'alpha/model-a', provider: 'alpha', model: 'model-a', catalogSource: 'live' },
                { id: 'alpha/model-b', provider: 'alpha', model: 'model-b', catalogSource: 'live' },
                { id: 'beta/model-c', provider: 'beta', model: 'model-c', catalogSource: 'live' },
                { id: 'gamma/model-d', provider: 'gamma', model: 'model-d', catalogSource: 'live' },
            ];
        },
    }));

    const state = await service.state({ providers: ['alpha', 'beta'] });

    assert.deepEqual(seen, [{ ...configured, providers: ['alpha', 'beta'] }],
        'filtr должен уйти в каталог, иначе скрытые шлюзы опрашиваются сетью');
    assert.deepEqual(state.models.map(row => row.id).sort(), [
        'alpha/model-a',
        'alpha/model-b',
        'beta/model-c',
        'hidden/model-x',
    ], 'скрытый провайдер gamma не попадает, опубликованная строка hidden остаётся');

    await service.state();
    assert.deepEqual(seen[1], configured, 'без фильтра каталог спрашивается как раньше');
});
