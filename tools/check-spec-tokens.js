#!/usr/bin/env node
/**
 * check-spec-tokens.js — скан спеки шлюзов на битые токены подстановки.
 *
 * Зачем. `subst()` в add-gateway.js меняет только ПАРНЫЕ `%токен%`. Непарный `%`
 * не заменяется ни на что, и точка начинает искать в файле строку, которой там нет.
 * Чекер честно печатает «пропуск» — без ошибки, без предупреждения.
 *
 * Ровно так и вышло 13.09.2026 с точкой 1.33 (грабля #23): в спеке стояло
 * `nudgeBalanceOnce('%p:'` вместо `'%p%:'` — закрывающий `%` потерян. Симптом был
 * худшего сорта: ЭТАЛОН kktoken показывал «НЕПОЛНО, 1 пропуск», хотя строка
 * `nudgeBalanceOnce('kk:' + api_key, recalc)` в коде на месте (transparent-proxy.js:14356).
 * То есть инвариант «эталон обязан давать ПОЛНО» нарушился, и по отчёту нельзя было
 * понять, врёт спека или пропала правка в коде.
 *
 * Что делает: снимает из каждого поля все валидные токены и смотрит, остался ли `%`.
 * Остался — значит в спеке опечатка. Проверяет и точки, и поля `within`/`file`.
 *
 * Запуск:
 *   node tools/check-spec-tokens.js
 * Код возврата: 0 — все токены парные, 1 — есть битые.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SPEC_FILE = path.join(__dirname, 'gateways.spec.json');

/** Токены, которые понимает subst() в add-gateway.js. Список обязан совпадать. */
const TOKENS = ['%p%', '%x%', '%P%', '%full%', '%NAME%', '%HOST%', '%PORT%',
    '%FOLDER%', '%ICON%', '%COLOR%', '%REF%'];

/** Поля точки, куда подставляются токены. */
const FIELDS = ['expect', 'within', 'file'];

function main() {
    if (!fs.existsSync(SPEC_FILE)) {
        console.error(`нет файла спеки: ${SPEC_FILE}`);
        return 2;
    }
    const spec = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'));
    if (!Array.isArray(spec.points)) {
        console.error('в спеке нет массива points');
        return 2;
    }

    const bad = [];
    let checked = 0;

    for (const p of spec.points) {
        for (const f of FIELDS) {
            const raw = p[f];
            if (raw == null) continue;
            for (const v of (Array.isArray(raw) ? raw : [raw])) {
                if (typeof v !== 'string') continue;
                checked += 1;

                // Снимаем валидные токены — что осталось, то и битое.
                let rest = v;
                for (const t of TOKENS) rest = rest.split(t).join('');
                if (!rest.includes('%')) continue;

                const at = v.indexOf('%');
                bad.push({
                    id: p.id, field: f, value: v,
                    context: v.slice(Math.max(0, at - 16), at + 16),
                });
            }
        }
    }

    console.log(`Спека: ${spec.points.length} точек · проверено полей: ${checked}`);

    if (!bad.length) {
        console.log('Все токены парные.');
        return 0;
    }

    console.log('');
    for (const b of bad) {
        console.log(`✗ ${b.id}  ${b.field} = ${JSON.stringify(b.value)}`);
        console.log(`     контекст: …${b.context}…`);
    }
    console.log('');
    console.log(`БИТЫХ ТОКЕНОВ: ${bad.length}. Непарный \`%\` не подставляется — точка будет вечно «отсутствовать».`);
    return 1;
}

process.exit(main());
