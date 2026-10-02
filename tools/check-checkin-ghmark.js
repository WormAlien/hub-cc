#!/usr/bin/env node
// Отказ подарка доезжает до строки аккаунта, а не только до лога.
//
// Заявка владельца 24.09 по живому логу пачки ⚡: «аккаунт с мертвым входом не помечается в
// дашборде, только в лог пишет». Разбор: `arAutoCheckinFinish` на `code !== 0` писал факт
// отказа в `AR_AUTO_CHECKIN` (память, TTL 10 мин) и в кольцо журнала (стирается рестартом),
// а в пул - НИЧЕГО. Строка после этого выглядела здоровой: `status: live`, баланс на месте,
// пустой `selfFailureKind`; причину приходилось искать в файле лога.
//
// Решение владельца: метку - в существующий слой статусов (колонка GITHUB), слоёв не
// плодить; такие аккаунты ПРОПУСКАТЬ в пачке.
//
// Вторая находка того же разбора: `arGhNameFor` звал `ghSnapHealth(ghSessionLib(), ghId)` -
// строку вместо записи. Внутри функция читает `account.id`, то есть `undefined` →
// `readCache(undefined)` → `hasSnap: false` → «(общего снимка нет)» дописывалось ВСЕГДА,
// хотя снимки лежали на диске у всех шести аккаунтов пачки.
//
// Запуск: node tools/check-checkin-ghmark.js
'use strict';
const fs = require('fs');
const path = require('path');

const lf = (s) => s.replace(/\r\n/g, '\n');
const PROXY = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'transparent-proxy.js'), 'utf8'));
const HTML = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'proxy-dashboard.html'), 'utf8'));
const OLD = process.env.CHECK_OLD_SRC
    ? lf(fs.readFileSync(process.env.CHECK_OLD_SRC, 'utf8')) : null;

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};
const cutFn = (src, head) => {
    const i = src.indexOf(head);
    if (i < 0) return '';
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? undefined : j + 2);
};
// Для строк-констант: режем по концу строки, иначе в срез попадает всё до следующей `\n}`.
const cutLine = (src, head) => {
    const i = src.indexOf(head);
    if (i < 0) return '';
    return src.slice(i, src.indexOf('\n', i));
};

const FINISH = cutFn(PROXY, 'async function arAutoCheckinFinish(');
const BUILD = cutFn(PROXY, 'function arBuildBatch(');
const ACTIVE = cutFn(PROXY, 'function arCheckinBlockActive(');

// ── 1. метка отказа уезжает в пул ──
console.log('\n1. отказ становится фактом пула, а не строкой в логе');
check(!!FINISH, 'arAutoCheckinFinish найден');
check(/checkinFailKind/.test(FINISH) && /checkinFailCode/.test(FINISH) && /checkinFailAt/.test(FINISH),
    'ветка отказа пишет вид, код и время отказа');
