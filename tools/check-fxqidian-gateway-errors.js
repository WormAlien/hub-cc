#!/usr/bin/env node
'use strict';
// Real checksum-pinned Bifrost and Front Door; localhost-only vendor fixtures.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const sidecar = require('../routing/lib/bifrost-sidecar');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = process.env.FX_GATEWAY_TEST_SCRATCH
    || (process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch')
        : process.env.TMPDIR || os.tmpdir());
const MODEL = 'fxqidian/glm-5.3-flash';
const BARE_MODEL = 'glm-5.3-flash';
const PRIVATE = 'fx-fixture-private-vendor-sentinel';
const MODEL_KEY = 'fixture-only-model-key';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
async function freePort() {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function waitFor(predicate, label, timeoutMs = 9000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try { if (await predicate()) return; } catch (error) { last = error; }
        await sleep(20);
    }
    throw new Error(`fixture deadline: ${label}${last ? ': ' + last.message : ''}`);
}
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function request(port, pathname, body, headers = {}) {
    return new Promise(resolve => {
        const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
        let settled = false;
        const finish = value => { if (!settled) { settled = true; resolve(value); } };
        const req = http.request({ host: '127.0.0.1', port, path: pathname, agent: false,
            method: raw ? 'POST' : 'GET', timeout: 8500,
            headers: { ...headers, ...(raw ? { 'content-type': 'application/json', 'content-length': raw.length } : {}) },
        }, res => {
            const chunks = [];
            const done = truncated => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json;
                try { json = JSON.parse(text); } catch { /* SSE or truncated JSON */ }
                finish({ status: res.statusCode, headers: res.headers, trailers: res.trailers, text, json, truncated });
            };
            res.on('data', chunk => chunks.push(Buffer.from(chunk)));
            res.on('end', () => done(false));
            res.on('aborted', () => done(true));
            res.on('error', () => done(true));
        });
        req.on('error', error => finish({ status: 0, text: '', truncated: true, error: error.code || error.message }));
        req.on('timeout', () => req.destroy(new Error('fixture request deadline')));
        req.end(raw);
    });
}
function sendJson(res, value, status = 200, extraHeaders = {}, trailers = {}) {
    const raw = Buffer.from(JSON.stringify(value));
    const trailerNames = Object.keys(trailers);
    res.writeHead(status, { 'content-type': 'application/json',
        ...(trailerNames.length ? { trailer: trailerNames.join(', ') } : { 'content-length': raw.length }), ...extraHeaders });
    if (trailerNames.length) res.addTrailers(trailers);
    res.end(raw);
}
async function terminate(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
    });
}

