#!/usr/bin/env node
'use strict';
// Приёмка «имя без модели» и двух тир-карт.
//
// Заявка владельца 12.09: `/model agentrouter` вместо `/model agentrouter/gpt-6-astra`,
// модель выбирает вкладка «Маршруты». Плюс «для провайдера свой маппинг, для маршрутов
// свой» — до этого файл был один, и правка на одной вкладке меняла поведение другой.
//
// Что доказываем (и почему именно это):
//  1. Голое имя шлюза распознаётся и разворачивается в `default` из routes-карты.
//     До правки этот случай возвращал null → запрос МОЛЧА уезжал на активный шлюз,
//     то есть на чужой баланс. Тихий отказ, ради которого всё и делалось.
//  2. Читается именно `<prefix>-routes-modelmap.json`, а НЕ карта активного шлюза:
//     если перепутать файлы, вкладки снова начнут перетирать друг друга.
//  3. Заголовок `x-route-prefixed` уходит наверх (по нему keepalive берёт ту же
//     routes-карту) и снимается с непрефиксных запросов — иначе чужой запрос
//     притворится префиксным.
//  4. Пустой `default` → 400 с подсказкой, а не угадывание и не тихий уход.
//  5. Суффикс окна на голом имени (`agentrouter[1m]`) не ломает поиск в реестре.
//     normalizeCcModel вешает `[1m]` автоматически, так что случай неизбежен.
//  6. Сабагенты (sonnet/haiku) идут по СВОИМ тирам, а не по `default` — решение
//     владельца «вариант A»: haiku обязан остаться дешёвым.
//
// Живых шлюзов и платных запросов здесь нет: апстрим поддельный, он же и протокол.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-routes-'));
const FD_PORT = 21421;          // front-door под тестом
const UP_PORT = 21422;          // «шлюз» провайдера

const servers = [];
let child = null;
const cleanup = () => {
    for (const s of servers) { try { s.close(); } catch { } }
    if (child) { try { process.kill(child.pid); } catch { } }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
};
process.on('exit', cleanup);

const nap = ms => new Promise(r => setTimeout(r, ms));

function listen(server, port) {
    servers.push(server);
    return new Promise((res, rej) => {
        server.once('error', rej);
        server.listen(port, '127.0.0.1', res);
    });
}

function post(port, urlPath, obj, timeout = 15000) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    return new Promise((resolve, reject) => {
        const rq = http.request({
            host: '127.0.0.1', port, method: 'POST', path: urlPath, timeout,
            headers: { 'content-type': 'application/json', 'content-length': payload.length },
        }, (r) => {
            const buf = [];
            r.on('data', c => buf.push(c));
            r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(buf).toString('utf8') }));
        });
        rq.on('timeout', () => rq.destroy(new Error('timeout')));
        rq.on('error', reject);
        rq.end(payload);
    });
}

const ok = [];
const fails = [];
const check = (name, fn) => {
    try { fn(); ok.push(name); }
    catch (e) { fails.push(`${name}: ${e.message}`); }
};

