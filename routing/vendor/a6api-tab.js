/* a6api: one key, per-model seller pools. No automatic paid checks. */
(() => {
  'use strict';
  const API = '/__switch/api/a6api/';
  const DEFAULT_MODEL = 'deepseek-v4.1-flash-1017';
  const byId = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v, digits = 6) => v == null || !Number.isFinite(Number(v)) ? 'нет данных' : '$' + Number(v).toFixed(digits).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  const pct = v => v == null ? 'нет данных' : Number(v).toFixed(2).replace(/\.00$/, '') + '%';
  const time = v => v ? new Date(typeof v === 'number' && v < 1e11 ? v * 1000 : v).toLocaleString('ru-RU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'нет данных';
  const status = (ok, label) => `<span class="a6-status" data-ok="${ok == null ? 'unknown' : !!ok}">${esc(label)}</span>`;
  const S = { wired: false, loading: false, modelLoading: false, busy: false, sequence: 0, logSequence: 0, reviewSequence: 0,
    state: null, tokenId: null, model: DEFAULT_MODEL, data: null, draft: null, dirty: false,
    filter: '', selectedOnly: false, selectedKey: '', drafts: new Map() };
  async function api(name, body) {
    const r = await fetch(API + name, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok || d.ok === false) throw Object.assign(new Error(d.error || 'a6api: HTTP ' + r.status), { code: d.code, writeAccepted: d.writeAccepted });
    return d;
  }
  function error(text) { byId('a6-error').hidden = !text; byId('a6-error').textContent = text || ''; }
  function shell() {
    if (S.wired) return;
    const root = byId('a6api-root'); if (!root) return;
    root.innerHTML = `
      <header class="a6-head"><div><h1>a6api</h1><p class="a6-muted">Модели, продавцы и маршрут вашего ключа</p></div>
        <div class="a6-row"><button class="a6-btn" data-a6="refresh">↻ Обновить</button><a class="a6-btn" href="https://a6api.com/console" target="_blank" rel="noopener">Кабинет ↗</a></div></header>
      <div id="a6-error" class="a6-notice a6-error" role="alert" hidden></div>
      <div id="a6-local" class="a6-notice" hidden>Просмотр через сеть. Для изменения маршрута и копирования ключа откройте этот дашборд через localhost на основной машине.</div>
      <div class="a6-summary">
        <section class="a6-panel"><div class="a6-controls">
          <label class="a6-field"><span>Ключ</span><select id="a6-token" class="a6-select"></select></label>
          <label class="a6-field"><span>Модель</span><input id="a6-model" class="a6-input a6-mono" list="a6-model-list" autocomplete="off"><datalist id="a6-model-list"></datalist></label>
        </div><div id="a6-key-info"></div><div class="a6-key-line"><button class="a6-btn a6-small" data-a6="copy-key">Копировать ключ</button><button class="a6-btn a6-small" data-a6="copy-model">Модель</button><button class="a6-btn a6-small" data-a6="copy-url">Адрес API</button></div>
        <div class="a6-key-line"><span id="a6-whitelist" class="a6-muted"></span><button id="a6-enable" class="a6-btn a6-small" data-a6="enable" hidden>Разрешить модель</button></div></section>
        <section class="a6-panel"><div class="a6-row"><h2>Маршрут модели</h2><span id="a6-route-mode" class="a6-muted"></span></div>
          <div id="a6-pool" class="a6-route-strip"></div>
          <div class="a6-route-controls"><label class="a6-field"><span>Порядок продавцов</span><select id="a6-strategy" class="a6-select"><option value="price_asc">Сначала дешевле</option><option value="latency_asc">Сначала быстрее</option><option value="success_desc">Сначала надёжнее</option><option value="user_priority_desc">Вручную</option></select></label>
          <label class="a6-field"><span>Потолок входа, $ / 1M</span><input id="a6-input-cap" class="a6-input a6-mono" type="number" min="0" step="0.000001"></label>
          <label class="a6-field"><span>Потолок выхода, $ / 1M</span><input id="a6-output-cap" class="a6-input a6-mono" type="number" min="0" step="0.000001"></label></div>
          <div class="a6-route-foot"><span id="a6-draft-status"></span><div class="a6-row"><button class="a6-btn" data-a6="reset">Отменить правки</button><button id="a6-save" class="a6-btn a6-primary" data-a6="save">Сохранить маршрут</button></div></div>
        </section></div>
      <section class="a6-panel a6-data"><div class="a6-table-head"><div><h2>Продавцы</h2><p id="a6-catalog-info" class="a6-muted"></p></div>
        <div class="a6-row"><input id="a6-filter" class="a6-input" placeholder="Поиск продавца или канала" aria-label="Поиск продавца"><label class="a6-row"><input id="a6-selected" type="checkbox"> Только пул</label></div></div>
        <div class="a6-table-wrap"><table class="a6-table"><thead><tr><th>В пул</th><th>Продавец / канал</th><th>Вход / выход за 1M</th><th>Отзывы</th><th>Успешность</th><th>Первый токен</th><th>Наши пробы</th></tr></thead><tbody id="a6-sellers"></tbody></table></div>
        <p class="a6-empty">Успешность запросов не равна аптайму. Отзывы и статистика площадки не гарантируют подлинность модели.</p></section>
      <section id="a6-reviews" class="a6-panel" hidden><div class="a6-head"><h2>Отзывы о канале</h2><button class="a6-btn a6-small" data-a6="close-reviews">Закрыть</button></div><div id="a6-review-items"></div></section>
      <section class="a6-panel a6-data"><div class="a6-table-head"><div><h2>Расход ключа</h2><p class="a6-muted">Последние запросы выбранной модели, по данным a6api</p></div><button class="a6-btn a6-small" data-a6="logs">Обновить журнал</button></div><div class="a6-table-wrap"><table class="a6-table"><thead><tr><th>Время</th><th>Канал</th><th>Вход / выход</th><th>Списано</th><th>Время ответа</th></tr></thead><tbody id="a6-log-rows"></tbody></table></div></section>`;
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-a6]'); if (!b || b.disabled) return;
      const action = b.dataset.a6;
      const operations = { refresh: load, save, reset, enable, 'copy-key': copyKey, 'copy-model': () => copy(S.model), 'copy-url': () => copy('https://api.a6api.com/v1'), logs: loadLogs,
        reviews: () => showReviews(Number(b.dataset.id)), 'close-reviews': () => { byId('a6-reviews').hidden = true; },
        remove: () => toggleChannel(Number(b.dataset.id), false), up: () => move(Number(b.dataset.id), -1), down: () => move(Number(b.dataset.id), 1) };
      return Promise.resolve(operations[action]?.()).catch(e => error(e.message));
    });
    byId('a6-token').addEventListener('change', () => select(Number(byId('a6-token').value), S.model));
    byId('a6-model').addEventListener('change', () => select(S.tokenId, byId('a6-model').value.trim()));
    byId('a6-filter').addEventListener('input', () => { S.filter = byId('a6-filter').value; renderSellers(); });
    byId('a6-selected').addEventListener('change', () => { S.selectedOnly = byId('a6-selected').checked; renderSellers(); });
    byId('a6-sellers').addEventListener('change', e => { if (e.target.dataset.channel) toggleChannel(Number(e.target.dataset.channel), e.target.checked); });
    for (const id of ['a6-strategy', 'a6-input-cap', 'a6-output-cap']) byId(id).addEventListener('input', capture);
    S.wired = true;
  }
  function selectedToken() { return S.state?.tokens.find(t => t.id === S.tokenId); }
  function restricted() { const t = selectedToken(); return !!(S.model && t?.restricted && !t.models.includes(S.model)); }
  function editable() {
    return !!(S.state?.canWrite && !S.busy && !S.loading && !S.modelLoading && S.data && S.data.canWrite !== false &&
      !S.data.route.pin && S.draft?.tokenId === S.tokenId && S.draft?.model === S.model);
  }
  function renderControls() {
    const locked = S.busy || S.loading;
    byId('a6-token').disabled = locked || !S.state?.tokens.length;
    byId('a6-model').disabled = locked || !S.tokenId || !S.state?.models.length;
    for (const id of ['a6-strategy', 'a6-input-cap', 'a6-output-cap']) byId(id).disabled = !editable();
    byId('a6-enable').disabled = locked || S.modelLoading || !S.state?.canWrite || !S.tokenId || !S.model;
    for (const b of byId('a6api-root').querySelectorAll('[data-a6]')) {
      if (b.dataset.a6 === 'refresh') b.disabled = locked;
      if (b.dataset.a6 === 'reset') b.disabled = !editable() || !S.dirty;
      if (b.dataset.a6 === 'copy-key') b.disabled = locked || !S.state?.canWrite || !S.tokenId;
      if (b.dataset.a6 === 'copy-model' || b.dataset.a6 === 'logs') b.disabled = locked || S.modelLoading || !S.tokenId || !S.model;
    }
  }
  function capture(e) {
    if (!editable()) return;
    S.draft.strategy = byId('a6-strategy').value;
    S.draft.caps.input_price_micros = Math.round(Number(byId('a6-input-cap').value) * 1e6);
    S.draft.caps.output_price_micros = Math.round(Number(byId('a6-output-cap').value) * 1e6);
    S.dirty = true;
    if (e?.target.id === 'a6-strategy') renderPool(); else renderDraftStatus();
  }
  function renderDraftStatus() {
    byId('a6-draft-status').textContent = S.busy ? 'Сохранение...' : S.loading || S.modelLoading ? 'Загрузка маршрута...' :
      S.dirty ? 'Не сохранено. Обновление не сбрасывает черновик.' : 'Только выбранные продавцы, без всего рынка';
    byId('a6-save').disabled = !editable() || !S.dirty || restricted() || !S.draft?.channels.length;
    renderControls();
  }
  function renderKey() {
    const t = selectedToken();
    byId('a6-key-info').innerHTML = t ? `<div class="a6-key-line"><code class="a6-mono">${esc(t.mask || 'ключ скрыт')}</code>${status(t.status === 1, t.status === 1 ? 'Включён' : 'Выключен')}</div>
      <dl class="a6-facts"><div class="a6-fact"><dt>Баланс аккаунта</dt><dd>${money(S.state.account?.balanceUsd, 4)}</dd></div><div class="a6-fact"><dt>Расход этого ключа</dt><dd>${money(t.spentUsd)}</dd></div><div class="a6-fact"><dt>Лимит ключа</dt><dd class="a6-fact-small">${t.unlimited ? 'В пределах баланса' : money(t.remainingUsd)}</dd></div><div class="a6-fact"><dt>Действует до</dt><dd class="a6-fact-small">${t.expires === -1 ? 'Без срока' : time(t.expires)}</dd></div></dl>` : '<p class="a6-muted">В кабинете нет ключей. Создайте ключ в a6api.</p>';
    byId('a6-whitelist').textContent = !t || !S.model ? 'Выберите ключ и модель' : restricted() ? 'Модель не разрешена этому ключу' : 'Модель разрешена ключу';
    byId('a6-enable').hidden = !restricted();
    byId('a6-local').hidden = !!S.state?.canWrite;
    renderControls();
  }
  function freshDraft(route) {
    const channels = [...route.channels];
    if (route.strategy === 'user_priority_desc') channels.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return { tokenId: S.tokenId, model: S.model, baselineId: route.id, baselineVersion: route.version,
      strategy: route.strategy || 'price_asc', channels: channels.map(c => c.channelId), caps: { ...route.caps },
      confirmedPrices: Object.fromEntries(S.data.catalog.items.map(x => [x.channelId, { ...x.prices }])) };
  }
  function renderPool() {
    if (!S.draft || !S.data) {
      byId('a6-route-mode').textContent = '';
      byId('a6-pool').textContent = S.loading || S.modelLoading ? 'Загрузка маршрута...' : 'Нет данных маршрута';
      byId('a6-pool').innerHTML = `<span class="a6-muted">${esc(byId('a6-pool').textContent)}</span>`;
      byId('a6-strategy').value = S.draft?.strategy || 'price_asc';
      byId('a6-input-cap').value = S.draft?.caps.input_price_micros ? S.draft.caps.input_price_micros / 1e6 : '';
      byId('a6-output-cap').value = S.draft?.caps.output_price_micros ? S.draft.caps.output_price_micros / 1e6 : '';
      renderDraftStatus(); return;
    }
    const route = S.data.route;
    byId('a6-route-mode').textContent = route.pin ? 'Закреп #' + route.pin.channelId + ' обходит пул' : route.autoPool || route.fallback ? 'Есть широкий маршрут в кабинете' : 'Ручной пул';
    byId('a6-pool').innerHTML = S.draft.channels.length ? S.draft.channels.map((id, i) => {
      const x = S.data.catalog.items.find(x => x.channelId === id) || route.channels.find(x => x.channelId === id) || {};
      return `<div class="a6-chip"><span>${esc(x.supplier || x.name || 'Канал')} <small class="a6-muted">#${id}</small></span>${S.draft.strategy === 'user_priority_desc' ? `<button class="a6-btn a6-small" data-a6="up" data-id="${id}" aria-label="Выше в очереди" ${!editable() || i === 0 ? 'disabled' : ''}>↑</button><button class="a6-btn a6-small" data-a6="down" data-id="${id}" aria-label="Ниже в очереди" ${!editable() || i === S.draft.channels.length - 1 ? 'disabled' : ''}>↓</button>` : ''}<button class="a6-btn a6-small" data-a6="remove" data-id="${id}" aria-label="Убрать из пула" ${!editable() ? 'disabled' : ''}>×</button></div>`;
    }).join('') : '<span class="a6-muted">Отметьте продавцов в таблице ниже</span>';
    byId('a6-strategy').value = S.draft.strategy;
    byId('a6-input-cap').value = S.draft.caps.input_price_micros ? S.draft.caps.input_price_micros / 1e6 : '';
    byId('a6-output-cap').value = S.draft.caps.output_price_micros ? S.draft.caps.output_price_micros / 1e6 : '';
    for (const id of ['a6-strategy', 'a6-input-cap', 'a6-output-cap']) byId(id).disabled = !editable();
    renderDraftStatus();
  }
  function renderSellers() {
    if (!S.data) {
      byId('a6-catalog-info').textContent = '';
      byId('a6-sellers').innerHTML = `<tr><td colspan="7" class="a6-empty">${S.loading || S.modelLoading ? 'Загрузка продавцов...' : 'Нет данных для выбранного ключа и модели'}</td></tr>`;
      return;
    }
    const q = S.filter.toLowerCase();
    const rows = S.data.catalog.items.filter(x => (!q || `${x.supplier} ${x.channel} ${x.channelId}`.toLowerCase().includes(q)) && (!S.selectedOnly || S.draft?.channels.includes(x.channelId)));
    byId('a6-catalog-info').textContent = `${rows.length} каналов · ${S.data.catalog.stale ? 'Кеш площадки' : 'Данные площадки'} · ${time(S.data.catalog.snapshot || Date.now())}`;
    byId('a6-sellers').innerHTML = rows.length ? rows.map(x => {
      const picked = S.draft?.channels.includes(x.channelId), p = S.data.probes?.[x.channelId];
      return `<tr data-selected="${!!picked}"><td><input type="checkbox" data-channel="${x.channelId}" aria-label="Добавить ${esc(x.supplier)} в пул" ${picked ? 'checked' : ''} ${!editable() || !x.available ? 'disabled' : ''}></td>
        <td class="a6-seller">${esc(x.supplier)}<small>${esc(x.channel)} · #${x.channelId}</small>${!x.available ? status(false, 'Недоступен') : ''}</td>
        <td class="a6-price">${money(x.inputUsd)} / ${money(x.outputUsd)}<small>кэш ${money(x.cacheUsd)}</small></td>
        <td>${x.reviews ? `<button class="a6-btn a6-small" data-a6="reviews" data-id="${x.listingId}">${x.rating == null ? '?' : esc(x.rating)} / 5 · ${x.reviews}</button>` : '<span class="a6-muted">нет отзывов</span>'}</td>
        <td class="a6-price">${pct(x.success24h)}<small>за 24 ч</small><small>последние: ${pct(x.recentSuccess)} · n=${x.samples ?? '?'}</small></td>
        <td class="a6-price">${x.ttftMs ? (x.ttftMs / 1000).toFixed(1) + ' с' : 'нет данных'}</td>
        <td><div class="a6-stack">${status(p?.tools, 'tools')}${status(p?.vision, 'vision')}${status(p?.combined, 'вместе')}</div>${p?.at ? `<small>${time(p.at)}</small>` : '<small>не проверяли</small>'}</td></tr>`;
    }).join('') : '<tr><td colspan="7" class="a6-empty">Нет каналов по выбранному фильтру</td></tr>';
  }
  function toggleChannel(id, checked) {
    if (!editable() || !S.draft) return;
    if (checked && !S.draft.channels.includes(id)) {
      const x = S.data.catalog.items.find(x => x.channelId === id && x.available); if (!x) return;
      S.draft.channels.push(id); S.draft.confirmedPrices[id] = { ...x.prices };
      for (const k of ['input_price_micros', 'output_price_micros']) S.draft.caps[k] = Math.max(S.draft.caps[k] || 0, x.prices[k] || 0);
    } else if (!checked) S.draft.channels = S.draft.channels.filter(x => x !== id);
    S.dirty = true; renderPool(); renderSellers();
  }
  function move(id, delta) {
    if (!editable()) return;
    const i = S.draft.channels.indexOf(id), j = i + delta;
    if (i < 0 || j < 0 || j >= S.draft.channels.length) return;
    [S.draft.channels[i], S.draft.channels[j]] = [S.draft.channels[j], S.draft.channels[i]];
    S.dirty = true; renderPool();
  }
  function rememberDraft() {
    if (S.selectedKey && S.dirty && S.draft) S.drafts.set(S.selectedKey, { draft: S.draft, dirty: true });
  }
  function activateSelection(tokenId, model) {
    const key = tokenId && model ? tokenId + '|' + model : '';
    if (key !== S.selectedKey) {
      rememberDraft();
      const saved = S.drafts.get(key);
      S.draft = saved?.draft || null; S.dirty = !!saved?.dirty; S.data = null;
    }
    S.tokenId = tokenId; S.model = model; S.selectedKey = key;
    byId('a6-model').value = model; byId('a6-token').value = tokenId ? String(tokenId) : '';
  }
  async function select(tokenId, model) {
    if (S.busy || S.loading) {
      byId('a6-model').value = S.model; byId('a6-token').value = S.tokenId ? String(S.tokenId) : ''; return;
    }
    if (!S.state?.models.includes(model) || !S.state.tokens.some(t => t.id === tokenId)) {
      byId('a6-model').value = S.model; byId('a6-token').value = S.tokenId ? String(S.tokenId) : '';
      error('Выберите ключ и модель из каталога'); return;
    }
    error(''); activateSelection(tokenId, model); renderKey();
    await loadModel();
  }
  async function loadModel() {
    const sequence = ++S.sequence, tokenId = S.tokenId, model = S.model;
    ++S.logSequence; ++S.reviewSequence;
    byId('a6-reviews').hidden = true;
    byId('a6-log-rows').innerHTML = '<tr><td colspan="5" class="a6-empty">Выберите ключ и модель</td></tr>';
    S.data = null; S.modelLoading = !!(tokenId && model); renderPool(); renderSellers();
    if (!S.modelLoading) return;
    try {
      const d = await api('model?' + new URLSearchParams({ tokenId, model }));
      if (sequence !== S.sequence) return;
      S.data = d; if (!S.dirty || !S.draft) S.draft = freshDraft(d.route);
      S.modelLoading = false; renderPool(); renderSellers(); await loadLogs();
    } catch (e) { if (sequence === S.sequence) error(e.message); }
    finally {
      if (sequence === S.sequence) { S.modelLoading = false; renderPool(); renderSellers(); }
    }
  }
  async function load() {
    shell(); if (!S.wired || S.loading || S.busy) return;
    S.loading = true; S.modelLoading = false; ++S.sequence; ++S.logSequence; ++S.reviewSequence;
    error(''); renderPool(); renderSellers();
    try {
      S.state = await api('state');
      const tokenId = S.state.tokens.some(t => t.id === S.tokenId) ? S.tokenId : (S.state.tokens.find(t => t.name === 'deepseek') || S.state.tokens[0])?.id || null;
      const model = S.state.models.includes(S.model) ? S.model : S.state.models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : (S.state.models[0] || '');
      byId('a6-token').innerHTML = S.state.tokens.map(t => `<option value="${t.id}">${esc(t.name)} #${t.id}</option>`).join('');
      byId('a6-model-list').innerHTML = S.state.models.map(m => `<option value="${esc(m)}"></option>`).join('');
      activateSelection(tokenId, model); renderKey(); await loadModel();
    } catch (e) { error(e.message); }
    finally { S.loading = false; renderPool(); renderSellers(); }
  }
  async function loadLogs() {
    const sequence = ++S.logSequence, tokenId = S.tokenId, model = S.model;
    if (!tokenId || !model) return;
    byId('a6-log-rows').innerHTML = '<tr><td colspan="5" class="a6-empty">Загрузка журнала...</td></tr>';
    const current = () => sequence === S.logSequence && tokenId === S.tokenId && model === S.model;
    try {
      const d = await api('logs?' + new URLSearchParams({ tokenId, model }));
      if (!current()) return;
      byId('a6-log-rows').innerHTML = d.items.length ? d.items.map(x => `<tr><td>${time(x.at)}</td><td>#${esc(x.channelId ?? '?')}</td><td class="a6-mono">${esc(x.input ?? '?')} / ${esc(x.output ?? '?')}</td><td class="a6-price">${money(x.usd)}</td><td>${x.duration == null ? 'нет данных' : esc(x.duration) + ' с'}</td></tr>`).join('') : '<tr><td colspan="5" class="a6-empty">У этого ключа пока нет запросов выбранной модели</td></tr>';
    } catch (e) { if (current()) byId('a6-log-rows').innerHTML = `<tr><td colspan="5" class="a6-empty">Журнал недоступен: ${esc(e.message)}</td></tr>`; }
  }
  function reset() {
    if (!editable()) return;
    S.draft = freshDraft(S.data.route); S.dirty = false; S.drafts.delete(S.selectedKey); error(''); renderPool(); renderSellers();
  }
  async function save() {
    if (!editable() || !S.dirty || restricted()) return;
    if (!S.draft.channels.length) return error('Оставьте хотя бы одного продавца');
    const before = S.data.route.channels.map(x => '#' + x.channelId).join(', ') || 'маршрут по умолчанию';
    const after = S.draft.channels.map(x => '#' + x).join(', ');
    if (!window.confirm(`Сохранить маршрут ${S.model}?\n${before} → ${after}\nВход до ${money(S.draft.caps.input_price_micros / 1e6)}, выход до ${money(S.draft.caps.output_price_micros / 1e6)} за 1M.\nАвтопул и выход на весь рынок будут выключены.`)) return;
    S.busy = true; renderPool(); renderSellers(); error('');
    try {
      const d = await api('route', S.draft); S.data.route = d.route; S.dirty = false; S.drafts.delete(S.selectedKey);
      S.draft = freshDraft(d.route); window.toast?.('Маршрут сохранён и проверен', 'success');
    } catch (e) { error(e.message + (e.writeAccepted ? ' Запись была принята сервером; обновите данные перед повтором.' : '')); }
    finally { S.busy = false; renderPool(); renderSellers(); }
  }
  async function enable() {
    if (!S.state?.canWrite || S.busy || S.loading || S.modelLoading || !restricted()) return;
    if (!window.confirm(`Разрешить ${S.model} ключу ${selectedToken().name}? Старые модели останутся.`)) return;
    S.busy = true; error(''); renderPool(); renderSellers();
    let enabled = false;
    try { await api('enable-model', { tokenId: S.tokenId, model: S.model }); enabled = true; }
    catch (e) { error(e.message); }
    finally { S.busy = false; renderPool(); renderSellers(); }
    if (enabled) await load();
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); window.toast?.('Скопировано', 'success'); }
    catch { error('Буфер обмена недоступен. Откройте дашборд через localhost.'); }
  }
  async function copyKey() {
    if (!S.state?.canWrite || !S.tokenId) return error('Копирование ключа доступно только через localhost');
    if (!window.confirm('Скопировать полный API-ключ в буфер обмена?')) return;
    const d = await api('reveal', { tokenId: S.tokenId }); await copy(d.key);
  }
  async function showReviews(listingId) {
    const sequence = ++S.reviewSequence;
    byId('a6-reviews').hidden = false; byId('a6-review-items').textContent = 'Загрузка отзывов...';
    try {
      const d = await api('reviews?' + new URLSearchParams({ listingId }));
      if (sequence !== S.reviewSequence) return;
      byId('a6-review-items').innerHTML = d.items.length ? d.items.map(x => `<article class="a6-review"><div class="a6-row"><strong>${esc(x.rating)} / 5</strong><span class="a6-muted">${esc(x.user)} · ${time(x.at)}</span></div><p>${esc(x.text || 'Оценка без текста')}</p>${x.reply ? `<p class="a6-muted">Продавец: ${esc(x.reply)}</p>` : ''}</article>`).join('') : '<p class="a6-muted">Отзывов пока нет</p>';
    } catch (e) { if (sequence === S.reviewSequence) byId('a6-review-items').textContent = e.message; }
  }
  window.A6API = { load, save, toggleChannel };
  const boot = () => { if (document.querySelector('[data-tab-content="a6api"].active')) load(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
