// jw-openai-proxy.js — Anthropic→OpenAI конвертер для JustWoker GPT-моделей (:20164).
//
// Принимает запросы в формате Anthropic (/v1/messages), конвертирует в OpenAI
// и шлёт на api.justwoker.icu/v1/chat/completions. Ответ конвертирует обратно.
// Без WAF-обвязки — JustWoker её не требует.
//
// Ключ: активный аккаунт из routing/justwoker-sessions.json (active: true).
// Перечитывается на каждый запрос — смена ключа в дашборде работает без рестарта.
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 20164);
const UPSTREAM_BASE = 'https://api.justwoker.icu';
const SESSIONS_FILE = path.join(__dirname, 'justwoker-sessions.json');
const REQUEST_TIMEOUT_MS = 600000;
const MAX_TOKENS_LIMIT = 64000;

const upstream = new URL(UPSTREAM_BASE);

// ── Ключ: активный аккаунт из justwoker-sessions.json ────────────────────────
function resolveKey(req) {
    try {
        const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
        const sessions = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        const active = sessions.find(s => s.active && s.api_key);
        if (active) return active.api_key;
    } catch {}
    // fallback: ключ из заголовка клиента
    const auth = req.headers['authorization'] || '';
    const fromHeader = req.headers['x-api-key'] || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (fromHeader && fromHeader.trim() && fromHeader.trim() !== 'dummy') return fromHeader.trim();
    return '';
}

// ── Утилиты ───────────────────────────────────────────────────────────────────
function log(msg) {
    process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function writeJSON(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

function claudeError(res, code, message, errType) {
    if (res.headersSent || res.writableEnded) {
        try {
            res.write('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: errType || 'api_error', message } }) + '\n\n');
            res.end();
        } catch {}
        return;
    }
    writeJSON(res, code, { type: 'error', error: { type: errType || 'api_error', message } });
}

// ── Anthropic → OpenAI ────────────────────────────────────────────────────────
function systemToText(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) return system.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
    return '';
}

function toolResultToText(block) {
    const c = block.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(p => (p && p.type === 'text') ? p.text : JSON.stringify(p)).join('\n');
    if (c == null) return '';
    return JSON.stringify(c);
}

function convertClaudeToOpenAI(claudeReq) {
    const messages = [];
    const sys = systemToText(claudeReq.system);
    if (sys) messages.push({ role: 'system', content: sys });

    for (const msg of claudeReq.messages || []) {
        const content = msg.content;
        if (typeof content === 'string') {
            messages.push({ role: msg.role, content });
            continue;
        }
        if (!Array.isArray(content)) continue;

        if (msg.role === 'user') {
            for (const tr of content.filter(b => b.type === 'tool_result')) {
                messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: toolResultToText(tr) || '(empty)' });
            }
            const rest = content.filter(b => b.type === 'text');
            if (rest.length) messages.push({ role: 'user', content: rest.map(b => b.text).join('\n') });
        } else if (msg.role === 'assistant') {
            const texts = content.filter(b => b.type === 'text').map(b => b.text);
            const toolUses = content.filter(b => b.type === 'tool_use');
            const out = { role: 'assistant', content: texts.length ? texts.join('\n') : null };
            if (toolUses.length) {
                out.tool_calls = toolUses.map(tu => ({
                    id: tu.id, type: 'function',
                    function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
                }));
            }
            if (out.content !== null || out.tool_calls) messages.push(out);
        }
    }

    const req = {
        model: claudeReq.model,
        messages,
        max_tokens: Math.max(1, Math.min(claudeReq.max_tokens || 4096, MAX_TOKENS_LIMIT)),
        stream: !!claudeReq.stream,
    };
    if (claudeReq.stream) req.stream_options = { include_usage: true };
    if (claudeReq.temperature !== undefined) req.temperature = claudeReq.temperature;
    if (claudeReq.top_p !== undefined) req.top_p = claudeReq.top_p;
    if (claudeReq.stop_sequences && claudeReq.stop_sequences.length) req.stop = claudeReq.stop_sequences;
    if (claudeReq.tools && claudeReq.tools.length) {
        req.tools = claudeReq.tools.filter(t => t && t.name).map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
        }));
    }
    if (claudeReq.tool_choice) {
        const tc = claudeReq.tool_choice;
        if (tc.type === 'auto') req.tool_choice = 'auto';
        else if (tc.type === 'any') req.tool_choice = 'required';
        else if (tc.type === 'tool' && tc.name) req.tool_choice = { type: 'function', function: { name: tc.name } };
    }
    return req;
}

