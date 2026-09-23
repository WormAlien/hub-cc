'use strict';
// Тесты витрины Лиги на каноническом счётчике. Страница целиком в браузере не поднимается:
// блок витрины вырезается из `proxy-dashboard.html` и исполняется в узле - тот же приём, что
// в `tools/check-league-chat.js`. Сеть, DOM и живые данные не участвуют.
//
// Запуск: node tools/check-league-cc-ui.js
//
// 🪤 Проверяются НАСТОЯЩИЕ lgTotal/lgAligned/lgShow/lgKeys, а не наличие слов в файле:
// «поле прочерка» и «нет нулей вместо неизвестного» - утверждения о поведении.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const pending = [];
function ok(name, fn) {
    const done = p => { passed++; console.log('  ok   ' + name + (typeof p === 'string' ? ' (' + p + ')' : '')); };
    const bad = e => { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); };
    try {
        const r = fn();
        if (r && typeof r.then === 'function') pending.push(r.then(done, bad));
        else done(r);
    } catch (e) { bad(e); }
}
function finish() {
    Promise.all(pending).then(() => {
        console.log('\ncheck-league-cc-ui: ' + passed + ' ok, ' + failed + ' fail');
        process.exit(failed ? 1 : 0);
    });
}

function locate() {
    for (const c of ['C:/Users/WormAlien/Desktop/Autoreger_Clean/routing', process.env.AUTOREGER_ROUTING]) {
        if (c && fs.existsSync(path.join(c, 'proxy-dashboard.html'))) return path.join(c, 'proxy-dashboard.html');
    }
    throw new Error('не найден routing/proxy-dashboard.html; задай AUTOREGER_ROUTING');
}
const HTML = fs.readFileSync(locate(), 'utf8');

// Блок витрины: от канонического счётчика до сплайна.
const A = HTML.indexOf('// ── Канонический счётчик Claude Code в срезе');
const B = HTML.indexOf('// ── Монотонный кубический сплайн');
if (A < 0 || B <= A) {
    console.log('  FAIL блок витрины не вырезается из страницы');
    console.log('\ncheck-league-cc-ui: 0 ok, 1 fail');
    process.exit(1);
}
const src = HTML.slice(A, B);
const build = new Function('LG', 'LG_M', 'LG_TOT', 'LG_R', 'LG_RW', 'lgTok', 'lgSum', 'lgInt', 'lgCumOn',
    `${src}\nreturn { lgCc, lgCcRun, lgCcTotal, lgStreak, lgTotal, lgAligned, lgKeys, lgShow, lgMetricGap, lgComposition,
             lgDef, lgDefMark, lgDefNote, lgRankable, lgPlace, lgSort, lgLegacyTotal, lgDefNotice, lgRuns,
             lgWindowKeys, lgCcOpen, lgTopCfg, lgTopRows };`);

const LG_M = {
    cc: { lb: 'токены Claude Code', fmt: v => String(v), source: 'cc' },
    tok: { lb: 'токены (журнал)', fmt: v => String(v) },
};
const LG_R = { h24: { lb: 'сутки' }, d7: { lb: 'неделя' }, d30: { lb: 'месяц' }, all: { lb: 'всё время' } };
const LG_TOT = { tok: { h24: 'tokD', d7: 'tokW', d30: 'tokM', all: 'tokA' } };
const LG_RW = { h24: 'за сутки', d7: 'за неделю', d30: 'за месяц', all: 'всего' };
const lgTok = v => String(v);
const lgSum = a => a.reduce((x, y) => x + (Number(y) || 0), 0);
const lgInt = v => String(Math.round(v));

function envelope(over) {
    return Object.assign({
        v: 1, available: true, lifetime: 59_000_000_000,
        totals: { h24: 3_600_000_000, d7: 17_000_000_000, d30: 48_000_000_000 },
        days: { keys: ['2026-09-14', '2026-09-15', '2026-09-16'], values: [1_000_000, 2_000_000, 3_000_000] },
        hours: { keys: ['2026-09-16T10', '2026-09-16T11'], values: [1_000_000, 2_600_000] },
        activity: { streakCurrent: 50 },
    }, over || {});
}
function api(metric, range, data) {
    const LG = { metric, range, data: data || null, cum: false };
    return build(LG, LG_M, LG_TOT, LG_R, LG_RW, lgTok, lgSum, lgInt, () => false);
}
const me = p => Object.assign({ nick: 'я', tot: { tokA: 46_000_000_000, streak: 63 } }, p || {});
const stranger = p => Object.assign({ nick: 'сосед', tot: { tokA: 1_000_000, streak: 7 } }, p || {});

