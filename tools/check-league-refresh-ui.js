#!/usr/bin/env node
'use strict';
// Actual dashboard and local assets, isolated API responses and a controlled browser clock.
// No request reaches the live hub, a provider or the receiver; no chat message is sent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const routing = path.join(__dirname, '..', 'routing');
const html = fs.readFileSync(process.env.LEAGUE_DASH || path.join(routing, 'proxy-dashboard.html'), 'utf8');
const origin = 'http://league-refresh-fixture.invalid';
const out = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'league-refresh-'));
const base = Date.parse('2026-11-24T12:00:00.000Z');
const gid = 'a'.repeat(32), installId = '1'.repeat(16), memberId = '2'.repeat(16);
const groups = [{ gid, title: 'Тестовая группа', members: 2 }];
const observations = [], errors = [], blocked = [], mutations = [];
let passed = 0, failed = 0;

function slice(seq, activity) {
    const stamp = new Date(base + seq * 1000).toISOString();
    const cc = (tokens, streak) => ({
        v: 1, available: true, complete: true, lifetime: tokens,
        totals: { h24: tokens, d7: tokens, d30: tokens },
        days: { keys: ['2026-11-23', '2026-11-24'], values: [tokens / 2, tokens / 2] },
        hours: { keys: ['2026-11-24T12'], values: [tokens] }, activity: { streakCurrent: streak },
    });
    const mine = cc(seq * 1_000_000, 119);
    if (activity === 'unavailable') { mine.available = false; mine.activity = null; mine.reason = 'no-snapshot'; }
    else if (activity === 'zero') mine.activity.streakCurrent = 0;
    return {
        me: { installId, nick: 'refresh-fixture', stamp, tot: { streak: 2, tokW: seq * 1_000_000 }, ccStats: mine },
        peers: [{ rid: '3'.repeat(16), nick: 'fixture-peer', recvAt: stamp, tot: { streak: 7 }, ccStats: cc(500_000, 7) }],
        groups, receiver: { configured: true, last: { ok: true, at: stamp } }, chart: { top: 5, self: true },
    };
}

async function until(fn, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await fn()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Timed out: ' + label);
}

async function openScene(browser, width, initial = 'warm') {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const data = { seq: 1, activity: initial, reads: 0, active: 0, peak: 0, hold: null, status: 200 };
    await context.addInitScript(() => localStorage.setItem('opencode_active_tab', 'claude'));
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== origin) { blocked.push(url.origin); return route.abort('blockedbyclient'); }
        if (!['GET', 'HEAD'].includes(req.method())) {
            mutations.push({ width, method: req.method(), path: url.pathname });
            return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
        }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        if (url.pathname.startsWith('/vendor/')) {
            const file = path.resolve(routing, 'vendor', url.pathname.slice('/vendor/'.length));
            if (file.startsWith(path.resolve(routing, 'vendor') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                const ext = path.extname(file);
                return route.fulfill({ contentType: ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'font/woff2', body: fs.readFileSync(file) });
            }
        }
        let body = { ok: false }, status = 404;
        if (url.pathname === '/__switch/api/league') {
            data.reads++; data.active++; data.peak = Math.max(data.peak, data.active);
            const reply = slice(data.seq, data.activity), replyStatus = data.status;
            try {
                if (data.hold) await data.hold.promise;
                await route.fulfill({ status: replyStatus, contentType: 'application/json', body: JSON.stringify(replyStatus === 200 ? reply : { error: 'fixture unavailable' }) });
            } finally { data.active--; }
            return;
        }
        if (url.pathname === '/__switch/api/league/me') {
            body = { ok: true, memberId, installId, nick: 'refresh-fixture', role: 'member', canUpload: false, groups }; status = 200;
        } else if (url.pathname === '/__switch/api/league/group/' + gid) {
            body = { ok: true, gid, title: groups[0].title, members: [{ installId, memberId, rid: '4'.repeat(16), nick: 'refresh-fixture', status: 'active' }] }; status = 200;
        } else if (url.pathname === '/__switch/api/league/chat') {
            body = { groups: { [gid]: { seq: 0, gseq: 0, firstSeq: 1, messages: [] } }, unknown: [] }; status = 200;
        } else if (url.pathname === '/__switch/api/league/gateways') { body = { ok: true, items: [] }; status = 200; }
        else if (url.pathname === '/__switch/api/models/health') { body = { ok: true, pairs: [] }; status = 200; }
        return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push({ width, error: e.message }));
    await page.clock.install({ time: new Date(base) });
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.clock.pauseAt(new Date(base + 10000));
    await until(() => page.evaluate(() => !!LG.data && !LG.loading), 'background League slice');
    return { context, page, data };
}

