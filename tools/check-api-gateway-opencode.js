'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'routing', 'lib', 'api-gateway-opencode.js');
const DURABLE_PATH = path.join(ROOT, 'routing', 'lib', 'durable-write.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-opencode-'));
const SECRET = 'fixture-secret-never-return';

const MANIFEST = {
    version: 1,
    revision: 7,
    enabled: true,
    models: {
        'vendor/nested/model': {
            displayName: 'Vendor / Nested Model',
            claudeBehavesAs: 'claude-sonnet-5',
            contextTokens: 200000,
            outputTokens: 16000,
            publishedAt: '2026-11-10T00:00:00.000Z',
        },
        'agentrouter/gpt-5.6-sol': {
            displayName: 'AgentRouter / GPT 5.6 Sol',
            claudeBehavesAs: 'claude-opus-5',
            contextTokens: 1050000,
            outputTokens: 32000,
            publishedAt: '2026-11-09T00:00:00.000Z',
        },
    },
};

const EXPECTED_PROVIDER = {
    npm: '@ai-sdk/openai-compatible',
    name: 'ABUSE HUB',
    options: {
        baseURL: 'http://127.0.0.1:20100/openai/v1',
        apiKey: 'dummy',
        timeout: 600000,
    },
    models: {
        'agentrouter/gpt-5.6-sol': {
            name: 'AgentRouter / GPT 5.6 Sol',
            limit: { context: 1050000, output: 32000 },
        },
        'vendor/nested/model': {
            name: 'Vendor / Nested Model',
            limit: { context: 200000, output: 16000 },
        },
    },
};

after(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
});

function load() {
    delete require.cache[require.resolve(LIB_PATH)];
    return require(LIB_PATH);
}

function encodeJson(value, style = {}) {
    const newline = style.newline || '\n';
    const indent = style.indent === undefined ? '  ' : style.indent;
    let text = JSON.stringify(value, null, indent).replace(/\n/g, newline);
    if (style.finalNewline !== false) text += newline;
    if (style.bom) text = '﻿' + text;
    return Buffer.from(text, 'utf8');
}

function baseConfig(extra = {}) {
    return {
        $schema: 'https://opencode.ai/config.json',
        model: 'legacy/current-model-must-not-change',
        small_model: 'legacy/current-small-model-must-not-change',
        agent: { build: { model: 'legacy/agent-model-must-not-change' } },
        mcp: { fixture: { command: ['never-run', SECRET], enabled: true } },
        permission: { bash: 'ask' },
        command: { fixture: { template: SECRET } },
        provider: {
            legacy: {
                name: 'Legacy Provider',
                options: { apiKey: SECRET, baseURL: 'https://fixture.invalid/v1' },
                models: { 'legacy-model': { name: 'Legacy Model' } },
            },
        },
        unknownFutureField: { nested: [1, { keep: true }] },
        ...extra,
    };
}

