#!/usr/bin/env node
'use strict';

// Full production dashboard + local vendor assets, intercepted loopback fixture.
// Provider catalog/accounts/maps/publication responses are TEST FIXTURES, not live
// inference or production persistence. No hub, provider, profile or config starts.
// Run: node tools/check-provider-advanced-ui.js
// Optional: HERMES_TEST_SCRATCH=<scratch> PROVIDER_ADVANCED_DEADLINE_MS=540000
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ROUTING = path.join(ROOT, 'routing');
const SCRATCH = process.env.HERMES_TEST_SCRATCH || (process.platform === 'win32'
  ? 'C:/Users/WormAlien/AppData/Local/hermes/cache/scratch'
  : path.join(os.homedir(), '.cache/hermes/scratch'));
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = SCRATCH;
fs.mkdirSync(SCRATCH, { recursive: true });
const RUN = fs.mkdtempSync(path.join(SCRATCH, 'provider-advanced-ui-'));
const ORIGIN = 'http://127.0.0.1:45397'; // Intercepted; never a real listener.
const WIDTHS = [1440, 393];
const PROVIDERS = [
  { prefix: 'uc', suffix: 'Uc', tab: 'uncensoredlabs' },
  { prefix: 'xc', suffix: 'Xc', tab: 'xingchi' },
  { prefix: 'fg', suffix: 'Fg', tab: 'freegg' },
  { prefix: 'fx', suffix: 'Fx', tab: 'fxqidian' },
];
const AR = { prefix: 'ar', suffix: 'Ar', tab: 'agentrouter' };
const clone = value => structuredClone(value);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sources = new Map();
function source(file) {
  const rel = path.relative(ROOT, file).replaceAll('\\', '/');
  if (!sources.has(rel)) {
    const bytes = fs.readFileSync(file);
    sources.set(rel, { path: rel, sha256: sha(bytes), bytes: bytes.length, content: bytes });
  }
  return sources.get(rel).content;
}
// Freeze this run's source. Siblings may edit the working copy; never poll them.
const HTML = source(path.join(ROUTING, 'proxy-dashboard.html')).toString('utf8');
source(__filename);
const htmlSnapshot = path.join(RUN, 'dashboard-source.html');
fs.writeFileSync(htmlSnapshot, HTML);
const allTabs = [...new Set([...HTML.matchAll(/\bdata-tab="([^"]+)"/g)].map(m => m[1]))];
const visibleTabs = [...PROVIDERS.map(p => p.tab), 'agentrouter', 'health', 'claude'];
const cfg = { hedgeMs: 20000, maxHedges: 0, maxAttempts: 3, preCommitMs: 10000,
  poolFallbackModel: '', poolDeadMs: 900000 };
const expectedMatrix = PROVIDERS.flatMap(p => WIDTHS.map(width => `${p.prefix}:${width}`));
const expectedRegressions = WIDTHS.map(width => `ar:${width}`);
const evidence = {
  schemaVersion: 1, run: RUN, startedAt: new Date().toISOString(), command: 'node tools/check-provider-advanced-ui.js',
  scope: {
    real: ['unmodified complete dashboard source snapshot', 'local production vendor JS/CSS/fonts',
      'Chromium mouse/keyboard/navigation/reload', 'existing modelPublicationChip + MODEL_PUBLICATION JS'],
    fixtureOnly: ['provider catalogs/accounts/balances', 'in-memory provider map persistence and active model',
      'publication API responses and in-memory manifest, including explicit readback'],
    notVerified: ['live provider inference', 'owner files/keys/profiles/configs', 'production publication filesystem transaction',
      'production lifecycle', 'owner runtime rollout'],
    safety: 'Every browser HTTP request is fulfilled by this fixture or aborted. No route.continue, listener or production start.',
    a6api: 'Existing asset may load as part of the full dashboard; tab navigation and API requests are excluded and guarded.',
    saveFailure: 'Explicit HTTP 200 / ok:false application rejection; no fabricated successful save.',
  },
  expectedMatrix, expectedRegressions, cases: [], sourceSnapshot: htmlSnapshot,
};
let browser;
function persist() {
  fs.writeFileSync(path.join(RUN, 'receipt.json'), JSON.stringify(evidence, null, 2) + '\n');
}
function progress(text) {
  fs.appendFileSync(path.join(RUN, 'progress.log'), new Date().toISOString() + ' ' + text + '\n');
  console.log(text);
  persist();
}
function postCount(f) { return f.row.requests.filter(r => r.method === 'POST').length; }
function mapPosts(f) { return f.row.requests.filter(r => r.method === 'POST' && r.path === `/__switch/api/${f.p.prefix}/modelmap`); }
function selectionPosts(f) { return f.row.requests.filter(r => r.method === 'POST' && r.path.endsWith('/set-model')); }
function safeError(error) { return { name: error.name, message: error.message, stack: error.stack }; }

async function checkpoint(f, name, action) {
  f.row.phase = name;
  const check = { name, startedAt: new Date().toISOString() };
  f.row.checks.push(check);
  try { await action(); check.status = 'passed'; }
  catch (error) {
    check.status = 'failed'; check.error = safeError(error);
    await artifact(f, 'failure-' + name).catch(e => { check.artifactError = e.message; });
    progress(`RED ${f.row.key} ${name}: ${error.message.split('\n')[0]}`);
  }
  check.finishedAt = new Date().toISOString();
  persist();
  return check.status === 'passed';
}
async function settled(f) {
  await f.page.waitForFunction(() => window.__fixturePendingFetch === 0
    && performance.now() - window.__fixtureLastFetch > 120, null, { timeout: 12000 });
  await f.page.waitForFunction(() => !document.documentElement.classList.contains('tw-boot'), null, { timeout: 12000 });
}
async function artifact(f, label, fullPage = true) {
  const stem = `${f.row.key.replace(':', '-')}-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const shot = path.join(RUN, stem + '.png');
  await f.page.screenshot({ path: shot, fullPage, animations: 'disabled', timeout: 12000 });
  const item = { label, path: shot, width: f.row.width, fullPage, phase: f.row.phase };
  if (label.startsWith('failure')) {
    const state = await f.page.evaluate(prefix => {
      const d = document.getElementById(prefix + '-modelmap');
      const m = document.getElementById(prefix + '-models');
      const panel = d?.closest('[data-tab-content]');
      return { activeTab: localStorage.getItem('opencode_active_tab'), theme: document.documentElement.dataset.theme,
        activePanels: [...document.querySelectorAll('[data-tab-content].active')].map(e => e.dataset.tabContent),
        detail: d ? { tag: d.tagName, open: d.open, text: d.innerText, html: d.outerHTML } : null,
        models: m ? { text: m.innerText, html: m.outerHTML } : null,
        sections: panel ? [...panel.querySelectorAll('[id]')].map(e => e.id) : [],
        tiers: ['opus', 'sonnet', 'haiku', 'gpt'].map(tier => ({ tier,
          value: document.getElementById(prefix + '-mm-' + tier)?.value })),
        toasts: document.getElementById('toasts')?.innerText };
    }, f.p.prefix);
    item.state = path.join(RUN, stem + '.json');
    fs.writeFileSync(item.state, JSON.stringify({ ...state, fixtureMap: f.maps[f.p.prefix],
      fixtureActive: f.active[f.p.prefix], requestCount: f.row.requests.length }, null, 2) + '\n');
  }
  f.row.screenshots.push(item);
  persist();
}
async function tierValues(f) {
  return f.page.evaluate(prefix => Object.fromEntries(['opus', 'sonnet', 'haiku'].map(tier =>
    [tier, document.getElementById(prefix + '-mm-' + tier)?.value])), f.p.prefix);
}
async function chooseDraft(f, draft) {
  for (const [tier, value] of Object.entries(draft)) await f.page.locator(`#${f.p.prefix}-mm-${tier}`).selectOption(value);
}
async function assertDraft(f, draft) {
  assert.equal(await f.detail.evaluate(e => e.open), true, 'advanced open state survives refresh');
  assert.deepEqual(await tierValues(f), draft, 'unsaved tier values survive refresh, including out-of-catalog targets');
}
async function readback(f, label) {
  const data = await f.page.evaluate(async prefix => {
    const map = await (await fetch(`/__switch/api/${prefix}/modelmap`)).json();
    const active = await (await fetch(`/__switch/api/${prefix}/active-model`)).json();
    const publication = await (await fetch('/__switch/api/api-gateway')).json();
    return { map, active, publication };
  }, f.p.prefix);
  f.row.readbacks.push({ label, ...data });
  return data;
}
async function navigate(f, tab) {
  assert.notEqual(tab, 'a6api', 'test must never navigate a6api');
  await f.page.locator(`.nav-btn[data-tab="${tab}"]`).click();
  await f.page.locator(`[data-tab-content="${tab}"].active`).waitFor({ state: 'visible' });
  await settled(f);
}

async function fixture(p, width, kind = 'matrix') {
  const row = { key: `${p.prefix}:${width}`, kind, provider: p.tab, prefix: p.prefix, width, height: 900,
    status: 'running', phase: 'boot', checks: [], requests: [], blockedExternal: [], blockedWebSockets: [],
    blockedMutations: [], a6apiRequests: [], unexpectedLocalReads: [], rawConsoleErrors: [],
    consoleErrors: [], pageErrors: [], warnings: [], routeErrors: [], screenshots: [], readbacks: [], enumerations: [] };
  evidence.cases.push(row);
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const maps = {}, active = {}, catalogs = {}, sessions = {};
  for (const provider of [...PROVIDERS, AR]) {
    const pre = provider.prefix;
    catalogs[pre] = pre === 'ar' ? ['gpt-5.6-sol', 'gpt-6.1-sol']
      : ['claude-opus-5', `fixture/${pre}/catalog-exact-model`, 'gpt-6.1-sol'];
    active[pre] = catalogs[pre][0];
    maps[pre] = pre === 'ar' ? { opus: 'gpt-6.1-sol', sonnet: 'gpt-5.6-sol', haiku: 'gpt-5.6-sol', gpt: '' }
      : { opus: `fixture/${pre}/saved-out-of-catalog-opus`, sonnet: `fixture/${pre}/saved-out-of-catalog-sonnet`, haiku: catalogs[pre][0] };
    sessions[pre] = [{ id: `fixture-${pre}`, name: `TEST FIXTURE ${provider.tab}`, email: `${pre}.fixture@example.test`,
      api_key: `sk-fixture-only-not-a-live-key-${pre}`, active: true, status: 'live', balance: 42,
      granted: 100, grant: 100, spent: 58, balanceSource: 'self', balanceCheckedAt: new Date().toISOString(),
      createdAt: '2026-11-01T00:00:00.000Z' }];
  }
  let revision = 7;
  const published = new Map([...PROVIDERS, AR].map(provider => [provider.tab + '/' + catalogs[provider.prefix][0], {
    displayName: `FIXTURE ${provider.tab}`, contextTokens: 1000000, outputTokens: 32000,
    claudeBehavesAs: 'claude-opus-5', publishedAt: '2026-11-01T00:00:00.000Z',
  }]));
  const manifest = () => ({ version: 1, revision, enabled: true, models: Object.fromEntries(published) });
  const publicationState = () => ({ ok: true, fixture: true, canWrite: true, manifest: manifest(),
    providers: [...PROVIDERS, AR].map(provider => provider.tab), candidatesLoaded: true,
    models: [...PROVIDERS, AR].flatMap(provider => catalogs[provider.prefix].map(model => {
      const id = provider.tab + '/' + model;
      return { id, provider: provider.tab, model, published: published.has(id),
        ...(published.get(id) || { displayName: `FIXTURE ${model}`, contextTokens: 1000000, outputTokens: 32000, claudeBehavesAs: 'claude-opus-5' }),
        health: { state: 'unknown' }, source: 'acceptance-fixture' };
    })), public: { anthropicBaseUrl: ORIGIN, openaiBaseUrl: ORIGIN + '/openai/v1' } });
  const f = { p, row, context, maps, active, catalogs, sessions, failNextSave: false };
  await context.addInitScript(({ tab, tabs, visible }) => {
    if (!localStorage.getItem('opencode_active_tab')) localStorage.setItem('opencode_active_tab', tab);
    localStorage.setItem('dashboard-tabs-config-v1', JSON.stringify({ order: visible, hidden: tabs.filter(t => !visible.includes(t)), shown: [] }));
    if (!localStorage.getItem('dashboard-theme')) localStorage.setItem('dashboard-theme', 'zen');
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.__copied.push(text) } });
    // Observe, never stub, throttle or suppress production fetch behavior.
    const original = window.fetch.bind(window);
    window.__fixturePendingFetch = 0; window.__fixtureLastFetch = 0;
    window.fetch = async (...args) => {
      window.__fixturePendingFetch++;
      try { return await original(...args); }
      finally { window.__fixturePendingFetch--; window.__fixtureLastFetch = performance.now(); }
    };
  }, { tab: p.tab, tabs: allTabs, visible: visibleTabs });
  if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => {
    row.blockedWebSockets.push(socket.url()); socket.close();
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== ORIGIN) {
      row.blockedExternal.push({ url: req.url(), method: req.method(), phase: row.phase, disposition: 'aborted' });
      return route.abort('blockedbyclient');
    }
    const pathname = url.pathname;
    if (pathname === '/') {
      const banner = '<div data-acceptance-fixture style="position:fixed;top:0;left:0;right:0;z-index:10000;padding:3px 8px;background:#143425;color:#bbf7d0;font:11px system-ui;pointer-events:none">TEST FIXTURE - local dashboard/assets; fake provider data; no live inference or owner writes</div>';
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML.replace(/(<body\b[^>]*>)/i, '$1' + banner) });
    }
    if (pathname.startsWith('/vendor/')) {
      const file = path.resolve(ROUTING, 'vendor', decodeURIComponent(pathname.slice('/vendor/'.length)));
      const base = path.resolve(ROUTING, 'vendor') + path.sep;
      if (file.startsWith(base) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
        return route.fulfill({ contentType: type, body: source(file) });
      }
      row.routeErrors.push({ path: pathname, message: 'missing local asset' });
      return route.abort('blockedbyclient');
    }
    let input;
    try { input = req.postData() ? req.postDataJSON() : undefined; }
    catch { input = { invalidJSON: true }; }
    const record = { method: req.method(), path: pathname, query: url.search, body: input, phase: row.phase };
    row.requests.push(record);
    if (/\/(?:a6api|a6)(?:\/|$)/i.test(pathname)) {
      row.a6apiRequests.push(record); return route.abort('blockedbyclient');
    }
    const mutation = !['GET', 'HEAD'].includes(req.method());
    const providerMatch = /^\/__switch\/api\/(uc|xc|fg|fx|ar)\/(.*)$/.exec(pathname);
    const pre = providerMatch?.[1], tail = providerMatch?.[2];
    const allowed = req.method() === 'POST' && (
      pre === p.prefix && tail === 'modelmap' && ['save-failure', 'save-success', 'ar-save'].includes(row.phase)
      || pre === p.prefix && tail === 'set-model' && row.phase === 'exact-selection'
      || pathname === '/__switch/api/api-gateway/publication' && ['publication-on', 'publication-off'].includes(row.phase));
    const send = async (body, status = 200) => {
      record.status = status;
      return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
    };
    if (mutation && !allowed) {
      row.blockedMutations.push(record);
      return send({ ok: false, fixture: true, error: 'fixture_safety_guard_unexpected_mutation' });
    }
    try {
      if (pathname === '/__switch/api/status') return send({ current: p.tab, backends: Object.fromEntries([...PROVIDERS, AR].map(provider =>
        [provider.tab, { label: `FIXTURE ${provider.tab}`, base_url: ORIGIN }])), oauth: {} });
      if (pathname === '/__switch/api/api-gateway') return send(publicationState());
      if (pathname === '/__switch/api/api-gateway/publication') {
        assert.deepEqual(Object.keys(input).sort(), ['expectedRevision', 'id', 'published']);
        assert.equal(input.expectedRevision, revision);
        assert.equal(typeof input.published, 'boolean');
        assert.ok(publicationState().models.some(m => m.id === input.id));
        if (input.published) published.set(input.id, { displayName: `FIXTURE ${input.id}`, contextTokens: 1000000,
          outputTokens: 32000, claudeBehavesAs: 'claude-opus-5', publishedAt: new Date().toISOString() });
        else published.delete(input.id);
        revision++;
        record.mutation = 'fixture-publication-only';
        return send({ ok: true, fixture: true, model: { id: input.id, published: input.published }, manifest: manifest(),
          opencode: { ok: true, scope: 'fixture-response-only-no-filesystem-sync' } });
      }
      if (providerMatch) {
        if (tail === 'sessions') return send({ ok: true, fixture: true, sessions: sessions[pre], activeModel: active[pre], modelMap: maps[pre] });
        if (tail === 'models') {
          const models = catalogs[pre].map(id => ({ id, supported_endpoint_types: ['openai'], source: 'acceptance-fixture' }));
          if (pre === 'ar') models.push({ id: 'gpt-6-astra', source: 'retired-fixture-should-not-render' });
          return send({ ok: true, fixture: true, models, data: models });
        }
        if (tail === 'active-model') return send({ ok: true, fixture: true, model: active[pre] });
        if (tail === 'modelmap') {
          if (req.method() === 'POST') {
            assert.deepEqual(Object.keys(input).sort(), (pre === 'ar' ? ['gpt', 'haiku', 'opus', 'sonnet'] : ['haiku', 'opus', 'sonnet']));
            if (f.failNextSave) { f.failNextSave = false; record.mutation = 'fixture-map-rejected';
              return send({ ok: false, fixture: true, error: 'fixture_write_rejected' }); }
            maps[pre] = clone(input); record.mutation = 'fixture-map-committed';
          }
          return send({ ok: true, fixture: true, modelMap: maps[pre] });
        }
        if (tail === 'set-model') {
          assert.equal(input.model, catalogs[pre][1]);
          assert.deepEqual(input.modelMap || maps[pre], maps[pre], 'selection sends saved map, never a tier draft');
          active[pre] = input.model; record.mutation = 'fixture-main-selection';
          return send({ ok: true, fixture: true, model: active[pre], settingsModel: active[pre] + '[1m]' });
        }
        if (tail === 'balance') return send({ ok: true, fixture: true, status: 'live', balance: 42, spent: 58, granted: 100,
          balanceSource: 'self', balanceCheckedAt: new Date().toISOString() });
        if (tail === 'model-tests') return send({ ok: true, fixture: true, results: {} }); // Passive read, never inference POST.
        if (tail === 'autoreg/status') return send({ ok: true, fixture: true, running: false, stage: 'test fixture idle', stdout: [] });
        if (tail === 'checkin-config') return send({ ok: true, fixture: true, checkin: { resetHhmmMsk: '20:30', bonusUsd: 25 } });
        if (tail === 'checkin-events') return send({ ok: true, fixture: true, seq: 1, events: [] });
      }
      if (/\/keepalive\/state$/.test(pathname)) return send({ ok: true, fixture: true, port: 0, up: true,
        cfg, config: cfg, defaults: cfg, stats: {}, latency: {} });
      if (/\/keepalive\/latency$/.test(pathname)) return send({ ok: true, fixture: true, points: [],
        window_sec: Number(url.searchParams.get('window') || 86400), now: Date.now(), total_all: 0, proxy_state: 'up', source: 'fixture' });
      if (/\/auto\/status$/.test(pathname)) return send({ ok: true, fixture: true, enabled: false, shared: true,
        source: 'fixture', sources: ['fixture'], entries: [], runs: [], events: [] });
      if (pathname === '/__switch/api/health') return send({ ok: true, fixture: true, current: p.tab,
        services: [{ name: 'TEST FIXTURE control plane', port: 0, status: 'up' }], wired: { base: ORIGIN } });
      if (pathname === '/__switch/api/routes') return send({ ok: true, fixture: true, providers: [...PROVIDERS, AR].map(provider => ({
        name: provider.tab, tiers: maps[provider.prefix], gatewayTiers: maps[provider.prefix] })) });
      if (pathname === '/__switch/api/gemini/list') return send({ ok: true, fixture: true, accounts: [], server: { up: false }, tiers: [] });
      if (pathname === '/__switch/api/gemini/modelmap') return send({ ok: true, fixture: true, modelMap: {}, activeModel: null });
      // Unrelated passive boot reads get explicitly empty fixture shapes. They are
      // enumerated in the receipt, not mistaken for production responses.
      row.unexpectedLocalReads.push({ path: pathname, query: url.search, phase: row.phase });
      return send({ ok: true, fixture: true, fixtureScope: 'empty-unrelated-passive-read', sessions: [], accounts: [],
        entries: [], events: [], runs: [], shared: [], keys: [], models: [], data: [], rows: [],
        history: [], items: [], services: [], building: false, running: false, results: {}, checkin: {} });
    } catch (error) {
      row.routeErrors.push({ request: record, error: safeError(error) });
      return send({ ok: false, fixture: true, error: 'fixture_contract_failure' });
    }
  });
  f.page = await context.newPage();
  f.page.setDefaultTimeout(10000);
  f.page.on('pageerror', error => row.pageErrors.push(error.message));
  f.page.on('console', message => {
    if (message.type() === 'error') row.rawConsoleErrors.push({ text: message.text(), location: message.location(), phase: row.phase });
    if (message.type() === 'warning') row.warnings.push({ text: message.text(), phase: row.phase });
  });
  f.detail = f.page.locator('#' + p.prefix + '-modelmap');
  f.models = f.page.locator('#' + p.prefix + '-models');
  f.row.initialMap = clone(maps[p.prefix]);
  f.row.initialActive = active[p.prefix];
  return f;
}

