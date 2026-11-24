#!/usr/bin/env node
'use strict';
// Real frontdoor -> keepalive -> FreeGG Responses converter -> loopback fixture.
// No hub lifecycle, production credentials, production ports, or vendor traffic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const ROOT = path.resolve(__dirname, '..');
const SCRATCH = 'C:/Users/WormAlien/AppData/Local/hermes/cache/scratch';
const MODEL = 'freegg/gpt-6.1-sol';
const RAW_USAGE = { input_tokens: 100, output_tokens: 17, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } };
const USAGE = { input_tokens: 60, output_tokens: 17, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); console.log('  ok ' + name); }
    catch (error) { results.push({ name, ok: false, error: error.message }); console.error('  FAIL ' + name + ': ' + error.message); }
}
const bodyOf = extra => ({ model: MODEL, max_tokens: 2048, messages: [{ role: 'user', content: 'local fixture Ж' }], ...extra });
const data = event => 'data: ' + JSON.stringify(event) + '\n\n';
function eventsOf(raw) {
    return raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim()));
}
function contentOf(events) {
    const blocks = [];
    const closed = new Set();
    for (const event of events) {
        if (event.type === 'content_block_start') {
            assert.equal(blocks[event.index], undefined, 'duplicate block start');
            blocks[event.index] = { ...event.content_block };
        }
        if (event.type === 'content_block_delta') {
            const block = blocks[event.index];
            assert.ok(block && !closed.has(event.index), 'delta outside an open block');
            if (event.delta.type === 'text_delta') block.text += event.delta.text;
            if (event.delta.type === 'input_json_delta') block._json = (block._json || '') + event.delta.partial_json;
        }
        if (event.type === 'content_block_stop') {
            assert.ok(blocks[event.index] && !closed.has(event.index), 'invalid block stop');
            closed.add(event.index);
        }
    }
    for (const [index, block] of blocks.entries()) {
        assert.ok(closed.has(index), 'unclosed content block');
        if (block.type === 'tool_use') { block.input = JSON.parse(block._json || '{}'); delete block._json; }
    }
    return blocks;
}
function messageOf(response, stream) {
    assert.equal(response.status, 200, response.text);
    assert.equal(response.aborted, false, 'successful response aborted');
    if (!stream) return JSON.parse(response.text);
    const events = eventsOf(response.text);
    assert.equal(events.filter(e => e.type === 'message_start').length, 1);
    assert.equal(events.filter(e => e.type === 'message_delta').length, 1);
    assert.equal(events.filter(e => e.type === 'message_stop').length, 1);
    assert.ok(!events.some(e => e.type === 'error'));
    const final = events.find(e => e.type === 'message_delta');
    return { ...events.find(e => e.type === 'message_start').message, content: contentOf(events), usage: final.usage, stop_reason: final.delta.stop_reason };
}
async function reservePort() {
    const server = http.createServer();
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
function request(base, endpoint, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request(base + endpoint, { method: payload === null ? 'GET' : 'POST', headers: {
            'content-type': 'application/json', 'x-api-key': 'fixture-other-provider', authorization: 'Bearer fixture-ar-borrowed-key',
            'user-agent': 'claude-cli/freegg-fixture', 'accept-encoding': 'identity', ...extraHeaders,
        } }, res => {
            const chunks = []; let settled = false;
            const finish = aborted => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers, aborted }); };
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => finish(false));
            res.on('aborted', () => finish(true));
            res.on('error', () => finish(true));
        });
        const timer = setTimeout(() => req.destroy(new Error('fixture request timeout')), 8000);
        req.on('error', error => { clearTimeout(timer); reject(error); });
        req.end(payload);
    });
}

