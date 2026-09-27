#!/usr/bin/env node
/**
 * check-google-agy.js — регресс на пул аккаунтов Antigravity CLI (`routing/lib/google-agy.js`).
 *
 * Инвариант одной строкой: слепок входа сохраняется и подкладывается байт в байт, а сам
 * OAuth-токен наружу (в ответы, в отчёт) не выходит никогда - только почта из `id_token`.
 *
 * Почему проверки поведенческие. Хранилище учётных данных Windows принадлежит СИСТЕМЕ: это
 * единственная запись `gemini:antigravity` на пользователя, и проба, которая её тронет,
 * разлогинит живого `agy`. Поэтому доступ подменяется (`setVault`) на память, и всё, что
 * проверяется, проверяется на нём. Живое хранилище пробой не трогается вовсе.
 *
 * Что здесь ловится:
 *   · 🪤 слепок, сохранённый под чужим адресом. Если писать в карточку то, что лежит в
 *     хранилище, без сверки адреса, «переключиться» на аккаунт станет невозможно, а карточка
 *     будет обещать вход, которого нет;
 *   · подмена байт при base64-круге (сохранили - прочитали - записали): токен отличается на
 *     один байт, и вход молча перестаёт работать;
 *   · утечка токена наружу - в ответ ручки он попадать не должен ни в каком виде;
 *   · лончер с не-ASCII содержимым и без подмены `USERPROFILE`: тогда `agy` подхватит общий
 *     профиль, и история с настройками смешаются между аккаунтами.
 *
 * Запуск: node tools/check-google-agy.js        (exit 1 = связка порвана)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'google-agy-'));
process.env.GOOGLE_DIR = TMP;
// 🪤 Бинарь подменяем на заведомо отсутствующий: проба не должна запускать настоящий `agy`
// (он бы полез в сеть и в чужую сессию). Проверка «не установлен» идёт через это же.
// 🪤 Имя подставного бинаря - ЛАТИНИЦЕЙ: путь уезжает в лончер, а лончер обязан быть в ASCII
// (cmd.exe печатает cp866). С русским именем падала бы проверка ASCII, и падала бы на
// фикстуре, а не на коде - ровно это и случилось при первом прогоне.
process.env.AGY_EXE = path.join(TMP, 'no-such-agy.exe');
const pool = require(path.join(REPO, 'routing', 'lib', 'google-pool.js'));
const agy = require(path.join(REPO, 'routing', 'lib', 'google-agy.js'));

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

// Запись agy как она есть: JSON с полями token / auth_method / id_token, где id_token - JWT.
function mkBlob(email, filler = 'A') {
    const claims = { iss: 'https://accounts.google.com', email, email_verified: true, iat: 1780000000, exp: 1780003600 };
    const jwt = ['eyJhbGciOiJSUzI1NiJ9',
        Buffer.from(JSON.stringify(claims)).toString('base64url'),
        'signature-not-checked-here'].join('.');
    return Buffer.from(JSON.stringify({ token: `1//${filler.repeat(40)}`, auth_method: 'consumer', id_token: jwt }), 'utf8');
}

const BLOB_A = mkBlob('first@gmail.com', 'A');
const BLOB_B = mkBlob('second@gmail.com', 'B');

// Подставное хранилище: та же семантика, что у настоящего (одна запись, чтение/запись целиком).
let vaultBuf = null;
agy.setVault({
    async read() { return vaultBuf ? Buffer.from(vaultBuf) : null; },
    async write(buf) { vaultBuf = Buffer.from(buf); },
});

(async () => {
    // ── 1. Модуль и адреса каталогов ──────────────────────────────────────────
    section('1. Каталоги и установка');
    check(agy.DIR === path.join(TMP, 'agy'), 'каталог пула agy перекрывается через GOOGLE_DIR');
    check(agy.DIR.startsWith(TMP), 'проба не трогает живой google/agy');
    check(agy.credFile('gg_1').endsWith(path.join('agy', 'acct_gg_1.cred')), 'слепок входа лежит на аккаунт');
    check(agy.installed() === false, 'отсутствующий бинарь виден как «agy не установлен»');

    // ── 2. Разбор записи ─────────────────────────────────────────────────────
    section('2. Разбор записи');
    check(agy.blobEmail(BLOB_A) === 'first@gmail.com', 'почта достаётся из id_token');
    check(agy.blobEmail(Buffer.from('не JSON')) === null, 'мусорный слепок не роняет разбор');
    check(agy.blobEmail(Buffer.from('{"token":"x"}')) === null, 'запись без id_token разбирается как «нет почты»');

    // ── 3. Кто в хранилище ───────────────────────────────────────────────────
    section('3. Кто сейчас в agy');
    check((await agy.current()).email === null, 'пустое хранилище - «никто не вошёл»');
    const recA = pool.normalize({ email: 'first@gmail.com', password: 'p1' }, []);
    const recB = pool.normalize({ email: 'second@gmail.com', password: 'p2' }, [recA]);
    pool.save([recA, recB]);
    vaultBuf = BLOB_A;
    const cur = await agy.current();
    check(cur.email === 'first@gmail.com' && cur.id === recA.id, 'аккаунт хранилища сходится с записью пула по почте');

    // ── 4. Сохранение слепка ─────────────────────────────────────────────────
    section('4. Сохранение и сверка адреса');
    const wrong = await agy.capture(recB.id);
    check(wrong.ok === false && /войди в agy этим аккаунтом/.test(wrong.error),
        'чужой адрес не записывается под эту карточку (иначе переключение обещало бы вход, которого нет)');
    check(!fs.existsSync(agy.credFile(recB.id)), 'после отказа файла у второй карточки не появилось');

    const okA = await agy.capture(recA.id);
    check(okA.ok === true && okA.email === 'first@gmail.com' && okA.bytes === BLOB_A.length,
        'свой вход сохраняется');
    check(fs.existsSync(agy.credFile(recA.id)), 'файл слепка появился на диске');
    check(agy.saved().length === 1 && agy.saved()[0].id === recA.id, 'сохранённый вход видно в списке');

    const saveOut = JSON.stringify(okA);
    check(!/1\/\//.test(saveOut) && !saveOut.includes('signature-not-checked-here'),
        'ответ сохранения не содержит ни токена, ни id_token');
    check(!/token/.test(Object.keys(okA).join(',')), 'в ответе нет поля с токеном');

    // ── 5. Переключение: байт в байт ─────────────────────────────────────────
    section('5. Переключение');
    vaultBuf = BLOB_B;                       // в хранилище теперь другой аккаунт
    const sw = await agy.switchTo(recA.id);
    check(sw.ok === true && sw.email === 'first@gmail.com', 'переключение вернуло почту целевого аккаунта');
    check(!!vaultBuf && vaultBuf.equals(BLOB_A), 'в хранилище лёг ровно тот же слепок, байт в байт');
    check((await agy.current()).email === 'first@gmail.com', 'после переключения хранилище читается как целевой аккаунт');

    const noSaved = await agy.switchTo(recB.id);
    check(noSaved.ok === false && /нет сохранённого входа/.test(noSaved.error),
        'переключение на аккаунт без слепка отказывает словами');

    // ── 6. Забыть ────────────────────────────────────────────────────────────
    section('6. Забыть слепок');
    vaultBuf = BLOB_B;
    agy.forget(recA.id);
    check(!fs.existsSync(agy.credFile(recA.id)) && agy.saved().length === 0, 'слепок забыт, список пуст');
    check(vaultBuf.equals(BLOB_B), 'забывание слепка НЕ трогает хранилище (там сейчас другой аккаунт)');

    // ── 7. Лончер и прогон ───────────────────────────────────────────────────
    section('7. Лончер и прогон');
    const launcher = agy.launcher(recA.id);
    const text = fs.readFileSync(launcher, 'utf8');
    check(/set "USERPROFILE=.*acct_gg_.*\\home"/.test(text), 'лончер подменяет USERPROFILE на каталог аккаунта');
    check(/set "HOME=/.test(text), 'и HOME тоже: часть кода у cli смотрит на него');
    check(!/[^\x00-\x7F]/.test(text), 'лончер в ASCII (правило кодировок: .cmd не терпит BOM и кириллицы)');
    check(agy.homeDir(recA.id).startsWith(TMP), 'каталог профиля аккаунта лежит в пуле, а не в общем ~/.gemini');

    const run = await agy.run(recA.id, ['-p', 'тест']);
    check(run.ok === false && /нет /.test(run.error || ''), 'прогон без бинаря отказывает, а не падает');

    // ── 8. Каталог закрыт от git ─────────────────────────────────────────────
    section('8. Публичный репозиторий');
    const inGit = (p) => spawnSync('git', ['-C', REPO, 'check-ignore', '-q', p], { encoding: 'utf8' }).status === 0;
    check(inGit('google/agy/acct_gg_1.cred'), 'слепок входа закрыт .gitignore');
    check(inGit('google/agy/acct_gg_1/home/settings.json'), 'каталог профиля аккаунта закрыт .gitignore');
    check(!inGit('routing/lib/google-agy.js') && !inGit('tools/agy-cred.ps1'),
        'код модуля и помощник едут в коммит');

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* временный каталог */ }
    say(fails.length ? `\nпровалено ${fails.length} из ${total}` : `\n${total}/${total} проверок пройдено`);
    process.exit(fails.length ? 1 : 0);
})().catch(e => {
    console.error(`\n✗ проба упала: ${e.stack || e.message}`);
    process.exit(1);
});
