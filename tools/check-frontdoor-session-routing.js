'use strict';
// Изолированный HTTP-тест session-aware routing. Живой :20100 не трогает.
// Два окна выбирают разные провайдеры явным префиксом, затем оба запускают
// `claude-opus-5` без префикса. Агент каждого окна обязан попасть в свою routes-карту.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const SCRIPT = path.resolve(__dirname, '../routing/frontdoor-proxy.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function server(label, requests) {
    return http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
            requests.push({ label, model: body.model, session: body.metadata });
            const out = JSON.stringify({ model: body.model, ok: true });
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
            res.end(out);
        });
    });
}
function listen(s) { return new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', () => resolve(s.address().port)); }); }
async function request(port, model, session) {
    const body = JSON.stringify({ model, max_tokens: 1, metadata: { user_id: JSON.stringify({ session_id: session }) } });
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return { status: r.status, body: await r.json() };
}

(async () => {
    const aReq = [], bReq = [], a = server('a6api', aReq), b = server('premier', bReq);
    const aPort = await listen(a), bPort = await listen(b);
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'frontdoor-session-'));
    const registry = path.join(dir, 'backends.json');
    const aMap = path.join(dir, 'a6api-modelmap.json'), aRoutes = path.join(dir, 'a6api-routes-modelmap.json');
    const bMap = path.join(dir, 'premier-modelmap.json'), bRoutes = path.join(dir, 'premier-routes-modelmap.json');
    fs.writeFileSync(aMap, JSON.stringify({ opus: 'a-opus', sonnet: 'a-sonnet', haiku: 'a-haiku' }));
    fs.writeFileSync(aRoutes, JSON.stringify({ opus: 'a6-opus', sonnet: 'a6-sonnet', haiku: 'a6-haiku' }));
    fs.writeFileSync(bMap, JSON.stringify({ opus: 'p-opus', sonnet: 'p-sonnet', haiku: 'p-haiku' }));
    fs.writeFileSync(bRoutes, JSON.stringify({ opus: 'pm-opus', sonnet: 'pm-sonnet', haiku: 'pm-haiku' }));
    fs.writeFileSync(registry, JSON.stringify({ version: 1, providers: {
        a6api: { backend: 'a6api', upstream: `http://127.0.0.1:${aPort}`, modelmap: aMap },
        premier: { backend: 'premier', upstream: `http://127.0.0.1:${bPort}`, modelmap: bMap },
    }, aliases: {} }));
    const port = await new Promise((resolve, reject) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.once('error', reject); });
    const child = spawn(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT), env: { ...process.env, PORT: String(port), BACKENDS_FILE: registry, ACTIVE_BACKEND_FILE: path.join(dir, 'active.json'), LOG_FILE: path.join(dir, 'frontdoor.log'), SWITCH_PORT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        let ready = false;
        for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/__frontdoor/api/status`); if (r.ok) { ready = true; break; } } catch {} await sleep(30); }
        assert.ok(ready, 'изолированный front door не поднялся');
        const pa = await request(port, 'a6api/gpt-6-sol', 'window-a');
        const pb = await request(port, 'premier/free-deepseek-4.1-flash', 'window-b');
        assert.equal(pa.status, 200, 'parent A routed'); assert.equal(pb.status, 200, 'parent B routed');
        assert.deepEqual(aReq.map(x => x.model), ['gpt-6-sol'], 'окно A: родительский запрос на a6api');
        assert.deepEqual(bReq.map(x => x.model), ['free-deepseek-4.1-flash'], 'окно B: родительский запрос на Premier');
        const ca = await request(port, 'claude-opus-5', 'window-a');
        const cb = await request(port, 'claude-opus-5', 'window-b');
        if (ca.status !== 200 || cb.status !== 200) {
            console.log('DEBUG child responses', JSON.stringify({ ca, cb }));
            try { console.log('DEBUG frontdoor log', fs.readFileSync(path.join(dir, 'frontdoor.log'), 'utf8').slice(-3000)); } catch {}
        }
        assert.equal(ca.status, 200, 'child A routed'); assert.equal(cb.status, 200, 'child B routed');
        assert.deepEqual(aReq.map(x => x.model), ['gpt-6-sol', 'a6-opus'], 'окно A: провайдер и агент на карте a6api');
        assert.deepEqual(bReq.map(x => x.model), ['free-deepseek-4.1-flash', 'pm-opus'], 'окно B: провайдер и агент на карте Premier');
        // Неизвестная сессия не наследует чужую привязку; без active state отвечает честным 503.
        const unknown = await request(port, 'claude-opus-5', 'window-c');
        assert.equal(unknown.status, 503, 'неизвестное окно не должно украсть провайдера соседнего');
        console.log(JSON.stringify({ ok: true, a: aReq, b: bReq, unknown }, null, 1));
    } finally {
        child.kill(); a.close(); b.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(e => { console.error(e.stack); process.exit(1); });
