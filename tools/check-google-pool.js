#!/usr/bin/env node
/**
 * check-google-pool.js — регресс на пул Google-аккаунтов (`routing/lib/google-pool.js`).
 *
 * Инвариант одной строкой: строка магазина разбирается зеркально Outlook (base32-секрет -
 * это 2FA, а не признак чужого аккаунта), запись пула durable, а пароль и секрет не уезжают
 * в список, который вкладка опрашивает каждые 15 секунд.
 *
 * Почему проверки поведенческие, а не «есть ли строка X». Каждая поломка здесь тихая:
 *   · 🪤 ГЛАВНАЯ - при копировании с `routing/lib/outlook-pool.js` проверка «base32 в строке
 *     = это GitHub-аккаунт, отбрось» переезжает КАК ЕСТЬ. У Outlook она защищает ящик от
 *     чужого пароля, у Google делает обратное: выбрасывает ровно то, за что аккаунт и куплен
 *     (секрет 2FA). Симптом отложенный - карточка есть, кода нет, и выясняется это под
 *     челленджем Google руками через неделю. Проверка на неё стоит отдельным пунктом;
 *   · строка `почта\tпароль:секрет` (таб как разделитель полей) теряет 2FA, если пароль не
 *     отклеить от секрета - тоже молча;
 *   · `save` без durable-записи теряет пул при BSOD: 13.09 два падения подряд оставили
 *     соседние пулы 100% нулевых байт при сохранённом размере;
 *   · `load`, вернувший `[]` на битом файле, разрешает запись поверх огрызка - восстановление
 *     после этого невозможно;
 *   · забытая строка в `.gitignore` уводит живые пароли и куки профилей в ПУБЛИЧНЫЙ репозиторий
 *     (у budsin, fxqidian и lsapi эта же строка однажды уже была забыта при папках на диске).
 *
 * Что здесь ЖИВОЕ: разбор гоняется на подставном пуле, запись - на настоящем `fs` в временном
 * каталоге, порядок вызовов `fsync`/`rename` меряется перехватом `fs`, а `.gitignore`
 * спрашивается у самого git. Сети нет, дашборд не нужен, `:8200` не задет, ни один живой
 * файл не пишется.
 *
 * Запуск: node tools/check-google-pool.js        (exit 1 = связка порвана)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');

// 🪤 Каталог пула подменяем ДО require: иначе модуль сядет на живой `google/accounts.json`,
// и проба напишет в боевой пул. Переменная та же, которой пользуется сам модуль.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'google-pool-'));
process.env.GOOGLE_DIR = TMP;
const pool = require(path.join(REPO, 'routing', 'lib', 'google-pool.js'));

const fails = [];
const skips = [];
let total = 0;

const say = (s) => console.log(s);
const section = (t) => say(`\n── ${t} ──`);
function check(cond, msg) {
    total += 1;
    say(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) fails.push(msg);
    return !!cond;
}
const skip = (msg) => { skips.push(msg); say(`  · ${msg}`); };

const POOL_FILE = path.join(TMP, 'accounts.json');
const writePool = (raw) => fs.writeFileSync(POOL_FILE, raw, 'utf8');
const readPool = () => fs.readFileSync(POOL_FILE, 'utf8');
const clearPool = () => { try { fs.unlinkSync(POOL_FILE); } catch { /* нет файла - и хорошо */ } };

// Секреты, которые встречаются в пробах: ни один из них не должен оказаться в `safeView`.
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASS = 'Lox-Nebe1naya-9';
const RECOV = 'reserve.box@mail.ru';

// ── 1. Модуль и контракт ──────────────────────────────────────────────────────
section('1. Модуль и контракт');
check(typeof pool.load === 'function' && typeof pool.save === 'function', 'load и save экспортируются');
check(Array.isArray(pool.STATUSES) && pool.STATUSES.includes('unknown'), 'STATUSES - массив со значением unknown');
check(Array.isArray(pool.KINDS) && pool.KINDS.includes('burner'), 'KINDS - массив со значением burner');
check(pool.profileLabel('gg_1') === 'acct_gg_1', 'профиль называется acct_<id>');
check(pool.DIR === TMP, 'каталог пула подменяется через GOOGLE_DIR (проба не трогает живой пул)');

