// agentrouter/open-session.js
//
// Открывает консоль agentrouter.org в видимом Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ
// на аккаунт (полный профиль на диск: куки, localStorage, сессия GitHub).
//
// Сценарий:
//   1. В дашборде нажимаешь 🌐 «Открыть браузер» на карточке аккаунта.
//   2. Открывается Chromium с профилем agentrouter/profiles/<label>/ (на аккаунт).
//   3. Ключа у аккаунта ещё нет → открывается РЕГИСТРАЦИЯ по рефке владельца.
//      Ключ уже вписан → открывается страница баланса/пополнения.
//   4. Профиль сохраняется автоматически — при следующих открытиях agentrouter
//      уже залогинен (можно сразу жать чек-ин +$25).
//
// Если рядом лежит <label>.json (импортированный чужой share-код) — применяем его
// как storageState (cookies + localStorage), тогда GitHub/agentrouter сразу залогинены.
//
// Использование:
//   node agentrouter/open-session.js <label> [register|console|auto|checkin|autocheckin]
//     label — имя профиля (папка agentrouter/profiles/<label>/)
//     режим — register:    регистрация по рефке (у аккаунта ещё нет sk-ключа),
//             console:     страница баланса/пополнения (ключ уже есть),
//             checkin:     разлогин + страница входа (забрать суточные +$25 руками),
//             autocheckin: то же, но вход через GitHub скрипт делает САМ и закрывается,
//             auto (по умолчанию): чистый профиль = register, иначе console.
//
// Коды возврата: 0 = готово (оба чек-ин-режима печатают маркер AUTOCHECKIN_RESULT {...}),
//   2 = таймаут ожидания GitHub-логина, 3 = GitHub-сессия в профиле мертва (нужен
//   ручной вход, пароль и 2FA автоматика не вводит), 5 = шлюз отверг OAuth (state/код),
//   1 = прочая ошибка. Про вход через GitHub кодов ДВА, и путать их нельзя:
//   4 = страница входа действительно переделана: кнопки GitHub нет, а живой /api/status
//       ОТВЕТИЛ — просто без github_client_id (или /api/oauth/state отказал словами).
//       Тут чинить нечего до тех пор, пока не посмотришь вёрстку глазами;
//   6 = край не ответил вовсе: публичная /api/status вернула пусто / не-JSON. Это
//       рейт-лимит или WAF по IP, вёрстка ни при чём — лечится паузой, а не разбором
//       страницы. Разведено 10.09: до этого ЛЮБОЙ отказ печатался как «шлюз переделал
//       страницу входа», и владельца посылали чинить то, чего не ломали.
//       🪤 Таблица сообщений дашборда (AR_AUTO_CHECKIN_FAIL в routing/transparent-proxy.js)
//       про код 6 ещё не знает и покажет «скрипт завершился с кодом 6». Это честнее
//       неверного диагноза, но строку туда добавить надо — задача в трекере ABUSE HUB.

const { chromium } = require('playwright');
const { raiseBrowserWindow } = require('../routing/lib/focus-window.js');
const fs = require('fs');
const path = require('path');

// Рефка владельца: аккаунт без ключа регистрируем ТОЛЬКО по ней (реф-бонус +$100).
// Реф-ссылка — из routing/lib/ref-codes.js, а не литералом: код владельца лежит
// дефолтом в routing/ref-codes.default.json, пользователь вписывает свой через 💩 в
// «Настройках» дашборда (routing/ref-codes.json, он в .gitignore). Одна точка на весь
// репозиторий: раньше код был в десяти местах, и забытое = потерянный реф-кредит.
const REGISTER_URL = require("../routing/lib/ref-codes.js").url("agentrouter");
// Ключ уже вписан → сразу баланс/пополнение, а не корень сайта.
const CONSOLE_URL = 'https://agentrouter.org/console/topup';
// Корень нужен для прогрева перед регистрацией (см. openRegisterViaRef).
const ROOT_URL = 'https://agentrouter.org/';
// Чек-ин +$25 капает раз в сутки только после ПОВТОРНОГО входа через GitHub, поэтому
// режим checkin гасит сессию и ставит браузер на страницу входа.
const LOGIN_URL = 'https://agentrouter.org/login';
// Роут разлогина у New-API не задокументирован. С 2026-08-22 он не основной путь, а
// фолбэк: сначала выходим через меню профиля в шапке (см. uiLogout), как это делает
// человек. Прямой заход сюда навигацией оставлен на случай, если шапка переедет.
const LOGOUT_URL = 'https://agentrouter.org/api/user/logout';
// Пункт «выйти» в дропдауне аватара. UI сайта китайский (退出), но пул языков держим
// шире: шлюз уже менял локаль страницы входа, и селектор по одному языку — мина.
const LOGOUT_MENU_RE = /退出|登出|注销|logout|log ?out|sign ?out|выйти|выход/i;
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной GitHub-логин
// Автоподарку человек не нужен: клик, редиректы GitHub-а и колбэк укладываются
// в считанные секунды. Полторы минуты — с запасом на медленный WAF.
const AUTO_LOGIN_TIMEOUT_MS = 90 * 1000;

// ───── Пороги ожиданий автоподарка (пересмотрены 10.09) ───────────────────
// Замер первого инструментированного прогона: Chromium поднимается за 0.8 с, удачный
// прогон ~19 с, а НЕудачный целиком состоит из фиксированных таймаутов — 22 с, из них
// 15 с ожидание попапа, которого не будет, и 4.7 с попытка снять эталон. Второй случай
// (сессия уже мертва на сервере) дал 57 с против 19 с: код искал аватар в шапке
// страницы /login с потолком 15 с.
//
// Общий принцип правки: ждать не «сколько не жалко», а до появления ПРИЗНАКА, что ждать
// больше нечего. Голые потолки оставлены только там, где признака нет, и они короткие.
//
// Кнопки входа SPA дорисовывает после #root, поэтому ждать её надо; но ДВА кандидата
// ждались последовательно по 10 с — на странице без кнопки это 20 с. Теперь оба ждут
// одновременно с общим бюджетом.
const GH_BTN_WAIT_MS = 8000;
// Попап открывается не по клику, а ПОСЛЕ ответа /api/oauth/state (см. разбор v7 ниже),
// то есть цена ожидания = один round-trip к шлюзу. 6 с хватает даже медленному WAF, а
// раньше выхода из ожидания добивается watchOauthState: пришёл отказ — попапа не будет.
const GH_POPUP_WAIT_MS = 6000;
// Живы мы или нет, решается гонкой «аватар в шапке / SPA увела на /login» (см. consoleGate).
// Потолок нужен только на третий случай — белый экран, когда не случилось ни того, ни другого.
const CONSOLE_GATE_MS = 8000;

const labelArg = process.argv[2];
const label = (labelArg || `ar_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto | checkin | autocheckin
const profileDir = path.join(PROFILES_DIR, label);

// ───── Адрес, через который идёт ЭТОТ прогон ─────────────────────────────
//
// Родитель кладёт его разовым файлом и ждёт, что мы его съедим: ни аргументом, ни через
// env нельзя - список процессов машины виден целиком вместе с паролем прокси.
//
// 🪤 Почему браузер вообще идёт через прокси (отмена решения 12.09). Прямой путь с рабочей
// станции выходит адресом ноды CH - локальный tun включён всегда, - и панель жжёт этот
// адрес после ~19 запросов логина (замер 20.09, окно ~20 мин). То есть «идти напрямую»
// означало светить своей же нодой. Разбор - wiki «Ротация адресов под подарки AgentRouter».
const PROXY_SEED_DIR = path.join(__dirname, '..', 'routing', 'runtime', 'ar-proxy');

function takeProxySeed(lbl) {
  const file = path.join(PROXY_SEED_DIR, `${lbl}.json`);
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;                       // нет файла - прогон без прокси (пул выключен или визит 🌐)
  }
  try { fs.rmSync(file, { force: true }); } catch { /* не удалился - не беда, перезапишут */ }
  const p = doc && doc.proxy;
  if (!p || !p.server) return null;
  // 🔴 Страховка от «адреса-пустышки». 20.09 родитель собрал строку из несуществующего поля
  // (`host` вместо `hostname`), в окно уехало `http://undefined:10808`, браузер не достучался
  // никуда - и это выглядело как «край не отвечает», то есть как вина панели, а не наша.
  // Лучше громко упасть здесь, чем полтора часа искать причину в чужом огороде.
  if (/undefined|null|:\s*$/.test(String(p.server))) {
    console.error(`❌ Адрес прогона собран неправильно: ${p.server}. Браузер не поднимаю.`);
    process.exit(7);
  }
  return {
    server: String(p.server),
    username: p.username ? String(p.username) : undefined,
    password: p.password ? String(p.password) : undefined,
  };
}

const proxySeed = takeProxySeed(label);

// 🔴 Chromium молча уходит НАПРЯМУЮ, если у SOCKS-прокси есть логин с паролем: не ошибка,
// не отказ - просто тихий выход домашним (в нашем случае нодовым) адресом, ровно то, от
// чего прокси и защищает. Падаем явным текстом ДО запуска браузера (код 7 - как раньше).
if (proxySeed && /^socks/i.test(proxySeed.server) && proxySeed.username) {
  console.error('❌ SOCKS с логином и паролем: Chromium такое игнорирует и идёт напрямую.');
  console.error('   Нужен http:// с авторизацией либо socks5 без пароля. Браузер не поднимаю.');
  process.exit(7);
}
if (proxySeed) {
  console.log(`🌐 прогон через адрес ${proxySeed.server}${proxySeed.username ? ' (с авторизацией)' : ''}`);
}

// Тихий режим окна. Очередь ⚡ открывает окна сама и не должна трогать рабочее место
// владельца («заебало они забирают фокус», 19.09). 🎁 ручной чек-ин и обход ЛК - наоборот:
// там человек сидит в окне.
// 🔴 Регистрация - тоже «человек в окне», и прятать её нельзя. Аккаунт без ключа заводят
// руками: скрипт печатает «зарегайся через GitHub на открывшейся странице» и ждёт логина
// до 10 минут. В headless страницы нет вовсе, то есть ожидание безнадёжно по построению -
// человеку некуда нажимать. Свежая установка 23.09 (друг): режим `register` ушёл без окна,
// прогон умер по таймауту, а в дашборде это читалось как «браузер не появляется», следом -
// «браузер уже открыт» (процесс всё это время был жив и ждал).
let silentWindow = !['checkin', 'console', 'register'].includes(mode);

