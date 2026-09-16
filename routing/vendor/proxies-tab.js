/* ════════════════════════════════════════════════════════════════════════════
   proxies-tab.js — вкладка «СВОИ ПРОКСИ» дашборда ABUSE HUB (:8200)
   Неймспейс: window.PROXIES. Точка входа: PROXIES.load().

   Зачем вкладка. Пул прокси (`routing/lib/proxy-pool.js`) раскидывает аккаунты по
   прокси ЛИПКО: у аккаунта с живой сессией адрес НЕ меняется, иначе антифрод панели
   замечает смену IP раньше, чем мы получим чек баланса. Раскладка считается по паре
   «прокси × хост» (`maxPerHost`), потому что лимит у каждой панели свой, а WAF
   agentrouter бьёт по IP. Здесь владелец видит эту раскладку и правит её руками.

   🔴 Пароли сюда НЕ приходят и отсюда НЕ уходят. У своих прокси есть логин с паролем
   (SOCKS5 из XGATE), и сервер отдаёт только `label`/`id`, которые кредов не содержат.
   Практическое следствие для формы: textarea НЕЛЬЗЯ предзаполнять сохранённым списком.
   `label` не восстанавливается в строку с паролем, и повторное сохранение из textarea
   молча стёрло бы авторизацию у всех прокси. Поэтому textarea всегда пустая и означает
   «ЗАМЕНИТЬ список целиком», а сохранённое показывается таблицей ниже.

   🪤 Ребаланс двигает привязки ЖИВЫХ аккаунтов. Поэтому кнопка сначала показывает план
   (dryRun), и только отдельной кнопкой он применяется. Кнопки «сделать сразу» здесь нет
   намеренно: смена IP у аккаунта дороже, чем перекос нагрузки.

   🔴 Разметка рисуется из JS, поэтому Tailwind-утилит здесь быть не должно: сборка
   Tailwind сканирует только статический HTML, классов из шаблонных строк в ней нет, и
   вкладка отрисовалась бы голым текстом. Вся форма — в /vendor/proxies-tab.css, классы
   `px-*`, ровно как `md-*` у вкладок «Модели» и «MEDIA».

   Регресс логики пула — tools/check-proxy-mapping.js.
   ════════════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const API = '/__switch/api/proxies/';
  const POLL_MS = 15000;

  const S = {
    data: null,
    loading: false,
    err: null,
    notice: null,            // { kind: 'ok'|'err', text }
    plan: null,              // план ребаланса (dryRun) — показывается до применения
    timer: null,
    saving: false,
    checking: false,
  };

  // ── Утилиты ───────────────────────────────────────────────────────────────

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  async function api(path, opts) {
    const res = await fetch(API + path, opts);
    const text = await res.text();
    let doc = null;
    try { doc = JSON.parse(text); } catch { /* не JSON */ }
    if (!res.ok) {
      // 🪤 503 здесь означает не «сломался дашборд», а «модуль вкладки ещё не поднят».
      // Текст сервера несёт причину — показываем её, а не общее «ошибка».
      throw new Error((doc && doc.error) || `HTTP ${res.status}`);
    }
    return doc || {};
  }

  const post = (path, body) => api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  function setNotice(kind, text) { S.notice = text ? { kind, text } : null; }

  // Обновление баннера БЕЗ перерисовки вкладки.
  //
  // 🔴 Нужно там, где во вкладке есть несохранённый пользовательский ввод: render()
  // пересобирает разметку из состояния сервера и стирает набранное. Так терялась бы
  // строка, только что добавленная в textarea полями.
  function updateNotice(kind, text) {
    S.notice = text ? { kind, text } : null;
    const el = document.getElementById('px-notice');
    if (!el) return;
    el.className = text
      ? `px-notice ${kind === 'err' ? 'px-notice-err' : 'px-notice-ok'}`
      : 'px-notice px-notice-ok';
    el.style.display = text ? '' : 'none';
    el.textContent = text || '';
  }

  // ── Загрузка ──────────────────────────────────────────────────────────────

  async function load({ silent = false } = {}) {
    if (S.loading) return;
    S.loading = true;
    if (!silent) { S.err = null; render(); }
    // 🪤 Флаг, а не `return`: `render()` живёт в `finally`, и ранний выход его НЕ
    // пропускает - `finally` выполняется всегда. Без флага защита была бы мёртвой.
    let skipRender = false;
    try {
      S.data = await api('state');
      // 🪤 Ответ может прийти 200-м и быть не тем, что мы ждём: ручку отдаёт модуль,
      // который правят параллельно, и «200 без полей» здесь реальнее, чем кажется.
      // Без этой проверки render() падает на `d.own.length`, и вкладка умирает целиком -
      // вместо внятного «сервер ответил не тем».
      if (!S.data || !Array.isArray(S.data.own) || !S.data.counts) {
        throw new Error('сервер ответил не тем: в ответе нет ни своих прокси, ни счётчиков');
      }
      S.err = null;
      // 🪤 Пересобираем вкладку ТОЛЬКО когда данные правда изменились.
      //
      // Раньше каждый опрос (15 с) заканчивался полной пересборкой: 1368 узлов, 32 КБ
      // разметки. На этом дашборде Tailwind собирается в браузере и следит за DOM, то
      // есть лишняя пересборка - это лишний пересмотр всей огромной страницы. Замер:
      // сам рендер 1 мс, но платит не он, а наблюдатель за мутациями.
      //
      // 🪤 `updatedAt` из подписи выкидываем: `state()` ставит туда текущее время, и
      // сравнение с ним не совпало бы НИКОГДА - то есть защиты не было бы вовсе.
      const { updatedAt, ...stable } = S.data;
      const sig = JSON.stringify(stable);
      const unchanged = S.sig === sig;
      S.sig = sig;
      // Счётчик в навигации обновляем всегда - он и есть дешёвая часть.
      const badge = document.getElementById('nav-count-proxies');
      if (badge && S.data.counts) badge.textContent = String(S.data.counts.own);
      if (silent && unchanged) skipRender = true;
    } catch (e) {
      S.err = e.message || String(e);
      // 🪤 Снимок обнуляем ЯВНО. Иначе при ошибке чтения render пойдёт по данным с
      // прошлого раза, и они будут показаны как текущие - владелец станет править
      // раскладку по цифрам, которые уже неверны. Ошибка важнее устаревшей картинки.
      S.data = null;
    } finally {
      S.loading = false;
      if (!skipRender) render();
    }
  }

  // Поллинг только пока вкладка ВИДИМА: иначе фоновая вкладка будет дёргать state на
  // каждом тике, а состояние читает файлы привязок с диска.
  function startPoll() {
    if (S.timer) return;
    S.timer = setInterval(() => {
      const panel = document.querySelector('[data-tab-content="proxies"]');
      if (!panel || !panel.classList.contains('active')) return;
      if (document.hidden) return;
      load({ silent: true });
    }, POLL_MS);
  }

  // ── Действия ──────────────────────────────────────────────────────────────

  async function saveOwn() {
    const ta = document.getElementById('px-own-text');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) {
      setNotice('err', 'Список пуст. Сохранение стёрло бы свои прокси и осиротило привязки — вставьте строки.');
      render();
      return;
    }
    S.saving = true; setNotice(null, null); render();
    try {
      const r = await post('own', { text });
      const parts = [`принято ${r.saved}`];
      if (r.bad && r.bad.length) parts.push(`не разобрано ${r.bad.length}`);
      setNotice('ok', parts.join(', ') + '. ' + (r.warning || ''));
      // 🪤 Поле чистим ДО перерисовки, а не после: render() пересобирает вкладку из
      // состояния сервера, и очистка «после» уже ни на что не влияла бы - строка
      // возвращалась бы на место. Список уже принят, держать его в поле незачем.
      ta.value = '';
      await load({ silent: true });
    } catch (e) {
      setNotice('err', e.message || String(e));
    } finally {
      S.saving = false; render();
    }
  }

  async function checkOwn() {
    S.checking = true; setNotice('ok', 'проверяю свои прокси...'); render();
    try {
      const r = await post('check', {});
      const results = r.results || [];
      const ok = results.filter(x => x.ok).length;
      // 🪤 404 в результатах — это про ДВИЖОК панели, а не про прокси: у sub2api-панелей
      // нет `/api/status`, и живой прокси выглядел бы мёртвым. Говорим об этом прямо.
      const wrong404 = results.some(x => x.status === 404);
      setNotice(wrong404 ? 'err' : 'ok',
        `проверено ${results.length}, живых ${ok}`
        + (wrong404 ? ' · есть 404: путь проверки не от этой панели, см. подсказку' : ''));
      S.checks = results;
      await load({ silent: true });
    } catch (e) {
      setNotice('err', e.message || String(e));
    } finally {
      S.checking = false; render();
    }
  }

  async function planRebalance() {
    setNotice(null, null);
    try {
      const r = await post('rebalance', { dryRun: true });
      S.plan = r;
      setNotice('ok', `план: перемещений ${(r.moves || []).length}, пропущено ${(r.skipped || []).length}. Ничего пока не изменено.`);
    } catch (e) {
      S.plan = null; setNotice('err', e.message || String(e));
    }
    render();
  }

  async function applyRebalance() {
    if (!S.plan || !(S.plan.moves || []).length) return;
    try {
      const r = await post('rebalance', { dryRun: false });
      setNotice(r.errors && r.errors.length ? 'err' : 'ok',
        `применено ${r.applied}${r.errors && r.errors.length ? `, ошибок ${r.errors.length}` : ''}`);
      S.plan = null;
      await load({ silent: true });
    } catch (e) {
      setNotice('err', e.message || String(e));
      render();
    }
  }

  async function releaseKey(key) {
    try {
      await post('assign', { key, release: true });
      setNotice('ok', `привязка ${key} снята`);
      await load({ silent: true });
    } catch (e) { setNotice('err', e.message || String(e)); render(); }
  }

  // ── Ручной ввод по полям ──────────────────────────────────────────────────
  //
  // Зачем рядом с textarea: продавцы присылают креды ВРАЗНОБОЙ - то строкой
  // `ip:port:login:pass`, то адрес отдельным сообщением, а логин с паролем третьим.
  // Пароль при этом надо куда-то вписать, и просить владельца склеивать URL руками
  // значит терять пароли по дороге. Поля собирают строку сами, экранируя пароль.
  //
  // 🪤 Пароль НЕ показываем и не сохраняем во вкладке: после «Добавить» поле очищается.
  // Так он не окажется ни в разметке, ни в памяти браузера, ни в скриншоте вкладки.

  function openInlineForm() {
    S.showForm = !S.showForm;
    render();
  }

  function addFromFields() {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const scheme = val('px-f-scheme') || 'socks5';
    const host = val('px-f-addr').trim();
    const port = val('px-f-port').trim();
    const user = val('px-f-user').trim();
    const pass = val('px-f-pass');

    if (!host) { setNotice('err', 'Адрес не заполнен.'); render(); return; }
    // Порт можно вписать в адрес (`1.2.3.4:1080`) - продавцы часто дают так.
    const both = /^(.+):(\d{1,5})$/.exec(host);
    const p = Number(both ? both[2] : port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      setNotice('err', 'Не понял порт. Укажи его отдельным полем или допиши к адресу через двоеточие.');
      render();
      return;
    }
    const hostOnly = both ? both[1].trim() : host;

    // 🔴 Пароль экранируется, потому что в строке подключения он идёт частью authority.
    // В паролях прокси-продавцов регулярно встречается `@`, `:` и `#`, и незакодированный
    // `@` разрывает адрес на части: `user:pa@ss@1.2.3.4:1080` разберётся не туда, а
    // молчание здесь дорого - прокси просто не подключится. Обратно его раскодирует
    // серверный `parseProxy` (`decodeURIComponent`), поэтому круг «собрать → разобрать»
    // возвращает те же креды. Проверка круга - в tools/check-proxies-tab.js.
    const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';

    // 🪤 ДОПИСЫВАЕМ к тому, что уже в textarea, а не заменяем. Владелец может вставить
    // список и добавить один прокси полями - затирание было бы неожиданным.
    const ta = document.getElementById('px-own-text');
    if (!ta) return;
    const cur = ta.value.trim();
    ta.value = (cur ? cur + '\n' : '') + `${scheme}://${auth}${hostOnly}:${p}`;
    // Пароль стираем сразу: он уже в строке, а больше ему во вкладке делать нечего.
    const passEl = document.getElementById('px-f-pass');
    if (passEl) passEl.value = '';

    // 🔴 Здесь НЕ вызываем render(). Он перерисовывает вкладку из состояния сервера и
    // стёр бы только что добавленную строку вместе с `S.notice` - владелец нажал
    // «Добавить», а список остался бы прежним. Пишем уведомление прямо в его узел.
    updateNotice('ok', 'Строка добавлена в список выше — проверь и нажми «Сохранить список».');
  }

  // ── Разметка ──────────────────────────────────────────────────────────────

  // Статус НИКОГДА не одним цветом: цвет + знак + слово. В тёмных темах один цвет
  // неотличим, а в светлых — почти не читается.
  const aliveCell = (alive) => alive
    ? '<span class="px-alive">● жив</span>'
    : '<span class="px-dead">✕ мёртв</span>';

  // Возраст вердикта. «Жив» без «когда проверяли» — вердикт, который стареет молча:
  // прокси мог умереть минуту назад, а вкладка всё ещё зелёная.
  function ageText(ms) {
    if (ms == null) return '';
    const m = Math.round(ms / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ч назад`;
    return `${Math.round(h / 24)} сут назад`;
  }

  const cardTitle = (text, count) =>
    `<h2 class="px-card-title">${esc(text)}${count == null ? '' : `<span class="px-count">${esc(count)}</span>`}</h2>`;

  function ownSection(d) {
    const rows = (d.own || []).map(p => {
      const hosts = Object.entries(p.byHost || {});
      const hostStr = hosts.length
        ? hosts.map(([h, n]) => `${esc(h)}: ${n}`).join(', ')
        : '<span class="px-tier-none">не используется</span>';
      const checks = (S.checks || []).filter(c => c.id === p.id);
      // 🪤 Если проверок в этой сессии не было — берём вердикты из СНИМКА состояния
      // (`d.health`), иначе после обновления страницы столбец «проверка» обнулялся бы,
      // хотя проверку никто не отменял.
      const cached = (d.health || []).filter(h => h.proxyId === p.id);
      const all = checks.length ? checks : cached.map(h => ({
        host: h.host, ok: h.ok, error: h.error, ms: h.ms, status: h.status,
        ageMs: h.ageMs, path: h.path,
      }));
      const checkStr = all.length
        ? all.map(c => {
            const when = c.ageMs != null ? `<span class="px-note-faint"> · ${esc(ageText(c.ageMs))}</span>` : '';
            const why = c.status === 404 ? ' (путь не от этой панели)' : '';
            return `<span class="${c.ok ? 'px-alive' : 'px-dead'}" title="${esc(c.error || c.path || '')}">`
              + `${esc(c.host)}: ${c.ok ? 'ок' : 'нет'}${c.ms ? ` ${c.ms} мс` : ''}${esc(why)}</span>${when}`;
          }).join('<br>')
        : '<span class="px-tier-none">не проверялся</span>';
      return `<tr>
        <td class="px-mono">${esc(p.label)}</td>
        <td class="px-cell-xs">${esc(p.scheme)}${p.hasAuth
          ? ' <span class="px-tier-own" title="в строке есть логин и пароль">🔑</span>'
          : ''}</td>
        <td>${aliveCell(p.alive)}</td>
        <td class="px-cell-xs">${checkStr}</td>
        <td class="px-cell-xs">${hostStr}</td>
        <td class="px-cell-num">${p.accounts}</td>
      </tr>`;
    }).join('');

    return `
      <section class="px-card">
        ${cardTitle('Свои прокси', d.own.length ? `в пуле ${d.own.length}` : 'список пуст')}
        <p class="px-hint">
          Строка на прокси, любой формат: <code>socks5://user:pass@host:port</code>,
          <code>http://1.2.3.4:8080</code> или голый <code>ip:port</code>.
          Свой ярус приоритетнее скрапера и доливом не вымывается.
        </p>
        <div class="px-warn">
          Поле ниже <b>заменяет список целиком</b>. Пароли сервер обратно не отдаёт — сохранённые строки
          показаны таблицей, а поле всегда пустое. Если вставить список без паролей, авторизация у этих прокси пропадёт.
        </div>
        <textarea id="px-own-text" rows="5" spellcheck="false" class="px-textarea"
          placeholder="socks5://user:pass@node-fin1.xgate.online:10808&#10;154.219.251.60:63848:WpUL16FvW:rYw2GBb2A&#10;http://1.2.3.4:8080"></textarea>
        <p class="px-note-faint">
          Понимает три формы: <b>URL</b> (<code>socks5://логин:пароль@адрес:порт</code>),
          <b>магазинную</b> (<code>адрес:порт:логин:пароль</code>) и голый <code>адрес:порт</code>.
          Строки, которые не разобрались, вернутся списком - молча ничего не теряется.
        </p>
        <div class="px-row">
          <button onclick="PROXIES.openInlineForm()" class="px-btn">
            ${S.showForm ? '− Скрыть поля' : '＋ Вписать по полям'}</button>
          <span class="px-note-faint">если продавец дал адрес, логин и пароль отдельно</span>
        </div>
        ${S.showForm ? `<div class="px-fields">
          <label class="px-field"><span>протокол</span>
            <select id="px-f-scheme" class="px-select">
              <option value="socks5" selected>socks5</option>
              <option value="socks4">socks4</option>
              <option value="http">http</option>
              <option value="https">https</option>
            </select></label>
          <label class="px-field"><span>адрес</span>
            <input id="px-f-addr" class="px-input" placeholder="154.221.51.42" spellcheck="false"></label>
          <label class="px-field"><span>порт</span>
            <input id="px-f-port" class="px-input" placeholder="64117" spellcheck="false"></label>
          <label class="px-field"><span>логин</span>
            <input id="px-f-user" class="px-input" placeholder="если нужен" spellcheck="false"></label>
          <label class="px-field"><span>пароль</span>
            <input id="px-f-pass" class="px-input" type="password" placeholder="если нужен" spellcheck="false"></label>
          <div class="px-row">
            <button onclick="PROXIES.addFromFields()" class="px-btn px-btn-ok">Добавить в список</button>
            <span class="px-note-faint">порт можно вписать прямо в адрес: <code>1.2.3.4:1080</code></span>
          </div>
        </div>` : ''}
        <div class="px-row">
          <button onclick="PROXIES.saveOwn()" ${S.saving ? 'disabled' : ''} class="px-btn px-btn-ok">
            ${S.saving ? 'сохраняю...' : 'Сохранить список'}</button>
          <button onclick="PROXIES.checkOwn()" ${S.checking || !d.own.length ? 'disabled' : ''} class="px-btn px-btn-azure">
            ${S.checking ? 'проверяю...' : 'Проверить здоровье'}</button>
          <span class="px-note-faint">проверка идёт по всем хостам пула, путь подбирается под движок панели</span>
        </div>
        ${d.own.length ? `<div class="px-table-wrap"><table class="px-table">
          <thead><tr><th>адрес</th><th>схема</th><th>состояние</th><th>проверка</th><th>нагрузка по хостам</th><th style="text-align:right">аккаунтов</th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : ''}
      </section>`;
  }

  function scrapedSection(d) {
    const s = d.scraped || {};
    return `
      <section class="px-card">
        ${cardTitle('Ярус скрапера', 'перелив, когда свои заняты')}
        <div class="px-stats">
          <span>адресов: <b>${s.count || 0}</b></span>
          <span>источник: <span class="px-mono-dim">${esc(s.source || '—')}</span></span>
          ${s.bad ? `<span class="px-warn-text">не разобрано строк: ${s.bad}</span>` : ''}
          ${s.fileError ? `<span class="px-dead">файл: ${esc(s.fileError)}</span>` : ''}
        </div>
        <p class="px-note-faint">Публичные прокси живут минутами — список доливается перед прогонами, поэтому цифра честна только на момент чтения.</p>
      </section>`;
  }

  function rebalanceSection(d) {
    const c = d.counts || {};
    const moves = (S.plan && S.plan.moves) || [];
    const skipped = (S.plan && S.plan.skipped) || [];

    const planRows = moves.map(m => `<tr>
        <td class="px-key">${esc(m.key)}</td>
        <td class="px-dead">${esc(m.from)}</td>
        <td class="px-cell-xs">${esc(m.host || '—')}</td>
        <td class="px-cell-xs">${esc(m.why)}</td>
      </tr>`).join('');

    const skipRows = skipped.map(s => `<tr>
        <td class="px-key">${esc(s.key)}</td>
        <td class="px-mono-dim">${esc(s.proxy)}</td>
        <td class="px-warn-text">${esc(s.why)}</td>
      </tr>`).join('');

    return `
      <section class="px-card">
        ${cardTitle('Осиротевшие и перекос', (c.orphans || 0) > 0 ? `проблемных привязок ${c.orphans}` : 'перекоса нет')}
        <div class="px-stats">
          <span>привязок всего: <b>${c.assigned || 0}</b></span>
          <span class="${c.orphansOwn ? 'px-warn-text' : ''}">осиротевших своих: <b>${c.orphansOwn || 0}</b></span>
          <span class="${c.orphansScraped ? 'px-dead' : ''}">осиротевших скраперных: <b>${c.orphansScraped || 0}</b></span>
        </div>
        <p class="px-hint">
          Осиротевшая привязка — прокси пропал из пула, аккаунт остался без выхода. Перевес — на одном прокси
          для одного хоста сидит больше <code>maxPerHost</code> аккаунтов. Живые привязки ребаланс НЕ трогает:
          смена IP у аккаунта с сессией заметнее, чем перекос.
        </p>
        <div class="px-row">
          <button onclick="PROXIES.planRebalance()" class="px-btn px-btn-azure">Показать план</button>
          ${moves.length ? `<button onclick="PROXIES.applyRebalance()" class="px-btn px-btn-danger">
            Применить ${moves.length} перемещений</button>` : ''}
        </div>
        ${planRows ? `<div class="px-table-wrap"><table class="px-table">
          <thead><tr><th>аккаунт</th><th>был на</th><th>хост</th><th>почему</th></tr></thead>
          <tbody>${planRows}</tbody></table></div>` : ''}
        ${skipRows ? `<p class="px-warn-text">Пропущено автоматикой (решение владельца):</p>
          <div class="px-table-wrap"><table class="px-table"><tbody>${skipRows}</tbody></table></div>` : ''}
      </section>`;
  }

  function mappingSection(d) {
    const all = d.assignments || [];
    const rows = all.map(a => `<tr>
        <td class="px-key">${esc(a.key)}</td>
        <td class="px-mono-dim">${esc(a.proxy)}</td>
        <td>${a.tier === 'own' ? '<span class="px-tier-own">свой</span>'
          : (a.tier ? '<span class="px-tier-scraped">скрапер</span>' : '<span class="px-tier-none">—</span>')}</td>
        <td class="px-cell-xs">${esc(a.host || '—')}</td>
        <td>${aliveCell(a.alive)}</td>
        <td style="text-align:right"><button onclick="PROXIES.releaseKey('${esc(a.key)}')" class="px-btn-mini">отвязать</button></td>
      </tr>`).join('');

    return `
      <section class="px-card">
        ${cardTitle('Карта привязок', `аккаунтов ${all.length}`)}
        <div class="px-table-wrap"><table class="px-table">
          <thead><tr><th>аккаунт</th><th>прокси</th><th>ярус</th><th>хост</th><th>прокси жив</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </section>`;
  }

  // Ёмкость: потолок считается из размера пула, поэтому показываем не только число,
  // но и из чего оно вышло. Владелец просил «пусть скачет как хочет, но с предупреждением» -
  // значит предупреждение тут главное, а не запрет.
  function capacitySection(d) {
    const c = d.capacity;
    if (!c) return '';
    const manual = (c.manual || []).length
      ? `<p class="px-note-faint">Формула перебита вручную для: ${(c.manual || [])
        .map(m => `${esc(m.host)} = ${m.value}`).join(', ')}</p>`
      : '';
    const other = c.assignedAll != null && c.assignedAll !== c.assigned
      ? `<p class="px-note-faint">В файле привязок ещё ${c.assignedAll - c.assigned} записей других
        провайдеров — пул их не обслуживает, в расчёт ёмкости они не идут.</p>`
      : '';

    return `
      <section class="px-card">
        ${cardTitle('Ёмкость', 'сколько аккаунтов приходится на один прокси')}
        ${c.dense ? `<div class="px-warn">
          ⚠️ <b>Плотно: ${c.perProxy.toFixed(1)} аккаунта на прокси</b> при пороге ${c.threshold}.
          Пул раскладку не ограничивает, но на один IP столько аккаунтов ходит редко и выглядит
          для панели плотнее обычного домашнего NAT. Дешёвый ход — добавить прокси: потолок
          пересчитается сам.
        </div>` : ''}
        <div class="px-stats">
          <span>рабочих прокси: <b>${c.liveProxies}</b></span>
          <span>привязано аккаунтов: <b>${c.assigned}</b></span>
          <span>на адрес: <b>${c.perProxy == null ? '—' : c.perProxy.toFixed(2)}</b></span>
          <span>потолок: <b>${c.limit}</b></span>
        </div>
        <p class="px-hint">
          Пул один на все шлюзы, и потолок тоже один: он считается как
          <code>привязанные аккаунты обслуживаемых шлюзов ÷ рабочие прокси</code>, чтобы
          подстраиваться под размер пула. 6 прокси на 33 аккаунта дадут потолок 6, а 20 прокси —
          потолок 2; никто ничего не вписывает. По провайдерам ёмкость НЕ делится: адреса в
          пуле одни и те же.
        </p>
        ${manual}${other}
      </section>`;
  }

  function render() {
    const root = document.getElementById('proxies-root');
    if (!root) return;

    const d = S.data;
    const noticeText = S.notice ? S.notice.text : null;
    const noticeKind = S.notice ? S.notice.kind : 'ok';
    // 🪤 Ошибку чтения показываем ВСЕГДА, даже когда есть данные с прошлого раза.
    // Иначе вкладка молча рисует устаревшее состояние как свежее - и владелец правит
    // раскладку по цифрам, которые уже неверны.
    const errBanner = S.err
      ? `<div class="px-notice px-notice-err">чтение состояния не удалось: ${esc(S.err)}</div>`
      : '';
    // 🪤 У баннера есть id, и он живёт в разметке всегда. Так его можно обновить, не
    // перерисовывая вкладку, - и не потерять набранное в textarea.
    const noticeDiv = (noticeText || S.err)
      ? `${errBanner}${noticeText && !S.err
        ? `<div class="px-notice ${noticeKind === 'err' ? 'px-notice-err' : 'px-notice-ok'}" id="px-notice">${esc(noticeText)}</div>`
        : ''}`
      : '<div class="px-notice px-notice-ok" id="px-notice" style="display:none"></div>';
    const notice = noticeDiv;

    if (!d) {
      root.innerHTML = `<div class="px-wrap">
        <h1 class="px-title"><span>🔌</span> Свои прокси</h1>
        ${errBanner || '<div class="px-notice px-notice-ok">читаю состояние пула...</div>'}
      </div>`;
      return;
    }

    root.innerHTML = `
      <div class="px-wrap">
        <header class="px-header">
          <div>
            <h1 class="px-title"><span>🔌</span> Свои прокси</h1>
            <p class="px-sub">свой ярус прокси и раскладка аккаунтов по паре «прокси × хост»</p>
          </div>
          <div class="px-chips">
            <span class="px-chip ${d.enabled ? 'px-chip-on' : 'px-chip-off'}">${d.enabled ? '● пул включён' : '✕ пул выключен'}</span>
            <span class="px-chip">свои: ${d.counts ? d.counts.own : 0}</span>
            <span class="px-chip">скрапер: ${d.counts ? d.counts.scraped : 0}</span>
            <span class="px-chip" title="приоритет своего яруса при новых привязках">свои первыми: ${d.ownFirst ? 'да' : 'нет'}</span>
          </div>
        </header>
        ${notice}
        ${ownSection(d)}
        ${capacitySection(d)}
        ${scrapedSection(d)}
        ${rebalanceSection(d)}
        ${mappingSection(d)}
        ${!d.own.length ? `<div class="px-empty">
          Свой ярус пуст — весь флот идёт через скрапер. Вставьте свои прокси выше: список живёт отдельно
          от выгрузки скрапера, его не вымывает долив, и он получает приоритет при новых привязках.
        </div>` : ''}
      </div>`;
  }

  window.PROXIES = { load, saveOwn, checkOwn, planRebalance, applyRebalance, releaseKey, render, openInlineForm, addFromFields };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startPoll);
  else startPoll();
})();
