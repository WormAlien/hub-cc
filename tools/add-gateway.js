#!/usr/bin/env node
/**
 * add-gateway.js — проверка полноты вкладки шлюза ABUSE HUB по машиночитаемой спеке.
 *
 * Зачем. Вкладка шлюза — не один блок кода, а ~40 упоминаний, размазанных по десяти
 * файлам, два из которых по 25 тысяч строк. Забыть одну строчку легко, а симптом при
 * этом не «не собралось», а тихая полуработа: вкладка есть, а баланс не считается;
 * аккаунт добавляется, а активация не поднимает keepalive; авторотация молча обходит
 * шлюз стороной. Инструкция (wiki/abuse-hub/ADDING-A-GATEWAY.md) описывает всё верно,
 * но описывает ПРОЗОЙ и с номерами строк — а номера гниют после первой же правки.
 * Замер 13.09.2026: в инструкции массив `pools` из 9 pid-карт, в коде 12; в инструкции
 * `xxLoadSessionsLight`, в коде `loadKkSessionsLight`. Обе расхождения — молчаливые.
 *
 * Поэтому спека лежит отдельным JSON (gateways.spec.json), где каждая точка задана
 * ЯКОРЕМ-СТРОКОЙ, а не номером строки: строка переживает правки файла, номер — нет.
 *
 * Что делает: `check` — отчёт о пропусках, `plan` — та же спека, но инструкцией к
 * действию (якорь + живой номер строки + готовая строка), `apply` — вставки по живому
 * коду эталона (по умолчанию СУХОЙ прогон, запись — только явным `--write`), `list` —
 * известные шлюзы. Сети нет, дашборд не нужен, без `--write` файлы не трогаются.
 *
 * Сторожа при `apply`: регион эталона не должен нести артефактов ЧУЖОГО шлюза -
 * ни в разметке (`foreignMarkers`), ни в коде (`codeArtifacts`: чужие константы,
 * функции, файлы, хосты, порты). Найдено на nova 17.09: регион констант проглотил
 * блок Odyssey, а запись `$perPort` несла вложенную копию записи getunikey.
 *
 * Отличие `plan` от `check`. `check` отвечает «полно ли», `plan` — «что и куда
 * писать». Номер строки берётся ЖИВЫМ поиском по файлу на момент запуска (в спеке
 * номеров нет и быть не должно — они гниют): рядом с ним печатается сама строка-якорь,
 * и по ней видно, туда ли попал. Не нашлось — печатается «не найден», а не выдуманный
 * номер. Точки идут по файлам в порядке правки: внутри файла сверху вниз, чтобы файл
 * проходился один раз и глазами, а не прыжками. Не путать с номером из инструкции:
 * он снят на дату написания прозы и после первой же правки выше по файлу уехал.
 *
 * Запуск:
 *   node tools/add-gateway.js check kktoken      # эталон, обязан быть ПОЛНО
 *   node tools/add-gateway.js check hcnsec       # копия минус GitHub
 *   node tools/add-gateway.js plan  kktoken      # то же, но «что писать и где»
 *   node tools/add-gateway.js apply fluxnat      # сухой прогон вставок
 *   node tools/add-gateway.js apply fluxnat --write   # вставить (бэкап + node --check)
 *   node tools/add-gateway.js list
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SPEC_FILE = path.join(__dirname, 'gateways.spec.json');
const CONFIG_FILE = path.join(__dirname, 'gateways.config.json');

// ── конфиги шлюзов ───────────────────────────────────────────────────────────

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

/** x-форма: kk → Kk, hn → Hn (для handleKk*, renderKkGauge) */
function xForm(p) {
    return p.charAt(0).toUpperCase() + p.slice(1);
}

/** Подстановка токенов %p% %x% %P% %full% %NAME% %HOST% %PORT% %FOLDER% %ICON% %COLOR% %REF% */
function subst(text, gw) {
    return String(text)
        .replace(/%p%/g, gw.p)
        .replace(/%x%/g, xForm(gw.p))
        .replace(/%P%/g, gw.P)
        .replace(/%full%/g, gw.full)
        .replace(/%NAME%/g, gw.NAME)
        .replace(/%HOST%/g, gw.HOST)
        .replace(/%PORT%/g, String(gw.PORT))
        .replace(/%FOLDER%/g, gw.FOLDER || gw.full)
        .replace(/%ICON%/g, gw.ICON || '')
        .replace(/%COLOR%/g, gw.COLOR || '')
        .replace(/%REF%/g, gw.REF || '');
}

// ── трансформация кода эталона в код цели ────────────────────────────────────
//
// `apply` не хранит шаблонов: шаблон — это ЖИВОЙ код эталона. Инструкция говорит
// «копипаста KKtoken-блока + замена значений», и это ровно то, что здесь происходит
// механически: найти строку (или блок) эталона, заменить имена, вставить рядом.
//
// 🪤 Почему не хранить блоки в спеке: 93 блока продублировали бы код, который и так
// лежит в файле. Копия разошлась бы с оригиналом на первой же правке — и чекер бы
// этого не заметил, потому что проверяет он ПРИСУТСТВИЕ, а не совпадение.

/** Обязательные поля конфига: без них трансформа оставит в коде чужое имя. */
const REQUIRED_IN_CONFIG = ['p', 'P', 'full', 'NAME', 'HOST', 'PORT'];

/**
 * Пары «как у эталона» → «как у цели», из двух конфигов.
 *
 * Имена эталона живут в ТРЁХ регистрах сразу — `kktoken` (полное), `KK_` (константа),
 * `Kk` (x-форма в `handleKk*`, `renderKkGauge`, `keepaliveKk`) — плюс короткий `kk`
 * в роутах и реестрах, `KKtoken` в человекочитаемом, хост, порт, иконка, цвет, реф-код.
 *
 * 🪤 Порядок замен — от длинного к короткому, иначе `kk` съест начало `kktoken`
 * и на выходе получится `fluxtoken`. Поэтому пары сортируются по длине левой части.
 *
 * 🪤 Пара `[P, P]` без подчёркивания заведена 17.09 отдельно: до неё `KK_` заменялось,
 * а ГОЛЫЙ `KK` — нет, и в короткой подписи UI (`short: 'KK'` в `GH_USE_META`) у нового
 * шлюза оставалась чужая подпись. Симптом тихий: значок свой, буквы чужие, ни одна
 * проверка `check` этого не видит (точка 2.9 проверяет только `%p%: { icon: '%ICON%'`).
 *
 * 🪤 Пустые значения отбрасываются: `''` совпадает со всем и строка превратилась бы
 * в кашу. У fluxnat пуст `REF` — это нормально, реф-точки ослаблены флагом.
 */
