// health-agg.js — агрегатор журнала `token-usage.jsonl` по парам «шлюз|модель».
//
// Зачем: витрине здоровья шлюзов нужны сравнимые между собой цифры скорости и
// объёма. Журнал для этого пригоден не целиком, и почти каждое поле в нём имеет
// оговорку — они собраны здесь, чтобы потребитель не переоткрывал их заново.
//
// 🪤 ЧТО В ЖУРНАЛЕ НЕЛЬЗЯ СЧИТАТЬ (проверено по коду `usage-tap.js`):
//
//   1. `ms` — НЕ время ответа. Секундомер стартует, когда пришли ЗАГОЛОВКИ:
//      `createTap` вызывается внутри колбэка `requester(...)` в
//      `frontdoor-proxy.js:480`, а `state.started = Date.now()` стоит в
//      `usage-tap.js:342`. При `st=1` (SSE) заголовки уходят сразу, тело течёт
//      следом — `ms` ≈ время генерации, и это честная скорость.
//      При `st=0` та же цифра означает РАЗНОЕ у разных шлюзов, и это хуже, чем
//      просто «другая шкала». Замер 10.09 по окну 15 суток, 367 строк с `st=0`:
//        • 261 строка имеет `ms` меньше секунды (медиана РОВНО 0) при `out` в
//          500–1000 токенов. Тысяча токенов за ноль миллисекунд — это не скорость,
//          а пересылка уже готового тела: шлюз держал заголовки до конца генерации;
//        • ~90 строк (почти все — agentrouter) имеют `ms` 30–50 с: этот шлюз
//          флашит заголовки ДО генерации, и там `ms` генерацию как раз включает.
//      То есть `st=0` — это СМЕСЬ ДВУХ НЕСОВМЕСТИМЫХ ВЕЛИЧИН в одном поле, и
//      отсечкой сверху она не лечится: делить `out` на ноль бессмысленно в любом
//      случае. Поэтому ЛЮБАЯ метрика скорости считается ТОЛЬКО по `st === 1`;
//      `st=0` участвует лишь в счётчиках объёма (`ok_responses`, `cache_pct`,
//      `stream_pct`). Цена вопроса измерена: наивный расчёт по всем строкам даёт
//      200 значений Infinity ток/с, среднее 1 464 и максимум 4 795 000 ток/с
//      против медианы 52.9 и максимума 500 после фильтра.
//      🪤 Проверять это надо СРЕДНИМ И МАКСИМУМОМ, а не медианой: `st=0` здесь
//      0.8% строк, и медиана «без фильтра» (53.4) почти совпадает с медианой
//      «с фильтром» (52.9). Медиана мусор прячет — она и выбрана как сводная
//      именно поэтому, но доказательством работы фильтра служить не может.
//
//   2. Провалов в файле НЕТ. `usage-tap.js:337` — `if (!meta.status ||
//      meta.status >= 300) return null`, плюс `:363` — успех без блока `usage`
//      не пишется. Значит доля успеха/ошибок отсюда НЕВЫВОДИМА: знаменатель
//      (все попытки) в файл не попадает. Не считать и не показывать.
//
//   3. `usage-tap.js:339` — `if (h['content-encoding']) return null`. Шлюз,
//      который жмёт ответы, невидим ЦЕЛИКОМ, а не частично. Ноль записей у шлюза
//      — это не обязательно простой; предупреждение об этом уезжает в `warnings`.
//
//   4. Оборванные ответы ПИШУТСЯ: тап отдаёт запись в `end()`, а `end` наступает
//      и на разрыве. У такой записи `ms` и `out` обрезаны, и от полной она ничем
//      не отличается. Это шум в сторону «медленно/мало» — он размазывается
//      медианой, но не устраняется, и это причина брать медиану, а не среднее.
//
//   5. `cost` занижен ×9.16 (базовый прайс New API без группового множителя).
//      Поле не читается вообще — ни здесь, ни у потребителей этого модуля.
//
// Формулы (заданы контрактом, менять только вместе с потребителями):
//   • скорость строки = `out / (ms/1000)` при `st===1 && out >= 50`; значения
//     > 500 ток/с — артефакт (обрезанный `ms` при полном `out`), они выбрасываются
//     и считаются отдельно в `tokps_dropped`;
//   • сводная скорость = МЕДИАНА ПО СТРОКАМ, а не `Σout/Σms`. Отношение сумм —
//     это средневзвешенное по длине ответа, и один самый длинный ответ утаскивает
//     всю цифру за собой;
//   • `tokps_median_opus5` на шлюзе считается только по `claude-opus-5`. Общий p50
//     по смеси моделей между шлюзами НЕ сравним: у шлюзов разный состав моделей,
//     а thinking-модели генерируют в другом темпе;
//   • кэш = `cr / (cr + cw + in)`;
//   • меньше 50 строк — метрика `null`, потребитель рисует «мало данных».
'use strict';

