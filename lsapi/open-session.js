// lsapi/open-session.js
//
// Открывает видимый Chromium с персональным профилем аккаунта Lingshu (lsapi.cloud).
// Профиль сохраняет историю, cookies, localStorage и сессию панели на диск.
//
// Использование:
//   node lsapi/open-session.js <label> [register|console|auto]
//     label - имя профиля (папка lsapi/profiles/<label>/)
//     mode - register: форма регистрации по реф-ссылке,
//            console: консоль аккаунта,
//            auto (по умолчанию): чистый профиль = register, иначе console.
//
// Email и пароль берутся только из LS_LK_EMAIL и LS_LK_PASS. В argv они не передаются.
// Окно остаётся открытым до закрытия пользователем.
//
// Взят у aikeysapi/open-session.js: это единственная в репозитории версия, которая умеет
// отличать «кука живая» от «SPA считает, что вход сделан» (см. isLoginPage ниже).
// Реф-код при этом берётся из routing/lib/ref-codes.js, а не литералом: одна точка на
// репозиторий, иначе забытая правка = потерянный реф-кредит.

const { chromium } = require('playwright');
const { raiseBrowserWindow } = require('../routing/lib/focus-window.js');
const fs = require('fs');
const path = require('path');

// Ссылка вида https://lsapi.cloud/sign-up?aff=YaPV, код владельца - дефолтом
// в routing/ref-codes.default.json, свой вписывается через «Настройки» дашборда.
const REGISTER_URL = require('../routing/lib/ref-codes.js').url('lsapi');
// 🪤 Консоль у этой панели открывается не на `/console`, а на `/wallet` — решение владельца
// 21.09: «по кнопке 🌐 должна открываться https://lsapi.cloud/wallet». Там же лежит баланс
// и пополнение, ради которых в ЛК и заходят.
const CONSOLE_URL = 'https://lsapi.cloud/wallet';
const ROOT_URL = 'https://lsapi.cloud/';
const STATUS_URL = 'https://lsapi.cloud/api/status';
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const POOL_FILE = path.join(__dirname, '..', 'routing', 'lsapi-sessions.json');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

// Окно живёт до Ctrl+C: обещание резолвится только при закрытии контекста.
function holdOpen(context) {
  return new Promise((resolve) => { context.on('close', resolve); });
}

