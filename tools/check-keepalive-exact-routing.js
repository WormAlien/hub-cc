'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROXY = path.join(ROOT, 'routing', 'keepalive-proxy.js');
const CONVERTER = path.join(ROOT, 'routing', 'custom-openai-proxy.js');
const TRANSPARENT = path.join(ROOT, 'routing', 'transparent-proxy.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-exact-routing-'));
const LOCAL_HOP_SECRET = path.join(TMP, 'abuse-hub-local-hop.key');
const localHopAuth = require(path.join(ROOT, 'routing', 'lib', 'local-hop-auth.js'))
    .createLocalHopAuth({ secretFile: LOCAL_HOP_SECRET });
const ROUTE_AUTH = localHopAuth.token('frontdoor-to-keepalive');
const EXACT_MODEL = 'gpt-5.6-sol[1m]';
const SUBSTITUTE_MODEL = 'deepseek-v4-flash';
const PRIMARY_KEY = 'fixture-primary-key';
const ROTATED_KEY = 'fixture-rotated-key';

function listen(server, port = 0) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
}

async function freePort() {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForProxy(port, child, stderr) {
    for (let i = 0; i < 100; i += 1) {
        if (child.exitCode !== null) throw new Error(`keepalive exited early: ${stderr()}`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/__keepalive/api/status`, {
                signal: AbortSignal.timeout(250),
            });
            if (response.ok) return;
        } catch { /* not ready */ }
        await wait(40);
    }
    throw new Error(`keepalive did not start: ${stderr()}`);
}

function requestBody(caseName) {
    const base = {
        model: ['message-stop-substring', 'stall'].includes(caseName)
            ? (caseName === 'message-stop-substring' ? 'Exact-message_stop-Model' : 'Exact-Stall-Model')
            : caseName.startsWith('echo-') ? 'Nested/Case-Sensitive-ID' : EXACT_MODEL,
        stream: !['empty-json', 'echo-json'].includes(caseName),
        max_tokens: 64,
        messages: [{ role: 'user', content: `exact route ${caseName}` }],
    };
    if (caseName === 'vision') {
        base.messages[0].content = [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
            { type: 'text', text: 'keep the image unchanged' },
        ];
    }
    if (caseName === 'thinking') {
        base.messages = [
            { role: 'user', content: 'think' },
            { role: 'assistant', content: [{ type: 'thinking', thinking: 'private', signature: 's'.repeat(96) }] },
            { role: 'user', content: 'continue' },
        ];
    }
    return base;
}

function send(port, caseName, timeoutMs = 8000) {
    const body = requestBody(caseName);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            resolve({ ...value, requestBody: body });
        };
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/v1/messages',
            timeout: timeoutMs,
            headers: {
                'content-type': 'application/json',
                'content-length': String(payload.length),
                'x-route-final': '1',
                'x-route-exact': '1',
                [localHopAuth.headerName]: ROUTE_AUTH,
                'x-fixture-case': caseName,
            },
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('aborted', () => finish({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
                aborted: true,
            }));
            res.on('error', () => finish({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
                aborted: true,
            }));
            res.on('end', () => finish({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
                aborted: false,
            }));
        });
        req.on('timeout', () => req.destroy(new Error('fixture request timed out')));
        req.on('error', error => {
            if (settled) return;
            reject(error);
        });
        req.end(payload);
    });
}

async function stopChild(child) {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        wait(2000),
    ]);
}

function successSse(model) {
    return [
        'event: message_start',
        `data: ${JSON.stringify({ type: 'message_start', message: { model, content: [] } })}`,
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
    ].join('\n');
}


async function verifyPreconnectRetry() {
    const attempts = [];
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            attempts.push({ body, headers: { ...req.headers } });
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(successSse(body.model));
        });
    });
    const upstreamPort = await listen(upstream);
    await new Promise(resolve => upstream.close(resolve));

    const proxyPort = await freePort();
    const configFile = path.join(TMP, 'preconnect-config.json');
    const keyFile = path.join(TMP, 'preconnect-key.txt');
    fs.writeFileSync(keyFile, PRIMARY_KEY + '\n', 'utf8');
    let child = null;
    let stderrText = '';
    try {
        child = spawn(process.execPath, [PROXY], {
            cwd: path.join(ROOT, 'routing'),
            env: {
                ...process.env,
                ABUSE_HUB_LOCAL_HOP_KEY_FILE: LOCAL_HOP_SECRET,
                HOME: TMP,
                USERPROFILE: TMP,
                PORT: String(proxyPort),
                UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
                KEY_FILE: keyFile,
                KEEPALIVE_LOG_FILE: path.join(TMP, 'preconnect.log'),
                CONFIG_FILE: configFile,
                LATENCY_FILE: path.join(TMP, 'preconnect-latency.json'),
                EVENTS_FILE: path.join(TMP, 'preconnect-events.json'),
                FAILDUMP_DIR: path.join(TMP, 'preconnect-faildump'),
                PAID_SINGLE_KEY: '1',
                MAX_ATTEMPTS: '2',
                MAX_HEDGES: '0',
                HEDGE_MS: '0',
                HOLD_MS: '0',
                EMPTY_STREAM_MS: '0',
                JSON_HOLD_MS: '0',
                PRE_COMMIT_MS: '0',
                STALL_MS: '0',
                CATALOG_TTL_MS: '0',
                RETRY_DELAY_MS: '100',
                RETRY_BUDGET_MS: '5000',
                UPSTREAM_TIMEOUT_MS: '2000',
                LOCAL_EXACT_ADAPTER: '0',
                MODEL_ECHO_INJECT: '0',
            },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        child.stderr.on('data', chunk => { stderrText += chunk.toString('utf8'); });
        await waitForProxy(proxyPort, child, () => stderrText.slice(-2000));
        const pending = send(proxyPort, 'preconnect');
        await wait(40);
        await listen(upstream, upstreamPort);
        const response = await pending;
        assert.equal(response.status, 200, response.body);
        assert.equal(attempts.length, 1, 'pre-connect failure must reach exactly one paid generation');
        assert.equal(attempts[0].body.model, EXACT_MODEL);
    } finally {
        await stopChild(child);
        if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    }
}

async function verifyConverterTopology() {
    const topologySource = fs.readFileSync(TRANSPARENT, 'utf8');
    assert.match(topologySource,
        /UPSTREAM:\s*KV_CONVERTER_URL[\s\S]{0,300}?LOCAL_EXACT_ADAPTER:\s*'1'/,
        'production KVOTUM keepalive spawn must identify its local custom-openai converter');
    const genericTopology = /async function customSpawnProxy\(provider\)[\s\S]*?async function customKillProxy/.exec(topologySource);
    assert.ok(genericTopology, 'generic Custom converter topology is missing');
    assert.match(genericTopology[0], /custom-openai-topology[\s\S]*?runtime\.keepaliveEnv/,
        'generic Custom keepalive must use the explicit generated custom-openai runtime config');
    const customRuntime = require(path.join(ROOT, 'routing', 'lib', 'custom-openai-topology.js')).buildRuntimeConfig({
        provider: { id: 'fixture', name: 'fixture', baseUrl: 'https://fixture.invalid/v1', modelMap: {} },
        keepalivePort: 31001, adapterPort: 31002, claudeDir: TMP,
        activeKeyFile: path.join(TMP, 'custom-topology-key.txt'),
        localHopSecretPath: LOCAL_HOP_SECRET,
    });
    assert.equal(customRuntime.keepaliveEnv.UPSTREAM, 'http://127.0.0.1:31002',
        'generic Custom keepalive must target its generated adapter');
    assert.equal(customRuntime.keepaliveEnv.LOCAL_EXACT_ADAPTER, '1',
        'generic Custom keepalive must explicitly identify its generated custom-openai adapter');
    const odysseyTopology = /async function odKeepaliveSpawn\(\)[\s\S]*?watchChildExit\(child, 'keepalive Odyssey'/.exec(topologySource);
    assert.ok(odysseyTopology, 'production Odyssey keepalive topology is missing');
    assert.match(odysseyTopology[0], /LOCAL_EXACT_ADAPTER:\s*'1'[\s\S]*?HAIKU_GPT_PROXY:\s*OD_CONVERTER_URL/,
        'production Odyssey keepalive must explicitly identify its custom-openai adapter');
    const a6Gateway = require(path.join(ROOT, 'routing', 'lib', 'a6api-gateway.js'));
    assert.equal(a6Gateway.buildRuntimeConfig({ secretDir: TMP, routingDir: path.join(ROOT, 'routing') }).keepaliveEnv.LOCAL_EXACT_ADAPTER, '1',
        'production A6API converter topology must explicitly identify its local custom-openai adapter');
    const generations = [];
    const vendor = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            generations.push({ body, headers: { ...req.headers } });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'chatcmpl_converter_topology',
                model: body.model,
                choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }));
        });
    });
    const vendorPort = await listen(vendor);
    const converterPort = await freePort();
    const proxyPort = await freePort();
    const model = 'DeepSeek/Nested/Case-Sensitive[1m]';
    const configFile = path.join(TMP, 'converter-topology.json');
    const keyFile = path.join(TMP, 'converter-topology-key.txt');
    fs.writeFileSync(keyFile, PRIMARY_KEY + '\n', 'utf8');
    fs.writeFileSync(configFile, JSON.stringify({
        port: converterPort,
        upstream: `http://127.0.0.1:${vendorPort}/v1`,
        keyFile,
        modelMap: {},
        providerName: 'KVOTUM-fixture',
        localHopSecretPath: LOCAL_HOP_SECRET,
    }) + '\n', 'utf8');
    let converter = null;
    let keepalive = null;
    let converterStderr = '';
    let keepaliveStderr = '';
    try {
        converter = spawn(process.execPath, [CONVERTER, configFile], {
            cwd: path.join(ROOT, 'routing'),
            env: { ...process.env, HOME: TMP, USERPROFILE: TMP, PORT: String(converterPort) },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        converter.stderr.on('data', chunk => { converterStderr += chunk.toString('utf8'); });
        for (let i = 0; i < 100; i += 1) {
            if (converter.exitCode !== null) throw new Error(`converter exited early: ${converterStderr}`);
            try {
                const response = await fetch(`http://127.0.0.1:${converterPort}/health`, { signal: AbortSignal.timeout(250) });
                if (response.ok) break;
            } catch { /* not ready */ }
            if (i === 99) throw new Error(`converter did not start: ${converterStderr}`);
            await wait(40);
        }
        keepalive = spawn(process.execPath, [PROXY], {
            cwd: path.join(ROOT, 'routing'),
            env: {
                ...process.env,
                ABUSE_HUB_LOCAL_HOP_KEY_FILE: LOCAL_HOP_SECRET,
                HOME: TMP,
                USERPROFILE: TMP,
                PORT: String(proxyPort),
                UPSTREAM: `http://127.0.0.1:${converterPort}`,
                KEY_FILE: keyFile,
                KEEPALIVE_LOG_FILE: path.join(TMP, 'converter-topology.log'),
                CONFIG_FILE: path.join(TMP, 'converter-topology-keepalive.json'),
                LATENCY_FILE: path.join(TMP, 'converter-topology-latency.json'),
                EVENTS_FILE: path.join(TMP, 'converter-topology-events.json'),
                FAILDUMP_DIR: path.join(TMP, 'converter-topology-faildump'),
                PAID_SINGLE_KEY: '0',
                LOCAL_EXACT_ADAPTER: '1',
                MAX_ATTEMPTS: '1',
                MAX_HEDGES: '0',
                HEDGE_MS: '0',
                HOLD_MS: '0',
                EMPTY_STREAM_MS: '0',
                JSON_HOLD_MS: '0',
                PRE_COMMIT_MS: '0',
                STALL_MS: '0',
                CATALOG_TTL_MS: '0',
                UPSTREAM_TIMEOUT_MS: '3000',
                MODEL_ECHO_INJECT: '0',
            },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        keepalive.stderr.on('data', chunk => { keepaliveStderr += chunk.toString('utf8'); });
        await waitForProxy(proxyPort, keepalive, () => keepaliveStderr.slice(-2000));
        const response = await new Promise((resolve, reject) => {
            const body = Buffer.from(JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'production-shaped converter exactness' }] }), 'utf8');
            const req = http.request({
                hostname: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/messages', timeout: 5000,
                headers: {
                    'content-type': 'application/json',
                    'content-length': String(body.length),
                    'x-route-final': '1',
                    'x-route-exact': '1',
                    [localHopAuth.headerName]: ROUTE_AUTH,
                },
            }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            });
            req.on('timeout', () => req.destroy(new Error('converter topology request timed out')));
            req.on('error', reject);
            req.end(body);
        });
        assert.equal(response.status, 200, response.body);
        assert.equal(generations.length, 1, 'converter topology must start one vendor generation');
        assert.equal(generations[0].body.model, model, 'production-shaped converter topology changed exact model bytes');
        assert.equal(generations[0].headers['x-abuse-hub-local-exact'], undefined, 'trusted local exact marker reached vendor');
        assert.equal(generations[0].headers['x-route-exact'], undefined, 'route exact marker reached vendor');
    } finally {
        await stopChild(keepalive);
        await stopChild(converter);
        await new Promise(resolve => vendor.close(resolve));
    }
}

