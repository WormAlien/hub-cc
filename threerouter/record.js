// threerouter/record.js
//
// Запись маршрута владельца "от реги до ключа" для ThreeRouter.
// Два окна: слева emailnator (почта), справа регистрация с реф-кодом.
// Пишет JSONL: клики, ввод, навигацию, ответы API (captcha/register/keys).
// Формат строки повторяет приём из rumeng/auto-add.js: элемент, класс, текст, страница.
//
// Запуск:  node threerouter/record.js
// Выход:   threerouter/recordings/route-<штамп>.jsonl (gitignored)
// Окна закрыть руками - процесс завершится сам.

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DIR = path.join(__dirname, 'recordings');
fs.mkdirSync(DIR, { recursive: true });
const LOG = path.join(DIR, `route-${TS}.jsonl`);
fs.writeFileSync(LOG, '');

function log(obj) {
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
}

// Наблюдатель передаётся ФУНКЦИЕЙ, а не строкой (грабля rumeng: экранирование ломало код).
function installWatcher() {
    const cssPath = (el) => {
        if (!el || el.nodeType !== 1) return '';
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && parts.length < 6) {
            let part = cur.tagName.toLowerCase();
            if (cur.id) { part += '#' + cur.id; parts.unshift(part); break; }
            if (cur.className && typeof cur.className === 'string') {
                const cls = cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 3);
                if (cls.length) part += '.' + cls.join('.');
            }
            const parent = cur.parentElement;
            if (parent) {
                const sib = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
                if (sib.length > 1) part += `:nth-of-type(${sib.indexOf(cur) + 1})`;
            }
            parts.unshift(part);
            cur = parent;
        }
        return parts.join(' > ');
    };
    const describe = (el) => ({
        tag: el.tagName ? el.tagName.toLowerCase() : '',
        id: el.id || '',
        name: el.getAttribute && (el.getAttribute('name') || ''),
        cls: (typeof el.className === 'string' ? el.className : '') || '',
        text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
        type: (el.getAttribute && el.getAttribute('type')) || '',
        aria: (el.getAttribute && el.getAttribute('aria-label')) || '',
        href: (el.getAttribute && el.getAttribute('href')) || '',
        path: cssPath(el),
    });
    const send = (kind, data) => { try { window.__send(kind, data); } catch (e) {} };
    document.addEventListener('click', (e) => {
        send('click', { ...describe(e.target), url: location.href });
    }, true);
    document.addEventListener('change', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
            send('input', { ...describe(t), value: String(t.value || '').slice(0, 200), url: location.href });
        }
    }, true);
    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            send('nav', { url: lastUrl });
        }
    }, 400);
}

const WINDOWS = [
    { name: 'email', url: 'https://www.emailnator.com/' },
    { name: 'site', url: 'https://www.threerouter.com/register?aff=DADYQH35FHUJ' },
];

async function openWindow(win) {
    const ctx = await chromium.launchPersistentContext(path.join(DIR, 'profiles', win.name), {
        headless: false,
        viewport: null,
        args: ['--start-maximized', '--lang=ru-RU'],
        locale: 'ru-RU',
    });
    await ctx.exposeBinding('__send', (_src, kind, msg) => log({ win: win.name, kind, ...msg }));
    await ctx.addInitScript(installWatcher);
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) log({ win: win.name, kind: 'nav', url: f.url() });
    });
    page.on('console', (m) => {
        if (m.type() === 'error') log({ win: win.name, kind: 'console_error', text: m.text().slice(0, 300) });
    });
    page.on('response', async (r) => {
        const u = r.url();
        if (!/threerouter\.com\/api\/v1\/(auth|captcha|keys|groups|user)|threerouter\.com\/v1\/usage/.test(u)) return;
        let body = '';
        try { body = (await r.text()).slice(0, 1500); } catch (e) { body = '<no body>'; }
        log({ win: win.name, kind: 'api', status: r.status(), method: r.request().method(), url: u, body });
    });
    ctx.on('close', () => log({ win: win.name, kind: 'closed' }));
    await page.goto(win.url, { waitUntil: 'domcontentloaded' }).catch((e) => log({ win: win.name, kind: 'goto_error', error: e.message }));
    return ctx;
}

(async () => {
    console.log(`[record] лог: ${LOG}`);
    const ctxs = [];
    for (const w of WINDOWS) ctxs.push(await openWindow(w));
    console.log('[record] два окна открыты. Сделай полный цикл руками: почта -> регистрация -> капча -> код -> вход -> группа -> ключ.');
    console.log('[record] Когда закончишь - просто закрой оба окна, процесс завершится сам.');
    let closed = 0;
    await Promise.all(ctxs.map((ctx) => new Promise((resolve) => ctx.on('close', () => { closed++; if (closed === ctxs.length) resolve(); }))));
    console.log('[record] окна закрыты, запись сохранена.');
})().catch((e) => { console.error('[record] FAILED:', e); process.exit(1); });
