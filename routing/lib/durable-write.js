'use strict';

// ───────────────────────────── durable-запись JSON ─────────────────────────────
//
// Зачем этот модуль. 13.09.2026 машина дважды падала в BSOD (11:44 `0x20001`, 15:53
// `0x1E`), и оба раза пулы `agentrouter-sessions.json` и `justwoker-sessions.json`
// оказывались на диске **100% нулевых байт при сохранённом размере**. Это не обрезка и
// не битый JSON: `fs.writeFileSync` пишет в page cache и возвращает управление, не
// дожидаясь носителя. Жёсткий крах убивает машину между «данные в кэше» и «данные на
// диске» — ядро уже выделило файлу блоки (размер остался), но содержимое не доехало.
//
// Что делает запись durable:
//   1. пишем во временный файл РЯДОМ с целевым (тот же том — иначе `rename` не атомарен);
//   2. `fsync` временного файла — данные физически на носителе;
//   3. `rename` поверх целевого — атомарная подмена inode.
//
// Инвариант, который это даёт: **читатель всегда видит либо прежний целый файл, либо
// новый целый файл — но никогда дырку.** Если машина упала до `rename`, на диске остался
// старый файл; если после — новый. Промежуточного состояния не существует.
//
// 🪤 Почему не «просто добавить fsync к writeFileSync». `fsync` после записи НА МЕСТО
// закрывает окно «данные в кэше», но не закрывает окно «файл уже усечён до нуля, а новые
// данные ещё не записаны»: `writeFileSync` сначала обрезает файл. Краш ровно в этот
// момент даёт то, что мы и наблюдали — нулёвку правильной длины. Поэтому именно tmp+rename.
//
// 🪤 `fsync` вызывается и на КАТАЛОГЕ, где лежит временный файл. Без этого сам `rename`
// может остаться в кэше метаданных, и после краха на диске окажется прежняя версия —
// не потеря данных, но потеря последнего обновления. Стоит один syscall на запись.
const fs = require('fs');
const path = require('path');

// Уникальный суффикс на процесс, чтобы параллельные писатели одного файла не топтали
// временные файлы друг друга. PID хватает: внутри одного процесса запись синхронная.
const TMP_SUFFIX = () => `.tmp-${process.pid}`;

function fsyncDir(dir) {
    try {
        const fd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) {
        // Каталог не открылся для fsync (бывает на Windows-разделах и сетевых дисках).
        // Это не повод ронять запись: сам файл уже синхронизирован, теряется максимум
        // последняя версия метаданных, а не данные.
    }
}

let stageSequence = 0;

function stageAtomicSync(target, data, token) {
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (e) { /* open below reports the failure */ }
    stageSequence += 1;
    const cleanToken = token
        ? String(token).replace(/[^a-zA-Z0-9._-]/g, '_')
        : `${process.pid}-${stageSequence}`;
    const tmp = `${target}.${token ? 'stage' : 'tmp'}-${cleanToken}`;
    let fd = null;
    try {
        fd = fs.openSync(tmp, 'wx');
        if (Buffer.isBuffer(data)) fs.writeFileSync(fd, data);
        else fs.writeFileSync(fd, String(data), 'utf8');
        fs.fsyncSync(fd);
    } catch (error) {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* already closed */ } }
        try { fs.unlinkSync(tmp); } catch (e) { /* absent */ }
        throw error;
    }
    try { fs.closeSync(fd); } catch (e) { /* already closed */ }
    return { target, tmp };
}

function waitSync(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch (e) { /* retry immediately when blocking wait is unavailable */ }
}

function commitAtomicSync(stage) {
    const retryable = new Set(['EACCES', 'EPERM', 'EBUSY']);
    for (let attempt = 0; ; attempt += 1) {
        try {
            fs.renameSync(stage.tmp, stage.target);
            fsyncDir(path.dirname(stage.target));
            return;
        } catch (error) {
            if (!retryable.has(error && error.code) || attempt >= 4) throw error;
            waitSync(10 * (attempt + 1));
        }
    }
}

function discardAtomicSync(stage) {
    if (!stage || !stage.tmp) return;
    try { fs.unlinkSync(stage.tmp); } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
    }
}

function writeAtomic(target, text) {
    const stage = stageAtomicSync(target, text);
    try { commitAtomicSync(stage); }
    catch (error) {
        try { discardAtomicSync(stage); } catch (e) { /* preserve original error */ }
        throw error;
    }
}

// Запись JSON тем же форматированием, что было в проекте: 2 пробела + хвостовой \n.
// Формат сохранён намеренно — файлы читает не только Node, но и агент глазами.
function writeJsonSync(target, value, replacer = null) {
    writeAtomic(target, JSON.stringify(value, replacer, 2) + '\n');
}

// Запись сырого текста (для файлов, которые уже сериализованы вызывающим).
function writeTextSync(target, text) {
    const body = String(text);
    writeAtomic(target, body.endsWith('\n') ? body : body + '\n');
}

// ───────────────────────── детектор нулёвки (пост-BSOD) ─────────────────────────
//
// Файл состояния, обнулённый жёстким крахом, НЕ равен пустому. Разница
// принципиальная: пустой пул — законное состояние («аккаунтов нет»), а нулёвка —
// потеря, которую надо восстановить. Если их спутать, происходит ровно то, что
// случилось 13.09: `load()` возвращает `[]`, обработчик пишет поверх огрызок из
// одной записи, и от прежнего содержимого не остаётся даже возможности его спасти.
//
// Признак выбран намеренно грубый: файл непустой И начинается с нулевого байта.
// JSON не может начинаться с нуля (`[`, `{`, BOM — что угодно, но не 0x00),
// поэтому ложных срабатываний это не даёт.
function zeroedError(label) {
    const err = new Error(`${label}: файл начинается с нулевого байта — это нулёвка после `
        + 'жёсткого краха, а НЕ пустой пул. Не перезаписываю: восстанови из снимка');
    err.poolCorrupt = 'zeroed';
    return err;
}

// Бросает, если текст — нулёвка. Возвращает тот же текст, если он в порядке.
function assertNotZeroed(raw, label) {
    if (raw && raw.length && raw.charCodeAt(0) === 0) throw zeroedError(label);
    return raw;
}

module.exports = {
    writeJsonSync,
    writeTextSync,
    writeAtomic,
    stageAtomicSync,
    commitAtomicSync,
    discardAtomicSync,
    fsyncDir,
    assertNotZeroed,
    zeroedError,
};
