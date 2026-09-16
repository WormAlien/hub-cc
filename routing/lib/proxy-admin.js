// routing/lib/proxy-admin.js
//
// Операции вкладки «Свои прокси»: чтение раскладки, сохранение своего списка,
// проверка здоровья, ребаланс и ручное назначение. HTTP и UI живут отдельно -
// здесь только логика и безопасные снимки данных.
//
// Зачем модуль появился. Пул (`./proxy-pool.js`) умеет липко привязывать аккаунт к
// прокси и раскладывать нагрузку по паре «прокси × хост», но он ничего не знает о
// владельце: у него нет способа ПОКАЗАТЬ раскладку и нет пути ЗАПИСИ списка. Владелец
// просил вкладку, в которую он вставляет свои прокси (SOCKS5 из своего VPN XGATE плюс
// купленные) и видит, как они разложены по аккаунтам.
//
// 🔴 ГЛАВНОЕ ПРАВИЛО ЭТОГО МОДУЛЯ: наружу НЕ уходят креды. У прокси владельца есть
// логин и пароль (`socks5://user:pass@node:10808`), и они не должны покидать машину ни
// в JSON для браузера, ни в лог. Пул уже даёт `label` и `id` БЕЗ кредов (проверено:
// `parseProxy` строит их из host:port), а поле `raw` содержит креды дословно - его
// наружу отдавать нельзя НИКОГДА. Единственное место, где `raw` законен, - запись в
// конфиг при сохранении списка.
//
// 🪤 Почему свой список живёт в `ownList` конфига, а не в отдельном текстовом файле.
// Формат `ip:port` из выгрузки скрапера несёт протокол в ИМЕНИ файла и не имеет места
// для логина с паролем. Свой прокси с авторизацией в такой файл не влезает: `raw` не
// восстановить из `label`, и повторное сохранение списка молча стёрло бы пароли, а два
// прокси с разными кредами на одном host:port схлопнулись бы в один id. Поэтому свои
// строки хранятся ДОСЛОВНО в JSON, где для них есть место. `ownFile` в конфиге остаётся
// поддержан пулом, но вкладка пишет именно `ownList`.
//
// Запрет из соседнего модуля остаётся в силе и здесь: прокси назначен и не работает -
// НЕ ходить напрямую. Этот модуль ничего не ходит в панели, поэтому правило его не
// касается напрямую, но `state()` обязан говорить про мёртвый прокси честно, чтобы
// владелец не принял его за рабочий.

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'proxy-pool.json');

// Путь проверки зависит от ДВИЖКА панели, а не от нашего удобства. `/api/status` - это
// соглашение New API; у sub2api-панелей (`api.rumeng-ai.com`, `true-sota.com`) такого
// пути нет, он отдаёт 404 - и тогда НИ ОДИН прокси не проходит проверку при полностью
// живом прокси и живой панели (замер 13.09). Разбор - в шапке `./proxy-pool.js`.
const PREFLIGHT_PATH_BY_HOST = {
    'api.rumeng-ai.com': '/api/v1/settings/public',
};

// Проверяем не залпом: пачка своих прокси, выстреленная одновременно, упирается в
// рейт-лимит того же WAF, ради ухода от которого пул и заведён.
const CHECK_CONCURRENCY = 4;

let POOL = null;
let LOAD_ERROR = null;
try { POOL = require('./proxy-pool.js'); }
catch (e) { LOAD_ERROR = (e && (e.message || String(e))) || 'не загружается'; }

// Пул мог обновиться на диске, а мы держим снимок бесконечно долго - мемо на короткий
// срок, как в самом пуле (CONFIG_MEMO_MS). Ноль здесь означает «перечитывать всегда».
let POOL_MEMO = { at: 0, lib: null };
const POOL_MEMO_MS = 5000;

function poolLib() {
    if (POOL && (Date.now() - POOL_MEMO.at) < POOL_MEMO_MS) return POOL;
    try {
        // require вернёт тот же модуль из кеша Node; перечитываем ссылку на случай,
        // если процесс поднял пул позже нас.
        POOL = require('./proxy-pool.js');
        LOAD_ERROR = null;
    } catch (e) {
        LOAD_ERROR = (e && (e.message || String(e))) || 'не загружается';
        return null;
    }
    POOL_MEMO = { at: Date.now(), lib: POOL };
    return POOL;
}

// Внятный отказ вместо падения: модуль пула может не собраться (нет пакета `socks`,
// битый конфиг), и вкладка обязана показать это текстом, а не белым экраном.
function unavailable(what = 'state') {
    const why = LOAD_ERROR ? `: ${LOAD_ERROR}` : '';
    return { ok: false, error: `пул прокси недоступен (${what})${why}` };
}

const nowIso = () => new Date().toISOString();

