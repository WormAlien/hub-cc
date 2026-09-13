// rumeng/refresh-sessions.js
//
// Пересобирает снимки входа для кнопки 🌐 у записей пула 如梦AI, где есть пароль.
// Снимок `rumeng/sessions/acct_<id>.json` — это то, что `open-session.js` кладёт в чистый
// профиль, чтобы браузер открылся УЖЕ ЗАЛОГИНЕННЫМ, а не на форме входа.
//
// Запуск: node rumeng/refresh-sessions.js [--dry-run] [--force]
//   --dry-run  не трогать пул (снимки всё равно пишутся — они безвредны)
//   --force    пересобрать даже те записи, у которых снимок выглядит живым
//
// 🪤 Пул правит дашборд параллельно, поэтому перед записью файл ПЕРЕЧИТЫВАЕТСЯ, и в свежую
// копию мержатся только поля сессии найденной записи. Иначе мы затрём чужую правку
// (переименование, активацию, баланс), сделанную за время нашего прогона.
//
// ─────────────────────── чем это НЕ как aikeysapi/refresh-sessions.js ───────────────────────
//
// 🔴 ГЛАВНОЕ: у 如梦AI вход — JWT, а не кука. Панель не ставит куку сессии вообще, поэтому
// `sessionCookie` здесь нечем наполнять, а признаком «снимок годный» служит наличие
// **`auth_token`** в `origins[].localStorage`.
//
// 🔴 И ЕЩЁ РАЗ ПРО ИМЯ КЛЮЧА, потому что это единственная ловушка, которую нельзя угадать:
// по проводу ручки отдают поле **`access_token`**, а SPA кладёт его в localStorage под
// именем **`auth_token`** и оттуда же читает. Снимок с ключом `access_token` выглядит
// правильным и открывает ФОРМУ ВХОДА. Имена сверены с живым бандлом 13.09:
//     function me(e){ localStorage.setItem("auth_token", e) }
//
// 🔴 СНИМОК УМЕЕТ ПРОТУХАТЬ ПО ЧАСАМ, и это тоже отличие от куки. Панель хранит срок в
// `token_expires_at` (мс эпохи) и, когда он вышел, перехватчик молча уводит на `/login`.
// Поэтому «снимок есть» — недостаточное условие: проверяем ещё и срок, и живым запросом
// `/auth/me`, иначе кнопка 🌐 будет открывать логин при формально существующем файле.
//
// 🪤 ПОЧЕМУ ЖИВОЙ ЗАПРОС, А НЕ ТОЛЬКО СРОК В ФАЙЛЕ. Замер 13.09: с заведомо мёртвым
// токеном кабинет рисуется и держится ~16 СЕКУНД — ключ на месте, формы входа нет,
// URL `/dashboard`, — и лишь потом перехватчик получает 401 и выкидывает на `/login`.
// Значит проверка «ключ есть → сессия живая» отвечает ДА на мёртвой сессии, и владелец
// увидел бы кабинет, который через несколько секунд сам схлопнется в логин. Токен на
// живость спрашиваем у панели.
//
// 🪤 Файл САМОДОСТАТОЧЕН — не тянет ничего из `rumeng/auto-add.js`, хотя образец тянул из
// соседа. Причина конкретная: auto-add пишется параллельно другим агентом, и `require`
// на файл, который прямо сейчас редактируют, роняет скрипт целиком. Зависимость поэтому
// развёрнута в безопасную сторону: снимок пишется ЗДЕСЬ и отсюда же экспортируется, а
// auto-add при желании импортирует готовое (см. module.exports внизу).

'use strict';

const fs = require('fs');
const path = require('path');

const HOST = 'api.rumeng-ai.com';
const ORIGIN = `https://${HOST}`;
const BASE = `${ORIGIN}/api/v1`;

