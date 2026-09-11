'use strict';
// Стенд для вкладки «Маршруты»: отдаёт НОВЫЙ proxy-dashboard.html с диска и подменяет
// API фикстурами. Живой :8200 не трогаем — он на старом коде и держит чужие сессии.
const http = require('http');
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
const PORT = Number(process.env.PORT || 8399);

// Реестр: редактируемый local, редактируемый remote, без тир-карты, и скрытый.
const TIERS = {
    agentrouter: { opus: 'claude-opus-5', sonnet: 'claude-opus-5', haiku: 'claude-opus-5', gpt: 'claude-opus-5' },
    aipm: { opus: 'claude-opus-4-6', sonnet: 'claude-opus-4-6-thinking', haiku: 'claude-sonnet-4-6', gpt: '' },
    justwoker: { opus: 'gpt-5.6-sol', sonnet: 'gpt-5.6-luna', haiku: 'gpt-5.6-terra', gpt: '' },
};
const CATALOG = {
    agentrouter: ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5'],
    aipm: ['claude-opus-4-6', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6'],
    justwoker: [],                                  // мёртвый шлюз: каталога нет
};
const saves = [];

function providers() {
    return [
        { name: 'agentrouter', label: 'AgentRouter', upstream: 'http://localhost:20133', local: true, aliases: ['ar'], tiers: TIERS.agentrouter, activeModel: null },
        { name: 'aipm', label: 'AIPM', upstream: 'http://localhost:20163', local: true, aliases: ['ap'], tiers: TIERS.aipm, activeModel: null },
        { name: 'justwoker', label: 'JustWoker', upstream: 'http://localhost:20158', local: true, aliases: ['jw'], tiers: TIERS.justwoker, activeModel: null },
        // Тир-карты нет — строка обязана остаться читаемой, без пустых селектов.
        { name: 'notion', label: 'Notion (cheap)', upstream: 'http://localhost:8190', local: true, aliases: [], tiers: null, activeModel: null },
        // Вкладки в навигации нет вовсе → обязан попасть в «скрыто», а не в список.
        { name: 'omniroute', label: 'FreeModel (OmniRoute)', upstream: 'http://localhost:20128/v1', local: true, aliases: ['om'], tiers: null, activeModel: null },
    ];
}

const json = (res, code, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) });
    res.end(b);
};

http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = u.pathname;

    if (p === '/' || p === '/index.html') {
        const html = fs.readFileSync(HTML);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
    }
    // 🪤 Без /vendor страница рендерится БЕЗ Tailwind — мерить вёрстку на ней нельзя.
    if (p.startsWith('/vendor/')) {
        const f = path.join(__dirname, '..', 'routing', p.replace(/^\//, ''));
        if (fs.existsSync(f) && fs.statSync(f).isFile()) {
            const ext = path.extname(f);
            const ct = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript'
                : ext === '.woff2' ? 'font/woff2' : 'application/octet-stream';
            res.writeHead(200, { 'content-type': ct });
            return res.end(fs.readFileSync(f));
        }
        res.writeHead(404); return res.end('');
    }
    if (p === '/__switch/api/routes') {
        return json(res, 200, { ok: true, providers: providers(), updatedAt: Date.now(), tiers: ['opus', 'sonnet', 'haiku', 'gpt'] });
    }
    if (p === '/__switch/api/routes/models') {
        const prov = u.searchParams.get('provider') || '';
        return json(res, 200, { ok: true, provider: prov, models: CATALOG[prov] || [] });
    }
    if (p === '/__switch/api/routes/modelmap' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            const j = JSON.parse(body || '{}');
            saves.push(j);
            // justwoker навсегда падает — проверяем откат выбора в UI.
            if (j.provider === 'justwoker') return json(res, 400, { ok: false, error: 'шлюз отклонил' });
            const t = TIERS[j.provider];
            if (!t) return json(res, 400, { ok: false, error: 'нет такого' });
            t[j.tier] = String(j.value || '');       // слияние: остальные тиры не трогаем
            return json(res, 200, { ok: true, provider: j.provider, tier: j.tier, value: t[j.tier], tiers: { ...t } });
        });
        return;
    }
    // Журнал сохранений для утверждений теста.
    if (p === '/__test/saves') return json(res, 200, { saves, tiers: TIERS });

    // Всё остальное — благонадёжная заглушка, чтобы загрузочный JS не падал.
    if (p.startsWith('/__switch/api/')) return json(res, 200, { ok: true, data: [], items: [], sessions: [], models: [], providers: [] });
    res.writeHead(404); res.end('');
}).listen(PORT, '127.0.0.1', () => console.log(`routes harness: http://127.0.0.1:${PORT}`));
