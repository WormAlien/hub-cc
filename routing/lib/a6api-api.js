'use strict';
// a6api is a marketplace: routing belongs to a token + model, not to a local account pool.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ORIGIN = 'https://api.a6api.vip';
const MODEL = 'deepseek-v4.1-flash-1017';
const PRICE_FIELDS = ['input_price_micros', 'output_price_micros', 'cache_read_price_micros', 'cache_write_price_micros', 'per_request_price_micros'];
const STRATEGIES = ['price_asc', 'success_desc', 'latency_asc', 'user_priority_desc'];
const SECRET_DIR = path.join(os.homedir(), '.secrets');

class ApiError extends Error {
    constructor(code, message, status = 502, upstreamStatus = null) {
        super(message); this.code = code; this.status = status; this.upstreamStatus = upstreamStatus;
    }
}
const fail = (code, message, status = 400) => { throw new ApiError(code, message, status); };
const number = v => (typeof v !== 'number' && typeof v !== 'string') || (typeof v === 'string' && !v.trim()) || !Number.isFinite(Number(v)) ? null : Number(v);
const scaled = (v, divisor) => number(v) === null ? null : Number(v) / divisor;
const idOf = v => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) fail('invalid_id', 'Некорректный ID'); return n; };
const modelOf = v => { if (typeof v !== 'string' || !v.trim() || v.length > 250 || /[\x00-\x1f]/.test(v)) fail('invalid_model', 'Выберите модель'); return v.trim(); };
const mask = s => { const v = String(s || ''); return v ? v.slice(0, 5) + '***' + v.slice(-4) : null; };
const modelList = t => String(t.model_limits || '').split(',').map(s => s.trim()).filter(Boolean);
function normalizeListing(x) {
    return {
        channelId: Number(x.channel_id), listingId: Number(x.listing_id), supplierId: Number(x.supplier_id),
        supplier: String(x.supplier_name || ''), channel: String(x.channel_name || ''), model: String(x.model_name || ''),
        description: String(x.description || ''), inputUsd: scaled(x.input_price_micros, 1e6),
        outputUsd: scaled(x.output_price_micros, 1e6), cacheUsd: scaled(x.cache_read_price_micros, 1e6),
        prices: Object.fromEntries(PRICE_FIELDS.map(k => [k, number(x[k])])),
        success24h: scaled(x.success_rate_24h, 100), recentSuccess: scaled(x.recent_success_rate, 100),
        samples: number(x.sample_count), ttftMs: number(x.p50_ttft_ms), latencyMs: number(x.recent_p50_ms),
        rating: scaled(x.review_rating_tenths, 10), reviews: number(x.review_count),
        deposit: x.authenticity_guaranteed === true, lastSample: number(x.last_sample_at),
        lastFailure: String(x.last_failure_code || ''),
        available: x.listing_availability === 1 && !x.supplier_channel_disabled && !x.user_channel_disabled,
    };
}
function tokenView(t, qpu) {
    return { id: Number(t.id), name: String(t.name || ''), mask: mask(t.key), status: Number(t.status),
        expires: number(t.expired_time), unlimited: t.unlimited_quota === true,
        remainingUsd: scaled(t.remain_quota, qpu), spentUsd: scaled(t.used_quota, qpu),
        restricted: t.model_limits_enabled === true, models: modelList(t), routing: t.routing_enabled === true };
}
function routeView(s, pins = []) {
    return { id: s ? Number(s.id) : null, version: s ? number(s.config_version) : null,
        strategy: s && s.sort_strategy || 'price_asc', caps: s && s.caps || {},
        fallback: !!(s && s.fallback_enabled), autoPool: !!(s && s.auto_pool_enabled),
        channels: (s && s.channels || []).filter(c => !c.removed_at).map(c => ({
            channelId: Number(c.channel_id), name: c.channel_name || '', supplier: c.supplier_name || '',
            state: c.state, effective: c.route_effective === true, prices: c.current_price || {},
            priority: number((s.user_priorities || {})[String(c.channel_id)]),
        })), pin: pins.length ? { channelId: Number(pins[0].channel_id), fallback: !!pins[0].fallback_to_smart_routing } : null };
}
function readPanelToken(secretDir = SECRET_DIR) {
    try {
        const text = fs.readFileSync(path.join(secretDir, 'a6api.token'), 'utf8').replace(/^﻿/, '');
        const token = text.split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('#'));
        if (token) return token;
    } catch { /* reported without exposing the file or its contents */ }
    fail('panel_token_missing', 'Нет токена кабинета a6api в .secrets', 503);
}
function readPanelUserId(secretDir) {
    let config;
    try { config = JSON.parse(fs.readFileSync(path.join(secretDir, 'a6api-config.json'), 'utf8').replace(/^﻿/, '')); }
    catch (e) { fail(e.code === 'ENOENT' ? 'panel_config_missing' : 'panel_config_invalid', 'Нужен userId кабинета a6api в .secrets/a6api-config.json', 503); }
    const id = number(config && config.userId);
    if (!Number.isSafeInteger(id) || id < 1) fail('panel_config_invalid', 'Некорректный userId кабинета a6api в .secrets/a6api-config.json', 503);
    return id;
}
function allowedPath(p, method) {
    if (typeof p !== 'string' || !p.startsWith('/api/') || /[\\\r\n#]/.test(p) || p.includes('..')) return false;
    const u = new URL(p, ORIGIN);
    if (u.origin !== ORIGIN) return false;
    const x = u.pathname;
    if (method === 'GET') return ['/api/status', '/api/user/self', '/api/pricing', '/api/token/', '/api/subscriptions', '/api/marketplace/pins', '/api/log/self'].includes(x)
        || /^\/api\/token\/\d+$/.test(x) || /^\/api\/subscriptions\/\d+$/.test(x)
        || x === '/api/marketplace/channels/search' || /^\/api\/marketplace\/listings\/\d+\/reviews$/.test(x)
        || /^\/api\/marketplace\/channels\/\d+\/models\/[^/]+\/failures$/.test(x);
    if (method === 'POST') return ['/api/token/', '/api/subscriptions', '/api/marketplace/pin', '/api/marketplace/unpin'].includes(x)
        || /^\/api\/token\/\d+\/key$/.test(x);
    return method === 'PUT' && (x === '/api/token/' || /^\/api\/subscriptions\/\d+\/config$/.test(x));
}
function createClient({ token, userId, fetchImpl = globalThis.fetch, secretDir = SECRET_DIR, timeoutMs = 30000 } = {}) {
    const locks = new Set();
    async function request(p, { method = 'GET', body } = {}) {
        if (!allowedPath(p, method)) fail('invalid_path', 'Invalid panel API path');
        const key = typeof token === 'function' ? token() : token || readPanelToken(secretDir);
        const headers = { Authorization: 'Bearer ' + key, 'New-Api-User': String(idOf(userId === undefined ? readPanelUserId(secretDir) : userId)), Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        let r;
        try {
            r = await fetchImpl(ORIGIN + p, { method, headers, redirect: 'error',
                body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        } catch (e) {
            const timeout = e && ['TimeoutError', 'AbortError'].includes(e.name);
            throw new ApiError(timeout ? 'upstream_timeout' : 'upstream_network', timeout ? 'Таймаут a6api' : 'Нет ответа a6api');
        }
        let j;
        try { j = await r.json(); } catch {
            if (r.ok) throw new ApiError('upstream_not_json', 'a6api вернул не JSON');
        }
        if (!r.ok || !j || typeof j !== 'object' || j.success === false || j.error) {
            // Only known machine codes are public. Provider text can contain credentials or request bodies.
            const codes = ['subscription_config_version_conflict', 'subscription_duplicate_token_model', 'subscription_channel_required',
                'subscription_config_invalid', 'subscription_priority_invalid', 'subscription_channel_invalid', 'invalid_ratio_range', 'invalid_ratio_currency', 'invalid_cache_hit_rate'];
            const code = j && (j.code || j.error && j.error.code);
            const conflict = r.status === 409 || ['subscription_config_version_conflict', 'subscription_duplicate_token_model'].includes(code);
            throw new ApiError(codes.includes(code) ? code : (r.ok ? 'upstream_rejected' : 'upstream_http'),
                conflict ? 'Маршрут изменился в кабинете. Обновите его перед сохранением.' : (r.ok ? 'a6api отклонил запрос. Обновите состояние кабинета.' : 'a6api: HTTP ' + r.status),
                conflict ? 409 : (r.status === 401 ? 401 : 502), r.status);
        }
        return j.data === undefined ? j : j.data;
    }
    async function paged(p, param = 'p', pageSize = 100) {
        const all = []; let total = null;
        for (let page = 1; page <= 100; page++) {
            const d = await request(p + (p.includes('?') ? '&' : '?') + new URLSearchParams({ [param]: page, page_size: pageSize, size: pageSize }));
            const rows = Array.isArray(d) ? d : d && d.items;
            if (!Array.isArray(rows)) throw new ApiError('upstream_schema', 'a6api: изменился формат списка');
            all.push(...rows); total = number(d.total);
            if (Array.isArray(d) || (total !== null ? all.length >= total : rows.length < pageSize)) return all;
            if (!rows.length) break;
        }
        throw new ApiError('upstream_pagination', 'a6api: список получен не полностью');
    }
    async function tokens() { return paged('/api/token/'); }
    async function ownToken(id) {
        id = idOf(id); const t = (await tokens()).find(x => Number(x.id) === id);
        if (!t) fail('token_not_owned', 'Ключ не найден в вашем кабинете', 404); return t;
    }
    async function models() {
        const d = await request('/api/pricing');
        if (!Array.isArray(d)) throw new ApiError('upstream_schema', 'a6api: изменился каталог моделей');
        return [...new Set(d.map(x => x.model_name).filter(x => typeof x === 'string'))].sort();
    }
    async function listings(model, tokenId, { pageSize = 500 } = {}) {
        model = modelOf(model); const items = new Map(), seen = new Set(); let total = null, received = 0, stale = false, snapshot = null;
        for (let page = 1; page <= 30; page++) {
            const q = new URLSearchParams({ model, page, page_size: pageSize });
            if (tokenId) q.set('token_id', idOf(tokenId));
            const d = await request('/api/marketplace/channels/search?' + q);
            if (!d || !Array.isArray(d.items)) throw new ApiError('upstream_schema', 'a6api: изменился список продавцов');
            const nextTotal = number(d.total), nextSnapshot = number(d.snapshot_generated_at);
            if ((nextTotal !== null && (!Number.isSafeInteger(nextTotal) || nextTotal < 0))
                || (page > 1 && (nextTotal !== total || nextSnapshot !== snapshot))) {
                throw new ApiError('upstream_pagination', 'a6api: каталог изменился во время чтения. Обновите его.');
            }
            total = nextTotal; snapshot = nextSnapshot; stale = stale || d.stale === true;
            for (const x of d.items) {
                const key = x.channel_id + ':' + x.model_name;
                if (seen.has(key)) throw new ApiError('upstream_pagination', 'a6api: страницы каталога повторяются. Обновите его.');
                seen.add(key);
                if (x.model_name === model) items.set(Number(x.channel_id), normalizeListing(x));
            }
            received += d.items.length;
            if (total !== null && (received > total || (!d.items.length && received < total))) throw new ApiError('upstream_pagination', 'a6api: каталог получен не полностью');
            if (total !== null ? received === total : d.items.length < pageSize) return { items: [...items.values()].sort((a, b) => (a.inputUsd ?? Infinity) - (b.inputUsd ?? Infinity)), total, stale, snapshot };
        }
        throw new ApiError('upstream_pagination', 'a6api: слишком большой каталог');
    }
    async function subscriptions() { return paged('/api/subscriptions'); }
    async function route(tokenId, model) {
        const [subs, pins] = await Promise.all([subscriptions(), request('/api/marketplace/pins')]);
        const same = x => Number(x.token_id) === Number(tokenId) && x.model_name === model && !x.deleted;
        return routeView(subs.find(same), (Array.isArray(pins) ? pins : []).filter(same));
    }
    async function state() {
        const [self, status, ts, ms] = await Promise.all([request('/api/user/self'), request('/api/status'), tokens(), models()]);
        const qpu = Number(status.quota_per_unit);
        if (!(qpu > 0)) throw new ApiError('quota_unit_missing', 'a6api не вернул единицу квоты');
        return { account: { balanceUsd: scaled(self.quota, qpu), spentUsd: scaled(self.used_quota, qpu) },
            quotaPerUnit: qpu, tokens: ts.map(t => tokenView(t, qpu)), models: ms, fetchedAt: Date.now() };
    }
    async function reviews(listingId) {
        const d = await request('/api/marketplace/listings/' + idOf(listingId) + '/reviews?page=1&page_size=50');
        return { count: number(d.total), rating: scaled(d.review_rating_tenths, 10), items: (d.items || []).map(x => ({
            rating: number(x.rating), text: String(x.content || ''), at: number(x.created_at),
            user: String(x.user_mask || ''), reply: x.reply ? String(x.reply.content || '') : null,
        })) };
    }
    async function logs(tokenId, model) {
        const t = await ownToken(tokenId);
        const [status, d] = await Promise.all([request('/api/status'), request('/api/log/self?' + new URLSearchParams({ p: 1, page_size: 20, token_name: t.name, model_name: modelOf(model) }))]);
        const qpu = Number(status.quota_per_unit);
        return { total: number(d.total), items: (d.items || []).filter(x => (x.token_id === undefined || Number(x.token_id) === Number(tokenId)) && (!x.model_name || x.model_name === model)).map(x => ({
            id: x.id, at: number(x.created_at), type: number(x.type), model: x.model_name, channelId: number(x.channel_id ?? x.channel),
            input: number(x.prompt_tokens), output: number(x.completion_tokens), usd: scaled(x.quota, qpu), duration: number(x.use_time),
        })) };
    }
    async function reveal(tokenId) {
        await ownToken(tokenId); const d = await request('/api/token/' + idOf(tokenId) + '/key', { method: 'POST', body: {} });
        if (!d || typeof d.key !== 'string' || d.key.includes('*')) throw new ApiError('key_unavailable', 'Полный ключ недоступен');
        return d.key.startsWith('sk-') ? d.key : 'sk-' + d.key;
    }
    async function exclusive(key, fn) {
        if (locks.has(key)) fail('operation_busy', 'Эта настройка уже сохраняется', 409);
        locks.add(key); try { return await fn(); } finally { locks.delete(key); }
    }
    async function enableModel(tokenId, model) {
        tokenId = idOf(tokenId); model = modelOf(model);
        return exclusive('token:' + tokenId, async () => {
            const t = await ownToken(tokenId);
            if (!(await models()).includes(model)) fail('unknown_model', 'Модель не найдена в a6api');
            if (!t.model_limits_enabled || modelList(t).includes(model)) return { ok: true };
            const fields = ['id', 'name', 'remain_quota', 'unlimited_quota', 'expired_time', 'model_limits_enabled',
                'model_limits', 'allow_ips', 'group', 'cross_group_retry', 'routing_enabled', 'routing_preference',
                'routing_allow_fallback', 'pricing_strategy', 'pricing_custom_pct'];
            const body = Object.fromEntries(fields.filter(k => t[k] !== undefined).map(k => [k, t[k]]));
            body.model_limits = [...modelList(t), model].join(',');
            let writeError = null;
            try { await request('/api/token/', { method: 'PUT', body }); } catch (e) { writeError = e; }
            const after = await ownToken(tokenId);
            if (after.model_limits_enabled && modelList(after).includes(model) && modelList(t).every(m => modelList(after).includes(m))) return { ok: true };
            if (writeError) throw writeError;
            throw new ApiError('token_readback_mismatch', 'Модель добавлена не так, как ожидалось. Обновите ключ.', 409);
        });
    }
    async function saveRoute(draft) {
        const tokenId = idOf(draft.tokenId), model = modelOf(draft.model);
        const ids = [...new Set((Array.isArray(draft.channels) ? draft.channels : []).map(idOf))];
        if (!ids.length) fail('empty_pool', 'Оставьте хотя бы одного продавца: пустой пул может вернуть весь рынок');
        if (ids.length > 20) fail('pool_too_large', 'Максимум 20 каналов в ручном пуле');
        if (!STRATEGIES.includes(draft.strategy)) fail('invalid_strategy', 'Неизвестная стратегия маршрута');
        return exclusive('token:' + tokenId, async () => {
            const t = await ownToken(tokenId);
            if (t.model_limits_enabled && !modelList(t).includes(model)) fail('model_restricted', 'Сначала добавьте модель в разрешённые для ключа');
            const current = await route(tokenId, model);
            if (current.id && (!Number.isSafeInteger(current.version) || current.version < 1)
                || (current.id ?? null) !== number(draft.baselineId) || (current.version ?? null) !== number(draft.baselineVersion)) fail('route_conflict', 'Маршрут изменился в кабинете. Обновите его перед сохранением.', 409);
            if (current.pin) fail('route_pinned', 'У модели есть закреп, он обходит пул. Сначала снимите его в кабинете.', 409);
            const catalog = await listings(model, tokenId);
            const chosen = ids.map(id => catalog.items.find(x => x.channelId === id));
            if (chosen.some(x => !x || !x.available)) fail('channel_unavailable', 'Один из каналов больше не доступен для этой модели', 409);
            const caps = Object.fromEntries(PRICE_FIELDS.map(k => {
                const raw = Object.hasOwn(draft.caps || {}, k) ? draft.caps[k] : current.caps[k];
                const n = Number(raw ?? 0);
                if (!Number.isSafeInteger(n) || n < 0) fail('invalid_caps', 'Лимиты цен должны быть неотрицательными micros');
                return [k, n];
            }));
            if (!(caps.input_price_micros > 0) || !(caps.output_price_micros > 0)) fail('missing_caps', 'Укажите потолки цены входа и выхода');
            for (const x of chosen) {
                const confirmed = (draft.confirmedPrices || {})[x.channelId];
                for (const field of PRICE_FIELDS) {
                    const price = number(x.prices[field]);
                    if (price === null && !['input_price_micros', 'output_price_micros'].includes(field)) continue;
                    if (!confirmed || number(confirmed[field]) !== price) fail('price_changed', 'Цена продавца изменилась. Обновите каталог и подтвердите заново.', 409);
                    if (price === null || (caps[field] > 0 && price > caps[field])) fail('price_over_cap', 'Цена выбранного канала выше установленного потолка', 409);
                }
            }
            const priorities = Object.fromEntries(ids.map((id, i) => [String(id), ids.length - i]));
            const body = { channels: ids.map(id => ({ channel_id: id, priority: draft.strategy === 'user_priority_desc' ? priorities[id] : null })),
                caps, sort_strategy: draft.strategy, user_priorities: draft.strategy === 'user_priority_desc' ? priorities : {},
                auto_pool_enabled: false, min_ratio: '', max_ratio: '', min_cache_hit_rate_bps: null, fallback_enabled: false };
            const matches = s => s && Number(s.token_id) === tokenId && s.model_name === model && !s.fallback_enabled && !s.auto_pool_enabled
                && s.sort_strategy === body.sort_strategy && JSON.stringify((s.channels || []).filter(c => !c.removed_at).map(c => Number(c.channel_id)).sort((a, b) => a - b)) === JSON.stringify([...ids].sort((a, b) => a - b))
                && PRICE_FIELDS.every(k => Number(s.caps && s.caps[k] || 0) === caps[k])
                && (draft.strategy !== 'user_priority_desc' || ids.every(id => number((s.user_priorities || {})[String(id)]) === priorities[id]));
            let accepted = false;
            try {
                const saved = current.id ? await request('/api/subscriptions/' + current.id + '/config', { method: 'PUT', body: { ...body, expected_config_version: current.version } })
                    : await request('/api/subscriptions', { method: 'POST', body: { ...body, token_id: tokenId, model_name: model } });
                accepted = true;
                const sid = saved && saved.id || current.id;
                const after = sid ? await request('/api/subscriptions/' + idOf(sid)) : (await subscriptions()).find(s => s.token_id === tokenId && s.model_name === model && !s.deleted);
                if (!matches(after)) throw new ApiError('route_readback_mismatch', 'a6api принял запись, но проверка настроек не совпала. Черновик сохранён.', 409);
                return routeView(after);
            } catch (e) {
                // A timeout is ambiguous. Read once, never repeat a charge-bearing mutation.
                if (!accepted && ['upstream_timeout', 'upstream_network'].includes(e.code)) {
                    try {
                        const after = (await subscriptions()).find(s => Number(s.token_id) === tokenId && s.model_name === model && !s.deleted);
                        if (matches(after)) return routeView(after);
                    } catch { /* preserve the original error */ }
                }
                e.writeAccepted = accepted; throw e;
            }
        });
    }
    return { request, tokens, ownToken, models, listings, subscriptions, route, state, reviews, logs, reveal, enableModel, saveRoute };
}
module.exports = { createClient, normalizeListing, tokenView, routeView, ApiError, PRICE_FIELDS, STRATEGIES, SECRET_DIR, MODEL, modelList, idOf, modelOf };
