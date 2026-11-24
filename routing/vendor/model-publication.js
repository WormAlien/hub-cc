/* One publication control for provider model chips and the API Gateway list. */
(() => {
  'use strict';
  const API = '/__switch/api/api-gateway';
  const S = { data: null, ready: false, busy: false, reading: null, sequence: 0, lastRead: 0, messages: new Map() };
  const validId = id => typeof id === 'string' && id.trim() === id && !/\s|[\x00-\x1f\x7f]/u.test(id)
    && id.indexOf('/') > 0 && id.indexOf('/') < id.length - 1;
  const current = id => !!S.data?.models?.some(model => model.id === id && model.published);
  const known = id => Array.isArray(S.data?.providers) && S.data.providers.includes(id.slice(0, id.indexOf('/')));
  const slots = () => [...document.querySelectorAll('[data-publication-slot]')];
  const blocked = (id, source) => source ? source.dataset.publicationBlocked || '' :
    slots().filter(slot => slot.dataset.publicationSlot === id).every(slot => !!slot.dataset.publicationBlocked);
  const notify = (text, kind) => window.toast?.(text, kind);

  function readableError(error) {
    const a6api = {
      a6api_key_not_selected: 'Сначала выберите и подготовьте ключ a6api кнопкой «Использовать ключ».',
      a6api_token_expired: 'Срок выбранного ключа a6api истёк. Измените срок в кабинете или используйте другой ключ.',
      a6api_token_disabled: 'Выбранный ключ a6api выключен или недоступен. Используйте рабочий ключ.',
      a6api_token_quota: 'Лимит выбранного ключа a6api исчерпан. Измените лимит в кабинете или используйте другой ключ.',
      a6api_token_missing: 'Выбранный ключ a6api больше не найден в кабинете. Используйте другой ключ.',
      a6api_model_unavailable: 'Модель не разрешена выбранному ключу a6api или отсутствует в текстовом каталоге.',
      a6api_catalog_unavailable: 'Не удалось проверить каталог a6api. Публикации сохранены; повторите позже.',
    };
    if (Object.hasOwn(a6api, error.code)) return a6api[error.code];
    if (error.status === 409) return 'Список уже изменился. Состояние обновлено; повторите переключение.';
    if (error.status === 403) return 'Изменение доступно только через localhost на машине хаба.';
    if (error.status === 404) return 'Публикация недоступна. Серверу хаба требуется обновление.';
    if (error.status === 400) return 'Не удалось сохранить: проверьте точный ID модели и настройки Gateway.';
    return 'Не удалось подтвердить сохранение. Проверьте соединение и повторите.';
  }

  async function request(url, body) {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin',
      signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }) });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok === false) {
      const error = new Error('publication_request_failed');
      error.status = response.status; error.code = data?.code;
      throw error;
    }
    return data;
  }

  function accept(data) {
    if (!data?.manifest || !Number.isSafeInteger(data.manifest.revision) || data.manifest.revision < 1
      || !Array.isArray(data.models) || typeof data.canWrite !== 'boolean') throw new Error('publication_state_invalid');
    S.data = data; S.ready = true; S.lastRead = Date.now();
    paint();
    document.dispatchEvent(new CustomEvent('abuse-hub:model-publications', { detail: data }));
    return data;
  }

  async function read(force = false) {
    if (!force && S.reading) return S.reading;
    const sequence = ++S.sequence;
    const pending = request(API).then(data => sequence === S.sequence ? accept(data) : S.data);
    S.reading = pending;
    try { return await pending; }
    catch (error) { if (sequence === S.sequence) { S.ready = false; paint(); } throw error; }
    finally { if (S.reading === pending) S.reading = null; }
  }

  function refresh(force = false) {
    if (!force && S.ready && Date.now() - S.lastRead < 3000) return Promise.resolve(S.data);
    return read(force).catch(() => null);
  }

  function build(slot) {
    const id = slot.dataset.publicationSlot;
    const panel = slot.closest('[id$="-models"]');
    if (panel && !panel.classList.contains('mp-model-panel')) panel.classList.add('mp-model-panel');
    if (!validId(id) || slot.querySelector('input[data-publication-id]')) return;
    slot.classList.add('mp-slot');
    const label = document.createElement('label'); label.className = 'mp-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.disabled = true;
    input.dataset.publicationId = id; input.dataset.field = 'published';
    input.setAttribute('aria-label', 'В API Gateway: ' + id);
    const track = document.createElement('span'); track.className = 'mp-track'; track.setAttribute('aria-hidden', 'true');
    const caption = document.createElement('span'); caption.className = 'mp-caption'; caption.textContent = 'В API Gateway';
    label.append(input, track, caption);
    label.addEventListener('click', event => event.stopPropagation());
    label.addEventListener('keydown', event => event.stopPropagation());
    input.addEventListener('change', event => {
      event.stopPropagation();
      const wanted = input.checked;
      input.checked = current(id);
      change(id, wanted, slot);
    });
    const message = document.createElement('span'); message.className = 'mp-message';
    message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); message.hidden = true;
    slot.append(label, message);
  }

  function paint() {
    for (const slot of slots()) {
      build(slot);
      const id = slot.dataset.publicationSlot, input = slot.querySelector('input[data-publication-id]');
      if (!input) continue;
      const supported = known(id), message = S.messages.get(id), prerequisite = !current(id) && slot.dataset.publicationBlocked;
      input.checked = current(id);
      input.disabled = S.busy || !S.ready || !S.data?.canWrite || !supported || !!prerequisite;
      input.setAttribute('aria-busy', String(S.busy));
      const label = slot.querySelector('.mp-toggle');
      const title = !S.ready ? 'Статус публикации не прочитан. Откройте вкладку повторно или обновите страницу.'
        : !S.data.canWrite ? 'Только просмотр: изменения доступны через localhost на машине хаба.'
        : !supported ? 'У провайдера нет зарегистрированного точного маршрута API Gateway.'
        : prerequisite ? prerequisite
        : 'Показать модель в picker Claude Code, OpenCode и Hermes. Текущая модель не меняется.';
      if (label.title !== title) label.title = title;
      label.classList.toggle('mp-readonly', input.disabled && !S.busy);
      slot.classList.toggle('mp-saving', S.busy);
      const output = slot.querySelector('.mp-message');
      const signature = message ? message.kind + ':' + message.text + ':' + !!message.retry : '';
      if (output.dataset.signature === signature) continue;
      output.dataset.signature = signature;
      output.replaceChildren(); output.hidden = !message;
      if (!message) continue;
      output.dataset.kind = message.kind;
      output.append(document.createTextNode(message.text));
      if (message.retry) {
        const retry = document.createElement('button'); retry.type = 'button';
        retry.dataset.publicationRetry = id; retry.className = 'mp-retry'; retry.textContent = 'Повторить Sync';
        retry.disabled = S.busy || !S.ready || !S.data?.canWrite;
        retry.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); retrySync(id); });
        output.append(retry);
      }
    }
  }

  async function change(id, published, source) {
    if (S.busy || !validId(id) || !S.ready || !S.data?.canWrite || !known(id) || published && !current(id) && blocked(id, source)) return paint();
    S.busy = true; S.messages.delete(id); paint();
    try {
      const before = await read(true);
      if (!before?.canWrite || !known(id)) throw Object.assign(new Error('local_only'), { status: 403 });
      const result = await request(API + '/publication', { expectedRevision: before.manifest.revision, id, published });
      if (result.model?.id !== id || result.model.published !== published || !result.manifest) throw new Error('publication_receipt_invalid');
      const after = await read(true);
      if (!after || current(id) !== published || after.manifest.revision < result.manifest.revision) {
        throw Object.assign(new Error('publication_readback_conflict'), { status: 409 });
      }
      if (result.opencode?.ok !== true) {
        S.messages.set(id, { kind: 'warning', text: (published ? 'Опубликована.' : 'Скрыта.') + ' OpenCode не обновлён.', retry: true });
        notify('Публикация сохранена, но OpenCode не обновлён.', 'warn');
      } else notify(published ? 'Модель добавлена в picker. Текущая модель не изменена.' : 'Модель скрыта из picker. Текущая модель не изменена.', 'success');
    } catch (error) {
      // A lost response can follow a committed transaction. Reconcile before
      // drawing either state; never substitute the old checkbox for readback.
      await refresh(true);
      const text = readableError(error);
      S.messages.set(id, { kind: 'error', text, retry: false }); notify(text, 'error');
    } finally { S.busy = false; paint(); }
  }

  async function retrySync(id) {
    if (S.busy || !S.ready || !S.data?.canWrite) return;
    S.busy = true; paint();
    try {
      const result = await request(API + '/opencode/sync', {});
      if (result.ok !== true) throw new Error('opencode_sync_failed');
      const before = S.data.manifest.revision;
      const after = await read(true);
      if (!after || after.manifest.revision !== before) throw new Error('opencode_sync_drift');
      S.messages.clear(); notify('OpenCode обновлён. Текущая модель не изменена.', 'success');
    } catch {
      S.messages.set(id, { kind: 'warning', text: 'OpenCode не обновлён. Проверьте настройки клиента.', retry: true });
      notify('OpenCode не обновлён.', 'warn');
    } finally { S.busy = false; paint(); }
  }

  function enhance() {
    const hosts = slots();
    if (!hosts.length) return;
    paint(); refresh();
  }

  let queued = false;
  const observer = new MutationObserver(records => {
    const addedSlot = records.some(record => [...record.addedNodes].some(node => node.nodeType === 1
      && (node.matches('[data-publication-slot]') || node.querySelector('[data-publication-slot]'))));
    if (!addedSlot || queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; enhance(); });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.MODEL_PUBLICATION = Object.freeze({ refresh, enhance, change, retrySync });
  if (typeof window.showTab === 'function') {
    const show = window.showTab;
    window.showTab = function (...args) {
      const result = show.apply(this, args);
      const panel = [...document.querySelectorAll('[data-tab-content]')].find(node => node.dataset.tabContent === args[0]);
      if (panel?.querySelector('[data-publication-slot]')) { paint(); refresh(true); }
      return result;
    };
  }
  window.addEventListener('focus', () => { if (document.querySelector('[data-tab-content].active [data-publication-slot]')) refresh(true); });
  enhance();
})();
