#!/usr/bin/env node
'use strict';
// Приёмка виртуального `/model multi`: провайдер+модель на КАЖДЫЙ тир (кросс-шлюз).
//
// Заявка владельца 19.09: сверху вкладки «Маршруты» завести `/model multi`, где окно и
// сабагенты (opus/sonnet/haiku) идут на РАЗНЫЕ шлюзы. Это дополнение к однашлюзовому
// режиму 12.09, не разворот: обычный `/model agentrouter` по-прежнему один шлюз на окно.
//
// Что доказываем (и почему именно это):
//  1. Голое `multi` → тир default → пара {provider, model} из multi-карты, форвард на
//     ЕЁ шлюз (не на активный). Иначе окно молча уехало бы на активный шлюз.
//  2. `multi/claude-sonnet-5` (сабагент) → тир по имени → пара sonnet → ДРУГОЙ upstream.
//     Это и есть кросс-шлюзовость: окно и сабагент на разных шлюзах одновременно.
//  3. Заголовок `x-route-final` уходит наверх (keepalive по нему НЕ ремапит модель
//     тир-картой резолвленного шлюза — иначе выбор multi потерялся бы) и `x-route-tier`
//     при multi НЕ ставится (модель уже конечная).
//  4. Провайдер резолвится из РЕЕСТРА, а не из копии таблицы; неизвестный → 400.
//  5. Ненастроенный тир → 400 с подсказкой на блок multi, наверх не ушло ничего.
//  6. gpt через multi не маршрутизируется (в MULTI_TIERS его нет) → 400.
//  7. Подделанный клиентом `x-route-final` на непрефиксном запросе снимается.
//
// Живых шлюзов и платных запросов здесь нет: оба апстрима поддельные.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-multi-'));
const FD_PORT = 21431;          // front-door под тестом
const UP_JW = 21432;            // «шлюз» justwoker (окно)
const UP_AR = 21433;            // «шлюз» agentrouter (сабагенты)

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

