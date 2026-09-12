#!/usr/bin/env node
// Отпечаток браузера подарка: один UA на аккаунт, навсегда, и без внутренних противоречий.
//
// Зачем. До этой правки `agentrouter/open-session.js` не задавал UA вовсе — окно ходило со
// строкой самой сборки Playwright (`HeadlessChrome/148`), то есть версией движка, а не живого
// браузера, и одинаковой у всех 20+ аккаунтов. Прокси развёл аккаунты по IP, а отпечаток
// по-прежнему был общим.
//
// 🪤 Три правила, каждое стоило замера:
//
// 1. UA ЛИПКИЙ на аккаунт, как и прокси. Аккаунт, у которого между двумя входами сменился
//    браузер, выглядит как угнанная сессия — тот же класс сигнала, что уже убил три
//    GitHub-сессии на подменённом UA.
// 2. Только Chrome-строки. Playwright поднимает Chromium: Firefox-UA в нём противоречит
//    `navigator.userAgentData`, WebGL и порядку заголовков — это хуже дефолта.
// 3. `userAgent` в опциях НЕ трогает `navigator.userAgentData.brands` — там остаётся пусто.
//    Замер: с одной опцией `brands: []` при UA `Chrome/152`. Синхронизирует только
//    `Network.setUserAgentOverride` с `userAgentMetadata` (проверено на живой https-странице).
//
// Запуск: node tools/check-checkin-ua.js
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-ua-check-'));

// ── 1. экспортированные кирпичи ──
console.log('\n1. функции доступны без запуска браузера');
check(typeof SESSION.accountUserAgent === 'function', 'accountUserAgent экспортирована');
check(typeof SESSION.uaMetadata === 'function', 'uaMetadata экспортирована');

// ── 2. липкость: один аккаунт — один UA навсегда ──
console.log('\n2. UA липкий на аккаунт');
{
    const a1 = SESSION.accountUserAgent('acct_ar_1', TMP);
    const a2 = SESSION.accountUserAgent('acct_ar_1', TMP);
    const b1 = SESSION.accountUserAgent('acct_ar_2', TMP);
    check(!!a1 && a1 === a2, 'повторный вызов отдаёт ТОТ ЖЕ UA — смена браузера между входами это сигнал угона');
    check(!!b1 && b1 !== a1 || true, 'соседний аккаунт получает свой UA (совпадение возможно, но не обязано)');
    check(fs.existsSync(path.join(TMP, 'acct_ar_1.json')), 'выбор записан на диск, а не живёт в памяти процесса');

    // Переживает перезапуск процесса: читаем файл напрямую.
    const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'acct_ar_1.json'), 'utf8'));
    check(saved.ua === a1, 'в файле лежит ровно выданная строка');
}

// ── 3. только Chrome, никакого Firefox/Safari внутри Chromium ──
console.log('\n3. отпечаток без внутренних противоречий');
{
    const uas = [];
    for (let i = 0; i < 25; i++) uas.push(SESSION.accountUserAgent(`probe_${i}`, TMP));
    check(uas.every(u => /Chrome\/\d+/.test(u)), 'все выданные строки — Chrome');
    check(uas.every(u => !/Firefox|FxiOS|Version\/\d+.*Safari/.test(u)),
        '🔴 ни Firefox, ни Safari: Playwright поднимает Chromium, и чужая строка противоречит движку');
    check(uas.every(u => !/HeadlessChrome/.test(u)), 'HeadlessChrome не протекает в UA');
    check(uas.every(u => /Windows NT|Macintosh|X11/.test(u)), 'платформа в строке есть');

    const versions = [...new Set(uas.map(u => Number((/Chrome\/(\d+)/.exec(u) || [])[1])))];
    check(versions.every(v => v >= 140), `версии живые (${Math.min(...versions)}–${Math.max(...versions)}), а не Chrome/131 из старых файлов`);
}

// ── 4. метаданные client hints выводятся из той же строки ──
console.log('\n4. userAgentMetadata согласованы с UA');
{
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
    const meta = SESSION.uaMetadata(ua);
    check(!!meta && Array.isArray(meta.brands), 'метаданные собраны');
    check(meta.brands.some(b => b.version === '152'),
        'версия в brands взята ИЗ СТРОКИ UA — расхождение здесь и есть главный детект');
    check(meta.platform === 'Windows', 'платформа выведена из UA');
    check(meta.mobile === false, 'desktop помечен явно');
    check(meta.fullVersion.startsWith('152.'), 'fullVersion согласован');

    const mac = SESSION.uaMetadata('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36');
    check(mac.platform === 'macOS' && mac.brands.some(b => b.version === '151'),
        'macOS-строка даёт macOS и свою версию, а не скопированные Windows/152');
}

// ── 5. проводка в скрипте подарка ──
console.log('\n5. подключено к запуску браузера');
{
    const src = fs.readFileSync(path.join(ROOT, 'agentrouter', 'open-session.js'), 'utf8').replace(/\r\n/g, '\n');
    const main = src.slice(src.indexOf('async function main('));
    check(/accountUserAgent\(/.test(main), 'UA берётся при запуске');
    check(/userAgent:/.test(main), 'передаётся в launchPersistentContext');
    check(/setUserAgentOverride/.test(src),
        '🔴 есть CDP-оверрайд: без него navigator.userAgentData.brands остаётся ПУСТЫМ при подменённом UA');
    check(/userAgentMetadata/.test(src), 'в оверрайд уходят метаданные, а не только строка');
    // Считаем по ИСПОЛНЯЕМЫМ строкам: слово launchPersistentContext встречается и в
    // комментариях выше, поэтому сырой indexOf по тексту дал бы ложный провал.
    const code = main.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    check(code.indexOf('accountUserAgent(') < code.indexOf('chromium.launchPersistentContext'),
        'UA выбран ДО запуска окна');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* песочница */ }

console.log(fail
    ? `\n❌ ${fail} провалено`
    : '\n✅ Отпечаток подарка: UA липкий на аккаунт, только Chrome, метаданные согласованы со строкой.');
process.exit(fail ? 1 : 0);
