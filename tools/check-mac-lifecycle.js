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
test('optional launch failure carries its real error code into the event, not a generic label', async () => {
    // Живой случай 16.11.2026: Bifrost не стартовал из-за bifrost_catalog_invalid
    // (пины каталогов не совпадали с файлами), но optionalFailure отдавал наружу
    // фиксированное 'launch_failed' / «запуск sidecar не удался». Снаружи — безликое
    // «OpenAI sidecar недоступен», и человек искал сеть и порты вместо пинов.
    const svc = { port: 45209, name: 'bifrost fixture', script: 'transparent-proxy.js', ready: '/health', optional: true };
    const events = [];
    const failure = Object.assign(new Error('Pinned Bifrost catalog failed identity verification'),
        { code: 'bifrost_catalog_invalid' });
    const result = await L.startServices([svc], {
        listeners: () => new Map(), activeUpstreamPort: () => 0,
        verifyProcessOwnership: async () => false,
        waitReady: async () => false,
        startService: async () => { throw failure; },
        stopLaunched: async () => ({ freed: true }),
        stopService: async () => { assert.fail('must never kill by port'); },
        on: event => events.push(event),
    });
    assert.equal(result.optionalFailures.length, 1);
    assert.equal(result.optionalFailures[0].code, 'bifrost_catalog_invalid');
    assert.match(result.optionalFailures[0].text, /пины каталогов/);
    const ev = events.find(e => e.type === 'start-optional-failed');
    assert.ok(ev, 'no start-optional-failed event');
    assert.equal(ev.code, 'bifrost_catalog_invalid');
    assert.match(ev.text, /пины каталогов/);
    // Причина доехала, но путь из error.message наружу НЕ попал.
    assert.equal(JSON.stringify({ result, events }).includes('/private/'), false);
});

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

test('Windows utility gate recognizes the Win32-only process snapshot call boundary', () => {
    assert.deepEqual(windowsUtilityGate(fs.readFileSync(SOURCE, 'utf8')), []);
});

test('Windows utility gate rejects unguarded snapshot calls, escaping references, and unrelated utilities', () => {
    const life = fs.readFileSync(SOURCE, 'utf8');
    const boundary = "const table = process.platform === 'win32' ? createProcessTable() : null;";
    assert.ok(life.includes(boundary), 'exercise the actual process snapshot callsite');
    for (const unsafe of [
        life.replace(boundary, 'const table = createProcessTable();'),
        life + '\ncreateProcessTable().executable(123);\n',
        life + '\nmodule.exports.snapshotFactory = createProcessTable;\n',
        life + "\nspawnSync('powershell', ['-NoProfile']);\n",
    ]) {
        const failures = windowsUtilityGate(unsafe, '');
        assert.equal(failures.length, 1);
        assert.equal(failures[0].name, 'Windows-утилиты вне гейта');
        assert.match(failures[0].why, /routing\/lifecycle\.js:\d+/);
    }
});

test('Windows utility gate does not treat an IS_WIN comment as a platform boundary', () => {
    const life = fs.readFileSync(SOURCE, 'utf8')
        .replace("const table = process.platform === 'win32' ? createProcessTable() : null;", 'const table = createProcessTable();')
        .replace('function createProcessTable() {', 'function createProcessTable() {\n    // IS_WIN is only a comment, not a guard.');
    assert.equal(windowsUtilityGate(life, '').length, 1);
});

for (const platform of ['darwin', 'linux']) {
    test(`${platform} verified status uses platform identity without invoking Windows utilities`, async () => {
        const script = '/hub platform/own script.js';
        const identities = new Map([
            [701, { executable: '/usr/bin/node', argv: ['/usr/bin/node', script, 'extra arg', ''] }],
            [702, { executable: '/usr/bin/node', argv: ['/usr/bin/node', '/foreign.js', script] }],
            [703, { executable: '/hub platform/tool', argv: ['/hub platform/tool'] }],
            [704, { executable: '/foreign/tool', argv: ['/foreign/tool'] }],
        ]);
        const calls = [];
        const lifecycle = platformLifecycle(platform, (exe, args) => {
            calls.push(exe);
            if (exe === 'ps') return { status: 0, stdout: identities.get(Number(args[1])).executable };
            if (platform === 'darwin' && exe === '/usr/bin/python3') {
                return { status: 0, stdout: JSON.stringify(identities.get(Number(args.at(-1)))) };
            }
            if (platform === 'linux' && exe === 'readlink') {
                return { status: 0, stdout: identities.get(Number(args[0].split('/')[2])).executable };
            }
            assert.fail(`unexpected platform executable: ${exe}`);
        }, file => {
            const match = String(file).match(/^\/proc\/(\d+)\/cmdline$/);
            return match ? Buffer.from(identities.get(Number(match[1])).argv.join('\0') + '\0') : fs.readFileSync(file);
        });
        const services = [
            { port: 45211, name: 'own Node', script },
            { port: 45212, name: 'own executable', executable: '/hub platform/tool', imageName: 'tool' },
            { port: 45213, name: 'foreign executable', executable: '/hub platform/tool', imageName: 'tool' },
        ];
        const rows = await lifecycle.statusVerified({
            services, childItems: [{ port: 45214, name: 'foreign child', script }], customItems: [],
            listeners: () => new Map([[45211, new Set([701])], [45212, new Set([703])],
                [45213, new Set([704])], [45214, new Set([702])]]), activeUpstreamPort: () => 0,
        });
        assert.deepEqual(Array.from(rows, row => [row.name, row.up, row.foreign]), [
            ['own Node', true, false], ['own executable', true, false],
            ['foreign executable', false, true], ['foreign child', false, true],
        ]);
        assert.deepEqual(Array.from(lifecycle.pidArguments(701)), identities.get(701).argv);
        assert.equal(lifecycle.pidExecutable(703), '/hub platform/tool');
        assert.equal(calls.some(exe => /powershell|tasklist|taskkill|netstat/i.test(exe)), false);
    });
}

