#!/usr/bin/env node
'use strict';
// Subagent 429 gets a spare pool key for THIS request only; primary key stays selected.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-keyfb-'));
const UP = 8801, PX = 8802, DASH = 8803;
const PRIMARY = 'sk-primary-keep', SPARE = 'sk-spare-free';
const KEY_FILE = path.join(TMP, 'active-key.txt');
const SESSIONS = path.join(TMP, 'tr-sessions.json');
fs.writeFileSync(KEY_FILE, PRIMARY + '\n');
fs.writeFileSync(SESSIONS, JSON.stringify([
    { name: 'primary', api_key: PRIMARY, status: 'live', active: true, balance: 40 },
    { name: 'spare', api_key: SPARE, status: 'live', active: false, balance: 10 },
], null, 2));
const seen = [];
const upstream = http.createServer((req, res) => {
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (req.url === '/v1/messages') seen.push(key);
    req.resume();
    req.on('end', () => {
        if (key === PRIMARY) { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Rate limit exceeded: please retry after 5 seconds"}}'); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
});
const dashCalls = [];
const dash = http.createServer((req, res) => { dashCalls.push(req.url); res.writeHead(200); res.end('{"ok":true}'); });
const wait = ms => new Promise(r => setTimeout(r, ms));
function ask(model) {
    const body = JSON.stringify({ model, stream: true, messages: [], max_tokens: 64 });
    return new Promise((resolve, reject) => {
        const r = http.request({ port: PX, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
            res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
        r.on('error', reject); r.end(body);
    });
}
(async () => {
    await new Promise(r => upstream.listen(UP, '127.0.0.1', r));
    await new Promise(r => dash.listen(DASH, '127.0.0.1', r));
    const child = spawn(process.execPath, [path.join(ROOT, 'routing/keepalive-proxy.js')], {
        cwd: path.join(ROOT, 'routing'),
        env: { ...process.env, PORT: String(PX), UPSTREAM: `http://127.0.0.1:${UP}`, KEY_FILE, SESSIONS_FILE: SESSIONS,
            ROTATE_PROVIDER: 'tr', DASHBOARD_URL: `http://127.0.0.1:${DASH}`, CONFIG_FILE: path.join(TMP, 'cfg.json'),
            LATENCY_FILE: path.join(TMP, 'lat.json'), EVENTS_FILE: path.join(TMP, 'ev.json'), KEEPALIVE_LOG_FILE: path.join(TMP, 'ka.log'),
            MODELMAP_FILE: path.join(TMP, 'none.json'), HAIKU_REMAP: '0', HEDGE_MS: '0', PRE_COMMIT_MS: '0',
            MAX_ATTEMPTS: '1', HOLD_MS: '0', RETRY_DELAY_MS: '50', PAID_SINGLE_KEY: '0' },
        stdio: 'ignore',
    });
    try {
        for (let i = 0; i < 60; i++) {
            try { const r = await fetch(`http://127.0.0.1:${PX}/__state`); await r.text(); if (r.ok) break; } catch { /* not up yet */ }
            await wait(100);
        }
        seen.length = 0;
        let r = await ask('claude-sonnet-5');
        assert.equal(r.status, 200, r.body.slice(0, 200));
        assert.deepEqual(seen, [PRIMARY, SPARE], 'subagent must retry once on the spare key');
        assert.equal(fs.readFileSync(KEY_FILE, 'utf8').trim(), PRIMARY, 'primary selection must not change');
        assert.deepEqual(dashCalls, [], 'must not ask dashboard to rotate the global key');
        seen.length = 0;
        r = await ask('glm-5.3');
        assert.notEqual(r.status, 200, 'main-window request must not steal a spare key');
        assert.deepEqual(seen, [PRIMARY], 'main-window request keeps its key');
        assert.equal(fs.readFileSync(KEY_FILE, 'utf8').trim(), PRIMARY);
        console.log('check-keepalive-keyfallback: PASS');
    } finally {
        child.kill();
        upstream.close(); dash.close();
        fs.rmSync(TMP, { recursive: true, force: true });
    }
})().catch(e => { console.error('check-keepalive-keyfallback: FAIL', e.message); process.exitCode = 1; });
