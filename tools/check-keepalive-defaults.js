#!/usr/bin/env node
'use strict';

// Local HTTP acceptance: no lifecycle calls, live providers, or owner state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = process.env.KEEPALIVE_TEST_SCRATCH
    || (process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch')
        : path.join(os.homedir(), '.cache/hermes/scratch'));
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = SCRATCH;
fs.mkdirSync(SCRATCH, { recursive: true });
const RUN = fs.mkdtempSync(path.join(SCRATCH, 'keepalive-defaults-'));
const SCRIPT = process.env.KEEPALIVE_TEST_SCRIPT || path.join(ROOT, 'routing/keepalive-proxy.js');
const RECEIPT = process.env.KEEPALIVE_TEST_RECEIPT || path.join(RUN, 'acceptance.json');
const children = new Set();
const evidence = { script: SCRIPT, scratch: SCRATCH, run: RUN, fixtures: [] };
process.on('exit', () => {
    for (const child of children) child.kill();
    fs.writeFileSync(RECEIPT, JSON.stringify(evidence, null, 2) + '\n');
});

const DEFAULTS = {
    hedgeMs: 20000, maxAttempts: 3, maxHedges: 0, preCommitMs: 10000,
    visionBridge: false, visionModel: 'deepseek-v4-flash', upstreamTimeoutMs: 300000,
    holdMs: 120000, emptyStreamMs: 180000, retryBudgetMs: 90000, catalogTtlMs: 600000,
    jsonHoldMs: 15000, stallMs: 180000, poolFallbackModel: 'deepseek-v4-flash', poolDeadMs: 900000,
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = async server => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
};
async function freePort() {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}
function request(port, pathname, body) {
    return new Promise((resolve, reject) => {
        const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({ host: '127.0.0.1', port, path: pathname, agent: false,
            method: raw ? 'POST' : 'GET', timeout: 3000,
            headers: raw ? { 'content-type': 'application/json', 'content-length': raw.length } : {},
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json;
                try { json = JSON.parse(text); } catch { /* SSE */ }
                resolve({ status: res.statusCode, text, json });
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
function sendJson(res, body) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

async function fixture(t, { config, env = {}, upstreamHost = '127.0.0.1', replyDelayMs } = {}) {
    const dir = fs.mkdtempSync(path.join(RUN, 'fixture-'));
    const file = name => path.join(dir, name);
    const home = file('home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(file('fixture-modelmap.json'), '{}\n');
    const configFile = file('config.json');
    if (config !== undefined) fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    const record = { name: t.name, dir, states: [], calls: [], childExited: false, maxConcurrent: 0 };
    evidence.fixtures.push(record);
    let active = 0;
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/models') { req.resume(); return sendJson(res, { data: [{ id: 'claude-fixture' }] }); }
        if (req.url === '/logs') { req.resume(); return sendJson(res, { ok: true }); }
        if (req.method === 'POST' && req.url === '/v1/messages' && replyDelayMs !== undefined) {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                record.calls.push({ method: req.method, path: req.url, body });
                active += 1;
                record.maxConcurrent = Math.max(record.maxConcurrent, active);
                res.once('close', () => { active -= 1; });
                const timer = setTimeout(() => {
                    if (res.destroyed) return;
                    const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.end(event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
                        content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
                        + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
                        + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture generation complete' } })
                        + event('content_block_stop', { index: 0 })
                        + event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
                        + event('message_stop', {}));
                }, replyDelayMs);
                res.once('close', () => clearTimeout(timer));
            });
            return;
        }
        req.resume();
        record.calls.push({ method: req.method, path: req.url });
        res.writeHead(404); res.end('fixture path not implemented');
    });
    const upstreamPort = await listen(upstream);
    const port = await freePort();
    record.port = port;
    record.upstreamPort = upstreamPort;
    // Map a paid hostname only inside this child; never resolve or contact it remotely.
    // Also fail on any non-fixture socket, sensitive owner read, or outside write.
    fs.writeFileSync(file('guard.cjs'), `
'use strict';
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), dns = require('node:dns');
const root = ${JSON.stringify(dir.replace(/\\/g, '/').toLowerCase() + '/')};
const alias = ${JSON.stringify(upstreamHost)};
const ports = new Set(${JSON.stringify([port, upstreamPort])});
const append = fs.appendFileSync.bind(fs);
function violation(message) {
    append(${JSON.stringify(file('guard-violations.jsonl'))}, JSON.stringify({ message }) + '\\n');
    throw new Error(message);
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : net._normalizeArgs(args)[0];
    const host = String(options.host || 'localhost').toLowerCase();
    if (options.path || !['127.0.0.1', 'localhost', '::1', alias].includes(host) || !ports.has(Number(options.port))) {
        violation('non-fixture socket blocked: ' + host + ':' + options.port);
    }
    return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
    if (hostname !== alias || alias === '127.0.0.1') return lookup.apply(this, arguments);
    const cb = typeof options === 'function' ? options : callback;
    queueMicrotask(() => options && options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
};
function outside(value) {
    if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return false;
    const resolved = path.resolve(String(value)).replace(/\\\\/g, '/').toLowerCase();
    return resolved !== root.slice(0, -1) && !resolved.startsWith(root);
}
for (const name of ['readFileSync', 'readFile', 'openSync', 'open']) {
    const original = fs[name];
    fs[name] = function (value, ...args) {
        if (outside(value) && /(?:active-key\\.txt|keys\\.json|sessions\\.json|[\\\\/]\\.secrets[\\\\/]|[\\\\/]\\.claude[\\\\/])/i.test(String(value))) {
            violation('sensitive owner read blocked');
        }
        return original.call(this, value, ...args);
    };
}
for (const name of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'renameSync', 'unlinkSync', 'mkdirSync', 'rmSync', 'chmodSync', 'linkSync']) {
    const original = fs[name];
    fs[name] = function (value, ...args) {
        if (outside(value) || ['renameSync', 'linkSync'].includes(name) && outside(args[0])) violation('outside write blocked');
        return original.call(this, value, ...args);
    };
}
fs.writeFileSync(${JSON.stringify(file('startup-env.json'))}, JSON.stringify({
    home: require('node:os').homedir(), tmpdir: require('node:os').tmpdir(),
    tmp: process.env.TMP, temp: process.env.TEMP, tmpdirEnv: process.env.TMPDIR,
    paths: Object.fromEntries(['CONFIG_FILE', 'KEY_FILE', 'MODELMAP_FILE', 'KEEPALIVE_LOG_FILE', 'LATENCY_FILE', 'EVENTS_FILE', 'FAILDUMP_DIR', 'TOKEN_USAGE_FILE', 'ABUSE_HUB_LOCAL_HOP_KEY_FILE'].map(key => [key, process.env[key]]))
}));
`);
    const baseEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (/^(systemroot|windir|path|comspec|pathext)$/i.test(name)) baseEnv[name] = value;
    }
    Object.assign(baseEnv, {
        HOME: home, USERPROFILE: home, APPDATA: file('appdata'), LOCALAPPDATA: file('localappdata'),
        TMPDIR: SCRATCH, TEMP: SCRATCH, TMP: SCRATCH, NODE_OPTIONS: '',
        PORT: String(port), UPSTREAM: `http://${upstreamHost}:${upstreamPort}`,
        CONFIG_FILE: configFile, KEY_FILE: file('absent-key.txt'), SESSIONS_FILE: '',
        MODELMAP_FILE: file('fixture-modelmap.json'), KEEPALIVE_LOG_FILE: file('keepalive.log'),
        LATENCY_FILE: file('latency.json'), EVENTS_FILE: file('events.json'), FAILDUMP_DIR: file('faildump'),
        TOKEN_USAGE_FILE: file('usage.jsonl'), ABUSE_HUB_LOCAL_HOP_KEY_FILE: file('local-hop.key'),
        PROXY_LOG_INGEST_URL: `http://127.0.0.1:${upstreamPort}/logs`,
        DASHBOARD_URL: `http://127.0.0.1:${upstreamPort}`, HAIKU_GPT_PROXY: `http://127.0.0.1:${upstreamPort}`,
        HAIKU_REMAP: '0', GPT_PROXY_FORCE: '0', LOCAL_EXACT_ADAPTER: '0',
        AUTOROTATE: '0', ROTATE_PROVIDER: '', KEY_SPREAD: '0', PAID_SINGLE_KEY: '0', ALLOW_PAID_HEDGE: '0',
    });
    const child = spawn(process.execPath, ['--require', file('guard.cjs'), SCRIPT], {
        cwd: dir, env: { ...baseEnv, ...env, TMPDIR: SCRATCH, TEMP: SCRATCH, TMP: SCRATCH },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    children.add(child);
    record.pid = child.pid;
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; fs.appendFileSync(file('stdout.log'), chunk); });
    child.stderr.on('data', chunk => { output += chunk; fs.appendFileSync(file('stderr.log'), chunk); });
    t.after(async () => {
        await terminate(child);
        record.childExited = child.exitCode !== null || child.signalCode !== null;
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
        record.upstreamClosed = !upstream.listening;
        record.guardViolations = fs.existsSync(file('guard-violations.jsonl'))
            ? fs.readFileSync(file('guard-violations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
        assert.deepEqual(record.guardViolations, [], 'all I/O must stay isolated even if production catches an error');
    });
    const deadline = Date.now() + 8000;
    while (!output.includes('listening on http')) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`fixture child exited: ${output}`);
        if (Date.now() > deadline) throw new Error(`fixture child readiness deadline: ${output}`);
        await sleep(20);
    }
    record.startupEnv = JSON.parse(fs.readFileSync(file('startup-env.json'), 'utf8'));
    assert.equal(path.resolve(record.startupEnv.home), home);
    for (const key of ['tmpdir', 'tmp', 'temp', 'tmpdirEnv']) assert.equal(path.resolve(record.startupEnv[key]), path.resolve(SCRATCH));
    for (const value of Object.values(record.startupEnv.paths)) assert.equal(path.resolve(value).startsWith(dir + path.sep), true);
    const state = async () => {
        const response = await request(port, '/__state');
        assert.equal(response.status, 200);
        record.states.push(response.json);
        return response.json;
    };
    return { port, state, configFile, record, file };
}

test('clean start disables parallel duplicates by default', async t => {
    const f = await fixture(t);
    const state = await f.state();
    assert.equal(state.cfg.maxHedges, 0, 'clean startup must default maxHedges to 0');
    assert.deepEqual(state.cfg, DEFAULTS, 'retry/precommit and all unrelated defaults stay intact');
    assert.deepEqual(state.defaults, DEFAULTS, 'recommended defaults use the same policy');
    assert.equal(state.cfgVersion, 8, 'default-only change must not reset existing v8 configs');
    assert.equal(state.paidHedgeLocked, false, 'free/local providers are still opt-in, not forcibly locked');
    assert.equal(fs.existsSync(f.configFile), false, 'clean startup must not write an owner config');
});

test('saved v8 explicit hedge overrides preserve every unrelated knob', async t => {
    const knobs = {
        hedgeMs: 13000, maxAttempts: 7, preCommitMs: 6000, upstreamTimeoutMs: 420000,
        holdMs: 65000, emptyStreamMs: 95000, retryBudgetMs: 100000, catalogTtlMs: 700000,
        jsonHoldMs: 12000, stallMs: 80000, poolFallbackModel: 'fixture-fallback', poolDeadMs: 600000,
        visionBridge: true, visionModel: 'fixture-vision',
    };
    for (const maxHedges of [1, 3, 0]) {
        await t.test(`saved maxHedges=${maxHedges}`, async t => {
            const saved = { v: 8, ...knobs, maxHedges };
            const f = await fixture(t, { config: saved, env: { MAX_HEDGES: '5', MAX_ATTEMPTS: '10', PRE_COMMIT_MS: '12000' } });
            const before = fs.readFileSync(f.configFile);
            const state = await f.state();
            assert.deepEqual(state.cfg, { ...knobs, maxHedges }, 'saved v8 config must win over changed defaults and env');
            assert.equal(state.defaults.maxHedges, 0, 'recommendations do not erase explicit opt-in');
            assert.equal(state.cfgVersion, 8);
            assert.deepEqual(fs.readFileSync(f.configFile), before, 'same-version startup must not rewrite saved config');
            assert.equal(fs.existsSync(`${f.configFile}.v8.bak`), false, 'default-only change must not archive v8');
        });
    }
});

test('saved config without maxHedges receives zero without replacing other fields', async t => {
    const saved = { v: 8, hedgeMs: 9000, maxAttempts: 6, preCommitMs: 8000, holdMs: 45000,
        jsonHoldMs: 0, poolFallbackModel: '', visionBridge: true, visionModel: 'fixture-vision' };
    const f = await fixture(t, { config: saved });
    const before = fs.readFileSync(f.configFile);
    const state = await f.state();
    const { v, ...knobs } = saved;
    assert.equal(state.cfg.maxHedges, 0, 'a missing saved field must inherit the new zero default');
    assert.deepEqual(state.cfg, { ...DEFAULTS, ...knobs }, 'missing maxHedges must not trigger a whole-config migration');
    assert.deepEqual(fs.readFileSync(f.configFile), before, 'loading a missing field must not rewrite the saved document');
    assert.equal(state.cfgVersion, v);
});

test('recommended reset persists zero using unchanged defaults', async t => {
    const f = await fixture(t, { config: { v: 8, maxHedges: 4, hedgeMs: 11000, maxAttempts: 8,
        preCommitMs: 7000, holdMs: 50000, visionBridge: true, visionModel: 'fixture-vision' } });
    const before = await f.state();
    assert.equal(before.cfg.maxHedges, 4);
    assert.equal(before.defaults.maxHedges, 0, 'the recommended reset must use the new zero policy');
    const response = await request(f.port, '/__config', before.defaults);
    assert.equal(response.status, 200);
    const after = await f.state();
    assert.deepEqual(after.cfg, DEFAULTS, 'reset must restore every original default except maxHedges');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), { v: 8, ...DEFAULTS }, 'read back exact persisted reset');
    assert.deepEqual(after.defaults, before.defaults, 'applying recommendations must not mutate their source');
});