ok('«всё время» берётся из общего счётчика, а не из суммы дней', () => {
    const a = api('cc', 'all', { me: me({ ccStats: envelope() }) });
    assert.strictEqual(a.lgTotal(me({ ccStats: envelope() }), 'all'), 59_000_000_000);
    const sum = 1_000_000 + 2_000_000 + 3_000_000;
    assert.notStrictEqual(59_000_000_000, sum, 'сумма дней здесь заведомо меньше - на этом и расходились');
});

ok('окна считаются из счётчика, а не из legacy-полей', () => {
    const row = me({ ccStats: envelope() });
    const a = api('cc', 'd7', { me: row });
    assert.strictEqual(a.lgTotal(row, 'd7'), 17_000_000_000, 'неделя из totals.d7');
    assert.strictEqual(a.lgTotal(row, 'h24'), 3_600_000_000, 'сутки из totals.h24');
    assert.strictEqual(a.lgTotal(row, 'all'), 59_000_000_000);
    const t = api('tok', 'all', { me: row });
    assert.strictEqual(t.lgTotal(row, 'all'), 46_000_000_000, 'прежняя метрика осталась прежней');
});

ok('отсутствующий день остаётся дырой, а не нулём', () => {
    const row = me({ ccStats: envelope() });
    const a = api('cc', 'all', { me: row });
    const keys = a.lgKeys(row, 'all');
    assert.deepStrictEqual(keys, ['2026-09-14', '2026-09-15', '2026-09-16'], 'сетка из счётчика');
    const aligned = a.lgAligned(row, ['2026-09-13', '2026-09-14', '2026-09-16']);
    assert.deepStrictEqual(aligned, [null, 1_000_000, 3_000_000], 'дня нет - и это null, а не 0');
});

// Прежний участник показан своими числами и помечен; прочерк остаётся только там, где
// показывать нечего вовсе. Прежняя версия этого теста требовала прочерка у любого без
// нового счётчика - это и была та поломка, из-за которой статистика старых версий не
// отрисовывалась (владелец 18.09).
// Место при этом даётся и прежнему (владелец 22.09: «номера нужны даже если версии не
// соответствуют») - раньше на его месте стояла метка «~».
ok('участник без нового счётчика не прячется за прочерком', () => {
    const row = stranger({ tot: { tokW: 5_000_000, tokA: 1_000_000, streak: 7 } });
    const a = api('cc', 'd7', { me: me({ ccStats: envelope() }), peers: [row] });
    assert.strictEqual(a.lgTotal(row, 'd7'), 5_000_000, 'показываем его собственную неделю');
    assert.strictEqual(a.lgShow(row, 'd7'), '5000000', 'и это цифра, а не прочерк');
    assert.strictEqual(a.lgDef(row), 'legacy');
    assert.strictEqual(a.lgRankable(row), false, 'сравнимым с каноническим он от этого не стал');
    assert.strictEqual(a.lgPlace(row, 1), '2', 'но номер в списке получает: владелец 22.09');
    assert.strictEqual(a.lgMetricGap(row), null, 'причина «нет данных» тут не называется: данные есть');
});

ok('окно без данных у прежнего участника даёт прочерк, а не ноль', () => {
    const row = stranger({ tot: { tokA: 1_000_000, streak: 7 } });   // есть только «всё время»
    const a = api('cc', 'd7', { me: me({ ccStats: envelope() }), peers: [row] });
    assert.strictEqual(a.lgTotal(row, 'd7'), null, 'за неделю числа нет');
    assert.strictEqual(a.lgShow(row, 'd7'), '—', 'и прочерк честнее нуля');
    assert.strictEqual(a.lgTotal(row, 'all'), 1_000_000, 'а «всё время» у него есть');
});

