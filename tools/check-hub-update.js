#!/usr/bin/env node
'use strict';
// Exercise the production post-update function and installer launch blocks only.
// No package installs, external network, real user settings or live hub processes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '..');
function postUpdateFixture(platform, status = 0) {
    const source = fs.readFileSync(path.join(ROOT, 'hub.js'), 'utf8');
    const npmStart = source.indexOf('async function doNpmPostUpdate({');
    const npmEnd = source.indexOf('async function doUpdate({', npmStart);
    const start = source.indexOf('async function doPostUpdate({');
    const end = source.indexOf('// ── Ввод', start);
    assert.ok(start >= 0 && end > start, 'production post-update body must be found');
    const calls = [], restarts = [];
    const context = {
        process: { platform, env: { FIXTURE_SENTINEL: 'preserved' } },
        L: { ROOT: '/fixture/hub' }, SAFE: false, findBash: () => '/fixture/bash',
        line: () => {}, bold: value => value, red: value => value,
        dim: value => value, NO: () => 'no', OK: () => 'ok',
        spawnSync: (executable, args, options) => { calls.push({ executable, args, options }); return { status }; },
        doRestart: async options => { restarts.push(options); return true; },
    };
    vm.createContext(context);
    const run = vm.runInContext(source.slice(npmStart, npmEnd) + source.slice(start, end) + '\ndoPostUpdate;', context);
    return { run, calls, restarts };
}
test('Linux post-update uses npm and only restarts after a successful install', async () => {
    for (const status of [0, 1]) {
        const f = postUpdateFixture('linux', status);
        assert.equal(await f.run({ interactive: false }), status === 0);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].executable, 'npm');
        assert.deepEqual(Array.from(f.calls[0].args), ['install', '--no-audit', '--no-fund']);
        assert.equal(f.restarts.length, status === 0 ? 1 : 0);
    }
});
for (const platform of ['darwin', 'win32']) {
    test(`post-update delegates dependency-only installation and restarts once (${platform})`, async () => {
        const f = postUpdateFixture(platform);
        assert.equal(await f.run({ interactive: false }), true);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].args[0], platform === 'darwin' ? 'install-mac.sh' : 'install.sh');
        assert.equal(f.calls[0].options.env.HUB_SKIP_START, '1');
        assert.equal(f.calls[0].options.env.AUTO, '1');
        assert.equal(f.calls[0].options.env.FIXTURE_SENTINEL, 'preserved');
        assert.equal(f.restarts.length, 1);
        assert.equal(f.restarts[0].open, false);
    });
    test(`failed dependency installation never starts or restarts (${platform})`, async () => {
        const f = postUpdateFixture(platform, 1);
        assert.equal(await f.run({ interactive: false }), false);
        assert.equal(f.restarts.length, 0);
    });
}
function installerBlock(file) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const start = source.indexOf(file === 'install-mac.sh' ? '# 10. Запуск' : '# ── 10. Запуск');
    const end = source.indexOf(file === 'install-mac.sh' ? '# 11. Памятка' : '# ── Шпаргалка', start);
    assert.ok(start >= 0 && end > start, 'production installer launch block must be found');
    return source.slice(start, end);
}
function runInstallerBlock(file, skip) {
    const helpers = `set -u\nb(){ :; }\nstep(){ :; }\nok(){ :; }\nnoask(){ return 0; }\nask(){ return 0; }\nbash(){ printf 'LAUNCH\\n'; return 0; }\nstart(){ printf 'LAUNCH\\n'; return 0; }\n`;
    const r = spawnSync('bash', ['-c', helpers + installerBlock(file)], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, AUTO: '1', HUB_SKIP_START: skip },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
}
for (const file of ['install-mac.sh', 'install.sh']) {
    test(`${file} dependency-only mode never launches a second hub`, () => {
        assert.doesNotMatch(runInstallerBlock(file, '1'), /LAUNCH/);
    });
    test(`${file} standalone install keeps its normal launch behavior`, () => {
        assert.match(runInstallerBlock(file, ''), /LAUNCH/);
    });
}
