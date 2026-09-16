#!/usr/bin/env node
// Regression: мэппинг «прокси × хост» для чеков баланса.
//
// Что проверяется и почему именно это. Пул отдаёт аккаунту липкий прокси, и до 15.09
// нагрузка считалась ГЛОБАЛЬНО (`leastLoaded`), а лимит у каждой панели свой. Плюс свои
// прокси владельца жили бы в том же файле, что и выгрузка скрапера, - а её долив режет
// список по cap и однажды вымыл бы купленные адреса.
//
// Тест держит три инварианта, каждый из которых до правки был нарушен:
//   1. свои прокси приоритетнее скрапера, но переполнение яруса переливается, а не молчит;
//   2. лимит считается НА ПАРУ прокси × хост, а не на аккаунт вообще;
//   3. ребаланс двигает только осиротевшие привязки и перевес - живую не трогает.
//
// Запуск: node tools/check-proxy-mapping.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PROXY = require(path.join(ROOT, 'routing', 'lib', 'proxy-pool.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-map-check-'));
const ASSIGN = path.join(TMP, 'proxy-assign.json');
const OWN = path.join(TMP, 'own-proxies.txt');
const SCRAPED = path.join(TMP, 'scraped.txt');
const HOST = 'agentrouter.org';
const OTHER = 'api.rumeng-ai.com';

let fail = 0;
function check(ok, what) {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
}

function writeFile(file, lines) { fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8'); }

// Песочница: боевые routing/proxy-assign.json и routing/own-proxies.txt не трогаем -
// там привязки живых аккаунтов.
async function withPool(env, fn) {
    const saved = { ...process.env };
    process.env.PROXY_POOL_ASSIGN = ASSIGN;
    for (const [k, v] of Object.entries(env)) {
        if (v == null) delete process.env[k];
        else process.env[k] = String(v);
    }
    PROXY._reset();
    try { return await fn(); }
    finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
        PROXY._reset();
    }
}

function resetAssign() { try { fs.rmSync(ASSIGN, { force: true }); } catch { /* нет файла - и хорошо */ } }

