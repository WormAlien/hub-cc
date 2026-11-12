'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'routing', 'lib', 'api-gateway.js');
const DURABLE_PATH = path.join(ROOT, 'routing', 'lib', 'durable-write.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-sync-'));
const SECRET = 'fixture-secret-never-log';

const META = {
    displayName: 'AgentRouter / GPT 5.6 Sol',
    claudeBehavesAs: 'claude-opus-5',
    contextTokens: 1050000,
    outputTokens: 32000,
    publishedAt: '2026-11-09T00:00:00.000Z',
};
const INITIAL_MANIFEST = {
    version: 1,
    revision: 1,
    enabled: true,
    models: { 'agentrouter/gpt-5.6-sol': META },
};
const SECOND_META = {
    displayName: 'AgentRouter / Vendor Model',
    claudeBehavesAs: 'claude-sonnet-5',
    contextTokens: 200000,
    outputTokens: 16000,
    publishedAt: '2026-11-09T00:00:01.000Z',
};

const originalHome = process.env.HOME;
const originalProfile = process.env.USERPROFILE;
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

after(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
    fs.rmSync(TMP, { recursive: true, force: true });
});

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function settingsValue() {
    return {
        model: 'agentrouter/current-model-must-not-change',
        env: { ANTHROPIC_AUTH_TOKEN: SECRET, CLAUDE_CODE_MAX_CONTEXT_TOKENS: '999999' },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'safe-fixture' }] }] },
        plugins: { 'fixture-plugin': true },
        permissions: { allow: ['Read'], deny: ['Network'] },
        mcpServers: { fixture: { command: 'never-run' } },
        modelSettings: { effort: 'high', nested: { sentinel: SECRET } },
        unknownFutureField: { array: [1, { keep: true }] },
        modelPicker: { replaceBuiltInOptions: false, options: [{ model: 'old' }] },
    };
}

function encodeSettings(value) {
    return Buffer.from('﻿' + JSON.stringify(value, null, 4).replace(/\n/g, '\r\n') + '\r\n', 'utf8');
}

function fixture(name) {
    const dir = fs.mkdtempSync(path.join(TMP, `${name}-`));
    const manifestPath = path.join(dir, 'routing', 'api-gateway.json');
    const backendsPath = path.join(dir, '.claude', 'backends.json');
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    writeJson(manifestPath, INITIAL_MANIFEST);
    writeJson(backendsPath, { providers: { agentrouter: {} }, aliases: { ar: 'agentrouter' } });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, encodeSettings(settingsValue()));
    return { dir, manifestPath, backendsPath, settingsPath };
}

function draft(enabled = true) {
    return {
        enabled,
        models: {
            'agentrouter/gpt-5.6-sol': { ...META },
            'agentrouter/vendor/model': { ...SECOND_META },
        },
    };
}

function load() {
    delete require.cache[require.resolve(LIB_PATH)];
    return require(LIB_PATH);
}

function parseJsonBytes(raw) {
    let text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
}

function expectCode(fn, code) {
    let caught = null;
    try { fn(); } catch (error) { caught = error; }
    assert.ok(caught, `expected ${code}`);
    assert.equal(caught.code, code);
    assert.equal(caught.message.includes(SECRET), false);
    return caught;
}

function hash(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function filesRecursively(dir) {
    const out = [];
    const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full); else out.push(full);
        }
    };
    walk(dir);
    return out;
}

function transientFiles(dir) {
    return filesRecursively(dir).filter(file => /\.txn$|\.lock$|\.stage-|\.tmp-/i.test(path.basename(file)));
}

function backupFiles(dir) {
    return filesRecursively(dir).filter(file => /\.bak-api-gateway-/i.test(path.basename(file)));
}

function saveOptions(f, extra = {}) {
    return {
        manifestPath: f.manifestPath,
        backendsPath: f.backendsPath,
        settingsPath: f.settingsPath,
        expectedRevision: 1,
        draft: draft(),
        ...extra,
    };
}

test('exports picker projection and transaction APIs', () => {
    const lib = load();
    for (const name of [
        'buildModelPicker',
        'patchModelPicker',
        'saveManifestAndPicker',
        'recoverManifestAndPicker',
    ]) assert.equal(typeof lib[name], 'function', `${name} must be exported`);
});

