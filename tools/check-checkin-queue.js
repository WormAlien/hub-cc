#!/usr/bin/env node
// Очередь чек-инов: залп по кнопкам ⚡/🎁 не отбивается, а идёт конвейером (25.08),
// и с 10.09 конвейеров ДВА — ручной 🎁 и автоматический ⚡ не ждут друг друга.
//
// Было (25.08): три окна сразу, четвёртый клик — 429 «уже открыто 3 браузера». Плюс шлюз
// ловил нас на частоте и выключал точный баланс всему пулу. Стало: один прогон за раз
// плюс пауза между стартами; клик отвечает «N в очереди, старт через ~Xс».
//
// Было (до 10.09): «занято» считалось по ЛЮБОМУ живому окну ЛК — а ручное окно 🎁 по
// замыслу ждёт человека до 10 минут. Одно забытое открытым окно держало весь конвейер ⚡
// ровно эти 10 минут (замер: pid 22352 висел с 04:24:56). Плюс `handleArCheckinStatus`
// выбрасывал по TTL записи со `state !== 'running'`, то есть И `queued`: задание теряло
// карточку статуса, оставаясь в очереди, наблюдатель на фронте молча сдавался, а окно
// потом всплывало ниоткуда.
//
// Запуск: node tools/check-checkin-queue.js
'use strict';
const fs = require('fs');
const path = require('path');

const lf = (s) => s.replace(/\r\n/g, '\n');
const PROXY = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'transparent-proxy.js'), 'utf8'));
const HTML = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'proxy-dashboard.html'), 'utf8'));

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};
const cutFn = (src, head) => {
    const i = src.indexOf(head);
    if (i < 0) return '';
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? undefined : j + 2);
};

// ── 1. отказа больше нет ──
console.log('\n1. отказ заменён очередью');
check(!/уже открыто \$\{alive\.length\} браузеров/.test(PROXY), 'ответ 429 «уже открыто N браузеров» убран');
check(/AR_CHECKIN_QUEUE/.test(PROXY), 'очередь есть');
check(/queued: true/.test(PROXY), 'клик получает ответ «в очереди», а не ошибку');

// ── 2. один за раз + пауза, но ВНУТРИ своей полосы ──
console.log('\n2. один за раз и пауза — по полосам');
const gap = Number((PROXY.match(/const AR_CHECKIN_GAP_MS = ([\d_]+)/) || [])[1]?.replace(/_/g, ''));
check(gap >= 10_000, `пауза между прогонами не меньше 10 с (получили ${gap / 1000}с)`);
const busy = cutFn(PROXY, 'function arCheckinBusy(');
check(/arCheckinBusy\(lane\)/.test(PROXY) && /arRunKind\.get\(label\) === lane/.test(busy),
    'занятость считается по СВОЕЙ полосе, а не по любому живому окну ЛК');
const wait = cutFn(PROXY, 'function arCheckinWaitMs(');
check(/arCheckinBusy\(lane\)/.test(wait) && /arCheckinLastStart\[lane\]/.test(wait),
    'ждём и закрытия окна своей полосы, и остатка паузы после прошлого старта в ней же');
const pump = cutFn(PROXY, 'function arCheckinPump(');
check(/AR_CHECKIN_QUEUE\.splice\(at, 1\)/.test(pump) && /findIndex/.test(pump),
    'насос берёт первое задание, чья полоса свободна (а не слепой shift по общей очереди)');
