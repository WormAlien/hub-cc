// Читает остаток с chat.b.ai/usage браузером профиля шлюза.
//
// Зачем браузером: страница за Cloudflare, и любой HTTP-запрос со стороны (curl, серверный fetch,
// даже с живыми куками профиля) получает `403 Cf-Mitigated: challenge` вместо данных — проверено
// 15.09. Профиль шлюза логинится в chat.b.ai через Google, поэтому читаем в самом браузере.
//
// Печатает одну строку JSON: {"ok":true,"balance":297604,"raw":"297,604"} или причину отказа.
// Запуск: node bai/read-balance.js [--visible]   (--visible — если Cloudflare не пропустит headless)
const path = require('path');
const { chromium } = require('playwright');

const PROFILE = path.join(__dirname, 'profiles');
const URL = 'https://chat.b.ai/usage';

(async () => {
    const visible = process.argv.includes('--visible');
    const realChrome = process.argv.includes('--chrome');   // настоящий Chrome: Cloudflare к нему добрее
    const ctx = await chromium.launchPersistentContext(PROFILE, {
        ...(realChrome ? { channel: 'chrome' } : {}),
        headless: !visible,
        viewport: visible ? null : { width: 1280, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
    });
    try {
        const page = ctx.pages()[0] || await ctx.newPage();
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 🪤 Классы у элементов сгенерированные (`acss-1h7d5nm`) и меняются от сборки к сборке,
        // поэтому цепляемся не за класс, а за СОСЕДА элемента с текстом ровно «Balance».
        // Ждём долго: если Cloudflare показал проверку, человеку нужно время её пройти.
        const handle = await page.waitForFunction(() => {
            const label = [...document.querySelectorAll('div')]
                .find(n => n.children.length === 0 && n.textContent.trim() === 'Balance');
            const txt = label && label.nextElementSibling && label.nextElementSibling.textContent.trim();
            return txt && /\d/.test(txt) ? txt : null;
        }, { timeout: Number(process.env.BALANCE_WAIT_MS || 150000) }).catch(() => null);

        const raw = handle ? await handle.jsonValue() : null;
        if (!raw) {
            // Диагностика в отказе: «челлендж Cloudflare» и «не залогинен» лечатся разным.
            const title = await page.title().catch(() => '');
            const text = await page.evaluate(() => document.body.innerText.slice(0, 160).replace(/\s+/g, ' ')).catch(() => '');
            console.log(JSON.stringify({ ok: false, reason: 'число не найдено', url: page.url(), title, text }));
            process.exit(1);
        }
        console.log(JSON.stringify({ ok: true, balance: Number(String(raw).replace(/[^\d.]/g, '')), raw }));
    } finally {
        await ctx.close();
    }
})().catch(e => {
    console.log(JSON.stringify({ ok: false, reason: String(e.message).slice(0, 140) }));
    process.exit(1);
});
