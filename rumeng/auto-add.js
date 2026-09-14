// rumeng/auto-add.js
//
// Авторег аккаунтов **如梦AI · Rumeng** (`api.rumeng-ai.com`). Архитектура скопирована с
// `aikeysapi/auto-add.js` (пул прокси, sticky-привязка, `stage()`, мерж-запись пула,
// коды возврата), но **это ГИБРИД**, а не чистый HTTP, и три места сломаны по сравнению
// с образцом.
//
// ─────────────────────────── ТРИ ОТЛИЧИЯ ОТ ZhiFlow ───────────────────────────
//
// 1. 🔴 **JWT, а не кука.** `POST /auth/register` СРАЗУ отдаёт `access_token` +
//    `refresh_token` + `expires_in` + `user` плоским объектом (без обёртки `data`).
//    Логин отдельным запросом НЕ НУЖЕН — он тут страховка, а не шаг.
//    Все последующие запросы — `Authorization: Bearer <access_token>`.
//    Снимок для кнопки 🌐 — это НЕ куки, а четыре ключа в `localStorage`, и имена в них
//    НЕ совпадают с именами полей API: токен зовётся `auth_token`, не `access_token`
//    (разбор — у writeProfileSession). Снимок пишет `refresh-sessions.js`, не мы.
//
// 2. 🔴 **База `/api/v1`, а не `/api`.**
//
// 3. 🔴 **Группа при создании ключа ОБЯЗАТЕЛЬНА.** Владелец проверил живьём: «создать»
//    без выбранной группы даёт ошибку, ключ не создаётся. Поэтому цикл всегда сначала
//    `GET /groups/available`, и только потом `POST /keys` с `group_id`.
//
// Чего у rumeng НЕТ (проверено `GET /settings/public`): реф-программы (`affiliate_enabled`
// = false), капчи (`turnstile_enabled` = false), инвайтов, промокодов, лимитов панели.
//
// ─────────────────────────── КОНТРАКТ API (из бандла SPA) ───────────────────────────
//
// Разобран `assets/RegisterView-*.js`, `EmailVerifyView-*.js`, `AppHeader.vue_*.js`
// (клиент ключей) и `groups-*.js` — это код самой панели, не догадки:
//
//   GET  /settings/public                 → без авторизации; флаги + вайтлист суффиксов
//   POST /auth/send-verify-code  {email}  → 200 {"code":0,…,"data":{"countdown":60}}
//   POST /auth/register  {email,password,verify_code,…} → JWT
//   POST /auth/login     {email,password}              → JWT
//   GET  /auth/me                         → профиль
//   GET  /groups/available                → список групп (нужен id для ключа)
//   POST /keys  {name, group_id, …}       → создаёт ключ
//   GET  /keys?page=&page_size=           → список
//
// 🎯 **ИМЯ ПОЛЯ КОДА — `verify_code`.** Это не перебор: в `EmailVerifyView` функция
// отправки формы дословно зовёт
//     m.register({ email, password, verify_code: h.value.trim(), turnstile_token, … })
// то есть на экране `/email-verify` SPA шлёт в `POST /auth/register` **всё тело сразу** —
// email, пароль И код. Регистрация ОДНОШАГОВАЯ на уровне API, двухшаговая только в UI
// (`/register` кладёт креды в `sessionStorage.register_data` и уводит на `/email-verify`).
//
// 🪤 Прежние пробы путались именно здесь: `verification_code` и `code` дают
// `EMAIL_VERIFY_REQUIRED` (сервер ИХ НЕ ЧИТАЕТ — поля нет, значит кода нет), а
// `verify_code` дал `INVALID_VERIFY_CODE` — то есть **поле прочитано, код плохой**.
// Код был чужой: взят из письма `VerseIn <support@versein.app>` трёхчасовой давности,
// лежавшего в переиспользованном ящике emailnator.
//
// ─────────────────────────── ПОЧТА — КРИТИЧЕСКИЙ ПУТЬ ───────────────────────────
//
// 🔴 **Вайтлист сервера: `@qq.com`, `@gmail.com`, `*.edu.cn`.** Все три наших обычных
// сервиса (guerrillamail, instanttempemail/fpklm, mail.tm/uberip) отвергаются по суффиксу
// ДО регистрации. Единственный путь — `emailnator.com`, он даёт точечный `@gmail.com`.
//
// ⚠️ У emailnator нет бесплатного API → нужен Playwright. Поэтому авторега — **гибрид**:
// браузер ТОЛЬКО для почты, сама регистрация — чистый `fetch` через прокси.
//
// 🪤 **Адреса emailnator переиспользуются — в ящике лежат ЧУЖИЕ письма.** Либа фильтрует
// по свежести, но этого мало: мы дополнительно передаём `fromHint` = `如梦AI`. Отправитель
// панели — `如梦AI <2624952982@qq.com>` (`contact_info` в `/settings/public` = `2624952982`).
//
// 🪤 Локаль контекста — `zh-CN`: сайт локализуется по языку браузера, и селекторы по
// китайскому тексту молча сломаются на английских кнопках.
//
// ─────────────────────────── ПРОКСИ ───────────────────────────
//
// Через ОБЩИЙ пул `routing/lib/proxy-pool.js`, как у AK. Пул включается точечно по хосту
// в `routing/proxy-pool.json`; `api.rumeng-ai.com` там ПОКА НЕТ — этот файл общий с
// параллельными сессиями, и правит его владелец/вкладка, не авторега. Пока хоста нет в
// списке, `enabledForHost()` вернёт false и мы пойдём напрямую с явной отметкой в логе.
//
// 🪤 Прокси применяется только к панели. Браузер emailnator ходит НАПРЯМУЮ: это внешний
// сервис, к панели отношения не имеет, а гонять Playwright через дохлый публичный SOCKS —
// лишний источник отказов на шаге, который и так самый долгий.
//
// Использование:
//   node rumeng/auto-add.js [count]
//     --no-proxy   работать с домашнего IP явно
//     --dry-run    прогнать всё, кроме записи в пул
//     --headful    показать окно браузера почты (по умолчанию headless)
//
// Результат: `routing/rumeng-sessions.json` (мерж-запись), лог `logs/rumeng-autoadd.log`,
// stdout-контракт с дашбордом — `RM_STAGE {json}` и `RM_AUTOADD_RESULT {json}`.
//
// Коды возврата: 0 создан хоть один · 2 панель закрыла регистрацию · 3 логин ·
//   4 ключ · 5 рейт-лимит · 6 прокси · 7 не создано ни одного · 8 почта · 9 капча · 1 прочее.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
// Durable-запись пула: temp + fsync + rename.
const { writeJsonSync: durableWriteJson } = require('../routing/lib/durable-write');

const HOST = 'api.rumeng-ai.com';
const BASE = '/api/v1';
const SITE = `https://${HOST}`;
const PREFLIGHT_PATH = '/api/v1/settings/public';

