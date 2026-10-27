#!/usr/bin/env node
'use strict';
// Actual frontdoor -> keepalive -> strict converter -> localhost fixture. No live APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const ROOT = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok ' + name); }
    catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
}
const requestBody = (model, extra = {}) => ({ model, max_tokens: 2048, messages: [{ role: 'user', content: 'local fixture' }], ...extra });
const data = x => 'data: ' + JSON.stringify(x) + '\n\n';
const delta = x => ({ choices: [{ delta: x, finish_reason: null }] });
const finish = reason => ({ choices: [{ delta: {}, finish_reason: reason }] });
const eventsOf = raw => raw.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
function contentOf(events) {
    const blocks = [];
    for (const event of events) {
        if (event.type === 'content_block_start') blocks[event.index] = { ...event.content_block };
        if (event.type !== 'content_block_delta') continue;
        const block = blocks[event.index]; assert.ok(block, 'delta before block start');
        if (event.delta.type === 'thinking_delta') block.thinking += event.delta.thinking;
        if (event.delta.type === 'text_delta') block.text += event.delta.text;
        if (event.delta.type === 'input_json_delta') block._json = (block._json || '') + event.delta.partial_json;
    }
    return blocks.filter(Boolean).map(block => {
        if (block.type === 'tool_use') { block.input = JSON.parse(block._json || '{}'); delete block._json; }
        return block;
    });
}
async function reservePort() {
    const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-stack-'));
    const children = [], generations = [], wrongActive = [], logs = [], ensures = [];
    let mode = 'normal';
    const mock = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8'), body = raw ? JSON.parse(raw) : null;
                if (req.url === '/logs') { logs.push(body); res.writeHead(200); res.end('{}'); return; }
                if (req.url === '/__switch/api/keepalive/ensure') { ensures.push(body); res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'fixture does not start gateways' })); return; }
                if (req.url.startsWith('/wrong/')) { wrongActive.push(body); res.writeHead(418, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'wrong active fixture' })); return; }
                if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [] })); return; }
                assert.equal(req.url, '/v1/chat/completions');
                generations.push({ body, headers: req.headers });
                if (mode === 'transient') { await wait(40); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'api_error', message: 'temporarily overloaded, please retry' } })); return; }
                if (body.stream) {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    const events = mode === 'tools' && !body.messages.some(m => m.role === 'tool')
                        ? [delta({ reasoning_content: 'inspect screenshot Ж' }), delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }), delta({ tool_calls: [{ index: 0, id: 'call_stack_image', function: { name: 'read_image', arguments: '"fixture.png"}' } }] }), finish('tool_calls')]
                        : [delta({ content: 'fixture complete Ж' }), finish('stop')];
                    res.end(events.map(data).join('') + data({ choices: [], usage: { prompt_tokens: 31, completion_tokens: 8 } }) + 'data: [DONE]\n\n');
                } else {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ id: 'chatcmpl_stack', model: body.model, choices: [{ message: { role: 'assistant', content: 'fixture complete' }, finish_reason: 'stop' }], usage: { prompt_tokens: 31, completion_tokens: 8 } }));
                }
            } catch (e) { res.writeHead(500); res.end('fixture error'); console.error('fixture: ' + e.message); }
        });
    });
    const file = name => path.join(dir, name);
    async function writeJson(name, value) { fs.writeFileSync(file(name), JSON.stringify(value) + '\n'); await wait(20); }
    async function jsonRequest(base, endpoint, body) {
        const r = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'other-provider', 'user-agent': 'claude-cli/fixture', 'accept-encoding': 'identity' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(7000) });
        const text = await r.text(); return { status: r.status, text, headers: r.headers };
    }
    async function start(name, script, args, extraEnv, endpoint) {
        const baseEnv = { ...process.env, HOME: dir, USERPROFILE: dir, NODE_OPTIONS: '',
            PROXY_LOG_INGEST_URL: 'http://127.0.0.1:' + mock.address().port + '/logs',
            TOKEN_USAGE_FILE: file(name + '-usage.jsonl'), OPENAI_API_KEY: 'fixture-unused-environment',
            REASONING_AS: 'thinking', LOG_FILE: file(name + '.log'),
            SWITCH_PORT: String(mock.address().port), SWITCHER_PORT: String(mock.address().port),
            DASHBOARD_URL: 'http://127.0.0.1:' + mock.address().port };
        const child = spawn(process.execPath, [path.join(ROOT, 'routing', script), ...args], { cwd: dir, env: { ...baseEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
        const outputFile = file(name + '-stdout.log'); let output = '';
        const onOutput = c => { output = (output + c.toString()).slice(-16000); fs.appendFileSync(outputFile, c); };
        child.stdout.on('data', onOutput); child.stderr.on('data', onOutput); children.push({ child, name });
        const base = 'http://127.0.0.1:' + extraEnv.PORT;
        for (let i = 0; i < 100; i++) {
            if (child.exitCode !== null || child.signalCode) throw new Error(name + ' exited: ' + output);
            try { const r = await fetch(base + endpoint, { signal: AbortSignal.timeout(200) }); await r.text(); if (r.ok) return base; }
            catch { /* only poll the new fixture child */ }
            await wait(40);
        }
        throw new Error(name + ' readiness timeout: ' + output);
    }
    try {
        mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
        const converterPort = await reservePort(), keepalivePort = await reservePort(), frontdoorPort = await reservePort(), unavailablePort = await reservePort();
        const providerMap = { default: 'deepseek-provider-main', opus: 'deepseek-provider-opus', sonnet: 'deepseek-provider-sonnet', haiku: 'deepseek-provider-haiku', gpt: '' };
        const routesMap = { default: 'deepseek-route-main', opus: 'deepseek-route-opus', sonnet: 'deepseek-route-sonnet', haiku: 'deepseek-route-haiku', gpt: '' };
        await writeJson('a6api-modelmap.json', providerMap); await writeJson('a6api-routes-modelmap.json', routesMap);
        fs.writeFileSync(file('active-key.txt'), 'fixture-key-one\n');
        await writeJson('converter.json', { port: converterPort, upstream: 'http://127.0.0.1:' + mock.address().port + '/v1', keyFile: file('active-key.txt'), modelMap: {}, providerName: 'a6api-fixture', strictToolsVision: true });
        const converter = await start('converter', 'custom-openai-proxy.js', [file('converter.json')], { PORT: String(converterPort) }, '/health');
        const clamp = { maxAttempts: 1, maxHedges: 0, hedgeMs: 0, holdMs: 0, emptyStreamMs: 0, catalogTtlMs: 0, poolFallbackModel: '', poolDeadMs: 0, visionBridge: false };
        await writeJson('keepalive.json', { v: 8, maxAttempts: 7, maxHedges: 3, hedgeMs: 1000, holdMs: 10000, emptyStreamMs: 30000, catalogTtlMs: 60000, poolFallbackModel: 'forbidden-fallback', poolDeadMs: 60000, visionBridge: true, preCommitMs: 0, jsonHoldMs: 0, stallMs: 0, retryBudgetMs: 10000, upstreamTimeoutMs: 20000 });
        const keepalive = await start('keepalive', 'keepalive-proxy.js', [], {
            PORT: String(keepalivePort), UPSTREAM: converter, KEY_FILE: file('active-key.txt'), MODELMAP_FILE: file('a6api-modelmap.json'), SESSIONS_FILE: '',
            PAID_SINGLE_KEY: '1', HAIKU_REMAP: '1', GPT_PROXY_FORCE: '0', HAIKU_GPT_PROXY: converter, UPSTREAM_NOSTREAM: '0', EMPTY_TEXT_FIX: '0',
            ROTATE_PROVIDER: 'a6api', AUTOROTATE: '1', MODEL_ECHO: '1', MODEL_ECHO_INJECT: '1', THINK_STRIP: '1',
            CONFIG_FILE: file('keepalive.json'), KEEPALIVE_LOG_FILE: file('keepalive.log'), LATENCY_FILE: file('latency.json'), EVENTS_FILE: file('events.json'), FAILDUMP_DIR: file('faildump'),
            COUNT_TOKENS_FALLBACK: '1', RETRY_FAST_FAIL_MS: '1', RETRY_DELAY_MS: '10', CONN_TRACE: '0', VISION_BRIDGE: '0',
        }, '/__state');
        const entry = { backend: 'a6api', upstream: keepalive, keyFile: file('active-key.txt'), modelmap: file('a6api-modelmap.json'), updatedAt: Date.now() };
        const decoy = { backend: 'wrong-active', upstream: 'http://127.0.0.1:' + mock.address().port + '/wrong', updatedAt: Date.now() };
        await writeJson('active-backend.json', entry);
        await writeJson('backends.json', { providers: { a6api: entry, failed: { ...entry, backend: 'failed', upstream: 'http://127.0.0.1:' + unavailablePort } }, aliases: {} });
        await writeJson('multi-routes-modelmap.json', {});
        const frontdoor = await start('frontdoor', 'frontdoor-proxy.js', [], { PORT: String(frontdoorPort), ACTIVE_BACKEND_FILE: file('active-backend.json'), BACKENDS_FILE: file('backends.json'), MULTI_MAP_FILE: file('multi-routes-modelmap.json'), UPSTREAM_TIMEOUT_MS: '6000', ENSURE_TIMEOUT_MS: '1000', ENSURE_COOLDOWN_MS: '1000' }, '/__frontdoor/api/status');
        async function state() { return JSON.parse((await jsonRequest(keepalive, '/__state')).text); }
        function assertClamp(s) {
            for (const [key, value] of Object.entries(clamp)) assert.equal(s.cfg[key], value, key);
            assert.equal(s.rotate.on, false); assert.equal(s.rotate.provider, 'a6api'); assert.equal(s.upstream, converter);
        }
        await test('single-key cfg and rotation are clamped after hostile startup config', async () => { assertClamp(await state()); });
        // Never exercise image requests if the clamp could call the production vision bridge.
        if ((await state()).cfg.visionBridge) throw new Error('unsafe fixture: visionBridge was not clamped');
        await test('bare /model a6api[1m] uses routes.default instead of the active backend', async () => {
            await writeJson('active-backend.json', decoy);
            const before = wrongActive.length, start = generations.length;
            const r = await jsonRequest(frontdoor, '/v1/messages', requestBody('a6api[1m]'));
            assert.equal(r.status, 200); assert.equal(generations.length, start + 1); assert.equal(generations.at(-1).body.model, routesMap.default);
            // Frontdoor strips the prefix before keepalive; echo follows the established protocol.
            assert.equal(JSON.parse(r.text).model, routesMap.default + '[1m]'); assert.equal(wrongActive.length, before);
            await writeJson('active-backend.json', entry);
        });
        await test('active native model passes through with client suffix echoed only downstream', async () => {
            await writeJson('active-backend.json', entry);
            const model = 'deepseek/Native-Exact[1m]', r = await jsonRequest(frontdoor, '/v1/messages', requestBody(model));
            assert.equal(r.status, 200); assert.equal(generations.at(-1).body.model, 'deepseek/Native-Exact'); assert.equal(JSON.parse(r.text).model, model);
        });
        for (const tier of ['opus', 'sonnet', 'haiku']) await test('active claude-' + tier + ' uses provider map', async () => {
            const model = 'claude-' + tier + '-5[1m]', r = await jsonRequest(frontdoor, '/v1/messages', requestBody(model));
            assert.equal(r.status, 200); assert.equal(generations.at(-1).body.model, providerMap[tier]); assert.equal(JSON.parse(r.text).model, model);
        });
        for (const tier of ['opus', 'sonnet', 'haiku']) await test('prefixed claude-' + tier + ' uses routes map', async () => {
            const model = 'claude-' + tier + '-5[1m]', r = await jsonRequest(frontdoor, '/v1/messages', requestBody('a6api/' + model));
            assert.equal(r.status, 200); assert.equal(generations.at(-1).body.model, routesMap[tier]); assert.equal(JSON.parse(r.text).model, model);
        });
        await test('explicit a6api/native model is not remapped to routes.default', async () => {
            const model = 'deepseek/Explicit-Exact[1m]', r = await jsonRequest(frontdoor, '/v1/messages', requestBody('a6api/' + model));
            assert.equal(r.status, 200); assert.equal(generations.at(-1).body.model, 'deepseek/Explicit-Exact'); assert.equal(JSON.parse(r.text).model, model);
        });
        await test('two-turn tools preserve reasoning and native user/tool-result images through all hops', async () => {
            mode = 'tools';
            try {
                const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636460f85f0f0002870180eb47ba920000000049454e44ae426082', 'hex').toString('base64') } };
                const model = 'deepseek-stack-vision[1m]';
                const body = requestBody('a6api/' + model, { stream: true, thinking: { type: 'enabled', budget_tokens: 1024 }, tools: [{ name: 'read_image', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect this and call read_image' }, image] }] });
                const first = await jsonRequest(frontdoor, '/v1/messages', body), events = eventsOf(first.text), content = contentOf(events);
                assert.equal(first.status, 200); assert.equal(events.find(e => e.type === 'message_start').message.model, model);
                assert.ok(events.some(e => e.type === 'message_stop'));
                assert.equal(generations.at(-1).body.model, 'deepseek-stack-vision'); assert.deepEqual(generations.at(-1).body.thinking, { type: 'enabled' });
                assert.ok(generations.at(-1).body.messages[0].content.some(p => p.type === 'image_url' && p.image_url.url.endsWith(image.source.data)));
                const tool = content.find(b => b.type === 'tool_use'); assert.equal(tool.id, 'call_stack_image'); assert.deepEqual(tool.input, { path: 'fixture.png' });
                const next = { ...body, messages: [...body.messages, { role: 'assistant', content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: [{ type: 'text', text: 'captured fixture' }, image] }] }] };
                const second = await jsonRequest(frontdoor, '/v1/messages', next), sent = generations.at(-1).body, secondEvents = eventsOf(second.text);
                const assistant = sent.messages.find(m => m.role === 'assistant'), result = sent.messages.find(m => m.role === 'tool');
                assert.equal(assistant.reasoning_content, 'inspect screenshot Ж'); assert.equal(assistant.tool_calls[0].id, tool.id);
                assert.equal(result.tool_call_id, tool.id); assert.equal(result.content, 'captured fixture'); assert.ok(!result.content.includes(image.source.data));
                const imageMessage = sent.messages[sent.messages.indexOf(result) + 1]; assert.equal(imageMessage.role, 'user');
                assert.ok(imageMessage.content.some(p => p.type === 'image_url' && p.image_url.url.endsWith(image.source.data)));
                assert.ok(imageMessage.content.some(p => p.type === 'text' && p.text.includes(tool.id)));
                assert.equal(secondEvents.find(e => e.type === 'message_start').message.model, model);
                assert.deepEqual(secondEvents.find(e => e.type === 'message_delta').usage, { input_tokens: 31, output_tokens: 8 }); assert.ok(secondEvents.some(e => e.type === 'message_stop'));
            } finally { mode = 'normal'; }
        });
        await test('active key file switch affects the next request without restarting children', async () => {
            fs.writeFileSync(file('active-key.txt'), 'fixture-key-two\n');
            const r = await jsonRequest(frontdoor, '/v1/messages', requestBody('a6api/deepseek-key'));
            assert.equal(r.status, 200); assert.equal(generations.at(-1).headers.authorization, 'Bearer fixture-key-two');
        });
        await test('missing active key never borrows incoming other-provider credentials', async () => {
            fs.unlinkSync(file('active-key.txt')); const before = generations.length;
            try { const r = await jsonRequest(frontdoor, '/v1/messages', requestBody('a6api/deepseek-key')); assert.equal(r.status, 401); assert.equal(generations.length, before); }
            finally { fs.writeFileSync(file('active-key.txt'), 'fixture-key-two\n'); }
        });
        await test('injected __config cannot reenable retries, hedges, fallback, or vision bridge', async () => {
            const r = await jsonRequest(keepalive, '/__config', { maxAttempts: 9, maxHedges: 3, hedgeMs: 1000, holdMs: 60000, emptyStreamMs: 30000, catalogTtlMs: 60000, poolFallbackModel: 'forbidden-other-model', poolDeadMs: 60000, visionBridge: true });
            assert.equal(r.status, 200); assertClamp(JSON.parse(r.text)); assertClamp(await state());
        });
        for (const stream of [false, true]) await test('transient 500 sends exactly one upstream generation (stream=' + stream + ')', async () => {
            mode = 'transient'; const before = generations.length;
            try {
                const r = await jsonRequest(frontdoor, '/v1/messages', requestBody('a6api/deepseek-error', { stream }));
                assert.ok(r.status >= 500 || r.text.includes('"type":"error"'), 'expected a surfaced upstream error');
                assert.equal(generations.length, before + 1); assert.ok(!r.text.includes('"type":"message_stop"'));
            } finally { mode = 'normal'; }
        });
        await test('count_tokens through the frontdoor performs no upstream generation', async () => {
            const before = generations.length;
            const r = await jsonRequest(frontdoor, '/v1/messages/count_tokens', requestBody('a6api[1m]'));
            assert.equal(r.status, 200); assert.ok(JSON.parse(r.text).input_tokens > 0); assert.equal(generations.length, before);
        });
        await test('missing route default fails closed instead of using a different active backend', async () => {
            await writeJson('active-backend.json', decoy); await writeJson('a6api-routes-modelmap.json', { ...routesMap, default: '' });
            const before = generations.length, wrongBefore = wrongActive.length;
            try { const r = await jsonRequest(frontdoor, '/v1/messages', requestBody('a6api[1m]')); assert.equal(r.status, 400); assert.equal(generations.length, before); assert.equal(wrongActive.length, wrongBefore); }
            finally { await writeJson('a6api-routes-modelmap.json', routesMap); await writeJson('active-backend.json', entry); }
        });
        await test('unreachable registered prefix cannot fall back to the different active backend', async () => {
            await writeJson('active-backend.json', decoy); const before = generations.length, wrongBefore = wrongActive.length, ensureBefore = ensures.length;
            try {
                const r = await jsonRequest(frontdoor, '/v1/messages', requestBody('failed/deepseek-explicit'));
                assert.equal(r.status, 502); assert.equal(generations.length, before); assert.equal(wrongActive.length, wrongBefore); assert.equal(ensures.length, ensureBefore + 1);
            } finally { await writeJson('active-backend.json', entry); }
        });
        await test('usage and operational files stay in the fixture directory', async () => {
            const usage = file('frontdoor-usage.jsonl'); assert.ok(fs.existsSync(usage));
            const rows = fs.readFileSync(usage, 'utf8').trim().split('\n').map(JSON.parse); assert.ok(rows.length > 0);
            assert.ok(fs.existsSync(file('keepalive.json'))); assert.ok(fs.existsSync(file('keepalive.log')));
            assertClamp(await state());
        });
    } finally {
        for (const { child } of children.reverse()) {
            if (child.exitCode === null && !child.signalCode) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
        }
        mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(`check-a6api-stack: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1;
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
