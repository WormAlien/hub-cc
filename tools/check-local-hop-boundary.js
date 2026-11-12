#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FRONTDOOR = path.join(ROOT, 'routing', 'frontdoor-proxy.js');
const KEEPALIVE = path.join(ROOT, 'routing', 'keepalive-proxy.js');
const ADAPTER = path.join(ROOT, 'routing', 'custom-openai-proxy.js');
const LOCAL_HOP = path.join(ROOT, 'routing', 'lib', 'local-hop-auth.js');
const CUSTOM_TOPOLOGY = path.join(ROOT, 'routing', 'lib', 'custom-openai-topology.js');
const A6_GATEWAY = path.join(ROOT, 'routing', 'lib', 'a6api-gateway.js');
const TRANSPARENT = path.join(ROOT, 'routing', 'transparent-proxy.js');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
    catch (error) { console.error(`  FAIL ${name}\n       ${error.stack || error.message}`); process.exitCode = 1; }
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

async function reservePort() {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}

function spawnNode(name, script, args, env, cwd, children) {
    let output = '';
    const child = spawn(process.execPath, [script, ...args], {
        cwd, env: { ...process.env, NODE_OPTIONS: '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const capture = chunk => { output = (output + chunk.toString('utf8')).slice(-24000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    children.push(child);
    return { name, child, output: () => output };
}

async function stopChild(record) {
    const child = record && record.child ? record.child : record;
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = once(child, 'exit').catch(() => []);
    try { child.kill(); } catch { /* already gone */ }
    await Promise.race([exited, wait(1500)]);
    if (child.exitCode === null && !child.signalCode) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await Promise.race([once(child, 'exit').catch(() => []), wait(1500)]);
    }
}

async function waitReady(record, url) {
    for (let i = 0; i < 120; i += 1) {
        if (record.child.exitCode !== null || record.child.signalCode) {
            throw new Error(`${record.name} exited before readiness:\n${record.output()}`);
        }
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(250) });
            await response.text();
            if (response.ok) return;
        } catch { /* not ready */ }
        await wait(40);
    }
    throw new Error(`${record.name} readiness timeout:\n${record.output()}`);
}

function request({ port, method = 'GET', pathname = '/', headers = {}, body = null, timeoutMs = 5000 }) {
    const payload = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port, method, path: pathname, timeout: timeoutMs,
            headers: { ...(payload ? { 'content-length': String(payload.length) } : {}), ...headers },
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: { ...res.headers }, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        req.end(payload || undefined);
    });
}

function inferenceBody(model = 'Claude-Opus/Boundary[1m]') {
    return { model, max_tokens: 32, messages: [{ role: 'user', content: 'trust boundary' }] };
}

