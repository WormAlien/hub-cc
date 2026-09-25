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
        check(/всего\s*2/.test(note) && /с 2FA\s*1/.test(note), `строка сводки посчитана (${note.replace(/\n/g, ' ').slice(0, 60)}…)`);
        check(await page.locator('.gg-chip').count() === 5, 'пять чипов статуса (все + четыре вердикта)');
        check(await page.locator('.gg-card').count() === 2, 'две карточки по демо-пулу');

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
        check(await page.locator('.gg-card').count() === 2, 'до записи число карточек не изменилось');
        await page.locator('.gg-panel-imp button:has-text("Импортировать")').click();
        await page.waitForTimeout(900);
        check(await page.locator('.gg-card').count() === 4, 'запись пачки добавила две карточки');

        // ── 7. Меню и вид ────────────────────────────────────────────────────
        console.log('\n── 7. Меню и вид ──');
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
