// dacall/auto-add.js
//
// Авторега аккаунтов dacall.AI (`api-ru.dacall.ai`). **Чистый HTTP на панель**, браузер
// нужен только для ящика (emailnator — настоящий точечный @gmail.com).
//
// Контракт снят ЖИВОЙ ЗАПИСЬЮ кликов владельца 2026-10-01 (`artifacts/manual-2026-10-01-18-23-24/net.jsonl`),
// а не выведен из бандла: порядок ручек и тела — как в записи.
//
//   POST /api/v1/auth/send-verify-code  {email}                          → {countdown:60}
//   POST /api/v1/auth/register          {email, password, verify_code}   → access_token, user.trial_balance=20
//   POST /api/v1/keys                   {name, group_id}                 → ПОЛНЫЙ `sk-…` в ответе
//   GET  /api/v1/auth/me                                                 → профиль/баланс
//
// 🔴 **Группа обязательна.** Ключ, созданный без `group_id`, панель принимает, но потом
// отбивает запросы: `403 API Key is not assigned to any group`. Живой замер 01.10: ключ
// с `group_id: null` → 403, с `group_id: 3` → 200. Группа 3 = «Claude code standard-ru»
// (platform anthropic, множитель 0.3). Список — `GET /api/v1/groups/available`.
//
// 🎯 Ключ приходит ПОЛНЫЙ, прямо в ответе на создание. Reveal-ручки, как у ZhiFlow, нет —
// и маски в ответе тоже нет. Это самый дешёвый шлюз по части ключа из встреченных.
//
// 🪤 Антибот у площадки — `api.botwafguard.net` (`POST /getcaptcha/<uuid>` + `/check/<uuid>`,
// тело — fingerprint браузера). В записи владельца его токен **в `register` не передаётся
// вовсе**: тело там только email/password/verify_code. Значит виджет висит отдельно и
// чистый HTTP-авторег им не связан. Если однажды панель начнёт требовать его — искать надо
// будет в теле register, а не в заголовках.
//
// ПОЧТА
// -----
// emailnator (`freemodel/lib/emailnator.js`): настоящий точечный `@gmail.com`, решение
// владельца. Один браузер на весь прогон, вкладка одна. `--mail=rest` переключает на
// цепочку REST-ящиков (guerrillamail → instanttempemail → mail.tm) — она быстрее, но
// домены одноразовые и у панелей бывают в чёрных списках. У dacall вайтлиста нет
// (`registration_email_suffix_whitelist: []`), так что обе дороги открыты.
//
// ПРОКСИ
// ------
// Общий пул `routing/lib/proxy-pool.js` — CONNECT/SOCKS, preflight с TTL, липкая привязка
// «аккаунт → прокси», fail-closed. Своей реализации туннелей здесь нет намеренно.
// Включается точечно на хост в `routing/proxy-pool.json` (список `hosts`).
// 🔴 Пул включён и пуст либо адрес мёртв → падаем, а не уходим тихо на домашний IP.
//
// Использование:
//   node dacall/auto-add.js 3                 — три аккаунта
//     --no-proxy        работать с домашнего IP явно
//     --dry-run         всё, кроме записи в пул
//     --mail=rest       ящики без браузера (guerrillamail и дальше)
//     --mail=emailnator (по умолчанию)
//
// Результат: аккаунты дописываются в `routing/dacall-sessions.json`, лог —
// `logs/dacall-autoadd.log`, последняя строка stdout — `DC_AUTOADD_RESULT {json}`.
//
// Коды возврата: 0 создан хоть один · 2 регистрация закрыта · 4 ключ · 5 рейт-лимит ·
//   6 прокси · 7 не создано ни одного · 8 почта · 1 прочее.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { writeJsonSync: durableWriteJson } = require('../routing/lib/durable-write');

const HOST = 'api-ru.dacall.ai';
const SITE = 'https://ru.dacall.ai';
const POOL_FILE = path.join(__dirname, '..', 'routing', 'dacall-sessions.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'dacall-autoadd.log');

// Группа «Claude code standard-ru» — та, под которой ключ действительно работает.
const GROUP_ID = 3;

const PASS_LEN = 16;
const REQ_TIMEOUT_MS = 45000;
const GAP_MS = 4000;
const OTP_TIMEOUT_MS = 180000;
const OTP_POLL_MS = 5000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch { /* лог не должен ронять авторег */ }
}

