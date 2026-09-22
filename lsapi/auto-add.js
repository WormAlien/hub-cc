// lsapi/auto-add.js
//
// Авторег аккаунтов Lingshu · 灵枢 AI (`lsapi.cloud`). **Чистый HTTP, без браузера** —
// копия `aikeysapi/auto-add.js`, от которой взята и архитектура, и вся обвязка (ящики,
// OTP, прокси-пул, durable-запись, маркеры этапов).
//
// Контракт снят ЖИВОЙ ПРОБОЙ 2026-09-21 (аккаунт id 3519, прогон от ящика до ключа
// целиком, `logs/lsapi-autoadd.log`), а не выведен из «панель тоже New API»:
//
//   GET  /api/status                     → turnstile_check=false, email_verification=true
//   GET  /api/verification?email=        → {success:true}, письмо за ~8 с
//   POST /api/user/register?turnstile=   → {success:true}, БЕЗ автологина
//   POST /api/user/login?turnstile=      → кука `session` + data.id
//   POST /api/token/                     → {success:true}, ключа в ответе НЕТ
//   GET  /api/token/?p=1&size=10         → ключ ЗАМАСКИРОВАН (`BpU6**********a20A`)
//   POST /api/token/<id>/key             → полный ключ (48 символов)
//   GET  /api/user/self                  → quota 0, inviter_id 3499 (реф-кредит владельцу)
//
// 🔴 **ГЛАВНОЕ ОТЛИЧИЕ ОТ ZhiFlow, ради которого этот файл и существует.** Приглашённому
// за регистрацию НЕ ДАЮТ НИЧЕГО: `quota = 0` (замер 21.09). Деньги капают НА ОСНОВНОЙ
// аккаунт владельца - $2 за каждого приведённого плюс 10% с его пополнений. То есть
// авторега здесь не «заводит по $5 на акк», а **крутит счётчик рефералов главного аккаунта**,
// и сами аккаунты пула пустые, пока владелец не переведёт на них деньги.
// Отсюда две вещи, которых нет у ZhiFlow: `granted`/`balance` у свежего аккаунта честный
// ноль (не считай это поломкой пейджа), а ценность имеет КОЛИЧЕСТВО прогонов, не их качество.
//
// 🔑 Ключ в пул пишется как `sk-` + отданное панелью. Панель принимает обе формы (замер:
// голый `BpU6…` и `sk-BpU6…` одинаково живые и на `Authorization: Bearer`, и на `x-api-key`;
// мусорный префикс `zz-` отбивает 401 - это контроль). Форма со `sk-` выбрана потому, что её
// показывает сам ЛК, её же вставляют руками, и на ней работает общий `isRealKey()` репозитория.
// Голый ключ вкладка сочла бы заглушкой и навсегда оставила аккаунт в `no_key` - ровно то,
// что у ZhiFlow лечили собственной `akIsRealKey()` в восьми местах. Здесь правка не нужна.
//
// 🪤 `?turnstile=` в пути - ПУСТОЙ параметр, как у ZhiFlow: капчи нет
// (`turnstile_check=false`), но фронт панели дописывает его ко всем трём ручкам. Форму
// запроса повторили по аналогу и проверили живьём - регистрация прошла.
//
// 🪤 Заголовок `New-Api-User: <id>` обязателен после логина, до логина - `-1`.
//
// 🪤 Ключ добывается ТОЛЬКО `POST /api/token/<id>/key`: в списке маска, при создании в
// ответе одно `{success:true}`. Грабуля та же, что у WisdomSatan и ZhiFlow.
//
// ПОЧТА
// -----
// Живое письмо (проба 21.09):
//   from:    `灵枢 AI` - ДИСПЛЕЙ-ИМЯ, БЕЗ адреса вовсе
//   subject: `灵枢 AI邮箱验证邮件`
//   body:    您好，你正在进行灵枢 AI邮箱验证。 您的验证码为: 592292
//
// 🪤 Якорь `您的验证码为` тот же, что у ZhiFlow, но код здесь - **6 ЦИФР**, а не
// алфавитно-цифровые шесть. Регулярка покрывает обе формы, менять её не нужно.
// 🪤 Письмо только на китайском, фильтр по адресу отправителя невозможен (адреса нет) -
// признак панели ищется по бренду в любом поле (`灵枢` / `lingshu`).
//
// ПРОКСИ
// ------
// Через ОБЩИЙ пул `routing/lib/proxy-pool.js`, включается точечно на `lsapi.cloud`
// в `routing/proxy-pool.json`. Пул включён и пуст либо прокси мёртв → НЕ идём напрямую,
// а падаем: тихий уход на домашний IP - тот самый провал freemodel.
//
// Использование:
//   node lsapi/auto-add.js [count]
//     --no-proxy      работать с домашнего IP явно (пул при этом не спрашиваем)
//     --dry-run       прогнать всё, кроме записи в пул
//     --keep-mail     не гасить ящик после успеха (для отладки писем)
//
// Результат: аккаунты дописываются в `routing/lsapi-sessions.json` (мерж-запись),
// лог - `logs/lsapi-autoadd.log`, последняя строка stdout - `LS_AUTOADD_RESULT {json}`
// для дашборда.
//
// Коды возврата: 0 создан хоть один · 2 панель закрыла регистрацию · 3 логин ·
//   4 ключ · 5 рейт-лимит · 6 прокси · 7 не создано ни одного · 8 почта · 1 прочее.

'use strict';

