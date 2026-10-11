// gemini/open-session.js
//
// Открывает Chrome в профиле ВЫБРАННОГО Google-аккаунта и ведёт его по ссылке согласия
// Antigravity — той самой, по которой подписка Google разрешает отдавать модели Gemini.
//
// 🪤 Код авторизации здесь НЕ забирается. Его ловит сервер вкладки: он держит слушателя на
// `127.0.0.1:51121` (этот адрес прописан в OAuth-клиенте Antigravity, другим он быть не может)
// и сам добавляет аккаунт в пул. Окно только доводит человека до кнопки «Разрешить» и печатает
// живой код 2FA. Если колбэк не доедет (окно закрыли раньше, порт занят), человек вставит
// ссылку руками на вкладке — оба пути ведут к одному и тому же `completeOAuthFlow`.
//
// 🪤 Профиль — ТОТ ЖЕ, что у вкладки Google (`google/profiles/acct_<id>/`). Аккаунт там уже
// авторизован, поэтому обычно человеку остаётся нажать «Разрешить», а не вводить пароль.
// Второй профиль на тот же аккаунт означал бы вторую сессию Google и лишний челлендж —
// ровно то, от чего профиль и спасает.
//
// 🪤 Прокси аккаунта приходит сюда переменной (`GEMINI_PROXY`) и ставится ОКНУ. Это не
// украшение: вход и дальнейшие запросы к Google должны выйти с одного IP, иначе смена адреса
// выглядит как угон сессии — за это аккаунты и ловят бан (предупреждение апстрима прямо в
// README форка).
//
// Креды и прокси — ТОЛЬКО переменными среды: argv видно в диспетчере задач.
//
// Использование:
//   GEMINI_AUTH_URL=… GOOGLE_LABEL=acct_gg_… node gemini/open-session.js
//
// Коды возврата: 0 — окно закрыто (успели или нет — не важно), 1 — ошибка запуска,
//                2 — не дождались за 10 минут, окно оставлено человеку.

import { chromium } from 'playwright';
// Хаб — CommonJS, этот скрипт — ESM (так объявлена вся папка `gemini/`), поэтому импортируем
// именованными импортами: Node разбирает `module.exports = { … }` и отдаёт их как есть.
import { raiseBrowserWindow } from '../routing/lib/focus-window.js';
import { totpCode, secondsLeft } from '../routing/lib/totp.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const authUrl = String(process.env.GEMINI_AUTH_URL || '').trim();
const label = String(process.env.GOOGLE_LABEL || '').trim();
const email = String(process.env.GOOGLE_EMAIL || '').trim();
const pass = String(process.env.GOOGLE_PASS || '');
const totp = String(process.env.GOOGLE_TOTP || '').trim();
const proxyRaw = String(process.env.GEMINI_PROXY || '').trim();

let proxy = null;
if (proxyRaw) {
    try { proxy = JSON.parse(proxyRaw); } catch { console.error('✗ GEMINI_PROXY не разобрался как JSON — иду без прокси'); }
}

const CALLBACK_PREFIX = 'http://localhost:51121';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

const EMAIL_SELECTORS = ['input[type="email"]', 'input[name="identifier"]'];
const NEXT_SELECTORS = ['#identifierNext button', '#identifierNext', 'button:has-text("Next")', 'button:has-text("Далее")'];
const PASS_SELECTORS = ['input[type="password"]', 'input[name="Passwd"]'];
const TOTP_SELECTORS = ['input#totpPin', 'input[name="totpPin"]', 'input[type="tel"][maxlength="6"]'];
const CONSENT_SELECTORS = ['button:has-text("Разрешить")', 'button:has-text("Allow")', 'button:has-text("Continue")', '#submit_approve_access'];

function profileDirFor(label) {
    return path.join(REPO, 'google', 'profiles', label);
}

async function visible(page, selectors) {
    for (const s of selectors) {
        const loc = page.locator(s).first();
        try { if (await loc.isVisible({ timeout: 1200 })) return loc; } catch { /* следующая */ }
    }
    return null;
}

