'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'routing', 'frontdoor-proxy.js');
const KEEPALIVE_SCRIPT = path.join(ROOT, 'routing', 'keepalive-proxy.js');
const API_GATEWAY = require(path.join(ROOT, 'routing', 'lib', 'api-gateway.js'));
const CANCELLATION_SCRIPT = path.join(ROOT, 'routing', 'lib', 'request-cancellation.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-frontdoor-'));
const SECRET = 'fixture-private-sentinel';
const SEED = {
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

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function freePort() {
    const probe = require('node:net').createServer();
    return listen(probe).then(port => new Promise(resolve => probe.close(() => resolve(port))));
}

function request(port, method, urlPath, body, extraHeaders = {}) {
    const payload = body === undefined
        ? null
        : Buffer.isBuffer(body)
            ? body
            : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { ...extraHeaders };
    if (payload) {
        headers['content-type'] = headers['content-type'] || 'application/json';
        headers['content-length'] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            method,
            path: urlPath,
            timeout: 4000,
            headers,
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('aborted', () => reject(new Error('response aborted')));
            res.on('error', reject);
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(raw); } catch { /* assertion reports raw */ }
                resolve({ status: res.statusCode, headers: res.headers, raw, json });
            });
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        if (payload) req.end(payload); else req.end();
    });
}

function requestWithOptions(port, {
    method = 'POST',
    urlPath = '/v1/messages',
    body,
    headers: extraHeaders = {},
    localAddress,
} = {}) {
    const payload = body === undefined
        ? null
        : Buffer.isBuffer(body)
            ? body
            : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = Array.isArray(extraHeaders) ? [...extraHeaders] : { ...extraHeaders };
    if (payload) {
        if (Array.isArray(headers)) {
            headers.push(['content-type', 'application/json'], ['content-length', String(payload.length)]);
        } else {
            headers['content-type'] = headers['content-type'] || 'application/json';
            headers['content-length'] = String(payload.length);
        }
    }
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            method,
            path: urlPath,
            timeout: 4000,
            headers,
            ...(localAddress ? { localAddress } : {}),
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('aborted', () => reject(new Error('response aborted')));
            res.on('error', reject);
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(raw); } catch { /* assertion reports raw */ }
                resolve({ status: res.statusCode, headers: res.headers, raw, json });
            });
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        if (payload) req.end(payload); else req.end();
    });
}

function rawHttpRequest(port, wire) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const chunks = [];
        socket.setTimeout(4000, () => socket.destroy(new Error('raw request timeout')));
        socket.on('connect', () => socket.end(wire));
        socket.on('data', chunk => chunks.push(chunk));
        socket.on('error', reject);
        socket.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const status = Number((raw.match(/^HTTP\/1\.1 (\d{3})/) || [])[1]);
            resolve({ status, raw });
        });
    });
}

function errorCode(response) {
    return response.json && response.json.error && response.json.error.code;
}

async function waitUntil(predicate, timeoutMs, message) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(message);
}

function expectGatewayCode(fn, code) {
    let caught = null;
    try { fn(); } catch (error) { caught = error; }
    assert.ok(caught, `expected ${code}`);
    assert.equal(caught.code, code);
}

function checkDelegatedProjectionContract() {
    assert.equal(typeof API_GATEWAY.restoreDelegatedOpenAiObject, 'function',
        'Phase 3 exports delegated OpenAI object restoration');
    assert.equal(typeof API_GATEWAY.makeRedactedOpenAiError, 'function',
        'Phase 3 exports redacted OpenAI errors');
    const publicModel = 'agentrouter/gpt-5.6-sol';
    for (const incoming of ['correct', '', 'gpt-5.6-sol', 'abuse-hub/agentrouter/gpt-5.6-sol', undefined]) {
        const source = incoming === undefined
            ? { id: 'chat_fixture', choices: [], usage: { total_tokens: 2 } }
            : { id: 'chat_fixture', model: incoming, choices: [], usage: { total_tokens: 2 } };
        const before = structuredClone(source);
        const restored = API_GATEWAY.restoreDelegatedOpenAiObject(source, publicModel);
        assert.equal(restored.model, publicModel);
        assert.deepEqual(source, before, 'restoration must not mutate sidecar objects');
        assert.deepEqual(restored.usage, { total_tokens: 2 });
    }
    const redacted = API_GATEWAY.restoreDelegatedOpenAiObject({
        error: { message: SECRET, extra_fields: { raw_body: SECRET }, headers: { authorization: SECRET } },
        model: 'private-model',
        local_path: TMP,
    }, publicModel, { status: 500 });
    assert.deepEqual(redacted, API_GATEWAY.makeRedactedOpenAiError(503, 'upstream_unavailable', publicModel));
    assert.equal(JSON.stringify(redacted).includes(SECRET), false);
    assert.equal(JSON.stringify(redacted).includes(TMP), false);
    assert.throws(
        () => API_GATEWAY.restoreDelegatedOpenAiObject([], publicModel),
        /plain JSON object/i,
    );
}

async function waitForReady(port) {
    let last = null;
    for (let i = 0; i < 80; i += 1) {
        try { return await request(port, 'GET', '/openai/v1/models'); }
        catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 40)); }
    }
    throw last || new Error('front-door did not start');
}

