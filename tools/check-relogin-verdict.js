#!/usr/bin/env node
// Вердикт «вход был после цифры» не должен ронять запись баланса.
//
// Зачем файл. Блок смягчения вердикта (`reloginAfterCheck`, 15.09) обращался к `prof` и
// `host` — переменным из ЧУЖОЙ функции (`newapiBalance`, строка ~8860). `newapiApplyBalance`
// их не видит, поэтому прогон падал с `ReferenceError`, а панель показывала
// «balance: prof is not defined».
//
// 🪤 Симптом обманчив: выглядит как «аккаунт залогинен, а баланс не чекается». На самом
// деле чека не было вообще — падала ЗАПИСЬ результата, то есть цифра не доезжала до пула
// ни на одном аккаунте, включая живые.
//
// 🪤 Почему это не поймал `node --check`: undefined-переменная — не синтаксис, а область
// видимости. Ловит только исполнение.
//
// Запуск: node tools/check-relogin-verdict.js
'use strict';

const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const src = fs.readFileSync(DASH, 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};
function cutFn(text, head) {
    const start = text.indexOf(head);
    if (start < 0) throw new Error(`не нашёл: ${head}`);
    let i = start, paren = 0, sawParen = false;
    for (; i < text.length; i += 1) {
        const c = text[i];
        if (c === '(') { paren += 1; sawParen = true; }
        else if (c === ')') { paren -= 1; if (sawParen && paren === 0) { i += 1; break; } }
    }
    let depth = 0, seen = false;
    for (; i < text.length; i += 1) {
        const c = text[i];
        if (c === '{') { depth += 1; seen = true; }
        else if (c === '}') { depth -= 1; if (seen && depth === 0) return text.slice(start, i + 1); }
    }
    throw new Error(`не закрыл тело: ${head}`);
}

const body = cutFn(src, 'function newapiApplyBalance(');

// Песочница: ровно те свободные имена, что функция берёт снаружи. Если появится новое —
// тест упадёт на ReferenceError, и это правильно: оно тоже окажется undefined в бою.
function makeWorld() {
    const world = { logs: [], ops: [], notes: [] };
    const deps = {
        logLine: (m) => world.logs.push(String(m)),
        // Журнал сбора на вкладке AgentRouter: та же строка уезжает и туда (см. arNote в
        // transparent-proxy.js). Собираем отдельно - по нему проверяем, что налив виден
        // владельцу, а не только в общем логе, который тонет в keepalive.
        arNote: (kind, text) => world.notes.push({ kind, text }),
        financeLog: (o) => world.ops.push(o),
        moneyKickOnZero: () => {},
        newapiLkOpenedAt: (label) => {
            world.lastLkLabel = label;
            return world.lkAt || 0;
        },
        AR_CHECKIN_MIN_USD: 20,
        AR_CHECKIN_OBSERVE_MAX_MS: 24 * 3600_000,
        AR_LOGIN_KINDS: ['login_dead', 'login_expired'],
    };
    const factory = new Function('deps', `
        const { logLine, arNote, financeLog, moneyKickOnZero, newapiLkOpenedAt, AR_CHECKIN_MIN_USD,
                AR_CHECKIN_OBSERVE_MAX_MS, AR_LOGIN_KINDS } = deps;
        ${body}
        return newapiApplyBalance;
    `);
    world.apply = factory(deps);
    return world;
}

// Живой чек прошёл, но self-часть отбилась: ровно состояние, в котором включается смягчение.
const liveBal = (over = {}) => ({
    status: 'live', balance: 100, spent: 10, granted: 110, grantedSelf: 110,
    balanceSource: 'self', selfCached: true, self: { granted: 110 }, ...over,
});