test('picker projection is deterministic and patch changes only modelPicker', () => {
    const lib = load();
    const manifest = {
        version: 1,
        revision: 8,
        enabled: true,
        models: {
            'agentrouter/vendor/model': SECOND_META,
            'agentrouter/gpt-5.6-sol': META,
        },
    };
    const picker = lib.buildModelPicker(manifest);
    assert.deepEqual(picker, {
        replaceBuiltInOptions: true,
        options: [
            {
                // Манифест объявляет 1050000 контекста - пикер обязан отдать `[1m]`, иначе
                // выбранная из него модель даёт клиенту окно 200k (регресс 12.11).
                model: 'agentrouter/gpt-5.6-sol[1m]',
                label: 'AgentRouter / GPT 5.6 Sol',
                description: 'ABUSE HUB',
                behavesAs: 'claude-opus-5',
            },
            {
                // 200k в манифесте - суффикса быть не должно.
                model: 'agentrouter/vendor/model',
                label: 'AgentRouter / Vendor Model',
                description: 'ABUSE HUB',
                behavesAs: 'claude-sonnet-5',
            },
        ],
    });
    const original = settingsValue();
    const before = structuredClone(original);
    const patched = lib.patchModelPicker(original, picker);
    assert.deepEqual(original, before, 'input settings are not mutated');
    const oldPicker = patched.modelPicker;
    delete patched.modelPicker;
    delete before.modelPicker;
    assert.deepEqual(patched, before, 'every field except modelPicker is unchanged');
    assert.deepEqual(oldPicker, picker);
    assert.equal(Object.hasOwn(patched, 'availableModels'), false);

    manifest.enabled = false;
    assert.deepEqual(lib.buildModelPicker(manifest), {
        replaceBuiltInOptions: true,
        options: [],
    });
});

test('field-only patch preserves an own __proto__ key without changing object prototype', () => {
    const lib = load();
    const settings = JSON.parse('{"__proto__":{"sentinel":"keep"},"model":"x"}');
    const patched = lib.patchModelPicker(settings, { replaceBuiltInOptions: true, options: [] });
    assert.equal(Object.getPrototypeOf(patched), Object.prototype);
    assert.equal(Object.hasOwn(patched, '__proto__'), true);
    assert.deepEqual(patched.__proto__, { sentinel: 'keep' });
    assert.equal(patched.model, 'x');
});

test('successful save increments once and preserves every unrelated settings value', () => {
    const lib = load();
    const f = fixture('success');
    const manifestBefore = fs.readFileSync(f.manifestPath);
    const settingsBefore = fs.readFileSync(f.settingsPath);
    const beforeValue = parseJsonBytes(settingsBefore);

    const result = lib.saveManifestAndPicker(saveOptions(f));
    assert.deepEqual(result, { ok: true, revision: 2, enabled: true, publishedModelCount: 2 });
    const manifestAfter = parseJsonBytes(fs.readFileSync(f.manifestPath));
    const settingsAfter = parseJsonBytes(fs.readFileSync(f.settingsPath));
    assert.equal(manifestAfter.revision, 2);
    assert.deepEqual(Object.keys(manifestAfter.models).sort(), [
        'agentrouter/gpt-5.6-sol',
        'agentrouter/vendor/model',
    ]);
    const installedPicker = settingsAfter.modelPicker;
    delete settingsAfter.modelPicker;
    delete beforeValue.modelPicker;
    assert.deepEqual(settingsAfter, beforeValue, 'only modelPicker changes');
    assert.equal(settingsAfter.model, 'agentrouter/current-model-must-not-change');
    assert.equal(settingsAfter.env.ANTHROPIC_AUTH_TOKEN, SECRET);
    assert.equal(Object.hasOwn(settingsAfter, 'availableModels'), false);
    assert.deepEqual(installedPicker, lib.buildModelPicker(manifestAfter));
    assert.notEqual(hash(f.manifestPath), crypto.createHash('sha256').update(manifestBefore).digest('hex'));

    const backups = backupFiles(f.dir);
    assert.equal(backups.length, 2, `expected two adjacent backups, got ${backups}`);
    assert.ok(backups.some(file => fs.readFileSync(file).equals(manifestBefore)), 'manifest backup is byte exact');
    assert.ok(backups.some(file => fs.readFileSync(file).equals(settingsBefore)), 'settings backup is byte exact');
    assert.deepEqual(transientFiles(f.dir), [], 'success leaves no journal, lock, stage, or temp file');

    expectCode(
        () => lib.saveManifestAndPicker(saveOptions(f)),
        'api_gateway_revision_conflict',
    );
    assert.equal(parseJsonBytes(fs.readFileSync(f.manifestPath)).revision, 2, 'second stale save does not write');
});

