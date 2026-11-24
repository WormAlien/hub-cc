#!/usr/bin/env node
'use strict';
// Disposable whole-dashboard fixture. Account/catalog data is demonstrative;
// a6api gateway/routes, publication, Claude picker and OpenCode writers are REAL.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const childProcess = require('node:child_process');
const { fileURLToPath } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const ROUTING = path.join(ROOT, 'routing');
const PREFIX = '/__a6api-preview';
const SCOPE = 'isolated-a6api-models';
const MAIN_MODEL = 'deepseek-v4.1-flash-1017';
const BASE_MODELS = [MAIN_MODEL, 'deepseek-v4-pro', 'vendor/nested-model'];
const MAIN_ID = 'a6api/' + MAIN_MODEL;
const OTHER_ID = 'agentrouter/gpt-5.6-sol';
let activeRun = null;
const clone = value => structuredClone(value);
const parseFile = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
const inside = (root, file) => {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const filePath = file => file instanceof URL ? fileURLToPath(file) : Buffer.isBuffer(file) ? file.toString() : String(file);
function json(res, status, value) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
}
function fixtureError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
async function bodyObject(req) {
    const parts = []; let length = 0;
    for await (const part of req) {
        length += part.length;
        if (length > 65536) throw fixtureError('preview_body_too_large', 413);
        parts.push(part);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); }
    catch { throw fixtureError('preview_invalid_json'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fixtureError('preview_invalid_json');
    return value;
}
function installGuards(run, guards, fault) {
    // Same durable-writer wrapper boundary as model-publication-preview.js,
    // including writable file descriptors; fsync remains the actual OS operation.
    const original = new Map(), promiseOriginal = new Map(), descriptors = new Map();
    const violation = label => {
        guards.push(label);
        throw fixtureError('preview_isolation_violation', 500);
    };
    const permittedRead = file => {
        if (inside(run, file)) return true;
        const normalized = path.resolve(file).replaceAll('\\', '/');
        if (!inside(ROOT, file) || /(?:^|\/)(?:\.secrets|\.claude)(?:\/|$)/i.test(normalized)
            || /(?:^|\/)\.env(?:[.\/]|$)/i.test(normalized)
            || /(?:active-key\.(?:txt|json)|(?:keys|sessions|token|credentials)\.json|\.key$)/i.test(normalized)) return false;
        return /\.(?:js|cjs|mjs|json|css|html|woff2)$/i.test(normalized);
    };
    const check = (file, write, kind = 'file') => {
        if (typeof file === 'number') {
            if (!descriptors.has(file) || write && !descriptors.get(file).writable) violation('unowned file descriptor ' + kind);
            return;
        }
        const resolved = path.resolve(filePath(file));
        if (write ? !inside(run, resolved) : !permittedRead(resolved)) violation((write ? 'outside fixture write: ' : 'private/outside read: ') + kind
            + (!write && inside(ROOT, resolved) ? ' (repo/' + path.relative(ROOT, resolved).replaceAll('\\', '/') + ')' : ''));
        if (write) fault(resolved, kind);
    };
    const writable = flags => typeof flags === 'string' ? /[wa+]/.test(flags)
        : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0;
    const wrap = (name, fn) => {
        if (typeof fs[name] !== 'function') return;
        const saved = fs[name]; original.set(name, saved); fs[name] = fn(saved);
    };
    wrap('openSync', saved => function (file, flags, ...args) {
        const write = writable(flags); check(file, write, 'openSync');
        const fd = saved.call(fs, file, flags, ...args);
        descriptors.set(fd, { writable: write && inside(run, filePath(file)) }); return fd;
    });
    wrap('closeSync', saved => function (fd) { descriptors.delete(fd); return saved.call(fs, fd); });
    wrap('open', saved => function (file, flags, ...args) {
        const write = writable(flags); check(file, write, 'open');
        const callback = args.pop();
        return saved.call(fs, file, flags, ...args, (error, fd) => {
            if (!error) descriptors.set(fd, { writable: write && inside(run, filePath(file)) });
            callback(error, fd);
        });
    });
    wrap('close', saved => function (fd, callback) { descriptors.delete(fd); return saved.call(fs, fd, callback); });
    for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync',
        'copyFileSync', 'linkSync', 'chmodSync', 'chownSync', 'truncateSync', 'utimesSync',
        'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'link', 'chmod', 'chown', 'truncate', 'utimes']) {
        wrap(name, saved => function (file, ...args) {
            check(file, true, name);
            if (/^(?:rename|copyFile|link)/.test(name)) check(args[0], true, name + ' destination');
            return saved.call(fs, file, ...args);
        });
    }
    for (const name of ['writeSync', 'writevSync', 'ftruncateSync', 'fchmodSync', 'fchownSync', 'futimesSync',
        'write', 'writev', 'ftruncate', 'fchmod', 'fchown', 'futimes']) {
        wrap(name, saved => function (fd, ...args) { check(fd, true, name); return saved.call(fs, fd, ...args); });
    }
    for (const name of ['readFileSync', 'readFile', 'createReadStream']) {
        wrap(name, saved => function (file, ...args) { check(file, false, name); return saved.call(fs, file, ...args); });
    }
    wrap('createWriteStream', saved => function (file, ...args) { check(file, true, 'createWriteStream'); return saved.call(fs, file, ...args); });
    for (const name of ['symlinkSync', 'symlink']) wrap(name, () => () => violation('fixture symlinks prohibited'));
    for (const name of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'link', 'chmod', 'chown', 'truncate', 'utimes', 'readFile', 'open', 'symlink']) {
        if (typeof fs.promises[name] !== 'function') continue;
        const saved = fs.promises[name]; promiseOriginal.set(name, saved);
        fs.promises[name] = async function (file, ...args) {
            if (name === 'symlink') return violation('fixture symlinks prohibited');
            check(file, name === 'open' ? writable(args[0]) : name !== 'readFile', 'promises.' + name);
            if (['rename', 'copyFile', 'link'].includes(name)) check(args[0], true, 'promises.' + name + ' destination');
            const result = await saved.call(fs.promises, file, ...args);
            if (name === 'open') descriptors.set(result.fd, { writable: writable(args[0]) && inside(run, filePath(file)) });
            return result;
        };
    }
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function () { return violation('outbound socket blocked'); };
    const processes = new Map();
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        processes.set(name, childProcess[name]); childProcess[name] = () => violation('child process blocked: ' + name);
    }
    return () => {
        for (const [name, saved] of original) fs[name] = saved;
        for (const [name, saved] of promiseOriginal) fs.promises[name] = saved;
        for (const [name, saved] of processes) childProcess[name] = saved;
        net.Socket.prototype.connect = connect;
    };
}

