'use strict';
// Адаптер статистики Claude Code для Лиги: один канонический счётчик токенов для всех
// участников, посчитанный по тем же правилам, что показывает сам Claude Code.
//
// Зачем отдельный модуль. Лига до сих пор складывала `max(дневной ряд кеша, журнал
// front-door) + другие приложения` и называла суммой неполного дневного ряда общий итог.
// Это разные величины: у Claude Code общий итог берётся из исторического `modelUsage`
// (`inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens`), а
// дневной ряд после миграции `dailyModelTokensVersion: 5` пересобирается из СОХРАНИВШИХСЯ
// транскриптов. Отсюда оба правила ниже: total и дни - независимые величины, а неизвестный
// участок помечается пропуском, а не превращается в ноль.
//
// Границы модуля:
//   - только чтение; ничего не пишет ни в кеш Claude Code, ни в свои файлы;
//   - никаких внешних зависимостей, только node: builtins;
//   - fs передаётся снаружи (тесты подставляют синтетический), поэтому логику можно
//     проверить без живых данных;
//   - пути строятся от корня конфигурации, без имён пользователей и букв диска;
//   - наружу уезжают только числа, даты и коды; путей, имён файлов и текстов в снимке нет.
//
// Чем ограничен охват и почему это не «недосчёт»:
//   - дни внутри окна кеша (<= `lastComputedDate`) берём ТОЛЬКО из дневного ряда кеша.
//     Если строки за такой день нет (её снесла миграция), день становится пропуском:
//     транскрипты за него не подставляем, потому что те же события уже сидят в lifetime
//     из `modelUsage`, и подстановка посчитала бы их дважды;
//   - дни после watermark транскрипты дают как `input + output`: кеш контекста и создание
//     кеша в этих записях нулевые, поэтому хвост делает lifetime неполным (флаг
//     `completeLifetime: false`), а не «полным с кешем»;
//   - сам Claude Code читает не больше последних 100 МиБ файла и не дедуплицирует `message.id`;
//     повторяем ровно это и помечаем усечение флагом, а не молчим.
const fsDefault = require('fs');
const os = require('os');
const path = require('path');

const ACCOUNTING_VERSION = 1;              // версия ЭТОГО определения; едет в срез
const CACHE_VERSIONS = new Set([1, 2, 3, 4, 5]);
const TAIL_CAP_BYTES = 100 * 1024 * 1024;  // как у Claude Code: только хвост файла
const SERIES_WIRE_MAX = 400;               // сколько дней истории едет в срез (хвост свежих)
const TYPES = new Set(['user', 'assistant', 'attachment', 'system']);
const DAY_MS = 86400000;

const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
const hourKey = ms => new Date(ms).toISOString().slice(0, 13);
const dayStart = dk => Date.parse(dk + 'T00:00:00.000Z');
const hourStart = hk => Date.parse(hk + ':00:00.000Z');
const HOUR_MS = 3600000;

function resolveRoot(rootArg) {
    if (rootArg) return rootArg;
    if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
    return path.join(os.homedir(), '.claude');
}

// ── Прочие харнессы из журнала front-door ────────────────────────────────────────
// Claude Code считается из своих данных (кеш и транскрипты). Всё остальное, что шло через
// front-door - opencode, curl, разовые скрипты, - видно только в журнале хаба, и харнесс
// там помечен по user-agent. Правило строгое: записи `claude-code` из журнала в счёт НЕ
// идут, иначе тот же трафик посчитается дважды (он есть и в транскриптах, и в журнале).
//
// Охват журнала честно неполный: он ротируется целыми сутками (потолок 32 МиБ), поэтому
// «всё время» по прочим харнессам - это то, что уцелело в файле, и так это и подписано.
const JOURNAL_CAP_BYTES = 32 * 1024 * 1024;
const DEFAULT_JOURNAL = path.join(__dirname, 'token-usage.jsonl');
const OTHER_HARNESS_MAX = 8;
// Имя харнесса приходит из user-agent, то есть снаружи. Оставляем только буквы, цифры и
// три знака, остальное выбрасываем: имя уезжает в чужой срез и рисуется в разметке.
// 🪤 Никаких escape-последовательностей: в исходнике не должно быть ни сырых управляющих
// байтов, ни хитрых классов - фильтруем по одному символу.
const HARNESS_OK = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-';
const harnessName = v => {
    let out = '';
    for (const ch of String(v == null ? '' : v)) {
        if (HARNESS_OK.indexOf(ch) >= 0 && out.length < 24) out += ch;
    }
    return out || 'unknown';
};