// ── 2. Разбор строки ──────────────────────────────────────────────────────────
section('2. Разбор строки');

// 🪤 Тот самый зеркальный пункт: секрет 2FA обязан ДОЕХАТЬ, а не отбросить строку.
const withTotp = pool.parseLine(`some.user@gmail.com:${PASS}:${TOTP}`);
check(withTotp.email === 'some.user@gmail.com' && withTotp.password === PASS && withTotp.totpSecret === TOTP,
    'почта:пароль:секрет - 2FA-секрет доехал до записи (зеркало Outlook: там такая строка отбрасывалась)');
check(!withTotp.error, 'строка с секретом НЕ считается ошибкой');

const plain = pool.parseLine(`some.user@gmail.com:${PASS}`);
check(plain.password === PASS && plain.totpSecret === '', 'почта:пароль - секрета нет, ошибки нет');

const withBoth = pool.parseLine(`some.user@gmail.com:${PASS}:${RECOV}:${TOTP}`);
check(withBoth.totpSecret === TOTP && withBoth.recoveryEmail === RECOV,
    'почта:пароль:резервная почта:секрет - обе части разошлись по своим полям');

const reversed = pool.parseLine(`some.user@gmail.com:${PASS}:${TOTP}:${RECOV}`);
check(reversed.totpSecret === TOTP && reversed.recoveryEmail === RECOV,
    'обратный порядок хвоста разбирается так же (поля ищем по виду, а не по позиции)');

const tabbed = pool.parseLine(`some.user@gmail.com\t${PASS}:${TOTP}`);
check(tabbed.password === PASS && tabbed.totpSecret === TOTP,
    'таб как разделитель полей: секрет отклеен от пароля, а не съеден им');

const piped = pool.parseLine(`some.user@gmail.com|${PASS}|${TOTP}`);
check(piped.password === PASS && piped.totpSecret === TOTP, 'разделитель | разбирается');

const spoken = pool.parseLine('some.user@gmail.com:пароль с пробелами');
check(spoken.password === 'пароль с пробелами', 'пароль с пробелами внутри не режется');

const upper = pool.parseLine('Some.User@Gmail.com:' + PASS);
check(upper.email === 'some.user@gmail.com', 'адрес приводится к нижнему регистру');

check(pool.parseLine('Заказ: №8066475').error === 'адреса почты в строке нет', 'строка чека без адреса - шум, а не запись');
check(pool.parseLine('https://shop.example/order/1').error === 'адреса почты в строке нет', 'ссылка на заказ - шум');
check(/нет пароля/.test(pool.parseLine('some.user@gmail.com').error || ''), 'строка с адресом без пароля - ОШИБКА, а не шум');
check(/на месте пароля/.test(pool.parseLine(`some.user@gmail.com:${TOTP}`).error || ''),
    'секрет на месте пароля - ошибка, а не молчаливая запись с секретом вместо пароля');
check(pool.parseLine('').error === 'пустая строка', 'пустая строка - ошибка');

// ── 2б. Формат магазина: третий хвост, пароль приложения против секрета 2FA ────
// 🪤 Самая дорогая путаница этого модуля. Оба хвоста выглядят одинаково (буквы с цифрами
// группами по четыре), но означают разное: секрет 2FA даёт живой код, пароль приложения
// вводят в почтовый клиент. Примешь пароль за секрет - карточка покажет код, который
// никогда не подойдёт; примешь секрет за пароль - вход по 2FA останется без кода.
section('2б. Пароль приложения против секрета 2FA');
const appOf = (line) => pool.parseLine(line).appPassword;
const totpOf = (line) => pool.parseLine(line).totpSecret;
const APP16 = 'cmsk dp4z keik kncq';
const APP16_NOSPACE = 'cmskdp4zkeikkncq';
// Формат, которым продают на самом деле: разделитель `|`, третий хвост - строчными.
const SELLER_32 = 'cmsk dp4z keik kncq zak7 dsjt nfx2 53ej';

