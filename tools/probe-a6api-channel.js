'use strict';
// Проверка одного канала a6api на tools и vision: тот же путь, что у приёмки 23.10.
// Канал адресуется закрепом (pin): маршрут на время пробы сужается до одного продавца,
// иначе площадка сама выбирает, кого спросить, и результат нельзя приписать каналу.
//
//   node tools/probe-a6api-channel.js 2846
//
// Платные запросы идут ТОЛЬКО через routing/lib/a6api-probe.js: у него счётчик,
// журнал в .secrets/a6api-probes.jsonl и потолок в .secrets/a6api-probe-budget.json.
// Пустой пул в кабинете недопустим (площадка вернёт весь рынок), поэтому маршрут
// восстанавливается в finally даже при падении пробы.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../routing/lib/a6api-api');
const probe = require('../routing/lib/a6api-probe');

const MODEL = process.env.A6_MODEL || 'deepseek-v4.1-flash-1017';
const TOKEN_ID = Number(process.env.A6_TOKEN || 145381);
const SECRET_DIR = path.join(os.homedir(), '.secrets');
const poolSnapshot = path.join(SECRET_DIR, 'a6api-flash-pool-before-probe.json');

function readKey() {
    const f = path.join(SECRET_DIR, 'a6api-active-key.txt');
    return fs.readFileSync(f, 'utf8').replace(/^﻿/, '').trim();
}

(async () => {
    const channelId = Number(process.argv[2]);
    if (!Number.isSafeInteger(channelId) || channelId < 1) throw new Error('Укажи ID канала: node tools/probe-a6api-channel.js 2846');
    const client = api.createClient();
    const snapshot = JSON.parse(fs.readFileSync(poolSnapshot, 'utf8'));
    const restore = { id: snapshot.id, version: null, strategy: snapshot.strategy, caps: snapshot.caps, channels: snapshot.channels };

    // Цену канала берём из каталога: по ней считается оценка расхода в бюджете проб.
    const catalog = await client.listings(MODEL, TOKEN_ID, { pageSize: 500 });
    const listing = catalog.items.find(x => x.channelId === channelId);
    if (!listing || !listing.available) throw new Error(`Канал ${channelId} недоступен для этой модели`);
    const price = { inputUsd: listing.inputUsd, outputUsd: listing.outputUsd };
    console.log(`канал ${channelId} ${listing.supplier} · ${price.inputUsd}/${price.outputUsd} за 1M · успех ${listing.recentSuccess}%`);

    // Сужаем пул до одного канала. Потолки поднимаем до его собственной цены: иначе
    // тот же фильтр, что обнулил пул утром, отбросит канал и проба уйдёт мимо.
    const chosen = listing.prices;
    const caps = {
        input_price_micros: chosen.input_price_micros,
        output_price_micros: chosen.output_price_micros,
        cache_read_price_micros: chosen.cache_read_price_micros || 0,
        cache_write_price_micros: 0,
        per_request_price_micros: 0,
    };
    const cur = await client.route(TOKEN_ID, MODEL);
    console.log(`сужу пул ${cur.channels.map(c => c.channelId).join(',')} -> ${channelId} (v${cur.version})`);
    const saved = await client.saveRoute({
        tokenId: TOKEN_ID, model: MODEL, channels: [channelId], strategy: cur.strategy, caps,
        confirmedPrices: { [channelId]: chosen }, baselineId: cur.id, baselineVersion: cur.version,
    });
    console.log(`пул сужен: v${saved.version}, каналов ${saved.channels.length}`);

    let report;
    try {
        // 🪤 Потолок ЗАПРОСОВ берём из файла бюджета и передаём явно: у `createRunner`
        // свой дефолт `maxRequests = 32`, и он перебивает файл, потому что проверка -
        // `Math.min(maxRequests, b.maxRequests)`. 23.10 счётчик дошёл ровно до 32, и проба
        // падала с `probe_budget`, хотя бюджет уже расширен.
        const budgetFile = JSON.parse(fs.readFileSync(path.join(SECRET_DIR, 'a6api-probe-budget.json'), 'utf8'));
        const runner = probe.createRunner({ secretDir: SECRET_DIR, maxRequests: budgetFile.maxRequests });
        const result = await runner.suite({
            key: readKey(), tokenId: TOKEN_ID, channelId, model: MODEL, price, quick: false,
        });
        report = { channelId, supplier: listing.supplier, price, ok: result.ok, results: result.results };
    } finally {
        // Возврат пула: читаем ТЕКУЩУЮ версию, а не ту, что была до сужения - за время
        // пробы кабинет мог измениться, и запись по старой версии получила бы конфликт.
        const now = await client.route(TOKEN_ID, MODEL);
        if (now.channels.length === 1 && now.channels[0].channelId === channelId) {
            await client.saveRoute({
                tokenId: TOKEN_ID, model: MODEL, channels: restore.channels, strategy: restore.strategy,
                caps: restore.caps,
                confirmedPrices: Object.fromEntries((await client.listings(MODEL, TOKEN_ID, { pageSize: 500 }))
                    .items.filter(x => restore.channels.includes(x.channelId)).map(x => [x.channelId, x.prices])),
                baselineId: now.id, baselineVersion: now.version,
            });
            console.log(`пул восстановлен: ${restore.channels.join(',')}`);
        } else {
            console.log(`пул НЕ трогаю: в кабинете уже ${now.channels.map(c => c.channelId).join(',')}`);
        }
    }

    const budget = JSON.parse(fs.readFileSync(path.join(SECRET_DIR, 'a6api-probe-budget.json'), 'utf8'));
    console.log(`бюджет проб: ${budget.count}/${budget.maxRequests}, потрачено ~$${budget.usd.toFixed(6)}`);
    for (const r of report.results) {
        console.log(`  ${r.test.padEnd(14)} ${r.ok ? 'OK  ' : 'FAIL'} http ${r.http || '-'} ${r.ms || '?'}мс ${r.reason || ''}${r.text ? ' | ' + String(r.text).slice(0, 70).replace(/\s+/g, ' ') : ''}`);
    }
    console.log(JSON.stringify({ channelId, supplier: report.supplier, ok: report.ok,
        passed: report.results.filter(r => r.ok).length, total: report.results.length }));
    process.exitCode = report.ok ? 0 : 1;
})().catch(e => { console.error('ERR', e.code || '', e.message); process.exit(1); });
