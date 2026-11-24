#!/usr/bin/env node
'use strict';

// Whole-source Chromium acceptance for the two-column Tabs Manager. The fixture
// intercepts every request and uses new, ephemeral browser contexts only. No
// implementation handler is replaced, invoked or synthesized by these tests.
// Seed changes are test setup followed by a real reload, never fake UI commits.
// Run: node tools/check-tabs-manager-ui.js
// Optional: TABS_MANAGER_DASH, TABS_MANAGER_STAGE=red|final, TABS_MANAGER_CASES, TABS_MANAGER_MODES
// (comma-separated sortable-mouse,native-mouse,sortable-touch,native-touch).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { ROOT, ORIGIN, KEY, SENTINEL, DEFAULTS, EXTRA, snapshotSource, installFixture } = require('./tabs-manager-preview');

const SCRATCH = process.env.HERMES_TEST_SCRATCH || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch') : path.join(os.homedir(), '.cache/hermes/scratch'));
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = SCRATCH;
fs.mkdirSync(SCRATCH, { recursive: true });
const OUT = fs.mkdtempSync(path.join(SCRATCH, 'tabs-manager-ui-'));
fs.mkdirSync(path.join(OUT, 'screenshots'));
const SOURCE = snapshotSource(); // One immutable source snapshot; never poll siblings.
const STAGE = process.env.TABS_MANAGER_STAGE || 'red';
const ALL_MODES = [
    { id: 'sortable-mouse', native: false, touch: false, width: 1440, height: 900 },
    { id: 'native-mouse', native: true, touch: false, width: 1440, height: 900 },
    { id: 'sortable-touch', native: false, touch: true, width: 393, height: 852 },
    { id: 'native-touch', native: true, touch: true, width: 393, height: 852 },
];
const chosen = process.env.TABS_MANAGER_MODES?.split(',');
const MODES = chosen ? ALL_MODES.filter(mode => chosen.includes(mode.id)) : ALL_MODES;
assert.ok(MODES.length && (!chosen || chosen.every(id => ALL_MODES.some(mode => mode.id === id))), 'unknown/empty TABS_MANAGER_MODES');
const selectedCases = process.env.TABS_MANAGER_CASES?.split(',').filter(Boolean);
const RECEIPT = {
    command: 'node tools/check-tabs-manager-ui.js', stage: STAGE, run: OUT,
    source: { path: SOURCE.filename, sha256: SOURCE.sha256, hasViewportMeta: SOURCE.hasViewportMeta,
        sortableAsset: SOURCE.sortablePath, bytes: Buffer.byteLength(SOURCE.html) },
    fixturePreconditions: ['Gemini already warm/offline: no cold-provider startup; no response is live backend evidence.',
        'League role probe transport unavailable: role-driven ladmin ownership is separate from tab visibility and cannot race an empty-list seed.'],
    scope: 'Exact whole dashboard HTML + real local assets, real Chromium events. Offline GET fixtures and total request interception; not live backend/inference/owner-browser acceptance.',
    safeguards: { ephemeralContexts: true, persistentProfileOpened: false, productionStarted: false,
        productionModulesImported: false, fixtureOriginHasNoListener: true,
        a6api: 'Passive nav partition member only; never selected, dragged, keyboard-transferred, or used as a test item.',
        handlerReplacement: false, fakeCommit: false },
    modes: [], scenarios: [], harnessIssues: [], fatal: null,
};
const saveReceipt = () => fs.writeFileSync(path.join(OUT, 'receipt.json'), JSON.stringify(RECEIPT, null, 2) + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listId = list => list === 'visible' ? 'tabs-manager-visible' : 'tabs-manager-hidden';
const rowSelector = (list, id) => '#' + listId(list) + ' > li[data-tab="' + id + '"]';
const safe = name => name.replace(/[^a-z0-9_-]+/gi, '-');

async function settle(scene) {
    if (scene.page.isClosed()) return;
    await scene.page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all((window.__tabsManagerQaPending || []).splice(0));
        if (window.__tabsManagerQaPending) window.__tabsManagerQaPending.length = 0;
    });
}
async function state(page) {
    return page.evaluate(({ key, sentinel }) => {
        const visible = node => {
            for (let el = node; el instanceof Element; el = el.parentElement) {
                const css = getComputedStyle(el);
                if (css.display === 'none' || css.visibility === 'hidden') return false;
            }
            return !!node;
        };
        const buttons = [...document.querySelectorAll('#main-nav > button.nav-btn[data-tab]')];
        const sections = [...document.querySelectorAll('#main-nav > div[data-extra-nav]')];
        const rows = id => [...document.querySelectorAll('#' + id + ' > li[data-tab]')].map(row => row.dataset.tab);
        const raw = localStorage.getItem(key);
        let config = null;
        try { config = raw === null ? null : JSON.parse(raw); } catch { config = '<invalid-json>'; }
        return {
            payload: raw, config, active: localStorage.getItem('opencode_active_tab'),
            ownerSentinel: localStorage.getItem(sentinel), localStorageKeys: Object.keys(localStorage).sort(),
            managerOpen: visible(document.getElementById('tabs-manager')),
            columns: { visible: rows('tabs-manager-visible'), hidden: rows('tabs-manager-hidden'), legacy: rows('tabs-manager-list') },
            sidebar: {
                order: buttons.map(b => b.dataset.tab),
                visible: buttons.filter(visible).map(b => b.dataset.tab),
                hidden: buttons.filter(b => !visible(b)).map(b => b.dataset.tab),
                activeButtons: buttons.filter(b => b.classList.contains('bg-elevated')).map(b => b.dataset.tab),
                sections: sections.map(s => ({ id: s.dataset.extraNav, visible: visible(s),
                    children: [...s.querySelectorAll('button.nav-btn[data-tab]')].map(b => b.dataset.tab),
                    childrenAtTopLevel: [...s.querySelectorAll('button.nav-btn[data-tab]')].filter(b => b.parentElement?.id === 'main-nav').map(b => b.dataset.tab) })),
                childOrder: [...document.querySelector('#main-nav')?.children || []].map(el => el.dataset.tab || el.dataset.extraNav).filter(Boolean),
            },
            activeContent: [...document.querySelectorAll('[data-tab-content].active')].map(el => el.dataset.tabContent),
        };
    }, { key: KEY, sentinel: SENTINEL });
}

async function screenshot(scene, name) {
    const filename = path.join(OUT, 'screenshots', safe(scene.mode.id + '-' + name) + '.png');
    await scene.page.screenshot({ path: filename, fullPage: false, timeout: 8000 });
    scene.record.screenshots.push(filename);
    return filename;
}
async function phase(scene, id) {
    scene.record.currentScenario = id;
    await scene.page.evaluate(id => { window.__tabsManagerQaPhase = id; }, id);
    await settle(scene);
}
async function requireColumns(scene) {
    const count = await scene.page.locator('#tabs-manager-visible, #tabs-manager-hidden').count();
    assert.equal(count, 2, 'Feature RED: exact visible/hidden drop lists are absent (legacy monkey-button manager is not a two-column implementation).');
    assert.ok(await scene.page.locator('#tabs-manager-visible').isVisible(), 'visible drop list must be reachable');
    assert.ok(await scene.page.locator('#tabs-manager-hidden').isVisible(), 'hidden drop list must be reachable');
}
async function open(scene) {
    if ((await state(scene.page)).managerOpen) return;
    const trigger = scene.page.locator('button[onclick="openTabsManager()"]', { hasText: 'Настроить вкладки' });
    try {
        if (scene.mode.touch) await trigger.tap();
        else await trigger.click();
    } catch (error) {
        scene.record.openFailure = await trigger.evaluate(node => {
            const r = node.getBoundingClientRect();
            return { width: innerWidth, height: innerHeight, scrollX, scrollY,
                visual: { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale,
                    offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop },
                rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.outerHTML.slice(0, 500) };
        });
        throw error;
    }
    await scene.page.locator('#tabs-manager').waitFor({ state: 'visible' });
    await settle(scene);
}
async function close(scene) {
    await scene.page.locator('#tabs-manager button', { hasText: 'Готово' }).click();
    await scene.page.locator('#tabs-manager').waitFor({ state: 'hidden' });
    await settle(scene);
}

