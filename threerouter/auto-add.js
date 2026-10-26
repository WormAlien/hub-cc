// threerouter/auto-add.js
//
// Авторега аккаунтов ThreeRouter (www.threerouter.com, движок sub2api).
// Клон rumeng/auto-add.js по инфраструктуре; главное отличие - КЛИК-КАПЧА,
// которая решается РУКАМИ в видимом окне (image_click или slider).
//
// Использование:
//   node threerouter/auto-add.js [количество]
//
// Что делает один аккаунт:
//   1. emailnator: ящик только .Gmail (адрес *@gmail.com проходит вайтлист панели);
//   2. видимое окно: /register?aff=DADYQH35FHUJ, email + пароль заполняются сами;
//   3. владелец решает капчу; токен ловим из ответа POST /api/v1/auth/captcha/verify;
//   4. скрипт жмёт Continue -> /email-verify, письмо ищет по НОВЫМ href (baseline до отправки),
//      отправитель ThreeRouter, код - 6 символов букв/цифр (не только цифры);
//   5. подтверждение -> JWT плоским объектом; группа -> ключ (полный sk-... в ответе);
//   6. запись в routing/threerouter-sessions.json + снимок localStorage для кнопки 🌐.
//
// 🪤 Три вещи, на которых это молча ломается (все проверены живьём 23.10):
//   - код письма НЕ цифровой: AXMFJK. extractCode из emailnator ищет 6 цифр и вернёт null;
//   - адреса emailnator переиспользуются: в ящике лежат чужие письма, поэтому baseline href
//     обязателен (в библиотеке был ещё и литеральный BACKSPACE вместо \b - починен);
//   - группа при создании ключа обязательна: без group_id ключ создаётся с null и мёртв.
//
// Прокси не используется: прогон идёт напрямую. Если площадка начнёт резать IP - сюда
// добавляется routing/lib/proxy-pool.js, как у rumeng.

'use strict';

const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const en = require('../freemodel/lib/emailnator');
const { writeJsonSync: durableWriteJson } = require('../routing/lib/durable-write');
const pp = require('../routing/lib/proxy-pool.js');

const ORIGIN = 'https://www.threerouter.com';
const API = `${ORIGIN}/api/v1`;
const GATEWAY = 'https://api.threerouter.com';
const REF = 'DADYQH35FHUJ';
const REGISTER_URL = `${ORIGIN}/register?aff=${REF}`;
const POOL_FILE = path.join(__dirname, '..', 'routing', 'threerouter-sessions.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const FROM_HINT = 'threerouter';
const OTP_TIMEOUT_MIN = 10;
const CAPTCHA_TIMEOUT_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 45 * 1000;

const COUNT = Math.max(1, Number(process.argv[2]) || 1);
const NO_PROXY = process.argv.includes('--no-proxy');
// PID-файл: кнопка «Стоп» в дашборде должна останавливать прогон, запущенный и из
// терминала, а не только тот, который поднял сам сервер. Живёт рядом с пулом, чистится
// по выходу и по Ctrl+C.
const PID_FILE = path.join(__dirname, '..', 'routing', 'threerouter-autoreg.pid');
function pidWrite() { try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch {} }
function pidClear() {
    try {
        if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
    } catch {}
}
process.on('exit', pidClear);
process.on('SIGINT', () => { pidClear(); process.exit(130); });
// Ревизия условий входа из /settings/public: без неё модалка согласия держит поля
// email/password в `disabled`, и fill падает с «element is not enabled».
let AGREEMENT_REV = '';
// Прокси на текущий аккаунт. У площадки лимит «1 регистрация на IP в сутки»
// (REGISTRATION_IP_LIMIT, живой ответ 23.10), поэтому каждый аккаунт идёт своим
// выходом: браузер и HTTP-шаги обязаны быть с ОДНОГО адреса.
let PROXY = null;
let PROXY_LABEL = 'напрямую';

async function castFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
    if (!PROXY) return fetch(url, { method, headers, body, signal });
    return pp.fetchVia(PROXY, url, { method, headers, body: body === undefined ? null : body, timeoutMs: HTTP_TIMEOUT_MS });
}

