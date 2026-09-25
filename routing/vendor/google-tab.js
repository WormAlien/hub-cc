/* ════════════════════════════════════════════════════════════════════════════
   google-tab.js — вкладка «Google» дашборда ABUSE HUB (:8200)
   Неймспейс: window.GOOGLE. Точка входа: GOOGLE.load().

   Пул Google-аккаунтов под подписку AI Pro: карточка на аккаунт, логин и пароль с
   копированием, живой TOTP-код, если у аккаунта есть секрет, кнопка «Открыть сессию»
   и разбор пачки из магазина с предпросмотром.

   Форма взята у вкладки GitHub-аккаунтов (владелец 25.09: «каеф на подобии гитхаб
   вкладки») и повторяет ЯЗЫК дашборда, а не придумана заново: шапка с заголовком
   слева и действиями справа, формы раскрываются панелями под шапкой (не модальными
   окнами), сетка карточек по брейкпоинтам, кнопки и поля тех же размеров, что в
   статике дашборда. Числа и токены - в шапке `google-tab.css`.

   Два изъяна GitHub-вкладки здесь исправлены:

     • 🪤 Парсер пачки живёт НА СЕРВЕРЕ. У GitHub он продублирован во фронте
       (`ghParseLine`), и новая раскладка магазина требует правок в двух местах.
       Здесь разбор идёт ручкой `import` с `dryRun`, а фронт рисует её ответ.
     • 🪤 Секреты НЕ едут в опрос. Список (`list`) отдаёт `hasPassword`/`hasTotp`
       вместо значений; пароль и 2FA-секрет приходят отдельной ручкой `keys?id=`
       по нажатию глаза (у GitHub они уезжают в каждом опросе раз в 15 секунд).

   Живой код 2FA считается прямо в браузере (base32 + HMAC-SHA1, RFC 6238) и
   обновляется на смене тридцатисекундного окна.

   🪤 Поля форм живут в состоянии (S.draft), а не в DOM: опрос раз в 15 секунд
     перерисовывает разметку, и набранное в форме без этого пропадало бы на
     середине ввода.

   Статус никогда не одним цветом: цвет + знак + слово.
   ════════════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const API = '/__switch/api/google/';
  const POLL_MS = 15000;

  const S = {
    accounts: [], byStatus: {}, byKind: {}, statuses: [], kinds: [],
    pool: { host: '', enabled: false, proxies: [], total: 0, tiers: [] },   // пул прокси для селектора
    secrets: {},        // id → { password, totpSecret, appPassword } - только по запросу
    reveal: {},         // id → true, пароль показан
    revealApp: {},      // id → true, пароль приложения показан
    codes: {}, fail: {},// id → код этого окна / метка «в этом окне не собрался»
    menuOpen: null,
    search: '', statusFilter: '', kindFilter: '',
    loading: false, err: null, loadedOnce: false,
    panel: null,        // null | 'add' | 'import'
    draft: {},          // поля формы добавления
    impText: '', preview: null, addErr: null,
    totals: { total: 0, withTotp: 0, withSession: 0, openWindows: 0 },
    pollTimer: null, tickTimer: null,
  };

  const STATUS_META = {
    unknown: { label: '~ не проверен', cls: 'gg-tag', bar: 'gg-bar-unknown', hint: 'статус ставит человек: v1 ничего не проверяет сама' },
    live:    { label: '✓ живой', cls: 'gg-tag gg-tag-live', bar: 'gg-bar-live', hint: '' },
    dead:    { label: '✗ мёртвый', cls: 'gg-tag gg-tag-dead', bar: 'gg-bar-dead', hint: '' },
    locked:  { label: '⛔ залочен', cls: 'gg-tag gg-tag-locked', bar: 'gg-bar-locked', hint: 'заблокирован или просит челлендж' },
  };
  const KIND_META = {
    personal: { label: 'личный', cls: 'gg-tag gg-tag-personal', hint: 'на личном автоматизацию не запускаем' },
    burner:   { label: 'расходник', cls: 'gg-tag gg-tag-burner', hint: 'под прогоны и эксперименты' },
  };
  // Плашки занятости: в v1 пусты (проверок нет), поле живёт под будущие ветки подписки.
  const USE_TAGS = { flow: 'gg-tag gg-tag-flow', antigravity: 'gg-tag gg-tag-antigravity' };

  // ── Утилиты ───────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  async function api(path, opts) {
    const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    let body = null;
    try { body = await r.json(); } catch { /* ниже решим по коду */ }
    if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
    return body || {};
  }

  const post = (path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload || {}) });

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function ago(iso) {
    if (!iso) return null;
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ч назад`;
    return `${Math.floor(h / 24)} дн назад`;
  }

  function toast(text, kind) {
    let box = document.querySelector('.gg-toasts');
    if (!box) { box = document.createElement('div'); box.className = 'gg-toasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'gg-toast' + (kind === 'ok' ? ' gg-toast-ok' : kind === 'bad' ? ' gg-toast-bad' : '');
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(String(text || ''));
      toast(`${label} скопирован`, 'ok');
    } catch (e) {
      toast(`скопировать не вышло: ${e.message}`, 'bad');
    }
  }

  // ── TOTP (RFC 6238) ───────────────────────────────────────────────────────
  // Секрет приходит ручкой `keys` и кешируется: он не меняется, а дёргать сервер на
  // каждый тик незачем.

  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function base32Decode(str) {
    const clean = String(str || '').replace(/[^A-Za-z2-7]/g, '').toUpperCase();
    const bits = [];
    for (const ch of clean) {
      const v = B32.indexOf(ch);
      if (v < 0) return null;
      for (let b = 4; b >= 0; b--) bits.push((v >> b) & 1);
    }
    const bytes = [];
    for (let i = 0; i + 7 < bits.length; i += 8) {
      let n = 0;
      for (let j = 0; j < 8; j++) n = (n << 1) | bits[i + j];
      bytes.push(n);
    }
    return bytes.length ? bytes : null;
  }

  const totpWindow = () => Math.floor(Date.now() / 1000 / 30);
  const secondsLeft = () => 30 - (Math.floor(Date.now() / 1000) % 30);

  async function computeTotp(secret) {
    const bytes = base32Decode(secret);
    const c = window.crypto && window.crypto.subtle;
    // 🪤 `crypto.subtle` есть только в защищённом контексте. На localhost это так, а по
    // LAN-адресу (дашборд открывают и так) - нет, и тогда вместо кода честная подпись.
    if (!bytes || !c) return null;
    const counter = totpWindow();
    const buf = new ArrayBuffer(8);
    new DataView(buf).setUint32(4, counter >>> 0);   // 64-бит big-endian, старшие 32 = 0
    const key = await c.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = new Uint8Array(await c.sign('HMAC', key, new Uint8Array(buf)));
    const off = sig[sig.length - 1] & 0x0f;
    const num = ((sig[off] & 0x7f) << 24 | sig[off + 1] << 16 | sig[off + 2] << 8 | sig[off + 3]) % 1000000;
    return String(num).padStart(6, '0');
  }

  function codeCache(id) {
    const e = S.codes[id];
    return e && e.win === totpWindow() ? e : null;
  }
  const codeOf = (id) => { const c = codeCache(id); return c ? c.code : null; };
  const secsOf = () => secondsLeft();

  // 🪤 Неудача считается по окну: битый секрет не соберётся никогда, и без этой метки
  // карточка звала бы пересчёт на каждой перерисовке, а перерисовка шла бы на каждом
  // провале. Получился бы вечный цикл вместо честной подписи «код не считается».
  const codeFailed = (id) => S.fail[id] === totpWindow();

  async function ensureCode(a) {
    if (!a.hasTotp) return null;
    const secret = (S.secrets[a.id] || {}).totpSecret;
    if (!secret) return null;
    const cached = codeCache(a.id);
    if (cached) return cached;
    if (codeFailed(a.id)) return null;
    const failWindow = () => { S.fail[a.id] = totpWindow(); };
    try {
      const code = await computeTotp(secret);
      if (!code) { failWindow(); return null; }
      S.codes[a.id] = { win: totpWindow(), code };
      return S.codes[a.id];
    } catch { failWindow(); return null; }
  }

  // ── Загрузка ──────────────────────────────────────────────────────────────

  async function load(force) {
    if (S.loading) return;
    startTimers();
    S.loading = true;
    try {
      const data = await api('list');
      S.accounts = data.accounts || [];
      S.byStatus = data.byStatus || {};
      S.byKind = data.byKind || {};
      S.statuses = data.statuses || [];
      S.kinds = data.kinds || [];
      S.totals = {
        total: data.total || 0, withTotp: data.withTotp || 0,
        withSession: data.withSession || 0, openWindows: data.openWindows || 0,
      };
      S.err = null;
      S.loadedOnce = true;
    } catch (e) {
      S.err = e.message;
    } finally {
      S.loading = false;
    }
    // Пул прокси нужен для селектора: он меняется редко, поэтому берём его один раз и
    // обновляем только когда выбор сделан или вкладку открыли заново.
    if (!S.pool.host) await loadPool();
    // 🪤 Открытое меню карточки перерисовка закрывает, а опрос идёт каждые 15 секунд.
    // Пока человек выбирает в меню, разметку не трогаем: данные уже в S.
    if (!S.menuOpen) render();
    await hydrateSecrets();
    if (force) toast('пул перечитан', 'ok');
  }

  async function loadPool() {
    try {
      const p = await api('proxies');
      S.pool = {
        host: p.host || '', enabled: !!p.enabled, proxies: p.proxies || [],
        total: p.total || 0, skipped: p.skipped || 0, tiers: p.tiers || [],
      };
    } catch (e) {
      S.pool = { host: '', enabled: false, proxies: [], total: 0, tiers: [], error: e.message };
    }
  }

  // Секреты тянем ТОЛЬКО для карточек с 2FA: без секрета кода не собрать, а это и есть
  // смысл блока. Пароли так не подтягиваются - они ждут нажатия глаза.
  async function hydrateSecrets() {
    const need = S.accounts.filter(a => a.hasTotp && !S.secrets[a.id] && a.id);
    for (const a of need) {
      try {
        const k = await api('keys?id=' + encodeURIComponent(a.id));
        S.secrets[a.id] = { password: k.password || '', totpSecret: k.totpSecret || '' };
      } catch { /* карточка просто покажет честное «недоступен» */ }
    }
    if (need.length) render();
  }

  // ── Шапка ─────────────────────────────────────────────────────────────────

  function summaryHtml() {
    const t = S.totals;
    // Расход по веткам подписки считаем из тех же `usedOn`, что рисуют плашки на карточках:
    // в v1 он нулевой, но строка уже на месте - иначе её появление потом читалось бы как
    // новая сущность, а не как «вот эти записи».
    const uses = {};
    for (const a of S.accounts) for (const u of (a.usedOn || [])) uses[u.tag] = (uses[u.tag] || 0) + 1;
    const useStr = ['flow', 'antigravity'].map(tag => `${tag} ${uses[tag] || 0}`).join(' · ');
    const bits = [
      `аккаунтов <b>${t.total}</b>`,
      `живых <b>${S.byStatus.live || 0}</b>`,
      `с 2FA <b>${t.withTotp}</b>`,
      `со снимком сессии <b>${t.withSession}</b>`,
    ];
    if (t.openWindows) bits.push(`окон открыто <b>${t.openWindows}</b>`);
    return `${bits.join(' · ')} · записей о расходе: ${useStr}`;
  }

  function chipsHtml() {
    const all = `<button class="gg-chip ${S.statusFilter ? '' : 'gg-chip-on'}" onclick="GOOGLE.setFilter('')">все</button>`;
    const rest = (S.statuses.length ? S.statuses : ['unknown', 'live', 'dead', 'locked']).map(s => {
      const m = STATUS_META[s] || STATUS_META.unknown;
      const n = S.byStatus[s] || 0;
      return `<button class="gg-chip ${S.statusFilter === s ? 'gg-chip-on' : ''}" title="${esc(m.hint)}" onclick="GOOGLE.setFilter('${s}')">${esc(m.label)}${n ? ` · ${n}` : ''}</button>`;
    }).join('');
    // Вторая грядка - по классу аккаунта. У GitHub-вкладки так же две: статус и запись в
    // пулах; здесь вторая ось - личный против расходника, и её тоже видно счётчиком.
    const kall = `<button class="gg-chip ${S.kindFilter ? '' : 'gg-chip-on'}" onclick="GOOGLE.setKindFilter('')">все классы</button>`;
    const krest = (S.kinds.length ? S.kinds : ['personal', 'burner']).map(k => {
      const m = KIND_META[k] || KIND_META.burner;
      const n = S.byKind[k] || 0;
      return `<button class="gg-chip ${S.kindFilter === k ? 'gg-chip-on' : ''}" title="${esc(m.hint)}" onclick="GOOGLE.setKindFilter('${k}')">${esc(m.label)}${n ? ` · ${n}` : ''}</button>`;
    }).join('');
    return `<span class="gg-chips">${all}${rest}</span><span class="gg-chips">${kall}${krest}</span>`;
  }

  // Порядковый номер «в цепочке»: как у GitHub-вкладки, где он означает последовательность
  // покупки. Считаем по дате добавления, а не по порядку в файле: файл правят руками.
  function seqMap() {
    const sorted = [...S.accounts].filter(a => !a.broken)
      .sort((a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || '')) || String(a.id).localeCompare(String(b.id)));
    const m = {};
    sorted.forEach((a, i) => { m[a.id] = i + 1; });
    return m;
  }

  // Селектор прокси: адрес берётся ИЗ ПУЛА, вписать строку руками нельзя. В списке - метка
  // (без кредов), ярус и сколько аккаунтов на этот адрес уже село.
  //
  // 🪤 В списке только свои адреса: скрапленные под Google не годятся (решение владельца
  // 25.09). Привязка, которой в списке нет - скрапленная или пропавшая из пула, - остаётся
  // отдельным вариантом: молча сбросить её на «не привязан» значило бы потерять работу.
  function proxyOptions(selected) {
    const list = S.pool.proxies;
    if (!selected && !list.length) return `<option value="">${S.pool.skipped ? 'своих адресов нет (скрапленные не годятся)' : 'в пуле нет адресов'}</option>`;
    const head = `<option value="" ${selected ? '' : 'selected'}>- не привязан -</option>`;
    const body = list.map(p => {
      const marks = [p.tier, p.accounts ? `занят ${p.accounts}` : null, p.verdict === 'bad' ? 'не отвечает' : null]
        .filter(Boolean).join(' · ');
      return `<option value="${esc(p.id)}" ${String(selected) === String(p.id) ? 'selected' : ''}>${esc(p.label)}${marks ? ` (${esc(marks)})` : ''}</option>`;
    }).join('');
    const orphan = selected && !list.some(p => String(p.id) === String(selected))
      ? `<option value="${esc(selected)}" selected>${esc(selected)} - не годится под Google</option>` : '';
    return head + orphan + body;
  }

  function headerHtml() {
    return `<header class="gg-head">
      <div>
        <h1 class="gg-title">
          <span style="color:var(--color-azure)">🔵</span>
          <a href="https://accounts.google.com" target="_blank" rel="noopener">Google аккаунты</a>
        </h1>
        <p class="gg-sub">аккаунты под подписку AI Pro · строка магазина <code>почта:пароль:2FA-секрет</code> · 2FA-код считается локально (TOTP) · пул <code>google/accounts.json</code></p>
        <p class="gg-note">${summaryHtml()}</p>
      </div>
      <div class="gg-actions">
        ${chipsHtml()}
        <input id="gg-search" class="gg-search" placeholder="🔍 поиск по почте, нику, заметке…"
          value="${esc(S.search)}" oninput="GOOGLE.setSearch(this.value)">
        <button class="gg-btn" onclick="GOOGLE.load(true)" title="Перечитать пул">↻</button>
        <button class="gg-btn gg-btn-add" onclick="GOOGLE.openPanel('add')">➕ Добавить</button>
        <button class="gg-btn gg-btn-imp" onclick="GOOGLE.openPanel('import')">📥 Импорт</button>
      </div>
    </header>`;
  }

  // Предупреждение о пуле прокси. Под Google годятся только свои резидентские адреса,
  // скрапленные в список не попадают вообще, а хост может быть не в белом списке пула - и
  // про каждое из этого вкладка говорит вслух, а не показывает молча пустой селектор.
  function poolNoteHtml() {
    if (!S.pool.host) return '';
    const own = `в списке только свои адреса${S.pool.skipped ? `, скрапленных отсеяно ${S.pool.skipped}` : ''}`;
    if (!S.pool.total && !S.pool.skipped) return '<div class="gg-hint gg-hint-warn">Пул прокси пуст: привязывать нечего. Заведи адреса на вкладке «Свои прокси».</div>';
    if (!S.pool.total) return `<div class="gg-hint gg-hint-warn">Своих адресов в пуле нет (${S.pool.skipped} скрапленных отсеяно: под Google они не годятся). Добавь резидентский адрес на вкладке «Свои прокси».</div>`;
    if (!S.pool.enabled) {
      return `<div class="gg-hint gg-hint-warn">Пул прокси не обслуживает <code>${esc(S.pool.host)}</code>: хост не в его белом списке (${own}). Выбрать адрес можно, но в бою он на этот хост не пойдёт - сначала добавь хост в пул на вкладке «Свои прокси».</div>`;
    }
    return `<div class="gg-hint">Пул обслуживает <code>${esc(S.pool.host)}</code>, ${own}${S.pool.tiers.length ? ` (ярусы: ${esc(S.pool.tiers.join(', '))})` : ''}.</div>`;
  }

  // ── Панели: добавление и импорт ───────────────────────────────────────────

  const D = (k) => esc((S.draft || {})[k] || '');
  const draftAttr = (k) => `value="${D(k)}" oninput="GOOGLE.draft('${k}', this.value)"`;

  function addPanelHtml() {
    return `<div class="gg-panel gg-panel-add">
      <div class="gg-form">
        <label class="gg-lbl gg-wide">почта (@gmail.com)
          <input class="gg-in gg-in-mono" ${draftAttr('email')} placeholder="account@gmail.com">
        </label>
        <label class="gg-lbl">пароль
          <input class="gg-in gg-in-mono" ${draftAttr('password')} placeholder="как прислал магазин">
        </label>
        <label class="gg-lbl">2FA-секрет (если есть)
          <input class="gg-in gg-in-mono" ${draftAttr('totpSecret')} placeholder="JBSWY3DPEHPK3PXP…">
        </label>
        <label class="gg-lbl">пароль приложения (если есть)
          <input class="gg-in gg-in-mono" ${draftAttr('appPassword')} placeholder="cmsk dp4z keik kncq">
        </label>
        <label class="gg-lbl">телефон
          <input class="gg-in" ${draftAttr('phone')} placeholder="+7 …">
        </label>
        <label class="gg-lbl">почта восстановления
          <input class="gg-in gg-in-mono" ${draftAttr('recoveryEmail')} placeholder="reserve@mail.ru">
        </label>
        <label class="gg-lbl gg-wide">прокси (из пула)
          <select class="gg-in gg-in-mono" onchange="GOOGLE.draft('proxy', this.value)">${proxyOptions(D('proxy'))}</select>
        </label>
        <label class="gg-lbl">ник для карточки
          <input class="gg-in" ${draftAttr('nickname')} placeholder="пусто - возьмём из адреса">
        </label>
        <label class="gg-lbl">класс
          <select class="gg-in" onchange="GOOGLE.draft('kind', this.value)">
            <option value="burner" ${D('kind') === 'burner' || !D('kind') ? 'selected' : ''}>расходник</option>
            <option value="personal" ${D('kind') === 'personal' ? 'selected' : ''}>личный</option>
          </select>
        </label>
        <label class="gg-lbl gg-wide">заметка
          <input class="gg-in" ${draftAttr('note')} placeholder="у кого куплен, что шло в комплекте">
        </label>
      </div>
      ${S.addErr ? `<div class="gg-hint gg-hint-bad">${esc(S.addErr)}</div>` : ''}
      <div class="gg-hint">Пароль остаётся в пуле на диске и <b>не показывается в списке</b>: карточка получает его отдельным запросом по нажатию глаза. Он нужен, чтобы подставить его в окне входа.</div>
      <div class="gg-form-foot">
        <button class="gg-btn gg-btn-add" onclick="GOOGLE.submitAdd()">Сохранить</button>
        <button class="gg-btn" onclick="GOOGLE.closePanel()">Отмена</button>
      </div>
    </div>`;
  }

  function importPanelHtml() {
    const p = S.preview;
    const preview = !p ? '<div class="gg-preview">Вставь письмо-чек целиком и нажми «Проверить»: покажу, что разобралось, что пошло ошибкой и что уже есть в пуле.</div>'
      : `<div class="gg-preview">
          <div class="gg-hint-ok">разобрано записей: ${p.parsed}</div>
          ${p.duplicates.length ? `<div class="gg-hint-warn">дубли (в пуле или в этой же пачке): ${p.duplicates.length}</div>` : ''}
          ${p.errors.length ? `<div class="gg-hint-bad">строк с ошибкой: ${p.errors.length}</div>
            <ul>${p.errors.slice(0, 8).map(e => `<li>строка ${e.line}: ${esc(e.error)}</li>`).join('')}</ul>` : ''}
          ${p.sample.length ? `<div>к записи пойдёт:</div>
            <ul>${p.sample.map(e => `<li><code>${esc(e.email)}</code>${e.hasTotp ? ' · 2FA ✓' : ' · без 2FA'}${e.recoveryEmail ? ' · восстановление' : ''}</li>`).join('')}</ul>
            ${p.parsed > p.sample.length ? `<div>…и ещё ${p.parsed - p.sample.length}</div>` : ''}` : ''}
          <div>Ошибки в пул не попадают: запись произойдёт по кнопке «Импортировать».</div>
        </div>`;
    return `<div class="gg-panel gg-panel-imp">
      <div class="gg-hint">Строки вида <code>почта:пароль</code>, <code>почта:пароль:2FA-секрет</code> или
        <code>почта:пароль:почта-восстановления:секрет</code> - порядок хвоста любой, разделитель
        <code>:</code>, <code>|</code>, <code>;</code> или таб. Строки чека без адреса (реклама, рамки, ссылки)
        пропускаются как шум.</div>
      <div class="gg-imp-grid">
        <textarea id="gg-imp-text" class="gg-area" placeholder="вставь сюда письмо-чек магазина целиком"
          oninput="GOOGLE.setImpText(this.value)">${esc(S.impText || '')}</textarea>
        ${preview}
      </div>
      <div class="gg-form-foot">
        <button class="gg-btn gg-btn-imp" ${p && p.parsed ? '' : 'disabled'} onclick="GOOGLE.commitImport()">Импортировать${p && p.parsed ? ` ${p.parsed}` : ''}</button>
        <button class="gg-btn" onclick="GOOGLE.runDry()">Проверить</button>
        <button class="gg-btn" onclick="GOOGLE.closePanel()">Отмена</button>
      </div>
    </div>`;
  }

  // ── Карточка ──────────────────────────────────────────────────────────────

  function usesBadges(a) {
    const uses = Array.isArray(a.usedOn) ? a.usedOn : [];
    // Пустая грядка не исчезает, а говорит словами: у GitHub на этом месте стоят метки пулов,
    // и «пусто» там читается как «нигде не занят». Молчание в v1 выглядело бы как недоделка.
    if (!uses.length) return '<div class="gg-badges" title="Записей о расходе нет: ветки подписки (Flow, Antigravity) ещё не подключены"><span class="gg-tag">нигде не занят</span></div>';
    return `<div class="gg-badges" title="Где этот аккаунт уже израсходован">${uses
      .map(u => `<span class="${USE_TAGS[u.tag] || 'gg-tag'}">${esc(u.tag || '?')}</span>`).join('')}</div>`;
  }

  // Пароль приложения (16 знаков) - отдельный хвост строки магазина, его вводят в почтовый
  // клиент руками. Показывается только если он в записи есть: у большинства аккаунтов его нет.
  function appPassBlock(a) {
    if (!a.hasAppPassword) return '';
    const rev = !!S.revealApp[a.id];
    const val = (S.secrets[a.id] || {}).appPassword;
    return `<div class="gg-field">
      <div class="gg-label">Пароль приложения</div>
      <div class="gg-row">
        <span class="gg-val">${val ? (rev ? esc(val) : '•••• •••• •••• ••••') : 'скрыт до запроса'}</span>
        <span style="display:flex">
          <button class="gg-ico" title="Показать/скрыть пароль приложения" onclick="GOOGLE.toggleApp('${esc(a.id)}')">${rev ? '🙈' : '👁'}</button>
          <button class="gg-ico" title="Скопировать пароль приложения" onclick="GOOGLE.copyApp('${esc(a.id)}')">📋</button>
        </span>
      </div>
    </div>`;
  }

  function totpBlock(a) {
    if (!a.hasTotp) {
      return `<div class="gg-totp">
        <div class="gg-label">2FA-код</div>
        <div class="gg-code-none">секрета нет, код из телефона</div>
      </div>`;
    }
    const secret = (S.secrets[a.id] || {}).totpSecret;
    if (!secret) {
      return `<div class="gg-totp">
        <div class="gg-label">2FA-код</div>
        <div class="gg-code-none">секрет не получен с сервера</div>
      </div>`;
    }
    // 🪤 Проверяем защищённый контекст ЗДЕСЬ, а не выводим из пустого кода: иначе любая
    // заминка выдавала бы себя за отсутствие crypto.
    if (!(window.crypto && window.crypto.subtle)) {
      return `<div class="gg-totp">
        <div class="gg-label">2FA-код</div>
        <div class="gg-code-none">браузер не даёт считать код: нужен защищённый контекст - открой дашборд по localhost, а не по LAN-адресу</div>
      </div>`;
    }
    const secs = secsOf();
    const code = codeOf(a.id);
    if (!code) {
      const pending = !codeFailed(a.id);
      // Считаем прямо при отрисовке, а не ждём секундного тика: иначе карточка мигает
      // пустотой до первого тика, а он ещё и не найдёт, что заполнять.
      if (pending) ensureCode(a).then(() => { if (!S.menuOpen && codeOf(a.id)) render(); });
      return `<div class="gg-totp">
        <div class="gg-row">
          <span class="gg-label">2FA-код</span>
          <span class="gg-secs">${secs}s</span>
        </div>
        ${pending
          ? '<span class="gg-code gg-code-none">считаю…</span>'
          : '<span class="gg-code-none">код не считается: секрет не разбирается как base32</span>'}
      </div>`;
    }
    const cls = secs <= 3 ? 'gg-code gg-code-crit' : secs <= 10 ? 'gg-code gg-code-warn' : 'gg-code';
    const fill = secs <= 3 ? 'gg-fill gg-fill-crit' : secs <= 10 ? 'gg-fill gg-fill-warn' : 'gg-fill';
    return `<div class="gg-totp">
      <div class="gg-row">
        <span class="gg-label">2FA-код</span>
        <button class="gg-ico" title="Скопировать 2FA-код" onclick="GOOGLE.copyCode('${esc(a.id)}')">📋</button>
      </div>
      <div class="gg-row">
        <span class="${cls}">${code.slice(0, 3)}&nbsp;${code.slice(3)}</span>
        <span class="gg-secs">${secs}s</span>
      </div>
      <div class="gg-track"><div class="${fill}" style="width:${(secs / 30) * 100}%"></div></div>
    </div>`;
  }

  function cardHtml(a) {
    if (a.broken) {
      return `<div class="gg-card gg-card-broken"><div class="gg-bar gg-bar-dead"></div>
        <div class="gg-body">
          <div class="gg-name">${esc(a.email || 'запись без адреса')}</div>
          <div class="gg-hint gg-hint-bad">запись не читается: ${esc(a.broken)}</div>
          <div class="gg-hint">Пул не перезаписывается поверх битой записи - почини файл руками или восстанови из снимка.</div>
        </div></div>`;
    }
    const st = STATUS_META[a.status] || STATUS_META.unknown;
    const kd = KIND_META[a.kind] || KIND_META.burner;
    const rev = !!S.reveal[a.id];
    const sec = S.secrets[a.id] || {};
    const passShown = rev && sec.password ? esc(sec.password) : '••••••••';
    const sess = a.sessionFileAt ? `снимок ${ago(a.sessionFileAt) || fmtDate(a.sessionFileAt)}` : 'сессии нет';
    return `<div class="gg-card ${S.menuOpen === a.id ? 'gg-card-open' : ''}" data-gg-id="${esc(a.id)}">
      <div class="gg-bar ${st.bar}"></div>
      ${S.menuOpen === a.id ? menuHtml(a) : ''}
      <div class="gg-body">
        <div class="gg-top">
          <div class="gg-ava gg-ava-${esc(a.status || 'unknown')}">🔵</div>
          <div class="gg-id">
            <div class="gg-name" title="${esc(a.nickname)}">${esc(a.nickname || '—')}</div>
            <div class="gg-mail" title="${esc(a.email)}">${esc(a.email)}</div>
          </div>
        </div>
        <div class="gg-badges">
          <span class="${st.cls}" title="${esc(st.hint)}">${esc(st.label)}</span>
          <span class="${kd.cls}" title="${esc(kd.hint)}">${esc(kd.label)}</span>
          <span class="gg-tag" title="${a.sessionFileAt ? 'Снимок storageState: по нему видно, что вход был' : 'Снимка нет: аккаунт ещё не входили через вкладку'}">${esc(sess)}</span>
          ${a.hasProfile
            ? '<span class="gg-tag" title="Профиль браузера на диске: вход в него переживает рестарт">профиль есть</span>'
            : '<span class="gg-tag" title="Профиля ещё нет - открой сессию один раз">профиля нет</span>'}
          ${a.openPid ? `<span class="gg-tag gg-tag-warn" title="Окно профиля сейчас открыто (pid ${a.openPid})">окно открыто</span>` : ''}
        </div>
        <div class="gg-meta">
          <span title="Порядок добавления в пул (последовательность покупки)">№${seqMap()[a.id] || '—'} в цепочке</span>
          <span>добавлен ${fmtDate(a.addedAt)}</span>
        </div>
        ${usesBadges(a)}
        <div class="gg-field">
          <div class="gg-label">Логин</div>
          <div class="gg-row">
            <span class="gg-val" title="${esc(a.email)}">${esc(a.email)}</span>
            <button class="gg-ico" title="Скопировать логин" onclick="GOOGLE.copyLogin('${esc(a.id)}')">📋</button>
          </div>
        </div>
        <div class="gg-field">
          <div class="gg-label">Пароль</div>
          <div class="gg-row">
            <span class="gg-val">${a.hasPassword ? passShown : '<span class="gg-code-none">пароля в записи нет</span>'}</span>
            <span style="display:flex">
              <button class="gg-ico" title="Показать/скрыть пароль" onclick="GOOGLE.togglePass('${esc(a.id)}')">${rev ? '🙈' : '👁'}</button>
              <button class="gg-ico" title="Скопировать пароль" onclick="GOOGLE.copyPass('${esc(a.id)}')">📋</button>
            </span>
          </div>
        </div>
        ${totpBlock(a)}
        ${appPassBlock(a)}
        ${a.phone ? `<div class="gg-field">
          <div class="gg-label">Телефон</div>
          <div class="gg-row">
            <span class="gg-val">${esc(a.phone)}</span>
            <button class="gg-ico" title="Скопировать телефон" onclick="GOOGLE.copyPhone('${esc(a.id)}')">📋</button>
          </div>
        </div>` : ''}
        ${a.recoveryEmail ? `<div class="gg-field">
          <div class="gg-label">Почта восстановления</div>
          <div class="gg-row">
            <span class="gg-val" title="${esc(a.recoveryEmail)}">${esc(a.recoveryEmail)}</span>
            <button class="gg-ico" title="Скопировать почту восстановления" onclick="GOOGLE.copyRecovery('${esc(a.id)}')">📋</button>
          </div>
        </div>` : ''}
        <div class="gg-field">
          <div class="gg-label">Прокси</div>
          <div class="gg-row">
            <select class="gg-in gg-in-sm gg-in-mono" title="Адрес берётся из пула прокси. Под Google годятся резидентские: датацентровые он режет челленджем"
              onchange="GOOGLE.setProxy('${esc(a.id)}', this.value)">${proxyOptions(a.proxy)}</select>
          </div>
        </div>
        ${a.note ? `<div class="gg-hint">${esc(a.note)}</div>` : ''}
        <div class="gg-spacer"></div>
        <div class="gg-foot">
          <button class="gg-btn gg-btn-go" title="Открыть браузер с профилем этого аккаунта на странице входа Google" onclick="GOOGLE.openSession('${esc(a.id)}')">Открыть сессию</button>
          <button class="gg-btn gg-btn-square" title="Действия (статус, класс, пароль, заметка, удалить)" onclick="GOOGLE.menu('${esc(a.id)}')">⋯</button>
        </div>
      </div>
    </div>`;
  }

  function menuHtml(a) {
    const s = (v, label) => `<button class="${a.status === v ? 'gg-menu-on' : ''}" onclick="GOOGLE.setStatus('${esc(a.id)}','${v}')">${label}</button>`;
    const k = (v, label) => `<button class="${a.kind === v ? 'gg-menu-on' : ''}" onclick="GOOGLE.setKind('${esc(a.id)}','${v}')">${label}</button>`;
    return `<div class="gg-menu">
      ${s('live', '✓ живой')}${s('dead', '✗ мёртвый')}${s('locked', '⛔ залочен')}${s('unknown', '~ не проверен')}
      <div class="gg-sep"></div>
      ${k('personal', 'личный')}${k('burner', 'расходник')}
      <div class="gg-sep"></div>
      <button onclick="GOOGLE.togglePass('${esc(a.id)}')">👁 показать пароль</button>
      <button onclick="GOOGLE.copyAll('${esc(a.id)}')">📋 копировать строку целиком</button>
      <button onclick="GOOGLE.askNote('${esc(a.id)}')">✎ заметка</button>
      <div class="gg-sep"></div>
      <button class="gg-menu-crit" onclick="GOOGLE.del('${esc(a.id)}')">🗑 Удалить (профиль и снимок тоже)</button>
    </div>`;
  }

  function filtered() {
    const q = S.search.trim().toLowerCase();
    return S.accounts.filter(a => {
      if (S.statusFilter && a.status !== S.statusFilter) return false;
      if (S.kindFilter && a.kind !== S.kindFilter) return false;
      if (!q) return true;
      const hay = [a.email, a.nickname, a.note, a.recoveryEmail, a.proxy].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function render() {
    const root = $('google-root');
    if (!root) return;
    // 🪤 Поле поиска перерисовывается вместе с разметкой, а вместе с ним теряется фокус и
    // каретка: набор в поиске обрывался бы после первой же буквы. Запоминаем и возвращаем.
    const active = document.activeElement;
    const wasSearch = !!(active && active.id === 'gg-search');
    const caret = wasSearch ? active.selectionStart : null;
    const list = filtered();
    const alert = S.err ? `<div class="gg-alert">
        <span>пул не читается: ${esc(S.err)}</span>
        <button class="gg-btn" onclick="GOOGLE.load(true)">↻ повторить</button>
      </div>` : '';
    const empty = !S.loadedOnce && !S.err ? '<div class="gg-empty">читаю пул…</div>'
      : list.length ? list.map(cardHtml).join('')
      : `<div class="gg-empty">${S.accounts.length ? 'под фильтр ничего не подошло' : 'пул пуст. Заведи аккаунт кнопкой «Добавить» или вставь пачку чеков через «Импорт»'}</div>`;
    root.innerHTML = `<div class="gg-wrap">
      ${headerHtml()}
      ${alert}
      ${poolNoteHtml()}
      ${S.panel === 'add' ? addPanelHtml() : ''}
      ${S.panel === 'import' ? importPanelHtml() : ''}
      <div class="gg-grid">${empty}</div>
      <div class="gg-note">
        <span>2FA-код считается прямо в браузере из секрета (base32 + HMAC-SHA1, RFC 6238)</span>
        <span class="gg-sep-inline">·</span>
        <span>статус ставит человек: <span class="gg-hint-ok">живой</span> / <span class="gg-hint-warn">залочен</span> / <span class="gg-hint-bad">мёртвый</span> / не проверен</span>
        <span class="gg-sep-inline">·</span>
        <span>профиль браузера на аккаунт и снимок сессии лежат в <code>google/</code>, в git не едут</span>
      </div>
    </div>`;
    // Цифра в сайдбаре: живых из всего, как у вкладки Outlook. `unknown` в неё не идёт -
    // он не значит «живой».
    const nav = $('nav-count-google');
    if (nav) nav.textContent = S.totals.total ? `${S.byStatus.live || 0}/${S.totals.total}` : '—';
    if (wasSearch) {
      const el = $('gg-search');
      if (el) {
        el.focus();
        try { el.setSelectionRange(caret, caret); } catch { /* не критично */ }
      }
    }
  }

  // ── Действия ──────────────────────────────────────────────────────────────

  function find(id) { return S.accounts.find(a => String(a.id) === String(id)) || null; }

  async function ensureSecret(id) {
    if (S.secrets[id] && S.secrets[id].password) return S.secrets[id];
    const k = await api('keys?id=' + encodeURIComponent(id));
    S.secrets[id] = {
      password: k.password || '',
      totpSecret: k.totpSecret || '',
      appPassword: k.appPassword || '',
    };
    return S.secrets[id];
  }

  const GOOGLE = {
    load,
    refresh() { return load(); },

    setSearch(v) { S.search = v; render(); },
    setFilter(v) { S.statusFilter = v; render(); },
    setKindFilter(v) { S.kindFilter = v; render(); },
    menu(id) { S.menuOpen = S.menuOpen === id ? null : id; render(); },

    openPanel(which) {
      S.panel = S.panel === which ? null : which;
      S.preview = null;
      S.addErr = null;
      render();
    },
    closePanel() { S.panel = null; S.preview = null; S.addErr = null; S.impText = ''; S.draft = {}; render(); },
    draft(k, v) { S.draft[k] = v; },
    setImpText(v) { S.impText = v; },

    async togglePass(id) {
      try {
        if (!S.reveal[id]) await ensureSecret(id);
        S.reveal[id] = !S.reveal[id];
        S.menuOpen = null;
        render();
      } catch (e) { toast(`пароль не получить: ${e.message}`, 'bad'); }
    },

    async toggleApp(id) {
      try {
        if (!S.revealApp[id]) await ensureSecret(id);
        S.revealApp[id] = !S.revealApp[id];
        S.menuOpen = null;
        render();
      } catch (e) { toast(`пароль приложения не получить: ${e.message}`, 'bad'); }
    },

    async copyApp(id) {
      try {
        const s = await ensureSecret(id);
        if (!s.appPassword) return toast('пароля приложения в записи нет', 'bad');
        await copyText(s.appPassword, 'пароль приложения');
      } catch (e) { toast(`не получить: ${e.message}`, 'bad'); }
    },

    async copyLogin(id) { const a = find(id); await copyText(a && a.email, 'логин'); },
    async copyPhone(id) { const a = find(id); await copyText(a && a.phone, 'телефон'); },
    async copyRecovery(id) { const a = find(id); await copyText(a && a.recoveryEmail, 'почта восстановления'); },

    async copyPass(id) {
      try { const s = await ensureSecret(id); await copyText(s.password, 'пароль'); }
      catch (e) { toast(`пароль не получить: ${e.message}`, 'bad'); }
    },

    async copyCode(id) {
      const a = find(id);
      const c = a && await ensureCode(a);
      if (!c) return toast('код не считается', 'bad');
      await copyText(c.code, 'код 2FA');
    },

    async copyAll(id) {
      try {
        const a = find(id);
        const s = await ensureSecret(id);
        const parts = [a.email, s.password];
        if (s.totpSecret) parts.push(s.totpSecret);
        if (a.recoveryEmail) parts.push(a.recoveryEmail);
        if (s.appPassword) parts.push(s.appPassword);
        await copyText(parts.join(':'), 'строка аккаунта');
      } catch (e) { toast(`не собрать строку: ${e.message}`, 'bad'); }
    },

    async setStatus(id, status) {
      S.menuOpen = null;
      try { await post('update', { id, patch: { status } }); toast('статус обновлён', 'ok'); await load(); }
      catch (e) { toast(e.message, 'bad'); }
    },

    async setKind(id, kind) {
      S.menuOpen = null;
      try { await post('update', { id, patch: { kind } }); toast('класс обновлён', 'ok'); await load(); }
      catch (e) { toast(e.message, 'bad'); }
    },

    async askNote(id) {
      S.menuOpen = null;
      const a = find(id);
      const note = prompt('Заметка по аккаунту', (a && a.note) || '');
      if (note === null) return render();
      try { await post('update', { id, patch: { note } }); await load(); }
      catch (e) { toast(e.message, 'bad'); }
    },

    async setProxy(id, proxyId) {
      try {
        await post('update', { id, patch: { proxy: proxyId || '' } });
        toast(proxyId ? 'прокси привязан' : 'привязка снята', 'ok');
        await load();
      } catch (e) { toast(e.message, 'bad'); await load(); }
    },

    async openSession(id) {
      try {
        const r = await post('open', { id });
        toast(r.already ? `окно уже открыто (pid ${r.pid})` : `окно поднимается: ${r.label} (pid ${r.pid})`, 'ok');
        setTimeout(() => load(), 2500);
      } catch (e) { toast(`окно не открылось: ${e.message}`, 'bad'); }
    },

    async del(id) {
      S.menuOpen = null;
      const a = find(id);
      if (!confirm(`Удалить аккаунт ${a ? a.email : id}?\n\nВместе с записью сносятся профиль браузера и снимок сессии. Отменить будет нечем - только резервная копия папки google/.`)) return render();
      try { await post('delete', { id }); toast('аккаунт удалён', 'ok'); await load(); }
      catch (e) { toast(e.message, 'bad'); }
    },

    async submitAdd() {
      const d = S.draft || {};
      if (!d.email || !d.password) { S.addErr = 'нужны и адрес, и пароль: без пары в профиль не войти'; return render(); }
      try {
        await post('add', {
          email: d.email, password: d.password, totpSecret: d.totpSecret || '',
          appPassword: d.appPassword || '',
          phone: d.phone || '', recoveryEmail: d.recoveryEmail || '', proxy: d.proxy || '',
          nickname: d.nickname || '', kind: d.kind || 'burner', note: d.note || '',
        });
        S.panel = null; S.draft = {}; S.addErr = null;
        toast('аккаунт заведён', 'ok');
        await load();
      } catch (e) { S.addErr = e.message; render(); }
    },

    async runDry() {
      const text = ($('gg-imp-text') || {}).value || S.impText || '';
      S.impText = text;
      try { S.preview = await post('import', { text, dryRun: true }); }
      catch (e) { S.preview = null; toast(e.message, 'bad'); }
      render();
    },

    async commitImport() {
      const text = ($('gg-imp-text') || {}).value || S.impText || '';
      S.impText = text;
      try {
        const r = await post('import', { text });
        S.panel = null; S.preview = null; S.impText = '';
        toast(`записано ${r.added.length}${r.duplicates.length ? `, дублей пропущено ${r.duplicates.length}` : ''}`, 'ok');
        await load();
      } catch (e) { toast(e.message, 'bad'); }
    },
  };

  window.GOOGLE = GOOGLE;

  // ── Тик и опрос ───────────────────────────────────────────────────────────
  // Опрос раз в 15 секунд: список без секретов, стоит дёшево. Тик раз в секунду двигает
  // счётчик, полосу и сам код - точечно, по узлам. Перерисовывать карточку целиком каждую
  // секунду нельзя: это выбивает выделение текста (а его тут копируют) и закрывает меню.
  function startTimers() {
    if (S.pollTimer) return;
    S.pollTimer = setInterval(() => load(), POLL_MS);
    S.tickTimer = setInterval(async () => {
      if (document.hidden) return;
      const root = $('google-root');
      // `offsetParent` пуст, когда вкладка не показана: тикать в фоне незачем.
      if (!root || !root.offsetParent) return;
      const secs = secondsLeft();
      for (const a of S.accounts) {
        if (!a.hasTotp) continue;
        const card = root.querySelector(`[data-gg-id="${a.id}"]`);
        if (!card) continue;
        const codeEl = card.querySelector('.gg-code');
        if (!codeEl) continue;
        // Окно сменилось - пересчитываем код, но только раз на окно (кеш по номеру окна).
        if (!codeCache(a.id)) { try { await ensureCode(a); } catch { /* покажем прошлый */ } }
        const code = codeOf(a.id);
        if (code) codeEl.innerHTML = `${code.slice(0, 3)}&nbsp;${code.slice(3)}`;
        codeEl.className = 'gg-code' + (secs <= 3 ? ' gg-code-crit' : secs <= 10 ? ' gg-code-warn' : '');
        const secEl = card.querySelector('.gg-secs');
        if (secEl) secEl.textContent = `${secs}s`;
        const fillEl = card.querySelector('.gg-fill');
        if (fillEl) {
          fillEl.style.width = `${(secs / 30) * 100}%`;
          fillEl.className = 'gg-fill' + (secs <= 3 ? ' gg-fill-crit' : secs <= 10 ? ' gg-fill-warn' : '');
        }
      }
    }, 1000);
  }

  // 🪤 Загрузку НЕ запускаем сами: скрипт подключён в конце body, и автостарт тянул бы
  // пул даже у того, кто вкладку не открывал. Первый `load()` делает шов вкладки
  // (`showTab`), дальше таймеры идут сами.
  GOOGLE.start = startTimers;
})();