const fs = require('fs');
const path = require('path');

const LOG_FILE = process.env.TOKEN_USAGE_FILE || path.join(__dirname, 'token-usage.jsonl');
const ARCHIVE_DIR = path.join(path.dirname(LOG_FILE), 'archive');

// Имя архива — РОВНО `token-usage-<ГГГГ-ММ-ДД>.jsonl` (их пишет `rotateJournal`,
// `usage-tap.js:261`). Регексп строгий не из аккуратности: рядом в той же папке
// лежит `token-usage-snapshot-2026-09-05.jsonl` — это КОПИЯ живого журнала, а не
// вырезанные из него сутки. Замер 10.09: 36 270 из её 36 270 строк присутствуют в
// живом журнале (первая строка совпадает побайтово), то есть шаблон `token-usage-*`
// удвоил бы 70% всех данных. Всё, что похоже на журнал, но не подходит под
// регексп, пропускается и перечисляется в `warnings`.
const ARCHIVE_RE = /^token-usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const ARCHIVE_LIKE_RE = /^token-usage.*\.jsonl$/;

const MIN_N = 50;          // порог, ниже которого метрика — null
const TOKPS_CAP = 500;     // ток/с, выше — артефакт обрезанного `ms`
const TOKPS_MIN_OUT = 50;  // короткий ответ меряет не скорость, а накладные
const TAIL_MS = 60 * 1000; // «долгий ответ» для tail_60s_pct
const OPUS5 = 'claude-opus-5';

// ── Чтение append-only журнала ХВОСТОМ ───────────────────────────────────────
// Копия механизма из `transparent-proxy.js:8847` (`tailRead`) и `:8882`
// (`tailLines`) — КОПИЯ НАМЕРЕННО, а не `require`: тот файл на 21 000 строк, тянуть
// его сюда ради двух функций значит завести зависимость от всего дашборда.
// Наивный кеш по одному `mtimeMs` тут бесполезен: `token-usage.jsonl` пишется на
// каждый запрос через front-door, значит промах на каждом обращении и перечитывание
// 8 МБ — замерено 130…190 мс на пустом месте. Журнал дописывается в конец, поэтому
// помним смещение и читаем только новое.

// Сколько байт хвоста можно декодировать. Обрыв посреди многобайтового символа
// подставляет U+FFFD и ломает JSON именно той строки. Незаконченные байты не
// декодируем и смещение на них НЕ двигаем — доедут следующим чтением целиком.
function utf8Cut(buf) {
  for (let i = buf.length - 1, back = 0; i >= 0 && back < 3; i--, back++) {
    const b = buf[i];
    if ((b & 0xC0) === 0x80) continue;                   // байт продолжения — идём назад
    const need = (b & 0xE0) === 0xC0 ? 2 : (b & 0xF0) === 0xE0 ? 3
      : (b & 0xF8) === 0xF0 ? 4 : 1;
    return need > buf.length - i ? i : buf.length;
  }
  return buf.length;
}

// Признаков свежести три, а не один (см. разбор в transparent-proxy.js):
//   1. `ino` — ловит подмену файла через `tmp+rename`;
//   2. дописывание СТРОГО увеличивает размер: равный размер при другом `mtime`
//      или `ino` — это перезапись, читаем целиком;
//   3. якорь — 128 байт перед запомненным офсетом, перечитанные с диска.
// Якорь держим сырыми байтами (`latin1`): он сверяется побайтово и не должен
// зависеть от декодирования UTF-8.
const TAIL_ANCHOR = 128;

