// Xingchi: Anthropic Messages ↔ OpenAI Responses. One upstream generation per request.
// Keepalive :20186 → converter :20187. XC_LISTEN_PORT / XC_UPSTREAM_BASE / XC_KEY_FILE
// override the defaults. Caller-selected keys take precedence over the Xingchi file.
// Tier mapping reloads routing/xingchi-modelmap.json ({opus, sonnet, haiku}) by mtime.
//
// 🔴 ДВА СВОЙСТВА ПЛОЩАДКИ, ИЗ-ЗА КОТОРЫХ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ (замер 21.11.2026, живой
// ключ владельца):
//
//  1. Открыт ТОЛЬКО Responses API. Claude Code и Hermes говорят Anthropic-форматом, и
//     их прямые пути закрыты:
//        POST /v1/messages         → 403 {"type":"permission_error",
//                                       "message":"This group does not allow /v1/messages dispatch"}
//        POST /v1/chat/completions → 400 {"code":"chat_completions_disabled", ... please use /v1/responses}
//        POST /v1/responses        → 200, живой ответ gpt-6.1-sol
//     Значит keepalive НЕЛЬЗЯ пускать на корень api.xingchiapi.com напрямую: он шлёт
//     `/v1/messages` и получил бы 403 на каждом запросе. Апстримом keepalive служит СВОЙ
//     конвертер, который переводит Anthropic → Responses:
//        Claude Code → keepalive :20186 → конвертер :20187 → api.xingchiapi.com /v1/responses
//
//  2. Кромка пускает ТОЛЬКО известные харнессы по User-Agent. Запрос без UA (дефолт Node,
//     curl, python-requests) отвечает 403 client_not_allowed со списком разрешённых
//     клиентов; тот же запрос с `claude-cli/...` — 200. Поэтому апстрим-заголовки
//     ОБЯЗАНЫ нести harness-UA: без него конвертер отдавал бы 403 на каждом запросе, а
//     снаружи это выглядело бы как «ключ не работает».
//     Живая проба 21.11: `claude-cli/2.1.220 (external, cli)` → 200.
//
// 🪤 Комментарий эталона kktoken про «каждый четвёртый POST отдаёт пустой 403 от кромки
// Cloudflare» здесь НЕ подтверждён и в этот файл не переносится: замер 21.11 — отказы
// приходят по UA-фильтру, а не по счётчику запросов. Ретрай 403 в keepalive-proxy.js
// остаётся страховкой, а не замеренным фактом этой площадки.

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { responsesUsageToAnthropic } = require('./lib/usage-normalize.js');
const { createLogger } = require('./proxy-logger.js');
const { logLine } = createLogger('xingchi');

const LISTEN_PORT = Number(process.env.XC_LISTEN_PORT || 20187);
const UPSTREAM_BASE = String(process.env.XC_UPSTREAM_BASE || 'https://api.xingchiapi.com/v1').replace(/\/+$/, '');
const ACTIVE_KEY_FILE = process.env.XC_KEY_FILE || path.join(os.homedir(), '.claude', 'xingchi-active-key.txt');
const MODELMAP_FILE = path.join(__dirname, 'xingchi-modelmap.json');
const MAX_TOKENS_LIMIT = 64000;
const REQUEST_TIMEOUT_MS = 600000;
const RESPONSES_MIN_OUTPUT_TOKENS = 16;

// Кромка площадки пускает по UA только известные харнессы (см. шапку). Значение берём
// из того же набора, что и keepalive-прокси шлёт на catch-capable шлюзы: это настоящий
// идентификатор Claude Code, и он в белом списке площадки.
const CLIENT_USER_AGENT = 'claude-cli/2.1.220 (external, cli)';

const upstream = new URL(UPSTREAM_BASE);

// ══════════════════════ МОДЕЛИ ══════════════════════

