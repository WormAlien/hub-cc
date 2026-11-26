'use strict';
// Real Chromium acceptance of exact dashboard Claim code against a loopback-only fake API.
// Does not import the proxy/backend, read accounts/profiles, or call any provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'routing/proxy-dashboard.html'), 'utf8');
const start = source.indexOf('let xcCheckinState = ');
const end = source.indexOf('async function loadXcSessions(', start);
assert.ok(start > 0 && end > start, 'exact Claim function region exists');
const code = source.slice(start, end);
const theme = source.match(/<style type="text\/tailwindcss">[\s\S]*?<\/style>/)[0];
const escCode = source.match(/const esc = \(s\)[^\n]+/)[0];
const keyCode = source.match(/function isRealKey\(k\)[^\n]+/)[0];
const boxes = ['xc-checkin', 'xc-checkin-journal'].map(id => {
  const match = source.match(new RegExp('<div id="' + id + '"[^>]*></div>'));
  assert.ok(match, id + ' production container'); return match[0];
}).join('');
const accounts = [
  { id: 'fixture-a', email: 'demo-a@example.test', api_key: 'sk-fixture-a' },
  { id: 'fixture-b', email: 'demo-b@example.test', api_key: 'sk-fixture-b' },
  { id: 'fixture-c', email: 'demo-c@example.test', api_key: 'sk-fixture-c' },
  { id: 'fixture-invalid', email: 'invalid@example.test', api_key: 'placeholder' },
];
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/vendor/tailwindcss-browser-4.js"></script><link rel="stylesheet" href="/vendor/fonts.css">${theme}</head><body class="bg-bg text-ink font-sans"><main class="px-6 py-8 space-y-4">${boxes}<div id="toast" role="status"></div></main><script>const $=id=>document.getElementById(id);${escCode}\n${keyCode}\nconst state={xingchi:${JSON.stringify(accounts)}};window.fixtureToasts=[];function toast(text,type){fixtureToasts.push({text,type});$('toast').textContent=text;}\n${code}\nxcCheckinLoad(false);</script></body></html>`;
const scratch = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'hermes/cache/scratch');
fs.mkdirSync(scratch, { recursive: true });
const out = process.env.XC_UI_ARTIFACT_DIR || fs.mkdtempSync(path.join(scratch, 'xingchi-checkin-ui-'));
fs.mkdirSync(out, { recursive: true });
let data, failNext, calls = [], unexpected = [];
function reset() {
  data = { config: { enabled: false, time: '09:00', timezone: 'Asia/Shanghai' }, accounts: accounts.slice(0, 3).map(a => ({ id: a.id, status: { claimed_today: false } })), runs: [], events: [], batch: { queued: 0, running: 0 } };
  failNext = null;
}
function event(text) { data.events.push({ at: '2026-11-25T01:00:00Z', text }); }
const reply = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/__switch/api/xc/')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, path: url.pathname, query: url.search, body });
    const op = url.pathname.slice('/__switch/api/xc/checkin-'.length);
    if (failNext === op) { failNext = null; return reply(res, { error: 'fixture failure <safe>' }, 503); }
    if (op === 'status' && req.method === 'GET') return reply(res, data);
    if (req.method !== 'POST') { unexpected.push(req.url); return reply(res, { error: 'method' }, 405); }
    if (op === 'claim' || op === 'all') {
      const selected = op === 'claim' ? data.accounts.filter(a => a.id === body.id) : data.accounts.filter(a => !a.status.claimed_today);
      data.runs = selected.map(a => ({ id: a.id, state: 'queued' })); data.batch = { queued: selected.length, running: 0 };
      event('queued ' + selected.length); return reply(res, { queued: selected.length });
    }
    if (op === 'cancel') { const cancelled = data.runs.length; data.runs = []; data.batch = {}; event('cancelled'); return reply(res, { cancelled }); }
    if (op === 'mark') { const a = data.accounts.find(a => a.id === body.id); assert.ok(a); a.status.claimed_today = body.on; event('manual mark'); return reply(res, { ok: true }); }
    if (op === 'config') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) return reply(res, { error: 'invalid time' }, 400);
      data.config = body; return reply(res, { ok: true });
    }
    unexpected.push(req.url); return reply(res, { error: 'unexpected' }, 404);
  }
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
  const assets = { '/vendor/tailwindcss-browser-4.js': 'application/javascript', '/vendor/fonts.css': 'text/css' };
  if (assets[url.pathname] || /^\/vendor\/fonts\/[\w.-]+\.woff2$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': assets[url.pathname] || 'font/woff2' }); return res.end(fs.readFileSync(path.join(root, 'routing', url.pathname)));
  }
  unexpected.push(req.url); return reply(res, { error: 'not found' }, 404);
});
(async () => {
  let browser;
  const results = [], blocked = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true });
    for (const [name, width, height, mobile] of [['desktop', 1440, 1000, false], ['mobile', 390, 844, true]]) {
      reset(); calls = [];
      const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin !== origin) { blocked.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage(), errors = [], screenshots = [], checks = [];
      page.on('pageerror', e => errors.push(String(e)));
      page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text()); });
      const row = id => page.locator('#xc-checkin tr').filter({ hasText: 'demo-' + id + '@example.test' });
      const button = handler => page.locator('#xc-checkin button[onclick="' + handler + '"]');
      const claim = id => row(id).getByRole('button', { name: 'Claim', exact: true });
      const refresh = async () => { const response = page.waitForResponse(r => r.url().includes('checkin-status')); await button('xcCheckinLoad(true)').click(); await response; await page.waitForFunction(() => document.querySelector('#xc-checkin table')); };
      const text = async (locator, value) => { await locator.filter({ hasText: value }).waitFor(); assert.ok((await locator.innerText()).includes(value)); };
      const shot = async label => { const p = path.join(out, name + '-' + label + '.png'); await page.screenshot({ path: p, fullPage: true }); screenshots.push(p); };
      const lastPost = () => calls.filter(c => c.method === 'POST').at(-1);
      await page.goto(origin);
      await page.locator('#xc-checkin tr').nth(2).waitFor();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#xc-checkin')).paddingTop === '16px');
      assert.equal(await page.locator('#xc-checkin tr').count(), 3);
      await text(page.locator('#xc-checkin'), 'Готовы: 3');
      assert.equal(await button('xcCheckinCancel()').isDisabled(), true);
      assert.equal(await claim('a').isEnabled(), true);
      await shot('ready'); checks.push('ready, real-key filtering, initial disabled Stop');
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, tableWidth: document.querySelector('table').scrollWidth, scrollerWidth: document.querySelector('table').parentElement.clientWidth }));
      assert.ok(layout.scrollWidth <= width, 'no page horizontal overflow: ' + JSON.stringify(layout));
      for (const selector of ['xcCheckinAll()', 'xcCheckinCancel()', 'xcCheckinSaveConfig()']) {
        const rect = await button(selector).boundingBox(); assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width, 'control within viewport');
      }
      checks.push('responsive page/control fit; table overflow constrained to native scroller');
      await claim('a').click(); await text(row('a'), 'очередь');
      assert.deepEqual(lastPost(), { method: 'POST', path: '/__switch/api/xc/checkin-claim', query: '', body: { id: 'fixture-a' } });
      assert.equal(await claim('a').isDisabled(), true); assert.equal(await button('xcCheckinAll()').isDisabled(), true);
      assert.equal(await button('xcCheckinCancel()').isEnabled(), true);
      data.runs[0].state = 'running'; data.batch = { queued: 0, running: 1 }; await refresh(); await text(row('a'), 'Claim…');
      await shot('running'); checks.push('single Claim POST, queued/running, disabled duplicate controls');
      await button('xcCheckinCancel()').click(); await page.waitForFunction(() => document.querySelector('[onclick="xcCheckinCancel()"]').disabled);
      assert.equal(lastPost().path, '/__switch/api/xc/checkin-cancel'); assert.deepEqual(lastPost().body, {});
      await button('xcCheckinAll()').click(); await page.waitForFunction(() => document.querySelector('[onclick="xcCheckinAll()"]').disabled);
      assert.equal(lastPost().path, '/__switch/api/xc/checkin-all'); assert.deepEqual(lastPost().body, {});
      assert.equal(data.runs.length, 3);
      data.runs = data.runs.map(r => ({ ...r, state: 'done' })); data.accounts.forEach(a => { a.status.claimed_today = true; }); data.batch = {};
      event('done: <img src=x onerror=alert(1)>'); await refresh(); await text(page.locator('#xc-checkin'), 'Готовы: 0');
      for (const id of ['a', 'b', 'c']) { assert.equal(await claim(id).isDisabled(), true); await text(row(id), 'Claim сегодня'); }
      assert.equal(await page.locator('#xc-checkin-journal img').count(), 0);
      await text(page.locator('#xc-checkin-journal'), '<img src=x onerror=alert(1)>');
      await shot('done'); checks.push('cancel/all POST, completed/already-claimed disablement, escaped journal');
      reset(); data.accounts[1].status.claimed_today = true; data.accounts[2].error = 'fixture provider error';
      await refresh(); await text(row('b'), 'Claim сегодня'); await text(row('c'), 'ошибка');
      assert.equal(await claim('b').isDisabled(), true); assert.equal(await claim('c').isEnabled(), true);
      await row('a').getByRole('button', { name: 'отметить' }).click(); await text(row('a'), 'Claim сегодня');
      assert.deepEqual(lastPost().body, { id: 'fixture-a', on: true }); assert.equal(lastPost().path, '/__switch/api/xc/checkin-mark');
      await page.locator('#xc-checkin-enabled').check(); await page.locator('#xc-checkin-time').fill('10:30'); await button('xcCheckinSaveConfig()').click();
      await text(page.locator('#toast'), 'расписание Claim сохранено');
      assert.deepEqual(lastPost().body, { enabled: true, time: '10:30', timezone: 'Asia/Shanghai' });
      await page.waitForFunction(() => document.querySelector('#xc-checkin-time').value === '10:30' && document.querySelector('#xc-checkin-enabled').checked);
      await shot('mixed-config'); checks.push('mixed error/already-claimed, manual mark, persisted schedule POST');
      await page.locator('#xc-checkin-time').fill('25:99'); await button('xcCheckinSaveConfig()').click(); await text(page.locator('#toast'), 'invalid time');
      assert.equal(data.config.time, '10:30');
      failNext = 'claim'; await claim('c').click(); await text(page.locator('#toast'), 'fixture failure <safe>');
      await text(row('c'), 'ошибка');
      for (const [op, selector] of [['all', 'xcCheckinAll()'], ['config', 'xcCheckinSaveConfig()']]) {
        failNext = op; await button(selector).click(); await text(page.locator('#toast'), 'fixture failure <safe>');
        assert.equal(lastPost().path, '/__switch/api/xc/checkin-' + op);
      }
      failNext = 'mark'; await row('c').getByRole('button', { name: 'отметить' }).click(); await text(page.locator('#toast'), 'fixture failure <safe>');
      await button('xcCheckinAll()').click(); await page.waitForFunction(() => !document.querySelector('[onclick="xcCheckinCancel()"]').disabled);
      failNext = 'cancel'; await button('xcCheckinCancel()').click(); await text(page.locator('#toast'), 'fixture failure <safe>');
      failNext = 'status'; await button('xcCheckinLoad(true)').click(); await text(page.locator('#xc-checkin'), 'Claim: fixture failure <safe>');
      assert.equal(await page.locator('#xc-checkin safe').count(), 0);
      await shot('status-error'); checks.push('invalid config and all six API error paths safely visible');
      await page.evaluate(() => xcCheckinLoad(false));
      await page.evaluate(() => { state.xingchi = []; xcCheckinRender(); });
      await text(page.locator('#xc-checkin'), 'Готовы: 0'); assert.equal(await button('xcCheckinAll()').isDisabled(), true);
      assert.equal(await page.locator('#xc-checkin tr').count(), 0); checks.push('empty account list');
      assert.ok(calls.some(c => c.path.endsWith('checkin-status') && c.query === '?probe=1'));
      assert.equal(/lottery|blind.?box|лотере|слеп.{0,5}короб/i.test(code), false);
      assert.deepEqual(errors, []); checks.push('probe refresh, no console/page errors, no lottery/blind-box code or requests');
      results.push({ name, viewport: { width, height }, checks, layout, screenshots, calls, errors });
      await context.close();
    }
    assert.deepEqual(blocked, []); assert.deepEqual(unexpected, []);
    const report = { status: 'PASS', scope: 'Exact extracted production Claim functions/containers with local production Tailwind/fonts; fake API only, not full dashboard or provider integration', command: 'node tools/check-xingchi-checkin-ui-browser.js', headless: true, origin, browser: browser.version(), liveProviderCalls: 0, productionRestart: false, blocked, unexpected, results };
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(report, null, 2));
    console.log('PASS Xingchi daily Claim real headless Chromium desktop/mobile isolated HTTP UI acceptance');
    console.log(JSON.stringify({ artifactDirectory: out, receipt: path.join(out, 'receipt.json'), viewports: results.map(r => r.viewport), checks: results.map(r => ({ name: r.name, count: r.checks.length })), screenshots: results.flatMap(r => r.screenshots), requests: results.map(r => ({ name: r.name, count: r.calls.length })), liveProviderCalls: 0 }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.stack, results, calls, unexpected, blocked }, null, 2));
    console.error(error); console.error('Artifacts: ' + out); process.exitCode = 1;
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})();
