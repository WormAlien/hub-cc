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
};

/** Первый видимый локатор из списка селекторов или null. */
async function firstVisible(page, list) {
    for (const sel of list) {
        const loc = page.locator(sel).first();
        try {
            if (await loc.count() && await loc.isVisible()) return { loc, sel };
        } catch { /* отвалился между проверками - идём дальше */ }
    }
    return null;
}

/** Текст и адреса iframe со страницы. Не прочиталось - пусто, а не падение. */
async function pageInfo(page) {
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

async function clickSubmit(page, log) {
    const sub = await firstVisible(page, SEL.submit);
    if (sub) {
        const text = (await sub.loc.innerText().catch(() => '')) || (await sub.loc.getAttribute('value').catch(() => '')) || sub.sel;
        await sub.loc.click({ timeout: 5000 }).catch(e => log(`   ⚠️ подтверждение не нажалось: ${String(e.message || e).split('\n')[0]}`));
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

    if (!login || !password) {
        return { ok: false, wall: null, why: 'в записи нет логина или пароля - заполнять нечем' };
    }

    let filledLogin = false, filledPass = false, lastCode = null, steps = 0;
    const deadline = Date.now() + budgetMs;
    const started = Date.now();

    while (Date.now() < deadline) {
        if (probe && await probe()) return { ok: true };
        if (onStep) await onStep({ step: ++steps, url: page.url() });
        // Стенку проверяем ПЕРВОЙ: пока она на экране, любые нажатия только вредят.
        const wall = detectWall(page.url(), await pageInfo(page));
        if (wall) return { ok: false, wall, why: WALL_WHY[wall] || 'стенка' };

        const loginF = await firstVisible(page, SEL.login);
        const passF = await firstVisible(page, SEL.pass);
        const totpF = await firstVisible(page, SEL.totp);

        if (loginF || passF) {
            if (loginF && !filledLogin) {
                await loginF.loc.fill(login);
                log(`   ✍️ логин «${login}» вписан`);
                filledLogin = true;
            }
            if (passF && !filledPass) {
                await passF.loc.fill(password);
                log(`   ✍️ пароль вписан (${password.length} симв., значение в лог не пишу)`);
                filledPass = true;
            }
            // Подтверждение ОДНО на два поля: см. правило 1 в шапке.
            await clickSubmit(page, log);
            await sleep(2500);
            continue;
        }

        if (totpF) {
            if (!secret) return { ok: false, wall: 'totp_missing', why: WALL_WHY.totp_missing };
            const now = code(secret);
            if (!now) return { ok: false, wall: 'totp_missing', why: 'TOTP-секрет не разбирается' };
            if (now === lastCode) {
                // Тот же код второй раз GitHub отвергает: ждём смены окна (правило 3).
                log('   ⏳ жду смены окна кода - повтор не отправляю');
                await sleep(1500);
                continue;
            }
            await totpF.loc.fill(now).catch(() => {});
            lastCode = now;
            log(`   🔑 код 2FA вписан, до смены окна ${left()} с`);
            await sleep(700);
            // 🔴 Самопереход формы (правило 2): жмём, только если поле ещё на экране.
            if (await totpF.loc.isVisible().catch(() => false)) await clickSubmit(page, log);
            else log('   ⚡ форму отправила сама страница - кнопку не жму');
            await sleep(3000);
            continue;
        }

        if (probe && await probe()) return { ok: true };
        await sleep(1000);
    }

    const spent = Math.round((Date.now() - started) / 1000);
    return { ok: false, wall: null, why: `вход не подтвердился за ${spent} с` };
}

module.exports = { fillGithubLogin, detectWall, firstVisible, SEL, WALLS, WALL_WHY };
