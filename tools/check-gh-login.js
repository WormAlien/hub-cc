#!/usr/bin/env node
// Автологин GitHub в чек-ине AgentRouter: логин, пароль, код 2FA.
//
// Зачем файл. Живая проба 12.10 (`_research/ar-gh-autologin-probe.js`) доказала, что шлюз
// пускает по паролю и TOTP: кода на почту и капчи GitHub не спросил. Но в боевом пути
// автологина НЕТ вовсе - `passGithubGate()` на `github.com/login` сразу возвращает `'dead'`,
// и аккаунт уезжает в человеческий вход. Цена: сессия GitHub живёт 14 суток, и каждый, кто
// её потерял, ждёт человека (так встал `disfiguredli`).
//
// Файл проверяет поведение боевой функции на поддельной странице, а не грепает текст. Три
// правила взяты из живого прогона и нарушаются молча:
//   1. логин и пароль стоят на ОДНОЙ странице - подтверждать надо ОДИН раз, иначе второй
//      `Sign in` уезжает в пустоту;
//   2. 🔴 форма 2FA уходит САМА на шестой цифре - нажатие `Verify` по исчезнувшему полю
//      уронило пробу 12.10 ровно на удачном входе;
//   3. код нельзя слать дважды - GitHub отвергает повтор, ждём смены тридцатисекундного окна.
//
// Запуск: node tools/check-gh-login.js

'use strict';

const path = require('path');

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};

const MOD_PATH = path.join(__dirname, '..', 'routing', 'lib', 'gh-login.js');
let mod = null;
try { mod = require(MOD_PATH); } catch { /* модуля нет - это и есть краснота на HEAD */ }

console.log('\n0. модуль на месте');
check(!!mod, 'routing/lib/gh-login.js существует и грузится');
check(!!mod && typeof mod.fillGithubLogin === 'function', 'экспортирует fillGithubLogin');
if (!mod) {
    console.log('\n× модуля нет: автологина в боевом пути не существует. Краснота ожидаема.\n');
    process.exit(1);
}
const { fillGithubLogin, SEL } = mod;

// ── поддельная страница ────────────────────────────────────────────────────
// Экраны идут по сценарию; переход на следующий случается по submit (click/press), а
// `vanishOnFill` воспроизводит самопереход формы 2FA.
function makePage(script) {
    let i = 0, vanished = false;
    const log = [];
    const cur = () => script[Math.min(i, script.length - 1)];
    const visible = (sel) => {
        if (vanished) return false;
        const s = cur();
        if (sel === 'input[name="commit"]' || sel === 'button[type="submit"]') return !!s.submit;
        return (s.fields || []).some(f => sel.startsWith(f) || sel.includes(f));
    };
    const advance = () => { i++; vanished = false; };
    const elem = (sel) => ({
        count: async () => (visible(sel) ? 1 : 0),
        isVisible: async () => visible(sel),
        fill: async (v) => { log.push(['fill', sel, v]); if (cur().vanishOnFill && sel.includes('totp')) vanished = true; },
        click: async () => { log.push(['click', sel]); try { cur().onSubmit && cur().onSubmit(log); } catch { /* сценарий */ } advance(); },
        press: async () => { log.push(['press', sel]); advance(); },
        innerText: async () => 'Sign in',
        inputValue: async () => '',
    });
    return {
        _log: log,
        _screen: () => cur(),
        _vanished: () => vanished,
        url: () => cur().url || 'https://github.com/login',
        waitForTimeout: async () => {},
        locator: (sel) => ({ first: () => elem(sel) }),
        evaluate: async () => ({ text: cur().text || '', iframes: cur().iframes || [] }),
    };
}

const CREDS = { login: 'disfiguredli', password: 'SuperSecret123', totpSecret: 'JBSWY3DPEHPK3PXP' };
const RUN = { budgetMs: 5000, log: () => {}, totpCode: () => '123456', secondsLeft: () => 20 };

