#!/usr/bin/env node
/*
 * check-custom-ports.js — регресс на выдачу портов конвертерам Custom-провайдеров.
 *
 * Зачем файл существует. 2026-09-10 провайдер `newapi.makelove.cloud` получил :20156 —
 * это порт keepalive GoRouter. Аллокатор считал порт свободным честно: keepalive
 * неактивного шлюза не поднят, бинд-проба проходит. Диапазон кастомов (20150–20250)
 * накрывает блок keepalive (20155–20164) целиком, и бинд-проба такую коллизию поймать
 * не может по построению — она меряет «занят сейчас», а не «чужой».
 *
 * 🪤 Цена ошибки выросла с приходом префиксного роутинга. Раньше это был тихий отказ
 * (шлюз просто не стартовал), теперь `custom/<модель>` адресуемо: запрос ушёл бы на
 * GoRouter с чужим ключом и чужой тир-картой — то есть молча потратил бы чужой баланс.
 *
 * Живой стек НЕ трогает: только чтение таблиц и чистые функции, ни одного сокета.
 *
 * Запуск: node tools/check-custom-ports.js      (exit 1 = резерв портов сломан)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROUTING = path.join(__dirname, '..', 'routing');
const cp = require(path.join(ROUTING, 'lib', 'custom-ports.js'));
const lifecycle = require(path.join(ROUTING, 'lifecycle.js'));

let passed = 0;
function ok(name, fn) {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('check-custom-ports:');

// ── 1. Каждый порт из lifecycle.children() зарезервирован ─────────────────────
// Это главный инвариант: таблица children() — единственный список наших процессов,
// и всё, что в ней, аллокатор обязан обходить.
ok('все порты lifecycle.children() попадают в резерв', () => {
    const reserved = cp.reservedPorts();
    const missing = lifecycle.children()
        .map(k => Number(k.port))
        .filter(p => p > 0 && !reserved.has(p));
    assert.deepStrictEqual(missing, [], `не зарезервированы: ${missing.join(', ')}`);
});

// ── 2. Конкретный порт из инцидента ───────────────────────────────────────────
ok(':20156 (GoRouter) зарезервирован — тот самый порт инцидента', () => {
    assert.ok(cp.reservedPorts().has(20156), ':20156 свободен для выдачи');
});

// ── 3. Весь блок keepalive закрыт ─────────────────────────────────────────────
ok('блок keepalive 20155–20164 закрыт целиком', () => {
    const reserved = cp.reservedPorts();
    const open = [];
    for (let p = 20155; p <= 20164; p++) if (!reserved.has(p)) open.push(p);
    assert.deepStrictEqual(open, [], `открыты: ${open.join(', ')}`);
});

// ── 4. Фолбэк работает без lifecycle ──────────────────────────────────────────
// Дашборд обязан подниматься и в дереве, где lifecycle не читается. Тогда резерв
// держится на статике — и она не должна быть пустой.
ok('без lifecycle резерв держится на фолбэке', () => {
    const reserved = cp.reservedPorts({});           // объект без children()
    for (let p = 20155; p <= 20164; p++) {
        assert.ok(reserved.has(p), `фолбэк потерял :${p}`);
    }
});

// ── 5. Резерв не съел весь диапазон ───────────────────────────────────────────
// Обратная ошибка: перестраховаться так, что выдавать станет нечего.
ok('свободных портов под кастомы остаётся с запасом', () => {
    const reserved = cp.reservedPorts();
    let free = 0;
    for (let p = cp.PORT_MIN; p <= cp.PORT_MAX; p++) if (!reserved.has(p)) free++;
    assert.ok(free >= 80, `свободно всего ${free} портов из ${cp.PORT_MAX - cp.PORT_MIN + 1}`);
});

// ── 6. Диапазон в дашборде не разъехался с модулем ────────────────────────────
// Числа живут в модуле; в transparent-proxy.js они должны именно импортироваться,
// а не быть переписаны рядом второй копией.
ok('transparent-proxy берёт диапазон из модуля, а не своей копией', () => {
    const src = fs.readFileSync(path.join(ROUTING, 'transparent-proxy.js'), 'utf8');
    assert.ok(/require\(['"]\.\/lib\/custom-ports['"]\)/.test(src),
        'transparent-proxy.js не требует lib/custom-ports');
    assert.ok(!/const\s+CUSTOM_PROXY_PORT_MIN\s*=\s*\d+/.test(src),
        'в transparent-proxy.js снова захардкожен CUSTOM_PROXY_PORT_MIN');
});

// ── 7. Аллокатор и путь повторного использования порта прикрыты оба ───────────
// Мало не выдавать новый чужой порт: в записи провайдера уже мог лежать чужой,
// и путь «переиспользовать записанный» обязан его отбросить.
ok('и выдача, и повторное использование порта смотрят в резерв', () => {
    const src = fs.readFileSync(path.join(ROUTING, 'transparent-proxy.js'), 'utf8');
    const hits = (src.match(/customReservedPorts\(\)/g) || []).length;
    assert.ok(hits >= 3, `customReservedPorts() вызывается ${hits} раз, ожидалось ≥3 ` +
        '(определение + аллокатор + переиспользование)');
});

// ── 8. В боевом файле провайдеров нет чужих портов ────────────────────────────
// Не про код, а про состояние: запись, выданная ДО фикса, живёт в файле и сама не
// починится, пока провайдера не переактивируют.
ok('custom-providers.json не держит зарезервированных портов', () => {
    const file = path.join(ROUTING, 'custom-providers.json');
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    const reserved = cp.reservedPorts();
    const bad = (doc.providers || [])
        .filter(p => p.proxyPort && reserved.has(Number(p.proxyPort)))
        .map(p => `${p.name} → :${p.proxyPort}`);
    assert.deepStrictEqual(bad, [], `чужие порты в записях: ${bad.join('; ')}`);
});

console.log(process.exitCode ? '\nСЛОМАНО' : `\nвсё зелено (${passed})`);