function readJournal(deps, journalPath, cap) {
    const f = (deps && deps.fs) || fsDefault;
    const out = {
        byHarness: new Map(), days: Object.create(null), hours: Object.create(null),
        lines: 0, skipped: 0, firstMs: null, lastMs: null, truncated: false, reason: null,
    };
    let r;
    try { r = readTail({ fs: f }, journalPath, cap || JOURNAL_CAP_BYTES); }
    catch (e) { out.reason = 'no-journal'; return out; }
    out.truncated = !!r.truncated;
    for (const raw of r.text.split('\n')) {
        const s = raw.trim();
        if (!s) continue;
        let e;
        try { e = JSON.parse(s); } catch (x) { continue; }        // обрыв хвоста записи
        const ms = Date.parse(e && e.t);
        if (!Number.isFinite(ms)) { out.skipped++; continue; }
        const h = harnessName(e.h);
        if (h === 'claude-code') continue;                         // двойного счёта не делаем
        const tok = asNum(e.in) + asNum(e.out);
        if (!tok) continue;
        out.lines++;
        if (out.firstMs === null || ms < out.firstMs) out.firstMs = ms;
        if (out.lastMs === null || ms > out.lastMs) out.lastMs = ms;
        const dk = dayKey(ms), hk = hourKey(ms);
        out.days[dk] = (out.days[dk] || 0) + tok;
        out.hours[hk] = (out.hours[hk] || 0) + tok;
        const rec = out.byHarness.get(h) || { h, tokens: 0, days: Object.create(null) };
        rec.tokens += tok;
        rec.days[dk] = (rec.days[dk] || 0) + tok;
        out.byHarness.set(h, rec);
    }
    if (out.lastMs === null) out.reason = 'empty-journal';
    return out;
}

// Хвост файла: ровно то, что видит сам Claude Code (`_Me` в его сборке - последние 100 МиБ,
// с выравниванием по переводу строки). Последний аргумент - лимит для тестов.
function readTail(deps, file, cap) {
    const f = (deps && deps.fs) || fsDefault;
    const limit = cap || TAIL_CAP_BYTES;
    const st = f.statSync(file);
    const buf = f.readFileSync(file);
    const truncated = st.size > limit;
    const slice = truncated ? buf.subarray(buf.length - limit) : buf;
    let text = slice.toString('utf8');
    if (truncated) {
        const nl = text.indexOf('\n');
        text = nl !== -1 && nl < text.length - 1 ? text.slice(nl + 1) : text;
    }
    return { text, truncated };
}

// Строки JSONL. Битая строка (в том числе недописанный хвост записи) пропускается:
// файл пишется прямо сейчас, и это нормальное состояние, а не ошибка.
function parseLines(text) {
    const out = [];
    for (const raw of text.split('\n')) {
        const s = raw.trim();
        if (!s) continue;
        try { out.push(JSON.parse(s)); } catch (e) { /* хвост недописан */ }
    }
    return out;
}

const asNum = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const usedOf = u => ({
    in: asNum(u && u.input_tokens),
    out: asNum(u && u.output_tokens),
    cr: asNum(u && u.cache_read_input_tokens),
    cw: asNum(u && u.cache_creation_input_tokens),
});

function listTranscripts(f, projectsDir) {
    const out = [];
    let projects;
    try { projects = f.readdirSync(projectsDir); } catch (e) { return out; }
    for (const p of projects) {
        const dir = projectsDir + '/' + p;
        let names;
        try { names = f.readdirSync(dir); } catch (e) { continue; }
        for (const n of names) {
            if (n.slice(-6) !== '.jsonl') continue;
            const session = n.slice(0, -6);
            out.push(dir + '/' + n);
            // Токены вложенных агентов Claude Code считает в общий итог, хотя их сессии и
            // активность - нет. Ищем ровно тот путь, который он обходит.
            for (const a of agentFiles(f, dir + '/' + session + '/subagents')) out.push(a);
        }
    }
    return out;
}

function agentFiles(f, dir) {
    let names;
    try { names = f.readdirSync(dir); } catch (e) { return []; }
    return names.filter(n => /^agent-.*\.jsonl$/.test(n)).map(n => dir + '/' + n);
}

