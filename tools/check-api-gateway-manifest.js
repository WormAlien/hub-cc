#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'routing', 'lib', 'api-gateway.js');
const DEFAULT_PATH = path.join(ROOT, 'routing', 'api-gateway.default.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-manifest-'));

after(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
});

const APPROVED_SEED = {
    version: 1,
    revision: 1,
    enabled: true,
    models: {
        'agentrouter/gpt-5.6-sol': {
            displayName: 'AgentRouter / GPT 5.6 Sol',
            claudeBehavesAs: 'claude-opus-5',
            contextTokens: 1050000,
            outputTokens: 32000,
            publishedAt: '2026-11-09T00:00:00.000Z',
        },
    },
};
const APPROVED_SEED_TEXT = JSON.stringify(APPROVED_SEED, null, 2) + '\n';
const META = APPROVED_SEED.models['agentrouter/gpt-5.6-sol'];

function loadLibrary() {
    return require(LIB_PATH);
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function fixture(name, providers = { agentrouter: {}, second: {} }, aliases = { ar: 'agentrouter' }) {
    const dir = path.join(TMP, name);
    fs.mkdirSync(dir, { recursive: true });
    const backendsPath = path.join(dir, 'backends.json');
    writeJson(backendsPath, { providers, aliases });
    return {
        dir,
        backendsPath,
        defaultManifestPath: path.join(dir, 'api-gateway.default.json'),
        manifestPath: path.join(dir, 'api-gateway.json'),
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function expectCode(fn, code) {
    let error = null;
    try { fn(); } catch (caught) { error = caught; }
    assert.ok(error, `expected ${code}`);
    assert.equal(error.name, 'ApiGatewayError');
    assert.equal(error.code, code);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
    return error;
}

test('exports the Slice 1A manifest core API', () => {
    assert.ok(fs.existsSync(LIB_PATH), 'routing/lib/api-gateway.js must exist');
    const lib = loadLibrary();
    for (const name of [
        'ApiGatewayError',
        'readCanonicalProviders',
        'parseCanonicalId',
        'recognizeCallableModel',
        'validateManifest',
        'prepareManifestUpdate',
        'ensureLocalManifest',
        'readManifest',
        'toOpenAiModels',
    ]) {
        assert.equal(typeof lib[name], 'function', `${name} must be exported`);
    }
});

test('tracked default manifest is byte-exact approved seed', () => {
    assert.equal(fs.readFileSync(DEFAULT_PATH, 'utf8'), APPROVED_SEED_TEXT);
});

test('canonical provider reader uses raw provider keys and never aliases', () => {
    const lib = loadLibrary();
    const f = fixture('providers', { agentrouter: {}, 'vendor-two': {}, CaseKey: {} }, {
        ar: 'agentrouter',
        AGENTROUTER: 'agentrouter',
        v2: 'vendor-two',
    });
    const providers = lib.readCanonicalProviders(f.backendsPath);
    assert.ok(providers instanceof Set);
    assert.deepEqual([...providers], ['agentrouter', 'vendor-two', 'CaseKey']);
    assert.equal(providers.has('ar'), false);
    assert.equal(providers.has('AGENTROUTER'), false);
});

test('canonical parser splits once and preserves nested model remainder exactly', () => {
    const lib = loadLibrary();
    const providers = new Set(['agentrouter']);
    assert.deepEqual(lib.parseCanonicalId('agentrouter/vendor/family/model:v1', providers), {
        id: 'agentrouter/vendor/family/model:v1',
        provider: 'agentrouter',
        model: 'vendor/family/model:v1',
    });
});

test('canonical parser treats every byte after the first slash as the model remainder', () => {
    const lib = loadLibrary();
    const providers = new Set(['agentrouter']);
    assert.deepEqual(lib.parseCanonicalId('agentrouter/vendor//family/model', providers), {
        id: 'agentrouter/vendor//family/model',
        provider: 'agentrouter',
        model: 'vendor//family/model',
    });
});

test('canonical parser rejects aliases, unknown providers, and malformed IDs', () => {
    const lib = loadLibrary();
    const providers = new Set(['agentrouter']);
    expectCode(() => lib.parseCanonicalId('ar/gpt-5.6-sol', providers), 'api_gateway_unknown_provider');
    expectCode(() => lib.parseCanonicalId('unknown/gpt-5.6-sol', providers), 'api_gateway_unknown_provider');
    for (const id of [
        null,
        '',
        'agentrouter',
        '/gpt-5.6-sol',
        'agentrouter/',
        ' agentrouter/gpt-5.6-sol',
        'agentrouter/gpt-5.6-sol ',
        'agentrouter/gpt\n5',
    ]) {
        expectCode(() => lib.parseCanonicalId(id, providers), 'api_gateway_invalid_model');
    }
});

test('callable recognition depends only on canonical registry, not publication state', () => {
    const lib = loadLibrary();
    const f = fixture('hidden-callable', { agentrouter: {} }, { ar: 'agentrouter' });
    assert.equal(fs.existsSync(f.manifestPath), false);
    assert.deepEqual(
        lib.recognizeCallableModel('agentrouter/vendor/family/model', { backendsPath: f.backendsPath }),
        { id: 'agentrouter/vendor/family/model', provider: 'agentrouter', model: 'vendor/family/model' },
    );
    assert.equal(fs.existsSync(f.manifestPath), false);
    expectCode(
        () => lib.recognizeCallableModel('ar/vendor/family/model', { backendsPath: f.backendsPath }),
        'api_gateway_unknown_provider',
    );
});

test('manifest validation accepts the approved strict v1 document', () => {
    const lib = loadLibrary();
    const value = clone(APPROVED_SEED);
    assert.strictEqual(lib.validateManifest(value, new Set(['agentrouter'])), value);
});

test('manifest validation rejects top-level schema violations', () => {
    const lib = loadLibrary();
    const providers = new Set(['agentrouter']);
    const invalid = [];
    invalid.push(null, [], 'manifest');
    for (const key of ['version', 'revision', 'enabled', 'models']) {
        const doc = clone(APPROVED_SEED);
        delete doc[key];
        invalid.push(doc);
    }
    for (const [key, value] of [
        ['version', 2],
        ['revision', 0],
        ['revision', -1],
        ['revision', 1.5],
        ['revision', Number.MAX_SAFE_INTEGER + 1],
        ['enabled', 1],
        ['models', []],
        ['models', null],
    ]) {
        const doc = clone(APPROVED_SEED);
        doc[key] = value;
        invalid.push(doc);
    }
    const extra = clone(APPROVED_SEED);
    extra.discovery = {};
    invalid.push(extra);
    const polluted = clone(APPROVED_SEED);
    Object.setPrototypeOf(polluted, { inherited: true });
    invalid.push(polluted);
    const dangerous = clone(APPROVED_SEED);
    dangerous.models = JSON.parse('{"__proto__":{"displayName":"x"}}');
    invalid.push(dangerous);
    const dangerousConstructor = clone(APPROVED_SEED);
    dangerousConstructor.models = JSON.parse('{"constructor":{"displayName":"x"}}');
    invalid.push(dangerousConstructor);

    for (const doc of invalid) {
        expectCode(() => lib.validateManifest(doc, providers), 'api_gateway_manifest_invalid');
    }
});

test('manifest validation rejects metadata schema and canonical ID violations', () => {
    const lib = loadLibrary();
    const providers = new Set(['agentrouter']);
    const variants = [];
    for (const key of ['displayName', 'claudeBehavesAs', 'contextTokens', 'outputTokens', 'publishedAt']) {
        const doc = clone(APPROVED_SEED);
        delete doc.models['agentrouter/gpt-5.6-sol'][key];
        variants.push(doc);
    }
    for (const [key, value] of [
        ['displayName', '   '],
        ['claudeBehavesAs', ''],
        ['contextTokens', 0],
        ['contextTokens', 1.25],
        ['outputTokens', Number.MAX_SAFE_INTEGER + 1],
        ['publishedAt', '2026-11-09T00:00:00Z'],
        ['publishedAt', 'not-a-date'],
    ]) {
        const doc = clone(APPROVED_SEED);
        doc.models['agentrouter/gpt-5.6-sol'][key] = value;
        variants.push(doc);
    }
    const extra = clone(APPROVED_SEED);
    extra.models['agentrouter/gpt-5.6-sol'].health = 'healthy';
    variants.push(extra);
    const alias = clone(APPROVED_SEED);
    alias.models['ar/gpt-5.6-sol'] = alias.models['agentrouter/gpt-5.6-sol'];
    delete alias.models['agentrouter/gpt-5.6-sol'];
    variants.push(alias);
    const unknown = clone(APPROVED_SEED);
    unknown.models['unknown/gpt-5.6-sol'] = unknown.models['agentrouter/gpt-5.6-sol'];
    delete unknown.models['agentrouter/gpt-5.6-sol'];
    variants.push(unknown);
    const malformed = clone(APPROVED_SEED);
    malformed.models.agentrouter = malformed.models['agentrouter/gpt-5.6-sol'];
    delete malformed.models['agentrouter/gpt-5.6-sol'];
    variants.push(malformed);

    for (const doc of variants) {
        expectCode(() => lib.validateManifest(doc, providers), 'api_gateway_manifest_invalid');
    }
});

test('manifest update checks expected revision and increments without mutating inputs', () => {
    const lib = loadLibrary();
    const providers = new Set(['agentrouter']);
    const current = clone(APPROVED_SEED);
    const draft = clone(APPROVED_SEED);
    draft.enabled = false;
    draft.revision = 999;
    const currentBefore = JSON.stringify(current);
    const draftBefore = JSON.stringify(draft);
    const next = lib.prepareManifestUpdate(current, draft, 1, providers);
    assert.equal(next.revision, 2);
    assert.equal(next.enabled, false);
    assert.equal(JSON.stringify(current), currentBefore);
    assert.equal(JSON.stringify(draft), draftBefore);
    expectCode(
        () => lib.prepareManifestUpdate(current, draft, 0, providers),
        'api_gateway_revision_conflict',
    );
    expectCode(
        () => lib.prepareManifestUpdate(current, draft, 2, providers),
        'api_gateway_revision_conflict',
    );
});

test('local manifest seeds once through the default and is never overwritten', () => {
    const lib = loadLibrary();
    const f = fixture('seed-once', { agentrouter: {} });
    fs.writeFileSync(f.defaultManifestPath, APPROVED_SEED_TEXT, 'utf8');

    const seeded = lib.ensureLocalManifest(f);
    assert.deepEqual(seeded, APPROVED_SEED);
    assert.equal(fs.readFileSync(f.manifestPath, 'utf8'), APPROVED_SEED_TEXT);

    const ownerState = clone(APPROVED_SEED);
    ownerState.revision = 7;
    ownerState.enabled = false;
    writeJson(f.manifestPath, ownerState);
    const before = fs.readFileSync(f.manifestPath);
    const existing = lib.ensureLocalManifest(f);
    assert.deepEqual(existing, ownerState);
    assert.deepEqual(fs.readFileSync(f.manifestPath), before);
});

test('ensure and read fail closed without changing corrupt or zeroed local bytes', () => {
    const lib = loadLibrary();
    const f = fixture('corrupt-preserve', { agentrouter: {} });
    fs.writeFileSync(f.defaultManifestPath, APPROVED_SEED_TEXT, 'utf8');

    const corrupt = Buffer.from('{"secret-sentinel":"not-json"', 'utf8');
    fs.writeFileSync(f.manifestPath, corrupt);
    const corruptError = expectCode(() => lib.ensureLocalManifest(f), 'api_gateway_unavailable');
    assert.deepEqual(fs.readFileSync(f.manifestPath), corrupt);
    assert.equal(corruptError.message.includes('secret-sentinel'), false);
    assert.equal(corruptError.message.includes(f.manifestPath), false);
    expectCode(() => lib.readManifest(f), 'api_gateway_unavailable');
    assert.deepEqual(fs.readFileSync(f.manifestPath), corrupt);

    const zeroed = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);
    fs.writeFileSync(f.manifestPath, zeroed);
    expectCode(() => lib.ensureLocalManifest(f), 'api_gateway_unavailable');
    assert.deepEqual(fs.readFileSync(f.manifestPath), zeroed);
    expectCode(() => lib.readManifest(f), 'api_gateway_unavailable');
    assert.deepEqual(fs.readFileSync(f.manifestPath), zeroed);
});

test('ensure seeds only on ENOENT and leaves other filesystem states untouched', () => {
    const lib = loadLibrary();
    const f = fixture('enoent-only', { agentrouter: {} });
    fs.writeFileSync(f.defaultManifestPath, APPROVED_SEED_TEXT, 'utf8');
    fs.mkdirSync(f.manifestPath);
    expectCode(() => lib.ensureLocalManifest(f), 'api_gateway_unavailable');
    assert.equal(fs.statSync(f.manifestPath).isDirectory(), true);
});

test('first-run seeding shares the manifest writer lock and retires a stale owner', () => {
    const lib = loadLibrary();
    const f = fixture('seed-lock', { agentrouter: {} });
    fs.writeFileSync(f.defaultManifestPath, APPROVED_SEED_TEXT, 'utf8');
    const lockPath = `${f.manifestPath}.lock`;
    fs.writeFileSync(lockPath, String(process.pid), 'utf8');
    expectCode(() => lib.ensureLocalManifest(f), 'api_gateway_busy');
    assert.equal(fs.existsSync(f.manifestPath), false);

    const dead = require('node:child_process').spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    fs.writeFileSync(lockPath, String(dead.pid), 'utf8');
    assert.deepEqual(lib.ensureLocalManifest(f), APPROVED_SEED);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.readFileSync(f.manifestPath, 'utf8'), APPROVED_SEED_TEXT);
});

test('crashed update overlay restores owner manifest before first-run seed logic', () => {
    const lib = loadLibrary();
    const f = fixture('update-overlay-crash', { agentrouter: {} });
    fs.writeFileSync(f.defaultManifestPath, APPROVED_SEED_TEXT, 'utf8');
    const owner = clone(APPROVED_SEED);
    owner.revision = 9;
    owner.enabled = false;
    writeJson(f.manifestPath, owner);
    const ownerBytes = fs.readFileSync(f.manifestPath);
    const script = `
      const fs = require('node:fs');
      const lib = require(${JSON.stringify(LIB_PATH)});
      const lock = ${JSON.stringify(`${f.manifestPath}.lock`)};
      lib.acquireManifestLock(lock);
      lib.beginManifestUpdateOverlayLocked({ manifestPath: ${JSON.stringify(f.manifestPath)} });
      fs.unlinkSync(${JSON.stringify(f.manifestPath)});
      process.exit(56);
    `;
    const crashed = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(crashed.status, 56, crashed.stderr);
    assert.equal(fs.existsSync(f.manifestPath), false);
    assert.equal(fs.existsSync(`${f.manifestPath}.update-txn`), true);

    assert.deepEqual(lib.ensureLocalManifest(f), owner);
    assert.deepEqual(fs.readFileSync(f.manifestPath), ownerBytes);
    assert.equal(fs.existsSync(`${f.manifestPath}.update-txn`), false);
    assert.equal(fs.existsSync(`${f.manifestPath}.lock`), false);
});

test('update overlay recovery finishes when owner bytes are already restored but backup cleanup crashed', () => {
    const lib = loadLibrary();
    const f = fixture('update-overlay-cleanup-crash', { agentrouter: {} });
    const owner = clone(APPROVED_SEED);
    owner.revision = 11;
    writeJson(f.manifestPath, owner);
    const ownerBytes = fs.readFileSync(f.manifestPath);
    const lockPath = `${f.manifestPath}.lock`;
    const lockFd = lib.acquireManifestLock(lockPath);
    lib.beginManifestUpdateOverlayLocked({ manifestPath: f.manifestPath });
    const backup = fs.readdirSync(path.dirname(f.manifestPath))
        .map(name => path.join(path.dirname(f.manifestPath), name))
        .find(file => /\.bak-api-gateway-update-/.test(file));
    assert.ok(backup);
    fs.unlinkSync(backup);
    lib.releaseManifestLock(lockPath, lockFd);

    assert.deepEqual(lib.ensureLocalManifest(f), owner);
    assert.deepEqual(fs.readFileSync(f.manifestPath), ownerBytes);
    assert.equal(fs.existsSync(`${f.manifestPath}.update-txn`), false);
});

test('fresh malformed lock fails closed while an old crash artifact is retired', () => {
    const lib = loadLibrary();
    const f = fixture('malformed-lock', { agentrouter: {} });
    fs.writeFileSync(f.defaultManifestPath, APPROVED_SEED_TEXT, 'utf8');
    const lockPath = `${f.manifestPath}.lock`;
    fs.writeFileSync(lockPath, '', 'utf8');
    expectCode(() => lib.ensureLocalManifest(f), 'api_gateway_busy');
    assert.equal(fs.existsSync(f.manifestPath), false);

    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lockPath, old, old);
    assert.deepEqual(lib.ensureLocalManifest(f), APPROVED_SEED);
    assert.equal(fs.existsSync(lockPath), false);
});

