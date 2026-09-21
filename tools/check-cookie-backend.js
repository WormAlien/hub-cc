#!/usr/bin/env node
// Провал сборки better-sqlite3 обязан быть НАЗВАН, а не превращаться в прикидку баланса.
//
// Разбор 21.09 (пришёл из лиги): на машине не собрался нативный модуль, точный баланс
// молча ушёл в `guessGrant` (`Math.ceil(spent/25)*25`), а человек увидел не «модуль не
// собран», а неверный совет «войди в ЛК заново». Диагностика под этот случай в репо
// ЕСТЬ (`SQLITE_ERROR`, `cookieFailReason`), но она ключуется по падению
// `require('better-sqlite3')` - а на 12.x биндинг грузится ЛЕНИВО, внутри конструктора
// (`node_modules/better-sqlite3/lib/database.js:48`). Замер в изолированной копии без
// бинарника: `require` отвечает OK, падает только `new Database(':memory:')` -
// `Could not locate the bindings file`. То есть диагностика была недостижима целиком,
// а хелс-чек `:8200` печатал «бэкенд куки готов» на несобранном модуле.
//
// Страж подменяет ровно один шов - `require('bindings')`, который и падает в бою, - и
// требует, чтобы оба выхода говорили правду. Подмена ставится ДО первого require, так
// что код самой better-sqlite3 исполняется настоящий.
//
// Запуск: node tools/check-cookie-backend.js
//
// 🪤 Чего этот страж НЕ умеет: он не воспроизводит отказ сборки целиком (бинарник не
// трогает - на живой установке он нужен рабочим) и не проверяет, что куки реально
// читаются: для этого нужен настоящий профиль Chromium. Он держит ровно реакцию на
// отказ - то, что молчало.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};

const LIB = path.join(__dirname, '..', 'routing', 'lib', 'newapi-account.js');

// Профиль, каким его видит cookieFailReason: БД куки на месте, ключа профиля нет. Так
// выглядит профиль от chrome-headless-shell и любой профиль, чей `Local State` не
// прочитался, - то есть ровно тот случай, где раньше печаталось «войди в ЛК заново».
function fakeProfile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-'));
    const net = path.join(dir, 'Default', 'Network');
    fs.mkdirSync(net, { recursive: true });
    fs.writeFileSync(path.join(net, 'Cookies'), 'not-a-real-db');
    return dir;
}

// В бою падает `require('bindings')` внутри конструктора - отдаём ту же ошибку, что
// вернул бы он сам, слово в слово.
const BINDINGS_ERROR = 'Could not locate the bindings file. Tried:'
    + `\n * ${path.join(__dirname, '..', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')}`;
const origLoad = Module._load;
const breakBindings = () => {
    Module._load = function (request) {
        if (request === 'bindings') throw new Error(BINDINGS_ERROR);
        return origLoad.apply(this, arguments);
    };
};
const healBindings = () => { Module._load = origLoad; };

const na = require(LIB);

console.log('\n1. модуль не собран - отказ назван');
breakBindings();
{
    const ready = na.cookieBackendReady();
    check(ready.ok === false, `cookieBackendReady краснеет${ready.ok ? ' - А ОН ЗЕЛЁНЫЙ, отказ сборки не виден' : ''}`);
    check(/better-sqlite3/.test(String(ready.error)) || /bindings/i.test(String(ready.error)),
        `причина называет модуль: «${String(ready.error).slice(0, 80)}»`);

    const dir = fakeProfile();
    const reason = String(na.cookieFailReason(dir, 'agentrouter.org'));
    check(/better-sqlite3/.test(reason) && /npm rebuild/.test(reason),
        `cookieFailReason называет модуль и лечение: «${reason.slice(0, 80)}»`);
    check(!/войди в ЛК заново/.test(reason), 'cookieFailReason не отправляет владельца перелогиниваться');
    check(!/не расшифровался|Local State|DPAPI/.test(reason), 'cookieFailReason не уводит разбор в шифрование профиля');
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n2. модуль собран - проба не мешает здоровому пути');
healBindings();
{
    const ready = na.cookieBackendReady();
    check(ready.ok === true, ready.ok
        ? 'cookieBackendReady зелёный'
        : `бэкенд куки НЕ собран в этой установке: ${ready.error} · лечится: npm rebuild better-sqlite3`);

    // На успехе причина обязана обнулиться: иначе отставший диагноз «не собран» переживёт
    // починку модуля и будет врать уже в другую сторону.
    const dir = fakeProfile();
    const reason = String(na.cookieFailReason(dir, 'agentrouter.org'));
    check(!/better-sqlite3/.test(reason), `после починки диагноз не залипает: «${reason.slice(0, 80)}»`);
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fail
    ? `\n❌ ${fail} провалено`
    : '\n✅ Отказ сборки better-sqlite3 назван вслух и в хелс-чеке, и в подсказке баланса.');
process.exit(fail ? 1 : 0);
