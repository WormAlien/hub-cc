// getunikey/open-session.js
//
// Открывает видимый Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ аккаунта (полный профиль
// на диск: история, куки, localStorage, сессия UniKey).
//
// Панель — тот же New API, что у соседних шлюзов, поэтому весь механизм (реф-код
// в localStorage, кука ЛК, отключённый HTTP-кеш, отчёт о белом экране) взят у ЭТАЛОНА
// без изменений. Отличаются адреса, реф-код — и путь входа.
//
// 🪤 Главное отличие: у UniKey НЕТ входа через GitHub. Замер `/api/status` 2026-09-15:
// github_oauth=false, github_client_id="" , oidc_enabled=false, linuxdo_oauth=false,
// telegram_oauth=false, wechat_login=false. Поэтому вся машинерия GitHub-OAuth из
// исходника ВЫРЕЗАНА, а не оставлена мёртвой: ждать кнопку, которой нет, значит висеть
// десять минут и соврать в лог «таймаут GitHub-логина». По той же причине выкинуты
// gh-live-capture и папка `gh-sessions/` — снимать нечего; окно держим своими четырьмя
// строками (holdOpen). Регэкспы ошибок обмена GitHub-кода («failed to fetch git token»,
// потраченный `code`, «state parameter is empty or mismatched», «failed to get user
// information») на этом шлюзе не могут совпасть никогда, а комментарий, противоречащий
// коду под ним, дороже отсутствующего.
//
// Чем UniKey отличается от hcnsec, у которого GitHub тоже вырезан:
//   • вход через Google OAuth ЕСТЬ (`google_oauth: true`, `google_client_id` заполнен) —
//     второй живой путь, поэтому «сайт сам ушёл на внешний вход» снова актуально, только
//     уезжает он на accounts.google.com, а не на github.com;
//   • 🪤 на регистрации, входе и запросе кода включён `turnstile_check` — капча Cloudflare
//     на форме (hcaptcha выключена). Именно поэтому авто-заведений (⚡) у вкладки НЕТ:
//     сценарий без человека тут не гарантирован. Скрипт открывает окно и ждёт, пока
//     человек пройдёт капчу и вход руками, — сам он не регистрирует ничего;
//   • регистрация открыта (`register_enabled=true`, `password_register_enabled=true`) и
//     требует кода с почты (`email_verification=true`, 6 цифр).
//
// Сценарий:
//   1. В дашборде добавляешь аккаунт (email, ключ можно оставить пустым), жмёшь
//      🌐 «Открыть браузер».
//   2. Открывается Chromium с профилем getunikey/profiles/<label>/ (на аккаунт).
//   3. Ключа у аккаунта ещё нет → открывается РЕГИСТРАЦИЯ по рефке владельца.
//      Ключ уже вписан → открывается страница баланса (wallet).
//   4. Регистрируешься руками: Google-вход ИЛИ почта + пароль + код из письма, капчу
//      проходишь сам. Затем в ЛК UniKey возьми API-ключ и вставь его в аккаунт кнопкой 🔑
//      на дашборде (или впиши сразу при добавлении).
//   5. Профиль сохраняется автоматически — при следующих открытиях UniKey уже залогинен.
//
// Использование:
//   node getunikey/open-session.js <label> [register|console|auto]
//     label — имя профиля (папка getunikey/profiles/<label>/)
//     режим — register: регистрация по рефке (у аккаунта ещё нет sk-ключа),
//             console:  страница баланса (ключ уже есть),
//             auto (по умолчанию): чистый профиль = register, иначе console.
//
// Код возврата 0 = профиль открыт, 2 = таймаут ожидания входа (первый вход).

const { chromium } = require('playwright');
const { raiseBrowserWindow } = require('../routing/lib/focus-window.js');
const fs = require('fs');
const path = require('path');