test('paid hedge lock remains enforced for saved config and runtime patches', async t => {
    const saved = { v: 8, maxHedges: 3, hedgeMs: 11000, maxAttempts: 7,
        preCommitMs: 8000, holdMs: 45000, visionBridge: true, visionModel: 'fixture-vision' };
    const f = await fixture(t, { config: saved, upstreamHost: 'gorouter.app' });
    const before = await f.state();
    const { v, ...knobs } = saved;
    const expected = { ...DEFAULTS, ...knobs, maxHedges: 0 };
    assert.equal(before.flatRate, true);
    assert.equal(before.paidHedgeLocked, true, 'paid protection is independent of the default policy');
    assert.deepEqual(before.cfg, expected, 'saved paid hedge opt-in must still be clamped without altering other knobs');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), { v, ...expected });
    assert.equal((await request(f.port, '/__config', { maxHedges: 5 })).status, 200);
    const after = await f.state();
    assert.deepEqual(after.cfg, expected, 'runtime paid hedge patch must still be clamped');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), { v, ...expected });
});

test('explicit paid hedge launch allowance still preserves saved opt-in', async t => {
    const saved = { v: 8, maxHedges: 2, hedgeMs: 12000, maxAttempts: 6, preCommitMs: 7000 };
    const f = await fixture(t, { config: saved, upstreamHost: 'gorouter.app', env: { ALLOW_PAID_HEDGE: '1' } });
    const before = fs.readFileSync(f.configFile);
    const state = await f.state();
    assert.equal(state.flatRate, true);
    assert.equal(state.paidHedgeLocked, false, 'explicit launch permission must still unlock paid opt-in');
    assert.deepEqual(state.cfg, { ...DEFAULTS, ...Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'v')) });
    assert.deepEqual(fs.readFileSync(f.configFile), before);
    assert.equal((await request(f.port, '/__config', { maxHedges: 4 })).status, 200);
    const after = await f.state();
    assert.deepEqual(after.cfg, { ...state.cfg, maxHedges: 4 });
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), { v: 8, ...after.cfg });
});

