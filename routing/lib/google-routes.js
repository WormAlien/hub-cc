'use strict';
/*
 * google-routes.js — весь HTTP вкладки Google одним входом.
 *
 * Зачем один вход. Канон добавления вкладки в этот дашборд раскидывает обработчики по
 * лестнице из ~355 предикатов в `transparent-proxy.js`, и у вкладки аккаунтов это выходит
 * боком: там ручки сравнивают `req.url === '/__switch/api/ol/list'` целиком, поэтому любой
 * `?query` мимо них пролетает и вкладка молча получает 404 (разбор - в шапке
 * `routing/lib/media-routes.js`). Здесь весь HTTP живёт в модуле, а в большом файле остаётся
 * ОДНА строка делегирования плюс одна строка подключения лога.
 *
 * 🪤 Секреты наружу уезжают ТОЛЬКО ручкой `keys`, и только по явному запросу. Список
 * (`list`) вкладка опрашивает раз в 15 секунд - паролям и 2FA-секретам там делать нечего
 * (в GitHub-вкладке они едут в каждом опросе; это её изъян, а не образец).
 *
 * 🪤 Креды уходят в скрипт окна ПЕРЕМЕННЫМИ СРЕДЫ, а не аргументами: argv виден в диспетчере
 * задач любому, кто его откроет.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const durable = require('./durable-write');
const pool = require('./google-pool');

const ROUTING = path.join(__dirname, '..');
const REPO = path.join(ROUTING, '..');
const OPEN_SCRIPT = path.join(REPO, 'google', 'open-session.js');
const PIDS_FILE = path.join(pool.DIR, 'pids.json');
const PREFIX = '/__switch/api/google/';

// Что можно править снаружи. Список закрытый: `id`, `addedAt` и `usedOn` меняет сервер, а не
// форма, и «прими любое поле» здесь означало бы, что фронт правит идентификатор записи.
const EDITABLE = ['status', 'kind', 'note', 'nickname', 'phone', 'recoveryEmail', 'proxy', 'password', 'totpSecret'];

// ── Подключение к хабу ───────────────────────────────────────────────────────
// Лог (`logLine`) и ранний пробник окна живут в `transparent-proxy.js` и передаются сюда
// ИНЪЕКЦИЕЙ, а не копируются: копия рано или поздно разъедется с боевой (тот же довод, что
// у `routing/lib/pooldrop.js`). Без инъекции модуль работает молча - это нужно регрессу.
let hub = { log: () => {}, earlyFailure: null };
function setHub(h) {
    hub = { log: (h && h.log) || (() => {}), earlyFailure: (h && h.earlyFailure) || null };
}

// ── Ответы ───────────────────────────────────────────────────────────────────

function json(res, code, body) {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
}

function readBody(req, limitBytes = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > limitBytes) { reject(new Error('тело запроса больше лимита')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error(`тело не JSON: ${e.message}`)); }
        });
        req.on('error', reject);
    });
}

// ── Маска ────────────────────────────────────────────────────────────────────
// Своя, а не `olMaskEmail` из большого файла: у той же функции другой потребитель, а здесь
// важно ровно одно - адрес аккаунта не должен уехать в лог, который попадает в скриншоты.
const EMAIL_RE = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;
function maskEmail(email) {
    const s = String(email || '').trim();
    const at = s.indexOf('@');
    if (at < 0) return (s.slice(0, 2) || '?') + '***';
    return s.slice(0, Math.min(2, at)) + '***' + s.slice(at);
}
const maskInText = s => String(s || '').replace(EMAIL_RE, m => maskEmail(m));

// ── Карта открытых окон ──────────────────────────────────────────────────────
// 🪤 На диске, а не в памяти: окно сессии - отдельный detached-процесс и переживает рестарт
// `:8200` (в этом весь смысл). Карта в памяти после рестарта пуста, и удаление снесло бы
// профиль у живого браузера - а на Windows это отказ EBUSY, то есть осиротевшая папка.
function readPids() {
    try {
        const raw = fs.readFileSync(PIDS_FILE, 'utf8');
        durable.assertNotZeroed(raw, 'Google-pids');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return doc && typeof doc === 'object' ? doc : {};
    } catch { return {}; }
}
const writePids = doc => durable.writeJsonSync(PIDS_FILE, doc);
function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

// ── Факты о сессии ───────────────────────────────────────────────────────────

const profileDir = id => path.join(pool.PROFILES_DIR, pool.profileLabel(id));
const sessionFile = id => path.join(pool.SESSIONS_DIR, `${id}.json`);

function sessionStat(id) {
    try { return fs.statSync(sessionFile(id)); } catch { return null; }
}

// Запись, какой её видит вкладка: публичная форма пула плюс то, что знает только файловая
// система (профиль, снимок, живо ли окно). Пароля и секрета здесь нет - за ними идут в `keys`.
function cardView(e, pids) {
    const view = pool.safeView(e);
    const st = sessionStat(e.id);
    const pid = pids[e.id];
    return {
        ...view,
        hasProfile: fs.existsSync(profileDir(e.id)),
        sessionFileAt: st ? new Date(st.mtimeMs).toISOString() : null,
        openPid: pidAlive(pid) ? pid : null,
    };
}

// Снимок появился или обновился, пока окно было открыто → переписываем `sessionAt` датой
// файла. Статус НЕ трогаем: вход руками мог кончиться челленджем, и «снимок есть» не значит
// «аккаунт живой» - вердикт ставит владелец.
function refreshSessionAt(id) {
    const st = sessionStat(id);
    if (!st) return;
    const at = new Date(st.mtimeMs).toISOString();
    try {
        const arr = pool.load();
        const cur = pool.findById(arr, id);
        if (!cur || cur.sessionAt === at) return;
        cur.sessionAt = at;
        pool.save(arr);
        hub.log(`google: снимок сессии ${pool.profileLabel(id)} обновлён (${at.slice(0, 16).replace('T', ' ')})`);
    } catch (e) { hub.log(`google: sessionAt не обновлён (${e.message})`); }
}

// ── Маршрутизация ────────────────────────────────────────────────────────────

/**
 * Единственный вход. Возвращает true, если запрос обслужен здесь.
 * В `transparent-proxy.js` этому соответствуют две строки:
 *     const googleRoutes = require('./lib/google-routes');
 *     googleRoutes.setHub({ log: logLine, earlyFailure: sessionOpenEarlyFailure });
 * и одна в лестнице:
 *     if (googleRoutes.handle(req, res)) return;
 */
