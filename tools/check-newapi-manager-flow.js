'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../routing/proxy-dashboard.html'), 'utf8').replace(/\r/g, '');
function functionText(name) {
    const start = html.indexOf(`async function ${name}(`);
    const next = html.indexOf('\n}\n', start);
    assert.ok(start >= 0 && next > start, name + ' exists');
    return html.slice(start, next + 2);
}
test('auto-onboarded manager record opens provision and verifies key readback without credentials popup', async () => {
    const calls = [], rows = [{ id: 'chosen', ghId: 'gh_chosen', api_key: 'no-key-fixture' }];
    const sandbox = { calls, rows, NEWAPI_SEED_PROV: { fx: { autoOnboarding: true, label: 'Fxqidian',
        reload: async () => { rows[0].api_key = 'sk-' + 'fixture-provider-key'; }, list: () => rows } },
        fetch: async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return { ok: true, json: async () => ({ ok: true, pid: 1 }) }; },
        toast: () => {}, setTimeout: fn => { fn(); return 0; }, Date, Promise };
    vm.createContext(sandbox);
    vm.runInContext(functionText('newapiAutoOnboard'), sandbox);
    assert.equal(await sandbox.newapiAutoOnboard('fx', 'chosen'), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['/__switch/api/fx/session/open', { id: 'chosen', mode: 'provision' }]);
    assert.ok(rows[0].api_key.startsWith('sk-'));
});
test('auto onboarding flag is enabled for accepted common-runtime providers only', () => {
    const region = html.slice(html.indexOf('const NEWAPI_SEED_PROV = {'), html.indexOf('let ghSeedProv'));
    assert.match(region, /fx:\s*\{[^\n]*autoOnboarding:\s*true/);
    assert.match(region, /fg:\s*\{[^\n]*autoOnboarding:\s*true/);
    const enabled = [...region.matchAll(/\b([a-z]+):\s*\{[^\n]*autoOnboarding:\s*true/g)].map(match => match[1]).sort();
    assert.deepEqual(enabled, ['fg', 'fx']);
});

test('freegg session/open forwards provision to the owned wrapper without changing the active account', async () => {
    const source = fs.readFileSync(require('node:path').join(__dirname, '../routing/transparent-proxy.js'), 'utf8').replace(/\r/g, '');
    const start = source.indexOf('async function handleFgSessionOpen(');
    const end = source.indexOf('\nasync function handleAxSessionOpen(', start);
    const calls = [];
    const sandbox = { readJsonBody: async () => ({ id: 'chosen', mode: 'provision' }),
        fgLoad: () => [{ id: 'chosen', api_key: 'no-key-fixture', active: false }],
        fgLkPids: new Map(), fgPidAlive: () => false, path: require('node:path'), __dirname: 'routing',
        newapiSyncProfile: () => {}, newapiRecheckAfterLk: () => {}, newapiLkVisited: () => {},
        logLine: () => {}, isRealKey: () => false, sessionOpenEarlyFailure: async () => null,
        process: { execPath: 'node' }, jsonRes: (_res, status, body) => ({ status, body }),
        spawn: (_exe, args) => { calls.push(args); return { pid: 1, stdout: { on: () => {} },
            stderr: { on: () => {} }, on: () => {}, unref: () => {} }; } };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(start, end), sandbox);
    await sandbox.handleFgSessionOpen({}, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'acct_chosen');
    assert.equal(calls[0][2], 'provision');
});

test('fxqidian session/open forwards provision to the owned wrapper without changing the active account', async () => {
    const source = fs.readFileSync(require('node:path').join(__dirname, '../routing/transparent-proxy.js'), 'utf8').replace(/\r/g, '');
    const start = source.indexOf('async function handleFxSessionOpen(');
    const end = source.indexOf('\nasync function handleLsSessionOpen(', start);
    const calls = [];
    const sandbox = { readJsonBody: async () => ({ id: 'chosen', mode: 'provision' }),
        fxLoad: () => [{ id: 'chosen', api_key: 'no-key-fixture', active: false }],
        fxLkPids: new Map(), fxPidAlive: () => false, path: require('node:path'), __dirname: 'routing',
        newapiSyncProfile: () => {}, newapiRecheckAfterLk: () => {}, newapiLkVisited: () => {},
        logLine: () => {}, isRealKey: () => false, sessionOpenEarlyFailure: async () => null,
        process: { execPath: 'node' }, jsonRes: (_res, status, body) => ({ status, body }),
        spawn: (_exe, args) => { calls.push(args); return { pid: 1, stdout: { on: () => {} },
            stderr: { on: () => {} }, on: () => {}, unref: () => {} }; } };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(start, end), sandbox);
    await sandbox.handleFxSessionOpen({}, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'acct_chosen');
    assert.equal(calls[0][2], 'provision');
});

test('an existing key cannot make a still-running provision look complete', async () => {
    const rows = [{ id: 'chosen', api_key: 'sk-existing-key' }], events = [];
    let now = 0;
    const sandbox = { NEWAPI_SEED_PROV: { fx: { reload: async () => {}, list: () => rows } },
        fetch: async () => ({ ok: true, json: async () => ({ ok: true, already: true, pid: 1 }) }),
        toast: (_text, kind) => events.push(kind), Date: { now: () => (now += 70000) },
        setTimeout: fn => { fn(); }, Promise };
    vm.createContext(sandbox);
    vm.runInContext(functionText('newapiAutoOnboard'), sandbox);
    assert.equal(await sandbox.newapiAutoOnboard('fx', 'chosen'), false,
        'existing key is not evidence that the requested provision completed');
    assert.ok(!events.includes('success'));
});
