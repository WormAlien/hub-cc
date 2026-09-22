#!/usr/bin/env node
// Добор «забрать у всех»: кого берём в следующую пачку.
//
// Было (найдено 21.09 живым замером): `faithfulpho` забран в 18:52:02, окно закрылось в
// 18:52:21, добор набрал пачку в 18:52:21 - и тот же аккаунт поехал второй раз в 18:52:46.
// Отбор смотрел на живой pid и на очередь, а оба признака к этому моменту мертвы: pid
// снимает обработчик 'exit' ДО насоса, а отметку в пул ставит `arAutoCheckinFinish`
// (асинхронная, доезжает через ~11 с: 2 с флаш кук + чек баланса).
//
// Вторая беда того же отбора: отказ (код 3 - мёртвая GitHub-сессия) не мешает аккаунту
// снова попасть в готовые, и добор гонял бы его пачка за пачкой до потолка AR_COLLECT_MAX,
// пока в пачке есть хоть один успех.
//
// Запуск: node tools/check-checkin-dobor.js
'use strict';
const fs = require('fs');
const path = require('path');

const lf = (s) => s.replace(/\r\n/g, '\n');
const PROXY = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'transparent-proxy.js'), 'utf8'));
const HTML = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'proxy-dashboard.html'), 'utf8'));
const OLD = process.env.CHECK_OLD_SRC
    ? lf(fs.readFileSync(process.env.CHECK_OLD_SRC, 'utf8')) : null;

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

// ── 1. отбор помнит, кого уже брали в этом заходе ──
console.log('\n1. добор не берёт одного и того же дважды');
const build = cutFn(PROXY, 'function arBuildBatch(');
check(/AR_COLLECT_SEEN/.test(PROXY), 'есть множество «кого уже брали в этом заходе»');
check(/AR_COLLECT_SEEN\.has\(label\)/.test(build), 'отбор спрашивает его по метке аккаунта');
check(/прогон уже идёт/.test(build) && /runSt\.state === 'running' \|\| runSt\.state === 'queued'/.test(build),
    'отбор пропускает прогон в полёте и стоящий в очереди — по записи статуса, а не по pid');

// ── 2. кто наполняет и кто чистит ──
console.log('\n2. наполнение и сброс');
const enq = cutFn(PROXY, 'function arEnqueueBatch(');
check(/AR_COLLECT_SEEN\.add\(job\.label\)/.test(enq),
    'постановка в очередь помечает аккаунт использованным в этом заходе');
const all = cutFn(PROXY, 'async function handleArCheckinAll(');
check(/AR_COLLECT_SEEN\.clear\(\)/.test(all),
    'новое нажатие «забрать у всех» начинает счёт заново');
check(/const AR_COLLECT_SEEN = new Set\(\)/.test(PROXY),
    'счёт захода объявлен множеством меток, а не списком с повторами');

// ── 3. поведение: гонка «окно закрылось, отметка ещё в пути» ──
// Статические проверки ловят форму, а не гонку. Здесь вырезаем arBuildBatch и исполняем
// его с подставным пулом: два вызова подряд - ровно то, что делает насос (пачка, затем
// добор через секунду после закрытия окна).
console.log('\n3. поведение: аккаунт не уезжает в добор сразу после своего прогона');
// `buildSrc` - вырезанный arBuildBatch. Тем же кодом проверяем и старую версию: гонка
// обязана воспроизводиться на ней, иначе «зелено после правки» ничего не доказывает.
function mkSandbox(buildSrc, sessions) {
    const AR_COLLECT_SEEN = new Set();
    const AR_AUTO_CHECKIN = new Map();
    const arLkPids = new Map();
    const alive = new Set();
    const deps = {
        AR_COLLECT_SEEN, AR_AUTO_CHECKIN, arLkPids,
        arPidAlive: (pid) => alive.has(pid),
        arQueueSpot: () => null,
        arLoad: () => sessions,
    };
    const src = `const { AR_COLLECT_SEEN, AR_AUTO_CHECKIN, arLkPids, arPidAlive, arQueueSpot, arLoad } = deps;\n${buildSrc}\nreturn { arBuildBatch };`;
    // arCheckinReadyList живёт в другом месте файла (и покрыт check-checkin-queue):
    // здесь он подставной - проверяем отбор, а не готовность.
    const fn = new Function('deps', 'arCheckinReadyList', src);
    return { ...fn(deps, () => sessions), deps, alive };
}
const acc = (id, name) => ({ id, name, api_key: 'sk-x', status: 'live' });
const race = (sandbox) => {
    const first = sandbox.arBuildBatch(2);
    first.jobs.forEach(j => sandbox.deps.AR_COLLECT_SEEN.add(j.label));  // так делает arEnqueueBatch
    // Окно первого прогона закрылось: pid снят, а отметка в пул ещё не доехала.
    sandbox.deps.AR_AUTO_CHECKIN.set(first.jobs[0].label, { label: first.jobs[0].label, state: 'running' });
    return { first, second: sandbox.arBuildBatch(6) };
};
{
    const t = race(mkSandbox(build, [acc('1', 'faithfulpho'), acc('2', 'sandylashes'), acc('3', 'lovingfairy')]));
    check(t.first.jobs.length === 2 && t.first.ready === 3, 'пачка взяла двух из трёх готовых');
    check(t.second.jobs.length === 1 && t.second.jobs[0].dispName === 'lovingfairy',
        'добор взял только нетронутого — ни того, кто в полёте, ни того, кого уже брали');
}

// Отказ тоже помечается: иначе аккаунт с мёртвым GitHub поехал бы в каждую пачку.
{
    const t = mkSandbox(build, [acc('1', 'merrygoround')]);
    const first = t.arBuildBatch(6);
    first.jobs.forEach(j => t.deps.AR_COLLECT_SEEN.add(j.label));
    t.deps.AR_AUTO_CHECKIN.set(first.jobs[0].label, { label: first.jobs[0].label, state: 'error' });
    const second = t.arBuildBatch(6);
    check(second.jobs.length === 0 && /уже брали/.test((second.skipped || []).join(' ')),
        'аккаунт, отбитый шлюзом, в этот заход больше не берут (причина видна в ответе)');
}

// ── 4. объяснение на вкладке ──
console.log('\n4. вкладка показывает, кого пропустили и почему');
check(/skippedWhy/.test(PROXY), 'причины пропуска уезжают на фронт, а не тонут в логе');

if (OLD) {
    console.log('\n5. краснота на СТАРОМ коде: та же гонка воспроизводится');
    const oldBuild = cutFn(OLD, 'function arBuildBatch(');
    check(!/AR_COLLECT_SEEN/.test(OLD), 'до правки множества использованных не было');
    check(!/прогон уже идёт/.test(oldBuild), 'и отбор не смотрел на запись прогона в полёте');
    const t = race(mkSandbox(oldBuild, [acc('1', 'faithfulpho'), acc('2', 'sandylashes'), acc('3', 'lovingfairy')]));
    check(t.second.jobs.some(j => j.label === 'acct_1'),
        'на старом коде faithfulpho уезжает в добор второй раз — ровно то, что видели 21.09');
}

console.log(fail ? `\n❌ ${fail} провалено` : '\n✅ Добор: одного и того же аккаунта в заходе не берём дважды.');
process.exit(fail ? 1 : 0);
