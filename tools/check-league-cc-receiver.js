'use strict';
// Тесты приёмника Лиги на синтетических срезах. Модуль приёмника при `require` поднимает
// сервер и слушает порт, поэтому функции вырезаются из исходника и исполняются отдельно -
// тот же приём, что в `tools/check-league-chat.js`. Живые данные, сеть и запись на диск не
// участвуют: ни секретов, ни портов, ни файлов.
//
// Запуск: node tools/check-league-cc-receiver.js
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
        console.log('\ncheck-league-cc-receiver: ' + passed + ' ok, ' + failed + ' fail');
        process.exit(failed ? 1 : 0);
    });
}

function locate() {
    for (const c of ['C:/Users/WormAlien/Desktop/Autoreger_Clean/routing', process.env.AUTOREGER_ROUTING]) {
        if (c && fs.existsSync(path.join(c, 'league-receiver.js'))) return path.join(c, 'league-receiver.js');
    }
    throw new Error('не найден routing/league-receiver.js; задай AUTOREGER_ROUTING');
}
const SRC = fs.readFileSync(locate(), 'utf8');

function cut(fromMarker, toMarker, name) {
    const a = SRC.indexOf(fromMarker);
    const b = SRC.indexOf(toMarker);
    if (a < 0 || b < 0 || b <= a) throw new Error(`не вырезался блок ${name}`);
    return SRC.slice(a, b);
}

// Новый блок канонического счётчика: вырезается первым, потому что `sliceClean` его зовёт.
let ccApi = null, ccErr = '';
try {
    ccApi = new Function(`${cut('// ── CC-STATS-BEGIN', '// ── CC-STATS-END', 'cc-stats')}
        return { ccClean, ccGuard, legacyHold, CC_REASONS, CC_DAYS_MAX, CC_HOURS_MAX, LEGACY_HOLD_MAX_MS };`)();
} catch (e) { ccErr = e.message; }
// Белый список и очистка среза: константы, помощники и сама `sliceClean`.
const sliceSrc = cut('const WINDOWS = ', '// ── Состояние одного журнала', 'sliceClean');
const sliceApi = new Function('avatarClean', 'ccClean',
    `${sliceSrc}\nreturn { sliceClean, windowsOf, totClean };`)(() => null, ccApi ? ccApi.ccClean : () => null);
// Публичная выдача соседям.
const peerSrc = cut('const PEER_PUBLIC = ', 'function handlePeers', 'peerPublic');
const peerApi = new Function('ridOf', `${peerSrc}\nreturn { peerPublic, PEER_PUBLIC };`)(id => 'r-' + String(id).slice(0, 4));

const NOW = Date.parse('2026-09-16T12:00:00Z');
function slice(over) {
    return Object.assign({
        installId: 'a'.repeat(16), nick: 'Тест', ver: '9.9.9',
        keys: { d7: ['2026-09-15', '2026-09-16'], all: ['2026-09-16'] },
        tok: { d7: [1, 2], all: [3] },
        tot: { tokA: 1000, promptsAll: 5, spentAll: 1, bought: 1, reg: 2 },
    }, over || {});
}
function envelope(over) {
    return Object.assign({
        v: 1, available: true, reason: null,
        lifetime: 59_000_000_000, lifetimeLower: null, complete: true, stale: false,
        asOf: '2026-09-16T11:59:00.000Z',
        totals: { h24: 1_000_000, d7: 17_000_000_000, d30: 48_000_000_000 },
        days: { keys: ['2026-09-15', '2026-09-16'], values: [2_500_000_000, 3_600_000_000] },
        hours: { keys: ['2026-09-16T11'], values: [1_000_000] },
        breakdown: { cache: 55_000_000_000, tail: 4_000_000_000, days: 46_000_000_000 },
        activity: { activeDays: 82, sessions: 1455, messages: 483333, streakCurrent: 50, streakLongest: 50, lastDate: '2026-09-16' },
        source: { cacheVersion: 5, dailyVersion: 5, watermark: '2026-09-15', truncatedFiles: 2 },
        unknownDays: 0,
    }, over || {});
}

ok('блок канонического счётчика вырезается из приёмника', () => {
    assert.ok(ccApi, 'нет блока CC-STATS: ' + ccErr);
});