// Вклад одного файла: токены по UTC-дням, часы, признак сессии. Чистая функция от текста,
// поэтому кеш-слой может держать её результат в памяти и переиспользовать без чтения.
function readContribution(deps, file, isAgent) {
    const r = readTail(deps, file);
    const c = {
        cc: {}, cr: {}, cw: {}, hours: {}, activeDays: {}, hourTok: {}, messages: 0, files: 0,
        sidechainSessions: 0, truncated: !!r.truncated, ok: false,
    };
    const rows = parseLines(r.text).filter(e => e && TYPES.has(e.type));
    if (!rows.length) return c;
    const main = rows.filter(e => e.isSidechain !== true);
    const chosen = isAgent ? rows : main;
    if (!chosen.length) return c;
    const firstMs = Date.parse(chosen[0].timestamp);
    const lastMs = Date.parse(chosen[chosen.length - 1].timestamp);
    if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return c;
    c.ok = true;
    // Сессию считаем по главному файлу: у вложенного агента своя «сессия» в отдельном файле,
    // и прибавлять её к человеческим сессиям нельзя.
    if (!isAgent) {
        c.files = 1;
        if (main.length !== rows.length) c.sidechainSessions = 1;
    }
    for (const e of chosen) {
        if (e.type !== 'assistant') continue;
        const ms = Date.parse(e.timestamp);
        if (!Number.isFinite(ms)) continue;
        const dk = dayKey(ms);
        const u = usedOf(e.message && e.message.usage);
        c.cc[dk] = (c.cc[dk] || 0) + u.in + u.out;
        c.cr[dk] = (c.cr[dk] || 0) + u.cr;
        c.cw[dk] = (c.cw[dk] || 0) + u.cw;
        // Часовая корзина - та же gross-величина, что и суточная, и тоже в UTC: окно «сутки»
        // в Лиге скользящее, и собрать его из календарных дней нельзя.
        const hk = hourKey(ms);
        c.hourTok[hk] = (c.hourTok[hk] || 0) + u.in + u.out + u.cr + u.cw;
        // Активный день создаёт только главный файл: у Claude Code день, где работал один
        // вложенный агент, в `dailyActivity` не появляется вовсе.
        if (!isAgent) c.activeDays[dk] = 1;
        const h = String(new Date(ms).getUTCHours());
        c.hours[h] = (c.hours[h] || 0) + 1;
        c.messages++;
    }
    return c;
}

function emptyAgg() {
    return {
        daily: { cc: {}, cacheRead: {}, cacheWrite: {} },
        hours: {}, activeDays: {}, hourTok: {}, messages: 0, files: 0, firstMs: null, lastMs: null,
        truncatedFiles: 0, skipped: 0, sidechainSessions: 0,
    };
}

// Свернуть вклады файлов и кеш в снимок. Здесь нет ни одного обращения к диску: именно
// поэтому кеш-слой может пересобрать снимок из памяти за миллисекунды.
function foldStats(contribs, meta) {
    const agg = emptyAgg();
    for (const c of contribs) {
        if (!c) continue;
        if (c.truncated) agg.truncatedFiles++;
        if (!c.ok) { agg.skipped++; continue; }
        agg.files += c.files;
        agg.messages += c.messages;
        agg.sidechainSessions += c.sidechainSessions;
        for (const dk of Object.keys(c.cc)) agg.daily.cc[dk] = (agg.daily.cc[dk] || 0) + c.cc[dk];
        for (const dk of Object.keys(c.activeDays)) agg.activeDays[dk] = 1;
        for (const hk of Object.keys(c.hourTok)) agg.hourTok[hk] = (agg.hourTok[hk] || 0) + c.hourTok[hk];
        for (const dk of Object.keys(c.cr)) agg.daily.cacheRead[dk] = (agg.daily.cacheRead[dk] || 0) + c.cr[dk];
        for (const dk of Object.keys(c.cw)) agg.daily.cacheWrite[dk] = (agg.daily.cacheWrite[dk] || 0) + c.cw[dk];
        for (const h of Object.keys(c.hours)) agg.hours[h] = (agg.hours[h] || 0) + c.hours[h];
    }
    return snapshotFrom(agg, meta);
}

