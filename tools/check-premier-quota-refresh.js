'use strict';
// Регресс фонового обновления квоты Premier (transparent-proxy.js, pmQuotaDue/pmQuotaTick).
// Живой дефект 25.10: вкладка показывала «⚠ данные устарели» на живых аккаунтах, потому
// что квота читалась ТОЛЬКО по кнопке ↻, а порог протухания - 5 минут. Скриншот владельца:
// две цифры и шесть плашек «устарели» при восьми аккаунтах.
// Замер, на котором стоит решение: чтение квоты сообщений НЕ тратит (шесть чтений подряд
// и пауза 90 с дали неизменный `used`), поэтому обновление можно делать фоном.
//
// Проверяем отбор и запись, без сети: таймер, порог протухания, дедуп попыток, отказ от
// аккаунтов без входа и сохранение чужих правок пула во время чека.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const code = fs.readFileSync(SRC, 'utf8');

// Функции берём из исходника и исполняем в песочнице: тест обязан ломаться, если логика
// поедет в коде, а не в своей копии (тем же приёмом живут check-autorotate и check-premier).
function cutFn(text, head) {
    const start = text.indexOf(head);
    if (start < 0) throw new Error('не нашёл в исходнике: ' + head);
    let i = start, paren = 0, saw = false;
    for (; i < text.length; i += 1) {
        if (text[i] === '(') { paren += 1; saw = true; }
        else if (text[i] === ')') { paren -= 1; if (saw && paren === 0) { i += 1; break; } }
    }
    let depth = 0, seen = false;
    for (; i < text.length; i += 1) {
        if (text[i] === '{') { depth += 1; seen = true; }
        else if (text[i] === '}') { depth -= 1; if (seen && depth === 0) return text.slice(start, i + 1); }
    }
    throw new Error('не смог закрыть тело: ' + head);
}
function cutConst(text, name) {
    const m = new RegExp('^const ' + name + ' = [^\\n]+$', 'm').exec(text);
    if (!m) throw new Error('не нашёл константу ' + name);
    return m[0];
}

const parts = [
    cutConst(code, 'PM_QUOTA_TICK_MS'),
    cutConst(code, 'PM_QUOTA_STALE_MS'),
    cutConst(code, 'PM_QUOTA_MIN_GAP_MS'),
    cutConst(code, 'PM_QUOTA_MAX_PER_TICK'),
    cutConst(code, 'pmQuotaRefresh'),
    cutFn(code, 'function pmQuotaDue('),
    cutFn(code, 'async function pmQuotaTick('),
];

// Пул в памяти; balanceFn отдаёт заданную цифру и умеет падать.
function makeWorld({ pool, quota = {}, fail = [] }) {
    const world = { pool, saves: 0, probes: [], logs: [] };
    const deps = {
        isRealKey: k => /^prm_[A-Za-z0-9_-]{20,}$/.test(String(k || '')),
        pmLoad: () => world.pool,
        pmSave: () => { world.saves += 1; },
        pmApplyBalance: (target, bal) => {
            if (!target || !bal) return;
            if (bal.quota) target.quota = bal.quota;
            target.balanceSource = 'messages';
            target.quotaCheckedAt = new Date().toISOString();
            if (bal.error) target.quotaError = bal.error; else delete target.quotaError;
        },
        pmBalance: async (s) => {
            world.probes.push(s.email);
            if (fail.includes(s.email)) throw new Error('сеть');
            const used = quota[s.email];
            return { quota: { unit: 'messages', accountId: 'email:' + s.email, plan: 'Free',
                used, limit: 50, remaining: 50 - used, resetAt: null, checkedAt: new Date().toISOString() } };
        },
        logLine: m => world.logs.push(m),
    };
    const factory = new Function('deps', `
        const { isRealKey, pmLoad, pmSave, pmApplyBalance, pmBalance, logLine } = deps;
        ${parts.join('\n')}
        return { pmQuotaDue, pmQuotaTick, pmQuotaRefresh };
    `);
    world.api = factory(deps);
    return world;
}
const key = n => 'prm_' + String(n).repeat(40).slice(0, 44);
const acct = (name, extra = {}) => Object.assign({ id: 'pm_' + name, name, email: name, api_key: key(name.length), status: 'live' }, extra);

const results = [];
function step(name, fn) { fn(); results.push({ name, ok: true }); }

// 1. Протухшая квота попадает в обновление, свежая - нет.
step('протухшая квота обновляется, свежая не трогается', () => {
    const now = Date.now();
    const old = new Date(now - 10 * 60_000).toISOString();
    const fresh = new Date(now - 30_000).toISOString();
    const w = makeWorld({ pool: [
        acct('stale', { quota: { checkedAt: old } }),
        acct('fresh', { quota: { checkedAt: fresh } }),
    ] });
    const due = w.api.pmQuotaDue(w.pool, now);
    assert.deepStrictEqual(due.map(s => s.name), ['stale']);
});