if (ccApi) {
    ok('приёмник хранит конверт, а не выбрасывает его', () => {
        const out = sliceApi.sliceClean(slice({ ccStats: envelope() }), 'Тест', '2026-09-16T12:00:00.000Z');
        assert.ok(out.ccStats, 'ccStats потерян белым списком');
        assert.strictEqual(out.ccStats.lifetime, 59_000_000_000);
        assert.strictEqual(out.ccStats.v, 1);
    });

    ok('неизвестное в конверте не проходит границу', () => {
        const dirty = envelope({
            evil: 'строка с разметкой', totals: { h24: 1, d7: 2, d30: 3, evil: 4 },
            days: { keys: ['2026-09-16'], values: [5], evil: ['x'] },
            source: { cacheVersion: 5, dailyVersion: 5, watermark: '2026-09-15', path: '/home/u/.claude' },
        });
        const out = ccApi.ccClean(dirty);
        const dump = JSON.stringify(out);
        assert.ok(!dump.includes('evil'), 'неизвестное поле проехало: ' + dump.slice(0, 200));
        assert.ok(!dump.includes('/home/'), 'путь проехал');
        assert.deepStrictEqual(Object.keys(out.days), ['keys', 'values']);
    });

    ok('null остаётся null, а не превращается в ноль', () => {
        const out = ccApi.ccClean(envelope({ lifetime: null, lifetimeLower: 42, available: false, totals: { h24: null, d7: null, d30: null } }));
        assert.strictEqual(out.lifetime, null, 'неизвестный итог не должен стать нулём');
        assert.strictEqual(out.lifetimeLower, 42);
        assert.strictEqual(out.available, false);
        assert.strictEqual(out.totals.h24, null);
    });

    ok('код причины ограничен списком, чужой текст не едет', () => {
        assert.strictEqual(ccApi.ccClean(envelope({ reason: 'no-cache' })).reason, 'no-cache');
        assert.strictEqual(ccApi.ccClean(envelope({ reason: '<img src=x onerror=1>' })).reason, null);
        assert.ok(ccApi.CC_REASONS.has('unsupported-cache-version'));
    });

    ok('ряды обрезаются вместе с ключами и остаются числами', () => {
        const n = ccApi.CC_DAYS_MAX + 50;
        const dayAt = i => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
        const out = ccApi.ccClean(envelope({
            days: { keys: Array.from({ length: n }, (_, i) => dayAt(i)), values: Array.from({ length: n }, (_, i) => i) },
        }));
        assert.strictEqual(out.days.keys.length, out.days.values.length, 'ключи и значения разъехались');
        assert.strictEqual(out.days.keys.length, ccApi.CC_DAYS_MAX, 'ряд не обрезан до потолка');
        assert.strictEqual(out.days.keys[0], dayAt(n - ccApi.CC_DAYS_MAX), 'обрезается хвост, а не голова');
        const bad = ccApi.ccClean(envelope({ days: { keys: ['2026-09-16', 'x'], values: [Infinity, -5] } }));
        assert.deepStrictEqual(bad.days, { keys: ['2026-09-16'], values: [0] },
            'негодный ключ уносит своё значение, а не весь ряд');
    });

    ok('часовое окно тоже ограничено по длине', () => {
        const n = ccApi.CC_HOURS_MAX + 10;
        const out = ccApi.ccClean(envelope({
            hours: { keys: Array.from({ length: n }, (_, i) => '2026-09-16T' + String(i).padStart(2, '0')), values: Array.from({ length: n }, () => 1) },
        }));
        assert.strictEqual(out.hours.keys.length, ccApi.CC_HOURS_MAX);
        assert.strictEqual(out.hours.keys.length, out.hours.values.length);
    });

    ok('публичная выдача соседям несёт канонический счётчик', () => {
        assert.deepStrictEqual(ccApi && peerApi.PEER_PUBLIC.filter(k => k === 'ccStats'), ['ccStats'], 'поля нет в белом списке');
        const pub = peerApi.peerPublic(slice({ ccStats: envelope() }));
        assert.ok(pub.ccStats, 'ccStats не доехал до соседей');
        assert.strictEqual(pub.installId, undefined, 'installId по-прежнему не уезжает');
        assert.ok(!JSON.stringify(pub).includes('Тест"/'), 'ник не подменён');
    });

    ok('первый канонический срез становится базой без сравнения с legacy', () => {
        const prev = { tot: { tokA: 5_000_000 } };
        const reason = ccApi.ccGuard(prev, { ccStats: envelope() }, NOW);
        assert.strictEqual(reason, null, 'новый счётчик не должен сравниваться с legacy tokA');
    });

    ok('обвал канонического итога отвергается', () => {
        const prev = { ccStats: envelope() };
        const dropped = envelope({ lifetime: 20_000_000_000 });
        assert.ok(ccApi.ccGuard(prev, { ccStats: dropped }, NOW), 'просадка вдвое должна быть отклонена');
    });

    ok('пропуск конверта не сбрасывает базу', () => {
        const prev = { ccStats: envelope() };
        assert.strictEqual(ccApi.ccGuard(prev, { tok: {} }, NOW), null, 'без конверта проверять нечего');
        const jumped = envelope({ lifetime: 400_000_000_000 });
        assert.ok(ccApi.ccGuard(prev, { ccStats: jumped }, NOW), 'база осталась прежней, скачок виден');
    });

    ok('чужая версия определения не сравнивается с нашей', () => {
        const prev = { ccStats: envelope() };
        assert.strictEqual(ccApi.ccGuard(prev, { ccStats: envelope({ v: 2, lifetime: 900_000_000_000 }) }, NOW), null);
        assert.strictEqual(ccApi.ccGuard(prev, { ccStats: envelope({ v: 99 }) }, NOW), null);
    });

    ok('недоступный конверт не портит базу', () => {
        const prev = { ccStats: envelope() };
        assert.strictEqual(ccApi.ccGuard(prev, { ccStats: envelope({ available: false, lifetime: null }) }, NOW), null);
    });

    ok('отказ по legacy-токенам держит legacy, но пропускает канонический', () => {
        const prev = slice({ ccStats: envelope(), tot: { tokA: 1000, promptsAll: 5, spentAll: 1, bought: 1, reg: 2 } });
        const next = sliceApi.sliceClean(slice({
            ccStats: envelope({ lifetime: 60_000_000_000 }),
            tot: { tokA: 90_000_000, promptsAll: 5, spentAll: 1, bought: 1, reg: 2 },
            tok: { d7: [40_000_000, 50_000_000], all: [90_000_000] },
        }), 'Тест', '2026-09-16T12:00:00.000Z');
        const held = ccApi.legacyHold(prev, next, 'tokA вырос на 89000000 за 0.10 ч, потолок 1000000', NOW);
        assert.ok(held, 'удержание не сработало');
        assert.strictEqual(held.next.tot.tokA, 1000, 'legacy-число осталось прежним');
        assert.deepStrictEqual(held.next.tok.all, [3], 'legacy-ряд тоже прежний');
        assert.strictEqual(held.next.ccStats.lifetime, 60_000_000_000, 'канонический проходит целиком');
        assert.strictEqual(held.next.tot.spentAll, 1, 'деньги не переписываются');
        assert.ok(held.held.since, 'у удержания есть время начала');
    });

    ok('отказ по деньгам или аккаунтам удержанием не лечится', () => {
        const prev = slice({ ccStats: envelope() });
        const next = sliceApi.sliceClean(slice({ ccStats: envelope() }), 'Тест', '2026-09-16T12:00:00.000Z');
        assert.strictEqual(ccApi.legacyHold(prev, next, 'spentAll вырос на 500000 за 0.10 ч, потолок 1', NOW), null);
        assert.strictEqual(ccApi.legacyHold(prev, next, 'acc убыл: 300 → 100', NOW), null);
    });

    ok('без канонического конверта удержания нет: поведение прежнее', () => {
        const prev = slice({ ccStats: envelope() });
        const next = sliceApi.sliceClean(slice({}), 'Тест', '2026-09-16T12:00:00.000Z');
        assert.strictEqual(ccApi.legacyHold(prev, next, 'tokA вырос на 89000000 за 0.10 ч', NOW), null);
    });

    ok('затянувшееся удержание сдаётся и принимает новые legacy-числа', () => {
        const prev = slice({ ccStats: envelope(), legacyHeld: { since: new Date(NOW - ccApi.LEGACY_HOLD_MAX_MS - 1000).toISOString(), reason: 'tokA' } });
        const next = sliceApi.sliceClean(slice({ ccStats: envelope(), tot: { tokA: 90_000_000, promptsAll: 5, spentAll: 1, bought: 1, reg: 2 } }),
            'Тест', '2026-09-16T12:00:00.000Z');
        const out = ccApi.legacyHold(prev, next, 'tokA вырос на 89000000 за 0.10 ч', NOW);
        assert.ok(out && out.next.tot.tokA === 90_000_000, 'после потолка новые числа принимаются');
        assert.ok(out.rebasedLegacy, 'и это видно как ребейз legacy');
        assert.ok(!out.next.legacyHeld, 'удержание снимается');
    });
}

finish();
