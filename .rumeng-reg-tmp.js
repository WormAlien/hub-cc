// Регистрация на 如梦AI (rumeng) через живой UI. Без прокси.
//
// 🔴 ГЛАВНОЕ УСТРОЙСТВО: почта живёт в ОТДЕЛЬНОЙ ВКЛАДКЕ.
// В прежних прогонах я ходил в ящик ТОЙ ЖЕ вкладкой — страница с формой кода при этом
// оставалась брошенной и дёргалась, а код в неё никто не вписывал. Отсюда «спамит на
// странице кода» и «код с почты не вставляется».
//
// Теперь: panel-вкладка держит панель (форма → код), mail-вкладка держит emailnator.
// Их никогда не пересекаем.
//
// Порядок на emailnator строго: галочки → Generate New → GO (наблюдение владельца).

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmail, openInbox, extractCode, clickExactButton, dismissCookie } = require('./freemodel/lib/emailnator');

const SITE = 'https://api.rumeng-ai.com';
const OUT = path.join(os.tmpdir(), 'rumeng-recon');
fs.mkdirSync(OUT, { recursive: true });
// 🪤 Метка прогона в имени снимка: без неё файлы перезаписываются, и при разборе
// легко смотреть на адрес ПРОШЛОГО запуска, приняв его за текущий (наступал 13.09).
const RUN = new Date().toLocaleTimeString('ru-RU').replace(/:/g, '');
const snap = async (page, n) => { try { await page.screenshot({ path: path.join(OUT, `${RUN}-${n}.png`) }); console.log(`   📸 ${RUN}-${n}`); } catch {} };

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--window-size=1400,940'] });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 }, locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });

  // ДВЕ вкладки: почта и панель. Порядок важен — почту заводим первой.
  const mailPage = await ctx.newPage();
  const page = await ctx.newPage();
  const out = {};

  try {
    // 1. Почта (в своей вкладке)
    //
    // 🔴 `bringToFront` ОБЯЗАТЕЛЕН. Вкладка, созданная не последней, остаётся фоновой,
    // а фоновые вкладки браузер тормозит: клики по чипам не доходили (в логе видно, как
    // погас только `Domain`, а три остальных остались включены), адрес не генерировался.
    // В прошлых прогонах вкладка была одна и активная — поэтому там всё работало.
    await mailPage.bringToFront();
    const email = await createEmail(mailPage);
    const password = 'Rm' + Math.random().toString(36).slice(2, 9) + '!' + Math.floor(Math.random() * 90 + 10);
    out.email = email; out.password = password;
    console.log('══ ПОЧТА ══\n  ', email);

    // 2. Панель (в своей)
    console.log('\n══ РЕГИСТРАЦИЯ ══');
    await page.bringToFront();
    await page.goto(SITE + '/register', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const agree = page.locator('button').filter({ hasText: /同意并继续/ }).first();
    if (await agree.count()) { await agree.click({ timeout: 5000 }); await page.waitForTimeout(2500); }
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.waitForTimeout(500);
    await snap(page, '01-filled');
    await clickExactButton(page, '继续');
    await page.waitForTimeout(8000);
    out.urlAfterSubmit = page.url();
    console.log('  URL:', out.urlAfterSubmit);
    if (!/email-verify/i.test(page.url())) { console.log('  шага кода не было'); return; }

    // 3. Код: уходим в ПОЧТОВУЮ вкладку, панель остаётся на месте
    console.log('\n══ КОД ══');
    console.log('  панель уходит в фон, работаем в почтовой вкладке');
    await mailPage.bringToFront();      // вкладка почты снова становится активной
    await page.waitForTimeout(500);
    await openInbox(mailPage, email);
    await snap(mailPage, '02-inbox');

    let code = null;
    for (let i = 0; i < 25 && !code; i++) {
      const reload = mailPage.locator('button', { hasText: /Reload|Refresh/i }).first();
      if (await reload.count()) await reload.click({ timeout: 3000 }).catch(() => {});
      await mailPage.waitForTimeout(2000);
      const body = await mailPage.locator('body').innerText().catch(() => '');
      code = extractCode(body);
      if (!code) process.stdout.write('.');
      if (!code) await mailPage.waitForTimeout(4000);
    }
    out.mailCode = code;
    console.log(code ? `\n  ✅ код ${code}` : '\n  🔴 код не пришёл');
    if (!code) return;

    // 4. Возвращаемся в панель и вписываем код — БЕЗ перезагрузок и лишних нажатий
    await page.bringToFront();
    await page.waitForTimeout(1500);
    const codeInput = page.locator('input:not([type=email]):not([type=password])').first();
    const n = await codeInput.count();
    console.log('  поле кода на панели:', n > 0 ? 'есть' : 'НЕ НАЙДЕНО');
    if (!n) { await snap(page, '99-no-code-field'); return; }
    await codeInput.fill(String(code));
    out.codeFilled = true;
    await page.waitForTimeout(700);
    await snap(page, '03-code-filled');
    console.log('  код вписан');

    let pressed = false;
    for (const label of ['验证并创建账户', '创建账户', '验证']) {
      if (await clickExactButton(page, label)) { console.log('  жму:', label); pressed = true; break; }
    }
    if (!pressed) console.log('  🔴 кнопки подтверждения не нашлось');
    await page.waitForTimeout(10000);
    await snap(page, '04-after-verify');

    const fin = await page.evaluate(() => ({
      url: location.href,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
      storage: Object.keys(localStorage).map(k => k + '=' + String(localStorage.getItem(k)).slice(0, 60)),
    }));
    out.final = fin;
    console.log('\n══ ИТОГ ══');
    console.log('  URL:', fin.url);
    console.log('  текст:', fin.text.slice(0, 300));
    console.log('  localStorage:', JSON.stringify(fin.storage));
    out.registered = /dashboard|keys/i.test(fin.url);

    console.log('\nокно держу 60 с');
    await page.waitForTimeout(60000);
  } catch (e) {
    console.log('ОШИБКА:', e.message);
    await snap(page, '99-error').catch(() => {});
  } finally {
    console.log('\nИТОГ: ' + JSON.stringify(out, null, 1));
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log('снимки в', OUT);
  }
})().catch(e => { console.log('ФАТАЛЬНО:', e.message); process.exit(1); });
