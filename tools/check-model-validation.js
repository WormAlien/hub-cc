'use strict';
// Regression for Claude Code /model validation through keepalive-proxy.js.
// A slow upstream error used to arrive after JSON pre-commit had sent HTTP 200
// and whitespace. The proxy then destroyed the socket because it could no longer
// forward the real status, so Claude Code showed "socket connection was closed".

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PROXY = path.join(ROOT, 'routing', 'keepalive-proxy.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'model-validation-'));
let child = null;
let upstream = null;

const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const nap = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = async () => {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
};

function request(port, body, timeoutMs = 12000) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise(resolve => {
        const req = http.request({
            host: '127.0.0.1', port, method: 'POST', path: '/v1/messages?beta=true', timeout: timeoutMs,
            headers: { 'content-type': 'application/json', 'content-length': payload.length },
        }, res => {
            const chunks = [];
            let aborted = false;
            res.on('data', chunk => chunks.push(chunk));
            res.on('aborted', () => { aborted = true; resolve({ status: res.statusCode, aborted, body: Buffer.concat(chunks).toString('utf8') }); });
            res.on('end', () => resolve({ status: res.statusCode, aborted, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(new Error('client timeout')));
        req.on('error', error => resolve({ status: 0, aborted: true, error: error.message, body: '' }));
        req.end(payload);
    });
}

async function cleanup() {
    if (child) { try { child.kill(); } catch {} }
    if (upstream) await new Promise(resolve => upstream.close(resolve)).catch(() => {});
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

(async () => {
    const upstreamPort = await freePort();
    const proxyPort = await freePort();
    upstream = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => setTimeout(() => {
            if (res.destroyed) return;
            res.writeHead(524, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'error code: 524' } }));
        }, 3500));
    });
    await new Promise((resolve, reject) => {
        upstream.once('error', reject);
        upstream.listen(upstreamPort, '127.0.0.1', resolve);
    });

    const mapFile = path.join(TMP, 'modelmap.json');
    fs.writeFileSync(mapFile, '{}\n', 'utf8');
    child = spawn(process.execPath, [PROXY], {
        cwd: ROOT,
        stdio: 'ignore',
        env: {
            ...process.env,
            PORT: String(proxyPort),
            UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
            MODELMAP_FILE: mapFile,
            KEEPALIVE_LOG_FILE: path.join(TMP, 'keepalive.log'),
            JSON_HOLD_MS: '3000', PRE_COMMIT_MS: '0', HEDGE_MS: '0', MAX_HEDGES: '0',
            MAX_ATTEMPTS: '1', HOLD_MS: '0', UPSTREAM_TIMEOUT_MS: '10000', AUTOROTATE: '0',
        },
    });

    let ready = false;
    for (let i = 0; i < 60; i += 1) {
        try {
            const r = await fetch(`http://127.0.0.1:${proxyPort}/__keepalive/api/status`, { signal: AbortSignal.timeout(500) });
            if (r.ok) { ready = true; break; }
        } catch {}
        await nap(100);
    }
    assert.ok(ready, 'keepalive test process did not start');

    const result = await request(proxyPort, {
        model: 'test-model', max_tokens: 1,
        system: [{ type: 'text', text: '' }, { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }] }],
        metadata: { user_id: JSON.stringify({ session_id: 'model-validation-test' }) },
    });

    assert.equal(result.status, 529, `expected retryable 529 without a broken socket, got ${JSON.stringify(result)}`);
    assert.equal(result.aborted, false, 'validation response must not be a broken socket');
    assert.match(result.body, /error code: 524/);
    assert.match(result.body, /overloaded_error/);
    console.log(JSON.stringify({ ok: true, status: result.status, aborted: result.aborted }));
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
}).finally(cleanup);
