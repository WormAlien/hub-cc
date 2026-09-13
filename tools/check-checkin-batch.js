#!/usr/bin/env node
// Пачка подарков: «⚡ Забрать у всех» стартует одной кнопкой, «⏹ Стоп» останавливает, а
// предохранитель гасит прогон сам, когда шлюз бьёт по IP.
//
// Зачем регресс. 10.09 владелец попросил остановить идущую пачку — и оказалось, что НЕЧЕМ:
// очередь живёт в памяти дашборда, ручки отмены не было, а убийство браузера очередь не
// останавливало (обработчик `exit` зовёт насос, тот спавнит следующего). Пачка добежала
// сама. Реализация появилась в тот же день, но теста у неё не было — этот файл его закрывает.
//
// 🪤 Предохранитель обязан считать ИМЕННО те коды, которые означают «бьёт по IP»: 4 (страница
// входа без кнопки GitHub), 5 (шлюз отверг OAuth), 6 (край не ответил). Код 7 относился к
// удалённому browser-proxy пути и больше не существует. Коды 2 и 3 — про конкретный аккаунт,
// и вставать по ним нельзя: два дохлых аккаунта подряд заперли бы остальные девять живых.
//
// Проверка идёт по исходнику: очередь и счётчики живут в памяти процесса `:8200`, а
// перезапускать его регрессом нельзя — рестарт рвёт живые сессии владельца.
//
// Запуск: node tools/check-checkin-batch.js
'use strict';

const fs = require('fs');
const path = require('path');

const lf = s => s.replace(/\r\n/g, '\n');
const ROOT = path.join(__dirname, '..');
const PROXY = lf(fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8'));
const HTML = lf(fs.readFileSync(path.join(ROOT, 'routing', 'proxy-dashboard.html'), 'utf8'));

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

// ── 1. ручки пачки и стопа ──
console.log('\n1. ручки на бэкенде');
check(/\/api\/ar\/checkin-all/.test(PROXY), 'POST /api/ar/checkin-all — старт пачки');
check(/\/api\/ar\/checkin-cancel/.test(PROXY), 'POST /api/ar/checkin-cancel — стоп');
check(/async function handleArCheckinAll/.test(PROXY) && /async function handleArCheckinCancel/.test(PROXY),
    'у обеих ручек свои обработчики');

// ── 2. отмена действительно опустошает очередь ──
console.log('\n2. стоп очищает очередь, а не только рисует кнопку');
{
    const cancel = cutFn(PROXY, 'function arCheckinCancel(');
    check(cancel.length > 0, 'функция отмены найдена');
    check(/AR_CHECKIN_QUEUE/.test(cancel), 'трогает саму очередь');
    check(/cancelled/.test(cancel), 'снятым заданиям ставится состояние cancelled — наблюдатель на фронте это видит');
    check(/killRunning/.test(cancel), 'прибить уже открытое окно можно, но это отдельное явное действие');
    check(/lane/.test(cancel), 'останавливать можно одну полосу, а не только всё сразу');
}

// ── 3. предохранитель: какие коды считаются ──
console.log('\n3. предохранитель по отказам подряд');
{
    const note = cutFn(PROXY, 'function arBatchNote(');
    check(note.length > 0, 'счётчик прогресса пачки найден');
    check(/consecFail\+\+/.test(note), 'отказы подряд считаются');
    const m = note.match(/if \(code === ([^)]+)\) b\.consecFail\+\+; else b\.consecFail = 0;/);
    const codes = m ? (m[1].match(/\d+/g) || []).map(Number) : [];
    check([4, 5, 6].every(c => codes.includes(c)) && !codes.includes(7),
        `считаются только живые коды «бьёт по IP»: 4, 5, 6 (найдено ${codes.join(', ') || '—'})`);
    check(!codes.includes(2) && !codes.includes(3),
        'коды 2 и 3 НЕ считаются: это про один аккаунт, а не про шлюз');
    check(/b\.consecFail = 0/.test(note) && /code === 0/.test(note),
        'успешный прогон сбрасывает серию — иначе пачка вставала бы на случайной паре');
    check(/labels\.has\(label\)/.test(note), 'чужие прогоны (одиночный клик) в прогресс пачки не попадают');
}

// ── 4. сработавший предохранитель останавливает, а не просто пишет в лог ──
console.log('\n4. сработал — значит встал');
{
    const fuseIdx = PROXY.indexOf('AR_CHECKIN_BATCH_FUSE');
    check(fuseIdx >= 0, 'порог предохранителя задан константой');
    const around = PROXY.slice(fuseIdx, fuseIdx + 6000);
    check(/arCheckinCancel\(/.test(around) || /arCheckinCancel\(/.test(PROXY),
        'при срабатывании зовётся та же отмена, что и кнопка — один путь остановки');
    const note = cutFn(PROXY, 'function arBatchNote(');
    check(/AR_CHECKIN_BATCH_FUSE/.test(note), 'порог проверяется там же, где считаются отказы');
}

// ── 5. кнопки в дашборде ──
console.log('\n5. дашборд');
check(/checkin-all/.test(HTML), 'кнопка «Забрать у всех» бьёт в свою ручку');
check(/checkin-cancel/.test(HTML), 'кнопка «Стоп» бьёт в свою ручку');
check(/Стоп/.test(HTML), 'подпись «Стоп» есть в разметке');
check(/cancelled/.test(HTML), 'фронт знает состояние cancelled и не ждёт отменённое задание молча');

console.log(fail
    ? `\n❌ ${fail} провалено`
    : '\n✅ Пачка подарков: старт и стоп одной кнопкой, отмена чистит очередь, предохранитель считает только коды шлюза.');
process.exit(fail ? 1 : 0);
