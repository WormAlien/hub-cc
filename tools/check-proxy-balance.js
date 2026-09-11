#!/usr/bin/env node
// Точный баланс через прокси: один аккаунт — один исходящий адрес, и ни одного тихого
// похода напрямую.
//
// Зачем. Замер 10.09: публичная `GET /api/status` вернула ПУСТОЕ тело на седьмом подряд
// прогоне — край режет домашний IP, с которого ходят 20+ аккаунтов. Пул прокси написан,
// но до этой правки интеграция была МЁРТВОЙ: `accountProxy()` не вызывался нигде, все
// `apiFetch()` шли без `proxy`, а `apiFetchRawAuth()` вообще ходил голым `fetch`.
//
// 🪤 Главная проверка файла — НЕ «прокси используется», а «аккаунт не светится двумя IP».
// Чек баланса это цепочка запросов (`/api/status` → refresh/self → повтор по cookie id),
// и если хоть один из них уйдёт мимо туннеля, панель увидит два адреса в одном сеансе —
// ровно тот сигнал, от которого прокси и защищает.
//
// Сети здесь нет: `fetchVia` подменяется записывающей заглушкой, глобальный `fetch`
// подменяется капканом. Наружу регресс не ходит.
//
// Запуск: node tools/check-proxy-balance.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POOL = require(path.join(ROOT, 'routing', 'lib', 'proxy-pool.js'));
const ACC = require(path.join(ROOT, 'routing', 'lib', 'newapi-account.js'));

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};

process.env.PROXY_POOL_PREFLIGHT_TTL = '0';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-balance-check-'));
const realFetchVia = POOL.fetchVia;
const realFetch = global.fetch;

// Ответ в форме, которую разбирает apiFetch: status/ok/headers.get/getSetCookie/text.
function fakeResponse(payload, status = 200) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => null, getSetCookie: () => [] },
        text: async () => text,
        json: async () => JSON.parse(text),
    };
}

const SELF = { success: true, data: { id: 7, username: 'probe', quota: 5_000_000, used_quota: 1_000_000 } };
const STATUS = { success: true, data: { quota_per_unit: 500_000, quota_display_type: 'USD' } };

// Пул, глобальный fetch и env приводятся в исходное состояние всегда — иначе следующая
// секция мерила бы чужую настройку.
async function withEnv(env, fn) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    POOL._reset();
    try { return await fn(); }
    finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
        POOL.fetchVia = realFetchVia;
        global.fetch = realFetch;
        POOL._reset();
    }
}

// Ответ по адресу: и туннель, и прямой путь отвечают одинаково, поэтому расхождение в
// проверках означает разницу в МАРШРУТЕ, а не в данных.
function respond(url) {
    if (url.includes('/api/status')) return fakeResponse(STATUS);
    if (url.includes('/api/user/self')) return fakeResponse(SELF);
    return fakeResponse({ success: true, data: {} });
}

// Записывает каждый вызов и отвечает по URL. Один и тот же объект-заглушка на всю секцию,
// чтобы было видно ВСЮ цепочку запросов аккаунта, а не последний из них.
function recorder() {
    const calls = [];
    POOL.fetchVia = async (proxy, url, opts = {}) => {
        calls.push({ proxy: proxy && proxy.id, url, method: opts.method || 'GET' });
        return respond(String(url));
    };
    return calls;
}

function trapDirect() {
    const hits = [];
    global.fetch = async (url) => {
        hits.push(String(url));
        return respond(String(url));
    };
    return hits;
}

