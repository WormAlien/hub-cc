'use strict';

// routing/lib/google-pool.js
//
// Пул Google-аккаунтов: хранилище плюс разбор пачки из магазина. Логика вынесена в модуль
// по образцу `routing/lib/outlook-pool.js` (у GitHub-пула она размазана по трём файлам, и
// его собственные регрессы на это жалуются).
//
// 🔴 Почему у аккаунта есть профиль браузера, а не только пара логин-пароль: вход в Google
// с нового адреса упирается в челлендж (телефон, «подтвердите, что это вы»), а кука профиля
// его уже прошла. Пароль здесь - то, чем человек один раз входит в профиль; дальше живёт
// кука. Поэтому профиль, снимок сессии и запись пула - ТРИ разные вещи, и терять их нельзя
// по отдельности (см. `remove`).
//
// 🪤 Как читать строку магазина - ЗЕРКАЛЬНО Outlook, и это главная ловушка при копировании.
// Там base32-секрет в строке означал «это НЕ ящик, а GitHub-аккаунт, отбрось». Здесь
// наоборот: `почта:пароль:СЕКРЕТ` - это ровно то, что продавец Google-аккаунтов и продаёт,
// и секрет обязан доехать до карточки как `totpSecret`, иначе живой код 2FA неоткуда взять.
//
// Файлы: google/accounts.json (пул, в .gitignore), google/profiles/acct_<id>/ (профиль
// Chromium на аккаунт), google/sessions/<id>.json (снимок storageState).

const fs = require('fs');
const path = require('path');
const durable = require('./durable-write');

// 🪤 Каталог пула перекрывается переменной окружения. Это не «на всякий случай»: регресс
// `tools/check-google-pool.js` обязан писать и ронять файлы, не заглядывая в живой пул
// (тот же приём и тот же довод, что у `routing/lib/media-routes.js`: проба идёт по тому же
// коду, что и прод, но на своём файле).
const DIR = process.env.GOOGLE_DIR
    ? path.resolve(process.env.GOOGLE_DIR)
    : path.join(__dirname, '..', '..', 'google');
const FILE = path.join(DIR, 'accounts.json');
const PROFILES_DIR = path.join(DIR, 'profiles');
const SESSIONS_DIR = path.join(DIR, 'sessions');

// Вердикт ставит человек: v1 ничего не проверяет сам, и «не смогли измерить» обязано
// выглядеть как `unknown`, а не как `dead` (канон вкладки AgentRouter).
const STATUSES = ['unknown', 'live', 'dead', 'locked'];
// Класс аккаунта. `personal` - личный, автоматизацию на нём не запускаем ни в v1, ни
// дальше; `burner` - расходник под прогоны.
const KINDS = ['personal', 'burner'];

// ── хранилище ────────────────────────────────────────────────────────────────

// Читает пул. Бросает на нулёвке и на битом JSON - НАМЕРЕННО, в отличие от большинства
// лоадеров хаба, которые глотают бросок в `catch { return []; }` (это зафиксировано как
// общий изъян в [[Долговечная запись пулов — защита от нулёвки]]). Разница принципиальная:
// вернуть `[]` на битом файле значит показать пустую вкладку и разрешить запись поверх
// огрызка. Вызывающий ловит и отвечает 500 с текстом ошибки.
function load() {
    let raw = null;
    try { raw = fs.readFileSync(FILE, 'utf8'); }
    catch (e) {
        if (e.code === 'ENOENT') return [];   // пул ещё не заводили - это законное «нет записей»
        throw e;
    }
    durable.assertNotZeroed(raw, 'Google-пул');
    const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    let arr;
    try { arr = JSON.parse(text); }
    catch (e) {
        const err = new Error(`google/accounts.json не разбирается как JSON: ${e.message}. `
            + 'Не перезаписываю: починить руками или восстановить из снимка');
        err.poolCorrupt = 'unparseable';
        throw err;
    }
    if (!Array.isArray(arr)) {
        const err = new Error('google/accounts.json - не массив записей');
        err.poolCorrupt = 'shape';
        throw err;
    }
    return arr;
}