function anchorAt(fd, pos, len) {
  if (len <= 0) return '';
  const b = Buffer.allocUnsafe(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return b.subarray(0, n).toString('latin1');
}

function tailRead(file, st8) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (st.mtimeMs === st8.mtime && st.size === st8.size && st.ino === st8.ino)
    return { text: '', reset: false, st };
  let grew = st8.size > 0 && st.size > st8.size && st.ino === st8.ino;
  let from = grew ? st8.size : 0;
  let text = '', got = 0, fresh = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      // Сверка якоря — ДО чтения хвоста: не совпал, значит хвоста нет и читать
      // надо файл целиком с нуля.
      if (grew) {
        const back = Math.min(TAIL_ANCHOR, from);
        if (anchorAt(fd, from - back, back) !== st8.tail) { grew = false; from = 0; }
      }
      const len = st.size - from;
      if (len > 0) {
        const buf = Buffer.allocUnsafe(len);
        const n = fs.readSync(fd, buf, 0, len, from);
        got = utf8Cut(buf.subarray(0, n));
        text = buf.subarray(0, got).toString('utf8');
        fresh = buf.subarray(0, got).toString('latin1');
      }
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  // Новый якорь собирается из прежнего и прочитанных байтов — второго чтения
  // диска для этого не нужно.
  st8.tail = ((grew ? st8.tail : '') + fresh).slice(-TAIL_ANCHOR);
  st8.mtime = st.mtimeMs; st8.size = from + got; st8.ino = st.ino;
  return { text, reset: !grew, st };
}

// Последняя строка без `\n` — недописанная, возвращается в `rest` и уйдёт в
// начало следующего чтения.
function tailLines(state, text, reset) {
  if (reset) state.rest = '';
  const all = state.rest + text;
  const parts = all.split('\n');
  state.rest = parts.pop();
  return parts;
}

// ── Разбор записей ───────────────────────────────────────────────────────────
// Держим РАЗОБРАННЫМИ в памяти: агрегировать по произвольному окну — это проход
// по массиву, а не чтение файла. Поля короткие: 50 тыс. записей ≈ 8 МБ heap.
// `cost` не читается сознательно (см. 🪤 п.5).
const num = v => (Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : 0);
const norm = v => String(v == null ? '' : v).trim().toLowerCase();

function parseRec(ln) {
  let e;
  try { e = JSON.parse(ln); } catch { return null; }
  if (!e || typeof e !== 'object') return null;
  const t = Date.parse(e.t);
  if (!Number.isFinite(t)) return null;
  return {
    t,
    bk: norm(e.bk),
    // `am` (реальная модель) важнее `m` (имя, которое видел клиент): на шлюзе с
    // тир-картой запрос исполняет цель карты, а в ответе стоит клиентское имя —
    // MODEL_ECHO в keepalive. Без этого «Здоровье» показывало у justwoker строку
    // `claude-opus-5`, хотя Opus там нет вовсе, а работает `gpt-5.6-sol`.
    // Старые записи поля `am` не имеют и остаются на `m` — задним числом их не чиним.
    m: norm(e.am || e.m),
    s: e.st === 1 ? 1 : 0,
    d: num(e.ms),
    o: num(e.out),
    i: num(e.in),
    cr: num(e.cr),
    cw: num(e.cw),
  };
}

// Живой журнал: инкрементальное состояние хвоста.
const LIVE = { mtime: 0, size: 0, ino: 0, tail: '', rest: '', list: [], bad: 0 };

function liveEntries() {
  const r = tailRead(LOG_FILE, LIVE);
  if (!r) return LIVE;                       // файла нет — отдаём, что накоплено
  if (r.reset) { LIVE.list = []; LIVE.bad = 0; }
  for (const ln of tailLines(LIVE, r.text, r.reset)) {
    if (!ln) continue;
    const rec = parseRec(ln);
    if (!rec) { LIVE.bad++; continue; }
    LIVE.list.push(rec);
  }
  return LIVE;
}

