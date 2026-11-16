#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const zlib = require('node:zlib');
const { after, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'routing', 'lib', 'bifrost-sidecar.js');
const LOCK_PATH = path.join(ROOT, 'routing', 'bifrost-lock.json');
const CONFIG_PATH = path.join(ROOT, 'routing', 'bifrost-config.json');
const NOTICE_PATH = path.join(ROOT, 'routing', 'BIFROST-NOTICE.txt');
const PRICING_PATH = path.join(ROOT, 'routing', 'bifrost-pricing.json');
const MODEL_PARAMETERS_PATH = path.join(ROOT, 'routing', 'bifrost-model-parameters.json');
const LIFECYCLE_PATH = path.join(ROOT, 'routing', 'lifecycle.js');
const PHASE3_ISOLATED = process.argv.includes('--phase3-isolated');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-bifrost-stack-'));
const EXPECTED = {
    repo: 'maximhq/bifrost',
    version: 'v2.5.0',
    defaultHost: '127.0.0.1',
    defaultPort: 20135,
    artifacts: {
        'win32-x64': {
            os: 'windows', arch: 'amd64', filename: 'bifrost-http.exe',
            sha256: '2736fffdeb99b3bc0f7d45aa1d84d3cda73a70800a35de99695488842731604d',
        },
        'linux-x64': {
            os: 'linux', arch: 'amd64', filename: 'bifrost-http',
            sha256: 'd7f9697ebf443f8f961c1c751e58123320ae8c749170eaf63b6455dd4f1fde2f',
        },
        'linux-arm64': {
            os: 'linux', arch: 'arm64', filename: 'bifrost-http',
            sha256: '7d5e8717793ba7c9a87cfd63886c226c79f470932dd1281d29209ddf47d8b85f',
        },
        'darwin-x64': {
            os: 'darwin', arch: 'amd64', filename: 'bifrost-http',
            sha256: '6dcefc70045fc866a3532b0e0f42464cc22be47e832058d0527586c6fddd69e6',
        },
        'darwin-arm64': {
            os: 'darwin', arch: 'arm64', filename: 'bifrost-http',
            sha256: 'cf79d49801475af6a8f90111b9124c60e4395bf0b57fb01fe5fb64ab994919fd',
        },
    },
};

function fresh(name) {
    const dir = path.join(TMP, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function hashBytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function loadSidecar() {
    delete require.cache[require.resolve(LIB_PATH)];
    return require(LIB_PATH);
}

function request(port, pathname) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2000 }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
    });
}

function rawRequest(port, { method = 'GET', pathname = '/', headers = {}, body = '' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: pathname,
            method,
            headers,
            timeout: 5000,
        }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        req.end(body);
    });
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

