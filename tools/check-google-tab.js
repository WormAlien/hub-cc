#!/usr/bin/env node
/**
 * check-google-tab.js — регресс на вкладку Google: шов в дашборде и ручки модуля.
 *
 * Инвариант одной строкой: вкладка вшита во все точки шва (включая три, которые забывают),
 * а её ручки отдают список БЕЗ секретов, секреты - только по явному запросу, и битый пул
 * не выглядит как пустой.
 *
 * Почему проверки поведенческие. Каждая поломка здесь тихая:
 *   · забытый `DEFAULT_TABS_VISIBLE` - кнопка есть в DOM, но с классом `hidden`, и нажать её
 *     физически нельзя («element is not visible», ловилось на живой проверке MEDIA);
 *   · забытый `FRESH_PREFIXES` - правка вкладки не доедет до браузера вообще;
 *   · ручка без строки делегирования отвечает 404 на нажатие и не роняет прокси - вкладка
 *     просто «не работает», без ошибки в логе;
 *   · `list`, начавший отдавать пароль, светит пул в опросе раз в 15 секунд (у GitHub-вкладки
 *     и `keys`, и `list` возят секреты - это её изъян, а не образец);
 *   · `load()`, вернувший пустой список на нулёвке, разрешает записать поверх огрызка.
 *
 * 🪤 Ручки гоняются ПО-НАСТОЯЩЕМУ: модуль поднимается с подменённым `GOOGLE_DIR`, ему
 * подаются подставные `req`/`res`, и ответ читается из того, что он написал в `res.end`.
 * Сети нет, дашборд не нужен, `:8200` не задет, живой пул не читается и не пишется.
 *
 * Запуск: node tools/check-google-tab.js        (exit 1 = связка порвана)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PROXY = path.join(REPO, 'routing', 'transparent-proxy.js');
const HTML = path.join(REPO, 'routing', 'proxy-dashboard.html');
const TABJS = path.join(REPO, 'routing', 'vendor', 'google-tab.js');
const TABCSS = path.join(REPO, 'routing', 'vendor', 'google-tab.css');
const ROUTES = path.join(REPO, 'routing', 'lib', 'google-routes.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'google-tab-'));
process.env.GOOGLE_DIR = TMP;
const pool = require(path.join(REPO, 'routing', 'lib', 'google-pool.js'));
const routes = require(ROUTES);

const fails = [];
let total = 0;
const say = (s) => console.log(s);
const section = (t) => say(`\n── ${t} ──`);
function check(cond, msg) {
    total += 1;
    say(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) fails.push(msg);
    return !!cond;
}

// 🪤 CRLF нормализуем: в этом репозитории `transparent-proxy.js` и `proxy-dashboard.html`
// лежат в CRLF, а `vendor/*` в LF. Без нормализации поиск по концу строки врёт.
const read = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { return null; } };

const proxy = read(PROXY) || '';
const html = read(HTML) || '';
const tabJs = read(TABJS) || '';
const tabCss = read(TABCSS) || '';

// ── Подставной HTTP ───────────────────────────────────────────────────────────
// Просим ручки так же, как их позовёт сервер: `handle(req, res)`. Ответ читаем из res.end.

function call(method, url, body) {
    return new Promise((resolve) => {
        const req = new EventEmitter();
        req.method = method;
        req.url = url;
        req.destroy = () => {};
        const res = {
            statusCode: 0,
            writeHead(code) { this.statusCode = code; },
            end(payload) {
                let json = null;
                try { json = JSON.parse(String(payload)); } catch { /* не JSON - оставим null */ }
                resolve({ code: this.statusCode, json, raw: String(payload) });
            },
        };
        const handled = routes.handle(req, res);
        if (!handled) return resolve({ code: 0, json: null, foreign: true });
        process.nextTick(() => {
            if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
            req.emit('end');
        });
    });
}