test('repeated saves keep exactly one adjacent backup pair', () => {
    const lib = load();
    const f = fixture('backup-retention');
    lib.saveManifestAndPicker(saveOptions(f));
    const manifestAfterFirst = fs.readFileSync(f.manifestPath);
    const settingsAfterFirst = fs.readFileSync(f.settingsPath);
    lib.saveManifestAndPicker(saveOptions(f, {
        expectedRevision: 2,
        draft: draft(false),
    }));
    const backups = backupFiles(f.dir);
    assert.equal(backups.length, 2, `only the latest backup pair is retained: ${backups}`);
    assert.ok(backups.some(file => fs.readFileSync(file).equals(manifestAfterFirst)));
    assert.ok(backups.some(file => fs.readFileSync(file).equals(settingsAfterFirst)));
});

test('stale revision and invalid settings fail before either target changes', () => {
    const lib = load();
    const stale = fixture('stale');
    const staleManifest = fs.readFileSync(stale.manifestPath);
    const staleSettings = fs.readFileSync(stale.settingsPath);
    expectCode(
        () => lib.saveManifestAndPicker(saveOptions(stale, { expectedRevision: 0 })),
        'api_gateway_revision_conflict',
    );
    assert.deepEqual(fs.readFileSync(stale.manifestPath), staleManifest);
    assert.deepEqual(fs.readFileSync(stale.settingsPath), staleSettings);
    assert.deepEqual(backupFiles(stale.dir), []);
    assert.deepEqual(transientFiles(stale.dir), []);

    const invalid = fixture('invalid-settings');
    fs.writeFileSync(invalid.settingsPath, Buffer.from(`{"secret":"${SECRET}"`, 'utf8'));
    const invalidManifest = fs.readFileSync(invalid.manifestPath);
    const invalidSettings = fs.readFileSync(invalid.settingsPath);
    expectCode(
        () => lib.saveManifestAndPicker(saveOptions(invalid)),
        'api_gateway_settings_invalid',
    );
    assert.deepEqual(fs.readFileSync(invalid.manifestPath), invalidManifest);
    assert.deepEqual(fs.readFileSync(invalid.settingsPath), invalidSettings);
    assert.deepEqual(backupFiles(invalid.dir), []);
    assert.deepEqual(transientFiles(invalid.dir), []);
});

test('source hash conflict preserves external settings edit and leaves manifest unchanged', () => {
    const lib = load();
    const f = fixture('source-conflict');
    const manifestBefore = fs.readFileSync(f.manifestPath);
    const external = encodeSettings({ ...settingsValue(), externalEdit: 'wins' });
    const error = expectCode(
        () => lib.saveManifestAndPicker(saveOptions(f, {
            onStep(step) {
                if (step === 'beforeCommit') fs.writeFileSync(f.settingsPath, external);
            },
        })),
        'api_gateway_source_conflict',
    );
    assert.equal(error.rolledBack, true);
    assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
    assert.deepEqual(fs.readFileSync(f.settingsPath), external);
    assert.deepEqual(transientFiles(f.dir), []);
});

test('update overlay refuses to start over a pending picker transaction', () => {
    const lib = load();
    const f = fixture('update-vs-picker');
    const lockPath = `${f.manifestPath}.lock`;
    const lockFd = lib.acquireManifestLock(lockPath);
    fs.writeFileSync(`${f.manifestPath}.txn`, '{"version":1}\n', 'utf8');
    expectCode(
        () => lib.beginManifestUpdateOverlayLocked({ manifestPath: f.manifestPath }),
        'api_gateway_busy',
    );
    lib.releaseManifestLock(lockPath, lockFd);
    assert.deepEqual(fs.readFileSync(f.manifestPath), Buffer.from(JSON.stringify(INITIAL_MANIFEST, null, 2) + '\n'));
    assert.equal(fs.existsSync(`${f.manifestPath}.update-txn`), false);
});

