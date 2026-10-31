// custom-openai-proxy.js — generic Anthropic → OpenAI прокси для Custom-провайдеров
//
// Claude Code шлёт Anthropic-формат (/v1/messages), прокси конвертирует в OpenAI
// chat/completions и отправляет на baseUrl провайдера (OpenAI-совместимый).
// Используется, когда провайдер НЕ говорит по Anthropic API (например bluesminds).
//
// Конфиг — JSON-файл, путь передаётся аргументом argv[2] (пишет transparent-proxy.js):
//   {
//     "port": 20150,
//     "upstream": "https://api.bluesminds.com/v1",
//     "keyFile": "C:\\...\\custom-active-key.txt",
//     "modelMap": { "opus": "z-ai/glm-5.2", "sonnet": "...", "haiku": "..." },
//     "providerName": "BluesMinds"
//   }
// Пустой map-элемент = передавать claude-имя модели как есть.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { StringDecoder } = require('node:string_decoder');

const CONFIG_FILE = process.argv[2];
const DEFAULT_KEY_FILE = path.join(os.homedir(), '.claude', 'custom-active-key.txt');
const MAX_TOKENS_LIMIT = 64000;
const MIN_TOKENS_LIMIT = 1024;
const REQUEST_TIMEOUT_MS = 600000;

let config = null;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (e) {
    console.error('[custom proxy] НЕ МОГУ ПРОЧИТАТЬ КОНФИГ:', e.message);
    process.exit(1);
}

const LISTEN_PORT = config.port || 20150;
const UPSTREAM_BASE = String(config.upstream || '').replace(/\/+$/, '');
const ACTIVE_KEY_FILE = config.keyFile || DEFAULT_KEY_FILE;
const MODEL_MAP = config.modelMap || {};
const PROVIDER_NAME = config.providerName || 'Custom';
// Opt in per instance. Existing Custom/Odyssey converters retain their legacy contract.
const STRICT_TOOLS_VISION = config.strictToolsVision === true;
const IS_A6API = STRICT_TOOLS_VISION && PROVIDER_NAME.toLowerCase() === 'a6api';
const A6API_ERROR_BODY_MAX = 64 * 1024;

const upstream = new URL(UPSTREAM_BASE);

function mapModel(claudeModel) {
    // [1m] — метка окна Claude Code, апстриму она не нужна: срезаем ДО тиров,
    // иначе claude-opus-4-6-thinking[1m] с пустой картой уезжает апстриму как есть
    // и тот отвечает model_not_found. Суффикс режут прокси — канон 1M-context-pin.
    const original = String(claudeModel || '').replace(/\[1m\]$/, '');
    const m = original.toLowerCase(), passthrough = STRICT_TOOLS_VISION ? original : m;
    if (m.includes('opus')) return MODEL_MAP.opus || passthrough;
    if (m.includes('sonnet')) return MODEL_MAP.sonnet || passthrough;
    if (m.includes('haiku')) return MODEL_MAP.haiku || passthrough;
    return passthrough;
}

function resolveKey(req) {
    if (STRICT_TOOLS_VISION) {
        // A missing active key is not permission to borrow the caller's or environment's key.
        try { return config.keyFile ? fs.readFileSync(ACTIVE_KEY_FILE, 'utf8').trim() : ''; }
        catch { return ''; }
    }
    const auth = req.headers['authorization'] || '';
    const fromHeader = req.headers['x-api-key'] || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (fromHeader && fromHeader.trim() && fromHeader !== 'dummy') return fromHeader.trim();
    try {
        const active = fs.readFileSync(ACTIVE_KEY_FILE, 'utf8').trim();
        if (active) return active;
    } catch {}
    return process.env.OPENAI_API_KEY || '';
}

// ══════════ ANTHROPIC → OPENAI ══════════

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
        } else if (STRICT_TOOLS_VISION && b.type === 'image' && b.source && b.source.type === 'url') {
            parts.push({ type: 'image_url', image_url: { url: b.source.url } });
        }
    }
    return parts;
}

function toolResultToText(block) {
    const c = block.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(p => !STRICT_TOOLS_VISION || !p || p.type !== 'image').map(p => (p && p.type === 'text') ? p.text : (typeof p === 'string' ? p : JSON.stringify(p))).join('\n');
    if (c == null) return '';
    return JSON.stringify(c);
}