test('single-key paid guard overrides saved and launch hedge opt-in', async t => {
    const saved = { v: 8, maxHedges: 3, maxAttempts: 8, hedgeMs: 9000, preCommitMs: 7000,
        upstreamTimeoutMs: 420000, holdMs: 60000, emptyStreamMs: 60000, catalogTtlMs: 90000,
        poolFallbackModel: 'fixture-fallback', poolDeadMs: 600000, visionBridge: true };
    const f = await fixture(t, { config: saved, upstreamHost: 'gorouter.app',
        env: { PAID_SINGLE_KEY: '1', ALLOW_PAID_HEDGE: '1' } });
    const state = await f.state();
    const { v, ...knobs } = saved;
    const expected = { ...DEFAULTS, ...knobs, maxAttempts: 1, maxHedges: 0, hedgeMs: 0, holdMs: 0,
        emptyStreamMs: 0, catalogTtlMs: 0, poolFallbackModel: '', poolDeadMs: 0, visionBridge: false };
    assert.deepEqual(state.cfg, expected, 'single-key safety limits must remain independent of the general default and paid allowance');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), { v, ...expected });
    assert.equal((await request(f.port, '/__config', knobs)).status, 200);
    const after = await f.state();
    assert.deepEqual(after.cfg, expected, 'runtime patches must not disable single-key safety');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), { v, ...expected });
    assert.equal(after.rotate.on, false);
});

