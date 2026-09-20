#!/usr/bin/env node
/**
 * check-gh-seed-unverified.js — регресс на «мёртвая сессия НЕ блокирует заселение».
 *
 * Инвариант одной строкой: заселение из менеджера не отказывает из-за состояния GitHub-сессии.
 *   код 0 — снимок снят и подтверждён,   код 4 — снят, живость не подтверждена (settings увёл
 *   на /login),   код 3 — куки user_session нет вовсе.
 * Первые два заселяются снимком, третий — БЕЗ снимка: запись заводится, браузер открывается на
 * регистрации, и вход по логину в аккаунт провайдера оживляет и запись, и общий снимок.
 *
 * Почему файл существует: 19.09 владелец показал, что «🐙 из менеджера» пишет «сессия мертва»
 * на сессии, которую тут же оживляет обычный вход в аккаунт. Тогда разжали код 4. 21.09 повторилось
 * с кодом 3: у `cicidefinaasyifah` все копии сессии были просрочены (кэш до 05.09, те же куки в
 * профилях go/tb), harvest честно вернул 3 — и заведение записи отменилось, а вместе с ним и вход,
 * который эту сессию оживил бы. Разбор — wiki/log.md [2026-09-21] и wiki/abuse-hub/hub-tasks.md.
 *
 * Проверка статическая: сети и браузера не требует, читает исходники.
 *
 * Запуск:  node tools/check-gh-seed-unverified.js     (exit 1 = инвариант порван)
 */
const fs = require('fs');
const path = require('path');

const HARVEST = path.join(__dirname, '..', 'github', 'harvest-session.js');
const PROXY = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const DASH = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');

const fails = [];
const ok = [];

function read(p) {
    try { return fs.readFileSync(p, 'utf8'); }
    catch (e) { fails.push(`не читается ${p}: ${e.message}`); return ''; }
}
const harvest = read(HARVEST);
const proxy = read(PROXY);
const dash = read(DASH);

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
has(proxy, 'unverified, deadSession: !!seedWhy, note',
    'ответ заселения перестал везти флаги unverified/deadSession/note — плашка «вход попросит логин» не покажется');
// Текст отказа на пути перебора источников больше НЕ должен звать /login «мёртвой»:
// мёртвой теперь считается только отсутствие user_session.
has(proxy, "r.code === 3 ? 'нет живой user_session'",
    'текст источника вернулся к «сессия мертва» — снова путает непроверенную с мёртвой');

// ---- 3. код 3 не отказ: заводим без снимка, оживляет вход -------------------
//
// Инвариант: «сеять нечем» — это НЕ повод не заводить запись. Хардблок отбирал у владельца
// ровно тот шаг, который сессию оживляет (запись → session/open → логин → gh-live-capture).
has(proxy, 'let seedWhy = null;',
    'исчезла переменная seedWhy — причина «сеять нечем» перестала доезжать до записи и до UI');
has(proxy, 'if (!snap && tried.length) seedWhy = tried.join(\'; \')',
    'перебор источников снова завершается отказом вместо причины seedWhy');
// Именно «GitHub-сессия ... не годится» — текст заселения. У ⭐ (`ghStarSnapshot`) свой,
// почти такой же по буквам отказ намеренно: там сессия нужна живьём, чтобы поставить звезду,
// и оживить её этим путём нельзя. Не подтягивать туда послабление.
hasNot(proxy, 'GitHub-сессия ${nick} не годится',
    'вернулся 409 «GitHub-сессия не годится» — мёртвая сессия опять блокирует заведение');
has(proxy, 'сессия ${nick} не годится',
    '⭐ перестал отказывать на мёртвой сессии — звезду ставить нечем, окно открылось бы на /login');
has(proxy, 'if (snap) durableWriteJson(path.join(sessionsDir, label + \'.json\'), gsl.seedPayload(snap, nick));',
    'снимок пишется даже когда его нет — пустой seed:github притворится сессией перед open-session');
// Занятость остаётся отказом: это открытое окно, а не мёртвая сессия, и лечится закрытием.
has(proxy, 'if (sources.length && !free.length) {',
    'проверка занятости перестала отсекать случай «источников нет вовсе» — на пустом списке будет вечный 409');
has(proxy, 'заняты открытым браузером',
    'пропал отказ «профили заняты» — заселение вслепую сожгло бы живую сессию');
// UI обязан эту причину показать: иначе «запись без сессии» выглядит как успешное заселение.
has(dash, 'data.deadSession',
    'дашборд перестал различать «сессия переехала» и «заведено без сессии»');
has(dash, '&& !data.deadSession',
    '⚡ авто снова берётся за аккаунт без снимка — ему нечем входить, гарантированный провал');

for (const s of ok) console.log(`  ok   ${s}`);
for (const s of fails) console.log(`  FAIL ${s}`);
if (fails.length) {
    console.log(`\n[X] инвариант «непроверенная сессия заселяется, а не блокируется» порван: ${fails.length} проблем(ы).`);
    process.exit(1);
}
console.log(`\n[OK] ${ok.length}/${ok.length} — заселение переживает и непроверенную сессию, и мёртвую; оживление за входом.`);
