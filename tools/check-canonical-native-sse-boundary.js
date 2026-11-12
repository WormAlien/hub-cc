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
    const exited = once(child, 'exit').catch(() => []);
    child.kill();
    await Promise.race([exited, wait(1500)]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
}

async function waitReady(child, port, output) {
    for (let i = 0; i < 120; i += 1) {
        if (child.exitCode !== null || child.signalCode) throw new Error(`frontdoor exited:\n${output()}`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/__frontdoor/api/status`, { signal: AbortSignal.timeout(200) });
            await response.text();
            if (response.ok) return;
        } catch { /* retry */ }
        await wait(35);
    }
    throw new Error(`frontdoor readiness timeout:\n${output()}`);
}

function request(port, body) {
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise(resolve => {
        let response = null;
        const chunks = [];
        let aborted = false;
        let error = null;
        const req = http.request({
            hostname: '127.0.0.1', port, method: 'POST', path: '/v1/messages', timeout: 4000,
            headers: { 'content-type': 'application/json', 'content-length': String(payload.length), 'accept-encoding': 'identity' },
        }, res => {
            response = res;
            res.on('data', chunk => chunks.push(chunk));
            res.on('aborted', () => { aborted = true; });
            res.on('error', value => { error = value; });
            res.on('close', () => resolve({
                status: res.statusCode,
                complete: res.complete,
                aborted,
                error,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
            res.on('end', () => resolve({
                status: res.statusCode,
                complete: res.complete,
                aborted,
                error,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', value => resolve({ status: response && response.statusCode, complete: false, aborted, error: value, body: Buffer.concat(chunks).toString('utf8') }));
        req.end(payload);
    });
}

function event(name, value) {
    return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}

(async () => {
    console.log('check-canonical-native-sse-boundary:');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-native-sse-'));
    const secretFile = path.join(temp, 'secrets', 'local-hop.key');
    const frontdoorPort = await reservePort();
    let mode = 'full';
    const backend = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body.stream) {
                const response = JSON.stringify({
                    id: 'msg_json', type: 'message', role: 'assistant', model: body.model,
                    content: [{ type: 'text', text: 'json message_stop is content only' }],
                    stop_reason: 'end_turn', stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 1 },
                });
                res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(response) });
                return res.end(response);
            }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            if (mode === 'zero') return res.end();
            res.write(event('message_start', {
                type: 'message_start',
                message: {
                    id: 'msg_message_stop_substring', type: 'message', role: 'assistant',
                    model: `${body.model}-message_stop`, content: [], stop_reason: null,
                    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
                },
            }));
            res.write(event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
            res.write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial message_stop text' } }));
            if (mode === 'partial') return res.end();
            res.write(event('content_block_stop', { type: 'content_block_stop', index: 0 }));
            res.write(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }));
            res.end(event('message_stop', { type: 'message_stop' }));
        });
    });
    const backendPort = await listen(backend);
    const state = { backend: 'agentrouter', upstream: `http://127.0.0.1:${backendPort}`, keyFile: null, modelmap: null };
    const activeFile = path.join(temp, 'active-backend.json');
    const backendsFile = path.join(temp, 'backends.json');
    const multiFile = path.join(temp, 'multi-routes-modelmap.json');
    fs.writeFileSync(activeFile, JSON.stringify(state) + '\n');
    fs.writeFileSync(backendsFile, JSON.stringify({ providers: { agentrouter: state }, aliases: {} }) + '\n');
    fs.writeFileSync(multiFile, '{}\n');
    let output = '';
    const frontdoor = spawn(process.execPath, [FRONTDOOR], {
        cwd: temp,
        env: {
            ...process.env, NODE_OPTIONS: '', HOME: temp, USERPROFILE: temp,
            PORT: String(frontdoorPort), ACTIVE_BACKEND_FILE: activeFile,
            BACKENDS_FILE: backendsFile, MULTI_MAP_FILE: multiFile,
            BIFROST_URL: 'http://127.0.0.1:1', SWITCH_PORT: '1', ENSURE_TIMEOUT_MS: '50',
            UPSTREAM_TIMEOUT_MS: '3000', ABUSE_HUB_LOCAL_HOP_KEY_FILE: secretFile,
            TOKEN_USAGE_FILE: path.join(temp, 'usage.jsonl'),
        },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    frontdoor.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    frontdoor.stderr.on('data', chunk => { output += chunk.toString('utf8'); });
    try {
        await waitReady(frontdoor, frontdoorPort, () => output);
        const publicModel = 'agentrouter/Claude-Opus/Nested[1m]';
        const base = { model: publicModel, max_tokens: 32, messages: [{ role: 'user', content: 'canonical direct route' }] };

        const json = await request(frontdoorPort, { ...base, stream: false });
        assert.equal(json.status, 200, json.body);
        assert.equal(json.complete, true);
        const object = JSON.parse(json.body);
        assert.equal(object.model, publicModel);
        assert.equal(object.content[0].text, 'json message_stop is content only');
        console.log('  ok  canonical JSON restores full public model');

        mode = 'full';
        const full = await request(frontdoorPort, { ...base, stream: true });
        assert.equal(full.status, 200, full.body);
        assert.equal(full.complete, true, full.body);
        assert.equal(full.aborted, false, full.body);
        const objects = [...full.body.matchAll(/^data:\s*(\{.*\})\r?$/gm)].map(match => JSON.parse(match[1]));
        assert.ok(objects.length >= 6, full.body);
        for (const value of objects) {
            if (value.model !== undefined) assert.equal(value.model, publicModel);
            if (value.message && value.message.model !== undefined) assert.equal(value.message.model, publicModel);
        }
        assert.equal(objects.filter(value => value.type === 'message_stop').length, 1);
        assert.ok(full.body.includes('partial message_stop text'));
        console.log('  ok  full canonical SSE requires and preserves real terminal event');

        for (const truncateMode of ['partial', 'zero']) {
            mode = truncateMode;
            const truncated = await request(frontdoorPort, { ...base, stream: true });
            assert.equal(truncated.complete, false, `${truncateMode} EOF was clean: ${JSON.stringify(truncated)}`);
            assert.equal(truncated.body.includes('"type":"message_stop"'), false, truncated.body);
            assert.equal(truncated.body.includes('event: error'), false, truncated.body);
            console.log(`  ok  ${truncateMode}-content EOF without message_stop aborts downstream`);
        }
    } finally {
        await stopChild(frontdoor);
        try { backend.closeAllConnections(); } catch { /* old Node */ }
        if (backend.listening) await new Promise(resolve => backend.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log('check-canonical-native-sse-boundary: PASS (4)');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