async function fixture({ frontTimeoutMs = 6000 } = {}) {
    fs.mkdirSync(SCRATCH, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(SCRATCH, 'fx-gateway-errors-'));
    const file = name => path.join(tmp, name);
    const children = [], servers = [], calls = [], callbacks = [], keepaliveResponses = [], bifrostResponses = [], observations = [];
    let mode = { status: 524 }, frontPort, bfPort;
    const artifact = file('observations.json');
    const usageRows = () => fs.existsSync(file('usage.jsonl'))
        ? fs.readFileSync(file('usage.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
        : [];
    const save = () => writeJson(artifact, {
        binary: pinned, observations,
        callbacks: callbacks.map(({ body, ...entry }) => entry),
        keepaliveResponses: keepaliveResponses.map(({ body, ...entry }) => entry),
        bifrostResponses,
        usage: usageRows(),
        calls: calls.map(({ body, release, ...entry }) => ({ ...entry, body })),
    });
    const expected = sidecar.expectedExecutable();
    const verification = sidecar.verifyFile(expected.executable, expected.artifact.sha256);
    assert.equal(verification.ok, true, 'existing checksum-pinned binary required; this test never installs');
    const pinned = { version: expected.lock.version, sha256: verification.actual, executable: expected.executable };
    const baseEnv = {};
    for (const name of ['SYSTEMROOT', 'WINDIR', 'PATH', 'COMSPEC', 'PATHEXT']) {
        if (process.env[name] !== undefined) baseEnv[name] = process.env[name];
    }
    Object.assign(baseEnv, { HOME: tmp, USERPROFILE: tmp, TMP: tmp, TEMP: tmp, TMPDIR: tmp,
        NODE_OPTIONS: '', ABUSE_HUB_LOCAL_HOP_KEY_FILE: file('local-hop.key'),
        TOKEN_USAGE_FILE: file('usage.jsonl') });
    fs.writeFileSync(file('local-hop.key'), crypto.randomBytes(32));
    fs.writeFileSync(file('model-key.txt'), MODEL_KEY);

    async function start(executable, args, extraEnv, port, healthPath, name, cwd = tmp) {
        const child = spawn(executable, args, { cwd, env: { ...baseEnv, ...extraEnv },
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        children.push(child);
        child.stdout.on('data', chunk => fs.appendFileSync(file(`${name}.stdout.log`), chunk));
        child.stderr.on('data', chunk => fs.appendFileSync(file(`${name}.stderr.log`), chunk));
        await waitFor(async () => {
            if (child.exitCode !== null) throw new Error(`${name} exited ${child.exitCode}`);
            return (await request(port, healthPath)).status === 200;
        }, `${name} readiness`);
    }
    function relay(port, req, res, captures, label) {
        const chunks = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            let body;
            try { body = JSON.parse(raw.toString('utf8')); } catch { /* health */ }
            const entry = { label, path: req.url, body, status: null, text: '', complete: false, trailers: {} };
            if (req.method === 'POST' && req.url !== '/logs') captures.push(entry);
            const headers = { ...req.headers, host: `127.0.0.1:${port}`, 'content-length': raw.length, connection: 'close' };
            delete headers['transfer-encoding'];
            const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, agent: false,
                headers, timeout: 8000 }, upRes => {
                entry.status = upRes.statusCode;
                entry.contentType = upRes.headers['content-type'];
                res.writeHead(upRes.statusCode, upRes.headers);
                upRes.on('data', chunk => { entry.text += chunk.toString('utf8'); });
                upRes.on('end', () => {
                    entry.complete = true;
                    entry.trailers = { ...upRes.trailers };
                    if (Object.keys(upRes.trailers).length && !res.destroyed) res.addTrailers(upRes.trailers);
                });
                upRes.on('aborted', () => { if (!res.destroyed) res.destroy(); });
                upRes.on('error', () => { if (!res.destroyed) res.destroy(); });
                upRes.pipe(res);
            });
            upstream.on('timeout', () => upstream.destroy(new Error('relay deadline')));
            upstream.on('error', error => { entry.error = error.code || error.message; if (!res.destroyed) res.destroy(); });
            res.on('close', () => { if (!res.writableFinished && !upstream.destroyed) upstream.destroy(); });
            upstream.end(raw);
        });
        req.on('error', () => { if (!res.destroyed) res.destroy(); });
    }
    const vendor = http.createServer((req, res) => {
        if (req.url === '/logs') return sendJson(res, {});
        const chunks = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const selected = { ...mode };
            const entry = { body, path: req.url, status: selected.status, closed: false,
                closedBeforeFinish: false, modelKeyUsed: req.headers.authorization === `Bearer ${MODEL_KEY}`,
                leakedControls: Object.keys(req.headers).filter(name => name.startsWith('x-abuse-hub-') || name.startsWith('x-bf-')) };
            calls.push(entry);
            res.on('close', () => { entry.closed = true; entry.closedBeforeFinish = !res.writableFinished; });
            entry.release = () => {
                if (res.destroyed || res.writableEnded) return;
                if (selected.kind === 'native-usage') {
                    const ending = selected.crlf ? String.fromCharCode(13, 10) : '\n';
                    const event = (type, value) => {
                        const json = JSON.stringify({ type, ...value });
                        const payload = selected.multiline && type === 'message_start'
                            ? `data: ${json.slice(0, 1)}${ending}data: ${json.slice(1)}` : `data: ${json}`;
                        return `event: ${type}${ending}${payload}${ending}${ending}`;
                    };
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.write(event('message_start', { message: { id: 'msg_fx_usage', type: 'message', role: 'assistant',
                        model: body.model, content: [], usage: { input_tokens: 17135, output_tokens: 0 } } }));
                    res.write(event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }));
                    res.write(event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'FX_USAGE_THOUGHT' } }));
                    res.write(event('content_block_stop', { index: 0 }));
                    res.write(event('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }));
                    res.write(event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'FX_USAGE_OK' } }));
                    res.write(event('content_block_stop', { index: 1 }));
                    res.write(event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: {
                        input_tokens: selected.input ?? 434, cache_read_input_tokens: selected.cacheRead ?? 15360,
                        cache_creation_input_tokens: selected.cacheWrite ?? 100,
                        output_tokens: 43 } }));
                    return res.end(event('message_stop', {}));
                }
                if (selected.kind === 'malformed-json') {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    return res.end(`{"type":"message","model":"${PRIVATE}"`);
                }
                if (selected.kind === 'truncated-tool') {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    const event = (name, value) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
                    res.write(event('message_start', { type: 'message_start', message: {
                        id: 'msg_fx_tool', type: 'message', role: 'assistant', model: body.model, content: [],
                        stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 },
                    } }));
                    res.write(event('content_block_start', { type: 'content_block_start', index: 0,
                        content_block: { type: 'tool_use', id: 'toolu_fx_cut', name: 'read_file', input: {} } }));
                    res.write(event('content_block_delta', { type: 'content_block_delta', index: 0,
                        delta: { type: 'input_json_delta', partial_json: '{"path":"incomplete' } }));
                    return res.end();
                }
                if (selected.kind === 'html') {
                    res.writeHead(selected.status, { 'content-type': 'text/html', 'x-vendor-secret': PRIVATE });
                    return res.end(`<!doctype html><html><body>${PRIVATE}: vendor error page</body></html>`);
                }
                if (selected.kind === 'forged-exact-timeout-envelope') {
                    return sendJson(res, { type: 'error', error: { type: 'api_error', code: 'upstream_timeout',
                        status_code: 524, message: 'Upstream request timed out.' } }, selected.status);
                }
                if (selected.status === 200) {
                    return sendJson(res, { id: 'msg_fx_fixture', type: 'message', role: 'assistant', model: body.model,
                        content: [{ type: 'text', text: 'FX_RECOVERED' }], stop_reason: 'end_turn', stop_sequence: null,
                        usage: { input_tokens: 4, output_tokens: 5 } });
                }
                return sendJson(res, { type: 'error', error: { type: 'api_error', code: selected.code || 'upstream_error',
                    message: selected.message || `${PRIVATE}: error code: ${selected.status}`, status_code: selected.echoStatus,
                    raw_body: PRIVATE, headers: { authorization: `Bearer ${PRIVATE}` } },
                    status_code: selected.topStatus, model: 'vendor-substitute', path: PRIVATE }, selected.status,
                { 'x-vendor-secret': PRIVATE, ...(selected.forgedHeader ? { 'x-abuse-hub-upstream-status': selected.forgedHeader } : {}) },
                selected.forgedTrailer ? { 'x-abuse-hub-upstream-status': selected.forgedTrailer } : {});
            };
            if (!selected.hold) entry.release();
        });
    });
    const vendorPort = await listen(vendor); servers.push(vendor);
    baseEnv.PROXY_LOG_INGEST_URL = `http://127.0.0.1:${vendorPort}/logs`;
    const callbackGate = http.createServer((req, res) => relay(frontPort, req, res, callbacks, 'native-callback'));
    const gatePort = await listen(callbackGate); servers.push(callbackGate);
    const bifrostGate = http.createServer((req, res) => relay(bfPort, req, res, bifrostResponses, 'pinned-bifrost'));
    const bridgePort = await listen(bifrostGate); servers.push(bifrostGate);
    const keepPort = await freePort();
    const keepaliveGate = http.createServer((req, res) => relay(keepPort, req, res, keepaliveResponses, 'local-keepalive'));
    const keepaliveBoundaryPort = await listen(keepaliveGate); servers.push(keepaliveGate);
    frontPort = await freePort();
    bfPort = await freePort();
    writeJson(file('backends.json'), { version: 1, providers: { fxqidian: {
        backend: 'fxqidian', upstream: `http://127.0.0.1:${keepaliveBoundaryPort}`, modelmap: file('hostile-modelmap.json'),
    } }, aliases: { fx: 'fxqidian' } });
    writeJson(file('hostile-modelmap.json'), { default: 'forbidden-model', opus: 'forbidden-model',
        sonnet: 'forbidden-model', haiku: 'forbidden-model', gpt: 'forbidden-model' });
    writeJson(file('manifest.json'), { version: 1, revision: 1, enabled: true, models: {} });
    try {
        await start(process.execPath, [path.join(ROOT, 'routing/keepalive-proxy.js')], {
            PORT: String(keepPort), UPSTREAM: `http://127.0.0.1:${vendorPort}`, KEY_FILE: file('model-key.txt'),
            MODELMAP_FILE: file('hostile-modelmap.json'), CONFIG_FILE: file('absent-keepalive-config.json'),
            SESSIONS_FILE: '', PAID_SINGLE_KEY: '0', AUTOROTATE: '0', KEY_SPREAD: '0',
            CUSTOM_PROVIDER_ID: 'fxqidian', LOCAL_EXACT_ADAPTER: '0', HAIKU_REMAP: '0', GPT_PROXY_FORCE: '0',
            VISION_BRIDGE: '0', THINK_STRIP: '0', EMPTY_TEXT_FIX: '0', UPSTREAM_NOSTREAM: '0', MODEL_ECHO_INJECT: '0',
            HEDGE_MS: '0', MAX_HEDGES: '0', MAX_ATTEMPTS: '1', HOLD_MS: '0', EMPTY_STREAM_MS: '0',
            JSON_HOLD_MS: '0', STALL_MS: '0', CATALOG_TTL_MS: '0', POOL_FALLBACK_MODEL: '', POOL_DEAD_MS: '0',
            PRE_COMMIT_MS: '250', IDLE_MS: '40', UPSTREAM_TIMEOUT_MS: '20000', CONN_TRACE: '0',
            KEEPALIVE_LOG_FILE: file('keepalive.log'), LATENCY_FILE: file('latency.json'), EVENTS_FILE: file('events.json'),
            FAILDUMP_DIR: file('faildump'), DASHBOARD_URL: `http://127.0.0.1:${vendorPort}`,
        }, keepPort, '/__state', 'keepalive');
        const appDir = file('bifrost-runtime');
        const pinnedCatalogs = path.join(ROOT, 'routing/runtime/bifrost/v2.5.0');
        const configPath = sidecar.writeRuntimeConfig({ appDir, baseUrl: `http://127.0.0.1:${gatePort}`,
            pricingPath: path.join(pinnedCatalogs, 'bifrost-pricing.json'),
            modelParametersPath: path.join(pinnedCatalogs, 'bifrost-model-parameters.json') });
        const descriptor = sidecar.createServiceDescriptor({ executable: expected.executable, appDir, configPath,
            port: bfPort, expectedSha256: expected.artifact.sha256, version: expected.lock.version });
        await start(descriptor.executable, descriptor.args, descriptor.env, bfPort, '/health', 'bifrost', descriptor.cwd);
        await start(process.execPath, [path.join(ROOT, 'routing/frontdoor-proxy.js')], {
            PORT: String(frontPort), BACKENDS_FILE: file('backends.json'), API_GATEWAY_FILE: file('manifest.json'),
            API_GATEWAY_DEFAULT_FILE: file('manifest.json'), CLAUDE_SETTINGS_FILE: file('absent-settings.json'),
            ACTIVE_BACKEND_FILE: file('absent-active.json'), MULTI_MAP_FILE: file('absent-multi.json'),
            BIFROST_URL: `http://127.0.0.1:${bridgePort}`, LOG_FILE: file('frontdoor.log'),
            UPSTREAM_TIMEOUT_MS: String(frontTimeoutMs), SWITCH_PORT: String(vendorPort),
        }, frontPort, '/openai/v1/models', 'frontdoor');
        save();
        return { tmp, artifact, frontPort, keepPort, calls, callbacks, keepaliveResponses, bifrostResponses, pinned, usageRows,
            setMode(value) { mode = { ...value }; },
            async chat(stream = false, override = {}) {
                const label = `${mode.status}-${stream ? 'stream' : 'json'}`;
                const response = await request(frontPort, '/openai/v1/chat/completions', {
                    model: MODEL, stream, max_tokens: 4096, reasoning_effort: 'high',
                    messages: [{ role: 'system', content: 'Preserve this exact FX fixture prompt.' },
                        { role: 'user', content: 'case:fx-timeout' }],
                    tools: [{ type: 'function', function: { name: 'read_file', description: 'Fixture tool',
                        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }],
                    ...override,
                }, { authorization: 'Bearer dummy', 'user-agent': 'Hermes-FX-fixture', 'x-session-id': 'fixture-fx-session' });
                observations.push({ label, response });
                save();
                return response;
            },
            async close() {
                for (const child of children.reverse()) await terminate(child);
                for (const server of servers.reverse()) {
                    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
                }
                save();
                console.log(`FX_GATEWAY_FIXTURE=${artifact}`);
            },
        };
    } catch (error) {
        for (const child of children.reverse()) await terminate(child);
        for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        save();
        throw error;
    }
}
function assertTimeout(response) {
    assert.equal(response.status, 504, `physical timeout lost: HTTP ${response.status}: ${response.text}`);
    assert.equal(response.json?.error?.code, 'upstream_timeout', response.text);
    assert.equal(response.json?.model, MODEL);
    assert.equal(response.text.includes(PRIVATE), false);
    assert.equal(response.text.includes('vendor-substitute'), false);
    assert.equal(response.headers['x-vendor-secret'], undefined);
    assert.equal(response.text.includes('[DONE]'), false);
}

