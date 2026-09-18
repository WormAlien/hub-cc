#!/usr/bin/env node
/**
 * Живая проба расписания партий AgentRouter: карточка в панели и метки циферблата.
 *
 * Зачем отдельная проба, если есть `check-ar-quota.js`. Тот проверяет арифметику
 * (две копии — серверную и клиентскую) и следы правок по исходнику. Здесь другое:
 * страница поднимается в настоящем браузере, и проверяется то, что видно глазами и
 * ломается молча — сколько меток нарисовал суточный круг, куда вывернулся сектор
 * «до партии», что написано под часами, что подставилось в поля карточки и что
 * покажет отказ сервера. Ассерт по исходнику тут бесполезен: строка на месте, а
 * отрисовка сломана.
 *
 * Запуск: node tools/check-ar-schedule-ui.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { arQuotaBatches } = require('../routing/lib/ar-quota-probe');

const DASH = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
const URL = 'http://dashboard.test/__switch';
const src = fs.readFileSync(DASH, 'utf8');

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failed++; };
const eq = (got, want, msg) => ok(got === want,
    `${msg}${got === want ? '' : `  (ожидалось ${JSON.stringify(want)}, получено ${JSON.stringify(got)})`}`);

// Расписания-сцены: поставка вендора, три партии и зона, где локальные времена
// не совпадают с входными (иначе предпросмотр карточки проверять нечем).
const VENDOR = { ok: true, tz: 'Asia/Shanghai', times: ['10:00', '19:00'], source: 'file',
                 updated: '2026-09-18', error: null,
                 fallback: { tz: 'Asia/Shanghai', times: ['10:00', '19:00'] } };
const THREE = { ...VENDOR, tz: 'UTC', times: ['00:00', '08:00', '16:00'] };

// Считаем ожидание тем же расписанием, что и страница: проба не должна зависеть от
// того, в какой час её запустили.
const schedOf = j => ({ tz: j.tz, times: j.times });
const localTimes = j => {
    const b = arQuotaBatches(Date.now(), schedOf(j));
    const pad = n => String(n).padStart(2, '0');
    return [...new Set(b.all.map(t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }))].sort();
};

async function mkPage(browser, route, onPost, fixedNow) {
    const context = await browser.newContext();
    // Пришпиленные часы: сектор «до партии» разный в разное время суток (9 ч днём, 15 ч
    // ночью), и проверка, которая ловит только тот промежуток, что случился при запуске,
    // вторую половину грабли просто не увидит.
    if (fixedNow) await context.addInitScript(ts => { Date.now = () => ts; }, fixedNow);
    // Затравка кеша: страница должна увидеть готовую запись ещё до своего первого тика.
    await context.route('**/*', (r) => {
        const u = r.request().url();
        if (u === URL) return r.fulfill({ contentType: 'text/html; charset=utf-8', body: src });
        if (u.includes('/ar/quota-schedule')) {
            if (r.request().method() === 'POST') {
                const body = JSON.parse(r.request().postData() || '{}');
                return r.fulfill({ contentType: 'application/json', body: JSON.stringify(onPost(body)) });
            }
            return r.fulfill({ contentType: 'application/json', body: JSON.stringify(route) });
        }
        if (u.includes('/ar/quota-state')) return r.fulfill({
            contentType: 'application/json', body: JSON.stringify({ ok: true, pools: {} }) });
        if (/\.js(\?|$)/.test(u)) return r.fulfill({ contentType: 'application/javascript', body: '' });
        return r.fulfill({ contentType: 'application/json', body: '{}' });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
        const s = document.getElementById('arq-sched-line');
        return s && s.textContent.trim().length > 0;
    }, null, { timeout: 15000 });
    // Карточка живёт на вкладке AgentRouter, а скрытое поле не заполнить: переключаем
    // вкладку так же, как это делает человек.
    await page.click('[data-tab="agentrouter"]');
    await page.waitForSelector('#arq-sched-tz', { state: 'visible', timeout: 5000 });
    return { context, page, errors };
}

/* Положить готовую запись в кеш страницы и заставить её перечитать.
   🪤 Через `addInitScript` не работает: в нём localStorage ещё не отдаётся по origin, и
   исключение там глотается - сцена при этом выглядит зелёной, не проверив ничего.
   Поэтому сеем ПОСЛЕ загрузки, а `stSync` дёргаем тем же событием, каким его зовёт
   возврат на вкладку (`visibilitychange`) - второго пути в stSync нет. */
async function seedCache(page, json) {
    await page.evaluate(s => localStorage.setItem('ar-quota-state', s), json);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(600);
}