test('failed lock initialization removes the incomplete lock immediately', () => {
    const lib = loadLibrary();
    const f = fixture('lock-init-failure', { agentrouter: {} });
    fs.writeFileSync(f.defaultManifestPath, APPROVED_SEED_TEXT, 'utf8');
    const originalFsync = fs.fsyncSync;
    let injected = false;
    fs.fsyncSync = function failFirstFsync(fd) {
        if (!injected) {
            injected = true;
            throw Object.assign(new Error('injected lock fsync failure'), { code: 'EIO' });
        }
        return originalFsync(fd);
    };
    try {
        expectCode(() => lib.ensureLocalManifest(f), 'api_gateway_unavailable');
    } finally {
        fs.fsyncSync = originalFsync;
    }
    assert.equal(fs.existsSync(`${f.manifestPath}.lock`), false);
    assert.equal(fs.existsSync(f.manifestPath), false);
});

test('invalid default never creates a local manifest', () => {
    const lib = loadLibrary();
    const f = fixture('bad-default', { agentrouter: {} });
    fs.writeFileSync(f.defaultManifestPath, '{bad default', 'utf8');
    expectCode(() => lib.ensureLocalManifest(f), 'api_gateway_unavailable');
    assert.equal(fs.existsSync(f.manifestPath), false);
});

