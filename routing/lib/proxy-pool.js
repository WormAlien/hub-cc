// routing/lib/proxy-pool.js
//
// Общий пул прокси для исходящих запросов к шлюзам: разбор строк, туннели
// (http/https/socks4/socks5), preflight и — главное — ЛИПКАЯ привязка «аккаунт → прокси».
//
// Зачем модуль появился. Замер 2026-09-10: седьмой подряд автоподарок получил от
// `GET /api/status` ПУСТОЕ ТЕЛО. Ручка публичная, авторизация там ни при чём — режет
// край (WAF/рейт-лимит по IP): все 20+ аккаунтов ходят к agentrouter.org с одного
// домашнего адреса. Паузами это не лечится (их и так 2.5 с на хост, см. HOST_GAP_OVERRIDE
// в newapi-account.js) — лечится разными исходящими IP.
//
// Код туннелей взят из `wisdomsatan/auto-add.js`, где он отработан на живых регистрациях.
// Здесь он ВЫНЕСЕН, а не скопирован: у авторега прокси одноразовый, а у нас за аккаунтом
// закреплена живая сессия — и это меняет главное правило пула.
//
// 🪤 ЛИПКОСТЬ ОБЯЗАТЕЛЬНА, round-robin здесь ВРЕДЕН. В авторегах IP одноразовый: взял
// прокси, завёл аккаунт, забыл. У нас у аккаунта есть сессионная кука, история запросов
// и баланс. Аккаунт, который сегодня пришёл из Германии, а через минуту из Бразилии, для
// антифрода панели заметнее, чем двадцать аккаунтов с одного домашнего IP. Поэтому
// привязка пишется в `routing/proxy-assign.json` и сама НЕ переназначается.
//
// 🔴 Прокси назначен и не работает — НЕ ходить напрямую. Правило принято в репозитории
// раньше (шапка `wisdomsatan/auto-add.js`, § ПРОКСИ) и стоило разбора: в
// `freemodel/freemodel_autoreger_v3.js:119` `parseProxy()` понимает только `http(s)://`
// и на строке `socks5://…` молча возвращает null — после чего авторег уходил с домашнего
// IP, и никто об этом не узнавал. Здесь такого пути нет: все отказы громкие.
//
// 🪤 «Прокси не настроен» и «прокси сломан» — РАЗНЫЕ ответы, путать их нельзя:
//     { ok:true,  proxy:null } — пул не настроен → идти напрямую, ровно как раньше;
//     { ok:true,  proxy:{…}  } — идти через него;
//     { ok:false, error:'…'  } — назначен и мёртв → НЕ ИДТИ ВООБЩЕ, ни через что.
//
// Настройка — `routing/proxy-pool.json` (креды внутри, файлу место в .gitignore):
//
//   {
//     "enabled": true,
//     "file": "D:/proxies/export/protocols/socks5.txt",
//     "scheme": "socks5",
//     "list": ["http://user:pass@1.2.3.4:8080"],
//     "hosts": ["agentrouter.org"],
//     "preflightTtlMs": 600000
//   }
//
// Формат `file` — как у скрапера: протокол несёт ИМЯ ФАЙЛА (`export/protocols/socks5.txt`),
// а строки голые `ip:port`. Схема берётся по убыванию приоритета из `scheme`, из имени
// файла, иначе http — это эквивалент флага `--proxy-scheme` у авторегов.
//
// `hosts` — белый список хостов, на которых пул работает. Пусто = на всех. Полезно,
// чтобы включать прокси точечно (инцидент был на agentrouter.org) и не менять поведение
// остальных шлюзов одним переключателем.
//
// Быстрое включение без файла и изоляция регресса — через env:
//   PROXY_POOL          строки прокси через запятую (перебивает file/list из конфига)
//   PROXY_POOL_FILE     путь к файлу со списком
//   PROXY_POOL_SCHEME   схема для голых `ip:port`
//   PROXY_POOL_HOSTS    белый список хостов через запятую
//   PROXY_POOL_ENABLED  0/1 — жёстко выключить или включить
//   PROXY_POOL_ASSIGN   путь к файлу привязок (регресс не должен трогать боевой)
//   PROXY_POOL_PREFLIGHT_TTL  сколько мс верить проверке здоровья; 0 = не проверять

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');

const DIR = path.join(__dirname, '..');                    // routing/
const CONFIG_FILE = path.join(DIR, 'proxy-pool.json');
const DEFAULT_ASSIGN_FILE = path.join(DIR, 'proxy-assign.json');
const DEFAULT_OWN_FILE = path.join(DIR, 'own-proxies.txt');

const TUNNEL_TIMEOUT_MS = 20000;
const REQUEST_TIMEOUT_MS = 15000;
const PREFLIGHT_TIMEOUT_MS = 12000;
const PREFLIGHT_TTL_MS = 10 * 60_000;
const CONFIG_MEMO_MS = 5000;      // конфиг читается на каждый чек баланса — не жжём диск

const SCHEMES = ['http', 'https', 'socks', 'socks4', 'socks5'];

function readJson(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    } catch { return {}; }
}

function splitCsv(v) {
    return String(v == null ? '' : v).split(',').map(s => s.trim()).filter(Boolean);
}

const nowIso = () => new Date().toISOString();

// ───────────────────────────── разбор ─────────────────────────────

