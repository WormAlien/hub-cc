#!/usr/bin/env node
'use strict';
// Real dashboard + local assets, intercepted API fixtures only. No live hub,
// provider inference, owner maps/settings, or lifecycle processes are touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const routing = path.join(root, 'routing');
const dashboard = fs.readFileSync(process.env.UC_ADVANCED_DASH || path.join(routing, 'proxy-dashboard.html'), 'utf8');
const scratch = process.env.HERMES_TEST_SCRATCH || 'C:/Users/WormAlien/AppData/Local/hermes/cache/scratch';
fs.mkdirSync(scratch, { recursive: true });
const out = fs.mkdtempSync(path.join(scratch, 'uc-advanced-modelmap-'));
const origin = 'http://127.0.0.1:45393';
const observations = [], failures = [], networkViolations = [], blockedRequests = [];
const phase = process.env.UC_ADVANCED_PHASE || 'save';

async function scenario(browser, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  let catalog = [{ id: 'gpt-6.1-sol' }, { id: 'free/nested/draft-target' }, { id: 'gpt-6-astra' },
    { id: 'vendor/' + 'long-model-name-'.repeat(12) }];
  let saved = { opus: 'saved/vendor/legacy-target', sonnet: 'gpt-6.1-sol', haiku: null, gpt: 'untouched-gpt-route' };
  let active = 'gpt-6.1-sol';
  let saveMode = 'success';
  const requests = [], errors = [];
  const sessions = [{ id: 'fixture-uc', name: 'UncensoredLabs browser fixture', email: 'uc@example.test',
    api_key: 'sk-uc-browser-fixture-not-a-secret', active: true, status: 'live', balance: 5, granted: 5 }];
  await context.addInitScript(() => {
    if (!localStorage.getItem('opencode_active_tab')) localStorage.setItem('opencode_active_tab', 'claude');
    window.__ucCopied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async text => window.__ucCopied.push(text) } });
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) {
      const blocked = { width, method: req.method(), url: req.url() };
      blockedRequests.push(blocked);
      // The unchanged dashboard requests optional FX rates at boot. Still block
      // it before any network access, without treating it as a UC-side write.
      if (req.url() !== 'https://www.cbr-xml-daily.ru/daily_json.js') networkViolations.push(blocked);
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: dashboard });
    if (url.pathname.startsWith('/vendor/')) {
      const file = path.resolve(routing, 'vendor', url.pathname.slice('/vendor/'.length));
      if (file.startsWith(path.resolve(routing, 'vendor') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file);
        return route.fulfill({ contentType: ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'font/woff2', body: fs.readFileSync(file) });
      }
    }
    requests.push({ method: req.method(), path: url.pathname, body: req.postData() ? req.postDataJSON() : null });
    let body = { ok: false, error: 'isolated fixture: optional endpoint unavailable' }, status = 404;
    if (url.pathname === '/__switch/api/status') {
      body = { current: 'uncensoredlabs', backends: { uncensoredlabs: { label: 'UncensoredLabs', base_url: origin } }, oauth: {} }; status = 200;
    } else if (url.pathname === '/__switch/api/uc/sessions') { body = { ok: true, sessions }; status = 200; }
    else if (url.pathname === '/__switch/api/sessions') { body = { ok: true, sessions: [] }; status = 200; }
    else if (url.pathname === '/__switch/api/uc/models') { body = { ok: true, models: catalog }; status = 200; }
    else if (url.pathname === '/__switch/api/uc/active-model') { body = { ok: true, model: active }; status = 200; }
    else if (url.pathname === '/__switch/api/uc/modelmap' && req.method() === 'GET') { body = { ok: true, modelMap: saved }; status = 200; }
    else if (url.pathname === '/__switch/api/uc/modelmap' && req.method() === 'POST') {
      const input = req.postDataJSON();
      assert.deepEqual(Object.keys(input).sort(), ['haiku', 'opus', 'sonnet'], 'existing payload has exactly three tier values');
      if (saveMode === 'failure') { body = { ok: false, error: 'UC fixture save failed' }; status = 500; }
      else if (saveMode === 'network-failure') return route.abort('failed');
      else {
        saved = { ...saved, ...Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value || null])) };
        body = { ok: true, modelMap: saved }; status = 200;
      }
    }
    else if (url.pathname === '/__switch/api/uc/keepalive/state') {
      const cfg = { hedgeMs: 20000, maxHedges: 0, maxAttempts: 3, preCommitMs: 10000, poolFallbackModel: '' };
      body = { ok: true, port: 45394, cfg, defaults: cfg, stats: {}, latency: {} }; status = 200;
    } else if (url.pathname === '/__switch/api/uc/autoreg/status') { body = { ok: true, running: false, stdout: '' }; status = 200; }
    else if (url.pathname.endsWith('/auto/status')) {
      body = { ok: true, enabled: false, shared: true, switches: 0, poolReady: 1, poolBalance: 5 }; status = 200;
    } else if (url.pathname === '/__switch/api/api-gateway') {
      body = { ok: true, canWrite: true, providers: ['uncensoredlabs'], manifest: { version: 1, revision: 7, enabled: true },
        models: [], candidatesLoaded: false, public: { anthropicBaseUrl: origin, openaiBaseUrl: origin + '/openai/v1' } }; status = 200;
    } else if (req.method() !== 'GET' && req.method() !== 'HEAD') {
      networkViolations.push({ width, method: req.method(), url: req.url() });
      return route.abort('blockedbyclient');
    }
    return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.locator('#main-nav .nav-btn[data-tab="uncensoredlabs"]').click();
    await page.waitForFunction(() => document.getElementById('uc-mm-opus')?.value === 'saved/vendor/legacy-target'
      && document.querySelector('#uc-models-list [data-publication-chip]'));
    const details = page.locator('#uc-modelmap');
    const markup = await details.evaluate(node => ({ tag: node.tagName, open: node.open,
      previous: node.previousElementSibling?.id, summary: node.querySelector(':scope > summary')?.textContent.trim(),
      text: node.textContent, insideCatalog: !!document.querySelector('#uc-models #uc-modelmap') }));
    assert.equal(markup.tag, 'DETAILS', 'uc-modelmap must be a native disclosure below the catalog');
    assert.equal(markup.open, false, 'advanced mapping is closed on first load');
    assert.equal(markup.previous, 'uc-models', 'advanced mapping belongs immediately below uc-models');
    assert.equal(markup.summary, 'Дополнительно - маппинг тиров');
    assert.equal(markup.insideCatalog, false, 'catalog select/copy/publication stay outside the advanced tier mapping');
    assert.match(markup.text, /совместим/i, 'mapping explains client compatibility');
    assert.match(markup.text, /Bifrost/, 'exact Bifrost selection is not tier mapping');
    assert.doesNotMatch(markup.text, /opus-only|только.*opus/i);
    assert.equal(await page.locator('#uc-mm-opus').isVisible(), false);
    assert.equal(await page.locator('#uc-models-list [data-publication-chip="uncensoredlabs/free/nested/draft-target"] button[title^="Копировать"]').count(), 1);
    assert.equal(await page.locator('#uc-models-list [data-publication-slot="uncensoredlabs/free/nested/draft-target"]').count(), 1);
    await page.locator('#uc-models-list [data-publication-chip="uncensoredlabs/free/nested/draft-target"] button[title^="Копировать"]').click();
    await page.waitForFunction(() => window.__ucCopied.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__ucCopied), ['/model free/nested/draft-target[1m]'], 'catalog copy preserves the existing exact nested ID command without selecting or saving it');
    await details.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'closed-' + width + '.png') });
    await details.locator(':scope > summary').click();
    assert.equal(await details.evaluate(node => node.open), true);
    assert.equal(await page.locator('#uc-mm-haiku').inputValue(), '', 'null saved target keeps existing empty option');
    assert.equal(await page.locator('#uc-mm-opus option[value="saved/vendor/legacy-target"]').count(), 1, 'saved out-of-catalog target is retained');
    await page.evaluate(() => { window.__ucDetailsBeforeRefresh = document.getElementById('uc-modelmap'); });
    await page.evaluate(async () => { await loadUcModelMap(); await loadUcModels(false); });
    assert.equal(await page.evaluate(() => window.__ucDetailsBeforeRefresh === document.getElementById('uc-modelmap')
      && document.getElementById('uc-modelmap').open), true, 'ordinary refresh never replaces/closes the native details');
    assert.equal(requests.filter(req => req.method === 'POST').length, 0, 'opening and ordinary refresh do not save, publish, activate, or change the main model');
    const layout = await details.evaluate(node => {
      const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
      return { viewport: innerWidth, card: rect(node), fields: [...node.querySelectorAll('select,button,summary')].map(rect),
        overflow: node.scrollWidth > node.clientWidth + 1 };
    });
    assert.equal(layout.overflow, false, 'advanced mapping has no horizontal overflow');
    assert.ok(layout.card.left >= 0 && layout.card.right <= width + 1, 'details fit viewport');
    assert.ok(layout.fields.every(field => field.width > 0 && field.left >= layout.card.left && field.right <= layout.card.right + 1), 'long options and summary fit details at ' + width + 'px');
    await page.screenshot({ path: path.join(out, 'open-' + width + '.png') });
    await page.locator('#main-nav .nav-btn[data-tab="settings"]').click();
    await page.locator('#main-nav .nav-btn[data-tab="uncensoredlabs"]').click();
    assert.equal(await details.evaluate(node => node.open), true, 'return to the tab retains native open state');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('uc-mm-opus')?.value === 'saved/vendor/legacy-target');
    assert.equal(await page.locator('#uc-modelmap').evaluate(node => node.open), false, 'F5 closes disclosure and reads saved map');
    assert.equal(active, 'gpt-6.1-sol');
    assert.deepEqual(saved, { opus: 'saved/vendor/legacy-target', sonnet: 'gpt-6.1-sol', haiku: null, gpt: 'untouched-gpt-route' });
    if (phase !== 'markup') {
      await page.locator('#uc-modelmap > summary').click();
      await page.locator('#uc-mm-opus').selectOption('free/nested/draft-target');
      await page.evaluate(() => { window.__ucDetailsBeforeRefresh = document.getElementById('uc-modelmap'); });
      saved = { ...saved, opus: 'server/saved-new-opus', sonnet: 'gpt-6-astra', haiku: 'saved/new/haiku' };
      await page.evaluate(() => loadUcModelMap());
      assert.equal(await page.locator('#uc-mm-opus').inputValue(), 'free/nested/draft-target', 'fresh saved state must not overwrite a user-changed tier');
      assert.equal(await page.locator('#uc-mm-sonnet').inputValue(), 'gpt-6-astra', 'untouched tier follows fresh saved state');
      assert.equal(await page.locator('#uc-mm-haiku').inputValue(), 'saved/new/haiku', 'untouched null tier can receive a fresh saved target');
      assert.deepEqual(await page.evaluate(() => state.ucModelMap), saved, 'draft is separate from authoritative saved map');
      catalog = [{ id: 'gpt-6-astra' }];
      await page.evaluate(() => loadUcModels(true));
      await page.waitForFunction(() => document.querySelectorAll('#uc-models-list [data-publication-chip]').length === 1);
      assert.equal(await page.locator('#uc-mm-opus').inputValue(), 'free/nested/draft-target', 'dirty nested ID survives disappearing from catalog');
      assert.equal(await page.locator('#uc-mm-opus option[value="free/nested/draft-target"]').count(), 1, 'missing draft target remains an option');
      await page.locator('[data-tab-content="uncensoredlabs"] button[onclick="loadUcSessions(false)"]').click();
      await page.waitForFunction(() => document.getElementById('uc-list').textContent.includes('uc@example.test'));
      await page.evaluate(() => loadUcModelMap());
      assert.equal(await page.locator('#uc-mm-opus').inputValue(), 'free/nested/draft-target', 'ordinary session refresh preserves draft');
      assert.equal(await page.evaluate(() => window.__ucDetailsBeforeRefresh === document.getElementById('uc-modelmap')
        && document.getElementById('uc-modelmap').open), true, 'dirty refresh preserves details node and native open state');
      assert.equal(requests.filter(req => req.method === 'POST').length, 0, 'draft refresh never writes the saved map or main model');
      await page.locator('#uc-modelmap').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, 'draft-refresh-' + width + '.png') });
      await page.locator('#main-nav .nav-btn[data-tab="settings"]').click();
      await page.locator('#main-nav .nav-btn[data-tab="uncensoredlabs"]').click();
      assert.equal(await page.locator('#uc-mm-opus').inputValue(), 'free/nested/draft-target', 'return to provider preserves unsaved tier draft');
      assert.equal(await page.locator('#uc-modelmap').evaluate(node => node.open), true);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.getElementById('uc-mm-opus')?.value === 'server/saved-new-opus');
      assert.equal(await page.locator('#uc-modelmap').evaluate(node => node.open), false, 'F5 closes disclosure and drops only the unsaved browser draft');
      assert.equal(active, 'gpt-6.1-sol');
    }
    if (phase === 'save') {
      await page.locator('#uc-modelmap > summary').click();
      catalog = [{ id: 'gpt-6-astra' }, { id: 'free/nested/save-target' }];
      await page.evaluate(() => loadUcModels(true));
      await page.waitForFunction(() => document.querySelector('#uc-mm-opus option[value="free/nested/save-target"]'));
      await page.locator('#uc-mm-opus').selectOption('free/nested/save-target');
      await page.locator('#uc-mm-sonnet').selectOption('');
      const beforeFailure = { ...saved };
      saveMode = 'failure';
      await page.locator('#uc-modelmap button[onclick="ucSaveModelMap()"]').click();
      await page.waitForFunction(() => document.getElementById('toasts').textContent.includes('UC fixture save failed'));
      await page.evaluate(() => loadUcModelMap());
      assert.equal(await page.locator('#uc-mm-opus').inputValue(), 'free/nested/save-target', 'failed explicit save retains dirty value');
      assert.equal(await page.locator('#uc-mm-sonnet').inputValue(), '', 'failed save retains an intentional empty tier');
      assert.deepEqual(saved, beforeFailure, 'failed save does not wipe or change persisted map');
      saveMode = 'network-failure';
      await page.evaluate(() => ucSaveModelMap());
      await page.evaluate(() => loadUcModelMap());
      assert.equal(await page.locator('#uc-mm-opus').inputValue(), 'free/nested/save-target', 'network failure retains dirty value');
      assert.deepEqual(saved, beforeFailure);
      saveMode = 'success';
      await page.locator('#uc-modelmap button[onclick="ucSaveModelMap()"]').click();
      await page.waitForFunction(() => document.getElementById('toasts').textContent.includes('маппинг сохранён'));
      const expectedPayload = { opus: 'free/nested/save-target', sonnet: '', haiku: 'saved/new/haiku' };
      assert.deepEqual(requests.filter(req => req.method === 'POST').map(req => req.body), [expectedPayload, expectedPayload, expectedPayload]);
      assert.deepEqual(saved, { ...expectedPayload, sonnet: null, gpt: 'untouched-gpt-route' }, 'existing three-tier payload and unrelated saved values preserved');
      await page.evaluate(() => loadUcModelMap());
      assert.deepEqual(await page.evaluate(() => state.ucModelMap), saved, 'readback of exact fixture target confirms successful save');
      saved = { ...saved, opus: 'server/after-success', sonnet: 'server/after-empty-save' };
      await page.evaluate(() => loadUcModelMap());
      assert.equal(await page.locator('#uc-mm-opus').inputValue(), 'server/after-success', 'successful save clears the acknowledged draft before fresh saved state');
      assert.equal(await page.locator('#uc-mm-sonnet').inputValue(), 'server/after-empty-save', 'successful empty save is no longer dirty');
      assert.equal(active, 'gpt-6.1-sol', 'saving tier compatibility never changes main model identity');
      assert.equal(await page.locator('#uc-modelmap').evaluate(node => node.open), true, 'save/reconcile leaves native details open');
      await page.locator('#uc-mm-opus').selectOption('free/nested/save-target');
      let releaseSave;
      const saveGate = new Promise(resolve => { releaseSave = resolve; });
      await page.route('**/__switch/api/uc/modelmap', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        await saveGate;
        return route.fallback();
      });
      const inFlightSave = page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === '/__switch/api/uc/modelmap');
      await page.locator('#uc-modelmap button[onclick="ucSaveModelMap()"]').click();
      await inFlightSave;
      await page.locator('#uc-mm-opus').selectOption('gpt-6-astra');
      saved = { ...saved, sonnet: 'server/while-save-pending' };
      await page.evaluate(() => loadUcModelMap());
      assert.equal(await page.locator('#uc-mm-sonnet').inputValue(), 'server/while-save-pending', 'untouched tier can refresh while save is pending');
      const saveResponse = page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === '/__switch/api/uc/modelmap');
      releaseSave();
      await saveResponse;
      await page.evaluate(() => loadUcModelMap());
      assert.equal(await page.locator('#uc-mm-opus').inputValue(), 'gpt-6-astra', 'successful save reconciles but does not erase edits made while request was pending');
      assert.equal(await page.locator('#uc-mm-sonnet').inputValue(), 'server/after-empty-save', 'untouched fresh display is not accidentally captured as a dirty draft');
      assert.equal(saved.opus, 'free/nested/save-target', 'save persisted submitted snapshot, not the later edit');
      assert.equal(await page.evaluate(() => state.ucModelMap.opus), saved.opus, 'main-model payload still uses saved state, not later draft');
      await page.locator('#uc-modelmap').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, 'saved-' + width + '.png') });
    }
    assert.deepEqual(errors, [], 'whole dashboard browser errors');
    observations.push({ width, phase, markup, layout, requests, errors, saved, active });
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'failure-' + width + '.png') }).catch(() => {});
    observations.push({ width, phase, requests, errors, saved, active });
    throw error;
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  try {
    for (const width of [1440, 393]) {
      try { await scenario(browser, width); passed++; console.log('PASS UC advanced tier mapping, phase=' + phase + ', width=' + width); }
      catch (error) { failures.push({ width, message: error.message, stack: error.stack }); console.error('FAIL UC advanced tier mapping, phase=' + phase + ', width=' + width + '\n' + error.stack); }
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ phase, passed, failed: failures.length, failures, observations, networkViolations, blockedRequests,
      scope: 'intercepted actual dashboard + assets; no live requests, owner writes, or production restarts' }, null, 2) + '\n');
  }
  console.log('check-uc-advanced-modelmap: ' + passed + ' passed, ' + failures.length + ' failed');
  console.log('evidence: ' + out);
  assert.deepEqual(networkViolations, [], 'network/write guard violations');
  process.exitCode = failures.length ? 1 : 0;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
