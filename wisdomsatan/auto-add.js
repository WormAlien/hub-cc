// wisdomsatan/auto-add.js
//
// Авторег аккаунтов api.wisdomsatan.club. **Чистый HTTP, без браузера вообще** — первый
// такой авторег для шлюза в этом репозитории (у остальных Playwright/Camoufox, потому что
// там капча и/или GitHub-OAuth).
//
// Почему так можно. Замер `/api/status` 2026-09-10: `turnstile_check=false` (капчи нет),
// `email_verification=false` (почту не подтверждает), `github_oauth=false` и все прочие
// OAuth выключены — живой путь один, логин+пароль. Аккаунт заводится четырьмя запросами:
//
//   POST /api/user/register        → {success:true}, БЕЗ автологина и без сессии
//   POST /api/user/login           → кука `session` + data.id
//   POST /api/token/               → {success:true}, ключа в ответе НЕТ
//   POST /api/token/<id>/key       → полный 48-символьный ключ
//   GET  /api/user/self            → квота, aff_code, inviter_id (проверка реф-кредита)
//
// 🪤 Ключ добывается ТОЛЬКО последним запросом. `GET /api/token/` и `GET /api/token/<id>`
// отдают его замаскированным (`4YJY**********q3ep`), а `POST /api/token/` при создании не
// возвращает ничего кроме `{success:true}`. Наивная схема «создать и прочитать из списка»
// принесёт маску — это стоило часа при разведке.
//
// 🪤 Заголовок `New-Api-User: <id>` обязателен в КАЖДОМ запросе к панели после логина,
// иначе 401 «не предоставлен New-Api-User». Куки одной мало.
//
// 🪤 Пароль ограничен 8–20 символами (`validate:"min=8,max=20"`, model/user.go тега
// v0.11.5). Двадцать один символ панель отвергнет с невнятным `Field validation for
// 'Password' failed on the 'min' tag`. Генератор ниже держится в этих границах.
//
// 🪤 `display_name` панель принимает и ВЫБРАСЫВАЕТ (перезаписывает на username), а
// `password2` на сервере не существует вовсе — проверка только во фронте. Не тратим поля.
//
// 🪤 Реф-кредит проверяем по факту: у заведённого аккаунта `inviter_id` обязан быть
// НЕнулевым. Ноль означает, что `aff_code` не сработал, и снаружи это никак не видно —
// регистрация всё равно вернёт success (в New API ошибка резолва aff проглатывается,
// controller/user.go: `inviterId, _ := model.GetUserIdByAffCode(affCode)`).
//
// ПРОКСИ
// ------
// `POST /api/user/register` висит под `middleware.CriticalRateLimit()`, то есть поток
// регистраций с одного IP упрётся в 429. Отсюда поддержка пула прокси с ротацией — по
// одному прокси на аккаунт, round-robin.
//
// 🔴 Если прокси запрошен и не работает — скрипт ПАДАЕТ, а не идёт напрямую. Это не
// перестраховка: в `freemodel/freemodel_autoreger_v3.js:119` `parseProxy()` принимает
// только `http(s)://`, а на строке `socks5://…` молча возвращает `null`, после чего
// авторег уходит с домашнего IP и никто об этом не узнаёт. Здесь такого пути нет.
//
// Прокси проверяется ДО первой регистрации: preflight'ом на `GET /api/status` (публичный,
// аккаунт не тратится). Не прошёл — прокси выбрасывается из пула, а не «попробуем на живом».
//
// Использование:
//   node wisdomsatan/auto-add.js [count]
//     --proxy <url>          один прокси: http://[user:pass@]host:port, socks5://…, socks4://…
//     --proxy-file <path>    файл, по прокси на строку
//     --proxy-scheme <s>     схема для строк без неё (дефолт http) — под формат
//                            `export/protocols/socks5.txt` инструмента-скрапера,
//                            где протокол несёт ИМЯ ФАЙЛА, а строки голые `ip:port`
//     --no-proxy             явно разрешить работу с домашнего IP (иначе с прокси-флагами
//                            несовместимо; без флагов прокси и так не используется)
//     --dry-run              прогнать всё, кроме записи в пул
//
// Результат: аккаунты дописываются в routing/wisdomsatan-sessions.json (мерж-запись,
// см. §pool), лог — logs/wisdomsatan-autoadd.log, последняя строка stdout —
// `WS_AUTOADD_RESULT {json}` для дашборда.
//
// Коды возврата: 0 хоть один аккаунт создан · 2 панель закрыла регистрацию ·
//   3 логин не прошёл после регистрации · 4 ключ не добыт · 5 выбило рейт-лимитом ·
//   6 прокси непригодны · 7 не создано ни одного · 1 прочее.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
// Durable-запись пула: temp + fsync + rename.
const { writeJsonSync: durableWriteJson } = require('../routing/lib/durable-write');

