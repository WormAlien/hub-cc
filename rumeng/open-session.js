// rumeng/open-session.js
//
// Открывает видимый Chromium с персональным профилем аккаунта 如梦AI (rumeng).
// Профиль сохраняет историю, cookies, localStorage и сессию панели на диск.
//
// Использование:
//   node rumeng/open-session.js <label> [register|console|auto]
//     label — имя профиля (папка rumeng/profiles/<label>/)
//     mode — register: форма регистрации,
//            console: личный кабинет,
//            auto (по умолчанию): чистый профиль = register, иначе console.
//
// Email и пароль берутся только из RM_LK_EMAIL и RM_LK_PASS. В argv они не передаются.
// Окно остаётся открытым до закрытия пользователем.
//
// ─────────────────────────── чем эта вкладка НЕ как AIKeysAPI ───────────────────────────
//
// Структурно это копия aikeysapi/open-session.js, но панель другая, и четыре отличия
// принципиальны — на них держится весь вход.
//
//   1. 🔴 СЕССИЯ НЕ В КУКЕ. `api.rumeng-ai.com` — это sub2api (Go + Vue), он держит JWT
//      в **localStorage**. Проверка «мы внутри» по куке ЛК, как у New API, здесь не
//      сработает НИКОГДА: куки сессии панель не ставит вообще. Поэтому и снимок для 🌐 —
//      это не «кука + user», а связка ключей localStorage. Cookie-путь из образца тут
//      просто нечего наполнять.
//
//   2. 🔴 КЛЮЧ НАЗЫВАЕТСЯ `auth_token`, А НЕ `access_token`. Это главная ловушка файла, и
//      она стоит отдельного абзаца. По проводу ручки `/auth/login`, `/auth/register` и
//      `/auth/refresh` отдают поле `access_token` — но SPA кладёт его в localStorage под
//      именем `auth_token` (`function me(e){localStorage.setItem("auth_token",e)}` в
//      бандле) и оттуда же читает в перехватчике запросов. Снимок с ключом `access_token`
//      формально «есть», выглядит правильным — и открывает ФОРМУ ВХОДА, потому что SPA
//      такого ключа не знает. Имена ключей сверены с живым бандлом 13.09, не угаданы.
//      Полный набор, который пишет сам сайт при входе:
//         auth_token | refresh_token | token_expires_at | auth_user
//
//   3. 🪤 МОДАЛКА УСЛОВИЙ ПЕРЕГОРАЖИВАЕТ ВХОД. Поверх формы висит 条款更新通知 с кнопкой
//      `同意并继续`, и пока она не нажата, поля email/password стоят `disabled`. Наивный
//      скрипт падает с `element is not enabled`, и это выглядит как сломанный селектор.
//      Согласие живёт в localStorage под `sub2api_login_agreement_consent`, а его ревизию
//      сервер отдаёт в `/settings/public` → `login_agreement_revision`. Ревизия МЕНЯЕТСЯ,
//      поэтому она не захардкожена: берём живую и сверяем перед каждым входом.
//
//   4. 🪤 ЛОКАЛИЗАЦИЯ ПО ЯЗЫКУ БРАУЗЕРА ЛОМАЕТ СЕЛЕКТОРЫ ПО ТЕКСТУ. В пробе без явной
//      локали кнопки оказались английскими (`Accept and continue` вместо `同意并继续`), и
//      все селекторы на китайском тексте сломались МОЛЧА. Поэтому здесь и явный
//      `locale: 'zh-CN'`, и поиск кнопки сразу по обоим языкам.

const { chromium } = require('playwright');
const { raiseBrowserWindow } = require('../routing/lib/focus-window.js');
const fs = require('fs');
const path = require('path');

const HOST = 'api.rumeng-ai.com';
const ROOT_URL = `https://${HOST}/`;
const ORIGIN = `https://${HOST}`;
const REGISTER_URL = `${ORIGIN}/register`;
const LOGIN_URL = `${ORIGIN}/login`;
// Личный кабинет — то, что владелец ждёт увидеть по кнопке 🌐. Ключи лежат на /keys,
// но кнопка называется «открыть ЛК», а не «открыть ключи».
const CONSOLE_URL = `${ORIGIN}/dashboard`;
const SETTINGS_URL = `${ORIGIN}/api/v1/settings/public`;