// Панель отдаёт ключ БЕЗ префикса (48 символов), но принимает и `sk-` + его же (замер
// 21.09: обе формы живые и на Bearer, и на x-api-key, а мусорный префикс отбивает 401).
// В пул пишем форму со `sk-`: её показывает сам ЛК, её же вставляют руками, и на ней
// работает общий isRealKey() репозитория. Голый ключ вкладка сочла бы заглушкой и
// навсегда оставила аккаунт в `no_key` — ровно то, что у ZhiFlow лечили своей akIsRealKey.
function withSkPrefix(k) {
    const s = String(k || '').trim();
    if (!s) return s;
    return s.startsWith('sk-') ? s : 'sk-' + s;
}

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
// Durable-запись пула: temp + fsync + rename. Авторег заводит аккаунты, ради которых
// пул и существует, — потерять их при BSOD нельзя.
const { writeJsonSync: durableWriteJson } = require('../routing/lib/durable-write');

const HOST = 'lsapi.cloud';
const POOL_FILE = path.join(__dirname, '..', 'routing', 'lsapi-sessions.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'lsapi-autoadd.log');

const PASS_MIN = 8;
const PASS_MAX = 20;        // жёсткий предел панели New API, не наш вкус
const USER_MAX = 20;
const RATE_RETRIES = 3;
const RATE_BASE_MS = 20000;
const REQ_TIMEOUT_MS = 45000;
const GAP_MS = 3500;        // пауза между аккаунтами: CriticalRateLimit на регистрации
const OTP_TIMEOUT_MS = 180000;
const OTP_POLL_MS = 3000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch { /* лог не должен ронять авторег */ }
}

// ───────────────────────────── маркер этапа для дашборда ─────────────────────────────
//
// Человекочитаемые строки лога («✓ код …», «✓ зарегистрирован») для человека годятся, а
// для индикатора в UI — нет: формулировки правятся, и парсер русского текста однажды
// молча соврёт, показав не тот этап. Поэтому этап едет ОТДЕЛЬНОЙ машиночитаемой строкой
// — ровно тем же приёмом, что уже работает для итога (`LS_AUTOADD_RESULT {json}`).
//
// 🪤 В файл лога эту строку НЕ пишем: она служебная, для stdout-контракта с бэкендом.
// В `logs/lsapi-autoadd.log` человек читает обычные строки.
const STAGES = ['mail', 'otp_wait', 'wait_proxy', 'register', 'login', 'token', 'key', 'self'];

function stage(name, { i, count, note } = {}) {
    const payload = { stage: name };
    if (i != null) payload.i = i;
    if (count != null) payload.count = count;
    if (note) payload.note = note;
    console.log('LS_STAGE ' + JSON.stringify(payload));
}

// Реф-код — из общей точки, а не литералом (см. routing/lib/ref-codes.js).
function affCode() {
    try { return require('../routing/lib/ref-codes.js').code('lsapi') || ''; }
    catch { return ''; }
}

// ───────────────────────────── юзерагенты ─────────────────────────────
//
// 🪤 UA генерируется ОДИН НА АККАУНТ и держится на всех его запросах. Смена агента между
// register и login — это сессия, у которой посреди жизни поменялся браузер.
//
// 🪤 Генератор строится один раз: у пакета дорого строится ФИЛЬТР, а не выборка.

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

// Client hints — ТОЛЬКО для Chrome и выведены из той же строки UA. Safari и Firefox их не
// отправляют вовсе; приписать значило бы создать противоречие внутри одного отпечатка.
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
        try { return String(uaGen().toString()); } catch { /* пакет сломался — запасной */ }
    }
    return UA_FALLBACK[crypto.randomInt(UA_FALLBACK.length)];
}

// ───────────────────────────── HTTP к панели ─────────────────────────────

