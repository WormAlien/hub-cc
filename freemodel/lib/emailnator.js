// freemodel/lib/emailnator.js
//
// Обёртка над emailnator.com: получить Gmail-алиас и дождаться письма.
// Принимает готовый Playwright page — можно reuse тот же browser context.
//
// API:
//   const { createEmail, openInbox, pollInbox } = require('../freemodel/lib/emailnator');
//   const email = await createEmail(page);              // всегда @gmail.com
//   await openInbox(page, email);                       // открыть ящик
//   const code  = await pollInbox(page, email, { timeout: 5 });
//
// ─── Переписано 2026-09-13 под новый сайт ───────────────────────────────────────
//
// 🔴 Старая версия сломана целиком, и молча: она читала адрес из `page.locator('input').first()`,
// а на сайте теперь НЕТ НИ ОДНОГО input — адрес лежит в `span.mf-mono` внутри `.mf-address-row`.
// `inputValue()` на пустом локаторе падал в catch, цикл молча крутился шесть раз и скрипт
// уходил с «не удалось получить email», хотя сайт был полностью рабочий.
//
// 🔴 Домен по умолчанию — НЕ gmail. Сайт выдаёт `vmcb98t@tmpmailtor.com`, то есть
// домен-двойник, который панели отсекают чёрными списками.
//
// 🎯 Нужная настройка — ВКЛЮЧЁН ТОЛЬКО ЧИП `.Gmail` (решение владельца 13.09):
//     Domain:выкл  +Gmail:выкл  .Gmail:ВКЛ  GoogleMail:выкл
// Даёт настоящий `имя.фамилия@gmail.com` с точками. Остальные варианты:
//   • все чипы включены (так сайт открывается) → адрес с плюс-алиасом, как `kentkouh+76wup@`
//   • `+Gmail` вместо `.Gmail` → тоже плюс-алиас
// Плюс-алиас виден панелям как признак одноразового ящика, поэтому берём точечный.
//
// 🪤 Чипы НЕЗАВИСИМЫ: клик по одному не гасит остальные, и на свежей загрузке включены все
// четыре. Значит мало нажать `.Gmail` — надо ещё ПОГАСИТЬ три остальных, иначе адрес
// получится с плюсом.
//
// 🪤 Состояние чипа в классах не отражается (`mf-chip` и до, и после), но читается по
// вычисленному фону переключателя: включён — синий `rgb(0,123,255)`, выключен — серый.
// Поэтому ориентируемся на цвет, а результат всё равно проверяем по самому адресу.
//
// Зачем именно Gmail: в [[Одноразовые почты — арсенал для авторегов]] записано, что ни один
// одноразовый домен у китайских панелей не проходит whitelist, а `@gmail.com` — проходит.

const POLL_INTERVAL_MS = 6000;
const MAX_WAIT_MIN = 15;
const SITE = 'https://www.emailnator.com/';

// 🪤 Класс адреса РАЗНЫЙ на двух страницах: на главной это `.mf-address-row .mf-mono`,
// а в ящике — `.mf-panel-address`. Со старым селектором чтение адреса в ящике молча
// возвращало пустоту (проверено живьём 13.09).
const ADDRESS_SEL = '.mf-address-row .mf-mono, .mf-panel-address, .mf-mono';

// Экранирование для точного совпадения по тексту чипа. Без него `+Gmail` и `.Gmail`
// работают как метасимволы регулярки, а `GoogleMail` даёт `\G` — невалидный escape.
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function dismissCookie(page) {
  for (const label of ['Got it', 'Consent', 'Accept']) {
    try {
      const b = page.locator('button', { hasText: label }).first();
      if (await b.count()) { await b.click({ timeout: 2500 }); await page.waitForTimeout(600); return; }
    } catch { /* баннера может не быть */ }
  }
}

async function readAddress(page) {
  try {
    const el = page.locator(ADDRESS_SEL).first();
    if (!(await el.count())) return '';
    return (await el.innerText()).trim();
  } catch { return ''; }
}