function seedConfig(scene, visible, shown = [], order = scene.known) {
    assert.ok(!visible.includes('a6api') || visible.length === scene.known.length, 'a6api may only be a passive member of an all-visible seed');
    return { order: [...order], hidden: scene.known.filter(id => !visible.includes(id)), shown: [...shown] };
}
async function seed(scene, config, active = 'fin') {
    assert.notEqual(active, 'a6api', 'a6api cannot be navigated to');
    await phase(scene, 'fixture-seed');
    // Finish the preceding document's real reads before navigation. Cancelling
    // an unrelated Gemini load during fixture reload invokes its existing
    // cold-server recovery; that is not a Tabs Manager visibility operation.
    await scene.page.waitForFunction(() => window.__tabsManagerQaFetchPending === 0 && !_navQBusy, null, { timeout: 20000 });
    await scene.page.evaluate(({ config, active, key }) => {
        if (config === null) localStorage.removeItem(key);
        else localStorage.setItem(key, typeof config === 'string' ? config : JSON.stringify(config));
        localStorage.setItem('opencode_active_tab', active);
    }, { config, active, key: KEY });
    await scene.page.reload({ waitUntil: 'load' });
    await scene.page.waitForFunction(() => typeof openTabsManager === 'function' && !document.documentElement.classList.contains('tw-boot'));
    await open(scene);
    await settle(scene);
    await phase(scene, scene.record.currentScenario = scene.runningScenario);
}

function eqSet(actual, expected, label) {
    assert.deepEqual([...actual].sort(), [...expected].sort(), label);
    assert.equal(new Set(actual).size, actual.length, label + ': no duplicates');
}
function assertSchema(snapshot) {
    assert.ok(snapshot.config && snapshot.config !== '<invalid-json>', 'completed move must persist parseable config');
    assert.deepEqual(Object.keys(snapshot.config).sort(), ['hidden', 'order', 'shown'], 'preserve the exact v1 schema');
    for (const key of ['order', 'hidden', 'shown']) {
        assert.ok(Array.isArray(snapshot.config[key]), key + ' must be an array');
        assert.ok(snapshot.config[key].every(id => typeof id === 'string'), key + ' holds string identifiers');
        assert.equal(new Set(snapshot.config[key]).size, snapshot.config[key].length, key + ' has no duplicated IDs');
    }
}
function assertDefault(scene, snapshot) {
    assert.equal(snapshot.payload, null, 'fresh/reset defaults must remain implicit, not materialized');
    assert.deepEqual(snapshot.sidebar.visible, DEFAULTS.filter(id => scene.known.includes(id)), 'DEFAULT_TABS_VISIBLE and its order are unchanged');
    assert.ok(snapshot.sidebar.sections.every(s => !s.visible), 'Whoami/Чтим память are hidden by default');
}
async function assertPartition(scene) {
    await requireColumns(scene);
    const snapshot = await state(scene.page);
    const all = [...snapshot.columns.visible, ...snapshot.columns.hidden];
    eqSet(all, [...scene.known, ...EXTRA], 'each direct nav item/extra section must appear exactly once');
    assert.equal(all.length, scene.known.length + EXTRA.length, 'column counts must partition nav entries, not nested section children');
    assert.deepEqual(snapshot.columns.visible.filter(id => !EXTRA.includes(id)), snapshot.sidebar.visible,
        'visible list is a projection of actual SIDEBAR order, not an independent list');
    eqSet(snapshot.columns.hidden.filter(id => !EXTRA.includes(id)), snapshot.sidebar.hidden, 'hidden list matches actual SIDEBAR visibility');
    for (const section of snapshot.sidebar.sections) {
        assert.equal(snapshot.columns.visible.includes(section.id), section.visible, 'extra section visibility matches its sidebar container');
        for (const child of section.children) assert.ok(!all.includes(child), 'nested section child cannot become a top-level manager item: ' + child);
    }
    for (const id of all) {
        assert.equal(await scene.page.locator('#tabs-manager li[data-tab="' + id + '"] .tabs-manager-handle').count(), 1, 'one accessible drag handle per row: ' + id);
        assert.equal(await scene.page.locator('#tabs-manager li[data-tab="' + id + '"]').getAttribute('class').then(c => /\btabs-manager-row\b/.test(c || '')), true, 'row contract class: ' + id);
    }
    const controls = await scene.page.locator('#tabs-manager li[data-tab] button:not(.tabs-manager-handle), #tabs-manager li[data-tab] input[type="checkbox"], #tabs-manager li[data-tab] [role="switch"], #tabs-manager li[data-tab] [onclick*="toggleTabHidden"]').count();
    assert.equal(controls, 0, 'per-row visibility buttons/toggles must be removed');
    for (const list of ['visible', 'hidden']) {
        const heading = scene.page.locator('#tabs-manager-' + list + '-title');
        assert.equal(await heading.count(), 1, 'named readable list heading');
        assert.ok(await heading.isVisible());
        assert.match(await heading.textContent(), list === 'visible' ? /Видимые/ : /Скрытые/);
        const countText = await scene.page.locator('#tabs-manager-' + list + '-count').textContent();
        assert.equal(Number(countText.match(/\d+/)?.[0]), snapshot.columns[list].length, 'heading count equals collected rows');
        const headingCss = await heading.evaluate(node => {
            const css = getComputedStyle(node), box = node.getBoundingClientRect();
            return { fontSize: parseFloat(css.fontSize), opacity: Number(css.opacity), color: css.color,
                width: box.width, height: box.height, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
        });
        assert.ok(headingCss.fontSize >= 13 && headingCss.opacity >= 0.9 && headingCss.height > 0, 'headings cannot be tiny/faded');
        assert.ok(headingCss.scrollWidth <= headingCss.clientWidth + 1, 'heading and count must fit without clipping');
    }
    return snapshot;
}

async function handle(scene, list, id) {
    assert.notEqual(id, 'a6api', 'excluded provider cannot be a drag/keyboard test item');
    const row = scene.page.locator(rowSelector(list, id));
    assert.equal(await row.count(), 1, 'drag source must be present exactly once: ' + list + '/' + id);
    const grip = row.locator('.tabs-manager-handle, .handle').first();
    assert.equal(await grip.count(), 1, 'real source row needs a drag handle');
    await grip.scrollIntoViewIfNeeded();
    return grip;
}
async function targetPoint(scene, list, id, position = 'before') {
    const target = id ? scene.page.locator(rowSelector(list, id)) : scene.page.locator('#' + listId(list));
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert.ok(box && box.width > 20 && box.height > 20, 'empty or populated list needs a usable drop area');
    return { x: box.x + box.width * 0.58,
        y: id ? box.y + (position === 'after' ? box.height - 6 : 6) : box.y + Math.min(36, box.height / 2), box };
}
async function touch(scene, type, point) {
    await scene.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? []
        : [{ x: point.x, y: point.y, radiusX: 3, radiusY: 3, force: 1, id: 1 }] });
}
async function beginDrag(scene, grip) {
    await grip.scrollIntoViewIfNeeded();
    const box = await grip.boundingBox();
    assert.ok(box && box.width > 5 && box.height > 5, 'drag handle has a hit area');
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (scene.mode.touch) {
        await touch(scene, 'touchStart', start);
        await delay(400); // Real long press, not a synthesized dragstart.
        await touch(scene, 'touchMove', { x: start.x + 9, y: start.y + 3 });
    } else {
        await scene.page.mouse.move(start.x, start.y);
        await scene.page.mouse.down();
        await scene.page.mouse.move(start.x + 12, start.y + 3, { steps: 6 });
    }
    await delay(120);
    return start;
}
async function moveDrag(scene, start, target, pause = 260) {
    if (scene.mode.touch) {
        for (let step = 1; step <= 16; step++) {
            await touch(scene, 'touchMove', { x: start.x + (target.x - start.x) * step / 16,
                y: start.y + (target.y - start.y) * step / 16 });
            await delay(12);
        }
        await touch(scene, 'touchMove', { x: target.x, y: target.y + 2 });
    } else {
        await scene.page.mouse.move(target.x, target.y - 3, { steps: 24 });
        await scene.page.mouse.move(target.x, target.y, { steps: 3 }); // Chromium HTML5 needs a second dragover.
    }
    await delay(pause);
}
async function endDrag(scene, cancel = null) {
    if (cancel === 'escape') await scene.page.keyboard.press('Escape');
    if (scene.mode.touch) await touch(scene, cancel === 'touchcancel' ? 'touchCancel' : 'touchEnd', { x: 0, y: 0 });
    else await scene.page.mouse.up();
    await delay(220);
    await settle(scene);
}
async function drag(scene, fromList, id, toList, targetId = null, options = {}) {
    await requireColumns(scene);
    const before = await state(scene.page);
    const eventStart = scene.record.inputEvents.length;
    const grip = await handle(scene, fromList, id);
    const target = await targetPoint(scene, toList, targetId, options.position);
    // Scrolling the target may move the source. Re-read the source after it.
    const start = await beginDrag(scene, grip);
    await moveDrag(scene, start, target);
    const pending = await state(scene.page);
    await endDrag(scene, options.cancel);
    const after = await state(scene.page);
    const events = scene.record.inputEvents.slice(eventStart);
    const transport = scene.mode.touch ? 'CDP Input.dispatchTouchEvent' : 'Playwright mouse native input';
    scene.record.drags.push({ scenario: scene.runningScenario, id, fromList, toList, targetId, options,
        transport, start, target: { x: target.x, y: target.y }, pending, before, after,
        eventTypes: [...new Set(events.map(e => e.type))], trustedEvents: events.filter(e => e.trusted).length });
    assert.ok(events.some(e => e.trusted && e.tab === id && (scene.mode.touch ? e.type === 'touchstart' || e.type === 'pointerdown' : e.type === 'mousedown' || e.type === 'pointerdown')),
        'real trusted browser input must reach the actual source row');
    assert.equal(pending.payload, before.payload, 'hover is not a commit: no config write before release');
    assert.deepEqual(pending.sidebar.visible, before.sidebar.visible, 'hover does not mutate sidebar until completed drop');
    return { before, pending, after, events };
}
async function keyboardMove(scene, fromList, id, keys, finish = 'Space') {
    const grip = await handle(scene, fromList, id);
    await grip.focus();
    const before = await state(scene.page), eventStart = scene.record.inputEvents.length;
    assert.equal(await grip.evaluate(node => node.tabIndex >= 0 && !node.disabled), true, 'drag handle must be keyboard-focusable');
    await scene.page.keyboard.press('Space');
    for (const key of keys) await scene.page.keyboard.press(key);
    const pending = await state(scene.page);
    await scene.page.keyboard.press(finish);
    await settle(scene);
    const after = await state(scene.page);
    scene.record.keyboard.push({ scenario: scene.runningScenario, id, fromList, keys, finish, before, pending, after });
    assert.equal(pending.payload, before.payload, 'keyboard movement is transactional until Space/Enter');
    assert.deepEqual(pending.sidebar.visible, before.sidebar.visible, 'keyboard hover must not apply visibility early');
    assert.ok(scene.record.inputEvents.slice(eventStart).some(e => e.type === 'keydown' && e.trusted && e.key === ' '), 'real Space key reaches page');
    return { before, pending, after };
}
function assertNoTabsWrites(scene, baseline, label) {
    const writes = scene.record.storageWrites.slice(baseline).filter(w => w.phase !== 'boot' && w.phase !== 'fixture-seed' && (w.key === KEY || w.operation === 'clear'));
    assert.deepEqual(writes, [], label);
}

