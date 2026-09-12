#!/usr/bin/env node
// Regression: New-API HTTP is direct-first and retries exactly once through the sticky
// account proxy only for transport exceptions, WAF HTML, or HTTP 429.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const POOL = require(path.join(ROOT, 'routing', 'lib', 'proxy-pool.js'));
const ACC = require(path.join(ROOT, 'routing', 'lib', 'newapi-account.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-first-check-'));
const realFetch = global.fetch;
const realFetchVia = POOL.fetchVia;
let fail = 0;
function check(ok, what) { console.log(`   ${ok ? '·' : '×'} ${what}`); if (!ok) fail++; }
function response(payload, status = 200, type = 'application/json') {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return { status, ok: status >= 200 && status < 300,
        headers: { get: n => n.toLowerCase() === 'content-type' ? type : null, getSetCookie: () => [] },
        text: async () => text };
}
async function scenario(name, direct, expectedProxy, assertions) {
    console.log(`\n${name}`);
    const saved = { ...process.env };
    Object.assign(process.env, {
        PROXY_POOL: 'http://203.0.113.90:8080', PROXY_POOL_HOSTS: 'retry.example',
        PROXY_POOL_ASSIGN: path.join(TMP, `${name.replace(/\W/g, '_')}.json`), PROXY_POOL_PREFLIGHT_TTL: '0',
    });
    POOL._reset();
    let directCalls = 0, proxyCalls = 0;
    global.fetch = async (...args) => { directCalls++; return typeof direct === 'function' ? direct(...args) : direct; };
    POOL.fetchVia = async () => { proxyCalls++; return response({ success: true, via: 'proxy' }); };
    try {
        const out = await ACC.accountFetch({ host: 'retry.example', accountId: `acct_${name}`, url: 'https://retry.example/api/user/self' });
        check(directCalls === 1, `direct attempted exactly once (got ${directCalls})`);
        check(proxyCalls === expectedProxy, `proxy attempts ${expectedProxy} (got ${proxyCalls})`);
        assertions(out);
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved); POOL.fetchVia = realFetchVia; global.fetch = realFetch; POOL._reset();
    }
}

(async () => {
await scenario('1. direct success', response({ success: true }), 0, out => {
    check(out.ok && out.viaProxy === false, 'direct result shape preserved with viaProxy=false');
});
await scenario('2. transport exception', () => { throw new Error('ECONNRESET original'); }, 1, out => {
    check(out.ok && out.viaProxy === true, 'transport failure retries once through proxy');
});
await scenario('3. WAF HTML', response('<html>challenge</html>', 200, 'text/html'), 1, out => {
    check(out.ok && out.viaProxy === true, 'WAF HTML retries once through proxy');
});
await scenario('4. HTTP 429', response({ error: 'slow down' }, 429), 1, out => {
    check(out.ok && out.viaProxy === true, '429 retries once through proxy');
});
await scenario('5. HTTP 401', response({ error: 'auth' }, 401), 0, out => {
    check(out.status === 401 && out.viaProxy === false, '401 is returned directly without proxy retry');
});
await scenario('6. HTTP 403', response({ error: 'forbidden' }, 403), 0, out => {
    check(out.status === 403 && out.viaProxy === false, '403 is returned directly without proxy retry');
});
await scenario('7. semantic HTTP 500', response({ error: 'server' }, 500), 0, out => {
    check(out.status === 500 && out.viaProxy === false, 'other semantic response is not retried');
});

console.log('\n8. fallback failure preserves original failure');
{
    const saved = { ...process.env };
    Object.assign(process.env, { PROXY_POOL: 'http://203.0.113.91:8080', PROXY_POOL_HOSTS: 'retry.example',
        PROXY_POOL_ASSIGN: path.join(TMP, 'fallback.json'), PROXY_POOL_PREFLIGHT_TTL: '0' });
    POOL._reset(); global.fetch = async () => { throw new Error('ECONNRESET original'); };
    POOL.fetchVia = async () => { throw new Error('proxy tunnel dead'); };
    const out = await ACC.accountFetch({ host: 'retry.example', accountId: 'acct_fail', url: 'https://retry.example/api/status' });
    check(out.ok === false && out.proxyError === true, 'fallback failure is explicit');
    check(/ECONNRESET original/.test(out.error || ''), 'original direct failure remains visible');
    check(/proxy tunnel dead/.test(out.proxyFallbackError || out.error || ''), 'proxy fallback reason remains visible');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved); POOL.fetchVia = realFetchVia; global.fetch = realFetch; POOL._reset();
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(fail ? `\n❌ ${fail} failed` : '\n✅ Direct-first transport retries only transport/WAF/429 exactly once.');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
