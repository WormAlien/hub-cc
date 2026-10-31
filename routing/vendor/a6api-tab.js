/* a6api: local Claude Code controls. Reading or selecting never activates a gateway. */
(() => {
  'use strict';
  const API = '/__switch/api/a6api/';
  const COMMAND = '/model a6api[1m]';
  const SLOTS = ['default', 'opus', 'sonnet', 'haiku'];
  const byId = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = v => v == null || !Number.isFinite(Number(v)) ? 'нет данных' : '$' + Number(v).toFixed(6).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  const time = v => {
    if (v === -1 || v === 0) return 'Без срока';
    if (v == null || v === '') return 'нет данных';
    const d = new Date(typeof v === 'number' && v < 1e11 ? v * 1000 : v);
    return Number.isFinite(d.getTime()) ? d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'нет данных';
  };
  const S = { wired: false, loading: false, modelLoading: false, busy: false, sequence: 0,
    state: null, tokenId: null, models: [], modelsReady: false, drafts: new Map(), routeObserver: null, routeTimer: null };
  const token = () => S.state?.tokens.find(t => t.id === S.tokenId);
  // 🪤 В выпадашке только рабочие ключи. Выключенный (`status !== 1`) выбрать нельзя -
  // кнопка «Использовать ключ» на нём остаётся серой, - но сама строка в списке читается
  // как предложение и путает: 25.10 владелец показал в селекте служебный `a6-probe-…`.
  // Оставляем ещё текущий и уже подготовленный ключ: если активный выключили в кабинете,
  // он обязан остаться видимым, иначе селект молча покажет чужой.
  function visibleTokens() {
    const all = S.state?.tokens || [];
    return all.filter(t => t.status === 1 || t.id === S.tokenId || t.id === S.state?.selectedTokenId);
  }
  const draft = () => S.drafts.get(S.tokenId);
  const dirty = () => !!draft()?.dirty.size;
  const locked = () => S.loading || S.modelLoading || S.busy;
  const prepared = () => !!(S.tokenId && S.state?.prepared && S.state.selectedTokenId === S.tokenId);
  const validMap = () => !!(draft() && S.modelsReady && SLOTS.every(slot => S.models.includes(draft().values[slot])));
  function usableKey() {
    const t = token();
    return !!(t && t.status === 1 && (t.unlimited || t.remainingUsd == null || Number(t.remainingUsd) > 0) &&
      (t.expires == null || Number(t.expires) <= 0 || Number(t.expires) * (Number(t.expires) < 1e11 ? 1000 : 1) > Date.now()));
  }
  const editable = () => !!(S.state?.canWrite && !locked() && S.modelsReady && S.models.length && usableKey());
  const canUseKey = () => !!(S.state?.canWrite && !locked() && usableKey() && S.modelsReady && S.models.length && !prepared());
  const canSave = () => editable() && prepared() && dirty() && validMap();
  const canActivate = () => !!(S.state?.canWrite && !locked() && usableKey() && prepared() && validMap() && !dirty());
  async function api(name, body) {
    const r = await fetch(API + name, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok || d.ok === false) throw new Error(d.error || 'a6api: HTTP ' + r.status);
    return d;
  }
  function error(text) { byId('a6-error').hidden = !text; byId('a6-error').textContent = text || ''; }
  function shell() {
    if (S.wired) return;
    const root = byId('a6api-root'); if (!root) return;
    root.innerHTML = `
      <header class="a6-head"><div><h1>a6api</h1><p class="a6-muted">Claude Code на одном платном аккаунте</p></div>
        <div class="a6-row"><button id="a6-refresh" class="a6-btn" data-a6="refresh">Обновить</button><a class="a6-btn" href="https://a6api.vip/console" target="_blank" rel="noopener">Кабинет</a></div></header>
      <div id="a6-error" class="a6-notice a6-error" role="alert" hidden></div>
      <div id="a6-local" class="a6-notice" hidden>Только просмотр. Чтобы изменить настройки, откройте дашборд через localhost на основной машине.</div>
      <section class="a6-account" aria-label="Аккаунт a6api"><div><span class="a6-muted">Общий баланс</span><strong id="a6-balance" class="a6-balance a6-mono">нет данных</strong></div>
        <div class="a6-account-spend"><span class="a6-muted">Расход аккаунта</span><span id="a6-account-spent" class="a6-mono">нет данных</span></div>
        <span id="a6-connection" class="a6-status" role="status">Не подготовлен</span></section>
      <div class="a6-layout">
        <section class="a6-panel a6-key-panel" aria-labelledby="a6-key-title"><h2 id="a6-key-title">Ключ для Claude Code</h2>
          <p id="a6-active-key" class="a6-muted"></p>
          <label class="a6-field a6-key-select"><span>Ключ из кабинета</span><select id="a6-token" class="a6-select"></select></label>
          <div id="a6-key-info"></div><button id="a6-use-key" class="a6-btn" data-a6="use-key">Использовать ключ</button>
          <p id="a6-key-note" class="a6-muted">Подготовит a6api локально, не переключая Claude Code.</p></section>
        <section class="a6-panel a6-model-panel" aria-labelledby="a6-main-title">
          <label class="a6-field a6-main-field"><span id="a6-main-title">Основное окно</span><select id="a6-model-default" class="a6-select a6-main-model a6-mono" aria-describedby="a6-model-note"></select></label>
          <div id="a6-cmd-default" class="a6-cmd-row"></div>
          <p id="a6-model-note" class="a6-muted"></p>
          <div class="a6-subagents"><h2>Субагенты</h2><div class="a6-tier-grid">${['opus', 'sonnet', 'haiku'].map(slot => `<label class="a6-field"><span>${slot[0].toUpperCase() + slot.slice(1)}</span><select id="a6-model-${slot}" class="a6-select a6-mono"></select></label>`).join('')}</div><div id="a6-cmd-tiers" class="a6-cmd-row a6-cmd-tiers"></div></div>
          <div class="a6-save-row"><span id="a6-draft-status" class="a6-muted" role="status"></span><button id="a6-save" class="a6-btn" data-a6="save">Сохранить модели</button></div>
          <div class="a6-route-note"><p id="a6-routes-hint" class="a6-muted">Субагенты идут тирами Opus, Sonnet и Haiku; они общие с вкладкой «Маршруты». Субагенты другого провайдера - через /model multi там же. Основная модель для /model настраивается отдельно.</p><button class="a6-btn a6-small" data-a6="routes">Маршруты</button></div>
        </section>
      </div>
      <section class="a6-activation" aria-label="Подключение Claude Code"><div><button id="a6-activate" class="a6-btn a6-primary" data-a6="activate">Активировать для Claude Code</button><p id="a6-activation-note" class="a6-muted">Переключит текущий бэкенд Claude Code на a6api.</p></div>
        <div class="a6-command"><span class="a6-muted">Для отдельного окна</span><button class="a6-btn a6-mono" data-a6="copy-command" aria-label="Скопировать /model a6api[1m]">/model a6api[1m]</button></div></section>`;
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-a6]'); if (!b || b.disabled) return;
      // Команда у конкретной модели: текст берём из её же data-cmd, чтобы бейдж и
      // буфер не могли разойтись.
      if (b.dataset.a6 === 'copy-cmd') return copyRendered(b);
      const actions = { refresh: load, 'use-key': useKey, save: saveModels, activate, routes: openRoutes, 'copy-command': copyCommand };
      return Promise.resolve(actions[b.dataset.a6]?.()).catch(e => error(e.message));
    });
    byId('a6-token').addEventListener('change', () => selectToken(Number(byId('a6-token').value)));
    for (const slot of SLOTS) byId('a6-model-' + slot).addEventListener('change', () => selectModel(slot));
    S.wired = true;
  }
  function reconcileDraft() {
    if (!S.tokenId || !S.modelsReady) return;
    const saved = S.state?.modelMap || {};
    let d = draft();
    if (!d) {
      const values = Object.fromEntries(SLOTS.map(slot => {
        const value = typeof saved[slot] === 'string' ? saved[slot] : '';
        return [slot, S.tokenId === S.state.selectedTokenId || S.models.includes(value) ? value : ''];
      }));
      d = { values, base: { ...values }, dirty: new Set() }; S.drafts.set(S.tokenId, d);
    } else if (S.tokenId === S.state.selectedTokenId) {
      for (const slot of SLOTS) {
        const value = typeof saved[slot] === 'string' ? saved[slot] : '';
        if (!d.dirty.has(slot)) d.values[slot] = value;
        d.base[slot] = value;
        if (d.values[slot] === value) d.dirty.delete(slot);
      }
    }
  }
  // ── Команда /model под каждым селектором ──────────────────────────────────
  // Владельцу нужна готовая строка для второго окна конкретной модели, а не общая
  // `/model a6api[1m]`: тир называть обязательно, иначе то же окно получит `default`.
  // Основное окно адресуется явным именем модели (`a6api/<модель>`) - эта форма уже
  // проверена в бою и не требует правки `default`. Тир - формой `a6api[<тир>]`, её
  // понимает front-door и подменяет по тир-карте.
  // 🪤 Форму `a6api/<тир>` (слэш + имя тира) НЕ предлагаем: keepalive возвращает её
  // эхом как `<тир>[1m]`, [CC] такого имени не знает и рвёт поток - живой отказ 26.10.
  function commandFor(slot, model) {
    if (!model) return '';
    return slot === 'default' ? '/model a6api/' + model : '/model a6api[' + slot + ']';
  }
  // 🪤 Команда нужна НЕ под каждым селектором: четыре строки подряд съедали высоту
  // панели (замер 26.10: вкладка выходила за потолок 850 px при ширине 1365 на 11 px).
  // Поэтому одна строка под ОСНОВНЫМ окном (адрес отдельного окна) и одна общая
  // строка под тирами: `a6api[sonnet]` - самый ходовой, остальные в подсказке.
  function cmdChip(cmd) {
    return `<code class="a6-cmd" data-a6="copy-cmd" data-cmd="${esc(cmd)}"
        title="Клик = скопировать ${esc(cmd)}" role="button" tabindex="0">${esc(cmd)}</code>`;
  }
  function renderCmd(slot, model) {
    const box = byId('a6-cmd-' + slot); if (!box) return;
    const cmd = commandFor(slot, model);
    box.innerHTML = cmd ? cmdChip(cmd) : '';
  }
  function renderTierCmds() {
    const box = byId('a6-cmd-tiers'); if (!box) return;
    const d = draft(); if (!d) { box.innerHTML = ''; return; }
    // Показываем только те тиры, что заполнены, одной строкой через пробел.
    const cmds = ['sonnet', 'opus', 'haiku'].filter(t => d.values[t]).map(t => commandFor(t, d.values[t]));
    box.innerHTML = cmds.length ? cmds.map(cmdChip).join('') : '';
  }
  async function copyRendered(el) {
    const cmd = el?.dataset?.cmd;
    if (!cmd) return;
    try { await navigator.clipboard.writeText(cmd); window.toast?.('📋 ' + cmd, 'success', 2500); }
    catch { error('Буфер обмена недоступен. Скопируйте вручную: ' + cmd); }
  }

  function renderModels() {
    const d = draft();
    for (const slot of SLOTS) {
      const select = byId('a6-model-' + slot), value = d?.values[slot] || '';
      const missing = value && !S.models.includes(value);
      select.innerHTML = '<option value="">Выберите модель</option>' +
        (missing ? `<option value="${esc(value)}" disabled>${esc(value)} (${S.modelsReady ? 'недоступна' : 'черновик'})</option>` : '') +
        S.models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      select.value = value; select.disabled = !editable();
      renderCmd(slot, value);
    }
    renderTierCmds();
    byId('a6-model-note').textContent = S.modelLoading || S.loading ? 'Загрузка разрешённых моделей...' : !S.tokenId ? 'Выберите ключ из кабинета.' :
      !S.modelsReady ? 'Модели недоступны. Обновите данные.' : !S.models.length ? 'У ключа нет разрешённых моделей. Настройте их в кабинете.' :
      SLOTS.some(slot => d?.values[slot] && !S.models.includes(d.values[slot])) ? 'В черновике есть недоступные модели. Выберите разрешённые.' : 'Только модели, разрешённые выбранному ключу.';
    byId('a6-draft-status').textContent = S.busy ? 'Сохранение...' : dirty() ? 'Не сохранено. Черновик переживёт обновление.' :
      !d || !validMap() ? 'Выберите разрешённые модели' : prepared() ? 'Модели сохранены' : 'Выбор моделей для этого ключа';
    byId('a6-activation-note').textContent = !prepared() ? 'Сначала нажмите «Использовать ключ».' : dirty() || !validMap() ?
      'Перед активацией сохраните разрешённые модели.' : 'Переключит текущий бэкенд Claude Code на a6api.';
    byId('a6-save').disabled = !canSave();
    byId('a6-activate').disabled = !canActivate();
  }
  function render() {
    byId('a6-balance').textContent = money(S.state?.account?.balanceUsd);
    byId('a6-account-spent').textContent = money(S.state?.account?.spentUsd);
    byId('a6-local').hidden = !S.state || !!S.state.canWrite;
    const connection = byId('a6-connection');
    connection.textContent = S.state?.active ? 'Активен в Claude Code' : S.state?.prepared ? 'Подготовлен, не активен' : 'Не подготовлен';
    connection.dataset.active = String(!!S.state?.active);
    const savedToken = S.state?.tokens.find(t => t.id === S.state.selectedTokenId);
    byId('a6-active-key').textContent = savedToken ? 'Используется: ' + savedToken.name : 'Ключ ещё не выбран';
    const shown = visibleTokens();
    byId('a6-token').innerHTML = shown.map(t => `<option value="${t.id}">${esc(t.name)} #${t.id}${t.status === 1 ? '' : ' - выключен'}</option>`).join('');
    byId('a6-token').value = S.tokenId ? String(S.tokenId) : '';
    byId('a6-token').disabled = S.busy || S.loading || !shown.length;
    const t = token();
    byId('a6-key-info').innerHTML = t ? `<div class="a6-key-identity"><code class="a6-mono">${esc(t.mask || 'ключ скрыт')}</code><span class="a6-muted">${t.status === 1 ? 'Включён' : 'Выключен'}</span></div>
      <dl class="a6-key-facts"><div><dt>Расход ключа</dt><dd class="a6-mono">${money(t.spentUsd)}</dd></div><div><dt>Остаток лимита</dt><dd>${t.unlimited ? 'В пределах баланса' : money(t.remainingUsd)}</dd></div><div><dt>Действует до</dt><dd>${time(t.expires)}</dd></div></dl>` : '<p class="a6-muted">Ключей нет. Создайте ключ в кабинете a6api.</p>';
    byId('a6-use-key').disabled = !canUseKey();
    byId('a6-key-note').textContent = prepared() ? 'Этот ключ подготовлен для a6api.' : 'Подготовит a6api локально, не переключая Claude Code.';
    byId('a6-refresh').disabled = S.busy || S.loading;
    renderModels();
  }
  function acceptModels(models) {
    if (!Array.isArray(models) || models.some(m => typeof m !== 'string' || !m)) throw new Error('Не удалось прочитать разрешённые модели');
    S.models = [...new Set(models)]; S.modelsReady = true; reconcileDraft();
  }
  async function loadModels() {
    const sequence = ++S.sequence, tokenId = S.tokenId;
    S.models = []; S.modelsReady = false; S.modelLoading = !!tokenId; render();
    if (!tokenId) return;
    try {
      const d = await api('models?' + new URLSearchParams({ tokenId }));
      if (sequence !== S.sequence || tokenId !== S.tokenId) return;
      if (d.tokenId !== tokenId) throw new Error('Ответ моделей относится к другому ключу. Обновите данные.');
      acceptModels(d.models);
    } catch (e) { if (sequence === S.sequence) error(e.message); }
    finally { if (sequence === S.sequence) { S.modelLoading = false; render(); } }
  }
  async function selectToken(tokenId) {
    if (S.busy || S.loading) { render(); return; }
    if (!S.state?.tokens.some(t => t.id === tokenId)) { render(); error('Выберите ключ из списка'); return; }
    S.tokenId = tokenId; error(''); await loadModels();
  }
  function selectModel(slot) {
    if (!editable() || !draft()) { renderModels(); return; }
    const value = byId('a6-model-' + slot).value;
    if (!S.models.includes(value)) { renderModels(); error('Выберите разрешённую модель из списка'); return; }
    const d = draft(); d.values[slot] = value;
    if (value === d.base[slot]) d.dirty.delete(slot); else d.dirty.add(slot);
    error(''); renderModels();
  }
  // opts.quiet - фоновое обновление с тика дашборда (раз в 15 с).
  // 🪤 Обычная загрузка ставит `S.loading = true`, а `locked()` считает это занятостью,
  // и на время запроса (state идёт ~1 с, models ещё 0.4 с) гаснут ВСЕ кнопки и селекты.
  // Пока вкладка открыта, тик делал это каждые 15 секунд - со стороны выглядело как
  // «кнопки тухнут сами» (владелец показал 25.10). Тихий режим обновляет только цифры и
  // список ключей: управление не блокирует, модели не перечитывает, выбор ключа не меняет.
  // 🪤 Тихий прогон НЕ трогает `S.sequence`: этот счётчик обрывает чужую загрузку моделей,
  // а её `finally` при смене счётчика не снимает `modelLoading` - вкладка залипла бы
  // навсегда в состоянии «идёт загрузка», то есть ровно в том же «кнопки серые».
  async function load(opts = {}) {
    shell(); if (!S.wired || S.loading || S.busy) return;
    if (opts.quiet && S.state && S.modelsReady && !S.modelLoading) {
      try {
        const d = await api('state');
        if (!Array.isArray(d.tokens)) return;
        S.state = d;
        if (!S.busy) render();
      } catch (e) { /* сбой тихого прогона не рисуем: следующий тик повторит */ }
      return;
    }
    S.loading = true; S.modelLoading = false; S.modelsReady = false;
    const sequence = ++S.sequence; error(''); render();
    try {
      const d = await api('state');
      if (sequence !== S.sequence) return;
      if (!Array.isArray(d.tokens)) throw new Error('Не удалось прочитать ключи a6api');
      S.state = d;
      if (!d.tokens.some(t => t.id === S.tokenId)) S.tokenId = d.tokens.find(t => t.id === d.selectedTokenId)?.id || d.tokens.find(t => t.status === 1)?.id || d.tokens[0]?.id || null;
      if (S.tokenId && S.tokenId === d.selectedTokenId) acceptModels(d.models);
      else await loadModels();
    } catch (e) { error(e.message); }
    finally { S.loading = false; render(); }
  }
  async function useKey() {
    if (!canUseKey()) return;
    if (S.state.selectedTokenId && S.state.selectedTokenId !== S.tokenId &&
      !window.confirm(`Использовать ключ «${token().name}» для всех запросов a6api?\nТекущий ключ будет заменён. Бэкенд Claude Code не переключится.`)) return;
    const tokenId = S.tokenId; S.busy = true; error(''); render();
    let success = false;
    try {
      const d = await api('key', { tokenId });
      if (d.selectedTokenId !== tokenId) throw new Error('Сервер не подтвердил выбранный ключ. Обновите данные.');
      S.state.selectedTokenId = tokenId; S.state.prepared = false; success = true;
    } catch (e) { error(e.message); }
    finally { S.busy = false; render(); }
    if (success) await load();
  }
  async function saveModels() {
    if (!canSave()) return;
    const tokenId = S.tokenId, modelMap = { ...draft().values };
    S.busy = true; error(''); render();
    try {
      const d = await api('modelmap', { tokenId, modelMap });
      if (!d.modelMap || SLOTS.some(slot => d.modelMap[slot] !== modelMap[slot]) ||
        !d.routesMap || ['opus', 'sonnet', 'haiku'].some(slot => d.routesMap[slot] !== modelMap[slot])) {
        throw new Error('Сервер не подтвердил модели. Черновик сохранён, обновите данные.');
      }
      S.state.modelMap = d.modelMap; S.state.routesMap = d.routesMap;
      const current = draft(); current.base = { ...modelMap }; current.dirty.clear();
      window.toast?.('Модели сохранены', 'success');
    } catch (e) { error(e.message); }
    finally { S.busy = false; render(); }
  }
  async function activate() {
    if (!canActivate()) return;
    if (!window.confirm(`Переключить Claude Code на a6api с ключом «${token().name}»?\nОсновное окно: ${draft().values.default}\nТекущий бэкенд будет заменён.`)) return;
    const tokenId = S.tokenId; S.busy = true; error(''); render();
    try {
      const d = await api('activate', { tokenId });
      if (d.active !== true) throw new Error('Сервер не подтвердил активацию');
      S.state.active = true; window.toast?.('a6api активирован для Claude Code', 'success');
    } catch (e) { error(e.message); }
    finally { S.busy = false; render(); }
  }
  async function copyCommand() {
    try { await navigator.clipboard.writeText(COMMAND); window.toast?.('Команда скопирована', 'success'); }
    catch { error('Буфер обмена недоступен. Скопируйте команду /model a6api[1m] вручную.'); }
  }
  function openRoutes() {
    if (typeof window.showTab !== 'function') return error('Вкладка «Маршруты» недоступна');
    S.routeObserver?.disconnect(); clearTimeout(S.routeTimer);
    window.showTab('routes');
    const highlight = () => {
      const row = byId('routes-row-a6api'); if (!row) return false;
      row.scrollIntoView({ block: 'center' }); row.classList.add('a6-route-focus');
      setTimeout(() => row.classList.remove('a6-route-focus'), 2200); return true;
    };
    highlight();
    const target = byId('routes-box');
    if (target && window.MutationObserver) {
      S.routeObserver = new window.MutationObserver(highlight);
      S.routeObserver.observe(target, { childList: true, subtree: true });
      S.routeTimer = setTimeout(() => S.routeObserver.disconnect(), 5000);
    }
  }
  window.A6API = { load };
  const boot = () => { if (document.querySelector('[data-tab-content="a6api"].active')) load(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