// Счётчик запросов к ручке логина. Панель режет ИМЕННО её по IP: замер 20.09 дал ~19
// запросов на адрес и окно отстоя ~20 мин. Родитель запишет это число в счётчик адреса,
// чтобы пул знал, когда уводить его в отстой, - поэтому считаем по факту, а не «примерно».
//
// 🪤 Отдельной функцией, а не телом main: регресс `check-checkin-preflight` стережёт, что
// ДО разлогина state-OAuth не запрашивается вообще, и упоминание этого пути прямо в main
// валит его проверку. Проверка полезная - запрос подменил бы живую сессию аккаунта.
function watchLoginRequests(context) {
  const hit = { n: 0 };
  context.on('request', r => {
    try { if (r.url().includes('/api/oauth/state')) hit.n++; }
    catch { /* разбор URL не наша забота */ }
  });
  return hit;
}


// ───── Полный след прогона чек-ина в файл ────────────────────────────────
// Дашборд ловит stdout скрипта и льёт его в logLine, а тот пишет в консоль и в кольцо
// на 400 строк. Кольцо затапливает keepalive за секунды (он логирует каждый ping), и к
// моменту разбора от прогона не остаётся НИЧЕГО — 24.08 так и вышло: «автоподарок берёт
// кэш» проверить было не по чему. Поэтому оба режима чек-ина дублируют вывод в файл.
// Только они: обычный визит в ЛК живёт минутами и мусорил бы каталогом.
//
// Каждая строка ФАЙЛА помечена временем от старта скрипта — иначе «долго» невозможно
// разобрать: до 10.09 в логе не было ни одной отметки времени, и на вопрос «где ушли
// 57 секунд» приходилось гадать по порядку строк. В stdout префикс НЕ идёт намеренно:
// его разбирает бэкенд (маркер AUTOCHECKIN_RESULT), формат там менять незачем.
const T0 = Date.now();
const elapsed = () => `[+${((Date.now() - T0) / 1000).toFixed(1)}s]`.padEnd(9);
// 🔴 Регистрация тоже заводит след: 23.09.2026 прогон у друга умер по таймауту логина, и
// разбирать было нечем - в логе хаба одна строка, а stdout ребёнка тонет в общем кольце.
const RUN_LOG = (mode === 'checkin' || mode === 'autocheckin' || mode === 'register') ? (() => {
  try {
    const dir = path.join(__dirname, '..', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `ar-checkin-${label}-${stamp}.log`);
    const fd = fs.openSync(file, 'a');
    for (const kind of ['log', 'error']) {
      const orig = console[kind].bind(console);
      console[kind] = (...args) => {
        orig(...args);
        try { fs.writeSync(fd, elapsed() + ' ' + args.map(a => typeof a === 'string' ? a : String(a)).join(' ') + '\n'); } catch {}
      };
    }
    return file;
  } catch { return null; }
})() : null;

// Ручной вход в GitHub, сделанный человеком в открытом окне, тоже должен попасть в копию
// сессии — до 2026-08-22 копия снималась один раз, при открытии, и ручной вход терялся.
const ghCapture = require('../routing/lib/gh-live-capture.js').makeCapture({
  label,
  moduleDir: __dirname,
  poolFile: path.join(__dirname, '..', 'routing', 'agentrouter-sessions.json'),
});

// Если рядом лежит <label>.json — применяем его как storageState: cookies + localStorage.
// Два разных источника такого файла, и различать их обязательно:
//   share-код друга      → аккаунт agentrouter уже создан, GitHub/agentrouter сразу залогинены;
//   seed:'github'        → только GitHub-куки, аккаунта agentrouter ещё НЕТ (см. seededGithub).
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
      // пропустит регистрацию по рефке — реф-кредит потеряется.
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
// (поймано на двух ar-аккаунтах, 2026-08-17). Кеш профиля чистить нельзя вслепую,
// поэтому ходим мимо HTTP-кеша: сессия и localStorage остаются на месте.
// Вешаем и на новые вкладки — GitHub-OAuth умеет открываться попапом.
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

// Первый GitHub-вход с реф-ссылки регулярно заканчивался ошибкой сайта
// «failed to get user information», и лечилось это руками: вставить реф-ссылку
// заново и обновить страницу. Автоматизируем ровно этот обход.
const AUTH_ERROR_RE = /failed to get user info|无法获取用户信息|не удалось получить (данные|информацию)/i;

async function pageHasAuthError(page) {
  try {
    return AUTH_ERROR_RE.test(await page.evaluate(() => document.body ? document.body.innerText : ''));
  } catch { return false; }
}

// Реф-код сайт хранит в localStorage (ключ `aff`) и переживает уход на другие
// страницы — проверено пробником. Поэтому сначала заходим по реф-ссылке (сажаем
// код в профиль), потом прогреваем корень (SPA поднимается, /api/status и
// cf_clearance оседают), и только потом показываем страницу регистрации.
async function openRegisterViaRef(page) {
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const readAff = () => page
    .evaluate(() => { try { return localStorage.getItem('aff'); } catch { return null; } })
    .catch(() => null);

  // Happy path — ОДНА навигация. Код оседает с первого захода, и прыжки
  // рефка → корень → рефка пользователь видел как метание страницы; они же
  // рвали OAuth-state, если сайт успевал уехать на GitHub-вход сам.
  const aff = await readAff();
  if (aff) {
    console.log(`🤝 реф-код сохранён в профиль: aff=${aff}`);
    return;
  }

  console.log('⚠️  реф-код не осел с первого раза — прогреваю корень и захожу заново');
  if (/github\.com/i.test(page.url())) {
    console.log('↪️  сайт сам ушёл на GitHub-вход — не перебиваем редирект');
    return;
  }

  await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  if (/github\.com/i.test(page.url())) {
    console.log('↪️  сайт сам ушёл на GitHub-вход — не перебиваем редирект');
    return;
  }
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const aff2 = await readAff();
  console.log(aff2
    ? `🤝 реф-код сохранён в профиль со второй попытки: aff=${aff2}`
    : '⚠️  реф-код так и не осел в localStorage — регистрация может не зачесться');
}

// После GitHub-логина: обновляем страницу, и если сайт всё-таки ответил
// «failed to get user information» — заходим по реф-ссылке снова (реф-код уже в
// localStorage, кредит не теряется). Два прохода: ошибка транзиентная.
async function settleAfterLogin(page) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
    if (!(await pageHasAuthError(page))) return true;
    console.log(`⚠️  сайт ответил «failed to get user information» — повтор ${attempt}/2 по реф-ссылке…`);
    await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  return !(await pageHasAuthError(page));
}