console.log('\n1. блок смягчения исполняется, а не падает');
{
    const w = makeWorld();
    // 🪤 Дата цифры обязана лежать и в `bal.self`: запись берёт её ОТТУДА (строка ~9428), а на
    // отсутствующую подставляет «сейчас» — и тогда вход никогда не окажется её новее, то есть
    // блок молча не сработает. Тест обязан повторять боевую форму ответа, иначе проверяет не то.
    const staleFigure = new Date(Date.now() - 3600_000).toISOString();
    const target = {
        id: 'ar_1', api_key: 'sk-test-key', profile: 'acct_ar_1',
        selfCheckedAt: staleFigure,
        checkinAt: new Date().toISOString(), checkinFrom: 'auto',
        selfFailureKind: 'login_dead',
        balance: 100, spent: 10, granted: 110, grantedSelf: 110,
    };
    let threw = null;
    try { w.apply(target, liveBal({ self: { granted: 110, selfCheckedAt: staleFigure } }), { checkin: true }); }
    catch (e) { threw = e; }
    check(!threw, `запись баланса не падает${threw ? ` — ${threw.constructor.name}: ${threw.message}` : ''}`);
    check(target.selfFailureKind === 'relogin_unverified',
        `вердикт смягчён до «не переспрошен» (получили ${target.selfFailureKind})`);
    check(!!target.selfReloginAt, 'дата входа записана в selfReloginAt');
    check(w.logs.some(l => /после чека был вход/.test(l)), 'смягчение видно в логе');
    // 🪤 Лог обязан назвать ПРЕЖНИЙ вердикт. В бою он живёт в записи пула и переживает
    // прогоны, в которых ответ его не принёс, — брать его из `bal` значит печатать «undefined».
    check(w.logs.some(l => /вердикт «login_dead» смягчён/.test(l)),
        'в логе назван прежний вердикт, а не «undefined»');
    check(w.lastLkLabel === 'acct_ar_1', 'отметку ЛК спрашивают по профилю записи, а не по несуществующей переменной');
}

console.log('\n2. без входа после цифры вердикт НЕ смягчается');
{
    const w = makeWorld();
    const freshFigure = new Date().toISOString();
    const target = {
        id: 'ar_2', api_key: 'sk-test-key', profile: 'acct_ar_2',
        selfCheckedAt: freshFigure,
        checkinAt: new Date(Date.now() - 7200_000).toISOString(), checkinFrom: 'auto',
        selfFailureKind: 'login_dead',
        balance: 100, spent: 10, granted: 110, grantedSelf: 110,
    };
    let threw = null;
    try { w.apply(target, liveBal({ self: { granted: 110, selfCheckedAt: freshFigure } }), { checkin: true }); }
    catch (e) { threw = e; }
    check(!threw, 'не падает и здесь');
    check(target.selfFailureKind === 'login_dead',
        `старый вход не смягчает вердикт (получили ${target.selfFailureKind})`);
}

console.log('\n3. таймер подарка не двигается, когда наблюдение опоздало');
{
    const mkTarget = (over = {}) => ({
        id: 'ar_1', api_key: 'sk-test-key', profile: 'acct_ar_1',
        balance: 100, spent: 10, granted: 110, grantedSelf: 100,
        ...over,
    });
    // Ответ чека: выдача выросла на $100 — как будто подарков накопилось на несколько дней.
    const grew = () => liveBal({ self: { granted: 200 } });

    // 3а. Цифру обновляли час назад — рост свежий, таймер обязан сдвинуться.
    {
        const w = makeWorld();
        const t = mkTarget({ selfCheckedAt: new Date(Date.now() - 3600_000).toISOString() });
        w.apply(t, grew(), { checkin: true });
        check(!!t.checkinAt, 'свежее наблюдение: подарок отмечен');
        check(t.checkinFrom === 'self', 'и именно по росту выдачи');
        check(t.grantedSelf === 200, 'база сдвинута на новую выдачу');
        // Налив виден и в журнале сбора на вкладке: владелец 21.09 просил «логи на вкладке,
        // чтобы видно было чё происходит», а деньги - первое, что там нужно видеть.
        check(w.notes.some(n => n.kind === 'grant' && /выдача/.test(n.text)),
            'налив уезжает в журнал вкладки, а не только в общий лог');
    }

    // 3б. 🔴 Цифра стояла 60 часов — рост копил несколько дней, к «сейчас» его не привязать.
    // Штамп тут и был багом: таймер уезжал на сутки вперёд и блокировал НАСТОЯЩИЙ подарок.
    {
        const w = makeWorld();
        const t = mkTarget({ selfCheckedAt: new Date(Date.now() - 60 * 3600_000).toISOString() });
        w.apply(t, grew(), { checkin: true });
        check(!t.checkinAt, '🔴 опоздавшее наблюдение НЕ ставит штамп — таймер не двигается');
        check(t.grantedSelf === 200, 'но база обновлена: следующий рост считается от неё');
        check(w.logs.some(l => /к одному моменту рост не привязать/.test(l)),
            'причина пропуска штампа названа в логе');
    }

    // 3в. Роста нет — штампа нет ни при каком возрасте цифры.
    {
        const w = makeWorld();
        const t = mkTarget({ selfCheckedAt: new Date(Date.now() - 3600_000).toISOString() });
        w.apply(t, liveBal({ self: { granted: 100 } }), { checkin: true });
        check(!t.checkinAt, 'без роста выдачи подарок не отмечается');
    }
}