async function main() {
    if (!authUrl) { console.error('✗ не передана ссылка согласия (GEMINI_AUTH_URL)'); process.exit(1); }
    if (!label) { console.error('✗ не передан профиль аккаунта (GOOGLE_LABEL)'); process.exit(1); }

    const profileDir = profileDirFor(label);
    fs.mkdirSync(profileDir, { recursive: true });
    const fresh = (() => { try { return fs.readdirSync(profileDir).length === 0; } catch { return true; } })();

    console.log('🚀 Открываю Chrome…');
    console.log(`👤 аккаунт: ${email || '(адрес не передан)'} · профиль ${label} · ${fresh ? 'чистый (нужен вход)' : 'уже есть (вход обычно не спросят)'}`);
    console.log(proxy ? `🌐 прокси аккаунта: ${proxy.server}` : '🌐 прокси нет — Google увидит домашний IP этого аккаунта');

    const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: null,
        // Системный Chrome, а не комплектный Chromium: в нём живут расширения владельца
        // (прокси-расширение и прочее), и это тот же браузер, что открывает вкладка Google.
        channel: 'chrome',
        ignoreDefaultArgs: ['--disable-extensions'],
        args: ['--window-size=1100,900', '--disable-blink-features=AutomationControlled'],
        ...(proxy ? { proxy } : {}),
    });

    const page = context.pages()[0] || await context.newPage();
    await page.bringToFront();
    raiseBrowserWindow();

    let done = false;
    let filledEmail = false, filledPass = false, printedCode = '', consentShown = false;

    try {
        console.log('🎯 иду по ссылке согласия; дальше — «Разрешить» руками (капчу и «это вы?» автоматика не проходит)');
        await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
            .catch(e => console.log(`ℹ️  первая навигация оборвалась (${e.message.split('\n')[0]}) — жду конечное состояние`));

        const started = Date.now();
        while (Date.now() - started < LOGIN_TIMEOUT_MS) {
            const url = page.url();
            if (url.startsWith(CALLBACK_PREFIX)) { done = true; break; }

            if (!filledEmail && email) {
                const field = await visible(page, EMAIL_SELECTORS);
                if (field) {
                    try {
                        await field.fill(email);
                        const next = await visible(page, NEXT_SELECTORS);
                        if (next) await next.click({ timeout: 5000 }); else await field.press('Enter');
                        filledEmail = true;
                        console.log('🔐 адрес подставлен и нажато «Далее»');
                    } catch (e) { console.log(`ℹ️  адрес подставить не удалось (${e.message.split('\n')[0]})`); filledEmail = true; }
                }
            }

            if (!filledPass && pass) {
                const field = await visible(page, PASS_SELECTORS);
                if (field) {
                    // Кнопку входа НЕ жмём осознанно: у Google на этом шаге бывает капча и
                    // «Подтвердите, что это вы» — человек проходит это быстрее автоматики.
                    try { await field.fill(pass); console.log('🔐 пароль подставлен (кнопку жмёшь ты)'); }
                    catch (e) { console.log(`ℹ️  пароль подставить не удалось (${e.message.split('\n')[0]})`); }
                    filledPass = true;
                }
            }

            // Код 2FA печатаем, только когда Google его действительно спрашивает, и обновляем
            // на смене тридцатисекундного окна — иначе он протухнет ровно в момент ввода.
            const totpField = totp ? await visible(page, TOTP_SELECTORS) : null;
            if (totpField) {
                const code = totpCode(totp);
                if (code && code !== printedCode) {
                    printedCode = code;
                    console.log(`🔑 код 2FA: ${code} (осталось ${secondsLeft()} с)`);
                }
            }

            // Кнопку согласия ищем, но НЕ жмём: «Разрешить» на подписку стоит отдавать осознанно.
            const consent = await visible(page, CONSENT_SELECTORS);
            if (consent && !consentShown) {
                consentShown = true;
                console.log('✅ дошло до экрана согласия — жми «Разрешить», окно закроется само');
            }

            await page.waitForTimeout(1500).catch(() => {});
        }
    } catch (e) {
        console.error(`✗ ${e.message}`);
    }

    if (done) {
        console.log('🎉 согласие получено — код уехал серверу вкладки, аккаунт добавляется');
        await new Promise(r => setTimeout(r, 6000));   // дать человеку увидеть, что всё получилось
    } else {
        console.log('⏱️  согласия за 10 минут не случилось. Окно оставляю открытым: доведи вход');
        console.log('   руками, и либо код доедет сам, либо вставь ссылку колбэка во вкладке.');
        await new Promise(resolve => { context.on('close', resolve); process.on('SIGINT', () => context.close().catch(() => {})); });
    }

    try { await context.close(); } catch { /* уже закрыт */ }
    console.log('👋 окно закрыто');
    process.exit(0);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
