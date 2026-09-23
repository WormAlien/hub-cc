'use strict';
// Тесты адаптера статистики Claude Code. Полностью синтетические: файлы живут в памяти
// (tools/lib/fake-fs.js), время передаётся аргументом, живые данные и сеть не читаются.
//
// Запуск: node tools/check-league-cc-stats.js
//
// 🪤 Тест обязан падать до появления адаптера и падать на неверной семантике. Совпадение
// с ожиданием здесь - единственное доказательство, что счёт повторяет /stats, а не «похож».
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeFs } = require('./lib/fake-fs.js');

let passed = 0, failed = 0;
const pending = [];
// 🪤 Обвязка обязана дожидаться асинхронных проверок: обещание, которое никто не ждёт,
// «проходит» всегда, и это ложнозелёный тест.
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
        console.log('\ncheck-league-cc-stats: ' + passed + ' ok, ' + failed + ' fail');
        process.exit(failed ? 1 : 0);
    });
}

function locate() {
    for (const c of ['C:/Users/WormAlien/Desktop/Autoreger_Clean/routing', process.env.AUTOREGER_ROUTING]) {
        if (c && fs.existsSync(path.join(c, 'transparent-proxy.js'))) return c;
    }
    throw new Error('не найден routing/ с кодом хаба; задай AUTOREGER_ROUTING');
}
const ROUTING = locate();
const MOD = path.join(ROUTING, 'league-cc-stats.js');
const ROOT = '/home/u/.claude';
const NOON = Date.parse('2026-09-16T12:00:00Z');
const noonOn = iso => Date.parse(iso);

// Кеш: `modelUsage` = 300 вход + 50 выход + 600 чтение кеша + 50 запись = 1000 с кешем
// против 350 без него. Разница и есть предмет проверки «total с кешем».
function cacheDoc(o) {
    o = o || {};
    return JSON.stringify({
        version: o.version === undefined ? 5 : o.version,
        lastComputedDate: o.lastComputedDate === undefined ? '2026-09-15' : o.lastComputedDate,
        dailyActivity: o.dailyActivity || [{ date: '2026-09-14', messageCount: 10, sessionCount: 2, toolCallCount: 3 }],
        dailyModelTokens: o.dailyModelTokens || [{ date: '2026-09-14', tokensByModel: { 'claude-opus-5': 1000 } }],
        dailyModelTokensVersion: o.dailyVersion === undefined ? 5 : o.dailyVersion,
        modelUsage: o.modelUsage || {
            'claude-opus-5': {
                inputTokens: 300, outputTokens: 50,
                cacheReadInputTokens: 600, cacheCreationInputTokens: 50,
                webSearchRequests: 0, costUSD: 0, contextWindow: 0, maxOutputTokens: 0,
            },
        },
        totalSessions: o.totalSessions === undefined ? 7 : o.totalSessions,
        totalMessages: o.totalMessages === undefined ? 70 : o.totalMessages,
        longestSession: null,
        firstSessionDate: o.firstSessionDate === undefined ? '2026-09-01T00:00:00.000Z' : o.firstSessionDate,
        hourCounts: o.hourCounts || { 12: 4 },
    });
}
const line = o => JSON.stringify(o);
function assistant(ts, usage, o) {
    o = o || {};
    return line({
        type: 'assistant', uuid: o.uuid || ('u' + Math.random().toString(36).slice(2)),
        timestamp: ts, isSidechain: !!o.sidechain, sessionId: o.sessionId || 's1',
        message: { id: o.id || ('m' + Math.random().toString(36).slice(2)), model: o.model || 'claude-opus-5', usage },
    });
}
const usage = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
const build = (files, cacheOpts) => makeFs(Object.assign({ [ROOT + '/stats-cache.json']: cacheDoc(cacheOpts) }, files));
const main = (o) => assistant(o.ts, o.u, { id: o.id, sidechain: o.sidechain, sessionId: o.sessionId });

ok('адаптер существует отдельным модулем', () => {
    assert.ok(fs.existsSync(MOD), 'нет ' + MOD);
});

