#!/usr/bin/env node
// Метка профиля может указывать на МЁРТВЫЙ остаток — и тогда чек читает не тот каталог.
//
// 🔴 Замер 16.09 на живых аккаунтах. У трёх записей пула поле `profile` было `git_N`
// (остаток старого заселения), а рабочая папка, которую создаёт кнопка 🌐, называется
// `acct_<id>`. `newapiProfileDir` берёт каталог по метке, если он СУЩЕСТВУЕТ, — не
// проверяя, что там живая сессия. Существуют обе, резолв возвращал первую — мёртвую.
//
// Последствия ровно те, на которые жаловался владелец:
//   • из мёртвой папки приходил HTTP 401 → вердикт «разлогинен» на ЖИВОМ аккаунте;
//   • свежая цифра не приходила никогда — `selfCheckedAt` замер на 12.09;
//   • деньги показывались неправильно: $0.64 при $26.20 на счету.
//
// Лечение проверяется РЕЗУЛЬТАТОМ: метка живая — второй попытки нет вовсе.
//
// Запуск: node tools/check-profile-fallback.js
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routing', 'transparent-proxy.js'), 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};
function cutFn(text, head) {
    const start = text.indexOf(head);
    if (start < 0) throw new Error(`не нашёл: ${head}`);
    let i = start, paren = 0, saw = false;
    for (; i < text.length; i += 1) {
        const c = text[i];
        if (c === '(') { paren += 1; saw = true; }
        else if (c === ')') { paren -= 1; if (saw && paren === 0) { i += 1; break; } }
    }
    let depth = 0, seen = false;
    for (; i < text.length; i += 1) {
        const c = text[i];
        if (c === '{') { depth += 1; seen = true; }
        else if (c === '}') { depth -= 1; if (seen && depth === 0) return text.slice(start, i + 1); }
    }
    throw new Error(`не закрыл тело: ${head}`);
}

const body = cutFn(src, 'async function newapiBalance(');
const QPU = 500000;

const DEAD = 'C:/fake/profiles/git_1';
const REAL = 'C:/fake/profiles/acct_ar_1';

function makeWorld(opts = {}) {
    const world = { selfDirs: [], logs: [], syncCalls: 0 };
    const deps = {
        logLine: (m) => world.logs.push(String(m)),
        isRealKey: (k) => /^sk-/.test(String(k || '').trim()),
        round2: (v) => Math.round(Number(v) * 100) / 100,
        newapiLib: () => ({
            quotaPerUnit: async () => QPU,
            quotaToUsd: (q, qpu) => (q == null || !isFinite(q) ? null : Math.round((Number(q) / (qpu || QPU)) * 100) / 100),
            accountSelf: async (o) => {
                const dir = o && o.profileDir;
                world.selfDirs.push(dir);
                if (opts.selfByDir) return opts.selfByDir(dir) || { ok: false, error: 'нет ответа для этого каталога' };
                return opts.selfAnswer || { ok: false, error: 'заглушка: сюда заходить не должны' };
            },
            warmAesKeys: () => ({ warmed: 0, failed: 0 }),
            cookieDbLocked: () => false,
        }),
        newapiWarmProfileKeys: () => {},
        // Резолв метки: как в бою — сначала `profile`, и только потом `acct_<id>`.
        newapiResolveProfile: () => ({ label: opts.resolveLabel || 'git_1', dir: opts.resolveDir || DEAD }),
        // Каталог по метке существует только там, где его назвал тест.
        newapiProfileDir: (host, label) => (opts.dirs && opts.dirs[label]) || null,
        newapiLkOpenedAt: () => 0,
        newapiLkBusy: () => false,
        newapiSyncProfile: () => { world.syncCalls += 1; },
        fetch: async (url) => (String(url).includes('/usage')
            ? { status: 200, json: async () => ({ total_usage: 0 }) }
            : { status: 200, json: async () => ({ access_until: 0 }) }),
        AbortSignal: { timeout: () => undefined },
    };
    const factory = new Function('deps', `
        const { logLine, isRealKey, round2, newapiLib, newapiWarmProfileKeys, newapiResolveProfile,
                newapiProfileDir, newapiLkOpenedAt, newapiLkBusy, newapiSyncProfile, fetch, AbortSignal } = deps;
        ${body}
        return newapiBalance;
    `);
    world.run = (target) => factory(deps)({
        target,
        host: 'agentrouter.org',
        ccHeaders: {},
        usageUrl: 'https://x/dashboard/billing/usage',
        subUrl: null,
        guessGrant: (spent) => Math.max(175, Math.ceil(spent / 25) * 25),
    });
    return world;
}