async function waitFor(fn, timeoutMs = 10000) {
    const until = Date.now() + timeoutMs;
    let last;
    while (Date.now() < until) {
        try { return await fn(); } catch (error) { last = error; }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw last || new Error('timeout');
}

function terminate(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
}

async function runPhase3Isolated() {
    const sidecar = loadSidecar();
    const fixtureRoot = path.join(TMP, 'phase3-isolated');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const frontdoorScript = path.join(ROOT, 'routing', 'frontdoor-proxy.js');
    const keepaliveScript = path.join(ROOT, 'routing', 'keepalive-proxy.js');
    const customOpenAiScript = path.join(ROOT, 'routing', 'custom-openai-proxy.js');
    const secret = 'phase3-private-sentinel';
    const children = [];
    const servers = [];
    const delayedTimers = new Set();
    let frontdoorPort = 0;
    let gateMode = 'normal';
    const heldCallbacks = [];
    const callbackCaptures = [];
    const generations = [];
    let catalogHits = 0;

    const writeJson = (file, value) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
    };
    const listenDynamic = server => new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    const closeServer = server => new Promise(resolve => server.close(() => resolve()));
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitUntil = async (predicate, label, timeoutMs = 10000) => {
        const deadline = Date.now() + timeoutMs;
        let last;
        while (Date.now() < deadline) {
            try {
                const value = await predicate();
                if (value) return value;
            } catch (error) { last = error; }
            await sleep(25);
        }
        throw last || new Error(`timeout waiting for ${label}`);
    };
    const usagePath = path.join(fixtureRoot, 'token-usage.jsonl');
    const usageRows = () => {
        if (!fs.existsSync(usagePath)) return [];
        const text = fs.readFileSync(usagePath, 'utf8').trim();
        return text ? text.split(/\r?\n/).map(line => JSON.parse(line)) : [];
    };
    const parseCase = body => {
        const match = JSON.stringify(body).match(/case:([a-z0-9-]+)/i);
        return match ? match[1].toLowerCase() : 'text';
    };
    const jsonResponse = (res, body, status = 200) => {
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(payload.length) });
        res.end(payload);
    };
    const streamEvent = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    const streamText = (res, body, text = 'phase3 text') => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(streamEvent('message_start', {
            type: 'message_start',
            message: {
                id: 'msg_phase3', type: 'message', role: 'assistant', model: body.model,
                content: [], stop_reason: null, stop_sequence: null,
                usage: { input_tokens: 3, output_tokens: 0 },
            },
        }));
        res.write(streamEvent('content_block_start', {
            type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
        }));
        res.write(streamEvent('content_block_delta', {
            type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
        }));
        res.write(streamEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
        res.write(streamEvent('message_delta', {
            type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { input_tokens: 3, output_tokens: 4 },
        }));
        res.end(streamEvent('message_stop', { type: 'message_stop' }));
    };
    const streamTool = (res, body) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(streamEvent('message_start', {
            type: 'message_start',
            message: {
                id: 'msg_tool_split', type: 'message', role: 'assistant', model: body.model,
                content: [], stop_reason: null, stop_sequence: null,
                usage: { input_tokens: 3, output_tokens: 0 },
            },
        }));
        res.write(streamEvent('content_block_start', {
            type: 'content_block_start', index: 0,
            content_block: { type: 'tool_use', id: 'toolu_split', name: 'read_file', input: {} },
        }));
        res.write(streamEvent('content_block_delta', {
            type: 'content_block_delta', index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":"alpha' },
        }));
        res.write(streamEvent('content_block_delta', {
            type: 'content_block_delta', index: 0,
            delta: { type: 'input_json_delta', partial_json: '.txt"}' },
        }));
        res.write(streamEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
        res.write(streamEvent('message_delta', {
            type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage: { input_tokens: 3, output_tokens: 4 },
        }));
        res.end(streamEvent('message_stop', { type: 'message_stop' }));
    };

    const backend = http.createServer((req, res) => {
        if (req.url === '/v1/models') {
            catalogHits += 1;
            return jsonResponse(res, { data: [{ id: 'hostile-substitute-model' }] });
        }
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { return jsonResponse(res, { error: { message: 'invalid fixture request' } }, 400); }
            if (req.url === '/v1/chat/completions') {
                let closeResolve;
                const entry = {
                    caseName: 'converter-exact', body, headers: { ...req.headers }, startedAt: Date.now(),
                    closedAt: 0, closedBeforeFinish: false,
                    closed: new Promise(resolve => { closeResolve = resolve; }),
                };
                generations.push(entry);
                res.once('close', () => {
                    entry.closedAt = Date.now();
                    entry.closedBeforeFinish = !res.writableFinished;
                    closeResolve(entry);
                });
                if (body && body.stream === true) {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    const values = [
                        { choices: [{ index: 0, delta: { role: 'assistant', content: 'converter exact' }, finish_reason: null }] },
                        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
                        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } },
                    ];
                    return res.end(`${values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')}data: [DONE]\n\n`);
                }
                return jsonResponse(res, {
                    id: 'chatcmpl_converter', model: body && body.model,
                    choices: [{ index: 0, message: { role: 'assistant', content: 'converter exact' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 3, completion_tokens: 4 },
                });
            }
            const caseName = parseCase(body);
            let closeResolve;
            const entry = {
                caseName,
                body,
                headers: { ...req.headers },
                startedAt: Date.now(),
                closedAt: 0,
                closedBeforeFinish: false,
                closed: new Promise(resolve => { closeResolve = resolve; }),
            };
            generations.push(entry);
            res.once('close', () => {
                entry.closedAt = Date.now();
                entry.closedBeforeFinish = !res.writableFinished;
                closeResolve(entry);
            });

            const baseMessage = content => ({
                id: `msg_${caseName}`, type: 'message', role: 'assistant', model: body.model,
                content, stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
                stop_sequence: null, usage: { input_tokens: 3, output_tokens: 4 },
            });
            if (caseName === 'accepted-reset' || caseName === 'direct-accepted-reset') {
                const timer = setTimeout(() => {
                    delayedTimers.delete(timer);
                    if (res.socket && !res.socket.destroyed) res.socket.destroy();
                }, 10);
                delayedTimers.add(timer);
                return;
            }
            if (caseName === 'message-stop-substring') {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                res.write(streamEvent('message_start', {
                    type: 'message_start',
                    message: {
                        id: 'msg_message_stop_substring', type: 'message', role: 'assistant',
                        model: `${body.model}-message_stop`, content: [], stop_reason: null,
                        stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 },
                    },
                }));
                res.write(streamEvent('content_block_start', {
                    type: 'content_block_start', index: 0,
                    content_block: { type: 'text', text: 'message_stop is content only' },
                }));
                res.write(streamEvent('content_block_delta', {
                    type: 'content_block_delta', index: 0,
                    delta: { type: 'text_delta', text: 'partial message_stop text without a terminal event' },
                }));
                return res.end();
            }
            if (caseName === 'exact-stall') {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                res.write(streamEvent('message_start', {
                    type: 'message_start',
                    message: {
                        id: 'msg_exact_stall', type: 'message', role: 'assistant', model: body.model,
                        content: [], stop_reason: null, stop_sequence: null,
                        usage: { input_tokens: 3, output_tokens: 0 },
                    },
                }));
                res.write(streamEvent('content_block_start', {
                    type: 'content_block_start', index: 0,
                    content_block: { type: 'text', text: '' },
                }));
                res.write(streamEvent('content_block_delta', {
                    type: 'content_block_delta', index: 0,
                    delta: { type: 'text_delta', text: 'partial before exact stall' },
                }));
                return;
            }
            if (caseName === 'fallback') {
                return jsonResponse(res, {
                    type: 'error',
                    error: { type: 'model_not_found', message: `${secret}: no exact channel` },
                }, 503);
            }
            if (caseName === 'tool-single') {
                return jsonResponse(res, baseMessage([
                    { type: 'tool_use', id: 'toolu_single', name: 'read_file', input: { path: 'alpha.txt' } },
                ]));
            }
            if (caseName === 'parallel-tools') {
                return jsonResponse(res, baseMessage([
                    { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.txt' } },
                    { type: 'tool_use', id: 'toolu_b', name: 'write_file', input: { path: 'b.txt', text: 'ok' } },
                ]));
            }
            if (caseName === 'tool-results') {
                return jsonResponse(res, baseMessage([{ type: 'text', text: 'tool results accepted' }]));
            }
            if (caseName === 'tool-split') return streamTool(res, body);
            if (caseName === 'delay-unary' || caseName === 'race-claimed') {
                const timer = setTimeout(() => {
                    delayedTimers.delete(timer);
                    if (!res.destroyed) jsonResponse(res, baseMessage([{ type: 'text', text: 'too late' }]));
                }, 5000);
                delayedTimers.add(timer);
                return;
            }
            if (['sidecar-midflight', 'bifrost-death', 'drain-paid', 'callback-close'].includes(caseName)) {
                entry.release = () => {
                    if (!res.destroyed && !res.writableEnded) {
                        jsonResponse(res, baseMessage([{ type: 'text', text: `${caseName} released` }]));
                    }
                };
                return;
            }
            if (caseName === 'delay-stream') {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                res.write(streamEvent('message_start', {
                    type: 'message_start',
                    message: {
                        id: 'msg_delay_stream', type: 'message', role: 'assistant', model: body.model,
                        content: [], stop_reason: null, stop_sequence: null,
                        usage: { input_tokens: 3, output_tokens: 0 },
                    },
                }));
                res.write(streamEvent('content_block_start', {
                    type: 'content_block_start', index: 0,
                    content_block: { type: 'text', text: '' },
                }));
                res.write(streamEvent('content_block_delta', {
                    type: 'content_block_delta', index: 0,
                    delta: { type: 'text_delta', text: 'partial before cancel' },
                }));
                const timer = setTimeout(() => {
                    delayedTimers.delete(timer);
                    if (!res.destroyed) streamText(res, body, 'late duplicate');
                }, 5000);
                delayedTimers.add(timer);
                return;
            }
            if (caseName === 'truncated-partial') {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                res.write(streamEvent('message_start', {
                    type: 'message_start',
                    message: {
                        id: 'msg_truncated', type: 'message', role: 'assistant', model: body.model,
                        content: [], stop_reason: null, stop_sequence: null,
                        usage: { input_tokens: 3, output_tokens: 0 },
                    },
                }));
                res.write(streamEvent('content_block_start', {
                    type: 'content_block_start', index: 0,
                    content_block: { type: 'text', text: '' },
                }));
                res.write(streamEvent('content_block_delta', {
                    type: 'content_block_delta', index: 0,
                    delta: { type: 'text_delta', text: 'cut' },
                }));
                return res.end();
            }
            if (caseName === 'truncated-zero') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                return res.end();
            }
            if (caseName === 'truncated-json') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.flushHeaders();
                res.write('{"id":"msg_cut","type":"message","model":"private');
                const timer = setTimeout(() => {
                    delayedTimers.delete(timer);
                    if (res.socket && !res.socket.destroyed) res.socket.destroy();
                }, 25);
                delayedTimers.add(timer);
                return;
            }
            if (body.stream === true) return streamText(res, body);
            return jsonResponse(res, baseMessage([{ type: 'text', text: `phase3 ${caseName}` }]));
        });
    });
    const backendPort = await listenDynamic(backend);
    servers.push(backend);

    const remoteBackend = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { return jsonResponse(res, { error: { message: 'invalid fixture request' } }, 400); }
            const caseName = parseCase(body);
            let closeResolve;
            const entry = {
                caseName,
                body,
                headers: { ...req.headers },
                startedAt: Date.now(),
                closedAt: 0,
                closedBeforeFinish: false,
                closed: new Promise(resolve => { closeResolve = resolve; }),
            };
            generations.push(entry);
            res.once('close', () => {
                entry.closedAt = Date.now();
                entry.closedBeforeFinish = !res.writableFinished;
                closeResolve(entry);
            });
            const responseBody = {
                id: `msg_${caseName}`, type: 'message', role: 'assistant', model: body.model,
                content: [{ type: 'text', text: `phase3 ${caseName}` }], stop_reason: 'end_turn',
                stop_sequence: null, usage: { input_tokens: 3, output_tokens: 4 },
            };
            if (caseName === 'direct-accepted-reset') {
                const timer = setTimeout(() => {
                    delayedTimers.delete(timer);
                    if (res.socket && !res.socket.destroyed) res.socket.destroy();
                }, 10);
                delayedTimers.add(timer);
                return;
            }
            if (caseName === 'native-gzip') {
                const compressed = zlib.gzipSync(Buffer.from(JSON.stringify({
                    ...responseBody,
                    model: 'private-native-model',
                    private_detail: 'preserved-provider-field',
                }), 'utf8'));
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'content-encoding': 'gzip',
                    'content-length': String(compressed.length),
                });
                return res.end(compressed);
            }
            jsonResponse(res, responseBody);
        });
    });
    const remoteBackendPort = await listenDynamic(remoteBackend);
    servers.push(remoteBackend);

    const capturedHeaders = capture => {
        const result = {};
        for (const [name, value] of Object.entries(capture.headers)) {
            const lower = name.toLowerCase();
            if (['host', 'connection', 'transfer-encoding', 'content-length'].includes(lower)) continue;
            result[lower] = value;
        }
        result['content-length'] = String(capture.body.length);
        return result;
    };
    const forwardCapture = (capture, downstreamRes = null) => new Promise(resolve => {
        const target = http.request({
            host: '127.0.0.1', port: frontdoorPort, method: capture.method, path: capture.path,
            headers: capturedHeaders(capture), timeout: 10000,
        }, targetRes => {
            const parts = [];
            targetRes.on('data', chunk => {
                parts.push(chunk);
                if (downstreamRes && !downstreamRes.destroyed) downstreamRes.write(chunk);
            });
            if (downstreamRes && !downstreamRes.destroyed) downstreamRes.writeHead(targetRes.statusCode, targetRes.headers);
            targetRes.on('end', () => {
                if (downstreamRes && !downstreamRes.destroyed) downstreamRes.end();
                resolve({ status: targetRes.statusCode, body: Buffer.concat(parts).toString('utf8') });
            });
            targetRes.on('aborted', () => {
                if (downstreamRes && !downstreamRes.destroyed) downstreamRes.destroy();
                resolve({ status: targetRes.statusCode, body: Buffer.concat(parts).toString('utf8'), aborted: true });
            });
        });
        if (downstreamRes) {
            downstreamRes.on('close', () => {
                if (!downstreamRes.writableFinished && !target.destroyed) target.destroy();
            });
        }
        target.on('error', error => {
            if (downstreamRes && !downstreamRes.destroyed) downstreamRes.destroy(error);
            resolve({ status: 0, body: '', error: error.code || error.message });
        });
        target.end(capture.body);
    });
    const callbackGate = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const capture = {
                method: req.method,
                path: req.url,
                headers: { ...req.headers },
                rawHeaders: [...req.rawHeaders],
                body: Buffer.concat(chunks),
            };
            callbackCaptures.push(capture);
            if (gateMode === 'hold') {
                capture.release = () => forwardCapture(capture, res);
                heldCallbacks.push(capture);
                return;
            }
            if (gateMode === 'close-after-arrival') {
                capture.forwarded = forwardCapture(capture, res);
                capture.forwarded.catch(() => {});
                (async () => {
                    try {
                        await waitUntil(() => generations.some(entry => entry.caseName === 'callback-close'),
                            'callback-close backend arrival', 5000);
                        if (res.socket && !res.socket.destroyed) res.socket.destroy();
                    } catch {
                        if (res.socket && !res.socket.destroyed) res.socket.destroy();
                    }
                })();
                return;
            }
            capture.forwarded = forwardCapture(capture, res);
            capture.forwarded.catch(() => {});
        });
    });
    const gatePort = await listenDynamic(callbackGate);
    servers.push(callbackGate);

    const keepalivePort = await freePort();
    const converterPort = await freePort();
    const converterKeepalivePort = await freePort();
    const frontPort = await freePort();
    const bridgePort = await freePort();
    const bifrostPort = await freePort();
    frontdoorPort = frontPort;
    const keyFile = path.join(fixtureRoot, 'provider-key.txt');
    const modelMap = path.join(fixtureRoot, 'hostile-modelmap.json');
    const providerKey = 'fixture-provider-key';
    fs.writeFileSync(keyFile, `${providerKey}\n`, 'utf8');
    writeJson(modelMap, {
        default: 'hostile-substitute-model', opus: 'hostile-substitute-model',
        sonnet: 'hostile-substitute-model', haiku: 'hostile-substitute-model', gpt: 'hostile-substitute-model',
    });
    const localHopSecretPath = path.join(fixtureRoot, 'abuse-hub-local-hop.key');
    const converterConfigPath = path.join(fixtureRoot, 'converter.json');
    writeJson(converterConfigPath, {
        port: converterPort,
        upstream: `http://127.0.0.1:${backendPort}/v1`,
        keyFile,
        modelMap: {
            opus: 'forbidden-converter-opus',
            sonnet: 'forbidden-converter-sonnet',
            haiku: 'forbidden-converter-haiku',
        },
        providerName: 'KVOTUM-fixture',
        localHopSecretPath,
        strictToolsVision: true,
    });
    let converterStderr = '';
    const converter = spawn(process.execPath, [customOpenAiScript, converterConfigPath], {
        cwd: path.dirname(customOpenAiScript),
        env: {
            ...process.env,
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: localHopSecretPath,
            HOME: fixtureRoot,
            USERPROFILE: fixtureRoot,
            PORT: String(converterPort),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    children.push(converter);
    converter.stderr.on('data', chunk => { converterStderr = (converterStderr + chunk.toString('utf8')).slice(-8000); });
    await waitUntil(async () => {
        const ready = await request(converterPort, '/health');
        return ready.status === 200;
    }, 'isolated converter', 15000);

    const productionTopologySource = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8');
    const productionKvTopology = /async function kvKeepaliveSpawn\(\)[\s\S]*?watchChildExit\(child, 'keepalive KVOTUM'/.exec(productionTopologySource);
    assert.ok(productionKvTopology, 'production KVOTUM keepalive topology is missing');
    assert.match(productionKvTopology[0], /UPSTREAM:\s*KV_CONVERTER_URL[\s\S]*?LOCAL_EXACT_ADAPTER:\s*'1'/,
        'production KVOTUM keepalive must mark its local custom-openai adapter');

    let converterKeepaliveStderr = '';
    const converterKeepalive = spawn(process.execPath, [keepaliveScript], {
        cwd: path.dirname(keepaliveScript),
        env: {
            ...process.env,
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: localHopSecretPath,
            HOME: fixtureRoot,
            USERPROFILE: fixtureRoot,
            PORT: String(converterKeepalivePort),
            UPSTREAM: `http://127.0.0.1:${converterPort}`,
            KEY_FILE: keyFile,
            MODELMAP_FILE: modelMap,
            KEEPALIVE_LOG_FILE: path.join(fixtureRoot, 'converter-keepalive.log'),
            CONFIG_FILE: path.join(fixtureRoot, 'converter-keepalive-config.json'),
            LATENCY_FILE: path.join(fixtureRoot, 'converter-latency.json'),
            EVENTS_FILE: path.join(fixtureRoot, 'converter-events.json'),
            FAILDUMP_DIR: path.join(fixtureRoot, 'converter-faildump'),
            SWITCH_PORT: '1',
            DASHBOARD_URL: 'http://127.0.0.1:1',
            PAID_SINGLE_KEY: '0',
            AUTOROTATE: '0',
            HAIKU_GPT_PROXY: '',
            GPT_PROXY_FORCE: '0',
            HAIKU_TO_MODEL: 'forbidden-keepalive-haiku',
            POOL_FALLBACK_MODEL: 'forbidden-keepalive-fallback',
            VISION_BRIDGE: '0',
            HEDGE_MS: '5',
            MAX_HEDGES: '2',
            MAX_ATTEMPTS: '3',
            PRE_COMMIT_MS: '0',
            HOLD_MS: '0',
            EMPTY_STREAM_MS: '0',
            JSON_HOLD_MS: '0',
            STALL_MS: '175',
            CATALOG_TTL_MS: '600000',
            RETRY_DELAY_MS: '10',
            RETRY_FAST_FAIL_MS: '2000',
            RETRY_BUDGET_MS: '10000',
            UPSTREAM_TIMEOUT_MS: '10000',
            COUNT_TOKENS_FALLBACK: '0',
            THINK_STRIP: '1',
            UPSTREAM_NOSTREAM: '0',
            MODEL_ECHO_INJECT: '1',
            LOCAL_EXACT_ADAPTER: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    children.push(converterKeepalive);
    converterKeepalive.stderr.on('data', chunk => {
        converterKeepaliveStderr = (converterKeepaliveStderr + chunk.toString('utf8')).slice(-8000);
    });
    await waitUntil(async () => {
        const ready = await request(converterKeepalivePort, '/__keepalive/api/status');
        return ready.status === 200;
    }, 'isolated converter keepalive', 15000);

    let keepaliveStderr = '';
    const keepalive = spawn(process.execPath, [keepaliveScript], {
        cwd: path.dirname(keepaliveScript),
        env: {
            ...process.env,
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: localHopSecretPath,
            HOME: fixtureRoot,
            USERPROFILE: fixtureRoot,
            PORT: String(keepalivePort),
            UPSTREAM: `http://127.0.0.1:${backendPort}`,
            KEY_FILE: keyFile,
            MODELMAP_FILE: modelMap,
            KEEPALIVE_LOG_FILE: path.join(fixtureRoot, 'keepalive.log'),
            CONFIG_FILE: path.join(fixtureRoot, 'keepalive-config.json'),
            LATENCY_FILE: path.join(fixtureRoot, 'latency.json'),
            EVENTS_FILE: path.join(fixtureRoot, 'events.json'),
            FAILDUMP_DIR: path.join(fixtureRoot, 'faildump'),
            SWITCH_PORT: '1',
            DASHBOARD_URL: 'http://127.0.0.1:1',
            PAID_SINGLE_KEY: '0',
            AUTOROTATE: '0',
            HAIKU_GPT_PROXY: '',
            GPT_PROXY_FORCE: '0',
            HAIKU_TO_MODEL: 'hostile-substitute-model',
            POOL_FALLBACK_MODEL: 'hostile-substitute-model',
            VISION_BRIDGE: '1',
            HEDGE_MS: '5',
            MAX_HEDGES: '2',
            MAX_ATTEMPTS: '3',
            PRE_COMMIT_MS: '0',
            HOLD_MS: '0',
            EMPTY_STREAM_MS: '0',
            JSON_HOLD_MS: '0',
            STALL_MS: '175',
            CATALOG_TTL_MS: '600000',
            RETRY_DELAY_MS: '10',
            RETRY_FAST_FAIL_MS: '2000',
            RETRY_BUDGET_MS: '10000',
            UPSTREAM_TIMEOUT_MS: '10000',
            COUNT_TOKENS_FALLBACK: '0',
            THINK_STRIP: '1',
            UPSTREAM_NOSTREAM: '0',
            MODEL_ECHO_INJECT: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    children.push(keepalive);
    keepalive.stderr.on('data', chunk => { keepaliveStderr = (keepaliveStderr + chunk.toString('utf8')).slice(-8000); });
    await waitUntil(async () => {
        const ready = await request(keepalivePort, '/__keepalive/api/status');
        return ready.status === 200;
    }, 'isolated keepalive', 15000);

    const lazyBackendPort = await freePort();
    let lazyBackend = null;
    let lazyEnsureHits = 0;
    const lazyDashboard = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', async () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            assert.equal(req.method, 'POST');
            assert.equal(req.url, '/__switch/api/keepalive/ensure');
            assert.equal(body.port, lazyBackendPort);
            lazyEnsureHits += 1;
            if (!lazyBackend) {
                lazyBackend = http.createServer((backendReq, backendRes) => {
                    const bodyChunks = [];
                    backendReq.on('data', chunk => bodyChunks.push(chunk));
                    backendReq.on('end', () => {
                        const requestBody = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
                        let closeResolve;
                        const entry = {
                            caseName: 'lazy-ensure', body: requestBody,
                            headers: { ...backendReq.headers }, startedAt: Date.now(),
                            closedAt: 0, closedBeforeFinish: false,
                            closed: new Promise(resolve => { closeResolve = resolve; }),
                        };
                        generations.push(entry);
                        backendRes.once('close', () => {
                            entry.closedAt = Date.now();
                            entry.closedBeforeFinish = !backendRes.writableFinished;
                            closeResolve(entry);
                        });
                        jsonResponse(backendRes, {
                            id: 'msg_lazy', type: 'message', role: 'assistant', model: requestBody.model,
                            content: [{ type: 'text', text: 'lazy ensured' }], stop_reason: 'end_turn',
                            stop_sequence: null, usage: { input_tokens: 3, output_tokens: 4 },
                        });
                    });
                });
                await new Promise((resolve, reject) => {
                    lazyBackend.once('error', reject);
                    lazyBackend.listen(lazyBackendPort, '127.0.0.1', () => {
                        lazyBackend.removeListener('error', reject);
                        resolve();
                    });
                });
                servers.push(lazyBackend);
            }
            jsonResponse(res, { ok: true, already: lazyEnsureHits > 1 });
        });
    });
    const lazyDashboardPort = await listenDynamic(lazyDashboard);
    servers.push(lazyDashboard);

    const activePath = path.join(fixtureRoot, '.claude', 'active-backend.json');
    const backendsPath = path.join(fixtureRoot, '.claude', 'backends.json');
    const defaultManifestPath = path.join(fixtureRoot, 'routing', 'api-gateway.default.json');
    const manifestPath = path.join(fixtureRoot, 'routing', 'api-gateway.json');
    const settingsPath = path.join(fixtureRoot, '.claude', 'settings.json');
    const providerState = name => ({
        backend: name,
        upstream: `http://127.0.0.1:${keepalivePort}`,
        modelmap: modelMap,
        updatedAt: Date.now(),
    });
    const remoteState = {
        backend: 'remote',
        upstream: `http://[::ffff:127.0.0.1]:${remoteBackendPort}`,
        keyFile,
        modelmap: modelMap,
        updatedAt: Date.now(),
    };
    const providerRecords = {
        agentrouter: providerState('agentrouter'),
        gemini: providerState('gemini'),
        remote: remoteState,
        directlocal: {
            backend: 'directlocal',
            upstream: `http://127.0.0.1:${remoteBackendPort}`,
            modelmap: null,
            updatedAt: Date.now(),
        },
        lazy: {
            backend: 'lazy',
            upstream: `http://127.0.0.1:${lazyBackendPort}`,
            modelmap: null,
            updatedAt: Date.now(),
        },
        converter: {
            backend: 'converter',
            upstream: `http://127.0.0.1:${converterKeepalivePort}`,
            modelmap: modelMap,
            updatedAt: Date.now(),
        },
    };
    writeJson(activePath, providerState('agentrouter'));
    writeJson(backendsPath, {
        version: 1,
        providers: providerRecords,
        aliases: { ar: 'agentrouter' },
    });
    writeJson(defaultManifestPath, {
        version: 1,
        revision: 1,
        enabled: true,
        models: {
            'agentrouter/vendor/nested/model': {
                displayName: 'Phase 3 Fixture', claudeBehavesAs: 'claude-opus-5',
                contextTokens: 1000, outputTokens: 100, publishedAt: '2026-11-10T00:00:00.000Z',
            },
        },
    });

    let bridgeMode = 'proxy';
    let bridgeHits = 0;
    let bridgeLastToken = '';
    let bridgeHeldTarget = null;
    let bridgeHeldResponse = null;
    let bridgeEarlyCase = '';
    const syntheticBridgeTokens = [];
    const bridgeSockets = new Set();
    const bridge = http.createServer((req, res) => {
        bridgeHits += 1;
        bridgeLastToken = String(req.headers['x-bf-eh-x-abuse-hub-request-token'] || '');
        if (bridgeMode !== 'proxy' && bridgeLastToken) syntheticBridgeTokens.push(bridgeLastToken);
        if (bridgeMode === 'early-success-after-claim') {
            const target = http.request({
                host: '127.0.0.1',
                port: bifrostPort,
                method: req.method,
                path: req.url,
                headers: { ...req.headers, host: `127.0.0.1:${bifrostPort}` },
            });
            target.on('error', () => {});
            req.pipe(target);
            const finishEarly = async () => {
                try {
                    await waitUntil(() => generations.some(entry => entry.caseName === bridgeEarlyCase),
                        `early sidecar ${bridgeEarlyCase} backend arrival`, 5000);
                    const payload = Buffer.from(JSON.stringify({
                        id: `chat_${bridgeEarlyCase}`,
                        object: 'chat.completion',
                        model: `abuse-hub/agentrouter/${bridgeEarlyCase}`,
                        choices: [{ index: 0, message: { role: 'assistant', content: 'early sidecar response' }, finish_reason: 'stop' }],
                    }), 'utf8');
                    if (!res.destroyed) {
                        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(payload.length) });
                        res.end(payload);
                    }
                } catch {
                    if (!res.destroyed) res.destroy();
                }
            };
            finishEarly();
            res.on('close', () => { if (!res.writableFinished) target.destroy(); });
            return;
        }
        if (bridgeMode === 'stream-json-error') {
            return jsonResponse(res, {
                error: { message: secret },
                detail: secret,
                local_path: fixtureRoot,
                route: 'private-route',
            }, 200);
        }
        if (bridgeMode === 'truncate-nonstream') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.flushHeaders();
            res.write('{"id":"outer-cut"');
            return setTimeout(() => {
                if (res.socket && !res.socket.destroyed) res.socket.destroy();
            }, 10);
        }
        if (bridgeMode === 'private-error') {
            return jsonResponse(res, { detail: secret, local_path: fixtureRoot, error: null }, 500);
        }
        if (bridgeMode === 'success-error') {
            return jsonResponse(res, { error: { message: secret }, local_path: fixtureRoot }, 200);
        }
        if (bridgeMode === 'malformed-error') {
            res.writeHead(500, { 'content-type': 'application/json' });
            return res.end('{');
        }
        if (bridgeMode === 'array-error') {
            return jsonResponse(res, [secret], 404);
        }
        const target = http.request({
            host: '127.0.0.1',
            port: bifrostPort,
            method: req.method,
            path: req.url,
            headers: { ...req.headers, host: `127.0.0.1:${bifrostPort}` },
        }, targetRes => {
            res.writeHead(targetRes.statusCode || 502, targetRes.headers);
            targetRes.pipe(res);
        });
        if (bridgeMode === 'hold-response') {
            bridgeHeldTarget = target;
            bridgeHeldResponse = res;
        }
        target.on('error', () => {
            if (!res.headersSent && !res.destroyed) res.writeHead(503, { 'content-type': 'application/json' });
            if (!res.destroyed) res.end('{}');
        });
        req.pipe(target);
        res.on('close', () => { if (!res.writableFinished) target.destroy(); });
    });
    bridge.on('connection', socket => {
        bridgeSockets.add(socket);
        socket.on('close', () => bridgeSockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        bridge.once('error', reject);
        bridge.listen(bridgePort, '127.0.0.1', () => {
            bridge.removeListener('error', reject);
            resolve();
        });
    });
    servers.push(bridge);

    let frontdoorStderr = '';
    const frontdoor = spawn(process.execPath, [frontdoorScript], {
        cwd: path.dirname(frontdoorScript),
        env: {
            ...process.env,
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: localHopSecretPath,
            HOME: fixtureRoot,
            USERPROFILE: fixtureRoot,
            PORT: String(frontdoorPort),
            ACTIVE_BACKEND_FILE: activePath,
            BACKENDS_FILE: backendsPath,
            API_GATEWAY_DEFAULT_FILE: defaultManifestPath,
            API_GATEWAY_FILE: manifestPath,
            CLAUDE_SETTINGS_FILE: settingsPath,
            TOKEN_USAGE_FILE: usagePath,
            LOG_FILE: path.join(fixtureRoot, 'frontdoor.log'),
            SWITCH_PORT: String(lazyDashboardPort),
            BIFROST_URL: `http://127.0.0.1:${bridgePort}`,
            BIFROST_INTERNAL_MARKER: sidecar.INTERNAL_HOP_MARKER,
            MULTI_MAP_FILE: path.join(fixtureRoot, 'multi-routes-modelmap.json'),
            UPSTREAM_TIMEOUT_MS: '10000',
            DRAIN_MAX_MS: '250',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    children.push(frontdoor);
    frontdoor.stderr.on('data', chunk => { frontdoorStderr = (frontdoorStderr + chunk.toString('utf8')).slice(-8000); });
    await waitUntil(async () => {
        const ready = await rawRequest(frontdoorPort, { pathname: '/openai/v1/models' });
        return ready.status === 200;
    }, 'isolated frontdoor', 15000);

    const expected = sidecar.expectedExecutable();
    assert.equal(sidecar.verifyFile(expected.executable, expected.artifact.sha256).ok, true,
        'phase3 isolated mode requires the exact pinned cached Bifrost binary');
    const runtimeRoot = path.join(fixtureRoot, 'runtime');
    const appDir = path.join(runtimeRoot, expected.lock.version);
    const configPath = sidecar.writeRuntimeConfig({
        appDir,
        baseUrl: `http://127.0.0.1:${gatePort}`,
    });
    const descriptor = sidecar.createServiceDescriptor({
        executable: expected.executable,
        appDir,
        configPath,
        port: bifrostPort,
        expectedSha256: expected.artifact.sha256,
        version: expected.lock.version,
    });
    const childEnv = {};
    for (const name of ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
        if (process.env[name] !== undefined) childEnv[name] = process.env[name];
    }
    Object.assign(childEnv, descriptor.env, { HOME: fixtureRoot, USERPROFILE: fixtureRoot });
    let bifrostStderr = '';
    let bifrost = spawn(descriptor.executable, descriptor.args, {
        cwd: descriptor.cwd,
        env: childEnv,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    children.push(bifrost);
    bifrost.stderr.on('data', chunk => { bifrostStderr = (bifrostStderr + chunk.toString('utf8')).slice(-8000); });
    await waitUntil(async () => {
        const health = await request(bifrostPort, '/health');
        return health.status === 200;
    }, 'pinned Bifrost', 20000);

    const startRequest = ({
        port = frontdoorPort,
        pathname = '/openai/v1/chat/completions',
        body,
        headers = {},
        timeoutMs = 20000,
        onData = null,
    }) => {
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        let response = null;
        let settled = false;
        let resolveDone;
        const done = new Promise(resolve => { resolveDone = resolve; });
        const finish = value => {
            if (settled) return;
            settled = true;
            resolveDone(value);
        };
        const client = http.request({
            host: '127.0.0.1', port, method: 'POST', path: pathname,
            headers: {
                'content-type': 'application/json',
                'content-length': String(payload.length),
                ...headers,
            },
            timeout: timeoutMs,
        }, res => {
            response = res;
            const chunks = [];
            res.on('data', chunk => {
                chunks.push(chunk);
                if (onData) onData(chunk, client, res);
            });
            res.on('end', () => finish({
                status: res.statusCode, headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'), complete: true,
            }));
            res.on('aborted', () => finish({
                status: res.statusCode, headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'), complete: false, aborted: true,
            }));
            res.on('error', error => finish({
                status: res.statusCode, headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'), complete: false,
                error: error.code || error.message,
            }));
        });
        client.on('timeout', () => client.destroy(new Error('phase3 fixture timeout')));
        client.on('error', error => finish({
            status: response && response.statusCode || 0,
            headers: response && response.headers || {}, body: '', complete: false,
            error: error.code || error.message,
        }));
        client.end(payload);
        return { client, done };
    };
    const publicCall = async (body, headers) => startRequest({ body, headers }).done;
    const openAiObjects = text => text.split(/\r?\n/)
        .filter(line => line.startsWith('data:') && line.trim() !== 'data: [DONE]')
        .map(line => JSON.parse(line.slice(5).trim()));
    const assertPublicModel = (response, publicModel) => {
        if (String(response.headers['content-type'] || '').includes('event-stream')) {
            const objects = openAiObjects(response.body);
            assert.ok(objects.length > 0, `no OpenAI SSE objects for ${publicModel}`);
            for (const object of objects) assert.equal(object.model, publicModel);
            return objects;
        }
        const object = JSON.parse(response.body);
        assert.equal(object.model, publicModel);
        return object;
    };
    const assertSingleGenerationAndUsage = async (beforeGenerations, beforeRows, publicModel) => {
        assert.equal(generations.length, beforeGenerations + 1, `generation count for ${publicModel}`);
        await waitUntil(() => usageRows().length === beforeRows + 1, `usage row for ${publicModel}`);
        assert.equal(usageRows().length, beforeRows + 1, `outer leg duplicated usage for ${publicModel}`);
    };
    const basePublicHeaders = {
        authorization: `Bearer ${secret}`,
        'x-api-key': secret,
        cookie: `session=${secret}`,
        'proxy-authorization': `Basic ${secret}`,
        'user-agent': 'opencode-phase3',
        'x-request-id': 'phase3-request',
        'x-session-id': 'phase3-session',
    };

    try {
        const runSuccess = async (body, check) => {
            const publicModel = body.model;
            const beforeGenerations = generations.length;
            const beforeRows = usageRows().length;
            const beforeCallbacks = callbackCaptures.length;
            const response = await publicCall(body, basePublicHeaders);
            assert.equal(response.status, 200, `${publicModel}: ${response.body} ${frontdoorStderr} ${bifrostStderr}`);
            assert.equal(response.complete, true, `${publicModel} response was incomplete`);
            const outward = assertPublicModel(response, publicModel);
            await assertSingleGenerationAndUsage(beforeGenerations, beforeRows, publicModel);
            assert.equal(callbackCaptures.length, beforeCallbacks + 1, 'one Bifrost callback per public request');
            const callback = callbackCaptures.at(-1);
            assert.equal(callback.headers['x-abuse-hub-internal'], sidecar.INTERNAL_HOP_MARKER);
            assert.match(String(callback.headers['x-abuse-hub-request-token'] || ''), /^[A-Za-z0-9_-]{43}$/);
            assert.equal(callback.headers['x-bf-eh-x-abuse-hub-request-token'], undefined,
                'Bifrost must strip only the event-handler carrier prefix');
            const generation = generations.at(-1);
            assert.equal(generation.body.model, publicModel.slice(publicModel.indexOf('/') + 1));
            assert.equal(generation.headers['x-route-final'], undefined);
            assert.equal(generation.headers['x-route-exact'], undefined);
            assert.equal(generation.headers['x-abuse-hub-internal'], undefined);
            assert.equal(generation.headers['x-abuse-hub-request-token'], undefined);
            if (check) await check(outward, response, generation);
            return { outward, response, generation, callback };
        };

        const nested = await runSuccess({
            model: 'agentrouter/vendor/nested/model',
            messages: [{ role: 'user', content: 'case:text' }],
            stream: false,
        }, outward => {
            assert.equal(outward.choices[0].message.content, 'phase3 text');
            assert.equal(outward.usage.prompt_tokens, 3);
            assert.equal(outward.usage.completion_tokens, 4);
        });

        await runSuccess({
            model: 'remote/Vendor/Nested/Case[1m]',
            messages: [{ role: 'user', content: 'case:remote-credentials' }],
            stream: false,
        }, (_outward, _response, generation) => {
            assert.equal(generation.headers.authorization, `Bearer ${providerKey}`);
            assert.equal(generation.headers['x-api-key'], providerKey);
            for (const name of [
                'x-route-final', 'x-route-exact', 'x-abuse-hub-internal',
                'x-abuse-hub-request-token', 'x-bf-hostile', 'x-route-hostile',
                'x-abuse-hub-hostile', 'cookie', 'proxy-authorization',
            ]) assert.equal(generation.headers[name], undefined, `${name} reached remote vendor`);
        });

        await runSuccess({
            model: 'converter/DeepSeek/Nested/Case-Sensitive[1m]',
            messages: [{ role: 'user', content: 'case:converter-exact' }],
            stream: false,
        }, (_outward, _response, generation) => {
            assert.equal(generation.body.model, 'DeepSeek/Nested/Case-Sensitive[1m]');
            assert.equal(generation.headers['x-abuse-hub-local-exact'], undefined,
                'local adapter exact marker reached final vendor');
        });

        await runSuccess({
            model: 'gemini/claude-opus-4-6',
            messages: [{ role: 'user', content: 'case:stream-text' }],
            stream: true,
        }, (_objects, response) => {
            assert.equal((response.body.match(/data: \[DONE\]/g) || []).length, 1);
            assert.match(response.body, /phase3 text/);
        });

        await runSuccess({
            model: 'agentrouter/tools/single',
            messages: [{ role: 'user', content: 'case:tool-single' }],
            stream: false,
        }, outward => {
            const calls = outward.choices[0].message.tool_calls;
            assert.equal(calls.length, 1);
            assert.equal(calls[0].id, 'toolu_single');
            assert.equal(calls[0].function.name, 'read_file');
            assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'alpha.txt' });
        });

        await runSuccess({
            model: 'agentrouter/tools/split',
            messages: [{ role: 'user', content: 'case:tool-split' }],
            stream: true,
        }, (objects, response) => {
            const deltas = objects.flatMap(object => object.choices || [])
                .map(choice => choice.delta && choice.delta.tool_calls)
                .filter(Boolean).flat();
            assert.ok(deltas.length >= 2, 'split tool arguments did not stream');
            const args = deltas.map(call => call.function && call.function.arguments || '').join('');
            assert.equal(args, '{"path":"alpha.txt"}');
            assert.equal((response.body.match(/data: \[DONE\]/g) || []).length, 1);
        });

        const parallel = await runSuccess({
            model: 'agentrouter/tools/parallel',
            messages: [{ role: 'user', content: 'case:parallel-tools' }],
            stream: false,
        }, outward => {
            const calls = outward.choices[0].message.tool_calls;
            assert.deepEqual(calls.map(call => [call.id, call.function.name]), [
                ['toolu_a', 'read_file'], ['toolu_b', 'write_file'],
            ]);
        });

        const priorCalls = parallel.outward.choices[0].message.tool_calls;
        await runSuccess({
            model: 'agentrouter/tools/parallel',
            messages: [
                { role: 'user', content: 'run both tools' },
                { role: 'assistant', content: null, tool_calls: priorCalls },
                { role: 'tool', tool_call_id: 'toolu_a', content: 'A result' },
                { role: 'tool', tool_call_id: 'toolu_b', content: 'B result' },
                { role: 'user', content: 'case:tool-results' },
            ],
            stream: false,
        }, (outward, _response, generation) => {
            assert.equal(outward.choices[0].message.content, 'tool results accepted');
            const serialized = JSON.stringify(generation.body.messages);
            assert.match(serialized, /toolu_a/);
            assert.match(serialized, /toolu_b/);
            assert.match(serialized, /tool_result/);
        });

        bridgeMode = 'stream-json-error';
        const beforeStreamJsonError = generations.length;
        const beforeStreamJsonRows = usageRows().length;
        const streamJsonError = await publicCall({
            model: 'agentrouter/stream-json-error',
            messages: [{ role: 'user', content: 'case:text' }],
            stream: true,
        }, basePublicHeaders);
        assert.equal(streamJsonError.status, 503, JSON.stringify(streamJsonError));
        assert.equal(streamJsonError.complete, true, 'stream 2xx JSON error must be a complete redacted JSON response');
        assert.equal(String(streamJsonError.headers['content-type'] || '').split(';', 1)[0], 'application/json');
        assert.deepEqual(JSON.parse(streamJsonError.body), {
            error: { message: 'Upstream request failed.', type: 'api_error', code: 'upstream_unavailable' },
            model: 'agentrouter/stream-json-error',
        });
        assert.equal(streamJsonError.body.includes(secret), false, 'stream 2xx JSON error leaked private sentinel');
        assert.equal(streamJsonError.body.includes(fixtureRoot), false, 'stream 2xx JSON error leaked private path');
        assert.equal(generations.length, beforeStreamJsonError, 'stream 2xx JSON error reached paid backend');
        assert.equal(usageRows().length, beforeStreamJsonRows, 'stream 2xx JSON error wrote usage');
        bridgeMode = 'proxy';

        const directResetBefore = generations.length;
        const directResetEnsuresBefore = lazyEnsureHits;
        const directResetBody = JSON.stringify({
            model: 'directlocal/direct-accepted-reset',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'case:direct-accepted-reset' }],
        });
        const directReset = await rawRequest(frontdoorPort, {
            method: 'POST', pathname: '/v1/messages',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(directResetBody),
            },
            body: directResetBody,
        }).catch(error => ({ status: 0, error: error.code || error.message }));
        assert.equal(directReset.status === 200, false, JSON.stringify(directReset));
        await sleep(250);
        assert.equal(generations.length, directResetBefore + 1,
            'direct canonical post-body local reset replayed the paid generation');
        assert.equal(lazyEnsureHits, directResetEnsuresBefore,
            'direct canonical post-body local reset invoked lazy ensure');

        const nativeGzipModel = 'remote/Native/Gzip/Case[1m]';
        const nativeGzipBody = JSON.stringify({
            model: nativeGzipModel,
            max_tokens: 8,
            messages: [{ role: 'user', content: 'case:native-gzip' }],
        });
        const nativeGzip = await rawRequest(frontdoorPort, {
            method: 'POST', pathname: '/v1/messages',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(nativeGzipBody),
                'accept-encoding': 'gzip',
                authorization: `Bearer ${secret}`,
                'x-api-key': secret,
                cookie: `session=${secret}`,
                'proxy-authorization': `Basic ${secret}`,
                'x-route-hostile': secret,
                'x-bf-hostile': secret,
                'x-abuse-hub-hostile': secret,
            },
            body: nativeGzipBody,
        });
        assert.equal(nativeGzip.status, 200, nativeGzip.body);
        assert.equal(nativeGzip.headers['content-encoding'], undefined,
            'decoded direct native response retained upstream encoding');
        const nativeGzipObject = JSON.parse(nativeGzip.body);
        assert.equal(nativeGzipObject.model, nativeGzipModel,
            'encoded direct native response did not restore full canonical provider/model');
        assert.equal(nativeGzipObject.private_detail, 'preserved-provider-field',
            'encoded direct native response lost provider fields');
        const nativeGzipGeneration = generations.at(-1);
        assert.equal(nativeGzipGeneration.body.model, 'Native/Gzip/Case[1m]');
        assert.equal(nativeGzipGeneration.headers.authorization, `Bearer ${providerKey}`);
        assert.equal(nativeGzipGeneration.headers['x-api-key'], providerKey);
        assert.equal(nativeGzipGeneration.headers['accept-encoding'], 'identity');
        for (const name of [
            'cookie', 'proxy-authorization', 'x-route-hostile', 'x-bf-hostile',
            'x-abuse-hub-hostile', 'x-route-final', 'x-route-exact',
        ]) assert.equal(nativeGzipGeneration.headers[name], undefined,
            `direct remote native leaked ${name}`);

        const exactIncompleteCase = async (caseName, markerText) => {
            const before = generations.length;
            const result = await publicCall({
                model: `agentrouter/exact/${caseName}`,
                messages: [{ role: 'user', content: `case:${caseName}` }],
                stream: true,
            }, basePublicHeaders);
            assert.equal(result.status, 200, `${caseName}: ${JSON.stringify(result)}`);
            assert.equal(result.body.includes('data: [DONE]'), false,
                `${caseName}: exact incomplete stream gained DONE`);
            assert.match(result.body, new RegExp(markerText), `${caseName}: partial upstream bytes were lost`);
            const syntheticError = /event:\s*error|"type"\s*:\s*"error"|"type"\s*:\s*"message_stop"/.test(result.body);
            assert.equal(syntheticError, false,
                `${caseName}: exact incomplete stream gained synthetic framing`);
            const callback = callbackCaptures.at(-1);
            assert.ok(callback && callback.forwarded, `${caseName}: callback forward was not captured`);
            const innerResult = await callback.forwarded;
            assert.equal(Boolean(innerResult.aborted || innerResult.error), true,
                `${caseName}: keepalive-to-Bifrost callback ended cleanly: ${JSON.stringify(innerResult)}`);
            assert.match(innerResult.body || '', new RegExp(markerText),
                `${caseName}: keepalive callback lost partial upstream bytes`);
            assert.doesNotMatch(innerResult.body || '',
                /event:\s*error|"type"\s*:\s*"error"|"type"\s*:\s*"message_stop"/,
                `${caseName}: keepalive synthesized error or terminal framing`);
            await sleep(250);
            assert.equal(generations.length, before + 1, `${caseName}: exact incomplete stream replayed a generation`);
            const generation = generations.at(-1);
            if (caseName === 'exact-stall') {
                await Promise.race([
                    generation.closed,
                    sleep(2000).then(() => { throw new Error('exact stall left upstream socket open'); }),
                ]);
                assert.equal(generation.closedBeforeFinish, true, 'exact stall did not destroy upstream');
            }
        };
        await exactIncompleteCase('message-stop-substring', 'partial message_stop text');
        await exactIncompleteCase('exact-stall', 'partial before exact stall');

        const lazyBefore = generations.length;
        const lazyRowsBefore = usageRows().length;
        const lazyResponse = await publicCall({
            model: 'lazy/Vendor/Lazy-Exact[1m]',
            messages: [{ role: 'user', content: 'case:lazy-ensure' }],
            stream: false,
        }, basePublicHeaders);
        assert.equal(lazyResponse.status, 200, lazyResponse.body);
        assert.equal(generations.length, lazyBefore + 1, 'lazy ensure creates one generation');
        assert.equal(lazyEnsureHits, 1, 'lazy provider is ensured exactly once after pre-connect failure');
        assert.equal(generations.at(-1).body.model, 'Vendor/Lazy-Exact[1m]');
        await waitUntil(() => usageRows().length === lazyRowsBefore + 1, 'lazy ensure usage row');
        bridgeMode = 'truncate-nonstream';
        const outerTruncated = await publicCall({
            model: 'agentrouter/outer-truncation',
            messages: [{ role: 'user', content: 'case:text' }],
            stream: false,
        }, basePublicHeaders);
        assert.equal(outerTruncated.status, 503, JSON.stringify(outerTruncated));
        assert.equal(outerTruncated.complete, true, 'outer truncation returns a complete redacted error before public headers');
        assert.deepEqual(JSON.parse(outerTruncated.body), {
            error: { message: 'Upstream request failed.', type: 'api_error', code: 'upstream_unavailable' },
            model: 'agentrouter/outer-truncation',
        });
        assert.equal((await rawRequest(frontdoorPort, { pathname: '/openai/v1/models' })).status, 200,
            'frontdoor remains healthy after outer truncation');

        for (const [mode, expectedStatus, expectedCode] of [
            ['private-error', 503, 'upstream_unavailable'],
            ['success-error', 503, 'upstream_unavailable'],
            ['malformed-error', 503, 'upstream_unavailable'],
            ['array-error', 404, 'model_not_found'],
        ]) {
            bridgeMode = mode;
            const publicModel = `agentrouter/redaction/${mode}`;
            const response = await publicCall({
                model: publicModel,
                messages: [{ role: 'user', content: 'case:text' }],
                stream: false,
            }, basePublicHeaders);
            assert.equal(response.status, expectedStatus, `${mode}: ${response.body}`);
            const projected = JSON.parse(response.body);
            assert.equal(projected.error.code, expectedCode);
            assert.equal(projected.model, publicModel);
            assert.equal(response.body.includes(secret), false, `${mode} leaked private sentinel`);
            assert.equal(response.body.includes(fixtureRoot), false, `${mode} leaked private path`);
        }
        bridgeMode = 'proxy';
        const rejectedTombstoneCallbacks = syntheticBridgeTokens.splice(0);
        for (const token of rejectedTombstoneCallbacks) {
            const callbackBody = JSON.stringify({
                model: 'agentrouter/rejected-delayed-callback',
                max_tokens: 8,
                messages: [{ role: 'user', content: 'case:text' }],
            });
            const rejected = await rawRequest(frontdoorPort, {
                method: 'POST', pathname: '/v1/messages',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(callbackBody),
                    'x-abuse-hub-internal': sidecar.INTERNAL_HOP_MARKER,
                    'x-abuse-hub-request-token': token,
                },
                body: callbackBody,
            });
            assert.equal(rejected.status, 403, rejected.body);
        }

        const statusAfterRedaction = JSON.parse((await rawRequest(frontdoorPort, {
            pathname: '/__frontdoor/api/status',
        })).body);
        assert.equal(statusAfterRedaction.api_gateway_inflight, 0,
            'synthetic redaction tombstones did not clear');
        bridgeMode = 'proxy';

        writeJson(backendsPath, {
            version: 1,
            providers: providerRecords,
            aliases: { ar: 'agentrouter' },
        });
        const liveRegistryDocument = JSON.parse(fs.readFileSync(backendsPath, 'utf8'));
        const beforePreconnectBridgeHits = bridgeHits;
        bridge.closeAllConnections();
        await closeServer(bridge);
        const preconnectFailure = await publicCall({
            model: 'agentrouter/sidecar-preconnect',
            messages: [{ role: 'user', content: 'case:text' }],
            stream: false,
        }, basePublicHeaders);
        assert.equal(preconnectFailure.status, 503, preconnectFailure.body);
        assert.equal(bridgeHits, beforePreconnectBridgeHits,
            'closed bridge unexpectedly accepted sidecar request');
        const preconnectStatus = JSON.parse((await rawRequest(frontdoorPort, {
            pathname: '/__frontdoor/api/status',
        })).body);
        assert.equal(preconnectStatus.api_gateway_inflight, 0,
            'proven sidecar preconnect failure did not remove both nonexistent legs');
        await new Promise((resolve, reject) => {
            bridge.once('error', reject);
            bridge.listen(bridgePort, '127.0.0.1', () => {
                bridge.removeListener('error', reject);
                resolve();
            });
        });
        writeJson(backendsPath, liveRegistryDocument);

        bridgeMode = 'hold-response';
        bridgeHeldTarget = null;
        bridgeHeldResponse = null;
        const beforeMidflight = generations.length;
        const midflight = startRequest({
            body: {
                model: 'agentrouter/sidecar/midflight',
                messages: [{ role: 'user', content: 'case:sidecar-midflight' }],
                stream: false,
            },
        });
        const midflightGeneration = await waitUntil(
            () => generations.length > beforeMidflight && generations.at(-1),
            'sidecar midflight backend arrival',
        );
        await waitUntil(() => bridgeHeldTarget && bridgeHeldResponse,
            'sidecar midflight response hold');
        bridgeHeldResponse.socket.destroy();
        const midflightResult = await midflight.done;
        assert.ok(midflightResult.status === 503 || midflightResult.complete === false,
            JSON.stringify(midflightResult));
        await Promise.race([
            midflightGeneration.closed,
            sleep(2000).then(() => { throw new Error('sidecar midflight backend socket stayed open'); }),
        ]);
        assert.equal(midflightGeneration.closedBeforeFinish, true,
            'sidecar midflight failure did not cancel claimed backend');
        await waitUntil(async () => {
            const status = JSON.parse((await rawRequest(frontdoorPort, {
                pathname: '/__frontdoor/api/status',
            })).body);
            return status.api_gateway_inflight === 0;
        }, 'sidecar midflight registry cleanup', 3000);
        assert.equal(generations.length, beforeMidflight + 1,
            'sidecar midflight failure started a retry or hedge');
        bridgeMode = 'hold-response';
        bridgeHeldTarget = null;
        bridgeHeldResponse = null;
        const beforeBifrostDeath = generations.length;
        const bifrostDeath = startRequest({
            body: {
                model: 'agentrouter/sidecar/bifrost-death',
                messages: [{ role: 'user', content: 'case:bifrost-death' }],
                stream: false,
            },
        });
        const bifrostDeathGeneration = await waitUntil(
            () => generations.length > beforeBifrostDeath && generations.at(-1),
            'Bifrost death backend arrival',
        );
        await waitUntil(() => bridgeHeldTarget && bridgeHeldResponse,
            'Bifrost death bridge hold');
        await terminate(bifrost);
        bifrost = null;
        for (const socket of bridgeSockets) socket.destroy();
        const bifrostDeathResult = await Promise.race([
            bifrostDeath.done,
            sleep(5000).then(() => ({ timeout: true })),
        ]);
        assert.equal(bifrostDeathResult.timeout, undefined,
            'public request stayed open after Bifrost death');
        assert.ok(bifrostDeathResult.status === 503 || bifrostDeathResult.complete === false,
            JSON.stringify(bifrostDeathResult));
        await Promise.race([
            bifrostDeathGeneration.closed,
            sleep(2000).then(() => { throw new Error('Bifrost death backend socket stayed open'); }),
        ]);
        assert.equal(bifrostDeathGeneration.closedBeforeFinish, true,
            'Bifrost death did not cancel claimed backend');
        assert.equal(generations.length, beforeBifrostDeath + 1,
            'Bifrost death started a retry or hedge');
        await waitUntil(async () => {
            const status = JSON.parse((await rawRequest(frontdoorPort, {
                pathname: '/__frontdoor/api/status',
            })).body);
            return status.api_gateway_inflight === 0;
        }, 'Bifrost death registry cleanup', 3000);
        bifrost = spawn(descriptor.executable, descriptor.args, {
            cwd: descriptor.cwd,
            env: childEnv,
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
        });
        children.push(bifrost);
        bifrost.stderr.on('data', chunk => {
            bifrostStderr = (bifrostStderr + chunk.toString('utf8')).slice(-8000);
        });
        await waitUntil(async () => {
            const health = await request(bifrostPort, '/health');
            return health.status === 200;
        }, 'restarted pinned Bifrost after death case', 20000);
        bridgeMode = 'proxy';
        bridgeHeldTarget = null;
        bridgeHeldResponse = null;

        const beforeDisabledBridgeHits = bridgeHits;
        const beforeDisabledGenerations = generations.length;
        const beforeDisabledRows = usageRows().length;
        writeJson(manifestPath, {
            version: 1,
            revision: 2,
            enabled: false,
            models: {},
        });
        const disabled = await publicCall({
            model: 'agentrouter/hidden-disabled',
            messages: [{ role: 'user', content: 'case:text' }],
            stream: false,
        }, basePublicHeaders);
        assert.equal(disabled.status, 503, disabled.body);
        assert.equal(JSON.parse(disabled.body).error.code, 'api_gateway_disabled');
        assert.equal(bridgeHits, beforeDisabledBridgeHits,
            'disabled manifest POST reached sidecar bridge');
        assert.equal(generations.length, beforeDisabledGenerations,
            'disabled manifest POST reached backend');
        assert.equal(usageRows().length, beforeDisabledRows,
            'disabled manifest POST wrote usage');
        const disabledStatus = JSON.parse((await rawRequest(frontdoorPort, {
            pathname: '/__frontdoor/api/status',
        })).body);
        assert.equal(disabledStatus.api_gateway_inflight, 0,
            'disabled manifest POST minted a registry token');
        writeJson(manifestPath, {
            version: 1,
            revision: 3,
            enabled: true,
            models: {},
        });
        const hiddenEnabled = await publicCall({
            model: 'agentrouter/hidden-enabled',
            messages: [{ role: 'user', content: 'case:text' }],
            stream: false,
        }, basePublicHeaders);
        assert.equal(hiddenEnabled.status, 200, hiddenEnabled.body);
        assert.equal(JSON.parse(hiddenEnabled.body).model, 'agentrouter/hidden-enabled');

        const nativeJsonModel = 'agentrouter/Native/Nested/Case[1m]';
        const nativeJsonBody = JSON.stringify({
            model: nativeJsonModel,
            max_tokens: 8,
            messages: [{ role: 'user', content: 'case:text' }],
        });
        const nativeJson = await rawRequest(frontdoorPort, {
            method: 'POST', pathname: '/v1/messages',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(nativeJsonBody),
            },
            body: nativeJsonBody,
        });
        assert.equal(nativeJson.status, 200, nativeJson.body);
        assert.equal(JSON.parse(nativeJson.body).model, nativeJsonModel,
            'direct native JSON restores full canonical provider/model');
        assert.equal(generations.at(-1).body.model, 'Native/Nested/Case[1m]',
            'direct native JSON keeps exact bare backend model');

        const nativeSseModel = 'agentrouter/Native/Sse/Case';
        const nativeSseBody = JSON.stringify({
            model: nativeSseModel,
            max_tokens: 8,
            stream: true,
            messages: [{ role: 'user', content: 'case:stream-text' }],
        });
        const nativeSse = await rawRequest(frontdoorPort, {
            method: 'POST', pathname: '/v1/messages',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(nativeSseBody),
            },
            body: nativeSseBody,
        });
        assert.equal(nativeSse.status, 200, nativeSse.body);
        const nativeStarts = nativeSse.body.split(/\r?\n/)
            .filter(line => line.startsWith('data:') && line.includes('message_start'))
            .map(line => JSON.parse(line.slice(5).trim()));
        assert.equal(nativeStarts.length, 1);
        assert.equal(nativeStarts[0].message.model, nativeSseModel,
            'direct native SSE restores full canonical provider/model');
        assert.equal(generations.at(-1).body.model, 'Native/Sse/Case',
            'direct native SSE keeps exact bare backend model');

        const beforeReplay = generations.length;
        const replay = await forwardCapture(nested.callback);
        assert.equal(replay.status, 403, replay.body);
        assert.match(replay.body, /permission_error/);
        assert.equal(generations.length, beforeReplay, 'one-use token replay reached backend');

        const directToken = crypto.randomBytes(32).toString('base64url');
        const directBody = {
            model: 'abuse-hub/agentrouter/direct-spoof',
            messages: [{ role: 'user', content: 'case:text' }],
        };
        const directPayload = JSON.stringify(directBody);
        const beforeDirect = generations.length;
        const direct = await rawRequest(bifrostPort, {
            method: 'POST', pathname: '/v1/chat/completions',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(directPayload),
                'x-bf-eh-x-abuse-hub-request-token': directToken,
            },
            body: directPayload,
        });
        assert.ok(direct.status >= 400, direct.body);
        assert.equal(generations.length, beforeDirect, 'direct Bifrost marker override reached backend');
        const directCallbackBody = JSON.stringify({
            model: 'agentrouter/direct-spoof', max_tokens: 8,
            messages: [{ role: 'user', content: 'case:text' }],
        });
        const directCallback = await rawRequest(frontdoorPort, {
            method: 'POST', pathname: '/v1/messages',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(directCallbackBody),
                'x-abuse-hub-internal': sidecar.INTERNAL_HOP_MARKER,
            },
            body: directCallbackBody,
        });
        assert.equal(directCallback.status, 403);
        assert.equal(generations.length, beforeDirect);

        const beforeAcceptedReset = generations.length;
        const acceptedReset = await publicCall({
            model: 'agentrouter/no-retry/accepted-reset',
            messages: [{ role: 'user', content: 'case:accepted-reset' }],
            stream: false,
        }, basePublicHeaders);
        assert.equal(acceptedReset.complete && acceptedReset.status >= 200 && acceptedReset.status < 300,
            false, JSON.stringify(acceptedReset));
        await sleep(250);
        assert.equal(generations.length, beforeAcceptedReset + 1,
            'accepted-body socket reset started a second paid generation');

        const beforeFallback = generations.length;
        const fallback = await publicCall({
            model: 'agentrouter/no-fallback',
            messages: [{ role: 'user', content: 'case:fallback' }], stream: false,
        }, basePublicHeaders);
        assert.equal(fallback.status, 503, fallback.body);
        assert.equal(fallback.body.includes(secret), false);
        assert.deepEqual(JSON.parse(fallback.body), {
            error: { message: 'Upstream request failed.', type: 'api_error', code: 'upstream_unavailable' },
            model: 'agentrouter/no-fallback',
        });
        await sleep(250);
        assert.equal(generations.length, beforeFallback + 1, 'fallback or retry started another generation');
        assert.equal(generations.at(-1).body.model, 'no-fallback');
        assert.notEqual(generations.at(-1).body.model, 'hostile-substitute-model');

        const beforeUnknown = generations.length;
        const unknown = await publicCall({
            model: 'unknown/nope', messages: [{ role: 'user', content: 'case:text' }],
        }, basePublicHeaders);
        assert.equal(unknown.status, 404);
        assert.equal(generations.length, beforeUnknown);

        gateMode = 'hold';
        const heldBefore = heldCallbacks.length;
        const outerFirst = startRequest({
            body: {
                model: 'agentrouter/cancel/outer-first',
                messages: [{ role: 'user', content: 'case:text' }], stream: false,
            },
        });
        const held = await waitUntil(() => heldCallbacks.length > heldBefore && heldCallbacks.at(-1), 'held callback');
        const beforeOuterFirst = generations.length;
        outerFirst.client.destroy(new Error('fixture outer-first cancel'));
        await outerFirst.done;
        await sleep(50);
        const rejectedHeld = await held.release();
        assert.equal(rejectedHeld.status, 403, rejectedHeld.body);
        await sleep(100);
        assert.equal(generations.length, beforeOuterFirst, 'outer-first cancellation resurrected backend work');
        gateMode = 'normal';

        const cancelClaimed = async (caseName, stream) => {
            const before = generations.length;
            let clientHandle;
            clientHandle = startRequest({
                body: {
                    model: `agentrouter/cancel/${caseName}`,
                    messages: [{ role: 'user', content: `case:${caseName}` }], stream,
                },
            });
            const entry = await waitUntil(() => generations.length > before && generations.at(-1), `${caseName} backend arrival`);
            const cancelledAt = Date.now();
            clientHandle.client.destroy(new Error(`fixture ${caseName} cancel`));
            await clientHandle.done;
            await Promise.race([
                entry.closed,
                sleep(2000).then(() => { throw new Error(`${caseName} backend socket stayed open`); }),
            ]);
            assert.equal(entry.closedBeforeFinish, true, `${caseName} backend completed instead of cancellation`);
            assert.ok(entry.closedAt - cancelledAt < 2000, `${caseName} backend cancellation exceeded 2 seconds`);
            await sleep(100);
            assert.equal(generations.length, before + 1, `${caseName} started a retry or hedge`);
        };
        await cancelClaimed('delay-unary', false);
        await cancelClaimed('delay-stream', true);

        for (let index = 0; index < 6; index += 1) {
            if (index % 2 === 0) {
                gateMode = 'hold';
                const heldCount = heldCallbacks.length;
                const before = generations.length;
                const race = startRequest({
                    body: {
                        model: `agentrouter/cancel/race-${index}`,
                        messages: [{ role: 'user', content: 'case:text' }], stream: false,
                    },
                });
                const raceHeld = await waitUntil(() => heldCallbacks.length > heldCount && heldCallbacks.at(-1), `outer-first race ${index}`);
                race.client.destroy(new Error('fixture race cancel'));
                await race.done;
                const result = await raceHeld.release();
                assert.equal(result.status, 403);
                assert.equal(generations.length, before);
                gateMode = 'normal';
            } else {
                await cancelClaimed('race-claimed', false);
            }
        }

        for (const [caseName, stream] of [
            ['truncated-partial', true],
            ['truncated-zero', true],
            ['truncated-json', false],
        ]) {
            const before = generations.length;
            const truncated = await publicCall({
                model: `agentrouter/truncation/${caseName}`,
                messages: [{ role: 'user', content: `case:${caseName}` }], stream,
            }, basePublicHeaders);
            assert.equal(truncated.body.includes('data: [DONE]'), false, `${caseName} synthesized DONE`);
            assert.equal(truncated.body.includes(secret), false, `${caseName} leaked private detail`);
            const explicitError = String(truncated.headers['content-type'] || '').includes('event-stream')
                && openAiObjects(truncated.body).some(object => object.error);
            assert.equal(
                truncated.complete && truncated.status >= 200 && truncated.status < 300 && !explicitError,
                false,
                `${caseName} ended as a clean success: ${JSON.stringify(truncated)}`,
            );
            await sleep(150);
            assert.equal(generations.length, before + 1, `${caseName} replayed a possibly billable generation`);
        }

        bridgeMode = 'proxy';
        gateMode = 'close-after-arrival';
        const beforeCallbackClose = generations.length;
        const beforeCallbackCloseRows = usageRows().length;
        const callbackCloseRequest = startRequest({
            body: {
                model: 'agentrouter/callback/close',
                messages: [{ role: 'user', content: 'case:callback-close' }],
                stream: false,
            },
        });
        const callbackCloseGeneration = await waitUntil(
            () => generations.length > beforeCallbackClose && generations.at(-1),
            'callback-close backend arrival',
        );
        const callbackClosePublic = await Promise.race([
            callbackCloseRequest.done,
            sleep(5000).then(() => ({ timeout: true })),
        ]);
        assert.equal(callbackClosePublic.timeout, undefined,
            'public request stayed open after callback response close');
        await Promise.race([
            callbackCloseGeneration.closed,
            sleep(2000).then(() => { throw new Error('premature callback response close left backend alive'); }),
        ]);
        assert.equal(callbackCloseGeneration.closedBeforeFinish, true,
            'premature callback response close did not cancel backend');
        assert.equal(generations.length, beforeCallbackClose + 1,
            'premature callback response close started a retry or hedge');
        assert.ok(usageRows().length <= beforeCallbackCloseRows + 1,
            'premature callback response close duplicated usage');
        await waitUntil(async () => {
            const callbackCloseStatus = JSON.parse((await rawRequest(frontdoorPort, {
                pathname: '/__frontdoor/api/status',
            })).body);
            return callbackCloseStatus.api_gateway_inflight === 0;
        }, 'callback-close registry cleanup', 3000);
        gateMode = 'normal';
        bridgeMode = 'proxy';
        bridgeEarlyCase = '';

        bridgeMode = 'early-success-after-claim';
        bridgeEarlyCase = 'drain-paid';
        const beforeDrainPaid = generations.length;
        const beforeDrainPaidRows = usageRows().length;
        const drainPaidRequest = startRequest({
            body: {
                model: 'agentrouter/drain/paid',
                messages: [{ role: 'user', content: 'case:drain-paid' }],
                stream: false,
            },
        });
        const drainPaidGeneration = await waitUntil(
            () => generations.length > beforeDrainPaid && generations.at(-1),
            'drain-paid backend arrival',
        );
        const drainPaidPublic = await drainPaidRequest.done;
        assert.equal(drainPaidPublic.status, 200, JSON.stringify(drainPaidPublic));
        const preDrainStatus = JSON.parse((await rawRequest(frontdoorPort, {
            pathname: '/__frontdoor/api/status',
        })).body);
        assert.equal(preDrainStatus.api_gateway_inflight, 1,
            'drain-paid claimed work not registered');
        const drainResponse = await rawRequest(frontdoorPort, {
            method: 'POST', pathname: '/__drain', body: '',
            headers: { 'content-length': '0' },
        });
        assert.equal(drainResponse.status, 200, drainResponse.body);
        assert.equal(JSON.parse(drainResponse.body).inflight, 1,
            'drain response did not count claimed paid work');
        await sleep(500);
        assert.equal(frontdoor.exitCode, null,
            'frontdoor exited while claimed paid work remained alive');
        drainPaidGeneration.release();
        await Promise.race([
            drainPaidGeneration.closed,
            sleep(2000).then(() => { throw new Error('drain-paid backend did not finish after release'); }),
        ]);
        await waitUntil(() => usageRows().length === beforeDrainPaidRows + 1,
            'drain-paid usage row', 3000);
        assert.equal(generations.length, beforeDrainPaid + 1,
            'drain-paid started more than one generation');
        assert.equal(usageRows().length, beforeDrainPaidRows + 1,
            'drain-paid wrote more than one usage row');
        await waitUntil(() => frontdoor.exitCode !== null || frontdoor.signalCode !== null,
            'frontdoor exit after drain-paid completion', 5000);
        bridgeMode = 'proxy';
        bridgeEarlyCase = '';

        assert.ok(catalogHits >= 1, 'hostile replacement catalog was not armed');
        assert.equal(sidecar.verifyFile(expected.executable, expected.artifact.sha256).ok, true,
            'pinned Bifrost changed during isolated acceptance');
        process.stdout.write('check-bifrost-stack --phase3-isolated: PASS\n');
    } finally {
        gateMode = 'normal';
        for (const held of heldCallbacks) {
            if (held.release) {
                try { await held.release(); } catch { /* fixture teardown */ }
                held.release = null;
            }
        }
        for (const timer of delayedTimers) clearTimeout(timer);
        for (const child of children.reverse()) await terminate(child);
        for (const server of servers.reverse()) await closeServer(server);
        fs.rmSync(TMP, { recursive: true, force: true });
    }
}