function makeFixture(name, values) {
    const dir = fs.mkdtempSync(path.join(TMP, `${name}-`));
    const targetDirs = ['user', 'wiki', 'hub'];
    const targets = targetDirs.map((part, index) => {
        const file = path.join(dir, part, 'opencode.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const item = values[index];
        fs.writeFileSync(file, encodeJson(item.value, item.style));
        return { label: item.label, path: file };
    });
    return {
        dir,
        targets,
        journalPath: path.join(dir, 'state', 'opencode-sync.txn'),
    };
}

function serviceFor(fixture, extra = {}) {
    const { createOpenCodeService } = load();
    return createOpenCodeService({
        targets: fixture.targets,
        journalPath: fixture.journalPath,
        durableImpl: require(DURABLE_PATH),
        ...extra,
    });
}

function serialize(value) {
    return JSON.stringify(value);
}

function parseJsonFile(file) {
    let text = fs.readFileSync(file).toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
}

function hash(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function filesRecursively(dir) {
    if (!fs.existsSync(dir)) return [];
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

function backupFiles(fixture) {
    return filesRecursively(fixture.dir).filter(file => path.basename(file).includes('.bak-api-gateway-opencode-'));
}

function transientFiles(fixture) {
    return filesRecursively(fixture.dir).filter(file => {
        const name = path.basename(file);
        return file === fixture.journalPath || file === `${fixture.journalPath}.lock`
            || name.includes('.stage-') || name.includes('.tmp-');
    });
}

function expectCode(fn, code) {
    let caught = null;
    try { fn(); } catch (error) { caught = error; }
    assert.ok(caught, `expected ${code}`);
    assert.equal(caught.code, code);
    assert.equal(caught.message.includes(SECRET), false);
    return caught;
}

function writeFixtureDescriptor(file, fixture) {
    fs.writeFileSync(file, JSON.stringify({
        targets: fixture.targets,
        journalPath: fixture.journalPath,
        manifest: MANIFEST,
    }), 'utf8');
}

function runCrashFixture(fixture, hookStep, exitCode = 71) {
    const descriptorPath = path.join(fixture.dir, 'descriptor.json');
    writeFixtureDescriptor(descriptorPath, fixture);
    const script = `
      const fs = require('node:fs');
      const durable = require(${JSON.stringify(DURABLE_PATH)});
      const { createOpenCodeService } = require(${JSON.stringify(LIB_PATH)});
      const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(descriptorPath)}, 'utf8'));
      const hook = ${JSON.stringify(hookStep)};
      let stageCalls = 0;
      let commitCalls = 0;
      const injected = {
        ...durable,
        stageAtomicSync(...args) {
          const stage = durable.stageAtomicSync(...args);
          stageCalls += 1;
          if (hook === 'afterStage' + stageCalls) process.exit(${exitCode});
          return stage;
        },
        commitAtomicSync(stage) {
          durable.commitAtomicSync(stage);
          commitCalls += 1;
          if (hook === 'afterCommit' + commitCalls) process.exit(${exitCode});
        },
      };
      const service = createOpenCodeService({
        targets: fixture.targets,
        journalPath: fixture.journalPath,
        durableImpl: injected,
      });
      service.sync(fixture.manifest);
    `;
    return spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fixture.dir, USERPROFILE: fixture.dir },
    });
}

test('exports the exact OpenCode service methods and requires three injected targets', () => {
    const moduleApi = load();
    assert.deepEqual(Object.keys(moduleApi), ['createOpenCodeService']);
    const { createOpenCodeService } = moduleApi;
    assert.equal(typeof createOpenCodeService, 'function');
    const f = makeFixture('interface', [
        { label: 'User', value: baseConfig() },
        { label: 'Wiki', value: baseConfig() },
        { label: 'Hub', value: baseConfig() },
    ]);
    const service = createOpenCodeService({
        targets: f.targets,
        journalPath: f.journalPath,
        durableImpl: require(DURABLE_PATH),
    });
    assert.deepEqual(Object.keys(service).sort(), [
        'preview',
        'recover',
        'status',
        'sync',
    ].sort());
    for (const method of ['recover', 'status', 'preview', 'sync']) {
        assert.equal(typeof service[method], 'function', method);
    }
    assert.throws(
        () => createOpenCodeService({ targets: f.targets.slice(0, 2), journalPath: f.journalPath }),
        error => error && error.code === 'api_gateway_opencode_invalid_options',
    );
});