const KEY = 'sk-test-key';
const TARGET = { api_key: KEY, id: 'ar_1', profile: 'git_1' };
const DEAD_ANSWER = { ok: false, error: 'сессия профиля недействительна (HTTP 401)', stale: true, failureKind: 'login_dead' };
const LIVE_ANSWER = { ok: true, balance: 26.2, spent: 0, granted: 26.2, userId: 1, username: 'probe' };

(async () => {
    console.log('\n1. метка живая — второй попытки НЕТ');
    {
        const w = makeWorld({ selfByDir: (d) => (d === DEAD ? LIVE_ANSWER : null) });
        const bal = await w.run(TARGET);
        check(w.selfDirs.length === 1, `спросили ровно один каталог (получили ${w.selfDirs.length})`);
        check(w.selfDirs[0] === DEAD, 'и это метка записи');
        check(bal.balance === 26.2, `цифра взята (${bal.balance})`);
        check(bal.self && bal.self.profileUsed === 'git_1', 'метка осталась прежней — поведение не изменилось');
    }

    console.log('\n2. метка МЁРТВАЯ, детерминированный каталог живой — берём второй');
    {
        const w = makeWorld({
            dirs: { acct_ar_1: REAL },
            selfByDir: (d) => (d === DEAD ? DEAD_ANSWER : (d === REAL ? LIVE_ANSWER : null)),
        });
        const bal = await w.run(TARGET);
        check(w.selfDirs.length === 2, `вторая попытка сделана (каталогов спрошено: ${w.selfDirs.length})`);
        check(w.selfDirs[0] === DEAD && w.selfDirs[1] === REAL, 'сначала метка, потом acct_<id> — порядок безопасный');
        check(bal.balanceSource === 'self' && bal.balance === 26.2,
            `🔴 живой аккаунт больше не «разлогинен»: получили ${bal.balanceSource}/${bal.balance}`);
        check(bal.self && bal.self.profileUsed === 'acct_ar_1',
            'рабочая метка уезжает в запись — вторая попытка становится постоянной, а не каждым чеком');
        check(w.logs.some(l => /отдал 401, а «acct_ar_1» живой/.test(l)), 'подмена метки названа в логе');
    }

    console.log('\n3. второго каталога нет — лишнего запроса НЕ делаем');
    {
        const w = makeWorld({ selfByDir: () => DEAD_ANSWER });
        const bal = await w.run(TARGET);
        check(w.selfDirs.length === 1, `запросили один раз (получили ${w.selfDirs.length})`);
        check(bal.balanceSource !== 'self', 'точная цифра не выдумана');
        check(String(bal.selfError || '').length > 0, 'причина отказа доехала до UI');
    }

    console.log('\n4. оба каталога мертвы — возвращается ИСХОДНЫЙ отказ, а не подмена');
    {
        const w = makeWorld({
            dirs: { acct_ar_1: REAL },
            selfByDir: () => DEAD_ANSWER,
        });
        const bal = await w.run(TARGET);
        check(w.selfDirs.length === 2, 'обе попытки сделаны');
        check(!/acct_ar_1/.test(String(bal.self && bal.self.profileUsed || '')),
            'мёртвая метка НЕ записана как рабочая');
        check(/401|недействительна/.test(String(bal.selfError || '')), 'сказана настоящая причина');
    }

    console.log(fail
        ? `\n❌ ${fail} провалено`
        : '\n✅ Профиль: метка проверяется результатом, живой каталог находится, мёртвый не подменяет вердикт.');
    process.exit(fail ? 1 : 0);
})();
