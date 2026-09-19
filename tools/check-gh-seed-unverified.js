#!/usr/bin/env node
/**
 * check-gh-seed-unverified.js — регресс на «непроверенная сессия НЕ блокирует заселение».
 *
 * Инвариант одной строкой: если settings-страница увела на /login, но кука user_session в
 * профиле ЕСТЬ, harvest снимает снимок как непроверенный (код 4), а заселение (newapiAddGithub)
 * его принимает и заводит запись с предупреждением — вместо прежнего 409 «сессия мертва».
 *
 * Почему файл существует: 19.09 владелец показал, что «🐙 из менеджера» пишет «сессия мертва»
 * на сессии, которую тут же оживляет обычный вход в аккаунт. Оживление из НОВЫХ кук логина уже
 * жило в justwoker/open-session.js (gh-live-capture), но хардблок заселения не давал до него
 * дойти. Разбор — wiki/log.md [2026-09-19] и wiki/abuse-hub/hub-tasks.md.
 *
 * Проверка статическая: сети и браузера не требует, читает исходники.
 *
 * Запуск:  node tools/check-gh-seed-unverified.js     (exit 1 = инвариант порван)
 */
const fs = require('fs');
const path = require('path');

const HARVEST = path.join(__dirname, '..', 'github', 'harvest-session.js');
const PROXY = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');

const fails = [];
const ok = [];

function read(p) {
    try { return fs.readFileSync(p, 'utf8'); }
    catch (e) { fails.push(`не читается ${p}: ${e.message}`); return ''; }
}
const harvest = read(HARVEST);
const proxy = read(PROXY);

function has(src, needle, msg) {
    if (src.includes(needle)) ok.push(msg);
    else fails.push(`${msg} (не нашёл: ${needle})`);
}
function hasNot(src, needle, msg) {
    if (!src.includes(needle)) ok.push(msg);
    else fails.push(`${msg} (нашёл лишнее: ${needle})`);
}

// ---- 1. harvest: код 4 для непроверенной сессии ----------------------------
has(harvest, 'process.exit(verified ? 0 : 4)',
    'harvest снова хардблочит на /login вместо кода 4 — заселение не сможет продолжить');
has(harvest, "verifiedAt: verified ? new Date().toISOString() : null",
    'снимок перестал помечать неподтверждённую живость (verifiedAt:null)');
has(harvest, 'unverified: !verified',
    'в снимке нет флага unverified — потребитель не отличит непроверенный от живого');

// Единственный настоящий хардблок — отсутствие user_session, а не /login.
{
    const noSess = harvest.indexOf('!hasUserSession');
    const exit3 = harvest.indexOf('process.exit(3)');
    if (noSess >= 0 && exit3 > noSess && exit3 - noSess < 400)
        ok.push('harvest: код 3 остался только на «нет куки user_session» (заселять физически нечем)');
    else fails.push('harvest: код 3 больше не привязан к отсутствию user_session — либо вернулся ранний блок по /login, либо блок пропал совсем');
}

// ---- 2. заселение принимает код 4 ------------------------------------------
has(proxy, 'r.code === 0 || r.code === 4',
    'newapiAddGithub снова принимает только код 0 — непроверенная сессия опять даст 409');
has(proxy, 'unverified, note',
    'ответ заселения перестал везти флаг unverified/note — плашка «вход попросит логин» не покажется');
// Текст отказа на пути перебора источников больше НЕ должен звать /login «мёртвой»:
// мёртвой теперь считается только отсутствие user_session.
has(proxy, "r.code === 3 ? 'нет живой user_session'",
    'текст источника вернулся к «сессия мертва» — снова путает непроверенную с мёртвой');

for (const s of ok) console.log(`  ok   ${s}`);
for (const s of fails) console.log(`  FAIL ${s}`);
if (fails.length) {
    console.log(`\n[X] инвариант «непроверенная сессия заселяется, а не блокируется» порван: ${fails.length} проблем(ы).`);
    process.exit(1);
}
console.log(`\n[OK] ${ok.length}/${ok.length} — заселение переживает непроверенную сессию, оживление за входом.`);
