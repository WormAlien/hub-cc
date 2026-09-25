#!/usr/bin/env node
/*
 * google-preview.js — стенд вкладки Google, БЕЗ живого дашборда.
 *
 * Зачем. Вкладка вшита в `proxy-dashboard.html`, но проверить её отрисовку можно только
 * после рестарта `:8200` - а рестарт делает владелец, и каждая кривая правка стоит
 * round-trip'а с ним. Стенд показывает то же самое на своём порту.
 *
 * Что он делает: поднимает свой порт, отдаёт настоящий `/__switch/api/google/*` из
 * `routing/lib/google-routes.js`, `/vendor/*` с диска и страницу-обёртку с токенами тем
 * дашборда.
 *
 * 🔴 Живой пул НЕ читается и НЕ пишется: `GOOGLE_DIR` подменяется на временный каталог
 * ДО подключения модулей, и в нём заводится демо-пара. Живой стек не трогается вовсе:
 * свой порт, ноль обращений к `:8200`.
 *
 * 🪤 Временный каталог живёт до выхода процесса: стенд отдаёт из него профиль и снимок
 * демо-аккаунта, чтобы карточка показывала «профиль есть» и возраст снимка.
 *
 * Запуск: node tools/google-preview.js [порт]
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROUTING = path.join(__dirname, '..', 'routing');
const PORT = Number(process.argv[2]) || 8398;

// 🔴 Подмена каталога ДО require - иначе стенд сядет на живой google/accounts.json.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'google-preview-'));
process.env.GOOGLE_DIR = DIR;

const pool = require(path.join(ROUTING, 'lib', 'google-pool.js'));
const routes = require(path.join(ROUTING, 'lib', 'google-routes.js'));

// ── Демо-пара ────────────────────────────────────────────────────────────────
// Один личный аккаунт с 2FA, телефоном, восстановлением и прокси - то есть со всеми
// полями карточки. Второй расходник без 2FA: на нём видно, что блок кода честно говорит
// «секрета нет», а не показывает пустоту.
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const DEMO = [
    {
        email: 'demo.personal@gmail.com', password: 'demo-pass-personal', totpSecret: TOTP,
        phone: '+7 900 111-22-33', recoveryEmail: 'demo.reserve@mail.ru', proxy: 'res-fi-01',
        kind: 'personal', status: 'live', nickname: 'demo.personal', note: 'куплен 25.09 у продавца, в комплекте 2FA-секрет',
    },
    {
        email: 'demo.burner@gmail.com', password: 'demo-pass-burner', totpSecret: '',
        kind: 'burner', status: 'unknown', nickname: 'demo.burner',
    },
    {
        // Третий - под формат, которым продают на самом деле: `почта|пароль|16 знаков строчными`
        // (пароль приложения, он же уезжает в блок «Пароль приложения»).
        email: 'demo.apppass@gmail.com', password: 'demo-pass-app', appPassword: 'cmskdp4zkeikkncq',
        kind: 'burner', status: 'unknown', nickname: 'demo.apppass',
    },
];
{
    // 🪤 Массив растущий: `normalize` ищет свободный id по нему, и на пустом массиве оба
    // демо-аккаунта получили бы один и тот же id (одна миллисекунда на двоих).
    const arr = [];
    for (const e of DEMO) arr.push(pool.normalize(e, arr));
    pool.save(arr);
    // Профиль и снимок первому: карточка обязана показать «профиль есть» и возраст снимка.
    fs.mkdirSync(path.join(pool.PROFILES_DIR, pool.profileLabel(arr[0].id)), { recursive: true });
    fs.writeFileSync(path.join(pool.PROFILES_DIR, pool.profileLabel(arr[0].id), 'Cookies'), 'demo', 'utf8');
    fs.mkdirSync(pool.SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(pool.SESSIONS_DIR, `${arr[0].id}.json`), '{"cookies":[]}', 'utf8');
    console.log(`демо-пул: ${pool.FILE} (${arr.length} записи)`);
}

// 🪤 Шрифты лежат во вложенной папке (`/vendor/fonts/Geist-400-latin.woff2`), поэтому
// имя берётся относительным путём внутри /vendor, а не `basename`. Без woff2 в MIME браузер
// получил бы 404 на каждый файл гарнитуры, и стенд показывал бы вкладку системным шрифтом -
// то есть ровно не то, что надо посмотреть.
const MIME = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};

// Токены — ТЕ ЖЕ значения, что дашборд объявляет в своём `@theme` (oklch, как у него), а не
// подобранные на глаз hex: стенд обязан показывать вкладку в её родной среде. Шрифты
// подключаются его же файлом.
//
// 🪤 Это ДЕФОЛТНАЯ тёмная тема. У дашборда их 22, и он навешивает оверрайды инлайном на
// <html> - если владелец сидит на другой, стенд покажет иначе, чем живой :8200. Живая
// вкладка берёт токены окружения, поэтому расхождение стенда и дашборда - это тема, а не
// разъехавшаяся форма.
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
<title>Google — стенд</title>
<link href="/vendor/fonts.css" rel="stylesheet">
<link rel="stylesheet" href="/vendor/google-tab.css">
<style>
  body { margin:0; background:var(--color-bg); color:var(--color-ink);
         font-family:var(--font-sans),ui-sans-serif,system-ui,sans-serif; }
  .hint { padding:10px 24px; font-size:12px; color:var(--color-dim);
          border-bottom:1px solid var(--color-line-soft); }
</style>
</head>
<body>
<div class="hint">Стенд вкладки Google. Ручки настоящие (свой демо-пул аккаунтов, пул прокси - общий с дашбордом и только на чтение), дашборд не запущен. Тема - дефолтная тёмная: живая вкладка берёт вашу.</div>
<div id="google-root"></div>
<script src="/vendor/google-tab.js"></script>
<script>GOOGLE.load();</script>
</body></html>`;

const srv = http.createServer((req, res) => {
    if (routes.handle(req, res)) return;

    // Иконки у стенда нет: без этой строки браузер пишет в консоль 404, и проба отрисовки
    // (`check-google-tab-render.js`) считает консоль грязной на ровном месте.
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (req.url.startsWith('/vendor/')) {
        // Путь внутри /vendor сохраняем целиком (нужен ради /vendor/fonts/*), но выше
        // каталога не пускаем: `..` из адреса наружу не выведет.
        const rel = decodeURIComponent(req.url.split('?')[0].slice('/vendor/'.length));
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
    console.log(`стенд Google: http://127.0.0.1:${PORT}`);
});

// На выходе убираем за собой временный каталог: он наш, а не владельца.
const bye = () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* уже нет */ } process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
