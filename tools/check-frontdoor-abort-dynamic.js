'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../routing/frontdoor-proxy.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdoor-abort-dynamic-'));

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function freePort() {
    const probe = net.createServer();
    return listen(probe).then(port => new Promise(resolve => probe.close(() => resolve(port))));
}

async function waitUntil(predicate, timeoutMs, message) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(message);
}

(async () => {
    let upstreamReceived = false;
    let upstreamClosed = false;
    const upstream = http.createServer((req, res) => {
        upstreamReceived = true;
        res.on('close', () => { upstreamClosed = true; });
        req.resume();
    });
    const upstreamPort = await listen(upstream);
    const frontdoorPort = await freePort();
    const statePath = path.join(TMP, 'active-backend.json');
    fs.writeFileSync(statePath, JSON.stringify({
        backend: 'abort-fixture',
        upstream: `http://127.0.0.1:${upstreamPort}`,
        keyFile: null,
        modelmap: null,
    }), 'utf8');

    const child = spawn(process.execPath, [SCRIPT], {
        cwd: path.dirname(SCRIPT),
        env: {
            ...process.env,
            HOME: TMP,
            USERPROFILE: TMP,
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(TMP, 'abuse-hub-local-hop.key'),
            PORT: String(frontdoorPort),
            ACTIVE_BACKEND_FILE: statePath,
            BACKENDS_FILE: path.join(TMP, 'missing-backends.json'),
            LOG_FILE: path.join(TMP, 'frontdoor.log'),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

    try {
        await waitUntil(() => stderr.includes('front-door'), 5000, 'frontdoor did not start');
        const body = Buffer.from(JSON.stringify({
            model: 'claude-opus-5',
            stream: true,
            max_tokens: 8,
            messages: [{ role: 'user', content: 'abort fixture' }],
        }), 'utf8');
        const client = http.request({
            hostname: '127.0.0.1',
            port: frontdoorPort,
            method: 'POST',
            path: '/v1/messages',
            headers: {
                'content-type': 'application/json',
                'content-length': String(body.length),
            },
        });
        client.on('error', () => {});
        client.end(body);
        await waitUntil(() => upstreamReceived, 5000, 'request did not reach dynamic upstream');
        assert.equal(upstreamClosed, false, 'upstream is live before caller abort');
        client.destroy();
        await waitUntil(() => upstreamClosed, 5000, 'caller abort did not close dynamic upstream');
        assert.match(stderr, /кли.*нт уш.*л/u, 'frontdoor logged caller departure');
        console.log('check-frontdoor-abort-dynamic OK');
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill();
            await new Promise(resolve => child.once('exit', resolve));
        }
        await new Promise(resolve => upstream.close(resolve));
        fs.rmSync(TMP, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