// Разбор строки прокси. Понимает ТРИ формы, потому что владелец получает прокси от
// продавцов и они приходят вразнобой - и заставлять его переписывать руками значит
// терять пароли по дороге:
//
//   1. URL           socks5://user:pass@1.2.3.4:1080     http://1.2.3.4:8080
//   2. магазинная    1.2.3.4:1080:user:pass              1.2.3.4:1080
//   3. голый         1.2.3.4:1080                        (формат выгрузки скрапера)
//
// 🪤 Форма 2 - та, в которой прокси отдают продавцы (`ip:port:login:password`). Она
// устроена ОПАСНО для наивного разбора: строка `1.2.3.4:1080:user:pass`, отданная
// URL-парсеру, молча теряет логин с паролем - `new URL` увидит в них часть адреса, а
// прокси останется «рабочим», только анонимным. Такой прокси упрётся в чужой лимит
// или в отказ авторизации, и причина будет неочевидна. Поэтому форма 2 распознаётся
// ЯВНО и раньше, чем строка попадёт в URL.
//
// 🪤 Порт :80 у http и :443 у https нельзя проверять через `u.port` - `new URL` срезает
// дефолтный для схемы порт, и «порта нет» теряло бы каждую пятую строку бесплатных
// списков. Порт берём из самой строки.
//
// 🪤 Возврат null здесь — НЕ «работай напрямую». Это входные данные, которые мы не поняли;
// решение о походе принимает forAccount(), и он на пустом пуле отвечает ошибкой.
function parseProxy(raw, defScheme = 'http') {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || s.startsWith('#')) return null;
    const scheme0 = SCHEMES.includes(String(defScheme || '').toLowerCase())
        ? String(defScheme).toLowerCase()
        : 'http';

    // ── форма 2: ip:port или ip:port:login:password ──
    // 🪤 Условие `!includes('://')` обязательно, а одной проверки «ровно 2 или 4 куска»
    // МАЛО: `socks5://1.2.3.4:1080` тоже делится на два куска, и первый (`socks5://1.2.3.4`)
    // похож на адрес по алфавиту. Без этой отсечки схема прокси терялась бы, а строка
    // молча превращалась в «http на хосте socks5». Проверку «похоже на адрес» оставляем
    // как вторую линию: она ловит мусор вроде `Привет:мир`.
    if (!/^[a-z0-9]+:\/\//i.test(s)) {
        const c = s.split(':').map(x => x.trim());
        const looksHost = /^[a-z0-9._-]+$/i.test(c[0] || '') && !c[0].includes('/');
        if (looksHost && (c.length === 2 || c.length === 4)) {
            const port = Number(c[1]);
            if (Number.isInteger(port) && port >= 1 && port <= 65535) {
                const label = `${scheme0}://${c[0]}:${port}`;
                return {
                    id: label, label, raw: s,
                    scheme: scheme0,
                    hostname: c[0],
                    port,
                    // Кредов в label/id нет намеренно: сменив пароль, привязку терять
                    // незачем, а наружу label уходит в UI и логи.
                    user: c.length === 4 ? c[2] : '',
                    pass: c.length === 4 ? c[3] : '',
                };
            }
        }
    }

    const withScheme = /^[a-z0-9]+:\/\//i.test(s) ? s : `${scheme0}://${s}`;
    let u;
    try { u = new URL(withScheme); } catch { return null; }
    const scheme = u.protocol.replace(':', '').toLowerCase();
    if (!SCHEMES.includes(scheme)) return null;
    if (!u.hostname) return null;
    const authority = withScheme.slice(withScheme.indexOf('://') + 3).split(/[/?#]/)[0];
    const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
    const explicit = /:(\d{1,5})$/.exec(hostPart);
    const port = Number(explicit ? explicit[1] : u.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const label = `${scheme}://${u.hostname}:${port}`;
    return {
        // id стабильно по СОДЕРЖАНИЮ, а не по позиции в файле: список скрапера
        // пересортируется при каждом обновлении, и индексный id порвал бы все привязки.
        id: label,
        label,
        raw: s,
        scheme,
        hostname: u.hostname,
        port,
        user: u.username ? decodeURIComponent(u.username) : '',
        pass: u.password ? decodeURIComponent(u.password) : '',
    };
}

// Схема из имени файла: `export/protocols/socks5.txt` → socks5. Так раскладывает списки
// скрапер, и это единственное место, где протокол вообще указан.
function schemeFromFilename(file) {
    if (!file) return null;
    const base = path.basename(String(file)).toLowerCase().replace(/\.[a-z0-9]+$/, '');
    return SCHEMES.includes(base) ? base : null;
}

// Строки → { proxies, bad }. Дедуп по label: в списках скрапера повторы обычное дело,
// а дубль в пуле перекосил бы раскладку привязок (least-loaded считает записи).
function parseList(lines, defScheme = 'http') {
    const arr = Array.isArray(lines) ? lines : String(lines == null ? '' : lines).split(/\r?\n/);
    const proxies = [];
    const bad = [];
    const seen = new Set();
    for (const line of arr) {
        const s = String(line == null ? '' : line).trim();
        if (!s || s.startsWith('#')) continue;
        const p = parseProxy(s, defScheme);
        if (!p) { bad.push(s); continue; }
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        proxies.push(p);
    }
    return { proxies, bad };
}

// Файл со списком. Схема: явная > из имени файла > http.
function loadFile(file, defScheme = null) {
    const scheme = (SCHEMES.includes(String(defScheme || '').toLowerCase()) ? String(defScheme).toLowerCase() : null)
        || schemeFromFilename(file)
        || 'http';
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { return { proxies: [], bad: [], scheme, error: `не читается ${file}: ${e.message}` }; }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return { ...parseList(text, scheme), scheme, error: null };
}

// ───────────────────────────── конфиг ─────────────────────────────

let CFG_MEMO = null;   // { at, key, cfg }

function envKey() {
    const e = process.env;
    return [e.PROXY_POOL, e.PROXY_POOL_FILE, e.PROXY_POOL_SCHEME,
        e.PROXY_POOL_HOSTS, e.PROXY_POOL_ENABLED, e.PROXY_POOL_ASSIGN,
        e.PROXY_POOL_OWN, e.PROXY_POOL_OWN_FILE, e.PROXY_POOL_OWN_FIRST, e.PROXY_POOL_MAX_PER_HOST,
        e.PROXY_POOL_PREFLIGHT_TTL].join('\u0000');
}

function config() {
    const key = envKey();
    if (CFG_MEMO && CFG_MEMO.key === key && (Date.now() - CFG_MEMO.at) < CONFIG_MEMO_MS) return CFG_MEMO.cfg;

    const e = process.env;
    const doc = fs.existsSync(CONFIG_FILE) ? readJson(CONFIG_FILE) : {};

    // env перебивает файл ЦЕЛИКОМ по источнику списка. Иначе регресс, поднявший свой
    // пул через env, случайно подмешал бы боевые прокси владельца из конфига.
    const envList = e.PROXY_POOL ? splitCsv(e.PROXY_POOL) : null;
    const envFile = e.PROXY_POOL_FILE || null;
    const hasEnvSource = !!(envList && envList.length) || !!envFile;

    const list = hasEnvSource ? (envList || []) : (Array.isArray(doc.list) ? doc.list.map(String) : []);
    const file = hasEnvSource ? envFile : (doc.file ? String(doc.file) : null);
    const scheme = String(e.PROXY_POOL_SCHEME || doc.scheme || '').toLowerCase() || null;
    const hosts = e.PROXY_POOL_HOSTS ? splitCsv(e.PROXY_POOL_HOSTS)
        : (Array.isArray(doc.hosts) ? doc.hosts.map(String).filter(Boolean) : []);

    // Источники ярусов независимы: env своего яруса целиком заменяет его file/list,
    // но не выключает скрапер. Явная пустая строка позволяет изолировать регресс.
    const hasEnvOwn = e.PROXY_POOL_OWN != null || e.PROXY_POOL_OWN_FILE != null;
    const ownList = hasEnvOwn ? splitCsv(e.PROXY_POOL_OWN)
        : (Array.isArray(doc.ownList) ? doc.ownList.map(String) : []);
    const ownFile = hasEnvOwn ? (e.PROXY_POOL_OWN_FILE || null)
        : (doc.ownFile != null ? (String(doc.ownFile) || null) : DEFAULT_OWN_FILE);
    const ownFirst = e.PROXY_POOL_OWN_FIRST != null
        ? !['0', 'false'].includes(e.PROXY_POOL_OWN_FIRST.toLowerCase()) : doc.ownFirst !== false;
    let limits = doc.maxPerHost;
    if (e.PROXY_POOL_MAX_PER_HOST != null) {
        try { limits = JSON.parse(e.PROXY_POOL_MAX_PER_HOST); } catch { limits = null; }
    }
    // Путь проверки ПО ХОСТУ: у площадок на Next.js нет `/api/status`, и без этого поля
    // пул хоронит живые прокси вердиктом «HTTP 404» (см. forAccount).
    let preflightPaths = {};
    if (doc.preflightPaths && typeof doc.preflightPaths === 'object' && !Array.isArray(doc.preflightPaths)) {
        for (const [h, v] of Object.entries(doc.preflightPaths)) {
            if (typeof v === 'string' && v.startsWith('/')) preflightPaths[h] = v;
        }
    }
    if (e.PROXY_POOL_PREFLIGHT_PATHS) {
        try { preflightPaths = { ...preflightPaths, ...JSON.parse(e.PROXY_POOL_PREFLIGHT_PATHS) }; } catch { /* мусор в env не ломает конфиг */ }
    }

    const maxPerHost = { '*': 8 };
    if (limits && typeof limits === 'object' && !Array.isArray(limits)) {
        for (const [h, n] of Object.entries(limits)) {
            if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) maxPerHost[h] = n;
        }
    }

    // Отсутствующий НЕОБЯЗАТЕЛЬНЫЙ own-proxies.txt не включает пустой пул на чистой
    // установке. Явно заданный, но потерянный файл, наоборот, оставляет fail-closed.
    const ownConfigured = !!ownFile && (hasEnvOwn || !!doc.ownFile || fs.existsSync(ownFile));
    const hasSource = !!file || list.length > 0 || ownConfigured || ownList.length > 0;
    let enabled;
    const envEnabled = e.PROXY_POOL_ENABLED;
    if (envEnabled === '0' || envEnabled === 'false') enabled = false;
    else if (envEnabled === '1' || envEnabled === 'true') enabled = hasSource;
    else if (doc.enabled === false) enabled = false;
    // Ключевое для правила «не настроен → как раньше»: без источника прокси пул выключен
    // сам собой, и ни один вызывающий не меняет поведения.
    else enabled = hasSource;

    const ttl = Number(e.PROXY_POOL_PREFLIGHT_TTL != null ? e.PROXY_POOL_PREFLIGHT_TTL : doc.preflightTtlMs);
    const cfg = {
        enabled,
        file,
        list,
        ownFile,
        ownList,
        ownFirst,
        maxPerHost,
        preflightPaths,
        scheme,
        hosts,
        preflightTtlMs: Number.isFinite(ttl) && ttl >= 0 ? ttl : PREFLIGHT_TTL_MS,
        assignFile: e.PROXY_POOL_ASSIGN || (doc.assignFile ? String(doc.assignFile) : DEFAULT_ASSIGN_FILE),
        configFile: CONFIG_FILE,
    };
    CFG_MEMO = { at: Date.now(), key, cfg };
    return cfg;
}

function enabled() { return config().enabled; }

// Работает ли пул на этом хосте. Пустой белый список = на всех.
function enabledForHost(host) {
    const cfg = config();
    if (!cfg.enabled) return false;
    if (!cfg.hosts.length) return true;
    return !!host && cfg.hosts.includes(String(host));
}

// ───────────────────────────── пул ─────────────────────────────

let POOL_MEMO = null;   // { key, pool }
// Память происхождения переживает обновление ownFile в процессе. Для перезапуска
// происхождение также хранится в метаданных файла привязок, а не в строках скрапера.
// Счётчик «сколько аккаунтов прямо сейчас садится на этот хост». Нужен формуле ёмкости:
// она делит аккаунты на прокси, и без учёта ещё не посаженных потолок выходил бы 1, пока
// привязанных меньше, чем прокси - то есть уже второй аккаунт получал бы «мест нет» при
// свободных адресах. Заполняется в forAccount, живёт миллисекунды.
const PENDING = new Map();   // host → сколько посадок идёт прямо сейчас


function fileStamp(file) {
    if (!file) return '-';
    try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; }
    catch { return 'нет'; }
}

