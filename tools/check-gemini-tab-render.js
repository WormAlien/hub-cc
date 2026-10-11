#!/usr/bin/env node
/**
 * check-gemini-tab-render.js — приёмка ОТРИСОВКИ вкладки Gemini: гоняет настоящий стенд
 * (`tools/gemini-preview.js`) в настоящем Chromium.
 *
 * Зачем отдельно от `check-gemini-tab.js`. Тот проверяет шов и ручки, но ничего не говорит о
 * том, как вкладка выглядит: разметку целиком рисует JS, и половина поломок видна только
 * глазом. Живой `:8200` для этого не годится — второй экземпляр дашборда поднимать нельзя
 * (boot снимет keepalive живого стека), а рестарт делает владелец. Стенд даёт то же самое
 * на своём порту и своём демо-пуле.
 *
 * Что проверяется поведением, а не поиском строк:
 *   · три состояния карточки различимы: pro с квотой, выжженный с лимитом и забаненный;
 *   · шкала квоты рисуется и её процент соответствует узкой модели аккаунта;
 *   · список моделей раскрывается и закрывается по кнопке;
 *   · состояние «сервер вкладки лежит» показывается честно, с кнопкой «поднять»;
 *   · ноль ошибок в консоли и нет горизонтального переполнения на 1440 и на 640.
 *
 * Запуск: node tools/check-gemini-tab-render.js       (exit 1 = вкладка сломана)
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const PORT = 8399;
const PORT_DOWN = 8396;

let total = 0;
const fails = [];
function check(cond, msg) {
    total += 1;
    console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) fails.push(msg);
    return !!cond;
}

const stands = [];
function startStand(port, env) {
    const p = spawn(process.execPath, [path.join(__dirname, 'gemini-preview.js'), String(port)], {
        cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    stands.push(p);
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`стенд :${port} не поднялся за 20 с`)), 20000);
        p.stdout.on('data', d => { if (String(d).includes('стенд Gemini')) { clearTimeout(t); resolve(); } });
        p.stderr.on('data', d => process.stderr.write(`[стенд ${port}] ${d}`));
        p.on('exit', c => { clearTimeout(t); reject(new Error(`стенд :${port} вышел с кодом ${c}`)); });
    });
}

(async () => {
    let browser = null;
    const done = (code) => {
        try { if (browser) browser.close(); } catch { /* уже закрыт */ }
        for (const s of stands) { try { s.kill(); } catch { /* уже мёртв */ } }
        console.log(fails.length ? `\nпровалено ${fails.length} из ${total}` : `\n${total}/${total} проверок пройдено`);
        process.exit(code);
    };

    try {
        await startStand(PORT, {});
        await startStand(PORT_DOWN, { GEMINI_PREVIEW_DOWN: '1' });

        browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
        const consoleBad = [];
        page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleBad.push(`${m.type()}: ${m.text()}`); });
        page.on('pageerror', e => consoleBad.push(`pageerror: ${e.message}`));
        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
        await page.waitForSelector('.gm-card', { timeout: 10000 });

        // ── 1. Шапка и сетка ─────────────────────────────────────────────────
        console.log('\n── 1. Шапка и сетка ──');
        check((await page.locator('.gm-title').innerText()).includes('Gemini'), 'заголовок вкладки на месте');
        const note = await page.locator('.gm-note').first().innerText();
        check(/поднят/.test(note) && /20178/.test(note), `состояние сервера и порт в подписи (${note.replace(/\n/g, ' ').slice(0, 70)}…)`);
        check(/3 аккаунт/.test(await page.locator('.gm-sub').first().innerText()), 'счётчик аккаунтов в подзаголовке');
        check(await page.locator('.gm-card').count() === 3, 'три карточки по демо-пулу');

        // ── 2. Три состояния, которые вкладка обязана различать ──────────────
        console.log('\n── 2. Тир, лимит, бан ──');
        const cards = await page.locator('.gm-card').allInnerTexts();
        check(cards.some(t => /✦ pro/.test(t) && /✦ ultra/.test(t) === false), 'тир подписки виден словами («✦ pro»)');
        check(cards.some(t => /выключен/.test(t)), 'выключенный аккаунт помечен');
        check(cards.some(t => /забанен/.test(t)), 'забаненный аккаунт помечен, а не спрятан');
        check(cards.some(t => /лимит по 1 модел/.test(t)), 'упирание в лимит модели видно плашкой');
        check(cards.some(t => /перенос/.test(t)), 'перенесённый из форка аккаунт помечен как перенос');
        check(await page.locator('.gm-card-off').count() === 1, 'выключенная карточка приглушена');

        // ── 3. Шкала квоты ──────────────────────────────────────────────────
        console.log('\n── 3. Шкала квоты ──');
        check(await page.locator('.gm-energy .energy-track').count() === 2,
            'шкала стоит там, где квоту измеряли (два аккаунта из трёх)');
        check(await page.locator('.gm-unmeasured').count() === 1,
            'там, где квоту не спрашивали, стоит подпись, а не пустая полоса на нуле');
        const pcts = await page.locator('.gm-energy .energy-pct').allInnerTexts();
        check(pcts.some(t => /83%/.test(t)), `остаток по квоте посчитан (${pcts.map(t => t.trim().split('%')[0] + '%').join(' / ')})`);
        check(pcts.some(t => /2%/.test(t)), 'выжженный аккаунт показывает почти ноль, а не пустоту');
        const subs = await page.locator('.gm-energy .eg-sub').allInnerTexts();
        check(subs.some(t => /gemini-3\.8-flash-tiered/.test(t)), 'под шкалой названа узкая модель — по ней и видно, когда кончится');

        // ── 4. Список моделей раскрывается ──────────────────────────────────
        console.log('\n── 4. Список моделей ──');
        check(await page.locator('.gm-models-open').count() === 0, 'по умолчанию список моделей закрыт');
        await page.locator('.gm-card').first().locator('button', { hasText: 'модели' }).click();
        await page.waitForSelector('.gm-models-open', { timeout: 5000 });
        const rows = await page.locator('.gm-models-open .gm-model-row').count();
        check(rows === 5, `раскрылся список моделей аккаунта (${rows} строк)`);
        check((await page.locator('.gm-models-open').innerText()).includes('сброс'), 'в строке модели есть время сброса');
        await page.locator('.gm-card').first().locator('button', { hasText: 'модели' }).click();
        await page.waitForTimeout(300);
        check(await page.locator('.gm-models-open').count() === 0, 'закрывается повторным нажатием');

        // ── 5. Модели, тиры и переключение ──────────────────────────────────
        console.log('\n── 5. Модели, тиры, переключение ──');
        const calls = [];
        page.on('request', r => { if (r.url().includes('/api/gemini/')) calls.push(r.method() + ' ' + r.url().split('/api/gemini/')[1]); });

        await page.locator('.gm-actions button', { hasText: 'модели и тиры' }).click();
        await page.waitForSelector('.gm-panel .gm-models', { timeout: 5000 });
        const cat = await page.locator('.gm-panel .gm-models button.gm-tag').count();
        check(cat === 8, `каталог моделей показан кнопками (${cat} моделей)`);
        check(await page.locator('.gm-panel button.gm-tag.gm-tag-on').count() === 1, 'активная модель подсвечена, и она одна');

        const selects = page.locator('.gm-map .gm-select');
        check(await selects.count() === 3, 'три тира Claude Code — три выбора');
        check(await selects.nth(0).inputValue() === 'gemini-3.6-flash-high', 'тир opus показывает своё значение из карты');
        // 🪤 haiku в карте стенда указывает на модель, которой в демо-каталоге НЕТ — так
        // проверяется, что значение не пропадает молча (в жизни модель убирают из Google).
        check(await selects.nth(2).inputValue() === 'gemini-3.5-flash-lite',
            'тир со значением вне каталога остаётся выбранным, а не сбрасывается в «не задано»');
        check((await selects.nth(2).locator('option:checked').innerText()).includes('нет в каталоге'),
            'и подписан как отсутствующий в каталоге');
        const opts = await selects.nth(0).locator('option').count();
        check(opts === 9, `в выборе тира весь каталог плюс «не задано» (${opts} вариантов)`);

        await page.locator('.gm-panel button', { hasText: 'сохранить тиры' }).click();
        await page.waitForTimeout(400);
        check(calls.some(c => c === 'POST modelmap'), 'кнопка «сохранить тиры» пишет карту');

        await page.locator('.gm-panel .gm-models button.gm-tag').first().click();
        await page.waitForTimeout(400);
        check(calls.some(c => c === 'POST set-model'), 'клик по модели делает её активной');

        await page.locator('.gm-actions button', { hasText: 'сделать активным' }).click();
        await page.waitForTimeout(600);
        check(calls.some(c => c === 'POST activate'), 'кнопка «сделать активным» переключает бэкенд');
        check((await page.locator('.gm-toast').allInnerTexts()).join(' ').includes('активный бэкенд'),
            'и об этом сказано тостом, а не тишиной');

        // ── 5б. Добавление аккаунта из вкладки ──────────────────────────────
        console.log('\n── 5б. Авторизация аккаунта ──');
        await page.locator('.gm-actions button', { hasText: 'добавить аккаунт' }).click();
        await page.waitForSelector('.gm-auth-list', { timeout: 5000 });
        const authRows = page.locator('.gm-auth-list .gm-auth-row');
        check(await authRows.count() === 2, `список аккаунтов пула Google показан (${await authRows.count()} строки)`);
        check((await authRows.nth(0).innerText()).includes('уже в пуле'), 'авторизованный аккаунт помечен и не предлагается заново');
        check(await authRows.nth(0).locator('button[disabled]').count() === 1, 'и кнопка у него действительно выключена');
        check((await authRows.nth(1).innerText()).includes('авторизовать'), 'новый аккаунт предлагается авторизовать');

        await authRows.nth(1).locator('button').click();
        await page.waitForTimeout(500);
        check(calls.some(c => c === 'POST auth/start'), 'кнопка открывает окно входа (auth/start)');
        // 🪤 `innerText` отдаёт НАРИСОВАННЫЙ текст, а заголовок панели набран капсом
        // (`text-transform: uppercase`) — сравниваем без регистра, иначе проверка ругается
        // на верстку, а не на поведение.
        const flow = await page.locator('.gm-panel').filter({ hasText: 'Вход:' }).first().innerText();
        check(/demo\.new@gmail\.com/i.test(flow), `в панели видно, под каким аккаунтом открылось окно (${flow.replace(/\n/g, ' ').slice(0, 60)}…)`);
        check(flow.includes('203.0.113.7'), 'и через какой прокси — это тот самый IP, за который банят');

        await page.locator('#gm-auth-input').fill('http://localhost:51121/oauth-callback?code=demo&state=st_demo');
        await page.locator('.gm-panel button', { hasText: 'готово' }).click();
        await page.waitForTimeout(600);
        check(calls.some(c => c === 'POST auth/complete'), 'ссылка колбэка доезжает до сервера вкладки');
        check((await page.locator('.gm-toast').allInnerTexts()).join(' ').includes('аккаунт добавлен'),
            'и об успехе сказано тостом');

        // ── 6. Состояние «сервер лежит» ─────────────────────────────────────
        console.log('\n── 6. Сервер лежит ──');
        const page2 = await browser.newPage({ viewport: { width: 1440, height: 950 } });
        const bad2 = [];
        page2.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') bad2.push(`${m.type()}: ${m.text()}`); });
        page2.on('pageerror', e => bad2.push(`pageerror: ${e.message}`));
        await page2.goto(`http://127.0.0.1:${PORT_DOWN}/`, { waitUntil: 'load' });
        await page2.waitForSelector('.gm-panel', { timeout: 10000 });
        const downText = await page2.locator('.gm-wrap, .gm-head').first().innerText();
        check(/лежит/.test(downText), 'сказано прямо, что сервер лежит');
        check(/поднять сервер/.test(await page2.locator('.gm-actions').innerText()), 'предложена кнопка «поднять сервер»');
        check(await page2.locator('.gm-card').count() === 0, 'карточек нет — пул не выдумывается');
        check(bad2.length === 0, `консоль в этом состоянии чистая${bad2.length ? ': ' + bad2[0] : ''}`);
        await page2.close();

        // ── 7. Переполнение по ширине ───────────────────────────────────────
        console.log('\n── 7. Ширина ──');
        for (const w of [1440, 1024, 640]) {
            await page.setViewportSize({ width: w, height: 950 });
            await page.waitForTimeout(250);
            const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            check(over <= 1, `нет горизонтального переполнения на ${w} px (${over})`);
        }

        console.log('\n── 8. Консоль ──');
        check(consoleBad.length === 0, `ноль ошибок и предупреждений${consoleBad.length ? ': ' + consoleBad[0] : ''}`);

        done(fails.length ? 1 : 0);
    } catch (e) {
        console.error(`\nсломалось: ${e.message}`);
        done(1);
    }
})();