// Архивы: сутки уже закрыты и не меняются, поэтому читаются ЦЕЛИКОМ ровно один
// раз и кешируются по `mtime+size+ino` каждый по отдельности. Пропавший файл
// выбрасывается из кеша, новый дочитывается — остальные не трогаются.
const ARCH = { files: new Map(), skipped: new Set(), bad: 0, list: null };

function archiveEntries() {
  let names;
  try { names = fs.readdirSync(ARCHIVE_DIR); } catch { ARCH.list = ARCH.list || []; return ARCH; }
  const seen = new Set();
  let dirty = ARCH.list === null;
  for (const name of names.slice().sort()) {
    if (!ARCHIVE_RE.test(name)) {
      if (ARCHIVE_LIKE_RE.test(name) && !ARCH.skipped.has(name)) ARCH.skipped.add(name);
      continue;
    }
    const file = path.join(ARCHIVE_DIR, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    seen.add(name);
    const prev = ARCH.files.get(name);
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.ino === st.ino) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const list = [];
    let bad = 0;
    for (const ln of text.split('\n')) {
      if (!ln) continue;
      const rec = parseRec(ln);
      if (!rec) { bad++; continue; }
      list.push(rec);
    }
    ARCH.files.set(name, { mtime: st.mtimeMs, size: st.size, ino: st.ino, list, bad });
    dirty = true;
  }
  for (const name of [...ARCH.files.keys()]) {
    if (!seen.has(name)) { ARCH.files.delete(name); dirty = true; }
  }
  if (dirty) {
    const all = [];
    let bad = 0;
    for (const name of [...ARCH.files.keys()].sort()) {
      const f = ARCH.files.get(name);
      bad += f.bad;
      for (const rec of f.list) all.push(rec);
    }
    ARCH.list = all;
    ARCH.bad = bad;
  }
  return ARCH;
}

// ── Статистика ───────────────────────────────────────────────────────────────
const r1 = x => Math.round(x * 10) / 10;

// Медиана по отсортированному массиву: при чётной длине — среднее двух средних.
function medianSorted(arr) {
  const n = arr.length;
  if (!n) return null;
  const h = n >> 1;
  return n % 2 ? arr[h] : (arr[h - 1] + arr[h]) / 2;
}