// Стрик активных UTC-дней. Считается от сегодняшнего дня, без «прощения» вчерашнего, как в
// самом Claude Code; активность тут - сообщения в транскриптах, а не вводы в history.jsonl
// (это отдельная метрика Лиги и другого числа не даёт).
function streaks(activeDays, now) {
    const set = new Set(activeDays);
    let cur = 0;
    for (let ms = dayStart(dayKey(now)); set.has(dayKey(ms)); ms -= DAY_MS) cur++;
    let longest = 0, run = 0, prev = null;
    for (const dk of [...set].sort()) {
        const ms = dayStart(dk);
        run = (prev !== null && ms - prev === DAY_MS) ? run + 1 : 1;
        prev = ms;
        if (run > longest) longest = run;
    }
    return { current: cur, longest };
}

function snapshotFrom(agg, meta) {
    const { doc, reason, cacheExists, now, today, cacheRaw } = meta;
    // Активность - дни, в которых были сообщения. Живой замер 16.09 показал, почему брать её
    // только по уцелевшим транскриптам нельзя: старые сессии удалены, и выходило 31 активный
    // день против 82 на экране `/stats`. Кеш `dailyActivity` историю хранит - объединяем её с
    // тем, что нашли в транскриптах (второе закрывает дни после watermark).
    const activitySet = new Set();
    for (const r of ((doc && doc.dailyActivity) || [])) {
        if (r && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) activitySet.add(r.date);
    }
    for (const dk of Object.keys(agg.activeDays)) activitySet.add(dk);
    const activityDays = [...activitySet].sort();
    if (!doc && !activityDays.length) {
        return {
            accountingVersion: ACCOUNTING_VERSION, available: false,
            // «Нет источников» - это отсутствие и кеша, и транскриптов; если кеш был, но
            // нечитаем, причина обязана называть именно его.
            reason: cacheExists ? reason : 'no-sources',
            lifetimeCC: null, lifetimeLowerBound: null, completeLifetime: false,
            totals: { d7: null, d30: null }, daily: { keys: [], known: {}, basis: {} },
            activity: { activeDays: 0, sessions: 0, messages: 0, streak: { current: 0, longest: 0 }, lastDate: null, hours: {} },
            source: { cache: null, cacheVersion: null, dailyVersion: null, watermark: null, firstSession: null },
            coverage: { unknownDays: 0 }, truncatedFiles: agg.truncatedFiles,
        };
    }

    const inSum = {}, outSum = {}, crSum = {}, cwSum = {};
    for (const m of Object.keys((doc && doc.modelUsage) || {})) {
        const u = (doc.modelUsage)[m] || {};
        inSum[m] = asNum(u.inputTokens);
        outSum[m] = asNum(u.outputTokens);
        crSum[m] = asNum(u.cacheReadInputTokens);
        cwSum[m] = asNum(u.cacheCreationInputTokens);
    }
    const dailyCache = {};
    for (const rec of ((doc && doc.dailyModelTokens) || [])) {
        if (!rec || !rec.date) continue;
        let sum = 0;
        for (const m of Object.keys(rec.tokensByModel || {})) sum += asNum(rec.tokensByModel[m]);
        dailyCache[rec.date] = sum;
    }

    const wm = doc && doc.lastComputedDate;
    const wmMs = wm ? dayStart(wm) : null;
    const known = {}, basis = {};
    let tailGross = 0, afterWatermark = false, unknownDays = 0;

    for (const dk of Object.keys(dailyCache)) { known[dk] = dailyCache[dk]; basis[dk] = 'cache'; }
    // Дни внутри окна кеша без своей строки: пропуск. Транскрипты за них не подставляем -
    // те же события уже в lifetime из modelUsage, и это был бы двойной счёт.
    if (doc) {
        const minCache = Object.keys(dailyCache).sort()[0];
        for (const dk of Object.keys(agg.daily.cc)) {
            if (wmMs !== null && dayStart(dk) <= wmMs && dailyCache[dk] === undefined) {
                if (minCache === undefined || dk < minCache) continue;   // до первой строки кеша - не наш участок
                basis[dk] = 'unknown'; unknownDays++;
            }
        }
    }
    // Хвост после watermark: транскрипты хранят ВСЕ четыре категории (замер 16.09 на живой
    // машине - сутки дали 0,105 млрд входа+выхода и 3,479 млрд чтения кеша), поэтому день
    // считается той же gross-величиной, что и день из кеша. Иначе график ломался бы ступенькой
    // на границе watermark, а total недосчитывал кеш сегодняшнего дня против `/stats`.
    const tailInOut = {};
    for (const dk of Object.keys(agg.daily.cc)) {
        const ms = dayStart(dk);
        if (wmMs !== null && ms <= wmMs) continue;      // внутри окна кеша транскрипты не считаем
        if (ms > now) continue;                          // будущее (сбитые часы) не считаем
        const gross = agg.daily.cc[dk] + (agg.daily.cacheRead[dk] || 0) + (agg.daily.cacheWrite[dk] || 0);
        known[dk] = gross;
        basis[dk] = 'transcript';
        tailInOut[dk] = agg.daily.cc[dk];
        tailGross += gross;
        afterWatermark = true;
    }
    // Диагностика кеша - только за дни, которые реально взяты из транскриптов: за дни кеша
    // эти же числа уже сидят в `modelUsage`, и второй раз показывать их незачем.
    const tailCache = {};
    for (const dk of Object.keys(agg.daily.cacheRead)) {
        if (basis[dk] !== 'transcript') continue;
        tailCache[dk] = { read: agg.daily.cacheRead[dk] || 0, write: agg.daily.cacheWrite[dk] || 0 };
    }

    // Прочие харнессы из журнала front-door. Дни и часы ВЛИВАЕМ в общий ряд, а не держим
    // отдельной кривой: цифра и график обязаны говорить одно и то же. Записи `claude-code`
    // сюда не доходят (см. readJournal) - Claude Code уже посчитан по транскриптам.
    const jr = meta.journal || null;
    const otherDays = (jr && jr.days) || {};
    const otherD7 = Object.keys(otherDays)
        .filter(dk => dayStart(dk) >= dayStart(today) - 6 * DAY_MS).reduce((s, dk) => s + otherDays[dk], 0);
    const otherD30 = Object.keys(otherDays)
        .filter(dk => dayStart(dk) >= dayStart(today) - 29 * DAY_MS).reduce((s, dk) => s + otherDays[dk], 0);
    for (const dk of Object.keys(otherDays)) {
        if (known[dk] === undefined) { known[dk] = otherDays[dk]; basis[dk] = 'journal'; }
        else known[dk] += otherDays[dk];
    }
    const hourTok = Object.assign({}, agg.hourTok);
    for (const hk of Object.keys((jr && jr.hours) || {})) hourTok[hk] = (hourTok[hk] || 0) + jr.hours[hk];
    const otherTokens = Object.keys(otherDays).reduce((s, dk) => s + otherDays[dk], 0);

    const sumOver = fromMs => Object.keys(known)
        .filter(dk => dayStart(dk) >= fromMs)
        .reduce((s, dk) => s + known[dk], 0);
    const lifetimeCache = Object.keys(inSum).reduce(
        (s, m) => s + inSum[m] + outSum[m] + crSum[m] + cwSum[m], 0);

    // Состав итога. Claude Code идёт первым и с пометкой охвата: у него он полный (кеш плюс
    // транскрипты), а у журнальных харнессов - только то, что уцелело в журнале.
    const sources = [{
        h: 'claude-code',
        tokens: doc ? lifetimeCache + tailGross : null,
        lowerBound: doc ? null : tailGross,
        coverage: doc ? 'full' : 'lower-bound',
    }];
    if (jr) {
        const list = [...jr.byHarness.values()].sort((a, b) => b.tokens - a.tokens);
        for (const rec of list.slice(0, OTHER_HARNESS_MAX)) {
            sources.push({ h: rec.h, tokens: rec.tokens, coverage: 'journal' });
        }
        const rest = list.slice(OTHER_HARNESS_MAX).reduce((s, r) => s + r.tokens, 0);
        if (rest) sources.push({ h: 'other', tokens: rest, coverage: 'journal' });
    }

    return {
        accountingVersion: ACCOUNTING_VERSION,
        available: true,
        // Причина остаётся и при живых данных: она объясняет, почему total неизвестен.
        reason: doc ? null : (cacheExists ? reason : 'no-cache'),
        lifetimeCC: doc ? lifetimeCache + tailGross : null,
        // Итог для человека: Claude Code плюс всё, что видел журнал по прочим харнессам.
        lifetime: doc ? lifetimeCache + tailGross + otherTokens : null,
        // Без кеша общий итог неизвестен, а сумма по сохранившимся транскриптам плюс журнал -
        // нижняя граница: истории старше первой уцелевшей сессии в ней нет по построению.
        lifetimeLowerBound: doc ? null : tailGross + otherTokens,
        // Хвост, посчитанный транскриптами, полон по определению: там есть все четыре
        // категории. Неполон только итог без кеша - он и помечен как нижняя граница.
        completeLifetime: !!doc,
        otherTokens, otherD7, otherD30, otherDays, sources,
        journal: jr ? {
            reason: jr.reason, lines: jr.lines, truncated: !!jr.truncated,
            first: jr.firstMs === null ? null : dayKey(jr.firstMs),
            last: jr.lastMs === null ? null : dayKey(jr.lastMs),
        } : { reason: 'no-journal', lines: 0, truncated: false, first: null, last: null },
        lifetimeBreakdown: {
            cache: doc ? lifetimeCache : null,
            tail: doc ? tailGross : null,
            input: Object.keys(inSum).reduce((s, m) => s + inSum[m], 0) || null,
            cacheRead: Object.keys(crSum).reduce((s, m) => s + crSum[m], 0) || null,
            cacheWrite: Object.keys(cwSum).reduce((s, m) => s + cwSum[m], 0) || null,
            knownDaysSum: Object.keys(known).reduce((s, dk) => s + known[dk], 0),
        },
        totals: { d7: sumOver(dayStart(today) - 6 * DAY_MS), d30: sumOver(dayStart(today) - 29 * DAY_MS) },
        daily: {
            keys: Object.keys(known).sort(),
            known,
            basis,
            cacheRead: agg.daily.cacheRead,
            cacheWrite: agg.daily.cacheWrite,
            tailCache,
            tailInOut,
            hours: agg.hours,
        },
        activity: {
            activeDays: activityDays.length,
            // Сессии и сообщения берём из кеша: он считает их по человеческим сессиям,
            // выкидывая sidechain и вложенных агентов, и это ровно то число, что видно в
            // `/stats`. Без кеша остаётся счёт по уцелевшим файлам - он помечен как нижний.
            sessions: doc ? asNum(doc.totalSessions) : agg.files,
            messages: doc ? asNum(doc.totalMessages) : agg.messages,
            streak: streaks(activityDays, now),
            lastDate: activityDays.length ? activityDays.slice().sort().slice(-1)[0] : null,
            hours: agg.hours,
        },
        source: {
            cache: doc ? 'stats-cache' : null,
            cacheVersion: doc ? doc.version : null,
            dailyVersion: doc ? (doc.dailyModelTokensVersion === undefined ? null : doc.dailyModelTokensVersion) : null,
            watermark: wm || null,
            firstSession: (doc && doc.firstSessionDate) || null,
            cacheBytes: cacheRaw === undefined ? null : cacheRaw,
        },
        coverage: { unknownDays, truncatedFiles: agg.truncatedFiles, sidechainSessions: agg.sidechainSessions },
        // Скользящее окно суток по часовым корзинам (Claude Code плюс журнал). Часы без
        // записей отсутствуют, а не стоят нулями: ноль означал бы «в этот час работали и
        // потратили ровно ноль».
        hourly: (() => {
            const keys = Object.keys(hourTok).sort();
            const h24 = {};
            const from = hourStart(hourKey(now)) - 23 * HOUR_MS;
            for (const hk of keys) {
                const ms = hourStart(hk);
                if (ms >= from && ms <= now) h24[hk] = hourTok[hk];
            }
            return { keys, h24, from: new Date(from).toISOString(), to: new Date(hourStart(hourKey(now))).toISOString() };
        })(),
        truncatedFiles: agg.truncatedFiles,
    };
}

