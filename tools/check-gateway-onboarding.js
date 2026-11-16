#!/usr/bin/env node
'use strict';
// Behavioral fixtures only: no live provider, real account, browser or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const REPO = path.join(__dirname, '..');
const scratch = process.platform === 'win32'
    ? path.join(require('node:os').homedir(), 'AppData', 'Local', 'hermes', 'cache', 'scratch') : process.env.TMPDIR;
assert.ok(scratch, 'Hermes scratch directory must be configured');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(scratch, 'gateway-onboarding-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(root, 'routing', 'lib'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'add-gateway.js'), path.join(root, 'tools', 'add-gateway.js'));
    const gw = { p: 'zz', P: 'ZZ', full: 'examplegw', FOLDER: 'examplegw', NAME: 'Example', HOST: 'example.invalid', PORT: 20991,
        github: true, ref: true, REF: 'ExactRef', customPanel: false, hedgesTuned: true,
        onboarding: { kind: 'newapi-github', consolePath: '/console/token', callbackPath: '/api/oauth/github', tokenName: 'ABUSE HUB' } };
    const config = { kktoken: { ...gw, p: 'kk', P: 'KK', full: 'kktoken', FOLDER: 'kktoken', PORT: 20990, onboarding: undefined }, examplegw: gw };
    const spec = { source: 'kktoken', files: {}, points: [{ id: '3.10', title: 'Open session', file: '%FOLDER%/open-session.js', kind: 'file' }], inserts: {} };
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    const json = (rel, value) => write(rel, JSON.stringify(value));
    const save = () => { json('tools/gateways.config.json', config); json('tools/gateways.spec.json', spec); };
    save();
    write('routing/lib/newapi-onboarding.js', "throw new Error('runtime must never load during generator');\n");
    const run = (...args) => { const r = spawnSync(process.execPath, [path.join(root, 'tools', 'add-gateway.js'), ...args], { cwd: root, encoding: 'utf8', timeout: 10000 }); return { ...r, output: String(r.stdout || '') + String(r.stderr || '') }; };
    const snapshot = () => { const result = {}; const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else result[path.relative(root, p)] = fs.readFileSync(p).toString('base64'); } }; walk(root); return result; };
    return { root, gw, config, spec, write, json, save, run, snapshot, wrapper: path.join(root, 'examplegw', 'open-session.js') };
}
test('explicit verified dialect generates a generic wrapper without cloning provider code; dry-run is inert', t => {
    const f = fixture(t);
    f.write('kktoken/open-session.js', "throw new Error('arbitrary site-specific clone forbidden');\n");
    const before = f.snapshot();
    const dry = f.run('apply', 'examplegw');
    assert.equal(dry.status, 0, dry.output);
    assert.match(dry.output, /newapi-github/);
    assert.deepEqual(f.snapshot(), before);
    const applied = f.run('apply', 'examplegw', '--write');
    assert.equal(applied.status, 0, applied.output);
    assert.ok(fs.existsSync(f.wrapper), 'opted-in open-session wrapper is created');
    const wrapper = fs.readFileSync(f.wrapper, 'utf8');
    assert.match(wrapper, /require\(['"]\.\.\/routing\/lib\/newapi-onboarding['"]\)/);
    assert.match(wrapper, /runProvider/);
    assert.match(wrapper, /provider: ['"]examplegw['"]/);
    assert.match(wrapper, /moduleDir: __dirname/);
    assert.match(wrapper, /label: process\.argv\[2\]/);
    assert.match(wrapper, /mode: process\.argv\[3\] \|\| ['"]auto['"]/);
    assert.doesNotMatch(wrapper, /site-specific|example\.invalid|ExactRef|playwright/);
    const repeat = f.snapshot();
    assert.equal(f.run('apply', 'examplegw', '--write').status, 0);
    assert.deepEqual(f.snapshot(), repeat, 'repeat apply does not write even a backup');
});
test('onboarding check rejects an arbitrary existing script and apply never clobbers it', t => {
    const f = fixture(t);
    f.write('examplegw/open-session.js', "throw new Error('private site-specific source');\n");
    const before = f.snapshot();
    const checked = f.run('check', 'examplegw');
    assert.equal(checked.status, 1, checked.output);
    assert.match(checked.output, /generic wrapper|generic newapi-github/);
    const applied = f.run('apply', 'examplegw', '--write');
    assert.equal(applied.status, 1, applied.output);
    assert.deepEqual(f.snapshot(), before);
});
test('missing generic runtime refuses the complete apply before any write', t => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.root, 'routing/lib/newapi-onboarding.js'));
    const before = f.snapshot();
    assert.equal(f.run('apply', 'examplegw', '--write').status, 1);
    assert.deepEqual(f.snapshot(), before);
});
test('without explicit onboarding old gateway scripts and manual creation behavior are unchanged', t => {
    const f = fixture(t);
    delete f.gw.onboarding; f.save();
    assert.equal(f.run('apply', 'examplegw', '--write').status, 0);
    assert.equal(fs.existsSync(f.wrapper), false);
    f.write('examplegw/open-session.js', "throw new Error('legacy script is not executed');\n");
    const before = f.snapshot();
    assert.equal(f.run('check', 'examplegw').status, 0);
    assert.equal(f.run('apply', 'examplegw', '--write').status, 0);
    assert.deepEqual(f.snapshot(), before);
});
test('explicit dialect validates paths, identifiers, flags and rejects secret-bearing config without disclosing it', t => {
    const cases = [
        gw => { gw.onboarding.kind = 'custom'; },
        gw => { gw.github = false; }, gw => { gw.ref = false; }, gw => { gw.customPanel = true; },
        gw => { gw.full = "examplegw'; throw new Error('injected')"; },
        gw => { gw.FOLDER = '../outside'; }, gw => { gw.HOST = 'user:fixture-secret@example.invalid'; },
        gw => { gw.onboarding.consolePath = 'https://outside.invalid/console/token'; },
        gw => { gw.onboarding.callbackPath = '//outside.invalid/api/oauth/github'; },
        gw => { gw.onboarding.consolePath = '/console/token?key=fixture-secret'; },
        gw => { gw.onboarding.consolePath = '/console/../token'; },
        gw => { gw.onboarding.consolePath = '/console/%2e%2e/token'; },
        gw => { gw.onboarding.callbackPath = '/api\\oauth\\github'; },
        gw => { gw.onboarding.password = 'fixture-secret'; },
        gw => { gw.onboarding.tokenName = 'sk-fixture-secret'; },
    ];
    for (const change of cases) {
        const f = fixture(t); change(f.gw); f.save(); const before = f.snapshot();
        const result = f.run('apply', 'examplegw', '--write');
        assert.notEqual(result.status, 0, 'invalid onboarding must be refused');
        assert.doesNotMatch(result.output, /fixture-secret|injected/);
        assert.deepEqual(f.snapshot(), before);
    }
});
test('plan identifies generic onboarding rather than accepting an arbitrary existing script', t => {
    const f = fixture(t);
    f.write('examplegw/open-session.js', "throw new Error('not generic');\n");
    const result = f.run('plan', 'examplegw');
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /generic wrapper/);
});
test('provision uses configured local port, rejects an incomplete tab and never repairs missing pool data', t => {
    const f = fixture(t); const tool = require('./add-gateway.js');
    f.write('examplegw/open-session.js', tool.renderOnboardingWrapper(f.gw));
    const missingPool = f.run('provision', 'examplegw', '--id', 'chosen');
    assert.equal(missingPool.status, 2);
    f.json('routing/examplegw-sessions.json', [{ id: 'chosen', api_key: 'fixture-secret' }]);
    const envRun = port => spawnSync(process.execPath, [path.join(f.root, 'tools/add-gateway.js'), 'provision', 'examplegw', '--id', 'chosen'],
        { cwd: f.root, env: { ...process.env, SWITCH_PORT: port }, encoding: 'utf8' });
    const before = f.snapshot();
    const configured = envRun('8301');
    assert.equal(configured.status, 0, configured.stdout + configured.stderr);
    assert.match(configured.stdout, /:8301/);
    for (const port of ['0', '65536', '8301evil']) assert.equal(envRun(port).status, 2);
    assert.deepEqual(f.snapshot(), before);
    f.spec.points.push({ id: 'fixture-missing', title: 'Required tab surface', file: 'routing/missing-tab.js', kind: 'must', expect: 'required' });
    f.save(); const incomplete = f.snapshot();
    assert.equal(f.run('provision', 'examplegw', '--id', 'chosen', '--write').status, 2);
    assert.deepEqual(f.snapshot(), incomplete);
});

test('provision dry-run selects an exact existing provider-pool id without loading runtime or writing', t => {
    const f = fixture(t);
    const tool = require('./add-gateway.js');
    assert.equal(typeof tool.renderOnboardingWrapper, 'function', 'export pure wrapper renderer for fixtures');
    f.write('examplegw/open-session.js', tool.renderOnboardingWrapper(f.gw));
    f.json('routing/examplegw-sessions.json', [{ id: 'stable_Chosen-01', email: 'fixture-private-email', api_key: 'fixture-secret-key', ghId: 'gh-selected' }, { id: 'other', api_key: 'fixture-other-secret' }]);
    const before = f.snapshot();
    const dry = f.run('provision', 'examplegw', '--id', 'stable_Chosen-01');
    assert.equal(dry.status, 0, dry.output);
    assert.match(dry.output, /acct_stable_Chosen-01/);
    assert.match(dry.output, /dry-run|Сухой прогон/i);
    assert.doesNotMatch(dry.output, /fixture-|gh-selected/);
    assert.deepEqual(f.snapshot(), before);
});
test('provision write launches only chosen acct_<id> and suppresses runtime secrets on success or failure', t => {
    const f = fixture(t); const tool = require('./add-gateway.js');
    assert.equal(typeof tool.renderOnboardingWrapper, 'function');
    f.write('examplegw/open-session.js', tool.renderOnboardingWrapper(f.gw));
    f.json('routing/examplegw-sessions.json', [{ id: 'chosen_01', api_key: 'fixture-private-key' }, { id: 'other_02', api_key: '' }]);
    // Local substitute proves executable wrapper plumbing, not real OAuth/key creation.
    f.write('routing/lib/newapi-onboarding.js', "exports.runProvider = async opts => { require('fs').writeFileSync(require('path').join(opts.moduleDir, 'called.json'), JSON.stringify({ ...opts, port: process.env.SWITCH_PORT, hubOrigin: process.env.NEWAPI_HUB_ORIGIN })); console.log('fixture-secret-key'); };\n");
    const result = f.run('provision', 'examplegw', '--id', 'chosen_01', '--write');
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /fixture-secret|fixture-private/);
    const called = JSON.parse(fs.readFileSync(path.join(f.root, 'examplegw/called.json')));
    assert.deepEqual(called, { provider: 'examplegw', moduleDir: path.join(f.root, 'examplegw'), label: 'acct_chosen_01', mode: 'provision', port: process.env.SWITCH_PORT || '8200', hubOrigin: `http://127.0.0.1:${process.env.SWITCH_PORT || '8200'}` });
    f.write('routing/lib/newapi-onboarding.js', "exports.runProvider = async () => { throw new Error('fixture-secret-key'); };\n");
    const failed = f.run('provision', 'examplegw', '--id', 'chosen_01', '--write');
    assert.equal(failed.status, 1, failed.output);
    assert.doesNotMatch(failed.output, /fixture-secret/);
});
test('provision refuses absent, ambiguous, malformed and unselected accounts without writes or secret output', t => {
    const cases = [
        { args: [] }, { args: ['--id'] }, { args: ['--id', 'missing'] }, { args: ['--id', '../chosen'] },
        { args: ['--id', ' chosen '] }, { args: ['--id', 'chosen', '--id', 'other'] },
        { args: ['--id', 'chosen', '--batch'] }, { args: ['--id', 'chosen', '--gh', 'random'] },
        { args: ['--id', 'chosen'], pool: [{ id: 'chosen' }, { id: 'chosen' }] },
        { args: ['--id', 'chosen'], pool: { chosen: { id: 'chosen', api_key: 'fixture-secret' } } },
        { args: ['--id', 'chosen'], pool: [{ id: 1 }] },
        { args: ['--id', 'chosen'], edit: f => { delete f.gw.onboarding; f.save(); } },
        { args: ['--id', 'chosen'], edit: f => fs.unlinkSync(path.join(f.root, 'routing/lib/newapi-onboarding.js')) },
        { args: ['--id', 'chosen'], edit: f => f.write('examplegw/open-session.js', "console.log('fixture-secret');") },
    ];
    for (const c of cases) {
        const f = fixture(t); const tool = require('./add-gateway.js');
        assert.equal(typeof tool.renderOnboardingWrapper, 'function');
        f.write('examplegw/open-session.js', tool.renderOnboardingWrapper(f.gw));
        f.json('routing/examplegw-sessions.json', c.pool || [{ id: 'chosen', api_key: 'fixture-secret' }]);
        if (c.edit) c.edit(f); const before = f.snapshot();
        const result = f.run('provision', 'examplegw', ...c.args, '--write');
        assert.notEqual(result.status, 0, result.output);
        assert.doesNotMatch(result.output, /fixture-secret/);
        assert.deepEqual(f.snapshot(), before);
    }
});