// Сравниваем по ПОДСТРОКЕ селектора: тест не должен знать, какой именно из списка
// селекторов выбрал модуль (#login_field или input[name="login"]) - это его дело.
const fills = (p, key) => p._log.filter(l => l[0] === 'fill' && l[1].includes(key)).map(l => l[2]);
const clicks = (p, sel) => p._log.filter(l => l[0] === 'click' && l[1] === sel).length;

(async () => {
    // ── 1. одна страница на логин и пароль, одно подтверждение ──
    console.log('\n1. логин и пароль на одной странице - подтверждение ОДНО');
    {
        const p = makePage([
            { fields: ['login', 'password'], submit: true, url: 'https://github.com/login' },
            { fields: ['totp'], submit: true, url: 'https://github.com/sessions/two-factor/app' },
        ]);
        let probed = false;
        const res = await fillGithubLogin(p, CREDS, {
            ...RUN, sessionProbe: async () => { probed = true; return probed && clicks(p, 'input[name="commit"]') >= 1; },
        });
        check(fills(p, 'login').includes(CREDS.login), 'логин вписан');
        check(fills(p, 'password').includes(CREDS.password), 'пароль вписан');
        check(clicks(p, 'input[name="commit"]') === 1, `submit логина и пароля нажат РОВНО раз (нажатий: ${clicks(p, 'input[name="commit"]')})`);
        check(res.ok === true, 'вход зачтён по sessionProbe');
    }

    // ── 2. код 2FA вписан в поле второй страницы ──
    console.log('\n2. код 2FA вписывается после перехода на страницу 2FA');
    {
        const p = makePage([
            { fields: ['login', 'password'], submit: true, url: 'https://github.com/login' },
            { fields: ['totp'], submit: true, url: 'https://github.com/sessions/two-factor/app' },
        ]);
        await fillGithubLogin(p, CREDS, { ...RUN, sessionProbe: async () => false });
        check(fills(p, 'totp').includes('123456'), 'код из секрета вписан в поле 2FA');
    }

    // ── 3. 🔴 самоотправка формы 2FA: не жать Verify по исчезнувшему полю ──
    console.log('\n3. форма 2FA ушла сама - кнопку НЕ жмут и не падают');
    {
        const p = makePage([
            { fields: ['login', 'password'], submit: true, url: 'https://github.com/login' },
            { fields: ['totp'], submit: true, vanishOnFill: true, url: 'https://github.com/sessions/two-factor/app' },
            { fields: [], submit: false, url: 'https://github.com/' },
        ]);
        // Проба подтверждает вход РОВНО после самоотправки формы - то есть проверяем путь,
        // на котором проба 12.10 и упала.
        const res = await fillGithubLogin(p, CREDS, { ...RUN, sessionProbe: async () => p._vanished() });
        check(clicks(p, 'button[type="submit"]') === 0, 'Verify не нажат: поле уже исчезло');
        check(res.ok === true, 'вход всё равно зачтён (форма отправилась сама)');
    }

    // ── 4. тот же код дважды не отправляется ──
    console.log('\n4. повтор того же кода не отправляется');
    {
        const p = makePage([
            { fields: ['login', 'password'], submit: true, url: 'https://github.com/login' },
            { fields: ['totp'], submit: true, url: 'https://github.com/sessions/two-factor/app' },
        ]);
        await fillGithubLogin(p, CREDS, { ...RUN, secondsLeft: () => 20, sessionProbe: async () => false });
        check(fills(p, 'totp').length === 1, `код вписан один раз, а не в цикле (раз: ${fills(p, 'totp').length})`);
    }

    // ── 5. нет секрета 2FA - не гадаем ──
    console.log('\n5. без TOTP-секрета прогон останавливается с причиной');
    {
        const p = makePage([
            { fields: ['login', 'password'], submit: true, url: 'https://github.com/login' },
            { fields: ['totp'], submit: true, url: 'https://github.com/sessions/two-factor/app' },
        ]);
        const res = await fillGithubLogin(p, { ...CREDS, totpSecret: '' }, { ...RUN, sessionProbe: async () => false });
        check(res.ok === false, 'вход не объявлен состоявшимся');
        check(res.wall === 'totp_missing', `причина названа (wall=${res.wall})`);
        check(fills(p, 'totp').length === 0, 'в поле кода ничего не вписано');
    }

    // ── 6. нет пароля - вообще не начинаем ──
    console.log('\n6. без пароля форма не заполняется');
    {
        const p = makePage([{ fields: ['login', 'password'], submit: true, url: 'https://github.com/login' }]);
        const res = await fillGithubLogin(p, { ...CREDS, password: '' }, { ...RUN, sessionProbe: async () => false });
        check(res.ok === false, 'вход не состоялся');
        check(fills(p, 'login').length === 0 && fills(p, 'password').length === 0, 'ничего не вписано');
        check(/парол/i.test(res.why || ''), 'причина говорит про пароль');
    }

    // ── 7. стенка «подтвердите устройство» ──
    console.log('\n7. стенка device verification распознаётся и форма не долбится');
    {
        const p = makePage([
            { fields: ['login', 'password'], submit: true, url: 'https://github.com/login' },
            { fields: [], submit: true, url: 'https://github.com/sessions/verified-device', text: 'We sent a verification code to your email' },
        ]);
        const res = await fillGithubLogin(p, CREDS, { ...RUN, sessionProbe: async () => false });
        check(res.ok === false, 'вход не объявлен состоявшимся');
        check(res.wall === 'device', `стенка названа (wall=${res.wall})`);
        check(fills(p, 'totp').length === 0, 'код в поле стенки не вписывается');
    }

    // ── 8. капча ──
    console.log('\n8. капча распознаётся');
    {
        const p = makePage([
            { fields: ['login', 'password'], submit: true, url: 'https://github.com/login' },
            { fields: [], submit: false, iframes: ['https://github.com/arkoselabs'], text: 'Verify you are human' },
        ]);
        const res = await fillGithubLogin(p, CREDS, { ...RUN, sessionProbe: async () => false });
        check(res.wall === 'captcha', `капча названа (wall=${res.wall})`);
    }

    // ── 9. пароль не уходит в лог ──
    console.log('\n9. пароль не попадает в лог');
    {
        const said = [];
        const p = makePage([
            { fields: ['login', 'password'], submit: true, url: 'https://github.com/login' },
            { fields: ['totp'], submit: true, url: 'https://github.com/sessions/two-factor/app' },
        ]);
        await fillGithubLogin(p, CREDS, { ...RUN, log: (s) => said.push(String(s)), sessionProbe: async () => false });
        check(!said.join('\n').includes(CREDS.password), 'значение пароля в лог не попало');
        check(!said.join('\n').includes(CREDS.totpSecret), 'значение TOTP-секрета в лог не попало');
    }

    // ── 10. успех подтверждает sessionProbe, а не URL ──
    console.log('\n10. успех определяется sessionProbe, а не адресом страницы');
    {
        const p = makePage([
            { fields: ['login', 'password'], submit: true, url: 'https://github.com/login' },
            { fields: ['totp'], submit: true, url: 'https://github.com/sessions/two-factor/app' },
        ]);
        let calls = 0;
        const res = await fillGithubLogin(p, CREDS, { ...RUN, sessionProbe: async () => (++calls > 1) });
        check(res.ok === true, 'вход зачтён, хотя адрес остался страницей 2FA');
    }

    // ── 11. таблицы селекторов - боевые ──
    console.log('\n11. селекторы совпадают с живым замером 12.10');
    {
        check(SEL.login.includes('#login_field'), 'поле логина: #login_field');
        check(SEL.pass.includes('#password'), 'поле пароля: #password');
        check(SEL.totp.includes('#app_totp'), 'поле кода: #app_totp');
        check(SEL.submit.includes('input[name="commit"]'), 'подтверждение: input[name="commit"]');
    }

    console.log(fail ? `\n× провалено проверок: ${fail}\n` : '\n· все проверки пройдены\n');
    process.exit(fail ? 1 : 0);
})();
