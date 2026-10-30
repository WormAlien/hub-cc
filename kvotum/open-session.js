'use strict';
// kvotum/open-session.js
//
// Открывает видимый Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ аккаунта (полный профиль
// на диск: история, куки, localStorage, сессии GitHub + KVOTUM).
//
// Панель - СВОЯ (FastAPI SPA), не New API. Механика снята с живого бандла
// витрины (app.js v=32 + landing.js v=32, замер 2026-10-30):
//   • вход - модалка на витрине: GitHub (`/api/auth/oauth/github/start`),
//     Google и Telegram; пароль-регистрации нет вовсе;
//   • аккаунт создаётся АВТОМАТИЧЕСКИ при первом входе (текст модалки),
//     отдельной страницы регистрации нет;
//   • реф-код ловится на КОРНЕ `/?ref=CODE`: бандл матчами
//     `[?&]ref=([0-9a-z]{7,16})` кладёт код в localStorage `ref` И в cookie
//     `ref` на 30 дней (SameSite=Lax). Один заход по реф-ссылке достаточен;
//   • после OAuth площадка возвращает на `#/oauth?token=…` (и для новичка ещё
//     `&key=…` - ГОТОВЫЙ API-ключ!) - SPA кладёт сессионный JWT в
//     localStorage `token`, а ключ в sessionStorage `first_key`. То есть у
//     свежего аккаунта ключ уже создан площадкой - его можно снять скриптом;
//   • API-ключи и их лимиты живут на `#/keys`, баланс - `#/dashboard`
//     (`#/billing` - пополнение: СБП от 100 ₽, CryptoBot от $1).
//
// Сценарий:
//   1. В дашборде добавляешь аккаунт (email, ключ можно оставить пустым),
//      жмёшь 🌐 «Открыть браузер».
//   2. Открывается Chromium с профилем kvotum/profiles/<label>/ (на аккаунт).
//   3. Ключа у аккаунта ещё нет → открывается реф-ссылка и кнопка GitHub.
//      Ключ уже вписан → сразу страница ключей.
//   4. Ключ скрипт берёт сам: у новичка площадка отдаёт его в URL возврата
//      (`first_key`); не достался - создаётся через панельный API (JWT) и всё
//      равно пишется в пул дашборда без рук.
//   5. Профиль сохраняется автоматически - при следующих открытиях GitHub и
//      KVOTUM уже залогинены.
//
// Использование:
//   node kvotum/open-session.js <label> [register|console|auto]
//     label - имя профиля (папка kvotum/profiles/<label>/)
//     режим - register: рефка + GitHub-вход (ключа ещё нет),
//             console:  страница ключей (ключ уже есть),
//             auto (по умолчанию): чистый профиль = register.
//
// Код возврата 0 = профиль открыт, 2 = таймаут ожидания GitHub-логина (первый вход).

const { chromium } = require('playwright');
const { raiseBrowserWindow } = require('../routing/lib/focus-window.js');
const fs = require('fs');
const path = require('path');

// Рефка владельца: из routing/lib/ref-codes.js, а не литералом. Форма своя -
// `/?ref=`, не `/sign-up?aff=` эталона (см. комментарий в ref-codes.js).
const REGISTER_URL = require('../routing/lib/ref-codes.js').url('kvotum');
const ROOT_URL = 'https://myapi.buzz/';
const KEYS_URL = 'https://myapi.buzz/#/keys';
const GH_START_URL = 'https://myapi.buzz/api/auth/oauth/github/start';
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

// Ручной вход в GitHub, сделанный человеком в открытом окне, тоже должен попасть
// в копию сессии (как у nova/premier).
const ghCapture = require('../routing/lib/gh-live-capture.js').makeCapture({
  label,
  moduleDir: __dirname,
  poolFile: path.join(__dirname, '..', 'routing', 'kvotum-sessions.json'),
});

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной GitHub-логин
const HUB = 'http://localhost:8200';

