/* ════════════════════════════════════════════════════════════════════════════
   models-tab.js — вкладка «Модели» дашборда ABUSE HUB (:8200)
   Неймспейс: window.MODELS. Точка входа: MODELS.load().

   Данные — с РЕАЛЬНОГО рабочего трафика, а не с пингов. Отсюда три вещи,
   которые в этом файле нигде не смешиваются:

     ┌─────────────────────────┬──────────────┬──────────────────────────────┐
     │ pairs (скорость, кэш)   │ 15 дней      │ журнал успешных ответов      │
     │ reliability (отказы)    │ 48 часов     │ счётчики прокси              │
     │ probes (ручная проверка)│ момент       │ один живой запрос            │
     └─────────────────────────┴──────────────┴──────────────────────────────┘

   🔴 Окна НИКОГДА не делятся друг на друга и не складываются: это разные
      популяции. Каждая цифра в интерфейсе подписана своим окном.

   🪤 `ok_responses` — это «Успешных ответов», а НЕ «Запросов»: в журнал
      попадают только 2xx с отчётом usage, ошибок там нет вообще. Делить
      отказы на это число — ложь.

   🪤 Слова «мёртвая» в интерфейсе нет. Возраст — не доказательство смерти.

   🪤 Свежий трафик + провалившаяся проба = врёт ПРОБА (не тот id, протухшая
      тир-карта). Журнал старше пробы. Красный в этом случае запрещён.

   Стиль: Tailwind 4 browser build, 22 темы через OKLCH-переменные.
     • только токены тем: bg/surface/elevated/line/line-soft/ink/muted/dim
       и акценты emerald/amber/azure/violet/crimson;
     • `rose` НЕ используется вообще: в теме zen он неотличим от crimson
       (ΔE 5.1 при норме 15, дейтеранопия 4.7, тританопия 1.3);
     • `sky`/`teal`/`cyan` в темах не объявлены — не красят ничего;
     • `bg-white/…` невидим на светлых темах (daylight/paper);
     • статус НИКОГДА не одним цветом — цвет + знак + слово, чтобы читалось
       при дальтонизме и при неразличимых цветах.

   Классы `mh-*` — на стороне A8 (/vendor/models-tab.css). Здесь только
   разметка. Ожидаемый контракт:
     mh-table, mh-th, mh-row, mh-num  — плотность и моноширина таблицы
     mh-badge                          — форма бейджа состояния
     mh-chip                           — мелкая плашка-факт на карточке
     mh-group                          — шапка свёрнутой группы каталога
     mh-kpi                            — плитка KPI
   ════════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  const API = '/__switch/api/models';

  // ── мелкая утварь ─────────────────────────────────────────────────────────
  // Свой esc: имена моделей приходят от чужих шлюзов, доверия им нет никакого.
  // Кавычка экранируется тоже — значения уходят в атрибуты (data-key, title).
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const byId = (id) => document.getElementById(id);
  const say = (text, kind, ms) => {
    if (typeof window.toast === 'function') window.toast(text, kind, ms);
    else console.log('[models]', kind || 'info', text);
  };

  // Ключ джойна — `${bk}|${m}`, оба куска lowercase + trim. Зафиксирован в
  // каркасе вкладки (proxy-dashboard.html), менять нельзя.
  const pkey = (bk, m) => `${String(bk ?? '').trim().toLowerCase()}|${String(m ?? '').trim().toLowerCase()}`;

  // Время приезжает как ISO-строка или как эпоха (в секундах или в мс) —
  // терпим всё, иначе одна смена формата на бэке обнуляет всю колонку.
  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  const hoursSince = (ts) => { const ms = toMs(ts); return ms == null ? null : (Date.now() - ms) / 3.6e6; };

  function ago(ts) {
    const ms = toMs(ts);
    if (ms == null) return null;
    const dt = Date.now() - ms;
    if (dt < 0) return 'только что';
    if (dt < 90e3) return 'только что';
    if (dt < 3.6e6) return `${Math.round(dt / 60e3)} мин назад`;
    if (dt < 864e5) return `${Math.round(dt / 36e5)} ч назад`;
    return `${Math.round(dt / 864e5)} дн назад`;
  }

  const num = (v, d = 0) => (v == null || !Number.isFinite(Number(v)))
    ? null
    : Number(v).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });

  // Проценты: целое от 10 и выше, один знак ниже — иначе «0%» вместо «0,4%».
  function pct(v) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    const n = Number(v);
    return (Math.abs(n) >= 10 ? num(n, 0) : num(n, 1)) + '%';
  }

  function ms2s(v) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    const n = Number(v);
    return n < 1000 ? `${num(n, 0)} мс` : `${num(n / 1000, 1)} с`;
  }

  function median(arr) {
    const a = arr.filter((x) => x != null && Number.isFinite(Number(x))).map(Number).sort((x, y) => x - y);
    if (!a.length) return null;
    const h = a.length >> 1;
    return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
  }

  const dash = '<span class="text-muted">—</span>';
  const noData = '<span class="text-muted">нет данных</span>';

  // ── состояние вкладки ─────────────────────────────────────────────────────
  // Живёт между перерисовками: MODELS.load() зовёт не только кнопка ↻, но и
  // общий автотик дашборда. Сортировка, фильтр и галочки обязаны переживать
  // фоновую перечитку, иначе вкладка выдёргивает ввод из-под рук.
  const S = {
    data: null,
    rows: [],
    err: null,
    loading: false,
    wired: false,          // делегированные обработчики навешены один раз
    qWired: false,         // слушатель поля поиска — свой флаг, свой момент
    shell: false,          // каркас таблицы (тулбар с поиском) построен
    q: '',
    sort: { k: 'seen', dir: 'desc' },
    openCatalog: false,
    picked: new Set(),     // ключи моделей, отмеченных на проверку
    asking: false,         // ждём смету (первый POST, без confirm)
    probing: false,        // прогон идёт на бэке
    pollTimer: null,
    sawRunning: false,
  };

  const WIN_REL = '48 ч';
  const winTraffic = () => {
    const d = S.data && S.data.window && Number(S.data.window.days);
    return Number.isFinite(d) && d > 0 ? `${num(d, 0)} дн` : '15 дн';
  };

  // ── сборка строк: catalog ∪ pairs ─────────────────────────────────────────
  // Одна модель может прийти из трёх мест сразу (тир-карта, каталог шлюза,
  // журнал трафика). Джойн по pkey, трафик приоритетнее каталога.
  function buildRows(d) {
    const pairs = new Map();
    for (const p of (d.pairs || [])) {
      if (!p) continue;
      pairs.set(pkey(p.bk, p.m), p);
    }
    const probes = d.probes || {};
    const rows = new Map();

    const put = (bk, m, key) => {
      if (!rows.has(key)) rows.set(key, { key, bk: bk ?? '', m: m ?? '', pair: null, cat: null, probe: probes[key] || null });
      return rows.get(key);
    };

    for (const c of (d.catalog || [])) {
      if (!c) continue;
      const key = c.key || pkey(c.bk, c.m);
      put(c.bk, c.m, key).cat = c;
    }
    for (const [key, p] of pairs) {
      const r = put(p.bk, p.m, key);
      r.pair = p;
      // Журнал знает точное написание имени — каталог мог отдать алиас.
      if (p.m) r.m = p.m;
      if (p.bk) r.bk = p.bk;
    }
    for (const r of rows.values()) r.st = stateOf(r);
    return [...rows.values()];
  }

  // ── состояние модели ──────────────────────────────────────────────────────
  // Возвращает { tone, sign, word, sub, tip, rank }.
  //   tone — токен акцента (emerald|amber|crimson|azure) либо '' = приглушённо.
  //   sign — знак, дублирующий цвет: интерфейс обязан читаться без цвета.
  //   rank — для сортировки колонки «состояние»: чем меньше, тем «живее».
  //
  // 🪤 Красный ставится ТОЛЬКО по провалившейся пробе и только если журнал
  //    её не опровергает. Возраст сам по себе красным не бывает никогда.
  function stateOf(r) {
    const p = r.pair;
    const pr = r.probe;
    const seenH = p ? hoursSince(p.last_seen) : null;
    const fresh = seenH != null && seenH < 24;
    const probeAge = pr ? ago(pr.at) : null;
    const probeTs = probeAge ? `проверка ${probeAge}` : 'проверка';

    // Проба сознательно не запускалась (например, низкий баланс) — это не
    // отрицательный результат. Показываем нейтрально и оставляем модель в
    // состоянии, которое доказывает рабочий трафик, если он есть.
    if (pr && pr.skipped) {
      return fresh ? {
        tone: 'emerald', sign: '●', word: 'рабочая',
        sub: `последний ответ ${ago(p.last_seen)} · проверка пропущена: ${pr.skipped}`,
        tip: 'Живая проверка не запускалась; состояние подтверждено реальным трафиком.',
        rank: 0,
      } : {
        tone: '', sign: '○', word: 'не проверялась',
        sub: `проверка пропущена: ${pr.skipped}`,
        tip: 'Запрос к модели не отправлялся, поэтому отрицательного результата нет.',
        rank: 5,
      };
    }

    // Проба провалилась, но журнал показывает свежий ответ → врёт проба.
    // Амбер с обеими отметками времени, никогда не красный.
    if (pr && pr.ok === false && fresh) {
      return {
        tone: 'amber', sign: '⚠', word: 'рабочая · проверка не прошла',
        sub: `ответ ${ago(p.last_seen)} · ${probeTs}: ${pr.reason || 'без причины'}`,
        tip: 'Журнал старше пробы: модель отвечала на реальном трафике. Скорее всего проба ушла не тем id или по протухшей тир-карте.',
        rank: 1,
      };
    }
    if (pr && pr.ok === false) {
      return {
        tone: 'crimson', sign: '✗', word: 'не ответила',
        sub: `${probeTs}: ${pr.reason || 'без причины'}`,
        tip: 'Живой запрос вернул ошибку, свежего трафика тоже нет.',
        rank: 6,
      };
    }
    if (pr && pr.ok) {
      const ttfb = ms2s(pr.ttfb_ms);
      return {
        tone: 'emerald', sign: '✓', word: p ? 'рабочая · проверена' : 'ответила на проверке',
        sub: `${probeTs}${ttfb ? ` · TTFB ${ttfb}` : ''}`,
        tip: 'Ответила на живой запрос.',
        rank: 0,
      };
    }
    if (fresh) {
      return {
        tone: 'emerald', sign: '●', word: 'рабочая',
        sub: `последний ответ ${ago(p.last_seen)}`,
        tip: `Успешный ответ на реальном трафике за последние сутки (журнал ${winTraffic()}).`,
        rank: 0,
      };
    }
    if (seenH != null && seenH < 24 * 7) {
      return {
        tone: 'amber', sign: '◐', word: 'давно не видели',
        sub: `последний ответ ${ago(p.last_seen)}`,
        tip: 'Трафика больше суток нет. Это не значит, что модель мертва — её просто не звали.',
        rank: 2,
      };
    }
    if (seenH != null) {
      return {
        tone: '', sign: '◌', word: 'давно не видели',
        sub: `последний ответ ${ago(p.last_seen)}`,
        tip: 'Трафика больше недели нет. Возраст — не доказательство: проверь запросом.',
        rank: 4,
      };
    }
    const fromCatalog = r.cat && r.cat.source === 'catalog';
    return {
      tone: '', sign: '○', word: fromCatalog ? 'не проверялась' : 'не использовалась',
      sub: fromCatalog ? 'есть в каталоге шлюза' : 'ни одного ответа в журнале',
      tip: 'Трафика по ней не было. Телеметрии нет — узнать можно только живым запросом.',
      rank: 5,
    };
  }

  // Триплет классов акцента. Пустой tone = приглушённая, но читаемая подача:
  // text-muted проходит AA во всех 22 темах, text-faint — ни в одной.
  const toneCls = (t) => (t
    ? `bg-${t}/10 border-${t}/40 text-${t}`
    : 'bg-elevated border-line-soft text-muted');

  // ── KPI-строка ────────────────────────────────────────────────────────────
  // Четыре плитки. У каждой цифры подписано ОКНО, из которого она взята,
  // иначе через неделю никто не вспомнит, что скорость — за 15 дней, а
  // отказы — за 48 часов, и кто-нибудь поделит одно на другое.
  function kpiTile(label, value, sub, tone) {
    const v = value == null
      ? '<span class="text-muted text-base">нет данных</span>'
      : `<span class="text-ink font-semibold">${value}</span>`;
    const accent = tone ? `text-${tone}` : 'text-muted';
    return `<div class="mh-kpi rounded-xl bg-surface border border-line-soft p-4">
      <div class="text-[11px] uppercase tracking-wider ${accent}">${esc(label)}</div>
      <div class="mt-1.5 text-2xl leading-none">${v}</div>
      <div class="mt-1.5 text-[11px] text-muted">${sub || ''}</div>
    </div>`;
  }

  function renderKpi() {
    const box = byId('models-kpi');
    if (!box) return;
    if (S.err) { box.innerHTML = errCard(S.err); return; }
    if (!S.data) { box.innerHTML = kpiTile('загрузка…', null, ''); return; }

    const rows = S.rows || [];
    const live = rows.filter((r) => r.pair && hoursSince(r.pair.last_seen) < 24);
    const med = median(rows.map((r) => (r.pair ? r.pair.tokps_median : null)));
    const medN = rows.filter((r) => r.pair && r.pair.tokps_median != null).length;
    const gws = (S.data.gateways || []).length;

    box.innerHTML = [
      kpiTile('Всего моделей', num(rows.length, 0),
        `каталог шлюзов + журнал за ${winTraffic()}`, 'azure'),
      kpiTile('Рабочих сейчас', num(live.length, 0),
        'успешный ответ за последние 24 ч', live.length ? 'emerald' : 'amber'),
      kpiTile('Медианная скорость', med == null ? null : `${num(med, 1)} <span class="text-sm text-muted">ток/с</span>`,
        medN ? `медиана по ${num(medN, 0)} моделям · журнал ${winTraffic()}` : 'мало данных (n=0)', 'violet'),
      kpiTile('Шлюзов с данными', num(gws, 0),
        `отвечали за ${winTraffic()}`, 'azure'),
    ].join('');
  }

  const errCard = (msg) => `<div class="rounded-xl bg-surface border border-line-soft p-4">
    <div class="text-xs text-crimson">✗ ${esc(msg)}</div>
  </div>`;

  // ── карточки шлюзов ───────────────────────────────────────────────────────
  // Тип тарифа, а НЕ деньги: ни одной суммы на вкладке нет и быть не должно.
  // Бэк может отдать flat_rate в разных местах — терпим все.
  //
  // Отсутствие flat_rate = `free`, а не «тариф не указан» (решение владельца
  // 10.09). Весь хаб построен на бесплатных эндпоинтах, и «не указан» здесь было
  // не осторожностью, а шумом: у кастом-провайдеров платного тарифа нет по
  // определению — иначе их бы тут не было. Плоский и токенный тарифы остаются
  // подписанными отдельно: они говорят не про деньги, а про цену дубля.
  function tariffOf(bk, gw) {
    const cat = S.data && S.data.catalog;
    let src = gw || {};
    if (src.flat_rate == null && cat && !Array.isArray(cat) && Array.isArray(cat.gateways)) {
      src = cat.gateways.find((g) => g && pkey(g.bk, '') === pkey(bk, '')) || src;
    }
    if (src.flat_rate == null) return { word: 'free', tone: 'emerald', notes: src.notes || '' };
    return src.flat_rate
      ? { word: 'плоско за запрос', tone: 'violet', notes: src.notes || '' }
      : { word: 'по токенам', tone: 'amber', notes: src.notes || '' };
  }

  const chip = (tone, sign, word, tip) =>
    `<span class="mh-chip inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] ${toneCls(tone)}"${tip ? ` title="${esc(tip)}"` : ''}>${sign ? `${esc(sign)} ` : ''}${esc(word)}</span>`;

  // Строка «подпись → цифра» внутри карточки. Цифра всегда text-ink font-semibold:
  // это единственная градация, которая проходит AA во всех темах.
  function fact(label, value, hint, tip) {
    const v = value == null ? noData : `<span class="text-ink font-semibold">${value}</span>`;
    return `<div class="flex items-baseline justify-between gap-2"${tip ? ` title="${esc(tip)}"` : ''}>
      <span class="text-[11px] text-muted">${esc(label)}</span>
      <span class="text-xs whitespace-nowrap">${v}${hint ? ` <span class="text-[10px] text-muted">${esc(hint)}</span>` : ''}</span>
    </div>`;
  }

  function renderCards() {
    const box = byId('models-cards');
    if (!box) return;
    if (S.err) { box.innerHTML = errCard(S.err); return; }
    if (!S.data) { box.innerHTML = '<div class="text-xs text-muted">загрузка…</div>'; return; }

    const gws = S.data.gateways || [];
    const catalogGateways = Array.isArray(S.data.catalog_gateways) ? S.data.catalog_gateways : [];
    const allBks = new Set([
      ...gws.map((g) => String(g && g.bk || '').trim().toLowerCase()),
      ...catalogGateways.map((g) => String(g && g.bk || '').trim().toLowerCase()),
    ]);
    if (!allBks.size) {
      box.innerHTML = `<div class="rounded-xl bg-surface border border-line-soft p-4 text-xs text-muted">нет данных: за ${esc(winTraffic())} ни один шлюз не отчитался</div>`;
      return;
    }
    const rel = S.data.reliability || {};
    const trafficByBk = new Map(gws.map((g) => [String(g && g.bk || '').trim().toLowerCase(), g]));
    const catalogByBk = new Map(catalogGateways.map((g) => [String(g && g.bk || '').trim().toLowerCase(), g]));
    box.innerHTML = [...allBks].filter(Boolean).map((bk) => {
      const g = trafficByBk.get(bk) || { bk, ok_responses: 0, models: 0, last_seen: null, tokps_median_opus5: null };
      const cg = catalogByBk.get(bk) || null;
      const mine = (S.rows || []).filter((r) => pkey(r.bk, '') === pkey(bk, ''));
      const trafficRows = mine.filter((r) => r.pair);
      const liveN = trafficRows.filter((r) => hoursSince(r.pair.last_seen) < 24).length;
      const shareTone = !trafficRows.length ? '' : (liveN / trafficRows.length >= 0.5 ? 'emerald' : liveN ? 'amber' : '');
      const t = tariffOf(bk, cg || g);
      const R = rel[bk] || rel[String(bk).toLowerCase()] || null;

      // failure_pct — своё окно 48 ч и своя популяция (все запросы, включая
      // упавшие). С ok_responses не сопоставляется ничем.
      const failHtml = (!R || R.no_data)
        ? noData
        : `<span class="text-ink font-semibold">${esc(pct(R.failure_pct) || '—')}</span>`;
      const failTip = R && !R.no_data && R.breakdown
        ? 'Из чего сложилось: ' + Object.entries(R.breakdown).map(([k, v]) => `${k} ${v}`).join(', ')
        : 'Доля неуспешных запросов к шлюзу за 48 ч. С «успешными ответами» из журнала не сопоставляется: разные окна и разные популяции.';
      const savedTip = R && R.saved_breakdown
        ? 'Из чего сложилось: ' + Object.entries(R.saved_breakdown).map(([k, v]) => `${k} ${v}`).join(', ')
        : 'Запросы, которые защита увела на другой шлюз или переспросила. Это спасённые запросы, а не потери.';

      return `<div class="rounded-xl bg-surface border border-line-soft p-4 space-y-2.5">
        <div class="flex items-start justify-between gap-2">
          <div class="text-sm font-semibold text-ink truncate" title="${esc(bk)}">${esc(bk)}</div>
          ${chip(t.tone, '◆', t.word, t.notes || 'Тип тарифа шлюза. Сумм на этой вкладке нет намеренно.')}
        </div>
        ${t.notes ? `<div class="text-[11px] text-muted">${esc(t.notes)}</div>` : ''}
        <div class="space-y-1.5 pt-0.5 border-t border-line-soft">
          ${fact('Рабочих моделей с трафиком', trafficRows.length ? `${num(liveN, 0)} / ${num(trafficRows.length, 0)}` : null,
    trafficRows.length ? (shareTone ? `· ${pct((liveN / trafficRows.length) * 100)}` : '· 0%') : '',
    'Знаменатель — только модели, по которым был реальный трафик. Свёрнутый каталог сюда не входит.')}
          ${fact('Скорость claude-opus-5', g.tokps_median_opus5 == null ? null : num(g.tokps_median_opus5, 1), g.tokps_median_opus5 == null ? '' : 'ток/с',
    'Именно по claude-opus-5: общий p50 по смеси моделей между шлюзами несравним — у каждого своя смесь.')}
          ${fact('Успешных ответов', num(g.ok_responses, 0), `за ${winTraffic()}`,
    'В журнал попадают только 2xx с отчётом usage. Это НЕ число запросов: ошибок здесь нет вообще.')}
          <div class="flex items-baseline justify-between gap-2" title="${esc(failTip)}">
            <span class="text-[11px] text-muted">Отказы шлюза за ${esc(WIN_REL)}</span>
            <span class="text-xs whitespace-nowrap">${failHtml}</span>
          </div>
          <div class="flex items-baseline justify-between gap-2" title="${esc(savedTip)}">
            <span class="text-[11px] text-muted">Сработала защита, раз</span>
            <span class="text-xs whitespace-nowrap">${(!R || R.no_data) ? noData : `<span class="text-ink font-semibold">${esc(num(R.saved, 0) || '0')}</span> <span class="text-[10px] text-muted">за ${esc(WIN_REL)}</span>`}</span>
          </div>
        </div>
        <div class="text-[11px] text-muted pt-1 border-t border-line-soft">
          моделей с трафиком ${esc(num(trafficRows.length, 0) || '0')}${cg && cg.models_in_catalog != null ? ` · в каталоге ${esc(num(cg.models_in_catalog, 0) || '0')}` : ''} · последний ответ ${esc(ago(g.last_seen) || 'неизвестно')}
        </div>
      </div>`;
    }).join('');
  }

  // ── таблица моделей ───────────────────────────────────────────────────────
  // Каркас (тулбар с поиском) строится ОДИН раз и больше не переписывается:
  // MODELS.load() зовёт не только кнопка, но и общий автотик дашборда, а
  // innerHTML по контейнеру с полем ввода выдёргивал бы строку поиска из-под
  // рук на каждой фоновой перечитке.
  const CACHE_UNMEASURED_BK = new Set(['custom', 'gorouter', 'justwoker', 'kktoken', 'tabi']);
  const cachePct = (p, bk) => CACHE_UNMEASURED_BK.has(String(bk || '').toLowerCase()) ? null : p.cache_pct;

  const COLS = [
    { k: 'm', t: 'Модель', a: 'left' },
    { k: 'bk', t: 'Шлюз', a: 'left' },
    { k: 'state', t: 'Состояние', a: 'left' },
    { k: 'tokps', t: 'Скорость, ток/с', a: 'right', tip: 'Медиана по успешным ответам. Рядом n — по скольким ответам посчитано.' },
    { k: 'tail', t: 'Хвост, дольше 60 с', a: 'right', tip: 'Доля ответов, которые шли дольше минуты.' },
    { k: 'stream', t: 'Ответы стримом, %', a: 'right', tip: 'Меньше 100% — шлюз отвечал целым JSON, а не потоком.' },
    { k: 'cache', t: 'Промпт из кэша, %', a: 'right', tip: 'Доля промпта, прочитанная из кэша шлюза.' },
    { k: 'seen', t: 'Последний ответ', a: 'right' },
  ];

  function buildShell() {
    const box = byId('models-table');
    if (!box || S.shell) return;
    box.innerHTML = `
      <div class="rounded-xl bg-surface border border-line-soft">
        <div class="px-4 py-3 border-b border-line-soft space-y-2.5">
          <div class="flex items-center gap-2 flex-wrap">
            <input id="mh-q" type="search" placeholder="фильтр: имя модели или шлюз"
              class="text-xs px-3 py-1.5 rounded-lg bg-elevated border border-line-soft text-ink placeholder:text-muted w-64 max-w-full" />
            <span id="mh-count" class="text-[11px] text-muted font-mono"></span>
          </div>
          <div class="flex items-center gap-2 flex-wrap text-[11px] text-muted">
            <span>Три окна, и они не складываются:</span>
            ${chip('azure', '📊', `трафик — ${winTraffic()}`, 'Скорость, хвост, стрим, кэш и «успешных ответов» — из журнала успешных ответов.')}
            ${chip('amber', '🛡', `отказы — ${WIN_REL}`, 'Отказы и сработавшая защита — счётчики прокси за последние 48 часов. Другая популяция: сюда входят упавшие запросы, которых в журнале нет вообще.')}
            ${chip('violet', '🩺', 'проверка — момент', 'Ручной живой запрос. Одна точка во времени, статистикой не является.')}
          </div>
        </div>
        <div id="mh-live" class="overflow-x-auto"></div>
        <div id="mh-catalog" class="border-t border-line-soft"></div>
      </div>`;
    S.shell = true;
    const q = byId('mh-q');
    if (q) q.value = S.q;
    wireSearch();
  }

  function cmp(a, b, k, dir) {
    const s = dir === 'asc' ? 1 : -1;
    const txt = (r) => String(k === 'bk' ? r.bk : r.m || '').toLowerCase();
    if (k === 'm' || k === 'bk') return txt(a).localeCompare(txt(b), 'ru') * s;
    if (k === 'state') return (a.st.rank - b.st.rank) * (dir === 'asc' ? 1 : -1);
    const get = (r) => {
      const p = r.pair;
      if (!p) return null;
      if (k === 'tokps') return p.tokps_median;
      if (k === 'tail') return p.tail_60s_pct;
      if (k === 'stream') return p.stream_pct;
      if (k === 'cache') return cachePct(p, r.bk);
      if (k === 'seen') return toMs(p.last_seen);
      return null;
    };
    const va = get(a), vb = get(b);
    // Пустые значения всегда внизу, в обе стороны сортировки: «нет данных»
    // не должно всплывать наверх как самое маленькое число.
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (Number(va) - Number(vb)) * s;
  }

  function filtered(rows) {
    const q = S.q.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const al = (r.cat && Array.isArray(r.cat.aliases)) ? r.cat.aliases.join(' ') : '';
      const tier = (r.cat && r.cat.tier) || '';
      return `${r.m} ${r.bk} ${al} ${tier}`.toLowerCase().includes(q);
    });
  }

  function thHtml() {
    return COLS.map((c) => {
      const on = S.sort.k === c.k;
      const arrow = on ? (S.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      const cls = on ? 'text-ink' : 'text-muted';
      const al = c.a === 'right' ? 'text-right' : 'text-left';
      return `<th data-k="${esc(c.k)}" class="mh-th px-3 py-2 ${al} ${cls} font-medium cursor-pointer select-none whitespace-nowrap"${c.tip ? ` title="${esc(c.tip)}"` : ''}>${esc(c.t)}${arrow}</th>`;
    }).join('');
  }

  function badge(st) {
    return `<span class="mh-badge inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] whitespace-nowrap ${toneCls(st.tone)}" title="${esc(st.tip || '')}">${esc(st.sign)} ${esc(st.word)}</span>`;
  }

  function swapNote(r) {
    const to = r.probe && r.probe.swapped_to;
    if (!to) return '';
    return `<div class="mt-1">${chip('violet', '⇄', `шлюз подменил модель на ${to}`,
      'Ответ пришёл не от той модели, которую просили. Для тир-карты это важный факт: заказ и выдача разошлись.')}</div>`;
  }

  function liveRow(r) {
    const p = r.pair;
    const spd = p.tokps_median == null
      ? `<span class="text-muted">мало данных (n=${esc(num(p.tokps_n, 0) || '0')})</span>`
      : `<span class="text-ink font-semibold">${esc(num(p.tokps_median, 1))}</span> <span class="text-[10px] text-muted">n=${esc(num(p.tokps_n, 0) || '0')}</span>`;
    const spdTip = [
      `Медиана скорости за ${winTraffic()}.`,
      p.tokps_n != null ? `Посчитано по ${num(p.tokps_n, 0)} ответам.` : '',
      p.tokps_dropped ? `Отброшено как выбросы: ${num(p.tokps_dropped, 0)}.` : '',
      p.ms_p50 != null ? `Полное время ответа: p50 ${ms2s(p.ms_p50)}` + (p.ms_p90 != null ? `, p90 ${ms2s(p.ms_p90)}.` : '.') : '',
    ].filter(Boolean).join(' ');

    const cell = (v, tip) => `<td class="mh-num px-3 py-1.5 text-right whitespace-nowrap text-xs"${tip ? ` title="${esc(tip)}"` : ''}>${v == null ? dash : `<span class="text-ink font-semibold">${esc(v)}</span>`}</td>`;
    const streamTip = (p.stream_pct != null && p.stream_pct < 100)
      ? 'Меньше 100% — часть ответов шлюз отдал целым JSON, а не потоком.'
      : 'Доля ответов, отданных потоком.';

    return `<tr class="mh-row border-t border-line-soft hover:bg-elevated/40">
      <td class="px-3 py-1.5 font-mono text-xs text-ink">
        <div class="truncate max-w-[280px]" title="${esc(r.m)}">${esc(r.m)}</div>${swapNote(r)}
      </td>
      <td class="px-3 py-1.5 text-xs text-muted whitespace-nowrap">${esc(r.bk)}</td>
      <td class="px-3 py-1.5">${badge(r.st)}<div class="text-[10px] text-muted mt-0.5">${esc(r.st.sub || '')}</div></td>
      <td class="mh-num px-3 py-1.5 text-right whitespace-nowrap text-xs" title="${esc(spdTip)}">${spd}</td>
      ${cell(pct(p.tail_60s_pct), `Доля ответов дольше 60 с. Окно — журнал за ${winTraffic()}.`)}
      ${cell(pct(p.stream_pct), streamTip)}
      ${cell(pct(cachePct(p, r.bk)), CACHE_UNMEASURED_BK.has(String(r.bk || '').toLowerCase())
        ? 'Шлюз не отдаёт отдельные cache_read/cache_write: значение свёрнуто во входные токены.'
        : 'Доля промпта, прочитанная из кэша шлюза.')}
      <td class="px-3 py-1.5 text-right whitespace-nowrap text-xs text-muted"
          title="${esc(`Успешных ответов за ${winTraffic()}: ${num(p.ok_responses, 0) || 0}. Это не число запросов — в журнал попадают только 2xx с отчётом usage.`)}">
        ${esc(ago(p.last_seen) || '—')}
      </td>
    </tr>`;
  }

  function renderLive(rows) {
    const box = byId('mh-live');
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = `<div class="px-4 py-10 text-center text-xs text-muted">${S.q ? 'ничего не найдено по фильтру' : 'нет данных: за окно журнала ни одна модель не ответила'}</div>`;
      return;
    }
    box.innerHTML = `<table class="mh-table w-full">
      <thead class="bg-elevated text-[10px] uppercase tracking-wider"><tr>${thHtml()}</tr></thead>
      <tbody>${rows.map(liveRow).join('')}</tbody>
    </table>`;
  }

  // Группа «в каталоге, без трафика». Свёрнута по умолчанию НЕ ради красоты:
  // это сотни моделей, у которых телеметрии нет и быть не может. Развёрнутые
  // да ещё и красные, они сделали бы вкладку нечитаемой в первый же день.
  function catalogRow(r) {
    const on = S.picked.has(r.key);
    const cat = r.cat || {};
    const stale = Number(cat.catalog_stale_days);
    const staleHtml = Number.isFinite(stale) && stale > 7
      ? ` ${chip('amber', '⌛', `каталог не обновлялся ${num(stale, 0)} дн`, 'Список моделей шлюза давно не перечитывали — модель могла и появиться, и исчезнуть.')}`
      : '';
    return `<tr class="mh-row border-t border-line-soft hover:bg-elevated/40">
      <td class="px-3 py-1.5 w-8">
        <input type="checkbox" data-pick="${esc(r.key)}"${on ? ' checked' : ''}
          class="accent-emerald align-middle" title="Отметить для живой проверки" />
      </td>
      <td class="px-3 py-1.5 font-mono text-xs text-muted">
        <div class="truncate max-w-[280px]" title="${esc(r.m)}">${esc(r.m)}</div>${swapNote(r)}
      </td>
      <td class="px-3 py-1.5 text-xs text-muted whitespace-nowrap">${esc(r.bk)}</td>
      <td class="px-3 py-1.5">${badge(r.st)}<div class="text-[10px] text-muted mt-0.5">${esc(r.st.sub || '')}</div></td>
      <td class="px-3 py-1.5 text-xs text-muted whitespace-nowrap">${esc(cat.tier || '—')}${staleHtml}</td>
      <td class="px-3 py-1.5 text-xs text-muted truncate max-w-[220px]" title="${esc(cat.owned_by || '')}">${esc(cat.owned_by || '—')}</td>
    </tr>`;
  }

  function renderCatalog(rows) {
    const box = byId('mh-catalog');
    if (!box) return;
    const n = rows.length;
    const picked = rows.filter((r) => S.picked.has(r.key)).length;
    const head = `<button id="mh-cat-toggle" type="button"
        class="mh-group w-full flex items-center gap-2 px-4 py-2.5 text-left text-xs text-muted hover:bg-elevated/40">
        <span class="text-ink">${S.openCatalog ? '▾' : '▸'}</span>
        <span class="text-ink font-semibold">В каталоге, без трафика</span>
        <span class="font-mono">${esc(num(n, 0))}</span>
        <span class="text-[11px]">— телеметрии по ним нет, состояние узнаётся только живым запросом</span>
      </button>`;
    if (!S.openCatalog || !n) {
      box.innerHTML = head + (n ? '' : '');
      return;
    }
    box.innerHTML = head + `
      <div class="px-4 py-2 flex items-center gap-2 flex-wrap border-t border-line-soft">
        <button id="mh-pick-all" type="button" class="text-[11px] px-2 py-1 rounded-md bg-elevated border border-line-soft text-muted hover:border-line">
          ${picked >= n ? 'снять все' : 'выбрать все видимые'}
        </button>
        <button id="mh-probe" type="button" ${(!picked || S.probing) ? 'disabled' : ''}
          class="text-[11px] px-2.5 py-1 rounded-md ${(!picked || S.probing) ? 'bg-elevated border border-line-soft text-muted' : 'bg-emerald/10 border border-emerald/40 text-emerald hover:bg-emerald/20'}"
          title="Один живой запрос на каждую отмеченную модель. Сначала покажу смету и спрошу подтверждение.">
          🩺 Проверить выбранные${picked ? ` (${num(picked, 0)})` : ''}
        </button>
        <span class="text-[11px] text-muted">проверка — это реальный запрос на шлюз, не пинг</span>
      </div>
      <div class="overflow-x-auto">
        <table class="mh-table w-full">
          <thead class="bg-elevated text-[10px] uppercase tracking-wider text-muted"><tr>
            <th class="px-3 py-2 w-8"></th>
            <th class="px-3 py-2 text-left font-medium">Модель</th>
            <th class="px-3 py-2 text-left font-medium">Шлюз</th>
            <th class="px-3 py-2 text-left font-medium">Состояние</th>
            <th class="px-3 py-2 text-left font-medium">Тир</th>
            <th class="px-3 py-2 text-left font-medium">Владелец</th>
          </tr></thead>
          <tbody>${rows.map(catalogRow).join('')}</tbody>
        </table>
      </div>`;
  }

  function renderTable() {
    const box = byId('models-table');
    if (!box) return;
    // Каркас снесён вместе с полем поиска — сбрасываем оба флага, иначе
    // слушатель больше никогда не повесится на новый инпут.
    if (S.err) { box.innerHTML = errCard(S.err); S.shell = false; S.qWired = false; return; }
    if (!S.data) { box.innerHTML = '<div class="rounded-xl bg-surface border border-line-soft p-4 text-xs text-muted">загрузка…</div>'; S.shell = false; S.qWired = false; return; }

    buildShell();
    const all = filtered(S.rows || []);
    // Кнопку проверки получают ТОЛЬКО модели с нулевым трафиком: там, где
    // трафик есть, телеметрия уже ответила — лучше и бесплатно.
    const live = all.filter((r) => r.pair).sort((a, b) => cmp(a, b, S.sort.k, S.sort.dir));
    const cat = all.filter((r) => !r.pair).sort((a, b) => cmp(a, b, S.sort.k === 'state' ? 'state' : 'm', S.sort.k === 'state' ? S.sort.dir : 'asc'));

    const cnt = byId('mh-count');
    if (cnt) {
      cnt.textContent = `${live.length} с трафиком · ${cat.length} только в каталоге`
        + (S.q ? ` (фильтр из ${(S.rows || []).length})` : '');
    }
    renderLive(live);
    renderCatalog(cat);
  }

  // ── счётчик в сайдбаре ────────────────────────────────────────────────────
  // Пишем его сами: записи для `models` в NAV_COUNT_JOBS нет намеренно — она
  // заставила бы фоновый поллер звать MODELS.load() каждые 20 с, то есть
  // обходить журнал на 8 МБ впустую.
  // 🪤 Прочерк, пока данных нет. Ноль значит «померили и мертво», прочерк —
  //    «ещё не мерили»; это то же различение, что и во всех метриках вкладки.
  function renderNavCount() {
    const el = byId('nav-count-models');
    if (!el) return;
    if (!S.data || S.err) {
      el.textContent = '—';
      el.className = 'text-[10px] font-mono text-muted';
      return;
    }
    const alive = (S.rows || []).filter((r) => r.pair && hoursSince(r.pair.last_seen) < 24).length;
    el.textContent = String(alive);
    el.className = 'text-[10px] font-mono ' + (alive ? 'text-emerald' : 'text-muted');
  }

  function render() {
    renderKpi();
    renderCards();
    renderTable();
    renderNavCount();
  }

  // ── события ───────────────────────────────────────────────────────────────
  // Делегирование, а не inline onclick: имена моделей приходят от чужих шлюзов,
  // и склеивать их в JS-строку атрибута — способ получить чужой код в кавычках.
  // Обработчики вешаются один раз за жизнь страницы.
  function wire() {
    if (S.wired) return;
    const box = byId('models-table');
    const btn = byId('models-refresh');
    if (btn) btn.addEventListener('click', () => load(true));
    if (!box) return;

    box.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-k]');
      if (th) {
        const k = th.dataset.k;
        // Второй клик по той же колонке переворачивает порядок. Текстовые
        // колонки начинают с «а→я», числовые — с большего: так первым делом
        // видно самое быстрое, а не самое пустое.
        if (S.sort.k === k) S.sort.dir = S.sort.dir === 'asc' ? 'desc' : 'asc';
        else S.sort = { k, dir: (k === 'm' || k === 'bk') ? 'asc' : 'desc' };
        renderTable();
        return;
      }
      if (e.target.closest('#mh-cat-toggle')) { S.openCatalog = !S.openCatalog; renderTable(); return; }
      if (e.target.closest('#mh-pick-all')) {
        const cat = filtered(S.rows || []).filter((r) => !r.pair);
        const allOn = cat.length && cat.every((r) => S.picked.has(r.key));
        cat.forEach((r) => (allOn ? S.picked.delete(r.key) : S.picked.add(r.key)));
        renderTable();
        return;
      }
      if (e.target.closest('#mh-probe')) { probeSelected(); }
    });

    box.addEventListener('change', (e) => {
      const cb = e.target.closest('input[data-pick]');
      if (!cb) return;
      if (cb.checked) S.picked.add(cb.dataset.pick);
      else S.picked.delete(cb.dataset.pick);
      // Перерисовываем только кнопку — иначе клик по галочке пересобирал бы
      // таблицу прямо под курсором.
      syncProbeBtn();
    });
    S.wired = true;
  }

  function syncProbeBtn() {
    const b = byId('mh-probe');
    if (!b) return;
    const n = S.picked.size;
    const off = !n || S.probing || S.asking;
    b.disabled = off;
    b.textContent = `🩺 Проверить выбранные${n ? ` (${num(n, 0)})` : ''}`;
    b.className = 'text-[11px] px-2.5 py-1 rounded-md ' + (off
      ? 'bg-elevated border border-line-soft text-muted'
      : 'bg-emerald/10 border border-emerald/40 text-emerald hover:bg-emerald/20');
  }

  // Поле поиска живёт в каркасе, который строит buildShell — свой флаг и свой
  // вызов оттуда, иначе слушатель либо не повесится, либо повесится дважды.
  function wireSearch() {
    if (S.qWired) return;
    const q = byId('mh-q');
    if (!q) return;
    q.addEventListener('input', () => { S.q = q.value || ''; renderTable(); });
    S.qWired = true;
  }

  // ── живая проверка ────────────────────────────────────────────────────────
  // Два шага, и первый обязателен: POST без `confirm` возвращает ТОЛЬКО смету.
  // Показываем её человеку и спрашиваем, прежде чем слать `confirm:true` —
  // проверка это реальные запросы на чужие шлюзы, а не пинг.
  function estimateText(d, n) {
    const bits = [];
    const cnt = d && (d.total ?? d.count ?? (Array.isArray(d.pairs) ? d.pairs.length : null));
    bits.push(`Моделей на проверку: ${num(cnt ?? n, 0)}.`);
    const eta = d && (d.eta_ms ?? d.estimate_ms ?? d.duration_ms);
    if (eta != null) bits.push(`Ожидаемое время: ${ms2s(eta)}.`);
    else if (d && d.eta) bits.push(`Ожидаемое время: ${d.eta}.`);
    if (d && d.note) bits.push(String(d.note));
    if (d && d.warning) bits.push(String(d.warning));
    if (Array.isArray(d && d.warnings)) bits.push(...d.warnings.map(String));
    bits.push('Каждая проверка — реальный запрос на шлюз. Продолжить?');
    return bits.join('\n');
  }

  async function postProbe(pairs, confirm) {
    const res = await fetch(`${API}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirm ? { pairs, confirm: true } : { pairs }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    return d;
  }

  async function probeSelected() {
    if (S.probing) return say('🩺 Проверка уже идёт', 'warn');
    const rows = (S.rows || []).filter((r) => S.picked.has(r.key) && !r.pair);
    if (!rows.length) return say('Отметь хотя бы одну модель без трафика', 'warn');
    const pairs = rows.map((r) => ({ bk: r.bk, m: r.m }));

    try {
      S.probing = true; syncProbeBtn();
      const est = await postProbe(pairs, false);
      S.probing = false; syncProbeBtn();
      // Смету показываем ВСЕГДА, даже если бэк вернул её пустой: молчаливый
      // запуск чужих запросов — не то, что человек должен обнаруживать постфактум.
      if (!window.confirm(estimateText(est, pairs.length))) return;

      S.probing = true; syncProbeBtn();
      const run = await postProbe(pairs, true);
      if (run && run.started === false) {
        S.probing = false; syncProbeBtn();
        return say('🩺 Проверять некого', 'info');
      }
      say(`🩺 Запущена проверка: ${num(run && run.total != null ? run.total : pairs.length, 0)} шт. (в фоне, можно уйти со вкладки)`, 'success', 5000);
      progressPoll();
    } catch (e) {
      S.probing = false; syncProbeBtn();
      say('Проверка: ' + e.message, 'error', 7000);
    }
  }

  // Поллинг прогресса — калька с tgmProgressPoll. Таймер ОДИН и сам себя гасит,
  // когда прогона нет: повторный заход на вкладку не должен плодить таймеры.
  // Не привязан к активной вкладке нарочно — прогон идёт минутами, и тост о
  // финише должен долететь, даже если человек ушёл смотреть другое.
  function progressPoll() {
    if (S.pollTimer) return;
    const stop = () => {
      if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
      S.sawRunning = false;
      S.probing = false;
      syncProbeBtn();
    };
    const wrap = () => byId('models-progress');

    const tick = async () => {
      let d;
      try {
        const res = await fetch(`${API}/probe/progress`);
        d = await res.json();
        if (!res.ok) throw new Error(d.error || 'fail');
      } catch { return stop(); }

      const box = wrap();
      if (!box) return stop();

      if (d.running) {
        S.sawRunning = true;
        S.probing = true;
        syncProbeBtn();
        box.classList.remove('hidden');
        const total = Number(d.total) || 0;
        const done = Number(d.done) || 0;
        const p = total ? Math.round((done / total) * 100) : 0;
        const bar = byId('models-progress-bar');
        const txt = byId('models-progress-txt');
        if (bar) bar.style.width = p + '%';
        if (txt) {
          txt.textContent = `${done}/${total} (${p}%)`
            + (d.current ? ` · сейчас ${typeof d.current === 'string' ? d.current : (d.current.m || '')}` : '');
        }
        return;
      }

      box.classList.add('hidden');
      if (S.sawRunning) {
        // Прогон только что финишировал. Считаем итог по results и перечитываем
        // данные: ответы проб — отдельное окно («момент»), в pairs они не попадут.
        const rs = Array.isArray(d.results) ? d.results : Object.values(d.results || {});
        const ok = rs.filter((x) => x && x.ok).length;
        const bad = rs.length - ok;
        say(`🩺 Готово: ✓ ответили ${ok} · ✗ не ответили ${bad}`, bad ? 'warn' : 'success', 7000);
        load(true);
      }
      stop();
    };

    S.pollTimer = setInterval(tick, 2000);
    tick();
  }

  // ── загрузка ──────────────────────────────────────────────────────────────
  // Зовут двое: кнопка ↻ и общий автотик дашборда. Отсюда защита от наложения
  // и сохранение S.q / S.sort / S.picked между перечитками.
  async function load(force) {
    wire();
    if (S.loading) return;
    S.loading = true;
    if (!S.data) { renderKpi(); renderCards(); renderTable(); renderNavCount(); }
    try {
      const res = await fetch(`${API}/health${force ? `?t=${Date.now()}` : ''}`);
      const d = await res.json();
      if (!res.ok || d.ok === false) throw new Error(d.error || `HTTP ${res.status}`);
      S.data = d;
      S.err = null;
      S.rows = buildRows(d);
      // Галочки чистим от исчезнувших ключей: иначе счётчик кнопки врёт, а
      // проверка уходит по моделям, которых в каталоге уже нет.
      const alive = new Set(S.rows.map((r) => r.key));
      for (const k of [...S.picked]) if (!alive.has(k)) S.picked.delete(k);
      if (Array.isArray(d.warnings) && d.warnings.length && force) {
        say('⚠ ' + d.warnings.slice(0, 3).join(' · '), 'warn', 8000);
      }
    } catch (e) {
      S.err = e.message || String(e);
      S.data = null;
      S.rows = [];
    } finally {
      S.loading = false;
    }
    render();
    // Прогон мог быть запущен из прошлой сессии вкладки — полоса должна
    // появиться сама. Таймер один, повторный вызов ничего не плодит.
    progressPoll();
  }

  window.MODELS = {
    load,
    // Наружу — только точка входа и ручное обновление. Всё остальное закрыто:
    // вкладка не должна редактироваться из консоли соседних вкладок.
    refresh: () => load(true),
  };
})();
