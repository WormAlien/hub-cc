'use strict';
// Проба-измерение: доходит ли НАСТОЯЩИЙ клик до селекта тира, и не гасит ли кто-то
// default у pointerdown/mousedown. Работает ТОЛЬКО на чтение: ничего не выбирает,
// ничего не сохраняет — на живом :8200 запускать безопасно.
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8200/';

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => !document.documentElement.classList.contains('tw-boot'), null, { timeout: 15000 });
    await page.click('#main-nav > button[data-tab="routes"]');
    await page.waitForSelector('#routes-rows .rt-row select[data-tier="default"]', { timeout: 15000 });
    await page.waitForTimeout(1500);

    // Слушатели-зонды. capture на window срабатывает ПЕРВЫМ, bubble на window — ПОСЛЕДНИМ,
    // поэтому пара даёт точный ответ: кто-то по пути погасил default или нет.
    await page.evaluate(() => {
        window.__probe = [];
        const note = (phase) => (e) => {
            window.__probe.push({
                phase, type: e.type,
                target: e.target.tagName + (e.target.dataset && e.target.dataset.tier ? ':' + e.target.dataset.tier : ''),
                prevented: e.defaultPrevented,
                cancelable: e.cancelable,
            });
        };
        for (const t of ['pointerdown', 'mousedown', 'click']) {
            window.addEventListener(t, note('capture'), true);
            window.addEventListener(t, note('bubble'), false);
        }
    });

    const sel = await page.$('#routes-rows .rt-row select[data-tier="default"]');
    const before = await page.evaluate(() => {
        const s = document.querySelector('#routes-rows .rt-row select[data-tier="default"]');
        window.__sameNode = s;
        const r = s.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                 top: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === s };
    });
    console.log('селект в центре точки — верхний элемент:', before.top);

    // Настоящий ввод: настоящий клик по координатам, не elementHandle.click().
    await page.mouse.move(before.x, before.y);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(400);

    const after = await page.evaluate(() => ({
        events: window.__probe,
        nodeStillInDom: document.contains(window.__sameNode),
        active: document.activeElement ? document.activeElement.tagName : null,
    }));
    console.log('\n--- события настоящего клика ---');
    for (const e of after.events) {
        console.log(`${e.phase.padEnd(8)} ${e.type.padEnd(12)} target=${e.target.padEnd(18)} defaultPrevented=${e.prevented} cancelable=${e.cancelable}`);
    }
    const md = after.events.find(e => e.type === 'pointerdown' && e.phase === 'bubble');
    const mm = after.events.find(e => e.type === 'mousedown' && e.phase === 'bubble');
    console.log('\n--- вердикт ---');
    console.log('pointerdown погашен:', md ? md.prevented : 'событие НЕ дошло вовсе');
    console.log('mousedown   погашен:', mm ? mm.prevented : 'событие НЕ родилось / не дошло');
    console.log('узел селекта ещё в DOM:', after.nodeStillInDom);
    console.log('activeElement:', after.active);
    await browser.close();
})();