// Заголовки повторяют живую запись браузера владельца. `New-Api-User: -1` до логина —
// именно то, что посылает фронт Lingshu (видно в записи у /api/status и /api/verification).
function panel(method, urlPath, { body, cookie, userId, agent, ua } = {}) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const agentStr = ua || UA_FALLBACK[0];
    const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'User-Agent': agentStr,
        ...clientHints(agentStr),
        'Origin': `https://${HOST}`,
        'Referer': `https://${HOST}/`,
        'New-Api-User': String(userId == null ? -1 : userId),
    };
    if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
    }
    if (cookie) headers['Cookie'] = cookie;

    return new Promise(resolve => {
        const req = https.request({
            host: HOST, port: 443, method, path: urlPath, headers,
            agent, timeout: REQ_TIMEOUT_MS,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* панель могла отдать HTML от WAF */ }
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
        log(`   ⏳ ${label}: 429 → ретрай ${i + 2}/${RATE_RETRIES} через ${waitMs / 1000} с`);
        await sleep(waitMs);
    }
    return last;
}

// 🪤 Кука `session` у Lingshu длинная base64; резать надо по `;` КАЖДОЙ куки отдельно,
// а не склеенную строку из `headers['set-cookie']` — иначе разбор `name=value` врёт.
const cookieHeader = setCookie =>
    (setCookie || []).map(c => String(c).split(';')[0]).filter(Boolean).join('; ');

// ───────────────────────────── креды ─────────────────────────────

const ADJ = ['swift', 'keen', 'calm', 'lucky', 'nova', 'mint', 'pine', 'iris', 'onyx', 'echo'];
const NOUN = ['fox', 'wolf', 'bird', 'hare', 'owl', 'koi', 'lynx', 'moth', 'apex', 'lake'];
const pick = a => a[crypto.randomInt(a.length)];

function randomUsername() {
    return `${pick(ADJ)}${pick(NOUN)}${crypto.randomBytes(3).toString('hex')}`.slice(0, USER_MAX);
}

// 18 символов — внутри 8..20 панели, с гарантией цифры, строчной и заглавной: панель
// проверяет длину, а состав нет, но пароль потом вводят руками в ЛК через 🌐.
function randomPassword() {
    const body = crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 15);
    const pass = `${body}a7Q`;
    if (pass.length < PASS_MIN || pass.length > PASS_MAX) {
        throw new Error(`битый генератор пароля: ${pass.length} символов`);
    }
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

// Мерж-ДОПИСЫВАНИЕ, а не запись целиком: дашборд пишет этот же файл после сетевых сканов,
// и целая запись снесла бы аккаунт, заведённый в это окно (гонка, поймана в AIPM).
// Запись через общий durable-хелпер: temp + fsync + rename. Прежняя версия делала
// temp+rename без fsync — при BSOD данные оставались в page cache и файл оказывался
// нулями при живом inode (инцидент 13.09, дважды за день).
function poolAppend(records) {
    const disk = poolLoad();
    const haveKeys = new Set(disk.map(s => s.api_key).filter(Boolean));
    const fresh = records.filter(r => !haveKeys.has(r.api_key));
    if (!fresh.length) return 0;
    durableWriteJson(POOL_FILE, disk.concat(fresh));
    return fresh.length;
}

function poolPatch(apiKey, patch) {
    const disk = poolLoad();
    const i = disk.findIndex(s => s.api_key === apiKey);
    if (i < 0) throw new Error('сохранённый аккаунт не найден');
    disk[i] = { ...disk[i], ...patch };
    durableWriteJson(POOL_FILE, disk);
}

async function checkSavedBalance(rec) {
    const url = `http://127.0.0.1:8200/__switch/api/ls/balance?api_key=${encodeURIComponent(rec.api_key)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== 'live') throw new Error(data.error || data.status || `HTTP ${res.status}`);
    poolPatch(rec.api_key, {
        status: data.status, balance: data.balance, spent: data.spent,
        granted: data.granted, balanceSource: data.balanceSource,
        balanceCheckedAt: new Date().toISOString(), balanceError: null,
    });
    return data;
}

// ───────────────────────────── почта и OTP ─────────────────────────────
//
// Живое письмо (запись 12.09, акк lsba5d7e76):
//   from:    noreply@lsapi.cloud
//   subject: Lingshu &middot; 灵枢AI邮箱验证邮件
//   body:    您好，你正在进行Lingshu · 灵枢AI邮箱验证。 您的验证码为: cac613
//            验证码 10 分钟内有效，如果不是本人操作，请忽略。
//
// 🪤 Письмо ТОЛЬКО на китайском, английского варианта панель не присылает. Ключевая
// якорная фраза — `您的验证码为` («ваш код подтверждения»), двоеточие может быть
// полноширинным (`：`) или обычным, пробелы вокруг плавают.

// Первичный regex — по якорю письма. Резервный — 6 алфанумериков подряд, но ТОЛЬКО
// внутри письма от панели (см. isPanelMail): иначе ловится `Random` из приветствия
// guerrillamail, поймано живьём при записи.
const OTP_ANCHORED = /(?:验证码为|验证码是|verification code(?:\s+is)?)\s*[:：]?\s*([A-Za-z0-9]{6})\b/i;
const OTP_LOOSE = /\b([A-Za-z0-9]{6})\b/;

// Письмо от панели. Смотрим НЕ только на адрес отправителя.
//
// 🪤 У разных ящиков одно и то же письмо выглядит по-разному: guerrillamail отдаёт
// `noreply@lsapi.cloud`, а instanttempemail — только ДИСПЛЕЙ-ИМЯ `Lingshu · 灵枢AI`,
// без адреса вовсе. Фильтр по `@lsapi.cloud` молча выбрасывал письмо, оно лежало в
// ящике, а авторег ждал код три минуты и падал «код не пришёл». Поймано живьём 12.09.
//
// Поэтому признак — бренд панели в любом из полей, а служебное письмо guerrillamail
// отсекается явно по отправителю.
const PANEL_BRAND_RE = /lingshu|灵枢|lsapi/i;
const NOISE_FROM_RE = /@guerrillamail\.com|@guerrilla/i;

function isPanelMail(from, subject, body) {
    if (NOISE_FROM_RE.test(String(from || ''))) return false;
    return PANEL_BRAND_RE.test(`${from || ''} ${subject || ''}`);
}

function extractOtp(body) {
    // HTML-теги и html-энтити письма мешают якорю — снимаем до поиска.
    const text = String(body || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&middot;/gi, '·')
        .replace(/&[a-z#0-9]+;/gi, ' ');
    const m = OTP_ANCHORED.exec(text);
    if (m) return m[1];
    const loose = OTP_LOOSE.exec(text);
    return loose ? loose[1] : null;
}

// Ящик. Порядок попыток — по замерам 12.09: guerrillamail быстрее всех (300 мс), но у
// него бывают окна, когда TLS-хендшейк рвётся со станции (поймано живьём: TCP до
// 93.90.93.22:443 открыт, а secure-соединение не встаёт — тогда падал ВЕСЬ авторег на
// первом же шаге). Поэтому цепочка: guerrillamail → instanttempemail → mail.tm.
//
// 🪤 У всех трёх РАЗНЫЙ интерфейс (guerrilla — класс, остальные — функции), поэтому
// каждая обёртка отдаёт единый вид `{ addr, poll(), sid }`, а не «как получилось».
const MAIL_TIMEOUT_MS = 25000;

function withTimeout(promise, ms, label) {
    let t;
    const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: таймаут ${ms} мс`)), ms); });
    return Promise.race([promise, guard]).finally(() => clearTimeout(t));
}

