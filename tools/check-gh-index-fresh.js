'use strict';
// Свежесть индекса профилей на пути /api/gh/keys (баг 17.09).
//
// Что было: бейдж GitHub говорил «сессии нет ни в общем снимке, ни в профилях» (красный),
// хотя сессия лежала в профиле AgentRouter - индекс профилей на диске был старше самого
// профиля, а список аккаунтов его не обновлял. Красное «сессии нет» на незнании - ложь,
// ровно та же, что уже запрещена в этом месте для недоступного модуля (`hasSnap: null`).
//
// Запуск: node tools/check-gh-index-fresh.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const pending = [];
// 🪤 Обвязка дожидается обещаний: тест, который никто не ждёт, «проходит» всегда.
const ok = (name, fn) => {
    const done = () => { passed++; console.log('  ok   ' + name); };
    const bad = e => { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); };
    try {
        const r = fn();
        if (r && typeof r.then === 'function') pending.push(r.then(done, bad));
        else done();
    } catch (e) { bad(e); }
};
const finish = () => {
    clearTimeout(watchdog);   // снимаем сторож: тесты дошли до конца сами
    return Promise.all(pending).then(() => {
        console.log('\ncheck-gh-index-fresh: ' + passed + ' ok, ' + failed + ' fail');
        process.exit(failed ? 1 : 0);
    });
};
// Сторож: подвешенное обещание обязано выглядеть провалом, а не молчанием до таймаута.
const watchdog = setTimeout(() => {
    console.log('\nFAIL: тесты не завершились за 30 с (подвешенное обещание)');
    process.exit(1);
}, 30000);

const ROOT = path.join(__dirname, '..');
const lf = s => s.replace(/\r\n/g, '\n');
const PROXY = lf(fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8'));
const HTML = lf(fs.readFileSync(path.join(ROOT, 'routing', 'proxy-dashboard.html'), 'utf8'));

// Вырезаем функцию целиком: от строки объявления до закрывающей скобки в начале строки.
function cutFn(src, head) {
    const i = src.indexOf(head);
    if (i < 0) return '';
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? undefined : j + 2);
}

const freshSrc = cutFn(PROXY, 'function ghIndexState(');
const snapSrc = cutFn(PROXY, 'function ghSnapHealth(');
const keysSrc = cutFn(PROXY, 'async function handleGhKeys(');
const badgeSrc = cutFn(HTML, 'function newapiGhBadge(');
const loadSrc = cutFn(HTML, 'async function loadGhKeys(');

// Сборка обёрток: если функции в исходнике ещё нет, тест обязан ПОКАЗАТЬ провал, а не
// упасть на конструировании и утащить за собой остальные проверки.
function build(name, fn) {
    try { return { ok: true, fn: fn() }; }
    catch (e) { return { ok: false, err: `${name}: ${e.message}` }; }
}
const need = (b, what) => { if (!b.ok) throw new Error(b.err || ('не собралось: ' + what)); return b.fn; };

const B_fresh = build('ghIndexState', () => new Function('ghIndexBuilding', `${freshSrc}\nreturn ghIndexState;`)(() => false));
const B_snap = build('ghSnapHealth', () => new Function('gsl', 'account', 'fresh',
    `${snapSrc}\nreturn ghSnapHealth(gsl, account, fresh);`));
const B_keys = build('handleGhKeys', () => new Function('deps', `
    const { jsonRes, ghLoad, ghUsageMap, ghSessionLib, ghIndexState, ghRebuildIndex, ghSnapHealth, logLine } = deps;
    ${keysSrc}
    return handleGhKeys;`));
const B_badge = build('newapiGhBadge', () => new Function('s', 'prov', 'state', 'esc',
    `${badgeSrc}\nreturn newapiGhBadge(s, prov);`));