const POOL_FILE = path.join(__dirname, '..', 'routing', 'rumeng-sessions.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'rumeng-autoadd.log');

// Отправитель писем панели. Подсказка для выбора письма в ПЕРЕИСПОЛЬЗОВАННОМ ящике —
// см. шапку. Совпадение ищется по подстроке в строке списка (отправитель + тема).
const MAIL_FROM_HINT = '如梦AI';

// Ревизия условий, которую панель хранит в `localStorage.sub2api_login_agreement_consent`
// после нажатия `同意并继续`. Нужна ТОЛЬКО для снимка ЛК (кнопка 🌐): пока согласия нет,
// поля формы входа стоят `disabled`, и снимок открывается поверх модалки.
//
// 🪤 Значение живёт в `/settings/public` (`login_agreement_revision`) и МОЖЕТ СМЕНИТЬСЯ —
// тогда панель попросит согласие заново. Это штатно. Константа здесь — лишь дефолт на
// случай, если настройки не прочитались; при нормальном прогоне берётся живое значение.
const AGREEMENT_REVISION = '515ed00e0aa9f5e6';

const PASS_MIN = 8;          // панель: `o.password.length < 6` → минимум 6, берём с запасом
const PASS_MAX = 32;
const RATE_RETRIES = 3;
const RATE_BASE_MS = 20000;
const REQ_TIMEOUT_MS = 45000;
const GAP_MS = 4000;         // пауза между аккаунтами
const OTP_TIMEOUT_MIN = 4;   // потолок ожидания письма, минуты (pollInbox считает в минутах)

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
// Машиночитаемая строка ОТДЕЛЬНО от человеческого лога: формулировки правятся, и парсер
// русского текста однажды молча соврёт. Тот же приём, что `AK_STAGE` у ZhiFlow.
//
// 🪤 В файл лога НЕ пишем: это stdout-контракт с бэкендом, а не запись для человека.
const STAGES = ['mail', 'otp_wait', 'wait_proxy', 'register', 'login', 'token', 'key', 'self'];

function stage(name, { i, count, note } = {}) {
    const payload = { stage: name };
    if (i != null) payload.i = i;
    if (count != null) payload.count = count;
    if (note) payload.note = note;
    console.log('RM_STAGE ' + JSON.stringify(payload));
}

// ───────────────────────────── юзерагенты ─────────────────────────────
//
// 🪤 UA генерируется ОДИН НА АККАУНТ и держится на всех его запросах: смена агента
// посреди жизни сессии — это браузер, поменявшийся на ходу.

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
// шлют вовсе; приписать значило бы создать противоречие внутри одного отпечатка.
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
//
// 🪤 База `/api/v1`, а не `/api`. Пути ниже пишутся БЕЗ базы (`/auth/register`), её
// дописывает сама panel() — ровно так же устроен axios-клиент SPA (`baseURL` + путь).
//
// 🪤 Авторизация — `Authorization: Bearer`, куки нет вовсе. Заголовка `New-Api-User`,
// обязательного у ZhiFlow, здесь НЕ СУЩЕСТВУЕТ: это заголовок New API, а rumeng — не он.
function panel(method, urlPath, { body, token, agent, ua } = {}) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const agentStr = ua || UA_FALLBACK[0];
    const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent': agentStr,
        ...clientHints(agentStr),
        'Origin': SITE,
        'Referer': `${SITE}/`,
    };
    if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
    }
    if (token) headers['Authorization'] = `Bearer ${token}`;

    return new Promise(resolve => {
        const req = https.request({
            host: HOST, port: 443, method, path: BASE + urlPath, headers,
            agent, timeout: REQ_TIMEOUT_MS,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* Caddy/WAF мог отдать HTML */ }
                resolve({ status: res.statusCode, json, text });
            });
        });
        req.once('timeout', () => req.destroy(new Error('таймаут запроса')));
        req.once('error', e => resolve({ status: 0, json: null, text: '', error: e.message }));
        if (payload) req.write(payload);
        req.end();
    });
}

// Ответ панели бывает в двух формах, и это НЕ каприз: обёртка `{code:0,message,data}`
// у настроечных ручек и ПЛОСКИЙ объект у auth (`{access_token,…}` прямо в корне — так
// его читает SPA: `const {data:t} = await n.post('/auth/register',e); me(t.access_token)`).
// Наивное `json.data.access_token` на регистрации даст undefined.
//
// 🪤 Обёртку опознаём по ЧИСЛОВОМУ `code` рядом с `data`, а не по «data — это объект».
// Первая версия отсеивала массивы (`!Array.isArray(j.data)`) — и `GET /groups/available`,
// который отдаёт `{"code":0,…,"data":[…]}`, возвращал внешнюю обёртку вместо списка
// групп. Снаружи это выглядело как «групп нет (success)»: сообщение об успехе внутри
// сообщения об ошибке — ровно тот сорт вранья, который уводит разбор к правам аккаунта.
// Живой прогон 13.09 встал именно здесь, уже имея JWT.
const unwrap = r => {
    const j = r && r.json;
    if (!j || typeof j !== 'object') return null;
    if (typeof j.code === 'number' && Object.prototype.hasOwnProperty.call(j, 'data')) {
        return j.data;
    }
    return j;
};

// Текст ошибки панели. Порядок полей — по живым ответам: `message` у auth,
// `detail` у ручек ключей (SPA читает именно `response.data.detail`).
function errText(r) {
    const j = r && r.json;
    if (j && typeof j === 'object') {
        const msg = j.message || j.detail || (j.data && j.data.message);
        const reason = j.reason || j.code;
        if (msg) return reason && reason !== 0 ? `${msg} (${reason})` : String(msg);
    }
    if (r && r.error) return r.error;
    return `HTTP ${r ? r.status : '?'}${r && r.text ? ` ${r.text.slice(0, 160)}` : ''}`;
}

// 429 — ждём и повторяем, с логом, чтобы прогон не выглядел зависшим.
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

// ───────────────────────────── публичные настройки панели ─────────────────────────────
//
// 🔴 Проверяем ПЕРЕД КАЖДЫМ ПРОГОНОМ, а не один раз при написании кода. `turnstile_site_key`
// у панели уже лежит (`0x4AAAAAAD5LiNIoDDM91lSX`) при `turnstile_enabled:false` — то есть
// капча заготовлена и включается одним флагом. Её включение сломает авторегу МОЛЧА:
// сервер начнёт требовать `turnstile_token`, а мы будем слать регистрацию без него и
// читать невнятную ошибку. Дешевле упасть на старте с понятным текстом.
//
// Заодно берём вайтлист суффиксов ИЗ ОТВЕТА, а не хардкодом: если панель однажды уберёт
// `@gmail.com`, мы узнаем это до создания ящика, а не после.
async function publicSettings({ agent, ua } = {}) {
    const r = await panel('GET', '/settings/public', { agent, ua });
    const d = unwrap(r);
    if (!d || r.status !== 200) throw new Error(`/settings/public: ${errText(r)}`);
    return {
        registrationEnabled: d.registration_enabled !== false,
        emailVerifyEnabled: d.email_verify_enabled !== false,
        turnstileEnabled: d.turnstile_enabled === true,
        suffixWhitelist: Array.isArray(d.registration_email_suffix_whitelist)
            ? d.registration_email_suffix_whitelist : [],
        siteName: d.site_name || '如梦AI',
        version: d.version || null,
        agreementRevision: d.login_agreement_revision || AGREEMENT_REVISION,
    };
}

