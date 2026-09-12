#!/usr/bin/env node
//
// check-health-async.js — регресс на «дашборд встаёт на секунды».
//
// Как это выстрелило (замеры 12.09): выдача HTML `:8200` показывала TTFB 12,97 с при
// обычных 17 мс. Причина — синхронные внешние команды ВНУТРИ обработчика
// `GET /__switch/api/health`: `execFileSync` останавливает event loop целиком, и пока
// Windows считает `netstat -ano` (159–185 мс) и ходит по сети `git fetch`, процесс не
// обслуживает НИКОГО. Дашборд — один процесс на всё, поэтому замирает и HTML, и
// проксирование Claude Code.
//
// Почему именно эта ручка, а не все 18 синхронных вызовов в файле: health опрашивается
// САМ. `proxy-dashboard.html` зовёт `loadHealth()` на загрузке страницы безусловно
// (бейдж N✓/N↓) и дальше каждые 15 с, пока вкладка открыта. Остальные синхронные места
// (`taskkill` при убийстве порта, `git` в разовой ручке update-check, `sqlite3`) человек
// вызывает руками кнопкой — там блокировка на 200 мс никого не будит.
//
// 🪤 Проверка статическая, по исходнику, и это не лень. Поднять второй экземпляр
// `transparent-proxy.js` в песочнице нельзя: на старте он делает `arProxySpawn({force})`
// и `keepaliveBring(..., {force})` по ЗАХАРДКОЖЕННЫМ портам — то есть убил бы боевые
// keepalive владельца, через которые в этот момент работает Claude Code.
// `SWITCHER_NO_BOOT_KEEPALIVE=1` закрывает только вторую половину.
//
// Проверяем:
//   1. в теле `handleHealth` нет синхронного запуска внешних команд;
//   2. вместо них — await'нутый асинхронный вызов (иначе «починка» удалением строки);
//   3. механика: асинхронный запуск той же команды не держит event loop, синхронный —
//      держит. Замер на живом `netstat`, без сети и без боевых портов.
//
// Запуск: node tools/check-health-async.js      (exit 1 = горячий путь снова блокирует)

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'routing', 'transparent-proxy.js');