// Константы повтора берём из самой страницы, а не переписываем в тесте: иначе проверка
// перестанет замечать, что потолок сняли или паузу сделали нулевой.
const RETRY_MS = Number((HTML.match(/const GH_INDEX_RETRY_MS = (\d+)/) || [])[1]);
const RETRY_MAX = Number((HTML.match(/const GH_INDEX_RETRY_MAX = (\d+)/) || [])[1]);
const B_load = build('loadGhKeys', () => new Function('deps', `
    const { fetch, state, $, esc, ghRenderGrid, toast, setTimeout } = deps;
    let _ghIndexRetries = 0;
    const GH_INDEX_RETRY_MS = ${Number.isFinite(RETRY_MS) ? RETRY_MS : 4000};
    const GH_INDEX_RETRY_MAX = ${Number.isFinite(RETRY_MAX) ? RETRY_MAX : 6};
    ${loadSrc}
    return { loadGhKeys, retries: () => _ghIndexRetries };`));

ok('источники для проверки вырезаются', () => {
    assert.ok(freshSrc, 'нет ghIndexState в transparent-proxy.js');
    assert.ok(snapSrc, 'нет ghSnapHealth');
    assert.ok(keysSrc, 'нет handleGhKeys');
    assert.ok(badgeSrc, 'нет newapiGhBadge в странице');
    assert.ok(loadSrc, 'нет loadGhKeys в странице');
});

const stubGsl = (o = {}) => Object.assign({
    readCache: () => null, transferableProfile: () => null,
    cacheAgeMs: () => Infinity, cacheStale: () => null,
    // cacheLive — годность снимка по сроку ЕГО куки (19.09); в ответе ghSnapInfo это snapLive.
    cacheLive: () => null,
}, o);

ok('свежесть индекса считается по stat, без расшифровки', () => {
    const fresh = need(B_fresh);
    const freshOne = fresh({ indexInfo: () => ({ exists: true, count: 228, ageMs: 1000 }), indexOutdatedDirs: () => [] });
    assert.strictEqual(freshOne.fresh, true, 'ни одного расхождения по mtime - индекс свежий');
    const stale = fresh({ indexInfo: () => ({ exists: true, count: 228, ageMs: 1000 }), indexOutdatedDirs: () => ['a', 'b'] });
    assert.strictEqual(stale.fresh, false, 'два профиля разошлись - индекс устарел');
    assert.strictEqual(stale.outdated, 2);
    const none = fresh({ indexInfo: () => ({ exists: false, count: 0, ageMs: Infinity }), indexOutdatedDirs: () => ['a'] });
    assert.strictEqual(none.fresh, false, 'индекса нет - он не свежий');
    assert.strictEqual(none.exists, false);
});

ok('устаревший индекс: «не знаю», а не «сессии нет»', () => {
    const snap = need(B_snap);
    const h = snap(stubGsl(), { id: 'gh_1', login: 'stupidread', nickname: 'stupidread' }, false);
    assert.strictEqual(h.hasSession, null, 'на устаревшем индексе отсутствие записи - незнание');
    assert.strictEqual(h.indexStale, true, 'и это названо отдельным полем');
    assert.notStrictEqual(h.hasSession, false, 'false означал бы доказанное отсутствие');
});

ok('устаревший индекс не мешает положительному ответу', () => {
    const snap = need(B_snap);
    const gsl = stubGsl({
        readCache: () => ({ ghLogin: 'stupidread', harvestedAt: new Date().toISOString() }),
        cacheAgeMs: () => 60000, cacheStale: () => false, cacheLive: () => true,
    });
    const h = snap(gsl, { id: 'gh_1', login: 'stupidread', nickname: 'stupidread' }, false);
    assert.strictEqual(h.hasSession, true, 'снимок найден - это факт, его устаревший индекс не отменяет');
    assert.strictEqual(h.indexStale, false, 'краснеть и проверяться тут нечего');
});

