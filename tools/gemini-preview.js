#!/usr/bin/env node
/*
 * gemini-preview.js — стенд вкладки Gemini, БЕЗ живого дашборда.
 *
 * Зачем. Вкладка вшита в `proxy-dashboard.html`, а её правки видны только после рестарта
 * `:8200` — рестарт делает владелец, и каждая кривая правка стоит round-trip'а с ним.
 * Стенд показывает ту же вкладку на своём порту.
 *
 * 🔴 Что здесь НАСТОЯЩЕЕ, а что подставное. Настоящие: файлы вкладки (`/vendor/gemini-tab.js`
 * и `.css` с диска), токены темы дашборда и разметка, которую собирает JS. Подставные: данные —
 * демо-пул из трёх аккаунтов ниже. Так сделано намеренно: стенд нужен для отрисовки и не имеет
 * права ни поднимать сервер вкладки, ни ходить в Google, ни читать живой пул (в живом пуле
 * лежат refresh-токены).
 *
 * 🪤 Формы ответов списаны с боевого модуля `routing/lib/gemini-routes.js` (`list` и `models`) —
 * если ручки там поменяются, менять и здесь, иначе стенд начнёт показывать несуществующую форму
 * и «всё зелено» станет ложью. Сам модуль стенд не проверяет: его проверяет `check-gemini-tab.js`.
 *
 * Запуск: node tools/gemini-preview.js [порт]
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROUTING = path.join(__dirname, '..', 'routing');
const PORT = Number(process.argv[2]) || 8399;

// Демо-аккаунты: три состояния, которые вкладка обязана различать, — обычный pro с квотой,
// аккаунт с выжженной квотой и аккаунт, который Google забанил.
const now = Date.now();
const ago = ms => new Date(now - ms).toISOString();
const q = f => ({ remainingFraction: f, resetTime: new Date(now + 3600_000).toISOString() });

const DEMO = [
    {
        email: 'demo.pro@gmail.com', source: 'oauth', enabled: true, isInvalid: false, invalidReason: null,
        addedAt: ago(26 * 3600_000), lastUsed: ago(10 * 60_000), tier: 'pro', projectId: 'aicode-consumers',
        quota: {
            models: ['gemini-3.8-flash-tiered', 'gemini-3.6-flash-high', 'gemini-3.1-pro-low', 'gemini-2.5-flash', 'claude-sonnet-4-6'],
            perModel: {
                'gemini-3.8-flash-tiered': q(0.83), 'gemini-3.6-flash-high': q(0.83), 'gemini-3.1-pro-low': q(0.83),
                'gemini-2.5-flash': q(0.99), 'claude-sonnet-4-6': q(1),
            },
            minFraction: 0.83, lastChecked: ago(4 * 60_000),
        },
        rateLimited: [], hasToken: true,
    },
    {
        email: 'demo.burner@gmail.com', source: 'legacy-import', enabled: true, isInvalid: false, invalidReason: null,
        addedAt: ago(5 * 24 * 3600_000), lastUsed: ago(3 * 3600_000), tier: 'pro', projectId: 'aicode-consumers',
        quota: {
            models: ['gemini-3.8-flash-tiered', 'gemini-3.6-flash-high', 'gemini-3.1-pro-low'],
            perModel: { 'gemini-3.8-flash-tiered': q(0.02), 'gemini-3.6-flash-high': q(0.02), 'gemini-3.1-pro-low': q(1) },
            minFraction: 0.02, lastChecked: ago(32 * 60_000),
        },
        rateLimited: [{ model: 'gemini-3.8-flash-tiered', resetTime: new Date(now + 600_000).toISOString() }],
        hasToken: true,
    },
    {
        email: 'demo.banned@gmail.com', source: 'oauth', enabled: false, isInvalid: true,
        invalidReason: 'аккаунт забанен — Gemini отключён за нарушение условий',
        addedAt: ago(9 * 24 * 3600_000), lastUsed: ago(6 * 24 * 3600_000), tier: 'free', projectId: null,
        quota: { models: [], perModel: {}, minFraction: null, lastChecked: null },
        rateLimited: [], hasToken: true,
    },
];

const LIST = {
    ok: true,
    server: { up: true, name: 'gemini', up_at: now, accounts: 3, enabled: 2, available: 2, summary: '3 total, 2 available, 0 rate-limited, 1 invalid', port: 20178 },
    accounts: DEMO,
    total: 3,
    live: 2,
    tiers: ['pro', 'free'],
};

// GEMINI_PREVIEW_DOWN=1 — состояние «сервер вкладки лежит»: вкладка обязана показать это
// честно и предложить поднять его, а не рисовать пустоту. Проверяется приёмкой отрисовки.
const DOWN = process.env.GEMINI_PREVIEW_DOWN === '1';
const LIST_DOWN = {
    ok: true,
    server: { up: false, error: 'fetch failed', port: 20178 },
    accounts: [], total: 0, live: 0, tiers: [],
};
if (DOWN) console.log('стенд Gemini: режим «сервер лежит»');

const MODELS = {
    ok: true,
    models: ['gemini-3.8-flash-tiered', 'gemini-3.7-flash-tiered', 'gemini-3.6-flash-high', 'gemini-3.6-flash-medium',
        'gemini-3.1-pro-low', 'gemini-2.5-flash', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'],
    total: 8,
};

// Тир-карта стенда: те же ключи, что у боевой (`routing/gemini-modelmap.json`).
const MODELMAP = { opus: 'gemini-3.6-flash-high', sonnet: 'gemini-3.6-flash-medium', haiku: 'gemini-3.5-flash-lite' };

// 🪤 Шрифты лежат во вложенной папке (`/vendor/fonts/*.woff2`), поэтому путь внутри /vendor
// сохраняется целиком, а не берётся basename: иначе браузер получит 404 на каждую гарнитуру
// и стенд покажет вкладку системным шрифтом — то есть не то, что надо посмотреть.
const MIME = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};

// Токены — те же значения, что дашборд объявляет в своём `@theme` (oklch), а не подобранные
// на глаз hex: стенд обязан показывать вкладку в её родной среде. Это ДЕФОЛТНАЯ тёмная тема;
// живая вкладка берёт тему владельца, поэтому расхождение стенда и :8200 — это тема, не форма.
//
// 🪤 `renderEnergyGauge` приходит из дашборда, и в стенде его нет — вкладка это переживает
// (проверяет `typeof`), но тогда шкалы квоты на стенде не будет вовсе, а именно её и надо
// смотреть. Поэтому здесь её крошечная копия: только разметка, которую ждёт `check-gemini-tab-render.js`.
const PAGE = `<!doctype html>
<html lang="ru" style="
  --font-sans:'Geist',ui-sans-serif,system-ui,sans-serif;
  --font-mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --color-bg:oklch(0.135 0.012 245); --color-surface:oklch(0.175 0.012 245);
  --color-elevated:oklch(0.215 0.013 245); --color-line:oklch(0.30 0.014 245);
  --color-line-soft:oklch(0.24 0.014 245);
  --color-ink:oklch(0.96 0.005 245); --color-muted:oklch(0.66 0.013 245);
  --color-dim:oklch(0.48 0.014 245); --color-faint:oklch(0.36 0.014 245);
  --color-emerald:oklch(0.78 0.17 155); --color-amber:oklch(0.82 0.17 80);
  --color-azure:oklch(0.72 0.16 240); --color-violet:oklch(0.74 0.17 295);
  --color-crimson:oklch(0.70 0.20 22); --color-rose:oklch(0.72 0.18 12);">
<head>
<meta charset="utf-8">
<title>Gemini — стенд</title>
<link href="/vendor/fonts.css" rel="stylesheet">
<link rel="stylesheet" href="/vendor/gemini-tab.css">
<style>
  body { margin:0; background:var(--color-bg); color:var(--color-ink);
         font-family:var(--font-sans),ui-sans-serif,system-ui,sans-serif; }
  .hint { padding:10px 24px; font-size:12px; color:var(--color-dim);
          border-bottom:1px solid var(--color-line-soft); }
  /* Урезанная копия renderEnergyGauge из дашборда: стенд показывает вкладку без него. */
  .energy-track { height:24px; border-radius:999px; background:var(--color-elevated); overflow:hidden; position:relative; }
  .energy-fill { height:100%; border-radius:999px; background-image:linear-gradient(90deg, var(--eg-c, var(--color-emerald)) 0%, color-mix(in oklch, var(--eg-c, var(--color-emerald)), white 32%) 50%, var(--eg-c, var(--color-emerald)) 100%); }
  .energy-pct { position:absolute; inset:0; display:flex; align-items:center; justify-content:flex-end; padding-right:12px; font-family:var(--font-mono); font-size:13px; }
  .eg-title { font-size:12px; text-transform:uppercase; letter-spacing:0.2em; color:var(--color-dim); margin-bottom:10px; }
  .eg-sub { margin-top:10px; font-size:12px; color:var(--color-muted); display:flex; gap:16px; flex-wrap:wrap; }