// ── 1. Шов: шесть вставок ─────────────────────────────────────────────────────
section('1. Шов в дашборде');
check(html.includes('<link rel="stylesheet" href="/vendor/google-tab.css">'), 'стиль вкладки подключён в <head>');
check(/data-tab="google"/.test(html), 'кнопка вкладки есть в сайдбаре');
check(/data-tab-content="google"/.test(html) && /id="google-root"/.test(html), 'панель вкладки с корнем разметки есть');
check(/if \(name === 'google' && !state\.loaded\.google\) \{ state\.loaded\.google = true; if \(typeof GOOGLE !== 'undefined'\) GOOGLE\.load\(\)\.?;?/.test(html)
    || /state\.loaded\.google = true; if \(typeof GOOGLE !== 'undefined'\) GOOGLE\.load\(\);/.test(html),
    'ленивая инициализация в showTab с гвардом typeof');
check(/case 'google':\s*if \(typeof GOOGLE !== 'undefined'\) GOOGLE\.refresh\(\);/.test(html), 'ручка в реестре обновления вкладок');
check(/\{ tab: 'google',\s*fn: \(\) => \(typeof GOOGLE !== 'undefined'\) && GOOGLE\.load\(\), mark: 'google' \}/.test(html),
    'вкладка в NAV_COUNT_JOBS (цифра в сайдбаре)');
check(/<script src="\/vendor\/google-tab\.js"><\/script>/.test(html), 'скрипт вкладки подключён');
// Скрипт обязан стоять в конце body: если он раньше, `GOOGLE` не успеет появиться к
// первому показу вкладки, и ленивый инит с гвардом молча ничего не сделает.
const scriptAt = html.indexOf('<script src="/vendor/google-tab.js">');
const bodyEnd = html.lastIndexOf('</body>');
check(scriptAt > 0 && bodyEnd > scriptAt, 'скрипт стоит до </body>, а не в середине страницы');

section('2. Три точки, которые забывают');
check(/const DEFAULT_TABS_VISIBLE = \[[^\]]*'outlook', 'google',/.test(html),
    "DEFAULT_TABS_VISIBLE: 'google' стоит сразу за 'outlook' (иначе кнопка скрыта классом hidden)");
check(/FRESH_PREFIXES = \[[^\]]*'google-tab'/.test(proxy),
    "FRESH_PREFIXES знает 'google-tab' (иначе правка вкладки не доедет до браузера)");
check(/const want = \[[^\]]*'outlook', 'google',/.test(read(path.join(REPO, 'tools', 'check-hub.js')) || ''),
    "список префиксов в tools/check-hub.js обновлён тем же порядком");

section('3. Проводка в transparent-proxy.js');
check(/googleRoutes\.handle\(req, res\)\) return;/.test(proxy), 'строка делегирования стоит в лестнице');
check(/const googleRoutes = require\('\.\/lib\/google-routes'\)/.test(proxy), 'модуль подключается один раз, а не в каждом запросе');
check(/googleRoutes\.setHub\(\{ log: logLine, earlyFailure: sessionOpenEarlyFailure \}\)/.test(proxy),
    'лог и пробник окна передаются инъекцией (копий в repo нет)');

// ── 4. Ручки: секреты и битый пул ─────────────────────────────────────────────
section('4. Ручки: список без секретов');

const PASS = 'Lox-Nebe1naya-9';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