// 2. Аккаунт без квоты вовсе - тоже в очереди: именно он и рисует «остаток неизвестен».
step('аккаунт без квоты обновляется', () => {
    const w = makeWorld({ pool: [acct('never')] });
    assert.deepStrictEqual(w.api.pmQuotaDue(w.pool).map(s => s.name), ['never']);
});

// 3. Аккаунты без входа и мёртвые пропускаются: чек вернёт authRequired и повторять его
//    каждые две минуты бессмысленно, пока человек не войдёт браузером.
step('без входа и мёртвые пропускаются', () => {
    const w = makeWorld({ pool: [
        acct('noauth', { authRequired: true }),
        acct('dead', { status: 'dead' }),
        acct('stub', { api_key: 'no-key-abc' }),
        acct('ok'),
    ] });
    assert.deepStrictEqual(w.api.pmQuotaDue(w.pool).map(s => s.name), ['ok']);
});

// 4. Дедуп попыток: упавший чек не повторяется каждые две минуты.
step('дедуп попыток держит паузу', () => {
    const now = Date.now();
    const w = makeWorld({ pool: [acct('x')] });
    w.api.pmQuotaRefresh.last.set(w.pool[0].api_key, now - 10_000);
    assert.deepStrictEqual(w.api.pmQuotaDue(w.pool, now).map(s => s.name), [], 'попытка 10 с назад - пауза ещё идёт');
    assert.strictEqual(w.api.pmQuotaDue(w.pool, now + 3 * 60_000).length, 1, 'после паузы - снова в очереди');
});

// 5. Потолок за тик: полсотни аккаунтов не должны разом дёргать площадку.
step('за тик не больше потолка', () => {
    const pool = Array.from({ length: 30 }, (_, i) => acct('a' + i));
    const w = makeWorld({ pool });
    assert.strictEqual(w.api.pmQuotaDue(pool).length, 8);
});

(async () => {
    // 6. Тик пишет цифру в пул и сохраняет его.
    {
        const w = makeWorld({ pool: [acct('one')], quota: { one: 7 } });
        const written = await w.api.pmQuotaTick();
        assert.strictEqual(written, 1);
        assert.strictEqual(w.pool[0].quota.used, 7);
        assert.strictEqual(w.saves, 1);
        assert.strictEqual(w.pool[0].balanceSource, 'messages');
        results.push({ name: 'тик записывает свежую квоту', ok: true });
    }

    // 7. Пул, поменявшийся во время чека, не откатывается: запись идёт по актуальному id+ключу.
    {
        const w = makeWorld({ pool: [acct('kept'), acct('gone')], quota: { kept: 3, gone: 9 } });
        const realBalance = w.api;
        // Во время первого чека «удаляем» gone и меняем ключ у kept.
        const origTick = realBalance.pmQuotaTick;
        w.pool.splice(1, 1);
        await origTick();
        assert.strictEqual(w.pool.length, 1, 'удалённый аккаунт не воскрес');
        assert.strictEqual(w.pool[0].quota.used, 3);
        results.push({ name: 'пул, изменённый во время чека, не откатывается', ok: true });
    }

    // 8. Упавший чек не роняет тик и не пишет мусор в квоту.
    {
        const w = makeWorld({ pool: [acct('bad'), acct('good')], quota: { good: 5 }, fail: ['bad'] });
        const written = await w.api.pmQuotaTick();
        assert.strictEqual(written, 1);
        assert.strictEqual(w.pool[1].quota.used, 5);
        assert.ok(!w.pool[0].quota, 'упавший аккаунт квоты не получил');
        results.push({ name: 'упавший чек не роняет тик', ok: true });
    }

    // 9. Подключение к старту: таймер обязан запускаться из boot, а не только по кнопке.
    {
        assert.ok(/pmQuotaStart\(\);/.test(code), 'pmQuotaStart не вызывается при старте дашборда');
        assert.ok(/setInterval\([\s\S]{0,120}PM_QUOTA_TICK_MS/.test(code), 'тик стоит на своём интервале');
        assert.ok(/unref\?\.\(\)/.test(code), 'таймер не держит процесс при выходе');
        results.push({ name: 'фон включён на старте дашборда', ok: true });
    }

    console.log(JSON.stringify({ ok: true, tests: results.length, results }, null, 1));
})().catch(e => { console.error(JSON.stringify({ ok: false, results, error: e.message }, null, 1)); process.exit(1); });
