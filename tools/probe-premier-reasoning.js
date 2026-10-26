'use strict';
// Проба Premier: как шлюз принимает thinking-блоки в истории многоходового запроса.
// Ошибка `400 This reasoning model requires previous reasoning_content in multi-turn
// requests` приходит на историю, которую отдал он же сам, поэтому вариантов два:
// подпись виновата или сам блок. Проба отвечает замером, а не догадкой.
//
// Стоимость нулевая: Premier тарифицируется сообщениями Free-плана (50/сутки), не деньгами.
// Каждое сообщение списывает квоту аккаунта, поэтому по умолчанию один аккаунт и один
// запрос на вариант; `--accounts` показывает, у кого квота ещё жива.
//
//   node tools/probe-premier-reasoning.js --accounts
//   node tools/probe-premier-reasoning.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENDPOINT = 'https://ide.kgpix.bond/v1/messages';
const MODEL = 'deepseek-v4.1-flash-1017';
const SECRET_DIR = process.env.SECRET_DIR || path.join(os.homedir(), '.secrets');
const SESSIONS = path.join(SECRET_DIR, 'premier-sessions.json');
const ACTIVE = path.join(SECRET_DIR, 'premier-active-key.txt');

function accounts() {
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(SESSIONS, 'utf8')); } catch { rows = []; }
    if (!Array.isArray(rows)) rows = Object.values(rows || {});
    return rows.filter(a => a && typeof a.api_key === 'string' && a.api_key.startsWith('prm_'));
}
function activeKey() {
    try { return fs.readFileSync(ACTIVE, 'utf8').trim(); } catch { return ''; }
}
const mask = k => k ? k.slice(0, 6) + '***' + k.slice(-4) : '(нет)';

async function post(key, body) {
    const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'x-api-key': key, authorization: 'Bearer ' + key, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
    });
    const text = await r.text();
    let short = text.replace(/\s+/g, ' ').slice(0, 220);
    try { const j = JSON.parse(text); short = (j.error && (j.error.message || j.error.type)) || (j.content || []).map(b => b.text || b.type).join(' ').slice(0, 120); } catch { /* текст как есть */ }
    return { status: r.status, short };
}