// ── 1. ярусы: свои отдельно и первыми ──
console.log('\n1. свои прокси - отдельный ярус, приоритет над скрапером');
(async () => {
writeFile(OWN, ['socks5://10.0.0.1:1080', 'socks5://10.0.0.2:1080']);
writeFile(SCRAPED, ['http://203.0.113.11:8080', 'http://203.0.113.12:8080']);

await withPool({
    PROXY_POOL_OWN_FILE: OWN, PROXY_POOL_FILE: SCRAPED,
    PROXY_POOL_HOSTS: HOST, PROXY_POOL_PREFLIGHT_TTL: '0',
}, async () => {
    resetAssign();
    const t = PROXY.tiers();
    check(t.own.length === 2, `свой ярус прочитан отдельно (${t.own.length} из 2)`);
    check(t.scraped.length === 2, `скрапер прочитан отдельно (${t.scraped.length} из 2)`);
    const p = PROXY.pool();
    check(p.proxies.length === 4, `пул отдаёт объединение (${p.proxies.length} из 4)`);
    check(p.proxies[0].id === 'socks5://10.0.0.1:1080', 'свои идут ПЕРВЫМИ, когда ownFirst');
    check(PROXY.tierOf('socks5://10.0.0.1:1080') === 'own', 'tierOf называет свой ярус');
    check(PROXY.tierOf('http://203.0.113.11:8080') === 'scraped', 'tierOf называет скраперный ярус');
    const r = await PROXY.forAccount('ar_a1', { host: HOST, usePreflight: false });
    check(r.ok && r.tier === 'own', `новый аккаунт сел на СВОЙ прокси (tier=${r.tier})`);
});

// ── 2. свой прокси не вымывается доливом скрапера ──
console.log('\n2. долив скрапера не трогает свой ярус');
await withPool({
    PROXY_POOL_OWN_FILE: OWN, PROXY_POOL_FILE: SCRAPED,
    PROXY_POOL_HOSTS: HOST, PROXY_POOL_PREFLIGHT_TTL: '0',
}, async () => {
    // Долив в файл скрапера пишет ТОЛЬКО в него - свой файл он не знает по устройству.
    writeFile(SCRAPED, ['http://203.0.113.11:8080', 'http://203.0.113.99:8080']);
    PROXY._reset();
    const t = PROXY.tiers();
    check(t.own.length === 2 && t.own[0].id === 'socks5://10.0.0.1:1080', 'свои на месте после долива скрапера');
    check(t.scraped.length === 2, 'скрапер обновился');
});

// ── 3. ёмкость считается на пару прокси × хост ──
console.log('\n3. лимит maxPerHost - на прокси И на хост, а не на аккаунт вообще');
await withPool({
    PROXY_POOL_OWN: 'socks5://10.0.0.1:1080', PROXY_POOL_FILE: SCRAPED,
    PROXY_POOL_HOSTS: HOST + ',' + OTHER, PROXY_POOL_PREFLIGHT_TTL: '0',
    PROXY_POOL_MAX_PER_HOST: JSON.stringify({ '*': 1 }),
}, async () => {
    resetAssign();
    writeFile(SCRAPED, ['http://203.0.113.11:8080', 'http://203.0.113.12:8080']);
    PROXY._reset();
    const a = await PROXY.forAccount('ar_a1', { host: HOST, usePreflight: false });
    const b = await PROXY.forAccount('ar_a2', { host: HOST, usePreflight: false });
    check(a.ok && a.proxy.id === 'socks5://10.0.0.1:1080', 'первый аккаунт забрал свой прокси');
    check(b.ok && b.proxy.id !== a.proxy.id, 'второй НЕ сел на тот же адрес: лимит 1 на пару');
    check(b.tier === 'scraped', 'второй перелился на скрапер, а не остался без прокси');

    // Тот же прокси, но ДРУГОЙ хост - там места ещё нет, значит лимит именно парный.
    const c = await PROXY.forAccount('rm_a1', { host: OTHER, usePreflight: false });
    check(c.ok && c.proxy.id === 'socks5://10.0.0.1:1080', 'на другом хосте свой прокси снова свободен');

    const load = PROXY.hostLoad(HOST);
    check((load.get('socks5://10.0.0.1:1080') || 0) === 1, 'нагрузка на хосте считает ровно 1');
});

// ── 4. хост выводится из ключа у старых привязок ──
console.log('\n4. старые привязки без поля host не сваливаются в один бакет');
await withPool({
    PROXY_POOL_OWN: 'socks5://10.0.0.1:1080', PROXY_POOL_FILE: SCRAPED,
    PROXY_POOL_HOSTS: HOST + ',' + OTHER, PROXY_POOL_PREFLIGHT_TTL: '0',
}, async () => {
    resetAssign();
    // Записи в формате ДО правки: поля host нет вовсе.
    fs.writeFileSync(ASSIGN, JSON.stringify({
        version: 1,
        assign: {
            'ar_1789000000001_1': { proxy: 'http://203.0.113.11:8080', at: '2026-09-01T00:00:00.000Z' },
            'aikeysapi:old@fpklm.com': { proxy: 'http://203.0.113.12:8080', at: '2026-09-01T00:00:00.000Z' },
        },
    }, null, 2), 'utf8');
    PROXY._reset();
    const d = PROXY.describe();
    const hosts = d.byHost.map(h => h.host).sort();
    check(hosts.includes('agentrouter.org'), 'ключ `ar_…` вывел agentrouter.org, а не unknown');
    check(hosts.includes('www.aikeysapi.com'), 'ключ `aikeysapi:…` вывел свою панель');
    check(!hosts.includes('unknown') || d.byHost.find(h => h.host === 'unknown').proxies.length === 0,
        'в unknown не осталось выводимых привязок');
});

// ── 5. ребаланс: живое не трогает, осиротевшее перевешивает ──
console.log('\n5. ребаланс двигает осиротевшие, живую привязку не трогает');
await withPool({
    PROXY_POOL_OWN_FILE: OWN, PROXY_POOL_FILE: SCRAPED,
    PROXY_POOL_HOSTS: HOST, PROXY_POOL_PREFLIGHT_TTL: '0',
}, async () => {
    resetAssign();
    writeFile(SCRAPED, ['http://203.0.113.11:8080', 'http://203.0.113.12:8080']);
    PROXY._reset();
    const live = await PROXY.forAccount('ar_live', { host: HOST, usePreflight: false });
    // Осиротевшая привязка: адреса нет ни в одном ярусе.
    const doc = JSON.parse(fs.readFileSync(ASSIGN, 'utf8'));
    doc.assign['ar_gone'] = { proxy: 'http://198.51.100.77:3128', at: '2026-09-01T00:00:00.000Z' };
    fs.writeFileSync(ASSIGN, JSON.stringify(doc, null, 2), 'utf8');
    PROXY._reset();

    const plan = PROXY.rebalancePlan();
    const keysMoved = plan.moves.map(m => m.key);
    check(keysMoved.includes('ar_gone'), 'осиротевшая привязка в плане');
    check(!keysMoved.includes('ar_live'), 'ЖИВАЯ привязка в план не попала');
    check(plan.moves.find(m => m.key === 'ar_gone').why.includes('исчез'), 'причина названа прямо');

    const res = PROXY.applyRebalance(plan);
    check(res.applied === 1, `применено ровно одно перемещение (${res.applied})`);
    const after = PROXY.assignmentFor('ar_gone');
    check(after && after.proxy !== 'http://198.51.100.77:3128', 'осиротевший получил живой адрес');
    const liveAfter = PROXY.assignmentFor('ar_live');
    check(liveAfter && liveAfter.proxy === live.proxy.id, 'живая привязка осталась прежней');
});

// ── 6. свой осиротевший ждёт владельца, а не перевешивается сам ──
console.log('\n6. осиротевший СВОЙ прокси не перевешивается автоматикой');
await withPool({
    PROXY_POOL_OWN_FILE: OWN, PROXY_POOL_FILE: SCRAPED,
    PROXY_POOL_HOSTS: HOST, PROXY_POOL_PREFLIGHT_TTL: '0',
}, async () => {
    resetAssign();
    writeFile(OWN, ['socks5://10.0.0.1:1080']);
    writeFile(SCRAPED, ['http://203.0.113.11:8080']);
    PROXY._reset();
    await PROXY.forAccount('ar_own1', { host: HOST, usePreflight: false });
    // Свой прокси исчез из своего файла - у аккаунта при этом живая сессия.
    writeFile(OWN, ['socks5://10.0.0.9:1080']);
    // 🪤 Чистим память ПОЛНОСТЬЮ - так выглядит перезапуск дашборда. История яруса
    // обязана уцелеть: она лежит в файле привязок рядом с ними. Если бы жила только в
    // памяти, после рестарта свой осиротевший выглядел бы скраперным и был бы перевешен
    // автоматикой молча.
    PROXY._reset();
    const plan = PROXY.rebalancePlan();
    check(!plan.moves.map(m => m.key).includes('ar_own1'), 'автоматика его не двигает');
    check(plan.skipped.map(s => s.key).includes('ar_own1'), 'он в skipped - решение за владельцем');
});

// ── 7. перелив ярусов и отказ, когда места нет нигде ──
//
// 🪤 Здесь ЯВНЫЙ предел хоста, а не ключ `*`. `*` с 15.09 не читается: потолок считается
// из размера пула, и звёздочка вернула бы ту жёсткость, от которой уходим. Проверяем
// именно ветку ручной настройки - она остаётся сильнее формулы.
console.log('\n7. перелив при переполнении и внятный отказ, когда мест нет нигде');
await withPool({
    PROXY_POOL_OWN: 'socks5://10.0.0.1:1080', PROXY_POOL_FILE: SCRAPED,
    PROXY_POOL_HOSTS: HOST, PROXY_POOL_PREFLIGHT_TTL: '0',
    PROXY_POOL_MAX_PER_HOST: JSON.stringify({ [HOST]: 1 }),
}, async () => {
    resetAssign();
    writeFile(SCRAPED, ['http://203.0.113.11:8080']);
    PROXY._reset();
    await PROXY.forAccount('ar_a1', { host: HOST, usePreflight: false });   // свой
    const b = await PROXY.forAccount('ar_a2', { host: HOST, usePreflight: false }); // скрапер
    check(b.ok && b.tier === 'scraped', 'перелив на скрапер, когда свои заняты');
    const c = await PROXY.forAccount('ar_a3', { host: HOST, usePreflight: false });
    check(c.ok === false && c.saturated === true, 'мест нет нигде → отказ saturated');
    check(c.proxy === undefined, 'напрямую не выдаётся ни при каком раскладе');
    check(/прокси/.test(c.error), 'ошибка называет лечение - добавить прокси');
});

// ── 7b. потолок САМ подстраивается под размер пула ──
//
// Это главное требование владельца 15.09: «у меня 5-6, а у других юзеров может быть и
// меньше, и больше». Никто ничего не настраивает - формула делит аккаунты на рабочие
// прокси. Проверяем три размера пула на одном и том же числе аккаунтов.
console.log('\n7b. потолок подстраивается под размер пула');
for (const [nProxies, expected] of [[2, 3], [3, 2], [6, 1]]) {
    await withPool({
        PROXY_POOL_OWN: Array.from({ length: nProxies }, (_, i) => `socks5://10.0.0.${i + 1}:1080`).join(','),
        PROXY_POOL_FILE: SCRAPED, PROXY_POOL_HOSTS: HOST, PROXY_POOL_PREFLIGHT_TTL: '0',
    }, async () => {
        resetAssign();
        writeFile(SCRAPED, []);
        PROXY._reset();
        const keys = Array.from({ length: 6 }, (_, i) => `ar_p${i + 1}`);
        const res = await Promise.all(keys.map(k => PROXY.forAccount(k, { host: HOST, usePreflight: false })));
        const ok = res.filter(r => r.ok).length;
        const spread = new Set(res.filter(r => r.ok).map(r => r.proxy.id)).size;
        check(ok === 6, `${nProxies} прокси: расселись все 6 аккаунтов (${ok})`);
        check(spread === Math.min(nProxies, 6), `${nProxies} прокси: задействовано адресов ${spread}`);
        check(PROXY.maxPerHostFor(HOST) <= expected + 1,
            `${nProxies} прокси: потолок ${PROXY.maxPerHostFor(HOST)} соразмерен пулу`);
    });
}

// ── 9. форматы строк, в которых прокси реально приходят ──
//
// Зачем отдельный блок: продавцы и друзья дают прокси вразнобой, и самая опасная форма -
// `ip:port:login:pass`. Отданная URL-парсеру, она МОЛЧА теряет логин с паролем: прокси
// остаётся «рабочим», только анонимным, и упрётся в чужой лимит без внятной причины.
// Поэтому проверяем не только «разобралось», но и что креды УЦЕЛЕЛИ.
console.log('\n9. форматы: URL, магазинная, голая');
const FMT = [
    // [строка, что ждём: host, port, user, pass]
    ['socks5://5MVqczzJ:kWtuvZnN@154.221.51.42:64117', '154.221.51.42', 64117, '5MVqczzJ', 'kWtuvZnN'],
    ['154.219.251.60:63848:WpUL16FvW:rYw2GBb2A', '154.219.251.60', 63848, 'WpUL16FvW', 'rYw2GBb2A'],
    ['185.104.150.84:63624:FSanaM1bk:Cm46C3cLn', '185.104.150.84', 63624, 'FSanaM1bk', 'Cm46C3cLn'],
    ['103.118.85.144:1080', '103.118.85.144', 1080, '', ''],
    ['socks5://1.2.3.4:1080', '1.2.3.4', 1080, '', ''],          // схема БЕЗ кредов
    ['http://1.2.3.4:80', '1.2.3.4', 80, '', ''],                 // порт по умолчанию не срезан
];
for (const [line, host, port, user, pass] of FMT) {
    const r = PROXY.parseProxy(line, 'socks5');
    const ok = r && r.hostname === host && r.port === port && (r.user || '') === user && (r.pass || '') === pass;
    check(ok, `разобрано с кредами: ${line}`);
}
// Круг «собрать → разобрать» со стороны ПУЛА: вкладка экранирует пароль в строке, пул
// обязан вернуть его обратно. Экранирование проверяется в check-proxies-tab.js - там, где
// сборка и живёт. Здесь только обратная половина, иначе обе стороны окажутся в одном месте
// и рассинхрон между ними никто не поймает.
const esc = PROXY.parseProxy('socks5://user:pa%40ss%3Awith%23specials@1.2.3.4:1080', 'socks5');
check(!!(esc && esc.pass === 'pa@ss:with#specials' && esc.user === 'user'),
    'экранированный пароль возвращается раскодированным');

check(PROXY.parseProxy('Привет:мир', 'socks5') === null, 'мусор отвергнут, а не понят как прокси');
check(PROXY.parseProxy('1.2.3.4:99999:u:p', 'socks5') === null, 'битый порт отвергнут');
check(!PROXY.parseProxy('socks5://1.2.3.4:1080', 'socks5').scheme.includes('://'),
    'схема из URL не потерялась в магазинной ветке');


// ── 10. хост вне пула не ребалансируется ──
//
// 🔴 Дефект, который это стережёт: у хоста, которого пул не обслуживает, потолок равен
// нулю, поэтому КАЖДАЯ его привязка выглядела «сверх потолка» - и план предлагал сдвинуть
// привязки провайдеров, которых пул не знает, с причиной «на прокси уже 0 аккаунтов».
// Замер 15.09 на живых данных: из 21 перемещения 15 были такими.
console.log('\n10. план не трогает хосты вне пула');
await withPool({
    PROXY_POOL_OWN: 'socks5://10.0.0.1:1080', PROXY_POOL_FILE: SCRAPED,
    PROXY_POOL_HOSTS: HOST, PROXY_POOL_PREFLIGHT_TTL: '0',
}, async () => {
    resetAssign();
    writeFile(SCRAPED, ['http://203.0.113.11:8080']);
    // Две привязки: одна на обслуживаемый хост, вторая - на чужой ему.
    fs.writeFileSync(ASSIGN, JSON.stringify({
        version: 1,
        assign: {
            'ar_alive': { proxy: 'http://203.0.113.11:8080', at: '2026-09-01T00:00:00.000Z', host: HOST },
            'aikeysapi:dead@fpklm.com': { proxy: 'http://203.0.113.11:8080', at: '2026-09-01T00:00:00.000Z', host: 'www.aikeysapi.com' },
        },
    }, null, 2), 'utf8');
    PROXY._reset();
    const plan = PROXY.rebalancePlan();
    check(!plan.moves.some(m => m.host === 'www.aikeysapi.com'), 'чужой хост не попал в перемещения');
    check(plan.skipped.some(s => s.key === 'aikeysapi:dead@fpklm.com'), 'он попал в пропущенные с причиной');
    check(!/уже 0 аккаунтов/.test(JSON.stringify(plan)),
        'нет самопротиворечивой причины «уже 0 аккаунтов»');
});

// ── 10b. чужие записи не раздувают потолок и не прячут настоящий перевес ──
//
// 🔴 Дефект, который это стережёт, - ЗЕРКАЛЬНЫЙ блоку 10 и пришёл вместе с его правкой.
// Вычистив чужие хосты из плана, легко оставить их в ЧИСЛИТЕЛЕ потолка: `capacity()` тогда
// печатает густоту по обслуживаемым хостам, а `maxPerHostFor()` делит весь файл целиком.
// Потолок раздувается ровно во столько раз, сколько в файле чужих записей, и настоящий
// перевес уходит под него - молча, без единой ошибки.
//
// Замер 16.09 на живых данных: 28 привязок AgentRouter на 39 адресов давали потолок
// `ceil(44/39)=2` вместо `ceil(28/39)=1`, и план показывал 0 перемещений вместо 6.
//
// 🪤 Блок 10 этот случай НЕ ловит: там одна привязка обслуживаемого хоста на один прокси,
// перевес невозможен по построению, и блок зелёный при любом числителе.
console.log('\n10b. чужие записи не раздувают потолок');
await withPool({
    PROXY_POOL_OWN: 'socks5://10.0.0.1:1080,socks5://10.0.0.2:1080',
    PROXY_POOL_FILE: SCRAPED, PROXY_POOL_HOSTS: HOST, PROXY_POOL_PREFLIGHT_TTL: '0',
}, async () => {
    resetAssign();
    writeFile(SCRAPED, []);
    PROXY._reset();

    const DENSE = 'socks5://10.0.0.1:1080';
    // Два аккаунта обслуживаемого хоста на ОДНОМ адресе при двух адресах в пуле - это
    // перевес: потолок обязан выйти 1.
    const assign = {
        ar_one: { proxy: DENSE, at: '2026-09-01T00:00:00.000Z', host: HOST },
        ar_two: { proxy: DENSE, at: '2026-09-02T00:00:00.000Z', host: HOST },
    };
    // Четыре записи провайдера, которого пул не обслуживает. В ёмкость они входить не
    // должны ВООБЩЕ - ни в густоту, ни в потолок.
    for (let i = 1; i <= 4; i++) {
        assign[`rumeng:dead${i}@fpklm.com`] = { proxy: DENSE, at: '2026-09-01T00:00:00.000Z', host: OTHER };
    }
    fs.writeFileSync(ASSIGN, JSON.stringify({ version: 1, assign }, null, 2), 'utf8');
    PROXY._reset();

    const c = PROXY.capacity();
    check(c.assigned === 2, `густота считает только обслуживаемые (${c.assigned} из 2)`);
    check(c.assignedAll === 6, `чужие видны отдельной справкой, а не в расчёте (${c.assignedAll} из 6)`);
    check(c.limit === 1, `потолок ${c.limit}: посчитан от 2 привязок, а не от 6`);
    // 🔴 Инвариант против повторного расхождения: потолок обязан выводиться из ТЕХ ЖЕ
    // чисел, которые вкладка печатает рядом с ним. Пока это одна формула на два места,
    // числители будут разъезжаться снова.
    check(c.limit === Math.max(1, Math.ceil(c.assigned / c.liveProxies)),
        'потолок согласован с цифрами, напечатанными рядом с ним');

    const plan = PROXY.rebalancePlan();
    check(plan.moves.length === 1, `настоящий перевес найден (${plan.moves.length} из 1)`);
    check(plan.moves.every(m => m.host === HOST), 'двигается только обслуживаемый хост');
    check(plan.moves.every(m => m.key === 'ar_two'), 'двигается самая свежая привязка, сессия моложе');
    check(plan.skipped.filter(s => s.host === OTHER).length === 4, 'четыре чужие - в пропущенных');
});

// ── 8. живой регресс на боевом пуле не падает ──
console.log('\n8. describe на боевой конфигурации не падает');
try {
    PROXY._reset();
    const d = PROXY.describe();
    check(typeof d.own === 'number' && typeof d.scraped === 'number', 'ярусы названы числами');
    check(Array.isArray(d.byHost), 'матрица по хостам отдана');
    check(d.byHost.every(h => Array.isArray(h.proxies)), 'внутри хостов - список прокси со счётчиками');
    check(typeof d.ownError !== 'undefined', 'ownError присутствует (null, если файла нет)');
} catch (e) {
    check(false, `describe упал: ${e.message}`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* временная песочница */ }

console.log(fail
    ? `\n❌ ${fail} провалено`
    : '\n✅ Мэппинг прокси × хост: ярусы, приоритет своих, ёмкость на пару, ребаланс без сноса живых.');
process.exit(fail ? 1 : 0);
})();