async function check(scene, id, title, run) {
    if (selectedCases && !selectedCases.includes(id)) return;
    scene.runningScenario = id;
    await phase(scene, id);
    const record = { mode: scene.mode.id, id, title, status: 'running', before: await state(scene.page), after: null,
        screenshots: [], assertions: [], error: null };
    const writeStart = scene.record.storageWrites.length;
    const errorStart = scene.record.errors.length;
    const requestStart = scene.record.requests.length;
    RECEIPT.scenarios.push(record);
    saveReceipt();
    try {
        await run({ writeStart, record });
        await settle(scene);
        assert.equal(scene.record.forbidden.filter(req => req.phase === id).length, 0, 'This scenario cannot issue activation/restart/model-map/other mutation requests');
        assert.equal(scene.record.inputEvents.filter(e => e.tab === 'a6api').length, 0, 'excluded provider cannot be an input target');
        assert.equal(scene.record.errors.slice(errorStart).length, 0, 'new uncaught/rejection errors during this scenario');
        const after = await state(scene.page);
        assert.equal(after.ownerSentinel, record.before.ownerSentinel, 'isolated owner sentinel cannot change');
        record.status = 'passed';
        console.log('PASS ' + scene.mode.id + ' / ' + id);
    } catch (error) {
        record.status = 'failed'; record.error = { message: error.message, stack: error.stack };
        console.error('FAIL ' + scene.mode.id + ' / ' + id + ': ' + error.message.slice(0, 1200)); // Full exact error and payload stay in receipt, not terminal megadiffs.
        try { record.screenshots.push(await screenshot(scene, STAGE + '-' + id)); } catch (captureError) {
            RECEIPT.harnessIssues.push({ mode: scene.mode.id, scenario: id, issue: 'failure screenshot unavailable', error: captureError.message });
        }
        // Recover only browser input; never touch implementation or poll source.
        try { await scene.page.mouse.up(); if (scene.mode.touch) await touch(scene, 'touchCancel', { x: 0, y: 0 }); } catch {}
    } finally {
        try { await settle(scene); record.after = await state(scene.page); } catch (error) {
            RECEIPT.harnessIssues.push({ mode: scene.mode.id, scenario: id, issue: 'state readback failed', error: error.message });
        }
        record.storageWrites = scene.record.storageWrites.slice(writeStart);
        record.requests = scene.record.requests.slice(requestStart);
        record.browserErrors = scene.record.errors.slice(errorStart);
        saveReceipt();
    }
}