// Проходит ли адрес вайтлист панели. Формы из ответа: `@gmail.com` (суффикс) и `*.edu.cn`
// (маска домена). Пустой список = фильтра нет.
function suffixAllowed(email, list) {
    if (!list || !list.length) return true;
    const addr = String(email).toLowerCase();
    return list.some(raw => {
        const s = String(raw).toLowerCase().trim();
        if (!s) return false;
        if (s.startsWith('*.')) {
            const dom = s.slice(1);              // `*.edu.cn` → `.edu.cn`
            return addr.endsWith(dom);
        }
        return addr.endsWith(s);
    });
}

// ───────────────────────────── креды ─────────────────────────────
//
// Имени пользователя у rumeng НЕТ: регистрация принимает только email + пароль
// (см. тело в `RegisterView`/`EmailVerifyView`). Логин — тоже по email.
//
// Панель проверяет лишь длину (`password.length < 6`), но пароль потом вводят руками в
// ЛК через кнопку 🌐, поэтому состав держим читаемым: без символов, ломающих копипасту.
function randomPassword() {
    const body = crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 15);
    const pass = `Rm${body}7q`;
    if (pass.length < PASS_MIN || pass.length > PASS_MAX) {
        throw new Error(`битый генератор пароля: ${pass.length} символов`);
    }
    return pass;
}

// Имя ключа. Уникально в пределах аккаунта — по нему ключ находится ТОЧНО, без
// угадывания «самого свежего» (грабля WisdomSatan: при совпадении секунды забирался чужой).
function keyName() {
    return `cc_${crypto.randomBytes(4).toString('hex')}`;
}

// ───────────────────────────── пул ─────────────────────────────

