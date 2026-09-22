#!/usr/bin/env node
/**
 * check-add-gateway.js — статический регресс на САМ чекер вкладок (tools/add-gateway.js).
 *
 * Зачем файл существует. `node tools/add-gateway.js check <шлюз>` — единственный инструмент,
 * который отвечает на вопрос «вкладка шлюза заведена целиком?». Он уже нашёл настоящий дефект
 * (у AIPM тег бэкапа настроек остался `settings-kk` вместо `settings-ap`), то есть работает.
 * Но регресса у него самого не было — а инструмент, который ВРЁТ, хуже отсутствующего: он
 * уводит в сторону уверенно, и человек идёт чинить живой код вместо спеки. Ровно так же молча
 * ломается незакрытый токен `%p:` в спеке: строка не подставится никогда, точка навсегда
 * «пропущена», и дефект выглядит как недоделанный шлюз.
 *
 * Чекер вкладок умеет ошибаться восемью способами, и на каждый здесь свой блок:
 *   1. спека невалидна (опечатка в id / kind / file) — точка молча не проверяется НИКОГДА;
 *   2. токен написан неверно или неизвестен инструменту — строка не подставляется, и точка
 *      всегда «пропущена»; пустой токен (`%ICON%` у шлюза без иконки) даёт обратный эффект —
 *      `includes('')` истинно, и точка зелена, ничего не проверив;
 *   3. эталон (kktoken) перестал давать 100% — сломана спека ИЛИ инструмент;
 *   4. файл из спеки не существует — инструмент пишет «нет файла», хотя виноват не шлюз;
 *   5. `when`-флаг, которого нет в конфиге шлюза, читается как false: точка молча уходит в
 *      «ослабления», и выглядит это как честное ослабление;
 *   6. `apply` умеет писать — и обязан делать это ТОЛЬКО по `--write`: сухой прогон,
 *      тронувший файл, ломает живой дашборд молча (блок 6, проба по sha1);
 *   7. регион эталона несёт артефакты соседа — клон размножает чужую поломку; на nova
 *      так уехал целый блок констант Odyssey, а запись `$perPort` размножила матрёшку
 *      (блок 7: `codeArtifacts` и `nestedEntries`, плюс реплей обоих дефектов);
 *   8. РЕЕСТР ЕСТЬ, А ТОЧКИ ПОД НЕГО НЕТ — вкладка выходит «рабочая, но одна кнопка молчит»:
 *      так вышло с `NEWAPI_SEED_PROV` («GitHub: неизвестный шлюз nv»), а сканом нашлись ещё
 *      четыре таких реестра (блок 8).
 *
 * 🪤 Почему здесь не только проверки спеки, но и прогон инструмента. Спека может быть
 * идеальной, а `checkPoint` — перестать сравнивать строки (рефакторинг, лишний `subst`,
 * сменившийся порядок замен). Тогда все точки разом «на месте», и это самый опасный вид
 * зелёного. Поэтому эталон прогоняется по-настоящему, и его цифры сверяются с независимым
 * пересчётом этого файла: сколько точек обязано быть ослаблено по флагам kktoken, столько
 * инструмент и обязан назвать. Счётчики при этом разбираются из вывода, а не из кода.
 * Вывод инструмента приходит в трубу (не TTY), поэтому цвета в нём выключены — разбор
 * стабилен; запускается это в отдельном процессе, свои переменные не портит.
 *
 * Сети нет, дашборд не нужен, файлы только читаются (`:8200` не задет).
 *
 * Запуск: node tools/check-add-gateway.js      (exit 1 = спека или инструмент врут)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ADD_GATEWAY = path.join(__dirname, 'add-gateway.js');
const SPEC_FILE = path.join(__dirname, 'gateways.spec.json');
const CONFIG_FILE = path.join(__dirname, 'gateways.config.json');

// kind, которые инструмент РЕАЛЬНО исполняет. `_readme` в спеке обещает ещё `must-not` и
// `absent`, но ветки под них в коде нет: точка с таким kind проваливается в общую ветку `must`
// и проверяется наоборот (для `must-not` это значит «обязана присутствовать»). Сверка набора
// с исходником — ниже, в блоке 1.
const KINDS = ['must', 'must-any', 'must-not-count', 'file'];

const fails = [];
const warns = [];
let total = 0;

function section(title) { console.log(`\n── ${title} ──`); }
function check(cond, msg) {
    total += 1;
    console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) fails.push(msg);
}
function warn(msg) { warns.push(msg); console.log(`  ! ${msg}`); }
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

const specSrc = read(SPEC_FILE);
const configSrc = read(CONFIG_FILE);
const toolSrc = read(ADD_GATEWAY);
if (!specSrc || !configSrc || !toolSrc) {
    console.log(`✗ не читается ${!specSrc ? SPEC_FILE : !configSrc ? CONFIG_FILE : ADD_GATEWAY} — проверять нечего`);
    process.exit(1);
}
const spec = JSON.parse(specSrc);
const config = JSON.parse(configSrc);
const GW_NAMES = Object.keys(config).filter((k) => !k.startsWith('_'));

// Шлюз-эталон: обязана давать ПОЛНО `check`, и на его живых строках проверяются сторожа.
const REF = 'kktoken';

// ── подстановка: копия `subst` из инструмента ────────────────────────────────
// Порядок замен сохранён (`%p%` → `%x%` → `%P%` …): инструмент заменяет именно так, и
// самодельный порядок дал бы другой результат на строках с двумя токенами.
function xForm(p) { return p.charAt(0).toUpperCase() + p.slice(1); }

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

/** Адрес точки: как в инструменте — сначала ключ `spec.files`, иначе литеральный путь от корня. */
function resolve(fileKey, gw) {
    if (Object.prototype.hasOwnProperty.call(spec.files || {}, fileKey)) {
        return path.join(REPO, spec.files[fileKey]);
    }
    return path.join(REPO, subst(fileKey, gw));
}

