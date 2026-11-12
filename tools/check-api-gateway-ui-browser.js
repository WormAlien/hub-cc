#!/usr/bin/env node
'use strict';

// Fully intercepted UI smoke. The local fixture server owns an OS-assigned IPv4
// loopback port, but every browser request must be fulfilled by Playwright.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const routing = path.join(root, 'routing');
const dashboardPath = path.join(routing, 'proxy-dashboard.html');
const scriptPath = path.join(routing, 'vendor', 'api-gateway-tab.js');
const stylePath = path.join(routing, 'vendor', 'api-gateway-tab.css');
const dashboard = fs.readFileSync(dashboardPath, 'utf8');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-ui-'));

function mustMatch(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, label);
  return match[0];
}

function jsonResponse(route, status, value) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(value),
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// Guard the verified AgentRouter copy command that was already present in the
// supplied dashboard base. The API Gateway insertion must not replace it.
assert.match(dashboard, /function arModelCommand\(id\) \{\s*const model = 'agentrouter\/' \+ String\(id \|\| ''\)\.replace\(\/\^\\\/\+\/, ''\);\s*return '\/model ' \+ withCtxSuffix\(model, 'agentrouter'\);\s*\}/);
assert.match(dashboard, /const cmd = arModelCommand\(id\);/);
assert.match(dashboard, /copyToClipboard\(\$\{cmdJ\}, \$\{cmdJ\}\)/);

// These static seams are intentionally checked before browser startup. In RED
// they fail because the tab has not been registered yet.
const navMarkup = mustMatch(
  dashboard,
  /<button[^>]*data-tab="api-gateway"[\s\S]*?<\/button>/,
  'API Gateway nav button is missing',
);
const tabMarkup = mustMatch(
  dashboard,
  /<div data-tab-content="api-gateway" id="tab-api-gateway"><div id="api-gateway-root"><\/div><\/div>/,
  'API Gateway root skeleton is missing',
);
const uiStyle = mustMatch(
  dashboard,
  /<link rel="stylesheet" href="\/vendor\/api-gateway-tab\.css">/,
  'API Gateway stylesheet link is missing',
);
const uiScript = mustMatch(
  dashboard,
  /<script src="\/vendor\/api-gateway-tab\.js"><\/script>/,
  'API Gateway script link is missing',
);
assert.match(dashboard, /const DEFAULT_TABS_VISIBLE = \[[^\]]*'api-gateway'[^\]]*\];/);
assert.ok(fs.existsSync(scriptPath), 'API Gateway script is missing');
assert.ok(fs.existsSync(stylePath), 'API Gateway stylesheet is missing');