if (PHASE3_ISOLATED) {
    runPhase3Isolated().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
} else {
    after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('tracked lock pins the exact repo, version, URLs, filenames, and five checksums', () => {
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    assert.equal(lock.repo, EXPECTED.repo);
    assert.equal(lock.version, EXPECTED.version);
    assert.equal(lock.defaultHost, EXPECTED.defaultHost);
    assert.equal(lock.defaultPort, EXPECTED.defaultPort);
    assert.deepEqual(Object.keys(lock.artifacts).sort(), Object.keys(EXPECTED.artifacts).sort());
    for (const [key, expected] of Object.entries(EXPECTED.artifacts)) {
        const artifact = lock.artifacts[key];
        assert.equal(artifact.sha256, expected.sha256, key);
        assert.equal(artifact.filename, expected.filename, key);
        assert.equal(
            artifact.url,
            `https://downloads.getmaxim.ai/bifrost/v2.5.0/${expected.os}/${expected.arch}/${expected.filename}`,
            key,
        );
        assert.equal(/latest/i.test(artifact.url), false, key);
    }
    assert.equal(Object.hasOwn(lock, 'selfUpdate'), false);
});

test('tracked template is file-only, keyless, Anthropic based, retry-free, and operation-restricted', () => {
    const template = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    assert.equal(template.source_of_truth, 'config.json');
    assert.equal(template.disable_onboarding, true);
    assert.equal(template.client.enable_logging, false);
    assert.equal(template.client.disable_content_logging, true);
    assert.equal(template.client.enforce_auth_on_inference, false);
    assert.deepEqual(template.client.allowed_origins, ['http://127.0.0.1:20100']);
    assert.equal(Object.hasOwn(template.client, 'required_headers'), false);
    assert.equal(template.client.disable_db_pings_in_health, true);
    assert.deepEqual(template.config_store, { enabled: false });
    assert.deepEqual(template.logs_store, { enabled: false });
    assert.deepEqual(Object.keys(template.providers), ['abuse-hub']);
    const provider = template.providers['abuse-hub'];
    assert.deepEqual(provider.keys, []);
    assert.equal(provider.network_config.base_url, 'http://127.0.0.1:20100');
    assert.equal(provider.network_config.max_retries, 0);
    const sidecar = loadSidecar();
    assert.equal(provider.network_config.extra_headers['x-abuse-hub-internal'], sidecar.INTERNAL_HOP_MARKER);
    assert.equal(Object.hasOwn(provider, 'fallbacks'), false);
    assert.equal(provider.custom_provider_config.base_provider_type, 'anthropic');
    assert.equal(provider.custom_provider_config.is_key_less, true);
    assert.deepEqual(provider.custom_provider_config.allowed_requests, {
        chat_completion: true,
        chat_completion_stream: true,
    });
    assert.deepEqual(template.framework, {
        pricing: {
            pricing_url: 'bifrost-pricing.json',
            model_parameters_url: 'bifrost-model-parameters.json',
            pricing_sync_interval: 86400,
            mcp_library_sync_interval: 0,
            live_models_sync_interval: 0,
        },
    });
    assert.equal(hashBytes(fs.readFileSync(PRICING_PATH)), '9269f021b3e0240ba6252d6f6b81fe167dcd1724bd84c74310a5389ce392845c');
    assert.equal(hashBytes(fs.readFileSync(MODEL_PARAMETERS_PATH)), 'eb0279f8848f3f6690d10dff1165fe8c2b22818cb93319f76a3341d17a911dac');
});

test('Apache-2.0 notice names the pinned upstream and does not claim the binary is tracked', () => {
    const notice = fs.readFileSync(NOTICE_PATH, 'utf8');
    assert.match(notice, /maximhq\/bifrost/i);
    assert.match(notice, /Apache License, Version 2\.0/i);
    assert.match(notice, /v2\.5\.0/);
    assert.match(notice, /not tracked|not committed/i);
});

test('Apache-2.0 notice links the actual pinned transports tag license', () => {
    const notice = fs.readFileSync(NOTICE_PATH, 'utf8');
    assert.match(notice, /github\.com\/maximhq\/bifrost\/blob\/transports\/v2\.5\.0\/LICENSE/);
});

test('platform selection returns exact records and rejects every unsupported pair', () => {
    const sidecar = loadSidecar();
    const lock = sidecar.readLock(LOCK_PATH);
    for (const key of Object.keys(EXPECTED.artifacts)) {
        const [platform, arch] = key.split('-');
        const picked = sidecar.selectArtifact(lock, platform, arch);
        assert.equal(picked.sha256, EXPECTED.artifacts[key].sha256);
        assert.equal(picked.filename, EXPECTED.artifacts[key].filename);
    }
    assert.throws(() => sidecar.selectArtifact(lock, 'win32', 'arm64'), /unsupported/i);
    assert.throws(() => sidecar.selectArtifact(lock, 'freebsd', 'x64'), /unsupported/i);
});

test('install downloads beside cache, refuses mismatch, and removes the temporary artifact', async () => {
    const sidecar = loadSidecar();
    const cacheRoot = fresh('mismatch-cache');
    let tempSeen = '';
    await assert.rejects(
        sidecar.ensureInstalled({
            lockPath: LOCK_PATH,
            cacheRoot,
            platform: 'win32',
            arch: 'x64',
            download: async (_url, temp) => {
                tempSeen = temp;
                fs.writeFileSync(temp, 'wrong artifact');
            },
        }),
        /checksum/i,
    );
    assert.ok(tempSeen.startsWith(cacheRoot + path.sep));
    assert.equal(fs.existsSync(tempSeen), false);
    assert.deepEqual(fs.readdirSync(cacheRoot, { recursive: true }).filter(name => /bifrost-http\.exe$/i.test(name)), []);
});

test('install replaces an existing corrupt cache only after the temporary artifact verifies', async () => {
    const sidecar = loadSidecar();
    const cacheRoot = fresh('replace-cache');
    const payload = Buffer.from('replacement fixture executable');
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    lock.artifacts['win32-x64'].sha256 = hashBytes(payload);
    const fixtureLock = path.join(cacheRoot, 'lock.json');
    fs.writeFileSync(fixtureLock, JSON.stringify(lock));
    const artifact = sidecar.selectArtifact(lock, 'win32', 'x64');
    const executable = path.join(cacheRoot, lock.version, artifact.cacheDir, artifact.filename);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'corrupt existing cache');
    const unlinks = [];
    const result = await sidecar.ensureInstalled({
        lockPath: fixtureLock,
        cacheRoot,
        platform: 'win32',
        arch: 'x64',
        download: async (_url, temp) => fs.writeFileSync(temp, payload),
        unlink: file => { unlinks.push(file); fs.unlinkSync(file); },
    });
    assert.equal(result.installed, true);
    assert.equal(fs.readFileSync(executable).equals(payload), true);
    assert.deepEqual(unlinks, [], 'verified replacement must use atomic rename, not pre-delete the live cache');
});

