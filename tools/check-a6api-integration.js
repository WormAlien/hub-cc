#!/usr/bin/env node
'use strict';
// Static seams plus actual activation function in a VM; never edits the real CC config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'routing/transparent-proxy.js'), 'utf8');
const keep = fs.readFileSync(path.join(root, 'routing/keepalive-proxy.js'), 'utf8');
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + ': ' + String(e.message).split('\n').slice(0, 4).join(' ')); process.exitCode = 1; } }
async function asyncTest(name, fn) { try { await fn(); passed++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + ': ' + String(e.message).split('\n').slice(0, 4).join(' ')); process.exitCode = 1; } }
function fun(name) {
    const start = code.indexOf('function ' + name + '('); assert.ok(start >= 0, name + ' absent');
    const end = code.indexOf('\n}', start); assert.ok(end > start); return code.slice(start, end + 2);
}
test('gateway is registered in backend, prefixes, alias and routes catalog', () => {
    assert.match(code, /a6api:\s*\{\s*label:\s*'a6api'/);
    assert.match(code, /const CC_MODEL_PREFIX = \{[^;]*a6api:\s*'a6api'/);
    assert.match(code, /const BACKEND_ALIASES = \{[^;]*a6:\s*'a6api'/);
    assert.match(code, /const ROUTE_EP = \{[^;]*a6api:\s*'a6api'/);
    assert.match(fun('handleRoutesModels'), /provider === 'a6api'/);
    assert.match(fun('applyTarget'), /target === 'a6api'/);
    const switchBlock = code.slice(code.indexOf("req.url === '/__switch/api/switch'"), code.indexOf("req.url === '/__switch/api/switch'") + 1300);
    assert.ok(switchBlock.includes("target === 'a6api'") && switchBlock.includes('a6Routes.canWrite(req)'), 'generic switch must not bypass a6api write guard');
});
test('both model maps are present with independent defaults and shared tiers', () => {
    for (const suffix of ['-modelmap.json', '-routes-modelmap.json']) {
        const map = JSON.parse(fs.readFileSync(path.join(root, 'routing/a6api' + suffix), 'utf8'));
        for (const k of ['default', 'opus', 'sonnet', 'haiku']) assert.equal(map[k], 'deepseek-v4.1-flash-1017');
    }
});
test('a6api activation uses the existing settings writer and preserves unrelated config', () => {
    let current = { env: { ANTHROPIC_API_KEY: 'old-secret', ANTHROPIC_AUTH_TOKEN: 'old-token', ANTHROPIC_MODEL: 'old', KEEP_ME: 'yes',
        CLAUDE_CODE_SUBAGENT_MODEL: 'agentrouter/gpt-6-astra', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' },
        apiKeyHelper: 'old helper', permissions: { allow: ['Bash(node *)'] }, model: 'old' }, written, state;
    const context = { A6_KEEPALIVE_URL: 'http://127.0.0.1:20191', readSettings: () => structuredClone(current),
        clearOtEnv: obj => { for (const k of ['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_MODEL']) delete obj.env[k]; },
        writeSettings: obj => { written = obj; current = structuredClone(obj); }, saveState: value => { state = value; },
        currentTarget: () => 'a6api', normalizeCcModel: x => x, Error };
    vm.runInNewContext(fun('a6CommitActivation'), context);
    context.a6CommitActivation('deepseek-v4.1-flash-1017');
    assert.equal(written.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:20191'); assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, 'dummy');
    assert.equal(written.env.ANTHROPIC_API_KEY, undefined); assert.equal(written.apiKeyHelper, undefined);
    assert.equal(written.env.KEEP_ME, 'yes'); assert.equal(written.permissions.allow[0], 'Bash(node *)');
    assert.equal(written.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined, 'a6api owns its subagents through its own tiers');
    assert.equal(written.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined, 'foreign forced subagent provider must not override a6api tiers');
    assert.equal(written.model, 'deepseek-v4.1-flash-1017'); assert.equal(state, 'a6api');
    assert.ok(!JSON.stringify(written).includes('old-secret'));
});
test('a6api status line and lazy start use registered shared lifecycle', () => {
    const lifecycle = require(path.join(root, 'routing/lifecycle'));
    for (const p of [20191, 20192]) assert.ok(lifecycle.children().some(x => x.port === p));
    assert.match(fun('keepaliveInstances'), /\[A6_KEEPALIVE_PORT\]/);
    const statusline = fs.readFileSync(path.join(root, 'routing/statusline-autoreger.sh'), 'utf8');
    assert.match(statusline, /gauge_from_a6api_balance/);
    assert.match(statusline, /provider" = "a6api"/);
    assert.match(statusline, /provider" = "threerouter"/);
    assert.match(statusline, /\*api\.threerouter\.com\*\) provider="threerouter"/);
    const spec = JSON.parse(fs.readFileSync(path.join(root, 'tools/gateways.spec.json'), 'utf8').replace(/^﻿/, ''));
    assert.equal(spec.files.statusline, 'routing/statusline-autoreger.sh');
    assert.ok(spec.points.some(p => p.id === '5.1' && p.file === 'statusline' && /%SESSIONSFILE%/.test(p.expect)));
    assert.equal(spec.inserts['5.1'].span, 'lines:2');
    assert.match(fun('keepaliveInstances'), /\[A6_CONVERTER_PORT\]/);
    assert.ok(fun('bootSweepStaleChildren').includes('keep.add(A6_CONVERTER_PORT)'), 'active converter must survive sweep');
    const bar = fs.readFileSync(path.join(root, 'routing/statusline-autoreger.sh'), 'utf8');
    assert.match(bar, /a6api\)\s+map_prefix="a6api"/);
    assert.ok(bar.includes('localhost:20191') && bar.includes('127.0.0.1:20191'), 'direct a6api URL must not become Custom');
    const fallback = fs.readFileSync(path.join(root, 'routing/keepalive-restart.ps1'), 'utf8');
    assert.match(fallback, /20191/); assert.match(fallback, /a6api-gateway/);
});
test('a6api readiness delegates before generic port handling can kill another process', () => {
    const bring = fun('keepaliveBring');
    assert.ok(bring.indexOf('a6Gateway') >= 0 && bring.indexOf('a6Gateway') < bring.indexOf('stopPortSoftly'), 'a6api must own its pair readiness');
    assert.ok(code.includes('a6Gateway.saveRouteTier('), 'shared routes editor must validate the selected a6api key');
});
test('single-key paid mode clamps retries, hedging, fallback, catalog and rotation', () => {
    assert.match(keep, /PAID_SINGLE_KEY/); assert.match(keep, /function clampSingleKey/);
    const start = keep.indexOf('function clampSingleKey('), end = keep.indexOf('\n}', start);
    const ctx = { PAID_SINGLE_KEY: true, cfg: { maxAttempts: 9, maxHedges: 3, hedgeMs: 1000, holdMs: 60000, poolFallbackModel: 'wrong', catalogTtlMs: 60000, visionBridge: true } };
    vm.runInNewContext(keep.slice(start, end + 2), ctx); ctx.clampSingleKey();
    assert.equal(ctx.cfg.maxAttempts, 1); assert.equal(ctx.cfg.maxHedges, 0); assert.equal(ctx.cfg.hedgeMs, 0);
    assert.equal(ctx.cfg.holdMs, 0); assert.equal(ctx.cfg.poolFallbackModel, ''); assert.equal(ctx.cfg.catalogTtlMs, 0); assert.equal(ctx.cfg.visionBridge, false);
    assert.match(keep, /ROTATE_ON = !PAID_SINGLE_KEY/);
});
(async () => {
    await asyncTest('statusline renders the a6api account balance from the private cache', async () => {
        const os = require('node:os'), { spawnSync } = require('node:child_process');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-status-'));
        try {
            fs.mkdirSync(path.join(dir, '.claude')); fs.mkdirSync(path.join(dir, '.secrets'));
            fs.writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify({ model: 'deepseek-v4-flash[1m]', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:20100' } }));
            fs.writeFileSync(path.join(dir, '.claude/active-backend.json'), JSON.stringify({ backend: 'a6api', upstream: 'http://127.0.0.1:20191', keyFile: null, modelmap: 'a6api-modelmap.json' }));
            fs.writeFileSync(path.join(dir, '.claude/backends.json'), JSON.stringify({ providers: { a6api: { upstream: 'http://127.0.0.1:20191', keyFile: null, modelmap: 'a6api-modelmap.json' } }, aliases: {} }));
            fs.writeFileSync(path.join(dir, '.secrets/a6api-balance.json'), JSON.stringify({ balanceUsd: 5.57, spentUsd: 0.42, checkedAt: new Date().toISOString() }));
            const r = spawnSync('bash', [path.join(root, 'routing/statusline-autoreger.sh')], { encoding: 'utf8',
                env: { ...process.env, HOME: dir, STATUSLINE_PAYLOAD: JSON.stringify({ model: { id: 'a6api[1m]' }, context_window: { context_window_size: 1000000, used_percentage: 7 } }) } });
            assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /\$5\.57/); assert.match(r.stdout, /a6api/);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    console.log(`check-a6api-integration: ${passed} passed`);
})();