let pass = 0;
const fails = [];
const ok = (name) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, why) => { fails.push(`${name} — ${why}`); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${why}`); };
const t = async (name, fn) => {
    try { const r = await fn(); if (r === true || r === undefined) ok(name); else bad(name, String(r)); }
    catch (e) { bad(name, e.message); }
};

// Тело функции по имени: от `function имя(` до строки `^}` на нулевом отступе. Файл
// на 23 000 строк, объявления верхнего уровня — единственная надёжная граница.
function functionBody(src, name) {
    const lines = src.split(/\r?\n/);
    const start = lines.findIndex(l => new RegExp(`^(async\\s+)?function\\s+${name}\\s*\\(`).test(l));
    assert.notStrictEqual(start, -1, `в исходнике нет функции ${name}()`);
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i] === '}') return { text: lines.slice(start, i + 1).join('\n'), start, end: i };
    }
    throw new Error(`не нашёл закрывающую скобку ${name}()`);
}

(async () => {
    const src = fs.readFileSync(SRC, 'utf8');

    console.log('\n\x1b[1m1. Горячий путь: GET /__switch/api/health\x1b[0m');

    const health = functionBody(src, 'handleHealth');

    await t('handleHealth не зовёт синхронные внешние команды', () => {
        const hits = [];
        health.text.split('\n').forEach((l, i) => {
            if (/\b(execFileSync|execSync|spawnSync)\s*\(/.test(l)) {
                hits.push(`строка ${health.start + i + 1}: ${l.trim()}`);
            }
        });
        return hits.length === 0
            ? true
            : `синхронный запуск команды в обработчике, который опрашивается каждые 15 с:\n      ` + hits.join('\n      ');
    });

    await t('handleHealth получает данные о портах асинхронно (await)', () => {
        // Защита от «починки» вырезанием: netstat должен остаться, но неблокирующим.
        const m = /await\s+\w*[eE]xecFile\w*\(\s*'netstat'/.test(health.text)
            || /await\s+\w+\([^)]*'netstat'/.test(health.text);
        return m ? true : 'в handleHealth нет await-вызова netstat — данные о слушателях пропали вместе с блокировкой';
    });

    await t('handleHealth получает состояние git асинхронно (await)', () => {
        // `git fetch --quiet origin` ходит в СЕТЬ. Синхронно это худшая из двух
        // блокировок: netstat стоит сотни мс, недоступный origin — секунды.
        if (!/\bgit\b/.test(health.text)) return true;            // блок убрали целиком — тоже решение
        const syncGit = /execFileSync\(\s*'git'/.test(health.text);
        return syncGit ? 'git в health всё ещё синхронный — сетевой fetch стоит в event loop' : true;
    });

    console.log('\n\x1b[1m2. Механика: async не держит event loop, sync держит\x1b[0m');

    // Мерим не «быстро/медленно», а способность процесса отвечать во время работы
    // команды. Тик setInterval раз в 10 мс — модель параллельного запроса за HTML:
    // максимальный разрыв между тиками и есть время, на которое встал бы чужой запрос.
    //
    // 🪤 Один netstat мерить нельзя: его цена плавает с размером таблицы соединений
    // (50 мс на пустой машине против 159–185 мс на живом флоте) и тонет в шуме
    // планировщика. Поэтому прогон из N вызовов подряд — суммарный блок заведомо выше
    // шума, а разрыв между sync и async остаётся тем же по природе.
    const RUNS = 5;
    const ARGS = ['netstat', ['-ano'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }];

    const lagDuring = (run) => new Promise((resolve) => {
        const gaps = [];
        let prev = Date.now();
        const timer = setInterval(() => { const now = Date.now(); gaps.push(now - prev); prev = now; }, 10);
        // 🪤 Снимать таймер сразу после работы НЕЛЬЗЯ: самый большой разрыв живёт в
        // тике, который loop ещё не успел выполнить — он выполнится первым же шагом
        // ПОСЛЕ разблокировки. `clearInterval` в ту же микрозадачу его съедал, и замер
        // показывал 21 мс блокировки там, где стенные часы честно намеряли 250 мс.
        const done = () => setTimeout(() => { clearInterval(timer); resolve(Math.max(0, ...gaps)); }, 30);
        // Даём таймеру пару тиков разогнаться, иначе первый разрыв меряет собственный старт.
        setTimeout(() => run(done), 50);
    });

    const syncLag = await lagDuring((done) => {
        for (let i = 0; i < RUNS; i += 1) { try { execFileSync(...ARGS); } catch {} }
        done();
    });

    const asyncLag = await lagDuring((done) => {
        let left = RUNS;
        const next = () => (left-- > 0 ? execFile(...ARGS, next) : done());
        next();
    });

    console.log(`      блокировка event loop на ${RUNS}× netstat: sync ${syncLag} мс · async ${asyncLag} мс`);

    await t('асинхронный netstat не блокирует event loop', () => {
        // Сравниваем с sync, а не с абсолютной константой: на другой машине числа
        // другие, а разрыв по природе остаётся.
        if (syncLag < 100) return `замер не показателен: ${RUNS}× sync встали всего на ${syncLag} мс — netstat подозрительно быстр, проверь руками`;
        return asyncLag < syncLag / 2
            ? true
            : `async держал loop ${asyncLag} мс против ${syncLag} мс у sync — выигрыша нет`;
    });

    console.log();
    if (fails.length) {
        console.log(`\x1b[31m✗ провалено ${fails.length}, пройдено ${pass}\x1b[0m`);
        for (const f of fails) console.log(`   • ${f}`);
        process.exit(1);
    }
    console.log(`\x1b[32m✓ всё зелено (${pass})\x1b[0m`);
})();
