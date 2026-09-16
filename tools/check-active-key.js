#!/usr/bin/env node
'use strict';
// Активный ключ шлюза: файл активации, а без него - ключ из пула.
//
// Что доказываем и почему именно это:
//  1. Файл активации ПОБЕЖДАЕТ пул. Иначе активация переставала бы что-либо значить:
//     владелец выбрал аккаунт кнопкой 🔑, а запрос ушёл бы на первый из пула.
//  2. Файла нет - ключ берётся из пула. Ровно этого не хватало 16.09: маршрут
//     `/model odyssey` уходил наверх с клиентским токеном чужого шлюза и получал
//     `401 This API key is not valid` (request_id req_13e829bb3adafc7ea916729e).
//  3. Ни файла, ни пула - пустой ключ, то есть «инжектить нечего»: прокси оставляет
//     заголовки как пришли. Это прежнее поведение, и оно не должно молча измениться.
//  4. Пул читается по mtime: правка пула подхватывается без рестарта, но и зряшного
//     чтения файла на каждый запрос нет.
//  5. Ступени выбора аккаунта - активный → живой → любой с ключом. Третья ступень
//     обязательна: у odyssey все аккаунты `unknown`, и на первых двух пул пуст.
//
// Сети не касается: только временные файлы.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const lib = require(path.join(ROOT, 'routing', 'lib', 'active-key.js'));

