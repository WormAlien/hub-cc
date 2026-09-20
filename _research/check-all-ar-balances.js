#!/usr/bin/env node
/**
 * Обход балансов AgentRouter через пул прокси.
 *
 * Ручка одна: `GET /__switch/api/ar/balance?api_key=…` - она же единственный писатель
 * баланса в кеш сессии, и она же дедуплицирует параллельные вызовы по одному ключу
 * (`arBalanceOnce`), поэтому ходим по одному ключу за раз, а не залпом.
 *
 * Зачем именно сейчас: 20.09 в чек добавлен путь «сначала адрес аккаунта» (вариант 3).
 * Обход показывает по каждому аккаунту, КУДА он пошёл - через свой адрес, прямым путём
 * или отказал, - то есть проверяет решение на всём пуле, а не на одном прогоне.
 *
 * Запуск: node _research/check-all-ar-balances.js [--limit N] [--delay 300]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8200';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'ar-balances-sweep.txt');
const argv = process.argv.slice(2);
const arg = (n, d) => { const a = argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const LIMIT = Number(arg('limit', 0)) || 0;
const DELAY = Number(arg('delay', 300));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const line = s => { console.log(s); fs.appendFileSync(OUT, s + '\n', 'utf8'); };

function accounts() {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'routing', 'agentrouter-sessions.json'), 'utf8'));
    const arr = Array.isArray(doc) ? doc : Object.values(doc);
    return arr.filter(a => a && a.api_key).map(a => ({
        key: a.api_key,
        name: a.name || a.email || a.login || (a.id || '?'),
    }));
}

(async () => {
    const all = accounts();
    const list = LIMIT ? all.slice(0, LIMIT) : all;
    line(`=== обход балансов через пул: ${list.length} аккаунтов (${new Date().toLocaleString('sv').slice(0, 19)}) ===`);

    const stat = { ok: 0, fail: 0, viaProxy: 0, direct: 0, unknown: 0 };
    for (const acc of list) {
        const url = `${BASE}/__switch/api/ar/balance?api_key=${encodeURIComponent(acc.key)}`;
        let r = null;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
            r = await res.json();
        } catch (e) {
            r = { error: (e && e.message) || String(e) };
        }
        const via = r && r.viaProxy === true ? 'адрес'
            : r && r.viaProxy === false ? 'напрямую'
                : r && r.proxyFirstFailure ? 'адрес отбил → напрямую'
                    : '?';
        // 🪤 Признак успеха - `status`/`balance`, а НЕ `ok`: ручка отдаёт разобранный
        // баланс (`{status:'live', balance…}`), поля `ok` в ней нет вовсе.
        const good = !!(r && (r.status === 'live' || r.balance != null));
        if (good) {
            stat.ok++;
            if (via === 'адрес') stat.viaProxy++; else if (via === 'напрямую') stat.direct++; else stat.unknown++;
        } else {
            stat.fail++;
        }
        const money = r && (r.balance != null ? r.balance : r.quota);
        line(`${good ? '✅' : '❌'} ${String(acc.name).slice(0, 18).padEnd(19)} ${String(r && r.status || via).padEnd(12)}`
            + ` ${money != null ? '$' + money : (r && (r.error || r.proxyFirstFailure || r.proxyFallbackError)) || ''}`);
        await sleep(DELAY);
    }

    line('');
    line(`ИТОГО: успешно ${stat.ok}, отказов ${stat.fail}`);
    line(`путь: через адрес аккаунта ${stat.viaProxy}, напрямую ${stat.direct}, неясно ${stat.unknown}`);
})().catch(e => line('ПАДЕНИЕ: ' + ((e && e.stack) || e)));
