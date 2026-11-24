#!/usr/bin/env node
'use strict';

// Read-only whole-dashboard fixture for Tabs Manager acceptance. All browser HTTP
// requests are intercepted; no hub/provider module, server or owner profile loads.
// Exported for the test runner; this module deliberately has no production start.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const ROUTING = path.join(ROOT, 'routing');
const ORIGIN = 'http://127.0.0.1:45398'; // Interception origin; nothing listens here.
const KEY = 'dashboard-tabs-config-v1';
const SENTINEL = 'tabs-manager-fixture-owner-sentinel';
const DEFAULTS = ['fin', 'league', 'github', 'outlook', 'google', 'gemini', 'agentrouter', 'gorouter', 'justwoker', 'kktoken', 'uncensoredlabs', 'xingchi', 'freegg', 'apinex', 'kvotum', 'threerouter', 'premier', 'vani', 'dacall', 'cleanapis', 'artbloom', 'fxqidian', 'lsapi', 'budsin', 'nova', 'odyssey', 'bai', 'getunikey', 'aipm', 'hcnsec', 'aikeysapi', 'rumeng', 'tabi', 'seekai', 'custom', 'a6api', 'media', 'plugins', 'health', 'models', 'api-gateway', 'routes', 'settings'];
const EXTRA = ['whoami', 'memory'];

function snapshotSource(filename = process.env.TABS_MANAGER_DASH || path.join(ROUTING, 'proxy-dashboard.html')) {
    const html = fs.readFileSync(filename, 'utf8');
    const assets = new Map();
    for (const match of html.matchAll(/(?:src|href)=["'](\/vendor\/[^"'#?]+)["']/g)) {
        const pathname = match[1];
        const file = path.resolve(ROUTING, 'vendor', pathname.slice('/vendor/'.length));
        if (file.startsWith(path.resolve(ROUTING, 'vendor') + path.sep) && fs.existsSync(file)) {
            assets.set(pathname, fs.readFileSync(file));
        }
    }
    return {
        filename: path.resolve(filename), html, assets,
        sha256: crypto.createHash('sha256').update(html).digest('hex'),
        sortablePath: [...assets.keys()].find(p => /sortable/i.test(p)) || null,
        hasViewportMeta: /<meta\b[^>]*\bname\s*=\s*["']viewport["']/i.test(html),
    };
}

function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
        [k, /(?:password|token|secret|api[_-]?key|authorization|cookie)/i.test(k) ? '<redacted>' : redact(v)]));
}

// Explicit EMPTY/offline responses are fixture boundaries, not evidence that any
// backend works. Unknown endpoints remain 404 and are enumerated in the receipt.
function readOnlyReply(pathname) {
    if (pathname === '/__switch/api/status') return { current: 'official', backends: {}, oauth: { loggedIn: false } };
    if (pathname === '/__switch/api/health') return { current: 'official', services: [], wired: {}, git: {}, uptime_s: 0 };
    if (pathname === '/__switch/api/routes') return { ok: true, providers: [] };
    if (pathname === '/__switch/api/league') return { me: null, peers: [], groups: [], receiver: { configured: false } };
    if (pathname === '/__switch/api/league/me') return { ok: true, role: 'member', groups: [], canUpload: false };
    if (pathname === '/__switch/api/league/chat') return { ok: true, groups: {}, unknown: [] };
    if (pathname === '/__switch/api/league/gateways') return { ok: true, items: [] };
    if (pathname === '/__switch/api/league/receiver') return { ok: true, configured: false };
    if (pathname === '/__switch/api/models/health') return { ok: true, pairs: [] };
    if (pathname === '/__switch/api/api-gateway') return {
        ok: true, canWrite: false, providers: [], models: [], candidatesLoaded: false,
        manifest: { version: 1, revision: 0, enabled: false },
        public: { anthropicBaseUrl: ORIGIN, openaiBaseUrl: ORIGIN + '/openai/v1' },
    };
    if (pathname === '/__switch/api/api-gateway/clients') return { ok: true, claude: { status: 'fixture-offline' }, opencode: { status: 'fixture-offline' }, hermes: { installed: false } };
    if (pathname === '/__switch/api/api-gateway/sidecar') return { status: 'unavailable', installed: false, verified: false };
    if (/\/gemini\/list$/.test(pathname)) return { ok: true, accounts: [], server: { up: true }, tiers: [] }; // Explicit warm/offline precondition: no cold-provider autostart outside Tabs Manager scope.
    if (/\/google\/list$/.test(pathname)) return { ok: true, accounts: [] };
    if (/\/(?:ol|outlook)\/list$/.test(pathname)) return { ok: true, items: [], summary: {} };
    if (/\/sessions$/.test(pathname)) return { ok: true, sessions: [] };
    if (/\/keys$/.test(pathname)) return { ok: true, keys: [] };
    if (/\/models$/.test(pathname)) return { ok: true, models: [] };
    if (/\/modelmap$/.test(pathname)) return { ok: true, modelMap: {} };
    if (/\/active-model$/.test(pathname)) return { ok: true, model: null };
    if (/\/keepalive\/state$/.test(pathname)) return { ok: true, cfg: {}, defaults: {}, stats: {}, latency: {}, port: 0 };
    if (/\/autorotate(?:\/state)?$/.test(pathname)) return { ok: true, enabled: false, history: [] };
    if (/\/(?:ref-codes|refcodes)$/.test(pathname)) return { ok: true, codes: {} };
    return null;
}