test('preview is redacted and reports only abuse-hub model structural changes', () => {
    const changedProvider = {
        ...EXPECTED_PROVIDER,
        options: { ...EXPECTED_PROVIDER.options, timeout: 1, privateOption: SECRET },
        models: {
            'agentrouter/gpt-5.6-sol': { name: 'Old display name', privateModelValue: SECRET },
            'old/model': { name: 'Remove me', apiKey: SECRET },
        },
    };
    const f = makeFixture('preview', [
        {
            label: 'User config',
            value: baseConfig(),
            style: { bom: true, newline: '\r\n', indent: '    ', finalNewline: false },
        },
        {
            label: 'Wiki config',
            value: baseConfig({ provider: { ...baseConfig().provider, 'abuse-hub': changedProvider } }),
            style: { newline: '\n', indent: '  ', finalNewline: true },
        },
        {
            label: 'Hub config',
            value: baseConfig({ provider: { ...baseConfig().provider, 'abuse-hub': EXPECTED_PROVIDER } }),
            style: { newline: '\n', indent: '  ', finalNewline: true },
        },
    ]);
    const service = serviceFor(f);
    const preview = service.preview(MANIFEST);
    assert.deepEqual(preview, {
        status: 'changes',
        targets: [
            {
                label: 'User config',
                status: 'changes',
                additions: 2,
                removals: 0,
                changes: 0,
            },
            {
                label: 'Wiki config',
                status: 'changes',
                additions: 1,
                removals: 1,
                changes: 1,
            },
            {
                label: 'Hub config',
                status: 'synced',
                additions: 0,
                removals: 0,
                changes: 0,
            },
        ],
    });
    const text = serialize(preview);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(f.dir), false);
    assert.equal(text.includes('legacy'), false);
    assert.equal(text.includes('apiKey'), false);
    assert.equal(text.includes('baseURL'), false);

    assert.deepEqual(service.status(MANIFEST), {
        status: 'changes',
        targets: [
            { label: 'User config', status: 'changes', synced: false },
            { label: 'Wiki config', status: 'changes', synced: false },
            { label: 'Hub config', status: 'synced', synced: true },
        ],
    });
});

test('preview and status report missing or invalid targets without leaking content or paths', () => {
    const f = makeFixture('invalid', [
        { label: 'Good', value: baseConfig() },
        { label: 'Missing', value: baseConfig() },
        { label: 'Invalid', value: baseConfig() },
    ]);
    fs.unlinkSync(f.targets[1].path);
    fs.writeFileSync(f.targets[2].path, Buffer.from(`{"secret":"${SECRET}"`, 'utf8'));
    const service = serviceFor(f);
    const preview = service.preview(MANIFEST);
    assert.equal(preview.status, 'invalid');
    assert.deepEqual(preview.targets[1], {
        label: 'Missing', status: 'changes',
        additions: Object.keys(EXPECTED_PROVIDER.models).length, removals: 0, changes: 0,
    });
    assert.deepEqual(preview.targets[2], {
        label: 'Invalid', status: 'invalid',
        additions: 0, removals: 0, changes: 0,
    });
    const text = serialize(preview);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(f.dir), false);
});

test('native V2 configs are patched in providers, not duplicated into legacy provider', () => {
    const native = extra => ({
        $schema: 'https://opencode.ai/config.json',
        model: 'abuse-hub/agentrouter/gpt-5.6-sol',
        agents: { build: { model: 'abuse-hub/agentrouter/gpt-5.6-sol' } },
        mcp: { servers: { fixture: { type: 'local', command: ['never-run', SECRET] } } },
        providers: {
            legacy: { settings: { apiKey: SECRET }, models: { 'legacy-model': { name: 'Legacy' } } },
            'abuse-hub': {
                package: 'aisdk:@ai-sdk/openai-compatible',
                name: 'ABUSE HUB',
                settings: { baseURL: 'http://127.0.0.1:20100/openai/v1', apiKey: 'dummy', timeout: 600000 },
                models: { 'stale/model': { name: 'Stale', limit: { context: 1, output: 1 } } },
            },
        },
        ...extra,
    });
    const EXPECTED_NATIVE = {
        package: 'aisdk:@ai-sdk/openai-compatible',
        name: 'ABUSE HUB',
        settings: EXPECTED_PROVIDER.options,
        models: EXPECTED_PROVIDER.models,
    };
    const f = makeFixture('native-v2', [
        { label: 'User config', value: native() },
        { label: 'Wiki config', value: native() },
        { label: 'Hub config', value: native() },
    ]);

    assert.equal(serviceFor(f).preview(MANIFEST).status, 'changes');
    const result = serviceFor(f).sync(MANIFEST);
    assert.equal(result.changed, 3);
    for (const target of f.targets) {
        const value = parseJsonFile(target.path);
        assert.equal(value.provider, undefined, 'legacy provider block must not appear');
        assert.deepEqual(value.providers['abuse-hub'], EXPECTED_NATIVE);
        assert.deepEqual(Object.keys(value.providers), ['legacy', 'abuse-hub']);
        assert.equal(JSON.stringify(value).includes(SECRET), true);
        assert.equal(value.model, 'abuse-hub/agentrouter/gpt-5.6-sol');
        assert.deepEqual(value.agents, { build: { model: 'abuse-hub/agentrouter/gpt-5.6-sol' } });
    }
    assert.equal(serviceFor(f).preview(MANIFEST).status, 'synced');
    const beforeHashes = f.targets.map(target => hash(target.path));
    assert.equal(serviceFor(f).sync(MANIFEST).changed, 0);
    assert.deepEqual(f.targets.map(target => hash(target.path)), beforeHashes);
});

