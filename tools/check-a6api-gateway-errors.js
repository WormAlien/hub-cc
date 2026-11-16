#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const sidecar = require('../routing/lib/bifrost-sidecar');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'a6api-diagnostic-private-credential-path-sentinel';
const MODEL = 'a6api/deepseek-v4.1-flash-1017';
const CIRCUIT_MESSAGE = 'a6api: продавцы этой модели временно заблокированы после ошибок upstream. Дождитесь восстановления или добавьте резервного продавца в кабинете a6api.';
const SELLER_MESSAGE = 'a6api: у модели deepseek-v4.1-flash-1017 нет доступного продавца. Выбранный продавец недоступен или удалён. Выберите другого продавца в кабинете a6api или смените модель.';
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const freePort = async () => { const s = http.createServer(); const p = await listen(s); await new Promise(r => s.close(r)); return p; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label) { for (let i = 0; i < 160; i++) { try { if (await fn()) return; } catch {} await sleep(25); } throw new Error(`timeout: ${label}`); }
function request(port, pathname, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method: raw ? 'POST' : 'GET', timeout: 5000,
            headers: { ...headers, ...(raw ? { 'content-type': 'application/json', 'content-length': raw.length } : {}) } }, res => {
            const chunks = [];
            const done = truncated => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json, truncated }); };
            res.on('data', c => chunks.push(c)); res.on('end', () => done(false)); res.on('aborted', () => done(true)); res.on('error', () => done(true));
        });
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end(raw);
    });
}
async function fixture(realBifrost = false, remoteBackend = false) {
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'a6api-gateway-errors-'));
    const children = [], servers = [], calls = [], callbackStatuses = [], timers = new Set();
    let mode = 'circuit', bridgeMode = 'normal', frontPort;
    const sendJson = (res, value, status) => { const raw = Buffer.from(JSON.stringify(value)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': raw.length }); res.end(raw); };
    const backend = http.createServer((req, res) => {
        const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks));
            const entry = { body, headers: req.headers, closed: false }; calls.push(entry); res.on('close', () => { entry.closed = true; });
            if (body.model === 'concurrent-unknown') return sendJson(res, { error: { code: SECRET, type: 'api_error', message: SECRET } }, 503);
            if (mode === 'auth') return sendJson(res, { error: { code: SECRET, type: 'authentication_error', message: SECRET } }, 401);
            const code = mode === 'seller' ? 'smart_route_no_active_candidates' : 'subscription_route_circuit_blocked';
            const status = mode === 'seller' ? 409 : mode === 'status-mismatch' ? 409 : 503;
            if (mode === 'stall') { res.writeHead(503, { 'content-type': 'application/json' }); res.write('{"error":'); return; }
            if (mode === 'truncated') { res.writeHead(503, { 'content-type': 'application/json' }); res.write(`{"error":{"code":"${code}","type":"api_error","message":"${SECRET}"}}`); const t = setTimeout(() => { timers.delete(t); res.destroy(); }, 10); timers.add(t); return; }
            if (mode === 'oversized') return sendJson(res, { error: { code, type: 'api_error', message: SECRET.repeat(2500) } }, 503);
            if (mode === 'malformed') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(`{"error":{"code":"${code}"},"private":"${SECRET}"`); }
            if (mode === 'unknown') return sendJson(res, { error: { code: SECRET, type: 'overloaded_error', message: SECRET }, path: SECRET }, 503);
            if (mode === 'top-code') return sendJson(res, { code, error: { type: 'api_error', message: SECRET } }, 503);
            if (mode === 'type-mismatch') return sendJson(res, { error: { code, type: 'invalid_request_error', message: SECRET } }, 503);
            if (mode === 'wrong-content-type') { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end(JSON.stringify({ error: { code, type: 'api_error', message: SECRET } })); }
            sendJson(res, { type: 'error', error: { code, type: mode === 'seller' ? 'invalid_request_error' : 'api_error', message: SECRET, raw_body: SECRET, headers: { authorization: SECRET } }, model: 'hostile-substitute', path: SECRET }, status);
        });
    });
    const backendPort = await listen(backend); servers.push(backend);
    frontPort = await freePort();
    const fake = http.createServer((req, res) => {
        const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', async () => {
            const body = JSON.parse(Buffer.concat(chunks));
            if (bridgeMode === 'forged-only') return sendJson(res, { error: { code: 'subscription_route_circuit_blocked', type: 'api_error', message: SECRET } }, 503);
            const publicModel = body.model.replace(/^abuse-hub\//, '');
            const cb = await request(frontPort, '/v1/messages', { model: bridgeMode === 'model-mismatch' ? 'a6api/wrong' : publicModel, stream: body.stream === true, max_tokens: 8, messages: [{ role: 'user', content: 'fixture' }] }, {
                'x-abuse-hub-internal': sidecar.INTERNAL_HOP_MARKER,
                'x-abuse-hub-request-token': req.headers['x-bf-eh-x-abuse-hub-request-token'],
            }).catch(() => null);
            if (!cb || res.destroyed) return res.destroy();
            callbackStatuses.push(cb.status);
            if (bridgeMode === 'wrapped-200') return sendJson(res, { error: { code: SECRET, message: SECRET, extra_fields: { raw_response: cb.text } } }, 200);
            if (bridgeMode === 'sse-error') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(`data: ${JSON.stringify({ error: { code: SECRET, message: SECRET } })}\n\n`); }
            // Deliberately discard the callback code/status as Bifrost can wrap them.
            sendJson(res, { error: { code: 'overloaded_error', message: SECRET, extra_fields: { raw_response: cb.text } } }, 503);
        });
    });
    let bifrostPort;
    if (realBifrost) {
        const expected = sidecar.expectedExecutable();
        assert.equal(sidecar.verifyFile(expected.executable, expected.artifact.sha256).ok, true, 'exact pinned cached Bifrost required');
        bifrostPort = await freePort();
        const appDir = path.join(tmp, 'runtime', expected.lock.version);
        const configPath = sidecar.writeRuntimeConfig({ appDir, baseUrl: `http://127.0.0.1:${frontPort}` });
        const d = sidecar.createServiceDescriptor({ executable: expected.executable, appDir, configPath, port: bifrostPort, expectedSha256: expected.artifact.sha256, version: expected.lock.version });
        const env = {}; for (const n of ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) if (process.env[n] !== undefined) env[n] = process.env[n];
        const child = spawn(d.executable, d.args, { cwd: d.cwd, env: { ...env, ...d.env, HOME: tmp, USERPROFILE: tmp, TMP: tmp, TEMP: tmp, TMPDIR: tmp }, stdio: 'ignore', windowsHide: true }); children.push(child);
        await waitFor(async () => (await request(bifrostPort, '/health')).status === 200, 'pinned Bifrost');
    } else { bifrostPort = await listen(fake); servers.push(fake); }
    const backendsPath = path.join(tmp, 'backends.json'), manifestPath = path.join(tmp, 'manifest.json');
    writeJson(backendsPath, { version: 1, providers: Object.fromEntries(['a6api', 'agentrouter'].map(backend => [backend, { backend, upstream: remoteBackend ? `http://[::ffff:127.0.0.1]:${backendPort}` : `http://127.0.0.1:${backendPort}`, modelmap: null }])) });
    writeJson(manifestPath, { version: 1, revision: 1, enabled: true, models: {} });
    const child = spawn(process.execPath, [path.join(ROOT, 'routing/frontdoor-proxy.js')], { cwd: path.join(ROOT, 'routing'), env: { ...process.env, HOME: tmp, USERPROFILE: tmp, PORT: String(frontPort), BACKENDS_FILE: backendsPath, ACTIVE_BACKEND_FILE: path.join(tmp, 'absent.json'), API_GATEWAY_FILE: manifestPath, API_GATEWAY_DEFAULT_FILE: manifestPath, CLAUDE_SETTINGS_FILE: path.join(tmp, 'absent-settings.json'), ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(tmp, 'local-hop.key'), BIFROST_URL: `http://127.0.0.1:${bifrostPort}`, TOKEN_USAGE_FILE: path.join(tmp, 'usage.jsonl'), LOG_FILE: path.join(tmp, 'frontdoor.log'), UPSTREAM_TIMEOUT_MS: '2000', SWITCH_PORT: '1', MULTI_MAP_FILE: path.join(tmp, 'absent-map.json') }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); children.push(child);
    let logs = ''; child.stderr.on('data', c => { logs += c.toString(); });
    await waitFor(async () => (await request(frontPort, '/openai/v1/models')).status === 200, 'frontdoor');
    return { frontPort, calls, callbackStatuses, setMode(value) { mode = value; }, setBridge(value) { bridgeMode = value; }, logs: () => logs,
        async close() { for (const t of timers) clearTimeout(t); for (const c of children.reverse()) if (c.exitCode === null && c.signalCode === null) { const exited = new Promise(r => c.once('exit', r)); c.kill(); await exited; } for (const s of servers) { s.closeAllConnections(); await new Promise(r => s.close(r)); } fs.rmSync(tmp, { recursive: true, force: true }); } };
}
function assertSafe(response, { status = 503, code = 'subscription_route_circuit_blocked', message = CIRCUIT_MESSAGE, model = MODEL, native = false } = {}) {
    assert.equal(response.status, status, response.text);
    assert.equal(response.json?.error?.code, code, response.text);
    assert.equal(response.json?.error?.message, message, response.text);
    assert.equal(response.json?.error?.type, status === 409 ? 'invalid_request_error' : 'api_error');
    assert.equal(response.json.model, model);
    assert.equal(response.text.includes(SECRET), false, 'private provider data must never surface');
    assert.equal(response.text.includes('hostile-substitute'), false, 'upstream model must not surface');
    assert.equal(response.text.includes('[DONE]'), false, 'error must not end as successful stream');
    assert.deepEqual(Object.keys(response.json).sort(), native ? ['error', 'model', 'type'] : ['error', 'model']);
}
const chat = (f, stream = false, model = MODEL, headers = {}) => request(f.frontPort, '/openai/v1/chat/completions', { model, stream, max_tokens: 8, messages: [{ role: 'user', content: 'fixture' }] }, headers);

