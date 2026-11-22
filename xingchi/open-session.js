'use strict';
// xingchi/open-session.js
//
// Открывает панель Xingchi в видимом Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ аккаунта —
// кнопка 🌐 на вкладке. Контракт вызова задан хендлером `handleXcSessionOpen` в
// `routing/transparent-proxy.js`:
//
//   node xingchi/open-session.js <label> [register|console|auto]
//     label = acct_<id записи в пуле>; профиль → xingchi/profiles/<label>/
//     register — у аккаунта ещё нет ключа: открываем регистрацию по рефке владельца;
//     console  — ключ уже есть: открываем страницу ключей;
//     auto     — register при чистом профиле, иначе console.
//
// 🔴 ПОЧЕМУ ЭТО НЕ КОПИЯ kktoken/open-session.js. Канон ([[ADDING-A-GATEWAY]] § 3.10)
// оставляет этот файл руками, потому что он сайт-специфичен. Отличия площадки, снятые
// живой разведкой 21.11.2026 (см. `GET /api/v1/settings/public`):
//
//   • GitHub-OAuth ВЫКЛЮЧЕН (`github_oauth_enabled:false`), как и Google/WeChat/OIDC.
//     Вход в кабинет — только LinuxDO-OAuth (`linuxdo_oauth_enabled:true`) либо
//     регистрация по email. Значит осмысленного «GitHub-входа» тут нет вовсе, и
//     кнопка открывает страницу, где человек входит сам.
//   • На регистрации включён Turnstile Cloudflare (`turnstile_enabled:true`,
//     site_key `0x4AAAAAAF9rGuWcH0qXc1BK`). Автоматическая регистрация невозможна в
//     принципе: скрипт открывает окно и ждёт, пока капчу и вход пройдёт человек.
//   • Признак «я вошёл» лежит НЕ в куке, а в `localStorage` (`token`/`user` у панели
//     на этом движке). Поэтому проверять вход по куке бесполезно — смотрим localStorage
//     и отсутствие формы пароля.
//   • Регистрация живёт на панели `xingchiapi.com`, а НЕ на API-хосте
//     `api.xingchiapi.com`: рефка владельца ведёт на `xingchiapi.com/register?aff=…`.
//
// Сценарий:
//   1. В дашборде добавляешь аккаунт, жмёшь 🌐 «Открыть браузер».
//   2. Открывается Chromium с профилем xingchi/profiles/<label>/ (на аккаунт).
//   3. Ключа нет → РЕГИСТРАЦИЯ по рефке владельца. Ключ вписан → страница ключей.
//   4. В кабинете возьми API-ключ и вставь его в аккаунт кнопкой 🔑 на дашборде.
//   5. Профиль сохраняется автоматически — при следующих открытиях вход уже есть.
//
// Код возврата 0 = профиль открыт, 1 = ошибка.

const { chromium } = require('playwright');
const { raiseBrowserWindow } = require('../routing/lib/focus-window.js');
const fs = require('fs');
const path = require('path');

// Панель (регистрация/ключи) и API-хост намеренно разные: рефка и кабинет — на панели.
const PANEL_ORIGIN = 'https://xingchiapi.com';
// Реф-ссылка — из routing/lib/ref-codes.js, а не литералом: код владельца лежит дефолтом
// в routing/ref-codes.default.json, пользователь вписывает свой через 💩 в «Настройках»
// дашборда. Одна точка на весь репозиторий.
const REGISTER_URL = require('../routing/lib/ref-codes.js').url('xingchi');
// Ключ уже вписан → сразу страница ключей, а не логин.
const CONSOLE_URL = `${PANEL_ORIGIN}/keys`;
const PROFILES_DIR = path.join(__dirname, 'profiles');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const modeArg = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

function log(...a) { console.log('[xingchi/open-session]', ...a); }

// Первый ли запуск профиля: нет файла Default/Preferences → чистый профиль.
function isFreshProfile() {
    return !fs.existsSync(path.join(profileDir, 'Default', 'Preferences'));
}

async function main() {
    if (!label.startsWith('acct_')) {
        log('❌ label должен быть вида acct_<id>, получено:', label);
        process.exit(1);
    }
    fs.mkdirSync(profileDir, { recursive: true });

    let mode = modeArg;
    if (mode !== 'register' && mode !== 'console') mode = isFreshProfile() ? 'register' : 'console';

    const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: null,                          // иначе страница заперта в 1280x800
        args: [
            '--window-size=600,1000', '--window-position=60,40',
            // 🔴 Без этого флага Turnstile не отдаёт челлендж ВООБЩЕ: виджет рисуется
            // пустой рамкой, iframe `challenges.cloudflare.com` не создаётся, токена нет,
            // и регистрация отвечает ошибкой проверки — при ручном клике тоже, потому что
            // кликать не по чему. Замер 22.11.2026 на живой форме xingchi (настоящий
            // sitekey `0x4AAAAAAF9rGuWcH0qXc1BK`), один IP, три сборки:
            //   комплектный Chromium без флага        → webdriver=true,  token 0 Б   (провал)
            //   комплектный Chromium + этот флаг      → webdriver=false, token 794 Б (прошёл)
            //   системный Chrome + этот флаг          → webdriver=false, token 794 Б (прошёл)
            // То есть дело не в сборке и не в адресе (с того же IP обычный Firefox-браузер
            // владельца проходит), а в флаге автоматизации. Строка есть во всех остальных
            // `*/open-session.js` хаба — здесь её недоставало.
            '--disable-blink-features=AutomationControlled',
        ],
    });

    const page = ctx.pages()[0] || await ctx.newPage();

    // Регистрация по рефке: один переход СРАЗУ по ссылке с кодом — сайт кладёт код в
    // localStorage и больше переходов до входа не делает (человек проходит Turnstile и
    // вход руками). Отдельный прогрев корня не нужен: рефка сама открывается 200.
    const url = (mode === 'register' && REGISTER_URL) ? REGISTER_URL : CONSOLE_URL;
    if (mode === 'register' && !REGISTER_URL) {
        log('⚠️ реф-ссылка не резолвится (нет кода) — открываю регистрацию без рефки');
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(e => log('goto:', e.message));
    // bringToFront поднимает вкладку; окно ОС наверх выносит WinAPI-хелпер.
    // Хелпер СИНХРОННЫЙ и на не-win32 возвращает undefined — не обещание.
    await page.bringToFront().catch(() => {});
    try { raiseBrowserWindow(); } catch { /* окно останется в общем порядке */ }

    // Вход держится в localStorage, а не в куке: у панели на этом движке признак «я
    // вошёл» — токен в localStorage + отсутствие формы пароля.
    await page.waitForTimeout(3500);
    const loggedIn = await page.evaluate(() => {
        const hasPw = !!document.querySelector('input[type=password]');
        let tok = null;
        try { tok = localStorage.getItem('token') || localStorage.getItem('access_token') || localStorage.getItem('user'); } catch {}
        return !hasPw && !!tok;
    }).catch(() => false);

    if (mode === 'register') {
        log('окно регистрации открыто — пройди Turnstile и вход руками; профиль сохранится сам');
    } else {
        log(loggedIn ? '✅ внутри кабинета' : '⚠️ похоже на форму входа — войди вручную, профиль сохранится');
    }

    log(`окно открыто: ${url} (профиль ${label}, режим ${mode})`);
    await new Promise(resolve => ctx.on('close', resolve));
    process.exit(0);
}

main().catch(e => { log('❌', (e && e.stack) || e); process.exit(1); });