test('sync accepts an unchanged native V2 target while creating two missing targets', () => {
    const nativeProvider = {
        package: 'aisdk:@ai-sdk/openai-compatible',
        name: 'ABUSE HUB',
        settings: EXPECTED_PROVIDER.options,
        models: EXPECTED_PROVIDER.models,
    };
    const native = {
        $schema: 'https://opencode.ai/config.json',
        model: 'abuse-hub/agentrouter/gpt-5.6-sol',
        agents: {
            build: { model: 'abuse-hub/agentrouter/gpt-5.6-sol' },
            review: { mode: 'subagent', permission: { edit: 'deny' } },
        },
        mcp: { servers: { context7: { type: 'remote', url: 'https://fixture.invalid/mcp' } } },
        providers: {
            'zai-coding-plan': {
                package: '@ai-sdk/openai-compatible',
                settings: { apiKey: `{file:${SECRET}}` },
                models: { fixture: { name: 'Fixture' } },
            },
            'abuse-hub': nativeProvider,
        },
    };
    const f = makeFixture('native-unchanged-two-missing', [
        { label: 'User config', value: native },
        { label: 'Wiki config', value: {} },
        { label: 'Hub config', value: {} },
    ]);
    fs.unlinkSync(f.targets[1].path);
    fs.unlinkSync(f.targets[2].path);
    const userBefore = fs.readFileSync(f.targets[0].path);

    const result = serviceFor(f).sync(MANIFEST);

    assert.equal(result.changed, 2);
    assert.deepEqual(fs.readFileSync(f.targets[0].path), userBefore);
    assert.deepEqual(parseJsonFile(f.targets[0].path).providers['abuse-hub'], nativeProvider);
    assert.deepEqual(parseJsonFile(f.targets[1].path), { provider: { 'abuse-hub': EXPECTED_PROVIDER } });
    assert.deepEqual(parseJsonFile(f.targets[2].path), { provider: { 'abuse-hub': EXPECTED_PROVIDER } });
    assert.deepEqual(backupFiles(f).filter(file => file.startsWith(f.targets[0].path)), []);
    assert.deepEqual(transientFiles(f), []);
});