function poolLoad() {
    try {
        const raw = fs.readFileSync(POOL_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

// Мерж-ДОПИСЫВАНИЕ, а не запись целиком: этот же файл пишет дашборд после сетевых сканов,
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
    const res = await fetch(`http://127.0.0.1:8200/__switch/api/rm/balance?api_key=${encodeURIComponent(rec.api_key)}`, { signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== 'live') throw new Error(data.error || data.status || `HTTP ${res.status}`);
    poolPatch(rec.api_key, {
        status: data.status, balance: data.balance, spent: data.spent,
        granted: data.granted, balanceSource: data.balanceSource,
        balanceCheckedAt: new Date().toISOString(), balanceError: null,
    });
    return data;
}

// ───────────────────────────── почта: emailnator через Playwright ─────────────────────────────
//
// 🔴 Браузер здесь НЕ прихоть. Вайтлист панели пропускает только `@qq.com`, `@gmail.com`
// и `*.edu.cn`; из доступного нам это `emailnator.com`, у которого **нет бесплатного API**.
// Поэтому авторега гибридная: Playwright обслуживает ТОЛЬКО ящик, регистрация идёт
// чистым `fetch`/`https` через прокси.
//
// 🔴 Либу `freemodel/lib/emailnator.js` НЕ ТРОГАЕМ — она переписана 13.09 под новый сайт,
// и все её грабли (GO-привязка ящика, тело письма в iframe, Reload из открытого письма,
// год из копирайта вместо кода, независимые чипы доменов) уже разобраны внутри неё.
//
// 🪤 `locale: 'zh-CN'` обязателен: сайты локализуются по языку браузера, и селекторы,
// построенные на китайском тексте, молча сломаются на английских кнопках.
//
// 🪤 Браузер держим ОДИН на весь прогон, а страницу — свою на аккаунт. Поднимать Chromium
// на каждый аккаунт значит платить ~2 с × count впустую; держать одну страницу на все —
// значит тащить в новый ящик состояние предыдущего (и его чужие письма).
let BROWSER = null;

async function browser({ headful } = {}) {
    if (BROWSER) return BROWSER;
    const { chromium } = require('playwright');
    BROWSER = await chromium.launch({
        headless: !headful,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    return BROWSER;
}

async function closeBrowser() {
    if (!BROWSER) return;
    try { await BROWSER.close(); } catch { /* уже мёртв — не беда */ }
    BROWSER = null;
}

// Создать ящик и вернуть { addr, page, ctx, poll() }.
//
// 🪤 Контекст НЕ закрываем здесь: страница нужна живой до момента чтения кода —
// `pollInbox` работает с той же вкладкой, где ящик был привязан кнопкой `GO !`.
// Закрытие — в `dispose()` вызывающей стороной, после регистрации.
async function makeMailbox({ headful } = {}) {
    const en = require('../freemodel/lib/emailnator.js');
    const br = await browser({ headful });
    const ctx = await br.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'zh-CN',
        userAgent: UA_FALLBACK[0],
    });
    const page = await ctx.newPage();

    let addr;
    try {
        addr = await en.createEmail(page);
    } catch (e) {
        await ctx.close().catch(() => {});
        throw e;
    }

    return {
        addr,
        // 🪤 `fromHint` — ГЛАВНАЯ страховка этого шлюза, а не украшение. Адреса emailnator
        // переиспользуются, и в свежем ящике лежат чужие письма. Живой случай 13.09: код
        // `835302` взят из письма `VerseIn <support@versein.app>` трёхчасовой давности,
        // панель ответила «invalid or expired verification code» — и это выглядело как
        // ошибка НАШЕГО кода, хотя код был просто не наш. Фильтр свежести внутри либы
        // ловит не всё: чужое письмо может прийти и минуту назад.
        async code({ timeoutMin = OTP_TIMEOUT_MIN } = {}) {
            return en.pollInbox(page, addr, { timeout: timeoutMin, fromHint: MAIL_FROM_HINT });
        },
        async dispose() { await ctx.close().catch(() => {}); },
    };
}

// ───────────────────────────── прокси через общий пул ─────────────────────────────
//
// Своей реализации туннелей здесь НЕТ намеренно: `routing/lib/proxy-pool.js` уже умеет
// CONNECT/SOCKS, preflight с TTL, липкую привязку и fail-closed. Дублировать значит
// заводить второй набор граблей.
//
// 🪤 Привязка по АККАУНТУ (его email), а не по номеру слота. Причина найдена живым
// прогоном 12.09 на AK: слот переживает прогон, поэтому каждый следующий запуск сажал
// первый аккаунт на тот же самый адрес. Для антифрода это худший из возможных узоров.
//
// Порядок «сначала ящик, потом прокси» возможен потому, что emailnator — внешний сервис
// и ходит напрямую; прокси нужен только запросам к панели.
//
// 🎯 Пул опустел — ЖДЁМ докорма, а не теряем аккаунт (решение владельца 12.09): публичные
// прокси живут минуты, фоновый докорм вкладки находит новые, а аккаунт к этому моменту
// уже оплачен ящиком. Ждём ТОЛЬКО когда пул пуст; мёртвый конкретный прокси — обычный
// быстрый перебор.
const PROXY_WAIT_MS = 5 * 60 * 1000;
const PROXY_WAIT_POLL_MS = 8000;

async function acquireProxyFor(email, { noProxy, index, count }) {
    if (noProxy) return { agent: undefined, proxyLabel: 'напрямую (--no-proxy)' };

    let pp;
    try { pp = require('../routing/lib/proxy-pool.js'); }
    catch (e) {
        return { error: `общий пул прокси не загрузился: ${e.message}. Нужен домашний IP — скажи --no-proxy` };
    }

    // `api.rumeng-ai.com` внесён в `hosts` файла `routing/proxy-pool.json` 13.09 по
    // решению владельца («прокси на регу с кнопочкой»), поэтому пул здесь ВКЛЮЧЁН.
    // Замер в момент включения: из 20 прокси пула 9 отдают 200 на `/settings/public`
    // этого хоста — остальные мертвы сами по себе, не заблокированы панелью.
    //
    // 🪤 Ветка ниже остаётся и остаётся ГРОМКОЙ: конфиг перечитывается по mtime, и хост
    // из списка может исчезнуть (правка руками, откат, параллельная сессия). Тогда
    // регистрация молча уйдёт с домашнего IP — это был провал freemodel, и никто об этом
    // не знал. Строка лога дороже одной проверки.
    if (!pp.enabledForHost(HOST)) {
        return { agent: undefined, proxyLabel: `напрямую (пул выключен для ${HOST})` };
    }

    const key = `rumeng:${String(email).toLowerCase()}`;
    const tried = new Set();
    const deadline = Date.now() + PROXY_WAIT_MS;
    // 🔴 Путь проверки ОБЯЗАТЕЛЕН: по умолчанию пул стучит в `/api/status` — соглашение
    // New API, которого у sub2api нет. На rumeng он отдаёт 404, вердикт «HTTP 404», и
    // НИ ОДИН прокси не проходит — при живом прокси и живой панели. Замер 13.09:
    // `/api/status` → 404, `/api/v1/settings/public` → 200 за 1,85 с через тот же socks5.
    let r = await pp.forAccount(key, { host: HOST, preflightPath: PREFLIGHT_PATH });
    let firstError = null;
    let announcedWait = false;

    for (let attempt = 0; attempt < 3 && !r.ok; attempt++) {
        if (!firstError) firstError = r.error;
        log(`   ⚠️ ${r.error}`);

        const cur = pp.assignmentFor(key);
        if (cur && cur.proxy) tried.add(cur.proxy);

        let others = pp.pool().proxies.filter(x => !tried.has(x.id));
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

        r = await pp.forAccount(key, { host: HOST, preflightPath: PREFLIGHT_PATH });
    }

    if (!r.ok) return { error: `${firstError || r.error}; перебор кандидатов не дал живого прокси` };
    if (!r.proxy) return { agent: undefined, proxyLabel: `напрямую (${r.reason || 'пул пуст по конфигу'})` };

    return {
        agent: pp.agentFor(r.proxy),
        proxyLabel: r.proxy.label || r.proxy.id || 'прокси',
    };
}

// ───────────────────────────── один аккаунт ─────────────────────────────

const CLOSED_RE = /закрыт|禁止|not allowed|disabled|关闭|已关闭|未开放|registration.*(closed|disabled)/i;
// Занятость адреса — не повод падать: следующий ящик будет другим.
//
// 🪤 Живой случай 13.09: `send-verify-code` ответил `email already exists (EMAIL_EXISTS)`.
// Это не сбой — **адреса emailnator переиспользуются**, и выданный ящик уже был кем-то
// (возможно, нами же в прошлом прогоне) зарегистрирован. Правильная реакция — взять
// НОВЫЙ ящик, а не считать аккаунт потерянным.
const TAKEN_RE = /已存在|已被使用|已注册|exists|taken|occupied|registered/i;

// Сколько ящиков перебрать, пока не попадётся незанятый. Каждый стоит ~15 с, поэтому
// потолок низкий: если три подряд заняты, проблема не в удаче, а в сервисе.
const MAIL_ATTEMPTS = 3;

async function createOne(index, { noProxy, count, headful, settings }) {
    const password = randomPassword();
    const ua = nextUserAgent();               // один агент на весь жизненный цикл аккаунта
    const at = (name, note) => stage(name, { i: index, count, note });

    // 1–3. Ящик + запрос кода, с перебором ящиков при занятом адресе.
    //
    // Ящик создаётся ПЕРВЫМ и напрямую: emailnator — внешний сервис, к панели отношения
    // не имеет. Прокси берём после, потому что липкая привязка идёт по адресу.
    //
    // 🪤 Цикл нужен из-за ПЕРЕИСПОЛЬЗОВАНИЯ адресов emailnator: выданный ящик может уже
    // быть зарегистрирован, и панель отвечает `EMAIL_EXISTS`. Живой прогон 13.09 встал
    // ровно здесь. Это не отказ, а «попробуй другой ящик».
    let box = null;
    let addr = null;
    let net = null;
    let got = null;

    try {
        for (let attempt = 1; attempt <= MAIL_ATTEMPTS; attempt++) {
            at('mail', attempt > 1 ? `ящик ${attempt}/${MAIL_ATTEMPTS}` : undefined);
            try { box = await makeMailbox({ headful }); }
            catch (e) { return { ok: false, code: 8, why: `ящик не создан: ${e.message}` }; }
            addr = box.addr;
            log(`[${index}] ящик ${addr}${attempt > 1 ? ` (попытка ${attempt})` : ''}`);

            // 🛡 Сверяем адрес с вайтлистом ДО всякой сети. Панель отвергает чужой суффикс
            // ответом `EMAIL_SUFFIX_NOT_ALLOWED`; а если emailnator однажды выдаст не-gmail
            // (например `@tmpmailtor.com` — его домен по умолчанию), мы узнаем это здесь,
            // а не из ответа сервера.
            if (!suffixAllowed(addr, settings.suffixWhitelist)) {
                return {
                    ok: false, code: 8,
                    why: `адрес ${addr} не проходит вайтлист панели (${settings.suffixWhitelist.join(', ')})`,
                };
            }

            // 2. Прокси — свой на аккаунт, привязанный к его адресу.
            got = await acquireProxyFor(addr, { noProxy: !!noProxy, index, count });
            if (got.error) return { ok: false, code: 6, why: got.error };
            net = { agent: got.agent, ua };
            log(`   через ${got.proxyLabel}`);
            if (attempt === 1) log(`   UA ${ua.slice(0, 78)}${ua.length > 78 ? '…' : ''}`);

            // 3. Запрос кода. Тело — ровно `{email}` (SPA: `n.post('/auth/send-verify-code', e)`).
            //
            // 🪤 Успех — `code: 0` в обёртке, а НЕ просто HTTP 200: панель отвечает
            // двухсоткой и на часть отказов. Живой успех: `{"code":0,"message":"success",
            // "data":{"message":"Verification code sent successfully","countdown":60}}`.
            const ver = await retryOnRate('send-verify-code', () => panel(
                'POST', '/auth/send-verify-code', { body: { email: addr }, ...net }));
            const verOk = ver.status === 200 && ver.json && (ver.json.code === 0 || ver.json.code === undefined);
            if (verOk) break;

            const msg = errText(ver);
            if (CLOSED_RE.test(msg) && !TAKEN_RE.test(msg)) {
                return { ok: false, code: 2, why: `панель закрыла регистрацию: ${msg}` };
            }
            // Адрес занят — берём НОВЫЙ ящик и пробуем снова.
            if (TAKEN_RE.test(msg) && attempt < MAIL_ATTEMPTS) {
                log(`   ⚠️ адрес уже зарегистрирован (${msg}) — беру новый ящик`);
                await box.dispose();
                box = null;
                continue;
            }
            return { ok: false, code: 8, why: `send-verify-code: ${msg}` };
        }
        if (!box) return { ok: false, code: 8, why: `за ${MAIL_ATTEMPTS} попыток не нашёлся свободный ящик` };
        log('   ✓ код запрошен, жду письмо');

        // 4. Код из письма. 🪤 Читаем ТОЛЬКО письмо от панели (`fromHint` внутри box.code()):
        // ящик переиспользуется и полон чужих писем — см. комментарий у makeMailbox.
        at('otp_wait');
        const code = await box.code();
        if (!code) {
            return { ok: false, code: 8, why: `код от ${MAIL_FROM_HINT} не пришёл за ${OTP_TIMEOUT_MIN} мин` };
        }
        log(`   ✓ код получен (${String(code).length} цифр)`);
        const { agent } = got;

        // 5. Регистрация. 🎯 ПОЛЕ КОДА — `verify_code`.
        //
        // Это не перебор, а дословный вызов из бандла (`EmailVerifyView`, функция отправки):
        //   m.register({ email, password, verify_code: h.value.trim(), turnstile_token, … })
        // Регистрация ОДНОШАГОВАЯ на уровне API: `/register` и `/email-verify` — две страницы
        // UI, но один запрос. `/register` только кладёт креды в `sessionStorage.register_data`.
        //
        // 🪤 `verification_code` и `code` давали `EMAIL_VERIFY_REQUIRED` именно потому, что
        // сервер их НЕ ЧИТАЕТ: поля нет → кода нет → «подтверждение требуется».
        //
        // Необязательные поля (`promo_code`, `invitation_code`, `aff_code`, `turnstile_token`)
        // НЕ шлём вовсе: все соответствующие флаги панели выключены, а SPA в этом случае
        // подставляет `undefined`, то есть ключа в JSON нет.
        at('register');
        const body = { email: addr, password, verify_code: String(code).trim() };
        if (settings.turnstileEnabled) {
            // Сюда мы не попадём — прогон падает раньше, в main(). Ветка оставлена явной,
            // чтобы при включении капчи было видно, куда встраивать решатель.
            return { ok: false, code: 9, why: 'включена Turnstile — регистрация без токена капчи не пройдёт' };
        }
        const reg = await retryOnRate('register', () => panel('POST', '/auth/register', { body, ...net }));
        if (reg.status === 429) return { ok: false, code: 5, why: 'рейт-лимит на регистрации' };

        let auth = unwrap(reg);
        let accessToken = auth && auth.access_token;
        if (!accessToken) {
            const msg = errText(reg);
            if (CLOSED_RE.test(msg) && !TAKEN_RE.test(msg)) {
                return { ok: false, code: 2, why: `панель закрыла регистрацию: ${msg}` };
            }
            return { ok: false, code: 7, why: `register: ${msg}` };
        }
        log('   ✓ зарегистрирован, JWT выдан регистрацией');

        // 6. Логин — СТРАХОВКА, а не шаг. В отличие от ZhiFlow (где регистрация сессию не
        // ставит и логин обязателен), здесь `register` уже вернул токены. Ходим сюда только
        // если регистрация почему-то отдала успех без `access_token`.
        let refreshToken = auth.refresh_token || null;
        let expiresIn = auth.expires_in || null;
        let user = auth.user || null;

        if (!accessToken) {
            at('login');
            const lg = await retryOnRate('login', () => panel('POST', '/auth/login', {
                body: { email: addr, password }, ...net,
            }));
            const ld = unwrap(lg);
            if (!ld || !ld.access_token) return { ok: false, code: 3, why: `login: ${errText(lg)}` };
            accessToken = ld.access_token;
            refreshToken = ld.refresh_token || refreshToken;
            expiresIn = ld.expires_in || expiresIn;
            user = ld.user || user;
            log('   ✓ вход');
        }

        const authed = { token: accessToken, ...net };

        // 7. Профиль. Берём ДО ключа: нужен id аккаунта в записи пула, а заодно это
        // проверка, что выданный токен действительно рабочий, — до того как мы на нём
        // начнём создавать ключи и разбирать невнятные ошибки.
        at('self');
        const meRes = await panel('GET', '/auth/me', authed);
        const me = unwrap(meRes) || {};
        if (!user) user = me.user || me;
        const uid = (user && (user.id ?? user.user_id)) ?? me.id ?? null;
        const balance = pickBalance(user, me);
        log(`   ✓ профиль id=${uid ?? '?'}${balance != null ? `, баланс ${balance}` : ''}`);

        // 8. Группа. 🔴 ОБЯЗАТЕЛЬНА и строго ДО создания ключа: владелец проверил живьём —
        // нажатие «创建» без выбранной группы даёт ошибку, ключ не создаётся. В UI это
        // `选择分组` → `kiro自建`; в API — `GET /groups/available` и `group_id` в теле.
        at('token');
        const grp = await pickGroup(authed);
        if (grp.error) return { ok: false, code: 4, why: grp.error };
        log(`   ✓ группа «${grp.name}» (id=${grp.id})`);

        // 9. Ключ. Клиент SPA (`AppHeader.vue_*.js`, функция create):
        //   const l = { name }; if (group_id !== undefined) l.group_id = group_id; …
        //   await f.post('/keys', l)
        // Остальные поля (quota, ip_whitelist, rate_limit_*, expires_in_days) опциональны
        // и добавляются только при ненулевых значениях — значит бессрочный безлимитный
        // ключ это ровно `{name, group_id}`.
        //
        // Живой ответ создания (проба 13.09) — ПОЛНЫЙ ключ в открытом виде:
        //   {"code":0,…,"data":{"id":207,"user_id":189,"key":"sk-ef4e…e417","group_id":…}}
        // Маски, как у ZhiFlow, здесь нет, и отдельная ручка раскрытия не нужна.
        at('key');
        const nameForKey = keyName();
        const mk = await retryOnRate('keys', () => panel('POST', '/keys', {
            body: { name: nameForKey, group_id: grp.id }, ...authed,
        }));
        const created = unwrap(mk);
        if (!created || (mk.status >= 400)) {
            return { ok: false, code: 4, why: `keys create: ${errText(mk)}` };
        }

        // 🛡 Проверяем, что группа ДЕЙСТВИТЕЛЬНО прилипла. Сервер принимает ключ и без
        // неё (200, `group_id: null`) — то есть «успех» тут ничего не доказывает, а
        // ключ без группы не привязан к апстриму и лёг бы в пул мёртвым. Эта проверка
        // и есть та обязательность группы, о которой говорил владелец.
        if (created.group_id == null) {
            return { ok: false, code: 4, why: `keys create: ключ создан БЕЗ группы (group_id=null) — такой ключ нерабочий` };
        }

        // 🪤 Ключ ищем в ОТВЕТЕ, и только если его там нет — в списке. У ZhiFlow ответ
        // создания ключа не содержал, и наивная схема «создать и прочитать из списка»
        // давала маску. Здесь ответ полный, но подстраховка дешевле потерянного аккаунта.
        let apiKey = pickKeyString(created);
        let keyId = created.id ?? (created.key && created.key.id) ?? null;

        if (!apiKey) {
            const found = await findKeyByName(authed, nameForKey);
            if (found.error) return { ok: false, code: 4, why: found.error };
            apiKey = found.key;
            keyId = found.id ?? keyId;
        }
        if (!apiKey || apiKey.includes('*') || apiKey.length < 16) {
            return { ok: false, code: 4, why: `ключ не добыт: получили ${apiKey ? 'маску/огрызок' : 'пусто'}` };
        }
        log(`   ✓ ключ добыт (${mask(apiKey)}, ${apiKey.length} символов)`);

        return {
            ok: true,
            record: {
                id: `rm_${Date.now()}_${index}`,
                email: addr,
                name: (user && (user.username || user.name)) || addr.split('@')[0],
                password,
                api_key: apiKey,
                active: false,            // владение активным ключом ставит дашборд, не мы
                status: 'live',
                created: new Date().toISOString(),
                userId: uid,
                keyId,
                keyName: nameForKey,
                groupId: grp.id,
                groupName: grp.name,
                autoAdded: true,
                balance: balance != null ? balance : null,
                proxyUsed: agent ? got.proxyLabel : null,
                userAgent: ua,
                mailProvider: addr.split('@')[1] || null,
                // 🔴 JWT вместо куки — это и есть главное отличие вкладки от ZhiFlow.
                // Оба токена нужны: `access_token` живёт `expires_in`, а продлевается он
                // ТОЛЬКО через `refresh_token` (`POST /auth/refresh`).
                accessToken,
                refreshToken,
                tokenExpiresIn: expiresIn,
                tokenIssuedAt: new Date().toISOString(),
                // Живая ревизия условий — для снимка ЛК. Берём из настроек этого прогона,
                // а не из константы: панель может обновить условия в любой момент.
                agreementRevision: settings.agreementRevision || AGREEMENT_REVISION,
                // Состояние входа для SPA. В пул НЕ уходит — main() снимает поле сразу
                // после записи снимка: это состояние браузера, а не свойство аккаунта.
                spaUser: user || me || null,
            },
        };
    } finally {
        // Ящик больше не нужен ни при успехе, ни при провале: код либо получен, либо уже
        // не придёт. Вкладка, оставленная жить, держит Chromium и течёт на пачке.
        if (box) await box.dispose();
    }
}

// Маска секрета для лога. 🔴 Полный ключ в лог не попадает НИКОГДА: файл лога читает
// человек в UI, и оттуда он разлетается по скриншотам.
const mask = s => {
    const v = String(s || '');
    return v.length <= 12 ? '***' : `${v.slice(0, 6)}…${v.slice(-4)}`;
};

// Баланс/грант нового аккаунта. Панель зовёт это по-разному в разных ручках, поэтому
// перебираем известные имена, а не гадаем одно. null = поля нет, и это не ошибка.
function pickBalance(...objs) {
    for (const o of objs) {
        if (!o || typeof o !== 'object') continue;
        for (const k of ['balance', 'quota', 'credit', 'remaining_quota', 'total_quota']) {
            const v = o[k];
            if (typeof v === 'number') return v;
        }
    }
    return null;
}

// Строка ключа в ответе создания. Имя поля заранее неизвестно (в списке ключ может быть
// замаскирован), поэтому берём первое похожее на настоящий ключ значение.
function pickKeyString(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const cands = [];
    const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 3) return;
        for (const [k, v] of Object.entries(o)) {
            if (typeof v === 'string' && /key|token|secret/i.test(k)) cands.push(v);
            else if (v && typeof v === 'object') walk(v, depth + 1);
        }
    };
    walk(obj, 0);
    // Настоящий ключ длинный и без звёздочек маски.
    const real = cands.find(v => v.length >= 16 && !v.includes('*'));
    return real || null;
}

// Группа для ключа.
//
// 🔴 Владелец проверил живьём: в UI нажатие «创建» без выбранной группы даёт ошибку.
// 🪤 Но на уровне API это НЕ ТАК: `POST /keys {name}` без `group_id` отвечает 200 и
// создаёт ключ с `group_id: null` (проверено пробником 13.09, ключ id=207). То есть
// обязательность группы — проверка ФРОНТА, и «успех» API здесь обманчив: ключ без группы
// не привязан ни к одному апстриму, а выглядит как настоящий и ляжет в пул мёртвым.
// ⇒ Группу ставим всегда и падаем, если её нет, — это сознательно строже сервера.
//
// 🪤 Имя группы НЕ хардкодим: у владельца в UI это `kiro自建`, но набор групп у нового
// аккаунта может отличаться (живой список 13.09 начинался с `反重力gemini`, `gptpro`).
// Жёсткое имя дало бы «группа не найдена» на пустом месте. Берём предпочтительную по
// шаблону, иначе первую доступную.
const GROUP_PREFERRED_RE = /kiro|claude|anthropic/i;

async function pickGroup(authed) {
    const r = await panel('GET', '/groups/available', authed);
    const d = unwrap(r);
    const items = Array.isArray(d) ? d
        : Array.isArray(d && d.items) ? d.items
        : Array.isArray(d && d.groups) ? d.groups : [];
    if (!items.length) {
        return { error: `groups/available: групп нет (${errText(r)}) — ключ без группы не создаётся` };
    }
    const named = g => String(g.name || g.title || g.label || g.code || g.id || '');
    // Список групп — в лог: это каталог того, что аккаунту вообще доступно, и он
    // меняется на стороне панели. Без него выбор группы выглядит как магия.
    log(`   группы (${items.length}): ${items.map(named).slice(0, 12).join(', ')}${items.length > 12 ? ' …' : ''}`);

    // Мёртвые группы в выбор не берём: ключ в `status != active` группе бесполезен.
    const alive = items.filter(g => !g.status || g.status === 'active');
    const pickFrom = alive.length ? alive : items;
    const preferred = pickFrom.find(g => GROUP_PREFERRED_RE.test(named(g)));
    const g = preferred || pickFrom[0];
    const id = g.id ?? g.group_id ?? g.value;
    if (id == null) return { error: `groups/available: у группы «${named(g)}» нет id` };
    return { id, name: named(g), total: items.length, preferred: !!preferred };
}

// Запасной путь добычи ключа: найти по ИМЕНИ, которое мы сами задали. По имени ключ
// находится точно, без угадывания «самого свежего» — при совпадении секунды или
// параллельном создании мы бы забрали чужой (грабля WisdomSatan).
//
// 🪤 Панель создаёт запись не мгновенно: сразу после POST список может прийти пустым.
// Пара коротких повторов дешевле потерянного аккаунта — он уже зарегистрирован.
async function findKeyByName(authed, name) {
    let lastSeen = -1;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep(1500);
        const r = await panel('GET', '/keys?page=1&page_size=100', authed);
        const d = unwrap(r);
        const items = Array.isArray(d && d.items) ? d.items : Array.isArray(d) ? d : [];
        lastSeen = items.length;
        const mine = items.find(k => String(k.name) === name);
        if (mine) {
            const key = pickKeyString(mine);
            if (key) return { key, id: mine.id ?? null };
            // Нашли запись, но ключ в списке замаскирован — честно об этом и говорим,
            // а не «ключ не найден»: это разные поломки с разным лечением.
            return { error: `keys list: ключ «${name}» найден, но значение замаскировано — нужна отдельная ручка раскрытия` };
        }
    }
    return { error: `keys list: своего ключа «${name}» не нашли (в списке ${lastSeen < 0 ? 'запрос не прошёл' : lastSeen + ' шт.'})` };
}