// Рефка владельца: аккаунт без ключа регистрируем ТОЛЬКО по ней. Раньше код был
// захардкожен в десяти местах, и забытое = потерянный реф-кредит; теперь ссылка — из
// routing/lib/ref-codes.js, а не литералом: код владельца лежит дефолтом в
// routing/ref-codes.default.json (у getunikey это `6ssC`), пользователь вписывает свой
// через 💩 в «Настройках» дашборда (routing/ref-codes.json, он в .gitignore).
// 🪤 Реф-программа у площадки ЕСТЬ (живая карточка «Referral Program» в кошельке), но
// начисляется от ПОПОЛНЕНИЯ приглашённого — пачка пустых регистраций бонуса не даст.
const REGISTER_URL = require('../routing/lib/ref-codes.js').url('getunikey');
// Ключ уже вписан → сразу баланс, а не логин. Роут именно `/wallet`.
const CONSOLE_URL = 'https://www.getunikey.ai/wallet';
// Корень нужен для прогрева перед регистрацией (см. openRegisterViaRef) и как источник
// SITE_HOST для проверки куки ЛК (см. hasSessionCookie).
const ROOT_URL = 'https://www.getunikey.ai/';
// Публичная конфигурация панели — на ней держится предполётная проверка (см. preflight).
const STATUS_URL = 'https://www.getunikey.ai/api/status';
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной вход (капча + почта)

// Окно живёт до Ctrl+C: обещание резолвится только на закрытии контекста. В исходнике
// эту роль играл gh-live-capture.holdOpen() — он попутно вычитывал GitHub-куки; здесь
// вычитывать нечего, поэтому держим окно своими четырьмя строками, а не тянем модуль,
// который на этом шлюзе не имеет смысла.
function holdOpen(context) {
  return new Promise((resolve) => { context.on('close', resolve); });
}

