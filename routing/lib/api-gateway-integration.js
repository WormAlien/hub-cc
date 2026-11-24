'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const dashboardModule = require('./api-gateway-dashboard.js');
const manifestDefault = require('./api-gateway.js');
const routesCatalogDefault = require('./routes-catalog.js');
const openCodeDefault = require('./api-gateway-opencode.js');
const hermesDefault = require('./api-gateway-hermes.js');
const bifrostDefault = require('./bifrost-sidecar.js');

const PREFIX = '/__switch/api/api-gateway';
const BODY_LIMIT = 64 * 1024;
const START_COMMAND = 'hermes dashboard --no-open';
const WINDOWS_INSTALL_COMMAND = 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)';
const POSIX_INSTALL_COMMAND = 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash';
// Literal messages only: never forward dependency/provider prose even with a known code.
const PUBLICATION_ERRORS = Object.freeze({
    a6api_key_not_selected: { status: 409, message: 'Сначала выберите и подготовьте ключ a6api кнопкой «Использовать ключ».' },
    a6api_token_expired: { status: 409, message: 'Срок выбранного ключа a6api истёк. Измените срок в кабинете или используйте другой ключ.' },
    a6api_token_disabled: { status: 409, message: 'Выбранный ключ a6api выключен или недоступен. Используйте рабочий ключ.' },
    a6api_token_quota: { status: 409, message: 'Лимит выбранного ключа a6api исчерпан. Измените лимит в кабинете или используйте другой ключ.' },
    a6api_catalog_unavailable: { status: 503, message: 'Не удалось проверить разрешённый каталог a6api. Публикации сохранены; повторите позже.' },
    a6api_token_missing: { status: 409, message: 'Выбранный ключ a6api больше не найден в кабинете. Используйте другой ключ.' },
    a6api_model_unavailable: { status: 409, message: 'Эта exact модель не разрешена выбранному ключу a6api или отсутствует в текстовом каталоге.' },
});

// Какие провайдеры смотреть: только те, чья вкладка видна в сайдбаре. Пустой список — фильтра нет
// (так ходят пробы и старые клиенты); мусорные имена отсеиваются, иначе один кривой параметр
// выключил бы каталог целиком.
function visibleProvidersFromUrl(rawUrl) {
    let values;
    try { values = new URL(rawUrl, 'http://127.0.0.1').searchParams.getAll('provider'); }
    catch { return null; }
    if (!values.length) return null;
    const names = values
        .flatMap(value => String(value).split(','))
        .map(value => value.trim())
        .filter(value => /^[A-Za-z0-9_.-]{1,64}$/.test(value));
    return names.length ? [...new Set(names)] : null;
}

function platformPath(platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}

// Путь к вики владельца. На его машине папка есть; на чужой её быть не должно,
// поэтому отсутствие корня означает «вики-цели нет», а НЕ «создать по этому пути»
// (25.11: Sync создавал D:\WORMALIENAIGIGANT на машине друга).
function defaultWikiRoot({ platform = process.platform, repoRoot = path.resolve(__dirname, '..', '..') } = {}) {
    const paths = platformPath(platform);
    const candidate = platform === 'win32'
        ? 'D:\\WORMALIENAIGIGANT'
        : paths.resolve(repoRoot, '..', '..', 'WORMALIENAIGIGANT');
    try { return fs.existsSync(candidate) ? candidate : undefined; } catch { return undefined; }
}

function defaultOpenCodeTargets({
    platform = process.platform,
    home = os.homedir(),
    xdgConfigHome = process.env.XDG_CONFIG_HOME || '',
    repoRoot = path.resolve(__dirname, '..', '..'),
    wikiRoot,
} = {}) {
    const paths = platformPath(platform);
    const configRoot = xdgConfigHome || paths.join(home, '.config');
    const targets = [
        { label: 'User config', path: paths.join(configRoot, 'opencode', 'opencode.json') },
    ];
    // Wiki config - только когда корень задан явно (или нашёлся у владельца). Иначе
    // на чистой машине синк заводил рабочую папку владельца из воздуха.
    if (wikiRoot) targets.push({ label: 'Wiki config', path: paths.join(wikiRoot, 'opencode.json') });
    targets.push({ label: 'Hub config', path: paths.join(repoRoot, 'opencode.json') });
    return targets;
}