// ── OpenAI → Anthropic (non-stream) ──────────────────────────────────────────
function mapStopReason(r) {
    if (r === 'length') return 'max_tokens';
    if (r === 'tool_calls' || r === 'function_call') return 'tool_use';
    return 'end_turn';
}

function convertOpenAIToClaude(openaiResp, claudeReq) {
    const choice = (openaiResp.choices && openaiResp.choices[0]) || {};
    const msg = choice.message || {};
    const content = [];
    if (msg.content) content.push({ type: 'text', text: msg.content });
    for (const tc of msg.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
    if (!content.length) content.push({ type: 'text', text: '' });
    return {
        id: openaiResp.id ? openaiResp.id.replace(/^(chatcmpl|resp)/, 'msg') : `msg_${Date.now()}`,
        type: 'message', role: 'assistant', model: claudeReq.model, content,
        stop_reason: mapStopReason(choice.finish_reason), stop_sequence: null,
        usage: {
            input_tokens: (openaiResp.usage && openaiResp.usage.prompt_tokens) || 0,
            output_tokens: (openaiResp.usage && openaiResp.usage.completion_tokens) || 0,
        },
    };
}

// ── OpenAI SSE → Anthropic SSE ────────────────────────────────────────────────
function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function handleStreaming(clientRes, upstreamRes, claudeReq) {
    clientRes.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sseWrite(clientRes, 'message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: claudeReq.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    sseWrite(clientRes, 'ping', { type: 'ping' });

    let nextBlockIndex = 0, textBlockIndex = null, finishReason = null;
    const toolBlocks = new Map();
    let usage = { input_tokens: 0, output_tokens: 0 };
    let buffer = '', ended = false;

    function ensureTextBlock() {
        if (textBlockIndex !== null) return textBlockIndex;
        textBlockIndex = nextBlockIndex++;
        sseWrite(clientRes, 'content_block_start', { type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } });
        return textBlockIndex;
    }
    function closeTextBlock() {
        if (textBlockIndex === null) return;
        sseWrite(clientRes, 'content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
        textBlockIndex = null;
    }
    function processChunk(chunk) {
        const choice = (chunk.choices && chunk.choices[0]) || null;
        if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens || 0, output_tokens: chunk.usage.completion_tokens || 0 };
        if (!choice) return;
        const delta = choice.delta || {};
        if (delta.content) {
            sseWrite(clientRes, 'content_block_delta', { type: 'content_block_delta', index: ensureTextBlock(), delta: { type: 'text_delta', text: delta.content } });
        }
        for (const tc of delta.tool_calls || []) {
            const oi = tc.index || 0;
            let tb = toolBlocks.get(oi);
            if (!tb) {
                closeTextBlock();
                tb = { claudeIndex: nextBlockIndex++, id: tc.id || `toolu_${Date.now()}_${oi}`, name: (tc.function && tc.function.name) || '', started: false };
                toolBlocks.set(oi, tb);
            }
            if (tc.id) tb.id = tc.id;
            if (tc.function && tc.function.name) tb.name = tc.function.name;
            if (!tb.started && tb.name) {
                sseWrite(clientRes, 'content_block_start', { type: 'content_block_start', index: tb.claudeIndex, content_block: { type: 'tool_use', id: tb.id, name: tb.name, input: {} } });
                tb.started = true;
            }
            if (tb.started && tc.function && tc.function.arguments) {
                sseWrite(clientRes, 'content_block_delta', { type: 'content_block_delta', index: tb.claudeIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
            }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    function finish() {
        if (ended) return; ended = true;
        closeTextBlock();
        for (const tb of toolBlocks.values()) if (tb.started) sseWrite(clientRes, 'content_block_stop', { type: 'content_block_stop', index: tb.claudeIndex });
        sseWrite(clientRes, 'message_delta', { type: 'message_delta', delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
        sseWrite(clientRes, 'message_stop', { type: 'message_stop' });
        clientRes.end();
    }
    upstreamRes.on('data', data => {
        buffer += data.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try { processChunk(JSON.parse(payload)); } catch {}
        }
    });
    upstreamRes.on('end', finish);
    upstreamRes.on('error', () => { if (!ended) { ended = true; sseWrite(clientRes, 'error', { type: 'error', error: { type: 'api_error', message: 'upstream stream error' } }); clientRes.end(); } });
}

// ── Запрос на апстрим ─────────────────────────────────────────────────────────
function sendUpstream(bodyStr, apiKey, onResponse, onError) {
    const req = https.request({
        hostname: upstream.hostname,
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(bodyStr),
        },
        timeout: REQUEST_TIMEOUT_MS,
    }, onResponse);
    req.on('error', onError);
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.write(bodyStr);
    req.end();
    return req;
}

// ── Обработчик /v1/messages ───────────────────────────────────────────────────
function handleMessages(req, res, body) {
    let claudeReq;
    try { claudeReq = JSON.parse(body); }
    catch (e) { return claudeError(res, 400, 'invalid JSON: ' + e.message, 'invalid_request_error'); }

    const apiKey = resolveKey(req);
    if (!apiKey) return claudeError(res, 401, 'Нет активного ключа JustWoker (justwoker-sessions.json)', 'authentication_error');

    const openaiReq = convertClaudeToOpenAI(claudeReq);
    const bodyStr = JSON.stringify(openaiReq);
    log(`${claudeReq.model} stream=${!!claudeReq.stream}`);

    sendUpstream(bodyStr, apiKey, (upRes) => {
        if (upRes.statusCode !== 200) {
            let b = '';
            upRes.on('data', c => b += c);
            upRes.on('end', () => {
                let message = b.slice(0, 500);
                try { message = JSON.parse(b).error?.message || message; } catch {}
                log(`upstream ${upRes.statusCode}: ${message}`);
                claudeError(res, upRes.statusCode, message,
                    upRes.statusCode === 401 ? 'authentication_error' :
                    upRes.statusCode === 429 ? 'rate_limit_error' :
                    upRes.statusCode >= 500 ? 'api_error' : 'invalid_request_error');
            });
            return;
        }
        if (claudeReq.stream) return handleStreaming(res, upRes, claudeReq);
        let b = '';
        upRes.on('data', c => b += c);
        upRes.on('end', () => {
            try {
                const openaiResp = JSON.parse(b);
                writeJSON(res, 200, convertOpenAIToClaude(openaiResp, claudeReq));
            } catch (e) {
                claudeError(res, 502, 'bad upstream response: ' + e.message);
            }
        });
    }, (err) => claudeError(res, 502, 'upstream: ' + err.message));
}

// ── Сервер ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/__jw-openai/api/status') {
        const sessions = (() => { try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return []; } })();
        const active = sessions.find(s => s.active);
        return writeJSON(res, 200, { ok: true, port: PORT, upstream: UPSTREAM_BASE, activeKey: active ? '***' + active.api_key.slice(-6) : null, activeEmail: active ? active.email : null });
    }
    const url = (req.url || '').split('?')[0];
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
        if (url === '/v1/messages') return handleMessages(req, res, b);
        if (url === '/messages') return handleMessages(req, res, b);
        writeJSON(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'unknown endpoint: ' + url } });
    });
});

server.listen(PORT, '127.0.0.1', () => {
    log(`jw-openai-proxy listening on :${PORT} → ${UPSTREAM_BASE}`);
});