// История, на которой шлюз падает в бою: ход с thinking, следом обычный вопрос.
function history(variant) {
    const assistant = () => {
        if (variant === 'signed') return [{ type: 'thinking', thinking: 'Проверяю ключ curl-ом.', signature: 'premier-gw' }, { type: 'text', text: 'Ключ рабочий.' }];
        if (variant === 'unsigned') return [{ type: 'thinking', thinking: 'Проверяю ключ curl-ом.', signature: '' }, { type: 'text', text: 'Ключ рабочий.' }];
        if (variant === 'thinking-only') return [{ type: 'thinking', thinking: 'Проверяю ключ curl-ом.', signature: 'premier-gw' }];
        return [{ type: 'text', text: 'Ключ рабочий.' }];
    };
    const toolTurn = [
        { role: 'user', content: 'Проверь ключ curl-ом.' },
        { role: 'assistant', content: [
            { type: 'thinking', thinking: 'Запущу curl.', signature: 'premier-gw' },
            { type: 'tool_use', id: 'toolu_probe_1', name: 'Bash', input: { command: 'curl -s https://ide.kgpix.bond/v1/models' } },
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_probe_1', content: '{"data":[]}' }] },
        { role: 'user', content: 'Ответь одним словом: да.' },
    ];
    // Ходы, которые боевой клиент кладёт ролью `system` ПРЯМО В messages: у Anthropic такой
    // роли в messages нет, и шлюз-конвертер может их выбрасывать вместе с цепочкой reasoning.
    const withSystem = [
        { role: 'user', content: 'Проверь ключ.' },
        { role: 'assistant', content: assistant() },
        { role: 'system', content: '<total_tokens>14959255 tokens left</total_tokens>' },
        { role: 'user', content: 'Ответь одним словом: да.' },
    ];
    if (variant === 'tool') return toolTurn;
    if (variant === 'system-role') return withSystem;
    if (variant === 'tool+system') return [...toolTurn.slice(0, 3), { role: 'system', content: '<total_tokens>14959255 tokens left</total_tokens>' }, toolTurn[3]];
    return [
        { role: 'user', content: 'Проверь, рабочий ли ключ.' },
        { role: 'assistant', content: assistant() },
        { role: 'user', content: 'Ответь одним словом: да.' },
    ];
}

const VARIANTS = [
    { name: 'no-thinking', thinking: null, note: 'история без блоков, thinking выключен' },
    { name: 'signed', thinking: { type: 'enabled', budget_tokens: 1024 }, note: 'подпись premier-gw, thinking включён' },
    { name: 'unsigned', thinking: { type: 'enabled', budget_tokens: 1024 }, note: 'пустая подпись, thinking включён' },
    { name: 'thinking-only', thinking: { type: 'enabled', budget_tokens: 1024 }, note: 'ход только из thinking, без текста' },
    { name: 'tool', thinking: { type: 'enabled', budget_tokens: 1024 }, note: 'tool_use + tool_result, thinking включён', tools: true },
    { name: 'system-role', thinking: { type: 'enabled', budget_tokens: 1024 }, note: 'роль system внутри messages' },
    { name: 'tool+system', thinking: { type: 'enabled', budget_tokens: 1024 }, note: 'tool-цикл плюс роль system', tools: true },
];

const TOOLS = [{ name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }];

// ── Реплей живого упавшего тела ───────────────────────────────────────────────
// Минимальные истории проходят (см. выше), значит причина в размере или в конкретном
// ходу. Реплей отвечает двоичным поиском по префиксу: какое самое короткое начало
// истории ещё падает. Каждый запрос - одно сообщение квоты Premier, не деньги.
async function replay(file) {
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pool = accounts();
    let key = '';
    for (const a of pool) {
        const r = await post(a.api_key, { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] });
        if (r.status === 200) { key = a.api_key; console.log('аккаунт для реплея:', a.name || '?'); break; }
    }
    if (!key) { console.log('нет аккаунта с квотой'); process.exitCode = 2; return; }
    const all = body.messages || [];
    const send = async (n) => {
        const b = { ...body, messages: all.slice(0, n), max_tokens: Math.min(body.max_tokens || 1024, 1024) };
        if (b.stream) { b.stream = false; delete b.stream_options; }
        const r = await post(key, b);
        console.log('  префикс', String(n).padStart(4), '/', all.length, '→', r.status, r.status !== 200 ? '| ' + r.short : '');
        return r.status;
    };
    console.log('тело:', path.basename(file), 'сообщений', all.length, body.messages ? '' : '');
    if (await send(all.length) === 200) { console.log('полное тело теперь проходит - отказ сменился, сравнить не с чем'); return; }
    let lo = 1, hi = all.length;   // lo проходит?, hi падает
    // Начало истории само по себе обычно валидно, но проверяем: если и оно падает, поиск не нужен.
    if (await send(3) !== 200) { console.log('падает даже короткое начало - причина не в длине истории'); return; }
    lo = 3;
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (await send(mid) === 200) lo = mid; else hi = mid;
    }
    console.log('порог: до', lo, 'сообщений проходит, с', hi, 'падает');
    const last = all[hi - 1];
    console.log('последний ход порога:', JSON.stringify(last).slice(0, 300));
}

(async () => {
    const idx = process.argv.indexOf('--replay');
    if (idx > 0 && process.argv[idx + 1]) return replay(process.argv[idx + 1]);
    const pool = accounts();
    const only = process.argv.includes('--accounts');
    console.log('аккаунтов в пуле:', pool.length, '| активный ключ:', mask(activeKey()));
    if (only) {
        for (const a of pool) {
            const r = await post(a.api_key, { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] });
            console.log(' ', (a.name || a.email || '?').padEnd(16), r.status, r.short);
        }
        return;
    }
    // Берём аккаунт, у которого есть квота: первый ответивший не-429.
    let key = '', used = '';
    for (const a of pool) {
        const r = await post(a.api_key, { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] });
        console.log('квота', (a.name || '?').padEnd(16), r.status, r.short);
        if (r.status === 200) { key = a.api_key; used = a.name || '?'; break; }
    }
    if (!key) { console.log('ни у одного аккаунта пула нет квоты - проба не состоялась'); process.exitCode = 2; return; }
    console.log('проверяю на аккаунте:', used);
    for (const v of VARIANTS) {
        const body = { model: MODEL, max_tokens: 64, messages: history(v.name) };
        if (v.thinking) body.thinking = v.thinking;
        if (v.tools) body.tools = TOOLS;
        const r = await post(key, body);
        console.log(' ', v.name.padEnd(14), r.status, '|', v.note, '|', r.short);
    }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
