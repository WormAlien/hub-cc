#!/usr/bin/env node
// odyssey/record-signup.js
//
// Окно с ЗАПИСЬЮ РУЧНОЙ РЕГИСТРАЦИИ. Владелец проходит регистрацию на
// odysseyapi.tech сам, скрипт ничего не жмёт и пишет три слоя:
//
//   1. ДЕЙСТВИЯ  - каждый клик, ввод, submit и Enter: селектор + описание элемента.
//   2. КОНТРАКТ  - весь HTTP к odysseyapi.tech и clerk.odysseyapi.tech: метод, путь,
//                  тело запроса, статус, тело ответа, set-cookie.
//   3. ВИДЕО+HAR - на случай, если по тексту будет непонятно, что произошло.
//
// Зачем так: у площадки НЕТ своих ручек регистрации (замер 16.09 - пять путей
// `/api/*` отдают 404 страницей Next.js, `/dashboard/api-keys` = 307 на вход), а
// на `/sign-up` стоит ALTCHA (proof-of-work). Значит автореге придётся ходить
// браузером, и её сценарий должен повторять ровно тот маршрут, которым проходит
// человек. Гадать по DOM я больше не буду - записываю живой проход.
//
// 🔴 Первый прогон 16.09 показал ДВА барьера, а не один, и это главный вывод записи:
//   • ALTCHA - свой барьер площадки, проходится вычислением:
//     `GET /api/auth/altcha/challenge` (PBKDF2/SHA-256, cost 5000) → виджет считает →
//     `POST /api/auth/altcha/verify` → `200 {"nonce":"..."}`. Человек тут не нужен.
//   • Cloudflare Turnstile - капча САМОГО Clerk (sitekey 0x4AAAAAAAWXJGBD7bONzLBd),
//     вылезает после «Continue». Именно она и не пускает: `POST /v1/client/sign_ups`
//     в записи отсутствует, то есть Clerk не отправил регистрацию без токена капчи.
//
// 🪤 Поэтому запись идёт НАСТОЯЩИМ Chrome (`channel: 'chrome'`), а не Chromium из
// комплекта Playwright: Turnstile отбивает комплектный Chromium даже у человека -
// владелец жал галочку дважды, и она молча пересоздавала челлендж (`.../api/normal`).
// Комплектный движок остаётся флагом `--chromium` для сравнения.
//
// Запуск:
//   node odyssey/record-signup.js [label] [--no-mail-setup] [--chromium]
//
// label - имя профиля, папка odyssey/profiles/<label>/. ТА ЖЕ папка, которой
// пользуется кнопка 🌐 (`open-session.js`), поэтому созданный руками аккаунт
// останется залогинен и для дашборда: назови аккаунт тем же label.
//
// Итог (odyssey/recordings/):
//   signup-<ts>.log        читаемый лог действий - то же, что видно в консоли
//   signup-<ts>.jsonl      машинный лог: действия + запросы + ответы
//   signup-<ts>.har        полный трафик
//   signup-<ts>-route.md   сводный маршрут, собирается при закрытии окна
//   video/*.webm           запись окна
//   odyssey/.signup-state.json  ящик, пароль, пойманный ключ
//
// 🪤 Грабля #17 (kktoken/open-session.js): viewport: null + --window-size, иначе
// Playwright зажимает страницу в 1280x720 внутри большого окна.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createEmail, openInbox } = require('../freemodel/lib/emailnator');

// challenges.cloudflare.com в списке намеренно: по нему видно, выдал Turnstile токен
// или пересоздал челлендж. Без этого барьер в записи выглядел бы как «клик в пустоту».
const SITE_HOSTS = ['odysseyapi.tech', 'clerk.odysseyapi.tech', 'challenges.cloudflare.com'];
const SIGNUP_URL = 'https://odysseyapi.tech/sign-up';
const MAIL_URL = 'https://www.emailnator.com/';

