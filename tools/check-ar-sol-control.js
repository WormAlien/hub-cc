#!/usr/bin/env node
'use strict';
/**
 * Sol-only AgentRouter control regression. Exercise extracted production HTTP
 * handlers rather than starting the dashboard monolith (which owns live ports).
 * Files and statusline subprocesses use an isolated temporary repository; paid
 * providers and legacy quota dependencies are guarded, never contacted.
 *
 * TMPDIR/TEMP/TMP must point at an isolated scratch directory on Windows.
 * AR_SOL_EVIDENCE_DIR preserves fixtures, extracted handlers, and results there.
 * Run: node tools/check-ar-sol-control.js [--case=manual]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_FILE = path.join(ROOT, 'routing', 'transparent-proxy.js');
const source = fs.readFileSync(SOURCE_FILE, 'utf8').replace(/\r\n/g, '\n');
const evidence = process.env.AR_SOL_EVIDENCE_DIR
    ? path.resolve(process.env.AR_SOL_EVIDENCE_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'ar-sol-control-'));
fs.mkdirSync(evidence, { recursive: true });
const requestedCase = (process.argv.find((arg) => arg.startsWith('--case=')) || '').slice(7);
const cases = [];
const results = [];

function test(id, name, run) { cases.push({ id, name, run }); }
function cutFunction(name, required = true) {
    const head = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
    if (!head) {
        assert.equal(required, false, `production function ${name} is missing`);
        return '';
    }
    const end = source.indexOf('\n}\n', head.index);
    assert.ok(end > head.index, `production function ${name} does not close`);
    return source.slice(head.index, end + 3);
}
function forbidden(touches, label) {
    return () => {
        touches.push(label);
        throw new Error(`forbidden legacy dependency: ${label}`);
    };
}
function guardedObject(touches, label) {
    return new Proxy({}, { get: (_target, method) => forbidden(touches, `${label}.${String(method)}`) });
}
function quotaRoutes(touches) {
    const declarations = [
        'jsonRes', 'handleArQuotaCheck', 'handleArQuotaState',
        'handleArQuotaScheduleGet', 'handleArQuotaScheduleSet',
        'arQuotaDoc', 'arQuotaPut', 'arSchedulePayload',
    ].map((name) => cutFunction(name, name === 'jsonRes' || name === 'handleArQuotaCheck')).join('\n');
    const dispatch = source.split('\n').filter((line) => /if \(req\.method.*return handleArQuota/.test(line));
    assert.equal(dispatch.length, 4, 'all four production quota dispatch branches are present');
    const code = `${declarations}\nreturn (req, res) => {\n`
        + "const arPath = req.url.split('?')[0];\n" + dispatch.join('\n')
        + "\nreturn jsonRes(res, 404, { ok: false, error: 'isolated route not found' });\n};\n";
    fs.writeFileSync(path.join(evidence, 'quota-handlers.js'), code);
    const dependencies = {
        fs: guardedObject(touches, 'fs'), path,
        https: guardedObject(touches, 'https'),
        LISTEN_PORT: 0, AR_ACTIVE_KEY_FILE: '/fixture/ar-active-key.txt',
        AR_QUOTA_STATE_FILE: '/fixture/ar-quota-state.json',
        AR_QUOTA_DEFAULT_POOL: 'opus',
        AR_QUOTA_POOLS: { opus: 'claude-opus-5', opus55: 'claude-opus-5-5', gpt: 'gpt-6-astra' },
        logLine: forbidden(touches, 'logLine'),
        agentRouterBase: forbidden(touches, 'agentRouterBase'),
        readJsonBody: forbidden(touches, 'readJsonBody'),
        poolDropState: forbidden(touches, 'poolDropState'),
        poolRestoreTiers: forbidden(touches, 'poolRestoreTiers'),
    };
    for (const name of [
        'arQuotaPoolForModel', 'arQuotaBodyFor', 'arQuotaReadPools',
        'classifyArQuotaProbe', 'buildArQuotaCache', 'isArQuotaCacheFresh',
        'arQuotaSchedule', 'arQuotaPoolSchedule', 'arQuotaBatches',
        'arQuotaScheduleSave', 'arQuotaDropAt', 'arQuotaKeyTail',
    ]) dependencies[name] = forbidden(touches, name);
    return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}
async function withServer(handler, run) {
    const server = http.createServer((req, res) => {
        try {
            Promise.resolve(handler(req, res)).catch((error) => {
                if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
                if (!res.writableEnded) res.end(JSON.stringify({ error: error.message }));
            });
        } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    try { return await run(server.address().port); }
    finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
}
function request(port, url, method = 'GET', body = '') {
    return new Promise((resolve, reject) => {
        const wire = typeof body === 'string' ? body : JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1', port, path: url, method,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire) },
            agent: false, timeout: 3000,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
                catch { reject(new Error(`non-JSON production response: ${text}`)); }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('isolated HTTP request timed out')));
        req.end(wire);
    });
}

function cutPoolRoute(name) {
    const marker = `    if (req.method === 'POST' && req.url === '/__switch/api/routes/${name}') {`;
    const head = source.indexOf(marker);
    const end = source.indexOf('\n    }\n', head);
    assert.ok(head > 0 && end > head, `production ${name} route block is missing`);
    return source.slice(head, end + 7);
}
function poolHarness(touches, dir, fileSystem = guardedObject(touches, 'fs'), poolLib = guardedObject(touches, 'poolDropLib')) {
    const prefix = /const CC_MODEL_PREFIX = \{[\s\S]*?\n\};/.exec(source);
    assert.ok(prefix, 'production provider prefix table is missing');
    const code = [
        prefix[0], "const TIER_MIRROR_TIERS = ['opus', 'sonnet', 'haiku'];", 'let _tierMirrorBusy = false;',
        ...['tierMapFile', 'writeTierMap', 'mirrorTierMapPair', 'resolveProviderKey',
            'poolDropTiers', 'poolRestoreTiers', 'poolDropState', 'routeTierMap', 'handleRoutes', 'jsonRes'].map((name) => cutFunction(name)),
        'return { poolDropTiers, poolRestoreTiers, poolDropState, handleRoutes, routes: (req, res) => {',
        cutPoolRoute('pool-drop'), cutPoolRoute('pool-restore'),
        "return jsonRes(res, 404, { ok: false, error: 'isolated route not found' }); }, };",
    ].join('\n');
    fs.writeFileSync(path.join(evidence, 'pool-handlers.js'), code);
    const dependencies = {
        fs: fileSystem, path, poolDropLib: poolLib, __dirname: dir,
        logLine: () => {},
        AR_ACTIVE_KEY_FILE: path.join(dir, 'ar-active-key.txt'),
        BACKENDS_REGISTRY_FILE: path.join(dir, 'backends.json'),
        ROUTE_TIERS: ['default', 'opus', 'sonnet', 'haiku', 'gpt'],
        MULTI_TIERS: ['default', 'opus', 'sonnet', 'haiku'],
        routeActiveModel: () => 'gpt-6.1-sol', readMultiMap: () => ({}),
        arQuotaPoolForModel: forbidden(touches, 'arQuotaPoolForModel'),
        arQuotaPut: forbidden(touches, 'arQuotaPut'),
        buildArQuotaCache: forbidden(touches, 'buildArQuotaCache'),
    };
    return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}
function legacyFixture(name) {
    const dir = path.join(evidence, name);
    fs.mkdirSync(dir, { recursive: true });
    const files = {
        'ar-modelmap.json': '{ "gpt": "gpt-6.1-sol", "opus": "gpt-5.6-sol", "note": "owner" }\n',
        'ar-routes-modelmap.json': '{ "default": "gpt-6.1-sol", "opus": "gpt-5.6-sol" }\n',
        'ar-modelmap.pooldrop.bak.json': '{ "opus": "claude-opus-5" }\n',
        'ar-routes-modelmap.pooldrop.bak.json': '{ "default": "claude-opus-5" }\n',
        'ar-pooldrop.json': JSON.stringify({
            provider: 'agentrouter', deadModel: 'claude-opus-5', fallback: 'deepseek-v4-flash',
            droppedAt: new Date(Date.now() + 60_000).toISOString(),
            backupFiles: [path.join(dir, 'ar-modelmap.pooldrop.bak.json'), path.join(dir, 'ar-routes-modelmap.pooldrop.bak.json')],
        }) + '\n',
        'ar-quota-state.json': '{ "gpt": { "state": "exhausted" } }\n',
        'ar-quota-schedule.json': '{ "tz": "UTC", "times": ["00:00", "12:00"] }\n',
        'league-sched.json': '{ "tz": "UTC", "times": ["00:00", "12:00"] }\n',
    };
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return dir;
}
function snapshot(dir) {
    return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
        const file = path.join(dir, name);
        return [name, { bytes: fs.readFileSync(file).toString('base64'), mtimeMs: fs.statSync(file).mtimeMs }];
    }));
}

async function withCatalog(cache, outcome, run) {
    const touches = [];
    const timers = new Set();
    const upstreamRequests = [];
    const code = `${cutFunction('jsonRes')}\n${cutFunction('handleArModels')}\nreturn handleArModels;`;
    fs.writeFileSync(path.join(evidence, 'catalog-handler.js'), code);
    return withServer((req, res) => {
        upstreamRequests.push(req.url);
        res.writeHead(outcome.status, { 'content-type': 'application/json' });
        res.end(outcome.raw === undefined ? JSON.stringify(outcome.data) : outcome.raw);
    }, async (upstreamPort) => {
        const dependencies = {
            AR_MODELS_CACHE: cache, AR_BASE_URL: 'https://agentrouter.org', AR_CC_HEADERS: { 'x-app': 'cli' },
            fs: guardedObject(touches, 'fs'), poolRestoreTiers: forbidden(touches, 'poolRestoreTiers'),
            setTimeout: () => { const timer = {}; timers.add(timer); return timer; },
            clearTimeout: (timer) => timers.delete(timer),
            fetch: (url, options) => {
                assert.equal(url, 'https://agentrouter.org/v1/models', 'catalog must use the existing catalog endpoint, not a quota probe');
                if (outcome.transportError) throw new Error(outcome.transportError);
                return fetch(`http://127.0.0.1:${upstreamPort}/v1/models`, options);
            },
        };
        const handler = new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
        const value = await withServer(handler, (port) => run(port, upstreamRequests));
        assert.deepEqual(touches, [], 'catalog reads must not mutate owner files or quota state');
        return { value, upstreamRequests, touches, timersRemaining: timers.size };
    });
}

// Vertical slice 1: the obsolete manual endpoint rejects BEFORE reading a key,
// probing a provider, writing quota state, or restoring either owner tier map.
test('manual', 'manual quota checks return HTTP 410 without legacy side effects', async () => {
    const touches = [];
    const replies = [];
    await withServer(quotaRoutes(touches), async (port) => {
        for (const [url, body] of [
            ['/__switch/api/ar/quota-check?pool=gpt', { pool: 'gpt' }],
            ['/__switch/api/ar/quota-check', { pool: 'opus' }],
            ['/__switch/api/ar/quota-check?pool=opus55', 'not JSON'],
            ['/__switch/api/ar/quota-check?pool=unknown', {}],
        ]) {
            const reply = await request(port, url, 'POST', body);
            replies.push({ url, ...reply });
            assert.equal(reply.status, 410, `${url} must be explicitly retired, got ${JSON.stringify(reply)}`);
            assert.equal(reply.body.ok, false);
            assert.equal(reply.body.disabled, true);
            assert.equal(reply.body.code, 'agentrouter_quota_retired');
            assert.equal(reply.body.state, null);
            assert.deepEqual(reply.body.pools, {});
            assert.match(reply.body.error, /retired/i);
        }
    });
    assert.deepEqual(touches, [], 'retired requests must not touch throwing legacy dependencies');
    fs.writeFileSync(path.join(evidence, 'manual-replies.json'), JSON.stringify({ replies, touches }, null, 2) + '\n');
});

test('schedule', 'legacy quota schedule reads and writes return HTTP 410 without file access', async () => {
    const touches = [];
    const replies = [];
    await withServer(quotaRoutes(touches), async (port) => {
        for (const [method, url, body] of [
            ['POST', '/__switch/api/ar/quota-schedule', { tz: 'UTC', times: ['00:00', '12:00'] }],
            ['POST', '/__switch/api/ar/quota-schedule?pool=opus55', 'invalid JSON'],
            ['GET', '/__switch/api/ar/quota-schedule?legacy=1', ''],
        ]) {
            const reply = await request(port, url, method, body);
            replies.push({ method, url, ...reply });
            assert.equal(reply.status, 410, `schedule control must be retired before body/file access: ${JSON.stringify(reply)}`);
            assert.equal(reply.body.ok, false);
            assert.equal(reply.body.disabled, true);
            assert.equal(reply.body.code, 'agentrouter_quota_retired');
            assert.equal(reply.body.state, null);
            assert.deepEqual(reply.body.pools, {});
            assert.equal(reply.body.next, undefined);
            assert.equal(reply.body.times, undefined);
        }
    });
    assert.deepEqual(touches, [], 'schedule requests must not parse a body or access legacy files');
    fs.writeFileSync(path.join(evidence, 'schedule-replies.json'), JSON.stringify({ replies, touches }, null, 2) + '\n');
});

test('state', 'quota state reports disabled and empty without reading stale files', async () => {
    const touches = [];
    const replies = [];
    await withServer(quotaRoutes(touches), async (port) => {
        for (const url of ['/__switch/api/ar/quota-state', '/__switch/api/ar/quota-state?pool=gpt']) {
            const reply = await request(port, url);
            replies.push({ url, ...reply });
            assert.equal(reply.status, 200);
            assert.deepEqual(reply.body, {
                ok: true, disabled: true, code: 'agentrouter_quota_retired', state: null, pools: {},
            }, 'legacy quota state must not expose exhausted lanes, key tails, or schedules');
        }
    });
    assert.deepEqual(touches, [], 'disabled state must not read a quota cache, key, or schedule');
    fs.writeFileSync(path.join(evidence, 'state-replies.json'), JSON.stringify({ replies, touches }, null, 2) + '\n');
});

test('poolcontrol', 'both AgentRouter aliases reject pool-drop and restore before touching files or state', async () => {
    const dir = legacyFixture('poolcontrol-files');
    const before = snapshot(dir);
    const touches = [];
    const replies = [];
    const harness = poolHarness(touches, dir);
    await withServer(harness.routes, async (port) => {
        for (const provider of ['ar', 'agentrouter']) {
            for (const endpoint of ['pool-drop', 'pool-restore']) {
                const reply = await request(port, `/__switch/api/routes/${endpoint}`, 'POST', {
                    provider, model: 'gpt-6.1-sol', fallback: 'deepseek-v4-flash',
                });
                replies.push({ provider, endpoint, ...reply });
                assert.equal(reply.status, 410, `${provider}/${endpoint} must retire before dependencies: ${JSON.stringify(reply)}`);
                assert.equal(reply.body.ok, false);
                assert.equal(reply.body.disabled, true);
                assert.equal(reply.body.code, 'agentrouter_quota_retired');
                assert.equal(reply.body.provider, 'agentrouter');
                assert.notEqual(reply.body.restored, true);
                assert.equal(reply.body.tiers, undefined);
            }
        }
    });
    assert.deepEqual(touches, [], 'even poolDropFiles/tierMapFile must not be reached for retired aliases');
    assert.deepEqual(snapshot(dir), before, 'all obsolete markers/backups/schedules/owner maps must survive byte-for-byte');
    fs.writeFileSync(path.join(evidence, 'poolcontrol-replies.json'), JSON.stringify({ replies, touches, before, after: snapshot(dir) }, null, 2) + '\n');
});

test('poolstate', 'obsolete AgentRouter markers cannot produce active state or route banners', async () => {
    const dir = legacyFixture('poolstate-files');
    const touches = [];
    const denied = poolHarness(touches, dir);
    assert.doesNotThrow(() => denied.poolDropState({ toString() { throw new Error('invalid provider input'); } }),
        'unrelated invalid provider state inputs must retain the original null-on-error behavior');
    for (const provider of ['ar', 'agentrouter']) {
        assert.equal(denied.poolDropState(provider), null, `${provider} state must be null`);
    }
    assert.deepEqual(touches, [], 'AgentRouter state must not even inspect the pool marker library');

    fs.writeFileSync(path.join(dir, 'backends.json'), JSON.stringify({
        providers: { agentrouter: { label: 'AgentRouter', upstream: 'http://localhost:20133' },
            gorouter: { label: 'GoRouter', upstream: 'https://gorouter.test' } },
        aliases: { ar: 'agentrouter' },
    }) + '\n');
    const otherMarker = { deadModel: 'claude-opus-5', fallback: 'non-ar-fallback', droppedAt: '2026-01-01T00:00:00.000Z' };
    fs.writeFileSync(path.join(dir, 'gorouter-pooldrop.json'), JSON.stringify(otherMarker) + '\n');
    const before = snapshot(dir);
    const harness = poolHarness(touches, dir, fs, require('../routing/lib/pooldrop.js'));
    const reply = await withServer((req, res) => harness.handleRoutes(res), (port) => request(port, '/__switch/api/routes'));
    assert.equal(reply.status, 200);
    const ar = reply.body.providers.find((provider) => provider.name === 'agentrouter');
    assert.equal(ar.pooldrop, null, 'actual routes handler must not propagate a stale AR banner');
    assert.equal(ar.gatewayTiers.gpt, 'gpt-6.1-sol', 'owner gateway map remains the current Sol map');
    assert.equal(ar.tiers.default, 'gpt-6.1-sol', 'owner route map remains the current Sol map');
    assert.deepEqual(ar.aliases, ['ar']);
    const other = reply.body.providers.find((provider) => provider.name === 'gorouter');
    assert.deepEqual(other.pooldrop, otherMarker, 'other providers keep their pool state behavior');
    assert.deepEqual(snapshot(dir), before, 'state/route reads must not restore/delete/migrate old files');
    fs.writeFileSync(path.join(evidence, 'poolstate-reply.json'), JSON.stringify({ reply, touches, before, after: snapshot(dir) }, null, 2) + '\n');
});

test('otherproviders', 'non-AgentRouter pool handlers preserve drop, idempotence, restore, and validation', async () => {
    const dir = legacyFixture('otherprovider-files');
    const arBefore = snapshot(dir);
    const touches = [];
    const harness = poolHarness(touches, dir, fs, require('../routing/lib/pooldrop.js'));
    const map = path.join(dir, 'gorouter-modelmap.json');
    const routes = path.join(dir, 'gorouter-routes-modelmap.json');
    const marker = path.join(dir, 'gorouter-pooldrop.json');
    const mapBytes = '{\n    "opus": "claude-opus-5", "sonnet": "gpt-5.6-sol", "haiku": "glm-5.3", "note": "owner"\n}';
    const routesBytes = '{ "default": "claude-opus-5", "opus": "claude-opus-5", "note": "routes-owner" }\n';
    fs.writeFileSync(map, mapBytes);
    fs.writeFileSync(routes, routesBytes);
    const replies = [];
    await withServer(harness.routes, async (port) => {
        const empty = await request(port, '/__switch/api/routes/pool-drop', 'POST', { provider: 'gorouter', model: 'claude-opus-5', fallback: '' });
        assert.equal(empty.status, 400, 'ordinary empty fallback validation remains a 400');
        assert.equal(fs.readFileSync(map, 'utf8'), mapBytes);
        assert.equal(fs.existsSync(marker), false);
        const drop = await request(port, '/__switch/api/routes/pool-drop', 'POST', { provider: 'gorouter', model: 'claude-opus-5', fallback: 'deepseek-v4-flash' });
        replies.push({ action: 'drop', ...drop });
        assert.equal(drop.status, 200, `unrelated provider drop must still succeed: ${JSON.stringify(drop)}`);
        assert.equal(drop.body.ok, true);
        assert.equal(JSON.parse(fs.readFileSync(map, 'utf8')).opus, 'deepseek-v4-flash');
        assert.equal(JSON.parse(fs.readFileSync(map, 'utf8')).sonnet, 'gpt-5.6-sol', 'foreign model family remains unchanged');
        assert.equal(JSON.parse(fs.readFileSync(map, 'utf8')).haiku, 'glm-5.3');
        assert.equal(JSON.parse(fs.readFileSync(map, 'utf8')).note, 'owner');
        assert.equal(fs.readFileSync(path.join(dir, 'gorouter-modelmap.pooldrop.bak.json'), 'utf8'), mapBytes);
        assert.equal(fs.readFileSync(path.join(dir, 'gorouter-routes-modelmap.pooldrop.bak.json'), 'utf8'), routesBytes);
        assert.equal(harness.poolDropState('gorouter').fallback, 'deepseek-v4-flash');
        const again = await request(port, '/__switch/api/routes/pool-drop', 'POST', { provider: 'gorouter', model: 'claude-opus-5', fallback: 'glm-5.3' });
        assert.equal(again.status, 200);
        assert.equal(again.body.already, true);
        const restore = await request(port, '/__switch/api/routes/pool-restore', 'POST', { provider: 'gorouter' });
        replies.push({ action: 'restore', ...restore });
        assert.equal(restore.status, 200);
        assert.equal(restore.body.restored, true);
        assert.equal(fs.readFileSync(map, 'utf8'), mapBytes, 'ordinary restore stays byte-for-byte');
        assert.equal(fs.readFileSync(routes, 'utf8'), routesBytes, 'ordinary route restore stays byte-for-byte');
        assert.equal(fs.existsSync(marker), false);
        const missing = await request(port, '/__switch/api/routes/pool-restore', 'POST', { provider: 'unknown-provider' });
        assert.equal(missing.status, 400, 'unknown providers keep the normal error response');
    });
    assert.deepEqual(touches, [], 'other providers must not resurrect retired AgentRouter quota state');
    const after = snapshot(dir);
    for (const [name, state] of Object.entries(arBefore)) assert.deepEqual(after[name], state, `non-AR operations touched ${name}`);
    fs.writeFileSync(path.join(evidence, 'otherprovider-replies.json'), JSON.stringify({ replies, touches, arBefore }, null, 2) + '\n');
});

test('timers', 'legacy quota env and schedules cannot register probes or restore maps at startup or on ticks', async () => {
    const dir = legacyFixture('timer-files');
    const before = snapshot(dir);
    const head = source.indexOf('const AR_BALANCE_TICK_MS =');
    const end = source.indexOf('const BALANCE_NUDGE_INFLIGHT =', head);
    assert.ok(head > 0 && end > head, 'production balance/startup timer block is missing');
    const block = source.slice(head, end);
    fs.writeFileSync(path.join(evidence, 'startup-timers.js'), block);
    const runs = [];
    for (const legacyEnv of ['1', '', '0']) {
        const touches = [];
        const registered = [];
        let balanceTicks = 0;
        const timer = (kind) => (callback, delay) => {
            registered.push({ kind, callback, delay });
            return { unref() {} };
        };
        const dependencies = {
            process: { env: { AR_QUOTA_AUTOTICK: legacyEnv, AR_QUOTA_SCHEDULE_FILE: path.join(dir, 'ar-quota-schedule.json') } },
            fs: new Proxy({ readFileSync: (file) => {
                if (file === '/fixture/active-key') return 'sk-fixture-not-live';
                if (file === '/fixture/settings') return JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:20133' } });
                return forbidden(touches, `fs.readFileSync(${file})`)();
            } }, { get: (target, method) => target[method] || forbidden(touches, `fs.${String(method)}`) }),
            http: guardedObject(touches, 'http'),
            setInterval: timer('interval'), setTimeout: timer('timeout'),
            AR_ACTIVE_KEY_FILE: '/fixture/active-key', SETTINGS_FILE: '/fixture/settings',
            AR_BASE_URL: 'https://agentrouter.org', LISTEN_PORT: 0,
            arBalanceMaybe: () => { balanceTicks += 1; },
            AR_QUOTA_POOLS: { opus: 'claude-opus-5', gpt: 'gpt-6-astra', opus55: 'claude-opus-5-5' },
            arQuotaDropAt: forbidden(touches, 'arQuotaDropAt'),
            arQuotaPoolSchedule: forbidden(touches, 'arQuotaPoolSchedule'),
            poolRestoreTiers: forbidden(touches, 'poolRestoreTiers'),
            poolDropLib: guardedObject(touches, 'poolDropLib'),
            tierMapFile: forbidden(touches, 'tierMapFile'), logLine: forbidden(touches, 'logLine'),
        };
        new Function(...Object.keys(dependencies), block)(...Object.values(dependencies));
        assert.deepEqual(registered.map(({ kind, delay }) => ({ kind, delay })), [{ kind: 'interval', delay: 120_000 }],
            `legacy env=${JSON.stringify(legacyEnv)} must not register quota startup/interval timers`);
        for (const entry of registered) entry.callback();
        assert.equal(balanceTicks, 1, 'the unrelated active-account billing tick remains');
        assert.deepEqual(touches, [], 'no legacy probe, schedule or restore dependency is reachable');
        runs.push({ legacyEnv, timers: registered.map(({ kind, delay }) => ({ kind, delay })), balanceTicks, touches });
    }
    for (const token of ['AR_QUOTA_AUTOTICK', 'AR_QUOTA_WINDOWS_MS', 'AR_QUOTA_STATE_FILE',
        'arQuotaTicked', 'arQuotaAutoTickNow', 'arQuotaProbeAsync', 'arQuotaPut', 'arQuotaDoc', 'arSchedulePayload',
        "require('./lib/ar-quota-probe')"]) {
        assert.equal(source.includes(token), false, `${token} must be physically removed, not hidden by a UI/config flag`);
    }
    assert.deepEqual(snapshot(dir), before, 'startup/ticks must not migrate/delete/restore any legacy file or map');
    fs.writeFileSync(path.join(evidence, 'timer-evidence.json'), JSON.stringify({ runs, before, after: snapshot(dir) }, null, 2) + '\n');
});

test('remoteschedule', 'league sync keeps peer/chart exchange but never imports or exports quota schedules', async () => {
    const dir = legacyFixture('league-files');
    const arBefore = snapshot(dir);
    const touches = [];
    const seen = [];
    const code = `${cutFunction('leagueSync')}\nreturn leagueSync;`;
    fs.writeFileSync(path.join(evidence, 'league-sync.js'), code);
    const dependencies = {
        fs, path,
        leagueConfig: () => ({ enabled: true, url: 'http://receiver.fixture', key: 'fixture-not-live' }),
        leagueSelf: () => ({ installId: 'fixture-install' }),
        leagueReq: async (_config, url, method, body) => {
            seen.push({ url, method, body: body || null });
            if (url === '/schedule') throw new Error('retired remote quota schedule must not be requested');
            if (url === '/slice') return { status: 200, body: '{}' };
            if (url.startsWith('/peers?')) return { status: 200, body: JSON.stringify({ peers: [{ rid: 'fixture-peer' }], updated: '2026-01-01' }) };
            if (url === '/health') return { status: 200, body: JSON.stringify({ instance: 'fixture-instance' }) };
            if (url === '/config') return { status: 200, body: JSON.stringify({ chart: { range: 'week' }, schedule: { tz: 'UTC', times: ['00:00', '12:00'] } }) };
            throw new Error(`unexpected isolated league request: ${url}`);
        },
        LEAGUE_SYNC_LAST: { peers: 0 },
        LEAGUE_PEERS_FILE: path.join(dir, 'league-peers.json'), LEAGUE_CHART_FILE: path.join(dir, 'league-chart.json'),
        LEAGUE_SCHED_FILE: path.join(dir, 'league-sched.json'),
        leagueReceiverInstanceRemember: () => {},
        leagueInstanceVerdict: () => ({ state: 'same' }),
        leagueSchedApplied: forbidden(touches, 'leagueSchedApplied'),
        arQuotaScheduleSave: forbidden(touches, 'arQuotaScheduleSave'), logLine: () => {},
    };
    const sync = new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
    const reply = await sync();
    assert.deepEqual(reply, { ok: true, peers: 1 }, 'normal league sync stays working');
    assert.deepEqual(seen.map(({ url }) => url), ['/slice', '/peers?installId=fixture-install', '/health', '/config'],
        'no legacy quota schedule request is allowed during real league sync');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'league-chart.json'), 'utf8')).chart.range, 'week');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'league-peers.json'), 'utf8')).peers[0].rid, 'fixture-peer');
    assert.deepEqual(touches, [], 'remote schedule metadata cannot trigger a local quota file write');
    const after = snapshot(dir);
    for (const [name, state] of Object.entries(arBefore)) assert.deepEqual(after[name], state, `league sync changed legacy file ${name}`);
    for (const token of ['leagueSchedApplied', 'LEAGUE_SCHED_FILE', 'arQuotaScheduleSave']) {
        assert.equal(source.includes(token), false, `${token} must no longer have an active import/export path`);
    }
    fs.writeFileSync(path.join(evidence, 'league-evidence.json'), JSON.stringify({ reply, seen, touches, arBefore }, null, 2) + '\n');
});

test('statusline', 'real statusline keeps Sol identity, balance and check-in but ignores every legacy pool file', async () => {
    const dir = path.join(evidence, 'statusline-stage');
    const routing = path.join(dir, 'routing');
    const home = path.join(dir, 'home');
    const claude = path.join(home, '.claude');
    fs.mkdirSync(routing, { recursive: true });
    fs.mkdirSync(claude, { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const script = path.join(routing, 'statusline-autoreger.sh');
    fs.copyFileSync(path.join(ROOT, 'routing', 'statusline-autoreger.sh'), script);
    fs.copyFileSync(path.join(ROOT, 'routing', 'statusline-agentrouter-state.js'), path.join(routing, 'statusline-agentrouter-state.js'));
    fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:20100' } }) + '\n');
    fs.writeFileSync(path.join(claude, 'active-backend.json'), JSON.stringify({ backend: 'agentrouter', upstream: 'http://localhost:20133' }) + '\n');
    fs.writeFileSync(path.join(claude, 'backends.json'), JSON.stringify({
        providers: { agentrouter: { modelmap: 'ar-modelmap.json' } }, aliases: { ar: 'agentrouter' },
    }) + '\n');
    fs.writeFileSync(path.join(claude, 'ar-active-key.txt'), 'fixture-statusline-key\n');
    const now = Date.now();
    const checked = new Date(now).toISOString();
    fs.writeFileSync(path.join(routing, 'agentrouter-sessions.json'), JSON.stringify(Array.from({ length: 50 }, (_, index) => ({
        api_key: index === 31 ? 'fixture-statusline-key' : `fixture-key-${index}`,
        status: 'live', balance: index === 31 ? 12.34 : 1, granted: 25,
        balanceCheckedAt: checked, checkinAt: index < 40 ? checked : '2000-01-01T00:00:00.000Z',
        padding: 'x'.repeat(500),
    })), null, 2) + '\n');
    fs.writeFileSync(path.join(routing, 'ar-checkin.json'), '{ "resetHhmmMsk": "20:30" }\n');
    fs.writeFileSync(path.join(routing, 'ar-modelmap.json'), '{ "opus": "gpt-6.1-sol", "gpt": "" }\n');
    fs.writeFileSync(path.join(routing, 'ar-routes-modelmap.json'), '{ "default": "gpt-5.6-sol", "opus": "gpt-5.6-sol", "gpt": "" }\n');
    const dropMs = Math.floor(now / 60_000) * 60_000;
    const drop = new Date(dropMs);
    const hhmm = `${String(drop.getUTCHours()).padStart(2, '0')}:${String(drop.getUTCMinutes()).padStart(2, '0')}`;
    const state = { state: 'exhausted', checkedAt: checked, dropAt: drop.toISOString(), keyTail: 'fake' };
    fs.writeFileSync(path.join(claude, 'ar-quota-state.json'), JSON.stringify({ opus: state, gpt: state }) + '\n');
    fs.writeFileSync(path.join(claude, 'ar-quota-schedule.json'), JSON.stringify({ tz: 'UTC', times: [hhmm] }) + '\n');
    fs.writeFileSync(path.join(routing, 'ar-pooldrop.json'), '{ "fallback": "legacy-not-a-sol-model" }\n');
    fs.writeFileSync(path.join(routing, 'keepalive-config-20133.json'), '{ "poolFallbackModel": "legacy-not-a-sol-model" }\n');
    fs.writeFileSync(path.join(dir, 'logs', '.money_autorotate.json'), '{ "enabled": true }\n');
    const networkLog = path.join(dir, 'network-attempts.log');
    const bashEnv = path.join(dir, 'network-guard.sh');
    fs.writeFileSync(bashEnv, 'curl() { printf "%s\\n" "$*" >> "$AR_SOL_NETWORK_LOG"; return 96; }\ncurl.exe() { curl "$@"; }\n');
    const before = { routing: snapshot(routing), claude: snapshot(claude) };
    const outputs = [];
    const payload = (id) => JSON.stringify({ model: { id }, context_window: { total_input_tokens: 139000, context_window_size: 1000000, used_percentage: 13 } }) + '\n';
    const statuslineEnv = { ...process.env, HOME: home, STATUSLINE_PAYLOAD: '', BASH_ENV: bashEnv,
        AR_SOL_NETWORK_LOG: networkLog, AR_QUOTA_AUTOTICK: '1',
        AR_QUOTA_SCHEDULE_FILE: path.join(claude, 'ar-quota-schedule.json'),
        TMPDIR: os.tmpdir(), TEMP: os.tmpdir(), TMP: os.tmpdir() };
    // Hermes suppresses MSYS path conversion for native tool commands. A real
    // Git Bash statusline uses the normal conversion when invoking its Node helper.
    delete statuslineEnv.MSYS_NO_PATHCONV;
    delete statuslineEnv.MSYS2_ARG_CONV_EXCL;
    for (const id of ['gpt-6.1-sol[1m]', 'gpt-5.6-sol', 'ar/gpt-5.6-sol', 'agentrouter', 'claude-opus-5']) {
        const started = performance.now();
        const run = spawnSync('bash', ['-x', script.replace(/\\/g, '/')], {
            input: payload(id), encoding: 'utf8', timeout: 4000,
            env: statuslineEnv,
        });
        const milliseconds = Math.round(performance.now() - started);
        const text = (run.stdout || '').replace(/\u001b\[[0-9;]*m/g, '');
        outputs.push({ id, text, milliseconds, exit: run.status, error: run.error?.message || null });
        fs.writeFileSync(path.join(dir, `trace-${outputs.length}.log`), run.stderr || '');
        fs.writeFileSync(path.join(evidence, 'statusline-outputs.json'), JSON.stringify(outputs, null, 2) + '\n');
        assert.equal(run.status, 0, `statusline must render successfully: ${run.error?.message || run.stderr}`);
        assert.ok(text.includes('$12.34'), `active balance is preserved: ${text}`);
        assert.ok(text.includes('🎁10'), `existing check-in count is preserved: ${text}`);
        assert.ok(text.includes('⧉ 139k/1M'), `context segment is preserved: ${text}`);
        assert.equal(/pool|пул|квот|⛔|legacy-not-a-sol-model/i.test(text), false, `old exhausted state cannot show pool/fallback text: ${text}`);
        assert.equal(/ar-quota-(state|schedule)|ar-pooldrop|poolFallbackModel/.test(run.stderr || ''), false,
            'actual Bash execution must not read quota/marker/fallback files');
        if (id === 'agentrouter') assert.ok(text.startsWith('agentrouter→gpt-5.6-sol'), `bare route identity uses current route map: ${text}`);
        else if (id === 'claude-opus-5') assert.ok(text.startsWith('agentrouter/claude-opus-5→gpt-6.1-sol'), `client tier compatibility is preserved: ${text}`);
        else assert.ok(text.startsWith(`agentrouter/${id.replace(/^ar\//, '')}`), `exact Sol model identity is preserved: ${text}`);
    }
    assert.equal(fs.existsSync(networkLog), false, 'fresh balance must not need any network; legacy schedules must never call it');
    assert.deepEqual({ routing: snapshot(routing), claude: snapshot(claude) }, before, 'statusline leaves maps/markers/schedules/account cache untouched');
    const statusline = fs.readFileSync(script, 'utf8');
    for (const token of ['ar-quota-state', 'ar-quota-schedule', 'ar-pooldrop.json', 'pool_dry', 'POOL_MARK', 'poolFallbackModel', 'statusline-pool-success.js']) {
        assert.equal(statusline.includes(token), false, `${token} must be physically removed from the statusline`);
    }
});

test('catalogfailure', 'actual AgentRouter catalog HTTP failures are explicit errors, never valid empty success', async () => {
    const cache = { data: null, ts: 0, TTL: 300_000 };
    const outcome = await withCatalog(cache, { status: 503, data: { error: 'fixture unavailable' } }, async (port) => {
        const reply = await request(port, '/__switch/api/ar/models?api_key=fixture-not-live&force=1');
        assert.equal(reply.body.ok, false, `HTTP failure must not masquerade as valid empty catalog: ${JSON.stringify(reply)}`);
        assert.equal(reply.status, 502);
        assert.equal(reply.body.status, 503);
        assert.match(reply.body.error, /HTTP 503/);
        assert.deepEqual(reply.body.models, []);
        assert.equal(reply.body.source, 'none');
        assert.equal(reply.body.cached, false);
        return reply;
    });
    assert.equal(cache.data, null, 'failed catalog cannot poison the successful cache');
    assert.equal(outcome.timersRemaining, 0, 'catalog timer is always cleared');
    fs.writeFileSync(path.join(evidence, 'catalogfailure-reply.json'), JSON.stringify(outcome, null, 2) + '\n');
});

test('catalogsol', 'live and cached AgentRouter catalogs contain only exact Sol IDs and retain valid empty state', async () => {
    const rows = [
        { id: 'gpt-6.1-sol', owned_by: 'fixture', supported_endpoint_types: ['chat'] },
        { id: 'gpt-6-astra', owned_by: 'legacy' }, { id: 'claude-opus-5' },
        { id: 'gpt-5.6-sol', owned_by: 'fixture56', supported_endpoint_types: ['chat'] },
        { id: 'GPT-6.1-SOL' }, { id: 'gpt-6.1-sol[1m]' }, { id: ' gpt-5.6-sol ' },
        { id: 'gpt-6.1-sol-preview' },
    ];
    const cache = { data: rows, ts: Date.now(), TTL: 300_000 };
    const cacheBefore = JSON.stringify(cache.data);
    const evidenceRows = [];
    const cached = await withCatalog(cache, { status: 200, data: { data: rows } }, async (port) => {
        const reply = await request(port, '/__switch/api/ar/models?api_key=fixture-not-live');
        assert.deepEqual(reply.body.models.map(({ id }) => id), ['gpt-6.1-sol', 'gpt-5.6-sol'], 'cached legacy catalog must be filtered, never normalize near-miss model IDs');
        assert.equal(reply.body.ok, true);
        assert.equal(reply.body.cached, true);
        assert.equal(reply.body.source, 'cache');
        assert.equal(reply.body.stale, false);
        return reply;
    });
    assert.equal(cached.upstreamRequests.length, 0, 'normal cache hit must not call a provider');
    assert.equal(JSON.stringify(cache.data), cacheBefore, 'filtering a historical cache response does not rewrite owner/cache state');
    evidenceRows.push(cached);
    const live = await withCatalog(cache, { status: 200, data: { data: rows } }, async (port) => {
        const reply = await request(port, '/__switch/api/ar/models?api_key=fixture-not-live&force=1');
        assert.deepEqual(reply.body.models.map(({ id }) => id), ['gpt-6.1-sol', 'gpt-5.6-sol']);
        assert.equal(reply.body.cached, false);
        assert.equal(reply.body.source, 'live');
        assert.equal(reply.body.stale, false);
        assert.equal(reply.body.models[0].owned_by, 'fixture');
        assert.deepEqual(reply.body.models[1].supported_endpoint_types, ['chat']);
        return reply;
    });
    assert.equal(live.upstreamRequests.length, 1);
    assert.deepEqual(cache.data.map(({ id }) => id), ['gpt-6.1-sol', 'gpt-5.6-sol']);
    evidenceRows.push(live);
    const empty = await withCatalog(cache, { status: 200, data: { data: [] } }, async (port) => {
        const reply = await request(port, '/__switch/api/ar/models?api_key=fixture-not-live&force=1');
        assert.equal(reply.body.ok, true, 'successful empty catalog is not a transport failure');
        assert.deepEqual(reply.body.models, []);
        assert.equal(reply.body.error, undefined);
        return reply;
    });
    assert.deepEqual(cache.data, [], 'a successful empty list replaces old cached availability');
    const emptyCached = await withCatalog(cache, { status: 503, data: {} }, async (port) => request(port, '/__switch/api/ar/models?api_key=fixture-not-live'));
    assert.equal(emptyCached.upstreamRequests.length, 0);
    assert.equal(emptyCached.value.body.ok, true);
    assert.deepEqual(emptyCached.value.body.models, []);
    evidenceRows.push(empty, emptyCached);
    fs.writeFileSync(path.join(evidence, 'catalog-sol-replies.json'), JSON.stringify(evidenceRows, null, 2) + '\n');
});

test('catalogtransport', 'transport or invalid catalog responses report errors and stale cache provenance without renewing availability', async () => {
    const initial = [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }, { id: 'gpt-5.6-sol' }];
    const scenarios = [
        { name: 'transport no cache', cache: { data: null, ts: 0, TTL: 300_000 }, outcome: { status: 200, transportError: 'fixture connection failure' }, expectedStatus: null },
        { name: 'transport with cache', cache: { data: initial, ts: Date.now() - 600_000, TTL: 300_000 }, outcome: { status: 200, transportError: 'fixture connection failure' }, expectedStatus: null },
        { name: 'HTTP with cache', cache: { data: initial, ts: Date.now() - 600_000, TTL: 300_000 }, outcome: { status: 503, data: {} }, expectedStatus: 503 },
        { name: 'invalid JSON', cache: { data: null, ts: 0, TTL: 300_000 }, outcome: { status: 200, raw: 'not-json' }, expectedStatus: null },
        { name: 'invalid envelope', cache: { data: null, ts: 0, TTL: 300_000 }, outcome: { status: 200, data: { error: 'not a catalog' } }, expectedStatus: null },
    ];
    const evidenceRows = [];
    for (const scenario of scenarios) {
        const before = JSON.stringify(scenario.cache);
        const result = await withCatalog(scenario.cache, scenario.outcome, async (port) => {
            const reply = await request(port, '/__switch/api/ar/models?api_key=fixture-not-live&force=1');
            assert.equal(reply.body.ok, false, `${scenario.name} cannot be a successful empty catalog: ${JSON.stringify(reply)}`);
            assert.equal(reply.status, 502);
            assert.equal(reply.body.status, scenario.expectedStatus);
            assert.ok(reply.body.error);
            if (scenario.cache.data) {
                assert.deepEqual(reply.body.models.map(({ id }) => id), ['gpt-6.1-sol', 'gpt-5.6-sol']);
                assert.equal(reply.body.cached, true);
                assert.equal(reply.body.stale, true);
                assert.equal(reply.body.source, 'cache');
                assert.match(reply.body.note, /stale/i);
            } else {
                assert.deepEqual(reply.body.models, []);
                assert.equal(reply.body.cached, false);
                assert.equal(reply.body.source, 'none');
            }
            return reply;
        });
        assert.equal(JSON.stringify(scenario.cache), before, 'failed refresh cannot renew/cache/migrate historical availability');
        assert.equal(result.timersRemaining, 0, `${scenario.name} must clear the request timeout`);
        evidenceRows.push({ name: scenario.name, result });
    }
    fs.writeFileSync(path.join(evidence, 'catalog-transport-replies.json'), JSON.stringify(evidenceRows, null, 2) + '\n');
});

test('catalogroutes', 'shared AgentRouter route candidates cannot relabel stale error cache as a live catalog', async () => {
    const cache = { data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-5.6-sol' }], ts: Date.now() - 600_000, TTL: 300_000 };
    const result = await withCatalog(cache, { status: 503, data: {} }, async (port) => {
        const json = new Function('http', 'LISTEN_PORT', `${cutFunction('routesCatalogJson')}\nreturn routesCatalogJson;`)(http, port);
        const candidate = new Function('routesCatalogJson', 'ROUTE_EP', 'routesCatalogLib',
            `${cutFunction('routesCandidateModelsForKey')}\nreturn routesCandidateModelsForKey;`)(
            json, { agentrouter: 'ar' }, require('../routing/lib/routes-catalog.js'));
        const models = await candidate('agentrouter', 'fixture-not-live');
        assert.deepEqual(models, [], 'stale cached models in ok:false AR responses must not be published as live route candidates');
        return models;
    });
    const ordinary = new Function('routesCatalogJson', 'ROUTE_EP', 'routesCatalogLib',
        `${cutFunction('routesCandidateModelsForKey')}\nreturn routesCandidateModelsForKey;`)(
        async () => ({ ok: false, stale: true, models: [{ id: 'claude-opus-5' }] }),
        { gorouter: 'go' }, require('../routing/lib/routes-catalog.js'));
    assert.deepEqual(await ordinary('gorouter', 'fixture-not-live'), ['claude-opus-5'], 'other providers retain their candidate behavior');
    fs.writeFileSync(path.join(evidence, 'catalog-routes-evidence.json'), JSON.stringify(result, null, 2) + '\n');
});

(async () => {
    const selected = cases.filter((entry) => !requestedCase || entry.id === requestedCase);
    assert.ok(selected.length, `unknown case: ${requestedCase}`);
    for (const entry of selected) {
        const started = performance.now();
        try {
            await entry.run();
            results.push({ id: entry.id, name: entry.name, ok: true, milliseconds: Math.round(performance.now() - started) });
            console.log(`OK   ${entry.id}: ${entry.name}`);
        } catch (error) {
            results.push({ id: entry.id, name: entry.name, ok: false, error: error.message });
            console.error(`FAIL ${entry.id}: ${entry.name}\n${error.stack}`);
        }
    }
    const passed = results.filter((result) => result.ok).length;
    const failed = results.length - passed;
    fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({
        command: [process.execPath, ...process.argv.slice(1)],
        source: SOURCE_FILE, evidence, passed, failed, results,
    }, null, 2) + '\n');
    console.log(`\n${passed} passed, ${failed} failed; evidence: ${evidence}`);
    process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