async function enumeration(f) {
  const data = await f.page.evaluate(prefix => {
    const d = document.getElementById(prefix + '-modelmap'), m = document.getElementById(prefix + '-models');
    const rect = e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }; };
    const chips = [...m.querySelectorAll('[data-publication-chip]')].map(e => ({ id: e.dataset.publicationChip,
      copyButtons: e.querySelectorAll('button[title^="Копировать"]').length,
      switches: e.querySelectorAll('input[data-publication-id]').length, inDetails: !!e.closest('details') }));
    const tiers = ['opus', 'sonnet', 'haiku'].map(tier => {
      const s = document.getElementById(prefix + '-mm-' + tier);
      return { tier, value: s?.value, options: s ? [...s.options].map(o => o.value) : [] };
    });
    return { tag: d.tagName, open: d.open, summary: d.querySelector('summary')?.innerText,
      belowInDOM: !!(m.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING),
      independent: !m.contains(d) && !d.contains(m), modelRect: rect(m), detailRect: rect(d),
      catalog: chips, tiers, sectionOrder: [...d.parentElement.children].map(e => ({ tag: e.tagName, id: e.id, title: e.querySelector('h2, summary')?.innerText })) };
  }, f.p.prefix);
  data.catalogUnique = [...new Set(data.catalog.map(c => c.id))].sort();
  data.catalogCount = data.catalog.length; data.catalogUniqueCount = data.catalogUnique.length;
  for (const tier of data.tiers) { tier.uniqueOptions = [...new Set(tier.options)]; tier.count = tier.options.length; tier.uniqueCount = tier.uniqueOptions.length; }
  f.row.enumerations.push(data);
  return data;
}
async function publication(f, wanted, draft) {
  const id = f.p.tab + '/' + f.catalogs[f.p.prefix][1];
  const toggle = f.models.locator(`input[data-publication-id="${id}"]`);
  const before = await readback(f, wanted ? 'before-publication-on' : 'before-publication-off');
  const mapCount = mapPosts(f).length, selectCount = selectionPosts(f).length;
  await toggle.waitFor({ state: 'visible' });
  await f.page.waitForFunction(id => [...document.querySelectorAll('input[data-publication-id]')]
    .some(e => e.dataset.publicationId === id && !e.disabled), id);
  await toggle.click();
  await f.page.waitForFunction(([id, wanted]) => [...document.querySelectorAll('input[data-publication-id]')]
    .some(e => e.dataset.publicationId === id && !e.disabled && e.checked === wanted), [id, wanted]);
  await settled(f);
  const after = await readback(f, wanted ? 'publication-on-readback' : 'publication-off-readback');
  const write = f.row.requests.filter(r => r.path === '/__switch/api/api-gateway/publication' && r.method === 'POST').at(-1);
  assert.deepEqual(write?.body, { expectedRevision: before.publication.manifest.revision, id, published: wanted });
  assert.equal(after.publication.models.find(m => m.id === id)?.published, wanted);
  assert.equal(after.publication.manifest.revision, before.publication.manifest.revision + 1);
  assert.deepEqual(after.map.modelMap, before.map.modelMap, 'publication cannot save tiers');
  assert.equal(after.active.model, before.active.model, 'publication cannot select a main model');
  assert.equal(mapPosts(f).length, mapCount);
  assert.equal(selectionPosts(f).length, selectCount);
  if (draft) await assertDraft(f, draft);
}
async function copyExact(f) {
  const id = f.p.tab + '/' + f.catalogs[f.p.prefix][1];
  const chip = f.models.locator(`[data-publication-chip="${id}"]`);
  const before = postCount(f), copies = await f.page.evaluate(() => window.__copied.length);
  await chip.locator('button[title^="Копировать"]').click();
  await f.page.waitForFunction(n => window.__copied.length === n + 1, copies);
  const actual = await f.page.evaluate(() => window.__copied.at(-1));
  const expected = '/model ' + (f.p.prefix === 'ar' ? id : f.catalogs[f.p.prefix][1]) + '[1m]';
  f.row.clipboard = { actual, expected };
  assert.equal(actual, expected, 'copy preserves exact nested vendor ID and existing command semantics');
  assert.equal(postCount(f), before, 'copy cannot write mapping, select, activate or publish');
}
async function basicFlow(f) {
  const pre = f.p.prefix, before = postCount(f);
  for (const id of [pre + '-energy', pre + '-models', pre + '-keepalive', pre + '-list']) {
    const section = f.page.locator('#' + id);
    assert.equal(await section.count(), 1, 'preserve full-dashboard section ' + id);
    assert.equal(await section.isVisible(), true);
    assert.equal(await section.evaluate(e => !!e.closest('details')), false, id + ' stays outside advanced mapping');
  }
  assert.match(await f.page.locator('#' + pre + '-list').innerText(), new RegExp(pre + '\\.fixture@example\\.test'));
  assert.match(await f.page.locator('#' + pre + '-energy').innerText(), /42[.,]00/);
  await f.page.locator('#' + pre + '-keepalive button').filter({ hasText: '↻' }).first().click();
  await settled(f);
  assert.equal(await f.page.locator('#' + pre + '-keepalive-attempts').inputValue(), '3');
  assert.equal(await f.page.locator('#' + pre + '-keepalive-maxhedges').inputValue(), '0');
  assert.doesNotMatch(await f.page.locator('#' + pre + '-keepalive-status').innerText(), /ошибка|undefined|NaN/i);
  const balance = f.page.locator('#' + pre + '-list button[onclick^="' + pre + 'CheckBalance"]');
  await balance.first().click(); await settled(f);
  assert.match(await balance.first().innerText(), /42[.,]00/);
  await f.page.locator('#' + pre + '-list').scrollIntoViewIfNeeded();
  await artifact(f, 'accounts-balance-keepalive', false);
  if (pre !== 'ar') {
    await f.page.locator('#' + pre + '-filter').fill('no-such-fixture-account');
    assert.match(await f.page.locator('#' + pre + '-list').innerText(), /ничего|0 из/);
    await f.page.locator('#' + pre + '-filter').fill('');
    await f.page.locator('#' + pre + '-sort').selectOption('bal-desc');
    await f.page.locator(`[data-tab-content="${f.p.tab}"] button[onclick="${pre}ShowAdd()"]`).click();
    assert.equal(await f.page.locator('#' + pre + '-add-form').isVisible(), true);
    await f.page.locator('#' + pre + '-add-form button[onclick="' + pre + 'ShowAdd(false)"]').click();
    assert.equal(await f.page.locator('#' + pre + '-add-form').isVisible(), false);
    if (pre === 'uc') assert.equal(await f.page.locator('#uc-autoreg').isVisible(), true);
  } else {
    for (const id of ['ar-checkin', 'ar-journal']) assert.equal(await f.page.locator('#' + id).isVisible(), true);
  }
  assert.equal(postCount(f), before, 'basic passive flow never starts, activates or writes');
}
async function guards(f) {
  // Keep deliberate transport aborts visible in raw evidence; they are not JS
  // console.error calls. Everything else is asserted, never suppressed.
  f.row.consoleErrors = f.row.rawConsoleErrors.filter(e => {
    const external = f.row.blockedExternal.some(r => r.url === e.location.url);
    const blockedTransport = external && /^Failed to load resource:.*(?:ERR_BLOCKED_BY_CLIENT|ERR_FAILED)/.test(e.text);
    if (blockedTransport) e.expectedBlockedTransport = true;
    return !blockedTransport;
  });
  assert.deepEqual(f.row.consoleErrors, [], 'application console errors = 0');
  assert.deepEqual(f.row.pageErrors, [], 'uncaught page errors = 0');
  assert.deepEqual(f.row.routeErrors, [], 'fixture contract failures = 0');
  assert.deepEqual(f.row.blockedMutations, [], 'no unexpected lifecycle/activation/mutation request even attempted');
  assert.deepEqual(f.row.a6apiRequests, [], 'a6api API requests = 0');
  assert.ok(f.row.blockedExternal.every(r => r.disposition === 'aborted'), 'all external requests aborted');
  assert.equal(f.row.requests.filter(r => r.method === 'POST' && /\/(activate|switch|restart|start|stop|open|provision)(?:\/|$)/.test(r.path)).length, 0);
}

