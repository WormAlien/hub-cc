'use strict';
// Isolated full-dashboard fixture. No real accounts or provider sockets.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.join(__dirname, '../routing');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-preview-'));
const accounts = [{ id: 'fixture-a', email: 'demo-a@example.test', api_key: 'fixture-a', active: true },
    { id: 'fixture-b', email: 'demo-b@example.test', api_key: 'fixture-b' }];
let calls = 0;
const probe = require('../routing/lib/xingchi-model-test.js').createXingchiModelTest({
    accounts: () => accounts, cacheFile: path.join(dir, 'cache.json'),
    fetchImpl: async (url, options) => {
        calls++; const body = JSON.parse(options.body); await new Promise(r => setTimeout(r, 200));
        return body.model === 'gpt-6' ? new Response(JSON.stringify({ error: { message: 'Service temporarily unavailable' } }), { status: 503 })
            : new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }));
    },
});
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), p = url.pathname;
    if (p === '/__fixture') return json(res, { calls });
    if (p === '/__switch/api/xc/model-tests') {
        try {
            if (req.method === 'GET') return json(res, { ok: true, ...probe.read(url.searchParams.get('accountId')) });
            let raw = ''; for await (const c of req) raw += c;
            const b = JSON.parse(raw); return json(res, { ok: true, result: await probe.test(b.accountId, b.model) });
        } catch(e) { return json(res, { ok: false, error: e.message }, 400); }
    }
    if (p === '/__switch/api/xc/sessions') return json(res, { ok: true, sessions: accounts });
    if (p === '/__switch/api/xc/models') return json(res, { ok: true, models: ['gpt-6.1-sol', 'gpt-6', 'gpt-image-2'].map(id => ({id})) });
    if (p === '/__switch/api/xc/active-model') return json(res, { ok: true, model: 'gpt-6.1-sol' });
    if (p === '/__switch/api/xc/modelmap') return json(res, { ok: true, modelMap: {} });
    if (p === '/__switch/api/api-gateway') return json(res, { ok: true, manifest: { revision: 1 }, models: [], providers: ['xingchi'], canWrite: false });
    if (p === '/__switch/api/status') return json(res, { current: 'xingchi', backends: { xingchi: { label: 'Xingchi' } }, presets: {}, oauth: {} });
    if (p.startsWith('/__switch/')) return json(res, { ok: true, sessions: [], entries: [], runs: [] });
    if (p.startsWith('/vendor/fonts/') && /^[\w.-]+$/.test(path.basename(p))) {
        const font = path.join(root, 'vendor/fonts', path.basename(p));
        if (fs.existsSync(font)) { res.writeHead(200, { 'Content-Type': 'font/woff2' }); return res.end(fs.readFileSync(font)); }
    }
    if (p.startsWith('/__media/')) return json(res, { ok: true, providers: [], jobs: [], history: [] });
    const file = p === '/' ? path.join(root, 'proxy-dashboard.html') : p.startsWith('/vendor/') && path.basename(p) === p.slice(8) ? path.join(root, 'vendor', path.basename(p)) : '';
    if (file && fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'application/javascript' }); return res.end(fs.readFileSync(file)); }
    res.writeHead(404); res.end();
}).listen(0, '127.0.0.1', function () { console.log('XC_PREVIEW http://127.0.0.1:' + this.address().port); });