const fieldsOf = (p) => [p.file, ...(Array.isArray(p.expect) ? p.expect : [p.expect]), ...(p.any || []), p.within]
    .filter((v) => typeof v === 'string');

/** Точка ослаблена: хотя бы один её флаг выключен в конфиге. */
const isAbsent = (p, gw) => Array.isArray(p.when) && p.when.some((f) => !gw[f]);

console.log('== check-add-gateway: спека и чекер вкладок сходятся ==');

// ── 1. спека структурно валидна ───────────────────────────────────────────────
section('gateways.spec.json · структура точек');
{
    const points = spec.points;
    check(Array.isArray(points) && points.length > 0, `points — непустой массив (${Array.isArray(points) ? points.length : '—'} шт.)`);
    const files = spec.files || {};
    check(Object.keys(files).length > 0, `files — непустая карта (${Object.keys(files).length} шт.)`);

    const bad = { id: [], dup: [], title: [], file: [], kind: [], expect: [], num: [], when: [] };
    const seen = new Set();
    for (const p of points || []) {
        const at = p && p.id ? p.id : '(без id)';
        if (typeof p.id !== 'string' || !p.id.trim()) bad.id.push(JSON.stringify(p.id));
        else if (seen.has(p.id)) bad.dup.push(p.id);
        else seen.add(p.id);
        if (typeof p.title !== 'string' || !p.title.trim()) bad.title.push(at);
        if (typeof p.file !== 'string' || !p.file.trim()) bad.file.push(at);
        if (!KINDS.includes(p.kind)) bad.kind.push(`${at}: ${JSON.stringify(p.kind)}`);

        // `must-any` живёт на `any` (вариантов может быть много), остальные — на `expect`;
        // у kind `file` искать нечего вовсе: она про существование файла.
        if (p.kind === 'must-any') {
            if (!Array.isArray(p.any) || !p.any.length) bad.expect.push(`${at}: нет any`);
        } else if (p.kind !== 'file') {
            const exp = Array.isArray(p.expect) ? p.expect : [p.expect];
            if (!exp.length || exp.some((e) => typeof e !== 'string' || !e.trim())) bad.expect.push(at);
        }

        if (p.max != null && typeof p.max !== 'number') bad.num.push(`${at}: max`);
        if (p.expectMin != null && typeof p.expectMin !== 'number') bad.num.push(`${at}: expectMin`);
        if (p.within != null && typeof p.within !== 'string') bad.num.push(`${at}: within`);

        // `when` — непустой массив без дублей. Пустой массив инструмент читает как «применимо
        // всегда»: это забытый флаг, а не поставленное условие, и заметить его неоткуда.
        if (p.when != null) {
            if (!Array.isArray(p.when) || !p.when.length) bad.when.push(`${at}: пусто/не массив`);
            else if (new Set(p.when).size !== p.when.length) bad.when.push(`${at}: дубль флага`);
        }
    }

    const tail = (arr, n = 6) => (arr.length > n ? ` — ${arr.slice(0, n).join(', ')} … ещё ${arr.length - n}` : ` — ${arr.join(', ')}`);
    check(bad.id.length === 0, `у каждой точки непустая id${bad.id.length ? tail(bad.id) : ''}`);
    check(bad.dup.length === 0, `id не дублируются (точек ${(points || []).length}, уникальных ${seen.size})${bad.dup.length ? tail(bad.dup) : ''}`);
    check(bad.title.length === 0, `у каждой точки есть title${bad.title.length ? tail(bad.title) : ''}`);
    check(bad.file.length === 0, `у каждой точки есть file${bad.file.length ? tail(bad.file) : ''}`);
    check(bad.kind.length === 0, `kind — из известного набора (${KINDS.join(', ')})${bad.kind.length ? tail(bad.kind) : ''}`);
    check(bad.expect.length === 0, `у каждой точки есть что искать (expect — строка или массив, либо any у must-any)${bad.expect.length ? tail(bad.expect) : ''}`);
    check(bad.num.length === 0, `max/expectMin — числа, within — строка${bad.num.length ? tail(bad.num) : ''}`);
    check(bad.when.length === 0, `when — непустой массив без дублей${bad.when.length ? tail(bad.when) : ''}`);

    // Файл точки — либо ключ spec.files (инструмент подставит путь из карты), либо
    // литеральный путь от корня проекта; `..` и абсолютный путь означают, что инструмент
    // полезет за пределы репозитория — этого в спеке быть не должно.
    const literal = (points || []).filter((p) => !Object.prototype.hasOwnProperty.call(files, p.file));
    const outside = literal.filter((p) => path.isAbsolute(p.file) || p.file.split(/[\\/]/).includes('..'));
    check(outside.length === 0, `file — ключ из spec.files либо путь внутри проекта (литеральных: ${literal.length}${literal.length ? ' — ' + literal.map((p) => p.id).join(', ') : ''})${outside.length ? tail(outside.map((p) => `${p.id} → ${p.file}`)) : ''}`);

    // Набор kind сверяется с исходником инструмента: kind, которого он не разбирает,
    // проверяется общей ветвью — то есть наоборот от задуманного и без единого сообщения.
    const unimpl = KINDS.filter((k) => k !== 'must' && !toolSrc.includes(`'${k}'`));
    check(unimpl.length === 0, `каждый kind из набора инструмент исполняет${unimpl.length ? ' — нет ветки под: ' + unimpl.join(', ') : ''}`);

    const promised = new Set();
    for (const line of spec._readme || []) {
        const m = /^\s{2}([a-z][a-z-]*)\s+—/.exec(line);
        if (m) promised.add(m[1]);
    }
    const ghosts = [...promised].filter((k) => !KINDS.includes(k));
    if (ghosts.length) {
        warn(`_readme обещает kind «${ghosts.join('», «')}», которых инструмент не знает: точка с таким kind проверится общей ветвью must — наоборот от задуманного`);
    }

    // Хвост карты файлов: alias, на который не смотрит ни одна точка, — либо забытая точка,
    // либо мёртвый ключ. Не приговор (ключ может ждать будущую точку), но заметить стоит.
    const unused = Object.keys(files).filter((a) => !(points || []).some((p) => p.file === a));
    if (unused.length) warn(`alias без точек — файл в спеке есть, а точки на него нет: ${unused.join(', ')}`);
}