// ───────────────────────────── маркер этапа для дашборда ─────────────────────────────
//
// Человекочитаемые строки для индикатора не годятся: формулировки правятся, и парсер
// русского текста однажды молча соврёт, показав не тот этап. Этап едет отдельной
// машиночитаемой строкой — тем же приёмом, что итог (`DC_AUTOADD_RESULT {json}`).
// 🪤 В файл лога эта строка не пишется: она служебная, для контракта с бэкендом.
const STAGES = ['mail', 'wait_proxy', 'otp_wait', 'register', 'key', 'self'];

function stage(name, { i, count, note } = {}) {
    const payload = { stage: name };
    if (i != null) payload.i = i;
    if (count != null) payload.count = count;
    if (note) payload.note = note;
    console.log('DC_STAGE ' + JSON.stringify(payload));
}

// ───────────────────────────── HTTP к панели ─────────────────────────────

// 🔴 **User-Agent на /v1 решает всё, и «правильный» здесь — клиентский.**
// Живой замер 01.10 18:47 по одному и тому же запросу к `claude-opus-5-5`:
//
//   curl/8.0                          → 200 за 3,9 с
//   axios/1.7.2                       → 200 за 6,3 с
//   claude-cli/2.1.158 (external…)    → ТАЙМАУТ (30 с), потом socket hang up
//   браузерный Chrome/148            → ТАЙМАУТ
//   без user-agent вовсе             → ТАЙМАУТ
//
// Ни 403, ни 502 при этом не приходит: соединение просто висит и обрывается. Снаружи это
// выглядит как «шлюз лёг», хотя `/v1/models` в тот же момент отвечает 200 за 0,2 с, а curl
// с любым клиентским UA — за 3 с. Стережёт это `api.botwafguard.net` (см. шапку файла).
//
// 🪤 **Отсюда следствие для вкладки, а не только для автореги: `claude-cli` здесь запрещён** —
// а именно его наш проект ставит в `CC_HEADERS` для keepalive. Значит keepalive через dacall
// со стандартными заголовками работать НЕ будет; при заведении вкладки это надо решать
// отдельно (это же подтверждение, что антибот панели смотрит именно на UA, а не на TLS).
const UA = 'curl/8.0';

function request(method, url, { body, headers = {}, agent, timeoutMs = REQ_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = body == null ? null : JSON.stringify(body);
        const req = https.request({
            method,
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            agent,
            headers: {
                'user-agent': UA,
                'accept': 'application/json',
                'content-type': 'application/json',
                'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
                ...headers,
                ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
            },
            timeout: timeoutMs,
        }, res => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch { /* не JSON — оставляем как текст */ }
                const setCookie = res.headers['set-cookie'] || [];
                resolve({ status: res.statusCode, json, raw, setCookie });
            });
        });
        req.on('timeout', () => req.destroy(new Error(`таймаут ${timeoutMs} мс`)));
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function panel(method, urlPath, { body, token, agent } = {}) {
    const headers = {};
    if (token) headers['authorization'] = 'Bearer ' + token;
    return request(method, `https://${HOST}${urlPath}`, { body, headers, agent });
}

// Проверка ключа живым запросом — не «панель сказала success», а сам инференс.
//
// 🪤 Первый запрос по свежему ключу у dacall может висеть дольше обычного (прогрев канала):
// на живом прогоне 18:29 он не уложился в 45 с. Поэтому здесь свой, более щедрый таймаут и
// одна повторная попытка — и НИ ОДНА из них не имеет права стоить аккаунта: если ключ не
// ответил, запись всё равно уходит в пул с пометкой `probeOk: false` (см. createOne).
const PROBE_TIMEOUT_MS = 120000;

async function probeKey(apiKey, agent) {
    let last = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const r = await request('POST', `https://${HOST}/v1/messages`, {
                body: { model: 'claude-opus-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: KEY-OK' }] },
                headers: { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey },
                agent,
                timeoutMs: PROBE_TIMEOUT_MS,
            });
            return { ok: r.status === 200, status: r.status, body: (r.raw || '').slice(0, 200), attempt };
        } catch (e) {
            last = { ok: false, status: -1, body: e.message, attempt };
            if (attempt < 2) log(`   ⚠️ проверка ключа не ответила (${e.message}) — повтор`);
        }
    }
    return last;
}

// ───────────────────────────── почта ─────────────────────────────