test('sync changes only provider.abuse-hub in all three targets and preserves file style', () => {
    const originals = [
        {
            label: 'User config',
            value: baseConfig(),
            style: { bom: true, newline: '\r\n', indent: '    ', finalNewline: false },
        },
        {
            label: 'Wiki config',
            value: baseConfig({ provider: { ...baseConfig().provider, other: { token: SECRET } } }),
            style: { newline: '\n', indent: '  ', finalNewline: true },
        },
        {
            label: 'Hub config',
            value: baseConfig({ provider: { ...baseConfig().provider, 'abuse-hub': {
                ...EXPECTED_PROVIDER,
                models: { 'old/model': { name: 'Old' } },
            } } }),
            style: { newline: '\n', indent: '\t', finalNewline: true },
        },
    ];
    const f = makeFixture('sync-success', originals);
    const beforeBytes = f.targets.map(target => fs.readFileSync(target.path));
    const service = serviceFor(f);
    assert.deepEqual(service.sync(MANIFEST), {
        ok: true,
        status: 'synced',
        changed: 3,
        targets: [
            { label: 'User config', status: 'synced', synced: true },
            { label: 'Wiki config', status: 'synced', synced: true },
            { label: 'Hub config', status: 'synced', synced: true },
        ],
    });

    for (let index = 0; index < f.targets.length; index += 1) {
        const target = f.targets[index];
        const next = parseJsonFile(target.path);
        const expected = structuredClone(originals[index].value);
        expected.provider['abuse-hub'] = EXPECTED_PROVIDER;
        assert.deepEqual(next, expected, `${target.label} changes only provider.abuse-hub`);
        assert.equal(next.model, 'legacy/current-model-must-not-change');
        assert.equal(next.small_model, 'legacy/current-small-model-must-not-change');
        assert.equal(next.agent.build.model, 'legacy/agent-model-must-not-change');
        assert.equal(next.provider.legacy.options.apiKey, SECRET);
        assert.equal(fs.readFileSync(target.path)[0] === 0xef, originals[index].style.bom === true);
        const text = fs.readFileSync(target.path).toString('utf8');
        assert.equal(text.includes('\r\n'), originals[index].style.newline === '\r\n');
        assert.equal(/\r?\n$/.test(text), originals[index].style.finalNewline !== false);
    }

    const backups = backupFiles(f);
    assert.equal(backups.length, 3, `one adjacent backup per target: ${backups}`);
    for (const original of beforeBytes) {
        assert.ok(backups.some(file => fs.readFileSync(file).equals(original)), 'backups are byte exact');
    }
    assert.deepEqual(transientFiles(f), [], 'successful sync leaves no journal, lock, stage, or temp file');
    assert.deepEqual(service.preview(MANIFEST), {
        status: 'synced',
        targets: f.targets.map(target => ({
            label: target.label, status: 'synced',
            additions: 0, removals: 0, changes: 0,
        })),
    });
});

test('second sync is idempotent and does not replace files or backups', () => {
    const f = makeFixture('idempotent', [
        { label: 'User', value: baseConfig() },
        { label: 'Wiki', value: baseConfig() },
        { label: 'Hub', value: baseConfig() },
    ]);
    const service = serviceFor(f);
    assert.equal(service.sync(MANIFEST).changed, 3);
    const beforeHashes = f.targets.map(target => hash(target.path));
    const beforeBackups = backupFiles(f).map(file => [file, hash(file)]).sort();
    assert.deepEqual(service.sync(MANIFEST), {
        ok: true,
        status: 'synced',
        changed: 0,
        targets: f.targets.map(target => ({ label: target.label, status: 'synced', synced: true })),
    });
    assert.deepEqual(f.targets.map(target => hash(target.path)), beforeHashes);
    assert.deepEqual(backupFiles(f).map(file => [file, hash(file)]).sort(), beforeBackups);
    assert.deepEqual(transientFiles(f), []);
});

test('sync creates a missing target that only stores the abuse-hub provider', () => {
    const f = makeFixture('sync-missing', [
        { label: 'User config', value: baseConfig() },
        { label: 'Wiki config', value: baseConfig() },
        { label: 'Hub config', value: baseConfig() },
    ]);
    fs.unlinkSync(f.targets[1].path);
    fs.unlinkSync(f.targets[2].path);

    const preview = serviceFor(f).preview(MANIFEST);
    assert.equal(preview.status, 'changes');
    assert.equal(preview.targets[1].status, 'changes');
    assert.equal(preview.targets[1].additions, EXPECTED_PROVIDER.models
        ? Object.keys(EXPECTED_PROVIDER.models).length : 0);

    const result = serviceFor(f).sync(MANIFEST);
    assert.equal(result.status, 'synced');
    assert.deepEqual(
        f.targets.map(target => ({ label: target.label, status: 'synced', synced: true })),
        result.targets,
    );
    for (const index of [1, 2]) {
        assert.deepEqual(parseJsonFile(f.targets[index].path), { provider: { 'abuse-hub': EXPECTED_PROVIDER } });
        assert.deepEqual(backupFiles(f).filter(file => file.startsWith(f.targets[index].path)), []);
    }
    assert.equal(serviceFor(f).preview(MANIFEST).status, 'synced');
    assert.deepEqual(transientFiles(f), []);
});

