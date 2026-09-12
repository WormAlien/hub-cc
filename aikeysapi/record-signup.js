#!/usr/bin/env node
// aikeysapi/record-signup.js
//
// Браузер с записью: владелец руками проходит регистрацию на www.aikeysapi.com,
// скрипт пишет ВЕСЬ HTTP-контракт (метод, URL, тело запроса, статус, тело ответа)
// в JSONL + HAR, а параллельно поллит одноразовый ящик и печатает OTP-код.
//
// Запуск:  node aikeysapi/record-signup.js
// Итог:    aikeysapi/recordings/signup-<ts>.jsonl  (только api-вызовы)
//          aikeysapi/recordings/signup-<ts>.har    (полный трафик)
//          aikeysapi/.signup-inbox.json            (ящик + пароль + пойманный код)
//
// Грабля #17 (kktoken/open-session.js): viewport: null + --window-size,
// иначе Playwright зажимает страницу в 1280x720 внутри большого окна.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { GuerrillaInbox } = require('../freemodel/lib/guerrillamail.js');

const HOST = 'www.aikeysapi.com';
const ORIGIN = `https://${HOST}`;
const DIR = __dirname;
const REC_DIR = path.join(DIR, 'recordings');
const PROFILE = path.join(DIR, 'profiles', 'signup-record');
const INBOX_FILE = path.join(DIR, '.signup-inbox.json');

const OTP_RE = /(?:验证码|verification code|code)\D{0,20}([A-Za-z0-9]{6})/i;

function ts() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function genPassword() {
    // панель New API: validate min=8 max=20
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 11; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s + '!x7';
}

(async () => {
    fs.mkdirSync(REC_DIR, { recursive: true });
    fs.mkdirSync(PROFILE, { recursive: true });

    const stamp = ts();
    const jsonlPath = path.join(REC_DIR, `signup-${stamp}.jsonl`);
    const harPath = path.join(REC_DIR, `signup-${stamp}.har`);
    const jsonl = fs.createWriteStream(jsonlPath, { flags: 'a' });
    const rec = obj => jsonl.write(JSON.stringify(obj) + '\n');

    // ---- ящик: переиспользуем уже созданный, иначе новый -------------------
    const inbox = new GuerrillaInbox();
    let state = {};
    try { state = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8')); } catch { /* нет — создадим */ }

    if (state.email && state.sid) {
        inbox.sidToken = state.sid;
        inbox.emailAddr = state.email;
    } else {
        await inbox.create();
        const local = 'ak' + Math.random().toString(36).slice(2, 8);
        await inbox.setUser(local);
        state = { email: inbox.emailAddr, sid: inbox.sidToken, created: new Date().toISOString() };
    }
    if (!state.password) state.password = genPassword();
    if (!state.username) state.username = state.email.split('@')[0];
    state.recording = { jsonl: jsonlPath, har: harPath };
    fs.writeFileSync(INBOX_FILE, JSON.stringify(state, null, 1));

    console.log('');
    console.log('══════════════════════════════════════════════════');
    console.log('  ДАННЫЕ ДЛЯ РЕГИСТРАЦИИ (вводи в браузере)');
    console.log('══════════════════════════════════════════════════');
    console.log(`  email:    ${state.email}`);
    console.log(`  username: ${state.username}`);
    console.log(`  пароль:   ${state.password}`);
    console.log('══════════════════════════════════════════════════');
    console.log(`  запись:   ${path.basename(jsonlPath)}`);
    console.log('  Код с почты появится здесь сам (поллинг 3 с).');
    console.log('  Когда получишь API-ключ — просто закрой окно браузера.');
    console.log('══════════════════════════════════════════════════');
    console.log('');

    // ---- браузер -----------------------------------------------------------
    const ctx = await chromium.launchPersistentContext(PROFILE, {
        headless: false,
        viewport: null,                               // грабля #17
        args: ['--window-size=1500,1000', '--window-position=60,40'],
        recordHar: { path: harPath, content: 'embed' },
        locale: 'ru-RU',
    });

    const seen = new Set();

    ctx.on('request', req => {
        const url = req.url();
        if (!url.includes(HOST)) return;
        const u = new URL(url);
        if (!/^\/(api|v1)\//.test(u.pathname)) return;
        rec({
            t: new Date().toISOString(),
            kind: 'request',
            method: req.method(),
            path: u.pathname + u.search,
            headers: req.headers(),
            body: req.postData() || null,
        });
        console.log(`  → ${req.method()} ${u.pathname}${u.search}`);
    });

    ctx.on('response', async res => {
        const url = res.url();
        if (!url.includes(HOST)) return;
        const u = new URL(url);
        if (!/^\/(api|v1)\//.test(u.pathname)) return;
        let body = null;
        try { body = (await res.text()).slice(0, 8000); } catch { body = '<не прочитано>'; }
        const hdrs = res.headers();
        rec({
            t: new Date().toISOString(),
            kind: 'response',
            status: res.status(),
            path: u.pathname + u.search,
            setCookie: hdrs['set-cookie'] || null,
            headers: hdrs,
            body,
        });
        const short = (body || '').replace(/\s+/g, ' ').slice(0, 160);
        console.log(`  ← ${res.status()} ${u.pathname} :: ${short}`);

        // ключ в ответе — сразу в стейт
        const m = (body || '').match(/"key"\s*:\s*"([^"]{20,})"/);
        if (m) {
            state.api_key = m[1];
            fs.writeFileSync(INBOX_FILE, JSON.stringify(state, null, 1));
            console.log('');
            console.log(`  🔑 ПОЙМАН КЛЮЧ: ${m[1]}`);
            console.log('');
        }
    });

    // ---- поллинг почты -----------------------------------------------------
    let mailStop = false;
    (async () => {
        while (!mailStop) {
            try {
                const list = await inbox.checkNew();
                for (const m of list) {
                    if (seen.has(m.mail_id)) continue;
                    seen.add(m.mail_id);
                    const full = await inbox.fetchEmail(m.mail_id);
                    const body = (full.mail_body || '').replace(/<[^>]+>/g, ' ');
                    console.log('');
                    console.log(`  📬 письмо: ${m.mail_subject} (от ${m.mail_from})`);
                    const code = body.match(OTP_RE) || body.match(/\b([A-Za-z0-9]{6})\b/);
                    if (code) {
                        state.otp = code[1];
                        state.otp_at = new Date().toISOString();
                        fs.writeFileSync(INBOX_FILE, JSON.stringify(state, null, 1));
                        console.log('');
                        console.log(`  ✉️  КОД: ${code[1]}`);
                        console.log('');
                    } else {
                        console.log(`  (код не распознан) ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
                    }
                    rec({ t: new Date().toISOString(), kind: 'mail', subject: m.mail_subject, from: m.mail_from, body: body.slice(0, 3000) });
                }
            } catch (e) {
                // молча: guerrilla иногда отдаёт мусор, следующий тик починит
            }
            await new Promise(r => setTimeout(r, 3000));
        }
    })();

    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(`${ORIGIN}/register?aff=vsFh`, { waitUntil: 'domcontentloaded' }).catch(e => {
        console.log(`  ⚠️ не открылась страница регистрации: ${e.message}`);
    });

    await new Promise(resolve => ctx.on('close', resolve));
    mailStop = true;
    jsonl.end();
    console.log('');
    console.log('══════════════════════════════════════════════════');
    console.log(`  Запись закрыта: ${jsonlPath}`);
    console.log(`  HAR:            ${harPath}`);
    if (state.api_key) console.log(`  Ключ:           ${state.api_key}`);
    console.log('══════════════════════════════════════════════════');
    process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