test('unknown and adversarial local errors remain generic and credential-safe in both protocols', async () => {
    const f = await fixture();
    try {
        for (const mode of ['unknown', 'status-mismatch', 'type-mismatch', 'top-code', 'wrong-content-type', 'malformed', 'oversized', 'truncated']) {
            f.setMode(mode);
            for (const stream of [false, true]) {
                assertSafe(await chat(f, stream), { code: 'upstream_unavailable', message: 'Upstream request failed.' });
                assertSafe(await request(f.frontPort, '/v1/messages', { model: MODEL, stream, max_tokens: 8, messages: [{ role: 'user', content: 'fixture' }] }), { native: true, code: 'upstream_unavailable', message: 'Upstream request failed.' });
            }
        }
        assert.equal(f.logs().includes(SECRET), false, 'provider private text is not logged');
    } finally { await f.close(); }
});

test('forged sidecar codes and public headers cannot create a trusted callback diagnosis', async () => {
    const f = await fixture();
    try {
        f.setBridge('forged-only');
        for (const stream of [false, true]) assertSafe(await chat(f, stream), { code: 'upstream_unavailable', message: 'Upstream request failed.' });
        assert.equal(f.calls.length, 0);
        for (const name of ['x-abuse-hub-error-code', 'x-bf-eh-x-abuse-hub-request-token', 'x-abuse-hub-request-token']) {
            const result = await chat(f, false, MODEL, { [name]: 'subscription_route_circuit_blocked' });
            assert.equal(result.status, 400);
        }
        f.setBridge('model-mismatch');
        assertSafe(await chat(f), { code: 'upstream_unavailable', message: 'Upstream request failed.' });
        assert.equal(f.calls.length, 0);
        assert.equal(f.callbackStatuses.at(-1), 403);
    } finally { await f.close(); }
});