const themeScript = [...dashboard.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .find((match) => match[1].includes('const THEMES ='))?.[0];
assert.ok(themeScript, 'dashboard theme script is missing');

const publishedMissingId = 'agentrouter/gpt-5.6-sol';
const healthyPublishedId = 'a6api/gpt-6-sol';
const sameProviderCandidateId = 'a6api/gpt-5-hidden';
const xssCandidateId = 'candidate/<img src=x onerror=window.__xss=1>';
const nestedCandidateId = 'gemini/models/claude-opus';
const now = new Date().toISOString();
let state = {
  ok: true,
  canWrite: true,
  public: {
    anthropicBaseUrl: 'http://127.0.0.1:20100',
    openaiBaseUrl: 'http://127.0.0.1:20100/openai/v1',
  },
  manifest: { version: 1, revision: 7, enabled: true },
  models: [
    {
      id: publishedMissingId,
      provider: 'agentrouter',
      model: 'gpt-5.6-sol',
      published: true,
      displayName: 'AgentRouter / GPT 5.6 Sol',
      claudeBehavesAs: 'claude-opus-5',
      contextTokens: 1050000,
      outputTokens: 32000,
      publishedAt: now,
      catalog: { present: false, source: 'configured' },
      passive: { lastSuccess: null },
      probe: { ok: false, at: now, reason: 'upstream unavailable' },
      health: { state: 'unhealthy', reason: 'Published model is missing from discovery' },
    },
    {
      id: healthyPublishedId,
      provider: 'a6api',
      model: 'gpt-6-sol',
      published: true,
      displayName: 'A6API / GPT 6 Sol',
      claudeBehavesAs: 'claude-sonnet-5',
      contextTokens: 200000,
      outputTokens: 24000,
      publishedAt: now,
      catalog: { present: true, source: 'live' },
      passive: { lastSuccess: now },
      probe: { ok: true, at: now, reason: null },
      health: { state: 'healthy', reason: null },
    },
    {
      id: sameProviderCandidateId,
      provider: 'a6api',
      model: 'gpt-5-hidden',
      published: false,
      displayName: 'A6API / GPT 5 Hidden',
      claudeBehavesAs: 'claude-sonnet-5',
      contextTokens: 200000,
      outputTokens: 24000,
      publishedAt: null,
      catalog: { present: true, source: 'live' },
      passive: { lastSuccess: null },
      probe: { ok: null, at: null, reason: null },
      health: { state: 'unknown', reason: 'No evidence yet' },
    },
    {
      id: xssCandidateId,
      provider: 'candidate<script>window.__xss=2</script>',
      model: '<img src=x onerror=window.__xss=1>',
      published: false,
      displayName: '<svg onload=window.__xss=3>',
      claudeBehavesAs: 'claude-haiku-5',
      contextTokens: 64000,
      outputTokens: 8000,
      publishedAt: null,
      catalog: { present: true, source: 'pricing' },
      passive: { lastSuccess: null },
      probe: { ok: null, at: null, reason: '<img src=x onerror=window.__xss=4>' },
      health: { state: 'warning', reason: '<img src=x onerror=window.__xss=5>' },
    },
    {
      id: nestedCandidateId,
      provider: 'gemini',
      model: 'models/claude-opus',
      published: false,
      displayName: 'Needle Candidate',
      claudeBehavesAs: 'claude-opus-5',
      contextTokens: 128000,
      outputTokens: 16000,
      publishedAt: null,
      catalog: { present: true, source: 'snapshot' },
      passive: { lastSuccess: null },
      probe: { ok: null, at: null, reason: null },
      health: { state: 'unknown', reason: 'No evidence yet' },
    },
  ],
  sidecar: {
    status: 'running',
    installed: true,
    version: 'v2.5.0',
    checksum: '2736fffdeb99b3bc0f7d45aa1d84d3cda73a70800a35de99695488842731604d',
    installState: 'checksum verified',
    health: 'healthy',
    restart: { state: 'sidecar-only', detail: 'Use the hub sidecar restart action' },
  },
  clients: {
    claude: { status: 'ready', publishedModels: 2, detail: 'Picker matches manifest' },
    openCode: { status: 'drift', targets: 3, detail: 'Preview before Sync' },
    hermes: {
      status: 'absent',
      installed: false,
      installCommand: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)',
      startCommand: 'hermes dashboard --no-open',
      syncInstruction: 'Install Hermes, start its dashboard, then Sync.',
      yaml: 'id: abuse-hub\nbase_url: http://127.0.0.1:20100/openai/v1',
    },
  },
};

const requests = [];
const unexpected = [];
const browserErrors = [];
let liveHits = 0;
let saveMode = 'success';

function findModel(id) {
  return state.models.find((model) => model.id === id);
}

const server = http.createServer((request, response) => {
  liveHits++;
  response.statusCode = 599;
  response.end('Playwright interception failed');
});