if (fs.existsSync(MOD)) {
    const A = require(MOD);

    ok('пустая установка: явное «нет источников», а не нули', () => {
        const s = A.computeCcStats({ fs: makeFs({}), root: ROOT, now: NOON });
        assert.strictEqual(s.available, false);
        assert.strictEqual(s.reason, 'no-sources');
        assert.strictEqual(s.lifetimeCC, null, 'неизвестное не должно быть нулём');
        assert.strictEqual(s.lifetimeLowerBound, null);
        assert.strictEqual(s.totals.d7, null);
    });

    ok('total складывает четыре категории, а не вход с выходом', () => {
        const s = A.computeCcStats({ fs: build({}), root: ROOT, now: NOON });
        assert.strictEqual(s.available, true);
        assert.strictEqual(s.lifetimeCC, 1000, 'ожидался total с кешем, получено ' + s.lifetimeCC);
        assert.strictEqual(s.lifetimeBreakdown.input, 300);
        assert.strictEqual(s.lifetimeBreakdown.cacheRead, 600);
        assert.strictEqual(s.lifetimeBreakdown.cacheWrite, 50);
    });

    ok('неизвестная версия кеша: отказ, а не догадка по отношению сумм', () => {
        const s = A.computeCcStats({ fs: build({}, { version: 99 }), root: ROOT, now: NOON });
        assert.strictEqual(s.available, false);
        assert.strictEqual(s.reason, 'unsupported-cache-version');
        assert.strictEqual(s.lifetimeCC, null);
    });

    ok('битый кеш: ошибка, а не пустой результат', () => {
        const s = A.computeCcStats({
            fs: makeFs({ [ROOT + '/stats-cache.json']: '{ это не json' }), root: ROOT, now: NOON,
        });
        assert.strictEqual(s.available, false);
        assert.strictEqual(s.reason, 'bad-cache');
    });

    ok('дни транскриптов режутся по UTC, а не по местному времени', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']:
                main({ ts: '2026-09-15T23:30:00.000Z', u: usage(1, 0, 0, 0) }) + '\n' +
                main({ ts: '2026-09-16T00:30:00.000Z', u: usage(2, 0, 0, 0) }) + '\n',
        };
        const s = A.computeCcStats({ fs: build(files, { lastComputedDate: '2026-09-10' }), root: ROOT, now: NOON });
        assert.strictEqual(s.daily.known['2026-09-15'], 1, 'вечер UTC остаётся на своей дате');
        assert.strictEqual(s.daily.known['2026-09-16'], 2, 'ночь UTC уходит в следующие сутки');
        assert.strictEqual(s.daily.basis['2026-09-16'], 'transcript');
        assert.strictEqual(s.daily.known['2026-09-10'], undefined, 'строки кеша за 10.09 нет - это пропуск');
    });

    ok('вложенные агенты дают токены, но не сессии и не активность', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']:
                line({ type: 'user', uuid: 'uu1', timestamp: '2026-09-16T08:00:00.000Z', sessionId: 's1' }) + '\n' +
                main({ ts: '2026-09-16T08:01:00.000Z', u: usage(10, 5, 0, 0) }),
            [ROOT + '/projects/p1/s1/subagents/agent-a1.jsonl']:
                // 15.09 существует ТОЛЬКО у агента - в активные дни он попасть не должен.
                main({ ts: '2026-09-15T08:05:00.000Z', u: usage(70, 0, 0, 0) }) + '\n' +
                main({ ts: '2026-09-16T08:05:00.000Z', u: usage(100, 0, 0, 0) }),
        };
        const s = A.computeCcStats({ fs: build(files), root: ROOT, now: NOON });
        assert.strictEqual(s.daily.known['2026-09-16'], 115, 'сессия 15 плюс агент 100');
        assert.strictEqual(s.daily.known['2026-09-15'], undefined, 'внутри окна кеша без строки - пропуск');
        assert.strictEqual(s.activity.activeDays, 2, 'день кеша 14.09 и день сессии 16.09, но не день агента');
        assert.strictEqual(s.activity.sessions, 7, 'сессии берутся из кеша, а не из файлов');
    });

    ok('дубли message.id считаются как в Claude Code: не дедуплицируются', () => {
        const same = main({ id: 'msg_same', ts: '2026-09-16T09:00:00.000Z', u: usage(7, 3, 0, 0) });
        const s = A.computeCcStats({
            fs: build({ [ROOT + '/projects/p1/s1.jsonl']: same + '\n' + same + '\n' }), root: ROOT, now: NOON,
        });
        assert.strictEqual(s.daily.known['2026-09-16'], 20, 'двадцать, а не десять');
    });

    ok('sidechain не считается, служебные типы записей игнорируются', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']:
                main({ ts: '2026-09-16T09:00:00.000Z', u: usage(4, 1, 0, 0), sidechain: true }) + '\n' +
                main({ ts: '2026-09-16T09:01:00.000Z', u: usage(6, 1, 0, 0) }) + '\n' +
                line({ type: 'summary', uuid: 'x', timestamp: '2026-09-16T09:02:00.000Z' }) + '\n' +
                line({ type: 'api_system', uuid: 'y', timestamp: '2026-09-16T09:03:00.000Z' }),
        };
        const s = A.computeCcStats({ fs: build(files), root: ROOT, now: NOON });
        assert.strictEqual(s.daily.known['2026-09-16'], 7);
        assert.strictEqual(s.coverage.sidechainSessions, 1);
    });

    ok('недописанный хвост строки не ломает проход', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']:
                main({ ts: '2026-09-16T09:00:00.000Z', u: usage(5, 0, 0, 0) }) + '\n' + '{"type":"assist',
        };
        const s = A.computeCcStats({ fs: build(files), root: ROOT, now: NOON });
        assert.strictEqual(s.daily.known['2026-09-16'], 5);
    });

    ok('хвост после watermark: транскрипты дают все четыре категории, как и кеш', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']:
                main({ ts: '2026-09-16T01:00:00.000Z', u: usage(10, 4, 100, 20) }),
        };
        const s = A.computeCcStats({ fs: build(files), root: ROOT, now: NOON });
        assert.strictEqual(s.lifetimeCC, 1134, 'кеш 1000 плюс сутки хвоста 134 целиком');
        assert.strictEqual(s.lifetimeBreakdown.tail, 134);
        assert.strictEqual(s.completeLifetime, true, 'с кешем итог полный: хвост измерен четырьмя категориями');
        assert.strictEqual(s.daily.basis['2026-09-16'], 'transcript');
        assert.strictEqual(s.daily.known['2026-09-16'], 134, 'день графика - та же gross-величина, что день кеша');
        assert.deepStrictEqual(s.daily.tailCache['2026-09-16'], { read: 100, write: 20 });
    });

    ok('дни кеша и дни транскриптов на графике одной величиной', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']: main({ ts: '2026-09-16T01:00:00.000Z', u: usage(10, 0, 90, 0) }),
        };
        const s = A.computeCcStats({ fs: build(files), root: ROOT, now: NOON });
        assert.strictEqual(s.daily.known['2026-09-14'], 1000, 'день кеша - gross');
        assert.strictEqual(s.daily.known['2026-09-16'], 100, 'день транскриптов - тоже gross: 10 + 90');
        const tailKeys = Object.keys(s.daily.tailCache);
        assert.deepStrictEqual(tailKeys, ['2026-09-16'], 'диагностика кеша только за дни транскриптов');
    });

    ok('watermark на сегодня: транскрипты того же дня не добавляются', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']: main({ ts: '2026-09-16T09:00:00.000Z', u: usage(50, 0, 0, 0) }),
        };
        const s = A.computeCcStats({
            fs: build(files, { lastComputedDate: '2026-09-16' }), root: ROOT, now: NOON,
        });
        assert.strictEqual(s.lifetimeCC, 1000, 'двойного счёта быть не должно');
        assert.strictEqual(s.daily.basis['2026-09-16'], 'unknown', 'строка дня ещё не в кеше - пропуск');
        assert.strictEqual(s.coverage.unknownDays, 1);
    });

    ok('день внутри окна кеша без строки: пропуск, а не подстановка транскриптом', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']:
                main({ ts: '2026-09-14T10:00:00.000Z', u: usage(9, 1, 0, 0) }) + '\n' +
                main({ ts: '2026-09-15T10:00:00.000Z', u: usage(8, 2, 0, 0) }),
        };
        const s = A.computeCcStats({ fs: build(files), root: ROOT, now: NOON });
        assert.strictEqual(s.daily.known['2026-09-14'], 1000, 'день со строкой кеша берётся из кеша');
        assert.strictEqual(s.daily.known['2026-09-15'], undefined, 'дня нет в кеше - значения нет');
        assert.strictEqual(s.daily.basis['2026-09-15'], 'unknown');
        assert.strictEqual(s.totals.d7, 1000, 'сумма недели считается по известным дням');
    });

    ok('нет кеша, но есть транскрипты: нижняя граница вместо ложного total', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']: main({ ts: '2026-09-16T09:00:00.000Z', u: usage(30, 4, 0, 0) }),
        };
        const s = A.computeCcStats({ fs: makeFs(files), root: ROOT, now: NOON });
        assert.strictEqual(s.available, true);
        assert.strictEqual(s.reason, 'no-cache');
        assert.strictEqual(s.lifetimeCC, null, 'без кеша total неизвестен');
        assert.strictEqual(s.lifetimeLowerBound, 34);
        assert.strictEqual(s.completeLifetime, false);
    });

    ok('стрик считается от сегодняшнего дня и вчерашний не прощает', () => {
        const three = {
            [ROOT + '/projects/p1/s1.jsonl']:
                main({ ts: '2026-09-14T10:00:00.000Z', u: usage(1, 0, 0, 0) }) + '\n' +
                main({ ts: '2026-09-15T10:00:00.000Z', u: usage(1, 0, 0, 0) }) + '\n' +
                main({ ts: '2026-09-16T10:00:00.000Z', u: usage(1, 0, 0, 0) }),
        };
        const a = A.computeCcStats({ fs: build(three), root: ROOT, now: NOON });
        assert.strictEqual(a.activity.streak.current, 3, 'три дня подряд включая сегодня');
        assert.strictEqual(a.activity.streak.longest, 3);
        assert.strictEqual(a.activity.activeDays, 3, 'активных дней три: сообщения в три разные даты');

        const two = {
            [ROOT + '/projects/p1/s1.jsonl']:
                main({ ts: '2026-09-14T10:00:00.000Z', u: usage(1, 0, 0, 0) }) + '\n' +
                main({ ts: '2026-09-15T10:00:00.000Z', u: usage(1, 0, 0, 0) }),
        };
        const b = A.computeCcStats({ fs: build(two), root: ROOT, now: NOON });
        assert.strictEqual(b.activity.streak.current, 0, 'сегодня нет активности - стрик прерван');
        assert.strictEqual(b.activity.streak.longest, 2);
    });

    ok('крышка чтения помечает усечение вместо тихой потери', () => {
        const long = main({ ts: '2026-09-16T09:00:00.000Z', u: usage(1, 0, 0, 0) }) + '\n';
        const r = A.readTail({ fs: makeFs({ '/f.jsonl': long.repeat(50) }) }, '/f.jsonl', 200);
        assert.strictEqual(r.truncated, true);
        assert.ok(r.text.length <= 200, 'хвост не длиннее лимита');
        const small = A.readTail({ fs: makeFs({ '/g.jsonl': long }) }, '/g.jsonl', long.length);
        assert.strictEqual(small.truncated, false);
        assert.ok(small.text.includes('"type":"assistant"'), 'целый файл читается целиком');
    });

    ok('повторный пересчёт на тех же данных даёт ту же сумму', () => {
        const files = { [ROOT + '/projects/p1/s1.jsonl']: main({ ts: '2026-09-16T09:00:00.000Z', u: usage(9, 1, 0, 0) }) };
        const a = A.computeCcStats({ fs: build(files), root: ROOT, now: NOON });
        const b = A.computeCcStats({ fs: build(files), root: ROOT, now: NOON });
        assert.strictEqual(a.lifetimeCC, b.lifetimeCC);
        assert.deepStrictEqual(a.daily.known, b.daily.known);
    });

    ok('корень конфигурации переопределяется аргументом', () => {
        const other = '/custom/cfg';
        const s = A.computeCcStats({ fs: makeFs({ [other + '/stats-cache.json']: cacheDoc() }), root: other, now: NOON });
        assert.strictEqual(s.lifetimeCC, 1000);
    });

    ok('активность и стрик берутся из кеша, а не только из уцелевших транскриптов', () => {
        // Живой замер 16.09 поймал дефект: по одним транскриптам выходило 31 активный день
        // и стрик 31, тогда как `/stats` показывал 82 активных дня и стрик 50. Причина -
        // старые сессии удалены, а кеш `dailyActivity` историю хранит.
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']: main({ ts: '2026-09-16T09:00:00.000Z', u: usage(5, 0, 0, 0) }),
        };
        const cacheOpts = {
            dailyActivity: [
                { date: '2026-09-12', messageCount: 5, sessionCount: 1, toolCallCount: 0 },
                { date: '2026-09-13', messageCount: 5, sessionCount: 1, toolCallCount: 0 },
                { date: '2026-09-14', messageCount: 5, sessionCount: 1, toolCallCount: 0 },
                { date: '2026-09-15', messageCount: 5, sessionCount: 1, toolCallCount: 0 },
            ],
        };
        const s = A.computeCcStats({ fs: build(files, cacheOpts), root: ROOT, now: NOON });
        assert.strictEqual(s.activity.activeDays, 5, 'четыре дня кеша плюс сегодняшний');
        assert.strictEqual(s.activity.streak.current, 5, 'стрик непрерывен с 12.09 по 16.09');
        assert.strictEqual(s.activity.streak.longest, 5);
    });

    ok('без кеша активность считается по транскриптам', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']:
                main({ ts: '2026-09-15T09:00:00.000Z', u: usage(1, 0, 0, 0) }) + '\n' +
                main({ ts: '2026-09-16T09:00:00.000Z', u: usage(1, 0, 0, 0) }),
        };
        const s = A.computeCcStats({ fs: makeFs(files), root: ROOT, now: NOON });
        assert.strictEqual(s.activity.activeDays, 2);
        assert.strictEqual(s.activity.streak.current, 2);
    });

    ok('кеш без сегодняшнего дня не выдумывает стрик', () => {
        const files = { [ROOT + '/projects/p1/s1.jsonl']: main({ ts: '2026-09-10T09:00:00.000Z', u: usage(1, 0, 0, 0) }) };
        const s = A.computeCcStats({
            fs: build(files, { dailyActivity: [{ date: '2026-09-13', messageCount: 3, sessionCount: 1, toolCallCount: 0 }] }),
            root: ROOT, now: NOON,
        });
        assert.strictEqual(s.activity.activeDays, 2, '13.09 из кеша и 10.09 из транскриптов');
        assert.strictEqual(s.activity.streak.current, 0, 'сегодня активности нет');
        assert.strictEqual(s.activity.streak.longest, 1);
    });

    ok('часовые корзины считаются по UTC и дают окно суток', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']:
                main({ ts: '2026-09-16T09:30:00.000Z', u: usage(10, 0, 90, 0) }) + '\n' +
                main({ ts: '2026-09-16T09:45:00.000Z', u: usage(5, 0, 0, 0) }) + '\n' +
                main({ ts: '2026-09-15T23:10:00.000Z', u: usage(7, 0, 0, 0) }),
        };
        const s = A.computeCcStats({ fs: build(files), root: ROOT, now: noonOn('2026-09-16T10:00:00Z') });
        assert.deepStrictEqual(s.hourly.keys, ['2026-09-15T23', '2026-09-16T09'], 'часовые ключи по UTC');
        assert.strictEqual(s.hourly.h24['2026-09-16T09'], 105, 'час складывает сутки целиком, включая кеш');
        assert.strictEqual(s.hourly.h24['2026-09-15T23'], 7, 'час до полуночи UTC - в своём часе');
        assert.strictEqual(s.hourly.h24['2026-09-16T10'], undefined, 'ещё не наступивший час не выдумывается');
    });

    ok('окно суток скользящее: 24 часа назад ещё в окне, 25 уже нет', () => {
        const files = {
            [ROOT + '/projects/p1/s1.jsonl']:
                main({ ts: '2026-09-15T09:00:00.000Z', u: usage(100, 0, 0, 0) }) + '\n' +   // ровно 25 ч назад
                main({ ts: '2026-09-15T23:00:00.000Z', u: usage(3, 0, 0, 0) }) + '\n' +    // 11 ч назад
                main({ ts: '2026-09-16T09:00:00.000Z', u: usage(4, 0, 0, 0) }),           // 1 ч назад
        };
        const s = A.computeCcStats({ fs: build(files), root: ROOT, now: noonOn('2026-09-16T10:00:00Z') });
        const sum24 = Object.keys(s.hourly.h24).reduce((x, k) => x + s.hourly.h24[k], 0);
        assert.strictEqual(sum24, 7, 'скользящие сутки: 3 и 4 в окне, 100 за 25 часов - уже нет');
        assert.strictEqual(s.daily.known['2026-09-16'], 4, 'календарные сутки UTC дают другое число');
    });

    ok('срез для обмена несёт версию, полноту и только числа с датами', () => {
        const files = { [ROOT + '/projects/p1/s1.jsonl']: main({ ts: '2026-09-16T09:00:00.000Z', u: usage(10, 0, 90, 0) }) };
        const s = A.computeCcStats({ fs: build(files), root: ROOT, now: NOON });
        const e = A.envelopeFrom(s, '2026-09-16T12:00:00.000Z');
        assert.strictEqual(e.v, 1, 'версия определения едет в срез');
        assert.strictEqual(e.available, true);
        assert.strictEqual(e.lifetime, 1100, 'кеш 1000 плюс сутки 100');
        assert.strictEqual(e.complete, true);
        assert.strictEqual(e.totals.d7, 1100);
        assert.strictEqual(typeof e.totals.h24, 'number');
        assert.deepStrictEqual(e.days.keys.slice(-1), ['2026-09-16']);
        assert.strictEqual(e.days.values[e.days.values.length - 1], 100);
        assert.strictEqual(e.activity.streakCurrent, 1);
        assert.strictEqual(e.source.watermark, '2026-09-15');
        const dump = JSON.stringify(e);
        assert.ok(!dump.includes('/home/'), 'путей в срезе нет');
        assert.ok(!dump.includes('projects'), 'имён каталогов в срезе нет');
        assert.ok(dump.length < 8000, 'срез не раздувается: ' + dump.length + ' байт');
    });

    ok('срез без снимка помечен как «нет данных», а не нулями', () => {
        const e = A.envelopeFrom(null);
        assert.strictEqual(e.available, false);
        assert.strictEqual(e.lifetime, null);
        assert.strictEqual(e.totals.d7, null);
        assert.strictEqual(e.activity, null);
    });

    // 🔴 Свежая установка 23.09 (друг): на машине нет ни кэша Claude Code, ни транскриптов,
    // и `snapshotFrom` отдаёт фигуру «нет источников» - БЕЗ `hourly`, `daily` и `activity`.
    // `envelopeFrom` разыменовывал `snap.hourly.h24` и валил `leagueSync` целиком
    // (`Cannot read properties of undefined (reading 'h24')` в логе хаба): участник молча
    // не отправлял свой срез, а выглядело это как «приёмник не отвечает».
    ok('срез «нет источников» не роняет обмен и едет как «нет данных»', () => {
        const noSources = {
            accountingVersion: 1, available: false, reason: 'no-sources',
            lifetimeCC: null, lifetimeLowerBound: null, completeLifetime: false,
            totals: { d7: null, d30: null }, daily: { keys: [], known: {}, basis: {} },
            activity: { activeDays: 0, sessions: 0, messages: 0, streak: { current: 0, longest: 0 }, lastDate: null, hours: {} },
            source: { cache: null, cacheVersion: null, dailyVersion: null, watermark: null, firstSession: null },
            coverage: { unknownDays: 0 }, truncatedFiles: 0,
        };
        const e = A.envelopeFrom(noSources, '2026-09-16T12:00:00.000Z');
        assert.strictEqual(e.available, false, 'это «нет данных», а не нули');
        assert.strictEqual(e.reason, 'no-sources', 'причина названа своя, а не no-snapshot');
        assert.strictEqual(e.totals.h24, null);
        assert.deepStrictEqual(e.hours.keys, [], 'часовой ряд пуст, а не бросает');
        assert.strictEqual(e.activity, null);
    });

    ok('срез без кеша отдаёт нижнюю границу и запрет на полное сравнение', () => {
        const files = { [ROOT + '/projects/p1/s1.jsonl']: main({ ts: '2026-09-16T09:00:00.000Z', u: usage(42, 0, 0, 0) }) };
        const s = A.computeCcStats({ fs: makeFs(files), root: ROOT, now: NOON });
        const e = A.envelopeFrom(s);
        assert.strictEqual(e.lifetime, null, 'полного итога нет');
        assert.strictEqual(e.lifetimeLower, 42);
        assert.strictEqual(e.complete, false, 'участник с неполным итогом не идёт в общий рейтинг');
    });

    // ── Прочие харнессы из журнала front-door ─────────────────────────────────────
    // Правило: Claude Code считается из своих данных, а журнал идёт в счёт ТОЛЬКО тем, что
    // не он. Иначе один и тот же трафик посчитается дважды - он виден и в транскриптах, и
    // в журнале.
    const jline = o => JSON.stringify(Object.assign({ t: '2026-09-16T09:00:00.000Z', in: 0, out: 0, cr: 0, cw: 0, m: 'x', st: 1 }, o));
    const journalFs = (journal, cacheOpts) => makeFs({
        [ROOT + '/stats-cache.json']: cacheDoc(cacheOpts),
        '/hub/routing/token-usage.jsonl': journal,
    });

    ok('прочие харнессы берутся из журнала, а Claude Code из журнала не берётся', () => {
        const journal = [
            jline({ h: 'claude-code', in: 1_000_000, out: 5_000 }),
            jline({ h: 'opencode', in: 400_000, out: 2_000 }),
            jline({ h: 'opencode', in: 100_000, out: 1_000 }),
            jline({ h: 'curl', in: 7, out: 0 }),
        ].join('\n') + '\n';
        const s = A.computeCcStats({ fs: journalFs(journal), root: ROOT, now: NOON, journalPath: '/hub/routing/token-usage.jsonl' });
        const fromJournal = s.sources.filter(x => x.coverage === 'journal').map(x => x.h).sort();
        assert.deepStrictEqual(fromJournal, ['curl', 'opencode'], 'в журнальный счёт попали только прочие: ' + fromJournal.join(','));
        const oc = s.sources.find(x => x.h === 'opencode');
        assert.strictEqual(oc.tokens, 503_000, 'вход+выход двух записей');
        assert.strictEqual(s.otherTokens, 503_007, 'сумма прочих');
        assert.strictEqual(s.lifetimeCC, 1000, 'счётчик Claude Code не тронут');
        assert.strictEqual(s.lifetime, 1000 + 503_007, 'итог = Claude Code + прочие');
    });

    ok('записи журнала раскладываются по UTC-дням и окнам', () => {
        const journal = [
            jline({ h: 'opencode', in: 10, out: 0, t: '2026-09-15T23:30:00.000Z' }),
            jline({ h: 'opencode', in: 20, out: 0, t: '2026-09-16T00:30:00.000Z' }),
        ].join('\n') + '\n';
        const s = A.computeCcStats({ fs: journalFs(journal), root: ROOT, now: NOON, journalPath: '/hub/routing/token-usage.jsonl' });
        assert.strictEqual(s.otherDays['2026-09-15'], 10, 'вечер UTC на своей дате');
        assert.strictEqual(s.otherDays['2026-09-16'], 20, 'ночь UTC в следующих сутках');
        assert.strictEqual(s.otherD7, 30, 'окно недели включает оба дня');
    });

    ok('журнала нет - это пропуск в источниках, а не ошибка', () => {
        const s = A.computeCcStats({ fs: build({}), root: ROOT, now: NOON, journalPath: '/hub/routing/token-usage.jsonl' });
        assert.strictEqual(s.lifetimeCC, 1000, 'счётчик Claude Code считается как обычно');
        assert.strictEqual(s.otherTokens, 0);
        assert.deepStrictEqual(s.sources.map(x => x.h), ['claude-code'], 'источник только один');
        assert.strictEqual(s.journal.reason, 'no-journal');
    });

    ok('огромный журнал читается хвостом и помечает усечение', () => {
        const long = jline({ h: 'opencode', in: 5, out: 0 }) + '\n';
        const s = A.computeCcStats({
            fs: journalFs(long.repeat(400)), root: ROOT, now: NOON,
            journalPath: '/hub/routing/token-usage.jsonl', journalCap: 2000,
        });
        assert.strictEqual(s.journal.truncated, true, 'файл больше потолка - охват обрезан');
        assert.ok(s.journal.lines > 0, 'строки прочитались');
        assert.strictEqual(s.sources.find(x => x.h === 'opencode') !== undefined, true, 'харнесс опознан');
    });

    ok('имя харнесса из user-agent обрезается и не тащит разметку', () => {
        const journal = jline({ h: '<img src=x onerror=alert(1)>оченьдлинноеимяхарнесса', in: 1, out: 0 }) + '\n';
        const s = A.computeCcStats({ fs: journalFs(journal), root: ROOT, now: NOON, journalPath: '/hub/routing/token-usage.jsonl' });
        const h = s.sources.find(x => x.h !== 'claude-code').h;
        assert.ok(h.length <= 24, 'имя ограничено по длине: ' + h);
        assert.ok(!/[<>]/.test(h), 'угловые скобки не проходят: ' + h);
    });

    ok('в срез уезжает состав источников, а не только сумма', () => {
        const journal = jline({ h: 'opencode', in: 400_000, out: 2_000 }) + '\n';
        const s = A.computeCcStats({ fs: journalFs(journal), root: ROOT, now: NOON, journalPath: '/hub/routing/token-usage.jsonl' });
        const e = A.envelopeFrom(s);
        assert.strictEqual(e.lifetime, 1000 + 402_000, 'итог с прочими');
        assert.strictEqual(e.sources.length, 2, 'два источника в срезе');
        const cc = e.sources.find(x => x.h === 'claude-code');
        const oc = e.sources.find(x => x.h === 'opencode');
        assert.strictEqual(cc.tokens, 1000);
        assert.strictEqual(cc.coverage, 'full');
        assert.strictEqual(oc.tokens, 402_000);
        assert.strictEqual(oc.coverage, 'journal', 'охват журнала помечен как неполный');
        assert.ok(JSON.stringify(e).length < 9000, 'срез не раздувается: ' + JSON.stringify(e).length);
    });

    ok('в снимке нет путей, имён файлов и текстов', () => {
        const files = { [ROOT + '/projects/p1/s1.jsonl']: main({ ts: '2026-09-16T09:00:00.000Z', u: usage(3, 1, 0, 0) }) };
        const s = A.computeCcStats({ fs: build(files), root: ROOT, now: NOON });
        const dump = JSON.stringify(s);
        assert.ok(!dump.includes('/projects/'), 'путь проекта не должен уезжать');
        assert.ok(!dump.includes('s1.jsonl'), 'имя файла не должно уезжать');
        assert.ok(!dump.includes(ROOT), 'корень конфигурации не должен уезжать');
    });

    // ── Кеш-слой: дашборд не имеет права сканировать гигабайты на каждый запрос ──────
    // Счётчик чтений вешается на синтетический fs, поэтому проверка не «на глаз»:
    // она видит каждое обращение к файлу.
    function countingFs(files, cacheOpts) {
        const inner = build(files, cacheOpts);
        const reads = { content: 0, stat: 0, dir: 0, byPath: {} };
        return {
            reads,
            fs: {
                readFileSync: p => {
                    reads.content++;
                    reads.byPath[p] = (reads.byPath[p] || 0) + 1;
                    return inner.readFileSync(p);
                },
                statSync: p => { reads.stat++; return inner.statSync(p); },
                readdirSync: p => { reads.dir++; return inner.readdirSync(p); },
            },
        };
    }

    ok('кеш-слой существует и отдаёт снимок без сканирования до первого refresh', () => {
        assert.strictEqual(typeof A.createStatsCache, 'function', 'нужен createStatsCache');
        const c = countingFs({ [ROOT + '/projects/p1/s1.jsonl']: main({ ts: '2026-09-16T09:00:00.000Z', u: usage(5, 0, 0, 0) }) });
        const cache = A.createStatsCache({ fs: c.fs, root: ROOT, now: () => NOON });
        assert.strictEqual(cache.snapshot(), null, 'до первого refresh снимка нет');
        assert.strictEqual(c.reads.content, 0, 'snapshot не должен читать файлы');
    });

    ok('второй refresh без изменений не перечитывает содержимое', () => {
        const t = ROOT + '/projects/p1/s1.jsonl';
        const c = countingFs({ [t]: main({ ts: '2026-09-16T09:00:00.000Z', u: usage(5, 0, 0, 0) }) });
        const cache = A.createStatsCache({ fs: c.fs, root: ROOT, now: () => NOON });
        return cache.refresh().then(first => {
            const after = c.reads.byPath[t];
            assert.strictEqual(after, 1, 'первый проход читает файл один раз');
            return cache.refresh().then(second => {
                assert.strictEqual(c.reads.byPath[t], after, 'повторный проход не читает файл заново');
                assert.strictEqual(second.daily.known['2026-09-16'], first.daily.known['2026-09-16']);
                assert.strictEqual(cache.stats().filesRead, 0, 'во втором проходе не прочитано ни одного файла');
                assert.strictEqual(cache.stats().filesReused, 1, 'вклад взят из памяти');
            });
        });
    });

    ok('изменённый файл перечитывается, а не остаётся старым', () => {
        let body = main({ ts: '2026-09-16T09:00:00.000Z', u: usage(5, 0, 0, 0) });
        const inner = build({ [ROOT + '/projects/p1/s1.jsonl']: body });
        let mtime = 1;
        const files = new Map([[ROOT + '/projects/p1/s1.jsonl', () => body]]);
        const fs2 = {
            readFileSync: p => {
                if (files.has(p)) return Buffer.from(files.get(p)(), 'utf8');
                return inner.readFileSync(p);
            },
            statSync: p => {
                if (files.has(p)) return { size: Buffer.byteLength(files.get(p)()), mtimeMs: mtime };
                return inner.statSync(p);
            },
            readdirSync: p => inner.readdirSync(p),
        };
        const cache = A.createStatsCache({ fs: fs2, root: ROOT, now: () => NOON });
        return cache.refresh().then(a => {
            assert.strictEqual(a.daily.known['2026-09-16'], 5);
            body = main({ ts: '2026-09-16T09:00:00.000Z', u: usage(50, 0, 0, 0) });
            mtime = 2;
            return cache.refresh().then(b => {
                assert.strictEqual(b.daily.known['2026-09-16'], 50, 'перечитанный файл даёт новое число');
                assert.strictEqual(cache.stats().filesRead, 1, 'перечитан ровно один файл');
            });
        });
    });

    ok('исчезнувший файл уносит свой вклад из снимка', () => {
        const files = new Map([[ROOT + '/projects/p1/s1.jsonl', main({ ts: '2026-09-16T09:00:00.000Z', u: usage(5, 0, 0, 0) })]]);
        const inner = build({});
        const fs3 = {
            readFileSync: p => (files.has(p) ? Buffer.from(files.get(p), 'utf8') : inner.readFileSync(p)),
            statSync: p => {
                if (files.has(p)) return { size: Buffer.byteLength(files.get(p)), mtimeMs: 1 };
                return inner.statSync(p);
            },
            readdirSync: p => {
                if (p === ROOT + '/projects') return ['p1'];
                if (p === ROOT + '/projects/p1') return files.size ? ['s1.jsonl'] : [];
                return inner.readdirSync(p);
            },
        };
        const cache = A.createStatsCache({ fs: fs3, root: ROOT, now: () => NOON });
        return cache.refresh().then(a => {
            assert.strictEqual(a.daily.known['2026-09-16'], 5);
            files.clear();
            return cache.refresh().then(b => {
                assert.strictEqual(b.daily.known['2026-09-16'], undefined, 'вклад удалённого файла уходит');
                assert.strictEqual(b.activity.activeDays, 1, 'остаётся только день из кеша');
            });
        });
    });

    ok('два одновременных refresh не запускают два сканирования', () => {
        const t = ROOT + '/projects/p1/s1.jsonl';
        const c = countingFs({ [t]: main({ ts: '2026-09-16T09:00:00.000Z', u: usage(5, 0, 0, 0) }) });
        const cache = A.createStatsCache({ fs: c.fs, root: ROOT, now: () => NOON });
        const p1 = cache.refresh(), p2 = cache.refresh();
        return Promise.all([p1, p2]).then(([a, b]) => {
            assert.strictEqual(c.reads.byPath[t], 1, 'файл прочитан один раз на два вызова');
            assert.strictEqual(a.daily.known['2026-09-16'], b.daily.known['2026-09-16']);
            assert.strictEqual(cache.stats().refreshes, 1, 'проход один');
        });
    });

    ok('упавший проход не публикует нули и оставляет прошлый снимок', () => {
        const c = countingFs({ [ROOT + '/projects/p1/s1.jsonl']: main({ ts: '2026-09-16T09:00:00.000Z', u: usage(5, 0, 0, 0) }) });
        let broken = false;
        const cache = A.createStatsCache({
            fs: {
                readFileSync: p => {
                    if (broken && p.endsWith('stats-cache.json')) throw new Error('ENOENT');
                    return c.fs.readFileSync(p);
                },
                statSync: c.fs.statSync, readdirSync: c.fs.readdirSync,
            },
            root: ROOT, now: () => NOON,
        });
        return cache.refresh().then(a => {
            assert.strictEqual(a.lifetimeCC, 1005, 'кеш 1000 плюс хвост 5');
            broken = true;
            return cache.refresh().then(b => {
                assert.strictEqual(b.lifetimeCC, a.lifetimeCC, 'снимок остался прежним');
                assert.strictEqual(b.stale, true, 'и помечен как несвежий');
                assert.strictEqual(cache.snapshot().lifetimeCC, a.lifetimeCC, 'опубликован последний хороший');
                assert.ok(cache.stats().stalePasses >= 1);
            });
        });
    });

    ok('refresh не бросает наружу и не блокирует вызывающего', () => {
        const c = countingFs({});
        const cache = A.createStatsCache({ fs: c.fs, root: ROOT, now: () => NOON });
        const r = cache.refresh();
        assert.ok(typeof r.then === 'function', 'refresh возвращает обещание');
        return r.then(() => {});
    });
}

finish();