// Перцентиль ближайшего ранга (nearest-rank): p90 при n=10 — десятое значение.
function pctSorted(arr, p) {
  const n = arr.length;
  if (!n) return null;
  return arr[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
}

function newPair(bk, m) {
  return {
    key: `${bk}|${m}`, bk, m,
    ok_responses: 0,
    tokps_median: null, tokps_n: 0, tokps_dropped: 0,
    tail_60s_pct: null, stream_pct: 0, cache_pct: null,
    ms_p50: null, ms_p90: null,
    last_seen: null, first_seen: null,
    _tokps: [], _ms: [], _stream: 0, _tail: 0,
    _cr: 0, _cw: 0, _in: 0, _tMin: Infinity, _tMax: -Infinity,
  };
}

// Разбивку кэша отдают не все шлюзы — а формула контракта в этом случае честно
// даёт cache_pct = 0, что читается как «кэш не работает». Замер 10.09 по всему
// журналу: justwoker, kktoken, gorouter, tabi и custom пишут cr=0 И cw=0 при
// миллиардах во `in` (то есть чтение кэша свёрнуто во вход), cr появляется только
// у agentrouter, aipm и hcnsec. Отличаем одно от другого счётчиками на шлюзе и
// говорим об этом в warnings.

function feed(p, rec) {
  p.ok_responses++;
  if (rec.t < p._tMin) p._tMin = rec.t;
  if (rec.t > p._tMax) p._tMax = rec.t;
  p._cr += rec.cr; p._cw += rec.cw; p._in += rec.i;
  if (!rec.s) return;                            // дальше — только стрим (🪤 п.1)
  p._stream++;
  if (rec.d > 0) {
    p._ms.push(rec.d);
    if (rec.d > TAIL_MS) p._tail++;
  }
  if (rec.o >= TOKPS_MIN_OUT && rec.d > 0) {
    const v = rec.o / (rec.d / 1000);
    if (v > TOKPS_CAP) p.tokps_dropped++;         // обрезанный `ms` (🪤 п.4)
    else p._tokps.push(v);
  }
}

function seal(p) {
  p._tokps.sort((a, b) => a - b);
  p._ms.sort((a, b) => a - b);
  p.tokps_n = p._tokps.length;
  p.tokps_median = p.tokps_n >= MIN_N ? r1(medianSorted(p._tokps)) : null;
  // Знаменатель у tail/ms — только стримовые строки: `ms` у `st=0` меряет не то.
  const sn = p._ms.length;
  p.tail_60s_pct = sn >= MIN_N ? r1((p._tail / sn) * 100) : null;
  p.ms_p50 = sn >= MIN_N ? Math.round(medianSorted(p._ms)) : null;
  p.ms_p90 = sn >= MIN_N ? Math.round(pctSorted(p._ms, 0.9)) : null;
  p.stream_pct = p.ok_responses ? r1((p._stream / p.ok_responses) * 100) : 0;
  const den = p._cr + p._cw + p._in;
  // Ноль cr И cw у шлюзов, сворачивающих кэш во входные токены, означает
  // «разбивки нет», а не «кэш не использовался». Не рисуем ложные 0,0%.
  p.cache_pct = (p._cr === 0 && p._cw === 0) ? null
    : (den > 0 ? r1((p._cr / den) * 100) : null);
  p.first_seen = p._tMin === Infinity ? null : new Date(p._tMin).toISOString();
  p.last_seen = p._tMax === -Infinity ? null : new Date(p._tMax).toISOString();
  delete p._tokps; delete p._ms; delete p._stream; delete p._tail;
  delete p._cr; delete p._cw; delete p._in; delete p._tMin; delete p._tMax;
  return p;
}

/**
 * Срез журнала за окно, разложенный по парам «шлюз|модель».
 * @param {{windowSec?: number}} [opts] — ширина окна назад от «сейчас», сек.
 * @returns {{window: object, pairs: object[], gateways: object[], warnings: string[]}}
 */
function aggregate({ windowSec = 15 * 86400 } = {}) {
  const now = Date.now();
  const span = Math.max(1, Number(windowSec) || 15 * 86400) * 1000;
  const from = now - span;

  const live = liveEntries();
  const arch = archiveEntries();
  const warnings = [];

  // Граница живого журнала: архив по определению содержит только ВЫРЕЗАННЫЕ,
  // то есть более старые сутки. Запись архива, попадающая в диапазон живого
  // файла, — это перекрытие (снимок вместо вырезки), и она отбрасывается: иначе
  // тот же ответ посчитается дважды.
  let liveMin = Infinity;
  for (const r of live.list) if (r.t < liveMin) liveMin = r.t;

  const pairs = new Map();
  const gws = new Map();
  const seenBkAll = new Set();
  let overlap = 0;

  const take = rec => {
    seenBkAll.add(rec.bk);
    if (rec.t < from || rec.t > now) return;
    const key = `${rec.bk}|${rec.m}`;
    let p = pairs.get(key);
    if (!p) { p = newPair(rec.bk, rec.m); pairs.set(key, p); }
    feed(p, rec);
    let g = gws.get(rec.bk);
    if (!g) { g = { bk: rec.bk, ok_responses: 0, models: 0, last_seen: null, tokps_median_opus5: null, _models: new Set(), _tMax: -Infinity, _tokps: [], _cache: 0, _in: 0 }; gws.set(rec.bk, g); }
    g.ok_responses++;
    g._models.add(rec.m);
    g._cache += rec.cr + rec.cw;
    g._in += rec.i;
    if (rec.t > g._tMax) g._tMax = rec.t;
    // Скорость шлюза — ТОЛЬКО по opus-5 и только по стриму: смесь моделей между
    // шлюзами не сравнима (🪤 в шапке, формулы).
    if (rec.m === OPUS5 && rec.s && rec.o >= TOKPS_MIN_OUT && rec.d > 0) {
      const v = rec.o / (rec.d / 1000);
      if (v <= TOKPS_CAP) g._tokps.push(v);
    }
  };

  for (const rec of arch.list || []) {
    if (Number.isFinite(liveMin) && rec.t >= liveMin) { overlap++; continue; }
    take(rec);
  }
  for (const rec of live.list) take(rec);

  const pairList = [...pairs.values()].map(seal)
    .sort((a, b) => b.ok_responses - a.ok_responses || a.key.localeCompare(b.key));

  const noCache = [];

  const gwList = [...gws.values()].map(g => {
    g._tokps.sort((a, b) => a - b);
    g.models = g._models.size;
    g.last_seen = g._tMax === -Infinity ? null : new Date(g._tMax).toISOString();
    g.tokps_median_opus5 = g._tokps.length >= MIN_N ? r1(medianSorted(g._tokps)) : null;
    if (g._cache === 0 && g._in > 0) noCache.push(g.bk);
    delete g._models; delete g._tMax; delete g._tokps; delete g._cache; delete g._in;
    return g;
  }).sort((a, b) => b.ok_responses - a.ok_responses || a.bk.localeCompare(b.bk));

  // ── Предупреждения ─────────────────────────────────────────────────────────
  warnings.push('Провалов в журнале нет: usage-tap.js:337 не пишет ответы со статусом >= 300, ' +
    ':363 — успехи без блока usage. Доля успеха по этим данным НЕВЫВОДИМА.');
  warnings.push('Скорость и ms_* посчитаны только по st===1: при st=0 поле ms — смесь двух величин ' +
    '(у 261 из 367 строк оно меньше секунды при 500-1000 выходных токенов, у ~90 — 30-50 с). ' +
    'Наивный расчёт по всем строкам даёт Infinity и максимум 4 795 000 ток/с (замер 10.09).');
  warnings.push('Поле cost не читается: занижено ×9.16 (базовый прайс New API без группового множителя).');
  warnings.push('Оборванные ответы пишутся с обрезанными ms и out и от полных неотличимы — ' +
    'поэтому медиана по строкам, а не среднее и не Σout/Σms.');

  const silent = [...seenBkAll].filter(bk => !gws.has(bk)).sort();
  if (silent.length) {
    warnings.push(`Шлюзы с нулём записей в окне: ${silent.join(', ')}. Это не обязательно простой: ` +
      'usage-tap.js:339 не разбирает ответы с content-encoding, и шлюз, который жмёт ответы, ' +
      'невидим целиком.');
  }
  if (!gwList.length) {
    warnings.push('В окне нет ни одной записи. Если шлюзы при этом работают — проверьте ' +
      'content-encoding у их ответов (usage-tap.js:339).');
  }

  if (noCache.length) {
    warnings.push(`cache_pct = 0 у шлюзов ${noCache.sort().join(', ')} означает «разбивки нет», ` +
      'а не «кэш не работает»: они пишут cr=0 и cw=0, свернув чтение кэша во входные токены. ' +
      'Настоящий процент кэша по ним из журнала не восстановить.');
  }

  const bad = live.bad + arch.bad;
  if (bad) warnings.push(`Битых строк пропущено: ${bad}.`);
  if (overlap) {
    warnings.push(`Записей архива отброшено как перекрытие живого журнала: ${overlap}. ` +
      'Архив должен содержать только вырезанные сутки; пересечение = снимок вместо вырезки.');
  }
  if (ARCH.skipped.size) {
    warnings.push(`Файлы в archive/ пропущены (имя не token-usage-<ГГГГ-ММ-ДД>.jsonl): ` +
      `${[...ARCH.skipped].sort().join(', ')}.`);
  }
  for (const p of pairList) {
    if (p.tokps_median === null && p.ok_responses >= MIN_N) {
      warnings.push(`${p.key}: ok_responses=${p.ok_responses}, но строк для скорости только ` +
        `${p.tokps_n} (нужно ${MIN_N}) — метрики скорости null.`);
    }
  }

  return {
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days: Math.round(span / 86400000) },
    pairs: pairList,
    gateways: gwList,
    warnings,
  };
}

module.exports = { aggregate };
