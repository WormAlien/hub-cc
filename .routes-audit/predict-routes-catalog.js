'use strict';
// Прогон ЦЕПОЧКИ ИСТОЧНИКОВ по всем шлюзам вкладки «Маршруты» - тем же кодом, что пойдёт
// в бою (`routing/lib/routes-catalog.js`), но без ожидания рестарта `:8200`.
//
// Зачем: серверные ручки держатся в памяти процесса, поэтому живьём новая цепочка
// заработает только после рестарта. Здесь она исполняется по шагам против ЖИВЫХ ручек
// (`/<ep>/sessions`, `/<ep>/models`) и реального снимка на диске - то есть показывает,
// что именно окажется в селектах, ещё до рестарта.
//
// Ничего не пишет: только чтение и GET-запросы.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const lib = require(path.join(ROOT, 'routing', 'lib', 'routes-catalog.js'));
const src = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8');

// Карты тянем из самого монолита - требовать его нельзя, он поднимает боевой сервер.
// 🪤 Без якоря `^`: в ROUTE_EP по НЕСКОЛЬКО пар на строке, и якорь брал бы только первую
// - тогда для половины шлюзов `ep` выходил пустым и прогон врал «каталога нет».
const blockOf = (name) => {
    const at = src.indexOf(`const ${name} = {`);
    return src.slice(at, src.indexOf('\n};', at));
};
const parsePairs = (block) => {
    const out = {};
    const re = /(\w+):\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(block))) out[m[1]] = m[2];
    return out;
};
const ROUTE_EP = parsePairs(blockOf('ROUTE_EP'));
const CC_MODEL_PREFIX = parsePairs(blockOf('CC_MODEL_PREFIX'));
const MONEY_GW_HOST = (() => {
    const at = src.indexOf('const MONEY_GW = {');
    const block = src.slice(at, src.indexOf('\n};', at));
    const out = {};
    const re = /(\w+):\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(block))) {
        const tag = /tag:\s*'([^']+)'/.exec(m[2]);
        const host = /host:\s*'([^']+)'/.exec(m[2]);
        if (tag && host) out[tag[1]] = host[1];
    }
    return out;
})();

const PORT = process.env.PORT || 8200;
const get = (url) => new Promise((resolve) => {
    const rq = http.get(url, { timeout: 15000 }, (r) => {
        const buf = [];
        r.on('data', c => buf.push(c));
        r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(buf).toString('utf8'))); } catch { resolve({}); } });
    });
    rq.on('timeout', () => { rq.destroy(new Error('timeout')); });
    rq.on('error', () => resolve({}));
});

async function catalogFor(provider) {
    const ep = ROUTE_EP[provider];
    const prefix = CC_MODEL_PREFIX[provider];
    if (!ep || !prefix) return { models: [], source: 'none', note: 'провайдер без каталога' };

    const fromSnapshot = () => {
        const host = MONEY_GW_HOST[provider] || lib.EXTRA_HOSTS[provider] || '';
        const snap = lib.snapshotFor(host);
        if (!snap) return { models: [], source: 'none', note: 'каталога нет ни живьём, ни в снимке' };
        return { models: snap.models, source: 'snapshot', staleDays: snap.staleDays };
    };
    const live = async (key, source) => {
        if (!key) return null;
        const d = await get(`http://127.0.0.1:${PORT}/__switch/api/${ep}/models?api_key=${encodeURIComponent(key)}`);
        const raw = Array.isArray(d.models) ? d.models : [];
        const models = lib.textOnly(raw);
        return models.length ? { models, source } : null;
    };

    let activeKey = '';
    try { activeKey = fs.readFileSync(path.join(os.homedir(), '.claude', `${prefix}-active-key.txt`), 'utf8').trim(); } catch { }
    const byActive = await live(activeKey, 'live');
    if (byActive) return byActive;

    const s = await get(`http://127.0.0.1:${PORT}/__switch/api/${ep}/sessions`);
    const key = lib.pickAccountKey(s.sessions);
    const byPool = await live(key, 'accounts');
    if (byPool) return byPool;

    return fromSnapshot();
}

(async () => {
    // Провайдеры вкладки берём у сервера - ровно те, что владелец видит строками.
    const d = await get(`http://127.0.0.1:${PORT}/__switch/api/routes`);
    const names = (d.providers || []).filter(p => p.tiers).map(p => p.name);
    console.log(`провайдеров с тир-картой: ${names.length}\n`);
    for (const n of names) {
        const r = await catalogFor(n);
        const tail = r.source === 'snapshot' && r.staleDays != null ? ` (снимку ${r.staleDays} дн)` : '';
        console.log(`${n.padEnd(12)} [${String(r.models.length).padStart(2)}] ${r.source}${tail}`);
        if (r.models.length) console.log(`             ${r.models.slice(0, 8).join(', ')}${r.models.length > 8 ? ' …' : ''}`);
    }
    console.log('\nсейчас в живом :8200 работает СТАРАЯ ручка - после рестарта будет это');
})();
