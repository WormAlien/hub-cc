(() => {
  'use strict';

  const API = '/__switch/api/api-gateway';
  const root = () => document.getElementById('api-gateway-root');
  const byId = (id) => document.getElementById(id);

  const S = {
    data: null,
    loading: false,
    wired: false,
    q: '',
    filter: 'all',
    request: 0,
  };

  const text = (value, fallback = '-') => {
    const string = String(value == null ? '' : value).trim();
    return string || fallback;
  };

  const countPublished = () => (S.data?.models || []).filter((model) => model.published).length;

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

  function statusTone(state) {
    const normalized = String(state || '').toLowerCase();
    if (['ready', 'healthy', 'running', 'current', 'ok'].includes(normalized)) return 'healthy';
    if (['failed', 'error', 'unhealthy', 'down'].includes(normalized)) return 'unhealthy';
    if (['drift', 'warning', 'stale'].includes(normalized)) return 'warning';
    return 'unknown';
  }

  function readableError(payload, response) {
    if (response?.status === 409 || payload?.error === 'revision_conflict') return 'Revision conflict. Reloaded state is required before Save.';
    return text(payload?.error || payload?.message, response ? `Request failed (${response.status})` : 'Request failed');
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
      notify('Copied', 'success');
    } catch {
      notify('Clipboard is unavailable', 'error');
    }
  }

  function setNavCount() {
    const counter = byId('nav-count-api-gateway');
    if (!counter || !S.data) return;
    counter.textContent = `${countPublished()}/${(S.data.models || []).length}`;
  }

  function copyLine(kind, value, key) {
    const button = element('button', {
      type: 'button',
      class: 'ag-button',
      text: 'Copy',
      dataset: { copy: key },
      'aria-label': `Copy ${kind} URL`,
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
    const status = text(sidecar.status, sidecar.installed === false ? 'not installed' : 'unknown');
    const checksum = text(sidecar.checksum, 'not available');
    const shortChecksum = checksum.length > 14 ? `${checksum.slice(0, 12)}...` : checksum;
    return element('section', { class: 'ag-surface ag-sidecar', dataset: { agSidecar: '' } }, [
      element('div', { class: 'ag-sidecar-head' }, [
        element('div', {}, [
          element('div', { class: 'ag-eyebrow', text: 'Protocol sidecar' }),
          element('div', { class: 'ag-sidecar-name', text: 'Bifrost' }),
        ]),
        badge(status, statusTone(sidecar.health || status), text(sidecar.health || status)),
      ]),
      element('div', { class: 'ag-facts' }, [
        fact('Pinned version', sidecar.version),
        fact('Checksum', shortChecksum),
        fact('Install', sidecar.installState || (sidecar.installed ? 'installed' : 'not installed')),
        fact('Health', sidecar.health),
        fact('Restart', typeof sidecar.restart === 'object' ? sidecar.restart.detail || sidecar.restart.state : sidecar.restart),
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
    setRowMessage(row, 'Saving...', '');
    button.disabled = true;
    try {
      const body = readRow(row);
      if (!body.id || !body.displayName || !body.claudeBehavesAs || !Number.isSafeInteger(body.contextTokens) || body.contextTokens <= 0 || !Number.isSafeInteger(body.outputTokens) || body.outputTokens <= 0) {
        throw new Error('Label, behavesAs, context, and output limits are required. Limits must be positive integers.');
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
      row.dataset.published = String(body.published);
      setRowMessage(row, 'Saved manifest + Claude picker', 'ok');
      setNavCount();
      renderModelGroups();
      const savedRow = [...document.querySelectorAll('.ag-model')].find((item) => item.dataset.modelId === body.id);
      if (savedRow) setRowMessage(savedRow, 'Saved manifest + Claude picker', 'ok');
      const revision = byId('ag-revision');
      if (revision) revision.textContent = `manifest r${S.data.manifest.revision}`;
      const publishedBadge = row.querySelector('.ag-badge');
      if (publishedBadge) {
        publishedBadge.textContent = body.published ? 'Published' : 'Hidden';
        publishedBadge.className = `ag-badge ag-badge--${body.published ? 'published' : 'hidden'}`;
      }
      notify('Saved manifest + Claude picker', 'success');
    } catch (error) {
      setRowMessage(row, error.message, 'error');
      notify(error.message, 'error');
    } finally {
      button.disabled = !S.data?.canWrite;
    }
  }

  function renderModel(model) {
    const disabled = !S.data.canWrite;
    const published = input('published', '', 'checkbox', {
      class: 'ag-toggle',
      checked: Boolean(model.published),
      disabled,
      'aria-label': `${model.published ? 'Hide' : 'Publish'} ${model.id}`,
    });
    const save = element('button', {
      type: 'button',
      class: 'ag-button ag-button--primary ag-save',
      text: 'Save',
      disabled,
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
        modelBadges(model),
      ]),
      field('Label', input('displayName', model.displayName, 'text', { disabled, maxlength: 160 })),
      field('behavesAs', input('claudeBehavesAs', model.claudeBehavesAs, 'text', { disabled, maxlength: 120 })),
      field('Context', input('contextTokens', model.contextTokens, 'number', { disabled, min: 1, step: 1, inputmode: 'numeric' })),
      field('Output', input('outputTokens', model.outputTokens, 'number', { disabled, min: 1, step: 1, inputmode: 'numeric' })),
      element('div', { class: 'ag-model-action' }, [
        save,
        element('div', { class: 'ag-row-message', 'aria-live': 'polite' }),
      ]),
    ]);
    save.addEventListener('click', () => saveModel(row));
    return row;
  }

  function sortedModels() {
    return [...(S.data?.models || [])].sort((a, b) => {
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
      box.append(element('div', { class: 'ag-empty', text: 'No models match this search and filter.' }));
      return;
    }
    for (const group of groups) {
      box.append(element('section', { class: 'ag-provider-group', dataset: { provider: group.provider } }, [
        element('div', { class: 'ag-provider-head' }, [
          element('span', { class: 'ag-provider-name', text: group.provider }),
          element('span', { class: 'ag-count', text: `${group.rows.length} model${group.rows.length === 1 ? '' : 's'}` }),
        ]),
        element('div', { class: 'ag-provider-models' }, group.rows.map(renderModel)),
      ]));
    }
  }

  function clientStatus(client = {}) {
    return badge(text(client.status, 'unknown'), statusTone(client.status), client.detail || client.status || 'unknown');
  }

  function setClientMessage(card, message, kind) {
    const output = card.querySelector('.ag-client-message');
    output.textContent = message || '';
    output.dataset.kind = kind || '';
  }

  function claudeCard(client = {}) {
    return element('section', { class: 'ag-surface ag-client', dataset: { client: 'claude' } }, [
      element('div', { class: 'ag-client-head' }, [
        element('div', { class: 'ag-client-title', text: 'Claude Code' }),
        clientStatus(client),
      ]),
      element('div', { class: 'ag-client-detail', text: client.detail || `${client.publishedModels ?? countPublished()} published models in modelPicker.` }),
      element('div', { class: 'ag-client-message', text: 'Save changes manifest and Claude modelPicker together.' }),
    ]);
  }

  async function openCodePreview(card) {
    const output = byId('ag-opencode-preview');
    setClientMessage(card, 'Loading preview...', '');
    try {
      const data = await requestJson(`${API}/opencode/preview`);
      output.replaceChildren();
      const targets = Array.isArray(data.targets) ? data.targets : [];
      if (!targets.length) output.append(element('div', { class: 'ag-empty', text: 'No OpenCode targets were reported.' }));
      for (const target of targets) {
        output.append(element('div', { class: 'ag-preview-row' }, [
          element('span', {}, [
            element('strong', { text: text(target.label, 'OpenCode target') }),
            document.createTextNode(` - ${text(target.status, 'unknown')}`),
          ]),
          element('span', { class: 'ag-count', text: `add ${Number(target.additions || 0)} / remove ${Number(target.removals || 0)} / change ${Number(target.changes || 0)}` }),
        ]));
      }
      setClientMessage(card, 'Preview is redacted. Review it before Sync.', 'ok');
    } catch (error) {
      setClientMessage(card, error.message, 'error');
    }
  }

  async function syncClient(card, kind) {
    if (!S.data?.canWrite) return;
    const button = card.querySelector(`[data-action="${kind === 'opencode' ? 'sync' : 'sync'}"]`);
    if (button) button.disabled = true;
    setClientMessage(card, 'Syncing...', '');
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
    const card = element('section', { class: 'ag-surface ag-client', dataset: { client: 'opencode' } });
    const preview = element('button', { type: 'button', class: 'ag-button', text: 'Preview', dataset: { action: 'preview' } });
    const sync = element('button', { type: 'button', class: 'ag-button ag-button--primary', text: 'Sync', dataset: { action: 'sync' }, disabled: !S.data.canWrite });
    card.append(
      element('div', { class: 'ag-client-head' }, [element('div', { class: 'ag-client-title', text: 'OpenCode' }), clientStatus(client)]),
      element('div', { class: 'ag-client-detail', text: client.detail || 'Preview and Sync only the abuse-hub provider in configured targets.' }),
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
    const running = client.backendRunning === true || client.running === true
      || (client.backendRunning === undefined && client.running === undefined
        && !['absent', 'blocked', 'down', 'stopped', 'unsupported_api'].includes(status));
    const card = element('section', { class: 'ag-surface ag-client', dataset: { client: 'hermes' } });
    const detail = client.detail || client.syncInstruction || (installed ? 'Connect only the abuse-hub endpoint. Current model is preserved.' : 'Hermes is absent. Install and start it before Sync.');
    const actions = element('div', { class: 'ag-client-actions' });
    const sync = element('button', {
      type: 'button',
      class: 'ag-button ag-button--primary',
      text: 'Sync',
      dataset: { action: 'sync' },
      disabled: !S.data.canWrite || !installed || !running,
    });
    actions.append(sync);
    const body = [
      element('div', { class: 'ag-client-head' }, [element('div', { class: 'ag-client-title', text: 'Hermes' }), clientStatus(client)]),
      element('div', { class: 'ag-client-detail', text: detail }),
    ];
    if (client.installCommand) body.push(element('code', { class: 'ag-code', text: client.installCommand }));
    if (client.startCommand || client.startInstruction) body.push(element('code', { class: 'ag-code', text: client.startCommand || client.startInstruction }));
    if (client.yaml) body.push(element('code', { class: 'ag-code', text: client.yaml }));
    body.push(actions, element('div', { class: 'ag-client-message', 'aria-live': 'polite' }));
    card.append(...body);
    sync.addEventListener('click', () => syncClient(card, 'hermes'));
    return card;
  }

  function render() {
    const host = root();
    if (!host || !S.data) return;
    const publicUrls = S.data.public || {};
    const sidecar = S.data.sidecar || {};
    const clients = S.data.clients || {};
    host.replaceChildren(element('main', { class: 'ag-shell' }, [
      element('header', { class: 'ag-header' }, [
        element('div', {}, [
          element('p', { class: 'ag-kicker', text: 'One localhost gateway' }),
          element('h1', { class: 'ag-title', text: 'API Gateway' }),
          element('p', { class: 'ag-subtitle', text: 'Publish exact provider/model IDs once, then project the same allowlist into Claude Code, OpenCode, and Hermes.' }),
        ]),
        element('div', { class: 'ag-header-meta' }, [
          element('span', { id: 'ag-revision', class: 'ag-revision', text: `manifest r${text(S.data.manifest?.revision, '?')}` }),
          S.data.canWrite ? null : element('span', { class: 'ag-readonly', text: 'Read-only: writes disabled' }),
        ]),
      ]),
      element('div', { class: 'ag-overview' }, [
        element('section', { class: 'ag-surface ag-endpoints' }, [
          element('div', { class: 'ag-eyebrow', text: 'Public loopback URLs' }),
          element('div', { class: 'ag-endpoint-list' }, [
            copyLine('Anthropic', text(publicUrls.anthropicBaseUrl), 'anthropic'),
            copyLine('OpenAI', text(publicUrls.openaiBaseUrl), 'openai'),
          ]),
        ]),
        renderSidecar(sidecar),
      ]),
      element('aside', {
        class: 'ag-surface ag-policy',
        text: 'Hidden removes picker only; exact ID remains callable; red health never reroutes; Save updates manifest+Claude; OpenCode needs Preview/Sync; current model never changes.',
      }),
      element('section', { class: 'ag-surface ag-models-panel' }, [
        element('div', { class: 'ag-models-head' }, [
          element('div', {}, [
            element('h2', { class: 'ag-section-title', text: 'Published models and candidates' }),
            element('p', { class: 'ag-section-note', text: 'Published rows stay first even when missing or unhealthy. Catalog, passive traffic, probe, and health remain independent.' }),
          ]),
          element('div', { class: 'ag-tools' }, [
            element('input', { id: 'ag-search', class: 'ag-input ag-search', type: 'search', placeholder: 'Search model or provider', value: S.q, 'aria-label': 'Search API Gateway models' }),
            element('select', { id: 'ag-filter', class: 'ag-select ag-filter', value: S.filter, 'aria-label': 'Filter API Gateway models' }, [
              element('option', { value: 'all', text: 'All states' }),
              element('option', { value: 'published', text: 'Published' }),
              element('option', { value: 'hidden', text: 'Hidden' }),
              element('option', { value: 'unhealthy', text: 'Unhealthy' }),
              element('option', { value: 'warning', text: 'Warning' }),
              element('option', { value: 'unknown', text: 'Unknown' }),
            ]),
          ]),
        ]),
        element('div', { id: 'ag-model-groups', class: 'ag-model-groups' }),
      ]),
      element('section', { class: 'ag-clients' }, [
        claudeCard(clients.claude || {}),
        openCodeCard(clients.openCode || clients.opencode || {}),
        hermesCard(clients.hermes || {}),
      ]),
      element('div', { class: 'ag-global-message', 'aria-live': 'polite' }),
    ]));
    setNavCount();
    const search = byId('ag-search');
    const filter = byId('ag-filter');
    search.addEventListener('input', () => { S.q = search.value; renderModelGroups(); });
    filter.value = S.filter;
    filter.addEventListener('change', () => { S.filter = filter.value; renderModelGroups(); });
    renderModelGroups();
  }

  async function load() {
    const host = root();
    if (!host || S.loading) return;
    S.loading = true;
    const requestId = ++S.request;
    if (!S.data) host.replaceChildren(element('div', { class: 'ag-loading', text: 'Loading API Gateway state...' }));
    try {
      const data = await requestJson(API);
      if (requestId !== S.request) return;
      S.data = data;
      if (typeof S.data.canWrite !== 'boolean') S.data.canWrite = true;
      render();
    } catch (error) {
      if (requestId !== S.request) return;
      host.replaceChildren(element('div', { class: 'ag-shell' }, [
        element('div', { class: 'ag-fatal', text: `API Gateway state: ${error.message}` }),
      ]));
    } finally {
      if (requestId === S.request) S.loading = false;
    }
  }

  const api = Object.freeze({ load, refresh: load });
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
  if (active) api.load();
})();