ok('свой срез без счётчика показывает прежние числа и объясняет это', () => {
    const row = me({ isMe: 1, tot: { tokW: 4_000_000, tokA: 46_000_000_000, streak: 63 } });
    const a = api('cc', 'd7', { me: row, peers: [stranger({ tot: { tokW: 5_000_000, tokA: 5_000_000 } })] });
    // Раньше здесь был прочерк с подписью «ещё не посчитан»: вкладка выглядела пустой у
    // того, кто просто не перезапустил хаб. Теперь цифры видны, а причина - в шапке.
    assert.strictEqual(a.lgTotal(row, 'd7'), 4_000_000, 'свои прежние числа показаны');
    assert.strictEqual(a.lgDef(row), 'legacy');
    const notice = a.lgDefNotice();
    assert.ok(/свой канонический счётчик/.test(notice), 'шапка называет причину: ' + notice);
    assert.ok(/прежние числа/.test(notice), 'и говорит, что показано вместо него: ' + notice);
    assert.ok(/1 участник на старой версии/.test(notice), 'про соседа на старой версии тоже сказано: ' + notice);
});

ok('стрик берётся из активности Claude Code, а не из промптов', () => {
    const a = api('cc', 'd7', {});
    assert.strictEqual(a.lgStreak(me({ ccStats: envelope() })), 50, 'стрик счётчика');
    assert.strictEqual(a.lgStreak(me({ ccStats: envelope({ activity: null }) })), 63,
        'без активности падаем на прежний стрик, а не на ноль');
    assert.strictEqual(a.lgStreak(stranger()), 7);
});

ok('часовое окно отдаёт часы, дневные - дни', () => {
    const row = me({ ccStats: envelope() });
    const a = api('cc', 'h24', { me: row });
    assert.deepStrictEqual(a.lgKeys(row, 'h24'), ['2026-09-16T10', '2026-09-16T11']);
    const d = api('cc', 'd30', { me: row });
    assert.deepStrictEqual(d.lgKeys(row, 'd30'), ['2026-09-14', '2026-09-15', '2026-09-16'],
        'месяц короче истории - берём что есть');
    const w = api('cc', 'd7', { me: row });
    assert.deepStrictEqual(w.lgKeys(row, 'd7'), ['2026-09-14', '2026-09-15', '2026-09-16'], 'хвост недели');
});

ok('пустой счётчик даёт прочерки, а не падение', () => {
    // 🪤 Участник без ЛЮБЫХ чисел: ни нового счётчика, ни прежних полей. С прежними полями
    // прочерк был бы уже неправдой - его цифры видны, см. тест про совместимость версий.
    const bare = { nick: 'пусто', tot: {}, ccStats: envelope({ days: null, hours: null, totals: {}, lifetime: null }) };
    const a = api('cc', 'all', { me: bare });
    assert.strictEqual(a.lgTotal(bare, 'all'), null);
    assert.strictEqual(a.lgShow(bare, 'all'), '—');
    assert.deepStrictEqual(a.lgKeys(bare, 'all'), []);
});

ok('состав итога называется словами: кто его набрал', () => {
    const a = api('cc', 'd7', {});
    const both = me({ ccStats: envelope({
        sources: [
            { h: 'claude-code', tokens: 59_000_000_000, coverage: 'full' },
            { h: 'opencode', tokens: 402_000, coverage: 'journal' },
        ],
    }) });
    const line = a.lgComposition(both);
    assert.ok(line.includes('Claude Code'), 'Claude Code назван: ' + line);
    assert.ok(line.includes('opencode'), 'и второй харнесс тоже: ' + line);
    assert.strictEqual(a.lgComposition(me({ ccStats: envelope({ sources: [{ h: 'claude-code', tokens: 1, coverage: 'full' }] }) })), '',
        'один источник объяснять нечем - строки нет');
    assert.strictEqual(a.lgComposition(stranger()), '', 'без счётчика и строки нет');
});

ok('обрезанный журнал помечается в составе, а не молчит', () => {
    const a = api('cc', 'd7', {});
    const row = me({ ccStats: envelope({
        sources: [
            { h: 'claude-code', tokens: 59_000_000_000, coverage: 'full' },
            { h: 'opencode', tokens: 402_000, coverage: 'journal' },
        ],
        journal: { truncated: true, lines: 100, first: '2026-09-01', last: '2026-09-16' },
    }) });
    assert.ok(/обрезан/.test(a.lgComposition(row)), 'усечение журнала названо: ' + a.lgComposition(row));
});

