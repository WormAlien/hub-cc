#!/usr/bin/env node
'use strict';
// check-ar-client-gone.js — регресс на различение «клиент ушёл» и «пустой поток»
// в AR-конвертере (routing/agentrouter-proxy.js).
//
// Зачем. Живой случай 22.11.2026 в журнале клиентской установки:
//   [frontdoor] клиент ушёл (ответ не дописан) — рву апстрим
//   [frontdoor] ECONNRESET
//   [keepalive] клиент ушёл через 9с (содержимого не было)
//   [ar] responses: отказ до контента (empty_stream) - отдаю 502
// То есть конвертер записал уход КЛИЕНТА как отказ АПСТРИМА. Из-за этого
// «502 upstream вернул поток без содержимого» появлялся там, где вендор ни при чём,
// и разбор уходил в чужую сторону (лимиты, квоты, ретраи).
//
// Что проверяем: эмиттер отдаёт code='client_gone', когда clientRes уже разрушен,
// и code='empty_stream', когда поток закрыл апстрим. Оба случая — без контента.
//
// Только локальные фикстуры. Сети нет, генерации нет, секретов нет.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PROXY = path.join(ROOT, 'routing', 'agentrouter-proxy.js');

// ── фиктивный upstream: только /v1/responses ─────────────────────────────────
// mode='empty'  — закрывает поток, не прислав ни одного события контента;
// mode='ok'     — присылает нормальный текст (контроль: это не должно быть отказом).
function startUpstream() {
    const state = { mode: 'empty' };
    const server = http.createServer((req, res) => {
        const url = (req.url || '').split('?')[0];
        if (url === '/v1/models') {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }] }));
        }
        if (url !== '/v1/responses') { res.writeHead(404); return res.end('no'); }
        req.resume();
        req.on('end', () => {
            if (state.mode === 'empty') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end();                       // ни одного data-события
                return;
            }
            if (state.mode === 'silent') {
                // Держим соединение открытым и МОЛЧИМ — как вендор в очереди.
                // Только в этом режиме уход клиента можно отличить от пустого ответа:
                // при 'empty' апстрим закрывается первым, и empty_stream — правда.
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                state.held = res;
                return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const send = o => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
            if (state.mode === 'ratelimit') {
                // Явный лимит ВНУТРИ SSE, как это делает вендор: код кладётся в КОРЕНЬ
                // события (см. вики, entities/AgentRouter.md — форма события error у Sol).
                send({ type: 'error', code: 'rate_limit_exceeded', message: 'slow down' });
                res.end();
                return;
            }
            if (state.mode === 'tools') {
                // Содержательный ответ БЕЗ текста: только tool call. Это не «пустой поток».
                send({ type: 'response.created', response: { id: 'r2', status: 'in_progress' } });
                send({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', name: 'get_time', call_id: 'c1', arguments: '' } });
                send({ type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"tz":"UTC"}' });
                send({ type: 'response.completed', response: { id: 'r2', status: 'completed', usage: { input_tokens: 5, output_tokens: 7 } } });
                res.end();
                return;
            }
            send({ type: 'response.created', response: { id: 'r1', status: 'in_progress' } });
            send({ type: 'response.output_text.delta', delta: 'OK' });
            send({ type: 'response.completed', response: { id: 'r1', status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } });
            res.end();
        });
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, port: server.address().port })));
}

// Поднимаем конвертер отдельным процессом и бьём в него как keepalive: /v1/messages.
function startProxy(upPort) {
    const port = 30000 + Math.floor(Math.random() * 5000);
    const child = spawn(process.execPath, [PROXY], {
        env: { ...process.env, LISTEN_PORT: String(port), AR_UPSTREAM_BASE: `http://127.0.0.1:${upPort}` },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => out += d);
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
            const req = http.request({ host: '127.0.0.1', port, path: '/__agentrouter/api/status', method: 'GET' }, res => {
                res.resume();
                if (res.statusCode === 200) return resolve({ child, port, log: () => out });
                retry();
            });
            req.on('error', retry);
            req.end();
        };
        const retry = () => {
            if (Date.now() - t0 > 8000) return reject(new Error('конвертер не поднялся:\n' + out));
            setTimeout(tick, 200);
        };
        tick();
    });
}

