#!/usr/bin/env node
/*
 * media-preview.js — стенд для вкладки MEDIA, БЕЗ живого дашборда.
 *
 * Зачем. Вкладка сидит в новых файлах и в `proxy-dashboard.html` ещё не вшита (шов
 * ставится, когда освободятся большие файлы). Посмотреть её всё равно надо ДО шва:
 * если она криво рисуется, чинить это внутри 30-тысячестрочного файла дороже.
 *
 * Поднимает свой порт, отдаёт настоящие `/__media/api/*` из `lib/media-routes.js`,
 * `/vendor/*` с диска и страницу-обёртку с токенами тем дашборда.
 *
 * Живой стек НЕ трогает: свой порт, ничего не пишет, кроме кеша каталога моделей.
 *
 * Запуск: node tools/media-preview.js [порт]
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROUTING = path.join(__dirname, '..', 'routing');
const routes = require(path.join(ROUTING, 'lib', 'media-routes.js'));
const PORT = Number(process.argv[2]) || 8399;

const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// Токены — те же имена, что дашборд навешивает на <html>. Значения взяты из его
// тёмной темы по умолчанию: стенд должен показывать вкладку в её родной среде.
const PAGE = `<!doctype html>
<html lang="ru" style="
  --color-bg:#0b0e13; --color-surface:#131922; --color-elevated:#1a212b;
  --color-line:#2c3339; --color-line-soft:#1e242c;
  --color-ink:#e8ebee; --color-muted:#c9d1d9; --color-dim:#8b949e;
  --color-emerald:#3ddc91; --color-amber:#ff8a3d; --color-azure:#58a6ff;
  --color-crimson:#f85149; --color-violet:#a78bfa;">
<head>
<meta charset="utf-8">
<title>MEDIA — стенд</title>
<link rel="stylesheet" href="/vendor/media-tab.css">
<style>
  body { margin:0; background:var(--color-bg); color:var(--color-ink);
         font-family:-apple-system,"Segoe UI",system-ui,sans-serif; }
  .hint { padding:10px 24px; font-size:12px; color:var(--color-dim);
          border-bottom:1px solid var(--color-line-soft); }
  /* Утилиты Tailwind, которые использует разметка вкладки. Здесь их немного, и
     тянуть ради стенда весь браузерный билд Tailwind незачем. */
  .text-muted{color:var(--color-muted)} .text-dim{color:var(--color-dim)}
  .text-azure{color:var(--color-azure)} .text-emerald{color:var(--color-emerald)}
  .text-crimson{color:var(--color-crimson)} .text-amber{color:var(--color-amber)}
  .font-mono{font-family:ui-monospace,Menlo,monospace} .font-medium{font-weight:500}
  .text-sm{font-size:13px} .text-\\[11px\\]{font-size:11px} .text-\\[10px\\]{font-size:10px}
  .text-\\[12px\\]{font-size:12px} .text-lg{font-size:18px}
  .mt-1{margin-top:4px} .mt-2{margin-top:8px} .mt-3{margin-top:12px} .mt-4{margin-top:16px}
  .mt-0\\.5{margin-top:2px} .mb-0{margin-bottom:0} .flex{display:flex} .gap-1\\.5{gap:6px}
  .items-center{align-items:center} .justify-between{justify-content:space-between}
  .flex-1{flex:1} .min-w-0{min-width:0} .truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hidden{display:none}
</style>
</head>
<body>
<div class="hint">Стенд вкладки MEDIA. Ручки настоящие, дашборд не запущен.</div>
<div id="media-root"></div>
<script src="/vendor/media-tab.js"></script>
<script>MEDIA.load();</script>
</body></html>`;

const srv = http.createServer((req, res) => {
    if (routes.handle(req, res)) return;

    if (req.url.startsWith('/vendor/')) {
        const name = path.basename(req.url.split('?')[0]);
        const file = path.join(ROUTING, 'vendor', name);
        const ext = path.extname(name);
        if (!MIME[ext] || !fs.existsSync(file)) { res.writeHead(404); return res.end('нет такого'); }
        res.writeHead(200, { 'Content-Type': MIME[ext] });
        return res.end(fs.readFileSync(file));
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
});

srv.listen(PORT, '127.0.0.1', () => {
    console.log(`стенд MEDIA: http://127.0.0.1:${PORT}`);
});
