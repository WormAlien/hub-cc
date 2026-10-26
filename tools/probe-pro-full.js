'use strict';
// Полная проверка канала: system-послушание, tool-цикл, две картинки, vision+tools.
// Тот же набор, что принимали у flash 25.10. Пул сужается до одного канала и
// возвращается в finally. Каждый тест - один платный запрос.
//
//   node tools/probe-pro-full.js 6596
//
const api = require('../routing/lib/a6api-api');
const probe = require('../routing/lib/a6api-probe');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const key = fs.readFileSync(path.join(os.homedir(), '.secrets', 'a6api-active-key.txt'), 'utf8').trim();
const MODEL = process.env.PRO_MODEL || 'deepseek-v4-pro';
const TOKEN = 145381;

const post = body => new Promise(resolve => {
    const req = require('node:https').request({
        hostname: 'api.a6api.com', path: '/v1/chat/completions', method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ raw: raw.slice(0, 200) }); } });
    });
    req.on('error', e => resolve({ err: e.message }));
    req.end(body);
});

const capsOf = x => ({
    input_price_micros: Number(x.input_price_micros),
    output_price_micros: Number(x.output_price_micros),
    cache_read_price_micros: Number(x.cache_read_price_micros || 0),
    cache_write_price_micros: 0,
    per_request_price_micros: 0,
});
const msgOf = r => (r && r.choices && r.choices[0] && r.choices[0].message) || {};
const textOf = r => String(msgOf(r).content || '');
const jsonOf = s => {
    try { return JSON.parse(String(s).trim().replace(/^```json\s*|\s*```$/g, '')); } catch { return null; }
};
const routeBody = (channels, caps, version) => ({
    channels, caps, sort_strategy: 'price_asc', user_priorities: {}, auto_pool_enabled: false,
    min_ratio: '', max_ratio: '', min_cache_hit_rate_bps: null, fallback_enabled: false,
    expected_config_version: version,
});

(async () => {
    const c = api.createClient();
    const ch = Number(process.argv[2]);
    if (!ch) throw new Error('укажи канал: node tools/probe-pro-full.js 6596');
    const start = await c.route(TOKEN, MODEL);
    const restore = { channels: start.channels.map(x => x.channelId), caps: start.caps };
    const out = { channel: ch, tests: [] };

    try {
        const d = await c.request('/api/marketplace/channels/search?' + new URLSearchParams({ model: MODEL, p: 1, page_size: 100 }));
        const x = (Array.isArray(d) ? d : (d.items || [])).find(r => Number(r.channel_id) === ch);
        if (!x) throw new Error('канал не в каталоге');
        const caps = capsOf(x);
        const cur = await c.route(TOKEN, MODEL);
        await c.request('/api/subscriptions/' + cur.id + '/config', { method: 'PUT',
            body: routeBody([{ channel_id: ch, priority: null }], caps, cur.version) });
        out.supplier = x.supplier_name;
        out.input = Number(x.input_price_micros) / 1e6;
        out.output = Number(x.output_price_micros) / 1e6;

        const nonce = 'ZEBRA-' + crypto.randomInt(10000, 99999);
        let r = await post(JSON.stringify({ model: MODEL, max_tokens: 256, thinking: { type: 'disabled' }, messages: [
            { role: 'system', content: 'Reply with exactly ' + nonce + ' and nothing else.' },
            { role: 'user', content: 'Hello.' }] }));
        out.tests.push({ name: 'system', ok: textOf(r).trim() === nonce, got: textOf(r).slice(0, 40) });

        const base = {
            model: MODEL, max_tokens: 512, thinking: { type: 'disabled' },
            messages: [
                { role: 'system', content: 'Call the requested tool, then report the marker from its result.' },
                { role: 'user', content: 'Call read_marker with tag a6.' }],
            tools: [{ type: 'function', function: { name: 'read_marker', description: 'Read test marker',
                parameters: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] } } }],
        };
        r = await post(JSON.stringify(base));
        const calls = msgOf(r).tool_calls || [];
        const callOk = calls.length === 1 && calls[0].function.name === 'read_marker'
            && JSON.parse(calls[0].function.arguments).tag === 'a6';
        out.tests.push({ name: 'tools', ok: callOk, got: calls.length ? calls[0].function.name : 'нет вызова' });

        if (callOk) {
            const marker = 'MARK-' + crypto.randomBytes(3).toString('hex');
            r = await post(JSON.stringify({ ...base, messages: [
                ...base.messages, msgOf(r),
                { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify({ marker }) }] }));
            out.tests.push({ name: 'tools-result', ok: textOf(r).includes(marker), got: textOf(r).slice(0, 50) });
        }

        for (const color of ['red', 'blue']) {
            const f = probe.imageFixture(undefined, color);
            r = await post(JSON.stringify({ model: MODEL, max_tokens: 2048, thinking: { type: 'disabled' },
                messages: [{ role: 'user', content: probe.imageParts(f) }] }));
            const o = jsonOf(textOf(r));
            out.tests.push({ name: 'vision-' + color,
                ok: !!o && String(o.code) === f.code && o.color === color, got: textOf(r).slice(0, 50) });
        }

        const f2 = probe.imageFixture(undefined, 'blue');
        r = await post(JSON.stringify({ model: MODEL, max_tokens: 2048, thinking: { type: 'disabled' },
            messages: [{ role: 'user', content: [
                { type: 'text', text: 'Read the digits and square color, then call report_card. Do not answer with text.' },
                probe.imageParts(f2)[1]] }],
            tools: [{ type: 'function', function: { name: 'report_card', description: 'Report the card',
                parameters: { type: 'object', properties: { code: { type: 'string' }, color: { type: 'string' } },
                    required: ['code', 'color'] } } }] }));
        const tc = (msgOf(r).tool_calls || [])[0];
        let vok = false;
        if (tc) { const o = JSON.parse(tc.function.arguments); vok = String(o.code) === f2.code && o.color === f2.color; }
        out.tests.push({ name: 'vision+tools', ok: vok, got: tc ? tc.function.arguments.slice(0, 60) : 'нет вызова' });
    } finally {
        const now = await c.route(TOKEN, MODEL);
        await c.request('/api/subscriptions/' + now.id + '/config', { method: 'PUT',
            body: routeBody(restore.channels.map(id => ({ channel_id: id, priority: null })), restore.caps, now.version) });
        console.error('пул возвращён на ' + restore.channels.join(','));
    }

    out.passed = out.tests.filter(t => t.ok).length;
    out.total = out.tests.length;
    console.log(JSON.stringify(out, null, 1));
    process.exit(out.passed === out.total ? 0 : 1);
})().catch(e => { console.error('ERR', e.code || '', e.message); process.exit(1); });