ok('свежий индекс: пустой поиск - доказанное «сессии нет»', () => {
    const snap = need(B_snap);
    const h = snap(stubGsl(), { id: 'gh_1', login: 'x', nickname: 'x' }, true);
    assert.strictEqual(h.hasSession, false, 'свежий индекс имеет право сказать «нет»');
    assert.strictEqual(h.indexStale, false);
});

ok('список сам запускает пересборку устаревшего индекса', () => {
    const build_ = need(B_keys);
    const rebuilt = []; const seen = []; let idxCalls = 0;
    const handler = build_({
        jsonRes: (res, code, body) => { res.body = body; res.code = code; },
        ghLoad: () => [{ id: 'gh_1', login: 'stupidread', nickname: 'stupidread' }],
        ghUsageMap: () => ({}),
        ghSessionLib: () => stubGsl(),
        // Заодно проверяем, что свежесть ДОЕЗЖАЕТ до расчёта здоровья: без неё он снова
        // начнёт утверждать «сессии нет» на устаревшем индексе.
        ghSnapHealth: (gsl, account, fresh) => { seen.push(fresh); return { hasSession: fresh ? false : null, indexStale: !fresh }; },
        ghIndexState: () => { idxCalls++; return { fresh: false, exists: true, outdated: 3, building: false }; },
        ghRebuildIndex: (reason) => { rebuilt.push(reason); return { started: true }; },
        logLine: () => {},
    });
    const res = {};
    return handler({ url: '/__switch/api/gh/keys' }, res).then(() => {
        assert.strictEqual(res.code, 200, 'ответ без ошибки: ' + JSON.stringify(res.body));
        assert.strictEqual(rebuilt.length, 1, 'устаревший индекс обязан запустить пересборку: ' + JSON.stringify(rebuilt));
        assert.strictEqual(res.body.indexFresh, false, 'срез честно говорит, что индекс не свежий');
        assert.strictEqual(res.body.keys[0].indexStale, true);
        assert.strictEqual(idxCalls, 1, 'свежесть считается один раз на запрос');
        assert.deepStrictEqual(seen, [false], 'в расчёт здоровья уехала та же свежесть: ' + JSON.stringify(seen));
    });
});

ok('свежий индекс пересборку не запускает', () => {
    const build_ = need(B_keys);
    const rebuilt = [];
    const handler = build_({
        jsonRes: (res, code, body) => { res.body = body; res.code = code; },
        ghLoad: () => [{ id: 'gh_1', login: 'x', nickname: 'x' }],
        ghUsageMap: () => ({}),
        ghSessionLib: () => stubGsl(),
        ghSnapHealth: (gsl, account, fresh) => ({ hasSession: fresh ? false : null, indexStale: !fresh }),
        ghIndexState: () => ({ fresh: true, exists: true, outdated: 0, building: false }),
        ghRebuildIndex: (r) => { rebuilt.push(r); return {}; },
        logLine: () => {},
    });
    const res = {};
    return handler({ url: '/__switch/api/gh/keys' }, res).then(() => {
        assert.strictEqual(rebuilt.length, 0, 'свежий индекс трогать не надо');
        assert.strictEqual(res.body.indexFresh, true);
        assert.strictEqual(res.body.indexBuilding, false, 'сборка не идёт и не нужна');
    });
});

ok('бейдж на устаревшем индексе - «проверяется», а не красное «сессии нет»', () => {
    const badge = need(B_badge);
    const gh = { id: 'gh_1', login: 'stupidread', nickname: 'stupidread', status: 'live', hasSession: null, indexStale: true };
    const html = badge({ ghId: 'gh_1', api_key: 'sk-1' }, 'ar', { github: [gh] }, s => String(s));
    assert.ok(!/crimson/.test(html), 'красного быть не должно: ' + html);
    assert.ok(/amber/.test(html), 'это состояние ожидания: ' + html);
    assert.ok(/пересобира/.test(html) && /провер/.test(html),
        'подсказка обязана сказать, что идёт проверка после пересборки: ' + html);
    assert.ok(!/сессии нет/.test(html), 'утверждать отсутствие сессии нечем');
});