test('save recovers a crashed update overlay before checking revision', () => {
    const lib = load();
    const f = fixture('save-after-update-crash');
    const manifestBefore = fs.readFileSync(f.manifestPath);
    const script = `
      const fs = require('node:fs');
      const lib = require(${JSON.stringify(LIB_PATH)});
      const manifest = ${JSON.stringify(f.manifestPath)};
      lib.acquireManifestLock(manifest + '.lock');
      lib.beginManifestUpdateOverlayLocked({ manifestPath: manifest });
      fs.unlinkSync(manifest);
      process.exit(58);
    `;
    const crashed = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(crashed.status, 58, crashed.stderr);
    assert.equal(fs.existsSync(f.manifestPath), false);

    assert.deepEqual(lib.saveManifestAndPicker(saveOptions(f)), {
        ok: true, revision: 2, enabled: true, publishedModelCount: 2,
    });
    assert.equal(parseJsonBytes(fs.readFileSync(f.manifestPath)).revision, 2);
    assert.equal(fs.existsSync(`${f.manifestPath}.update-txn`), false);
    assert.equal(fs.existsSync(`${f.manifestPath}.lock`), false);
    assert.notDeepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
});

test('restart recovery cleans a crash after only the first stage', () => {
    const lib = load();
    const f = fixture('crash-after-first-stage');
    const manifestBefore = fs.readFileSync(f.manifestPath);
    const settingsBefore = fs.readFileSync(f.settingsPath);
    const script = `
      const lib = require(${JSON.stringify(LIB_PATH)});
      const opts = ${JSON.stringify(saveOptions(f))};
      opts.onStep = step => { if (step === 'afterManifestStage') process.exit(45); };
      lib.saveManifestAndPicker(opts);
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir },
        encoding: 'utf8',
    });
    assert.equal(child.status, 45, child.stderr);
    assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
    assert.deepEqual(fs.readFileSync(f.settingsPath), settingsBefore);
    assert.equal(fs.existsSync(`${f.manifestPath}.txn`), true, 'journal exists before staging');
    assert.ok(transientFiles(f.dir).some(file => /\.stage-/.test(file)), 'first stage survives the crash');
    assert.deepEqual(lib.recoverManifestAndPicker({
        manifestPath: f.manifestPath,
        backendsPath: f.backendsPath,
        settingsPath: f.settingsPath,
    }), { recovered: 'rolled_back' });
    assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
    assert.deepEqual(fs.readFileSync(f.settingsPath), settingsBefore);
    assert.deepEqual(transientFiles(f.dir), []);
});

test('partial staging failure leaves both targets unchanged and no transient debris', () => {
    const lib = load();
    const durable = require(DURABLE_PATH);
    const f = fixture('stage-failure');
    const manifestBefore = fs.readFileSync(f.manifestPath);
    const settingsBefore = fs.readFileSync(f.settingsPath);
    let stageCalls = 0;
    const injected = {
        ...durable,
        stageAtomicSync(...args) {
            stageCalls += 1;
            if (stageCalls === 2) throw Object.assign(new Error('second stage failed'), { code: 'EIO' });
            return durable.stageAtomicSync(...args);
        },
    };
    const error = expectCode(
        () => lib.saveManifestAndPicker(saveOptions(f, { durableImpl: injected })),
        'api_gateway_transaction_failed',
    );
    assert.equal(error.rolledBack, true);
    assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
    assert.deepEqual(fs.readFileSync(f.settingsPath), settingsBefore);
    assert.deepEqual(transientFiles(f.dir), []);
});

test('failure after manifest replacement rolls both targets back byte exact', () => {
    const lib = load();
    const f = fixture('rollback');
    const manifestBefore = fs.readFileSync(f.manifestPath);
    const settingsBefore = fs.readFileSync(f.settingsPath);
    const error = expectCode(
        () => lib.saveManifestAndPicker(saveOptions(f, {
            onStep(step) {
                if (step === 'afterManifestCommit') throw Object.assign(new Error('injected'), { code: 'EIO' });
            },
        })),
        'api_gateway_transaction_failed',
    );
    assert.equal(error.rolledBack, true);
    assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
    assert.deepEqual(fs.readFileSync(f.settingsPath), settingsBefore);
    const backups = backupFiles(f.dir);
    assert.equal(backups.length, 2);
    assert.ok(backups.some(file => fs.readFileSync(file).equals(manifestBefore)));
    assert.ok(backups.some(file => fs.readFileSync(file).equals(settingsBefore)));
    assert.deepEqual(transientFiles(f.dir), []);
});

test('failure while committing settings rolls the already committed manifest back', () => {
    const lib = load();
    const durable = require(DURABLE_PATH);
    const f = fixture('second-commit-failure');
    const manifestBefore = fs.readFileSync(f.manifestPath);
    const settingsBefore = fs.readFileSync(f.settingsPath);
    let commits = 0;
    const injected = {
        ...durable,
        commitAtomicSync(stage) {
            commits += 1;
            if (commits === 2) throw Object.assign(new Error('second rename failed'), { code: 'EACCES' });
            return durable.commitAtomicSync(stage);
        },
    };
    const error = expectCode(
        () => lib.saveManifestAndPicker(saveOptions(f, { durableImpl: injected })),
        'api_gateway_transaction_failed',
    );
    assert.equal(error.rolledBack, true);
    assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
    assert.deepEqual(fs.readFileSync(f.settingsPath), settingsBefore);
    assert.deepEqual(transientFiles(f.dir), []);
});

test('restart recovery rolls back a crash between the two commits', () => {
    const lib = load();
    const f = fixture('crash-between');
    const manifestBefore = fs.readFileSync(f.manifestPath);
    const settingsBefore = fs.readFileSync(f.settingsPath);
    const script = `
      const lib = require(${JSON.stringify(LIB_PATH)});
      const opts = ${JSON.stringify(saveOptions(f))};
      opts.onStep = step => { if (step === 'afterManifestCommit') process.exit(41); };
      lib.saveManifestAndPicker(opts);
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir },
        encoding: 'utf8',
    });
    assert.equal(child.status, 41, child.stderr);
    assert.notDeepEqual(fs.readFileSync(f.manifestPath), manifestBefore, 'manifest committed before crash');
    assert.deepEqual(fs.readFileSync(f.settingsPath), settingsBefore, 'settings not committed before crash');
    const recovered = lib.recoverManifestAndPicker({
        manifestPath: f.manifestPath,
        backendsPath: f.backendsPath,
        settingsPath: f.settingsPath,
    });
    assert.deepEqual(recovered, { recovered: 'rolled_back' });
    assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
    assert.deepEqual(fs.readFileSync(f.settingsPath), settingsBefore);
    assert.deepEqual(transientFiles(f.dir), []);
    assert.equal(backupFiles(f.dir).length, 2);
});