check(appOf(`a@gmail.com|Pass#Word%|${APP16}`) === APP16_NOSPACE,
    'пароль приложения (16 знаков строчными группами по 4) идёт в своё поле');
check(totpOf(`a@gmail.com|Pass#Word%|${APP16}`) === '',
    'и НЕ попадает в секрет 2FA: живой код из него не собирается');
check(appOf('a@gmail.com|P#1|abcd 1234 efgh 5678') === 'abcd1234efgh5678',
    'цифры 0/1/8/9 в base32 невозможны - значит это пароль приложения');
check(totpOf(`a@gmail.com|Pass#Word%|${SELLER_32}`) !== '',
    '32 знака строчными - это СЕКРЕТ 2FA: пароль приложения длиннее 16 не бывает');
check(appOf(`a@gmail.com|Pass#Word%|${SELLER_32}`) === '',
    'и паролем приложения он при этом не считается');
check(totpOf(`a@gmail.com|P#1|JBSWY3DPEHPK3PXP`) !== '', 'секрет 2FA заглавными (16) остаётся секретом');
const both = pool.parseLine(`a@gmail.com|P#1|reserve@mail.ru|JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP|${APP16}`);
check(both.recoveryEmail === 'reserve@mail.ru' && both.totpSecret && both.appPassword,
    'оба хвоста вместе разошлись по своим полям, порядок любой');
check(pool.parseLine(`a@gmail.com|P#1|${APP16}`).note === '', 'пароль приложения не оседает в заметке как мусор');
check(pool.looksLikeAppPass(APP16) && !pool.looksLikeAppPass('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'),
    'различитель отвечает верно на оба вида');

// ── 3. Пачка ──────────────────────────────────────────────────────────────────
section('3. Пачка');
const receipt = [
    '↓↓↓↓ Ваш заказ: ↓↓↓↓',
    `one.user@gmail.com:${PASS}`,
    `two.user@gmail.com:${PASS}:${TOTP}`,
    `one.user@gmail.com:${PASS}`,                       // дубль внутри пачки
    'two.user@gmail.com:другой-пароль',                  // дубль внутри пачки, другой регистр полей
    'three.user@gmail.com',                              // адрес без пароля - ошибка
    '',
].join('\n');
const bulk = pool.parseBulk(receipt, []);
check(bulk.entries.length === 2, `в пачке распознано 2 записи (получено ${bulk.entries.length})`);
check(bulk.errors.length === 1, `ошибок 1 - строка с адресом без пароля (получено ${bulk.errors.length})`);
check(bulk.duplicates.length === 2, `дублей 2 (получено ${bulk.duplicates.length})`);
check(bulk.entries.some(e => e.totpSecret === TOTP), 'в записи из пачки секрет 2FA на месте');

const againstPool = pool.parseBulk(`one.user@gmail.com:${PASS}`, [{ email: 'ONE.user@gmail.com' }]);
check(againstPool.entries.length === 0 && againstPool.duplicates.length === 1,
    'дубль против пула ловится без учёта регистра');

// ── 4. Запись durable ─────────────────────────────────────────────────────────
section('4. Запись');
clearPool();
const arr = [pool.normalize({ email: 'some.user@gmail.com', password: PASS, totpSecret: TOTP, recoveryEmail: RECOV, kind: 'personal' }, [])];
pool.save(arr);
let back = null;
try { back = JSON.parse(readPool()); } catch { /* ниже */ }
check(Array.isArray(back) && back.length === 1, 'после save файл читается как валидный JSON');
check(readPool().endsWith('\n'), 'файл заканчивается переводом строки');
check(fs.readdirSync(TMP).filter(f => f !== 'accounts.json').length === 0,
    'временных файлов после записи не осталось');
