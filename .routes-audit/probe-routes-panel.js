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
            nomap: rows.filter(r => !r.querySelector('select')).length,
            nomapMsg: rows.filter(r => !r.querySelector('select'))
                .map(r => r.textContent.includes('тир-карты нет')).filter(Boolean).length,
            // Приглушение ненастроенных — иерархия варианта A: взгляд должен идти туда,
            // где сигнал есть. Один раз это уже потерялось при переносе.
            off: rows.map(r => ({
                p: r.dataset.provider,
                off: r.dataset.off,
                dflt: ((r.querySelector('select[data-tier="default"]') || {}).value || '').trim(),
            })),
            master: rows.length ? Math.round((rows[0].querySelector('select[data-tier="default"]') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width) : 0,
            groups: rows.filter(r => ((r.querySelector('.rt-glab') || {}).textContent || '').trim() === 'сабагенты').length,
            // Шлюз, который не отдаёт каталог (пусто даже на его сайте): строку обязаны
            // наполнять модели из ЕГО ЖЕ обычной тир-карты, иначе выбирать нечего.
            noCatOpts: [...document.querySelectorAll('#routes-rows .rt-row[data-provider="justwoker"] select[data-tier="opus"] option')]
                .map(o => o.value).filter(Boolean),
            // Шлюз без файла активного ключа: каталог берётся по ключу из его сессий, и в тир
            // обязаны попасть только текстовые модели — картинка с `openai` в типах тоже
            // заявляет чат-эндпоинт, но тиром быть не может.
            noKeyOpts: [...document.querySelectorAll('#routes-rows .rt-row[data-provider="aikeysapi"] select[data-tier="opus"] option')]
                .map(o => o.value).filter(Boolean),
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
    ok('карточка без тир-карты читается текстом, без пустых селектов',
        m.nomap > 0 && m.nomapMsg === m.nomap, `nomap=${m.nomap}, с пояснением=${m.nomapMsg}`);
    ok('ненастроенные шлюзы приглушены, настроенные — нет',
        m.off.every(r => (r.dflt ? r.off === '0' : r.off === '1')),
        m.off.map(r => `${r.p}:${r.off}`).join(' '));
    ok('сабагенты сгруппированы под общим заголовком', m.groups === m.withMap, `${m.groups}/${m.withMap}`);
    ok('ручка «окно» крупнее триммеров', m.master > (m.col.opus[0] || {}).w,
        `мастер ${m.master} против триммера ${(m.col.opus[0] || {}).w}`);
    ok('шлюз без каталога наполнен моделями из своей обычной карты',
        m.noCatOpts.includes('gpt-5.6-luna') && m.noCatOpts.length >= 3, m.noCatOpts.join(','));
    ok('без файла ключа каталог берётся из аккаунтов шлюза — только текстовые модели',
        m.noKeyOpts.includes('gpt-5.6-sol') && m.noKeyOpts.includes('gpt-5.6-terra')
        && !m.noKeyOpts.some(v => v.includes('image') || v.includes('video')), m.noKeyOpts.join(','));

    // ── Перестановка ─────────────────────────────────────────────────────────
    const order = () => page.$$eval('#routes-rows .rt-row', rs => rs.map(r => r.dataset.provider));
    const savedOrder = () => page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('routes-order') || '[]'); } catch (e) { return []; }
    });
    const before = await order();
    ok('есть что переставлять', before.length > 1, before.join(','));

    // Мышь: тянем за ручку ПЕРВОЙ карточки ниже середины второй. Sortable на десктопе
    // работает нативным HTML5 drag&drop, поэтому mouse.down + move, а не click.
    const g = await page.$('#routes-rows .rt-row:first-child .rt-grip');
    const t = await page.$('#routes-rows .rt-row:nth-child(2)');
    const gb = await g.boundingBox(), tb = await t.boundingBox();
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height * 0.9, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const afterDrag = await order();
    ok('мышь: карточка едет за ручку', afterDrag.join(',') !== before.join(','),
        `${before.join(',')} → ${afterDrag.join(',')}`);
    // 🪤 Порядок после переноса НЕалфавитный — именно на нём и надо проверять F5: на
    // алфавитном «пережил перезагрузку» проходило бы и со сломанным хранилищем.
    ok('порядок сохранён в localStorage', (await savedOrder()).join(',') === afterDrag.join(','),
        JSON.stringify(await savedOrder()));
    ok('кнопка «По алфавиту» стала видна', await page.isVisible('#routes-reset-order'));

    // F5: порядок обязан пережить перезагрузку — иначе он не «рабочее место», а игрушка.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => !document.documentElement.classList.contains('tw-boot'), null, { timeout: 15000 });
    await page.click('#main-nav > button[data-tab="routes"]');
    await page.waitForSelector('#routes-rows .rt-row', { timeout: 8000 });
    ok('порядок пережил F5', (await order()).join(',') === afterDrag.join(','), (await order()).join(','));
    ok('кнопка сброса видна и после F5', await page.isVisible('#routes-reset-order'));

    // Клавиатура: фокус на ручке первой карточки, стрелка вниз.
    await page.focus('#routes-rows .rt-row:first-child .rt-grip');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(250);
    const afterKey = await order();
    ok('клавиатура ↑↓ меняет порядок', afterKey[1] === afterDrag[0],
        `${afterDrag.join(',')} → ${afterKey.join(',')}`);

    // Сброс: возвращается алфавитный порядок, и хранилище очищается.
    await page.click('#routes-reset-order');
    await page.waitForTimeout(700);
    const afterReset = await order();
    ok('«По алфавиту» вернул исходный порядок', afterReset.join(',') === before.join(','), afterReset.join(','));
    ok('сброс очистил хранилище', (await savedOrder()).length === 0, JSON.stringify(await savedOrder()));

    // ── Автосохранение тира ──────────────────────────────────────────────────
    // Разметку селектов переписали (Task 2), а на ней держится вся запись — проверяем,
    // что смена уходит на сервер и что отказ сервера возвращает прежний выбор.
    const arSel = await page.$('#routes-rows .rt-row[data-provider="agentrouter"] select[data-tier="default"]');
    await arSel.selectOption('claude-opus-5');
    await page.waitForTimeout(600);
    const testSaves = await (await page.request.get(`${URL}__test/saves`)).json();
    ok('смена тира ушла на сервер',
        (testSaves.saves || []).some(s => s.provider === 'agentrouter' && s.tier === 'default' && s.value === 'claude-opus-5'),
        JSON.stringify((testSaves.saves || []).slice(-1)));
    ok('селект остался на новом значении', (await arSel.inputValue()) === 'claude-opus-5');

    const arOpus = await page.$('#routes-rows .rt-row[data-provider="agentrouter"] select[data-tier="opus"]');
    const prevOpus = await arOpus.inputValue();
    await arOpus.selectOption('claude-haiku-4-5-20251001');   // стенд отвечает 400
    await page.waitForTimeout(800);
    ok('отказ сервера откатил выбор', (await arOpus.inputValue()) === prevOpus,
        `${prevOpus} → ${await arOpus.inputValue()}`);

    // Приглушение обязано сниматься сразу после выбора окна, а не после перезагрузки:
    // иначе строка остаётся серой и выбор выглядит несработавшим.
    // 🪤 Проверяем переход В ОБЕ СТОРОНЫ: стенд держит карты в памяти, поэтому «до» зависит
    // от прошлых прогонов — утверждение на абсолютном значении падало со второго запуска.
    const aipmRow = await page.$('#routes-rows .rt-row[data-provider="aipm"]');
    const aipmDef = await page.$('#routes-rows .rt-row[data-provider="aipm"] select[data-tier="default"]');
    await aipmDef.selectOption('');                    // пусто → строка обязана потускнеть
    await page.waitForTimeout(700);
    const offEmpty = await aipmRow.getAttribute('data-off');
    await aipmDef.selectOption('claude-opus-4-6');     // выбрали окно → обязана зажечься
    await page.waitForTimeout(700);
    const offSet = await aipmRow.getAttribute('data-off');
    ok('приглушение переключается сразу за выбором окна (пусто → тускло, выбрано → ярко)',
        offEmpty === '1' && offSet === '0', `пусто: ${offEmpty}, выбрано: ${offSet}`);
    // И селект приглушённой строки не должен быть прозрачным: с прозрачным фоном он
    // читается как подпись, а не как элемент управления.
    // 🪤 Берём строку, которая в стенде ТОЧНО есть и ТОЧНО приглушена, и отдельно требуем,
    // чтобы элемент нашёлся: селектор по несуществующему провайдеру давал ложный PASS.
    const bg = await page.$eval('#routes-rows .rt-row[data-provider="aikeysapi"] .rt-sel',
        el => getComputedStyle(el).backgroundColor);
    ok('у селекта пустой строки есть фон', !!bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg), bg);

    await browser.close();
    console.log(failed ? `\n${failed} провалов` : '\nвсё зелёное');
    process.exit(failed ? 1 : 0);
})();