// ───────────────────────────── снимок входа для кнопки 🌐 ─────────────────────────────
//
// 🔴 Снимок пишем НЕ своей функцией, а `writeProfileSession` из `rumeng/refresh-sessions.js`.
// Формат снимка — один на вкладку: если авторега и обновлятор сессий заведут по своему,
// они разъедутся, и кнопка 🌐 будет открывать ЛК то залогиненным, то нет в зависимости от
// того, кто писал файл последним. Один формат, одна точка правки.
//
// 🔴 ИМЕНА КЛЮЧЕЙ НЕ УГАДЫВАЮТСЯ — и здесь легко ошибиться молча. По проводу
// `/auth/register`, `/auth/login` и `/auth/refresh` отдают поле **`access_token`**, но SPA
// кладёт его в localStorage под именем **`auth_token`**, и оттуда же читает в перехватчике
// запросов. Замер живого бандла `assets/index-BY5fm1HP.js`:
//
//   setItem("auth_token")        2   getItem("auth_token")        4
//   setItem("refresh_token")     2   getItem("refresh_token")     2
//   setItem("auth_user")         3   getItem("auth_user")         2
//   setItem("token_expires_at")  2   getItem("token_expires_at")  1
//   setItem("access_token")      0   getItem("access_token")      0   ← ключа НЕТ ВООБЩЕ
//
// Снимок с `access_token` вместо `auth_token` открыл бы форму входа, не сказав ни слова.
//
// 🪤 `token_expires_at` — это АБСОЛЮТНЫЙ момент (`Date.now() + expires_in*1000`), а не
// сами секунды: `oe(e){ localStorage.setItem("token_expires_at", String(Date.now()+e*1e3)) }`.
// Пересчёт делает `sessionStateFromJwt`, поэтому ему передаётся `expiresIn` в секундах.
//
// 🪤 Все ЧЕТЫРЕ ключа обязательны. Без `refresh_token` SPA не продлит сессию сама и
// выбросит владельца на логин ровно в тот момент, когда токен истечёт прямо в открытом окне.
//
// 🔴 СЕССИЯ ПРИВЯЗАНА К UA — снимок бесполезен, если открыть его чужим браузером.
// Замер 13.09 на живом аккаунте (id=192), один и тот же `auth_token`:
//
//   родной UA (из записи пула)     → /auth/me  200
//   тот же UA, версия Chrome 999   → /auth/me  401  SESSION_BINDING_MISMATCH
//   другой UA (Linux)              → /auth/me  401  SESSION_BINDING_MISMATCH
//   без UA                         → /auth/me  401  SESSION_BINDING_MISMATCH
//
// Панель зовёт это «Session network fingerprint changed». Значит `userAgent` в записи
// пула — не украшение для антифрода, а ЧАСТЬ УЧЁТНЫХ ДАННЫХ: и кнопка 🌐, и любой
// обновлятор обязаны ходить именно с ним, иначе живой токен выглядит протухшим.
// Сверять вход только живым `GET /auth/me` С РОДНЫМ UA; наличие ключа в localStorage
// ничего не доказывает (мёртвый токен рисует кабинет ~16 с, потом 401 и /login).
//
// 🪤 `refresh_token` ОДНОРАЗОВЫЙ. Тот, что выдан регистрацией, к моменту первого 401 уже
// потрачен интерцептором SPA — прямая проба даёт `REFRESH_TOKEN_INVALID`, и это НЕ порча
// записи. Свежий refresh (сразу после `POST /auth/login`) отрабатывает 200 — проверено.
// Поэтому чинить протухший вход надо повторным `login` по паролю, а не refresh'ем из пула.
function writeProfileSession(rec) {
    if (!rec || !rec.accessToken) return null;
    const rs = require('./refresh-sessions.js');
    return rs.writeProfileSession(rec.id, {
        accessToken: rec.accessToken,
        refreshToken: rec.refreshToken,
        expiresIn: rec.tokenExpiresIn,
        user: rec.spaUser,
        // Согласие с условиями — иначе модалка 条款更新通知 перегораживает кабинет и
        // залогиненному. Ревизия живая, из настроек этого прогона.
        consentRevision: rec.agreementRevision || AGREEMENT_REVISION,
    });
}

