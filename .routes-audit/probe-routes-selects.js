'use strict';
// Живой замер вкладки «Маршруты» на боевом :8200: что реально стоит в селектах тиров.
// Свой профиль (chromium.launch), окно владельца не трогается.
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto('http://127.0.0.1:8200/', { waitUntil: 'domcontentloaded' });
    // Анти-FOUC-гейт: пока класс на месте, body скрыт и клик по вкладке не пройдёт.
    await page.waitForFunction(() => !document.documentElement.classList.contains('tw-boot'), null, { timeout: 20000 });
    await page.click('#main-nav > button[data-tab="routes"]');
    await page.waitForSelector('#routes-rows .rt-row', { timeout: 10000 });
    await page.waitForTimeout(6000);            // каталоги подгружаются после отрисовки

    const rows = await page.evaluate(() => {
        const out = [];
        for (const r of document.querySelectorAll('#routes-rows .rt-row')) {
            const name = r.dataset.provider;
            const tiers = {};
            for (const sel of r.querySelectorAll('select[data-tier]')) {
                tiers[sel.dataset.tier] = {
                    value: sel.value,
                    selected: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : null,
                    opts: sel.options.length,
                    list: [...sel.options].map(o => o.value).filter(Boolean),
                    title: sel.title || '',
                    unconf: sel.classList.contains('rt-unconf'),
                };
            }
            out.push({ name, off: r.dataset.off, tiers });
        }
        return out;
    });

    for (const r of rows) {
        console.log(`\n=== ${r.name}  (data-off=${r.off})`);
        for (const [t, s] of Object.entries(r.tiers)) {
            console.log(`   ${t.padEnd(8)} стоит «${s.value}»  опций=${s.opts}${s.unconf ? '  ⚠ НЕ ПОДТВЕРЖДЕНА' : ''}`);
            if (s.opts <= 30) console.log(`            ${s.list.join(', ') || '—'}`);
            if (s.title) console.log(`            tooltip: ${s.title}`);
        }
    }
    // Ошибки в консоли — признак сломанной разметки.
    await browser.close();
})().catch(e => { console.error('проба упала:', e.message); process.exit(1); });