// Один источник: файл + inline. Свои читаются ОТДЕЛЬНО от выгрузки скрапера:
// его долив обрезает список по cap и однажды вымыл бы купленные адреса.
// Один источник: файл + inline.
//
// 🪤 `optional` отличает «файла ещё нет» от «файл есть, но не читается». Свой ярус
// появляется только когда владелец вставил прокси во вкладке, и до этого момента
// отсутствие `own-proxies.txt` - нормальное состояние, а не поломка. Показывать ENOENT
// в дашборде как ошибку значило бы держать там красную строку на пустом месте. У яруса
// скрапера такого снисхождения нет: он - основание пула, и его пропажа это сбой.
function readTier(file, list, scheme, optional = false) {
    const loaded = file ? loadFile(file, scheme)
        : { proxies: [], bad: [], scheme: scheme || 'http', error: null };
    if (optional && loaded.error && /ENOENT/.test(loaded.error)) loaded.error = null;
    const inline = parseList(list, scheme || loaded.scheme);
    const byId = new Map(loaded.proxies.map(p => [p.id, p]));
    for (const p of inline.proxies) if (!byId.has(p.id)) byId.set(p.id, p);
    return { proxies: [...byId.values()], bad: [...loaded.bad, ...inline.bad],
        scheme: loaded.scheme, error: loaded.error };
}

function tiers() {
    const cfg = config();
    const key = JSON.stringify([cfg.file, fileStamp(cfg.file), cfg.list, cfg.scheme,
        cfg.ownFile, fileStamp(cfg.ownFile), cfg.ownList, cfg.ownFirst, cfg.assignFile]);
    if (POOL_MEMO && POOL_MEMO.key === key) return POOL_MEMO.tiers;
    const own = readTier(cfg.ownFile, cfg.ownList, cfg.scheme, true);
    const scraped = readTier(cfg.file, cfg.list, cfg.scheme);
    const ownIds = new Set(own.proxies.map(p => p.id));
    // Свой адрес остаётся своим даже при дубле в выгрузке. Иначе ownFirst=false
    // мог бы заменить купленные креды анонимной строкой с тем же id.
    const scrapedProxies = scraped.proxies.filter(p => !ownIds.has(p.id));
    const proxies = cfg.ownFirst ? [...own.proxies, ...scrapedProxies]
        : [...scrapedProxies, ...own.proxies];
    const out = {
        own: own.proxies, scraped: scrapedProxies, byId: new Map(proxies.map(p => [p.id, p])),
        bad: [...own.bad, ...scraped.bad], ownError: own.error, fileError: scraped.error,
        ownSource: cfg.ownFile || (cfg.ownList.length ? 'config.ownList' : null),
        source: cfg.file || (cfg.list.length ? 'config.list' : null),
    };
    POOL_MEMO = { key, tiers: out, pool: { ...out, proxies, scheme: scraped.scheme } };
    return out;
}

function tierOf(proxyId) {
    const t = tiers();
    if (t.own.some(p => p.id === proxyId)) return 'own';
    return t.byId.has(proxyId) ? 'scraped' : null;
}

// Старый контракт сохранён: consumers видят объединённые proxies/byId и прежние ��оля.
function pool() {
    tiers();
    return POOL_MEMO.pool;
}

// ───────────────────────────── туннели ─────────────────────────────


// Куда пойдёт туннель: своими руками CONNECT или через пакет `socks`. Отдельной чистой
// функцией, чтобы регресс проверял диспетчеризацию без единого сокета.
function tunnelKind(proxy) {
    const s = proxy && proxy.scheme;
    if (s === 'http' || s === 'https') return 'http';
    if (s === 'socks' || s === 'socks4' || s === 'socks5') return 'socks';
    return null;
}

// HTTP(S)-прокси: CONNECT-туннель руками. Зависимостей не нужно, а `https-proxy-agent`
// в дереве нет — ставить пакет ради 30 строк незачем.
//
// 🪤 Отличие от `wisdomsatan/auto-add.js`: там CONNECT к `https://`-прокси уходит по
// голому `http.request`, то есть к TLS-прокси стучатся открытым текстом. У авторегов это
// не выстрелило только потому, что https-прокси им не давали. Здесь схема решает, каким
// модулем идти к САМОМУ прокси.
function httpTunnel(proxy, host, port) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (proxy.user || proxy.pass) {
            headers['Proxy-Authorization'] =
                'Basic ' + Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');
        }
        const mod = proxy.scheme === 'https' ? https : http;
        const req = mod.request({
            host: proxy.hostname, port: proxy.port, method: 'CONNECT',
            path: `${host}:${port}`, headers, timeout: TUNNEL_TIMEOUT_MS,
            ...(proxy.scheme === 'https' ? { servername: proxy.hostname } : {}),
        });
        req.once('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                return reject(new Error(`CONNECT → HTTP ${res.statusCode}`));
            }
            resolve(socket);
        });
        req.once('timeout', () => req.destroy(new Error('CONNECT: таймаут')));
        req.once('error', reject);
        req.end();
    });
}

// SOCKS4/5 — через пакет `socks`. 🪤 Он лежит в дереве ТРАНЗИТИВНО (тянет telegram), в
// package.json его нет. Поэтому не «падаем с ReferenceError», а говорим прямо.
function socksTunnel(proxy, host, port) {
    let SocksClient;
    try { ({ SocksClient } = require('socks')); }
    catch {
        return Promise.reject(new Error(
            "SOCKS требует пакет 'socks' — в дереве его нет. `npm i socks` или используйте HTTP-прокси"));
    }
    const type = proxy.scheme === 'socks4' ? 4 : 5;
    return SocksClient.createConnection({
        proxy: {
            host: proxy.hostname, port: proxy.port, type,
            ...(proxy.user ? { userId: proxy.user } : {}),
            ...(proxy.pass ? { password: proxy.pass } : {}),
        },
        command: 'connect',
        destination: { host, port },
        timeout: TUNNEL_TIMEOUT_MS,
    }).then(info => info.socket);
}

function tunnel(proxy, host, port) {
    const kind = tunnelKind(proxy);
    if (kind === 'http') return httpTunnel(proxy, host, port);
    if (kind === 'socks') return socksTunnel(proxy, host, port);
    return Promise.reject(new Error(`неизвестная схема прокси: ${proxy && proxy.scheme}`));
}

// Агент, у которого соединение идёт через туннель. keepAlive выключен намеренно: на
// публичных прокси переиспользование сокета живёт хуже, чем новый CONNECT.
function agentFor(proxy) {
    if (!proxy) return undefined;      // undefined = глобальный агент node, путь «как раньше»
    const a = new https.Agent({ keepAlive: false });
    a.createConnection = (options, cb) => {
        const host = options.host || options.hostname;
        const port = Number(options.port) || 443;
        tunnel(proxy, host, port).then(sock => {
            const t = tls.connect({ socket: sock, servername: options.servername || host });
            t.once('secureConnect', () => cb(null, t));
            t.once('error', e => cb(e));
        }).catch(e => cb(e));
        return undefined;
    };
    return a;
}

// ───────────────────────────── запрос через прокси ─────────────────────────────

// Ответ в форме, совместимой с fetch-Response ровно в той части, которой пользуется
// вызывающий код: status / ok / headers.get / headers.getSetCookie / text().
//
// 🪤 `getSetCookie()` обязателен. Родной `headers.get('set-cookie')` склеивает несколько
// кук через запятую, и разбор `name=value` после этого врёт — именно поэтому
// `extractSetCookie()` в newapi-account.js сначала спрашивает getSetCookie. Не отдать его
// здесь означало бы тихо ломать ротацию одноразовой refresh-куки на jwt-инстансах.
function shapeResponse(res, text) {
    const raw = res.headers || {};
    const headers = {
        get(name) {
            const v = raw[String(name).toLowerCase()];
            if (v == null) return null;
            return Array.isArray(v) ? v.join(', ') : String(v);
        },
        getSetCookie() {
            const v = raw['set-cookie'];
            if (v == null) return [];
            return Array.isArray(v) ? v.slice() : [String(v)];
        },
    };
    const status = res.statusCode || 0;
    return {
        status,
        ok: status >= 200 && status < 300,
        headers,
        viaProxy: true,
        // Тело уже вычитано в строку: повторный вызов, в отличие от fetch, не падает.
        text: async () => text,
        json: async () => JSON.parse(text),
    };
}