ok('бейдж со свежим индексом по-прежнему краснеет на доказанном отсутствии', () => {
    const badge = need(B_badge);
    const gh = { id: 'gh_1', login: 'x', nickname: 'x', status: 'live', hasSession: false, indexStale: false };
    const html = badge({ ghId: 'gh_1', api_key: 'sk-1' }, 'ar', { github: [gh] }, s => String(s));
    assert.ok(/crimson/.test(html), 'доказанное отсутствие остаётся красным: ' + html);
    assert.ok(/сессии нет/.test(html), 'и это по-прежнему сказано словами');
});

ok('бейдж с живой сессией остаётся бирюзовым', () => {
    const badge = need(B_badge);
    const gh = { id: 'gh_1', login: 'x', nickname: 'x', status: 'live', hasSession: true, sessionSource: 'profile', profileSource: 'ar:acct_1' };
    const html = badge({ ghId: 'gh_1', api_key: 'sk-1' }, 'ar', { github: [gh] }, s => String(s));
    assert.ok(/teal/.test(html), 'живая сессия не должна краснеть: ' + html);
    assert.ok(/профиле ar:acct_1/.test(html), 'источник назван: ' + html);
});

ok('список сам повторит запрос, пока идёт пересборка', () => {
    const timers = [];
    const api = need(B_load)({
        fetch: async () => ({ ok: true, json: async () => ({ keys: [], usage: {}, indexBuilding: true, indexFresh: false }) }),
        state: { github: [], loaded: { github: false } },
        $: () => ({ innerHTML: '', textContent: '', classList: { toggle: () => {} } }),
        esc: s => String(s), ghRenderGrid: () => {}, toast: () => {},
        setTimeout: (fn, ms) => { timers.push(ms); return 0; },
    });
    return api.loadGhKeys().then(() => {
        assert.strictEqual(timers.length, 1, 'пока сборка идёт - назначен ровно один повтор: ' + JSON.stringify(timers));
        assert.ok(timers[0] >= 1000 && timers[0] <= 15000, 'повтор не мгновенный и не через минуту: ' + timers[0]);
        return api.loadGhKeys();
    }).then(() => {
        assert.strictEqual(timers.length, 2, 'повторы идут по одному на загрузку, без лавины: ' + timers.length);
    }).then(() => {
        // Потолок: пока сборка не закончилась, повторы не бесконечны.
        let n = 0;
        const cap = Number.isFinite(RETRY_MAX) ? RETRY_MAX : 6;
        const spin = () => (++n > cap + 2 ? Promise.resolve() : api.loadGhKeys().then(spin));
        return spin().then(() => {
            assert.ok(api.retries() <= cap, 'счётчик повторов не растёт выше потолка: ' + api.retries());
        });
    });
});

ok('после свежего ответа счётчик повторов обнуляется', () => {
    const api = need(B_load)({
        fetch: async () => ({ ok: true, json: async () => ({ keys: [], usage: {}, indexBuilding: false, indexFresh: true }) }),
        state: { github: [], loaded: { github: false } },
        $: () => ({ innerHTML: '', textContent: '', classList: { toggle: () => {} } }),
        esc: s => String(s), ghRenderGrid: () => {}, toast: () => {}, setTimeout: () => 0,
    });
    return api.loadGhKeys().then(() => {
        assert.strictEqual(api.retries(), 0, 'свежий индекс освобождает счётчик');
    });
});

ok('в пути списка нет расшифровки профилей', () => {
    const heavy = /scanProfiles\(|warmAesKeys|execFileSync\(['"]powershell|readProfileCookies\(/;
    assert.ok(!heavy.test(keysSrc), 'обработчик не имеет права звать DPAPI-скан');
    assert.ok(!heavy.test(loadSrc), 'страница тем более');
    assert.ok(!/scanProfiles\(/.test(badgeSrc), 'бейдж читает только готовые поля');
});

finish();

