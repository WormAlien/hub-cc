'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonSync: durableWriteJson } = require('./durable-write');

// Тело пробы. `max_tokens` НЕ равен 1 намеренно: gpt-6-astra отвергает крошечный потолок
// вывода («Could not finish the message because max_tokens or model output limit was
// reached») и отвечает 400 — а классификатор читает это как `error`, и кнопка «Проверить
// GPT» падала вместо ответа. Ровно та же грабля, что чинилась полом 16 в конвертере
// (`agentrouter-proxy.js`), но здесь пол конвертера не работает: проба идёт СВОИМ
// запросом прямо на agentrouter.org, минуя конвертер.
//
// 16 выбрано не «на глаз»: это минимальное значение, которое Astra принимает (проверено
// пробой 15.09). Потолок на ответ не влияет — пробе важен только код состояния, а не текст.
//
// Для claude-* пол безвреден: там max_tokens=1 работал, но 16 работает так же.
const AR_QUOTA_BODY = Object.freeze({
    model: 'claude-opus-5',
    max_tokens: 16,
    messages: [{ role: 'user', content: '1' }],
});

// ── Полос две, и они РАЗНЫЕ ──────────────────────────────────────────────────
// agentrouter наливает Claude и GPT одновременно (партии одни и те же), но
// кончаются они по отдельности: 15.09 в 04:52 пул Opus был пуст, а GPT ещё
// отдавался. Поэтому состояние ведётся на полосу, а не на аккаунт.
// Имя модели НЕ угадывается: у AgentRouter это ровно то, что перечислено в
// /v1/models; для gpt это `gpt-6-astra`.
const AR_QUOTA_POOLS = Object.freeze({
    opus: 'claude-opus-5',
    gpt: 'gpt-6-astra',
});
const AR_QUOTA_DEFAULT_POOL = 'opus';

// Полоса по имени модели. `null` = модель беспуловая (deepseek-*, glm-*): она
// пулу не подчинена, и записывать ей состояние квоты нечего.
function arQuotaPoolForModel(id) {
    const s = String(id || '');
    if (/^claude[-_]/i.test(s)) return 'opus';
    if (/^gpt[-_]/i.test(s)) return 'gpt';
    return null;
}

// Тело пробы для полосы. Одна и та же проба на обеих полосах проверяла бы Opus
// дважды и врала про GPT — поэтому модель берётся из таблицы, а не из константы.
function arQuotaBodyFor(pool) {
    const model = AR_QUOTA_POOLS[pool];
    return model ? { ...AR_QUOTA_BODY, model } : { ...AR_QUOTA_BODY };
}

// Файл состояния — плоский словарь по полосам: `{"opus":{…},"gpt":{…}}`.
// 🪤 Формат v1 (одна запись без ключей полос) обязан читаться как запись opus:
// он лежит на диске у всех, кто обновляется, и «после апдейта квота пропала»
// выглядело бы поломкой.
function arQuotaReadPools(raw) {
    let doc = null;
    try { doc = JSON.parse(raw); } catch { return {}; }
    if (!doc || typeof doc !== 'object') return {};
    const out = {};
    for (const p of Object.keys(AR_QUOTA_POOLS)) {
        if (doc[p] && typeof doc[p] === 'object') out[p] = doc[p];
    }
    if (!out.opus && doc.state) out.opus = doc;   // v1 = запись opus
    return out;
}

// ── Расписание партий: список времён в зоне ШЛЮЗА ────────────────────────────
// Не сетка «цикл N часов», и это не вкус: объявление 18.09 дало партии 05:00 и
// 14:00 МСК — промежутки 9 ч и 15 ч, одной константой такое не выражается
// в принципе. Прежняя сетка (8 ч от 16:00 UTC = 03/11/19 МСК) прожила шесть дней.
// Третья смена расписания за девять дней — поэтому расписание читается с диска.
//
// Дублирование арифметики зон в часах дашборда (`proxy-dashboard.html`) намеренное:
// часы — самодостаточный IIFE в разметке, а ручки расписания до рестарта `:8200`
// может не быть вовсе, и без своей копии часы остались бы мёртвыми. Обе реализации
// обязаны совпадать — регресс сверяет их между собой по батарее моментов, а не
// по исходнику (ассерт по исходнику зеленеет на сломанном коде).
const AR_SCHEDULE_FILE = path.join(os.homedir(), '.claude', 'ar-quota-schedule.json');