async function installFixture(context, source, record, { native, initialConfig = null, initialActive = 'fin' }) {
    await context.exposeBinding('__tabsManagerQaRecord', (_source, item) => {
        if (item.kind === 'storage') record.storageWrites.push(item);
        else record.inputEvents.push(item);
    });
    await context.addInitScript(({ key, sentinel, native, initialConfig, initialActive }) => {
        window.__tabsManagerQaPhase = 'boot';
        window.__tabsManagerQaPending = [];
        window.__tabsManagerQaFetchPending = 0;
        const fetchActual = window.fetch.bind(window);
        window.fetch = async (...args) => {
            window.__tabsManagerQaFetchPending++;
            try { return await fetchActual(...args); }
            finally { window.__tabsManagerQaFetchPending--; }
        };
        const send = item => {
            const p = window.__tabsManagerQaRecord({ ...item, phase: window.__tabsManagerQaPhase, url: location.href });
            window.__tabsManagerQaPending.push(p.catch(() => {}));
        };
        const proto = Storage.prototype;
        for (const method of ['setItem', 'removeItem', 'clear']) {
            const original = proto[method];
            proto[method] = function (...args) {
                let local = false;
                try { local = this === localStorage; } catch {}
                const changedKey = method === 'clear' ? null : String(args[0]);
                const before = changedKey === null ? null : this.getItem(changedKey);
                const stack = new Error('storage writer provenance').stack;
                const result = original.apply(this, args);
                if (local) send({ kind: 'storage', operation: method, key: changedKey, stack,
                    before: changedKey === key ? before : '<non-tabs-value-not-recorded>',
                    after: changedKey === key ? this.getItem(changedKey) : '<non-tabs-value-not-recorded>' });
                return result;
            };
        }
        if (location.origin.startsWith('http')) {
            try {
                if (sessionStorage.getItem('tabs-manager-fixture-seeded') !== '1') {
                    window.__tabsManagerQaPhase = 'fixture-seed';
                    if (initialConfig !== null) localStorage.setItem(key, typeof initialConfig === 'string' ? initialConfig : JSON.stringify(initialConfig));
                    localStorage.setItem('opencode_active_tab', initialActive);
                    localStorage.setItem(sentinel, 'isolated-test-sentinel-not-an-owner-profile');
                    sessionStorage.setItem('tabs-manager-fixture-seeded', '1');
                    window.__tabsManagerQaPhase = 'boot';
                }
            } catch {}
        }
        if (native) {
            Object.defineProperty(window, 'Sortable', { configurable: false, get: () => undefined, set: () => {} });
        }
        const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup',
            'dragstart', 'dragover', 'drop', 'dragend', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'keydown', 'keyup'];
        for (const type of types) document.addEventListener(type, event => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target?.closest('#tabs-manager') && !['dragend', 'pointercancel', 'touchcancel', 'keydown', 'keyup', 'drop'].includes(type)) return;
            const row = target?.closest('li[data-tab]');
            send({ kind: 'input', type, trusted: event.isTrusted, tab: row?.dataset.tab || null,
                list: target?.closest('ul')?.id || null, key: /^key/.test(type) ? event.key : null,
                pointerType: event.pointerType || (/^touch/.test(type) ? 'touch' : /^mouse/.test(type) ? 'mouse' : null) });
        }, true);
    }, { key: KEY, sentinel: SENTINEL, native, initialConfig, initialActive });

    await context.route('**/*', async route => {
        const req = route.request();
        const url = new URL(req.url());
        const method = req.method();
        let payload = null;
        if (!['GET', 'HEAD'].includes(method)) {
            try { payload = redact(req.postDataJSON()); } catch { payload = req.postData() ? '<non-json-body>' : null; }
        }
        const request = { method, path: url.pathname, query: url.search, origin: url.origin,
            phase: record.currentScenario || 'boot', payload, intercepted: true,
            initiator: req.frame()?.url() || null };
        record.requests.push(request);
        if (url.origin !== ORIGIN) {
            request.boundary = 'external-blocked'; record.blockedExternal.push(request);
            return route.abort('blockedbyclient');
        }
        if (!['GET', 'HEAD'].includes(method)) {
            request.boundary = 'mutation-blocked'; record.forbidden.push(request);
            return route.fulfill({ status: 403, contentType: 'application/json',
                body: JSON.stringify({ ok: false, code: 'tabs_manager_fixture_mutation_forbidden' }) });
        }
        if (url.pathname === '/') {
            request.boundary = 'exact-dashboard-source';
            return route.fulfill({ contentType: 'text/html; charset=utf-8', body: source.html });
        }
        if (native && /\/vendor\/.*sortable/i.test(url.pathname)) {
            request.boundary = 'sortable-deliberately-disabled';
            return route.fulfill({ contentType: 'application/javascript', body: '/* native-fallback acceptance: Sortable intentionally unavailable */' });
        }
        if (url.pathname.startsWith('/vendor/')) {
            let body = source.assets.get(url.pathname);
            if (!body && /^\/vendor\/[a-z0-9_./-]+$/i.test(url.pathname)) {
                const filename = path.resolve(ROUTING, 'vendor', url.pathname.slice('/vendor/'.length));
                const assetRoot = path.resolve(ROUTING, 'vendor') + path.sep;
                if (filename.startsWith(assetRoot) && fs.existsSync(filename) && fs.statSync(filename).isFile()) {
                    body = fs.readFileSync(filename); source.assets.set(url.pathname, body);
                }
            }
            if (body) {
                request.boundary = 'real-local-asset';
                const ext = path.extname(url.pathname);
                return route.fulfill({ contentType: ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'font/woff2', body });
            }
        }
        if (url.pathname === '/__switch/api/league/me') {
            request.boundary = 'role-probe-transport-unavailable-out-of-scope';
            return route.abort('failed'); // Real source catch preserves role-owned ladmin instead of racing seed visibility.
        }
        const body = readOnlyReply(url.pathname);
        request.boundary = body === null ? 'unimplemented-fixture-get' : 'explicit-offline-fixture-get';
        if (body === null) record.unimplemented.push({ path: url.pathname, query: url.search });
        return route.fulfill({ status: body === null ? 404 : 200, contentType: 'application/json; charset=utf-8',
            body: JSON.stringify(body ?? { ok: false, code: 'tabs_manager_fixture_get_unimplemented' }) });
    });
    if (typeof context.routeWebSocket === 'function') {
        await context.routeWebSocket('**/*', socket => {
            record.blockedSockets.push(socket.url());
            socket.close({ code: 1008, reason: 'isolated Tabs Manager fixture' });
        });
    }
}

module.exports = { ROOT, ROUTING, ORIGIN, KEY, SENTINEL, DEFAULTS, EXTRA, snapshotSource, installFixture };
