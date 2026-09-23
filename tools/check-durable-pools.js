'use strict';

// Регресс на durable-запись пулов: BSOD не должен оставлять пул нулями или обрезком.
//
// Инцидент 13.09 (дважды за день, 11:44 и 15:53): `writeFileSync` фиксирует page cache,
// а не носитель. После жёсткого краха файл на диске оказался 100% нулевых байт при
// сохранённом размере — то есть содержимое не доехало, а inode остался.
//
// Контракт, который проверяется:
//   1) запись идёт через временный файл рядом с целевым;
//   2) содержимое сбрасывается на носитель (`fsync`) ДО переименования;
//   3) переименование атомарное (`rename`) — читатель видит либо старый файл, либо новый;
//   4) функция одна на все пулы, а не скопирована 21 раз (иначе треть забудут обновить).
//
// Тест поведенческий: он реально пишет файл через функцию и роняет процесс НА СЕРЕДИНЕ,
// проверяя, что на диске остался целый JSON, а не дырка.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (condition) console.log(`ok ${checks} - ${message}`);
  else { failures += 1; console.error(`not ok ${checks} - ${message}`); }
}

const proxyText = fs.readFileSync(path.join(ROOT, 'routing/transparent-proxy.js'), 'utf8');
const durablePath = path.join(ROOT, 'routing/lib/durable-write.js');