const POOL_FILE = path.join(__dirname, '..', 'routing', 'rumeng-sessions.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// Те же имена ключей, что пишет сам сайт при входе. Менять только вместе с бандлом.
const TOKEN_KEY = 'auth_token';
const REFRESH_KEY = 'refresh_token';
const EXPIRES_KEY = 'token_expires_at';
const USER_KEY = 'auth_user';
const CONSENT_KEY = 'sub2api_login_agreement_consent';

// Запас, с которым токен считаем протухшим: сессия, живущая ещё минуту, до ЛК не доедет.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

const REQ_TIMEOUT_MS = 30000;
const GAP_MS = 1500;

// 🔴 СЕССИЯ ПРИВЯЗАНА К USER-AGENT. Это третья причина, по которой кнопка 🌐 открывает
// логин, и она не видна ни в токене, ни в сроке его жизни.
//
// Замер 13.09 на живом аккаунте (`userId=190`), один и тот же `accessToken`, менялся
// ТОЛЬКО заголовок `User-Agent`:
//     200  UA из записи пула (Chrome/151)       success
//     401  Chrome/999 (чужой)                   Session network fingerprint changed
//     401  Chrome/140 (константа этого файла)   Session network fingerprint changed
//     401  без заголовка UA                     Session network fingerprint changed
//
// Проверка на строгость: правка ОДНОЙ цифры версии (151 → 150) уже даёт 401, отрезанный
// хвост `Safari/537.36` — тоже. Совпадение требуется побайтовое (лишний пробел в конце
// сервер прощает — он его обрезает).
//
// ⇒ Авторега выдаёт каждому аккаунту свой UA и кладёт его в запись полем `userAgent`.
// Ходить константой — значит получить 401 на ЖИВЫХ токенах и пометить их мёртвыми;
// диагноз выглядел бы как «токен протух», хотя протухло только совпадение отпечатка.
// Поэтому UA всегда берём ИЗ ЗАПИСИ, а константа ниже — лишь фолбэк для записей без поля
// (заведённых руками или до появления `userAgent`).
const UA_FALLBACK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const recordUA = rec => (rec && typeof rec.userAgent === 'string' && rec.userAgent.trim())
    ? rec.userAgent
    : UA_FALLBACK;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Секреты в консоль не печатаем: маска оставляет ровно столько, чтобы отличить один
// токен от другого в логе, и ни байтом больше.
const mask = v => {
    const s = String(v || '');
    return s ? `${s.slice(0, 6)}…(${s.length})` : '(пусто)';
};

// ───────────────────────────── HTTP к панели ─────────────────────────────

// 🪤 `ua` — обязательный по смыслу параметр, хоть и с фолбэком: запрос к аккаунту чужим
// агентом получит 401 «Session network fingerprint changed» на живом токене.
async function api(method, route, { body, token, ua } = {}) {
    const headers = {
        Accept: 'application/json',
        'User-Agent': ua || UA_FALLBACK,
        Origin: ORIGIN,
        Referer: `${ORIGIN}/login`,
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const r = await fetch(BASE + route, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* панель иногда отдаёт html при 5xx */ }
        return { status: r.status, json, text };
    } catch (e) {
        return { status: 0, json: null, text: '', error: e.message };
    }
}

// Панель заворачивает полезную нагрузку в конверт `{code, message, data}`, но не всегда:
// часть ручек отдаёт объект напрямую. Разворачиваем оба вида, чтобы не ловить «токена нет»
// на успешном ответе.
function unwrap(json) {
    if (!json || typeof json !== 'object') return null;
    if (json.data && typeof json.data === 'object') return json.data;
    return json;
}

function apiError(r) {
    const j = r.json || {};
    return j.message || j.reason || j.error || r.error || `HTTP ${r.status}`;
}

// ───────────────────────────── пул ─────────────────────────────

function load() {
    if (!fs.existsSync(POOL_FILE)) {
        // Пул заводит вкладка дашборда/авторега, не этот скрипт: молча создавать файл
        // здесь — значит однажды разойтись с их форматом.
        throw new Error(`пула нет: ${POOL_FILE} (аккаунты ещё не заводились)`);
    }
    const raw = fs.readFileSync(POOL_FILE, 'utf8');
    const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    if (!Array.isArray(arr)) throw new Error('пул не массив');
    return arr;
}

// Мерж-запись: перечитываем файл (дашборд мог его поправить, пока мы ходили в сеть) и
// вписываем только поля сессии нужной записи. Пишем через временный файл + rename, чтобы
// читатель никогда не увидел половину JSON.
function saveSessionFields(recordId, fields) {
    let arr;
    try { arr = load(); } catch { return false; }
    const rec = arr.find(x => x && x.id === recordId);
    if (!rec) return false;
    Object.assign(rec, fields);
    const dir = path.dirname(POOL_FILE);
    const tmp = path.join(dir, `.rumeng-sessions.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, POOL_FILE);
    return true;
}

// ───────────────────────────── снимок ─────────────────────────────

// Снимок состояния входа для кнопки 🌐.
//
// 🪤 Кладём ВСЕ ЧЕТЫРЕ ключа, а не один токен. `auth_token` пускает в кабинет, но без
// `refresh_token` и `token_expires_at` SPA не сможет продлить сессию сама и выкинет
// владельца на логин ровно в тот момент, когда токен истечёт прямо в открытом окне.
// `auth_user` — профиль для шапки; без него интерфейс поднимается пустым.
//
// Согласие с условиями кладём сюда же: модалка 条款更新通知 перегораживает страницу и
// залогиненному пользователю тоже, а её ревизию мы всё равно уже спросили у сервера.
function sessionStateFromJwt({ accessToken, refreshToken, expiresIn, user, consentRevision }) {
    if (!accessToken) return null;
    const ls = [{ name: TOKEN_KEY, value: String(accessToken) }];
    if (refreshToken) ls.push({ name: REFRESH_KEY, value: String(refreshToken) });
    if (expiresIn) ls.push({ name: EXPIRES_KEY, value: String(Date.now() + Number(expiresIn) * 1000) });
    if (user && typeof user === 'object') ls.push({ name: USER_KEY, value: JSON.stringify(user) });
    if (consentRevision) {
        ls.push({
            name: CONSENT_KEY,
            value: JSON.stringify({ revision: consentRevision, accepted_at: new Date().toISOString() }),
        });
    }
    // Куки у панели нет вообще — поле держим пустым массивом ради формата storageState,
    // который читает open-session.js.
    return { cookies: [], origins: [{ origin: ORIGIN, localStorage: ls }] };
}

function snapshotFile(recordId) {
    return path.join(SESSIONS_DIR, `acct_${recordId}.json`);
}

function writeProfileSession(recordId, payload) {
    const state = sessionStateFromJwt(payload);
    if (!state) return null;
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const file = snapshotFile(recordId);
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    return file;
}

// 🪤 Снимок БЕЗ `auth_token` считаем негодным, а не «уже есть» — прямой аналог
// `snapshotHasSpaUser` у образца. Там признаком входа SPA был `user` при живой куке;
// здесь куки нет вовсе, и весь вход — это один ключ localStorage. Файл, в котором его
// нет (или лежит `access_token`, как подсказывает имя поля в ответе API), молча открывает
// форму входа.
function snapshotHasJwt(file) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        return (j.origins || []).some(o =>
            (o.localStorage || []).some(e => e.name === TOKEN_KEY && e.value));
    } catch { return false; }
}

// Срок жизни из самого снимка. Возвращает null, если срока в файле нет — тогда судить
// о протухании нечем и решает уже проверка живым запросом.
function snapshotExpiresAt(file) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const o of j.origins || []) {
            for (const e of o.localStorage || []) {
                if (e.name === EXPIRES_KEY) {
                    const n = parseInt(e.value, 10);
                    return Number.isFinite(n) ? n : null;
                }
            }
        }
    } catch { /* битый файл = пересобрать */ }
    return null;
}

function snapshotToken(file) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const o of j.origins || []) {
            for (const e of o.localStorage || []) {
                if (e.name === TOKEN_KEY) return e.value || null;
            }
        }
    } catch { /* битый файл */ }
    return null;
}

// ───────────────────────────── вход ─────────────────────────────

async function login(rec) {
    const ua = recordUA(rec);
    const r = await api('POST', '/auth/login', { body: { email: rec.email, password: rec.password }, ua });
    if (r.status !== 200) return { ok: false, why: apiError(r) };
    const d = unwrap(r.json);
    // Панель умеет требовать второй фактор. Без него токена не будет, и честнее сказать
    // об этом прямо, чем отдать «нет токена» без причины.
    if (d && d.requires_2fa === true) return { ok: false, why: 'аккаунт под 2FA — снимок собрать нельзя' };
    if (!d || !d.access_token) return { ok: false, why: apiError(r) || 'панель не отдала access_token' };
    return {
        ok: true,
        accessToken: d.access_token,
        refreshToken: d.refresh_token || null,
        expiresIn: d.expires_in || null,
        user: d.user || null,
        ua,
    };
}

// Продление по refresh-токену.
//
// 📌 `refresh_token` ОДНОРАЗОВЫЙ. Тот, что выдан регистрацией, к моменту первого 401 уже
// потрачен перехватчиком SPA, и прямая проба отвечает `REFRESH_TOKEN_INVALID`. Это
// НОРМАЛЬНОЕ состояние записи, а не её порча: протухший вход чинится повторным
// `POST /auth/login` по паролю из записи. Поэтому неудачный refresh здесь — не ошибка
// аккаунта, а обычная ветка, и на `failed` она не влияет.
async function refresh(refreshToken, ua) {
    const r = await api('POST', '/auth/refresh', { body: { refresh_token: refreshToken }, ua });
    if (r.status !== 200) return { ok: false, why: apiError(r) };
    const d = unwrap(r.json);
    if (!d || !d.access_token) return { ok: false, why: apiError(r) || 'панель не отдала access_token' };
    return {
        ok: true,
        accessToken: d.access_token,
        refreshToken: d.refresh_token || refreshToken,
        expiresIn: d.expires_in || null,
        user: d.user || null,
        ua,
    };
}

// Живость токена — той же ручкой, которой пользуется сама SPA.
// UA обязателен: без него ответ будет 401 даже на полностью живом токене.
async function whoami(token, ua) {
    const r = await api('GET', '/auth/me', { token, ua });
    if (r.status !== 200) return { ok: false, why: apiError(r) };
    const d = unwrap(r.json);
    return d ? { ok: true, user: d.user || d } : { ok: false, why: 'пустой профиль' };
}

// Ревизия соглашения — живая, из настроек панели. Не константа: ревизия меняется, и
// протухшее согласие снова поднимет модалку поверх кабинета.
async function agreementRevision() {
    const r = await api('GET', '/settings/public');
    if (r.status !== 200) return null;
    const d = unwrap(r.json) || {};
    if (d.login_agreement_enabled !== true) return null;
    const docs = Array.isArray(d.login_agreement_documents) ? d.login_agreement_documents : [];
    // Тот же фолбэк, что в бандле SPA: нет явной ревизии — ключ собирается из даты и
    // перечня документов. Повторяем ровно, иначе согласие не совпадёт с ожидаемым.
    return d.login_agreement_revision
        || (docs.length ? `${d.login_agreement_updated_at || ''}:${docs.map(x => `${x.id}:${x.title}`).join('|')}` : null);
}

// ───────────────────────────── прогон ─────────────────────────────

async function main() {
    const arr = load();
    const consentRevision = await agreementRevision();
    console.log(`🗂️  пул: ${POOL_FILE} · записей ${arr.length}`);
    console.log(consentRevision
        ? `📜 ревизия соглашения: ${consentRevision.slice(0, 16)} — кладу согласие в снимок`
        : '📜 соглашение выключено или недоступно — согласие в снимок не кладу');

    let fixed = 0, failed = 0, skipped = 0;

    for (const rec of arr) {
        if (!rec || !rec.id) { skipped++; continue; }
        const who = rec.email || rec.id;
        const ua = recordUA(rec);
        if (!rec.userAgent) console.log(`  ⚠️ ${who}: в записи нет userAgent — иду фолбэком, сессия может не признать отпечаток`);

        const file = snapshotFile(rec.id);
        const hasSnap = fs.existsSync(file);
        const okSnap = hasSnap && snapshotHasJwt(file);
        const expAt = okSnap ? snapshotExpiresAt(file) : null;
        const expired = expAt != null && expAt - EXPIRY_SKEW_MS < Date.now();

        // Годный и не просроченный снимок трогать незачем — но только если не --force и
        // если живой запрос подтверждает токен. Пропуск «по файлу» без проверки и был тем
        // самым «сессия есть», после которого владелец видел логин.
        if (okSnap && !expired && !FORCE) {
            const tok = snapshotToken(file);
            const me = tok ? await whoami(tok, ua) : { ok: false, why: 'в снимке нет токена' };
            if (me.ok) {
                skipped++;
                console.log(`= ${who}: снимок живой (/auth/me отвечает)`);
                continue;
            }
            console.log(`· ${who}: снимок есть, но /auth/me отвечает «${me.why}» — пересобираю`);
        } else if (okSnap && expired) {
            console.log(`· ${who}: снимок протух (${new Date(expAt).toISOString()}) — пересобираю`);
        } else if (hasSnap && !okSnap) {
            console.log(`· ${who}: снимок без ${TOKEN_KEY} — негодный, пересобираю`);
        } else if (!hasSnap) {
            console.log(`· ${who}: снимка нет — собираю`);
        }

        // Токен из САМОЙ ЗАПИСИ может быть ещё живым: авторега кладёт его в пул при
        // создании аккаунта, а снимка при этом может не быть вовсе. Проверяем до всякого
        // логина — это бесплатно и экономит панели лишнюю аутентификацию.
        let r = { ok: false, why: 'нет пути входа' };
        if (rec.accessToken) {
            const me = await whoami(rec.accessToken, ua);
            if (me.ok) {
                r = {
                    ok: true,
                    accessToken: rec.accessToken,
                    refreshToken: rec.refreshToken || null,
                    expiresIn: rec.tokenExpiresIn || null,
                    user: me.user,
                    ua,
                };
                console.log('   ✓ токен из записи пула ещё живой — логин не нужен');
            } else {
                console.log(`   · токен из записи не принят (${me.why})`);
            }
        }

        // 📌 Refresh НЕ пробуем: `refresh_token` одноразовый, и тот, что лежит в записи,
        // к первому 401 уже потрачен перехватчиком SPA (прямая проба даёт
        // `REFRESH_TOKEN_INVALID`). Это нормальное состояние записи, а не её порча.
        // Протухший вход чинится паролем — он в записи и он многоразовый.
        if (!r.ok) {
            if (!rec.password) {
                failed++;
                console.log(`✗ ${who}: токен не принят, а пароля в записи нет — снимок собрать нечем`);
                await sleep(GAP_MS);
                continue;
            }
            r = await login(rec);
            if (r.ok) console.log('   ✓ вошёл паролем, получен свежий токен');
        }

        if (!r.ok) {
            failed++;
            console.log(`✗ ${who}: ${r.why}`);
            await sleep(GAP_MS);
            continue;
        }

        // Профиль для шапки кабинета. Если логин его не отдал — добираем `/auth/me`:
        // снимок без `auth_user` открывает кабинет с пустым пользователем.
        let user = r.user;
        if (!user) {
            const me = await whoami(r.accessToken);
            if (me.ok) user = me.user;
            else console.log(`   ⚠️ /auth/me не отдал профиль (${me.why}) — снимок будет без ${USER_KEY}`);
        }

        let snap = null;
        try {
            snap = writeProfileSession(rec.id, {
                accessToken: r.accessToken,
                refreshToken: r.refreshToken,
                expiresIn: r.expiresIn,
                user,
                consentRevision,
            });
        } catch (e) { console.log(`   ⚠️ снимок не записан: ${e.message}`); }

        if (!DRY) {
            const fields = {
                sessionAt: new Date().toISOString(),
                tokenExpiresAt: r.expiresIn ? new Date(Date.now() + Number(r.expiresIn) * 1000).toISOString() : null,
            };
            if (user && user.id != null) fields.rumengUserId = user.id;
            try { saveSessionFields(rec.id, fields); }
            catch (e) { console.log(`   ⚠️ пул не обновлён: ${e.message}`); }
        }

        fixed++;
        console.log(`${DRY ? '·' : '✓'} ${who}: снимок готов${snap ? ` (${path.basename(snap)})` : ''}`
            + ` · токен ${mask(r.accessToken)}${user && user.id != null ? ` · uid ${user.id}` : ''}`);
        await sleep(GAP_MS);
    }

    console.log(`\nИтого: обновлено ${fixed}, ошибок ${failed}, пропущено ${skipped}${DRY ? ' (--dry-run)' : ''}`);
    if (fixed) console.log('🪤 Проверка не на словах: node rumeng/open-session.js acct_<id> console — должен открыться кабинет, а не логин.');
    process.exit(failed && !fixed ? 1 : 0);
}

if (require.main === module) {
    main().catch(e => { console.error('ERR', e.message); process.exit(1); });
}

// Экспортируем писателя снимка, чтобы авторега (`rumeng/auto-add.js`) не заводила ВТОРУЮ
// реализацию формата. Расхождение здесь не падает, а тихо ломает кнопку 🌐 у новых
// аккаунтов — ровно тот класс багов, ради которого образец держит формат в одном месте.
module.exports = {
    HOST, ORIGIN, BASE, POOL_FILE, SESSIONS_DIR,
    TOKEN_KEY, REFRESH_KEY, EXPIRES_KEY, USER_KEY, CONSENT_KEY,
    api, unwrap, login, refresh, whoami, agreementRevision,
    sessionStateFromJwt, writeProfileSession, snapshotHasJwt, snapshotFile,
};
