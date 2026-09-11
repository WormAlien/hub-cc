#!/usr/bin/env node
// Пул прокси: разбор строк, ЛИПКАЯ привязка «аккаунт → прокси» и — главное — отсутствие
// тихого ухода напрямую.
//
// Зачем регресс. Замер 10.09: седьмой подряд автоподарок получил от публичной
// `GET /api/status` ПУСТОЕ тело — край режет домашний IP, с которого ходят 20+ аккаунтов.
// Лечится разными исходящими адресами, но у лекарства есть своя цена: у аккаунта живая
// GitHub-сессия, и подмена IP под ней заметнее антифроду, чем сам общий IP. Отсюда два
// правила, которые этот файл и стережёт:
//
//   1. привязка липкая и сама НЕ переназначается;
//   2. назначенный прокси мёртв → НЕ ИДТИ ВООБЩЕ, ни через другой, ни напрямую.
//
// 🪤 Класс ошибки, ради которого всё написано, живой и найден в этом репозитории:
// `freemodel/freemodel_autoreger_v3.js:119` на строке `socks5://…` молча возвращает null,
// после чего авторег уходит с домашнего IP и никто об этом не узнаёт. Проверки ниже
// требуют, чтобы КАЖДЫЙ отказ был громким.
//
// Сети здесь ровно столько, сколько нужно для проверки мёртвого прокси: порт 127.0.0.1:1
// отвечает мгновенным отказом соединения, наружу регресс не ходит.
//
// Запуск: node tools/check-proxy-pool.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.join(__dirname, '..', 'routing', 'lib', 'proxy-pool.js');
const PROXY = require(MODULE);

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-check-'));
const ASSIGN = path.join(TMP, 'proxy-assign.json');
const HOST = 'agentrouter.org';

// Регресс обязан жить в своей песочнице: боевой `routing/proxy-assign.json` и боевой
// конфиг трогать нельзя — там привязки живых аккаунтов.
//
// 🪤 Функция async и внутри ОБЯЗАТЕЛЬНО `await fn()`: без ожидания `finally` вернул бы env
// на место сразу после создания промиса, и проверки шли бы уже на чужой конфигурации.
async function withPool({ list = null, file = null, scheme = null, hosts = HOST, enabled = null }, fn) {
    const saved = { ...process.env };
    process.env.PROXY_POOL_ASSIGN = ASSIGN;
    if (list) process.env.PROXY_POOL = list.join(',');
    else delete process.env.PROXY_POOL;
    if (file) process.env.PROXY_POOL_FILE = file; else delete process.env.PROXY_POOL_FILE;
    if (scheme) process.env.PROXY_POOL_SCHEME = scheme; else delete process.env.PROXY_POOL_SCHEME;
    if (hosts) process.env.PROXY_POOL_HOSTS = hosts; else delete process.env.PROXY_POOL_HOSTS;
    if (enabled != null) process.env.PROXY_POOL_ENABLED = enabled; else delete process.env.PROXY_POOL_ENABLED;
    PROXY._reset();
    try { return await fn(); }
    finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
        PROXY._reset();
    }
}

const resetAssign = () => { try { fs.unlinkSync(ASSIGN); } catch { /* первого запуска ещё не было */ } };

