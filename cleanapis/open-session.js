// cleanapis/open-session.js
//
// Открывает видимый Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ аккаунта (полный профиль
// на диск: история, куки, localStorage, сессии GitHub + cleanapis).
//
// Панель - СВОЯ, на Laravel + Tailwind, а не New API: замер 01.10, `GET /api/status`
// и `/panel` отдают 404, куки `XSRF-TOKEN` и `clean-apis-session` (Laravel), вход
// через GitHub и Google (`/auth/github/redirect`, `/auth/google/redirect`).
// Механика взята у kktoken (GitHub-OAuth, кука ЛК, ожидание входа); отличаются
// адреса, отсутствие рефки и разбор ошибок площадки.
//
// Чем cleanapis отличается (замер публичных страниц 01.10):
//   - вход через GitHub-OAuth есть - путь тот же, что у эталона;
//   - вход через Google тоже есть, но ветки для него здесь нет: она появится,
//     когда кто-то заведёт аккаунт так. Сценарий владельца покрывает GitHub;
//   - на входе И на регистрации включена капча Cloudflare Turnstile
//     (скрипт challenges.cloudflare.com на обеих формах), а форма регистрации -
//     классический Laravel POST с `_token`, `email`, `password`, `name`, `phone`.
//     Поэтому авто-заведения (молния) у вкладки НЕТ: сценарий без человека тут не
//     гарантирован. Скрипт открывает окно и ждёт, пока человек пройдёт капчу и
//     вход руками, - сам он ничего не регистрирует;
//   - 🔴 реф-программы у площадки НЕТ (владелец 30.09: бонус начисляется при
//     пополнении, а не за приглашённых), поэтому регистрация открывается просто
//     как `/register`, и ключа реферала тут не существует.
//
// 🪤 Что НЕ проверено живьём и требует первого прогона с аккаунтом: адрес кабинета
// (`/dashboard` отвечает 200 и без входа - это оболочка SPA, а не доказательство
// доступа), точные тексты ошибок площадки и то, что кука `clean-apis-session`
// действительно садится после ручного входа. Эвристика «залогинен ли» здесь общая
// для семейства: `SITE_SESSION_RE` ловит `session`, а `clean-apis-session` ей
// подходит. На живом входе это подтвердить и, если разойдётся, сузить до своего
// домена - у соседей это сделано именно так.
//
// Сценарий:
//   1. В дашборде добавляешь аккаунт (email, ключ можно оставить пустым), жмёшь
//      🌐 «Открыть браузер».
//   2. Открывается Chromium с профилем cleanapis/profiles/<label>/ (на аккаунт).
//   3. Ключа у аккаунта ещё нет - открывается регистрация. Ключ уже вписан -
//      открывается кабинет (`/dashboard`).
//   4. В кабинете Clean APIs возьми API-ключ и вставь его в аккаунт кнопкой 🔑
//      на дашборде (или впиши сразу при добавлении).
//   5. Профиль сохраняется автоматически - при следующих открытиях GitHub и
//      Clean APIs уже залогинены.
//
// Использование:
//   node cleanapis/open-session.js <label> [register|console|auto]
//     label - имя профиля (папка cleanapis/profiles/<label>/)
//     режим - register: страница регистрации (у аккаунта ещё нет ключа),
//             console:  кабинет (ключ уже есть),
//             auto (по умолчанию): чистый профиль = register, иначе console.
//
// Код возврата 0 = профиль открыт, 2 = таймаут ожидания GitHub-логина (первый вход).

const { chromium } = require('playwright');
const { raiseBrowserWindow } = require('../routing/lib/focus-window.js');
const fs = require('fs');
const path = require('path');

// Реф-программы у cleanapis НЕТ (владелец 30.09: бонус начисляется при пополнении, а не
// за приглашённых), поэтому вместо ссылки с кодом здесь просто страница регистрации.
// 🪤 Не подставлять сюда `ref-codes.js` «на всякий случай»: кода не существует, а
// выдуманный aff-параметр площадка либо проигнорирует, либо отдаст 404 на форме.
const REGISTER_URL = 'https://cleanapis.com/register';
// Ключ уже вписан → сразу кабинет, а не логин.
const CONSOLE_URL = 'https://cleanapis.com/dashboard';
// Корень нужен для прогрева перед регистрацией (см. openRegisterViaRef).
const ROOT_URL = 'https://cleanapis.com/';
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