</style>
</head>
<body>
<div class="hint">Стенд вкладки Gemini. Данные подставные (три демо-аккаунта), сервер вкладки и Google не трогаются. Тема — дефолтная тёмная: живая вкладка берёт вашу.</div>
<div id="gemini-root"></div>
<script>
  // Копия общей шкалы дашборда (урезанная до разметки): вкладка зовёт её по имени.
  function renderEnergyGauge(el, opts) {
    if (!el) return;
    const pct = Math.max(0, Math.min(100, Math.round(opts.pct || 0)));
    el.innerHTML = '<div class="eg-title">⚡ ' + (opts.title || '') + '</div>' +
      '<div class="energy-track"><div class="energy-fill" style="width:' + pct + '%; --eg-c: var(--color-' + (opts.color || 'emerald') + ')"></div>' +
      '<div class="energy-pct">' + pct + '% запас</div></div>' +
      (opts.sub ? '<div class="eg-sub">' + opts.sub + '</div>' : '');
  }
</script>
<script src="/vendor/gemini-tab.js"></script>
<script>GEMINI.load();</script>
</body></html>`;

const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // Иконки у стенда нет: без этой строки браузер пишет 404 в консоль, и проба отрисовки
    // считает консоль грязной на ровном месте.
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (url.startsWith('/__switch/api/gemini/')) {
        const route = url.slice('/__switch/api/gemini/'.length);
        let body = { ok: true };
        if (route === 'list') body = DOWN ? LIST_DOWN : LIST;
        else if (route === 'models') body = MODELS;
        else if (route === 'modelmap') body = { ok: true, modelMap: MODELMAP, activeModel: 'gemini-3.6-flash-high' };
        else if (route === 'set-model') body = { ok: true, appliedModel: 'gemini-3.6-flash-medium' };
        else if (route === 'auth/start') body = { ok: true, state: 'st_demo', email: 'demo.new@gmail.com', proxy: { label: 'http://203.0.113.7:8080' } };
        else if (route === 'auth/complete') body = { ok: true, email: 'demo.new@gmail.com' };
        else if (route === 'activate') body = { ok: true, base: 'http://127.0.0.1:20179', settingsUpdated: true, model: 'gemini-3.6-flash-high', keepalive: { up: true, port: 20179 } };
        else if (route.startsWith('refresh')) body = { ok: true, status: 'ok', email: 'demo.pro@gmail.com' };
        else if (route.startsWith('server')) body = { ok: true, pid: 4242 };
        else if (route.startsWith('account') || route === 'delete') body = { ok: true };
        // POST'ы стенда ничего не значат: он не поднимает сервер и не ходит в Google.
        const buf = Buffer.from(JSON.stringify(body), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
        return res.end(buf);
    }

    // Пул Google: вкладка Gemini берёт аккаунты у соседней вкладки, и стенд отдаёт ту же форму.
    // Один аккаунт уже авторизован в подписке (он же есть в демо-пуле), второй — новый.
    if (url.startsWith('/__switch/api/google/')) {
        const body = {
            ok: true,
            accounts: [
                { id: 'gg_demo_1', email: 'demo.pro@gmail.com', usedOn: [{ tag: 'antigravity', at: now }] },
                { id: 'gg_demo_2', email: 'demo.new@gmail.com', usedOn: [] },
            ],
            total: 2,
        };
        const buf = Buffer.from(JSON.stringify(body), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
        return res.end(buf);
    }

    if (url.startsWith('/vendor/')) {
        const rel = decodeURIComponent(url.slice('/vendor/'.length));
        const file = path.join(ROUTING, 'vendor', rel);
        const ext = path.extname(file).toLowerCase();
        if (!MIME[ext] || !file.startsWith(path.join(ROUTING, 'vendor')) || !fs.existsSync(file)) {
            res.writeHead(404);
            return res.end('нет такого');
        }
        res.writeHead(200, { 'Content-Type': MIME[ext] });
        return res.end(fs.readFileSync(file));
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
});

srv.listen(PORT, '127.0.0.1', () => {
    console.log(`стенд Gemini: http://127.0.0.1:${PORT}`);
});