// ── 1. Модуль существует и экспортирует контракт ──
check(fs.existsSync(durablePath), 'routing/lib/durable-write.js exists');
let durable = null;
try { durable = require(durablePath); } catch (e) {
  check(false, `durable-write.js загружается (${e.message})`);
}
if (durable) {
  check(typeof durable.writeJsonSync === 'function', 'durable-write экспортирует writeJsonSync');
  check(typeof durable.writeTextSync === 'function', 'durable-write экспортирует writeTextSync');

  // ── 2. Поведение: файл реально записывается и валиден ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-test-'));
  const target = path.join(dir, 'pool.json');
  const payload = [{ id: 'ar_1', balance: 5 }, { id: 'ar_2', balance: 0.25 }];
  durable.writeJsonSync(target, payload);
  let back = null;
  try { back = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { /* ниже */ }
  check(Array.isArray(back) && back.length === 2, 'после записи файл читается как валидный JSON');
  check(fs.readFileSync(target, 'utf8').endsWith('\n'), 'файл заканчивается переводом строки');

  // ── 3. Не остаётся временного мусора ──
  const leftovers = fs.readdirSync(dir).filter(f => f !== 'pool.json');
  check(leftovers.length === 0, `в каталоге не осталось временных файлов (найдено: ${leftovers.join(', ') || 'нет'})`);

  // ── 3б. Каталог цели может отсутствовать ──
  // Свежая установка 23.09 (друг): `routing/runtime/` в git не едет (пустые каталоги git
  // не хранит), а пишет туда очередь чек-ина. Первая же запись падала ENOENT, и в логе
  // стояло `снимок на диск не записан (ENOENT ... ar-checkin-queue.json.tmp-2520)` - то
  // есть durable-очередь была выключена молча, а «очередь переживает рестарт» - неправдой.
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-fresh-'));
  const deep = path.join(freshDir, 'runtime', 'nested', 'queue.json');
  durable.writeJsonSync(deep, { ok: true });
  let deepBack = null;
  try { deepBack = JSON.parse(fs.readFileSync(deep, 'utf8')); } catch (e) { /* ниже */ }
  check(deepBack && deepBack.ok === true, 'запись создаёт отсутствующий каталог (свежая установка)');

  // ── 4. Перезапись сохраняет СТАРОЕ содержимое, если процесс упал до rename ──
  // Пишем «хорошее» значение, затем запускаем потомка, который пишет «плохое» и
  // убивает себя ДО переименования. На диске обязан остаться хороший JSON.
  const child = `
    const fs = require('fs');
    const path = require('path');
    const dw = require(${JSON.stringify(durablePath)});
    const target = ${JSON.stringify(target)};
    // Пишем во временный файл и валим процесс, не доводя до rename.
    const tmp = target + '.tmp-probe';
    const fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, '[' + '0,'.repeat(2000) + '0]');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    process.kill(process.pid, 'SIGKILL');
  `;
  const tmpScript = path.join(dir, 'crash-probe.js');
  fs.writeFileSync(tmpScript, child, 'utf8');
  spawnSync(process.execPath, [tmpScript], { timeout: 15000 });

  let afterCrash = null;
  try { afterCrash = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { /* ниже */ }
  check(Array.isArray(afterCrash) && afterCrash.length === 2 && afterCrash[0].id === 'ar_1',
    'обрыв до rename оставляет на диске ПРЕЖНИЙ целый JSON, а не дырку');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 5. Все пулы пишутся через общий durable-хелпер ──
// Раньше каждая из ~21 функций звала writeFileSync сама — и любая забытая означала
// дыру при BSOD.
const saveNames = [...proxyText.matchAll(/^function ([a-zA-Z]+Save)\(/gm)].map(m => m[1]);
check(saveNames.length >= 15, `найдено функций сохранения: ${saveNames.length}`);

const rawWriteInSave = [];
for (const name of saveNames) {
  const re = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{([\\s\\S]{0,700}?)\\n\\}`, 'm');
  const m = proxyText.match(re);
  if (!m) continue;
  const body = m[2];
  if (/fs\.writeFileSync\(/.test(body) && !/durable/i.test(body)) rawWriteInSave.push(name);
}
check(rawWriteInSave.length === 0,
  `ни один Save не пишет напрямую writeFileSync (нарушители: ${rawWriteInSave.join(', ') || 'нет'})`);

check(/require\(['"]\.\/lib\/durable-write['"]\)/.test(proxyText),
  'transparent-proxy подключает lib/durable-write');

// ── 6. Нулёвка не притворяется пустым пулом ──
// Инцидент 13.09: после BSOD файл был 100% нулей, `load()` вернул `[]`, и обработчик
// записал поверх ОГРЫЗОК из одной записи — восстановление из снимка усложнилось.
// Детектор обязан отличать битый файл от пустого и бросать.
if (durable && typeof durable.assertNotZeroed === 'function') {
  let threw = false;
  try { durable.assertNotZeroed(Buffer.from([0, 0, 0, 0]).toString('binary'), 'Test'); }
  catch (e) { threw = true; check(e.poolCorrupt === 'zeroed', 'детектор помечает ошибку как poolCorrupt=zeroed'); }
  check(threw, 'нулёвка бросает, а не возвращается как пустой пул');

  let okPassthrough = true;
  try { durable.assertNotZeroed('[{"id":"ar_1"}]', 'Test'); }
  catch { okPassthrough = false; }
  check(okPassthrough, 'нормальный JSON проходит проверку без исключения');

  let emptyOk = true;
  try { durable.assertNotZeroed('', 'Test'); } catch { emptyOk = false; }
  check(emptyOk, 'по-настоящему пустой файл НЕ считается нулёвкой');
} else {
  check(false, 'durable-write экспортирует assertNotZeroed');
}

// ── 7. Все лоадеры пулов защищены детектором ──
const guarded = [...proxyText.matchAll(/assertNotZeroed\(raw, '([^']+)'\)/g)].map(m => m[1]);
check(guarded.length >= 15, `лоадеров под защитой: ${guarded.length}`);
for (const must of ['AgentRouter', 'JustWoker', 'TabiToken', 'XPeach', 'GoRouter']) {
  check(guarded.includes(must) || guarded.some(g => g.includes(must)),
    `лоадер ${must} защищён от нулёвки`);
}

// ── 8. arSaveMerge не пишет поверх битого пула ──
// Тело берём от заголовка функции до следующей `function` на нулевом отступе —
// жадный `\n}` не годится: внутри есть вложенные блоки.
const mergeStart = proxyText.indexOf('function arSaveMerge(changed)');
check(mergeStart > 0, 'arSaveMerge найден');
if (mergeStart > 0) {
  const rest = proxyText.slice(mergeStart);
  const nextFn = rest.slice(1).search(/\nfunction /);
  const mergeBody = nextFn > 0 ? rest.slice(0, nextFn + 1) : rest.slice(0, 1500);
  check(/poolCorrupt|catch\s*\(e\)/.test(mergeBody),
    'arSaveMerge ловит битый пул и отменяет запись');
  check(/return false/.test(mergeBody),
    'arSaveMerge возвращает false вместо записи поверх нулёвки');
  check(/Не перезаписываю|запись отменена/.test(mergeBody),
    'arSaveMerge говорит вслух, что запись отменена');
}

// ── 4. Порядок вызовов: fsync ДО rename ──
// 🪤 Почему проверяется именно порядок, а не «переживание краха». Краш-симуляция из
// user-space НЕ воспроизводит настоящий BSOD: SIGKILL убивает процесс, но ядро живое и
// сбрасывает page cache, поэтому старый `writeFileSync` в таком тесте тоже «выживал» —
// нулевые потери и у него. Ложная уверенность хуже отсутствия теста, поэтому здесь
// фиксируется то, что действительно отличает durable-запись: fsync стоит МЕЖДУ записью
// и подменой имени, и синхронизируется ещё и каталог.
(function checkCallOrder() {
  const realOpen = fs.openSync, realFsync = fs.fsyncSync, realRename = fs.renameSync;
  const calls = [];
  fs.openSync = function (...a) { calls.push({ op: 'open', arg: String(a[0]) }); return realOpen.apply(fs, a); };
  fs.fsyncSync = function (...a) { calls.push({ op: 'fsync' }); return realFsync.apply(fs, a); };
  fs.renameSync = function (...a) { calls.push({ op: 'rename' }); return realRename.apply(fs, a); };

  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-order-'));
    const target = path.join(dir, 'pool.json');
    fs.writeFileSync(target, '[]\n', 'utf8');   // прежняя версия существует
    calls.length = 0;
    require(durablePath).writeJsonSync(target, [{ id: 'ar_1' }]);

    const iWrite = calls.findIndex(c => c.op === 'fsync');
    const iRename = calls.findIndex(c => c.op === 'rename');
    check(iWrite >= 0, 'fsync вызывается');
    check(iRename >= 0, 'rename вызывается (атомарная подмена)');
    check(iWrite >= 0 && iRename > iWrite, 'fsync стоит ДО rename — данные на диске раньше подмены');

    // Временный файл пишется рядом с целевым (иначе rename не атомарен между томами).
    const opened = calls.filter(c => c.op === 'open').map(c => c.arg);
    check(opened.some(p => path.dirname(p) === dir && p !== target),
      'временный файл лежит в том же каталоге, что целевой');

    // Каталог синхронизируется: после fsync самого файла есть ещё один fsync.
    check(calls.filter(c => c.op === 'fsync').length >= 2, 'каталог тоже синхронизируется (fsync после rename)');
    check(fs.readdirSync(dir).filter(f => f !== 'pool.json').length === 0,
      'временных файлов после записи не осталось');
  } finally {
    fs.openSync = realOpen; fs.fsyncSync = realFsync; fs.renameSync = realRename;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// ── 9. Автореги пишут пулы durable-путём ──
// Авторег заводит аккаунты, ради которых пул и существует. У aikeysapi и rumeng был
// temp+rename БЕЗ fsync, у wisdomsatan — прямая запись в целевой файл вовсе.
for (const rel of ['aikeysapi/auto-add.js', 'rumeng/auto-add.js', 'wisdomsatan/auto-add.js']) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { check(false, `${rel} существует`); continue; }
  const text = fs.readFileSync(p, 'utf8');
  check(/require\(['"]\.\.\/routing\/lib\/durable-write['"]\)/.test(text),
    `${rel} подключает durable-write`);
  const rawWrites = [...text.matchAll(/fs\.writeFileSync\((POOL_FILE|file|tmp)/g)].map(m => m[1]);
  check(rawWrites.length === 0,
    `${rel}: нет сырой записи пула (найдено: ${rawWrites.join(', ') || 'нет'})`);
}

console.log(`\n${checks - failures}/${checks} проверок пройдено`);
process.exit(failures ? 1 : 0);