function tokenPairs(src, dst) {
    if (!src || !dst) return [];
    const raw = [
        [src.HOST, dst.HOST],
        [src.NAME, dst.NAME],
        [`${src.P}_`, `${dst.P}_`],
        [xForm(src.p), xForm(dst.p)],
        [src.full, dst.full],
        [src.p, dst.p],
        [src.P, dst.P],
        [String(src.PORT), String(dst.PORT)],
        [src.ICON, dst.ICON],
        [src.COLOR, dst.COLOR],
        [src.REF, dst.REF],
    ];
    return raw
        .filter(([from, to]) => from && to && from !== to)
        .sort((a, b) => b[0].length - a[0].length);
}

/** Строка кода эталона → та же строка для цели. */
function toTarget(text, pairs) {
    let out = String(text);
    for (const [from, to] of pairs) out = out.split(from).join(to);
    return out;
}

// ── проверка одной точки ─────────────────────────────────────────────────────

function countOccurrences(hay, needle) {
    if (!needle) return 0;
    let n = 0, i = 0;
    for (;;) {
        const at = hay.indexOf(needle, i);
        if (at === -1) return n;
        n += 1;
        i = at + needle.length;
    }
}

/**
 * `within`: ожидание должно стоять не дальше WITHIN_LINES строк от маркера.
 * Нужно там, где сама по себе строка не уникальна: `kkLkPids` встречается в файле
 * много раз, а важен он ровно в массиве `pools` внутри `newapiLkBusy` — забыть его
 * там значит потерять детект открытого браузера профиля (грабля #21).
 */
const WITHIN_LINES = 6;

/** Строка без хвостового CR: файлы репо бывают и в CRLF, а печатать `\r` незачем. */
function stripCr(s) {
    return s.replace(/\r$/, '');
}

/**
 * Якорь для точки с `within`. Возвращает `{ line, text, found, markerLine }`, где
 * `line` — строка самого ожидания, если оно уже стоит рядом с маркером, иначе строка
 * маркера (в неё и надо дописать). `found=false` значит «вставлять», а не «всё плохо»:
 * маркер на месте, ожидания рядом нет. Если нет и маркера — null.
 *
 * Одна реализация на два вызова намеренно: `check` спрашивает только `found`, `plan` —
 * ещё и номер. Разъедься они, план начнёт указывать не туда, куда смотрит отчёт.
 */
function findWithinLine(hay, marker, needle) {
    const lines = hay.split('\n');
    let first = -1;
    for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].includes(marker)) continue;
        if (first === -1) first = i;
        const stop = Math.min(i + WITHIN_LINES, lines.length);
        for (let j = i; j < stop; j += 1) {
            if (lines[j].includes(needle)) {
                return { line: j + 1, text: stripCr(lines[j]), found: true, markerLine: i + 1 };
            }
        }
    }
    if (first === -1) return null;
    return { line: first + 1, text: stripCr(lines[first]), found: false, markerLine: first + 1 };
}

function withinMarker(hay, marker, needle) {
    const hit = findWithinLine(hay, marker, needle);
    return !!(hit && hit.found);
}

function checkPoint(point, gw, files) {
    // Ослабление по флагам конфига
    if (Array.isArray(point.when)) {
        const off = point.when.filter(f => !gw[f]);
        if (off.length) {
            return { status: 'absent', note: `ослабление: нет ${off.join(', ')}` };
        }
    }

    const rel = subst(point.file, gw);
    const abs = files[point.file] || path.join(REPO, rel);

    if (point.kind === 'file') {
        return fs.existsSync(abs)
            ? { status: 'ok' }
            : { status: 'missing', note: `нет файла ${rel}` };
    }

    if (!fs.existsSync(abs)) {
        return { status: 'missing', note: `нет файла ${rel}` };
    }
    const hay = fs.readFileSync(abs, 'utf8');

    const expects = Array.isArray(point.expect) ? point.expect : [point.expect];

    if (point.kind === 'must-not-count') {
        const needle = subst(expects[0], gw);
        const n = countOccurrences(hay, needle);
        if (point.expectMin != null && n < point.expectMin) {
            return { status: 'missing', note: `${needle} — ${n} шт, нужно ≥${point.expectMin}`, count: n };
        }
        if (point.max != null && n > point.max) {
            return { status: 'missing', note: `дубль: ${needle} — ${n} шт (грабля #19)`, count: n };
        }
        return { status: 'ok', count: n };
    }

    const absent = [];
    for (const e of expects) {
        const needle = subst(e, gw);
        if (point.within) {
            const marker = subst(point.within, gw);
            if (!withinMarker(hay, marker, needle)) {
                absent.push(`${needle}  (не найден рядом с «${marker}»)`);
            }
        } else if (!hay.includes(needle)) {
            absent.push(needle);
        }
    }

    return absent.length
        ? { status: 'missing', note: absent.join(' · ') }
        : { status: 'ok' };
}

/**
 * `must-any` — точка выполнена, если найден ХОТЯ БЫ ОДИН из вариантов.
 * Нужна там, где форма строки законно разошлась между шлюзами: константа порта
 * у старых `= 20161;`, у новых `= Number(process.env.HN_KEEPALIVE_PORT || 20162)`.
 * Инструкция описывает только первую форму — вторая молча считается пропуском.
 */
function checkAny(point, gw, files) {
    if (Array.isArray(point.when)) {
        const off = point.when.filter(f => !gw[f]);
        if (off.length) return { status: 'absent', note: `ослабление: нет ${off.join(', ')}` };
    }

    const rel = subst(point.file, gw);
    const abs = files[point.file] || path.join(REPO, rel);
    if (!fs.existsSync(abs)) return { status: 'missing', note: `нет файла ${rel}` };

    const hay = fs.readFileSync(abs, 'utf8');
    // У `must-any` близость к маркеру считается так же, как у `must`: иначе у точки
    // «список ручек ротации» (1.8m) хватило бы ЛЮБОГО `|bd|` в файле, в том числе из
    // совсем другого списка — и пропуск в нужной строке прошёл бы зелёным.
    const found = (point.any || []).some(v => {
        const needle = subst(v, gw);
        return point.within ? withinMarker(hay, subst(point.within, gw), needle) : hay.includes(needle);
    });
    return found ? { status: 'ok' } : { status: 'missing', note: (point.any || []).map(v => subst(v, gw)).join('  |  ') };
}

// ── план правок ──────────────────────────────────────────────────────────────

