#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ROUTING = path.join(ROOT, 'routing');
const LIFECYCLE = path.join(ROUTING, 'lifecycle.js');
const TRANSPARENT = path.join(ROUTING, 'transparent-proxy.js');
const OWNERSHIP = path.join(ROUTING, 'lib', 'custom-process-ownership.js');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let passed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok  ${name}`);
    } catch (error) {
        console.error(`  FAIL ${name}\n       ${error.stack || error.message}`);
        process.exitCode = 1;
    }
}

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopChild(child) {
    if (!child || !alive(child.pid)) return;
    const exited = once(child, 'exit').catch(() => []);
    try { child.kill(); } catch { /* already gone */ }
    await Promise.race([exited, wait(1500)]);
    if (alive(child.pid) && process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
    } else if (alive(child.pid)) {
        try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (let i = 0; i < 30 && alive(child.pid); i += 1) await wait(25);
}

function request(port, pathname = '/ping', headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: pathname, headers, timeout: 1500 }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
    });
}

function writeFixture(file, identity) {
    fs.writeFileSync(file, `'use strict';\n`
        + `const http = require('node:http');\n`
        + `const port = Number(process.argv[2] || 0);\n`
        + `const identity = ${JSON.stringify(identity)};\n`
        + `const server = http.createServer((req, res) => {\n`
        + `  if (req.url === '/ping') { res.end('alive'); return; }\n`
        + `  const body = JSON.stringify({ ...identity, ok: true, pid: process.pid, port: server.address().port });\n`
        + `  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });\n`
        + `  res.end(body);\n`
        + `});\n`
        + `server.listen(port, '127.0.0.1', () => process.stdout.write('READY ' + server.address().port + '\\n'));\n`
        + `process.on('SIGTERM', () => server.close(() => process.exit(0)));\n`, 'utf8');
}

function startFixture(script, port, children) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, String(port)], {
            cwd: path.dirname(script), env: { ...process.env, NODE_OPTIONS: '' },
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
        children.push(child);
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`fixture readiness timeout: ${stderr}`)), 5000);
        child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
        child.stdout.on('data', chunk => {
            stdout += chunk.toString('utf8');
            const match = stdout.match(/READY (\d+)/);
            if (!match) return;
            clearTimeout(timer);
            resolve({ child, port: Number(match[1]) });
        });
        child.once('exit', code => {
            if (!/READY \d+/.test(stdout)) {
                clearTimeout(timer);
                reject(new Error(`fixture exited ${code}: ${stderr}`));
            }
        });
    });
}

function staleProvider(port, stalePid, temp) {
    return {
        id: 'fixture-provider',
        name: 'Fixture Provider',
        baseUrl: 'http://127.0.0.1:9/v1',
        proxyPort: port,
        proxyPid: stalePid,
        adapterPort: 0,
        adapterPid: 0,
        __ownershipOptions: {
            routingDir: ROUTING,
            configFile: path.join(temp, 'fixture-provider.json'),
        },
    };
}

function staleDescriptor(port, stalePid, foreignScript) {
    return {
        role: 'adapter',
        pid: stalePid,
        port,
        providerId: 'fixture-provider',
        providerName: 'Fixture Provider',
        expectedUpstream: 'http://127.0.0.1:9/v1',
        scriptPath: foreignScript + '.expected-owner',
        configPath: foreignScript + '.expected-config',
        statusPath: '/__custom/api/status',
    };
}

(async () => {
    console.log('check-custom-ownership-boundary:');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-ownership-'));
    const children = [];
    const ownerScript = path.join(temp, 'owned-listener.js');
    const foreignScript = path.join(temp, 'foreign-listener.js');
    writeFixture(ownerScript, {
        role: 'adapter', providerId: 'fixture-provider', provider: 'Fixture Provider',
        upstream: 'http://127.0.0.1:9/v1',
    });
    writeFixture(foreignScript, {
        role: 'foreign', providerId: 'foreign', provider: 'Foreign Listener',
        upstream: 'http://127.0.0.1:1/v1',
    });

    try {
        await test('lifecycle stop never kills a foreign listener on a stale Custom port', async () => {
            const first = await startFixture(ownerScript, 0, children);
            const stalePid = first.child.pid;
            const port = first.port;
            await stopChild(first.child);
            const foreign = await startFixture(foreignScript, port, children);
            const lifecycle = require(LIFECYCLE);
            let portKills = 0;
            let drainedPorts = null;
            const result = await lifecycle.stopServices([], {
                phase: 'stop',
                children: [{
                    port, name: 'stale Custom adapter', respawn: false,
                    customProcess: staleDescriptor(port, stalePid, foreignScript),
                }],
                killPort: async () => { portKills += 1; return { port, freed: true, denied: false }; },
                drainAll: async ports => { drainedPorts = ports; return { asked: 0, inflight: 0, freed: 0 }; },
            });
            assert.deepEqual(drainedPorts, [], 'lifecycle sent an unauthenticated drain to an unverified Custom listener');
            assert.equal(portKills, 0, 'lifecycle fell back to kill-by-port');
            assert.equal((await request(port)).body, 'alive', 'foreign child was terminated');
            assert.equal(result.results[0].foreign, true);
            await stopChild(foreign.child);
        });

        await test('boot sweep uses shared ownership cleanup and preserves a reused foreign port', async () => {
            assert.ok(fs.existsSync(OWNERSHIP), 'shared Custom ownership module is missing');
            const ownership = require(OWNERSHIP);
            const first = await startFixture(ownerScript, 0, children);
            const stalePid = first.child.pid;
            const port = first.port;
            await stopChild(first.child);
            const foreign = await startFixture(foreignScript, port, children);
            const provider = staleProvider(port, stalePid, temp);
            const result = await ownership.sweepInactiveCustomTopologies([provider], 0, {
                descriptorFactory: () => [staleDescriptor(port, stalePid, foreignScript)],
            });
            assert.equal(result.length, 1);
            assert.equal(result[0].foreign, true);
            assert.equal((await request(port)).body, 'alive');
            await stopChild(foreign.child);
        });

        await test('manual Custom cleanup preserves a reused foreign port', async () => {
            assert.ok(fs.existsSync(OWNERSHIP), 'shared Custom ownership module is missing');
            const ownership = require(OWNERSHIP);
            const first = await startFixture(ownerScript, 0, children);
            const stalePid = first.child.pid;
            const port = first.port;
            await stopChild(first.child);
            const foreign = await startFixture(foreignScript, port, children);
            const result = await ownership.cleanupCustomTopology(staleProvider(port, stalePid, temp), {
                descriptorFactory: () => [staleDescriptor(port, stalePid, foreignScript)],
            });
            assert.equal(result.ok, false);
            assert.equal(result.foreign, true);
            assert.equal((await request(port)).body, 'alive');
            await stopChild(foreign.child);
        });

        await test('active Custom recreate fails closed and does not spawn over a reused foreign port', async () => {
            assert.ok(fs.existsSync(OWNERSHIP), 'shared Custom ownership module is missing');
            const ownership = require(OWNERSHIP);
            const first = await startFixture(ownerScript, 0, children);
            const stalePid = first.child.pid;
            const port = first.port;
            await stopChild(first.child);
            const foreign = await startFixture(foreignScript, port, children);
            let spawned = 0;
            const result = await ownership.recreateActiveCustomTopology(staleProvider(port, stalePid, temp), {
                descriptorFactory: () => [staleDescriptor(port, stalePid, foreignScript)],
                spawn: async () => { spawned += 1; return { ok: true }; },
            });
            assert.equal(result.ok, false);
            assert.equal(spawned, 0);
            assert.equal((await request(port)).body, 'alive');
            await stopChild(foreign.child);
        });

        await test('shared cleanup terminates only an exactly verified owned PID', async () => {
            assert.ok(fs.existsSync(OWNERSHIP), 'shared Custom ownership module is missing');
            const ownership = require(OWNERSHIP);
            const owner = await startFixture(ownerScript, 0, children);
            const result = await ownership.cleanupCustomProcess({
                role: 'adapter', pid: owner.child.pid, port: owner.port,
                providerId: 'fixture-provider', providerName: 'Fixture Provider',
                expectedUpstream: 'http://127.0.0.1:9/v1', scriptPath: ownerScript,
                statusPath: '/__custom/api/status',
            });
            assert.equal(result.ok, true, JSON.stringify(result));
            assert.equal(result.freed, true, JSON.stringify(result));
            assert.equal(result.pid, owner.child.pid);
            for (let i = 0; i < 40 && alive(owner.child.pid); i += 1) await wait(25);
            assert.equal(alive(owner.child.pid), false, 'verified owner remained alive');
        });

        await test('TOCTOU listener swap after first identity check never reaches exact termination', async () => {
            assert.ok(fs.existsSync(OWNERSHIP), 'shared Custom ownership module is missing');
            const ownership = require(OWNERSHIP);
            const owner = await startFixture(ownerScript, 0, children);
            const descriptor = {
                role: 'adapter', pid: owner.child.pid, port: owner.port,
                providerId: 'fixture-provider', providerName: 'Fixture Provider',
                expectedUpstream: 'http://127.0.0.1:9/v1', scriptPath: ownerScript,
                statusPath: '/__custom/api/status',
            };
            let checks = 0;
            let exactKills = 0;
            let foreign = null;
            const result = await ownership.cleanupCustomProcess(descriptor, {
                readStatus: async current => {
                    const response = await ownership.readProcessStatus(current);
                    checks += 1;
                    if (checks === 1) {
                        await stopChild(owner.child);
                        foreign = await startFixture(foreignScript, owner.port, children);
                    }
                    return response;
                },
                stopExactPid: async () => { exactKills += 1; return { freed: true, denied: false }; },
            });
            assert.equal(checks, 1, 'second check should stop at the replaced listener PID');
            assert.equal(exactKills, 0, 'cleanup terminated a PID after ownership changed');
            assert.equal(result.foreign, true);
            assert.equal((await request(owner.port)).body, 'alive');
            await stopChild(foreign.child);
        });

        await test('production descriptor generator binds PID, port, role, provider, upstream, adapter URL and config path', async () => {
            assert.ok(fs.existsSync(OWNERSHIP), 'shared Custom ownership module is missing');
            const ownership = require(OWNERSHIP);
            const configFile = path.join(temp, 'generated-config.json');
            const provider = {
                id: 'generated', name: 'Generated Provider', baseUrl: 'https://vendor.invalid/v1/',
                proxyPort: 31001, proxyPid: 41001, adapterPort: 31002, adapterPid: 41002,
            };
            const descriptors = ownership.buildCustomProcessDescriptors(provider, {
                routingDir: ROUTING, configFile,
            });
            assert.deepEqual(descriptors.map(item => item.role), ['keepalive', 'adapter']);
            assert.deepEqual(descriptors.map(item => item.pid), [41001, 41002]);
            assert.deepEqual(descriptors.map(item => item.port), [31001, 31002]);
            assert.equal(descriptors[0].providerId, provider.id);
            assert.equal(descriptors[0].providerName, provider.name);
            assert.equal(descriptors[0].expectedUpstream, 'http://127.0.0.1:31002');
            assert.equal(descriptors[0].adapterUrl, 'http://127.0.0.1:31002');
            assert.equal(descriptors[1].expectedUpstream, 'https://vendor.invalid/v1');
            assert.equal(descriptors[1].configPath, path.resolve(configFile));
        });

        await test('production lifecycle and dashboard paths delegate to the shared primitive', async () => {
            const lifecycleSource = fs.readFileSync(LIFECYCLE, 'utf8');
            const dashboardSource = fs.readFileSync(TRANSPARENT, 'utf8');
            assert.match(lifecycleSource, /buildCustomProcessDescriptors/);
            assert.match(lifecycleSource, /cleanupCustomProcess/);
            assert.match(dashboardSource, /cleanupCustomTopology/);
            const sweepStart = dashboardSource.indexOf('async function bootSweepStaleChildren');
            const sweepEnd = dashboardSource.indexOf('async function bootRecreateActiveCustomProxy', sweepStart);
            assert.ok(sweepStart >= 0 && sweepEnd > sweepStart);
            assert.match(dashboardSource.slice(sweepStart, sweepEnd), /customKillProxy|sweepInactiveCustomTopologies/);
            assert.match(dashboardSource.slice(sweepEnd, sweepEnd + 3500), /customKillProxy/);
        });
    } finally {
        for (const child of children.reverse()) await stopChild(child);
        fs.rmSync(temp, { recursive: true, force: true });
    }

    console.log(process.exitCode ? '\nFAILED' : `\nPASS (${passed})`);
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