test('OpenAI model projection is exact, sorted, and disabled state is stable', () => {
    const lib = loadLibrary();
    const manifest = {
        version: 1,
        revision: 3,
        enabled: true,
        models: {
            'second/z-model': {
                ...META,
                displayName: 'Z model',
                publishedAt: '2026-11-09T00:00:02.999Z',
            },
            'agentrouter/a/model': {
                ...META,
                displayName: 'A model',
                publishedAt: '2026-11-09T00:00:01.001Z',
            },
        },
    };
    assert.deepEqual(lib.toOpenAiModels(manifest), [
        { id: 'agentrouter/a/model', object: 'model', created: 1794182401, owned_by: 'abuse-hub' },
        { id: 'second/z-model', object: 'model', created: 1794182402, owned_by: 'abuse-hub' },
    ]);
    manifest.enabled = false;
    expectCode(() => lib.toOpenAiModels(manifest), 'api_gateway_disabled');
});

test('registry and manifest read failures expose only stable redacted errors', () => {
    const lib = loadLibrary();
    const f = fixture('redaction', { agentrouter: {} });
    const secret = 'do-not-print-private-value';
    fs.writeFileSync(f.backendsPath, `{ "${secret}":`, 'utf8');
    const registryError = expectCode(
        () => lib.readCanonicalProviders(f.backendsPath),
        'api_gateway_unavailable',
    );
    assert.equal(registryError.message.includes(secret), false);
    assert.equal(registryError.message.includes(f.backendsPath), false);
});
