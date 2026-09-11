'use strict';
/*
 * custom-ports.js — какие порты аллокатор Custom-провайдеров отдавать НЕ имеет права.
 *
 * Зачем файл существует. Конвертеры Custom-провайдеров живут в диапазоне 20150–20250,
 * а keepalive шлюзов — на 20155–20164, то есть ВНУТРИ него. Аллокатор проверял занятость
 * бинд-пробой, и она тут бесполезна по построению: keepalive неактивного шлюза не поднят,
 * порт свободен, проба говорит «бери». Замерено 2026-09-10 — провайдер
 * `newapi.makelove.cloud` получил :20156 (GoRouter) и держал его живым процессом
 * (pid 34940), из-за чего GoRouter не мог стартовать вовсе.
 *
 * 🪤 Раньше это было почти безвредно: чужой порт занят, шлюз лежит, но адресовать его
 * никто не мог. С префиксным роутингом (`aipm/model`) адрес появился — и запрос вида
 * `custom/<модель>` ушёл бы на GoRouter, то есть на ЧУЖОЙ шлюз с чужим ключом и чужой
 * тир-картой. Отказ был бы не в виде ошибки, а в виде молча потраченного чужого баланса.
 *
 * Источник истины — таблица `lifecycle.children()`. Новый keepalive, добавленный туда,
 * резервируется здесь сам: второго списка, который надо помнить обновлять, нет.
 * `RESERVED_FALLBACK` — страховка ровно на один случай: lifecycle не читается.
 */

const PORT_MIN = 20150;
const PORT_MAX = 20250;

// Снято с lifecycle.children() 2026-09-10. Держится как фолбэк, а не как копия списка:
// при живом lifecycle значения приходят оттуда и перекрывают эти.
const RESERVED_FALLBACK = [
    20132, 20133,                              // AR-конвертер, AgentRouter keepalive
    20155, 20156, 20157, 20158, 20159, 20160,  // tabi, gorouter, xpeach, justwoker, seekai, truesota
    20161, 20162, 20163, 20164,                // kktoken, hcnsec, aipm, wisdomsatan
];

/**
 * Порты, которые аллокатор кастомов обязан пропускать.
 * @param {object} [lifecycle] — модуль lifecycle (внедряется в тестах). По умолчанию
 *                               грузится лениво; не прочитался — работаем на фолбэке.
 * @returns {Set<number>}
 */
function reservedPorts(lifecycle) {
    const reserved = new Set(RESERVED_FALLBACK);
    let lc = lifecycle;
    if (!lc) {
        try { lc = require('../lifecycle'); } catch { lc = null; }
    }
    try {
        if (lc && typeof lc.children === 'function') {
            for (const kid of lc.children()) {
                const port = Number(kid && kid.port);
                if (port > 0) reserved.add(port);
            }
        }
    } catch { /* таблица недоступна — остаёмся на фолбэке */ }
    return reserved;
}

/** Попадает ли порт в диапазон, из которого раздаются конвертеры кастомов. */
function inCustomRange(port) {
    const p = Number(port);
    return p >= PORT_MIN && p <= PORT_MAX;
}

module.exports = { PORT_MIN, PORT_MAX, RESERVED_FALLBACK, reservedPorts, inCustomRange };