test('install atomically promotes verified bytes into a versioned cache', async () => {
    const sidecar = loadSidecar();
    const cacheRoot = fresh('atomic-cache');
    const payload = Buffer.from('fixture bifrost executable');
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    lock.artifacts['win32-x64'].sha256 = hashBytes(payload);
    const fixtureLock = path.join(cacheRoot, 'lock.json');
    fs.writeFileSync(fixtureLock, JSON.stringify(lock));
    const renames = [];
    const result = await sidecar.ensureInstalled({
        lockPath: fixtureLock,
        cacheRoot,
        platform: 'win32',
        arch: 'x64',
        download: async (_url, temp) => fs.writeFileSync(temp, payload),
        rename: (from, to) => { renames.push([from, to]); fs.renameSync(from, to); },
    });
    assert.equal(result.installed, true);
    assert.match(result.executable, /v2\.5\.0[\\/]windows-amd64[\\/]bifrost-http\.exe$/);
    assert.equal(fs.readFileSync(result.executable).equals(payload), true);
    assert.equal(renames.length, 1);
    assert.equal(path.dirname(renames[0][0]), path.dirname(renames[0][1]));
    assert.equal(sidecar.verifyFile(result.executable, hashBytes(payload)).ok, true);
});

test('every cache hit is reverified and corrupt cache is never launchable', async () => {
    const sidecar = loadSidecar();
    const cacheRoot = fresh('cache-reverify');
    const payload = Buffer.from('verified fixture executable');
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    lock.artifacts['win32-x64'].sha256 = hashBytes(payload);
    const fixtureLock = path.join(cacheRoot, 'lock.json');
    fs.writeFileSync(fixtureLock, JSON.stringify(lock));
    let downloads = 0;
    const first = await sidecar.ensureInstalled({
        lockPath: fixtureLock,
        cacheRoot,
        platform: 'win32', arch: 'x64',
        download: async (_url, temp) => { downloads += 1; fs.writeFileSync(temp, payload); },
    });
    const second = await sidecar.ensureInstalled({
        lockPath: fixtureLock,
        cacheRoot,
        platform: 'win32', arch: 'x64',
        download: async () => { throw new Error('cache hit must not download'); },
    });
    assert.equal(second.cached, true);
    assert.equal(downloads, 1);
    fs.writeFileSync(first.executable, 'corrupt');
    await assert.rejects(
        sidecar.prepareLaunch({
            lockPath: fixtureLock,
            configTemplatePath: CONFIG_PATH,
            cacheRoot,
            runtimeRoot: fresh('corrupt-runtime'),
            platform: 'win32', arch: 'x64',
            install: false,
        }),
        /checksum|corrupt/i,
    );
});

