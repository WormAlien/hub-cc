// vani/open-session.js
//
// Открывает видимый Chromium с персональным профилем аккаунта Vani (vani.ai).
// Профиль сохраняет историю, cookies, localStorage и сессию панели на диск.
//
// 🔴 Особенность vani: ВХОД БЕЗ ПАРОЛЯ. Email -> 6-значный код на почту -> сессия.
// Пароля нет вовсе, поэтому prefill подставляет только адрес, а код владелец вводит
// руками. На шаге отправки email стоит Cloudflare Turnstile - в Chromium (CDP) он часто
// падает; если капча не проходит тут, ходи в ЛК через Camoufox
// (`vani/record-signup-camoufox.py`), где движок не CDP и Turnstile проходит молча.
//
// Использование:
//   node vani/open-session.js <label> [register|console]
//     label   - имя профиля (папка vani/profiles/<label>/)
//     mode    - register: страница входа/регистрации, console: консоль ключей,
//               auto (по умолчанию): чистый профиль = register, иначе console.
//
// Email берётся только из VN_LK_EMAIL (в argv не передаётся). Пароля у площадки нет.
// Окно остаётся открытым до закрытия пользователем.

const { chromium } = require('playwright');
const { raiseBrowserWindow } = require('../routing/lib/focus-window.js');
const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://c.vani.ai/login';
const CONSOLE_URL = 'https://c.vani.ai/settings/developer';
const ROOT_URL = 'https://c.vani.ai/';
const STATUS_URL = 'https://vani.ai/api/status';
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const POOL_FILE = path.join(__dirname, '..', 'routing', 'vani-sessions.json');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function holdOpen(context) {
  return new Promise((resolve) => { context.on('close', resolve); });
}

// Снимок сессии из пула (если есть) - переносим куки и localStorage.
function loadImportedSession() {
  try {
    const p = path.join(SESSIONS_DIR, label + '.json');
    if (!fs.existsSync(p)) return null;
    const ss = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!ss || typeof ss !== 'object') return null;
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
    try { await context.addCookies(session.cookies); applied = true; }
    catch (e) { console.log(`⚠️ часть cookies не применилась: ${e.message}`); }
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

const SITE_HOST = 'vani.ai';
const CF_COOKIE_RE = /^(cf_clearance|__cf_bm|_cfuvid|cf_chl)/i;
const SITE_SESSION_RE = /session|token|access|auth|refresh|sid|jwt/i;
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
    } catch { /* без кеш-бага страница живёт и так */ }
  };
  context.on('page', p => { apply(p); });
  await apply(page);
}

// Панель vani - SPA: и вход, и чат отдаются по своим URL. Признак «не вошёл» -
// видимое поле ввода email на странице входа.
async function isLoginPage(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector('input#email, input[type="email"]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  } catch { return false; }
}

async function trySnapshotRecovery(page, context, shared) {
  if (!shared) return false;
  await applyImportedSession(context, shared);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(4000);
  return !(await isLoginPage(page));
}

// У vani свой статус-HTTP (не соглашение New API): отдаёт проверки компонентов.
async function preflight() {
  try {
    const r = await fetch(STATUS_URL, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json' },
    });
    if (r.status !== 200) return { ok: false, error: `api/status HTTP ${r.status}` };
    const d = (await r.json()) || {};
    const bad = (d.components || []).filter(c => c.status && c.status !== 'operational');
    return { ok: true, components: (d.components || []).length, down: bad.map(c => c.id) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Подстановка только адреса: пароля у vani нет, код из письма владелец вводит сам.
async function prefillLogin(page) {
  const email = String(process.env.VN_LK_EMAIL || '').trim();
  if (!email) return false;
  try {
    const emailSel = 'input#email, input[type="email"]';
    await page.waitForSelector(emailSel, { timeout: 20000 });
    const e = page.locator(emailSel).first();
    if (await e.count()) await e.fill(email);
    console.log('🔐 Адрес подставлен из VN_LK_EMAIL.');
    console.log('   У vani ВХОД БЕЗ ПАРОЛЯ: нажми «Email me a sign-in link or code»,');
    console.log('   пройди Turnstile, введи 6-значный код из письма.');
    return true;
  } catch (e) {
    console.log(`ℹ️  Поле email не найдено (${e.message.split('\n')[0]}) - вход руками.`);
    return false;
  }
}

async function main() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();
  const shared = loadImportedSession();

  console.log('🚀 Запускаю Chromium (видимый режим)…');
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен вход)' : 'уже есть (сохранённый)'}`);
  console.log(`🗂️  пул сессий: ${POOL_FILE}`);

  const pre = await preflight();
  if (!pre.ok) {
    console.log(`⚠️  статус площадки не прочитался (${pre.error}) - открываю окно как есть.`);
  } else {
    console.log(`🛰️  vani: компонентов ${pre.components}, не в норме: ${pre.down.length ? pre.down.join(', ') : 'нет'}.`);
  }

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

  const existingCookies = await context.cookies().catch(() => []);
  const needSnapshot = !!shared && (fresh || !hasSessionCookie(existingCookies));
  const appliedSession = needSnapshot ? await applyImportedSession(context, shared) : false;
  const wantLogin = appliedSession ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;

  try {
    if (appliedSession) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(3000);
      if (await isLoginPage(page)) {
        if (await trySnapshotRecovery(page, context, shared)) {
          console.log('✅ Снимок применён со второй попытки - vani залогинен.');
        } else {
          console.log('⚠️  Снимок применён, но панель показывает страницу входа.');
          console.log('   Пересобери снимок из живого профиля (`vani/profiles/<label>`).');
        }
      } else {
        console.log('✅ Снимок применён - vani залогинен.');
      }
      console.log('   Браузер открыт - закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    if (wantLogin) {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2000);
      console.log('⚠️  Вход vani: адрес -> код из письма. Пароля нет, Turnstile может потребоваться.');
      await prefillLogin(page);
      console.log('   Браузер остаётся открытым - закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
    if (!fresh) {
      if (await isLoginPage(page)) {
        if (await trySnapshotRecovery(page, context, shared)) {
          console.log('✅ Снимок из пула применён - vani залогинен.');
        } else {
          console.log('⚠️  Профиль на диске есть, но вход НЕ выполнен - открыта форма входа.');
          console.log('   Войди по коду из письма вручную.');
        }
      } else {
        console.log('✅ Профиль восстановлен - vani залогинен.');
      }
      console.log('   Браузер открыт - закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    console.log('⚠️  Первый вход: введи адрес и код из письма на странице входа.');
    await prefillLogin(page);
    console.log('   Браузер остаётся открытым - закрой когда закончишь (Ctrl+C).');
    await holdOpen(context);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