(async () => {
    // Чужой префикс модуль не перехватывает — иначе он съел бы ручки соседних вкладок.
    const foreign = await call('GET', '/__switch/api/ol/list');
    check(foreign.foreign === true, 'чужой префикс модуль не перехватывает');

    const added = await call('POST', '/__switch/api/google/add', {
        email: 'acc.one@gmail.com', password: PASS, totpSecret: TOTP, recoveryEmail: 'reserve@mail.ru',
        phone: '+7 900 000-00-00', proxy: 'res-fi-01', kind: 'personal',
    });
    check(added.code === 200 && added.json.ok === true, 'add заводит аккаунт');
    const id = added.json.id;

    const list = await call('GET', '/__switch/api/google/list');
    check(list.code === 200 && list.json.accounts.length === 1, 'list отдаёт запись');
    const view = list.json.accounts[0];
    check(!('password' in view) && !('totpSecret' in view), 'в списке нет полей password и totpSecret');
    check(!list.raw.includes(PASS) && !list.raw.includes(TOTP), 'пароль и 2FA-секрет не встречаются в ответе списка');
    check(view.hasPassword === true && view.hasTotp === true, 'вместо секретов - признаки hasPassword и hasTotp');
    check(view.email === 'acc.one@gmail.com' && view.proxy === 'res-fi-01', 'остальные поля на месте');
    check(typeof view.hasProfile === 'boolean' && 'openPid' in view, 'карточка знает про профиль и открытое окно');
    check(list.json.withTotp === 1 && list.json.total === 1, 'сводка посчитана');

    // 🪤 Запрос с query - именно то, на чём спотыкается лестница соседних вкладок (`req.url ===`).
    const withQuery = await call('GET', '/__switch/api/google/list?cache=0');
    check(withQuery.code === 200, 'query-строка в адресе не ломает ручку');

    const keys = await call('GET', `/__switch/api/google/keys?id=${encodeURIComponent(id)}`);
    check(keys.code === 200 && keys.json.password === PASS && keys.json.totpSecret === TOTP,
        'keys отдаёт пароль и секрет по явному запросу');
    const keysNoId = await call('GET', '/__switch/api/google/keys');
    check(keysNoId.code === 400, 'keys без id - 400, а не «отдай всё»');
    const keysBadId = await call('GET', '/__switch/api/google/keys?id=нет-такого');
    check(keysBadId.code === 404, 'keys по чужому id - 404');

    // ── Ручка пула прокси: адрес выбирают из пула, а не вписывают строкой ─────
    const proxies = await call('GET', '/__switch/api/google/proxies');
    check(proxies.code === 200 && typeof proxies.json.host === 'string' && proxies.json.host.includes('google'),
        `ручка proxies отдаёт список для своего хоста (${proxies.json.host})`);
    check(Array.isArray(proxies.json.proxies) && typeof proxies.json.enabled === 'boolean',
        `список адресов и признак «хост обслуживается» (адресов ${proxies.json.total})`);
    check(proxies.json.proxies.every(p => p.id && p.label && !('raw' in p) && !('pass' in p)),
        'в списке адресов нет ни raw, ни пароля: креды прокси не покидают свой модуль');
    check(!/"raw"|:\/\/[^/"]+:[^/"]*@/.test(proxies.raw),
        'ни одна строка ответа не содержит кредов прокси');

    section('5. Ручки: правки и защита от подмены');
    const dup = await call('POST', '/__switch/api/google/add', { email: 'ACC.one@gmail.com', password: 'x' });
    check(dup.code === 409, 'повторный адрес не заводится вторым аккаунтом');
    const noPass = await call('POST', '/__switch/api/google/add', { email: 'acc.two@gmail.com' });
    check(noPass.code === 400, 'аккаунт без пароля отклоняется');

    const hijack = await call('POST', '/__switch/api/google/add', { email: 'acc.three@gmail.com', password: PASS, id: 'gg_хакер_0' });
    check(hijack.code === 200 && hijack.json.id !== 'gg_хакер_0', 'id из тела игнорируется: его ставит сервер');

    const badStatus = await call('POST', '/__switch/api/google/update', { id, patch: { status: 'пофиг' } });
    check(badStatus.code === 400, 'неизвестный статус отклоняется');
    const unknownField = await call('POST', '/__switch/api/google/update', { id, patch: { id: 'gg_чужой' } });
    check(unknownField.code === 400, 'правка закрытого поля отклоняется (белый список)');
    const okUpdate = await call('POST', '/__switch/api/google/update', { id, patch: { status: 'live', kind: 'burner', note: 'куплен 25.09' } });
    check(okUpdate.code === 200 && okUpdate.json.account.status === 'live', 'разрешённые поля правятся');
    // 🪤 Идентификаторы обязаны быть разными: три записи заведены в одну миллисекунду, и
    // `newId` различает их только по текущему пулу. Совпади они - у двух аккаунтов был бы
    // один профиль на диске, и удаление одного снесло бы сессию другого.
    const allIds = (await call('GET', '/__switch/api/google/list')).json.accounts.map(a => a.id);
    check(allIds.length >= 2 && new Set(allIds).size === allIds.length,
        `идентификаторы записей не повторяются (${allIds.length} записей, ${new Set(allIds).size} разных)`);

    section('6. Ручки: пачка, удаление, битый пул');
    // Считаем ДО предпросмотра, а не ожидаем число: аккаунты уже заводились в секции 5,
    // и вписанная константа проверяла бы арифметику теста, а не поведение ручки.
    const beforeDry = await call('GET', '/__switch/api/google/list');
    const dry = await call('POST', '/__switch/api/google/import', {
        text: `пачка.один@gmail.com:${PASS}\nпачка.два@gmail.com:${PASS}:${TOTP}\nЗаказ: №1\nдубль@gmail.com:${PASS}\nдубль@gmail.com:${PASS}`,
        dryRun: true,
    });
    check(dry.code === 200 && dry.json.parsed === 3, `предпросмотр разобрал 3 записи (получено ${dry.json.parsed})`);
    check(dry.json.duplicates.length === 1, 'предпросмотр показывает дубль');
    const afterDry = await call('GET', '/__switch/api/google/list');
    check(afterDry.json.total === beforeDry.json.total,
        `предпросмотр в пул НЕ пишет (было ${beforeDry.json.total}, стало ${afterDry.json.total})`);

    const commit = await call('POST', '/__switch/api/google/import', { text: `пачка.три@gmail.com:${PASS}:${TOTP}` });
    check(commit.code === 200 && commit.json.added.length === 1, 'запись пачки пишет в пул');
    const committed = await call('GET', `/__switch/api/google/keys?id=${commit.json.added[0]}`);
    check(committed.json.totpSecret === TOTP, 'секрет из пачки доехал до записи');

    // Удаление сносит ТРИ вещи. Кладём профиль и снимок руками - так их создаёт окно сессии.
    const target = commit.json.added[0];
    const profDir = path.join(pool.PROFILES_DIR, pool.profileLabel(target));
    const sessFile = path.join(pool.SESSIONS_DIR, `${target}.json`);
    fs.mkdirSync(profDir, { recursive: true });
    fs.writeFileSync(path.join(profDir, 'Cookies'), 'x', 'utf8');
    fs.mkdirSync(pool.SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(sessFile, '{}', 'utf8');
    const del = await call('POST', '/__switch/api/google/delete', { id: target });
    check(del.code === 200, 'delete проходит');
    check(!fs.existsSync(profDir), 'удаление сносит профиль браузера');
    check(!fs.existsSync(sessFile), 'удаление сносит снимок сессии');
    const afterDel = await call('GET', '/__switch/api/google/list');
    check(!afterDel.json.accounts.some(a => a.id === target), 'удаление сносит запись пула');

    const unknown = await call('GET', '/__switch/api/google/нет-такой-ручки');
    check(unknown.code === 404, 'неизвестный маршрут - 404, а не чужой ответ');

    // 🔴 Нулёвка не должна выглядеть пустым пулом: иначе вкладка покажет «пул пуст» и
    // разрешит запись поверх огрызка. Ручка обязана ответить ошибкой.
    const before = fs.readFileSync(pool.FILE, 'utf8');
    fs.writeFileSync(pool.FILE, Buffer.from([0, 0, 0, 0]));
    const zeroed = await call('GET', '/__switch/api/google/list');
    check(zeroed.code === 500 && /нулёвк|пул/i.test(String(zeroed.json && zeroed.json.error)),
        'нулёвочный пул отвечает ошибкой, а не пустым списком');
    fs.writeFileSync(pool.FILE, before, 'utf8');
    const restored = await call('GET', '/__switch/api/google/list');
    check(restored.code === 200, 'после восстановления файла список снова читается');

    // ── 7. Файлы вкладки ──────────────────────────────────────────────────────
    section('7. Файлы вкладки');
    check(/window\.GOOGLE = GOOGLE;/.test(tabJs), 'модуль объявляет неймспейс window.GOOGLE');
    check(tabJs.includes("const API = '/__switch/api/google/'"), 'модуль ходит в свой префикс');
    check(tabJs.includes('keys?id='), 'секреты запрашиваются отдельной ручкой, а не приходят со списком');
    check(!/class="[^"]*\b(bg|text|border)-(surface|muted|faint|ink|elevated|line|crimson|emerald|amber)\b/.test(tabJs),
        'в разметке вкладки нет Tailwind-утилит (их не соберут из внешнего файла)');
    check(!/#[0-9a-fA-F]{3,6}\b/.test(tabCss.replace(/\/\*[\s\S]*?\*\//g, '')),
        'в CSS вкладки нет своих hex-цветов (только токены тем)');
    // Форма обязана быть языком дашборда, а не своей выдумкой. Три признака, по которым
    // это видно машинно: шрифты берутся из его `@theme`, формы раскрываются панелью под
    // шапкой (у GitHub так, у модальных окон в дашборде нет ни одной вкладки-списка), а
    // сетка карточек повторяет брейкпоинты `#gh-grid`.
    check(/var\(--font-mono\)/.test(tabCss) && /var\(--font-sans\)/.test(tabCss),
        'шрифты взяты из темы дашборда (var(--font-sans) / var(--font-mono)), а не системные');
    check(/\.gg-panel/.test(tabCss) && !/gg-modal/.test(tabCss) && !/gg-modal/.test(tabJs),
        'формы вкладки - панель под шапкой, как у GitHub, а не модальное окно');
    check(/@media \(min-width: 640px\)/.test(tabCss) && /@media \(min-width: 1536px\)/.test(tabCss),
        'сетка карточек повторяет брейкпоинты #gh-grid (640 / 1024 / 1280 / 1536)');
    check(/crypto\.subtle/.test(tabJs) && /открой дашборд по localhost/.test(tabJs),
        'код 2FA считается в браузере, и его отсутствие объясняется словами, а не пустотой');
    const inGit = (p) => spawnSync('git', ['-C', REPO, 'check-ignore', '-q', p], { encoding: 'utf8' }).status === 0;
    check(!inGit('routing/vendor/google-tab.js') && !inGit('routing/vendor/google-tab.css'),
        'файлы вкладки едут в коммит (не закрыты .gitignore)');

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* временный каталог */ }
    say(fails.length ? `\nпровалено ${fails.length} из ${total}` : `\n${total}/${total} проверок пройдено`);
    process.exit(fails.length ? 1 : 0);
})().catch(e => {
    console.error(`\n✗ проба упала: ${e.stack || e.message}`);
    process.exit(1);
});
