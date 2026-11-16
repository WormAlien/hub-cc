#!/usr/bin/env node
'use strict';
// Actual localhost keepalive/frontdoor/pinned Bifrost; no external generation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const sidecar = require('../routing/lib/bifrost-sidecar');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function freePort() { const s = http.createServer(); const port = await listen(s); await new Promise(r => s.close(r)); return port; }
function request(port, endpoint, body) {
    return new Promise((resolve, reject) => {
        const raw = body === undefined ? null : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: endpoint, method: raw ? 'POST' : 'GET',
            headers: raw ? { 'content-type': 'application/json' } : {}, timeout: 9000 }, res => {
            let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
            res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json }); });
            res.on('error', reject); res.on('aborted', () => reject(new Error('response aborted')));
        });
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end(raw);
    });
}
async function fixture() {
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'json-error-idle-'));
    const children = [], calls = [], logs = [];
    let mode = 'error';
    const files = name => path.join(tmp, name);
    const json = (name, d) => fs.writeFileSync(files(name), JSON.stringify(d));
    const vendor = http.createServer((req, res) => {
        const chunks = []; req.on('data', c => chunks.push(c));
        req.on('end', async () => {
            if (req.url === '/logs') { res.end('{}'); return; }
            const body = JSON.parse(Buffer.concat(chunks)); calls.push(body);
            await sleep(3250);
            if (res.destroyed) return;
            if (mode === 'success') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
                    content: [{ type: 'text', text: 'RECOVERED_WITHOUT_RESTART' }], stop_reason: 'end_turn',
                    stop_sequence: null, usage: { input_tokens: 4, output_tokens: 5 } }));
                return;
            }
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fixture delayed transport failure' } }));
        });
    });
    const vendorPort = await listen(vendor), keepPort = await freePort(), frontPort = await freePort(), bfPort = await freePort();
    const keyFile = files('key.txt'); fs.writeFileSync(keyFile, 'fixture-model-key');
    const localHopFile = files('local-hop.key');
    json('keepalive.json', { v: 8, preCommitMs: 0, jsonHoldMs: 3000, stallMs: 0, maxAttempts: 1, maxHedges: 0, hedgeMs: 0, holdMs: 0, retryBudgetMs: 10000, catalogTtlMs: 0, poolFallbackModel: '', poolDeadMs: 0, visionBridge: false, upstreamTimeoutMs: 20000 });
    json('backends.json', { version: 1, providers: { agentrouter: { backend: 'agentrouter', upstream: `http://127.0.0.1:${keepPort}`, keyFile } } });
    json('manifest.json', { version: 1, revision: 1, enabled: true, models: {} });
    const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, TMP: tmp, TEMP: tmp, TMPDIR: tmp,
        ABUSE_HUB_LOCAL_HOP_KEY_FILE: localHopFile, TOKEN_USAGE_FILE: files('usage.jsonl'),
        PROXY_LOG_INGEST_URL: `http://127.0.0.1:${vendorPort}/logs`, NODE_OPTIONS: '' };
    async function start(executable, args, extra, port, endpoint) {
        const child = spawn(executable, args, { cwd: tmp, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        children.push(child); child.stdout.on('data', c => logs.push(c.toString())); child.stderr.on('data', c => logs.push(c.toString()));
        for (let i = 0; i < 120; i++) {
            if (child.exitCode !== null) throw new Error('fixture failed: ' + logs.join('').slice(-1200));
            try { if ((await request(port, endpoint)).status === 200) return; } catch {}
            await sleep(30);
        }
        throw new Error('fixture readiness failed');
    }
    try {
        await start(process.execPath, [path.join(ROOT, 'routing/keepalive-proxy.js')], {
            PORT: String(keepPort), UPSTREAM: `http://127.0.0.1:${vendorPort}`, KEY_FILE: keyFile,
            CONFIG_FILE: files('keepalive.json'), SESSIONS_FILE: '', MODELMAP_FILE: files('absent-map.json'),
            HAIKU_REMAP: '0', LOCAL_EXACT_ADAPTER: '0', AUTOROTATE: '0', GPT_PROXY_FORCE: '0',
            VISION_BRIDGE: '0', THINK_STRIP: '0', EMPTY_TEXT_FIX: '0', UPSTREAM_NOSTREAM: '0',
            KEEPALIVE_LOG_FILE: files('keepalive.log'), LATENCY_FILE: files('latency.json'), EVENTS_FILE: files('events.json'), FAILDUMP_DIR: files('faildump'), CONN_TRACE: '0',
        }, keepPort, '/__state');
        const expected = sidecar.expectedExecutable();
        assert.equal(sidecar.verifyFile(expected.executable, expected.artifact.sha256).ok, true);
        const appDir = files('bifrost-runtime');
        const configPath = sidecar.writeRuntimeConfig({ appDir, baseUrl: `http://127.0.0.1:${frontPort}` });
        const d = sidecar.createServiceDescriptor({ executable: expected.executable, appDir, configPath, port: bfPort, expectedSha256: expected.artifact.sha256, version: expected.lock.version });
        await start(d.executable, d.args, d.env, bfPort, '/health');
        await start(process.execPath, [path.join(ROOT, 'routing/frontdoor-proxy.js')], {
            PORT: String(frontPort), BACKENDS_FILE: files('backends.json'), API_GATEWAY_FILE: files('manifest.json'),
            API_GATEWAY_DEFAULT_FILE: files('manifest.json'), ACTIVE_BACKEND_FILE: files('absent-active.json'),
            CLAUDE_SETTINGS_FILE: files('absent-settings.json'), MULTI_MAP_FILE: files('absent-multi.json'),
            BIFROST_URL: `http://127.0.0.1:${bfPort}`, LOG_FILE: files('front.log'), UPSTREAM_TIMEOUT_MS: '8000',
        }, frontPort, '/openai/v1/models');
        return { tmp, frontPort, keepPort, calls, logs, setMode(value) { mode = value; },
            async close() { for (const c of children.reverse()) if (c.exitCode === null && !c.signalCode) { const done = new Promise(r => c.once('exit', r)); c.kill(); await done; } vendor.closeAllConnections(); await new Promise(r => vendor.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); } };
    } catch (e) { for (const c of children) c.kill(); vendor.closeAllConnections(); vendor.close(); throw e; }
}
test('delayed exact JSON failure keeps non-success status after jsonHold threshold', async () => {
    const f = await fixture();
    try {
        const r = await request(f.frontPort, '/v1/messages', { model: 'agentrouter/gpt-fixture', stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'fixture' }] });
        assert.ok(r.status >= 400, `error carried HTTP ${r.status}: ${r.text}`);
        assert.equal(r.json.type, 'error');
        assert.equal(f.calls.length, 1);
    } finally { await f.close(); }
});
test('pinned Bifrost cannot turn delayed exact failure into a blank successful completion', async () => {
    const f = await fixture();
    try {
        const r = await request(f.frontPort, '/openai/v1/chat/completions', { model: 'agentrouter/gpt-fixture', stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'fixture' }] });
        assert.ok(r.status >= 400, `error became HTTP ${r.status}: ${r.text}`);
        assert.ok(r.json.error);
        assert.equal(f.calls.length, 1);
        assert.equal((await request(f.frontPort, '/openai/v1/models')).status, 200);
        f.setMode('success');
        const next = await request(f.frontPort, '/openai/v1/chat/completions', { model: 'agentrouter/gpt-fixture', stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'fixture retry' }] });
        assert.equal(next.status, 200);
        assert.equal(next.json.choices[0].message.content, 'RECOVERED_WITHOUT_RESTART');
        assert.equal(next.json.model, 'agentrouter/gpt-fixture');
        assert.equal(f.calls.length, 2, 'one request per attempt, no restart or hidden generation');
    } finally { await f.close(); }
});

test('legacy non-exact JSON hold remains enabled for a delayed successful message', async () => {
    const f = await fixture();
    try {
        f.setMode('success');
        const r = await request(f.keepPort, '/v1/messages', { model: 'gpt-fixture', stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'fixture' }] });
        assert.equal(r.status, 200);
        assert.equal(r.json.content[0].text, 'RECOVERED_WITHOUT_RESTART');
        assert.match(r.text, /^\s+\{/);
        assert.equal(f.calls.length, 1);
    } finally { await f.close(); }
});
