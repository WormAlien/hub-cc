// dacall/record-signup.js
//
// Запись процесса регистрации на dacall.AI в браузере: видео + HAR + скриншоты по шагам.
// Ящик берётся у emailnator (точечный @gmail.com) — вайтлиста доменов у панели нет,
// но gmail «свежее» и владелец просил emailinator-цепочку.
//
// Запуск:  node dacall/record-signup.js
// Выход:   dacall/artifacts/signup-<штамп>/  (video/, *.png, *.har, account.json, run.log)
//
// ── Что разведано статикой по контракту (01.10) ────────────────────────────────
//   POST /api/v1/auth/send-verify-code   { email }
//   POST /api/v1/auth/register           { email, password, verify_code, aff_code?, promo_code? }
// Капчи нет (turnstile и обе китайские выключены), invitation_code выключен.
// Поля формы: #email #password #confirmPassword  →  #code на /email-verify.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const emailnator = require('../freemodel/lib/emailnator');

const SITE = 'https://ru.dacall.ai';
const REGISTER_URL = SITE + '/register';

const stamp = new Date().toLocaleString('sv').slice(0, 19).replace(/[: ]/g, '-');
const OUT = path.join(__dirname, 'artifacts', 'signup-' + stamp);
const VIDEO_DIR = path.join(OUT, 'video');
fs.mkdirSync(VIDEO_DIR, { recursive: true });

const LOG = [];
function log(...a) {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  LOG.push(line);
  console.log(line);
  fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n') + '\n', 'utf-8');
}

// Пароль: 16 символов, буквы+цифры+знак. Панель требует минимум (проверялось валидатором: min).
function makePassword() {
  const A = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789', S = '!@#$%';
  const pick = s => s[crypto.randomInt(s.length)];
  let p = pick(A) + pick(A.toUpperCase()) + pick(D) + pick(S);
  while (p.length < 16) p += pick(A + A.toUpperCase() + D);
  return p;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + '.png') }).catch(() => {});
}

// Принять всплывшее соглашение (login_agreement_mode: "modal").
//
// 🪤 На живом прогоне 18:06 кнопка называется **«Принять и продолжить»**, а не «Продолжить»:
// прежний список с якорями `^продолжить$` её не поймал, модалка осталась открытой, и отправка
// формы ушла в никуда — URL так и остался `/register`. Ищем по корню «принять», а не по целому
// тексту, и ждём, пока окно исчезнет.
async function acceptAgreement(page) {
  for (let i = 0; i < 5; i++) {
    const btn = page.getByRole('button', { name: /принять|соглас|accept|i agree|同意/i }).first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) break;
    const label = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    await btn.click({ timeout: 5000 }).catch(() => {});
    log('  соглашение: нажал «' + label + '»');
    await sleep(1200);
  }
  // Галочка согласия, если она есть в форме
  const cb = page.locator('input[type=checkbox]').first();
  if (await cb.count().catch(() => 0)) {
    const on = await cb.isChecked().catch(() => false);
    if (!on) { await cb.check({ timeout: 3000 }).catch(() => {}); log('  соглашение: поставил галочку'); }
  }
  await page.locator('input#email').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
}