/** Сколько символов строки-якоря печатать: хватает, чтобы узнать строку глазами. */
const ANCHOR_CHARS = 80;

/** Якорь точки в живом файле: номер строки (1-based) и её текст. null — не найден. */
function findAnchor(hay, needle) {
    if (!needle) return null;
    const at = hay.indexOf(needle);
    if (at === -1) return null;
    const start = hay.lastIndexOf('\n', at - 1) + 1;
    let end = hay.indexOf('\n', at);
    if (end === -1) end = hay.length;
    return {
        line: hay.slice(0, at).split('\n').length,
        text: stripCr(hay.slice(start, end)),
    };
}

/** Все вхождения — по строке на каждое: дубль (грабля #19) виден только списком. */
function findAllLines(hay, needle) {
    const hits = [];
    hay.split('\n').forEach((text, i) => {
        if (needle && text.includes(needle)) hits.push({ line: i + 1, text: stripCr(text) });
    });
    return hits;
}

/**
 * Точка спеки → шаг плана: что писать, куда и в каком она состоянии.
 * state: done — уже на месте · todo — вписать · bad — дефект (дубль, нет файла) ·
 * skip — ослабление по флагам конфига (точки нет намеренно, писать нечего).
 */
function planPoint(point, gw, files) {
    // В спеке file — либо алиас из files, либо путь от корня (modelmap, папка шлюза,
    // .gitignore). Печатать надо путь: алиас «backend» человеку ничего не говорит и в
    // редакторе не открывается, поэтому путь считаем от корня и в прямых слэшах.
    const abs = files[point.file] || path.join(REPO, subst(point.file, gw));
    const rel = path.relative(REPO, abs).split(path.sep).join('/');
    const p = { id: point.id, title: point.title, rel, anchor: null, ready: [], note: '', state: 'todo', fileOnly: false };

    if (Array.isArray(point.when) && point.when.some(f => !gw[f])) {
        p.state = 'skip';
        p.note = `ослабление: нет ${point.when.filter(f => !gw[f]).join(', ')}`;
        return p;
    }

    const exists = fs.existsSync(abs);

    // Файл: строк не бывает, шаг — «создать файл». Печатаем это всегда, даже когда
    // файл уже есть: план читают и как чеклист, а не только как список недостач.
    if (point.kind === 'file') {
        p.fileOnly = true;
        p.state = exists ? 'done' : 'todo';
        return p;
    }

    const expects = (Array.isArray(point.expect) ? point.expect : [point.expect]).map(e => subst(e, gw));
    const need = text => ({ how: 'надо', text });

    if (!exists) {
        p.state = 'bad';
        p.note = `нет файла ${rel}`;
        p.ready = expects.map(need);
        return p;
    }

    const hay = fs.readFileSync(abs, 'utf8');

    if (point.kind === 'must-not-count') {
        const hits = findAllLines(hay, expects[0]);
        p.anchor = hits[0] || null;
        p.ready = [need(expects[0])];
        if (!hits.length || (point.expectMin != null && hits.length < point.expectMin)) {
            p.state = 'todo';
        } else if (point.max != null && hits.length > point.max) {
            p.state = 'bad';
            p.note = `дубль: ${hits.length} шт на строках ${hits.map(h => h.line).join(', ')} — оставить одну (грабля #19)`;
        } else {
            p.state = 'done';
            if (hits.length > 1) p.note = `вхождений ${hits.length}: строки ${hits.map(h => h.line).join(', ')}`;
        }
        return p;
    }

    if (point.kind === 'must-any') {
        const variants = (point.any || []).map(v => subst(v, gw));
        const hit = variants.find(v => hay.includes(v));
        if (hit) {
            p.state = 'done';
            p.anchor = findAnchor(hay, hit);
            p.ready = [need(hit)];
        } else {
            // Формы законно расходятся между шлюзами, поэтому «либо», а не «надо»:
            // обе строки в файл не пишутся, выбирается одна.
            p.ready = variants.map((text, i) => ({ how: i ? 'либо' : 'надо', text }));
            p.note = 'формы расходятся между шлюзами — вписать одну';
        }
        return p;
    }

    if (point.within) {
        const marker = subst(point.within, gw);
        const hit = findWithinLine(hay, marker, expects[0]);
        p.ready = expects.map(need);
        if (hit && hit.found) {
            p.state = 'done';
            // Именно строка из окна маркера, а не первое вхождение по файлу: `kkLkPids`
            // живёт ещё и в других пулах, и якорь «где попало» увёл бы править не туда.
            p.anchor = { line: hit.line, text: hit.text };
        } else if (hit) {
            // Маркер есть, ожидания рядом нет: номер — от маркера, туда и дописывать.
            p.state = 'todo';
            p.anchor = { line: hit.line, text: hit.text };
            p.note = `вписать рядом с маркером (строка ${hit.markerLine}): ${marker}`;
        } else {
            p.state = 'bad';
            p.note = `маркер не найден: ${marker}`;
        }
        return p;
    }

    // must: якорь — первое найденное из ожиданий (expect бывает массивом строк блока).
    p.anchor = expects.reduce((acc, t) => acc || findAnchor(hay, t), null);
    p.ready = expects.map(need);
    p.state = p.anchor ? 'done' : 'todo';
    return p;
}

// ── вывод ────────────────────────────────────────────────────────────────────

