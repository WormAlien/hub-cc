#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'routing', 'lib', 'api-gateway-hermes.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-hermes-'));
const INSTALL_COMMAND = 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)';
const START_COMMAND = 'hermes dashboard --no-open';
const PUBLIC_BASE_URL = 'http://127.0.0.1:20100/openai/v1';
const MODEL = 'agentrouter/gpt-5.6-sol';
const SECRET = 'sk-fixture-never-return';
const PRIVATE_PATH = 'C:\\Users\\Private\\.hermes\\config.yaml';

const servers = new Set();

after(async () => {
    await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(TMP, { recursive: true, force: true });
});

function sendJson(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
    });
    response.end(body);
}

async function startStub(handler) {
    const server = http.createServer(handler);
    servers.add(server);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: async () => {
            if (!servers.delete(server)) return;
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}

function marker(name) {
    const target = path.join(TMP, name, 'bin', 'hermes.cmd');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '@exit /b 0\r\n', 'ascii');
    return target;
}

function load() {
    assert.ok(fs.existsSync(LIB_PATH), 'routing/lib/api-gateway-hermes.js must exist');
    delete require.cache[require.resolve(LIB_PATH)];
    return require(LIB_PATH);
}

function serviceOptions(installationMarker, dashboardBaseUrl, getModel = async () => MODEL) {
    return {
        installationProbes: [installationMarker],
        dashboardBaseUrl,
        getModel,
        timeoutMs: 1000,
    };
}

function endpoint(model = MODEL) {
    return {
        id: 'abuse-hub',
        name: 'ABUSE HUB',
        base_url: PUBLIC_BASE_URL,
        model,
        models: [model],
        api_mode: 'chat_completions',
        discover_models: true,
        is_current: false,
        source: 'providers',
    };
}

async function readJsonBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('absent Hermes is neutral and never calls the dashboard or creates a root', async () => {
    let requests = 0;
    let modelReads = 0;
    const stub = await startStub((_request, response) => {
        requests += 1;
        sendJson(response, 500, { detail: 'unexpected request' });
    });
    const probeRoot = path.join(TMP, 'absent-install');
    const installationMarker = path.join(probeRoot, 'bin', 'hermes.cmd');
    const { createHermesService } = load();
    assert.equal(typeof createHermesService, 'function');
    const service = createHermesService(serviceOptions(
        installationMarker,
        stub.baseUrl,
        async () => {
            modelReads += 1;
            return MODEL;
        },
    ));

    for (const method of ['detect', 'status', 'sync']) {
        assert.equal(typeof service[method], 'function', `${method} must be exported`);
    }

    assert.deepEqual(await service.detect(), {
        status: 'absent',
        installed: false,
        installCommand: INSTALL_COMMAND,
        startCommand: START_COMMAND,
    });
    for (const value of [await service.status(), await service.sync()]) {
        assert.equal(value.status, 'absent');
        assert.equal(value.ok, true);
        assert.equal(value.installed, false);
        assert.equal(value.backendRunning, false);
        assert.equal(value.apiCompatible, null);
        assert.equal(value.configured, false);
        assert.equal(value.synced, false);
        assert.equal(value.installCommand, INSTALL_COMMAND);
        assert.equal(value.startCommand, START_COMMAND);
    }
    assert.equal(requests, 0);
    assert.equal(modelReads, 0);
    assert.equal(fs.existsSync(probeRoot), false, 'detection must not mkdir the installation or data root');
    await stub.close();
});

test('installed Hermes with a down backend returns start and offline YAML instructions without writing', async () => {
    const installationMarker = marker('down-install');
    const stub = await startStub((_request, response) => sendJson(response, 500, {}));
    const dashboardBaseUrl = stub.baseUrl;
    await stub.close();
    const installRoot = path.dirname(path.dirname(installationMarker));
    const before = fs.readdirSync(installRoot, { recursive: true }).map(String).sort();
    const service = load().createHermesService(serviceOptions(installationMarker, dashboardBaseUrl));

    const detected = await service.detect();
    assert.deepEqual(detected, {
        status: 'installed',
        installed: true,
        startCommand: START_COMMAND,
    });
    for (const value of [await service.status(), await service.sync()]) {
        assert.equal(value.status, 'down');
        assert.equal(value.ok, false);
        assert.equal(value.installed, true);
        assert.equal(value.backendRunning, false);
        assert.equal(value.apiCompatible, null);
        assert.equal(value.configured, false);
        assert.equal(value.synced, false);
        assert.equal(value.startCommand, START_COMMAND);
        assert.match(value.yaml, /^providers:\n  abuse-hub:/);
        assert.match(value.yaml, /model: agentrouter\/gpt-5\.6-sol/);
        assert.match(value.yaml, /api_mode: chat_completions/);
        assert.match(value.yaml, /discover_models: true/);
        assert.equal(value.yaml.includes('make_default: true'), false);
    }
    const afterFiles = fs.readdirSync(installRoot, { recursive: true }).map(String).sort();
    assert.deepEqual(afterFiles, before, 'down handling must not write offline YAML or create a data root');
});

