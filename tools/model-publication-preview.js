#!/usr/bin/env node
'use strict';
// Explicit local preview fixture: real dashboard + real publication transaction,
// disposable Claude/OpenCode files. Never start the production hub or providers.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROUTING = path.join(ROOT, 'routing');
const scratch = process.env.HERMES_TEST_SCRATCH || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch')
    : path.join(os.homedir(), '.cache/hermes/scratch'));
fs.mkdirSync(scratch, { recursive: true });
for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = scratch;
const run = fs.mkdtempSync(path.join(scratch, 'model-publication-preview-'));
const home = path.join(run, 'home');
const hub = path.join(run, 'hub');
const paths = {
    manifestPath: path.join(hub, 'routing/api-gateway.json'),
    defaultManifestPath: path.join(hub, 'routing/api-gateway.default.json'),
    backendsPath: path.join(home, '.claude/backends.json'),
    settingsPath: path.join(home, '.claude/settings.json'),
};
const targets = ['User config', 'Wiki config', 'Hub config'].map((label, index) => ({
    label, path: path.join(run, ['user', 'wiki', 'hub'][index], 'opencode.json'),
}));
const guards = [];
const prefix = path.resolve(run).toLowerCase() + path.sep;
const inside = file => {
    const resolved = path.resolve(String(file)).toLowerCase();
    return resolved === prefix.slice(0, -1) || resolved.startsWith(prefix);
};
const handles = new Set();
const open = fs.openSync;
fs.openSync = function (file, flags, ...args) {
    if (!inside(file) && (typeof flags !== 'string' || /[wa+]/.test(flags))) {
        guards.push('outside fixture open');
        throw new Error('preview writable handle must stay inside disposable fixture');
    }
    const fd = open.call(this, file, flags, ...args);
    if (inside(file)) handles.add(fd);
    return fd;
};
const close = fs.closeSync;
fs.closeSync = function (fd) { handles.delete(fd); return close.call(this, fd); };
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'copyFileSync', 'linkSync', 'chmodSync']) {
    const original = fs[name];
    fs[name] = function (file, ...args) {
        if (!(typeof file === 'number' ? handles.has(file) : inside(file))
            || ['renameSync', 'copyFileSync', 'linkSync'].includes(name) && !inside(args[0])) {
            guards.push('outside fixture write: ' + name);
            throw new Error('preview write must stay inside disposable fixture');
        }
        return original.call(this, file, ...args);
    };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    guards.push('outbound socket blocked');
    throw new Error('preview has no outbound sockets');
};
Object.assign(process.env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(run, 'xdg'),
    API_GATEWAY_WIKI_ROOT: path.join(run, 'wiki'),
    ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(run, 'local-hop.key'),
});
const gateway = require('../routing/lib/api-gateway.js');
const { createProductionApiGateway } = require('../routing/lib/api-gateway-integration.js');
const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const seed = { version: 1, revision: 7, enabled: true, models: {
    'agentrouter/gpt-5.6-sol': { displayName: 'AgentRouter / GPT 5.6 Sol',
        claudeBehavesAs: 'claude-sonnet-5', contextTokens: 200000, outputTokens: 24000,
        publishedAt: '2026-11-20T00:00:00.000Z' },
} };
write(paths.manifestPath, seed);
write(paths.defaultManifestPath, seed);
write(paths.backendsPath, { providers: { agentrouter: {}, gorouter: {}, gemini: {}, a6api: {} }, activeProvider: 'agentrouter' });
write(paths.settingsPath, { model: 'agentrouter/gpt-5.6-sol[1m]', permissions: { defaultMode: 'ask' },
    modelPicker: gateway.buildModelPicker(seed), previewSentinel: 'unchanged' });
write(targets[0].path, { model: 'abuse-hub/agentrouter/gpt-5.6-sol', providers: { other: { name: 'Unchanged fixture' } }, previewSentinel: 'unchanged' });
write(targets[1].path, { model: 'other/unchanged', provider: { other: { name: 'Unchanged fixture' } }, previewSentinel: 'unchanged' });
const product = createProductionApiGateway({
    repoRoot: hub, home, wikiRoot: path.join(run, 'wiki'), paths, opencodeTargets: targets,
    opencodeJournalPath: path.join(run, 'opencode.txn'),
    resolveModelCandidates: async () => ['gpt-5.6-sol', 'gpt-6.1-sol'].map(model => ({ provider: 'agentrouter', model, source: 'preview-fixture' })),
    readPassive: async () => ({}), readProbes: async () => ({}),
    sidecarStatus: async () => ({ status: 'unavailable', installed: false, verified: false }),
    hermesFactory: () => ({ status: () => ({ installed: false, status: 'preview-fixture' }), sync: () => { throw new Error('preview never configures Hermes'); } }),
});
product.openCodeService.sync(seed);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
let origin = '', requests = [];
function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
}
const session = { id: 'preview-only', name: 'Изолированный preview', email: 'preview@example.test',
    api_key: 'fixture-not-a-live-key', active: true, status: 'live', balance: 25, grant: 25 };