// Дефолт = объявление 2026-09-18. Времени в зоне шлюза, а не в МСК: объявление
// копируется в настройку дословно, пересчёт показывает панель.
const AR_SCHEDULE_DEFAULT = Object.freeze({
    tz: 'Asia/Shanghai',
    times: Object.freeze(['10:00', '19:00']),
    note: 'объявление 2026-09-18: две партии, Пекин 10:00 и 19:00',
});

// Путь переопределяется переменной окружения — так регресс гоняет расписание на
// временном файле, не трогая живое `~/.claude`.
function arScheduleFile() {
    return process.env.AR_QUOTA_SCHEDULE_FILE || AR_SCHEDULE_FILE;
}

// Зона проверяется тем же Intl, которым потом считается: «валидная на вид» строка,
// которую Intl не принимает, уронила бы тик часов в бою, а не в редакторе.
function arScheduleTzOk(tz) {
    const s = String(tz || '').trim();
    if (!s || s.length > 64) return false;
    try { new Intl.DateTimeFormat('en-CA', { timeZone: s }); return true; } catch { return false; }
}

// «10:00, 19:00» или ['10:00','19:00'] → нормализованный список. Терпимо к разделителям
// и к «9» вместо «09:00», но не к мусору: молча проглоченная опечатка сдвинула бы
// налив на сутки, и заметить это было бы нечем.
function arScheduleParseTimes(raw) {
    const list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[,;\s]+/);
    const out = [];
    for (const item of list) {
        const s = String(item || '').trim();
        if (!s) continue;
        const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(s);
        if (!m) return { ok: false, error: `не время: «${s}»` };
        const hh = Number(m[1]);
        const mi = m[2] === undefined ? 0 : Number(m[2]);
        if (hh > 23 || mi > 59) return { ok: false, error: `не время: «${s}»` };
        const t = `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
        if (!out.includes(t)) out.push(t);
    }
    // Минимум две: на одной партии дуга «от прошлой до следующей» вырождается в
    // полный круг, а SVG дугу с совпавшими концами не рисует вообще — молча.
    if (out.length < 2) return { ok: false, error: 'нужно минимум две партии в сутки' };
    if (out.length > 8) return { ok: false, error: 'больше восьми партий не поддерживается' };
    out.sort();   // «HH:MM» лексикографически = хронологически
    return { ok: true, times: out };
}

// Что бы ни лежало в файле — на выходе либо валидное расписание, либо дефолт с
// причиной. Битый файл не должен ронять ни часы, ни автопроверку: у шлюза это
// третья смена схемы за девять дней, и правит файл человек.
function arScheduleNormalize(doc) {
    // Отсутствие файла — это не ошибка, а поставка. Пустой объект в файле — ошибка:
    // кто-то правил руками и стёр содержимое, и молчать об этом нельзя.
    if (doc === null || doc === undefined) return { ...AR_SCHEDULE_DEFAULT, source: 'default' };
    const d = typeof doc === 'object' ? doc : {};
    const tz = typeof d.tz === 'string' ? d.tz.trim() : '';
    const parsed = arScheduleParseTimes(d.times);
    let error = null;
    if (!parsed.ok) error = parsed.error;
    else if (!arScheduleTzOk(tz)) error = `неизвестная зона: «${tz || '—'}»`;
    if (error) return { ...AR_SCHEDULE_DEFAULT, source: 'default', error };
    return { tz, times: parsed.times, source: 'file',
             note: typeof d.note === 'string' ? d.note.slice(0, 200) : '',
             updated: typeof d.updated === 'string' ? d.updated.slice(0, 40) : '' };
}

// Текущее расписание с кешем по mtime: зовётся на каждом тике автопроверки, а
// stat дешевле чтения с разбором. Правка файла видна сразу, рестарт не нужен.
let AR_SCHED_CACHE = null;
function arQuotaSchedule() {
    const file = arScheduleFile();
    let st = null;
    try { st = fs.statSync(file); } catch { /* файла нет — работаем дефолтом */ }
    const mtimeMs = st ? st.mtimeMs : -1;
    if (AR_SCHED_CACHE && AR_SCHED_CACHE.file === file && AR_SCHED_CACHE.mtimeMs === mtimeMs) {
        return AR_SCHED_CACHE.doc;
    }
    let doc;
    if (!st) {
        doc = arScheduleNormalize(null);
    } else {
        try {
            doc = arScheduleNormalize(JSON.parse(fs.readFileSync(file, 'utf8')));
        } catch (e) {
            doc = { ...arScheduleNormalize(null), error: `файл расписания не прочитан: ${e.message}` };
        }
    }
    AR_SCHED_CACHE = { file, mtimeMs, doc };
    return doc;
}

// ── Зона ↔ UTC ───────────────────────────────────────────────────────────────
// Форматтер кешируется: он дорогой, а зовётся на каждом тике и на каждой пробе.
// Зону задаёт человек, поэтому кеш ограничен — иначе опечатка в поле раздувала бы
// память живого процесса.
const AR_TZ_FMT = new Map();
function arZonedParts(ts, tz) {
    let f = AR_TZ_FMT.get(tz);
    if (!f) {
        if (AR_TZ_FMT.size >= 32) AR_TZ_FMT.clear();
        f = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
        AR_TZ_FMT.set(tz, f);
    }
    const g = {};
    for (const p of f.formatToParts(new Date(ts))) g[p.type] = p.value;
    // 🪤 Полночь Intl отдаёт как «24» при hour12:false, и Date.UTC(…, 24, …) уезжает
    // на сутки вперёд. Модуль обязателен и регрессируется отдельной сценой.
    return { y: Number(g.year), mo: Number(g.month), d: Number(g.day),
             h: Number(g.hour) % 24, mi: Number(g.minute), s: Number(g.second) };
}

// Смещение зоны в миллисекундах на момент ts.
function arZonedOffsetMs(ts, tz) {
    const p = arZonedParts(ts, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

// Стенные HH:MM зоны tz → момент UTC. Два прохода: смещение зависит от момента, а
// момент — от смещения. Второго хватает и на границе перехода: там поправка меняется
// на час, и первый проход уже выводит на нужную сторону от неё.
function arZonedToUtc(y, mo, d, hh, mi, tz) {
    const guess = Date.UTC(y, mo - 1, d, hh, mi);
    const ts1 = guess - arZonedOffsetMs(guess, tz);
    return guess - arZonedOffsetMs(ts1, tz);
}

// Партии вокруг момента: `last` — последняя не позже ts, `next` — первая после.
// Кандидаты берутся за трое суток по стенным часам зоны, поэтому обе точки есть
// всегда, в том числе сразу после смены расписания и в день перехода на летнее время.
function arQuotaBatches(now, sched) {
    const t = Number(now);
    const s = sched || arQuotaSchedule();
    if (!Number.isFinite(t) || !s || !Array.isArray(s.times) || !s.times.length) return null;
    const p = arZonedParts(t, s.tz);
    const cand = [];
    for (const off of [-1, 0, 1]) {
        const b = new Date(Date.UTC(p.y, p.mo - 1, p.d + off));
        for (const hhmm of s.times) {
            const [hh, mi] = hhmm.split(':').map(Number);
            cand.push(arZonedToUtc(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate(), hh, mi, s.tz));
        }
    }
    cand.sort((a, b) => a - b);
    let last = null, next = null;
    for (const c of cand) { if (c <= t) last = c; else if (next === null) next = c; }
    // `all` отдаём наружу: клиенту по нему рисуются метки суточного круга, а пробе —
    // локальные времена партий. Своей копии списка ни у кого нет, и разойтись нечему.
    return { last, next, all: cand, tz: s.tz, times: s.times };
}

// Последняя партия НЕ ПОЗЖЕ ts. Ответ шлюза относится именно к ней: пока не
// случился следующий налив, состояние квоты не могло измениться само.
// ⚠️ Смена расписания обесценивает весь кеш разом: в записях лежит `dropAt` прежней
// сетки, а `isArQuotaCacheFresh` сверяет его с текущей. Так и надо — одна лишняя
// проба после смены честнее, чем «квота закончилась» с прошлой схемы.
function arQuotaDropAt(ts, sched) {
    const b = arQuotaBatches(ts, sched);
    return b ? b.last : null;
}

// Хвост ключа: заметить смену аккаунта достаточно, а секретом не является.
// Целый sk-… в кеш не попадает НИКОГДА — иначе ключ уехал бы в localStorage,
// чего вся схема quota-check избегает специально (сервер его не отдаёт клиенту).
function arQuotaKeyTail(key) {
    const s = String(key || '');
    return s.length > 4 ? s.slice(-4) : s;
}

// Запись кеша из результата пробы. `error` не кешируется вообще: это факт про
// сеть в тот момент, а не про квоту, и показывать его завтра бессмысленно.
function buildArQuotaCache(result, key, now) {
    const state = result && result.state;
    if (state !== 'available' && state !== 'exhausted') return null;
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return {
        state,
        checkedAt: new Date(ts).toISOString(),
        dropAt: new Date(arQuotaDropAt(ts)).toISOString(),
        keyTail: arQuotaKeyTail(key),
    };
}

// Годна ли запись СЕЙЧАС. Инвалидация по партии, а не по TTL: пока идёт та же
// партия — ответ актуален сколько угодно долго; как только случился налив, запись
// мертва (показывать «квота закончилась» после нового налива хуже, чем молчать).
// Смена активного ключа тоже убивает запись: состояние привязано к аккаунту.
function isArQuotaCacheFresh(entry, now, keyTail) {
    if (!entry || (entry.state !== 'available' && entry.state !== 'exhausted')) return false;
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const checked = Date.parse(entry.checkedAt);
    if (!Number.isFinite(checked) || checked > ts + 60_000) return false;   // запись из будущего — часы уехали
    const drop = Date.parse(entry.dropAt);
    if (!Number.isFinite(drop) || drop !== arQuotaDropAt(ts)) return false;
    if (keyTail && entry.keyTail && entry.keyTail !== keyTail) return false;
    return true;
}

// Кто свежее: сравнение по checkedAt, а НЕ по слою. Иначе браузер с устаревшей
// записью затирал бы свежую серверную — и наоборот сразу после рестарта :8200.
function pickFresherArQuota(a, b) {
    const ta = a && Date.parse(a.checkedAt), tb = b && Date.parse(b.checkedAt);
    if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : null;
    if (!Number.isFinite(tb)) return a;
    return tb > ta ? b : a;
}

function classifyArQuotaProbe(status, rawBody) {
    const code = Number(status) || 0;
    if (code >= 200 && code < 300) return { state: 'available' };
    const text = String(rawBody || '');
    if (code === 402 && /Budget pool quota has been exhausted/i.test(text)) {
        return { state: 'exhausted' };
    }
    let message = text.slice(0, 300) || `HTTP ${code || 0}`;
    try {
        const parsed = JSON.parse(text);
        message = parsed?.error?.message || parsed?.error || parsed?.message || message;
    } catch {}
    return { state: 'error', error: String(message) };
}

// Запись расписания. Пишем только валидное и только durable: tmp + fsync + rename,
// потому что BSOD оставляет обычную запись файлом нулями (инцидент 13.09). Кеш
// сбрасывается руками, а не по mtime: на грубом разрешении mtime правка в ту же
// секунду осталась бы незамеченной, и панель показала бы старое расписание.
function arQuotaScheduleSave(patch) {
    const d = patch && typeof patch === 'object' ? patch : {};
    const tz = String(d.tz == null ? '' : d.tz).trim();
    const parsed = arScheduleParseTimes(d.times);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (!arScheduleTzOk(tz)) return { ok: false, error: `неизвестная зона: «${tz}»` };
    const doc = {
        tz,
        times: parsed.times,
        updated: new Date().toISOString().slice(0, 10),
        note: typeof d.note === 'string' ? d.note.slice(0, 200) : '',
    };
    const file = arScheduleFile();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        durableWriteJson(file, doc);
    } catch (e) {
        return { ok: false, error: `не записано: ${e.message}` };
    }
    AR_SCHED_CACHE = null;
    return { ok: true, schedule: arQuotaSchedule() };
}

module.exports = {
    AR_QUOTA_BODY,
    AR_QUOTA_POOLS,
    AR_QUOTA_DEFAULT_POOL,
    arQuotaPoolForModel,
    arQuotaBodyFor,
    arQuotaReadPools,
    AR_SCHEDULE_DEFAULT,
    arScheduleFile,
    arScheduleTzOk,
    arScheduleParseTimes,
    arQuotaSchedule,
    arQuotaScheduleSave,
    arQuotaBatches,
    arZonedParts,
    arZonedToUtc,
    classifyArQuotaProbe,
    arQuotaDropAt,
    arQuotaKeyTail,
    buildArQuotaCache,
    isArQuotaCacheFresh,
    pickFresherArQuota,
};
