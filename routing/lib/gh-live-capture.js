// routing/lib/gh-live-capture.js
//
// Ручной вход в GitHub внутри профиля тоже должен сохраниться.
//
// Как было: <provider>/open-session.js снимает копию GitHub-сессии ОДИН РАЗ — сразу
// после открытия окна — и уходит спать до закрытия (`new Promise(() => {})`). Всё, что
// человек делает дальше, в копию не попадало, а приходит он ровно за этим: жмёт
// «Continue with GitHub», логинится руками, GitHub выдаёт новый `user_session`. На диске
// при этом остаётся снимок ДО входа. Ссылаться на «оно и так в профиле» нельзя: Chromium
// пишет куки в SQLite лениво, и закрытие окна по Ctrl+C флаш не гарантирует — ровно так
// профиль `acct_ar_1786714708319_0` две недели жил на заселённой сессии от 20.08, хотя
// вход руками делали позже (замер 22.08: `user_session` в копии = seed от 20.08).
//
// Что делает модуль: пока окно открыто, каждые POLL_MS опрашивает банку кук КОНТЕКСТА
// (это память, флаш на диск не нужен) и, как только видит новый `user_session`,
//   1) перезаписывает <provider>/gh-sessions/<label>.json — источник, из которого чек-ин
//      возвращает сессию, если GitHub погасит её сам;
//   2) обновляет общий снимок github/sessions/<ghId>.json, если у записи пула есть
//      привязка `gh_…` — тот самый снимок, которым заселяют профили новых аккаунтов.
//
// Сырых запросов к github.com здесь нет и быть не должно: фейковый UA GitHub считает
// угоном и гасит сессию (см. routing/lib/github-session.js).

const fs = require('fs');
const path = require('path');
// Durable-запись: менеджер GitHub-аккаунтов — реестр, по которому берут сессии.
const { writeJsonSync: durableWriteJson } = require('./durable-write');

const POLL_MS = 5 * 1000;

function isGithubCookie(c) {
    const d = String((c && c.domain) || '').replace(/^\./, '');
    return d === 'github.com' || d.endsWith('.github.com');
}

function isGithubOrigin(o) {
    return /^https:\/\/([\w-]+\.)*github\.com$/i.test(String((o && o.origin) || ''));
}

function userSessionOf(cookies) {
    const c = (cookies || []).find(x => x.name === 'user_session' && x.value);
    return c ? c.value : null;
}

// Пул провайдера: массив записей либо {sessions:[…]}. Нужен ровно один факт — какой
// GitHub привязан к записи (поле ghId), чтобы обновить и общий снимок.
function ghIdForLabel(poolFile, label) {
    try {
        const id = String(label || '').replace(/^acct_/, '');
        const raw = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
        const arr = Array.isArray(raw) ? raw : (raw.sessions || raw.list || []);
        const rec = arr.find(s => String(s.id) === id);
        const ghId = rec && rec.ghId;
        return /^gh_/.test(String(ghId || '')) ? ghId : null;
    } catch { return null; }
}

// Личный GitHub владельца помечен в пуле маркером `ghId: 'personal'` — это метка «мой,
// не из пула»: по ней рисуется фиолетовый бейдж и работает isOwnerAccount. Своя запись в
// хранилище у него при этом ЕСТЬ (`login: WormAlien`), просто пул на неё не ссылается.
// Поэтому id для общего снимка достаём по логину из живых кук (`dotcom_user`): маркер в
// пуле не трогаем, а снимок всё равно попадает под правильный id и уходит на заселение
// новых профилей. Тот же путь спасает записи вообще без привязки.
function ghIdByLogin(accountsFile, login) {
    if (!login) return null;
    try {
        const want = String(login).toLowerCase();
        const raw = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
        const arr = Array.isArray(raw) ? raw : (raw.accounts || raw.keys || []);
        const hits = arr.filter(a => [a.login, a.nickname, a.nick, a.email]
            .some(v => String(v || '').toLowerCase() === want ||
                       String(v || '').toLowerCase().split('@')[0] === want));
        // Двусмысленность не разруливаем молча: два аккаунта под одним ником — повод
        // ничего не писать, а не выбирать первый попавшийся.
        return hits.length === 1 ? hits[0].id : null;
    } catch { return null; }
}

