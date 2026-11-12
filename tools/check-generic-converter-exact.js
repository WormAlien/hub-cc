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
const CONVERTER = path.join(ROOT, 'routing', 'custom-openai-proxy.js');
const TRANSPARENT = path.join(ROOT, 'routing', 'transparent-proxy.js');
const A6_GATEWAY = path.join(ROOT, 'routing', 'lib', 'a6api-gateway.js');
const CUSTOM_TOPOLOGY = path.join(ROOT, 'routing', 'lib', 'custom-openai-topology.js');
const REQUESTED = 'custom/Claude-Opus/Nested/Case-Sensitive[1m]';
const BARE = REQUESTED.slice(REQUESTED.indexOf('/') + 1);
const MAPPED = 'mapped-opus';
const LOCAL_MARKER = 'x-abuse-hub-local-exact';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const stopped = once(child, 'exit');
    child.kill();
    await Promise.race([stopped, wait(2000)]);
    if (child.exitCode === null && !child.signalCode) {
        const killed = once(child, 'exit');
        child.kill('SIGKILL');
        await Promise.race([killed, wait(2000)]);
    }
}

async function waitReady(child, url, output) {
    for (let i = 0; i < 120; i += 1) {
        if (child.exitCode !== null || child.signalCode) {
            throw new Error(`child exited before ${url} was ready:\n${output()}`);
        }
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(250) });
            await response.text();
            if (response.ok) return;
        } catch { /* not ready */ }
        await wait(40);
    }
    throw new Error(`readiness timeout for ${url}:\n${output()}`);
}

function spawnNode(name, script, args, env, cwd, children) {
    let output = '';
    const child = spawn(process.execPath, [script, ...args], {
        cwd,
        env: { ...process.env, NODE_OPTIONS: '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = chunk => { output = (output + chunk.toString('utf8')).slice(-16000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    children.push(child);
    return { child, output: () => `${name}:\n${output}` };
}

function request(port, body, headers = {}) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port, method: 'POST', path: '/v1/messages', timeout: 8000,
            headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers },
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(new Error('request timed out')));
        req.on('error', reject);
        req.end(payload);
    });
}

