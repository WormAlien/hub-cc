'use strict';
/*
 * gh-login.js - довести GitHub-вход до конца: логин, пароль, код 2FA.
 *
 * Зачем модулем, а не копией в чек-ине. Ровно этот сценарий уже живёт дважды - в пробе
 * `_research/ar-gh-autologin-probe.js` и (будет) в `agentrouter/open-session.js`. Урок
 * `totp.js` тот же: две реализации одной формулы расходятся молча, и расхождение видно
 * только тем, что «на одном окне код подходит, на другом нет». Здесь одна на всех.
 *
 * Карта GitHub-входа снята живой пробой 12.10.2026 (след прогона
 * `_research/ar-gh-login-probe-disfiguredli-*.log`), а не выведена из общих соображений:
 *
 *   github.com/login                     →  #login_field И #password на ОДНОЙ странице,
 *                                           подтверждение `input[name="commit"]` один раз
 *   github.com/sessions/two-factor/app   →  #app_totp, и форма уходит САМА на шестой цифре
 *
 * 🔴 Три правила, каждое стоило прогона:
 *   1. Одно подтверждение на две страницы: логин и пароль живут рядом, второй `Sign in`
 *      уезжает в пустоту.
 *   2. Форму 2FA не надо подтверждать кнопкой: страница уходит сама, а нажатие по
 *      исчезнувшему полю роняет прогон уже ПОСЛЕ удачного входа (падение 12.10).
 *   3. Тот же код второй раз не отправляется: GitHub его отвергает. Ждём смены
 *      тридцатисекундного окна - новое значение придёт само.
 *
 * Чего здесь НЕТ намеренно: обхода стенок. Код на почту, капча и «аккаунт помечен» -
 * это остановка с названной причиной, а не повод придумывать обход. Почту купленных
 * аккаунтов (48 из 59 - outlook.com) мы не контролируем вовсе.
 *
 * Успех подтверждает вызывающий (`sessionProbe`) - по НОВОЙ куке `user_session`, а не по
 * адресу: страницы 2FA и колбэка живут на том же хосте, и URL тут ничего не доказывает.
 */

const { totpCode, secondsLeft } = require('./totp.js');

// Селекторы - из живого замера 12.10, порядок = приоритет.
const SEL = {
    login: ['#login_field', 'input[name="login"]', 'input[autocomplete="username"]'],
    pass: ['#password', 'input[name="password"]', 'input[autocomplete="current-password"]'],
    totp: ['#app_totp', 'input[name="app_otp"]', 'input[name="otp"]', 'input[autocomplete="one-time-code"]'],
    submit: ['input[name="commit"]', 'button[type="submit"]', 'input[type="submit"]'],
    totpAlternative: [
        'a[href*="/sessions/two-factor/app"]',
        'a[href*="totp"]',
        'a:has-text("Authenticator app")',
        'a:has-text("authentication app")',
        'a:has-text("Use your authenticator")',
    ],
};

// Стенки. Проверяются по адресу, тексту и адресам iframe разом - капча живёт в iframe и в
// тексте страницы не называется.
const WALLS = [
    { wall: 'device', re: /sessions\/verified-device|device-verification|sent a verification code|verify your device|device verification/i },
    { wall: 'captcha', re: /arkoselabs|funcaptcha|hcaptcha|recaptcha|turnstile/i },
    { wall: 'flagged', re: /account has been flagged|has been suspended|unusual activity detected/i },
];

const WALL_WHY = {
    device: 'GitHub требует подтвердить устройство - код ушёл на почту аккаунта, а почты у нас нет',
    captcha: 'GitHub показал капчу',
    flagged: 'GitHub помечал аккаунт (flagged / suspended / необычная активность)',
    totp_missing: 'GitHub спрашивает код 2FA, а TOTP-секрета в записи нет',
    totp_exhausted: 'GitHub продолжает спрашивать 2FA после допустимого числа кодов',
    origin: 'GitHub-вход ушёл с https://github.com — автоматика остановлена',
};

function githubUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return url.origin === 'https://github.com' ? url : null;
    } catch { return null; }
}
function githubChallengePending(value) {
    const url = githubUrl(value);
    return !!url && (/^\/sessions\/(?:two-factor(?:\/app)?|sudo)(?:\/|$)/.test(url.pathname)
        || url.pathname === '/settings/two_factor_checkup');
}

async function guardedGithubFill(locator, page, value) {
    if (typeof locator.evaluate !== 'function') {
        if (!githubUrl(page.url())) return false;
        await locator.fill(value);
        return !!githubUrl(page.url());
    }
    return locator.evaluate((element, nextValue) => {
        if (location.origin !== 'https://github.com') return false;
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
            : element instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
        const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (!setter || !element.isConnected) return false;
        element.focus();
        setter.call(element, nextValue);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }, value);
}

async function guardedGithubClick(locator, page) {
    if (typeof locator.evaluate !== 'function') {
        if (!githubUrl(page.url())) return false;
        await locator.click({ timeout: 5000 });
        return true;
    }
    return locator.evaluate(element => {
        if (location.origin !== 'https://github.com' || !element.isConnected) return false;
        element.click();
        return true;
    });
}

// Экран account chooser: `github.com/switch_account?return_to=…` («Your accounts»). GitHub
// показывает его, когда в профилеChrome остался другой сохранённый аккаунт и он просит выбрать,
// кем продолжить. Живой случай 04.11: greedybelieve - после пароля открылся выбор, исполнитель
// его не знал, 90 секунд ждал и вернул общий таймаут, а дашборд написал «автоматика пароль и 2FA
// не вводит» - при том что credentials ввёл. Жмём ТОЛЬКО точное совпадение логина: чужой
// аккаунт выбрать нельзя (это вход в чужую учётку), а «выбрать другого» - это форма логина,
// которую цикл и так умеет. Ссылка на аккаунт - кнопка с именем в заголовке формы.
function isSwitchAccount(url) {
    return /github\.com\/switch_account/i.test(String(url || ''));
}

async function pickSwitchAccount(page, login, log, beforeGithubAction) {
    if (!githubUrl(page.url())) return false;
    // Основной путь GitHub рендерит: <form action="/switch_account?…"><button name="target" value="<login>">Continue as …</button></form>
    let used = 'button[name="target"]';
    let loc = page.locator(`button[name="target"][value="${login}"]`).first();
    if (!(await loc.count().catch(() => 0))) {
        // Фолбэк: элемент, в тексте которого наш логин (кнопка/ссылка «Continue as greedybelieve»).
        loc = null; used = null;
        if (typeof page.getByRole === 'function') {
            loc = page.getByRole('button', { name: login, exact: false }).first();
            used = 'button by text';
        }
        if (!loc || !(await loc.count().catch(() => 0))) {
            loc = page.locator(`a:has-text("${login}")`).first();
            used = 'link by text';
        }
    }
    try {
        if (githubUrl(page.url()) && await loc.count() && githubUrl(page.url()) && await loc.isVisible()) {
            if (!githubUrl(page.url())) return false;
            if (beforeGithubAction) await beforeGithubAction('chooser', page);
            if (!githubUrl(page.url())) return false;
            if (!await guardedGithubClick(loc, page)) return false;
            log(`   🔀 account chooser: выбран «${login}» (${used})`);
            return true;
        }
    } catch (e) {
        log(`   ⚠️ account chooser: выбор не нажался: ${String(e.message || e).split('\n')[0]}`);
    }
    return false;
}

/** Первый видимый локатор из списка селекторов или null. */
async function firstVisible(page, list) {
    if (!githubUrl(page.url())) return null;
    for (const sel of list) {
        const loc = page.locator(sel).first();
        try {
            if (!githubUrl(page.url())) return null;
            if (await loc.count() && githubUrl(page.url()) && await loc.isVisible()) {
                if (!githubUrl(page.url())) return null;
                return { loc, sel };
            }
        } catch { /* отвалился между проверками - идём дальше */ }
    }
    return null;
}

