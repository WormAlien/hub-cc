#!/usr/bin/env node
// Автоподарок AgentRouter: прогон не должен состоять из фиксированных таймаутов (10.09).
//
// Было (первый инструментированный прогон, метки времени от старта скрипта):
//   [+0.0s]  🚀 Запускаю Chromium
//   [+0.8s]  🐙 GitHub-сессия: 5 кук в профиле
//   [+5.5s]  📌 эталон до подарка снять НЕ УДАЛОСЬ          ← 4.7 с впустую
//   [+6.3s]  🚪 вышел через меню профиля
//   [+21.3s] ⚠️  попап не появился — собираю authorize-URL   ← 15 с впустую
//   [+22.1s] ❌ Не нашёл, чем начать GitHub-вход
// Сам Chromium поднимается за 0.8 с, удачный прогон ~19 с — а НЕудачный целиком
// состоял из ожиданий того, чего не будет. Второй случай, сессия мертва на сервере:
// goto(/console/topup) уводит на /login, но код всё равно искал аватар в шапке с
// потолком 15 с, потому что hasSessionCookie видит ПРОТУХШУЮ куку и раннего выхода
// не делает. 57 с против 19 с.
//
// Стало: ждём не «сколько не жалко», а до ПРИЗНАКА, что ждать больше нечего —
//   · consoleGate         — гонка «аватар / SPA увела на /login» вместо потолка 15 с;
//   · watchOauthState     — попап открывается только после годного /api/oauth/state,
//                           отказ на нём = приговор, ждать попап дальше бессмысленно;
//   · Promise.any на кнопках — два кандидата ждутся разом, а не по 10 с подряд;
//   · браузер после перелогина не ждёт и не снимает баланс: точная проверка идёт после
//     закрытия окна обычным cookie/raw-auth путём.
// Плюс честный отказ: пустое тело от ПУБЛИЧНОЙ /api/status — это рейт-лимит/WAF по IP
// (код 6), а не «шлюз переделал страницу входа» (код 4).
//
// Живой браузер не поднимается: блоки вырезаются из исходника и исполняются с
// подставными зависимостями — тот же приём, что в tools/check-ar-gh-fallback.js.
//
// Запуск: node tools/check-checkin-speed.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'agentrouter', 'open-session.js');
const SESS = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};
const cutFn = (src, head) => {
    const i = src.indexOf(head);
    if (i < 0) return '';
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? undefined : j + 2);
};
const cutRange = (src, from, to) => {
    const i = src.indexOf(from);
    const j = src.indexOf(to, i + 1);
    return i < 0 || j <= i ? '' : src.slice(i, j);
};
const num = (name) => {
    const m = SESS.match(new RegExp(`const ${name} = (\\d+)`));
    return m ? Number(m[1]) : NaN;
};
// Подставная страница: url() читается на каждом опросе, waitForTimeout — настоящий сон.
const fakePage = (url) => {
    const p = {
        _url: url,
        url: () => p._url,
        waitForTimeout: (ms) => new Promise(r => setTimeout(r, ms)),
    };
    return p;
};