function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
    if (!url.pathname.startsWith(PREFIX)) return false;
    const route = url.pathname.slice(PREFIX.length);
    Promise.resolve()
        .then(() => dispatch(req, res, route, url.searchParams))
        .catch(e => { if (!res.headersSent) json(res, 500, { error: e.message }); });
    return true;
}

async function dispatch(req, res, route, query) {
    // GET list - всё, что рисует вкладку. Без секретов, это опрос раз в 15 секунд.
    if (req.method === 'GET' && route === 'list') {
        const arr = pool.load();
        const pids = readPids();
        const accounts = arr.map(e => {
            try { return cardView(e, pids); }
            // 🪤 Битый отдельно взятый записи не должно ронять весь список: карточка с
            // ошибкой видна и объясняет себя, а пустая вкладка - нет.
            catch (err) { return { id: e.id || null, email: String(e.email || ''), broken: err.message }; }
        });
        const byStatus = {}, byKind = {};
        for (const a of accounts) {
            if (a.broken) continue;
            byStatus[a.status] = (byStatus[a.status] || 0) + 1;
            byKind[a.kind] = (byKind[a.kind] || 0) + 1;
        }
        return json(res, 200, {
            accounts, byStatus, byKind,
            total: accounts.length,
            withTotp: accounts.filter(a => a.hasTotp).length,
            withSession: accounts.filter(a => a.sessionFileAt).length,
            openWindows: accounts.filter(a => a.openPid).length,
            statuses: pool.STATUSES, kinds: pool.KINDS,
        });
    }

    // GET keys?id=<id> - пароль и 2FA-секрет ОДНОЙ карточки, по нажатию «глаз» или «копировать».
    if (req.method === 'GET' && route === 'keys') {
        const id = query.get('id');
        if (!id) return json(res, 400, { error: 'нужен id' });
        const rec = pool.findById(pool.load(), id);
        if (!rec) return json(res, 404, { error: 'аккаунт не найден' });
        return json(res, 200, {
            id: rec.id,
            email: String(rec.email || ''),
            password: String(rec.password || ''),
            totpSecret: String(rec.totpSecret || ''),
        });
    }

    // POST add - одна запись руками.
    if (req.method === 'POST' && route === 'add') {
        const body = await readBody(req);
        const arr = pool.load();
        const email = String(body.email || '').trim().toLowerCase();
        if (!pool.isEmail(email)) return json(res, 400, { error: 'адрес не похож на почту' });
        if (arr.some(e => String(e.email || '').toLowerCase() === email))
            return json(res, 409, { error: 'такой аккаунт уже есть в пуле' });
        // 🪤 `id` и `addedAt` из тела ВЫБРАСЫВАЕМ: их ставит сервер. Иначе фронт (или тот,
        // кто дёрнул ручку руками) назначает записи чужой идентификатор, и профиль на диске
        // достаётся не той карточке.
        let rec = null;
        try { rec = pool.normalize({ ...body, id: '', addedAt: null, email }, arr); }
        catch (e) { return json(res, 400, { error: e.message }); }
        arr.push(rec);
        pool.save(arr);
        hub.log(`google add: ${maskEmail(email)} (${rec.kind}, ${rec.totpSecret ? 'с 2FA' : 'без 2FA'})`);
        return json(res, 200, { ok: true, id: rec.id, account: cardView(rec, readPids()) });
    }

    // POST import { text, dryRun } - пачка из магазина. Разбор живёт на СЕРВЕРЕ, и предпросмотр
    // идёт тем же кодом, что и запись: у GitHub-вкладки парсер продублирован во фронте, и это
    // зафиксировано как изъян (новая раскладка магазина требует правок в двух местах).
    if (req.method === 'POST' && route === 'import') {
        const body = await readBody(req);
        const text = String(body.text || '');
        if (!text.trim()) return json(res, 400, { error: 'пустой текст' });
        const arr = pool.load();
        const parsed = pool.parseBulk(text, arr);
        const preview = {
            parsed: parsed.entries.length,
            errors: parsed.errors,
            duplicates: parsed.duplicates,
            sample: parsed.entries.slice(0, 5).map(e => ({
                email: e.email, hasTotp: !!e.totpSecret, recoveryEmail: e.recoveryEmail, note: e.note,
            })),
        };
        if (body.dryRun) return json(res, 200, { dryRun: true, ...preview });
        const work = arr.slice();
        const added = [];
        for (const e of parsed.entries) {
            const rec = pool.normalize(e, work);
            work.push(rec);
            added.push(rec);
        }
        if (added.length) pool.save(work);
        hub.log(`google import: разобрано ${parsed.entries.length}, ошибок ${parsed.errors.length}, `
            + `дублей ${parsed.duplicates.length}, записано ${added.length}`);
        return json(res, 200, { ok: true, added: added.map(r => r.id), ...preview });
    }

    // POST update { id, patch } - точечная правка. Пароль и секрет правятся здесь же: опечатка
    // продавца в присланной строке - обычное дело, и заводить ради неё вторую запись незачем.
    if (req.method === 'POST' && route === 'update') {
        const body = await readBody(req);
        const id = body.id;
        const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
        if (!id) return json(res, 400, { error: 'нужен id' });
        const arr = pool.load();
        const i = arr.findIndex(e => String(e.id) === String(id));
        if (i < 0) return json(res, 404, { error: 'аккаунт не найден' });
        const known = Object.keys(patch).filter(k => EDITABLE.includes(k));
        if (!known.length) return json(res, 400, { error: `править нечего - известные поля: ${EDITABLE.join(', ')}` });
        if (patch.status && !pool.STATUSES.includes(String(patch.status)))
            return json(res, 400, { error: `неизвестный статус: ${patch.status}` });
        if (patch.kind && !pool.KINDS.includes(String(patch.kind)))
            return json(res, 400, { error: `неизвестный класс: ${patch.kind}` });
        const next = { ...arr[i] };
        for (const k of known) next[k] = patch[k];
        try { arr[i] = pool.normalize(next, arr); }
        catch (e) { return json(res, 400, { error: e.message }); }
        pool.save(arr);
        // 🪤 Правку пароля в лог не пишем и не намекаем на её содержимое: строка лога уезжает
        // в скриншоты. Достаточно «какие поля тронули».
        hub.log(`google update: ${maskEmail(arr[i].email)} (поля: ${known.join(', ')})`);
        return json(res, 200, { ok: true, account: cardView(arr[i], readPids()) });
    }

    // POST delete { id } - сносит ТРИ вещи в порядке профиль, снимок, запись. Оставленный
    // профиль - не мусор, а ловушка: перезалив того же аккаунта подхватит лежащую там куку,
    // и «свой» аккаунт молча покажет чужую сессию. Файлы идут первыми, и если профиль не
    // удалился (живой Chromium), запись остаётся на месте - лучше видимая ошибка, чем сирота.
    if (req.method === 'POST' && route === 'delete') {
        const body = await readBody(req);
        if (!body.id) return json(res, 400, { error: 'нужен id' });
        const arr = pool.load();
        const i = arr.findIndex(e => String(e.id) === String(body.id));
        if (i < 0) return json(res, 404, { error: 'аккаунт не найден' });
        const target = arr[i];
        const pids = readPids();
        if (pidAlive(pids[target.id]))
            return json(res, 409, { error: `окно этого аккаунта открыто (pid ${pids[target.id]}) - закрой его, иначе профиль на диске не удалится` });
        try {
            fs.rmSync(profileDir(target.id), { recursive: true, force: true });
        } catch (err) {
            return json(res, 409, {
                error: `профиль ${pool.profileLabel(target.id)} не удалился (${err.code || err.message}) - `
                    + 'закрой браузер и повтори, запись оставил на месте',
            });
        }
        try { fs.rmSync(sessionFile(target.id), { force: true }); } catch { /* снимка могло и не быть */ }
        arr.splice(i, 1);
        pool.save(arr);
        delete pids[target.id];
        // Карта окон - вспомогательная: её отказ не повод отвечать ошибкой на уже сделанное
        // удаление (запись и файлы к этому моменту снесены).
        try { writePids(pids); } catch (e) { hub.log(`google: карта окон не обновлена (${e.message})`); }
        hub.log(`google delete: ${maskEmail(target.email)} (профиль ${pool.profileLabel(target.id)} и снимок удалены)`);
        return json(res, 200, { ok: true });
    }

    // POST open { id } - видимое окно Chromium в профиле аккаунта. Вход доводит человек:
    // пароль подставляется, но капчу и челлендж за него не проходит никто.
    if (req.method === 'POST' && route === 'open') {
        const body = await readBody(req);
        if (!body.id) return json(res, 400, { error: 'нужен id' });
        const rec = pool.findById(pool.load(), body.id);
        if (!rec) return json(res, 404, { error: 'аккаунт не найден' });
        const label = pool.profileLabel(rec.id);
        const pids = readPids();
        if (pidAlive(pids[rec.id]))
            return json(res, 200, { ok: true, label, already: true, pid: pids[rec.id] });
        if (!fs.existsSync(OPEN_SCRIPT))
            return json(res, 500, { error: `нет ${OPEN_SCRIPT} - обнови репо (git pull) и обнови страницу` });

        const proc = spawn(process.execPath, [OPEN_SCRIPT, label], {
            detached: true,
            stdio: 'pipe',
            // Профиль привязан к СТАБИЛЬНОМУ id, а не к адресу: смена почты не рвёт сессию.
            env: {
                ...process.env,
                GOOGLE_LABEL: label,
                GOOGLE_EMAIL: String(rec.email || ''),
                GOOGLE_PASS: String(rec.password || ''),
                GOOGLE_TOTP: String(rec.totpSecret || ''),
            },
        });
        // Вывод ребёнка маскируем ЗДЕСЬ, а не в нём: скрипт печатает полный адрес осознанно
        // (его запускают и руками из консоли), а в лог хаба та же строка уезжает сбоку.
        proc.stdout.on('data', d => hub.log(`google open [${label}]: ${maskInText(String(d).trim())}`));
        proc.stderr.on('data', d => hub.log(`google open ERR [${label}]: ${maskInText(String(d).trim())}`));
        proc.on('error', e => hub.log(`google open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => {
            const p = readPids();
            delete p[rec.id];
            writePids(p);
            hub.log(`google open: ${label} - окно закрыто (code ${code}, sig ${sig})`);
            refreshSessionAt(rec.id);
        });
        proc.unref();
        pids[rec.id] = proc.pid;
        writePids(pids);
        // Не умер за пару секунд - считаем, что окно поднимается. Без этого пробника вкладка
        // рисовала зелёный тост на не открывшемся браузере.
        const failed = hub.earlyFailure ? await hub.earlyFailure(proc) : null;
        if (failed) {
            const p = readPids();
            delete p[rec.id];
            writePids(p);
            hub.log(`google open FAIL [${label}]: ${failed}`);
            return json(res, 502, { error: failed });
        }
        hub.log(`google open: ${maskEmail(rec.email)} -> ${label} (pid ${proc.pid})`);
        return json(res, 200, { ok: true, label, pid: proc.pid });
    }

    return json(res, 404, { error: `неизвестный маршрут Google: ${route}` });
}

module.exports = {
    handle, setHub, PREFIX, OPEN_SCRIPT, PIDS_FILE,
    maskEmail, maskInText, readPids, writePids, pidAlive, cardView,
};
