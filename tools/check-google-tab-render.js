#!/usr/bin/env node
/**
 * check-google-tab-render.js — приёмка ОТРИСОВКИ вкладки Google: гоняет настоящий стенд
 * (`tools/google-preview.js`) в настоящем Chromium.
 *
 * Зачем отдельный скрипт, если есть `check-google-tab.js`. Тот проверяет шов и ручки, но
 * ничего не говорит о том, как вкладка выглядит и ведёт себя: разметку целиком рисует JS,
 * и половина поломок здесь видна только глазом. Живой `:8200` для этого не годится -
 * второй экземпляр дашборда поднимать нельзя (boot снимет keepalive живого стека), а
 * рестарт делает владелец. Стенд даёт то же самое на своём порту и своём демо-пуле.
 *
 * Что проверяется поведением, а не поиском строк:
 *   · карточки нарисовались, код 2FA совпал с независимым расчётом на node (тот же
 *     RFC 6238, но другая реализация - совпадение ловит ошибку в base32 или в обрезке);
 *   · 🪤 фокус и набранное в поиске НЕ теряются при перерисовке опросом (разметка
 *     пересобирается каждые 15 секунд, и это ровно та поломка, которую не видно в коде);
 *   · 🪤 набранное в форме добавления переживает перерисовку (поля живут в состоянии);
 *   · формы - панель под шапкой, а не всплывающее окно поверх (язык дашборда);
 *   · пачка: предпросмотр до записи, потом запись и рост числа карточек;
 *   · ноль ошибок и предупреждений в консоли, нет горизонтального переполнения.
 *
 * Запуск: node tools/check-google-tab-render.js       (exit 1 = вкладка сломана)
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const PORT = 8397;
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';   // тот же, что в демо-пуле стенда
const PASS = 'demo-pass-personal';

let total = 0;
const fails = [];
function check(cond, msg) {
    total += 1;
    console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) fails.push(msg);
    return !!cond;
}

// Независимый расчёт кода: та же формула, но другая реализация, чем в браузере.
function nodeTotp(secret, at = Date.now()) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = String(secret).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, val = 0;
    const bytes = [];
    for (const ch of clean) {
        val = (val << 5) | A.indexOf(ch);
        bits += 5;
        if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
    const h = crypto.createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
    const o = h[h.length - 1] & 0x0f;
    return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0');
}

(async () => {
    // ── Стенд ─────────────────────────────────────────────────────────────────
    const stand = spawn(process.execPath, [path.join(__dirname, 'google-preview.js'), String(PORT)], {
        cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('стенд не поднялся за 20 с')), 20000);
        stand.stdout.on('data', d => {
            if (String(d).includes('стенд Google')) { clearTimeout(t); resolve(); }
        });
        stand.stderr.on('data', d => process.stderr.write(`[стенд] ${d}`));
        stand.on('exit', c => { clearTimeout(t); reject(new Error(`стенд вышел с кодом ${c}`)); });
    });

    let browser = null;
    const done = (code) => {
        try { if (browser) browser.close(); } catch { /* уже закрыт */ }
        try { stand.kill(); } catch { /* уже мёртв */ }
        console.log(fails.length ? `\nпровалено ${fails.length} из ${total}` : `\n${total}/${total} проверок пройдено`);
        process.exit(code);
    };

    try {
        await ready;
        browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
        const consoleBad = [];
        page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleBad.push(`${m.type()}: ${m.text()}`); });
        page.on('pageerror', e => consoleBad.push(`pageerror: ${e.message}`));
        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
        await page.waitForSelector('.gg-card', { timeout: 10000 });

        // ── 1. Шапка и сетка ─────────────────────────────────────────────────
        console.log('\n── 1. Шапка и сетка ──');
        check((await page.locator('.gg-title').innerText()).includes('Google аккаунты'), 'заголовок вкладки на месте');
        check((await page.locator('.gg-sub').innerText()).includes('google/accounts.json'),
            'в подзаголовке виден путь пула');
        const note = await page.locator('.gg-note').first().innerText();
        check(/аккаунтов\s*3/.test(note) && /с 2FA\s*1/.test(note) && /о расходе/.test(note),
            `строка сводки посчитана (${note.replace(/\n/g, ' ').slice(0, 60)}…)`);
        const chips = await page.locator('.gg-chip').allInnerTexts();
        check(chips.some(t => /не проверен/.test(t)) && chips.some(t => /живой/.test(t)),
            `грядка чипов по статусу (${chips.slice(0, 3).join(' / ')}…)`);
        check(chips.some(t => /расходник/.test(t)) && chips.some(t => /личный/.test(t)),
            'вторая грядка чипов - по классу аккаунта (как две грядки у GitHub)');
        check(await page.locator('.gg-card').count() === 3, 'три карточки по демо-пулу');

        // ── 1б. Прокси: селектор из пула, а не вписывание строкой ────────────
        console.log('\n── 1б. Прокси из пула ──');
        const sel = page.locator('.gg-card select').first();
        const opts = await sel.locator('option').allInnerTexts();
        check(await sel.count() === 1 && opts.length > 5,
            `в карточке селектор адресов, а не поле ввода (${opts.length} вариантов)`);
        check(/не привязан/.test(opts[0]), 'первый вариант - «не привязан»');
        const poolNote = await page.locator('.gg-hint-warn').first().innerText();
        check(/не обслуживает|пуст/.test(poolNote), `про хост сказано честно: ${poolNote.slice(0, 70)}…`);

        // ── 2. Код 2FA ───────────────────────────────────────────────────────
        console.log('\n── 2. Код 2FA ──');
        const codeText = await page.locator('.gg-code').first().innerText();
        const shown = codeText.replace(/\s/g, '');
        const expected = nodeTotp(TOTP_SECRET);
        // Пересчитываем, если между двумя расчётами перевалило окно: сверяем смысл, не момент.
        const ok = shown === expected || shown === nodeTotp(TOTP_SECRET) || shown === nodeTotp(TOTP_SECRET, Date.now() + 5000);
        check(/^\d{6}$/.test(shown) && ok, `код совпал с независимым расчётом (браузер ${shown}, node ${expected})`);
        check((await page.locator('.gg-secs').first().innerText()).endsWith('s'), 'счётчик до перевала окна идёт');
        const noTotp = await page.locator('.gg-card').nth(1).locator('.gg-code-none').first().innerText();
        check(/секрета нет/.test(noTotp), 'карточка без секрета говорит об этом словами');

        // ── 2б. Пароль приложения: отдельный хвост строки магазина ───────────
        console.log('\n── 2б. Пароль приложения ──');
        const appCard = page.locator('.gg-card').nth(2);
        // 🪤 Подписи полей в CSS идут `text-transform: uppercase`, поэтому innerText отдаёт
        // их капсом - сравниваем без учёта регистра, иначе проба ломается на оформлении.
        const appLabels = (await appCard.locator('.gg-label').allInnerTexts()).join(' | ').toLowerCase();
        check(appLabels.includes('пароль приложения'), `у третьего демо-аккаунта блок пароля приложения (${appLabels})`);
        const appMasked = await appCard.locator('.gg-val').last().innerText();
        check(!/cmsk/.test(appMasked), `пароль приложения закрыт точками (${appMasked})`);
        await appCard.locator('[title="Показать/скрыть пароль приложения"]').click();
        await page.waitForTimeout(400);
        check((await appCard.locator('.gg-val').last().innerText()) === 'cmskdp4zkeikkncq',
            'глаз открывает пароль приложения (в нём нет ни пробелов, ни смены регистра)');
        const totpOnApp = await appCard.locator('.gg-code').count();
        check(totpOnApp === 0, 'из пароля приложения НЕ собирается живой код 2FA: блок кода у него пуст');

        // ── 3. Секреты по нажатию ────────────────────────────────────────────
        console.log('\n── 3. Секреты ──');
        const card = (i) => page.locator('.gg-card').nth(i);
        check((await card(0).locator('.gg-val').nth(1).innerText()) === '••••••••', 'пароль в карточке закрыт точками');
        await card(0).locator('[title="Показать/скрыть пароль"]').click();
        await page.waitForTimeout(400);
        check((await card(0).locator('.gg-val').nth(1).innerText()) === PASS, 'глаз открывает пароль');
        check((await card(1).locator('.gg-val').nth(1).innerText()) === '••••••••', 'на соседней карточке пароль остался закрыт');

        // ── 4. Перерисовка не должна съедать ввод ────────────────────────────
        console.log('\n── 4. Опрос не съедает ввод ──');
        await page.fill('#gg-search', 'burner');
        await page.locator('#gg-search').focus();
        await page.evaluate(() => GOOGLE.load());          // то же, что делает опрос раз в 15 с
        await page.waitForTimeout(600);
        check(await page.locator('.gg-card').count() === 1, 'поиск фильтрует сетку');
        const searchStill = await page.evaluate(() => {
            const el = document.getElementById('gg-search');
            return { value: el.value, focused: document.activeElement === el };
        });
        check(searchStill.value === 'burner', 'набранное в поиске пережило перерисовку');
        check(searchStill.focused === true, 'фокус в поиске пережил перерисовку');
        await page.fill('#gg-search', '');
        await page.evaluate(() => GOOGLE.setSearch(''));
        await page.waitForTimeout(300);

        // ── 5. Форма добавления: панель, а не окно ───────────────────────────
        console.log('\n── 5. Форма добавления ──');
        await page.locator('button:has-text("Добавить")').click();
        await page.waitForSelector('.gg-panel-add');
        const panelPos = await page.evaluate(() => getComputedStyle(document.querySelector('.gg-panel-add')).position);
        check(panelPos !== 'fixed' && panelPos !== 'absolute', 'форма раскрыта панелью в потоке, а не окном поверх');
        await page.fill('.gg-panel-add input', 'typed@gmail.com');
        await page.evaluate(() => GOOGLE.load());
        await page.waitForTimeout(600);
        const draftKept = await page.locator('.gg-panel-add input').first().inputValue();
        check(draftKept === 'typed@gmail.com', 'набранное в форме пережило перерисовку');
        await page.locator('.gg-panel-add button:has-text("Отмена")').click();

        // ── 6. Импорт пачки ──────────────────────────────────────────────────
        console.log('\n── 6. Импорт пачки ──');
        await page.locator('button:has-text("Импорт")').click();
        await page.waitForSelector('.gg-panel-imp textarea');
        await page.fill('.gg-panel-imp textarea', [
            '↓↓↓↓ Ваш заказ: ↓↓↓↓',
            'batch.one@gmail.com:пароль-один:JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
            'batch.two@gmail.com:пароль-два:reserve.box@mail.ru',
            'https://shop.example/order/9',
            'broken@gmail.com',
        ].join('\n'));
        await page.locator('.gg-panel-imp button:has-text("Проверить")').click();
        // 🪤 Ждём ТЕКСТ, а не селектор: `.gg-preview` есть в панели и до проверки (там
        // подсказка), так что ожидание по селектору проходило бы сразу и проба читала бы
        // подсказку вместо предпросмотра.
        await page.waitForFunction(
            () => /разобрано записей/.test(document.querySelector('.gg-panel-imp').innerText),
            { timeout: 10000 },
        );
        const preview = await page.locator('.gg-panel-imp .gg-preview').innerText();
        check(/разобрано записей: 2/.test(preview), 'предпросмотр разобрал две записи из пяти строк');
        check(/строк с ошибкой: 1/.test(preview) && /broken@gmail\.com/.test(preview), 'строка без пароля показана ошибкой с адресом');
        check(await page.locator('.gg-card').count() === 3, 'до записи число карточек не изменилось');
        await page.locator('.gg-panel-imp button:has-text("Импортировать")').click();
        await page.waitForTimeout(900);
        check(await page.locator('.gg-card').count() === 5, 'запись пачки добавила две карточки');

        // ── 7. Меню и вид ────────────────────────────────────────────────────
        console.log('\n── 7. Меню и вид ──');
        // Привязку прокси проверяем делом: выбираем НАСТОЯЩИЙ адрес из пула и смотрим, что он
        // лёг в запись, а селектор после перерисовки показывает именно его.
        //
        // 🪤 Берём адрес по виду пула (`http://…`), а не по номеру варианта: демо-аккаунт
        // приходит с привязкой `res-fi-01`, которой в пуле нет, - она рисуется отдельным
        // вариантом «адреса нет в пуле», и выбор «второго по счёту» проверял бы сам себя.
        const values = await sel.locator('option').evaluateAll(os => os.map(o => o.value));
        const orphan = values.find(v => v && !/^https?:\/\//.test(v));
        const fromPool = values.find(v => /^https?:\/\//.test(v));
        check(!!orphan, `привязка, которой нет в пуле, показана честно (${orphan})`);
        check(!!fromPool, 'в селекторе есть настоящие адреса пула');
        await sel.selectOption(fromPool);
        await page.waitForTimeout(900);
        const stored = await page.evaluate(() => document.querySelector('.gg-card select').value);
        check(stored === fromPool, `выбранный из пула адрес лёг в запись (${fromPool.slice(0, 34)}…)`);
        await page.locator('.gg-card select').first().selectOption('');
        await page.waitForTimeout(600);
        check(await page.evaluate(() => document.querySelector('.gg-card select').value) === '',
            'привязка снимается обратно на «не привязан»');

        await card(0).locator('button[title="Действия (статус, класс, пароль, заметка, удалить)"]').click();
        await page.waitForSelector('.gg-menu');
        const items = await page.locator('.gg-menu button').allInnerTexts();
        check(items.some(t => /живой/.test(t)) && items.some(t => /Удалить/.test(t)),
            `меню карточки открылось (${items.length} пунктов)`);
        const overflow = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            grid: (() => { const g = document.querySelector('.gg-grid'); return g.scrollWidth > g.clientWidth; })(),
        }));
        check(!overflow.page && !overflow.grid, 'горизонтального переполнения нет');
        const fonts = await page.evaluate(() => {
            const el = document.querySelector('.gg-val');
            return { mono: getComputedStyle(el).fontFamily, title: getComputedStyle(document.querySelector('.gg-title')).fontSize };
        });
        check(/Geist Mono/i.test(fonts.mono), `моноширинный шрифт дашборда подключён (${fonts.mono.split(',')[0]})`);
        check(fonts.title === '24px', `заголовок набран кеглем text-2xl (${fonts.title})`);

        check(consoleBad.length === 0, `консоль чистая${consoleBad.length ? `: ${consoleBad.slice(0, 3).join(' | ')}` : ''}`);

        // ── 8. Широкий экран ────────────────────────────────────────────────
        // 🪤 Панель формы не имеет права растягиваться на всю ширину монитора: на 2К строка
        // ввода выходит под 1900 px, и это ровно то, на что владелец сказал «чё криво».
        console.log('\n── 8. Широкий экран ──');
        await page.setViewportSize({ width: 1920, height: 1000 });
        await page.locator('button:has-text("Импорт")').click();
        await page.waitForSelector('.gg-panel-imp textarea');
        const wide = await page.evaluate(() => {
            const box = (el) => el.getBoundingClientRect();
            const panel = box(document.querySelector('.gg-panel-imp'));
            const area = box(document.querySelector('.gg-panel-imp textarea'));
            const prev = box(document.querySelector('.gg-panel-imp .gg-preview'));
            return { panel: panel.width, area: area.width, prevX: prev.x, areaRight: area.right, sameRow: Math.abs(prev.y - area.y) < 40 };
        });
        check(wide.panel <= 1120, `панель формы ограничена по ширине (${Math.round(wide.panel)} px при окне 1920)`);
        check(wide.area < 900, `поле ввода не растянуто на всю ширину (${Math.round(wide.area)} px)`);
        check(wide.sameRow && wide.prevX >= wide.areaRight - 1,
            'предпросмотр стоит рядом с полем, а не под ним: место справа используется');
        await page.locator('.gg-panel-imp button:has-text("Отмена")').click();

        // Скриншот кладём в системный временный каталог, а не в репозиторий: смотреть на
        // вкладку полезно, а мусорить в рабочем дереве - нет.
        const shot = path.join(require('os').tmpdir(), 'google-tab-render.png');
        await page.evaluate(() => GOOGLE.menu(null));
        await page.screenshot({ path: shot, fullPage: true });
        console.log(`\nскриншот: ${shot}`);
    } catch (e) {
        check(false, `проба упала: ${e.message}`);
    }
    done(fails.length ? 1 : 0);
})();
