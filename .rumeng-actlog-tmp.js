// Регистрация на 如梦AI с ЛОГОМ ДЕЙСТВИЙ.
//
// 🔴 Смысл: каждая строка лога говорит, ЧТО нажато и ПО КАКОМУ ЭЛЕМЕНТУ.
// Никакого видео — только текст, по которому видно, куда именно я тыкаю.
//
// Формат строки:
//   [время] КЛИК  <селектор>  → <тег> «текст» (класс)
//   [время] ВВОД  <селектор>  → "значение"
//   [время] URL   стало: <адрес>
// Если элемент не найден — печатается СПИСОК всех подходящих, чтобы было видно,
// что на странице на самом деле.

const { chromium } = require('playwright');
const { createEmail, openInbox, pollInbox } = require('./freemodel/lib/emailnator');

const SITE = 'https://api.rumeng-ai.com';
const t = () => new Date().toLocaleTimeString('ru-RU');
const LOG = (kind, msg) => console.log(`[${t()}] ${kind.padEnd(6)} ${msg}`);

// Описание элемента для лога — по нему видно, куда именно попал клик.
//
// 🪤 Описывать надо через РЕЗОЛВЛЕННЫЙ Playwright-элемент, а не через
// `document.querySelector(sel)`: селекторы вида `button:has-text("…")` — это
// синтаксис Playwright, а не CSS, и в браузере такой querySelector молча даёт null.
// Именно поэтому в логе стояло «?» вместо элемента.
async function describeEl(page, selector) {
  try {
    const loc = page.locator(selector).first();
    if (!(await loc.count())) return null;
    return await loc.evaluate((el) => {
      const txt = (el.innerText || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const cls = (el.className || '').toString().split(' ')[0];
      return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}> «${txt}»`;
    });
  } catch { return null; }
}

async function CLICK(page, selector, note = '') {
  const before = page.url();
  const el = await describeEl(page, selector);
  let ok = false;
  try {
    await page.locator(selector).first().click({ timeout: 8000 });
    ok = true;
  } catch (e) {
    LOG('КЛИК', `${selector} → ❌ НЕ НАШЁЛ (${e.message.split('\n')[0].slice(0, 60)})`);
    const all = await page.evaluate(() => [...document.querySelectorAll('button,a,input')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}«${(e.innerText || e.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 24)}»`).slice(0, 14));
    LOG('ЕСТЬ', all.join('  '));
    return false;
  }
  await page.waitForTimeout(1200);
  const after = page.url();
  LOG('КЛИК', `${selector} → ${el || '?'}${note ? '  (' + note + ')' : ''}${after !== before ? `  → URL: ${after.replace(SITE, '')}` : ''}`);
  return ok;
}

async function TYPE(page, selector, value) {
  const el = await describeEl(page, selector);
  try {
    await page.locator(selector).first().fill(value);
  } catch (e) {
    LOG('ВВОД', `${selector} → ❌ НЕ НАШЁЛ`);
    return false;
  }
  LOG('ВВОД', `${selector} → ${el || '?'}  ← "${String(value).slice(0, 30)}"`);
  return true;
}

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--window-size=1360,940'] });
  const ctx = await browser.newContext({
    viewport: { width: 1360, height: 900 }, locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  const mail = await ctx.newPage();     // почта — своя вкладка
  const page = await ctx.newPage();     // панель — своя вкладка

  try {
    await mail.bringToFront();
    const email = await createEmail(mail);
    const password = 'Rm' + Math.random().toString(36).slice(2, 9) + '!' + Math.floor(Math.random() * 90 + 10);
    await openInbox(mail, email);
    LOG('ПОЧТА', `${email}  пароль: ${password}`);

    await page.bringToFront();
    LOG('URL', `открываю ${SITE}/register`);
    await page.goto(SITE + '/register', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    LOG('URL', `стало: ${page.url().replace(SITE, '')}`);

    await CLICK(page, 'button:has-text("同意并继续")', 'согласие с условиями');
    await TYPE(page, '#email', email);
    await TYPE(page, '#password', password);
    await CLICK(page, 'button:has-text("继续")', 'продолжить');
    await page.waitForTimeout(7000);
    LOG('URL', `стало: ${page.url().replace(SITE, '')}`);

    // Код — через ЕДИНСТВЕННУЮ реализацию из либы.
    //
    // 🔴 Здесь раньше жила СВОЯ копия цикла ожидания, старая и кривая: она жала Reload по
    // кругу и не открывала письмо. Из-за дубля правки в либе её не касались — «КОД НЕ
    // ПОЛУЧЕН» при письме в ящике. Одна реализация на всех, иначе это повторяется.
    await mail.bringToFront();
    LOG('ПОЧТА', 'иду за кодом (pollInbox из lib/emailnator)');
    let code = null;
    try { code = await pollInbox(mail, email, { timeout: 3 }); }
    catch (e) { LOG('ПОЧТА', 'ошибка: ' + e.message); }
    LOG('КОД', code ? `получен: ${code}` : 'НЕ ПОЛУЧЕН');
    if (!code) return;

    // Обратно в панель
    await page.bringToFront();
    await page.waitForTimeout(1000);
    LOG('URL', `панель: ${page.url().replace(SITE, '')}`);

    const inputs = await page.evaluate(() => [...document.querySelectorAll('input')]
      .filter(i => { const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map(i => `input#${i.id || '-'}[${i.type}] placeholder="${i.placeholder || ''}"`));
    LOG('ПОЛЯ', inputs.join('  ') || '(нет)');

    await TYPE(page, 'input:not([type=email]):not([type=password])', code);

    const btns = await page.evaluate(() => [...document.querySelectorAll('button')]
      .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map(b => `«${(b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30)}»`));
    LOG('КНОПКИ', btns.join('  ') || '(нет)');

    // Пробуем все осмысленные подписи по очереди — какая сработает, видно по URL
    for (const label of ['验证并创建账户', '创建账户', '验证邮箱', '验证', '继续', '提交']) {
      const sel = `button:has-text("${label}")`;
      const cnt = await page.locator(sel).count().catch(() => 0);
      if (!cnt) { LOG('ПРОПУСК', `${sel} — нет такой кнопки`); continue; }
      const before = page.url();
      await CLICK(page, sel, `попытка с «${label}»`);
      await page.waitForTimeout(7000);
      const after = page.url();
      if (after !== before) { LOG('УСПЕХ', `перешли на ${after.replace(SITE, '')}`); break; }
      LOG('СТОП', `«${label}» нажата, но URL не изменился (${after.replace(SITE, '')}) — жму следующую`);
    }

    await page.waitForTimeout(6000);
    const fin = await page.evaluate(() => ({
      url: location.href,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    }));
    LOG('ИТОГ', `URL: ${fin.url}`);
    LOG('ИТОГ', `текст: ${fin.text.slice(0, 220)}`);

    console.log('\nокно 90 с — покажи, куда жать дальше, если не туда');
    await page.waitForTimeout(90000);
  } catch (e) {
    LOG('ОШИБКА', e.message);
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch(e => { console.log('ФАТАЛЬНО:', e.message); process.exit(1); });
