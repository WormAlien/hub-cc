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
    `${src}\nreturn { lgCc, lgCcRun, lgCcTotal, lgStreak, lgTotal, lgAligned, lgKeys, lgShow, lgMetricGap, lgComposition };`);

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

ok('у соседа без счётчика прочерк и последнее место, а не ноль', () => {
    const row = stranger();
    const a = api('cc', 'd7', { me: me({ ccStats: envelope() }), peers: [row] });
    assert.strictEqual(a.lgTotal(row, 'd7'), null, 'у старого клиента числа нет');
    assert.strictEqual(a.lgShow(row, 'd7'), '—', 'прочерк, а не «0»');
    assert.ok(a.lgMetricGap(row), 'причина названа');
    assert.ok(a.lgMetricGap(row).includes('старой версии'), 'и она про версию: ' + a.lgMetricGap(row));
    assert.strictEqual(a.lgAligned(row, ['2026-09-16'])[0], null);
});

ok('свой срез без счётчика объясняется как «ещё не посчитан»', () => {
    const row = me({ isMe: 1 });
    const a = api('cc', 'd7', { me: row });
    assert.ok(a.lgTotal(row, 'd7') === null);
    assert.ok(/не посчитан/.test(a.lgMetricGap(row)), 'своя причина отличается от чужой: ' + a.lgMetricGap(row));
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
    const row = me({ ccStats: envelope({ days: null, hours: null, totals: {}, lifetime: null }) });
    const a = api('cc', 'all', { me: row });
    assert.strictEqual(a.lgTotal(row, 'all'), null);
    assert.strictEqual(a.lgShow(row, 'all'), '—');
    assert.deepStrictEqual(a.lgKeys(row, 'all'), []);
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

finish();