// Список метрик витрины: метрика токенов должна быть ОДНА. Прежняя (журнал front-door с
// другим определением) не показывается отдельной кнопкой - числа об одном и том же не
// должны стоять рядом и спорить друг с другом.
const M_A = HTML.indexOf('const LG_M = {');
const M_B = HTML.indexOf('const LG_SER = [');
const LG_META = (() => {
    if (M_A < 0 || M_B <= M_A) return null;
    try {
        return new Function('lgTok', 'lgInt', 'lgSum',
            `${HTML.slice(M_A, M_B)}\nreturn { LG_M, LG_TOT };`)(v => String(v), v => String(Math.round(v)), a => a.length);
    } catch (e) { return { err: e.message }; }
})();

ok('метрика токенов в интерфейсе одна, прежней кнопки нет', () => {
    assert.ok(LG_META && LG_META.LG_M, 'список метрик не вырезался: ' + (LG_META && LG_META.err));
    const tokenMetrics = Object.entries(LG_META.LG_M).filter(([, m]) => m.unit === null && m.source === 'cc');
    assert.deepStrictEqual(tokenMetrics.map(([k]) => k), ['cc'], 'каноническая метрика токенов одна');
    assert.strictEqual(LG_META.LG_M.tok, undefined, 'прежней кнопки токенов в списке быть не должно');
    assert.strictEqual((LG_META.LG_TOT || {}).tok, undefined, 'и её итогов в таблице тоже');
    assert.ok(Object.keys(LG_META.LG_M).includes('acc'), 'остальные оси не тронуты');
    assert.ok(LG_META.LG_M.cc.hint.includes('front-door'), 'подсказка называет второй источник: ' + LG_META.LG_M.cc.hint);
});

// ── Совместимость версий: у соседа на старом клиенте есть свои числа ──────────
// Владелец 18.09: «статистика прошлых версий просто не отрисовывается». Участник, который
// ещё не обновился, присылает прежние поля (`tok`, `tot.tok*`) - их и надо показать,
// помечая другим счётчиком. С 22.09 такие участники ещё и получают место в списке
// (владелец: «номера нужны даже если версии не соответствуют»), но остаются в хвосте
// доски: сравнимое впереди, прежние между собой.

ok('участник без нового счётчика показывает свою прежнюю цифру', () => {
    const a = api('cc', 'd7', {});
    const old = stranger({ tot: { tokW: 5_000_000, tokA: 1_000_000, streak: 7 } });
    assert.strictEqual(a.lgDef(old), 'legacy', 'прежние числа распознаны как прежний счётчик');
    assert.strictEqual(a.lgTotal(old, 'd7'), old.tot.tokW, 'неделя берётся из его же поля');
    assert.notStrictEqual(a.lgShow(old, 'd7'), '—', 'прочерка быть не должно: цифра есть');
});

ok('прежняя цифра помечена и объяснена словами', () => {
    const a = api('cc', 'd7', {});
    const old = stranger();
    assert.strictEqual(a.lgDefMark(old), '~', 'метка другого счётчика');
    assert.ok(/прежн/i.test(a.lgDefNote(old)), 'в подсказке сказано, что счётчик прежний: ' + a.lgDefNote(old));
    assert.ok(/не срaвн/i.test(a.lgDefNote(old)) || /не сравн/i.test(a.lgDefNote(old)),
        'и что с новым он не сравнивается: ' + a.lgDefNote(old));
    assert.strictEqual(a.lgDefMark(me({ ccStats: envelope() })), '', 'у нового счётчика метки нет');
});