check(/setTimeout\(arCheckinPump/.test(pump), 'если ждать — насос сам просыпается');
check(!/arSpawnSession\(job\)\.catch/.test(pump),
    'синхронный arSpawnSession не вызывается как Promise — иначе каждый старт падает с .catch is not a function');
check(/unref/.test(pump), 'таймер не держит процесс');
check(/AR_RATE_RETRY_MAX/.test(PROXY) && /failureKind = code === 6 \? 'rate_limit'/.test(PROXY),
    'код 6 сохраняется как rate-limit и имеет ограниченный retry');
check(/AR_RATE_RETRY_COOLDOWN_MS/.test(PROXY) && /AR_RATE_RETRY_TIMERS/.test(PROXY),
    'рейт-лимит планирует ограниченный повтор после cooldown');
check(/current\.state = 'queued'/.test(PROXY) && /wantAuto: true/.test(PROXY),
    'автоматический повтор возвращается в auto-очередь, а не спавнит обходной процесс');
check(/st\.state !== 'queued'\) return/.test(pump) && /st\.position = i \+ 1/.test(pump),
    'пока стоим в очереди, статус обновляет позицию и время до старта');
// Обработка провалившегося запуска переехала из насоса в arSpawnFailed 11.09: спавн стал
// асинхронным (резолвит прокси до окна), и отказ приходит двумя путями — throw и отказ
// промиса. Проверяем там, где код теперь живёт.
const spawnFail = cutFn(PROXY, 'function arSpawnFailed(');
check(/name: job\.dispName/.test(spawnFail), 'у неудачного запуска в статусе есть имя аккаунта, тост не безымянный');
check(/arBatchNote\(job\.label, 1\)/.test(spawnFail), 'провал запуска двигает прогресс пачки — иначе она замрёт навсегда');