// Ждём, пока GitHub-вход пройден и появился auth-cookie на agentrouter.org —
// значит мы внутри консоли. Профиль в этот момент уже сохраняется Chromium'ом на диск.
// Страницу регистрации/логина в зачёт не берём: на ней куки (csrf и прочее) есть сразу,
// иначе «вход выполнен» печаталось бы через полторы секунды после старта.
async function waitForLogin(page, context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = page.url();
    const cookies = await context.cookies('https://agentrouter.org').catch(() => []);
    const leftAuth = !/\/register|\/login|\/sign-in|\/sign-up/.test(url);
    if (url.includes('agentrouter.org') && leftAuth && hasSessionCookie(cookies)) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

// ───── Автоподарок: вход через GitHub без человека ────────────────────────
// Разведка живой страницы (2026-08-22, Playwright + бандл assets/index-*.js):
//
//   async function v7(clientId, mode = "login") {          // обработчик кнопки
//     const state = await b7(mode);                         // GET /api/oauth/state?aff=…&mode=login
//     state && (localStorage.setItem("oauth_mode", mode),
//       window.open(`https://github.com/login/oauth/authorize?client_id=${clientId}&state=${state}&scope=user:email`))
//   }
//
// Отсюда три вывода, на которых держится вся ветка autocheckin:
//   1. Кнопка входа — <button> с подписью «使用 GitHub 继续» (UI сайта китайский) и
//      иконкой .semi-icon-github_logo. Селектор по тексту «Continue with GitHub»
//      не сработал бы никогда; в подвале сидят ещё две ссылки на github.com —
//      берём только BUTTON.
//   2. Клик открывает ПОПАП: GitHub-вход и колбэк /oauth/github?code=… уезжают
//      туда, исходная вкладка остаётся на /login. window.opener сайт не трогает.
//      Поэтому ждать успех по page.url() исходной вкладки нельзя (см. ниже).
//   3. Колбэк идёт в /api/oauth/github?code=…&state=…&mode=login, и в ответе
//      шлюз САМ сообщает, налил ли суточный бонус: data.checked_in. Это честнее
//      любого угадывания по росту выдачи — его и отдаём в дашборд.
const OAUTH_API_RE = /\/api\/oauth\/github/i;

// Тело ответа читаем через перехват, а не в обработчике 'response': к моменту, когда
// resp.json() доберётся до тела, SPA уже уводит страницу на /console/token, тело
// выбрасывается и мы молча остаёмся без checked_in (так и было в первом прогоне).
// route.fetch() буферизует ответ у нас, fulfill отдаёт его странице — одноразовый
// `code` при этом расходуется РОВНО один раз.
function watchOauthResult(context) {
  const out = { seen: false, success: null, checkedIn: null, message: '', userId: null };
  context.route(OAUTH_API_RE, async (route) => {
    try {
      const resp = await route.fetch();
      const body = await resp.text();
      try {
        const j = JSON.parse(body);
        out.seen = true;
        out.success = !!j.success;
        out.message = String(j.message || '');
        out.checkedIn = !!(j.data && j.data.checked_in);
        // id пользователя нужен для заголовка New-Api-User: в localStorage его пишет
        // колбэк-компонент, а мы к тому моменту уже закрываем попап — своя копия надёжнее.
        out.userId = (j.data && j.data.id) || null;
        // 🪤 quota/used_quota в колбэке ЕСТЬ, но они ОБНУЛЕНЫ. Проверено живым прогоном
        // 2026-08-22 на аккаунте с $175: `checked_in: true` приехало верное, а
        // `quota: 0, used_quota: 0`. То есть шлюз отдаёт на входе урезанный объект
        // пользователя (в списке полей при этом видны и password, и access_token —
        // дело не в санитайзе целиком, обнулена именно квота).
        // Поэтому балансом из колбэка пользоваться НЕЛЬЗЯ: он выглядит как настоящая
        // цифра, а записал бы в пул $0 — с вышибанием активного аккаунта
        // (moneyKickOnZero) и сломанным детектом чек-ина (granted стал бы нулём).
        // Из колбэка берём только два факта: зачтён ли бонус и id пользователя.
        if (j.data) console.log(`🧾 колбэк отдал поля: ${Object.keys(j.data).join(',')}`);
        console.log(out.success
          ? `🔑 шлюз принял GitHub-вход${out.checkedIn ? ', суточный чек-ин зачтён' : ' — чек-ин НЕ зачтён (окно ещё не сменилось)'}`
          : `⚠️  шлюз отверг вход: ${out.message || 'без причины'}`);
      } catch { /* не json (заглушка WAF) — решит /api/user/self */ }
      await route.fulfill({ response: resp, body });
    } catch (e) {
      // Перехват не должен ломать вход: не смогли прочитать — пропускаем как есть.
      console.log(`⚠️  ответ колбэка прочитать не удалось (${e.message})`);
      await route.continue().catch(() => {});
    }
  }).catch(() => {});
  return out;
}

// GitHub-стена: логин, пароль, 2FA, подтверждение устройства. Сюда попадаем, когда
// сессия в профиле мертва. `login/oauth/…` в стену НЕ входит — это нормальный шаг
// OAuth, поэтому negative lookahead обязателен.
const GH_AUTH_WALL_RE = /github\.com\/(login(?!\/oauth)|session\b|sessions\/)/i;

// Почему начать GitHub-вход не удалось. Заполняется clickGithubLogin/buildAuthorizeUrl,
// читается в main — от этого зависит, каким кодом выходить (4 «вёрстку переделали» или
// 6 «край не ответил») и что владелец прочтёт в тосте. Раньше причина не хранилась
// вообще: любой отказ печатался одним текстом про переделанную страницу входа.
//   edge-silent — /api/status или /api/oauth/state ответили пусто/не-JSON: рейт-лимит,
//                 WAF по IP, обрыв. Вёрстка ни при чём;
//   no-client-id — край ОТВЕТИЛ json'ом, но github_client_id в нём нет: вход через
//                 GitHub у шлюза выключен или переехал;
//   no-state    — /api/oauth/state отказал словами (success:false);
//   error       — запрос из страницы вообще не состоялся. Считаем краем: до вёрстки
//                 дело не дошло.
const loginStart = { why: null, detail: '', hadButton: false };

// Фолбэк на случай, если кнопки на странице нет или попап не открылся: собираем тот
// же authorize-URL руками. client_id читаем из живого /api/status (хардкодить нельзя —
// шлюз может пересоздать OAuth-приложение), `aff` подставляем как сайт, иначе
// регистрация нового аккаунта потеряла бы реф-кредит.
//
// Возвращает { url } либо { why, detail } — см. loginStart. 🪤 Тело читаем ТЕКСТОМ и
// парсим сами: прежняя версия звала resp.json() и на пустом ответе края улетала в
// исключение, а исключение снаружи выглядело так же, как «кнопки нет» — отсюда и
// неверный диагноз в отказе.
async function buildAuthorizeUrl(page) {
  try {
    const r = await page.evaluate(async () => {
      const get = async (u) => {
        const resp = await fetch(u, { credentials: 'include' });
        const body = await resp.text();
        let json = null;
        try { json = JSON.parse(body); } catch { /* пусто или HTML-челлендж WAF */ }
        return { status: resp.status, len: body.length, json };
      };
      const st = await get('/api/status');
      if (!st.json) return { why: 'edge-silent', detail: `/api/status → HTTP ${st.status}, тело ${st.len} Б, не JSON` };
      const cid = st.json.data && st.json.data.github_client_id;
      if (!cid) return { why: 'no-client-id', detail: '/api/status ответил, но github_client_id в нём нет' };
      let q = '/api/oauth/state?mode=login';
      const aff = localStorage.getItem('aff');
      if (aff) q += '&aff=' + encodeURIComponent(aff);
      const s = await get(q);
      if (!s.json) return { why: 'edge-silent', detail: `/api/oauth/state → HTTP ${s.status}, тело ${s.len} Б, не JSON` };
      const state = s.json.success && s.json.data;
      if (!state) return { why: 'no-state', detail: `/api/oauth/state отказал: ${s.json.message || 'без причины'}` };
      localStorage.setItem('oauth_mode', 'login');
      return { url: `https://github.com/login/oauth/authorize?client_id=${cid}&state=${state}&scope=user:email` };
    });
    return r && (r.url || r.why) ? r : { why: 'error', detail: 'страница не вернула ни URL, ни причины' };
  } catch (e) {
    return { why: 'error', detail: e.message };
  }
}

// Признак «попапа не будет» вместо слепого потолка. Обработчик кнопки (см. разбор v7
// выше) СНАЧАЛА спрашивает /api/oauth/state и только при годном ответе зовёт
// window.open. Значит отказ на этом запросе — приговор: ждать попап дальше бессмысленно.
// Ровно так сгорели 15 с в замере 10.09 (край был под рейт-лимитом и молчал всем, чем мог).
const OAUTH_STATE_RE = /\/api\/oauth\/state/i;
function watchOauthState(page) {
  const out = { seen: false, done: false, ok: false, note: '' };
  const onResp = async (r) => {
    if (out.done || !OAUTH_STATE_RE.test(r.url())) return;
    let body;
    try {
      body = await r.text();
    } catch (e) {
      // 🪤 Тело не прочиталось — это НЕ приговор. Вердикт обрывает вход, и выносить его
      // на СВОЕЙ ошибке чтения нельзя: попап в этот момент может уже открываться.
      // Без `done` дальше работает обычный потолок, то есть худший случай = как раньше.
      out.note = `тело /api/oauth/state не прочиталось (${e.message})`;
      return;
    }
    out.seen = true;
    try {
      const j = JSON.parse(body);
      out.ok = !!(j && j.success && j.data);
      out.note = out.ok ? 'state получен' : `шлюз отказал: ${(j && j.message) || 'без причины'}`;
    } catch {
      out.ok = false;
      out.note = `HTTP ${r.status()}, тело не JSON (пусто или заглушка WAF)`;
    }
    out.done = true; // приговор выносит ПЕРВЫЙ прочитанный ответ, второй его не перебивает
  };
  page.on('response', onResp);
  return { out, off: () => page.off('response', onResp) };
}

// Ждём попап, но не вслепую: выходим сразу, как только watchOauthState вынес отказ.
// Потолок остаётся на случай, когда ответа нет вообще (запрос повис) — он короткий,
// потому что после годного state window.open зовётся в том же обработчике, без сети.
async function awaitGithubPopup(context, page, stateWatch) {
  let popup = null;
  const popupP = context.waitForEvent('page', { timeout: GH_POPUP_WAIT_MS })
    .then(p => { popup = p; return p; })
    .catch(() => null);
  const deadline = Date.now() + GH_POPUP_WAIT_MS;
  while (Date.now() < deadline) {
    if (popup) return popup;
    if (stateWatch.out.done && !stateWatch.out.ok) {
      console.log(`⏱️  попапа не будет: сайт спросил /api/oauth/state и получил — ${stateWatch.out.note}`);
      return null;
    }
    await page.waitForTimeout(100).catch(() => {});
  }
  return await popupP;
}

// Шлюз встречает модалкой «系统公告» (14 объявлений) поверх формы входа. Playwright
// честно ждал, пока она уйдёт: клик по кнопке GitHub упирался в .semi-modal-wrap,
// перебирал попытки и в итоге уходил в фолбэк (поймано на третьем прогоне 2026-08-22).
// Гасим сами: Escape, если не помог — крестик.
async function dismissModals(page) {
  for (let i = 0; i < 3; i++) {
    const wrap = page.locator('.semi-modal-wrap').first();
    if (!(await wrap.isVisible().catch(() => false))) return;
    if (i === 0) console.log('🪧 закрываю модалку объявлений — она перекрывает кнопку входа');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400).catch(() => {});
    if (!(await wrap.isVisible().catch(() => false))) return;
    const x = page.locator('.semi-modal-close').first();
    if (await x.count().catch(() => 0)) await x.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400).catch(() => {});
  }
}

// Возвращает страницу, на которой пойдёт GitHub-часть (попап или та же вкладка),
// либо null — значит начать вход нечем (причина остаётся в loginStart).
async function clickGithubLogin(context, page) {
  loginStart.why = null; loginStart.detail = ''; loginStart.hadButton = false;
  await dismissModals(page);
  const byIcon = page.locator('button:has(.semi-icon-github_logo)').first();
  const byText = page.locator('button').filter({ hasText: /github/i }).first();
  // Ждать обязательно: reportRender возвращается, как только #root не пуст, а кнопки
  // сторонних входов SPA дорисовывает позже — в первом прогоне их «не было».
  // 🪤 Но ждать кандидатов ПО ОЧЕРЕДИ нельзя: на странице без кнопки это два потолка
  // подряд, то есть 20 с в пустоту. Ждём оба разом — Promise.any берёт первого
  // появившегося и не падает из-за того, что второй не пришёл.
  const target = await Promise.any([
    byIcon.waitFor({ state: 'visible', timeout: GH_BTN_WAIT_MS }).then(() => byIcon),
    byText.waitFor({ state: 'visible', timeout: GH_BTN_WAIT_MS }).then(() => byText),
  ]).catch(() => null);

  if (target) {
    loginStart.hadButton = true;
    // Слушаем ответ на /api/oauth/state ДО клика: сайт зовёт его первым делом, и именно
    // он решает, откроется попап или нет.
    const stateWatch = watchOauthState(page);
    try {
      await target.click({ timeout: 5000 }).catch(e => console.log(`⚠️  клик по кнопке GitHub не прошёл: ${e.message}`));
      const popup = await awaitGithubPopup(context, page, stateWatch);
      if (popup) {
        console.log('🪟 попап GitHub-входа открылся');
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        return popup;
      }
    } finally {
      stateWatch.off();
    }
    console.log('⚠️  попап не появился — собираю authorize-URL сам');
  } else {
    console.log('⚠️  кнопки входа через GitHub на странице нет — собираю authorize-URL сам');
  }

  const built = await buildAuthorizeUrl(page);
  if (!built.url) {
    loginStart.why = built.why || 'error';
    loginStart.detail = built.detail || '';
    console.log(`⚠️  authorize-URL собрать не удалось (${loginStart.why}): ${loginStart.detail}`);
    return null;
  }
  console.log('↪️  иду на GitHub authorize в этой же вкладке');
  await page.goto(built.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  return page;
}

// Проводим попап через GitHub-часть. Возвращаем, чем всё кончилось: dead — сессия
// мертва (дальше идти некуда), authorized — нажали согласие на доступ приложению,
// callback — GitHub уже вернул на шлюз, closed — попап закрылся сам (это норма:
// SPA колбэка могла успеть отработать).
async function passGithubGate(gh) {
  for (let i = 0; i < 25; i++) {
    if (gh.isClosed()) return 'closed';
    const url = gh.url();
    if (/agentrouter\.org/i.test(url)) return 'callback';
    if (GH_AUTH_WALL_RE.test(url)) return 'dead';
    if (/github\.com\/login\/oauth\/authorize/i.test(url)) {
      const btn = gh.locator('button[name="authorize"]').first();
      const n = await btn.count().catch(() => 0);
      if (n > 0) {
        console.log('🔓 GitHub просит подтвердить доступ приложению — жму Authorize (один раз)');
        await btn.click({ timeout: 5000 }).catch(e => console.log(`⚠️  Authorize не нажался: ${e.message}`));
        return 'authorized';
      }
    }
    await gh.waitForTimeout(700).catch(() => {});
  }
  return 'unknown';
}

// Успех входа определяем ПО ОТВЕТУ ШЛЮЗА на колбэк, а не по наличию куки. Ловушка,
// стоившая первого прогона (2026-08-22): `/api/oauth/state` сам ставит куку с именем
// `session` (в ней сервер держит state OAuth), она проходит по hasSessionCookie — и
// «вход выполнен» печаталось ДО того, как GitHub вообще вернулся. Скрипт тут же уводил
// вкладку на консоль и обрывал летящий запрос колбэка: сессия так и не создавалась,
// точный баланс потом отвечал «сессия профиля недействительна (HTTP 401)».
//
// Для ручного режима после doCheckinLogout достаточно дождаться новой сессионной куки:
// старые куки домена уже удалены, а точный /api/user/self оставляем исключительно
// родительскому HTTP-пути после закрытия браузера. Браузер не читает и не сохраняет баланс.
async function waitForSiteSession(context, page, timeoutMs, oauth, pollMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (oauth && oauth.seen && oauth.success === false) return { ok: false, rejected: true, message: oauth.message };
    // `/api/oauth/state` itself creates a `session` cookie before GitHub returns. Only the
    // gateway callback proves that login completed; accepting the cookie closes Chromium
    // mid-OAuth, especially in manual mode.
    if (oauth && oauth.seen && oauth.success === true) return { ok: true };
    await page.waitForTimeout(pollMs).catch(() => {});
  }
  return { ok: false, rejected: false };
}

