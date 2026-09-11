/*
 * health-reliability.js — отказы и обрывы по денежным шлюзам из кольца событий keepalive.
 *
 * Источник ровно один: минутные бакеты `routing/keepalive-events-<порт>.json`, которые
 * пишет keepalive-прокси, а формат и окно держит event-store.js. Здесь только
 * классификация и арифметика — файлы читаются через его API (`readStore`/`summarize`).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 Знаменатель — `req` ИЗ ЭТОГО ЖЕ КОЛЬЦА, и никогда из token-usage.jsonl.
 *
 * Это не вкусовщина, а границы популяции. События считает keepalive-прокси (по одному
 * процессу на шлюз, свой файл на порт), а `token-usage.jsonl` пишет front-door — он
 * видит другие запросы, другой отрезок времени и другую единицу учёта (там строка на
 * ответ модели, здесь минутный счётчик). Поделив одно на другое, получаешь проценты,
 * ошибочные в разы: у шлюза может быть 800 событий `req` при 24 000 строк журнала —
 * «доля отказов» съедет в 30 раз и будет выглядеть правдоподобно. Поэтому любое
 * отношение внутри этого модуля берёт числитель и знаменатель из одного бакета.
 *
 * 🔴 Окно здесь 48 часов (`event-store.BUCKETS` = 2880 минут), а не сутки.
 *
 * Агрегатор журнала живёт на 15 днях, и смешивать окна нельзя: `window_sec` отдаётся
 * наружу именно для того, чтобы потребитель подписал цифру честным периодом.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Классификация — тут легко перевернуть знак.
 *
 * ОТКАЗ шлюза = err + abort + stall + truncated. `truncated` (поток кончился без
 * `message_stop`) обязателен: это самый паскудный отказ — байты пересланы честно, код
 * 200, а ответ неполный, и клиент печатает `Connection closed mid-response`.
 *
 * НЕ отказ:
 *  🪤 `clientgone` — владелец нажал Ctrl-C. Записать это шлюзу — значит наказать его за
 *     чужое решение; на живых файлах clientgone доходит до 221 события (:20163), то есть
 *     ошибка была бы не косметической.
 *  🪤 `hold` / `empty` / `jsonhold` / `precommit` — СРАБОТАВШАЯ ЗАЩИТА, спасённые запросы.
 *     Считать их отказами — перевернуть знак: хорошо защищённый шлюз выглядел бы хуже
 *     незащищённого (у :20133 одних `precommit` 1781 против 223 настоящих отказов).
 *     Отдаём отдельным числом `saved` как нейтрально-положительное.
 *  `route` (подмена мёртвой модели на живую) и `rotate` (ротация аккаунта) — тоже защиты,
 *  идут отдельными числами. `boot` — рестарт процесса, объясняет дыры на шкале.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Ноль и null различаются. Ноль = «померили, не было». null = «не мерили»: файла нет,
 * он битый, или в окне не оказалось ни одного бакета. Границы всей истории
 * (`oldest_at`/`newest_at`) отдаются даже при `no_data`, иначе «данных нет» не отличить
 * от «данные есть, но старше окна» — на :20161 сейчас ровно второй случай.
 */

'use strict';

const path = require('path');
const evs = require('./event-store');

// ── Карта шлюз → порт keepalive ───────────────────────────────────────────────
//
// Ключ — тег из реестра MONEY_GW (transparent-proxy.js:18762-18783), тот же самый, что
// front-door пишет в token-usage.jsonl полем `bk` (замер: agentrouter/gorouter/tabi/
// kktoken/justwoker/hcnsec/aipm). Совпадение неслучайно и полезно: потребитель может
// склеить наши отказы со своей статистикой по одному ключу — но именно склеить рядом,
// а не поделить одно на другое (см. запрет выше).
//
// Порт берётся так же, как его берёт сам дашборд при спавне (transparent-proxy.js:1122-1131):
// сначала env, потом константа. Иначе при поднятом `JW_KEEPALIVE_PORT=…` мы читали бы
// файл, в который никто не пишет, и честно рапортовали «нет данных».
//
// Порядок — как в MONEY_GW: ar, go, tb, xp, jw, sk, ts, kk, ap, hn.
const PORT_BY_GW = {
  agentrouter: Number(process.env.AR_KEEPALIVE_PORT || 20133),  // transparent-proxy.js:1122, :7534
  gorouter:    Number(process.env.GO_KEEPALIVE_PORT || 20156),  // :1124, :12234
  tabi:        Number(process.env.TB_KEEPALIVE_PORT || 20155),  // :1123, :17227
  xpeach:      Number(process.env.XP_KEEPALIVE_PORT || 20157),  // :1125, :18174
  justwoker:   Number(process.env.JW_KEEPALIVE_PORT || 20158),  // :1126, :14947
  seekai:      Number(process.env.SK_KEEPALIVE_PORT || 20159),  // :1127, :15849
  truesota:    Number(process.env.TS_KEEPALIVE_PORT || 20160),  // :1128, :16506
  kktoken:     Number(process.env.KK_KEEPALIVE_PORT || 20161),  // :1129, :12885
  aipm:        Number(process.env.AP_KEEPALIVE_PORT || 20163),  // :1130, :12920 (не 20162!)
  hcnsec:      Number(process.env.HN_KEEPALIVE_PORT || 20162),  // :1131, :14257
};