async function main() {
  log('=== запись регистрации dacall.AI ===', stamp);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'ru-RU',
    recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 900 } },
    recordHar: { path: path.join(OUT, 'trace.har'), content: 'embed' },
  });
  context.setDefaultTimeout(20000);

  const emailPage = await context.newPage();
  const page = await context.newPage();

  try {
    // ── 1. Ящик ─────────────────────────────────────────────────────────────
    log('[1/7] беру ящик у emailnator…');
    const email = await emailnator.createEmail(emailPage);
    log('  ящик:', email);

    // ── 2. Форма регистрации ────────────────────────────────────────────────
    log('[2/7] открываю', REGISTER_URL);
    await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await emailnator.dismissCookie(page);
    await acceptAgreement(page);          // модалка «Условия обновлены» встаёт сразу на входе
    await shot(page, '01-register');

    const password = makePassword();
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    if (await page.locator('#confirmPassword').count()) {
      await page.locator('#confirmPassword').fill(password);
    }
    await shot(page, '02-filled');
    log('  форма заполнена, пароль:', password);

    // ── 3. Отправка ─────────────────────────────────────────────────────────
    log('[3/7] отправляю форму…');
    const submit = page.locator('form button[type=submit]').first();
    if (await submit.count()) await submit.click({ timeout: 8000 }).catch(() => {});
    else {
      log('  ⚠️ form button[type=submit] не найден — пробую по тексту');
      await page.getByRole('button', { name: /создать аккаунт|зарегистр|sign ?up|注册/i }).first()
        .click({ timeout: 8000 }).catch(() => {});
    }
    await page.waitForURL(/email-verify|\/dashboard/, { timeout: 20000 })
      .catch(() => log('  ⚠️ URL не сменился на /email-verify за 20 с'));
    await page.waitForTimeout(2000);
    await acceptAgreement(page);
    await page.waitForTimeout(1500);
    log('  URL после отправки:', page.url());
    await shot(page, '03-after-submit');

    // ── 4. Код ──────────────────────────────────────────────────────────────
    // ── 4. Запрос кода и ожидание письма ────────────────────────────────────
    // На /email-verify код может уходить сам, а может ждать кнопку — жмём, если она есть.
    const sendBtn = page.getByRole('button', { name: /отправить код|нажмите|отправить повторно|send code|resend/i }).first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click({ timeout: 6000 }).catch(() => {});
      log('  нажал «отправить код» на странице подтверждения');
      await page.waitForTimeout(3000);
      await shot(page, '03b-code-requested');
    }

    log('[4/7] жду код в ящике (письмо от dacall)…');
    const code = await emailnator.pollInbox(emailPage, email, { timeout: 6, fromHint: 'dacall' });
    if (!code) throw new Error('код не пришёл за 6 минут');
    log('  код:', code);
    await shot(emailPage, '04-inbox-code');

    // ── 5. Подтверждение ────────────────────────────────────────────────────
    log('[5/7] ввожу код…');
    await page.bringToFront();
    if (!/email-verify/i.test(page.url())) {
      log('  ⚠️ мы не на странице подтверждения, URL=' + page.url());
    }
    await page.locator('#code').fill(code);
    await shot(page, '05-code-entered');
    const submit2 = page.locator('form button[type=submit]').first();
    if (await submit2.count()) await submit2.click({ timeout: 8000 }).catch(() => {});
    else await page.getByRole('button', { name: /подтверд|создать|verify|продолж/i }).first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(6000);
    log('  URL после подтверждения:', page.url());
    await shot(page, '06-after-verify');

    // ── 6. Ключ: страница API-ключей, создание, чтение полного значения ─────
    log('[6/7] создаю API-ключ на вкладке «API-ключи»…');
    await page.goto(SITE + '/keys', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(4000);
    await acceptAgreement(page);
    await shot(page, '07-keys-empty');

    let apiKey = null, keyFrom = null;
    // (а) сначала как человек: кнопка создания → имя → группа → подтвердить
    try {
      await page.getByRole('button', { name: /создать|новый ключ|добавить|create|new key/i }).first()
        .click({ timeout: 6000 });
      await page.waitForTimeout(1500);
      const nameInput = page.locator('input[type=text]:visible').first();
      if (await nameInput.count()) await nameInput.fill('cc-' + stamp.slice(-5));
      // группа Claude code (у dacall ключ без группы не работает вовсе)
      const groupSelect = page.locator('select:visible').first();
      if (await groupSelect.count()) {
        await groupSelect.selectOption({ label: /claude code/i }).catch(() => {});
      } else {
        await page.getByRole('button', { name: /групп/i }).first().click({ timeout: 3000 }).catch(() => {});
        await page.getByText(/claude code/i).first().click({ timeout: 3000 }).catch(() => {});
      }
      await shot(page, '08-key-form');
      await page.locator('form button[type=submit]').first().click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(3500);
      await shot(page, '09-key-created');
      const m = await page.evaluate(() => (document.body.innerText.match(/sk-[0-9a-f]{20,}/i) || [])[0] || null).catch(() => null);
      if (m) { apiKey = m; keyFrom = 'ui'; }
    } catch (e) { log('  UI-путь не прошёл:', e.message); }

    // (б) запасной путь тем же контрактом: POST /keys {name, group_id}
    if (!apiKey) {
      apiKey = await page.evaluate(async () => {
        const t = localStorage.getItem('access_token') || localStorage.getItem('token');
        const r = await fetch('https://api-ru.dacall.ai/api/v1/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
          body: JSON.stringify({ name: 'cc-auto', group_id: 3 }),   // 3 = Claude code standard-ru
        });
        const j = await r.json();
        return (j && j.data && j.data.key) || null;
      }).catch(() => null);
      keyFrom = apiKey ? 'api' : null;
    }
    await shot(page, '10-key-final');
    log('  ключ:', apiKey ? apiKey.slice(0, 22) + '…' : 'НЕ ПОЛУЧЕН', '(источник:', keyFrom + ')');

    // Проверка ключа живым запросом к /v1/messages
    let keyOk = null;
    if (apiKey) {
      keyOk = await page.evaluate(async (k) => {
        const r = await fetch('https://api-ru.dacall.ai/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: KEY-OK' }] }),
        });
        return { status: r.status, body: (await r.text()).slice(0, 300) };
      }, apiKey).catch(e => ({ status: -1, body: e.message }));
      log('  проверка ключа:', JSON.stringify(keyOk).slice(0, 200));
    }

    // ── 7. Что получили ─────────────────────────────────────────────────────
    log('[7/7] собираю результат…');
    const auth = await page.evaluate(() => ({
      user: localStorage.getItem('auth_user'),
      token: localStorage.getItem('access_token') || localStorage.getItem('token'),
      keys: Object.keys(localStorage),
    })).catch(() => ({}));

    let user = null;
    try { user = JSON.parse(auth.user || 'null'); } catch { /* как есть */ }

    await page.goto(SITE + '/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(5000);
    await shot(page, '11-dashboard');
    const dashText = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 2500)).catch(() => '');

    const result = {
      stamp, site: SITE, email, password, code,
      apiKey, keyFrom, keyOk,
      finalUrl: page.url(),
      user,
      token: auth.token || null,
      localStorageKeys: auth.keys || [],
      dashboardText: dashText,
    };
    fs.writeFileSync(path.join(OUT, 'account.json'), JSON.stringify(result, null, 2), 'utf-8');
    // Почта и ключ - отдельными короткими файлами, чтобы не искать их в JSON
    fs.writeFileSync(path.join(OUT, 'mailbox.txt'), email + '\n' + password + '\n' + (apiKey || '') + '\n', 'utf-8');
    fs.writeFileSync(path.join(__dirname, 'last-mailbox.txt'), email + '\n' + password + '\n' + (apiKey || '') + '\n', 'utf-8');

    log('[7/7] готово:', OUT);
    log('  === ПОЧТА:', email);
    log('  === ПАРОЛЬ:', password);
    log('  === КЛЮЧ:', apiKey || 'НЕ ПОЛУЧЕН');
    log('  user:', JSON.stringify(user));
  } catch (e) {
    log('❌ ОШИБКА:', e.message);
    await shot(page, '99-error').catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    // видео появляется на диск только после close
    const vids = fs.readdirSync(VIDEO_DIR).filter(f => f.endsWith('.webm'));
    if (vids.length) log('  видео:', vids.map(v => path.join(VIDEO_DIR, v)).join(', '));
  }
}

main();
