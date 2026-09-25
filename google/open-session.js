// google/open-session.js
//
// Открывает видимый Chromium с профилем КОНКРЕТНОГО Google-аккаунта и доводит человека до
// входа в аккаунт (https://accounts.google.com/). Как только аккаунт открылся - снимает
// storageState в google/sessions/<id>.json, ставит `sessionAt` в пуле и оставляет окно
// жить: закрывает его человек.
//
// Зачем аккаунту профиль браузера, а не только пара логин-пароль: вход в Google с нового
// адреса упирается в челлендж (код на телефон, «подтвердите, что это вы», «не ваш
// компьютер?»), а профиль - это ровно то, что его переживает. Пароль здесь не доступ к
// почте, а то, чем человек ОДИН РАЗ входит в профиль; дальше живёт кука.
//
// Сценарий:
//   1. В дашборде на карточке аккаунта жмёшь «Открыть сессию».
//   2. Открывается Chromium с профилем google/profiles/acct_<id>/ (на аккаунт).
//   3. Скрипт подставляет адрес и жмёт «Далее», подставляет пароль - и ОСТАНАВЛИВАЕТСЯ.
//      Кнопку входа не жмём осознанно: у Google на этом шаге бывает капча, «Подтвердите,
//      что это вы», код из приложения-аутентификатора и «Остаться в системе?». Человек
//      проходит это быстрее, чем автоматика распознаёт, что именно спросили.
//   4. Если у записи есть 2FA-секрет - скрипт печатает ЖИВОЙ код и обновляет его каждые
//      30 секунд, пока окно ждёт входа. Телефон за кодом тянуться не нужно.
//   5. Профиль пишется на диск сам (launchPersistentContext) - на следующих открытиях
//      аккаунт поднимается без пароля.
//
// Использование:
//   GOOGLE_EMAIL=… GOOGLE_PASS=… GOOGLE_TOTP=… node google/open-session.js acct_<id>
//   Креды ТОЛЬКО переменными среды: argv видно в диспетчере задач. Если переменных нет -
//   берём пару из самой записи пула (тот же файл, новых секретов не появляется).
//
// Коды возврата: 0 - окно открылось и было закрыто штатно, 1 - ошибка,
//                2 - таймаут ожидания входа (10 мин), 3 - label не найден в пуле.

const { chromium } = require('playwright');
const { raiseBrowserWindow } = require('../routing/lib/focus-window.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../routing/lib/google-pool.js');

const accountId = String(process.argv[2] || '').trim();
const label = pool.profileLabel(accountId);
const profileDir = path.join(pool.PROFILES_DIR, label);

const SIGNIN_URL = 'https://accounts.google.com/';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной догон капчи и челленджа

const EMAIL_SELECTORS = ['input[type="email"]', 'input[name="identifier"]'];
const NEXT_SELECTORS = ['#identifierNext button', '#identifierNext', 'button:has-text("Next")'];
const PASS_SELECTORS = ['input[type="password"]', 'input[name="Passwd"]'];
const PASS_NEXT_SELECTORS = ['#passwordNext button', '#passwordNext'];
const TOTP_SELECTORS = ['input#totpPin', 'input[name="totpPin"]', 'input[type="tel"][maxlength="6"]'];