// Прочитать кеш Claude Code. Возвращает разобранный документ и причину, если он непригоден.
function readCache(f, cachePath) {
    let raw = null, exists = false;
    try { raw = f.readFileSync(cachePath).toString('utf8'); exists = true; } catch (e) { exists = false; }
    let doc = null, reason = null;
    if (!exists) reason = 'no-cache';
    else {
        try { doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); }
        catch (e) { doc = null; reason = 'bad-cache'; }
    }
    if (doc && !CACHE_VERSIONS.has(doc.version)) { doc = null; reason = 'unsupported-cache-version'; }
    return { doc, reason, exists, bytes: exists ? Buffer.byteLength(raw, 'utf8') : null };
}

function computeCcStats(deps) {
    const d = deps || {};
    const f = d.fs || fsDefault;
    const root = resolveRoot(d.root);
    const now = Number.isFinite(d.now) ? d.now : Date.now();
    const files = listTranscripts(f, root + '/projects');
    const contribs = files.map(p => {
        try { return readContribution(d, p, /[\\/]subagents[\\/]/.test(p)); }
        catch (e) { return null; }         // файл исчез между листингом и чтением - не повод падать
    });
    const cache = readCache(f, root + '/stats-cache.json');
    const journal = readJournal(d, d.journalPath || DEFAULT_JOURNAL, d.journalCap);
    return foldStats(contribs, {
        doc: cache.doc, reason: cache.reason, cacheExists: cache.exists,
        now, today: dayKey(now), cacheRaw: cache.bytes, journal,
    });
}

