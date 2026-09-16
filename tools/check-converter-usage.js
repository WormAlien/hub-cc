#!/usr/bin/env node
'use strict';
// Конвертер Anthropic → OpenAI: расход в ФИНАЛЬНОМ событии стрима.
//
// Что доказываем и почему именно это:
//  1. `message_delta` несёт `input_tokens`. Claude Code считает контекст сессии именно
//     оттуда: в `message_start` токенов ещё нет (там честный ноль), а если финальное
//     событие их не принесёт, в статуслайне вместо `⧉ 139k/1M` появляется `⧉ ?`.
//     Этот пропуск чинили дважды вручную (16.09 - agentrouter Responses-ветка, затем
//     custom-openai-proxy), и оба раза без теста - поэтому тест здесь.
//  2. `input_tokens` НАСТОЯЩИЙ, а не оценка: берётся `prompt_tokens` из ответа шлюза.
//  3. Ноль от шлюза оценку не затирает: часть шлюзов отвечает `prompt_tokens: 0`, и
//     отдать ноль значит вернуть `⧉ ?` обратно.
//
// Сети не касается: вместо шлюза - поддельный OpenAI-совместимый SSE-сервер.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const CONVERTER = path.join(ROOT, 'routing', 'custom-openai-proxy.js');
const UP_PORT = 20298;
const CV_PORT = 20297;

const failures = [];
const check = async (name, fn) => {
    try { await fn(); console.log(`PASS  ${name}`); }
    catch (e) { failures.push(name); console.log(`FAIL  ${name}  ← ${e.message}`); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convusage-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { } });

// ── Поддельный шлюз: OpenAI-совместимый SSE ─────────────────────────────────
let upstreamMode = 'usage';                    // 'usage' | 'no-usage' | 'zero-usage'
const upstream = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200); res.end('{}'); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        // Конвертер обязан попросить расход явно: без `include_usage` шлюз его не шлёт.
        assert.strictEqual(body.stream_options && body.stream_options.include_usage, true,
            'конвертер не запросил usage у шлюза (stream_options.include_usage)');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\n`);
        if (upstreamMode !== 'no-usage') {
            const usage = upstreamMode === 'zero-usage'
                ? { prompt_tokens: 0, completion_tokens: 0 }
                : { prompt_tokens: 42, completion_tokens: 7 };
            res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    });
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function startConverter(tag) {
    const configFile = path.join(TMP, `cfg-${tag}.json`);
    const keyFile = path.join(TMP, 'key.txt');
    fs.writeFileSync(keyFile, 'fk-test-key');
    fs.writeFileSync(configFile, JSON.stringify({
        port: CV_PORT, upstream: `http://127.0.0.1:${UP_PORT}/v1`,
        keyFile, modelMap: {}, providerName: 'Test',
    }));
    return spawn(process.execPath, [CONVERTER, configFile], { stdio: 'ignore' });
}

// Одна проба: поднять конвертер, попросить стрим, вернуть финальное usage.
async function ask(mode) {
    upstreamMode = mode;
    const child = startConverter(mode);
    try {
        for (let i = 0; i < 40; i++) {
            await wait(150);
            const ready = await new Promise(r => {
                const s = http.request({ host: '127.0.0.1', port: CV_PORT, path: '/v1/models', method: 'GET' }, () => r(true));
                s.on('error', () => r(false));
                s.end();
            });
            if (ready) break;
        }
        const body = JSON.stringify({ model: 'openai/gpt-5.6-terra', max_tokens: 16, stream: true,
            messages: [{ role: 'user', content: 'Say: ok' }] });
        const raw = await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: CV_PORT, path: '/v1/messages', method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
                (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); });
            req.on('error', reject);
            req.end(body);
        });
        const line = raw.split('\n').filter(l => l.startsWith('data: ') && l.includes('"message_delta"')).pop();
        assert.ok(line, `в стриме нет message_delta: ${raw.slice(0, 200)}`);
        return JSON.parse(line.slice(6)).usage || {};
    } finally {
        try { child.kill(); } catch { }
        await wait(200);
    }
}

(async () => {
    await new Promise(r => upstream.listen(UP_PORT, '127.0.0.1', r));

    await check('финальное событие несёт настоящий input_tokens шлюза', async () => {
        const u = await ask('usage');
        assert.strictEqual(u.input_tokens, 42, `input_tokens=${u.input_tokens} - не от шлюза`);
        assert.strictEqual(u.output_tokens, 7, `output_tokens=${u.output_tokens}`);
    });

    await check('нулевой расход шлюза не затирает оценку', async () => {
        const u = await ask('zero-usage');
        assert.ok(u.input_tokens > 0, `input_tokens=${u.input_tokens}: ноль вернёт «?» в статуслайн`);
        assert.ok(u.output_tokens > 0, `output_tokens=${u.output_tokens}`);
    });

    await check('шлюз без usage вовсе - оценка, а не ноль', async () => {
        const u = await ask('no-usage');
        assert.ok(u.input_tokens > 0, `input_tokens=${u.input_tokens}`);
        assert.ok(u.output_tokens > 0, `output_tokens=${u.output_tokens}`);
    });

    upstream.close();
    console.log(failures.length
        ? `\n[FAIL] провалено ${failures.length}: ${failures.join('; ')}`
        : '\n[OK] конвертер отдаёт расход в финальном событии');
    process.exit(failures.length ? 1 : 0);
})();