const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const POOL_FILE = path.join(__dirname, '..', 'routing', 'rumeng-sessions.json');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

// ─────────────────── User-Agent: часть учётных данных, а не украшение ───────────────────
//
// 🔴 Панель держит сессию за заголовком `User-Agent` — вплоть до версии браузера.
// Замер 13.09 на живом аккаунте `userId=204`, ОДИН И ТОТ ЖЕ `auth_token`, менялся только UA:
//
//     200  UA из поля `userAgent` записи пула
//     401  тот же UA, но версия 139 → 140           SESSION_BINDING_MISMATCH
//     401  дефолтный UA Chromium / без заголовка
//     200  UA записи + `Accept-Language` / `sec-ch-ua`   ← не влияют вовсе
//
// 🪤 Симптом обманчив, и владелец описал его дословно: «крутится туда-сюда и не заходит
// в аккаунт». Токен в localStorage на месте, кабинет РИСУЕТСЯ и держится ~16 секунд —
// а потом перехватчик ловит 401 на `/auth/me` и уводит на `/login`. Снаружи это «панель
// не пускает», хотя токен живой и панель его принимает: просто не от ЭТОГО окна.
//
// Запись ищем по метке профиля: `routing/transparent-proxy.js` спавнит нас как
// `acct_<id записи>` (`handleRmSessionOpen`), то есть id — это метка без префикса.
// Механизм ровно тот же, что `recordUA` в `refresh-sessions.js`: второй не заводим.
function resolvePoolRecord() {
  try {
    const arr = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    const id = label.replace(/^acct_/, '');
    return Array.isArray(arr) ? (arr.find(r => r && r.id === id) || null) : null;
  } catch { return null; }
}
const poolRecord = resolvePoolRecord();
const recordUA = (poolRecord && typeof poolRecord.userAgent === 'string' && poolRecord.userAgent.trim())
  ? poolRecord.userAgent.trim()
  : null;

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

// Ключ согласия с условиями и ключи входа — ровно те имена, что пишет сам сайт.
const CONSENT_KEY = 'sub2api_login_agreement_consent';
const TOKEN_KEY = 'auth_token';
const AUTH_KEYS = [TOKEN_KEY, 'refresh_token', 'token_expires_at', 'auth_user'];

// Окно живёт до Ctrl+C: обещание резолвится только при закрытии контекста.
function holdOpen(context) {
  return new Promise((resolve) => { context.on('close', resolve); });
}

// ───────────────────────────── снимок сессии ─────────────────────────────

// Импортированный share-снимок содержит JWT уже созданного аккаунта.
// 🪤 У rumeng нет ни GitHub-, ни Google-входа (`github_oauth_enabled`/`google_oauth_enabled`
// = false в /settings/public), поэтому seed-снимки чужих OAuth-сессий здесь бессмысленны и
// отбрасываются — применить их всё равно некуда.
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

// В снимке есть JWT? Снимок без `auth_token` открывает форму входа, сколько его ни применяй.
function sessionHasJwt(session) {
  if (!session) return false;
  return (session.origins || []).some(o =>
    (o.localStorage || []).some(e => e.name === TOKEN_KEY && e.value));
}

// 🪤 localStorage сеем «только если ключа НЕТ», а не безусловно.
//
// Причина не косметическая: `addInitScript` срабатывает на КАЖДОЙ навигации, а SPA сама
// обновляет JWT через `/auth/refresh` и переписывает `auth_token`. Безусловная запись
// вернула бы на следующем переходе СТАРЫЙ токен поверх свежего — это 401, вылет на
// `/login` и «кнопка снова открывает логин» ровно там, где всё только что работало.
// Пустой localStorage (первое открытие профиля) под условие подходит, так что вход
// восстанавливается как надо, а живую сессию мы не топчем.
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
        (entries) => {
          for (const { name, value } of entries) {
            try { if (localStorage.getItem(name) === null) localStorage.setItem(name, value); } catch {}
          }
        },
        o.localStorage.map(({ name, value }) => ({ name, value })),
      );
      applied = true;
    } catch { /* origin может быть невалидным — пропускаем */ }
  }
  return applied;
}