test('prepareLaunch refuses a cache swap between verification and descriptor creation', async () => {
    const sidecar = loadSidecar();
    const cacheRoot = fresh('prepare-swap-cache');
    const runtimeRoot = fresh('prepare-swap-runtime');
    const payload = Buffer.from('prepare launch fixture');
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    lock.artifacts['win32-x64'].sha256 = hashBytes(payload);
    const fixtureLock = path.join(cacheRoot, 'lock.json');
    fs.writeFileSync(fixtureLock, JSON.stringify(lock));
    let swaps = 0;
    await assert.rejects(
        sidecar.prepareLaunch({
            lockPath: fixtureLock,
            configTemplatePath: CONFIG_PATH,
            cacheRoot,
            runtimeRoot,
            platform: 'win32', arch: 'x64',
            download: async (_url, temp) => fs.writeFileSync(temp, payload),
            afterVerify: executable => {
                swaps += 1;
                fs.writeFileSync(executable, 'swapped after verification');
            },
        }),
        /checksum|changed|corrupt/i,
    );
    assert.equal(swaps, 1);
});

test('runtime config contains only safe fixed structure plus base URL and marker overrides', () => {
    const sidecar = loadSidecar();
    const appDir = fresh('runtime-config');
    const configPath = sidecar.writeRuntimeConfig({
        templatePath: CONFIG_PATH,
        appDir,
        baseUrl: 'http://127.0.0.1:45678',
        internalMarker: 'runtime-secret-marker',
    });
    assert.equal(path.basename(configPath), 'config.json');
    assert.deepEqual(fs.readdirSync(appDir), [
        'bifrost-model-parameters.json',
        'bifrost-pricing.json',
        'config.json',
    ]);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const network = config.providers['abuse-hub'].network_config;
    const pricing = config.framework.pricing;
    assert.equal(pricing.pricing_url, `file:${path.join(appDir, 'bifrost-pricing.json').split(path.sep).join('/')}`);
    assert.equal(pricing.model_parameters_url, `file:${path.join(appDir, 'bifrost-model-parameters.json').split(path.sep).join('/')}`);
    assert.equal(pricing.mcp_library_sync_interval, 0);
    assert.equal(pricing.live_models_sync_interval, 0);
    assert.equal(network.base_url, 'http://127.0.0.1:45678');
    assert.equal(network.max_retries, 0);
    assert.equal(network.extra_headers['x-abuse-hub-internal'], 'runtime-secret-marker');
    assert.deepEqual(config.config_store, { enabled: false });
    assert.deepEqual(config.logs_store, { enabled: false });

    const status = sidecar.redactedStatus({
        lockPath: LOCK_PATH,
        configPath,
        executable: 'C:\\private\\bifrost-http.exe',
        appDir: 'C:\\private\\runtime',
        installed: true,
        verified: true,
    });
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes('runtime-secret-marker'), false);
    assert.equal(serialized.includes('45678'), false);
    assert.equal(serialized.includes('C:\\private'), false);
    assert.deepEqual(status, {
        repo: EXPECTED.repo,
        version: EXPECTED.version,
        installed: true,
        verified: true,
        provider: 'abuse-hub',
    });
});

test('runtime config recovers only exact stale atomic stages and rejects unrelated entries', () => {
    const sidecar = loadSidecar();
    const appDir = fresh('runtime-stage-recovery');
    fs.writeFileSync(path.join(appDir, 'config.json.tmp-4242-1'), 'stale');
    fs.writeFileSync(path.join(appDir, 'config.json.stage-deadbeef'), 'stale');
    sidecar.writeRuntimeConfig({ templatePath: CONFIG_PATH, appDir });
    assert.deepEqual(fs.readdirSync(appDir), [
        'bifrost-model-parameters.json',
        'bifrost-pricing.json',
        'config.json',
    ]);

    for (const name of ['config.json.tmp-', 'config.json.tmp-42', 'config.json.tmp-42-x', 'config.json.stage-', 'other.json', 'nested']) {
        const rejectDir = fresh(`reject-${name.replace(/[^a-z0-9]/gi, '_')}`);
        const target = path.join(rejectDir, name);
        if (name === 'nested') fs.mkdirSync(target); else fs.writeFileSync(target, 'unrelated');
        assert.throws(
            () => sidecar.writeRuntimeConfig({ templatePath: CONFIG_PATH, appDir: rejectDir }),
            /file-only|unexpected/i,
            name,
        );
    }
});

test('Bifrost descriptor uses a strict environment allowlist and fixed identity policy', () => {
    const sidecar = loadSidecar();
    const descriptor = sidecar.createServiceDescriptor({
        executable: 'C:\\cache\\bifrost-http.exe',
        appDir: 'C:\\runtime\\bifrost',
        port: 45679,
        env: { SAFE_FIXTURE: 'present' },
    });
    assert.equal(descriptor.envPolicy, 'allowlist');
    assert.deepEqual(descriptor.env, {
        BIFROST_BASE_PATH: '/',
        BIFROST_NO_UPDATE_CHECK: '1',
        SAFE_FIXTURE: 'present',
    });
    assert.equal(descriptor.identity.path, path.resolve('C:\\cache\\bifrost-http.exe'));
    assert.equal(descriptor.identity.healthPath, '/health');
    assert.equal(descriptor.identity.marker, 'abuse-hub-bifrost-v1');
});

test('lifecycle allowlisted environment excludes secrets, proxy credentials, and every inherited BIFROST control', () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const parent = {
        ...process.env,
        OPENAI_API_KEY: 'openai-secret',
        ANTHROPIC_API_KEY: 'anthropic-secret',
        HTTPS_PROXY: 'http://user:pass@proxy.invalid',
        BIFROST_PPROF_PORT: '45678',
        BIFROST_PPROF_HOST: '0.0.0.0',
        BIFROST_BASE_PATH: '/unsafe',
    };
    const env = lifecycle.serviceEnv({
        executable: process.execPath,
        envPolicy: 'allowlist',
        env: { BIFROST_BASE_PATH: '/', BIFROST_NO_UPDATE_CHECK: '1' },
    }, parent);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.BIFROST_PPROF_PORT, undefined);
    assert.equal(env.BIFROST_PPROF_HOST, undefined);
    assert.equal(env.BIFROST_BASE_PATH, '/');
    assert.equal(env.BIFROST_NO_UPDATE_CHECK, '1');
    assert.ok(env.SystemRoot || env.SYSTEMROOT, 'Windows execution environment is retained');
});