// ───── Резервная копия GitHub-сессии профиля ─────────────────────────────
// GitHub-куки — самое дорогое, что есть в профиле: вход обратно должен стоить один клик
// «Continue with GitHub», а у авторегов пароля и 2FA под рукой может не быть вообще.
// Поэтому перед КАЖДЫМ разлогином снимаем копию на диск. Копия нужна не только от нашего
// кода: GitHub сам гасит сессию, если тем же аккаунтом вошли в другом месте (и тем более
// если по нему стучались сырыми запросами) — тогда следующий чек-ин восстановит её отсюда.
// В файле лежат сессионные секреты — каталог в .gitignore, значения в лог не пишем.
const GH_BACKUP_DIR = path.join(__dirname, 'gh-sessions');

function ghBackupPath(lbl) {
  return path.join(GH_BACKUP_DIR, lbl + '.json');
}

function isGithubCookie(c) {
  const d = String(c.domain || '').replace(/^\./, '');
  return d === 'github.com' || d.endsWith('.github.com');
}

// Сохраняем только куки с ненулевым сроком: сессионные (expires ≤ 0) всё равно умирают
// вместе с браузером, и восстанавливать их бессмысленно.
function saveGhBackup(lbl, cookies) {
  const keep = cookies.filter(c => isGithubCookie(c) && c.expires > 0);
  if (!keep.length) return 0;
  try {
    fs.mkdirSync(GH_BACKUP_DIR, { recursive: true });
    fs.writeFileSync(ghBackupPath(lbl), JSON.stringify({ savedAt: new Date().toISOString(), cookies: keep }, null, 2) + '\n', 'utf8');
    return keep.length;
  } catch (e) {
    console.log(`⚠️  копию GitHub-сессии сохранить не удалось: ${e.message}`);
    return 0;
  }
}

// Только не истёкшие: просроченную куку Chromium примет и молча выбросит, а в логе
// это выглядело бы как «восстановил», хотя вход всё равно попросит пароль.
function loadGhBackup(lbl) {
  try {
    const j = JSON.parse(fs.readFileSync(ghBackupPath(lbl), 'utf8'));
    const now = Date.now() / 1000;
    return { savedAt: j.savedAt, cookies: (j.cookies || []).filter(c => c.expires > now) };
  } catch { return null; }
}

// ───── Общий снимок сессии: github/sessions/<ghId>.json ──────────────────
// Копия выше — СВОЯ, на каждую запись пула отдельная, и появляется она только после того,
// как этот скрипт хоть раз отработал под живой сессией. Общий снимок — другой слой: он
// на GitHub-АККАУНТ, его наполняет харвест из любого профиля любого шлюза и живой захват
// кук (routing/lib/gh-live-capture.js → writeShared) прямо во время наших окон.
//
// 🪤 Запись сюда была двусторонней с самого начала, а чтения не было вовсе. Из-за этого
// автоподарок выходил с кодом 3 «GitHub-сессия мертва, возьми готовый GitHub заново» —
// хотя годная сессия ЭТОГО ЖЕ аккаунта лежала на диске рядом. Замер 10.09: общий снимок
// был у всех 20 привязанных записей AR, 16 из них моложе суток.
//
// По TTL 7 суток НЕ отсекаем (решение владельца): это наша осторожная оценка, а не срок
// от GitHub — кука `user_session` живёт дольше. Цена лишней попытки — одно окно, цена
// отказа — гарантированно не забранный подарок. Возраст просто честно пишем в лог.
const AR_POOL_FILE = path.join(__dirname, '..', 'routing', 'agentrouter-sessions.json');
const GH_SHARED_DIR = path.join(__dirname, '..', 'github', 'sessions');

function sharedGhPath(ghId) {
  return path.join(GH_SHARED_DIR, String(ghId).replace(/[^\w-]/g, '_') + '.json');
}

// ghId записи пула по её label. Резолвер уже написан и экспортирован живым захватом —
// второй копии тут не заводим.
function ghIdForThisLabel() {
  try {
    return require('../routing/lib/gh-live-capture.js').ghIdForLabel(AR_POOL_FILE, label) || null;
  } catch { return null; }
}

// Снимок для этого аккаунта или null. Куки — формат storageState, `context.addCookies()`
// принимает их как есть; сессионные (`expires: -1`) отбрасываем, как и в локальной копии:
// они всё равно умирают вместе с браузером.
function loadSharedGhSnapshot() {
  const ghId = ghIdForThisLabel();
  if (!ghId) return null;
  try {
    const j = JSON.parse(fs.readFileSync(sharedGhPath(ghId), 'utf8'));
    const now = Date.now() / 1000;
    const cookies = (j.cookies || []).filter(c => c.expires > now || c.expires === -1);
    if (!cookies.length) return null;
    const ms = j.harvestedAt ? Date.now() - Date.parse(j.harvestedAt) : NaN;
    return {
      ghId,
      ghLogin: j.ghLogin || null,
      harvestedAt: j.harvestedAt || null,
      ageDays: Number.isFinite(ms) ? +(ms / 86400000).toFixed(1) : null,
      cookies,
    };
  } catch { return null; }
}

// Влить общий снимок в открытый контекст. Возвращает описание попытки для лога и маркера.
async function seedFromSharedSnapshot(context, why) {
  const snap = loadSharedGhSnapshot();
  if (!snap) {
    console.log(`🐙 общего снимка сессии для этого аккаунта нет (${why})`);
    return null;
  }
  const age = snap.ageDays === null ? 'возраст неизвестен'
    : `возраст ${snap.ageDays} дн${snap.ageDays > 7 ? ', старше TTL 7 сут — пробуем всё равно' : ''}`;
  try {
    await context.addCookies(snap.cookies);
    const after = await context.cookies('https://github.com').catch(() => []);
    const ok = after.some(c => c.name === 'user_session' && c.value);
    console.log(`🐙 поднял сессию из общего снимка ${snap.ghLogin || snap.ghId} (${age}): ${snap.cookies.length} кук`
      + `${ok ? ' — user_session на месте' : ' — ⚠️ user_session не появилась'}`);
    return { ...snap, ok };
  } catch (e) {
    console.log(`⚠️  общий снимок ${snap.ghLogin || snap.ghId} влить не удалось: ${e.message}`);
    return { ...snap, ok: false };
  }
}

// Копия свежей GitHub-сессии после успешного входа/открытия ЛК. Именно этот снимок
// потом вернёт чек-ин, если GitHub погасит сессию сам. Пустую копию не пишем — иначе
// один заход с уже мёртвым GitHub затёр бы годную.
// Куки живого контекста — в jar, чтобы бэкенд ходил с тем же пруфом WAF, что и браузер.
// Ключевое здесь — СЕССИОННЫЕ куки: `acw_sc__v2` от Aliyun живёт только в памяти окна, в
// SQLite профиля не попадает, и чтение профиля её не находит никогда. Без неё наш
// node-клиент на `/api/user/self` получает HTML-челлендж («WAF-заглушка»), сколько бы он
// ни ждал — JS он не исполняет. С ней шанс пройти появляется, потому что пруф уже добыт
// браузером. Значения в лог не пишем, только имена.
async function harvestCookiesToJar(context) {
  try {
    const lib = require('../routing/lib/newapi-account.js');
    if (typeof lib.putJarCookies !== 'function') return;
    const ck = await context.cookies('https://agentrouter.org').catch(() => []);
    if (!ck.length) return;
    const map = {};
    for (const c of ck) if (c.name && c.value) map[c.name] = c.value;
    const n = lib.putJarCookies('agentrouter.org', profileDir, map);
    const session = ck.filter(c => !(c.expires > 0)).map(c => c.name);
    console.log(`🍪 куки контекста → jar: ${Object.keys(map).length} имён (${Object.keys(map).join(', ')})`
      + `${n ? `, обновлено ${n}` : ', новых значений нет'}`
      + `${session.length ? ` · сессионных, которых нет на диске: ${session.join(', ')}` : ''}`);
  } catch (e) {
    console.log(`⚠️  куки в jar не уехали: ${e.message}`);
  }
}
// Как назвать сессию в тексте ошибки. Раньше здесь было безымянное «GitHub-сессия
// аккаунта мертва» — по такому сообщению владелец не знал, какой именно GitHub чинить,
// а их в менеджере три десятка. Ник берём из менеджера, ghId — запасной вариант.
function ghNameForError(seeded) {
  const ghId = (seeded && seeded.ghId) || ghIdForThisLabel();
  const login = seeded && seeded.ghLogin;
  if (login) return `«${login}»`;
  if (!ghId) return 'этого аккаунта';
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'routing', 'github-accounts.json'), 'utf8'));
    const rec = (Array.isArray(arr) ? arr : []).find(a => a.id === ghId);
    if (rec) return `«${rec.nickname || rec.login || ghId}»`;
  } catch { /* менеджер недоступен — обойдёмся ghId */ }
  return `«${ghId}»`;
}