test('diagnoses never cross requests or providers', async () => {
    const f = await fixture();
    try {
        const [known, unknown] = await Promise.all([chat(f), chat(f, false, 'a6api/concurrent-unknown')]);
        assertSafe(known);
        assertSafe(unknown, { model: 'a6api/concurrent-unknown', code: 'upstream_unavailable', message: 'Upstream request failed.' });
        assertSafe(await chat(f, false, 'agentrouter/deepseek-v4.1-flash-1017'), { model: 'agentrouter/deepseek-v4.1-flash-1017', code: 'upstream_unavailable', message: 'Upstream request failed.' });
        f.setMode('unknown');
        assertSafe(await chat(f), { code: 'upstream_unavailable', message: 'Upstream request failed.' });
    } finally { await f.close(); }
});

test('native missing-key authentication status survives redaction', async () => {
    const f = await fixture();
    try {
        f.setMode('auth');
        assertSafe(await request(f.frontPort, '/v1/messages', { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'fixture' }] }), { native: true, status: 401, code: 'upstream_unavailable', message: 'Upstream request failed.' });
    } finally { await f.close(); }
});

test('remote provider bodies cannot impersonate the trusted local a6api converter', async () => {
    const f = await fixture(false, true);
    try {
        for (const stream of [false, true]) {
            assertSafe(await chat(f, stream), { code: 'upstream_unavailable', message: 'Upstream request failed.' });
            assertSafe(await request(f.frontPort, '/v1/messages', { model: MODEL, stream, max_tokens: 8, messages: [{ role: 'user', content: 'fixture' }] }), { native: true, code: 'upstream_unavailable', message: 'Upstream request failed.' });
        }
    } finally { await f.close(); }
});

