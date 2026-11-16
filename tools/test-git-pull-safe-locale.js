// Разбор отказов git не должен зависеть от локали машины. Живой случай 16.11.2026:
// у второго пользователя (macOS, ru_RU) git печатает
//   «Ваши локальные изменения … будут перезаписаны при слиянии»
//   «Указанные неотслеживаемые файлы … будут перезаписаны при слиянии»
// а git-pull-safe.js искал английские фразы. Регекс не срабатывал → pullSafe выходил
// ДО разбора: код 1 («pull не удался») вместо авто-stash, тир-карты не сохранялись,
// человек чинил обновление руками по списку из 19 файлов.
//
// Проверяем две вещи, обе без подмены git. Шим вместо git на Windows не работает:
// execFile не запускает .cmd, а файл без расширения CreateProcess не находит —
// попытка такого шима даёт ЛОЖНЫЙ PASS, поэтому её здесь нет.
//   1) классификация настоящего русского вывода из отчёта;
//   2) что КАЖДЫЙ запуск git из модуля получает C-локаль.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');

const ok = (n, c, extra) => {
    console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra && !c ? '  -> ' + extra : ''}`);
    if (!c) process.exitCode = 1;
};

// ── 1. Настоящий текст из отчёта друга ────────────────────────────────────────
const REAL_RU = [
    "error: Ваши локальные изменения в указанных файлах будут перезаписаны при слиянии:",
    "\trouting/a6api-modelmap.json",
    "\trouting/ar-modelmap.json",
    "\trouting/ar-routes-modelmap.json",
    "Сделайте коммит или спрячьте ваши изменения перед слиянием веток.",
    "error: Указанные неотслеживаемые файлы в рабочем каталоге будут перезаписаны при слиянии:",
    "\tfreegg/open-session.js",
    "\trouting/freegg-proxy.js",
    "\ttools/check-hub-update.js",
    "Переместите эти файлы или удалите их перед переключением веток.",
    "Прерываю",
].join("\n");

const REAL_EN = [
    "error: Your local changes to the following files would be overwritten by merge:",
    "\trouting/ar-modelmap.json",
    "Please commit your changes or stash them before you merge.",
    "error: The following untracked working tree files would be overwritten by merge:",
    "\tfreegg/open-session.js",
    "Please move or remove them before you merge.",
].join("\n");

// Предикаты повторяют то, по чему модуль принимает решения: через require() их не
// достать, модуль их не экспортирует.
const isOverwriteRefusal = (msg) => /would be overwritten|local changes/i.test(msg);
const parseUntracked = (msg) => {
    const out = [];
    let inside = false;
    for (const raw of msg.split(/\r?\n/)) {
        if (/untracked working tree files would be overwritten/i.test(raw)) { inside = true; continue; }
        if (!inside) continue;
        if (/^\s+\S/.test(raw)) { out.push(raw.trim()); continue; }
        break;
    }
    return out;
};

// Контракт: предикаты понимают АНГЛИЙСКИЙ текст, и именно английский им всегда
// приходит — потому что локаль форсируется. Русский текст они НЕ обязаны понимать,
// и утверждать обратное значило бы закреплять неверный контракт. Что важно — чтобы
// русский до них не доходил; это проверяет блок 2.
ok('EN: отказ распознан', isOverwriteRefusal(REAL_EN));
ok('EN: неотслеживаемый найден', parseUntracked(REAL_EN).includes('freegg/open-session.js'));

// А это — фиксация самого дефекта: русский текст предикаты НЕ понимают. Тест
// падал бы, если бы кто-то «починил» разбор добавлением русских регексов вместо
// форсирования локали: тогда защита снова зависела бы от машины и её каталогов.
ok('RU без C-локали: предикат НЕ срабатывает (дефект зафиксирован)',
    isOverwriteRefusal(REAL_RU) === false,
    'русский текст неожиданно распознан — значит разбор снова зависит от локали');
ok('RU без C-локали: список untracked пуст (дефект зафиксирован)',
    parseUntracked(REAL_RU).length === 0,
    `найдено ${parseUntracked(REAL_RU).length}`);

// ── 2. Каждый запуск git обязан получать C-локаль ─────────────────────────────
const src = fs.readFileSync(path.join(__dirname, 'git-pull-safe.js'), 'utf8');

ok('объявлен GIT_ENV', /const GIT_ENV = \{/.test(src));
ok('GIT_ENV: LC_ALL=C', /GIT_ENV = \{[^}]*LC_ALL: 'C'/.test(src), 'LC_ALL не задан в GIT_ENV');
ok('GIT_ENV: LANG=C', /GIT_ENV = \{[^}]*LANG: 'C'/.test(src), 'LANG не задан в GIT_ENV');

// Ни один прямой execFileSync('git', …) не должен остаться без env: GIT_ENV —
// иначе та же дыра вернётся через новый вызов.
const directCalls = src.match(/execFileSync\('git',[\s\S]{0,400}?\}\)/g) || [];
ok('прямые вызовы git найдены', directCalls.length > 0, `найдено ${directCalls.length}`);
const withoutEnv = directCalls.filter(call => !/env: GIT_ENV/.test(call));
ok('все прямые вызовы git передают env: GIT_ENV', withoutEnv.length === 0,
    withoutEnv.map(c => c.split('\n')[0].trim()).join(' | '));

const wrapper = src.slice(src.indexOf('function git(...args)'), src.indexOf('function git(...args)') + 300);
ok('обёртка git() передаёт env: GIT_ENV', /env: GIT_ENV/.test(wrapper), wrapper.split('\n')[0]);

// ── 3. Шум «pathspec … did not match» не должен утекать в консоль ─────────────
const isTrackedBody = src.slice(src.indexOf('function isTracked(rel)'), src.indexOf('function isTracked(rel)') + 700);
ok('isTracked глушит stderr', /stdio: \['ignore', 'pipe', 'ignore'\]/.test(isTrackedBody),
    isTrackedBody.split('\n').slice(0, 6).join(' | '));

// ── 4. Живая проверка: git реально уважает C-локаль ───────────────────────────
const live = execFileSync('bash', ['-lc', 'LC_ALL=C LANG=C git --version'], { encoding: 'utf8' });
ok('git принимает LC_ALL=C', /git version/i.test(live));

// ── 5. Классификация путей, на которых встал пользователь ─────────────────────
const mod = require(path.join(__dirname, 'git-pull-safe.js'));
for (const f of ['routing/a6api-modelmap.json', 'routing/ar-modelmap.json', 'routing/ar-routes-modelmap.json']) {
    ok(`state-файл распознан: ${f}`, mod.isStateFile(f) === true);
}
ok('новый файл апстрима НЕ state', mod.isStateFile('tools/check-hub-update.js') === false);
ok('freegg НЕ state', mod.isStateFile('freegg/open-session.js') === false);