console.log('\n4. провалившаяся попытка не перетирает вердикт удачной проверки');
{
    // Владелец: «всё равно пишет, что логин не проверен, на аккаунтах, которые уже проверены».
    // Механика: цифру переиспользуют чаще, чем переспрашивают (WAF + пауза по частоте), а
    // вердикт снимался ТОЛЬКО свежим ответом. Замер 16.09: 21 запись из 33 с плашкой и у всех
    // `selfCached` — включая активный аккаунт с $1238, который работал прямо в тот момент.
    const mk = (over = {}) => ({
        id: 'ar_1', api_key: 'sk-test-key', profile: 'acct_ar_1',
        balance: 100, spent: 10, granted: 110, grantedSelf: 100,
        selfFailureKind: 'no_proof',
        ...over,
    });
    const cached = (extra = {}) => liveBal({
        selfCached: true, self: { granted: 100 }, selfFailureKind: 'no_proof',
        selfError: 'WAF просит JS-челлендж', ...extra,
    });

    // 4а. Переиспользованная цифра ЕЩЁ СВЕЖАЯ → проверяли недавно → плашки быть не должно.
    {
        const w = makeWorld();
        const t = mk();
        w.apply(t, cached({ selfStale: false }), { checkin: true });
        check(!t.selfFailureKind,
            `🔴 свежая переиспользованная цифра снимает плашку (осталась: ${t.selfFailureKind || '—'})`);
    }

    // 4б. Цифра старая → сомнение честное, плашка остаётся.
    {
        const w = makeWorld();
        const t = mk();
        w.apply(t, cached({ selfStale: true }), { checkin: true });
        check(t.selfFailureKind === 'no_proof',
            `старая цифра плашку сохраняет (получили ${t.selfFailureKind || '—'})`);
    }

    // 4в. Свежий ответ по-прежнему главнее всего и стирает плашку.
    {
        const w = makeWorld();
        const t = mk();
        w.apply(t, liveBal({ self: { granted: 100 } }), { checkin: true });
        check(!t.selfFailureKind, 'свежий self стирает плашку, как и раньше');
    }
}

console.log('\n5. имена берутся из СВОЕЙ области видимости');
{
    const fn = src.slice(src.indexOf('function newapiApplyBalance('));
    const scope = fn.slice(0, fn.indexOf('\n}\n') + 2);
    // Считаем по ИСПОЛНЯЕМЫМ строкам: комментарий рядом сам объясняет, почему `host` тут нет,
    // и наивный поиск по тексту ловил бы собственное объяснение.
    const code = scope.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    check(!/\bprof\b/.test(code),
        'в newapiApplyBalance нет обращения к `prof` — он живёт внутри newapiBalance');
    check(!/\bhost\b/.test(code),
        'и к `host` тоже: у этой функции нет такого параметра');
}

console.log(fail
    ? `\n❌ ${fail} провалено`
    : '\n✅ Вердикт про вход: смягчается по дате, не роняет запись баланса и не берёт чужие переменные.');
process.exit(fail ? 1 : 0);