function isFreshProfile() {
  try {
    const prefs = path.join(profileDir, 'Default', 'Preferences');
    return !fs.existsSync(prefs);
  } catch { return true; }
}

// ───────────────────────────── состояние страницы ─────────────────────────────

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

// Точка монтирования у Vite-сборки — `#app`, но проверяем и `#root`: сборка чужая и
// может переехать, а белый экран должен диагностироваться, а не списываться на «наверное ок».
async function reportRender(page) {
  const ok = await page.waitForFunction(
    () => {
      const r = document.querySelector('#app') || document.querySelector('#root');
      return !!r && r.innerHTML.length > 200;
    },
    { timeout: 15000 },
  ).then(() => true).catch(() => false);
  console.log(ok
    ? '✅ страница отрисовалась'
    : '⚠️  белый экран: SPA не поднялась — жми F5, в DevTools ищи 404 на /assets/*.js');
}

// Панель — SPA, и «я вошёл» она держит в localStorage, а не в адресе страницы: при
// протухшем токене перехватчик сам уводит на `/login`. Судить по `page.url()` нельзя —
// смотрим на саму форму.
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

// «Мы внутри» = в localStorage панели лежит `auth_token`. Дешёвая проверка: наличие ключа.
async function panelLoggedIn(page) {
  try {
    return await page.evaluate((k) => {
      try { return !!localStorage.getItem(k); } catch { return false; }
    }, TOKEN_KEY);
  } catch { return false; }
}

async function readToken(page) {
  try {
    return await page.evaluate((k) => {
      try { return localStorage.getItem(k); } catch { return null; }
    }, TOKEN_KEY);
  } catch { return null; }
}