const HOST = 'api.wisdomsatan.club';
const POOL_FILE = path.join(__dirname, '..', 'routing', 'wisdomsatan-sessions.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'wisdomsatan-autoadd.log');

// Реф-код — из общей точки, а не литералом (см. routing/lib/ref-codes.js).
function affCode() {
    try { return require('../routing/lib/ref-codes.js').code('wisdomsatan') || ''; }
    catch { return ''; }
}

const PASS_MIN = 8;
const PASS_MAX = 20;      // жёсткий предел панели, не наш вкус
const USER_MAX = 20;
const RATE_RETRIES = 3;
const RATE_BASE_MS = 20000;
const REQ_TIMEOUT_MS = 45000;
const GAP_MS = 3000;      // пауза между аккаунтами: CriticalRateLimit на регистрации

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch {}
}

// ───────────────────────────── прокси ─────────────────────────────

// Принимаем и полный URL, и голый `ip:port` (формат export/protocols/*.txt скрапера,
// где протокол несёт имя файла). Возвращаем нормализованное описание или null.
function parseProxy(raw, defScheme) {
    const s = String(raw || '').trim();
    if (!s || s.startsWith('#')) return null;
    const withScheme = /^[a-z0-9]+:\/\//i.test(s) ? s : `${defScheme}://${s}`;
    let u;
    try { u = new URL(withScheme); } catch { return null; }
    const scheme = u.protocol.replace(':', '').toLowerCase();
    if (!['http', 'https', 'socks', 'socks4', 'socks5'].includes(scheme)) return null;
    if (!u.hostname || !u.port) return null;
    return {
        raw: s,
        scheme,
        hostname: u.hostname,
        port: Number(u.port),
        user: u.username ? decodeURIComponent(u.username) : '',
        pass: u.password ? decodeURIComponent(u.password) : '',
        label: `${scheme}://${u.hostname}:${u.port}`,
    };
}

// HTTP(S)-прокси: CONNECT-туннель руками. Зависимостей не нужно, а `https-proxy-agent`
// в дереве нет — ставить пакет ради 30 строк незачем.
function httpTunnel(proxy, host, port) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (proxy.user || proxy.pass) {
            headers['Proxy-Authorization'] =
                'Basic ' + Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');
        }
        const req = http.request({
            host: proxy.hostname, port: proxy.port, method: 'CONNECT',
            path: `${host}:${port}`, headers, timeout: 20000,
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
        timeout: 20000,
    }).then(info => info.socket);
}

function tunnel(proxy, host, port) {
    return proxy.scheme === 'http' || proxy.scheme === 'https'
        ? httpTunnel(proxy, host, port)
        : socksTunnel(proxy, host, port);
}

// Агент, у которого соединение идёт через туннель. keepAlive выключен намеренно: на
// публичных прокси переиспользование сокета живёт хуже, чем новый CONNECT.
function agentFor(proxy) {
    if (!proxy) return new https.Agent({ keepAlive: false });
    const a = new https.Agent({ keepAlive: false });
    a.createConnection = (options, cb) => {
        const host = options.host || options.hostname;
        const port = Number(options.port) || 443;
        tunnel(proxy, host, port).then(sock => {
            const t = tls.connect({ socket: sock, servername: host });
            t.once('secureConnect', () => cb(null, t));
            t.once('error', e => cb(e));
        }).catch(e => cb(e));
        return undefined;
    };
    return a;
}

