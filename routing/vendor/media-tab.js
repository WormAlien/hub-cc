/* ════════════════════════════════════════════════════════════════════════════
   media-tab.js — вкладка «MEDIA» дашборда ABUSE HUB (:8200)
   Неймспейс: window.MEDIA. Точка входа: MEDIA.load().

   Студия генерации: слева задание, по центру результат, справа библиотека.
   Ключей эта вкладка НЕ хранит и НЕ показывает — они живут у провайдера, а
   сюда приходит только маска и признак «ключ есть». Разбор — вика,
   «MEDIA API — вкладка генерации изображений и видео».

   🪤 Работа идёт в СЕРВЕРНОЙ очереди, не в этой вкладке. Закрытая вкладка не
      должна убивать оплаченную генерацию, поэтому здесь только опрос статуса.

   🪤 Модель с пометкой «уточни» — это не поломка, а честное «параметры никто
      не подтверждал». Половина каталога шлюза — алиасы, которых нет в
      документации вендора: у них дефолты формы взяты с потолка.

   Стиль (тот же контракт, что у models-tab.js):
     • только токены тем: bg/surface/elevated/line/line-soft/ink/muted/dim
       и акценты emerald/amber/azure/violet/crimson;
     • `rose` НЕ используется: в теме zen неотличим от crimson;
     • `bg-white/…` невидим на светлых темах — не применять;
     • статус НИКОГДА не одним цветом: цвет + знак + слово.

   Классы `md-*` — в /vendor/media-tab.css. Здесь только разметка.
   ════════════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const API = '/__media/api/';

  const S = {
    providers: [],
    providerId: null,
    mode: 'image',            // image | video
    models: { image: [], video: [] },
    modelId: null,
    scannedAt: null,
    loading: false,
    scanning: false,
    err: null,
    advanced: false,
    jobs: [],
    history: [],
    selected: null,           // job для центральной колонки
    pollTimer: null,
  };

  // ── Утилиты ───────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  async function api(path, opts) {
    const res = await fetch(API + path, opts);
    const text = await res.text();
    let doc = null;
    try { doc = JSON.parse(text); } catch { /* не JSON */ }
    if (!res.ok) throw new Error((doc && doc.error) || `HTTP ${res.status}`);
    return doc;
  }

  function say(msg, tone) {
    // Тостер дашборда, если он есть; иначе тихо в консоль — вкладка не должна
    // падать из-за отсутствия чужой функции.
    if (typeof window.toast === 'function') window.toast(msg, tone);
    else if (tone === 'err') console.error('[MEDIA]', msg);
    else console.log('[MEDIA]', msg);
  }

  function fmtBytes(n) {
    if (!n) return '—';
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' КБ';
    return (n / 1024 / 1024).toFixed(2) + ' МБ';
  }

  function fmtMs(ms) {
    if (!ms) return '—';
    return ms < 1000 ? ms + ' мс' : (ms / 1000).toFixed(1) + ' с';
  }

  // Статус — цвет + знак + слово. Ни одна из трёх частей не необязательна.
  const STATUS = {
    queued:  { cls: 'text-muted',   sign: '◦', word: 'в очереди' },
    running: { cls: 'text-azure',   sign: '◐', word: 'делается' },
    done:    { cls: 'text-emerald', sign: '✓', word: 'готово' },
    failed:  { cls: 'text-crimson', sign: '✕', word: 'ошибка' },
  };
  function statusHtml(st) {
    const s = STATUS[st] || { cls: 'text-muted', sign: '?', word: st || '—' };
    return `<span class="${s.cls}">${s.sign} ${esc(s.word)}</span>`;
  }

  // ── Загрузка данных ───────────────────────────────────────────────────────

  async function load(force) {
    S.loading = true; S.err = null; render();
    try {
      const d = await api('providers');
      S.providers = d.providers || [];
      if (!S.providerId) {
        // По умолчанию — тот, у кого медиа-моделей больше (список уже отсортирован).
        const withMedia = S.providers.find((p) => p.counts.image + p.counts.video > 0);
        S.providerId = (withMedia || S.providers[0] || {}).id || null;
      }
      await Promise.all([loadModels(force), loadHistory()]);
    } catch (e) {
      S.err = e.message || String(e);
    } finally {
      S.loading = false;
      render();
      pollJobs();
    }
  }

  async function loadModels(force) {
    if (!S.providerId) { S.models = { image: [], video: [] }; return; }
    S.scanning = Boolean(force);
    render();
    try {
      const d = await api(`models?provider=${encodeURIComponent(S.providerId)}${force ? '&force=1' : ''}`);
      S.models = { image: d.image || [], video: d.video || [] };
      S.scannedAt = d.scannedAt || null;
      const list = S.models[S.mode] || [];
      if (!list.find((m) => m.id === S.modelId)) S.modelId = (list[0] || {}).id || null;
    } catch (e) {
      S.err = e.message || String(e);
      S.models = { image: [], video: [] };
    } finally {
      S.scanning = false;
    }
  }

  async function loadHistory() {
    try {
      const d = await api('history?limit=100');
      S.history = d.items || [];
    } catch { S.history = []; }
  }

  // 🪤 Опрос самозавершающийся: таймер живёт, только пока есть незакрытые задания.
  // Иначе вкладка молотит запросы вечно и на простое, и в фоне.
  async function pollJobs() {
    try {
      const d = await api('jobs');
      S.jobs = d.jobs || [];
    } catch { /* тик мог не доехать — не повод рушить вкладку */ }

    const active = S.jobs.some((j) => j.status === 'queued' || j.status === 'running');
    const justFinished = S.jobs.find((j) => S.selected && j.id === S.selected.id && j.status !== S.selected.status);
    if (justFinished) S.selected = justFinished;
    if (!S.selected) S.selected = S.jobs.find((j) => j.status === 'done') || null;

    renderJobs(); renderResult();

    clearTimeout(S.pollTimer);
    if (active) S.pollTimer = setTimeout(pollJobs, 2000);
    else loadHistory().then(renderLibrary);
  }

  // ── Действия ──────────────────────────────────────────────────────────────

  function collectParams() {
    const p = {};
    const size = $('md-size') && $('md-size').value;
    if (size) p.size = size;

    if (S.mode === 'image') {
      const count = Number($('md-count') && $('md-count').value) || 1;
      p.count = count;
      const q = $('md-quality') && $('md-quality').value;
      if (q) p.quality = q;
      const neg = $('md-negative') && $('md-negative').value.trim();
      if (neg) p.negativePrompt = neg;
      const seed = $('md-seed') && $('md-seed').value.trim();
      if (seed) p.seed = seed;
    } else {
      const dur = Number($('md-duration') && $('md-duration').value);
      if (dur) p.durationSec = dur;
    }

    const rawEl = $('md-raw');
    const rawTxt = rawEl && rawEl.value.trim();
    if (rawTxt) {
      try { p.raw = JSON.parse(rawTxt); }
      catch (e) { throw new Error(`сырой JSON не разбирается: ${e.message}`); }
    }
    return p;
  }

  async function generate() {
    const prompt = ($('md-prompt') && $('md-prompt').value || '').trim();
    if (!prompt) { say('Пустой промпт', 'err'); return; }
    if (!S.modelId) { say('Не выбрана модель', 'err'); return; }

    let params;
    try { params = collectParams(); }
    catch (e) { say(e.message, 'err'); return; }

    const btn = $('md-go');
    if (btn) { btn.disabled = true; btn.textContent = 'ставлю…'; }
    try {
      const d = await api('generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: S.providerId, model: S.modelId, prompt, params }),
      });
      S.selected = d.job;
      say(`Задание ${d.job.id} поставлено`, 'ok');
      pollJobs();
    } catch (e) {
      say(e.message, 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '▶ Сгенерировать'; }
    }
  }

  function pickModel(id) { S.modelId = id; render(); }
  function setMode(mode) {
    S.mode = mode;
    const list = S.models[mode] || [];
    S.modelId = (list[0] || {}).id || null;
    render();
  }
  function setProvider(id) { S.providerId = id; S.modelId = null; loadModels(false).then(render); }
  function toggleAdvanced() { S.advanced = !S.advanced; render(); }
  function selectJob(id) {
    S.selected = S.jobs.find((j) => j.id === id) || S.history.find((h) => h.id === id) || null;
    renderResult();
  }
  function reuse(id) {
    const j = S.jobs.find((x) => x.id === id) || S.history.find((x) => x.id === id);
    if (!j) return;
    if ($('md-prompt')) $('md-prompt').value = j.prompt || '';
    if (j.model) S.modelId = j.model;
    if (j.kind && j.kind !== S.mode) S.mode = j.kind;
    render();
    say('Промпт и модель подставлены', 'ok');
  }

  // ── Ключ провайдера ───────────────────────────────────────────────────────

  // Пока ключ один — просто маска, как было. Когда их несколько (по аккаунту на грант),
  // появляется выбор: студия тратит выбранный. 🪤 Рычаг только там, где есть медиа и есть
  // из чего выбирать; у текстового провайдера он бессмыслен, и сервер это подтверждает
  // отказом — прятать условие в интерфейсе недостаточно.
  // 🪤 Наружу ключ не отдаётся ни в одну сторону: кнопка адресует ключ ИНДЕКСОМ.
  function keyPickHtml(prov) {
    if (!prov || !prov.hasKey) return '';
    if (!prov.hasMedia || !(prov.keysCount > 1)) {
      return `<div class="text-dim text-[11px] mt-1 font-mono">ключ ${esc(prov.keyMask)}</div>`;
    }
    const btns = (prov.keyMasks || []).map((m, i) => `
      <button class="md-mini${i === prov.keyIndex ? ' md-mode-on' : ''}" data-key="${i}"
              title="тратить этот ключ">${i === prov.keyIndex ? '✓' : ''} ${esc(m || '—')}</button>`).join('');
    return `
      <div class="mt-2">
        <label class="md-label">ключ · тратится выбранный</label>
        <div class="flex flex-wrap gap-1.5">${btns}</div>
      </div>`;
  }

  async function setMediaKey(index) {
    const prov = S.providers.find((p) => p.id === S.providerId);
    if (!prov) return;
    try {
      const d = await api('keys/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: prov.id, index }),
      });
      const i = S.providers.findIndex((p) => p.id === prov.id);
      if (i >= 0 && d && d.provider) S.providers[i] = d.provider;
      say('Ключ для медиа переключён', 'ok');
      render();
    } catch (e) { say('Не удалось переключить ключ: ' + e.message, 'err'); }
  }

  // ── Разметка ──────────────────────────────────────────────────────────────

  function renderTask() {
    const host = $('md-task');
    if (!host) return;
    const prov = S.providers.find((p) => p.id === S.providerId);
    const list = S.models[S.mode] || [];
    const model = list.find((m) => m.id === S.modelId) || null;
    const caps = (model && model.caps) || {};

    host.innerHTML = `
      <label class="md-label">провайдер</label>
      <select id="md-provider" class="md-input">
        ${S.providers.map((p) => `
          <option value="${esc(p.id)}"${p.id === S.providerId ? ' selected' : ''}>
            ${esc(p.name)} — 🖼 ${p.counts.image} · 🎬 ${p.counts.video}
          </option>`).join('')}
      </select>
      ${prov && !prov.hasKey ? '<div class="text-crimson text-[11px] mt-1">✕ у провайдера нет ключа</div>' : ''}
      ${keyPickHtml(prov)}

      <div class="md-modes mt-3">
        <button class="md-mode${S.mode === 'image' ? ' md-mode-on' : ''}" data-mode="image">🖼 Изображение</button>
        <button class="md-mode${S.mode === 'video' ? ' md-mode-on' : ''}" data-mode="video">🎬 Видео</button>
      </div>

      <div class="flex items-center justify-between mt-3">
        <label class="md-label mb-0">модель · ${list.length}</label>
        <button id="md-scan" class="md-mini">${S.scanning ? '…' : '↻ пересканировать'}</button>
      </div>
      <select id="md-model" class="md-input">
        ${list.length ? list.map((m) => `
          <option value="${esc(m.id)}"${m.id === S.modelId ? ' selected' : ''}>
            ${esc(m.id)}${m.undocumented ? '  ⚠ уточни параметры' : ''}
          </option>`).join('') : '<option value="">— моделей нет —</option>'}
      </select>
      ${model && model.undocumented ? `
        <div class="md-warn">
          ⚠ <b>Параметры не подтверждены.</b> Этой модели нет в документации вендора —
          размеры и поля ниже взяты по умолчанию и могут не подойти. Если шлюз ответит
          отказом, задай поля через сырой JSON и сохрани профиль.
        </div>` : ''}

      <label class="md-label mt-3">промпт</label>
      <textarea id="md-prompt" class="md-input md-area" rows="4" placeholder="что нарисовать"></textarea>

      <div class="md-grid mt-3">
        <div>
          <label class="md-label">размер</label>
          <select id="md-size" class="md-input">
            ${(caps.sizes || []).map((s) => `<option${s === caps.defaultSize ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>
        ${S.mode === 'image' ? `
          <div>
            <label class="md-label">сколько</label>
            <input id="md-count" class="md-input" type="number" min="1" max="${caps.maxCount || 4}" value="1">
          </div>` : `
          <div>
            <label class="md-label">длительность, с</label>
            <select id="md-duration" class="md-input">
              ${(caps.durationsSec || [5]).map((d) => `<option${d === caps.defaultDurationSec ? ' selected' : ''}>${d}</option>`).join('')}
            </select>
          </div>`}
      </div>

      <button id="md-adv" class="md-mini mt-3">${S.advanced ? '▾' : '▸'} расширенные</button>
      <div class="${S.advanced ? '' : 'hidden'}">
        ${S.mode === 'image' ? `
          ${caps.supportsQuality ? `
            <label class="md-label mt-2">качество</label>
            <select id="md-quality" class="md-input">
              <option value="">по умолчанию</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>` : ''}
          <label class="md-label mt-2">негативный промпт</label>
          <input id="md-negative" class="md-input" placeholder="чего не должно быть">
          <label class="md-label mt-2">seed</label>
          <input id="md-seed" class="md-input" placeholder="пусто = случайный">
        ` : ''}
        <label class="md-label mt-2">сырой JSON поверх запроса</label>
        <textarea id="md-raw" class="md-input md-area md-mono" rows="3" placeholder='{"style":"vivid"}'></textarea>
        <div class="text-dim text-[11px] mt-1">
          Побеждает все поля выше. Аварийный рычаг для параметров, которых нет в форме.
        </div>
      </div>

      <button id="md-go" class="md-go mt-4">▶ Сгенерировать</button>
      ${S.scannedAt ? `<div class="text-dim text-[11px] mt-2">каталог снят ${esc(String(S.scannedAt).slice(0, 16).replace('T', ' '))}</div>` : ''}
    `;

    const provSel = $('md-provider'); if (provSel) provSel.onchange = (e) => setProvider(e.target.value);
    const modelSel = $('md-model'); if (modelSel) modelSel.onchange = (e) => pickModel(e.target.value);
    const scanBtn = $('md-scan'); if (scanBtn) scanBtn.onclick = () => loadModels(true).then(render);
    const advBtn = $('md-adv'); if (advBtn) advBtn.onclick = toggleAdvanced;
    const goBtn = $('md-go'); if (goBtn) goBtn.onclick = generate;
    host.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    host.querySelectorAll('[data-key]').forEach((b) => { b.onclick = () => setMediaKey(Number(b.dataset.key)); });
  }

  function renderResult() {
    const host = $('md-result');
    if (!host) return;
    const j = S.selected;
    if (!j) {
      host.innerHTML = '<div class="md-empty">Здесь появится результат.<br><span class="text-dim">Слева — задание, справа — что уже сделано.</span></div>';
      return;
    }
    const arts = j.artifacts || [];
    host.innerHTML = `
      <div class="md-res-head">
        <div>
          <div class="text-sm font-medium">${statusHtml(j.status)} <span class="font-mono text-muted">${esc(j.model || '')}</span></div>
          <div class="text-dim text-[11px] mt-0.5 font-mono">${esc(j.id)} · ${fmtMs(j.ms)}</div>
        </div>
        <div class="flex gap-1.5">
          <button class="md-mini" data-act="reuse" data-id="${esc(j.id)}">↻ повторить</button>
        </div>
      </div>
      ${j.status === 'failed' ? `<div class="md-err">✕ ${esc(j.error || 'без текста')}</div>` : ''}
      ${j.dialectVerified === false ? '<div class="md-warn mt-2">⚠ Диалект этого типа моделей на живом шлюзе не проверялся — если ответ не опознан, это ожидаемо.</div>' : ''}
      <div class="md-arts">
        ${arts.map((a) => (
          String(a.mime || '').startsWith('video/')
            ? `<video class="md-art" src="${esc(a.url)}" controls preload="metadata"></video>`
            : `<a href="${esc(a.url)}" target="_blank" rel="noreferrer"><img class="md-art" src="${esc(a.url)}" alt=""></a>`
        )).join('')}
      </div>
      ${arts.length ? `
        <div class="md-facts">
          ${arts.map((a) => `<span class="md-chip">${esc(a.mime || '?')} · ${fmtBytes(a.bytes)} · <a class="text-azure" href="${esc(a.url)}" download>скачать</a></span>`).join('')}
        </div>` : ''}
      <div class="md-prompt-echo">${esc(j.prompt || '')}</div>
    `;
    host.querySelectorAll('[data-act="reuse"]').forEach((b) => { b.onclick = () => reuse(b.dataset.id); });
  }

  function renderJobs() {
    const host = $('md-jobs');
    if (!host) return;
    const active = S.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    if (!active.length) { host.innerHTML = ''; return; }
    host.innerHTML = active.map((j) => `
      <div class="md-job" data-id="${esc(j.id)}">
        ${statusHtml(j.status)} <span class="font-mono text-[11px] text-muted">${esc(j.model)}</span>
        <div class="text-dim text-[11px] truncate">${esc(j.prompt)}</div>
      </div>`).join('');
    host.querySelectorAll('[data-id]').forEach((el) => { el.onclick = () => selectJob(el.dataset.id); });
  }

  function renderLibrary() {
    const host = $('md-library');
    if (!host) return;
    const q = (($('md-search') && $('md-search').value) || '').toLowerCase();
    const items = S.history.filter((h) => !q || String(h.prompt || '').toLowerCase().includes(q));
    if (!items.length) {
      host.innerHTML = `<div class="md-empty text-[12px]">${q ? 'Ничего не нашлось.' : 'Пока пусто.'}</div>`;
      return;
    }
    host.innerHTML = items.map((h) => {
      const thumb = (h.artifacts || [])[0];
      const isVideo = thumb && String(thumb.mime || '').startsWith('video/');
      return `
        <div class="md-lib-item" data-id="${esc(h.id)}">
          <div class="md-lib-thumb">
            ${thumb && !isVideo ? `<img src="${esc(thumb.url)}" alt="" loading="lazy">` : `<span class="text-dim text-lg">${isVideo ? '🎬' : '—'}</span>`}
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[11px] truncate">${esc(h.prompt || '')}</div>
            <div class="text-dim text-[10px] font-mono truncate">${esc(h.model || '')}</div>
            <div class="text-[10px] mt-0.5">${statusHtml(h.status)}</div>
          </div>
        </div>`;
    }).join('');
    host.querySelectorAll('[data-id]').forEach((el) => { el.onclick = () => selectJob(el.dataset.id); });
  }

  function render() {
    const root = $('media-root');
    if (!root) return;
    if (!root.dataset.built) {
      root.innerHTML = `
        <div class="md-wrap">
          <aside class="md-col md-col-task"><div id="md-task"></div></aside>
          <section class="md-col md-col-result">
            <div id="md-jobs" class="md-jobs"></div>
            <div id="md-result" class="md-result"></div>
          </section>
          <aside class="md-col md-col-lib">
            <input id="md-search" class="md-input" placeholder="поиск по промпту">
            <div id="md-library" class="md-library"></div>
          </aside>
        </div>`;
      root.dataset.built = '1';
      const s = $('md-search'); if (s) s.oninput = renderLibrary;
    }
    if (S.err) say(S.err, 'err');
    // Промпт и сырой JSON переживают перерисовку — иначе набранное пропадает при
    // каждой смене модели.
    const keepPrompt = $('md-prompt') && $('md-prompt').value;
    const keepRaw = $('md-raw') && $('md-raw').value;
    renderTask();
    if (keepPrompt && $('md-prompt')) $('md-prompt').value = keepPrompt;
    if (keepRaw && $('md-raw')) $('md-raw').value = keepRaw;
    renderJobs(); renderResult(); renderLibrary();
  }

  window.MEDIA = {
    load,
    refresh: () => load(true),
  };
})();
