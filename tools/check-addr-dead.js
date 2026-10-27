#!/usr/bin/env node
// Мёртвый адрес прогона не должен валить пачку.
//
// Живой случай 15.10.2026: владелец был без VPN, ротация выдала первыми две дохлые строки
// из `own-proxies.txt`, обе попытки вернули код 8 («край молчит»), и предохранитель пачки
// погасил ВЕСЬ заход - 50 подарков не собрались. Причина была не в шлюзе: до него не
// доехали. Тот же код 8 приезжает и когда шлюз честно режет нас по IP - и вот ЭТО повод
// пачку останавливать.
//
// Поэтому проверяем две вещи разом: (1) транспорт и лимит разведены кодами 12 и 8, и
// (2) код 12 не кормит предохранитель, не пишет метку отказа в пул и возвращает задание
// в очередь, а не в «провал».
//
// Запуск: node tools/check-addr-dead.js

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SESS = fs.readFileSync(path.join(ROOT, 'agentrouter', 'open-session.js'), 'utf8').replace(/\r\n/g, '\n');
const PROXY = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8').replace(/\r\n/g, '\n');
const LIBSRC = fs.readFileSync(path.join(ROOT, 'routing', 'lib', 'proxy-pool.js'), 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};
function cutFn(text, head) {
    const start = text.indexOf(head);
    if (start < 0) return '';
    const body = text.indexOf('{', text.indexOf(')', start));
    if (body < 0) return '';
    let depth = 0;
    for (let i = body; i < text.length; i++) {
        if (text[i] === '{') depth++;
        if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return '';
}

// ── 1. ребёнок различает «до шлюза не доехали» и «шлюз отбил» ──
console.log('\n1. проба края называет транспорт отдельно');
{
    const edge = cutFn(SESS, 'async function preflightEdge(');
    check(edge.length > 0, 'тело preflightEdge найдено');
    check(/transport:\s*true/.test(edge), 'при обрыве запроса ставится признак transport');
    check(/if \(!r\) return \{ ok: false, transport: true/.test(edge),
        'отсутствие ответа страницы — тоже транспорт, а не пустая вёрстка');
    check(/github_client_id/.test(edge), 'пустое тело при живом адресе по-прежнему отдельный случай');
    const t = edge.indexOf('transport: true');
    const empty = edge.indexOf('github_client_id нет');
    check(t > 0 && empty > 0 && t < empty, 'в catch транспорт ставится раньше, чем вердикт про тело');
}
{
    const pre = SESS.slice(SESS.indexOf('const edge = await preflightEdge(page);'),
        SESS.indexOf('const edge = await preflightEdge(page);') + 1400);
    check(/edge\.transport/.test(pre) && /process\.exit\(12\)/.test(pre),
        '🔴 транспорт даёт код 12, а не 8');
    const t12 = pre.indexOf('process.exit(12)');
    const t8 = pre.indexOf('process.exit(8)');
    check(t12 > 0 && t8 > t12, 'ветка 12 стоит ПЕРЕД общим кодом 8 — иначе она недостижима');
    check(/сессия аккаунта цела/.test(pre), 'текст по-прежнему обещает целую сессию аккаунта');
}

// ── 2. родитель разводит адрес и лимит ──
console.log('\n2. код 12 не считается отказом аккаунта');
{
    // 🪤 Якорь — ИМЕННО обработчик чек-ина: `proc.on('exit'` в файле не один, и по первому
    // попаданию слайс уходил в чужой обработчик (github session/open), где ветки 12 нет.
    const anchor = PROXY.indexOf('arParseAutoCheckinMarker(outTail)');
    const handler = PROXY.slice(anchor, anchor + 2600);
    check(anchor > 0, 'обработчик выхода чек-ина найден');
    check(/code === 12/.test(handler) && /arAddrDeadRetry\(/.test(handler),
        'выход с кодом 12 уходит в отдельную ветку arAddrDeadRetry');
    // 🪤 Сравниваем ПОЗИЦИИ ВЫЗОВОВ, а не первые упоминания: и `arAutoCheckinFinish`, и
    // `arSpendAddress` выше уже названы в комментариях, и проверка по «первому вхождению»
    // ловила бы текст комментария вместо кода.
    const branch12 = handler.indexOf('if (wantCheckin && code === 12)');
    const finish = handler.indexOf('else if (wantCheckin) arAutoCheckinFinish(');
    check(branch12 > 0 && finish > branch12, 'ветка 12 стоит до arAutoCheckinFinish (метки в пул не будет)');
    check(/if \(wantCheckin && code !== 12\) arBatchNote/.test(PROXY),
        'пачке код 12 не показываем: прогон вернётся в очередь, а не в «провал»');
    const gotAddr = handler.indexOf('arRunProxy.get(label)');
    const spent = handler.indexOf('arSpendAddress(label,');
    check(gotAddr > 0 && spent > gotAddr,
        'id адреса читается ДО списания — иначе мёртвый адрес нечем назвать');
}
{
    check(/if \(code === 12\) \{ \/\* нейтрально \*\/ \}/.test(PROXY),
        'предохранитель: код 12 не двигает series и не сбрасывает её');
    const m = PROXY.match(/else if \(code === ([^)]+)\) b\.consecFail\+\+; else b\.consecFail = 0;/);
    const codes = m ? (m[1].match(/\d+/g) || []).map(Number) : [];
    check(codes.includes(8), `код 8 (край молчит) пачку по-прежнему останавливает (найдено ${codes.join(', ') || '—'})`);
    check(!codes.includes(12), 'код 12 в список останавливающих НЕ попал');
    check(!codes.includes(9) && !codes.includes(3), 'коды про конкретный аккаунт пачку не трогают');
}

// ── 3. что делает ветка: метит адрес мёртвым и возвращает задание ──
console.log('\n3. мёртвый адрес: пометить и повторить через другой');
{
    const fn = cutFn(PROXY, 'function arAddrDeadRetry(');
    check(fn.length > 0, 'функция arAddrDeadRetry существует');
    check(/health\(p, AR_POOL_HOST, \{ force: true \}\)/.test(fn),
        'адрес проверяется принудительно — вердикт ложится в кеш здоровья');
    check(/deadProxiesFor\(AR_POOL_HOST\)/.test(fn) && /tiers\(\)\.own/.test(fn),
        'проверяется, остались ли живые свои адреса');
    check(/arCheckinCancel\(\{ lane: 'auto'/.test(fn),
        'когда живых не осталось — пачка встаёт с причиной (а не молча)');
    check(/AR_ADDR_RETRY_MAX/.test(fn) && /AR_ADDR_RETRY\.get\(label\)/.test(fn),
        'повтор ограничен счётчиком на аккаунт — цикла нет');
    check(/AR_CHECKIN_QUEUE\.push\(/.test(fn) && /arCheckinPump\(\)/.test(fn),
        'задание возвращается в очередь и насос стартует');
    check(/arBatchNote\(label, 12\)/.test(fn),
        'исчерпав попытки, отдаём прогон пачке — иначе прогресс завис бы на «идёт»');
    check(!/checkinFailKind|arSaveMerge|arCheckinFailClear/.test(fn),
        '🔴 метки отказа в пул ветка не пишет: аккаунт тут не виноват');
}
{
    check(/function deadProxiesFor/.test(LIBSRC) && /healthCacheGet/.test(LIBSRC),
        'deadProxiesFor читает именно кеш здоровья — тем и работает отсев');
    check(/exclude: dead/.test(PROXY), 'ротация получает мёртвых адресов в отсев (было и раньше)');
}

// ── 4. коды названы владельцу ──
console.log('\n4. код 12 назван в обеих таблицах');
{
    const auto = PROXY.slice(PROXY.indexOf('const AR_AUTO_CHECKIN_FAIL'), PROXY.indexOf('const AR_CHECKIN_FAIL_MANUAL'));
    check(/^\s*12:/m.test(auto), 'таблица автоподарка знает код 12');
    check(/не донёс трафик/i.test(auto), 'и говорит про адрес, а не про шлюз');
    check(/^\s*8:/m.test(auto), 'код 8 остался на месте');
    const manual = PROXY.slice(PROXY.indexOf('const AR_CHECKIN_FAIL_MANUAL'), PROXY.indexOf('const AR_CHECKIN_FAIL_MANUAL') + 900);
    check(/^\s*12:/m.test(manual), 'ручная таблица тоже знает код 12');
}

console.log(fail
    ? `\n× провалено проверок: ${fail}\n`
    : '\n· мёртвый адрес прогона гасит только себя: помечен, задание повторено, пачка стоит лишь когда живых нет.\n');
process.exit(fail ? 1 : 0);