check(back && back[0].totpSecret === TOTP, 'секрет 2FA лёг в файл целиком');

// Порядок вызовов: fsync ДО rename. Симметрично `check-durable-pools.js` - там разобран
// довод, почему проверяется порядок, а не «переживание краха» (SIGKILL не воспроизводит BSOD).
(function checkOrder() {
    const realOpen = fs.openSync, realFsync = fs.fsyncSync, realRename = fs.renameSync;
    const calls = [];
    fs.openSync = function (...a) { calls.push({ op: 'open', arg: String(a[0]) }); return realOpen.apply(fs, a); };
    fs.fsyncSync = function (...a) { calls.push({ op: 'fsync' }); return realFsync.apply(fs, a); };
    fs.renameSync = function (...a) { calls.push({ op: 'rename' }); return realRename.apply(fs, a); };
    try {
        calls.length = 0;
        pool.save(arr);
        const iSync = calls.findIndex(c => c.op === 'fsync');
        const iRename = calls.findIndex(c => c.op === 'rename');
        check(iSync >= 0 && iRename > iSync, 'fsync стоит ДО rename - данные на диске раньше подмены');
        check(calls.filter(c => c.op === 'fsync').length >= 2, 'каталог тоже синхронизируется');
        const opened = calls.filter(c => c.op === 'open').map(c => c.arg);
        check(opened.some(p => path.dirname(p) === TMP && p !== POOL_FILE), 'временный файл лежит рядом с целевым');
    } finally {
        fs.openSync = realOpen; fs.fsyncSync = realFsync; fs.renameSync = realRename;
    }
})();