/** Текст и адреса iframe со страницы. Не прочиталось - пусто, а не падение. */
async function pageInfo(page) {
    if (!githubUrl(page.url())) return { text: '', iframes: [] };
    try {
        return await page.evaluate(() => ({
            text: document.body ? String(document.body.innerText || '').slice(0, 2000) : '',
            iframes: [...document.querySelectorAll('iframe')].map(f => String(f.src || '')),
        }));
    } catch {
        return { text: '', iframes: [] };
    }
}

/** Какая стенка на странице, или null. */
function detectWall(url, info) {
    const hay = [String(url || ''), (info && info.text) || '', ((info && info.iframes) || []).join(' ')].join('\n');
    for (const w of WALLS) if (w.re.test(hay)) return w.wall;
    return null;
}

async function clickSubmit(page, log, beforeGithubAction) {
    if (!githubUrl(page.url())) return false;
    const sub = await firstVisible(page, SEL.submit);
    if (sub) {
        if (!githubUrl(page.url())) return false;
        const text = (await sub.loc.innerText().catch(() => '')) || (await sub.loc.getAttribute('value').catch(() => '')) || sub.sel;
        if (!githubUrl(page.url())) return false;
        if (beforeGithubAction) await beforeGithubAction('submit', page);
        if (!githubUrl(page.url())) return false;
        const clicked = await guardedGithubClick(sub.loc, page)
            .catch(e => { log(`   ⚠️ подтверждение не нажалось: ${String(e.message || e).split('\n')[0]}`); return false; });
        if (!clicked) return false;
        log(`   🖱️ нажато: «${String(text).trim() || sub.sel}»`);
        return true;
    }
    return false;
}

/**
 * Довести вход. Мутирует страницу; решает по `sessionProbe`.
 *
 * @param page   страница Playwright (нужны url/locator/evaluate/waitForTimeout)
 * @param creds  {login, password, totpSecret}
 * @param opts   {budgetMs, sessionProbe, log, onStep, totpCode, secondsLeft, sleepMs}
 * @returns      {ok:true} | {ok:false, wall, why}
 *
 * `onStep` зовётся раз в такт, ДО действий, и нужен инструменту: проба
 * `_research/ar-gh-autologin-probe.js` снимает им карту страницы (какие поля и кнопки
 * на экране). Так у пробы и у боя один исполнитель - иначе две реализации одной формы
 * расходятся молча, как это уже было с TOTP до `totp.js`.
 */
