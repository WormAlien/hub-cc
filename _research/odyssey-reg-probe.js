// _research/odyssey-reg-probe.js
//
// ВРЕМЕННАЯ проба разведки, а не код механизма. Цель этапа 0 у Odyssey: выяснить,
// проходится ли регистрация Clerk без человека, и где на этом пути берётся API-ключ.
//
// Почему это вообще нужно: у rumeng ядром автореги был чистый HTTP в sub2api. Здесь
// площадка за Clerk, и замер 16.09 показал, что своих `/api/*` ручек у неё НЕТ -
// `/dashboard/api-keys` отвечает 307 на вход, то есть ключ заводится только в ЛК
// за живой сессией. Значит скрипт будет браузерным, и первое, что надо знать, -
// какие у формы селекторы и что делает умная капча Clerk.
//
// Использование:
//   node _research/odyssey-reg-probe.js inspect          осмотр формы, НИЧЕГО не создаётся
//   node _research/odyssey-reg-probe.js inspect --headful
//
// Регистрация в этой версии НЕ выполняется: сначала селекторы, потом прогон. Так
// один живой аккаунт не тратится на угадывание разметки.

'use strict';

const HEADFUL = process.argv.includes('--headful');
const MODE = (process.argv[2] || 'inspect').replace(/^--/, '');

const SIGNUP_URL = 'https://odysseyapi.tech/sign-up';

// UA живой и «человеческий» намеренно: умная капча Clerk включается на подозрительном
// трафике, и дефолтный UA headless-хрома - первое, за что она цепляется.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function dump(page, tag) {
    const data = await page.evaluate(() => {
        const q = sel => Array.from(document.querySelectorAll(sel)).map(e => ({
            tag: e.tagName.toLowerCase(),
            type: e.type || null,
            name: e.name || null,
            id: e.id || null,
            placeholder: e.placeholder || null,
            text: (e.innerText || '').trim().slice(0, 70) || null,
            cls: String(e.className || '').slice(0, 90),
            disabled: e.disabled === true,
            href: e.getAttribute ? e.getAttribute('href') : null,
        }));
        return {
            url: location.href,
            title: document.title,
            inputs: q('input, select, textarea'),
            buttons: q('button, [role="button"]'),
            links: q('a').filter(a => a.href).slice(0, 25),
            iframes: Array.from(document.querySelectorAll('iframe')).map(f => ({ title: f.title || null, src: String(f.src).slice(0, 120) })),
            body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
        };
    });
    console.log(`\n================ ${tag} ================`);
    console.log('URL    :', data.url);
    console.log('TITLE  :', data.title);
    console.log('IFRAME :', JSON.stringify(data.iframes));
    console.log('INPUTS :');
    for (const i of data.inputs) console.log('   ', JSON.stringify(i));
    console.log('BUTTONS:');
    for (const b of data.buttons) console.log('   ', JSON.stringify(b));
    console.log('LINKS  :');
    for (const l of data.links) console.log('   ', JSON.stringify(l));
    console.log('BODY   :', data.body);
}

(async () => {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({
        headless: !HEADFUL,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const ctx = await browser.newContext({
        locale: 'en-US',
        viewport: { width: 1280, height: 900 },
        userAgent: UA,
    });
    const page = await ctx.newPage();

    // Всё, что браузер печатает сам, полезно: ошибки Clerk видны в консоли раньше,
    // чем в разметке, а `captcha` в тексте ошибки - прямой ответ на главный вопрос.
    page.on('console', m => {
        const t = m.text();
        if (/captcha|error|fail|invalid|clerk/i.test(t)) console.log('   [console]', t.slice(0, 200));
    });
    page.on('response', async r => {
        const u = r.url();
        if (/clerk|sign_?up|client/i.test(u) && r.status() >= 400) {
            console.log('   [http]', r.status(), u.slice(0, 140));
            try { console.log('          ', (await r.text()).slice(0, 300)); } catch { /* тело не обязательно */ }
        }
    });

    try {
        console.log(`режим: ${MODE} · headless: ${!HEADFUL}`);
        await page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(6000);   // Clerk-компонент монтируется асинхронно
        await dump(page, 'ПОСЛЕ ЗАГРУЗКИ /sign-up');

        // 🔴 ГЛАВНАЯ НАХОДКА ПЕРВОГО ОСМОТРА: форму закрывает НЕ умная капча Clerk,
        // а **ALTCHA** - proof-of-work («I'm not a robot · Protected by ALTCHA · One
        // quick check keeps bots out, then the form appears»). Это принципиально:
        // ALTCHA решается ВЫЧИСЛЕНИЕМ (хешкаш), а не распознаванием картинок, то есть
        // без человека в принципе. Прежняя запись «авто-заведения нет, капча Clerk не
        // гарантирует сценарий без человека» опиралась на окружение Clerk, а не на
        // живую страницу, - и на живой странице барьер другой.
        const box = page.locator('input[type="checkbox"][id^="altcha-checkbox"]');
        if (await box.count()) {
            // Конфигурация виджета — это и есть ответ на «решается ли он вычислением».
            // `challengeurl` говорит, откуда берётся задача, `maxnumber` — потолок перебора.
            const widget = await page.evaluate(() => {
                const w = document.querySelector('altcha-widget') || document.querySelector('[id^="altcha"]')?.closest('altcha-widget, div');
                const el = document.querySelector('altcha-widget');
                const attrs = el ? Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])) : null;
                return {
                    hasCustomElement: !!el,
                    attrs,
                    outer: (w ? w.outerHTML : '').slice(0, 900),
                };
            });
            console.log('\nALTCHA widget:', JSON.stringify(widget, null, 1).slice(0, 1200));

            console.log('\nнашёл ALTCHA-галочку, жму');
            // 🪤 Прямой клик по `input` перехватывает нарисованная поверх `<svg>` галочка
            // («intercepts pointer events»). Поэтому жмём label, а если его нет — сам
            // чекбокс с `force`. Это дефект МОЕГО селектора, не защита страницы.
            const label = page.locator('label').filter({ hasText: /not a robot/i });
            if (await label.count()) {
                await label.first().click({ timeout: 15000 }).catch(e => console.log('   label не кликнулся:', e.message));
            } else {
                await box.first().click({ force: true, timeout: 15000 }).catch(e => console.log('   force-клик не прошёл:', e.message));
            }
            await page.waitForTimeout(10000);      // виджет считает PoW
            const checked = await box.first().isChecked().catch(() => null);
            const token = await page.evaluate(() => (document.querySelector('input[name="altcha"]') || {}).value || null);
            console.log(`   галочка: ${checked} · длина токена altcha: ${token ? token.length : 0}`);
            await dump(page, 'ПОСЛЕ ALTCHA');
        } else {
            console.log('\nALTCHA-галочки нет');
        }

        // Согласие/куки-баннер, если он есть, ищем текстом - до полей.
        for (const t of ['Accept', 'Accept all', 'I agree', 'Agree']) {
            const b = page.getByRole('button', { name: t, exact: false });
            if (await b.count().catch(() => 0)) {
                await b.first().click().catch(() => {});
                console.log(`нажал «${t}»`);
                await page.waitForTimeout(1500);
                await dump(page, 'ПОСЛЕ СОГЛАСИЯ');
                break;
            }
        }
    } catch (e) {
        console.log('ОШИБКА:', e.message);
    } finally {
        if (HEADFUL) {
            console.log('\nокно открыто (headful) - закрываю через 5 с');
            await page.waitForTimeout(5000).catch(() => {});
        }
        await browser.close().catch(() => {});
    }
})();