(async () => {

// ── 1. пул выключен — прежний путь, буква в букву ──
console.log('\n1. пул не настроен: ходим напрямую, как до правки');
await withEnv({ PROXY_POOL_ENABLED: '0', PROXY_POOL_ASSIGN: path.join(TMP, 'a1.json') }, async () => {
    const direct = trapDirect();
    const calls = recorder();
    const r = await ACC.accountSelf({
        host: 'px-off.example', profileDir: null, accessToken: 'tok', accountId: 'acct_off',
    });
    check(r.ok === true, 'баланс посчитан');
    check(r.balance === 10 && r.spent === 2, 'цифры те же, что и без прокси (5M/500k = $10, расход $2)');
    check(direct.length > 0, 'запросы ушли обычным fetch');
    check(calls.length === 0, 'туннель не задействован ни разу');
});

// ── 2. назначенный прокси мёртв — НЕ идти напрямую ──
console.log('\n2. мёртвый прокси не превращается в поход с домашнего IP');
await withEnv({
    PROXY_POOL: 'http://127.0.0.1:1',
    PROXY_POOL_HOSTS: 'px-dead.example',
    PROXY_POOL_ASSIGN: path.join(TMP, 'a2.json'),
    // Здесь preflight ОБЯЗАН работать: именно он ловит мёртвый адрес до запроса.
    // 127.0.0.1:1 отвечает мгновенным отказом, наружу проверка не ходит.
    PROXY_POOL_PREFLIGHT_TTL: '600000',
}, async () => {
    const direct = trapDirect();
    const r = await ACC.accountSelf({
        host: 'px-dead.example', profileDir: null, accessToken: 'tok', accountId: 'acct_dead',
    });
    check(r.ok === false, 'чек баланса честно провален');
    check(r.proxyError === true, 'причина названа отдельным признаком proxyError, а не спрятана в текст');
    check(direct.length === 0, '🔴 ГЛАВНОЕ: ни одного запроса напрямую — домашний IP не засветился');
});

// ── 3. вся цепочка аккаунта идёт через ОДИН адрес ──
console.log('\n3. один аккаунт — один исходящий адрес на всю цепочку');
await withEnv({
    PROXY_POOL: 'http://203.0.113.91:8080,http://203.0.113.92:8080',
    PROXY_POOL_HOSTS: 'px-live.example',
    PROXY_POOL_ASSIGN: path.join(TMP, 'a3.json'),
}, async () => {
    const direct = trapDirect();
    const calls = recorder();
    const r = await ACC.accountSelf({
        host: 'px-live.example', profileDir: null, accessToken: 'tok', accountId: 'acct_live',
    });
    check(r.ok === true, 'баланс посчитан через туннель');
    check(direct.length === 0, 'ни один запрос не утёк мимо прокси');
    const ids = [...new Set(calls.map(c => c.proxy))];
    check(ids.length === 1 && ids[0], `все ${calls.length} запроса ушли через ОДИН прокси (${ids[0] || '—'})`);
    check(calls.some(c => c.url.includes('/api/status')), 'метаданные шлюза тоже через прокси, а не напрямую');
    check(calls.some(c => c.url.includes('/api/user/self')), 'raw-auth запрос self тоже через прокси');

    // Липкость на уровне чека: второй чек того же аккаунта обязан взять тот же адрес.
    const again = recorder();
    await ACC.accountSelf({ host: 'px-live.example', profileDir: null, accessToken: 'tok', accountId: 'acct_live' });
    const sameIds = [...new Set(again.map(c => c.proxy))];
    check(sameIds.length === 1 && sameIds[0] === ids[0], 'повторный чек аккаунта пошёл тем же адресом');

    // Соседний аккаунт получает свой адрес — иначе пул не решает задачу.
    const neighbour = recorder();
    await ACC.accountSelf({ host: 'px-live.example', profileDir: null, accessToken: 'tok', accountId: 'acct_other' });
    const otherIds = [...new Set(neighbour.map(c => c.proxy))];
    check(otherIds.length === 1 && otherIds[0] !== ids[0], 'у соседнего аккаунта свой адрес');
});

// ── 4. usage ходит той же обёрткой, что и self ──
console.log('\n4. usage не светит второй IP');
check(typeof ACC.accountFetch === 'function',
    'экспортирована обёртка accountFetch — общий вход для self и usage');
await withEnv({
    PROXY_POOL: 'http://203.0.113.95:8080',
    PROXY_POOL_HOSTS: 'px-usage.example',
    PROXY_POOL_ASSIGN: path.join(TMP, 'a4.json'),
}, async () => {
    const direct = trapDirect();
    const calls = recorder();
    const self = await ACC.accountSelf({
        host: 'px-usage.example', profileDir: null, accessToken: 'tok', accountId: 'acct_usage',
    });
    const usage = await ACC.accountFetch({
        host: 'px-usage.example', accountId: 'acct_usage',
        url: 'https://px-usage.example/api/dashboard/billing/usage',
        options: { headers: { authorization: 'tok' } },
    });
    check(self.ok === true && usage.ok === true, 'и self, и usage выполнены');
    check(direct.length === 0, 'usage не ушёл мимо туннеля');
    const ids = [...new Set(calls.map(c => c.proxy))];
    check(ids.length === 1, 'usage и self светят панели ОДИН адрес, а не два');
    check(calls.some(c => c.url.includes('/billing/usage')), 'запрос usage действительно прошёл через прокси');
});

await withEnv({ PROXY_POOL_ENABLED: '0', PROXY_POOL_ASSIGN: path.join(TMP, 'a5.json') }, async () => {
    const direct = trapDirect();
    const r = await ACC.accountFetch({
        host: 'px-usage-off.example', accountId: 'acct_usage',
        url: 'https://px-usage-off.example/api/dashboard/billing/usage',
    });
    check(r.ok === true && direct.length === 1, 'при выключенном пуле accountFetch — это обычный fetch');
});

// ── 5. вызывающая сторона передаёт id аккаунта ──
console.log('\n5. дашборд передаёт id аккаунта, а не только хост');
{
    const src = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8').replace(/\r\n/g, '\n');
    const balance = src.slice(src.indexOf('async function newapiBalance'), src.indexOf('async function newapiBalance') + 20000);
    check(/accountSelf\(\{[^}]*accountId:\s*target\.id/s.test(balance),
        'newapiBalance передаёт accountId: target.id — иначе липкость считалась бы по профилю или хосту');
    check(/accountFetch\(/.test(balance),
        'usage в newapiBalance идёт через accountFetch, а не голым fetch');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* песочница */ }

console.log(fail
    ? `\n❌ ${fail} провалено`
    : '\n✅ Баланс через прокси: цепочка аккаунта идёт одним адресом, usage не светит второй, отказ вместо тихого direct.');
process.exit(fail ? 1 : 0);

})();