const failures = [];
const check = (name, fn) => {
    try { fn(); console.log(`PASS  ${name}`); }
    catch (e) { failures.push(name); console.log(`FAIL  ${name}  ← ${e.message}`); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'akey-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { } });
const w = (name, obj) => { const p = path.join(TMP, name); fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); return p; };

// ── 1. Ступени выбора аккаунта ───────────────────────────────────────────────
check('активный аккаунт вперёд живого, живой вперёд прочих', () => {
    assert.strictEqual(lib.pickAccountKey([{ api_key: 'k1', status: 'dead' }, { api_key: 'k2', status: 'live' }]), 'k2');
    assert.strictEqual(lib.pickAccountKey([{ api_key: 'k1', status: 'dead', active: true }, { api_key: 'k2', status: 'live' }]), 'k1');
});

check('третья ступень берёт любой аккаунт с ключом', () => {
    // 🪤 Случай odyssey: все девять помечены `unknown`, ни один не активен.
    assert.strictEqual(lib.pickAccountKey([{ api_key: 'k1', status: 'unknown' }, { api_key: 'k2' }]), 'k1');
    assert.strictEqual(lib.pickAccountKey([]), '');
    assert.strictEqual(lib.pickAccountKey([{ status: 'live' }]), '', 'аккаунт без ключа выбран быть не может');
});

// ── 2. Резолвер ──────────────────────────────────────────────────────────────
const keyFile = w('odyssey-active-key.txt', 'sk-active-AAA\n');
const poolFile = w('odyssey-sessions.json', { 0: { api_key: 'sk-pool-BBB', status: 'unknown' } });
const poolArr = w('odyssey-sessions-arr.json', [{ api_key: 'sk-pool-CCC', status: 'unknown' }]);
const emptyPool = w('empty-sessions.json', {});
const missing = path.join(TMP, 'нет-такого.txt');

check('файл активации побеждает пул', () => {
    const r = lib.resolveKey({ keyFile, sessionsFile: poolFile });
    assert.strictEqual(r.key, 'sk-active-AAA');
    assert.strictEqual(r.source, 'active');
});

check('файла нет - ключ берётся из пула', () => {
    const r = lib.resolveKey({ keyFile: missing, sessionsFile: poolFile });
    assert.strictEqual(r.key, 'sk-pool-BBB');
    assert.strictEqual(r.source, 'pool');
});

check('пул читается и массивом, и объектом по номерам', () => {
    assert.strictEqual(lib.resolveKey({ keyFile: missing, sessionsFile: poolArr }).key, 'sk-pool-CCC');
});

check('ни файла, ни пула - пустой ключ, а не выдумка', () => {
    assert.strictEqual(lib.resolveKey({ keyFile: missing, sessionsFile: emptyPool }).key, '');
    assert.strictEqual(lib.resolveKey({ keyFile: missing, sessionsFile: missing }).source, 'none');
    assert.strictEqual(lib.resolveKey({}).source, 'none');
});

check('пустой файл активации не считается активацией', () => {
    const blank = w('blank-active-key.txt', '   \n');
    assert.strictEqual(lib.resolveKey({ keyFile: blank, sessionsFile: poolFile }).source, 'pool');
});

check('битый пул не роняет, а даёт пустой ключ', () => {
    const broken = w('broken-sessions.json', '{ это не json');
    assert.strictEqual(lib.resolveKey({ keyFile: missing, sessionsFile: broken }).source, 'none');
});

check('пул перечитывается после правки, но не на каждый запрос', () => {
    const f = w('hot-sessions.json', { 0: { api_key: 'sk-first' } });
    assert.strictEqual(lib.resolveKey({ keyFile: missing, sessionsFile: f }).key, 'sk-first');
    // Тот же mtime - значение из кеша, файл не читается заново (проверяем по подмене).
    assert.strictEqual(lib.resolveKey({ keyFile: missing, sessionsFile: f }).key, 'sk-first');
    // Правка пула с новым mtime обязана подхватиться: иначе аккаунт ротировался бы
    // только с рестартом прокси.
    fs.writeFileSync(f, JSON.stringify({ 0: { api_key: 'sk-second' } }));
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(f, later, later);
    assert.strictEqual(lib.resolveKey({ keyFile: missing, sessionsFile: f }).key, 'sk-second');
});

// ── 3. Клей: прокси и запускалка ─────────────────────────────────────────────
check('keepalive берёт ключ резолвером в ОБЕИХ точках', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routing', 'keepalive-proxy.js'), 'utf8');
    assert.ok(!/fs\.readFileSync\(AR_ACTIVE_KEY_FILE/.test(src),
        'осталось прямое чтение файла ключа - обход резолвера');
    assert.ok(/SESSIONS_FILE/.test(src), 'пул аккаунтов прокси не видит');
    assert.ok(/activeKeyNow\(\)/.test(src), 'резолвер не подключён');
});

check('пул прокинут в env каждого keepalive', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8');
    const keys = [...src.matchAll(/KEY_FILE: (\w+)_ACTIVE_KEY_FILE,/g)].map(m => m[1]);
    const pools = [...src.matchAll(/SESSIONS_FILE: (\w+)_SESSIONS_FILE,/g)].map(m => m[1]);
    assert.ok(keys.length >= 10, `подозрительно мало мест запуска: ${keys.length}`);
    const missing = keys.filter(k => !pools.includes(k));
    assert.ok(!missing.length, `без пула остались: ${missing.join(', ')}`);
});

check('копии выбора ключа больше нет', () => {
    const cat = fs.readFileSync(path.join(ROOT, 'routing', 'lib', 'routes-catalog.js'), 'utf8');
    assert.ok(!/function pickAccountKey/.test(cat), 'в routes-catalog вернулась своя копия ступеней');
    assert.ok(/require\('\.\/active-key'\)/.test(cat), 'routes-catalog не берёт общий выбор ключа');
});

// ── 4. Боевой пул Odyssey (только чтение) ────────────────────────────────────
check('на боевом пуле Odyssey ключ находится, хотя активации нет', () => {
    const pool = path.join(ROOT, 'routing', 'odyssey-sessions.json');
    const r = lib.resolveKey({ keyFile: path.join(os.homedir(), '.claude', 'odyssey-active-key.txt'), sessionsFile: pool });
    assert.strictEqual(r.source, 'pool', `источник ${r.source} - ожидался пул`);
    assert.ok(r.key.startsWith('sk-'), 'из пула приехал не ключ');
});

console.log(failures.length
    ? `\n[FAIL] провалено ${failures.length}: ${failures.join('; ')}`
    : '\n[OK] ключ берётся из активации, а без неё из пула');
process.exit(failures.length ? 1 : 0);