// Грубая оценка токенов запроса (~4 символа на токен) для usage в ответе,
// когда апстрим не присылает реальный usage (игнорирует stream_options.include_usage).
function estimateTokens(claudeReq) {
    let chars = systemToText(claudeReq.system).length;
    for (const msg of claudeReq.messages || []) {
        const c = msg.content;
        if (typeof c === 'string') chars += c.length;
        else if (Array.isArray(c)) {
            for (const b of c) {
                if (b && b.type === 'text') chars += (b.text || '').length;
                else if (b && b.type === 'tool_use') chars += JSON.stringify(b.input || {}).length;
                else if (b && b.type === 'tool_result') {
                    chars += toolResultToText(b).length;
                    if (STRICT_TOOLS_VISION && Array.isArray(b.content)) chars += b.content.filter(p => p && p.type === 'image').length * 1024;
                } else if (STRICT_TOOLS_VISION && b && b.type === 'image') chars += 1024;
                else if (STRICT_TOOLS_VISION && b && b.type === 'thinking') chars += (b.thinking || '').length;
            }
        }
    }
    for (const t of claudeReq.tools || []) {
        chars += (t.name || '').length + (t.description || '').length + JSON.stringify(t.input_schema || {}).length;
    }
    return Math.max(1, Math.ceil(chars / 4));
}