test('default policy sends no parallel generation while local upstream is silent', async t => {
    const f = await fixture(t, { replyDelayMs: 180, env: { HEDGE_MS: '50' } });
    const response = await request(f.port, '/v1/messages', { model: 'claude-fixture', stream: true, max_tokens: 16,
        messages: [{ role: 'user', content: 'fixture only' }] });
    assert.equal(response.status, 200);
    assert.match(response.text, /fixture generation complete/);
    assert.equal(f.record.calls.length, 1, 'silence must not launch a duplicate under the default policy');
    assert.equal(f.record.maxConcurrent, 1);
    const state = await f.state();
    assert.equal(state.stats.hedges, 0);
    assert.equal(state.cfg.maxAttempts, 3);
    assert.equal(state.cfg.preCommitMs, 10000);
});

test('saved positive hedge opt-in still launches a parallel local generation', async t => {
    const f = await fixture(t, { config: { v: 8, hedgeMs: 1000, maxHedges: 1 }, replyDelayMs: 1500 });
    const response = await request(f.port, '/v1/messages', { model: 'claude-fixture', stream: true, max_tokens: 16,
        messages: [{ role: 'user', content: 'fixture only' }] });
    assert.equal(response.status, 200);
    assert.match(response.text, /fixture generation complete/);
    assert.equal(f.record.calls.length, 2, 'preserved opt-in must still affect the real generation path');
    assert.equal(f.record.maxConcurrent, 2);
    const state = await f.state();
    assert.equal(state.cfg.maxHedges, 1);
    assert.equal(state.defaults.maxHedges, 0);
    assert.equal(state.stats.hedges, 1);
});