(async () => {
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${uiStyle}${themeScript}<style>html,body{margin:0;min-height:100%;background:var(--color-bg);color:var(--color-ink);font-family:"Geist",Arial,sans-serif}nav{padding:8px}[data-tab-content]{display:none}[data-tab-content].active{display:block}</style></head><body><nav id="main-nav">${navMarkup}</nav>${tabMarkup}<script>window.toast=(text,kind)=>window.__toasts.push({text,kind});window.showTab=(name)=>document.querySelectorAll('[data-tab-content]').forEach(panel=>panel.classList.toggle('active',panel.dataset.tabContent===name));document.querySelector('[data-tab="api-gateway"]').addEventListener('click',()=>showTab('api-gateway'));</script>${uiScript}</body></html>`;
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
      colorScheme: 'dark',
    });
    await context.addInitScript(() => {
      window.__toasts = [];
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => window.__copied.push(text) },
      });
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push(`${request.method()} ${request.url()}`);
        return route.abort('blockedbyclient');
      }
      if (url.pathname === '/' && request.method() === 'GET') {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
      }
      if (url.pathname === '/vendor/api-gateway-tab.js' && request.method() === 'GET') {
        return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: fs.readFileSync(scriptPath) });
      }
      if (url.pathname === '/vendor/api-gateway-tab.css' && request.method() === 'GET') {
        return route.fulfill({ contentType: 'text/css; charset=utf-8', body: fs.readFileSync(stylePath) });
      }
      // Вкладка спрашивает `state?provider=...`: каталог собирается только по видимым вкладкам
      // сайдбара. Сравниваем pathname, а не весь адрес, и заодно требуем фильтр - без него
      // экран снова начнёт тянуть все шлюзы.
      if (url.pathname === '/__switch/api/api-gateway' && request.method() === 'GET') {
        requests.push({ method: 'GET', name: 'state', providers: url.searchParams.getAll('provider') });
        return jsonResponse(route, 200, state);
      }
      if (url.pathname === '/__switch/api/api-gateway/model' && request.method() === 'POST') {
        const body = request.postDataJSON();
        requests.push({ method: 'POST', name: 'model', body });
        if (saveMode === 'failure') return jsonResponse(route, 500, { ok: false, error: 'fixture save failed' });
        if (saveMode === 'conflict') return jsonResponse(route, 409, { ok: false, error: 'revision_conflict', currentRevision: state.manifest.revision + 1 });
        const model = findModel(body.id);
        Object.assign(model, {
          published: body.published,
          displayName: body.displayName,
          claudeBehavesAs: body.claudeBehavesAs,
          contextTokens: body.contextTokens,
          outputTokens: body.outputTokens,
          publishedAt: body.published ? (model.publishedAt || now) : null,
        });
        state.manifest.revision++;
        return jsonResponse(route, 200, { ok: true, manifest: state.manifest });
      }
      if (url.pathname === '/__switch/api/api-gateway/opencode/preview' && request.method() === 'GET') {
        requests.push({ method: 'GET', name: 'opencode-preview' });
        return jsonResponse(route, 200, {
          ok: true,
          targets: [
            { label: 'Global <img src=x onerror=window.__xss=6>', status: 'changes', additions: 2, removals: 1, changes: 3 },
            { label: 'Project', status: 'current', additions: 0, removals: 0, changes: 0 },
          ],
        });
      }
      if (url.pathname === '/__switch/api/api-gateway/opencode/sync' && request.method() === 'POST') {
        requests.push({ method: 'POST', name: 'opencode-sync', body: request.postDataJSON() });
        return jsonResponse(route, 200, { ok: true, synced: 3, message: 'OpenCode targets synced' });
      }
      if (url.pathname === '/__switch/api/api-gateway/hermes/sync' && request.method() === 'POST') {
        requests.push({ method: 'POST', name: 'hermes-sync', body: request.postDataJSON() });
        return jsonResponse(route, 200, { ok: true, message: 'Hermes endpoint synced' });
      }
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort('blockedbyclient');
    });

    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.goto(origin + '/', { waitUntil: 'load' });
    assert.equal(await page.locator('#api-gateway-root').isVisible(), false, 'tab should start hidden');
    await page.locator('[data-tab="api-gateway"]').click();
    await page.locator('.ag-model').first().waitFor();

    // Каталог спрашивается только по видимым вкладкам: в фикстуре видна одна - api-gateway.
    assert.deepEqual(requests.find(call => call.name === 'state').providers, ['api-gateway'],
      'вкладка должна ограничить каталог видимыми провайдерами');
    assert.equal(await page.locator('#nav-count-api-gateway').innerText(), '2/5');
    assert.equal(await page.locator('.ag-model').count(), 5);
    assert.deepEqual(
      await page.locator('.ag-model').evaluateAll((rows) => rows.filter((row) => row.dataset.published === 'true').map((row) => row.dataset.modelId)),
      [healthyPublishedId, publishedMissingId],
      'published rows are not sorted by ID',
    );
    assert.equal(
      await page.locator('.ag-model').evaluateAll((rows) => {
        const published = rows.flatMap((row, index) => row.dataset.published === 'true' ? [index] : []);
        const hidden = rows.flatMap((row, index) => row.dataset.published === 'false' ? [index] : []);
        return Math.max(...published) < Math.min(...hidden);
      }),
      true,
      'a hidden candidate rendered before a published model',
    );
    assert.equal(await page.locator(`[data-model-id="${publishedMissingId}"]`).count(), 1, 'missing published row disappeared');
    assert.match(await page.locator(`[data-model-id="${publishedMissingId}"]`).innerText(), /UNHEALTHY/i);
    assert.match(await page.locator(`[data-model-id="${publishedMissingId}"]`).innerText(), /CATALOG MISSING/i);
    assert.equal(await page.locator('#api-gateway-root img, #api-gateway-root svg').count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(await page.locator('.ag-policy').innerText(), /Hidden removes picker only; exact ID remains callable; red health never reroutes; Save updates manifest\+Claude; OpenCode needs Preview\/Sync; current model never changes\./);
    for (const label of ['Label', 'behavesAs', 'Context', 'Output']) {
      assert.equal(await page.locator('.ag-model .ag-label', { hasText: label }).count(), 5, `${label} editor is missing`);
    }
    assert.equal(await page.locator('.ag-model [data-field="published"]').count(), 5, 'publish toggles are missing');
    const badgeText = (await page.locator(`[data-model-id="${publishedMissingId}"] .ag-badges`).innerText()).toUpperCase();
    for (const fact of ['CATALOG MISSING', 'PASSIVE UNKNOWN', 'PROBE FAILED', 'UNHEALTHY']) assert.match(badgeText, new RegExp(fact));

    await page.locator('[data-copy="anthropic"]').click();
    await page.locator('[data-copy="openai"]').click();
    assert.deepEqual(await page.evaluate(() => window.__copied), [
      'http://127.0.0.1:20100',
      'http://127.0.0.1:20100/openai/v1',
    ]);

    const sidecarText = await page.locator('[data-ag-sidecar]').innerText();
    assert.match(sidecarText, /v2\.5\.0/);
    assert.match(sidecarText, /2736fff/);
    assert.match(sidecarText, /checksum verified/i);
    assert.match(sidecarText, /healthy/i);
    assert.match(sidecarText, /Use the hub sidecar restart action/);

    await page.locator('#ag-search').fill('Needle');
    assert.equal(await page.locator('.ag-model:visible').count(), 1);
    assert.equal(await page.locator('.ag-provider-group:visible').count(), 1);
    await page.locator('#ag-search').fill('');
    await page.locator('#ag-filter').selectOption('unhealthy');
    assert.equal(await page.locator('.ag-model:visible').count(), 1);
    assert.equal(await page.locator('.ag-model:visible').getAttribute('data-model-id'), publishedMissingId);
    await page.locator('#ag-filter').selectOption('all');

    let row = page.locator(`[data-model-id="${nestedCandidateId}"]`);
    await row.locator('[data-field="published"]').check();
    await row.locator('[data-field="displayName"]').fill('Gemini / Claude Opus');
    await row.locator('[data-field="claudeBehavesAs"]').fill('claude-opus-5');
    await row.locator('[data-field="contextTokens"]').fill('256000');
    await row.locator('[data-field="outputTokens"]').fill('24000');
    await row.locator('.ag-save').click();
    await page.waitForFunction((id) => document.querySelector(`[data-model-id="${CSS.escape(id)}"]`)?.dataset.published === 'true', nestedCandidateId);
    const saved = requests.filter((request) => request.name === 'model').at(-1).body;
    assert.deepEqual(saved, {
      expectedRevision: 7,
      id: nestedCandidateId,
      published: true,
      displayName: 'Gemini / Claude Opus',
      claudeBehavesAs: 'claude-opus-5',
      contextTokens: 256000,
      outputTokens: 24000,
    });
    assert.equal(await page.locator('#nav-count-api-gateway').innerText(), '3/5');
    assert.deepEqual(
      await page.locator('.ag-model').evaluateAll((rows) => rows.slice(0, 3).map((item) => item.dataset.modelId)),
      [healthyPublishedId, publishedMissingId, nestedCandidateId],
      'newly published row did not move ahead of hidden candidates',
    );

    saveMode = 'failure';
    row = page.locator(`[data-model-id="${nestedCandidateId}"]`);
    await row.locator('[data-field="displayName"]').fill('Unsaved failure draft');
    await row.locator('.ag-save').click();
    await row.locator('.ag-row-message').filter({ hasText: 'fixture save failed' }).waitFor();
    assert.equal(await row.locator('[data-field="displayName"]').inputValue(), 'Unsaved failure draft');
    assert.equal(await row.locator('.ag-save').isDisabled(), false);

    saveMode = 'conflict';
    await row.locator('[data-field="displayName"]').fill('Conflict draft');
    await row.locator('.ag-save').click();
    await row.locator('.ag-row-message').filter({ hasText: 'Revision conflict' }).waitFor();
    assert.equal(await row.locator('[data-field="displayName"]').inputValue(), 'Conflict draft');
    saveMode = 'success';

    const claude = page.locator('[data-client="claude"]');
    assert.match(await claude.innerText(), /Claude Code/);
    assert.match(await claude.innerText(), /Picker matches manifest/);
    const openCode = page.locator('[data-client="opencode"]');
    assert.match(await openCode.innerText(), /OpenCode/);
    assert.match(await openCode.innerText(), /Preview before Sync/);
    await openCode.locator('[data-action="preview"]').click();
    await page.locator('#ag-opencode-preview').filter({ hasText: 'Global' }).waitFor();
    assert.match(await page.locator('#ag-opencode-preview').innerText(), /add 2.*remove 1.*change 3/i);
    assert.equal(await page.locator('#ag-opencode-preview img, #ag-opencode-preview svg').count(), 0);
    await page.locator('[data-client="opencode"] [data-action="sync"]').click();
    await page.locator('[data-client="opencode"] .ag-client-message').filter({ hasText: 'OpenCode targets synced' }).waitFor();
    assert.equal(requests.filter((request) => request.name === 'opencode-sync').length, 1);

    const hermes = page.locator('[data-client="hermes"]');
    assert.match(await hermes.innerText(), /iex \(irm https:\/\/hermes-agent\.nousresearch\.com\/install\.ps1\)/);
    assert.match(await hermes.innerText(), /hermes dashboard --no-open/);
    assert.match(await hermes.innerText(), /Install Hermes, start its dashboard, then Sync\./);
    assert.equal(await hermes.locator('[data-action="sync"]').isDisabled(), true);
    state.clients.hermes = {
      status: 'blocked',
      installed: true,
      backendRunning: null,
      detail: 'No published API Gateway model is available for Hermes.',
    };
    await page.evaluate(() => window.API_GATEWAY.load());
    assert.equal(await page.locator('[data-client="hermes"] [data-action="sync"]').isDisabled(), true,
      'blocked Hermes DTO must not expose Sync');
    state.clients.hermes = {
      status: 'running',
      installed: true,
      backendRunning: true,
      detail: 'Dashboard API reachable',
      syncInstruction: 'Sync the abuse-hub endpoint without changing the current model.',
    };
    await page.evaluate(() => window.API_GATEWAY.load());
    await page.locator('[data-client="hermes"] [data-action="sync"]').click();
    await page.locator('[data-client="hermes"] .ag-client-message').filter({ hasText: 'Hermes endpoint synced' }).waitFor();
    assert.equal(requests.filter((request) => request.name === 'hermes-sync').length, 1);

    for (const themeId of ['zen', 'daylight']) {
      await page.evaluate((id) => applyTheme(id, false), themeId);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const layout = await page.evaluate(() => {
          const root = document.getElementById('api-gateway-root');
          const models = [...document.querySelectorAll('.ag-model')].map((element) => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, overflow: element.scrollWidth - element.clientWidth };
          });
          return {
            overflow: document.documentElement.scrollWidth - innerWidth,
            root: root.getBoundingClientRect().toJSON(),
            models,
            scheme: document.documentElement.style.colorScheme,
            surface: getComputedStyle(document.querySelector('.ag-surface')).backgroundColor,
          };
        });
        assert.ok(layout.overflow <= 1, `${themeId}/${width}: page overflow ${layout.overflow}`);
        assert.ok(layout.root.left >= -1 && layout.root.right <= width + 1, `${themeId}/${width}: root overflow`);
        assert.ok(layout.models.every((model) => model.left >= -1 && model.right <= width + 1 && model.overflow <= 1), `${themeId}/${width}: model overflow`);
        assert.equal(layout.scheme, themeId === 'daylight' ? 'light' : 'dark');
        assert.notEqual(layout.surface, 'rgba(0, 0, 0, 0)');
        await page.screenshot({ path: path.join(artifacts, `${themeId}-${width}.png`), fullPage: true });
      }
    }

    await page.setViewportSize({ width: 1440, height: 1000 });
    state.canWrite = false;
    await page.evaluate(() => window.API_GATEWAY.load());
    await page.locator('.ag-readonly').waitFor();
    assert.equal(await page.locator('.ag-save:not([disabled])').count(), 0);
    assert.equal(await page.locator('.ag-model [data-field]:not([disabled])').count(), 0);
    assert.equal(await page.locator('[data-client="opencode"] [data-action="sync"]').isDisabled(), true);
    assert.equal(await page.locator('[data-client="hermes"] [data-action="sync"]').isDisabled(), true);
    const writesBefore = requests.filter((request) => request.method === 'POST').length;
    await page.locator('[data-client="opencode"] [data-action="preview"]').click();
    await page.locator('#ag-opencode-preview').filter({ hasText: 'Project' }).waitFor();
    assert.equal(requests.filter((request) => request.method === 'POST').length, writesBefore);

    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.deepEqual(unexpected, [], 'unexpected browser requests were blocked');
    assert.deepEqual(browserErrors, [], 'browser page errors');
    assert.equal(liveHits, 0, 'a browser request reached the fixture server');
    console.log(`check-api-gateway-ui-browser: PASS (${requests.length} intercepted API calls)`);
    console.log('All browser requests intercepted; zero live dashboard, client, or provider calls.');
    console.log('Screenshots: ' + artifacts);
  } finally {
    if (context) await context.close();
    await browser.close();
    await closeServer(server);
  }
})().catch(async (error) => {
  console.error(error.stack);
  console.error('Screenshots: ' + artifacts);
  try { await closeServer(server); } catch {}
  process.exitCode = 1;
});
