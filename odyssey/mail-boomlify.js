#!/usr/bin/env node
// odyssey/mail-boomlify.js
//
// Мост к boomlify.com («Gmail Temp Mail»): отдаёт адрес и код письма строками JSON.
//
// 🔴 Зачем третья почта. Владелец 17.09: у 22.do кончаются свободные gmail-адреса, а
// emailnator письма от Clerk не получал. boomlify даёт точечный `@gmail.com` без регистрации
// (адрес живёт 7 дней, в интерфейсе по умолчанию уже включены `.` нотация и домен gmail.com)
// и заявляет доставляемость выше обычных одноразовых сервисов. Проверяем замером, а не
// верим: адрес - да, а вот дойдёт ли письмо, покажет прогон.
//
// 🪤 Почему браузер, а не API. У boomlify есть HTTP-API (`v1.boomlify.com`, ключ в
// `X-API-Key`), но в нём НЕТ gmail-алиасов - только их собственные одноразовые домены и
// кастомные. Одноразовые Clerk отвергает (`block_disposable_email_domains`), значит нужен
// именно этот интерфейс, а у него API нет. Понадобится кастомный домен - вернёмся к API.
//
// Протокол (stdin → stdout, по строке JSON):
//   {"cmd":"create"}                                → {"ok":true,"email":"…@gmail.com"}
//   {"cmd":"code","timeout_min":3}                   → {"ok":true,"code":"123456"} | {"ok":false,…}
//   {"cmd":"stop"}                                   → {"ok":true} и выход
//
// 🪤 stdout отдан ТОЛЬКО под JSON: чужой вывод (наш собственный лог, страница) уходит в
// stderr, иначе строки склеиваются и разбор на стороне драйвера теряет ответ целиком.

const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const URL_NEW = 'https://boomlify.com/en/gmail-temp-mail/';

let extractCode = (text) => {
  const m = String(text || '').match(/(?:^|\D)(\d{6})(?:\D|$)/);
  return m ? m[1] : '';
};
try {
  // Экстрактор кода берём у emailnator-либы, чтобы не заводить третий по счёту.
  ({ extractCode } = require(path.join(__dirname, '..', 'freemodel', 'lib', 'emailnator.js')));
} catch { /* останется свой простой */ }

const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);
const say = (...a) => process.stderr.write('[boomlify] ' + a.join(' ') + '\n');
console.log = say; console.info = say; console.warn = say;
const out = (o) => realWrite(JSON.stringify(o) + '\n');

let browser = null, ctx = null, page = null, email = '';

async function ensurePage() {
  if (page) return page;
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  page = await ctx.newPage();
  return page;
}

// Адрес на странице: берём первое совпадение gmail-адреса в видимом тексте. Селектор
// привязывать не стали намеренно - разметка у сервиса меняется, а адрес всегда показан
// пользователю крупно и один.
async function readAddress(p) {
  return await p.evaluate(() => {
    const txt = document.body.innerText || '';
    const m = txt.match(/[A-Za-z0-9._%+-]+@(?:gmail|googlemail)\.com/);
    return m ? m[0] : '';
  });
}

async function listText(p) {
  // Левая панель со списком писем и правая с содержимым - обе части страницы. Читаем всё
  // видимое: письмо может оказаться и превью в списке.
  return await p.evaluate(() => document.body.innerText || '');
}

async function create(p) {
  await p.goto(URL_NEW, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Появление адреса ждём: страница рисует его скриптом.
  for (let i = 0; i < 30; i++) {
    await p.waitForTimeout(1000);
    const a = await readAddress(p);
    if (a) return a;
  }
  throw new Error('адрес на странице не появился');
}

// 🔴 Берём ТОЛЬКО нужное письмо, и это главное в этом клиенте. Ящики многоразовые: в свежем
// может лежать чужое письмо с чужим кодом. У руменга на этом уже стояли (13.09: код взяли из
// письма VerseIn трёхчасовой давности, панель ответила «invalid or expired verification code»),
// и там лекарство - `fromHint` по отправителю. Здесь то же самое: строку списка открываем,
// только если в ней есть след нашего письма, и код берём лишь из письма с этим следом.
// След ищем широко - Odyssey, Clerk, «verify»/«verification», «код»: имя отправителя у Clerk
// может быть и «Odyssey», и «Clerk», и «noreply@odysseyapi.tech».
const HINT = /odyssey|clerk|verif|verification|код|code/i;

async function waitCode(p, minutes, hints) {
  const deadline = Date.now() + Math.max(1, minutes) * 60 * 1000;
  const seen = new Set();
  const re = hints ? new RegExp(hints, 'i') : HINT;
  while (Date.now() < deadline) {
    // Кнопка «Refresh emails» - основной способ обновить список; автообновление у них тоже
    // есть, но полагаться на него не будем.
    await p.locator('button', { hasText: /Refresh emails/i }).first()
      .click({ timeout: 4000 }).catch(() => {});
    await p.waitForTimeout(2000);

    const txt = await listText(p);
    if (/No emails found/i.test(txt)) { await p.waitForTimeout(4000); continue; }

    const rows = p.locator('div[class*="cursor-pointer"], li, tr').filter({ hasText: /\S/ });
    const n = Math.min(await rows.count().catch(() => 0), 15);
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const t = ((await row.innerText().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
      // Служебные надписи панели - не письма.
      if (!t || /Gmail Inbox|Refresh emails|Search emails|No emails|Select an email|Email Options|Alias Type|Dot Notation|Plus Addressing|Generate New Alias/i.test(t)) continue;
      if (!re.test(t)) { seen.add('мимо: ' + t.slice(0, 60)); continue; }
      if (seen.has(t)) continue;
      seen.add(t);
      say('открываю письмо: ' + t.slice(0, 90));
      await row.click({ timeout: 4000 }).catch(() => {});
      await p.waitForTimeout(2500);
      const body = await listText(p);
      const code = extractCode(body);
      if (code) {
        // 🪤 В теле может быть несколько чисел: берём то, что стоит рядом со словом про код.
        const near = (body.match(/(?:verification|verify|код|code)[^0-9]{0,40}(\d{6})/i) || [])[1];
        say('код из письма: ' + (near || code));
        return near || code;
      }
      say('в письме кода нет: ' + body.replace(/\s+/g, ' ').slice(0, 120));
    }
    if (seen.size && Date.now() + 15000 > deadline) say('виденные строки: ' + [...seen].slice(-6).join(' | '));
    await p.waitForTimeout(3000);
  }
  return '';
}

async function shutdown(code = 0) {
  try { if (browser) await browser.close(); } catch { /* уже мёртв */ }
  browser = ctx = page = null;
  process.exit(code);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const text = String(line).trim();
  if (!text) return;
  let cmd;
  try { cmd = JSON.parse(text); } catch { out({ ok: false, error: 'не JSON' }); return; }
  try {
    if (cmd.cmd === 'create') {
      const p = await ensurePage();
      email = await create(p);
      say('адрес: ' + email);
      out({ ok: true, email });
    } else if (cmd.cmd === 'code') {
      if (!email) { out({ ok: false, error: 'адрес ещё не создан' }); return; }
      const code = await waitCode(page, Number(cmd.timeout_min) || 3, cmd.hint || '');
      out(code ? { ok: true, code } : { ok: false, error: 'письма с кодом нет' });
    } else if (cmd.cmd === 'stop') {
      out({ ok: true });
      await shutdown(0);
    } else {
      out({ ok: false, error: 'неизвестная команда: ' + cmd.cmd });
    }
  } catch (e) {
    out({ ok: false, error: String((e && e.message) || e) });
  }
});