// ── журнал «какой прокси уже регистрировал сегодня» ──
//
// 🔴 Лимит площадки считается по IP: «1 аккаунт с адреса в сутки». Бесплатные прокси
// живут минуты и делятся с чужими, поэтому одного «нового из пула» мало: адрес мог уже
// отработать сегодня в прошлом прогоне (или его уже сожгли другие люди). Журнал не даёт
// ДВУМ нашим прогонам взять один и тот же адрес и переживает перезапуск.
const PROXY_LEDGER = path.join(__dirname, '..', 'routing', 'threerouter-proxy-ledger.json');
// 🔴 Лимит площадки живёт по её часовому поясу: сервер сообщает `Asia/Shanghai` (UTC+8,
// `server_utc_offset: +08:00`). Сброс «на сегодня» у неё наступает в 19:00 МСК, а не в
// полночь. Считать по локальной дате - значит обнулить журнал за час до сброса и снова
// взять сожжённый адрес.
function providerDate() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function proxyLedgerLoad() {
    try { return JSON.parse(fs.readFileSync(PROXY_LEDGER, 'utf8')) || {}; } catch { return {}; }
}
function proxiesUsedToday() {
    const doc = proxyLedgerLoad();
    return new Set(doc.date === providerDate() && Array.isArray(doc.used) ? doc.used.map(String) : []);
}
function proxyMarkUsed(id) {
    if (!id) return;
    const used = proxiesUsedToday();
    used.add(String(id));
    durableWriteJson(PROXY_LEDGER, { date: providerDate(), used: [...used] });
}
const RUN_USED_PROXIES = new Set();

// Свежий РАБОЧИЙ прокси: не из этого прогона, не из сегодняшнего журнала, и обязательно
// с успешным preflight по API-пути площадки. Привязка пишется в пул (reassign), чтобы
// снимок ЛК и баланс аккаунта потом ходили тем же адресом.
async function acquireFreshProxy(key, host) {
    const used = new Set([...proxiesUsedToday(), ...RUN_USED_PROXIES]);
    // Свои адреса - первыми (решение владельца), но когда они кончились, для автореги
    // добираем скраперный ярус. `pp.pick()` здесь не годится: он уважает потолок
    // «аккаунтов на адрес» и источник `own`, из-за чего на 4 своих адресах отвечает
    // `saturated`, хотя 60 скраперных живы и проверяются preflight'ом.
    const pool = pp.pool();
    const list = [...(pool.own || []), ...(pool.scraped || [])];
    for (const cand of list) {
        const id = String(cand.id);
        if (used.has(id)) continue;
        used.add(id);
        const pf = await pp.preflight(cand, { host, path: '/api/v1/settings/public' });
        if (!pf.ok) {
            log(`прокси ${cand.label || id} не прошёл preflight (${pf.error || pf.status})`);
            continue;
        }
        RUN_USED_PROXIES.add(id);
        proxyMarkUsed(id);
        const bind = pp.reassign(key, id);
        if (!bind.ok) log(`⚠️ привязка ${id} не записалась: ${bind.error}`);
        return cand;
    }
    throw new Error('нет живого прокси под этот хост: все адреса уже использованы сегодня или не проходят preflight');
}

function log(...a) { console.log('[tr-auto]', ...a); }
function stage(name, extra = {}) { console.log(`TR_STAGE ${JSON.stringify({ stage: name, ...extra })}`); }

function randomPassword() {
    // sub2api требует минимум 8; берём 18 и гарантируем все классы.
    const body = crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '');
    return `Tr${body.slice(0, 12)}7q`;
}
function keyName() { return `cc_${crypto.randomBytes(4).toString('hex')}`; }

function unwrap(j) {
    if (j && typeof j === 'object' && typeof j.code === 'number' && 'data' in j) return j.data;
    return j;
}