function postMessages(port, { timeoutMs = 4000 } = {}) {
    const body = JSON.stringify({
        model: 'claude-opus-5', max_tokens: 64, stream: true,
        messages: [{ role: 'user', content: 'hi' }],
    });
    return new Promise(resolve => {
        const req = http.request({
            host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', c => text += c);
            res.on('end', () => resolve({ status: res.statusCode, text, aborted: false }));
            res.on('aborted', () => resolve({ status: res.statusCode, text, aborted: true }));
        });
        req.on('error', e => resolve({ status: 0, text: '', error: e.message }));
        req.setTimeout(timeoutMs, () => { req.destroy(new Error('client timeout')); });
        req.write(body);
        req.end();
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('пустой поток апстрима = empty_stream (это про вендора)', async () => {
    const up = await startUpstream();
    const px = await startProxy(up.port);
    try {
        up.state.mode = 'empty';
        const r = await postMessages(px.port);
        await sleep(300);
        const log = px.log();
        assert.match(log, /empty_stream/, 'пустой поток апстрима обязан дать empty_stream');
        assert.doesNotMatch(log, /клиент ушёл до контента/,
            'нельзя называть это уходом клиента: клиент как раз ждал ответа');
        // Наружу должен уйти отказ, а не пустой 200.
        assert.ok(r.status >= 400 || /"type":"error"/.test(r.text),
            `ожидали отказ, получили ${r.status} ${r.text.slice(0, 80)}`);
    } finally {
        px.child.kill(); up.server.close();
    }
});

test('клиент ушёл до контента = client_gone, а не empty_stream', async () => {
    const up = await startUpstream();
    const px = await startProxy(up.port);
    try {
        // Апстрим МОЛЧИТ и держит поток открытым — как вендор в очереди. Клиент
        // не дожидается и уходит. Только в этой сцене уход клиента отличим от
        // пустого ответа апстрима, и именно она воспроизводит живой случай 22.11
        // ([frontdoor] клиент ушёл → ECONNRESET → [ar] empty_stream → 502).
        up.state.mode = 'silent';
        await postMessages(px.port, { timeoutMs: 150 });
        await sleep(700);
        const log = px.log();
        assert.match(log, /клиент ушёл до контента/,
            'уход клиента обязан быть назван своим именем');
        assert.doesNotMatch(log, /\(empty_stream\)/,
            'уход клиента не должен попадать в счётчик отказов апстрима');
    } finally {
        try { up.state.held && up.state.held.destroy(); } catch {}
        px.child.kill(); up.server.close();
    }
});

test('нормальный поток не считается отказом (контроль)', async () => {
    const up = await startUpstream();
    const px = await startProxy(up.port);
    try {
        up.state.mode = 'ok';
        const r = await postMessages(px.port);
        await sleep(250);
        const log = px.log();
        assert.equal(r.status, 200, `нормальный поток обязан дать 200, получили ${r.status}`);
        assert.match(r.text, /"text":"OK"/, 'содержимое должно доехать до клиента');
        assert.doesNotMatch(log, /empty_stream/, 'успешный ответ нельзя писать в отказы');
        assert.doesNotMatch(log, /клиент ушёл до контента/, 'успешный ответ — не уход клиента');
    } finally {
        px.child.kill(); up.server.close();
    }
});

test('счётчик clientGone виден в статусе отдельно от errors', async () => {
    const up = await startUpstream();
    const px = await startProxy(up.port);
    try {
        up.state.mode = 'empty';
        await postMessages(px.port, { timeoutMs: 150 });
        await sleep(600);
        const st = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: px.port, path: '/__agentrouter/api/status' }, res => {
                let b = ''; res.on('data', c => b += c);
                res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
            }).on('error', reject);
        });
        assert.equal(typeof st.stats.clientGone, 'number',
            'stats.clientGone обязан быть числом — иначе диагностика снова врёт');
    } finally {
        px.child.kill(); up.server.close();
    }
});

// ── Классификация отказов: 429 только по явному transient-коду ───────────────
// Требование приёмки: не преобразовывать ЛЮБОЙ пустой поток в 429 и не выдавать
// ложный 200. Проверяем на живом конвертере через mock-upstream.
test('явный rate_limit в SSE → 429, а не 502 и не 200', async () => {
    const up = await startUpstream();
    const px = await startProxy(up.port);
    try {
        up.state.mode = 'ratelimit';
        const r = await postMessages(px.port);
        // Наружу обязан уйти отказ вида rate_limit (клиент его ретраит), не пустой 200.
        assert.ok(r.status !== 200 || /rate_limit/.test(r.text),
            `ожидали отказ вида rate_limit, получили ${r.status} ${r.text.slice(0, 100)}`);
        assert.match(r.text, /rate_limit|429/, 'клиент должен увидеть rate_limit, а не generic 502');
    } finally { px.child.kill(); up.server.close(); }
});

test('пустой поток НЕ превращается в 429', async () => {
    const up = await startUpstream();
    const px = await startProxy(up.port);
    try {
        up.state.mode = 'empty';
        const r = await postMessages(px.port);
        assert.doesNotMatch(r.text, /rate_limit_error/,
            'пустой поток — не лимит; выдавать его за 429 значит врать клиенту');
    } finally { px.child.kill(); up.server.close(); }
});

test('tool-call-only ответ считается содержательным, не пустым', async () => {
    const up = await startUpstream();
    const px = await startProxy(up.port);
    try {
        up.state.mode = 'tools';
        const r = await postMessages(px.port);
        await sleep(250);
        const log = px.log();
        assert.doesNotMatch(log, /empty_stream/,
            'ответ только с tool_call — это содержательный ответ, не пустой поток');
        assert.doesNotMatch(log, /клиент ушёл до контента/, 'клиент никуда не уходил');
    } finally { px.child.kill(); up.server.close(); }
});
