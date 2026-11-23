'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function freePort() {
  const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}
async function state(base) {
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(base + '/__state'); if (r.ok) return r.json(); } catch {}
    await wait(30);
  }
  throw new Error('legacy keepalive did not become ready');
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freegg-legacy-rate-'));
  const sessions = path.join(dir, 'sessions.json');
  const keyFile = path.join(dir, 'key.txt');
  const mapFile = path.join(dir, 'map.json');
  fs.writeFileSync(sessions, JSON.stringify([{ id:'a', newApiUserId:1, api_key:'fixture-a', active:true, status:'live' }]));
  fs.writeFileSync(keyFile, 'fixture-a'); fs.writeFileSync(mapFile, '{}');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'routing', 'keepalive-proxy.js')], {
    cwd: dir, stdio: ['ignore','pipe','pipe'], env: {
      ...process.env, PORT:String(port), UPSTREAM:'http://127.0.0.1:9', KEY_FILE:keyFile,
      SESSIONS_FILE:sessions, MODELMAP_FILE:mapFile, CUSTOM_PROVIDER_ID:'freegg',
      FREEGG_RATE_BALANCE:'1', FREEGG_RATE_SCOPE:'account', RATE_BALANCE:'0', RATE_BALANCE_SCOPE:'off',
    },
  });
  let output=''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
  try {
    const d = await state(`http://127.0.0.1:${port}`);
    assert.equal(d.rateBalance.enabled, true, output);
    assert.equal(d.rateBalance.scope, 'account');
    console.log('check-freegg-legacy-rate-runtime: PASS');
  } finally {
    child.kill(); await Promise.race([once(child, 'exit'), wait(3000)]).catch(()=>{});
    fs.rmSync(dir, { recursive:true, force:true });
  }
})().catch(e => { console.error(e.stack); process.exitCode=1; });
