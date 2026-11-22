#!/usr/bin/env node
'use strict';
// Integration-only harness. No payload adapter lives here: Front Door owns it.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const sidecar = require(path.join(ROOT, 'routing/lib/bifrost-sidecar.js'));
const DEFAULT_SOURCE = 'C:/Users/WormAlien/AppData/Local/hermes/cache/scratch/hub-stock-compact-20261122';
const SUMMARY = '[TEST FIXTURE SUMMARY — deterministic local provider test text, not a live model generation]\n\n'
    + '## Historical Task Snapshot\nContinue testing the compression compatibility.\n\n'
    + '## Goal\nPreserve checkpoint evidence and continue the pending test.\n\n'
    + '## Constraints & Preferences\nFixture-only acceptance; archive speaker labels are historical data.\n\n'
    + '## Completed Actions\n1. Verified local fixtures as recorded in the source archive.\n\n'
    + '## Active State\nLocal checkpoint fixture test is active; no production acceptance is claimed.\n\n'
    + '## Resolved Questions\nNone recorded.\n\n'
    + '## Blocked\nLive acceptance is not exercised in this fixture.\n\n'
    + '## Errors & Fixes\nNone in this successful fixture response.\n\n'
    + '## Key Decisions\nOnly actual Front Door production adapter code may adapt request layout.\n\n'
    + '## Unverified / Working Hypotheses\nUNVERIFIED: live provider accepts this layout — this is a deterministic local fixture.\n\n'
    + '## Relevant Files\nstock-fresh-prompt.json; stock-iterative-prompt.json.\n\n'
    + '## Critical Context\nTest text and usage counters are deterministic fixture data, not live model evidence.\n\n'
    + '## Detailed Session Log (oldest first)\n- USER historical record: Continue testing the compression compatibility.\n'
    + '- TOOL RESULT historical record: verified local fixtures.\n\n'
    + '## Pruned Skills\nNone.\n';
