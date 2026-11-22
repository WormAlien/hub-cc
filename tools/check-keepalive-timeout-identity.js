'use strict';
// Actual keepalive, local held vendor: timeout identity after SSE precommit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '..');
const { createLocalHopAuth } = require('../routing/lib/local-hop-auth.js');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function freePort() { const server = http.createServer(); const port = await listen(server); await new Promise(r => server.close(r)); return port; }

async function fixture() {
    const dir = fs.mkdtempSync(path.join(process.env.HERMES_TEST_SCRATCH || process.env.TMPDIR || os.tmpdir(), 'keepalive-timeout-'));
    let held, calls = 0;
    const vendor = http.createServer((req, res) => { req.resume(); req.on('end', () => { calls++; held = res; }); });
    const vendorPort = await listen(vendor), port = await freePort();
    const localHopFile = path.join(dir, 'local-hop.key');
    const auth = createLocalHopAuth({ secretFile: localHopFile });
    fs.writeFileSync(path.join(dir, 'key.txt'), 'local-timeout-fixture-key');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ v: 8, preCommitMs: 50, jsonHoldMs: 0,
        maxAttempts: 1, maxHedges: 0, hedgeMs: 0, holdMs: 0, stallMs: 0, catalogTtlMs: 0,
        upstreamTimeoutMs: 8000, retryBudgetMs: 8000, visionBridge: false, poolFallbackModel: '', poolDeadMs: 0 }));
    const env = {};
    for (const name of ['SYSTEMROOT', 'WINDIR', 'PATH', 'COMSPEC', 'PATHEXT']) if (process.env[name] !== undefined) env[name] = process.env[name];
    Object.assign(env, { HOME: dir, USERPROFILE: dir, TMP: dir, TEMP: dir, TMPDIR: dir,
        PORT: String(port), UPSTREAM: 'http://127.0.0.1:' + vendorPort,
        KEY_FILE: path.join(dir, 'key.txt'), SESSIONS_FILE: '', MODELMAP_FILE: path.join(dir, 'absent-map.json'),
        CONFIG_FILE: path.join(dir, 'config.json'), ABUSE_HUB_LOCAL_HOP_KEY_FILE: localHopFile,
        HAIKU_REMAP: '0', GPT_PROXY_FORCE: '0', LOCAL_EXACT_ADAPTER: '0', AUTOROTATE: '0',
        THINK_STRIP: '0', EMPTY_TEXT_FIX: '0', VISION_BRIDGE: '0', UPSTREAM_NOSTREAM: '0',
        KEEPALIVE_LOG_FILE: path.join(dir, 'keepalive.log'), LATENCY_FILE: path.join(dir, 'latency.json'),
        EVENTS_FILE: path.join(dir, 'events.json'), FAILDUMP_DIR: path.join(dir, 'faildump'), PROXY_LOG_INGEST_URL: 'disabled' });
    const child = spawn(process.execPath, [path.join(ROOT, 'routing/keepalive-proxy.js')], {
        cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = ''; child.stderr.on('data', c => { stderr += c.toString(); });
    for (let i = 0; i < 150; i++) {
        if (child.exitCode !== null) throw new Error('fixture exited: ' + stderr.slice(-500));
        try { if ((await fetch('http://127.0.0.1:' + port + '/__state')).status === 200) break; } catch {}
        if (i === 149) throw new Error('fixture readiness timeout');
        await wait(30);
    }
    function send() {
        const raw = JSON.stringify({ model: 'glm-5.3-flash', stream: true, max_tokens: 32,
            messages: [{ role: 'user', content: 'timeout fixture' }] });
        let resolveHeaders, resolveDone;
        const headers = new Promise(r => { resolveHeaders = r; });
        const done = new Promise(r => { resolveDone = r; });
        const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', timeout: 8000,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw),
                'x-route-final': '1', 'x-route-exact': '1', [auth.headerName]: auth.token('frontdoor-to-keepalive') } }, res => {
            resolveHeaders({ status: res.statusCode, contentType: res.headers['content-type'] });
            let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
            res.on('end', () => resolveDone({ text, complete: true, trailers: { ...res.trailers } }));
            res.on('aborted', () => resolveDone({ text, complete: false }));
            res.on('error', () => resolveDone({ text, complete: false }));
        });
        req.on('error', e => { resolveHeaders({ error: e.code }); resolveDone({ complete: false, text: '' }); });
        req.on('timeout', () => req.destroy(new Error('fixture request timeout')));
        req.end(raw);
        return { headers, done };
    }
    return { dir, send, get calls() { return calls; },
        release(status, text, contentType = 'text/html') { assert.ok(held); const res = held; held = null;
            res.writeHead(status, { 'content-type': contentType }); res.end(text); },
        async close() { vendor.closeAllConnections(); await new Promise(r => vendor.close(r));
            if (child.exitCode === null && child.signalCode === null) await new Promise(r => { child.once('exit', r); child.kill(); }); } };
}

function errorObject(text) {
    const errors = text.split('\n').filter(line => line.startsWith('data:'))
        .map(line => JSON.parse(line.slice(5))).filter(o => o.type === 'error');
    assert.equal(errors.length, 1, 'one real terminal error, no synthesized success');
    assert.ok(!text.includes('message_stop') && !text.includes('content_block_start'), 'no model output synthesized');
    return errors[0].error;
}

for (const status of [504, 524]) test(`origin ${status} after SSE precommit preserves safe numeric timeout identity`, async () => {
    const f = await fixture();
    try {
        const call = f.send();
        const header = await call.headers;
        assert.equal(header.status, 200, 'fixture reached the exact real precommit seam');
        assert.match(header.contentType, /event-stream/);
        f.release(status, '<html>vendor-private-sentinel trace timeout</html>');
        const response = await call.done;
        assert.equal(response.complete, true);
        const error = errorObject(response.text);
        assert.equal(error.code, 'upstream_timeout');
        assert.equal(error.status_code, status);
        assert.equal(response.trailers['x-abuse-hub-upstream-status'], String(status),
            'only the authenticated keepalive may attest the physical timeout');
        assert.ok(!response.text.includes('vendor-private-sentinel'), 'raw vendor detail must not cross the boundary');
        assert.equal(f.calls, 1, 'no hidden retry on an exact generation');
        console.log('TIMEOUT_FIXTURE=' + f.dir);
    } finally { await f.close(); }
});

test('ordinary vendor error retains its existing identity without a timeout verdict', async () => {
    const f = await fixture();
    try {
        const call = f.send();
        assert.equal((await call.headers).status, 200);
        f.release(503, JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'fixture busy' } }), 'application/json');
        const response = await call.done;
        const error = errorObject(response.text);
        assert.equal(error.type, 'overloaded_error');
        assert.equal(error.message, 'fixture busy');
        assert.notEqual(error.code, 'upstream_timeout');
        assert.equal(response.trailers['x-abuse-hub-upstream-status'], undefined);
        assert.equal(f.calls, 1);
    } finally { await f.close(); }
});
