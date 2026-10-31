'use strict';
// Actual dashboard HTML, served entirely from local fixtures. No live account requests.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const ORIGIN = 'http://premier-dashboard.test';
const URL = ORIGIN + '/__switch';
const modelMap = { opus: 'qwen3.8-max-0902', sonnet: 'qwen3.8-max-0902', haiku: 'glm-5.3-flash' };
const key = n => 'prm_' + n.repeat(43);
const quota = (id, used) => ({ unit: 'messages', accountId: id, used, limit: 50, remaining: Math.max(0, 50 - used), checkedAt: new Date().toISOString(), resetAt: new Date(Date.now() + 3600000).toISOString() });
let rows = [
    { id: 'pm_demo1', email: 'ready', api_key: key('a'), status: 'live', created: '2026-10-23T00:00:00Z', quota: quota('1', 13) },
    { id: 'pm_demo2', email: 'empty', api_key: key('b'), status: 'live', created: '2026-10-23T00:01:00Z', quota: quota('2', 50) },
    { id: 'pm_demo3', email: 'unknown', api_key: key('c'), status: 'live', created: '2026-10-23T00:02:00Z' },
];
(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [], calls = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(() => {
            localStorage.setItem('opencode_active_tab', 'premier');
            localStorage.setItem('dashboard-auto-refresh-enabled', '0');
        });
        await page.route('**/*', async route => {
            const url = new global.URL(route.request().url());
            calls.push(route.request().method() + ' ' + url.pathname);
            const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
            if (url.origin !== ORIGIN) return route.abort();
            if (url.pathname === '/__switch') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'routing/proxy-dashboard.html'), 'utf8') });
            if (url.pathname.startsWith('/vendor/')) {
                const file = path.join(ROOT, 'routing', url.pathname.slice(1));
                if (fs.existsSync(file) && fs.statSync(file).isFile()) {
                    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
                    return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
                }
            }
            if (url.pathname === '/__switch/api/pm/sessions') return send({ sessions: rows });
            if (url.pathname === '/__switch/api/pm/models') return send({ ok: true, models: Object.values(modelMap).map(id => ({ id })) });
            if (url.pathname === '/__switch/api/pm/modelmap') return send({ ok: true, modelMap });
            if (url.pathname === '/__switch/api/pm/active-model') return send({ ok: true, model: 'qwen3.8-max-0902' });
            if (url.pathname === '/__switch/api/pm/session/open') return send({ ok: true, mode: 'console' });
            // Реф-блок: код известен только у демо-аккаунта 1, остальные — «впиши код».
            if (url.pathname === '/__switch/api/pm/ref') {
                // Фронт шлёт ключ по форме id аккаунта: `id_…` не бывает, реальные — `pm_…` / `ar_…`.
                const body = JSON.parse(route.request().postData() || '{}');
                const id = body.id || Object.values(body)[0] || '';
                const set = typeof body.set === 'string' ? body.set.trim() : null;
                const row = rows.find(r => r.id === id);
                // Запись пула: вписанный руками код лежит в `refCode`, а `ref` — код, под
                // которым регистрируется сам аккаунт. Держим оба поля, чтобы тест ловил
                // подмену одного другим.
                if (set !== null && row) { if (set) row.refCode = set; else delete row.refCode; }
                const own = row && row.refCode ? row.refCode : null;
                if (id === 'pm_demo1') return send({ ok: true, id, ref: own, code: '123260146087', link: 'https://ide.kgpix.bond/r/123260146087', source: own ? 'own' : 'account', referral: { on: true, active: 1, pending: 0, next: { n: 3, need: 2 } } });
                // Демо-2: кода нет, пока его не впишут руками.
                if (!own) return send({ ok: true, id, ref: null, code: null, link: null, source: 'none', referral: null });
                return send({ ok: true, id, ref: own, code: own, link: 'https://ide.kgpix.bond/r/' + own, source: 'own', referral: null });
            }
            if (url.pathname === '/__switch/api/status') return send({ current: 'agentrouter', backends: {}, oauth: { loggedIn: false } });
            if (url.pathname.endsWith('/accounts')) return send({ accounts: [] });
            if (url.pathname.endsWith('/sessions')) return send({ sessions: [] });
            if (url.pathname.includes('/keepalive/')) return send({ ok: true, running: false, available: false });
            if (url.pathname.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: '' });
            return send({ ok: true });
        });
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof renderPm === 'function');
        await page.evaluate(() => showTab('premier'));
        await page.locator('#pm-list tr[data-acct-id="pm_demo1"]').waitFor();
        const panel = page.locator('[data-tab-content="premier"]');
        assert.equal(await panel.isVisible(), true);
        assert.match(await panel.innerText(), /37 \/ 50 сообщений/);
        assert.match(await panel.innerText(), /0 \/ 50 сообщений/);
        assert.match(await panel.innerText(), /остаток неизвестен/);
        assert.doesNotMatch(await panel.innerText(), /\$|opus-only|по рефке|только Opus/);
        assert.equal(await page.locator('#pm-list [role="meter"]').count(), 2);
        await page.selectOption('#pm-sort', 'bal-asc');
        assert.equal(await page.locator('#pm-list tr[data-acct-id]').first().getAttribute('data-acct-id'), 'pm_demo2');
        await page.locator('#pm-list tr[data-acct-id="pm_demo1"] button[title^="Открыть Premier"]').click();
        assert.ok(calls.includes('POST /__switch/api/pm/session/open'));
        await page.locator('button[onclick="pmShowAdd()"]').click();
        assert.equal(await page.locator('#pm-add-form button[onclick="newapiAddPickGithub(\'pm\')"]').isVisible(), true);
        await page.locator('button[onclick="pmShowAdd(false)"]').click();
        // Реф-код: селект аккаунтов, ссылка для выбранного, ручной ввод кода и
        // перенос ссылки в форму «Добавить».
        await page.selectOption('#pm-ref-owner', 'pm_demo1');
        await page.waitForFunction(() => document.querySelector('#pm-ref-link').value.includes('/r/'));
        assert.match(await page.locator('#pm-ref-link').inputValue(), /^https:\/\/ide\.kgpix\.bond\/r\/[A-Za-z0-9_-]+$/);
        assert.match(await page.locator('#pm-ref-stats').innerText(), /активных 1/);
        assert.match(await page.locator('#pm-ref-note').innerText(), /код этого аккаунта/);
        await page.selectOption('#pm-ref-owner', 'pm_demo2');
        await page.waitForFunction(() => document.querySelector('#pm-ref-stats').innerText === 'счётчик неизвестен');
        assert.equal(await page.locator('#pm-ref-link').inputValue(), '');
        assert.equal(await page.locator('#pm-ref-code').inputValue(), '');
        assert.match(await page.locator('#pm-ref-note').innerText(), /впиши его в поле выше|открой окно/);
        // Ручной ввод: код без открытого окна аккаунта — главный сценарий.
        await page.fill('#pm-ref-code', '569d56342c5e');
        await page.locator('button[onclick="pmRefSave()"]').click();
        await page.waitForFunction(() => document.querySelector('#pm-ref-link').value.includes('569d56342c5e'));
        assert.equal(await page.locator('#pm-ref-link').inputValue(), 'https://ide.kgpix.bond/r/569d56342c5e');
        assert.match(await page.locator('#pm-ref-note').innerText(), /код вписан руками/);
        await page.locator('button[onclick="pmRefToAdd()"]').click();
        assert.equal(await page.locator('#pm-add-form').isVisible(), true);
        assert.equal(await page.locator('#pm-add-ref').inputValue(), 'https://ide.kgpix.bond/r/569d56342c5e');
        await page.locator('button[onclick="pmShowAdd(false)"]').click();
        // Снятие своего кода: аккаунт возвращается к коду из кэша окна.
        await page.fill('#pm-ref-code', '');
        await page.locator('button[onclick="pmRefSave()"]').click();
        await page.waitForFunction(() => !document.querySelector('#pm-ref-link').value.includes('569d56342c5e'));
        assert.equal(await page.locator('#pm-ref-link').inputValue(), '');
        await page.selectOption('#pm-ref-owner', 'pm_demo1');
        await page.waitForFunction(() => document.querySelector('#pm-ref-link').value.includes('/r/'));
        await page.locator('button[onclick="pmRefToAdd()"]').click();
        assert.equal(await page.locator('#pm-add-form').isVisible(), true);
        assert.equal(await page.locator('#pm-add-ref').inputValue(), 'https://ide.kgpix.bond/r/123260146087');
        await page.locator('button[onclick="pmShowAdd(false)"]').click();
        for (const tab of ['kktoken', 'vani', 'premier']) {
            await page.evaluate(name => showTab(name), tab);
            assert.equal(await page.locator(`[data-tab-content="${tab}"]`).isVisible(), true);
        }
        await page.locator('#pm-list').scrollIntoViewIfNeeded();
        const screenshot = path.join(os.tmpdir(), 'premier-dashboard-desktop.png');
        await page.screenshot({ path: screenshot, fullPage: false });
        console.log('Screenshot: ' + screenshot);
        await page.setViewportSize({ width: 640, height: 950 });
        await page.locator('#pm-list').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(os.tmpdir(), 'premier-dashboard-narrow.png') });
        rows = [{ ...rows[2] }];
        await page.evaluate(() => loadPmSessions(false));
        assert.equal(await page.locator('#pm-energy .energy-fill').count(), 0);
        assert.match(await page.locator('#pm-energy').innerText(), /Остаток неизвестен/);
        console.log('Page errors: ' + JSON.stringify(errors));
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('Premier real HTML: quota states, sort, browser action and GitHub entry pass');
    } finally { await browser.close(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