(async () => {
    await verifyConverterTopology();
    await verifyPreconnectRetry();
    const attempts = new Map();
    const generationStarts = new Map();
    const active = new Map();
    const maxActive = new Map();
    const dashboardPaths = [];
    let catalogHits = 0;
    let stallUpstreamClosed = false;
    const keyFile = path.join(TMP, 'active-key.txt');
    fs.writeFileSync(keyFile, PRIMARY_KEY + '\n', 'utf8');

    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/models') {
            catalogHits += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: SUBSTITUTE_MODEL }] }));
            return;
        }
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch (error) { res.writeHead(400); res.end(error.message); return; }
            const caseName = String(req.headers['x-fixture-case'] || 'unknown');
            const rows = attempts.get(caseName) || [];
            const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            rows.push({ body, headers: { ...req.headers }, auth, startedAt: Date.now() });
            attempts.set(caseName, rows);
            if (!(caseName === 'rotate' && auth === PRIMARY_KEY)) {
                generationStarts.set(caseName, (generationStarts.get(caseName) || 0) + 1);
            }
            const nowActive = (active.get(caseName) || 0) + 1;
            active.set(caseName, nowActive);
            maxActive.set(caseName, Math.max(maxActive.get(caseName) || 0, nowActive));
            let closed = false;
            const done = () => {
                if (closed) return;
                closed = true;
                active.set(caseName, Math.max(0, (active.get(caseName) || 1) - 1));
            };
            res.once('close', done);
            res.once('finish', done);

            const jsonError = (status, message, type = 'api_error') => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ type: 'error', error: { type, message } }));
            };
            const sse = () => {
                if (res.destroyed || res.writableEnded) return;
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(successSse(body.model));
            };

            if (caseName === 'model-miss') {
                setTimeout(() => jsonError(503, 'No available channel: model_not_found', 'model_not_found'), 25);
            } else if (caseName === 'quota') {
                jsonError(402, 'Budget pool quota has been exhausted.');
            } else if (caseName === 'slow') {
                setTimeout(sse, 80);
            } else if (caseName === 'vision') {
                sse();
            } else if (caseName === 'truncated') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end([
                    'event: content_block_start',
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
                    '',
                    'event: content_block_delta',
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
                    '',
                    '',
                ].join('\n'));
            } else if (caseName === 'message-stop-substring') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end([
                    'event: message_start',
                    `data: ${JSON.stringify({ type: 'message_start', message: { model: body.model, content: [] } })}`,
                    '',
                    'event: content_block_delta',
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"text mentions message_stop but is incomplete"}}',
                    '',
                    'event: content_block_start',
                    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_message_stop","name":"tool_message_stop","input":{}}}',
                    '',
                    'event: content_block_delta',
                    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"value\\":\\"message_stop\\"}"}}',
                    '',
                    '',
                ].join('\n'));
            } else if (caseName === 'stall') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write([
                    'event: content_block_start',
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
                    '',
                    'event: content_block_delta',
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial before stall"}}',
                    '',
                    '',
                ].join('\n'));
                const markClosed = () => { stallUpstreamClosed = true; };
                req.once('aborted', markClosed);
                req.socket.once('close', markClosed);
            } else if (caseName === 'empty') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end();
            } else if (caseName === 'empty-json') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end();
            } else if (caseName === 'echo-json') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ type: 'message', model: 'vendor-internal-model', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
            } else if (caseName === 'echo-sse') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(successSse('vendor-internal-model'));
            } else if (caseName === 'thinking') {
                const hasThinking = body.messages.some(message => Array.isArray(message.content)
                    && message.content.some(block => block && block.type === 'thinking'));
                if (hasThinking) jsonError(400, 'Invalid signature in thinking block', 'invalid_request_error');
                else sse();
            } else if (caseName === 'transport' && rows.length === 1) {
                req.socket.destroy();
            } else if (caseName === 'retryable-5xx') {
                res.writeHead(503, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ retryable: true, error: { type: 'api_error', message: 'accepted generation failed later' } }));
            } else if (caseName === 'transport-headers') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n');
                req.socket.destroy();
            } else if (caseName === 'rotate' && auth === PRIMARY_KEY) {
                jsonError(403, 'Insufficient account balance.');
            } else {
                sse();
            }
        });
    });
    const upstreamPort = await listen(upstream);

    const dashboard = http.createServer((req, res) => {
        dashboardPaths.push(req.url);
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            if (req.url === '/__switch/api/fixture/rotate') {
                fs.writeFileSync(keyFile, ROTATED_KEY + '\n', 'utf8');
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, email: 'fixture-account' }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'fixture refuses pool mutation' }));
        });
    });
    const dashboardPort = await listen(dashboard);

    const proxyPort = await freePort();
    const modelMap = path.join(TMP, 'hostile-modelmap.json');
    fs.writeFileSync(modelMap, JSON.stringify({
        default: SUBSTITUTE_MODEL,
        opus: SUBSTITUTE_MODEL,
        sonnet: SUBSTITUTE_MODEL,
        haiku: SUBSTITUTE_MODEL,
        gpt: SUBSTITUTE_MODEL,
    }, null, 2) + '\n', 'utf8');
    let child = null;
    let stderrText = '';
    try {
        child = spawn(process.execPath, [PROXY], {
            cwd: path.join(ROOT, 'routing'),
            env: {
                ...process.env,
                ABUSE_HUB_LOCAL_HOP_KEY_FILE: LOCAL_HOP_SECRET,
                HOME: TMP,
                USERPROFILE: TMP,
                PORT: String(proxyPort),
                UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
                MODELMAP_FILE: modelMap,
                KEEPALIVE_LOG_FILE: path.join(TMP, 'keepalive.log'),
                CONFIG_FILE: path.join(TMP, 'keepalive-config.json'),
                LATENCY_FILE: path.join(TMP, 'latency.json'),
                EVENTS_FILE: path.join(TMP, 'events.json'),
                FAILDUMP_DIR: path.join(TMP, 'faildump'),
                KEY_FILE: keyFile,
                ROTATE_PROVIDER: 'fixture',
                DASHBOARD_URL: `http://127.0.0.1:${dashboardPort}`,
                PAID_SINGLE_KEY: '0',
                AUTOROTATE: '1',
                MAX_ROTATIONS: '2',
                HAIKU_GPT_PROXY: '',
                GPT_PROXY_FORCE: '0',
                HAIKU_TO_MODEL: SUBSTITUTE_MODEL,
                POOL_FALLBACK_MODEL: SUBSTITUTE_MODEL,
                VISION_BRIDGE: '1',
                HEDGE_MS: '10',
                MAX_HEDGES: '2',
                MAX_ATTEMPTS: '3',
                PRE_COMMIT_MS: '0',
                HOLD_MS: '0',
                EMPTY_STREAM_MS: '0',
                JSON_HOLD_MS: '0',
                STALL_MS: '150',
                CATALOG_TTL_MS: '600000',
                RETRY_DELAY_MS: '10',
                RETRY_FAST_FAIL_MS: '0',
                RETRY_BUDGET_MS: '10000',
                UPSTREAM_TIMEOUT_MS: '3000',
                COUNT_TOKENS_FALLBACK: '0',
                THINK_STRIP: '1',
                UPSTREAM_NOSTREAM: '0',
                MODEL_ECHO_INJECT: '0',
            },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        child.stderr.on('data', chunk => { stderrText += chunk.toString('utf8'); });
        await waitForProxy(proxyPort, child, () => stderrText.slice(-2000));
        for (let i = 0; i < 100 && catalogHits === 0; i += 1) await wait(20);
        assert.ok(catalogHits > 0, 'hostile catalog did not arm');
        const catalogBaseline = catalogHits;

        const responses = {};
        for (const caseName of ['model-miss', 'quota', 'slow', 'vision', 'truncated', 'message-stop-substring', 'empty', 'empty-json', 'echo-json', 'echo-sse', 'thinking', 'transport', 'retryable-5xx', 'rotate']) {
            responses[caseName] = await send(proxyPort, caseName);
        }
        const stallStarted = Date.now();
        responses.stall = await send(proxyPort, 'stall', 35000);
        const stallElapsedMs = Date.now() - stallStarted;

        assert.equal(responses['model-miss'].status, 503, responses['model-miss'].body);
        assert.ok(responses['retryable-5xx'].status >= 500, responses['retryable-5xx'].body);
        assert.equal(responses.quota.status, 402, responses.quota.body);
        for (const caseName of ['slow', 'vision', 'echo-sse', 'rotate']) {
            assert.equal(responses[caseName].status, 200, `${caseName}: ${responses[caseName].body}`);
            assert.match(responses[caseName].body, /"type":"message_stop"/, `${caseName} lacks real terminal event`);
        }
        assert.equal(responses['echo-json'].status, 200, responses['echo-json'].body);
        assert.equal(JSON.parse(responses['echo-json'].body).model, 'vendor-internal-model',
            'exact JSON response must bypass keepalive model echo mutation');
        assert.match(responses['echo-sse'].body, /"model":"vendor-internal-model"/,
            'exact SSE response must bypass keepalive model echo mutation');
        assert.doesNotMatch(responses['echo-sse'].body, /"model":"Nested\/Case-Sensitive-ID(?:\[1m\])?"/,
            'exact SSE response must not inject or echo the request model');
        assert.ok(responses.transport.status >= 500, responses.transport.body);
        assert.equal(responses['retryable-5xx'].status, 503, responses['retryable-5xx'].body);
        assert.equal(responses.thinking.status, 400, responses.thinking.body);

        for (const caseName of ['truncated', 'message-stop-substring', 'empty', 'empty-json']) {
            assert.equal(responses[caseName].status, 200, `${caseName}: headers must come from the real upstream response`);
            assert.equal(responses[caseName].aborted, true, `${caseName}: exact incomplete response must abort downstream`);
            assert.doesNotMatch(responses[caseName].body, /"type":"message_stop"|"type":"message_delta"|"type":"error"/,
                `${caseName}: exact mode must not synthesize a terminal or error event`);
        }
        assert.doesNotMatch(responses.truncated.body, /"type":"content_block_stop"/,
            'exact truncated stream must not synthesize content_block_stop');
        for (let i = 0; i < 20 && !stallUpstreamClosed; i += 1) await wait(25);
        assert.equal(responses.stall.status, 200, 'stall: headers must come from the real upstream response');
        assert.equal(responses.stall.aborted, true, 'stall: exact incomplete response must abort downstream');
        assert.match(responses.stall.body, /partial before stall/, 'stall: real upstream partial content was lost');
        assert.doesNotMatch(responses.stall.body, /event:\s*error|"type":"error"|"type":"message_stop"|"type":"message_delta"/,
            'stall: exact mode must not synthesize error or terminal framing');
        assert.equal(stallUpstreamClosed, true, 'stall: exact guard must destroy the stalled upstream socket');
        assert.ok(stallElapsedMs < 3000, `stall: exact guard did not fire promptly (${stallElapsedMs}ms)`);

        const expectedCounts = {
            'model-miss': 1,
            quota: 1,
            slow: 1,
            vision: 1,
            truncated: 1,
            'message-stop-substring': 1,
            empty: 1,
            'empty-json': 1,
            'echo-json': 1,
            'echo-sse': 1,
            thinking: 1,
            transport: 1,
            'retryable-5xx': 1,
            stall: 1,
            rotate: 2,
        };
        for (const [caseName, count] of Object.entries(expectedCounts)) {
            const rows = attempts.get(caseName) || [];
            assert.equal(rows.length, count, `${caseName}: unexpected attempts ${JSON.stringify(rows)}`);
            assert.equal(maxActive.get(caseName), 1, `${caseName}: exact attempts must never overlap`);
            for (const row of rows) {
                assert.equal(row.body.model, requestBody(caseName).model, `${caseName}: exact model changed`);
                assert.equal(row.headers['x-route-final'], undefined, `${caseName}: x-route-final reached vendor`);
                assert.equal(row.headers['x-route-exact'], undefined, `${caseName}: x-route-exact reached vendor`);
            }
        }

        assert.equal(generationStarts.get('transport'), 1,
            'body-received reset must not start a second paid generation');
        assert.equal(generationStarts.get('retryable-5xx'), 1,
            'retryable exact 5xx must not start a second paid generation');
        assert.equal(generationStarts.get('rotate'), 1,
            'pre-generation balance rejection must not count as an accepted generation');
        assert.deepEqual(attempts.get('transport').map(row => row.body), [requestBody('transport')],
            'body-received transport loss must stop after the accepted exact body');
        assert.deepEqual(attempts.get('rotate').map(row => row.body), [requestBody('rotate'), requestBody('rotate')],
            'same-provider account rotation must preserve the exact body');
        assert.deepEqual(attempts.get('rotate').map(row => row.auth), [PRIMARY_KEY, ROTATED_KEY],
            'same-provider account rotation must remain enabled');
        assert.deepEqual(attempts.get('vision')[0].body, requestBody('vision'),
            'exact route must not replace an image through the vision bridge');
        assert.deepEqual(attempts.get('thinking')[0].body, requestBody('thinking'),
            'exact route must not heal and replay a thinking-signature rejection');
        assert.equal(catalogHits, catalogBaseline, 'exact route must not refresh the catalog after model_not_found');
        assert.deepEqual(dashboardPaths, ['/__switch/api/fixture/rotate'],
            'only same-provider account rotation may call the dashboard; 402 must not mutate the model map');
        assert.equal(stderrText.includes(`подмена модели`), false, 'exact route armed model substitution');

        console.log('check-keepalive-exact-routing: PASS');
    } finally {
        await stopChild(child);
        await new Promise(resolve => upstream.close(resolve));
        await new Promise(resolve => dashboard.close(resolve));
        fs.rmSync(TMP, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
