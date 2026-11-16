#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const LOCAL_HOP_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-integration-local-hop-'));
const LOCAL_HOP_SECRET = path.join(LOCAL_HOP_TMP, 'abuse-hub-local-hop.key');
process.env.ABUSE_HUB_LOCAL_HOP_KEY_FILE = LOCAL_HOP_SECRET;
after(() => fs.rmSync(LOCAL_HOP_TMP, { recursive: true, force: true }));

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'routing', 'lib', 'api-gateway-integration.js');
const PROXY = path.join(ROOT, 'routing', 'transparent-proxy.js');

function load() {
    delete require.cache[require.resolve(LIB)];
    return require(LIB);
}

function request(overrides = {}) {
    return {
        method: 'GET',
        url: '/__switch/api/api-gateway',
        headers: { host: '127.0.0.1:43210' },
        socket: { remoteAddress: '127.0.0.1', encrypted: false },
        ...overrides,
    };
}

function response() {
    return {
        writableEnded: false,
        headersSent: false,
        statusCode: null,
        headers: null,
        text: '',
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
        end(body = '') { this.text += body; this.writableEnded = true; },
    };
}

function emitJsonBody(req, value, contentType = 'application/json') {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    req.headers = { ...req.headers, 'content-type': contentType, 'content-length': String(bytes.length) };
    queueMicrotask(() => {
        req.onData?.(bytes);
        req.onEnd?.();
    });
    req.on = (event, fn) => {
        if (event === 'data') req.onData = fn;
        if (event === 'end') req.onEnd = fn;
        return req;
    };
    req.unpipe = () => {};
    req.pause = () => {};
    return req;
}

async function settle() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

test('integration module exposes exact production helpers', () => {
    assert.ok(fs.existsSync(LIB), 'routing/lib/api-gateway-integration.js must exist');
    assert.deepEqual(Object.keys(load()).sort(), [
        'createApiGatewayRoutes',
        'createProductionApiGateway',
        'defaultHermesInstallationProbes',
        'defaultOpenCodeTargets',
        'resolveRouteCandidates',
    ].sort());
});

test('exact routes dispatch before generic handlers and expose canonical state DTO', async () => {
    const service = {
        state: async () => ({ ok: true, public: {}, manifest: { version: 1, revision: 1, enabled: true }, models: [], sidecar: {}, clients: {} }),
        candidates: async () => ({ ok: true, models: [], candidatesLoaded: true }),
        updateModel: async value => ({ ok: true, revision: 2, value }),
        sidecarStatus: async () => ({ status: 'ready' }),
        clientsStatus: async () => ({ claude: { status: 'ready' } }),
        openCodePreview: async () => ({ status: 'changes', targets: [] }),
        openCodeSync: async () => ({ ok: true, status: 'synced' }),
        hermesSync: async () => ({ ok: true, status: 'absent' }),
    };
    const routes = load().createApiGatewayRoutes({ service, canWrite: () => true });
    const cases = [
        ['GET', '/__switch/api/api-gateway', 'state'],
        ['GET', '/__switch/api/api-gateway/candidates', 'candidates'],
        ['GET', '/__switch/api/api-gateway/sidecar', 'sidecar'],
        ['GET', '/__switch/api/api-gateway/clients', 'clients'],
        ['GET', '/__switch/api/api-gateway/opencode/preview', 'preview'],
    ];
    for (const [method, url, label] of cases) {
        const res = response();
        assert.equal(routes.handle(request({ method, url }), res), true, label);
        await settle();
        assert.equal(res.statusCode, 200, label);
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(JSON.parse(res.text).ok ?? true, true, label);
    }
    const miss = response();
    assert.equal(routes.handle(request({ url: '/__switch/api/api-gateway-extra' }), miss), false);
    assert.equal(miss.writableEnded, false);
    const unlistedRestart = response();
    assert.equal(routes.handle(request({ method: 'POST', url: '/__switch/api/api-gateway/sidecar/restart' }), unlistedRestart), false,
        'only the canonical API Gateway routes may own the prefix');
    assert.equal(unlistedRestart.writableEnded, false);
});