// Пишем через durable-write, а не голым tmp+rename: у Outlook запись идёт `writeFileSync`
// плюс `renameSync` без fsync, и после BSOD это даёт файл нулевых байт при сохранённом
// размере (инцидент 13.09, разбор - в шапке `routing/lib/durable-write.js`).
function save(arr) {
    // 🪤 Перед записью сверяем то, что лежит на диске. Иначе порядок «прочитал битый файл -
    // записал одну новую запись» тихо превращает нулёвку в огрызок, и восстанавливать
    // становится нечего. Проверка стоит здесь, а не только в `load`, потому что `load`
    // можно обойти (запись пришла из ручки, которая пул не читала).
    try { durable.assertNotZeroed(fs.readFileSync(FILE, 'utf8'), 'Google-пул'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    durable.writeJsonSync(FILE, arr);
    return arr;
}

// ── мелочи предметной области ────────────────────────────────────────────────

const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());
const profileLabel = id => 'acct_' + id;

// Идентификатор записи. Формат как у соседей (`ol_`, `gh_`): метка времени плюс счётчик,
// чтобы две записи, заведённые в одну миллисекунду, не слились.
// 🪤 `arr` — это ТЕКУЩИЙ пул, и он нужен не для красоты: свободный идентификатор ищется
// по нему. Передашь пустой массив на каждую запись - две записи, заведённые в одну
// миллисекунду, получат ОДИН id, а вместе с ним и один общий профиль на диске. Ручки
// (`add`, `import`) поэтому передают растущий массив, а не исходный.
function newId(arr, now = Date.now()) {
    const have = new Set((arr || []).map(e => String(e.id || '')));
    let i = 0;
    while (have.has(`gg_${now}_${i}`)) i += 1;
    return `gg_${now}_${i}`;
}

// ── разбор пачки ─────────────────────────────────────────────────────────────

// Файлы магазина - это письма-чеки: сверху «Заказ: …», рамки и реклама со ссылками, и
// только потом строки. Строку берём, если в ней есть адрес почты, остальное - шум.
const NOISE_RE = /^(Заказ|Сайт|Ваш заказ|↓|🚨|🕺|https?:)/i;
const NO_EMAIL = 'адреса почты в строке нет';

// Секрет 2FA: base32, только A-Z и 2-7, обычно 16 или 32 знака, пробелы продавцы иногда
// ставят группами. Регистр не важен, но в записи храним верхним: так его ест генератор кода.
function looksLikeTotp(s) {
    const v = String(s || '').replace(/[\s-]+/g, '');
    return /^[A-Z2-7]{16,}$/i.test(v);
}

// Разделитель ищем по строке, а не задаём: магазины отдают `:`, `;`, `|` и табы.
// 🪤 Табы проверяются первыми: в файлах магазина таб - разделитель ПОЛЕЙ, а `:` внутри
// поля (в том числе внутри пароля). Обратная сторона: у строки `почта\tпароль:секрет`
// пароль склеится с секретом. Это лечится не выбором разделителя, а в `parseLine` -
// см. `splitGluedTotp`.
function splitFields(line) {
    const sep = /\t/.test(line) ? /\t+/ : /;/.test(line) && !/:/.test(line) ? /;+/ : /\|/.test(line) ? /\|+/ : /:/;
    return String(line).split(sep).map(s => s.trim()).filter(s => s !== '');
}

// Отклеивает 2FA-секрет от пароля, если строка пришла одним полем. Отклеиваем ТОЛЬКО по
// хвосту: `secret:пароль` такой строкой не считается, потому что решение принимает
// `looksLikeTotp`, а он смотрит на весь хвост целиком. Пароль, который сам кончается на
// `:base32`, практически невозможен, а вот строка `почта\tпароль:JBSWY3DP...` - обычная.
function splitGluedTotp(field) {
    const m = /^(.+?)[;|:]\s*([A-Z2-7][A-Z2-7\s-]{14,})$/i.exec(String(field || ''));
    if (m && looksLikeTotp(m[2])) {
        return { password: m[1].trim(), totpSecret: m[2].replace(/[\s-]+/g, '').toUpperCase() };
    }
    return { password: String(field || ''), totpSecret: '' };
}

// Одна строка → запись или { error }. Позиции полей не фиксируем: адрес ищем по виду,
// пароль берём первым непустым после него, а хвост разбираем по TYPE каждого поля -
// почта едет в `recoveryEmail`, base32 в `totpSecret`, остальное в заметку. Так одна и та
// же функция съедает и `почта:пароль`, и `почта:пароль:секрет`, и
// `почта:пароль:почта-восстановления:секрет`, не зная, в каком порядке их положил магазин.
function parseLine(line) {
    const parts = splitFields(line);
    if (!parts.length) return { error: 'пустая строка' };
    const at = parts.findIndex(isEmail);
    if (at < 0) return { error: NO_EMAIL };
    const email = parts[at].toLowerCase();
    const rest = parts.slice(at + 1);
    const rawPass = rest.length ? rest[0] : '';
    if (!rawPass) return { error: `у ${email} нет пароля` };
    if (looksLikeTotp(rawPass)) {
        // Секрет на месте пароля - это другая раскладка магазина, и угадывать её молча
        // нельзя: вход в профиль пойдёт секретом вместо пароля, и отказ будет под челленджем.
        return { error: `${email}: на месте пароля лежит 2FA-секрет - проверь формат файла` };
    }
    const glued = splitGluedTotp(rawPass);
    const password = glued.password;
    let totpSecret = glued.totpSecret;
    let recoveryEmail = '';
    const tail = [];
    for (const f of rest.slice(1)) {
        if (!f) continue;
        if (!recoveryEmail && isEmail(f)) { recoveryEmail = f.toLowerCase(); continue; }
        if (!totpSecret && looksLikeTotp(f)) { totpSecret = f.replace(/[\s-]+/g, '').toUpperCase(); continue; }
        tail.push(f);
    }
    return {
        email,
        password,
        totpSecret,
        recoveryEmail,
        kind: 'burner',
        note: tail.length ? tail.join(' · ') : '',
    };
}

// Пачка → { entries, errors, duplicates }. Дубли считаем и внутри пачки, и против пула:
// перезалив того же чека не должен плодить второй профиль на тот же аккаунт.
function parseBulk(text, existing) {
    const have = new Set((existing || []).map(a => String(a.email || '').toLowerCase()));
    const seen = new Set();
    const entries = [], errors = [], duplicates = [];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (!line || NOISE_RE.test(line)) return;
        const r = parseLine(line);
        // Строку без адреса считаем шумом чека, а не ошибкой: в письме магазина таких строк
        // больше, чем полезных. Ошибка - это строка С адресом, но без пароля или с
        // перепутанными полями.
        if (r.error === NO_EMAIL) return;
        if (r.error) { errors.push({ line: i + 1, error: r.error }); return; }
        if (have.has(r.email) || seen.has(r.email)) { duplicates.push(r.email); return; }
        seen.add(r.email);
        entries.push(r);
    });
    return { entries, errors, duplicates };
}

