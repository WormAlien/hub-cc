'use strict';
/*
 * media-routes.js — весь HTTP вкладки MEDIA одним входом.
 *
 * Зачем один вход. Канон добавления вкладки в этот дашборд раскидывает обработчики по
 * лестнице из ~355 предикатов в `transparent-proxy.js`. Здесь это не нужно: вкладка новая,
 * своих реестров у неё нет, поэтому весь её HTTP живёт в модуле, а в большом файле остаётся
 * ОДНА строка делегирования. Меньше шов — меньше драки правок с параллельной работой.
 *
 * 🪤 Сравнение пути идёт по `pathname`, а не по `req.url` целиком. В дашборде это грабли с
 * историей: ~355 предикатов лестницы сверяют `req.url ===`, и любой `?param` мимо них
 * пролетает. Здесь query-строка обязана быть безвредной с первой строки.
 *
 * Каталог моделей кешируется в СВОЙ файл, а не в запись провайдера: `custom-providers.json`
 * пишет живой дашборд, и лезть туда третьей рукой — гарантированная потеря обновления.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const catalog = require('./media-catalog');
const queue = require('./media-queue');

const ROUTING = path.join(__dirname, '..');
const PROVIDERS_FILE = path.join(ROUTING, 'custom-providers.json');
const MODELS_CACHE_FILE = path.join(ROUTING, 'media-models-cache.json');
const PREFIX = '/__media/api/';

// ── Ответы ───────────────────────────────────────────────────────────────────

function json(res, code, body) {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
}

function readBody(req, limitBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > limitBytes) { reject(new Error('тело запроса больше лимита')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error(`тело не JSON: ${e.message}`)); }
        });
        req.on('error', reject);
    });
}

// ── Провайдеры и каталог ─────────────────────────────────────────────────────

function loadProviders() {
    try {
        const raw = fs.readFileSync(PROVIDERS_FILE, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(doc.providers) ? doc.providers : [];
    } catch { return []; }
}

function findProvider(id) {
    return loadProviders().find(p => p.id === id) || null;
}

function loadModelsCache() {
    try {
        const raw = fs.readFileSync(MODELS_CACHE_FILE, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return doc && typeof doc === 'object' ? doc : {};
    } catch { return {}; }
}

function saveModelsCache(doc) {
    const tmp = `${MODELS_CACHE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, MODELS_CACHE_FILE);
}

/** Спросить у провайдера `/v1/models`. Ключ берём активный. */
function fetchModels(provider) {
    return new Promise((resolve, reject) => {
        const key = (provider.keys || []).find(k => k.active) || (provider.keys || [])[0];
        if (!key || !key.apiKey) return reject(new Error('у провайдера нет ключа'));
        let target;
        try { target = new URL(String(provider.baseUrl).replace(/\/+$/, '') + '/models'); }
        catch (e) { return reject(new Error(`плохой baseUrl: ${e.message}`)); }
        const mod = target.protocol === 'http:' ? http : https;
        const req = mod.get(target, {
            headers: { Authorization: `Bearer ${key.apiKey}`, Accept: 'application/json' },
            timeout: 30000,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                try {
                    const doc = JSON.parse(text);
                    const ids = (doc.data || []).map(m => m && m.id).filter(Boolean);
                    resolve(ids);
                } catch (e) { reject(new Error(`ответ не JSON: ${e.message}`)); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('таймаут 30 с')));
        req.on('error', reject);
    });
}

/** Модели провайдера: из кеша, при `force` — заново со шлюза. */
async function modelsFor(provider, force) {
    const cache = loadModelsCache();
    const hit = cache[provider.id];
    if (!force && hit && Array.isArray(hit.models) && hit.models.length) {
        return { models: hit.models, scannedAt: hit.scannedAt, fromCache: true };
    }
    const models = await fetchModels(provider);
    cache[provider.id] = { models, scannedAt: new Date().toISOString() };
    saveModelsCache(cache);
    return { models, scannedAt: cache[provider.id].scannedAt, fromCache: false };
}

/** Сводка по провайдеру: сколько у него моделей каждого типа. Ключи наружу не отдаются. */
function providerSummary(provider, models) {
    const cls = catalog.classify(provider.id, models || []);
    const keys = provider.keys || [];
    const active = keys.find(k => k.active) || keys[0];
    return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        hasKey: Boolean(active && active.apiKey),
        keyMask: active && active.apiKey ? '…' + String(active.apiKey).slice(-8) : null,
        counts: { image: cls.image.length, video: cls.video.length, other: cls.other.length },
    };
}

// ── Отдача файла ─────────────────────────────────────────────────────────────

/**
 * 🪤 Видео без `Range` в браузере не перематывается: плеер тянет весь файл и шкала мертва.
 * Поэтому диапазоны обслуживаем честно — `206`, `Content-Range`, `Accept-Ranges`.
 */