(async () => {
    fs.mkdirSync(SCRATCH, { recursive: true });
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'freegg-stack-'));
    const file = name => path.join(dir, name);
    const children = [], generations = [], unexpected = [], ensures = [], fixtureErrors = [];
    let mode = 'normal';
    const fixture = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', async () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                const body = raw ? JSON.parse(raw) : null;
                if (req.url === '/logs') { res.writeHead(200); res.end('{}'); return; }
                if (req.url === '/__switch/api/keepalive/ensure') { ensures.push(body); res.writeHead(503); res.end('{"ok":false,"error":"fixture never starts gateways"}'); return; }
                if (req.method !== 'POST' || req.url !== '/v1/responses') {
                    unexpected.push({ method: req.method, url: req.url }); res.writeHead(418); res.end('{"error":"forbidden fixture endpoint"}'); return;
                }
                generations.push({ body, headers: req.headers, mode });
                if (mode.startsWith('http-')) {
                    await wait(40);
                    if (res.destroyed) return;
                    const status = Number(mode.slice(5));
                    res.writeHead(status, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: { code: status === 410 ? 'endpoint_gone' : 'server_error', message: 'fixture upstream HTTP ' + status } })); return;
                }
                const error = { code: 'server_error', message: 'fixture content failure Ж' };
                if (!body.stream) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    if (mode === 'content-failed') { res.end(JSON.stringify({ type: 'response.failed', response: { status: 'failed', error }, error, status: 'failed' })); return; }
                    if (mode === 'malformed') { res.end('{broken'); return; }
                    const tool = mode === 'tools' && !body.input.some(item => item.type === 'function_call_output');
                    const output = tool
                        ? [{ type: 'function_call', id: 'fc_fixture', call_id: 'call_freegg_fixture', name: 'read_local', arguments: '{"path":"fixture.txt"}' }]
                        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture complete Ж' }] }];
                    res.end(JSON.stringify({ id: 'resp_freegg_fixture', status: 'completed', model: body.model, output, usage: RAW_USAGE })); return;
                }
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                const created = { type: 'response.created', response: { id: 'resp_freegg_fixture', status: 'in_progress' } };
                if (mode === 'content-failed') { res.end(data(created) + data({ type: 'response.failed', response: { status: 'failed', error } })); return; }
                if (mode === 'malformed') { res.end(data(created) + 'data: {broken\n\n'); return; }
                const tool = mode === 'tools' && !body.input.some(item => item.type === 'function_call_output');
                const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_freegg_fixture', name: 'read_local', arguments: '{"path":"fixture.txt"}' };
                const events = tool ? [created,
                    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
                    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' },
                    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"fixture.txt"}' },
                    { type: 'response.output_item.done', output_index: 0, item },
                ] : [created, { type: 'response.output_text.delta', delta: 'fixture complete ' }, { type: 'response.output_text.delta', delta: 'Ж' }];
                if (mode === 'post-content-failed') events.push({ type: 'response.failed', response: { status: 'failed', error } });
                else if (mode !== 'truncated') events.push({ type: 'response.completed', response: { id: 'resp_freegg_fixture', status: 'completed', usage: RAW_USAGE } });
                // Split inside the UTF-8 character too; all real hops must decode safely.
                const bytes = Buffer.from(events.map(data).join(''));
                const unicode = bytes.indexOf(Buffer.from('Ж'));
                const split = unicode < 0 ? Math.floor(bytes.length / 2) : unicode + 1;
                res.write(bytes.subarray(0, split));
                setTimeout(() => { if (!res.destroyed) res.end(bytes.subarray(split)); }, 20);
            } catch (error) { fixtureErrors.push(error.message); res.writeHead(500); res.end('{"error":"fixture implementation error"}'); }
        });
    });
    async function writeJson(name, value) { fs.writeFileSync(file(name), JSON.stringify(value) + '\n'); await wait(25); }
    async function start(name, script, port, extraEnv, endpoint) {
        const safeEnv = {};
        for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) safeEnv[key] = process.env[key];
        const env = { ...safeEnv, HOME: dir, USERPROFILE: dir, TMP: dir, TEMP: dir, TMPDIR: dir,
            NODE_OPTIONS: '', ABUSE_HUB_LOCAL_HOP_KEY_FILE: file('local-hop.key'),
            PROXY_LOG_INGEST_URL: 'http://127.0.0.1:' + fixture.address().port + '/logs',
            TOKEN_USAGE_FILE: file(name + '-usage.jsonl'), LOG_FILE: file(name + '.log'),
            SWITCH_PORT: String(fixture.address().port), SWITCHER_PORT: String(fixture.address().port),
            DASHBOARD_URL: 'http://127.0.0.1:' + fixture.address().port,
            PORT: String(port), ...extraEnv };
        const child = spawn(process.execPath, ['--require', file('fixture-guard.cjs'), path.join(ROOT, 'routing', script)], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push({ child, name });
        let output = '';
        const onOutput = chunk => { output = (output + chunk.toString()).slice(-12000); fs.appendFileSync(file(name + '-stdout.log'), chunk); };
        child.stdout.on('data', onOutput); child.stderr.on('data', onOutput);
        const base = 'http://127.0.0.1:' + port;
        for (let i = 0; i < 100; i++) {
            if (child.exitCode !== null || child.signalCode) throw new Error(name + ' exited: ' + output);
            try { const r = await request(base, endpoint); if (r.status === 200) return base; } catch { /* new child only */ }
            await wait(40);
        }
        throw new Error(name + ' readiness timeout: ' + output);
    }
    function assertGeneration(before, model = 'gpt-6.1-sol') {
        assert.equal(generations.length, before + 1, 'must issue exactly one generation');
        const sent = generations.at(-1);
        assert.equal(sent.body.model, model, 'exact vendor model');
        assert.equal(sent.headers.authorization, 'Bearer fixture-freegg-selected', 'borrowed another provider key');
        for (const key of ['x-api-key', 'x-route-final', 'x-route-exact', 'x-route-prefixed', 'x-abuse-hub-local-exact', 'x-abuse-hub-route-auth']) assert.equal(sent.headers[key], undefined, key + ' leaked to vendor');
        assert.equal(sent.body.store, false);
        return sent.body;
    }
    function usageRows() {
        return fs.existsSync(file('frontdoor-usage.jsonl')) ? fs.readFileSync(file('frontdoor-usage.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    }
    async function assertUsageRow(before, stream, model = 'gpt-6.1-sol') {
        for (let i = 0; i < 30 && usageRows().length === before; i++) await wait(20);
        const rows = usageRows(); assert.equal(rows.length, before + 1, 'one journal row per completed response');
        const row = rows.at(-1);
        assert.equal(row.bk, 'freegg'); assert.equal(row.m, model); assert.equal(row.st, stream ? 1 : 0);
        assert.deepEqual({ in: row.in, out: row.out, cr: row.cr, cw: row.cw }, { in: 60, out: 17, cr: 30, cw: 10 });
        assert.equal(row.in + row.cr + row.cw, RAW_USAGE.input_tokens, 'cache buckets counted twice');
    }
    try {
        fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
        const ports = [];
        while (ports.length < 4) { const port = await reservePort(); if (!ports.includes(port) && port !== fixture.address().port) ports.push(port); }
        const [converterPort, keepalivePort, frontdoorPort, unavailablePort] = ports;
        const allowedPorts = [fixture.address().port, ...ports];
        // Preload denies non-fixture sockets and sensitive production reads in each child.
        // Violations fail the suite even if a proxy catches the exception.
        fs.writeFileSync(file('fixture-guard.cjs'), `
'use strict';
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const root = ${JSON.stringify(dir.replace(/\\/g, '/').toLowerCase() + '/')};
const allowed = new Set(${JSON.stringify(allowedPorts)});
const append = fs.appendFileSync.bind(fs);
function violation(message) { append(${JSON.stringify(file('guard-violations.jsonl'))}, JSON.stringify({ message }) + '\\n'); throw new Error(message); }
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : net._normalizeArgs(args)[0];
    const host = String(options.host || 'localhost').toLowerCase();
    if (options.path || !['127.0.0.1', 'localhost', '::1'].includes(host) || !allowed.has(Number(options.port))) violation('non-fixture socket blocked: ' + host + ':' + options.port);
    return originalConnect.apply(this, args);
};
function outside(value) { if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return false; return !path.resolve(String(value)).replace(/\\\\/g, '/').toLowerCase().startsWith(root); }
for (const name of ['readFileSync', 'readFile', 'openSync', 'open']) {
    const original = fs[name];
    fs[name] = function (value, ...args) {
        if (outside(value) && /(?:active-key\\.txt|keys\\.json|sessions\\.json|[\\\\/]\\.secrets[\\\\/]|[\\\\/]\\.claude[\\\\/])/i.test(String(value))) violation('sensitive production read blocked');
        return original.call(this, value, ...args);
    };
}
for (const name of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'renameSync', 'unlinkSync', 'mkdirSync']) {
    const original = fs[name];
    fs[name] = function (value, ...args) { if (outside(value) || name === 'renameSync' && outside(args[0])) violation('write outside fixture blocked'); return original.call(this, value, ...args); };
}
`);
        fs.writeFileSync(file('local-hop.key'), crypto.randomBytes(32));
        fs.mkdirSync(file('.claude'));
        fs.writeFileSync(file('.claude/ar-active-key.txt'), 'fixture-ar-must-never-be-borrowed\n');
        fs.writeFileSync(file('freegg-active-key.txt'), 'fixture-freegg-selected\n');
        const providerMap = { default: 'forbidden-provider-map', opus: 'forbidden-opus', sonnet: 'forbidden-sonnet', haiku: 'forbidden-haiku', gpt: 'forbidden-gpt-remap' };
        const routeMap = { ...providerMap, default: 'gpt-6.1-sol' };
        await writeJson('freegg-modelmap.json', providerMap); await writeJson('freegg-routes-modelmap.json', routeMap);
        const converter = await start('converter', 'freegg-proxy.js', converterPort, {
            FG_LISTEN_PORT: String(converterPort), FG_UPSTREAM_BASE: 'http://127.0.0.1:' + fixture.address().port + '/v1', FG_KEY_FILE: file('freegg-active-key.txt'),
        }, '/health');
        // Match fgKeepaliveSpawn's exact topology; do not mask it with PAID_SINGLE_KEY.
        await writeJson('keepalive.json', { v: 8, maxAttempts: 7, maxHedges: 0, hedgeMs: 1000, holdMs: 10000, emptyStreamMs: 0, catalogTtlMs: 0, poolFallbackModel: '', poolDeadMs: 0, visionBridge: false, preCommitMs: 0, jsonHoldMs: 0, stallMs: 0, retryBudgetMs: 10000, upstreamTimeoutMs: 20000 });
        const keepalive = await start('keepalive', 'keepalive-proxy.js', keepalivePort, {
            UPSTREAM: converter, KEY_FILE: file('freegg-active-key.txt'), MODELMAP_FILE: file('freegg-modelmap.json'), SESSIONS_FILE: '',
            LOCAL_EXACT_ADAPTER: '1', CUSTOM_PROVIDER_ID: 'freegg', CUSTOM_PROVIDER_NAME: 'FreeGG',
            GPT_PROXY_FORCE: '0', HAIKU_REMAP: '1', HAIKU_TO_MODEL: '', HAIKU_GPT_PROXY: converter, MAX_HEDGES: '0',
            PAID_SINGLE_KEY: '0', AUTOROTATE: '0', KEY_SPREAD: '0',
            UPSTREAM_NOSTREAM: '0', EMPTY_TEXT_FIX: '0', MODEL_ECHO: '1', MODEL_ECHO_INJECT: '1', THINK_STRIP: '1',
            CONFIG_FILE: file('keepalive.json'), KEEPALIVE_LOG_FILE: file('keepalive.log'), LATENCY_FILE: file('latency.json'), EVENTS_FILE: file('events.json'), FAILDUMP_DIR: file('faildump'),
            COUNT_TOKENS_FALLBACK: '1', RETRY_FAST_FAIL_MS: '1', RETRY_DELAY_MS: '10', CONN_TRACE: '0', VISION_BRIDGE: '0',
        }, '/__state');
        const entry = { backend: 'freegg', upstream: keepalive, keyFile: file('freegg-active-key.txt'), modelmap: file('freegg-modelmap.json'), updatedAt: Date.now() };
        const decoy = { backend: 'agentrouter', upstream: 'http://127.0.0.1:' + fixture.address().port + '/wrong-active', keyFile: file('.claude/ar-active-key.txt'), updatedAt: Date.now() };
        await writeJson('active-backend.json', decoy);
        await writeJson('backends.json', { providers: { freegg: entry, agentrouter: decoy, failed: { ...entry, backend: 'failed', upstream: 'http://127.0.0.1:' + unavailablePort } }, aliases: {} });
        await writeJson('multi-routes-modelmap.json', {});
        // Canonical IDs are callable regardless of publication; keep all manifest files isolated.
        await writeJson('api-gateway.default.json', { version: 1, revision: 1, enabled: true, models: {} });
        await writeJson('api-gateway.json', { version: 1, revision: 1, enabled: true, models: {} });
        const frontdoor = await start('frontdoor', 'frontdoor-proxy.js', frontdoorPort, {
            ACTIVE_BACKEND_FILE: file('active-backend.json'), BACKENDS_FILE: file('backends.json'), MULTI_MAP_FILE: file('multi-routes-modelmap.json'),
            API_GATEWAY_FILE: file('api-gateway.json'), API_GATEWAY_DEFAULT_FILE: file('api-gateway.default.json'), CLAUDE_SETTINGS_FILE: file('.claude/settings.json'),
            BIFROST_URL: 'http://127.0.0.1:' + fixture.address().port,
            UPSTREAM_TIMEOUT_MS: '6000', ENSURE_TIMEOUT_MS: '1000', ENSURE_COOLDOWN_MS: '1000',
        }, '/__frontdoor/api/status');
        await test('real children advertise FreeGG identity and the exact local converter', async () => {
            const health = JSON.parse((await request(converter, '/health')).text);
            assert.equal(health.provider, 'freegg'); assert.equal(health.upstream, 'http://127.0.0.1:' + fixture.address().port + '/v1');
            const state = JSON.parse((await request(keepalive, '/__state')).text);
            assert.equal(state.upstream, converter); assert.equal(state.localExactAdapter, true); assert.equal(state.cfg.maxHedges, 0); assert.equal(state.cfg.visionBridge, false);
            const identity = JSON.parse((await request(keepalive, '/__keepalive/api/status')).text); assert.equal(identity.providerId, 'freegg');
        });
        for (const stream of [false, true]) await test('canonical exact routing and one generation (stream=' + stream + ')', async () => {
            const before = generations.length, rows = usageRows().length;
            const response = await request(frontdoor, '/v1/messages', bodyOf({ stream }));
            const message = messageOf(response, stream);
            const sent = assertGeneration(before);
            assert.equal(sent.stream, stream); assert.deepEqual(message.content, [{ type: 'text', text: 'fixture complete Ж' }]);
            assert.equal(message.stop_reason, 'end_turn'); assert.deepEqual(message.usage, USAGE);
            await assertUsageRow(rows, stream);
            assert.equal(message.model, MODEL, 'canonical assistant model prefix must be restored');
        });
        for (const stream of [false, true]) await test('system, history, assistant prefix, and parameters survive every hop (stream=' + stream + ')', async () => {
            const before = generations.length;
            const history = [{ role: 'user', content: 'history question Ж' }, { role: 'assistant', content: 'history answer Ж' }, { role: 'user', content: [{ type: 'text', text: 'continue exactly' }] }, { role: 'assistant', content: 'assistant-prefix:' }];
            const response = await request(frontdoor, '/v1/messages', bodyOf({ stream, system: [{ type: 'text', text: 'SYSTEM first Ж' }, { type: 'text', text: 'SYSTEM second' }], messages: history, temperature: 0.25, top_p: 0.9, output_config: { effort: 'high' } }));
            messageOf(response, stream);
            const sent = assertGeneration(before);
            assert.equal(sent.instructions, 'SYSTEM first Ж\nSYSTEM second');
            assert.deepEqual(sent.input, [
                { role: 'user', content: [{ type: 'input_text', text: 'history question Ж' }] },
                { role: 'assistant', content: [{ type: 'output_text', text: 'history answer Ж' }] },
                { role: 'user', content: [{ type: 'input_text', text: 'continue exactly' }] },
                { role: 'assistant', content: [{ type: 'output_text', text: 'assistant-prefix:' }] },
            ]);
            assert.equal(sent.max_output_tokens, 2048); assert.equal(sent.temperature, 0.25); assert.equal(sent.top_p, 0.9); assert.deepEqual(sent.reasoning, { effort: 'high' });
        });
        for (const stream of [false, true]) await test('two-turn function tools and exclusive cache buckets (stream=' + stream + ')', async () => {
            mode = 'tools';
            try {
                const toolSchema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
                const firstBody = bodyOf({ stream, system: 'tool system Ж', tools: [{ name: 'read_local', description: 'Read a fixture file', input_schema: toolSchema }], tool_choice: { type: 'tool', name: 'read_local' } });
                let before = generations.length, rows = usageRows().length;
                const first = messageOf(await request(frontdoor, '/v1/messages', firstBody), stream);
                const firstSent = assertGeneration(before);
                assert.equal(firstSent.stream, stream); assert.equal(firstSent.instructions, 'tool system Ж');
                assert.deepEqual(firstSent.tools, [{ type: 'function', name: 'read_local', description: 'Read a fixture file', parameters: { ...toolSchema, additionalProperties: false } }]);
                assert.deepEqual(firstSent.tool_choice, { type: 'function', name: 'read_local' });
                assert.equal(first.stop_reason, 'tool_use'); assert.deepEqual(first.usage, USAGE);
                assert.deepEqual(first.content, [{ type: 'tool_use', id: 'call_freegg_fixture', name: 'read_local', input: { path: 'fixture.txt' } }]);
                await assertUsageRow(rows, stream);
                before = generations.length; rows = usageRows().length;
                const secondBody = { ...firstBody, messages: [...firstBody.messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.content[0].id, content: 'fixture file content Ж' }, { type: 'text', text: 'use the result and finish' }] }] };
                const second = messageOf(await request(frontdoor, '/v1/messages', secondBody), stream);
                const secondSent = assertGeneration(before);
                assert.equal(secondSent.instructions, 'tool system Ж');
                assert.deepEqual(secondSent.input, [
                    { role: 'user', content: [{ type: 'input_text', text: 'local fixture Ж' }] },
                    { type: 'function_call', call_id: 'call_freegg_fixture', name: 'read_local', arguments: '{"path":"fixture.txt"}' },
                    { type: 'function_call_output', call_id: 'call_freegg_fixture', output: 'fixture file content Ж' },
                    { role: 'user', content: [{ type: 'input_text', text: 'use the result and finish' }] },
                ]);
                assert.deepEqual(second.content, [{ type: 'text', text: 'fixture complete Ж' }]); assert.equal(second.stop_reason, 'end_turn'); assert.deepEqual(second.usage, USAGE);
                await assertUsageRow(rows, stream);
            } finally { mode = 'normal'; }
        });
        for (const stream of [false, true]) for (const errorMode of ['http-401', 'http-410', 'http-429', 'http-500', 'content-failed', 'malformed']) await test(errorMode + ' remains an error with one generation (stream=' + stream + ')', async () => {
            mode = errorMode;
            const before = generations.length, rows = usageRows().length;
            try {
                const response = await request(frontdoor, '/v1/messages', bodyOf({ stream }));
                assertGeneration(before);
                const expectedStatus = errorMode.startsWith('http-') ? Number(errorMode.slice(5)) : 502;
                assert.equal(response.status, expectedStatus, response.text);
                const error = JSON.parse(response.text); assert.equal(error.type, 'error'); assert.ok(error.error.message);
                assert.ok(!response.text.includes('"type":"message_stop"'), 'fabricated success terminal');
                assert.ok(!response.text.includes('"type":"message"'), 'fabricated assistant success');
                assert.equal(usageRows().length, rows, 'error counted as successful usage');
            } finally { mode = 'normal'; }
        });
        for (const errorMode of ['post-content-failed', 'truncated']) await test(errorMode + ' cannot fabricate completion after stream content', async () => {
            mode = errorMode;
            const before = generations.length, rows = usageRows().length;
            try {
                const response = await request(frontdoor, '/v1/messages', bodyOf({ stream: true }));
                assertGeneration(before); assert.equal(response.status, 200);
                const events = eventsOf(response.text);
                assert.ok(events.some(event => event.type === 'content_block_delta' && event.delta.text));
                assert.ok(response.aborted || events.some(event => event.type === 'error'), 'content failure was hidden');
                assert.ok(!events.some(event => event.type === 'message_stop'), 'synthetic success stop');
                assert.ok(!events.some(event => event.type === 'message_delta'), 'synthetic usage/final delta');
                assert.equal(usageRows().length, rows, 'unfinished content counted as success');
            } finally { mode = 'normal'; }
        });
        await test('window suffix never reaches Responses and model case/nested IDs stay exact', async () => {
            const before = generations.length;
            const response = await request(frontdoor, '/v1/messages', bodyOf({ model: 'freegg/Vendor/Nested/Case-ID[1m]' }));
            const message = messageOf(response, false); assertGeneration(before, 'Vendor/Nested/Case-ID');
            assert.equal(message.model, 'freegg/Vendor/Nested/Case-ID[1m]', 'context window marker lost downstream');
        });
        await test('count_tokens through frontdoor performs zero generations', async () => {
            const before = generations.length;
            const response = await request(frontdoor, '/v1/messages/count_tokens', bodyOf());
            assert.equal(response.status, 200); assert.ok(JSON.parse(response.text).input_tokens > 0); assert.equal(generations.length, before);
        });
        await test('missing FreeGG key cannot borrow client or AgentRouter credentials', async () => {
            const before = generations.length;
            fs.unlinkSync(file('freegg-active-key.txt'));
            try {
                const response = await request(frontdoor, '/v1/messages', bodyOf());
                assert.equal(generations.length, before, 'missing FreeGG key generated using caller/other-provider credentials');
                assert.equal(response.status, 401, response.text);
            } finally { fs.writeFileSync(file('freegg-active-key.txt'), 'fixture-freegg-selected\n'); }
        });
        await test('direct keepalive rejects forged exact routing headers before generation', async () => {
            const before = generations.length;
            const response = await request(keepalive, '/v1/messages', bodyOf({ model: 'gpt-6.1-sol' }), { 'x-route-final': '1', 'x-route-exact': '1', 'x-abuse-hub-route-auth': 'forged-fixture-marker' });
            assert.equal(response.status, 403); assert.equal(generations.length, before);
        });
        await test('unreachable registered route fails closed without active-provider fallback', async () => {
            const before = generations.length, ensureBefore = ensures.length;
            const response = await request(frontdoor, '/v1/messages', bodyOf({ model: 'failed/gpt-6.1-sol' }));
            assert.equal(response.status, 502); assert.equal(generations.length, before); assert.equal(ensures.length, ensureBefore + 1); assert.deepEqual(unexpected, []);
        });
        await test('missing route default fails closed without touching AgentRouter', async () => {
            await writeJson('freegg-routes-modelmap.json', { ...routeMap, default: '' });
            const before = generations.length;
            try { const response = await request(frontdoor, '/v1/messages', bodyOf({ model: 'freegg[1m]' })); assert.equal(response.status, 400); assert.equal(generations.length, before); assert.deepEqual(unexpected, []); }
            finally { await writeJson('freegg-routes-modelmap.json', routeMap); }
        });
        await test('exact requests ignore hostile retry/hedge/fallback config and maps', async () => {
            await request(keepalive, '/__config', { maxAttempts: 9, maxHedges: 3, hedgeMs: 1000, holdMs: 10000, poolFallbackModel: 'forbidden-pool-fallback', poolDeadMs: 60000 });
            mode = 'http-500';
            const before = generations.length;
            try { const response = await request(frontdoor, '/v1/messages', bodyOf()); assertGeneration(before); assert.equal(response.status, 500, response.text); }
            finally { mode = 'normal'; }
        });
    } catch (error) {
        results.push({ name: 'stack setup/runtime', ok: false, error: error.message });
        console.error('  FAIL stack setup/runtime: ' + error.message);
    } finally {
        for (const { child } of children.reverse()) {
            if (child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill(); await exited; }
        }
        fixture.closeAllConnections();
        await new Promise(resolve => fixture.close(resolve));
        const violations = fs.existsSync(file('guard-violations.jsonl')) ? fs.readFileSync(file('guard-violations.jsonl'), 'utf8') : '';
        await test('no non-fixture sockets, production secrets, other endpoints, or fixture errors', async () => {
            assert.equal(violations, ''); assert.deepEqual(unexpected, []); assert.deepEqual(fixtureErrors, []);
        });
        await test('all fixture child processes are stopped', async () => {
            assert.ok(children.every(({ child }) => child.exitCode !== null || child.signalCode));
        });
        const failed = results.filter(result => !result.ok).length;
        const credentialSource = headers => headers.authorization === 'Bearer fixture-freegg-selected' ? 'selected-freegg' : headers.authorization === 'Bearer fixture-other-provider' ? 'caller-other-provider' : headers.authorization === 'Bearer fixture-ar-borrowed-key' ? 'caller-ar-bearer' : headers.authorization === 'Bearer fixture-ar-must-never-be-borrowed' ? 'scratch-ar-key-file' : 'unknown';
        fs.writeFileSync(file('result.json'), JSON.stringify({ results, generations: generations.length, generationSummary: generations.map(({ body, mode, headers }) => ({ model: body.model, stream: body.stream, mode, credentialSource: credentialSource(headers) })), unexpected, ensures: ensures.length, fixtureErrors, violations, childrenStopped: children.every(({ child }) => child.exitCode !== null || child.signalCode) }, null, 2));
        console.log('fixture artifacts: ' + dir);
        console.log(`check-freegg-stack: ${results.length - failed} passed, ${failed} failed`);
        if (failed) process.exitCode = 1;
        // Retain failure logs but no selected keys or local-hop secrets.
        for (const name of ['freegg-active-key.txt', '.claude/ar-active-key.txt', 'local-hop.key']) fs.rmSync(file(name), { force: true });
        if (!failed) fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