// Авто-запись готового ключа новичка в пул дашборда (два вызова, оба молчат при
// ошибке - вкладка скажет, чего не хватает, но браузер не роняем):
//   /kv/add   - аккаунта ещё нет в пуле: создаём запись по email из панели;
//   /kv/key   - запись есть (владелец добавил руками): вписываем ключ в неё.
// Автоматизирует «создание и сохранение API» (владелец 30.10): после GitHub-входа
// площадка сама отдаёт ключ (sessionStorage first_key), скрипт кладёт его в пул -
// кнопка 🔑 руками остаётся для чужих ключей. Страницу передаёт вызывающий (main).
async function autoSaveKey(page, firstKey) {
  try {
    // Панель знает настоящий email аккаунта: /api/me с JWT из localStorage.
    const token = await page.evaluate(() => {
      try { return localStorage.getItem('token') || ''; } catch { return ''; }
    });
    let email = '';
    if (token) {
      const me = await fetch('https://myapi.buzz/api/me', { headers: { Authorization: 'Bearer ' + token } })
        .then(r => (r.ok ? r.json() : null)).catch(() => null);
      email = me && me.email ? me.email : '';
    }
    const list = await fetch(`${HUB}/__switch/api/kv/sessions`).then(r => (r.ok ? r.json() : null)).catch(() => null);
    const rows = (list && list.sessions) || [];
    const byKey = rows.find(s => s.api_key === firstKey);
    if (byKey) return `ключ уже в пуле (${byKey.id}) - ничего не делаю`;
    const byEmail = email && rows.find(s => s.email === email);
    if (byEmail && !/^sk-/.test(String(byEmail.api_key || ''))) {
      const r = await fetch(`${HUB}/__switch/api/kv/key`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: byEmail.id, api_key: firstKey }),
      }).then(r => r.json()).catch(() => null);
      return r && r.ok ? `ключ вписан в запись ${byEmail.id} (${email})` : 'не вписал: дашборд отказал (/kv/key)';
    }
    if (email) {
      const r = await fetch(`${HUB}/__switch/api/kv/add`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, api_key: firstKey }),
      }).then(r => r.json()).catch(() => null);
      return r && r.ok ? `аккаунт ${email} добавлен в пул с ключом (${r.id})` : 'не добавил: дашборд отказал (/kv/add)';
    }
    return 'не добавил: панель не назвала email (сессия без JWT)';
  } catch (e) {
    return 'не добавил: ' + e.message;
  }
}

// Если рядом лежит <label>.json - применяем как storageState: cookies + localStorage.
// Два источника, различать обязательно:
//   share-код друга   → аккаунт KVOTUM уже создан, всё залогинено;
//   seed:'github'     → только GitHub-куки, аккаунта KVOTUM ещё НЕТ.
function loadImportedSession() {
  try {
    const p = path.join(SESSIONS_DIR, label + '.json');
    if (!fs.existsSync(p)) return null;
    const ss = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!ss || typeof ss !== 'object') return null;
    return {
      seed: ss.seed === 'github' ? 'github' : null,
      ghLogin: typeof ss.ghLogin === 'string' ? ss.ghLogin : null,
      cookies: Array.isArray(ss.cookies) ? ss.cookies : [],
      origins: Array.isArray(ss.origins) ? ss.origins : [],
    };
  } catch { return null; }
}

async function applyImportedSession(context, session) {
  if (!session) return false;
  let applied = false;
  if (session.cookies && session.cookies.length) {
    try {
      await context.addCookies(session.cookies);
      applied = true;
    } catch (e) {
      console.log(`⚠️ часть cookies не применилась: ${e.message}`);
    }
  }
  // localStorage: addInitScript до goto, чтобы каждый origin получил свои ключи.
  const lsOrigins = (session.origins || []).filter(o => o.localStorage && o.localStorage.length);
  for (const o of lsOrigins) {
    try {
      await context.addInitScript(
        (entries) => { for (const { name, value } of entries) { try { localStorage.setItem(name, value); } catch {} } },
        o.localStorage.map(({ name, value }) => ({ name, value })),
      );
      applied = true;
    } catch { /* origin может быть невалидным - пропускаем */ }
  }
  return applied;
}

