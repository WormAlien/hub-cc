// aikeysapi/auto-add.js
//
// Авторег аккаунтов ZhiFlow · 智流AI (`www.aikeysapi.com`). **Чистый HTTP, без браузера** —
// второй такой авторег в репозитории после `wisdomsatan/auto-add.js`, от которого взята
// архитектура. Отличие принципиальное: здесь панель ТРЕБУЕТ подтверждение почты
// (`email_verification=true`), поэтому в цикл встроен одноразовый ящик.
//
// Контракт снят ЖИВОЙ ЗАПИСЬЮ регистрации владельца 2026-09-12 (`recordings/signup-*.jsonl`,
// акк `akiisz07`, id 147) — не выведен из поколения сборки:
//
//   GET  /api/status                     → turnstile_check=false, email_verification=true
//   GET  /api/verification?email=&turnstile=  → {success:true}, письмо ~17 с
//   POST /api/user/register?turnstile=   → {success:true}, БЕЗ автологина и без сессии
//   POST /api/user/login?turnstile=      → кука `session` + data.id
//   POST /api/token/                     → {success:true}, ключа в ответе НЕТ
//   GET  /api/token/?p=1&size=10         → ключ ЗАМАСКИРОВАН (`bKmg**********ogd9`)
//   POST /api/token/<id>/key             → полный ключ (48 символов)
//   GET  /api/user/self                  → quota 2 500 000 ($5), inviter_id (реф-кредит)
//
// 🪤 `?turnstile=` в пути — ПУСТОЙ параметр, и он есть в живой записи у всех трёх ручек
// (verification, register, login). Капчи нет (`turnstile_check=false`), но фронт всё равно
// дописывает параметр; воспроизводим байт в байт, чтобы не отличаться от браузера.
//
// 🪤 Ключ добывается ТОЛЬКО `POST /api/token/<id>/key`. В списке — маска, при создании в
// ответе одно `{success:true}`. Наивная схема «создать и прочитать из списка» даст маску:
// эта грабля уже стоила часа на WisdomSatan и подтвердилась здесь записью.
//
// 🪤 Ключи ZhiFlow НЕ начинаются с `sk-` (живой `bKmgS36…ogd9`, `ziUH…M09e`). Префикс
// дописывает клиент, и общий `isRealKey()` дашборда на этом спотыкался — во вкладке `ak`
// для этого своя `akIsRealKey()`. В пул пишем ключ КАК ЕСТЬ, без `sk-`: именно так лежит
// принятый вкладкой `probe_x9k2`, и переобувать формат посреди пула нельзя.
//
// 🪤 Заголовок `New-Api-User: <id>` обязателен в каждом запросе после логина. До логина
// фронт посылает `-1` — воспроизводим и это.
//
// 🪤 `POST /api/token/` требует поле `name` НЕПУСТЫМ (в записи `"1"`), а `group: ''`
// означает «группа аккаунта по умолчанию». Не подставлять `default`: у ZhiFlow группы
// зовутся по-своему (`Claude-Opus-系列`, `GPT Image2`), и `default` — не их имя.
//
// ПОЧТА
// -----
// guerrillamail (`freemodel/lib/guerrillamail.js`): ящик за 300 мс, письмо ZhiFlow пришло
// за ~17 с, фильтра доменов у панели нет. Код — 6 алфанумериков, живёт 10 минут.
//
// 🪤 Приветственное письмо самой guerrillamail («Welcome to Guerrilla Mail») приходит
// ПЕРВЫМ и содержит слово `Random` в позиции, куда попадает наивный `\b[A-Za-z0-9]{6}\b`.
// Поймано живьём при записи. Поэтому письма фильтруются по отправителю (`@aikeysapi.com`),
// а не только по регекспу кода.
//
// ПРОКСИ
// ------
// Через ОБЩИЙ пул `routing/lib/proxy-pool.js` (просьба владельца), а не своей реализацией:
// пул уже умеет CONNECT/SOCKS, preflight с TTL, липкую привязку «аккаунт → прокси» и
// fail-closed. Включается точечно на `www.aikeysapi.com` в `routing/proxy-pool.json`.
//
// 🔴 Пул включён и пуст либо назначенный прокси мёртв → НЕ идём напрямую, а падаем.
// Тихий уход на домашний IP — тот самый провал `freemodel` (`parseProxy()` возвращал null
// на `socks5://` и авторег уходил с домашнего адреса, никто не знал).
//
// Использование:
//   node aikeysapi/auto-add.js [count]
//     --no-proxy      работать с домашнего IP явно (пул при этом не спрашиваем)
//     --dry-run       прогнать всё, кроме записи в пул
//     --keep-mail     не гасить ящик после успеха (для отладки писем)
//
// Результат: аккаунты дописываются в `routing/aikeysapi-sessions.json` (мерж-запись),
// лог — `logs/aikeysapi-autoadd.log`, последняя строка stdout — `AK_AUTOADD_RESULT {json}`
// для дашборда.
//
// Коды возврата: 0 создан хоть один · 2 панель закрыла регистрацию · 3 логин ·
//   4 ключ · 5 рейт-лимит · 6 прокси · 7 не создано ни одного · 8 почта · 1 прочее.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const HOST = 'www.aikeysapi.com';
const POOL_FILE = path.join(__dirname, '..', 'routing', 'aikeysapi-sessions.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'aikeysapi-autoadd.log');

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

// Реф-код — из общей точки, а не литералом (см. routing/lib/ref-codes.js).
function affCode() {
    try { return require('../routing/lib/ref-codes.js').code('aikeysapi') || ''; }
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
// именно то, что посылает фронт ZhiFlow (видно в записи у /api/status и /api/verification).
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

// 🪤 Кука `session` у ZhiFlow длинная base64; резать надо по `;` КАЖДОЙ куки отдельно,
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
// Запись атомарная — temp + rename: падение процесса посреди writeFileSync обнуляло пул
// (доработка №2 из разбора WisdomSatan).
function poolAppend(records) {
    const disk = poolLoad();
    const haveKeys = new Set(disk.map(s => s.api_key).filter(Boolean));
    const fresh = records.filter(r => !haveKeys.has(r.api_key));
    if (!fresh.length) return 0;
    const dir = path.dirname(POOL_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.aikeysapi-sessions.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(disk.concat(fresh), null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, POOL_FILE);
    return fresh.length;
}

// ───────────────────────────── почта и OTP ─────────────────────────────
//
// Живое письмо (запись 12.09, акк akiisz07):
//   from:    noreply@aikeysapi.com
//   subject: ZhiFlow &middot; 智流AI邮箱验证邮件
//   body:    您好，你正在进行ZhiFlow · 智流AI邮箱验证。 您的验证码为: cac613
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

function isPanelMail(from) {
    return /@aikeysapi\.com\s*$/i.test(String(from || '').trim());
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

// Ящик: guerrillamail — 300 мс на создание, письмо ZhiFlow пришло за ~17 с, фильтра
// доменов у панели нет (проверено emailinator-ом руками и guerrilla-ящиком в записи).
async function makeInbox() {
    const { GuerrillaInbox } = require('../freemodel/lib/guerrillamail.js');
    const inbox = new GuerrillaInbox();
    await inbox.create();
    // Своя локальная часть: дефолтный адрес guerrilla иногда уже засвечен у сервисов.
    const local = 'ak' + crypto.randomBytes(3).toString('hex');
    const addr = await inbox.setUser(local);
    return { inbox, addr };
}

// Ждём письмо ОТ ПАНЕЛИ и достаём код. Приветствие guerrillamail пропускаем по отправителю.
async function waitOtp(inbox, { timeoutMs = OTP_TIMEOUT_MS, pollMs = OTP_POLL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    const seen = new Set();
    while (Date.now() < deadline) {
        let list = [];
        try { list = await inbox.checkNew(); }
        catch (e) { log(`   ⚠️ почта: ${e.message}`); }
        for (const m of list) {
            if (seen.has(m.mail_id)) continue;
            seen.add(m.mail_id);
            if (!isPanelMail(m.mail_from)) continue;   // 🪤 не приветствие guerrillamail
            let full;
            try { full = await inbox.fetchEmail(m.mail_id); }
            catch (e) { log(`   ⚠️ чтение письма: ${e.message}`); continue; }
            const code = extractOtp(full.mail_body || '');
            if (code) return { code, subject: m.mail_subject };
            log(`   ⚠️ письмо от панели пришло, кода не нашёл: ${String(full.mail_body || '').replace(/\s+/g, ' ').slice(0, 200)}`);
        }
        await sleep(pollMs);
    }
    return null;
}

// ───────────────────────────── один аккаунт ─────────────────────────────

const CLOSED_RE = /закрыт|禁止|not allowed|disabled|关闭|已关闭|未开放/i;

// Всё, что панель говорит про занятость адреса/имени — не повод падать: на следующем
// аккаунте будут другие креды. Отличаем от настоящих отказов, чтобы не жечь код выхода 2.
const TAKEN_RE = /已存在|已被使用|已注册|exists|taken|occupied/i;

async function createOne(index, { agent, proxyLabel }) {
    const username = randomUsername();
    const password = randomPassword();
    const aff = affCode();
    const ua = nextUserAgent();               // один агент на весь жизненный цикл аккаунта
    const net = { agent, ua };
    log(`[${index}] ${username} · ${proxyLabel}`);
    log(`   UA ${ua.slice(0, 78)}${ua.length > 78 ? '…' : ''}`);

    // 1. Ящик. Создаём ДО запроса кода: адрес нужен в самом запросе.
    let inbox, addr;
    try { ({ inbox, addr } = await makeInbox()); }
    catch (e) { return { ok: false, code: 8, why: `ящик не создан: ${e.message}` }; }
    log(`   ✓ ящик ${addr}`);

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
    const otp = await waitOtp(inbox);
    if (!otp) return { ok: false, code: 8, why: `код не пришёл за ${OTP_TIMEOUT_MS / 1000} с` };
    log(`   ✓ код ${otp.code}`);

    // 4. Регистрация. `password2` панель на сервере не проверяет (его там нет), но фронт
    // его посылает — воспроизводим состав тела из записи целиком, включая пустой
    // `wechat_verification_code`.
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
    // 🪤 Снимаем id существующих токенов ДО создания: выбирать «самый свежий» по
    // created_time нельзя — при совпадении секунды или параллельном токене заберём чужой
    // (доработка №1 из разбора WisdomSatan).
    const before = await panel('GET', '/api/token/?p=1&size=100', auth);
    const beforeIds = new Set(
        (((before.json || {}).data || {}).items || []).map(t => t.id));

    const mk = await retryOnRate('token', () => panel('POST', '/api/token/', {
        body: {
            name: `cc${index}`,
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

    // 7. Найти СВОЙ токен: тот, чей id не существовал до создания.
    const after = await panel('GET', '/api/token/?p=1&size=100', auth);
    const items = ((after.json || {}).data || {}).items || [];
    const mine = items.find(t => !beforeIds.has(t.id));
    if (!mine || !mine.id) return { ok: false, code: 4, why: 'token list: своего токена не нашли' };

    // 8. Полный ключ — ТОЛЬКО этим запросом. В списке маска (`bKmg**********ogd9`).
    const keyRes = await panel('POST', `/api/token/${mine.id}/key`, { body: {}, ...auth });
    const rawKey = ((keyRes.json || {}).data || {}).key;
    if (!rawKey || rawKey.includes('*') || rawKey.length < 20) {
        return { ok: false, code: 4, why: `token key: получили ${rawKey ? 'маску' : `HTTP ${keyRes.status}`}` };
    }
    // 🪤 БЕЗ префикса `sk-`: ключи ZhiFlow его не имеют, и принятый вкладкой probe_x9k2
    // лежит в пуле как есть. Проверку делает akIsRealKey() в дашборде.
    log(`   ✓ ключ добыт (${rawKey.length} символов)`);

    // 9. Профиль: квота и — главное — проверка реф-кредита.
    // 🪤 Ноль в inviter_id снаружи невидим: New API проглатывает ошибку резолва aff
    // (`inviterId, _ := model.GetUserIdByAffCode(affCode)`), регистрация всё равно success.
    const self = await panel('GET', '/api/user/self', auth);
    const d = (self.json || {}).data || {};
    const inviter = Number(d.inviter_id || 0);
    const quota = Number(d.quota || 0);
    if (aff && !inviter) {
        log(`   ⚠️  РЕФ-КРЕДИТ НЕ ЗАСЧИТАН: inviter_id=0 при aff_code=${aff}. Панель не ругается — проверь код`);
    } else if (inviter) {
        log(`   ✓ реф засчитан, inviter_id=${inviter}`);
    }
    // quota_per_unit у ZhiFlow 500 000 (замер: 2 500 000 = $5.00, подтверждено владельцем)
    log(`   ✓ квота ${quota} ($${(quota / 500000).toFixed(2)})`);

    return {
        ok: true,
        record: {
            id: `ak_${Date.now()}_${index}`,
            email: addr,
            name: username,
            password,
            api_key: rawKey,
            active: false,            // владение активным ключом ставит дашборд, не мы
            status: 'live',
            created: new Date().toISOString(),
            newApiUserId: uid,
            tokenId: mine.id,
            autoAdded: true,
            inviterId: inviter || null,
            grantQuota: quota || null,
            proxyUsed: proxyLabel === 'напрямую' ? null : proxyLabel,
            userAgent: ua,
            mailSid: inbox.sidToken,   // ящик ещё жив ~1 ч: пригодится для сброса пароля
            sessionCookie: cookie,     // авторега уже залогинилась — баланс не должен ждать открытия ЛК
            sessionCookieAt: new Date().toISOString(),
        },
    };
}

// ───────────────────────────── прокси через общий пул ─────────────────────────────
//
// Своей реализации туннелей здесь НЕТ намеренно: `routing/lib/proxy-pool.js` уже умеет
// CONNECT/SOCKS, preflight с TTL, липкую привязку и fail-closed. Дублировать значит
// заводить второй набор граблей.
//
// 🪤 Липкая привязка по ключу `aikeysapi:<email>` невозможна: email рождается ВНУТРИ
// цикла аккаунта, а прокси нужен раньше — им и создаётся ящик. Поэтому ключ привязки —
// порядковый слот `aikeysapi:slot<N>`: он стабилен между прогонами, значит один и тот же
// слот всегда садится на тот же прокси, а разные аккаунты одного прогона разъезжаются
// по разным IP. Это и есть то, что нужно против антифрода.

// 🪤 Липкость слота отличается от липкости АККАУНТА, и это принципиально. У живого
// аккаунта смена IP заметнее пропущенного чека, поэтому пул на мёртвый назначенный прокси
// отвечает отказом и другой не подставляет — это правильно. Но слот занимается ДО того,
// как аккаунт создан: за ним ещё никто не стоит, менять нечему. Поймано живым прогоном
// 12.09 — прокси умер между двумя запусками, и слот оказался заперт навсегда при восьми
// живых прокси в пуле.
//
// Поэтому: слот с мёртвым прокси переназначается на ДРУГОЙ (перебор до 3 кандидатов), и
// только если живых не осталось — отказ. Аккаунт при этом ещё не существует, так что ни
// одна сессия не «переезжает» на другой IP.
//
// 🪤 Кандидат выбирается СВОИМ least-loaded по отфильтрованному списку, а не голым
// `pp.reassign(key)`. Причина: `leastLoaded()` при равной нагрузке возвращает `proxies[0]`,
// а мёртвый прокси стоит в `stable.txt` первым (список отсортирован по p50, и самый
// быстрый успел умереть). Голый reassign возвращал ровно тот же адрес — поймано прогоном.
async function acquireProxy(slot, { noProxy }) {
    if (noProxy) return { agent: undefined, proxyLabel: 'напрямую (--no-proxy)' };

    let pp;
    try { pp = require('../routing/lib/proxy-pool.js'); }
    catch (e) {
        return { error: `общий пул прокси не загрузился: ${e.message}. Нужен домашний IP — скажи --no-proxy` };
    }

    if (!pp.enabledForHost(HOST)) {
        return { agent: undefined, proxyLabel: `напрямую (пул выключен для ${HOST})` };
    }

    const key = `aikeysapi:slot${slot}`;
    const tried = new Set();
    let r = await pp.forAccount(key, { host: HOST });
    let firstError = null;

    for (let attempt = 0; attempt < 3 && !r.ok; attempt++) {
        if (!firstError) firstError = r.error;
        log(`   ⚠️ ${r.error}`);

        const cur = pp.assignmentFor(key);
        if (cur && cur.proxy) tried.add(cur.proxy);

        const p = pp.pool();
        const others = p.proxies.filter(x => !tried.has(x.id));
        if (!others.length) {
            return { error: `${firstError}; живых прокси в пуле не осталось (проверено ${tried.size})` };
        }

        // Нагрузку считаем без себя: свой слот в расчёт брать незачем.
        const assign = { ...pp.assignments() };
        delete assign[key];
        const next = pp.leastLoaded(others, assign);

        const re = pp.reassign(key, next.id);
        if (!re.ok) return { error: `${firstError}; переназначить не вышло: ${re.error}` };
        log(`   ↻ слот${slot} → ${re.proxy.label || re.proxy.id}`);

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
    log(`🚀 авторег ZhiFlow: ${args.count} акк${args.count > 1 ? '.' : ''}${args.dry ? ' (--dry-run)' : ''}`);
    if (args.noProxy) {
        log('🏠 --no-proxy: работаю с домашнего IP. POST /api/user/register под CriticalRateLimit —');
        log('   поток регистраций с одного адреса упрётся в 429');
    }

    const created = [];
    const failed = [];
    let lastCode = 7;

    for (let i = 1; i <= args.count; i++) {
        const got = await acquireProxy(i, args);
        if (got.error) {
            log(`❌ ${got.error}`);
            log('   Напрямую НЕ пойду — это и есть тот тихий провал, из-за которого автореги');
            log('   уходили с домашнего IP. Нужен домашний адрес — скажи явно --no-proxy.');
            failed.push(got.error);
            lastCode = 6;
            break;
        }

        let res;
        try { res = await createOne(i, got); }
        catch (e) { res = { ok: false, code: 1, why: `исключение: ${e.message}` }; }

        if (res.ok) {
            created.push(res.record);
        } else {
            failed.push(res.why);
            lastCode = res.code;
            log(`   ✗ ${res.why}`);
            if (res.code === 2) break;      // регистрация закрыта — остальные попытки бессмысленны
        }
        if (i < args.count) await sleep(GAP_MS);
    }

    let written = 0;
    if (created.length && !args.dry) written = poolAppend(created);
    else if (args.dry) log(`🧪 --dry-run: в пул не пишу (${created.length} готово)`);

    log(`Итого: создано ${created.length}, записано в пул ${written}, ошибок ${failed.length}`);
    if (written) {
        log('🪤 Активировать аккаунт кнопкой на вкладке — из скрипта active не ставим.');
    }

    // Последняя строка stdout — контракт с дашбордом.
    console.log('AK_AUTOADD_RESULT ' + JSON.stringify({
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
        console.log('AK_AUTOADD_RESULT ' + JSON.stringify({ created: 0, written: 0, failed: 1, errors: [e.message] }));
        process.exit(1);
    });
}

module.exports = {
    HOST, POOL_FILE,
    panel, retryOnRate, cookieHeader, clientHints, nextUserAgent,
    randomUsername, randomPassword, affCode,
    poolLoad, poolAppend,
    extractOtp, isPanelMail,
    _internals: { PASS_MIN, PASS_MAX, USER_MAX, OTP_TIMEOUT_MS, OTP_POLL_MS, GAP_MS },
};
