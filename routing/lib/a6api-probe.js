'use strict';
// Explicit, bounded capability tests. No background jobs, shell execution or real tools.
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SECRET_DIR, ApiError } = require('./a6api-api');
const DIGITS = {
    0: ['01110','10001','10011','10101','11001','10001','01110'], 1: ['00100','01100','00100','00100','00100','00100','01110'],
    2: ['01110','10001','00001','00010','00100','01000','11111'], 3: ['11110','00001','00001','01110','00001','00001','11110'],
    4: ['00010','00110','01010','10010','11111','00010','00010'], 5: ['11111','10000','10000','11110','00001','00001','11110'],
    6: ['01110','10000','10000','11110','10001','10001','01110'], 7: ['11111','00001','00010','00100','01000','01000','01000'],
    8: ['01110','10001','10001','01110','10001','10001','01110'], 9: ['01110','10001','10001','01111','00001','00001','01110'],
};
function crc32(buffer) {
    let c = 0xffffffff;
    for (const b of buffer) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, body) {
    const t = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([t, body])));
    return Buffer.concat([size, t, body, crc]);
}
function imageFixture(code = String(crypto.randomInt(1000, 10000)), color = 'red') {
    if (!/^\d{4}$/.test(code) || !['red', 'blue', 'green'].includes(color)) throw new Error('Invalid image fixture');
    const width = 340, height = 180, stride = width * 3 + 1;
    const pixels = Buffer.alloc(stride * height, 255);
    for (let y = 0; y < height; y++) pixels[y * stride] = 0;
    function rect(x, y, w, h, rgb) {
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
            const p = yy * stride + 1 + xx * 3; pixels[p] = rgb[0]; pixels[p + 1] = rgb[1]; pixels[p + 2] = rgb[2];
        }
    }
    for (let n = 0; n < code.length; n++) DIGITS[code[n]].forEach((row, y) => {
        [...row].forEach((bit, x) => { if (bit === '1') rect(25 + n * 75 + x * 10, 15 + y * 10, 10, 10, [0, 0, 0]); });
    });
    rect(140, 110, 55, 55, { red: [230, 25, 25], blue: [20, 65, 235], green: [20, 175, 50] }[color]);
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
    return { code, color, base64: png.toString('base64'),
        prompt: 'Read the four digits and the color of the square in this image. Return only a JSON object with keys code (string) and color (English lowercase).' };
}
function imageParts(f) { return [{ type: 'text', text: f.prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + f.base64 } }]; }
function makeToolRound(model) {
    return { model, max_tokens: 512, stream: true, stream_options: { include_usage: true }, thinking: { type: 'enabled' },
        messages: [{ role: 'system', content: 'Call the requested tool. After its result, output only the marker value, without explanation.' },
            { role: 'user', content: 'Call read_marker with tag a6, then give me the marker from its result.' }],
        tools: [{ type: 'function', function: { name: 'read_marker', description: 'Read a test marker by tag.',
            parameters: { type: 'object', properties: { tag: { type: 'string', enum: ['a6'] } }, required: ['tag'], additionalProperties: false } } }] };
}
function toolFollowup(first, message, marker) {
    const calls = message.tool_calls || [];
    if (calls.length !== 1 || calls[0].function.name !== 'read_marker' || JSON.parse(calls[0].function.arguments).tag !== 'a6') throw new Error('Invalid tool call');
    return { ...first, messages: [...first.messages, message, { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify({ marker }) }] };
}
async function parseStream(response) {
    const message = { role: 'assistant', content: '' }, tools = [], decoder = new TextDecoder();
    let buffer = '', done = false, usage = null, model = null, finish = null, chars = 0;
    function line(raw) {
        const text = raw.trim(); if (!text.startsWith('data:')) return;
        const data = text.slice(5).trim(); if (data === '[DONE]') { done = true; return; }
        if (!data) return;
        const x = JSON.parse(data);
        if (x.error) throw new Error('Upstream stream error');
        if (x.model) model = x.model; if (x.usage) usage = x.usage;
        const choice = x.choices && x.choices[0]; if (!choice) return;
        if (choice.finish_reason) finish = choice.finish_reason;
        const d = choice.delta || {};
        if (d.content) message.content += d.content;
        if (d.reasoning_content) message.reasoning_content = (message.reasoning_content || '') + d.reasoning_content;
        for (const t of d.tool_calls || []) {
            const i = t.index || 0; if (i > 16) throw new Error('Too many tools');
            const out = tools[i] || (tools[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
            if (t.id) out.id = t.id;
            if (t.function && t.function.name) out.function.name += t.function.name;
            if (t.function && t.function.arguments) out.function.arguments += t.function.arguments;
        }
    }
    for await (const chunk of response.body) {
        chars += chunk.length; if (chars > 1024 * 1024) throw new Error('Response too large');
        buffer += decoder.decode(chunk, { stream: true });
        let idx; while ((idx = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, idx)); buffer = buffer.slice(idx + 1); }
    }
    buffer += decoder.decode(); if (buffer.trim()) line(buffer);
    if (!done || !finish) throw new Error('Incomplete SSE response');
    if (tools.length) message.tool_calls = tools.filter(Boolean);
    if (!message.content) message.content = null;
    return { message, usage, model, finish };
}
function jsonFromText(s) {
    const text = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(text);
}
function createRunner({ fetchImpl = globalThis.fetch, secretDir = SECRET_DIR, maxRequests = 32, budgetUsd = 0.05, now = Date.now } = {}) {
    const file = path.join(secretDir, 'a6api-probes.jsonl');
    const runFile = path.join(secretDir, 'a6api-probe-budget.json');
    function budget() {
        try { return JSON.parse(fs.readFileSync(runFile, 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; return { count: 0, usd: 0, budgetUsd, maxRequests }; }
    }
    function writeBudget(b) { fs.mkdirSync(secretDir, { recursive: true }); fs.writeFileSync(runFile, JSON.stringify(b) + '\n'); }
    async function call({ key, tokenId, channelId, body, test, validate, price }) {
        const b = budget();
        const estimate = ((price && price.inputUsd || 0.02) * 4096 + (price && price.outputUsd || 0.08) * (body.max_tokens || 512)) / 1e6;
        if (b.count >= Math.min(maxRequests, b.maxRequests) || b.usd + estimate > Math.min(budgetUsd, b.budgetUsd)) throw new ApiError('probe_budget', 'Лимит оплаченных проб исчерпан', 409);
        // Reserve BEFORE I/O: interrupted/aborted requests still count and may be charged.
        b.count++; b.usd += estimate; writeBudget(b);
        const start = now(); const record = { at: new Date().toISOString(), tokenId, channelId, model: body.model, test, request: b.count, ok: false };
        let got = null;
        try {
            const r = await fetchImpl('https://api.a6api.com/v1/chat/completions', { method: 'POST', redirect: 'error',
                headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
            record.http = r.status; record.ttfbMs = now() - start;
            if (!r.ok) { record.reason = 'http_' + r.status; await r.body?.cancel(); return { record, got }; }
            got = body.stream ? await parseStream(r) : await r.json().then(x => ({ message: x.choices?.[0]?.message || {}, usage: x.usage, model: x.model, finish: x.choices?.[0]?.finish_reason }));
            record.returnedModel = got.model; record.usage = got.usage; record.finish = got.finish;
            if (got.finish === 'length') { record.reason = 'output_limit'; return { record, got }; }
            record.ok = !!validate(got); record.reason = record.ok ? null : 'unexpected_answer';
            record.text = String(got.message.content || '').slice(0, 220);
            record.toolNames = (got.message.tool_calls || []).map(t => t.function.name);
            return { record, got };
        } catch (e) { record.reason = ['TimeoutError', 'AbortError'].includes(e.name) ? 'timeout' : 'invalid_response'; return { record, got }; }
        finally { record.ms = now() - start; fs.appendFileSync(file, JSON.stringify(record) + '\n'); }
    }
    async function suite({ key, tokenId, channelId, model, price, quick = false }) {
        const base = { key, tokenId, channelId, price }; const results = [];
        const run = async (test, body, validate) => { const x = await call({ ...base, test, body, validate }); results.push(x.record); return x; };
        if (!quick) {
            const nonce = 'ZEBRA-' + crypto.randomInt(10000, 99999);
            const system = await run('system', { model, stream: true, max_tokens: 256, thinking: { type: 'disabled' }, messages: [
                { role: 'system', content: 'Reply with exactly ' + nonce + ' and nothing else.' }, { role: 'user', content: 'Hello.' }] }, x => String(x.message.content || '').trim() === nonce);
            if (!system.record.ok) return { ok: false, results };
        }
        const first = makeToolRound(model);
        const a = await run('tools-first', first, x => {
            const calls = x.message.tool_calls || [];
            return calls.length === 1 && !!calls[0].id && calls[0].function.name === 'read_marker' && JSON.parse(calls[0].function.arguments).tag === 'a6';
        });
        if (a.record.ok) {
            const marker = 'MARKER-' + crypto.randomBytes(4).toString('hex');
            await run('tools-result', toolFollowup(first, a.got.message, marker), x => String(x.message.content || '').trim() === marker && !x.message.tool_calls?.length);
        }
        const fixture = imageFixture(undefined, 'red');
        await run('vision-red', { model, stream: true, max_tokens: 2048, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: imageParts(fixture) }] }, x => {
            const o = jsonFromText(x.message.content); return String(o.code) === fixture.code && o.color === fixture.color;
        });
        const other = imageFixture(undefined, 'blue');
        if (!quick) await run('vision-blue', { model, stream: true, max_tokens: 2048, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: imageParts(other) }] }, x => {
            const o = jsonFromText(x.message.content); return String(o.code) === other.code && o.color === other.color;
        });
        const combined = { model, stream: true, max_tokens: 2048, thinking: { type: 'disabled' },
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the four digits and the square color in the image. Call report_card with these values. Do not answer with text.' }, imageParts(other)[1]] }],
            tools: [{ type: 'function', function: { name: 'report_card', description: 'Report the card that you saw.', parameters: { type: 'object', properties: { code: { type: 'string' }, color: { type: 'string' } }, required: ['code', 'color'] } } }] };
        await run('vision-tools', combined, x => {
            const t = x.message.tool_calls?.[0]; if (!t || t.function.name !== 'report_card') return false;
            const o = JSON.parse(t.function.arguments); return String(o.code) === other.code && o.color === other.color;
        });
        return { ok: results.every(x => x.ok), results };
    }
    return { call, suite, budget };
}
module.exports = { imageFixture, imageParts, parseStream, makeToolRound, toolFollowup, createRunner };
