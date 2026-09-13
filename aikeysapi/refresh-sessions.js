// aikeysapi/refresh-sessions.js
//
// Дозаполняет `sessionCookie` + `newApiUserId` в записях пула, у которых есть пароль,
// но нет живой сессии. Нужно потому, что точный баланс (`/api/user/self`) требует
// авторизации: без cookie дашборд показывал «~ прикидку» либо просил открыть ЛК руками.
//
// HTTP-авторег пишет сессию сразу при создании аккаунта (см. auto-add.js) — этот скрипт
// для тех записей, что появились РАНЬШЕ этого и для добавленных вручную.
//
// Запуск: node aikeysapi/refresh-sessions.js [--dry-run]
//
// 🪤 Пишем мерж-дописыванием по тому же правилу, что и пул: дашборд правит этот файл
// параллельно, поэтому обновляем ТОЛЬКО поля сессии у найденной записи, а не файл целиком.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { panel, cookieHeader, nextUserAgent, writeProfileSession } = require('./auto-add.js');

const POOL_FILE = path.join(__dirname, '..', 'routing', 'aikeysapi-sessions.json');
const DRY = process.argv.includes('--dry-run');

// 🪤 Снимок БЕЗ состояния входа SPA считаем негодным, а не «уже есть».
//
// Панель ZhiFlow — SPA на New API: признак «вошёл» она держит в localStorage (`user`),
// а куку возит как транспорт. Снимок из одной куки открывает ФОРМУ ВХОДА, хотя
// `/api/user/self` по ней отвечает 200. Проверено 12.09 в headless: только кука → логин,
// кука + `user` → консоль. Все снимки, собранные до этой правки, — именно такие.
function snapshotHasSpaUser(file) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        return (j.origins || []).some(o =>
            (o.localStorage || []).some(e => e.name === 'user' && e.value));
    } catch { return false; }
}

function load() {
    const raw = fs.readFileSync(POOL_FILE, 'utf8');
    const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    if (!Array.isArray(arr)) throw new Error('пул не массив');
    return arr;
}

function save(arr) {
    const dir = path.dirname(POOL_FILE);
    const tmp = path.join(dir, `.aikeysapi-sessions.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, POOL_FILE);
}

async function login(rec, ua) {
    const r = await panel('POST', '/api/user/login?turnstile=', {
        body: { username: rec.name, password: rec.password }, ua,
    });
    if (!r.json || r.json.success !== true || !r.json.data || !r.json.data.id) {
        return { ok: false, why: (r.json && r.json.message) || r.error || `HTTP ${r.status}` };
    }
    const cookie = cookieHeader(r.setCookie);
    if (!cookie) return { ok: false, why: 'панель не поставила куку session' };
    return { ok: true, cookie, uid: r.json.data.id };
}

(async () => {
    const arr = load();
    let fixed = 0, failed = 0, skipped = 0;

    for (const rec of arr) {
        if (!rec.password) { skipped++; console.log(`— ${rec.email}: нет пароля, пропуск`); continue; }

        // 🪤 Проверяем не только куку, но и СНИМОК профиля. Записи, заведённые до
        // появления writeProfileSession, имеют живую куку и при этом не имеют снимка —
        // на «кука есть → пропуск» они навсегда остались бы без входа в ЛК по 🌐.
        const snapFile = path.join(__dirname, 'sessions', `acct_${rec.id}.json`);
        const hasSnap = fs.existsSync(snapFile);
        if (rec.sessionCookie && rec.newApiUserId && hasSnap && snapshotHasSpaUser(snapFile)) {
            skipped++;
            console.log(`= ${rec.email}: сессия и снимок уже есть`);
            continue;
        }
        const needLogin = !rec.sessionCookie || !rec.newApiUserId;
        if (!needLogin) {
            console.log(hasSnap
                ? `· ${rec.email}: снимок без состояния входа SPA — пересобираю`
                : `· ${rec.email}: кука есть, нет снимка — только снимок`);
        }

        // Кука есть — берём её и не дёргаем логин зря (панель под CriticalRateLimit).
        // Логинимся только когда куки действительно нет.
        let r;
        if (!needLogin) {
            r = { ok: true, cookie: rec.sessionCookie, uid: rec.newApiUserId };
        } else {
            const ua = nextUserAgent();
            try { r = await login(rec, ua); }
            catch (e) { r = { ok: false, why: e.message }; }
        }

        if (!r.ok) {
            failed++;
            console.log(`✗ ${rec.email}: ${r.why}`);
            continue;
        }
        if (!DRY && needLogin) {
            rec.sessionCookie = r.cookie;
            rec.sessionCookieAt = new Date().toISOString();
            rec.newApiUserId = r.uid;
            save(arr);
        }
        // Снимок профиля — чтобы кнопка 🌐 открывала ЛК УЖЕ залогиненной. Без него
        // владелец вводит пароль руками при первом входе (пароль в записи есть, так что
        // это не блокер, но лишний шаг). Пишем и в --dry-run: файл безвредный, а
        // посмотреть результат хочется до боевого прогона.
        //
        // Состояние входа SPA берём тем же запросом, которым дашборд читает баланс:
        // без `user` в localStorage снимок открывает форму входа (см. snapshotHasSpaUser).
        let spaUser = null;
        try {
            const me = await panel('GET', '/api/user/self', { cookie: r.cookie, userId: r.uid, ua: nextUserAgent() });
            if (me.json && me.json.success && me.json.data) spaUser = me.json.data;
            else console.log(`   ⚠️ /api/user/self не отдал профиль (HTTP ${me.status}) — снимок будет без входа SPA`);
        } catch (e) { console.log(`   ⚠️ профиль не получен: ${e.message}`); }

        let snap = null;
        try { snap = writeProfileSession(rec.id, r.cookie, spaUser); }
        catch (e) { console.log(`   ⚠️ снимок не записан: ${e.message}`); }
        fixed++;
        console.log(`${DRY ? '·' : '✓'} ${rec.email}: сессия обновлена (id ${r.uid})${snap ? `, снимок ${require('path').basename(snap)}` : ''}`);
    }

    console.log(`\nИтого: обновлено ${fixed}, ошибок ${failed}, пропущено ${skipped}${DRY ? ' (--dry-run)' : ''}`);
    process.exit(failed && !fixed ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