async function backupGhAfterLogin(context) {
  const gh = await context.cookies('https://github.com').catch(() => []);
  const n = saveGhBackup(label, gh);
  if (n) console.log(`🐙 копия GitHub-сессии обновлена (${n} кук) — чек-ин сможет её вернуть`);
}

// Сразу после входа сайт любит отдать «未登录或登录已过期» / «failed to get user info» —
// это транзиентное: SPA поднялась на данных погашенной сессии. Лечится тем же, чем при
// регистрации, — перезагрузкой. Два прохода, потом просто говорим правду.
const CHECKIN_STALE_RE = /未登录|登录已过期|not logged in|failed to get user info/i;
// Колбэк GitHub-а: `code` одноразовый, повторный заход по этому URL сайт встречает
// уже потраченным кодом и отвечает «failed to fetch git token». Приём из
// gorouter/open-session.js: с колбэка не перезагружаемся, а уходим на консоль.
const OAUTH_CALLBACK_RE = /\/oauth\/(github|oidc)|[?&]code=/i;

async function settleAfterCheckin(page) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const txt = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (!CHECKIN_STALE_RE.test(txt) && !AUTH_ERROR_RE.test(txt)) return true;
    console.log(`⚠️  сайт показывает «сессия истекла» — обновляю страницу (${attempt}/2)…`);
    if (OAUTH_CALLBACK_RE.test(page.url())) await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1800);
  }
  const txt = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const bad = CHECKIN_STALE_RE.test(txt) || AUTH_ERROR_RE.test(txt);
  if (bad) console.log('⚠️  сообщение осталось — вход всё равно прошёл (кука есть), баланс проверится с диска.');
  return !bad;
}

// Тихий вариант reportRender: дождаться, что SPA нарисовалась. Нужен там, где белый
// экран не диагноз, а просто «ещё рано искать элемент». Ждать обязательно: HTTP-кеш у нас
// выключен намеренно (см. disableHttpCache), бандл и /api/user/self тянутся заново на
// каждом запуске, и шапки с аватаром в первые секунды в DOM нет вообще — на этом первый
// прогон UI-выхода и сорвался в фолбэк.
async function waitSpaReady(page, ms) {
  return page.waitForFunction(
    () => { const r = document.getElementById('root'); return !!r && r.innerHTML.length > 200; },
    { timeout: ms },
  ).then(() => true).catch(() => false);
}

// Подписка на ответ роута разлогина. Вешать ДО клика: сайт зовёт его сам, и другого
// надёжного признака выхода у нас нет (см. uiLogout — куку сервер не отзывает).
function watchLogoutAck(page) {
  const out = { seen: false, ok: false };
  const onResp = async (r) => {
    if (out.seen || !/\/api\/user\/logout/i.test(r.url())) return;
    out.seen = true;
    try {
      const j = JSON.parse(await r.text());
      out.ok = !!j.success;
    } catch { out.ok = r.status() === 200; }
  };
  page.on('response', onResp);
  return { out, off: () => page.off('response', onResp) };
}

// Убрать куки СВОЕГО домена через CDP. После UI-выхода они уже мертвы на сервере, но на
// диске остаются — а точный баланс дашборд читает по кукам профиля и принял бы мёртвую
// `session` за живую сессию (тот же ложный позитив, что с `user_session` у GitHub).
// Ровно перечисленные имена, чужих домены не касаемся — почему не clearCookies, см. apiLogout.
async function purgeSiteCookies(context, page) {
  const ck = await context.cookies('https://agentrouter.org').catch(() => []);
  if (!ck.length) return 0;
  let n = 0;
  try {
    const cdp = await context.newCDPSession(page);
    for (const k of ck) {
      await cdp.send('Network.deleteCookies', { name: k.name, domain: k.domain, path: k.path || '/' });
      n++;
    }
    await cdp.detach().catch(() => {});
  } catch { /* не вышло — не беда, сессия и так погашена сервером */ }
  return n;
}

// Куда сайт уводит разлогиненного. Отдельная константа, а не выражение по месту:
// проверка нужна и в гонке ниже, и в doCheckinLogout.
const AUTH_PAGE_RE = /agentrouter\.org\/(login|register|sign-in|sign-up)\b/i;

// Жива сессия или нет — решает ОДНА гонка: либо в шапке появился аватар (есть из чего
// выходить), либо SPA увела на /login (сервер сессию уже не принимает).
//
// 🪤 По куке это НЕ определяется. Шлюз гасит сессию, не отзывая `session` в браузере
// (замер 22.08, см. разбор в uiLogout), поэтому на протухшей сессии hasSessionCookie
// честно отвечает «есть» — и код шёл дальше искать аватар на странице входа с потолком
// 15 с. Замер 10.09: такой прогон стоил 57 с против 19 с у нормального.
//
// 🪤 И сразу после goto смотреть page.url() тоже бесполезно: /console/topup отдаёт тот
// же index.html, а на /login уводит уже поднявшийся бандл — редирект клиентский.
// Поэтому гонка, а не одна проверка: кто первый, тот и ответ.
async function consoleGate(page, avatar, ms = CONSOLE_GATE_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (AUTH_PAGE_RE.test(page.url())) return 'login';
    if (await avatar.isVisible().catch(() => false)) return 'live';
    await page.waitForTimeout(150).catch(() => {});
  }
  return 'unknown';
}

// Выход через меню профиля — основной путь с 2026-08-22 (просьба владельца).
// Раньше скрипт сразу удалял куки домена, и в окне это выглядело так: белая страница
// JSON-роута, потом сайт с руганью «не авторизован», и только потом форма входа. Клик по
// аватару делает то же самое руками сайта: сессию гасит его собственный обработчик, на
// /login SPA уезжает клиентским роутом (бандл заново не грузится), лишнего экрана с
// ошибкой не появляется вообще. GitHub-кук этот путь не касается совсем.
//
// Селекторы сняты с живой страницы 2026-08-22 (профиль acct_ar_1787282231931_14):
// аватар в шапке — единственный .semi-avatar внутри <button> (semi-avatar-extra-small,
// буква логина); дропдаун — .semi-dropdown-content с четырьмя <li>: 个人设置 / API令牌 /
// 钱包 / 退出. Ищем по тексту, а не по позиции: порядок пунктов шлюз уже менял.
//
// ⚠️ ПРИЗНАК УСПЕХА — ОТВЕТ РОУТА, А НЕ ПРОПАЖА КУКИ. Замерено там же: сайт зовёт
// GET /api/user/logout, получает {"success":true}, чистит localStorage.user и уезжает на
// /login — но `Set-Cookie` в ответе НЕТ, и `session` остаётся в браузере (значение то же,
// на сервере уже мёртвое). Первый прогон ждал пропажи куки, не дождался и honestly ушёл
// в фолбэк с удалением кук, хотя выход прошёл. Мёртвую куку убираем сами, но уже после —
// не как способ разлогина, а чтобы не оставлять на диске ложный признак живой сессии.
async function uiLogout(context, page) {
  await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const before = await context.cookies('https://agentrouter.org').catch(() => []);
  if (!hasSessionCookie(before)) {
    console.log('🚪 сессии сайта в профиле и не было — выходить не из чего');
    return true;
  }
  await dismissModals(page);
  await waitSpaReady(page, 25000);
  await dismissModals(page);

  const avatar = page.locator('button:has(.semi-avatar)').first();
  const gate = await consoleGate(page, avatar);
  if (gate === 'login') {
    // Кука в профиле есть, но сервер её уже не принимает — кабинет сам увёл на вход.
    // Дальше идти НЕКУДА: ни аватара, ни роута разлогина не будет, а эталон снимать
    // бессмысленно (оба его источника живут только при живой сессии — см.
    // readBaselineSelf). Мёртвую куку с диска убираем, чтобы точный баланс не принял её
    // за живую сессию: это тот же ложный позитив, что после UI-выхода.
    const purged = await purgeSiteCookies(context, page);
    console.log(`🚪 сессия сайта уже мертва — кабинет увёл на страницу входа, выходить не из чего`
      + `${purged ? `; мёртвых кук убрано ${purged}` : ''}`);
    return true;
  }
  if (gate === 'unknown') {
    console.log(`⚠️  ни аватара, ни страницы входа за ${CONSOLE_GATE_MS / 1000} с`
      + ` (url=${page.url()}, кнопок с аватаром ${await page.locator('button:has(.semi-avatar)').count().catch(() => '?')})`
      + ' — похоже на белый экран или заглушку WAF');
    return false;
  }

  const ack = watchLogoutAck(page);
  try {
    await avatar.click({ timeout: 5000 }).catch(e => console.log(`⚠️  клик по аватару не прошёл: ${e.message}`));
    const item = page.locator('.semi-dropdown-content li, .semi-dropdown-item').filter({ hasText: LOGOUT_MENU_RE }).first();
    const hasItem = await item.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
    if (!hasItem) { console.log('⚠️  в меню профиля нет пункта выхода'); return false; }
    await item.click({ timeout: 5000 }).catch(e => console.log(`⚠️  клик по «выйти» не прошёл: ${e.message}`));

    const until = Date.now() + 8000;
    while (!ack.out.seen && Date.now() < until) await page.waitForTimeout(200);
  } finally {
    ack.off();
  }

  if (!ack.out.ok) {
    console.log(ack.out.seen ? '⚠️  шлюз не подтвердил выход' : '⚠️  сайт так и не позвал роут разлогина');
    return false;
  }
  const purged = await purgeSiteCookies(context, page);
  console.log(`🚪 вышел через меню профиля — шлюз подтвердил${purged ? `, мёртвых кук убрано ${purged}` : ''}; GitHub-куки не тронуты`);
  return true;
}

