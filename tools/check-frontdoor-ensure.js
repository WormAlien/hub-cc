#!/usr/bin/env node
'use strict';
// Приёмка автоподъёма keepalive по префиксу модели.
//
// Что доказываем (и почему именно это):
//  1. Запрос с префиксом на МЁРТВЫЙ локальный порт не падает 502, а доезжает — front-door
//     просит дашборд поднять инстанс и повторяет запрос ОДИН раз.
//  2. Апстрим получает запрос ровно один раз (дубль = второй платный запрос).
//  3. Префикс срезан: шлюзу уезжает `model` без `<провайдер>/`.
//  4. Запрос БЕЗ префикса на мёртвый активный бэкенд подъём НЕ вызывает — там за это
//     отвечает bootSpawnActiveBackend(), а авто-подъём был бы дракой с владельцем,
//     который погасил порт руками.
//  5. Дедуп: пачка одновременных запросов даёт ОДИН вызов ensure, иначе второй
//     keepaliveBring снял бы как зомби только что заспавненного первым.
//  6. Отказ подъёма отдаётся 502 с человеческой причиной, а не виснет.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-ensure-'));
const FD_PORT = 21411;          // front-door под тестом
const SWITCH_PORT = 21412;      // поддельный дашборд
const UP_PORT = 21413;          // апстрим провайдера (поднимается «по требованию»)
const DEAD_PORT = 21414;        // активный бэкенд, который поднимать НЕ должны

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

function post(port, urlPath, obj, timeout = 20000) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    return new Promise((resolve, reject) => {
        const rq = http.request({
            host: '127.0.0.1', port, method: 'POST', path: urlPath, timeout,
            headers: { 'content-type': 'application/json', 'content-length': payload.length },
        }, (r) => {
            const b = [];
            r.on('data', c => b.push(c));
            r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(b).toString('utf8') }));
        });
        rq.on('timeout', () => rq.destroy(new Error('timeout')));
        rq.on('error', reject);
        rq.end(payload);
    });
}

// Апстрим провайдера: поднимается ТОЛЬКО когда поддельный дашборд получит ensure.
let upstreamHits = [];
let upstreamServer = null;
async function bringUpstream() {
    if (upstreamServer) return;
    upstreamServer = http.createServer((req, res) => {
        const b = [];
        req.on('data', c => b.push(c));
        req.on('end', () => {
            upstreamHits.push({ path: req.url, body: Buffer.concat(b).toString('utf8') });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, from: 'upstream' }));
        });
    });
    await listen(upstreamServer, UP_PORT);
}

let ensureCalls = [];
let ensureMode = 'ok';           // 'ok' | 'fail'