test('state advertises write capability from the same mutation guard', async () => {
    const service = {
        state: async () => ({ ok: true, public: {}, manifest: { version: 1, revision: 1, enabled: true }, models: [], sidecar: {}, clients: {} }),
    };
    const routes = load().createApiGatewayRoutes({ service });
    const local = response();
    routes.handle(request(), local);
    await settle();
    assert.equal(JSON.parse(local.text).canWrite, true);

    const foreign = response();
    routes.handle(request({ socket: { remoteAddress: '192.0.2.1', encrypted: false } }), foreign);
    await settle();
    assert.equal(JSON.parse(foreign.text).canWrite, false);
});

test('mutation guard accepts IPv4, IPv4-mapped, and IPv6 loopback', async () => {
    let calls = 0;
    const routes = load().createApiGatewayRoutes({
        service: {
            updateModel: async () => { calls += 1; return { ok: true }; },
        },
    });
    for (const [remoteAddress, host, origin] of [
        ['127.19.20.21', '127.19.20.21:43210', 'http://127.19.20.21:43210'],
        ['::ffff:127.0.0.1', '127.0.0.1:43210', 'http://127.0.0.1:43210'],
        ['::1', '[::1]:43210', 'http://[::1]:43210'],
    ]) {
        const res = response();
        const req = emitJsonBody(request({
            method: 'POST',
            url: '/__switch/api/api-gateway/model',
            socket: { remoteAddress, encrypted: false },
            headers: { host, origin, 'sec-fetch-site': 'same-origin' },
        }), { expectedRevision: 1 });
        routes.handle(req, res);
        await settle();
        assert.equal(res.statusCode, 200, remoteAddress);
    }
    assert.equal(calls, 3);
});

test('all mutation routes require loopback same-origin JSON and enforce 64 KiB before service call', async () => {
    let calls = 0;
    const service = {
        updateModel: async body => { calls += 1; return { ok: true, body }; },
        openCodeSync: async () => { calls += 1; return { ok: true }; },
        hermesSync: async () => { calls += 1; return { ok: true }; },
    };
    const routes = load().createApiGatewayRoutes({ service });
    for (const url of [
        '/__switch/api/api-gateway/model',
        '/__switch/api/api-gateway/opencode/sync',
        '/__switch/api/api-gateway/hermes/sync',
    ]) {
        const foreign = response();
        const foreignReq = emitJsonBody(request({ method: 'POST', url, socket: { remoteAddress: '192.0.2.1', encrypted: false } }), {});
        assert.equal(routes.handle(foreignReq, foreign), true);
        await settle();
        assert.equal(foreign.statusCode, 403);

        const cross = response();
        const crossReq = emitJsonBody(request({ method: 'POST', url, headers: { host: '127.0.0.1:43210', origin: 'http://evil.test' } }), {});
        routes.handle(crossReq, cross);
        await settle();
        assert.equal(cross.statusCode, 403);

        const plain = response();
        const plainReq = emitJsonBody(request({ method: 'POST', url }), {}, 'text/plain');
        routes.handle(plainReq, plain);
        await settle();
        assert.equal(plain.statusCode, 415);

        const huge = response();
        const hugeReq = emitJsonBody(request({ method: 'POST', url }), Buffer.alloc(65537, 0x20));
        routes.handle(hugeReq, huge);
        await settle();
        assert.equal(huge.statusCode, 413);
    }
    assert.equal(calls, 0);

    const good = response();
    const body = { expectedRevision: 1, id: 'p/m', published: false, displayName: 'P / M', claudeBehavesAs: 'claude-opus-5', contextTokens: 1, outputTokens: 1 };
    const goodReq = emitJsonBody(request({ method: 'POST', url: '/__switch/api/api-gateway/model', headers: { host: '127.0.0.1:43210', origin: 'http://127.0.0.1:43210', 'sec-fetch-site': 'same-origin' } }), body);
    routes.handle(goodReq, good);
    await settle();
    assert.equal(good.statusCode, 200);
    assert.equal(calls, 1);
});