// Фолбэк: погасить сессию, не считаясь с версткой сайта. Раньше это был основной путь.
//
// Порядок важен: сначала best-effort logout на сервере (пока куки ещё живые), потом
// удаляем куки домена — это и есть гарантия разлогина, не зависящая от роутов сайта.
//
// ⚠️ ПОЧЕМУ CDP, А НЕ context.clearCookies({domain}) — ловушка, стоившая GitHub-сессии
// (2026-08-20, аккаунт lankymapping). Фильтр в Playwright реализован как «снести ВЕСЬ
// cookie-store и переставить обратно то, что не подошло под фильтр». В ПАМЯТИ всё
// правильно (лог честно печатал «GitHub 4/4 на месте»), но удаление ложится в SQLite
// профиля сразу, а переставленные куки — лениво. Пользователь закрывает окно браузера
// (или процесс убивают) до флаша — и GitHub-кук на диске больше НЕТ.
// Замерено на чистых профилях: clearCookies-фильтр → GitHub 0/3 на диске,
// Network.deleteCookies → GitHub 3/3. CDP удаляет ровно названные записи и чужих
// не касается вообще, поэтому терять нечего.
// localStorage не трогаем: там реф-код `aff`, к сессии он не относится.
async function apiLogout(context, page, ghBefore) {
  await page.goto(LOGOUT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(800);

  const total = (await context.cookies('https://agentrouter.org').catch(() => [])).length;
  const deleted = await purgeSiteCookies(context, page);
  if (total && !deleted) {
    // Последний резерв — НЕ clearCookies(): он снёс бы GitHub (см. выше). Лучше
    // оставить пользователя разлогиниться руками, чем потерять вход одним кликом.
    console.log('⚠️  удалить куки через CDP не удалось — GitHub трогать не буду.');
    console.log('   Разлогинься на странице сам: аватар в шапке → 退出.');
  }
  const arLeft = (await context.cookies('https://agentrouter.org').catch(() => [])).length;
  console.log(`🚪 куки agentrouter.org: удалено ${deleted}/${total}, осталось ${arLeft}${arLeft === 0 ? ' — сессия погашена' : ' (разлогинься вручную)'}`);
  await restoreGithubIfLost(context, ghBefore);
}

// Чек-ин +$25: гасим сессию agentrouter и ставим браузер на страницу входа.
// Сначала по-человечески (меню профиля), и только если шапка не поддалась — грубым
// путём через удаление кук.
async function doCheckinLogout(context, page) {
  const ghBefore = (await context.cookies('https://github.com').catch(() => []));
  const saved = saveGhBackup(label, ghBefore);
  console.log(`🐙 GitHub-сессия: ${ghBefore.length} кук в профиле${saved ? `, копия сохранена (${saved} долгоживущих)` : ', сохранять нечего'}`);

  if (!(await uiLogout(context, page))) {
    console.log('↪️  выход через меню не вышел — гашу сессию удалением кук');
    await apiLogout(context, page, ghBefore);
  }

  // После клиентского роута мы, скорее всего, уже на /login — тогда навигация лишняя
  // и стоит секунду загрузки бандла заново.
  if (!/\/login\b/.test(page.url())) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await reportRender(page);
  // UI logout returns only success/failure; balance is never read in Chromium.
  return true;
}

// Страховка: сверяем GitHub-куки по ИМЕНАМ (а не по количеству — так видно, что именно
// пропало) и возвращаем недостающие. Сначала из снимка «до», потом из копии на диске:
// второй случай — когда GitHub погасил сессию сам, ещё до нашего разлогина. Третьим
// номером — общий снимок github/sessions/<ghId>.json: своей копии может не быть вовсе
// (аккаунт заселили готовой сессией и он ни разу тут не отрабатывал).
async function restoreGithubIfLost(context, ghBefore) {
  const after = await context.cookies('https://github.com').catch(() => []);
  const have = new Set(after.map(c => c.name));
  let missing = ghBefore.filter(c => !have.has(c.name));

  if (!missing.length) {
    const bk = loadGhBackup(label);
    if (!after.length && bk && bk.cookies.length) {
      console.log(`🐙 GitHub-кук в профиле нет — восстанавливаю из копии от ${bk.savedAt}`);
      missing = bk.cookies;
    } else if (!after.length) {
      // Ни кук, ни своей копии — последняя надежда на общий снимок.
      const seeded = await seedFromSharedSnapshot(context, 'ни кук в профиле, ни своей копии');
      if (!seeded || !seeded.ok) {
        console.log('🐙 GitHub-сессию вернуть нечем — вход попросит пароль/2FA');
      }
      return;
    } else {
      console.log(`🐙 GitHub-куки: ${after.length}/${ghBefore.length} на месте — вход одним кликом`);
      return;
    }
  } else {
    console.log(`⚠️  пропали GitHub-куки: ${missing.map(c => c.name).join(', ')} — возвращаю`);
  }

  try {
    await context.addCookies(missing);
    const fixed = await context.cookies('https://github.com').catch(() => []);
    const ok = fixed.some(c => c.name === 'user_session');
    console.log(`🐙 GitHub-куки возвращены в открытый браузер: ${fixed.length}${ok ? ' (user_session на месте — вход одним кликом)' : ' — ⚠️ user_session нет, вход попросит пароль/2FA'}`);
    // Возврат — это ВСТАВКА, а Chromium пишет вставки в SQLite лениво: закроешь окно
    // сразу — на диске их может не оказаться. Это не страшно, потому что источник
    // истины — копия на диске: следующий чек-ин восстановит заново из неё же.
    console.log('   (копия остаётся на диске — если закроешь окно слишком быстро, следующий чек-ин вернёт её снова)');
  } catch (e) {
    console.log(`⚠️  вернуть GitHub-куки не удалось (${e.message}) — войди в GitHub вручную, копия лежит в ${ghBackupPath(label)}`);
  }
}

// ───── Отпечаток: один UA на аккаунт, навсегда ───────────────────────────
//
// До 12.09 UA тут не задавался вовсе: окно ходило строкой самой сборки Playwright
// (`HeadlessChrome/148`) — то есть версией движка, а не живого браузера, и ОДИНАКОВОЙ у всех
// 20+ аккаунтов. Прокси развёл их по IP, а отпечаток остался общим.
//
// 🪤 UA обязан быть ЛИПКИМ ровно как прокси. Аккаунт, у которого между двумя входами
// сменился браузер, выглядит как угнанная сессия — тот же класс сигнала, что уже убил три
// GitHub-сессии. Поэтому выбор пишется на диск рядом с профилем и переживает перезапуск.
//
// 🪤 Только Chrome-строки. Playwright поднимает Chromium: Firefox- или Safari-UA в нём
// противоречит `navigator.userAgentData`, WebGL и порядку заголовков — это ХУЖЕ дефолта.
// Пакет `user-agents` (intoli) отдаёт живой срез реального трафика, из него берём Chrome.
const UA_DIR = path.join(__dirname, 'ua');
const UA_FALLBACK = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
];

// Генератор строится ОДИН раз: у пакета дорого строится фильтр, а не выборка.
let uaGen = null;
try {
  const UserAgent = require('user-agents');
  uaGen = new UserAgent({ deviceCategory: 'desktop' });
} catch { /* пакета нет — работаем на запасном списке */ }

function freshUserAgent() {
  for (let i = 0; i < 40 && uaGen; i++) {
    let candidate = '';
    try { candidate = String(uaGen().toString()); } catch { break; }
    // Chromium умеет притворяться только Chrome. Всё остальное создаёт противоречие
    // внутри одного отпечатка, поэтому просто тянем следующую строку.
    if (/Chrome\/\d+/.test(candidate) && !/Firefox|FxiOS|OPR\/|Edg\/|HeadlessChrome/.test(candidate)) {
      const v = Number((/Chrome\/(\d+)/.exec(candidate) || [])[1]);
      if (v >= 140) return candidate;
    }
  }
  return UA_FALLBACK[Math.floor(Math.random() * UA_FALLBACK.length)];
}

// UA аккаунта: читаем сохранённый, иначе выбираем и запоминаем.
function accountUserAgent(label, dir = UA_DIR) {
  const file = path.join(dir, `${String(label || 'default')}.json`);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved.ua === 'string' && saved.ua) return saved.ua;
  } catch { /* первого запуска ещё не было */ }

  const ua = freshUserAgent();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ua, at: new Date().toISOString() }), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* не записали — на следующем запуске выберется заново, это не повод падать */ }
  return ua;
}

// Client hints ИЗ ТОЙ ЖЕ строки UA.
//
// 🔴 Опция `userAgent` у Playwright меняет только `navigator.userAgent`, а
// `navigator.userAgentData.brands` остаётся ПУСТЫМ — замер 12.09: при UA `Chrome/152`
// массив `[]`. Пустые brands у «хрома» — готовый детект. Синхронизирует их только
// `Network.setUserAgentOverride` с `userAgentMetadata` (проверено на живой https-странице).
function uaMetadata(ua) {
  const version = String((/Chrome\/(\d+)/.exec(ua) || [])[1] || '152');
  const full = (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || `${version}.0.0.0`;
  const platform = /Windows/.test(ua) ? 'Windows'
    : /Macintosh/.test(ua) ? 'macOS'
    : /X11|Linux/.test(ua) ? 'Linux' : 'Windows';
  return {
    brands: [
      { brand: 'Chromium', version },
      { brand: 'Google Chrome', version },
      { brand: 'Not_A Brand', version: '24' },
    ],
    fullVersion: full,
    platform,
    platformVersion: platform === 'Windows' ? '15.0.0' : platform === 'macOS' ? '14.0.0' : '6.0.0',
    architecture: 'x86',
    model: '',
    mobile: false,
  };
}

async function applyUserAgentOverride(context, page, ua) {
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: ua,
      acceptLanguage: 'en-US,en;q=0.9',
      platform: /Macintosh/.test(ua) ? 'MacIntel' : /X11|Linux/.test(ua) ? 'Linux x86_64' : 'Win32',
      userAgentMetadata: uaMetadata(ua),
    });
  } catch (e) {
    console.log(`⚠️  client hints не синхронизированы: ${e.message}`);
  }
}