const catalog = ['gpt-5.6-sol', 'gpt-6.1-sol'].map(id => ({ id, supported_endpoint_types: ['openai'] }));
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push({ method: req.method, pathname });
    if (product.routes.handle(req, res)) return;
    if (pathname === '/__publication-preview/ready') return json(res, 200, {
        ok: true, scope: 'isolated-model-publication', revision: gateway.readPublishedManifest(paths).revision,
    });
    if (pathname === '/__publication-preview/state') return json(res, 200, {
        manifest: gateway.readPublishedManifest(paths),
        claude: { current: read(paths.settingsPath).model, picker: read(paths.settingsPath).modelPicker },
        opencode: targets.map(target => {
            const config = read(target.path), provider = config.providers?.['abuse-hub'] || config.provider?.['abuse-hub'];
            return { label: target.label, current: config.model || null, models: Object.keys(provider.models) };
        }), guards, requests,
    });
    if (pathname === '/openai/v1/models') return json(res, 200, { object: 'list', data: gateway.toOpenAiModels(gateway.readPublishedManifest(paths)) });
    if (pathname === '/__switch/api/status') return json(res, 200, {
        current: 'agentRouter', presets: { agentRouter: { model: 'gpt-5.6-sol', base_url: origin } },
        backends: { agentrouter: { label: 'AgentRouter', base_url: origin }, gorouter: { label: 'GoRouter', base_url: origin } }, oauth: {},
    });
    if (pathname === '/__switch/api/ar/sessions') return json(res, 200, { ok: true, sessions: [session] });
    if (pathname === '/__switch/api/ar/models') return json(res, 200, { ok: true, models: catalog });
    if (pathname === '/__switch/api/ar/active-model') return json(res, 200, { ok: true, model: 'gpt-5.6-sol' });
    if (pathname === '/__switch/api/ar/modelmap') return json(res, 200, { ok: true, modelMap: { opus: 'gpt-5.6-sol' } });
    if (pathname === '/__switch/api/ar/keepalive/state') {
        // Visual fixture only; the actual keepalive path is exercised separately
        // by check-keepalive-defaults with a real isolated child and HTTP readback.
        const cfg = { hedgeMs: 20000, maxHedges: 0, maxAttempts: 3, preCommitMs: 10000, poolFallbackModel: '' };
        return json(res, 200, { ok: true, cfg, defaults: cfg, stats: {}, latency: {}, port: 0 });
    }
    if (pathname === '/__switch/api/go/sessions') return json(res, 200, { ok: true, sessions: [] });
    if (pathname === '/__switch/api/go/active-model') return json(res, 200, { ok: true, model: 'fixture-model' });
    if (pathname.startsWith('/__switch/api/ar/')) return json(res, 200, { ok: true, entries: [], runs: [], shared: [] });
    if (pathname === '/') {
        const banner = '<div style="position:fixed;top:0;left:0;right:0;z-index:10000;padding:3px 12px;background:#153724;color:#bbf7d0;font:11px system-ui;pointer-events:none">Изолированный preview · аккаунт и данные демонстрационные · рабочие настройки не меняются</div>';
        const html = fs.readFileSync(path.join(ROUTING, 'proxy-dashboard.html'), 'utf8').replace(/(<body\b[^>]*>)/i, '$1' + banner);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
    }
    if (pathname.startsWith('/vendor/')) {
        const filename = pathname.slice('/vendor/'.length);
        if (filename && filename === path.basename(filename) && /^[a-zA-Z0-9_.-]+$/.test(filename)) {
            const file = path.join(ROUTING, 'vendor', filename);
            if (fs.existsSync(file) && fs.statSync(file).isFile()) {
                const type = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)];
                if (type) { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); return res.end(fs.readFileSync(file)); }
            }
        }
    }
    json(res, 404, { ok: false, code: 'preview_fixture_path_unimplemented' });
});
const port = Number(process.env.PUBLICATION_PREVIEW_PORT || 0);
server.on('error', error => { console.error(error.code || error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
    origin = 'http://127.0.0.1:' + server.address().port;
    const receipt = { url: origin, pid: process.pid, run, paths, targets, scope: 'isolated fixture; production services untouched' };
    write(path.join(run, 'preview.json'), receipt);

    console.log('PUBLICATION_PREVIEW ' + JSON.stringify(receipt));
});
function shutdown() {
    net.Socket.prototype.connect = connect;
    write(path.join(run, 'final.json'), {
        manifest: gateway.readPublishedManifest(paths), requests, guards, closing: true,
    });
    server.closeAllConnections();
    server.close(() => {});
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
module.exports = { server, run, paths, targets };