// ───────────────────────────── main ─────────────────────────────

function parseArgs(argv) {
    const a = { count: 1, noProxy: false, dry: false, headful: false };
    for (let i = 2; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--no-proxy') a.noProxy = true;
        else if (t === '--dry-run') a.dry = true;
        else if (t === '--headful' || t === '--headed') a.headful = true;
        else if (/^\d+$/.test(t)) a.count = Math.max(1, Number(t));
    }
    return a;
}

async function main() {
    const args = parseArgs(process.argv);
    log(`🚀 авторег 如梦AI: ${args.count} акк${args.count > 1 ? '.' : ''}${args.dry ? ' (--dry-run)' : ''}`);

    // 🔴 Снимаем настройки панели ПЕРЕД прогоном, каждый раз. Три флага решают, есть ли
    // смысл начинать: закрытая регистрация, включённая капча и вайтлист суффиксов.
    // Капча у панели заготовлена (`turnstile_site_key` лежит при выключенном флаге) —
    // её включение сломало бы авторегу молча, поэтому падаем внятно и сразу.
    let settings;
    try { settings = await publicSettings({ ua: UA_FALLBACK[0] }); }
    catch (e) {
        log(`❌ настройки панели не прочитались: ${e.message}`);
        stage('done', { i: 0, count: args.count, note: 'settings' });
        console.log('RM_AUTOADD_RESULT ' + JSON.stringify({ created: 0, written: 0, failed: 1, errors: [e.message], accounts: [] }));
        process.exit(1);
    }
    log(`   панель ${settings.siteName} v${settings.version || '?'} · регистрация ${settings.registrationEnabled ? 'открыта' : 'ЗАКРЫТА'}`
        + ` · капча ${settings.turnstileEnabled ? '🔴 ВКЛЮЧЕНА' : 'выкл'} · почта ${settings.suffixWhitelist.join(', ') || 'любая'}`);

    if (!settings.registrationEnabled) {
        log('❌ регистрация на панели закрыта — прогон бессмыслен');
        stage('done', { i: 0, count: args.count, note: 'closed' });
        console.log('RM_AUTOADD_RESULT ' + JSON.stringify({ created: 0, written: 0, failed: 1, errors: ['registration_enabled=false'], accounts: [] }));
        process.exit(2);
    }
    if (settings.turnstileEnabled) {
        log('❌ панель включила Turnstile — регистрация без решателя капчи не пройдёт.');
        log('   Это ожидаемая развилка: ключ капчи у них лежал заготовленным. Нужен решатель.');
        stage('done', { i: 0, count: args.count, note: 'turnstile' });
        console.log('RM_AUTOADD_RESULT ' + JSON.stringify({ created: 0, written: 0, failed: 1, errors: ['turnstile_enabled=true'], accounts: [] }));
        process.exit(9);
    }
    if (args.noProxy) {
        log('🏠 --no-proxy: работаю с домашнего IP явно');
    }

    const created = [];
    const failed = [];
    let lastCode = 7;
    let written = 0;

    try {
        for (let i = 1; i <= args.count; i++) {
            let res;
            try { res = await createOne(i, { noProxy: args.noProxy, count: args.count, headful: args.headful, settings }); }
            catch (e) { res = { ok: false, code: 1, why: `исключение: ${e.message}` }; }

            if (res.ok) {
                created.push(res.record);
                // 🪤 Пишем пул ПОСЛЕ КАЖДОГО аккаунта, а не пачкой в конце: длинный прогон
                // может умереть на любом шаге следующего аккаунта, и тогда уже добытые
                // ключи потеряются вместе с оплаченными ящиками.
                if (!args.dry) {
                    try {
                        const f = writeProfileSession(res.record);
                        if (f) log(`   ✓ снимок ЛК (${path.basename(f)})`);
                    } catch (e) { log(`   ⚠️ снимок ЛК не записан: ${e.message}`); }
                    const rec = { ...res.record };
                    delete rec.spaUser;              // состояние SPA — не поле записи пула
                    try {
                        const n = poolAppend([rec]);
                        written += n;
                        if (n) log(`   ✓ записан в пул (${path.basename(POOL_FILE)})`);
                        else log(`   · уже был в пуле (дубль)`);
                    } catch (e) {
                        const why = `персистенция ${rec.email}: аккаунт создан, но пул не записан: ${e.message}`;
                        failed.push(why);
                        log(`   ❌ ${why}`);
                    }
                    try {
                        const balance = await checkSavedBalance(rec);
                        log(`   ✓ баланс ${rec.email}: $${Number(balance.balance || 0).toFixed(2)}`);
                    } catch (e) {
                        const why = `баланс ${rec.email}: ${e.message}`;
                        failed.push(why);
                        try { poolPatch(rec.api_key, { balanceError: e.message, balanceCheckedAt: new Date().toISOString() }); } catch (patchError) { log(`   ⚠️ ${patchError.message}`); }
                        log(`   ⚠️ ${why}`);
                    }
                }
            } else {
                failed.push(res.why);
                // Регистрация закрыта или включена капча — остальные попытки бессмысленны.
                // Отказ прокси или почты — нет: следующий аккаунт получит другие.
                if (res.code === 2 || res.code === 9) break;
            }
            if (i < args.count) await sleep(GAP_MS);
        }
    } finally {
        await closeBrowser();
    }

    const writtenFinal = args.dry ? 0 : written;
    if (args.dry) log(`🧪 --dry-run: в пул не пишу (${created.length} готово)`);
    log(`Итого: создано ${created.length}, записано в пул ${writtenFinal}, ошибок ${failed.length}`);
    if (writtenFinal) log('🪤 Активировать аккаунт кнопкой на вкладке — из скрипта active не ставим.');

    // Гасим индикатор: без терминального маркера UI застрял бы на последнем пройденном
    // шаге и показывал этап уже завершённого прогона.
    stage('done', { i: args.count, count: args.count });

    // 🔴 Секретов в контракте НЕТ: ни ключа, ни пароля, ни токенов. Эта строка уезжает в
    // дашборд и оттуда в UI владельца.
    console.log('RM_AUTOADD_RESULT ' + JSON.stringify({
        created: created.length,
        written: writtenFinal,
        failed: failed.length,
        errors: failed.slice(0, 5),
        accounts: created.map(r => ({
            id: r.id, email: r.email, userId: r.userId,
            groupName: r.groupName, balance: r.balance,
            keyMask: mask(r.api_key),
        })),
    }));

    process.exit(created.length ? 0 : lastCode);
}

if (require.main === module) {
    main().catch(async e => {
        await closeBrowser();
        log(`❌ ${e.stack || e.message}`);
        console.log('RM_AUTOADD_RESULT ' + JSON.stringify({ created: 0, written: 0, failed: 1, errors: [e.message], accounts: [] }));
        process.exit(1);
    });
}

module.exports = {
    HOST, BASE, SITE, POOL_FILE, STAGES, MAIL_FROM_HINT, AGREEMENT_REVISION,
    panel, retryOnRate, unwrap, errText, clientHints, nextUserAgent,
    publicSettings, suffixAllowed, randomPassword, keyName,
    poolLoad, poolAppend, mask, pickBalance, pickKeyString, pickGroup, findKeyByName,
    makeMailbox, closeBrowser, acquireProxyFor, stage,
    writeProfileSession,
    _internals: { PASS_MIN, PASS_MAX, OTP_TIMEOUT_MIN, GAP_MS, REQ_TIMEOUT_MS },
};