async function fillGithubLogin(page, creds = {}, opts = {}) {
    const login = String(creds.login || '').trim();
    const password = String(creds.password || '');
    const secret = String(creds.totpSecret || '').trim();
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const onStep = typeof opts.onStep === 'function' ? opts.onStep : null;
    const budgetMs = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 60000;
    const probe = typeof opts.sessionProbe === 'function' ? opts.sessionProbe : null;
    const code = typeof opts.totpCode === 'function' ? opts.totpCode : totpCode;
    const left = typeof opts.secondsLeft === 'function' ? opts.secondsLeft : secondsLeft;
    const sleep = (ms) => page.waitForTimeout(opts.sleepMs || ms);
    const completionUrl = typeof opts.completionUrl === 'function' ? opts.completionUrl : null;
    const beforeGithubAction = typeof opts.beforeGithubAction === 'function' ? opts.beforeGithubAction : null;
    const totpState = opts.totpState && typeof opts.totpState === 'object' ? opts.totpState : {};
    if (!(totpState.usedCodes instanceof Set)) totpState.usedCodes = new Set();
    if (!Number.isSafeInteger(totpState.submissions) || totpState.submissions < 0) totpState.submissions = 0;
    if (!Number.isSafeInteger(totpState.maxSubmissions) || totpState.maxSubmissions < 1) totpState.maxSubmissions = 3;

    const totpOnly = opts.allowTotpOnly === true && secret && githubChallengePending(page.url());
    if (!login || !password && !totpOnly) {
        return { ok: false, wall: null, why: 'в записи нет логина или пароля - заполнять нечем' };
    }

    let filledLogin = false, filledPass = false, lastCode = null, steps = 0;
    let switchHandled = false, retriesAfterSubmit = 0;
    const deadline = Date.now() + budgetMs;
    const started = Date.now();

    while (Date.now() < deadline) {
        const href = page.url();
        if (!githubUrl(href)) {
            if (completionUrl && completionUrl(href) && probe && await probe()) return { ok: true };
            return { ok: false, wall: 'origin', why: WALL_WHY.origin };
        }
        if (probe && await probe()) return { ok: true };
        if (onStep) await onStep({ step: ++steps, url: page.url() });
        if (!githubUrl(page.url())) return { ok: false, wall: 'origin', why: WALL_WHY.origin };
        // Account chooser: выбрать НАШ логин ровно один раз. Повторная попытка на той же
        // странице - цикл, поэтому после первой попытки экран либо уходит, либо это стенка.
        if (!switchHandled && isSwitchAccount(page.url())) {
            switchHandled = true;
            await pickSwitchAccount(page, login, log, beforeGithubAction);
            await sleep(2500);
            continue;
        }
        // Стенку проверяем ПЕРВОЙ: пока она на экране, любые нажатия только вредят.
        const wall = detectWall(page.url(), await pageInfo(page));
        if (wall) return { ok: false, wall, why: WALL_WHY[wall] || 'стенка' };

        const loginF = await firstVisible(page, SEL.login);
        const passF = await firstVisible(page, SEL.pass);
        const totpF = await firstVisible(page, SEL.totp);

        const current = githubUrl(page.url());
        if (secret && !totpF && current && current.pathname.startsWith('/sessions/sudo')) {
            const alternative = await firstVisible(page, SEL.totpAlternative);
            if (alternative) {
                if (!githubUrl(page.url())) return { ok: false, wall: 'origin', why: WALL_WHY.origin };
                if (beforeGithubAction) await beforeGithubAction('sudo-alternative', page);
                if (!githubUrl(page.url())) return { ok: false, wall: 'origin', why: WALL_WHY.origin };
                if (!await guardedGithubClick(alternative.loc, page)) {
                    return { ok: false, wall: 'origin', why: WALL_WHY.origin };
                }
                log('   🔑 sudo: выбран вход через authenticator app');
                await sleep(1000);
                continue;
            }
            if (!githubUrl(page.url())) return { ok: false, wall: 'origin', why: WALL_WHY.origin };
            await page.goto('https://github.com/sessions/two-factor/app', { waitUntil: 'domcontentloaded' }).catch(() => {});
            await sleep(1000);
            continue;
        }

        // После submit поля могут исчезнуть на мгновение (переход, POST /session). Это
        // НЕ успех и НЕ стенка: если формы нет дольше пары секунд, страницу перезагружаем -
        // GitHub иногда отвечает на POST /session ошибкой 500 (живой случай 04.11:
        // greedybelieve - Sign in нажат, /session отдал «Server Error», модуль ждал до конца
        // бюджета). Ровно две перезагрузки, дальше действительно сдаёмся.
        //
        // 🔴 Но НЕ на странице согласия OAuth. Живой случай 24.11 (freegg/ciciaidiltaslim):
        // пароль и 2FA приняты, GitHub увёл на `/login/oauth/authorize`, полей входа там нет -
        // и эта ветка дважды перезагружала `/login`, выбрасывая готовый вход. Со стороны это
        // выглядело как «GitHub вошёл, но страница крутится и на freegg не идёт». Согласие
        // обрабатывает вызывающий; на нём перезагрузка запрещена.
        const atCompletion = (completionUrl && completionUrl(page.url()))
            || (current && current.pathname === '/login/oauth/authorize');
        if (!loginF && !passF && !totpF && filledLogin && !atCompletion && retriesAfterSubmit < 2) {
            retriesAfterSubmit++;
            log(`   ↻ поля исчезли после submit (попытка ${retriesAfterSubmit}/2) - перезагружаю /login`);
            await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
            await sleep(2500);
            continue;
        }

        if (loginF || passF) {
            if (loginF && !filledLogin) {
                if (!githubUrl(page.url())) return { ok: false, wall: 'origin', why: WALL_WHY.origin };
                if (beforeGithubAction) await beforeGithubAction('login-fill', page);
                if (!githubUrl(page.url())) return { ok: false, wall: 'origin', why: WALL_WHY.origin };
                if (!await guardedGithubFill(loginF.loc, page, login)) {
                    return { ok: false, wall: 'origin', why: WALL_WHY.origin };
                }
                log(`   ✍️ логин «${login}» вписан`);
                filledLogin = true;
            }
            if (passF && !filledPass) {
                if (!githubUrl(page.url())) return { ok: false, wall: 'origin', why: WALL_WHY.origin };
                if (beforeGithubAction) await beforeGithubAction('password-fill', page);
                if (!githubUrl(page.url())) return { ok: false, wall: 'origin', why: WALL_WHY.origin };
                if (!await guardedGithubFill(passF.loc, page, password)) {
                    return { ok: false, wall: 'origin', why: WALL_WHY.origin };
                }
                log(`   ✍️ пароль вписан (${password.length} симв., значение в лог не пишу)`);
                filledPass = true;
            }
            // Подтверждение ОДНО на два поля: см. правило 1 в шапке.
            await clickSubmit(page, log, beforeGithubAction);
            await sleep(2500);
            continue;
        }

        if (totpF) {
            if (!secret) return { ok: false, wall: 'totp_missing', why: WALL_WHY.totp_missing };
            if (totpState.submissions >= totpState.maxSubmissions) {
                return { ok: false, wall: 'totp_exhausted', why: WALL_WHY.totp_exhausted };
            }
            const now = code(secret);
            if (!now) return { ok: false, wall: 'totp_missing', why: 'TOTP-секрет не разбирается' };
            if (totpState.usedCodes.has(now) || now === lastCode) {
                // Тот же код второй раз GitHub отвергает: ждём смены окна (правило 3).
                log('   ⏳ жду смены окна кода - повтор не отправляю');
                await sleep(1500);
                continue;
            }
            if (!githubUrl(page.url())) return { ok: false, wall: 'origin', why: WALL_WHY.origin };
            if (beforeGithubAction) await beforeGithubAction('totp-fill', page);
            if (!githubUrl(page.url())) return { ok: false, wall: 'origin', why: WALL_WHY.origin };
            try {
                if (!await guardedGithubFill(totpF.loc, page, now)) {
                    return { ok: false, wall: 'origin', why: WALL_WHY.origin };
                }
            }
            catch { await sleep(500); continue; }
            lastCode = now;
            totpState.usedCodes.add(now);
            totpState.submissions++;
            log(`   🔑 код 2FA вписан, до смены окна ${left()} с`);
            await sleep(700);
            // 🔴 Самопереход формы (правило 2): жмём, только если поле ещё на экране.
            if (await totpF.loc.isVisible().catch(() => false)) await clickSubmit(page, log, beforeGithubAction);
            else log('   ⚡ форму отправила сама страница - кнопку не жму');
            await sleep(3000);
            continue;
        }

        await sleep(1000);
    }

    const spent = Math.round((Date.now() - started) / 1000);
    return { ok: false, wall: null, why: `вход не подтвердился за ${spent} с` };
}

module.exports = { fillGithubLogin, detectWall, firstVisible, SEL, WALLS, WALL_WHY, isSwitchAccount,
    pickSwitchAccount, githubUrl, githubChallengePending, guardedGithubFill, guardedGithubClick };