function makeCapture({ label, moduleDir, poolFile }) {
    const backupDir = path.join(moduleDir, 'gh-sessions');
    const backupFile = path.join(backupDir, label + '.json');
    const sharedDir = path.join(moduleDir, '..', 'github', 'sessions');
    const accountsFile = path.join(moduleDir, '..', 'routing', 'github-accounts.json');

    // Что уже лежит на диске. Сравниваем по значению user_session: сессия скользящая,
    // GitHub ротирует куку — новое значение и есть признак «вход был».
    function savedUserSession() {
        try {
            return userSessionOf(JSON.parse(fs.readFileSync(backupFile, 'utf8')).cookies);
        } catch { return null; }
    }

    // Сессионные куки (expires ≤ 0) не сохраняем: они умирают вместе с браузером,
    // восстанавливать их бессмысленно. Формат файла — тот же, что у saveGhBackup.
    function writeBackup(cookies) {
        const keep = cookies.filter(c => isGithubCookie(c) && c.expires > 0);
        if (!keep.length) return 0;
        fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(backupFile,
            JSON.stringify({ savedAt: new Date().toISOString(), cookies: keep }, null, 2) + '\n', 'utf8');
        return keep.length;
    }

    // Общий снимок для заселения новых профилей. Формат — как у github/harvest-session.js,
    // иначе open-session.js не примет его за seed:'github'.
    async function writeShared(context, ghId, cookies) {
        const state = await context.storageState().catch(() => null);
        if (!state) return false;
        const ghCookies = (state.cookies || []).filter(isGithubCookie);
        if (!userSessionOf(ghCookies)) return false;
        const origins = (state.origins || []).filter(isGithubOrigin);
        const login = ((cookies || []).find(c => c.name === 'dotcom_user') || {}).value || null;
        fs.mkdirSync(sharedDir, { recursive: true });
        fs.writeFileSync(path.join(sharedDir, ghId + '.json'), JSON.stringify({
            seed: 'github',
            ghLogin: login,
            harvestedAt: new Date().toISOString(),
            verifiedAt: new Date().toISOString(),
            source: path.join(moduleDir, 'profiles', label),
            cookies: ghCookies,
            origins,
        }, null, 2) + '\n', 'utf8');
        return true;
    }

    // Что уже лежит в ОБЩЕМ снимке под этим id. Нужно, чтобы не переписывать файл на каждом
    // замере, но и не пропустить случай «копия профиля свежая, а снимка нет».
    function sharedUserSession(ghId) {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(sharedDir, ghId + '.json'), 'utf8'));
            return userSessionOf(j.cookies);
        } catch { return null; }
    }

