#!/usr/bin/env node
// Regression: счётчик и отстой адреса - ротация под забор подарков AgentRouter.
//
// Зачем это вообще. Панель agentrouter режет ручку логина по IP: замер 20.09 дал
// ~19 запросов на адрес и окно отстоя ~20 минут (проба `_research/ar-ip-cooldown-probe.js`,
// воспроизведено дважды). Один перелогин дёргает ручку 3-4 раза - отсюда владельцевские
// «5-6 аккаунтов на IP». Пул обязан сам уводить адрес в отстой и возвращать его, иначе
// хаб продолжит светить сожжённым адресом и терять логины.
//
// Инварианты, каждый из которых ломается молча:
//   1. счётчик живёт НА АДРЕСЕ и переживает перезапуск `:8200`;
//   2. набравший порог адрес уходит в отстой и НЕ выдаётся под новые посадки;
//   3. когда в отстое ВСЕ - это не «нагрузка», а ожидание: очередь обязана узнать,
//      сколько ждать (ближайший, а не первый попавшийся);
//   4. отсидевший адрес возвращается с нулём, а не с прежним счётом;
//   5. ротация берёт НАИМЕНЕЕ использованный, иначе кольцо не расходится.
//
// Запуск: node tools/check-proxy-ledger.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PROXY = require(path.join(ROOT, 'routing', 'lib', 'proxy-pool.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-ledger-check-'));
const ASSIGN = path.join(TMP, 'proxy-assign.json');
const OWN = path.join(TMP, 'own-proxies.txt');
const SCRAPED = path.join(TMP, 'scraped.txt');
const HOST = 'agentrouter.org';