// ── Обёртки <analysis>/<summary>: снять из истории, не трогая запрос сжатия ───
// Claude Code при сжатии контекста просит модель оформить сводку тегами `<analysis>`
// и `<summary>` и кладёт её в историю обычным текстом. Модель на a6api видит образец и
// начинает отвечать В ТОМ ЖЕ формате вместо ответа по делу: 25.10 за час накопилось
// 28 таких ответов, и каждый был новым образцом для следующего.
// Замер, который снял подозрение с провайдера: прямой запрос в площадку с 402k и 605k
// токенов входа и обычным вопросом («сколько будет два плюс два») вернул «Четыре» без
// единого тега. Значит режет не площадка, а имитация образца из истории.
// Поэтому обёртки снимаем из ИСХОДЯЩЕЙ истории (текст внутри сохраняем), а сам запрос
// на сжатие не трогаем: там теги - часть контракта с Claude Code, и без них `/compact`
// перестанет разбирать сводку. Гейт - по фразам инструкции, снятым из бинаря CC.
const COMPACT_PROMPT_RE = /detailed summary of the conversation|<analysis> tags to organize your thoughts/i;
const SCAFFOLD_TAG_RE = /<\/?(?:analysis|summary)>/i;
function stripSummaryScaffold(text) {
    const s = String(text);
    // Тела без тегов не трогаем вовсе: trim и склейка переводов меняли бы обычные
    // сообщения на каждом запросе, а это правка не по делу.
    if (!SCAFFOLD_TAG_RE.test(s)) return s;
    return s
        .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
        .replace(/<summary>([\s\S]*?)<\/summary>/gi, '$1')
        .replace(/<\/?(?:analysis|summary)>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
// Инструкция сжатия живёт в последнем пользовательском ходе; читаем три последних
// сообщения, а не всё тело: stringify двух мегабайт на каждом запросе - лишняя работа.
function isCompactionRequest(claudeReq) {
    const msgs = claudeReq.messages || [];
    for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 3; i--) {
        const c = msgs[i] && msgs[i].content;
        const text = typeof c === 'string' ? c
            : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n') : '';
        if (COMPACT_PROMPT_RE.test(text)) return true;
    }
    return false;
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
            const toolResults = content.filter(b => b.type === 'tool_result');
            const toolImages = [];
            for (const tr of toolResults) {
                messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: toolResultToText(tr) || '(empty)' });
                if (STRICT_TOOLS_VISION && Array.isArray(tr.content)) {
                    const images = contentPartsFromClaude(tr.content.filter(b => b && b.type === 'image'));
                    if (images.length) toolImages.push({ type: 'text', text: `Images returned by tool ${tr.tool_use_id}:` }, ...images);
                }
            }
            const rest = content.filter(b => b.type === 'text' || b.type === 'image');
            if (rest.length || toolImages.length) {
                const parts = [...toolImages, ...contentPartsFromClaude(rest)];
                const onlyText = parts.every(p => p.type === 'text');
                messages.push({ role: 'user', content: onlyText ? parts.map(p => p.text).join('\n') : parts });
            }
        } else if (msg.role === 'assistant') {
            const texts = content.filter(b => b.type === 'text').map(b => b.text);
            const toolUses = content.filter(b => b.type === 'tool_use');
            const out = { role: 'assistant' };
            out.content = texts.length ? texts.join('\n') : null;
            if (toolUses.length) {
                out.tool_calls = toolUses.map(tu => ({ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }));
                if (STRICT_TOOLS_VISION) out.reasoning_content = content.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('');
            }
            if (out.content !== null || out.tool_calls) messages.push(out);
        }
    }

    // Снятие обёрток сводки - ТОЛЬКО у нового экземпляра (a6api) и только когда это не
    // запрос сжатия. Старые Custom/Odyssey-инстансы идут прежним путём байт в байт.
    if (STRICT_TOOLS_VISION && !isCompactionRequest(claudeReq)) {
        for (const m of messages) {
            if (typeof m.content === 'string') m.content = stripSummaryScaffold(m.content);
            else if (Array.isArray(m.content)) {
                for (const p of m.content) if (p && p.type === 'text') p.text = stripSummaryScaffold(p.text);
            }
        }
    }

    const openaiReq = {
        model: mapModel(claudeReq.model),
        messages,
        max_tokens: Math.max(MIN_TOKENS_LIMIT, Math.min(claudeReq.max_tokens || MIN_TOKENS_LIMIT, MAX_TOKENS_LIMIT)),
        stream: !!claudeReq.stream,
    };
    if (claudeReq.stream) openaiReq.stream_options = { include_usage: true };
    if (STRICT_TOOLS_VISION && /deepseek/i.test(openaiReq.model) && claudeReq.thinking) {
        const type = claudeReq.thinking.type;
        if (['enabled', 'adaptive', 'disabled'].includes(type)) openaiReq.thinking = { type: type === 'disabled' ? 'disabled' : 'enabled' };
    }
    if (claudeReq.temperature !== undefined) openaiReq.temperature = claudeReq.temperature;
    if (claudeReq.top_p !== undefined) openaiReq.top_p = claudeReq.top_p;
    if (claudeReq.stop_sequences && claudeReq.stop_sequences.length) openaiReq.stop = claudeReq.stop_sequences;

    if (claudeReq.tools && claudeReq.tools.length) {
        openaiReq.tools = claudeReq.tools.filter(t => t && t.name).map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
        }));
    }
    if (claudeReq.tool_choice) {
        const tc = claudeReq.tool_choice;
        if (tc.type === 'auto') openaiReq.tool_choice = 'auto';
        else if (tc.type === 'any') openaiReq.tool_choice = 'required';
        else if (tc.type === 'tool' && tc.name) openaiReq.tool_choice = { type: 'function', function: { name: tc.name } };
    }
    return openaiReq;
}

// ══════════ OPENAI → ANTHROPIC (non-stream) ══════════

function mapStopReason(finishReason) {
    switch (finishReason) {
        case 'length': return 'max_tokens';
        case 'tool_calls': case 'function_call': return 'tool_use';
        case 'stop': default: return 'end_turn';
    }
}