// ───── Предпроверка входа: обе причины, которые видно ДО гашения сессии ──
//
// Подарок = разлогин + вход. Гашение сессии идёт первым, а «смогу ли войти обратно»
// выясняется уже после него — и тогда любой отказ (мёртвая GitHub-сессия, молчащий
// край, пропавшая кнопка, отказ OAuth) оставляет аккаунт РАЗЛОГИНЕННЫМ. Цена провала —
// доступ к остатку (до $175 на аккаунте) и выпадение из пула до следующего удачного
// прогона, то есть до того самого механизма, который его и снёс.
//
// Две причины из четырёх стоят ноль и проверяются заранее:
//   • `user_session` GitHub лежит в профиле локально — сеть не нужна;
//   • `/api/status` — ПУБЛИЧНАЯ ручка, отвечает и без сессии.
//
// 🪤 Только `/api/status`. Через `/api/oauth/state` предпроверку вести нельзя: этот
// роут сам ставит куку `session` (в ней сервер держит state OAuth) и до разлогина
// подменил бы живую сессию аккаунта заглушкой — та же ловушка, что описана у
// waitForSiteSession. Гасить сессию своим же пробником было бы худшим видом отказа.
async function preflightEdge(page) {
  try {
    const r = await page.evaluate(async () => {
      const resp = await fetch('/api/status', { credentials: 'include' });
      const body = await resp.text();
      let json = null;
      try { json = JSON.parse(body); } catch { /* пусто или HTML-челлендж WAF */ }
      return {
        status: resp.status,
        len: body.length,
        clientId: !!(json && json.data && json.data.github_client_id),
      };
    });
    if (r && r.clientId) return { ok: true };
    return {
      ok: false,
      detail: r
        ? `/api/status → HTTP ${r.status}, тело ${r.len} Б, github_client_id нет`
        : 'страница не вернула ответ',
    };
  } catch (e) {
    // Обрыв запроса из страницы — тоже отказ края: до вёрстки дело не дошло.
    return { ok: false, detail: e.message };
  }
}

// Живость GitHub-сессии профиля. Ничего не гасит и ходит на github.com только за
// куками, без сырых запросов (фейковый UA GitHub считает угоном — так уже потеряли три
// сессии). Своей копии нет — пробуем общий снимок: та же цепочка, что и после
// разлогина, просто раньше и до того, как аккаунт что-то потерял.
async function ensureGithubSession(context, why) {
  const alive = async () => (await context.cookies('https://github.com').catch(() => []))
    .some(c => c.name === 'user_session' && c.value);
  if (await alive()) return { ok: true, seeded: null };
  const seeded = await seedFromSharedSnapshot(context, why);
  if (await alive()) return { ok: true, seeded };
  return { ok: false, seeded };
}