async function runMode(browser, mode) {
    const record = { mode: mode.id, viewport: { width: mode.width, height: mode.height }, touch: mode.touch,
        disabledSortable: mode.native, requests: [], forbidden: [], unimplemented: [], blockedExternal: [], blockedSockets: [],
        storageWrites: [], inputEvents: [], errors: [], consoleErrors: [], drags: [], keyboard: [], screenshots: [],
        currentScenario: 'boot', engine: null, boot: null, final: null };
    RECEIPT.modes.push(record);
    const context = await browser.newContext({ viewport: { width: mode.width, height: mode.height },
        isMobile: mode.touch, hasTouch: mode.touch, deviceScaleFactor: 1,
        serviceWorkers: 'block', acceptDownloads: false });
    const scene = { mode, context, record, page: null, cdp: null, known: [], runningScenario: 'boot' };
    await installFixture(context, SOURCE, record, { native: mode.native });
    const page = scene.page = await context.newPage();
    page.setDefaultTimeout(4500);
    page.setDefaultNavigationTimeout(16000);
    page.on('pageerror', error => record.errors.push({ phase: record.currentScenario, message: error.message, stack: error.stack }));
    page.on('console', message => { if (message.type() === 'error') record.consoleErrors.push({ phase: record.currentScenario, text: message.text() }); });
    scene.cdp = await context.newCDPSession(page);
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false }); // Per-scenario screenshots/state already captured; do not trace 3.5MB DOM on every input.
    try {
        await page.goto(ORIGIN + '/', { waitUntil: 'load' });
        await page.waitForFunction(() => typeof openTabsManager === 'function' && !document.documentElement.classList.contains('tw-boot'));
        await settle(scene);
        record.boot = await state(page);
        record.bootViewport = await page.evaluate(() => ({ width: innerWidth, scale: visualViewport?.scale || 1 }));
        scene.known = record.boot.sidebar.order;
        assert.ok(scene.known.includes('fin') && scene.known.includes('league') && scene.known.includes('claude'), 'real dashboard navigation scope must load');
        if (record.errors.length) RECEIPT.harnessIssues.push({ mode: mode.id, issue: 'whole-dashboard boot error(s); see mode.errors, not suppressed', errors: record.errors });
        const basic = ['fin', 'league', 'github'];

        await check(scene, 'fresh-defaults', 'Свежие defaults/старый whitelist применяются без записи v1.', async () => {
            assertDefault(scene, await state(page));
            const actualDefaults = await page.evaluate(() => [...DEFAULT_TABS_VISIBLE]);
            assert.deepEqual(actualDefaults, DEFAULTS, 'existing whitelist must not change');
            assert.equal(record.storageWrites.filter(w => w.key === KEY && w.phase !== 'fixture-seed').length, 0, 'boot cannot materialize defaults');
        });
        await check(scene, 'open-close-read-only', 'Открытие, Готово и повторное открытие ничего не сохраняют и не меняют профиль.', async ({ writeStart, record: result }) => {
            const before = await state(page);
            await open(scene);
            result.screenshots.push(await screenshot(scene, STAGE + '-initial'));
            await close(scene); await open(scene);
            const after = await state(page);
            assert.equal(after.payload, before.payload);
            assert.deepEqual(after.sidebar, before.sidebar, 'opening cannot alter nav projection');
            assert.equal(after.active, before.active, 'opening cannot activate another tab');
            assertNoTabsWrites(scene, writeStart, 'opening/closing cannot write localStorage config');
            result.backgroundStorageWrites = record.storageWrites.slice(writeStart).filter(w => w.key !== KEY && w.operation !== 'clear');
            // Only tabs config belongs to this acceptance surface. The complete
            // ledger still reports unrelated League feed/cache writes honestly.

        });
        await check(scene, 'two-columns-partition-ui', 'Две читаемые колонки, точные counts/partition, ни одной кнопки видимости.', async () => {
            await assertPartition(scene);
            record.engine = await page.evaluate(() => {
                const elements = ['tabs-manager-visible', 'tabs-manager-hidden', 'tabs-manager-list'].map(id => {
                    const el = document.getElementById(id);
                    const sortable = el && (window.Sortable?.get?.(el) || el._sortable);
                    return { id, present: !!el, sortable: !!sortable, group: sortable?.options?.group?.name || null,
                        draggable: el?.querySelector('li')?.draggable || false };
                });
                return { available: typeof window.Sortable !== 'undefined', version: window.Sortable?.version || null, elements };
            });
            assert.equal(record.engine.available, !mode.native, 'requested drag engine must be exercised, not silently swapped');
            if (!mode.native) assert.ok(record.engine.elements.filter(e => e.id !== 'tabs-manager-list').every(e => e.sortable), 'SortableJS path must wire BOTH connected drop lists');
        });
        await check(scene, 'viewport-heading-layout', 'Desktop1440/mobile393: headings и drop-колонки помещаются в реальный viewport.', async ({ record: result }) => {
            await open(scene);
            await requireColumns(scene);
            const geometry = await page.evaluate(() => {
                const box = el => {
                    const r = el.getBoundingClientRect(); const css = getComputedStyle(el);
                    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
                        overflowX: css.overflowX, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
                };
                return { width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width, pageScrollWidth: document.documentElement.scrollWidth,
                    viewportMeta: document.querySelector('meta[name="viewport"]')?.content || null,
                    dialog: box(document.querySelector('#tabs-manager > [role="dialog"], #tabs-manager .tabs-manager-dialog')),
                    lists: [...document.querySelectorAll('#tabs-manager-visible, #tabs-manager-hidden')].map(box),
                    handles: [...document.querySelectorAll('#tabs-manager .tabs-manager-handle')].map(box) };
            });
            result.geometry = geometry;
            assert.equal(geometry.width, mode.width, 'real mobile CSS viewport must be 393, not a scaled desktop 980px without viewport meta');
            assert.ok(geometry.pageScrollWidth <= geometry.width + 1, 'whole dashboard must not add horizontal page overflow');
            assert.ok(geometry.dialog.left >= 0 && geometry.dialog.right <= mode.width + 1);
            assert.ok(geometry.dialog.top >= 0 && geometry.dialog.bottom <= geometry.height + 1);
            assert.ok(geometry.lists.every(l => l.width >= 120 && l.height >= 50 && l.left >= 0 && l.right <= mode.width + 1 && l.scrollWidth <= l.clientWidth + 1),
                'both mobile drop targets remain usable without horizontal clipping');
            assert.ok(geometry.handles.every(h => h.width >= 24 && h.height >= 32), 'handles have a usable pointer hit area');
            result.screenshots.push(await screenshot(scene, STAGE + '-layout'));
        });
        await check(scene, 'modal-viewport-restoration', 'Mobile viewport принадлежит открытой модалке, закрытие восстанавливает соседние вкладки.', async () => {
            await open(scene);
            if (mode.touch) assert.equal(await page.evaluate(() => innerWidth), mode.width, 'opened manager uses the real phone width');
            await close(scene);
            assert.equal(await page.locator('meta[name="viewport"]').count(), SOURCE.hasViewportMeta ? 1 : 0, 'closing restores the pre-existing document viewport');
            const closedViewport = await page.evaluate(() => ({ width: innerWidth, scale: visualViewport?.scale || 1 }));
            assert.equal(closedViewport.width, record.bootViewport.width, 'closing restores the legacy layout viewport, not merely the absence of a meta tag');
            assert.ok(Math.abs(closedViewport.scale - record.bootViewport.scale) < .01, 'closing restores the pre-existing browser zoom so the opener remains tappable after reload');
            await open(scene);
            if (mode.touch) assert.equal(await page.evaluate(() => innerWidth), mode.width, 'reopened manager again uses phone width');
        });

        await check(scene, 'drag-visible-to-hidden', 'Настоящий drag вправо скрывает League в SIDEBAR и сохраняет schema только после drop.', async () => {
            await seed(scene, seedConfig(scene, basic)); await requireColumns(scene);
            const result = await drag(scene, 'visible', 'league', 'hidden', 'claude');
            assert.ok(result.after.columns.hidden.includes('league'));
            assert.ok(!result.after.sidebar.visible.includes('league'), 'actual sidebar button must be hidden');
            assert.ok(result.after.config.hidden.includes('league')); assertSchema(result.after);
            await assertPartition(scene);
        });
        await check(scene, 'drag-hidden-to-visible', 'Настоящий drag влево возвращает Claude; reopen и F5 читают тот же payload/sidebar.', async ({ record: result }) => {
            await seed(scene, seedConfig(scene, basic));
            const moved = await drag(scene, 'hidden', 'claude', 'visible', 'league');
            assert.ok(moved.after.sidebar.visible.includes('claude'), 'sidebar must expose restored tab');
            assert.ok(!moved.after.config.hidden.includes('claude')); assertSchema(moved.after);
            const persisted = moved.after;
            await close(scene); await open(scene);
            assert.deepEqual((await state(page)).sidebar, persisted.sidebar, 'reopen reads persistent projection');
            assert.equal((await state(page)).payload, persisted.payload);
            await phase(scene, 'reload'); await page.reload({ waitUntil: 'load' });
            await page.waitForFunction(() => typeof openTabsManager === 'function' && !document.documentElement.classList.contains('tw-boot'));
            await open(scene); await phase(scene, scene.runningScenario);
            const reloaded = await state(page);
            assert.equal(reloaded.payload, persisted.payload, 'F5 must not rewrite the payload');
            assert.deepEqual(reloaded.sidebar.visible, persisted.sidebar.visible, 'F5 reads exact sidebar visibility/order');
            await assertPartition(scene);
            result.screenshots.push(await screenshot(scene, STAGE + '-restored-after-f5'));
        });
        await check(scene, 'drag-visible-reorder', 'Drag внутри левой колонки меняет именно SIDEBAR order; видимость/extra shown сохраняются.', async () => {
            await seed(scene, seedConfig(scene, basic));
            const { before, after } = await drag(scene, 'visible', 'github', 'visible', 'fin');
            assert.deepEqual(after.sidebar.visible, ['github', 'fin', 'league'], 'actual nav order must match the completed reorder');
            eqSet(after.sidebar.visible, before.sidebar.visible, 'reorder does not change visibility');
            eqSet(after.config.hidden.filter(id => !EXTRA.includes(id)), before.config.hidden.filter(id => !EXTRA.includes(id)), 'reorder does not change ordinary/unknown hidden identifiers; extra defaults may materialize');
            assert.deepEqual(after.config.shown, before.config.shown); assertSchema(after);
            await assertPartition(scene);
        });
        await check(scene, 'drag-noop-no-write', 'Drag/drop на свою строку не пишет localStorage даже на fresh defaults.', async ({ writeStart }) => {
            await seed(scene, null); const baseline = record.storageWrites.length;
            const { before, after } = await drag(scene, 'visible', 'league', 'visible', 'league');
            assert.equal(after.payload, before.payload);
            assert.deepEqual(after.sidebar, before.sidebar);
            assert.deepEqual(after.columns, before.columns);
            assertNoTabsWrites(scene, baseline, 'same-index drag is a no-op, not a persistence transaction');
            void writeStart;
        });
        await check(scene, 'drag-escape-cancel', 'Esc отменяет real drag: DOM/sidebar/payload восстановлены, записи нет.', async () => {
            await seed(scene, seedConfig(scene, basic)); const baseline = record.storageWrites.length;
            const { before, after } = await drag(scene, 'visible', 'league', 'hidden', 'claude', { cancel: 'escape' });
            assert.equal(after.payload, before.payload); assert.deepEqual(after.sidebar, before.sidebar); assert.deepEqual(after.columns, before.columns);
            assertNoTabsWrites(scene, baseline, 'cancelled drag must not commit/materialize config');
        });
        if (!mode.native) await check(scene, 'drag-escape-engine-cleanup', 'Esc завершает сам Sortable drag, удаляет preview clone и не оставляет live engine.', async () => {
            await seed(scene, seedConfig(scene, basic)); await requireColumns(scene);
            const before = await state(page), baseline = record.storageWrites.length;
            const target = await targetPoint(scene, 'hidden', 'claude');
            const start = await beginDrag(scene, await handle(scene, 'visible', 'league'));
            await moveDrag(scene, start, target);
            assert.equal(await page.evaluate(() => !!window.Sortable.active), true, 'real drag engine started');
            try {
                await page.keyboard.press('Escape'); await settle(scene);
                const engine = await page.evaluate(() => ({ active: !!window.Sortable.active,
                    clones: document.querySelectorAll('#tabs-manager .tabs-manager-fallback').length }));
                assert.equal(engine.active, false, 'Escape must terminate Sortable, not only restore application rows');
                assert.equal(engine.clones, 0, 'cancelled drag leaves no fallback clone');
            } finally { await endDrag(scene); }
            const after = await state(page);
            assert.deepEqual(after.columns, before.columns); assert.deepEqual(after.sidebar, before.sidebar);
            assert.equal(after.payload, before.payload); assertNoTabsWrites(scene, baseline, 'engine cancel is read-only');
        });
        await check(scene, 'drag-outside-cancel', 'Release вне drop-колонок не коммитит drag и не теряет row.', async () => {
            await seed(scene, seedConfig(scene, basic)); await requireColumns(scene);
            const before = await state(page), baseline = record.storageWrites.length;
            const grip = await handle(scene, 'visible', 'league');
            const start = await beginDrag(scene, grip);
            await moveDrag(scene, start, { x: 2, y: 2 }); await endDrag(scene);
            const after = await state(page);
            assert.equal(after.payload, before.payload); assert.deepEqual(after.sidebar, before.sidebar); assert.deepEqual(after.columns, before.columns);
            assertNoTabsWrites(scene, baseline, 'invalid/outside drop is cancelled');
        });
        if (mode.touch) await check(scene, 'touchcancel-no-write', 'Системный touchCancel откатывает реальный touch перенос без записи.', async () => {
            await seed(scene, seedConfig(scene, basic)); const baseline = record.storageWrites.length;
            const { before, after } = await drag(scene, 'visible', 'league', 'hidden', 'claude', { cancel: 'touchcancel' });
            assert.equal(after.payload, before.payload); assert.deepEqual(after.sidebar, before.sidebar); assert.deepEqual(after.columns, before.columns);
            assertNoTabsWrites(scene, baseline, 'touchCancel cannot be interpreted as touchEnd commit');
        });

        await check(scene, 'empty-hidden-target', 'Настоящий transfer в пустую Скрытые: usable drop area и SIDEBAR readback.', async () => {
            await seed(scene, seedConfig(scene, scene.known, EXTRA)); await requireColumns(scene);
            assert.equal((await state(page)).columns.hidden.length, 0, 'fixture creates empty hidden column');
            const { after } = await drag(scene, 'visible', 'league', 'hidden');
            assert.ok(after.columns.hidden.includes('league')); assert.ok(!after.sidebar.visible.includes('league')); assertSchema(after);
            await assertPartition(scene);
        });
        await check(scene, 'all-hidden-empty-visible-recovery', 'Все скрыты: Настроить вкладки достижимо, drag в пустые Видимые восстанавливает навигацию.', async ({ record: result }) => {
            await seed(scene, seedConfig(scene, [])); await requireColumns(scene);
            assert.equal((await state(page)).sidebar.visible.length, 0);
            assert.equal((await state(page)).columns.visible.length, 0);
            await close(scene); assert.ok(await page.locator('button[onclick="openTabsManager()"]', { hasText: 'Настроить вкладки' }).isVisible());
            await open(scene);
            const { after } = await drag(scene, 'hidden', 'fin', 'visible');
            assert.deepEqual(after.sidebar.visible, ['fin'], 'empty-visible recovery exposes the actual nav button');
            assert.equal(after.active, 'fin'); assert.ok(after.activeContent.includes('fin')); assertSchema(after);
            await assertPartition(scene);
            result.screenshots.push(await screenshot(scene, STAGE + '-all-hidden-recovered'));
        });
        await check(scene, 'active-hidden-first-visible', 'Скрытие active League выбирает first-visible FIN, не provider activation.', async () => {
            await seed(scene, seedConfig(scene, basic), 'league');
            assert.equal((await state(page)).active, 'league');
            const { after } = await drag(scene, 'visible', 'league', 'hidden', 'claude');
            assert.equal(after.active, after.sidebar.visible[0], 'active hidden fallback follows actual sidebar order');
            assert.equal(after.active, 'fin'); assert.ok(after.activeContent.includes('fin'));
            assert.ok(!after.sidebar.activeButtons.includes('league'));
        });
        await check(scene, 'unknown-saved-identifiers', 'Unknown order/hidden/shown IDs переживают transfer/reorder/reopen/F5 без нормализации.', async () => {
            const markers = { order: 'future/order-entry:KEEP', hidden: 'future/hidden-entry:KEEP', shown: 'future/extra-entry:KEEP' };
            const config = seedConfig(scene, basic);
            config.order.splice(1, 0, markers.order); config.hidden.push(markers.hidden); config.shown.push(markers.shown);
            await seed(scene, config);
            const { after } = await drag(scene, 'visible', 'league', 'hidden', 'claude');
            for (const key of ['order', 'hidden', 'shown']) assert.ok(after.config[key].includes(markers[key]), 'unknown saved ID preserved exactly in ' + key);
            const reordered = await drag(scene, 'visible', 'github', 'visible', 'fin');
            for (const key of ['order', 'hidden', 'shown']) assert.ok(reordered.after.config[key].includes(markers[key]));
            await close(scene); await open(scene);
            await phase(scene, 'reload'); await page.reload({ waitUntil: 'load' });
            await page.waitForFunction(() => typeof openTabsManager === 'function' && !document.documentElement.classList.contains('tw-boot'));
            await open(scene); await phase(scene, scene.runningScenario);
            for (const key of ['order', 'hidden', 'shown']) assert.ok((await state(page)).config[key].includes(markers[key]));
            await assertPartition(scene);
        });

        for (const extra of EXTRA) await check(scene, 'extra-' + extra + '-shown-semantics', 'Extra ' + extra + ': shown отдельно, место/дети SIDEBAR сохранены, повторный hide переживает F5.', async () => {
            const config = seedConfig(scene, basic);
            await seed(scene, config);
            const beforeRestore = await state(page);
            const childrenBefore = beforeRestore.sidebar.sections.find(s => s.id === extra).children;
            const relativeSectionPlacement = snapshot => snapshot.sidebar.childOrder
                .filter(id => id === extra || snapshot.sidebar.order.includes(id));
            const placementBefore = relativeSectionPlacement(beforeRestore);
            const restored = await drag(scene, 'hidden', extra, 'visible', 'league');
            assert.ok(restored.after.config.shown.includes(extra), 'restored EXTRA_NAV is explicitly shown');
            assert.ok(!restored.after.config.order.includes(extra), 'extra section is not an ordinary tab order entry');
            assert.ok(restored.after.sidebar.sections.find(s => s.id === extra).visible);
            assert.deepEqual(relativeSectionPlacement(restored.after), placementBefore, 'extra sections keep their original separate sidebar placement; manager position is not ordinary nav order');
            assert.deepEqual(restored.after.sidebar.sections.find(s => s.id === extra).children, childrenBefore);
            await assertPartition(scene);
            const hidden = await drag(scene, 'visible', extra, 'hidden', 'claude');
            assert.ok(!hidden.after.config.shown.includes(extra), 'hiding EXTRA_NAV removes shown opt-in, not a contradictory hidden/shown toggle');
            assert.ok(!hidden.after.sidebar.sections.find(s => s.id === extra).visible);
            await phase(scene, 'reload'); await page.reload({ waitUntil: 'load' });
            await page.waitForFunction(() => typeof openTabsManager === 'function' && !document.documentElement.classList.contains('tw-boot'));
            await open(scene); await phase(scene, scene.runningScenario);
            assert.ok(!((await state(page)).sidebar.sections.find(s => s.id === extra).visible), 'extra hide remains hidden after F5');
            await assertPartition(scene);
        });

        await check(scene, 'keyboard-transfer-equivalent', 'Space/ArrowRight/Space и ArrowLeft/Enter эквивалентны completed drag и меняют SIDEBAR.', async () => {
            await seed(scene, seedConfig(scene, basic)); await requireColumns(scene);
            const hidden = await keyboardMove(scene, 'visible', 'league', ['ArrowRight']);
            assert.ok(!hidden.after.sidebar.visible.includes('league')); assert.ok(hidden.after.config.hidden.includes('league')); assertSchema(hidden.after);
            const shown = await keyboardMove(scene, 'hidden', 'league', ['ArrowLeft'], 'Enter');
            assert.ok(shown.after.sidebar.visible.includes('league')); assert.ok(!shown.after.config.hidden.includes('league')); assertSchema(shown.after);
            await assertPartition(scene);
        });
        await check(scene, 'keyboard-reorder-equivalent', 'Space/ArrowUp/Space меняет SIDEBAR порядок и не меняет partition.', async () => {
            await seed(scene, seedConfig(scene, basic));
            const { before, after } = await keyboardMove(scene, 'visible', 'github', ['ArrowUp']);
            assert.deepEqual(after.sidebar.visible, ['fin', 'github', 'league']);
            eqSet(after.sidebar.visible, before.sidebar.visible, 'keyboard reorder preserves visibility'); assertSchema(after);
            await assertPartition(scene);
        });
        await check(scene, 'keyboard-cancel-noop-no-write', 'Keyboard Escape, Space без движения и boundary ArrowUp не пишут конфиг.', async () => {
            await seed(scene, seedConfig(scene, basic)); const baseline = record.storageWrites.length;
            const cancelled = await keyboardMove(scene, 'visible', 'league', ['ArrowRight'], 'Escape');
            assert.equal(cancelled.after.payload, cancelled.before.payload); assert.deepEqual(cancelled.after.columns, cancelled.before.columns);
            const noop = await keyboardMove(scene, 'visible', 'league', []);
            assert.equal(noop.after.payload, noop.before.payload);
            const boundary = await keyboardMove(scene, 'visible', 'fin', ['ArrowUp']);
            assert.equal(boundary.after.payload, boundary.before.payload); assert.deepEqual(boundary.after.sidebar, boundary.before.sidebar);
            assertNoTabsWrites(scene, baseline, 'all three keyboard cancellations/noops must be read-only');
        });
        await check(scene, 'keyboard-empty-visible-target', 'Keyboard transfer в пустую левую колонку восстанавливает actual SIDEBAR.', async () => {
            await seed(scene, seedConfig(scene, []));
            const { after } = await keyboardMove(scene, 'hidden', 'fin', ['ArrowLeft']);
            assert.deepEqual(after.sidebar.visible, ['fin']); assertSchema(after); await assertPartition(scene);
        });
        await check(scene, 'keyboard-tab-reachability', 'Ручки достижимы Tab без programmatic focus; инструкция и live status присутствуют.', async () => {
            await seed(scene, seedConfig(scene, basic)); await requireColumns(scene);
            await page.locator('#tabs-manager button', { hasText: 'Готово' }).focus();
            let reachable = false;
            for (let i = 0; i < scene.known.length + 8; i++) {
                await page.keyboard.press('Tab');
                const focused = await page.evaluate(() => ({ handle: document.activeElement?.matches('.tabs-manager-handle'), tab: document.activeElement?.closest('li[data-tab]')?.dataset.tab }));
                if (focused.handle && focused.tab !== 'a6api') { reachable = true; break; }
            }
            assert.ok(reachable, 'Tab must reach a keyboard drag handle');
            assert.match(await page.locator('#tabs-manager-instructions').textContent(), /(?:клавиатур|пробел|Space)/i);
            assert.equal(await page.locator('#tabs-manager [role="status"][aria-live]').count(), 1, 'keyboard changes have an announcement surface');
        });

        await check(scene, 'reset-rejected-read-only', 'Сбросить требует confirm; отказ сохраняет точный payload/unknown IDs.', async () => {
            const cfg = seedConfig(scene, basic); cfg.order.push('unknown/reset-kept');
            await seed(scene, cfg); const before = await state(page), baseline = record.storageWrites.length;
            let seen = null;
            const onDialog = dialog => { seen = { type: dialog.type(), message: dialog.message() }; return dialog.dismiss(); };
            page.once('dialog', onDialog);
            await page.locator('#tabs-manager button', { hasText: 'Сбросить' }).click();
            page.removeListener('dialog', onDialog); await settle(scene);
            assert.ok(seen && seen.type === 'confirm', 'reset cannot be immediate/destructive without confirmation');
            assert.match(seen.message, /Сбросить/);
            assert.equal((await state(page)).payload, before.payload); assert.deepEqual((await state(page)).sidebar, before.sidebar);
            assertNoTabsWrites(scene, baseline, 'rejected reset must not remove/save config');
        });
        await check(scene, 'reset-confirmed-defaults', 'Подтверждённый reset удаляет key, возвращает прежний default без новой записи; F5 устойчив.', async ({ record: result }) => {
            await seed(scene, seedConfig(scene, basic)); const baseline = record.storageWrites.length;
            let seen = null;
            const onDialog = dialog => { seen = { type: dialog.type(), message: dialog.message() }; return dialog.accept(); };
            page.once('dialog', onDialog);
            await page.locator('#tabs-manager button', { hasText: 'Сбросить' }).click();
            page.removeListener('dialog', onDialog); await settle(scene);
            assert.ok(seen && seen.type === 'confirm');
            assertDefault(scene, await state(page)); await assertPartition(scene);
            const writes = record.storageWrites.slice(baseline).filter(w => w.key === KEY);
            assert.equal(writes.filter(w => w.operation === 'removeItem').length, 1, 'confirmed reset removes key exactly once');
            assert.equal(writes.filter(w => w.operation === 'setItem').length, 0, 'reset must not materialize fresh config');
            await phase(scene, 'reload'); await page.reload({ waitUntil: 'load' });
            await page.waitForFunction(() => typeof openTabsManager === 'function' && !document.documentElement.classList.contains('tw-boot'));
            await open(scene); await phase(scene, scene.runningScenario);
            assertDefault(scene, await state(page));
            result.screenshots.push(await screenshot(scene, STAGE + '-reset-final'));
        });
        await check(scene, 'malformed-storage-defaults', 'Невалидный saved JSON применяет default без скрытой записи/repair.', async () => {
            await seed(scene, '{invalid-json:KEEP');
            const baseline = record.storageWrites.length, snapshot = await state(page);
            assert.equal(snapshot.payload, '{invalid-json:KEEP', 'literal malformed storage is not silently rewritten');
            assert.deepEqual(snapshot.sidebar.visible, DEFAULTS.filter(id => scene.known.includes(id)));
            assertNoTabsWrites(scene, baseline, 'opening invalid saved config must not repair the owner profile');
        });

        if (mode.touch) await check(scene, 'mobile-scroll-not-drag', 'Touch swipe по label прокручивает список без случайного commit/transfer.', async ({ record: result }) => {
            await seed(scene, seedConfig(scene, basic)); await requireColumns(scene);
            const list = page.locator('#tabs-manager-hidden');
            await list.evaluate(node => { node.scrollTop = 0; }); // Scroll setup, not a UI-state commit.
            const before = await state(page), baseline = record.storageWrites.length;
            const dimensions = await list.evaluate(node => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
            assert.ok(dimensions.scrollHeight > dimensions.clientHeight + 30, 'mobile fixture must contain a genuinely scrollable hidden list');
            const box = await list.boundingBox();
            const start = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.76 };
            await touch(scene, 'touchStart', start);
            for (let step = 1; step <= 12; step++) {
                await touch(scene, 'touchMove', { x: start.x, y: start.y - Math.min(170, box.height * 0.5) * step / 12 }); await delay(16);
            }
            await touch(scene, 'touchEnd', start); await delay(180); await settle(scene);
            const afterScroll = await list.evaluate(node => node.scrollTop);
            result.scroll = { before: dimensions, afterScroll };
            assert.ok(afterScroll > dimensions.scrollTop + 5, 'non-handle swipe must scroll the list, not swallow touch');
            assert.equal((await state(page)).payload, before.payload); assert.deepEqual((await state(page)).columns, before.columns);
            assertNoTabsWrites(scene, baseline, 'a scroll gesture cannot save tab visibility/order');
        });
        await check(scene, 'drag-edge-autoscroll', 'Real drag у края прокручивает длинную колонку; Esc после scroll не сохраняет.', async ({ record: result }) => {
            await seed(scene, seedConfig(scene, basic)); await requireColumns(scene);
            const list = page.locator('#tabs-manager-hidden'); await list.evaluate(node => { node.scrollTop = 0; });
            const box = await list.boundingBox();
            const dimensions = await list.evaluate(node => ({ scrollTop: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }));
            assert.ok(dimensions.scrollHeight > dimensions.clientHeight + 30, 'drag scrolling scenario needs overflow');
            const before = await state(page), baseline = record.storageWrites.length;
            const start = await beginDrag(scene, await handle(scene, 'visible', 'league'));
            const target = { x: box.x + box.width * 0.65, y: box.y + box.height - 14 };
            await moveDrag(scene, start, target, 950);
            const afterScroll = await list.evaluate(node => node.scrollTop);
            await endDrag(scene, 'escape');
            result.scroll = { before: dimensions, afterScroll, start, target };
            assert.ok(afterScroll > dimensions.scrollTop + 5, 'real drag near edge must auto-scroll to rows below the fold');
            assert.equal((await state(page)).payload, before.payload); assert.deepEqual((await state(page)).sidebar, before.sidebar); assert.deepEqual((await state(page)).columns, before.columns);
            assertNoTabsWrites(scene, baseline, 'scroll/cancel is not a completed move');
        });
        await check(scene, 'no-lifecycle-profile-network-write', 'Вся matrix: ни одного POST/PUT/DELETE/activation/restart/model-map; профиль недоступен.', async ({ record: result }) => {
            assert.deepEqual(record.forbidden, [], 'all state-changing requests are forbidden and read back from interception ledger');
            const financeReads = record.blockedExternal.filter(req => req.method === 'GET' && req.origin === 'https://www.cbr-xml-daily.ru' && req.path === '/daily_json.js');
            result.outOfScopeFinanceReads = financeReads;
            assert.deepEqual(record.blockedExternal.filter(req => !financeReads.includes(req)), [], 'no unexpected outbound provider/owner/mutating request; known FIN readonly exchange-rate GET is intercepted and explicitly enumerated');
            assert.deepEqual(record.blockedSockets, [], 'no live WebSocket path');
            const snapshot = await state(page);
            assert.equal(snapshot.ownerSentinel, 'isolated-test-sentinel-not-an-owner-profile');
            assert.ok(!record.inputEvents.some(e => e.tab === 'a6api'), 'a6api is not a test input');
            result.requestMethods = [...new Set(record.requests.map(req => req.method))];
            result.screenshots.push(await screenshot(scene, STAGE + '-last-state'));
        });
        record.final = await state(page);
    } catch (error) {
        RECEIPT.harnessIssues.push({ mode: mode.id, issue: 'mode setup/teardown failed', error: error.message, stack: error.stack });
        try { await screenshot(scene, STAGE + '-mode-error'); } catch {}
    } finally {
        record.engine ||= await page.evaluate(() => ({ available: typeof window.Sortable !== 'undefined', version: window.Sortable?.version || null })).catch(() => null);
        try { await settle(scene); } catch {}
        await context.tracing.stop({ path: path.join(OUT, safe(mode.id) + '-trace.zip') }).catch(error =>
            RECEIPT.harnessIssues.push({ mode: mode.id, issue: 'trace unavailable', error: error.message }));
        await context.close();
        saveReceipt();
    }
}