// Под каким id ложится общий снимок. Привязка `gh_…` в пуле — прямой ответ; маркер
    // `personal` и пустая привязка — через логин из живых кук. Если логин не сошёлся ни
    // с одной записью хранилища (или сошёлся с двумя), снимок не пишем вообще: пусть
    // лучше не будет, чем встанет под чужой id.
    function resolveGhId(login) {
        const fromPool = poolFile ? ghIdForLabel(poolFile, label) : null;
        if (fromPool) return fromPool;
        return ghIdByLogin(accountsFile, login);
    }

    // Оживить запись менеджера если она была dead. Вызывается после успешного writeShared:
    // только что сняли живую user_session — значит аккаунт живой, каким бы ни был статус.
    // Перезаписываем минимально: только status и harvestedAt — не трогаем пароли и коды.
    function reviveIfDead(ghId) {
        if (!ghId || !accountsFile) return;
        try {
            const raw = fs.readFileSync(accountsFile, 'utf8');
            const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            if (!Array.isArray(arr)) return;
            const rec = arr.find(a => a.id === ghId);
            if (!rec || rec.status === 'live') return;
            const old = rec.status;
            rec.status = 'live';
            rec.revivedAt = new Date().toISOString();
            durableWriteJson(accountsFile, arr);
            console.log(`🟢 GitHub-менеджер: ${ghId} (${rec.nickname || rec.login || '?'}) был ${old} — оживлён по свежей сессии`);
        } catch (e) {
            console.log(`⚠️  не удалось оживить ${ghId} в менеджере: ${e.message}`);
        }
    }

    // Один замер. Возвращает true, если сессия оказалась новой и копия обновлена.
    async function captureOnce(context, { quiet = false } = {}) {
        const cookies = await context.cookies('https://github.com').catch(() => []);
        const live = userSessionOf(cookies);
        if (!live) return false;
        // Сессия не изменилась — копию не пишем, но менеджер всё равно оживляем:
        // человек мог зайти через провайдера с тем же user_session, а запись в
        // менеджере при этом dead/cooldown.
        if (live === savedUserSession()) {
            const login = ((cookies || []).find(c => c.name === 'dotcom_user') || {}).value || null;
            const ghId = resolveGhId(login);
            if (ghId) {
                // Копия профиля уже свежая — но это про ЭТОТ шлюз. Общий снимок мог не
                // записаться вовсе: запись привязалась к GitHub позже, файл снесли, логин
                // разошёлся. Тогда следующие шлюзы засеют старьё, хотя живая сессия лежит
                // прямо здесь, — ровно это владелец назвал 21.09 «нет сохранения гитхаба
                // для других провайдеров». Досылаем, только если снимка/сессии там нет.
                if (sharedUserSession(ghId) !== live) {
                    if (!quiet) console.log(`🐙 общий снимок ${ghId} был не от этой сессии — досылаю`);
                    await writeShared(context, ghId, cookies);
                }
                reviveIfDead(ghId);
            }
            return false;
        }
        try {
            const n = writeBackup(cookies);
            if (!n) return false;
            if (!quiet) console.log(`🐙 ручной вход в GitHub сохранён (${n} кук) — чек-ин сможет его вернуть`);
            const login = ((cookies || []).find(c => c.name === 'dotcom_user') || {}).value || null;
            const ghId = resolveGhId(login);
            if (ghId && await writeShared(context, ghId, cookies)) {
                if (!quiet) console.log(`   общий снимок ${ghId}${login ? ` (${login})` : ''} обновлён — новые профили заселятся этой сессией`);
                reviveIfDead(ghId);
            }
            return true;
        } catch (e) {
            console.log(`⚠️  копию GitHub-сессии сохранить не удалось: ${e.message}`);
            return false;
        }
    }

    // Замена `await new Promise(() => {})`: так же держит скрипт до закрытия окна,
    // но по дороге забирает ручной вход. Промис не резолвится — закрытие контекста
    // роняет процесс сам, как и раньше.
    //
    // Замер идёт ДВУМЯ путями, и второй обязателен. Таймер раз в POLL_MS ловит вход,
    // случившийся в открытом окне; но вход через GitHub заканчивается редиректом
    // OAuth-колбэка, и человек закрывает окно через секунды после «Вход выполнен» —
    // замер 21.09: логин в 21:47:27, выход в 21:47:29, тик в это окно не попал, сессия
    // не сохранилась ни в копию, ни в общий снимок. Поэтому второй путь — навигация
    // страницы: к моменту колбэка новая кука уже в контексте, и замер успевает.
    // busy не даёт наложениям замеров писать файлы одновременно.
    function holdOpen(context) {
        return new Promise(() => {
            let busy = false;
            const ping = () => {
                if (busy) return;
                busy = true;
                captureOnce(context).catch(() => {}).finally(() => { busy = false; });
            };
            const timer = setInterval(ping, POLL_MS);
            const watch = p => { try { p.on('framenavigated', ping); } catch { /* страница уже мертва */ } };
            for (const p of context.pages()) watch(p);
            context.on('page', watch);
            context.on('close', () => clearInterval(timer));
        });
    }

    return { captureOnce, holdOpen, backupFile };
}

module.exports = { makeCapture, isGithubCookie, userSessionOf, ghIdForLabel, ghIdByLogin, POLL_MS };