// Поддельный шлюз: пишет в свой массив, что ему прислали.
function fakeGateway(seen) {
    return http.createServer((req, res) => {
        const buf = [];
        req.on('data', c => buf.push(c));
        req.on('end', () => {
            let model = null;
            try { model = JSON.parse(Buffer.concat(buf).toString('utf8')).model; } catch { }
            seen.push({
                model,
                prefixed: req.headers['x-route-prefixed'] || null,
                tier: req.headers['x-route-tier'] || null,
                final: req.headers['x-route-final'] || null,
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    });
}

function post(port, urlPath, obj, extraHeaders, timeout = 15000) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    return new Promise((resolve, reject) => {
        const rq = http.request({
            host: '127.0.0.1', port, method: 'POST', path: urlPath, timeout,
            headers: Object.assign({ 'content-type': 'application/json', 'content-length': payload.length }, extraHeaders || {}),
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
    const seenJw = [];
    const seenAr = [];
    await listen(fakeGateway(seenJw), UP_JW);
    await listen(fakeGateway(seenAr), UP_AR);
    const clearSeen = () => { seenJw.length = 0; seenAr.length = 0; };

    // ── Реестр: два ЛОКАЛЬНЫХ шлюза на разных апстримах ───────────────────────
    // Пути карт абсолютные (иначе readModelMap резолвит от routing/ и читает боевые).
    const jwMap = path.join(TMP, 'jw-modelmap.json');
    const arMap = path.join(TMP, 'ar-modelmap.json');
    fs.writeFileSync(jwMap, JSON.stringify({ opus: '', sonnet: '', haiku: '' }), 'utf8');
    fs.writeFileSync(arMap, JSON.stringify({ opus: '', sonnet: '', haiku: '' }), 'utf8');

    const registry = path.join(TMP, 'backends.json');
    const active = path.join(TMP, 'active-backend.json');
    fs.writeFileSync(registry, JSON.stringify({
        version: 1,
        aliases: {},
        providers: {
            justwoker: { upstream: `http://127.0.0.1:${UP_JW}`, keyFile: null, modelmap: jwMap },
            agentrouter: { upstream: `http://127.0.0.1:${UP_AR}`, keyFile: null, modelmap: arMap },
        },
    }), 'utf8');
    fs.writeFileSync(active, JSON.stringify({
        backend: 'justwoker', upstream: `http://127.0.0.1:${UP_JW}`, updatedAt: Date.now(),
    }), 'utf8');

    // ── multi-карта: окно на justwoker, сабагенты на agentrouter ──────────────
    const multiMap = path.join(TMP, 'multi-routes-modelmap.json');
    fs.writeFileSync(multiMap, JSON.stringify({
        default: { provider: 'justwoker', model: 'claude-opus-4-8' },
        opus: { provider: 'justwoker', model: 'claude-opus-4-8' },
        sonnet: { provider: 'agentrouter', model: 'glm-5.3' },
        haiku: { provider: 'agentrouter', model: 'deepseek-v4-flash' },
    }), 'utf8');

    // ── Front-door под тестом ────────────────────────────────────────────────
    child = spawn(process.execPath, [path.join(__dirname, '..', 'routing', 'frontdoor-proxy.js')], {
        env: {
            ...process.env,
            PORT: String(FD_PORT),
            BACKENDS_FILE: registry, ACTIVE_BACKEND_FILE: active,
            MULTI_MAP_FILE: multiMap,
            LOG_FILE: path.join(TMP, 'fd.log'),
        },
        stdio: 'ignore',
    });
    for (let i = 0; i < 60; i++) {
        try { await post(FD_PORT, '/__ping', {}, null, 1000); break; } catch { await nap(100); }
    }

    // 1. Голое multi → default → justwoker/claude-opus-4-8
    clearSeen();
    let r = await post(FD_PORT, '/v1/messages', { model: 'multi', max_tokens: 1 });
    check('голое multi принято (200)', () => assert.strictEqual(r.status, 200, `status ${r.status}: ${r.body}`));
    check('окно уехало на шлюз justwoker (UP_JW)', () => assert.strictEqual(seenJw.length, 1, `jw=${seenJw.length} ar=${seenAr.length}`));
    check('на agentrouter НЕ уходило', () => assert.strictEqual(seenAr.length, 0));
    check('модель = конечная claude-opus-4-8 из multi-карты', () => assert.strictEqual(seenJw[0] && seenJw[0].model, 'claude-opus-4-8', JSON.stringify(seenJw[0])));
    check('x-route-final уехал наверх (keepalive не ремапит)', () => assert.strictEqual(seenJw[0] && seenJw[0].final, '1', JSON.stringify(seenJw[0])));
    check('x-route-tier при multi НЕ ставится', () => assert.strictEqual(seenJw[0] && seenJw[0].tier, null, JSON.stringify(seenJw[0])));
    check('x-route-prefixed стоит', () => assert.strictEqual(seenJw[0] && seenJw[0].prefixed, '1'));

    // 1b. multi[1m] — суффикс окна снимается, тот же результат
    clearSeen();
    await post(FD_PORT, '/v1/messages', { model: 'multi[1m]', max_tokens: 1 });
    check('multi[1m] развёрнут как multi', () => assert.strictEqual(seenJw[0] && seenJw[0].model, 'claude-opus-4-8', JSON.stringify(seenJw[0])));

    // 2. Кросс-шлюз: сабагент sonnet → agentrouter/glm-5.3 (ДРУГОЙ upstream)
    clearSeen();
    await post(FD_PORT, '/v1/messages', { model: 'multi/claude-sonnet-5', max_tokens: 1 });
    check('сабагент sonnet уехал на ДРУГОЙ шлюз agentrouter (UP_AR)', () => assert.strictEqual(seenAr.length, 1, `jw=${seenJw.length} ar=${seenAr.length}`));
    check('на justwoker sonnet НЕ уходил', () => assert.strictEqual(seenJw.length, 0));
    check('sonnet-модель = glm-5.3 из multi-карты', () => assert.strictEqual(seenAr[0] && seenAr[0].model, 'glm-5.3', JSON.stringify(seenAr[0])));
    check('sonnet: x-route-final стоит', () => assert.strictEqual(seenAr[0] && seenAr[0].final, '1'));

    // 2b. haiku → agentrouter/deepseek-v4-flash
    clearSeen();
    await post(FD_PORT, '/v1/messages', { model: 'multi/claude-haiku-4-5-20251001', max_tokens: 1 });
    check('сабагент haiku → agentrouter/deepseek-v4-flash', () => assert.strictEqual(seenAr[0] && seenAr[0].model, 'deepseek-v4-flash', JSON.stringify(seenAr[0])));

    // 3. Ненастроенный тир → 400, наверх ничего
    clearSeen();
    const multiGap = path.join(TMP, 'multi-gap.json');
    fs.writeFileSync(multiGap, JSON.stringify({
        default: { provider: 'justwoker', model: 'claude-opus-4-8' },
        // opus/sonnet/haiku не заданы
    }), 'utf8');
    const FD2 = FD_PORT + 10;
    const child2 = spawn(process.execPath, [path.join(__dirname, '..', 'routing', 'frontdoor-proxy.js')], {
        env: { ...process.env, PORT: String(FD2), BACKENDS_FILE: registry, ACTIVE_BACKEND_FILE: active, MULTI_MAP_FILE: multiGap, LOG_FILE: path.join(TMP, 'fd2.log') },
        stdio: 'ignore',
    });
    const killChild2 = () => { try { process.kill(child2.pid); } catch { } };
    process.on('exit', killChild2);
    for (let i = 0; i < 60; i++) { try { await post(FD2, '/__ping', {}, null, 1000); break; } catch { await nap(100); } }

    clearSeen();
    r = await post(FD2, '/v1/messages', { model: 'multi/claude-sonnet-5', max_tokens: 1 });
    check('ненастроенный тир → 400', () => assert.strictEqual(r.status, 400, `status ${r.status}: ${r.body}`));
    check('400 называет блок multi и тир', () => assert.ok(/multi/i.test(r.body) && /sonnet/.test(r.body), r.body));
    check('при 400 наверх не ушло ничего', () => assert.strictEqual(seenJw.length + seenAr.length, 0));

    // 3b. default настроен — окно доезжает даже при пустых сабагент-тирах
    clearSeen();
    r = await post(FD2, '/v1/messages', { model: 'multi', max_tokens: 1 });
    check('default настроен → окно доезжает (200)', () => assert.strictEqual(r.status, 200, `status ${r.status}: ${r.body}`));
    check('окно → justwoker/claude-opus-4-8', () => assert.strictEqual(seenJw[0] && seenJw[0].model, 'claude-opus-4-8'));

    // 4. gpt через multi не маршрутизируется (нет тира gpt) → 400
    clearSeen();
    r = await post(FD_PORT, '/v1/messages', { model: 'multi/gpt-6-astra', max_tokens: 1 });
    check('multi/gpt-* → 400 (тира gpt у multi нет)', () => assert.strictEqual(r.status, 400, `status ${r.status}: ${r.body}`));
    check('gpt-400 наверх ничего не шлёт', () => assert.strictEqual(seenJw.length + seenAr.length, 0));
    killChild2();

    // 5. Провайдер не в реестре → 400
    clearSeen();
    const multiBadProv = path.join(TMP, 'multi-badprov.json');
    fs.writeFileSync(multiBadProv, JSON.stringify({ default: { provider: 'nonexistent', model: 'x' } }), 'utf8');
    const FD3 = FD_PORT + 11;
    const child3 = spawn(process.execPath, [path.join(__dirname, '..', 'routing', 'frontdoor-proxy.js')], {
        env: { ...process.env, PORT: String(FD3), BACKENDS_FILE: registry, ACTIVE_BACKEND_FILE: active, MULTI_MAP_FILE: multiBadProv, LOG_FILE: path.join(TMP, 'fd3.log') },
        stdio: 'ignore',
    });
    const killChild3 = () => { try { process.kill(child3.pid); } catch { } };
    process.on('exit', killChild3);
    for (let i = 0; i < 60; i++) { try { await post(FD3, '/__ping', {}, null, 1000); break; } catch { await nap(100); } }
    clearSeen();
    r = await post(FD3, '/v1/messages', { model: 'multi', max_tokens: 1 });
    check('провайдер не в реестре → 400', () => assert.strictEqual(r.status, 400, `status ${r.status}: ${r.body}`));
    check('400 называет провайдера и реестр', () => assert.ok(/nonexistent/.test(r.body) && /реестр/i.test(r.body), r.body));
    check('несуществующий провайдер: наверх ничего', () => assert.strictEqual(seenJw.length + seenAr.length, 0));
    killChild3();

    // 6. Обычный запрос без multi: заголовок x-route-final не должен появиться,
    //    даже если клиент его подсунул.
    clearSeen();
    await post(FD_PORT, '/v1/messages', { model: 'claude-opus-5', max_tokens: 1 }, { 'x-route-final': '1' });
    check('обычная модель едет на активный шлюз (justwoker)', () => assert.strictEqual(seenJw[0] && seenJw[0].model, 'claude-opus-5', JSON.stringify(seenJw[0])));
    check('подделанный клиентом x-route-final снят', () => assert.strictEqual(seenJw[0] && seenJw[0].final, null, JSON.stringify(seenJw[0])));
    check('и x-route-prefixed тоже снят', () => assert.strictEqual(seenJw[0] && seenJw[0].prefixed, null));

    // ── Итог ─────────────────────────────────────────────────────────────────
    for (const n of ok) console.log(`  ok   ${n}`);
    for (const f of fails) console.log(`  FAIL ${f}`);
    if (fails.length) {
        console.log(`\n[FAIL] ${fails.length} из ${ok.length + fails.length}`);
        process.exit(1);
    }
    console.log(`\n[OK] виртуальный /model multi: кросс-шлюзовой роутинг работает (${ok.length} проверок)`);
    process.exit(0);
})().catch((e) => { console.error('тест упал:', e); process.exit(1); });