test('optional lifecycle failures expose only the public redacted schema', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const events = [];
    const sentinel = 'top-secret-descriptor-value';
    const privatePath = 'C:\\private\\runtime';
    const result = await lifecycle.startServices([{
        port: 45101,
        name: 'private optional',
        executable: 'C:\\private\\bifrost-http.exe',
        args: ['-app-dir', privatePath, sentinel],
        env: { API_TOKEN: sentinel },
        cwd: privatePath,
        optional: true,
        logName: 'bifrost',
        prepare: () => {},
    }], {
        on: event => events.push(event),
        listeners: () => new Map(),
        activeUpstreamPort: () => 0,
        startService: () => { throw new Error(`launch failed at ${privatePath} with ${sentinel}`); },
        logTail: () => sentinel,
        serviceLog: () => privatePath,
    });
    assert.deepEqual(Object.keys(result.optionalFailures[0]).sort(), ['code', 'name', 'optional', 'port', 'text']);
    const serialized = JSON.stringify({ result, events });
    for (const forbidden of [sentinel, privatePath, 'API_TOKEN', 'executable', 'args', 'cwd', 'prepare', 'tail', 'log']) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
});

test('optional no-bind subprocess is terminated by exact launch PID before continuation', { timeout: 20000 }, async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const dir = fresh('no-bind-subprocess');
    const fixture = path.join(dir, 'no-bind.js');
    const pidFile = path.join(dir, 'pid.txt');
    fs.writeFileSync(fixture, `require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`);
    const port = await freePort();
    const launched = [];
    const result = await lifecycle.startServices([{
        port, name: 'no bind optional', executable: process.execPath,
        args: [fixture, pidFile], cwd: dir, optional: true, logName: 'no-bind', imageName: path.basename(process.execPath),
    }], {
        listeners: () => new Map(),
        activeUpstreamPort: () => 0,
        startService: svc => {
            const child = spawn(svc.executable, svc.args, { cwd: svc.cwd, stdio: 'ignore', windowsHide: true });
            launched.push(child);
            return child.pid;
        },
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        stopLaunched: lifecycle.stopLaunched,
        maxPortPolls: 2,
    });
    assert.equal(result.optionalFailures.length, 1);
    await waitFor(() => {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        assert.throws(() => process.kill(pid, 0));
        return true;
    }, 10000);
    for (const child of launched) await terminate(child);
});

test('Windows production launcher cleanup terminates the exact launched process tree', { timeout: 20000 }, async t => {
    if (process.platform !== 'win32') return t.skip('Windows launcher only');
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const dir = fresh('windows-launch-tree');
    const fixture = path.join(dir, 'child.js');
    const pidFile = path.join(dir, 'child.pid');
    const logName = `bifrost-tree-${process.pid}-${Date.now()}`;
    fs.writeFileSync(fixture, `require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`);
    const svc = {
        port: await freePort(),
        name: 'Windows tree fixture',
        executable: process.execPath,
        args: [fixture, pidFile],
        cwd: dir,
        optional: true,
        logName,
        imageName: path.basename(process.execPath),
    };
    let launchPid = 0;
    let childPid = 0;
    try {
        launchPid = await lifecycle.startService(svc);
        await waitFor(() => {
            childPid = Number(fs.readFileSync(pidFile, 'utf8'));
            assert.ok(childPid > 0);
            return true;
        });
        const stopped = await lifecycle.stopLaunched(launchPid);
        assert.equal(stopped.freed, true);
        await waitFor(() => {
            assert.throws(() => process.kill(childPid, 0));
            return true;
        });
    } finally {
        for (const pid of [launchPid, childPid]) {
            if (pid > 0) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
        }
        try { fs.unlinkSync(lifecycle.serviceLog(svc)); } catch { /* absent */ }
    }
});

test('stop plan carries descriptors and refuses a foreign holder instead of killing by port', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const svc = {
        port: 45102, name: 'Bifrost fixture', executable: 'C:\\expected\\bifrost-http.exe',
        args: [], optional: true, imageName: 'bifrost-http.exe', identity: { path: 'C:\\expected\\bifrost-http.exe' },
    };
    const plan = lifecycle.killPlan('stop', [svc]);
    assert.equal(plan[0].service, svc);
    let killed = false;
    assert.equal(typeof lifecycle.stopServices, 'function', 'fixture-only stop core must exist before this test can run');
    const result = await lifecycle.stopServices([svc], {
        phase: 'stop', children: [],
        listeners: () => new Map([[svc.port, new Set([91002])]]),
        pidImage: () => 'bifrost-http.exe',
        pidExecutable: () => 'C:\\foreign\\bifrost-http.exe',
        killPort: async () => { killed = true; return { freed: true }; },
        drainAll: async () => ({ asked: 0, inflight: 0, freed: 0 }),
    });
    assert.equal(killed, false);
    assert.equal(result.stuck.length, 1);
    assert.equal(result.stuck[0].foreign, true);
});

test('stop core rechecks external ownership after drain before exact termination', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const svc = {
        port: 45111,
        name: 'Ownership race fixture',
        executable: 'C:\\expected\\bifrost-http.exe',
        optional: true,
        imageName: 'bifrost-http.exe',
        identity: { path: 'C:\\expected\\bifrost-http.exe' },
    };
    let checks = 0;
    let killed = false;
    const result = await lifecycle.stopServices([svc], {
        phase: 'stop',
        children: [],
        listeners: () => new Map([[svc.port, new Set([91011])]]),
        verifyProcessOwnership: async () => ++checks === 1,
        stopLaunched: async () => { killed = true; return { freed: true }; },
        drainAll: async () => ({ asked: 0, inflight: 0, freed: 0 }),
    });
    assert.equal(killed, false);
    assert.equal(checks, 2);
    assert.equal(result.stuck[0].foreign, true);
});

test('stop core terminates an owned external holder by exact PID and production stop delegates to the core', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const svc = {
        port: 45107, name: 'Owned Bifrost fixture', executable: 'C:\\expected\\bifrost-http.exe',
        args: [], optional: true, imageName: 'bifrost-http.exe', identity: { path: 'C:\\expected\\bifrost-http.exe' },
    };
    const live = new Map([[svc.port, new Set([91007])]]);
    const exact = [];
    let portKilled = false;
    const result = await lifecycle.stopServices([svc], {
        phase: 'stop', children: [],
        listeners: () => live,
        pidImage: () => 'bifrost-http.exe',
        pidExecutable: () => 'C:\\expected\\bifrost-http.exe',
        stopLaunched: async pid => {
            exact.push(pid);
            live.delete(svc.port);
            return { pid, freed: true, denied: false };
        },
        killPort: async () => { portKilled = true; return { freed: true }; },
        drainAll: async () => ({ asked: 0, inflight: 0, freed: 0 }),
    });
    assert.deepEqual(exact, [91007]);
    assert.equal(portKilled, false);
    assert.equal(result.stuck.length, 0);
    assert.match(lifecycle.stop.toString(), /stopServices\(/, 'production wrapper must delegate to the descriptor-aware core');
});

test('sidecar ownership requires the exact executable path, pinned hash, health, and marker identity', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const dir = fresh('identity');
    const expected = path.join(dir, 'bifrost-http.exe');
    fs.writeFileSync(expected, 'expected-binary');
    const svc = {
        port: 45103, name: 'Bifrost identity', executable: expected, imageName: 'bifrost-http.exe', optional: true,
        identity: { path: expected, sha256: hashBytes(Buffer.from('expected-binary')), healthPath: '/health', marker: 'identity-marker' },
    };
    assert.equal(await lifecycle.verifyServiceIdentity(svc, 123, {
        pidImage: () => 'bifrost-http.exe',
        pidExecutable: () => path.join(dir, 'foreign', 'bifrost-http.exe'),
        healthIdentity: async () => ({ ok: true, marker: 'identity-marker' }),
    }), false);
    fs.writeFileSync(expected, 'tampered-binary');
    assert.equal(await lifecycle.verifyServiceIdentity(svc, 123, {
        pidImage: () => 'bifrost-http.exe', pidExecutable: () => expected,
        healthIdentity: async () => ({ ok: true, marker: 'identity-marker' }),
    }), false);
    fs.writeFileSync(expected, 'expected-binary');
    assert.equal(await lifecycle.verifyServiceIdentity(svc, 123, {
        pidImage: () => 'bifrost-http.exe', pidExecutable: () => expected,
        healthIdentity: async () => ({ ok: true, marker: 'wrong-marker' }),
    }), false);
    assert.equal(await lifecycle.verifyServiceIdentity(svc, 123, {
        pidImage: () => 'bifrost-http.exe', pidExecutable: () => expected,
        healthIdentity: async () => ({ ok: true, marker: 'identity-marker' }),
    }), true);
});


test('health identity accepts the exact pinned release version with its v prefix', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const port = await freePort();
    const server = http.createServer((req, res) => {
        const body = req.url === '/health'
            ? JSON.stringify({ status: 'ok' })
            : JSON.stringify('v2.5.0');
        res.writeHead(req.url === '/health' || req.url === '/api/version' ? 200 : 404, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
        });
        res.end(body);
    });
    await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', error => error ? reject(error) : resolve()));
    try {
        const identity = await lifecycle.healthIdentity({
            port,
            ready: '/health',
            identity: { healthPath: '/health', marker: 'identity-marker', version: 'v2.5.0' },
        });
        assert.deepEqual(identity, { ok: true, marker: 'identity-marker', version: 'v2.5.0' });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('sidecar identity binds the running command line and exact config marker to the pinned process', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const dir = fresh('runtime-identity');
    const executable = path.join(dir, 'bifrost-http.exe');
    const appDir = path.join(dir, 'app');
    const configPath = path.join(appDir, 'config.json');
    fs.mkdirSync(appDir);
    fs.writeFileSync(executable, 'expected-binary');
    const config = {
        providers: {
            'abuse-hub': {
                network_config: {
                    extra_headers: { 'x-abuse-hub-internal': 'identity-marker' },
                },
            },
        },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const svc = {
        port: 45110,
        name: 'Bifrost runtime identity',
        executable,
        imageName: 'bifrost-http.exe',
        identity: {
            path: executable,
            sha256: hashBytes(Buffer.from('expected-binary')),
            appDir,
            configPath,
            configSha256: hashBytes(fs.readFileSync(configPath)),
            healthPath: '/health',
            marker: 'identity-marker',
            version: 'v2.5.0',
        },
    };
    const base = {
        pidImage: () => 'bifrost-http.exe',
        pidExecutable: () => executable,
        healthIdentity: async () => ({ ok: true, marker: 'identity-marker', version: '2.5.0' }),
    };
    assert.equal(await lifecycle.verifyServiceIdentity(svc, 123, {
        ...base,
        pidArguments: () => [executable, '-app-dir', path.join(dir, 'foreign'), '-host', '127.0.0.1', '-port', String(svc.port)],
    }), false, 'wrong app dir');
    fs.writeFileSync(configPath, JSON.stringify({ ...config, providers: { 'abuse-hub': { network_config: { extra_headers: { 'x-abuse-hub-internal': 'wrong' } } } } }));
    assert.equal(await lifecycle.verifyServiceIdentity(svc, 123, {
        ...base,
        pidArguments: () => [executable, '-app-dir', appDir, '-host', '127.0.0.1', '-port', String(svc.port)],
    }), false, 'changed config');
    fs.writeFileSync(configPath, JSON.stringify(config));
    assert.equal(await lifecycle.verifyServiceIdentity(svc, 123, {
        ...base,
        pidArguments: () => [executable, '-app-dir', appDir, '-host', '127.0.0.1', '-port', String(svc.port)],
    }), true);
});

test('status marks optional sidecar up only after exact identity and health verification', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const svc = { port: 45104, name: 'Bifrost status', optional: true, executable: 'C:\\expected\\bifrost-http.exe', identity: { path: 'C:\\expected\\bifrost-http.exe' } };
    const map = new Map([[svc.port, new Set([123])]]);
    const down = (await lifecycle.statusRowsVerified([svc], map, 0, 'service', {
        verifyServiceIdentity: async () => false,
    }))[0];
    assert.equal(down.up, false);
    assert.equal(down.degraded, true);
    assert.equal(down.foreign, true);
    const up = (await lifecycle.statusRowsVerified([svc], map, 0, 'service', {
        verifyServiceIdentity: async () => true,
    }))[0];
    assert.equal(up.up, true);
    assert.equal(up.degraded, false);
});

test('new external launch failing identity is stopped by its exact returned PID', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const port = 45108;
    const pid = 91008;
    const live = new Map();
    const exactStops = [];
    const result = await lifecycle.startServices([{
        port,
        name: 'new wrong identity',
        executable: 'C:\\expected\\bifrost-http.exe',
        args: [],
        optional: true,
        ready: '/health',
        imageName: 'bifrost-http.exe',
        identity: { path: 'C:\\expected\\bifrost-http.exe' },
    }], {
        listeners: () => live,
        activeUpstreamPort: () => 0,
        startService: async () => { live.set(port, new Set([pid])); return pid; },
        sleep: async () => {},
        waitReady: async () => true,
        verifyProcessOwnership: async () => true,
        verifyServiceIdentity: async () => false,
        stopLaunched: async stoppedPid => {
            exactStops.push(stoppedPid);
            live.delete(port);
            return { pid: stoppedPid, freed: true };
        },
        maxPortPolls: 1,
    });
    assert.deepEqual(exactStops, [pid]);
    assert.equal(result.started.length, 0);
    assert.equal(result.optionalFailures[0].code, 'identity_failed');
});

test('production status surface verifies external identity before reporting sidecar up', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const svc = {
        port: 45109,
        name: 'Bifrost status fixture',
        executable: 'C:\\expected\\bifrost-http.exe',
        optional: true,
        identity: { path: 'C:\\expected\\bifrost-http.exe' },
    };
    const map = new Map([[svc.port, new Set([91009])]]);
    const rows = await lifecycle.statusVerified({
        services: [svc],
        childItems: [],
        customItems: [],
        listeners: () => map,
        activeUpstreamPort: () => 0,
        verifyServiceIdentity: async () => false,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].up, false);
    assert.equal(rows[0].foreign, true);
    const hubSource = fs.readFileSync(path.join(ROOT, 'hub.js'), 'utf8');
    assert.match(hubSource, /await L\.statusVerified\(\)/, 'hub production surfaces must await verified status');
});
test('runtime template rejects every scope expansion and projects only the fixed schema', () => {
    const sidecar = loadSidecar();
    const base = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const mutations = [
        ['second provider', doc => { doc.providers.other = structuredClone(doc.providers['abuse-hub']); }],
        ['plugin', doc => { doc.plugins = [{ name: 'routing' }]; }],
        ['governance', doc => { doc.governance = { enabled: true }; }],
        ['routing rules', doc => { doc.routing = { rules: [] }; }],
        ['extra store', doc => { doc.vector_store = { enabled: true }; }],
        ['unknown top level', doc => { doc.unreviewed = true; }],
        ['unknown provider field', doc => { doc.providers['abuse-hub'].unreviewed = true; }],
        ['unknown network field', doc => { doc.providers['abuse-hub'].network_config.unreviewed = true; }],
        ['unknown custom field', doc => { doc.providers['abuse-hub'].custom_provider_config.unreviewed = true; }],
        ['unknown client field', doc => { doc.client.unreviewed = true; }],
        ['inert required headers', doc => { doc.client.required_headers = ['x-abuse-hub-frontdoor']; }],
        ['unknown pricing field', doc => { doc.framework.pricing.unreviewed = true; }],
    ];
    for (const [name, mutate] of mutations) {
        const dir = fresh(`template-${name.replace(/\W+/g, '-')}`);
        const template = structuredClone(base);
        mutate(template);
        const templatePath = path.join(dir, 'template.json');
        fs.writeFileSync(templatePath, JSON.stringify(template));
        assert.throws(
            () => sidecar.writeRuntimeConfig({ templatePath, appDir: path.join(dir, 'app') }),
            /config|contract|scope/i,
            name,
        );
    }
});

test('POSIX external spawn awaits asynchronous EACCES and ENOENT errors', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const { EventEmitter } = require('node:events');
    for (const code of ['EACCES', 'ENOENT']) {
        let unrefCalled = false;
        const fakeSpawn = () => {
            const child = new EventEmitter();
            child.pid = 0;
            child.unref = () => { unrefCalled = true; };
            queueMicrotask(() => child.emit('error', Object.assign(new Error(code), { code })));
            return child;
        };
        await assert.rejects(
            lifecycle.startService({
                port: 45105, name: `optional ${code}`, executable: '/missing/bifrost-http',
                args: [], cwd: '/missing', optional: true, logName: `spawn-${code}`,
            }, { platform: 'linux', spawn: fakeSpawn, rotateLog: () => path.join(TMP, `${code}.log`) }),
            error => error.code === code,
        );
        assert.equal(unrefCalled, false, `${code} child must not detach before spawn succeeds`);
    }
});

