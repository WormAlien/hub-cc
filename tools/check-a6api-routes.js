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
    const gateway = {
        state: async () => ({ tokens: [{ id: 9, name: 'test', mask: 'sk-***' }], models: ['model'], account: { balanceUsd: 2 }, selectedTokenId: 9, prepared: true, active: false,
            modelMap: { default: 'model', opus: 'model', sonnet: 'model', haiku: 'model' }, routesMap: { default: 'other' } }),
        models: async id => { assert.equal(id, 9); return ['model']; },
        selectKey: async id => { assert.equal(id, 9); writes++; return { ok: true, selectedTokenId: id }; },
        saveModels: async (id, patch) => { assert.equal(id, 9); writes++; return { ok: true, modelMap: patch, routesMap: { default: 'other' } }; },
        activate: async id => { assert.equal(id, 9); writes++; return { ok: true, active: true }; },
    };
    const router = createRoutes({ gateway, api: {}, secretDir: dir });
    const server = http.createServer((req, res) => { if (!router.handle(req, res)) { res.statusCode = 404; res.end('other'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/__switch/api/a6api/';
    const post = (name, body) => fetch(base + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
        await test('state GET is sanitized, no-store and never mutates', async () => {
            const r = await fetch(base + 'state?fresh=1'); const d = await r.json();
            assert.equal(r.status, 200); assert.equal(d.canWrite, true); assert.equal(d.tokens[0].mask, 'sk-***');
            assert.equal(d.selectedTokenId, 9); assert.equal(d.prepared, true); assert.equal(d.active, false);
            assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(writes, 0);
        });
        await test('per-key model catalog is read-only and needs no key in URL', async () => {
            const r = await fetch(base + 'models?tokenId=9'); const d = await r.json();
            assert.equal(r.status, 200); assert.deepEqual(d.models, ['model']); assert.equal(d.tokenId, 9); assert.equal(writes, 0);
        });
        await test('seller management and secret-reveal endpoints are removed', async () => {
            for (const name of ['model', 'reviews', 'logs', 'route', 'enable-model', 'reveal']) {
                assert.equal((await fetch(base + name + '?tokenId=9&model=model')).status, 404, name);
                assert.equal((await post(name, { tokenId: 9 })).status, 404, name);
            }
            assert.equal(writes, 0);
        });
        await test('GET cannot select keys, save models or activate Claude Code', async () => {
            for (const name of ['key', 'modelmap', 'activate']) assert.equal((await fetch(base + name)).status, 405);
            assert.equal(writes, 0);
        });
        await test('plain form and cross-origin writes are denied', async () => {
            assert.equal((await fetch(base + 'key', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
            assert.equal((await fetch(base + 'key', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' })).status, 403);
            assert.equal(writes, 0);
        });
        await test('key, modelmap and activate are distinct explicit operations', async () => {
            let r = await post('key', { tokenId: 9 }); assert.equal((await r.json()).selectedTokenId, 9); assert.equal(writes, 1);
            const patch = { default: 'model', opus: 'model', sonnet: 'model', haiku: 'model' };
            r = await post('modelmap', { tokenId: 9, modelMap: patch }); assert.deepEqual((await r.json()).modelMap, patch); assert.equal(writes, 2);
            r = await post('activate', { tokenId: 9 }); assert.equal((await r.json()).active, true); assert.equal(writes, 3);
        });
        await test('malformed JSON and oversized bodies do not mutate', async () => {
            assert.equal((await fetch(base + 'key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
            assert.equal((await post('key', { a: 'x'.repeat(70000) })).status, 413); assert.equal(writes, 3);
        });
        await test('unrelated routes remain untouched', async () => assert.equal((await fetch(base.replace('/a6api/', '/other/'))).status, 404));
    } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
    console.log(`check-a6api-routes: ${passed} passed`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