// Reload the tier map without restarting the adapter.
const modelMapCache = { data: null, mtime: 0 };
function readModelMap() {
    const empty = { opus: '', sonnet: '', haiku: '' };
    try {
        const st = fs.statSync(MODELMAP_FILE);
        if (modelMapCache.data && st.mtimeMs === modelMapCache.mtime) return modelMapCache.data;
        const raw = fs.readFileSync(MODELMAP_FILE, 'utf8');
        const data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
        modelMapCache.data = { ...empty, ...data };
        modelMapCache.mtime = st.mtimeMs;
        return modelMapCache.data;
    } catch { return empty; }
}

// [1m] — метка окна Claude Code, апстриму не нужна: голое имя модели, суффикс даёт 400.
function stripWindow(model) {
    return String(model || '').replace(/\s*\[[^\]]*\]\s*$/, '');
}

const TIER_RE = [
    { tier: 'opus', re: /(^|[-_.\/])opus([-_.\/]|$)/i },
    { tier: 'sonnet', re: /(^|[-_.\/])sonnet([-_.\/]|$)/i },
    { tier: 'haiku', re: /(^|[-_.\/])haiku([-_.\/]|$)/i },
];

// claude-тир → модель площадки. Не-тир (уже целевое имя) проходит как есть, регистр НЕ
// понижаем: id моделей площадки регистрозависимы.
function applyModelMap(model) {
    const base = stripWindow(model);
    const mm = readModelMap();
    for (const { tier, re } of TIER_RE) {
        if (!mm[tier]) continue;
        if (re.test(base)) {
            if (mm[tier] !== base) logLine(`model map: ${base} → ${mm[tier]} (${tier})`);
            return mm[tier];
        }
    }
    return base;
}

// ══════════════════════ КЛЮЧ ══════════════════════

function resolveKey(req) {
    // Keepalive sends the selected account key in both headers; never replace it.
    const auth = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+(.+)$/i.exec(auth);
    for (const value of [req.headers['x-api-key'], bearer && bearer[1]]) {
        const key = String(value || '').trim();
        if (key && key !== 'dummy') return key;
    }
    try {
        return fs.readFileSync(ACTIVE_KEY_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
    } catch { return ''; }
}

function upstreamHeaders(apiKey, bodyLen) {
    const h = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        // 🔴 Обязателен: без harness-UA кромка площадки отвечает 403 client_not_allowed.
        'User-Agent': CLIENT_USER_AGENT,
    };
    if (bodyLen) h['Content-Length'] = bodyLen;
    return h;
}

function upstreamRequest(pathSuffix, apiKey, body, onResponse, onError) {
    const bodyStr = typeof body === 'string' ? body : (body ? JSON.stringify(body) : null);
    const mod = upstream.protocol === 'https:' ? https : http;
    const req = mod.request({
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: upstream.pathname.replace(/\/$/, '') + pathSuffix,
        method: bodyStr ? 'POST' : 'GET',
        headers: upstreamHeaders(apiKey, bodyStr ? Buffer.byteLength(bodyStr) : 0),
        timeout: REQUEST_TIMEOUT_MS,
    }, onResponse);
    req.on('error', onError);
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    if (bodyStr) req.write(bodyStr);
    req.end();
    return req;
}

// ══════════════════════ ANTHROPIC → RESPONSES ══════════════════════

function systemToText(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) return system.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
    return '';
}

function contentPartsFromClaude(blocks) {
    const parts = [];
    for (const b of blocks) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source && b.source.type === 'base64') {
            parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        } else if (b.type === 'image' && b.source && b.source.type === 'url') {
            parts.push({ type: 'image_url', image_url: { url: b.source.url } });
        }
    }
    return parts;
}

function toolResultToText(block) {
    const c = block.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(p => !p || p.type !== 'image').map(p => (p && p.type === 'text') ? p.text : (typeof p === 'string' ? p : JSON.stringify(p))).join('\n');
    if (c == null) return '';
    return JSON.stringify(c);
}

// Keep long historical call IDs paired within Responses' 64-character limit.
function responsesCallId(value) {
    const id = String(value || '');
    if (id.length <= 64) return id;
    return 'call_' + crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 59);
}

// Tools у Responses плоские: {type:'function', name, parameters}, не вложенный function.
function toolToResponses(t) {
    const params = t.input_schema || { type: 'object', properties: {} };
    return {
        type: 'function',
        name: t.name,
        description: t.description || '',
        parameters: { ...params, additionalProperties: false },
    };
}

