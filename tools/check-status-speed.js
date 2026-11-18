#!/usr/bin/env node
'use strict';
// Список сервисов обязан строиться за один опрос процессов, а не за вызов на PID.
//
// Живая жалоба владельца 18.11.2026: ярлык ABUSE HUB «лагает и не прогружает
// список по 10 секунд». Замер statusVerified() = 9.7 с. Причина: на КАЖДЫЙ
// найденный PID запускался отдельный экземпляр PowerShell
// (Get-CimInstance Win32_Process -Filter 'ProcessId = N'), а запуск PowerShell
// стоит ~0.5 с независимо от объёма вопроса. Девять PID давали девять оплат.
//
// Здесь проверяем главное свойство починки: число запусков внешних программ не
// растёт вместе с числом PID. Проверять именно время нельзя — тест на секундах
// флакует на нагруженной машине; считаем вызовы.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'routing/lifecycle.js'), 'utf8');

test('the process snapshot is taken once, not per pid', () => {
    // Снимок процессов должен существовать как отдельная сущность с ленивой
    // загрузкой, иначе каждый вопрос про PID снова стоит запуска программы.
    const start = SRC.indexOf('function createProcessTable()');
    assert.ok(start > 0, 'нет единого снимка процессов');
    const body = SRC.slice(start, SRC.indexOf('function pidImage', start));
    assert.match(body, /let loaded = false/, 'снимок не защищён от повторной загрузки');
    assert.match(body, /if \(loaded\) return;/, 'снимок грузится повторно');
    assert.match(body, /Get-CimInstance Win32_Process \| /,
        'снимок не забирает процессы одним запросом');
});

test('status rows receive the snapshot instead of shelling out per pid', () => {
    // Регресс-замок: адаптеры обязаны дойти до проверяющих функций.
    assert.match(SRC, /pidExecutable: pid => table\.executable\(pid\)/,
        'проверка исполняемого файла снова запускает программу на каждый PID');
    assert.match(SRC, /pidArguments: pid => table\.commandLine\(pid\)/,
        'чтение командной строки снова запускает программу на каждый PID');
    assert.match(SRC, /const table = process\.platform === 'win32' \? createProcessTable\(\) : null/,
        'снимок не создаётся перед построением списка');
    assert.match(SRC, /const checks = await Promise\.all\(row\.pids\.map\(pid => verifier\(svc, pid, adapters\)\)\)/,
        'адаптеры не доходят до проверки PID');
});

test('the source no longer asks powershell per single pid on the status path', () => {
    // Одиночные запросы остались только там, где снимок недоступен (не-Windows
    // ветки и резервный путь). На пути построения списка их быть не должно.
    const statusPart = SRC.slice(SRC.indexOf('async function statusVerified'));
    assert.ok(!/spawnSync\('powershell'/.test(statusPart),
        'на пути построения списка снова есть запуск powershell');
    assert.ok(!/spawnSync\('tasklist'/.test(statusPart),
        'на пути построения списка снова есть запуск tasklist');
});

test('a foreign process is still reported as not ours', () => {
    // Починка скорости не должна была ослабить проверку владельца: чужой
    // процесс обязан остаться «не наш», иначе мы начнём убивать чужие порты.
    const start = SRC.indexOf('async function verifyProcessOwnership');
    const body = SRC.slice(start, SRC.indexOf('function commandTokens', start));
    assert.match(body, /if \(!isOursForService\(svc, imageOf\(pid\), runningPath\)\) return false;/,
        'проверка владельца ослаблена');
    assert.match(body, /hashFile\(runningPath\) !== String\(svc\.identity\.sha256\)\.toLowerCase\(\)/,
        'проверка по хешу файла пропала');
});

test('the snapshot cannot go stale between separate calls', () => {
    // Снимок обязан жить внутри одного построения списка: сразу после запуска
    // сервиса его PID ещё не виден снимку, и общий кэш назвал бы свой процесс
    // чужим. Проверяем, что таблица создаётся в statusVerified, а не в модуле.
    assert.ok(!/^const processTable = /m.test(SRC),
        'снимок вынесен в общую переменную — он устареет между вызовами');
    assert.match(SRC, /async function statusVerified[\s\S]*?createProcessTable\(\)/,
        'снимок не привязан к одному построению списка');
});
