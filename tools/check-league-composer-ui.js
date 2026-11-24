#!/usr/bin/env node
'use strict';
// Real dashboard, local assets and native navigation. API replies are isolated fixtures:
// no request reaches the live hub, receiver or a provider, including chat submissions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const routing = path.join(__dirname, '..', 'routing');
const html = fs.readFileSync(process.env.LEAGUE_DASH || path.join(routing, 'proxy-dashboard.html'), 'utf8');
const origin = 'http://league-composer-fixture.invalid';
const out = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'league-composer-'));
const gid = 'a'.repeat(32), installId = '1'.repeat(16), memberId = '2'.repeat(16);
const stamp = '2026-11-22T12:00:00.000Z';
const groups = [{ gid, title: 'Тестовая группа', members: 1 }];
const slice = {
    me: { installId, nick: 'browser-fixture', stamp, isMe: 1, tot: { tokW: 30, tokA: 30 },
        ccStats: { v: 1, available: true, lifetime: 30, totals: { h24: 10, d7: 30, d30: 30 },
            days: { keys: ['2026-11-21', '2026-11-22'], values: [20, 10] },
            hours: { keys: ['2026-11-22T12'], values: [10] }, activity: { streakCurrent: 2 } } },
    peers: [], groups, receiver: { configured: true, last: { ok: true, at: stamp } },
};
let passed = 0, failed = 0;
const observations = [], errors = [], blocked = [];

async function geometry(page) {
    return page.locator('#lg-inp').evaluate(inp => {
        const css = getComputedStyle(inp), box = inp.getBoundingClientRect();
        const send = document.getElementById('lg-send').getBoundingClientRect();
        return { height: box.height, width: box.width, inlineHeight: inp.style.height,
            clientHeight: inp.clientHeight, scrollHeight: inp.scrollHeight,
            lineHeight: parseFloat(css.lineHeight), padding: parseFloat(css.paddingTop) + parseFloat(css.paddingBottom),
            sendHeight: send.height, bottomDelta: Math.abs(box.bottom - send.bottom),
            left: box.left, right: box.right, compRight: document.getElementById('lg-comp').getBoundingClientRect().right,
            value: inp.value };
    });
}