async function makeGuerrilla() {
    const { GuerrillaInbox } = require('../freemodel/lib/guerrillamail.js');
    const inbox = new GuerrillaInbox();
    await inbox.create();
    // Своя локальная часть: дефолтный адрес guerrilla иногда уже засвечен у сервисов.
    const local = 'ls' + crypto.randomBytes(3).toString('hex');
    const addr = await inbox.setUser(local);
    return {
        addr, sid: inbox.sidToken,
        async poll() {
            const list = await inbox.checkNew();
            const out = [];
            for (const m of list) {
                const full = await inbox.fetchEmail(m.mail_id);
                out.push({ from: m.mail_from, subject: m.mail_subject, body: full.mail_body || '' });
            }
            return out;
        },
    };
}

async function makeInstantTemp() {
    const ite = require('../freemodel/lib/instanttempemail.js');
    const box = await ite.createEmail();
    return {
        addr: box.address, sid: box.token,
        async poll() {
            const emails = await ite.fetchInbox(box.token);
            return emails.map(e => ({
                from: String(e.from || e.sender || ''),
                subject: String(e.subject || ''),
                body: ite.emailToText(e),
            }));
        },
    };
}

async function makeMailTm() {
    const mtm = require('../freemodel/lib/mailtm.js');
    const box = await mtm.createEmail();
    return {
        addr: box.address, sid: box.token,
        async poll() {
            const emails = await mtm.fetchInbox(box.token);
            const out = [];
            for (const meta of emails) {
                let full = meta;
                try { full = await mtm.fetchMessage(box.token, meta.id); } catch { /* заголовков хватит */ }
                out.push({
                    from: String(meta.from?.address || meta.from || ''),
                    subject: String(meta.subject || ''),
                    body: mtm.emailToText(full),
                });
            }
            return out;
        },
    };
}

// Порядок = цена ошибки, а не рейтинг провайдера. `makeInbox` возвращает ПЕРВЫЙ
// удавшийся ящик, поэтому мёртвый провайдер в начале списка платится на КАЖДОМ
// аккаунте: у guerrillamail сейчас рвётся TLS-хендшейк, и он съедал 25 с из 48 с
// прогона (замер 12.09), а на пачке из трёх — 75 с.
//
// 🪤 guerrillamail стоял первым по замеру «300 мс», который больше не воспроизводится:
// сервис лежит. Держать его впереди «на случай, если оживёт» — значит платить таймаут
// за всех и всегда. В хвосте списка он сохраняет роль фолбэка: когда первые два не
// завелись, попытка всё ещё стоит своих 25 с.
const MAIL_PROVIDERS = [
    { name: 'instanttempemail', make: makeInstantTemp },
    { name: 'mail.tm', make: makeMailTm },
    { name: 'guerrillamail', make: makeGuerrilla },
];

async function makeInbox() {
    const errors = [];
    for (const p of MAIL_PROVIDERS) {
        try {
            const box = await withTimeout(p.make(), MAIL_TIMEOUT_MS, p.name);
            log(`   ✓ ящик ${box.addr} (${p.name})`);
            return box;
        } catch (e) {
            errors.push(`${p.name}: ${e.message}`);
            log(`   ⚠️ ${p.name} не подошёл — ${e.message}`);
        }
    }
    throw new Error(`ни один ящик не завёлся → ${errors.join(' | ')}`);
}