// ── Кеш-слой для живого процесса ─────────────────────────────────────────────────
// Дашборд не имеет права сканировать гигабайты на каждый запрос: снимок живёт в памяти,
// обновляется фоном и переиспользует вклады неизменившихся файлов. Первый проход холодный
// (читает всё), дальше читаются только изменившиеся файлы.
function createStatsCache(deps) {
    const d = deps || {};
    const f = d.fs || fsDefault;
    const root = resolveRoot(d.root);
    const nowOf = typeof d.now === 'function' ? d.now : () => (Number.isFinite(d.now) ? d.now : Date.now());
    const cachePath = root + '/stats-cache.json';
    const projectsDir = root + '/projects';
    const journalPath = d.journalPath || DEFAULT_JOURNAL;

    const entries = new Map();     // путь -> { key, contribution }
    let published = null;
    let inflight = null;
    const st = { refreshes: 0, filesRead: 0, filesReused: 0, lastMs: 0, publishedAt: null, stalePasses: 0 };

    function pass() {
        const t0 = Date.now();
        const seen = new Set();
        let read = 0, reused = 0;
        const contribs = [];
        for (const p of listTranscripts(f, projectsDir)) {
            seen.add(p);
            const isAgent = /[\\/]subagents[\\/]/.test(p);
            let key = null;
            try { const s = f.statSync(p); key = s.size + ':' + s.mtimeMs; } catch (e) { entries.delete(p); continue; }
            const prev = entries.get(p);
            if (prev && prev.key === key) {
                reused++;
                if (prev.contribution) contribs.push(prev.contribution);
                continue;
            }
            let c = null;
            try { c = readContribution(d, p, isAgent); } catch (e) { c = null; }
            read++;
            entries.set(p, { key, contribution: c });
            if (c) contribs.push(c);
        }
        for (const p of [...entries.keys()]) if (!seen.has(p)) entries.delete(p);   // файл исчез

        let cache;
        try { cache = readCache(f, cachePath); }
        catch (e) { cache = { doc: null, reason: 'bad-cache', exists: true, bytes: null }; }

        st.filesRead = read;
        st.filesReused = reused;
        st.lastMs = Date.now() - t0;
        // Журнал front-door перечитываем каждый проход: он растёт с каждым запросом, кеш по
        // mtime тут не работает. Хвост в 14-32 МиБ читается десятки миллисекунд.
        let journal;
        try { journal = readJournal(d, journalPath, d.journalCap); }
        catch (e) { journal = null; }
        return foldStats(contribs, {
            doc: cache.doc, reason: cache.reason, cacheExists: cache.exists,
            now: nowOf(), today: dayKey(nowOf()), cacheRaw: cache.bytes, journal,
        });
    }

    function refresh() {
        if (inflight) return inflight;
        inflight = Promise.resolve()
            .then(() => {
                const next = pass();
                st.refreshes++;
                // Проход, потерявший источник, не публикуется: лучше показать последний
                // хороший снимок с пометкой «несвежий», чем молча уронить total до нижней
                // границы или до нуля.
                const lostLifetime = published && published.lifetimeCC !== null && next.lifetimeCC === null;
                const lostAll = published && published.available && !next.available;
                if (lostLifetime || lostAll) {
                    st.stalePasses++;
                    published = Object.assign({}, published, { stale: true, staleAt: new Date(nowOf()).toISOString() });
                } else {
                    published = Object.assign({}, next, { stale: false, staleAt: null });
                }
                st.publishedAt = new Date(nowOf()).toISOString();
                return published;
            })
            .catch(() => published)          // наружу не бросаем: дашборд не должен падать из-за статистики
            .finally(() => { inflight = null; });
        return inflight;
    }

    return { refresh, snapshot: () => published, stats: () => Object.assign({ publishedAt: st.publishedAt }, st) };
}

