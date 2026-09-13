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

// Принимаем и полный URL, и голый `ip:port` (формат export/protocols/*.txt скрапера, где
// протокол несёт имя файла). Возвращаем нормализованное описание или null.
//
// 🪤 Возврат null здесь — НЕ «работай напрямую». Это входные данные, которые мы не поняли;
// решение о походе принимает forAccount(), и он на пустом пуле отвечает ошибкой.
function parseProxy(raw, defScheme = 'http') {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || s.startsWith('#')) return null;
    const scheme0 = SCHEMES.includes(String(defScheme || '').toLowerCase())
        ? String(defScheme).toLowerCase()
        : 'http';
    const withScheme = /^[a-z0-9]+:\/\//i.test(s) ? s : `${scheme0}://${s}`;
    let u;
    try { u = new URL(withScheme); } catch { return null; }
    const scheme = u.protocol.replace(':', '').toLowerCase();
    if (!SCHEMES.includes(scheme)) return null;
    if (!u.hostname) return null;
    // 🪤 `new URL` СРЕЗАЕТ дефолтный для схемы порт: у `http://1.2.3.4:80` поле `u.port`
    // пустое, как и у адреса вообще без порта. Проверять `!u.port` значило молча терять
    // весь :80 у http и :443 у https — а в бесплатных списках это каждая пятая строка.
    // Поэтому порт берём из самой строки, и «порта нет» по-прежнему остаётся отказом.
    const authority = withScheme.slice(withScheme.indexOf('://') + 3).split(/[/?#]/)[0];
    const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
    const explicit = /:(\d{1,5})$/.exec(hostPart);
    const port = Number(explicit ? explicit[1] : u.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const label = `${scheme}://${u.hostname}:${port}`;
    return {
        // id стабильно по СОДЕРЖАНИЮ, а не по позиции в файле: список скрапера
        // пересортируется при каждом обновлении, и индексный id порвал бы все привязки.
        // Кредов в id нет намеренно — сменив пароль, привязку терять незачем.
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

    const hasSource = !!file || list.length > 0;
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

function fileStamp(file) {
    if (!file) return '-';
    try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; }
    catch { return 'нет'; }
}

// Итоговый пул: файл + inline-список конфига, слитые и дедуплицированные.
// Мемо по (источник + mtime файла): список скрапера обновляют, и перечитывать его
// на каждый чек баланса незачем, но и залипать на снимке нельзя.
function pool() {
    const cfg = config();
    const key = [cfg.file || '-', fileStamp(cfg.file), cfg.list.join('|'), cfg.scheme || '-'].join('\u0000');
    if (POOL_MEMO && POOL_MEMO.key === key) return POOL_MEMO.pool;

    const proxies = [];
    const bad = [];
    const seen = new Set();
    let fileError = null;
    let scheme = cfg.scheme || 'http';

    if (cfg.file) {
        const r = loadFile(cfg.file, cfg.scheme);
        scheme = r.scheme;
        fileError = r.error;
        for (const p of r.proxies) { if (!seen.has(p.id)) { seen.add(p.id); proxies.push(p); } }
        bad.push(...r.bad);
    }
    if (cfg.list.length) {
        const r = parseList(cfg.list, cfg.scheme || scheme);
        for (const p of r.proxies) { if (!seen.has(p.id)) { seen.add(p.id); proxies.push(p); } }
        bad.push(...r.bad);
    }

    const byId = new Map(proxies.map(p => [p.id, p]));
    const out = { proxies, byId, bad, scheme, fileError, source: cfg.file || (cfg.list.length ? 'config.list' : null) };
    POOL_MEMO = { key, pool: out };
    return out;
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

// Главная функция модуля. Ответы читать строго по контракту из шапки.
//
//   { ok:true,  proxy:null, direct:true } — пул не настроен/выключен на этом хосте
//   { ok:true,  proxy:{…}, how:'sticky'|'new' } — идти через него
//   { ok:false, error }                   — назначен и мёртв → НЕ ХОДИТЬ ВООБЩЕ
async function forAccount(key, { host = null, force = false, usePreflight = true, preflightPath = DEFAULT_PREFLIGHT_PATH } = {}) {
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
    } else {
        proxy = leastLoaded(p.proxies, doc.assign);
        how = 'new';
        writeAssign(k, { proxy: proxy.id, at: nowIso(), why: 'первичное назначение' });
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

    return { ok: true, proxy, how, key: k };
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
    let proxy;
    if (proxyId) {
        proxy = p.byId.get(String(proxyId)) || null;
        if (!proxy) return { ok: false, error: `${proxyId} нет в пуле` };
    } else {
        const doc = loadAssign();
        delete doc.assign[k];                       // себя в расчёт нагрузки не берём
        proxy = leastLoaded(p.proxies, doc.assign);
    }
    writeAssign(k, { proxy: proxy.id, at: nowIso(), why: 'назначено вручную' });
    forgetHealth(proxy.id);
    return { ok: true, proxy };
}

// Сводка для дашборда и регресса. Кредов не печатаем: label их не содержит.
function describe() {
    const cfg = config();
    const p = pool();
    const assign = assignments();
    const load = new Map(p.proxies.map(x => [x.id, 0]));
    let orphans = 0;
    for (const v of Object.values(assign)) {
        if (!v || !v.proxy) continue;
        if (load.has(v.proxy)) load.set(v.proxy, load.get(v.proxy) + 1);
        else orphans++;
    }
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
        load: [...load.entries()].map(([id, n]) => ({ id, accounts: n })),
    };
}

// Сброс мемо — для регресса, который меняет env между проверками.
function _reset() { CFG_MEMO = null; POOL_MEMO = null; HEALTH.clear(); }

module.exports = {
    // разбор
    parseProxy, parseList, loadFile, schemeFromFilename, SCHEMES,
    // конфиг и пул
    config, enabled, enabledForHost, pool, describe,
    CONFIG_FILE, DEFAULT_ASSIGN_FILE,
    // сеть
    tunnel, tunnelKind, httpTunnel, socksTunnel, agentFor, fetchVia,
    preflight, preflightVerdict, health, forgetHealth,
    // липкость
    stickyKey, forAccount, assignments, assignmentFor, release, reassign, leastLoaded,
    // служебное
    _reset,
};
