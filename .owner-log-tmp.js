// ЛОГ ДЕЙСТВИЙ ВЛАДЕЛЬЦА.
//
// Владелец проходит процесс руками (регистрация → код → вход → создание ключа),
// а скрипт записывает КАЖДОЕ нажатие и ввод: по какому элементу, с каким текстом
// и каким селектором. По этому логу воспроизводится путь до API-ключа.
//
// Никакого видео. Только текст.

const { chromium } = require('playwright');
const fs = require('fs');
const { createEmail, openInbox } = require('./freemodel/lib/emailnator');

const SITE = 'https://api.rumeng-ai.com';
const LOGFILE = '.owner-actions-tmp.log';
const t = () => new Date().toLocaleTimeString('ru-RU');
const LOG = (kind, msg) => {
  const line = `[${t()}] ${kind.padEnd(6)} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch {}
};

// 🪤 Наблюдатель передаётся ФУНКЦИЕЙ, а не строкой. Со строкой всё ломалось на
// экранировании внутри шаблонной строки, и в браузер уезжал нерабочий код —
// самотест это и показал: «перехвачено событий: 0».
function installWatcher() {
  if (window.__watching) return;
  window.__watching = true;

  const sel = (el) => {
    if (!el || el.nodeType !== 1) return '?';
    if (el.id) return '#' + el.id;
    const parts = [];
    let cur = el;
    for (let i = 0; i < 4 && cur && cur.nodeType === 1; i++) {
      let p = cur.tagName.toLowerCase();
      const cls = (cur.className || '').toString().trim().split(/\s+/).filter(Boolean)[0];
      if (cls && cls.length < 30) p += '.' + cls;
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(p);
      if (cur.id) break;
      cur = parent;
    }
    return parts.join(' > ');
  };

  const info = (el) => {
    if (!el || el.nodeType !== 1) return '?';
    const raw = el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '';
    const txt = String(raw).replace(/\s+/g, ' ').trim().slice(0, 40);
    return sel(el) + '  <' + el.tagName.toLowerCase() + '>  «' + txt + '»';
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('button,a,input,label,[role=button],li') || e.target;
    window.__send('КЛИК', info(el) + '   @ ' + location.pathname);
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !('value' in el)) return;
    const v = String(el.value || '');
    window.__send('ВВОД', info(el) + '   ← "' + (v.length > 24 ? v.slice(0, 24) + '…' : v) + '"');
  }, true);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      const clean = (u) => u.replace(/^https?:\/\/[^/]+/, '').slice(0, 80);
      window.__send('URL', clean(lastUrl) + '  →  ' + clean(location.href));
      lastUrl = location.href;
    }
  }, 700);
}

(async () => {
  try { fs.writeFileSync(LOGFILE, ''); } catch {}

  const browser = await chromium.launch({ headless: false, args: ['--window-size=1400,960'] });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 920 }, locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });

  await ctx.exposeBinding('__send', (_src, kind, message) => LOG(kind, message));
  await ctx.addInitScript(installWatcher);

  const mail = await ctx.newPage();
  const page = await ctx.newPage();

  await mail.bringToFront();
  const email = await createEmail(mail);
  await openInbox(mail, email);

  await page.bringToFront();
  await page.goto(SITE + '/register', { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('');
  console.log('════════════════════════════════════════════════');
  console.log('  ЯЩИК:  ' + email);
  console.log('  Проходи ВЕСЬ путь сам: регистрация → код → вход → API-ключ.');
  console.log('  Каждое нажатие пишу в лог: элемент, текст, селектор.');
  console.log('  Окно живёт 45 минут. Лог: ' + LOGFILE);
  console.log('════════════════════════════════════════════════');
  console.log('');

  await page.waitForTimeout(45 * 60 * 1000).catch(() => {});
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  console.log('окно закрыто, лог в ' + LOGFILE);
})().catch((e) => { console.log('ФАТАЛЬНО:', e.message); process.exit(1); });