test('missing published model fails closed before any Hermes API call', async () => {
    let requests = 0;
    const stub = await startStub((_request, response) => {
        requests += 1;
        sendJson(response, 200, { version: '0.23.1' });
    });
    const service = load().createHermesService(serviceOptions(
        marker('no-model-install'),
        stub.baseUrl,
        async () => null,
    ));

    for (const value of [await service.status(), await service.sync()]) {
        assert.equal(value.status, 'blocked');
        assert.equal(value.ok, false);
        assert.equal(value.reason, 'no_published_model');
        assert.equal(value.installed, true);
        assert.equal(value.backendRunning, null);
        assert.equal(value.apiCompatible, null);
        assert.equal(JSON.stringify(value).includes(SECRET), false);
    }
    assert.equal(requests, 0, 'no model must prevent even read-only Hermes API calls');

    const throwing = load().createHermesService(serviceOptions(
        marker('model-error-install'),
        stub.baseUrl,
        async () => { throw new Error(`manifest failed ${SECRET} ${PRIVATE_PATH}`); },
    ));
    const redacted = await throwing.sync();
    assert.equal(redacted.reason, 'no_published_model');
    assert.equal(JSON.stringify(redacted).includes(SECRET), false);
    assert.equal(JSON.stringify(redacted).includes(PRIVATE_PATH), false);
    assert.equal(requests, 0);
    await stub.close();
});

test('v2026.6.5 dashboard without the custom endpoint route reports a clean capability mismatch', async () => {
    const calls = [];
    const stub = await startStub((request, response) => {
        calls.push(`${request.method} ${request.url}`);
        if (request.method === 'GET' && request.url === '/api/status') {
            sendJson(response, 200, { version: 'v2026.6.5', config_path: PRIVATE_PATH });
            return;
        }
        if (request.method === 'GET' && request.url === '/api/providers/custom-endpoints') {
            sendJson(response, 404, { detail: `Not Found ${SECRET} ${PRIVATE_PATH}` });
            return;
        }
        sendJson(response, 500, { detail: 'unexpected request' });
    });
    const service = load().createHermesService(serviceOptions(marker('old-install'), stub.baseUrl));

    for (const value of [await service.status(), await service.sync()]) {
        assert.equal(value.status, 'running');
        assert.equal(value.ok, false);
        assert.equal(value.installed, true);
        assert.equal(value.backendRunning, true);
        assert.equal(value.apiCompatible, false);
        assert.equal(value.version, 'v2026.6.5');
        assert.equal(value.reason, 'unsupported_api');
        assert.match(value.error, /does not support custom endpoint sync/i);
        const text = JSON.stringify(value);
        assert.equal(text.includes(SECRET), false);
        assert.equal(text.includes(PRIVATE_PATH), false);
    }
    assert.equal(calls.filter(call => call.startsWith('POST ')).length, 0);
    assert.deepEqual(calls, [
        'GET /api/status',
        'GET /api/providers/custom-endpoints',
        'GET /api/status',
        'GET /api/providers/custom-endpoints',
    ]);
    await stub.close();
});

