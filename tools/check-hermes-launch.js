#!/usr/bin/env node
'use strict';

// Real disposable child processes only; never launches the installed Hermes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { after, test } = require('node:test');

const LAUNCHER = path.join(__dirname, 'launch-hermes.js');
const scratch = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'hermes', 'cache', 'scratch')
    : process.env.TMPDIR || os.tmpdir();
fs.mkdirSync(scratch, { recursive: true });
const TMP = fs.mkdtempSync(path.join(scratch, 'hub-hermes-launch-'));
const FIXTURE = path.join(TMP, 'fake hermes.js');
const CWD = path.join(TMP, 'user project');
fs.mkdirSync(CWD);
fs.writeFileSync(FIXTURE, `
'use strict';
const fs = require('node:fs');
fs.writeFileSync(process.env.HUB_FIXTURE_CAPTURE, JSON.stringify({
    timeout: process.env.HERMES_TUI_RPC_TIMEOUT_MS,
    args: process.argv.slice(2), cwd: process.cwd(),
    home: process.env.HERMES_HOME,
    apiKey: process.env.OPENAI_API_KEY,
}));
process.exit(Number(process.env.HUB_FIXTURE_EXIT || 0));
`);

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function fixtureRun(args = [], extraEnv = {}) {
    const capture = path.join(TMP, 'capture.json');
    fs.rmSync(capture, { force: true });
    const env = {
        ...process.env, HUB_FIXTURE_CAPTURE: capture,
        HERMES_HOME: path.join(TMP, 'fixture home'),
        OPENAI_API_KEY: 'fixture-only-not-a-real-secret', ...extraEnv,
    };
    delete env.HERMES_TUI_RPC_TIMEOUT_MS;
    if (Object.hasOwn(extraEnv, 'HERMES_TUI_RPC_TIMEOUT_MS')) {
        env.HERMES_TUI_RPC_TIMEOUT_MS = extraEnv.HERMES_TUI_RPC_TIMEOUT_MS;
    }
    const driver = `require(${JSON.stringify(LAUNCHER)}).main(${JSON.stringify(args)}, {
        executable: process.execPath, prefixArgs: [${JSON.stringify(FIXTURE)}]
    });`;
    const result = spawnSync(process.execPath, ['-e', driver], {
        cwd: CWD, env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    return { result, capture: fs.existsSync(capture) ? JSON.parse(fs.readFileSync(capture, 'utf8')) : null };
}

test('unset timeout reaches the actual child as 660000', () => {
    assert.ok(fs.existsSync(LAUNCHER), 'tools/launch-hermes.js must exist');
    const { result, capture } = fixtureRun();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(capture.timeout, '660000');
    assert.deepEqual(capture.args, ['--tui']);
    assert.equal(capture.cwd, CWD);
});

test('explicit timeout and original arguments/environment remain byte-for-byte', () => {
    const args = ['--profile', 'fixture profile', '--resume', 'a"b & echo injected', '', '%PATH%', '$(touch nope)', 'x\\y\\', 'Ω'];
    for (const timeout of ['420000', '', 'invalid-user-value']) {
        const { result, capture } = fixtureRun(args, {
            HERMES_TUI_RPC_TIMEOUT_MS: timeout,
            HERMES_HOME: path.join(TMP, 'fixture profile'),
            OPENAI_API_KEY: 'fixture-only-not-a-real-secret',
            HUB_FIXTURE_EXIT: '23',
        });
        assert.equal(result.status, 23, result.stderr);
        assert.equal(capture.timeout, timeout);
        assert.deepEqual(capture.args, ['--tui', ...args]);
        assert.equal(capture.home, path.join(TMP, 'fixture profile'));
        assert.equal(capture.apiKey, 'fixture-only-not-a-real-secret');
        assert.equal(result.stdout + result.stderr, '', 'launcher must not print arguments or env');
    }
});

test('standalone --help prints portable usage without launching Hermes', () => {
    const { result, capture } = fixtureRun(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(capture, null, 'help must never spawn the fixture');
    assert.match(result.stdout, /node tools\/launch-hermes\.js \[args\]/);
    assert.match(result.stdout, /660000/);
    assert.match(result.stdout, /PowerShell/);
    assert.match(result.stdout, /Git Bash/);
});

test('Hermes --help can still be passed through after --', () => {
    const { result, capture } = fixtureRun(['--', '--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(capture.args, ['--tui', '--help']);
});

test('discovery reuses canonical PATH/install probes and chooses a native executable', () => {
    const { resolveExecutable } = require(LAUNCHER);
    const bin = path.join(TMP, 'native path');
    fs.mkdirSync(bin, { recursive: true });
    const native = path.join(bin, process.platform === 'win32' ? 'hermes.exe' : 'hermes');
    fs.copyFileSync(process.execPath, native);
    fs.chmodSync(native, 0o755);
    const options = { pathEnv: bin, home: path.join(TMP, 'absent home'), localAppData: path.join(TMP, 'absent local') };
    assert.equal(resolveExecutable(options), native);
    const capture = path.join(TMP, 'discovery.json');
    const env = {
        ...process.env, HUB_FIXTURE_CAPTURE: capture,
        HERMES_HOME: path.join(TMP, 'fixture home'),
        OPENAI_API_KEY: 'fixture-only-not-a-real-secret',
    };
    delete env.HERMES_TUI_RPC_TIMEOUT_MS;
    const driver = `require(${JSON.stringify(LAUNCHER)}).main(['--continue'], {
        installationOptions: ${JSON.stringify(options)}, prefixArgs: [${JSON.stringify(FIXTURE)}]
    });`;
    const result = spawnSync(process.execPath, ['-e', driver], { cwd: CWD, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.equal(actual.timeout, '660000');
    assert.deepEqual(actual.args, ['--tui', '--continue']);
});

test('Windows cmd probes select sibling native exe without invoking cmd.exe', { skip: process.platform !== 'win32' }, () => {
    const { resolveExecutable } = require(LAUNCHER);
    const home = path.join(TMP, 'cmd-home');
    const bin = path.join(home, 'local', 'hermes', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'hermes.cmd'), '@echo unsafe shim must never run\r\n');
    const native = path.join(bin, 'hermes.exe');
    fs.copyFileSync(process.execPath, native);
    assert.equal(resolveExecutable({ pathEnv: '', home, localAppData: path.join(home, 'local') }), native);
});

test('absent and cmd-only installs fail honestly without revealing env or args', () => {
    const options = { pathEnv: '', home: path.join(TMP, 'no-home'), localAppData: path.join(TMP, 'no-local') };
    if (process.platform === 'win32') {
        const bin = path.join(options.localAppData, 'hermes', 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'hermes.cmd'), '@echo unsafe fixture should not run\r\n');
    }
    const driver = `require(${JSON.stringify(LAUNCHER)}).main(['fixture-sensitive-argument'], {
        installationOptions: ${JSON.stringify(options)}
    });`;
    const result = spawnSync(process.execPath, ['-e', driver], {
        cwd: CWD, env: { ...process.env, OPENAI_API_KEY: 'fixture-secret-not-real' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 127);
    assert.match(result.stderr, /not found|not available/i);
    assert.match(result.stderr, /install/i);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-sensitive-argument|fixture-secret-not-real/);
});

test('spawn failure returns 126 without leaking executable or user arguments', () => {
    const missing = path.join(TMP, 'sensitive-private-executable');
    const driver = `require(${JSON.stringify(LAUNCHER)}).main(['sensitive-fixture-arg'], { executable: ${JSON.stringify(missing)} });`;
    const result = spawnSync(process.execPath, ['-e', driver], { cwd: CWD, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 126);
    assert.match(result.stderr, /unable to launch Hermes/);
    assert.doesNotMatch(result.stderr, /sensitive-private-executable|sensitive-fixture-arg/);
});

test('stdin/stdout/stderr are inherited without a launcher transcript', () => {
    const echo = path.join(TMP, 'stdio.js');
    fs.writeFileSync(echo, `process.stdin.setEncoding('utf8'); process.stdin.on('data', s => process.stdout.write(s)); process.stdin.on('end', () => process.stderr.write('fixture-stderr'));`);
    const driver = `require(${JSON.stringify(LAUNCHER)}).main([], { executable: process.execPath, prefixArgs: [${JSON.stringify(echo)}] });`;
    const result = spawnSync(process.execPath, ['-e', driver], { cwd: CWD, encoding: 'utf8', input: 'interactive-fixture-input\n', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'interactive-fixture-input\n');
    assert.equal(result.stderr, 'fixture-stderr');
});

test('child self-termination preserves signal result (portable POSIX check)', { skip: process.platform === 'win32' }, () => {
    const driver = `require(${JSON.stringify(LAUNCHER)}).main([], { executable: process.execPath, prefixArgs: ['-e', "process.kill(process.pid, 'SIGTERM')", '--'] });`;
    const result = spawnSync(process.execPath, ['-e', driver], { cwd: CWD, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.signal, 'SIGTERM');
});

test('parent SIGINT is forwarded to a real fixture child and its exit is preserved', { timeout: 10000 }, async () => {
    const fixture = path.join(TMP, 'signal.js');
    fs.writeFileSync(fixture, `process.on('SIGINT', () => { process.stdout.write('fixture-SIGINT\\n'); process.exit(37); }); process.stdout.write('fixture-ready\\n'); setInterval(() => {}, 1000);`);
    const driver = `
        const child = require(${JSON.stringify(LAUNCHER)}).main([], { executable: process.execPath, prefixArgs: [${JSON.stringify(fixture)}] });
        child.once('spawn', () => process.stdout.write('fixture-pid:' + child.pid + '\\n'));
        process.on('message', () => process.emit('SIGINT'));
        child.once('close', () => process.disconnect());
    `;
    const child = spawn(process.execPath, ['-e', driver], { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '', err = '', fixturePid;
    child.stderr.on('data', b => { err += b; });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    let timer;
    try {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('fixture readiness timed out')), 5000);
            child.stdout.on('data', b => {
                out += b;
                fixturePid = Number(out.match(/fixture-pid:(\d+)/)?.[1]);
                if (out.includes('fixture-ready')) { clearTimeout(timer); resolve(); }
            });
            child.once('error', reject);
        });
        child.send('fixture-signal');
        const result = await Promise.race([closed, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('SIGINT was not forwarded')), 3000);
        })]);
        if (process.platform === 'win32') {
            // Node's Windows child.kill(SIGINT) terminates the process; it cannot
            // deliver a POSIX signal handler. Real console Ctrl+C is OS broadcast.
            assert.equal(result.code, 130, err);
        } else {
            assert.equal(result.code, 37, err);
            assert.match(out, /fixture-SIGINT/);
        }
    } finally {
        clearTimeout(timer);
        if (fixturePid) { try { process.kill(fixturePid); } catch { /* Already exited. */ } }
        child.kill();
        await closed;
    }
});

test('Windows real console Ctrl+C reaches the attached fixture without force-kill', {
    skip: process.platform !== 'win32', timeout: 15000,
}, t => {
    let ptyPath;
    try { ptyPath = require.resolve('node-pty'); } catch { t.skip('existing optional node-pty dependency is unavailable'); return; }
    const fixture = path.join(TMP, 'console-signal.js');
    fs.writeFileSync(fixture, `
        process.on('SIGINT', () => { process.stdout.write('console-fixture-SIGINT\\n'); process.exit(37); });
        process.stdin.resume(); process.stdout.write('console-fixture-ready\\n');
    `);
    const driver = path.join(TMP, 'console-driver.js');
    fs.writeFileSync(driver, `require(${JSON.stringify(LAUNCHER)}).main([], { executable: process.execPath, prefixArgs: [${JSON.stringify(fixture)}] });`);
    const receipt = path.join(TMP, 'console-receipt.json');
    const probe = path.join(TMP, 'console-probe.js');
    // Isolate node-pty's ConPTY handles. Killing an already-exited terminal runs
    // its AttachConsole cleanup on a dead PID; leaving handles open hangs Node.
    fs.writeFileSync(probe, `
        const pty = require(${JSON.stringify(ptyPath)});
        const term = pty.spawn(process.execPath, [${JSON.stringify(driver)}], { cwd: ${JSON.stringify(CWD)}, env: process.env, cols: 90, rows: 24 });
        let out = '', sent = false;
        const timer = setTimeout(() => { term.kill(); process.exit(1); }, 7000);
        term.onData(data => { out += data; if (!sent && out.includes('console-fixture-ready')) { sent = true; term.write('\\x03'); } });
        term.onExit(exit => {
            clearTimeout(timer);
            require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ out, exitCode: exit.exitCode }));
            process.exit(0);
        });
    `);
    const result = spawnSync(process.execPath, [probe], { cwd: CWD, encoding: 'utf8', timeout: 12000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'no ConPTY cleanup errors');
    const actual = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.match(actual.out, /console-fixture-SIGINT/);
    assert.equal(actual.exitCode, 37);
});
