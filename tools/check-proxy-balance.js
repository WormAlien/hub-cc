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
        // 🪤 Источник задаём ЯВНО: он живёт в боевом `routing/proxy-pool.json`, и когда владелец
        // переключает его на «только свой», песочница подхватывает настройку и валит проверки -
        // тест начинает мерить не своё поведение, а чужую настройку боя.
        PROXY_POOL_SOURCE: 'auto', PROXY_POOL_OWN: '',
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

// ── 9. agentrouter: сначала адрес аккаунта, прямой путь - только если адреса нет ──
// Решение владельца 20.09 (вариант 3 из трёх): чек идёт ТЕМ ЖЕ адресом, что и перелогин,
// но если адрес в отстое - прямым путём, чтобы отчёт не врал «шлюз лежит».
async function arScenario(name, key, { cooling, ledgerUsed = 0 }, assertions) {
    console.log(`\n${name}`);
    const saved = { ...process.env };
    // 🪤 Короткий ключ для файла: русское имя в пути Windows раздувается до сотни знаков
    // (кириллица заменяется подчёркиваниями) и упирается в предел длины пути.
    const assign = path.join(TMP, `ar-${key}.json`);
    const ADDR = 'http://203.0.113.90:8080';
    if (!fs.existsSync(assign)) fs.writeFileSync(assign, '{"version":1,"assign":{}}', 'utf8');
    const doc = JSON.parse(fs.readFileSync(assign, 'utf8'));
    doc.assign = { acct_ar: { proxy: ADDR, at: new Date().toISOString(), why: 'тест', host: 'agentrouter.org' } };
    doc.ledger = {};
    if (cooling) doc.ledger[ADDR] = { used: 0, until: new Date(Date.now() + 600000).toISOString() };
    else if (ledgerUsed) doc.ledger[ADDR] = { used: ledgerUsed, until: null, at: new Date().toISOString() };
    fs.writeFileSync(assign, JSON.stringify(doc), 'utf8');

    Object.assign(process.env, {
        PROXY_POOL: ADDR, PROXY_POOL_HOSTS: 'agentrouter.org', PROXY_POOL_ASSIGN: assign,
        PROXY_POOL_PREFLIGHT_TTL: '0', PROXY_POOL_ROTATE_AFTER: '15', PROXY_POOL_COOLDOWN_MS: '600000',
        PROXY_POOL_SOURCE: 'auto',
    });
    POOL._reset();
    let directCalls = 0, proxyCalls = 0;
    global.fetch = async () => { directCalls++; return response({ success: true, via: 'direct' }); };
    POOL.fetchVia = async () => { proxyCalls++; return response({ success: true, via: 'proxy' }); };
    try {
        const out = await ACC.accountFetch({ host: 'agentrouter.org', accountId: 'acct_ar', url: 'https://agentrouter.org/api/user/self' });
        assertions(out, { directCalls, proxyCalls });
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

await arScenario('9a. адрес аккаунта есть и не в отстое - идём ИМ, прямого запроса нет', '9a', { cooling: false }, (out, c) => {
    check(c.proxyCalls === 1, `адрес попробован один раз (получено ${c.proxyCalls})`);
    check(c.directCalls === 0, `прямой запрос не делался вовсе (получено ${c.directCalls})`);
    check(out.ok && out.viaProxy === true, 'ответ помечен как идущий через адрес аккаунта');
});

await arScenario('9b. адрес в отстое - идём прямым путём, адрес не трогаем', '9b', { cooling: true }, (out, c) => {
    check(c.directCalls === 1, `прямой запрос сделан один раз (получено ${c.directCalls})`);
    check(c.proxyCalls === 0, `сожжённый адрес не тронут (получено ${c.proxyCalls})`);
    check(out.ok && out.viaProxy === false, 'ответ прямой - отчёт не соврёт про шлюз');
});

console.log(fail ? `\n❌ ${fail} failed` : '\n✅ Direct-first transport retries only transport/WAF/429 exactly once.');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