const RESPONSES_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// Hermes шлёт effort через output_config.effort, Claude Code — через thinking.budget_tokens.
// Оба приводим к одному полю Responses; нераспознанное не выдумываем.
function reasoningEffortForResponses(claudeReq) {
    const explicit = String((claudeReq && claudeReq.output_config && claudeReq.output_config.effort) || '').toLowerCase();
    if (RESPONSES_REASONING_EFFORTS.has(explicit)) return explicit;
    const thinking = claudeReq && claudeReq.thinking;
    if (!thinking || typeof thinking !== 'object') return '';
    if (thinking.type === 'disabled') return 'none';
    const budget = Number(thinking.budget_tokens);
    const maxTokens = Number(claudeReq.max_tokens);
    if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(maxTokens) || maxTokens <= 0) return '';
    const minimum = 1024;
    if (maxTokens <= minimum) return 'high';
    const ratio = (Math.min(maxTokens, Math.max(minimum, budget)) - minimum) / (maxTokens - minimum);
    if (ratio < 0.15) return 'minimal';
    if (ratio < 0.42) return 'low';
    if (ratio < 0.80) return 'medium';
    if (ratio < 0.92) return 'high';
    return 'xhigh';
}

function convertClaudeToResponses(claudeReq) {
    const input = [];
    const sys = systemToText(claudeReq.system);

    for (const msg of claudeReq.messages || []) {
        const content = msg.content;
        if (typeof content === 'string') {
            input.push({ role: msg.role, content: [{ type: msg.role === 'assistant' ? 'output_text' : 'input_text', text: content }] });
            continue;
        }
        if (!Array.isArray(content)) continue;

        if (msg.role === 'user') {
            // tool_result у Responses — отдельный item верхнего слоя, не текст в сообщении.
            for (const tr of content.filter(b => b && b.type === 'tool_result')) {
                input.push({
                    type: 'function_call_output',
                    call_id: responsesCallId(tr.tool_use_id),
                    output: toolResultToText(tr) || '(empty)',
                });
            }
            const rest = content.filter(b => b && (b.type === 'text' || b.type === 'image'));
            if (rest.length) {
                const parts = contentPartsFromClaude(rest).map(p => {
                    if (p.type === 'text') return { type: 'input_text', text: p.text };
                    return { type: 'input_image', image_url: p.image_url.url };
                });
                input.push({ role: 'user', content: parts });
            }
        } else if (msg.role === 'assistant') {
            const texts = content.filter(b => b && b.type === 'text').map(b => b.text);
            if (texts.length) input.push({ role: 'assistant', content: [{ type: 'output_text', text: texts.join('\n') }] });
            for (const tu of content.filter(b => b && b.type === 'tool_use')) {
                input.push({
                    type: 'function_call',
                    call_id: responsesCallId(tu.id),
                    name: tu.name,
                    arguments: JSON.stringify(tu.input || {}),
                });
            }
        }
    }

    const req = {
        // Суффикс окна наверх не уходит: площадка получает голое имя модели.
        model: stripWindow(claudeReq.model),
        input,
        // Пол по output-токенам: проба валидации модели у CC шлёт max_tokens: 1, а Responses
        // на крошечном потолке отвечает 400 «Could not finish the message».
        max_output_tokens: Math.max(RESPONSES_MIN_OUTPUT_TOKENS,
            Math.min(claudeReq.max_tokens || 4096, MAX_TOKENS_LIMIT)),
        stream: !!claudeReq.stream,
        store: false,
    };
    if (sys) req.instructions = sys;
    if (claudeReq.temperature !== undefined) req.temperature = claudeReq.temperature;
    if (claudeReq.top_p !== undefined) req.top_p = claudeReq.top_p;
    const effort = reasoningEffortForResponses(claudeReq);
    if (effort) req.reasoning = { effort };

    if (claudeReq.tools && claudeReq.tools.length) {
        req.tools = claudeReq.tools.filter(t => t && t.name).map(toolToResponses);
    }
    if (claudeReq.tool_choice && req.tools && req.tools.length) {
        const tc = claudeReq.tool_choice;
        if (tc.type === 'auto') req.tool_choice = 'auto';
        else if (tc.type === 'any') req.tool_choice = 'required';
        else if (tc.type === 'tool' && tc.name) req.tool_choice = { type: 'function', name: tc.name };
    }
    return req;
}