ok('место даётся всем, у кого есть цифры, а сравнимое идёт первым', () => {
    const a = api('cc', 'd7', {});
    const fresh = me({ ccStats: envelope({ totals: { d7: 1_000 } }) });
    const old = stranger();
    const empty = { nick: 'пусто', tot: {} };
    assert.strictEqual(a.lgRankable(fresh), true);
    assert.strictEqual(a.lgRankable(old), false, 'прежний с каноническим счётчиком несравним');
    assert.strictEqual(a.lgPlace(fresh, 0), '1', 'первое место у нового счётчика');
    assert.strictEqual(a.lgPlace(old, 1), '2', 'прежний получает номер, а не метку: владелец 22.09');
    assert.strictEqual(a.lgPlace(empty, 2), '—', 'а пустому номер не выдумывается');
    assert.ok(a.lgSort([old, fresh])[0] === fresh,
        'первым всё равно идёт сравнимый, даже когда его цифра меньше');
    const notice = api('cc', 'd7', { me: me({ ccStats: envelope() }), peers: [old] }).lgDefNotice();
    assert.ok(!/в местах не участвуют/i.test(notice),
        'шапка больше не выключает прежних из мест: ' + notice);
    assert.ok(!/в местах не участвует/i.test(a.lgDefNote(old)),
        'и подсказка тоже: ' + a.lgDefNote(old));
});

ok('два прежних участника сортируются между собой по своей цифре', () => {
    const a = api('cc', 'd7', {});
    const small = Object.assign(stranger(), { nick: 'малый', tot: { tokW: 100, tokA: 100 } });
    const big = Object.assign(stranger(), { nick: 'большой', tot: { tokW: 900, tokA: 900 } });
    const sorted = a.lgSort([small, big]);
    assert.strictEqual(sorted[0].nick, 'большой', 'внутри одного определения порядок честный');
});

ok('совсем пустой участник по-прежнему прочерк, а не ноль', () => {
    const a = api('cc', 'd7', {});
    const empty = { nick: 'пусто', tot: {} };
    assert.strictEqual(a.lgDef(empty), 'none');
    assert.strictEqual(a.lgTotal(empty, 'd7'), null);
    assert.strictEqual(a.lgShow(empty, 'd7'), '—');
    assert.strictEqual(a.lgDefMark(empty), '', 'метки счётчика у пустого нет');
});

ok('ряд прежнего участника для графика берётся из его полей', () => {
    const a = api('cc', 'all', {});
    const old = stranger({ keys: { all: ['2026-09-15', '2026-09-16'] }, tok: { all: [10, 20] } });
    assert.deepStrictEqual(a.lgKeys(old, 'all'), ['2026-09-15', '2026-09-16'],
        'сетка берётся из его же ключей');
    assert.deepStrictEqual(a.lgAligned(old, ['2026-09-14', '2026-09-15', '2026-09-16']), [null, 10, 20],
        'дни совмещаются по ключам, отсутствующий - дыра, а не ноль');
});

ok('определения не складываются и не подменяют друг друга', () => {
    const a = api('cc', 'd7', {});
    const fresh = me({ ccStats: envelope({ totals: { d7: 1_000 } }) });
    const old = stranger({ tot: { tokW: 9_999_999, tokA: 9_999_999 } });
    assert.strictEqual(a.lgTotal(fresh, 'd7'), 1_000, 'у нового счётчика своё число');
    assert.strictEqual(a.lgTotal(old, 'd7'), 9_999_999, 'у прежнего своё');
    assert.notStrictEqual(a.lgTotal(fresh, 'd7') + a.lgTotal(old, 'd7'), a.lgTotal(fresh, 'd7'),
        'суммы из двух определений не собираются');
    assert.ok(/прежний/i.test(a.lgDefNote(fresh)) === false, 'у нового участника пояснения про прежний счётчик нет');
});

// 🔴 Свежая установка 23.09.2026: график «всё время» у друга был пустым, а «за месяц» рисовался.
// Причина в разбиении ряда на куски: кусок из ОДНОЙ точки отбрасывался (`filter(s => s.length > 1)`),
// и вся серия не рисовалась вовсе - ни линии, ни точки, ни подписи. У «всё время» на свежей
// машине день ровно один, у месяца ключей 30 - отсюда разница в поведении.
ok('одиночная точка - это данные, а не пустой кусок', () => {
    const a = api('cc', 'd7', {});
    assert.deepStrictEqual(a.lgRuns([5]), [[0]], 'кусок из одной точки остаётся');
    assert.deepStrictEqual(a.lgRuns([1, null, 2, 3]), [[0], [2, 3]],
        'null рвёт ряд, но одиночный кусок перед разрывом не пропадает');
    assert.deepStrictEqual(a.lgRuns([1, 2, 3]), [[0, 1, 2]], 'обычный ряд - один кусок');
    assert.deepStrictEqual(a.lgRuns([]), [], 'пустой ряд - ни одного куска');
    assert.deepStrictEqual(a.lgRuns([1, 2], 2), [[0, 1]], 'minLen=2 одиночку отсекает (пунктир налива)');
    assert.deepStrictEqual(a.lgRuns([1, 2, null, 3], 2), [[0, 1]], 'и не склеивает куски через разрыв');
});