async function scenario(browser, width) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const messages = [];
    let groupReads = 0;
    await context.addInitScript(() => localStorage.setItem('opencode_active_tab', 'claude'));
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== origin) { blocked.push(url.origin); return route.abort('blockedbyclient'); }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        if (url.pathname.startsWith('/vendor/')) {
            const rel = url.pathname.slice('/vendor/'.length), file = path.resolve(routing, 'vendor', rel);
            if (file.startsWith(path.resolve(routing, 'vendor') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                const ext = path.extname(file);
                return route.fulfill({ contentType: ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'font/woff2', body: fs.readFileSync(file) });
            }
        }
        let body = { ok: false }, status = 404;
        if (url.pathname === '/__switch/api/league') { body = slice; status = 200; }
        else if (url.pathname === '/__switch/api/league/me') {
            body = { ok: true, memberId, installId, nick: 'browser-fixture', role: 'member', canUpload: false, groups }; status = 200;
        } else if (url.pathname === '/__switch/api/league/group/' + gid) {
            // Resolve the member list after the background slice, as on the reported path.
            await new Promise(resolve => setTimeout(resolve, 150));
            groupReads++;
            body = { ok: true, gid, title: groups[0].title, members: [{ installId, memberId, rid: '3'.repeat(16), nick: 'browser-fixture', status: 'active' }] }; status = 200;
        } else if (url.pathname === '/__switch/api/league/chat') {
            if (req.method() === 'POST') {
                const post = req.postDataJSON();
                assert.equal(post.gid, gid);
                messages.push({ seq: messages.length + 1, installId, nick: 'browser-fixture', text: post.text, recvAt: stamp });
                body = { ok: true, seq: messages.length };
            } else body = { groups: { [gid]: { seq: messages.length, gseq: 0, firstSeq: 1, messages } }, unknown: [] };
            status = 200;
        } else if (url.pathname === '/__switch/api/league/gateways') { body = { ok: true, items: [] }; status = 200; }
        else if (url.pathname === '/__switch/api/models/health') { body = { ok: true, pairs: [] }; status = 200; }
        return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push({ width, error: e.message }));
    try {
        await page.goto(origin + '/', { waitUntil: 'load' });
        await page.waitForFunction(() => !!document.getElementById('lg-inp'), null, { timeout: 20000 });
        assert.ok(groupReads > 0, 'background group response must build the hidden League shell');
        assert.equal(await page.locator('#lg-inp').isVisible(), false);
        await page.locator('.nav-btn[data-tab="league"]').click();
        await page.locator('#lg-inp').waitFor({ state: 'visible' });
        const initial = await geometry(page);
        observations.push({ viewportWidth: width, phase: 'background-open', ...initial });
        await page.locator('#lg-comp').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, 'open-' + width + '.png'), fullPage: true });
        assert.ok(initial.height >= 46, `hidden boot collapsed the input: ${JSON.stringify(initial)}`);
        assert.ok(initial.clientHeight >= initial.lineHeight + initial.padding, 'one text line must fit without clipping');
        assert.ok(initial.bottomDelta <= 1, 'composer buttons remain bottom-aligned');
        assert.ok(initial.width > 0 && initial.right <= initial.compRight, 'input remains inside its composer');

        const input = page.locator('#lg-inp');
        await input.fill('Читаемая строка');
        const single = await geometry(page);
        assert.ok(single.height >= 46 && single.scrollHeight <= single.clientHeight + 1, 'short typed text must fit');
        const draft = 'Первая строка\nВторая строка\nТретья строка';
        await input.fill(draft);
        const multiline = await geometry(page);
        assert.ok(multiline.height > 46 && multiline.height <= 120, 'multiline draft grows up to the cap');
        await page.evaluate(() => { showTab('claude'); lgChatBoot(); });
        const hiddenHeight = await input.evaluate(inp => inp.style.height);
        assert.equal(hiddenHeight, multiline.inlineHeight, 'a hidden measurement must not overwrite the draft height');
        await page.locator('.nav-btn[data-tab="league"]').click();
        assert.equal(await input.inputValue(), draft, 'returning to League must preserve the existing draft');
        const returned = await geometry(page);
        assert.ok(returned.height > 46 && returned.bottomDelta <= 1, 'returning draft remains readable and bottom-aligned');

        await input.fill('Читаемый черновик '.repeat(12));
        await page.setViewportSize({ width: width === 1440 ? 390 : 1440, height: 900 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const resized = await geometry(page);
        assert.ok(Math.abs(resized.height - Math.max(46, Math.min(resized.scrollHeight + 2, 120))) <= 1,
            'resize must recompute wrapped draft height: ' + JSON.stringify(resized));
        await page.setViewportSize({ width, height: 900 });
        await input.fill('Проверка клавиатуры');
        await input.press('End');
        await input.press('Shift+Enter');
        await input.pressSequentially('Вторая строка');
        assert.equal(messages.length, 0, 'Shift+Enter must not submit');
        const text = await input.inputValue();
        assert.match(text, /\n/, 'Shift+Enter inserts a newline');
        await input.press('Enter');
        await page.waitForFunction(() => document.getElementById('lg-inp').value === '');
        await page.waitForFunction(text => [...document.querySelectorAll('#lg-feed .lgmt')].some(e => e.textContent === text), text);
        assert.equal(messages.length, 1, 'Enter submits exactly one fixture message');
        assert.equal(messages[0].text, text);
        const sent = await geometry(page);
        assert.ok(sent.height >= 46 && sent.height <= 120, 'cleared composer returns to readable geometry');
        observations.push({ viewportWidth: width, phase: 'whole-flow', single, multiline, returned, resized, sent });
        await page.screenshot({ path: path.join(out, 'flow-' + width + '.png'), fullPage: true });
        assert.equal(errors.filter(e => e.width === width).length, 0, 'whole composer flow must not throw browser errors');
        return { context, page, messages };
    } catch (e) {
        await context.close();
        throw e;
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const width of [1440, 390]) {
            let scene;
            try {
                scene = await scenario(browser, width);
                passed++; console.log('PASS full composer flow, width=' + width);
            } catch (e) {
                failed++; console.error('FAIL full composer flow, width=' + width + '\n' + e.message);
            } finally {
                if (scene) await scene.context.close();
            }
        }
    } finally {
        await browser.close();
        fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ passed, failed, observations, errors, blocked, scope: 'isolated real dashboard browser; no live network' }, null, 2) + '\n');
    }
    console.log('check-league-composer-ui: ' + passed + ' passed, ' + failed + ' failed');
    console.log('evidence: ' + out);
    process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
