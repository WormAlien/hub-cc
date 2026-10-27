#!/usr/bin/env node
// Проводка автологина: что должно случиться ПОСЛЕ того, как он прошёл.
//
// Живой случай 17.10.2026 (`backmountai`, `bewitchedpr`): автологин сработал - строка
// «✅ автологин прошёл: GitHub-сессия создана заново» в логе есть, - а прогон всё равно
// записал аккаунту «GitHub-сессия мертва» и выпал из пачек. Две причины, обе молчаливые:
//
//   1. Гейт после входа читался ОДИН раз сразу после reload: вкладка ещё показывала старый
//      `/login`, гейт возвращал 'dead', и прогон сдавался через 0,7 с после удачного входа.
//   2. Общий снимок после входа не обновлялся: профиль живой, `github/sessions/<ghId>.json`
//      старый, а метка `gh_dead` снимается только снимком, снятым ПОЗЖЕ отказа - аккаунт
//      оставался заблокированным при живом входе.
//
// Запуск: node tools/check-gh-autologin-wire.js

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SESS = fs.readFileSync(path.join(ROOT, 'agentrouter', 'open-session.js'), 'utf8').replace(/\r\n/g, '\n');

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

// ── 1. после удачного входа снимок обновляется ──
console.log('\n1. автологин обновляет снимок сессии');
{
    const fn = cutFn(SESS, 'async function tryGithubLogin(');
    check(fn.length > 0, 'tryGithubLogin найдена');
    check(/if \(res\.ok\)/.test(fn), 'успех входа отделён от провала');
    check(/captureOnce\(context\)/.test(fn),
        '🔴 после удачного входа зовётся captureOnce — иначе метка gh_dead не снимется');
    check(/gh-live-capture/.test(fn), 'снимок пишется тем же модулем, что и везде');
    // Порядок: снимок пишется ВНУТРИ ветки успеха, а не до проверки.
    const okAt = fn.indexOf('if (res.ok)');
    const capAt = fn.indexOf('captureOnce(');
    check(okAt > 0 && capAt > okAt, 'снимок пишется именно после подтверждённого входа');
    check(/catch/.test(fn.slice(capAt)), 'падение записи снимка не роняет прогон');
}

// ── 2. гейт после входа не сдаётся с первого раза ──
console.log('\n2. гейт после автологина повторяется');
{
    const block = SESS.slice(SESS.indexOf('if (attempt && attempt.ok && target'), SESS.indexOf('if (attempt && attempt.ok && target') + 1400);
    check(block.length > 0, 'ветка «автологин прошёл» найдена');
    check(/for \(let i = 0; i < 3 && gate === 'dead'; i\+\+\)/.test(block),
        '🔴 у гейта до трёх попыток, а не одна перезагрузка');
    check(/waitForTimeout\(1500\)/.test(block) && /waitForTimeout\(1000\)/.test(block),
        'между попытками есть паузы — вкладке нужно доехать до authorize');
    check(/passGithubGate\(target\)/.test(block), 'каждая попытка переспрашивает гейт');
    check(/url=\$\{target\.url\(\)\}/.test(block),
        'если так и не поехало — в лог уходит адрес, на котором застряли');
    check(/reload\(\{ waitUntil: 'domcontentloaded' \}\)/.test(block), 'перезагрузка на месте');
}

// ── 3. второй раз кнопку входа не жмут ──
console.log('\n3. кнопку входа на шлюзе второй раз не жмут');
{
    const block = SESS.slice(SESS.indexOf('if (attempt && attempt.ok && target'), SESS.indexOf('if (attempt && attempt.ok && target') + 1400);
    check(!/clickGithubLogin/.test(block),
        '🔴 внутри ветки нет clickGithubLogin: второй клик перевыпускает state OAuth');
}

// ── 4. проба входа сравнивает ЗНАЧЕНИЕ, а не наличие ──
console.log('\n4. «сессия создана» = НОВОЕ значение куки');
{
    const fn = cutFn(SESS, 'async function tryGithubLogin(');
    check(/githubSessionValue\(context\)/.test(fn), 'проба читает значение куки, а не факт наличия');
    check(/const beforeSession = await githubSessionValue\(context\)/.test(fn),
        'значение «до входа» запоминается');
    check(/now !== beforeSession/.test(fn),
        '🔴 вход засчитывается только по НОВОМУ значению: старая мёртвая кука иначе даёт ложный успех');
    check(!/sessionProbe:\s*\(\)\s*=>\s*githubSessionAlive/.test(fn),
        'проверки «просто кука есть» в автологине не осталось');
    // Живой случай 16-18.10: пять «✅ автологин прошёл» без единой строки о вводе формы,
    // потому что старая user_session удовлетворяла проверке наличия.
    check(/githubSessionAlive/.test(SESS) && /async function githubSessionValue/.test(SESS),
        'предпроверке «кука есть» оставлена своя функция — она про другое');
}

console.log(fail
    ? `\n× провалено проверок: ${fail}\n`
    : '\n· автологин доводит дело до конца: снимок обновлён, гейт переспрошен, url назван.\n');
process.exit(fail ? 1 : 0);