// ── 3. спавн один на два пути ──
console.log('\n3. общий спавн и метка полосы');
const spawnFn = cutFn(PROXY, 'function arSpawnSession(');
check(/spawn\(process\.execPath/.test(spawnFn), 'спавн вынесен в общую функцию');
check(/const kind = wantAuto \? 'auto' : wantCheckin \? 'manual' : 'plain'/.test(spawnFn),
    'полоса прогона вычисляется при спавне');
check(/arRunKind\.set\(label, kind\)/.test(spawnFn) && /arRunKind\.delete\(label\)/.test(spawnFn),
    'метка полосы ставится при старте и снимается на выходе');
check((spawnFn.match(/if \(kind !== 'plain'\) arCheckinLastStart\[kind\] = Date\.now\(\)/g) || []).length === 2,
    'паузу двигают только чек-ины, и на старте, и на закрытии; визит 🌐 очередь не задерживает');
check(/arCheckinPump\(\)/.test(spawnFn), 'после закрытия окна насос берёт следующего');
check(/arAutoCheckinFinish\(/.test(spawnFn) && /newapiRecheckAfterLk\('ar', id\)/.test(spawnFn),
    'хвосты обоих режимов (чек-ин и обычный визит) на месте');
{
    const handler = PROXY.slice(PROXY.indexOf('async function handleArSessionOpen('), PROXY.indexOf('async function handleArAdd('));
    check(!/spawn\(process\.execPath/.test(handler), 'в обработчике своей копии спавна нет');
    check((handler.match(/arSpawnSession\(/g) || []).length === 2,
        'обработчик зовёт общий спавн ровно в двух местах (чек-ин без ожидания и обычный визит)');
    check(/arQueueSpot\(label\)/.test(handler) && /already: true/.test(handler),
        'повторный клик по уже стоящему в очереди аккаунту возвращает ту же позицию, а не кладёт дубль');
}

// ── 4. статус не выбрасывает стоящих в очереди ──
console.log('\n4. карточка статуса переживает долгое ожидание');
const status = cutFn(PROXY, 'function handleArCheckinStatus(');
check(/st\.state === 'running' \|\| st\.state === 'queued'/.test(status),
    'по TTL выбрасываются только завершённые: `queued` живёт, пока стоит в очереди');
check(!/st\.state !== 'running' && born/.test(status),
    'старого условия, съедавшего queued, не осталось');

// ── 5. фронт: ждёт очередь, а не сдаётся ──
console.log('\n5. наблюдатель на фронте');
const watch = cutFn(HTML, 'async function arCheckinWatch(');
check(/run\.state === 'queued'/.test(watch), 'наблюдатель понимает состояние queued');
check(/until = Date\.now\(\) \+ maxMs/.test(watch),
    'пока стоим в очереди, таймаут не течёт — иначе пятый аккаунт сдался бы до старта');
check(/toldQueued/.test(watch), 'про очередь сообщается один раз, а не каждые 3 с');
check(/data\.queued/.test(HTML), 'клик показывает позицию в очереди');
check((HTML.match(/data\.queued/g) || []).length >= 2, 'и ⚡, и 🎁 говорят про очередь');
// 🪤 Срез берём до `run.state`, а НЕ до `misses = 0`: объявление `let misses = 0` стоит в
// начале функции, indexOf нашёл бы его и срез вышел бы пустым (проверка молча «проходила»).
check(/toast\(/.test(watch.slice(watch.indexOf('if (!run)'), watch.indexOf('run.state'))),
    'пропажа прогона из статуса больше не заканчивается молчанием');

// ── 6. живой прогон логики полос ──
// Статические проверки выше ловят форму, а не поведение. Здесь вырезаем блок очереди из
// исходника и исполняем его с подставными зависимостями: настоящего браузера и :8200 не
// нужно, а независимость полос проверяется ровно так, как её сломали бы.
console.log('\n6. поведение: полосы не держат друг друга');
{
    const from = PROXY.indexOf('const AR_CHECKIN_QUEUE = [];');
    const to = PROXY.indexOf('// Спавн окна ЛК/чек-ина.');
    if (from < 0 || to < 0 || to <= from) {
        check(false, 'блок очереди найден в исходнике');
    } else {
        const block = PROXY.slice(from, to);
        // 🪤 С 21.09 в этом же регионе живёт снимок очереди на диск (durable-подъём после
        // рестарта). Песочнице он не нужен, но имена обязаны существовать: насос зовёт
        // arNote/arQueueSave на каждом шаге, а объявления AR_QUEUE_FILE/... исполняются при
        // сборке блока. Пустые заглушки здесь честнее, чем вырезание куска исходника:
        // регресс про порядок в полосах не должен краснеть от чужой подсистемы.
        const build = new Function('deps', 'fs', 'path', '__dirname', `
            const { arLkPids, arRunKind, arPidAlive, AR_AUTO_CHECKIN, logLine, arSpawnSession, arPoolGate,
                    arNote, durableWriteJson, arLoad, arSaveMerge,
                    arCheckinWindowStartMs, arReadCheckinCfg, CHECKIN_LOG_RE } = deps;
            ${block}
            return { AR_CHECKIN_QUEUE, AR_CHECKIN_GAP_MS, arCheckinLastStart,
                     arLaneOf, arCheckinBusy, arCheckinWaitMs, arQueueSpot, arQueueEta, arCheckinPump };
        `);

        const mk = () => {
            const arLkPids = new Map();
            const arRunKind = new Map();
            const alive = new Set();
            const started = [];
            const deps = {
                arLkPids, arRunKind, AR_AUTO_CHECKIN: new Map(), logLine: () => {},
                // Заглушки подсистемы снимка очереди (см. комментарий к сборке блока):
                // в этом регрессе проверяются полосы, а не долговечность.
                arNote: () => {},
                durableWriteJson: () => {}, arLoad: () => [], arSaveMerge: () => {},
                arCheckinWindowStartMs: () => 0, arReadCheckinCfg: () => ({ resetHhmmMsk: '20:30' }),
                CHECKIN_LOG_RE: /^ar-checkin-[\w.-]+\.log$/,
                arPidAlive: (pid) => alive.has(pid),
                // Отстой адресов проверяется отдельно (check-proxy-ledger, check-checkin-proxy):
                // здесь песочнице нужен только ответ «адреса есть», иначе насос встал бы на
                // паузу ожидания и полосы было бы не проверить.
                arPoolGate: () => null,
                // Повторяет то, что делает настоящий arSpawnSession: занимает полосу.
                // Без этого насос за один круг выпустил бы всю очередь — и тест прошёл бы
                // на сломанном коде.
                arSpawnSession: (job) => {
                    started.push(job.label);
                    const pid = 1000 + started.length;
                    alive.add(pid);
                    arLkPids.set(job.label, pid);
                    arRunKind.set(job.label, job.wantAuto ? 'auto' : 'manual');
                    q.arCheckinLastStart[job.wantAuto ? 'auto' : 'manual'] = Date.now();
                },
            };
            const q = build(deps, require('fs'), require('path'), __dirname);
            // Пауза после прошлого старта уже прошла: проверяем именно занятость полос.
            q.arCheckinLastStart.auto = 0;
            q.arCheckinLastStart.manual = 0;
            const hold = (label, kind) => {
                const pid = 9000 + arLkPids.size;
                alive.add(pid);
                arLkPids.set(label, pid);
                arRunKind.set(label, kind);
            };
            const job = (label, wantAuto) => ({ id: label, label, dispName: label, wantCheckin: true, wantAuto });
            return { q, deps, started, hold, job, alive, arLkPids };
        };

        // Главный случай владельца: открыто ручное окно 🎁, кликаем ⚡ по двум другим.
        {
            const t = mk();
            t.hold('acct_manual_open', 'manual');
            t.q.AR_CHECKIN_QUEUE.push(t.job('acct_auto_1', true), t.job('acct_auto_2', true));
            t.q.arCheckinPump();
            check(t.started.length === 1 && t.started[0] === 'acct_auto_1',
                'ручное окно 🎁 не держит ⚡: первый автоподарок стартовал сразу');
            check(t.q.AR_CHECKIN_QUEUE.length === 1,
                'второй ⚡ остался ждать — конвейер внутри полосы по-прежнему по одному');
        }

        // Обратное: своя полоса занята — ждём. Иначе «полосы» превратились бы в «без очереди».
        {
            const t = mk();
            t.hold('acct_auto_open', 'auto');
            t.q.AR_CHECKIN_QUEUE.push(t.job('acct_auto_3', true));
            t.q.arCheckinPump();
            check(t.started.length === 0 && t.q.AR_CHECKIN_QUEUE.length === 1,
                'живой ⚡ держит следующий ⚡ — защита от залпа на месте');
        }

        // Обычный визит 🌐 не полоса вовсе.
        {
            const t = mk();
            t.hold('acct_plain_open', 'plain');
            t.q.AR_CHECKIN_QUEUE.push(t.job('acct_auto_4', true), t.job('acct_manual_4', false));
            t.q.arCheckinPump();
            check(t.started.length === 2, 'визит 🌐 не держит ни ⚡, ни 🎁');
        }

        // Две полосы стартуют в один круг насоса, а не по очереди через таймер.
        {
            const t = mk();
            t.q.AR_CHECKIN_QUEUE.push(t.job('acct_auto_5', true), t.job('acct_manual_5', false));
            t.q.arCheckinPump();
            check(t.started.length === 2 && t.q.AR_CHECKIN_QUEUE.length === 0,
                '⚡ и 🎁 стартуют одновременно: полос две, окон максимум два');
        }

        // Позиция считается внутри полосы, а не по общему массиву.
        {
            const t = mk();
            t.hold('acct_auto_open', 'auto');
            t.hold('acct_manual_open', 'manual');
            t.q.AR_CHECKIN_QUEUE.push(t.job('a1', true), t.job('m1', false), t.job('a2', true));
            const spot = t.q.arQueueSpot('a2');
            check(spot && spot.lane === 'auto' && spot.index === 1 && spot.total === 2,
                'позиция «2 из 2 в своей полосе», а не «3 из 3 в общей куче»');
            check(t.q.arQueueSpot('нет такого') === null, 'у аккаунта вне очереди позиции нет');
        }
    }
}

console.log(fail ? `\n❌ ${fail} провалено` : '\n✅ Очередь чек-инов: две полосы, по одному в каждой, без отказов и без потери карточек.');
process.exit(fail ? 1 : 0);