function randomPassword() {
    const A = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789', S = '!@#$%';
    const pick = s => s[crypto.randomInt(s.length)];
    let p = pick(A) + pick('ABCDEFGHJKLMNPQRSTUVWXYZ') + pick(D) + pick(S);
    while (p.length < PASS_LEN) p += pick(A + D);
    return p;
}

// Браузер для emailnator: один на весь прогон, вкладка одна.
let _ctx = null, _mailPage = null;
async function mailPage() {
    if (_mailPage) return _mailPage;
    const { chromium } = require('playwright');
    _ctx = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    _mailPage = await _ctx.newPage();
    _mailPage.setDefaultTimeout(45000);
    return _mailPage;
}
async function closeMailBrowser() {
    try { if (_ctx) await _ctx.close(); } catch { /* уже закрыт */ }
    _ctx = null; _mailPage = null;
}

async function makeEmailnatorInbox() {
    const en = require('../freemodel/lib/emailnator.js');
    const page = await mailPage();
    const addr = await en.createEmail(page);
    return {
        addr,
        provider: 'emailnator',
        _page: page,
        _en: en,
        async waitCode(timeoutMin) {
            const code = await en.pollInbox(page, addr, { timeout: timeoutMin, fromHint: 'dacall' });
            return code;
        },
        async close() { /* браузер общий, вкладку не гасим */ },
    };
}

async function makeRestInbox() {
    // Цепочка как в aikeysapi: быстрый REST, но домены одноразовые.
    const mk = {
        async guerrillamail() {
            const { GuerrillaInbox } = require('../freemodel/lib/guerrillamail.js');
            const inbox = new GuerrillaInbox();
            await inbox.create();
            const local = 'dc' + crypto.randomBytes(3).toString('hex');   // свой local: дефолтный засвечен
            const addr = await inbox.setUser(local);
            return {
                addr, provider: 'guerrillamail',
                async poll() {
                    const list = await inbox.checkNew();
                    const out = [];
                    for (const m of list) {
                        const full = await inbox.fetchEmail(m.mail_id);
                        out.push({ from: m.mail_from, subject: m.mail_subject, body: full.mail_body || '' });
                    }
                    return out;
                },
            };
        },
        async instanttempemail() {
            const ite = require('../freemodel/lib/instanttempemail.js');
            const box = await ite.createEmail();
            return {
                addr: box.address, provider: 'instanttempemail',
                async poll() {
                    const emails = await ite.fetchInbox(box.token);
                    return emails.map(e => ({
                        from: String(e.from || e.sender || ''),
                        subject: String(e.subject || ''),
                        body: ite.emailToText(e),
                    }));
                },
            };
        },
    };

    let lastErr = null;
    for (const name of ['guerrillamail', 'instanttempemail']) {
        try {
            const box = await mk[name]();
            box.waitCode = (min) => waitOtp(box, { timeoutMs: min * 60000 });
            box.close = async () => { /* REST-ящики сами истекают */ };
            return box;
        } catch (e) { lastErr = e; log(`   ⚠️ ${name}: ${e.message}`); }
    }
    throw new Error('ни один REST-ящик не завёлся: ' + (lastErr && lastErr.message));
}

// Письмо от панели. 🪤 Фильтр по отправителю обязателен: у одноразовых сервисов первым
// приходит их собственное приветственное письмо, и в нём тоже есть шестёрка символов.
function isPanelMail(from, subject, body) {
    const hay = `${from} ${subject} ${String(body).slice(0, 400)}`.toLowerCase();
    return /dacall|dacall\.ai/.test(hay);
}

// Код подтверждения. Шесть цифр; годы (19xx/20xx) отсекаем явно — они есть в копирайте.
function extractOtp(body) {
    const s = String(body || '');
    const near = s.match(/(?:код|code|verification|verify|otp|pin)[^\d]{0,24}(\d{6})\b/i);
    if (near) return near[1];
    for (const m of s.matchAll(/\b(\d{6})\b/g)) {
        if (!/^(?:19|20)\d{2}$/.test(m[1])) return m[1];
    }
    return null;
}

