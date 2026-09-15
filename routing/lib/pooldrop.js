'use strict';

// ───────────────────── пул-дроп: тир-карта на фолбэк и обратно ─────────────────────
//
// Зачем. 15.09.2026 в 04:52 МСК живая сессия встала с
// `402 Budget pool quota has been exhausted. Please ask an administrator to increase
// the limit or select another budget pool.` Шлюз `agentrouter` выдаёт Claude- и
// GPT-модели только во время наливки пула («用完即止» — кончается раньше срока).
// Владелец руками переписал `ar-modelmap.json` на `deepseek-v4-flash` и продолжил
// работу. Лечение найдено — не хватало автоматики.
//
// Кто что делает. ЛОВИТ 402 и повторяет запрос `keepalive-proxy.js` (реактивная часть,
// работает без дашборда). ПЕРСИСТЕНТНОСТЬ — здесь: этот модуль переписывает тир-карту
// на диске (видно в дашборде, переживает рестарт) и держит маркер + бэкап, чтобы
// «вернуть как было» было физически возможно. Ручки, которые его дёргают, живут в
// `transparent-proxy.js` (дашборд :8200 — владелец тир-карт, см. memory
// `modelmap_written_by_dashboard`).
//
// Почему отдельный модуль, а не функции в `transparent-proxy.js`. Тот файл — 25 000
// строк, `require` его поднимает сервер на боевом порту. Регресс обязан гонять эту
// логику на ВРЕМЕННЫХ файлах, поэтому всё принимает пути аргументами, а две функции
// соседа (`tierMapFile`, `writeTierMap`) передаются ИНЪЕКЦИЕЙ — копий в репо не заводим,
// вторая копия рано или поздно разъедется с первой (тот же довод, что в комментарии к
// `tierMapFile`: «своей таблицы имён здесь нет намеренно»).
//
// 🪤 `tierMapFile` и `writeTierMap` НЕ дублируются здесь. Если не переданы — функции
// возвращают `{ok:false, error}` и НЕ пишут ничего. Молчаливой второй реализации нет
// намеренно: расхождение с боевым `writeTierMap` означало бы тихо испорченную тир-карту.

const fs = require('fs');
const path = require('path');

// ─────────────────────────────── пути ───────────────────────────────

// Кто есть кто. Пул наливки — это ТОЛЬКО `claude-*` и `gpt-*`; `deepseek-*`/`glm-*`
// выдаются шлюзом всегда и пулу не подчинены (факт от владельца 15.09). Регексп держим
// ровно тот же, что `POOL_MODEL_RE` в `keepalive-proxy.js`, — это одна и та же граница.
const POOL_MODEL_RE = /^(claude|gpt)[-_]/i;

function isPoolModel(id) {
    return POOL_MODEL_RE.test(String(id == null ? '' : id).trim());
}

// Имя бэкапа для файла карты. Держим рядом с самим файлом: `rename`/чтение идут по
// одному тому, а глазом видно, к какой карте бэкап относится.
//   ar-modelmap.json        → ar-modelmap.pooldrop.bak.json
//   ar-routes-modelmap.json → ar-routes-modelmap.pooldrop.bak.json
function bakOf(file) {
    return String(file).replace(/\.json$/, '.pooldrop.bak.json');
}

// Имя маркера — из имени ОБЫЧНОЙ карты: `ar-modelmap.json` → `ar-pooldrop.json`.
// Префикс берём у обычной карты, а не у routes-, потому что маркер один на провайдера
// (обе карты падают и возвращаются вместе).
function markerFor(mapFile) {
    return path.join(path.dirname(mapFile),
        path.basename(mapFile).replace(/-modelmap\.json$/, '-pooldrop.json'));
}

// Инъекция соседей из `transparent-proxy.js`. Модуль по умолчанию ничего не знает ни о
// таблице префиксов, ни о слиянии — и не должен.
const DEPS = {
    // tierMapFile(provider, routes) → абсолютный путь карты или null («провайдер не
    // редактируется»: у xpeach/omniroute обычной карты нет).
    tierMapFile: null,
    // writeTierMap(file, patch, emptyAs) → слить правку с тем, что УЖЕ лежит в файле.
    writeTierMap: null,
};

function configure(deps) {
    for (const k of Object.keys(DEPS)) {
        if (deps && k in deps) DEPS[k] = deps[k];
    }
    return { ...DEPS };
}

