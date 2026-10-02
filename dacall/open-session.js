// dacall/open-session.js
//
// Открывает ЛК dacall.AI в браузере с профилем аккаунта — кнопка 🌐 на вкладке.
// Контракт вызова задан хендлером `handleDcSessionOpen` в `routing/transparent-proxy.js`:
//
//   node dacall/open-session.js <label> [console|register]
//     label = acct_<id записи в пуле>; профиль → dacall/profiles/<label>/
//
// 🔴 **Почему это НЕ копия `kktoken/open-session.js`.** Канон ([[ADDING-A-GATEWAY]] § 3.10)
// прямо оставляет этот файл руками, потому что он сайт-специфичен: у KKtoken вход держится
// на куке `session` + GitHub-профилях и есть своя страница регистрации. У dacall панель —
// **SPA на sub2api**, и признак «я вошёл» она держит в `localStorage` (`access_token`,
// `auth_user`), а не в куке. Клон kktoken-файла дал бы ровно ту тихую полуработу, ради
// которой заведены сторожа: окно открывалось бы на форме входа.
// Ровно эта грабля уже ловилась на ZhiFlow — [[aikeysapi — вкладка ZhiFlow (дизайн)]]
// § «Кнопка 🌐 открывала форму входа».
//
// 🎯 Поэтому сессия не «ожидается», а ВСТАВЛЯЕТСЯ: из записи пула берём `accessToken` и
// `auth_user` (он же `user`), и кладём их в localStorage ДО первой навигации
// (`addInitScript` срабатывает только на следующей навигации — поэтому и до неё).

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const SITE = 'https://ru.dacall.ai';
const POOL_FILE = path.join(__dirname, '..', 'routing', 'dacall-sessions.json');
const LABEL = process.argv[2] || '';
const MODE = (process.argv[3] === 'register') ? 'register' : 'console';

function log(...a) { console.log('[dacall/open-session]', ...a); }

function poolRecordById(id) {
    try {
        const raw = fs.readFileSync(POOL_FILE, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        const arr = Array.isArray(doc) ? doc : (doc.sessions || []);
        return arr.find(r => String(r.id) === String(id)) || null;
    } catch (e) { log('пул не прочитался:', e.message); return null; }
}

async function raiseWindow() {
    // Окно поверх остальных. Модуль общий, у kktoken он уже используется.
    try {
        const focus = require('../routing/lib/focus-window.js');
        if (typeof focus.raiseBrowserWindow === 'function') await focus.raiseBrowserWindow();
    } catch { /* окно просто останется в общем порядке */ }
}

async function main() {
    if (!LABEL.startsWith('acct_')) {
        log('❌ label должен быть вида acct_<id>, получено:', LABEL);
        process.exit(1);
    }
    const id = LABEL.slice('acct_'.length);
    const rec = poolRecordById(id);
    if (!rec) {
        log(`❌ в пуле нет записи с id ${id} — нечего открывать`);
        process.exit(1);
    }

    const profileDir = path.join(__dirname, 'profiles', LABEL);
    fs.mkdirSync(profileDir, { recursive: true });

    const { chromium } = require('playwright');
    const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: null,                          // иначе страница заперта в 1280x800
        args: ['--window-size=600,1000', '--window-position=60,40'],
        locale: 'ru-RU',
    });

    // Сессия — в localStorage ДО первой навигации: у sub2api вход живёт именно там,
    // куки тут лишь транспорт, и без этого шага откроется форма входа.
    if (rec.accessToken) {
        await ctx.addInitScript(([token, userJson]) => {
            try {
                localStorage.setItem('access_token', token);
                if (userJson) localStorage.setItem('auth_user', userJson);
            } catch { /* localStorage может быть недоступен на about:blank */ }
        }, [rec.accessToken, JSON.stringify(rec.user || { id: rec.newapiUserId, email: rec.email })]);
        log('сессия подставлена (access_token + auth_user)');
    } else {
        log('⚠️ в записи нет accessToken — откроется форма входа');
    }

    const page = ctx.pages()[0] || await ctx.newPage();
    const url = MODE === 'register' ? `${SITE}/register` : `${SITE}/keys`;
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await raiseWindow();

    // Проверяем, что действительно внутри, а не на форме входа: у SPA по URL не понять.
    await page.waitForTimeout(3500);
    const loggedIn = await page.evaluate(() =>
        !document.querySelector('input[type=password]') && !!localStorage.getItem('access_token')
    ).catch(() => false);
    log(loggedIn ? '✅ внутри ЛК' : '⚠️ похоже на форму входа — снимок сессии не сработал');

    log(`окно открыто: ${url} (профиль ${LABEL})`);
    await new Promise(resolve => ctx.on('close', resolve));
    process.exit(0);
}

main().catch(e => { log('❌', e && e.stack || e); process.exit(1); });