// ── 2. токены подстановки ─────────────────────────────────────────────────────
section('токены подстановки · %p% %x% и родня');
{
    // Набор токенов НЕ хардкожен: он парсится из самого инструмента (его `.replace(/…/g`).
    // Так спека не разъедется с реализацией: новый токен в инструменте чекер увидит, а
    // токен, которого инструмент не знает, станет красным — вместо «точка всегда пропущена».
    const TOKENS = new Set([...toolSrc.matchAll(/\.replace\(\/%([A-Za-z][A-Za-z0-9]*)%\/g/g)].map((m) => m[1]));
    check(TOKENS.size >= 8, `набор токенов прочитан из инструмента (${TOKENS.size} шт.: ${[...TOKENS].join(' ')})`);

    // Сканер различает три беды: `%zz%` (закрыт, но инструменту неизвестен), `%p:` (нет
    // закрывающего процента — САМАЯ тихая: строка не подставится никогда) и одинокий `%`.
    function scanTokens(text) {
        const out = [];
        for (let i = 0; i < text.length; i += 1) {
            if (text[i] !== '%') continue;
            const rest = text.slice(i);
            const closed = /^%([A-Za-z][A-Za-z0-9]*)%/.exec(rest);
            if (closed) {
                if (!TOKENS.has(closed[1])) out.push({ kind: 'unknown', text: closed[0] });
                i += closed[0].length - 1;
                continue;
            }
            const open = /^%([A-Za-z][A-Za-z0-9]*)/.exec(rest);
            out.push({ kind: open ? 'unclosed' : 'stray', text: rest.slice(0, 14) });
        }
        return out;
    }

    // Самопроверка сканера. Сканер, чей регексп перестал находить, ЗЕЛЕНЕЕТ — это та же
    // болезнь, от которой этот файл лечит инструмент; поэтому положительный и четыре
    // отрицательных примера проверяются явно, а не «на глаз».
    const selfCases = [
        ['%p%', 0],
        ['const %P%_KEEPALIVE_PORT = %PORT%;', 0],
        ['"%full%":', 0],
        ['%p%%x%', 0],
        ['%p:', 1],
        ['%zz%', 1],
        ['100%', 1],
    ];
    const selfBad = selfCases.filter(([s, n]) => scanTokens(s).length !== n).map(([s]) => s);
    check(selfBad.length === 0, `сканер ловит незакрытый, неизвестный и одинокий «%»${selfBad.length ? ' — промах на: ' + selfBad.join(' | ') : ''}`);

    const tokenBad = [];
    const scanField = (where, value) => {
        for (const t of scanTokens(String(value))) tokenBad.push(`${where}: ${t.kind} «${t.text}»`);
    };
    for (const p of spec.points || []) {
        scanField(`${p.id} file`, p.file);
        for (const e of (Array.isArray(p.expect) ? p.expect : [p.expect]).filter((x) => typeof x === 'string')) scanField(`${p.id} expect`, e);
        for (const a of (p.any || []).filter((x) => typeof x === 'string')) scanField(`${p.id} any`, a);
        if (typeof p.within === 'string') scanField(`${p.id} within`, p.within);
    }
    check(tokenBad.length === 0,
        `все токены спеки закрыты и известны инструменту${tokenBad.length ? ` — ${tokenBad.slice(0, 6).join(' · ')}${tokenBad.length > 6 ? ` … ещё ${tokenBad.length - 6}` : ''}` : ''}`);

    // Пути в spec.files инструмент подставляет ТОЛЬКО через токены в поле точки: сам путь
    // из карты уходит в `path.join` как есть, и `%full%` там остался бы именем каталога.
    const filesWithTokens = Object.entries(spec.files || {}).filter(([, v]) => typeof v === 'string' && v.includes('%')).map(([k]) => k);
    check(filesWithTokens.length === 0, `spec.files — литеральные пути, без токенов${filesWithTokens.length ? ' — подстановки тут нет: ' + filesWithTokens.join(', ') : ''}`);

    // Известный и закрытый токен может быть ПУСТ у конкретного шлюза (`%REF%` у шлюза без
    // рефки, `%ICON%`/`%COLOR%` у шлюза без иконки). Подстановка даёт пустую строку, а
    // `hay.includes('')` истинно ВСЕГДА: точка зеленеет, ничего не проверив.
    const emptySubst = [];
    for (const name of GW_NAMES) {
        const gw = config[name];
        for (const p of spec.points || []) {
            if (p.kind === 'file' || isAbsent(p, gw)) continue;
            for (const f of fieldsOf(p)) if (!subst(f, gw).length) emptySubst.push(`${name}/${p.id}`);
        }
    }
    check(emptySubst.length === 0,
        `подстановка не даёт пустых строк — иначе точка зелена всегда${emptySubst.length ? ' — ' + [...new Set(emptySubst)].slice(0, 8).join(', ') : ''}`);
}

// ── 3. прогон инструмента: эталон обязан дать 100% ────────────────────────────
section('прогон `add-gateway.js check` · эталон и остальные шлюзы');
{
    // Сводку читаем ИЗ ВЫВОДА, а не из кода: разбирать исходник значило бы повторить
    // проверяемого и ничего не проверить. Вывод идёт в трубу, цвета в нём выключены.
    const parse = (out) => {
        const m = /(ПОЛНО|НЕПОЛНО)\s+—\s+(\d+)\/(\d+) точек на месте, (\d+) ослаблений, (\d+) пропусков/.exec(out);
        if (!m) return null;
        const list = (/ослабления \(ожидаемы\): (.+)/.exec(out) || [, ''])[1].trim();
        return {
            verdict: m[1], ok: +m[2], total: +m[3], absent: +m[4], missed: +m[5],
            absents: list ? list.split(',').map((s) => s.trim()).filter(Boolean).sort() : [],
        };
    };
    const run = (name) => {
        const r = spawnSync(process.execPath, [ADD_GATEWAY, 'check', name], { encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
        return { code: r.status == null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
    };
    // Инструмент обязан считать ослабленной ровно ту точку, чей `when` ложен. Это проверка
    // СЕМАНТИКИ `when` (блок 5), а не счётчика: ошибиться тут можно только вместе с кодом.
    const expectAbsent = (gw) => (spec.points || []).filter((p) => isAbsent(p, gw)).map((p) => p.id).sort();
    const dump = (out) => console.log(out.split('\n').slice(-8).map((l) => `      ${l}`).join('\n'));

    check(!!config[REF], `шлюз-эталон «${REF}» есть в конфиге`);
    const refRun = run(REF);
    const ref = parse(refRun.out);
    check(!!ref, 'сводка эталонного прогона разобрана (формат вывода не изменился)');
    if (!ref) {
        dump(refRun.out);
    } else {
        check(refRun.code === 0, `эталон отвечает кодом 0 (получено ${refRun.code})`);
        check(ref.verdict === 'ПОЛНО' && ref.missed === 0,
            `эталон ПОЛНО и пропусков 0 (вердикт ${ref.verdict}, пропусков ${ref.missed})${ref.missed ? ' — сломана спека ИЛИ инструмент' : ''}`);
        check(ref.total === (spec.points || []).length,
            `инструмент прошёл все точки спеки (${ref.total} из ${(spec.points || []).length}) — иначе часть точек он молча пропустил`);
        check(ref.ok + ref.absent === ref.total, `счётчики сводки сходятся: ${ref.ok} на месте + ${ref.absent} ослаблений = ${ref.total}`);
        const want = expectAbsent(config[REF]);
        check(ref.absent === want.length, `ослаблений ${ref.absent}, по флагам «${REF}» посчитано независимо ${want.length}`);
        check(JSON.stringify(ref.absents) === JSON.stringify(want),
            `список ослабленных точек совпал (${ref.absents.join(', ') || '—'} | независимо: ${want.join(', ') || '—'})`);
    }

    // Остальные шлюзы. Ослабления и код возврата сверяются наравне с эталоном (это контракт
    // инструмента), а число пропусков — только печатается: недоделанная вкладка это не повод
    // ронять регресс инструмента, но цифру полезно видеть глазами.
    for (const name of GW_NAMES) {
        if (name === REF) continue;
        const res = run(name);
        const q = parse(res.out);
        check(!!q, `сводка прогона «${name}» разобрана`);
        if (!q) { dump(res.out); continue; }
        const want = expectAbsent(config[name]);
        check(q.absent === want.length, `«${name}»: ослаблений ${q.absent}, по флагам посчитано независимо ${want.length}`);
        check(q.total === (spec.points || []).length, `«${name}»: инструмент прошёл все точки (${q.total} из ${(spec.points || []).length})`);
        // Код возврата — единственное, чем этот инструмент управляет снаружи: 0 ⟺ пропусков нет.
        check((q.missed === 0) === (res.code === 0),
            `«${name}»: код ${res.code} соответствует ${q.missed} пропускам (0 пропусков ⟺ код 0)`);
        console.log(`  · ${name}: ${q.ok}/${q.total} на месте, ${q.absent} ослаблений, ${q.missed} пропусков — цифра к сведению, вердикт не отсюда`);
    }
}

// ── 4. файлы спеки существуют ─────────────────────────────────────────────────
section('файлы · spec.files и адреса точек');
{
    // Адрес точки: ключ `spec.files` (путь берётся из карты) либо литеральный путь от корня.
    // Карта — часть спеки, а не документация: сгнивший путь в ней означает, что все точки
    // этого файла разом напишут «нет файла», и человек пойдёт искать вину в шлюзе.
    const brokenAlias = Object.entries(spec.files || {}).filter(([, rel]) => !fs.existsSync(path.join(REPO, rel))).map(([a, rel]) => `${a} → ${rel}`);
    check(brokenAlias.length === 0, `каждый ключ spec.files указывает на живой файл (${Object.keys(spec.files || {}).length} шт.)${brokenAlias.length ? ' — нет: ' + brokenAlias.join(', ') : ''}`);

    // Литеральные пути подставляются под КОНКРЕТНЫЙ шлюз, поэтому проверяются для каждого.
    // 🪤 Исключение — точки `kind: file`: их смысл ровно в том, что файла может ещё не быть
    // (создаст его копирование вкладки), и красить их в «отсутствует» значит требовать
    // невозможного. Их печатаем справкой: видно, у каких шлюзов вкладка уже обзавелась файлом.
    const lost = [];
    for (const name of GW_NAMES) {
        const gw = config[name];
        for (const p of spec.points || []) {
            if (p.kind === 'file' || isAbsent(p, gw)) continue;
            if (!fs.existsSync(resolve(p.file, gw))) lost.push(`${name}/${p.id} → ${path.relative(REPO, resolve(p.file, gw))}`);
        }
    }
    check(lost.length === 0, `каждая точка (кроме kind file) смотрит на существующий файл${lost.length ? ' — нет: ' + lost.join(', ') : ''}`);

    const ghosts = [];
    for (const name of GW_NAMES) {
        const gw = config[name];
        for (const p of (spec.points || []).filter((x) => x.kind === 'file')) {
            ghosts.push(`${p.id}/${name} ${fs.existsSync(resolve(p.file, gw)) ? 'есть' : 'нет'}`);
        }
    }
    if (ghosts.length) console.log(`  ! kind file (существование не обязательно, это и есть их смысл): ${ghosts.join(' · ')}`);
}

// ── 5. when-флаги осмысленны ──────────────────────────────────────────────────
section('when · флаги условий');
{
    // Набор флагов собирается из данных (булевы ключи конфигов), а не хардкодится: новый флаг
    // должен попадать сюда сам, иначе проверка разъедется с конфигами молча.
    const flags = new Set();
    for (const n of GW_NAMES) for (const [k, v] of Object.entries(config[n])) if (typeof v === 'boolean') flags.add(k);
    check(flags.size > 0, `флаги прочитаны из конфигов (${[...flags].join(', ')})`);

    const used = [...new Set((spec.points || []).filter((p) => Array.isArray(p.when)).flatMap((p) => p.when))].sort();
    check(used.length > 0, `в спеке есть точки с условием (${used.join(', ')})`);

    // Флаг, которого нет ни в одном конфиге, ложен всегда: точка уходит в «ослабления»
    // у КАЖДОГО шлюза, и выглядит это как честное ослабление, а не как опечатка в спеке.
    const unknown = used.filter((f) => !flags.has(f));
    check(unknown.length === 0, `каждый флаг из when — булев ключ конфига${unknown.length ? ' — неизвестны: ' + unknown.join(', ') : ''}`);

    // Флаг, которого нет у ОДНОГО шлюза, читается как false именно у него: шлюз флаг не
    // выключал, а точка у него уже «ожидаемо» ослаблена. Блок 3 ловит это счётчиком,
    // здесь — адресно, по конфигу.
    const holes = [];
    for (const n of GW_NAMES) for (const f of used) if (typeof config[n][f] !== 'boolean') holes.push(`${n}.${f}`);
    check(holes.length === 0, `у каждого шлюза есть все флаги, упомянутые в when (${GW_NAMES.length} конфигов × ${used.length} флагов)${holes.length ? ' — нет: ' + holes.join(', ') : ''}`);

    // Флаги печатаются в шапке прогона. Проверяемый, но не показанный флаг — это ослабление,
    // причину которого человек не увидит: ровно то, от чего инструмент и защищает.
    // Список берём из константы `FLAGS`, если она есть, иначе из инлайнового массива в
    // строке вывода — форму вывода инструмент менял дважды за день, и хардкод одной формы
    // ломал бы регресс на ровном месте (а пустой список молча зеленел бы).
    const flagDecl = (/const FLAGS\s*=\s*\[([^\]]*)\]/.exec(toolSrc) || [])[1];
    const flagLine = toolSrc.split('\n').find((l) => l.includes('.map(f =>') && l.includes('gw[f]')) || '';
    const flagSrc = flagDecl != null ? flagDecl : flagLine;
    const shown = [...flagSrc.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1]);
    check(shown.length > 0 && flagLine.length > 0,
        `список флагов найден (${shown.join(', ') || 'ни константы FLAGS, ни инлайнового массива — регексп устарел'})`);
    const notShown = used.filter((f) => !shown.includes(f));
    check(notShown.length === 0, `каждый флаг из when показан в шапке прогона${notShown.length ? ' — нет: ' + notShown.join(', ') : ''}`);
}

// ── 6. контракт самого инструмента ────────────────────────────────────────────
section('add-gateway.js · контракт');
{
    // 🪤 До 17.09 здесь стояло «check работает только на чтение», и это утверждение было из
    // версии ДО `apply`: инструмент уже умел писать по флагу `--write`, а тест падал (58/59)
    // и ждал починки — «снять это утверждение осознанно, а не закомментировать на минутку».
    // Замена сильнее прежней: проверяется ПОВЕДЕНИЕ, а не наличие строк в исходнике —
    // сухой прогон на шлюзе, который реально собирается вставлять 90+ блоков, не смеет
    // тронуть ни один файл. Проба идёт по fluxnat: вкладки у него нет, вставлять есть что,
    // ломать нечего.
    const hashOf = (rel) => crypto.createHash('sha1').update(fs.readFileSync(path.join(REPO, rel))).digest('hex');
    const touched = new Set();
    for (const p of spec.points || []) {
        if (p.kind === 'file') continue;
        const rel = path.relative(REPO, resolve(p.file, config[REF] || config.kktoken)).split(path.sep).join('/');
        if (!rel.startsWith('..') && fs.existsSync(path.join(REPO, rel))) touched.add(rel);
    }
    const before = new Map([...touched].map((rel) => [rel, hashOf(rel)]));
    const dry = spawnSync(process.execPath, [ADD_GATEWAY, 'apply', 'fluxnat'], { encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    const dryOut = (dry.stdout || '') + (dry.stderr || '');
    check(dry.status === 0, `сухой прогон apply отдал код 0 (получено ${dry.status})`);
    check(/Сухой прогон/.test(dryOut), 'сухой прогон сам себя называет сухим — запись только по --write');
    const changedFiles = [...touched].filter((rel) => hashOf(rel) !== before.get(rel));
    check(changedFiles.length === 0,
        `сухой прогон не тронул ни одного файла (сверено ${touched.size} по sha1)${changedFiles.length ? ' — ИЗМЕНЕНЫ: ' + changedFiles.join(', ') : ''}`);
    check(/--write/.test(toolSrc), 'флаг --write у apply на месте (запись только осознанным действием)');

    check(/missing\.length\s*\?\s*1\s*:\s*0/.test(toolSrc), 'пропуски возвращают код 1 — иначе провал не виден ни глазами, ни скриптом');
    check(/process\.exit\(main\(\)\)/.test(toolSrc), 'код возврата пробрасывается из main() (process.exit(main()))');

    // Отчёт (`check`) и план (`plan`) читают ОДНУ спеку и обязаны видеть её одинаково:
    // разъедутся — отчёт скажет «на месте», а план укажет вставлять в другое место.
    // Общее окно `within` — то место, где это расходится незаметнее всего.
    const withinFn = (/function withinMarker\(([\s\S]*?)\n}/.exec(toolSrc) || [])[1] || '';
    const planFn = (/function planPoint\(([\s\S]*?)\n}/.exec(toolSrc) || [])[1] || '';
    check(/findWithinLine\(/.test(withinFn) && /findWithinLine\(/.test(planFn),
        'окно `within` у check и plan ищется одной функцией findWithinLine — иначе план и отчёт разъедутся');
    check(['check', 'plan', 'list'].every((c) => toolSrc.includes(`'${c}'`)), 'команды check / plan / list на месте');

    // Проба «витрины»: `list` — то, что человек видит первым. Ключи-документация конфига
    // (`_readme`) — обычные ключи, и перебор печатает их как шлюз с undefined во всех полях.
    const l = spawnSync(process.execPath, [ADD_GATEWAY, 'list'], { encoding: 'utf8', cwd: REPO });
    const lout = (l.stdout || '') + (l.stderr || '');
    check(l.status === 0 && /kktoken/.test(lout), `list отвечает кодом 0 и печатает шлюзы (код ${l.status})`);
    const undef = lout.split('\n').filter((line) => line.includes('undefined'));
    if (undef.length) {
        warn(`list печатает ключи-документацию конфига как шлюзы — ${undef.length} стр. с undefined: «${undef[0].trim()}». Перебор конфига должен пропускать ключи на «_»`);
    }
}

// ── 7. сторожа региона: чужой код и записи-матрёшки ───────────────────────────
section('сторожа `apply` · чужой код в регионе и записи-матрёшки');
{
    // Оба дефекта найдены на nova 17.09, и оба инструмент пропустил: сухой прогон печатал
    // «0 дефектов» и «строк 40» вместо 25. Поэтому у каждого сторожа здесь ДВА утверждения:
    // живой файл чист, а реплей дефекта (склеенные блоки / вложенная запись) — ловится.
    const tool = require(ADD_GATEWAY);
    check(typeof tool.codeArtifacts === 'function' && typeof tool.nestedEntries === 'function',
        'инструмент экспортирует сторожа codeArtifacts и nestedEntries');

    // Реплей №1: регион `until-blank` проглотил блок соседа — блоки склеены, пустой строки нет.
    const backend = read(path.join(REPO, 'routing/transparent-proxy.js')) || '';
    const bl = backend.split('\n');
    const blankAfter = (from) => { let i = from + 1; while (i < bl.length && bl[i].trim() !== '') i += 1; return i - 1; };
    const kkStart = bl.findIndex((l) => l.includes('const KK_SESSIONS_FILE'));
    const nvStart = bl.findIndex((l) => l.includes('const NV_SESSIONS_FILE'));
    const kkRegion = kkStart >= 0 ? bl.slice(kkStart, blankAfter(kkStart) + 1).join('\n') : '';
    const nvRegion = nvStart >= 0 ? bl.slice(nvStart, blankAfter(nvStart) + 1).join('\n') : '';
    check(kkStart >= 0 && nvStart > kkStart, 'блоки констант KKtoken и Nova найдены в бэкенде');
    const kkHits = tool.codeArtifacts(kkRegion, REF, config);
    check(kkHits.length === 0,
        `живой регион констант KKtoken чист от чужого кода${kkHits.length ? ' — ' + kkHits.join(', ') : ''}`);
    const gluedHits = tool.codeArtifacts(kkRegion + '\n' + nvRegion, REF, config);
    check(gluedHits.some((h) => h.startsWith('nova')),
        `реплей: склеенные константы KK и Nova сторож видит${gluedHits.length ? ' (' + gluedHits.join(', ') + ')' : ' — НЕ ВИДИТ'}`);

    // Реплей №2: запись `$perPort` несёт вложенную копию записи соседа (так было в HEAD).
    const ps1Rel = 'routing/keepalive-restart.ps1';
    const ps1 = read(path.join(REPO, ps1Rel)) || '';
    const ENTRY = /^  (\d{5}) = @\{/;
    const liveNested = tool.nestedEntries(ps1, ENTRY);
    check(liveNested.length === 0,
        `в $perPort нет записей-матрёшек${liveNested.length ? ' — ' + liveNested.map((n) => n.key + ' внутри ' + n.inside).join(', ') : ''}`);

    const entryText = (text, key) => {
        const ls = String(text).split('\n');
        const start = ls.findIndex((l) => new RegExp('^  ' + key + ' = @\\{').test(l));
        if (start < 0) return '';
        let depth = 0;
        for (let i = start; i < ls.length; i += 1) {
            for (const ch of ls[i]) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1; }
            if (depth === 0) return ls.slice(start, i + 1).join('\n');
        }
        return '';
    };
    // Корпус: испорченная копия из HEAD, если она там ещё лежит (записи выпрямлены 17.09,
    // и после коммита этой правки HEAD станет чистым). Нет — собираем ту же порчу сами.
    const headPs1 = (spawnSync('git', ['show', 'HEAD:' + ps1Rel], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).stdout) || '';
    let corpus = '';
    let from = '';
    if (tool.nestedEntries(headPs1, ENTRY).length) { corpus = headPs1; from = 'HEAD'; }
    else {
        const lines = ps1.split('\n');
        const at = lines.findIndex((l) => /^  20161 = @\{/.test(l));
        corpus = [
            ...lines.slice(0, at + 1),
            `  20168 = @{ UPSTREAM = 'https://www.getunikey.ai'; KEY_FILE = "$profileDir\\.claude\\getunikey-active-key.txt";`,
            `             MODELMAP_FILE = (Join-Path $dir 'getunikey-modelmap.json') }`,
            ...lines.slice(at + 1),
        ].join('\n');
        from = 'собранная копия';
    }
    const nested = tool.nestedEntries(corpus, ENTRY);
    check(nested.length > 0,
        `испорченная копия $perPort (${from}): записей-матрёшек ${nested.length}${nested.length ? ' — ' + nested.map((n) => n.key + ' внутри ' + n.inside).join(', ') : 'НЕ НАЙДЕНО'}`);
    const entry = entryText(corpus, '20161');
    const entryHits = tool.codeArtifacts(entry, REF, config);
    check(entryHits.some((h) => h.startsWith('getunikey')),
        `...и внутри записи 20161 сторож видит чужой код${entryHits.length ? ' (' + entryHits.join(', ') + ')' : ' — НЕ ВИДИТ'}`);

    // Реплей №3: запись реестра внутри записи того же реестра (JS-вариант, класс BACKENDS).
    const backends = backend.slice(backend.indexOf('const BACKENDS = {'), backend.indexOf('const BACKENDS_REGISTRY_FILE'));
    const jsNested = tool.nestedEntries(backends, /^    ([a-z_0-9]+): \{/);
    check(jsNested.length === 0,
        `в реестре BACKENDS нет записей-матрёшек${jsNested.length ? ' — ' + jsNested.map((n) => n.key + ' внутри ' + n.inside).join(', ') : ''}`);

    // 🪤 Инвариант, из-за которого всё и случилось: блок констант эталона кончается ПУСТОЙ
    // строкой — на ней и стоит регион `until-blank`. Нет пустой — регион проглатывает блок
    // соседа (так в клон Nova уехали константы Odyssey). Проверяем ровно это и ровно для
    // эталона: у остальных шлюзов блоки кончаются чем угодно, но клонируют-то с эталона.
    // Граница самого региона проверяется выше — `codeArtifacts` на нём обязан молчать.
    check(String(bl[blankAfter(kkStart) + 1] || '').trim() === '',
        'после региона констант эталона стоит пустая строка — регион `until-blank` кончается на ней');
}

// ── 8. полнота спеки: реестр с ключом эталона, под который нет точки ───────────
section('полнота спеки · реестры с ключом эталона');
{
    // Правило простое: если эталон ВОШЁЛ в реестр (его ключ там есть), то и у цели он обязан
    // быть — значит под этот реестр нужна точка спеки. Иначе вкладка выходит «рабочая, но
    // одна кнопка молчит»: 17.09 так и вышло, и всплыло живьём тостом «GitHub: неизвестный
    // шлюз nv» — реестра NEWAPI_SEED_PROV в спеке не было вовсе. Сканом нашлись ещё три:
    // ghAddPick, карта тег→полное имя и карты pid в ghLkPidsByTag.
    const gw = config[REF];
    // Строку считаем реестром, если ключ эталона стоит в ней КЛЮЧОМ: `kk: …` или `kktoken: …`.
    const lineKey = new RegExp('(^|[ ,{])(' + gw.p + '|' + gw.full + '): ');
    // Точка закрывает реестр, если её ожидание само называет шлюз ключом (`kk: 'kktoken'`)
    // или именованным полем (`id: 'kktoken'`, `tab: 'kktoken'`). Голое `'kktoken'` (так
    // выглядит ожидание точки MONEY_PROVIDERS) закрывающим не считается — иначе оно
    // «покрывало» бы любую строку с именем шлюза, включая непокрытые реестры.
    const nameKey = new RegExp('(^|[ ,{])(' + gw.p + '|' + gw.full + '):');
    const nameField = new RegExp('(\\w+):\\s*\'?' + gw.full);
    const isKeyNeedle = (s) => nameKey.test(s) || nameField.test(s);
    const uncovered = [];
    for (const [alias, rel] of Object.entries(spec.files || {})) {
        const text = read(path.join(REPO, rel));
        if (!text) continue;
        const anchors = (spec.points || []).filter((p) => p.file === alias)
            .flatMap((p) => [...(Array.isArray(p.expect) ? p.expect : [p.expect]), ...(p.any || [])])
            .filter((x) => typeof x === 'string')
            .map((x) => subst(x, gw))
            .filter(isKeyNeedle);
        text.split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*|<!--)/.test(line)) return;      // комментарий с упоминанием — не реестр
            if (!lineKey.test(line)) return;
            if (!anchors.some((a) => line.includes(a))) uncovered.push(`${rel}:${i + 1} → ${line.trim().slice(0, 70)}`);
        });
    }
    check(uncovered.length === 0,
        `каждый реестр с ключом «${gw.p}:» / «${gw.full}:» покрыт точкой спеки${uncovered.length ? ' — нет: ' + uncovered.slice(0, 4).join(' | ') : ''}`);
}

// ── 9. полнота спеки: литеральный СПИСОК префиксов, под который нет точки ──────
section('полнота спеки · литеральные списки префиксов');
{
    // Сторож §8 видит реестр с КЛЮЧОМ эталона (`kk: …`) и слеп ко второй форме того же
    // реестра — ЛИТЕРАЛЬНОМУ перечислению префиксов: `(?:ar|…|kk|hn|ol)` в регулярке или
    // `['ar', …, 'kk', 'hn']` в массиве. Мимо него прошёл список ручек ротации в
    // `routing/transparent-proxy.js`: без `od` (17.09), без `bd` и `nv` (21.09) — просьба
    // о подмене ключа уезжала в 404, а снаружи это выглядело как «авторотация не
    // сработала на пустом пуле». Ровно тот класс, ради которого инструмент и существует:
    // вкладка есть, а одна ветка молчит. Контракт тот же, что у §8: эталон в списке —
    // значит под список обязана быть точка спеки.
    const gw = config[REF];
    const known = [...new Set(Object.values(config).filter((x) => x && x.p).map((x) => x.p))];
    const inList = (line, p) => new RegExp("[" + "\\|\\(\\)\\[\\]'\"" + "]" + p + "[" + "\\|\\(\\)\\[\\]'\"" + "]").test(line);
    const targets = [...new Set([
        ...Object.values(spec.files || {}).map((rel) => path.join(REPO, rel)),
        ...(spec.points || []).map((p) => resolve(p.file, gw)),   // точки с путём вместо алиаса (check-hub.js)
    ])];
    const uncovered = [];
    for (const abs of targets) {
        const text = read(abs);
        if (!text) continue;
        const rel = path.relative(REPO, abs).split(path.sep).join('/');
        const anchors = (spec.points || [])
            .filter((p) => resolve(p.file, gw) === abs)
            .flatMap((p) => [...(Array.isArray(p.expect) ? p.expect : [p.expect]), ...(p.any || [])])
            .filter((x) => typeof x === 'string')
            .map((x) => subst(x, gw));
        text.split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*|<!--)/.test(line)) return;              // упоминание в комментарии — не реестр
            if (!inList(line, gw.p)) return;
            // Именно СПИСОК, а не случайное упоминание: на строке минимум три префикса конфига.
            if (known.filter((p) => inList(line, p)).length < 3) return;
            if (!anchors.some((a) => a && line.includes(a))) uncovered.push(`${rel}:${i + 1} → ${line.trim().slice(0, 70)}`);
        });
    }
    check(uncovered.length === 0,
        `каждый литеральный список префиксов покрыт точкой спеки${uncovered.length ? ' — нет: ' + uncovered.slice(0, 4).join(' | ') : ''}`);
}

