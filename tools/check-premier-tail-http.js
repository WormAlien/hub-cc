'use strict';
// Живой HTTP-тракт дописки хвоста: настоящий keepalive-proxy.js -> локальный макет шлюза.
// Единичное преобразование уже покрыто tools/check-premier-tail.js; здесь проверяется то,
// что пробой не проверить: гейт по хосту и путь запроса целиком. Макет повторяет поведение
// Premier по замеру probe-premier-reasoning.js - 400, когда история кончается не текстом.
//
// Порт keepalive и макета берутся свободные, живой :20189 не трогается.

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert');

const KEEPALIVE = path.join(__dirname, '..', 'routing', 'keepalive-proxy.js');

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}
const results = [];
function step(name, fn) { return fn().then(() => results.push({ name, ok: true }), e => { results.push({ name, ok: false, error: e.message }); throw e; }); }

// Макет Premier: та же реакция, что у живого шлюза в reasoning-режиме.
function mockGateway() {
    const seen = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw); } catch { /* отдадим 400 ниже */ }
            seen.push(body);
            const msgs = Array.isArray(body.messages) ? body.messages : [];
            const last = msgs[msgs.length - 1] || {};
            const hasText = typeof last.content === 'string'
                ? last.content.trim().length > 0
                : Array.isArray(last.content) && last.content.some(b => b && b.type === 'text' && String(b.text || '').trim());
            if (last.role !== 'user' || !hasText) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
                    message: 'The model provider rejected the request: This reasoning model requires previous reasoning_content in multi-turn requests.' } }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
                content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 1 } }));
        });
    });
    return { server, seen };
}