const C = process.stdout.isTTY
    ? { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m', b: '\x1b[1m' }
    : { ok: '', bad: '', warn: '', dim: '', off: '', b: '' };

const FLAGS = ['github', 'ref', 'flatRate', 'anthropic', 'pool', 'shareScript'];

/** Конфиг шлюза или выход: без него и check, и plan печатают одно и то же. */
function gwOrDie(name, config) {
    const gw = config[name];
    if (gw) return gw;
    console.error(`${C.bad}Нет конфига шлюза «${name}» в ${path.basename(CONFIG_FILE)}${C.off}`);
    console.error(`Известные: ${Object.keys(config).join(', ') || '(пусто)'}`);
    process.exit(2);
}

/** Шапка отчёта: кто это и с какими флагами. Одна на check и plan. */
function gwHead(gw) {
    console.log(`${C.b}${gw.NAME}${C.off}  ${C.dim}(${gw.full}, префикс ${gw.p}, порт ${gw.PORT})${C.off}`);
    console.log(`${C.dim}флаги: ${FLAGS.map(f => `${f}=${gw[f] ? 'да' : 'нет'}`).join('  ')}${C.off}`);
}

/** Пути всех файлов спеки, ключ — алиас из spec.files. */
function specFiles(spec) {
    const files = {};
    for (const [alias, rel] of Object.entries(spec.files || {})) {
        files[alias] = path.join(REPO, rel);
    }
    return files;
}

function runCheck(name, spec, config) {
    const gw = gwOrDie(name, config);
    const files = specFiles(spec);

    gwHead(gw);
    console.log('');

    let ok = 0, absent = 0;
    const missing = [];

    for (const point of spec.points) {
        const r = point.kind === 'must-any'
            ? checkAny(point, gw, files)
            : checkPoint(point, gw, files);
        if (r.status === 'ok') { ok += 1; continue; }
        if (r.status === 'absent') { absent += 1; continue; }
        missing.push({ point, note: r.note });
    }

    // Группируем пропуски по файлу — так глазами видно, куда идти
    if (missing.length) {
        const byFile = new Map();
        for (const m of missing) {
            const key = m.point.file;
            if (!byFile.has(key)) byFile.set(key, []);
            byFile.get(key).push(m);
        }
        for (const [file, items] of byFile) {
            const rel = subst(file, gw);
            console.log(`${C.bad}✗ ${rel}${C.off}  ${C.dim}(${items.length})${C.off}`);
            for (const { point, note } of items) {
                console.log(`   ${C.bad}${point.id.padEnd(6)}${C.off} ${point.title}`);
                console.log(`   ${C.dim}       ${note}${C.off}`);
            }
            console.log('');
        }
    }

    const total = ok + absent + missing.length;
    const head = missing.length
        ? `${C.bad}${C.b}НЕПОЛНО${C.off}`
        : `${C.ok}${C.b}ПОЛНО${C.off}`;
    console.log(`${head}  —  ${ok}/${total} точек на месте, ${absent} ослаблений, ${C.bad}${missing.length} пропусков${C.off}`);
    if (absent) {
        const list = spec.points
            .filter(p => Array.isArray(p.when) && p.when.some(f => !gw[f]))
            .map(p => p.id);
        console.log(`${C.dim}ослабления (ожидаемы): ${list.join(', ')}${C.off}`);
    }

    return missing.length ? 1 : 0;
}

// ── план правок (вывод) ──────────────────────────────────────────────────────

const STATE = {
    todo: { mark: '+', color: C.warn, plain: 'вписать' },
    done: { mark: '=', color: C.ok, plain: 'уже на месте' },
    bad: { mark: '!', color: C.bad, plain: 'дефект' },
    skip: { mark: '~', color: C.dim, plain: 'ослаблено флагами' },
};

/**
 * План = та же спека, но инструкцией: для каждой точки — файл, номер строки-якоря,
 * сама строка и готовая к вставке строка с подставленными токенами. Отчёт `check`
 * нужен, чтобы узнать «полно ли»; план — чтобы сесть и дописать.
 */
function runPlan(name, spec, config) {
    const gw = gwOrDie(name, config);
    const items = spec.points.map(pt => planPoint(pt, gw, specFiles(spec)));

    // Группировка по файлу: порядок файлов — как в спеке (он же порядок работы), внутри
    // файла — по номеру строки. Так файл на 25 тысяч строк проходится сверху вниз за
    // один заход, а не прыжками между 199-й и 13931-й строкой.
    const groups = new Map();
    for (const it of items) {
        if (!groups.has(it.rel)) groups.set(it.rel, []);
        groups.get(it.rel).push(it);
    }
    const lineOf = it => (it.anchor ? it.anchor.line : Number.MAX_SAFE_INTEGER);
    for (const list of groups.values()) list.sort((a, b) => lineOf(a) - lineOf(b));

    const tally = { todo: 0, done: 0, bad: 0, skip: 0 };
    for (const it of items) tally[it.state] += 1;

    gwHead(gw);
    console.log(`${C.dim}легенда: ${Object.values(STATE).map(s => `${s.mark} ${s.plain}`).join(' · ')}${C.off}`);
    console.log(`${C.dim}файлов: ${groups.size}, точек: ${items.length}; внутри файла — сверху вниз${C.off}\n`);

    for (const [rel, list] of groups) {
        console.log(`${C.b}── ${rel}${C.off}  ${C.dim}(${list.length})${C.off}`);
        for (const it of list) {
            const st = STATE[it.state];
            console.log(`  ${st.color}${st.mark}${C.off}  ${it.id.padEnd(6)} ${it.title}`);

            if (it.fileOnly) {
                const tail = it.state === 'done' ? `${C.dim}  (уже есть)${C.off}` : '';
                console.log(`      ${C.dim}создать файл${C.off}  ${it.rel}${tail}`);
                console.log('');
                continue;
            }

            // Номер — от живого поиска. Нет якоря — так и говорим: выдуманный номер
            // хуже отсутствующего, по нему пойдут править не туда.
            const num = it.anchor ? String(it.anchor.line) : 'не найден';
            const text = it.anchor ? it.anchor.text : '';
            const cut = text.length > ANCHOR_CHARS ? `${text.slice(0, ANCHOR_CHARS)}…` : text;
            console.log(`${C.dim}      ${num.padEnd(9)}${C.off}${cut}`);
            for (const r of it.ready) {
                console.log(`${C.dim}      ${r.how.padEnd(6)}${C.off}${r.text}`);
            }
            if (it.note) console.log(`${C.warn}      ↑ ${it.note}${C.off}`);
            console.log('');
        }
    }

    console.log(
        `ПЛАН  —  ${tally.done} уже на месте, ${C.warn}${tally.todo} вписать${C.off}, `
        + `${tally.skip} ослаблений, ${C.bad}${tally.bad} дефектов${C.off}`,
    );
    if (tally.skip) {
        const list = items.filter(i => i.state === 'skip').map(i => i.id);
        console.log(`${C.dim}ослабления (ожидаемы): ${list.join(', ')}${C.off}`);
    }

    return tally.bad ? 1 : 0;
}

// ── apply: вставка кода эталона в целевые файлы ──────────────────────────────
//
// 🎯 Главная мысль: шаблон НЕ хранится в спеке. Шаблон — это живой код эталона
// (kktoken). `apply` находит регион эталона по иголке из `expect`, заменяет имена
// на имена цели и вставляет копию рядом. Дублировать 93 блока в JSON значило бы
// завести копию, которая разойдётся с оригиналом на первой же правке — и чекер бы
// этого не заметил, потому что проверяет он присутствие, а не совпадение.
//
// 🪤 Почему сухой прогон по умолчанию, а не `--dry-run`: файлы по 25 тысяч строк
// обслуживают живой дашборд, а ошибка здесь — SyntaxError в проде (грабля #1).
// Запись должна быть осознанным действием, а не побочным эффектом любопытства.

/** Сколько строк занимает регион эталона, начиная с якорной. */
function extractRegion(lines, start, span) {
    if (span === 'line') return { end: start };
    if (/^lines:\d+$/.test(span)) {
        const n = Number(span.slice('lines:'.length));
        if (start + n > lines.length) return { error: `нужно ${n} строк, а файл кончается на ${lines.length}` };
        return { end: start + n - 1 };
    }
    if (span === 'until-blank') {
        let i = start + 1;
        while (i < lines.length && lines[i].trim() !== '') i += 1;
        return { end: i - 1 };
    }
    if (span === 'braces') {
        // 🪤 Скобки в строковых литералах не считаем: `'{'` в тексте сбило бы счётчик
        // и регион уехал бы за пределы блока. Снимаем литералы построчно.
        const strip = s => s.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, '``');
        const count = s => {
            let d = 0;
            for (const ch of strip(s)) { if (ch === '{') d += 1; else if (ch === '}') d -= 1; }
            return d;
        };
        let depth = 0;
        for (let i = start; i < lines.length && i < start + 500; i += 1) {
            depth += count(lines[i]);
            if (i === start && depth <= 0) {
                return { error: `якорь «${lines[start].trim().slice(0, 40)}» не открывает блок — span «braces» тут не годится` };
            }
            if (depth === 0) return { end: i };
        }
        return { error: 'скобки не закрылись за 500 строк' };
    }
    return { error: `неизвестный span «${span}»` };
}

/** Иголка в коде ЭТАЛОНА для этой точки. */

/**
 * Артефакты ЧУЖОГО шлюза внутри региона эталона. Эталон и цель живут в ОДНОМ файле, поэтому
 * копия уже испорченного региона размножает чужую поломку: 15.09 кнопка вкладки getunikey
 * влезла внутрь кнопки kktoken (вставка шла после якорной строки), и следующий шлюз склонировал
 * мусор — в сайдбаре оказались четыре открывающих <button> на три закрывающих.
 */
function foreignMarkers(text, srcName, config) {
    const out = [];
    const names = Object.values(config || {}).filter(v => v && v.full && v.full !== srcName).map(v => v.full);
    for (const n of names) {
        const probes = ['data-tab="' + n + '"', 'data-tab-content="' + n + '"', 'nav-count-' + n + '"'];
        const hit = probes.find(s => text.includes(s));
        if (hit) out.push(n);
    }
    return out;
}

/**
 * Артефакты чужого шлюза в КОДЕ копируемого региона — то, чего не видит `foreignMarkers`
 * (тот смотрит разметку) и не видит `node --check` (дубли объявлений он ловит ПОСЛЕ записи,
 * а вложенную запись реестра — вообще нет: PowerShell и JS разбирают её молча).
 *
 * Найдено на nova 17.09, дважды за один прогон:
 *   • регион констант `until-blank` проглотил блок Odyssey (между блоками не было пустой
 *     строки) — в клон уехали `OD_SESSIONS_FILE`, `OD_BASE_URL` и весь блок целиком;
 *   • регион записи `20161` в `keepalive-restart.ps1` содержал ВЛОЖЕННУЮ копию записи
 *     getunikey — клон её размножил, и у UniKey пропал ключ верхнего уровня `20168`.
 *
 * Оба раза сухой прогон печатал «строк 40» вместо 25 и «0 дефектов». Сторож ловит оба
 * ДО записи: копировать регион с чужим кодом нельзя — это размножение чужой поломки.
 *
 * 🪤 Комментарии снимаются построчно, поэтому законное упоминание соседа в комментарии
 * («у odyssey такого нет, это свойство kktoken») дефектом не считается. Порт соседа
 * ищется в коде, а не в тексте, — иначе строка «как у tabi :20155» красила бы регион.
 */
function codeArtifacts(text, srcName, config) {
    const out = [];
    const others = Object.values(config || {}).filter(v => v && v.full && v.full !== srcName);
    const body = String(text).split('\n').filter((l) => {
        const t = l.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#') || t.startsWith('<!--'));
    }).join('\n');
    for (const g of others) {
        const x = xForm(g.p);
        const probes = [
            [new RegExp(`\\b${g.P}_[A-Z0-9_]+`), `${g.P}_ (константа)`],
            [new RegExp(`\\bhandle${x}[A-Z]`), `handle${x}* (хендлер)`],
            [new RegExp(`\\b${g.p}(Load|Save|Probe|Balance|ApplyBalance|ReadActiveModel|ReadActiveKey|ReadModelMap|KeepaliveSpawn|LkPids|PidAlive|PoolStats|SetKey|OpenLk)\\b`), `${g.p}* (функция)`],
            [new RegExp(`'${g.full}-[a-z-]+\\.(json|txt)'`), `${g.full}-… (файл шлюза)`],
            [new RegExp(`'${g.HOST}'`), `хост ${g.HOST}`],
            // 🪤 Порт ищем ТОЛЬКО в форме кода: `20168 = @{` (запись $perPort), `|| 20170`
            // (env-фолбэк константы), `port: 20170` (реестры). Голое число не годится —
            // в тексте подсказок вкладки живёт «как у tabi :20155», и это не артефакт.
            // Так же и ключ: проба «`%p%: `» ловила поле `fn:` в NAV_COUNT_JOBS, где
            // `fn` — обычное имя поля, а не префикс FluxRouter.
            [new RegExp(`(^|\\s)${g.PORT}\\s*=\\s*@\\{`), `запись ${g.PORT} = @{`],
            [new RegExp(`\\|\\|\\s*${g.PORT}\\b`), `фолбэк порта ${g.PORT}`],
            [new RegExp(`port\\s*:\\s*${g.PORT}\\b`), `port: ${g.PORT}`],
        ];
        const hit = probes.find(([re]) => re.test(body));
        if (hit) out.push(`${g.full} (${hit[1]})`);
    }
    return out;
}

/**
 * Записи-«матрёшки»: начало записи реестра, оказавшееся ВНУТРИ другой такой же.
 *
 * Так выглядит дефект «вставка разрубила запись соседа»: первая строка новой записи
 * садится сразу после первой строки предыдущей, хвост — после её хвоста. JS и PowerShell
 * разбирают такую вложенность молча, поэтому симптом не «упало», а «пропало»: у UniKey
 * ключ `20168` уехал внутрь четырёх чужих записей, и `-Port 20168` отвечал «Unknown port».
 *
 * `entryRe` — шаблон начала записи с ключом в первой группе, например:
 *   /^  (\d{5}) = @\{/        для `$perPort` в keepalive-restart.ps1
 *   /^    ([a-z_0-9]+): \{/   для объекта JavaScript
 * Скобки считаются по всем строкам подряд, включая строковые литералы: в этих реестрах
 * фигурных скобок внутри строк нет, а свои скобки есть только у самой записи.
 */
function nestedEntries(text, entryRe) {
    const out = [];
    const lines = String(text).split('\n');
    let depth = 0;
    let open = null;
    for (let i = 0; i < lines.length; i += 1) {
        const m = entryRe.exec(lines[i]);
        if (m && !/^\s*(\/\/|\*|#)/.test(lines[i])) {
            if (open) out.push({ line: i + 1, key: m[1], inside: open.key, text: lines[i].trim().slice(0, 70) });
            if (lines[i].includes('{')) open = { key: m[1], depth: depth + 1 };
        }
        for (const ch of lines[i]) {
            if (ch === '{') depth += 1;
            else if (ch === '}') depth -= 1;
        }
        if (open && depth < open.depth) open = null;
    }
    return out;
}

/**
 * Структурная проверка разметки дашборда — то, что node --check в HTML не видит.
 * Обе поломки 15.09 ловились бы здесь: дубль id (nav-count-getunikey дважды от клона мусора)
 * и кнопка навигации, не закрытая до следующей (обрыв, из-за которого поехали пункты меню).
 */
function checkHtmlStructure(text) {
    const problems = [];
    const ids = new Map();
    for (const m of text.matchAll(/\sid="([^"]+)"/g)) {
        if (/\$\{|<%|\{\{/.test(m[1])) continue;
        ids.set(m[1], (ids.get(m[1]) || 0) + 1);
    }
    for (const [id, n] of ids) if (n > 1) problems.push('дубль id «' + id + '» ×' + n);
    const nav = [...text.matchAll(/<button[^>]*data-tab="[^"]+"/g)];
    if (nav.length) {
        const seg = text.slice(nav[0].index, nav[nav.length - 1].index);
        const parts = seg.split(/<button[^>]*data-tab="/).slice(1);
        parts.slice(0, -1).forEach((part, i) => {
            if (!part.includes('</button>')) problems.push('кнопка вкладки №' + (i + 1) + ' не закрыта до следующей');
        });
    }
    return problems;
}

function refFor(point, rule, src) {
    return subst(rule.ref != null ? rule.ref : (Array.isArray(point.expect) ? point.expect[0] : point.expect), src);
}

/**
 * Что `apply` сделает с одной точкой. Ничего не пишет — только считает.
 * status: 'insert' (вставит) · 'done' (уже есть) · 'skip' (ослаблена флагом) ·
 * 'manual' (правила нет, руками) · 'bad' (якорь не найден и т.п.)
 */
function applyPoint(point, rule, src, dst, pairs, files) {
    const p = { id: point.id, title: point.title, status: 'insert', rel: '', at: null, anchor: '', lines: [], note: '' };

    if (Array.isArray(point.when) && point.when.some(f => !dst[f])) {
        p.status = 'skip';
        p.note = `ослабление: нет ${point.when.filter(f => !dst[f]).join(', ')}`;
        return p;
    }
    if (!rule) { p.status = 'manual'; return p; }

    const abs = files[point.file] || path.join(REPO, subst(point.file, dst));
    p.rel = path.relative(REPO, abs).split(path.sep).join('/');
    if (!fs.existsSync(abs)) { p.status = 'bad'; p.note = `нет файла ${p.rel}`; return p; }

    const hay = fs.readFileSync(abs, 'utf8');
    const lines = hay.split('\n');

    // Идемпотентность: если результат уже на месте — не трогаем. Иначе повторный
    // прогон удвоил бы записи, а это ровно та порча, которую дорого искать глазами.
    // 🪤 Иглу ищем ТАМ ЖЕ, где стоит маркер, у точек с `within`: у 2.20 игла `'bd',`
    // живёт в файле ещё девять раз (другие списки вкладок), и глобальный `includes`
    // объявил бы вставку сделанной, оставив `check` красным по этому же пункту.
    // У `must-any` берём первый вариант `any`: `expect` там пуст, и `subst(undefined)`
    // дал бы иглу «undefined», то есть точку, которая всегда «уже на месте».
    const needleSrc = Array.isArray(point.expect) ? point.expect[0]
        : (point.expect != null ? point.expect : (point.any || [])[0]);
    const targetNeedle = needleSrc == null ? null : subst(needleSrc, dst);
    const alreadyThere = (needle) => {
        if (needle == null) return false;
        return point.within ? withinMarker(hay, subst(point.within, dst), needle) : hay.includes(needle);
    };
    if (!rule.mode || rule.mode === 'after') {
        if (alreadyThere(targetNeedle)) { p.status = 'done'; p.note = 'уже на месте'; return p; }
    } else if (rule.mode === 'inline') {
        if (alreadyThere(subst(rule.add, dst))) { p.status = 'done'; p.note = 'уже на месте'; return p; }
    }

    const ref = refFor(point, rule, src);

    // Где искать якорь. Обычно — единственное вхождение в файле. Но у точек с `within`
    // иголка заведомо не уникальна (`kkLkPids` живёт и в своём объявлении, и в пулах
    // других шлюзов), поэтому линию задаёт маркер, а не первое вхождение.
    let start;
    if (point.within) {
        const marker = subst(point.within, src);
        const hit = findWithinLine(hay, marker, ref);
        if (!hit) { p.status = 'bad'; p.note = `маркер не найден: ${marker}`; return p; }
        if (!hit.found) { p.status = 'bad'; p.note = `рядом с «${marker}» нет «${ref}»`; return p; }
        start = hit.line - 1;
    } else {
        start = lines.findIndex(l => l.includes(ref));
        if (start < 0) { p.status = 'bad'; p.note = `якорь эталона не найден: ${ref}`; return p; }

        // Второе вхождение — уже неоднозначность: вставлять «куда попало» нельзя.
        if (lines.findIndex((l, i) => i > start && l.includes(ref)) >= 0) {
            p.status = 'bad';
            p.note = `якорь эталона встречается больше одного раза: ${ref}`;
            return p;
        }
    }

    if (rule.mode === 'inline') {
        const findSrc = subst(rule.find, src);
        if (!lines[start].includes(findSrc)) {
            p.status = 'bad';
            p.note = `на якорной строке нет «${findSrc}»`;
            return p;
        }
        const addDst = subst(rule.add, dst);
        const at = lines[start].indexOf(findSrc) + findSrc.length;
        p.at = start + 1;
        p.anchor = stripCr(lines[start]);
        p.lines = [{ index: start, text: lines[start].slice(0, at) + addDst + lines[start].slice(at) }];
        p.delta = { from: findSrc, to: addDst };
        p.note = 'дописать в якорную строку';
        return p;
    }

    const span = rule.span || 'line';
    const region = extractRegion(lines, start, span);
    if (region.error) { p.status = 'bad'; p.note = region.error; return p; }
    // 🪤 Регион эталона может быть уже испорчен предыдущей вставкой (эталон и цель — один файл).
    // Копия такого региона размножает чужую поломку, поэтому это дефект, а не копирование.
    {
        const regionText = lines.slice(start, region.end + 1).join('\n');
        const cfg = loadConfig();
        const foreign = foreignMarkers(regionText, src.full, cfg);
        if (foreign.length) {
            p.status = 'bad';
            p.note = 'в регионе эталона артефакты чужого шлюза: ' + foreign.join(', ');
            return p;
        }
        // 🪤 Второй сторож по тому же региону, но про КОД, а не разметку: чужие константы,
        // функции, файлы, ключи и порты. Ловит «регион проглотил блок соседа» (nova/odyssey
        // 17.09) и «регион несёт вложенную запись соседа» (там же, keepalive-restart.ps1).
        const artifacts = codeArtifacts(regionText, src.full, cfg);
        if (artifacts.length) {
            p.status = 'bad';
            p.note = `в регионе эталона код чужого шлюза: ${artifacts.join(', ')} — граница региона не там `
                + '(частая причина: между блоками эталона и соседа нет пустой строки при span until-blank)';
            return p;
        }
    }

    // 🪤 Регион вставляется ПОСЛЕ своей последней строки, а не после якорной: иначе копия
    // влезает ВНУТРЬ копируемого объекта или функции (проверено на kktoken/CC_HEADERS:
    // SyntaxError, и на функциях — вложенные копии, грабля #19).
    p.at = region.end + 1;
    p.anchor = stripCr(lines[start]);
    p.lines = lines
        .slice(start, region.end + 1)
        .map(l => toTarget(l, pairs))
        // Отступ новой записи берём от эталона — он уже выровнен по файлу.
        .map(l => (l === '' ? l : l));
    p.note = `${span}, строк ${region.end - start + 1}`;

    // 🪤 `until-blank` — единственный регион, чья граница держится на ПУСТОЙ СТРОКЕ,
    // и копия обязана эту границу сохранить. 17.09 на nova вышло иначе: блок Nova встал
    // вплотную к блоку KKtoken (пустая строка уехала под копию), и следующий шлюз получил
    // регион из ДВУХ блоков — сухой прогон показал «строк 40» вместо 25, а клон унёс бы
    // в себе весь блок предыдущего шлюза. Поэтому копия садится ПОСЛЕ разделяющей пустой
    // строки и заканчивается своей — тогда инвариант «блок, пустая строка, блок» держится
    // сам, без ручной правки файла перед каждым следующим заведением.
    if (span === 'until-blank') {
        p.at = region.end + 2;
        p.lines = [...p.lines, ''];
        p.note += ', с пустой строкой после';
    }
    return p;
}

function runApply(name, spec, config, write) {
    const dst = gwOrDie(name, config);
    const srcName = spec.source || 'kktoken';
    const src = config[srcName];
    if (!src) { console.error(`нет конфига эталона «${srcName}» в ${path.basename(CONFIG_FILE)}`); return 2; }
    if (srcName === name) { console.error('Эталон и цель — один шлюз, клонировать нечего.'); return 2; }

    // 🪤 Пустое поле конфига = незаменённое имя эталона в коде. Проверяем ДО правки:
    // после неё чинить придётся по живому файлу в 25 тысяч строк.
    const lack = REQUIRED_IN_CONFIG.filter(k => !dst[k]);
    if (lack.length) {
        console.error(`У шлюза «${name}» пустые обязательные поля: ${lack.join(', ')} — трансформа оставит чужие имена.`);
        return 2;
    }

    const pairs = tokenPairs(src, dst);
    const files = specFiles(spec);
    const inserts = spec.inserts || {};
    // 🪤 Источник бывает ПОТОЧЕЧНЫЙ. Вся вкладка клонируется с эталона (kktoken), но
    // машинерия автореги у эталона отсутствует вовсе — она есть у `aikeysapi`, и точка
    // с `"source": "aikeysapi"` берёт регион оттуда. Пара «источник → цель» при этом
    // строится своя: у ak свой префикс, свой хост и свой порт, и общие пары kktoken
    // оставили бы в скопированном коде чужие имена.
    const pairsFor = (srcCfg) => (srcCfg === src ? pairs : tokenPairs(srcCfg, dst));
    const items = spec.points.map(pt => {
        const ptSrc = pt.source ? config[pt.source] : src;
        if (!ptSrc) { console.error(`точка ${pt.id}: нет конфига источника «${pt.source}»`); process.exit(2); }
        if (pt.source && pt.source === name) { console.error(`точка ${pt.id}: источник и цель совпали`); process.exit(2); }
        return applyPoint(pt, inserts[pt.id], ptSrc, dst, pairsFor(ptSrc), files);
    });

    const tally = { insert: 0, done: 0, skip: 0, manual: 0, bad: 0 };
    for (const it of items) tally[it.status] += 1;

    gwHead(dst);
    console.log(`${C.dim}эталон: ${srcName} · режим: ${write ? `${C.bad}ЗАПИСЬ${C.off}` : `${C.ok}сухой прогон${C.off} — файлы не тронуты`}${C.off}\n`);

    for (const it of items) {
        if (it.status === 'skip') continue;
        const mark = it.status === 'insert' ? '＋' : it.status === 'done' ? '=' : it.status === 'bad' ? '!' : '·';
        const color = it.status === 'insert' ? C.ok : it.status === 'bad' ? C.bad : C.dim;
        const lineNo = it.at ? String(it.at).padEnd(8) : ''.padEnd(8);
        console.log(`${color}${mark}${C.off} ${it.id.padEnd(6)} ${lineNo} ${it.rel}${C.dim}  ${it.title}${it.note ? ` — ${it.note}` : ''}${C.off}`);
        if (it.status === 'insert' && it.lines.length) {
            // Для inline показываем САМУ вставку, а не строку в 200 символов: в длинной
            // строке реестра добавленный фрагмент иначе не разглядеть.
            if (it.delta) {
                console.log(`${C.dim}        ↓ ${it.delta.from}${C.off}${C.ok}${it.delta.to}${C.off}`);
            } else {
                for (const l of it.lines) {
                    console.log(`${C.dim}        ↓ ${stripCr(String(l.text != null ? l.text : l)).slice(0, 130)}${C.off}`);
                }
            }
        }
        if (it.status === 'bad') console.log(`${C.warn}        ↑ ${it.note}${C.off}`);
    }

    console.log(
        `\nИТОГ  —  ${C.ok}${tally.insert} вставить${C.off}, ${tally.done} уже на месте, `
        + `${tally.skip} ослаблений, ${C.dim}${tally.manual} руками${C.off}, ${C.bad}${tally.bad} дефектов${C.off}`,
    );

    if (!write) {
        console.log(`${C.dim}Сухой прогон. Записать: npm-скрипт не нужен, добавь --write.${C.off}`);
        return tally.bad ? 1 : 0;
    }

    // 🪤 Дефект при записи — стоп целиком: часть вкладки в файле хуже, чем ни одной,
    // потому что «наполовину заведённый» шлюз выглядит рабочим.
    if (tally.bad) {
        console.error(`\n${C.bad}Есть дефекты (${tally.bad}) — запись отменена целиком, файлы не тронуты.${C.off}`);
        return 1;
    }

    // Бэкап в отдельную папку с меткой времени: откат должен быть рукой подать.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = path.join(REPO, 'routing', '.backup', `apply-${dst.full}-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });

    const byFile = new Map();
    for (const it of items) {
        if (it.status !== 'insert') continue;
        if (!byFile.has(it.rel)) byFile.set(it.rel, []);
        byFile.get(it.rel).push(it);
    }

    let written = 0;
    for (const [rel, list] of byFile) {
        const abs = path.join(REPO, rel);
        const original = fs.readFileSync(abs, 'utf8');
        fs.writeFileSync(path.join(backupDir, rel.replace(/[\\/]/g, '__')), original, 'utf8');

        let lines = original.split('\n');
        // 🪤 Снизу вверх: вставка сдвигает номера всех строк ниже, и при проходе
        // сверху вниз вторая вставка уехала бы не туда.
        const sorted = [...list].sort((a, b) => b.at - a.at);
        for (const it of sorted) {
            if (it.lines.length === 1 && it.lines[0].index != null) {
                lines[it.lines[0].index] = it.lines[0].text;              // inline
            } else {
                lines.splice(it.at, 0, ...it.lines);                      // after
            }
            written += 1;
        }
        fs.writeFileSync(abs, lines.join('\n'), 'utf8');
        console.log(`${C.ok}записано${C.off} ${rel}  ${C.dim}(${list.length} точек)${C.off}`);
    }
    console.log(`${C.dim}бэкап: ${path.relative(REPO, backupDir).split(path.sep).join('/')}${C.off}`);

    // Синтаксис — сразу, ДО любых советов про рестарт: SyntaxError роняет прод.
    const jsFiles = [...byFile.keys()].filter(f => f.endsWith('.js'));
    let syntaxOk = true;
    for (const rel of jsFiles) {
        const r = require('child_process').spawnSync(process.execPath, ['--check', path.join(REPO, rel)], { encoding: 'utf8' });
        const ok = r.status === 0;
        if (!ok) syntaxOk = false;
        console.log(`${ok ? C.ok + 'синтаксис ок' : C.bad + 'СИНТАКСИС СЛОМАН'}${C.off} ${rel}${ok ? '' : `\n${r.stderr.slice(0, 400)}`}`);
    }

    for (const rel of [...byFile.keys()].filter(f => f.endsWith('.html'))) {
        const problems = checkHtmlStructure(fs.readFileSync(path.join(REPO, rel), 'utf8'));
        if (problems.length) {
            syntaxOk = false;
            console.log(C.bad + 'РАЗМЕТКА СЛОМАНА' + C.off + ' ' + rel + '\n  ' + problems.slice(0, 6).join('\n  '));
        } else {
            console.log(C.ok + 'разметка ок' + C.off + ' ' + rel);
        }
    }
    if (!syntaxOk) {
        console.error(`\n${C.bad}Файлы сломаны. Откат: скопируй из ${path.relative(REPO, backupDir).split(path.sep).join('/')}${C.off}`);
        return 1;
    }

    // Автопрогон check: стало хуже — сказать, а не промолчать.
    console.log('');
    const before = 0;
    runCheck(name, spec, config);

    console.log(`\n${C.dim}вставок: ${written}. Перезапуск дашборда — задачей владельцу (рестарт рвёт его же сессию).${C.off}`);
    return 0;
}

// ── вход ─────────────────────────────────────────────────────────────────────

function main() {
    const [cmd, arg] = process.argv.slice(2);
    const spec = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'));
    const config = loadConfig();

    if (cmd === 'list' || !cmd) {
        const gates = Object.entries(config).filter(([k]) => !k.startsWith('_'));   // `_readme` — документация, не шлюз
        console.log(`${C.b}Спека:${C.off} ${spec.points.length} точек в ${Object.keys(spec.files || {}).length} файлах`);
        console.log(`${C.b}Шлюзы:${C.off} ${gates.length}`);
        for (const [k, v] of gates) {
            console.log(`  ${k.padEnd(12)} ${String(v.NAME).padEnd(12)} порт ${String(v.PORT).padEnd(6)} ${v.HOST}`);
        }
        console.log(`\n${C.dim}node tools/add-gateway.js check <шлюз>   — что уже на месте${C.off}`);
        console.log(`${C.dim}node tools/add-gateway.js plan  <шлюз>   — что и куда писать${C.off}`);
        return 0;
    }

    if (cmd === 'check' || cmd === 'plan') {
        if (!arg) { console.error(`Укажи шлюз: ${cmd} <имя>`); return 2; }
        return cmd === 'check' ? runCheck(arg, spec, config) : runPlan(arg, spec, config);
    }

    if (cmd === 'apply') {
        if (!arg) { console.error('Укажи шлюз: apply <имя> [--write]'); return 2; }
        return runApply(arg, spec, config, process.argv.includes('--write'));
    }

    console.error(`Неизвестная команда «${cmd}». Есть: check, plan, apply, list`);
    return 2;
}

// Запуск только при прямом вызове: прогоны (`check-add-gateway.js`) импортируют
// функции отсюда, и без этой развилки импорт выполнял бы `main()` с чужим argv.
if (require.main === module) process.exit(main());

module.exports = { subst, xForm, tokenPairs, toTarget, loadConfig, specFiles, foreignMarkers, codeArtifacts, nestedEntries, checkHtmlStructure };