// ── 10. опора share/import: хендлер не зовёт необъявленное ─────────────────────
section('опора share/import · хендлер зовёт только объявленное');
{
    // Класс дефекта, найденный 21.09 на Lingshu и живший у budsin, nova и odyssey: спека
    // клонирует хендлеры `handle%x%Share` и `handle%x%Import`, а их ОПОРУ — `%p%B64UrlEncode`,
    // `%P%_SESSIONS_DIR`, `%P%_SHARE_SCRIPT` — нет. Клон ссылается на имена, которых в файле
    // не существует, кнопка передачи аккаунта падает `ReferenceError`-ом, а снаружи это
    // выглядит как «кнопка ничего не делает».
    //
    // 🪤 Почему это не ловилось: `node --check` пропускает (отсутствующее имя — не
    // SyntaxError), а `check <шлюз>` проверяет НАЛИЧИЕ хендлера (точка 1.18), а не то, на что
    // хендлер опирается. Первая версия проверки перечисляла конкретные имена — и развалилась
    // бы на первом же новом; здесь проверяется сам класс.
    //
    // Инструмент обязан ловить это у СЕБЯ, потому что чинится это спекой: точке 1.18 нужна
    // пара — точка на опору. Обе заведены (1.18a, 1.18b).
    const text = read(path.join(REPO, 'routing', 'transparent-proxy.js'));
    if (text) {
        // Объявленным считаем любое объявление в файле, включая локальное внутри хендлера.
        const declared = new Set();
        for (const m of text.matchAll(/(?:^|\s)(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);

        const bodyOf = (startIdx) => {
            let depth = 0, i = startIdx;
            for (; i < text.length; i += 1) {
                if (text[i] === '{') depth += 1;
                else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(startIdx, i + 1); }
            }
            return text.slice(startIdx);
        };

        const dangling = [];
        for (const [name, gw] of Object.entries(config)) {
            if (name.startsWith('_')) continue;
            const x = gw.p.charAt(0).toUpperCase() + gw.p.slice(1);
            for (const kind of ['Share', 'Import']) {
                const at = text.indexOf(`function handle${x}${kind}(`);
                if (at < 0) continue;                       // хендлера нет — это дело точки 1.18
                const body = bodyOf(text.indexOf('{', at));
                // Имена СВОЕГО префикса: `bdLoad`, `BdXxx`, `BD_CONST`. Регистр после префикса
                // обязателен — иначе в выборку попадут слова вроде `bdapi` из строк лога.
                const own = new Set();
                for (const m of body.matchAll(new RegExp('\\b(' + gw.p + '[A-Z][\\w$]*|' + gw.P + '_[A-Z_]+)\\b', 'g'))) own.add(m[1]);
                for (const id of own) if (!declared.has(id)) dangling.push(`${name}: handle${x}${kind} зовёт «${id}», а он не объявлен`);
            }
        }
        check(dangling.length === 0,
            `опора share/import объявлена у каждого шлюза${dangling.length ? ' — нет: ' + dangling.slice(0, 6).join(' | ') : ''}`);
    }
}

// ── итог ──────────────────────────────────────────────────────────────────────
if (warns.length) console.log(`\n! замечаний без провала: ${warns.length} (в вердикт не идут)`);
console.log(`\ncheck-add-gateway: ${total - fails.length}/${total}`);
if (fails.length) {
    console.log(`\n✗ провалено ${fails.length}:`);
    for (const m of fails) console.log(`   • ${m}`);
    console.log('\nЧинить надо спеку (tools/gateways.spec.json) или сам инструмент (tools/add-gateway.js):');
    console.log('этот файл описывает их контракт и правится только вместе с ним.');
    process.exit(1);
}
console.log('инструмент проверки вкладок жив · эталон kktoken даёт ПОЛНО · спека структурно валидна · токены целы');
