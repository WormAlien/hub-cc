#!/usr/bin/env node
// Подарок ⚡ через прокси: браузер аккаунта поднимается ТЕМ ЖЕ адресом, что и чек баланса,
// а невозможность его дать останавливает запуск, а не превращается в поход напрямую.
//
// Зачем именно браузер. Прокси на `/api/status` мало: вход в подарок идёт через GitHub
// OAuth, то есть весь Chromium (шлюз + попап github.com) обязан выходить одним адресом.
// Аккаунт, который проверяется из Германии, а логинится из дома, для антифрода панели
// заметнее, чем двадцать аккаунтов с одного домашнего IP.
//
// 🪤 Playwright умеет НЕ любую схему. Chromium не поддерживает socks4 вовсе, а SOCKS с
// логином/паролем игнорирует молча — запрос ушёл бы напрямую, и никто бы не узнал. Такие
// сочетания обязаны падать с понятным текстом ДО запуска браузера, а не «как-нибудь».
//
// Запуск: node tools/check-checkin-proxy.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SESSION = require(path.join(ROOT, 'agentrouter', 'open-session.js'));

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-proxy-check-'));

// ── 1. seed-файл: разовый носитель кредов ──
console.log('\n1. прокси приезжает файлом и живёт один запуск');
{
    check(typeof SESSION.readProxySeed === 'function' && typeof SESSION.proxyLaunchOptions === 'function',
        'скрипт экспортирует readProxySeed и proxyLaunchOptions — их можно проверить без браузера');

    const seedFile = path.join(TMP, 'acct_ar_1.json');
    fs.writeFileSync(seedFile, JSON.stringify({
        proxy: { id: 'http://203.0.113.10:8080', scheme: 'http', hostname: '203.0.113.10', port: 8080, user: 'u', pass: 'p' },
    }), 'utf8');

    const seed = SESSION.readProxySeed('acct_ar_1', TMP);
    check(seed && seed.hostname === '203.0.113.10', 'seed прочитан');
    check(!fs.existsSync(seedFile), 'файл удалён сразу после чтения — креды не лежат на диске дольше запуска');
    check(SESSION.readProxySeed('acct_ar_1', TMP) === null, 'повторное чтение отдаёт null, а не мусор');
    check(SESSION.readProxySeed('нет-такого', TMP) === null, 'отсутствие seed это штатный случай: пул выключен');
}

// ── 2. перевод в опции запуска Playwright ──
console.log('\n2. опции запуска');
{
    const none = SESSION.proxyLaunchOptions(null);
    check(none.ok === true && !none.options.proxy, 'без прокси опций не добавляем — путь ровно как до правки');

    const http = SESSION.proxyLaunchOptions({ scheme: 'http', hostname: '203.0.113.10', port: 8080, user: 'u', pass: 'p' });
    check(http.ok === true && http.options.proxy.server === 'http://203.0.113.10:8080', 'http → server с схемой и портом');
    check(http.options.proxy.username === 'u' && http.options.proxy.password === 'p', 'креды уходят отдельными полями, а не в URL');

    const socks5 = SESSION.proxyLaunchOptions({ scheme: 'socks5', hostname: '203.0.113.11', port: 1080 });
    check(socks5.ok === true && socks5.options.proxy.server === 'socks5://203.0.113.11:1080', 'socks5 без кредов поддержан');

    const socks4 = SESSION.proxyLaunchOptions({ scheme: 'socks4', hostname: '203.0.113.12', port: 1080 });
    check(socks4.ok === false && /socks4/i.test(socks4.error || ''), '🔴 socks4 отвергнут: Chromium его не умеет');

    const socksAuth = SESSION.proxyLaunchOptions({ scheme: 'socks5', hostname: '203.0.113.13', port: 1080, user: 'u', pass: 'p' });
    check(socksAuth.ok === false && /лог|парол|auth/i.test(socksAuth.error || ''),
        '🔴 SOCKS с логином отвергнут: Chromium молча пошёл бы напрямую');

    const junk = SESSION.proxyLaunchOptions({ scheme: 'ftp', hostname: 'x', port: 1 });
    check(junk.ok === false, 'чужая схема отвергнута');
    const noPort = SESSION.proxyLaunchOptions({ scheme: 'http', hostname: 'gate.provider.com', port: 0 });
    check(noPort.ok === false, 'адрес без порта отвергнут');

    const host = SESSION.proxyLaunchOptions({ scheme: 'http', hostname: 'gate.provider.com', port: 7000 });
    check(host.ok === true && host.options.proxy.server === 'http://gate.provider.com:7000', 'hostname поддержан наравне с IP');
}

// ── 3. родитель решает прокси ДО запуска браузера ──
console.log('\n3. бэкенд: отказ прокси не запускает Chromium');
{
    const src = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8').replace(/\r\n/g, '\n');
    const i = src.indexOf('async function arSpawnSession');
    const run = i >= 0 ? src.slice(i, i + 12000) : '';
    check(run.length > 0, 'функция запуска чек-ина найдена и стала асинхронной (прокси резолвится до spawn)');
    check(/arResolveCheckinProxy\(|accountProxy\(/.test(run), 'прокси резолвится в родителе, а не внутри браузера');
    check(/arWriteProxySeed\(/.test(run), 'адрес передаётся в child файлом, а не аргументом командной строки');
    check(run.indexOf('arResolveCheckinProxy(') < run.indexOf('spawn(process.execPath'), 'резолв идёт ДО spawn: мёртвый прокси не поднимает окно');
    check(/arAutoCheckinFinish\(id, label, 7/.test(run), 'отказ прокси отдаётся кодом 7, а не общим «скрипт упал»');

    check(/AR_CHECKIN_PROXY_DIR|ar-proxy/.test(src), 'каталог seed-файлов определён в бэкенде');
    check(!/\$\{[^}]*proxy\.pass|proxy\.user[^}]*\}/.test(run), 'кредов нет в строках лога/статуса');
}

// ── 4. предохранитель пачки видит отказы прокси ──
console.log('\n4. стоп пачки по отказам прокси');
{
    const src = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8').replace(/\r\n/g, '\n');
    check(/checkin-cancel/.test(src), 'ручка отмены на месте (была до этой правки)');
    const fuse = src.slice(src.indexOf('AR_CHECKIN_FUSE'), src.indexOf('AR_CHECKIN_FUSE') + 4000);
    check(/PROXY|proxy/.test(fuse) || /code === 7/.test(src),
        'код отказа прокси учитывается предохранителем — иначе он слеп ровно на новом классе отказа');
    check(/7/.test((src.match(/AR_AUTO_CHECKIN_FAIL[\s\S]{0,1200}/) || [''])[0]),
        'таблица сообщений дашборда знает код 7, иначе владелец увидит «код 7» без объяснения');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* песочница */ }

console.log(fail
    ? `\n❌ ${fail} провалено`
    : '\n✅ Подарок через прокси: seed одноразовый, неподдержанные схемы отвергнуты, отказ гасит запуск и виден пачке.');
process.exit(fail ? 1 : 0);
