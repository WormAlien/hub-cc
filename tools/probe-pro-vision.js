'use strict';
// Подбор канала deepseek-v4-pro с рабочим ЗРЕНИЕМ: сужаем пул до одного канала,
// шлём синтетическую картинку с контрольным кодом, сравниваем ответ программно.
// Пул возвращается на прежний канал в finally. Платные запросы - по одному на канал.
const api = require('../routing/lib/a6api-api');
const probe = require('../routing/lib/a6api-probe');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const key = fs.readFileSync(path.join(os.homedir(), '.secrets', 'a6api-active-key.txt'), 'utf8').trim();
const MODEL = 'deepseek-v4-pro', TOKEN = 145381;

const call = body => new Promise(resolve => {
    const req = require('node:https').request({ hostname: 'api.a6api.com', path: '/v1/chat/completions', method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        let raw = ''; res.on('data', c => { raw += c; });
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ raw: raw.slice(0, 150) }); } });
    });
    req.on('error', e => resolve({ err: e.message })); req.end(body);
});
const capsOf = x => ({ input_price_micros: Number(x.input_price_micros), output_price_micros: Number(x.output_price_micros),
    cache_read_price_micros: Number(x.cache_read_price_micros || 0), cache_write_price_micros: 0, per_request_price_micros: 0 });
const bodyFor = (ch, caps) => ({ channels: [{ channel_id: ch, priority: null }], caps, sort_strategy: 'price_asc', user_priorities: {},
    auto_pool_enabled: false, min_ratio: '', max_ratio: '', min_cache_hit_rate_bps: null, fallback_enabled: false });

(async () => {
    const c = api.createClient();
    const channels = process.argv.slice(2).map(Number);
    const start = await c.route(TOKEN, MODEL);
    const restore = { id: start.id, channels: start.channels.map(x => x.channelId), strategy: start.strategy, caps: start.caps };
    const results = [];
    try {
        for (const ch of channels) {
            const d = await c.request('/api/marketplace/channels/search?' + new URLSearchParams({ model: MODEL, p: 1, page_size: 100 }));
            const x = (Array.isArray(d) ? d : (d.items || [])).find(r => Number(r.channel_id) === ch);
            if (!x) { results.push({ ch, verdict: 'нет в каталоге' }); continue; }
            const caps = capsOf(x);
            const cur = await c.route(TOKEN, MODEL);
            await c.request('/api/subscriptions/' + cur.id + '/config', { method: 'PUT', body: { ...bodyFor(ch, caps), expected_config_version: cur.version } });
            const f = probe.imageFixture(undefined, 'red');
            const r = await call(JSON.stringify({ model: MODEL, max_tokens: 4096, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: probe.imageParts(f) }] }));
            const txt = String((r.choices && r.choices[0] && r.choices[0].message || {}).content || '');
            let ok = false;
            try { const o = JSON.parse(txt.trim().replace(/^```json\s*|\s*```$/g, '')); ok = String(o.code) === f.code && o.color === f.color; } catch { /* пустой или не JSON */ }
            results.push({ ch, supplier: x.supplier_name, input: Number(x.input_price_micros) / 1e6, output: Number(x.output_price_micros) / 1e6,
                verdict: ok ? 'vision OK' : (r.error ? 'отказ пула' : 'неверный ответ'), sample: txt.slice(0, 60) });
        }
    } finally {
        const now = await c.route(TOKEN, MODEL);
        const d = await c.request('/api/marketplace/channels/search?' + new URLSearchParams({ model: MODEL, p: 1, page_size: 100 }));
        const rows = (Array.isArray(d) ? d : (d.items || []));
        const back = rows.filter(x => restore.channels.includes(Number(x.channel_id))).map(x => ({ channel_id: Number(x.channel_id), priority: null }));
        const capsBack = restore.caps || capsOf(rows.find(x => Number(x.channel_id) === restore.channels[0]));
        await c.request('/api/subscriptions/' + now.id + '/config', { method: 'PUT',
            body: { ...bodyFor(restore.channels[0], capsBack), channels: back, expected_config_version: now.version } });
        console.error('пул возвращён на ' + restore.channels.join(','));
    }
    console.log(JSON.stringify(results, null, 1));
})().catch(e => { console.error('ERR', e.code || '', e.message); process.exit(1); });