// ── правки ───────────────────────────────────────────────────────────────────

const findById = (arr, id) => (arr || []).find(e => String(e.id) === String(id)) || null;

// Достраивает запись до полного набора полей. Секреты здесь НЕ трогаются: этим занят
// `safeView`, и путать эти две вещи нельзя.
function normalize(raw, arr, now = Date.now()) {
    const email = String(raw.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw new Error('адрес не похож на почту');
    const password = String(raw.password ?? '');
    if (!password) throw new Error('пароль обязателен - без него в профиль не войти');
    const kind = KINDS.includes(raw.kind) ? raw.kind : 'burner';
    return {
        id: String(raw.id || newId(arr, now)),
        email,
        password,
        totpSecret: String(raw.totpSecret || '').replace(/[\s-]+/g, '').toUpperCase(),
        phone: String(raw.phone || '').trim(),
        recoveryEmail: String(raw.recoveryEmail || '').trim().toLowerCase(),
        proxy: String(raw.proxy || '').trim(),
        kind,
        nickname: String(raw.nickname || '').trim() || email.split('@')[0],
        status: STATUSES.includes(raw.status) ? raw.status : 'unknown',
        note: String(raw.note || ''),
        addedAt: raw.addedAt || new Date(now).toISOString(),
        sessionAt: raw.sessionAt || null,
        lastCheck: raw.lastCheck || null,
        usedOn: Array.isArray(raw.usedOn) ? raw.usedOn : [],
    };
}

// То, что уезжает в список. Пароль и 2FA-секрет здесь ОТСУТСТВУЮТ: список запрашивается
// опросом раз в 15 секунд на открытой вкладке, и секретам там делать нечего. За секретами
// фронт идёт отдельным запросом, и только когда человек нажал «глаз» или «скопировать».
function safeView(e) {
    const o = normalize(e, null, Date.now());
    const { password, totpSecret, ...rest } = o;
    return { ...rest, hasPassword: !!password.length, hasTotp: !!totpSecret.length };
}

module.exports = {
    DIR, FILE, PROFILES_DIR, SESSIONS_DIR, STATUSES, KINDS,
    load, save, isEmail, looksLikeTotp, profileLabel, newId,
    splitFields, splitGluedTotp, parseLine, parseBulk, findById, normalize, safeView,
};