(async () => {
    fs.writeFileSync(path.join(OUT, 'source-sha256.txt'), SOURCE.sha256 + '  ' + SOURCE.filename + '\n');
    fs.writeFileSync(path.join(OUT, 'exact-source-snapshot.html'), SOURCE.html);
    console.log('TABS_MANAGER_EVIDENCE ' + OUT);
    const browser = await chromium.launch({ headless: true, downloadsPath: path.join(OUT, 'downloads') });
    RECEIPT.browser = { version: browser.version(), executable: chromium.executablePath(), playwright: require('playwright/package.json').version };
    const sourceStart = Date.now();
    const watchdog = setTimeout(() => {
        RECEIPT.fatal = { message: 'Bounded browser suite exceeded 480 seconds; incomplete scenarios remain RED, never GREEN.' };
        RECEIPT.result = 'HARNESS_TIMEOUT'; saveReceipt();
        console.error(RECEIPT.fatal.message); browser.close().finally(() => { process.exitCode = 2; });
    }, 480000);
    try {
        for (const mode of MODES) await runMode(browser, mode);
    } finally { clearTimeout(watchdog); await browser.close(); }
    RECEIPT.durationMs = Date.now() - sourceStart;
    const totals = {
        selectedModes: MODES.length, modesRun: RECEIPT.modes.length, scenarios: RECEIPT.scenarios.length,
        passed: RECEIPT.scenarios.filter(s => s.status === 'passed').length,
        failed: RECEIPT.scenarios.filter(s => s.status === 'failed').length,
        running: RECEIPT.scenarios.filter(s => s.status === 'running').length,
        forbiddenRequests: RECEIPT.modes.flatMap(m => m.forbidden).length,
        uncaughtErrors: RECEIPT.modes.flatMap(m => m.errors).length,
        harnessIssues: RECEIPT.harnessIssues.length,
        screenshots: new Set(RECEIPT.modes.flatMap(m => m.screenshots)).size,
        realInputEvents: RECEIPT.modes.flatMap(m => m.inputEvents).filter(e => e.trusted).length,
    };
    if (selectedCases) assert.ok(selectedCases.every(id => RECEIPT.scenarios.some(s => s.id === id)), 'unknown or unavailable TABS_MANAGER_CASES');
    assert.equal(totals.scenarios, totals.passed + totals.failed + totals.running, 'enumerated receipt scenarios partition exactly');
    RECEIPT.totals = totals;
    RECEIPT.result = totals.failed || totals.harnessIssues || totals.running || totals.modesRun !== totals.selectedModes ? 'RED' : 'GREEN';
    saveReceipt();
    const summary = [
        '# Tabs Manager — real browser receipt', '',
        '- Result: ' + RECEIPT.result,
        '- Scope: ' + RECEIPT.scope,
        '- Source: `' + RECEIPT.source.path + '` SHA256 `' + RECEIPT.source.sha256 + '`',
        '- Chromium: ' + RECEIPT.browser.version + '; Playwright: ' + RECEIPT.browser.playwright,
        '- Totals: ' + JSON.stringify(totals),
        '- Payload before/after, sidebar readback, trusted input events, all requests/errors: `receipt.json`.',
        '- Traces: one lightweight API/input trace per requested mode; exact source and per-scenario screenshots/state are stored separately.', '',
        '| Mode | Scenario | Result | Error |', '|---|---|---|---|',
        ...RECEIPT.scenarios.map(s => '| ' + s.mode + ' | ' + s.id + ' | ' + s.status + ' | ' + (s.error?.message || '').split('\n')[0].replace(/\|/g, '\\|') + ' |'),
        '', '## Harness limitations',
        '- Offline backend GET fixtures are explicitly marked; 404 endpoints are enumerated. No inference, gateway transaction or live process acceptance claimed.',
        '- New nonpersistent browser contexts cannot access owner browser localStorage/profile. No owner profile files, manifests, runtime modules or production services are opened.',
        '- CDP touch generates trusted Chromium events; the layout test separately requires a genuine 393px CSS viewport and stays RED if source viewport metadata is missing. Physical touch hardware acceptance is not claimed.',
        ...RECEIPT.harnessIssues.map(issue => '- ' + JSON.stringify(issue)), '',
    ].join('\n');
    fs.writeFileSync(path.join(OUT, 'report.md'), summary);
    console.log('TABS_MANAGER_RESULT ' + JSON.stringify({ result: RECEIPT.result, ...totals, receipt: path.join(OUT, 'receipt.json'), report: path.join(OUT, 'report.md'), evidence: OUT }));
    process.exitCode = RECEIPT.result === 'GREEN' ? 0 : 1;
})().catch(error => {
    RECEIPT.fatal = { message: error.message, stack: error.stack }; RECEIPT.result = 'HARNESS_ERROR'; saveReceipt();
    console.error(error.stack); console.log('TABS_MANAGER_EVIDENCE ' + OUT); process.exitCode = 2;
});