(async () => {

// ── 1. разбор: URL, голый ip:port, креды, hostname ──
console.log('\n1. разбор строк');
{
    const url = PROXY.parseProxy('socks5://user:pa%40ss@1.2.3.4:1080');
    check(url && url.scheme === 'socks5' && url.hostname === '1.2.3.4' && url.port === 1080,
        'полный URL со схемой разобран');
    check(url && url.user === 'user' && url.pass === 'pa@ss',
        'креды раскодированы (%40 → @), а не взяты сырыми');

    const bare = PROXY.parseProxy('5.6.7.8:8080', 'socks5');
    check(bare && bare.scheme === 'socks5' && bare.port === 8080,
        'голый ip:port берёт схему из умолчания — это формат export/protocols/*.txt');

    const host = PROXY.parseProxy('http://gate.provider.com:7000');
    check(host && host.hostname === 'gate.provider.com',
        'hostname купленного шлюза принимается наравне с IPv4');

    check(PROXY.parseProxy('') === null && PROXY.parseProxy('# comment') === null
        && PROXY.parseProxy('мусор') === null && PROXY.parseProxy('1.2.3.4') === null,
        'пустая строка, комментарий, мусор и адрес без порта → null');
    check(PROXY.parseProxy('ftp://1.2.3.4:21') === null && PROXY.parseProxy('1.2.3.4:70000') === null,
        'чужая схема и порт вне диапазона отвергнуты');
    check(PROXY.schemeFromFilename('export/protocols/socks5.txt') === 'socks5'
        && PROXY.schemeFromFilename('export/all_valid.txt') === null,
        'схема берётся из имени файла, где она есть, и не выдумывается, где её нет');
}

// ── 2. смешанный список сохраняет схему каждой строки ──
console.log('\n2. mixed-список: схема у каждой строки своя');
{
    const { proxies, bad } = PROXY.parseList([
        'http://203.0.113.10:8080',
        'socks5://203.0.113.11:1080',
        'socks4://203.0.113.12:1080',
        'https://203.0.113.13:443',
        '203.0.113.14:3128',
        'сломанная строка',
    ], 'http');
    const got = proxies.map(p => `${p.scheme}:${p.port}`);
    check(got.join(',') === 'http:8080,socks5:1080,socks4:1080,https:443,http:3128',
        'у каждой строки своя схема, умолчание применяется только к голой');
    check(bad.length === 1 && bad[0] === 'сломанная строка',
        'неразобранная строка попадает в счётчик bad, а не теряется молча');
    check(PROXY.tunnelKind({ scheme: 'https' }) === 'http'
        && PROXY.tunnelKind({ scheme: 'socks4' }) === 'socks'
        && PROXY.tunnelKind({ scheme: 'ftp' }) === null,
        'диспетчеризация туннеля по схеме: CONNECT, socks, отказ');
}

// ── 3. id стабилен по содержанию, а не по позиции ──
console.log('\n3. id не зависит от порядка списка');
{
    const a = PROXY.parseList(['http://1.1.1.1:80', 'http://2.2.2.2:80']).proxies.map(p => p.id).sort();
    const b = PROXY.parseList(['http://2.2.2.2:80', 'http://1.1.1.1:80']).proxies.map(p => p.id).sort();
    check(a.join('|') === b.join('|'), 'перетасовка списка не меняет id — привязки переживают обновление файла');
    const withCreds = PROXY.parseProxy('http://user:pass@1.1.1.1:80');
    const without = PROXY.parseProxy('http://1.1.1.1:80');
    check(withCreds.id === without.id, 'смена пароля не рвёт привязку: кредов в id нет');
    check(!/pass/.test(withCreds.label) && !/pass/.test(withCreds.id), 'креды не протекают в label/id');
    const dup = PROXY.parseList(['http://1.1.1.1:80', 'http://1.1.1.1:80']).proxies;
    check(dup.length === 1, 'дубль строки не раздваивает запись пула');
}

// ── 4. липкость: тот же аккаунт получает тот же прокси ──
console.log('\n4. аккаунт A повторно получает свой прокси');
await withPool({ list: ['http://203.0.113.21:8080', 'http://203.0.113.22:8080'] }, async () => {
    resetAssign();
    const first = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
    const second = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
    check(first.ok && second.ok, 'оба вызова успешны');
    check(first.proxy.id === second.proxy.id, 'выдан тот же адрес');
    check(first.how === 'new' && second.how === 'sticky', 'второй раз это уже липкая привязка, а не новое назначение');
    check(fs.existsSync(ASSIGN), 'привязка записана на диск, а не живёт в памяти процесса');

    // Порядок в файле меняется при каждом обновлении списка скрапера — привязка обязана выжить.
    return withPool({ list: ['http://203.0.113.22:8080', 'http://203.0.113.21:8080'] }, async () => {
        const after = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
        check(after.ok && after.proxy.id === first.proxy.id, 'после перетасовки списка привязка та же');
    });
});

// ── 5. least-loaded: новому аккаунту достаётся наименее занятый ──
console.log('\n5. аккаунт B получает наименее нагруженный');
await withPool({ list: ['http://203.0.113.31:8080', 'http://203.0.113.32:8080'] }, async () => {
    resetAssign();
    const a = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
    const b = await PROXY.forAccount('ar_acct_B', { host: HOST, usePreflight: false });
    check(a.ok && b.ok && a.proxy.id !== b.proxy.id, 'второму аккаунту достался свободный адрес, а не тот же самый');
    const c = await PROXY.forAccount('ar_acct_C', { host: HOST, usePreflight: false });
    check(c.ok, 'третий аккаунт при двух прокси тоже обслужен');
    const load = PROXY.describe().load;
    check(load.every(x => x.accounts >= 1) && load.reduce((s, x) => s + x.accounts, 0) === 3,
        'раскладка ровная: 3 аккаунта на 2 прокси без перекоса в один');
});

// ── 6. назначенный прокси пропал или мёртв → отказ, НЕ подмена и НЕ direct ──
console.log('\n6. мёртвый прокси не превращается в тихий direct');
await withPool({ list: ['http://203.0.113.41:8080', 'http://203.0.113.42:8080'] }, async () => {
    resetAssign();
    const a = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
    const assigned = a.proxy.id;
    const other = assigned.includes('41') ? '203.0.113.42' : '203.0.113.41';

    // Назначенный исчез из списка: единственный оставшийся адрес подставлять нельзя.
    return withPool({ list: [`http://${other}:8080`] }, async () => {
        const gone = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
        check(gone.ok === false && gone.needsReassign === true, 'пропавший прокси → ok:false, needsReassign');
        check(!gone.proxy, 'замена молча НЕ подставлена');
        check(gone.direct !== true, 'и напрямую тоже не пошли');
        check(/release|reassign/.test(gone.error || ''), 'ошибка называет явный выход: release/reassign');
    });
});

await withPool({ list: ['http://127.0.0.1:1'] }, async () => {
    resetAssign();
    // 127.0.0.1:1 отвечает мгновенным ECONNREFUSED — живой отказ туннеля без выхода наружу.
    const dead = await PROXY.forAccount('ar_acct_DEAD', { host: HOST, usePreflight: true });
    check(dead.ok === false && dead.dead === true, 'неотвечающий прокси → ok:false, dead:true');
    check(dead.direct !== true, 'напрямую не пошли и на этой ветке');
    check(/НЕ пойду/.test(dead.error || ''), 'ошибка прямо говорит, что обхода не будет');
});

// ── 7. пул выключен → поведение ровно как раньше ──
console.log('\n7. пул не настроен — прежний direct');
await withPool({ list: ['http://203.0.113.51:8080'], enabled: '0' }, async () => {
    const off = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
    check(off.ok === true && off.proxy === null && off.direct === true,
        'выключенный пул отдаёт direct, а не ошибку');
});
await withPool({ list: ['http://203.0.113.51:8080'], hosts: 'other-gateway.example' }, async () => {
    const off = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
    check(off.ok === true && off.proxy === null && off.direct === true,
        'хост вне белого списка обслуживается напрямую, как до пула');
    check(PROXY.enabledForHost(HOST) === false && PROXY.enabledForHost('other-gateway.example') === true,
        'белый список хостов действует в обе стороны');
});

// ── 8. включён, но пустой/битый источник → громкий отказ ──
console.log('\n8. включён и пуст — это ошибка настройки, не разрешение идти напрямую');
{
    const emptyFile = path.join(TMP, 'empty-list.txt');
    fs.writeFileSync(emptyFile, '# только комментарий\nсовсем не прокси\n', 'utf8');
    await withPool({ file: emptyFile, enabled: '1' }, async () => {
        resetAssign();
        const r = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
        check(r.ok === false, 'пул включён, но пригодных строк нет → ok:false');
        check(r.direct !== true && !r.proxy, 'ни direct, ни случайный прокси');
        check(/не разобрана|пуст/.test(r.error || ''), 'ошибка объясняет причину, а не «что-то пошло не так»');
    });
    await withPool({ file: path.join(TMP, 'нет-такого-файла.txt'), enabled: '1' }, async () => {
        const r = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
        check(r.ok === false && /не читается/.test(r.error || ''), 'нечитаемый файл списка → отказ с путём');
    });
    await withPool({ list: ['http://203.0.113.61:8080'] }, async () => {
        resetAssign();
        const r = await PROXY.forAccount('', { host: HOST, usePreflight: false });
        check(r.ok === false && /ключ/.test(r.error || ''), 'без ключа привязки прокси вслепую не выдаётся');
    });
}

// ── 9. preflight: 200 сам по себе не пропуск ──
console.log('\n9. критерий preflight');
{
    const v = PROXY.preflightVerdict.bind(PROXY);
    check(v(200, JSON.stringify({ success: true, data: { x: 1 } })).ok === true, '200 + JSON → PASS');
    check(v(200, '').ok === false, '200 с ПУСТЫМ телом → FAIL (ровно тот отказ 10.09)');
    check(v(200, '   ').ok === false, '200 с пробелами вместо тела → FAIL');
    check(v(200, '<!doctype html><html>WAF</html>').ok === false, 'HTML-заглушка → FAIL');
    check(v(200, '{"success": tru').ok === false, 'битый JSON → FAIL');
    check(v(200, JSON.stringify({ success: false })).ok === false, 'success:false → FAIL');
    check([403, 404, 429, 407, 502].every(code => v(code, JSON.stringify({ success: true })).ok === false),
        '403/404/429/407/502 → FAIL, каким бы ни было тело');
}

// ── 10. параллельные назначения не теряют друг друга ──
console.log('\n10. параллельные привязки не затирают соседа');
await withPool({ list: ['http://203.0.113.71:8080', 'http://203.0.113.72:8080', 'http://203.0.113.73:8080'] }, async () => {
    resetAssign();
    // Пачка балансов идёт по три аккаунта разом — ровно та гонка, что лечат apSaveMerge и poolAppend.
    const keys = ['ar_p1', 'ar_p2', 'ar_p3', 'ar_p4', 'ar_p5', 'ar_p6'];
    const res = await Promise.all(keys.map(k => PROXY.forAccount(k, { host: HOST, usePreflight: false })));
    check(res.every(r => r.ok), 'все параллельные вызовы обслужены');
    const saved = PROXY.assignments();
    check(keys.every(k => saved[k] && saved[k].proxy), `на диске все ${keys.length} привязок, ни одна не затёрта`);
    check(keys.every(k => saved[k].proxy === res[keys.indexOf(k)].proxy.id),
        'записанное совпадает с выданным — никто не получил чужой адрес');
    check(PROXY.describe().orphans === 0, 'осиротевших привязок нет');
});

// ── 11. снять и переназначить может только явное решение ──
console.log('\n11. release/reassign — только вручную');
await withPool({ list: ['http://203.0.113.81:8080', 'http://203.0.113.82:8080'] }, async () => {
    resetAssign();
    const a = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
    const moved = PROXY.reassign('ar_acct_A', a.proxy.id.includes('81') ? 'http://203.0.113.82:8080' : 'http://203.0.113.81:8080');
    check(moved.ok && moved.proxy.id !== a.proxy.id, 'reassign переставляет адрес по явной просьбе');
    const after = await PROXY.forAccount('ar_acct_A', { host: HOST, usePreflight: false });
    check(after.ok && after.proxy.id === moved.proxy.id, 'после reassign липкость держит уже новый адрес');
    check(PROXY.reassign('ar_acct_A', 'http://198.51.100.9:9999').ok === false, 'назначить адрес не из пула нельзя');
    const prev = PROXY.release('ar_acct_A');
    check(prev && prev.proxy === moved.proxy.id, 'release возвращает снятую привязку');
    check(PROXY.assignmentFor('ar_acct_A') === null, 'после release привязки нет');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* временная песочница */ }

console.log(fail
    ? `\n❌ ${fail} провалено`
    : '\n✅ Пул прокси: разбор, липкость, least-loaded, отказ вместо тихого direct, preflight и параллельная запись.');
process.exit(fail ? 1 : 0);

})();
