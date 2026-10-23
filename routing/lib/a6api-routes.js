'use strict';
// One route module, like MEDIA/Google. The panel credential never reaches the browser.
const fs = require('node:fs');
const path = require('node:path');
const { createClient, SECRET_DIR, ApiError, idOf, modelOf } = require('./a6api-api');
const PREFIX = '/__switch/api/a6api/';
const loopback = s => s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1';
function canWrite(req) {
    if (!loopback(req.socket && req.socket.remoteAddress)) return false;
    const h = req.headers || {};
    if (typeof h.host !== 'string' || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(h.host)) return false;
    let host;
    const protocol = req.socket.encrypted ? 'https:' : 'http:';
    try { host = new URL(protocol + '//' + h.host); } catch { return false; }
    if (h['sec-fetch-site'] !== undefined && h['sec-fetch-site'] !== 'same-origin') return false;
    if (h.origin !== undefined) {
        if (typeof h.origin !== 'string') return false;
        try { const o = new URL(h.origin); if (o.origin !== host.origin || h.origin !== o.origin) return false; }
        catch { return false; }
    }
    return true;
}
function json(res, status, data) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(data));
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0, overflow = false;
        req.on('data', c => { size += c.length; if (size > 65536) overflow = true; else chunks.push(c); });
        req.on('end', () => {
            if (overflow) return reject(new ApiError('body_too_large', 'Слишком большой запрос', 413));
            try { const d = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(); resolve(d); }
            catch { reject(new ApiError('invalid_json', 'Ожидается объект JSON', 400)); }
        });
        req.on('error', () => reject(new ApiError('request_closed', 'Запрос прерван', 400)));
    });
}
function probeSummary(secretDir, model) {
    const file = path.join(secretDir, 'a6api-probes.jsonl'); const result = {};
    let fd;
    try {
        fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size, bytes = Math.min(size, 256 * 1024), buf = Buffer.alloc(bytes);
        fs.readSync(fd, buf, 0, bytes, size - bytes);
        const lines = buf.toString('utf8').split('\n'); if (size > bytes) lines.shift();
        const legacy = new Map(); let generation = 0, order = 0;
        const knownTests = ['system', 'tools-first', 'tools-result', 'vision-red', 'vision-blue', 'vision-2048-red', 'vision-2048-blue', 'vision-tools'];
        for (const line of lines) {
            let r; try { r = JSON.parse(line); } catch { continue; }
            if (!r || r.model !== model || !Number.isSafeInteger(Number(r.channelId)) || Number(r.channelId) < 1 || !knownTests.includes(r.test)) continue;
            const tokenId = Number.isSafeInteger(Number(r.tokenId)) && Number(r.tokenId) > 0 ? Number(r.tokenId) : null;
            const key = tokenId + ':' + Number(r.channelId), explicitRun = r.runId ?? r.suiteId;
            let group;
            if ((typeof explicitRun === 'string' && explicitRun) || typeof explicitRun === 'number') {
                group = key + ':run:' + explicitRun; legacy.delete(key);
            } else {
                let run = legacy.get(key);
                // Legacy suites start at system, or tools-first for a quick repeat. Keep older
                // capability evidence, but never pair its second half with a new suite's first.
                if (!run || r.test === 'system' || (r.test === 'tools-first' && run.last !== 'system')) run = { id: ++generation };
                run.last = r.test; legacy.set(key, run); group = key + ':legacy:' + run.id;
            }
            const row = result[r.channelId] || (result[r.channelId] = { tests: {} });
            row.at = r.at; row.returnedModel = r.returnedModel || row.returnedModel;
            row.tests[r.test] = { ok: r.ok === true, reason: r.reason, at: r.at, tokenId, runId: explicitRun ?? null, _group: group, _order: ++order };
        }
        const paired = (a, b) => a && b && a.tokenId !== null && a._group === b._group ? a.ok && b.ok : null;
        const latest = (a, b) => !a ? b : !b ? a : a._order > b._order ? a : b;
        for (const row of Object.values(result)) {
            const t = row.tests;
            row.system = t.system ? t.system.ok : null;
            row.tools = paired(t['tools-first'], t['tools-result']);
            row.vision = paired(latest(t['vision-2048-red'], t['vision-red']), latest(t['vision-2048-blue'], t['vision-blue']));
            row.combined = t['vision-tools'] ? t['vision-tools'].ok : null;
            for (const test of Object.values(t)) { delete test._group; delete test._order; }
        }
    } catch (e) { if (e.code !== 'ENOENT') return { unavailable: true }; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return result;
}
function createRoutes({ api = createClient(), secretDir = SECRET_DIR } = {}) {
    const cache = new Map();
    async function cached(key, fn) {
        const hit = cache.get(key); if (hit && hit.until > Date.now()) return hit.promise;
        const promise = fn().catch(e => { cache.delete(key); throw e; });
        cache.set(key, { until: Date.now() + 15000, promise });
        if (cache.size > 20) cache.delete(cache.keys().next().value);
        return promise;
    }
    async function dispatch(req, res, url) {
        const action = url.pathname.slice(PREFIX.length);
        if (req.method === 'GET') {
            if (['route', 'enable-model', 'reveal'].includes(action)) return json(res, 405, { error: 'Нужен явный POST' });
            if (action === 'state') return json(res, 200, { ok: true, ...await cached('state', () => api.state()), canWrite: canWrite(req) });
            if (action === 'model') {
                const tokenId = idOf(url.searchParams.get('tokenId')), model = modelOf(url.searchParams.get('model'));
                await api.ownToken(tokenId);
                const [catalog, route] = await Promise.all([cached(tokenId + ':' + model, () => api.listings(model, tokenId)), api.route(tokenId, model)]);
                return json(res, 200, { ok: true, catalog, route, probes: probeSummary(secretDir, model), canWrite: canWrite(req) });
            }
            if (action === 'reviews') return json(res, 200, { ok: true, ...await cached('reviews:' + idOf(url.searchParams.get('listingId')), () => api.reviews(idOf(url.searchParams.get('listingId')))) });
            if (action === 'logs') return json(res, 200, { ok: true, ...await api.logs(idOf(url.searchParams.get('tokenId')), modelOf(url.searchParams.get('model'))) });
            return json(res, 404, { error: 'Ручка a6api не найдена' });
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'Метод не разрешён' });
        if (!canWrite(req)) return json(res, 403, { error: 'Управление ключом доступно только через localhost на этой машине', code: 'local_only' });
        if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) return json(res, 415, { error: 'Нужен Content-Type application/json' });
        if (!['route', 'enable-model', 'reveal'].includes(action)) return json(res, 404, { error: 'Ручка a6api не найдена' });
        const body = await readBody(req);
        const tokenId = idOf(body.tokenId);
        if (action === 'route') {
            const route = await api.saveRoute({ ...body, tokenId }); cache.clear(); return json(res, 200, { ok: true, route });
        }
        if (action === 'enable-model') {
            const result = await api.enableModel(tokenId, modelOf(body.model)); cache.clear(); return json(res, 200, result);
        }
        return json(res, 200, { ok: true, key: await api.reveal(tokenId) });
    }
    function handle(req, res) {
        let url; try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
        if (!url.pathname.startsWith(PREFIX)) return false;
        dispatch(req, res, url).catch(e => json(res, e instanceof ApiError ? e.status : (e.status || 500), {
            ok: false, code: e.code || 'a6api_error', error: e instanceof ApiError ? e.message : 'Не удалось выполнить запрос a6api',
            writeAccepted: e.writeAccepted === true,
        }));
        return true;
    }
    return { handle };
}
let routes;
function handle(req, res) {
    if (!req.url.startsWith(PREFIX)) return false;
    if (!routes) routes = createRoutes(); return routes.handle(req, res);
}
module.exports = { createRoutes, canWrite, handle, probeSummary };
