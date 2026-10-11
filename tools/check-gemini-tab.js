#!/usr/bin/env node
/**
 * check-gemini-tab.js — шов вкладки Gemini в дашборде и её ручки.
 *
 * Зачем. Половина поломок вкладки — «тихие»: файл вкладки на диске есть, ручки работают, а
 * кнопки в сайдбаре нет, или правки не доезжают до браузера, или цифра в сайдбаре мёртвая.
 * Глазом это не видно, а живой `:8200` трогать нельзя (рестарт рвёт сессию владельца).
 * Поэтому шов проверяется по файлам, а ручки — по-настоящему: модуль поднимается с
 * подставным локальным сервером вкладки и отвечает на подставные же req/res.
 *
 * 🪤 Список шва — ровно тот, что предписан чек-листом добавления вкладки (ARCHITECTURE.md):
 * кнопка, панель, ленивая загрузка, реестр обновления, очередь счётчика, тег script,
 * `DEFAULT_TABS_VISIBLE`, зеркало в `check-hub.js`, `FRESH_PREFIXES`, строка делегирования.
 * Забыть любой — тихий дефект, поэтому проверяется каждый.
 *
 * Запуск: node tools/check-gemini-tab.js      (exit 1 = вкладка сломана)
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const ROUTING = path.join(REPO, 'routing');
const PROXY = path.join(ROUTING, 'transparent-proxy.js');
const HTML = path.join(ROUTING, 'proxy-dashboard.html');
const CHECK_HUB = path.join(__dirname, 'check-hub.js');
const LIFECYCLE = path.join(ROUTING, 'lifecycle.js');

let total = 0;
const fails = [];
function check(cond, msg) {
    total += 1;
    console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) fails.push(msg);
    return !!cond;
}

const read = f => fs.readFileSync(f, 'utf8');

// ── 1. Файлы вкладки на месте ────────────────────────────────────────────────
console.log('\n── 1. Файлы ──');
for (const f of ['gemini-tab.js', 'gemini-tab.css']) {
    check(fs.existsSync(path.join(ROUTING, 'vendor', f)), `vendor/${f} на диске`);
}
check(fs.existsSync(path.join(ROUTING, 'lib', 'gemini-routes.js')), 'lib/gemini-routes.js на диске');
check(fs.existsSync(path.join(REPO, 'gemini', 'src', 'index.js')), 'сервер вкладки (gemini/src/index.js) на диске');

// ── 2. Шов в proxy-dashboard.html ────────────────────────────────────────────
console.log('\n── 2. Шов дашборда ──');
const html = read(HTML);
check(/<link rel="stylesheet" href="\/vendor\/gemini-tab\.css">/.test(html), 'CSS вкладки подключён в <head>');
check(/data-tab="gemini"/.test(html), 'кнопка в сайдбаре есть');
check(/id="nav-count-gemini"/.test(html), 'счётчик в сайдбаре есть');
check(/<div data-tab-content="gemini">\s*<div id="gemini-root">/.test(html), 'панель вкладки и её корень на месте');
check(/name === 'gemini' && !state\.loaded\.gemini/.test(html), 'ленивая загрузка в showTab');
check(/typeof GEMINI !== 'undefined'/.test(html), 'гвард по typeof при вызове вкладки');
check(/case 'gemini':\s+if \(typeof GEMINI !== 'undefined'\) GEMINI\.refresh\(\)/.test(html), 'ветка в реестре обновления');
check(/\{ tab: 'gemini',\s+fn: \(\) => \(typeof GEMINI !== 'undefined'\) && GEMINI\.load\(\), mark: 'gemini' \}/.test(html), 'задача в очереди счётчиков (с mark)');
check(/<script src="\/vendor\/gemini-tab\.js"><\/script>/.test(html), 'тег script подключён');
check(/const DEFAULT_TABS_VISIBLE = \[[^\]]*'gemini'/.test(html), 'вкладка в списке видимых (иначе она hidden в сайдбаре)');

// ── 3. Зеркало в check-hub и три места, которые забывают ─────────────────────
console.log('\n── 3. Три места, которые забывают ──');
check(/const want = \[[^\]]*'gemini'/.test(read(CHECK_HUB)), 'зеркальный список в tools/check-hub.js обновлён вместе с HTML');
const proxy = read(PROXY);
check(/FRESH_PREFIXES = \[[^\]]*'gemini-tab'/.test(proxy), 'FRESH_PREFIXES знает gemini-tab (иначе правки не доедут до браузера)');
check(/if \(geminiRoutes\.handle\(req, res\)\) return;/.test(proxy), 'строка делегирования в лестнице ручек');
check(/const geminiRoutes = require\('\.\/lib\/gemini-routes'\)/.test(proxy), 'модуль подключается один раз');
check(/geminiRoutes\.setHub\(\{[\s\S]{0,200}?log: logLine[\s\S]{0,200}?earlyFailure: sessionOpenEarlyFailure/.test(proxy),
    'модулю отданы logLine и ранний пробник окна');
check(/\{ port: 20178, name: 'Gemini \(Antigravity\)', respawn: true \}/.test(read(LIFECYCLE)),
    'порт вкладки в lifecycle.children() (попав туда, он резервируется от аллокатора кастомов)');

// ── 3б. Шов переключения бэкенда (этап 3) ────────────────────────────────────
console.log('\n── 3б. Переключение и тир-карта ──');
check(/const GEMINI_KEEPALIVE_URL_EARLY = 'http:\/\/127\.0\.0\.1:20179'/.test(proxy),
    'ранний литерал адреса — ШЛЮЗ (:20179), а не движок (в BACKENDS его иначе не поставить)');
check(/GEMINI_KEEPALIVE_URL_EARLY !== GEMINI_KEEPALIVE_URL/.test(proxy),
    'расхождение литерала и порта модуля роняет старт, а не уводит трафик в пустоту');
check(/gemini: \{\s*\n\s*label: 'Gemini \(Antigravity, подписка Google\)'/.test(proxy), 'бэкенд gemini объявлен в BACKENDS');
check(/gemini: 'gemini',/.test(proxy), 'префикс gemini в CC_MODEL_PREFIX (иначе /model gemini/... не работает)');
check(/gm: 'gemini',/.test(proxy), 'короткий алиас gm в BACKEND_ALIASES');
check(/async function geminiKeepaliveSpawn\(\)/.test(proxy), 'шлюз вкладки поднимается своим спавном');
check(/UPSTREAM: GEMINI_ENGINE_URL/.test(proxy) && /MODELMAP_FILE: GEMINI_MODELMAP_FILE/.test(proxy),
    '🪤 шлюз смотрит на движок и читает тир-карту вкладки — именно он переводит claude-opus-5 в модель Google');
check(/await geminiRoutes\.spawnServer\(\);\s*\n\s*let settingsOk/.test(proxy) || /await geminiRoutes\.spawnServer\(\)/.test(proxy),
    'перед активацией поднимается движок (мёртвый движок за живым шлюзом — это 502 без причины)');
check(/\[GEMINI_KEEPALIVE_PORT\]: \{ name: 'Gemini шлюз', spawn: geminiKeepaliveSpawn \}/.test(proxy),
    'порт шлюза в keepaliveInstances() — иначе кнопка «перезапустить» в Health его не знает');
check(/\[GEMINI_ENGINE_PORT\]: \{ name: 'Gemini движок'/.test(proxy), 'порт движка тоже в keepaliveInstances()');
check(/const keep = new Set\(\[AR_KEEPALIVE_PORT, frontdoorPort\(\), active, GEMINI_ENGINE_PORT\]\)/.test(proxy),
    'движок вкладки переживает рестарт дашборда (а шлюз — нет: его поднимает активация)');
check(/geminiRoutes\.setHub\(\{[\s\S]{0,400}?hooks: \{/.test(proxy), 'модулю отданы hooks переключения');
check(fs.existsSync(path.join(ROUTING, 'gemini-modelmap.json')), 'тир-карта активного пути на диске');
check(fs.existsSync(path.join(ROUTING, 'gemini-routes-modelmap.json')), 'тир-карта префиксного пути на диске');
check(/writeTierMap\(GEMINI_MODELMAP_FILE, \{ opus: model \}, null\)/.test(proxy),
    '🪤 выбор «главной модели» переписывает и тир opus: иначе выбранная модель жила бы до первого запроса чужого имени');

// ── 4. Ручки: поднимаем подставной сервер вкладки и дёргаем модуль ───────────
const CLIENT_VERSION_OK = { ok: true, name: 'gemini', up: true, accounts: 2, available: 2, summary: '2 total, 2 available' };
const ACCOUNTS = {
    status: 'ok',
    accounts: [
        { email: 'a@example.com', tier: 'pro', enabled: true, isInvalid: false, quota: { models: ['m1'], perModel: { m1: { remainingFraction: 0.5 } }, minFraction: 0.5, lastChecked: new Date().toISOString() }, refreshToken: 'СЕКРЕТ' },
        { email: 'b@example.com', tier: 'free', enabled: false, isInvalid: false, quota: { models: [], perModel: {}, minFraction: null, lastChecked: null } },
    ],
};

(async () => {
    console.log('\n── 4. Ручки ──');
    // 🪤 Порт для пробы — СВОЙ (20979, вне диапазона аллокатора 20150-20250), а не боевые
    // 20178/20179: на боевых может стоять живой сервер вкладки и её шлюз, и тогда проверка
    // либо топтала бы их, либо (как было сначала) пропускалась молча — то есть ручки
    // оставались бы непроверенными ровно там, где это нужнее всего.
    // Модуль читает порт из `GEMINI_PORT`, поэтому подстановка идёт ДО его require.
    const STUB_PORT = 20979;
    process.env.GEMINI_PORT = String(STUB_PORT);

    let stub = null;
    const canStub = await new Promise(resolve => {
        const s = http.createServer((req, res) => {
            const url = req.url.split('?')[0];
            const send = (body, code = 200) => {
                const b = Buffer.from(JSON.stringify(body), 'utf8');
                res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
                res.end(b);
            };
            if (url === '/status' || url === '/__keepalive/api/status') return send(CLIENT_VERSION_OK);
            if (url === '/api/accounts') return send(ACCOUNTS);
            if (url === '/v1/models') return send({ data: [{ id: 'gemini-3.8-flash-tiered' }] });
            return send({ status: 'ok' });
        });
        s.once('error', () => resolve(false));
        s.listen(STUB_PORT, '127.0.0.1', () => { stub = s; resolve(true); });
    });

    if (!canStub) {
        console.log(`  · порт ${STUB_PORT} занят — проверка ручек пропущена`);
    } else {
        const gr = require(path.join(ROUTING, 'lib', 'gemini-routes.js'));
        const logs = [];
        gr.setHub({ log: m => logs.push(m) });

        const call = (method, url, body) => new Promise(resolve => {
            const res = { code: null, headers: null, writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { resolve({ code: this.code, body: JSON.parse(b) }); } };
            const req = { method, url, on() {}, };
            if (body) { req.on = (ev, fn) => { if (ev === 'data') fn(Buffer.from(JSON.stringify(body))); if (ev === 'end') fn(); }; }
            else { req.on = (ev, fn) => { if (ev === 'end') fn(); }; }
            gr.handle(req, res);
        });

        check(gr.handle({ method: 'GET', url: '/__switch/api/google/list', on() {} }, {}) === false,
            'чужой префикс не перехватывается (иначе вкладка Google умерла бы)');

        const list = await call('GET', '/__switch/api/gemini/list');
        check(list.code === 200 && list.body.total === 2, `list отдаёт пул (${list.body && list.body.total} аккаунта)`);
        check(list.body.server && list.body.server.up === true, 'list отдаёт состояние сервера вкладки');

        const models = await call('GET', '/__switch/api/gemini/models');
        check(models.code === 200 && models.body.models.includes('gemini-3.8-flash-tiered'), 'каталог моделей отдаётся');

        const bad = await call('POST', '/__switch/api/gemini/server', { action: 'нет-такого' });
        check(bad.code === 400, 'неизвестное действие сервера — 400, а не тихое «ок»');

        const unknown = await call('GET', '/__switch/api/gemini/чего-то-нет');
        check(unknown.code === 404, 'неизвестный маршрут — 404');

        // 🪤 Подставной сервер отдаёт запись С refreshToken (как её отдал бы неаккуратный
        // апстрим): модуль обязан вырезать секрет сам, а не полагаться на чужую форму ответа.
        const leak = JSON.stringify(list.body);
        check(!leak.includes('СЕКРЕТ'), 'модуль сам вырезает refreshToken, даже если сервер его отдал');
        check(list.body.accounts.every(a => a.hasToken === true || a.hasToken === false), 'вместо секрета уезжает признак hasToken');

        // ── Переключение бэкенда: без хаба честный отказ, с хабом — его машинерия ──
        const noHook = await call('POST', '/__switch/api/gemini/activate', {});
        check(noHook.code === 501, 'без хаба переключение честно отказывает, а не делает вид, что переключило');

        let hooked = null;
        gr.setHub({
            log: () => {},
            hooks: {
                activate: (req, res) => { hooked = 'activate'; res.writeHead(200, {}); res.end(JSON.stringify({ ok: true, model: 'gemini-3.6-flash-high' })); },
                setModel: (req, res) => { hooked = 'set-model'; res.writeHead(200, {}); res.end(JSON.stringify({ ok: true, appliedModel: 'gemini-3.6-flash-medium' })); },
                modelMap: (req, res) => { hooked = 'modelmap'; res.writeHead(200, {}); res.end(JSON.stringify({ ok: true, modelMap: { opus: 'x' } })); },
                readModelMap: () => ({ opus: 'gemini-3.6-flash-high', sonnet: '', haiku: '' }),
                activeModel: () => 'gemini-3.6-flash-high',
            },
        });
        const act = await call('POST', '/__switch/api/gemini/activate', {});
        check(act.code === 200 && hooked === 'activate', 'с хабом переключение уходит в его машинерию (writeSettings и фронт-дверь)');
        const setM = await call('POST', '/__switch/api/gemini/set-model', { model: 'm' });
        check(setM.code === 200 && hooked === 'set-model', 'выбор модели тоже уходит в хаб');
        const mm = await call('GET', '/__switch/api/gemini/modelmap');
        check(mm.code === 200 && mm.body.modelMap.opus === 'gemini-3.6-flash-high' && mm.body.activeModel === 'gemini-3.6-flash-high',
            'GET modelmap отдаёт и карту, и активную модель');
        const saveMm = await call('POST', '/__switch/api/gemini/modelmap', { opus: 'a' });
        check(saveMm.code === 200 && hooked === 'modelmap', 'сохранение тиров уходит в хаб');
    }

    console.log(fails.length ? `\nпровалено ${fails.length} из ${total}` : `\n${total}/${total} проверок пройдено`);
    // 🪤 Без `process.exit()`: выход «в лоб» при живом (уже закрывающемся) сокете стенда
    // роняет Node на Windows ассерцией libuv, и зелёный прогон отдаёт код 9 вместо нуля —
    // то есть проверка врёт ровно там, где должна молчать.
    if (stub) stub.close();
    process.exitCode = fails.length ? 1 : 0;
})();