function defaultHermesInstallationProbes({
    platform = process.platform,
    home = os.homedir(),
    localAppData = process.env.LOCALAPPDATA || '',
    pathEnv = process.env.PATH || '',
} = {}) {
    const paths = platformPath(platform);
    const pathProbes = String(pathEnv).split(paths.delimiter)
        .filter(directory => directory && paths.isAbsolute(directory))
        .flatMap(directory => platform === 'win32'
            ? [paths.join(directory, 'hermes.exe'), paths.join(directory, 'hermes.cmd')]
            : [paths.join(directory, 'hermes')]);
    if (platform === 'win32') {
        const root = localAppData || paths.join(home, 'AppData', 'Local');
        return {
            probes: [...new Set([
                ...pathProbes,
                paths.join(root, 'hermes', 'hermes-agent', '.hermes', 'bin', 'hermes.exe'),
                paths.join(root, 'hermes', 'hermes-agent', '.hermes', 'bin', 'hermes.cmd'),
                paths.join(root, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
                paths.join(root, 'hermes', 'bin', 'hermes.cmd'),
            ])],
            installCommand: WINDOWS_INSTALL_COMMAND,
            startCommand: START_COMMAND,
        };
    }
    return {
        probes: [...new Set([
            ...pathProbes,
            paths.join(home, '.local', 'bin', 'hermes'),
            paths.join(home, '.hermes', 'hermes-agent', '.hermes', 'bin', 'hermes'),
            paths.join(home, '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'),
            paths.join(home, '.hermes', 'bin', 'hermes'),
        ])],
        installCommand: POSIX_INSTALL_COMMAND,
        startCommand: START_COMMAND,
    };
}

function isLoopback(address) {
    if (typeof address !== 'string') return false;
    if (address === '::1') return true;
    const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (net.isIP(normalized) !== 4) return false;
    const first = Number(normalized.split('.')[0]);
    return first === 127;
}

function canWrite(req) {
    if (!isLoopback(req && req.socket && req.socket.remoteAddress)) return false;
    const headers = (req && req.headers) || {};
    if (typeof headers.host !== 'string'
        || !/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/i.test(headers.host)) {
        return false;
    }
    let host;
    try { host = new URL(`${req.socket.encrypted ? 'https:' : 'http:'}//${headers.host}`); }
    catch { return false; }
    const site = headers['sec-fetch-site'];
    if (site !== undefined && String(site).toLowerCase() !== 'same-origin') return false;
    if (headers.origin !== undefined) {
        if (typeof headers.origin !== 'string') return false;
        try {
            const origin = new URL(headers.origin);
            if (origin.origin !== host.origin || headers.origin !== origin.origin) return false;
        } catch { return false; }
    }
    return true;
}

function json(res, status, value) {
    if (res.writableEnded) return;
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
}

function readJsonObject(req) {
    return new Promise((resolve, reject) => {
        const headers = req.headers || {};
        const declared = Number(headers['content-length']);
        if (Number.isFinite(declared) && declared > BODY_LIMIT) {
            const error = Object.assign(new Error('body_too_large'), { status: 413, code: 'body_too_large' });
            try { req.unpipe?.(); req.pause?.(); } catch { /* response remains writable */ }
            reject(error);
            return;
        }
        const chunks = [];
        let size = 0;
        let done = false;
        const fail = error => {
            if (done) return;
            done = true;
            reject(error);
        };
        req.on('data', chunk => {
            if (done) return;
            size += chunk.length;
            if (size > BODY_LIMIT) {
                chunks.length = 0;
                try { req.unpipe?.(); req.pause?.(); } catch { /* response remains writable */ }
                fail(Object.assign(new Error('body_too_large'), { status: 413, code: 'body_too_large' }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (done) return;
            done = true;
            let value;
            try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
            catch {
                reject(Object.assign(new Error('invalid_json'), { status: 400, code: 'invalid_json' }));
                return;
            }
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                reject(Object.assign(new Error('invalid_json'), { status: 400, code: 'invalid_json' }));
                return;
            }
            resolve(value);
        });
        req.on('error', () => fail(Object.assign(new Error('request_closed'), { status: 400, code: 'request_closed' })));
    });
}

function publicError(error) {
    const publication = Object.hasOwn(PUBLICATION_ERRORS, error && error.code) ? PUBLICATION_ERRORS[error.code] : null;
    if (publication) return {
        status: publication.status,
        body: { ok: false, code: error.code, error: publication.message },
    };
    const status = Number.isInteger(error && error.status)
        ? error.status
        : Number.isInteger(error && error.httpStatus) ? error.httpStatus : 500;
    const safeStatus = status >= 400 && status <= 599 ? status : 500;
    const code = typeof (error && error.code) === 'string' && /^[a-z0-9_]+$/.test(error.code)
        ? error.code
        : 'api_gateway_error';
    return {
        status: safeStatus,
        body: { ok: false, code, error: 'API Gateway request failed.' },
    };
}

function createApiGatewayRoutes({ service, canWrite: writeGuard = canWrite } = {}) {
    if (!service || typeof service !== 'object') throw new TypeError('API Gateway service is required.');
    const gets = new Map([
        [PREFIX, 'state'],
        [`${PREFIX}/candidates`, 'candidates'],
        [`${PREFIX}/sidecar`, 'sidecarStatus'],
        [`${PREFIX}/clients`, 'clientsStatus'],
        [`${PREFIX}/opencode/preview`, 'openCodePreview'],
    ]);
    const posts = new Map([
        [`${PREFIX}/model`, 'updateModel'],
        [`${PREFIX}/publication`, 'setPublication'],
        [`${PREFIX}/opencode/sync`, 'openCodeSync'],
        [`${PREFIX}/hermes/sync`, 'hermesSync'],
    ]);

    async function dispatch(req, res, pathname) {
        try {
            if (req.method === 'GET') {
                const method = gets.get(pathname);
                if (!method || typeof service[method] !== 'function') return json(res, 404, { ok: false, code: 'not_found', error: 'API Gateway route not found.' });
                // Кандидаты собираются только по выбранным видимым провайдерам. Начальный state
                // не запускает discovery и поэтому не получает параметры provider.
                const value = pathname === `${PREFIX}/candidates`
                    ? await service[method]({ providers: visibleProvidersFromUrl(req.url) })
                    : await service[method]();
                if (pathname === PREFIX && value && typeof value === 'object' && !Array.isArray(value)) {
                    return json(res, 200, { ...value, canWrite: !!writeGuard(req) });
                }
                return json(res, 200, value);
            }
            if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed.' });
            const method = posts.get(pathname);
            if (!method || typeof service[method] !== 'function') return json(res, 404, { ok: false, code: 'not_found', error: 'API Gateway route not found.' });
            if (!writeGuard(req)) return json(res, 403, { ok: false, code: 'local_only', error: 'Mutation is available only from this dashboard.' });
            if (!/^application\/json(?:;|$)/i.test(String((req.headers || {})['content-type'] || ''))) {
                return json(res, 415, { ok: false, code: 'json_required', error: 'Content-Type application/json is required.' });
            }
            const body = await readJsonObject(req);
            const value = method === 'updateModel' || method === 'setPublication'
                ? await service[method](body)
                : await service[method]();
            return json(res, 200, value);
        } catch (error) {
            const safe = publicError(error);
            return json(res, safe.status, safe.body);
        }
    }

    function handle(req, res) {
        let pathname;
        try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; }
        catch { return false; }
        if (!gets.has(pathname) && !posts.has(pathname)) return false;
        dispatch(req, res, pathname);
        return true;
    }

    return Object.freeze({ handle });
}

async function resolveRouteCandidates(options) {
    return routesCatalogDefault.resolveModelCandidates(options);
}

function sortedPublishedModel(manifest) {
    if (!manifest || manifest.enabled !== true || !manifest.models || typeof manifest.models !== 'object') return null;
    return Object.keys(manifest.models).sort().at(0) || null;
}

function createProductionApiGateway(options = {}) {
    const repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..');
    const routingRoot = path.join(repoRoot, 'routing');
    const home = options.home || os.homedir();
    // Явный корень (env/опция) уважаем всегда; путь по умолчанию - только если папка
    // реально существует. Иначе Wiki-цель просто не создаётся.
    const wikiRoot = options.wikiRoot || process.env.API_GATEWAY_WIKI_ROOT || defaultWikiRoot({ repoRoot });
    const manifestApi = options.manifestApi || manifestDefault;
    const resolveModelCandidates = options.resolveModelCandidates || routesCatalogDefault.resolveModelCandidates;
    const openCodeFactory = options.openCodeFactory || openCodeDefault.createOpenCodeService;
    const hermesFactory = options.hermesFactory || hermesDefault.createHermesService;
    const dashboardFactory = options.dashboardFactory || dashboardModule.createApiGatewayDashboardService;
    const paths = {
        defaultManifestPath: path.join(routingRoot, 'api-gateway.default.json'),
        manifestPath: path.join(routingRoot, 'api-gateway.json'),
        backendsPath: path.join(home, '.claude', 'backends.json'),
        settingsPath: path.join(home, '.claude', 'settings.json'),
        ...(options.paths || {}),
    };
    const targets = options.opencodeTargets || defaultOpenCodeTargets({
        platform: options.platform,
        home,
        xdgConfigHome: options.xdgConfigHome,
        wikiRoot,
        repoRoot,
    });
    const journalPath = options.opencodeJournalPath || path.join(routingRoot, 'runtime', 'api-gateway-opencode.txn');
    const openCodeService = openCodeFactory({ targets, journalPath, durableImpl: options.durableImpl });
    let openCodeRecovery;
    try { openCodeRecovery = openCodeService.recover(); }
    catch (error) { openCodeRecovery = { recovered: 'error', code: error && error.code || 'api_gateway_opencode_recovery_conflict' }; }

    const manifestReader = () => manifestApi.readPublishedManifest(paths);
    const hermesDefaults = defaultHermesInstallationProbes({
        platform: options.platform,
        home,
        localAppData: options.localAppData,
        pathEnv: options.pathEnv,
    });
    const rawHermesService = hermesFactory({
        installationProbes: hermesDefaults.probes,
        platform: options.platform || process.platform,
        installCommand: hermesDefaults.installCommand,
        startCommand: hermesDefaults.startCommand,
        getModel: async () => sortedPublishedModel(await manifestReader()),
        ...(options.hermesOptions || {}),
    });
    const platformHermesDto = value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const result = { ...value };
        if (result.status === 'absent' || result.installCommand !== undefined) {
            result.installCommand = hermesDefaults.installCommand;
        }
        if (result.startCommand !== undefined || result.status === 'absent' || result.status === 'down') {
            result.startCommand = hermesDefaults.startCommand;
        }
        return result;
    };
    const hermesService = Object.freeze({
        ...(typeof rawHermesService.detect === 'function'
            ? { detect: () => platformHermesDto(rawHermesService.detect()) }
            : {}),
        status: async () => platformHermesDto(await rawHermesService.status()),
        sync: async () => platformHermesDto(await rawHermesService.sync()),
    });
    const sidecarStatus = options.sidecarStatus || (async () => {
        try {
            const expected = bifrostDefault.expectedExecutable({ platform: options.platform, arch: options.arch });
            const checked = bifrostDefault.verifyFile(expected.executable, expected.artifact.sha256);
            return {
                ...bifrostDefault.redactedStatus({ installed: fs.existsSync(expected.executable), verified: checked.ok }),
                status: checked.ok ? 'ready' : (fs.existsSync(expected.executable) ? 'corrupt' : 'absent'),
                checksum: expected.artifact.sha256,
                installState: fs.existsSync(expected.executable) ? 'installed' : 'not installed',
                health: checked.ok ? 'healthy' : 'unknown',
            };
        } catch {
            return { status: 'unavailable', installed: false, verified: false };
        }
    });
    const dashboardService = dashboardFactory({
        readPublishedManifest: manifestApi.readPublishedManifest,
        readCanonicalProviders: manifestApi.readCanonicalProviders,
        saveManifestAndPicker: manifestApi.saveManifestAndPicker,
        validatePublication: options.validatePublication,
        resolveModelCandidates,
        readPassive: options.readPassive || (async () => ({})),
        readProbes: options.readProbes || (async () => ({})),
        getSidecarStatus: sidecarStatus,
        openCodeService,
        hermesService,
        paths,
        candidateOptions: options.candidateOptions || { providers: [] },
        publicUrls: options.publicUrls || {
            anthropicBaseUrl: 'http://127.0.0.1:20100',
            openaiBaseUrl: 'http://127.0.0.1:20100/openai/v1',
        },
    });
    const service = dashboardService;
    const routes = createApiGatewayRoutes({ service, canWrite: options.canWrite });
    const resolveSharedCandidates = providers => resolveModelCandidates({
        ...(options.candidateOptions || { providers: [] }),
        ...(providers === undefined ? {} : { providers }),
    });
    return Object.freeze({
        service,
        routes,
        resolveRouteCandidates: resolveSharedCandidates,
        openCodeRecovery,
        openCodeService,
        hermesService,
        targets,
        paths,
    });
}

module.exports = {
    createApiGatewayRoutes,
    createProductionApiGateway,
    defaultHermesInstallationProbes,
    defaultOpenCodeTargets,
    resolveRouteCandidates,
};
