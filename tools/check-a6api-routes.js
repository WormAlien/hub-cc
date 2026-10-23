#!/usr/bin/env node
'use strict';
// Real route handler, local HTTP transport; no account, keys or external requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const file = path.join(__dirname, '../routing/lib/a6api-routes.js');
let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok ' + name); }
    catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}
(async () => {
    await test('HTTP route module exists', () => assert.ok(fs.existsSync(file), 'a6api-routes.js is missing'));
    if (!fs.existsSync(file)) return;
    const { createRoutes, canWrite, probeSummary } = require(file);
    const req = (address, host = 'localhost:8200', headers = {}) => ({ socket: { remoteAddress: address }, headers: { host, ...headers } });
    await test('write access requires loopback AND a loopback host', () => {
        assert.equal(canWrite(req('127.0.0.1')), true);
        assert.equal(canWrite(req('::1', '[::1]:8200')), true);
        assert.equal(canWrite(req('::ffff:127.0.0.1', '127.0.0.1:8200')), true);
        assert.equal(canWrite(req('192.168.1.9')), false);
        assert.equal(canWrite(req('127.0.0.1', 'attacker.example')), false);
        assert.equal(canWrite(req('127.0.0.1', 'localhost.evil:8200')), false);
    });
    await test('cross origin and null origin writes are blocked', () => {
        assert.equal(canWrite(req('127.0.0.1', 'localhost:8200', { origin: 'https://evil.example' })), false);
        assert.equal(canWrite(req('127.0.0.1', 'localhost:8200', { origin: 'null' })), false);
        assert.equal(canWrite(req('127.0.0.1', 'localhost:8200', { 'sec-fetch-site': 'cross-site' })), false);
        assert.equal(canWrite(req('127.0.0.1', 'localhost:8200', { origin: 'http://localhost:8200' })), true);
    });
    await test('write host must be an authority, not a normalized URL', () => {
        for (const host of ['localhost:8200/path', 'localhost:8200?x', 'localhost:8200#x', '127.1:8200', ' localhost:8200']) {
            assert.equal(canWrite(req('127.0.0.1', host)), false, host);
        }
    });
    await test('write origin must be the exact socket origin without credentials or paths', () => {
        for (const origin of ['https://localhost:8200', 'http://user@localhost:8200', 'http://localhost:8200/path', 'http://localhost:8200?x', '']) {
            assert.equal(canWrite(req('127.0.0.1', 'localhost:8200', { origin })), false, origin);
        }
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6api-route-test-'));
    function journal(rows) {
        fs.writeFileSync(path.join(dir, 'a6api-probes.jsonl'), rows.map((r, i) => JSON.stringify({ model: 'model', tokenId: 9, channelId: 3, at: new Date(1792700000000 + i * 1000).toISOString(), ok: true, ...r })).join('\n') + '\n');
        return probeSummary(dir, 'model');
    }
    await test('probe tool rounds never combine different tokens or explicit runs', () => {
        assert.equal(journal([{ test: 'tools-first' }, { test: 'tools-result', tokenId: 10 }])[3].tools, null);
        assert.equal(journal([{ test: 'tools-first', runId: 'one' }, { test: 'tools-result', runId: 'two' }])[3].tools, null);
    });
    await test('a new tool-first does not reuse a previous successful tool result', () => {
        assert.equal(journal([{ test: 'tools-first' }, { test: 'tools-result' }, { test: 'tools-first' }])[3].tools, null);
    });
    await test('latest vision evidence wins instead of always preferring an older 2048 test', () => {
        const got = journal([{ test: 'vision-2048-red' }, { test: 'vision-2048-blue' }, { test: 'vision-red', ok: false }, { test: 'vision-blue', ok: false }]);
        assert.equal(got[3].vision, false);
    });
    await test('probe vision pair requires the same run without deleting legacy evidence', () => {
        const got = journal([{ test: 'system' }, { test: 'vision-red' }, { test: 'vision-blue' }, { test: 'tools-first' }, { test: 'vision-red' }]);
        assert.equal(got[3].vision, null); assert.equal(got[3].system, true);
        assert.equal(journal([{ test: 'vision-red', runId: 'one' }, { test: 'vision-blue', runId: 'two' }])[3].vision, null);
        assert.equal(journal([{ test: 'vision-red' }, { test: 'vision-blue' }, { channelId: 4, test: 'system' }])[3].vision, true);
    });
    let writes = 0;
    const api = {
        state: async () => ({ tokens: [{ id: 9, name: 'test', mask: 'sk-***' }], models: ['model'], account: { balanceUsd: 2 } }),
        ownToken: async id => { if (id !== 9) throw Object.assign(new Error('no token'), { code: 'token_not_owned', status: 404 }); return { id: 9 }; },
        listings: async model => ({ items: [{ model, channelId: 3 }], stale: true }),
        route: async () => ({ id: 1, version: 2, channels: [] }),
        logs: async () => ({ items: [] }), reviews: async () => ({ items: [], count: 0 }),
        saveRoute: async body => { writes++; return { id: 1, version: 3, channels: body.channels }; },
        enableModel: async () => { writes++; return { ok: true }; }, reveal: async () => { writes++; return 'sk-explicit-secret'; },
    };
    const router = createRoutes({ api, secretDir: dir });
    const server = http.createServer((req, res) => { if (!router.handle(req, res)) { res.statusCode = 404; res.end('other'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/__switch/api/a6api/';
    try {
        await test('state GET is sanitized, no-store and never mutates', async () => {
            const r = await fetch(base + 'state?fresh=1'); const d = await r.json();
            assert.equal(r.status, 200); assert.equal(d.canWrite, true); assert.equal(d.tokens[0].mask, 'sk-***');
            assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(writes, 0);
        });
        await test('query string is parsed, not compared as part of pathname', async () => {
            const r = await fetch(base + 'model?tokenId=9&model=model'); const d = await r.json();
            assert.equal(r.status, 200); assert.equal(d.catalog.items[0].model, 'model'); assert.equal(writes, 0);
        });
        await test('GET can never reveal a key or change routes', async () => {
            for (const name of ['reveal', 'route', 'enable-model']) assert.equal((await fetch(base + name)).status, 405);
            assert.equal(writes, 0);
        });
        await test('plain form and cross-origin writes are denied', async () => {
            const r = await fetch(base + 'route', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
            assert.equal(r.status, 415);
            const foreign = await fetch(base + 'route', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
            assert.equal(foreign.status, 403); assert.equal(writes, 0);
        });
        await test('JSON writes are explicit and return verified state', async () => {
            const r = await fetch(base + 'route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokenId: 9, channels: [3] }) });
            assert.equal(r.status, 200); assert.equal((await r.json()).route.version, 3); assert.equal(writes, 1);
        });
        await test('key reveal requires explicit POST', async () => {
            const r = await fetch(base + 'reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"tokenId":9}' });
            assert.equal((await r.json()).key, 'sk-explicit-secret'); assert.equal(writes, 2);
        });
        await test('malformed JSON and oversized bodies do not mutate', async () => {
            assert.equal((await fetch(base + 'route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
            assert.equal((await fetch(base + 'route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(70000) }) })).status, 413);
            assert.equal(writes, 2);
        });
        await test('unrelated routes remain untouched', async () => assert.equal((await fetch(base.replace('/a6api/', '/other/'))).status, 404));
    } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
    console.log(`check-a6api-routes: ${passed} passed`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