// Ручной вход в GitHub, сделанный человеком в открытом окне, тоже должен попасть в копию
// сессии — до 2026-08-22 копия не снималась вообще, и вход руками жил только в профиле.
const ghCapture = require('../routing/lib/gh-live-capture.js').makeCapture({
  label,
  moduleDir: __dirname,
  poolFile: path.join(__dirname, '..', 'routing', 'cleanapis-sessions.json'),
});

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной GitHub-логин

// Если рядом лежит <label>.json — применяем его как storageState: cookies + localStorage.
// Два разных источника такого файла, и различать их обязательно:
//   share-код друга      → аккаунт cleanapis уже создан, GitHub/cleanapis сразу залогинены;
//   seed:'github'        → только GitHub-куки, аккаунта cleanapis ещё НЕТ (см. seededGithub).
function loadImportedSession() {
  try {
    const p = path.join(SESSIONS_DIR, label + '.json');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const ss = JSON.parse(raw);
    if (!ss || typeof ss !== 'object') return null;
    return {
      // seed:'github' — в файле ТОЛЬКО GitHub-куки, аккаунта провайдера ещё нет: файл
      // положил дашборд по кнопке «взять готовый GitHub». Отличать обязательно, иначе
      // ветка ниже примет его за готовый аккаунт друга, уведёт на страницу баланса и
      // пропустит регистрацию — аккаунт у провайдера так и не заведётся.
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
// Cloudflare-куки в зачёт не идут — они появляются до всякого входа. И отдельно:
// `new_api_refresh` (jwt-инстансы tabi/xpeach) под старый regexp не подходил ВООБЩЕ,
// то есть у половины провайдеров проверка держалась на чужих куках целиком.
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

// Chromium кеширует и 404-ответы. Если на `/assets/index-<hash>.js` однажды прилетел
// 404 (деплой сайта / затык WAF), он оседает в кеше профиля — и SPA больше не
// поднимается НИКОГДА: на каждом открытии белый экран, хотя куки и логин живые
// (поймано на ar-аккаунтах 2026-08-17, у gorouter/tabi/cleanapis тот же NewAPI-фронт).
// Кеш профиля чистить вслепую нельзя, поэтому ходим мимо HTTP-кеша: сессия и
// localStorage остаются на месте. Вешаем и на новые вкладки — GitHub-OAuth
// умеет открываться попапом.
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
    () => { const r = document.getElementById('root'); return !!r && r.innerHTML.length > 200; },
    { timeout: 15000 },
  ).then(() => true).catch(() => false);
  console.log(ok
    ? '✅ страница отрисовалась'
    : '⚠️  белый экран: SPA не поднялась — жми F5, в DevTools ищи 404 на /assets/*.js');
}

// Ответы cleanapis (NewAPI) на неудачный GitHub-вход. Раньше скрипт знал только
// «failed to get user information» и на всё остальное молча ждал логин 10 минут —
// пользователь видел «дроч» вместо ответа сайта (2026-08-17).
const SITE_ERRORS = [
  {
    code: 'no_register',
    terminal: true,           // ждать дальше бессмысленно — аккаунт не создать
    // `\w` в JS — только ASCII, поэтому русские варианты классом [а-яё], а не \w.
    re: /new (user )?registration (is )?(disabled|closed)|registration (is )?disabled by (the )?admin|(clos|disabl)\w* new (user )?registration|管理员关闭了新用户注册|регистрац[а-яё]* (нов[а-яё]* [а-яё]* )?(закрыт|отключен)|закрыл[а-яё]* регистрацию/i,
    msg: '❌ cleanapis закрыл регистрацию новых аккаунтов (ответ сайта) — этот аккаунт создать нельзя.',
  },
  {
    code: 'git_token',
    re: /failed to fetch git token|failed to (get|fetch) (github )?(access )?token|无法获取 ?GitHub ?(访问)?令牌/i,
    msg: '⚠️  сайт не обменял GitHub-code на токен («failed to fetch git token»): одноразовый code уже потрачен. F5 не лечит — жми «Продолжить с GitHub» заново.',
  },
  {
    code: 'state',
    re: /state parameter is empty or mismatched|state 参数/i,
    msg: '⚠️  OAuth-state не совпал (страницу дёрнули посреди входа) — начни вход заново кнопкой «Продолжить с GitHub».',
  },
  {
    code: 'user_info',
    re: /failed to get user info|无法获取用户信息|не удалось получить (данные|информацию)/i,
    msg: '⚠️  сайт ответил «failed to get user information» — лечится обновлением страницы.',
  },
];

// Что сайт написал на странице прямо сейчас (тосты NewAPI рисуются в DOM).
async function siteError(page) {
  let text = '';
  try { text = await page.evaluate(() => document.body ? document.body.innerText : ''); } catch { return null; }
  return SITE_ERRORS.find(e => e.re.test(text)) || null;
}

// Колбэк GitHub-а: `code` одноразовый, повторный заход/F5 по этому URL сайт
// встречает уже потраченным кодом и отвечает «failed to fetch git token».
const OAUTH_CALLBACK_RE = /\/oauth\/(github|oidc)|[?&]code=/i;

// Реф-программы у cleanapis нет, поэтому «заселение реф-кода» здесь сводится к одной
// навигации на страницу регистрации. 🪤 Механику эталона (localStorage-ключ `aff`, вторая
// попытка через прогрев корня) сюда переносить НЕЛЬЗЯ: кода не существует, и скрипт бы
// дважды грел корень и печатал «реф-код не осел», пугая владельца на ровном месте.
// Имя функции оставлено прежним - её зовут выше по потоку.
async function openRegisterViaRef(page) {
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);

  // Сайт может сам уйти на GitHub-вход (сессия GitHub в профиле уже есть), и тогда
  // повторный goto рвёт OAuth-state: площадка отвечает «State parameter is empty or
  // mismatched» либо «failed to fetch git token». Редирект не перебиваем.
  if (/github\.com/i.test(page.url())) {
    console.log('↪️  сайт сам ушёл на GitHub-вход — не перебиваем редирект');
    return;
  }
  console.log(`📝 открыта страница регистрации: ${REGISTER_URL}`);
}