// Адреса emailnator переиспользуются: «email already exists» - штатный случай, а не
// поломка. Ловим по reason/тексту, потому что площадка называет причину по-разному
// на send-code и на register.
function isEmailTaken(e) {
    const t = `${(e && e.reason) || ''} ${(e && e.message) || ''} ${JSON.stringify((e && e.body) || {})}`.toLowerCase();
    return /already|exist|registered|taken|занят|已注册|已存在/.test(t);
}
function isIpLimit(e) {
    const t = `${(e && e.reason) || ''} ${(e && e.message) || ''}`.toLowerCase();
    return /registration_ip_limit|registration limit|ip address has reached/.test(t);
}

async function api(pathname, { method = 'GET', body, token } = {}) {
    const headers = { Accept: 'application/json', 'User-Agent': UA };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await castFetch(`${API}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    let j = {};
    try { j = await r.json(); } catch { /* тело может быть пустым */ }
    if (!r.ok) {
        const msg = (j && (j.message || j.error)) || `HTTP ${r.status}`;
        const e = new Error(`${method} ${pathname}: ${msg}`);
        e.status = r.status;
        e.reason = j && j.reason;
        e.code = j && j.code;
        e.body = j;
        throw e;
    }
    return unwrap(j);
}

// ───────────────────────────── пул аккаунтов ─────────────────────────────

function poolLoad() {
    try {
        const raw = fs.readFileSync(POOL_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function poolAppend(records) {
    const disk = poolLoad();
    const have = new Set(disk.map(s => s.api_key).filter(Boolean));
    const fresh = records.filter(r => !have.has(r.api_key));
    if (!fresh.length) return 0;
    durableWriteJson(POOL_FILE, disk.concat(fresh));
    return fresh.length;
}

// ───────────────────────────── код из письма ─────────────────────────────

// ThreeRouter присылает 6 символов A-Z0-9 (живой пример: AXMFJK), а не 6 цифр.
// 🪤 Первая версия взяла слово PLEASE из «PLEASE DO NOT SHARE…»: код в письме стоит
// отдельной строкой, а рядом со словом «code» оказался английский текст. Поэтому
// сначала ищем строку, состоящую РОВНО из шести символов, и только потом контекст.
const CODE_STOP = new Set([
    'PLEASE', 'VERIFY', 'EMAILS', 'EMAIL', 'SECURE', 'THANKS', 'NOTICE', 'ACCESS',
    'WELCOME', 'ACCOUNT', 'ROUTER', 'THREE', 'GMAIL', 'HTTPS', 'SIGNIN', 'LOGINS',
    'SHARED', 'SUPPORT', 'PRIVACY', 'POLICY', 'TERMS',
]);
function extractTrCode(text) {
    const s = String(text || '');
    const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    // 1) Код отдельной строкой - самый частый случай в письмах sub2api.
    for (const l of lines) {
        const m = l.match(/^([A-Z0-9]{6})$/);
        if (m && !CODE_STOP.has(m[1])) return m[1];
    }
    const flat = s.replace(/\s+/g, ' ');
    // 2) Рядом со словом про код.
    const near = flat.match(/(?:verification\s*code|verify\s*code|\bcode\b|код|otp|pin)[^A-Za-z0-9]{0,20}([A-Z0-9]{6})(?![A-Za-z0-9])/i);
    if (near && !CODE_STOP.has(near[1].toUpperCase())) return near[1].toUpperCase();
    // 3) Код, разнесённый пробелами: A X M F J K.
    const spaced = flat.match(/(?:^|\s)([A-Z0-9](?:\s+[A-Z0-9]){5})(?:\s|$)/);
    if (spaced) {
        const tok = spaced[1].replace(/\s+/g, '');
        if (!CODE_STOP.has(tok)) return tok;
    }
    // 4) Любой токен: сначала с цифрой, потом любой не из стоп-листа.
    const toks = [...flat.matchAll(/(?<![A-Za-z0-9])([A-Z0-9]{6})(?![A-Za-z0-9])/g)].map(m => m[1]);
    return toks.find(t => /\d/.test(t)) || toks.find(t => !CODE_STOP.has(t)) || null;
}

async function inboxHrefs(page) {
    try {
        return await page.evaluate(() => [...document.querySelectorAll('a.mf-msg-link')]
            .map(a => a.getAttribute('href')).filter(Boolean));
    } catch { return []; }
}

// ───────────────────────────── браузер ─────────────────────────────

async function clickExactButton(page, texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    for (const t of list) {
        const idx = await page.evaluate((want) => {
            const all = [...document.querySelectorAll('button')];
            return all.findIndex(x => (x.innerText || '').replace(/\s+/g, ' ').trim() === want);
        }, t).catch(() => -1);
        if (idx >= 0) {
            await page.locator('button').nth(idx).click({ timeout: 8000 }).catch(() => {});
            return t;
        }
    }
    return null;
}

async function dismissAgreement(page) {
    return clickExactButton(page, ['Accept and continue', '同意并继续', 'Accept', '同意']);
}

function waitCaptchaToken(page) {
    return new Promise((resolve, reject) => {
        const done = (fn, arg) => { clearTimeout(timer); page.off('response', onResp); page.off('close', onClose); fn(arg); };
        const timer = setTimeout(() => done(reject, new Error('капча не решена за 5 минут')), CAPTCHA_TIMEOUT_MS);
        const onClose = () => done(reject, new Error('окно регистрации закрыли до решения капчи'));
        async function onResp(r) {
            if (!r.url().includes('/auth/captcha/verify')) return;
            try {
                const j = await r.json();
                const tok = j && j.data && j.data.captcha_token;
                if (tok) done(resolve, tok);
            } catch { /* не наш ответ или тело не JSON */ }
        }
        page.on('response', onResp);
        page.on('close', onClose);
    });
}

// Вернуть окно к свежему адресу и заново прогнать шаг формы.
//
// 🔴 Заполнить поле НЕДОСТАТОЧНО (живой прогон 25.10): SPA уже увела окно на
// `/email-verify` и ждёт код СО СТАРОГО адреса. Заполнение полей там ничего не меняет -
// владелец видел «ждёт код со старой почты», хотя новый ящик уже создан.
// Поэтому возвращаемся на /register и жмём Continue ЕЩЁ РАЗ: SPA кладёт новые креды в
// `sessionStorage.register_data` и уходит на /email-verify уже с новым адресом.
// Капча не нужна - токен уже получен и уходит в HTTP send-code.
async function refillForm(page, addr, password) {
    try {
        if (!/\/register/.test(page.url())) {
            await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1500);
            await dismissAgreement(page);
            await page.waitForSelector('input[type="email"], #email', { timeout: 20000 });
        }
        await page.locator('input[type="email"], #email').first().fill(addr, { timeout: 8000 });
        await page.locator('input[type="password"], #password').first().fill(password, { timeout: 8000 });
        await clickExactButton(page, ['Continue', '继续', 'Продолжить']);
        await page.waitForTimeout(1200);
        return true;
    } catch (e) {
        log(`⚠️ форму не удалось обновить на ${addr}: ${e.message.split('\n')[0]}`);
        return false;
    }
}

// Контекст окна регистрации. Вынесен из oneAccount: окно могли закрыть - поднимаем
// заново с тем же прокси (showForm), и снимок в конце делается в новом контексте без
// повторной капчи. Капча-токен к сессии не привязан: регистрация проходит голым HTTP
// без кук, так что окно нужно для показа и снимка, а не для токена.
function newSiteContext(browser) {
    return (async () => {
        const ctx = await browser.newContext({
            userAgent: UA,
            viewport: null,
            locale: 'en-US',
            ...(PROXY ? {
                proxy: {
                    server: `${PROXY.scheme}://${PROXY.hostname}:${PROXY.port}`,
                    username: PROXY.user || undefined,
                    password: PROXY.pass || undefined,
                },
            } : {}),
        });
        if (AGREEMENT_REV) {
            await ctx.addInitScript(({ rev }) => {
                try {
                    const cur = localStorage.getItem('sub2api_login_agreement_consent');
                    if (!cur || JSON.parse(cur).revision !== rev) {
                        localStorage.setItem('sub2api_login_agreement_consent', JSON.stringify({ revision: rev, accepted_at: new Date().toISOString() }));
                    }
                } catch {}
            }, { rev: AGREEMENT_REV });
        }
        return ctx;
    })();
}

