#!/usr/bin/env node
'use strict';

// Real keepalive subprocess + loopback HTTP peers; never production state or provider traffic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { createLocalHopAuth } = require('../routing/lib/local-hop-auth.js');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = path.resolve(process.env.KEEPALIVE_TEST_SCRATCH
    || (process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch')
        : path.join(os.homedir(), '.cache/hermes/scratch')));
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = SCRATCH;
fs.mkdirSync(SCRATCH, { recursive: true });
const RUN = fs.mkdtempSync(path.join(SCRATCH, 'ar-sol-keepalive-'));
const SCRIPT = path.resolve(process.env.KEEPALIVE_TEST_SCRIPT || path.join(ROOT, 'routing/keepalive-proxy.js'));
const RECEIPT = path.resolve(process.env.KEEPALIVE_TEST_RECEIPT || path.join(RUN, 'acceptance.json'));
assert.ok(RECEIPT.startsWith(SCRATCH + path.sep), 'receipt must stay in Hermes scratch');
const children = new Set();
const evidence = { script: SCRIPT, scratch: SCRATCH, run: RUN, receipt: RECEIPT,
    argv: process.argv.slice(2), fixtures: [], selftests: [] };
process.on('exit', () => {
    for (const child of children) child.kill();
    fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
    fs.writeFileSync(RECEIPT, JSON.stringify(evidence, null, 2) + '\n');
});
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
console.log(`AgentRouter Sol keepalive receipt: ${RECEIPT}`);

const SOL = ['gpt-6.1-sol', 'gpt-5.6-sol'];
const FALLBACK = 'deepseek-v4-flash';
const POOL_BODY = { error: { message: 'Budget pool quota has been exhausted. Please ask an administrator to increase the limit or select another budget pool.' } };
const POOL_TEXT = JSON.stringify(POOL_BODY);
const MAP = { default: '', opus: SOL[0], sonnet: SOL[0], haiku: SOL[1], gpt: '' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}
async function freePort() {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}
function request(port, pathname, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({ host: '127.0.0.1', port, path: pathname, agent: false,
            method: raw ? 'POST' : 'GET', timeout: 8000,
            headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': raw.length } : {}), ...headers },
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json;
                try { json = JSON.parse(text); } catch { /* SSE */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('fixture response aborted')));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('fixture request deadline')));
        req.end(raw);
    });
}
async function terminate(child) {
    if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { child.kill('SIGTERM'); await exited; }
    finally { clearTimeout(timer); children.delete(child); }
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}
function sendMessage(res, model) {
    const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model,
        content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
        + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture generation complete' } })
        + event('content_block_stop', { index: 0 })
        + event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
        + event('message_stop', {}));
}

function writeGuard(file, dir, alias, ports) {
    fs.writeFileSync(file('guard.cjs'), `
'use strict';
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), dns = require('node:dns');
const root = ${JSON.stringify(dir.replace(/\\/g, '/').toLowerCase() + '/')};
const source = ${JSON.stringify(ROOT.replace(/\\/g, '/').toLowerCase() + '/')};
const alias = ${JSON.stringify(alias)};
const ports = new Set(${JSON.stringify(ports)});
const append = fs.appendFileSync.bind(fs);
function normalize(value) { return path.resolve(String(value)).replace(/\\\\/g, '/').toLowerCase(); }
function outside(value) {
    if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return false;
    const resolved = normalize(value);
    return resolved !== root.slice(0, -1) && !resolved.startsWith(root);
}
function violation(message) {
    append(${JSON.stringify(file('guard-violations.jsonl'))}, JSON.stringify({ message }) + '\\n');
    throw new Error(message);
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : net._normalizeArgs(args)[0];
    const host = String(options.host || 'localhost').toLowerCase();
    if (options.path || !['127.0.0.1', 'localhost', '::1', alias.toLowerCase()].includes(host)
            || !ports.has(Number(options.port))) violation('non-fixture socket blocked: ' + host + ':' + options.port);
    return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
    if (String(hostname).toLowerCase() !== alias.toLowerCase() || alias === '127.0.0.1') return lookup.apply(this, arguments);
    const cb = typeof options === 'function' ? options : callback;
    queueMicrotask(() => options && options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
};
function readAllowed(value) {
    if (!outside(value)) return true;
    const resolved = normalize(value);
    return resolved.startsWith(source) && /\\.(?:js|cjs)$/.test(resolved);
}
for (const name of ['readFileSync', 'readFile']) {
    const original = fs[name];
    fs[name] = function (value, ...args) {
        if (!readAllowed(value)) violation('outside state read blocked: ' + String(value));
        return original.call(this, value, ...args);
    };
}
for (const name of ['openSync', 'open']) {
    const original = fs[name];
    fs[name] = function (value, flags, ...args) {
        const writing = typeof flags === 'number' ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) : /[wa+]/.test(flags);
        if (writing ? outside(value) : !readAllowed(value)) violation('outside file open blocked: ' + String(value));
        return original.call(this, value, flags, ...args);
    };
}
for (const name of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'renameSync', 'rename', 'unlinkSync', 'unlink', 'mkdirSync', 'mkdir', 'rmSync', 'rm', 'chmodSync', 'linkSync']) {
    const original = fs[name];
    fs[name] = function (value, ...args) {
        if (outside(value) || ['renameSync', 'rename', 'linkSync'].includes(name) && outside(args[0])) violation('outside write blocked: ' + String(value));
        if (/modelmap|pool(?:drop|-drop|-status|-backup)/i.test(String(value))) {
            append(${JSON.stringify(file('map-writes.jsonl'))}, JSON.stringify({ operation: name, path: String(value) }) + '\\n');
        }
        return original.call(this, value, ...args);
    };
}
fs.writeFileSync(${JSON.stringify(file('startup-env.json'))}, JSON.stringify({
    home: require('node:os').homedir(), tmpdir: require('node:os').tmpdir(),
    tmp: process.env.TMP, temp: process.env.TEMP, tmpdirEnv: process.env.TMPDIR,
    paths: Object.fromEntries(['CONFIG_FILE', 'KEY_FILE', 'MODELMAP_FILE', 'KEEPALIVE_LOG_FILE', 'LATENCY_FILE', 'EVENTS_FILE', 'FAILDUMP_DIR', 'TOKEN_USAGE_FILE', 'ABUSE_HUB_LOCAL_HOP_KEY_FILE'].map(key => [key, process.env[key]]))
}));
`);
}

