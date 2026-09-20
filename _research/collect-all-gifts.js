#!/usr/bin/env node
/**
 * Набрать ВСЕ готовые подарки AgentRouter пачками.
 *
 * Почему пачками, а не одним залпом: `AR_CHECKIN_BATCH_MAX = 6` - осознанный предохранитель
 * (рядом с ним стоп-кран: два отказа «от шлюза» подряд = стена, дальше аккаунты не жжём).
 * Ручка `limit` у ручки больше шести всё равно не даёт - `Math.min(ask, MAX)`.
 *
 * Логика: попросить пачку → дождаться, пока очередь опустеет → попросить следующую.
 * Каждый шаг пишется в файл прогресса: работа не должна теряться, если агент умрёт.
 *
 * Запуск: node _research/collect-all-gifts.js [--max-hours 2]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8200';
const OUT = path.join(__dirname, 'collect-gifts-progress.txt');
const argv = process.argv.slice(2);
const MAX_HOURS = Number((argv.find(a => a.startsWith('--max-hours=')) || '').split('=')[1]) || 2;
const POLL_MS = 20000;
const T0 = Date.now();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function log(line) {
    const s = `[${stamp()} +${Math.round((Date.now() - T0) / 1000)}s] ${line}`;
    console.log(s);
    fs.appendFileSync(OUT, s + '\n', 'utf8');
}

async function api(method, url, body) {
    const res = await fetch(BASE + url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
}

function states(status) {
    const arr = Array.isArray(status.runs) ? status.runs
        : Array.isArray(status.items) ? status.items
            : Array.isArray(status) ? status : Object.values(status || {});
    return arr.filter(x => x && typeof x === 'object');
}

(async () => {
    log(`=== сбор подарков пачками по 6, лимит ${MAX_HOURS} ч ===`);
    let totalQueued = 0, batch = 0;
    for (;;) {
        if (Date.now() - T0 > MAX_HOURS * 3600e3) { log('лимит времени вышел - стоп'); return; }
        batch++;
        const fire = await api('POST', '/__switch/api/ar/checkin-all', {});
        if (!fire.ok) { log(`пачка ${batch}: отказ ${JSON.stringify(fire).slice(0, 200)}`); return; }
        const ready = Number(fire.ready || 0);
        const queued = Number(fire.queued || 0);
        log(`пачка ${batch}: поставлено ${queued}, готовых было ${ready}, отложено ${Number(fire.skipped || 0)}`);
        if (!queued) {
            const why = (fire.skippedWhy || []).slice(0, 3).join('; ');
            log(`ставить больше нечего (готовых ${ready})${why ? ' | ' + why : ''} - сбор закончен`);
            log(`ИТОГО поставлено в работу: ${totalQueued}`);
            return;
        }
        totalQueued += queued;

        // Ждём, пока эта пачка отработает: в очереди не должно остаться running/queued.
        for (;;) {
            await sleep(POLL_MS);
            const st = await api('GET', '/__switch/api/ar/checkin-status');
            const live = states(st).filter(x => x.state === 'running' || x.state === 'queued');
            if (!live.length) {
                const done = states(st).filter(x => x.state === 'done' || x.checkedIn).length;
                log(`пачка ${batch} отработала (в статусе записей: ${states(st).length})`);
                break;
            }
            const names = live.map(x => `${x.name || x.label}:${x.state}`).join(' ');
            log(`  в работе ${live.length}: ${names.slice(0, 120)}`);
            if (Date.now() - T0 > MAX_HOURS * 3600e3) { log('лимит времени вышел посреди пачки - стоп'); return; }
        }
        await sleep(5000);
    }
})().catch(e => log('ПАДЕНИЕ: ' + ((e && e.stack) || e)));