// 🪤 ap=20163, hn=20162 — порядок «перекрёстный» относительно алфавита и относительно
// порядка в реестре: HCNsec появился раньше AIPM и занял 20162. Перепутать эти два
// значения = приписать отказы соседнему шлюзу, а оба живые (у :20163 отказов 238).

const FAILURE_EVENTS = ['err', 'abort', 'stall', 'truncated'];
const SAVED_EVENTS   = ['hold', 'empty', 'jsonhold', 'precommit'];

// Минимум запросов, ниже которого процент не считается. 3 отказа из 6 запросов — это не
// «50% отказов», это отсутствие выборки, а на дашборде такая цифра выглядит приговором.
const MIN_REQ_FOR_PCT = 50;

const WINDOW_SEC_MAX = evs.BUCKETS * 60;          // 172800 = 48ч, следует за event-store
const WINDOW_SEC_DEFAULT = WINDOW_SEC_MAX;

// Опечатка в имени события или переименование в event-store.js не должны молча давать
// нули: считаем их один раз при загрузке и выносим в warnings.
const UNKNOWN_EVENTS = [...FAILURE_EVENTS, ...SAVED_EVENTS, 'req', 'ok', 'route', 'rotate', 'clientgone', 'boot']
  .filter((k) => !evs.EVENTS.includes(k));

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const sum = (totals, keys) => keys.reduce((acc, k) => acc + num(totals[k]), 0);
const pick = (totals, keys) => {
  const out = {};
  for (const k of keys) out[k] = num(totals[k]);
  return out;
};
const nulls = (keys) => {
  const out = {};
  for (const k of keys) out[k] = null;
  return out;
};
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const pct2 = (x) => Math.round(x * 100) / 100;

// Зажим окна. Считаем его здесь, а не полагаемся на внутренний зажим summarize(), чтобы
// `window_sec` в ответе не разъехался с окном, по которому реально сложены числа, — и
// чтобы окно было известно даже когда ни одного файла нет и summarize не звался ни разу.
//
// 🪤 Мусор на входе уходит в НАШИ 48ч, а не в 86400 из summarize. Молчаливая подмена
// суток вместо двух — это ровно то смешение окон, из-за которого цифра потом подписывается
// чужим периодом; лучше отдать документированный дефолт и сказать об этом в warnings.
function clampWindow(windowSec) {
  const n = Number(windowSec);
  if (!Number.isFinite(n) || n <= 0) return WINDOW_SEC_DEFAULT;
  return Math.max(60, Math.min(WINDOW_SEC_MAX, n));
}

function blank(bk, port, file, source, reason, oldestAt, newestAt) {
  return {
    bk, port,
    req: null,
    failures: null,
    failure_pct: null,
    breakdown: nulls(FAILURE_EVENTS),
    saved: null,
    saved_breakdown: nulls(SAVED_EVENTS),
    routed: null,
    rotated: null,
    clientgone: null,
    ok: null,                     // сверх контракта: req ≈ ok + failures + clientgone
    boot: null,                   // сверх контракта: рестарты, объясняют дыры на шкале
    no_data: true,
    no_data_reason: reason,
    oldest_at: oldestAt || null,
    newest_at: newestAt || null,
    source,
    file,
  };
}

function forGateway(bk, port, win, dir) {
  const file = evs.fileFor(port, dir);
  const store = evs.readStore(port, dir);

  // null от readStore = нет файла ИЛИ файл битый: для читателя это одно и то же, но для
  // отчёта разница есть, поэтому различаем существованием пути.
  if (!store) {
    return blank(bk, port, file, 'missing',
      'нет файла событий — keepalive на этом порту не поднимался (или файл битый)', null, null);
  }

  // Бакеты старше 48ч readStore отбросил сам. Пустой массив = история была, но целиком
  // вытекла из окна хранения.
  if (!store.buckets.length) {
    return blank(bk, port, file, 'file',
      `файл есть, но в нём нет ни одного бакета за последние ${WINDOW_SEC_MAX / 3600}ч`, null, null);
  }

  const s = evs.summarize(store.buckets, win);
  const oldestAt = iso(s.oldest_at);
  const newestAt = iso(s.newest_at);

  // Границы истории отдаём и здесь: без них «нет данных» не отличить от «данные есть, но
  // старше запрошенного окна», а это разные выводы о шлюзе.
  if (!s.points.length) {
    return blank(bk, port, file, 'file',
      `в окне ${win} c нет бакетов; вся история старше окна (последняя запись ${newestAt})`,
      oldestAt, newestAt);
  }

  const t = s.totals;
  const req = num(t.req);
  const failures = sum(t, FAILURE_EVENTS);
  const saved = sum(t, SAVED_EVENTS);

  return {
    bk, port,
    req,
    failures,
    // Знаменатель — `req` этого же кольца. При маленькой выборке процент не считаем.
    failure_pct: req >= MIN_REQ_FOR_PCT ? pct2((failures / req) * 100) : null,
    breakdown: pick(t, FAILURE_EVENTS),
    saved,
    saved_breakdown: pick(t, SAVED_EVENTS),
    routed: num(t.route),
    rotated: num(t.rotate),
    clientgone: num(t.clientgone),   // 🪤 сюда и только сюда: это Ctrl-C владельца
    ok: num(t.ok),
    boot: num(t.boot),
    no_data: false,
    no_data_reason: null,
    oldest_at: oldestAt,
    newest_at: newestAt,
    source: 'file',
    file,
  };
}