// 🔴 НАЛИЧИЕ КЛЮЧА — НЕ ДОКАЗАТЕЛЬСТВО ВХОДА, и это измерено, а не предположено.
//
// Замер 13.09 (headless, заведомо мёртвый токен в снимке): `auth_token` лежит на месте,
// формы входа нет, URL остаётся `/dashboard` — и так ЦЕЛЫХ ~16 СЕКУНД. Лишь потом
// перехватчик получает 401, чистит ключи и уводит на `/login`.
//
// Значит проверка «ключ есть → залогинен» отвечает ДА на мёртвой сессии: скрипт
// напечатал бы «✅ уже залогинен», а владелец через несколько секунд увидел бы логин —
// ровно та ложь, на которую он ругался. Спрашиваем саму панель: `/auth/me` отвечает
// мгновенно и однозначно.
// 🔴 `User-Agent` здесь ОБЯЗАТЕЛЕН, ровно как в окне.
//
// Этот запрос идёт из Node, а не из браузера, и своего UA не имеет вовсе — панель видит
// «чужой отпечаток» и отвечает `401 SESSION_BINDING_MISMATCH` на ПОЛНОСТЬЮ ЖИВОМ токене.
// Замер 13.09: `…/auth/me` с родным UA → 200, без заголовка UA → 401.
//
// 🪤 Чем это было опасно: самопроверка объявляла живую сессию мёртвой (`why: 'dead_token'`),
// скрипт печатал «токен ПРОТУХ» и уводил владельца входить заново — при том, что вход
// был исправен. Отдельная копия той же грабли, что и в окне, но с другой стороны.
async function tokenAlive(token) {
  if (!token) return false;
  try {
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    if (recordUA) headers['User-Agent'] = recordUA;
    const r = await fetch(`${ORIGIN}/api/v1/auth/me`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    return r.status === 200;
  } catch { return false; }
}

// Полная проверка входа: ключ на месте И панель его принимает.
// Сеть недоступна — не объявляем сессию мёртвой по ошибке связи: ключ есть, значит
// показываем кабинет и даём владельцу решить самому.
async function verifyLoggedIn(page) {
  const token = await readToken(page);
  if (!token) return { ok: false, why: 'no_token' };
  if (await tokenAlive(token)) return { ok: true };
  // Второй шанс: SPA могла прямо сейчас продлить токен через `/auth/refresh`.
  await page.waitForTimeout(2500);
  const again = await readToken(page);
  if (again && again !== token && await tokenAlive(again)) return { ok: true };
  return { ok: false, why: 'dead_token' };
}

// ───────────────────────────── модалка условий ─────────────────────────────

// Клик по кнопке с точным ВИДИМЫМ текстом.
//
// 🔴 Локаторы Playwright с якорями (`hasText: /^ТЕКСТ$/`) тут не годятся: внутри кнопок
// лежат иконки, `textContent` содержит разметку и пробелы, и якорь не совпадает — хотя
// `innerText` ровно такой. Приём взят из freemodel/lib/emailnator.js, где он уже оплачен
// двумя потерянными прогонами: ищем перебором по нормализованному `innerText`, кликаем
// настоящим кликом Playwright по индексу.
async function clickExactButton(page, texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  for (const t of list) {
    const idx = await page.evaluate((want) => {
      const all = [...document.querySelectorAll('button')];
      return all.findIndex(x => (x.innerText || '').replace(/\s+/g, ' ').trim() === want);
    }, t).catch(() => -1);
    if (idx >= 0) {
      await page.locator('button').nth(idx).click({ timeout: 8000 }).catch(() => {});
      return t;
    }
  }
  return null;
}

// Живая ревизия соглашения + публичные настройки панели.
// Это факты сервера, а не догадки: тот же ответ читает и сама SPA.
async function fetchPublicSettings() {
  try {
    const r = await fetch(SETTINGS_URL, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json' },
    });
    if (r.status !== 200) return { ok: false, error: `settings/public HTTP ${r.status}` };
    const body = await r.json();
    const d = (body && body.data) || body || {};
    // Тот же фолбэк ревизии, что и в бандле: если сервер её не задал, SPA собирает ключ
    // из даты и списка документов. Повторяем ровно, иначе согласие не совпадёт.
    const docs = Array.isArray(d.login_agreement_documents) ? d.login_agreement_documents : [];
    const revision = d.login_agreement_revision
      || (docs.length ? `${d.login_agreement_updated_at || ''}:${docs.map(x => `${x.id}:${x.title}`).join('|')}` : '');
    return {
      ok: true,
      site: d.site_name || '如梦AI',
      registration: d.registration_enabled !== false,
      turnstile: d.turnstile_enabled === true,
      agreement: d.login_agreement_enabled === true && docs.length > 0,
      agreementMode: d.login_agreement_mode === 'checkbox' ? 'checkbox' : 'modal',
      revision,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Согласие сеем ДО навигации: так модалка не успевает перегородить форму, и поля не
// стоят `disabled` к моменту, когда до них доходит подстановка кредов.
//
// 🪤 Ревизию берём живую, а не из константы: сменится ревизия — старое согласие перестанет
// совпадать, модалка вылезет снова, и «внезапно сломавшийся селектор» будет на самом деле
// сменой условий. Значение переписываем всегда (в отличие от токенов): согласие не
// ротируется сайтом, и свежая ревизия здесь строго полезнее старой.
async function seedAgreementConsent(context, revision) {
  if (!revision) return false;
  try {
    await context.addInitScript(({ key, rev }) => {
      try {
        const cur = localStorage.getItem(key);
        const same = cur && JSON.parse(cur).revision === rev;
        if (!same) localStorage.setItem(key, JSON.stringify({ revision: rev, accepted_at: new Date().toISOString() }));
      } catch {}
    }, { key: CONSENT_KEY, rev: revision });
    return true;
  } catch { return false; }
}

// Подстраховка на случай, если модалка всё-таки показалась: ревизия разъехалась, сеять
// было нечего (settings недоступны) или сайт показал согласие другим путём.
// Кнопки перечислены на обоих языках — локаль может оказаться не той, что мы просили.
async function dismissAgreement(page) {
  const hit = await clickExactButton(page, ['同意并继续', 'Accept and continue', '同意', 'Accept']);
  if (hit) {
    await page.waitForTimeout(1500);
    console.log(`📜 Модалка условий была на экране — нажал «${hit}».`);
  }
  return hit;
}

// ───────────────────────────── восстановление входа ─────────────────────────────

// Само-лечение для 🌐: оказались на форме входа, а снимок есть — применяем его НА МЕСТЕ
// и перезагружаем.
//
// 🪤 Ключи входа сначала ЧИСТИМ. Иначе «сеем только если ключа нет» сработает против нас:
// в localStorage может лежать протухший `auth_token` (именно он нас и выкинул на логин),
// условие увидит его как «ключ есть» и снимок молча не применится. Терять тут нечего —
// раз мы на форме входа, старые ключи заведомо мертвы.
//
// `addInitScript` срабатывает на СЛЕДУЮЩЕЙ навигации, поэтому перезагрузка обязательна,
// а не косметика.
async function trySnapshotRecovery(page, context, shared) {
  if (!shared) return false;
  await page.evaluate((keys) => {
    for (const k of keys) { try { localStorage.removeItem(k); } catch {} }
  }, AUTH_KEYS).catch(() => {});
  await applyImportedSession(context, shared);
  await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(4000);
  await dismissAgreement(page);
  if (await isLoginPage(page)) return false;
  return (await verifyLoggedIn(page)).ok;
}

// ───────────────────────────── вход ─────────────────────────────

const SITE_ERRORS = [
  {
    code: 'no_register',
    terminal: true,
    re: /registration (is )?(disabled|closed)|注册(已)?(关闭|禁用)|管理员关闭了新用户注册|регистрац[а-яё]* (закрыт|отключен)/i,
    msg: '❌ 如梦AI закрыл регистрацию новых аккаунтов (ответ панели) — этот аккаунт создать нельзя.',
  },
  {
    code: 'bad_suffix',
    terminal: false,
    // Живой ответ панели 13.09: вайтлист доменов почты. Ловим, потому что снаружи это
    // выглядит как «форма не отправляется», а причина — адрес, который сервер не примет.
    re: /email suffix is not allowed|EMAIL_SUFFIX_NOT_ALLOWED/i,
    msg: '⚠️  Панель принимает только @qq.com, @gmail.com и *.edu.cn — другой адрес отвергается до регистрации.',
  },
];

async function siteError(page) {
  let text = '';
  try { text = await page.evaluate(() => document.body ? document.body.innerText : ''); } catch { return null; }
  return SITE_ERRORS.find(e => e.re.test(text)) || null;
}

async function openRegister(page) {
  // 🪤 Реф-кода здесь НЕТ и быть не может: `affiliate_enabled: false` в /settings/public.
  // Прогрев корня ради `aff`, как у AIKeysAPI, тут был бы карго-культом — реф-программа
  // у панели просто выключена.
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);
  await dismissAgreement(page);
}

// Ждём, пока в localStorage появится `auth_token`. Куку не ждём вообще — панель её не ставит.
async function waitForLogin(page, context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const seen = new Set();
  while (Date.now() < deadline) {
    if (await panelLoggedIn(page)) return { ok: true };

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

// Кнопку входа не нажимаем: панель может потребовать код из письма или капчу.
// Это только удобная подстановка кредов из окружения, не автоматический логин.
//
// 🪤 Перед подстановкой обязательно снимаем модалку: пока согласие не дано, поля стоят
// `disabled`, и `fill()` падает с `element is not enabled` — ошибка, которая выглядит как
// сломанный селектор и стоила отдельного прогона 13.09.
async function prefillLogin(page) {
  const email = String(process.env.RM_LK_EMAIL || '').trim();
  const pass = String(process.env.RM_LK_PASS || '');
  if (!email && !pass) return false;
  try {
    await dismissAgreement(page);
    const emailSel = '#email, input[name="email"], input[type="email"]';
    const passSel = '#password, input[name="password"], input[type="password"]';
    await page.waitForSelector(passSel, { timeout: 20000 });
    // Ждём, пока поле реально станет доступным: согласие могло примениться только что.
    await page.waitForFunction(
      (sel) => { const el = document.querySelector(sel); return !!el && !el.disabled; },
      '#password, input[type="password"]',
      { timeout: 10000 },
    ).catch(() => {});
    if (email) {
      const e = page.locator(emailSel).first();
      if (await e.count()) await e.fill(email);
    }
    if (pass) {
      const p = page.locator(passSel).first();
      if (await p.count()) await p.fill(pass);
    }
    console.log(`🔐 Логин подставлен из переменных окружения${pass ? ' (email и пароль)' : ' (только email — пароля нет)'}.`);
    console.log('   Кнопку входа нажми сам: панель может спросить код с почты или капчу.');
    return true;
  } catch (e) {
    console.log(`ℹ️  Поле пароля не найдено (${e.message.split('\n')[0]}) — вход руками.`);
    return false;
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();
  const imported = loadImportedSession();
  if (imported && imported.ghSeedOnly) {
    console.log('⚠️  Рядом лежит снимок только GitHub-сессии: у 如梦AI нет GitHub-входа, игнорирую файл.');
  }
  const shared = imported && !imported.ghSeedOnly ? imported : null;

  console.log('🚀 Запускаю Chromium (видимый режим)…');
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен вход почтой)' : 'уже есть (сохранённый)'}`);
  console.log(`🗂️  пул сессий: ${POOL_FILE}`);
  // Говорим вслух, а не ломаем вход молча. Именно молчание превращало это в загадку:
  // окно открывается, токен на месте, а владелец видит форму входа и не понимает, почему.
  if (recordUA) {
    console.log(`🧬 UA аккаунта: ${recordUA}`);
  } else {
    console.log(`⚠️  В пуле нет записи «${label.replace(/^acct_/, '')}» или в ней нет поля userAgent.`);
    console.log('   🪤 Панель держит сессию за UA: без родного отпечатка вход, скорее всего,');
    console.log('      отвалится с SESSION_BINDING_MISMATCH — кабинет отрисуется и выкинет на /login.');
  }
  if (shared && !sessionHasJwt(shared)) {
    console.log(`⚠️  Снимок рядом есть, но в нём НЕТ ${TOKEN_KEY} — он не откроет ЛК.`);
    console.log('   Пересобери: node rumeng/refresh-sessions.js');
  }

  const pre = await fetchPublicSettings();
  if (!pre.ok) {
    console.log(`⚠️  предполётная проверка панели не удалась (${pre.error}) — открываю окно как есть.`);
  } else {
    console.log(`🛰️  ${pre.site}: регистрация ${pre.registration ? 'открыта' : 'ЗАКРЫТА'},`
      + ` капча ${pre.turnstile ? '🔴 ВКЛЮЧЕНА' : 'нет'},`
      + ` соглашение ${pre.agreement ? `есть (${pre.agreementMode}, ревизия ${pre.revision.slice(0, 16)})` : 'нет'}`);
    if (!pre.registration) console.log('   ❌ Новый аккаунт создать нельзя — панель закрыла регистрацию. Окно всё равно открою.');
    // Капча выключена (`turnstile_enabled: false`), но ключ сайта в настройках лежит про
    // запас. Её включение сломает авторегу молча, и признак ровно один — этот флаг.
    if (pre.turnstile) console.log('   🔴 Turnstile включили — авторега на этой панели встанет, вход руками.');
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    // 🔴 Без этого окно идёт дефолтным UA Chromium, а панель держит сессию за UA —
    // вход отваливается на первом же `/auth/me`. Разбор и замер — у `resolvePoolRecord()`.
    ...(recordUA ? { userAgent: recordUA } : {}),
    // 🪤 Локаль явная. Без неё сайт отдаёт английские кнопки, и любой селектор по
    // китайскому тексту ломается МОЛЧА — проверено в пробе 13.09.
    locale: 'zh-CN',
    args: ['--window-size=600,1000', '--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.bringToFront();
  raiseBrowserWindow();
  await disableHttpCache(context, page);

  // Согласие сеем всегда, независимо от снимка: модалка перегораживает и вход, и
  // регистрацию, а её появление не зависит от того, есть ли у нас сессия.
  if (pre.ok && pre.agreement) await seedAgreementConsent(context, pre.revision);

  // Снимок применяем, когда в САМОМ ПРОФИЛЕ нет живой сессии, — а не только когда профиль
  // чистый.
  //
  // 🪤 У образца здесь стояло `fresh && shared`, и на любом уже существующем профиле снимок
  // молча игнорировался: открывалась консоль, скрипт печатал «уже залогинен», ничего не
  // проверив, а владелец видел форму входа при живом снимке рядом. Каталог профиля
  // создаётся первым же открытием окна, так что «не чистый» — обычный случай, а не редкий.
  //
  // Отличие от образца: живость сессии по кукам тут не определить (их нет), а localStorage
  // без страницы не прочитать. Поэтому снимок применяем всегда, когда он есть, — а
  // «только если ключа нет» внутри applyImportedSession не даёт затоптать живой токен.
  const appliedSession = shared ? await applyImportedSession(context, shared) : false;
  const wantRegister = appliedSession ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;
  console.log(`🎯 ${wantRegister ? `регистрация: ${REGISTER_URL}` : `кабинет: ${CONSOLE_URL}`}`);

  try {
    if (appliedSession) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await reportRender(page);
      await dismissAgreement(page);
      const check = await verifyLoggedIn(page);
      if (!check.ok || await isLoginPage(page)) {
        // Честно: снимок применился, но входа в нём не хватило. Молчать здесь нельзя —
        // именно молчание и превращало это в «кнопка 🌐 открывает логин».
        if (check.why === 'dead_token') {
          console.log('⚠️  Токен из снимка ПРОТУХ: ключ на месте, но панель его не принимает.');
          console.log('   🪤 Пару секунд кабинет ещё рисуется — это не вход, сейчас выкинет на /login.');
        }
        if (await trySnapshotRecovery(page, context, shared)) {
          console.log('✅ Снимок применён со второй попытки — 如梦AI уже залогинен.');
        } else {
          console.log('⚠️  Снимок применён, но войти не удалось.');
          console.log(`   Причина, как правило, одна: в снимке нет ключа ${TOKEN_KEY} (или он протух).`);
          console.log('   🪤 Именно ЭТОГО имени: по проводу поле зовётся access_token, а SPA читает auth_token.');
          console.log('   Пересобери снимок: node rumeng/refresh-sessions.js');
          await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await prefillLogin(page);
        }
      } else {
        console.log('✅ Снимок применён — 如梦AI уже залогинен (панель подтвердила токен).');
      }
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    if (wantRegister) {
      await openRegister(page);
      console.log('⚠️  Регистрация. Введи email и пароль, затем введи код с почты на шаге /email-verify.');
      console.log('   🪤 Почта только @qq.com, @gmail.com или *.edu.cn — остальные панель отвергает.');
      await prefillLogin(page);

      const res = await waitForLogin(page, context);
      if (!res.ok) {
        if (res.err && res.err.code === 'no_register') {
          console.error('❌ Регистрация 如梦AI закрыта администратором — новый аккаунт не создать.');
          console.error('   Браузер оставляю открытым: ответ панели видно на странице.');
          await holdOpen(context);
          return;
        }
        console.error('❌ Таймаут ожидания входа (10 мин). Закрываю.');
        process.exit(2);
      }
      await reportRender(page);
      console.log('✅ Вход выполнен, профиль сохранён на диск. Забирай ключ на /keys.');
      console.log('   🪤 При создании ключа группа ОБЯЗАТЕЛЬНА: сначала имя, потом 选择分组, и только затем 创建.');
      console.log('   Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    if (!fresh) {
      await reportRender(page);
      await dismissAgreement(page);
      // 🪤 У образца здесь стояло безусловное «уже залогинен, если заходил раньше» —
      // утверждение, которое никто не проверял. Профиль на диске сам по себе не значит
      // вход: JWT мог истечь, а снимок — не примениться.
      const check = await verifyLoggedIn(page);
      if (!check.ok || await isLoginPage(page)) {
        if (check.why === 'dead_token') console.log('⚠️  Токен в профиле протух — панель его не принимает.');
        if (await trySnapshotRecovery(page, context, shared)) {
          console.log('✅ Снимок из пула применён — 如梦AI уже залогинен.');
        } else {
          console.log('⚠️  Профиль на диске есть, но вход НЕ выполнен.');
          console.log('   Войди паролем вручную (он есть в записи аккаунта на вкладке) либо');
          console.log('   пересобери снимок: node rumeng/refresh-sessions.js');
          await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await prefillLogin(page);
        }
      } else {
        console.log('✅ Профиль восстановлен — 如梦AI уже залогинен (панель подтвердила токен).');
      }
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    console.log('⚠️  Первый вход. Залогинься email + паролем на открывшейся странице.');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await prefillLogin(page);
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