// ───────────────────────────── юзерагенты ─────────────────────────────
//
// Пакет `user-agents` (intoli): выборка из снимка РЕАЛЬНОГО трафика за последние сутки,
// взвешенная по частоте, релиз каждый день. Один захардкоженный UA на все аккаунты — это
// общий отпечаток; в этом репозитории он к тому же протух (`Chrome/131` литералом в
// десяти файлах freemodel/ourtoken при живом 152).
//
// 🪤 UA генерируется ОДИН НА АККАУНТ и держится на всех его запросах. Сменить агента
// между register и login — это сессия, у которой посреди жизни поменялся браузер.
//
// 🪤 Генератор создаётся один раз и переиспользуется: у пакета дорого строится ФИЛЬТР,
// а не сама выборка — повторные вызовы быстрее сотни первых.
let uaGen = null;
try {
    const UserAgent = require('user-agents');
    uaGen = new UserAgent({ deviceCategory: 'desktop' });
} catch {
    log('⚠️  пакета user-agents нет — беру запасной список. `npm i user-agents` вернёт живые');
}

const UA_FALLBACK = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
];

// Client hints шлём ТОЛЬКО для Chrome и выводим из той же строки UA. Safari и Firefox
// их не отправляют вовсе, и приписать их — противоречие внутри одного отпечатка.
function clientHints(ua) {
    const m = /Chrome\/(\d+)/.exec(ua);
    if (!m || /Firefox/.test(ua)) return {};
    const v = m[1];
    const plat = /Windows/.test(ua) ? 'Windows'
        : /Macintosh/.test(ua) ? 'macOS'
        : /Linux|X11/.test(ua) ? 'Linux' : 'Windows';
    return {
        'sec-ch-ua': `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not_A Brand";v="24"`,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': `"${plat}"`,
    };
}

function nextUserAgent() {
    if (uaGen) {
        try { return String(uaGen().toString()); } catch {}
    }
    return UA_FALLBACK[crypto.randomInt(UA_FALLBACK.length)];
}

// ───────────────────────────── HTTP к панели ─────────────────────────────

// 🪤 Голый curl на Windows к этому хосту зависает в петле TLS-ренеготиации (schannel).
// Node ходит через OpenSSL и такого не ловит — но если будешь перепроверять руками,
// бери python/urllib, а не curl.
function panel(method, urlPath, { body, cookie, userId, proxy, ua } = {}) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const agentStr = ua || UA_FALLBACK[0];
    const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': agentStr,
        ...clientHints(agentStr),
        'Origin': `https://${HOST}`,
        'Referer': `https://${HOST}/`,
    };
    if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
    }
    if (cookie) headers['Cookie'] = cookie;
    if (userId) headers['New-Api-User'] = String(userId);

    return new Promise(resolve => {
        const req = https.request({
            host: HOST, port: 443, method, path: urlPath, headers,
            agent: agentFor(proxy), timeout: REQ_TIMEOUT_MS,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch {}
                resolve({
                    status: res.statusCode,
                    json,
                    text,
                    setCookie: res.headers['set-cookie'] || [],
                });
            });
        });
        req.once('timeout', () => req.destroy(new Error('таймаут запроса')));
        req.once('error', e => resolve({ status: 0, json: null, text: '', setCookie: [], error: e.message }));
        if (payload) req.write(payload);
        req.end();
    });
}

// 429 — ждём и повторяем, с логом, чтобы не выглядело зависшим.
async function retryOnRate(label, fn) {
    let last;
    for (let i = 0; i < RATE_RETRIES; i++) {
        last = await fn();
        if (last.status !== 429) return last;
        const waitMs = RATE_BASE_MS * (i + 1);
        log(`   ⏳ ${label}: 429 → ретрай ${i + 2}/${RATE_RETRIES} через ${waitMs / 1000}с`);
        await sleep(waitMs);
    }
    return last;
}

const cookieHeader = setCookie =>
    (setCookie || []).map(c => String(c).split(';')[0]).filter(Boolean).join('; ');

// ───────────────────────────── креды ─────────────────────────────

