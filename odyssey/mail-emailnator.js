#!/usr/bin/env node
// odyssey/mail-emailnator.js
//
// Мост к `freemodel/lib/emailnator.js`: отдаёт адрес и код письма строками JSON.
//
// 🔴 Зачем именно ЭТА либа, а не `camoufox_emailnator.py`. Владелец 17.09: «emailnator мы
// уже проходили - 如梦AI (rumeng), тут там создаётся правильная почта». Так и есть: у руменга
// стоит `freemodel/lib/emailnator.js`, переписанный 13.09 под новый сайт, и он включает
// ТОЛЬКО чип `.Gmail` (Domain off, +Gmail off, .Gmail on, GoogleMail off), из-за чего
// выдаёт настоящий `имя.фамилия@gmail.com`. Питоновский клиент ходит по СТАРЫМ селекторам
// (`custom-switch-googleMail` и соседи) - на живом прогоне 17.09 он отдал
// `b.ethd.ele.on51@googlemail.com`, то есть домен, который владелец отдельно запрещал.
// Второй реализации тех же шагов не заводим: берём проверенную и оборачиваем её.
//
// Протокол (stdin → stdout, по строке JSON):
//   {"cmd":"create"}                                  → {"ok":true,"email":"…@gmail.com"}
//   {"cmd":"code","timeout_min":3,"from_hint":"…"}     → {"ok":true,"code":"123456"} | {"ok":false,…}
//   {"cmd":"stop"}                                     → {"ok":true} и выход
//
// 🪤 Библиотека пишет свои шаги в `console.log`, а по stdout идёт JSON. Поэтому лог
// переведён в stderr: иначе разбор ответов ломается на первой же её строке.

const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const en = require(path.join(__dirname, '..', 'freemodel', 'lib', 'emailnator.js'));

process.stdout.write('');                       // stdout только для JSON
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.info = console.log;
console.warn = console.log;

let browser = null, ctx = null, page = null, email = null;

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

async function ensurePage() {
  if (page) return page;
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // 🪤 `zh-CN` как у руменга: сайт локализуется по языку браузера, и селекторы на
    // китайском тексте молча ломаются на английских кнопках.
    locale: 'zh-CN',
  });
  page = await ctx.newPage();
  return page;
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
      email = await en.createEmail(p);
      if (!email) { out({ ok: false, error: 'адрес не выдан' }); return; }
      console.error(`[mail-emailnator] адрес: ${email}`);
      out({ ok: true, email });
    } else if (cmd.cmd === 'code') {
      if (!email) { out({ ok: false, error: 'адрес ещё не создан' }); return; }
      // Библиотека считает срок в МИНУТАХ, драйвер присылает минуты же.
      const code = await en.pollInbox(page, email, {
        timeout: Math.max(1, Number(cmd.timeout_min) || 3),
        fromHint: String(cmd.from_hint || ''),
      });
      out(code ? { ok: true, code: String(code) } : { ok: false, error: 'письма с кодом нет' });
    } else if (cmd.cmd === 'stop') {
      out({ ok: true });
      await shutdown(0);
    } else {
      out({ ok: false, error: `неизвестная команда: ${cmd.cmd}` });
    }
  } catch (e) {
    out({ ok: false, error: String((e && e.message) || e) });
  }
});