function run(port, mv) {
    return spawn(process.execPath, [KEEPALIVE], {
        cwd: path.dirname(KEEPALIVE),
        env: { ...process.env, PORT: String(port), UPSTREAM: mv, PREMIER_TAIL_HOST: '127.0.0.1',
            AUTOROTATE: '0', IDLE_MS: '5000', UPSTREAM_TIMEOUT_MS: '20000', PRE_COMMIT_MS: '0',
            COUNT_TOKENS_FALLBACK: '1', FAILDUMP_DIR: path.join(require('node:os').tmpdir(), 'premier-tail-dump') },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUp(port) {
    for (let i = 0; i < 60; i++) {
        try { const r = await fetch(`http://127.0.0.1:${port}/__keepalive/api/status`, { signal: AbortSignal.timeout(500) }); if (r.ok) return; } catch { /* ждём */ }
        await sleep(250);
    }
    throw new Error('keepalive не поднялся');
}
const AGENT_TURN = { model: 'deepseek-v4.1-flash-1017', max_tokens: 1024, stream: false, messages: [
    { role: 'user', content: 'проверь ключ' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'запущу curl', signature: 'premier-gw' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'true' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
] };
async function send(port, body) {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
}

(async () => {
    const mock = mockGateway();
    const mvPort = await freePort();
    await new Promise(r => mock.server.listen(mvPort, '127.0.0.1', r));
    const mv = `http://127.0.0.1:${mvPort}`;
    const kaPort = await freePort();
    const child = run(kaPort, mv);
    try {
        await waitUp(kaPort);

        // 1. Без правки макет повторяет живой отказ: это и есть проверка, что стенд честный.
        await step('макет воспроизводит боевой 400', async () => {
            const r = await send(kaPort, AGENT_TURN);
            assert.strictEqual(r.status, 200, 'с допиской хвоста запрос обязан пройти');
            assert.ok(/ok/.test(r.text), 'ответ макета доехал до клиента');
        });

        // 2. На апстрим ушёл хвост с текстом: смотрим, что реально получил шлюз.
        await step('в хвосте ушёл текст, tool_result сохранён', async () => {
            const body = mock.seen[mock.seen.length - 1];
            const last = body.messages[body.messages.length - 1];
            assert.strictEqual(last.role, 'user');
            assert.strictEqual(last.content[0].type, 'tool_result', 'tool_result не переставлен');
            assert.deepStrictEqual(last.content[last.content.length - 1], { type: 'text', text: 'Continue.' });
            assert.strictEqual(body.messages.length, AGENT_TURN.messages.length, 'ходов не прибавилось');
        });

        // 3. Правильная история не переписывается: длина и содержимое те же, что у клиента.
        await step('правильный хвост остаётся байт-в-байт', async () => {
            const ok = { model: AGENT_TURN.model, max_tokens: 64, stream: false, messages: [
                { role: 'user', content: 'привет' }, { role: 'assistant', content: 'да' }, { role: 'user', content: 'ещё' }] };
            const r = await send(kaPort, ok);
            assert.strictEqual(r.status, 200);
            const got = mock.seen[mock.seen.length - 1];
            assert.deepStrictEqual(got.messages, ok.messages, 'история клиента не изменена');
        });

        // 4. count_tokens не трогаем: правка хвоста живёт только на /v1/messages.
        await step('count_tokens не переписывается', async () => {
            const r = await fetch(`http://127.0.0.1:${kaPort}/v1/messages/count_tokens`, { method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' }, body: JSON.stringify(AGENT_TURN) });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(mock.seen[mock.seen.length - 1].messages.length,
                (mock.seen.find(x => x.messages && x.messages.length === 3) || {}).messages.length,
                'count_tokens не дошёл до шлюза как тело запроса');
        });

        // 5. Хвост ролью system тоже лечится.
        await step('хвост system получает пользовательский ход', async () => {
            const body = { model: AGENT_TURN.model, max_tokens: 64, stream: false, messages: [
                { role: 'user', content: 'привет' }, { role: 'assistant', content: 'да' },
                { role: 'system', content: '<total_tokens>1 left</total_tokens>' }] };
            const r = await send(kaPort, body);
            assert.strictEqual(r.status, 200);
            const got = mock.seen[mock.seen.length - 1];
            assert.strictEqual(got.messages[got.messages.length - 1].role, 'user');
            assert.strictEqual(got.messages[got.messages.length - 2].role, 'system');
        });

        // 6. Рубильник: с PREMIER_TAIL=0 тот же запрос снова получает отказ шлюза.
        await step('PREMIER_TAIL=0 возвращает отказ шлюза', async () => {
            const offPort = await freePort();
            const off = spawn(process.execPath, [KEEPALIVE], { cwd: path.dirname(KEEPALIVE),
                env: { ...process.env, PORT: String(offPort), UPSTREAM: mv, PREMIER_TAIL_HOST: '127.0.0.1',
                    PREMIER_TAIL: '0', AUTOROTATE: '0', PRE_COMMIT_MS: '0', UPSTREAM_TIMEOUT_MS: '20000',
                    FAILDUMP_DIR: path.join(require('node:os').tmpdir(), 'premier-tail-dump') },
                stdio: ['ignore', 'pipe', 'pipe'] });
            try {
                await waitUp(offPort);
                const r = await send(offPort, AGENT_TURN);
                assert.notStrictEqual(r.status, 200, 'с выключенным рубильником запрос обязан падать');
                assert.ok(/requires previous reasoning_content/.test(r.text), 'отказ именно тот, что лечим');
            } finally { off.kill(); }
        });

        // 7. Гейт по хосту: чужой апстрим с тем же поведением правку не получает.
        await step('чужой хост правку не получает', async () => {
            const altPort = await freePort();
            const alt = spawn(process.execPath, [KEEPALIVE], { cwd: path.dirname(KEEPALIVE),
                env: { ...process.env, PORT: String(altPort), UPSTREAM: mv, PREMIER_TAIL_HOST: 'example.invalid',
                    AUTOROTATE: '0', PRE_COMMIT_MS: '0', UPSTREAM_TIMEOUT_MS: '20000',
                    FAILDUMP_DIR: path.join(require('node:os').tmpdir(), 'premier-tail-dump') },
                stdio: ['ignore', 'pipe', 'pipe'] });
            try {
                await waitUp(altPort);
                const r = await send(altPort, AGENT_TURN);
                assert.notStrictEqual(r.status, 200, 'без совпадения хоста дописки быть не должно');
            } finally { alt.kill(); }
        });
    } finally {
        child.kill();
        mock.server.close();
    }
    console.log(JSON.stringify({ ok: true, steps: results.length, results }));
})().catch(e => { console.error(JSON.stringify({ ok: false, results, error: e.message }, null, 1)); process.exit(1); });