// Первый ли запуск профиля: нет файла Default/Preferences → чистый профиль.
function isFreshProfile() {
  try {
    const prefs = path.join(profileDir, 'Default', 'Preferences');
    return !fs.existsSync(prefs);
  } catch { return true; }
}

// Сессия панели у KVOTUM - НЕ кука, а JWT в localStorage `token`
// (`localStorage.setItem('token', r.token)` в бандле). Поэтому «мы внутри»
// проверяется чтением localStorage, а не кук: куки сайта (cf_clearance и
// прочие) есть до всякого входа и за вход не отвечают.
async function panelToken(page) {
  return page.evaluate(() => {
    try { return localStorage.getItem('token') || ''; } catch { return ''; }
  }).catch(() => '');
}

// Chromium кеширует и 404-ответы: осевший 404 на бандле SPA ломает витрину
// навсегда (тот же класс, что у NewAPI-фронтов на ar-аккаунтах). Ходим мимо
// HTTP-кеша, сессия и localStorage остаются.
async function disableHttpCache(context, page) {
  const apply = async (p) => {
    try {
      const cdp = await context.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    } catch { /* без кеш-бага страница живёт и так */ }
  };
  context.on('page', p => { apply(p); });
  await apply(page);
}

// Реф-код: заход по реф-ссылке кладёт код в localStorage `ref` + cookie на
// 30 дней. Проверяем оседание и печатаем результат.
async function openRegisterViaRef(page) {
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const ref = await page.evaluate(() => {
    try { return localStorage.getItem('ref'); } catch { return null; }
  }).catch(() => null);
  console.log(ref
    ? `🤝 реф-код сохранён в профиль: ref=${ref}`
    : '⚠️  реф-код не осел в localStorage - регистрация может не зачесться');
}

// Ждём сессию панели: вернулись с GitHub на myapi.buzz И в localStorage
// появился JWT. Попутно снимаем first_key - готовый ключ новичка (см. ниже).
async function waitForPanelLogin(page) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const token = await panelToken(page);
    if (token) {
      const firstKey = await page.evaluate(() => {
        try { return sessionStorage.getItem('first_key') || ''; } catch { return ''; }
      }).catch(() => '');
      return { ok: true, token, firstKey };
    }
    await page.waitForTimeout(1500);
  }
  return { ok: false };
}

// 🪤 first_key живёт РОВНО ОДИН раз: площадка создаёт ключ сама при ПЕРВОМ входе
// нового аккаунта и отдаёт его в URL возврата OAuth (`#/oauth?token=…&key=…`),
// SPA кладёт в sessionStorage и показывает на дашборде один раз. У существующего
// аккаунта first_key не бывает вовсе - раньше ключ пришлось бы создавать руками
// в панели («Новый API-ключ», показывается один раз).
//
// Замер 30.10: JWT сессии принимает и СОЗДАНИЕ ключа - POST /api/me/keys с телом
// формы панели ({name, spend_limit, clear_limit, limit_period, allowed_models,
// expires_on, rpm_limit}) отвечает 200 и отдаёт ПОЛНЫЙ ключ в поле `key`
// (подтверждено живой пробой: ключ создан и удалён тем же JWT). Поэтому когда
// first_key не достался - ключ создаём сами, руками в панель ходить не нужно.
async function createPanelKey(token, name = 'hub') {
  const r = await fetch('https://myapi.buzz/api/me/keys', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, spend_limit: null, clear_limit: true, limit_period: 'total',
      allowed_models: [], expires_on: null, rpm_limit: null,
    }),
  }).catch(() => null);
  if (!r || !r.ok) return '';
  const k = await r.json().catch(() => null);
  return (k && k.key) ? k.key : '';
}