test('v0.23.1 upsert sends the required canonical model and never changes the default', async () => {
    const calls = [];
    const posts = [];
    let stored = null;
    const stub = await startStub(async (request, response) => {
        calls.push(`${request.method} ${request.url}`);
        if (request.method === 'GET' && request.url === '/api/status') {
            sendJson(response, 200, { version: '0.23.1' });
            return;
        }
        if (request.method === 'GET' && request.url === '/api/providers/custom-endpoints') {
            sendJson(response, 200, {
                endpoints: stored ? [stored] : [],
                current: { provider: 'existing-provider', model: 'existing/current-model' },
            });
            return;
        }
        if (request.method === 'POST' && request.url === '/api/providers/custom-endpoints') {
            const body = await readJsonBody(request);
            posts.push(body);
            if (!body.model) {
                sendJson(response, 422, { detail: [{ loc: ['body', 'model'], msg: 'Field required' }] });
                return;
            }
            stored = endpoint(body.model);
            sendJson(response, 200, {
                ok: true,
                id: 'abuse-hub',
                endpoints: [stored],
                current: { provider: 'existing-provider', model: 'existing/current-model' },
            });
            return;
        }
        sendJson(response, 500, { detail: 'unexpected request' });
    });
    let modelReads = 0;
    const service = load().createHermesService(serviceOptions(
        marker('current-install'),
        stub.baseUrl,
        async () => {
            modelReads += 1;
            return MODEL;
        },
    ));

    const first = await service.sync();
    assert.equal(first.status, 'running');
    assert.equal(first.ok, true);
    assert.equal(first.backendRunning, true);
    assert.equal(first.apiCompatible, true);
    assert.equal(first.configured, true);
    assert.equal(first.synced, true);
    assert.equal(first.changed, true);
    assert.equal(first.version, '0.23.1');
    assert.deepEqual(posts, [{
        id: 'abuse-hub',
        name: 'ABUSE HUB',
        base_url: PUBLIC_BASE_URL,
        model: MODEL,
        api_mode: 'chat_completions',
        discover_models: true,
        make_default: false,
    }]);
    assert.deepEqual(Object.keys(posts[0]).sort(), [
        'api_mode',
        'base_url',
        'discover_models',
        'id',
        'make_default',
        'model',
        'name',
    ]);
    assert.equal(Object.hasOwn(posts[0], 'current'), false);
    assert.equal(Object.hasOwn(posts[0], 'default_model'), false);
    assert.equal(Object.hasOwn(posts[0], 'api_key'), false);

    const second = await service.sync();
    assert.equal(second.synced, true);
    assert.equal(second.changed, false);
    assert.equal(posts.length, 1, 'an already synced endpoint must not be written again');

    const status = await service.status();
    assert.equal(status.status, 'running');
    assert.equal(status.apiCompatible, true);
    assert.equal(status.configured, true);
    assert.equal(status.synced, true);
    assert.equal(status.version, '0.23.1');
    assert.equal(posts.length, 1);
    assert.equal(modelReads, 3);
    assert.equal(calls.filter(call => call === 'POST /api/providers/custom-endpoints').length, 1);
    assert.ok(calls.filter(call => call === 'GET /api/providers/custom-endpoints').length >= 4);
    await stub.close();
});

test('API failures are redacted and never trigger an offline write', async () => {
    let posts = 0;
    const stub = await startStub((request, response) => {
        if (request.method === 'GET' && request.url === '/api/status') {
            sendJson(response, 200, { version: '0.23.1' });
            return;
        }
        if (request.method === 'GET' && request.url === '/api/providers/custom-endpoints') {
            sendJson(response, 500, { detail: `Bearer ${SECRET} at ${PRIVATE_PATH}` });
            return;
        }
        posts += 1;
        sendJson(response, 500, { detail: SECRET });
    });
    const service = load().createHermesService(serviceOptions(marker('api-error-install'), stub.baseUrl));
    const value = await service.sync();
    assert.equal(value.status, 'running');
    assert.equal(value.ok, false);
    assert.equal(value.backendRunning, true);
    assert.equal(value.apiCompatible, null);
    assert.equal(value.reason, 'api_error');
    assert.equal(value.error, 'Hermes dashboard API request failed.');
    assert.equal(posts, 0);
    const text = JSON.stringify(value);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(PRIVATE_PATH), false);
    await stub.close();
});

test('options reject non-loopback dashboards, relative probes, and missing getModel', () => {
    const { createHermesService } = load();
    for (const options of [
        { installationProbes: [], dashboardBaseUrl: 'http://0.0.0.0:9119', getModel: async () => MODEL },
        { installationProbes: [], dashboardBaseUrl: 'https://127.0.0.1:9119', getModel: async () => MODEL },
        { installationProbes: [], dashboardBaseUrl: 'http://localhost:9119', getModel: async () => MODEL },
        { installationProbes: ['relative/hermes.cmd'], dashboardBaseUrl: 'http://127.0.0.1:9119', getModel: async () => MODEL },
        { installationProbes: [], dashboardBaseUrl: 'http://127.0.0.1:9119' },
    ]) {
        assert.throws(
            () => createHermesService(options),
            error => error && error.code === 'api_gateway_hermes_invalid_options',
        );
    }
});