(async () => {
    // ── Поддельный шлюз: запоминает, что ему прислали ────────────────────────
    const seen = [];
    await listen(http.createServer((req, res) => {
        const buf = [];
        req.on('data', c => buf.push(c));
        req.on('end', () => {
            let model = null;
            try { model = JSON.parse(Buffer.concat(buf).toString('utf8')).model; } catch { }
            seen.push({ model, prefixed: req.headers['x-route-prefixed'] || null, tier: req.headers['x-route-tier'] || null });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    }), UP_PORT);

    // ── Реестр и обе карты ───────────────────────────────────────────────────
    // `modelmap` в реестре указывает на карту АКТИВНОГО пути; routes-карту
    // front-door обязан вывести сам, подменив суффикс имени файла.
    // 🪤 Пути АБСОЛЮТНЫЕ: относительные readModelMap() резолвит от `routing/`, и тест
    // читал бы боевые карты вместо своих фикстур.
    const gwMap = path.join(TMP, 'tp-modelmap.json');
    const rtMap = path.join(TMP, 'tp-routes-modelmap.json');
    const bareMap = path.join(TMP, 'bare-modelmap.json');
    fs.writeFileSync(gwMap, JSON.stringify({
        default: 'ГАЗЕТА-НЕ-ЭТА', opus: 'gateway-opus', sonnet: 'gateway-sonnet', haiku: 'gateway-haiku', gpt: '',
    }), 'utf8');
    fs.writeFileSync(rtMap, JSON.stringify({
        default: 'routes-default', opus: 'routes-opus', sonnet: 'routes-sonnet', haiku: 'routes-haiku', gpt: 'routes-gpt',
    }), 'utf8');
    // Провайдер без routes-карты: `default` взять неоткуда → обязан быть 400.
    fs.writeFileSync(bareMap, JSON.stringify({ opus: 'x' }), 'utf8');

    const registry = path.join(TMP, 'backends.json');
    const active = path.join(TMP, 'active-backend.json');
    fs.writeFileSync(registry, JSON.stringify({
        version: 1,
        aliases: { tp: 'testprov' },
        providers: {
            testprov: { upstream: `http://127.0.0.1:${UP_PORT}`, keyFile: null, modelmap: gwMap },
            bare: { upstream: `http://127.0.0.1:${UP_PORT}`, keyFile: null, modelmap: bareMap },
        },
    }), 'utf8');
    fs.writeFileSync(active, JSON.stringify({
        backend: 'testprov', upstream: `http://127.0.0.1:${UP_PORT}`, updatedAt: Date.now(),
    }), 'utf8');

    // ── Front-door под тестом ────────────────────────────────────────────────
    child = spawn(process.execPath, [path.join(__dirname, '..', 'routing', 'frontdoor-proxy.js')], {
        env: {
            ...process.env,
            PORT: String(FD_PORT),
            BACKENDS_FILE: registry, ACTIVE_BACKEND_FILE: active,
            LOG_FILE: path.join(TMP, 'fd.log'),
        },
        stdio: 'ignore',
    });
    for (let i = 0; i < 60; i++) {
        try { await post(FD_PORT, '/__ping', {}, 1000); break; } catch { await nap(100); }
    }

    // 1. Голое имя → default из routes-карты
    seen.length = 0;
    let r = await post(FD_PORT, '/v1/messages', { model: 'testprov', max_tokens: 1 });
    check('голое имя шлюза принято (200, не 502/400)', () => assert.strictEqual(r.status, 200, `status ${r.status}: ${r.body}`));
    check('модель развёрнута в default из ROUTES-карты', () => assert.strictEqual(seen[0] && seen[0].model, 'routes-default', JSON.stringify(seen[0])));
    check('карта активного шлюза НЕ использована', () => assert.notStrictEqual(seen[0] && seen[0].model, 'ГАЗЕТА-НЕ-ЭТА'));
    check('заголовок x-route-prefixed уехал наверх', () => assert.strictEqual(seen[0] && seen[0].prefixed, '1', JSON.stringify(seen[0])));
    check('тир помечен как default', () => assert.strictEqual(seen[0] && seen[0].tier, 'default'));

    // 2. Алиас и регистр
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'tp', max_tokens: 1 });
    check('алиас работает так же', () => assert.strictEqual(seen[0] && seen[0].model, 'routes-default'));
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'TestProv', max_tokens: 1 });
    check('регистр имени не важен', () => assert.strictEqual(seen[0] && seen[0].model, 'routes-default'));

    // 3. Суффикс окна на голом имени: normalizeCcModel вешает [1m] сам
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'testprov[1m]', max_tokens: 1 });
    check('суффикс [1m] на голом имени не ломает поиск', () => assert.strictEqual(seen[0] && seen[0].model, 'routes-default', JSON.stringify(seen[0])));

    // 4. Сабагенты идут по СВОИМ тирам (вариант A владельца)
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'testprov/claude-haiku-4-5-20251001', max_tokens: 1 });
    check('haiku помечен своим тиром, а не default', () => assert.strictEqual(seen[0] && seen[0].tier, 'haiku', JSON.stringify(seen[0])));
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'testprov/claude-sonnet-5', max_tokens: 1 });
    check('sonnet помечен своим тиром', () => assert.strictEqual(seen[0] && seen[0].tier, 'sonnet'));

    // 5. Пустой default → 400 с подсказкой, ничего никуда не уехало
    seen.length = 0;
    r = await post(FD_PORT, '/v1/messages', { model: 'bare', max_tokens: 1 });
    check('шлюз без default → 400', () => assert.strictEqual(r.status, 400, `status ${r.status}: ${r.body}`));
    check('400 объясняет, что чинить', () => assert.ok(/Маршруты|default/i.test(r.body), r.body));
    check('при 400 наверх не ушло ничего (денег не потрачено)', () => assert.strictEqual(seen.length, 0, JSON.stringify(seen)));

    // 6. Непрефиксный запрос: заголовок обязан отсутствовать, даже если клиент его подсунул
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'claude-opus-5', max_tokens: 1 });
    check('обычная модель едет на активный шлюз как есть', () => assert.strictEqual(seen[0] && seen[0].model, 'claude-opus-5'));
    check('без префикса заголовка нет (keepalive возьмёт обычную карту)', () => assert.strictEqual(seen[0] && seen[0].prefixed, null, JSON.stringify(seen[0])));

    // 7. Подделка заголовка клиентом снимается
    seen.length = 0;
    await new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify({ model: 'claude-opus-5', max_tokens: 1 }), 'utf8');
        const rq = http.request({
            host: '127.0.0.1', port: FD_PORT, method: 'POST', path: '/v1/messages', timeout: 15000,
            headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-route-prefixed': '1' },
        }, (res) => { res.resume(); res.on('end', resolve); });
        rq.on('error', reject);
        rq.end(payload);
    });
    check('подделанный клиентом x-route-prefixed снят', () => assert.strictEqual(seen[0] && seen[0].prefixed, null, JSON.stringify(seen[0])));

    // ── Итог ─────────────────────────────────────────────────────────────────
    for (const n of ok) console.log(`  ok   ${n}`);
    for (const f of fails) console.log(`  FAIL ${f}`);
    if (fails.length) {
        console.log(`\n[FAIL] ${fails.length} из ${ok.length + fails.length}`);
        process.exit(1);
    }
    console.log(`\n[OK] имя без модели и две тир-карты работают (${ok.length} проверок)`);
    process.exit(0);
})().catch((e) => { console.error('тест упал:', e); process.exit(1); });
