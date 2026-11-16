#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'routing', 'lifecycle.js');
const L = require(SOURCE);
test('optional occupied Node readiness failure never kills a replacement foreign holder by port', async () => {
    const svc = { port: 45205, name: 'fixture', script: 'transparent-proxy.js', ready: '/health', optional: true };
    const live = new Map([[svc.port, new Set([111])]]);
    const stopped = [];
    const result = await L.startServices([svc], {
        listeners: () => live, activeUpstreamPort: () => 0,
        verifyProcessOwnership: async (_svc, pid) => pid === 111,
        waitReady: async () => { live.set(svc.port, new Set([222])); return false; },
        stopService: async () => { assert.fail('must never kill by port'); },
        stopLaunched: async pid => { stopped.push(pid); return { freed: true }; },
    });
    assert.deepEqual(stopped, []);
    assert.equal(result.optionalFailures[0].code, 'readiness_failed');
});



test('required occupied Node with failed readiness is replaced by exact PID, not skipped as healthy', async () => {
    const svc = { port: 45208, name: 'required dashboard fixture', script: 'transparent-proxy.js', ready: '/health' };
    const live = new Map([[svc.port, new Set([111])]]);
    const stopped = [];
    let launches = 0;
    const result = await L.startServices([svc], {
        listeners: () => live, activeUpstreamPort: () => 0,
        verifyProcessOwnership: async (_svc, pid) => [111, 333].includes(pid),
        waitReady: async () => live.get(svc.port)?.has(333) || false,
        startService: async () => { launches++; live.set(svc.port, new Set([333])); return 333; },
        stopLaunched: async pid => { stopped.push(pid); live.delete(svc.port); return { freed: true }; },
        stopService: async () => { assert.fail('must never kill by port'); },
        sleep: async () => {}, maxPortPolls: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(launches, 1);
    assert.deepEqual(stopped, [111]);
    assert.equal(result.started[0].pid, 333);
});

test('required readiness recovery refuses a replacement foreign holder without launching or killing it', async () => {
    const svc = { port: 45209, name: 'required dashboard fixture', script: 'transparent-proxy.js', ready: '/health' };
    const live = new Map([[svc.port, new Set([111])]]);
    const result = await L.startServices([svc], {
        listeners: () => live, activeUpstreamPort: () => 0,
        verifyProcessOwnership: async (_svc, pid) => pid === 111,
        waitReady: async () => { live.set(svc.port, new Set([222])); return false; },
        startService: async () => { assert.fail('occupied foreign port must not launch'); },
        stopLaunched: async () => { assert.fail('replacement foreign PID must not die'); },
        stopService: async () => { assert.fail('must never kill by port'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed.port, svc.port);
    assert.deepEqual([...live.get(svc.port)], [222]);
});

test('mac argv inspection fails closed on helper failure, malformed JSON, or ambiguous ps output', () => {
    for (const output of [{ status: 1, stdout: '' }, { status: 0, stdout: 'bad' },
        { status: 0, stdout: '{"executable":"/node","argv":"node script"}' }]) {
        const mac = platformLifecycle('darwin', (exe, args) => {
            assert.notEqual(exe, 'ps');
            return output;
        });
        assert.equal(mac.pidExecutable(123), '');
        assert.equal(mac.pidArguments(123).length, 0);
    }
});

test('Linux argv retains empty arguments and never falls back to ambiguous ps', () => {
    const linux = platformLifecycle('linux', () => { assert.fail('no ps fallback'); }, file => {
        if (String(file).endsWith('/cmdline')) return Buffer.from('/usr/bin/node\0/space dir/script.js\0\0arg\0');
        return fs.readFileSync(file);
    });
    assert.deepEqual(Array.from(linux.pidArguments(123)), ['/usr/bin/node', '/space dir/script.js', '', 'arg']);
    const denied = platformLifecycle('linux', () => { assert.fail('no ps fallback'); }, () => { throw Error('denied'); });
    assert.equal(denied.pidArguments(123), '');
});

test('actual Node lifecycle start twice, stop, start uses only fixture PID and leaves foreign server alive', async () => {
    const { spawn } = require('node:child_process');
    const net = require('node:net');
    const scratch = process.env.TMPDIR || os.tmpdir();
    const dir = fs.mkdtempSync(path.join(scratch, 'mac lifecycle space-'));
    const script = path.join(dir, 'own script.js');
    fs.writeFileSync(script, "require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.argv[2]),'127.0.0.1');");
    const foreign = net.createServer();
    await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
    const free = net.createServer();
    await new Promise(resolve => free.listen(0, '127.0.0.1', resolve));
    const port = free.address().port;
    await new Promise(resolve => free.close(resolve));
    const svc = { port, name: 'spaced own fixture', script, args: [String(port)], ready: '/' };
    let launches = 0;
    const children = [];
    const adapters = {
        activeUpstreamPort: () => 0,
        startService: async () => {
            launches++;
            const child = spawn(process.execPath, [script, String(port)], { windowsHide: true, stdio: 'ignore' });
            children.push(child);
            await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
            return child.pid;
        },
    };
    try {
        const first = await L.startServices([svc], adapters);
        assert.equal(first.ok, true);
        const second = await L.startServices([svc], adapters);
        assert.equal(second.ok, true);
        assert.equal(launches, 1);
        assert.equal(second.started.length, 0);
        const stop = await L.stopServices([svc], { children: [], drainAll: async () => {} });
        assert.equal(stop.stuck.length, 0);
        assert.equal(L.listeners().has(port), false);
        assert.equal(foreign.listening, true);
        assert.equal((await L.startServices([svc], adapters)).ok, true);
        assert.equal(launches, 2);
        assert.equal((await L.stopServices([svc], { children: [], drainAll: async () => {} })).stuck.length, 0);
        assert.equal(foreign.listening, true);
    } finally {
        for (const child of children) await L.stopLaunched(child.pid);
        await new Promise(resolve => foreign.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('startup cannot report success when a foreign listener replaces the owned PID during readiness', async () => {
    const svc = { port: 45206, name: 'fixture', script: 'transparent-proxy.js', ready: '/health' };
    const live = new Map();
    const stopped = [];
    const result = await L.startServices([svc], {
        listeners: () => live, activeUpstreamPort: () => 0,
        startService: async () => { live.set(svc.port, new Set([111])); return 111; },
        verifyProcessOwnership: async (_svc, pid) => pid === 111,
        waitReady: async () => { live.set(svc.port, new Set([222])); return true; },
        stopLaunched: async pid => { stopped.push(pid); return { freed: true }; },
        sleep: async () => {}, maxPortPolls: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.started.length, 0);
    assert.deepEqual(stopped, [111]);
});

test('doctor completes its report without LOCALAPPDATA on a simulated Mac', () => {
    const { spawnSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mac-doctor-'));
    const tools = path.join(dir, 'tools');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(tools); fs.mkdirSync(bin);
    fs.copyFileSync(path.join(ROOT, 'tools', 'doctor.sh'), path.join(tools, 'doctor.sh'));
    for (const cmd of ['uname', 'git', 'node', 'npm', 'py', 'python', 'python3', 'curl', 'lsof', 'sqlite3', 'cmd.exe', 'find', 'open', 'notepad']) {
        fs.writeFileSync(path.join(bin, cmd), '#!/usr/bin/env bash\n' + (cmd === 'uname' ? 'printf "Darwin\\n"\n' : 'exit 0\n'));
        fs.chmodSync(path.join(bin, cmd), 0o755);
    }
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, PATH: `${bin.replace(/\\/g, '/')}:${process.env.PATH}` };
    delete env.LOCALAPPDATA;
    try {
        const result = spawnSync('bash', [path.join(tools, 'doctor.sh').replace(/\\/g, '/')], { env, encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr);
        const report = fs.readFileSync(path.join(dir, 'logs', 'doctor-report.txt'), 'utf8');
        assert.match(report, /===== КОНЕЦ =====/);
        assert.doesNotMatch(report, /unbound variable/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Custom cleanup receives the boundary-preserving platform identity adapters', async () => {
    let called = false;
    const mac = platformLifecycle('darwin', () => ({ status: 1 }), fs.readFileSync, async (_descriptor, adapters) => {
        called = true;
        assert.equal(adapters.pidArguments, mac.pidArguments);
        assert.equal(adapters.pidExecutable, mac.pidExecutable);
        return { freed: true };
    });
    const result = await mac.stopServices([], { children: [{ port: 45207, name: 'Custom fixture', customProcess: { port: 45207 } }],
        listeners: () => new Map(), drainAll: async () => {} });
    assert.equal(called, true);
    assert.equal(result.stuck.length, 0);
});

// Run real platform branches with only the unavailable OS seam replaced.
function platformLifecycle(platform, run, read = fs.readFileSync, customCleanup = null) {
    const source = fs.readFileSync(SOURCE, 'utf8');
    const sandbox = {
        module: { exports: {} }, __dirname: path.dirname(SOURCE), Buffer,
        process: { ...process, platform }, console, setTimeout, clearTimeout,
        require: name => name === 'child_process' ? { ...require(name), spawnSync: run }
            : name === 'fs' ? { ...fs, readFileSync: read }
            : name === 'path' ? path.posix
            : name === './lib/custom-process-ownership' && customCleanup ? { ...require(path.resolve(path.dirname(SOURCE), name)), cleanupCustomProcess: customCleanup }
            : name.startsWith('./') ? require(path.resolve(path.dirname(SOURCE), name)) : require(name),
    };
    vm.runInNewContext(source, sandbox, { filename: SOURCE });
    return sandbox.module.exports;
}

test('mac ownership reads boundary-preserving kernel argv, never space-joined BSD ps', async () => {
    const script = '/Users/mac/Abuse Hub/routing/transparent-proxy.js';
    const calls = [];
    const mac = platformLifecycle('darwin', (exe, args) => {
        calls.push([exe, args]);
        if (exe === 'ps') return { status: 0, stdout: args.includes('comm=')
            ? '/opt/homebrew/Cellar/node/26.3.0/bin/node\n'
            : `/opt/homebrew/bin/node ${script}\n` };
        if (/python3$/.test(exe)) return { status: 0, stdout: JSON.stringify({
            executable: '/opt/homebrew/Cellar/node/26.3.0/bin/node',
            argv: ['/opt/homebrew/bin/node', script, 'extra arg', ''],
        }) };
        return { status: 1, stdout: '' };
    });
    const args = mac.pidArguments(123);
    assert.deepEqual(Array.from(args), ['/opt/homebrew/bin/node', script, 'extra arg', '']);
    assert.equal(mac.pidExecutable(123), '/opt/homebrew/Cellar/node/26.3.0/bin/node');
    assert.equal(await mac.verifyProcessOwnership({ script }, 123), true);
    assert.equal(mac.isOursForService({ script }, 'node', '/opt/homebrew/bin/node', `/opt/homebrew/bin/node ${script}`), false);
    assert.equal(calls.some(([exe, args]) => exe === 'ps' && args.includes('command=')), false);
});

test('Node ownership refuses entrypoint spoofing by extra args, preload, eval, unknown flags, or relative paths', () => {
    const svc = { script: 'transparent-proxy.js' };
    const own = path.join(ROOT, 'routing', svc.script);
    const check = args => L.isOursForService(svc, path.basename(process.execPath), process.execPath, args);
    assert.equal(check([process.execPath, own]), true);
    for (const args of [
        [process.execPath, '/foreign.js', own],
        [process.execPath, '--require', own, '/foreign.js'],
        [process.execPath, '--eval', own],
        [process.execPath, '--eval=' + own],
        [process.execPath, '--run', own],
        [process.execPath, '--unknown', own],
        [process.execPath, 'transparent-proxy.js'],
    ]) assert.equal(check(args), false, JSON.stringify(args));
});

test('stop never kills or drains a holder that appears on an initially empty port', async () => {
    const svc = { port: 45201, name: 'fixture', script: 'transparent-proxy.js' };
    let reads = 0;
    const result = await L.stopServices([svc], {
        children: [],
        listeners: () => ++reads === 1 ? new Map() : new Map([[svc.port, new Set([999])]]),
        killPort: async () => { assert.fail('blind killPort'); },
        stopLaunched: async () => { assert.fail('nothing was owned'); },
        drainAll: async ports => { assert.deepEqual(ports, []); },
    });
    assert.equal(result.stuck.length, 1);
    assert.equal(result.stuck[0].foreign, true);
});

test('raw and unknown child descriptors fail closed rather than defaulting to keepalive', async () => {
    const known = L.childServiceDescriptors([{ port: 8300, name: 'legacy' }])[0];
    assert.equal(known.script, 'transparent-proxy.js');
    const explicit = { port: 45202, name: 'explicit', script: 'frontdoor-proxy.js' };
    assert.equal(L.childServiceDescriptors([explicit])[0].script, explicit.script);
    assert.equal(L.childServiceDescriptors([{ port: 45203, name: 'unknown' }])[0].script, undefined);
    const result = await L.stopServices([], {
        phase: 'stop', children: [{ port: 45203, name: 'unknown' }],
        listeners: () => new Map([[45203, new Set([999])]]),
        killPort: async () => { assert.fail('unknown child must not kill by port'); },
        drainAll: async ports => { assert.deepEqual(ports, []); },
    });
    assert.equal(result.stuck[0].foreign, true);
});

test('stop reports a replacement foreign listener after exact owned PID exits', async () => {
    const svc = { port: 45204, name: 'fixture', script: 'transparent-proxy.js' };
    const live = new Map([[svc.port, new Set([111])]]);
    const killed = [];
    const result = await L.stopServices([svc], {
        children: [], listeners: () => live, verifyProcessOwnership: async (_s, pid) => pid === 111,
        drainAll: async () => {},
        stopLaunched: async pid => { killed.push(pid); live.set(svc.port, new Set([222])); return { freed: true }; },
        killPort: async () => { assert.fail('foreign replacement'); },
    });
    assert.deepEqual(killed, [111]);
    assert.equal(result.stuck.length, 1);
    assert.equal(result.stuck[0].foreign, true);
    assert.deepEqual(result.stuck[0].holding, [222]);
});