test('route errors are redacted and preserve public HTTP status', async () => {
    const secret = 'sk-private-never-return';
    const service = {
        state: async () => {
            const error = new Error(`failure ${secret} C:\\Users\\Private\\config.json`);
            error.code = 'api_gateway_unavailable';
            error.status = 503;
            throw error;
        },
    };
    const routes = load().createApiGatewayRoutes({ service });
    const res = response();
    routes.handle(request(), res);
    await settle();
    assert.equal(res.statusCode, 503);
    assert.equal(res.text.includes(secret), false);
    assert.equal(res.text.includes('Private'), false);
    assert.deepEqual(JSON.parse(res.text), { ok: false, code: 'api_gateway_unavailable', error: 'API Gateway request failed.' });
});

test('OpenCode targets are platform and XDG aware with labels and no owner hardcode', () => {
    const { defaultOpenCodeTargets } = load();
    const win = defaultOpenCodeTargets({
        platform: 'win32',
        home: 'C:\\Temp\\Profile',
        xdgConfigHome: 'C:\\Temp\\Xdg',
        wikiRoot: 'D:\\Temp\\Wiki',
        repoRoot: 'C:\\Temp\\Hub',
    });
    assert.deepEqual(win, [
        { label: 'User config', path: path.win32.join('C:\\Temp\\Xdg', 'opencode', 'opencode.json') },
        { label: 'Wiki config', path: path.win32.join('D:\\Temp\\Wiki', 'opencode.json') },
        { label: 'Hub config', path: path.win32.join('C:\\Temp\\Hub', 'opencode.json') },
    ]);
    const mac = defaultOpenCodeTargets({
        platform: 'darwin',
        home: '/Users/fixture',
        xdgConfigHome: '',
        wikiRoot: '/Volumes/wiki',
        repoRoot: '/Users/fixture/hub',
    });
    assert.deepEqual(mac, [
        { label: 'User config', path: '/Users/fixture/.config/opencode/opencode.json' },
        { label: 'Wiki config', path: '/Volumes/wiki/opencode.json' },
        { label: 'Hub config', path: '/Users/fixture/hub/opencode.json' },
    ]);
    assert.equal(JSON.stringify({ win, mac }).includes('WormAlien'), false);
});

