#!/usr/bin/env node
// Regression: браузерный релогин AgentRouter идёт ЧЕРЕЗ адрес из пула, а не напрямую.
//
// Граница перевёрнута 20.09.2026 - это отмена решения 12.09 «прокси не сопровождает сбор
// подарка». Причина отмены измерена: прямой путь с рабочей станции выходит адресом ноды CH
// (локальный tun включён всегда), и панель жжёт этот адрес после ~19 запросов логина
// (замер 20.09, окно отстоя ~20 мин, воспроизведено дважды). То есть «идти напрямую»
// означало светить своей же нодой. Разбор - wiki «Ротация адресов под подарки AgentRouter».
//
// Что обязано быть правдой, и каждый пункт ломается МОЛЧА:
//   1. ребёнок читает разовый адрес и отдаёт его в launchPersistentContext;
//   2. разовый файл съедается - иначе следующий прогон поедет старым адресом;
//   3. SOCKS с логином и паролем - отказ ДО запуска: Chromium такое молча игнорирует
//      и уходит напрямую, то есть ровно туда, откуда мы уходим;
//   4. родитель берёт адрес ДО спавна (нет адреса - окно не поднимается) и пишет расход
//      адреса на выходе, числом от ребёнка, а не «примерно»;
//   5. все адреса в отстое - очередь ЖДЁТ ближайший и показывает таймер.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POOL = require(path.join(ROOT, 'routing', 'lib', 'proxy-pool.js'));
const SESSION = require(path.join(ROOT, 'agentrouter', 'open-session.js'));
const sessionSrc = fs.readFileSync(path.join(ROOT, 'agentrouter', 'open-session.js'), 'utf8').replace(/\r\n/g, '\n');
const dashSrc = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
function check(ok, what) {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
}
function cutFn(src, head) {
    const start = src.indexOf(head);
    if (start < 0) return '';
    const body = src.indexOf('{', src.indexOf(')', start));
    if (body < 0) return '';
    let depth = 0;
    for (let i = body; i < src.length; i++) {
        if (src[i] === '{') depth++;
        if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return '';
}

console.log('\n1. ребёнок читает разовый адрес и отдаёт его в браузер');
const seedFn = cutFn(sessionSrc, 'function takeProxySeed(');
check(seedFn.length > 0, 'takeProxySeed найден');
check(/PROXY_SEED_DIR/.test(sessionSrc) && /ar-proxy/.test(sessionSrc), 'каталог разовых файлов объявлен');
check(/fs\.rmSync\(file,\s*\{\s*force:\s*true\s*\}\)/.test(seedFn), 'разовый файл СЪЕДАЕТСЯ после чтения');
check(/server:/.test(seedFn) && /username:/.test(seedFn), 'из файла берутся server и логин с паролем');

const main = cutFn(sessionSrc, 'async function main(');
const launchAt = main.indexOf('chromium.launchPersistentContext');
const launchEnd = main.indexOf('});', launchAt);
const launch = launchAt >= 0 && launchEnd >= 0 ? main.slice(launchAt, launchEnd + 3) : '';
check(launchAt >= 0, 'launchPersistentContext найден');
check(/proxy:\s*proxySeed/.test(launch), 'адрес передан в launchPersistentContext');
check(/accountUserAgent\(/.test(main) && /userAgent:\s*ua/.test(launch), 'липкий UA аккаунта на месте');
check(/Network\.setUserAgentOverride/.test(sessionSrc) && /userAgentMetadata:\s*uaMetadata\(ua\)/.test(sessionSrc)
    && /applyUserAgentOverride\(context, page, ua\)/.test(main),
    'парный CDP userAgentMetadata на месте');

console.log('\n2. SOCKS с паролем - отказ до запуска браузера');
check(/\^socks/i.test(sessionSrc) && /process\.exit\(7\)/.test(sessionSrc),
    'SOCKS с логином и паролем роняет прогон кодом 7, а не уходит напрямую');

console.log('\n3. запросы ручки логина считаются в браузере и уезжают родителю');
const watchFn = cutFn(sessionSrc, 'function watchLoginRequests(');
check(watchFn.length > 0 && /\/api\/oauth\/state/.test(watchFn),
    'счётчик ручки логина живёт в watchLoginRequests');
check(/loginHit = watchLoginRequests\(context\)/.test(main),
    'навешивается в main ПОСЛЕ разлогина');
check(!/\/api\/oauth\/state/.test(main.slice(0, main.indexOf('await doCheckinLogout(context, page)'))),
    'до разлогина state-OAuth по-прежнему не трогается (иначе проба подменила бы живую сессию)');
check(/loginRequests:\s*loginHit\.n/.test(sessionSrc) && /AUTOCHECKIN_RESULT/.test(sessionSrc),
    'число уходит в маркере AUTOCHECKIN_RESULT');
// 🔴 Живой случай 20.09: упавший прогон маркера не печатал, и родитель списывал с адреса
// значение по умолчанию вчетверо больше сделанного - счёт раздувался, кольцо ротации
// сбивалось, один адрес выгорал раньше прочих.
check(/process\.on\('exit',\s*\(\)\s*=>\s*emitMarker\(/.test(sessionSrc),
    'маркер печатается и на выходе без вердикта - упавший прогон тоже отчитывается');
check(/let markerSent = false/.test(sessionSrc), 'маркер не дублируется (печатается один раз)');
check(/const AR_LOGIN_COST = 1;/.test(dashSrc),
    'запасное значение расхода - 1 запрос (меряно), а не 4');

console.log('\n4. родитель: адрес ДО спавна, расход на выходе');
const spawn = cutFn(dashSrc, 'function arSpawnSession(');
check(spawn.length > 0, 'arSpawnSession найден');
const callAt = spawn.indexOf('spawn(process.execPath');
const takeAt = spawn.indexOf('arTakeAddress(');
check(takeAt >= 0 && callAt >= 0 && takeAt < callAt, 'адрес берётся ДО спавна окна');
check(/if\s*\(!addr\.ok\)/.test(spawn) && /throw new Error/.test(spawn),
    'нет адреса - окно НЕ поднимается (бросаем, а не «пойдём как-нибудь»)');
check(/arSpendAddress\(label,\s*marker\s*&&\s*marker\.loginRequests\)/.test(spawn),
    'расход адреса пишется на выходе окна, числом от ребёнка');
check(/arDropSeed\(label\)/.test(spawn), 'разовый файл подчищается на ошибке');
check(/arRunProxy\.set\(job\.label,\s*p\.id\)/.test(cutFn(dashSrc, 'function arTakeAddress(')),
    'id адреса запоминается, чтобы списать расход именно с него');

console.log('\n5. все адреса в отстое - очередь ждёт, а не спавнит');
const takeFn = cutFn(dashSrc, 'function arTakeAddress(');
check(/rotateFor\(/.test(takeFn) && /agentrouter\.org/.test(dashSrc), 'адрес берётся ротацией по хосту agentrouter.org');
check(/enabledForHost\(AR_POOL_HOST\)/.test(takeFn), 'выключенный пул - прежнее поведение, без прокси');
const pump = cutFn(dashSrc, 'function arCheckinPump(');
check(/arPoolGate\(\)/.test(pump) && /gate\.cooling/.test(pump), 'насос проверяет отстой до спавна');
check(/ждём адрес/.test(pump), 'в статусе видно, что очередь ждёт адрес');

console.log('\n6. окно очереди не лезет вперёд, окно 🎁 - лезет');
check(/let silentWindow = !\['checkin', 'console', 'register'\]\.includes\(mode\)/.test(sessionSrc),
    'тихий режим - только у автоматических прогонов; ручные (🎁, ЛК) и регистрация идут с окном');
// 🔴 Регистрация с окном - не вкус, а условие работоспособности: скрипт ждёт GitHub-логина
// до 10 минут, а в headless логиниться некуда. Свежая установка 23.09: окно спрятали, прогон
// умер по таймауту, и в дашборде это выглядело как «браузер не появляется». Тот же случай -
// 'auto' на чистом профиле (он и есть регистрация): режим обязан выйти из тихого.
check(/if \(mode === 'auto' && fresh\) silentWindow = true/.test(sessionSrc),
    'первый вход на чистом профиле тоже выходит из тихого режима - человеку нужно окно');
const raiseIdx = sessionSrc.indexOf('raiseBrowserWindow();');
const guardIdx = sessionSrc.lastIndexOf('if (!silentWindow) {', raiseIdx);
check(raiseIdx > 0 && guardIdx > 0 && raiseIdx - guardIdx < 200,
    'bringToFront и raiseBrowserWindow стоят ПОД условием «не тихий режим»');
// 🎯 Автоматический прогон идёт БЕЗ ОКНА. Сворачивание через CDP не годилось: окно всё
// равно создаётся и Windows успевает его активировать - замер 21.09 поймал активным окно
// «Agent Router - Google Chrome» прямо во время прогона.
check(/headless:\s*silentWindow/.test(launch), 'автоматический прогон идёт headless - окна нет вовсе');
check(!/Browser\.setWindowBounds/.test(sessionSrc), 'костыля со сворачиванием больше нет');
check(!/--start-minimized/.test(launch),
    'в АРГУМЕНТАХ запуска нет --start-minimized: замер 20.09 показал, что Chrome на Windows его игнорирует');

console.log('\n7. круг «родитель записал → ребёнок прочитал»');
{
    // 🔴 Живой баг 20.09: родитель писал плоский `{server, username, password}`, а ребёнок
    // читал `doc.proxy` - оба куска на месте, договор разошёлся, и браузер молча шёл
    // НАПРЯМУЮ (через tun, то есть через тот же адрес ноды), пока родитель списывал расход
    // с выданного адреса. Статическая сверка такого не ловит - поэтому гоняем настоящий круг.
    const takeFn = cutFn(dashSrc, 'function arTakeAddress(');
    const m = takeFn.match(/JSON\.stringify\((\{[\s\S]*?\}),\s*null,\s*1\)/);
    check(!!m, 'найден литерал записи разового файла в arTakeAddress');
    // 🪤 Заглушку берём у САМОГО пула, а не выдумываем: 20.09 я подставил сюда объект с полем
    // `host`, литерал его прочитал, тест позеленел - а в бою поле называется `hostname`, и в
    // окно уезжало `http://undefined:10808`. Проверка должна идти по настоящей форме данных.
    const stub = POOL.parseProxy('http://u1:p1@10.9.8.7:8080');
    check(!!stub && stub.hostname === '10.9.8.7', 'заглушка взята у пула и разобрана');
    // 🪤 В функцию НЕ подставляем ничего, кроме того, что реально передаёт вызывающий:
    // 20.09 я подсунул сюда `nowIso` параметром, и литерал, звавший несуществующую в
    // transparent-proxy.js функцию, прошёл проверку - а в бою КАЖДЫЙ запуск падал
    // `nowIso is not defined`. Тест обязан ругаться на то же, на чём спотыкается прод.
    let written = null;
    let litErr = null;
    try {
        written = m ? new Function('p', 'AR_POOL_HOST', `return (${m[1]})`)(stub, 'agentrouter.org') : null;
    } catch (e) { litErr = e; }
    check(!litErr, `литерал записи вычисляется в честном окружении (${litErr ? litErr.message : 'ок'})`);
    check(!!written && !!written.proxy, 'родитель пишет ОБЁРТКУ proxy (а не плоский объект)');

    const dir = path.join(ROOT, 'routing', 'runtime', 'ar-proxy');
    const file = path.join(dir, 'check-seed-roundtrip.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(written), 'utf8');
    const parsed = SESSION.takeProxySeed('check-seed-roundtrip');
    check(!!parsed && parsed.server === 'http://10.9.8.7:8080', 'ребёнок прочитал адрес из того, что записал родитель');
    check(!!parsed && parsed.username === 'u1' && parsed.password === 'p1', 'логин и пароль доехали');
    check(!fs.existsSync(file), 'разовый файл съеден - второй прогон его не найдёт');
}

console.log('\n8. «Получить все» доводит до конца, стоп его гасит');
// Кнопка обещала «все», а ставила шесть: дальше надо было жать ещё раз, и снаружи это
// выглядело как «кнопка не работает». Добор живёт в насосе и обязан иметь предохранители.
const allFn = cutFn(dashSrc, 'async function handleArCheckinAll(');
const pumpFn = cutFn(dashSrc, 'function arCheckinPump(');
const cancelFn = cutFn(dashSrc, 'function arCheckinCancel(');
check(/AR_COLLECT_ALL = true/.test(allFn), 'кнопка включает добор до конца');
check(/AR_COLLECT_BATCHES = 0/.test(allFn), 'новый заход обнуляет счёт пачек');
check(/AR_COLLECT_ALL && !AR_CHECKIN_QUEUE\.length/.test(pumpFn), 'насос добирает, когда очередь опустела');
check(/arBuildBatch\(AR_CHECKIN_BATCH_MAX\)/.test(pumpFn), 'добор идёт теми же пачками по 6');
check(/AR_COLLECT_BATCHES >= AR_COLLECT_MAX/.test(pumpFn), 'у добора есть потолок числа пачек');
check(/пачка ушла в стену/.test(pumpFn), 'пачка без единого успеха останавливает добор');
check(/AR_COLLECT_ALL = false/.test(cancelFn), 'стоп-кран гасит добор, а не только очередь');
check(/collectAll: AR_COLLECT_ALL/.test(dashSrc), 'карточка видит, что добор идёт');

console.log(fail ? `\n❌ ${fail} failed` : '\n✅ Релогин идёт через адрес из пула; UA и CDP-подсказки на месте.');
process.exit(fail ? 1 : 0);