test('restart recovery accepts a crash after both commits', () => {
    const lib = load();
    const f = fixture('crash-after-both');
    const script = `
      const lib = require(${JSON.stringify(LIB_PATH)});
      const opts = ${JSON.stringify(saveOptions(f))};
      opts.onStep = step => { if (step === 'afterSettingsCommit') process.exit(42); };
      lib.saveManifestAndPicker(opts);
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir },
        encoding: 'utf8',
    });
    assert.equal(child.status, 42, child.stderr);
    const recovered = lib.recoverManifestAndPicker({
        manifestPath: f.manifestPath,
        backendsPath: f.backendsPath,
        settingsPath: f.settingsPath,
    });
    assert.deepEqual(recovered, { recovered: 'committed' });
    assert.equal(parseJsonBytes(fs.readFileSync(f.manifestPath)).revision, 2);
    assert.equal(parseJsonBytes(fs.readFileSync(f.settingsPath)).modelPicker.replaceBuiltInOptions, true);
    assert.deepEqual(transientFiles(f.dir), []);
});

test('live transaction lock blocks recovery, then stale owner is recovered', () => {
    const lib = load();
    const f = fixture('live-lock');
    const manifestBefore = fs.readFileSync(f.manifestPath);
    const settingsBefore = fs.readFileSync(f.settingsPath);
    const script = `
      const lib = require(${JSON.stringify(LIB_PATH)});
      const opts = ${JSON.stringify(saveOptions(f))};
      opts.onStep = step => { if (step === 'afterManifestCommit') process.exit(44); };
      lib.saveManifestAndPicker(opts);
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir },
        encoding: 'utf8',
    });
    assert.equal(child.status, 44, child.stderr);
    const lockPath = `${f.manifestPath}.lock`;
    const staleOwner = fs.readFileSync(lockPath);
    fs.writeFileSync(lockPath, String(process.pid), 'utf8');
    const manifestPartial = fs.readFileSync(f.manifestPath);
    expectCode(
        () => lib.recoverManifestAndPicker({
            manifestPath: f.manifestPath,
            backendsPath: f.backendsPath,
            settingsPath: f.settingsPath,
        }),
        'api_gateway_busy',
    );
    assert.deepEqual(fs.readFileSync(f.manifestPath), manifestPartial);
    assert.deepEqual(fs.readFileSync(f.settingsPath), settingsBefore);
    assert.equal(fs.existsSync(`${f.manifestPath}.txn`), true);

    fs.writeFileSync(lockPath, staleOwner);
    assert.deepEqual(lib.recoverManifestAndPicker({
        manifestPath: f.manifestPath,
        backendsPath: f.backendsPath,
        settingsPath: f.settingsPath,
    }), { recovered: 'rolled_back' });
    assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
    assert.deepEqual(fs.readFileSync(f.settingsPath), settingsBefore);
    assert.equal(fs.existsSync(lockPath), false);
});