check(/require\(['"]\.\/durable-write['"]\)/.test(fs.readFileSync(path.join(REPO, 'routing', 'lib', 'google-pool.js'), 'utf8')),
    'модуль пула подключает durable-write');
check(!/fs\.writeFileSync\(/.test(fs.readFileSync(path.join(REPO, 'routing', 'lib', 'google-pool.js'), 'utf8')),
    'в модуле пула нет сырой записи writeFileSync');

// ── 5. Битого пула не перезаписываем ─────────────────────────────────────────
section('5. Битый пул');
clearPool();
check(pool.load().length === 0, 'нет файла - пул читается как пустой (это законное состояние)');
writePool('[]');
check(pool.load().length === 0, 'пустой массив читается как пустой пул');

// 🪤 Именно НУЛЕВЫЕ байты, а не пробелы: детектор отличает нулёвку от пустого файла по
// первому байту, и подставь сюда пробелы - проба проверяла бы разбор мусора, а не BSOD.
writePool(Buffer.from([0, 0, 0, 0]));
let zeroedErr = null;
try { pool.load(); } catch (e) { zeroedErr = e; }
check(!!zeroedErr, 'нулёвка бросает, а не возвращается как пустой пул');
check(zeroedErr && zeroedErr.poolCorrupt === 'zeroed', 'ошибка помечена poolCorrupt=zeroed');
let saveThrew = false;
try { pool.save([{ id: 'gg_1', email: 'x@y.z', password: PASS }]); } catch { saveThrew = true; }
check(saveThrew, 'save поверх нулёвки отказывается писать');
check(readPool().charCodeAt(0) === 0, 'нулёвочный файл после отказа остался нетронутым');

writePool('{ это не JSON');
let brokenErr = null;
try { pool.load(); } catch (e) { brokenErr = e; }
check(!!brokenErr, 'битый JSON бросает, а не превращается в пустой пул');
check(brokenErr && brokenErr.poolCorrupt === 'unparseable', 'ошибка помечена poolCorrupt=unparseable');
check(readPool() === '{ это не JSON', 'битый файл не перезаписан');

writePool('{"accounts": []}');
let shapeErr = null;
try { pool.load(); } catch (e) { shapeErr = e; }
check(!!shapeErr, 'не массив бросает (пул - это список записей, а не объект)');

// ── 6. Список без секретов ────────────────────────────────────────────────────
section('6. Список без секретов');
clearPool();
const saved = pool.save([pool.normalize({ email: 'some.user@gmail.com', password: PASS, totpSecret: TOTP, recoveryEmail: RECOV }, [])]);
const view = pool.safeView(pool.load()[0]);
const viewText = JSON.stringify(view);
check(!('password' in view), 'в safeView нет поля password');
check(!('totpSecret' in view), 'в safeView нет поля totpSecret');
check(!('appPassword' in view), 'в safeView нет поля appPassword');
check(!viewText.includes(PASS), 'пароль не встречается в ответе списка');
check(!viewText.includes(TOTP), '2FA-секрет не встречается в ответе списка');
check(view.hasPassword === true && view.hasTotp === true, 'вместо самих секретов - признаки hasPassword и hasTotp');
check(view.email === 'some.user@gmail.com' && view.recoveryEmail === RECOV,
    'почта и почта восстановления остаются видны (они не секрет)');
check(saved[0].id === view.id, 'safeView сохраняет id записи');
check(view.kind === 'burner' && view.status === 'unknown', 'класс и статус по умолчанию - burner и unknown');
check(Array.isArray(view.usedOn) && view.usedOn.length === 0, 'usedOn - массив (поле живёт под будущие flow и antigravity)');

// 🪤 Идентификатор ищется по ТЕКУЩЕМУ пулу, а не по часам. На пустом массиве две записи,
// заведённые в одну миллисекунду, получили бы один id - а с ним один профиль на диске.
{
    const acc = [];
    acc.push(pool.normalize({ email: 'id.one@gmail.com', password: PASS }, acc));
    acc.push(pool.normalize({ email: 'id.two@gmail.com', password: PASS }, acc));
    check(new Set(acc.map(e => e.id)).size === 2, 'две записи подряд получают разные id (массив пула растущий)');
    // Обратную сторону тут проверять НЕЛЬЗЯ: на пустом массиве обе записи получают один id,
    // и это верное поведение функции - отличать их обязан вызывающий (ручки так и делают).
}

// ── 7. .gitignore - спрашиваем у самого git ───────────────────────────────────
section('7. Публичный репозиторий');
const inGit = (p) => {
    const r = spawnSync('git', ['-C', REPO, 'check-ignore', '-q', p], { encoding: 'utf8' });
    return r.status === 0;
};
for (const p of ['google/accounts.json', 'google/accounts.json.tmp-1234', 'google/profiles/acct_gg_1/Cookies', 'google/sessions/gg_1.json']) {
    check(inGit(p), `${p} закрыт .gitignore`);
}
check(!inGit('google/accounts.example.json'), 'образец записи НЕ закрыт - он должен ехать в коммит');
check(!inGit('routing/lib/google-pool.js'), 'модуль пула не закрыт (это код, а не данные)');
const example = path.join(REPO, 'google', 'accounts.example.json');
if (fs.existsSync(example)) {
    let ok = null;
    try { ok = JSON.parse(fs.readFileSync(example, 'utf8')); } catch { /* ниже */ }
    check(Array.isArray(ok) && ok.length >= 1, 'образец записи разбирается как JSON');
    check(Array.isArray(ok) && ok.every(e => pool.STATUSES.includes(e.status) && pool.KINDS.includes(e.kind)),
        'в образце только известные статусы и классы');
} else {
    skip('google/accounts.example.json ещё не создан');
}

// ── Итог ──────────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* временный каталог */ }
process.env.GOOGLE_DIR = '';
if (skips.length) say(`\nпропущено: ${skips.length}`);
say(`\n${total - fails.length}/${total} проверок пройдено`);
process.exit(fails.length ? 1 : 0);
