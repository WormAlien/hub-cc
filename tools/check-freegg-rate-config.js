'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createLocalHopAuth } = require('../routing/lib/local-hop-auth.js');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = process.env.KEEPALIVE_TEST_SCRATCH || (process.platform === 'win32'
  ? 'C:/Users/WormAlien/AppData/Local/hermes/cache/scratch'
  : path.join(require('node:os').homedir(), '.cache/hermes/scratch'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'freegg-rate-config-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const keyFile = path.join(dir, 'active.txt');
  const sessions = path.join(dir, 'sessions.json');
  const modelMap = path.join(dir, 'modelmap.json');
  fs.writeFileSync(keyFile, 'fixture-key-a');
  fs.writeFileSync(sessions, JSON.stringify([
    { id: 'fixture-a', newApiUserId: 101, api_key: 'fixture-key-a', status: 'live', active: true },
    { id: 'fixture-b', newApiUserId: 202, api_key: 'fixture-key-b', status: 'live' },
  ]));
  fs.writeFileSync(modelMap, JSON.stringify({ default: 'gpt-6.1-sol' }));
  let upstreamCalls = 0;
  const vendor = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/fixture/logs') { res.writeHead(200); res.end('{"ok":true}'); return; }
    upstreamCalls++; res.writeHead(500); res.end();
  });
  const upstreamPort = await listen(vendor);
  const cases = [
    { name: 'override-on-beats-env-off', config: '{"enabled":true,"scope":"shared"}', generic: '0', legacy: '0', enabled: true, scope: 'account' },
    { name: 'override-off-beats-env-on', config: '{"enabled":false}', generic: '1', legacy: '1', enabled: false, scope: 'off' },
    { name: 'corrupt-fail-closed', config: '{broken', generic: '1', legacy: '1', enabled: false, scope: 'off' },
    { name: 'array-fail-closed', config: '[{"enabled":true}]', generic: '1', legacy: '1', enabled: false, scope: 'off' },
    { name: 'nonboolean-fail-closed', config: '{"enabled":"true"}', generic: '1', legacy: '1', enabled: false, scope: 'off' },
    { name: 'null-fail-closed', config: 'null', generic: '1', legacy: '1', enabled: false, scope: 'off' },
    { name: 'missing-field-fail-closed', config: '{}', generic: '1', legacy: '1', enabled: false, scope: 'off' },
    { name: 'primitive-root-fail-closed', config: 'true', generic: '1', legacy: '1', enabled: false, scope: 'off' },
    { name: 'unreadable-directory-fail-closed', directory: true, config: null, generic: '1', legacy: '1', enabled: false, scope: 'off' },
    { name: 'bom-root-on', config: '\uFEFF{"enabled":true}', generic: '0', legacy: '0', enabled: true, scope: 'account' },
    { name: 'missing-preserves-generic-env', config: null, generic: '1', legacy: '0', envScope: 'key', enabled: true, scope: 'key' },
    { name: 'missing-preserves-legacy-env', config: null, generic: null, legacy: '1', envScope: 'shared', enabled: true, scope: 'shared' },
    { name: 'missing-default-off', config: null, generic: '0', legacy: '0', envScope: 'off', enabled: false, scope: 'off' },
    { name: 'default-home-file-on', config: '{"enabled":true}', defaultFile: true, generic: '0', legacy: '0', enabled: true, scope: 'account' },
    { name: 'missing-override-preserves-env-despite-home-on', config: null, generic: '0', legacy: '0', envScope: 'off', enabled: false, scope: 'off' },
    { name: 'other-provider-ignores-freegg-on', provider: 'fixture-provider', config: '{"enabled":true}', generic: '0', legacy: '0', envScope: 'off', enabled: false, scope: 'off' },
    { name: 'other-provider-keeps-generic-on', provider: 'fixture-provider', config: '{"enabled":false}', generic: '1', legacy: '0', envScope: 'key', enabled: true, scope: 'key' },
  ];
  const results = [];
  const selftests = [];
  try {
    for (const [index, spec] of cases.entries()) {
      const fixture = path.join(dir, String(index));
      fs.mkdirSync(fixture);
      const configFile = spec.defaultFile ? path.join(home, '.claude', 'freegg-rate-policy.json') : path.join(fixture, 'freegg-rate-policy.json');
      if (spec.directory) fs.mkdirSync(configFile);
      else if (spec.config !== null) fs.writeFileSync(configFile, spec.config);
      const reservation = http.createServer();
      const kp = await listen(reservation);
      await new Promise(resolve => reservation.close(resolve));
      const env = {
        ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata'),
        TMPDIR: fixture, TMP: fixture, TEMP: fixture, NODE_OPTIONS: '',
        PORT: String(kp), UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        KEY_FILE: keyFile, SESSIONS_FILE: sessions, MODELMAP_FILE: modelMap,
        CONFIG_FILE: path.join(fixture, 'keepalive-config.json'), EVENTS_FILE: path.join(fixture, 'events.json'),
        LATENCY_FILE: path.join(fixture, 'latency.json'), FAILDUMP_DIR: path.join(fixture, 'faildump'),
        ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(fixture, 'local-hop.key'),
        PROXY_LOG_INGEST_URL: `http://127.0.0.1:${upstreamPort}/fixture/logs`,
        DASHBOARD_URL: `http://127.0.0.1:${upstreamPort}`, HAIKU_GPT_PROXY: `http://127.0.0.1:${upstreamPort}`,
        TOKEN_USAGE_FILE: path.join(fixture, 'usage.jsonl'), VISION_BRIDGE: '0', PAID_SINGLE_KEY: '0',
        KEEPALIVE_LOG_FILE: path.join(fixture, 'keepalive.log'),
        CUSTOM_PROVIDER_ID: spec.provider || 'freegg', FREEGG_RATE_BALANCE: spec.legacy,
        FREEGG_RATE_SCOPE: spec.envScope || 'shared', RATE_BALANCE_SCOPE: spec.envScope || 'shared',
        FREEGG_RATE_JITTER_MS: '0', RATE_BALANCE_JITTER_MS: '0', CATALOG_TTL_MS: '0',
        AUTOROTATE: '0', GPT_PROXY_FORCE: '0', LOCAL_EXACT_ADAPTER: '0', KEY_SPREAD: '0', CONN_TRACE: '0',
      };
      if (spec.generic === null) delete env.RATE_BALANCE; else env.RATE_BALANCE = spec.generic;
      if (spec.defaultFile) delete env.FREEGG_RATE_CONFIG_FILE; else env.FREEGG_RATE_CONFIG_FILE = configFile;
      const child = spawn(process.execPath, [path.join(ROOT, 'routing/keepalive-proxy.js')], { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'], env });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      try {
        let state;
        for (let i = 0; i < 100; i++) {
          try { const response = await fetch(`http://127.0.0.1:${kp}/__state`); if (response.ok) { state = await response.json(); break; } } catch {}
          if (child.exitCode !== null) throw new Error(spec.name + ': keepalive exited: ' + output);
          await wait(30);
        }
        assert.ok(state, spec.name + ': isolated readiness: ' + output);
        assert.equal(state.rateBalance?.enabled, spec.enabled, spec.name + ': persisted FreeGG config controls enabled');
        assert.equal(state.rateBalance?.scope, spec.scope, spec.name + ': effective scope');
        if (!spec.provider) assert.deepEqual(state.freeggRate, state.rateBalance, spec.name + ': exact FreeGG legacy state alias');
        const inspectionAuth = createLocalHopAuth({ secretFile: path.join(fixture, 'local-hop.key') });
        const inspection = await (await fetch(`http://127.0.0.1:${kp}/__keepalive/api/status`, {
          headers: { [inspectionAuth.headerName]: inspectionAuth.token('status-inspection') },
        })).json();
        if (!spec.provider) {
          assert.deepEqual(inspection.rateBalance, state.rateBalance, spec.name + ': inspection exposes generic state');
          assert.deepEqual(inspection.freeggRate, state.rateBalance, spec.name + ': inspection exposes legacy FreeGG alias');
        }
        results.push({ name: spec.name, rateBalance: state.rateBalance, freeggRate: state.freeggRate });
        console.log(spec.name + ': PASS ' + JSON.stringify(state.rateBalance));
      } finally {
        if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
      }
    }
    for (const explicit of [true, false]) {
      const fixture = path.join(dir, explicit ? 'selftest-override' : 'selftest-default');
      fs.mkdirSync(path.join(fixture, 'home', '.claude'), { recursive: true });
      fs.mkdirSync(path.join(fixture, 'tmp'));
      const preference = explicit ? path.join(fixture, 'freegg-rate-policy.json')
        : path.join(fixture, 'home', '.claude', 'freegg-rate-policy.json');
      fs.writeFileSync(preference, '{"enabled":true}');
      fs.writeFileSync(path.join(fixture, 'modelmap.json'), '{}');
      const attemptsFile = path.join(fixture, 'preference-reads.jsonl');
      fs.writeFileSync(path.join(fixture, 'guard.cjs'), `
'use strict';
const fs = require('node:fs');
const append = fs.appendFileSync.bind(fs);
const original = fs.readFileSync;
fs.readFileSync = function (value, ...args) {
  if (/[\\\\/]freegg-rate-policy\\.json$/i.test(String(value))) {
    append(${JSON.stringify(attemptsFile)}, JSON.stringify({ attempted: String(value) }) + '\\n');
    throw new Error('selftest must not read persisted FreeGG preference');
  }
  return original.call(this, value, ...args);
};
`);
      const env = {
        ...process.env, HOME: path.join(fixture, 'home'), USERPROFILE: path.join(fixture, 'home'),
        TMPDIR: path.join(fixture, 'tmp'), TMP: path.join(fixture, 'tmp'), TEMP: path.join(fixture, 'tmp'), NODE_OPTIONS: '',
        PORT: '0', UPSTREAM: `http://127.0.0.1:${upstreamPort}`, CUSTOM_PROVIDER_ID: 'freegg', ROTATE_PROVIDER: 'fg',
        FREEGG_RATE_BALANCE: '0', FREEGG_RATE_SCOPE: 'off', RATE_BALANCE: '0', RATE_BALANCE_SCOPE: 'off',
        CONFIG_FILE: path.join(fixture, 'config.json'), KEY_FILE: path.join(fixture, 'absent-key.txt'), SESSIONS_FILE: '',
        MODELMAP_FILE: path.join(fixture, 'modelmap.json'), KEEPALIVE_LOG_FILE: path.join(fixture, 'keepalive.log'),
        EVENTS_FILE: path.join(fixture, 'events.json'), LATENCY_FILE: path.join(fixture, 'latency.json'),
        FAILDUMP_DIR: path.join(fixture, 'faildump'), ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(fixture, 'local-hop.key'),
        PROXY_LOG_INGEST_URL: `http://127.0.0.1:${upstreamPort}/fixture/logs`, DASHBOARD_URL: `http://127.0.0.1:${upstreamPort}`,
        HAIKU_GPT_PROXY: `http://127.0.0.1:${upstreamPort}`, HAIKU_REMAP: '1', LOCAL_EXACT_ADAPTER: '0',
        GPT_PROXY_FORCE: '0', PAID_SINGLE_KEY: '0', ALLOW_PAID_HEDGE: '0', AUTOROTATE: '0',
      };
      if (explicit) env.FREEGG_RATE_CONFIG_FILE = preference; else delete env.FREEGG_RATE_CONFIG_FILE;
      const child = spawn(process.execPath, ['--require', path.join(fixture, 'guard.cjs'),
        path.join(ROOT, 'routing/keepalive-proxy.js'), 'selftest'], { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'], env });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const deadline = setTimeout(() => child.kill(), 15000);
      let code;
      try { [code] = await once(child, 'exit'); } finally { clearTimeout(deadline); }
      assert.equal(code, 0, 'isolated selftest exits successfully: ' + output);
      assert.match(output, /selftest OK/);
      assert.equal(fs.existsSync(attemptsFile), false, 'IS_SELFTEST must not read persisted FreeGG preference (' + (explicit ? 'override' : 'default') + ')');
      selftests.push({ explicit, code, preferenceReads: 0 });
      console.log('selftest ' + (explicit ? 'override' : 'default') + ': PASS, no preference read');
    }
    assert.equal(upstreamCalls, 0, 'startup/state-only fixtures must not call any upstream');
    fs.writeFileSync(path.join(dir, 'readback.json'), JSON.stringify({ passed: results.length, upstreamCalls, results, selftests }, null, 2));
    console.log('check-freegg-rate-config: PASS (' + results.length + ' cases, ' + selftests.length + ' selftests, zero upstream calls)');
  } finally {
    vendor.closeAllConnections();
    await new Promise(resolve => vendor.close(resolve));
    console.log('configured subprocess readback: ' + path.join(dir, 'readback.json'));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