if (process.argv.includes('--probe') || process.argv.includes('--probe-delay')) {
    (async () => {
        const f = await fixture();
        try {
            for (const stream of (process.argv.includes('--probe-delay') ? [] : [false, true])) {
                f.setMode({ status: 524 });
                console.log(JSON.stringify({ probe: `immediate-${stream}`, response: await f.chat(stream),
                    callback: f.callbacks.at(-1), bifrost: f.bifrostResponses.at(-1) }));
            }
            f.setMode({ status: 524, hold: true });
            const before = f.callbacks.length;
            const pending = f.chat(true);
            await waitFor(() => f.callbacks.length > before && f.callbacks.at(-1).text.includes('ping'), 'native SSE precommit ping');
            f.calls.at(-1).release();
            console.log(JSON.stringify({ probe: 'precommitted-524', response: await pending,
                callback: f.callbacks.at(-1), bifrost: f.bifrostResponses.at(-1) }));
        } finally { await f.close(); }
    })().catch(error => { console.error(error.stack); process.exitCode = 1; });
} else {
    test('real pinned Bifrost preserves physical FX 524 as safe public timeout JSON', async () => {
        const f = await fixture();
        try {
            f.setMode({ status: 524 });
            const response = await f.chat(false);
            assertTimeout(response);
            assert.equal(f.calls.length, 1, 'no hidden second generation');
            assert.equal(f.calls[0].body.model, BARE_MODEL);
            assert.equal(f.calls[0].modelKeyUsed, true);
            assert.deepEqual(f.calls[0].leakedControls, []);
        } finally { await f.close(); }
    });
    test('real pinned ordinary 400 remains invalid_request and the next FX request recovers', async () => {
        const f = await fixture();
        try {
            for (const stream of [false, true]) {
                f.setMode({ status: 400, message: 'fixture invalid max_tokens' });
                const response = await f.chat(stream);
                assert.equal(response.status, 400, response.text || response.error);
                assert.equal(response.json?.error?.code, 'invalid_request');
                f.setMode({ status: 200 });
                const next = await f.chat(false);
                assert.equal(next.status, 200, next.text || next.error);
                assert.equal(next.json?.choices[0]?.message?.content, 'FX_RECOVERED');
                assert.equal(next.json.model, MODEL);
                assert.equal(next.json.usage.prompt_tokens, 4);
                assert.equal(next.json.usage.completion_tokens, 5);
            }
            assert.equal(f.calls.length, 4, 'one generation for each explicit request');
            const usage = f.usageRows();
            assert.equal(usage.length, 2, 'only the two real successful inner hops create usage, never the outer Bifrost leg');
            for (const row of usage) assert.deepEqual({ in: row.in, out: row.out, cr: row.cr, cw: row.cw },
                { in: 4, out: 5, cr: 0, cw: 0 });
        } finally { await f.close(); }
    });
    test('native FX final usage replaces the preliminary estimate without losing thinking or cache', async () => {
        const f = await fixture();
        try {
            f.setMode({ status: 200, kind: 'native-usage' });
            const response = await f.chat(true);
            assert.equal(response.status, 200, response.text);
            const events = response.text.split('\n').filter(line => line.startsWith('data:') && !line.includes('[DONE]'))
                .map(line => JSON.parse(line.slice(5)));
            const usage = events.filter(e => e.usage).at(-1).usage;
            assert.equal(usage.prompt_tokens, 434 + 15360 + 100, 'final provider buckets, not preliminary input');
            assert.equal(usage.completion_tokens, 43);
            assert.equal(usage.total_tokens, 434 + 15360 + 100 + 43);
            assert.equal(usage.prompt_tokens_details.cached_tokens, 15360);
            assert.equal(usage.prompt_tokens_details.cache_write_tokens, 100);
            assert.match(response.text, /FX_USAGE_THOUGHT/);
            assert.match(response.text, /FX_USAGE_OK/);
            assert.match(response.text, /data: \[DONE\]/);
            const rows = f.usageRows();
            assert.equal(rows.length, 1);
            assert.deepEqual({ in: rows[0].in, out: rows[0].out, cr: rows[0].cr, cw: rows[0].cw },
                { in: 434, out: 43, cr: 15360, cw: 100 });
            assert.equal(f.calls.length, 1);
            const native = f.keepaliveResponses.at(-1).text;
            assert.match(native, /"input_tokens":17135/, 'native client leg retains provider bytes');
            assert.match(native, /"input_tokens":434/, 'native final usage is untouched');
            assert.match(f.callbacks.at(-1).text, /"input_tokens":0/, 'only converter-facing preliminary input is neutralized');
        } finally { await f.close(); }
    });
    test('native FX final usage handles zero/cache-free counters and CRLF multiline events', async () => {
        const f = await fixture();
        try {
            for (const settings of [
                { input: 42, cacheRead: 0, cacheWrite: 0 },
                { input: 0, cacheRead: 1000, cacheWrite: 0, crlf: true, multiline: true },
            ]) {
                f.setMode({ status: 200, kind: 'native-usage', ...settings });
                const before = f.usageRows().length;
                const response = await f.chat(true);
                assert.equal(response.status, 200, response.text);
                const events = response.text.split('\n').filter(line => line.startsWith('data:') && !line.includes('[DONE]'))
                    .map(line => JSON.parse(line.slice(5)));
                const usage = events.filter(e => e.usage).at(-1).usage;
                assert.equal(usage.prompt_tokens, settings.input + settings.cacheRead + settings.cacheWrite);
                assert.equal(usage.completion_tokens, 43);
                assert.equal(usage.prompt_tokens_details?.cached_tokens ?? 0, settings.cacheRead);
                assert.equal(f.usageRows().length, before + 1);
                assert.match(response.text, /FX_USAGE_THOUGHT/);
                assert.match(response.text, /data: \[DONE\]/);
            }
            f.setMode({ status: 200, kind: 'native-usage', input: 42, cacheRead: 0, cacheWrite: 0 });
            const sibling = await f.chat(true, { model: 'fxqidian/native-sibling-fixture' });
            assert.equal(sibling.status, 200);
            assert.match(f.callbacks.at(-1).text, /"input_tokens":17135/, 'unaffected FX model is not silently changed');
        } finally { await f.close(); }
    });
    test('real pinned FX timeout retains identity after native keepalive precommit before model output', async () => {
        const f = await fixture();
        try {
            for (const status of [504, 524]) for (const kind of ['json', 'html']) {
                f.setMode({ status, kind, hold: true });
                const before = f.calls.length, callbacksBefore = f.callbacks.length;
                const pending = f.chat(true);
                await waitFor(() => f.callbacks.length > callbacksBefore && f.callbacks.at(-1).text.includes('ping'),
                    `native ${kind} keepalive precommit`);
                const native = f.callbacks.at(-1);
                assert.equal(native.status, 200, 'exercise committed native SSE, not immediate JSON');
                assert.equal(native.text.includes('content_block_delta'), false);
                f.calls.at(-1).release();
                const response = await pending;
                assertTimeout(response);
                assert.equal(f.calls.length, before + 1, 'keepalive/precommit never starts a second generation');
                assert.equal(f.keepaliveResponses.at(-1).trailers['x-abuse-hub-upstream-status'], String(status),
                    'locally generated physical-status seam reaches the authenticated callback');
                assert.equal(native.trailers['x-abuse-hub-upstream-status'], undefined, 'callback diagnosis is not forwarded to Bifrost');
                assert.equal(response.trailers['x-abuse-hub-upstream-status'], undefined, 'internal transport diagnosis is never public');
            }
            f.setMode({ status: 200 });
            const next = await f.chat(false);
            assert.equal(next.status, 200, 'completed timeout evidence cannot cross requests');
            assert.equal(next.json.model, MODEL);
        } finally { await f.close(); }
    });
    test('a proven local Front Door timeout is safe 504 and cancels the pending FX generation', async () => {
        const f = await fixture({ frontTimeoutMs: 750 });
        try {
            f.setMode({ status: 524, hold: true });
            const response = await f.chat(false);
            assertTimeout(response);
            assert.equal(f.calls.length, 1);
            await waitFor(() => f.calls[0].closedBeforeFinish, 'timeout closes pending vendor socket');
            await waitFor(async () => (await request(f.frontPort, '/__frontdoor/api/status')).json?.api_gateway_inflight === 0,
                'timeout request registry drains');
        } finally { await f.close(); }
    });
    test('real pinned explicit 504 and 524 survive both JSON and pre-output stream requests', async () => {
        const f = await fixture();
        try {
            for (const status of [504, 524]) for (const stream of [false, true]) {
                f.setMode({ status, message: `${PRIVATE}: no timeout keyword needed` });
                const before = f.calls.length;
                assertTimeout(await f.chat(stream));
                assert.equal(f.calls.length, before + 1);
                const vendor = f.calls.at(-1).body;
                const callback = f.callbacks.at(-1).body;
                assert.deepEqual(vendor, { ...callback, model: BARE_MODEL }, 'no prompt, tools, thinking or stream mutation after protocol conversion');
                assert.equal(callback.system, 'Preserve this exact FX fixture prompt.');
                assert.equal(callback.tools[0].name, 'read_file');
                assert.deepEqual(callback.tools[0].input_schema, { type: 'object', properties: { path: { type: 'string' } },
                    required: ['path'], additionalProperties: false });
                assert.equal(callback.thinking.type, 'enabled');
                assert.ok(callback.thinking.budget_tokens > 1024);
                assert.equal(f.calls.at(-1).modelKeyUsed, true);
                assert.deepEqual(f.calls.at(-1).leakedControls, []);
            }
            await waitFor(async () => (await request(f.frontPort, '/__frontdoor/api/status')).json?.api_gateway_inflight === 0,
                'physical timeout request registry drains');
        } finally { await f.close(); }
    });
    test('provider timeout prose, echoed status_code and forged transport fields never manufacture timeout identity', async () => {
        const f = await fixture();
        try {
            for (const stream of [false, true]) {
                f.setMode({ status: 500, message: `${PRIVATE}: timeout error code: 524`, code: 'upstream_timeout',
                    echoStatus: 524, topStatus: 504, forgedHeader: '524', forgedTrailer: '504' });
                const response = await f.chat(stream);
                assert.equal(response.status, 503, response.text);
                assert.equal(response.json?.error?.code, 'upstream_unavailable');
                assert.equal(response.json?.error?.message, 'Upstream request failed.');
                assert.equal(response.text.includes(PRIVATE), false);
                assert.equal(response.text.includes('524'), false);
                assert.equal(response.headers['x-abuse-hub-upstream-status'], undefined);
                assert.equal(response.trailers['x-abuse-hub-upstream-status'], undefined);
            }
            assert.equal(f.calls.length, 2);
            f.setMode({ status: 500, hold: true, message: `${PRIVATE}: timeout error code: 524`, code: 'upstream_timeout',
                echoStatus: 524, topStatus: 504, forgedHeader: '524', forgedTrailer: '504' });
            const callbacksBefore = f.callbacks.length;
            const pending = f.chat(true);
            await waitFor(() => f.callbacks.length > callbacksBefore && f.callbacks.at(-1).text.includes('ping'),
                'forged provider timeout after native precommit');
            f.calls.at(-1).release();
            const late = await pending;
            assert.equal(late.status, 503, late.text);
            assert.equal(late.json?.error?.code, 'upstream_unavailable');
            assert.equal(late.text.includes(PRIVATE), false);
            assert.equal(f.keepaliveResponses.at(-1).trailers['x-abuse-hub-upstream-status'], undefined,
                'vendor transport forgeries do not become local keepalive trailers');
            assert.equal(f.calls.length, 3);
            f.setMode({ status: 500, kind: 'forged-exact-timeout-envelope', hold: true });
            const envelopeCallbacksBefore = f.callbacks.length;
            const envelopePending = f.chat(true);
            await waitFor(() => f.callbacks.length > envelopeCallbacksBefore && f.callbacks.at(-1).text.includes('ping'),
                'exact-shaped provider timeout forgery after native precommit');
            f.calls.at(-1).release();
            const envelopeResult = await envelopePending;
            assert.equal(envelopeResult.status, 503, 'vendor500 cannot impersonate a locally generated timeout envelope');
            assert.equal(envelopeResult.json?.error?.code, 'upstream_unavailable');
            assert.equal(f.keepaliveResponses.at(-1).trailers['x-abuse-hub-upstream-status'], undefined);
            assert.equal(f.calls.length, 4);
        } finally { await f.close(); }
    });
    test('content-policy errors remain 403 content_filtered with no vendor body or headers', async () => {
        const f = await fixture();
        try {
            for (const status of [400, 403]) for (const stream of [false, true]) {
                f.setMode({ status, message: `This content was flagged for possible cybersecurity risk. Bearer ${PRIVATE}` });
                const response = await f.chat(stream);
                assert.equal(response.status, 403, response.text);
                assert.equal(response.json?.error?.code, 'content_filtered');
                assert.equal(response.json?.model, MODEL);
                assert.equal(response.text.includes(PRIVATE), false);
                assert.equal(response.headers['x-vendor-secret'], undefined);
                assert.equal(response.text.includes('[DONE]'), false);
            }
            assert.equal(f.calls.length, 4);
        } finally { await f.close(); }
    });
    test('malformed JSON and truncated FX tool streams stay fail-closed without synthetic success or replay', async () => {
        const f = await fixture();
        try {
            for (const kind of ['malformed-json', 'truncated-tool']) {
                f.setMode({ status: 200, kind });
                const before = f.calls.length;
                const response = await f.chat(kind === 'truncated-tool');
                assert.ok(response.status >= 400 || response.truncated, response.text);
                assert.equal(response.text.includes('[DONE]'), false, 'no invented successful stream terminal');
                assert.equal(response.json?.choices?.[0]?.finish_reason === 'stop', false);
                assert.equal(response.text.includes(PRIVATE), false);
                assert.equal(f.calls.length, before + 1, 'broken output is never replayed');
            }
        } finally { await f.close(); }
    });
    test('cancelling JSON and precommitted FX requests closes the vendor and drains the authenticated registry', async () => {
        const f = await fixture();
        try {
            for (const stream of [false, true]) {
                f.setMode({ status: 524, hold: true });
                const before = f.calls.length, callbacksBefore = f.callbacks.length;
                const raw = Buffer.from(JSON.stringify({ model: MODEL, stream, max_tokens: 4096,
                    messages: [{ role: 'user', content: 'cancellation fixture' }] }));
                const req = http.request({ host: '127.0.0.1', port: f.frontPort, path: '/openai/v1/chat/completions',
                    method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': raw.length } }, res => res.resume());
                req.on('error', () => {});
                req.end(raw);
                await waitFor(() => f.calls.length > before, 'vendor accepted exactly one request');
                if (stream) await waitFor(() => f.callbacks.length > callbacksBefore && f.callbacks.at(-1).text.includes('ping'),
                    'cancel after native keepalive precommit');
                req.destroy();
                await waitFor(() => f.calls[before].closedBeforeFinish, 'client cancellation closes vendor');
                await waitFor(async () => (await request(f.frontPort, '/__frontdoor/api/status')).json?.api_gateway_inflight === 0,
                    'client cancellation drains both request legs');
                assert.equal(f.calls.length, before + 1, 'no retry after client cancellation');
            }
            f.setMode({ status: 200 });
            const next = await f.chat(false);
            assert.equal(next.status, 200, 'cancelled diagnosis cannot poison the next request');
            assert.equal(next.json.model, MODEL);
        } finally { await f.close(); }
    });
}