test('created target is removed on rollback when a later commit fails', () => {
    const f = makeFixture('rollback-created', [
        { label: 'User', value: baseConfig() },
        { label: 'Wiki', value: baseConfig() },
        { label: 'Hub', value: baseConfig() },
    ]);
    fs.unlinkSync(f.targets[1].path);
    const before = [fs.readFileSync(f.targets[0].path), null, fs.readFileSync(f.targets[2].path)];
    const durable = require(DURABLE_PATH);
    let calls = 0;
    const injected = {
        ...durable,
        commitAtomicSync(stage) {
            calls += 1;
            if (calls === 2) throw Object.assign(new Error('fixture commit failure'), { code: 'EIO' });
            return durable.commitAtomicSync(stage);
        },
    };
    expectCode(() => serviceFor(f, { durableImpl: injected }).sync(MANIFEST),
        'api_gateway_opencode_transaction_failed');
    assert.deepEqual(fs.readFileSync(f.targets[0].path), before[0]);
    assert.equal(fs.existsSync(f.targets[1].path), false);
    assert.deepEqual(fs.readFileSync(f.targets[2].path), before[2]);
    assert.deepEqual(transientFiles(f), []);
});

test('sync refuses an invalid target before changing any target', () => {
    const f = makeFixture('sync-invalid', [
        { label: 'Good', value: baseConfig() },
        { label: 'Missing', value: baseConfig() },
        { label: 'Invalid', value: baseConfig() },
    ]);
    const goodBefore = fs.readFileSync(f.targets[0].path);
    fs.unlinkSync(f.targets[1].path);
    fs.writeFileSync(f.targets[2].path, Buffer.from(`{"secret":"${SECRET}"`, 'utf8'));
    assert.throws(
        () => serviceFor(f).sync(MANIFEST),
        error => error && error.code === 'api_gateway_opencode_target_invalid'
            && !error.message.includes(SECRET) && !error.message.includes(f.dir),
    );
    assert.deepEqual(fs.readFileSync(f.targets[0].path), goodBefore);
    assert.deepEqual(backupFiles(f), []);
    assert.deepEqual(transientFiles(f), []);
});

test('partial stage failure leaves all three targets byte exact and clears transient files', () => {
    const f = makeFixture('stage-failure', [
        { label: 'User', value: baseConfig() },
        { label: 'Wiki', value: baseConfig() },
        { label: 'Hub', value: baseConfig() },
    ]);
    const before = f.targets.map(target => fs.readFileSync(target.path));
    const durable = require(DURABLE_PATH);
    let calls = 0;
    const injected = {
        ...durable,
        stageAtomicSync(...args) {
            calls += 1;
            if (calls === 3) throw Object.assign(new Error('fixture stage failure'), { code: 'EIO' });
            return durable.stageAtomicSync(...args);
        },
    };
    const error = expectCode(() => serviceFor(f, { durableImpl: injected }).sync(MANIFEST),
        'api_gateway_opencode_transaction_failed');
    assert.equal(error.rolledBack, true);
    assert.deepEqual(f.targets.map(target => fs.readFileSync(target.path)), before);
    assert.deepEqual(transientFiles(f), []);
});

test('commit failure after one replacement rolls all three targets back byte exact', () => {
    const f = makeFixture('commit-failure', [
        { label: 'User', value: baseConfig() },
        { label: 'Wiki', value: baseConfig() },
        { label: 'Hub', value: baseConfig() },
    ]);
    const before = f.targets.map(target => fs.readFileSync(target.path));
    const durable = require(DURABLE_PATH);
    let calls = 0;
    const injected = {
        ...durable,
        commitAtomicSync(stage) {
            calls += 1;
            if (calls === 2) throw Object.assign(new Error('fixture commit failure'), { code: 'EACCES' });
            return durable.commitAtomicSync(stage);
        },
    };
    const error = expectCode(() => serviceFor(f, { durableImpl: injected }).sync(MANIFEST),
        'api_gateway_opencode_transaction_failed');
    assert.equal(error.rolledBack, true);
    assert.deepEqual(f.targets.map(target => fs.readFileSync(target.path)), before);
    assert.deepEqual(transientFiles(f), []);
    assert.equal(backupFiles(f).length, 3);
});