// Импортированный share-снимок может содержать cookies и localStorage уже созданного
// аккаунта. GitHub-only snapshots намеренно игнорируются: у Lingshu нет GitHub-входа.
function loadImportedSession() {
  try {
    const p = path.join(SESSIONS_DIR, label + '.json');
    if (!fs.existsSync(p)) return null;
    const ss = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!ss || typeof ss !== 'object') return null;
    if (ss.seed === 'github') return { ghSeedOnly: true };
    return {
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

function isFreshProfile() {
  try {
    const prefs = path.join(profileDir, 'Default', 'Preferences');
    return !fs.existsSync(prefs);
  } catch { return true; }
}

const SITE_HOST = new URL(ROOT_URL).hostname.toLowerCase();
const CF_COOKIE_RE = /^(cf_clearance|__cf_bm|_cfuvid|cf_chl)/i;
const SITE_SESSION_RE = /session|token|access|auth|refresh|new_api/i;
function hasSessionCookie(cookies) {
  return cookies.some(c => {
    const d = String(c.domain || c.host || '').replace(/^\./, '').toLowerCase();
    if (d !== SITE_HOST && !d.endsWith('.' + SITE_HOST)) return false;
    return !CF_COOKIE_RE.test(c.name) && SITE_SESSION_RE.test(c.name) && !!c.value;
  });
}

async function disableHttpCache(context, page) {
  const apply = async (p) => {
    try {
      const cdp = await context.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    } catch { /* без кеш-бага страница живёт и так - не роняем открытие */ }
  };
  context.on('page', p => { apply(p); });
  await apply(page);
}

async function reportRender(page) {
  const ok = await page.waitForFunction(
    () => { const r = document.getElementById('root'); return !!r && r.innerHTML.length > 200; },
    { timeout: 15000 },
  ).then(() => true).catch(() => false);
  console.log(ok
    ? '✅ страница отрисовалась'
    : '⚠️  белый экран: SPA не поднялась - жми F5, в DevTools ищи 404 на /static/js/*.js');
}

// Панель - SPA, и «я вошёл» она держит в localStorage, а не в адресе страницы: на
// `/console` без входа отдаётся форма логина по ТОМУ ЖЕ URL. Поэтому судить по `page.url()`
// нельзя - смотрим на саму форму.
async function isLoginPage(page) {
  try {
    return await page.evaluate(() => {
      const p = document.querySelector('input[type="password"]');
      if (!p) return false;
      const r = p.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  } catch { return false; }
}

// Само-лечение для 🌐: оказались на форме входа, а снимок есть - применяем его НА МЕСТЕ
// и перезагружаем.
//
// Зачем, если снимок уже применён выше: куки в профиль пишет ещё и
// `newapiSyncProfile()` (из общего jar), и он это делает БЕЗ состояния SPA. Порядок
// «кука уже лежала в профиле - снимок не применяли» оставлял владельца на форме входа
// при живом снимке рядом. Здесь это лечится без разбора причин: раз мы на логине, терять
// нечего - перезапись куки ничего не ломает.
//
// `addInitScript` срабатывает на СЛЕДУЮЩЕЙ навигации, поэтому перезагрузка обязательна,
// а не косметика.
async function trySnapshotRecovery(page, context, shared) {
  if (!shared) return false;
  await applyImportedSession(context, shared);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(4000);
  return !(await isLoginPage(page));
}

async function preflight() {
  try {
    const r = await fetch(STATUS_URL, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json' },
    });
    if (r.status !== 200) return { ok: false, error: `api/status HTTP ${r.status}` };
    const d = ((await r.json()) || {}).data || {};
    return {
      ok: true,
      registration: d.register_enabled !== false && d.password_register_enabled !== false,
      passwordLogin: d.password_login_enabled !== false,
      emailVerify: d.email_verification === true,
      turnstile: d.turnstile_check === true,
      site: d.system_name || 'Lingshu',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

const SITE_ERRORS = [
  {
    code: 'no_register',
    terminal: true,
    re: /new (user )?registration (is )?(disabled|closed)|registration (is )?disabled by (the )?admin|(clos|disabl)\w* new (user )?registration|管理员关闭了新用户注册|регистрац[а-яё]* (нов[а-яё]* [а-яё]* )?(закрыт|отключен)|закрыл[а-яё]* регистрацию/i,
    msg: '❌ Lingshu закрыл регистрацию новых аккаунтов (ответ панели) - этот аккаунт создать нельзя.',
  },
];

async function siteError(page) {
  let text = '';
  try { text = await page.evaluate(() => document.body ? document.body.innerText : ''); } catch { return null; }
  return SITE_ERRORS.find(e => e.re.test(text)) || null;
}

async function openRegister(page) {
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const readAff = () => page
    .evaluate(() => { try { return localStorage.getItem('aff'); } catch { return null; } })
    .catch(() => null);

  const aff = await readAff();
  if (aff) {
    console.log(`🤝 реф-код сохранён в профиль: aff=${aff}`);
    return;
  }

  console.log('⚠️  реф-код не осел с первого раза - прогреваю корень и захожу заново');
  await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const aff2 = await readAff();
  console.log(aff2
    ? `🤝 реф-код сохранён в профиль со второй попытки: aff=${aff2}`
    : '⚠️  реф-код так и не осел в localStorage - регистрация может не зачесться');
}

const AUTH_PAGE_RE = /\/sign-in|\/sign-up|\/register|\/otp|\/forgot-password|\/reset/;
async function waitForLogin(page, context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const seen = new Set();
  while (Date.now() < deadline) {
    const cookies = await context.cookies().catch(() => []);
    if (!AUTH_PAGE_RE.test(page.url()) && hasSessionCookie(cookies)) return { ok: true };

    const err = await siteError(page);
    if (err && !seen.has(err.code)) {
      seen.add(err.code);
      console.log(err.msg);
      if (err.terminal) return { ok: false, err };
    }
    await page.waitForTimeout(1500);
  }
  return { ok: false };
}

// Кнопку входа не нажимаем: панель может потребовать код из письма.
// Это только удобная подстановка кредов из окружения, не автоматический логин.
async function prefillLogin(page) {
  const email = String(process.env.LS_LK_EMAIL || '').trim();
  const pass = String(process.env.LS_LK_PASS || '');
  if (!email && !pass) return false;
  try {
    const emailSel = 'input[name="username"], input[name="email"], input[type="email"], input[id*="username" i], input[id*="email" i]';
    const passSel = 'input[name="password"], input[type="password"]';
    await page.waitForSelector(passSel, { timeout: 20000 });
    if (email) {
      const e = page.locator(emailSel).first();
      if (await e.count()) await e.fill(email);
    }
    if (pass) {
      // 🪤 Форма РЕГИСТРАЦИИ Lingshu просит пароль дважды — «Пароль» и «Подтвердить
      // пароль» (замер 21.09, открытие /sign-up?aff=), а форма входа — один раз.
      // Заполняем ВСЕ поля пароля: на входе оно одно и поведение прежнее, на регистрации
      // закрывается и подтверждение, и владельцу остаётся нажать кнопку.
      const fields = page.locator(passSel);
      const n = await fields.count();
      for (let i = 0; i < n; i++) await fields.nth(i).fill(pass);
    }
    console.log(`🔐 Логин подставлен из переменных окружения${pass ? ' (email и пароль)' : ' (только email - пароля нет)'}.`);
    console.log('   Кнопку входа нажми сам: панель может спросить код с почты.');
    return true;
  } catch (e) {
    console.log(`ℹ️  Поле пароля не найдено (${e.message.split('\n')[0]}) - вход руками.`);
    return false;
  }
}

async function main() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();
  const imported = loadImportedSession();
  if (imported && imported.ghSeedOnly) {
    console.log('⚠️  Рядом лежит снимок только GitHub-сессии: Lingshu не поддерживает GitHub-вход, игнорирую файл.');
  }
  const shared = imported && !imported.ghSeedOnly ? imported : null;

  console.log('🚀 Запускаю Chromium (видимый режим)…');
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен вход почтой)' : 'уже есть (сохранённый)'}`);
  console.log(`🗂️  пул сессий: ${POOL_FILE}`);

  const pre = await preflight();
  if (!pre.ok) {
    console.log(`⚠️  предполётная проверка панели не удалась (${pre.error}) - открываю окно как есть.`);
  } else {
    console.log(`🛰️  ${pre.site}: регистрация ${pre.registration ? 'открыта' : 'ЗАКРЫТА'},`
      + ` вход паролем ${pre.passwordLogin ? 'есть' : 'ВЫКЛЮЧЕН'},`
      + ` код на почту ${pre.emailVerify ? 'нужен' : 'не нужен'},`
      + ` капча ${pre.turnstile ? 'есть' : 'нет'}`);
    if (!pre.registration) console.log('   ❌ Новый аккаунт создать нельзя - панель закрыла регистрацию. Окно всё равно открою.');
    if (!pre.passwordLogin) console.log('   ❌ Вход паролем выключен, а других путей у Lingshu нет.');
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    // Разрешаем расширения в окне (друг ставит своё прокси-расширение): снимаем
    // дефолтный --disable-extensions Playwright и берём системный Chrome -
    // Chrome Web Store ставит расширения только в него, не в комплектный Chromium.
    channel: 'chrome',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--window-size=600,1000', '--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.bringToFront();
  raiseBrowserWindow();
  await disableHttpCache(context, page);

  // Снимок применяем, когда в САМОМ ПРОФИЛЕ нет живой сессии, - а не только когда профиль
  // чистый.
  //
  // 🪤 Раньше здесь стояло `fresh && shared`. На любом уже существующем профиле снимок
  // молча игнорировался, открывалась консоль, и скрипт печатал «уже залогинен» - ничего не
  // проверив. Владелец видел форму входа при живом снимке рядом. Каталог профиля создаётся
  // первым же открытием окна, так что «не чистый» - это обычный случай, а не редкий.
  const existingCookies = await context.cookies().catch(() => []);
  const needSnapshot = !!shared && (fresh || !hasSessionCookie(existingCookies));
  const appliedSession = needSnapshot ? await applyImportedSession(context, shared) : false;
  const wantRegister = appliedSession ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;
  console.log(`🎯 ${wantRegister ? `регистрация: ${REGISTER_URL}` : `консоль: ${CONSOLE_URL}`}`);

  try {
    if (appliedSession) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await reportRender(page);
      if (await isLoginPage(page)) {
        // Честно: снимок применился, но входа в нём не хватило. Молчать здесь нельзя -
        // именно молчание и превращало это в «кнопка 🌐 открывает логин».
        if (await trySnapshotRecovery(page, context, shared)) {
          console.log('✅ Снимок применён со второй попытки - Lingshu уже залогинен.');
        } else {
          console.log('⚠️  Снимок применён, но панель показывает ФОРМУ ВХОДА.');
          console.log('   Причина, как правило, одна: снимок без состояния входа SPA (localStorage.user).');
          console.log('   Кука при этом живая - API отвечает 200, а SPA про вход не знает.');
          console.log('   Пересобери снимок: node lsapi/refresh-sessions.js');
        }
      } else {
        console.log('✅ Снимок применён - Lingshu уже залогинен.');
      }
      console.log('   Браузер открыт - закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    if (wantRegister) {
      await openRegister(page);
      console.log('⚠️  Регистрация по реф-ссылке. Введи email и пароль, затем пройди код почты, если панель его попросит.');
      await prefillLogin(page);

      const res = await waitForLogin(page, context);
      if (!res.ok) {
        if (res.err && res.err.code === 'no_register') {
          console.error('❌ Регистрация Lingshu закрыта администратором - новый аккаунт не создать.');
          console.error('   Браузер оставляю открытым: ответ панели видно на странице.');
          await holdOpen(context);
          return;
        }
        console.error('❌ Таймаут ожидания входа (10 мин). Закрываю.');
        process.exit(2);
      }
      await reportRender(page);
      console.log('✅ Вход выполнен, профиль сохранён на диск. Забирай ключ в консоли.');
      console.log('   Браузер остаётся открытым - закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    if (!fresh) {
      await reportRender(page);
      // 🪤 Здесь стояло безусловное «уже залогинен, если заходил раньше» - утверждение,
      // которое никто не проверял. Профиль на диске сам по себе не значит вход: сессия
      // могла истечь, а снимок - не примениться.
      if (await isLoginPage(page)) {
        if (await trySnapshotRecovery(page, context, shared)) {
          console.log('✅ Снимок из пула применён - Lingshu уже залогинен.');
        } else {
          console.log('⚠️  Профиль на диске есть, но вход НЕ выполнен - открыта форма входа.');
          console.log('   Войди паролем вручную (он есть в записи аккаунта на вкладке) либо');
          console.log('   пересобери снимок: node lsapi/refresh-sessions.js');
        }
      } else {
        console.log('✅ Профиль восстановлен - Lingshu уже залогинен.');
      }
      console.log('   Браузер открыт - закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    console.log('⚠️  Первый вход. Залогинься email + паролем на открывшейся странице, затем возьми ключ в консоли.');
    await prefillLogin(page);
    const res = await waitForLogin(page, context);
    if (!res.ok) {
      console.error('❌ Таймаут ожидания входа (10 мин). Закрываю.');
      process.exit(2);
    }
    console.log('✅ Вход выполнен, профиль сохранён на диск. Браузер остаётся открытым - закрой когда закончишь (Ctrl+C).');
    await holdOpen(context);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