function preflightPathFor(host) {
    const lib = POOL;
    if (lib && lib.DEFAULT_PREFLIGHT_PATH && !PREFLIGHT_PATH_BY_HOST[host]) return lib.DEFAULT_PREFLIGHT_PATH;
    return PREFLIGHT_PATH_BY_HOST[host] || (lib && lib.DEFAULT_PREFLIGHT_PATH) || '/api/status';
}

// ───────────────────────────── чтение состояния ─────────────────────────────

// Снимок для вкладки: ярусы, раскладка по аккаунтам, здоровье, осиротевшие.
// Кредов здесь нет и быть не может - только label/id, которые их не содержат.
function state() {
    const lib = poolLib();
    if (!lib) return unavailable();
    let cfg, d, t;
    try {
        cfg = lib.config();
        d = lib.describe();
        t = lib.tiers();
    } catch (e) {
        return { ok: false, error: `не удалось прочитать состояние пула: ${(e && e.message) || e}` };
    }

    // Хост прокси для показа: у самого прокси хоста нет (он в другом поле - hostname),
    // поэтому берём его из label/id. Поле `raw` здесь не читаем вовсе - в нём креды.
    const own = t.own.map(p => {
        const load = new Map();
        for (const h of d.byHost) {
            const hit = h.proxies.find(x => x.id === p.id);
            if (hit) load.set(h.host, hit.accounts);
        }
        return {
            id: p.id,
            label: p.label,
            scheme: p.scheme,
            hostname: p.hostname,
            port: p.port,
            hasAuth: !!(p.user || p.pass),
            accounts: [...load.values()].reduce((a, b) => a + b, 0),
            byHost: Object.fromEntries(load),
            alive: t.byId.has(p.id),
        };
    });

    return {
        ok: true,
        enabled: !!cfg.enabled,
        ownFirst: cfg.ownFirst !== false,
        maxPerHost: cfg.maxPerHost,
        hosts: cfg.hosts,
        ownFile: cfg.ownFile || null,
        maxPerHostFor: Object.fromEntries((cfg.hosts || []).map(h => [h, lib.maxPerHostFor(h)])),
        // Ёмкость и густота: потолок считается из размера пула, поэтому вкладка обязана
        // показывать, ИЗ ЧЕГО он получился, а не только итоговое число.
        capacity: lib.capacity ? lib.capacity() : null,
        // Вердикты проверок с моментом вердикта: переживают обновление страницы.
        health: lib.healthSnapshot ? lib.healthSnapshot() : [],
        own,
        scraped: {
            count: t.scraped.length,
            bad: t.bad.length,
            source: t.source,
            fileError: t.fileError || null,
        },
        assignments: lib.assignmentRows().map(r => ({
            key: r.key,
            proxy: r.proxy,
            tier: lib.tierOf(r.proxy) || (lib.tiers().own.some(p => p.id === r.proxy) ? 'own' : null),
            host: r.host,
            at: r.at,
            why: r.why,
            alive: t.byId.has(r.proxy),
        })),
        orphans: d.byHost.flatMap(h => h.proxies.filter(x => !x.alive)
            .map(x => ({ host: h.host, proxy: x.id, accounts: x.accounts }))),
        counts: {
            own: d.own, scraped: d.scraped, assigned: d.assigned,
            orphans: d.orphans, orphansOwn: d.orphansOwn, orphansScraped: d.orphansScraped,
        },
        assignFile: d.assignFile,
        updatedAt: nowIso(),
    };
}

// ───────────────────────────── сохранение своего списка ─────────────────────────────

// Атомарно: пишем во временный файл рядом и переименовываем. Иначе параллельный чек
// баланса, читающий конфиг в этот момент, увидит обрезанный JSON и решит, что пул пуст.
function writeConfigAtomic(doc) {
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, CONFIG_FILE);
}

