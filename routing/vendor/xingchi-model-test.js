(() => {
  'use strict';
  const API = '/__switch/api/xc/model-tests';
  const S = { accounts: [], accountId: '', results: {}, pending: new Set(), sequence: 0, readError: '', signature: '' };
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const slots = () => [...document.querySelectorAll('[data-xc-test]')];
  function button(model) {
    return `<button type="button" data-xc-test="${esc(model)}" onclick="event.stopPropagation()" class="px-2 py-1 rounded text-[11px]" aria-label="Тест: ${esc(model)}">▶ Тест</button>`;
  }
  function paint() {
    for (const button of slots()) {
      const model = button.dataset.xcTest, result = S.results[model];
      const busy = S.pending.has(JSON.stringify([S.accountId, model]));
      const image = model.startsWith('gpt-image-');
      const stale = result && Date.now() - result.checkedAt >= 600000;
      button.disabled = image || busy || !S.accountId;
      button.classList.add('xc-test-button');
      button.textContent = image ? 'Нет теста' : busy ? '⏳ Тест' : result ?
        `${result.status === 'ok' ? '✓' : '✕'} ${stale ? 'Повторить · старый' : 'Тест'}` : '▶ Тест';
      button.style.color = result ? (result.status === 'ok' ? '#86efac' : '#fca5a5') : '';
      button.style.background = result ? (result.status === 'ok' ? '#14532d' : '#7f1d1d') : '';
      button.style.opacity = stale || image ? '0.65' : '1';
      button.title = image ? 'Генерация изображений не запускается' : busy ? 'Один запрос выполняется' : result ?
        `${result.status === 'ok' ? 'Ответ получен' : result.error} · HTTP ${result.httpStatus ?? '-'} · ${(result.latencyMs / 1000).toFixed(1)}с · ${new Date(result.checkedAt).toLocaleString()}${stale ? ' · результат устарел' : ''}` : S.readError || 'Один короткий платный запрос; модель не переключается';
      button.setAttribute('aria-description', button.title);
      button.onclick = event => { event.stopPropagation(); run(model); };
    }
    const note = document.getElementById('xc-test-note');
    if (note) note.textContent = S.readError || 'Один запрос по кнопке · кеш 10 мин · без автотестов';
  }
  async function request(url, body) {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(75000),
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(response.status === 404 ? 'Серверу нужен restart для тестов' : data.error || `HTTP ${response.status}`);
    return data;
  }
  async function read() {
    const sequence = ++S.sequence, id = S.accountId;
    S.results = {}; S.readError = ''; paint();
    if (!id) return;
    try {
      const data = await request(API + '?accountId=' + encodeURIComponent(id));
      if (sequence !== S.sequence) return;
      S.results = data.results || {};
    } catch (e) { if (sequence === S.sequence) S.readError = e.message; }
    paint();
  }
  async function run(model) {
    const id = S.accountId, signature = S.signature, token = JSON.stringify([id, model]);
    if (!id || model.startsWith('gpt-image-') || S.pending.has(token)) return;
    S.pending.add(token); paint();
    try {
      const data = await request(API, { accountId: id, model });
      if (id === S.accountId && signature === S.signature) { S.results[model] = data.result; S.readError = ''; }
    } catch (e) { if (id === S.accountId) { S.readError = e.message; window.toast?.(e.message, 'error'); } }
    finally { S.pending.delete(token); paint(); }
  }
  function attach(accounts) {
    S.accounts = accounts.filter(a => a.api_key && a.id);
    let controls = document.getElementById('xc-test-controls');
    const list = document.getElementById('xc-models-list');
    if (!list) return;
    if (!controls) {
      controls = document.createElement('div'); controls.id = 'xc-test-controls';
      controls.className = 'flex gap-2 items-center flex-wrap mb-2 text-[11px] text-muted';
      controls.innerHTML = '<label>Тест аккаунта: <select id="xc-test-account" class="bg-elevated rounded px-2 py-1"></select></label><span id="xc-test-note"></span>';
      list.before(controls);
    }
    const select = document.getElementById('xc-test-account');
    const previous = S.accountId;
    if (!S.accounts.some(a => a.id === S.accountId)) S.accountId = (S.accounts.find(a => a.active) || S.accounts[0])?.id || '';
    select.innerHTML = S.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.email || a.name || a.id)}${a.active ? ' (активный)' : ''}</option>`).join('') || '<option value="">Нет ключей</option>';
    select.value = S.accountId;
    select.onchange = () => { S.accountId = select.value; S.signature = ''; attach(S.accounts); };
    const row = S.accounts.find(a => a.id === S.accountId);
    const signature = JSON.stringify([row?.id, row?.api_key]);
    if (signature !== S.signature || previous !== S.accountId) { S.signature = signature; read(); }
    paint();
  }
  const style = document.createElement('style');
  style.textContent = '.xc-test-button{min-height:28px;white-space:nowrap;cursor:pointer}.xc-test-button:disabled{cursor:default}.xc-test-button:focus-visible{outline:2px solid var(--color-azure,#2997ff);outline-offset:2px}@media(pointer:coarse){.xc-test-button{min-height:44px;min-width:44px}}#xc-test-controls select{max-width:100%}';
  document.head.append(style);
  setInterval(paint, 15000); // Repaint age only; never issue an automatic probe.
  window.XingchiModelTest = { button, attach };
})();