// После GitHub-логина добиваем ошибки сайта. Главное правило: на колбэке OAuth
// (`/oauth/github?code=…`) НИКАКИХ reload — это второй расход одноразового кода,
// ровно из-за него вылезает «failed to fetch git token». С колбэка уходим на
// кошелёк: сессия уже в куках, страница поднимется заново.
async function settleAfterLogin(page) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (OAUTH_CALLBACK_RE.test(page.url())) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await page.waitForTimeout(2000);

    const err = await siteError(page);
    if (!err) return true;
    console.log(err.msg);
    if (err.terminal) return false;
    // Повтор — просто ещё один заход на ту же страницу, терять нечего.
    console.log(`   повтор ${attempt}/2 по странице регистрации…`);
    await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  return !(await siteError(page));
}

// Ждём, пока URL уйдёт со страниц входа/регистрации И появится кука — это значит
// GitHub-вход прошёл и мы внутри cleanapis (консоль/дашборд). Тогда профиль уже
// сохранён Chromium'ом. /sign-up тоже в списке: на нём куки (csrf и прочее) есть
// сразу, иначе «вход выполнен» печаталось бы через полторы секунды после старта.
// Попутно читаем ответ сайта: «регистрация закрыта» — выходим сразу, а не висим
// 10 минут; про потраченный code и сбитый state пишем по одному разу.
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

  console.log(`🚀 Запускаю Chromium (видимый режим)…`);
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен GitHub-логин)' : 'уже есть (сохранённый)'}`);

  // launchPersistentContext держит профиль открытым и пишет на диск всё сам.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    // Разрешаем расширения в окне (друг ставит своё прокси-расширение): снимаем
    // дефолтный --disable-extensions Playwright и берём системный Chrome —
    // Chrome Web Store ставит расширения только в него, не в комплектный Chromium.
    channel: 'chrome',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--window-size=600,1000', '--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.bringToFront();
  raiseBrowserWindow(); // bringToFront поднимает только вкладку — окно ОС наверх выносит WinAPI
  await disableHttpCache(context, page);

  // Импортированная чужая сессия: подкладываем cookies/localStorage до навигации.
  let appliedSession = false;
  if (fresh && imported) {
    appliedSession = await applyImportedSession(context, imported);
  }

  // Заселение готового GitHub — аккаунта у провайдера ещё нет, регистрация нужна.
  const seededGithub = appliedSession && imported && imported.seed === 'github';
  if (seededGithub) {
    console.log(`🐙 GitHub-сессия заселена${imported.ghLogin ? ` (${imported.ghLogin})` : ''} — пароль и 2FA не понадобятся, жми «Continue with GitHub».`);
  }

  // Импортированный share-код — аккаунт друга уже зарегистрирован, регистрация не нужна.
  const wantRegister = (appliedSession && !seededGithub) ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;                                   // 'auto': чистый профиль = регистрация
  console.log(`🎯 ${wantRegister ? `регистрация: ${REGISTER_URL}` : `баланс: ${CONSOLE_URL}`}`);

  try {
    if (appliedSession && !seededGithub) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await reportRender(page);
      console.log('✅ Импортированная сессия применена (GitHub/cleanapis уже залогинены).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context); // держим открытым, закрытие — вручную
      return;
    }

    // Регистрация: ждём логина и добиваем «failed to get user information» ВСЕГДА,
    // а не только на чистом профиле. Первая попытка могла упасть именно так —
    // тогда профиль уже не чистый, а аккаунт всё ещё без ключа.
    if (wantRegister) {
      await openRegisterViaRef(page);
      console.log('⚠️  Регистрация. Зарегайся через GitHub на открывшейся странице,');
      console.log('   затем возьми ключ в консоли Clean APIs и вставь его кнопкой 🔑 в дашборде.');

      const res = await waitForLogin(page, context);
      if (!res.ok) {
        if (res.err && res.err.code === 'no_register') {
          console.error('❌ Регистрация на cleanapis закрыта администратором — новый аккаунт не создать.');
          console.error('   Браузер оставляю открытым: ответ сайта видно на странице.');
          await ghCapture.holdOpen(context);
          return;
        }
        console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
        process.exit(2);
      }
      const settled = await settleAfterLogin(page);
      console.log(settled
        ? '✅ Вход выполнен, профиль сохранён на диск. Забирай ключ и вставляй кнопкой 🔑.'
        : '⚠️  Вход прошёл, но сайт всё ещё отдаёт ошибку (см. строку выше) — дальше руками.');
      console.log('   Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context);
      return;
    }

    // Вход, а не регистрация. Но у СВЕЖЕГО/заселённого профиля аккаунта у провайдера
    // может ещё не быть — тогда площадка заведёт его прямо на GitHub-входе.
    // 🪤 У эталона на этом месте сажался реф-код в localStorage, и это был не косметический
    // шаг: без него регистрация не зачитывалась владельцу. У cleanapis реф-программы нет,
    // поэтому сажать нечего — заходим на страницу регистрации и не перебиваем редирект,
    // если сайт сам ушёл на GitHub-вход (это порвало бы OAuth-state).
    // Условие не «свежий профиль», а «сессии ЛК нет»: у записи без ключа профиль после
    // первого неудачного захода уже НЕ свежий, а аккаунта по-прежнему нет.
    const siteCookies = await context.cookies().catch(() => []);
    let loggedInEarly = false;
    if (fresh || !hasSessionCookie(siteCookies)) {
      await openRegisterViaRef(page);
      if (/github\.com/i.test(page.url())) {
        console.log('↪️  сайт сам ушёл на GitHub-вход — жди входа');
        const okRef = await waitForLogin(page, context);
        if (!okRef) { console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.'); process.exit(2); }
        loggedInEarly = true;
      }
    }
    if (!/github\.com/i.test(page.url())) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    }

    if (!fresh) {
      await reportRender(page);
      console.log('✅ Профиль восстановлен (GitHub/cleanapis уже залогинены, если заходил раньше).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context); // держим открытым, закрытие — вручную
      return;
    }

    if (!loggedInEarly) console.log('⚠️  Первый вход. Залогинься в GitHub (кнопка «Продолжить с GitHub»),');
    if (!loggedInEarly) console.log('   затем возьми ключ в консоли Clean APIs и вставь его кнопкой 🔑 в дашборде.');

    const res = await waitForLogin(page, context);
    if (!res.ok) {
      console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
      process.exit(2);
    }

    console.log('✅ Вход выполнен, профиль сохранён на диск. Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
    await ghCapture.holdOpen(context);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
