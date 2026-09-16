#!/usr/bin/env node
// Точечный патч строки не должен отставать от полей, из которых рисуются значки.
//
// 🔴 Жалоба владельца 16.09: «баланс чекнулся, но статус аккаунта не поменялся».
// `arCheckBalance` (клик по 💰) переносит поля в строку ПОИМЁННО — `spent`, `balance`,
// `balanceSource`, `granted`, `accessUntil`, `selfError`. `selfFailureKind` в списке не
// было, поэтому цифра обновлялась, а плашка вердикта оставалась старой до F5.
//
// Это не первый раз: ровно тот же класс уже ловили на колонке 🎁 (см. комментарий к
// `handleArBalance`: «без этих полей колонка обновлялась бы только после F5 — именно так
// и выглядело со стороны»). Поэтому проверяем не наличие строки в файле, а СВЯЗЬ:
// каждое поле, которое значок читает, обязано быть в патче.
//
// Запуск: node tools/check-balance-patch-sync.js
//
// 🪤 Чего этот страж НЕ умеет: он читает текст. Удаление строк он поймает (проверено
// мутацией), а `if (false) { … }` вокруг них — нет: буквы на месте. Панель — 1,5 МБ HTML
// без песочницы, так что поведенческую проверку тут поставить нечем. Граница известна
// сознательно; для фронта панели это лучшее, что есть, и оно строго лучше грепа по имени.
'use strict';

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'routing', 'proxy-dashboard.html'), 'utf8');

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};
function cutFn(text, head) {
    const start = text.indexOf(head);
    if (start < 0) return '';
    const body = text.indexOf('{', start);
    if (body < 0) return '';
    let depth = 0;
    for (let i = body; i < text.length; i++) {
        if (text[i] === '{') depth++;
        if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return '';
}
// Поля, которые функция читает со строки аккаунта.
const readsOf = (fnBody) => [...new Set((fnBody.match(/\bs\.([A-Za-z_$][\w$]*)/g) || [])
    .map(m => m.slice(2)))];
// Поля, которые точечный патч переносит в строку (присваиванием или снятием).
const patchOf = (fnBody) => [...new Set([
    ...(fnBody.match(/\bs\.([A-Za-z_$][\w$]*)\s*=/g) || []),
    ...(fnBody.match(/delete\s+s\.([A-Za-z_$][\w$]*)/g) || []),
].map(m => m.replace(/^delete\s+/, '').replace(/\s*=$/, '').slice(2)))];

const verdict = cutFn(HTML, 'function loginVerdictMark(');
const fresh = cutFn(HTML, 'function balanceFreshMark(');
const patch = cutFn(HTML, 'async function arCheckBalance(');

console.log('\n1. куски на месте');
check(verdict.length > 0, 'loginVerdictMark найдена');
check(patch.length > 0, 'arCheckBalance найден');

console.log('\n2. вердикт переезжает вместе с балансом');
check(/selfFailureKind\s*=\s*data\.selfFailureKind/.test(patch),
    '🔴 selfFailureKind переносится из ответа в строку');
check(/delete\s+s\.selfFailureKind/.test(patch),
    'отсутствие поля в ответе СНИМАЕТ вердикт, а не оставляет старый');
check(/s\.selfFailureKind\s*=\s*data\.selfFailureKind/.test(patch)
    && patch.indexOf('delete s.selfFailureKind') > patch.indexOf('balanceCheckedAt'),
    'патч вердикта стоит рядом с прочими полями, а не в ветке live');

console.log('\n3. страж дрейфа: что читает значок — то и патчится');
{
    const reads = readsOf(verdict);
    check(reads.length > 0, `поля значка вердикта: ${reads.join(', ') || '—'}`);
    const patched = patchOf(patch);
    const missed = reads.filter(f => !patched.includes(f));
    check(missed.length === 0,
        `все поля вердикта есть в патче${missed.length ? ` — НЕТ: ${missed.join(', ')}` : ''}`);
}
{
    // Значок свежести цифры читает те же данные. Часть его входов приходит не патчем,
    // а хелпером applySelfSeen — поэтому смотрим на объединение обоих путей.
    const seen = cutFn(HTML, 'function applySelfSeen(');
    const reads = readsOf(fresh);
    const patched = [...new Set([...patchOf(patch), ...patchOf(seen)])];
    const missed = reads.filter(f => !patched.includes(f));
    check(missed.length === 0,
        `поля значка свежести покрыты патчем или applySelfSeen${missed.length ? ` — НЕТ: ${missed.join(', ')}` : ''}`);
}

console.log(fail
    ? `\n❌ ${fail} провалено`
    : '\n✅ Точечный патч строки покрывает все поля, из которых рисуются значки.');
process.exit(fail ? 1 : 0);