(async () => {
    checkDelegatedProjectionContract();
    assert.equal(fs.existsSync(CANCELLATION_SCRIPT), true,
        'Phase 3 request-cancellation registry module must exist');
    const { createRequestCancellationRegistry } = require(CANCELLATION_SCRIPT);
    let now = 1000;
    let randomCalls = 0;
    const rawToken = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    const registry = createRequestCancellationRegistry({
        randomBytes(size) {
            assert.equal(size, 32);
            randomCalls += 1;
            const raw = Buffer.from(rawToken);
            if (randomCalls > 1) raw[31] = (raw[31] + randomCalls - 1) & 0xff;
            return raw;
        },
        now: () => now,
        maxEntries: 2,
        claimTtlMs: 50,
        hardTtlMs: 200,
        sweepIntervalMs: 0,
    });
    try {
        const first = registry.begin({
            publicModel: 'agentrouter/gpt-5.6-sol',
            provider: 'agentrouter',
            bareModel: 'gpt-5.6-sol',
            streamMode: false,
            safeIdentity: { userAgent: 'fixture' },
        });
        assert.equal(randomCalls, 1);
        assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
        assert.deepEqual(Buffer.from(first.token, 'base64url'), rawToken);
        assert.equal(first.handle.publicModel, 'agentrouter/gpt-5.6-sol');
        assert.equal(Object.values(first.handle).includes(first.token), false, 'handle never retains encoded token');
        assert.equal(JSON.stringify(first.handle).includes(first.token), false, 'registry handle never serializes token');
        assert.equal(registry.size(), 1);

        const claimed = registry.claim(first.token);
        assert.equal(claimed, first.handle, 'canonical live token claims its record once');
        assert.throws(() => registry.claim(first.token), /request_rejected/);
        assert.throws(() => registry.claim('0'.repeat(43)), /request_rejected/);
        assert.throws(() => registry.claim('a'.repeat(42)), /request_rejected/);
        assert.throws(() => registry.claim(`${first.token}= `), /request_rejected/);

        let aborts = 0;
        registry.cancel(claimed, 'race-before-bind');
        assert.equal(registry.isCancelled(claimed), true);
        assert.equal(registry.bindInnerAbort(claimed, () => { aborts += 1; }), 'already_cancelled');
        assert.equal(aborts, 1, 'cancel before bind invokes the bound abort exactly once');
        registry.cancel(claimed, 'again');
        assert.equal(aborts, 1, 'cancellation is idempotent');
        registry.finishOuter(claimed);
        assert.throws(() => registry.claim(first.token), /request_rejected/);
        assert.equal(registry.size(), 1,
            'replay of a cancelled claimed token must not finish a still-closing backend leg');
        registry.finishInner(claimed);
        assert.equal(registry.size(), 0, 'both terminal legs remove a claimed record');

        const pending = registry.begin({
            publicModel: 'agentrouter/vendor//nested', provider: 'agentrouter', bareModel: 'vendor//nested',
            streamMode: true, safeIdentity: {},
        });
        registry.cancel(pending.handle, 'outer-first');
        registry.finishOuter(pending.handle);
        assert.equal(registry.size(), 1, 'cancelled pending tombstone survives outer close until callback or expiry');
        now = 1300;
        registry.sweep(now);
        assert.equal(registry.size(), 0, 'hard expiry removes an unconsumed pending tombstone');

        now = 1400;
        const rejectedPending = registry.begin({
            publicModel: 'agentrouter/rejected', provider: 'agentrouter', bareModel: 'rejected',
            streamMode: false, safeIdentity: {},
        });
        registry.cancel(rejectedPending.handle, 'outer-first');
        assert.throws(() => registry.claim(rejectedPending.token), /request_rejected/,
            'delayed callback consumes the cancelled tombstone rejection');
        registry.finishOuter(rejectedPending.handle);
        assert.equal(registry.size(), 0, 'rejected delayed callback plus outer close clears the tombstone');

        now = 2000;
        const expired = registry.begin({
            publicModel: 'agentrouter/expired', provider: 'agentrouter', bareModel: 'expired',
            streamMode: false, safeIdentity: {},
        });
        now = 2051;
        assert.throws(() => registry.claim(expired.token), /request_rejected/, 'claim TTL is enforced');
        assert.equal(registry.size(), 0, 'expired unclaimed record is removed at claim');

        now = 3000;
        const capOne = registry.begin({
            publicModel: 'agentrouter/one', provider: 'agentrouter', bareModel: 'one', streamMode: false, safeIdentity: {},
        });
        const capTwo = registry.begin({
            publicModel: 'agentrouter/two', provider: 'agentrouter', bareModel: 'two', streamMode: false, safeIdentity: {},
        });
        assert.throws(() => registry.begin({
            publicModel: 'agentrouter/three', provider: 'agentrouter', bareModel: 'three', streamMode: false, safeIdentity: {},
        }), /api_gateway_busy/, 'live records are never evicted at capacity');
        registry.cancel(capOne.handle, 'cleanup');
        registry.cancel(capTwo.handle, 'cleanup');
        registry.close();
        assert.equal(registry.size(), 0);
    } finally {
        registry.close();
    }

    assert.deepEqual(
        API_GATEWAY.restoreDelegatedOpenAiObject({ id: 'x', model: 'private', choices: [] }, 'agentrouter/gpt-5.6-sol'),
        { id: 'x', model: 'agentrouter/gpt-5.6-sol', choices: [] },
    );
    const privateError = API_GATEWAY.restoreDelegatedOpenAiObject({
        model: 'private', error: { message: SECRET, extra_fields: { path: TMP } }, route: SECRET,
    }, 'agentrouter/gpt-5.6-sol', { status: 502 });
    assert.deepEqual(privateError, {
        error: { message: 'Upstream request failed.', type: 'api_error', code: 'upstream_unavailable' },
        model: 'agentrouter/gpt-5.6-sol',
    });
    assert.equal(JSON.stringify(privateError).includes(SECRET), false);

    const defaultManifestPath = path.join(TMP, 'routing', 'api-gateway.default.json');
    const manifestPath = path.join(TMP, 'routing', 'api-gateway.json');
    const backendsPath = path.join(TMP, '.claude', 'backends.json');
    const activePath = path.join(TMP, '.claude', 'active-backend.json');
    const settingsPath = path.join(TMP, '.claude', 'settings.json');
    const logPath = path.join(TMP, 'frontdoor.log');
    const usagePath = path.join(TMP, 'token-usage.jsonl');

    let upstreamHits = 0;
    let remoteNativeEncoding = 'identity';
    let postBodyResetGenerations = 0;
    let postBodyResetEnsureHits = 0;
    const backendCalls = [];
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            upstreamHits += 1;
            const raw = Buffer.concat(chunks).toString('utf8');
            let body = null;
            try { body = JSON.parse(raw); } catch { /* fixture reports raw below */ }
            backendCalls.push({ path: req.url, headers: { ...req.headers }, body, raw });
            const holdForDrain = body && body.messages && body.messages.some(message => {
                const content = message && message.content;
                return content === 'drain claimed fixture';
            });
            if (holdForDrain) {
                heldDrainBackendResponse = res;
                res.on('close', () => { heldDrainBackendClosed = true; });
                return;
            }
            const remoteNativeFixture = body && body.messages && body.messages.some(message => {
                const content = message && message.content;
                return content === 'remote native exact fixture';
            });
            if (remoteNativeFixture) {
                const nativeBody = Buffer.from(JSON.stringify({
                    id: 'msg_remote_native', type: 'message', role: 'assistant', model: 'private-native-model',
                    content: [{ type: 'text', text: 'safe' }], stop_reason: 'end_turn',
                    usage: { input_tokens: 1, output_tokens: 1 },
                }), 'utf8');
                if (remoteNativeEncoding === 'gzip') {
                    const compressed = zlib.gzipSync(nativeBody);
                    res.writeHead(200, {
                        'content-type': 'application/json',
                        'content-encoding': 'gzip',
                        'content-length': String(compressed.length),
                    });
                    res.end(compressed);
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(nativeBody.length) });
                res.end(nativeBody);
                return;
            }
            const nativeFixture = body && body.messages && body.messages.some(message => {
                const content = message && message.content;
                return content === 'native fixture';
            });
            if (nativeFixture) {
                const nativeStream = body && body.stream === true;
                if (nativeStream) {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.end(`event: message_start\ndata: ${JSON.stringify({
                        type: 'message_start',
                        message: { id: 'msg_native', type: 'message', role: 'assistant', model: 'private-native-model', content: [], usage: { input_tokens: 1, output_tokens: 0 } },
                    })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`);
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'msg_native', type: 'message', role: 'assistant', model: 'private-native-model',
                    content: [{ type: 'text', text: 'safe' }], stop_reason: 'end_turn',
                    usage: { input_tokens: 1, output_tokens: 1 },
                }));
                return;
            }
            if (body && body.stream === true) {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(`event: message_start\ndata: ${JSON.stringify({
                    type: 'message_start',
                    message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } },
                })}\n\n`);
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'safe' } })}\n\n`);
                res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } })}\n\n`);
                res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'msg_fixture', type: 'message', role: 'assistant', model: body && body.model,
                content: [{ type: 'text', text: 'safe' }], stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
            }));
        });
    });
    const upstreamPort = await listen(upstream);
    const postBodyResetBackend = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            postBodyResetGenerations += 1;
            req.socket.destroy();
        });
    });
    const postBodyResetPort = await listen(postBodyResetBackend);
    const lazyPort = await freePort();
    const lazyBackendCalls = [];
    const lazyBackend = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            lazyBackendCalls.push({
                body: JSON.parse(raw),
                headers: { ...req.headers },
            });
            const responseBody = Buffer.from(JSON.stringify({
                id: 'msg_lazy', type: 'message', role: 'assistant',
                model: 'private-lazy-model', content: [{ type: 'text', text: 'safe' }],
                stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
            }), 'utf8');
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(responseBody.length) });
            res.end(responseBody);
        });
    });
    let lazyListening = false;
    let ensureHits = 0;
    const dashboard = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', async () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            ensureHits += 1;
            assert.equal(req.method, 'POST');
            assert.equal(req.url, '/__switch/api/keepalive/ensure');
            if (body.port === postBodyResetPort) {
                postBodyResetEnsureHits += 1;
                const responseBody = Buffer.from(JSON.stringify({ ok: true, already: true }), 'utf8');
                res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(responseBody.length) });
                res.end(responseBody);
                return;
            }
            assert.equal(body.port, lazyPort);
            if (!lazyListening) {
                await new Promise((resolve, reject) => {
                    lazyBackend.once('error', reject);
                    lazyBackend.listen(lazyPort, '127.0.0.1', () => {
                        lazyBackend.removeListener('error', reject);
                        lazyListening = true;
                        resolve();
                    });
                });
            }
            const responseBody = Buffer.from(JSON.stringify({ ok: true, already: ensureHits > 1 }), 'utf8');
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(responseBody.length) });
            res.end(responseBody);
        });
    });
    const dashboardPort = await listen(dashboard);
    const bifrostBodies = [];
    const callbackResults = [];
    let sidecarMode = 'stream-success';
    let sidecarHits = 0;
    let heldCallbackResponse = null;
    let heldSidecarResponse = null;
    let heldDrainBackendResponse = null;
    let heldDrainBackendClosed = false;
    let capturedSidecar = null;
    let frontdoorPort = 0;
    const bifrost = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            sidecarHits += 1;
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            bifrostBodies.push({ body, headers: req.headers, path: req.url });
            if (sidecarMode === 'capture-only') {
                capturedSidecar = {
                    request: req,
                    response: res,
                    body,
                    token: req.headers['x-bf-eh-x-abuse-hub-request-token'],
                };
                return;
            }
            if (sidecarMode === 'preconnect-close') {
                req.socket.destroy();
                return;
            }
            if (sidecarMode === 'truncated-json') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.flushHeaders();
                res.write('{"id":"partial"');
                setTimeout(() => res.socket.destroy(), 10);
                return;
            }
            if (sidecarMode === 'nonstream-private-error') {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ detail: SECRET, local_path: TMP, error: null }));
                return;
            }
            if (sidecarMode === 'nonstream-2xx-error') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: SECRET }, route: SECRET }));
                return;
            }
            if (sidecarMode === 'stream-2xx-private-object') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ detail: SECRET, local_path: TMP, route: SECRET }));
                return;
            }
            if (sidecarMode === 'stream-ambiguous-content-type') {
                res.writeHead(200, { 'content-type': 'application/json, text/event-stream' });
                res.end(`${JSON.stringify({ detail: SECRET, local_path: TMP, route: SECRET })}\n`);
                return;
            }
            if (sidecarMode === 'nonstream-malformed') {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end('{');
                return;
            }
            if (sidecarMode === 'nonstream-array') {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify([SECRET]));
                return;
            }
            const publicModel = String(body.model || '').replace(/^abuse-hub\//, '');
            const callbackBody = Buffer.from(JSON.stringify({
                model: publicModel,
                max_tokens: 8,
                stream: body.stream === true,
                messages: [{ role: 'user', content: sidecarMode === 'drain-after-claim'
                    ? 'drain claimed fixture'
                    : 'fixture' }],
            }), 'utf8');
            const callback = http.request({
                hostname: '127.0.0.1',
                port: frontdoorPort,
                method: 'POST',
                path: '/v1/messages',
                headers: {
                    'content-type': 'application/json',
                    'content-length': String(callbackBody.length),
                    'x-abuse-hub-internal': 'frontdoor-fixture-marker',
                    'x-abuse-hub-request-token': req.headers['x-bf-eh-x-abuse-hub-request-token'],
                    authorization: `Bearer ${SECRET}`,
                    'x-route-final': 'hostile',
                    'x-bf-hostile': SECRET,
                },
            }, callbackResponse => {
                const callbackChunks = [];
                if (sidecarMode === 'drain-after-claim') {
                callbackResponse.resume();
                callbackResponse.on('end', () => callbackResults.push({ status: callbackResponse.statusCode, drain: true }));
                callbackResponse.on('aborted', () => callbackResults.push({ aborted: true, drain: true }));
                return;
            }
            callbackResponse.on('data', chunk => callbackChunks.push(chunk));
                if (sidecarMode === 'hold-after-claim') {
                    heldCallbackResponse = callbackResponse;
                    heldSidecarResponse = res;
                    callbackResponse.on('aborted', () => callbackResults.push({ aborted: true }));
                    callbackResponse.on('error', error => callbackResults.push({ error: error.code || error.message }));
                    callbackResponse.on('close', () => callbackResults.push({ closed: true }));
                    return;
                }
                callbackResponse.on('end', () => {
                    callbackResults.push({
                        status: callbackResponse.statusCode,
                        headers: callbackResponse.headers,
                        raw: Buffer.concat(callbackChunks).toString('utf8'),
                    });
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    const objects = [{
                        id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
                        choices: [{ index: 0, delta: { role: 'assistant', content: 'safe' }, finish_reason: null }],
                    }, {
                        id: 'chat_fixture', object: 'chat.completion.chunk', created: 1,
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                    }];
                    const wire = `${objects.map(object => `data: ${JSON.stringify(object)}\n\n`).join('')}data: [DONE]\n\n`;
                    for (const byte of Buffer.from(wire, 'utf8')) res.write(Buffer.from([byte]));
                    res.end();
                });
            });
            callback.on('error', error => {
                callbackResults.push({ error: error.code || error.message });
                if (!res.destroyed) res.destroy(error);
            });
            callback.end(callbackBody);
            if (sidecarMode === 'drain-after-claim') {
                const respondAfterClaim = () => {
                    if (!heldDrainBackendResponse) {
                        setTimeout(respondAfterClaim, 5);
                        return;
                    }
                    const responseBody = Buffer.from(JSON.stringify({
                        id: 'chat_drain', object: 'chat.completion', model: body.model,
                        choices: [{ index: 0, message: { role: 'assistant', content: 'sidecar returned early' }, finish_reason: 'stop' }],
                    }), 'utf8');
                    res.writeHead(200, {
                        'content-type': 'application/json',
                        'content-length': String(responseBody.length),
                    });
                    res.end(responseBody);
                };
                respondAfterClaim();
            }
        });
    });
    const bifrostPort = await listen(bifrost);
    frontdoorPort = await freePort();

    writeJson(defaultManifestPath, SEED);
    writeJson(backendsPath, {
        version: 1,
        providers: {
            agentrouter: {
                backend: 'agentrouter',
                upstream: `http://127.0.0.1:${upstreamPort}`,
                modelmap: null,
                fixtureSecret: SECRET,
            },
        },
        aliases: { ar: 'agentrouter' },
    });
    fs.rmSync(settingsPath, { force: true });

    const child = spawn(process.execPath, [SCRIPT], {
        cwd: path.dirname(SCRIPT),
        env: {
            ...process.env,
            PORT: String(frontdoorPort),
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(TMP, 'abuse-hub-local-hop.key'),
            HOME: TMP,
            USERPROFILE: TMP,
            ACTIVE_BACKEND_FILE: activePath,
            BACKENDS_FILE: backendsPath,
            API_GATEWAY_DEFAULT_FILE: defaultManifestPath,
            API_GATEWAY_FILE: manifestPath,
            CLAUDE_SETTINGS_FILE: settingsPath,
            LOG_FILE: logPath,
            TOKEN_USAGE_FILE: usagePath,
            SWITCH_PORT: String(dashboardPort),
            BIFROST_URL: `http://127.0.0.1:${bifrostPort}`,
            BIFROST_INTERNAL_MARKER: 'frontdoor-fixture-marker',
            MULTI_MAP_FILE: path.join(TMP, 'multi-routes-modelmap.json'),
            DRAIN_MAX_MS: '250',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

    try {
        const listed = await waitForReady(frontdoorPort);
        assert.equal(listed.status, 200, `models without active state: ${listed.status} ${listed.raw} ${stderr.slice(-500)}`);
        assert.deepEqual(listed.json, {
            object: 'list',
            data: [{
                id: 'agentrouter/gpt-5.6-sol',
                object: 'model',
                created: 1794182400,
                owned_by: 'abuse-hub',
            }],
        });
        assert.match(String(listed.headers['content-type']), /^application\/json/);
        assert.equal(Number(listed.headers['content-length']), Buffer.byteLength(listed.raw));
        assert.equal(fs.existsSync(manifestPath), true, 'first models read seeds local state');

        const queried = await request(frontdoorPort, 'GET', '/openai/v1/models?source=picker');
        assert.equal(queried.status, 200);
        assert.equal(queried.raw, listed.raw, 'query string does not change model list');
        for (const forbidden of [SECRET, TMP, String(upstreamPort), settingsPath, backendsPath]) {
            assert.equal(listed.raw.includes(forbidden), false, `models response leaked ${forbidden}`);
        }

        writeJson(manifestPath, SEED);
        const nativeBody = {
            model: 'agentrouter/gpt-5.6-sol',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'native fixture' }],
        };
        const spoofedInternal = await request(
            frontdoorPort,
            'POST',
            '/v1/messages',
            nativeBody,
            { 'x-abuse-hub-internal': 'frontdoor-fixture-marker' },
        );
        assert.equal(spoofedInternal.status, 403);
        assert.equal(spoofedInternal.json && spoofedInternal.json.error && spoofedInternal.json.error.type, 'permission_error');
        assert.equal(upstreamHits, 0, 'spoofed internal marker must fail before backend routing');

        for (const headers of [
            { 'x-abuse-hub-request-token': 'a'.repeat(43) },
            { 'x-abuse-hub-correlation': 'a'.repeat(43) },
            { 'x-abuse-hub-request-id': 'a'.repeat(43) },
        ]) {
            const rejected = await request(frontdoorPort, 'POST', '/v1/messages', nativeBody, headers);
            assert.equal(rejected.status, 403, 'internal carrier aliases and token-only callbacks fail closed');
            assert.equal(rejected.json && rejected.json.error && rejected.json.error.type, 'permission_error');
        }
        assert.equal(upstreamHits, 0, 'callback authentication failures do no backend work');

        const nativeClaude = await request(frontdoorPort, 'POST', '/v1/messages?beta=true', nativeBody, {
            'x-route-final': 'hostile',
            'x-route-exact': 'hostile',
            'x-route-prefixed': 'hostile',
            'x-route-tier': 'hostile',
            'x-abuse-hub-hostile': SECRET,
            'x-bf-hostile': SECRET,
        });
        assert.equal(nativeClaude.status, 200, 'unmarked native Claude canonical request remains compatible');
        assert.equal(nativeClaude.json.model, 'agentrouter/gpt-5.6-sol',
            'direct canonical JSON response restores the immutable full public ID');
        assert.equal(upstreamHits, 1, 'unmarked native Claude request still reaches its selected backend');
        assert.equal(backendCalls[0].body.model, 'gpt-5.6-sol', 'direct canonical Claude strips one provider prefix');
        assert.equal(backendCalls[0].headers['x-route-final'], '1', 'direct canonical Claude is final');
        assert.equal(backendCalls[0].headers['x-route-exact'], '1', 'direct canonical Claude is exact');
        for (const name of ['x-route-prefixed', 'x-route-tier', 'x-abuse-hub-hostile', 'x-bf-hostile']) {
            assert.equal(backendCalls[0].headers[name], undefined, `${name} is stripped from direct canonical Claude`);
        }
        const nativeStream = await request(frontdoorPort, 'POST', '/v1/messages', {
            ...nativeBody,
            stream: true,
        });
        assert.equal(nativeStream.status, 200, nativeStream.raw);
        const nativeData = nativeStream.raw.split(/\r?\n/)
            .filter(line => line.startsWith('data:') && line.includes('message_start'))
            .map(line => JSON.parse(line.slice(5).trim()));
        assert.equal(nativeData.length, 1);
        assert.equal(nativeData[0].message.model, 'agentrouter/gpt-5.6-sol',
            'direct canonical SSE response restores the immutable full public ID');

        const invalidCases = [
            [{ model: 'agentrouter/gpt-5.6-sol', messages: [], stream: 'true' }, 400],
            [{ model: 'agentrouter/gpt-5.6-sol', messages: [], n: 2 }, 400],
            [{ model: 'agentrouter/gpt-5.6-sol', messages: [], best_of: 1.0, fallbacks: [] }, 400],
            [{ model: 'ar/gpt-5.6-sol', messages: [] }, 404],
            [{ model: 'AgentRouter/gpt-5.6-sol', messages: [] }, 404],
            [{ model: 'unknown/gpt-5.6-sol', messages: [] }, 404],
            [{ model: 'agentrouter/', messages: [] }, 400],
            [{ model: ' agentrouter/gpt-5.6-sol', messages: [] }, 400],
        ];
        for (const [body, status] of invalidCases) {
            const rejected = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', body);
            assert.equal(rejected.status, status, `strict ingress rejects ${JSON.stringify(body)}`);
        }
        const invalidJson = await request(
            frontdoorPort,
            'POST',
            '/openai/v1/chat/completions',
            Buffer.from('{', 'utf8'),
        );
        assert.equal(invalidJson.status, 400);
        assert.equal(bifrostBodies.length, 0, 'invalid public requests fail before sidecar contact');

        const forbiddenControlHeaders = {
            'x-route-final': '1',
            'x-abuse-hub-internal': 'spoof',
            'x-bf-hostile': SECRET,
        };
        for (const [name, value] of Object.entries(forbiddenControlHeaders)) {
            const rejected = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
                model: 'agentrouter/gpt-5.6-sol', messages: [], stream: false,
            }, { [name]: value });
            assert.equal(rejected.status, 400, `public control header ${name} rejected`);
        }
        assert.equal(bifrostBodies.length, 0, 'rejected public control headers never reach Bifrost');

        const usageRowsBeforeDelegated = fs.readFileSync(usagePath, 'utf8').trim().split('\n').filter(Boolean).length;
        const publicModel = 'agentrouter/vendor//nested';
        const delegated = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
            model: publicModel,
            messages: [{ role: 'user', content: 'fixture' }],
            stream: true,
            n: 1,
            best_of: 1,
        }, {
            authorization: `Bearer ${SECRET}`,
            'x-api-key': SECRET,
            cookie: `session=${SECRET}`,
            'proxy-authorization': `Basic ${SECRET}`,
            'user-agent': 'opencode-fixture',
            'x-request-id': 'outer-request',
            'x-session-id': 'outer-session',
        });
        assert.equal(delegated.status, 200, delegated.raw);
        assert.equal(callbackResults.length, 1, 'valid delegation produces one authenticated callback');
        assert.equal(callbackResults[0].status, 200, callbackResults[0].raw || callbackResults[0].error);
        assert.equal(backendCalls.length, 3, 'two native fixtures plus authenticated callback create exactly three backend requests');
        const internalCall = backendCalls[2];
        assert.equal(internalCall.path, '/v1/messages');
        assert.equal(internalCall.body.model, 'vendor//nested');
        assert.equal(internalCall.headers['x-route-final'], '1');
        assert.equal(internalCall.headers['x-route-exact'], '1');
        for (const name of [
            'authorization', 'x-api-key', 'cookie', 'proxy-authorization',
            'x-abuse-hub-internal', 'x-abuse-hub-request-token', 'x-bf-hostile',
        ]) {
            assert.equal(internalCall.headers[name], undefined, `${name} is stripped from the backend leg`);
        }
        assert.equal(bifrostBodies.length, 1, 'valid call creates exactly one outer sidecar request');
        assert.equal(callbackResults.length, 1, 'Bifrost makes exactly one authenticated callback');
        assert.equal(callbackResults[0].status, 200, callbackResults[0].raw || callbackResults[0].error);
        assert.equal(backendCalls.length, 3, 'two native fixtures plus one paid delegated generation reached backend');
        const delegatedBackend = backendCalls[2];
        assert.equal(delegatedBackend.path, '/v1/messages');
        assert.equal(delegatedBackend.body.model, 'vendor//nested', 'callback strips exactly the canonical provider prefix');
        assert.equal(delegatedBackend.headers['x-route-final'], '1');
        assert.equal(delegatedBackend.headers['x-route-exact'], '1');
        assert.equal(delegatedBackend.headers['user-agent'], undefined,
            'delegated local backend does not inherit the external client UA; keepalive supplies its vendor-safe UA');
        assert.equal(delegatedBackend.headers['x-request-id'], 'outer-request');
        assert.equal(delegatedBackend.headers['x-session-id'], 'outer-session');
        for (const name of [
            'authorization', 'x-api-key', 'cookie', 'proxy-authorization',
            'x-abuse-hub-internal', 'x-abuse-hub-request-token', 'x-bf-hostile',
        ]) {
            assert.equal(delegatedBackend.headers[name], undefined, `${name} is stripped from the backend leg`);
        }
        const outer = bifrostBodies[0];
        assert.equal(outer.path, '/v1/chat/completions');
        assert.equal(outer.body.model, `abuse-hub/${publicModel}`);
        assert.equal(outer.body.stream, true);
        // OpenAI делает max_tokens необязательным, и клиенты (Hermes) его не шлют. Bifrost с
        // reasoning отвергает такой запрос 400 ещё до модели, поэтому шлюз подставляет лимит
        // опубликованной модели - иначе весь turn клиента падает на пустом месте.
        assert.equal(outer.body.max_tokens, 32000,
            'вывод опубликованной модели подставляется, когда клиент не прислал max_tokens');
        assert.match(String(outer.headers['x-bf-eh-x-abuse-hub-request-token'] || ''), /^[A-Za-z0-9_-]{43}$/);
        for (const name of ['authorization', 'x-api-key', 'cookie', 'proxy-authorization', 'x-route-final', 'x-route-exact', 'x-abuse-hub-internal']) {
            assert.equal(outer.headers[name], undefined, `${name} is stripped from the sidecar leg`);
        }
        assert.equal(outer.headers['accept-encoding'], 'identity');
        assert.equal(Number(outer.headers['content-length']), Buffer.byteLength(JSON.stringify(outer.body)));
        const delegatedLines = delegated.raw.split(/\r?\n/).filter(line => line.startsWith('data:') && line.trim() !== 'data: [DONE]');
        assert.ok(delegatedLines.length >= 2);
        for (const line of delegatedLines) {
            const object = JSON.parse(line.slice(5).trim());
            assert.equal(object.model, publicModel, 'every public SSE object restores immutable outer model');
        }
        assert.equal((delegated.raw.match(/data: \[DONE\]/g) || []).length, 1, 'real DONE passes exactly once');
        const delegatedUsageRows = fs.readFileSync(usagePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        assert.equal(delegatedUsageRows.length, usageRowsBeforeDelegated + 1,
            'one delegated generation creates exactly one internal usage row and no outer duplicate');
        assert.equal(delegatedUsageRows.at(-1).m, 'vendor//nested');
        assert.equal(delegatedUsageRows.at(-1).h, 'opencode');

        const remoteKeyPath = path.join(TMP, '.claude', 'remote-active-key.txt');
        const remoteMapPath = path.join(TMP, 'routing', 'remote-modelmap.json');
        fs.writeFileSync(remoteKeyPath, 'configured-remote-key\n', 'utf8');
        writeJson(remoteMapPath, { opus: 'wrong-mapped-model', sonnet: '', haiku: '' });
        writeJson(backendsPath, {
            version: 1,
            providers: {
                agentrouter: {
                    backend: 'agentrouter',
                    upstream: `http://[::ffff:127.0.0.1]:${upstreamPort}`,
                    keyFile: 'remote-active-key.txt',
                    modelmap: remoteMapPath,
                    fixtureSecret: SECRET,
                },
            },
            aliases: { ar: 'agentrouter' },
        });
        const remoteNativeStart = backendCalls.length;
        remoteNativeEncoding = 'gzip';
        const remoteNative = await request(frontdoorPort, 'POST', '/v1/messages', {
            model: 'agentrouter/claude-opus-5[1m]',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'remote native exact fixture' }],
        }, {
            authorization: `Bearer ${SECRET}`,
            'x-api-key': SECRET,
            cookie: `session=${SECRET}`,
            'proxy-authorization': `Basic ${SECRET}`,
            'accept-encoding': 'gzip',
            'anthropic-version': '2023-06-01',
            'x-private-random': SECRET,
            'x-route-final': 'hostile',
            'x-route-exact': 'hostile',
            'x-route-hostile': SECRET,
            'x-abuse-hub-hostile': SECRET,
            'x-bf-hostile': SECRET,
        });
        assert.equal(remoteNative.status, 200, remoteNative.raw);
        assert.equal(remoteNative.json && remoteNative.json.id, 'msg_remote_native');
        assert.deepEqual(remoteNative.json && remoteNative.json.content, [{ type: 'text', text: 'safe' }]);
        assert.deepEqual(remoteNative.json && remoteNative.json.usage, { input_tokens: 1, output_tokens: 1 });
        assert.equal(remoteNative.json && remoteNative.json.model, 'agentrouter/claude-opus-5[1m]',
            'direct canonical gzip JSON response restores the immutable full public ID');
        assert.equal(remoteNative.headers['content-encoding'], undefined,
            'rewritten canonical JSON response is reframed as identity');
        assert.equal(backendCalls.length, remoteNativeStart + 1, 'direct remote canonical creates one request');
        const remoteNativeCall = backendCalls.at(-1);
        assert.equal(remoteNativeCall.body.model, 'claude-opus-5[1m]',
            'direct remote canonical bypasses tier mapping and suffix stripping');
        assert.equal(remoteNativeCall.headers.authorization, 'Bearer configured-remote-key');
        assert.equal(remoteNativeCall.headers['x-api-key'], 'configured-remote-key');
        assert.equal(remoteNativeCall.headers['accept-encoding'], 'identity');
        assert.equal(remoteNativeCall.headers['anthropic-version'], '2023-06-01');
        for (const name of [
            'cookie', 'proxy-authorization', 'x-private-random', 'x-route-final', 'x-route-exact', 'x-route-hostile',
            'x-abuse-hub-hostile', 'x-bf-hostile',
        ]) {
            assert.equal(remoteNativeCall.headers[name], undefined, `${name} never reaches a direct remote vendor`);
        }

        const remoteDelegatedStart = backendCalls.length;
        const remoteDelegated = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
            model: 'agentrouter/claude-opus-5[1m]',
            messages: [{ role: 'user', content: 'remote delegated exact fixture' }],
            stream: true,
        }, {
            authorization: `Bearer ${SECRET}`,
            'x-api-key': SECRET,
            cookie: `session=${SECRET}`,
        });
        assert.equal(remoteDelegated.status, 200, remoteDelegated.raw);
        assert.equal(backendCalls.length, remoteDelegatedStart + 1, 'delegated remote canonical creates one request');
        const remoteDelegatedCall = backendCalls.at(-1);
        assert.equal(remoteDelegatedCall.body.model, 'claude-opus-5[1m]',
            'delegated remote canonical preserves the exact bare model');
        assert.equal(remoteDelegatedCall.headers.authorization, 'Bearer configured-remote-key');
        assert.equal(remoteDelegatedCall.headers['x-api-key'], 'configured-remote-key');
        for (const name of [
            'x-route-final', 'x-route-exact', 'x-abuse-hub-internal',
            'x-abuse-hub-request-token', 'x-bf-hostile', 'cookie', 'proxy-authorization',
        ]) {
            assert.equal(remoteDelegatedCall.headers[name], undefined, `${name} never reaches a delegated remote vendor`);
        }

        writeJson(backendsPath, {
            version: 1,
            providers: {
                agentrouter: {
                    backend: 'agentrouter',
                    upstream: `http://127.0.0.1:${postBodyResetPort}`,
                    modelmap: null,
                },
            },
            aliases: { ar: 'agentrouter' },
        });
        const postBodyReset = await request(frontdoorPort, 'POST', '/v1/messages', {
            model: 'agentrouter/post-body-reset',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'post-body reset fixture' }],
        });
        assert.equal(postBodyReset.status, 502, postBodyReset.raw);
        assert.equal(postBodyResetGenerations, 1,
            'direct canonical request is never replayed after the local backend accepted its body');
        assert.equal(postBodyResetEnsureHits, 0,
            'post-connect ECONNRESET must not trigger lazy keepalive ensure');

        writeJson(backendsPath, {
            version: 1,
            providers: {
                agentrouter: {
                    backend: 'agentrouter',
                    upstream: `http://127.0.0.1:${lazyPort}`,
                    modelmap: null,
                },
            },
            aliases: { ar: 'agentrouter' },
        });
        const lazyNative = await request(frontdoorPort, 'POST', '/v1/messages', {
            model: 'agentrouter/vendor/direct-lazy-exact[1m]',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'direct lazy local exact fixture' }],
        });
        assert.equal(lazyNative.status, 200, lazyNative.raw);
        assert.equal(lazyNative.json && lazyNative.json.model, 'agentrouter/vendor/direct-lazy-exact[1m]');
        assert.equal(ensureHits, 1, 'a proven direct pre-connect failure ensures the local keepalive once');
        assert.equal(lazyBackendCalls.length, 1, 'direct lazy retry creates one accepted backend generation');
        assert.equal(lazyBackendCalls[0].body.model, 'vendor/direct-lazy-exact[1m]');
        assert.equal(lazyBackendCalls[0].headers['x-route-final'], '1');
        assert.equal(lazyBackendCalls[0].headers['x-route-exact'], '1');

        const lazyDelegated = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
            model: 'agentrouter/vendor/lazy-exact[1m]',
            messages: [{ role: 'user', content: 'lazy local exact fixture' }],
            stream: true,
        });
        assert.equal(lazyDelegated.status, 200, lazyDelegated.raw);
        assert.equal(ensureHits, 1, 'the live local keepalive is not ensured again');
        assert.equal(lazyBackendCalls.length, 2, 'delegated exact path adds one accepted generation');
        assert.equal(lazyBackendCalls[1].body.model, 'vendor/lazy-exact[1m]');
        assert.equal(lazyBackendCalls[1].headers['x-route-final'], '1');
        assert.equal(lazyBackendCalls[1].headers['x-route-exact'], '1');

        writeJson(backendsPath, {
            version: 1,
            providers: {
                agentrouter: {
                    backend: 'agentrouter',
                    upstream: `http://127.0.0.1:${upstreamPort}`,
                    modelmap: null,
                },
            },
            aliases: { ar: 'agentrouter' },
        });
        const gatewayStatus = () => request(frontdoorPort, 'GET', '/__frontdoor/api/status');
        const matrixBackendBaseline = upstreamHits + lazyBackendCalls.length;
        const captureOuter = async (publicModel, stream = false) => {
            sidecarMode = 'capture-only';
            capturedSidecar = null;
            const publicResult = request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
                model: publicModel,
                messages: [{ role: 'user', content: 'callback matrix fixture' }],
                stream,
            }).catch(error => error);
            await waitUntil(() => capturedSidecar !== null, 2000, 'sidecar request was not captured');
            const capture = { ...capturedSidecar, publicResult };
            capturedSidecar = null;
            return capture;
        };
        const closeCapturedOuter = async capture => {
            const responseBody = Buffer.from(JSON.stringify({ error: { message: SECRET } }), 'utf8');
            capture.response.writeHead(500, {
                'content-type': 'application/json',
                'content-length': String(responseBody.length),
            });
            capture.response.end(responseBody);
            const result = await capture.publicResult;
            assert.equal(result.status, 503, result.raw);
            assert.equal(result.raw.includes(SECRET), false);
        };
        const marker = 'frontdoor-fixture-marker';
        const matrixModel = 'agentrouter/callback-matrix';
        const matrixBody = {
            model: matrixModel,
            max_tokens: 8,
            stream: false,
            messages: [{ role: 'user', content: 'callback matrix fixture' }],
        };
        const envelopeCapture = await captureOuter(matrixModel, false);
        const callbackHeaders = {
            'x-abuse-hub-internal': marker,
            'x-abuse-hub-request-token': envelopeCapture.token,
        };
        const rawCallback = (extraLines, body = matrixBody, requestLine = 'POST /v1/messages HTTP/1.1') => {
            const payload = JSON.stringify(body);
            return rawHttpRequest(frontdoorPort,
                `${requestLine}\r\nHost: 127.0.0.1:${frontdoorPort}\r\nConnection: close\r\n`
                + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`
                + `${extraLines.join('\r\n')}\r\n\r\n${payload}`);
        };
        for (const duplicate of [
            [`x-abuse-hub-internal: ${marker}`, `x-abuse-hub-internal: ${marker}`,
                `x-abuse-hub-request-token: ${envelopeCapture.token}`],
            [`x-abuse-hub-internal: ${marker}`, `x-abuse-hub-request-token: ${envelopeCapture.token}`,
                `x-abuse-hub-request-token: ${envelopeCapture.token}`],
        ]) {
            const rejected = await rawCallback(duplicate);
            assert.equal(rejected.status, 403, 'duplicate raw callback headers fail closed');
        }
        for (const headers of [
            { ...callbackHeaders, 'x-abuse-hub-internal': `${marker},${marker}` },
            { ...callbackHeaders, 'x-abuse-hub-request-token': `${envelopeCapture.token},${envelopeCapture.token}` },
        ]) {
            const rejected = await requestWithOptions(frontdoorPort, { body: matrixBody, headers });
            assert.equal(rejected.status, 403, 'comma-joined callback headers fail closed');
        }
        for (const options of [
            { method: 'PUT', urlPath: '/v1/messages', body: matrixBody, headers: callbackHeaders },
            { method: 'POST', urlPath: '/v1/other', body: matrixBody, headers: callbackHeaders },
            { method: 'POST', urlPath: '/v1/messages?query=1', body: matrixBody, headers: callbackHeaders },
            { method: 'POST', urlPath: '/v1/messages', body: matrixBody,
                headers: { ...callbackHeaders, 'x-abuse-hub-internal': 'wrong-marker' } },
            { method: 'POST', urlPath: '/v1/messages', body: matrixBody, headers: callbackHeaders,
                localAddress: '127.0.0.2' },
        ]) {
            const rejected = await requestWithOptions(frontdoorPort, options);
            assert.equal(rejected.status, 403, 'wrong callback envelope fails closed');
            assert.equal(rejected.json && rejected.json.error && rejected.json.error.type, 'permission_error');
        }
        assert.equal(upstreamHits + lazyBackendCalls.length, matrixBackendBaseline,
            'callback envelope failures perform no backend work');
        const modelMismatch = await requestWithOptions(frontdoorPort, {
            body: { ...matrixBody, model: 'agentrouter/wrong-model' },
            headers: callbackHeaders,
        });
        assert.equal(modelMismatch.status, 403, 'callback model mismatch consumes and rejects the claim');
        assert.equal(upstreamHits + lazyBackendCalls.length, matrixBackendBaseline,
            'callback model mismatch performs no backend work');
        await closeCapturedOuter(envelopeCapture);

        const streamCapture = await captureOuter('agentrouter/callback-stream-matrix', false);
        const streamMismatch = await requestWithOptions(frontdoorPort, {
            body: {
                ...matrixBody,
                model: 'agentrouter/callback-stream-matrix',
                stream: true,
            },
            headers: {
                'x-abuse-hub-internal': marker,
                'x-abuse-hub-request-token': streamCapture.token,
            },
        });
        assert.equal(streamMismatch.status, 403, 'callback stream mismatch consumes and rejects the claim');
        assert.equal(upstreamHits + lazyBackendCalls.length, matrixBackendBaseline,
            'callback stream mismatch performs no backend work');
        await closeCapturedOuter(streamCapture);
        await waitUntil(async () => (await gatewayStatus()).json.api_gateway_inflight === 0,
            2000, 'callback negative matrix records did not drain');
        await new Promise(resolve => {
            bifrost.close(resolve);
            bifrost.closeAllConnections();
        });
        const preconnectDown = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
            model: 'agentrouter/preconnect-failure', messages: [], stream: false,
        });
        assert.equal(preconnectDown.status, 503);
        assert.equal((await gatewayStatus()).json.api_gateway_inflight, 0,
            'proven sidecar pre-connect failure removes both nonexistent legs');
        await new Promise((resolve, reject) => {
            bifrost.once('error', reject);
            bifrost.listen(bifrostPort, '127.0.0.1', () => {
                bifrost.removeListener('error', reject);
                resolve();
            });
        });

        sidecarMode = 'truncated-json';
        const truncated = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
            model: 'agentrouter/truncated-sidecar', messages: [], stream: false,
        });
        assert.equal(truncated.status, 503, truncated.raw);
        assert.equal(errorCode(truncated), 'upstream_unavailable');
        assert.equal(truncated.raw.includes(SECRET), false);
        assert.equal((await request(frontdoorPort, 'GET', '/openai/v1/models')).status, 200,
            'frontdoor remains healthy after sidecar truncation');

        sidecarMode = 'nonstream-2xx-error';
        const streamedJsonError = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
            model: 'agentrouter/stream-json-error', messages: [], stream: true,
        });
        assert.equal(streamedJsonError.status, 503, streamedJsonError.raw);
        assert.equal(errorCode(streamedJsonError), 'upstream_unavailable');
        assert.match(String(streamedJsonError.headers['content-type']), /^application\/json/);
        assert.equal(streamedJsonError.raw.includes(SECRET), false,
            'stream request must redact a 2xx JSON sidecar error before public headers');
        assert.equal(streamedJsonError.raw.includes(TMP), false,
            'stream request must not expose private sidecar paths');

        sidecarMode = 'stream-ambiguous-content-type';
        const ambiguousContentType = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
            model: 'agentrouter/stream-ambiguous-content-type', messages: [], stream: true,
        });
        assert.equal(ambiguousContentType.status, 503, ambiguousContentType.raw);
        assert.equal(errorCode(ambiguousContentType), 'upstream_unavailable');
        assert.match(String(ambiguousContentType.headers['content-type']), /^application\/json/);
        assert.equal(ambiguousContentType.raw.includes(SECRET), false,
            'ambiguous Content-Type must not enter the public SSE path');
        assert.equal(ambiguousContentType.raw.includes(TMP), false,
            'ambiguous Content-Type must not expose private sidecar paths');

        sidecarMode = 'stream-2xx-private-object';
        const streamedPrivateObject = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
            model: 'agentrouter/stream-private-object', messages: [], stream: true,
        });
        assert.equal(streamedPrivateObject.status, 503, streamedPrivateObject.raw);
        assert.equal(errorCode(streamedPrivateObject), 'upstream_unavailable');
        assert.match(String(streamedPrivateObject.headers['content-type']), /^application\/json/);
        assert.equal(streamedPrivateObject.raw.includes(SECRET), false,
            'stream request must not expose an unexpected 2xx JSON private object');
        assert.equal(streamedPrivateObject.raw.includes(TMP), false,
            'stream request must redact private sidecar paths');

        for (const [mode, expectedStatus, expectedCode] of [
            ['nonstream-private-error', 503, 'upstream_unavailable'],
            ['nonstream-2xx-error', 503, 'upstream_unavailable'],
            ['nonstream-malformed', 503, 'upstream_unavailable'],
            ['nonstream-array', 404, 'model_not_found'],
        ]) {
            sidecarMode = mode;
            const redacted = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
                model: 'agentrouter/redaction-fixture', messages: [], stream: false,
            });
            assert.equal(redacted.status, expectedStatus, `${mode}: ${redacted.raw}`);
            assert.equal(errorCode(redacted), expectedCode, mode);
            assert.equal(redacted.json.model, 'agentrouter/redaction-fixture');
            assert.equal(redacted.raw.includes(SECRET), false, `${mode} must redact private body fields`);
            assert.equal(redacted.raw.includes(TMP), false, `${mode} must redact private local paths`);
        }

        const tombstoneBaseline = (await gatewayStatus()).json.api_gateway_inflight;
        sidecarMode = 'hold-after-claim';
        const heldPublic = request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
            model: 'agentrouter/claimed-sidecar-failure', messages: [], stream: true,
        }).catch(error => error);
        await waitUntil(() => heldCallbackResponse !== null, 2000, 'claimed callback did not arrive');
        assert.equal(upstreamHits >= 5, true, 'claimed callback reached the backend before sidecar failure');
        heldSidecarResponse.socket.destroy();
        await waitUntil(() => callbackResults.some(result => result.aborted || result.closed || result.error),
            2000, 'claimed callback backend was not cancelled after sidecar failure');
        const heldResult = await heldPublic;
        assert.ok(heldResult instanceof Error || heldResult.status === 503,
            'sidecar midflight failure aborts or redacts the public response');
        await waitUntil(async () => {
            const status = await gatewayStatus();
            return status.json.api_gateway_inflight === tombstoneBaseline;
        }, 2000, 'claimed registry work did not drain after sidecar failure');

        sidecarMode = 'stream-success';
        const hidden = { ...SEED, revision: 2, models: {} };
        writeJson(manifestPath, hidden);
        const hiddenList = await request(frontdoorPort, 'GET', '/openai/v1/models');
        assert.equal(hiddenList.status, 200);
        assert.deepEqual(hiddenList.json, { object: 'list', data: [] });
        assert.deepEqual(
            API_GATEWAY.recognizeCallableModel('agentrouter/vendor//family/model', { backendsPath }),
            { id: 'agentrouter/vendor//family/model', provider: 'agentrouter', model: 'vendor//family/model' },
        );
        expectGatewayCode(
            () => API_GATEWAY.recognizeCallableModel('ar/vendor/model', { backendsPath }),
            'api_gateway_unknown_provider',
        );
        expectGatewayCode(
            () => API_GATEWAY.recognizeCallableModel('unknown/vendor/model', { backendsPath }),
            'api_gateway_unknown_provider',
        );
        expectGatewayCode(
            () => API_GATEWAY.recognizeCallableModel('agentrouter/', { backendsPath }),
            'api_gateway_invalid_model',
        );

        writeJson(manifestPath, { ...SEED, revision: 3, enabled: false });
        const disabled = await request(frontdoorPort, 'GET', '/openai/v1/models');
        assert.equal(disabled.status, 503);
        assert.equal(errorCode(disabled), 'api_gateway_disabled');
        const disabledSidecarHits = sidecarHits;
        const disabledBackendHits = upstreamHits + lazyBackendCalls.length;
        const disabledRegistrySize = (await gatewayStatus()).json.api_gateway_inflight;
        const disabledPost = await request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
            model: 'agentrouter/hidden-still-known', messages: [], stream: false,
        });
        assert.equal(disabledPost.status, 503);
        assert.equal(errorCode(disabledPost), 'api_gateway_disabled');
        assert.equal(sidecarHits, disabledSidecarHits, 'disabled POST fails before sidecar contact');
        assert.equal(upstreamHits + lazyBackendCalls.length, disabledBackendHits,
            'disabled POST fails before backend work');
        assert.equal((await gatewayStatus()).json.api_gateway_inflight, disabledRegistrySize,
            'disabled POST fails before token mint');

        const corrupt = Buffer.from(`{"${SECRET}":`, 'utf8');
        fs.writeFileSync(manifestPath, corrupt);
        const unavailable = await request(frontdoorPort, 'GET', '/openai/v1/models');
        assert.equal(unavailable.status, 503);
        assert.equal(errorCode(unavailable), 'api_gateway_unavailable');
        assert.deepEqual(fs.readFileSync(manifestPath), corrupt, 'corrupt owner state is not reseeded');
        assert.equal(unavailable.raw.includes(SECRET), false);
        assert.equal(unavailable.raw.includes(TMP), false);

        const recoveryManifestBefore = Buffer.from(JSON.stringify(SEED, null, 2) + '\n', 'utf8');
        const recoverySettingsBefore = Buffer.from(JSON.stringify({ model: SECRET }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(manifestPath, recoveryManifestBefore);
        fs.writeFileSync(settingsPath, recoverySettingsBefore);
        const crashScript = `
          const lib = require(${JSON.stringify(path.join(ROOT, 'routing', 'lib', 'api-gateway.js'))});
          lib.saveManifestAndPicker({
            manifestPath: ${JSON.stringify(manifestPath)},
            backendsPath: ${JSON.stringify(backendsPath)},
            settingsPath: ${JSON.stringify(settingsPath)},
            expectedRevision: 1,
            draft: ${JSON.stringify({ enabled: true, models: {} })},
            onStep(step) { if (step === 'afterManifestCommit') process.exit(47); },
          });
        `;
        const crashed = spawnSync(process.execPath, ['-e', crashScript], { encoding: 'utf8' });
        assert.equal(crashed.status, 47, crashed.stderr);
        assert.notDeepEqual(fs.readFileSync(manifestPath), recoveryManifestBefore);
        const recoveredList = await request(frontdoorPort, 'GET', '/openai/v1/models');
        assert.equal(recoveredList.status, 200, `models startup recovery: ${recoveredList.raw}`);
        assert.deepEqual(recoveredList.json, {
            object: 'list',
            data: [{
                id: 'agentrouter/gpt-5.6-sol', object: 'model', created: 1794182400, owned_by: 'abuse-hub',
            }],
        });
        assert.deepEqual(fs.readFileSync(manifestPath), recoveryManifestBefore);
        assert.deepEqual(fs.readFileSync(settingsPath), recoverySettingsBefore);

        fs.writeFileSync(`${manifestPath}.lock`, String(process.pid), 'utf8');
        const busyList = await request(frontdoorPort, 'GET', '/openai/v1/models');
        assert.equal(busyList.status, 503, 'models must not read through a live publication writer lock');
        assert.equal(errorCode(busyList), 'api_gateway_unavailable');
        fs.unlinkSync(`${manifestPath}.lock`);

        const unsupported = [
            await request(frontdoorPort, 'GET', '/openai/v1/unknown'),
            await request(frontdoorPort, 'POST', '/openai/v1/models', {}),
        ];
        for (const response of unsupported) {
            assert.equal(response.status, 404);
            assert.equal(errorCode(response), 'unsupported_route');
        }
        assert.equal(upstreamHits, 6,
            'native JSON, native SSE, local delegated, remote native, remote delegated, and claimed-failure are the only backend hits');

        fs.rmSync(manifestPath);
        fs.rmSync(defaultManifestPath);
        const missing = await request(frontdoorPort, 'GET', '/openai/v1/models');
        assert.equal(missing.status, 503);
        assert.equal(errorCode(missing), 'api_gateway_unavailable');

        const drainRegistryBaseline = (await gatewayStatus()).json.api_gateway_inflight;
        writeJson(defaultManifestPath, SEED);
        writeJson(manifestPath, SEED);
        sidecarMode = 'drain-after-claim';
        heldDrainBackendResponse = null;
        heldDrainBackendClosed = false;
        const drainPublic = request(frontdoorPort, 'POST', '/openai/v1/chat/completions', {
            model: 'agentrouter/drain-claimed', messages: [], stream: false,
        });
        await waitUntil(() => heldDrainBackendResponse !== null, 2000,
            'claimed backend did not arrive before drain');
        const earlySidecarResult = await drainPublic;
        assert.equal(earlySidecarResult.status, 200, earlySidecarResult.raw);
        assert.equal((await gatewayStatus()).json.api_gateway_inflight, drainRegistryBaseline + 1,
            'claimed paid work remains registered after early sidecar response');
        let exitedDuringClaimedWork = false;
        child.once('exit', () => { exitedDuringClaimedWork = true; });
        const drain = await request(frontdoorPort, 'POST', '/__drain');
        assert.equal(drain.status, 200, drain.raw);
        assert.equal(drain.json.inflight, 1,
            'drain reports claimed paid work as in flight');
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(exitedDuringClaimedWork, false,
            'frontdoor must not exit while claimed paid work remains alive');
        const drainBackendBody = Buffer.from(JSON.stringify({
            id: 'msg_drain', type: 'message', role: 'assistant', model: 'drain-claimed',
            content: [{ type: 'text', text: 'finished after drain' }], stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
        }), 'utf8');
        heldDrainBackendResponse.writeHead(200, {
            'content-type': 'application/json', 'content-length': String(drainBackendBody.length),
        });
        heldDrainBackendResponse.end(drainBackendBody);
        await waitUntil(() => heldDrainBackendClosed, 2000,
            'claimed backend did not complete after drain release');
        await waitUntil(() => child.exitCode !== null, 3000,
            'frontdoor did not exit after claimed paid work completed');

        console.log('check-api-gateway-frontdoor OK (models, hidden recognition, redacted errors, no fallback)');
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill();
            await new Promise(resolve => child.once('exit', resolve)).catch(() => {});
        }
        await new Promise(resolve => bifrost.close(resolve));
        await new Promise(resolve => upstream.close(resolve));
        await new Promise(resolve => postBodyResetBackend.close(resolve));
        await new Promise(resolve => dashboard.close(resolve));
        if (lazyListening) await new Promise(resolve => lazyBackend.close(resolve));
        fs.rmSync(TMP, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
