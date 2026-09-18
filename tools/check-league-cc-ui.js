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
             lgDef, lgDefMark, lgDefNote, lgRankable, lgPlace, lgSort, lgLegacyTotal, lgDefNotice };`);

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
ok('участник без нового счётчика не прячется за прочерком', () => {
    const row = stranger({ tot: { tokW: 5_000_000, tokA: 1_000_000, streak: 7 } });
    const a = api('cc', 'd7', { me: me({ ccStats: envelope() }), peers: [row] });
    assert.strictEqual(a.lgTotal(row, 'd7'), 5_000_000, 'показываем его собственную неделю');
    assert.strictEqual(a.lgShow(row, 'd7'), '5000000', 'и это цифра, а не прочерк');
    assert.strictEqual(a.lgDef(row), 'legacy');
    assert.strictEqual(a.lgRankable(row), false, 'но в места он не идёт');
    assert.strictEqual(a.lgPlace(row, 1), '~', 'вместо места - метка счётчика');
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
// помечая другим счётчиком и не пуская в места: определения разные.

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

ok('в местах участвует только новый счётчик', () => {
    const a = api('cc', 'd7', {});
    const fresh = me({ ccStats: envelope({ totals: { d7: 1_000 } }) });
    const old = stranger();
    assert.strictEqual(a.lgRankable(fresh), true);
    assert.strictEqual(a.lgRankable(old), false, 'прежний в места не идёт');
    assert.strictEqual(a.lgPlace(fresh, 0), '1', 'первое место у нового счётчика');
    assert.strictEqual(a.lgPlace(old, 1), '~', 'у прежнего вместо места метка счётчика');
    assert.ok(a.lgSort([old, fresh])[0] === fresh,
        'первым идёт новый счётчик даже когда его цифра меньше');
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

finish();