function functionSlice(source, name) {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing function ${name}`);
    let brace = source.indexOf('{', start);
    if (brace < 0) throw new Error(`missing body for ${name}`);
    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let i = brace; i < source.length; i += 1) {
        const c = source[i], next = source[i + 1];
        if (lineComment) { if (c === '\n') lineComment = false; continue; }
        if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i += 1; } continue; }
        if (quote) {
            if (escaped) { escaped = false; continue; }
            if (c === '\\') { escaped = true; continue; }
            if (c === quote) quote = '';
            continue;
        }
        if (c === '/' && next === '/') { lineComment = true; i += 1; continue; }
        if (c === '/' && next === '*') { blockComment = true; i += 1; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') depth += 1;
        if (c === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`unterminated function ${name}`);
}

function generatedTopologySignals() {
    const source = fs.readFileSync(TRANSPARENT, 'utf8');
    const custom = functionSlice(source, 'customSpawnProxy');
    const customRuntime = require(CUSTOM_TOPOLOGY).buildRuntimeConfig({
        provider: {
            id: 'fixture-provider',
            name: 'Generic Custom Fixture',
            baseUrl: 'https://vendor.invalid/v1',
            modelMap: { opus: MAPPED },
        },
        keepalivePort: 31001,
        adapterPort: 31002,
        claudeDir: path.join(os.tmpdir(), 'generic-custom-topology'),
        activeKeyFile: path.join(os.tmpdir(), 'generic-custom-key.txt'),
    });
    return {
        source,
        custom,
        customRuntime,
        genericExactAdapter: customRuntime.keepaliveEnv.LOCAL_EXACT_ADAPTER === '1',
    };
}

function verifyGeneratedTopologies({ source, custom, customRuntime }) {
    assert.match(custom, /custom-openai-proxy\.js/, 'generic custom topology must spawn custom-openai-proxy');
    assert.match(custom, /KEEPALIVE_PROXY_FILE/, 'generic custom topology must place keepalive before custom-openai-proxy');
    assert.match(custom, /custom-openai-topology/, 'generic custom topology must use the explicit generated runtime config');
    assert.equal(customRuntime.keepaliveEnv.UPSTREAM, `http://127.0.0.1:${customRuntime.converter.port}`,
        'generic custom adapter identity must come from its generated loopback topology');
    assert.equal(customRuntime.keepaliveEnv.LOCAL_EXACT_ADAPTER, '1',
        'generic custom converter-backed keepalive must explicitly opt into local exact adapter mode');
    assert.match(custom, /p\.adapterPort\s*=\s*adapterPort[\s\S]*?p\.adapterPid\s*=\s*adapter\.pid/,
        'generic custom topology must persist the adapter identity explicitly');

    for (const [name, upstreamPattern] of [
        ['arKeepaliveSpawn', /HAIKU_GPT_PROXY:\s*AR_PROXY_URL/],
        ['kvKeepaliveSpawn', /UPSTREAM:\s*KV_CONVERTER_URL/],
        ['odKeepaliveSpawn', /HAIKU_GPT_PROXY:\s*OD_CONVERTER_URL/],
    ]) {
        const slice = functionSlice(source, name);
        assert.match(slice, upstreamPattern, `${name} must explicitly select its custom-openai adapter`);
        assert.match(slice, /LOCAL_EXACT_ADAPTER:\s*'1'/, `${name} must opt into local exact adapter mode`);
    }

    const explicitAdapterOptIns = (source.match(/LOCAL_EXACT_ADAPTER:\s*'1'/g) || []).length;
    assert.equal(explicitAdapterOptIns, 3,
        'transparent-proxy must opt in exactly its three inline converter topologies');
    const transparentSpawnCount = (source.match(/spawn\(process\.execPath,\s*\[path\.join\(__dirname,\s*'custom-openai-proxy\.js'\)/g) || []).length;
    assert.equal(transparentSpawnCount, 3,
        'a custom-openai-proxy spawn site was added or removed without exact-adapter topology coverage');

    const productionScripts = [path.join(ROOT, 'routing'), path.join(ROOT, 'routing', 'lib')]
        .flatMap(dir => fs.readdirSync(dir, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.js') && !entry.name.includes('.bak'))
            .map(entry => path.join(dir, entry.name)));
    let allSpawnSites = 0;
    for (const file of productionScripts) {
        const script = fs.readFileSync(file, 'utf8');
        allSpawnSites += (script.match(/spawn\(process\.execPath,\s*\[path\.join\(__dirname,\s*'custom-openai-proxy\.js'\)/g) || []).length;
        allSpawnSites += (script.match(/script:\s*'custom-openai-proxy\.js'/g) || []).length;
    }
    assert.equal(allSpawnSites, 4,
        'a custom-openai-proxy-backed topology was added or removed without adapter-mode coverage');

    const a6Source = fs.readFileSync(A6_GATEWAY, 'utf8');
    assert.equal((a6Source.match(/script:\s*'custom-openai-proxy\.js'/g) || []).length, 1,
        'a6api custom-openai spawn coverage changed silently');
    const a6 = require(A6_GATEWAY).buildRuntimeConfig({
        secretDir: path.join(os.tmpdir(), 'a6api-topology-check'),
        routingDir: path.join(ROOT, 'routing'),
    });
    assert.equal(a6.keepaliveEnv.UPSTREAM, `http://127.0.0.1:${a6.converter.port}`,
        'a6api keepalive must select its generated converter');
    assert.equal(a6.keepaliveEnv.LOCAL_EXACT_ADAPTER, '1',
        'a6api converter-backed keepalive must explicitly opt in instead of inheriting PAID_SINGLE_KEY');
}

(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'generic-converter-exact-'));
    const children = [];
    const servers = [];
    const vendorRequests = [];
    try {
        const topology = generatedTopologySignals();

        const vendor = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                const body = JSON.parse(raw.toString('utf8'));
                vendorRequests.push({ raw, body, headers: { ...req.headers } });
                const response = Buffer.from(JSON.stringify({
                    id: 'chatcmpl_generic_exact', model: body.model,
                    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 1, completion_tokens: 1 },
                }), 'utf8');
                res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(response.length) });
                res.end(response);
            });
        });
        servers.push(vendor);
        const vendorPort = await listen(vendor);
        const converterPort = await reservePort();
        const keepalivePort = await reservePort();
        const frontdoorPort = await reservePort();
        const directConverterPort = await reservePort();

        const keyFile = path.join(temp, 'custom-active-key.txt');
        const converterConfig = path.join(temp, 'custom-provider-proxy.json');
        fs.writeFileSync(keyFile, 'fixture-custom-key\n', 'utf8');
        const localHopSecretPath = path.join(temp, 'abuse-hub-local-hop.key');
        const genericRuntime = require(CUSTOM_TOPOLOGY).buildRuntimeConfig({
            provider: {
                id: 'fixture-provider',
                name: 'Generic Custom Fixture',
                baseUrl: `http://127.0.0.1:${vendorPort}/v1`,
                modelMap: { opus: MAPPED, sonnet: 'mapped-sonnet', haiku: 'mapped-haiku' },
            },
            keepalivePort,
            adapterPort: converterPort,
            claudeDir: temp,
            activeKeyFile: keyFile,
            localHopSecretPath,
        });
        fs.writeFileSync(converterConfig, JSON.stringify(genericRuntime.converter) + '\n', 'utf8');
        fs.writeFileSync(genericRuntime.keepaliveEnv.MODELMAP_FILE, '{}\n');

        const converter = spawnNode('converter', CONVERTER, [converterConfig], {
            HOME: temp, USERPROFILE: temp, PORT: String(converterPort),
        }, temp, children);
        await waitReady(converter.child, `http://127.0.0.1:${converterPort}/health`, converter.output);

        const keepalive = spawnNode('keepalive', KEEPALIVE, [], {
            HOME: temp, USERPROFILE: temp,
            ...genericRuntime.keepaliveEnv,
            LOCAL_EXACT_ADAPTER: topology.genericExactAdapter ? '1' : '0',
            UPSTREAM_TIMEOUT_MS: '5000',
        }, temp, children);
        await waitReady(keepalive.child, `http://127.0.0.1:${keepalivePort}/__keepalive/api/status`, keepalive.output);

        const claudeDir = path.join(temp, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        const state = { backend: 'custom', upstream: `http://127.0.0.1:${keepalivePort}`, keyFile: null, modelmap: genericRuntime.keepaliveEnv.MODELMAP_FILE };
        const activeFile = path.join(claudeDir, 'active-backend.json');
        const backendsFile = path.join(claudeDir, 'backends.json');
        const multiFile = path.join(temp, 'multi-routes-modelmap.json');
        fs.writeFileSync(activeFile, JSON.stringify(state) + '\n');
        fs.writeFileSync(backendsFile, JSON.stringify({ version: 1, providers: { custom: state }, aliases: {} }) + '\n');
        fs.writeFileSync(multiFile, '{}\n');

        const frontdoor = spawnNode('frontdoor', FRONTDOOR, [], {
            HOME: temp, USERPROFILE: temp, PORT: String(frontdoorPort),
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: localHopSecretPath,
            ACTIVE_BACKEND_FILE: activeFile, BACKENDS_FILE: backendsFile, MULTI_MAP_FILE: multiFile,
            SWITCH_PORT: '1', ENSURE_TIMEOUT_MS: '50', UPSTREAM_TIMEOUT_MS: '5000',
            BIFROST_URL: `http://127.0.0.1:${directConverterPort}`,
            TOKEN_USAGE_FILE: path.join(temp, 'usage.jsonl'),
        }, temp, children);
        await waitReady(frontdoor.child, `http://127.0.0.1:${frontdoorPort}/__frontdoor/api/status`, frontdoor.output);

        const response = await request(frontdoorPort, {
            model: REQUESTED,
            max_tokens: 64,
            messages: [{ role: 'user', content: 'generic custom exact topology' }],
        });
        assert.equal(response.status, 200, response.body);
        assert.equal(vendorRequests.length, 1, 'full chain must create exactly one final vendor generation');
        const expectedVendorBody = {
            model: BARE,
            messages: [{ role: 'user', content: 'generic custom exact topology' }],
            max_tokens: 1024,
            stream: false,
        };
        assert.ok(vendorRequests[0].raw.equals(Buffer.from(JSON.stringify(expectedVendorBody), 'utf8')),
            `final vendor body changed: ${vendorRequests[0].raw.toString('utf8')}`);
        assert.equal(vendorRequests[0].body.model, BARE,
            `final vendor model must be byte-for-byte ${JSON.stringify(BARE)}, got ${JSON.stringify(vendorRequests[0].body.model)}`);
        assert.equal(vendorRequests[0].headers[LOCAL_MARKER], undefined, 'local exact marker reached final vendor');
        assert.equal(vendorRequests[0].headers['x-route-final'], undefined, 'x-route-final reached final vendor');
        assert.equal(vendorRequests[0].headers['x-route-exact'], undefined, 'x-route-exact reached final vendor');
        assert.equal(JSON.parse(response.body).model, REQUESTED, 'frontdoor did not restore immutable canonical model');

        verifyGeneratedTopologies(topology);

        const directBefore = vendorRequests.length;
        const direct = await request(frontdoorPort, {
            model: 'Claude-Opus/Caller-Forged[1m]', max_tokens: 64,
            messages: [{ role: 'user', content: 'caller marker is not a public privilege' }],
        }, { [LOCAL_MARKER]: '1' });
        assert.equal(direct.status, 200, direct.body);
        assert.equal(vendorRequests.length, directBefore + 1);
        assert.equal(vendorRequests.at(-1).body.model, MAPPED,
            'a public frontdoor caller earned exact privileges from the internal marker');
        assert.equal(vendorRequests.at(-1).headers[LOCAL_MARKER], undefined, 'forged marker reached vendor');

        console.log('check-generic-converter-exact: PASS');
    } finally {
        for (const child of children.reverse()) await stopChild(child);
        for (const server of servers.reverse()) {
            try { server.closeAllConnections(); } catch { /* old Node */ }
            if (server.listening) await new Promise(resolve => server.close(resolve));
        }
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