const DIR = __dirname;
const REC_DIR = path.join(DIR, 'recordings');
const VIDEO_DIR = path.join(REC_DIR, 'video');
const STATE_FILE = path.join(DIR, '.signup-state.json');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const label = (args[0] || 'signup-record').replace(/[^\w-]/g, '_');
const profileDir = path.join(DIR, 'profiles', label);
const doMailSetup = !flags.includes('--no-mail-setup');
// Настоящий Chrome по умолчанию, комплектный Chromium - только по явному флагу.
const useChromium = flags.includes('--chromium');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logPath = path.join(REC_DIR, `signup-${stamp}.log`);
const jsonlPath = path.join(REC_DIR, `signup-${stamp}.jsonl`);
const harPath = path.join(REC_DIR, `signup-${stamp}.har`);
const routePath = path.join(REC_DIR, `signup-${stamp}-route.md`);

fs.mkdirSync(REC_DIR, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

// 🔴 Пишем в файл КАЖДУЮ строку сразу, а не пакетом в конце: сессия агента может
// умереть посреди прогона (уже было), и тогда единственный носитель записи - диск.
const logStream = fs.createWriteStream(logPath, { flags: 'a' });
const jsonlStream = fs.createWriteStream(jsonlPath, { flags: 'a' });

const hhmmss = () => new Date().toLocaleTimeString('ru-RU', { hour12: false });
const route = [];   // сводка для route.md
let phase = 'setup'; // setup - жму я; user - жмёт владелец

function LOG(kind, msg) {
  const line = `[${hhmmss()}] ${String(kind).padEnd(8)} ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}
function REC(obj) {
  jsonlStream.write(JSON.stringify({ t: new Date().toISOString(), phase, ...obj }) + '\n');
}

let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* первый запуск */ }
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

function genPassword() {
  // Clerk: минимум 8 символов + проверка на утёкшие пароли, поэтому случайный.
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'Od' + s + '!7';
}

// ── слой 1: запись действий ───────────────────────────────────────────────────
// Ставится в КАЖДЫЙ фрейм до загрузки страницы. Слушатели на capture-фазе, чтобы
// клик попал в лог даже если приложение его потом остановит.
//
// 🪤 ALTCHA - это web-компонент с shadow DOM: `event.target` отдаёт хост-элемент,
// а настоящая галочка внутри тени. Поэтому цель берём из `composedPath()[0]` и
// пишем оба уровня - без этого в логе был бы бесполезный `<altcha-widget>`.
const INIT_SCRIPT = `(() => {
  if (window.__odRecInstalled) return;
  window.__odRecInstalled = true;

  const send = (p) => { try { window.__odRecEvent(p); } catch (e) {} };
  const txt = (el) => ((el.innerText || el.value || el.placeholder || el.getAttribute?.('aria-label') || '') + '')
    .replace(/\\s+/g, ' ').trim().slice(0, 48);
  const masked = (el) => {
    const t = (el.type || '').toLowerCase();
    const n = ((el.name || '') + ' ' + (el.id || '')).toLowerCase();
    return t === 'password' || /pass|pwd|secret/.test(n);
  };
  const desc = (el) => {
    if (!el || !el.tagName) return '?';
    const tag = el.tagName.toLowerCase();
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\\s+/)[0] : '';
    return '<' + tag + (el.id ? '#' + el.id : '') + cls + '> \\u00ab' + txt(el) + '\\u00bb';
  };
  const sel = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let p = cur.tagName.toLowerCase();
      const tid = cur.getAttribute && (cur.getAttribute('data-testid') || cur.getAttribute('data-test-id'));
      if (cur.id) { parts.unshift(p + '#' + cur.id); break; }
      if (tid) { parts.unshift(p + '[data-testid="' + tid + '"]'); break; }
      const nm = cur.getAttribute && cur.getAttribute('name');
      if (nm) p += '[name="' + nm + '"]';
      else {
        const cls = (typeof cur.className === 'string' && cur.className.trim())
          ? '.' + cur.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
        p += cls;
        const par = cur.parentElement;
        if (par) {
          const same = Array.from(par.children).filter(c => c.tagName === cur.tagName);
          if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(p);
      cur = cur.parentElement || (cur.getRootNode() && cur.getRootNode().host) || null;
    }
    return parts.join(' > ');
  };
  const target = (ev) => {
    const path = (ev.composedPath && ev.composedPath()) || [];
    const deep = path.find(n => n && n.nodeType === 1);
    return { deep: deep || ev.target, host: ev.target };
  };

  document.addEventListener('click', (ev) => {
    const { deep, host } = target(ev);
    send({
      kind: 'action', act: 'КЛИК', sel: sel(deep), el: desc(deep),
      shadowHost: deep !== host ? desc(host) : null, url: location.href,
    });
  }, { capture: true, passive: true });

  // Ввод пишем не по букве, а по паузе: иначе лог утонет в посимвольных строках.
  const timers = new WeakMap();
  document.addEventListener('input', (ev) => {
    const el = target(ev).deep;
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => {
      const v = el.value == null ? '' : String(el.value);
      send({
        kind: 'action', act: 'ВВОД', sel: sel(el), el: desc(el),
        value: masked(el) ? '\\u00ab\\u0441\\u043a\\u0440\\u044b\\u0442\\u043e, ' + v.length + '\\u00bb' : v.slice(0, 120),
        url: location.href,
      });
    }, 600));
  }, { capture: true, passive: true });

  document.addEventListener('change', (ev) => {
    const el = target(ev).deep;
    const tag = (el.tagName || '').toLowerCase();
    if (tag !== 'select' && el.type !== 'checkbox' && el.type !== 'radio') return;
    send({
      kind: 'action', act: 'ВЫБОР', sel: sel(el), el: desc(el),
      value: el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : String(el.value),
      url: location.href,
    });
  }, { capture: true, passive: true });

  document.addEventListener('submit', (ev) => {
    send({ kind: 'action', act: 'SUBMIT', sel: sel(ev.target), el: desc(ev.target), url: location.href });
  }, { capture: true, passive: true });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== 'Escape') return;
    const el = target(ev).deep;
    send({ kind: 'action', act: 'КЛАВИША', sel: sel(el), el: desc(el), value: ev.key, url: location.href });
  }, { capture: true, passive: true });
})();`;

const short = (u) => { try { const x = new URL(u); return x.host + x.pathname + x.search; } catch { return u; } };
const isOurs = (u) => SITE_HOSTS.some(h => { try { return new URL(u).host === h || new URL(u).host.endsWith('.' + h); } catch { return false; } });

(async () => {
  console.log('');
  LOG('СТАРТ', `профиль odyssey/profiles/${label} · запись: ${path.basename(logPath)}`);

  const launchOpts = {
    headless: false,
    viewport: null,                                     // грабля #17
    args: ['--window-size=1500,1000', '--window-position=40,20',
      '--disable-blink-features=AutomationControlled'], // как у боевого open-session.js
    recordHar: { path: harPath, content: 'embed' },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1500, height: 1000 } },
  };
  if (!useChromium) launchOpts.channel = 'chrome';      // см. заголовок: Turnstile
  LOG('БРАУЗЕР', useChromium ? 'комплектный Chromium (по флагу --chromium)' : 'настоящий Chrome (channel: chrome)');

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, launchOpts);
  } catch (e) {
    const msg = e.message.split('\n')[0].slice(0, 100);
    // Две разные причины отказа, и лечатся они по-разному, поэтому и попытки две.
    if (launchOpts.channel) {
      LOG('ВНИМАНИЕ', `Chrome не поднялся (${msg}), пробую комплектный Chromium - Turnstile может отбить`);
      delete launchOpts.channel;
      ctx = await chromium.launchPersistentContext(profileDir, launchOpts).catch(async (e2) => {
        LOG('ВНИМАНИЕ', `и без видео тогда (${e2.message.split('\n')[0].slice(0, 80)})`);
        delete launchOpts.recordVideo;
        return chromium.launchPersistentContext(profileDir, launchOpts);
      });
    } else {
      // Видео - приятный бонус, а не условие записи: если движок его не дал, идём без.
      LOG('ВНИМАНИЕ', `запуск с видео не удался (${msg}), поднимаю без видео`);
      delete launchOpts.recordVideo;
      ctx = await chromium.launchPersistentContext(profileDir, launchOpts);
    }
  }

  await ctx.exposeBinding('__odRecEvent', (source, p) => {
    const inFrame = source.frame !== source.page.mainFrame() ? ` [frame ${short(source.frame.url())}]` : '';
    const tail = p.value !== undefined ? `  <- "${p.value}"` : '';
    const shadow = p.shadowHost ? `  (в тени ${p.shadowHost})` : '';
    LOG(p.act, `${p.sel}  -> ${p.el}${shadow}${tail}${inFrame}`);
    REC(p);
    if (phase === 'user') route.push({ k: 'act', act: p.act, sel: p.sel, el: p.el, value: p.value });
  });
  await ctx.addInitScript(INIT_SCRIPT);

  // ── слой 2: HTTP-контракт ───────────────────────────────────────────────────
  ctx.on('request', (req) => {
    const u = req.url();
    if (!isOurs(u) || req.resourceType() === 'image' || req.resourceType() === 'font') return;
    const body = (req.postData() || '').slice(0, 4000) || null;
    REC({ kind: 'request', method: req.method(), url: short(u), body, headers: req.headers() });
    if (req.method() !== 'GET' || /\/v1\/|\/api\//.test(u)) {
      LOG('ЗАПРОС', `${req.method()} ${short(u)}${body ? `  body: ${body.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
      route.push({ k: 'req', method: req.method(), url: short(u), body });
    }
  });

  ctx.on('response', async (res) => {
    const u = res.url();
    if (!isOurs(u)) return;
    const type = res.request().resourceType();
    if (type === 'image' || type === 'font' || type === 'stylesheet') return;
    let body = null;
    try { body = (await res.text()).slice(0, 6000); } catch { body = '<не прочитано>'; }
    const h = res.headers();
    REC({ kind: 'response', status: res.status(), url: short(u), setCookie: h['set-cookie'] || null, body });
    if (res.request().method() !== 'GET' || /\/v1\/|\/api\//.test(u)) {
      LOG('ОТВЕТ', `${res.status()} ${short(u)} :: ${(body || '').replace(/\s+/g, ' ').slice(0, 200)}`);
      route.push({ k: 'res', status: res.status(), url: short(u), body: (body || '').slice(0, 600) });
    }
    // Ключ мог приехать любым ответом - ловим и сохраняем сразу.
    const key = (body || '').match(/sk-[A-Za-z0-9_-]{16,}/);
    if (key && state.api_key !== key[0]) {
      state.api_key = key[0];
      saveState();
      LOG('КЛЮЧ', `🔑 поймал в ответе ${short(u)}: ${key[0]}`);
    }
  });

  ctx.on('page', (p) => {
    LOG('ВКЛАДКА', `новая: ${short(p.url() || 'about:blank')}`);
    p.on('framenavigated', (f) => {
      if (f !== p.mainFrame()) return;
      LOG('ПЕРЕХОД', short(f.url()));
      REC({ kind: 'nav', url: f.url() });
      if (phase === 'user') route.push({ k: 'nav', url: short(f.url()) });
    });
  });

  // ── вкладки: почта + площадка ───────────────────────────────────────────────
  const mailPage = ctx.pages()[0] || await ctx.newPage();
  mailPage.on('framenavigated', (f) => {
    if (f !== mailPage.mainFrame()) return;
    LOG('ПЕРЕХОД', short(f.url()));
    REC({ kind: 'nav', url: f.url() });
  });

  if (!state.password) { state.password = genPassword(); saveState(); }

  if (doMailSetup) {
    // Пере-прогон после сорванной попытки - обычное дело (Turnstile, закрытое окно).
    // Плодить новый адрес каждый раз незачем: пока `POST /v1/client/sign_ups` не ушёл,
    // прежний ящик никем не занят. Свежий - по флагу `--new-mail`.
    const reuse = state.email && !flags.includes('--new-mail');
    LOG('НАСТРОЙКА', `${reuse ? 'открываю прежний ящик' : 'готовлю новый ящик'} на emailnator (жму я, это ещё не запись твоих действий)`);
    try {
      if (reuse) {
        await openInbox(mailPage, state.email);
        LOG('ПОЧТА', `ящик прежний: ${state.email}`);
      } else {
        const email = await createEmail(mailPage);   // сам гасит чипы и включает .Gmail
        state.email = email;
        state.created = new Date().toISOString();
        saveState();
        LOG('ПОЧТА', `адрес готов: ${email}`);
      }
    } catch (e) {
      LOG('ПОЧТА', `не смог подготовить сам (${e.message.split('\n')[0].slice(0, 90)}) - сделай во вкладке руками`);
      await mailPage.goto(MAIL_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  } else {
    await mailPage.goto(MAIL_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  const sitePage = await ctx.newPage();
  await sitePage.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded' }).catch(e => {
    LOG('ВНИМАНИЕ', `страница регистрации не открылась: ${e.message.split('\n')[0]}`);
  });
  await sitePage.bringToFront().catch(() => {});
  try { require('../routing/lib/focus-window.js').raiseBrowserWindow(); } catch { /* не критично */ }

  phase = 'user';   // дальше всё, что попадёт в лог, нажал владелец
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  ЗАПИСЬ ИДЁТ. Дальше всё в логе - твои действия.');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  вкладка 1: emailnator${state.email ? ` (адрес ${state.email})` : ''}`);
  console.log('  вкладка 2: odysseyapi.tech/sign-up');
  if (state.password) console.log(`  пароль наготове: ${state.password}`);
  console.log('');
  console.log('  Проходи регистрацию как удобно: почта, ALTCHA, код из письма,');
  console.log('  потом в кабинете возьми API-ключ - я поймаю его сам из ответа.');
  console.log('  ЗАКОНЧИЛ - просто закрой окно браузера, я соберу сводку.');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');

  await new Promise(resolve => ctx.on('close', resolve));

  // ── сводка маршрута ─────────────────────────────────────────────────────────
  const md = [];
  md.push(`# Odyssey - записанный ручной маршрут регистрации`);
  md.push('');
  md.push(`- Записано: ${new Date().toLocaleString('sv').slice(0, 16)} (MSK)`);
  md.push(`- Профиль: \`odyssey/profiles/${label}/\``);
  md.push(`- Почта: \`${state.email || '(готовил руками)'}\``);
  md.push(`- Ключ: ${state.api_key ? '`' + state.api_key + '`' : 'не поймал в трафике'}`);
  md.push(`- Логи: \`${path.basename(logPath)}\`, \`${path.basename(jsonlPath)}\`, \`${path.basename(harPath)}\``);
  md.push('');
  md.push('## Маршрут по шагам');
  md.push('');
  for (const r of route) {
    if (r.k === 'nav') md.push(`- 🧭 переход -> \`${r.url}\``);
    else if (r.k === 'act') md.push(`- 👉 ${r.act} \`${r.sel}\` -> ${r.el}${r.value !== undefined ? ` <- "${r.value}"` : ''}`);
    else if (r.k === 'req') md.push(`  - → \`${r.method} ${r.url}\`${r.body ? ` body: \`${String(r.body).replace(/\s+/g, ' ').slice(0, 300)}\`` : ''}`);
    else if (r.k === 'res') md.push(`  - ← \`${r.status}\` \`${r.url}\` :: ${String(r.body).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  md.push('');
  fs.writeFileSync(routePath, md.join('\n') + '\n');

  logStream.end();
  jsonlStream.end();
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Запись закрыта. Шагов в маршруте: ${route.length}`);
  console.log(`  лог:      ${logPath}`);
  console.log(`  маршрут:  ${routePath}`);
  console.log(`  HAR:      ${harPath}`);
  if (state.api_key) console.log(`  ключ:     ${state.api_key}`);
  console.log('══════════════════════════════════════════════════════════');
  process.exit(0);
})().catch(e => { LOG('ФАТАЛЬНО', e.stack || e.message); process.exit(1); });
