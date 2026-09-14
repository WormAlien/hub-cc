#!/usr/bin/env node
// Предпроверка входа — ДО гашения сессии аккаунта.
//
// Зачем файл. Подарок = разлогин + вход. Гашение сессии идёт ПЕРВЫМ, а «смогу ли войти
// обратно» выясняется уже после него: коды 3 (GitHub-сессия мертва), 4 (кнопки нет),
// 5 (OAuth отверг), 6 (край молчит по WAF) оставляют аккаунт РАЗЛОГИНЕННЫМ. То есть
// сессией платят за попытку, а не за результат — при остатке до $175 на аккаунте.
//
// Хуже того, вернуть логин может только браузерный прогон, а это ровно тот механизм,
// который его и сносит: петля. Разорвать её дёшево — обе причины, которые видно
// заранее, проверяются БЕСПЛАТНО: `user_session` лежит в профиле локально, а
// `/api/status` — публичная ручка, она отвечает и без сессии.
//
// 🪤 Через `/api/oauth/state` предпроверку вести НЕЛЬЗЯ: этот роут сам ставит куку
// `session` (в ней сервер держит state OAuth) и до разлогина подменил бы живую сессию
// аккаунта заглушкой. Ровно на этом уже попадался `waitForSiteSession`.
//
// Запуск: node tools/check-checkin-preflight.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SESS = fs.readFileSync(path.join(ROOT, 'agentrouter', 'open-session.js'), 'utf8').replace(/\r\n/g, '\n');
const PROXY = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};
function cutFn(text, head) {
    const start = text.indexOf(head);
    if (start < 0) return '';
    const body = text.indexOf('{', text.indexOf(')', start));
    if (body < 0) return '';
    let depth = 0;
    for (let i = body; i < text.length; i++) {
        if (text[i] === '{') depth++;
        if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return '';
}

const main = SESS.slice(SESS.indexOf('async function main('));

// ── 1. порядок: сначала проверка, потом гашение ──
console.log('\n1. проверка идёт ДО разлогина');
check(/async function preflightEdge\(/.test(SESS), 'проба края вынесена в отдельную функцию');
{
    const probeAt = main.indexOf('preflightEdge(page)');
    const logoutAt = main.indexOf('await doCheckinLogout(context, page)');
    check(probeAt >= 0, 'main зовёт предпроверку края');
    check(logoutAt >= 0, 'гашение сессии на месте');
    check(probeAt >= 0 && logoutAt >= 0 && probeAt < logoutAt,
        '🔴 предпроверка края стоит ВЫШЕ doCheckinLogout — иначе она бессмысленна');
}
{
    const ghAt = main.indexOf("ensureGithubSession(context, 'предпроверка входа')");
    const logoutAt = main.indexOf('await doCheckinLogout(context, page)');
    check(ghAt >= 0, 'main проверяет GitHub-сессию заранее');
    check(ghAt >= 0 && logoutAt >= 0 && ghAt < logoutAt,
        '🔴 GitHub-сессия проверяется ДО разлогина — кука лежит локально, сеть не нужна');
}

// ── 2. чем именно пробуем край ──
console.log('\n2. проба края не подменяет живую сессию');
{
    const probe = cutFn(SESS, 'async function preflightEdge(');
    check(probe.length > 0, 'тело пробы найдено');
    check(/\/api\/status/.test(probe), 'спрашиваем публичный /api/status');
    check(!/\/api\/oauth\/state/.test(probe),
        '🔴 /api/oauth/state не трогаем: он сам ставит куку session и до разлогина подменил бы живую сессию');
    check(/credentials:\s*'include'/.test(probe), 'куки к запросу прикладываются — иначе проба не про нашу сессию');
    check(/github_client_id/.test(probe), 'вердикт по github_client_id: край ответил, но вход выключен — это тоже отказ');
    check(/catch/.test(probe), 'обрыв запроса — тоже отказ, а не падение прогона');
}
check(!/\/api\/oauth\/state/.test(main.slice(0, main.indexOf('await doCheckinLogout(context, page)'))),
    '🔴 до разлогина state-OAuth не запрашивается вообще');

// ── 3. что делает отказ ──
console.log('\n3. отказ предпроверки не гасит сессию и говорит об этом');
check(/process\.exit\(8\)/.test(SESS), 'молчащий край → код 8');
check(/process\.exit\(9\)/.test(SESS), 'мёртвая GitHub-сессия → код 9');
{
    const beforeLogout = main.slice(0, main.indexOf('await doCheckinLogout(context, page)'));
    check(/process\.exit\(8\)/.test(beforeLogout) && /process\.exit\(9\)/.test(beforeLogout),
        'оба отказа случаются ДО разлогина');
    check(/НЕ начат/.test(beforeLogout) && /цела/.test(beforeLogout),
        'в тексте сказано: прогон не начат, сессия аккаунта цела');
}
{
    const dashTable = PROXY.slice(PROXY.indexOf('const AR_AUTO_CHECKIN_FAIL'), PROXY.indexOf('const AR_CHECKIN_FAIL_MANUAL'));
    check(/^\s*8:/m.test(dashTable), 'таблица дашборда знает код 8');
    check(/^\s*9:/m.test(dashTable), 'таблица дашборда знает код 9');
    check(/цела/i.test(dashTable), 'текст кодов 8/9 обещает владельцу сохранённую сессию');
    check(/^\s*3:/m.test(dashTable) && /^\s*6:/m.test(dashTable),
        'коды 3 и 6 остаются: страховка на случай отказа ПОСЛЕ разлогина');
}

// ── 4. предохранитель пачки различает причину ──
console.log('\n4. предохранитель пачки');
{
    const m = PROXY.match(/if \(code === ([^)]+)\) b\.consecFail\+\+; else b\.consecFail = 0;/);
    const codes = m ? (m[1].match(/\d+/g) || []).map(Number) : [];
    check(codes.includes(8), `код 8 (край молчит) останавливает пачку — это лимит по IP (найдено ${codes.join(', ') || '—'})`);
    check(!codes.includes(9), 'код 9 (мёртвая GitHub-сессия) пачку НЕ останавливает: причина про один аккаунт');
    check(codes.includes(4) && codes.includes(5) && codes.includes(6), 'прежние коды шлюза не потерялись');
}

console.log(fail
    ? `\n❌ ${fail} провалено`
    : '\n✅ Предпроверка входа: край и GitHub спрашиваются ДО разлогина, отказ оставляет сессию живой.');
process.exit(fail ? 1 : 0);