test('Hermes probes and instructions are platform-specific without creating roots', () => {
    const { defaultHermesInstallationProbes } = load();
    const win = defaultHermesInstallationProbes({ platform: 'win32', home: 'C:\\Temp\\Profile', localAppData: 'C:\\Temp\\Local', pathEnv: '' });
    assert.equal(win.installCommand, 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)');
    assert.equal(win.startCommand, 'hermes dashboard --no-open');
    assert.ok(win.probes.every(path.win32.isAbsolute));
    const mac = defaultHermesInstallationProbes({ platform: 'darwin', home: '/Users/fixture', pathEnv: '' });
    assert.equal(mac.installCommand, 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash');
    assert.equal(mac.startCommand, 'hermes dashboard --no-open');
    assert.ok(mac.probes.every(path.posix.isAbsolute));
    assert.ok(mac.probes.some(value => value.endsWith('/.local/bin/hermes')));
    assert.equal(JSON.stringify({ win, mac }).includes('WormAlien'), false);
});

test('Routes and Gateway consume the same candidate resolver with first-source semantics', async () => {
    const providers = new Set(['beta', 'alpha']);
    const calls = [];
    const candidateOptions = {
        providers,
        getLiveModels: async provider => { calls.push(`live:${provider}`); return provider === 'alpha' ? ['a/model'] : []; },
        getAccountModels: async provider => { calls.push(`accounts:${provider}`); return provider === 'beta' ? ['b/model'] : []; },
        getPricingModels: async provider => { calls.push(`pricing:${provider}`); return ['wrong']; },
        getSnapshotModels: async () => ['wrong'],
        getConfiguredModels: async () => ['wrong'],
    };
    const rows = await load().resolveRouteCandidates(candidateOptions);
    assert.deepEqual(rows.map(row => [row.id, row.catalogSource]), [
        ['alpha/a/model', 'live'],
        ['beta/b/model', 'accounts'],
    ]);
    assert.deepEqual(calls, ['live:alpha', 'live:beta', 'accounts:beta']);
});

test('production candidate options are shared with Routes and Gateway', async () => {
    const manifest = { version: 1, revision: 1, enabled: true, models: {} };
    const calls = [];
    let dashboardOptions;
    const candidateOptions = {
        providers: ['alpha'],
        getLiveModels: async () => [],
        getAccountModels: async () => [],
        getPricingModels: async () => [],
        getSnapshotModels: async () => [],
        getConfiguredModels: async () => [],
    };
    const product = load().createProductionApiGateway({
        repoRoot: ROOT,
        home: path.join(ROOT, '.fixture-home-shared-resolver'),
        wikiRoot: path.join(ROOT, '.fixture-wiki-shared-resolver'),
        manifestApi: {
            readPublishedManifest: async () => manifest,
            saveManifestAndPicker: async () => ({ ok: true }),
        },
        resolveModelCandidates: async options => { calls.push(options); return []; },
        dashboardFactory: options => {
            dashboardOptions = options;
            return {
                state: async () => ({ ok: true }),
                updateModel: async () => ({ ok: true }),
                sidecarStatus: async () => ({}),
                clientsStatus: async () => ({}),
                openCodePreview: async () => ({}),
                openCodeSync: async () => ({}),
                hermesSync: async () => ({}),
            };
        },
        openCodeFactory: () => ({ recover: () => ({ recovered: 'none' }), status: () => ({}), preview: () => ({}), sync: () => ({}) }),
        hermesFactory: () => ({ status: () => ({}), sync: () => ({}) }),
        opencodeTargets: [
            { label: 'A', path: path.join(ROOT, '.fixture-shared-a') },
            { label: 'B', path: path.join(ROOT, '.fixture-shared-b') },
            { label: 'C', path: path.join(ROOT, '.fixture-shared-c') },
        ],
        opencodeJournalPath: path.join(ROOT, '.fixture-shared-journal'),
        candidateOptions,
    });
    assert.strictEqual(dashboardOptions.candidateOptions, candidateOptions);
    await dashboardOptions.resolveModelCandidates(dashboardOptions.candidateOptions);
    await product.resolveRouteCandidates(['beta']);
    assert.strictEqual(calls[0], candidateOptions);
    assert.deepEqual(calls[1], { ...candidateOptions, providers: ['beta'] });
});

test('production factory recovers OpenCode at startup and Hermes picks first sorted published model', async () => {
    const events = [];
    const manifest = { version: 1, revision: 1, enabled: true, models: { 'z/model': {}, 'a/model': {} } };
    let hermesGetModel;
    const product = load().createProductionApiGateway({
        repoRoot: ROOT,
        home: path.join(ROOT, '.fixture-home-never-read'),
        wikiRoot: path.join(ROOT, '.fixture-wiki-never-read'),
        manifestApi: {
            readPublishedManifest: async () => manifest,
            saveManifestAndPicker: async () => ({ ok: true }),
        },
        resolveModelCandidates: async () => [],
        openCodeFactory: options => ({
            options,
            recover: () => { events.push('recover'); return { recovered: 'none' }; },
            status: () => ({ status: 'synced' }),
            preview: () => ({}),
            sync: () => ({}),
        }),
        hermesFactory: options => {
            hermesGetModel = options.getModel;
            return { status: () => ({ status: 'absent' }), sync: () => ({ status: 'absent' }) };
        },
        sidecarStatus: async () => ({ status: 'ready' }),
        readPassive: async () => ({}),
        readProbes: async () => ({}),
        candidateOptions: { providers: [] },
        opencodeTargets: [
            { label: 'A', path: path.join(ROOT, '.fixture-a') },
            { label: 'B', path: path.join(ROOT, '.fixture-b') },
            { label: 'C', path: path.join(ROOT, '.fixture-c') },
        ],
        opencodeJournalPath: path.join(ROOT, '.fixture-journal'),
        hermesOptions: { installationProbes: [] },
    });
    assert.deepEqual(events, ['recover']);
    assert.equal(await hermesGetModel(), 'a/model');
    assert.equal(typeof product.routes.handle, 'function');
    assert.equal(typeof product.service.state, 'function');
});

test('integrated Hermes path is neutral when absent and uses only an injected dynamic dashboard stub when installed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-hermes-integration-'));
    const marker = path.join(root, 'bin', 'hermes');
    const manifest = {
        version: 1,
        revision: 1,
        enabled: true,
        models: { 'z/model': {}, 'a/model': {} },
    };
    let endpoint = null;
    const calls = [];
    const stub = http.createServer(async (req, res) => {
        calls.push({ method: req.method, url: req.url });
        if (req.method === 'GET' && req.url === '/api/status') {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ version: '0.23.1' }));
        }
        if (req.method === 'GET' && req.url === '/api/providers/custom-endpoints') {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ endpoints: endpoint ? [endpoint] : [] }));
        }
        if (req.method === 'POST' && req.url === '/api/providers/custom-endpoints') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            endpoint = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }
        res.writeHead(404); res.end();
    });
    await new Promise((resolve, reject) => {
        stub.once('error', reject);
        stub.listen(0, '127.0.0.1', resolve);
    });
    const port = stub.address().port;
    const common = {
        repoRoot: ROOT,
        home: path.join(root, 'home'),
        wikiRoot: path.join(root, 'wiki'),
        manifestApi: {
            readPublishedManifest: async () => manifest,
            saveManifestAndPicker: async () => ({ ok: true }),
        },
        openCodeFactory: () => ({ recover: () => ({ recovered: 'none' }), status: () => ({}), preview: () => ({}), sync: () => ({}) }),
        opencodeTargets: [
            { label: 'A', path: path.join(root, 'a.json') },
            { label: 'B', path: path.join(root, 'b.json') },
            { label: 'C', path: path.join(root, 'c.json') },
        ],
        opencodeJournalPath: path.join(root, 'opencode.txn'),
        candidateOptions: { providers: [] },
    };
    try {
        const absent = load().createProductionApiGateway({
            ...common,
            hermesOptions: {
                installationProbes: [marker],
                dashboardBaseUrl: `http://127.0.0.1:${port}`,
            },
        });
        assert.equal((await absent.service.clientsStatus()).hermes.status, 'absent');
        assert.equal((await absent.service.hermesSync()).status, 'absent');
        assert.deepEqual(calls, [], 'absent Hermes must not call dashboard');
        assert.equal(fs.existsSync(path.join(root, 'hermes-root')), false);

        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, 'fixture', 'utf8');
        const installed = load().createProductionApiGateway({
            ...common,
            hermesOptions: {
                installationProbes: [marker],
                dashboardBaseUrl: `http://127.0.0.1:${port}`,
            },
        });
        const result = await installed.service.hermesSync();
        assert.equal(result.status, 'running');
        assert.equal(result.synced, true);
        assert.deepEqual(endpoint, {
            id: 'abuse-hub',
            name: 'ABUSE HUB',
            base_url: 'http://127.0.0.1:20100/openai/v1',
            model: 'a/model',
            api_mode: 'chat_completions',
            discover_models: true,
            make_default: false,
        });
        assert.ok(calls.every(call => call.url === '/api/status' || call.url === '/api/providers/custom-endpoints'));
    } finally {
        await new Promise(resolve => stub.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('check-hub mechanics use dynamic IPv4 loopback ports and exact owned PID teardown', () => {
    const source = fs.readFileSync(path.join(ROOT, 'tools', 'check-hub.js'), 'utf8');
    assert.match(source, /const freeLoopbackPort = \(\) =>/);
    assert.doesNotMatch(source, /\b28299\b|\b28297\b/);
    const mechanicsStart = source.indexOf('async function mechanics()');
    const denialStart = source.indexOf('async function denialIsInstant()', mechanicsStart);
    const spawnStart = source.indexOf('async function windowsSpawnProps()', denialStart);
    const tuiStart = source.indexOf('async function tui()', spawnStart);
    assert.ok(mechanicsStart > 0 && denialStart > mechanicsStart && spawnStart > denialStart && tuiStart > spawnStart);
    const mechanics = source.slice(mechanicsStart, denialStart);
    const denial = source.slice(denialStart, spawnStart);
    const spawn = source.slice(spawnStart, tuiStart);
    assert.doesNotMatch(mechanics, /L\.killPort\(/);
    assert.match(mechanics, /L\.stopLaunched\(listenerPid\)/);
    assert.doesNotMatch(denial, /PID 4|L\.killPort\(/);
    assert.match(denial, /L\.stopServices\(/);
    assert.doesNotMatch(spawn, /L\.killPort\(/);
    assert.match(spawn, /L\.stopLaunched\(listenerPid\)/);
});

test('Windows production defaults keep the approved wiki target without an owner-name hardcode', () => {
    const targets = load().defaultOpenCodeTargets({
        platform: 'win32',
        home: 'C:\\Temp\\Profile',
        repoRoot: 'C:\\Temp\\Hub',
        xdgConfigHome: '',
    });
    assert.deepEqual(targets, [
        { label: 'User config', path: 'C:\\Temp\\Profile\\.config\\opencode\\opencode.json' },
        { label: 'Wiki config', path: 'D:\\WORMALIENAIGIGANT\\opencode.json' },
        { label: 'Hub config', path: 'C:\\Temp\\Hub\\opencode.json' },
    ]);
    assert.equal(JSON.stringify(targets).includes('WormAlien'), false);
});

test('Hermes probes include PATH executable lookup candidates on Windows and macOS', () => {
    const { defaultHermesInstallationProbes } = load();
    const win = defaultHermesInstallationProbes({
        platform: 'win32',
        home: 'C:\\Temp\\Profile',
        localAppData: 'C:\\Temp\\Local',
        pathEnv: 'C:\\Tools;D:\\Bin',
    });
    assert.ok(win.probes.includes('C:\\Tools\\hermes.exe'));
    assert.ok(win.probes.includes('C:\\Tools\\hermes.cmd'));
    assert.ok(win.probes.includes('D:\\Bin\\hermes.exe'));
    const mac = defaultHermesInstallationProbes({
        platform: 'darwin',
        home: '/Users/fixture',
        pathEnv: '/opt/homebrew/bin:/usr/local/bin:/usr/bin',
    });
    assert.ok(mac.probes.includes('/opt/homebrew/bin/hermes'));
    assert.ok(mac.probes.includes('/usr/local/bin/hermes'));
});

test('production Hermes absent DTO uses the platform-specific install command', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-hermes-platform-'));
    const manifest = { version: 1, revision: 1, enabled: true, models: {} };
    try {
        const product = load().createProductionApiGateway({
            repoRoot: root,
            home: path.join(root, 'home'),
            wikiRoot: path.join(root, 'wiki'),
            platform: 'darwin',
            manifestApi: {
                readPublishedManifest: async () => manifest,
                saveManifestAndPicker: async () => ({ ok: true }),
            },
            openCodeFactory: () => ({ recover: () => ({ recovered: 'none' }), status: () => ({}), preview: () => ({}), sync: () => ({}) }),
            opencodeTargets: [
                { label: 'A', path: path.join(root, 'a.json') },
                { label: 'B', path: path.join(root, 'b.json') },
                { label: 'C', path: path.join(root, 'c.json') },
            ],
            opencodeJournalPath: path.join(root, 'opencode.txn'),
            candidateOptions: { providers: [] },
            hermesOptions: { installationProbes: [path.join(root, 'missing-hermes')] },
        });
        const dto = (await product.service.clientsStatus()).hermes;
        assert.equal(dto.status, 'absent');
        assert.equal(dto.installCommand, 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash');
        assert.equal(dto.startCommand, 'hermes dashboard --no-open');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Bifrost keeps exact Darwin x64 and arm64 pins and builds structural descriptors', () => {
    const sidecar = require(path.join(ROOT, 'routing', 'lib', 'bifrost-sidecar.js'));
    const lock = sidecar.readLock(path.join(ROOT, 'routing', 'bifrost-lock.json'));
    const expected = {
        x64: '6dcefc70045fc866a3532b0e0f42464cc22be47e832058d0527586c6fddd69e6',
        arm64: 'cf79d49801475af6a8f90111b9124c60e4395bf0b57fb01fe5fb64ab994919fd',
    };
    for (const [arch, sha256] of Object.entries(expected)) {
        const artifact = sidecar.selectArtifact(lock, 'darwin', arch);
        assert.equal(artifact.sha256, sha256);
        assert.equal(artifact.filename, 'bifrost-http');
        assert.match(artifact.url, new RegExp(`/darwin/${arch === 'x64' ? 'amd64' : 'arm64'}/bifrost-http$`));
        const descriptor = sidecar.defaultServiceDescriptor({
            lockPath: path.join(ROOT, 'routing', 'bifrost-lock.json'),
            cacheRoot: path.join(ROOT, '.fixture-bifrost-cache'),
            runtimeRoot: path.join(ROOT, '.fixture-bifrost-runtime'),
            platform: 'darwin',
            arch,
            port: 43210,
        });
        assert.equal(descriptor.executable.endsWith('bifrost-http'), true);
        assert.equal(descriptor.imageName, 'bifrost-http');
        assert.equal(descriptor.args.includes('-host'), true);
        assert.equal(descriptor.args[descriptor.args.indexOf('-host') + 1], '127.0.0.1');
        assert.equal(descriptor.args[descriptor.args.indexOf('-port') + 1], '43210');
        assert.equal(descriptor.identity.sha256, sha256);
        assert.equal(descriptor.identity.version, 'v2.5.0');
    }
});

test('dashboard fixture mode suppresses every production boot child and timer', () => {
    const source = fs.readFileSync(PROXY, 'utf8');
    assert.match(source, /const skipBootChildren = process\.env\.SWITCHER_NO_BOOT_CHILDREN === '1'/);
    const start = source.indexOf('server.listen(LISTEN_PORT');
    const guard = source.indexOf('if (!skipBootChildren)', start);
    const registry = source.indexOf('writeBackendsRegistry()', start);
    const end = source.indexOf('\n});', registry);
    assert.ok(start > 0 && guard > start && registry > guard && end > registry);
    const guarded = source.slice(guard, registry);
    for (const action of ['ghWarmIndexOnBoot()', 'newapiWarmProfileKeys', 'arMigrateIds()',
        'tgHealth.pruneOrphans()', 'fmAutoLoadPersist()', 'moneyLoadPersist()', 'pmQuotaStart()',
        'grokLauncherStart()', 'arProxySpawn({ force: true })', 'keepaliveBring(AR_KEEPALIVE_PORT']) {
        assert.ok(guarded.includes(action), `${action} is outside the fixture boot guard`);
    }
    const afterRegistry = source.slice(registry, end);
    assert.match(afterRegistry, /if \(!skipBootChildren\)[\s\S]*keepaliveBring\(frontdoorPort\(\), \{ force: true \}\)/);
});

test('AgentRouter production keepalive routes exact GPT through its converter', () => {
    const source = fs.readFileSync(PROXY, 'utf8');
    const start = source.indexOf('async function arKeepaliveSpawn()');
    const end = source.indexOf('\nconst AR_MODELS_CACHE', start);
    assert.ok(start > 0 && end > start, 'arKeepaliveSpawn body is missing');
    const body = source.slice(start, end);
    assert.match(body, /LOCAL_EXACT_ADAPTER:\s*'1'/);
    assert.match(body, /HAIKU_GPT_PROXY:\s*AR_PROXY_URL/);
});

test('transparent proxy injects the existing same-origin loopback mutation guard', () => {
    const source = fs.readFileSync(PROXY, 'utf8');
    const start = source.indexOf('const apiGatewayProduction = createProductionApiGateway({');
    const end = source.indexOf('\n});', start);
    assert.ok(start > 0 && end > start);
    assert.match(source.slice(start, end), /canWrite:\s*a6Routes\.canWrite/);
});

test('transparent proxy Routes endpoint consumes the production shared resolver', () => {
    const source = fs.readFileSync(PROXY, 'utf8');
    const head = source.indexOf('async function handleRoutesModels(');
    const end = source.indexOf('\nfunction handleRoutes(', head);
    assert.ok(head > 0 && end > head, 'async handleRoutesModels body is missing');
    const body = source.slice(head, end);
    assert.match(body, /apiGatewayProduction\.resolveRouteCandidates\(\[provider\]\)/);
    assert.doesNotMatch(body, /routesCatalogLib\.(?:pricingFor|snapshotFor|pickAccountKey|textOnly)/);
    assert.match(source, /async function resolveApiGatewayCandidates\(/);
});

test('transparent proxy structurally installs exact API Gateway routes before generic handlers and recovers on startup', () => {
    const source = fs.readFileSync(PROXY, 'utf8');
    assert.match(source, /createProductionApiGateway/);
    const serverAt = source.indexOf('const server = http.createServer');
    const gatewayAt = source.indexOf('apiGatewayRoutes.handle(req, res)', serverAt);
    const statusAt = source.indexOf("req.url === '/__switch/api/status'", serverAt);
    assert.ok(serverAt >= 0 && gatewayAt > serverAt && statusAt > gatewayAt, 'API Gateway route module must run before generic handlers');
    assert.match(source, /apiGatewayOpenCodeRecovery/);
});

// Фильтр видимых провайдеров едет только в отдельный запрос кандидатов. Начальное состояние
// читает один манифест и не должно ждать сеть шлюзов.
test('candidate route passes visible providers from the query and ignores malformed names', async () => {
    const seen = [];
    const service = {
        state: async () => ({ ok: true, models: [] }),
        candidates: async (options) => { seen.push(options); return { ok: true, models: [] }; },
    };
    const routes = load().createApiGatewayRoutes({ service });
    const cases = [
        ['/__switch/api/api-gateway/candidates?provider=alpha&provider=beta', ['alpha', 'beta']],
        ['/__switch/api/api-gateway/candidates?provider=alpha,beta', ['alpha', 'beta']],
        ['/__switch/api/api-gateway/candidates?provider=alpha&provider=../etc', ['alpha']],
        ['/__switch/api/api-gateway/candidates', null],
        ['/__switch/api/api-gateway/candidates?provider=bad name&provider=a b', null],
    ];
    for (const [url, expected] of cases) {
        routes.handle(request({ url }), response());
        await settle();
        assert.deepEqual(seen[seen.length - 1], { providers: expected }, url);
    }
});