/**
 * Import has no startup side effects. At most one fixture is active per process.
 * createPreview({port:0,lifetimeMs:600000,validatePublication}) lets the parent
 * inject a real guard if backend work changed its exported signature. Otherwise
 * the inspected gateway.validatePublication is passed to the inspected production
 * validatePublication option. guardWired reports wiring ONLY, never acceptance.
 */
async function createPreview(options = {}) {
    if (activeRun) throw fixtureError('preview_already_active');
    const scratch = path.resolve(options.scratch || process.env.HERMES_TEST_SCRATCH || (process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch') : path.join(os.homedir(), '.cache/hermes/scratch')));
    fs.mkdirSync(scratch, { recursive: true });
    const run = fs.mkdtempSync(path.join(scratch, 'a6api-models-preview-'));
    activeRun = run;
    const runId = crypto.randomUUID(), home = path.join(run, 'home'), hubRoot = path.join(run, 'hub');
    const routingDir = path.join(hubRoot, 'routing'), secretDir = path.join(home, '.secrets');
    const paths = {
        manifestPath: path.join(routingDir, 'api-gateway.json'),
        defaultManifestPath: path.join(routingDir, 'api-gateway.default.json'),
        backendsPath: path.join(home, '.claude/backends.json'),
        settingsPath: path.join(home, '.claude/settings.json'),
        hermesConfigPath: path.join(home, '.hermes/config.yaml'),
        modelMapPath: path.join(routingDir, 'a6api-modelmap.json'),
        routesMapPath: path.join(routingDir, 'a6api-routes-modelmap.json'),
        selectionPath: path.join(secretDir, 'a6api-gateway.json'),
        keyPath: path.join(secretDir, 'a6api-active-key.txt'),
        openCodeJournalPath: path.join(run, 'opencode.txn'),
    };
    const targets = ['User config', 'Wiki config', 'Hub config'].map((label, index) => ({
        label, path: path.join(run, ['user', 'wiki', 'hub'][index], 'opencode.json'),
    }));
    const env = {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(run, 'xdg'),
        LOCALAPPDATA: path.join(run, 'local'), APPDATA: path.join(run, 'roaming'),
        API_GATEWAY_WIKI_ROOT: path.join(run, 'wiki'), ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(run, 'local-hop.key'),
        TMPDIR: run, TMP: run, TEMP: run, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        HERMES_HOME: path.join(home, '.hermes'),
    };
    const oldEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env); // MUST precede every repository require.
    const guards = [], requests = [], apiRequests = [], hubCalls = [], faults = [];
    const mode = { token9: 'ready', token10: 'ready', catalog: 'normal', account: 'ready', readonly: false };
    let pendingManifestFailure = false, syncBackup = null, manifestBackup = null;
    const restoreGuards = installGuards(run, guards, (file, kind) => {
        if (pendingManifestFailure && kind.startsWith('rename') && file === path.resolve(paths.manifestPath)) {
            pendingManifestFailure = false; faults.push({ kind: 'manifest-write', code: 'EIO' });
            throw Object.assign(new Error('fixture manifest destination refuses one write'), { code: 'EIO' });
        }
    });
    const writeText = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
    const write = (file, value, bom = false) => {
        let text = JSON.stringify(value, null, 2) + '\n';
        if (bom) text = '\ufeff' + text.replaceAll('\n', '\r\n');
        writeText(file, text);
    };
    const resetEnvironment = () => {
        restoreGuards();
        for (const [key, value] of Object.entries(oldEnv)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        activeRun = null;
    };
    let server, lifetime, closing = false, receipt, a6, product;
    try {
        const manifestApi = require('../routing/lib/api-gateway.js');
        const durable = require('../routing/lib/durable-write.js');
        const { createGateway } = require('../routing/lib/a6api-gateway.js');
        const { createRoutes: createA6Routes, canWrite: a6CanWrite } = require('../routing/lib/a6api-routes.js');
        const { ApiError } = require('../routing/lib/a6api-api.js');
        const { createProductionApiGateway } = require('../routing/lib/api-gateway-integration.js');
        const proxySource = fs.readFileSync(path.join(ROUTING, 'transparent-proxy.js'), 'utf8');
        const sourceFunction = name => {
            const start = proxySource.indexOf('function ' + name + '('), end = proxySource.indexOf('\n}', start);
            if (start < 0 || end <= start) throw fixtureError('preview_map_writer_missing', 500);
            return proxySource.slice(start, end + 2);
        };
        // Execute only the pure production map seams, never import/start the hub.
        const mapWriter = vm.createContext({ fs, path, __dirname: routingDir, CC_MODEL_PREFIX: { a6api: 'a6api' },
            ROUTE_TIERS: ['default', 'opus', 'sonnet', 'haiku', 'gpt'], TIER_MIRROR_TIERS: ['opus', 'sonnet', 'haiku'],
            _tierMirrorBusy: false, durableWriteJson: durable.writeJsonSync,
            logLine() { throw fixtureError('preview_map_writer_failed', 500); } });
        for (const name of ['tierMapFile', 'writeTierMap', 'mirrorTierMapPair', 'a6ReadMap', 'a6WriteMap']) {
            vm.runInContext(sourceFunction(name), mapWriter);
        }
        const seed = { version: 1, revision: 7, enabled: true, models: {
            [MAIN_ID]: { displayName: 'Existing custom DeepSeek label', claudeBehavesAs: 'claude-sonnet-5',
                contextTokens: 200000, outputTokens: 24000, publishedAt: '2026-11-20T00:00:00.000Z' },
            [OTHER_ID]: { displayName: 'Unrelated AgentRouter sentinel', claudeBehavesAs: 'claude-sonnet-5',
                contextTokens: 200000, outputTokens: 24000, publishedAt: '2026-11-19T12:34:56.000Z' },
        } };
        const nativeMap = { default: 'legacy-native-default', opus: 'old-opus-target', sonnet: 'old-sonnet-target',
            haiku: 'old-haiku-target', gpt: 'preserved-native-gpt', futureNativeField: 'unchanged' };
        const routesMap = { ...nativeMap, default: 'independent-routes-default', gpt: 'independent-routes-gpt',
            futureRoutesField: 'unchanged' };
        write(paths.manifestPath, seed); write(paths.defaultManifestPath, seed);
        write(paths.backendsPath, { version: 1, activeProvider: 'agentrouter', providers: {
            a6api: { label: 'a6api', upstream: 'http://127.0.0.1:20191' },
            agentrouter: { label: 'AgentRouter', upstream: 'http://127.0.0.1:20104' },
            gorouter: { label: 'GoRouter', upstream: 'http://127.0.0.1:20113' },
        }, aliases: { a6: 'a6api', ar: 'agentrouter', go: 'gorouter' }, futureRegistryField: 'unchanged' });
        write(paths.settingsPath, { model: 'agentrouter/gpt-5.6-sol[1m]', modelPicker: manifestApi.buildModelPicker(seed),
            env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:20100', ANTHROPIC_AUTH_TOKEN: 'dummy', PREVIEW_ENV_SENTINEL: 'unchanged',
                CLAUDE_CODE_SUBAGENT_MODEL: 'agentrouter/gpt-5.6-sol', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' },
            permissions: { defaultMode: 'ask', allow: ['Read'], deny: ['Network'] },
            modelSettings: { effort: 'high' }, hooks: { fixture: 'never-run' }, futureField: { keep: [true, 1] } }, true);
        writeText(paths.hermesConfigPath, 'model:\n  default: agentrouter/gpt-5.6-sol\n  provider: custom:abuse-hub\n  base_url: http://127.0.0.1:20100/openai/v1\nagent:\n  max_iterations: 90\npreview_sentinel: unchanged\n');
        write(paths.modelMapPath, nativeMap); write(paths.routesMapPath, routesMap);
        write(path.join(secretDir, 'a6api-config.json'), { userId: 314, panelToken: 'fixture-panel-token-never-live' });
        for (const [index, target] of targets.entries()) {
            write(target.path, { model: index === 0 ? 'abuse-hub/agentrouter/gpt-5.6-sol' : 'other/unchanged-current',
                small_model: 'other/unchanged-small', agents: { build: { model: 'other/unchanged-agent' } },
                permission: { edit: 'ask' }, mcp: { fixture: { command: ['never-run'] } }, futureField: { keep: true },
                [index === 0 ? 'providers' : 'provider']: { other: { name: 'Unchanged fixture provider', options: { fixtureSentinel: 'unchanged' } } } }, index === 0);
        }
        const longModels = Array.from({ length: 44 }, (_, index) => 'fixture-family/model-' + String(index + 1).padStart(2, '0'));
        longModels.push('fixture-family/' + 'long-exact-model-'.repeat(8) + 'end');
        const catalog = () => mode.catalog === 'empty' ? []
            : mode.catalog === 'long' ? [...BASE_MODELS, ...longModels, 'other-only', 'gpt-image-2']
            : [...BASE_MODELS, 'other-only', 'gpt-image-2'];
        const tokenRows = () => [9, 10].filter(id => mode['token' + id] !== 'missing').map(id => ({
            id, name: id === 9 ? 'Основной демонстрационный' : 'Другой демонстрационный', status: mode['token' + id] === 'disabled' ? 2 : 1,
            expired_time: mode['token' + id] === 'expired' ? 1 : -1,
            unlimited_quota: mode['token' + id] !== 'quota', remain_quota: mode['token' + id] === 'quota' ? 0 : 500,
            used_quota: 3, model_limits_enabled: true,
            model_limits: (id === 9 ? mode.catalog === 'long' ? [...BASE_MODELS, ...longModels] : BASE_MODELS : ['other-only']).join(','),
        }));
        const failAccount = () => {
            if (mode.account === 'missing') throw new ApiError('panel_token_missing', 'Аккаунт не подключён', 503);
            if (mode.account === 'disconnected') throw new ApiError('upstream_http', 'Демонстрационный отказ кабинета', 401, 401);
        };
        const failCatalog = () => { if (mode.catalog === 'failed') throw new ApiError('upstream_http', 'Каталог a6api недоступен (демонстрационный отказ)', 502, 503); };
        const ownToken = async id => {
            apiRequests.push({ action: 'ownToken', tokenId: Number(id) }); failAccount();
            const row = tokenRows().find(t => t.id === Number(id));
            if (!row) throw new ApiError('token_not_owned', 'Ключ не найден в вашем кабинете', 404);
            return clone(row);
        };
        const api = {
            ownToken,
            async models() { apiRequests.push({ action: 'models' }); failCatalog(); return clone(catalog()); },
            async reveal(id) {
                apiRequests.push({ action: 'reveal', tokenId: Number(id) }); await ownToken(id);
                return 'sk-demo-' + Number(id); // fake, never printed/exported.
            },
            async state() {
                apiRequests.push({ action: 'state' });
                if (mode.account === 'missing') throw new ApiError('panel_token_missing', 'Аккаунт не подключён', 503);
                if (mode.account === 'disconnected') throw new ApiError('upstream_http', 'Демонстрационный отказ кабинета', 401, 401);
                failCatalog();
                return { account: { balanceUsd: 5.58, spentUsd: 0.42 }, quotaPerUnit: 500000, fetchedAt: Date.now(),
                    models: clone(catalog()), tokens: tokenRows().map(t => ({ id: t.id, name: t.name, mask: 'demo-' + t.id + '-***',
                        status: t.status, expires: t.expired_time, unlimited: t.unlimited_quota, remainingUsd: t.remain_quota / 500000,
                        spentUsd: t.used_quota / 500000, restricted: t.model_limits_enabled, models: t.model_limits.split(','), routing: true })) };
            },
            async request(endpoint) {
                apiRequests.push({ action: 'request', endpoint });
                if (endpoint === '/api/user/self') {
                    if (mode.account === 'missing') throw new ApiError('panel_token_missing', 'Аккаунт не подключён', 503);
                    if (mode.account === 'disconnected') throw new ApiError('upstream_http', 'Демонстрационный отказ кабинета', 401, 401);
                    return { id: 314, quota: 2790000, used_quota: 210000 };
                }
                if (endpoint === '/api/status') return { quota_per_unit: 500000 };
                throw new ApiError('invalid_path', 'Only explicit panel fixture endpoints exist', 400);
            },
        };
        const hub = {
            readMap: routes => mapWriter.a6ReadMap(routes),
            writeMap(patch, routes) {
                hubCalls.push({ action: 'writeMap', routes: !!routes, patch: clone(patch) });
                return mapWriter.a6WriteMap(patch, routes);
            },
            isActive: () => false,
            publish: () => hubCalls.push({ action: 'publish' }),
            ensure: async () => { throw new ApiError('preview_activation_forbidden', 'Preview не запускает native-процессы', 403); },
            activate: async () => { throw new ApiError('preview_activation_forbidden', 'Preview не переключает клиентов', 403); },
            syncModel: async () => { throw new ApiError('preview_activation_forbidden', 'Preview не меняет текущую модель', 403); },
        };
        a6 = createGateway({ api, secretDir, routingDir, hub,
            clientFactory: () => ({ request: endpoint => api.request(endpoint) }),
            fetchImpl: async () => { throw fixtureError('preview_provider_probe_forbidden'); } });
        await a6.selectKey(9); // native durable fake-key preparation, not synthetic success.
        const validator = typeof options.validatePublication === 'function' ? options.validatePublication
            : typeof a6.validatePublication === 'function' ? input => a6.validatePublication(input) : undefined;
        product = createProductionApiGateway({
            repoRoot: hubRoot, home, wikiRoot: path.join(run, 'wiki'), paths,
            xdgConfigHome: path.join(run, 'xdg'), localAppData: path.join(run, 'local'), pathEnv: '',
            opencodeTargets: targets, opencodeJournalPath: paths.openCodeJournalPath,
            validatePublication: validator,
            resolveModelCandidates: async ({ providers } = {}) => {
                const allowed = providers?.length ? new Set(providers) : null;
                return [
                    ...catalog().filter(model => model !== 'gpt-image-2').map(model => ({ id: 'a6api/' + model, provider: 'a6api', model, catalogSource: 'configured' })),
                    { id: OTHER_ID, provider: 'agentrouter', model: 'gpt-5.6-sol', catalogSource: 'configured' },
                ].filter(row => !allowed || allowed.has(row.provider));
            },
            readPassive: async () => ({}), readProbes: async () => ({}),
            sidecarStatus: async () => ({ status: 'unavailable', installed: false, verified: false, fixture: true }),
            hermesFactory: () => ({ status: () => ({ installed: false, status: 'preview-fixture' }),
                sync: () => { throw fixtureError('preview_hermes_mutation_forbidden'); } }),
        });
        const initialSync = product.openCodeService.sync(seed);
        if (initialSync.ok !== true || initialSync.targets.length !== 3) throw fixtureError('preview_initial_sync_failed', 500);
        apiRequests.length = 0; hubCalls.length = 0;
        const a6Routes = createA6Routes({ gateway: a6, secretDir });
        const safeRead = file => { try { return { valid: true, config: parseFile(file) }; } catch (error) { return { valid: false, code: error.code || 'invalid_json', config: null }; } };
        function getState() {
            const manifest = safeRead(paths.manifestPath), claude = safeRead(paths.settingsPath), selection = a6.readSelection();
            return { scope: SCOPE, pid: process.pid, runId, closing,
                manifest: manifest.config, manifestValid: manifest.valid,
                claude: { config: claude.config, current: claude.config?.model || null, picker: claude.config?.modelPicker || null },
                backends: parseFile(paths.backendsPath), hermes: { configText: fs.readFileSync(paths.hermesConfigPath, 'utf8') },
                opencode: targets.map(target => {
                    const value = safeRead(target.path), block = value.config?.providers?.['abuse-hub'] || value.config?.provider?.['abuse-hub'];
                    return { label: target.label, ...value, current: value.config?.model || null, models: Object.keys(block?.models || {}), provider: block || null };
                }),
                native: { modelMap: parseFile(paths.modelMapPath), routesMap: parseFile(paths.routesMapPath),
                    selection: { selectedTokenId: selection?.tokenId || null, prepared: a6.prepared() }, calls: clone(hubCalls) },
                fixture: clone(mode), guardWired: !!validator, guards: clone(guards), guardViolationCount: guards.length,
                requests: clone(requests), apiRequests: clone(apiRequests), faults: clone(faults),
            };
        }
        function control(input) {
            const choices = { token9: ['ready', 'disabled', 'expired', 'missing', 'quota'], token10: ['ready', 'disabled', 'expired', 'missing', 'quota'],
                catalog: ['normal', 'empty', 'long', 'failed'], account: ['ready', 'disconnected', 'missing'],
                key: ['missing', 'unselected'], sync: ['invalid-target', 'restore-target'], manifest: ['corrupt', 'restore'] };
            if (Object.keys(input).some(key => !Object.hasOwn(choices, key) && !['readonly', 'failNextManifestWrite'].includes(key))) throw fixtureError('preview_unknown_control');
            for (const [key, value] of Object.entries(input)) {
                if (Object.hasOwn(choices, key) ? !choices[key].includes(value) : typeof value !== 'boolean') throw fixtureError('preview_invalid_control');
            }
            for (const key of ['token9', 'token10', 'catalog', 'account', 'readonly']) if (Object.hasOwn(input, key)) mode[key] = input[key];
            if (input.key === 'missing') fs.unlinkSync(paths.keyPath);
            if (input.key === 'unselected') durable.writeJsonSync(paths.selectionPath, { reset: true, resetAt: '2026-11-20T00:00:00.000Z' });
            if (input.sync === 'invalid-target') {
                if (syncBackup) throw fixtureError('preview_sync_fault_already_set', 409);
                syncBackup = fs.readFileSync(targets[1].path); writeText(path.join(run, 'sync-target-backup.bin'), syncBackup);
                writeText(targets[1].path, '[ invalid fixture target');
            }
            if (input.sync === 'restore-target') {
                if (!syncBackup) throw fixtureError('preview_sync_fault_not_set', 409);
                writeText(targets[1].path, syncBackup); syncBackup = null;
            }
            if (input.manifest === 'corrupt') {
                if (manifestBackup) throw fixtureError('preview_manifest_fault_already_set', 409);
                manifestBackup = fs.readFileSync(paths.manifestPath); writeText(path.join(run, 'manifest-backup.bin'), manifestBackup);
                writeText(paths.manifestPath, '[ invalid fixture manifest');
            }
            if (input.manifest === 'restore') {
                if (!manifestBackup) throw fixtureError('preview_manifest_fault_not_set', 409);
                writeText(paths.manifestPath, manifestBackup); manifestBackup = null;
            }
            if (Object.hasOwn(input, 'failNextManifestWrite')) pendingManifestFailure = input.failNextManifestWrite;
            return { ok: true, fixtureOnly: true, fixture: clone(mode), pid: process.pid, runId };
        }
        let origin = '';
        const session = { id: 'a6-preview-ar', name: 'Демонстрационный sentinel', active: true, status: 'live', balance: 25, grant: 25 };
        function fixtureGet(pathname, url) {
            const keepalive = { hedgeMs: 20000, maxHedges: 0, maxAttempts: 3, preCommitMs: 10000, poolFallbackModel: '' };
            const arMap = { default: 'gpt-5.6-sol', opus: 'gpt-5.6-sol', sonnet: 'gpt-5.6-sol', haiku: 'gpt-5.6-sol', gpt: '' };
            const arModels = ['gpt-5.6-sol', 'gpt-6.1-sol'].map(id => ({ id, supported_endpoint_types: ['openai'] }));
            const fixed = new Map([
                ['/__switch/api/status', { current: 'agentrouter', presets: {}, backends: { agentrouter: { label: 'AgentRouter', base_url: origin }, a6api: { label: 'a6api', base_url: origin } }, oauth: { loggedIn: false } }],
                ['/__switch/api/ar/sessions', { ok: true, sessions: [session] }],
                ['/__switch/api/ar/models', { ok: true, models: arModels }],
                ['/__switch/api/ar/active-model', { ok: true, model: 'gpt-5.6-sol' }],
                ['/__switch/api/ar/modelmap', { ok: true, modelMap: arMap }],
                ['/__switch/api/ar/keepalive/state', { ok: true, cfg: keepalive, defaults: keepalive, stats: {}, latency: {}, port: 0 }],
                ['/__switch/api/ar/logs', { ok: true, entries: [] }],
                ['/__switch/api/ar/autoreg/status', { ok: true, runs: [], running: false }],
                ['/__switch/api/ar/schedule', { ok: true, entries: [], running: false }],
                ['/__switch/api/ar/checkin/status', { ok: true, entries: [], running: false }],
                ['/__switch/api/ar/pool/shared', { ok: true, shared: [] }],
                ['/__switch/api/go/sessions', { ok: true, sessions: [] }],
                ['/__switch/api/go/models', { ok: true, models: [] }],
                ['/__switch/api/go/active-model', { ok: true, model: 'fixture-gorouter-model' }],
                ['/__switch/api/go/modelmap', { ok: true, modelMap: {} }],
                ['/__switch/api/go/keepalive/state', { ok: true, cfg: keepalive, defaults: keepalive, stats: {}, latency: {}, port: 0 }],
            ]);
            // These finite GET-only placeholders were observed in the real boot
            // trace. They do NOT claim healthy inference or emulate any mutation.
            const dormantPrefixes = ['ar', 'go', 'jw', 'sk', 'ts', 'kk', 'uc', 'xc', 'fg', 'ax', 'kv', 'tr', 'pm', 'vn', 'dc', 'cp', 'ab', 'fx', 'ls', 'bd', 'nv', 'od', 'bai', 'uk', 'ap', 'hn', 'ak', 'rm', 'tb', 'xp'];
            for (const prefix of dormantPrefixes) {
                fixed.set('/__switch/api/' + prefix + '/auto/status', { ok: true, enabled: false, running: false, reason: 'preview-fixture-only' });
                if (!['ar', 'go'].includes(prefix)) fixed.set('/__switch/api/' + prefix + '/sessions', { ok: true, sessions: [] });
            }
            for (const prefix of ['ls', 'dc', 'od', 'uc']) fixed.set('/__switch/api/' + prefix + '/autoreg/status', { ok: true, running: false, runs: [], entries: [] });
            fixed.set('/__switch/api/gh/spend', { ok: true, rub: 0 });
            fixed.set('/__switch/api/health', { services: [], wired: {}, fixture: true });
            fixed.set('/__switch/api/settings/ref-codes', { ok: true, providers: [], shapes: {}, urls: {}, defaults: {}, user: {}, effective: {}, fixture: true });
            fixed.set('/__switch/api/grok/health', { ok: true, ready: false, fixture: true });
            fixed.set('/__switch/api/grok/sessions', { ok: true, sessions: [] });
            if (fixed.has(pathname)) return fixed.get(pathname);
            if (pathname === '/__switch/api/routes') {
                const registry = parseFile(paths.backendsPath);
                return { ok: true, updatedAt: 0, tiers: ['default', 'opus', 'sonnet', 'haiku', 'gpt'], multi: {}, multiTiers: ['default', 'opus', 'sonnet', 'haiku'],
                    providers: Object.entries(registry.providers).map(([name, row]) => ({ name, label: row.label, upstream: row.upstream, local: true,
                        aliases: Object.entries(registry.aliases).filter(([, target]) => target === name).map(([alias]) => alias).sort(),
                        tiers: name === 'a6api' ? parseFile(paths.routesMapPath) : name === 'agentrouter' ? arMap : null,
                        gatewayTiers: name === 'a6api' ? parseFile(paths.modelMapPath) : name === 'agentrouter' ? arMap : null,
                        activeModel: name === 'a6api' ? parseFile(paths.modelMapPath).default : name === 'agentrouter' ? 'gpt-5.6-sol' : null,
                        pooldrop: null })) };
            }
            if (pathname === '/__switch/api/routes/models') {
                const provider = url.searchParams.get('provider');
                if (provider === 'a6api') return { ok: true, models: catalog().filter(model => BASE_MODELS.includes(model) || mode.catalog === 'long' && longModels.includes(model)), source: 'pricing', note: 'Explicit a6api preview catalog fixture' };
                if (provider === 'agentrouter') return { ok: true, models: arModels.map(row => row.id), source: 'configured', note: 'Explicit AgentRouter preview fixture' };
                if (provider === 'gorouter') return { ok: true, models: [], source: 'configured', note: 'Explicit empty GoRouter preview fixture' };
            }
            return undefined; // NO blanket /__switch/ success, including writes.
        }
        server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://127.0.0.1'), pathname = url.pathname;
            const row = { method: req.method, pathname, tokenId: url.searchParams.has('tokenId') ? Number(url.searchParams.get('tokenId')) : undefined };
            requests.push(row); res.once('finish', () => { row.status = res.statusCode; });
            if (req.method === 'POST' && ['/__switch/api/api-gateway/publication', '/__switch/api/api-gateway/model', '/__switch/api/a6api/key', '/__switch/api/a6api/modelmap'].includes(pathname)) {
                const chunks = []; let size = 0;
                req.on('data', chunk => { size += chunk.length; if (size <= 65536) chunks.push(chunk); });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(Buffer.concat(chunks).toString());
                        row.body = Object.fromEntries(['expectedRevision', 'id', 'published', 'tokenId', 'modelMap'].filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]));
                    } catch { row.invalidBody = true; }
                });
            }
            // Readonly models an untrusted Host; unchanged real canWrite guards
            // produce both read-only DTOs and actual HTTP403, not a fake endpoint.
            if (mode.readonly && pathname.startsWith('/__switch/')) req.headers.host = 'readonly.preview.invalid';
            if (a6Routes.handle(req, res)) return;
            if (product.routes.handle(req, res)) return;
            if (pathname.startsWith(PREFIX + '/')) {
                const endpoint = pathname.slice(PREFIX.length + 1);
                if (req.method === 'GET' && endpoint === 'ready') return json(res, 200, { ok: !closing, scope: SCOPE, pid: process.pid, runId,
                    guardWired: !!validator, fixtureOnly: true, remainingMs: Math.max(0, receipt?.expiresAtMs - Date.now()) });
                if (req.method === 'GET' && endpoint === 'state') return json(res, 200, getState());
                if (req.method !== 'POST' || !['control', 'shutdown'].includes(endpoint)) return json(res, 405, { ok: false, code: 'preview_method_not_allowed' });
                if (!a6CanWrite(req) || !/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) return json(res, 403, { ok: false, code: 'preview_local_json_only' });
                bodyObject(req).then(input => {
                    if (endpoint === 'control') return json(res, 200, control(input));
                    if (input.pid !== process.pid || input.runId !== runId || Object.keys(input).sort().join(',') !== 'pid,runId') throw fixtureError('preview_owner_mismatch', 403);
                    json(res, 200, { ok: true, pid: process.pid, runId, closing: true });
                    setImmediate(() => shutdown('owned-http-shutdown'));
                }).catch(error => json(res, error.status || 500, { ok: false, code: error.code || 'preview_error' }));
                return;
            }
            if (req.method === 'GET' && pathname === '/openai/v1/models') {
                try { return json(res, 200, { object: 'list', data: manifestApi.toOpenAiModels(manifestApi.readPublishedManifest(paths)) }); }
                catch (error) { return json(res, 503, { ok: false, code: error.code || 'preview_manifest_invalid' }); }
            }
            if (req.method === 'GET') {
                const data = fixtureGet(pathname, url); if (data !== undefined) return json(res, 200, data);
                if (pathname === '/') {
                    const banner = '<div id="a6api-preview-banner" style="position:fixed;top:0;left:0;right:0;z-index:10000;padding:3px 12px;background:#153724;color:#bbf7d0;font:11px system-ui;pointer-events:none">Изолированный a6api preview · кабинет и каталог демонстрационные · рабочие настройки не меняются</div>';
                    const html = fs.readFileSync(path.join(ROUTING, 'proxy-dashboard.html'), 'utf8').replace(/(<body\b[^>]*>)/i, '$1' + banner);
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
                        'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'" });
                    return res.end(html);
                }
                if (pathname.startsWith('/vendor/')) {
                    const name = pathname.slice('/vendor/'.length), types = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
                    const fontName = name.startsWith('fonts/') ? name.slice('fonts/'.length) : null;
                    const safe = /^[A-Za-z0-9_.-]+$/.test(fontName || name) && !name.includes('..')
                        && (fontName ? fontName === path.basename(fontName) && path.extname(fontName) === '.woff2' : name === path.basename(name));
                    const type = types[path.extname(fontName || name)];
                    if (safe && type) {
                        const file = path.join(ROUTING, 'vendor', name);
                        if (fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(file)); }
                    }
                }
            }
            json(res, 404, { ok: false, code: 'preview_fixture_path_unimplemented' });
        });
        async function shutdown(reason = 'shutdown') {
            if (closing) return;
            closing = true; clearTimeout(lifetime);
            try { write(path.join(run, 'final.json'), { ...getState(), closing: true, reason }); }
            finally {
                server.closeAllConnections();
                await new Promise(resolve => server.close(resolve));
                resetEnvironment();
            }
        }
        const port = options.port === undefined ? Number(process.env.A6API_MODELS_PREVIEW_PORT || 0) : Number(options.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw fixtureError('preview_invalid_port');
        const lifetimeMs = Number(options.lifetimeMs ?? process.env.A6API_MODELS_PREVIEW_LIFETIME_MS ?? 600000);
        if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 1800000) throw fixtureError('preview_invalid_lifetime');
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
        origin = 'http://127.0.0.1:' + server.address().port;
        receipt = { url: origin, readyUrl: origin + PREFIX + '/ready', stateUrl: origin + PREFIX + '/state',
            pid: process.pid, runId, scope: SCOPE, run, paths, targets, guardWired: !!validator,
            lifetimeMs, expiresAtMs: Date.now() + lifetimeMs, receiptPath: path.join(run, 'preview.json'),
            initialPath: path.join(run, 'initial.json'), finalPath: path.join(run, 'final.json'),
            fixtureOnly: 'billing/catalog and boot placeholders; actual native/publication HTTP + durable disk writers',
            providerInference: false, productionServicesTouched: false };
        write(receipt.initialPath, getState()); write(receipt.receiptPath, receipt);
        lifetime = setTimeout(() => shutdown('bounded-lifetime').catch(error => { console.error(error.code || 'preview_shutdown_error'); process.exitCode = 1; }), lifetimeMs);
        return { server, run, paths, targets, receipt, gateway: a6, product, getState, control, shutdown };
    } catch (error) {
        clearTimeout(lifetime);
        if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        write(path.join(run, 'boot-failure.json'), { pid: process.pid, runId, code: error.code || 'preview_boot_error', guards,
            stack: String(error.stack || '').split(/\r?\n/).slice(1, 9), guardViolationCount: guards.length });
        if (guards.length) console.error('PREVIEW_GUARD ' + guards.join('; '));
        resetEnvironment(); throw error;
    }
}
async function main() {
    const args = process.argv.slice(2), options = {};
    if (args.includes('--help')) {
        console.log('node tools/a6api-models-preview.js --port 0 --lifetime-ms 600000\nA6API_MODELS_PREVIEW JSON contains the owned PID, URL, run and health/state paths.\nOnly disposable fixtures; no production start, real keys or provider inference.'); return;
    }
    for (let index = 0; index < args.length; index += 2) {
        if (!['--port', '--lifetime-ms'].includes(args[index]) || args[index + 1] === undefined) throw fixtureError('preview_invalid_arguments');
        options[args[index] === '--port' ? 'port' : 'lifetimeMs'] = Number(args[index + 1]);
    }
    const preview = await createPreview(options);
    console.log('A6API_MODELS_PREVIEW ' + JSON.stringify(preview.receipt));
    const stop = reason => preview.shutdown(reason).catch(error => { console.error(error.code || 'preview_shutdown_error'); process.exitCode = 1; });
    process.once('SIGTERM', () => stop('SIGTERM')); process.once('SIGINT', () => stop('SIGINT'));
}
module.exports = { createPreview, SCOPE, PREFIX, MAIN_ID, OTHER_ID, BASE_MODELS };
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