test('cancelling bounded error inspection tears down backend and releases request identity', async () => {
    const f = await fixture();
    try {
        for (const native of [false, true]) {
            f.setMode('stall');
            const baseline = f.calls.length;
            const raw = Buffer.from(JSON.stringify({ model: MODEL, stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'fixture' }] }));
            const req = http.request({ host: '127.0.0.1', port: f.frontPort, method: 'POST', path: native ? '/v1/messages' : '/openai/v1/chat/completions', headers: { 'content-type': 'application/json', 'content-length': raw.length } });
            req.on('error', () => {}); req.end(raw);
            await waitFor(() => f.calls.length > baseline, 'backend inspection started');
            req.destroy();
            await waitFor(() => f.calls[baseline].closed, 'cancelled backend closes');
            await waitFor(async () => (await request(f.frontPort, '/__frontdoor/api/status')).json.api_gateway_inflight === 0, 'cancelled request registry drains');
        }
        f.setMode('unknown');
        assertSafe(await chat(f), { code: 'upstream_unavailable', message: 'Upstream request failed.' });
    } finally { await f.close(); }
});

test('authenticated a6api circuit diagnosis survives wrapped Bifrost errors without provider text', async () => {
    const f = await fixture();
    try { assertSafe(await chat(f)); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.model, 'deepseek-v4.1-flash-1017'); assert.equal(f.calls[0].headers['x-route-exact'], '1'); assert.equal(f.calls[0].headers['x-route-final'], '1'); } finally { await f.close(); }
});

test('native a6api errors retain only generated diagnostics for both request stream modes', async () => {
    const f = await fixture();
    try {
        for (const mode of ['circuit', 'seller']) for (const stream of [false, true]) {
            f.setMode(mode);
            const response = await request(f.frontPort, '/v1/messages', { model: MODEL, stream, max_tokens: 8, messages: [{ role: 'user', content: 'fixture' }] });
            assertSafe(response, { native: true, ...(mode === 'seller' ? { status: 409, code: 'smart_route_no_active_candidates', message: SELLER_MESSAGE } : {}) });
        }
    } finally { await f.close(); }
});

test('seller configuration 409 and circuit 503 survive JSON and SSE error wrapping before public output', async () => {
    const f = await fixture();
    try {
        for (const mode of ['seller', 'circuit']) for (const bridge of ['normal', 'wrapped-200', 'sse-error']) for (const stream of [false, true]) {
            f.setMode(mode); f.setBridge(bridge);
            const before = f.calls.length;
            assertSafe(await chat(f, stream), mode === 'seller' ? { status: 409, code: 'smart_route_no_active_candidates', message: SELLER_MESSAGE } : {});
            assert.equal(f.calls.length, before + 1);
        }
    } finally { await f.close(); }
});

if (process.argv.includes('--isolated')) test('pinned real Bifrost preserves exact a6api errors in JSON and pre-output streaming', async () => {
    const f = await fixture(true);
    try {
        for (const mode of ['circuit', 'seller', 'unknown']) for (const stream of [false, true]) {
            f.setMode(mode);
            const before = f.calls.length;
            assertSafe(await chat(f, stream), mode === 'seller'
                ? { status: 409, code: 'smart_route_no_active_candidates', message: SELLER_MESSAGE }
                : mode === 'unknown' ? { code: 'upstream_unavailable', message: 'Upstream request failed.' } : {});
            assert.equal(f.calls.length, before + 1, 'one exact backend request');
            assert.equal(f.calls.at(-1).body.model, 'deepseek-v4.1-flash-1017');
            assert.equal(f.calls.at(-1).headers['x-route-exact'], '1');
            assert.equal(f.calls.at(-1).headers['x-route-final'], '1');
        }
        console.log('A6API_GATEWAY_PINNED_BIFROST_PASS');
    } finally { await f.close(); }
});