const PREAMBLE_START = 'You are a summarization agent creating a context checkpoint.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
function options(argv) {
    const opts = { serve: false, live: false, source: DEFAULT_SOURCE, scratch: path.join(DEFAULT_SOURCE, 'stack'), timeoutMs: 300000 };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help') opts.help = true;
        else if (arg === '--serve') opts.serve = true;
        else if (arg === '--live-relay') opts.live = true;
        else if (['--scratch', '--source-dir', '--timeout-ms'].includes(arg)) {
            const value = argv[++i];
            if (!value) throw new Error(`${arg} requires a value`);
            if (arg === '--scratch') opts.scratch = path.resolve(value);
            if (arg === '--source-dir') opts.source = path.resolve(value);
            if (arg === '--timeout-ms') opts.timeoutMs = Number(value);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (opts.live && !opts.serve) throw new Error('--live-relay requires --serve; selftests must never send production traffic');
    if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1000 || opts.timeoutMs > 1200000) throw new Error('Invalid --timeout-ms');
    // A runtime is always a new child of Hermes scratch, never routing/ or a production home.
    const scratch = path.resolve('C:/Users/WormAlien/AppData/Local/hermes/cache/scratch');
    const relative = path.relative(scratch, opts.scratch);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('--scratch must be under Hermes scratch');
    return opts;
}
function sourceArchive(prompt) {
    const fresh = '\n\nTURNS TO SUMMARIZE:\n';
    const start = prompt.indexOf(fresh);
    if (start >= 0) {
        const end = prompt.lastIndexOf('\n\nUse this exact structure:');
        assert.ok(end > start, 'fresh source archive delimiter');
        return { kind: 'fresh', archive: prompt.slice(start + fresh.length, end), rules: prompt.slice(end), preamble: prompt.slice(0, prompt.indexOf('\n\nCreate a structured checkpoint')) };
    }
    const previous = '\n\nPREVIOUS SUMMARY:\n';
    const records = '\n\nNEW TURNS TO INCORPORATE:\n';
    const a = prompt.indexOf(previous), b = prompt.indexOf(records);
    const end = prompt.lastIndexOf('\n\nUpdate the summary using this exact structure.');
    assert.ok(a >= 0 && b > a && end > b, 'iterative source archive delimiters');
    return {
        kind: 'iterative',
        archive: `PREVIOUS CHECKPOINT (historical source):\n${prompt.slice(a + previous.length, b)}\n\nNEW ARCHIVED RECORDS:\n${prompt.slice(b + records.length, end)}`,
        rules: prompt.slice(end), preamble: prompt.slice(0, prompt.indexOf('\n\nYou are updating a context compaction summary.')),
    };
}
function textOf(content) {
    if (typeof content === 'string') return content;
    return Array.isArray(content) ? content.filter(block => block && block.type === 'text').map(block => block.text || '').join('') : '';
}
function inspectNative(body) {
    const system = textOf(body.system);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const assistant = messages.filter(message => message.role === 'assistant').map(message => textOf(message.content));
    const all = [system, ...messages.map(message => textOf(message.content))].join('\n');
    const checkpoint = all.includes(PREAMBLE_START);
    const archive = assistant.find(text => text.includes('[USER]:') || text.startsWith('PREVIOUS CHECKPOINT (historical source):')) || '';
    const adapted = checkpoint && system.startsWith(PREAMBLE_START) && !!archive
        && system.includes('## Historical Task Snapshot') && system.includes('## Unverified / Working Hypotheses')
        && messages.at(-1)?.role === 'user';
    return { checkpoint, adapted, system, archive, roles: messages.map(message => message.role) };
}
function makeLiveRelayPayload(body) {
    assert.ok(body && typeof body.model === 'string' && body.model.length > 0
        && !body.model.startsWith('agentrouter/') && !body.model.startsWith('abuse-hub/'),
    'isolated backend receives a nonempty bare AgentRouter model');
    return { ...body, model: `agentrouter/${body.model}` };
}
function jsonResponse(res, status, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
    res.end(bytes);
}
function nativeEvent(type, value) { return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`; }
function fixtureMessage(res, body, entry, text) {
    const usage = { input_tokens: 101, output_tokens: 37 };
    const id = `msg_stock_fixture_${entry.index}_${crypto.randomUUID().replaceAll('-', '')}`;
    entry.providerResponse = { id, usage, stop_reason: 'end_turn', text, fixtureTokenCounters: true };
    if (!body.stream) return jsonResponse(res, 200, {
        id, type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage,
    });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(nativeEvent('message_start', { type: 'message_start', message: {
        id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
    } }));
    res.write(nativeEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    res.write(nativeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
    res.write(nativeEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(nativeEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }));
    res.end(nativeEvent('message_stop', { type: 'message_stop' }));
}
function request(port, pathname, body, timeoutMs = 20000) {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    let client;
    const done = new Promise(resolve => {
        let settled = false, response;
        const chunks = [];
        const finish = extra => {
            if (settled) return;
            settled = true;
            const raw = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(raw); } catch { /* SSE or incomplete */ }
            resolve({ status: response?.statusCode || 0, raw, json, ...extra });
        };
        client = http.request({ host: '127.0.0.1', port, path: pathname, method: bytes ? 'POST' : 'GET', timeout: timeoutMs,
            headers: bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length), 'user-agent': 'stock-hermes-checkpoint-fixture' } : {},
        }, res => {
            response = res;
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => finish({ complete: true }));
            res.on('aborted', () => finish({ complete: false, error: 'response_aborted' }));
            res.on('error', error => finish({ complete: false, error: error.code || error.message }));
        });
        client.on('timeout', () => client.destroy(new Error('fixture request timeout')));
        client.on('error', error => finish({ complete: false, error: error.code || error.message }));
        client.end(bytes);
    });
    return { done, cancel: () => client.destroy(new Error('fixture client cancelled')) };
}
function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
    });
}
async function freePort() {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function waitFor(fn, label, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    let last;
    while (Date.now() < until) {
        try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
        await sleep(30);
    }
    throw new Error(`${label}: ${last?.message || 'timed out'}`);
}
async function terminate(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* exact owned child already gone */ } }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
}
function childEnv(home, extra) {
    const env = {};
    // Do not inherit API keys, provider credentials, proxy URLs, NODE_OPTIONS or user configs.
    for (const name of ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT', 'LOCALAPPDATA']) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    return { ...env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, ...extra };
}
async function startStack(opts) {
    fs.mkdirSync(opts.scratch, { recursive: true });
    const runDir = fs.mkdtempSync(path.join(opts.scratch, opts.live ? 'live-' : 'fixture-'));
    const entries = [], children = [], servers = [], sockets = new Set();
    const stats = { productionRequests: 0, mode: 'normal' };
    let cleaned = false;
    const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        await Promise.all(children.map(terminate));
        for (const socket of sockets) socket.destroy();
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
        const rows = children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, owned: true }));
        assert.ok(rows.every(row => row.exitCode !== null || row.signal !== null), 'all exact owned children exited');
        writeJson(path.join(runDir, 'cleanup.json'), { children: rows, productionRequests: stats.productionRequests, clean: true });
    };
    try {
        const provider = http.createServer((req, res) => {
            if (req.url !== '/v1/messages' || req.method !== 'POST') return jsonResponse(res, 404, { error: { type: 'not_found_error', message: 'Fixture only serves native messages.' } });
            const chunks = [];
            let size = 0;
            req.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
            req.on('error', () => {});
            req.on('end', () => {
                const bytes = Buffer.concat(chunks);
                let body;
                try { body = JSON.parse(bytes.toString('utf8')); } catch { return jsonResponse(res, 400, { error: { type: 'invalid_request_error', message: 'Malformed fixture JSON.' } }); }
                const native = inspectNative(body);
                const entry = { index: entries.length + 1, requestSha256: hash(bytes), archiveSha256: hash(native.archive), archiveBytes: Buffer.byteLength(native.archive),
                    model: body.model, checkpoint: native.checkpoint, adapted: native.adapted, roles: native.roles, thinking: body.thinking || null,
                    startedAt: Date.now(), finished: false, closed: false, cancelled: false };
                if (!opts.live) entry.body = body;
                entries.push(entry);
                const save = () => writeJson(path.join(runDir, 'provider-receipts.json'), { fixture: !opts.live, productionRequests: stats.productionRequests, entries });
                res.on('finish', () => { entry.finished = true; save(); });
                res.on('close', () => { entry.closed = true; entry.cancelled = !res.writableFinished; save(); });
                save();
                if (opts.live) {
                    // This requalifies ONLY the model stripped by Front Door's backend hop.
                    // Archive/system/messages/thinking are forwarded exactly as received.
                    const liveBody = makeLiveRelayPayload(body);
                    const liveBytes = Buffer.from(JSON.stringify(liveBody));
                    assert.equal(JSON.stringify(liveBody.messages), JSON.stringify(body.messages));
                    const headers = { 'content-type': 'application/json', 'content-length': String(liveBytes.length), 'anthropic-version': '2023-06-01',
                        'user-agent': 'hermes-agent-stock-checkpoint-live-relay' };
                    for (const name of ['x-request-id', 'x-session-id']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
                    assert.ok(Object.keys(headers).every(name => !name.includes('auth') && !name.startsWith('x-abuse-hub') && !name.startsWith('x-bf-')));
                    stats.productionRequests++;
                    entry.liveForward = { model: liveBody.model, archiveSha256: hash(native.archive), headerNames: Object.keys(headers) };
                    save();
                    const upstream = http.request({ host: '127.0.0.1', port: 20100, path: '/v1/messages', method: 'POST', headers, timeout: opts.timeoutMs }, liveRes => {
                        entry.providerStatus = liveRes.statusCode;
                        res.writeHead(liveRes.statusCode, liveRes.headers);
                        // Forward real bytes; never turn an error/incomplete stream into success.
                        const responseHash = crypto.createHash('sha256');
                        let responseBytes = 0, capturedBytes = 0;
                        const captured = [];
                        liveRes.on('data', chunk => {
                            responseHash.update(chunk);
                            responseBytes += chunk.length;
                            if (capturedBytes + chunk.length <= 1024 * 1024) { captured.push(chunk); capturedBytes += chunk.length; }
                        });
                        liveRes.on('end', () => {
                            entry.realResponse = { bytes: responseBytes, sha256: responseHash.digest('hex'), complete: true, status: liveRes.statusCode };
                            if (responseBytes === capturedBytes && !body.stream) {
                                try {
                                    const value = JSON.parse(Buffer.concat(captured).toString('utf8'));
                                    entry.realResponse.id = value.id || null;
                                    entry.realResponse.usage = value.usage || null;
                                    entry.realResponse.stop_reason = value.stop_reason || null;
                                    const text = textOf(value.content);
                                    entry.realResponse.textChars = text.length;
                                    entry.realResponse.textSha256 = hash(text);
                                } catch { entry.realResponse.jsonParsed = false; }
                            }
                            save();
                        });
                        liveRes.pipe(res);
                        liveRes.on('error', () => res.destroy());
                        liveRes.on('aborted', () => res.destroy());
                    });
                    upstream.on('timeout', () => upstream.destroy(new Error('Live relay timeout')));
                    upstream.on('error', () => { entry.transportError = true; if (!res.headersSent) jsonResponse(res, 502, { type: 'error', error: { type: 'api_error', message: 'Live relay transport failed.' } }); else res.destroy(); });
                    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
                    upstream.end(liveBytes);
                    return;
                }
                if (native.checkpoint && !native.adapted) return jsonResponse(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Fixture rejects unsupported raw stock checkpoint layout.' } });
                if (stats.mode === 'error') return jsonResponse(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Deliberate fixture provider failure.' } });
                if (stats.mode === 'hold') return; // No provider terminal: cancellation must close this socket.

                fixtureMessage(res, body, entry, native.adapted ? SUMMARY : '[TEST FIXTURE ORDINARY RESPONSE] ordinary requests unaffected');
            });
        });
        provider.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
        servers.push(provider);
        const providerPort = await listen(provider);
        const sink = http.createServer((req, res) => { req.resume(); res.end('{}'); });
        sink.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
        servers.push(sink);
        const sinkPort = await listen(sink);
        const frontdoorPort = await freePort(), bifrostPort = await freePort();
        assert.notEqual(frontdoorPort, bifrostPort);
        assert.ok(![frontdoorPort, bifrostPort, providerPort, sinkPort].some(port => [20100, 20135, 8200].includes(port)), 'no production port allocations');
        const state = { backend: 'agentrouter', upstream: `http://127.0.0.1:${providerPort}`, modelmap: null, updatedAt: Date.now() };
        const statePath = path.join(runDir, '.claude/active-backend.json');
        const registryPath = path.join(runDir, '.claude/backends.json');
        const manifestPath = path.join(runDir, 'api-gateway.json');
        const settingsPath = path.join(runDir, '.claude/settings.json');
        writeJson(statePath, state);
        writeJson(registryPath, { version: 1, providers: { agentrouter: state }, aliases: {} });
        writeJson(manifestPath, { version: 1, revision: 1, enabled: true, models: { 'agentrouter/gpt-6.1-sol': {
            displayName: 'Stock Hermes isolated test', claudeBehavesAs: 'claude-opus-5', contextTokens: 1050000, outputTokens: 32000, publishedAt: '2026-11-22T00:00:00.000Z',
        } } });
        writeJson(settingsPath, {});
        const localHopFile = path.join(runDir, 'isolated-local-hop.key');
        fs.writeFileSync(localHopFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
        const internalMarker = `stock-isolated-${crypto.randomUUID()}`;
        const prepared = await sidecar.prepareLaunch({ install: false, runtimeRoot: path.join(runDir, 'runtime'), baseUrl: `http://127.0.0.1:${frontdoorPort}`, internalMarker });
        assert.equal(prepared.lock.version, 'v2.5.0');
        assert.equal(prepared.verified, true);
        const descriptor = sidecar.createServiceDescriptor({ executable: prepared.executable, appDir: prepared.appDir, configPath: prepared.configPath,
            port: bifrostPort, expectedSha256: prepared.artifact.sha256, version: prepared.lock.version });
        const launch = (name, executable, args, env, cwd) => {
            const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
            children.push(child);
            const log = fs.createWriteStream(path.join(runDir, `${name}.stderr.log`));
            child.stderr.pipe(log);
            child.on('error', error => { log.write(`Spawn failure: ${error.code || error.message}\n`); });
            return child;
        };
        const frontdoor = launch('frontdoor', process.execPath, [path.join(ROOT, 'routing/frontdoor-proxy.js')], childEnv(runDir, {
            PORT: String(frontdoorPort), ACTIVE_BACKEND_FILE: statePath, BACKENDS_FILE: registryPath,
            API_GATEWAY_DEFAULT_FILE: manifestPath, API_GATEWAY_FILE: manifestPath, CLAUDE_SETTINGS_FILE: settingsPath,
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: localHopFile, BIFROST_URL: `http://127.0.0.1:${bifrostPort}`, BIFROST_INTERNAL_MARKER: internalMarker,
            TOKEN_USAGE_FILE: path.join(runDir, 'token-usage.jsonl'), MULTI_MAP_FILE: path.join(runDir, 'unused-modelmap.json'),
            LOG_FILE: path.join(runDir, 'frontdoor.log'), SWITCH_PORT: String(sinkPort), PROXY_LOG_INGEST_URL: `http://127.0.0.1:${sinkPort}/logs`,
            UPSTREAM_TIMEOUT_MS: String(opts.timeoutMs), DRAIN_MAX_MS: '250',
        }), path.join(ROOT, 'routing'));
        await waitFor(async () => {
            if (frontdoor.exitCode !== null) throw new Error('Front Door exited');
            return (await request(frontdoorPort, '/openai/v1/models').done).status === 200;
        }, 'Front Door readiness');
        const bifrost = launch('bifrost', descriptor.executable, descriptor.args, childEnv(runDir, descriptor.env), descriptor.cwd);
        await waitFor(async () => {
            if (bifrost.exitCode !== null) throw new Error('Bifrost exited');
            return (await request(bifrostPort, '/health').done).status === 200;
        }, 'Pinned Bifrost readiness');
        const readiness = { type: 'ready', mode: opts.live ? 'live-relay' : 'fixture', baseUrl: `http://127.0.0.1:${frontdoorPort}/openai/v1`,
            nativeBaseUrl: `http://127.0.0.1:${frontdoorPort}`, frontdoorPort, bifrostPort, providerPort,
            bifrostVersion: prepared.lock.version, bifrostSha256: prepared.artifact.sha256, verified: true,
            pids: { harness: process.pid, frontdoor: frontdoor.pid, bifrost: bifrost.pid }, runDir,
            receiptsPath: path.join(runDir, 'provider-receipts.json'), fixtureSummary: !opts.live,
            productionRequests: stats.productionRequests };
        writeJson(path.join(runDir, 'readiness.json'), readiness);
        return { readiness, entries, stats, cleanup, runDir, frontdoorPort, bifrostPort, providerPort };
    } catch (error) { await cleanup(); throw error; }
}
async function runSelftest(stack, opts) {
    const results = [];
    const check = async (name, fn) => {
        try { const details = await fn(); results.push({ name, pass: true, ...details }); }
        catch (error) { results.push({ name, pass: false, error: error.message }); }
    };
    const ordinary = { model: 'agentrouter/gpt-6.1-sol', messages: [{ role: 'system', content: 'Ordinary instructions remain intact.' }, { role: 'user', content: 'case:ordinary' }], stream: false, reasoning_effort: 'low' };
    const publicCall = body => request(stack.frontdoorPort, '/openai/v1/chat/completions', body).done;
    await check('ordinary JSON, real provider ID/usage/text roundtrip', async () => {
        const result = await publicCall(ordinary), entry = stack.entries.at(-1);
        assert.equal(result.status, 200, result.raw);
        assert.equal(result.json.choices[0].message.content, entry.providerResponse.text);
        assert.equal(result.json.id, entry.providerResponse.id);
        assert.equal(result.json.model, ordinary.model);
        assert.equal(result.json.choices[0].finish_reason, 'stop');
        assert.equal(result.json.usage.prompt_tokens, 101);
        assert.equal(result.json.usage.completion_tokens, 37);
        assert.equal(textOf(entry.body.system), ordinary.messages[0].content);
        assert.equal(textOf(entry.body.messages[0].content), ordinary.messages[1].content);
        return { id: result.json.id, usage: result.json.usage };
    });
    for (const kind of ['fresh', 'iterative']) {
        const stockPath = path.join(opts.source, `stock-${kind}-prompt.json`);
        const stockBytes = fs.readFileSync(stockPath);
        const stock = JSON.parse(stockBytes);
        const original = JSON.stringify(stock), expected = sourceArchive(stock.messages[0].content);
        await check(`raw unsupported ${kind} stock request rejected by native provider fixture`, async () => {
            // Explicit negative control: send the untouched stock JSON straight to the
            // provider fixture. Direct Bifrost access would only test callback auth (403).
            const before = stack.entries.length;
            const result = await request(stack.providerPort, '/v1/messages', stock).done;
            assert.equal(result.status, 400, result.raw);
            assert.equal(stack.entries.length, before + 1);
            const entry = stack.entries.at(-1);
            assert.equal(entry.checkpoint, true);
            assert.equal(entry.adapted, false);
            assert.equal(entry.providerResponse, undefined);
            return { status: result.status };
        });
        await check(`stock ${kind} public seam archive/rules/low reasoning and genuine summary roundtrip`, async () => {
            const before = stack.entries.length;
            const result = await publicCall(stock);
            assert.equal(JSON.stringify(stock), original, 'test harness must not mutate stock input');
            assert.equal(hash(fs.readFileSync(stockPath)), hash(stockBytes), 'source JSON file remains byte-identical');
            assert.equal(result.status, 200, result.raw);
            assert.equal(stack.entries.length, before + 1, 'one provider generation');
            const entry = stack.entries.at(-1), native = inspectNative(entry.body);
            assert.equal(native.adapted, true, 'real Front Door adapter must separate archive');
            assert.equal(native.archive, expected.archive, 'source archive survives real Bifrost UTF-8 exact roundtrip');
            assert.ok(native.system.includes(expected.rules), 'all source template/focus rules survive Bifrost');
            assert.ok(native.system.includes(expected.preamble), 'original safety/language/provenance preamble preserved');
            assert.ok(native.roles.includes('assistant'), 'historical assistant archive supported by pinned config');
            assert.equal(entry.body.thinking?.type, 'enabled', 'explicit low reasoning converted by real Bifrost');
            assert.equal(entry.body.thinking.budget_tokens, Math.round(1024 + 0.15 * (entry.body.max_tokens - 1024)),
                'real pinned Anthropic thinking budget corresponds to explicit reasoning_effort=low');
            assert.equal(result.json.id, entry.providerResponse.id);
            assert.equal(result.json.model, stock.model);
            assert.equal(result.json.choices[0].message.content, SUMMARY);
            assert.equal(result.json.choices[0].finish_reason, 'stop');
            assert.equal(result.json.usage.prompt_tokens, 101);
            assert.equal(result.json.usage.completion_tokens, 37);
            return { archiveSha256: entry.archiveSha256, archiveBytes: entry.archiveBytes, thinking: entry.thinking, id: result.json.id, usage: result.json.usage };
        });
    }
    await check('ordinary SSE retains genuine terminal and fixture ID/usage', async () => {
        const result = await publicCall({ ...ordinary, stream: true, stream_options: { include_usage: true } });
        assert.equal(result.status, 200, result.raw);
        assert.ok(result.complete);
        assert.match(result.raw, /data: \[DONE\]/);
        const objects = result.raw.split(/\r?\n/).filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
        const entry = stack.entries.at(-1);
        assert.ok(objects.some(value => value.id === entry.providerResponse.id));
        assert.ok(objects.some(value => value.choices?.some(choice => choice.finish_reason === 'stop')));
        assert.ok(objects.some(value => value.usage?.prompt_tokens === 101 && value.usage?.completion_tokens === 37));
        assert.equal(objects.flatMap(value => value.choices || []).map(choice => choice.delta?.content || '').join(''), entry.providerResponse.text);
    });
    await check('provider error is not synthesized into a successful checkpoint', async () => {
        stack.stats.mode = 'error';
        try {
            const result = await publicCall(ordinary);
            assert.ok(result.status >= 400, `provider error returned ${result.status}: ${result.raw}`);
            assert.ok(result.json?.error);
            assert.ok(!result.json?.choices);
            return { status: result.status };
        } finally { stack.stats.mode = 'normal'; }
    });
    await check('cancellation destroys exact held native provider socket', async () => {
        stack.stats.mode = 'hold';
        let pending;
        try {
            const before = stack.entries.length;
            pending = request(stack.frontdoorPort, '/openai/v1/chat/completions', ordinary);
            await waitFor(() => stack.entries.length === before + 1, 'held provider arrival');
            const entry = stack.entries.at(-1);
            pending.cancel();
            await pending.done;
            await waitFor(() => entry.cancelled && entry.closed, 'native provider cancellation', 10000);
            assert.equal(entry.finished, false);
            assert.equal(entry.providerResponse, undefined);
            return { providerCancelled: true };
        } finally { pending?.cancel(); stack.stats.mode = 'normal'; }
    });
    await check('next ordinary request succeeds after cancellation without restart', async () => {
        const result = await publicCall(ordinary);
        assert.equal(result.status, 200, result.raw);
        assert.equal(result.json.id, stack.entries.at(-1).providerResponse.id);
    });
    await check('one internal accounting row per real successful provider terminal', async () => {
        const terminals = stack.entries.filter(entry => entry.providerResponse && entry.finished);
        const usagePath = path.join(stack.runDir, 'token-usage.jsonl');
        const rows = await waitFor(() => {
            if (!fs.existsSync(usagePath)) return false;
            const text = fs.readFileSync(usagePath, 'utf8').trim();
            const values = text ? text.split(/\r?\n/).map(line => JSON.parse(line)) : [];
            return values.length >= terminals.length ? values : false;
        }, 'terminal accounting');
        assert.equal(rows.length, terminals.length, 'no outer/inner duplicate or fabricated error/cancel usage');
        assert.ok(rows.every(row => row.bk === 'agentrouter' && row.m === 'gpt-6.1-sol' && row.in === 101 && row.out === 37));
        return { successfulProviderTerminals: terminals.length, accountingRows: rows.length };
    });
    assert.equal(stack.stats.productionRequests, 0, 'default fixture selftest never sends production traffic');
    const report = { marker: 'STOCK_HERMES_PINNED_STACK_SELFTEST', passed: results.filter(row => row.pass).length,
        failed: results.filter(row => !row.pass).length, results, productionRequests: 0, readiness: stack.readiness,
        limitations: ['Fixture text and token counters are explicitly synthetic provider test data.', 'Live provider acceptance requires explicit --live-relay --serve by parent.', 'No production processes/configs/keys/ports changed.'] };
    writeJson(path.join(stack.runDir, 'selftest.json'), report);
    return report;
}
async function main() {
    const opts = options(process.argv.slice(2));
    if (opts.help) {
        console.log('Usage: node tools/check-stock-hermes-checkpoint-stack.js [--serve] [--live-relay] [--scratch ABS_PATH] [--source-dir ABS_PATH] [--timeout-ms 300000]\n'
            + 'Default: isolated fixture selftest. --serve emits one readiness JSON line then holds until SIGINT/SIGTERM or stdin EOF.\n'
            + '--live-relay requires --serve and only forwards requested provider callbacks to existing production 127.0.0.1:20100/v1/messages.\n'
            + 'Keep stdin open in serve mode; close stdin for portable Windows exact child cleanup. No live requests during readiness.');
        return;
    }
    const stack = await startStack(opts);
    if (!opts.serve) {
        try { const report = await runSelftest(stack, opts); console.log(JSON.stringify(report)); if (report.failed) process.exitCode = 1; }
        finally { await stack.cleanup(); }
        return;
    }
    console.log(JSON.stringify(stack.readiness));
    await new Promise(resolve => {
        const stop = () => resolve();
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
        process.stdin.once('end', stop);
        process.stdin.resume();
    });
    await stack.cleanup();
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ error: error.message, code: error.code || 'stack_failure' })); process.exitCode = 1; });
module.exports = { options, sourceArchive, inspectNative, makeLiveRelayPayload, SUMMARY, startStack, runSelftest };