async function main() {
    // ── 1. потолки: короткие и вынесены в константы ──
    console.log('\n1. фиксированные ожидания стали константами и укоротились');
    const GATE = num('CONSOLE_GATE_MS');
    const POPUP = num('GH_POPUP_WAIT_MS');
    const BTN = num('GH_BTN_WAIT_MS');
    check(Number.isFinite(GATE) && GATE <= 10000, `CONSOLE_GATE_MS = ${GATE} мс (было 15000 на аватар)`);
    check(Number.isFinite(POPUP) && POPUP <= 8000, `GH_POPUP_WAIT_MS = ${POPUP} мс (было 15000)`);
    check(Number.isFinite(BTN) && BTN <= 10000, `GH_BTN_WAIT_MS = ${BTN} мс на ОБА кандидата (было 10000 на каждого)`);
    check(!/BASELINE_SELF_MS|readBaselineSelf\(/.test(SESS),
        'браузерный baseline/self-fetch полностью убран из speed-critical пути');
    const click = cutFn(SESS, 'async function clickGithubLogin(');
    check(!/timeout: 15000/.test(click) && !/timeout: 10000/.test(click),
        'в clickGithubLogin не осталось зашитых 10/15 с');
    check(/Promise\.any\(/.test(click), 'кандидаты кнопки ждутся одновременно (Promise.any), а не по очереди');
    const uiLogout = cutFn(SESS, 'async function uiLogout(');
    check(!/timeout: 15000/.test(uiLogout), 'ожидание аватара с потолком 15 с из uiLogout убрано');
    // Арифметика худшего случая — ради неё всё и делалось.
    const oldWorst = 15000 /* аватар */ + 4700 /* эталон */ + 10000 * 2 /* два кандидата */ + 15000 /* попап */;
    const newWorst = GATE + BTN + POPUP;
    check(newWorst < oldWorst / 2,
        `худший случай фиксированных ожиданий: было ~${(oldWorst / 1000).toFixed(1)} с → стало ${(newWorst / 1000).toFixed(1)} с`);

    // ── 2. разлогин: выходить не из чего — не выходим ──
    console.log('\n2. ранний выход из разлогина (сессия мертва на сервере)');
    check(/consoleGate\(/.test(uiLogout), 'uiLogout спрашивает consoleGate, а не ждёт аватар вслепую');
    check(!/readBaselineSelf\(|BASELINE_SELF_MS/.test(uiLogout),
        'uiLogout не запускает браузерный baseline/self-fetch');
    check(/gate === 'login'[\s\S]*?return true/.test(uiLogout),
        'вердикт «уже на странице входа» = выход прошёл, фолбэк с удалением кук не зовётся');
    check(/purgeSiteCookies\(context, page\)[\s\S]*?уже мертва/.test(uiLogout)
        || /уже мертва[\s\S]{0,400}?return true/.test(uiLogout),
        'мёртвая кука с диска убирается — иначе точный баланс примет её за живую сессию');
    check(!/BASELINE_SELF_MS|readBaselineSelf\(/.test(SESS),
        'browser baseline/self-fetch is absent from the implementation');
    check(!/watchSelfResponses\(|reloadForFreshSelf\(|captureSelfSnapshot\(|waitBalanceRendered\(|GIFT_RELOAD_ATTEMPTS|GIFT_TOTAL_BUDGET_MS/.test(SESS),
        'browser balance-wait machinery and snapshot capture are absent');

    {
        const block = cutRange(SESS, 'const AUTH_PAGE_RE =', '// Выход через меню профиля');
        if (!block) { check(false, 'блок consoleGate найден в исходнике'); }
        else {
            const { consoleGate } = new Function('deps', `
                const { CONSOLE_GATE_MS } = deps;
                ${block}
                return { consoleGate };
            `)({ CONSOLE_GATE_MS: 600 });

            const dead = fakePage('https://agentrouter.org/login');
            let t = Date.now();
            check(await consoleGate(dead, { isVisible: async () => false }) === 'login'
                && Date.now() - t < 400, 'страница входа распознаётся сразу, без ожидания аватара');

            // 🪤 Главный случай: редирект КЛИЕНТСКИЙ, сразу после goto url ещё старый.
            const late = fakePage('https://agentrouter.org/console/topup');
            setTimeout(() => { late._url = 'https://agentrouter.org/login'; }, 350);
            t = Date.now();
            const lateVerdict = await consoleGate(late, { isVisible: async () => false });
            check(lateVerdict === 'login' && Date.now() - t < 1200,
                'редирект, приехавший позже goto, всё равно ловится (опрос, а не одна проверка)');

            const live = fakePage('https://agentrouter.org/console/topup');
            let seen = 0;
            t = Date.now();
            check(await consoleGate(live, { isVisible: async () => ++seen > 2 }) === 'live'
                && Date.now() - t < 1200, 'живая сессия: аватар появился — идём выходить');

            const white = fakePage('https://agentrouter.org/console/topup');
            t = Date.now();
            const took = (await consoleGate(white, { isVisible: async () => false }), Date.now() - t);
            check(took < 1600, `белый экран не ждётся дольше бюджета (${took} мс на бюджете 600 мс)`);
        }
    }

    // ── 3. попап: ждём до приговора, а не до потолка ──
    console.log('\n3. ожидание попапа GitHub');
    {
        const block = cutRange(SESS, 'const OAUTH_STATE_RE =', '// Шлюз встречает модалкой');
        if (!block) { check(false, 'блок watchOauthState/awaitGithubPopup найден в исходнике'); }
        else {
            const said = [];
            const { watchOauthState, awaitGithubPopup } = new Function('deps', `
                const { console, GH_POPUP_WAIT_MS } = deps;
                ${block}
                return { watchOauthState, awaitGithubPopup };
            `)({ console: { log: (s) => said.push(String(s)) }, GH_POPUP_WAIT_MS: 600 });

            const mkPage = () => {
                const hs = [];
                return { on: (_, h) => hs.push(h), off: () => {}, waitForTimeout: (ms) => new Promise(r => setTimeout(r, ms)), _fire: (r) => Promise.all(hs.map(h => h(r))) };
            };
            const resp = (url, body, status = 200) => ({ url: () => url, status: () => status, text: async () => body });

            const p1 = mkPage();
            const w1 = watchOauthState(p1);
            await p1._fire(resp('https://agentrouter.org/api/user/self', '{"success":true}'));
            check(w1.out.seen === false, 'чужие ответы вердикт не выносят — сторожим только /api/oauth/state');
            await p1._fire(resp('https://agentrouter.org/api/oauth/state?mode=login', ''));
            check(w1.out.done && w1.out.ok === false && /не JSON/.test(w1.out.note),
                'пустое тело на /api/oauth/state = отказ, и в логе сказано почему');

            const p2 = mkPage();
            const w2 = watchOauthState(p2);
            await p2._fire(resp('https://agentrouter.org/api/oauth/state?mode=login', '{"success":true,"data":"st-1"}'));
            check(w2.out.done && w2.out.ok === true, 'годный state — вердикт «попап будет»');

            // Контекст, который НИКОГДА не отдаст попап: ровно случай замера 10.09.
            const deafCtx = { waitForEvent: (_n, o) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), o.timeout).unref()) };
            let t = Date.now();
            const got = await awaitGithubPopup(deafCtx, fakePage('x'), w1);
            check(got === null && Date.now() - t < 400,
                'отказ на state → бросаем ждать попап немедленно (раньше это стоило 15 с)');
            check(said.some(s => /попапа не будет/.test(s)), 'в логе объяснено, почему перестали ждать');

            const popup = { marker: 'popup' };
            const liveCtx = { waitForEvent: () => new Promise(r => setTimeout(() => r(popup), 150)) };
            t = Date.now();
            check(await awaitGithubPopup(liveCtx, fakePage('x'), w2) === popup && Date.now() - t < 900,
                'попап пришёл — возвращаем его, ничего не сломав');

            // Вердикта нет вообще (запрос повис) — работает потолок, и он короткий.
            const mute = { out: { seen: false, done: false, ok: false, note: '' } };
            t = Date.now();
            const capped = await awaitGithubPopup(deafCtx, fakePage('x'), mute);
            const took = Date.now() - t;
            check(capped === null && took >= 500 && took < 1600,
                `без вердикта ждём ровно бюджет (${took} мс на бюджете 600 мс)`);
        }
    }

    // ── 4. честный отказ: молчащий край ≠ переделанная вёрстка ──
    console.log('\n4. диагноз отказа называет вещи своими именами');
    {
        const body = cutFn(SESS, 'async function buildAuthorizeUrl(');
        if (!body) { check(false, 'buildAuthorizeUrl найдена в исходнике'); }
        else {
            const { buildAuthorizeUrl } = new Function(`${body}\nreturn { buildAuthorizeUrl };`)();
            // page.evaluate исполняем прямо здесь, подсунув браузерные глобалы.
            const run = async (routes, aff = null) => {
                const savedF = global.fetch, savedLS = global.localStorage;
                global.fetch = async (u) => {
                    const r = routes[String(u).split('?')[0]];
                    if (!r) throw new Error('нет маршрута ' + u);
                    return { status: r.status || 200, text: async () => r.body };
                };
                const bag = aff ? { aff } : {};
                global.localStorage = { getItem: (k) => (k in bag ? bag[k] : null), setItem: (k, v) => { bag[k] = v; } };
                try { return await buildAuthorizeUrl({ evaluate: (fn) => fn() }); }
                finally { global.fetch = savedF; global.localStorage = savedLS; }
            };
            const okStatus = { body: '{"success":true,"data":{"github_client_id":"CID42"}}' };

            const silent = await run({ '/api/status': { body: '', status: 200 } });
            check(silent.why === 'edge-silent' && /\/api\/status/.test(silent.detail),
                `пустое тело публичной /api/status = «край не ответил» (${silent.detail})`);

            const html = await run({ '/api/status': { body: '<html>waf</html>', status: 200 } });
            check(html.why === 'edge-silent', 'HTML-заглушка WAF — тоже молчащий край, а не вёрстка');

            const noCid = await run({ '/api/status': { body: '{"success":true,"data":{}}' } });
            check(noCid.why === 'no-client-id',
                'край ОТВЕТИЛ, но без github_client_id — вот это уже «переделали вход»');

            const stateSilent = await run({ '/api/status': okStatus, '/api/oauth/state': { body: '', status: 429 } });
            check(stateSilent.why === 'edge-silent' && /429/.test(stateSilent.detail),
                'молчащий /api/oauth/state тоже читается как рейт-лимит, а не как вёрстка');

            const noState = await run({ '/api/status': okStatus, '/api/oauth/state': { body: '{"success":false,"message":"too many requests"}' } });
            check(noState.why === 'no-state' && /too many requests/.test(noState.detail),
                'отказ словами доезжает до владельца дословно');

            const good = await run({ '/api/status': okStatus, '/api/oauth/state': { body: '{"success":true,"data":"ST-7"}' } }, 'AFF9');
            check(/client_id=CID42/.test(good.url || '') && /state=ST-7/.test(good.url || '')
                && /scope=user:email/.test(good.url || ''), 'happy path не сломан: authorize-URL собирается как раньше');

            const boom = await buildAuthorizeUrl({ evaluate: async () => { throw new Error('Target closed'); } });
            check(boom.why === 'error' && /Target closed/.test(boom.detail),
                'исключение из страницы — тоже причина, а не молчаливый null');
        }
    }

    console.log('\n5. код возврата отделён от текста');
    const auto = cutRange(SESS, 'const target = await clickGithubLogin(context, page);', '🔄 GitHub-часть');
    check(/edge-silent[\s\S]*?process\.exit\(6\)/.test(auto), 'молчащий край → код 6');
    check(/process\.exit\(4\)/.test(auto), 'переделанный вход остаётся кодом 4');
    check(auto.indexOf('process.exit(6)') < auto.indexOf('process.exit(4)'),
        'сначала отсекается край, и только потом обвиняется вёрстка');
    {
        const six = cutRange(auto, 'edge-silent', 'process.exit(6)');
        check(/рейт-лимит/.test(six) && !/переделал/.test(six),
            'в тексте кода 6 нет слова «переделал» — это неверный диагноз');
    }
    check(/\/\/\s+6 = край не ответил/.test(SESS), 'код 6 описан в шапке файла рядом с остальными');
    check(/AR_AUTO_CHECKIN_FAIL/.test(SESS),
        '🪤 в шапке отмечено, что таблица сообщений дашборда про код 6 ещё не знает');

    // ── 6. запреты владельца не нарушены ──
    console.log('\n6. чего трогать было нельзя');
    check(/headless: false/.test(SESS), 'headless: false на месте — решения по нему не принято');
    check(/accountUserAgent\(/.test(SESS) && /userAgent:\s*ua/.test(SESS),
        'липкий UA аккаунта передаётся в запуск Chromium');
    check(/Network\.setUserAgentOverride/.test(SESS) && /userAgentMetadata:\s*uaMetadata\(ua\)/.test(SESS),
        'client hints синхронизированы с липким UA');
    check(!/fetch\(['"`]https:\/\/github\.com/.test(SESS),
        'к github.com ходим только навигацией настоящего браузера');
    const sessionWait = cutFn(SESS, 'async function waitForSiteSession(');
    check(!/hasSessionCookie\(cookies\)\) return \{ ok: true \}/.test(sessionWait),
        'session-cookie from /api/oauth/state cannot finish login before OAuth callback');
    check(/oauth\.seen && oauth\.success === true/.test(sessionWait),
        'both manual and auto modes wait for successful gateway OAuth callback');
    check(/watchOauthResult\(context\)/.test(SESS)
        && !/auto \? watchOauthResult\(context\) : null/.test(SESS),
        'manual check-in observes OAuth callback too, not only autocheckin');
    check(/context\.on\('page',[\s\S]{0,250}applyUserAgentOverride/.test(SESS),
        'every popup gets matching sticky-UA client hints');
    check(/async function applyUserAgentOverride/.test(SESS),
        'UA/CDP override is a shared helper for initial page and popups');
    check(/oauth\.success/.test(sessionWait) && !/checkedIn/.test(sessionWait),
        'браузер ждёт только успешный колбэк входа, а не ошибочный checked_in или рост баланса');
    check(/loadSharedGhSnapshot/.test(SESS) && (SESS.match(/seedFromSharedSnapshot\(/g) || []).length >= 4,
        'подъём сессии из общего снимка не задет');
    check(!/\r/.test(fs.readFileSync(SRC, 'utf8')) && fs.readFileSync(SRC).slice(0, 3).toString('hex') !== 'efbbbf',
        'файл остался LF и без BOM');

    console.log(fail
        ? `\n❌ ${fail} провалено`
        : '\n✅ Автоподарок: ожидания кончаются по признаку, а не по потолку; отказ называет причину верно.');
    process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('❌ Ошибка теста:', e.stack || e.message); process.exit(1); });