function serveFile(req, res, art) {
    let stat;
    try { stat = fs.statSync(art.file); }
    catch { return json(res, 404, { error: 'файл не найден на диске' }); }

    const total = stat.size;
    const mime = art.mime || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (m) {
            let start = m[1] === '' ? null : Number(m[1]);
            let end = m[2] === '' ? null : Number(m[2]);
            if (start === null && end !== null) { start = Math.max(0, total - end); end = total - 1; }
            else { if (start === null) start = 0; if (end === null) end = total - 1; }
            if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
                res.writeHead(416, { 'Content-Range': `bytes */${total}` });
                return res.end();
            }
            end = Math.min(end, total - 1);
            res.writeHead(206, {
                'Content-Type': mime,
                'Content-Length': end - start + 1,
                'Content-Range': `bytes ${start}-${end}/${total}`,
                'Accept-Ranges': 'bytes',
            });
            return fs.createReadStream(art.file, { start, end }).pipe(res);
        }
    }
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': total, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(art.file).pipe(res);
}

// ── Маршрутизация ────────────────────────────────────────────────────────────

/**
 * Единственный вход. Возвращает true, если запрос обслужен здесь.
 * Строка делегирования в transparent-proxy.js:
 *     if (require('./lib/media-routes').handle(req, res)) return;
 */
function handle(req, res) {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { return false; }
    if (!pathname.startsWith(PREFIX)) return false;

    const route = pathname.slice(PREFIX.length);
    Promise.resolve()
        .then(() => dispatch(req, res, route, new URL(req.url, 'http://localhost').searchParams))
        .catch(e => { if (!res.headersSent) json(res, 500, { error: e.message }); });
    return true;
}

async function dispatch(req, res, route, query) {
    // GET providers — кто вообще умеет медиа
    if (req.method === 'GET' && route === 'providers') {
        const cache = loadModelsCache();
        const list = [];
        for (const p of loadProviders()) {
            const models = (cache[p.id] && cache[p.id].models) || [];
            const s = providerSummary(p, models);
            s.scannedAt = (cache[p.id] && cache[p.id].scannedAt) || null;
            list.push(s);
        }
        // Сверху те, у кого медиа-модели уже найдены.
        list.sort((a, b) => (b.counts.image + b.counts.video) - (a.counts.image + a.counts.video));
        return json(res, 200, { providers: list });
    }

    // GET models?provider=<id>&force=1
    if (req.method === 'GET' && route === 'models') {
        const provider = findProvider(query.get('provider'));
        if (!provider) return json(res, 404, { error: 'провайдер не найден' });
        const { models, scannedAt, fromCache } = await modelsFor(provider, query.get('force') === '1');
        const cls = catalog.classify(provider.id, models);
        return json(res, 200, {
            provider: providerSummary(provider, models),
            scannedAt, fromCache,
            image: cls.image, video: cls.video, other: cls.other.map(p => p.id),
        });
    }

    // POST profile — ручная правка типа/возможностей модели
    if (req.method === 'POST' && route === 'profile') {
        const body = await readBody(req);
        if (!body.provider || !body.model) return json(res, 400, { error: 'нужны provider и model' });
        const patch = body.reset ? null : { kind: body.kind, caps: body.caps };
        return json(res, 200, { profile: catalog.setProfile(body.provider, body.model, patch) });
    }

    // POST generate — поставить задание
    if (req.method === 'POST' && route === 'generate') {
        const body = await readBody(req);
        const provider = findProvider(body.provider);
        if (!provider) return json(res, 404, { error: 'провайдер не найден' });
        if (!body.model) return json(res, 400, { error: 'не выбрана модель' });
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return json(res, 400, { error: 'пустой промпт' });
        if (prompt.length > 8000) return json(res, 400, { error: 'промпт длиннее 8000 символов' });
        try {
            return json(res, 200, { job: queue.enqueue({ provider, model: body.model, prompt, params: body.params || {} }) });
        } catch (e) { return json(res, 400, { error: e.message }); }
    }

    // GET jobs — что в работе прямо сейчас
    if (req.method === 'GET' && route === 'jobs') {
        return json(res, 200, { jobs: queue.listJobs(), maxParallel: queue.MAX_PARALLEL });
    }

    // GET job/<id>
    if (req.method === 'GET' && route.startsWith('job/')) {
        const id = route.slice('job/'.length);
        if (!queue.isJobId(id)) return json(res, 400, { error: 'плохой id задания' });
        const job = queue.getJob(id);
        if (!job) return json(res, 404, { error: 'задание не найдено' });
        return json(res, 200, { job: queue.publicJob(job) });
    }

    // GET history?limit=N
    if (req.method === 'GET' && route === 'history') {
        const limit = Math.min(Math.max(Number(query.get('limit')) || 200, 1), 2000);
        return json(res, 200, { items: queue.readHistory(limit) });
    }

    // GET file/<jobId>/<index> — сам файл
    if (req.method === 'GET' && route.startsWith('file/')) {
        const [id, idxRaw] = route.slice('file/'.length).split('/');
        if (!queue.isJobId(id)) return json(res, 400, { error: 'плохой id задания' });
        const index = Number(idxRaw);
        if (!Number.isInteger(index) || index < 0 || index > 99) return json(res, 400, { error: 'плохой индекс файла' });
        const art = queue.artifactPath(id, index);
        if (!art) return json(res, 404, { error: 'файл не найден' });
        return serveFile(req, res, art);
    }

    return json(res, 404, { error: `неизвестный маршрут MEDIA: ${route}` });
}

module.exports = { handle, PREFIX, loadProviders, findProvider, modelsFor, providerSummary };