async function main() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();
  const imported = loadImportedSession();
  // 'auto' на чистом профиле - это та же регистрация (см. `wantRegister` ниже: там `fresh`
  // и решает), то есть человеку нужно окно. Решение принимается ЗДЕСЬ, а не в константе
  // выше: чистота профиля известна только на этом шаге.
  if (mode === 'auto' && fresh) silentWindow = true;

  // 🪤 Строка обязана называть РЕЖИМ, а не затвердеть: пока она говорила «видимый режим»
  // всегда, по логу нельзя было понять, идёт прогон с окном или без - а это первое, что
  // проверяешь, когда владелец жалуется на фокус.
  console.log(silentWindow
    ? '🚀 Запускаю Chromium (без окна — тихий режим очереди)…'
    : '🚀 Запускаю Chromium (видимый режим)…');
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен GitHub-логин)' : 'уже есть (сохранённый)'}`);

  // Browser relogin is always direct. Proxy fallback is confined to the parent process's
  // post-browser HTTP balance check.

  // launchPersistentContext держит профиль открытым и пишет на диск всё сам.
  // Отпечаток аккаунта: липкий UA, выбранный один раз и сохранённый на диск.
  const ua = accountUserAgent(label);
  const uaVer = (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || '?';
  const uaPlat = /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : 'Linux';
  console.log(`🖥️  отпечаток: Chrome ${uaVer} на ${uaPlat}`);

  // Прокси больше НЕ «аварийный ретрай»: адрес приходит на весь прогон и приходит из пула.
  // Прямого пути у agentrouter.org нет - нет адреса, значит прогон не начинается вовсе
  // (родитель просто не спавнит окно), а не «пойдём как-нибудь с нодового IP».
  const context = await chromium.launchPersistentContext(profileDir, {
    // 🔴 Тихий режим = ОКНА НЕТ. Сворачивание через CDP окно создаёт и Windows успевает его
    // активировать: замер 21.09 во время прогона активным было окно «Agent Router - Google
    // Chrome», то есть фокус забирался всё равно. Автоматические прогоны идут headless,
    // ручные (🎁 чек-ин и обход ЛК) остаются видимыми - там в окне сидит человек.
    headless: silentWindow,
    viewport: null,
    // Разрешаем расширения в окне (друг ставит своё прокси-расширение): снимаем
    // дефолтный --disable-extensions Playwright и берём системный Chrome —
    // Chrome Web Store ставит расширения только в него, не в комплектный Chromium.
    channel: 'chrome',
    ignoreDefaultArgs: ['--disable-extensions'],
    userAgent: ua,
    proxy: proxySeed || undefined,
    args: [
      '--window-size=600,1000',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  // Счётчик запросов к ручке логина навешивается ПОСЛЕ разлогина (см. watchLoginRequests):
  // до него эта ручка не дёргается вовсе, а проба края её специально не трогает - запрос
  // state подменил бы живую сессию аккаунта. Объявление здесь, навешивание - там.
  let loginHit = { n: 0 };

  // 🔴 Маркер печатается на ЛЮБОМ выходе, а не только на успешном. Иначе упавший прогон
  // не сообщает, сколько запросов он всё-таки сделал, и родитель списывает со своего адреса
  // значение по умолчанию - счёт раздувается, кольцо ротации сбивается, и адрес выгорает
  // раньше остальных (живой случай 20.09: финская взяла втрое больше).
  let markerSent = false;
  const emitMarker = (checkedIn, message) => {
    if (markerSent) return;
    markerSent = true;
    console.log(`AUTOCHECKIN_RESULT ${JSON.stringify({
      checkedIn, message, loginRequests: loginHit.n,
    })}`);
  };
  process.on('exit', () => emitMarker(null, 'прогон завершился без вердикта'));


  const page = context.pages()[0] || await context.newPage();

  // 🔴 Без этого оверрайда `navigator.userAgentData.brands` остаётся ПУСТЫМ при подменённом
  // UA (замер 12.09) — пустые brands у «хрома» сами по себе детект. Метаданные выводим из
  // той же строки, чтобы версия в UA и в brands совпадала.
  // Apply the same override to every target. `userAgent` changes the popup's string, but
  // CDP userAgentMetadata is target-scoped; without this GitHub sees empty brands.
  context.on('page', p => { applyUserAgentOverride(context, p, ua); });
  await applyUserAgentOverride(context, page, ua);
  // 🔴 Окно очереди НЕ лезет вперёд. Владелец 19.09: «заебало они забирают фокус» — окна
  // ⚡ всплывали поверх работы. `bringToFront` поднимает лишь вкладку, а окно ОС наверх
  // выносит WinAPI (`raiseBrowserWindow`), и раньше это делалось ВСЕГДА.
  // 🎁 Ручной чек-ин и обход ЛК - другое дело: там в окне сидит человек, и поднять его
  // наверх обязательно. Тихий режим - только у автоматических режимов.
  if (!silentWindow) {
    await page.bringToFront();
    raiseBrowserWindow(); // bringToFront поднимает только вкладку — окно ОС наверх выносит WinAPI
  }
  // 🎯 Тихие прогоны идут headless (см. `headless: silentWindow` выше): окна нет вовсе,
  // сворачивать нечего, и фокус у владельца не забирается ни на мгновение.
  await disableHttpCache(context, page);

  // Чек-ин идёт раньше всего остального: импортированные куки и рефка тут не при чём,
  // задача ровно одна — разлогинить и войти заново. `autocheckin` отличается тем, что
  // вход жмёт скрипт, а не человек.
  if (mode === 'checkin' || mode === 'autocheckin') {
    const auto = mode === 'autocheckin';
    // Подписку на ответ колбэка вешаем ДО клика и на КОНТЕКСТ, а не на страницу:
    // колбэк уедет в попап, которого сейчас ещё нет.
    const oauth = watchOauthResult(context);
    // Browser only relogs and harvests cookies; balance is checked after exit by the parent.
    try {
      console.log(auto
        ? '⚡ Автоподарок: гашу сессию и вхожу через GitHub сам.'
        : '🎁 Чек-ин +$25: гашу сессию и открываю вход.');
      if (RUN_LOG) console.log(`📝 полный след прогона: ${RUN_LOG}`);

      // 🔴 Предпроверка ДО выхода. Отказ здесь стоит один прогон; отказ ПОСЛЕ — сессию
      // аккаунта, а вернуть её может только такой же прогон (петля). Навигация нужна,
      // чтобы относительный fetch в пробе шёл с нашего origin: вкладка после старта
      // контекста может стоять на about:blank, и проба ответила бы «край молчит» ложно.
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const edge = await preflightEdge(page);
      if (!edge.ok) {
        console.error(`🛑 Прогон НЕ начат, сессия аккаунта цела: край не отвечает (${edge.detail}).`);
        console.error('   Это рейт-лимит или WAF по IP, а не сломанная вёрстка. Гасить сессию');
        console.error('   вслепую нельзя: не сумев войти, аккаунт остался бы разлогиненным.');
        await context.close().catch(() => {});
        process.exit(8);
      }
      if (auto) {
        const ghPre = await ensureGithubSession(context, 'предпроверка входа');
        if (!ghPre.ok) {
          console.error(`🛑 Прогон НЕ начат, сессия аккаунта цела: GitHub-сессия ${ghNameForError(ghPre.seeded)} мертва.`);
          console.error('   Пароль и 2FA автоматика не вводит — возьми 🐙 «готовый GitHub» заново.');
          await context.close().catch(() => {});
          process.exit(9);
        }
      }

      await doCheckinLogout(context, page);
      loginHit = watchLoginRequests(context);   // считаем только вход, а не пробу края

      if (auto) {
        // Страховка на случай, если сессия отвалилась ПОСЛЕ выхода (GitHub умеет гасить
        // её сам, если тем же аккаунтом вошли в другом месте). Основная проверка уже
        // прошла до разлогина — сюда попадаем только с тем, что изменилось по дороге.
        const gh = await ensureGithubSession(context, 'в профиле нет user_session');
        if (!gh.ok) {
          console.error(`❌ GitHub-сессия ${ghNameForError(gh.seeded)} мертва (нет user_session).`);
          console.error('   Пароль и 2FA автоматика не вводит: возьми 🐙 «готовый GitHub» заново или войди руками кнопкой 🎁.');
          await context.close().catch(() => {});
          process.exit(3);
        }

        const target = await clickGithubLogin(context, page);
        if (!target) {
          // 🪤 Диагноза здесь ДВА, и лечатся они противоположно. Молчащий край — это
          // рейт-лимит/WAF по нашему IP, лечится паузой; переделанный вход — руками и
          // глазами. Раньше на оба случая печаталось «шлюз переделал страницу входа»,
          // и владельца отправляли изучать вёрстку, которой никто не касался
          // (замер 10.09: /api/status вернула пустое тело — это ответ ПУБЛИЧНОГО роута,
          // он не зависит ни от сессии, ни от разметки).
          const edgeSilent = loginStart.why === 'edge-silent' || loginStart.why === 'error';
          if (edgeSilent) {
            console.error(`❌ Край не ответил: ${loginStart.detail || 'публичная /api/status вернула пусто'}.`);
            console.error('   Это рейт-лимит или WAF по IP, а не изменённая вёрстка: страница входа тут ни при чём.');
            console.error('   Подожди несколько минут и повтори ⚡ — или добери бонус кнопкой 🎁.');
            await context.close().catch(() => {});
            process.exit(6);
          }
          console.error(`❌ Начать GitHub-вход нечем: ${loginStart.detail || 'кнопки нет, authorize-URL не собрался'}.`);
          console.error(`   Край при этом ОТВЕЧАЕТ${loginStart.hadButton ? ', и кнопка на странице есть' : ', но кнопки GitHub на странице нет'}`
            + ' — похоже, шлюз переделал вход.');
          console.error('   Добери бонус кнопкой 🎁 — там вход жмёт человек.');
          await context.close().catch(() => {});
          process.exit(4);
        }

        let gate = await passGithubGate(target);
        if (gate === 'dead') {
          // Кука в профиле была, но GitHub её уже не принял. Ровно ОДНА повторная попытка
          // с общим снимком: он мог обновиться после того, как профиль в последний раз
          // логинился. Больше одной — цикл, поэтому попытка помечается и не повторяется.
          const seeded = await seedFromSharedSnapshot(context, 'GitHub попросил пароль/2FA');
          if (seeded && seeded.ok) {
            console.log('🔁 повторяю вход после подъёма сессии из общего снимка');
            const again = await clickGithubLogin(context, page);
            gate = again ? await passGithubGate(again) : 'dead';
          }
          if (gate === 'dead') {
            console.error(`❌ GitHub попросил пароль/2FA — сессия ${ghNameForError(seeded)} уже не годится.`);
            console.error('   Возьми 🐙 «готовый GitHub» заново или войди руками кнопкой 🎁.');
            await context.close().catch(() => {});
            process.exit(3);
          }
        }
        console.log(`🔄 GitHub-часть: ${gate}`);

        const res = await waitForSiteSession(context, page, AUTO_LOGIN_TIMEOUT_MS, oauth, 2000);
        if (!res.ok && res.rejected) {
          console.error(`❌ Шлюз отверг OAuth: ${res.message || 'без причины'}. Бонус не забран.`);
          await context.close().catch(() => {});
          process.exit(5);
        }
        if (!res.ok) {
          console.error('❌ Вход не подтвердился за 90 с. Бонус не забран — попробуй ещё раз или добери кнопкой 🎁.');
          await context.close().catch(() => {});
          process.exit(2);
        }

        // Попап больше не нужен, а на его URL лежит одноразовый code — трогать его
        // навигацией нельзя, только закрыть.
        if (target !== page && !target.isClosed()) await target.close().catch(() => {});
        await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      } else {
        console.log('   Жми «Continue with GitHub» — GitHub-сессия в профиле осталась, пароль и 2FA не нужны.');

        // Ждём, пока пользователь войдёт обратно. Дальше — САМИ закрываем браузер, и это
        // не косметика: Chromium пишет НОВЫЕ куки в SQLite профиля лениво, а точный баланс
        // читается именно с диска (см. newapi-account.js). Пока окно открыто, свежей куки
        // на диске нет — и чек честно откатывался на прикидку с «в профиле нет куки».
        // Корректное закрытие гарантирует флаш, поэтому после входа окно больше не нужно:
        // за ним пришли ровно за одним кликом.
        // Ждём по куке контекста, а не по URL этой вкладки: сайт уводит GitHub-вход в
        // попап, и вкладка так и остаётся на /login — проверка по URL давала бы ложный
        // таймаут «не дождался входа» при фактически забранном бонусе.
        const res = await waitForSiteSession(context, page, LOGIN_TIMEOUT_MS, oauth);
        if (!res.ok) {
          console.error('❌ Не дождался входа (10 мин). Закрываю — бонус не забран, зайди ещё раз.');
          await context.close().catch(() => {});
          process.exit(2);
        }
      }
      await settleAfterCheckin(page);
      await backupGhAfterLogin(context);
      await harvestCookiesToJar(context);
      console.log('✅ Вход выполнен. Закрываю браузер, чтобы куки легли на диск —');
      console.log('   без этого следующий чек баланса не найдёт в профиле живой сессии.');
      await context.close().catch(() => {});
      // The marker reports only the gateway's check-in verdict. The parent obtains the
      // authoritative balance through cookie/raw-auth after this process exits.
      emitMarker(auto && oauth && oauth.seen ? !!oauth.checkedIn : null, (auto && oauth && oauth.message) || '');
      console.log('🎁 Готово. Куки сохранены; дашборд сейчас проверит точный баланс обычным HTTP-путём.');
      process.exit(0);
    } catch (e) {
      await context.close().catch(() => {});
      throw e;
    }
  }

  // Импортированная чужая сессия: подкладываем cookies/localStorage до навигации.
  let appliedSession = false;
  if (fresh && imported) {
    appliedSession = await applyImportedSession(context, imported);
  }

  // Заселение готового GitHub — аккаунта у провайдера ещё нет, рефка НУЖНА.
  const seededGithub = appliedSession && imported && imported.seed === 'github';
  if (seededGithub) {
    console.log(`🐙 GitHub-сессия заселена${imported.ghLogin ? ` (${imported.ghLogin})` : ''} — пароль и 2FA не понадобятся, жми «Continue with GitHub».`);
  }

  // Импортированный share-код — аккаунт друга уже зарегистрирован, рефка ему не нужна.
  const wantRegister = (appliedSession && !seededGithub) ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;                                   // 'auto': чистый профиль = регистрация
  console.log(`🎯 ${wantRegister ? `регистрация по рефке: ${REGISTER_URL}` : `баланс: ${CONSOLE_URL}`}`);
  if (RUN_LOG) console.log(`полный след прогона: ${RUN_LOG}`);

  try {
    if (appliedSession && !seededGithub) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await reportRender(page);
      console.log('✅ Импортированная сессия применена (GitHub/agentrouter уже залогинены).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context);
      return;
    }

    // Регистрация: ждём логина и добиваем «failed to get user information» ВСЕГДА,
    // а не только на чистом профиле. Первая попытка могла упасть именно так —
    // тогда профиль уже не чистый, а аккаунт всё ещё без ключа.
    if (wantRegister) {
      await openRegisterViaRef(page);
      console.log('⚠️  Регистрация по рефке. Зарегайся через GitHub на открывшейся странице,');
      console.log('   потом возьми ключ в консоли и вставь его кнопкой 🔑 в дашборде.');

      const ok = await waitForLogin(page, context);
      if (!ok) {
        console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
        process.exit(2);
      }
      const settled = await settleAfterLogin(page);
      await backupGhAfterLogin(context);
      await harvestCookiesToJar(context);
      console.log(settled
        ? '✅ Вход выполнен, профиль сохранён на диск. Забирай ключ и вставляй кнопкой 🔑.'
        : '⚠️  Вход прошёл, но сайт всё ещё отдаёт «failed to get user information» — обнови страницу вручную (F5).');
      console.log('   Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context);
      return;
    }

    // Вход, а не регистрация. Но у СВЕЖЕГО/заселённого профиля аккаунта у провайдера
    // может ещё не быть — тогда сайт создаст его прямо на GitHub-входе, и БЕЗ реф-кода.
    // Ровно так у друга ушёл наш реф-кредит на tabitoken (2026-08-21): кнопка «вход»
    // повела на кошелёк, сайт зарегистрировал с нуля, `aff` в localStorage не было.
    // Поэтому сначала сажаем реф-код (он живёт в localStorage и переживает переходы),
    // и только потом идём на кошелёк: аккаунт есть — код просто не пригодится, аккаунта
    // нет — регистрация зачтётся по рефке. Если сайт сам увёл на GitHub-вход,
    // CONSOLE_URL не перебиваем: это порвало бы OAuth-state.
    // Условие не «свежий профиль», а «сессии ЛК нет». Разница поймана в тот же день:
    // у записи без ключа профиль после первого неудачного захода уже НЕ свежий, а
    // аккаунта у провайдера по-прежнему нет — второй клик снова уводил на кошелёк без
    // реф-кода, и рефка терялась ровно так же. Живому аккаунту (кука ЛК на месте) лишний
    // заход по реф-ссылке не делаем.
    const siteCookies = await context.cookies().catch(() => []);
    let loggedInEarly = false;
    if (fresh || !hasSessionCookie(siteCookies)) {
      await openRegisterViaRef(page);
      if (/github\.com/i.test(page.url())) {
        console.log('↪️  сайт сам ушёл на GitHub-вход — жди входа, реф-код уже в профиле');
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
      await backupGhAfterLogin(context);
      await harvestCookiesToJar(context);
      console.log('✅ Профиль восстановлен (agentrouter уже залогинен, если заходил раньше).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context); // держим открытым, закрытие — вручную
      return;
    }

    if (!loggedInEarly) console.log('⚠️  Первый вход. Залогинься через GitHub в открывшемся браузере.');
    console.log('   Профиль сохранится автоматически.');

    const ok = await waitForLogin(page, context);
    if (!ok) {
      console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
      process.exit(2);
    }

    await backupGhAfterLogin(context);
    console.log('✅ Вход выполнен, профиль сохранён на диск. Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
    await ghCapture.holdOpen(context);
  } finally {
    await context.close().catch(() => {});
  }
}

// Запуск только как скрипт. Регресс подключает файл как модуль ради чистых функций
// разбора прокси — без этой охраны `require` поднимал бы браузер и создавал профиль.
if (require.main === module) {
  main().catch(err => {
    console.error('❌ Ошибка:', err.message);
    process.exit(1);
  });
}

// `takeProxySeed` экспортируется ради регресса: он гоняет НАСТОЯЩИЙ круг «родитель записал -
// ребёнок прочитал». Статическая сверка по обе стороны такой баг не ловит: 20.09 родитель писал
// плоский `{server,…}`, ребёнок читал `doc.proxy`, оба куска выглядели на месте - а браузер
// молча шёл напрямую.
module.exports = { accountUserAgent, uaMetadata, UA_DIR, takeProxySeed };
