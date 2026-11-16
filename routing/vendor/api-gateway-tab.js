(() => {
  'use strict';

  const API = '/__switch/api/api-gateway';
  const CACHE_KEY = 'abuse-hub:api-gateway:v1';
  const root = () => document.getElementById('api-gateway-root');
  const byId = (id) => document.getElementById(id);

  const S = {
    data: null,
    clients: null,
    sidecar: null,
    loading: false,
    candidatesLoading: false,
    candidatesOpen: false,
    wired: false,
    q: '',
    filter: 'all',
    editing: new Set(),
    request: 0,
  };

  const text = (value, fallback = '-') => {
    const string = String(value == null ? '' : value).trim();
    return string || fallback;
  };

  const countPublished = () => (S.data?.models || []).filter((model) => model.published).length;

  function readCache() {
    let cached;
    try { cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null'); }
    catch { return null; }
    if (!cached || typeof cached !== 'object' || !cached.data || typeof cached.data !== 'object') return null;
    if (!Array.isArray(cached.data.models) || !cached.data.manifest || typeof cached.data.manifest !== 'object') return null;
    return cached;
  }

  function writeCache() {
    if (!S.data) return;
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data: S.data, clients: S.clients, sidecar: S.sidecar }));
    } catch {}
  }

  function restoreCache() {
    const cached = readCache();
    if (!cached) return false;
    S.data = cached.data;
    S.clients = cached.clients || null;
    S.sidecar = cached.sidecar || null;
    return true;
  }

  function element(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (name === 'class') node.className = value;
      else if (name === 'text') node.textContent = value;
      else if (name === 'dataset') Object.assign(node.dataset, value);
      else if (name === 'disabled') node.disabled = Boolean(value);
      else if (name === 'checked') node.checked = Boolean(value);
      else if (name === 'value') node.value = String(value);
      else node.setAttribute(name, String(value));
    }
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child == null) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const badge = (label, tone, title) => element('span', {
    class: `ag-badge ag-badge--${tone || 'unknown'}`,
    text: label,
    title: title || label,
  });

  function healthTone(state) {
    if (state === 'healthy') return 'healthy';
    if (state === 'unhealthy') return 'unhealthy';
    if (state === 'warning') return 'warning';
    return 'unknown';
  }

  function healthLabel(state) {
    if (state === 'healthy') return 'Работает';
    if (state === 'unhealthy') return 'Ошибка';
    if (state === 'warning') return 'Есть вопросы';
    return 'Нет данных';
  }

  function statusTone(state) {
    const normalized = String(state || '').toLowerCase();
    if (['ready', 'healthy', 'running', 'current', 'ok'].includes(normalized)) return 'healthy';
    if (['failed', 'error', 'unhealthy', 'down'].includes(normalized)) return 'unhealthy';
    if (['drift', 'warning', 'stale'].includes(normalized)) return 'warning';
    return 'unknown';
  }

  function readableError(payload, response) {
    if (response?.status === 409 || payload?.error === 'revision_conflict') return 'Данные уже изменились. Обновите вкладку перед сохранением.';
    return text(payload?.error || payload?.message, response ? `Ошибка запроса (${response.status})` : 'Ошибка запроса');
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    let payload;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok || payload?.ok === false) {
      const error = new Error(readableError(payload, response));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function notify(message, kind = 'info') {
    if (typeof window.toast === 'function') window.toast(message, kind);
  }

  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value);
      notify('Скопировано', 'success');
    } catch {
      notify('Буфер обмена недоступен', 'error');
    }
  }

  function setNavCount() {
    const counter = byId('nav-count-api-gateway');
    if (!counter || !S.data) return;
    counter.textContent = String(countPublished());
  }

  function copyLine(kind, value, key) {
    const button = element('button', {
      type: 'button',
      class: 'ag-button',
      text: 'Копировать',
      dataset: { copy: key },
      'aria-label': `Скопировать адрес ${kind}`,
    });
    button.addEventListener('click', () => copy(value));
    return element('div', { class: 'ag-copy-line' }, [
      element('span', { class: 'ag-copy-kind', text: kind }),
      element('code', { class: 'ag-copy-value', text: value, title: value }),
      button,
    ]);
  }

  function fact(label, value) {
    return element('div', { class: 'ag-fact' }, [
      element('span', { class: 'ag-fact-label', text: label }),
      element('span', { class: 'ag-fact-value', text: text(value) }),
    ]);
  }

  function renderSidecar(sidecar = {}) {
    const status = text(sidecar.status, sidecar.installed === false ? 'не установлен' : 'неизвестно');
    const checksum = text(sidecar.checksum, 'нет данных');
    const shortChecksum = checksum.length > 14 ? `${checksum.slice(0, 12)}...` : checksum;
    return element('section', { class: 'ag-surface ag-sidecar', dataset: { agSidecar: '' } }, [
      element('div', { class: 'ag-sidecar-head' }, [
        element('div', {}, [
          element('div', { class: 'ag-eyebrow', text: 'Конвертер протокола' }),
          element('div', { class: 'ag-sidecar-name', text: 'Bifrost' }),
        ]),
        badge(status, statusTone(sidecar.health || status), text(sidecar.health || status)),
      ]),
      element('div', { class: 'ag-facts' }, [
        fact('Версия', sidecar.version),
        fact('Контрольная сумма', shortChecksum),
        fact('Установка', sidecar.installState || (sidecar.installed ? 'установлен' : 'не установлен')),
        fact('Состояние', sidecar.health),
        fact('Перезапуск', typeof sidecar.restart === 'object' ? sidecar.restart.detail || sidecar.restart.state : sidecar.restart),
      ]),
    ]);
  }

  function modelBadges(model) {
    const catalog = model.catalog || {};
    const passive = model.passive || {};
    const probe = model.probe || {};
    const health = model.health || {};
    return element('div', { class: 'ag-badges' }, [
      badge(model.published ? 'Published' : 'Hidden', model.published ? 'published' : 'hidden', model.published ? 'Visible in pickers' : 'Hidden from pickers; exact ID remains callable'),
      badge(catalog.present ? `Catalog ${text(catalog.source, 'present')}` : 'Catalog missing', catalog.present ? 'present' : 'missing', catalog.present ? `Catalog source: ${text(catalog.source)}` : 'Published rows are retained when discovery no longer contains them'),
      badge(passive.lastSuccess ? 'Passive success' : 'Passive unknown', passive.lastSuccess ? 'ok' : 'unknown', passive.lastSuccess ? `Last success: ${passive.lastSuccess}` : 'No successful passive traffic evidence'),
      badge(probe.ok === true ? 'Probe ok' : probe.ok === false ? 'Probe failed' : 'Probe unknown', probe.ok === true ? 'ok' : probe.ok === false ? 'fail' : 'unknown', probe.reason || probe.at || 'No probe evidence'),
      badge(text(health.state, 'unknown'), healthTone(health.state), health.reason || `Health: ${text(health.state, 'unknown')}`),
    ]);
  }

  function field(label, control) {
    return element('label', { class: 'ag-field' }, [
      element('span', { class: 'ag-label', text: label }),
      control,
    ]);
  }

  function input(fieldName, value, type = 'text', extra = {}) {
    return element('input', {
      type,
      class: 'ag-input',
      value: value == null ? '' : value,
      dataset: { field: fieldName },
      ...extra,
    });
  }

  // Лимиты у неопубликованной модели никем не заданы. Сервер подставляет типовые, чтобы поле
  // не было пустым; показываем это подписью, иначе подстановка прочтётся как реальные цифры
  // провайдера. Save по-прежнему требует честные числа - подстановка ничего не сохраняет.
  function limitInput(fieldName, model, disabled, title) {
    const defaulted = Boolean(model.limitsDefaulted && model.limitsDefaulted[fieldName]);
    return input(fieldName, model[fieldName], 'number', {
      disabled,
      min: 1,
      step: 1,
      inputmode: 'numeric',
      class: defaulted ? 'ag-input ag-input--defaulted' : 'ag-input',
      title: defaulted ? `${title}: типовое значение, не получено от провайдера` : title,
      placeholder: defaulted ? 'типовое значение' : '',
    });
  }

  function rowMatches(model) {
    const q = S.q.trim().toLowerCase();
    const health = String(model.health?.state || 'unknown').toLowerCase();
    const filter = S.filter;
    if (filter === 'published' && !model.published) return false;
    if (filter === 'hidden' && model.published) return false;
    if (filter === 'unhealthy' && health !== 'unhealthy') return false;
    if (filter === 'warning' && health !== 'warning') return false;
    if (filter === 'unknown' && health !== 'unknown') return false;
    if (!q) return true;
    return [model.id, model.provider, model.model, model.displayName, model.claudeBehavesAs, model.catalog?.source, model.health?.state, model.health?.reason]
      .some((value) => String(value || '').toLowerCase().includes(q));
  }

  function setRowMessage(row, message, kind) {
    const output = row.querySelector('.ag-row-message');
    if (!output) return;
    output.textContent = message || '';
    output.dataset.kind = kind || '';
  }

  function readRow(row) {
    const get = (name) => row.querySelector(`[data-field="${name}"]`);
    return {
      expectedRevision: S.data.manifest.revision,
      id: row.dataset.modelId,
      published: get('published').checked,
      displayName: get('displayName').value.trim(),
      claudeBehavesAs: get('claudeBehavesAs').value.trim(),
      contextTokens: Number(get('contextTokens').value),
      outputTokens: Number(get('outputTokens').value),
    };
  }

  async function saveModel(row) {
    if (!S.data?.canWrite) return;
    const button = row.querySelector('.ag-save');
    setRowMessage(row, 'Сохранение...', '');
    button.disabled = true;
    try {
      const body = readRow(row);
      if (!body.id || !body.displayName || !body.claudeBehavesAs || !Number.isSafeInteger(body.contextTokens) || body.contextTokens <= 0 || !Number.isSafeInteger(body.outputTokens) || body.outputTokens <= 0) {
        throw new Error('Заполните название, совместимость и лимиты. Лимиты должны быть целыми положительными числами.');
      }
      const result = await requestJson(`${API}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const model = (S.data.models || []).find((item) => item.id === body.id);
      if (model) Object.assign(model, body, { publishedAt: body.published ? (model.publishedAt || new Date().toISOString()) : null });
      if (result.manifest) S.data.manifest = result.manifest;
      else S.data.manifest.revision += 1;
      writeCache();
      row.dataset.published = String(body.published);
      setRowMessage(row, 'Сохранено', 'ok');
      setNavCount();
      renderModelGroups();
      const savedRow = [...document.querySelectorAll('.ag-model')].find((item) => item.dataset.modelId === body.id);
      if (savedRow) setRowMessage(savedRow, 'Сохранено', 'ok');
      const publishedBadge = row.querySelector('.ag-badge');
      if (publishedBadge) {
        publishedBadge.textContent = body.published ? 'Опубликована' : 'Скрыта';
        publishedBadge.className = `ag-badge ag-badge--${body.published ? 'published' : 'hidden'}`;
      }
      notify('Модель сохранена', 'success');
    } catch (error) {
      setRowMessage(row, error.message, 'error');
      notify(error.message, 'error');
    } finally {
      button.disabled = !S.data?.canWrite;
    }
  }

  function renderModel(model) {
    const disabled = !S.data.canWrite;
    const editing = S.editing.has(model.id);
    const published = input('published', '', 'checkbox', {
      class: 'ag-toggle',
      checked: Boolean(model.published),
      disabled,
      'aria-label': `${model.published ? 'Скрыть' : 'Опубликовать'} ${model.id}`,
    });
    const save = element('button', {
      type: 'button',
      class: 'ag-button ag-button--primary ag-save',
      text: 'Сохранить',
      disabled,
    });
    const edit = element('button', {
      type: 'button',
      class: 'ag-button ag-edit',
      text: editing ? 'Закрыть' : 'Изменить',
      dataset: { action: 'edit' },
    });
    const row = element('article', {
      class: 'ag-model',
      dataset: {
        modelId: model.id,
        published: String(Boolean(model.published)),
        health: text(model.health?.state, 'unknown'),
      },
    }, [
      element('div', { class: 'ag-model-ident' }, [
        element('div', { class: 'ag-model-top' }, [
          published,
          element('span', { class: 'ag-model-id', text: model.id, title: model.id }),
        ]),
        element('div', { class: 'ag-model-summary' }, [
          badge(healthLabel(model.health?.state), healthTone(model.health?.state), model.health?.reason || 'Нет данных о состоянии'),
          element('span', { class: 'ag-limit', text: `${Number(model.contextTokens || 0).toLocaleString('ru-RU')} контекст` }),
          element('span', { class: 'ag-limit', text: `${Number(model.outputTokens || 0).toLocaleString('ru-RU')} ответ` }),
        ]),
      ]),
      element('div', { class: `ag-editor${editing ? ' is-open' : ''}` }, [
        field('Название', input('displayName', model.displayName, 'text', { disabled, maxlength: 160 })),
        field('Совместимость', input('claudeBehavesAs', model.claudeBehavesAs, 'text', { disabled, maxlength: 120 })),
        field('Контекст', limitInput('contextTokens', model, disabled, 'Размер контекста')),
        field('Ответ', limitInput('outputTokens', model, disabled, 'Максимальный ответ')),
      ]),
      element('div', { class: 'ag-model-action' }, [
        edit,
        editing ? save : null,
        element('div', { class: 'ag-row-message', 'aria-live': 'polite' }),
      ]),
    ]);
    edit.addEventListener('click', () => {
      if (S.editing.has(model.id)) S.editing.delete(model.id);
      else S.editing.add(model.id);
      renderModelGroups();
    });
    if (editing) save.addEventListener('click', () => saveModel(row));
    return row;
  }

  function sortedModels() {
    const visible = new Set(visibleProviders());
    return [...(S.data?.models || [])]
      .filter(model => visible.has(model.provider))
      .sort((a, b) => {
      if (Boolean(a.published) !== Boolean(b.published)) return a.published ? -1 : 1;
      return String(a.id).localeCompare(String(b.id), 'en');
      });
  }

  function renderModelGroups() {
    const box = byId('ag-model-groups');
    if (!box || !S.data) return;
    box.replaceChildren();
    const visible = sortedModels().filter(rowMatches);
    const groups = [];
    for (const model of visible) {
      const provider = text(model.provider, 'unknown');
      const published = Boolean(model.published);
      let group = groups.find((entry) => entry.provider === provider && entry.published === published);
      if (!group) {
        group = { provider, published, rows: [] };
        groups.push(group);
      }
      group.rows.push(model);
    }
    if (!groups.length) {
      box.append(element('div', { class: 'ag-empty', text: 'Подходящих моделей нет.' }));
      return;
    }
    for (const group of groups) {
      box.append(element('section', { class: 'ag-provider-group', dataset: { provider: group.provider } }, [
        element('div', { class: 'ag-provider-head' }, [
          element('span', { class: 'ag-provider-name', text: group.provider }),
          element('span', { class: 'ag-count', text: `${group.rows.length} мод.` }),
        ]),
        element('div', { class: 'ag-provider-models' }, group.rows.map(renderModel)),
      ]));
    }
  }

  function clientStatus(client = {}) {
    if (client.__harness === 'hermes' && client.installed !== false) {
      return badge('Настроен', 'healthy', 'Hermes TUI настроен на ABUSE HUB');
    }
    const runningWithApiError = String(client.status || '').toLowerCase() === 'running' && client.error;
    const statusUnavailable = client.installed === true && client.backendRunning === false;
    const label = runningWithApiError ? 'Sync unavailable' : statusUnavailable ? 'Status unavailable' : text(client.status, 'unknown');
    return badge(
      label,
      runningWithApiError || statusUnavailable ? 'warning' : statusTone(client.status),
      client.detail || client.error || client.status || 'unknown',
    );
  }

  function harnessStatus(kind, client = {}) {
    if (kind === 'claude') return { label: 'Настроен', tone: 'healthy' };
    if (kind === 'opencode') {
      const status = String(client.status || '').toLowerCase();
      return {
        label: status === 'synced' || status === 'current' ? 'Синхронизирован' : status === 'drift' ? 'Есть изменения' : 'Проверить',
        tone: statusTone(client.status),
      };
    }
    return {
      label: client.installed === false ? 'Не установлен' : 'Настроен',
      tone: client.installed === false ? 'warning' : 'healthy',
    };
  }

  function harnessChip(kind, label, client) {
    const status = harnessStatus(kind, client);
    return element('span', { class: 'ag-harness-chip', dataset: { harness: kind } }, [
      element('span', { class: 'ag-harness-name', text: label }),
      badge(status.label, status.tone, client.detail || status.label),
    ]);
  }

  function setupRow(kind, title, client, body) {
    const statusClient = kind === 'hermes' ? { ...client, __harness: 'hermes' } : client;
    return element('section', { class: 'ag-harness-row', dataset: { harnessSetup: kind } }, [
      element('div', { class: 'ag-harness-row-head' }, [
        element('strong', { text: title }),
        clientStatus(statusClient),
      ]),
      ...body,
    ]);
  }

  function setClientMessage(card, message, kind) {
    const output = card.querySelector('.ag-client-message');
    output.textContent = message || '';
    output.dataset.kind = kind || '';
  }

  function claudeCard(client = {}) {
    return setupRow('claude', 'Claude Code', client, [
      element('p', { class: 'ag-harness-copy', text: 'Сохраните опубликованную модель здесь. ABUSE HUB обновит список моделей Claude Code и не изменит текущую модель.' }),
      element('code', { class: 'ag-code', text: 'ANTHROPIC_BASE_URL=http://127.0.0.1:20100' }),
    ]);
  }

  async function openCodePreview(card) {
    const output = byId('ag-opencode-preview');
    setClientMessage(card, 'Загрузка предпросмотра...', '');
    try {
      const data = await requestJson(`${API}/opencode/preview`);
      output.replaceChildren();
      const targets = Array.isArray(data.targets) ? data.targets : [];
      if (!targets.length) output.append(element('div', { class: 'ag-empty', text: 'Конфиги OpenCode не найдены.' }));
      for (const target of targets) {
        output.append(element('div', { class: 'ag-preview-row' }, [
          element('span', {}, [
            element('strong', { text: text(target.label, 'Конфиг OpenCode') }),
            document.createTextNode(` - ${text(target.status, 'unknown')}`),
          ]),
          element('span', { class: 'ag-count', text: `+${Number(target.additions || 0)} / -${Number(target.removals || 0)} / изменено ${Number(target.changes || 0)}` }),
        ]));
      }
      setClientMessage(card, 'Предпросмотр скрывает секреты. Проверьте его перед синхронизацией.', 'ok');
    } catch (error) {
      setClientMessage(card, error.message, 'error');
    }
  }

  async function syncClient(card, kind) {
    if (!S.data?.canWrite) return;
    const button = card.querySelector(`[data-action="${kind === 'opencode' ? 'sync' : 'sync'}"]`);
    if (button) button.disabled = true;
    setClientMessage(card, 'Синхронизация...', '');
    try {
      const data = await requestJson(`${API}/${kind}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: S.data.manifest.revision }),
      });
      setClientMessage(card, data.message || `${kind} synced`, 'ok');
      notify(data.message || `${kind} synced`, 'success');
    } catch (error) {
      setClientMessage(card, error.message, 'error');
    } finally {
      if (button) button.disabled = !S.data?.canWrite;
    }
  }

  function openCodeCard(client = {}) {
    const card = setupRow('opencode', 'OpenCode', client, []);
    const preview = element('button', { type: 'button', class: 'ag-button', text: 'Предпросмотр', dataset: { action: 'preview' } });
    const sync = element('button', { type: 'button', class: 'ag-button ag-button--primary', text: 'Синхронизировать', dataset: { action: 'sync' }, disabled: !S.data.canWrite });
    card.append(
      element('p', { class: 'ag-harness-copy', text: 'Сначала откройте предпросмотр, затем синхронизируйте. Изменяется только provider abuse-hub; текущая модель и остальные providers сохраняются.' }),
      element('code', { class: 'ag-code', text: 'provider: abuse-hub\nbaseURL: http://127.0.0.1:20100/openai/v1' }),
      element('div', { class: 'ag-client-actions' }, [preview, sync]),
      element('div', { id: 'ag-opencode-preview', class: 'ag-preview' }),
      element('div', { class: 'ag-client-message', 'aria-live': 'polite' }),
    );
    preview.addEventListener('click', () => openCodePreview(card));
    sync.addEventListener('click', () => syncClient(card, 'opencode'));
    return card;
  }

  function hermesCard(client = {}) {
    const status = String(client.status || '').toLowerCase();
    const installed = client.installed !== false && status !== 'absent';
    const card = setupRow('hermes', 'Hermes', client, []);
    const detail = installed
      ? 'Настроен на ABUSE HUB. Модели обнаруживаются автоматически, текущая модель сохраняется.'
      : 'Установите Hermes, затем добавьте provider ABUSE HUB из примера ниже.';
    const body = [element('p', { class: 'ag-harness-copy', text: detail })];
    if (!installed && client.installCommand) body.push(element('code', { class: 'ag-code', text: client.installCommand }));
    body.push(element('code', { class: 'ag-code', text: 'provider: custom:abuse-hub\nbase_url: http://127.0.0.1:20100/openai/v1\napi_mode: chat_completions\ndiscover_models: true' }));
    body.push(element('div', { class: 'ag-client-message', 'aria-live': 'polite' }));
    card.append(...body);
    return card;
  }

  function render() {
    const host = root();
    if (!host || !S.data) return;
    const harnessSetupOpen = host.querySelector('.ag-harness-setup')?.open === true;
    const connectionOpen = host.querySelector('.ag-advanced')?.open === true;
    const publicUrls = S.data.public || {};
    const sidecar = S.sidecar || {};
    const clients = S.clients || {};
    host.replaceChildren(element('main', { class: 'ag-shell' }, [
      element('header', { class: 'ag-header' }, [
        element('div', {}, [
          element('h1', { class: 'ag-title', text: 'API Gateway' }),
          element('p', { class: 'ag-subtitle', text: 'Один список моделей для Claude Code, OpenCode и Hermes.' }),
        ]),
        element('div', { class: 'ag-header-meta' }, [
          S.data.canWrite ? null : element('span', { class: 'ag-readonly', text: 'Только чтение' }),
        ]),
      ]),
      element('section', { class: 'ag-surface ag-harness-bar' }, [
        element('span', { class: 'ag-harness-label', text: 'Клиенты' }),
        harnessChip('claude', 'Claude Code', clients.claude || {}),
        harnessChip('opencode', 'OpenCode', clients.openCode || clients.opencode || {}),
        harnessChip('hermes', 'Hermes', clients.hermes || {}),
      ]),
      element('details', { class: 'ag-surface ag-harness-setup', open: harnessSetupOpen }, [
        element('summary', { text: 'Настройка клиентов' }),
        element('div', { class: 'ag-harness-list' }, [
          claudeCard(clients.claude || {}),
          openCodeCard(clients.openCode || clients.opencode || {}),
          hermesCard(clients.hermes || {}),
        ]),
      ]),
      element('section', { class: 'ag-surface ag-models-panel' }, [
        element('div', { class: 'ag-models-head' }, [
          element('div', {}, [
            element('h2', { class: 'ag-section-title', text: S.candidatesOpen ? 'Добавление модели' : 'Опубликованные модели' }),
            element('p', { class: 'ag-section-note', text: S.candidatesOpen ? 'Выберите модели, которые должны появиться в клиентах.' : 'Изменение списка не переключает текущую модель.' }),
          ]),
          element('div', { class: 'ag-tools' }, [
            S.candidatesOpen
              ? element('input', { id: 'ag-search', class: 'ag-input ag-search', type: 'search', placeholder: 'Поиск моделей', value: S.q, 'aria-label': 'Поиск моделей API Gateway' })
              : element('button', { type: 'button', class: 'ag-button ag-button--primary', text: S.candidatesLoading ? 'Загрузка...' : 'Добавить модель', dataset: { action: 'add-model' }, disabled: S.candidatesLoading }),
            S.candidatesOpen ? element('button', { type: 'button', class: 'ag-button', text: 'Закрыть', dataset: { action: 'close-candidates' } }) : null,
          ]),
        ]),
        element('div', { id: 'ag-model-groups', class: 'ag-model-groups' }),
      ]),
      element('details', { class: 'ag-advanced', open: connectionOpen }, [
        element('summary', { text: 'Подключение' }),
        element('div', { class: 'ag-overview' }, [
          element('section', { class: 'ag-surface ag-endpoints' }, [
            element('div', { class: 'ag-endpoint-list' }, [
              copyLine('Anthropic', text(publicUrls.anthropicBaseUrl), 'anthropic'),
              copyLine('OpenAI', text(publicUrls.openaiBaseUrl), 'openai'),
            ]),
          ]),
          renderSidecar(sidecar),
        ]),
      ]),
      element('div', { class: 'ag-global-message', 'aria-live': 'polite' }),
    ]));
    setNavCount();
    const search = byId('ag-search');
    if (search) search.addEventListener('input', () => { S.q = search.value; renderModelGroups(); });
    host.querySelector('[data-action="add-model"]')?.addEventListener('click', loadCandidates);
    host.querySelector('[data-action="close-candidates"]')?.addEventListener('click', closeCandidates);
    renderModelGroups();
  }

  // Провайдеры, чья вкладка видна в сайдбаре. Каталог собирается только по ним: скрытый шлюз
  // не должен ни опрашиваться сетью, ни занимать строки. Карта имён та же, что у вкладки
  // «Маршруты»: имя в реестре не всегда равно имени вкладки (fm_openai -> freemodel).
  const TAB_OF_PROVIDER = { fm_openai: 'freemodel', vyce_openai: 'vyceai' };
  function visibleProviders() {
    const hidden = typeof effectiveHiddenSet === 'function' ? effectiveHiddenSet() : new Set();
    const navTabs = new Set([...document.querySelectorAll('#main-nav > button[data-tab]')]
      .filter(button => {
        const section = button.closest('[data-extra-nav]');
        return !section || !hidden.has(section.dataset.extraNav);
      })
      .map(button => button.dataset.tab));
    if (!navTabs.size) return [];
    const providers = [...navTabs]
      .filter(tab => !hidden.has(tab))
      .map(tab => Object.keys(TAB_OF_PROVIDER).find(provider => TAB_OF_PROVIDER[provider] === tab) || tab);
    return providers;
  }

  function stateUrl() {
    const providers = visibleProviders();
    if (!providers.length) return `${API}/candidates`;
    const query = providers.map(provider => `provider=${encodeURIComponent(provider)}`).join('&');
    return `${API}/candidates?${query}`;
  }

  async function loadCandidates() {
    if (S.candidatesLoading) return;
    S.candidatesLoading = true;
    render();
    try {
      const data = await requestJson(stateUrl());
      const canWrite = S.data.canWrite;
      S.data = { ...S.data, ...data, canWrite };
      S.candidatesOpen = true;
      writeCache();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      S.candidatesLoading = false;
      render();
    }
  }

  function closeCandidates() {
    S.candidatesOpen = false;
    S.q = '';
    S.data.models = (S.data.models || []).filter(model => model.published);
    writeCache();
    render();
  }

  async function loadAuxiliary() {
    const [clients, sidecar] = await Promise.all([
      requestJson(`${API}/clients`).catch(() => null),
      requestJson(`${API}/sidecar`).catch(() => null),
    ]);
    if (clients) S.clients = clients;
    if (sidecar) S.sidecar = sidecar;
    writeCache();
    if (S.data) render();
  }

  async function load() {
    const host = root();
    if (!host || S.loading) return;
    S.loading = true;
    const requestId = ++S.request;
    if (!S.data) {
      host.replaceChildren();
      host.setAttribute('aria-busy', 'true');
    } else {
      // Повторная загрузка: старые строки остаются на месте, сверху едет тонкая полоса.
      const shell = host.querySelector('.ag-shell') || host;
      if (!shell.querySelector('.ag-loadbar-inline')) {
        shell.insertBefore(element('span', { class: 'ag-loadbar ag-loadbar-inline', 'aria-hidden': 'true' }), shell.firstChild);
      }
    }
    try {
      const data = await requestJson(API);
      if (requestId !== S.request) return;
      S.data = data;
      if (typeof S.data.canWrite !== 'boolean') S.data.canWrite = true;
      writeCache();
      render();
      loadAuxiliary();
    } catch (error) {
      if (requestId !== S.request) return;
      host.replaceChildren(element('div', { class: 'ag-shell' }, [
        element('div', { class: 'ag-fatal', text: `API Gateway state: ${error.message}` }),
      ]));
    } finally {
      document.querySelectorAll('#api-gateway-root .ag-loadbar-inline, #api-gateway-root .ag-loading .ag-loadbar')
        .forEach(bar => bar.remove());
      host.removeAttribute('aria-busy');
      if (requestId === S.request) S.loading = false;
    }
  }

  function open() {
    if (S.data) {
      render();
      return;
    }
    load();
  }

  const restoredAtBoot = restoreCache();
  if (restoredAtBoot) render();
  if (restoredAtBoot) queueMicrotask(() => load());

  const api = Object.freeze({ load: open, refresh: load });
  window.API_GATEWAY = api;

  if (typeof window.showTab === 'function' && !window.showTab.__apiGatewayWrapped) {
    const hostShowTab = window.showTab;
    const wrappedShowTab = function (...args) {
      const result = hostShowTab.apply(this, args);
      if (args[0] === 'api-gateway') api.load();
      return result;
    };
    Object.defineProperty(wrappedShowTab, '__apiGatewayWrapped', { value: true });
    window.showTab = wrappedShowTab;
  }

  const active = document.querySelector('[data-tab-content="api-gateway"].active');
  if (active && !restoredAtBoot) api.load();
})();
