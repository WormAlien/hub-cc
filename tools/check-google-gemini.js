#!/usr/bin/env node
/**
 * check-google-gemini.js — регресс на пул аккаунтов Gemini CLI (`routing/lib/google-gemini.js`).
 *
 * Инвариант одной строкой: дом на аккаунт изолирует вход и настройки файлами, а прогон идёт
 * JS-входом пакета, а не через `.cmd` (у которого аргументы склеиваются в одну строку).
 *
 * Почему проверки поведенческие. Здесь всё держится на двух решениях, и оба ломаются молча:
 *   · 🪤 `GEMINI_FORCE_FILE_STORAGE=true` не выставлен - CLI уходит в системную ключницу
 *     (`@github/keytar`), то есть во вход ОДИН НА ПОЛЬЗОВАТЕЛЯ. Тогда «каталог на аккаунт»
 *     перестаёт давать аккаунт, а параллель - работать. Ошибка вылезет не сразу, а когда
 *     панели начнут перелогинивать друг друга;
 *   · 🪤 запуск через `gemini.cmd` - на Windows это `shell: true`, и промпт с кавычками или
 *     `&&` уезжает как команда. Проверка смотрит, что запускается node'ом по JS-входу.
 *
 * Запуск: node tools/check-google-gemini.js        (exit 1 = связка порвана)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'google-gemini-'));
process.env.GOOGLE_DIR = TMP;
// Подставные пути: проба не должна запускать настоящий CLI и лезть в сеть.
process.env.GEMINI_EXE = path.join(TMP, 'no-such-gemini.cmd');
process.env.GEMINI_ENTRY = path.join(TMP, 'no-such-entry.js');
const pool = require(path.join(REPO, 'routing', 'lib', 'google-pool.js'));
const gem = require(path.join(REPO, 'routing', 'lib', 'google-gemini.js'));

const fails = [];
let total = 0;
const say = (s) => console.log(s);
const section = (t) => say(`\n── ${t} ──`);
function check(cond, msg) {
    total += 1;
    say(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) fails.push(msg);
    return !!cond;
}

section('1. Каталоги и установка');
check(gem.DIR === path.join(TMP, 'gemini'), 'каталог пула Gemini CLI перекрывается через GOOGLE_DIR');
check(gem.installed() === false, 'отсутствующий лончер виден как «не установлен»');
const recA = pool.normalize({ email: 'gem.one@gmail.com', password: 'p1' }, []);
const recB = pool.normalize({ email: 'gem.two@gmail.com', password: 'p2' }, [recA]);
pool.save([recA, recB]);
check(gem.homeDir(recA.id).startsWith(TMP), 'дом аккаунта лежит в пуле, а не в общем ~/.gemini');

section('2. Лончер');
const launcher = gem.launcher(recA.id);
const text = fs.readFileSync(launcher, 'utf8');
check(new RegExp(`set "USERPROFILE=${TMP.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')}[^"]*acct_gg_`).test(text.replace(/\\/g, '\\')),
    'лончер подменяет USERPROFILE на дом аккаунта');
check(/set "HOME=/.test(text), 'и HOME тоже');
check(/set "GEMINI_FORCE_FILE_STORAGE=true"/.test(text),
    'лончер запрещает системную ключницу: иначе вход уедет в общее на пользователя место');
check(!/[^\x00-\x7F]/.test(text), 'лончер в ASCII (правило кодировок: .cmd не терпит BOM и кириллицы)');

section('3. Вход аккаунта');
check(gem.state(recA.id).hasCreds === false, 'без файла кредов входа нет');
fs.mkdirSync(path.dirname(gem.credsFile(recA.id)), { recursive: true });
fs.writeFileSync(gem.credsFile(recA.id), '{}', 'utf8');
fs.writeFileSync(gem.accountsFile(recA.id), JSON.stringify({ active: 'gem.one@gmail.com', old: [] }), 'utf8');
const st = gem.state(recA.id);
check(st.hasCreds === true, 'появился файл кредов - вход есть');
check(st.email === 'gem.one@gmail.com', 'почта читается из google_accounts.json');
check(st.at && !isNaN(Date.parse(st.at)), 'дата входа проставлена');
fs.writeFileSync(gem.accountsFile(recA.id), 'не JSON', 'utf8');
const broken = gem.state(recA.id);
check(broken.hasCreds === true && broken.email === '(почта ещё не читается)',
    'битый google_accounts.json не отменяет вход: он есть, а почта честно помечена как нечитаемая');
check(gem.states().length === 1 && gem.states()[0].id === recA.id,
    'в списке состояний только аккаунты с заведённым домом');

section('4. Прогон');
(async () => {
    const noExe = await gem.run(recA.id, 'привет');
    check(noExe.ok === false && /нет /.test(noExe.error || ''), 'без лончера прогон отказывает словами');
    // Лончер «есть», а JS-входа нет: это вторая, отдельная ветка отказа.
    fs.writeFileSync(process.env.GEMINI_EXE, '@echo off\r\n', 'utf8');
    const noEntry = await gem.run(recA.id, 'привет');
    check(noEntry.ok === false && /JS-входа/.test(noEntry.error || ''),
        'без JS-входа прогон отказывает, а не идёт через .cmd (там аргументы склеиваются в строку)');

    section('5. Публичный репозиторий');
    const inGit = (p) => spawnSync('git', ['-C', REPO, 'check-ignore', '-q', p], { encoding: 'utf8' }).status === 0;
    check(inGit('google/gemini/acct_gg_1/home/.gemini/oauth_creds.json'), 'вход закрыт .gitignore');
    check(!inGit('routing/lib/google-gemini.js'), 'код модуля едет в коммит');

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* временный каталог */ }
    say(fails.length ? `\nпровалено ${fails.length} из ${total}` : `\n${total}/${total} проверок пройдено`);
    process.exit(fails.length ? 1 : 0);
})().catch(e => {
    console.error(`\n✗ проба упала: ${e.stack || e.message}`);
    process.exit(1);
});
