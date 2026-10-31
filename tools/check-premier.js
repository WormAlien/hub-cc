'use strict';
// Premier: regressions use the real dashboard helpers without live requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log('OK ' + name); passed++; }
    catch (e) { console.error('FAIL ' + name + ': ' + e.message); failed++; }
}
function source(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n'); }
function keyCheck(file) {
    const match = source(file).match(/function isRealKey\(k\)\s*\{[\s\S]*?;\s*\}/);
    assert.ok(match, 'isRealKey exists');
    return vm.runInNewContext('(' + match[0] + ')');
}
for (const file of ['routing/transparent-proxy.js', 'routing/proxy-dashboard.html']) {
    test(file + ' accepts Premier keys', () => {
        const check = keyCheck(file);
        assert.equal(check('prm_' + 'A'.repeat(43)), true);
        assert.equal(check('no-key-placeholder'), false);
        assert.equal(check('prm_'), false);
        assert.equal(check('prm_' + 'A'.repeat(43) + '!'), false);
        assert.equal(check('sk-test'), true);
        assert.equal(check('vani_' + 'b'.repeat(64)), true);
    });
}
const apiFile = path.join(ROOT, 'routing/lib/premier-api.js');
let api = null;
test('Premier quota adapter exists', () => {
    assert.ok(fs.existsSync(apiFile), 'missing premier-api.js');
    api = require(apiFile);
});
if (api) {
    const now = Date.parse('2026-10-23T01:00:00Z');
    // Live /api/dev/state (23.10.2026) returns user.name/email only - no user.id.
    const state = { user: { name: 'owner', email: 'Owner@Example.com' }, plan: { name: 'Free' }, usage: { limit: 50, used: 13, resets_at: Date.parse('2026-10-23T21:00:00Z') } };
    test('server quota preserves message units and Moscow reset', () => {
        const q = api.normalizeState(state, now);
        assert.equal(q.remaining, 37); assert.equal(q.limit, 50); assert.equal(q.used, 13);
        assert.equal(q.unit, 'messages'); assert.equal(q.resetAt, '2026-10-23T21:00:00.000Z');
        assert.equal(q.accountId, 'email:owner@example.com'); assert.equal(q.plan, 'Free');
    });
    test('account identity falls back to id and prefers email', () => {
        assert.equal(api.accountIdentity({ user: { id: 7 } }), 'id:7');
        assert.equal(api.accountIdentity({ user: { id: 7, email: 'a@b.c' } }), 'email:a@b.c');
        assert.equal(api.accountIdentity({ user: { name: 'no-id-no-email' } }), null);
        assert.equal(api.normalizeState({ ...state, user: { id: 7 } }, now).accountId, 'id:7');
    });
    test('missing usage is unknown, not a free 50 messages', () => {
        assert.equal(api.normalizeState({ user: state.user }, now), null);
        assert.equal(api.normalizeState({ ...state, usage: { used: '13', limit: 50 } }, now), null);
        assert.equal(api.normalizeState({ ...state, usage: { used: 0 } }, now), null);
    });
    test('quota is bound only to a key listed by the same account', () => {
        const key = 'prm_' + 'q'.repeat(43);
        const mask = api.maskKey(key);
        assert.equal(mask, 'prm_qqq\u2026qqqq');
        const keys = [{ id: 'k1', hint: mask }, { id: 'k2', hint: 'prm_zzz\u2026zzzz' }];
        const b = api.keyBindingFrom('email:owner@example.com', keys, key, now);
        assert.equal(b.keyId, 'k1'); assert.equal(b.accountId, 'email:owner@example.com');
        assert.equal(b.hint, mask);
        assert.notEqual(b.fingerprint, key, 'the secret is never stored twice');
        const q = api.normalizeState(state, now);
        assert.equal(api.bindingMatches(b, key, q), true);
        assert.equal(api.bindingMatches(b, 'prm_' + 'w'.repeat(43), q), false);
        assert.equal(api.keyBindingFrom('email:owner@example.com', [{ id: 'k9', hint: 'prm_aaa\u2026aaaa' }], key), null);
        assert.equal(api.keyBindingFrom('email:owner@example.com', [{ id: 'k1', hint: mask }, { id: 'k2', hint: mask }], key), null);
        assert.equal(api.keyBindingFrom('email:owner@example.com', keys, 'no-key-placeholder'), null);
        assert.equal(api.keyBindingFrom(null, keys, key), null);
    });
    test('unlimited quota differs from missing limit', () => {
        const q = api.normalizeState({ ...state, usage: { ...state.usage, limit: null } }, now);
        assert.equal(q.limit, null); assert.equal(q.remaining, null); assert.equal(q.unlimited, true);
    });
    test('zero messages is valid and expires at the server reset', () => {
        const q = api.normalizeState({ ...state, usage: { ...state.usage, used: 55 } }, now);
        assert.equal(q.remaining, 0);
        assert.equal(api.quotaFresh(q, now + 1000), true);
        assert.equal(api.quotaFresh(q, Date.parse(q.resetAt)), false);
        assert.equal(api.quotaFresh(q, now + 10 * 60 * 1000), false);
    });
    test('GitHub-only state cannot prove Premier login', () => {
        assert.equal(api.isAuthenticated({ user: null, github: true }), false);
        assert.equal(api.isAuthenticated({ user: {} }), false);
        assert.equal(api.isAuthenticated({ user: { id: 7 } }), true);
        assert.equal(api.isAuthenticated({ user: { email: 'a@b.c' } }), true);
        assert.equal(api.isAuthenticated({ user: { name: 'only-name' } }), false);
    });
    test('quota failures preserve key status and old reading without USD', () => {
        const q = api.normalizeState(state, now);
        const row = { status: 'live', quota: q, balance: 37, granted: 50 };
        api.applyResult(row, { error: 'login required', authRequired: true }, now + 1000);
        assert.equal(row.status, 'live'); assert.equal(row.quota, q);
        assert.equal(row.quotaError, 'login required'); assert.equal(row.authRequired, true);
        assert.equal(row.balance, undefined); assert.equal(row.granted, undefined);
    });
    test('an unproven reading is dropped instead of kept as a number', () => {
        const key = 'prm_' + 'q'.repeat(43);
        const q = api.normalizeState(state, now);
        const b = api.keyBindingFrom(q.accountId, [{ id: 'k1', hint: api.maskKey(key) }], key, now);
        const row = { status: 'live', api_key: key, quota: q, quotaBinding: b };
        api.applyResult(row, { unverified: true, error: 'владелец квоты не подтверждён' }, now + 1000);
        assert.equal(row.quota, undefined); assert.equal(row.quotaBinding, undefined);
        assert.match(row.quotaError, /владелец/); assert.equal(row.status, 'live');
    });
    test('applying zero quota does not kill a working key', () => {
        const row = { status: 'live' };
        const q = api.normalizeState({ ...state, usage: { ...state.usage, used: 50 } }, now);
        api.applyResult(row, { quota: q }, now);
        assert.equal(row.status, 'live'); assert.equal(row.quota.remaining, 0);
    });
    test('cookie header excludes Github and lookalike domains', () => {
        const cookie = api.siteCookieHeader([
            { domain: '.ide.kgpix.bond', name: 'sid', value: 'yes' },
            { domain: 'github.com', name: 'user_session', value: 'no' },
            { domain: 'ide.kgpix.bond.attacker.test', name: 'sid', value: 'no' },
            { domain: 'ide.kgpix.bond', name: 'old', value: 'no', expires: now / 1000 - 1 },
        ], now);
        assert.equal(cookie, 'sid=yes');
    });
    // 29.10.2026: Premier логинит новых на второй домен eide.pro, старый kgpix остался.
    // Кука доменно-Scoped: заголовок собирается только из домена, где лежит
    // premier_session, чужие куки того же jar не подмешиваются.
    test('cookie header picks the eide.pro session when kgpix has none', () => {
        const cookie = api.siteCookieHeader([
            { domain: 'github.com', name: 'user_session', value: 'gh' },
            { domain: 'eide.pro', name: 'premier_session', value: 'new' },
            { domain: 'ide.kgpix.bond', name: 'premier_lang', value: 'ru' },
        ], now);
        assert.equal(cookie, 'premier_session=new');
    });
    test('both domains are declared, old origin stays exported', () => {
        assert.ok(api.HOSTS.includes('ide.kgpix.bond'));
        assert.ok(api.HOSTS.includes('eide.pro'));
        assert.equal(api.ORIGIN, 'https://ide.kgpix.bond');
        assert.ok(api.ORIGINS.includes('https://eide.pro'));
    });
}
test('Premier message billing disables hedged duplicate requests', () => {
    const match = source('routing/keepalive-proxy.js').match(/const FLAT_RATE_HOSTS = new Set\((\[[^;]+\])\);/);
    assert.ok(match);
    assert.ok(vm.runInNewContext(match[1]).includes('ide.kgpix.bond'));
});
test('Premier is excluded from USD totals in both summaries', () => {
    const front = source('routing/proxy-dashboard.html').split('\n').find(l => l.includes("id: 'premier'") && l.includes('stateKey:'));
    assert.ok(front && front.includes('noMoney: true'));
    const row = require('../internal/hub-balance').POOLS.find(p => p.id === 'pm');
    assert.ok(row && row.noMoney);
});
test('message meters distinguish unknown and exhausted quotas', () => {
    const html = source('routing/proxy-dashboard.html');
    const start = html.indexOf('function pmQuotaFresh('), end = html.indexOf('\nasync function loadPmSessions', start);
    assert.ok(start >= 0 && end > start, 'Premier quota UI missing');
    const sandbox = { Date, isRealKey: keyCheck('routing/proxy-dashboard.html') };
    vm.createContext(sandbox); vm.runInContext(html.slice(start, end), sandbox);
    const key = 'prm_' + 'x'.repeat(43), checkedAt = new Date().toISOString();
    const quota = { unit: 'messages', accountId: '7', checkedAt, limit: 50, used: 50, remaining: 0, resetAt: new Date(Date.now() + 3600000).toISOString() };
    let st = sandbox.pmPoolStats([{ api_key: key, status: 'live' }]);
    assert.equal(st.known, 0); assert.equal(st.unknown, 1); assert.equal(st.remPct, null);
    st = sandbox.pmPoolStats([{ api_key: key, status: 'live', quota }]);
    assert.equal(st.remaining, 0); assert.equal(st.limit, 50); assert.equal(st.remPct, 0);
    st = sandbox.pmPoolStats([{ api_key: key, status: 'live', quota }, { api_key: key + 'y', status: 'live', quota }]);
    assert.equal(st.limit, 50, 'two keys of one account must not double its quota');
    assert.equal(sandbox.pmQuotaFresh({ ...quota, resetAt: '2026-01-01T00:00:00Z' }), false);
});
test('daily message exhaustion is not a retryable 429', () => {
    const code = source('routing/keepalive-proxy.js');
    const rules = code.slice(code.indexOf('const RETRY_NO ='), code.indexOf('// ── ПУЛ НАЛИВКИ'));
    const start = code.indexOf('function isTransientBody('), end = code.indexOf('\n}\n', start) + 2;
    const sandbox = { structuredRetry: () => null, retryAfterSec: () => null, log: () => {} };
    vm.createContext(sandbox); vm.runInContext(rules + '\n' + code.slice(start, end), sandbox);
    assert.equal(sandbox.isTransientBody(429, Buffer.from('{"error":{"message":"Daily message limit reached; it resets at 00:00 Moscow time."}}')), false);
    assert.equal(sandbox.isTransientBody(429, Buffer.from('Too many requests, retry later')), true);
});
test('message quota sorting does not depend on dollar balances', () => {
    const html = source('routing/proxy-dashboard.html');
    const marker = 'function pmQuotaCompare(';
    const start = html.indexOf(marker), end = html.indexOf('\n}\n', start) + 2;
    assert.ok(start >= 0, 'message quota comparator missing');
    const box = { pmQuotaFresh: q => !!q };
    vm.createContext(box); vm.runInContext(html.slice(start, end), box);
    const a = { quota: { remaining: 0 } }, b = { quota: { remaining: 30 } };
    assert.ok(box.pmQuotaCompare(a, b, 'bal-asc') < 0);
    assert.ok(box.pmQuotaCompare(a, b, 'bal-desc') > 0);
    assert.ok(box.pmQuotaCompare({}, b, 'bal-asc') > 0);
});
test('gateway generator anchors message billing to the right registry', () => {
    const spec = JSON.parse(source('tools/gateways.spec.json'));
    assert.equal(spec.points.find(p => p.id === '3.2').within, 'const FLAT_RATE_HOSTS');
    assert.equal(spec.inserts['3.2'].mode, 'inline');
});
test('prefix routing has a default actual model', () => {
    const map = JSON.parse(source('routing/premier-routes-modelmap.json'));
    // 🪤 Раньше здесь стояла литеральная модель (`qwen3.8-max-0902`), и тест краснел
    // 25.10, когда владелец перевёл тиры на Flash: он кодировал выбор, а не свойство.
    // Свойство, которое обязано держаться, - `default` это РЕАЛЬНАЯ модель шлюза, а не
    // имя тира: иначе префиксный запрос уходит в никуда.
    assert.equal(typeof map.default, 'string');
    assert.ok(map.default.trim().length > 0, 'default пуст');
    assert.ok(!/^(opus|sonnet|haiku)$/i.test(map.default), 'default не должен быть именем тира');
    assert.ok(!/^claude[-_]/i.test(map.default), 'default не должен быть claude-тиром клиента');
});
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name, fn }); }
let session = null;
test('Premier browser module can be loaded without launching a browser', () => {
    const file = path.join(ROOT, 'premier/open-session.js');
    assert.ok(fs.existsSync(file), 'missing open-session.js');
    session = require(file);
});
if (session) testAsync('session import scopes cookies and localStorage to their own origin', async () => {
    let cookies = [], script = null, arg = null;
    const context = {
        addCookies: async list => { cookies = list; },
        addInitScript: async (fn, payload) => { script = fn; arg = payload; },
    };
    await session.applyImportedSession(context, {
        seed: 'github', cookies: [
            { domain: 'github.com', name: 'user_session', value: 'owned-session', path: '/', secure: true, httpOnly: true },
            { domain: 'other.test', name: 'secret', value: 'no', path: '/' },
        ], origins: [
            { origin: 'https://github.com', localStorage: [{ name: 'owned', value: 'yes' }] },
            { origin: 'https://other.test', localStorage: [{ name: 'secret', value: 'no' }] },
        ],
    });
    assert.equal(cookies.length, 1); assert.equal(cookies[0].httpOnly, true);
    const run = origin => {
        const stored = {};
        vm.runInNewContext('(' + script.toString() + ')(payload)', { payload: arg, location: { origin }, localStorage: { setItem: (k, v) => { stored[k] = v; } } });
        return stored;
    };
    assert.deepEqual(run('https://github.com'), { owned: 'yes' });
    assert.deepEqual(run('https://ide.kgpix.bond'), {});
});
if (api) {
    testAsync('quota probe tries each domain with its own cookie and takes the 200', async () => {
    const key = 'prm_' + 'z'.repeat(43);
    const seen = [];
    const r = await api.fetchQuota([
        { origin: 'https://ide.kgpix.bond', cookie: 'premier_lang=ru' },
        { origin: 'https://eide.pro', cookie: 'premier_session=new' },
    ], { apiKey: key, fetchImpl: async (url, opts) => {
        seen.push([url, opts.headers.Cookie]);
        if (url.startsWith('https://ide.kgpix.bond')) return { status: 401, ok: false };
        return { status: 200, ok: true, json: async () => ({
            user: { email: 'a@b.c' }, keys: [{ id: 'k1', hint: api.maskKey(key) }],
            usage: { used: 2, limit: 50 },
        }) };
    }});
    assert.deepEqual(seen[0], ['https://ide.kgpix.bond/api/dev/state', 'premier_lang=ru']);
    assert.deepEqual(seen[1], ['https://eide.pro/api/dev/state', 'premier_session=new']);
    assert.equal(r.quota.remaining, 48);
    assert.equal(r.binding.keyId, 'k1');
});
testAsync('a single string header is still probed against every domain', async () => {
    const key = 'prm_' + 'z'.repeat(43);
    const r = await api.fetchQuota('premier_session=new', { apiKey: key, fetchImpl: async url => {
        if (url.startsWith('https://ide.kgpix.bond')) return { status: 401, ok: false };
        return { status: 200, ok: true, json: async () => ({
            user: { email: 'a@b.c' }, keys: [{ id: 'k1', hint: api.maskKey(key) }],
            usage: { used: 1, limit: 50 },
        }) };
    }});
    assert.equal(r.quota.remaining, 49);
});
    testAsync('quota request sends cookies only to the fixed destination', async () => {
        const key = 'prm_' + 'z'.repeat(43);
        const r = await api.fetchQuota('sid=owned', { apiKey: key, fetchImpl: async (url, opts) => {
            assert.equal(url, 'https://ide.kgpix.bond/api/dev/state');
            assert.equal(opts.headers.Cookie, 'sid=owned'); assert.equal(opts.redirect, 'error');
            return { status: 200, ok: true, json: async () => ({
                user: { email: 'a@b.c' }, keys: [{ id: 'k1', hint: api.maskKey(key) }],
                usage: { used: 1, limit: 50 },
            }) };
        }});
        assert.equal(r.quota.remaining, 49);
        assert.equal(r.binding.keyId, 'k1');
    });
    testAsync('a key missing from the account list gives unknown, not its quota', async () => {
        const key = 'prm_' + 'z'.repeat(43);
        const r = await api.fetchQuota('sid=owned', { apiKey: key, fetchImpl: async () => ({
            status: 200, ok: true, json: async () => ({
                user: { email: 'a@b.c' }, keys: [{ id: 'other', hint: 'prm_aaa\u2026aaaa' }],
                usage: { used: 1, limit: 50 },
            }) }),
        });
        assert.equal(r.quota, undefined); assert.equal(r.unverified, true);
        assert.match(r.error, /владелец/);
    });
    testAsync('a state without a live account shape is not guessed', async () => {
        const key = 'prm_' + 'z'.repeat(43);
        const r = await api.fetchQuota('sid=owned', { apiKey: key, fetchImpl: async () => ({
            status: 200, ok: true, json: async () => ({ user: { name: 'no-id' }, keys: [{ id: 'k1', hint: api.maskKey(key) }], usage: { used: 1, limit: 50 } }),
        }) });
        assert.equal(r.quota, undefined); assert.equal(r.unverified, true);
    });
    testAsync('a replaced key drops the old reading before any request', async () => {
        const oldKey = 'prm_' + 'a'.repeat(43), newKey = 'prm_' + 'b'.repeat(43);
        const at = Date.parse('2026-10-23T01:00:00Z');
        const q = api.normalizeState({ user: { email: 'old@example.com' }, usage: { used: 1, limit: 50 } }, at);
        const b = api.keyBindingFrom(q.accountId, [{ id: 'k1', hint: api.maskKey(oldKey) }], oldKey, at);
        const row = { id: 'x!', api_key: newKey, quota: q, quotaBinding: b };
        const r = await api.readQuota(row, {});
        assert.equal(row.quota, undefined); assert.equal(row.quotaBinding, undefined);
        assert.equal(r.authRequired, true);
    });
    test('maskKey knows both live key formats', () => {
        // prm_ - аккаунты пула (3 символа до многоточия), sk-premier- - старые кабинеты,
        // у владельца в списке только такой (7 символов, живой замер 31.10).
        assert.equal(api.maskKey('prm_' + 'z'.repeat(43)), 'prm_zzz…zzzz');
        assert.equal(api.maskKey('sk-premier-' + 'c'.repeat(40)), 'sk-premier-ccccccc…cccc');
        assert.equal(api.maskKey('sk-other-key-abcdefghijklmnop'), null);
        assert.equal(api.maskKey(''), null);
    });
    testAsync('cookieless domain 401 does not mask the sessioned domain diagnosis', async () => {
        // Живой дефект 31.10: eide.pro (сессия жива) отвечал «ключ не в списке», а
        // без-куковый kgpix перезаписывал это «Сессия истекла» - владелец видел «войди
        // заново», будучи залогинен. Ошибку домена с premier_session приоритизируем.
        const r = await api.fetchQuota([
            { origin: 'https://eide.pro', cookie: 'premier_session=live' },
            { origin: 'https://ide.kgpix.bond', cookie: 'premier_lang=ru' },
        ], { apiKey: 'prm_' + 'z'.repeat(43), fetchImpl: async (url) => {
            if (url.startsWith('https://eide.pro')) return { status: 200, ok: true, json: async () => ({
                user: { email: 'a@b.c' }, keys: [{ id: 'k1', hint: 'prm_aaa…aaaa' }], usage: { used: 1, limit: 50 } }) };
            return { status: 401, ok: false };
        }});
        assert.equal(r.authRequired, undefined, '401 без-кукового домена не должен стать вердиктом');
        assert.equal(r.unverified, true);
        assert.match(r.error, /владелец/);
    });
    for (const code of [401, 403, 429, 503]) testAsync('quota HTTP ' + code + ' never declares an API key dead', async () => {
        const r = await api.fetchQuota('sid=owned', { fetchImpl: async () => ({ status: code, ok: false }) });
        assert.equal(r.status, undefined); assert.equal(!!r.authRequired, code === 401);
        assert.ok(r.error);
    });
}
function backendFunction(name) {
    const code = source('routing/transparent-proxy.js');
    const start = code.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
    const end = code.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, 'missing handler ' + name);
    return code.slice(start, end);
}
testAsync('quota refresh preserves accounts added while the request was pending', async () => {
    const key = 'prm_' + 'a'.repeat(43);
    let store = [{ id: 'pm_first', api_key: key, status: 'live' }];
    const box = {
        URL, LISTEN_PORT: 8200,
        pmLoad: () => JSON.parse(JSON.stringify(store)), pmSave: list => { store = list; },
        pmBalance: async () => {
            store.push({ id: 'pm_added', api_key: 'prm_' + 'b'.repeat(43) });
            return { quota: { remaining: 37 } };
        },
        pmApplyBalance: (row, result) => { row.quota = result.quota; },
        jsonRes: () => {},
    };
    vm.createContext(box); vm.runInContext(backendFunction('handlePmBalance'), box);
    await box.handlePmBalance({ url: '/__switch/api/pm/balance?api_key=' + key }, {});
    assert.equal(store.length, 2, 'refresh must not save the stale pre-request pool');
    assert.equal(store[0].quota.remaining, 37);
});
testAsync('bulk refresh also preserves concurrently added accounts', async () => {
    let store = [{ id: 'pm_first', api_key: 'prm_' + 'a'.repeat(43), status: 'live' }];
    const box = {
        URL, LISTEN_PORT: 8200, jsonKeepalive: () => () => {},
        pmLoad: () => JSON.parse(JSON.stringify(store)), pmSave: list => { store = list; },
        pmBalance: async () => { store.push({ id: 'pm_added' }); return { quota: { remaining: 12 } }; },
        pmApplyBalance: (row, result) => { row.quota = result.quota; },
        pmReadActiveModel: () => null, jsonRes: () => {},
    };
    vm.createContext(box); vm.runInContext(backendFunction('handlePmSessions'), box);
    await box.handlePmSessions({ url: '/__switch/api/pm/sessions?balance=1' }, {});
    assert.equal(store.length, 2);
    assert.equal(store[0].quota.remaining, 12);
});
(async () => {
    for (const { name, fn } of asyncTests) {
        try { await fn(); console.log('OK ' + name); passed++; }
        catch (e) { console.error('FAIL ' + name + ': ' + e.message); failed++; }
    }
    console.log(`${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
})();
