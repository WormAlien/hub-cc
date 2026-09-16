// Живая приёмка Responses-пути для gpt-6-astra.
//
// Зачем отдельный скрипт: /v1/responses — это ВХОД, который видит анти-бот, поэтому
// голый curl получает `401 unauthorized client detected` (грабля, на которой уже умер
// jw-openai-proxy.js). Здесь повторяются боевые CC_HEADERS из
// routing/agentrouter-proxy.js, плюс WAF-санитайз: без него проба ловит
// `500 sensitive words detected` на собственной заглушке системного промпта.
//
// Ключ — ~/.claude/ar-active-key.txt, тот же, что у боевого конвертера.
//
// Запуск: node tools/probe-astra-live.js
// Ничего не пишет на диск в репозитории. Только сеть.

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const KEY = fs.readFileSync(path.join(os.homedir(), '.claude', 'ar-active-key.txt'), 'utf8').trim();
const MODEL = process.argv[2] || 'gpt-6-astra';

const CC_HEADERS = {
    'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
};

const TOOL = {
    type: 'function',
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

function post(pathSuffix, body) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        const req = https.request({
            hostname: 'agentrouter.org',
            path: pathSuffix,
            method: 'POST',
            headers: {
                ...CC_HEADERS,
                'authorization': `Bearer ${KEY}`,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
            },
            timeout: 180000,
        }, (res) => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
        req.on('error', e => resolve({ status: 0, body: e.message }));
        req.write(payload);
        req.end();
    });
}

function msgOf(s) {
    try { const j = JSON.parse(s); return j.error?.message || JSON.stringify(j).slice(0, 400); }
    catch { return String(s).slice(0, 400); }
}

// ── 1. /v1/responses С ТУЛАМИ — то, что объявил вендор ──
const withTools = {
    model: MODEL,
    instructions: 'You are a helpful AI assistant.',
    input: [
        { role: 'user', content: [{ type: 'input_text', text: 'What is the weather in Rostov-on-Don? Use the weather tool.' }] },
    ],
    tools: [TOOL],
    tool_choice: 'auto',
    max_output_tokens: 300,
    store: false,
    stream: false,
};

// ── 2. Тот же вызов в chat, СНИМАЯ наш костыль (что сейчас и падает у владельца) ──
const chatNoBypass = {
    model: MODEL,
    messages: [
        { role: 'system', content: 'You are a helpful AI assistant.' },
        { role: 'user', content: 'What is the weather in Rostov-on-Don? Use the weather tool.' },
    ],
    tools: [{ type: 'function', function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.parameters } }],
    max_tokens: 300,
    stream: false,
};

// ── 3. /v1/responses БЕЗ тулов — контроль: путь живой вообще? ──
const noTools = {
    model: MODEL,
    instructions: 'You are a helpful AI assistant.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Say OK.' }] }],
    max_output_tokens: 60,
    store: false,
    stream: false,
};

(async () => {
    console.log(`model: ${MODEL}`);
    console.log(`key:   ${KEY.slice(0, 8)}…${KEY.slice(-4)}\n`);

    console.log('── 1. /v1/responses + tools ──');
    const r1 = await post('/v1/responses', withTools);
    console.log(`   HTTP ${r1.status}  ${msgOf(r1.body)}`);
    if (r1.status === 200) {
        try {
            const j = JSON.parse(r1.body);
            const kinds = (j.output || []).map(o => `${o.type}${o.name ? ':' + o.name : ''}`);
            console.log(`   status=${j.status}  output: ${kinds.join(', ') || '(пусто)'}`);
            const call = (j.output || []).find(o => o.type === 'function_call');
            if (call) {
                console.log(`   ✅ tool_call: ${call.name}(${call.arguments})  call_id=${call.call_id}`);
            } else {
                console.log('   ⚠ тула в ответе нет — либо модель решила ответить текстом, либо форма tools не принята');
            }
            console.log(`   usage: ${JSON.stringify(j.usage)}`);
        } catch (e) { console.log(`   (разбор упал: ${e.message})`); }
    }

    console.log('\n── 2. /v1/chat/completions БЕЗ костыля (текущая боль) ──');
    const r2 = await post('/v1/chat/completions', chatNoBypass);
    console.log(`   HTTP ${r2.status}  ${msgOf(r2.body)}`);

    console.log('\n── 3. /v1/responses БЕЗ тулов (контроль живости пути) ──');
    const r3 = await post('/v1/responses', noTools);
    console.log(`   HTTP ${r3.status}  ${msgOf(r3.body)}`);

    console.log('\n── 4. /v1/responses + tools, СТРИМИНГ (нужен живой CC) ──');
    const r4 = await post('/v1/responses', { ...withTools, stream: true });
    if (r4.status === 200) {
        const evs = r4.body.split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => { try { return JSON.parse(l.slice(5).trim()).type; } catch { return null; } })
            .filter(Boolean);
        const uniq = [...new Set(evs)];
        console.log(`   HTTP 200, событий ${evs.length}, типов ${uniq.length}`);
        console.log(`   типы: ${uniq.slice(0, 12).join(', ')}`);
        console.log(`   есть response.completed: ${uniq.includes('response.completed')}`);
        console.log(`   есть function_call_arguments.delta: ${uniq.includes('response.function_call_arguments.delta')}`);
    } else {
        console.log(`   HTTP ${r4.status}  ${msgOf(r4.body)}`);
    }
})();