// Готовый ключ: first_key (бесплатный подарок новичку) или свежесозданный панелью.
async function ensurePanelKey(res) {
  if (res.firstKey) return res.firstKey;
  console.log('ℹ️  first_key не достался (аккаунт не новый либо окно закрыли до возврата) - создаю ключ через панельный API…');
  const made = await createPanelKey(res.token);
  if (made) console.log(`🔑 ключ создан панелью автоматически: ${made}`);
  return made;
}

async function main() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();
  const imported = loadImportedSession();

  console.log('🚀 Запускаю Chromium (видимый режим)…');
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен GitHub-логин)' : 'уже есть (сохранённый)'}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    channel: 'chrome',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--window-size=600,1000', '--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.bringToFront();
  raiseBrowserWindow();
  await disableHttpCache(context, page);

  let appliedSession = false;
  if (fresh && imported) {
    appliedSession = await applyImportedSession(context, imported);
  }

  const seededGithub = appliedSession && imported && imported.seed === 'github';
  if (seededGithub) {
    console.log(`🐙 GitHub-сессия заселена${imported.ghLogin ? ` (${imported.ghLogin})` : ''} - пароль и 2FA не понадобятся, жми «Продолжить с GitHub».`);
  }

  const wantRegister = (appliedSession && !seededGithub) ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;                                   // 'auto': чистый профиль = регистрация
  console.log(`🎯 ${wantRegister ? `регистрация по рефке: ${REGISTER_URL}` : `ключи: ${KEYS_URL}`}`);

  try {
    if (appliedSession && !seededGithub) {
      await page.goto(KEYS_URL, { waitUntil: 'domcontentloaded' });
      console.log('✅ Импортированная сессия применена (KVOTUM уже залогинен).');
      console.log('   Браузер открыт - закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context); // держим открытым, закрытие - вручную
      return;
    }

    if (wantRegister) {
      await openRegisterViaRef(page);
      console.log('⚠️  Регистрация по рефке. Жми «Продолжить с GitHub» на открывшейся странице.');
      // GitHub-OAuth - прямая ссылка с витрины; согласие GitHub подтверждает
      // человек (аккаунт создаётся площадкой автоматически после возврата).
      await page.goto(GH_START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

      const res = await waitForPanelLogin(page);
      if (!res.ok) {
        console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
        process.exit(2);
      }
      const key = await ensurePanelKey(res);
      if (key) {
        console.log('🤖 ' + await autoSaveKey(page, key));
      } else {
        console.log('⚠️  Ключа нет (ни first_key, ни созданного) - возьми ключ на #/keys вручную.');
      }
      await page.goto(KEYS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      console.log('✅ Вход выполнен, профиль сохранён на диск.');
      console.log('   Браузер остаётся открытым - закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context);
      return;
    }

    // Вход, а не регистрация. Но у СВЕЖЕГО/заселённого профиля аккаунта может
    // ещё не быть - тогда GitHub-вход создаст его БЕЗ реф-кода. Ровно так у
    // друга ушёл реф-кредит на tabitoken (2026-08-21). Поэтому сначала рефка
    // (код переживает переходы в localStorage/cookie), потом GitHub.
    if (fresh || !(await panelToken(page))) {
      await openRegisterViaRef(page);
      if (/github\.com/i.test(page.url())) {
        console.log('↪️  сайт сам ушёл на GitHub-вход - жди входа, реф-код уже в профиле');
      } else {
        await page.goto(GH_START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      const res = await waitForPanelLogin(page);
      if (!res.ok) {
        console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
        process.exit(2);
      }
      const key = await ensurePanelKey(res);
      if (key) console.log('🤖 ' + await autoSaveKey(page, key));
    }
    if (!/github\.com/i.test(page.url())) {
      await page.goto(KEYS_URL, { waitUntil: 'domcontentloaded' });
    }

    if (!fresh) {
      console.log('✅ Профиль восстановлен (KVOTUM уже залогинен, если заходил раньше).');
      console.log('   Браузер открыт - закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context);
      return;
    }

    console.log('✅ Вход выполнен, профиль сохранён на диск. Браузер остаётся открытым - закрой когда закончишь (Ctrl+C).');
    await ghCapture.holdOpen(context);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
