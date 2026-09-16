// odyssey/open-session.js
//
// Открывает видимый Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ аккаунта (полный профиль
// на диск: история, куки, localStorage, сессия Odyssey).
//
// Площадка — СВОЙ шлюз на Next.js, а не New API: `GET /api/status` отдаёт HTML
// страницы, привычных `/api/user/*` нет вовсе (замер 16.09). Вход держит Clerk
// (`clerk.odysseyapi.tech`), поэтому у скрипта две отличительные черты.
//
// 🪤 Первое: у площадки НЕТ ни GitHub-входа, ни Google-входа. Замер публичного
// окружения Clerk 16.09: `social` содержит ровно один провайдер — `oauth_discord`.
// Значит вся GitHub-машинерия эталона вырезана (ждать кнопку, которой нет, значит
// висеть десять минут и соврать в лог «таймаут GitHub-логина»), а с ней — и
// Google-ветка, которую сохранял соседний bai. Уезжает сайт только на discord.com.
//
// 🪤 Второе: реф-программы у площадки нет ни на сайте, ни в API (проверено 16.09),
// поэтому `openRegisterViaRef` здесь — просто «открыть /sign-up»: сажать в
// localStorage нечего, и ветки «код не осел» тоже нет. Ключ реферала не теряется —
// его просто не существует.
//
// Что ещё сказало окружение Clerk (и что из этого следует):
//   • почта обязательна и подтверждается кодом, пароль есть (`password: true`),
//     первые факторы: `email_code`, `oauth_discord`, `password`;
//   • `captcha_enabled: true`, тип `smart` — умная капча Clerk. Она невидима
//     для человека и включается на подозрительном трафике, поэтому авто-заведения
//     (⚡) у вкладки НЕТ: сценарий без человека тут не гарантирован;
//   • `block_email_subaddresses: true` и `block_disposable_email_domains: true` —
//     плюс-алиасы (`user+tag@`) и одноразовые почты на регистрации не пройдут.
//     Нужны живые адреса: ровно то, чем владелец и собирается входить;
//   • телефон и username выключены — логин только по почте.
//
// Сценарий:
//   1. В дашборде добавляешь аккаунт (email, ключ можно оставить пустым), жмёшь
//      🌐 «Открыть браузер».
//   2. Открывается Chromium с профилем odyssey/profiles/<label>/ (на аккаунт).
//   3. Ключа у аккаунта ещё нет → открывается регистрация. Ключ уже вписан →
//      открывается страница кабинета.
//   4. Регистрируешься руками: почта + пароль, код из письма, капчу проходишь сам
//      (или вход через Discord). Затем в кабинете возьми API-ключ и вставь его в
//      аккаунт кнопкой 🔑 на дашборде (или впиши сразу при добавлении).
//   5. Профиль сохраняется автоматически — при следующих открытиях Odyssey уже
//      залогинен.
//
// Использование:
//   node odyssey/open-session.js <label> [register|console|auto]
//     label — имя профиля (папка odyssey/profiles/<label>/)
//     режим — register: страница регистрации (у аккаунта ещё нет sk-ключа),
//             console:  кабинет (ключ уже есть),
//             auto (по умолчанию): чистый профиль = register, иначе console.
//
// Код возврата 0 = профиль открыт, 2 = таймаут ожидания входа (первый вход).

const { chromium } = require('playwright');
const { raiseBrowserWindow } = require('../routing/lib/focus-window.js');
const fs = require('fs');
const path = require('path');

// Реф-ссылки нет (у площадки нет реф-программы), поэтому здесь литерал, а не
// `ref-codes.url('odyssey')`: звать реестр, в котором для этого шлюза заведомо
// пусто, значило бы оставить читателю загадку.
const REGISTER_URL = 'https://odysseyapi.tech/sign-up';
// Ключ уже вписан → сразу кабинет, а не логин. Именно `/dashboard`: корень — это
// маркетинговая страница Next.js.
const CONSOLE_URL = 'https://odysseyapi.tech/dashboard';
// Корень нужен как источник SITE_HOST для проверки куки ЛК (см. hasSessionCookie)
// и как страница прогрева.
const ROOT_URL = 'https://odysseyapi.tech/';
// Публичное окружение Clerk: из него видно, какие входы вообще открыты. Это
// замена предполётной проверке New API — у площадки своей `/api/status` нет.
const CLERK_ENV_URL = 'https://clerk.odysseyapi.tech/v1/environment'
  + '?__clerk_api_version=2025-04-10&_clerk_js_version=5.0.0';
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной вход (капча + почта)