test('Windows verified status caches one lazy snapshot per scope and preserves executable and command line identity', async () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const script = 'C:\\hub platform\\own script.js';
    const tool = 'C:\\hub platform\\tool.exe';
    const commandLine = `"${node}" "${script}" "extra arg" ""`;
    const records = [
        { ProcessId: 701, ExecutablePath: node, CommandLine: commandLine },
        { ProcessId: 702, ExecutablePath: node, CommandLine: `"${node}" "C:\\foreign.js" "${script}"` },
        { ProcessId: 703, ExecutablePath: tool, CommandLine: `"${tool}"` },
        { ProcessId: 704, ExecutablePath: 'C:\\foreign\\tool.exe', CommandLine: '"C:\\foreign\\tool.exe"' },
    ];
    const calls = [];
    const windows = platformLifecycle('win32', (exe, args, options) => {
        calls.push(exe);
        assert.equal(exe, 'powershell');
        assert.deepEqual(Array.from(args), ['-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress']);
        assert.equal(options.encoding, 'utf8');
        assert.equal(options.windowsHide, true);
        assert.equal(options.maxBuffer, 32 * 1024 * 1024);
        return { status: 0, stdout: JSON.stringify(records) };
    });
    const map = new Map([[45211, new Set([701])], [45212, new Set([703])],
        [45213, new Set([704])], [45214, new Set([702])]]);
    const options = {
        services: [{ port: 45211, name: 'own Node', script },
            { port: 45212, name: 'own executable', executable: tool, imageName: 'tool.exe' },
            { port: 45213, name: 'foreign executable', executable: tool, imageName: 'tool.exe' }],
        childItems: [{ port: 45214, name: 'foreign child', script }], customItems: [],
        listeners: () => map, activeUpstreamPort: () => 0,
        verifyProcessOwnership: async (svc, pid, adapters) => {
            const record = records.find(row => row.ProcessId === pid);
            assert.equal(adapters.pidExecutable(pid), record.ExecutablePath);
            assert.equal(adapters.pidArguments(pid), record.CommandLine);
            return windows.verifyProcessOwnership(svc, pid, adapters);
        },
    };
    assert.equal(calls.length, 0, 'snapshot creation is lazy');
    assert.deepEqual(Array.from(await windows.statusVerified(options), row => [row.name, row.up, row.foreign]), [
        ['own Node', true, false], ['own executable', true, false],
        ['foreign executable', false, true], ['foreign child', false, true],
    ]);
    assert.deepEqual(calls, ['powershell'], 'all services and children share one snapshot');
    records[0] = { ProcessId: 705, ExecutablePath: node, CommandLine: commandLine };
    map.set(45211, new Set([705]));
    assert.equal((await windows.statusVerified(options))[0].up, true, 'a later scope sees the new PID');
    assert.deepEqual(calls, ['powershell', 'powershell']);
    await windows.statusVerified({ ...options, listeners: () => new Map() });
    assert.equal(calls.length, 2, 'an empty verification scope needs no snapshot');
});

function windowsUtilityGate(life, hub = fs.readFileSync(path.join(ROOT, 'hub.js'), 'utf8')) {
    const gatePath = path.join(ROOT, 'tools', 'check-hub.js');
    const source = fs.readFileSync(gatePath, 'utf8');
    const start = source.indexOf('    const guilty = [];', source.indexOf('function macReady() {'));
    const end = source.indexOf('    // Браузер и установщик', start);
    assert.ok(start >= 0 && end > start, 'the actual Windows utility gate must be present');
    const failures = [];
    let passed = 0;
    vm.runInNewContext(source.slice(start, end), {
        life, hub, ok: () => { passed++; },
        bad: (name, why) => failures.push({ name, why }),
    }, { filename: gatePath });
    assert.equal(passed + failures.length, 1, 'the actual gate must return one verdict');
    return failures;
}

// Run real platform branches with only the unavailable OS seam replaced.
function platformLifecycle(platform, run, read = fs.readFileSync, customCleanup = null) {
    const source = fs.readFileSync(SOURCE, 'utf8');
    const sandbox = {
        module: { exports: {} }, __dirname: path.dirname(SOURCE), Buffer,
        process: { ...process, platform }, console, setTimeout, clearTimeout,
        require: name => name === 'child_process' ? { ...require(name), spawnSync: run }
            : name === 'fs' ? { ...fs, readFileSync: read }
            : name === 'path' ? (platform === 'win32' ? path.win32 : path.posix)
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

test('Linux identifies Node by its executable when comm is node-MainThread', { skip: process.platform !== 'linux' }, async () => {
    const script = 'transparent-proxy.js';
    const argv = ['/usr/bin/node', path.join(ROOT, 'routing', script)];
    const adapters = {
        pidImage: () => 'node-MainThread',
        pidExecutable: () => '/usr/bin/node',
        pidArguments: () => argv,
    };
    assert.equal(await L.verifyProcessOwnership({ script }, 123, adapters), true);
    assert.equal(await L.verifyProcessOwnership({ script: 'other.js' }, 123, adapters), false);
    assert.equal(await L.verifyProcessOwnership({ script }, 123, {
        ...adapters, pidExecutable: () => '/usr/bin/bash',
    }), false);
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