const cases = {
    async 'nickname-draft'(scene, width) {
        const { page, data } = scene;
        await page.locator('.nav-btn[data-tab="league"]').click({ force: true });
        await until(() => page.evaluate(() => !LG.loading), 'open League');
        await page.locator('#lg-nickbtn').click({ force: true });
        await page.locator('#lg-nickinp').fill('draft-nickname');
        data.seq = 3;
        await page.clock.fastForward(30000);
        await until(() => page.evaluate(() => !LG.loading), 'refresh while editing nickname');
        assert.equal(await page.locator('#lg-nickinp').count(), 1, 'automatic refresh must not destroy the nickname editor');
        assert.equal(await page.locator('#lg-nickinp').inputValue(), 'draft-nickname');
        assert.equal(await page.evaluate(() => document.activeElement === document.getElementById('lg-nickinp')), true);
        assert.match(await page.locator('#league-mini-val').innerText(), /3\s*M/, 'sidebar remains fresh while editing');
        await page.locator('#lg-nickinp').press('Escape');
        assert.equal(await page.locator('#lg-nickinp').count(), 0, 'cancel still works without submitting');
        assert.match(await page.locator('#lg-list .lgrow.me .lgv.on').innerText(), /3\s*M/);
        observations.push({ width, case: 'nickname-draft', reads: data.reads, draftPreserved: true });
    },
    async 'single-flight-draft'(scene, width) {
        const { page, data } = scene;
        await page.locator('.nav-btn[data-tab="league"]').click({ force: true });
        await until(() => page.evaluate(() => !LG.loading), 'open League');
        await page.locator('#lg-inp').fill('Черновик с вложением');
        await page.evaluate(() => {
            window.__draftNode = document.getElementById('lg-inp');
            LGC.att = { kind: 'file', name: 'fixture.txt', mime: 'text/plain', bytes: 4, b64: 'dGVzdA==' };
            window.__draftAtt = LGC.att;
            document.getElementById('lg-inp').focus();
        });
        const before = data.reads;
        let release;
        data.seq = 4;
        data.hold = { promise: new Promise(resolve => { release = resolve; }) };
        try {
            await page.evaluate(() => { lgLoad(true); lgLoad(true); showTab('league'); });
            await until(() => data.active === 1, 'single held fetch');
            await page.clock.fastForward(10000);
            assert.equal(data.reads, before + 1, 'clicks and refresh calls join one in-flight fetch');
            assert.equal(data.peak, 1);
        } finally { release(); data.hold = null; }
        await until(() => page.evaluate(() => !LG.loading && LG.data.me.ccStats.totals.d7 === 4_000_000), 'held refresh settled');
        assert.equal(await page.evaluate(() => document.getElementById('lg-inp') === window.__draftNode), true);
        assert.equal(await page.locator('#lg-inp').inputValue(), 'Черновик с вложением');
        assert.equal(await page.evaluate(() => LGC.att === window.__draftAtt), true, 'pending attachment is unchanged');
        assert.equal(await page.evaluate(() => document.activeElement === window.__draftNode), true, 'typing focus is unchanged');
        const after = data.reads;
        await page.clock.fastForward(30000);
        await until(() => page.evaluate(() => !LG.loading), 'poll after explicit fetch');
        assert.equal(data.reads, after + 1, 'repeated opening never creates duplicate polling loops');
        observations.push({ width, case: 'single-flight-draft', reads: data.reads, peak: data.peak, draft: true, attachment: true, focus: true });
    },
    async 'cold-auto-recovery'(scene, width) {
        const { page, data } = scene;
        assert.equal(await page.evaluate(() => lgStreak(LG.data.me)), null, 'cold canonical snapshot stays unknown');
        data.activity = 'warm'; data.seq = 2;
        await page.clock.fastForward(30000);
        await until(() => page.evaluate(() => !LG.loading && lgStreak(LG.data.me) === 119), 'cold startup recovers without click');
        await page.locator('.nav-btn[data-tab="league"]').click({ force: true });
        await until(() => page.evaluate(() => !LG.loading), 'open recovered cold slice');
        assert.match(await page.locator('#lg-list .lgrow.me .lgv:last-child').innerText(), /119/);
        observations.push({ width, case: 'cold-auto-recovery', reads: data.reads, streak: 119 });
    },
    async 'canonical-zero'(scene, width) {
        const { page, data } = scene;
        data.activity = 'zero';
        await page.locator('.nav-btn[data-tab="league"]').click({ force: true });
        await until(() => page.evaluate(() => !LG.loading), 'canonical zero settled');
        assert.equal(await page.evaluate(() => lgStreak(LG.data.me)), 0);
        assert.equal((await page.locator('#lg-list .lgrow.me .lgv:last-child').innerText()).replace(/\s+/g, ''), '🔥0',
            'a measured zero must be visible as zero, not legacy2 or an unknown dash');
        data.activity = 'unavailable';
        await page.evaluate(() => { lgLoad(true); });
        await until(() => page.evaluate(() => !LG.loading), 'unavailable canonical settled');
        assert.equal(await page.evaluate(() => lgStreak(LG.data.me)), null);
        assert.doesNotMatch(await page.locator('#lg-list .lgrow.me .lgv:last-child').innerText(), /2/);
        data.activity = 'warm';
        await page.clock.fastForward(30000);
        await until(() => page.evaluate(() => !LG.loading && lgStreak(LG.data.me) === 119), 'canonical warm recovery');
        assert.match(await page.locator('#lg-list .lgrow.me .lgv:last-child').innerText(), /119/);
        observations.push({ width, case: 'canonical-zero', zeroVisible: true, recoveredStreak: 119, reads: data.reads });
    },
    async 'request-timeout'(scene, width) {
        const { page, data } = scene;
        let release;
        data.hold = { promise: new Promise(resolve => { release = resolve; }) };
        const before = data.reads;
        try {
            await page.evaluate(() => { lgLoad(true); });
            await until(() => data.active === 1, 'held request started');
            await page.clock.fastForward(20001);
            assert.equal(await page.evaluate(() => LG.loading), false, 'a stalled response must release the loading lock after20seconds');
            assert.equal(await page.evaluate(() => LG.data.me.ccStats.activity.streakCurrent), 119);
            assert.equal(data.reads, before + 1, 'timeout must not start a parallel retry');
        } finally { release(); data.hold = null; }
        await until(() => data.active === 0, 'timed out request released');
        data.seq = 3;
        await page.clock.fastForward(30000);
        await until(() => page.evaluate(() => !LG.loading && LG.data.me.ccStats.totals.d7 === 3_000_000), 'retry after timeout');
        observations.push({ width, case: 'request-timeout', reads: data.reads, peak: data.peak, recovered: true });
    },
    async 'hidden-resume'(scene, width) {
        const { page, data } = scene;
        const before = data.reads;
        await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        data.seq = 2;
        await page.clock.fastForward(90000);
        assert.equal(data.reads, before, 'no rating requests while the document is hidden');
        await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, value: false });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await until(() => page.evaluate(() => !LG.loading), 'visible resume settled');
        assert.equal(data.reads, before + 1, 'returning to the document must refresh immediately');
        assert.equal(await page.evaluate(() => LG.data.me.ccStats.totals.d7), 2_000_000);
        observations.push({ width, case: 'hidden-resume', reads: data.reads, peak: data.peak, tokens: 2_000_000 });
    },
    async 'last-good-draft'(scene, width) {
        const { page, data } = scene;
        await page.locator('.nav-btn[data-tab="league"]').click({ force: true });
        await until(() => page.evaluate(() => !LG.loading), 'open League');
        await page.locator('#lg-inp').fill('Черновик не должен исчезнуть');
        await page.evaluate(() => { window.__keptComposer = document.getElementById('lg-inp'); window.__keptFeed = document.getElementById('lg-feed'); });
        const before = data.reads;
        data.status = 503;
        await page.clock.fastForward(30000);
        await until(() => page.evaluate(() => !LG.loading), 'failed refresh settled');
        assert.equal(data.reads, before + 1);
        assert.equal(await page.evaluate(() => document.getElementById('lg-inp') === window.__keptComposer), true,
            'a temporary polling error must not destroy the composer or its draft');
        assert.equal(await page.locator('#lg-inp').inputValue(), 'Черновик не должен исчезнуть');
        assert.equal(await page.evaluate(() => document.getElementById('lg-feed') === window.__keptFeed), true);
        assert.equal(await page.evaluate(() => LG.data.me.ccStats.activity.streakCurrent), 119);
        assert.match(await page.locator('#lg-stamp').innerText(), /обновление не удалось/i, 'the kept snapshot must be labeled');
        data.status = 200; data.seq = 3;
        await page.clock.fastForward(30000);
        await until(() => page.evaluate(() => !LG.loading && LG.data.me.ccStats.totals.d7 === 3_000_000), 'poll recovery');
        assert.equal(await page.evaluate(() => document.getElementById('lg-inp') === window.__keptComposer), true);
        assert.equal(await page.locator('#lg-inp').inputValue(), 'Черновик не должен исчезнуть');
        assert.doesNotMatch(await page.locator('#lg-stamp').innerText(), /обновление не удалось/i);
        await page.screenshot({ path: path.join(out, 'last-good-draft-' + width + '.png'), fullPage: true });
        observations.push({ width, case: 'last-good-draft', reads: data.reads, peak: data.peak, draftPreserved: true });
    },
    async 'automatic-sidebar'(scene, width) {
        const { page, data } = scene;
        const before = data.reads;
        assert.equal(await page.evaluate(() => document.querySelector('[data-tab-content="league"]').classList.contains('active')), false);
        data.seq = 2;
        await page.clock.fastForward(30000);
        await until(() => page.evaluate(() => !LG.loading), 'automatic sidebar refresh settled');
        assert.equal(data.reads, before + 1, 'the sidebar must fetch without opening League or clicking its mini-block');
        assert.equal(await page.evaluate(() => LG.data.me.ccStats.totals.d7), 2_000_000);
        assert.match(await page.locator('#league-mini-val').innerText(), /2\s*M/);
        assert.equal(await page.evaluate(() => state.loaded.league === true), false, 'polling does not navigate');
        assert.equal(data.peak, 1, 'only one League request at a time');
        await page.screenshot({ path: path.join(out, 'automatic-sidebar-' + width + '.png'), fullPage: true });
        observations.push({ width, case: 'automatic-sidebar', reads: data.reads, peak: data.peak, tokens: 2_000_000 });
    },
    async 'first-open'(scene, width) {
        const { page, data } = scene;
        assert.equal(await page.evaluate(() => state.loaded.league === true), false, 'background load does not imply navigation');
        const before = data.reads;
        data.seq = 2;
        await page.locator('.nav-btn[data-tab="league"]').click({ force: true });
        await until(() => page.evaluate(() => !LG.loading), 'first opening settled');
        assert.equal(data.reads, before + 1, 'the first navigation must fetch a fresh slice, not only render the startup cache');
        assert.equal(await page.evaluate(() => LG.data.me.ccStats.totals.d7), 2_000_000);
        assert.match(await page.locator('#league-mini-val').innerText(), /2\s*M/);
        assert.match(await page.locator('#lg-list .lgrow.me .lgv:last-child').innerText(), /119/);
        await page.locator('#lg-list').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, 'first-open-' + width + '.png'), fullPage: true });
        observations.push({ width, case: 'first-open', reads: data.reads, peak: data.peak, tokens: 2_000_000, streak: 119 });
    },
};

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const selected = process.env.LEAGUE_CASE ? [process.env.LEAGUE_CASE] : Object.keys(cases);
        for (const name of selected) {
            assert.ok(cases[name], 'unknown case: ' + name);
            for (const width of [1440, 390]) {
                let scene;
                try {
                    scene = await openScene(browser, width, name === 'cold-auto-recovery' ? 'unavailable' : 'warm');
                    await cases[name](scene, width);
                    assert.equal(errors.filter(e => e.width === width).length, 0, 'browser errors');
                    assert.equal(mutations.length, 0, 'the whole flow must remain read-only');
                    passed++; console.log('PASS ' + name + ', width=' + width);
                } catch (e) {
                    failed++; console.error('FAIL ' + name + ', width=' + width + '\n' + e.message);
                } finally { if (scene) await scene.context.close(); }
            }
        }
    } finally {
        await browser.close();
        fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ passed, failed, observations, errors, blocked, mutations,
            sourceSha256: crypto.createHash('sha256').update(html).digest('hex'), scope: 'actual isolated dashboard, desktop/mobile, browser clock; no live network' }, null, 2) + '\n');
    }
    console.log('check-league-refresh-ui: ' + passed + ' passed, ' + failed + ' failed');
    console.log('evidence: ' + out);
    process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
