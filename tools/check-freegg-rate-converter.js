'use strict';
// Exact production converter in a localhost-only scratch fixture. No vendor calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = process.env.TMPDIR || 'C:/Users/WormAlien/AppData/Local/hermes/cache/scratch';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = value => 'data: ' + JSON.stringify(value) + '\n\n';

(async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'freegg-rate-converter-'));
    const routing = path.join(dir, 'routing');
    fs.mkdirSync(path.join(routing, 'lib'), { recursive: true });
    for (const file of ['freegg-proxy.js', 'proxy-logger.js', 'lib/usage-normalize.js']) {
        fs.copyFileSync(path.join(ROOT, 'routing', file), path.join(routing, file));
    }
    fs.writeFileSync(path.join(routing, 'freegg-modelmap.json'), '{}');
    const keyFile = path.join(dir, 'fixture-key.txt');
    fs.writeFileSync(keyFile, 'fixture-key');
    let responder;
    let calls = 0;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => { calls += 1; responder(req, res); });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const reservation = http.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const base = 'http://127.0.0.1:' + port;
    let output = '';
    const child = spawn(process.execPath, [path.join(routing, 'freegg-proxy.js')], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            FG_LISTEN_PORT: String(port),
            FG_UPSTREAM_BASE: 'http://127.0.0.1:' + upstream.address().port + '/v1',
            FG_KEY_FILE: keyFile,
            PROXY_LOG_INGEST_URL: 'disabled',
        },
    });
    child.stdout.on('data', value => output += value);
    child.stderr.on('data', value => output += value);
    let passed = 0;
    let failed = 0;
    const ask = async stream => {
        const before = calls;
        const response = await fetch(base + '/v1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-key' },
            body: JSON.stringify({ model: 'gpt-6.1-sol', max_tokens: 16, stream, messages: [{ role: 'user', content: 'fixture' }] }),
            signal: AbortSignal.timeout(4000),
        });
        const body = await response.json();
        assert.equal(calls - before, 1, 'converter must send exactly one generation');
        return { status: response.status, retry: response.headers.get('retry-after'), error: body.error };
    };
    const test = async (name, fn) => {
        try { await fn(); passed += 1; console.log('ok ' + name); }
        catch (error) { failed += 1; console.error('FAIL ' + name + ': ' + error.message); }
    };
    try {
        let ready = false;
        for (let i = 0; i < 80; i += 1) {
            if (child.exitCode !== null) throw new Error('converter exited: ' + output);
            try {
                const response = await fetch(base + '/health', { signal: AbortSignal.timeout(200) });
                await response.text();
                if (response.ok) { ready = true; break; }
            } catch {}
            await wait(30);
        }
        assert.ok(ready, 'fixture converter readiness');
        await test('HTTP token429 preserves code and retry in both modes', async () => {
            responder = (_req, res) => {
                res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '17' });
                res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'token rate limit' } }));
            };
            for (const stream of [false, true]) {
                const result = await ask(stream);
                assert.equal(result.status, 429);
                assert.equal(result.error.type, 'rate_limit_error');
                assert.equal(result.error.code, 'rate_limit_exceeded');
                assert.equal(result.error.retry_after_ms, 17000);
                assert.equal(result.retry, '17');
            }
        });
        await test('SSE token429 preserves code and retry', async () => {
            responder = (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(frame({ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'token rate limit', retry_after: 23 } } }));
            };
            const result = await ask(true);
            assert.equal(result.status, 429);
            assert.equal(result.error.code, 'rate_limit_exceeded');
            assert.equal(result.error.retry_after_ms, 23000);
            assert.equal(result.retry, '23');
        });
        await test('HTTP server_error429 is not a token429 in both modes', async () => {
            responder = (_req, res) => {
                res.writeHead(429, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { type: 'server_error', message: 'rate limit service unavailable' } }));
            };
            for (const stream of [false, true]) {
                const result = await ask(stream);
                assert.equal(result.status, 429);
                assert.equal(result.error.type, 'api_error');
                assert.equal(result.error.code, 'server_error');
                assert.equal(result.retry, null);
            }
        });
        await test('SSE server_error is a hard failure without rate retry', async () => {
            responder = (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(frame({ type: 'response.failed', response: { error: { code: 'server_error', message: 'fixture failure' } } }));
            };
            const result = await ask(true);
            assert.equal(result.status, 502);
            assert.equal(result.error.code, 'server_error');
            assert.equal(result.error.type, 'api_error');
            assert.equal(result.retry, null);
        });
        await test('HTTP null retry metadata remains absent in both modes', async () => {
            responder = (_req, res) => {
                res.writeHead(429, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'token rate limit', retry_after_ms: null, retry_after: '' } }));
            };
            for (const stream of [false, true]) {
                const result = await ask(stream);
                assert.equal(result.status, 429);
                assert.equal(result.error.retry_after_ms, undefined);
                assert.equal(result.retry, null);
            }
        });
        await test('SSE null retry metadata remains absent', async () => {
            responder = (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(frame({ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'token rate limit', retry_after_ms: null, retry_after: '' } } }));
            };
            const result = await ask(true);
            assert.equal(result.status, 429);
            assert.equal(result.error.retry_after_ms, undefined);
            assert.equal(result.retry, null);
        });
        await test('HTTP and SSE reset timestamps propagate to retry', async () => {
            for (const stream of [false, true]) {
                responder = (_req, res) => {
                    res.writeHead(429, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'token rate limit', reset_at: new Date(Date.now() + 30000).toISOString() } }));
                };
                const result = await ask(stream);
                assert.equal(result.status, 429);
                assert.ok(result.error.retry_after_ms > 0 && result.error.retry_after_ms <= 31000);
                assert.ok(Number(result.retry) > 0);
            }
            responder = (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(frame({ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'token rate limit', reset_at: new Date(Date.now() + 30000).toISOString() } } }));
            };
            const result = await ask(true);
            assert.equal(result.status, 429);
            assert.ok(result.error.retry_after_ms > 0 && result.error.retry_after_ms <= 31000);
            assert.ok(Number(result.retry) > 0);
        });
        console.log('FreeGG rate converter: ' + passed + ' passed, ' + failed + ' failed');
        if (failed) process.exitCode = 1;
    } finally {
        child.kill();
        await Promise.race([once(child, 'exit'), wait(2000)]).catch(() => {});
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