// Если рядом лежит <label>.json — применяем его как storageState: cookies + localStorage.
// Два разных источника такого файла, и различать их обязательно:
//   share-код друга      → аккаунт UniKey уже создан, панель сразу залогинена;
//   seed:'github'        → файл от GitHub-менеджера, к UniKey отношения не имеет.
function loadImportedSession() {
  try {
    const p = path.join(SESSIONS_DIR, label + '.json');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const ss = JSON.parse(raw);
    if (!ss || typeof ss !== 'object') return null;
    // seed:'github' — в файле ТОЛЬКО GitHub-куки, его положил дашборд кнопкой «взять
    // готовый GitHub». Для getunikey он бесполезен (входа через GitHub нет), но и молча
    // применить его нельзя: ветка ниже приняла бы файл за готовый аккаунт друга и увела
    // на кошелёк аккаунта, которого не существует, — вместо страницы регистрации.
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
// Cloudflare-куки в зачёт не идут — они появляются до всякого входа (у UniKey
// `cf_clearance` плюс turnstile-куки). И отдельно: `new_api_refresh` (jwt-инстансы
// tabi/xpeach) под старый regexp не подходил ВООБЩЕ, то есть у половины провайдеров
// проверка держалась на чужих куках целиком.
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
// (поймано на ar-аккаунтах 2026-08-17, у getunikey тот же NewAPI-фронт). Кеш профиля
// чистить вслепую нельзя, поэтому ходим мимо HTTP-кеша: сессия и localStorage
// остаются на месте. Вешаем и на новые вкладки — Google-OAuth умеет открываться попапом.
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

// Предполётная проверка панели вместо угадывания текстов ошибок: New API отдаёт свою
// конфигурацию открыто (`GET /api/status`), поэтому «регистрация закрыта», «вход паролем
// выключен», «нужен код с почты» и «капча есть» мы УЗНАЁМ, а не вылавливаем регэкспом из
// тоста. Здесь это особенно дорого стоит: вход у площадки ручной, и знать заранее, какие
// пути открыты, значит не гонять человека по трём формам вслепую. Замер 2026-09-15:
// регистрация открыта, вход паролем есть, Google-OAuth есть, капча ЕСТЬ (turnstile).
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
      google: d.google_oauth === true,
      emailVerify: d.email_verification === true,
      turnstile: d.turnstile_check === true,
      site: d.system_name || 'UniKey',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Ответ панели, на котором ждать дальше бессмысленно. Осталась ОДНА запись: всё
// остальное в исходнике было про обмен GitHub-кода (потраченный `code`, сбитый
// OAuth-state, «failed to get user information») — на шлюзе без GitHub-входа эти
// регэкспы не могут совпасть никогда, и держать их значило бы врать читателю кода.
const SITE_ERRORS = [
  {
    code: 'no_register',
    terminal: true,           // ждать дальше бессмысленно — аккаунт не создать
    // `\w` в JS — только ASCII, поэтому русские варианты классом [а-яё], а не \w.
    re: /new (user )?registration (is )?(disabled|closed)|registration (is )?disabled by (the )?admin|(clos|disabl)\w* new (user )?registration|管理员关闭了新用户注册|регистрац[а-яё]* (нов[а-яё]* [а-яё]* )?(закрыт|отключен)|закрыл[а-яё]* регистрацию/i,
    msg: '❌ UniKey закрыл регистрацию новых аккаунтов (ответ панели) — этот аккаунт создать нельзя.',
  },
];

// Что панель написала на странице прямо сейчас (тосты New API рисуются в DOM).
async function siteError(page) {
  let text = '';
  try { text = await page.evaluate(() => document.body ? document.body.innerText : ''); } catch { return null; }
  return SITE_ERRORS.find(e => e.re.test(text)) || null;
}

// Сайт сам ушёл на ВНЕШНИЙ вход — у UniKey это Google OAuth (`google_oauth: true`).
// Перебивать такой редирект нельзя: второй goto рвёт OAuth-state, и панель потом отвечает
// «State parameter is empty or mismatched», а одноразовый `code` сгорает впустую. Ветка
// досталась от ЭТАЛОНА, где уезжали на github.com; там её пришлось оставить как была
// (входа через GitHub тут нет, но Google — есть, а грабля ровно та же).
const EXTERNAL_LOGIN_RE = /^https?:\/\/(accounts\.google\.com|oauth2\.googleapis\.com)\//i;

// Реф-код сайт хранит в localStorage (ключ `aff`). Одного захода по реф-ссылке
// достаточно — проверено: код оседает сразу, страница регистрации на чистом
// профиле рисуется без прогрева. Поэтому happy path = ОДНА навигация: прыжки
// рефка → корень → рефка юзер видел как «дрочь», и они же рвали OAuth-state.
// Корень прогреваем только если код с первого раза не осел.
async function openRegisterViaRef(page) {
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const readAff = () => page
    .evaluate(() => { try { return localStorage.getItem('aff'); } catch { return null; } })
    .catch(() => null);

  const aff = await readAff();
  if (aff) {
    console.log(`🤝 реф-код сохранён в профиль: aff=${aff}`);
    return;                       // страница регистрации уже открыта — больше не трогаем
  }

  console.log('⚠️  реф-код не осел с первого раза — прогреваю корень и захожу заново');

  // Если сайт сам уехал на внешний вход (сессия Google в профиле уже есть — страница
  // регистрации продолжает вход без нажатий), прогрев корня НЕ делаем: второй goto
  // рвёт OAuth-state, и сайт потом отвечает «State parameter is empty or mismatched».
  if (EXTERNAL_LOGIN_RE.test(page.url())) {
    console.log('↪️  сайт сам ушёл на внешний вход — не перебиваем редирект');
    return;
  }

  await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  if (EXTERNAL_LOGIN_RE.test(page.url())) {
    console.log('↪️  сайт сам ушёл на внешний вход — не перебиваем редирект');
    return;
  }
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const aff2 = await readAff();
  console.log(aff2
    ? `🤝 реф-код сохранён в профиль со второй попытки: aff=${aff2}`
    : '⚠️  реф-код так и не осел в localStorage — регистрация может не зачесться');
}

// Ждём, пока URL уйдёт со страниц входа/регистрации И появится кука — это значит вход
// прошёл и мы внутри UniKey (консоль/дашборд). Тогда профиль уже сохранён Chromium'ом.
// `/sign-up` тоже в списке: на нём куки (csrf, turnstile и прочее) есть сразу, иначе
// «вход выполнен» печаталось бы через полторы секунды после старта. Попутно читаем ответ
// панели: «регистрация закрыта» — выходим сразу, а не висим 10 минут.
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
    console.log('⚠️  Рядом лежит снимок ТОЛЬКО GitHub-сессии: для getunikey он бесполезен —');
    console.log('   входа через GitHub у площадки нет. Игнорирую файл, идём обычным путём.');
  }
  const shared = imported && !imported.ghSeedOnly ? imported : null;

  console.log(`🚀 Запускаю Chromium (видимый режим)…`);
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен ручной вход)' : 'уже есть (сохранённый)'}`);

  const pre = await preflight();
  if (!pre.ok) {
    console.log(`⚠️  предполётная проверка панели не удалась (${pre.error}) — открываю окно как есть.`);
  } else {
    console.log(`🛰️  ${pre.site}: регистрация ${pre.registration ? 'открыта' : 'ЗАКРЫТА'},`
      + ` вход паролем ${pre.passwordLogin ? 'есть' : 'ВЫКЛЮЧЕН'},`
      + ` Google-вход ${pre.google ? 'есть' : 'нет'},`
      + ` код на почту ${pre.emailVerify ? 'нужен' : 'не нужен'},`
      + ` капча ${pre.turnstile ? 'есть' : 'нет'}`);
    if (!pre.registration) {
      console.log('   ❌ Новый аккаунт создать нельзя — панель закрыла регистрацию. Окно всё равно открою.');
    }
    if (pre.turnstile) {
      console.log('   🖐 капча Cloudflare на форме: её проходит ЧЕЛОВЕК, скрипт ничего не регистрирует сам.');
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

  // Импортированный share-код — аккаунт друга уже зарегистрирован, рефка ему не нужна.
  const wantRegister = appliedSession ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;                                   // 'auto': чистый профиль = регистрация
  console.log(`🎯 ${wantRegister ? `регистрация по рефке: ${REGISTER_URL}` : `баланс: ${CONSOLE_URL}`}`);

  try {
    if (appliedSession) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await reportRender(page);
      console.log('✅ Импортированная сессия применена (UniKey уже залогинен).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    if (wantRegister) {
      await openRegisterViaRef(page);
      console.log('⚠️  Регистрация по рефке. Войди на открывшейся странице руками — Google-кнопкой');
      console.log('   или почтой с паролем, капчу пройди сам (код с почты — 6 цифр).');
      console.log('   Затем возьми ключ в ЛК UniKey и вставь его кнопкой 🔑 в дашборде.');

      const res = await waitForLogin(page, context);
      if (!res.ok) {
        if (res.err && res.err.code === 'no_register') {
          console.error('❌ Регистрация на getunikey закрыта администратором — новый аккаунт не создать.');
          console.error('   Браузер оставляю открытым: ответ панели видно на странице.');
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
    // быть — тогда сайт создаст его прямо на входе, и БЕЗ реф-кода. Ровно так у друга ушёл
    // наш реф-кредит на tabitoken (2026-08-21): кнопка «вход» повела на кошелёк, сайт
    // зарегистрировал с нуля, `aff` в localStorage не было. Поэтому сначала сажаем реф-код
    // (он живёт в localStorage и переживает переходы), и только потом идём на кошелёк:
    // аккаунт есть — код просто не пригодится, аккаунта нет — регистрация зачтётся по рефке.
    // Если сайт сам ушёл на внешний вход, CONSOLE_URL не перебиваем: это порвало бы OAuth-state.
    // Условие не «свежий профиль», а «сессии ЛК нет». Разница поймана в тот же день:
    // у записи без ключа профиль после первого неудачного захода уже НЕ свежий, а
    // аккаунта у провайдера по-прежнему нет — второй клик снова уводил на кошелёк без
    // реф-кода, и рефка терялась ровно так же. Живому аккаунту (кука ЛК на месте) лишний
    // заход по реф-ссылке не делаем.
    const siteCookies = await context.cookies().catch(() => []);
    let loggedInEarly = false;
    if (fresh || !hasSessionCookie(siteCookies)) {
      await openRegisterViaRef(page);
      if (EXTERNAL_LOGIN_RE.test(page.url())) {
        console.log('↪️  сайт сам ушёл на внешний вход — жди входа, реф-код уже в профиле');
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
      console.log('✅ Профиль восстановлен (UniKey уже залогинен, если заходил раньше).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    if (!loggedInEarly) console.log('⚠️  Первый вход. Залогинься руками (Google-кнопка или почта + пароль),');
    if (!loggedInEarly) console.log('   затем возьми ключ в ЛК UniKey и вставь его кнопкой 🔑 в дашборде.');

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
