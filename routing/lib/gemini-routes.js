'use strict';
/*
 * gemini-routes.js — весь HTTP вкладки Gemini (Antigravity) одним входом.
 *
 * Устройство — копия `routing/lib/google-routes.js`, и по той же причине: канон добавления
 * вкладки раскидывает ручки по лестнице из ~355 предикатов в `transparent-proxy.js`, где
 * `req.url` сравнивается целиком, поэтому любой `?query` мимо предиката проваливается в 404
 * молча. Здесь весь HTTP живёт в модуле, а в большом файле остаются строка подключения и
 * строка делегирования.
 *
 * 🪤 Что это за вкладка. За ней стоит НЕ наш код: вендоренная копия форка
 * `antigravity-claude-proxy` в `F:\hub-cc\gemini\` — отдельный ESM-процесс на своём порту,
 * который ходит в Google Cloud Code и отдаёт Anthropic-совместимый API. Модуль — пульт к нему:
 * поднимает, гасит, читает пул аккаунтов, квоту и тир. Почему отдельным процессом, а не кодом
 * внутри дашборда — в `gemini/VENDOR.md` и на странице проекта в вике.
 *
 * 🪤 Про «не спам». Вкладка опрашивает ТОЛЬКО этот модуль (раз в 15 секунд, как вкладка
 * Google), а модуль — локальный файл пула на диске сервера. К Google уходит ровно два рода
 * запросов: по явному нажатию ↻ на карточке и один фоновый — за самым старым по квоте
 * аккаунтом, не чаще раза в 60 секунд и не чаще кэша сервера. Иначе каждая открытая вкладка
 * молотила бы Google-API круглосуточно, и это ровно то, за что аккаунты ловят бан.
 *
 * 🪤 Секретов наружу нет вообще. В пуле вкладки лежит `refreshToken` — единственный секрет
 * аккаунта; наружу уезжает только `hasToken`. Список опрашивается опросом, и секретам там
 * делать нечего (та же логика, что у ручки `keys` во вкладке Google).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROUTING = path.join(__dirname, '..');
const REPO = path.join(ROUTING, '..');
const GEMINI_DIR = process.env.GEMINI_DIR ? path.resolve(process.env.GEMINI_DIR) : path.join(REPO, 'gemini');
const SERVER_SCRIPT = path.join(GEMINI_DIR, 'src', 'index.js');
const OPEN_SCRIPT = path.join(GEMINI_DIR, 'open-session.js');
// 02.10: порт сдвинут с вендорных 20176/20177 на 20178/20179 - 20176 занят Artbloom keepalive,
// 20177 - dacall.AI keepalive (живой процесс). Пара движок/шлюз целиком видна здесь и в
// lifecycle.children(); вендорные числа правились вместе: config.json сервера и START.bat.
const PORT = Number(process.env.GEMINI_PORT || 20178);
const BASE = `http://127.0.0.1:${PORT}`;
const LOG_FILE = path.join(REPO, 'logs', 'hub', 'gemini-server.log');
const PID_FILE = path.join(GEMINI_DIR, 'server.pid');
const PREFIX = '/__switch/api/gemini/';

// Переиспользуем чужие готовые части, а не заводим свои копии:
//   · `google-pool` — пул Google-аккаунтов (из него берётся аккаунт для входа и в него
//     пишется метка расхода);
//   · `google-routes` — только ради карты открытых окон (`readPids`/`pidAlive`): профиль
//     браузера один на аккаунт, и второе окно на тот же профиль Chromium просто не пустит;
//   · `proxy-pool` — липкая привязка «аккаунт → выходной IP» (та же, что у вкладки Google).
const googlePool = require('./google-pool');
const googleRoutes = require('./google-routes');
const proxyPool = require('./proxy-pool');

// Хост, под которым аккаунт ходит в Google: по нему пул прокси решает, годен ли адрес.
const GOOGLE_HOST = 'accounts.google.com';
// Метка расхода в записи Google-пула. Поле `usedOn` заведено под ветки подписки, и вкладка
// Google уже рисует по нему плашки — писать его до сих пор было некому.
const USE_TAG = 'antigravity';

// Клиент Antigravity ставит эту версию сам себе, и от неё зависят заголовки, с которыми
// сервер ходит в Google. Без неё версия вычисляется из установленного пакета и может уехать.
const CLIENT_VERSION = '1.110.0';

// 🚫 Фонового опроса Google нет - снято 02.10.2026. У апстрима здесь стоял авто-refresh
// квоты (`maybeRefreshStale`: один запрос на самый старый аккаунт, не чаще раза в минуту,
// только если данные старше 15 минут) - то есть обращения к Google всё равно шли сами,
// без человека. Причина снятия прямая: Google выдаёт баны за необслуживаемые обращения к
// аккаунту, и свежая полоса квоты этого не стоит.
// Квота спрашивается ТОЛЬКО кнопкой «↻ обновить» в вкладке - ручка `refresh`, один явный
// запрос на один аккаунт по действию человека. Кнопка и осталась; убран только автомат.

// ── Подключение к хабу ───────────────────────────────────────────────────────
// Лог, ранний пробник окна и `hooks` живут в `transparent-proxy.js` и передаются ИНЪЕКЦИЕЙ,
// а не копируются: копия рано или поздно разъедется с боевой. Без инъекции модуль работает
// молча — это нужно регрессу.
//
// 🪤 Зачем `hooks`, если можно было объявить эти ручки прямо в лестнице предикатов: переключение
// бэкенда обязано идти через `writeSettings()` — единственный чокпоинт, откуда состояние
// разъезжается по `settings.json`, фронт-двери и реестру `backends.json`. Эта машинерия живёт
// в большом файле, а HTTP вкладки — здесь; `hooks` и есть шов между ними. Так у вкладки
// остаётся ОДИН вход (никаких `req.url === …` в лестнице), а состояние не размножается.
let hub = { log: () => {}, earlyFailure: null, hooks: {} };
function setHub(h) {
    hub = {
        log: (h && h.log) || (() => {}),
        earlyFailure: (h && h.earlyFailure) || null,
        hooks: (h && h.hooks) || {},
    };
}

// ── Ответы ───────────────────────────────────────────────────────────────────

function json(res, code, body) {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
}

function readBody(req, limitBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > limitBytes) { reject(new Error('тело запроса больше лимита')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error(`тело не JSON: ${e.message}`)); }
        });
        req.on('error', reject);
    });
}

// Своя маска, а не общая из большого файла: у той другой потребитель, а здесь важно ровно
// одно — адрес аккаунта не должен уехать в лог, который попадает в скриншоты.
const EMAIL_RE = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;
const maskEmail = e => String(e || '').replace(EMAIL_RE, m => {
    const [user, domain] = m.split('@');
    return `${user.slice(0, 3)}***@${domain}`;
});
const maskInText = s => String(s || '').replace(EMAIL_RE, m => maskEmail(m));

// ── Разговор с сервером вкладки ──────────────────────────────────────────────

/** Запрос к локальному серверу. Возвращает `{ok, status, data, error}` и НИКОГДА не бросает. */
async function call(pathname, { method = 'GET', body = null, timeoutMs = 5000 } = {}) {
    try {
        const opts = { method, signal: AbortSignal.timeout(timeoutMs), headers: {} };
        if (body !== null) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const r = await fetch(BASE + pathname, opts);
        const text = await r.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
        return { ok: r.ok, status: r.status, data };
    } catch (e) {
        return { ok: false, status: 0, error: e.name === 'TimeoutError' ? 'таймаут' : e.message };
    }
}