/**
 * Сводка надёжности по всем денежным шлюзам.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.windowSec=172800] окно в секундах; зажимается в [60, 172800]
 * @param {string}  [opts.dir] каталог с файлами событий (по умолчанию — routing/)
 * @returns {{ window_sec:number, gateways:object, warnings:string[] }}
 */
function reliability({ windowSec = WINDOW_SEC_DEFAULT, dir } = {}) {
  const win = clampWindow(windowSec);
  const warnings = [];

  if (UNKNOWN_EVENTS.length) {
    warnings.push(`event-store не знает событий: ${UNKNOWN_EVENTS.join(', ')} — классификация неполная`);
  }
  const asked = Number(windowSec);
  if (!Number.isFinite(asked) || asked <= 0) {
    warnings.push(`windowSec=${JSON.stringify(windowSec)} не число — взято окно по умолчанию ${win} c`);
  } else if (asked !== win) {
    warnings.push(`окно ${asked} c зажато до ${win} c (предел хранения — ${WINDOW_SEC_MAX} c = ${WINDOW_SEC_MAX / 3600}ч)`);
  }

  const gateways = {};
  for (const [bk, port] of Object.entries(PORT_BY_GW)) {
    gateways[bk] = forGateway(bk, port, win, dir);
  }

  const all = Object.values(gateways);
  const label = (g) => `${g.bk}:${g.port}`;

  const missing = all.filter((g) => g.source === 'missing').map(label);
  if (missing.length) warnings.push(`нет файла событий: ${missing.join(', ')} — keepalive не поднимался`);

  // Две разные причины «нет данных», и путать их нельзя: в первой шлюз молчал больше
  // 48ч (бакеты отброшены самим event-store при чтении, `newest_at` уже недоступен),
  // во второй история жива и видна в `newest_at`, просто не попала в запрошенное окно.
  const evicted = all.filter((g) => g.no_data && g.source === 'file' && !g.newest_at).map(label);
  if (evicted.length) {
    warnings.push(`молчат дольше ${WINDOW_SEC_MAX / 3600}ч: ${evicted.join(', ')} — числа null, история вытекла из кольца`);
  }
  const stale = all.filter((g) => g.no_data && g.source === 'file' && g.newest_at)
    .map((g) => `${label(g)} (последняя запись ${g.newest_at})`);
  if (stale.length) warnings.push(`история есть, но старше окна ${win} c: ${stale.join(', ')} — числа null`);

  const thin = all
    .filter((g) => !g.no_data && g.req < MIN_REQ_FOR_PCT)
    .map((g) => `${g.bk} (req=${g.req})`);
  if (thin.length) warnings.push(`failure_pct не считан, выборка меньше ${MIN_REQ_FOR_PCT} запросов: ${thin.join(', ')}`);

  return { window_sec: win, gateways, warnings };
}

module.exports = { reliability, PORT_BY_GW };

// ── CLI: node routing/health-reliability.js [окно_в_секундах] ─────────────────
// Ровно для глазами-проверки: таблица «отказы / спасено / ушёл сам» по шлюзам.
if (require.main === module) {
  const r = reliability({ windowSec: Number(process.argv[2]) || WINDOW_SEC_DEFAULT });
  const hrs = (r.window_sec / 3600).toFixed(0);
  console.log(`окно ${r.window_sec} c (${hrs}ч), источник — кольцо событий keepalive, ${path.basename(__filename)}`);
  console.log('шлюз         порт   req    отказы  %     err  abort stall trunc  спасено  route rotate  Ctrl-C');
  for (const g of Object.values(r.gateways)) {
    if (g.no_data) {
      console.log(`${g.bk.padEnd(12)} ${String(g.port).padEnd(6)} нет данных — ${g.no_data_reason}`);
      continue;
    }
    const b = g.breakdown;
    console.log(
      `${g.bk.padEnd(12)} ${String(g.port).padEnd(6)} ${String(g.req).padStart(5)}  ` +
      `${String(g.failures).padStart(6)}  ${(g.failure_pct === null ? '—' : g.failure_pct.toFixed(2)).padStart(5)} ` +
      `${String(b.err).padStart(4)} ${String(b.abort).padStart(5)} ${String(b.stall).padStart(5)} ` +
      `${String(b.truncated).padStart(5)}  ${String(g.saved).padStart(7)}  ${String(g.routed).padStart(5)} ` +
      `${String(g.rotated).padStart(6)}  ${String(g.clientgone).padStart(6)}`
    );
  }
  for (const w of r.warnings) console.log(`⚠ ${w}`);
}
