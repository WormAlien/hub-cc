#!/usr/bin/env node
'use strict';
// Vertical DOM/state acceptance for the real Tabs Manager source only.
// Network is intercepted; provider content, activation and lifecycle are never executed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const routing = path.join(__dirname, '..', 'routing');
const html = fs.readFileSync(path.join(routing, 'proxy-dashboard.html'), 'utf8').replace(/\r\n/g, '\n');
const origin = 'http://tabs-state-fixture.invalid';
const out = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tabs-manager-state-'));
const navStart = html.indexOf('<nav id="main-nav"');
const nav = html.slice(navStart, html.indexOf('</nav>', navStart) + 6);
const modal = html.slice(html.indexOf('  <!-- Tabs Manager Modal'), html.indexOf('  <!-- ═══════════ MAIN'));
const source = html.slice(html.indexOf('// ═══════════════════ Tabs Manager'), html.indexOf('// ═══════════════════ Универсальный auto-refresh'));
const escSource = html.match(/^const esc = .*$/m)[0];
const fixture = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
:root{--color-bg:#0b0e13;--color-surface:#131922;--color-elevated:#1a212b;--color-line:#2c3339;--color-line-soft:#242c35;--color-ink:#e8ebee;--color-muted:#c9d1d9;--color-emerald:#3ddc91;--color-violet:#b69cff}
body{margin:0;background:var(--color-bg);color:var(--color-ink);font:14px system-ui,sans-serif}.hidden{display:none}#main-nav{width:250px}#main-nav>button{display:block}.hidden#main-nav>button,#main-nav>button.hidden,#main-nav>div.hidden{display:none}
</style></head><body><button id="fixture-open" onclick="openTabsManager()">Настроить вкладки</button>${nav}${modal}<script>
window.__calls={refresh:0,routes:0,tabs:[],writes:[],removes:[]};
const setItem=Storage.prototype.setItem,removeItem=Storage.prototype.removeItem;
Storage.prototype.setItem=function(k,v){if(k==='dashboard-tabs-config-v1')__calls.writes.push(JSON.parse(v));return setItem.call(this,k,v)};
Storage.prototype.removeItem=function(k){if(k==='dashboard-tabs-config-v1')__calls.removes.push(k);return removeItem.call(this,k)};
function showTab(name){__calls.tabs.push(name);localStorage.setItem('opencode_active_tab',name)}
function refreshNavCounts(){__calls.refresh++}
async function loadRoutes(){__calls.routes++}
${escSource}
${source}
applyTabsConfig();
</script></body></html>`;
const tests = [];
const test = (name, run) => tests.push({ name, run });
const rows = async (page, column) => page.locator('#tabs-manager-' + column + ' > li[data-tab]').evaluateAll(items => items.map(li => li.dataset.tab));
const config = page => page.evaluate(() => localStorage.getItem('dashboard-tabs-config-v1'));
const calls = page => page.evaluate(() => JSON.parse(JSON.stringify(__calls)));

async function scene(browser, options = {}) {
    const context = await browser.newContext({ viewport: { width: options.width || 1440, height: 900 }, hasTouch: !!options.touch, serviceWorkers: 'block' });
    const blocked = [], errors = [];
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
        blocked.push(route.request().url());
        return route.abort('blockedbyclient');
    });
    if (options.cfg !== undefined) await context.addInitScript(cfg => {
        if (!sessionStorage.getItem('tabs-state-seeded')) {
            localStorage.setItem('dashboard-tabs-config-v1', JSON.stringify(cfg));
            sessionStorage.setItem('tabs-state-seeded', '1');
        }
    }, options.cfg);
    if (options.active) await context.addInitScript(active => localStorage.setItem('opencode_active_tab', active), options.active);
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/', { waitUntil: 'load' });
    if (options.sortable) await page.addScriptTag({ path: path.join(routing, 'vendor', 'sortable-1.15.6.min.js') });
    await page.locator('#fixture-open').click();
    return { context, page, blocked, errors };
}

test('opening exposes visible/hidden columns without writing config', async browser => {
    const s = await scene(browser);
    try {
        const { page } = s;
        assert.equal(await page.locator('#tabs-manager-visible').count(), 1, 'Видимые needs a real list/drop target');
        assert.equal(await page.locator('#tabs-manager-hidden').count(), 1, 'Скрытые needs a real list/drop target');
        assert.ok((await rows(page, 'visible')).includes('fin'));
        assert.ok((await rows(page, 'hidden')).includes('whoami'));
        assert.ok((await rows(page, 'hidden')).includes('memory'));
        assert.equal(await page.locator('#tabs-manager [onclick^="toggleTabHidden"]').count(), 0, 'no monkey visibility buttons');
        assert.equal(await page.locator('#tabs-manager li[data-tab="notion"]').count(), 0, 'children of extra sections are not ordinary tabs');
        assert.equal(await config(page), null, 'opening leaves fresh defaults unmaterialized');
        assert.equal((await calls(page)).writes.length, 0);
        await page.locator('#tabs-manager button').filter({ hasText: 'Готово' }).click();
        assert.equal(await config(page), null, 'closing is read-only');
        assert.deepEqual(s.errors, []);
        assert.deepEqual(s.blocked, []);
    } finally { await s.context.close(); }
});

test('native drop transfers and persists current state without losing unknown IDs', async browser => {
    const saved = { order: ['fin', 'league', 'future-order'], hidden: ['claude', 'future-hidden'], shown: ['future-section'] };
    const s = await scene(browser, { cfg: saved, active: 'health' });
    try {
        const { page } = s;
        const transfer = await page.evaluate(() => {
            const row = document.querySelector('#tabs-manager-visible li[data-tab="league"]');
            const dt = new DataTransfer();
            row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            const target = document.getElementById('tabs-manager-hidden');
            target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: 9999 }));
            row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return { draggable: row.draggable, payload: dt.getData('text/plain') };
        });
        assert.equal(transfer.draggable, true, 'native fallback must expose draggable rows');
        assert.equal(transfer.payload, 'league', 'dragstart sets an actual dataTransfer payload');
        assert.ok((await rows(page, 'hidden')).includes('league'), 'drop moves the actual row to hidden');
        const state = JSON.parse(await config(page));
        assert.ok(state.hidden.includes('league'));
        assert.ok(state.hidden.includes('future-hidden'), 'unknown saved hidden IDs survive');
        assert.ok(state.order.includes('future-order'), 'unknown saved order IDs survive');
        assert.ok(state.shown.includes('future-section'), 'unknown saved shown IDs survive');
        const visible = await rows(page, 'visible');
        const known = await page.evaluate(() => getMainNavButtons().map(b => b.dataset.tab));
        assert.deepEqual(state.order.filter(id => visible.includes(id)), visible.filter(id => known.includes(id)), 'explicit saved order follows the left column');
        const after = await calls(page);
        assert.equal(after.writes.length, 1, 'only a completed drop writes once');
        assert.equal(after.refresh, 1);
        assert.equal(after.routes, 1);
        assert.deepEqual(after.tabs, [], 'transfer does not activate a provider');
        await page.reload({ waitUntil: 'load' });
        await page.locator('#fixture-open').click();
        assert.ok((await rows(page, 'hidden')).includes('league'), 'visibility survives reload');
        assert.deepEqual(s.errors, []);
        assert.deepEqual(s.blocked, []);
    } finally { await s.context.close(); }
});

test('native cancelled and no-op drops leave fresh defaults and listeners intact', async browser => {
    const s = await scene(browser);
    try {
        const { page } = s;
        const initial = await rows(page, 'visible');
        const outcome = await page.evaluate(() => {
            const row = document.querySelector('#tabs-manager-visible li[data-tab="fin"]');
            const transfer = new DataTransfer();
            row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
            row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
            const untouched = localStorage.getItem('dashboard-tabs-config-v1');
            row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
            const box = row.getBoundingClientRect();
            row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: box.top + 5 }));
            row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
            return untouched;
        });
        assert.equal(outcome, null, 'dragend without drop never writes');
        assert.deepEqual(await rows(page, 'visible'), initial);
        assert.equal(await config(page), null, 'successful same-position drop also never writes');
        assert.equal((await calls(page)).writes.length, 0);
        assert.equal((await calls(page)).refresh, 0);
        assert.equal((await calls(page)).routes, 0);
        assert.deepEqual(s.errors, []);
    } finally { await s.context.close(); }
});

test('keyboard move previews, cancels and commits with focus and announcements', async browser => {
    const s = await scene(browser);
    try {
        const { page } = s;
        const fin = page.locator('#tabs-manager li[data-tab="fin"] .tabs-manager-handle');
        const initial = await rows(page, 'visible');
        await fin.focus();
        await fin.press('Space');
        await page.keyboard.press('ArrowRight');
        assert.ok((await rows(page, 'hidden')).includes('fin'), 'picked row previews in the destination column');
        assert.equal(await config(page), null, 'keyboard preview is not persisted');
        assert.match(await page.locator('#tabs-manager-announcement').textContent(), /Скрытые|скрытые/, 'announce destination');
        await page.keyboard.press('Escape');
        assert.deepEqual(await rows(page, 'visible'), initial, 'Escape restores the exact original order');
        assert.equal(await config(page), null, 'cancel does not materialize fresh defaults');
        assert.equal(await page.locator('#tabs-manager').isVisible(), true, 'first Escape cancels a move, not the dialog');
        await fin.press('Space');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Space');
        const reordered = await rows(page, 'visible');
        assert.equal(reordered[1], 'fin', 'arrow + place reorders within visible');
        assert.equal((await calls(page)).writes.length, 1);
        assert.equal((await calls(page)).refresh, 0, 'pure reordering does not fetch providers');
        assert.equal((await calls(page)).routes, 0);
        assert.equal(await page.evaluate(() => document.activeElement.closest('li[data-tab]')?.dataset.tab), 'fin', 'focus survives re-render');
        assert.match(await page.locator('#tabs-manager-announcement').textContent(), /Сохранено|сохранено/, 'announce committed placement');
        await page.keyboard.press('Space');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Space');
        assert.ok(JSON.parse(await config(page)).hidden.includes('fin'));
        assert.equal((await calls(page)).writes.length, 2);
        assert.equal((await calls(page)).refresh, 1);
        assert.equal((await calls(page)).routes, 1);
        assert.deepEqual(s.errors, []);
    } finally { await s.context.close(); }
});

test('Sortable uses real grouped drag and rolls back release outside the columns', async browser => {
    const s = await scene(browser, { sortable: true });
    try {
        const { page } = s;
        assert.equal(await page.evaluate(() => !!document.getElementById('tabs-manager-visible')._sortable), true, 'use existing global SortableJS');
        if (process.env.TABS_STATE_DEBUG) await page.evaluate(() => {
            window.__dragTrace = [];
            for (const list of tabsManagerLists()) for (const key of ['onChoose', 'onStart', 'onEnd', 'onUnchoose']) {
                const callback = list._sortable.option(key);
                list._sortable.option(key, e => { __dragTrace.push({ key, id: e.item?.dataset.tab, mode: tabsManagerMove?.mode, dropped: tabsManagerMove?.dropped }); callback?.(e); });
            }
            for (const key of ['dragstart', 'dragend', 'pointerup', 'mouseup']) document.addEventListener(key, e => __dragTrace.push({ key, target: e.target.className, hit: document.elementFromPoint(e.clientX, e.clientY)?.outerHTML.slice(0, 200) }), true);
        });
        async function drag(selector, end) {
            const box = await page.locator(selector).boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2, { steps: 5 });
            await page.waitForTimeout(80);
            await page.mouse.move(end.x, end.y, { steps: 15 });
            await page.waitForTimeout(220);
        }
        const hiddenBox = await page.locator('#tabs-manager-hidden').boundingBox();
        await drag('#tabs-manager-visible li[data-tab="fin"] .tabs-manager-handle', { x: hiddenBox.x + 60, y: hiddenBox.y + 24 });
        await page.mouse.up();
        if (process.env.TABS_STATE_DEBUG) {
            console.log(JSON.stringify(await page.evaluate(() => ({ trace: __dragTrace, state: tabsManagerSnapshot(), move: tabsManagerMove && { mode: tabsManagerMove.mode, dropped: tabsManagerMove.dropped }, calls: __calls })), null, 2));
            await page.screenshot({ path: path.join(out, 'sortable-debug.png') });
        }
        assert.ok((await rows(page, 'hidden')).includes('fin'), 'a grouped mouse drop transfers columns');
        assert.equal((await calls(page)).writes.length, 1);
        const beforeCancel = await config(page);
        const initial = await rows(page, 'visible');
        await drag('#tabs-manager-visible li[data-tab="league"] .tabs-manager-handle', { x: hiddenBox.x + 60, y: hiddenBox.y + 24 });
        await page.mouse.move(5, 5, { steps: 15 });
        await page.mouse.up();
        assert.equal(await config(page), beforeCancel, 'release outside is a cancelled transaction');
        assert.deepEqual(await rows(page, 'visible'), initial, 'cancel restores the pre-drag DOM');
        await page.evaluate(() => {
            const list = document.getElementById('tabs-manager-visible');
            const row = list.querySelector('li[data-tab]');
            list._sortable.option('onChoose')({ item: row });
            list._sortable.option('onStart')({ item: row });
            list._sortable.option('onEnd')({ item: row, from: list, to: list, oldIndex: 0, newIndex: 0 });
        });
        assert.equal((await calls(page)).writes.length, 1, 'Sortable no-op end does not write');
        assert.deepEqual(s.errors, []);
    } finally { await s.context.close(); }
});

test('touch fallback transfers after deliberate hold and ignores scrolling gestures', async browser => {
    const s = await scene(browser, { width: 393, touch: true });
    try {
        const { page } = s;
        const session = await s.context.newCDPSession(page);
        const visible = page.locator('#tabs-manager-visible');
        const handle = page.locator('#tabs-manager-visible li[data-tab="fin"] .tabs-manager-handle');
        const box = await handle.boundingBox();
        const dest = await page.locator('#tabs-manager-hidden').boundingBox();
        const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const end = { x: dest.x + dest.width / 2, y: dest.y + 30 };
        const send = (type, point) => session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
        await send('touchStart', start);
        await page.waitForTimeout(320);
        for (let i = 1; i <= 10; i++) await send('touchMove', { x: start.x + (end.x - start.x) * i / 10, y: start.y + (end.y - start.y) * i / 10 });
        await page.waitForTimeout(120);
        await send('touchEnd');
        assert.ok((await rows(page, 'hidden')).includes('fin'), 'touch drop moves a held row to the right column');
        assert.equal((await calls(page)).writes.length, 1);
        const saved = await config(page);
        const label = await page.locator('#tabs-manager-visible li[data-tab="league"] .tabs-manager-label').boundingBox();
        const textStart = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
        await send('touchStart', textStart);
        await send('touchMove', { x: textStart.x, y: textStart.y - 60 });
        await send('touchEnd');
        assert.equal(await config(page), saved, 'scrolling the row text must not commit a move');
        const a = await visible.boundingBox(), b = await page.locator('#tabs-manager-hidden').boundingBox();
        assert.ok(a.x >= 0 && a.x + a.width <= b.x && b.x + b.width <= 393, 'both columns fit at mobile393');
        assert.ok(a.height >= 140 && b.height >= 140, 'empty/drop targets keep a useful minimum height');
        await page.screenshot({ path: path.join(out, 'touch-fallback-393.png') });
        assert.deepEqual(s.errors, []);
        assert.deepEqual(s.blocked, []);
    } finally { await s.context.close(); }
});

test('global Sortable touch separates hold-and-drag from quick handle scrolling', async browser => {
    const s = await scene(browser, { width: 393, touch: true, sortable: true });
    try {
        const { page } = s;
        const session = await s.context.newCDPSession(page);
        const send = (type, point) => session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
        const box = await page.locator('#tabs-manager-visible li[data-tab="fin"] .tabs-manager-handle').boundingBox();
        const dest = await page.locator('#tabs-manager-hidden').boundingBox();
        const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const end = { x: dest.x + dest.width / 2, y: dest.y + 28 };
        await send('touchStart', start);
        await page.waitForTimeout(320);
        for (let i = 1; i <= 12; i++) {
            await send('touchMove', { x: start.x + (end.x - start.x) * i / 12, y: start.y + (end.y - start.y) * i / 12 });
            await page.waitForTimeout(25);
        }
        await page.waitForTimeout(200);
        await send('touchEnd');
        assert.ok((await rows(page, 'hidden')).includes('fin'), 'real Sortable touch transfers after the hold');
        assert.equal((await calls(page)).writes.length, 1);
        const saved = await config(page);
        const next = await page.locator('#tabs-manager-visible li[data-tab="league"] .tabs-manager-handle').boundingBox();
        const p = { x: next.x + next.width / 2, y: next.y + next.height / 2 };
        await send('touchStart', p);
        await send('touchMove', { x: p.x, y: p.y - 65 });
        await page.waitForTimeout(320);
        await send('touchEnd');
        assert.equal(await config(page), saved, 'quick swipe on the handle cancels the delayed drag');
        assert.equal((await calls(page)).writes.length, 1);
        await page.screenshot({ path: path.join(out, 'touch-sortable-393.png') });
        assert.deepEqual(s.errors, []);
    } finally { await s.context.close(); }
});

test('touch cross-column preview follows the final placement after crossing lists', async browser => {
    const s = await scene(browser, { width: 393, touch: true });
    try {
        const { page } = s;
        const session = await s.context.newCDPSession(page);
        const box = await page.locator('#tabs-manager-visible li[data-tab="fin"] .tabs-manager-handle').boundingBox();
        const dest = await page.locator('#tabs-manager-hidden').boundingBox();

        const send = (type, point) => session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
        const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await send('touchStart', start);
        await page.waitForTimeout(320);
        for (let i = 1; i <= 10; i++) await send('touchMove', { x: start.x + (dest.x + 60 - start.x) * i / 10, y: start.y });
        const anchor = await page.locator('#tabs-manager-hidden li[data-tab="vyceai"]').boundingBox();
        await send('touchMove', { x: dest.x + 60, y: anchor.y + anchor.height - 3 });
        await send('touchEnd');
        const hidden = await rows(page, 'hidden');
        assert.ok(hidden.indexOf('fin') > hidden.indexOf('vyceai'), 'continued touch motion after crossing must place at the final row, not the first crossed target');
        assert.equal((await calls(page)).writes.length, 1);
        assert.deepEqual(s.errors, []);
    } finally { await s.context.close(); }
});

test('reordering preserves saved hidden identifiers and sections remain after tabs', async browser => {
    const s = await scene(browser, { cfg: { order: ['fin', 'league'], hidden: ['claude', 'future-hidden'], shown: [] } });
    try {
        const { page } = s;
        await page.locator('#tabs-manager li[data-tab="league"] .tabs-manager-handle').focus();
        await page.keyboard.press('Space');
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Space');
        assert.deepEqual(JSON.parse(await config(page)).hidden, ['claude', 'future-hidden'], 'ordinary reordering preserves exact saved hidden order and does not materialize EXTRA_NAV IDs');
        await page.locator('#tabs-manager li[data-tab="memory"] .tabs-manager-handle').focus();
        await page.keyboard.press('Space');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Space');
        const position = await page.evaluate(() => {
            const nav = document.getElementById('main-nav');
            const children = Array.from(nav.children);
            return { section: children.indexOf(nav.querySelector(':scope > [data-extra-nav="memory"]')), lastTab: Math.max(...getMainNavButtons().map(b => children.indexOf(b))) };
        });
        assert.ok(position.section > position.lastTab, 'shown EXTRA_NAV keeps its separate sidebar footer position');
        await page.reload({ waitUntil: 'load' });
        const restoredPosition = await page.evaluate(() => {
            const nav = document.getElementById('main-nav');
            const children = Array.from(nav.children);
            return { section: children.indexOf(nav.querySelector(':scope > [data-extra-nav="memory"]')), lastTab: Math.max(...getMainNavButtons().map(b => children.indexOf(b))) };
        });
        assert.ok(restoredPosition.section > restoredPosition.lastTab, 'EXTRA_NAV bottom position also survives normal apply on F5');
        assert.deepEqual(s.errors, []);
    } finally { await s.context.close(); }
});

test('mouse Escape cancels Sortable preview even when focus remains outside dialog', async browser => {
    const s = await scene(browser, { sortable: true });
    try {
        const { page } = s;
        const initial = await rows(page, 'visible');
        await page.locator('#fixture-open').focus();
        const box = await page.locator('#tabs-manager-visible li[data-tab="league"] .tabs-manager-handle').boundingBox();
        const dest = await page.locator('#tabs-manager-hidden').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2, { steps: 5 });
        await page.waitForTimeout(90);
        await page.mouse.move(dest.x + 50, dest.y + 24, { steps: 15 });
        await page.waitForTimeout(220);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        assert.deepEqual(await rows(page, 'visible'), initial, 'global Escape restores exact preview state');
        assert.equal(await config(page), null);
        assert.equal((await calls(page)).writes.length, 0);
        assert.deepEqual(s.errors, []);
    } finally { await s.context.close(); }
});

test('sections retain separate shown semantics across repeated transfer and reload', async browser => {
    const s = await scene(browser, { cfg: { order: ['fin', 'future-id'], hidden: ['future-hidden'], shown: ['future-section'] } });
    try {
        const { page } = s;
        const memory = page.locator('#tabs-manager li[data-tab="memory"] .tabs-manager-handle');
        await memory.focus();
        await memory.press('Space');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Space');
        assert.ok(JSON.parse(await config(page)).shown.includes('memory'));
        assert.equal(await page.locator('#main-nav > div[data-extra-nav="memory"]').evaluate(node => node.classList.contains('hidden')), false);
        assert.equal(await page.locator('#tabs-manager li[data-tab="notion"]').count(), 0);
        await page.keyboard.press('Space');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Space');
        const saved = JSON.parse(await config(page));
        assert.ok(!saved.shown.includes('memory'), 'hiding removes the known section from shown');
        assert.ok(saved.shown.includes('future-section'));
        assert.ok(saved.order.includes('future-id'));
        assert.ok(saved.hidden.includes('future-hidden'));
        await page.reload({ waitUntil: 'load' });
        await page.locator('#fixture-open').click();
        assert.ok((await rows(page, 'hidden')).includes('memory'), 'a previously shown section stays hidden after reload');
        assert.deepEqual(s.errors, []);
    } finally { await s.context.close(); }
});

test('empty visible list accepts drop and active-hidden fallback uses its first tab', async browser => {
    const ids = [...nav.matchAll(/<button\b[^>]*data-tab="([^"]+)"/g)].map(m => m[1]).filter(id => !['freemodel', 'truesota', 'xpeach', 'tokenrouter', 'devin', 'notion'].includes(id));
    const s = await scene(browser, { cfg: { order: ['fin', 'league'], hidden: ids, shown: [] }, active: 'fin' });
    try {
        const { page } = s;
        assert.deepEqual(await rows(page, 'visible'), [], 'all-hidden is representable without selecting an unavailable tab');
        assert.equal((await calls(page)).tabs.length, 0);
        const empty = await page.locator('#tabs-manager-visible').boundingBox();
        assert.ok(empty.height >= 140);
        await page.evaluate(() => {
            const row = document.querySelector('#tabs-manager-hidden li[data-tab="league"]');
            const transfer = new DataTransfer();
            row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
            document.getElementById('tabs-manager-visible').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        });
        assert.deepEqual(await rows(page, 'visible'), ['league'], 'drop into the empty left list restores navigation');
        assert.equal(await page.evaluate(() => localStorage.getItem('opencode_active_tab')), 'league', 'hidden active falls back to first visible');
        assert.deepEqual((await calls(page)).tabs, ['league']);
        assert.equal((await calls(page)).writes.length, 1);
        await page.locator('#tabs-manager .tabs-manager-done').click();
        await page.locator('#fixture-open').click();
        assert.deepEqual(await rows(page, 'visible'), ['league'], 'all-hidden remains recoverable through the independent configure entry');
        assert.deepEqual(s.errors, []);
    } finally { await s.context.close(); }
});

test('reset requires confirmation and leaves defaults unwritten after acceptance', async browser => {
    const s = await scene(browser, { cfg: { order: ['league', 'fin'], hidden: ['fin', 'future-hidden'], shown: ['memory'] } });
    try {
        const { page } = s;
        const before = await config(page);
        page.once('dialog', d => d.dismiss());
        await page.locator('#tabs-manager .tabs-manager-reset').click();
        assert.equal(await config(page), before, 'declining reset changes nothing');
        assert.equal((await calls(page)).removes.length, 0);
        page.once('dialog', d => d.accept());
        await page.locator('#tabs-manager .tabs-manager-reset').click();
        assert.equal(await config(page), null, 'acceptance removes existing config, not materializing defaults');
        assert.equal((await calls(page)).removes.length, 1);
        assert.equal((await calls(page)).writes.length, 0);
        assert.equal((await rows(page, 'visible'))[0], 'fin');
        assert.ok((await rows(page, 'hidden')).includes('memory'));
        assert.equal((await calls(page)).refresh, 1);
        assert.equal((await calls(page)).routes, 1);
        assert.deepEqual(s.errors, []);
    } finally { await s.context.close(); }
});

test('dialog traps focus, restores opener and closes only after cancelling a pick', async browser => {
    const s = await scene(browser);
    try {
        const { page } = s;
        assert.equal(await page.evaluate(() => document.activeElement.closest('#tabs-manager')?.id), 'tabs-manager', 'opening places focus in the dialog');
        await page.locator('#tabs-manager .tabs-manager-done').focus();
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.closest('#tabs-manager')?.id), 'tabs-manager', 'Tab cannot leave the modal');
        await page.locator('#tabs-manager-visible li[data-tab="fin"] .tabs-manager-handle').focus();
        await page.keyboard.press('Space');
        await page.keyboard.press('ArrowRight');
        await page.locator('#tabs-manager .tabs-manager-close').focus();
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#tabs-manager').isVisible(), true, 'Escape from any modal control cancels first');
        assert.ok((await rows(page, 'visible')).includes('fin'));
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#tabs-manager').isVisible(), false, 'idle Escape closes');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'fixture-open', 'close restores the actual opener');
        assert.equal(await config(page), null);
        assert.deepEqual(s.errors, []);
    } finally { await s.context.close(); }
});

(async () => {
    let compiled = 0;
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/\bsrc\s*=|type\s*=\s*["'](?:application\/json|importmap|text\/plain)["']/i.test(match[1]) || !match[2].trim()) continue;
        new vm.Script(match[2], { filename: 'proxy-dashboard-inline-' + (++compiled) });
    }
    console.log('PASS compile full dashboard: ' + compiled + ' inline scripts');
    const browser = await chromium.launch({ headless: true });
    const results = [];
    try {
        for (const t of tests) {
            try { await t.run(browser); results.push({ name: t.name, pass: true }); console.log('PASS ' + t.name); }
            catch (e) { results.push({ name: t.name, pass: false, error: e.stack }); console.error('FAIL ' + t.name + '\n' + e.message); }
        }
    } finally { await browser.close(); }
    const failed = results.filter(r => !r.pass).length;
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ compiled, results, scope: 'actual Tabs Manager source/DOM, isolated storage and no provider network' }, null, 2) + '\n');
    console.log('check-tabs-manager-state: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
    console.log('evidence: ' + out);
    process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