// Окно живёт до Ctrl+C: обещание резолвится только на закрытии контекста.
function holdOpen(context) {
  return new Promise((resolve) => { context.on('close', resolve); });
}

// Если рядом лежит <label>.json — применяем его как storageState: cookies + localStorage.
// Два разных источника такого файла, и различать их обязательно:
//   share-код друга      → аккаунт уже создан, панель сразу залогинена;
//   seed:'github'        → файл от GitHub-менеджера, к Odyssey отношения не имеет.
function loadImportedSession() {
  try {
    const p = path.join(SESSIONS_DIR, label + '.json');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const ss = JSON.parse(raw);
    if (!ss || typeof ss !== 'object') return null;
    // seed:'github' — в файле ТОЛЬКО GitHub-куки, его положил дашборд кнопкой «взять
    // готовый GitHub». Для odyssey он бесполезен (входа через GitHub нет), но и молча
    // применить его нельзя: ветка ниже приняла бы файл за готовый аккаунт друга и увела
    // бы в кабинет аккаунта, которого не существует, — вместо страницы регистрации.
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
  // localStorage: вставляем addInitScript до goto, чтобы каждый origin получил свои ключи.
  const lsOrigins = (session.origins || []).filter(o => o.localStorage && o.localStorage.length);
  for (const o of lsOrigins) {
    try {
      await context.addInitScript(
        (entries) => { for (const { name, value } of entries) { try { localStorage.setItem(name, value); } catch {} } },
        o.localStorage.map(({ name, value }) => ({ name, value })),
      );
      applied = true;
    } catch { /* origin может быть невалидным — пропускаем */ }
  }
  return applied;
}

// Первый ли запуск профиля: нет файла Default/Preferences → чистый профиль, ждём логин.
function isFreshProfile() {
  try {
    const prefs = path.join(profileDir, 'Default', 'Preferences');
    return !fs.existsSync(prefs);
  } catch { return true; }
}

// Кука ЛК СВОЕГО домена = мы действительно внутри. Раньше проверялась любая кука
// контекста, и это давало ложный позитив: после заселения GitHub-сессии в профиле
// сразу лежит `user_session` от github.com — waitForLogin возвращал true мгновенно и
// печатал «Вход выполнен», хотя на сайт мы не вошли. Поймано 2026-08-21 на tabitoken:
// скрипт отрапортовал успех, а в профиле от сайта осел только `cf_clearance`.
// Cloudflare-куки в зачёт не идут — они появляются до всякого входа.
//
// 🪤 У Odyssey ЛК держит Clerk, а не New API, поэтому набор кук свой: сессионные
// `__session` / `__client_uat` (и `__clerk_db_jwt` на dev-инстансах). `session` в
// списке ловит `__session`; `clerk` и `uat` добавлены под Clerk-имена — без них
// проверка осталась бы на чужих куках, то есть ровно на той грабле, что выше.
const SITE_HOST = new URL(ROOT_URL).hostname.toLowerCase();
const CF_COOKIE_RE = /^(cf_clearance|__cf_bm|_cfuvid|cf_chl)/i;
const SITE_SESSION_RE = /session|token|access|auth|refresh|new_api|clerk|uat/i;
function hasSessionCookie(cookies) {
  return cookies.some(c => {
    const d = String(c.domain || c.host || '').replace(/^\./, '').toLowerCase();
    if (d !== SITE_HOST && !d.endsWith('.' + SITE_HOST)) return false;
    return !CF_COOKIE_RE.test(c.name) && SITE_SESSION_RE.test(c.name) && !!c.value;
  });
}

// Chromium кеширует и 404-ответы. Если на `/assets/index-<hash>.js` однажды прилетел
// 404 (деплой сайта / затык WAF), он оседает в кеше профиля — и SPA больше не
// поднимается НИКОГДА: на каждом открытии белый экран, хотя куки и логин живые
// (поймано на ar-аккаунтах 2026-08-17). Кеш профиля чистить вслепую нельзя, поэтому
// ходим мимо HTTP-кеша: сессия и localStorage остаются на месте. Вешаем и на новые
// вкладки — внешний вход (Discord) умеет открываться попапом.
async function disableHttpCache(context, page) {
  const apply = async (p) => {
    try {
      const cdp = await context.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    } catch { /* без кеш-бага страница живёт и так — не роняем открытие */ }
  };
  context.on('page', p => { apply(p); });
  await apply(page);
}

// Белый экран должен быть виден в Server Logs, а не только глазами пользователя.
async function reportRender(page) {
  const ok = await page.waitForFunction(
    () => { const r = document.getElementById('root') || document.body; return !!r && r.innerHTML.length > 200; },
    { timeout: 15000 },
  ).then(() => true).catch(() => false);
  console.log(ok
    ? '✅ страница отрисовалась'
    : '⚠️  белый экран: SPA не поднялась — жми F5, в DevTools ищи 404 на /_next/*.js');
}

// Предполётная проверка вместо угадывания текстов ошибок. Своей `/api/status` у
// площадки нет (это Next.js), но у Clerk окружение публичное, и из него видно всё
// нужное: открыта ли регистрация, какие факторы входа включены, есть ли капча.
// Здесь это особенно дорого стоит: вход у площадки ручной, и знать заранее, какие
// пути открыты, значит не гонять человека по трём формам вслепую.
async function preflight() {
  try {
    const r = await fetch(CLERK_ENV_URL, {
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: 'application/json',
        Origin: 'https://odysseyapi.tech',
        Referer: 'https://odysseyapi.tech/sign-up',
      },
    });
    if (r.status !== 200) return { ok: false, error: `clerk environment HTTP ${r.status}` };
    const d = (await r.json()) || {};
    const us = d.user_settings || {};
    const at = us.attributes || {};
    const social = us.social || {};
    const factors = ((d.auth_config || {}).first_factors) || [];
    return {
      ok: true,
      registration: (us.sign_up || {}).mode !== 'restricted',
      passwordLogin: !!(at.password || {}).enabled && factors.includes('password'),
      discord: social.oauth_discord ? social.oauth_discord.enabled === true : false,
      emailVerify: !!(at.email_address || {}).required,
      captcha: (us.sign_up || {}).captcha_enabled === true,
      subaddresses: !!((us.restrictions || {}).block_email_subaddresses || {}).enabled,
      site: 'Odyssey (Clerk)',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Ответ панели, на котором ждать дальше бессмысленно. Прежнее содержимое было про
// обмен GitHub-кода (потраченный `code`, сбитый OAuth-state, «failed to get user
// information») — на шлюзе без GitHub-входа эти регэкспы не могут совпасть никогда.
// Осталось то, что бывает у Clerk: приглашение по заявке и выключенная регистрация.
const SITE_ERRORS = [
  {
    code: 'no_register',
    terminal: true,           // ждать дальше бессмысленно — аккаунт не создать
    // `\w` в JS — только ASCII, поэтому русские варианты классом [а-яё], а не \w.
    re: /sign-?ups? (are )?(disabled|not allowed|restricted)|registration (is )?(disabled|closed)|unable to sign ?up|регистрац[а-яё]* (нов[а-яё]* [а-яё]* )?(закрыт|отключен)/i,
    msg: '❌ Odyssey закрыл регистрацию новых аккаунтов (ответ формы) — этот аккаунт создать нельзя.',
  },
];

// Что страница написала прямо сейчас (Clerk рисует ошибки текстом в виджете).
async function siteError(page) {
  let text = '';
  try { text = await page.evaluate(() => document.body ? document.body.innerText : ''); } catch { return null; }
  return SITE_ERRORS.find(e => e.re.test(text)) || null;
}

// Сайт сам ушёл на ВНЕШНИЙ вход — у Odyssey это Discord (`oauth_discord`).
// Перебивать такой редирект нельзя: второй goto рвёт OAuth-state, и панель потом
// отвечает «State parameter is empty or mismatched», а одноразовый `code` сгорает
// впустую. Ветка досталась от ЭТАЛОНА, где уезжали на github.com; у bai её оставили
// под Google. Здесь в списке ровно то, что есть у площадки.
const EXTERNAL_LOGIN_RE = /^https?:\/\/(discord\.com|accounts\.google\.com|oauth2\.googleapis\.com)\//i;

// Открыть страницу регистрации. У эталона тут была посадка реф-кода в localStorage
// и две повторные попытки на случай «код не осел»; у Odyssey реф-программы нет,
// поэтому остался один заход и один прогрев корня — на случай, если Next.js отдал
// страницу до готовности Clerk-виджета.
async function openRegister(page) {
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  if (EXTERNAL_LOGIN_RE.test(page.url())) return;
  const hasWidget = await page.evaluate(
    () => !!document.querySelector('[class*="cl-"], [id^="cl-"], iframe[src*="clerk"]'),
  ).catch(() => false);
  if (hasWidget) return;
  console.log('⚠️  форма регистрации не отрисовалась — прогреваю корень и захожу заново');
  await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  if (EXTERNAL_LOGIN_RE.test(page.url())) return;
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
}

// Ждём, пока URL уйдёт со страниц входа/регистрации И появится кука — это значит вход
// прошёл и мы внутри (кабинет). Тогда профиль уже сохранён Chromium'ом. `/sign-up`
// тоже в списке: на нём куки Clerk есть сразу, иначе «вход выполнен» печаталось бы
// через полторы секунды после старта. Попутно читаем ответ формы: «регистрация
// закрыта» — выходим сразу, а не висим 10 минут.
async function waitForLogin(page, context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const seen = new Set();
  while (Date.now() < deadline) {
    const url = page.url();
    const cookies = await context.cookies().catch(() => []);
    const leftAuth = !/\/sign-in|\/sign-up/.test(url);
    if (leftAuth && hasSessionCookie(cookies)) return { ok: true };

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

async function main() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();
  const imported = loadImportedSession();
  if (imported && imported.ghSeedOnly) {
    console.log('⚠️  Рядом лежит снимок ТОЛЬКО GitHub-сессии: для odyssey он бесполезен —');
    console.log('   входа через GitHub у площадки нет. Игнорирую файл, идём обычным путём.');
  }
  const shared = imported && !imported.ghSeedOnly ? imported : null;

  console.log(`🚀 Запускаю Chromium (видимый режим)…`);
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен ручной вход)' : 'уже есть (сохранённый)'}`);

  const pre = await preflight();
  if (!pre.ok) {
    console.log(`⚠️  предполётная проверка Clerk не удалась (${pre.error}) — открываю окно как есть.`);
  } else {
    console.log(`🛰️  ${pre.site}: регистрация ${pre.registration ? 'открыта' : 'ЗАКРЫТА'},`
      + ` вход паролем ${pre.passwordLogin ? 'есть' : 'ВЫКЛЮЧЕН'},`
      + ` Discord-вход ${pre.discord ? 'есть' : 'нет'},`
      + ` код на почту ${pre.emailVerify ? 'нужен' : 'не нужен'},`
      + ` капча ${pre.captcha ? 'есть (умная, невидимая)' : 'нет'}`);
    if (!pre.registration) {
      console.log('   ❌ Новый аккаунт создать нельзя — площадка закрыла регистрацию. Окно всё равно открою.');
    }
    if (pre.captcha) {
      console.log('   🖐 капча Clerk срабатывает на подозрительном трафике: её проходит ЧЕЛОВЕК, скрипт ничего не регистрирует сам.');
    }
    if (pre.subaddresses) {
      console.log('   🪤 плюс-алиасы (`user+tag@`) на регистрации запрещены — нужен живой адрес.');
    }
  }

  // launchPersistentContext держит профиль открытым и пишет на диск всё сам.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    args: ['--window-size=600,1000', '--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.bringToFront();
  raiseBrowserWindow(); // bringToFront поднимает только вкладку — окно ОС наверх выносит WinAPI
  await disableHttpCache(context, page);

  // Импортированная чужая сессия: подкладываем cookies/localStorage до навигации.
  const appliedSession = (fresh && shared) ? await applyImportedSession(context, shared) : false;

  // Импортированный share-код — аккаунт друга уже зарегистрирован, регистрация ему не нужна.
  const wantRegister = appliedSession ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;                                   // 'auto': чистый профиль = регистрация
  console.log(`🎯 ${wantRegister ? `регистрация: ${REGISTER_URL}` : `кабинет: ${CONSOLE_URL}`}`);

  try {
    if (appliedSession) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await reportRender(page);
      console.log('✅ Импортированная сессия применена (Odyssey уже залогинен).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    if (wantRegister) {
      await openRegister(page);
      console.log('⚠️  Регистрация. Войди на открывшейся странице руками — почтой с паролем');
      console.log('   (код из письма) или кнопкой Discord, капчу пройди сам.');
      console.log('   Затем возьми ключ в кабинете Odyssey и вставь его кнопкой 🔑 в дашборде.');

      const res = await waitForLogin(page, context);
      if (!res.ok) {
        if (res.err && res.err.code === 'no_register') {
          console.error('❌ Регистрация на odyssey закрыта — новый аккаунт не создать.');
          console.error('   Браузер оставляю открытым: ответ формы видно на странице.');
          await holdOpen(context);
          return;
        }
        console.error('❌ Таймаут ожидания входа (10 мин). Закрываю.');
        process.exit(2);
      }
      await reportRender(page);
      console.log('✅ Вход выполнен, профиль сохранён на диск. Забирай ключ и вставляй кнопкой 🔑.');
      console.log('   Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    // Вход, а не регистрация. Но у СВЕЖЕГО профиля аккаунта у провайдера может ещё не
    // быть — тогда сайт создаст его прямо на входе. У площадок с реф-программой это
    // стоило бы реф-кредита (ровно так у друга ушёл наш реф на tabitoken 2026-08-21);
    // у Odyssey реф-программы нет, поэтому здесь просто открываем форму.
    // Условие не «свежий профиль», а «сессии ЛК нет»: у записи без ключа профиль после
    // первого неудачного захода уже НЕ свежий, а аккаунта у провайдера по-прежнему нет.
    // Если сайт сам ушёл на внешний вход, CONSOLE_URL не перебиваем: это порвало бы
    // OAuth-state.
    const siteCookies = await context.cookies().catch(() => []);
    let loggedInEarly = false;
    if (fresh || !hasSessionCookie(siteCookies)) {
      await openRegister(page);
      if (EXTERNAL_LOGIN_RE.test(page.url())) {
        console.log('↪️  сайт сам ушёл на внешний вход — жди входа');
        const okRef = await waitForLogin(page, context);
        if (!okRef) { console.error('❌ Таймаут ожидания входа (10 мин). Закрываю.'); process.exit(2); }
        loggedInEarly = true;
      }
    }
    if (!EXTERNAL_LOGIN_RE.test(page.url())) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    }

    if (!fresh) {
      await reportRender(page);
      console.log('✅ Профиль восстановлен (Odyssey уже залогинен, если заходил раньше).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    if (!loggedInEarly) console.log('⚠️  Первый вход. Залогинься руками (почта + пароль или Discord),');
    if (!loggedInEarly) console.log('   затем возьми ключ в кабинете Odyssey и вставь его кнопкой 🔑 в дашборде.');

    const res = await waitForLogin(page, context);
    if (!res.ok) {
      console.error('❌ Таймаут ожидания входа (10 мин). Закрываю.');
      process.exit(2);
    }

    console.log('✅ Вход выполнен, профиль сохранён на диск. Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
    await holdOpen(context);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