// Пути всей обвязки одного провайдера.
//
// `tierMapFile` можно передать и сюда (тогда `configure` не нужен) — так регресс
// подставляет временный каталог вместо боевого `routing/`.
// `mapFile`/`routesFile` можно задать напрямую, когда пути уже готовы.
function poolDropFiles({ provider, tierMapFile, mapFile, routesFile } = {}) {
    const resolve = tierMapFile || DEPS.tierMapFile;
    let map = mapFile || null;
    let routes = routesFile || null;
    if (!map || !routes) {
        if (typeof resolve !== 'function') {
            return { error: 'tierMapFile не передан: пути карт не из чего построить (см. configure)' };
        }
        if (!map) map = resolve(provider, false);
        if (!routes) routes = resolve(provider, true);
    }
    if (!map || !routes) {
        return { error: `провайдер '${provider}' не редактируется: тир-карты у него нет` };
    }
    return {
        mapFile: map,
        routesFile: routes,
        bakFile: bakOf(map),
        routesBakFile: bakOf(routes),
        markerFile: markerFor(map),
    };
}

// ──────────────────────────── чтение/запись ────────────────────────────

// 🪤 UTF-8 без BOM — но при ЧТЕНИИ BOM снимаем: файлы карт правит и дашборд, и
// владелец блокнотом, а в репо это уже принятый приём (см. `routeTierMap`,
// `writeTierMap`, `readMarker` ниже). BOM внутри JSON валит `JSON.parse`.
function stripBom(raw) {
    return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

function readJson(file) {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(stripBom(raw));
}

// Карта как плоский объект строк. Кривой/отсутствующий файл — не повод падать:
// «все тиры пустые» это валидное состояние (см. `routeTierMap`).
function readTiers(file) {
    try {
        const mm = readJson(file);
        if (!mm || typeof mm !== 'object' || Array.isArray(mm)) return {};
        const out = {};
        for (const [k, v] of Object.entries(mm)) out[k] = String(v == null ? '' : v).trim();
        return out;
    } catch { return {}; }
}

function readMarker(markerFile) {
    try {
        const j = readJson(markerFile);
        return (j && typeof j === 'object' && !Array.isArray(j)) ? j : null;
    } catch { return null; }
}

function writeMarker(markerFile, obj) {
    fs.writeFileSync(markerFile, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return markerFile;
}

// Снятие маркера идемпотентно: нет файла — тоже успех. Возвращаем, был ли он.
function clearMarker(markerFile) {
    try { fs.unlinkSync(markerFile); return true; } catch { return false; }
}

// ─────────────────────────── опускание карты ───────────────────────────

// Читает карту, кладёт бэкап, переписывает ТОЛЬКО пуловые цели на `fallback`.
//
// Что переписываем (правило владельца 15.09): ключ, чья цель равна `deadModel` ЛИБО
// матчится `isPoolModel`. Всё остальное — `glm-5.3`, `deepseek-*`, пустые строки —
// остаётся как у владельца: это беспуловые модели, их 402 не касается.
//   {opus: 'claude-opus-5', haiku: 'glm-5.3', gpt: '', sonnet: 'gpt-5.6-sol'}
//   deadModel='claude-opus-5', fallback='deepseek-v4-flash'
//   → {opus: 'deepseek-v4-flash', haiku: 'glm-5.3', gpt: '', sonnet: 'deepseek-v4-flash'}
//
// 🪤 Бэкап пишется ТОЛЬКО когда маркера ещё нет. Иначе повторный вызов (keepalive
// ретраит, дашборд дёрнули второй раз) затёр бы «исходник» уже переключённым файлом —
// и «вернуть как было» вернуло бы deepseek вместо карты владельца. Ошибка тихая:
// маркер на месте, `ok: true`, а восстановление даёт фолбэк.
//
// Слияние — по устройству `writeTierMap` (patch содержит только изменённые ключи,
// соседа стереть нельзя). Своей записи здесь нет.
//
// Возврат: `{ok, changed, already, tiers, backupFiles, error?}`. `already: true` —
// маркер уже стоял, файл не менялся (идемпотентность на уровне модуля, роут её лишь
// пересказывает клиенту).
function poolDrop(file, markerFile, opts = {}) {
    const { deadModel, fallback, now } = opts;
    const writeTierMap = opts.writeTierMap || DEPS.writeTierMap;
    const bakFile = opts.bakFile || bakOf(file);
    // `mark: false` — маркер ведёт вызывающий. Нужно там, где карт ДВЕ: если бы каждая
    // писала маркер сама, второй вызов увидел бы маркер первого и решил бы, что всё
    // уже сделано. Дашборд дёргает обе карты и ставит маркер один раз (см.
    // `poolDropTiers` в transparent-proxy.js).
    const useMarker = opts.mark !== false;

    const fb = String(fallback == null ? '' : fallback).trim();
    // Пустой фолбэк = фича выключена. Без цели переключение бессмысленно, а `writeTierMap`
    // записал бы пустой тир — то есть СТЁР модель у владельца. Не пишем ничего.
    if (!fb) return { ok: false, changed: false, tiers: readTiers(file), error: 'фолбэк не задан' };
    if (typeof writeTierMap !== 'function') {
        return { ok: false, changed: false, tiers: readTiers(file), error: 'writeTierMap не передан (инъекция, см. configure)' };
    }

    const prev = useMarker ? readMarker(markerFile) : null;
    if (prev) {
        // Идемпотентность: маркер — источник истины. Карта уже опущена, бэкап уже лежит.
        return {
            ok: true, changed: false, already: true,
            tiers: readTiers(file),
            backupFiles: Array.isArray(prev.backupFiles) ? prev.backupFiles : [],
            deadModel: prev.deadModel, fallback: prev.fallback,
        };
    }

    const before = readTiers(file);
    // Бэкап — побайтово, ДО правки: восстановление обязано вернуть ровно то, что было,
    // а не пересобранный `JSON.stringify` (порядок ключей, отступы, хвостовой \n).
    let backupFiles = [];
    try {
        const buf = fs.readFileSync(file);
        fs.writeFileSync(bakFile, buf);
        backupFiles = [bakFile];
    } catch (e) {
        // Карты нет (первый запуск) — опускать нечего. Молчаливой записи без бэкапа не
        // делаем: без исходника кнопка «вернуть» не работает, а карта была бы испорчена.
        return { ok: false, changed: false, tiers: before, error: `бэкап не создан: ${e.message}` };
    }

    const patch = {};
    for (const [k, v] of Object.entries(before)) {
        if (v === deadModel || isPoolModel(v)) patch[k] = fb;
    }

    let tiers = before;
    if (Object.keys(patch).length) {
        try {
            // `emptyAs` не важен: в патче только непустые значения. `''` — исторический
            // выбор ar (см. комментарий к writeTierMap), для нас он нейтрален.
            const mm = writeTierMap(file, patch, '');
            tiers = {};
            for (const [k, v] of Object.entries(mm || {})) tiers[k] = String(v == null ? '' : v).trim();
        } catch (e) {
            return { ok: false, changed: false, tiers: before, error: `карта не записана: ${e.message}` };
        }
    }

    if (useMarker) {
        writeMarker(markerFile, {
            provider: opts.provider || null,
            deadModel: deadModel || null,
            fallback: fb,
            droppedAt: new Date(now == null ? Date.now() : now).toISOString(),
            backupFiles,
        });
    }

    return { ok: true, changed: Object.keys(patch).length > 0, already: false, tiers, backupFiles, patch };
}

// ─────────────────────────── возврат карты ───────────────────────────

// Возврат из бэкапа ПОБАЙТОВО. «Как было» — это буквально те же байты: карту правит и
// владелец, и дашборд, лишний пересбор через JSON.stringify давал бы дифф на ровном месте.
//
// Отсутствующий или битый бэкап — `{ok:false, error}`, файл НЕ трогаем. Полу-возврат
// (записать половину JSON) хуже, чем честная ошибка: карта осталась бы нечитаемой.
function poolRestore(file, bakFile) {
    let buf;
    try {
        buf = fs.readFileSync(bakFile);
    } catch (e) {
        return { ok: false, error: `бэкап недоступен: ${e.message}` };
    }
    let tiers;
    try {
        const mm = JSON.parse(stripBom(buf.toString('utf8')));
        if (!mm || typeof mm !== 'object' || Array.isArray(mm)) throw new Error('не объект');
        tiers = {};
        for (const [k, v] of Object.entries(mm)) tiers[k] = String(v == null ? '' : v).trim();
    } catch (e) {
        return { ok: false, error: `бэкап битый: ${e.message}` };
    }
    try {
        fs.writeFileSync(file, buf);
    } catch (e) {
        return { ok: false, error: `карта не записана: ${e.message}` };
    }
    return { ok: true, restored: true, tiers };
}

module.exports = {
    isPoolModel, POOL_MODEL_RE,
    bakOf, markerFor, poolDropFiles,
    readTiers, readMarker, writeMarker, clearMarker,
    poolDrop, poolRestore,
    configure,
};