const CHIPS = ['Domain', '+Gmail', '.Gmail', 'GoogleMail'];
const WANT_CHIP = '.Gmail';

// Вытащить код из текста письма.
//
// 🔴 Прежний набор регулярок заканчивался на `\b(\d{4})\b` и потому возвращал МУСОР:
// на живом прогоне 13.09 он выдал «2026» — это год из копирайта «© 2026 如梦AI» в подвале
// страницы, а не код. Панель просит **шесть** цифр («6位验证码»), поэтому:
//   • сначала ищем шестёрку рядом со словом про код,
//   • затем любую шестёрку,
//   • четырёх- и пятизначные НЕ берём вовсе — их слишком много вокруг,
//   • годы (19xx/20xx) отсекаем явно.
function extractCode(text) {
  const s = String(text || '');
  const near = s.match(/(?:验证码|verification\s*code|verify\s*code|code|код|otp|pin)[^\d]{0,24}(\d{6})\b/i);
  if (near) return near[1];
  for (const m of s.matchAll(/\b(\d{6})\b/g)) {
    if (!/^(?:19|20)\d{2}$/.test(m[1])) return m[1];
  }
  return null;
}

// Включён ли чип. Считаем по фону переключателя: включён — синий акцент сайта,
// выключен — серый. Читаем с реального элемента, а не с атрибута: атрибут врёт.
async function chipState(page, label) {
  return page.evaluate((t) => {
    const b = [...document.querySelectorAll('button.mf-chip')]
      .find(x => (x.innerText || '').replace(/\s+/g, ' ').trim() === t);
    if (!b) return null;
    const sw = b.querySelector('.mf-chip-switch');
    if (!sw) return null;
    const m = (getComputedStyle(sw).backgroundColor || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const [r, g, bl] = [+m[1], +m[2], +m[3]];
    // синий доминирует над красным и достаточно ярок — иначе это серый «выключено»
    return bl > 150 && (bl - r) > 60;
  }, label);
}

async function clickChip(page, label) {
  const b = page.locator('button.mf-chip').filter({ hasText: new RegExp('^' + escRe(label) + '$') }).first();
  if (!(await b.count())) return false;
  await b.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(700);
  return true;
}

// Оставляем включённым ТОЛЬКО `.Gmail`. Мало нажать на него: чипы независимы, и на свежей
// загрузке включены все четыре — тогда адрес придёт с плюс-алиасом.
async function selectDotGmail(page) {
  const state = {};
  for (const c of CHIPS) state[c] = await chipState(page, c);
  console.log('[emailnator] тумблеры на входе:', CHIPS.map(c => `${c}:${state[c] ? 'ВКЛ' : 'выкл'}`).join('  '));

  for (const c of CHIPS) {
    if (state[c] === null) continue;                 // чипа нет — не наша забота
    const shouldBeOn = (c === WANT_CHIP);
    if (state[c] !== shouldBeOn) {
      await clickChip(page, c);
      console.log(`[emailnator] ${shouldBeOn ? 'включаю' : 'гашу'} ${c}`);
    }
  }
  const after = {};
  for (const c of CHIPS) after[c] = await chipState(page, c);
  console.log('[emailnator] тумблеры после:', CHIPS.map(c => `${c}:${after[c] ? 'ВКЛ' : 'выкл'}`).join('  '));
  return after[WANT_CHIP] === true;
}

// Один вызов = один рабочий Gmail. Настраиваем тумблеры под канон, генерируем и
// ПРОВЕРЯЕМ результат по адресу: тумблеры могут перерисоваться, а адрес не соврёт.
async function createEmail(page) {
  console.log('[emailnator] открываю сайт…');
  await page.goto(SITE, { timeout: 45000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await dismissCookie(page);
  await page.locator('button.mf-chip').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});

  const gen = page.locator('button', { hasText: /Generate New/i }).first();

  for (let attempt = 1; attempt <= 3; attempt++) {
    await selectDotGmail(page);
    if (await gen.count()) await gen.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const addr = await readAddress(page);
    console.log(`[emailnator] попытка ${attempt} → ${addr || '(пусто)'}`);
    if (addr && /@gmail\.com$/i.test(addr) && !addr.includes('+')) {
      // 🎯 ПОРЯДОК ВЛАДЕЛЬЦА, и он же рабочий: галочки → Generate New → **GO**.
      //
      // 🔴 Раньше GO стоял отдельно, уже на шаге кода (в openInbox), и адрес уходил
      // «неактивированным»: сгенерировали, переключились на панель, вернулись позже.
      // Владелец, глядя в окно, говорил «GO не нажат после generate» — и это была
      // не придирка: без GO сразу после генерации почта не начинает принимать.
      const urlBefore = page.url();
      const pressed = (await clickExactButton(page, 'GO !')) || (await clickExactButton(page, 'GO'));
      await page.waitForTimeout(4500);
      const bound = await readAddress(page);
      const moved = page.url() !== urlBefore;
      console.log(`[emailnator] GO нажат: ${pressed ? 'да' : 'НЕТ'} · переход: ${moved ? 'да' : 'нет'} · ящик: ${bound || '(пусто)'}`);
      if (bound && bound.toLowerCase() !== addr.toLowerCase()) {
        console.log(`[emailnator] ⚠️ ящик показывает «${bound}», ждём «${addr}» — жму GO ещё раз`);
        await clickExactButton(page, 'GO !');
        await page.waitForTimeout(4000);
      }
      console.log(`[emailnator] ✅ Gmail: ${addr}`);
      return addr;
    }
    if (addr && /@gmail\.com$/i.test(addr)) {
      // Плюс-алиас: тумблеры не встали как надо с первого раза — повторяем настройку
      console.log('[emailnator] адрес с плюс-алиасом — перенастраиваю тумблеры и пробую снова');
    }
  }
  throw new Error('emailnator не выдал точечный адрес @gmail.com за 3 попытки');
}

// Клик по кнопке с точным ВИДИМЫМ текстом.
//
// 🔴 Локаторы Playwright с якорями (`hasText: /^ТЕКСТ$/`) тут не годятся: внутри кнопок
// лежат иконки, `textContent` содержит разметку и пробелы, и якорь не совпадает — хотя
// `innerText` ровно такой. На этом встали два прогона (`继续` на панели) и потерялся
// `GO !` здесь. Ищем перебором в самой странице по нормализованному `innerText`,
// а кликаем настоящим кликом Playwright по индексу.
async function clickExactButton(page, text) {
  const idx = await page.evaluate((t) => {
    const all = [...document.querySelectorAll('button')];
    return all.findIndex(x => (x.innerText || '').replace(/\s+/g, ' ').trim() === t);
  }, text);
  if (idx < 0) return false;
  await page.locator('button').nth(idx).click({ timeout: 8000 }).catch(() => {});
  return true;
}

// Прочитать текст страницы ВМЕСТЕ С ТЕЛОМ ПИСЬМА.
//
// 🔴 Тело письма лежит внутри `<iframe class="w-full border-0 min-h-[300px]">`, а не в
// документе. Чтение одного `document.body` даёт только шапку и подвал — отправителя,
// тему и копирайт. Снаружи это выглядит как «в письме нет кода», хотя код есть, просто
// в другом документе. Найдено живьём 13.09: `body.innerText` — 485 символов, а во фрейме
// ещё 754 px письма.
async function readAllText(page) {
  const parts = [];
  try { parts.push(await page.locator('body').innerText()); } catch { /* бывает пусто */ }
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const t = await f.locator('body').innerText();
      if (t && t.trim()) parts.push(t);
    } catch { /* кросс-доменный или пустой фрейм — пропускаем */ }
  }
  return parts.join('\n');
}