test('descriptor-scoped Bifrost restart leaves dashboard and front-door fixtures alive', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const sidecar = { port: 45106, name: 'Bifrost', executable: process.execPath, args: [], optional: true, identity: { path: process.execPath } };
    const dashboardPid = 82001;
    const frontdoorPid = 2010001;
    const oldSidecarPid = 4510601;
    const newSidecarPid = 4510602;
    const live = new Map([
        [8200, new Set([dashboardPid])],
        [20100, new Set([frontdoorPid])],
        [sidecar.port, new Set([oldSidecarPid])],
    ]);
    const stopped = [];
    const launched = [];
    const result = await lifecycle.restartService('Bifrost', {
        services: [sidecar],
        listeners: () => live,
        verifyProcessOwnership: async (_svc, pid) => pid === oldSidecarPid,
        stopLaunched: async pid => {
            stopped.push(pid);
            live.delete(sidecar.port);
            return { freed: true, was: [pid], port: sidecar.port };
        },
        startService: async svc => {
            launched.push(svc.name);
            live.set(sidecar.port, new Set([newSidecarPid]));
            return newSidecarPid;
        },
        sleep: async () => {},
        waitReady: async () => true,
        verifyServiceIdentity: async (_svc, pid) => pid === newSidecarPid,
        writeLaunchRecord: () => {},
        maxPortPolls: 1,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(stopped, [oldSidecarPid]);
    assert.deepEqual(launched, ['Bifrost']);
    assert.deepEqual([...live.get(8200)], [dashboardPid]);
    assert.deepEqual([...live.get(20100)], [frontdoorPid]);
});


test('launch descriptor binds IPv4 loopback and passes app dir, port, args, and env', () => {
    const sidecar = loadSidecar();
    const descriptor = sidecar.createServiceDescriptor({
        executable: 'C:\\cache\\bifrost-http.exe',
        appDir: 'C:\\runtime\\bifrost',
        port: 45679,
        env: { FIXTURE_ENV: 'present' },
    });
    assert.equal(descriptor.port, 45679);
    assert.equal(descriptor.optional, true);
    assert.equal(descriptor.ready, '/health');
    assert.equal(descriptor.logName, 'bifrost');
    assert.equal(descriptor.imageName, 'bifrost-http.exe');
    assert.equal(descriptor.executable, 'C:\\cache\\bifrost-http.exe');
    assert.deepEqual(descriptor.args, [
        '-app-dir', 'C:\\runtime\\bifrost',
        '-host', '127.0.0.1',
        '-port', '45679',
        '-log-level', 'error',
        '-log-style', 'json',
    ]);
    assert.equal(descriptor.env.FIXTURE_ENV, 'present');
    assert.equal(descriptor.env.BIFROST_HOST, undefined);
});

test('default optional descriptor contains invalid port configuration instead of blocking lifecycle load', async () => {
    const sidecar = loadSidecar();
    const descriptor = sidecar.defaultServiceDescriptor({ port: Number.NaN });
    assert.equal(descriptor.optional, true);
    assert.equal(descriptor.port, 20135);
    await assert.rejects(descriptor.prepare(descriptor), /port/i);
});

test('default optional descriptor survives missing lock and defers the failure to prepare', async () => {
    const sidecar = loadSidecar();
    const root = fresh('missing-lock-descriptor');
    const descriptor = sidecar.defaultServiceDescriptor({
        lockPath: path.join(root, 'missing-lock.json'),
        configTemplatePath: CONFIG_PATH,
        cacheRoot: path.join(root, 'cache'),
        runtimeRoot: path.join(root, 'runtime'),
        platform: 'win32',
        arch: 'x64',
        port: 45680,
    });
    assert.equal(descriptor.optional, true);
    assert.equal(descriptor.port, 45680);
    await assert.rejects(descriptor.prepare(descriptor), /unavailable|missing/i);
});

test('default lifecycle descriptor never downloads a missing binary during stack start', async () => {
    const sidecar = loadSidecar();
    const root = fresh('missing-cache-descriptor');
    const payload = Buffer.from('would be downloadable');
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    lock.artifacts['win32-x64'].sha256 = hashBytes(payload);
    const fixtureLock = path.join(root, 'lock.json');
    fs.writeFileSync(fixtureLock, JSON.stringify(lock));
    let downloads = 0;
    const descriptor = sidecar.defaultServiceDescriptor({
        lockPath: fixtureLock,
        configTemplatePath: CONFIG_PATH,
        cacheRoot: path.join(root, 'cache'),
        runtimeRoot: path.join(root, 'runtime'),
        platform: 'win32',
        arch: 'x64',
        port: 45681,
        download: async (_url, temp) => {
            downloads += 1;
            fs.writeFileSync(temp, payload);
        },
    });
    await assert.rejects(descriptor.prepare(descriptor), /missing|checksum|corrupt/i);
    assert.equal(downloads, 0, 'normal stack start must not contact the release host');
});

test('repository ignore rules cover the versioned binary cache and generated runtime app dir', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.match(ignore, /^routing\/runtime\/bifrost\/$/m);
    assert.match(ignore, /^routing\/bifrost-cache\/$/m);
});

test('lifecycle readiness requires a successful health response, not merely an HTTP listener', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const port = await freePort();
    const server = http.createServer((_req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"status":"unhealthy"}');
    });
    await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', error => error ? reject(error) : resolve()));
    try {
        assert.equal(await lifecycle.waitReady(port, '/health', 250), false);
    } finally {
        await new Promise(resolve => server.close(() => resolve()));
    }
});

test('optional service with failed readiness is stopped and omitted from started services', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const port = 45005;
    const live = new Map();
    const stopped = [];
    const result = await lifecycle.startServices([{
        port,
        name: 'unhealthy optional',
        executable: 'bifrost-http',
        args: [],
        optional: true,
        ready: '/health',
        imageName: 'bifrost-http.exe',
        logName: 'bifrost',
    }], {
        listeners: () => live,
        activeUpstreamPort: () => 0,
        startService: () => {
            live.set(port, new Set([777]));
            return 777;
        },
        sleep: async () => {},
        waitReady: async () => false,
        verifyProcessOwnership: async () => true,
        stopLaunched: async stoppedPid => {
            stopped.push(stoppedPid);
            live.delete(port);
            return { pid: stoppedPid, freed: true, denied: false };
        },
        pidImage: () => 'bifrost-http.exe',
        logTail: () => '(fixture)',
        serviceLog: () => 'fixture.log',
        maxPortPolls: 1,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(stopped, [777]);
    assert.equal(result.started.length, 0);
    assert.equal(result.optionalFailures.length, 1);
    assert.match(result.optionalFailures[0].text, /status|health|ready|отвечает/i);
});

test('optional occupied sidecar uses exact identity, skips verified holder, and cleans unhealthy owned PID only', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const port = 45006;
    const pid = 888;
    const live = new Map([[port, new Set([pid])]]);
    const events = [];
    const exactStops = [];
    const svc = {
        port,
        name: 'occupied optional',
        executable: 'C:\\expected\\bifrost-http.exe',
        args: [],
        optional: true,
        ready: '/health',
        imageName: 'bifrost-http.exe',
        logName: 'bifrost',
        identity: { path: 'C:\\expected\\bifrost-http.exe' },
    };
    const verified = await lifecycle.startServices([svc], {
        on: event => events.push(event),
        listeners: () => live,
        activeUpstreamPort: () => 0,
        verifyProcessOwnership: async () => true,
        verifyServiceIdentity: async () => true,
        stopLaunched: async stoppedPid => { exactStops.push(stoppedPid); return { pid: stoppedPid, freed: true }; },
    });
    assert.equal(verified.optionalFailures.length, 0);
    assert.equal(events.some(event => event.type === 'start-skip'), true);
    assert.deepEqual(exactStops, []);

    events.length = 0;
    const unhealthy = await lifecycle.startServices([svc], {
        on: event => events.push(event),
        listeners: () => live,
        activeUpstreamPort: () => 0,
        verifyProcessOwnership: async () => true,
        verifyServiceIdentity: async () => false,
        stopLaunched: async stoppedPid => {
            exactStops.push(stoppedPid);
            live.delete(port);
            return { pid: stoppedPid, freed: true };
        },
    });
    assert.deepEqual(exactStops, [pid]);
    assert.equal(unhealthy.optionalFailures.length, 1);
    assert.equal(events.some(event => event.type === 'start-skip'), false);
});

test('required occupied external identity failure cleans the exact PID and fails startup', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const port = 45112;
    const pid = 91012;
    const live = new Map([[port, new Set([pid])]]);
    const exactStops = [];
    const events = [];
    const svc = {
        port,
        name: 'required external fixture',
        executable: 'C:\\expected\\required-service.exe',
        args: [],
        optional: false,
        imageName: 'required-service.exe',
        identity: { path: 'C:\\expected\\required-service.exe' },
    };
    const result = await lifecycle.startServices([svc], {
        on: event => events.push(event),
        listeners: () => live,
        activeUpstreamPort: () => 0,
        verifyProcessOwnership: async () => true,
        verifyServiceIdentity: async () => false,
        stopLaunched: async stoppedPid => {
            exactStops.push(stoppedPid);
            live.delete(port);
            return { pid: stoppedPid, freed: true };
        },
    });
    assert.deepEqual(exactStops, [pid]);
    assert.equal(live.has(port), false);
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, {
        name: svc.name,
        port: svc.port,
        optional: false,
    });
    assert.deepEqual(result.optionalFailures, []);
    assert.equal(events.some(event => event.type === 'error' && event.port === port), true);
});

test('lifecycle supports external args/env/log name and optional service failure continuation', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    assert.equal(typeof lifecycle.startServices, 'function');
    assert.equal(typeof lifecycle.isOursForService, 'function');

    const calls = [];
    const services = [
        { port: 45001, name: 'optional', executable: 'missing-bifrost', args: ['--one'], env: { A: 'B' }, optional: true, logName: 'bifrost', imageName: 'bifrost-http.exe' },
        { port: 45002, name: 'required', script: 'fixture.js' },
    ];
    const listeners = new Map();
    const events = [];
    const result = await lifecycle.startServices(services, {
        on: event => events.push(event),
        listeners: () => listeners,
        activeUpstreamPort: () => 0,
        startService: svc => {
            calls.push(svc);
            if (svc.optional) throw new Error('missing optional executable');
            listeners.set(svc.port, new Set([333]));
            return 333;
        },
        sleep: async () => {},
        waitReady: async () => true,
        verifyProcessOwnership: async () => true,
        pidImage: () => 'node.exe',
        logTail: () => '(fixture)',
        serviceLog: svc => `${svc.logName || svc.script}.log`,
        maxPortPolls: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.optionalFailures.length, 1);
    assert.equal(result.optionalFailures[0].port, 45001);
    assert.equal(result.failed, undefined);
    assert.deepEqual(calls, services);
    assert.ok(events.some(event => event.type === 'start-optional-failed' && event.port === 45001));
    assert.ok(result.started.some(row => row.port === 45002));

    const foreignEvents = [];
    const occupied = new Map([[45003, new Set([444])]]);
    const foreignResult = await lifecycle.startServices([
        { port: 45003, name: 'optional occupied', executable: 'bifrost-http', args: [], optional: true, imageName: 'bifrost-http.exe', logName: 'bifrost' },
        { port: 45004, name: 'required after occupied optional', script: 'fixture.js' },
    ], {
        on: event => foreignEvents.push(event),
        listeners: () => occupied,
        activeUpstreamPort: () => 0,
        startService: svc => {
            if (svc.port === 45004) {
                occupied.set(svc.port, new Set([555]));
                return 555;
            }
            throw new Error('optional foreign service must not launch');
        },
        sleep: async () => {},
        waitReady: async () => true,
        verifyProcessOwnership: async (_svc, pid) => pid !== 444,
        pidImage: pid => pid === 444 ? 'foreign.exe' : 'node.exe',
        logTail: () => '(fixture)',
        serviceLog: () => 'fixture.log',
        maxPortPolls: 1,
    });
    assert.equal(foreignResult.ok, true);
    assert.equal(foreignResult.foreign.length, 0);
    assert.equal(foreignResult.optionalFailures.length, 1);
    assert.ok(foreignEvents.some(event => event.type === 'start-optional-failed' && event.port === 45003));

    const macOwned = await lifecycle.startServices([
        { port: 45005, name: 'mac dashboard', script: 'transparent-proxy.js', ready: '/__switch/api/status' },
    ], {
        listeners: () => new Map([[45005, new Set([777])]]),
        activeUpstreamPort: () => 0,
        pidImage: () => '/opt/homebrew/Cellar/node/26.3.0/bin/node',
        pidExecutable: () => '/opt/homebrew/Cellar/node/26.3.0/bin/node',
        pidArguments: () => ['/opt/homebrew/Cellar/node/26.3.0/bin/node', path.join(ROOT, 'routing', 'transparent-proxy.js')],
        waitReady: async () => true,
    });
    assert.equal(macOwned.ok, true);
    assert.equal(macOwned.foreign.length, 0);

    const macForeign = await lifecycle.startServices([
        { port: 45006, name: 'mac dashboard', script: 'transparent-proxy.js', ready: '/__switch/api/status' },
    ], {
        listeners: () => new Map([[45006, new Set([778])]]),
        activeUpstreamPort: () => 0,
        pidImage: () => '/opt/homebrew/Cellar/node/26.3.0/bin/node',
        pidExecutable: () => '/opt/homebrew/Cellar/node/26.3.0/bin/node',
        pidArguments: () => ['/opt/homebrew/Cellar/node/26.3.0/bin/node', '/Users/fixture/foreign.js'],
        waitReady: async () => true,
    });
    assert.equal(macForeign.ok, false);
    assert.equal(macForeign.foreign.length, 1);

    const macSpoofedExtraArg = await lifecycle.startServices([
        { port: 45009, name: 'mac dashboard', script: 'transparent-proxy.js', ready: '/__switch/api/status' },
    ], {
        listeners: () => new Map([[45009, new Set([782])]]),
        activeUpstreamPort: () => 0,
        pidImage: () => '/opt/homebrew/Cellar/node/26.3.0/bin/node',
        pidExecutable: () => '/opt/homebrew/Cellar/node/26.3.0/bin/node',
        pidArguments: () => [
            '/opt/homebrew/Cellar/node/26.3.0/bin/node',
            '/Users/fixture/foreign.js',
            path.join(ROOT, 'routing', 'transparent-proxy.js'),
        ],
        waitReady: async () => true,
    });
    assert.equal(macSpoofedExtraArg.ok, false);
    assert.equal(macSpoofedExtraArg.foreign.length, 1);

    assert.equal(lifecycle.serviceLog({ executable: 'x', logName: 'bifrost' }).endsWith(`${path.sep}bifrost.log`), true);
    const fixtureCommand = [process.execPath, path.join(ROOT, 'routing', 'fixture.js')];
    assert.equal(lifecycle.isOursForService({ script: 'fixture.js' }, 'node.exe', process.execPath, fixtureCommand), true);
    assert.equal(lifecycle.isOursForService({ script: 'fixture.js' }, 'node', process.execPath, fixtureCommand), true);
    assert.equal(lifecycle.pidImage(process.pid), path.basename(process.execPath));
    assert.equal(lifecycle.isOurs(process.pid), true);
    assert.equal(lifecycle.isOursForService({ executable: 'x', imageName: 'bifrost-http.exe' }, 'bifrost-http.exe'), false);
    assert.equal(lifecycle.isOursForService({ executable: 'x', imageName: 'bifrost-http.exe' }, 'bifrost-http.exe', path.resolve('x')), true);
    assert.equal(lifecycle.isOursForService({ executable: 'x', imageName: 'bifrost-http.exe' }, 'node.exe'), false);
});

test('lifecycle stop refuses a foreign Node script and terminates only the exact owned script PID', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const svc = { port: 45007, name: 'mac dashboard', script: 'transparent-proxy.js' };
    const nodePath = '/opt/homebrew/Cellar/node/26.3.0/bin/node';
    const expectedScript = path.join(ROOT, 'routing', 'transparent-proxy.js');
    let portKilled = false;

    const foreign = await lifecycle.stopServices([svc], {
        phase: 'stop',
        children: [],
        listeners: () => new Map([[svc.port, new Set([779])]]),
        pidImage: () => nodePath,
        pidExecutable: () => nodePath,
        pidArguments: () => [nodePath, '/Users/fixture/foreign.js'],
        killPort: async () => { portKilled = true; return { freed: true }; },
        drainAll: async () => ({ asked: 0, inflight: 0, freed: 0 }),
    });
    assert.equal(portKilled, false);
    assert.equal(foreign.stuck.length, 1);
    assert.equal(foreign.stuck[0].foreign, true);

    const live = new Map([[svc.port, new Set([780])]]);
    const stopped = [];
    const owned = await lifecycle.stopServices([svc], {
        phase: 'stop',
        children: [],
        listeners: () => live,
        pidImage: () => nodePath,
        pidExecutable: () => nodePath,
        pidArguments: () => [nodePath, expectedScript],
        stopLaunched: async pid => {
            stopped.push(pid);
            live.delete(svc.port);
            return { pid, freed: true, denied: false };
        },
        killPort: async () => { portKilled = true; return { freed: true }; },
        drainAll: async () => ({ asked: 0, inflight: 0, freed: 0 }),
    });
    assert.deepEqual(stopped, [780]);
    assert.equal(owned.stuck.length, 0);
});

test('verified lifecycle status marks a foreign Node script down instead of reporting the port as healthy', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const svc = { port: 45008, name: 'mac dashboard', script: 'transparent-proxy.js' };
    const rows = await lifecycle.statusVerified({
        services: [svc],
        childItems: [],
        customItems: [],
        listeners: () => new Map([[svc.port, new Set([781])]]),
        activeUpstreamPort: () => 0,
        verifyProcessOwnership: async () => false,
    });
    assert.equal(rows[0].up, false);
    assert.equal(rows[0].foreign, true);
});

test('child lifecycle status and stop refuse a foreign Node holder on a managed child port', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const child = { port: 45010, name: 'Front Door fixture', respawn: true, script: 'frontdoor-proxy.js' };
    const rows = await lifecycle.statusVerified({
        services: [],
        childItems: [child],
        customItems: [],
        listeners: () => new Map([[child.port, new Set([783])]]),
        activeUpstreamPort: () => 0,
        verifyProcessOwnership: async () => false,
    });
    assert.equal(rows[0].up, false);
    assert.equal(rows[0].foreign, true);

    let killed = false;
    const stopped = await lifecycle.stopServices([], {
        phase: 'restart',
        children: [child],
        listeners: () => new Map([[child.port, new Set([783])]]),
        verifyProcessOwnership: async () => false,
        killPort: async () => { killed = true; return { freed: true }; },
        drainAll: async () => ({ asked: 0, inflight: 0, freed: 0 }),
    });
    assert.equal(killed, false);
    assert.equal(stopped.stuck.length, 1);
    assert.equal(stopped.stuck[0].foreign, true);
});

test('lifecycle start rejects a foreign PID that wins the port after launch and stops only its launch handle', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const svc = { port: 45011, name: 'mac dashboard', script: 'transparent-proxy.js', ready: '/health' };
    const live = new Map();
    const exactStops = [];
    let readyCalled = false;
    const result = await lifecycle.startServices([svc], {
        listeners: () => live,
        activeUpstreamPort: () => 0,
        startService: () => {
            live.set(svc.port, new Set([784]));
            return 700;
        },
        sleep: async () => {},
        verifyProcessOwnership: async () => false,
        waitReady: async () => { readyCalled = true; return true; },
        stopLaunched: async pid => { exactStops.push(pid); return { pid, freed: true, denied: false }; },
        killPort: async () => { throw new Error('foreign port holder must never be killed by port'); },
        maxPortPolls: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(readyCalled, false);
    assert.deepEqual(exactStops, [700]);
});

test('ensureProviderService refuses foreign occupied and post-launch holders', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const svc = { port: 45012, name: 'lazy provider', script: 'fixture.js', provider: 'fixture' };
    let launched = false;
    let stopped = 0;
    const occupied = await lifecycle.ensureProviderService(svc.port, {
        services: [svc],
        listeners: () => new Map([[svc.port, new Set([785])]]),
        verifyProcessOwnership: async () => false,
        startService: async () => { launched = true; return 700; },
    });
    assert.equal(occupied.ok, false);
    assert.equal(launched, false);

    const live = new Map();
    const raced = await lifecycle.ensureProviderService(svc.port, {
        services: [svc],
        listeners: () => live,
        verifyProcessOwnership: async () => false,
        startService: async () => { live.set(svc.port, new Set([786])); return 701; },
        stopLaunched: async pid => { stopped = pid; return { pid, freed: true, denied: false }; },
        sleep: async () => {},
        maxPortPolls: 1,
    });
    assert.equal(raced.ok, false);
    assert.equal(stopped, 701);
});