/** Состояние сервера: поднят ли, сколько аккаунтов видит. Быстрый путь, без похода в Google. */
async function serverStatus(timeoutMs = 1500) {
    const r = await call('/status', { timeoutMs });
    if (!r.ok || !r.data || r.data.ok !== true) return { up: false, error: r.error || `код ${r.status}` };
    return { up: true, ...r.data, port: PORT };
}

// ── Пид и лог поднятого сервера ──────────────────────────────────────────────

function readPid() {
    try {
        const j = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
        return j && j.pid ? j : null;
    } catch { return null; }
}

function writePid(pid) {
    try {
        fs.writeFileSync(PID_FILE, JSON.stringify({ pid, port: PORT, startedAt: new Date().toISOString() }, null, 2), 'utf8');
    } catch (e) { hub.log(`gemini: pid не записался (${e.message})`); }
}

const pidAlive = pid => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
};

function portIsFree() {
    return new Promise(resolve => {
        const sock = http.createServer();
        sock.once('error', () => resolve(false));
        sock.listen(PORT, '127.0.0.1', () => sock.close(() => resolve(true)));
    });
}

/**
 * Поднять сервер вкладки. Наружу выходит detached-процесс, который переживает и дашборд, и
 * его перезапуск (как keepalive шлюзов).
 *
 * 🪤 Вывод пишется В ФАЙЛ, а не в `ignore`: сервер, упавший на старте (занят порт, нет
 * зависимости), иначе не оставил бы после себя ничего, и «кнопка не работает» не имело бы
 * разбора. Файл открывается дескриптором, поэтому переживает смерть родителя — труба бы нет.
 */
