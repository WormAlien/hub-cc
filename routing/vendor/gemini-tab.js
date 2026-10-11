/*
 * gemini-tab.js — вкладка «Gemini» в дашборде хаба.
 *
 * За ней стоит свой сервер (`F:\hub-cc\gemini`, вендор форка antigravity-claude-proxy):
 * Anthropic-совместимый API поверх Google Cloud Code, то есть модели Gemini и Claude с
 * Google-аккаунтов. Вкладка — пульт: показывает, что за аккаунты в пуле, какая у них подписка,
 * сколько осталось квоты и какие модели доступны, и умеет поднять/погасить сам сервер.
 *
 * 🪤 Модуль ничего не знает про устройство сервера — только его ручки (`/__switch/api/gemini/*`,
 * см. `routing/lib/gemini-routes.js`). Так же устроена вкладка Google: разметку целиком рисует
 * внешний файл, а в `proxy-dashboard.html` остаются кнопка, панель и ветка ленивой загрузки.
 *
 * 🪤 Автозагрузки нет намеренно: первый `load()` делает шов из `showTab()`. Иначе дашборд
 * дёргал бы сервер вкладки при каждом открытии страницы, даже если во вкладку не заходили.
 */
(function () {
  'use strict';

  const API = '/__switch/api/gemini/';
  const POLL_MS = 15000;

  const S = {
    accounts: [],
    server: { up: false },
    total: 0,
    live: 0,
    tiers: [],
    err: null,
    loading: false,
    busy: false,        // идёт действие (поднять/погасить) — поллим аккуратнее
    openModels: {},     // email → раскрыт ли список моделей
    modelsOpen: false,  // раскрыт ли общий каталог моделей у сервера
    models: null,       // null = ещё не спрашивали, массив = ответ
    modelMap: {},       // тир-карта: opus/sonnet/haiku → модель Antigravity
    activeModel: null,  // выбранная модель вкладки (файл ~/.claude/gemini-active-model.txt)
    authPanel: false,   // раскрыта ли панель «добавить аккаунт»
    google: null,       // пул Google (берём у соседней вкладки: аккаунт приходит оттуда)
    auth: null,         // незавершённый вход: { state, email, proxy, proxyReason }
    authInput: '',      // вставленная ссылка колбэка или код
    authBusy: false,
    loadedOnce: false,
    startTried: false,  // автоподъём сервера пробуем один раз за загрузку страницы
    pollTimer: null,
  };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const TIER_META = {
    ultra: { label: '✦ ultra', cls: 'gm-tier-ultra', hint: 'старший тариф' },
    pro: { label: '✦ pro', cls: 'gm-tier-pro', hint: 'подписка Pro — модели Gemini доступны' },
    free: { label: 'free', cls: 'gm-tier-free', hint: 'бесплатный тариф — квота маленькая' },
  };
  const tierMeta = t => TIER_META[t] || { label: t ? esc(t) : 'тир не определён', cls: 'gm-tier-unknown', hint: 'тир ещё не спрашивали у Google' };

  async function api(path, opts) {
    const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    let body = null;
    try { body = await r.json(); } catch { /* пусто */ }
    if (!r.ok) throw new Error((body && (body.error || body.message)) || `HTTP ${r.status}`);
    return body || {};
  }
  const post = (path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload || {}) });

  function toast(text, kind) {
    let box = document.querySelector('.gm-toasts');
    if (!box) { box = document.createElement('div'); box.className = 'gm-toasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'gm-toast' + (kind === 'ok' ? ' gm-toast-ok' : kind === 'bad' ? ' gm-toast-bad' : '');
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function fmtTime(iso) {
    if (!iso) return null;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtAgo(iso) {
    if (!iso) return 'никогда';
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return 'никогда';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ч назад`;
    return `${Math.floor(h / 24)} дн назад`;
  }

  const pct = f => (typeof f === 'number' ? Math.round(f * 100) : 0);

  // ── Разметка ───────────────────────────────────────────────────────────────

  /** Панель «добавить аккаунт»: выбрать Google-аккаунт и провести вход в его окне. */
  function authPanelHtml() {
    if (!S.authPanel) return '';

    if (S.auth) {
      return `<div class="gm-panel">
        <div class="gm-panel-title">Вход: ${esc(S.auth.email)}</div>
        <div class="gm-dim gm-small">
          Окно Chrome открыто в профиле этого аккаунта${S.auth.proxy
            ? ` и через его прокси (<span class="gm-mono">${esc(S.auth.proxy.label)}</span>)`
            : ' — <span class="gm-bad">и БЕЗ прокси</span>'}.
          Войди и нажми «Разрешить»; окно закроется само, аккаунт появится в пуле.
        </div>
        ${!S.auth.proxy && S.auth.proxyReason ? `<div class="gm-hint-warn">
          Прокси не выдан (${esc(S.auth.proxyReason)}) — Google увидит домашний IP аккаунта.
          Смена IP у живого аккаунта выглядит как угон сессии, за это и банят. Проверь пул прокси
          во вкладке «Прокси» и повтори, если это важно.</div>` : ''}
        <div class="gm-auth-row">
          <input class="gm-input" id="gm-auth-input" placeholder="если окно закрылось раньше — вставь сюда ссылку колбэка или код"
                 value="${esc(S.authInput)}" oninput="GEMINI.setAuthInput(this.value)">
          <button class="gm-btn gm-btn-go" onclick="GEMINI.completeAuth()">готово</button>
          <button class="gm-btn gm-btn-dim" onclick="GEMINI.cancelAuth()">отмена</button>
        </div>
      </div>`;
    }

    if (S.google === null) return `<div class="gm-panel"><div class="gm-dim">читаю пул Google…</div></div>`;
    if (!S.google.length) {
      return `<div class="gm-panel">
        <div class="gm-panel-title">В пуле Google нет аккаунтов</div>
        <div class="gm-dim">Сначала заведи аккаунт на вкладке <b>Google</b> (почта, пароль, 2FA),
        потом вернись сюда и авторизуй его в подписке.</div>
      </div>`;
    }

    // Уже авторизованные в подписке помечаем: их повторный вход открыл бы второе окно на тот же
    // профиль (Chromium такое не пускает) и вообще бессмысленен.
    const already = new Set(S.accounts.map(a => String(a.email || '').toLowerCase()));
    const rows = S.google.map(g => {
        const done = already.has(String(g.email || '').toLowerCase());
        return `<div class="gm-auth-row">
          <span class="gm-mono gm-auth-mail">${esc(g.email)}</span>
          ${g.used ? '<span class="gm-tag gm-tag-dim" title="в записи Google-пула есть метка расхода">занят</span>' : ''}
          <button class="gm-btn${done ? ' gm-btn-dim' : ' gm-btn-go'}" ${done ? 'disabled' : ''}
            onclick="GEMINI.startAuth('${esc(g.id)}')">${done ? 'уже в пуле' : 'авторизовать'}</button>
        </div>`;
    }).join('');
    return `<div class="gm-panel">
      <div class="gm-panel-title">Взять аккаунт из пула Google и авторизовать в подписке</div>
      <div class="gm-dim gm-small">Откроется Chrome в профиле ЭТОГО аккаунта (там он уже залогинен)
      и с его прокси. Дальше — «Разрешить» руками: капчу и «подтвердите, что это вы» автоматика не проходит.</div>
      <div class="gm-auth-list">${rows}</div>
    </div>`;
  }

  function headerHtml() {
    const st = S.server || {};
    const up = !!st.up;
    return `
      <div class="gm-head">
        <div>
          <div class="gm-title">Gemini · Antigravity</div>
          <div class="gm-sub">
            ${S.total} аккаунт(ов) в пуле · <span class="gm-live">${S.live}</span> живых
            ${S.tiers.length ? ` · тиры: ${S.tiers.map(t => esc(t)).join(', ')}` : ''}
          </div>
          <div class="gm-note">
            Подписка Google отдаёт модели Gemini и Claude напрямую в Claude Code.
            Сервер вкладки — <span class="gm-mono">127.0.0.1:${esc(String(st.port || ''))}</span>:
            <span class="${up ? 'gm-ok' : 'gm-bad'}">${up ? 'поднят' : 'лежит'}</span>
            ${up && st.summary ? ` · <span class="gm-mono">${esc(st.summary)}</span>` : ''}
            ${!up && st.error ? ` · <span class="gm-dim">${esc(st.error)}</span>` : ''}
          </div>
        </div>
        <div class="gm-actions">
          <button class="gm-btn gm-btn-go" onclick="GEMINI.activate()" title="Переключить Claude Code на этот сервер. Текущая сессия не рвётся — новый адрес подхватится следующим запросом">⚡ сделать активным</button>
          <button class="gm-btn" onclick="GEMINI.openAuth()" title="Взять аккаунт из вкладки Google и авторизовать его в подписке">➕ добавить аккаунт</button>
          <button class="gm-btn" onclick="GEMINI.load(true)" title="Перечитать пул">↻</button>
          ${up
            ? `<button class="gm-btn" onclick="GEMINI.server('restart')" title="Перезапустить сервер вкладки">⟳ сервер</button>
               <button class="gm-btn gm-btn-dim" onclick="GEMINI.server('stop')" title="Погасить сервер (модели перестанут отвечать)">■ остановить</button>`
            : `<button class="gm-btn gm-btn-go" onclick="GEMINI.server('start')" title="Поднять сервер вкладки">▶ поднять сервер</button>`}
          <button class="gm-btn" onclick="GEMINI.showModels()" title="Модели, тиры и каталог">⚙ модели и тиры</button>
        </div>
      </div>`;
  }

  // Панель моделей и тиров: то же, что на вкладке AgentRouter, — каталог от шлюза, активная
  // модель и три тира Claude Code, которые в неё переезжают.
  function modelsPanelHtml() {
    if (!S.modelsOpen) return '';
    if (!Array.isArray(S.models)) return `<div class="gm-panel"><div class="gm-dim">спрашиваю у Google…</div></div>`;
    if (!S.models.length) return `<div class="gm-panel"><div class="gm-bad">каталог пуст или сервер лежит</div></div>`;

    const mm = S.modelMap || {};
    // 🪤 Значение карты, которого нет в каталоге (модель убрали из Google, или карту правили
    // руками), обязано остаться в списке. Иначе выбор молча показывал бы «— не задано —», а
    // «сохранить тиры» записало бы это как решение человека — и тир пропал бы без единого слова.
    const optionsFor = tier => {
        const cur = String(mm[tier] || '');
        return [...new Set([...S.models, cur].filter(Boolean))];
    };
    const select = (tier, title) => `
      <label class="gm-map-row">
        <span class="gm-map-tier">${title}</span>
        <select class="gm-select" data-tier="${tier}">
          <option value=""${!mm[tier] ? ' selected' : ''}>— не задано —</option>
          ${optionsFor(tier).map(id => `<option value="${esc(id)}"${String(mm[tier] || '') === id ? ' selected' : ''}>${esc(id)}${S.models.includes(id) ? '' : ' (нет в каталоге)'}</option>`).join('')}
        </select>
      </label>`;

    return `<div class="gm-panel">
      <div class="gm-panel-title">Тиры Claude Code → модели Antigravity</div>
      <div class="gm-map">
        ${select('opus', 'opus')}${select('sonnet', 'sonnet')}${select('haiku', 'haiku')}
      </div>
      <div class="gm-map-foot">
        <button class="gm-btn gm-btn-go" onclick="GEMINI.saveMap()">сохранить тиры</button>
        <span class="gm-dim gm-small">тир-карта уезжает в <span class="gm-mono">ANTHROPIC_DEFAULT_*_MODEL</span>:
        по ней Claude Code и выбирает модель, когда просит opus/sonnet/haiku</span>
      </div>

      <div class="gm-panel-title gm-mt">Каталог моделей — клик делает модель главной</div>
      <div class="gm-models">
        ${S.models.map(id => `<button class="gm-tag gm-mono${S.activeModel === id ? ' gm-tag-on' : ''}"
            title="сделать главной моделью вкладки (она же уезжает в тир opus)" onclick="GEMINI.setModel('${esc(id)}')">${esc(id)}</button>`).join('')}
      </div>
      <div class="gm-map-foot">
        <span class="gm-dim gm-small">главная модель: <span class="gm-mono">${esc(S.activeModel || 'не выбрана')}</span>
        · её же берёт тир <span class="gm-mono">opus</span>, поэтому отдельно его можно не трогать</span>
      </div>
    </div>`;
  }

  function modelRowsHtml(a) {
    const per = (a.quota && a.quota.perModel) || {};
    const ids = (a.quota && a.quota.models) || [];
    if (!ids.length) return '<div class="gm-dim gm-small">квота по моделям ещё не спрашивалась</div>';
    const rows = ids.map(id => {
      const q = per[id] || {};
      const left = typeof q.remainingFraction === 'number' ? `${pct(q.remainingFraction)}%` : '—';
      const reset = q.resetTime ? fmtTime(q.resetTime) : '';
      return `<div class="gm-model-row">
        <span class="gm-mono gm-model-name">${esc(id)}</span>
        <span class="gm-model-left">${left}</span>
        <span class="gm-dim gm-small">${reset ? 'сброс ' + esc(reset) : ''}</span>
      </div>`;
    }).join('');
    return `<div class="gm-models-list">${rows}</div>`;
  }

  function cardHtml(a, idx) {
    const t = tierMeta(a.tier);
    const badges = [];
    badges.push(`<span class="gm-tag ${t.cls}" title="${esc(t.hint)}">${t.label}</span>`);
    if (a.enabled === false) badges.push('<span class="gm-tag gm-tag-off">выключен</span>');
    if (a.isInvalid) badges.push(`<span class="gm-tag gm-tag-bad" title="${esc(a.invalidReason || '')}">забанен / недействителен</span>`);
    if (a.source === 'legacy-import') badges.push('<span class="gm-tag gm-tag-dim" title="перенесён из прежнего пула форка">перенос</span>');
    if (a.rateLimited && a.rateLimited.length) {
      badges.push(`<span class="gm-tag gm-tag-warn" title="${esc(a.rateLimited.map(r => r.model).join(', '))}">лимит по ${a.rateLimited.length} модел.</span>`);
    }

    const open = !!S.openModels[a.email];
    // Шкала показывается только когда квоту действительно измеряли: пустая полоса на нуле
    // читается как «квота кончилась», а это неправда — её просто ещё не спрашивали.
    const measured = a.quota && a.quota.minFraction != null;
    return `
      <div class="gm-card${a.enabled === false ? ' gm-card-off' : ''}">
        <div class="gm-card-head">
          <div class="gm-mail" title="${esc(a.email)}">${esc(a.email)}</div>
          <div class="gm-badges">${badges.join('')}</div>
        </div>
        ${measured
          ? `<div class="gm-energy" id="gm-energy-${idx}"></div>`
          : `<div class="gm-unmeasured">остаток квоты ещё не спрашивали${a.isInvalid ? ' — аккаунт помечен недействительным' : ''}</div>`}
        <div class="gm-card-meta">
          <span>квота обновлена: ${esc(fmtAgo(a.quota && a.quota.lastChecked))}</span>
          <span>моделей: ${((a.quota && a.quota.models) || []).length}</span>
          ${a.projectId ? `<span class="gm-mono gm-dim">${esc(a.projectId)}</span>` : ''}
        </div>
        <div class="gm-card-foot">
          <button class="gm-btn gm-btn-go" onclick="GEMINI.refreshAccount('${esc(a.email)}')" title="Спросить у Google квоту и тир именно этого аккаунта">↻ обновить</button>
          <button class="gm-btn" onclick="GEMINI.models('${esc(a.email)}')">${open ? '▲ модели' : '▼ модели'}</button>
          <button class="gm-btn" onclick="GEMINI.toggle('${esc(a.email)}', ${a.enabled === false})">${a.enabled === false ? 'включить' : 'выключить'}</button>
          <button class="gm-btn gm-btn-dim" onclick="GEMINI.remove('${esc(a.email)}')" title="Снять с пула (сам Google-аккаунт остаётся)">🗑</button>
        </div>
        ${open ? `<div class="gm-models-open">${modelRowsHtml(a)}</div>` : ''}
      </div>`;
  }

  function render() {
    const root = $('gemini-root');
    if (!root) return;
    if (S.err && !S.accounts.length) {
      root.innerHTML = headerHtml() + authPanelHtml() + `<div class="gm-panel"><div class="gm-bad">пул не прочитался: ${esc(S.err)}</div></div>`;
      return;
    }
    if (!S.accounts.length) {
      root.innerHTML = headerHtml() + authPanelHtml() + `<div class="gm-panel">
        <div class="gm-panel-title">В пуле подписки пока ни одного аккаунта</div>
        <div class="gm-dim">Аккаунт берётся из вкладки Google: там он уже с паролем, 2FA и своим
        профилем браузера, — и авторизуется кнопкой «добавить аккаунт» выше.</div>
      </div>`;
      return;
    }
    root.innerHTML = `<div class="gm-wrap">${headerHtml()}${modelsPanelHtml()}${authPanelHtml()}
      <div class="gm-grid">${S.accounts.map(cardHtml).join('')}</div></div>`;

    // Шкалу рисует общая функция дашборда: своя полоса разъехалась бы с остальными вкладками.
    S.accounts.forEach((a, i) => {
      if (typeof renderEnergyGauge !== 'function') return;
      const el = $('gm-energy-' + i);
      if (!el) return;   // квоту не измеряли — вместо шкалы стоит подпись
      renderEnergyGauge(el, {
        pct: pct(a.quota && a.quota.minFraction),
        title: 'остаток квоты',
        sub: (a.quota && a.quota.minFraction != null)
          ? `<span>узкая модель: <span class="gm-mono">${esc(weakestModel(a))}</span></span>`
          : '<span>ещё не измеряли</span>',
        note: a.quota && a.quota.lastChecked ? `проверено ${esc(fmtAgo(a.quota.lastChecked))}` : '',
      });
    });

    const cnt = $('nav-count-gemini');
    if (cnt) cnt.textContent = S.total ? `${S.live}/${S.total}` : '—';
  }

  /** Модель с самым маленьким остатком — по ней и видно, когда аккаунт «кончится». */
  function weakestModel(a) {
    const per = (a.quota && a.quota.perModel) || {};
    let best = null;
    for (const [id, q] of Object.entries(per)) {
      if (typeof q.remainingFraction !== 'number') continue;
      if (!best || q.remainingFraction < best.f) best = { id, f: q.remainingFraction };
    }
    return best ? best.id : '—';
  }

  // ── Данные ─────────────────────────────────────────────────────────────────

  async function load(force) {
    if (S.loading) return;
    S.loading = true;
    try {
      // Тиры тянем вместе со списком: они лежат в файле на сервере вкладки, стоят ноль и
      // нужны панели сразу, а не после отдельного клика.
      const [d, mp] = await Promise.all([api('list'), api('modelmap').catch(() => null)]);
      if (mp) { S.modelMap = mp.modelMap || {}; S.activeModel = mp.activeModel || null; }
      S.server = d.server || { up: false };
      S.accounts = d.accounts || [];
      S.total = d.total || 0;
      S.live = d.live || 0;
      S.tiers = d.tiers || [];
      S.err = d.error || null;
      S.loadedOnce = true;
    } catch (e) {
      S.err = e.message;
      S.server = { up: false, error: e.message };
    } finally {
      S.loading = false;
      render();
      // Сервер вкладки лежит? Поднимаем один раз за загрузку страницы, не спрашивая: после
      // перезапуска одного дашборда (без полного `hub.js start`) он не поднимается сам, и
      // вкладка иначе встречала бы владельца пустотой. Повтор — по кнопке, а не в цикле.
      if (!S.server.up && !S.startTried) {
        S.startTried = true;
        serverAction('start');
      }
    }
    startTimers();
  }

  function startTimers() {
    if (S.pollTimer) return;
    S.pollTimer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
  }

  // ── Действия ───────────────────────────────────────────────────────────────

  async function serverAction(action) {
    if (S.busy) return;
    S.busy = true;
    try {
      toast(action === 'stop' ? 'гашу сервер вкладки…' : action === 'start' ? 'поднимаю сервер вкладки…' : 'перезапускаю сервер…');
      const r = await post('server', { action });
      if (r && r.ok === false) throw new Error(r.error || 'не вышло');
      toast(action === 'stop' ? 'сервер погашен' : 'сервер работает', 'ok');
    } catch (e) {
      toast('сервер: ' + e.message, 'bad');
    } finally {
      S.busy = false;
      setTimeout(() => load(true), 1200);
    }
  }

  async function refreshAccount(email) {
    if (S.busy) return;
    S.busy = true;
    try {
      const r = await post('refresh', { email });
      if (r.status === 'banned') toast('аккаунт забанен Google — модели по нему больше не отвечают', 'bad');
      else toast(`квота обновлена: ${email}`, 'ok');
    } catch (e) {
      toast('квота: ' + e.message, 'bad');
    } finally {
      S.busy = false;
      load(true);
    }
  }

  async function toggle(email, enabled) {
    try {
      await post('account/toggle', { email, enabled });
      toast(enabled ? 'аккаунт включён' : 'аккаунт выключен', 'ok');
    } catch (e) {
      toast('не вышло: ' + e.message, 'bad');
    }
    load(true);
  }

  async function remove(email) {
    if (!confirm(`Снять аккаунт ${email} с пула Gemini?\n\nСам Google-аккаунт и его профиль в вкладке Google остаются на месте — снимается только доступ из этой вкладки.`)) return;
    try {
      await post('delete', { email });
      toast('аккаунт снят', 'ok');
    } catch (e) {
      toast('не вышло: ' + e.message, 'bad');
    }
    load(true);
  }

  // ── Авторизация аккаунта из вкладки ────────────────────────────────────────

  /** Открыть/закрыть панель «добавить аккаунт». Пул Google тянем у соседней вкладки. */
  async function openAuth() {
    S.authPanel = !S.authPanel;
    render();
    if (!S.authPanel) return;
    if (S.google !== null) return;
    S.google = null;
    render();
    try {
      // 🪤 Аккаунты берём у вкладки Google, а не из своего пула: список один, и заводить
      // второй значило бы показывать человеку разные вещи в двух соседних вкладках.
      const r = await fetch('/__switch/api/google/list', { headers: { 'Content-Type': 'application/json' } });
      const d = await r.json();
      S.google = ((d && d.accounts) || []).map(a => ({
        id: a.id, email: a.email,
        used: Array.isArray(a.usedOn) && a.usedOn.some(m => (typeof m === 'string' ? m : m && m.tag) === 'antigravity'),
      }));
    } catch (e) {
      S.google = [];
      toast('пул Google не прочитался: ' + e.message, 'bad');
    }
    render();
  }

  /** Открыть окно входа для выбранного Google-аккаунта. */
  async function startAuth(googleId) {
    if (S.authBusy) return;
    S.authBusy = true;
    try {
      const r = await post('auth/start', { googleId });
      S.auth = { state: r.state, email: r.email, proxy: r.proxy, proxyReason: r.proxyReason };
      S.authInput = '';
      toast(r.proxy ? `окно открыто · прокси ${r.proxy.label}` : 'окно открыто, но БЕЗ прокси', r.proxy ? 'ok' : 'bad');
      if (!r.proxy && r.proxyReason) toast('причина: ' + r.proxyReason, 'bad');
    } catch (e) {
      toast('окно не открылось: ' + e.message, 'bad');
    } finally {
      S.authBusy = false;
      render();
    }
  }

  /** Донести ссылку колбэка руками — когда окно закрыли раньше или колбэк не доехал. */
  async function completeAuth() {
    if (!S.auth) return;
    if (!S.authInput.trim()) return toast('вставь ссылку колбэка или код', 'bad');
    if (S.authBusy) return;
    S.authBusy = true;
    try {
      const r = await post('auth/complete', { state: S.auth.state, input: S.authInput.trim() });
      toast(`аккаунт добавлен: ${r.email || ''}`, 'ok');
      S.auth = null;
      S.authInput = '';
    } catch (e) {
      toast('код не принят: ' + e.message, 'bad');
    } finally {
      S.authBusy = false;
      load(true);
    }
  }

  function cancelAuth() {
    S.auth = null;
    S.authInput = '';
    render();
  }

  function setAuthInput(v) { S.authInput = String(v || ''); }

  // ── Модели, тиры и переключение ────────────────────────────────────────────

  /** Выбрать активную модель вкладки. Пишется в ~/.claude/gemini-active-model.txt. */
  async function setModel(id) {
    try {
      const r = await post('set-model', { model: id });
      S.activeModel = id;
      toast(`модель: ${(r && r.appliedModel) || id}`, 'ok');
    } catch (e) { toast('модель: ' + e.message, 'bad'); }
    load(true);
  }

  /** Сохранить тир-карту — три выбираемых значения, тем же смыслом, что у AgentRouter. */
  async function saveMap() {
    const pick = tier => {
      const el = document.querySelector(`.gm-select[data-tier="${tier}"]`);
      return el ? el.value : '';
    };
    try {
      await post('modelmap', { opus: pick('opus'), sonnet: pick('sonnet'), haiku: pick('haiku') });
      toast('тиры сохранены', 'ok');
    } catch (e) { toast('тиры: ' + e.message, 'bad'); }
    load(true);
  }

  /** Переключить Claude Code на Gemini. Сессия при этом не рвётся — адрес подхватится следующим запросом. */
  async function activate() {
    if (S.busy) return;
    S.busy = true;
    try {
      const r = await post('activate', S.activeModel ? { model: S.activeModel } : {});
      if (r && r.keepalive && r.keepalive.up === false) toast('сервер вкладки не поднялся: ' + (r.keepalive.error || '?'), 'bad');
      else if (r && r.settingsUpdated === false) toast('переключил, но настройки Claude Code записать не вышло — смотри лог хаба', 'bad');
      else toast(`Gemini — активный бэкенд${r && r.model ? ': ' + r.model : ''}`, 'ok');
    } catch (e) {
      toast('переключить не вышло: ' + e.message, 'bad');
    } finally {
      S.busy = false;
      setTimeout(() => load(true), 1500);
    }
  }

  function models(email) {    if (email) {
      S.openModels[email] = !S.openModels[email];
      render();
      return;
    }
    S.modelsOpen = !S.modelsOpen;
    if (S.modelsOpen && S.models === null) {
      render();
      api('models').then(d => { S.models = d.models || []; render(); })
        .catch(e => { S.models = []; toast('каталог: ' + e.message, 'bad'); render(); });
      return;
    }
    render();
  }

  window.GEMINI = {
    load,
    refresh: () => load(true),
    server: serverAction,
    refreshAccount,
    toggle,
    remove,
    models,
    showModels: () => models(null),
    setModel,
    saveMap,
    activate,
    openAuth,
    startAuth,
    completeAuth,
    cancelAuth,
    setAuthInput,
    start: startTimers,
  };
})();
