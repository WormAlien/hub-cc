#!/usr/bin/env node
// _research/probe-boomlify-inbox.js <минут>
//
// Проба: приходит ли на адрес boomlify ЛЮБОЕ письмо.
//
// 🔴 Зачем отдельная проба, когда есть драйвер. Живой прогон 17.09 06:09: заявка Clerk ушла,
// код запрошен - и на адрес boomlify письма не было три минуты. Но это может значить и «Clerk
// не доставил», и «сервис вообще не принимает почту». Проба отделяет одно от другого: она
// просто ЖДЁТ любое письмо и печатает всё, что увидит в ящике. Пишет владелец с любой своей
// почты - этого достаточно.
//
// Печатает адрес, затем каждую пару секунд состояние ящика.

const path = require('path');
const { chromium } = require('playwright');

const MINUTES = Number(process.argv[2] || 5);
const URL_NEW = 'https://boomlify.com/en/gmail-temp-mail/';

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  const page = await ctx.newPage();

  await page.goto(URL_NEW, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let addr = '';
  for (let i = 0; i < 30 && !addr; i++) {
    await page.waitForTimeout(1000);
    addr = await page.evaluate(() => {
      const m = (document.body.innerText || '').match(/[A-Za-z0-9._%+-]+@(?:gmail|googlemail)\.com/);
      return m ? m[0] : '';
    });
  }
  console.log('АДРЕС ДЛЯ ПРОВЕРКИ: ' + addr);
  console.log('напиши на него письмо с любой своей почты; окно открыто, жду ' + MINUTES + ' мин');

  const deadline = Date.now() + MINUTES * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    await page.locator('button', { hasText: /Refresh emails/i }).first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const txt = (await page.evaluate(() => document.body.innerText || '')).replace(/\s+/g, ' ');
    const inbox = txt.slice(0, 1200);
    if (/No emails found/i.test(inbox)) {
      process.stdout.write('.');
    } else if (inbox !== last) {
      last = inbox;
      console.log('\nЯЩИК: ' + inbox.slice(0, 600));
      const m = txt.match(/(?:^|\D)(\d{6})(?:\D|$)/);
      if (m) console.log('НАЙДЕН КОД: ' + m[1]);
    }
    await page.waitForTimeout(3000);
  }
  console.log('\nконец пробы');
  await browser.close();
})();
