'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'routing/proxy-dashboard.html'), 'utf8');
const panel = html.slice(html.indexOf('<div data-tab-content="freegg">'), html.indexOf('<div data-tab-content="apinex">'));
assert.ok(!/только Opus|opus-only|гранта нет|панель платная|каждый ЧЕТВЁРТЫЙ|молча выбрасывает/.test(panel), 'FreeGG must not inherit unverified KKtoken claims');
assert.ok(panel.includes('/v1/responses'), 'FreeGG explains its actual endpoint');
assert.ok(panel.includes('автоматически'), 'FreeGG explains automatic key onboarding');
const backend = fs.readFileSync(path.join(root, 'routing/transparent-proxy.js'), 'utf8');
const sweepStart = backend.indexOf('async function bootSweepStaleChildren');
const sweepEnd = backend.indexOf('async function bootRecreateActiveCustomProxy', sweepStart);
assert.ok(sweepStart >= 0 && sweepEnd > sweepStart, 'boot sweep function missing');
assert.match(backend.slice(sweepStart, sweepEnd),
    /active === FG_KEEPALIVE_PORT\) keep\.add\(FG_CONVERTER_PORT\)/,
    'active FreeGG converter must survive the boot stale-child sweep');
const spawn = backend.slice(backend.indexOf('async function fgKeepaliveSpawn()'), backend.indexOf('async function axKeepaliveSpawn()'));
assert.ok(spawn.includes('UPSTREAM: FG_CONVERTER_URL'));
assert.ok(spawn.includes('GPT_PROXY_FORCE: \'0\''), 'FreeGG cannot inherit the global AR converter');
assert.ok(backend.slice(backend.indexOf('async function fgBalance('), backend.indexOf('async function axBalance(')).includes("balanceSource === 'guess'"), 'FreeGG must not invent a registration grant');
const ps = fs.readFileSync(path.join(root, 'routing/keepalive-restart.ps1'), 'utf8');
assert.ok(/20184 = @\{ UPSTREAM = 'http:\/\/127\.0\.0\.1:20185'/.test(ps), 'restart path must use FreeGG converter too');
console.log('FreeGG surface and routing contract: PASS');