const ADJ = ['swift', 'keen', 'calm', 'lucky', 'nova', 'mint', 'pine', 'iris', 'onyx', 'echo'];
const NOUN = ['fox', 'wolf', 'bird', 'hare', 'owl', 'koi', 'lynx', 'moth', 'apex', 'lake'];
const pick = a => a[crypto.randomInt(a.length)];

function randomUsername() {
    const u = `${pick(ADJ)}${pick(NOUN)}${crypto.randomBytes(3).toString('hex')}`;
    return u.slice(0, USER_MAX);
}

// Ровно 18 символов — внутри 8..20 панели, с гарантией цифры, строчной и заглавной:
// панель длину проверяет, а состав нет, но пусть пароль будет приличным и там, где его
// потом руками вводят в ЛК.
function randomPassword() {
    const body = crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 15);
    const pass = `${body}a7Q`;
    if (pass.length < PASS_MIN || pass.length > PASS_MAX) throw new Error(`битый генератор пароля: ${pass.length} символов`);
    return pass;
}

// ───────────────────────────── пул ─────────────────────────────

function poolLoad() {
    try {
        const raw = fs.readFileSync(POOL_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

// Мерж-ДОПИСЫВАНИЕ, а не запись целиком. Причина не гипотетическая: дашборд пишет этот
// же файл после сетевых сканов, и целая запись сносит аккаунт, заведённый в это окно —
// ровно та гонка, которую в AIPM уже ловили (см. apSaveMerge в transparent-proxy.js).
// Дедуп по api_key: повторный прогон не должен плодить дубли.
// Запись через общий durable-хелпер: temp + fsync + rename. Здесь была САМАЯ опасная
// форма — прямая запись в целевой файл без временного: BSOD посреди неё оставлял пул
// нулями при живом inode, что и случилось с AR/JW 13.09.
function poolAppend(records) {
    const disk = poolLoad();
    const haveKeys = new Set(disk.map(s => s.api_key).filter(Boolean));
    const fresh = records.filter(r => !haveKeys.has(r.api_key));
    if (!fresh.length) return 0;
    durableWriteJson(POOL_FILE, disk.concat(fresh));
    return fresh.length;
}

// ───────────────────────────── один аккаунт ─────────────────────────────

const CLOSED_RE = /закрыт|禁止|not allowed|disabled|关闭/i;

async function createOne(index, proxy) {
    const username = randomUsername();
    const password = randomPassword();
    const aff = affCode();
    const ua = nextUserAgent();               // один агент на весь жизненный цикл аккаунта
    const tag = proxy ? proxy.label : 'напрямую';
    log(`[${index}] ${username} · ${tag}`);
    log(`   UA ${ua.slice(0, 78)}${ua.length > 78 ? '…' : ''}`);

    // 1. Регистрация. display_name и password2 не посылаем — панель их игнорирует.
    const reg = await retryOnRate('register', () => panel('POST', '/api/user/register', {
        body: { username, password, email: '', verification_code: '', aff_code: aff },
        proxy, ua,
    }));
    if (reg.status === 429) return { ok: false, code: 5, why: 'рейт-лимит на регистрации' };
    if (!reg.json || reg.json.success !== true) {
        const msg = (reg.json && reg.json.message) || reg.error || `HTTP ${reg.status}`;
        if (CLOSED_RE.test(msg)) return { ok: false, code: 2, why: `панель закрыла регистрацию: ${msg}` };
        return { ok: false, code: 7, why: `register: ${msg}` };
    }
    log(`   ✓ зарегистрирован`);

    // 2. Логин. Регистрация сессию НЕ ставит — это отдельный запрос.
    const login = await retryOnRate('login', () => panel('POST', '/api/user/login', {
        body: { username, password }, proxy, ua,
    }));
    if (!login.json || login.json.success !== true || !login.json.data || !login.json.data.id) {
        return { ok: false, code: 3, why: `login: ${(login.json && login.json.message) || login.error || `HTTP ${login.status}`}` };
    }
    const uid = login.json.data.id;
    const cookie = cookieHeader(login.setCookie);
    if (!cookie) return { ok: false, code: 3, why: 'login: панель не поставила куку session' };
    const auth = { cookie, userId: uid, proxy, ua };
    log(`   ✓ вход, id=${uid}`);

    // 3. Токен. В ответе ключа нет — только success.
    const mk = await retryOnRate('token', () => panel('POST', '/api/token/', {
        body: {
            name: 'cc', remain_quota: 500000, expired_time: -1, unlimited_quota: true,
            model_limits_enabled: false, model_limits: '', allow_ips: '', group: 'default',
        },
        ...auth,
    }));
    if (!mk.json || mk.json.success !== true) {
        return { ok: false, code: 4, why: `token create: ${(mk.json && mk.json.message) || `HTTP ${mk.status}`}` };
    }

    // 4. Найти id своего токена. Панель могла завести ещё и дефолтный
    // («<username>的初始令牌», если включён GenerateDefaultToken) — берём самый свежий.
    const list = await panel('GET', '/api/token/?p=0&size=50', auth);
    const items = (list.json && list.json.data && (list.json.data.items || list.json.data)) || [];
    const mine = (Array.isArray(items) ? items : [])
        .slice()
        .sort((a, b) => (b.created_time || 0) - (a.created_time || 0))[0];
    if (!mine || !mine.id) return { ok: false, code: 4, why: 'token list: своего токена не нашли' };

    // 5. Полный ключ — ТОЛЬКО этим запросом (см. шапку).
    const keyRes = await panel('POST', `/api/token/${mine.id}/key`, { body: {}, ...auth });
    const rawKey = keyRes.json && keyRes.json.data && keyRes.json.data.key;
    if (!rawKey || rawKey.includes('*') || rawKey.length < 32) {
        return { ok: false, code: 4, why: `token key: получили ${rawKey ? 'маску' : `HTTP ${keyRes.status}`}` };
    }
    const apiKey = `sk-${rawKey}`;
    log(`   ✓ ключ добыт (${rawKey.length} символов)`);

    // 6. Профиль: квота и — главное — проверка реф-кредита.
    const self = await panel('GET', '/api/user/self', auth);
    const d = (self.json && self.json.data) || {};
    const inviter = Number(d.inviter_id || 0);
    const quota = Number(d.quota || 0);
    if (aff && !inviter) {
        log(`   ⚠️  РЕФ-КРЕДИТ НЕ ЗАСЧИТАН: inviter_id=0 при aff_code=${aff}. Панель не ругается — проверь код`);
    } else if (inviter) {
        log(`   ✓ реф засчитан, inviter_id=${inviter}`);
    }
    log(`   ✓ квота ${quota} (${(quota / 500000).toFixed(2)} у.е.)`);

    return {
        ok: true,
        record: {
            id: `ws_${Date.now()}_${index}`,
            email: username,          // пул использует поле email как логин
            name: username,
            api_key: apiKey,
            password,
            active: false,            // владение активным ключом ставит дашборд, не мы
            status: 'live',
            created: new Date().toISOString(),
            newApiUserId: uid,
            autoAdded: true,
            inviterId: inviter || null,
            grantQuota: quota || null,
            proxyUsed: proxy ? proxy.label : null,
            userAgent: ua,
        },
    };
}

// ───────────────────────────── main ─────────────────────────────

function parseArgs(argv) {
    const a = { count: 1, proxy: null, proxyFile: null, scheme: 'http', noProxy: false, dry: false };
    for (let i = 2; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--proxy') a.proxy = argv[++i];
        else if (t === '--proxy-file') a.proxyFile = argv[++i];
        else if (t === '--proxy-scheme') a.scheme = String(argv[++i] || 'http').toLowerCase();
        else if (t === '--no-proxy') a.noProxy = true;
        else if (t === '--dry-run') a.dry = true;
        else if (/^\d+$/.test(t)) a.count = Math.max(1, Number(t));
    }
    return a;
}

// Проверка прокси ДО регистраций: публичный /api/status, аккаунт не тратится.
async function preflight(proxies) {
    const good = [];
    for (const p of proxies) {
        const t0 = Date.now();
        const r = await panel('GET', '/api/status', { proxy: p, ua: nextUserAgent() });
        const ms = Date.now() - t0;
        if (r.status === 200 && r.json && r.json.success) {
            log(`   ✓ ${p.label} — ${ms} мс`);
            good.push(p);
        } else {
            log(`   ✗ ${p.label} — ${r.error || `HTTP ${r.status}`} (${ms} мс), выбрасываю из пула`);
        }
    }
    return good;
}

async function main() {
    const args = parseArgs(process.argv);
    const wantProxy = !!(args.proxy || args.proxyFile);

    if (wantProxy && args.noProxy) {
        log('❌ --no-proxy несовместим с --proxy/--proxy-file');
        process.exit(1);
    }

    let proxies = [];
    if (wantProxy) {
        const lines = args.proxy
            ? [args.proxy]
            : fs.readFileSync(args.proxyFile, 'utf8').split(/\r?\n/);
        const bad = [];
        for (const l of lines) {
            if (!String(l).trim() || String(l).trim().startsWith('#')) continue;
            const p = parseProxy(l, args.scheme);
            if (p) proxies.push(p); else bad.push(String(l).trim());
        }
        if (bad.length) log(`⚠️  не разобрал ${bad.length} строк прокси, первая: ${bad[0]}`);
        // 🔴 Ни одной пригодной строки — падаем. Молча уйти напрямую нельзя.
        if (!proxies.length) {
            log('❌ прокси запрошены, но ни одна строка не разобрана. Напрямую НЕ пойду — это и есть');
            log('   тот самый тихий провал, из-за которого автореги уходили с домашнего IP.');
            log('   Нужен домашний IP — скажи это явно флагом --no-proxy.');
            process.exit(6);
        }
        log(`🔌 проверяю ${proxies.length} прокси на ${HOST}…`);
        proxies = await preflight(proxies);
        if (!proxies.length) {
            log('❌ ни один прокси не достучался до панели. Напрямую НЕ пойду (см. выше).');
            process.exit(6);
        }
        log(`🔌 живых прокси: ${proxies.length}`);
    } else {
        log(args.noProxy
            ? '🏠 работаю с домашнего IP (--no-proxy)'
            : '🏠 работаю с домашнего IP (прокси не заданы). Для потока регистраций дай --proxy-file:');
        if (!args.noProxy) log('   POST /api/user/register висит под CriticalRateLimit — с одного IP поток упрётся в 429');
    }

    const created = [];
    const failed = [];
    let lastCode = 7;

    for (let i = 1; i <= args.count; i++) {
        const proxy = proxies.length ? proxies[(i - 1) % proxies.length] : null;
        let res;
        try { res = await createOne(i, proxy); }
        catch (e) { res = { ok: false, code: 1, why: `исключение: ${e.message}` }; }

        if (res.ok) created.push(res.record);
        else {
            failed.push(res.why);
            lastCode = res.code;
            log(`   ✗ ${res.why}`);
            // Панель закрыла регистрацию — остальные попытки бессмысленны.
            if (res.code === 2) break;
        }
        if (i < args.count) await sleep(GAP_MS);
    }

    let written = 0;
    if (created.length && !args.dry) written = poolAppend(created);
    else if (args.dry) log(`🧪 --dry-run: в пул не пишу (${created.length} готово)`);

    log(`Итого: создано ${created.length}, записано в пул ${written}, ошибок ${failed.length}`);
    if (created.length) {
        log('Ключи добыты. 🪤 Активировать аккаунт кнопкой на вкладке — из скрипта active не ставим.');
    }

    // Последняя строка stdout — контракт с дашбордом.
    console.log('WS_AUTOADD_RESULT ' + JSON.stringify({
        created: created.length,
        written,
        failed: failed.length,
        errors: failed.slice(0, 5),
        proxies: proxies.length,
        accounts: created.map(r => ({ id: r.id, username: r.name, inviterId: r.inviterId, grantQuota: r.grantQuota })),
    }));

    process.exit(created.length ? 0 : lastCode);
}

main().catch(e => {
    log(`❌ ${e.stack || e.message}`);
    console.log('WS_AUTOADD_RESULT ' + JSON.stringify({ created: 0, written: 0, failed: 1, errors: [e.message] }));
    process.exit(1);
});