test('stale lock without a journal does not block the next save', () => {
    const lib = load();
    const f = fixture('stale-lock');
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(Number.isInteger(dead.pid));
    fs.writeFileSync(`${f.manifestPath}.lock`, String(dead.pid), 'utf8');
    assert.deepEqual(lib.saveManifestAndPicker(saveOptions(f)), {
        ok: true, revision: 2, enabled: true, publishedModelCount: 2,
    });
    assert.equal(fs.existsSync(`${f.manifestPath}.lock`), false);
});
test('ambiguous save preserves owner edit and journal but releases its live lock', () => {
    const lib = load();
    const f = fixture('ambiguous-save');
    const manifestBefore = fs.readFileSync(f.manifestPath);
    const settingsBefore = fs.readFileSync(f.settingsPath);
    const ownerEdit = encodeSettings({ ...settingsValue(), concurrentOwnerEdit: true });
    expectCode(
        () => lib.saveManifestAndPicker(saveOptions(f, {
            onStep(step) {
                if (step === 'afterManifestCommit') {
                    fs.writeFileSync(f.settingsPath, ownerEdit);
                    throw new Error('external writer won');
                }
            },
        })),
        'api_gateway_recovery_conflict',
    );
    assert.deepEqual(fs.readFileSync(f.settingsPath), ownerEdit);
    assert.equal(fs.existsSync(`${f.manifestPath}.txn`), true);
    assert.equal(fs.existsSync(`${f.manifestPath}.lock`), false, 'finished writer must release its lock');

    fs.writeFileSync(f.settingsPath, settingsBefore);
    assert.deepEqual(lib.recoverManifestAndPicker({
        manifestPath: f.manifestPath,
        backendsPath: f.backendsPath,
        settingsPath: f.settingsPath,
    }), { recovered: 'rolled_back' });
    assert.deepEqual(fs.readFileSync(f.manifestPath), manifestBefore);
    assert.deepEqual(fs.readFileSync(f.settingsPath), settingsBefore);
});

test('recovery never overwrites an unexpected owner edit', () => {
    const lib = load();
    const f = fixture('recovery-conflict');
    const script = `
      const lib = require(${JSON.stringify(LIB_PATH)});
      const opts = ${JSON.stringify(saveOptions(f))};
      opts.onStep = step => { if (step === 'afterManifestCommit') process.exit(43); };
      lib.saveManifestAndPicker(opts);
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir },
        encoding: 'utf8',
    });
    assert.equal(child.status, 43, child.stderr);
    const ownerEdit = encodeSettings({ ...settingsValue(), ownerEditAfterCrash: true });
    fs.writeFileSync(f.settingsPath, ownerEdit);
    expectCode(
        () => lib.recoverManifestAndPicker({
            manifestPath: f.manifestPath,
            backendsPath: f.backendsPath,
            settingsPath: f.settingsPath,
        }),
        'api_gateway_recovery_conflict',
    );
    assert.deepEqual(fs.readFileSync(f.settingsPath), ownerEdit);
    assert.ok(transientFiles(f.dir).some(file => file.endsWith('.txn')), 'journal is retained for manual recovery');
    assert.equal(backupFiles(f.dir).length, 2);
});