async function openInbox(page, email) {
  // Если вкладка не на emailnator (например, только что создана) — сначала приходим туда.
  if (!/emailnator\.com/i.test(page.url())) {
    await page.goto(SITE, { timeout: 45000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await dismissCookie(page);
  }

  // 🎯 `GO !` — ЭТО И ЕСТЬ привязка ящика к адресу, а не декоративная кнопка.
  //
  // 🔴 Без него `/inbox` открывается со СЛУЧАЙНЫМ временным адресом другого домена:
  // на живом прогоне 13.09 в ящике оказался `n1hp1x6g@tmpnator.live`, пока мы ждали
  // письмо на `los.tk.yle18.4@gmail.com`. Снаружи это выглядит как «код не пришёл»,
  // и разбор уходит искать проблему в панели или в почте — куда угодно, кроме правды.
  const go = (await clickExactButton(page, 'GO !')) || (await clickExactButton(page, 'GO'));
  if (go) {
    // Явная отметка нажатия. Раньше в логе было только «ящик открыт: <адрес>», а это
    // косвенный признак: readAddress читает адрес на ЛЮБОЙ странице сайта, включая
    // главную. По такому логу нельзя было отличить «GO нажат» от «мы и не уходили
    // с главной». Владелец смотрел на окно и говорил «GO не нажат» — и был прав
    // в том, что лог этого не доказывал.
    const urlBefore = page.url();
    await page.waitForTimeout(4500);
    const moved = page.url() !== urlBefore;
    console.log(`[emailnator] GO нажат: да · переход в ящик: ${moved ? 'да' : 'НЕТ'} → ${page.url()}`);
  } else {
    console.log('[emailnator] GO нажат: НЕТ — кнопка не найдена, иду в ящик по адресу');
  }

  // Запасной путь: прямой адрес ящика. 🪤 Было `/mailbox#`, стало `/inbox#` — старый
  // путь отдаёт страницу без ящика, и ожидание писем уходит в пустой таймаут.
  // 🪤 Этот переход ОБЯЗАТЕЛЕН в коде: одно время он тут только упоминался в логе,
  // а самой навигации не было — снаружи это выглядело как `about:blank` и «код не пришёл».
  let shown = await readAddress(page);
  if (!shown || (email && shown.toLowerCase() !== String(email).toLowerCase())) {
    await page.goto(`${SITE}inbox#${email}`, { timeout: 45000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await dismissCookie(page);
    shown = await readAddress(page);
  }

  // 🛡 Проверяем, что ящик НАШ. Это главная страховка: молчаливый чужой ящик
  // неотличим от «письмо не пришло».
  if (shown && email && shown.toLowerCase() !== String(email).toLowerCase()) {
    throw new Error(`ящик привязан к «${shown}», а не к «${email}» — письмо придёт не туда`);
  }
  if (shown) console.log(`[emailnator] ящик открыт: ${shown}`);
  else console.log('[emailnator] ⚠️ ящик открыт, но адрес на странице не прочитался');
}

// Ждём письмо и вытаскиваем код. `fromHint` — подстрока отправителя, если писем в ящике
// много и нужно именно одно (у emailnator в ящик падает и служебное).
// Внутри письма или в списке? Это РАЗНЫЕ страницы с разным поведением.
const inMessage = (url) => /\/inbox\/[^/]+\//.test(url);

async function pollInbox(page, email, opts = {}) {
  const timeoutMin = opts.timeout || MAX_WAIT_MIN;
  const fromHint = (opts.fromHint || '').toLowerCase();
  const maxAttempts = Math.max(1, Math.floor((timeoutMin * 60 * 1000) / POLL_INTERVAL_MS));

  console.log(`[emailnator] слежу за ${email} (${timeoutMin} мин макс)…`);
  await openInbox(page, email);

  const opened = new Set();
  let backToInbox = 0;
  let lastReloadAt = 0;

  for (let i = 0; i < maxAttempts; i++) {
    const url = page.url();

    // ── Мы ВНУТРИ письма: читаем тело и НИЧЕГО не жмём ────────────────────────
    // 🪤 Reload отсюда выбрасывает обратно в список — на этом и был бесконечный цикл.
    if (inMessage(url)) {
      const body = await readAllText(page);
      const code = extractCode(body);
      if (code) { console.log(`[emailnator] 🎉 код: ${code}`); return code; }
      console.log(`[emailnator] в письме кода нет (${body.replace(/\s+/g, ' ').length} симв.) — смотрю следующее`);
      await openInbox(page, email);         // вернуться в список — через вход, не Reload
      backToInbox++;
      await page.waitForTimeout(1500);
      continue;
    }

    // ── Мы в СПИСКЕ: ищем подходящее письмо и открываем ──────────────────────
    const links = page.locator('a.mf-msg-link');

    // 🔴 Считаем отдельно от «ноль». Если страница ПЕРЕХОДИТ (а Reload сам вызывает
    // переход), `count()` падает — и раньше это молча превращалось в 0, то есть в
    // «список пуст», то есть в новый Reload. Самоподдерживающийся цикл: Reload →
    // навигация → count падает → Reload. Это и был бесконечный спам обновлений.
    let n = null;
    try { n = await links.count(); }
    catch (e) {
      console.log(`[emailnator] список не сосчитался (${e.message.slice(0, 40)}) — жду, не жму Reload`);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(4000);
      continue;
    }

    if (!n) {
      // Reload — не чаще раза в 15 с, и только когда список РЕАЛЬНО пуст.
      if (!lastReloadAt || Date.now() - lastReloadAt > 15000) {
        const reload = page.locator('button', { hasText: /Reload|Refresh/i }).first();
        if (await reload.count()) await reload.click({ timeout: 3000 }).catch(() => {});
        lastReloadAt = Date.now();
        console.log('[emailnator] список пуст — обновляю');
        // Даём странице успокоиться, иначе следующий count упадёт на навигации
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(4000);
      } else {
        await page.waitForTimeout(POLL_INTERVAL_MS);
      }
      continue;
    }

    let clicked = false;
    for (let j = 0; j < Math.min(n, 8); j++) {
      const t = ((await links.nth(j).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (/upgrade to unlock|locked sender/i.test(t)) continue;   // заглушка Premium
      if (/unleash the power|ai tools/i.test(t)) continue;        // реклама сайта
      if (fromHint && !t.toLowerCase().includes(fromHint)) continue;
      // 🔴 Адреса emailnator ПЕРЕИСПОЛЬЗУЮТСЯ: в свежем ящике лежат чужие старые письма.
      // Живой случай 13.09: взяли код 835302 из письма VerseIn трёхчасовой давности и
      // отправили его в rumeng → `invalid or expired verification code`. Берём только
      // свежие: «Just now» / «N mins ago». Часы и дни — чужое.
      if (/\d+\s*(hrs?|hours?|days?|d)\s*ago/i.test(t)) continue;
      if (opened.has(t)) continue;
      opened.add(t);
      console.log(`[emailnator] открываю: ${t.slice(0, 70)}`);
      clicked = await links.nth(j).click({ timeout: 4000 }).then(() => true).catch(() => false);
      if (clicked) { await page.waitForTimeout(2500); break; }
    }

    if (!clicked) {
      // все подходящие уже открывали — освежаем список
      const reload = page.locator('button', { hasText: /Reload|Refresh/i }).first();
      if (await reload.count()) await reload.click({ timeout: 3000 }).catch(() => {});
      process.stdout.write('.');
      await page.waitForTimeout(POLL_INTERVAL_MS);
    }
  }
  console.log(`\n[emailnator] ❌ письма с кодом нет за ${timeoutMin} мин (возвратов в список: ${backToInbox})`);
  return null;
}

module.exports = { createEmail, openInbox, pollInbox, readAddress, dismissCookie, extractCode, clickExactButton, readAllText };