test('source conflict before commit preserves owner edit and changes no other target', () => {
    const f = makeFixture('source-conflict', [
        { label: 'User', value: baseConfig() },
        { label: 'Wiki', value: baseConfig() },
        { label: 'Hub', value: baseConfig() },
    ]);
    const before = f.targets.map(target => fs.readFileSync(target.path));
    const ownerEdit = encodeJson({ ...baseConfig(), ownerEdit: SECRET }, {
        newline: '\n', indent: '  ', finalNewline: true,
    });
    const service = serviceFor(f, {
        onStep(step) {
            if (step === 'beforeCommit') fs.writeFileSync(f.targets[1].path, ownerEdit);
        },
    });
    const error = expectCode(() => service.sync(MANIFEST), 'api_gateway_opencode_source_conflict');
    assert.equal(error.rolledBack, true);
    assert.deepEqual(fs.readFileSync(f.targets[0].path), before[0]);
    assert.deepEqual(fs.readFileSync(f.targets[1].path), ownerEdit);
    assert.deepEqual(fs.readFileSync(f.targets[2].path), before[2]);
    assert.deepEqual(transientFiles(f), []);
});

test('restart recovery rolls back crashes after commit one and commit two', () => {
    for (const [hook, exitCode] of [['afterCommit1', 72], ['afterCommit2', 73]]) {
        const f = makeFixture(`crash-${hook}`, [
            { label: 'User', value: baseConfig() },
            { label: 'Wiki', value: baseConfig() },
            { label: 'Hub', value: baseConfig() },
        ]);
        const before = f.targets.map(target => fs.readFileSync(target.path));
        const child = runCrashFixture(f, hook, exitCode);
        assert.equal(child.status, exitCode, child.stderr);
        assert.equal(fs.existsSync(f.journalPath), true);
        assert.notDeepEqual(f.targets.map(target => fs.readFileSync(target.path)), before,
            `${hook} leaves a partial transaction before recovery`);
        const recovered = serviceFor(f).recover();
        assert.deepEqual(recovered, { recovered: 'rolled_back' });
        assert.deepEqual(f.targets.map(target => fs.readFileSync(target.path)), before);
        assert.deepEqual(transientFiles(f), []);
    }
});

test('restart recovery accepts a crash after all three commits', () => {
    const f = makeFixture('crash-after-all', [
        { label: 'User', value: baseConfig() },
        { label: 'Wiki', value: baseConfig() },
        { label: 'Hub', value: baseConfig() },
    ]);
    const child = runCrashFixture(f, 'afterCommit3', 74);
    assert.equal(child.status, 74, child.stderr);
    assert.equal(fs.existsSync(f.journalPath), true);
    assert.deepEqual(serviceFor(f).recover(), { recovered: 'committed' });
    for (const target of f.targets) {
        assert.deepEqual(parseJsonFile(target.path).provider['abuse-hub'], EXPECTED_PROVIDER);
    }
    assert.deepEqual(transientFiles(f), []);
});

test('recovery fails closed on an external edit and retains the content-free journal', () => {
    const f = makeFixture('recovery-conflict', [
        { label: 'User', value: baseConfig() },
        { label: 'Wiki', value: baseConfig() },
        { label: 'Hub', value: baseConfig() },
    ]);
    const child = runCrashFixture(f, 'afterCommit1', 75);
    assert.equal(child.status, 75, child.stderr);
    const ownerEdit = encodeJson({ ...baseConfig(), afterCrashOwnerEdit: SECRET });
    fs.writeFileSync(f.targets[2].path, ownerEdit);
    expectCode(() => serviceFor(f).recover(), 'api_gateway_opencode_recovery_conflict');
    assert.deepEqual(fs.readFileSync(f.targets[2].path), ownerEdit);
    assert.equal(fs.existsSync(f.journalPath), true);
    const journalText = fs.readFileSync(f.journalPath, 'utf8');
    assert.equal(journalText.includes(SECRET), false);
    assert.equal(journalText.includes(f.dir), false);
    assert.equal(journalText.includes('Legacy Provider'), false);
    assert.equal(journalText.includes('current-model'), false);
});