test('lifecycle startServices launches an external descriptor with exact args, env, readiness, and optional status', async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const fixtureDir = fresh('external-lifecycle');
    const fixture = path.join(fixtureDir, 'fixture.js');
    fs.writeFileSync(fixture, `
const http = require('node:http');
const port = Number(process.argv[2]);
const expected = process.argv[3];
if (expected !== 'arg-ok' || process.env.BIFROST_FIXTURE !== 'env-ok') process.exit(23);
http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('ok'); }).listen(port, '127.0.0.1');
`, 'utf8');
    const port = await freePort();
    const svc = {
        port,
        name: 'Bifrost fixture',
        executable: process.execPath,
        args: [fixture, String(port), 'arg-ok'],
        env: { BIFROST_FIXTURE: 'env-ok' },
        cwd: fixtureDir,
        ready: '/health',
        optional: true,
        logName: `bifrost-fixture-${process.pid}`,
        imageName: path.basename(process.execPath),
    };
    const live = new Map();
    let child = null;
    const result = await lifecycle.startServices([svc], {
        listeners: () => live,
        activeUpstreamPort: () => 0,
        startService: descriptor => {
            child = spawn(descriptor.executable, descriptor.args, {
                cwd: descriptor.cwd,
                env: { ...process.env, ...descriptor.env },
                stdio: 'ignore',
                windowsHide: true,
            });
            live.set(descriptor.port, new Set([child.pid]));
            return child.pid;
        },
        sleep: async () => {},
        waitReady: async (readyPort, pathname) => {
            const response = await waitFor(() => request(readyPort, pathname));
            return response.status === 200;
        },
        pidImage: () => path.basename(process.execPath),
        maxPortPolls: 1,
    });
    try {
        assert.equal(result.ok, true);
        assert.equal(result.optionalFailures.length, 0);
        assert.equal(result.started.length, 1);
        assert.equal(result.started[0].pid, child.pid);
        const health = await request(port, '/health');
        assert.equal(health.status, 200);
        assert.equal(health.body, 'ok');
        assert.equal(lifecycle.isOursForService(svc, path.basename(process.execPath), process.execPath), true);
        const row = lifecycle.statusRows([svc], live, 0)[0];
        assert.equal(row.optional, true);
        assert.equal(row.expected, false);
        assert.equal(row.degraded, false);
        const down = lifecycle.statusRows([svc], new Map(), 0)[0];
        assert.equal(down.up, false);
        assert.equal(down.expected, false);
        assert.equal(down.degraded, true);
    } finally {
        await terminate(child);
    }
});

test('actual lifecycle external spawn preserves spaced args, env, readiness, log, and stop on a dynamic port', { timeout: 30000 }, async () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const fixtureDir = fresh('actual external spawn with spaces');
    const fixture = path.join(fixtureDir, 'fixture server.js');
    const mark = path.join(fixtureDir, 'received args.json');
    const port = await freePort();
    fs.writeFileSync(fixture, `
const fs = require('node:fs');
const http = require('node:http');
const port = Number(process.argv[2]);
fs.writeFileSync(process.argv[4], JSON.stringify({ arg: process.argv[3], env: process.env.BIFROST_FIXTURE }));
http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('ok'); }).listen(port, '127.0.0.1');
`, 'utf8');
    const svc = {
        port,
        name: 'Actual external fixture',
        executable: process.execPath,
        args: [fixture, String(port), 'arg with spaces', mark],
        env: { BIFROST_FIXTURE: 'env with spaces' },
        cwd: fixtureDir,
        ready: '/health',
        optional: true,
        logName: `bifrost-actual-fixture-${process.pid}-${port}`,
        imageName: path.basename(process.execPath),
    };
    const log = lifecycle.serviceLog(svc);
    let launchPid = 0;
    try {
        launchPid = await lifecycle.startService(svc);
        const ready = await waitFor(async () => {
            assert.equal(await lifecycle.waitReady(port, '/health', 500), true);
            return true;
        }, 15000);
        assert.equal(ready, true);
        assert.deepEqual(JSON.parse(fs.readFileSync(mark, 'utf8')), {
            arg: 'arg with spaces',
            env: 'env with spaces',
        });
        assert.equal(fs.existsSync(log), true);
        assert.equal((lifecycle.listeners().get(port) || new Set()).size, 1);
    } finally {
        if (launchPid) await lifecycle.stopLaunched(launchPid);
        try { fs.unlinkSync(log); } catch { /* no log if launch failed */ }
    }
    assert.equal((lifecycle.listeners().get(port) || new Set()).size, 0);
});

test('hub renders optional Bifrost failure and down status as a neutral sidecar degradation', async () => {
    const hubPath = path.join(ROOT, 'hub.js');
    delete require.cache[require.resolve(hubPath)];
    const hub = require(hubPath);
    const lifecycle = require(LIFECYCLE_PATH);
    assert.equal(typeof hub.reporter, 'function');
    assert.equal(typeof hub.finishStart, 'function');
    assert.equal(typeof hub.statusBlock, 'function');
    const originalStatus = lifecycle.statusVerified;
    lifecycle.statusVerified = async () => [
        { port: 8200, name: 'Dashboard', role: 'service', up: true, pids: [1], expected: true },
        { port: 20135, name: 'Bifrost', role: 'service', up: false, pids: [], optional: true, expected: false, degraded: true },
    ];
    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = chunk => { output += String(chunk); return true; };
    try {
        const report = hub.reporter();
        report({ type: 'start-begin', name: 'Bifrost', port: 20135 });
        report({ type: 'start-optional-failed', name: 'Bifrost', port: 20135, text: 'checksum mismatch' });
        assert.equal(hub.finishStart({
            ok: true,
            started: [{ name: 'Dashboard', port: 8200 }],
            foreign: [],
            optionalFailures: [{ name: 'Bifrost', port: 20135 }],
        }, false), true);
        await hub.statusBlock({ compact: true });
    } finally {
        process.stdout.write = originalWrite;
        lifecycle.statusVerified = originalStatus;
    }
    const plain = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.match(plain, /Bifrost/);
    assert.match(plain, /OpenAI sidecar unavailable|OpenAI sidecar недоступен/i);
    assert.doesNotMatch(plain, /Старт не удался/);
    assert.doesNotMatch(plain, /ждут выбора провайдера:.*Bifrost/i);
});

test('optional Bifrost is registered in status, stop, restart, and start order', () => {
    delete require.cache[require.resolve(LIFECYCLE_PATH)];
    const lifecycle = require(LIFECYCLE_PATH);
    const bifrost = lifecycle.SERVICES.find(service => service.name === 'Bifrost');
    assert.ok(bifrost, 'Bifrost service must be registered');
    assert.equal(bifrost.port, 20135);
    assert.equal(bifrost.optional, true);
    assert.equal(bifrost.ready, '/health');
    assert.equal(bifrost.logName, 'bifrost');
    assert.ok(bifrost.executable);
    assert.ok(Array.isArray(bifrost.args));
    for (const phase of ['stop', 'restart']) {
        assert.ok(lifecycle.killPlan(phase).some(item => item.port === 20135), phase);
    }
    const row = lifecycle.statusRows([bifrost], new Map(), 0, 'service')[0];
    assert.equal(row.optional, true);
    assert.equal(row.expected, false);
});

test('tracked Bifrost binary is absent from the git index', () => {
    const tracked = require('node:child_process').spawnSync(
        'git', ['-C', ROOT, 'ls-files', 'routing/bifrost-cache', 'routing/runtime/bifrost'],
        { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(tracked.status, 0);
    assert.equal(String(tracked.stdout).trim(), '');
});

test('opt-in real Bifrost reaches only the frontdoor marker boundary on dynamic ports', { timeout: 60000 }, async t => {
    if (process.env.BIFROST_REAL_SMOKE !== '1') return t.skip('set BIFROST_REAL_SMOKE=1 to run pinned real-binary boundary smoke');
    const sidecar = loadSidecar();
    const lifecycle = require(LIFECYCLE_PATH);
    const source = process.env.BIFROST_REAL_BINARY;
    if (!source || !fs.existsSync(source)) return t.skip('BIFROST_REAL_BINARY is not available');
    const expectedHash = EXPECTED.artifacts['win32-x64'].sha256;
    assert.equal(sidecar.verifyFile(source, expectedHash).ok, true);

    const backendPort = await freePort();
    const frontdoorPort = await freePort();
    const sidecarPort = await freePort();
    const hostilePprofPort = await freePort();
    const fixtureRoot = fresh('real-frontdoor-boundary');
    const localHopSecretPath = path.join(fixtureRoot, 'abuse-hub-local-hop.key');
    const frontdoorScript = path.join(ROOT, 'routing', 'frontdoor-proxy.js');
    const activePath = path.join(fixtureRoot, '.claude', 'active-backend.json');
    const backendsPath = path.join(fixtureRoot, '.claude', 'backends.json');
    const defaultManifestPath = path.join(fixtureRoot, 'routing', 'api-gateway.default.json');
    const manifestPath = path.join(fixtureRoot, 'routing', 'api-gateway.json');
    const settingsPath = path.join(fixtureRoot, '.claude', 'settings.json');
    const usagePath = path.join(fixtureRoot, 'token-usage.jsonl');
    const frontdoorLogPath = path.join(fixtureRoot, 'frontdoor.log');
    const writeJson = (file, value) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    };
    const usageRows = () => {
        if (!fs.existsSync(usagePath)) return [];
        const text = fs.readFileSync(usagePath, 'utf8').trim();
        return text ? text.split(/\r?\n/).map(line => JSON.parse(line)) : [];
    };

    const backendCalls = [];
    const backend = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            backendCalls.push({ path: req.url, body: parsed, headers: req.headers });
            const response = JSON.stringify({
                id: 'msg_fixture', type: 'message', role: 'assistant', model: parsed.model,
                content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
            });
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(response) });
            res.end(response);
        });
    });
    await new Promise((resolve, reject) => backend.listen(backendPort, '127.0.0.1', error => error ? reject(error) : resolve()));

    const backendState = {
        backend: 'agentrouter',
        upstream: `http://127.0.0.1:${backendPort}`,
        modelmap: null,
        updatedAt: Date.now(),
    };
    writeJson(activePath, backendState);
    writeJson(backendsPath, { version: 1, providers: { agentrouter: backendState }, aliases: {} });
    writeJson(defaultManifestPath, {
        version: 1,
        revision: 1,
        enabled: true,
        models: {
            'agentrouter/vendor/model': {
                displayName: 'Boundary Fixture',
                claudeBehavesAs: 'claude-opus-5',
                contextTokens: 1000,
                outputTokens: 100,
                publishedAt: '2026-11-10T00:00:00.000Z',
            },
        },
    });

    let frontdoorStderr = '';
    const frontdoorChild = spawn(process.execPath, [frontdoorScript], {
        cwd: path.dirname(frontdoorScript),
        env: {
            ...process.env,
            PORT: String(frontdoorPort),
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: localHopSecretPath,
            HOME: fixtureRoot,
            USERPROFILE: fixtureRoot,
            ACTIVE_BACKEND_FILE: activePath,
            BACKENDS_FILE: backendsPath,
            API_GATEWAY_DEFAULT_FILE: defaultManifestPath,
            API_GATEWAY_FILE: manifestPath,
            CLAUDE_SETTINGS_FILE: settingsPath,
            TOKEN_USAGE_FILE: usagePath,
            LOG_FILE: frontdoorLogPath,
            SWITCH_PORT: '1',
            BIFROST_URL: `http://127.0.0.1:${sidecarPort}`,
            MULTI_MAP_FILE: path.join(fixtureRoot, 'multi-routes-modelmap.json'),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    frontdoorChild.stderr.on('data', chunk => { frontdoorStderr += chunk.toString('utf8'); });

    const runtimeRoot = fresh('real-runtime');
    const descriptor = sidecar.createServiceDescriptor({
        executable: source,
        appDir: path.join(runtimeRoot, EXPECTED.version),
        port: sidecarPort,
        expectedSha256: expectedHash,
        version: EXPECTED.version,
        prepare: async current => {
            const appDir = path.join(runtimeRoot, EXPECTED.version);
            const configPath = sidecar.writeRuntimeConfig({
                templatePath: CONFIG_PATH,
                appDir,
                baseUrl: `http://127.0.0.1:${frontdoorPort}`,
            });
            return sidecar.createServiceDescriptor({
                executable: source,
                appDir,
                configPath,
                port: current.port,
                expectedSha256: expectedHash,
                version: EXPECTED.version,
            });
        },
    });
    const live = new Map();
    let launchedPid = 0;
    let launchedChild = null;
    let childEnv = null;
    try {
        await waitFor(async () => {
            const ready = await rawRequest(frontdoorPort, { pathname: '/__frontdoor/api/status' });
            assert.equal(ready.status, 200, frontdoorStderr.slice(-500));
            return true;
        });
        const result = await lifecycle.startServices([descriptor], {
            listeners: () => live,
            activeUpstreamPort: () => 0,
            startService: async svc => {
                childEnv = lifecycle.serviceEnv(svc, {
                    ...process.env,
                    OPENAI_API_KEY: 'real-smoke-secret',
                    ANTHROPIC_API_KEY: 'real-smoke-secret',
                    HTTPS_PROXY: 'http://user:pass@proxy.invalid',
                    BIFROST_PPROF_HOST: '0.0.0.0',
                    BIFROST_PPROF_PORT: String(hostilePprofPort),
                });
                launchedChild = spawn(svc.executable, svc.args, {
                    cwd: svc.cwd,
                    env: childEnv,
                    stdio: 'ignore',
                    windowsHide: true,
                });
                launchedPid = launchedChild.pid;
                return launchedPid;
            },
            sleep: async () => {
                try {
                    const health = await request(sidecarPort, '/health');
                    if (health.status === 200) live.set(sidecarPort, new Set([launchedPid]));
                } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
            },
            waitReady: async () => (await request(sidecarPort, '/health')).status === 200,
            verifyServiceIdentity: async () => true,
            stopLaunched: async pid => {
                if (pid === launchedPid && launchedChild) await terminate(launchedChild);
                live.delete(sidecarPort);
                return { pid, freed: true, denied: false };
            },
            maxPortPolls: 120,
        });
        assert.equal(result.ok, true);
        assert.equal(result.optionalFailures.length, 0);
        assert.equal(result.started.length, 1);
        assert.equal(childEnv.OPENAI_API_KEY, undefined);
        assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
        assert.equal(childEnv.HTTPS_PROXY, undefined);
        assert.equal(childEnv.BIFROST_PPROF_HOST, undefined);
        assert.equal(childEnv.BIFROST_PPROF_PORT, undefined);
        await assert.rejects(request(hostilePprofPort, '/debug/pprof/'), /ECONNREFUSED|socket hang up|connect/i);

        const health = await request(sidecarPort, '/health');
        assert.equal(health.status, 200);
        const bifrostBody = JSON.stringify({
            model: 'abuse-hub/agentrouter/vendor/model',
            messages: [{ role: 'user', content: 'hostile direct fixture' }],
        });
        for (const origin of ['https://evil.example', 'null']) {
            const preflight = await rawRequest(sidecarPort, {
                method: 'OPTIONS',
                pathname: '/v1/chat/completions',
                headers: {
                    origin,
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': 'content-type',
                },
            });
            assert.equal(preflight.status, 403, `${origin}: ${preflight.body}`);
            assert.equal(preflight.headers['access-control-allow-origin'], undefined, origin);
        }
        assert.equal(backendCalls.length, 0);
        assert.deepEqual(usageRows(), []);

        for (const origin of ['https://evil.example', undefined]) {
            const headers = {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(bifrostBody),
            };
            if (origin) headers.origin = origin;
            const direct = await rawRequest(sidecarPort, {
                method: 'POST',
                pathname: '/v1/chat/completions',
                headers,
                body: bifrostBody,
            });
            assert.ok(direct.status >= 400, `${origin || 'no-Origin'} direct Bifrost POST returned ${direct.status}: ${direct.body}`);
            assert.equal(direct.headers['access-control-allow-origin'], undefined);
            assert.match(direct.body, /Internal request is not permitted/i);
            assert.equal(backendCalls.length, 0, 'Bifrost may reach only the local frontdoor marker boundary');
            assert.deepEqual(usageRows(), [], 'blocked Bifrost request must not create a usage record');
        }

        const nativeBody = JSON.stringify({
            model: 'agentrouter/vendor/model',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'native fixture' }],
        });
        const spoofed = await rawRequest(frontdoorPort, {
            method: 'POST',
            pathname: '/v1/messages',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(nativeBody),
                'x-abuse-hub-internal': sidecar.INTERNAL_HOP_MARKER,
            },
            body: nativeBody,
        });
        assert.equal(spoofed.status, 403);
        assert.match(spoofed.body, /Internal request is not permitted/i);
        assert.equal(backendCalls.length, 0);
        assert.deepEqual(usageRows(), []);

        const native = await rawRequest(frontdoorPort, {
            method: 'POST',
            pathname: '/v1/messages',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(nativeBody),
            },
            body: nativeBody,
        });
        assert.equal(native.status, 200, native.body);
        assert.equal(backendCalls.length, 1);
        assert.equal(backendCalls[0].path, '/v1/messages');
        assert.equal(backendCalls[0].body.model, 'vendor/model');
        assert.equal(backendCalls[0].headers['x-abuse-hub-internal'], undefined);
        const rows = await waitFor(() => {
            const current = usageRows();
            assert.equal(current.length, 1);
            return current;
        });
        assert.equal(rows[0].bk, 'agentrouter');
        assert.deepEqual(fs.readdirSync(path.join(runtimeRoot, EXPECTED.version)), [
            'bifrost-model-parameters.json',
            'bifrost-pricing.json',
            'config.json',
        ]);
    } finally {
        if (launchedChild) await terminate(launchedChild);
        await terminate(frontdoorChild);
        await new Promise(resolve => backend.close(() => resolve()));
    }
});
}