// ── TOTP ─────────────────────────────────────────────────────────────────────
// RFC 6238, шаг 30 секунд, SHA-1: то, что отдаёт любой аутентификатор. Своя реализация, а
// не пакет, потому что зависимость ради пятнадцати строк в этом репозитории не заводится.
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** Код на момент `at`. Возвращает null, если секрета нет или он не разбирается. */
function totpCode(secret, at = Date.now()) {
  const key = base32Decode(secret);
  if (!key.length) return null;
  const counter = Math.floor(at / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac('sha1', key).update(msg).digest();
  const off = hash[hash.length - 1] & 0x0f;
  const num = ((hash[off] & 0x7f) << 24) | (hash[off + 1] << 16) | (hash[off + 2] << 8) | hash[off + 3];
  return String(num % 1000000).padStart(6, '0');
}
const secondsLeft = (at = Date.now()) => 30 - (Math.floor(at / 1000) % 30);

// ── Запись пула ──────────────────────────────────────────────────────────────

function resolveAccount() {
  if (!accountId) { console.error('✗ не передан label (ожидается acct_<id>)'); process.exit(3); }
  let arr = [];
  try { arr = pool.load(); }
  catch (e) { console.error(`✗ пул не читается: ${e.message}`); process.exit(3); }
  const rec = pool.findById(arr, accountId);
  if (!rec) { console.error(`✗ ${label} в пуле не найден (${pool.FILE})`); process.exit(3); }
  return rec;
}

// Креды: переменные среды важнее записи пула - в них то же самое, но решённое сейчас.
function credentials(rec) {
  let email = String(process.env.GOOGLE_EMAIL || '').trim();
  let pass = String(process.env.GOOGLE_PASS || '');
  let totp = String(process.env.GOOGLE_TOTP || '').trim();
  let src = 'среда';
  if (!email && !pass) {
    email = String(rec.email || '').trim();
    pass = String(rec.password || '');
    src = 'пул';
  }
  if (!totp) totp = String(rec.totpSecret || '').trim();
  return { email, pass, totp, src };
}

const isFreshProfile = () => { try { return fs.readdirSync(profileDir).length === 0; } catch { return true; } };

function snapshotSession(context, rec) {
  try {
    fs.mkdirSync(pool.SESSIONS_DIR, { recursive: true });
    const file = path.join(pool.SESSIONS_DIR, `${rec.id}.json`);
    return context.storageState({ path: file }).then(() => {
      console.log(`💾 снимок сессии: ${file}`);
      const arr = pool.load();
      const cur = pool.findById(arr, rec.id);
      if (cur) {
        cur.sessionAt = new Date().toISOString();
        pool.save(arr);
        console.log('📌 sessionAt в пуле обновлён');
      }
      return true;
    }).catch(e => { console.log(`ℹ️  снимок не снялся (${e.message}) - профиль всё равно на диске`); return false; });
  } catch (e) {
    console.log(`ℹ️  снимок не снялся (${e.message})`);
    return Promise.resolve(false);
  }
}

// ── Работа со страницей ──────────────────────────────────────────────────────

async function visible(page, selectors) {
  for (const s of selectors) {
    const loc = page.locator(s).first();
    try { if (await loc.isVisible({ timeout: 1200 })) return loc; } catch { /* следующая */ }
  }
  return null;
}

// «Мы внутри» проверяется АДРЕСОМ, а не подписью на странице: язык интерфейса у купленного
// аккаунта какой угодно, и «Добро пожаловать» на румынском не совпадёт ни с чем. Форма входа
// живёт на accounts.google.com; кабинет, почта и диск - уже внутри.
async function waitForLogin(page, creds) {
  const started = Date.now();
  let filledEmail = false, filledPass = false, printedCode = '';
  while (Date.now() - started < LOGIN_TIMEOUT_MS) {
    const url = page.url();
    // Ушли с формы входа на кабинет - значит вход состоялся.
    if (/^https?:\/\/(myaccount|mail|drive)\.google\.com\//i.test(url)) return { ok: true };

    if (!filledEmail && creds.email) {
      const field = await visible(page, EMAIL_SELECTORS);
      if (field) {
        try {
          await field.fill(creds.email);
          const next = await visible(page, NEXT_SELECTORS);
          if (next) await next.click({ timeout: 5000 });
          else await field.press('Enter');
          filledEmail = true;
          console.log(`🔐 Адрес подставлен (${creds.src}) и нажато «Далее».`);
        } catch (e) {
          console.log(`ℹ️  адрес подставить не удалось (${e.message.split('\n')[0]}) - введи руками.`);
          filledEmail = true;
        }
      }
    }

    if (!filledPass && creds.pass) {
      const field = await visible(page, PASS_SELECTORS);
      if (field) {
        try {
          await field.fill(creds.pass);
          filledPass = true;
          console.log('🔐 Пароль подставлен. Кнопку входа НЕ нажимаю: дальше Google может спросить');
          console.log('   капчу, «Подтвердите, что это вы» или код из приложения - допройди сам.');
        } catch (e) {
          console.log(`ℹ️  пароль подставить не удалось (${e.message.split('\n')[0]}) - введи руками.`);
          filledPass = true;
        }
      }
    }

    // Код 2FA печатаем, только если Google его действительно спрашивает, и обновляем на
    // смене тридцатисекундного окна - иначе он протухнет ровно в момент ввода.
    const totpField = creds.totp ? await visible(page, TOTP_SELECTORS) : null;
    if (totpField) {
      const code = totpCode(creds.totp);
      if (code && code !== printedCode) {
        printedCode = code;
        console.log(`🔑 код 2FA: ${code} (осталось ${secondsLeft()} с)`);
      }
    }

    await page.waitForTimeout(1500).catch(() => {});
  }
  return { ok: false };
}

async function main() {
  const rec = resolveAccount();
  const creds = credentials(rec);
  fs.mkdirSync(pool.PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();

  console.log('🚀 Запускаю Chromium (видимый режим)…');
  console.log(`🔵 аккаунт: ${rec.email || '(адреса в записи нет)'} · ${rec.kind || 'burner'} · id=${accountId}`);
  console.log(`📂 профиль: ${profileDir} · ${fresh ? 'чистый (нужен вход)' : 'уже есть (сохранённый)'}`);
  if (!creds.email && !creds.pass) console.log('⚠️  Ни GOOGLE_EMAIL/GOOGLE_PASS, ни пары в записи пула - форму заполняешь руками.');
  else if (!creds.pass) console.log('ℹ️  Пароля нет - подставлю только адрес.');
  if (!creds.totp) console.log('ℹ️  2FA-секрета в записи нет - код придётся взять из телефона.');

  // launchPersistentContext держит профиль открытым и пишет на диск всё сам.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    // Разрешаем расширения в окне (владелец ставит своё прокси-расширение): снимаем дефолтный
    // --disable-extensions Playwright и берём системный Chrome - Chrome Web Store ставит
    // расширения только в него, не в комплектный Chromium.
    channel: 'chrome',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--window-size=1100,900', '--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.bringToFront();
  raiseBrowserWindow(); // bringToFront поднимает только вкладку - окно ОС наверх выносит WinAPI

  try {
    console.log(`🎯 ${SIGNIN_URL}`);
    await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded' })
      .catch(e => console.log(`ℹ️  первая навигация оборвалась редиректом (${e.message.split('\n')[0]}) - жду конечное состояние`));

    const res = await waitForLogin(page, creds);
    if (!res.ok) {
      console.log('⏱️  вход не случился за 10 минут. Окно оставляю открытым: войди руками,');
      console.log('   потом закрой его - снимок сессии сниму при закрытии.');
    } else {
      console.log('✅ Аккаунт открыт.');
      await snapshotSession(context, rec);
    }

    // Окно живёт до закрытия человеком. По закрытию снимаем снимок ещё раз: если вход
    // случился после таймаута, он не должен потеряться.
    await new Promise(resolve => {
      context.on('close', resolve);
      process.on('SIGINT', () => { context.close().catch(() => {}); });
    });
    if (!res.ok) await snapshotSession(context, rec);
    console.log('👋 окно закрыто');
    process.exit(0);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    try { await context.close(); } catch { /* уже закрыт */ }
    process.exit(1);
  }
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
