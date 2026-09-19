#!/usr/bin/env node
// Автоподарок AgentRouter: GitHub-сессия берётся из ОБЩЕЙ схемы, а протухшая видна
// плашкой (10.09).
//
// Было: `agentrouter/open-session.js` знал ровно одну копию сессии — свою,
// `agentrouter/gh-sessions/<label>.json`, которая появляется только после того, как этот
// скрипт хоть раз отработал под живой сессией. Общий снимок
// `github/sessions/<ghId>.json` он не читал НИКОГДА, хотя запись туда двусторонняя с
// самого начала (routing/lib/gh-live-capture.js → writeShared). Из-за этого ⚡ выходил с
// кодом 3 «GitHub-сессия мертва, возьми готовый GitHub заново» — при том что годная
// сессия этого же аккаунта лежала на диске рядом. Замер 10.09: общий снимок был у всех
// 20 привязанных записей AR, 16 моложе суток.
//
// И второе: бейдж 🐙 в колонке GitHub был ВСЕГДА бирюзовый, про живость не говорил
// ничего, а текст ошибки не называл аккаунт — на пуле из двадцати записей это означало
// «чини наугад».
//
// Запуск: node tools/check-ar-gh-fallback.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lf = (s) => s.replace(/\r\n/g, '\n');
const SESS = lf(fs.readFileSync(path.join(ROOT, 'agentrouter', 'open-session.js'), 'utf8'));
const PROXY = lf(fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8'));
const HTML = lf(fs.readFileSync(path.join(ROOT, 'routing', 'proxy-dashboard.html'), 'utf8'));
const GSL = require('../routing/lib/github-session.js');

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

// ── 1. скрипт вообще знает про общую схему ──
console.log('\n1. общий снимок читается');
check(/github', 'sessions'/.test(SESS) || /GH_SHARED_DIR/.test(SESS),
    'скрипт знает путь github/sessions/<ghId>.json');
check(/ghIdForLabel\(/.test(SESS),
    'ghId резолвится готовым хелпером из gh-live-capture, а не второй копией');
const loadShared = cutFn(SESS, 'function loadSharedGhSnapshot(');
check(/harvestedAt/.test(loadShared) && /ageDays/.test(loadShared),
    'возраст снимка считается и отдаётся наружу');
check(/c\.expires === -1/.test(loadShared),
    'сессионные куки (expires: -1) не выбрасываются — в живой контекст они годятся');
check(!/cacheStale|TTL_MS/.test(loadShared),
    'по TTL снимок НЕ отсекается: решение владельца — вливать и пробовать');

// ── 2. три места, где снимок подставляется ──
console.log('\n2. снимок пробуется до того, как сдаться');
const restore = cutFn(SESS, 'async function restoreGithubIfLost(');
check(/seedFromSharedSnapshot\(/.test(restore),
    'цепочка восстановления: куки «до» → своя копия → общий снимок');
{
    const auto = SESS.slice(SESS.indexOf('      if (auto) {'), SESS.indexOf('🔄 GitHub-часть'));
    check(/seedFromSharedSnapshot\([\s\S]*?process\.exit\(3\)/.test(auto),
        'перед выходом с кодом 3 (нет user_session) снимок пробуется');
    check(/seedFromSharedSnapshot\(/.test(cutFn(SESS, 'async function ensureGithubSession(')),
        'дверь «нет user_session» пробует общий снимок — вынесена в общий хелпер обеих проверок');
    check((auto.match(/seedFromSharedSnapshot\(/g) || []).length === 1
        && /ensureGithubSession\(/.test(auto)
        && /GitHub попросил пароль\/2FA/.test(auto),
        'и на «нет user_session», и на «GitHub попросил пароль/2FA» — обе двери');
    check(/повторяю вход после подъёма сессии/.test(auto),
        'после подъёма сессии вход повторяется, а не просто логируется');
    check((auto.match(/clickGithubLogin\(/g) || []).length === 2,
        'повтор ровно один — иначе цикл');
}
check(/ghNameForError\(/.test(SESS), 'в тексте ошибки скрипта назван GitHub-аккаунт');

// ── 3. бэкенд: здоровье снимка на роуте, который фронт и так грузит ──
console.log('\n3. здоровье снимка приезжает на фронт');
const keys = cutFn(PROXY, 'async function handleGhKeys(');
check(/ghSnapHealth\(/.test(keys), '/api/gh/keys отдаёт здоровье снимка вместе со списком');
const health = cutFn(PROXY, 'function ghSnapHealth(');
check(/readCache/.test(health) && /cacheAgeMs/.test(health) && /cacheStale/.test(health),
    'считается готовыми хелперами github-session, а не своей арифметикой');
check(/hasSnap: null/.test(health),
    'модуль недоступен → null, а не false: врать «снимка нет» на незнании нельзя');
check(/transferableProfile/.test(health) && /hasSession/.test(health),
    'здоровье объединяет общий снимок с переносимой user_session из профилей');
check(/sessionSource/.test(health) && /profileSource/.test(health),
    'бэкенд называет источник сессии, а не только выдаёт булево');

const now = Date.now();
const profileHit = typeof GSL.transferableProfile === 'function'
    ? GSL.transferableProfile(['profile-only'], [
        { login: 'other', hasUserSession: true, lastUpdate: now - 1000, tag: 'go', label: 'wrong' },
        { login: 'PROFILE-ONLY', hasUserSession: true, lastUpdate: now, tag: 'ar', label: 'acct_profile_only' },
      ])
    : null;
check(!!profileHit && profileHit.label === 'acct_profile_only',
    'профиль с user_session считается переносимым даже без общего снимка');
check(typeof GSL.transferableProfile === 'function'
    && GSL.transferableProfile(['empty'], [
        { login: 'empty', hasUserSession: false, lastUpdate: now, tag: 'ar', label: 'acct_empty' },
      ]) === null,
    'профиль без user_session не выдаётся за переносимую сессию');

// ── 4. фронт: агрегированное состояние бейджа ──
console.log('\n4. плашка в строке аккаунта');
const badge = cutFn(HTML, 'function newapiGhBadge(');
// Свежесть бейдж читает в двух измерениях: snapAgeDays (возраст файла) и snapLive
// (проживёт ли снимок дальше - по сроку куки). 19.09 выяснилось, что решать должно
// второе: снимок 11 суток от роду с кукой, которой жить ещё 3 суток, полностью рабочий.
check(/snapLive/.test(badge) && /snapAgeDays/.test(badge), 'бейдж читает свежесть снимка');
check(/hasSession === false/.test(badge) && /status === 'dead'/.test(badge),
    'красное состояние — только «сессии нет нигде» или аккаунт помечен dead');
check(/sessionSource/.test(badge) && /profileSource/.test(badge),
    'подсказка бейджа различает общий снимок и профиль-источник');
check(/crimson/.test(badge) && /amber/.test(badge) && /teal/.test(badge),
    'три цвета: живой / протух / нечем входить');
check(/snapLive === false/.test(badge),
    'протухшим считается снимок с истёкшей кукой (snapLive), и только без профильного источника');

// ── 5. имя аккаунта в тосте ошибки ──
console.log('\n5. ошибка называет аккаунт');
const nameFor = cutFn(PROXY, 'function arGhNameFor(');
check(/ghLoad\(\)/.test(nameFor) && /nickname/.test(nameFor), 'ник берётся из менеджера GitHub');
check(/personal/.test(nameFor), 'личный GitHub владельца назван словами, а не ghId');
const finish = cutFn(PROXY, 'async function arAutoCheckinFinish(');
check(/code === 3 \|\| code === 5 \|\| code === 9/.test(finish) && /arGhNameFor\(id\)/.test(finish),
    'коды 3, 5 и 9 (это всегда про сессию) получают имя аккаунта в сообщение');
// Ищем в самой таблице сообщений, а не по всему файлу: старая формулировка законно
// цитируется в комментариях «как было» — на них проверка срабатывать не должна.
{
    const fails = PROXY.slice(PROXY.indexOf('const AR_AUTO_CHECKIN_FAIL'), PROXY.indexOf('const AR_CHECKIN_FAIL_MANUAL'));
    check(!/GitHub-сессия аккаунта мертва/.test(fails) && /общий снимок тоже не подошёл/.test(fails),
        'текст кода 3 говорит, что общий снимок уже пробовали, и не притворяется безымянным');
}

// ── 6. живой прогон на настоящих файлах ──
// Вырезаем блок работы со снимком и исполняем его с подставными зависимостями: браузера
// и :8200 не нужно, а формат снимка проверяется на боевых github/sessions/*.json.
console.log('\n6. поведение на боевых снимках');
{
    const from = SESS.indexOf('const AR_POOL_FILE =');
    const to = SESS.indexOf('// Как назвать сессию в тексте ошибки');
    if (from < 0 || to < 0 || to <= from) {
        check(false, 'блок работы со снимком найден в исходнике');
    } else {
        const build = new Function('deps', `
            const { fs, path, require, __dirname, console } = deps;
            let label = deps.label;
            ${SESS.slice(from, to)}
            return { loadSharedGhSnapshot, seedFromSharedSnapshot, setLabel: (v) => { label = v; } };
        `);
        const mk = (label) => build({
            fs, path, require, __dirname: path.join(ROOT, 'agentrouter'), console: { log: () => {} }, label,
        });

        // Берём первую запись пула с настоящей привязкой — тест не должен зависеть от
        // конкретного аккаунта, их состав меняется.
        const pool = JSON.parse(fs.readFileSync(path.join(ROOT, 'routing', 'agentrouter-sessions.json'), 'utf8'));
        const list = Array.isArray(pool) ? pool : (pool.sessions || []);
        const linked = list.find(s => /^gh_/.test(String(s.ghId || ''))
            && fs.existsSync(path.join(ROOT, 'github', 'sessions', String(s.ghId).replace(/[^\w-]/g, '_') + '.json')));
        if (!linked) {
            check(false, 'в пуле есть запись с привязкой и общим снимком (нечего проверять)');
        } else {
            const api = mk('acct_' + linked.id);
            const snap = api.loadSharedGhSnapshot();
            check(!!snap, `общий снимок читается для живой записи (${linked.name || linked.id})`);
            check(!!snap && snap.cookies.some(c => c.name === 'user_session'),
                'user_session переживает фильтрацию — иначе вливать нечего');
            check(!!snap && typeof snap.ageDays === 'number', 'возраст снимка — число');
            check(!!snap && typeof snap.ghLogin === 'string' && snap.ghLogin.length > 0,
                'в снимке есть логин GitHub — есть чем назвать аккаунт в ошибке');

            // Несуществующая запись: молча null, без исключения.
            check(mk('acct_ar_нет_такого_0').loadSharedGhSnapshot() === null,
                'у записи без привязки снимка нет, и это не падение');

            // Вливание: контекст «до» пустой, «после» — с user_session.
            (async () => {
                const added = [];
                const ctx = {
                    addCookies: async (c) => { added.push(...c); },
                    cookies: async () => added,
                };
                const r = await api.seedFromSharedSnapshot(ctx, 'тест');
                check(!!r && r.ok === true, 'вливание отдаёт ok:true, когда user_session появилась');
                check(added.length === snap.cookies.length, 'в контекст уехали все куки снимка');

                const deaf = { addCookies: async () => {}, cookies: async () => [] };
                const r2 = await api.seedFromSharedSnapshot(deaf, 'тест');
                check(!!r2 && r2.ok === false, 'если user_session не появилась — честный ok:false, а не «поднял»');

                const none = mk('acct_ar_нет_такого_0');
                check((await none.seedFromSharedSnapshot(ctx, 'тест')) === null,
                    'нет снимка → null, вливать нечего');

                console.log(fail ? `\n❌ ${fail} провалено` : '\n✅ GitHub-сессия: общий снимок читается и вливается, протухшая видна плашкой и названа в ошибке.');
                process.exit(fail ? 1 : 0);
            })();
        }
    }
}