// 🔴 Свежая установка 23.09.2026, второй заход: график «всё время» у друга рисовался, но ось
// была из ОДНОГО дня - его собственной истории. Соседи сжимались в один столбец (подписи
// налезали, у соседа «за сутки» 1 М против 47 млрд за всё время), и доска отдавала первое
// место свежей машине. Окно «всё время» обязано собираться из всех, кого рисуем.
ok('ось «всё время» собирается из всех участников, а не из своей истории', () => {
    const a = api('cc', 'all', {});
    const mine = me({ ccStats: envelope() });                                    // дни 09-14…09-16
    const peer = stranger({ ccStats: envelope({
        days: { keys: ['2026-08-01', '2026-09-16'], values: [5, 6] } }) });
    assert.deepStrictEqual(a.lgWindowKeys(mine, [mine, peer], 'all'),
        ['2026-08-01', '2026-09-14', '2026-09-15', '2026-09-16'],
        'объединение ключей всех участников, по возрастанию и без дублей');
    assert.deepStrictEqual(a.lgWindowKeys(mine, [], 'all'), a.lgKeys(mine, 'all'),
        'без соседей ось «всё время» - свои ключи');

    // 🔴 Второй заход: неделя и месяц рисовались ОДНИМ столбцом, потому что ось бралась из
    // своего ряда, а у канонического счётчика он у молодой машины короче окна («работают
    // только сутки», друг 23.09.2026). У фиксированных окон ось общая и лежит в `me.keys`.
    const weekKeys = ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'];
    const young = me({ keys: { d7: weekKeys, d30: weekKeys, h24: ['2026-09-23T20'] },
        ccStats: envelope({ days: { keys: ['2026-09-23'], values: [5] } }) });
    assert.deepStrictEqual(a.lgWindowKeys(young, [peer], 'd7'), weekKeys,
        'неделя берёт ось окна, а не свой один день');
    assert.strictEqual(a.lgWindowKeys(young, [peer], 'd7').length, 7, 'и в оси все семь суток');
    assert.deepStrictEqual(a.lgWindowKeys(mine, [peer], 'd30'), a.lgKeys(mine, 'd30'),
        'без `keys` в строке - прежнее поведение (ряд участника)');
});

// 🔴 Свежая установка 23.09.2026, третье: у друга нет кэша Claude Code, поэтому общий итог
// приходит пустым, а нижняя граница (`lifetimeLower`) есть. UI брал в этом случае цифру
// ПРЕЖНЕГО счётчика - участник «на новом счётчике» показывал чужое определение (1 М против
// 47 млрд) и при этом шёл первым, потому что считался сравнимым. Оба конца одной ошибки.
ok('неполный итог нового счётчика: своя цифра, метка «≥» и вне сравнения', () => {
    const a = api('cc', 'all', {});
    const fresh = me({ nick: 'новичок', ccStats: envelope({ lifetime: null, lifetimeLower: 7_000_000, complete: false }) });
    const full = me({ nick: 'старый', ccStats: envelope() });
    const old = stranger({ nick: 'прежний' });

    assert.strictEqual(a.lgCcOpen(fresh), true, 'итог неполный - это видно');
    assert.strictEqual(a.lgTotal(fresh, 'all'), 7_000_000, 'цифра берётся из своего же счётчика, а не из прежнего');
    assert.notStrictEqual(a.lgTotal(fresh, 'all'), a.lgLegacyTotal(fresh, 'all'), 'прежнее определение не подставлено');
    assert.strictEqual(a.lgShow(fresh, 'all'), '≥ 7000000', 'и помечена как нижняя граница');
    assert.strictEqual(a.lgRankable(fresh), false, 'в общий рейтинг не идёт: сравнивать нечего');
    assert.strictEqual(a.lgTotal(fresh, 'd30'), 48_000_000_000, 'окна при этом считаются как обычно');

    assert.strictEqual(a.lgCcOpen(full), false, 'у полного итога метки нет');
    assert.strictEqual(a.lgShow(full, 'all'), '59000000000', 'и цифра без «≥»');
    assert.strictEqual(a.lgRankable(full), true, 'полный итог - идёт в сравнение');
    assert.strictEqual(a.lgRankable(old), false, 'прежний счётчик - в свою группу, как и раньше');

    const rows = a.lgSort([fresh, full, old]);
    assert.strictEqual(rows[0].nick, 'старый', 'сравниваемый впереди: у него итог полный');
    assert.notStrictEqual(rows[0].nick, 'новичок', 'свежая машина больше не первая на доске');
});