// ══════════════════════ RESPONSES → ANTHROPIC ══════════════════════

function convertResponsesToClaude(resp, claudeReq) {
    const content = [];
    let stopReason = 'end_turn';

    for (const item of resp.output || []) {
        if (item.type === 'message') {
            for (const c of item.content || []) {
                if (c.type === 'output_text' && c.text) content.push({ type: 'text', text: c.text });
                else if (c.type === 'refusal' && c.refusal) content.push({ type: 'text', text: c.refusal });
            }
        } else if (item.type === 'function_call') {
            const parsed = JSON.parse(item.arguments || '{}');
            content.push({ type: 'tool_use', id: item.call_id || item.id, name: item.name, input: parsed });
        }
        // reasoning-айтемы пропускаем: в Anthropic-формате им соответствия нет.
    }

    if (resp.status === 'incomplete') {
        stopReason = resp.incomplete_details && resp.incomplete_details.reason === 'max_output_tokens'
            ? 'max_tokens' : 'end_turn';
    }
    if (content.some(b => b.type === 'tool_use')) stopReason = 'tool_use';
    if (!content.length) content.push({ type: 'text', text: '' });

    return {
        id: resp.id ? String(resp.id).replace(/^resp/, 'msg') : `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: claudeReq.model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: responsesUsageToAnthropic(resp.usage),
    };
}

// ══════════════════════ STREAMING ══════════════════════

function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Delay SSE headers until content, so pre-content failures retain an HTTP error status.
const RESPONSES_TRANSIENT_CODES = new Set(['rate_limit_exceeded', 'too_many_requests', 'server_error', 'overloaded']);

function responsesErrorInfo(ev) {
    const e = (ev && ev.type === 'response.failed' && ev.response && ev.response.error)
        || (ev && ev.error)
        || (ev && ev.type === 'error' && (ev.code || ev.message) ? ev : null)
        || null;
    if (!e) return null;
    return {
        code: e.code || e.type || 'unknown',
        message: e.message || JSON.stringify(e).slice(0, 300),
        transient: RESPONSES_TRANSIENT_CODES.has(e.code) || RESPONSES_TRANSIENT_CODES.has(e.type),
    };
}

function createResponsesEmitter(clientRes, claudeReq, { onTransientFail, onHardFail }) {
    let started = false;
    let ended = false;
    let failed = false;
    let terminalSeen = false;
    let nextBlockIndex = 0;
    let textBlockIndex = null;
    const toolBlocks = new Map();
    let usage = responsesUsageToAnthropic(null);
    let stopReason = 'end_turn';
    let buffer = '';

    function emitText(text) {
        if (!text) return;
        if (!started && toolBlocks.size) flushDeferredTools();
        const idx = ensureTextBlock();
        sseWrite(clientRes, 'content_block_delta', {
            type: 'content_block_delta', index: idx,
            delta: { type: 'text_delta', text },
        });
    }

    function commit() {
        if (started) return;
        started = true;
        clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        sseWrite(clientRes, 'message_start', {
            type: 'message_start',
            message: {
                id: msgId, type: 'message', role: 'assistant', model: claudeReq.model,
                content: [], stop_reason: null, stop_sequence: null,
                usage: { ...usage, output_tokens: 0 },
            },
        });
        sseWrite(clientRes, 'ping', { type: 'ping' });

    }

    function ensureTextBlock() {
        commit();
        if (textBlockIndex !== null) return textBlockIndex;
        textBlockIndex = nextBlockIndex++;
        sseWrite(clientRes, 'content_block_start', {
            type: 'content_block_start', index: textBlockIndex,
            content_block: { type: 'text', text: '' },
        });
        return textBlockIndex;
    }

    function closeTextBlock() {
        if (textBlockIndex === null) return;
        sseWrite(clientRes, 'content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
        textBlockIndex = null;
    }

    function closeAllToolBlocks() {
        for (const tb of toolBlocks.values()) {
            if (tb.started && !tb.closed) {
                sseWrite(clientRes, 'content_block_stop', { type: 'content_block_stop', index: tb.claudeIndex });
                tb.closed = true;
            }
        }
    }

    function onToolBlock(index, tb) {
        if (tb.started) return;
        if (!tb.name) return;
        commit();
        closeTextBlock();
        tb.claudeIndex = nextBlockIndex++;
        sseWrite(clientRes, 'content_block_start', {
            type: 'content_block_start', index: tb.claudeIndex,
            content_block: { type: 'tool_use', id: tb.id || `toolu_${Date.now()}_${index}`, name: tb.name, input: {} },
        });
        tb.started = true;
    }

    function emitToolArguments(tb, delta) {
        if (!tb.started || !delta) return;
        sseWrite(clientRes, 'content_block_delta', {
            type: 'content_block_delta', index: tb.claudeIndex,
            delta: { type: 'input_json_delta', partial_json: delta },
        });
    }

    function closeToolBlock(tb) {
        if (!tb.started || tb.closed) return;
        sseWrite(clientRes, 'content_block_stop', { type: 'content_block_stop', index: tb.claudeIndex });
        tb.closed = true;
    }

    function flushDeferredTools() {
        for (const [index, tb] of [...toolBlocks.entries()].sort((a, b) => a[0] - b[0])) {
            if (tb.started) continue;
            try { JSON.parse(tb.arguments || '{}'); }
            catch { finish('upstream returned malformed tool arguments', 'api_error'); return; }
            onToolBlock(index, tb);
            emitToolArguments(tb, tb.arguments);
            closeToolBlock(tb);
        }
    }

    function processEvent(ev) {
        if (ended || failed || clientRes.destroyed) return;
        const type = ev.type;

        // ── Отказы апстрима: событием внутри 200 ──
        if (type === 'error' || type === 'response.failed') {
            const info = responsesErrorInfo(ev) || { code: 'failed', message: 'upstream response failed', transient: false };
            if (!started) {
                failed = true;
                if (info.transient) return onTransientFail(info);
                return onHardFail(info);
            }
            return finish(info.message, 'api_error');
        }

        if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
            emitText(String(ev.delta || ''));
            return;
        }

        if (type === 'response.output_item.added') {
            const it = ev.item || {};
            if (it.type === 'function_call') {
                const oi = ev.output_index || 0;
                const tb = { claudeIndex: -1, id: it.call_id || it.id, name: it.name || '', arguments: '', started: false, closed: false };
                toolBlocks.set(oi, tb);
                if (started) onToolBlock(oi, tb);
            }
            return;
        }

        if (type === 'response.function_call_arguments.delta') {
            const oi = ev.output_index || 0;
            let tb = toolBlocks.get(oi);
            if (!tb) {
                tb = { claudeIndex: -1, id: null, name: '', arguments: '', started: false, closed: false };
                toolBlocks.set(oi, tb);
            }
            if (ev.delta) tb.arguments += ev.delta;
            if (tb.started) emitToolArguments(tb, ev.delta);
            return;
        }

        if (type === 'response.output_item.done') {
            const it = ev.item || {};
            const oi = ev.output_index || 0;
            const tb = toolBlocks.get(oi);
            if (tb) {
                if (!tb.id && (it.call_id || it.id)) tb.id = it.call_id || it.id;
                if (!tb.name && it.name) tb.name = it.name;
                if (!tb.arguments && it.arguments) tb.arguments = it.arguments;
                try { JSON.parse(tb.arguments || '{}'); }
                catch { return finish('upstream returned malformed tool arguments', 'api_error'); }
                if (tb.started) closeToolBlock(tb);
            }
            return;
        }

        if (type === 'response.incomplete') {
            if (!ev.response || ev.response.status !== 'incomplete' || ev.response.error)
                return finish('invalid upstream response terminal', 'api_error');
            terminalSeen = true;
            const r = ev.response || {};
            const reason = r.incomplete_details && r.incomplete_details.reason;
            if (r.usage) usage = responsesUsageToAnthropic(r.usage);
            stopReason = reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn';
            if (toolBlocks.size) {
                stopReason = 'tool_use';
                if (!started) flushDeferredTools();
            }
            return;
        }

        if (type === 'response.completed') {
            if (!ev.response || !['completed', 'incomplete'].includes(ev.response.status) || ev.response.error)
                return finish('invalid upstream response terminal', 'api_error');
            terminalSeen = true;
            const r = ev.response || {};
            if (r.usage) usage = responsesUsageToAnthropic(r.usage);
            if (r.status === 'incomplete' && r.incomplete_details) {
                stopReason = r.incomplete_details.reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn';
            }
            if (toolBlocks.size) {
                stopReason = 'tool_use';
                if (!started) flushDeferredTools();
            }
            return;
        }
        // response.created / in_progress / reasoning.* — молча мимо.
    }

    function finish(errorMessage, errorType) {
        if (ended) return;
        if (!errorMessage && !terminalSeen) errorMessage = 'upstream stream ended without response terminal';
        ended = true;
        // Поток без единого осмысленного события — это отказ, а не «пустой ответ».
        if (!started) {
            if (failed) return;
            return onHardFail({ code: 'empty_stream', message: errorMessage || 'upstream вернул поток без содержимого' });
        }
        closeTextBlock();
        closeAllToolBlocks();
        if (errorMessage) {
            sseWrite(clientRes, 'error', { type: 'error', error: { type: errorType || 'api_error', message: errorMessage } });
            clientRes.end();
            return;
        }
        // Send final input/output/cache usage even for tool-only streams.
        sseWrite(clientRes, 'message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage,
        });
        sseWrite(clientRes, 'message_stop', { type: 'message_stop' });
        clientRes.end();
    }

    return {
        push(chunk) {
            buffer += chunk;
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                let event;
                try { event = JSON.parse(payload); }
                catch { finish('upstream returned malformed SSE', 'api_error'); return; }
                processEvent(event);
            }
        },
        finish() {
            if (buffer.trim()) this.push('\n');
            finish();
        },
        abort: (m) => finish(m || 'upstream stream error', 'api_error'),
    };
}

// ══════════════════════ HANDLERS ══════════════════════

const stats = { requests: 0, streamed: 0, errors: 0, lastModel: '', started: new Date().toISOString() };

function writeJSON(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

function claudeError(res, code, message, errType) {
    if (res.destroyed || res.writableEnded) return;
    stats.errors++;
    if (res.headersSent || res.writableEnded) {
        try {
            sseWrite(res, 'error', { type: 'error', error: { type: errType || 'api_error', message } });
        } catch {}
        try { res.end(); } catch {}
        return;
    }
    writeJSON(res, code, { type: 'error', error: { type: errType || 'api_error', message } });
}

function handleResponsesStreaming(clientRes, claudeReq, makeRequest) {
    let activeRequest = null;
    let finished = false;

    const run = () => {
        if (finished || clientRes.writableEnded || clientRes.destroyed) return;
        activeRequest = makeRequest((upRes) => {
            upRes.setEncoding('utf8');
            if (upRes.statusCode !== 200) {
                upRes.on('error', () => claudeError(clientRes, 502, 'upstream response interrupted', 'api_error'));
                let errBody = '';
                upRes.on('data', c => errBody += c);
                upRes.on('end', () => {
                    let message = errBody.slice(0, 500);
                    try {
                        const parsed = JSON.parse(errBody);
                        message = (parsed.error && (parsed.error.message || parsed.error.type)) || parsed.message || message;
                    } catch {}
                    logLine(`responses upstream ${upRes.statusCode}: ${String(message).slice(0, 200)}`);
                    finished = true;
                    claudeError(clientRes, upRes.statusCode, message,
                        upRes.statusCode === 401 ? 'authentication_error'
                            : upRes.statusCode === 429 ? 'rate_limit_error'
                            : upRes.statusCode >= 500 ? 'api_error' : 'invalid_request_error');
                });
                return;
            }

            const stream = createResponsesEmitter(clientRes, claudeReq, {

                onTransientFail: (info) => {
                    finished = true;
                    logLine(`responses: отказ до контента (${info.code}) - отдаю 429, ретраит клиент`);
                    claudeError(clientRes, 429, info.message, 'rate_limit_error');
                },
                onHardFail: (info) => {
                    finished = true;
                    logLine(`responses: отказ до контента (${info.code}) - отдаю 502`);
                    claudeError(clientRes, 502, info.message, 'api_error');
                },
            });
            upRes.on('data', (d) => stream.push(d));
            upRes.on('end', () => stream.finish());
            upRes.on('error', () => stream.abort('upstream stream error'));
        }, (err) => {
            if (finished) return;
            finished = true;
            logLine(`responses upstream error: ${err.message}`);
            claudeError(clientRes, 502, 'upstream: ' + err.message);
        });
    };

    run();
    const cancelUpstream = () => {
        finished = true;
        if (activeRequest && !activeRequest.destroyed) activeRequest.destroy();
    };
    clientRes.on('close', cancelUpstream);
    clientRes.on('error', cancelUpstream);
    return activeRequest;
}

function handleMessages(req, res, body) {
    let claudeReq;
    try { claudeReq = JSON.parse(body); }
    catch (e) { return claudeError(res, 400, 'invalid JSON: ' + e.message, 'invalid_request_error'); }

    const apiKey = resolveKey(req);
    if (!apiKey) return claudeError(res, 401, 'Нет ключа Xingchi (xingchi-active-key.txt пуст)', 'authentication_error');

    claudeReq.model = applyModelMap(claudeReq.model);

    let respReq;
    try { respReq = convertClaudeToResponses(claudeReq); }
    catch (e) { return claudeError(res, 400, 'convert failed: ' + e.message, 'invalid_request_error'); }

    stats.requests++;
    stats.lastModel = claudeReq.model;
    const effort = respReq.reasoning && respReq.reasoning.effort;
    logLine(`/v1/messages ${claudeReq.model} → /v1/responses stream=${!!claudeReq.stream} items=${respReq.input.length} tools=${(respReq.tools || []).length}${effort ? ` effort=${effort}` : ''}`);

    const makeRequest = (onResponse, onError) =>
        upstreamRequest('/responses', apiKey, respReq, onResponse, onError);

    if (claudeReq.stream) {
        stats.streamed++;
        return handleResponsesStreaming(res, claudeReq, makeRequest);
    }

    const activeRequest = makeRequest((upRes) => {
        upRes.setEncoding('utf8');
        upRes.on('error', () => claudeError(res, 502, 'upstream response interrupted', 'api_error'));
        if (upRes.statusCode !== 200) {
            let errBody = '';
            upRes.on('data', c => errBody += c);
            upRes.on('end', () => {
                let message = errBody.slice(0, 500);
                let code = '';
                try {
                    const parsed = JSON.parse(errBody);
                    message = (parsed.error && (parsed.error.message || parsed.error.type)) || parsed.message || message;
                    code = (parsed.error && parsed.error.code) || parsed.code || '';
                } catch {}
                logLine(`upstream ${upRes.statusCode}: ${String(message).slice(0, 200)}`);
                const errType = upRes.statusCode === 401 ? 'authentication_error'
                    : upRes.statusCode === 429 ? 'rate_limit_error'
                    : upRes.statusCode >= 500 ? 'api_error' : 'invalid_request_error';
                const groupClosed = /group does not allow|chat_completions_disabled/.test(message);
                claudeError(res, upRes.statusCode,
                    groupClosed ? 'xingchi закрыл прямой путь: площадка обслуживает только /v1/responses (и только для харнесс-клиентов по User-Agent)' : message,
                    errType);
            });
            return;
        }
        let b = '';
        upRes.on('data', c => b += c);
        upRes.on('end', () => {
            try {
                const parsed = JSON.parse(b);
                // Отказ может приехать телом с кодом 200 — та же семья, что ловится в стриме.
                const failed = parsed.error || !['completed', 'incomplete'].includes(parsed.status);
                if (failed) {
                    const info = responsesErrorInfo(parsed) || { code: 'failed', message: 'upstream вернул отказ', transient: false };
                    logLine(`responses (non-stream) отказ: ${info.code} — ${String(info.message).slice(0, 160)}`);
                    return claudeError(res, info.transient ? 429 : 502, info.message,
                        info.transient ? 'rate_limit_error' : 'api_error');
                }
                writeJSON(res, 200, convertResponsesToClaude(parsed, claudeReq));
            } catch (e) {
                logLine(`responses (non-stream) parse failed: ${e.message}`);
                claudeError(res, 502, 'upstream ответ не разобрался: ' + e.message, 'api_error');
            }
        });
    }, (err) => {
        logLine(`responses upstream error: ${err.message}`);
        claudeError(res, 502, 'upstream: ' + err.message);
    });
    const cancelUpstream = () => activeRequest.destroy();
    res.on('close', cancelUpstream);
    res.on('error', cancelUpstream);
}

function handleCountTokens(res, body) {
    try {
        const r = JSON.parse(body);
        let chars = systemToText(r.system).length;
        for (const m of r.messages || []) {
            if (typeof m.content === 'string') chars += m.content.length;
            else if (Array.isArray(m.content)) {
                for (const b of m.content) chars += (b.text || '').length + (b.type === 'tool_use' ? JSON.stringify(b.input || {}).length : 0);
            }
        }
        writeJSON(res, 200, { input_tokens: Math.max(1, Math.ceil(chars / 4)) });
    } catch (e) { claudeError(res, 400, e.message, 'invalid_request_error'); }
}

function handleModels(req, res) {
    const apiKey = resolveKey(req);
    if (!apiKey) return claudeError(res, 401, 'Нет ключа Xingchi', 'authentication_error');
    upstreamRequest('/models', apiKey, null, (upRes) => {
        let b = '';
        upRes.on('data', c => b += c);
        upRes.on('end', () => {
            res.writeHead(upRes.statusCode || 502, { 'Content-Type': 'application/json' });
            res.end(b);
        });
    }, (err) => claudeError(res, 502, 'upstream: ' + err.message));
}

// Глобальная защита: промах в одном запросе не должен ронять прокси.
process.on('uncaughtException', (e) => {
    try { logLine('WARN uncaught: ' + ((e && e.stack) || e)); } catch {}
});
process.on('unhandledRejection', (e) => {
    try { logLine('WARN rejection: ' + ((e && e.stack) || e)); } catch {}
});

const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && (url === '/health' || url === '/__xingchi/api/status')) {
        return writeJSON(res, 200, {
            ok: true, provider: 'xingchi', upstream: UPSTREAM_BASE, port: LISTEN_PORT, stats,
            protocol: 'anthropic /v1/messages → openai /v1/responses',
            clientUserAgent: CLIENT_USER_AGENT,
            modelMap: readModelMap(),
            keyFile: ACTIVE_KEY_FILE,
        });
    }
    if (req.method === 'GET' && url === '/v1/models') return handleModels(req, res);

    if (req.method === 'POST') {
        req.setEncoding('utf8');
        let b = '';
        req.on('data', c => b += c);
        req.on('end', () => {
            if (url === '/v1/messages') return handleMessages(req, res, b);
            if (url === '/v1/messages/count_tokens') return handleCountTokens(res, b);
            claudeError(res, 404, 'unknown endpoint: ' + url, 'not_found_error');
        });
        return;
    }

    claudeError(res, 404, 'not found', 'not_found_error');
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
    console.log(`[Xingchi Proxy] :${LISTEN_PORT} → ${UPSTREAM_BASE}/responses`);
    console.log(`  anthropic /v1/messages → openai /v1/responses`);
    console.log(`  key: selected caller key, then ${ACTIVE_KEY_FILE}`);
    console.log(`  status: http://localhost:${LISTEN_PORT}/__xingchi/api/status`);
});
