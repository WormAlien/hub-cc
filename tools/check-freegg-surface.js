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
assert.match(panel, /id="fg-rate-balance-toggle"[^>]*role="switch"[^>]*aria-checked="false"/,
    'FreeGG keepalive settings expose an accessible rate-balance switch');
assert.match(panel, /id="fg-rate-balance-toggle"[^>]*aria-label="[^"]+"[^>]*h-\[44px\]/,
    'FreeGG rate-balance switch needs a labelled 44px touch target');
assert.match(panel, /id="fg-rate-balance-track"/, 'FreeGG rate-balance switch keeps its iOS-sized visible track');
assert.match(panel, /onclick="fgRateBalanceToggle\(\)"/,
    'FreeGG rate-balance switch invokes its dedicated controller');
assert.match(panel, /id="fg-rate-balance-state"/, 'FreeGG rate-balance switch has a visible state label');
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
assert.match(backend, /const FG_RATE_CONFIG_FILE\s*=/, 'FreeGG rate-balance preference needs a persisted config file');
assert.match(backend, /FG_RATE_CONFIG_FILE\s*=\s*path\.join\(os\.homedir\(\), '\.claude', 'freegg-rate-policy\.json'\)/,
    'FreeGG rate-balance preference must survive checkout replacement');
assert.match(backend, /async function handleFgRatePolicy/, 'FreeGG rate-balance preference needs a dedicated API');
assert.match(backend, /FREEGG_RATE_BALANCE:\s*rateCfg\.enabled \? '1' : '0'/,
    'FreeGG keepalive spawn must consume persisted switch state');
assert.match(backend, /FREEGG_RATE_SCOPE:\s*rateCfg\.enabled \? 'account' : 'off'/,
    'enabled dashboard switch must use explicit account scope');
assert.match(backend, /\(req\.method === 'GET' \|\| req\.method === 'POST'\) && req\.url === '\/__switch\/api\/fg\/rate-policy'/,
    'FreeGG rate-balance state API must be routed');
assert.match(backend, /keepaliveBring\(FG_KEEPALIVE_PORT, \{ force: true, waitMs: 8000 \}\)/,
    'changing rate-balance state must restart and verify the FreeGG keepalive');
assert.match(backend, /fgRateRestore\(previous\)[\s\S]*?rolledBack:\s*true/,
    'failed rate-balance restarts must restore the previous persisted state');
assert.match(backend, /function hubWriteGuard[\s\S]*?sec-fetch-site[\s\S]*?application\\\/json/,
    'state-changing dashboard routes need the shared same-origin JSON guard');
assert.match(backend, /handleFgRatePolicy\(req, res\)[\s\S]*?if \(!hubWriteGuard\(req, res\)\) return/,
    'FreeGG rate-balance POST must reject cross-site and simple-body requests');
assert.ok(backend.slice(backend.indexOf('async function fgBalance('), backend.indexOf('async function axBalance(')).includes("balanceSource === 'guess'"), 'FreeGG must not invent a registration grant');
const ps = fs.readFileSync(path.join(root, 'routing/keepalive-restart.ps1'), 'utf8');
assert.ok(/20184 = @\{ UPSTREAM = 'http:\/\/127\.0\.0\.1:20185'/.test(ps), 'restart path must use FreeGG converter too');
assert.match(ps, /freegg-rate-policy\.json[\s\S]*?-not \(\$rate -is \[System\.Array\]\)[\s\S]*?\$rate -is \[pscustomobject\][\s\S]*?FREEGG_RATE_BALANCE[\s\S]*?FREEGG_RATE_SCOPE/,
    'manual FreeGG restart must consume the same persisted rate policy');
console.log('FreeGG surface and routing contract: PASS');