async function main() {
    const browser = await chromium.launch();
    try {
        // ── Сцена 1: поставка вендора (две партии) ───────────────────────────────
        console.log('── A. поставка: Пекин 10:00 и 19:00 ──────────────────────────────');
        const A = await mkPage(browser, VENDOR, () => VENDOR);
        const line = await A.page.textContent('#arq-sched-line');
        ok(/Две партии в сутки/.test(line), `под часами сказано «Две партии в сутки» — ${line.trim().slice(0, 70)}`);
        ok(line.includes('10:00') && line.includes('19:00'), 'названы времена объявления');
        ok(line.includes(localTimes(VENDOR).join(' и ')), `назван пересчёт в твою зону: ${localTimes(VENDOR).join(' и ')}`);
        ok(/用完即止/.test(line), 'оговорка «партия конечная» на месте');

        eq(await A.page.evaluate(() => document.querySelectorAll('#arq-big .mks circle').length), 2,
            'суточный круг нарисовал РОВНО две метки — по числу партий, а не три зашитых');
        eq(await A.page.evaluate(() => document.querySelectorAll('#arq-mini .mks circle').length), 2,
            'мини-версия нарисовала столько же');

        // 🎯 Флаг большой дуги: сектор идёт от ПРОШЛОЙ партии к следующей, и на ночном
        // промежутке (15 ч = 225°) он обязан быть единицей. Зашитый ноль выворачивал бы
        // дугу через соседний сектор — ровно та грабля, что чинилась 12.09 сменой знака.
        const arc = await A.page.evaluate(() => document.querySelector('#arq-big .hf').getAttribute('d'));
        const nums = (arc.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
        // «M x y A 84 84 0 <largeArc> <sweep> x y»
        const largeArc = nums[5], sweep = nums[6];
        const b = arQuotaBatches(Date.now(), schedOf(VENDOR));
        const span = ((new Date(b.next).getHours() * 60 + new Date(b.next).getMinutes())
            - (new Date(b.last).getHours() * 60 + new Date(b.last).getMinutes()) + 1440) % 1440;
        eq(largeArc, span > 720 ? 1 : 0,
            `флаг большой дуги ${largeArc} при промежутке ${Math.round(span / 60)} ч (нужен ${span > 720 ? 1 : 0})`);
        eq(sweep, 1, 'сектор идёт по часовой — от прошлой партии к следующей');
        eq(nums[2] + ' ' + nums[3], '84 84', 'радиус сектора не поехал');

        // Карточка настроек: поля подставлены с сервера, а не пусты.
        eq(await A.page.inputValue('#arq-sched-times'), '10:00, 19:00', 'в поле времён — расписание с сервера');
        eq(await A.page.inputValue('#arq-sched-tz'), 'Asia/Shanghai', 'в поле зоны — зона шлюза');
        ok(/из файла/.test(await A.page.textContent('#arq-sched-state')), 'состояние говорит, что расписание из файла');
        ok(/→/.test(await A.page.textContent('#arq-sched-line2')), 'предпросмотр показывает пересчёт');
        eq(A.errors.length, 0, `ошибок в странице нет${A.errors.length ? ': ' + A.errors.join(' | ') : ''}`);
        await A.context.close();

        // ── Сцена 2: три партии, зона UTC ───────────────────────────────────────
        console.log('\n── B. три партии в зоне UTC ─────────────────────────────────────');
        const B = await mkPage(browser, THREE, () => THREE);
        const lineB = await B.page.textContent('#arq-sched-line');
        ok(/Три партии в сутки/.test(lineB), 'под часами сказано «Три партии в сутки»');
        eq(await B.page.evaluate(() => document.querySelectorAll('#arq-big .mks circle').length), 3,
            'меток стало три — круг следует за расписанием, а не за константой');
        eq(await B.page.inputValue('#arq-sched-times'), '00:00, 08:00, 16:00', 'поля перечитались под новое расписание');
        eq(B.errors.length, 0, 'ошибок в странице нет');
        await B.context.close();

        // ── Сцена 4: ночной промежуток 15 ч — тот самый 225° ────────────────────
        // 🎯 Здесь и живёт грабля: сектор «от прошлой партии к следующей» на 15 ч
        // больше полукруга, и с зашитым нулём в флаге большой дуги SVG рисует ЕГО ЖЕ
        // наоборот — через соседний сектор. 12.09 это уже случалось на третьем круге,
        // и поймал его владелец глазами, а не проба. Теперь ловит проба: часы
        // пришпилены к 23:00 МСК, между вечерней и утренней партией.
        console.log('\n── D. ночной промежуток 15 ч ────────────────────────────────────');
        const NIGHT = Date.UTC(2026, 8, 18, 20, 0, 0);      // 23:00 МСК
        const N = await mkPage(browser, VENDOR, () => VENDOR, NIGHT);
        const arcN = await N.page.evaluate(() => document.querySelector('#arq-big .hf').getAttribute('d'));
        const nN = (arcN.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
        const bN = arQuotaBatches(NIGHT, schedOf(VENDOR));
        const spanN = ((new Date(bN.next).getHours() * 60 + new Date(bN.next).getMinutes())
            - (new Date(bN.last).getHours() * 60 + new Date(bN.last).getMinutes()) + 1440) % 1440;
        eq(Math.round(spanN / 60), 15, 'проба встала ровно на 15-часовой промежуток (иначе сцена ничего не проверяет)');
        eq(nN[5], 1, 'на 225° флаг большой дуги = 1 (с нулём дуга вывернется через соседний сектор)');
        eq(nN[6], 1, 'и по-прежнему по часовой');
        eq(await N.page.textContent('#arq-big .hero'), '06:00:00',
            'отсчёт до утренней партии: от 23:00 МСК до 05:00 — ровно 6 часов');
        eq(N.errors.length, 0, 'ошибок в странице нет');
        await N.context.close();

        // ── Сцена 5: вкладка пережила смену расписания ──────────────────────────
        // 🪤 Живой случай 18.09: окно, открытое до рестарта `:8200`, гасило результат
        // проверки квоты МОЛЧА - владелец прочитал это как «кнопка не реагирует».
        // Кнопка была исправна, ответ отбрасывала проверка свежести, потому что старая
        // страница считает партию по прежней сетке. Различать «запись прошлой партии»
        // (молчать правильно) и «запись чужого календаря» (нужен F5) обязательно,
        // поэтому сцены две и они обязаны вести себя ПО-РАЗНОМУ.
        console.log('\n── E. запись, пережившая смену расписания ───────────────────────');
        const OLD_GRID = t => { const C = 8 * 3600e3, A = Date.UTC(1970, 0, 1, 16, 0, 0);
            return t - (((t - A) % C + C) % C); };
        const seed = (checkedAtMs, dropAtMs) => JSON.stringify({ opus: { state: 'available',
            checkedAt: new Date(checkedAtMs).toISOString(),
            dropAt: new Date(dropAtMs).toISOString(), keyTail: 'tail' } });

        // Запись чужого календаря: checkedAt и dropAt согласованы МЕЖДУ СОБОЙ, но по
        // прежней сетке - то есть писала её страница, которая ещё не знает нового расписания.
        const alienAt = Date.now() - 60_000;
        const E1 = await mkPage(browser, VENDOR, () => VENDOR);
        await seedCache(E1.page, seed(alienAt, OLD_GRID(alienAt)));
        eq(await E1.page.textContent('#arq-check-result'),
            'запись от прежней схемы партий - обнови страницу и проверь заново',
            'запись чужого календаря называет себя, а не молчит прочерком');
        eq(await E1.page.evaluate(() => document.querySelector('#arq-big').getAttribute('data-arq-state')),
            null, 'цвета такая запись не даёт: врать про квоту по чужой сетке нельзя');
        await E1.context.close();

        // Запись ПРОШЛОЙ партии по моей же сетке: согласована и с собой, и со мной -
        // значит F5 не при чём, и правильный ответ здесь именно молчаливый прочерк.
        const prev = arQuotaBatches(Date.now() - 26 * 3600e3, schedOf(VENDOR)).last;
        const E2 = await mkPage(browser, VENDOR, () => VENDOR);
        await seedCache(E2.page, seed(prev + 60_000, prev));
        eq(await E2.page.textContent('#arq-check-result'), '—',
            'запись просто прошлой партии молчит прочерком - F5 ей ничем не поможет');
        await E2.context.close();

        // ── Сцена 3: применение и отказ ─────────────────────────────────────────
        console.log('\n── C. «Применить» и отказ сервера ───────────────────────────────');
        const NEW = { ok: true, tz: 'Europe/Moscow', times: ['05:00', '14:00'], source: 'file',
                      updated: '2026-09-18', error: null, fallback: VENDOR.fallback };
        const C = await mkPage(browser, VENDOR, () => NEW);
        await C.page.fill('#arq-sched-times', '05:00, 14:00');
        await C.page.fill('#arq-sched-tz', 'Europe/Moscow');
        ok(/→/.test(await C.page.textContent('#arq-sched-line2')), 'предпросмотр живёт при вводе');
        await C.page.click('#arq-sched button:has-text("Применить")');
        await C.page.waitForFunction(() => /записано/.test(document.getElementById('arq-sched-msg').textContent),
            null, { timeout: 5000 });
        ok(/Две партии в сутки: 05:00 и 14:00/.test(await C.page.textContent('#arq-sched-line')),
            'после записи подпись пересобралась под новое расписание');
        eq(await C.page.inputValue('#arq-sched-tz'), 'Europe/Moscow', 'поля показывают записанное');
        await C.context.close();

        // Отказ: времена остаются в поле, текст ошибки объясняет причину.
        const D = await mkPage(browser, VENDOR, () => ({ ok: false, error: 'нужно минимум две партии в сутки' }));
        await D.page.fill('#arq-sched-times', '10:00');
        await D.page.click('#arq-sched button:has-text("Применить")');
        await D.page.waitForFunction(() => /не записано/.test(document.getElementById('arq-sched-msg').textContent),
            null, { timeout: 5000 });
        eq(await D.page.inputValue('#arq-sched-times'), '10:00',
            'отказ не стирает введённое: владелец правит текст, а не набирает заново');
        ok(/минимум две партии/.test(await D.page.textContent('#arq-sched-msg')), 'причина отказа названа');
        await D.context.close();
    } finally {
        await browser.close();
    }

    console.log(failed ? `\n❌ провалов: ${failed}` : '\n✅ все проверки прошли');
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