// https-запрос через туннель. Редиректы не разворачиваем — это `redirect: 'manual'`
// у fetch, и вызывающий код рассчитывает именно на такое поведение.
function fetchVia(proxy, url, { method = 'GET', headers = {}, body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (!proxy) return Promise.reject(new Error('fetchVia без прокси — вызывай обычный fetch'));
    const u = new URL(url);
    if (u.protocol !== 'https:') return Promise.reject(new Error(`fetchVia: поддержан только https, дано ${u.protocol}`));

    return new Promise((resolve, reject) => {
        const payload = body == null ? null
            : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
        const h = {};
        for (const [k, v] of Object.entries(headers || {})) if (v != null) h[k] = v;
        if (payload && h['content-length'] == null && h['Content-Length'] == null) {
            h['content-length'] = String(payload.length);
        }

        let done = false;
        let guard = null;
        const finish = (fn, arg) => {
            if (done) return;
            done = true;
            if (guard) clearTimeout(guard);
            fn(arg);
        };

        const req = https.request({
            host: u.hostname,
            port: u.port || 443,
            method,
            path: `${u.pathname}${u.search}`,
            headers: h,
            agent: agentFor(proxy),
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('error', e => finish(reject, e));
            res.on('end', () => finish(resolve, shapeResponse(res, Buffer.concat(chunks).toString('utf8'))));
        });

        // 🪤 Сторож на ВЕСЬ запрос, а не `timeout:` в опциях. С подменённым createConnection
        // сокет создаём мы, и штатный таймер node к нему не привязывается — запрос через
        // повисший прокси висел бы вечно, а чек баланса ждал бы его молча.
        guard = setTimeout(() => {
            req.destroy(new Error(`таймаут ${timeoutMs} мс через прокси ${proxy.label}`));
        }, timeoutMs);
        req.once('error', e => finish(reject, e));
        if (payload) req.write(payload);
        req.end();
    });
}

// ───────────────────────────── preflight ─────────────────────────────

// Вердикт по ответу — чистой функцией, чтобы регресс проверял его без сети.
//
// 🪤 HTTP 200 сам по себе НЕ пропуск. Инцидент 10.09 выглядел ровно как «200 и пустое
// тело»: ручка ответила, данных нет. Наивная проверка `status === 200` такой прокси
// признала бы живым и оставила бы нас ровно там же, откуда мы уходили.
function preflightVerdict(status, text) {
    if (status !== 200) return { ok: false, error: `HTTP ${status}` };
    const body = String(text == null ? '' : text).trim();
    if (!body) return { ok: false, error: 'HTTP 200, но тело ПУСТОЕ — ровно тот отказ, из-за которого пул и появился' };
    if (/^<(!doctype|html)/i.test(body)) return { ok: false, error: 'HTML вместо JSON — WAF-заглушка' };
    let json = null;
    try { json = JSON.parse(body); } catch { return { ok: false, error: 'тело не JSON' }; }
    if (json && json.success === false) return { ok: false, error: 'панель ответила success:false' };
    return { ok: true };
}

// Проверка прокси на конкретном шлюзе. Путь должен быть ПУБЛИЧНЫМ — аккаунт не тратится
// и сессия не жжётся, ровно как в preflight() авторега.
//
// 🔴 `/api/status` — это соглашение New API, а НЕ общий стандарт. У sub2api-панелей
// (`api.rumeng-ai.com`, `true-sota.com`) такого пути нет: он отдаёт 404, вердикт всегда
// «HTTP 404», и НИ ОДИН прокси не проходит проверку — при полностью живом прокси и живой
// панели. Замер 13.09: `/api/status` → 404, `/api/v1/settings/public` → 200 за 1,85 с
// через тот же socks5. Снаружи это выглядело как «все прокси мёртвые».
// ⇒ Движку с другим API путь передавать явно, параметром `path`.
const DEFAULT_PREFLIGHT_PATH = '/api/status';

async function preflight(proxy, { host, path: urlPath = DEFAULT_PREFLIGHT_PATH, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
    if (!host) return { ok: false, error: 'preflight без host' };
    const t0 = Date.now();
    try {
        const res = await fetchVia(proxy, `https://${host}${urlPath}`, {
            headers: { accept: 'application/json' },
            timeoutMs,
        });
        const text = await res.text();
        const v = preflightVerdict(res.status, text);
        return { ...v, status: res.status, ms: Date.now() - t0 };
    } catch (e) {
        return { ok: false, error: (e && (e.message || String(e))) || 'ошибка', status: 0, ms: Date.now() - t0 };
    }
}

// Кеш здоровья на процесс. Держим в памяти, а не в файле: состояние протухает за минуты,
// а файл привязок пишут параллельные чеки — лишняя запись только добавит гонок.
//
// 🪤 Ключ кеша включает ПУТЬ, а не только хост. Иначе проба `/api/status` и проба
// `/api/v1/settings/public` по одному хосту затирали бы вердикт друг друга, и прокси
// то «живой», то «мёртвый» без всякой связи с сетью.
const HEALTH = new Map();   // `${proxyId}|${host}|${path}` → { ok, error, at, ms }

// `path` необязателен и по умолчанию прежний — соседние вкладки (New API: aikeysapi,
// agentrouter) ничего не замечают. Нужен он движкам, где `/api/status` не существует.
async function health(proxy, host, { ttlMs = null, force = false, path: urlPath = DEFAULT_PREFLIGHT_PATH } = {}) {
    const ttl = ttlMs == null ? config().preflightTtlMs : ttlMs;
    if (ttl === 0) return { ok: true, skipped: true };      // проверка выключена настройкой
    const key = `${proxy.id}|${host}|${urlPath}`;
    const hit = HEALTH.get(key);
    if (!force && hit && (Date.now() - hit.at) < ttl) return { ...hit, cached: true };
    const r = await preflight(proxy, { host, path: urlPath });
    const rec = { ok: r.ok, error: r.error || null, status: r.status, ms: r.ms, at: Date.now() };
    HEALTH.set(key, rec);
    return rec;
}

function forgetHealth(proxyId = null, host = null) {
    if (!proxyId) { HEALTH.clear(); return; }
    for (const k of [...HEALTH.keys()]) {
        const [pid, h] = k.split('|');
        if (pid === proxyId && (!host || h === host)) HEALTH.delete(k);
    }
}

// ───────────────────────────── липкая привязка ─────────────────────────────

function assignFile() { return config().assignFile; }

function loadAssign() {
    const doc = readJson(assignFile());
    if (!doc.assign || typeof doc.assign !== 'object') doc.assign = {};
    if (!doc.version) doc.version = 1;
    return doc;
}

// Мерж-ЗАПИСЬ одного ключа, а не файла целиком. Причина не гипотетическая: пачка балансов
// идёт по три аккаунта параллельно, и запись снимка целиком стирала бы привязку соседа,
// заведённую в это же окно, — та же гонка, что лечат apSaveMerge/poolAppend.
function writeAssign(key, value) {
    const doc = loadAssign();
    if (value == null) delete doc.assign[key];
    else doc.assign[key] = value;
    doc.updatedAt = nowIso();
    try {
        fs.mkdirSync(path.dirname(assignFile()), { recursive: true });
        fs.writeFileSync(assignFile(), JSON.stringify(doc, null, 2) + '\n', 'utf8');
    } catch { /* привязка не записалась — вызывающий узнает по следующему разбору */ }
    return doc.assign[key] || null;
}

function assignments() { return loadAssign().assign; }
function assignmentFor(key) { return loadAssign().assign[String(key || '')] || null; }

// Вердикт по прокси и хосту из кеша здоровья, без сетевого похода.
//
// 🪤 Ключ кеша включает ПУТЬ (`proxyId|host|path`), а нам здесь хост нужен целиком.
// Путей на один хост бывает два - `/api/status` у New API и `/api/v1/settings/public`
// у sub2api - и «хоть один сказал, что мёртв» здесь правильный ответ: прокси, не
// достучавшийся до панели, работать через себя не даст ни на каком пути.
function healthCacheGet(proxyId = '', host = '') {
    const prefix = `${proxyId}|${host}|`;
    let any = null;
    for (const [k, v] of HEALTH) {
        if (!k.startsWith(prefix)) continue;
        if (v && v.ok === false) return v;   // провал важнее: он и решает
        any = any || v;
    }
    return any;
}

// Весь кеш здоровья одной структурой - для вкладки.
//
// 🪤 Зачем: вердикты проверок лежат в памяти процесса, а вкладка рисовала их только
// сразу после нажатия «Проверить». Обновил страницу (или открыл в другой вкладке
// браузера) - и «жив / мёртв» исчезло, хотя проверку никто не отменял. Отдаём снимок с
// моментом вердикта, чтобы UI показывал результат И его возраст, а не пустоту.
function healthSnapshot() {
    const out = [];
    for (const [key, v] of HEALTH) {
        const [proxyId, host, ...rest] = key.split('|');
        out.push({
            proxyId, host,
            path: rest.join('|') || DEFAULT_PREFLIGHT_PATH,
            ok: !!(v && v.ok), error: (v && v.error) || null,
            ms: (v && v.ms) || null, status: (v && v.status) || null,
            at: (v && v.at) || null, ageMs: v && v.at ? Date.now() - v.at : null,
        });
    }
    return out;
}

// Ключ привязки. Аккаунт в пуле опознаётся полем `id` (`ar_1786714708319_0`), но не все
// вызывающие его передают.
//
// 🪤 Нет id — это НЕ повод идти напрямую. Тогда берём следующий стабильный признак:
// имя профиля (`acct_ar_…`, оно и так производное от id), иначе хост. Липкость чуть
// грубее, зато домашний IP не течёт «потому что вызывающий не передал поле».
function stickyKey({ accountId = null, profileDir = null, host = null } = {}) {
    const id = String(accountId == null ? '' : accountId).trim();
    if (id) return id;
    if (profileDir) return `profile:${path.basename(String(profileDir))}`;
    if (host) return `host:${host}`;
    return '';
}

// Кому меньше всех досталось — тому и отдаём. Детерминированно: при равном счёте
// побеждает порядок в пуле, так что одинаковое состояние даёт одинаковую раскладку.
//
// 🪤 Это ГЛОБАЛЬНАЯ нагрузка и она годится только как второй критерий. У панелей свои
// лимиты на адрес (agentrouter злее всех), поэтому решает нагрузка НА ХОСТЕ - см. pick().
function leastLoaded(proxies, assign) {
    const load = new Map(proxies.map(p => [p.id, 0]));
    for (const v of Object.values(assign || {})) {
        if (v && v.proxy && load.has(v.proxy)) load.set(v.proxy, load.get(v.proxy) + 1);
    }
    let best = proxies[0];
    let bestN = load.get(best.id);
    for (const p of proxies) {
        const n = load.get(p.id);
        if (n < bestN) { best = p; bestN = n; }
    }
    return best;
}

// ───────────────── мэппинг «прокси × хост» и ёмкость ─────────────────

// Сколько привязок уже сидит на каждом прокси ИМЕННО для этого хоста.
//
// Зачем не хватает глобального счёта: у панели WAF считает запросы по IP, и лимит у
// каждой панели свой. Пять аккаунтов на одном прокси, разложенные по трём разным хостам,
// для каждого хоста выглядят как один-два адреса - а глобальный счёт показал бы пять и
// размазал бы остальных зря.
//
// 🪤 Записи привязок, созданные до 2026-09-15, поля `host` не имеют. Брать их за
// 'unknown' нельзя: тогда ВСЕ 53 существующие привязки свалятся в один бакет, и мэппинг
// по хостам - то, ради чего вкладка и делается, - на них просто не заработает. Но хост
// у них выводим: ключ привязки это ровно результат stickyKey(), а это accountId, у
// которого префикс однозначно называет панель (`ar_…`, `aikeysapi:…`, `rm_…`).
//
// Вывод - только ФОЛБЭК: явно записанный host всегда сильнее догадки.
const HOST_PREFIXES = [
    ['aikeysapi', 'www.aikeysapi.com'],
    ['ak', 'www.aikeysapi.com'],
    ['ar', 'agentrouter.org'],
    ['rm', 'api.rumeng-ai.com'],
    ['rumeng', 'api.rumeng-ai.com'],
];

function hostForKey(key) {
    const s = String(key || '').trim();
    if (!s) return null;
    const prefix = s.split(/[_:]/)[0].toLowerCase();
    if (!prefix) return null;
    // Ищем по УБЫВАНИЮ длины префикса: `aikeysapi` должен победить `ak`, иначе короткий
    // ключ перехватит чужой аккаунт.
    let best = null;
    for (const [p, host] of HOST_PREFIXES) {
        if (!prefix.startsWith(p)) continue;
        if (!best || p.length > best[0].length) best = [p, host];
    }
    return best ? best[1] : null;
}

// Хост записи привязки: явный или выведенный из ключа.
function recHost(rec, key) {
    if (rec && rec.host != null && rec.host !== '') return String(rec.host);
    return hostForKey(key);
}

// Ярус ПРИВЯЗКИ, а не прокси. Пишется в запись в момент назначения и переживает рестарт
// вместе с ней.
//
// 🪤 Почему не по текущему пулу: у осиротевшей привязки прокси в пуле уже НЕТ, и `tierOf()`
// про неё ничего не скажет - ни свой, ни скраперный. Спрашивать приходится у самой записи.
//
// 🪤 Почему не «история всего, что когда-либо лежало в своём файле»: такая история
// накапливается и не забывает ничего, поэтому протухший скраперный адрес, побывавший в
// своём списке хоть раз, навсегда считался бы своим и никогда не был бы перевешен
// автоматикой. Запись в момент назначения отвечает ровно про тот момент, когда это было
// решением, и больше ни о чём.
//
// У записей до 2026-09-15 поля `tier` нет - они скраперные, и это верно: своего яруса
// тогда не существовало.
function recTier(rec) {
    return rec && rec.tier === 'own' ? 'own' : 'scraped';
}

// Сколько привязок сидит на каждом прокси ИМЕННО для этого хоста.
function hostLoad(host = null) {
    const h = host == null ? 'unknown' : String(host);
    const load = new Map();
    for (const [key, v] of Object.entries(assignments())) {
        if (!v || !v.proxy) continue;
        if (recHost(v, key) !== h) continue;
        load.set(v.proxy, (load.get(v.proxy) || 0) + 1);
    }
    return load;
}

// Предел аккаунтов на один прокси для этого хоста. Ключ `*` - значение по умолчанию.
// 0 означает «на этот хост через прокси не ходим» и обрабатывается вызывающим явно.
// ───────────────── ёмкость, подстраивающаяся под размер пула ─────────────────
//
// 🔴 Потолок НЕ константа и НЕ настройка. Просьба владельца 15.09: «оно должно умно
// подстраиваться под то, сколько вообще прокси в пуле - у меня 5-6, а у других юзеров
// может быть и меньше, и больше». Фиксированное число этого не умеет: одно и то же «8»
// на пуле из 40 адресов разрешает что угодно, а на пуле из 2 адресов молча пускает
// шестнадцать аккаунтов на один IP.
//
// Формула: поровну всех привязанных аккаунтов хоста на все РАБОЧИЕ прокси, которые этот
// хост обслуживают. Не на все подряд: мёртвый адрес работы не несёт, и считать его в
// знаменателе значило бы раздавать места тому, чего нет.
//
//   2 прокси  × 10 аккаунтов → 5 на адрес
//   6 прокси  × 33 аккаунта  → 6 на адрес
//   20 прокси × 33 аккаунта  → 2 на адрес
//
// 🪤 Считается по данным НА ДИСКЕ (привязки + живой пул), а не по счётчикам в памяти:
// рестарт дашборда не должен менять раскладку, иначе одинаковое состояние даёт разные
// решения, и это ломает детерминизм выбора.
//
// 🪤 Уже сидящие привязки эта формула не трогает вообще. Она отвечает только на вопрос
// «куда посадить НОВЫЙ аккаунт». Перетасовка при смене размера пула была бы вреднее
// перекоса: у аккаунта живая сессия, и смена IP заметнее антифроду панели.
//
// Явный `maxPerHost[хост]` в конфиге остаётся и главнее формулы - для тех, кто знает
// свой предел лучше. Ключ `*` больше НЕ читается как значение по умолчанию: он бы
// перебил формулу одним числом и вернул ровно ту жёсткость, от которой уходим.
// Чем делим: прокси пула, которые МОГУТ обслуживать этот хост, минус те, про которые
// УЖЕ ИЗВЕСТНО, что они на нём не отвечают.
//
// 🪤 Формула не может «проверить, жив ли прокси» - живость узнаётся только живым
// preflight, а он ходит в сеть. И знать её постоянно нельзя: кеш здоровья живёт в
// памяти процесса и пуст после перезапуска дашборда. Если бы знаменатель зависел от
// сетевых проб, раскладка перестала бы быть повторяемой: то же состояние давало бы
// разные решения, и «почему аккаунт сел сюда» не объяснялось бы ничем.
//
// Поэтому берём факты, которые есть всегда: состав пула (диск) и вердикты проверок,
// которые кто-то уже сделал в этом процессе. Прокси, провалившийся на этом хосте,
// вычитается - и место перераспределяется на работающие, как владелец и просил. После
// перезапуска знание о провалах обнуляется, знаменатель возвращается к размеру пула,
// и это честнее притворной точности.
function liveProxiesFor(host = null) {
    const cfg = config();
    const t = tiers();
    if (!host) return t.byId.size;
    // Хост вне белого списка пула не обслуживается вовсе: делить не на что.
    if (cfg.hosts.length && !cfg.hosts.includes(String(host))) return 0;
    const h = String(host);
    let n = 0;
    for (const p of t.byId.values()) {
        const verdict = healthCacheGet(p.id, h);
        if (verdict && verdict.ok === false) continue;   // провалился на этом хосте - не считаем
        n++;
    }
    return n;
}

// Сколько аккаунтов уже привязано к этому хосту.
function assignedForHost(host = null) {
    if (host == null) return Object.keys(assignments()).length;
    const h = String(host);
    let n = 0;
    for (const [key, v] of Object.entries(assignments())) {
        if (v && v.proxy && recHost(v, key) === h) n++;
    }
    return n;
}

// Хосты, которые пул РЕАЛЬНО обслуживает: белый список конфига, а если его нет - те, что
// встретились в привязках. Записи без опознаваемого хоста сюда не попадают.
function servedHosts() {
    const cfg = config();
    if (cfg.hosts.length) return cfg.hosts.map(String);
    return [...new Set(assignmentRows().map(r => r.host).filter(Boolean))];
}

// 🔴 ЕДИНСТВЕННЫЙ числитель ёмкости. И потолок, и цифры вкладки берут его отсюда, и это
// не вкусовщина, а страж: пока числитель считался в двух местах по-разному, `capacity()`
// печатал густоту по обслуживаемым хостам, а `maxPerHostFor()` делил весь файл целиком -
// вместе с записями панелей, которых пул не знает.
//
// 🪤 Чем это кончилось 16.09: 28 привязок AgentRouter на 39 адресов давали потолок
// `ceil(44/39)=2` вместо `ceil(28/39)=1`. Шесть адресов несли по два аккаунта, план
// ребаланса показывал 0 перемещений вместо 6, и вкладка рядом с этим потолком печатала
// «записи других провайдеров в расчёт ёмкости не идут». Молча, без единой ошибки.
// Закреплено регрессом `check-proxy-mapping.js`, блок 10b.
function servedAssigned() {
    return servedHosts().reduce((n, h) => n + assignedForHost(h), 0);
}

// Потолок: сколько аккаунтов разрешено посадить на ОДИН прокси.
//
// 🔴 Считается на ВЕСЬ ПУЛ, а не на каждого провайдера отдельно. Владелец 16.09:
// «пул прокси должен быть 1, не надо разделять их». Пул один, прокси одни и те же, и
// делить его по провайдерам значило бы показывать разные ответы на один и тот же вопрос
// «сколько аккаунтов на адрес» - а адрес-то один.
//
// 🪤 Раньше считалось ПО ХОСТУ, и у этого была своя логика (WAF у панелей разный). Но
// владелец решил иначе, и он прав в главном: свой прокси один, а не «на AgentRouter свои,
// на другого свои». Разные лимиты на одном и том же адресе - это не тонкая настройка, а
// путаница, которую видно на вкладке.
//
// Ручное значение `maxPerHost["хост"]` остаётся и главнее формулы - аварийный рычаг для
// случая, когда конкретная панель доказанно злее прочих.
function maxPerHostFor(host = null) {
    const m = config().maxPerHost || {};
    const h = host == null ? '' : String(host);
    if (h && Number.isSafeInteger(m[h]) && m[h] > 0) return m[h];   // явная ручная настройка
    const live = liveProxiesFor(host);
    // Хост, которого пул не обслуживает, сажать некуда - это не «потолок 0», а «не наш
    // хост». Держим различие: смешать их значило бы снова получить план ребаланса,
    // который двигает привязки чужих провайдеров с причиной «уже 0 аккаунтов».
    if (live <= 0) return 0;

    // 🔴 Числитель - привязки ОБСЛУЖИВАЕМЫХ хостов и все, кому место ещё нужно. Не весь
    // файл: в нём лежат записи мёртвых панелей, и они раздували бы потолок ровно во
    // столько раз, сколько их накопилось (разбор - у `servedAssigned`).
    //
    // 🪤 Считать только уже привязанных нельзя - формула запирает сама себя: пока
    // аккаунтов меньше, чем прокси, потолок выходит 1, и уже второй аккаунт получает
    // «мест нет» при свободных адресах. Замерено регрессом: пул из трёх прокси не мог
    // расселить шесть аккаунтов. Поэтому в числителе и стоящие в очереди.
    //
    // 🪤 PENDING фильтровать по хостам не нужно: очередь наполняет только `forAccount`, а
    // он отсекает необслуживаемые хосты раньше - до взятия замка.
    let need = servedAssigned();
    for (const n of PENDING.values()) need += n;
    return Math.max(1, Math.ceil(need / live));
}

// Оценка риска для ВКЛАДКИ. Отдельно от ёмкости: раскладку владелец разрешил не
// ограничивать («пусть скачет как хочет»), но про опасную густоту должен узнать.
//
// Порог 8 - не замер, а здравый смысл: панель считает запросы со своего IP, и восемь
// аккаунтов, ходящих через один адрес с одной машины, выглядят для неё плотнее обычного
// домашнего NAT. Живёт в одном месте, чтобы правился одной строкой, когда появится замер.
const DENSE_PER_PROXY_WARN = 8;

// Сводка ёмкости для вкладки. ОДНА на весь пул - владелец 16.09: «пул прокси должен
// быть 1, не надо разделять их».
//
// 🪤 Раньше здесь была таблица по хостам, и это противоречило самому смыслу: адреса в
// пуле одни и те же, а лимит на них показывался разный - смотря для какого провайдера
// смотреть. Читается как «прокси поделены между провайдерами», хотя делены не прокси,
// а привязки.
function capacity() {
    const cfg = config();
    const t = tiers();
    const live = t.byId.size;
    // 🔴 Считаем только по ОБСЛУЖИВАЕМЫМ хостам. В файле привязок лежат записи мёртвых
    // панелей, и общий счёт по всему файлу показал бы густоту, которой в пуле нет.
    // Числитель берётся из `servedAssigned()` - там же, откуда его берёт потолок.
    const hosts = servedHosts();
    const served = servedAssigned();
    const per = live > 0 ? served / live : null;
    const manual = hosts
        .map(h => [h, (cfg.maxPerHost || {})[h]])
        .filter(([, v]) => Number.isSafeInteger(v) && v > 0);
    return {
        liveProxies: live,
        assigned: served,
        // Для справки: сколько записей в файле вообще, включая чужие провайдеры.
        assignedAll: Object.keys(assignments()).length,
        perProxy: per,
        limit: maxPerHostFor(hosts[0] || null),
        dense: per != null && per > DENSE_PER_PROXY_WARN,
        threshold: DENSE_PER_PROXY_WARN,
        // Ручные переопределения показываем, если они есть: молчать о том, что формула
        // перебита, нельзя - иначе цифра выглядит необъяснимой.
        manual: manual.map(([host, value]) => ({ host, value })),
    };
}

// Порядок ярусов для выбора. Свой адрес стабильнее и не вымоется доливом скрапера,
// поэтому при ownFirst он идёт первым; при ownFirst=false порядок обратный.
function tierOrder() {
    const cfg = config();
    const t = tiers();
    return cfg.ownFirst ? [['own', t.own], ['scraped', t.scraped]]
        : [['scraped', t.scraped], ['own', t.own]];
}

// Очередь посадок ПО ХОСТУ.
//
// 🔴 Зачем не «просто посчитать»: пачка балансов идёт параллельно, и без сериализации все
// вызовы видят одинаковую нагрузку (её ещё нет) и выбирают ОДИН прокси. Плюс формула
// ёмкости должна видеть, сколько аккаунтов ещё садится, иначе делит меньше, чем надо, и
// запирает сама себя: на пуле из трёх прокси потолок выходил 1, и шесть аккаунтов не
// расселялись вовсе (замерено регрессом check-proxy-pool.js, блок 10).
//
// Очередь - только на участок между «прочитал привязки» и «записал привязку». Сетевой
// preflight наружу её не выносим: держать очередь на время сети значит растянуть пачку на
// секунды.
const ASSIGN_QUEUE = new Map();   // host → хвост цепочки

function withAssignLock(host, fn) {
    const key = host == null ? 'unknown' : String(host);
    const prev = ASSIGN_QUEUE.get(key) || Promise.resolve();
    const run = () => {
        PENDING.set(key, (PENDING.get(key) || 0) + 1);
        const release = () => {
            const n = (PENDING.get(key) || 1) - 1;
            if (n <= 0) PENDING.delete(key); else PENDING.set(key, n);
        };
        try {
            const out = fn();
            // fn может вернуть промис - тогда счёт снимаем после него, а не сразу.
            if (out && typeof out.then === 'function') return out.finally(release);
            release();
            return out;
        } catch (e) { release(); throw e; }
    };
    const next = prev.then(run, run);
    ASSIGN_QUEUE.set(key, next.then(() => {}, () => {}));
    return next;
}

// Кандидат для НОВОЙ привязки: сначала ярус по порядку, внутри яруса - те, у кого на
// этом хосте есть место (hostLoad < maxPerHostFor), сортировка по (нагрузка на хосте,
// общая нагрузка, порядок в пуле).
//
// Возвращает { proxy, tier } | { exhausted: true, tier } | { saturated: true }.
// 🪤 «Свои кончились» и «у своих нет места» - разные вещи: в первом случае корректно
// перелить на скрапер, во втором перелив означал бы, что мы обходим лимит панели.
function pick(host = null) {
    const assign = assignments();
    const global = new Map();
    for (const v of Object.values(assign)) {
        if (v && v.proxy) global.set(v.proxy, (global.get(v.proxy) || 0) + 1);
    }
    const limit = maxPerHostFor(host);
    const hLoad = hostLoad(host);
    let sawTier = false;
    for (const [tier, list] of tierOrder()) {
        if (!list.length) continue;
        sawTier = true;
        const free = list.filter(p => (hLoad.get(p.id) || 0) < limit);
        if (!free.length) continue;          // ярус занят под потолок - пробуем следующий
        const rank = p => [
            hLoad.get(p.id) || 0,
            global.get(p.id) || 0,
            list.indexOf(p),
        ];
        free.sort((a, b) => {
            const ra = rank(a), rb = rank(b);
            return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
        });
        return { proxy: free[0], tier };
    }
    // Ни один ярус не дал места. Если прокси вообще есть, значит упёрлись в лимиты.
    if (sawTier) return { saturated: true };
    return { exhausted: true };
}

// Главная функция модуля. Ответы читать строго по контракту из шапки.
//
//   { ok:true,  proxy:null, direct:true } — пул не настроен/выключен на этом хосте
//   { ok:true,  proxy:{…}, how:'sticky'|'new' } — идти через него
//   { ok:false, error }                   — назначен и мёртв → НЕ ХОДИТЬ ВООБЩЕ
async function forAccount(key, { host = null, force = false, usePreflight = true, preflightPath = null } = {}) {
    // 🔴 Путь проверки зависит от ХОСТА, и по умолчанию его брать нельзя. `/api/status` -
    // соглашение New API; у площадок на Next.js такой ручки нет, и вердикт выходит
    // «HTTP 404» при ЖИВОМ прокси и живой панели. Ровно на этом встал чек баланса Odyssey
    // 16.09: аккаунт привязан к рабочему адресу, а пул считал его мёртвым и отказывался
    // идти («Напрямую НЕ пойду и другой не подставлю»). Путь для хоста задаётся в конфиге.
    const cfg0 = config();
    const probePath = preflightPath
        || (host && cfg0.preflightPaths && cfg0.preflightPaths[host])
        || DEFAULT_PREFLIGHT_PATH;
    return _forAccount(key, { host, force, usePreflight, preflightPath: probePath });
}

async function _forAccount(key, { host = null, force = false, usePreflight = true, preflightPath = DEFAULT_PREFLIGHT_PATH } = {}) {
    const cfg = config();
    if (!cfg.enabled) return { ok: true, proxy: null, direct: true, reason: 'пул прокси не настроен' };
    if (cfg.hosts.length && (!host || !cfg.hosts.includes(String(host)))) {
        return { ok: true, proxy: null, direct: true, reason: `хост ${host || '—'} вне белого списка пула` };
    }

    const p = pool();
    // 🔴 Включён, но пуст — это ошибка настройки, а не разрешение идти напрямую. Тот самый
    // тихий провал, из-за которого автореги уходили с домашнего IP.
    if (!p.proxies.length) {
        const why = p.fileError ? p.fileError
            : p.bad.length ? `ни одна из ${p.bad.length} строк не разобрана, первая: ${p.bad[0]}`
            : 'список пуст';
        return { ok: false, error: `пул прокси включён, но пригодных прокси нет (${why}). Напрямую НЕ пойду` };
    }

    const k = String(key || '').trim();
    if (!k) return { ok: false, error: 'нет ключа привязки (ни accountId, ни профиля, ни хоста) — вслепую прокси не выдам' };

    const doc = loadAssign();
    const cur = doc.assign[k];
    let proxy = null;
    let how = 'sticky';
    let tier = null;

    if (cur && cur.proxy) {
        proxy = p.byId.get(cur.proxy) || null;
        // 🔴 Назначенный прокси пропал из списка — молча подсунуть другой нельзя: у
        // аккаунта живая сессия, и смена IP заметнее, чем пропущенный чек. Пусть владелец
        // решит явно (reassign/release).
        if (!proxy) {
            return {
                ok: false,
                needsReassign: true,
                assigned: cur.proxy,
                error: `аккаунту назначен ${cur.proxy}, но его больше нет в пуле. Другой подставлять не буду`
                    + ' — верни строку в список или сними привязку явно (release/reassign)',
            };
        }
        tier = tierOf(proxy.id);
    } else {
        // 🔴 Посадка НОВОГО аккаунта - под очередью хоста. Без неё параллельная пачка
        // видит одинаковую нагрузку (её ещё нет) и все выбирают один прокси, а формула
        // ёмкости не видит, сколько аккаунтов ещё садится. Сеть (preflight) остаётся
        // снаружи очереди.
        const chosen = await withAssignLock(host, () => {
            const c = pick(host);
            if (c.proxy) {
                writeAssign(k, { proxy: c.proxy.id, at: nowIso(), why: 'первичное назначение', host: host || null, tier: c.tier });
            }
            return c;
        });
        // 🔴 Мест нет не значит «иди напрямую». Свободных прокси хватает, но у каждого
        // по этому хосту выбран потолок - перелив молча упёрся бы в WAF панели, ради
        // ухода от которого пул и существует.
        if (chosen.saturated) {
            return {
                ok: false,
                saturated: true,
                error: `на хосте ${host} нет свободного прокси: у всех достигнут потолок`
                    + ` ${maxPerHostFor(host)} аккаунтов на адрес. Добавь прокси в свои или сними`
                    + ' привязки вручную (release/reassign)',
            };
        }
        if (chosen.exhausted) return { ok: false, error: 'пул прокси пуст — назначать нечего' };
        proxy = chosen.proxy;
        tier = chosen.tier;
        how = 'new';
    }

    if (usePreflight && host) {
        const h = await health(proxy, host, { force, path: preflightPath });
        if (!h.ok) {
            return {
                ok: false,
                dead: true,
                proxy,
                assigned: proxy.id,
                error: `назначенный прокси ${proxy.label} не отвечает на ${host}: ${h.error}.`
                    + ' Напрямую НЕ пойду и другой не подставлю',
            };
        }
    }

    return { ok: true, proxy, how, key: k, tier };
}

// Явные операции владельца: снять привязку и назначить заново. Обе только по просьбе —
// автоматика этого не делает по построению (см. 🪤 про липкость).
function release(key) {
    const k = String(key || '').trim();
    if (!k) return null;
    const prev = assignmentFor(k);
    writeAssign(k, null);
    if (prev && prev.proxy) forgetHealth(prev.proxy);
    return prev;
}

function reassign(key, proxyId = null) {
    const k = String(key || '').trim();
    if (!k) return { ok: false, error: 'пустой ключ' };
    const p = pool();
    if (!p.proxies.length) return { ok: false, error: 'пул пуст — назначать нечего' };
    const prev = assignmentFor(k);
    // Хост держим в записи: он нужен ёмкости по паре «прокси × хост». Старая привязка
    // знает свой хост - сохраняем его, а не пишем unknown.
    const host = (prev && prev.host) || null;
    let proxy;
    if (proxyId) {
        proxy = p.byId.get(String(proxyId)) || null;
        if (!proxy) return { ok: false, error: `${proxyId} нет в пуле` };
    } else {
        // Себя в расчёт нагрузки не берём - считаем, что привязки ещё нет.
        const saved = prev;
        writeAssign(k, null);
        const chosen = pick(host);
        if (saved) writeAssign(k, saved);
        if (chosen.saturated) {
            return { ok: false, error: `на хосте ${host} нет свободного прокси: потолок ${maxPerHostFor(host)} достигнут у всех` };
        }
        if (chosen.exhausted) return { ok: false, error: 'пул прокси пуст — назначать нечего' };
        proxy = chosen.proxy;
    }
    writeAssign(k, { proxy: proxy.id, at: nowIso(), why: 'назначено вручную', host, tier: tierOf(proxy.id) || 'scraped' });
    forgetHealth(proxy.id);
    return { ok: true, proxy, tier: tierOf(proxy.id) };
}

// ───────────────────────────── ребаланс ─────────────────────────────

// Привязки, которые держат АККАУНТЫ, а не прокси. Ключ здесь - `key` записи
// (`ar_1789…`), а не id прокси: у одного прокси таких записей много.
function assignmentRows() {
    const rows = [];
    for (const [key, v] of Object.entries(assignments())) {
        if (!v || !v.proxy) continue;
        rows.push({ key, proxy: v.proxy, host: recHost(v, key), tier: recTier(v), at: v.at || null, why: v.why || null });
    }
    return rows;
}

// Что ребаланс сдвинет - БЕЗ применения. Два класса проблем:
//   1. осиротевшая привязка: прокси, на который она смотрит, из пула исчез;
//   2. переполнение: на одном прокси для одного хоста сидит больше maxPerHostFor.
//
// 🔴 Живая привязка, у которой есть место, не двигается НИКОГДА. У аккаунта живая сессия,
// и смена IP заметнее антифроду панели, чем один лишний чек. Планировщик - не повод
// трогать то, что работает.
//
// 🪤 Осиротевшая привязка на СВОЁМ ярусе в `moves` не попадает, только в `skipped`.
// Причина: свой прокси мог временно выпасть из списка (ротация файла, правка вручную), а
// у аккаунта сессия живая. Такую снимает владелец явно, автоматика - нет.
function rebalancePlan({ host = null } = {}) {
    const t = tiers();
    const rows = assignmentRows();
    const moves = [];
    const skipped = [];

    for (const r of rows) {
        if (!r.proxy) continue;
        if (t.byId.has(r.proxy)) continue;               // прокси на месте
        if (r.tier === 'own') {
            skipped.push({ key: r.key, proxy: r.proxy, host: r.host, why: 'осиротел на СВОЁМ ярусе — снимает только владелец' });
        } else {
            moves.push({ key: r.key, from: r.proxy, host: r.host, why: 'прокси исчез из пула' });
        }
    }

    // Переполнение: считаем нагрузку по паре прокси × хост, сверх лимита двигаем САМЫЕ
    // СВЕЖИЕ привязки - у них сессия моложе, и потеря непрерывности дешевле.
    const byPair = new Map();
    for (const r of rows) {
        if (!t.byId.has(r.proxy)) continue;              // осиротевшие уже разобраны выше
        if (host && r.host !== String(host)) continue;
        const k = `${r.proxy}|${r.host || 'unknown'}`;
        if (!byPair.has(k)) byPair.set(k, []);
        byPair.get(k).push(r);
    }
    for (const [, list] of byPair) {
        const h = list[0].host;
        // 🔴 Хост, которого пул НЕ обслуживает, не ребалансируем вообще.
        //
        // Без этой отсечки получалось вот что: у такого хоста потолок равен нулю (живых
        // прокси нет), условие `list.length <= limit` не выполнялось НИКОГДА, и КАЖДАЯ
        // привязка выглядела «сверх потолка». План предлагал сдвинуть привязки
        // провайдеров, которых пул не знает, с самопротиворечивой причиной «на прокси уже
        // 0 аккаунтов». Замер 15.09: из 21 перемещения 15 были такими.
        //
        // 🪤 В skipped, а не тихо мимо: это не «перекоса нет», а «эти привязки вне пула,
        // и трогать их должен владелец» - ровно тот случай, для которого skipped и есть.
        if (liveProxiesFor(h) === 0) {
            for (const r of list) {
                skipped.push({ key: r.key, proxy: r.proxy, host: r.host, why: 'хост вне пула — пул его не обслуживает' });
            }
            continue;
        }
        const limit = maxPerHostFor(h);
        if (list.length <= limit) continue;
        const extra = list.slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
            .slice(0, list.length - limit);
        for (const r of extra) {
            moves.push({ key: r.key, from: r.proxy, host: r.host, why: `на прокси уже ${limit} аккаунтов для ${h}` });
        }
    }

    return { moves, skipped };
}

// Применение плана. Идём по перемещениям по одному, каждый раз пересчитывая кандидата:
// после первого же перевеса нагрузка изменилась, и заранее посчитанные цели разъехались бы.
// 🪤 Прокси для перевеса ищем ТОЛЬКО с учётом хоста привязки. Подставить прокси, у
// которого на этом хосте уже потолок, значило бы чинить перекос перекосом.
function applyRebalance(plan) {
    const moves = (plan && plan.moves) || [];
    const errors = [];
    let applied = 0;
    for (const m of moves) {
        const k = String(m.key || '').trim();
        if (!k) { errors.push({ key: m.key, error: 'пустой ключ' }); continue; }
        const host = m.host == null ? null : String(m.host);
        const saved = assignmentFor(k);
        writeAssign(k, null);                            // себя в нагрузку не берём
        const chosen = pick(host);
        if (chosen.saturated || chosen.exhausted) {
            if (saved) writeAssign(k, saved);            // не смогли - вернуть как было
            errors.push({ key: k, error: chosen.saturated
                ? `нет свободного прокси для ${host}: потолок ${maxPerHostFor(host)} достигнут`
                : 'пул прокси пуст' });
            continue;
        }
        if (saved && saved.proxy) forgetHealth(saved.proxy);
        writeAssign(k, { proxy: chosen.proxy.id, at: nowIso(), why: `ребаланс: ${m.why || 'перевес'}`, host, tier: chosen.tier });
        applied++;
    }
    return { applied, errors };
}

// Сводка для дашборда и регресса. Кредов не печатаем: label их не содержит.
function describe() {
    const cfg = config();
    const p = pool();
    const t = tiers();
    const assign = assignments();
    const load = new Map(p.proxies.map(x => [x.id, 0]));
    let orphans = 0, orphansOwn = 0, orphansScraped = 0;
    for (const [key, v] of Object.entries(assign)) {
        if (!v || !v.proxy) continue;
        if (load.has(v.proxy)) load.set(v.proxy, load.get(v.proxy) + 1);
        else {
            orphans++;
            if (recTier(v) === 'own') orphansOwn++; else orphansScraped++;
        }
    }

    // Матрица «хост → прокси → сколько аккаунтов». Ради неё вкладка и делается: владелец
    // должен видеть, как его пять адресов разложены по панелям.
    const pairs = new Map();                             // host → Map(proxyId → n)
    for (const r of assignmentRows()) {
        const h = r.host || 'unknown';
        if (!pairs.has(h)) pairs.set(h, new Map());
        const m = pairs.get(h);
        m.set(r.proxy, (m.get(r.proxy) || 0) + 1);
    }
    const byHost = [...pairs.entries()].map(([host, m]) => ({
        host,
        limit: maxPerHostFor(host === 'unknown' ? null : host),
        proxies: [...m.entries()]
            .map(([id, accounts]) => ({ id, accounts, tier: tierOf(id), alive: t.byId.has(id) }))
            .sort((a, b) => b.accounts - a.accounts),
    })).sort((a, b) => a.host.localeCompare(b.host));

    return {
        enabled: cfg.enabled,
        source: p.source,
        scheme: p.scheme,
        hosts: cfg.hosts,
        count: p.proxies.length,
        bad: p.bad.length,
        fileError: p.fileError,
        assignFile: cfg.assignFile,
        assigned: Object.keys(assign).length,
        orphans,                                   // привязки на прокси, которых уже нет
        orphansOwn,
        orphansScraped,
        load: [...load.entries()].map(([id, n]) => ({ id, accounts: n, tier: tierOf(id) })),
        // Новое для вкладки «Свои прокси»:
        own: t.own.length,
        scraped: t.scraped.length,
        ownSource: t.ownSource,
        ownFile: cfg.ownFile || null,
        ownFirst: cfg.ownFirst !== false,
        ownError: t.ownError || null,
        maxPerHost: cfg.maxPerHost,
        byHost,
    };
}

// Сброс мемо — для регресса, который меняет env между проверками.
// 🪤 Ярус привязки здесь ни при чём: он лежит в САМОЙ записи на диске, а не в памяти
// процесса, поэтому рестарт дашборда его не теряет - и чистить в сбросе нечего.
function _reset() { CFG_MEMO = null; POOL_MEMO = null; HEALTH.clear(); }

module.exports = {
    // разбор
    parseProxy, parseList, loadFile, schemeFromFilename, SCHEMES,
    // конфиг и пул
    config, enabled, enabledForHost, pool, describe,
    CONFIG_FILE, DEFAULT_ASSIGN_FILE, DEFAULT_OWN_FILE,
    // ярусы и мэппинг «прокси × хост»
    tiers, tierOf, hostLoad, maxPerHostFor, pick, tierOrder,
    capacity, liveProxiesFor, assignedForHost,
    // сеть
    tunnel, tunnelKind, httpTunnel, socksTunnel, agentFor, fetchVia,
    preflight, preflightVerdict, health, forgetHealth, healthCacheGet, healthSnapshot,
    // липкость
    stickyKey, forAccount, assignments, assignmentFor, release, reassign, leastLoaded,
    // ребаланс
    assignmentRows, rebalancePlan, applyRebalance,
    // служебное
    _reset,
};