(async () => {
    console.log('check-local-hop-boundary:');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-hop-boundary-'));
    const secretFile = path.join(temp, 'secrets', 'abuse-hub-local-hop.key');
    const ownerKeyFile = path.join(temp, 'owner-paid-key.txt');
    const adapterConfig = path.join(temp, 'adapter.json');
    const modelMapFile = path.join(temp, 'modelmap.json');
    const keepaliveConfig = path.join(temp, 'keepalive.json');
    const children = [];
    const servers = [];
    const vendorRequests = [];
    let allowVendorResponse = false;
    try {
        fs.writeFileSync(ownerKeyFile, 'owner-paid-key\n', 'utf8');
        fs.writeFileSync(modelMapFile, '{}\n', 'utf8');

        const vendor = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                vendorRequests.push({ headers: { ...req.headers }, body: Buffer.concat(chunks).toString('utf8') });
                if (!allowVendorResponse) {
                    res.writeHead(500, { 'content-type': 'application/json' });
                    return res.end('{"error":{"message":"disabled"}}');
                }
                const incoming = JSON.parse(vendorRequests.at(-1).body);
                const outgoing = JSON.stringify({
                    id: 'chatcmpl_boundary', model: incoming.model,
                    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 1, completion_tokens: 1 },
                });
                res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(outgoing) });
                res.end(outgoing);
            });
        });
        servers.push(vendor);
        const vendorPort = await listen(vendor);
        const adapterPort = await reservePort();
        const keepalivePort = await reservePort();
        const frontdoorPort = await reservePort();

        fs.writeFileSync(adapterConfig, JSON.stringify({
            port: adapterPort,
            upstream: `http://127.0.0.1:${vendorPort}/v1`,
            keyFile: ownerKeyFile,
            modelMap: { opus: 'mapped-opus' },
            providerId: 'fixture',
            providerName: 'Fixture Adapter',
        }) + '\n', 'utf8');

        const adapter = spawnNode('adapter', ADAPTER, [adapterConfig], {
            HOME: temp, USERPROFILE: temp,
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: secretFile,
        }, temp, children);
        await waitReady(adapter, `http://127.0.0.1:${adapterPort}/health`);

        const baseKeepaliveEnv = {
            HOME: temp, USERPROFILE: temp,
            PORT: String(keepalivePort),
            UPSTREAM: `http://127.0.0.1:${adapterPort}`,
            LOCAL_EXACT_ADAPTER: '1',
            CUSTOM_PROVIDER_ID: 'fixture',
            CUSTOM_PROVIDER_NAME: 'Fixture Adapter',
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: secretFile,
            KEY_FILE: ownerKeyFile,
            MODELMAP_FILE: modelMapFile,
            CONFIG_FILE: keepaliveConfig,
            MAX_ATTEMPTS: '1', MAX_HEDGES: '0', HEDGE_MS: '0', PRE_COMMIT_MS: '0',
            HOLD_MS: '0', EMPTY_STREAM_MS: '0', COUNT_TOKENS_FALLBACK: '0',
            JSON_HOLD_MS: '0', STALL_MS: '0', CATALOG_TTL_MS: '0',
            VISION_BRIDGE: '0', MODEL_ECHO: '0', MODEL_ECHO_INJECT: '0',
            UPSTREAM_TIMEOUT_MS: '3000',
        };
        const keepalive = spawnNode('keepalive', KEEPALIVE, [], baseKeepaliveEnv, temp, children);
        await waitReady(keepalive, `http://127.0.0.1:${keepalivePort}/__keepalive/api/status`);

        const claudeDir = path.join(temp, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        const state = { backend: 'fixture', upstream: `http://127.0.0.1:${keepalivePort}`, keyFile: null, modelmap: modelMapFile };
        const activeFile = path.join(claudeDir, 'active-backend.json');
        const backendsFile = path.join(claudeDir, 'backends.json');
        const multiFile = path.join(temp, 'multi-routes-modelmap.json');
        fs.writeFileSync(activeFile, JSON.stringify(state) + '\n');
        fs.writeFileSync(backendsFile, JSON.stringify({ version: 1, providers: { fixture: state }, aliases: {} }) + '\n');
        fs.writeFileSync(multiFile, '{}\n');
        const frontdoor = spawnNode('frontdoor', FRONTDOOR, [], {
            HOME: temp, USERPROFILE: temp, PORT: String(frontdoorPort),
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: secretFile,
            ACTIVE_BACKEND_FILE: activeFile, BACKENDS_FILE: backendsFile, MULTI_MAP_FILE: multiFile,
            SWITCH_PORT: '1', ENSURE_TIMEOUT_MS: '50', UPSTREAM_TIMEOUT_MS: '3000',
            BIFROST_URL: 'http://127.0.0.1:1', TOKEN_USAGE_FILE: path.join(temp, 'usage.jsonl'),
        }, temp, children);
        await waitReady(frontdoor, `http://127.0.0.1:${frontdoorPort}/__frontdoor/api/status`);

        await test('shared secret is atomically created as exactly 32 bytes in the temp override only', async () => {
            assert.ok(fs.existsSync(LOCAL_HOP), 'shared local-hop auth module is missing');
            const auth = require(LOCAL_HOP).createLocalHopAuth({ secretFile, eager: true });
            assert.equal(auth.secretFile, path.resolve(secretFile));
            const bytes = fs.readFileSync(secretFile);
            assert.equal(bytes.length, 32);
            assert.notEqual(secretFile.toLowerCase(), path.join(os.homedir(), '.secrets', 'abuse-hub-local-hop.key').toLowerCase());
        });

        await test('direct keepalive forged final+exact markers cannot trigger owner-key inference', async () => {
            vendorRequests.length = 0;
            allowVendorResponse = true;
            const response = await request({
                port: keepalivePort, method: 'POST', pathname: '/v1/messages',
                headers: { 'content-type': 'application/json', 'x-route-final': '1', 'x-route-exact': '1' },
                body: inferenceBody('Claude-Opus/Direct-Forged[1m]'),
            });
            assert.ok(response.status === 401 || response.status === 403, response.body);
            assert.equal(vendorRequests.length, 0, 'unauthorized direct keepalive caller contacted owner-key adapter');
        });

        await test('direct adapter forged local-exact marker cannot spend the owner key', async () => {
            const before = vendorRequests.length;
            const response = await request({
                port: adapterPort, method: 'POST', pathname: '/v1/messages',
                headers: { 'content-type': 'application/json', 'x-abuse-hub-local-exact': '1' },
                body: inferenceBody('Claude-Opus/Adapter-Forged[1m]'),
            });
            assert.ok(response.status === 401 || response.status === 403, response.body);
            assert.equal(vendorRequests.length, before, 'unauthorized adapter caller contacted vendor');
        });

        await test('hostile Origin text/plain POST is rejected before owner key resolution or vendor contact', async () => {
            const before = vendorRequests.length;
            const response = await request({
                port: adapterPort, method: 'POST', pathname: '/v1/messages',
                headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
                body: JSON.stringify(inferenceBody()),
            });
            assert.ok(response.status === 401 || response.status === 403, response.body);
            assert.equal(response.headers['access-control-allow-origin'], undefined);
            assert.equal(vendorRequests.length, before, 'hostile Origin caused owner-key inference');
        });

        await test('hostile Origin with valid adapter auth is still rejected before owner key use', async () => {
            const auth = require(LOCAL_HOP).createLocalHopAuth({ secretFile });
            const before = vendorRequests.length;
            const response = await request({
                port: adapterPort, method: 'POST', pathname: '/v1/messages',
                headers: {
                    'content-type': 'text/plain',
                    origin: 'https://evil.example',
                    [auth.headerName]: auth.token('keepalive-to-adapter'),
                    'x-abuse-hub-local-exact': '1',
                },
                body: JSON.stringify(inferenceBody('Claude-Opus/Origin-With-Auth[1m]')),
            });
            assert.equal(response.status, 403, response.body);
            assert.equal(response.headers['access-control-allow-origin'], undefined);
            assert.equal(vendorRequests.length, before, 'Origin with valid adapter auth contacted vendor');
        });

        await test('frontdoor and keepalive public status are non-CORS and path/local-detail redacted', async () => {
            const frontdoorStatus = await request({
                port: frontdoorPort, pathname: '/__frontdoor/api/status',
                headers: { origin: 'https://evil.example' },
            });
            assert.equal(frontdoorStatus.status, 200);
            assert.equal(frontdoorStatus.headers['access-control-allow-origin'], undefined);
            const frontdoorBody = JSON.parse(frontdoorStatus.body);
            for (const name of ['state_file', 'registry_file', 'upstream', 'modelmap', 'registry']) {
                assert.equal(Object.hasOwn(frontdoorBody, name), false, `frontdoor public status exposed ${name}`);
            }
            assert.equal(frontdoorStatus.body.includes(temp), false);

            const keepaliveStatus = await request({
                port: keepalivePort, pathname: '/__keepalive/api/status',
                headers: { origin: 'https://evil.example' },
            });
            assert.equal(keepaliveStatus.status, 200);
            assert.equal(keepaliveStatus.headers['access-control-allow-origin'], undefined);
            const keepaliveBody = JSON.parse(keepaliveStatus.body);
            for (const name of ['pid', 'port', 'upstream', 'adapterUrl', 'localExactAdapter']) {
                assert.equal(Object.hasOwn(keepaliveBody, name), false, `keepalive public status exposed ${name}`);
            }
        });

        await test('status-inspection auth unlocks bounded frontdoor and keepalive identity only', async () => {
            const auth = require(LOCAL_HOP).createLocalHopAuth({ secretFile });
            const headers = { [auth.headerName]: auth.token('status-inspection') };
            const frontdoorStatus = await request({ port: frontdoorPort, pathname: '/__frontdoor/api/status', headers });
            assert.equal(frontdoorStatus.status, 200);
            assert.ok(frontdoorStatus.body.length < 64 * 1024);
            const frontdoorBody = JSON.parse(frontdoorStatus.body);
            assert.equal(frontdoorBody.upstream, `http://127.0.0.1:${keepalivePort}`);
            assert.equal(Object.hasOwn(frontdoorBody, 'state_file'), false);
            assert.equal(Object.hasOwn(frontdoorBody, 'registry_file'), false);
            assert.equal(frontdoorStatus.body.includes(temp), false);

            const keepaliveStatus = await request({ port: keepalivePort, pathname: '/__keepalive/api/status', headers });
            assert.equal(keepaliveStatus.status, 200);
            assert.ok(keepaliveStatus.body.length < 8192);
            const keepaliveBody = JSON.parse(keepaliveStatus.body);
            assert.equal(keepaliveBody.pid, keepalive.child.pid);
            assert.equal(keepaliveBody.port, keepalivePort);
            assert.equal(keepaliveBody.upstream, `http://127.0.0.1:${adapterPort}`);
            assert.equal(keepaliveBody.adapterUrl, `http://127.0.0.1:${adapterPort}`);
        });

        await test('trusted frontdoor exact request derives role-separated hop auth and consumes every marker before vendor egress', async () => {
            vendorRequests.length = 0;
            const response = await request({
                port: frontdoorPort, method: 'POST', pathname: '/v1/messages',
                headers: { 'content-type': 'application/json' },
                body: inferenceBody('fixture/Claude-Opus/Trusted[1m]'),
            });
            assert.equal(response.status, 200, response.body);
            assert.equal(vendorRequests.length, 1);
            assert.equal(JSON.parse(vendorRequests[0].body).model, 'Claude-Opus/Trusted[1m]');
            for (const name of Object.keys(vendorRequests[0].headers)) {
                assert.equal(name.startsWith('x-abuse-hub-'), false, `${name} reached vendor`);
                assert.equal(name.startsWith('x-route-'), false, `${name} reached vendor`);
            }
        });

        await test('unauthenticated status is non-CORS and redacts paths, upstream, maps, and local details', async () => {
            const status = await request({ port: adapterPort, pathname: '/__custom/api/status', headers: { origin: 'https://evil.example' } });
            assert.equal(status.status, 200);
            assert.equal(status.headers['access-control-allow-origin'], undefined);
            const body = JSON.parse(status.body);
            assert.equal(Object.hasOwn(body, 'keyFile'), false);
            assert.equal(Object.hasOwn(body, 'upstream'), false);
            assert.equal(Object.hasOwn(body, 'modelMap'), false);
            assert.equal(status.body.includes(temp), false);
            assert.equal(status.body.includes(ownerKeyFile), false);
        });

        await test('adapter-auth wire token cannot unlock detailed status identity', async () => {
            const auth = require(LOCAL_HOP).createLocalHopAuth({ secretFile });
            const status = await request({
                port: adapterPort, pathname: '/__custom/api/status',
                headers: { [auth.headerName]: auth.token('keepalive-to-adapter') },
            });
            assert.equal(status.status, 200, status.body);
            const body = JSON.parse(status.body);
            assert.equal(Object.hasOwn(body, 'pid'), false);
            assert.equal(Object.hasOwn(body, 'port'), false);
            assert.equal(Object.hasOwn(body, 'upstream'), false);
            assert.equal(Object.hasOwn(body, 'configSha256'), false);
        });

        await test('authenticated detailed status stays bounded and supports exact process identity without private paths', async () => {
            const auth = require(LOCAL_HOP).createLocalHopAuth({ secretFile });
            const status = await request({
                port: adapterPort, pathname: '/__custom/api/status',
                headers: { [auth.headerName]: auth.token('status-inspection') },
            });
            assert.equal(status.status, 200, status.body);
            assert.ok(status.body.length < 8192);
            const body = JSON.parse(status.body);
            assert.equal(body.role, 'adapter');
            assert.equal(body.providerId, 'fixture');
            assert.equal(body.pid, adapter.child.pid);
            assert.equal(body.port, adapterPort);
            assert.equal(body.upstream, `http://127.0.0.1:${vendorPort}/v1`);
            assert.equal(status.body.includes(ownerKeyFile), false);
            assert.equal(status.body.includes(secretFile), false);
        });

        await test('role tokens differ and production generators propagate only the secret path', async () => {
            const auth = require(LOCAL_HOP).createLocalHopAuth({ secretFile });
            assert.notEqual(auth.token('frontdoor-to-keepalive'), auth.token('keepalive-to-adapter'));
            assert.notEqual(auth.token('status-inspection'), auth.token('keepalive-to-adapter'));
            assert.notEqual(auth.token('status-inspection'), auth.token('frontdoor-to-keepalive'));
            const generic = require(CUSTOM_TOPOLOGY).buildRuntimeConfig({
                provider: { id: 'generic', name: 'Generic', baseUrl: 'https://vendor.invalid/v1' },
                keepalivePort: 31001, adapterPort: 31002, claudeDir: temp,
                activeKeyFile: ownerKeyFile, localHopSecretPath: secretFile,
            });
            assert.equal(generic.keepaliveEnv.ABUSE_HUB_LOCAL_HOP_KEY_FILE, secretFile);
            assert.equal(generic.converter.localHopSecretPath, secretFile);
            const a6 = require(A6_GATEWAY).buildRuntimeConfig({
                secretDir: temp, routingDir: path.join(ROOT, 'routing'), port: 31003,
                converterPort: 31004, localHopSecretPath: secretFile,
            });
            assert.equal(a6.keepaliveEnv.ABUSE_HUB_LOCAL_HOP_KEY_FILE, secretFile);
            assert.equal(a6.converter.localHopSecretPath, secretFile);
            const source = fs.readFileSync(TRANSPARENT, 'utf8');
            for (const label of ['KVOTUM', 'Odyssey']) {
                assert.match(source, new RegExp(`${label}[\\s\\S]{0,4000}ABUSE_HUB_LOCAL_HOP_KEY_FILE|ABUSE_HUB_LOCAL_HOP_KEY_FILE[\\s\\S]{0,4000}${label}`));
            }
            const spawnSites = (source.match(/custom-openai-proxy\.js/g) || []).length
                + (fs.readFileSync(A6_GATEWAY, 'utf8').match(/custom-openai-proxy\.js/g) || []).length;
            assert.ok(spawnSites >= 4, 'expected all current custom-openai-backed topologies');
            assert.equal(JSON.stringify(generic).includes(auth.token('frontdoor-to-keepalive')), false);
            assert.equal(JSON.stringify(a6).includes(auth.token('keepalive-to-adapter')), false);
        });
    } finally {
        for (const child of children.reverse()) await stopChild(child);
        for (const server of servers.reverse()) {
            try { server.closeAllConnections(); } catch { /* old Node */ }
            if (server.listening) await new Promise(resolve => server.close(resolve));
        }
        fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log(process.exitCode ? '\nFAILED' : `\nPASS (${passed})`);
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
