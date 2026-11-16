#!/usr/bin/env node
'use strict';
// Real converter subprocess in a scratch sandbox; localhost fixtures, no vendor calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const requestBody = extra => ({ model: 'claude-sonnet-4[1m]', max_tokens: 128, messages: [{ role: 'user', content: 'hello' }], ...extra });
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const textEvent = text => ({ type: 'response.output_text.delta', delta: text });
const terminal = (extra = {}) => ({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', usage: { input_tokens: 12, output_tokens: 2 }, ...extra } });
const normalBody = () => ({ id: 'resp_fixture', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 12, output_tokens: 2 } });
const jsonReply = body => (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const streamReply = events => (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(frame).join('')); };
const eventsFrom = text => text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim()));
function contentFrom(events) {
    const blocks = [];
    for (const e of events) {
        if (e.type === 'content_block_start') blocks[e.index] = { ...e.content_block };
        if (e.type !== 'content_block_delta') continue;
        assert.ok(blocks[e.index], 'delta must follow its block start');
        if (e.delta.type === 'text_delta') blocks[e.index].text += e.delta.text;
        if (e.delta.type === 'input_json_delta') blocks[e.index]._json = (blocks[e.index]._json || '') + e.delta.partial_json;
    }
    return blocks.filter(Boolean).map(b => {
        if (b.type === 'tool_use') { b.input = JSON.parse(b._json || '{}'); delete b._json; }
        return b;
    });
}
async function freePort() {
    const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
(async () => {
    const scratch = process.env.TMPDIR || path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch');
    fs.mkdirSync(scratch, { recursive: true });
    const dir = fs.mkdtempSync(path.join(scratch, 'freegg-converter-'));
    const routing = path.join(dir, 'routing'); fs.mkdirSync(path.join(routing, 'lib'), { recursive: true });
    for (const file of ['freegg-proxy.js', 'proxy-logger.js', 'lib/usage-normalize.js'])
        fs.copyFileSync(path.resolve(__dirname, '../routing', file), path.join(routing, file));
    fs.writeFileSync(path.join(routing, 'freegg-modelmap.json'), JSON.stringify({ opus: 'Fixture-Opus', sonnet: 'Fixture-Sonnet', haiku: 'Fixture-Haiku' }));
    const keyFile = path.join(dir, 'freegg-key.txt'); fs.writeFileSync(keyFile, 'fixture-file-key\n');
    const calls = [];
    let respond = jsonReply(normalBody()), child, output = '', passed = 0, failed = 0;
    const upstream = http.createServer((req, res) => {
        const chunks = []; req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            calls.push({ url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null });
            Promise.resolve(respond(req, res)).catch(e => { console.error('fixture error: ' + e.message); res.destroy(); });
        });
    });
    async function ask(body = requestBody(), headers = { 'x-api-key': 'fixture-client-key' }, endpoint = '/v1/messages') {
        const res = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
        return { status: res.status, text: await res.text() };
    }
    async function test(name, fn) {
        if (process.argv[2] && !name.includes(process.argv[2])) return;
        try { await fn(); passed++; console.log('  ok ' + name); }
        catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
    }
    let base;
    try {
        upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
        const port = await freePort(); base = 'http://127.0.0.1:' + port;
        child = spawn(process.execPath, [path.join(routing, 'freegg-proxy.js')], {
            cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, FG_LISTEN_PORT: String(port), FG_UPSTREAM_BASE: 'http://127.0.0.1:' + upstream.address().port + '/v1', FG_KEY_FILE: keyFile, PROXY_LOG_INGEST_URL: 'disabled' },
        });
        child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
        let ready = false;
        for (let i = 0; i < 60; i++) {
            if (child.exitCode !== null) throw new Error('converter exited: ' + output);
            try { const r = await fetch(base + '/health', { signal: AbortSignal.timeout(200) }); await r.text(); if (r.ok) { ready = true; break; } } catch {}
            await wait(40);
        }
        assert.ok(ready, 'converter did not start: ' + output);
        await test('assistant string history uses output_text', async () => {
            respond = jsonReply(normalBody());
            const result = await ask(requestBody({ messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'previous answer' }, { role: 'user', content: 'continue' }] }));
            assert.equal(result.status, 200);
            assert.deepEqual(calls.at(-1).body.input[1], { role: 'assistant', content: [{ type: 'output_text', text: 'previous answer' }] });
        });
        await test('split UTF8 SSE preserves exact text and usage', async () => {
            respond = async (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                const payload = Buffer.from(frame(textEvent('hello Ж中🙂')) + frame(terminal()));
                const cut = payload.indexOf(Buffer.from('Ж')) + 1;
                res.write(payload.subarray(0, cut)); await wait(30); res.end(payload.subarray(cut));
            };
            const r = await ask(requestBody({ stream: true })); const events = eventsFrom(r.text);
            assert.equal(contentFrom(events)[0].text, 'hello Ж中🙂');
            assert.deepEqual(events.find(e => e.type === 'message_delta').usage, { input_tokens: 12, output_tokens: 2 });
            assert.equal(events.filter(e => e.type === 'message_stop').length, 1);
        });
        await test('content filter refusal is verbatim with exactly one generation', async () => {
            const refusal = "I'm sorry, but I cannot assist with that request.";
            respond = streamReply([{ type: 'response.output_text.delta', delta: refusal }, {
                type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, usage: { input_tokens: 0, output_tokens: 0 } },
            }]);
            const before = calls.length;
            const result = await ask(requestBody({ stream: true }));
            assert.equal(calls.length - before, 1, 'converter must not retry safety refusals');
            assert.equal(result.status, 200);
            const events = eventsFrom(result.text);
            assert.equal(contentFrom(events)[0].text, refusal);
            assert.deepEqual(events.find(e => e.type === 'message_delta').usage, { input_tokens: 0, output_tokens: 0 });
            assert.equal(events.filter(e => e.type === 'message_stop').length, 1);
        });
        await test('stream without response terminal is never successful', async () => {
            for (const ending of ['', 'data: [DONE]\n\n']) {
                respond = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame(textEvent('partial')) + ending); };
                const result = await ask(requestBody({ stream: true })); const events = eventsFrom(result.text);
                assert.ok(events.some(e => e.type === 'error'), 'missing terminal must produce error');
                assert.ok(!events.some(e => e.type === 'message_stop' || e.type === 'message_delta'), 'no success terminal after truncation');
            }
        });
        await test('selected caller key wins over active FreeGG file', async () => {
            respond = jsonReply(normalBody());
            for (const headers of [{ 'x-api-key': 'selected-account-key' }, { authorization: 'Bearer selected-account-key', 'x-api-key': 'dummy' }]) {
                await ask(requestBody(), headers);
                assert.equal(calls.at(-1).headers.authorization, 'Bearer selected-account-key');
            }
        });
        await test('health has exact FreeGG provider identity', async () => {
            const health = await (await fetch(base + '/health')).json();
            assert.equal(health.provider, 'freegg');
            assert.deepEqual(health.modelMap, { opus: 'Fixture-Opus', sonnet: 'Fixture-Sonnet', haiku: 'Fixture-Haiku' });
        });
        await test('committed upstream failure closes active generation', async () => {
            let closed; const upstreamClosed = new Promise(resolve => { closed = resolve; });
            respond = (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(frame(textEvent('partial')));
                const timer = setInterval(() => res.write(': ping\n\n'), 30);
                res.on('close', () => { clearInterval(timer); closed(); });
                setTimeout(() => res.write(frame({ type: 'response.failed', response: { error: { code: 'server_error', message: 'fixture failed' } } })), 30);
            };
            const result = await ask(requestBody({ stream: true })); const events = eventsFrom(result.text);
            assert.ok(events.some(e => e.type === 'error'));
            assert.ok(!events.some(e => e.type === 'message_stop'));
            await Promise.race([upstreamClosed, wait(800).then(() => { throw new Error('upstream generation still open after committed error'); })]);
        });
        await test('tool-only stream carries usage and round-trips into second turn', async () => {
            const tool = { type: 'function_call', id: 'fc_fixture', call_id: 'call_exact', name: 'read_marker', arguments: '{"tag":"freegg"}' };
            respond = streamReply([
                { type: 'response.output_item.added', output_index: 0, item: { ...tool, arguments: '' } },
                { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"tag":' },
                { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"freegg"}' },
                { type: 'response.output_item.done', output_index: 0, item: tool },
                terminal({ output: [tool], usage: { input_tokens: 1042, output_tokens: 9, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 } } }),
            ]);
            const events = eventsFrom((await ask(requestBody({ stream: true, tools: [{ name: 'read_marker', input_schema: { type: 'object', properties: { tag: { type: 'string' } } } }] }))).text);
            const content = contentFrom(events);
            assert.deepEqual(content, [{ type: 'tool_use', id: 'call_exact', name: 'read_marker', input: { tag: 'freegg' } }]);
            assert.deepEqual(events.find(e => e.type === 'message_delta').usage, { input_tokens: 42, output_tokens: 9, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 });
            assert.equal(events.find(e => e.type === 'message_delta').delta.stop_reason, 'tool_use');
            respond = jsonReply(normalBody());
            await ask(requestBody({ messages: [requestBody().messages[0], { role: 'assistant', content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_exact', content: 'MARKER' }] }] }));
            const input = calls.at(-1).body.input;
            assert.deepEqual(input[1], { type: 'function_call', call_id: 'call_exact', name: 'read_marker', arguments: '{"tag":"freegg"}' });
            assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'call_exact', output: 'MARKER' });
        });
        await test('non-stream tool response keeps usage and exact call ID', async () => {
            respond = jsonReply({ ...normalBody(), output: [{ type: 'function_call', call_id: 'call_exact', name: 'read_marker', arguments: '{"tag":"freegg"}' }], usage: { input_tokens: 1042, output_tokens: 9, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 } } });
            const result = JSON.parse((await ask()).text);
            assert.deepEqual(result.content, [{ type: 'tool_use', id: 'call_exact', name: 'read_marker', input: { tag: 'freegg' } }]);
            assert.equal(result.stop_reason, 'tool_use');
            assert.deepEqual(result.usage, { input_tokens: 42, output_tokens: 9, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 });
            respond = jsonReply(normalBody());
            await ask(requestBody({ messages: [{ role: 'assistant', content: result.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_exact', content: [{ type: 'text', text: 'MARKER' }] }] }] }));
            assert.deepEqual(calls.at(-1).body.input, [
                { type: 'function_call', call_id: 'call_exact', name: 'read_marker', arguments: '{"tag":"freegg"}' },
                { type: 'function_call_output', call_id: 'call_exact', output: 'MARKER' },
            ]);
        });
        await test('committed client cancellation aborts upstream', async () => {
            let closed; const upstreamClosed = new Promise(resolve => { closed = resolve; });
            respond = (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(frame(textEvent('start')));
                const timer = setInterval(() => res.write(': ping\n\n'), 30);
                res.on('close', () => { clearInterval(timer); closed(); });
            };
            await new Promise((resolve, reject) => {
                const req = http.request(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-client-key' } }, res => {
                    res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
                });
                req.on('error', reject); req.end(JSON.stringify(requestBody({ stream: true })));
            });
            await Promise.race([upstreamClosed, wait(800).then(() => { throw new Error('upstream still open after cancellation'); })]);
        });
        await test('key fallback reads only configured FreeGG file and fails closed when absent', async () => {
            respond = jsonReply(normalBody());
            await ask(requestBody(), { authorization: 'Bearer dummy' });
            assert.equal(calls.at(-1).headers.authorization, 'Bearer fixture-file-key');
            fs.writeFileSync(keyFile, 'fixture-rotated-key');
            await ask(requestBody(), {}); assert.equal(calls.at(-1).headers.authorization, 'Bearer fixture-rotated-key');
            try {
                fs.unlinkSync(keyFile); const before = calls.length;
                assert.equal((await ask(requestBody(), { authorization: 'Bearer dummy' })).status, 401);
                const models = await fetch(base + '/v1/models'); await models.text(); assert.equal(models.status, 401);
                assert.equal(calls.length, before);
            } finally { fs.writeFileSync(keyFile, 'fixture-file-key\n'); }
        });
        await test('native refusal content is preserved in both response modes', async () => {
            const refusal = 'I cannot provide that. Ж🙂';
            respond = jsonReply({ ...normalBody(), output: [{ type: 'message', content: [{ type: 'refusal', refusal }] }] });
            assert.equal(JSON.parse((await ask()).text).content[0].text, refusal);
            respond = streamReply([{ type: 'response.refusal.delta', delta: refusal }, terminal()]);
            assert.equal(contentFrom(eventsFrom((await ask(requestBody({ stream: true }))).text))[0].text, refusal);
        });
        await test('non-stream missing terminal status is a failure', async () => {
            for (const status of [undefined, 'in_progress', 'queued']) {
                respond = jsonReply({ ...normalBody(), status });
                const result = await ask(); assert.equal(result.status, 502); assert.equal(JSON.parse(result.text).type, 'error');
            }
        });
        await test('non-stream UTF8 split chunks preserve exact text', async () => {
            respond = async (_req, res) => {
                res.writeHead(200, { 'content-type': 'application/json' });
                const bytes = Buffer.from(JSON.stringify({ ...normalBody(), output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ж中🙂' }] }] }));
                const cut = bytes.indexOf(Buffer.from('Ж')) + 1;
                res.write(bytes.subarray(0, cut)); await wait(30); res.end(bytes.subarray(cut));
            };
            assert.equal(JSON.parse((await ask()).text).content[0].text, 'Ж中🙂');
        });
        await test('incoming split UTF8 JSON preserves user content upstream', async () => {
            respond = jsonReply(normalBody());
            const bytes = Buffer.from(JSON.stringify(requestBody({ messages: [{ role: 'user', content: 'Ж中🙂' }] })));
            const cut = bytes.indexOf(Buffer.from('Ж')) + 1;
            await new Promise((resolve, reject) => {
                const req = http.request(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-client-key' } }, res => { res.resume(); res.on('end', resolve); });
                req.on('error', reject); req.write(bytes.subarray(0, cut)); setTimeout(() => req.end(bytes.subarray(cut)), 30);
            });
            assert.equal(calls.at(-1).body.input[0].content[0].text, 'Ж中🙂');
        });
        await test('malformed SSE after content cannot end as success', async () => {
            respond = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame(textEvent('partial')) + 'data: {broken\n\n' + frame(terminal())); };
            const events = eventsFrom((await ask(requestBody({ stream: true }))).text);
            assert.ok(events.some(e => e.type === 'error'));
            assert.ok(!events.some(e => e.type === 'message_stop'));
        });
        await test('aborted non-stream upstream returns bounded error', async () => {
            respond = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"status":'); setTimeout(() => res.destroy(), 30); };
            const result = await ask(); assert.equal(result.status, 502); assert.equal(JSON.parse(result.text).type, 'error');
            assert.equal((await fetch(base + '/health')).status, 200);
        });
        await test('terminal failure events never synthesize success or retry', async () => {
            for (const [type, code, expected] of [['response.failed', 'rate_limit_exceeded', 429], ['error', 'bad_request', 502], ['response.failed', undefined, 502]]) {
                respond = streamReply([type === 'error' ? { type, code, message: 'fixture error' } : { type, response: { error: code ? { code, message: 'fixture error' } : null } }]);
                const before = calls.length; const result = await ask(requestBody({ stream: true }));
                assert.equal(result.status, expected); assert.equal(JSON.parse(result.text).type, 'error');
                assert.equal(calls.length - before, 1);
            }
        });
        await test('aborted committed stream is error with no success terminal', async () => {
            respond = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(frame(textEvent('partial'))); setTimeout(() => res.destroy(), 30); };
            const events = eventsFrom((await ask(requestBody({ stream: true }))).text);
            assert.ok(events.some(e => e.type === 'error')); assert.ok(!events.some(e => e.type === 'message_stop'));
        });
        await test('non-stream content-filter refusal remains verbatim with one generation', async () => {
            const refusal = "I'm sorry, but I cannot assist with that request.";
            respond = jsonReply({ ...normalBody(), status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [{ type: 'message', content: [{ type: 'output_text', text: refusal }] }], usage: { input_tokens: 0, output_tokens: 0 } });
            const before = calls.length; const result = await ask();
            assert.equal(result.status, 200); assert.equal(JSON.parse(result.text).content[0].text, refusal); assert.equal(calls.length - before, 1);
        });
        await test('terminal SSE without trailing newline still completes', async () => {
            respond = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame(textEvent('ok')) + 'data: ' + JSON.stringify(terminal())); };
            const events = eventsFrom((await ask(requestBody({ stream: true }))).text);
            assert.equal(events.filter(e => e.type === 'message_stop').length, 1);
            assert.deepEqual(events.find(e => e.type === 'message_delta').usage, { input_tokens: 12, output_tokens: 2 });
        });
        await test('failure without details after committed text cannot be success', async () => {
            respond = streamReply([textEvent('partial'), { type: 'response.failed', response: {} }, terminal()]);
            const events = eventsFrom((await ask(requestBody({ stream: true }))).text);
            assert.ok(events.some(e => e.type === 'error')); assert.ok(!events.some(e => e.type === 'message_stop'));
        });
        await test('non-stream cancellation closes active generation', async () => {
            let closed; const upstreamClosed = new Promise(resolve => { closed = resolve; });
            let accepted; const upstreamAccepted = new Promise(resolve => { accepted = resolve; });
            respond = (_req, res) => {
                res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"status":');
                const timer = setInterval(() => res.write(' '), 30);
                res.on('close', () => { clearInterval(timer); closed(); }); accepted();
            };
            const req = http.request(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-client-key' } });
            req.on('error', () => {}); req.end(JSON.stringify(requestBody()));
            await upstreamAccepted; req.destroy();
            await Promise.race([upstreamClosed, wait(800).then(() => { throw new Error('non-stream generation still open after cancellation'); })]);
        });
        await test('truncated upstream HTTP error body fails promptly in streaming mode', async () => {
            respond = (_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.write('{"error":'); setTimeout(() => res.destroy(), 30); };
            const result = await ask(requestBody({ stream: true })); assert.equal(result.status, 502); assert.equal(JSON.parse(result.text).type, 'error');
        });
        await test('text then tool stream emits arguments exactly once', async () => {
            const tool = { type: 'function_call', call_id: 'call_after_text', name: 'read_marker', arguments: '{"tag":"freegg"}' };
            respond = streamReply([textEvent('Checking.'), { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '' } },
                { type: 'response.function_call_arguments.delta', output_index: 1, delta: tool.arguments }, { type: 'response.output_item.done', output_index: 1, item: tool }, terminal({ output: [tool] })]);
            const events = eventsFrom((await ask(requestBody({ stream: true }))).text);
            assert.deepEqual(contentFrom(events), [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'call_after_text', name: 'read_marker', input: { tag: 'freegg' } }]);
            assert.equal(events.find(e => e.type === 'message_delta').delta.stop_reason, 'tool_use');
        });
        await test('HTTP authentication failure retains status and Anthropic error type', async () => {
            respond = (_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture unauthorized' } })); };
            for (const stream of [false, true]) {
                const before = calls.length; const result = await ask(requestBody({ stream }));
                assert.equal(result.status, 401); assert.equal(JSON.parse(result.text).error.type, 'authentication_error');
                assert.equal(calls.length - before, 1);
            }
        });
        await test('invalid response terminal status cannot declare success', async () => {
            for (const status of [undefined, 'failed', 'in_progress']) {
                respond = streamReply([textEvent('partial'), terminal({ status })]);
                const events = eventsFrom((await ask(requestBody({ stream: true }))).text);
                assert.ok(events.some(e => e.type === 'error')); assert.ok(!events.some(e => e.type === 'message_stop'));
            }
        });
        await test('malformed tool arguments never become an executable success', async () => {
            const tool = { type: 'function_call', call_id: 'call_broken', name: 'read_marker', arguments: '{broken' };
            respond = jsonReply({ ...normalBody(), output: [tool] });
            const result = await ask(); assert.equal(result.status, 502); assert.equal(JSON.parse(result.text).type, 'error');
            respond = streamReply([{ type: 'response.output_item.added', output_index: 0, item: { ...tool, arguments: '' } },
                { type: 'response.function_call_arguments.delta', output_index: 0, delta: tool.arguments },
                { type: 'response.output_item.done', output_index: 0, item: tool }, terminal({ output: [tool] })]);
            const streamed = await ask(requestBody({ stream: true }));
            if (streamed.status !== 200) {
                assert.equal(streamed.status, 502); assert.equal(JSON.parse(streamed.text).type, 'error');
            } else {
                const events = eventsFrom(streamed.text);
                assert.ok(events.some(e => e.type === 'error')); assert.ok(!events.some(e => e.type === 'message_stop'));
            }
        });
        await test('request mapping preserves Responses tools, images and explicit model case', async () => {
            respond = jsonReply(normalBody());
            await ask(requestBody({ model: 'Fixture-Cased[1m]', max_tokens: 1, system: [{ type: 'text', text: 'system rules' }], output_config: { effort: 'high' },
                messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QQ==' } }] }],
                tools: [{ name: 'read_marker', description: 'Read marker', input_schema: { type: 'object', properties: { tag: { type: 'string' } } } }], tool_choice: { type: 'tool', name: 'read_marker' } }));
            const call = calls.at(-1);
            assert.equal(call.url, '/v1/responses'); assert.equal(call.body.model, 'Fixture-Cased');
            assert.equal(call.body.max_output_tokens, 16); assert.equal(call.body.store, false);
            assert.equal(call.body.instructions, 'system rules'); assert.deepEqual(call.body.reasoning, { effort: 'high' });
            assert.deepEqual(call.body.tool_choice, { type: 'function', name: 'read_marker' });
            assert.equal(call.body.tools[0].type, 'function'); assert.equal(call.body.tools[0].name, 'read_marker');
            assert.deepEqual(call.body.input[0].content, [{ type: 'input_text', text: 'inspect' }, { type: 'input_image', image_url: 'data:image/png;base64,QQ==' }]);
        });
        await test('tier model map reloads without converter restart', async () => {
            respond = jsonReply(normalBody());
            await ask(); assert.equal(calls.at(-1).body.model, 'Fixture-Sonnet');
            const mapFile = path.join(routing, 'freegg-modelmap.json');
            fs.writeFileSync(mapFile, JSON.stringify({ opus: 'Next-Opus', sonnet: 'Next-Sonnet', haiku: 'Next-Haiku' }));
            const future = new Date(Date.now() + 2000); fs.utimesSync(mapFile, future, future);
            await ask(); assert.equal(calls.at(-1).body.model, 'Next-Sonnet');
        });
        await test('max output token terminal preserves partial content', async () => {
            respond = streamReply([textEvent('partial'), { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 20, output_tokens: 128 } } }]);
            const events = eventsFrom((await ask(requestBody({ stream: true }))).text);
            assert.equal(contentFrom(events)[0].text, 'partial'); assert.equal(events.find(e => e.type === 'message_delta').delta.stop_reason, 'max_tokens');
            assert.equal(events.filter(e => e.type === 'message_stop').length, 1);
        });
        await test('converter stays healthy after fixture errors with no uncaught warnings', async () => {
            const response = await fetch(base + '/health'); await response.text();
            assert.equal(response.status, 200);
            assert.ok(!/WARN (uncaught|rejection)/.test(output), 'converter emitted an uncaught exception: ' + output);
        });
    } finally {
        if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
        upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(`check-freegg-proxy: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