let fail = 0;
function check(ok, what) {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
}
function writeFile(file, lines) { fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
function ids() { return PROXY.pool().proxies.map(p => p.id); }

const ENV = {
    // 🪤 PROXY_POOL_FILE задаём ЯВНО, пустым: без него конфиг подтянул бы боевой
    // `tools/proxy-validator/export/live-for-host.txt`, и скраперный ярус уводил бы
    // pick() мимо отстоя - тест зеленел бы по неверной причине.
    PROXY_POOL_OWN_FILE: OWN, PROXY_POOL_FILE: SCRAPED, PROXY_POOL_OWN: null,
    PROXY_POOL_HOSTS: HOST, PROXY_POOL_PREFLIGHT_TTL: '0',
    PROXY_POOL_ROTATE_AFTER: '3', PROXY_POOL_COOLDOWN_MS: '60000',
};

(async () => {
    writeFile(OWN, ['http://user:pass@10.0.0.1:1080', 'http://10.0.0.2:1080', 'http://10.0.0.3:1080']);
    writeFile(SCRAPED, []);               // скраперный ярус пуст: меряем только ярус «свои»

    // ── 1. счётчик на адресе и переживает перезапуск ──
    console.log('\n1. счётчик живёт на адресе и переживает перезапуск');
    await withPool(ENV, async () => {
        resetAssign();
        const [a] = ids();
        check(PROXY.ledgerRow(a).used === 0, 'новый адрес - счёт 0');
        PROXY.spend(a, 1);
        PROXY.spend(a, 1);
        check(PROXY.ledgerRow(a).used === 2, 'два запроса дали счёт 2 (spend суммирует)');

        PROXY._reset();                       // перезапуск процесса
        const row = PROXY.ledgerRow(a);
        check(row.used === 2, 'счёт пережил перезапуск (живёт в файле привязок)');
        check(row.until == null, 'порог не превышен - отстоя нет');
    });

    // ── 2. порог отправляет адрес в отстой, и под посадку он не отдаётся ──
    console.log('\n2. порог → отстой, и адрес не выдаётся');
    await withPool(ENV, async () => {
        resetAssign();
        const [a, b] = ids();
        PROXY.spend(a, 3);                    // ровно порог
        const row = PROXY.ledgerRow(a);
        check(row.cooling === true, 'набравший порог адрес в отстое');
        check(row.until && Date.parse(row.until) > Date.now(), 'отстой смотрит в будущее');

        const picked = PROXY.pick(HOST);
        check(picked.proxy && picked.proxy.id !== a, 'pick не выдал адрес в отстое, пока есть живой');
        check(picked.proxy && picked.proxy.id === b, 'выдал живой адрес');
    });

    // ── 3. все в отстое - это ОЖИДАНИЕ с ближайшим временем, а не «нагрузка» ──
    console.log('\n3. все адреса в отстое → ждать, и знать сколько');
    await withPool(ENV, async () => {
        resetAssign();
        const [a, b, c] = ids();
        PROXY.spend(a, 3);
        await sleep(30);
        PROXY.spend(b, 3);
        await sleep(30);
        PROXY.spend(c, 3);

        const picked = PROXY.pick(HOST);
        check(picked.cooling === true, 'pick сказал «все в отстое», а не «нагрузка»');
        check(picked.saturated !== true, 'это не saturated - иначе очередь начнёт рвать пачку');
        check(typeof picked.untilMs === 'number' && picked.untilMs > Date.now(), 'названо время возврата');
        const soonest = Math.min(...[a, b, c].map(id => Date.parse(PROXY.ledgerRow(id).until)));
        check(Math.abs(picked.untilMs - soonest) < 1500, 'время возврата - БЛИЖАЙШЕГО, а не первого в пуле');
    });

    // ── 4. отсидевший адрес возвращается с нулём ──
    console.log('\n4. отстой истекает - адрес возвращается чистым');
    await withPool({ ...ENV, PROXY_POOL_COOLDOWN_MS: '400' }, async () => {
        resetAssign();
        const [a] = ids();
        PROXY.spend(a, 3);
        check(PROXY.ledgerRow(a).cooling === true, 'адрес в отстое');
        await sleep(600);
        const row = PROXY.ledgerRow(a);
        check(row.cooling === false, 'отсидев, адрес вернулся');
        check(row.used === 0, 'счёт обнулён, а не остался прежним');
        const picked = PROXY.pick(HOST);
        check(picked.proxy && picked.proxy.id === a, 'pick снова его выдаёт');
    });

    // ── 5. вращение берёт наименее использованный ──
    console.log('\n5. ротация берёт наименее использованный, а не первый в пуле');
    await withPool(ENV, async () => {
        resetAssign();
        const [a, b, c] = ids();
        PROXY.spend(a, 2);
        PROXY.spend(b, 1);
        const t1 = PROXY.rotateFor('ar_1', { host: HOST });
        check(t1 && t1.proxy && t1.proxy.id === c, 'первым взял адрес с нулём (c)');
        // Адрес «использован» не привязкой, а перелогином: счёт двигает spend.
        PROXY.spend(t1.proxy.id, 1);
        const t2 = PROXY.rotateFor('ar_2', { host: HOST });
        check(t2 && t2.proxy && t2.proxy.id === b, 'следом - наименее использованный (b)');
        check(PROXY.assignmentFor('ar_1').proxy === c, 'привязка записана');
        check(PROXY.assignmentFor('ar_1').host === HOST, 'хост записан в привязку');
    });

    // ── 6. ротация не берёт адрес в отстое, даже если он «свободен» ──
    console.log('\n6. отстой главнее свободности');
    await withPool(ENV, async () => {
        resetAssign();
        const [a, b, c] = ids();
        PROXY.spend(a, 3);                    // отстой
        const t1 = PROXY.rotateFor('ar_1', { host: HOST });
        check(t1.proxy.id !== a, 'сожжённый адрес не выдан под перелогин');
        PROXY.spend(t1.proxy.id, 3);
        const t2 = PROXY.rotateFor('ar_2', { host: HOST });
        check(t2.proxy.id !== a && t2.proxy.id !== t1.proxy.id, 'взял третий, а не сожжённые');
        PROXY.spend(t2.proxy.id, 3);
        const t3 = PROXY.rotateFor('ar_3', { host: HOST });
        check(t3.cooling === true, 'когда сожжены все - сказал ждать');
        PROXY._reset();
        check(PROXY.ledgerRow(a).cooling === true, 'отстой записан в файл, а не в памяти');
    });

    // ── 7. ротация не уходит на скраперный ярус ──
    // 🔴 Живой баг 20.09: у каждого своего адреса уже был привязан аккаунт, потолок
    // «аккаунтов на адрес» стал 1, ярус «свои» для pick выглядел ПОЛНЫМ - и ротация
    // молча уезжала на скраперные адреса. Свои при этом стояли живые и пустые.
    console.log('\n7. ротация остаётся в ярусе «свои», а не уходит на скрапер');
    await withPool(ENV, async () => {
        resetAssign();
        const own = ids();
        // Чужой ярус непустой и заведомо живой - соблазн «перелить» есть.
        writeFile(SCRAPED, ['http://203.0.113.11:8080', 'http://203.0.113.12:8080']);
        PROXY._reset();
        // Привязываем по аккаунту на каждый свой адрес: именно так выглядело в бою, и
        // потолок «аккаунтов на адрес» становился 1 - ярус «свои» для pick выглядел полным.
        own.forEach((id, i) => PROXY.rotateFor(`ar_${i}`, { host: HOST }));
        const t3 = PROXY.rotateFor('ar_more', { host: HOST });
        check(!t3.proxy || !/203\.0\.113\./.test(String(t3.proxy.id)),
            'ротация не выдала скраперный адрес, пока свои живы');
        own.forEach(id => PROXY.spend(id, 3));            // все свои в отстой
        const t4 = PROXY.rotateFor('ar_d', { host: HOST });
        check(t4.cooling === true, 'свои в отстое, а скраперные живы - ротация ЖДЁТ, а не переливает');
        check(!t4.proxy, 'скраперный адрес не выдан под перелогин');
    });

    // ── 8. известный мёртвый адрес не выдаётся под перелогин ──
    // Ротация ходит без сетевых проб (иначе решение перестало бы быть повторяемым), поэтому
    // мёртвых ей называет вызывающий - из кеша здоровья пула. Тест проверяет, что названный
    // адрес действительно исключается, а не «просто передаётся».
    console.log('\n8. названный мёртвым адрес не идёт в ротацию');
    await withPool(ENV, async () => {
        resetAssign();
        const [a, b, c] = ids();
        const t1 = PROXY.rotateFor('ar_1', { host: HOST, exclude: [a, b] });
        check(t1.proxy && t1.proxy.id === c, 'из трёх живых с исключением двух взял третьего');
        const t2 = PROXY.rotateFor('ar_2', { host: HOST, exclude: [a, b, c] });
        check(!t2.proxy, 'все исключены - адрес не выдан (а не «взял хоть какой-нибудь»)');
        check(t2.saturated === true || t2.cooling === true, 'сказано, почему адреса нет');
    });

    // ── 9. выбор источника: свой / скрапер / напрямую ──
    // Решение владельца 20.09: свой пул уже есть, и скрапер больше не обязателен -
    // источник выбирает человек. Ключевое: `own` НЕ переливает в скрапер молча.
    console.log('\n9. выбор источника прокси');
    writeFile(OWN, ['http://u:p@10.0.0.1:1080', 'http://10.0.0.2:1080']);
    writeFile(SCRAPED, ['http://203.0.113.11:8080', 'http://203.0.113.12:8080']);

    await withPool({ ...ENV, PROXY_POOL_SOURCE: 'own' }, async () => {
        resetAssign();
        const picked = PROXY.pick(HOST);
        check(picked.proxy && picked.tier === 'own', 'источник «свой» - выдаётся только свой ярус');
        check(!/203\.0\.113\./.test(String(picked.proxy && picked.proxy.id)), 'скраперный адрес не подмешан');
    });

    await withPool({ ...ENV, PROXY_POOL_SOURCE: 'scraped' }, async () => {
        resetAssign();
        const picked = PROXY.pick(HOST);
        check(picked.proxy && picked.tier === 'scraped', 'источник «скрапер» - выдаётся только скрапер');
        check(/203\.0\.113\./.test(String(picked.proxy && picked.proxy.id)), 'свой адрес не подмешан');
    });

    await withPool({ ...ENV, PROXY_POOL_SOURCE: 'own' }, async () => {
        resetAssign();
        ids().filter(id => id.startsWith('http://10.0.0.')).forEach(id => PROXY.spend(id, 3));
        const picked = PROXY.pick(HOST);
        check(picked.cooling === true, 'свои в отстое при источнике «свой» - ЖДЁМ, а не берём скрапер');
        check(!picked.proxy, 'скраперный адрес не выдан вместо своего');
    });

    await withPool({ ...ENV, PROXY_POOL_SOURCE: 'direct' }, async () => {
        resetAssign();
        const c = PROXY.rotateFor('ar_1', { host: HOST });
        check(c.ok === true && c.proxy === null && c.direct === true,
            'источник «напрямую»: ротация не ошибка, а окно без прокси');
        const forAcc = await PROXY.forAccount('ar_2', { host: HOST, usePreflight: false });
        check(forAcc.ok === true && forAcc.direct === true, 'посадка тоже уходит напрямую');
    });

    // ── 10. ребаланс по хосту не трогает чужие хосты ──
    // 🔴 Живой случай 20.09: вкладка просит план для agentrouter.org, а он приносит
    // перемещения по aikeysapi, rumeng, odyssey и десяткам записей без хоста. Применение
    // такого плана двигает привязки чужих шлюзов - чинит один хост, ломая четыре.
    console.log('\n10. ребаланс по хосту не трогает чужие хосты');
    const OTHER_HOST = 'api.rumeng-ai.com';
    await withPool(ENV, async () => {
        resetAssign();
        // Две осиротевшие привязки: одна на наш хост, вторая - на чужой. Пишем файл напрямую:
        // `writeAssign` наружу не экспортируется (и не должен - это внутренняя запись).
        fs.writeFileSync(ASSIGN, JSON.stringify({
            version: 1,
            assign: {
                ar_1: { proxy: 'http://203.0.113.99:8080', at: '2026-01-01T00:00:00.000Z', why: 'тест', host: HOST, tier: 'scraped' },
                rm_1: { proxy: 'http://203.0.113.98:8080', at: '2026-01-01T00:00:00.000Z', why: 'тест', host: OTHER_HOST, tier: 'scraped' },
            },
        }, null, 1), 'utf8');
        PROXY._reset();
        const plan = PROXY.rebalancePlan({ host: HOST });
        const keys = (plan.moves || []).map(m => m.key);
        check(keys.includes('ar_1'), 'осиротевшая привязка СВОЕГО хоста попала в план');
        check(!keys.includes('rm_1'), 'привязка ЧУЖОГО хоста в план не попала');
        check((plan.moves || []).every(m => m.host === HOST), 'в плане нет ни одного чужого хоста');
    });

    // ── 11. выбор источника важнее липкости ──
    // 🔴 Иначе выбор работает только на бумаге: аккаунт сидит на скраперной привязке,
    // человек включает «только свой», а чеки продолжают идти по скраперу.
    console.log('\n11. источник важнее липкой привязки');
    await withPool(ENV, async () => {
        resetAssign();
        fs.writeFileSync(ASSIGN, JSON.stringify({
            version: 1,
            assign: { ar_old: { proxy: 'http://203.0.113.11:8080', at: '2026-01-01T00:00:00.000Z', why: 'старое', host: HOST, tier: 'scraped' } },
        }, null, 1), 'utf8');
        writeFile(SCRAPED, ['http://203.0.113.11:8080', 'http://203.0.113.12:8080']);
        process.env.PROXY_POOL_SOURCE = 'own';
        PROXY._reset();
        const r = await PROXY.forAccount('ar_old', { host: HOST, usePreflight: false });
        check(r.ok === true && r.proxy && PROXY.tierOf(r.proxy.id) === 'own',
            'аккаунт со скраперной привязкой переехал на свой адрес');
        check(/203\.0\.113\./.test(String(PROXY.assignmentFor('ar_old').proxy || '')) === false,
            'прежняя скраперная привязка заменена, а не оставлена рядом');
    });

    await withPool(ENV, async () => {
        resetAssign();
        fs.writeFileSync(ASSIGN, JSON.stringify({
            version: 1,
            assign: { ar_own: { proxy: 'http://10.0.0.1:1080', at: '2026-01-01T00:00:00.000Z', why: 'старое', host: HOST, tier: 'own' } },
        }, null, 1), 'utf8');
        process.env.PROXY_POOL_SOURCE = 'scraped';
        PROXY._reset();
        const r = await PROXY.forAccount('ar_own', { host: HOST, usePreflight: false });
        check(r.ok === true && r.proxy && !String(r.proxy.id).startsWith('http://10.0.0.'),
            'выбрали скрапер - свой адрес заменён скраперным');
        check(/203\.0\.113\.|socks/.test(String(PROXY.assignmentFor('ar_own').proxy || '')),
            'в привязке теперь скраперный адрес');
    });

    console.log(fail ? `\nПРОВАЛОВ: ${fail}` : '\nвсе проверки прошли');
    process.exit(fail ? 1 : 0);
})();