async function spawnServer(opts = {}) {
    const alive = await serverStatus();
    if (alive.up) {
        if (!opts.force) return { ok: true, already: true };
        await stopServer();
    }
    if (!fs.existsSync(SERVER_SCRIPT)) {
        return { ok: false, error: `нет ${SERVER_SCRIPT} — папка gemini потерялась` };
    }
    if (!(await portIsFree())) return { ok: false, error: `порт ${PORT} занят чужим процессом` };

    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        const fd = fs.openSync(LOG_FILE, 'a');
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [SERVER_SCRIPT], {
            detached: true,
            stdio: ['ignore', fd, fd],
            cwd: GEMINI_DIR,
            env: {
                ...process.env,
                PORT: String(PORT),
                HOST: '127.0.0.1',
                ANTIGRAVITY_CLIENT_VERSION: CLIENT_VERSION,
                // Свой каталог данных: пул аккаунтов и настройки лежат в папке вкладки,
                // а не в ~/.config/antigravity-proxy (там остался прежний форк).
                ANTIGRAVITY_CONFIG_DIR: GEMINI_DIR,
            },
        });
        fs.closeSync(fd);
        child.on('exit', (code, sig) => hub.log(`gemini server: процесс вышел (code ${code === null ? '—' : code}, sig ${sig || '—'})`));
        child.unref();
        writePid(child.pid);
        hub.log(`gemini server spawn: :${PORT} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        hub.log(`gemini server spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

/** Мягко погасить: просьба уйти, ожидание, и только потом сила. */
async function stopServer() {
    const st = await serverStatus(1200);
    if (!st.up) {
        // Сервер молчит, но порт занят — значит это зомби, его снимаем по-настоящему.
        if (!(await portIsFree())) {
            const pid = readPid();
            if (pidAlive(pid && pid.pid)) {
                try { process.kill(pid.pid); hub.log(`gemini server: снял зомби pid ${pid.pid}`); } catch { /* уже нет */ }
            }
        }
        return { ok: true, already: true };
    }
    await call('/__drain', { method: 'POST', timeoutMs: 3000 });
    for (let i = 0; i < 20; i += 1) {
        await new Promise(r => setTimeout(r, 250));
        if (!(await serverStatus(800)).up) return { ok: true, stopped: true };
    }
    const pid = readPid();
    if (pidAlive(pid && pid.pid)) {
        try { process.kill(pid.pid); } catch { /* уже нет */ }
    }
    return { ok: true, forced: true };
}

// ── Фоновое обновление квоты ─────────────────────────────────────────────────
// Снято 02.10.2026 вместе с константами выше: функция `maybeRefreshStale` и её вызов из
// `list` убраны целиком, чтобы автомат нельзя было вернуть случайно. Квота - только кнопкой.

/**
 * Оставляет от записи аккаунта только то, что можно показывать.
 *
 * 🪤 `refreshToken` вырезается ЗДЕСЬ, а не только на стороне сервера вкладки: сервер свой
 * (вендоренный форк) и его форма ответа от нас не зависит. Список опрашивается раз в 15 секунд,
 * и один секрет, уехавший в браузер, — это уехавший насовсем секрет. `hasToken` остаётся: по нему
 * видно, что аккаунт вообще авторизован.
 */
function safeAccount(a) {
    if (!a || typeof a !== 'object') return a;
    const { refreshToken, ...rest } = a;
    return { ...rest, hasToken: !!refreshToken || rest.hasToken === true };
}

// ── Прокси аккаунта и метка расхода ──────────────────────────────────────────

/**
 * Выходной адрес для окна авторизации ЭТОГО Google-аккаунта.
 *
 * 🪤 Форма ответа — та же, что у `browserProxy()` в `routing/lib/proxy-for.js`, и это
 * намеренно: тот файл — CLI-скрипт (он читает argv и работает при одном лишь `require`),
 * поэтому импортировать его нельзя, и четыре строки сборки повторены здесь. Если форма
 * поменяется, менять в обоих местах.
 *
 * 🪤 «Прокси нет» — это НЕ молчание: возвращаем причину, и её показывают в тосте. Аккаунт
 * без прокси уходит в Google с домашнего IP, а смена IP у живого аккаунта выглядит как угон
 * сессии — предупреждение об этом стоит прямо в README форка.
 */
async function browserProxyForAccount(accountId) {
    try {
        if (!proxyPool.enabledForHost(GOOGLE_HOST)) return { proxy: null, reason: `пул прокси выключен для ${GOOGLE_HOST}` };
        const key = proxyPool.stickyKey({ accountId });
        const r = await proxyPool.forAccount(key, { host: GOOGLE_HOST });
        if (!r || !r.ok || !r.proxy) return { proxy: null, reason: (r && (r.error || r.reason)) || 'свободного прокси нет' };
        const p = r.proxy;
        const cfg = { server: `${p.scheme}://${p.hostname}:${p.port}` };
        if (p.user) cfg.username = p.user;
        if (p.pass) cfg.password = p.pass;
        return { proxy: cfg, label: p.label || cfg.server, tier: r.tier || null, how: r.how || null };
    } catch (e) {
        return { proxy: null, reason: `пул прокси: ${e.message}` };
    }
}

/** Ставит метку «аккаунт занят веткой Antigravity» в записи Google-пула. Идемпотентно. */
function markUsedInGooglePool(email, googleId) {
    try {
        const arr = googlePool.load();
        const rec = (googleId && googlePool.findById(arr, googleId))
            || arr.find(a => String(a.email || '').toLowerCase() === String(email || '').toLowerCase());
        if (!rec) return null;
        const used = Array.isArray(rec.usedOn) ? rec.usedOn : [];
        if (used.some(m => m && (typeof m === 'string' ? m : m.tag) === USE_TAG)) return rec.id;
        used.push({ tag: USE_TAG, at: new Date().toISOString() });
        rec.usedOn = used;
        googlePool.save(arr);
        hub.log(`gemini: в Google-пуле помечен расход — ${maskEmail(email)}`);
        return rec.id;
    } catch (e) {
        // Метка — украшение карточки, а не работа: её отказ не повод ронять ответ.
        hub.log(`gemini: метку расхода поставить не вышло (${e.message})`);
        return null;
    }
}

// ── Ручки ────────────────────────────────────────────────────────────────────

async function dispatch(req, res, route) {
    const parts = route.split('/').filter(Boolean);
    const head = parts[0] || '';

    // GET list — то, что вкладка опрашивает раз в 15 секунд.
    if (req.method === 'GET' && head === 'list') {
        const st = await serverStatus();
        if (!st.up) return json(res, 200, { ok: true, server: st, accounts: [], total: 0 });
        const r = await call('/api/accounts', { timeoutMs: 8000 });
        if (!r.ok) return json(res, 200, { ok: true, server: st, accounts: [], total: 0, error: r.error || `код ${r.status}` });
        const accounts = ((r.data && r.data.accounts) || []).map(safeAccount);
        // Авто-refresh квоты (`maybeRefreshStale`) здесь стоял - снят 02.10.2026: опрос вкладки
        // не должен порождать обращения к Google. Квота - только кнопкой «↻ обновить».
        // Досыпаем метку расхода тем аккаунтам, которые уже лежат в пуле вкладки: так вкладка
        // Google узнаёт, что ящик занят подпиской, даже если вход прошёл колбэком (о нём хаб
        // не спрашивали) или аккаунты достались по наследству от прежнего форка. Функция
        // идемпотентна и пишет на диск только когда метки не было.
        for (const a of accounts) if (a && a.email) markUsedInGooglePool(a.email, null);
        return json(res, 200, {
            ok: true,
            server: st,
            accounts,
            total: accounts.length,
            live: accounts.filter(a => a.enabled !== false && !a.isInvalid).length,
            tiers: [...new Set(accounts.map(a => a.tier).filter(Boolean))],
        });
    }

    // GET models — каталог, который отдаёт сам Antigravity для выбранного аккаунта.
    if (req.method === 'GET' && head === 'models') {
        const r = await call('/v1/models', { timeoutMs: 30000 });
        if (!r.ok) return json(res, 502, { error: r.error || `сервер вкладки ответил ${r.status}` });
        const ids = ((r.data && r.data.data) || []).map(m => m.id);
        return json(res, 200, { ok: true, models: ids, total: ids.length });
    }

    // POST server {action} — поднять, погасить, перезапустить.
    if (req.method === 'POST' && head === 'server') {
        const body = await readBody(req);
        const action = String(body.action || '');
        if (!['start', 'stop', 'restart'].includes(action)) return json(res, 400, { error: 'action: start | stop | restart' });
        if (action === 'start') { const r = await spawnServer(); return json(res, r.ok ? 200 : 502, r); }
        if (action === 'stop') { const r = await stopServer(); return json(res, 200, r); }
        await stopServer();
        const r = await spawnServer({ force: true });
        return json(res, r.ok ? 200 : 502, r);
    }

    // POST refresh {email} — перезапросить квоту одного аккаунта.
    if (req.method === 'POST' && head === 'refresh') {
        const body = await readBody(req);
        if (!body.email) return json(res, 400, { error: 'нужен email' });
        const r = await call(`/api/accounts/${encodeURIComponent(body.email)}/refresh`, { method: 'POST', timeoutMs: 60000 });
        if (!r.ok) return json(res, 502, { error: r.error || `сервер вкладки ответил ${r.status}` });
        return json(res, 200, r.data || { ok: true });
    }

    // POST account {email, enabled} — включить/выключить аккаунт в пуле.
    if (req.method === 'POST' && head === 'account' && parts[1] === 'toggle') {
        const body = await readBody(req);
        if (!body.email || typeof body.enabled !== 'boolean') return json(res, 400, { error: 'нужны email и enabled' });
        const r = await call(`/api/accounts/${encodeURIComponent(body.email)}/toggle`, { method: 'POST', body: { enabled: body.enabled }, timeoutMs: 8000 });
        if (!r.ok) return json(res, 502, { error: r.error || `сервер вкладки ответил ${r.status}` });
        hub.log(`gemini: аккаунт ${maskEmail(body.email)} ${body.enabled ? 'включён' : 'выключен'}`);
        return json(res, 200, { ok: true });
    }

    // ── Авторизация Google-аккаунта прямо из вкладки ─────────────────────────

    /**
     * POST auth/start {googleId} — открыть окно входа выбранному Google-аккаунту.
     *
     * Порядок именно такой и он важен: сначала спрашиваем у сервера вкладки ссылку согласия
     * (он же поднимает слушателя колбэка на 51121), потом поднимаем окно. Наоборот значило бы
     * открыть окно в никуда.
     *
     * 🪤 Один профиль — одно окно. Профиль браузера на аккаунт персистентный, и второй
     * Chromium на тот же каталог падает отказом блокировки, который снаружи выглядит как
     * «кнопка не работает». Поэтому смотрим карту окон вкладки Google и честно отвечаем 409.
     */
    if (req.method === 'POST' && head === 'auth' && parts[1] === 'start') {
        const body = await readBody(req);
        const googleId = String(body.googleId || '').trim();
        if (!googleId) return json(res, 400, { error: 'нужен googleId — какой аккаунт авторизуем' });

        let rec = null;
        try { rec = googlePool.findById(googlePool.load(), googleId); }
        catch (e) { return json(res, 500, { error: `пул Google не читается: ${e.message}` }); }
        if (!rec) return json(res, 404, { error: 'аккаунт не найден в пуле Google — заведи его на вкладке Google' });

        const pid = googleRoutes.readPids()[googleId];
        if (pid && googleRoutes.pidAlive(pid))
            return json(res, 409, { error: `окно этого аккаунта уже открыто (pid ${pid}) — закрой его и повтори` });

        if (!fs.existsSync(OPEN_SCRIPT)) return json(res, 500, { error: `нет ${OPEN_SCRIPT} — папка gemini потерялась` });

        const st = await serverStatus(3000);
        if (!st.up) return json(res, 502, { error: 'сервер вкладки лежит — подними его кнопкой и повтори' });

        // Ссылку согласия выписывает сервер вкладки: приватный ключ PKCE остаётся у него,
        // в браузер уезжает только URL.
        const auth = await call('/api/auth/url', { timeoutMs: 10000 });
        if (!auth.ok || !auth.data || !auth.data.url)
            return json(res, 502, { error: `сервер вкладки не выдал ссылку согласия: ${auth.error || `HTTP ${auth.status}`}` });

        const { proxy, label: proxyLabel, reason: proxyReason } = await browserProxyForAccount(googleId);

        const child = spawn(process.execPath, [OPEN_SCRIPT], {
            detached: true,
            stdio: 'ignore',
            env: {
                ...process.env,
                GEMINI_AUTH_URL: auth.data.url,
                GOOGLE_LABEL: googlePool.profileLabel(googleId),
                GOOGLE_EMAIL: String(rec.email || ''),
                GOOGLE_PASS: String(rec.password || ''),
                GOOGLE_TOTP: String(rec.totpSecret || ''),
                ...(proxy ? { GEMINI_PROXY: JSON.stringify(proxy) } : {}),
            },
        });
        child.unref();
        hub.log(`gemini auth: окно для ${maskEmail(rec.email)} ${proxy ? `через ${proxyLabel}` : `БЕЗ ПРОКСИ (${proxyReason})`}`);
        return json(res, 200, {
            ok: true,
            state: auth.data.state,
            email: rec.email,
            proxy: proxy ? { label: proxyLabel } : null,
            proxyReason: proxy ? null : proxyReason,
            pid: child.pid,
        });
    }

    /** POST auth/complete {state, input} — донести код или ссылку колбэка руками. */
    if (req.method === 'POST' && head === 'auth' && parts[1] === 'complete') {
        const body = await readBody(req);
        if (!body.state || !body.input) return json(res, 400, { error: 'нужны state и input' });
        const r = await call('/api/auth/complete', { method: 'POST', body: { state: body.state, callbackInput: body.input }, timeoutMs: 60000 });
        if (!r.ok) return json(res, 502, { error: (r.data && r.data.error) || r.error || `сервер вкладки ответил ${r.status}` });
        const email = (r.data && r.data.email) || null;
        if (email) markUsedInGooglePool(email, null);
        return json(res, 200, { ok: true, email });
    }

    // POST delete {email} — снять аккаунт с пула вкладки.
    if (req.method === 'POST' && head === 'delete') {
        const body = await readBody(req);
        if (!body.email) return json(res, 400, { error: 'нужен email' });
        const r = await call(`/api/accounts/${encodeURIComponent(body.email)}`, { method: 'DELETE', timeoutMs: 8000 });
        if (!r.ok) return json(res, 502, { error: r.error || `сервер вкладки ответил ${r.status}` });
        hub.log(`gemini: аккаунт ${maskEmail(body.email)} снят`);
        return json(res, 200, { ok: true });
    }

    // POST activate {model?} — сделать Gemini активным бэкендом Claude Code.
    // Делает это хаб (`hooks.activate`): переключение идёт через writeSettings(), где живут
    // settings.json, фронт-дверь и реестр бэкендов. Если хук не подключён (регресс), честно
    // говорим об этом, а не делаем вид, что переключили.
    if (req.method === 'POST' && head === 'activate') {
        if (!hub.hooks.activate) return json(res, 501, { error: 'переключение бэкенда недоступно: модуль поднят без хаба' });
        return hub.hooks.activate(req, res);
    }

    // POST set-model {model} | POST modelmap {opus,sonnet,haiku} | GET modelmap
    if (req.method === 'POST' && head === 'set-model') {
        if (!hub.hooks.setModel) return json(res, 501, { error: 'выбор модели недоступен: модуль поднят без хаба' });
        return hub.hooks.setModel(req, res);
    }
    if (head === 'modelmap') {
        if (req.method === 'GET') {
            return json(res, 200, {
                ok: true,
                modelMap: hub.hooks.readModelMap ? hub.hooks.readModelMap() : {},
                activeModel: hub.hooks.activeModel ? hub.hooks.activeModel() : null,
            });
        }
        if (req.method === 'POST') {
            if (!hub.hooks.modelMap) return json(res, 501, { error: 'тир-карта недоступна: модуль поднят без хаба' });
            return hub.hooks.modelMap(req, res);
        }
    }

    return json(res, 404, { error: `неизвестный маршрут Gemini: ${route}` });
}

function handle(req, res) {
    let url; try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
    if (!url.pathname.startsWith(PREFIX)) return false;
    const route = url.pathname.slice(PREFIX.length);
    Promise.resolve().then(() => dispatch(req, res, route))
        .catch(e => { if (!res.headersSent) json(res, 500, { error: e.message }); });
    return true;
}

module.exports = {
    handle, setHub, PREFIX, PORT, BASE, GEMINI_DIR, SERVER_SCRIPT,
    spawnServer, stopServer, serverStatus, maskEmail, maskInText,
};
