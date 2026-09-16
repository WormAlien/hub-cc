'use strict';
// Проба «Маршрутов» на ЖИВОМ дашборде: открывает :8200, жмёт вкладку и слушает консоль.
// Отвечает на один вопрос - что именно ломает рендер вкладки сейчас.
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8200/';

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.documentElement.classList.contains('tw-boot'), null, { timeout: 20000 });
    await page.click('#main-nav > button[data-tab="routes"]');
    await page.waitForTimeout(3000);

    const state = await page.evaluate(() => {
        const box = document.getElementById('routes-box');
        const rows = [...document.querySelectorAll('#routes-rows .rt-row')];
        return {
            boxText: (box ? box.innerText : '<нет #routes-box>').slice(0, 300),
            rows: rows.length,
            selCount: document.querySelectorAll('#routes-rows select.rt-sel').length,
            banner: (document.querySelector('#routes-box .text-amber') || {}).innerText || '',
            html: (box ? box.innerHTML : '').slice(0, 200),
            perRow: rows.map(r => ({
                p: r.dataset.provider,
                off: r.dataset.off,
                tiers: [...r.querySelectorAll('select.rt-sel')].map(s => s.dataset.tier + '=' + (s.value || '—')),
                opts: [...new Set([...r.querySelectorAll('select.rt-sel')].map(s => s.options.length))],
                cmd: (r.querySelector('.rt-badge') || {}).textContent || '',
            })),
        };
    });
    console.log('СОСТОЯНИЕ:', JSON.stringify(state, null, 2));

    // ── Клик по селекту тира НАСТОЯЩЕЙ мышью ────────────────────────────────
    // 🪤 Проект уже ловил здесь баг: Sortable с `preventOnFilter: true` гасил
    // `pointerdown`, из-за чего нативный список не открывался, а `click` оставался живым —
    // проба обязана требовать именно рождение `mousedown`, а не «элемент в DOM есть».
    await page.evaluate(() => {
        window.__clicks = [];
        for (const t of ['pointerdown', 'mousedown']) {
            document.addEventListener(t, e => {
                window.__clicks.push({ t, on: (e.target.closest && e.target.closest('select.rt-sel')) ? 1 : 0,
                                       prevented: e.defaultPrevented });
            }, true);
        }
    });
    const sel = page.locator('#routes-rows select.rt-sel').first();
    const before = await page.evaluate(() => [...document.querySelectorAll('#routes-rows select.rt-sel')].map(s => s.value));
    const bb = await sel.boundingBox();
    if (bb) {
        // 🪤 Отпускаем кнопку В СТОРОНЕ от селекта: полный клик по нативному списку
        // может зафиксировать вариант и уйти в POST на диск. Замеру нужен только
        // `pointerdown`/`mousedown`, а он рождается на нажатии.
        await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(150);
        await page.mouse.move(5, 5);
        await page.mouse.up();
    }
    await page.keyboard.press('Escape');
    const after = await page.evaluate(() => [...document.querySelectorAll('#routes-rows select.rt-sel')].map(s => s.value));
    const clicks = await page.evaluate(() => window.__clicks.filter(c => c.on));
    const pd = clicks.find(c => c.t === 'pointerdown');
    const md = clicks.find(c => c.t === 'mousedown');
    console.log('КЛИК ПО СЕЛЕКТУ:', JSON.stringify({ pointerdown: pd || null, mousedown: md || null }));
    console.log(pd && !pd.prevented && md ? '  ✅ pointerdown не погашен, mousedown родился' : '  ❌ клик по селекту сломан');
    console.log(before.join('|') === after.join('|') ? '  ✅ ни один тир не изменился (запись на диск не тронута)' : '  ⚠ значения поехали: ' + JSON.stringify({ before, after }));

    console.log('\nОШИБКИ (' + errors.length + '):');
    for (const e of [...new Set(errors)]) console.log('  ' + e);
    await browser.close();
})();