function usageValue(value, fallback) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function convertOpenAIToClaude(openaiResp, claudeReq) {
    const choice = (openaiResp.choices && openaiResp.choices[0]) || {};
    const msg = choice.message || {};
    if (STRICT_TOOLS_VISION && (openaiResp.error || !choice.message || !['stop', 'length', 'tool_calls'].includes(choice.finish_reason))) throw new Error('invalid upstream response');
    const content = [];
    // Рассуждение reasoner-моделей приходит отдельным полем — см. подробный разбор в
    // стриминговой ветке (§ delta.reasoning_content). Здесь та же потеря: без этой
    // строки ответ дипсика, у которого весь бюджет ушёл на мысли, превращался в
    // `{type:'text', text:''}` ниже — пустой ответ без объяснения причины.
    const reasoning = msg.reasoning_content || msg.reasoning || '';
    if (reasoning && (STRICT_TOOLS_VISION || (process.env.REASONING_AS || 'thinking').toLowerCase() !== 'drop')) {
        content.push({ type: 'thinking', thinking: reasoning });
    }
    if (msg.content) content.push({ type: 'text', text: msg.content });
    for (const tc of msg.tool_calls || []) {
        let input = {};
        if (STRICT_TOOLS_VISION) {
            if (!tc.id || !tc.function || !tc.function.name) throw new Error('invalid upstream tool');
            input = JSON.parse(tc.function.arguments);
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid upstream tool arguments');
        } else { try { input = JSON.parse(tc.function.arguments || '{}'); } catch {} }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
    if (!content.length) content.push({ type: 'text', text: '' });
    return {
        id: openaiResp.id ? openaiResp.id.replace(/^chatcmpl/, 'msg') : `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: claudeReq.model,
        content,
        stop_reason: mapStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: STRICT_TOOLS_VISION ? usageValue(openaiResp.usage?.prompt_tokens, estimateTokens(claudeReq))
                : (openaiResp.usage && openaiResp.usage.prompt_tokens) || estimateTokens(claudeReq),
            output_tokens: STRICT_TOOLS_VISION ? usageValue(openaiResp.usage?.completion_tokens, Math.max(1, Math.ceil(((msg.content || '').length + reasoning.length + (msg.tool_calls || []).reduce((n, t) => n + t.function.arguments.length, 0)) / 4)))
                : (openaiResp.usage && openaiResp.usage.completion_tokens) || Math.max(1, Math.ceil(((msg.content || '').length + reasoning.length) / 4)),
        },
    };
}

// ══════════ UPSTREAM CALL ══════════

function upstreamRequest(pathSuffix, apiKey, body, onResponse, onError) {
    const bodyStr = body ? JSON.stringify(body) : null;
    const isHttps = upstream.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request({
        hostname: upstream.hostname,
        port: upstream.port || (isHttps ? 443 : 80),
        path: upstream.pathname.replace(/\/$/, '') + pathSuffix,
        method: body ? 'POST' : 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
        timeout: REQUEST_TIMEOUT_MS,
    }, onResponse);
    req.on('error', onError);
    req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
    return req;
}

// ══════════ STREAMING ══════════

function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function handleStreaming(clientRes, upstreamRes, claudeReq) {
    clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sseWrite(clientRes, 'message_start', {
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', model: claudeReq.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estimateTokens(claudeReq), output_tokens: 0 } },
    });
    sseWrite(clientRes, 'ping', { type: 'ping' });

    let nextBlockIndex = 0;
    let textBlockIndex = null;
    let thinkBlockIndex = null;
    const toolBlocks = new Map();
    let finishReason = null;
    let usage = { input_tokens: estimateTokens(claudeReq), output_tokens: STRICT_TOOLS_VISION ? null : 0 };
    let streamedChars = 0;
    let reasonedChars = 0;
    let buffer = '';
    const decoder = STRICT_TOOLS_VISION ? new StringDecoder('utf8') : null;
    let done = false, ended = false, upstreamBytes = 0;

    function streamError() {
        if (ended || clientRes.writableEnded || clientRes.destroyed) return;
        ended = true;
        sseWrite(clientRes, 'error', { type: 'error', error: { type: 'api_error', message: 'Incomplete or invalid upstream stream' } });
        clientRes.end(); upstreamRes.destroy();
    }

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
    // ── Рассуждение reasoner-моделей (delta.reasoning_content) ────────────────
    // DeepSeek и прочие reasoning-модели шлют мысли ОТДЕЛЬНЫМ полем, а ответ — в
    // delta.content. До 24.08 конвертер читал только второе, а первое молча
    // выбрасывал. В обычном случае это лишь прятало размышления, но у reasoner'а
    // весь бюджет max_tokens нередко уходит на них, `content` не приходит вовсе —
    // и клиент получал content_block_start с пустым текстом, ноль дельт и
    // content_block_stop, то есть ПУСТОЙ ОТВЕТ без единого признака причины.
    // Замер живьём (ai.fujcloud.com, deepseek-v4-flash, 24.08): в одном потоке
    // 31 событие, поля delta = content, reasoning_content, role. Оба поля есть.
    //
    // Мапим в thinking-блок Anthropic. Подпись (signature_delta) НЕ выдаём: её
    // требует только сам Anthropic при отправке блока ОБРАТНО, а сюда история
    // приходит через convertClaudeToOpenAI, где ассистентские блоки фильтруются
    // по `b.type === 'text'` — thinking отбрасывается и до шлюза не доезжает.
    // REASONING_AS=text — аварийный режим, если клиент не понимает thinking:
    // тогда рассуждение уходит обычным текстом, лишь бы не пропало.
    const REASONING_AS = STRICT_TOOLS_VISION ? 'thinking' : (process.env.REASONING_AS || 'thinking').toLowerCase();
    function ensureThinkBlock() {
        if (thinkBlockIndex !== null) return thinkBlockIndex;
        thinkBlockIndex = nextBlockIndex++;
        sseWrite(clientRes, 'content_block_start', {
            type: 'content_block_start', index: thinkBlockIndex,
            content_block: { type: 'thinking', thinking: '' },
        });
        return thinkBlockIndex;
    }
    function closeThinkBlock() {
        if (thinkBlockIndex === null) return;
        sseWrite(clientRes, 'content_block_stop', { type: 'content_block_stop', index: thinkBlockIndex });
        thinkBlockIndex = null;
    }
    // Блоки Anthropic не перекрываются: начался ответ или tool_call — рассуждение
    // обязано быть закрыто, иначе индексы поедут и клиент склеит блоки.
    function emitReasoning(text) {
        reasonedChars += text.length;
        if (REASONING_AS === 'drop') return;
        if (REASONING_AS === 'text') {
            const idx = ensureTextBlock();
            sseWrite(clientRes, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text } });
            return;
        }
        const idx = ensureThinkBlock();
        sseWrite(clientRes, 'content_block_delta', {
            type: 'content_block_delta', index: idx,
            delta: { type: 'thinking_delta', thinking: text },
        });
    }
    function processChunk(chunk) {
        if (STRICT_TOOLS_VISION && (!chunk || typeof chunk !== 'object' || chunk.error || !Array.isArray(chunk.choices))) throw new Error('invalid upstream event');
        const choice = (chunk.choices && chunk.choices[0]) || null;
        if (chunk.usage) {
            // 🪤 Ноль от шлюза НЕ затирает оценку: часть шлюзов отвечает
            // `prompt_tokens: 0` (или не отвечает вовсе), и тогда честнее отдать
            // приблизительное число, чем ноль - на нуле Claude Code рисует `⧉ ?`.
            usage = {
                input_tokens: STRICT_TOOLS_VISION ? usageValue(chunk.usage.prompt_tokens, usage.input_tokens) : chunk.usage.prompt_tokens || usage.input_tokens,
                output_tokens: STRICT_TOOLS_VISION ? usageValue(chunk.usage.completion_tokens, usage.output_tokens) : chunk.usage.completion_tokens || usage.output_tokens,
            };
        }
        if (!choice) return;
        const delta = choice.delta || {};
        // Рассуждение — ПЕРЕД ответом: у reasoner'а оно приходит первым, и открыть
        // текстовый блок раньше значило бы отдать мысли как ответ.
        if (delta.reasoning_content) emitReasoning(delta.reasoning_content);
        if (delta.content) {
            closeThinkBlock();
            streamedChars += delta.content.length;
            const idx = ensureTextBlock();
            sseWrite(clientRes, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: delta.content } });
        }
        for (const tc of delta.tool_calls || []) {
            if (STRICT_TOOLS_VISION) {
                if (!Number.isSafeInteger(tc.index) || tc.index < 0 || tc.index > 63) throw new Error('invalid tool index');
                let pending = toolBlocks.get(tc.index);
                if (!pending) { pending = { id: '', name: '', arguments: '' }; toolBlocks.set(tc.index, pending); }
                if (tc.id) {
                    if (pending.id && pending.id !== tc.id) throw new Error('changed tool ID');
                    pending.id = tc.id;
                }
                if (tc.function && tc.function.name) pending.name += tc.function.name;
                if (tc.function && tc.function.arguments) {
                    if (typeof tc.function.arguments !== 'string') throw new Error('invalid tool argument delta');
                    pending.arguments += tc.function.arguments;
                }
                continue;
            }
            const oi = tc.index || 0;
            let tb = toolBlocks.get(oi);
            if (!tb) {
                closeThinkBlock();
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
        if (STRICT_TOOLS_VISION) {
            if (ended) return;
            if (!done || !['stop', 'length', 'tool_calls'].includes(finishReason) || (toolBlocks.size > 0 && finishReason !== 'tool_calls') || (finishReason === 'tool_calls' && !toolBlocks.size)) return streamError();
            const ids = new Set();
            for (const tb of toolBlocks.values()) {
                if (!tb.id || !tb.name || ids.has(tb.id)) return streamError();
                ids.add(tb.id);
                try {
                    const input = JSON.parse(tb.arguments);
                    if (!input || typeof input !== 'object' || Array.isArray(input)) return streamError();
                } catch { return streamError(); }
            }
            // Tool identity may arrive after arguments. Buffer tools until the stream is
            // complete, so the first Anthropic block carries the real ID and full name.
            closeThinkBlock(); closeTextBlock();
            for (const [, tb] of [...toolBlocks.entries()].sort((a, b) => a[0] - b[0])) {
                tb.claudeIndex = nextBlockIndex++; tb.started = true;
                sseWrite(clientRes, 'content_block_start', { type: 'content_block_start', index: tb.claudeIndex, content_block: { type: 'tool_use', id: tb.id, name: tb.name, input: {} } });
                sseWrite(clientRes, 'content_block_delta', { type: 'content_block_delta', index: tb.claudeIndex, delta: { type: 'input_json_delta', partial_json: tb.arguments } });
                streamedChars += tb.arguments.length + tb.name.length;
                sseWrite(clientRes, 'content_block_stop', { type: 'content_block_stop', index: tb.claudeIndex });
                tb.started = false;
            }
            ended = true;
        }
        closeThinkBlock();
        closeTextBlock();
        for (const tb of toolBlocks.values()) {
            if (tb.started) sseWrite(clientRes, 'content_block_stop', { type: 'content_block_stop', index: tb.claudeIndex });
        }
        // Рассуждение — тоже выходные токены, шлюз их считает и берёт за них деньги.
        // Без reasonedChars оценка врала в разы на reasoner-моделях: у них мыслей
        // бывает больше, чем ответа, а при обрыве до `content` оценка была бы 1 токен.
        const fallbackOut = Math.max(1, Math.ceil((streamedChars + reasonedChars) / 4));
        // 🎯 `input_tokens` в финальном событии обязателен. Claude Code берёт контекст
        // сессии ИМЕННО отсюда (как и в `message_start`, там честный ноль - токенов ещё
        // нет): без него окно считается нулевым и в статуслайне вместо `⧉ 139k/1M`
        // появляется `⧉ ?`. Тот же пропуск чинили 16.09 в соседнем конвертере -
        // `agentrouter-proxy.js:1052`, Responses-ветка (владелец на `gpt-6-astra[1m]`).
        // Значение настоящее: `prompt_tokens` из ответа шлюза (у OpenAI-пути он есть),
        // а если шлюз его не прислал - оценка, заложенная в `usage` при старте.
        sseWrite(clientRes, 'message_delta', { type: 'message_delta', delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null }, usage: { input_tokens: usage.input_tokens, output_tokens: STRICT_TOOLS_VISION ? usageValue(usage.output_tokens, fallbackOut) : usage.output_tokens || fallbackOut } });
        sseWrite(clientRes, 'message_stop', { type: 'message_stop' });
        clientRes.end();
    }
    function processLine(line) {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { done = true; return; }
        if (STRICT_TOOLS_VISION && done) throw new Error('data after stream completion');
        if (STRICT_TOOLS_VISION) processChunk(JSON.parse(payload));
        else { try { processChunk(JSON.parse(payload)); } catch {} }
    }
    upstreamRes.on('data', (data) => {
        if (STRICT_TOOLS_VISION && ended) return;
        try {
            upstreamBytes += data.length;
            if (STRICT_TOOLS_VISION && upstreamBytes > 8 * 1024 * 1024) return streamError();
            buffer += decoder ? decoder.write(data) : data.toString('utf8');
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
                processLine(line);
            }
        } catch { streamError(); }
    });
    upstreamRes.on('end', () => {
        if (STRICT_TOOLS_VISION) {
            if (ended) return;
            try { buffer += decoder.end(); if (buffer.trim()) processLine(buffer.trim()); }
            catch { return streamError(); }
        }
        finish();
    });
    if (STRICT_TOOLS_VISION) {
        upstreamRes.on('aborted', streamError);
        upstreamRes.on('close', () => { if (!upstreamRes.complete) streamError(); });
    }
    upstreamRes.on('error', () => {
        if (STRICT_TOOLS_VISION) return streamError();
        try {
            sseWrite(clientRes, 'error', { type: 'error', error: { type: 'api_error', message: 'upstream stream error' } });
            clientRes.end();
        } catch {}
    });
}

// ══════════ HANDLERS ══════════

const stats = { requests: 0, streamed: 0, errors: 0, lastModel: '', started: new Date().toISOString() };

function writeJSON(res, code, obj) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, Authorization',
    });
    res.end(JSON.stringify(obj));
}
function a6apiSellerError(raw, model) {
    if (!IS_A6API || !raw || raw.length > A6API_ERROR_BODY_MAX) return null;
    let doc;
    try { doc = JSON.parse(raw.toString('utf8')); } catch { return null; }
    const code = doc && (doc.code || doc.error && doc.error.code);
    if (code !== 'smart_route_no_active_candidates') return null;
    return {
        code: 409,
        type: 'invalid_request_error',
        message: `a6api: у модели ${model} нет доступного продавца. Выбранный продавец недоступен или удалён. Выберите другого продавца в кабинете a6api или смените модель.`,
    };
}
function claudeError(res, code, message, errType) {
    if (STRICT_TOOLS_VISION) {
        if (res.writableEnded || res.destroyed) return;
        if (res.headersSent) {
            stats.errors++;
            sseWrite(res, 'error', { type: 'error', error: { type: errType || 'api_error', message } });
            return res.end();
        }
    }
    stats.errors++;
    writeJSON(res, code, { type: 'error', error: { type: errType || 'api_error', message } });
}
const { createLogger } = require('./proxy-logger.js');
const { logLine } = createLogger('custom-oa');

function handleMessages(req, res, body) {
    let claudeReq;
    try { claudeReq = JSON.parse(body); }
    catch (e) { return claudeError(res, 400, 'invalid JSON: ' + e.message, 'invalid_request_error'); }

    const apiKey = resolveKey(req);
    if (!apiKey) return claudeError(res, 401, 'Нет ключа ' + PROVIDER_NAME, 'authentication_error');

    let openaiReq;
    try { openaiReq = convertClaudeToOpenAI(claudeReq); }
    catch (e) { return claudeError(res, 400, 'convert failed: ' + e.message, 'invalid_request_error'); }

    stats.requests++;
    stats.lastModel = `${claudeReq.model} → ${openaiReq.model}`;
    logLine(`/v1/messages ${claudeReq.model} → ${openaiReq.model} stream=${!!claudeReq.stream} msgs=${openaiReq.messages.length} tools=${(openaiReq.tools || []).length}`);

    const upReq = upstreamRequest('/chat/completions', apiKey, openaiReq, (upRes) => {
        if (STRICT_TOOLS_VISION) {
            upRes.on('aborted', () => claudeError(res, 502, 'upstream response aborted'));
            upRes.on('error', () => claudeError(res, 502, 'upstream response error'));
        }
        if (upRes.statusCode !== 200) {
            let errBody = '', strictChunks = [], strictSize = 0, strictOverflow = false;
            upRes.on('data', c => {
                if (!STRICT_TOOLS_VISION) { errBody += c; return; }
                if (!IS_A6API || strictOverflow) return;
                if (strictSize + c.length > A6API_ERROR_BODY_MAX) {
                    strictChunks = []; strictSize = 0; strictOverflow = true; return;
                }
                strictChunks.push(c); strictSize += c.length;
            });
            upRes.on('end', () => {
                const sellerError = !strictOverflow && a6apiSellerError(Buffer.concat(strictChunks, strictSize), openaiReq.model);
                if (sellerError) {
                    logLine(`upstream ${upRes.statusCode}: smart_route_no_active_candidates for ${openaiReq.model}`);
                    return claudeError(res, sellerError.code, sellerError.message, sellerError.type);
                }
                let message = STRICT_TOOLS_VISION ? 'upstream HTTP ' + upRes.statusCode : errBody.slice(0, 500);
                if (!STRICT_TOOLS_VISION) { try { message = JSON.parse(errBody).error?.message || message; } catch {} }
                logLine(`upstream ${upRes.statusCode}: ${message.slice(0, 200)}`);
                const errType = upRes.statusCode === 401 ? 'authentication_error'
                    : upRes.statusCode === 429 ? 'rate_limit_error'
                    : upRes.statusCode >= 500 ? 'api_error' : 'invalid_request_error';
                claudeError(res, upRes.statusCode, message, errType);
            });
            return;
        }
        if (claudeReq.stream) {
            stats.streamed++;
            handleStreaming(res, upRes, claudeReq);
        } else {
            let b = '';
            if (STRICT_TOOLS_VISION) upRes.setEncoding('utf8');
            upRes.on('data', c => b += c);
            upRes.on('end', () => {
                try { writeJSON(res, 200, convertOpenAIToClaude(JSON.parse(b), claudeReq)); }
                catch (e) { claudeError(res, 502, STRICT_TOOLS_VISION ? 'bad upstream response' : 'bad upstream response: ' + e.message); }
            });
        }
    }, (err) => {
        logLine(`upstream error: ${err.message}`);
        claudeError(res, 502, STRICT_TOOLS_VISION ? 'upstream request failed' : 'upstream: ' + err.message);
    });

    res.on('close', () => { if (!res.writableEnded) upReq.destroy(); });
}

function handleCountTokens(res, body) {
    try {
        const r = JSON.parse(body);
        if (STRICT_TOOLS_VISION) return writeJSON(res, 200, { input_tokens: estimateTokens(r) });
        let chars = systemToText(r.system).length;
        for (const m of r.messages || []) {
            if (typeof m.content === 'string') chars += m.content.length;
            else if (Array.isArray(m.content)) {
                for (const b of m.content) chars += (b.text || '').length + (b.type === 'tool_use' ? JSON.stringify(b.input || {}).length : 0);
            }
        }
        writeJSON(res, 200, { input_tokens: Math.max(1, Math.ceil(chars / 4)) });
    } catch (e) {
        claudeError(res, 400, e.message, 'invalid_request_error');
    }
}

function handleModels(req, res) {
    const apiKey = resolveKey(req);
    if (STRICT_TOOLS_VISION && !apiKey) return claudeError(res, 401, 'Нет ключа ' + PROVIDER_NAME, 'authentication_error');
    upstreamRequest('/models', apiKey, null, (upRes) => {
        let b = '';
        upRes.on('data', c => b += c);
        upRes.on('end', () => {
            res.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(b);
        });
    }, (err) => claudeError(res, 502, 'upstream: ' + err.message));
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, Authorization' });
        return res.end();
    }
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (url === '/health' || url === '/__custom/api/status')) {
        return writeJSON(res, 200, { ok: true, provider: PROVIDER_NAME, upstream: UPSTREAM_BASE, port: LISTEN_PORT, modelMap: MODEL_MAP, stats, ...(!STRICT_TOOLS_VISION ? { keyFile: ACTIVE_KEY_FILE } : {}) });
    }
    if (req.method === 'GET' && url === '/v1/models') return handleModels(req, res);
    if (req.method === 'POST') {
        let b = '';
        if (STRICT_TOOLS_VISION) req.setEncoding('utf8');
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
    logLine(`[Custom OpenAI Proxy] ${PROVIDER_NAME} :${LISTEN_PORT} → ${UPSTREAM_BASE}`);
    logLine(`  mapping: opus→${MODEL_MAP.opus || '(pass-through)'}, sonnet→${MODEL_MAP.sonnet || '(pass-through)'}, haiku→${MODEL_MAP.haiku || '(pass-through)'}`);
    logLine(`  key: client header → ${ACTIVE_KEY_FILE}`);
    logLine(`  status: http://localhost:${LISTEN_PORT}/__custom/api/status`);
});