check(/arSaveMerge\(/.test(FINISH), 'пишет именно в пул (arSaveMerge), а не только в память');
check(/api_key/.test(FINISH), 'запись адресуется ключом - так пул ищет строку (см. arSaveMerge)');
check(/arCheckinFailKind\(code\)/.test(FINISH), 'вид метки берётся из таблицы кодов, а не из текста ошибки');

// ── 2. таблица кодов: кто закрывает сбор, кто нет ──
console.log('\n2. сбор закрывают только причины про GitHub-вход');
const kinds = cutLine(PROXY, 'const AR_CHECKIN_FAIL_KIND =');
check(/3:\s*'gh_dead'/.test(kinds) && /5:\s*'gh_dead'/.test(kinds) && /9:\s*'gh_dead'/.test(kinds),
    'коды 3, 5, 9 (GitHub-вход не состоялся) закрывают сбор');
check(!/\b6:/.test(kinds) && !/\b8:/.test(kinds),
    '6 (рейт-лимит) и 8 (край молчит) НЕ закрывают: они лечатся временем, у 6 свой повтор');

// ── 3. метка снимается сама, когда вход вернулся ──
console.log('\n3. поведение: помеченный аккаунт, у которого вход ожил');
function mkActive(activeSrc, snap) {
    const gsl = {
        readCache: () => snap,
        cacheLive: (s) => !!(s && s.live),
    };
    const fn = new Function('deps',
        `const { ghSessionLib } = deps;\n${activeSrc}\nreturn { arCheckinBlockActive };`);
    return fn({ ghSessionLib: () => gsl });
}
{
    if (!ACTIVE) {
        check(false, 'arCheckinBlockActive найден');
    } else {
    const at = '2026-09-24T00:40:00.000Z';
    const marked = { id: 'ar_1', ghId: 'gh_1', checkinFailKind: 'gh_dead', checkinFailCode: 9, checkinFailAt: at, checkinFailMsg: 'x' };
    const run = (snap) => mkActive(ACTIVE, snap).arCheckinBlockActive(marked);
    check(run(null) !== null, 'свежего доказательства нет - метка жива');
    check(run({ live: false, harvestedAt: '2026-09-24T01:00:00.000Z' }) !== null,
        'снимок есть, но его кука мертва - метка жива (harvest мог перезаписать те же мёртвые куки)');
    check(run({ live: true, harvestedAt: '2026-09-24T00:00:00.000Z' }) !== null,
        'живой снимок, снятый ДО отказа, метку не снимает');
    check(run({ live: true, harvestedAt: '2026-09-24T01:00:00.000Z' }) === null,
        'живой снимок, снятый ПОСЛЕ отказа (владелец перелогинился), метку снимает');
    check(mkActive(ACTIVE, null).arCheckinBlockActive({ id: 'ar_2', status: 'live' }) === null,
        'на аккаунте без метки ничего не блокируется');
    }
}

// ── 4. пачка помеченного не берёт ──
console.log('\n4. поведение: пачка и добор пропускают помеченный аккаунт');
{
    const WHY = cutFn(PROXY, 'function arCheckinBlockWhy(');
    // Гоняем НАСТОЯЩИЕ arCheckinBlockActive и arCheckinBlockWhy: подставной вердикт
    // проверил бы только мою же заглушку, а не текст, который увидит владелец.
    const fn = new Function('deps', 'arCheckinReadyList',
        `const { AR_COLLECT_SEEN, AR_AUTO_CHECKIN, arLkPids, arPidAlive, arQueueSpot, arLoad, ghSessionLib } = deps;\n`
        + `${ACTIVE}\n${WHY}\n${BUILD}\nreturn { arBuildBatch };`);
    const sessions = [
        { id: '1', name: 'deadgh', api_key: 'sk-1', status: 'live', ghId: 'gh_1',
          checkinFailKind: 'gh_dead', checkinFailCode: 9, checkinFailAt: '2026-09-24T00:40:00.000Z' },
        { id: '2', name: 'healthyguy', api_key: 'sk-2', status: 'live', ghId: 'gh_2' },
    ];
    const deps = {
        AR_COLLECT_SEEN: new Set(), AR_AUTO_CHECKIN: new Map(), arLkPids: new Map(),
        arPidAlive: () => false, arQueueSpot: () => null, arLoad: () => sessions,
        // Живой сессии GitHub ни у кого нет - метка держится.
        ghSessionLib: () => ({ readCache: () => null, cacheLive: () => false }),
    };
    const r = fn(deps, () => sessions).arBuildBatch(6);
    check(BUILD && r.jobs.length === 1 && r.jobs[0].dispName === 'healthyguy',
        'в пачку едет только аккаунт с живым входом');
    const why = (r.skipped || []).join(' ');
    check(/deadgh/.test(why), 'причина пропуска называет аккаунт');
    check(/вход в GitHub мёртв/.test(why), 'и объясняет причину: дело во входе, а не в очереди');
    check(/код 9/.test(why), 'в причине виден код отказа');
}

// ── 5. снятие метки: стирает все четыре поля и не пишет пустоту ──
console.log('\n5. поведение: снятие метки не оставляет хвостов');
{
    const CLEAR = cutFn(PROXY, 'function arCheckinFailClear(');
    const mk = (pool, throwIo) => {
        const saved = [];
        const fn = new Function('deps',
            `const { arLoad, arSave, logLine } = deps;\n${cutLine(PROXY, 'const AR_CHECKIN_FAIL_FIELDS =')}\n${CLEAR}\nreturn { arCheckinFailClear };`);
        const api = fn({
            arLoad: () => { if (throwIo) throw new Error('пул обнулён'); return pool; },
            arSave: (l) => saved.push(l),
            logLine: () => {},
        });
        return { api, saved, pool };
    };
    const marked = {
        id: 'ar_1', api_key: 'sk-1', status: 'live',
        checkinFailKind: 'gh_dead', checkinFailCode: 9,
        checkinFailAt: '2026-09-24T00:40:00.000Z', checkinFailMsg: 'вход мёртв',
    };
    const t = mk([marked]);
    check(t.api.arCheckinFailClear('ar_1') === true && t.saved.length === 1, 'успешный прогон снимает метку');
    check(!('checkinFailKind' in marked) && !('checkinFailCode' in marked)
        && !('checkinFailAt' in marked) && !('checkinFailMsg' in marked),
        'стираются все четыре поля, а не только вид');
    check(marked.status === 'live' && marked.api_key === 'sk-1', 'остальная запись не тронута');

    const clean = mk([{ id: 'ar_2', api_key: 'sk-2' }]);
    check(clean.api.arCheckinFailClear('ar_2') === false && clean.saved.length === 0,
        'аккаунту без метки лишней записи в пул не делаем');

    const broken = mk([], true);
    check(broken.api.arCheckinFailClear('ar_1') === false && broken.saved.length === 0,
        'битый пул: метка не снимается и поверх него не пишут');
}

// ── 6. фронт рисует метку в существующем слое, а не новым ──
console.log('\n6. метка видна в строке аккаунта');
check(/checkinBlock/.test(PROXY) && /checkinBlock/.test(HTML),
    'вердикт едет на фронт тем же полем, что читает таблица');
const badge = cutFn(HTML, 'function newapiGhBadge(');
check(/checkinBlock/.test(badge), 'бейдж колонки GITHUB (тот самый слой статусов) его знает');
check(/crimson/.test(badge), 'отказ красит бейдж в красный, а не в предупреждение');
// Правка внутри шаблонной строки: ни `node --check` по .js, ни линтер до неё не дотянутся,
// а сломанный синтаксис тут роняет ВСЮ вкладку (весь инлайн-скрипт дашборда).
check((() => { try { new Function(badge); return true; } catch (e) { return false; } })(),
    'бейдж разбирается как функция - правка не сломала инлайн-скрипт дашборда');

// ── 6. побочно: имя GitHub в ошибке не врёт про снимок ──
console.log('\n7. текст отказа не выдумывает «общего снимка нет»');
const ghName = cutFn(PROXY, 'function arGhNameFor(');
check(/ghSnapHealth\(ghSessionLib\(\), \{[\s\S]*?\bid:\s*ghId/.test(ghName),
    'в ghSnapHealth уезжает запись с id, а не строка: строку функция читает как account.id=undefined');

if (OLD) {
    console.log('\n8. краснота на старом коде');
    const oldFinish = cutFn(OLD, 'async function arAutoCheckinFinish(');
    check(!/checkinFailKind/.test(oldFinish), 'до правки метки отказа в пуле не было');
    check(!/checkinBlock/.test(OLD), 'и вердикта на фронт не приезжало');
    const oldGhName = cutFn(OLD, 'function arGhNameFor(');
    check(/ghSnapHealth\(ghSessionLib\(\), ghId\)/.test(oldGhName),
        'и «(общего снимка нет)» дописывалось всегда - строка вместо записи');
}

console.log(fail ? `\n❌ ${fail} провалено` : '\n✅ Отказ подарка помечается в пуле и виден в строке аккаунта.');
process.exit(fail ? 1 : 0);