async function waitOtp(box, { timeoutMs = OTP_TIMEOUT_MS, pollMs = OTP_POLL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    while (Date.now() < deadline) {
        let mails = [];
        try { mails = await box.poll(); } catch (e) { log(`   ⚠️ почта: ${e.message}`); }
        for (const m of mails.slice(seen)) {
            if (!isPanelMail(m.from, m.subject, m.body)) continue;
            const code = extractOtp(m.body);
            if (code) return code;
            log(`   ⚠️ письмо от панели пришло, кода не нашёл: ${String(m.body).replace(/\s+/g, ' ').slice(0, 180)}`);
        }
        seen = Math.max(seen, mails.length);
        await sleep(pollMs);
    }
    return null;
}

async function makeInbox(mode) {
    if (mode === 'rest') return makeRestInbox();
    try {
        return await makeEmailnatorInbox();
    } catch (e) {
        log(`   ⚠️ emailnator не дал ящик (${e.message}) — падаю на REST-цепочку`);
        return makeRestInbox();
    }
}

// ───────────────────────────── прокси через общий пул ─────────────────────────────

const PROXY_WAIT_MS = 5 * 60 * 1000;
const PROXY_WAIT_POLL_MS = 8000;

async function acquireProxyFor(email, { noProxy, index, count }) {
    if (noProxy) return { agent: undefined, proxyLabel: 'напрямую (--no-proxy)' };

    let pp;
    try { pp = require('../routing/lib/proxy-pool.js'); }
    catch (e) {
        return { error: `общий пул прокси не загрузился: ${e.message}. Нужен домашний IP — скажи --no-proxy` };
    }
    if (!pp.enabledForHost(HOST)) {
        return { agent: undefined, proxyLabel: `напрямую (пул выключен для ${HOST})` };
    }

    // 🪤 Привязка по АККАУНТУ, не по слоту: слот переживает прогон, и каждый следующий
    // запуск сажал бы первый аккаунт на тот же адрес — ровно та корреляция, от которой
    // пул и заводили. Ящик создаётся внешним сервисом, поэтому прокси берём ПОСЛЕ email.
    const key = `dacall:${String(email).toLowerCase()}`;
    const tried = new Set();
    const deadline = Date.now() + PROXY_WAIT_MS;
    let r = await pp.forAccount(key, { host: HOST });
    let firstError = null, announcedWait = false;

    for (let attempt = 0; attempt < 3 && !r.ok; attempt++) {
        if (!firstError) firstError = r.error;
        log(`   ⚠️ ${r.error}`);
        const cur = pp.assignmentFor(key);
        if (cur && cur.proxy) tried.add(cur.proxy);
        let others = pp.pool().proxies.filter(x => !tried.has(x.id));

        while (!others.length && Date.now() < deadline) {
            if (!announcedWait) {
                announcedWait = true;
                stage('wait_proxy', { i: index, count, note: 'пул пуст' });
                log(`   ⏳ живых прокси нет — жду докорма пула (до ${Math.round(PROXY_WAIT_MS / 1000)} с)`);
            }
            await sleep(PROXY_WAIT_POLL_MS);
            others = pp.pool().proxies.filter(x => !tried.has(x.id));
        }
        if (!others.length) {
            return { error: `${firstError}; прокси не появились за ${Math.round(PROXY_WAIT_MS / 1000)} с` };
        }

        const assign = { ...pp.assignments() };
        delete assign[key];
        const next = pp.leastLoaded(others, assign);
        const re = pp.reassign(key, next.id);
        if (!re.ok) return { error: `${firstError}; переназначить не вышло: ${re.error}` };
        log(`   ↻ прокси аккаунта → ${re.proxy.label || re.proxy.id}`);
        r = await pp.forAccount(key, { host: HOST });
    }

    if (!r.ok) return { error: `${firstError || r.error}; перебор не дал живого прокси` };
    if (!r.proxy) return { agent: undefined, proxyLabel: `напрямую (${r.reason || 'пул пуст'})` };
    return { agent: pp.agentFor(r.proxy), proxyLabel: r.proxy.label || r.proxy.id || 'прокси' };
}

// ───────────────────────────── пул ─────────────────────────────

function poolLoad() {
    try {
        const raw = fs.readFileSync(POOL_FILE, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        const arr = Array.isArray(doc) ? doc : (doc.sessions || []);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function poolAppend(records) {
    const existing = poolLoad();
    const byKey = new Map(existing.map(r => [r.api_key, r]));
    for (const r of records) byKey.set(r.api_key, { ...(byKey.get(r.api_key) || {}), ...r });
    durableWriteJson(POOL_FILE, [...byKey.values()]);
    return byKey.size;
}

// ───────────────────────────── один аккаунт ─────────────────────────────

async function createOne(index, { noProxy, count, mailMode }) {
    const at = n => stage(n, { i: index, count });

    // 1. Ящик (внешний сервис — прокси ему не нужен)
    at('mail');
    const box = await makeInbox(mailMode);
    const addr = box.addr;
    const password = randomPassword();
    log(`\n─── аккаунт ${index}/${count}: ${addr} (${box.provider})`);

    // 2. Прокси под этот адрес
    const got = await acquireProxyFor(addr, { noProxy, index, count });
    if (got.error) return { ok: false, code: 6, why: got.error };
    const agent = got.agent;
    log(`   прокси: ${got.proxyLabel}`);

    try {
        // 3. Код на почту
        at('register');
        const send = await panel('POST', '/api/v1/auth/send-verify-code', { body: { email: addr }, agent });
        if (send.status !== 200 || (send.json || {}).code !== 0) {
            return { ok: false, code: 8, why: `send-verify-code: HTTP ${send.status} ${(send.raw || '').slice(0, 160)}` };
        }
        log('   ✓ код запрошен');

        // 4. Ждём код
        at('otp_wait');
        const code = await box.waitCode(OTP_TIMEOUT_MS / 60000);
        if (!code) return { ok: false, code: 8, why: 'код не пришёл за 3 минуты' };
        log(`   ✓ код ${code}`);

        // 5. Регистрация
        at('register');
        const reg = await panel('POST', '/api/v1/auth/register', {
            body: { email: addr, password, verify_code: String(code) }, agent,
        });
        const rd = (reg.json || {}).data || {};
        if (reg.status !== 200 || (reg.json || {}).code !== 0 || !rd.access_token) {
            const msg = (reg.json || {}).message || (reg.raw || '').slice(0, 160);
            return { ok: false, code: 2, why: `register: HTTP ${reg.status} ${msg}` };
        }
        const token = rd.access_token;
        const user = rd.user || {};
        const uid = user.id;
        log(`   ✓ зарегистрирован, id ${uid}, trial $${user.trial_balance != null ? user.trial_balance : '?'}`);

        // 6. Ключ — группа обязательна, иначе 403 на инференсе
        at('key');
        const keyRes = await panel('POST', '/api/v1/keys', {
            body: { name: 'cc-auto', group_id: GROUP_ID }, token, agent,
        });
        const kd = (keyRes.json || {}).data || {};
        const apiKey = kd.key;
        if (!apiKey || !/^sk-/.test(apiKey) || apiKey.includes('*')) {
            return { ok: false, code: 4, why: `keys: HTTP ${keyRes.status}, ключ ${apiKey ? 'подозрительный' : 'не пришёл'}` };
        }
        log(`   ✓ ключ ${apiKey.slice(0, 14)}… (id ${kd.id}, группа ${kd.group_id})`);

        // 7. Ключ живой? Панель могла принять создание и всё равно отбить запросы.
        //
        // 🔴 Провал проверки НЕ выбрасывает аккаунт. Аккаунт к этому моменту уже оплачен
        // почтой и регистрацией, а ключ панель выдала — терять его из-за того, что первый
        // запрос не уложился в таймаут, значит выкидывать деньги на ровном месте. Пишем в
        // пул как есть, с пометкой `probeOk`, и пусть вкладка решает.
        const probe = await probeKey(apiKey, agent);
        log(`   ${probe.ok ? '✓' : '⚠️'} проверка ключа: HTTP ${probe.status}${probe.ok ? '' : ' — ' + probe.body}`);

        // 8. Профиль — что на аккаунте.
        //
        // 🪤 Панель держит ДВА кошелька: `balance` (пополненный) и `trial_balance` (грант за
        // регистрацию). Выше $20 гранта мы не видели: `balance: 0`, `trial: 19.99…`. Вкладка
        // же показывает одну цифру, и владелец ждёт «$20», а не «$0» — поэтому в пул пишем
        // СУММУ обоих как `balance`, а грант отдельным полем. Источник помечаем `self`:
        // цифра прочитана своим запросом, а не выведена прикидкой.
        at('self');
        const me = await panel('GET', '/api/v1/auth/me', { token, agent });
        const md = (me.json || {}).data || {};
        const trial = md.trial_balance != null ? Number(md.trial_balance) : (user.trial_balance != null ? Number(user.trial_balance) : 0);
        const paid = md.balance != null ? Number(md.balance) : 0;
        const spendable = Math.round((paid + trial) * 1e6) / 1e6;
        log(`   профиль: баланс $${paid}, грант $${trial} → к трате $${spendable.toFixed(2)}`);

        return {
            ok: true,
            record: {
                id: `dc_${Date.now()}_${index}`,
                email: addr,
                password,
                api_key: apiKey,
                active: false,                 // активный ключ ставит дашборд, не мы
                status: 'live',
                created: new Date().toISOString(),
                provider: 'dacall',
                newapiUserId: uid,
                keyId: kd.id,
                groupId: kd.group_id,
                balance: spendable,
                balanceSource: 'self',
                balanceCheckedAt: new Date().toISOString(),
                trialBalance: trial,
                paidBalance: paid,
                accessToken: token,
                autoAdded: true,
                probeOk: probe.ok,
                probeStatus: probe.status,
                proxyUsed: agent ? got.proxyLabel : null,
                mailProvider: box.provider,
                mailAddr: addr,
            },
        };
    } finally {
        try { await box.close(); } catch { /* ящик мог уже умереть */ }
    }
}

// ───────────────────────────── main ─────────────────────────────

function parseArgs(argv) {
    const a = { count: 1, noProxy: false, dry: false, mailMode: 'emailnator' };
    for (let i = 2; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--no-proxy') a.noProxy = true;
        else if (t === '--dry-run') a.dry = true;
        else if (t.startsWith('--mail=')) a.mailMode = t.slice(7);
        else if (/^\d+$/.test(t)) a.count = Math.max(1, Number(t));
    }
    return a;
}

async function main() {
    const args = parseArgs(process.argv);
    log(`🚀 авторег dacall.AI: ${args.count} акк${args.count > 1 ? '.' : ''}${args.dry ? ' (--dry-run)' : ''} · почта: ${args.mailMode}`);

    // Проверка «панель вообще регистрирует» — до создания ящиков.
    try {
        const s = await request('GET', `${SITE}/api/v1/settings/public`);
        const cfg = (s.json || {}).data || {};
        if (cfg.registration_enabled === false) {
            log('❌ панель закрыла регистрацию (registration_enabled=false)');
            console.log('DC_AUTOADD_RESULT ' + JSON.stringify({ created: 0, written: 0, failed: 0, errors: ['регистрация закрыта'] }));
            process.exit(2);
        }
        if (Array.isArray(cfg.registration_email_suffix_whitelist) && cfg.registration_email_suffix_whitelist.length) {
            log(`⚠️ у панели появился вайтлист доменов: ${cfg.registration_email_suffix_whitelist.join(', ')}`);
        }
        log(`   панель открыта (капчи: turnstile=${cfg.turnstile_enabled}, verify=${cfg.email_verify_enabled})`);
    } catch (e) {
        log(`⚠️ настройки панели не прочитались (${e.message}) — иду дальше`);
    }

    const records = [];
    const errors = [];

    for (let i = 1; i <= args.count; i++) {
        let res;
        try {
            res = await createOne(i, { noProxy: args.noProxy, count: args.count, mailMode: args.mailMode });
        } catch (e) {
            res = { ok: false, why: e.message };
        }
        if (res.ok) {
            records.push(res.record);
            if (!args.dry) {
                try {
                    const total = poolAppend([res.record]);
                    log(`   ↳ записан в пул (всего ${total})`);
                } catch (e) {
                    log(`   ⚠️ в пул не записалось: ${e.message}`);
                    errors.push('pool: ' + e.message);
                }
            }
        } else {
            log(`   ❌ аккаунт ${i} не получился: ${res.why}`);
            errors.push(res.why);
        }
        if (i < args.count) await sleep(GAP_MS);
    }

    await closeMailBrowser();

    log(`\n═══ итог: создано ${records.length} из ${args.count}${args.dry ? ' (dry-run, в пул не писали)' : ''}`);
    console.log('DC_AUTOADD_RESULT ' + JSON.stringify({
        created: records.length,
        written: args.dry ? 0 : records.length,
        failed: args.count - records.length,
        errors,
        keys: records.map(r => r.api_key.slice(0, 14) + '…'),
    }));

    if (!records.length) process.exit(7);
}

main().catch(e => {
    log('❌ фатально: ' + (e && e.stack || e));
    console.log('DC_AUTOADD_RESULT ' + JSON.stringify({ created: 0, written: 0, failed: 1, errors: [String(e && e.message || e)] }));
    process.exit(1);
});