// Открыть форму регистрации: навигация, согласие, ожидание доступного поля email.
// 🪤 Модалка условий держит поля `disabled`, и fill падает с «element is not enabled» -
// выглядит как сломанный селектор. Ждём разблокировку и один раз снимаем ещё раз.
async function showRegisterForm(page) {
    await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissAgreement(page);
    await page.waitForSelector('input[type="email"], #email', { timeout: 30000 });
    const enabled = await page.waitForFunction(() => {
        const e = document.querySelector('input[type="email"], #email');
        return !!e && !e.disabled;
    }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!enabled) await dismissAgreement(page);
}

// ───────────────────────────── один аккаунт ─────────────────────────────

async function oneAccount(browser, n) {
    // Почта и панель - РАЗНЫЕ контексты: почта идёт напрямую, панель - через прокси аккаунта.
    // Регистрационный лимит площадки считается по IP: «1 аккаунт с адреса в сутки»,
    // поэтому браузер и HTTP-шаги аккаунта обязаны выходить с одного прокси.
    let mailContext = await browser.newContext({ userAgent: UA, locale: 'en-US' });
    let emailPage = await mailContext.newPage();
    // 🪤 Пустая вкладка видна владельцу как белое окно «about:blank»: emailnator грузится
    // только по первому createEmail (после капчи), а пока контекст пуст - браузер держит
    // пустую страницу. Держим её на реальной странице сайта, чтобы окно не выглядело
    // зависшим; сам ящик появится после капчи.
    // 🪤 Однако грузим её НЕ на глазах у владельца: страница панели поднимается сразу
    // после, а emailnator догружается в фоне. Иначе видно «почта грузится только после
    // сайта» и кажется, что скрипт встал (живой случай 25.10).
    await emailPage.goto('https://www.emailnator.com/', { waitUntil: 'commit', timeout: 45000 })
        .catch(() => log('⚠️ emailnator не открылся в фоне - откроется по createEmail'));
    let siteContext = null;

    // Окна закрывают руками: владелец убирает «лишнее» окно, пока решает капчу, или
    // закрывает всё, когда кажется, что скрипт завис (живой случай 25.10 - падение на
    // `page.waitForTimeout: Target page... closed` посреди createEmail). Пересоздаём
    // молча: ящик нужен скрипту, а не человеку.
    async function reopenMail() {
        try {
            emailPage = await mailContext.newPage();
        } catch {
            await mailContext.close().catch(() => {});
            mailContext = await browser.newContext({ userAgent: UA, locale: 'en-US' });
            emailPage = await mailContext.newPage();
        }
        return emailPage;
    }
    // Почтовая операция переживает закрытое окно: пересоздаём страницу и пробуем ещё раз.
    // pollInbox ждёт письма минутами - если окно закрыли в этот момент, повтор уводит
    // его снова в список, счётчик попыток у него свой.
    async function mailOp(fn, ...args) {
        if (emailPage.isClosed()) await reopenMail();
        try { return await fn(emailPage, ...args); }
        catch (e) {
            if (!/Target (page|context or browser) has been closed|Target closed/i.test(String(e.message))) throw e;
            log('окно почты закрыли - пересоздаю и пробую ещё раз');
            await reopenMail();
            return await fn(emailPage, ...args);
        }
    }
    try {
        // 1. Прокси - САМЫЙ долгий шаг (перебор + preflight), поэтому он ДО создания ящика.
        //    Адрес emailnator переиспользуемый: чем дольше он «висит» до регистрации, тем
        //    больше шанс, что его заберёт другой человек.
        const password = randomPassword();
        stage('proxy');
        if (NO_PROXY) {
            PROXY = null;
            PROXY_LABEL = 'напрямую (--no-proxy)';
        } else {
            // Каждый аккаунт - через СВОЙ живой прокси: лимит площадки считается по IP,
            // и повтор адреса из журнала сегодняшнего дня гарантирует отказ.
            PROXY = await acquireFreshProxy(`tr_rega_${Date.now()}_${n}`, 'www.threerouter.com');
            PROXY_LABEL = PROXY.label || PROXY.id || 'прокси';
        }
        log(`выход: ${PROXY_LABEL}`);

        // 2. Окно панели и капча руками. Ящик создаём уже ПОСЛЕ неё.
        // 🪤 24.10 08:03: капча больше НЕ стартует сама на пустой форме - на странице
        // висит кнопка `Click to start verification`, и `waitCaptchaToken` ждал ответ
        // верификации, которого без клика не будет. Жмём её сами, решает владелец.
        siteContext = await newSiteContext(browser);
        let sitePage = await siteContext.newPage();
        await sitePage.bringToFront();

        stage('register-form');
        await showRegisterForm(sitePage);

        stage('captcha-manual');
        const opened = await clickExactButton(sitePage, ['Click to start verification', 'Start verification', '点击开始验证', '开始验证']);
        if (opened) log(`капча открыта кнопкой «${opened}»`);
        // 🪤 Ящик создаётся ПОСЛЕ капчи, не параллельно (правка 25.10). Параллельное
        // открытие emailnator показывало владельцу `about:blank` рядом с окном
        // регистрации, а почта грузилась только после страницы провайдера - два контекста
        // дрались за старт. От создания ящика до отправки кода проходят секунды.
        log('✋ РЕШИ КАПЧУ В ОКНЕ (4 зелёных круга или ползунок). Дальше скрипт продолжит сам.');
        const captchaToken = await waitCaptchaToken(sitePage);
        log(`капча решена, токен ${captchaToken.slice(0, 8)}…`);

        stage('mail');
        // Ящик создаётся ПЕРВЫМ делом после капчи и заполняется в форму сразу. Если он
        // окажется занятым, refillForm вернёт окно на /register, впишет новый адрес и
        // заново нажмёт Continue - иначе SPA остаётся ждать код со старой почты.
        let addr = await mailOp(en.createEmail);
        if (!addr) throw new Error('emailnator не выдал адрес');
        log(`почта: ${addr}`);
        let baseline = await mailOp(inboxHrefs);
        log(`baseline писем в ящике: ${baseline.length}`);
        // 🪤 Почта ещё грузится: поднимаем вкладку провайдера, чтобы владелец не смотрел
        // на `about:blank` и не решал, что скрипт завис. Ящик нужен скрипту, не человеку.
        await sitePage.bringToFront().catch(() => {});
        // Окно могли закрыть ПОКА решали капчу: поднимаем новое на том же прокси,
        // форма открывается заново, капча не нужна - токен уже у нас.
        if (sitePage.isClosed()) {
            log('окно регистрации закрыли - поднимаю новое (капча не нужна)');
            siteContext = await newSiteContext(browser);
            sitePage = await siteContext.newPage();
            await sitePage.bringToFront();
            await showRegisterForm(sitePage);
        }
        await sitePage.locator('input[type="email"], #email').first().fill(addr);
        await sitePage.locator('input[type="password"], #password').first().fill(password);
        await clickExactButton(sitePage, ['Continue', '继续', 'Продолжить']);

        // Дальше - ЧИСТЫЙ HTTP: токен капчи уже есть, а адрес emailnator может быть занят
        // (адреса переиспользуются). Тогда берём новый ящик и повторяем БЕЗ новой капчи:
        // SPA шлёт один и тот же captcha_token и в send-code, и в register.
        stage('email-verify');
        let code = null;
        let auth = null;
        let retries = 0;
        for (let attempt = 1; attempt <= 8 && !auth; attempt++) {
            try {
                await api('/auth/send-verify-code', {
                    method: 'POST',
                    body: { email: addr, click_captcha_token: captchaToken },
                });
            } catch (e) {
                if (isEmailTaken(e)) {
                    retries++;
                    if (retries >= 4) throw new Error(`emailnator отдаёт занятые адреса подряд (${retries} попыток) - беру паузу, попробуй позже`);
                    log(`адрес ${addr} занят (${e.reason || e.message}) - беру новый ящик`);
                    const next = await mailOp(en.createEmail);
                    if (!next) throw new Error('emailnator не выдал новый адрес');
                    addr = next;
                    baseline = await mailOp(inboxHrefs);
                    log(`новый адрес: ${addr}, baseline ${baseline.length}`);
                    // 🪤 Прежде чем слать код на новый адрес - верни его в ФОРМУ окна:
                    // владелец видит там прежний (занятый) ящик и думает, что скрипт завис.
                    await refillForm(sitePage, addr, password);
                    continue;
                }
                throw e;
            }
            log('код отправлен, слежу за ящиком…');
            code = await mailOp(en.pollInbox, addr, {
                timeout: OTP_TIMEOUT_MIN,
                fromHint: FROM_HINT,
                excludeHrefs: baseline,
                extract: extractTrCode,
            });
            if (!code) throw new Error('код из письма не пришёл');
            log(`код из письма: ${code}`);
            stage('verify-code');
            try {
                auth = await api('/auth/register', {
                    method: 'POST',
                    body: {
                        email: addr,
                        password,
                        verify_code: code,
                        click_captcha_token: captchaToken,
                        aff_code: REF,
                    },
                });
            } catch (e) {
                if (isEmailTaken(e)) {
                    retries++;
                    if (retries >= 4) throw new Error(`emailnator отдаёт занятые адреса подряд (${retries} попыток) - беру паузу, попробуй позже`);
                    log(`регистрация: адрес ${addr} занят - беру новый ящик`);
                    const next = await mailOp(en.createEmail);
                    if (!next) throw new Error('emailnator не выдал новый адрес');
                    addr = next;
                    baseline = await mailOp(inboxHrefs);
                    await refillForm(sitePage, addr, password);
                    continue;
                }
                if (isIpLimit(e)) {
                    // Прокси уже помечен в журнале при выдаче, так что следующий прогон
                    // этот адрес не возьмёт. Новый прокси - только с новой капчей.
                    throw new Error(`прокси ${PROXY_LABEL} уже регистрировал сегодня (1/IP в сутки) - адрес помечен в журнале`);
                }
                throw e;
            }
        }
        if (!auth || !auth.access_token) throw new Error('в ответе регистрации нет access_token');
        log(`аккаунт создан, userId=${auth.user && auth.user.id}`);

        stage('key');
        const groups = await api('/groups/available', { token: auth.access_token });
        const list = Array.isArray(groups) ? groups : [];
        const grp = list.find(g => /default/i.test(g.name || ''))
            || list.find(g => /claude|anthropic/i.test(g.name || ''))
            || list.find(g => g.status === 'active')
            || list[0];
        if (!grp) throw new Error('у аккаунта нет доступных групп — ключ не создать');
        const keyNameV = keyName();
        const keyRec = await api('/keys', { method: 'POST', token: auth.access_token, body: { name: keyNameV, group_id: grp.id } });
        if (!keyRec || !keyRec.key) throw new Error('в ответе создания ключа нет key');
        if (keyRec.group_id == null) throw new Error('ключ создан без group_id — он мёртв');
        log(`ключ ${keyRec.key.slice(0, 6)}…${keyRec.key.slice(-6)} (группа ${grp.name})`);

        stage('probe-key');
        const probe = await castFetch(`${GATEWAY}/v1/models`, {
            headers: { Authorization: `Bearer ${keyRec.key}`, Accept: 'application/json', 'User-Agent': UA },
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (probe.status !== 200) throw new Error(`ключ не прошёл /v1/models: HTTP ${probe.status}`);

        const user = auth.user || {};
        const now = new Date().toISOString();
        const rec = {
            id: `tr_${Date.now()}_${n}`,
            email: addr,
            name: addr.split('@')[0],
            password,
            api_key: keyRec.key,
            active: false,
            status: 'live',
            created: now,
            userId: user.id != null ? user.id : null,
            keyId: keyRec.id != null ? keyRec.id : null,
            keyName: keyNameV,
            groupId: grp.id,
            groupName: grp.name,
            autoAdded: true,
            balance: typeof user.balance === 'number' ? user.balance : null,
            balanceSource: 'key',
            userAgent: UA,
            proxyUsed: PROXY ? PROXY_LABEL : null,
            mailProvider: 'gmail.com',
            accessToken: auth.access_token,
            refreshToken: auth.refresh_token || null,
            tokenExpiresIn: auth.expires_in || null,
            tokenIssuedAt: now,
        };

        stage('snapshot');
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        // JWT получен по HTTP, а не через форму, поэтому в localStorage браузера его надо
        // положить самим - иначе снимок откроет форму входа. Имена ключей - как у SPA:
        // auth_token (не access_token!), refresh_token, token_expires_at, auth_user.
        try {
            await sitePage.goto(`${ORIGIN}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
            await sitePage.evaluate(({ tok, ref, exp, user }) => {
                try {
                    localStorage.setItem('auth_token', tok);
                    if (ref) localStorage.setItem('refresh_token', ref);
                    localStorage.setItem('token_expires_at', String(exp));
                    localStorage.setItem('auth_user', JSON.stringify(user || {}));
                } catch {}
            }, {
                tok: auth.access_token,
                ref: auth.refresh_token || '',
                exp: Date.now() + (Number(auth.expires_in) || 86400) * 1000,
                user: user,
            });
        } catch { /* снимок без localStorage хуже, но аккаунт уже создан - не роняем */ }
        const state = await siteContext.storageState();
        durableWriteJson(path.join(SESSIONS_DIR, `acct_${rec.id}.json`), state);

        stage('save');
        poolAppend([rec]);
        console.log(`TR_AUTOADD_RESULT ${JSON.stringify({ ok: true, id: rec.id, email: addr, balance: rec.balance, group: grp.name, key: keyRec.key.slice(0, 6) + '…' + keyRec.key.slice(-4) })}`);
        return rec;
    } finally {
        if (siteContext) await siteContext.close().catch(() => {});
        await mailContext.close().catch(() => {});
        PROXY = null;
        PROXY_LABEL = 'напрямую';
    }
}

// ───────────────────────────── main ─────────────────────────────

(async () => {
    pidWrite();
    log(`аккаунтов: ${COUNT} · реф ${REF} · пул ${POOL_FILE}`);
    const settings = await fetch(`${API}/settings/public`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
        .then(r => r.json()).then(unwrap).catch(() => null);
    if (settings) {
        AGREEMENT_REV = settings.login_agreement_revision || '';
        log(`регистрация: ${settings.registration_enabled ? 'открыта' : 'ЗАКРЫТА'};`
            + ` email-verify: ${settings.email_verify_enabled ? 'да' : 'нет'};`
            + ` клик-капча: ${settings.registration_click_captcha_enabled ? 'ДА (руками)' : 'нет'}`);
        if (!settings.registration_enabled) throw new Error('регистрация на площадке закрыта');
    }

    const browser = await chromium.launch({
        headless: false,
        args: ['--window-size=900,1000', '--disable-blink-features=AutomationControlled'],
    });
    let ok = 0;
    try {
        for (let i = 0; i < COUNT; i++) {
            stage('account', { n: i + 1, of: COUNT });
            try {
                await oneAccount(browser, i);
                ok++;
            } catch (e) {
                log(`❌ аккаунт ${i + 1}: ${e.message}`);
                console.log(`TR_AUTOADD_RESULT ${JSON.stringify({ ok: false, n: i + 1, error: e.message })}`);
            }
            if (i + 1 < COUNT) await new Promise(r => setTimeout(r, 4000));
        }
    } finally {
        await browser.close().catch(() => {});
    }
    log(`готово: ${ok}/${COUNT}`);
    process.exit(ok === COUNT ? 0 : 2);
})().catch((e) => { console.error('[tr-auto] FATAL:', e.message); process.exit(1); });
