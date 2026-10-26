#!/usr/bin/env node
'use strict';
// Actual converter subprocesses and localhost fixtures only. No real keys or upstreams.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const SCRIPT = path.resolve(__dirname, '../routing/custom-openai-proxy.js');
const MODEL = 'deepseek/Flash-Test[1m]';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok ' + name); }
    catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
}
const baseRequest = extra => ({ model: MODEL, max_tokens: 2048, messages: [{ role: 'user', content: 'hello' }], ...extra });
const data = value => 'data: ' + JSON.stringify(value) + '\n\n';
const delta = value => ({ choices: [{ delta: value, finish_reason: null }] });
const finish = reason => ({ choices: [{ delta: {}, finish_reason: reason }] });
function parseEvents(raw) {
    return raw.split(/\r?\n/).filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));
}
function collectContent(events) {
    const blocks = [];
    for (const e of events) {
        if (e.type === 'content_block_start') blocks[e.index] = { ...e.content_block };
        if (e.type !== 'content_block_delta') continue;
        const b = blocks[e.index]; assert.ok(b, 'delta before block start');
        if (e.delta.type === 'text_delta') b.text += e.delta.text;
        if (e.delta.type === 'thinking_delta') b.thinking += e.delta.thinking;
        if (e.delta.type === 'input_json_delta') b._json = (b._json || '') + e.delta.partial_json;
    }
    return blocks.filter(Boolean).map(b => { if (b.type === 'tool_use') { b.input = JSON.parse(b._json || '{}'); delete b._json; } return b; });
}
async function freePort() {
    const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
    const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p;
}
(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-converter-'));
    const calls = [], children = [];
    let respond = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl_fixture', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2 } }));
    };
    const normal = respond;
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            calls.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
            Promise.resolve(respond(req, res)).catch(e => { res.destroy(); console.error('fixture error: ' + e.message); });
        });
    });
    async function start(strict) {
        const tag = strict ? 'strict' : 'legacy', port = await freePort();
        const keyFile = path.join(dir, tag + '-key.txt'), configFile = path.join(dir, tag + '.json');
        fs.writeFileSync(keyFile, 'fixture-file-key\n');
        fs.writeFileSync(configFile, JSON.stringify({ port, upstream: 'http://127.0.0.1:' + upstream.address().port + '/v1', keyFile, modelMap: {}, providerName: 'fixture', ...(strict ? { strictToolsVision: true } : {}) }));
        const child = spawn(process.execPath, [SCRIPT, configFile], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OPENAI_API_KEY: 'fixture-env-key', PROXY_LOG_INGEST_URL: 'disabled', REASONING_AS: strict ? 'drop' : 'thinking' } });
        children.push(child); let output = '';
        child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
        const base = 'http://127.0.0.1:' + port;
        for (let i = 0; i < 60; i++) {
            if (child.exitCode !== null) throw new Error('converter exited: ' + output);
            try { const r = await fetch(base + '/health', { signal: AbortSignal.timeout(200) }); if (r.ok) return { base, keyFile, child }; }
            catch { /* wait for this new test subprocess */ }
            await wait(40);
        }
        throw new Error('converter did not start: ' + output);
    }
    async function ask(instance, body, endpoint = '/v1/messages', headers = {}) {
        const r = await fetch(instance.base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-client-key', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
        return { status: r.status, text: await r.text() };
    }
    try {
        upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
        const strict = await start(true), legacy = await start(false);
        await test('strict key file is primary, never the caller or environment key', async () => {
            respond = normal; await ask(strict, baseRequest());
            assert.equal(calls.at(-1).headers.authorization, 'Bearer fixture-file-key');
        });
        await test('missing or empty strict key fails before upstream including models', async () => {
            try {
                for (const missing of [false, true]) {
                    if (missing) fs.unlinkSync(strict.keyFile); else fs.writeFileSync(strict.keyFile, ' \n');
                    const before = calls.length;
                    assert.equal((await ask(strict, baseRequest())).status, 401);
                    const r = await fetch(strict.base + '/v1/models', { headers: { 'x-api-key': 'fixture-client-key' }, signal: AbortSignal.timeout(3000) });
                    assert.equal(r.status, 401); await r.text(); assert.equal(calls.length, before);
                }
            } finally { fs.writeFileSync(strict.keyFile, 'fixture-file-key\n'); }
        });
        await test('strict health never exposes a credential file path', async () => {
            const text = await (await fetch(strict.base + '/health')).text();
            assert.equal(JSON.parse(text).keyFile, undefined); assert.ok(!text.includes(strict.keyFile));
        });
        const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636460f85f0f0002870180eb47ba920000000049454e44ae426082', 'hex').toString('base64') } };
        await test('native user images preserve base64 and URL parts without text serialization', async () => {
            respond = normal;
            const r = await ask(strict, baseRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect' }, image, { type: 'image', source: { type: 'url', url: 'https://images.example.invalid/card.png' } }] }] }));
            assert.equal(r.status, 200);
            const content = calls.at(-1).body.messages[0].content;
            assert.equal(content.length, 3); assert.equal(content[1].image_url.url, 'data:image/png;base64,' + image.source.data);
            assert.equal(content[2].image_url.url, 'https://images.example.invalid/card.png');
            assert.ok(content.filter(p => p.type === 'text').every(p => !p.text.includes(image.source.data)));
        });
        await test('tool-result image moves to a user image part linked to the original tool ID', async () => {
            await ask(strict, baseRequest({ messages: [
                { role: 'assistant', content: [{ type: 'thinking', thinking: 'inspect result' }, { type: 'tool_use', id: 'call_image', name: 'read_image', input: {} }] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_image', content: [{ type: 'text', text: 'screen captured' }, image] }, { type: 'text', text: 'describe it' }] },
            ] }));
            const messages = calls.at(-1).body.messages;
            assert.equal(messages[1].role, 'tool'); assert.equal(messages[1].tool_call_id, 'call_image'); assert.equal(messages[1].content, 'screen captured');
            assert.equal(messages[2].role, 'user'); assert.ok(Array.isArray(messages[2].content));
            assert.ok(messages[2].content.some(p => p.type === 'text' && p.text.includes('call_image')));
            assert.ok(messages[2].content.some(p => p.type === 'image_url' && p.image_url.url.endsWith(image.source.data)));
            assert.equal(messages[0].reasoning_content, 'inspect result');
        });
        await test('DeepSeek thinking request drops Anthropic-only fields and response keeps client model', async () => {
            for (const type of ['enabled', 'adaptive', 'disabled']) {
                const r = await ask(strict, baseRequest({ thinking: { type, budget_tokens: 1500 }, output_config: { effort: 'high' } }));
                const sent = calls.at(-1).body;
                assert.deepEqual(sent.thinking, { type: type === 'disabled' ? 'disabled' : 'enabled' });
                assert.equal(sent.output_config, undefined); assert.equal(sent.model, 'deepseek/Flash-Test');
                assert.equal(JSON.parse(r.text).model, MODEL);
            }
        });
        await test('UTF8 split SSE preserves exact text, usage and terminal events', async () => {
            respond = async (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                const payload = Buffer.from(data(delta({ content: 'hello Ж中' })) + data(finish('stop')) + data({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } }) + 'data: [DONE]\n\n');
                const cut = payload.indexOf(Buffer.from('Ж')) + 1;
                res.write(payload.subarray(0, cut)); await wait(20); res.end(payload.subarray(cut));
            };
            const r = await ask(strict, baseRequest({ stream: true })); const events = parseEvents(r.text);
            assert.equal(collectContent(events)[0].text, 'hello Ж中');
            assert.deepEqual(events.find(e => e.type === 'message_delta').usage, { input_tokens: 42, output_tokens: 7 });
            assert.equal(events.filter(e => e.type === 'message_stop').length, 1); assert.equal(events[0].message.model, MODEL);
        });
        await test('late tool ID/name and early split arguments survive a two-turn reasoning loop', async () => {
            respond = (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end([delta({ reasoning_content: 'keep this thought' }), delta({ tool_calls: [{ index: 0, function: { arguments: '{"tag":' } }] }),
                    delta({ tool_calls: [{ index: 0, function: { name: 'read_' } }] }), delta({ tool_calls: [{ index: 0, id: 'call_exact', function: { name: 'marker', arguments: '"a6"}' } }] }),
                    finish('tool_calls'), { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9 } }].map(data).join('') + 'data: [DONE]\n\n');
            };
            const r = await ask(strict, baseRequest({ stream: true })), events = parseEvents(r.text), content = collectContent(events);
            const tool = content.find(b => b.type === 'tool_use');
            assert.deepEqual(tool, { type: 'tool_use', id: 'call_exact', name: 'read_marker', input: { tag: 'a6' } });
            respond = normal;
            await ask(strict, baseRequest({ thinking: { type: 'enabled' }, messages: [baseRequest().messages[0], { role: 'assistant', content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'MARKER' }] }] }));
            const sent = calls.at(-1).body;
            assert.equal(sent.messages[1].reasoning_content, 'keep this thought'); assert.equal(sent.messages[1].tool_calls[0].id, 'call_exact');
            assert.equal(sent.messages[2].tool_call_id, 'call_exact'); assert.equal(sent.messages[2].content, 'MARKER');
        });
        await test('strict usage preserves explicit zero instead of substituting an estimate', async () => {
            respond = (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(data(delta({ content: 'ok' })) + data(finish('stop')) + data({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }) + 'data: [DONE]\n\n');
            };
            const events = parseEvents((await ask(strict, baseRequest({ stream: true }))).text);
            assert.deepEqual(events.find(e => e.type === 'message_delta').usage, { input_tokens: 0, output_tokens: 0 });
        });
        await test('parallel tool deltas emit complete, non-overlapping Anthropic blocks', async () => {
            respond = (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(data(delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'beta', arguments: '{}' } }, { index: 0, id: 'a', function: { name: 'alpha', arguments: '{}' } }] })) + data(finish('tool_calls')) + 'data: [DONE]\n\n');
            };
            const events = parseEvents((await ask(strict, baseRequest({ stream: true }))).text);
            let active = null;
            for (const event of events) {
                if (event.type === 'content_block_start') { assert.equal(active, null); active = event.index; }
                if (event.type === 'content_block_delta') assert.equal(event.index, active);
                if (event.type === 'content_block_stop') { assert.equal(event.index, active); active = null; }
            }
            assert.equal(active, null); assert.deepEqual(collectContent(events).map(b => b.id), ['a', 'b']);
        });
        await test('non-stream response preserves split UTF8 and actual zero usage', async () => {
            respond = async (_req, res) => {
                res.writeHead(200, { 'content-type': 'application/json' });
                const bytes = Buffer.from(JSON.stringify({ choices: [{ message: { content: 'Ж中' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
                const cut = bytes.indexOf(Buffer.from('Ж')) + 1;
                res.write(bytes.subarray(0, cut)); await wait(20); res.end(bytes.subarray(cut));
            };
            const body = JSON.parse((await ask(strict, baseRequest())).text);
            assert.equal(body.content[0].text, 'Ж中'); assert.deepEqual(body.usage, { input_tokens: 0, output_tokens: 0 });
        });
        await test('split UTF8 in the incoming Anthropic JSON is preserved upstream', async () => {
            respond = normal;
            const bytes = Buffer.from(JSON.stringify(baseRequest({ messages: [{ role: 'user', content: 'Ж中' }] })));
            const cut = bytes.indexOf(Buffer.from('Ж')) + 1;
            await new Promise((resolve, reject) => {
                const req = http.request(strict.base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', resolve); });
                req.on('error', reject); req.write(bytes.subarray(0, cut)); setTimeout(() => req.end(bytes.subarray(cut)), 20);
            });
            assert.equal(calls.at(-1).body.messages[0].content, 'Ж中');
        });
        for (const mode of ['no-done', 'no-finish', 'error', 'bad-json', 'aborted']) await test('strict stream ' + mode + ' is an error, never message_stop', async () => {
            respond = (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(data(delta({ content: 'partial' })));
                if (mode === 'aborted') { setTimeout(() => res.destroy(), 20); return; }
                if (mode === 'error') res.write(data({ error: { message: 'fixture-file-key' } }));
                if (mode === 'bad-json') res.write('data: {broken\n\n');
                if (mode !== 'no-finish') res.write(data(finish('stop')));
                if (mode !== 'no-done') res.write('data: [DONE]\n\n');
                res.end();
            };
            const r = await ask(strict, baseRequest({ stream: true }));
            assert.ok(r.text.includes('"type":"error"')); assert.ok(!r.text.includes('"type":"message_stop"'));
            assert.ok(!r.text.includes('fixture-file-key'));
        });
        await test('non-stream error envelopes and malformed tool arguments are not success messages', async () => {
            for (const body of [{ error: { message: 'fixture-file-key' } }, { choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'tool', arguments: '{broken' } }] }, finish_reason: 'tool_calls' }] }]) {
                respond = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
                const r = await ask(strict, baseRequest()); assert.equal(r.status, 502); assert.ok(!r.text.includes('fixture-file-key'));
            }
        });
        await test('strict non-stream tool reasoning survives a legacy REASONING_AS override', async () => {
            respond = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { reasoning_content: 'tool thought', tool_calls: [{ id: 'c', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })); };
            const r = JSON.parse((await ask(strict, baseRequest())).text);
            assert.equal(r.content[0].type, 'thinking'); assert.equal(r.content[0].thinking, 'tool thought');
        });
        await test('aborted non-stream response returns a bounded error and leaves converter healthy', async () => {
            respond = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"choices":['); setTimeout(() => res.destroy(), 20); };
            const r = await ask(strict, baseRequest()); assert.equal(r.status, 502); assert.equal(JSON.parse(r.text).type, 'error');
            assert.equal((await fetch(strict.base + '/health')).status, 200);
        });
        await test('strict tool stream with invalid arguments or missing ID is never executable', async () => {
            for (const tool of [{ index: 0, id: 'c', function: { name: 'read', arguments: '{bad' } }, { index: 0, function: { name: 'read', arguments: '{}' } }]) {
                respond = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(data(delta({ tool_calls: [tool] })) + data(finish('tool_calls')) + 'data: [DONE]\n\n'); };
                const events = parseEvents((await ask(strict, baseRequest({ stream: true }))).text);
                assert.ok(events.some(e => e.type === 'error')); assert.ok(!events.some(e => e.type === 'message_stop' || e.content_block?.type === 'tool_use'));
            }
        });
        await test('length and a final DONE without newline complete a valid strict text response', async () => {
            respond = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(data(delta({ content: 'partial text' })) + data(finish('length')) + 'data: [DONE]'); };
            const events = parseEvents((await ask(strict, baseRequest({ stream: true }))).text);
            assert.equal(events.find(e => e.type === 'message_delta').delta.stop_reason, 'max_tokens'); assert.ok(events.some(e => e.type === 'message_stop'));
        });
        await test('HTTP upstream failures are sanitized in strict mode', async () => {
            respond = (_req, res) => { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'fixture-file-key' } })); };
            const r = await ask(strict, baseRequest()); assert.equal(r.status, 401); assert.ok(!r.text.includes('fixture-file-key'));
        });
        await test('client cancellation closes the upstream response', async () => {
            let ended; const closed = new Promise(resolve => { ended = resolve; });
            respond = (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(data(delta({ content: 'start' })));
                const timer = setInterval(() => res.write(': ping\n\n'), 30);
                res.on('close', () => { clearInterval(timer); ended(); });
            };
            await new Promise((resolve, reject) => {
                const req = http.request(strict.base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
                    res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
                }); req.on('error', reject); req.end(JSON.stringify(baseRequest({ stream: true })));
            });
            await Promise.race([closed, wait(1200).then(() => { throw new Error('upstream still open'); })]);
        });
        await test('count_tokens is local, keyless and does not count base64 as text', async () => {
            const before = calls.length; fs.writeFileSync(strict.keyFile, '');
            try {
                const count = async dataValue => JSON.parse((await ask(strict, baseRequest({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: [image, { type: 'text', text: 'result' }] }, { ...image, source: { ...image.source, data: dataValue } }] }], tools: [{ name: 'read', description: 'Read the image', input_schema: { type: 'object' } }] }), '/v1/messages/count_tokens')).text).input_tokens;
                assert.equal(await count('A'.repeat(4000)), await count('QQ==')); assert.ok(await count('QQ==') > 10);
                assert.equal(calls.length, before);
            } finally { fs.writeFileSync(strict.keyFile, 'fixture-file-key\n'); }
        });
        await test('legacy mode keeps header-first key and prior thinking/model behavior', async () => {
            respond = normal;
            await ask(legacy, baseRequest({ thinking: { type: 'enabled', budget_tokens: 1500 }, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'old' }, { type: 'tool_use', id: 'call', name: 'read', input: {} }] }] }));
            const sent = calls.at(-1);
            assert.equal(sent.headers.authorization, 'Bearer fixture-client-key'); assert.equal(sent.body.thinking, undefined);
            assert.equal(sent.body.messages[0].reasoning_content, undefined); assert.equal(sent.body.model, 'deepseek/flash-test');
        });
        // 25.10: Claude Code кладёт сводку компакта в историю с тегами <analysis>/<summary>,
        // модель на a6api видит образец и начинает отвечать тем же форматом вместо ответа.
        // Обёртки снимаем из исходящей истории, но НЕ из самого запроса сжатия.
        const SCAFFOLD_HISTORY = [
            { role: 'user', content: 'This session is being continued from a previous conversation.\n\n<analysis>\nвнутренние заметки\n</analysis>\n\n<summary>\n1. Пользователь просил починить прокси.\n</summary>' },
            { role: 'assistant', content: 'Понял.' },
            { role: 'user', content: 'продолжай' },
        ];
        await test('strict history drops summary scaffold wrappers and keeps the text', async () => {
            respond = normal;
            const r = await ask(strict, baseRequest({ messages: SCAFFOLD_HISTORY }));
            assert.equal(r.status, 200);
            const first = calls.at(-1).body.messages[0].content;
            assert.ok(!/<analysis>|<\/analysis>|<summary>|<\/summary>/.test(first), 'обёртки сняты');
            assert.match(first, /Пользователь просил починить прокси/, 'содержимое сводки сохранено');
            assert.ok(!/внутренние заметки/.test(first), 'блок analysis выброшен целиком');
            assert.equal(calls.at(-1).body.messages[2].content, 'продолжай', 'обычный ход не тронут');
        });
        await test('legacy history keeps the scaffold exactly as sent', async () => {
            respond = normal;
            await ask(legacy, baseRequest({ messages: SCAFFOLD_HISTORY }));
            assert.match(calls.at(-1).body.messages[0].content, /<analysis>[\s\S]*<\/summary>/, 'старый путь байт в байт');
        });
        await test('real compaction request keeps its tags', async () => {
            respond = normal;
            const compact = [
                { role: 'user', content: '<analysis>\nстарая сводка\n</analysis>\n\n<summary>\nстарое\n</summary>' },
                { role: 'user', content: 'Your task is to create a detailed summary of the conversation so far, paying close attention to the user\'s explicit requests. Wrap your analysis in <analysis> tags to organize your thoughts.' },
            ];
            await ask(strict, baseRequest({ messages: compact }));
            const sent = calls.at(-1).body.messages;
            assert.match(sent[0].content, /<analysis>/, 'историю не чистим, когда это запрос сжатия');
            assert.match(sent[sent.length - 1].content, /<analysis> tags/, 'инструкция сжатия доходит целиком');
        });
        await test('legacy stream retains zero-usage fallback and permissive completion', async () => {
            respond = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(data(delta({ content: 'ok' })) + data({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }) + data(finish('stop'))); };
            const r = await ask(legacy, baseRequest({ stream: true })), events = parseEvents(r.text);
            assert.ok(events.some(e => e.type === 'message_stop'));
            const usage = events.find(e => e.type === 'message_delta').usage;
            assert.ok(usage.input_tokens > 0); assert.ok(usage.output_tokens > 0);
        });
    } finally {
        for (const child of children) {
            if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
        }
        upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(`check-a6api-converter: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1;
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