async function matrixCase(p, width) {
  const f = await fixture(p, width);
  const pre = p.prefix, initial = clone(f.maps[pre]), initialActive = f.active[pre];
  const draft = { ...initial, opus: f.catalogs[pre][1], haiku: '' };
  progress('START ' + f.row.key);
  try {
    const ready = await checkpoint(f, 'full-dashboard-ready', async () => {
      await f.page.goto(ORIGIN, { waitUntil: 'load', timeout: 25000 });
      await navigate(f, p.tab);
      await f.page.locator('#' + pre + '-mm-opus').waitFor({ state: 'attached' });
      await f.models.locator('[data-publication-chip]').first().waitFor();
      await settled(f);
      assert.equal(postCount(f), 0, 'initial load has no POST');
      assert.equal(await f.page.locator('[data-tab-content]').count() > 20, true, 'real complete dashboard, not stripped HTML');
    });
    if (!ready) return;
    await checkpoint(f, 'collapsed-below-catalog', async () => {
      const data = await enumeration(f);
      assert.equal(data.tag, 'DETAILS');
      assert.equal(data.summary, 'Дополнительно - маппинг тиров');
      assert.equal(data.open, false);
      assert.equal(await f.page.locator('#' + pre + '-mm-opus').isVisible(), false);
      assert.equal(data.belowInDOM && data.independent, true, 'actual DOM order: separate details after catalog');
      assert.ok(data.detailRect.top >= data.modelRect.bottom - 1, 'actual rendered advanced block is below catalog');
      assert.equal(data.catalogCount, f.catalogs[pre].length);
      assert.equal(data.catalogUniqueCount, data.catalogCount, 'enumerated exact catalog contains no duplicate model controls');
      for (const chip of data.catalog) assert.deepEqual([chip.copyButtons, chip.switches, chip.inDetails], [1, 1, false]);
      await artifact(f, 'closed-full');
      await f.models.scrollIntoViewIfNeeded(); await artifact(f, 'closed-catalog', false);
    });
    const advanced = await checkpoint(f, 'mouse-keyboard-open-no-post', async () => {
      const before = postCount(f), summary = f.detail.locator('summary');
      await summary.click(); assert.equal(await f.detail.evaluate(e => e.open), true, 'mouse opens native details');
      await summary.focus(); await summary.press('Space');
      assert.equal(await f.detail.evaluate(e => e.open), false, 'Space closes native details');
      await summary.press('Enter'); assert.equal(await f.detail.evaluate(e => e.open), true, 'Enter opens native details');
      assert.equal(postCount(f), before);
      await artifact(f, 'open-full');
      await f.detail.scrollIntoViewIfNeeded(); await artifact(f, 'open-advanced', false);
    });
    await checkpoint(f, 'saved-out-of-catalog-and-deduped-options', async () => {
      assert.deepEqual(await tierValues(f), initial, 'opening does not coerce saved unavailable targets');
      const data = await enumeration(f);
      for (const tier of data.tiers) {
        assert.equal(tier.count, tier.uniqueCount, 'deduplicated options: ' + tier.tier);
        assert.ok(tier.options.includes(initial[tier.tier]));
      }
      assert.deepEqual(f.maps[pre], initial); assert.equal(f.active[pre], initialActive);
    });
    await checkpoint(f, 'basic-full-flow', () => basicFlow(f));
    await checkpoint(f, 'exact-copy-outside-details', () => copyExact(f));
    if (!advanced) {
      f.row.checks.push({ name: 'draft-save-refresh-flow', status: 'blocked', reason: 'native summary/open prerequisite failed; production code not patched by test' });
      return;
    }
    await checkpoint(f, 'draft-edit', async () => { await chooseDraft(f, draft); await assertDraft(f, draft); });
    await checkpoint(f, 'publication-on', () => publication(f, true, draft));
    for (const [label, fn, arg] of [['loadModels', 'load' + p.suffix + 'Models', true],
      ['loadModelMap', 'load' + p.suffix + 'ModelMap', undefined], ['loadSessions', 'load' + p.suffix + 'Sessions', false]]) {
      await checkpoint(f, 'draft-retained-' + label, async () => {
        const before = postCount(f);
        await f.page.evaluate(([name, argument]) => window[name](argument), [fn, arg]);
        await settled(f); await assertDraft(f, draft); assert.equal(postCount(f), before);
      });
    }
    await checkpoint(f, 'revisit-retains-open-and-draft', async () => {
      const before = postCount(f); await navigate(f, 'health'); await navigate(f, p.tab);
      await assertDraft(f, draft); assert.equal(postCount(f), before);
    });
    await checkpoint(f, 'close-open-retains-draft', async () => {
      const before = postCount(f), summary = f.detail.locator('summary');
      await summary.click(); assert.equal(await f.detail.evaluate(e => e.open), false);
      await summary.focus(); await summary.press('Enter'); await assertDraft(f, draft);
      assert.equal(postCount(f), before);
    });
    // Re-enter exact input only to make failure/success checks independent of a
    // previous RED refresh assertion; this is recorded, not a production fix.
    await checkpoint(f, 'save-failure', async () => {
      f.row.saveSetup = { draft, note: 're-entered via actual selects for independent save assertions' };
      await chooseDraft(f, draft);
      if (!await f.detail.evaluate(e => e.open)) await f.detail.locator('summary').click();
      const before = mapPosts(f).length, beforeSelection = selectionPosts(f).length;
      f.failNextSave = true;
      await f.detail.locator(`button[onclick="${pre}SaveModelMap()"]`).click(); await settled(f);
      assert.equal(mapPosts(f).length, before + 1);
      assert.equal(mapPosts(f).at(-1).mutation, 'fixture-map-rejected');
      assert.deepEqual(mapPosts(f).at(-1).body, draft);
      await assertDraft(f, draft);
      const data = await readback(f, 'rejected-save-readback');
      assert.deepEqual(data.map.modelMap, initial);
      assert.equal(data.active.model, initialActive);
      assert.equal(selectionPosts(f).length, beforeSelection);
      assert.match(await f.page.locator('#toasts').innerText(), /fixture_write_rejected|ошибка/i);
    });
    await checkpoint(f, 'failed-draft-retained-after-read', async () => {
      await f.page.evaluate(name => window[name](), 'load' + p.suffix + 'ModelMap');
      await settled(f); await assertDraft(f, draft);
    });
    await checkpoint(f, 'save-success', async () => {
      await chooseDraft(f, draft);
      const before = mapPosts(f).length, beforeSelection = selectionPosts(f).length;
      await f.detail.locator(`button[onclick="${pre}SaveModelMap()"]`).click(); await settled(f);
      assert.equal(mapPosts(f).length, before + 1);
      assert.deepEqual(mapPosts(f).at(-1).body, draft);
      assert.equal(mapPosts(f).at(-1).mutation, 'fixture-map-committed');
      const data = await readback(f, 'successful-save-readback');
      assert.deepEqual(data.map.modelMap, draft, 'read the exact map endpoint after success');
      assert.equal(data.active.model, initialActive, 'tier save never selects a main model');
      assert.equal(selectionPosts(f).length, beforeSelection); await assertDraft(f, draft);
    });
    await checkpoint(f, 'f5-closed-persisted-map', async () => {
      const before = postCount(f);
      await f.page.reload({ waitUntil: 'load', timeout: 25000 }); await settled(f); await navigate(f, p.tab);
      assert.equal(await f.detail.evaluate(e => e.open), false, 'F5 returns to collapsed default');
      assert.deepEqual(await tierValues(f), draft);
      const data = await readback(f, 'f5-readback');
      assert.deepEqual(data.map.modelMap, draft); assert.equal(data.active.model, initialActive);
      assert.equal(postCount(f), before); await artifact(f, 'f5-closed-full');
    });
    await checkpoint(f, 'publication-off', async () => {
      await publication(f, false);
      assert.equal(await f.detail.evaluate(e => e.open), false, 'publication cannot expand advanced mapping');
    });
    await checkpoint(f, 'exact-copy-while-collapsed', async () => { await copyExact(f); assert.equal(await f.detail.evaluate(e => e.open), false); });
    await checkpoint(f, 'exact-selection', async () => {
      const before = selectionPosts(f).length, mapsBefore = mapPosts(f).length;
      const id = p.tab + '/' + f.catalogs[pre][1];
      await f.models.locator(`[data-publication-chip="${id}"] .mp-choice`).click({ position: { x: 8, y: 8 } });
      await settled(f);
      assert.equal(selectionPosts(f).length, before + 1);
      assert.equal(selectionPosts(f).at(-1).body.model, f.catalogs[pre][1]);
      const data = await readback(f, 'explicit-selection-readback');
      assert.equal(data.active.model, f.catalogs[pre][1]); assert.deepEqual(data.map.modelMap, draft);
      assert.equal(mapPosts(f).length, mapsBefore);
      assert.equal(await f.detail.evaluate(e => e.open), false);
    });
    if (pre === 'uc') await checkpoint(f, 'representative-light-dark', async () => {
      const before = postCount(f);
      await f.page.evaluate(() => applyTheme('daylight', false));
      assert.equal(await f.page.evaluate(() => document.documentElement.style.colorScheme), 'light');
      await f.models.scrollIntoViewIfNeeded(); await artifact(f, 'light-closed-full');
      await f.detail.locator('summary').click(); await artifact(f, 'light-open-full');
      assert.deepEqual(await tierValues(f), draft);
      await f.page.evaluate(() => applyTheme('zen', false));
      assert.equal(await f.page.evaluate(() => document.documentElement.style.colorScheme), 'dark');
      assert.equal(postCount(f), before);
    });
  } finally {
    await checkpoint(f, 'safety-console-network', () => guards(f));
    f.row.finalMap = clone(f.maps[pre]); f.row.finalActive = f.active[pre];
    f.row.status = f.row.checks.every(c => c.status === 'passed') ? 'passed' : 'failed';
    await f.context.close(); f.row.contextClosed = true;
    progress(`END ${f.row.key} ${f.row.status.toUpperCase()}`);
  }
}
async function regressionCase(width) {
  const f = await fixture(AR, width, 'agentrouter-regression');
  progress('START ' + f.row.key);
  try {
    const ready = await checkpoint(f, 'ar-full-dashboard-ready', async () => {
      await f.page.goto(ORIGIN, { waitUntil: 'load', timeout: 25000 }); await navigate(f, AR.tab);
      await f.models.locator('[data-publication-chip]').first().waitFor(); await settled(f);
    });
    if (!ready) return;
    await checkpoint(f, 'ar-baseline-closed-two-sol', async () => {
      const data = await enumeration(f);
      assert.equal(data.tag, 'DETAILS'); assert.equal(data.open, false);
      assert.equal(data.summary, 'Дополнительно - маппинг тиров');
      assert.equal(data.belowInDOM && data.independent, true);
      assert.ok(data.detailRect.top >= data.modelRect.bottom - 1);
      assert.deepEqual(data.catalogUnique, ['agentrouter/gpt-5.6-sol', 'agentrouter/gpt-6.1-sol']);
      assert.equal(data.catalogCount, 2);
      assert.doesNotMatch(await f.models.innerText(), /astra/i);
      assert.equal(await f.page.locator('#arq-mini, #arq-big, #arq-sched, #ar-keepalive-pooldrop').count(), 0);
      await artifact(f, 'closed-full');
    });
    await checkpoint(f, 'ar-copy', () => copyExact(f));
    await checkpoint(f, 'ar-basic', () => basicFlow(f));
    await checkpoint(f, 'ar-open-no-post', async () => {
      const before = postCount(f); await f.detail.locator('summary').focus(); await f.detail.locator('summary').press('Enter');
      assert.equal(await f.detail.evaluate(e => e.open), true); assert.equal(postCount(f), before); await artifact(f, 'open-full');
    });
    await checkpoint(f, 'publication-on', () => publication(f, true));
    await checkpoint(f, 'ar-save', async () => {
      await f.page.locator('#ar-mm-haiku').selectOption('gpt-6.1-sol');
      await f.detail.locator('button[onclick="arSaveModelMap()"] ').click(); await settled(f);
      const data = await readback(f, 'ar-explicit-save');
      assert.equal(data.map.modelMap.haiku, 'gpt-6.1-sol'); assert.equal(data.active.model, f.row.initialActive);
    });
    await checkpoint(f, 'ar-f5-closed', async () => {
      await f.page.reload({ waitUntil: 'load', timeout: 25000 }); await settled(f); await navigate(f, AR.tab);
      assert.equal(await f.detail.evaluate(e => e.open), false);
      assert.equal(await f.page.locator('#ar-mm-haiku').inputValue(), 'gpt-6.1-sol');
      assert.equal(f.row.requests.filter(r => /\/ar\/quota|\/routes\/pool-(drop|restore)/.test(r.path)).length, 0);
    });
    await checkpoint(f, 'publication-off', () => publication(f, false));
  } finally {
    await checkpoint(f, 'safety-console-network', () => guards(f));
    f.row.finalMap = clone(f.maps.ar); f.row.finalActive = f.active.ar;
    f.row.status = f.row.checks.every(c => c.status === 'passed') ? 'passed' : 'failed';
    await f.context.close(); f.row.contextClosed = true; progress(`END ${f.row.key} ${f.row.status.toUpperCase()}`);
  }
}
function finish() {
  const matrix = evidence.cases.filter(c => c.kind === 'matrix');
  const regression = evidence.cases.filter(c => c.kind === 'agentrouter-regression');
  const matrixKeys = [...new Set(matrix.map(c => c.key))].sort();
  const regressionKeys = [...new Set(regression.map(c => c.key))].sort();
  const checks = evidence.cases.flatMap(c => c.checks);
  const requests = evidence.cases.flatMap(c => c.requests);
  evidence.counts = {
    expectedMatrix: expectedMatrix.length, matrixEnumerated: matrix.map(c => c.key), matrixUnique: matrixKeys,
    matrixCount: matrix.length, matrixUniqueCount: matrixKeys.length, matrixPassed: matrix.filter(c => c.status === 'passed').length,
    matrixFailed: matrix.filter(c => c.status !== 'passed').length,
    expectedRegression: expectedRegressions.length, regressionEnumerated: regression.map(c => c.key), regressionUnique: regressionKeys,
    regressionCount: regression.length, regressionUniqueCount: regressionKeys.length,
    regressionPassed: regression.filter(c => c.status === 'passed').length, regressionFailed: regression.filter(c => c.status !== 'passed').length,
    checks: checks.length, checksPassed: checks.filter(c => c.status === 'passed').length,
    checksFailed: checks.filter(c => c.status === 'failed').length, checksBlocked: checks.filter(c => c.status === 'blocked').length,
    screenshots: evidence.cases.reduce((n, c) => n + c.screenshots.length, 0),
    requests: requests.length, postRequests: requests.filter(r => r.method === 'POST').length,
    mutations: requests.filter(r => r.mutation).map(r => ({ phase: r.phase, path: r.path, kind: r.mutation, body: r.body })),
    consoleErrors: evidence.cases.reduce((n, c) => n + c.consoleErrors.length, 0),
    rawConsoleErrors: evidence.cases.reduce((n, c) => n + c.rawConsoleErrors.length, 0),
    pageErrors: evidence.cases.reduce((n, c) => n + c.pageErrors.length, 0),
    blockedExternal: evidence.cases.reduce((n, c) => n + c.blockedExternal.length, 0),
    blockedWebSockets: evidence.cases.reduce((n, c) => n + c.blockedWebSockets.length, 0),
    unexpectedMutations: evidence.cases.reduce((n, c) => n + c.blockedMutations.length, 0),
    a6apiAPIRequests: evidence.cases.reduce((n, c) => n + c.a6apiRequests.length, 0),
    routeErrors: evidence.cases.reduce((n, c) => n + c.routeErrors.length, 0),
    lifecycleActivationPosts: requests.filter(r => r.method === 'POST' && /\/(activate|switch|restart|start|stop|open|provision)(?:\/|$)/.test(r.path)).length,
  };
  evidence.matrixComplete = matrix.length === expectedMatrix.length && matrixKeys.length === matrix.length
    && JSON.stringify(matrixKeys) === JSON.stringify([...expectedMatrix].sort());
  evidence.regressionComplete = regression.length === expectedRegressions.length && regressionKeys.length === regression.length
    && JSON.stringify(regressionKeys) === JSON.stringify([...expectedRegressions].sort());
  evidence.sourceHashes = [...sources.values()].map(({ content, ...entry }) => {
    const file = path.join(ROOT, entry.path);
    const currentSha256 = fs.existsSync(file) ? sha(fs.readFileSync(file)) : null;
    return { ...entry, currentSha256, workingCopyChangedDuringRun: currentSha256 !== entry.sha256 };
  });
  evidence.status = !evidence.fatal && evidence.matrixComplete && evidence.regressionComplete
    && evidence.cases.every(c => c.status === 'passed' && c.contextClosed) ? 'GREEN' : 'RED';
  evidence.finishedAt = new Date().toISOString();
  persist();
  console.log('PROVIDER_ADVANCED_RECEIPT ' + path.join(RUN, 'receipt.json'));
  console.log(JSON.stringify({ status: evidence.status, counts: evidence.counts, run: RUN }));
  process.exitCode = evidence.status === 'GREEN' ? 0 : 1;
}
(async () => {
  progress('SOURCE FROZEN ' + sources.get('routing/proxy-dashboard.html').sha256);
  const deadline = setTimeout(() => {
    evidence.fatal = { message: 'bounded acceptance deadline exceeded' };
    finish(); browser?.close().finally(() => process.exit(1));
  }, Number(process.env.PROVIDER_ADVANCED_DEADLINE_MS || 540000));
  try {
    browser = await chromium.launch({ headless: true, args: ['--disable-background-networking', '--disable-component-update'] });
    evidence.browserVersion = browser.version(); evidence.nodeVersion = process.version;
    for (const p of PROVIDERS) for (const width of WIDTHS) {
      try { await matrixCase(p, width); }
      catch (error) { evidence.fatal ||= safeError(error); progress('CASE ERROR ' + p.prefix + ':' + width + ' ' + error.message); }
    }
    for (const width of WIDTHS) {
      try { await regressionCase(width); }
      catch (error) { evidence.fatal ||= safeError(error); progress('CASE ERROR ar:' + width + ' ' + error.message); }
    }
  } catch (error) { evidence.fatal = safeError(error); }
  finally { clearTimeout(deadline); if (browser) await browser.close(); finish(); }
})().catch(error => { evidence.fatal = safeError(error); finish(); });