// 🔴 Владелец 23.09.2026: «надо, чтобы настройки графика жили на ноде, чтобы у людей
// независимо от последних обновлений график менялся». Значит значения приходят с сервера,
// а клиент только исполняет - и обязан пережить и мусор в них, и свои границы.
ok('линиями - лидеры (сколько скажет нода) и всегда смотрящий', () => {
    const a = api('cc', 'd7', {});
    const rows = [1, 2, 3, 4, 5, 6, 7].map(i => ({ nick: 'u' + i, isMe: i === 6 }));

    assert.strictEqual(a.lgTopCfg({}).n, 5, 'по умолчанию пятёрка');
    assert.strictEqual(a.lgTopCfg({}).self, true, 'и смотрящий включён');
    assert.strictEqual(a.lgTopCfg({ top: 99 }).n, 12, 'потолок 12 - выше молча не пускаем');
    assert.strictEqual(a.lgTopCfg({ top: 0 }).n, 1, 'снизу тоже граница');
    assert.strictEqual(a.lgTopCfg({ top: 'мусор' }).n, 5, 'мусор - значения по умолчанию');
    assert.strictEqual(a.lgTopCfg({ self: 'нет' }).self, true, 'строка вместо булева не выключает');

    assert.deepStrictEqual(a.lgTopRows(rows, a.lgTopCfg({})).map(r => r.nick),
        ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'], 'пятёрка лидеров плюс смотрящий шестым');
    assert.deepStrictEqual(a.lgTopRows(rows, a.lgTopCfg({ top: 3 })).map(r => r.nick),
        ['u1', 'u2', 'u3', 'u6'], 'нода сказала три - рисуем три и себя');
    assert.deepStrictEqual(a.lgTopRows(rows, a.lgTopCfg({ top: 3, self: false })).map(r => r.nick),
        ['u1', 'u2', 'u3'], 'смотрящего можно выключить с ноды');
    assert.deepStrictEqual(a.lgTopRows(rows, a.lgTopCfg({ top: 9 })).map(r => r.nick),
        rows.map(r => r.nick), 'себя в лидерах дважды не рисуем');
});


// 🔴 Владелец 23.09.2026: «третье место, токены 0 - почему он тогда на третьем месте?»
// Ярусы («сравнимые впереди, прежние следом») давали ровно это: ноль наверху, 2,06 млрд ниже.
// Решение владельца: порядок ПО ЧИСЛУ во всей доске, метки счётчика остаются, кто без числа -
// в конец. Тест держит именно это, а не механику ярусов.
ok('порядок доски - по числу, а не по определению счётчика', () => {
    const a = api('cc', 'd7', {});
    const canon0 = me({ nick: 'канон-ноль', ccStats: envelope({ totals: { h24: 1, d7: 0, d30: 0 }, lifetime: 1 }) });
    const legacyBig = stranger({ nick: 'прежний-миллиард', tot: { tokW: 2_060_000_000, tokA: 50_000_000 } });
    const bare = { nick: 'без-числа', tot: {} };
    assert.strictEqual(a.lgTotal(canon0, 'd7'), 0, 'у канонического честный ноль');
    assert.strictEqual(a.lgTotal(legacyBig, 'd7'), 2_060_000_000, 'у прежнего - его число');
    const rows = a.lgSort([canon0, legacyBig, bare]);
    assert.deepStrictEqual(rows.map(r => r.nick), ['прежний-миллиард', 'канон-ноль', 'без-числа'],
        'большее число выше, ноль ниже него, кто без числа - в конец');
});

finish();
