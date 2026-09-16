'use strict';
// Обход ВСЕХ вкладок дашборда: щёлкает по каждой кнопке в навигации и собирает
// pageerror, которые она рождает. Отвечает на вопрос «добавление новых провайдеров
// сломало что-то ещё?» - ровно так 16.09 был найден упавший `routesDropAt`.
//
// Только чтение: жмём навигацию, ничего не сохраняем.
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8200/';

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    let bucket = [];
    page.on('pageerror', e => bucket.push(e.message));
    page.on('console', m => {
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) bucket.push('console: ' + m.text());
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.documentElement.classList.contains('tw-boot'), null, { timeout: 20000 });

    const tabs = await page.$$eval('#main-nav > button[data-tab]',
        bs => bs.map(b => ({ tab: b.dataset.tab, label: (b.querySelector('.flex-1') || {}).textContent || b.dataset.tab })));
    console.log(`вкладок в навигации: ${tabs.length}\n`);

    let bad = 0;
    for (const { tab, label } of tabs) {
        bucket = [];
        try {
            await page.click(`#main-nav > button[data-tab="${tab}"]`);
        } catch (e) {
            console.log(`❌ ${label} (${tab}) — кнопка не нажалась: ${e.message.slice(0, 80)}`);
            bad++;
            continue;
        }
        await page.waitForTimeout(1500);
        const stuck = await page.evaluate(t => {
            const p = document.querySelector(`[data-tab-content="${t}"]`);
            if (!p) return 'нет разметки вкладки';
            const txt = (p.innerText || '').trim();
            if (!txt) return 'пусто';
            if (/^(загружаю|обновляю|loading)[….!]*$/i.test(txt)) return `застряло на «${txt}»`;
            return '';
        }, tab);
        const errs = [...new Set(bucket)];
        if (errs.length || stuck) {
            bad++;
            console.log(`❌ ${label} (${tab})${stuck ? ' — ' + stuck : ''}`);
            for (const e of errs) console.log(`     ${e}`);
        } else {
            console.log(`✅ ${label} (${tab})`);
        }
    }
    await browser.close();
    console.log(bad ? `\n${bad} вкладок с замечаниями` : '\nвсе вкладки чистые');
    process.exit(bad ? 1 : 0);
})();