// ── Срез для обмена между участниками ────────────────────────────────────────────
// Всё, что уезжает наружу, описано здесь и только здесь: получатель валидирует ровно эти
// поля. Никаких путей, имён файлов, текстов и версии сборки - только числа, даты UTC и
// короткие коды причин. `v` - версия ОПРЕДЕЛЕНИЯ счёта: по ней рейтинг решает, можно ли
// сравнивать двух участников, и её же требует приёмник.
function envelopeFrom(snap, at) {
    // Пустой срез отдаём в ДВУХ случаях: снимка нет вовсе и снимок есть, но он «нет
    // источников». Второй - это машина без кэша Claude Code и без транскриптов: `snapshotFrom`
    // возвращает фигуру без `hourly`, `daily` и `activity` (см. ветку `no-sources`), а
    // разыменование `snap.hourly.h24` ниже валило `leagueSync` целиком - сообщением
    // `Cannot read properties of undefined (reading 'h24')` в логе хаба. Участник при этом
    // молча не отправлял свой срез. Свежая установка 23.09 (друг) - ровно этот случай.
    if (!snap || !snap.hourly || !snap.daily || !snap.totals || !snap.activity) {
        return {
            v: ACCOUNTING_VERSION, available: false,
            reason: (snap && snap.reason) || 'no-snapshot',
            lifetime: null, lifetimeLower: null, complete: false, stale: false, asOf: at || null,
            totals: { h24: null, d7: null, d30: null },
            days: { keys: [], values: [] }, hours: { keys: [], values: [] },
            breakdown: null, activity: null, source: null, unknownDays: 0,
        };
    }
    const dayKeys = snap.daily.keys;
    const hourKeys = Object.keys(snap.hourly.h24).sort();
    const sum = a => a.reduce((x, y) => x + y, 0);
    return {
        v: snap.accountingVersion,
        available: !!snap.available,
        reason: snap.reason || null,
        // Итог для человека - общий (Claude Code плюс журнальные харнессы). `lifetimeCC`
        // остаётся отдельным полем: он нужен для сверки с `/stats`, где виден только Claude Code.
        lifetime: snap.lifetime === undefined ? snap.lifetimeCC : snap.lifetime,
        lifetimeLower: snap.lifetimeLowerBound,
        complete: !!snap.completeLifetime,
        stale: !!snap.stale,
        asOf: at || new Date().toISOString(),
        totals: {
            h24: hourKeys.length ? sum(hourKeys.map(k => snap.hourly.h24[k])) : null,
            d7: snap.totals.d7,
            d30: snap.totals.d30,
        },
        // Состав итога: кто именно его набрал. Без этого «59,7 млрд» невозможно проверить,
        // а расхождение с `/stats` невозможно объяснить.
        sources: (snap.sources || []).map(x => ({
            h: x.h, tokens: x.tokens, lowerBound: x.lowerBound, coverage: x.coverage,
        })),
        otherTokens: snap.otherTokens,
        journal: snap.journal,
        days: { keys: dayKeys.slice(-SERIES_WIRE_MAX), values: dayKeys.slice(-SERIES_WIRE_MAX).map(k => snap.daily.known[k]) },
        hours: { keys: hourKeys, values: hourKeys.map(k => snap.hourly.h24[k]) },
        breakdown: snap.lifetimeBreakdown ? {
            cache: snap.lifetimeBreakdown.cache,
            tail: snap.lifetimeBreakdown.tail,
            days: snap.lifetimeBreakdown.knownDaysSum,
        } : null,
        activity: {
            activeDays: snap.activity.activeDays,
            sessions: snap.activity.sessions,
            messages: snap.activity.messages,
            streakCurrent: snap.activity.streak.current,
            streakLongest: snap.activity.streak.longest,
            lastDate: snap.activity.lastDate,
        },
        source: {
            cacheVersion: snap.source.cacheVersion,
            dailyVersion: snap.source.dailyVersion,
            watermark: snap.source.watermark,
            truncatedFiles: snap.coverage.truncatedFiles,
        },
        unknownDays: snap.coverage.unknownDays,
    };
}

function fsExists(f, p) {
    try { f.statSync(p); return true; } catch (e) { return false; }
}

module.exports = {
    computeCcStats, createStatsCache, envelopeFrom, readTail, resolveRoot, ACCOUNTING_VERSION,
    _internals: { streaks, parseLines, readContribution, foldStats, emptyAgg },
};