test('disabled manifest projects an exact empty provider without changing manifest input', () => {
    const f = makeFixture('disabled', [
        { label: 'User', value: baseConfig({ provider: { ...baseConfig().provider, 'abuse-hub': EXPECTED_PROVIDER } }) },
        { label: 'Wiki', value: baseConfig({ provider: { ...baseConfig().provider, 'abuse-hub': EXPECTED_PROVIDER } }) },
        { label: 'Hub', value: baseConfig({ provider: { ...baseConfig().provider, 'abuse-hub': EXPECTED_PROVIDER } }) },
    ]);
    const disabled = structuredClone(MANIFEST);
    disabled.enabled = false;
    const beforeManifest = structuredClone(disabled);
    const preview = serviceFor(f).preview(disabled);
    assert.deepEqual(disabled, beforeManifest);
    assert.ok(preview.targets.every(row => row.additions === 0 && row.removals === 2 && row.changes === 0));
    serviceFor(f).sync(disabled);
    for (const target of f.targets) {
        const value = parseJsonFile(target.path);
        assert.deepEqual(value.provider['abuse-hub'], { ...EXPECTED_PROVIDER, models: {} });
        assert.equal(value.model, 'legacy/current-model-must-not-change');
    }
});

test('crash after one durable stage recovers without replacing any target', () => {
    const f = makeFixture('crash-stage-one', [
        { label: 'User', value: baseConfig() },
        { label: 'Wiki', value: baseConfig() },
        { label: 'Hub', value: baseConfig() },
    ]);
    const before = f.targets.map(target => fs.readFileSync(target.path));
    const child = runCrashFixture(f, 'afterStage1', 76);
    assert.equal(child.status, 76, child.stderr);
    assert.deepEqual(f.targets.map(target => fs.readFileSync(target.path)), before);
    assert.equal(fs.existsSync(f.journalPath), true);
    assert.deepEqual(serviceFor(f).recover(), { recovered: 'rolled_back' });
    assert.deepEqual(f.targets.map(target => fs.readFileSync(target.path)), before);
    assert.deepEqual(transientFiles(f), []);
});

test('live transaction lock fails closed without reading or changing targets', () => {
    const f = makeFixture('live-lock', [
        { label: 'User', value: baseConfig() },
        { label: 'Wiki', value: baseConfig() },
        { label: 'Hub', value: baseConfig() },
    ]);
    const before = f.targets.map(target => fs.readFileSync(target.path));
    fs.mkdirSync(path.dirname(f.journalPath), { recursive: true });
    fs.writeFileSync(`${f.journalPath}.lock`, String(process.pid), 'utf8');
    expectCode(() => serviceFor(f).preview(MANIFEST), 'api_gateway_opencode_busy');
    assert.deepEqual(f.targets.map(target => fs.readFileSync(target.path)), before);
    fs.unlinkSync(`${f.journalPath}.lock`);
});

test('malformed recovery journal is retained and never exposes its content', () => {
    const f = makeFixture('bad-journal', [
        { label: 'User', value: baseConfig() },
        { label: 'Wiki', value: baseConfig() },
        { label: 'Hub', value: baseConfig() },
    ]);
    const before = f.targets.map(target => fs.readFileSync(target.path));
    fs.mkdirSync(path.dirname(f.journalPath), { recursive: true });
    fs.writeFileSync(f.journalPath, JSON.stringify({ version: 1, secret: SECRET }), 'utf8');
    const error = expectCode(() => serviceFor(f).recover(), 'api_gateway_opencode_recovery_conflict');
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(fs.existsSync(f.journalPath), true);
    assert.deepEqual(f.targets.map(target => fs.readFileSync(target.path)), before);
});
