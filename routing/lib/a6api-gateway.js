'use strict';
// One paid account, one explicitly selected key. No account rotation or seller management.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const durable = require('./durable-write');
const { createClient, SECRET_DIR, ApiError, MODEL, idOf, modelOf, modelList } = require('./a6api-api');
const { textOnly } = require('./routes-catalog');
const ROUTING = path.join(__dirname, '..');
const PORT = 20191, CONVERTER_PORT = 20192;
const TIERS = ['default', 'opus', 'sonnet', 'haiku'];
const DEFAULT_MAP = { default: MODEL, opus: MODEL, sonnet: MODEL, haiku: MODEL, gpt: '' };
const EMPTY_MAP = { default: '', opus: '', sonnet: '', haiku: '', gpt: '' };
const digest = key => crypto.createHash('sha256').update(key).digest('hex');
const numberOrNull = v => Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null;
const problem = (code, message, status = 409) => { throw new ApiError(code, message, status); };

function buildRuntimeConfig({ secretDir = SECRET_DIR, routingDir = ROUTING, port = PORT, converterPort = CONVERTER_PORT } = {}) {
    const keyFile = path.join(secretDir, 'a6api-active-key.txt');
    return {
        converter: { port: converterPort, upstream: 'https://api.a6api.com/v1', keyFile, modelMap: {}, providerName: 'a6api', strictToolsVision: true },
        keepaliveEnv: {
            PORT: String(port), UPSTREAM: `http://127.0.0.1:${converterPort}`, KEY_FILE: keyFile,
            SESSIONS_FILE: '', MODELMAP_FILE: path.join(routingDir, 'a6api-modelmap.json'),
            CONFIG_FILE: path.join(secretDir, 'a6api-keepalive.json'), PAID_SINGLE_KEY: '1',
            HAIKU_REMAP: '1', HAIKU_TO_MODEL: '', GPT_PROXY_FORCE: '0',
            HAIKU_GPT_PROXY: `http://127.0.0.1:${converterPort}`, POOL_FALLBACK_MODEL: '',
            MAX_ATTEMPTS: '1', MAX_HEDGES: '0', HEDGE_MS: '0', CATALOG_TTL_MS: '0',
            VISION_BRIDGE: '0', UPSTREAM_NOSTREAM: '0', AUTOROTATE: '0', ROTATE_PROVIDER: '',
            KEEPALIVE_LOG_FILE: path.join(secretDir, 'a6api-keepalive.log'),
            LATENCY_FILE: path.join(secretDir, 'a6api-latency.json'), EVENTS_FILE: path.join(secretDir, 'a6api-events.json'),
            FAILDUMP_DIR: path.join(secretDir, 'a6api-faildump'),
        },
    };
}
function createGateway({ api = createClient(), secretDir = SECRET_DIR, routingDir = ROUTING, hub: initialHub = {}, fetchImpl = globalThis.fetch } = {}) {
    const selectionFile = path.join(secretDir, 'a6api-gateway.json');
    const keyFile = path.join(secretDir, 'a6api-active-key.txt');
    const runtime = buildRuntimeConfig({ secretDir, routingDir });
    let hub = initialHub, busy = false, preparing = null;
    function setHub(next) { hub = { ...hub, ...next }; }
    function readSelection() {
        try {
            const s = JSON.parse(durable.assertNotZeroed(fs.readFileSync(selectionFile, 'utf8').replace(/^﻿/, ''), 'a6api'));
            if (!s || !Number.isSafeInteger(s.tokenId) || s.tokenId < 1 || typeof s.keyHash !== 'string') throw new Error();
            return s;
        } catch (e) {
            if (e.code === 'ENOENT') return null;
            problem('selection_invalid', 'Не читается выбранный ключ a6api. Сначала восстановите приватную конфигурацию.');
        }
    }
    function prepared(s = readSelection()) {
        if (!s) return false;
        try { const key = fs.readFileSync(keyFile, 'utf8').replace(/^﻿/, '').trim(); return !!key && digest(key) === s.keyHash; }
        catch { return false; }
    }
    function readMap(routes = false) {
        if (hub.readMap) return { ...EMPTY_MAP, ...hub.readMap(routes) };
        try { return { ...EMPTY_MAP, ...JSON.parse(fs.readFileSync(path.join(routingDir, 'a6api' + (routes ? '-routes' : '') + '-modelmap.json'), 'utf8').replace(/^﻿/, '')) }; }
        catch { return { ...EMPTY_MAP }; }
    }
    function cacheBalance(p) {
        try {
            durable.writeJsonSync(path.join(secretDir, 'a6api-balance.json'), {
                balanceUsd: numberOrNull(p && p.account && p.account.balanceUsd),
                spentUsd: numberOrNull(p && p.account && p.account.spentUsd),
                checkedAt: new Date().toISOString(),
            });
        } catch { /* статуслайн просто не увидит цифру, таб важнее */ }
    }
    function validateToken(t) {
        if (Number(t.status) !== 1) problem('token_disabled', 'Ключ выключен или недоступен');
        if (Number(t.expired_time) > 0 && Number(t.expired_time) <= Date.now() / 1000) problem('token_expired', 'Срок ключа истёк');
        if (t.unlimited_quota === false && Number(t.remain_quota) <= 0) problem('token_quota', 'Лимит этого ключа исчерпан');
    }
    function permitted(t, catalog) { return textOnly(catalog).filter(m => !t.model_limits_enabled || modelList(t).includes(m)); }
    async function models(tokenId) {
        const [t, catalog] = await Promise.all([api.ownToken(idOf(tokenId)), api.models()]);
        validateToken(t); return permitted(t, catalog);
    }
    function validateMaps(allowed, provider = readMap()) {
        for (const tier of TIERS) {
            const model = String(provider[tier] || '').trim();
            if (!model || !allowed.includes(model)) problem('model_unavailable', `Модель ${model || '(' + tier + ' не задан)'} не разрешена выбранному ключу. Настройте модели или кабинет a6api.`);
        }
    }
    function selected(tokenId) {
        const s = readSelection();
        if (!s || s.tokenId !== idOf(tokenId) || !prepared(s)) problem('key_not_selected', 'Сначала выберите и сохраните этот ключ a6api');
        return s;
    }
    async function exclusive(fn) {
        if (busy) problem('gateway_busy', 'Другая настройка a6api ещё сохраняется');
        busy = true; try { return await fn(); } finally { busy = false; }
    }
    async function state() {
        const s = readSelection(), p = await api.state();
        cacheBalance(p);
        const t = s && p.tokens.find(t => Number(t.id) === s.tokenId);
        const usable = t && Number(t.status) === 1 && !(Number(t.expires) > 0 && t.expires <= Date.now() / 1000);
        const allowed = t ? textOnly(p.models).filter(m => !t.restricted || t.models.includes(m)) : [];
        return { ...p, models: allowed, selectedTokenId: s ? s.tokenId : null,
            prepared: !!usable && prepared(s), active: !!hub.isActive?.(), modelMap: readMap(), routesMap: readMap(true) };
    }
    // Лёгкое чтение баланса для статусбара. `state()` тянет ещё каталог и список
    // ключей (три запроса) и пересобирает всю вкладку - для тика раз в минуту это
    // лишняя работа. Здесь только `/api/user/self`, и результат кладётся в тот же
    // кеш `~/.secrets/a6api-balance.json`, который читает статусбар.
    // 🎯 Раньше кеш писался ТОЛЬКО при открытии вкладки и при активации: работая в
    // терминале, владелец видел `$4.88~29м` - цифра верная, но старая.
    async function balance() {
        const self = await api.request('/api/user/self');
        const status = await api.request('/api/status');
        const qpu = Number(status && status.quota_per_unit);
        if (!(qpu > 0)) problem('quota_unit_missing', 'a6api не вернул единицу квоты');
        cacheBalance({ account: {
            balanceUsd: Number(self.quota) / qpu,
            spentUsd: Number(self.used_quota) / qpu,
        } });
        return { ok: true, balanceUsd: Number(self.quota) / qpu, spentUsd: Number(self.used_quota) / qpu };
    }
    async function selectKey(tokenId) {
        return exclusive(async () => {
            tokenId = idOf(tokenId);
            const [t, catalog] = await Promise.all([api.ownToken(tokenId), api.models()]); validateToken(t);
            if (!permitted(t, catalog).length) problem('model_unavailable', 'У ключа нет доступных текстовых моделей');
            const key = await api.reveal(tokenId);
            if (typeof key !== 'string' || !key.startsWith('sk-') || key.includes('*')) problem('key_invalid', 'Полный ключ a6api недоступен');
            let oldKey = null;
            try { oldKey = fs.readFileSync(keyFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            durable.writeTextSync(keyFile, key);
            try { durable.writeJsonSync(selectionFile, { tokenId, keyHash: digest(key), selectedAt: new Date().toISOString() }); }
            catch (e) { durable.writeTextSync(keyFile, oldKey || ''); throw e; }
            hub.publish?.();
            return { ok: true, selectedTokenId: tokenId };
        });
    }
    async function saveModels(tokenId, patch) {
        return exclusive(async () => {
            selected(tokenId);
            if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !TIERS.includes(k))) problem('invalid_models', 'Допустимы только модели окна, Opus, Sonnet и Haiku', 400);
            const clean = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, modelOf(v)]));
            const next = { ...readMap(), ...clean };
            validateMaps(await models(tokenId), next);
            if (!hub.writeMap) problem('hub_not_ready', 'Запись моделей ещё не подключена к хабу', 503);
            hub.writeMap(clean, false);
            const after = readMap(), routes = readMap(true);
            if (Object.entries(clean).some(([k, v]) => after[k] !== v) || ['opus', 'sonnet', 'haiku'].some(k => k in clean && routes[k] !== clean[k])) problem('model_readback', 'Проверка сохранённых моделей не совпала');
            if (hub.isActive?.() && 'default' in clean) await hub.syncModel?.(after.default);
            hub.publish?.(); return { ok: true, modelMap: after, routesMap: routes };
        });
    }
    async function saveRouteTier(tier, value) {
        return exclusive(async () => {
            const s = readSelection();
            if (!s) problem('key_not_selected', 'Сначала выберите ключ a6api');
            selected(s.tokenId);
            if (![...TIERS, 'gpt'].includes(tier)) problem('invalid_tier', 'Неизвестный тир', 400);
            const model = String(value ?? '').trim();
            if (model && !(await models(s.tokenId)).includes(model)) problem('model_unavailable', 'Модель не разрешена выбранному ключу');
            if (!hub.writeMap) problem('hub_not_ready', 'Маршруты не подключены', 503);
            hub.writeMap({ [tier]: model }, true);
            const after = readMap(true);
            if (after[tier] !== model || (['opus', 'sonnet', 'haiku'].includes(tier) && readMap()[tier] !== model)) problem('model_readback', 'Проверка маршрута не совпала');
            return { ok: true, provider: 'a6api', tier, value: model, tiers: after };
        });
    }
    async function activate(tokenId) {
        return exclusive(async () => {
            selected(tokenId); validateMaps(await models(tokenId));
            if (!hub.ensure || !hub.activate) problem('hub_not_ready', 'Активация a6api ещё не подключена к хабу', 503);
            const ready = await hub.ensure();
            if (!ready || !ready.ok) problem('gateway_not_ready', 'Локальный шлюз a6api не поднялся', 503);
            await hub.activate(readMap().default);
            if (hub.isActive && !hub.isActive()) problem('activation_readback', 'Claude Code не переключился на a6api');
            try { cacheBalance(await api.state()); } catch { /* цифра появится при первом открытии вкладки */ }
            return { ok: true, active: true };
        });
    }
    async function probe(port, endpoint) {
        try { const r = await fetchImpl(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(1200) }); return r.ok ? await r.json() : null; }
        catch { return null; }
    }
    function portFree(port) {
        return new Promise(resolve => {
            const s = net.createServer(); s.once('error', () => resolve(false));
            s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
        });
    }
    async function ensureChild({ port, endpoint, matches, script, args = [], env = {} }) {
        const existing = await probe(port, endpoint);
        if (existing && matches(existing)) return { ok: true, already: true };
        if (!await portFree(port)) problem('port_occupied', `Порт ${port} занят неготовым или чужим процессом. Ничего не останавливаю.`, 503);
        const log = path.join(secretDir, `a6api-${port}.log`);
        const out = fs.openSync(log, 'a'); let child;
        try { child = spawn(process.execPath, [path.join(routingDir, script), ...args], { cwd: routingDir,
            detached: true, windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, ...env } }); }
        finally { fs.closeSync(out); }
        let launchError = false; child.once('error', () => { launchError = true; }); child.unref();
        for (let i = 0; i < 40 && !launchError; i++) {
            await new Promise(resolve => setTimeout(resolve, 150));
            const status = await probe(port, endpoint); if (status && matches(status)) return { ok: true, pid: child.pid };
        }
        problem('spawn_failed', `Процесс a6api на ${port} не прошёл проверку готовности`, 503);
    }
    async function spawnGateway() {
        if (preparing) return preparing;
        preparing = (async () => {
            if (!prepared()) problem('key_not_selected', 'Активный ключ a6api не подготовлен', 503);
            const configFile = path.join(secretDir, 'a6api-converter.json');
            durable.writeJsonSync(configFile, runtime.converter);
            await ensureChild({ port: CONVERTER_PORT, endpoint: '/health',
                matches: d => d.ok && d.provider === 'a6api' && d.upstream === runtime.converter.upstream,
                script: 'custom-openai-proxy.js', args: [configFile] });
            return ensureChild({ port: PORT, endpoint: '/__keepalive/api/status',
                matches: d => d.ok && d.upstream === runtime.keepaliveEnv.UPSTREAM && Number(d.port) === PORT,
                script: 'keepalive-proxy.js', env: runtime.keepaliveEnv });
        })();
        try { return await preparing; } finally { preparing = null; }
    }
    async function restartGateway() {
        if (!prepared()) problem('key_not_selected', 'Активный ключ a6api не подготовлен', 503);
        const lifecycle = require('../lifecycle');
        const specs = [{ port: PORT, endpoint: '/__keepalive/api/status', matches: d => d.ok && d.upstream === runtime.keepaliveEnv.UPSTREAM },
            { port: CONVERTER_PORT, endpoint: '/health', matches: d => d.ok && d.provider === 'a6api' && d.upstream === runtime.converter.upstream }];
        const holders = lifecycle.listeners();
        for (const spec of specs) {
            if (!(holders.get(spec.port) || new Set()).size) continue;
            const status = await probe(spec.port, spec.endpoint);
            if (!status || !spec.matches(status)) problem('port_occupied', `На ${spec.port} чужой или неотвечающий процесс. Ничего не останавливаю.`, 503);
        }
        for (const spec of specs) {
            if (!(holders.get(spec.port) || new Set()).size) continue;
            const stopped = await lifecycle.killPort(spec.port, { drainMs: spec.port === PORT ? 120000 : 0 });
            if (!stopped.freed) problem('stop_failed', `Порт ${spec.port} не освободился`, 503);
        }
        return spawnGateway();
    }
    return { state, balance, models, selectKey, saveModels, saveRouteTier, activate, selected, prepared, readSelection, setHub, spawn: spawnGateway, restart: restartGateway, runtime };
}
module.exports = { createGateway, buildRuntimeConfig, PORT, CONVERTER_PORT, TIERS, DEFAULT_MAP };

if (require.main === module) {
    (async () => {
        if (process.argv[2] !== 'restart') throw new Error('Usage: node a6api-gateway.js restart');
        const gateway = createGateway();
        await gateway.restart();
        console.log('a6api gateway and converter are ready');
    })().catch(e => { console.error(e.message); process.exitCode = 1; });
}