// Ждём письмо ОТ ПАНЕЛИ и достаём код. Провайдер уже отфильтровал свои служебные письма.
async function waitOtp(box, { timeoutMs = OTP_TIMEOUT_MS, pollMs = OTP_POLL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    while (Date.now() < deadline) {
        let mails = [];
        try { mails = await box.poll(); }
        catch (e) { log(`   ⚠️ почта: ${e.message}`); }
        // Разбираем только НОВЫЕ письма: одна и та же пачка не должна крутиться вечно.
        for (const m of mails.slice(seen)) {
            if (!isPanelMail(m.from, m.subject)) continue;
            const code = extractOtp(m.body);
            if (code) return { code, subject: m.subject };
            log(`   ⚠️ письмо от панели пришло, кода не нашёл: ${String(m.body).replace(/\s+/g, ' ').slice(0, 200)}`);
        }
        seen = Math.max(seen, mails.length);
        await sleep(pollMs);
    }
    return null;
}

// ───────────────────────────── один аккаунт ─────────────────────────────

const CLOSED_RE = /закрыт|禁止|not allowed|disabled|关闭|已关闭|未开放/i;

// Всё, что панель говорит про занятость адреса/имени — не повод падать: на следующем
// аккаунте будут другие креды. Отличаем от настоящих отказов, чтобы не жечь код выхода 2.
const TAKEN_RE = /已存在|已被使用|已注册|exists|taken|occupied/i;

async function createOne(index, { noProxy, count }) {
    const username = randomUsername();
    const password = randomPassword();
    const aff = affCode();
    const ua = nextUserAgent();               // один агент на весь жизненный цикл аккаунта
    const at = (name, note) => stage(name, { i: index, count, note });

    // 1. Ящик. Создаём ПЕРВЫМ и напрямую: guerrillamail/instanttempemail — внешние
    // сервисы, к панели отношения не имеют, и прокси им не нужен. Зато адрес нужен
    // запросу кода, а привязка прокси — по адресу (см. acquireProxyFor).
    at('mail');
    let box;
    try { box = await makeInbox(); }
    catch (e) { return { ok: false, code: 8, why: `ящик не создан: ${e.message}` }; }
    const addr = box.addr;

    // 2. Прокси — свой на каждый аккаунт, привязанный к его адресу.
    const got = await acquireProxyFor(addr, { noProxy: !!noProxy, index, count });
    if (got.error) return { ok: false, code: 6, why: got.error };
    const { agent } = got;
    const net = { agent, ua };

    log(`[${index}] ${username} · ${got.proxyLabel}`);
    log(`   UA ${ua.slice(0, 78)}${ua.length > 78 ? '…' : ''}`);

    // 2. Запрос кода на почту. `?turnstile=` пустым — байт в байт как фронт (запись 12.09).
    // 🪤 Повтор на УЖЕ занятый адрес отвечает «занят» — это оракул «аккаунт существует»,
    // а не ошибка сети.
    const ver = await retryOnRate('verification', () => panel(
        'GET', `/api/verification?email=${encodeURIComponent(addr)}&turnstile=`, net));
    if (!ver.json || ver.json.success !== true) {
        const msg = (ver.json && ver.json.message) || ver.error || `HTTP ${ver.status}`;
        if (CLOSED_RE.test(msg) && !TAKEN_RE.test(msg)) {
            return { ok: false, code: 2, why: `панель закрыла регистрацию: ${msg}` };
        }
        return { ok: false, code: 8, why: `verification: ${msg}` };
    }
    log('   ✓ код запрошен, жду письмо');

    // 3. Код с почты. В записи письмо шло 17 с; ждём до 3 минут.
    at('otp_wait');
    const otp = await waitOtp(box);
    if (!otp) return { ok: false, code: 8, why: `код не пришёл за ${OTP_TIMEOUT_MS / 1000} с` };
    log(`   ✓ код ${otp.code}`);

    // 4. Регистрация. `password2` панель на сервере не проверяет (его там нет), но фронт
    // его посылает — воспроизводим состав тела из записи целиком, включая пустой
    // `wechat_verification_code`.
    at('register');
    const reg = await retryOnRate('register', () => panel('POST', '/api/user/register?turnstile=', {
        body: {
            username,
            password,
            password2: password,
            email: addr,
            verification_code: otp.code,
            wechat_verification_code: '',
            aff_code: aff,
        },
        ...net,
    }));
    if (reg.status === 429) return { ok: false, code: 5, why: 'рейт-лимит на регистрации' };
    if (!reg.json || reg.json.success !== true) {
        const msg = (reg.json && reg.json.message) || reg.error || `HTTP ${reg.status}`;
        if (CLOSED_RE.test(msg) && !TAKEN_RE.test(msg)) {
            return { ok: false, code: 2, why: `панель закрыла регистрацию: ${msg}` };
        }
        return { ok: false, code: 7, why: `register: ${msg}` };
    }
    log('   ✓ зарегистрирован');

    // 5. Логин. Регистрация сессию НЕ ставит — это отдельный запрос (проверено записью).
    at('login');
    const login = await retryOnRate('login', () => panel('POST', '/api/user/login?turnstile=', {
        body: { username, password }, ...net,
    }));
    if (!login.json || login.json.success !== true || !login.json.data || !login.json.data.id) {
        const msg = (login.json && login.json.message) || login.error || `HTTP ${login.status}`;
        return { ok: false, code: 3, why: `login: ${msg}` };
    }
    const uid = login.json.data.id;
    const cookie = cookieHeader(login.setCookie);
    if (!cookie) return { ok: false, code: 3, why: 'login: панель не поставила куку session' };
    const auth = { cookie, userId: uid, ...net };
    log(`   ✓ вход, id=${uid}`);

    // 6. Токен. Состав тела — из записи. `name` непустым, `group: ''` = группа аккаунта.
    //
    // Имя уникально для аккаунта (`cc_<username>`): по нему токен находится ТОЧНО, без
    // угадывания. Это важно, потому что панель могла завести и дефолтный токен.
    const tokenName = `cc_${username}`;
    at('token');

    // 🪤 Снимаем id существующих токенов ДО создания: выбирать «самый свежий» по
    // created_time нельзя — при совпадении секунды или параллельном токене заберём чужой
    // (доработка №1 из разбора WisdomSatan).
    const before = await panel('GET', '/api/token/?p=1&size=100', auth);
    const beforeIds = new Set(
        (((before.json || {}).data || {}).items || []).map(t => t.id));

    const mk = await retryOnRate('token', () => panel('POST', '/api/token/', {
        body: {
            name: tokenName,
            remain_quota: 0,
            remain_amount: 0,
            expired_time: -1,
            unlimited_quota: true,
            model_limits_enabled: false,
            model_limits: '',
            cross_group_retry: false,
            group: '',
            allow_ips: '',
        },
        ...auth,
    }));
    if (!mk.json || mk.json.success !== true) {
        return { ok: false, code: 4, why: `token create: ${(mk.json && mk.json.message) || `HTTP ${mk.status}`}` };
    }

    // 7. Найти СВОЙ токен. Два независимых признака, в порядке надёжности:
    //    1) по имени, которое мы только что задали — не зависит от пагинации и диффа;
    //    2) по id, которого не было в списке до создания — запасной путь.
    //
    // 🪤 «Своего токена не нашли» раньше могло значить и «запрос списка не удался»:
    // пустой ответ и отсутствие токена выглядели одинаково. Поэтому падение называет
    // HTTP-статус и то, сколько записей реально пришло.
    //
    // 🪤 Панель создаёт токен НЕ мгновенно: сразу после POST список может прийти пустым.
    // Пара коротких повторов дешевле потерянного аккаунта (он уже зарегистрирован).
    let mine = null;
    let lastSeen = -1;
    for (let attempt = 0; attempt < 3 && !mine; attempt++) {
        if (attempt) await sleep(1500);
        const after = await panel('GET', '/api/token/?p=1&size=100', auth);
        if (!after.json || after.json.success !== true) {
            log(`   ⚠️ список токенов: HTTP ${after.status}${after.error ? ` (${after.error})` : ''}`);
            continue;
        }
        const items = ((after.json.data || {}).items) || [];
        lastSeen = items.length;
        mine = items.find(t => t.name === tokenName)
            || items.find(t => !beforeIds.has(t.id));
    }
    if (!mine || !mine.id) {
        return { ok: false, code: 4, why: `token list: своего токена не нашли (в списке ${lastSeen < 0 ? 'запрос не прошёл' : lastSeen + ' шт.'}, имя ${tokenName})` };
    }

    // 8. Полный ключ — ТОЛЬКО этим запросом. В списке маска (`bKmg**********ogd9`).
    at('key');
    const keyRes = await panel('POST', `/api/token/${mine.id}/key`, { body: {}, ...auth });
    const rawKey = ((keyRes.json || {}).data || {}).key;
    if (!rawKey || rawKey.includes('*') || rawKey.length < 20) {
        return { ok: false, code: 4, why: `token key: получили ${rawKey ? 'маску' : `HTTP ${keyRes.status}`}` };
    }
    // ✅ В пул идёт `sk-` + отданное панелью (см. withSkPrefix в шапке): панель принимает
    // обе формы, но общий isRealKey() репозитория требует префикс, а голый ключ вкладка
    // сочла бы заглушкой и оставила аккаунт в `no_key`.
    const storedKey = withSkPrefix(rawKey);
    log(`   ✓ ключ добыт (${rawKey.length} символов, в пул со sk-)`);

    // 9. Профиль: квота и — главное — проверка реф-кредита.
    // 🪤 Ноль в inviter_id снаружи невидим: New API проглатывает ошибку резолва aff
    // (`inviterId, _ := model.GetUserIdByAffCode(affCode)`), регистрация всё равно success.
    at('self');
    const self = await panel('GET', '/api/user/self', auth);
    const d = (self.json || {}).data || {};
    const inviter = Number(d.inviter_id || 0);
    const quota = Number(d.quota || 0);
    if (aff && !inviter) {
        log(`   ⚠️  РЕФ-КРЕДИТ НЕ ЗАСЧИТАН: inviter_id=0 при aff_code=${aff}. Панель не ругается — проверь код`);
    } else if (inviter) {
        log(`   ✓ реф засчитан, inviter_id=${inviter}`);
    }
    // quota_per_unit у Lingshu 500 000 (замер: 2 500 000 = $5.00, подтверждено владельцем)
    log(`   ✓ квота ${quota} ($${(quota / 500000).toFixed(2)})`);

    return {
        ok: true,
        record: {
            id: `ls_${Date.now()}_${index}`,
            email: addr,
            name: username,
            password,
            api_key: storedKey,
            active: false,            // владение активным ключом ставит дашборд, не мы
            status: 'live',
            created: new Date().toISOString(),
            newApiUserId: uid,
            tokenId: mine.id,
            autoAdded: true,
            inviterId: inviter || null,
            grantQuota: quota || null,
            proxyUsed: agent ? got.proxyLabel : null,
            userAgent: ua,
            mailSid: box.sid,           // ящик ещё жив ~1 ч: пригодится для сброса пароля
            mailProvider: box.addr.split('@')[1] || null,
            sessionCookie: cookie,     // авторега уже залогинилась — баланс не должен ждать открытия ЛК
            sessionCookieAt: new Date().toISOString(),
            // Состояние входа для SPA (см. sessionStateFromCookie). В пул НЕ уходит —
            // main() снимает это поле сразу после записи снимка: в пуле это дубль
            // состояния браузера, а не свойство аккаунта.
            spaUser: d,
        },
    };
}

// ───────────────────────────── прокси через общий пул ─────────────────────────────
//
// Своей реализации туннелей здесь НЕТ намеренно: `routing/lib/proxy-pool.js` уже умеет
// CONNECT/SOCKS, preflight с TTL, липкую привязку и fail-closed. Дублировать значит
// заводить второй набор граблей.
//
// 🪤 Привязка по АККАУНТУ, а не по номеру слота. Причина найдена живым прогоном 12.09:
// слот переживает прогон, поэтому каждый следующий запуск сажал первый аккаунт на тот же
// самый адрес — `slot1` навсегда оставался за `185.200.188.234`. Для антифрода это хуже
// всего: десять прогонов подряд = десять аккаунтов с одного IP.
//
// Почему это вообще возможно здесь, хотя в цикле адрес нужен раньше аккаунта: ящик
// создаётся НАПРЯМУЮ (guerrillamail/instanttempemail — внешние сервисы, не панель),
// а прокси нужен только для запросов к Lingshu. Значит порядок можно развернуть:
// сначала email, потом прокси под него.
// 🎯 Решение владельца 12.09: пул опустел — ЖДЁМ прокси, а не теряем аккаунт.
//
// Публичные прокси живут минуты, а на вкладке работает фоновый докорм: пока мы ждём, он
// находит новые, и `pool()` подхватывает их по штампу mtime. Аккаунт к этому моменту уже
// оплачен ящиком (и часто регистрацией), поэтому подождать дешевле, чем потерять его.
//
// 🪤 Ждём только когда пул ПУСТ. Если прокси есть, но конкретный оказался мёртв, это
// обычный перебор — он остаётся быстрым (см. цикл в acquireProxyFor).
const PROXY_WAIT_MS = 5 * 60 * 1000;      // общий потолок ожидания на один аккаунт
const PROXY_WAIT_POLL_MS = 8000;

async function acquireProxyFor(email, { noProxy, index, count }) {
    if (noProxy) return { agent: undefined, proxyLabel: 'напрямую (--no-proxy)' };

    let pp;
    try { pp = require('../routing/lib/proxy-pool.js'); }
    catch (e) {
        return { error: `общий пул прокси не загрузился: ${e.message}. Нужен домашний IP — скажи --no-proxy` };
    }

    if (!pp.enabledForHost(HOST)) {
        return { agent: undefined, proxyLabel: `напрямую (пул выключен для ${HOST})` };
    }

    const key = `lsapi:${String(email).toLowerCase()}`;
    const tried = new Set();
    const deadline = Date.now() + PROXY_WAIT_MS;
    let r = await pp.forAccount(key, { host: HOST });
    let firstError = null;
    let announcedWait = false;

    for (let attempt = 0; attempt < 3 && !r.ok; attempt++) {
        if (!firstError) firstError = r.error;
        log(`   ⚠️ ${r.error}`);

        const cur = pp.assignmentFor(key);
        if (cur && cur.proxy) tried.add(cur.proxy);

        let others = pp.pool().proxies.filter(x => !tried.has(x.id));
        // Пул пуст — ждём докорма, а не сдаёмся. Отмечаем этапом, чтобы пауза была видна
        // в индикаторе: иначе прогон просто «зависает» без объяснения.
        while (!others.length && Date.now() < deadline) {
            if (!announcedWait) {
                announcedWait = true;
                stage('wait_proxy', { i: index, count, note: 'пул пуст' });
                log(`   ⏳ живых прокси нет — жду докорма пула (до ${Math.round(PROXY_WAIT_MS / 1000)} с)`);
            }
            await sleep(PROXY_WAIT_POLL_MS);
            others = pp.pool().proxies.filter(x => !tried.has(x.id));
        }
        if (!others.length) {
            return { error: `${firstError}; прокси в пуле так и не появились за ${Math.round(PROXY_WAIT_MS / 1000)} с (проверено ${tried.size})` };
        }

        // Нагрузку считаем без себя: свой слот в расчёт брать незачем.
        const assign = { ...pp.assignments() };
        delete assign[key];
        const next = pp.leastLoaded(others, assign);

        const re = pp.reassign(key, next.id);
        if (!re.ok) return { error: `${firstError}; переназначить не вышло: ${re.error}` };
        log(`   ↻ прокси аккаунта → ${re.proxy.label || re.proxy.id}`);

        r = await pp.forAccount(key, { host: HOST });
    }

    if (!r.ok) return { error: `${firstError || r.error}; перебор кандидатов не дал живого прокси` };
    if (!r.proxy) return { agent: undefined, proxyLabel: `напрямую (${r.reason || 'пул пуст по конфигу'})` };

    return {
        agent: pp.agentFor(r.proxy),
        proxyLabel: r.proxy.label || r.proxy.id || 'прокси',
    };
}

// ───────────────────────────── main ─────────────────────────────

function parseArgs(argv) {
    const a = { count: 1, noProxy: false, dry: false };
    for (let i = 2; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--no-proxy') a.noProxy = true;
        else if (t === '--dry-run') a.dry = true;
        else if (/^\d+$/.test(t)) a.count = Math.max(1, Number(t));
    }
    return a;
}

async function main() {
    const args = parseArgs(process.argv);
    log(`🚀 авторег Lingshu: ${args.count} акк${args.count > 1 ? '.' : ''}${args.dry ? ' (--dry-run)' : ''}`);
    if (args.noProxy) {
        log('🏠 --no-proxy: работаю с домашнего IP. POST /api/user/register под CriticalRateLimit —');
        log('   поток регистраций с одного адреса упрётся в 429');
    }

    const created = [];
    const failed = [];
    let lastCode = 7;
    let written = 0;

    for (let i = 1; i <= args.count; i++) {
        let res;
        try { res = await createOne(i, { noProxy: args.noProxy, count: args.count }); }
        catch (e) { res = { ok: false, code: 1, why: `исключение: ${e.message}` }; }

        if (res.ok) {
            created.push(res.record);
            // Пишем каждый успешный аккаунт сразу: длинный прогон может быть прерван
            // на следующем аккаунте, и уже добытый ключ нельзя оставлять только в памяти.
            if (!args.dry) {
                const rec = { ...res.record };
                try {
                    const f = writeProfileSession(rec.id, rec.sessionCookie, rec.spaUser);
                    if (f) log(`   ✓ снимок ЛК для ${rec.email} (${path.basename(f)})`);
                } catch (e) {
                    const why = `персистенция ${rec.email}: снимок ЛК не записан: ${e.message}`;
                    failed.push(why);
                    log(`   ⚠️ ${why}`);
                }
                delete rec.spaUser;   // состояние SPA — не поле записи пула
                try {
                    const n = poolAppend([rec]);
                    written += n;       // poolAppend возвращает 0 для дубля
                    if (n) log(`   ✓ аккаунт ${rec.email} записан в пул`);
                    else log(`   · аккаунт ${rec.email} уже был в пуле (дубль)`);
                } catch (e) {
                    const why = `персистенция ${rec.email}: аккаунт создан, но пул не записан: ${e.message}`;
                    failed.push(why);
                    log(`   ❌ ${why}`);
                }
                try {
                    const balance = await checkSavedBalance(rec);
                    // 🪤 «$5.00» здесь - это РЕЗЕРВ ПРИКИДКИ, а не деньги: гранта за
                    // регистрацию у lsapi нет вовсе (quota 0, замер 21.09), и точно цифра
                    // станет известна только из /api/user/self. Печатаем источник - иначе
                    // строка читается как «аккаунт с деньгами» и уводит владельца.
                    const exact = balance.balanceSource === 'self';
                    log(`   ${exact ? '✓' : '≈'} баланс ${rec.email}: $${Number(balance.balance || 0).toFixed(2)}`
                        + (exact ? '' : ' (прикидка, не деньги — гранта у панели нет)'));
                } catch (e) {
                    const why = `баланс ${rec.email}: ${e.message}`;
                    failed.push(why);
                    try { poolPatch(rec.api_key, { balanceError: e.message, balanceCheckedAt: new Date().toISOString() }); } catch (patchError) { log(`   ⚠️ ${patchError.message}`); }
                    log(`   ⚠️ ${why}`);
                }
            }
        } else {
            failed.push(res.why);
            // Регистрация закрыта — остальные попытки бессмысленны. Отказ прокси — нет:
            // это беда конкретного адреса, следующий аккаунт получит другой.
            if (res.code === 2) break;
        }
        if (i < args.count) await sleep(GAP_MS);
    }

    if (args.dry) log(`🧪 --dry-run: в пул не пишу (${created.length} готово)`);

    log(`Итого: создано ${created.length}, записано в пул ${written}, ошибок ${failed.length}`);
    if (written) {
        log('🪤 Активировать аккаунт кнопкой на вкладке — из скрипта active не ставим.');
    }

    // Гасим индикатор этапа: без терминального маркера UI застрял бы на последнем
    // пройденном шаге и показывал «self» уже завершённого прогона.
    stage('done', { i: args.count, count: args.count });

    // Последняя строка stdout — контракт с дашбордом.
    console.log('LS_AUTOADD_RESULT ' + JSON.stringify({
        created: created.length,
        written,
        failed: failed.length,
        errors: failed.slice(0, 5),
        accounts: created.map(r => ({
            id: r.id, email: r.email, username: r.name,
            inviterId: r.inviterId, grantQuota: r.grantQuota,
        })),
    }));

    process.exit(created.length ? 0 : lastCode);
}

if (require.main === module) {
    main().catch(e => {
        log(`❌ ${e.stack || e.message}`);
        console.log('LS_AUTOADD_RESULT ' + JSON.stringify({ created: 0, written: 0, failed: 1, errors: [e.message] }));
        process.exit(1);
    });
}

// ───────────────────────────── cookie-снимок профиля ─────────────────────────────
//
// Кнопка 🌐 ЛК (`open-session.js`) на ЧИСТОМ профиле умеет применить готовый снимок
// `sessions/<label>.json` и открыть консоль уже залогиненной. Метка профиля —
// `acct_<id записи пула>` (см. handleAkSessionOpen), значит снимок надо положить
// ровно под этим именем — иначе первый вход потребует ручного ввода пароля.
//
// 🪤 Значение куки берём СЫРЫМ (`session=…` → `…`): Playwright хранит name и value
// раздельно, и «session=session=…» он примет как значение с мусором внутри.

// Снимок состояния входа для кнопки 🌐.
//
// 🪤 ОДНОЙ КУКИ НЕ ХВАТАЕТ, и это неочевидно: панель Lingshu — SPA на New API, и она
// держит признак «я вошёл» в localStorage (`user`), а куку посылает лишь как транспорт.
// С кукой, но с пустым localStorage, `/console` отдаёт ФОРМУ ВХОДА — ровно так снимок и
// выглядел сломанным, хотя авторизация на уровне API работала (`/api/user/self` → 200).
//
// Замер 12.09 (headless, аккаунт `dponbfuz05@fpklm.com`):
//   только кука        → ЛОГИН
//   кука + user в LS   → КОНСОЛЬ, «pinelynx688760»
//
// Поэтому `user` (ответ `/api/user/self`) кладём в `origins[].localStorage` — в том же
// формате, который уже читает `applyImportedSession` в open-session.js.
function sessionStateFromCookie(cookieHeaderStr, user) {
    const first = String(cookieHeaderStr || '').split(';')[0].trim();
    const eq = first.indexOf('=');
    if (eq < 0) return null;
    const name = first.slice(0, eq);
    const value = first.slice(eq + 1);
    if (!name || !value) return null;
    const origins = (user && typeof user === 'object') ? [{
        origin: `https://${HOST}`,
        localStorage: [{ name: 'user', value: JSON.stringify(user) }],
    }] : [];
    return {
        cookies: [{
            name, value,
            domain: HOST, path: '/',
            expires: -1, httpOnly: false, secure: true, sameSite: 'Lax',
        }],
        origins,
    };
}

function writeProfileSession(recordId, cookieHeaderStr, user) {
    const state = sessionStateFromCookie(cookieHeaderStr, user);
    if (!state) return null;
    const dir = path.join(__dirname, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `acct_${recordId}.json`);
    // durable: снимок сессии — то, чем потом ходят за балансом. Нулёвка после BSOD
    // выглядела бы как «кука пропала» и увела бы на полный релогин.
    durableWriteJson(file, state);
    return file;
}

module.exports = {
    HOST, POOL_FILE, STAGES,
    panel, retryOnRate, cookieHeader, clientHints, nextUserAgent,
    randomUsername, randomPassword, affCode,
    poolLoad, poolAppend,
    extractOtp, isPanelMail, stage, makeInbox, MAIL_PROVIDERS,
    sessionStateFromCookie, writeProfileSession,
    _internals: { PASS_MIN, PASS_MAX, USER_MAX, OTP_TIMEOUT_MS, OTP_POLL_MS, GAP_MS },
};