async function fixture(t, { config, env = {}, upstreamHost = '127.0.0.1', map = MAP, routesMap = map, key,
    reply = (req, res, body) => /gpt-.*-sol/.test(body.model) ? sendJson(res, 402, POOL_BODY) : sendMessage(res, body.model),
    dashboardReply } = {}) {
    const dir = fs.mkdtempSync(path.join(RUN, 'fixture-'));
    const file = name => path.join(dir, name);
    const home = file('home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const mapFile = file('fixture-modelmap.json');
    const routesFile = file('fixture-routes-modelmap.json');
    fs.writeFileSync(mapFile, JSON.stringify(map, null, 2) + '\n');
    fs.writeFileSync(routesFile, JSON.stringify(routesMap, null, 2) + '\n');
    const snapshots = [mapFile, routesFile].map(filename => ({ filename, bytes: fs.readFileSync(filename), mtime: fs.statSync(filename).mtimeMs }));
    const configFile = file('config.json');
    if (config !== undefined) fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    if (key !== undefined) fs.writeFileSync(file('absent-key.txt'), key);
    const record = { name: t.name, dir, upstreamHost, states: [], generations: [], responses: [], dashboard: [],
        sessions: [], maxConcurrent: 0, dashboardMapWrites: [] };
    evidence.fixtures.push(record);
    let active = 0;
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/models') {
            req.resume();
            return sendJson(res, 200, { data: [...SOL, FALLBACK, 'glm-5.3', 'claude-fixture', 'claude-opus-5'].map(id => ({ id })) });
        }
        if (req.url === '/logs') { req.resume(); return sendJson(res, 200, { ok: true }); }
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            record.generations.push({ method: req.method, path: req.url, body,
                fixtureAuthorization: req.headers.authorization || null });
            active += 1;
            record.maxConcurrent = Math.max(record.maxConcurrent, active);
            res.once('close', () => { active -= 1; });
            if (req.method !== 'POST' || !/^\/v1\/messages(?:\?|$)/.test(req.url)) return sendJson(res, 404, { error: 'unexpected fixture path' });
            reply(req, res, body, record.generations.length);
        });
    });
    const dashboard = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            record.dashboard.push({ method: req.method, path: req.url, body });
            if (dashboardReply) return dashboardReply(req, res, body);
            // A real pool-drop HTTP call has an observable scratch map effect, not merely a counter.
            if (req.method === 'POST' && req.url === '/__switch/api/routes/pool-drop') {
                for (const filename of [mapFile, routesFile]) {
                    const changed = { ...map, opus: body.fallback, sonnet: body.fallback };
                    fs.writeFileSync(filename, JSON.stringify(changed, null, 2) + '\n');
                    record.dashboardMapWrites.push(filename);
                }
            }
            sendJson(res, 200, { ok: true });
        });
    });
    const upstreamPort = await listen(upstream);
    const dashPort = await listen(dashboard);
    const port = await freePort();
    Object.assign(record, { port, upstreamPort, dashPort });
    writeGuard(file, dir, upstreamHost, [port, upstreamPort, dashPort]);
    const baseEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (/^(systemroot|windir|path|comspec|pathext)$/i.test(name)) baseEnv[name] = value;
    }
    Object.assign(baseEnv, {
        HOME: home, USERPROFILE: home, APPDATA: file('appdata'), LOCALAPPDATA: file('localappdata'),
        TMPDIR: SCRATCH, TEMP: SCRATCH, TMP: SCRATCH, NODE_OPTIONS: '',
        PORT: String(port), UPSTREAM: `http://${upstreamHost}:${upstreamPort}`,
        CONFIG_FILE: configFile, KEY_FILE: file('absent-key.txt'), SESSIONS_FILE: '',
        MODELMAP_FILE: mapFile, KEEPALIVE_LOG_FILE: file('keepalive.log'),
        LATENCY_FILE: file('latency.json'), EVENTS_FILE: file('events.json'), FAILDUMP_DIR: file('faildump'),
        TOKEN_USAGE_FILE: file('usage.jsonl'), ABUSE_HUB_LOCAL_HOP_KEY_FILE: file('local-hop.key'),
        PROXY_LOG_INGEST_URL: `http://127.0.0.1:${upstreamPort}/logs`,
        DASHBOARD_URL: `http://127.0.0.1:${dashPort}`, HAIKU_GPT_PROXY: `http://127.0.0.1:${upstreamPort}`,
        HAIKU_REMAP: '0', GPT_PROXY_FORCE: '0', LOCAL_EXACT_ADAPTER: '0',
        AUTOROTATE: '0', ROTATE_PROVIDER: 'ar', KEY_SPREAD: '0', PAID_SINGLE_KEY: '0', ALLOW_PAID_HEDGE: '0',
        HEDGE_MS: '0', MAX_HEDGES: '0', PRE_COMMIT_MS: '0', JSON_HOLD_MS: '0', HOLD_MS: '0',
        EMPTY_STREAM_MS: '0', CATALOG_TTL_MS: '0', MAX_ATTEMPTS: '3', RETRY_DELAY_MS: '20',
    });
    let child;
    async function start() {
        const session = { exited: false };
        record.sessions.push(session);
        child = spawn(process.execPath, ['--require', file('guard.cjs'), SCRIPT], {
            cwd: dir, env: { ...baseEnv, ...env, TMPDIR: SCRATCH, TEMP: SCRATCH, TMP: SCRATCH },
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
        const current = child;
        children.add(current);
        session.pid = current.pid;
        current.once('exit', (code, signal) => { session.exited = true; session.code = code; session.signal = signal; });
        let output = '';
        current.stdout.on('data', chunk => { output += chunk; fs.appendFileSync(file('stdout.log'), chunk); });
        current.stderr.on('data', chunk => { output += chunk; fs.appendFileSync(file('stderr.log'), chunk); });
        const deadline = Date.now() + 8000;
        while (!output.includes('listening on http')) {
            if (current.exitCode !== null || current.signalCode !== null) throw new Error(`fixture child exited: ${output}`);
            if (Date.now() > deadline) throw new Error(`fixture child readiness deadline: ${output}`);
            await sleep(20);
        }
        session.startupEnv = JSON.parse(fs.readFileSync(file('startup-env.json'), 'utf8'));
        assert.equal(path.resolve(session.startupEnv.home), home);
        for (const key of ['tmpdir', 'tmp', 'temp', 'tmpdirEnv']) assert.equal(path.resolve(session.startupEnv[key]), SCRATCH);
        for (const value of Object.values(session.startupEnv.paths)) assert.ok(path.resolve(value).startsWith(dir + path.sep));
    }
    t.after(async () => {
        if (child) await terminate(child);
        for (const server of [upstream, dashboard]) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        record.peersClosed = !upstream.listening && !dashboard.listening;
        record.guardViolations = fs.existsSync(file('guard-violations.jsonl'))
            ? fs.readFileSync(file('guard-violations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
        record.keepaliveMapWrites = fs.existsSync(file('map-writes.jsonl'))
            ? fs.readFileSync(file('map-writes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
        assert.deepEqual(record.guardViolations, [], 'all I/O must stay isolated even when keepalive catches errors');
        assert.ok(record.sessions.every(session => session.exited), 'all fixture keepalives must exit');
    });
    await start();
    const state = async () => {
        const response = await request(port, '/__state');
        assert.equal(response.status, 200);
        record.states.push(response.json);
        return response.json;
    };
    const ask = async (model, { headers, stream = true } = {}) => {
        const response = await request(port, '/v1/messages', { model, stream, max_tokens: 16,
            messages: [{ role: 'user', content: 'fixture only' }] }, headers);
        record.responses.push({ requested: model, ...response });
        return response;
    };
    const assertMapsUnchanged = () => {
        for (const before of snapshots) {
            assert.deepEqual(fs.readFileSync(before.filename), before.bytes, 'quota retirement must not rewrite either model map');
            assert.equal(fs.statSync(before.filename).mtimeMs, before.mtime, 'even an identical map rewrite is forbidden');
        }
        assert.deepEqual(record.dashboardMapWrites, []);
        assert.equal(fs.existsSync(file('map-writes.jsonl')), false, 'keepalive must not attempt a model-map write');
    };
    const routeHeaders = options => {
        const auth = createLocalHopAuth({ secretFile: file('local-hop.key') });
        return { [auth.headerName]: auth.token('frontdoor-to-keepalive'), ...options };
    };
    return { port, file, configFile, mapFile, routesFile, record, state, ask, routeHeaders, assertMapsUnchanged,
        restart: async () => { await terminate(child); await start(); },
        patch: patch => request(port, '/__config', patch) };
}

async function runSelftest(t, provider) {
    const dir = fs.mkdtempSync(path.join(RUN, 'selftest-'));
    const file = name => path.join(dir, name);
    const home = file('home');
    const tmp = file('tmp');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(file('fixture-modelmap.json'), '{}\n');
    writeGuard(file, dir, '127.0.0.1', []);
    const env = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (/^(systemroot|windir|path|comspec|pathext)$/i.test(name)) env[name] = value;
    }
    Object.assign(env, {
        HOME: home, USERPROFILE: home, APPDATA: file('appdata'), LOCALAPPDATA: file('localappdata'),
        TMPDIR: tmp, TEMP: tmp, TMP: tmp, NODE_OPTIONS: '',
        PORT: '0', UPSTREAM: 'http://127.0.0.1:9', ROTATE_PROVIDER: provider, AUTOROTATE: '0',
        CONFIG_FILE: file('config.json'), KEY_FILE: file('absent-key.txt'), SESSIONS_FILE: '',
        MODELMAP_FILE: file('fixture-modelmap.json'), KEEPALIVE_LOG_FILE: file('keepalive.log'),
        LATENCY_FILE: file('latency.json'), EVENTS_FILE: file('events.json'), FAILDUMP_DIR: file('faildump'),
        TOKEN_USAGE_FILE: file('usage.jsonl'), ABUSE_HUB_LOCAL_HOP_KEY_FILE: file('local-hop.key'),
        PROXY_LOG_INGEST_URL: 'http://127.0.0.1:9/logs', DASHBOARD_URL: 'http://127.0.0.1:9',
        HAIKU_GPT_PROXY: 'http://127.0.0.1:9', HAIKU_REMAP: '1', LOCAL_EXACT_ADAPTER: '0',
        PAID_SINGLE_KEY: '0', ALLOW_PAID_HEDGE: '0',
    });
    const args = ['--require', file('guard.cjs'), SCRIPT, 'selftest'];
    const record = { name: t.name, provider, dir, command: [process.execPath, ...args], environment: env };
    evidence.selftests.push(record);
    const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    record.pid = child.pid;
    record.stdout = '';
    record.stderr = '';
    child.stdout.on('data', chunk => { record.stdout += chunk; fs.appendFileSync(file('stdout.log'), chunk); });
    child.stderr.on('data', chunk => { record.stderr += chunk; fs.appendFileSync(file('stderr.log'), chunk); });
    t.after(() => terminate(child));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { [record.code, record.signal] = await once(child, 'exit'); }
    finally { clearTimeout(timer); children.delete(child); }
    record.exited = child.exitCode !== null || child.signalCode !== null;
    record.guardViolations = fs.existsSync(file('guard-violations.jsonl'))
        ? fs.readFileSync(file('guard-violations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
    record.startupEnv = JSON.parse(fs.readFileSync(file('startup-env.json'), 'utf8'));
    assert.equal(path.resolve(record.startupEnv.home), home);
    for (const name of ['tmpdir', 'tmp', 'temp', 'tmpdirEnv']) assert.equal(path.resolve(record.startupEnv[name]), tmp);
    for (const value of Object.values(record.startupEnv.paths)) assert.ok(path.resolve(value).startsWith(dir + path.sep));
    assert.equal(record.code, 0, `isolated keepalive selftest failed: ${record.stderr.slice(-3500)}`);
    assert.match(record.stdout, /selftest OK/);
    assert.deepEqual(record.guardViolations, [], 'selftest must not access owner state or attempt any socket');
    assert.equal(fs.existsSync(file('config.json')), false, 'selftest restores its originally absent fixture config');
}

test('canonical pool402 on Sol ignores stale saved and env fallback', async t => {
    const f = await fixture(t, { config: { v: 8, poolFallbackModel: FALLBACK, poolDeadMs: 3600000 },
        env: { POOL_FALLBACK_MODEL: 'glm-5.3', POOL_DEAD_MS: '7200000' } });
    await f.state();
    const response = await f.ask(SOL[0]);
    await sleep(100);
    await f.state();
    assert.deepEqual(f.record.generations.map(call => call.body.model), [SOL[0]],
        'AgentRouter quota errors must never substitute the requested Sol with a saved/env fallback');
    assert.equal(response.status, 402, 'client must see the actual pool402, not a fabricated fallback success');
    assert.equal(response.text, POOL_TEXT, 'preserve the actual upstream error body');
    assert.deepEqual(f.record.dashboard, [], 'quota retirement must not call dashboard pool-drop/map APIs');
    f.assertMapsUnchanged();
});

test('runtime API cannot re-enable AgentRouter quota fallback or dead memory', async t => {
    const f = await fixture(t);
    const before = await f.state();
    const patch = { poolFallbackModel: 'glm-5.3', poolDeadMs: 7200000, maxAttempts: 6, preCommitMs: 8000 };
    const response = await f.patch(patch);
    assert.equal(response.status, 200, 'unrelated runtime knobs remain editable');
    assert.equal(response.json.cfg.poolFallbackModel, '', 'API fallback opt-in must be rejected by AgentRouter policy');
    assert.equal(response.json.cfg.poolDeadMs, 0, 'API dead-memory opt-in must also remain retired');
    assert.equal(response.json.defaults.poolFallbackModel, '', 'recommendations must not advertise a retired fallback');
    assert.equal(response.json.defaults.poolDeadMs, 0);
    const after = await f.state();
    assert.deepEqual(after.cfg, { ...before.cfg, ...patch, poolFallbackModel: '', poolDeadMs: 0 });
    assert.equal(after.cfgVersion, 8, 'provider policy must never reset the config schema/version');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), { v: 8, ...after.cfg },
        'read back the exact API persistence, not merely its response');
    for (const model of SOL) {
        const result = await f.ask(model);
        assert.equal(result.status, 402);
        assert.equal(result.text, POOL_TEXT);
    }
    assert.deepEqual(f.record.generations.map(call => call.body.model), SOL);
    assert.deepEqual(f.record.dashboard, []);
    f.assertMapsUnchanged();
});

test('saved quota policy is retired across persistence and restart without resetting overrides', async t => {
    const knobs = { hedgeMs: 13000, maxAttempts: 7, maxHedges: 2, preCommitMs: 6000,
        upstreamTimeoutMs: 420000, holdMs: 65000, emptyStreamMs: 95000, retryBudgetMs: 100000,
        catalogTtlMs: 700000, jsonHoldMs: 12000, stallMs: 80000, visionBridge: true, visionModel: 'fixture-vision' };
    const saved = { v: 8, ...knobs, poolFallbackModel: FALLBACK, poolDeadMs: 3600000 };
    const f = await fixture(t, { config: saved, env: { POOL_FALLBACK_MODEL: 'glm-5.3', POOL_DEAD_MS: '7200000',
        MAX_ATTEMPTS: '10', MAX_HEDGES: '5', PRE_COMMIT_MS: '10000' } });
    const bytes = fs.readFileSync(f.configFile);
    const expected = { ...knobs, poolFallbackModel: '', poolDeadMs: 0 };
    const before = await f.state();
    assert.deepEqual(before.cfg, expected, 'startup retires only saved quota fields, not any unrelated saved override');
    assert.equal(before.defaults.maxHedges, 0, 'concurrent default-hedges policy survives');
    assert.equal(before.cfgVersion, 8);
    assert.deepEqual(fs.readFileSync(f.configFile), bytes, 'startup does not rewrite owner configuration to retire quota');
    assert.equal(fs.existsSync(`${f.configFile}.v8.bak`), false, 'quota retirement is not a full-config version migration');
    await f.restart();
    assert.deepEqual((await f.state()).cfg, expected, 'stale saved config stays harmless after a real subprocess restart');
    assert.deepEqual(fs.readFileSync(f.configFile), bytes);
    const response = await f.patch({ poolFallbackModel: 'claude-fixture', poolDeadMs: 86400000, hedgeMs: 14000 });
    assert.equal(response.status, 200);
    const persisted = { ...expected, hedgeMs: 14000 };
    assert.deepEqual((await f.state()).cfg, persisted);
    const persistedBytes = fs.readFileSync(f.configFile);
    assert.deepEqual(JSON.parse(persistedBytes), { v: 8, ...persisted });
    await f.restart();
    assert.deepEqual((await f.state()).cfg, persisted, 'accepted unrelated API overrides survive restart with retired quota policy');
    assert.deepEqual(fs.readFileSync(f.configFile), persistedBytes, 'restart must not re-save or archive the persisted configuration');
    assert.deepEqual(f.record.dashboard, []);
    f.assertMapsUnchanged();
});

test('provider identity retires quota for aliases and both AgentRouter upstreams', async t => {
    const identities = [
        { upstreamHost: '127.0.0.1', provider: 'ar' },
        { upstreamHost: 'localhost', provider: 'ar' },
        { upstreamHost: 'localhost', provider: 'agentrouter' },
        { upstreamHost: '127.0.0.1', provider: 'AGENTROUTER' },
        { upstreamHost: 'agentrouter.org', provider: '' },
        { upstreamHost: 'api.agentrouter.org', provider: '' },
        { upstreamHost: 'agentrouter.org', provider: 'go' },
        { upstreamHost: 'ps.air-outer.com', provider: '' },
        { upstreamHost: 'ps.air-outer.com', provider: 'go' },
    ];
    for (const identity of identities) {
        await t.test(`${identity.upstreamHost} provider=${identity.provider || '(inferred)'}`, async t => {
            const f = await fixture(t, { upstreamHost: identity.upstreamHost,
                env: { ROTATE_PROVIDER: identity.provider, AUTOROTATE: '0',
                    POOL_FALLBACK_MODEL: FALLBACK, POOL_DEAD_MS: '86400000' } });
            const response = await f.ask(SOL[1]);
            await sleep(50);
            assert.deepEqual(f.record.generations.map(call => call.body.model), [SOL[1]],
                'upstream/provider identity, never the rotation switch or model name, controls retirement');
            assert.equal(response.status, 402);
            assert.equal(response.text, POOL_TEXT);
            const state = await f.state();
            assert.equal(state.cfg.poolFallbackModel, '');
            assert.equal(state.cfg.poolDeadMs, 0);
            assert.equal(state.defaults.poolFallbackModel, '');
            assert.equal(state.defaults.poolDeadMs, 0);
            assert.equal(state.cfgVersion, 8);
            assert.equal(fs.existsSync(f.configFile), false, 'even stale env must not force a config write at clean startup');
            assert.deepEqual(f.record.dashboard, []);
            f.assertMapsUnchanged();
        });
    }
});

test('Sol IDs and trusted prefixed tier routes never acquire quota dead suppression', async t => {
    const f = await fixture(t, { env: { HAIKU_REMAP: '1', POOL_FALLBACK_MODEL: FALLBACK, POOL_DEAD_MS: '86400000' } });
    const cases = [];
    for (const model of SOL) {
        for (const suffix of ['', '[1m]', '[200k]']) {
            for (const prefix of ['', 'ar/', 'agentrouter/']) cases.push({ model: prefix + model + suffix });
        }
    }
    // Front-door consumes the actual prefix before keepalive; its trusted marker selects routes-map.
    cases.push({ model: 'claude-opus-5[1m]', expected: SOL[0], headers: f.routeHeaders({ 'x-route-prefixed': '1' }) });
    cases.push({ model: 'claude-haiku-4-5[200k]', expected: SOL[1], headers: f.routeHeaders({ 'x-route-prefixed': '1' }) });
    for (const entry of cases) {
        const response = await f.ask(entry.model, { headers: entry.headers });
        assert.equal(response.status, 402, `honest quota error for ${entry.model}`);
        assert.equal(response.text, POOL_TEXT);
        assert.equal(f.record.generations.at(-1).body.model, entry.expected || entry.model,
            'preserve exact wire ID for direct names; only existing explicit client tier/window mapping may normalize');
    }
    const response = await f.ask(SOL[0]);
    assert.equal(response.status, 402, 'a subsequent request must reach the same requested Sol again, not a dead-memory fallback');
    assert.deepEqual(f.record.generations.map(call => call.body.model), [...cases.map(entry => entry.expected || entry.model), SOL[0]]);
    const state = await f.state();
    assert.equal(state.events24h.pooldrop || 0, 0);
    assert.equal(state.stats.retries, 0, 'quota is not a transient retry');
    assert.deepEqual(f.record.dashboard, []);
    f.assertMapsUnchanged();
});

test('ordinary transient failures still retry the identical Sol model', async t => {
    for (const model of SOL) {
        await t.test(model, async t => {
            const f = await fixture(t, { env: { POOL_FALLBACK_MODEL: FALLBACK },
                reply: (req, res, body, attempt) => attempt < 3
                    ? sendJson(res, 503, { retryable: true, error: { message: 'temporarily overloaded' } })
                    : sendMessage(res, body.model) });
            const response = await f.ask(model);
            assert.equal(response.status, 200);
            assert.match(response.text, /fixture generation complete/);
            assert.deepEqual(f.record.generations.map(call => call.body.model), [model, model, model],
                'quota retirement must not disable same-model transient retries or change the model');
            const state = await f.state();
            assert.equal(state.stats.retries, 2);
            assert.equal(state.stats.hedges, 0);
            assert.equal(state.cfg.maxAttempts, 3);
            assert.deepEqual(f.record.dashboard, []);
            f.assertMapsUnchanged();
        });
    }
});

test('other-provider fallback and preemptive dead memory remain unchanged', async t => {
    const dead = 'claude-opus-5';
    const f = await fixture(t, { env: { ROTATE_PROVIDER: 'go', HAIKU_REMAP: '1' },
        config: { v: 8, poolFallbackModel: FALLBACK, poolDeadMs: 3600000 },
        map: { default: '', opus: dead, sonnet: dead, haiku: dead, gpt: '' },
        reply: (req, res, body) => body.model === dead || body.model === `${dead}[1m]`
            ? sendJson(res, 402, POOL_BODY) : sendMessage(res, body.model),
        dashboardReply: (req, res) => sendJson(res, 200, { ok: true }) });
    const before = await f.state();
    assert.equal(before.defaults.poolFallbackModel, FALLBACK);
    assert.equal(before.defaults.poolDeadMs, 900000);
    assert.equal(before.cfg.poolDeadMs, 3600000);
    const first = await f.ask('claude-opus-4-8[1m]');
    assert.equal(first.status, 200, 'non-AgentRouter providers retain the existing fallback');
    assert.match(first.text, /fixture generation complete/);
    const second = await f.ask(dead);
    assert.equal(second.status, 200);
    assert.deepEqual(f.record.generations.map(call => call.body.model), [`${dead}[1m]`, FALLBACK, FALLBACK],
        'non-AR dead memory must still normalize suffixes and preemptively avoid the failed model');
    await sleep(100);
    assert.deepEqual(f.record.dashboard, [{ method: 'POST', path: '/__switch/api/routes/pool-drop',
        body: { provider: 'go', model: `${dead}[1m]`, fallback: FALLBACK } }]);
    assert.equal((await f.state()).events24h.pooldrop, 1);
    f.assertMapsUnchanged();
    const response = await f.patch({ poolFallbackModel: 'glm-5.3', poolDeadMs: 7200000 });
    assert.equal(response.status, 200);
    assert.equal(response.json.cfg.poolFallbackModel, 'glm-5.3', 'non-AR API fallback remains editable');
    assert.equal(response.json.cfg.poolDeadMs, 7200000);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), { v: 8, ...response.json.cfg });
});

test('AgentRouter balance rotation changes only the fixture account and keeps the Sol model', async t => {
    for (const model of SOL) {
        await t.test(model, async t => {
            const f = await fixture(t, { env: { AUTOROTATE: '1' }, key: 'fixture-before',
                reply: (req, res, body) => req.headers.authorization === 'Bearer fixture-before'
                    ? sendJson(res, 402, { error: { message: 'Insufficient account balance' } })
                    : sendMessage(res, body.model),
                dashboardReply: (req, res) => {
                    fs.writeFileSync(f.file('absent-key.txt'), 'fixture-after');
                    sendJson(res, 200, { ok: true, email: 'fixture@example.invalid' });
                } });
            const response = await f.ask(model);
            assert.equal(response.status, 200);
            assert.match(response.text, /fixture generation complete/);
            assert.deepEqual(f.record.generations.map(call => call.body.model), [model, model]);
            assert.deepEqual(f.record.generations.map(call => call.fixtureAuthorization), ['Bearer fixture-before', 'Bearer fixture-after']);
            assert.deepEqual(f.record.dashboard, [{ method: 'POST', path: '/__switch/api/ar/rotate',
                body: { reason: 'out-of-balance', fromKey: 'fixture-before', needUsd: null, leftUsd: null } }]);
            assert.equal(fs.readFileSync(f.file('absent-key.txt'), 'utf8'), 'fixture-after', 'read back only the explicitly isolated account file');
            const state = await f.state();
            assert.equal(state.stats.rotations, 1);
            assert.equal(state.rotate.on, true);
            assert.equal(state.cfg.poolFallbackModel, '');
            assert.equal(state.events24h.pooldrop || 0, 0);
            f.assertMapsUnchanged();
        });
    }
});

test('late quota error remains an honest in-band SSE failure after precommit', async t => {
    const f = await fixture(t, { config: { v: 8, preCommitMs: 2000 }, env: { IDLE_MS: '100', POOL_FALLBACK_MODEL: FALLBACK },
        reply: (req, res) => {
            const timer = setTimeout(() => sendJson(res, 402, POOL_BODY), 2250);
            res.once('close', () => clearTimeout(timer));
        } });
    const response = await f.ask(SOL[0]);
    assert.equal(response.status, 200, 'precommit cannot rewrite the already committed HTTP status');
    assert.match(response.text, /event: ping/);
    const errors = response.text.split('\n\n').filter(event => event.startsWith('event: error\n'))
        .map(event => JSON.parse(event.split('\ndata: ')[1]));
    assert.deepEqual(errors, [{ type: 'error', ...POOL_BODY }], 'preserve the genuine quota error in-band, never synthesize a fallback answer');
    assert.doesNotMatch(response.text, /fixture generation complete|event: message_start|event: message_stop/);
    assert.deepEqual(f.record.generations.map(call => call.body.model), [SOL[0]]);
    const state = await f.state();
    assert.equal(state.events24h.precommit, 1);
    assert.equal(state.events24h.pooldrop || 0, 0);
    assert.equal(state.stats.retries, 0);
    assert.deepEqual(f.record.dashboard, []);
    f.assertMapsUnchanged();
});

test('explicit AgentRouter hedge opt-in still launches same-model parallel generations', async t => {
    const f = await fixture(t, { config: { v: 8, hedgeMs: 1000, maxHedges: 1, maxAttempts: 3 },
        reply: (req, res, body) => {
            const timer = setTimeout(() => sendMessage(res, body.model), 1300);
            res.once('close', () => clearTimeout(timer));
        } });
    const response = await f.ask(SOL[1]);
    assert.equal(response.status, 200);
    assert.match(response.text, /fixture generation complete/);
    assert.deepEqual(f.record.generations.map(call => call.body.model), [SOL[1], SOL[1]],
        'retired quota must not block an existing explicit ordinary hedge');
    assert.equal(f.record.maxConcurrent, 2);
    const state = await f.state();
    assert.equal(state.stats.hedges, 1);
    assert.equal(state.cfg.maxHedges, 1);
    assert.equal(state.defaults.maxHedges, 0);
    assert.deepEqual(f.record.dashboard, []);
    f.assertMapsUnchanged();
});

test('isolated selftest verifies AgentRouter retired quota internals', async t => {
    await runSelftest(t, 'ar');
});

test('isolated selftest preserves other-provider quota internals', async t => {
    await runSelftest(t, 'go');
});

test('non-AgentRouter identities retain fallback even for the same Sol ID', async t => {
    const identities = [
        { upstreamHost: '127.0.0.1', provider: 'go' },
        { upstreamHost: 'agentrouter.org.fixture.invalid', provider: 'go' },
        { upstreamHost: 'ps.air-outer.com.fixture.invalid', provider: 'go' },
        { upstreamHost: 'localhost', provider: 'ar-other' },
    ];
    for (const identity of identities) {
        await t.test(`${identity.upstreamHost} provider=${identity.provider}`, async t => {
            const f = await fixture(t, { upstreamHost: identity.upstreamHost,
                env: { ROTATE_PROVIDER: identity.provider, POOL_FALLBACK_MODEL: FALLBACK },
                dashboardReply: (req, res) => sendJson(res, 200, { ok: true }) });
            const response = await f.ask(SOL[0]);
            assert.equal(response.status, 200, 'retirement belongs to the provider, not a model-only exemption or hostname substring');
            assert.match(response.text, /fixture generation complete/);
            assert.deepEqual(f.record.generations.map(call => call.body.model), [SOL[0], FALLBACK]);
            await sleep(50);
            assert.deepEqual(f.record.dashboard, [{ method: 'POST', path: '/__switch/api/routes/pool-drop',
                body: { provider: identity.provider, model: SOL[0], fallback: FALLBACK } }]);
            const state = await f.state();
            assert.equal(state.cfg.poolFallbackModel, FALLBACK);
            assert.equal(state.cfg.poolDeadMs, 900000);
            assert.equal(state.defaults.poolFallbackModel, FALLBACK);
            f.assertMapsUnchanged();
        });
    }
});
