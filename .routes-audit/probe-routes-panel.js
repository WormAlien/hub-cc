'use strict';
// Проба вкладки «Маршруты»: меряет живой дашборд через стенд — Tailwind отдаётся с диска,
// поэтому вёрстка настоящая, а не «страница без утилит». Проверяет ровно то, на что
// жаловался владелец в черновике: текст влезает целиком, колонки не разъезжаются по
// строкам, gpt-тира нет, ручка и кнопка копирования на месте.
//
// Запуск:  node .routes-audit/routes-harness.js   (в соседнем окне)
//          node .routes-audit/probe-routes-panel.js
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8399/';
let failed = 0;
const ok = (name, cond, extra = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);
};

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    // 🪤 `networkidle` здесь НЕ наступает: дашборд опрашивает сервер постоянно, и ожидание
    // повисло бы до таймаута. Готовность вёрстки — это снятый анти-FOUC-гейт `tw-boot`
    // (proxy-dashboard.html:32, Tailwind собирается в браузере); пока класс на месте,
    // body `visibility:hidden` и клик по кнопке вкладки Playwright выполнить не сможет.
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => !document.documentElement.classList.contains('tw-boot'), null, { timeout: 15000 });
    await page.click('#main-nav > button[data-tab="routes"]');
    await page.waitForSelector('#routes-rows .rt-row', { timeout: 8000 });

    const m = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#routes-rows .rt-row')];
        const col = t => rows.map(r => r.querySelector(`select[data-tier="${t}"]`)).filter(Boolean)
            .map(s => {
                const b = s.getBoundingClientRect();
                return { x: Math.round(b.x), w: Math.round(b.width), clip: s.scrollWidth > s.clientWidth + 1 };
            });
        return {
            box: document.getElementById('routes-box').clientWidth,
            rows: rows.length,
            withMap: rows.filter(r => r.querySelector('select')).length,
            col: { default: col('default'), opus: col('opus'), sonnet: col('sonnet'), haiku: col('haiku') },
            hasGpt: rows.some(r => r.querySelector('select[data-tier="gpt"]')),
            grips: rows.filter(r => r.querySelector('.rt-grip')).length,
            copies: rows.map(r => (r.querySelector('.rt-copy') || {}).textContent || '')
                .filter(t => t.trim() === 'Скопировать').length,
            badges: rows.map(r => (r.querySelector('.rt-badge') || {}).textContent || '').filter(Boolean),
        };
    });
    console.log('замер:', JSON.stringify(m));

    const tiers = ['default', 'opus', 'sonnet', 'haiku'];
    ok('карточки отрисованы', m.rows > 0, `rows=${m.rows}, box=${m.box}px`);
    ok('у каждой карточки ручка', m.grips === m.rows, `${m.grips}/${m.rows}`);
    ok('колонки не разъезжаются по строкам', tiers.every(t => new Set(m.col[t].map(c => c.x)).size <= 1));
    ok('ширина колонок одинаковая', tiers.every(t => new Set(m.col[t].map(c => c.w)).size <= 1));
    ok('текст моделей не обрезан', tiers.every(t => m.col[t].every(c => !c.clip)));
    ok('селект влезает в длинное имя каталога', m.col.default.every(c => c.w >= 203),
        `w=${m.col.default.map(c => c.w).join(',')}`);
    ok('gpt-тира на вкладке нет', !m.hasGpt);
    ok('кнопка «Скопировать» в каждой редактируемой', m.copies === m.withMap, `${m.copies}/${m.withMap}`);
    ok('бейдж команды без физической модели', m.badges.every(b => /^\/model [a-z0-9_-]+$/i.test(b.trim())),
        m.badges.join(' '));

    await browser.close();
    console.log(failed ? `\n${failed} провалов` : '\nвсё зелёное');
    process.exit(failed ? 1 : 0);
})();