// Текст из textarea → `ownList` конфига. Разбор - через пул (`parseList`), своего
// парсера здесь нет намеренно: два разборщика одного формата разъедутся.
function saveOwn(text) {
    const lib = poolLib();
    if (!lib) return { ...unavailable('saveOwn'), saved: 0, bad: [], proxies: [] };
    const raw = String(text == null ? '' : text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!raw.length) {
        return { ok: false, error: 'список пуст — сохранение стёрло бы свои прокси, а это осиротит привязки', saved: 0, bad: [], proxies: [] };
    }

    const parsed = lib.parseList(raw, 'socks5');
    // 🪤 `parseList` дедуплицирует по id, а id КРЕДОВ НЕ СОДЕРЖИТ. Два прокси с разными
    // логином на одном host:port - это два разных выхода, но один id. Предупреждаем
    // прямо: молча схлопнуть их значит отдать владельцу не тот список, что он вставил.
    const dupes = [];
    const seenRaw = new Set();
    for (const line of parsed.bad) dupes.push(line);
    const uniqueRaw = [];
    for (const line of raw) {
        if (seenRaw.has(line)) continue;
        seenRaw.add(line);
        uniqueRaw.push(line);
    }

    const doc = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{}');
    const prevCount = Array.isArray(doc.ownList) ? doc.ownList.length : 0;
    // Храним ДОСЛОВНО: `label` кредов не несёт, и пересохранение из него стёрло бы пароли.
    doc.ownList = uniqueRaw;
    // Явно снимаем ownFile: иначе пул читал бы ещё и старый текстовый файл, и в списке
    // оказались бы прокси, которых владелец уже не вводил.
    if (doc.ownFile) doc.ownFile = null;
    if (doc.enabled === undefined) doc.enabled = true;

    try { writeConfigAtomic(doc); }
    catch (e) { return { ok: false, error: `не удалось записать ${CONFIG_FILE}: ${(e && e.message) || e}` , saved: 0, bad: [], proxies: [] }; }

    lib._reset();
    const t = lib.tiers();

    const out = {
        ok: true,
        saved: t.own.length,
        bad: parsed.bad,
        proxies: t.own.map(p => p.label),
    };
    if (parsed.bad.length) out.warning = `не разобрано строк: ${parsed.bad.length} - они не попали в пул`;
    if (prevCount && !t.own.length) {
        out.warning = 'свой список стал пустым - привязки на свои прокси осиротели, снимите их во вкладке';
    }
    return out;
}

// ───────────────────────────── проверка здоровья ─────────────────────────────

// Прогон preflight по своим прокси. Ограничение параллельности - чтобы не выстрелить
// залпом и не собрать тот же рейт-лимит, от которого уходим.
async function checkOwn({ host = null } = {}) {
    const lib = poolLib();
    if (!lib) return { ...unavailable('checkOwn'), results: [] };
    const t = lib.tiers();
    if (!t.own.length) return { ok: true, results: [] };

    const cfg = lib.config();
    const hosts = host ? [String(host)] : (cfg.hosts.length ? cfg.hosts : ['agentrouter.org']);
    const jobs = [];
    for (const p of t.own) for (const h of hosts) jobs.push({ p, h });

    const results = [];
    let i = 0;
    const worker = async () => {
        while (i < jobs.length) {
            const job = jobs[i++];
            const r = await lib.health(job.p, job.h, {
                force: true,
                path: preflightPathFor(job.h),
            }).catch(e => ({ ok: false, error: (e && e.message) || String(e) }));
            results.push({
                id: job.p.id, host: job.h,
                ok: !!r.ok, error: r.error || null, ms: r.ms || null, status: r.status || null,
                // 🪤 Время проверки обязательно. «Жив» без «когда проверяли» - это вердикт,
                // который стареет молча: прокси мог умереть минуту назад, а вкладка всё ещё
                // показывает зелёное. `at` - момент вердикта, `ageMs` - сколько ему уже.
                at: r.at || Date.now(),
                ageMs: r.at ? Date.now() - r.at : 0,
                cached: !!r.cached,
                // 🪤 404 на `/api/status` - это про ДВИЖОК панели, а не про прокси. Для
                // sub2api путь другой (`/api/v1/settings/public`), и без этой пометки
                // живой прокси выглядел бы мёртвым.
                path: preflightPathFor(job.h),
            });
        }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, jobs.length) }, worker));
    return { ok: true, results };
}

// ───────────────────────────── ребаланс и привязки ─────────────────────────────

function rebalance({ dryRun = true, host = null } = {}) {
    const lib = poolLib();
    if (!lib) return { ...unavailable('rebalance'), dryRun, moves: [], skipped: [] };
    const plan = lib.rebalancePlan({ host });
    if (dryRun) return { ok: true, dryRun: true, moves: plan.moves, skipped: plan.skipped };
    const res = lib.applyRebalance(plan);
    return { ok: true, dryRun: false, moves: plan.moves, skipped: plan.skipped, applied: res.applied, errors: res.errors };
}

function assign({ key, proxyId = null } = {}) {
    const lib = poolLib();
    if (!lib) return { ...unavailable('assign'), proxy: null };
    const r = lib.reassign(key, proxyId);
    if (!r.ok) return { ok: false, error: r.error, proxy: null };
    // Наружу - только label: в объекте прокси есть `raw` с кредами.
    return { ok: true, proxy: { id: r.proxy.id, label: r.proxy.label }, tier: r.tier || null };
}

function unassign({ key } = {}) {
    const lib = poolLib();
    if (!lib) return { ...unavailable('unassign'), released: null };
    const prev = lib.release(key);
    // Снятая привязка тоже отдаётся без `raw`.
    return { ok: true, released: prev ? { proxy: prev.proxy, at: prev.at || null, why: prev.why || null } : null };
}

module.exports = { state, saveOwn, checkOwn, rebalance, assign, unassign, preflightPathFor };