async function main() {
    // ── Поддельный дашборд ───────────────────────────────────────────────────
    const dash = http.createServer((req, res) => {
        const b = [];
        req.on('data', c => b.push(c));
        req.on('end', async () => {
            if (req.method === 'POST' && req.url === '/__switch/api/keepalive/ensure') {
                const j = JSON.parse(Buffer.concat(b).toString('utf8') || '{}');
                ensureCalls.push(j.port);
                if (ensureMode === 'fail') {
                    res.writeHead(500, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ ok: false, error: 'спавн прошёл, но порт не ответил' }));
                }
                await nap(150);                       // подъём не мгновенный, как в жизни
                await bringUpstream();
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, name: 'TestProv', port: j.port }));
            }
            res.writeHead(404); res.end('{}');
        });
    });
    await listen(dash, SWITCH_PORT);

    // ── Фикстуры состояния ───────────────────────────────────────────────────
    const registry = path.join(TMP, 'backends.json');
    fs.writeFileSync(registry, JSON.stringify({
        version: 1,
        providers: {
            testprov: { upstream: `http://localhost:${UP_PORT}`, keyFile: null, modelmap: null, label: 'TestProv' },
        },
        aliases: { tp: 'testprov' },
    }), 'utf8');

    // Активный бэкенд — заведомо мёртвый локальный порт. Он НЕ должен подниматься.
    const active = path.join(TMP, 'active-backend.json');
    fs.writeFileSync(active, JSON.stringify({
        backend: 'deadactive', upstream: `http://localhost:${DEAD_PORT}`, updatedAt: Date.now(),
    }), 'utf8');

    // ── Front-door под тестом ────────────────────────────────────────────────
    child = spawn(process.execPath, [path.join(__dirname, '..', 'routing', 'frontdoor-proxy.js')], {
        env: {
            ...process.env,
            PORT: String(FD_PORT), SWITCH_PORT: String(SWITCH_PORT),
            BACKENDS_FILE: registry, ACTIVE_BACKEND_FILE: active,
            LOG_FILE: path.join(TMP, 'fd.log'),
        },
        stdio: 'ignore',
    });
    for (let i = 0; i < 60; i += 1) {
        try { await post(FD_PORT, '/__ping', {}, 1000); break; } catch { await nap(100); }
    }

    const failures = [];
    const check = (name, fn) => {
        try { fn(); console.log(`  ok   ${name}`); }
        catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); }
    };

    // ── 1-3. Префикс на мёртвый порт: подъём и ровно один долёт ──────────────
    const r1 = await post(FD_PORT, '/v1/messages', { model: 'testprov/claude-opus-5', max_tokens: 1 });
    check('префиксный запрос доезжает после автоподъёма (200, не 502)', () => {
        assert.strictEqual(r1.status, 200, `получили ${r1.status}: ${r1.body.slice(0, 200)}`);
    });
    check('ensure позван ровно один раз и на порт провайдера', () => {
        assert.deepStrictEqual(ensureCalls, [UP_PORT]);
    });
    check('апстрим получил запрос ровно один раз (нет платного дубля)', () => {
        assert.strictEqual(upstreamHits.length, 1, `долетело ${upstreamHits.length}`);
    });
    check('префикс срезан — шлюзу уехала голая модель', () => {
        assert.strictEqual(JSON.parse(upstreamHits[0].body).model, 'claude-opus-5');
    });

    // ── 5. Дедуп: пачка на ещё не поднятый порт = один ensure ────────────────
    try { upstreamServer.close(); } catch { }
    upstreamServer = null; upstreamHits = []; ensureCalls = [];
    await nap(200);
    const burst = await Promise.all([1, 2, 3, 4].map(() =>
        post(FD_PORT, '/v1/messages', { model: 'tp/claude-opus-5', max_tokens: 1 })));
    check('алиас tp/ тоже роутится и все 4 запроса доехали', () => {
        assert.deepStrictEqual(burst.map(b => b.status), [200, 200, 200, 200]);
    });
    check('пачка из 4 запросов дала ОДИН вызов ensure (дедуп держит)', () => {
        assert.strictEqual(ensureCalls.length, 1, `вызовов ${ensureCalls.length}: ${ensureCalls}`);
    });

    // ── 4. Без префикса подъём не зовём вовсе ────────────────────────────────
    ensureCalls = [];
    const r3 = await post(FD_PORT, '/v1/messages', { model: 'claude-opus-5', max_tokens: 1 });
    check('запрос без префикса на мёртвый активный бэкенд → 502', () => {
        assert.strictEqual(r3.status, 502, `получили ${r3.status}`);
    });
    check('для активного бэкенда автоподъём НЕ вызывается', () => {
        assert.deepStrictEqual(ensureCalls, []);
    });

    // ── 6. Отказ подъёма: 502 с причиной, а не висяк ─────────────────────────
    try { upstreamServer.close(); } catch { }
    upstreamServer = null; ensureCalls = []; ensureMode = 'fail';
    await nap(200);
    const r4 = await post(FD_PORT, '/v1/messages', { model: 'testprov/claude-opus-5', max_tokens: 1 });
    check('провалившийся подъём → 502 с причиной и упоминанием префикса', () => {
        assert.strictEqual(r4.status, 502, `получили ${r4.status}`);
        assert.ok(/автоподъём не удался/.test(r4.body), `нет причины в теле: ${r4.body.slice(0, 200)}`);
        assert.ok(/префиксом модели/.test(r4.body), `нет указания на префикс: ${r4.body.slice(0, 200)}`);
    });

    // ── Отбойник: второй запрос подряд не идёт за подъёмом снова ─────────────
    ensureCalls = [];
    const r5 = await post(FD_PORT, '/v1/messages', { model: 'testprov/claude-opus-5', max_tokens: 1 });
    check('после провала отбойник глушит повторный ensure (нет 8с на каждый запрос)', () => {
        assert.strictEqual(r5.status, 502);
        assert.deepStrictEqual(ensureCalls, []);
    });

    console.log(failures.length
        ? `\n[FAIL] провалено ${failures.length}: ${failures.join('; ')}`
        : '\n[OK] автоподъём keepalive по префиксу работает');
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('[FAIL]', e); process.exit(1); });
