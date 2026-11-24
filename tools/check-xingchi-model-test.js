'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

(async () => {
    const modulePath = '../routing/lib/xingchi-model-test.js';
    assert.ok(fs.existsSync(path.join(__dirname, modulePath)), 'Xingchi model-test module must exist');
    const { createXingchiModelTest } = require(modulePath);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-model-test-'));
    const cacheFile = path.join(dir, 'cache.json');
    let calls = 0, mode = 'ok', now = 1000000;
    let accounts = [{ id: 'a', api_key: 'secret-A', active: true }, { id: 'b', api_key: 'secret-B' }];
    const server = http.createServer(async (req, res) => {
        calls++;
        assert.equal(req.url, '/v1/responses');
        assert.equal(req.headers.authorization, 'Bearer secret-A');
        let raw = ''; for await (const c of req) raw += c;
        const body = JSON.parse(raw);
        assert.equal(body.model, 'gpt-6.1-sol');
        assert.equal(body.stream, false);
        if (mode === 'slow') await new Promise(r => setTimeout(r, 800));
        if (mode === 'fail') { res.writeHead(503); res.end(JSON.stringify({ error: { message: 'Service unavailable secret-A' } })); }
        else res.end(JSON.stringify({ status: 'completed', output: mode === 'empty' ? [] : [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const options = { accounts: () => accounts, cacheFile, now: () => now,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 500 };
    try {
        const service = createXingchiModelTest(options);
        assert.equal(service.read('a').results['gpt-6.1-sol'], undefined);
        assert.equal(calls, 0, 'cache read does not probe');
        const result = await service.test('a', 'gpt-6.1-sol');
        assert.equal(result.status, 'ok');
        assert.equal(result.httpStatus, 200);
        assert.equal(calls, 1);
        assert.equal(createXingchiModelTest(options).read('a').results['gpt-6.1-sol'].status, 'ok');
        now += 600001;
        assert.equal(service.read('a').results['gpt-6.1-sol'].stale, true);
        assert.equal(service.read('b').results['gpt-6.1-sol'], undefined);
        accounts[0].api_key = 'changed';
        assert.equal(service.read('a').results['gpt-6.1-sol'], undefined);
        accounts[0].api_key = 'secret-A';
        mode = 'fail';
        const failed = await service.test('a', 'gpt-6.1-sol');
        assert.equal(failed.status, 'error'); assert.equal(failed.httpStatus, 503);
        assert.ok(!failed.error.includes('secret-A'));
        assert.ok(!fs.readFileSync(cacheFile, 'utf8').includes('secret-A'));
        mode = 'empty'; assert.equal((await service.test('a', 'gpt-6.1-sol')).status, 'error');
        mode = 'slow'; const before = calls;
        const [x, y] = await Promise.all([service.test('a', 'gpt-6.1-sol'), service.test('a', 'gpt-6.1-sol')]);
        assert.equal(x.error, 'timeout'); assert.deepEqual(x, y); assert.equal(calls, before + 1);
        const count = calls;
        await assert.rejects(service.test('a', 'gpt-image-2'), /text/);
        await assert.rejects(service.test('missing', 'gpt-6.1-sol'), /account/);
        await assert.rejects(service.test('a', ''), /model/);
        assert.equal(calls, count);
        console.log('PASS Xingchi: real HTTP, cache/reload/stale/key scope, errors/timeout/dedup, no image requests');
    } finally {
        server.closeAllConnections(); await new Promise(r => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
