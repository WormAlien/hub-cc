'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = process.env.TMPDIR || 'C:/Users/WormAlien/AppData/Local/hermes/cache/scratch';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
    const server = http.createServer();
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
function request(port, method, url, body, extraHeaders = {}) {
    return new Promise(resolve => {
        const raw = body === undefined ? '' : JSON.stringify(body);
        const headers = raw ? {
            'content-type': 'application/json', 'content-length': Buffer.byteLength(raw),
            ...extraHeaders,
        } : { ...extraHeaders };
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = null; try { data = JSON.parse(text); } catch {}
                resolve({ status: res.statusCode, data, text });
            });
        });
        req.on('error', error => resolve({ status: 0, data: null, text: error.message }));
        if (raw) req.write(raw);
        req.end();
    });
}
function killFixturePort(port) {
    if (process.platform !== 'win32') return;
    try {
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
        for (const line of out.split(/\r?\n/)) {
            const m = line.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
            if (m) { try { execFileSync('taskkill.exe', ['/F', '/PID', m[1]], { stdio: 'ignore' }); } catch {} }
        }
    } catch {}
}
async function waitFor(fn, label, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const value = await fn();
        if (value) return value;
        await wait(100);
    }
    throw new Error(label + ' timeout');
}

(async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'freegg-rate-toggle-'));
    const routing = path.join(dir, 'routing');
    fs.mkdirSync(routing, { recursive: true });
    for (const file of [
        'transparent-proxy.js', 'keepalive-proxy.js', 'freegg-proxy.js', 'frontdoor-proxy.js',
        'proxy-dashboard.html', 'latency-store.js', 'event-store.js', 'proxy-logger.js', 'freegg-modelmap.json',
        'backends.json', 'frontdoor.json', 'rate-balance-providers.json',
    ]) {
        const src = path.join(ROOT, 'routing', file);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(routing, file));
    }
    fs.cpSync(path.join(ROOT, 'routing', 'lib'), path.join(routing, 'lib'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'internal'), path.join(dir, 'internal'), { recursive: true });
    for (const folder of ['freemodel', 'github', 'gemini', 'a6api']) {
        if (fs.existsSync(path.join(ROOT, folder))) fs.cpSync(path.join(ROOT, folder), path.join(dir, folder), { recursive: true });
    }
    const sourceRepo = process.env.HUB_SOURCE_REPO || ROOT;
    const sourceNodeModules = path.join(sourceRepo, 'node_modules');
    const repoNodeModules = fs.existsSync(path.join(ROOT, 'node_modules')) ? path.join(ROOT, 'node_modules') : sourceNodeModules;
    const linkNodeModules = path.join(dir, 'node_modules');
    if (fs.existsSync(repoNodeModules)) fs.symlinkSync(repoNodeModules, linkNodeModules, 'junction');
    const configPath = path.join(dir, '.claude', 'freegg-rate-policy.json');
    const poolFixture = [
        { id: 'a', newApiUserId: 1, api_key: 'fixture-key-a', active: true, status: 'live' },
        { id: 'b', newApiUserId: 2, api_key: 'fixture-key-b', status: 'live' },
    ];
    fs.writeFileSync(path.join(routing, 'freegg-sessions.json'), JSON.stringify(poolFixture));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'freegg-active-key.txt'), 'fixture-key-a\n');

    const dashboardPort = await freePort();
    const keepalivePort = await freePort();
    const converterPort = await freePort();
    let output = '';
    const childEnv = {
        ...process.env,
        NODE_PATH: [process.env.NODE_PATH || '', repoNodeModules].filter(Boolean).join(path.delimiter),
        HOME: dir,
        USERPROFILE: dir,
        SWITCHER_PORT: String(dashboardPort),
        FG_KEEPALIVE_PORT: String(keepalivePort),
        FG_CONVERTER_PORT: String(converterPort),
        FRONTDOOR_PORT: String(await freePort()),
        AR_KEEPALIVE_PORT: String(await freePort()),
        AR_PROXY_PORT: String(await freePort()),
        SWITCHER_NO_BOOT_CHILDREN: '1',
    };
    const child = spawn(process.execPath, [path.join(routing, 'transparent-proxy.js')], {
        cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
    });
    child.stdout.on('data', c => output += c);
    child.stderr.on('data', c => output += c);
    try {
        await waitFor(async () => (await request(dashboardPort, 'GET', '/__switch/api/fg/rate-policy')).status === 200,
            'dashboard readiness');
        let r = await request(dashboardPort, 'GET', '/__switch/api/fg/rate-policy');
        assert.equal(r.status, 200); assert.equal(r.data.enabled, false); assert.equal(r.data.scope, 'off');
        r = await request(dashboardPort, 'POST', '/__switch/api/fg/rate-policy', { enabled: true }, {
            'content-type': 'text/plain', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site',
        });
        assert.equal(r.status, 403, 'cross-site writes must be refused before restart or persistence');
        assert.equal(fs.existsSync(configPath), false, 'rejected cross-site write must not create config');
        r = await request(dashboardPort, 'POST', '/__switch/api/fg/rate-policy', { enabled: true }, {
            'content-type': 'text/plain',
        });
        assert.equal(r.status, 415, 'plain-body writes must not bypass browser preflight');
        assert.equal(fs.existsSync(configPath), false, 'rejected plain write must not create config');
        r = await request(dashboardPort, 'POST', '/__switch/api/fg/rate-policy', {});
        assert.equal(r.status, 400, 'missing boolean must fail closed');
        r = await request(dashboardPort, 'POST', '/__switch/api/fg/rate-policy', { enabled: true });
        assert.equal(r.status, 200, r.text + '\n' + output); assert.equal(r.data.enabled, true); assert.equal(r.data.scope, 'account'); assert.equal(r.data.restarted, true);
        assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).enabled, true);
        const state = await waitFor(async () => {
            const x = await request(keepalivePort, 'GET', '/__state');
            return x.status === 200 && x.data;
        }, 'FreeGG keepalive state');
        assert.equal(state.rateBalance.enabled, true); assert.equal(state.rateBalance.scope, 'account');
        r = await request(dashboardPort, 'POST', '/__switch/api/fg/rate-policy', { enabled: false });
        assert.equal(r.status, 200, r.text); assert.equal(r.data.enabled, false); assert.equal(r.data.scope, 'off');
        const stateOff = await waitFor(async () => {
            const x = await request(keepalivePort, 'GET', '/__state');
            return x.status === 200 && x.data && x.data.rateBalance.enabled === false && x.data;
        }, 'FreeGG keepalive off state');
        assert.equal(stateOff.rateBalance.scope, 'off');

        // Новая dashboard-сессия читает прежний выбор с диска: после включения
        // состояние переживает рестарт управляющего процесса, а не только ребёнка.
        r = await request(dashboardPort, 'POST', '/__switch/api/fg/rate-policy', { enabled: true });
        assert.equal(r.status, 200, r.text);
        child.kill();
        await Promise.race([once(child, 'exit'), wait(3000)]).catch(() => {});
        const restartedDashboard = spawn(process.execPath, [path.join(routing, 'transparent-proxy.js')], {
            cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
        });
        restartedDashboard.stdout.on('data', c => output += c);
        restartedDashboard.stderr.on('data', c => output += c);
        await waitFor(async () => (await request(dashboardPort, 'GET', '/__switch/api/fg/rate-policy')).status === 200,
            'restarted dashboard readiness');
        r = await request(dashboardPort, 'GET', '/__switch/api/fg/rate-policy');
        assert.equal(r.data.enabled, true);
        assert.equal(r.data.scope, 'account');
        restartedDashboard.kill();
        await Promise.race([once(restartedDashboard, 'exit'), wait(3000)]).catch(() => {});

        // До появления persisted preference старые FG_RATE_* env продолжают работать.
        fs.rmSync(configPath, { force: true });
        const legacyEnv = { ...childEnv, FG_RATE_BALANCE: '1', FG_RATE_SCOPE: 'account' };
        const legacyDashboard = spawn(process.execPath, [path.join(routing, 'transparent-proxy.js')], {
            cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: legacyEnv,
        });
        legacyDashboard.stdout.on('data', c => output += c);
        legacyDashboard.stderr.on('data', c => output += c);
        await waitFor(async () => (await request(dashboardPort, 'GET', '/__switch/api/fg/rate-policy')).status === 200,
            'legacy env dashboard readiness');
        r = await request(dashboardPort, 'GET', '/__switch/api/fg/rate-policy');
        assert.equal(r.data.enabled, true, 'FG_RATE_BALANCE=1 must remain compatible without a preference file');
        assert.equal(r.data.scope, 'account');
        legacyDashboard.kill();
        await Promise.race([once(legacyDashboard, 'exit'), wait(3000)]).catch(() => {});

        // Повреждённый preference не может сам включить функцию: чтение fail-closed.
        fs.writeFileSync(configPath, '{broken json');
        const corruptDashboard = spawn(process.execPath, [path.join(routing, 'transparent-proxy.js')], {
            cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
        });
        corruptDashboard.stdout.on('data', c => output += c);
        corruptDashboard.stderr.on('data', c => output += c);
        await waitFor(async () => (await request(dashboardPort, 'GET', '/__switch/api/fg/rate-policy')).status === 200,
            'corrupt config dashboard readiness');
        r = await request(dashboardPort, 'GET', '/__switch/api/fg/rate-policy');
        assert.equal(r.data.enabled, false);
        assert.equal(r.data.scope, 'off');
        corruptDashboard.kill();
        await Promise.race([once(corruptDashboard, 'exit'), wait(3000)]).catch(() => {});

        // Для следующего failure-теста снова поднимаем управляющий процесс с OFF.
        fs.writeFileSync(configPath, JSON.stringify({ enabled: false, scope: 'off' }));
        const failureDashboard = spawn(process.execPath, [path.join(routing, 'transparent-proxy.js')], {
            cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
        });
        failureDashboard.stdout.on('data', c => output += c);
        failureDashboard.stderr.on('data', c => output += c);
        await waitFor(async () => (await request(dashboardPort, 'GET', '/__switch/api/fg/rate-policy')).status === 200,
            'failure fixture dashboard readiness');

        // Переключатель fail-closed: если новый keepalive не стартовал, API обязан
        // вернуть прежнее состояние, а файл не должен остаться в новом значении.
        const brokenScript = path.join(routing, 'keepalive-proxy.js');
        const goodScript = fs.readFileSync(brokenScript);
        fs.writeFileSync(brokenScript, 'process.exit(23);\n');
        r = await request(dashboardPort, 'POST', '/__switch/api/fg/rate-policy', { enabled: true });
        assert.equal(r.status, 502, r.text);
        assert.equal(r.data.ok, false);
        assert.equal(r.data.enabled, false);
        assert.equal(r.data.scope, 'off');
        assert.equal(r.data.rolledBack, true);
        assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).enabled, false);
        fs.writeFileSync(brokenScript, goodScript);
        failureDashboard.kill();
        await Promise.race([once(failureDashboard, 'exit'), wait(3000)]).catch(() => {});
        console.log('check-freegg-rate-toggle: PASS');
    } catch (error) {
        error.message += '\nchild output:\n' + output.slice(-8000);
        throw error;
    } finally {
        child.kill();
        await Promise.race([once(child, 'exit'), wait(3000)]).catch(() => {});
        killFixturePort(keepalivePort);
        killFixturePort(converterPort);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) {
            if (!['EPERM', 'EBUSY'].includes(error && error.code)) throw error;
        }
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
