'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { writeAtomic } = require('./durable-write');

const ROUTING = path.resolve(__dirname, '..');
const DEFAULT_LOCK_PATH = path.join(ROUTING, 'bifrost-lock.json');
const DEFAULT_CONFIG_PATH = path.join(ROUTING, 'bifrost-config.json');
const DEFAULT_PRICING_PATH = path.join(ROUTING, 'bifrost-pricing.json');
const DEFAULT_MODEL_PARAMETERS_PATH = path.join(ROUTING, 'bifrost-model-parameters.json');
const DEFAULT_CACHE_ROOT = path.join(ROUTING, 'bifrost-cache');
const DEFAULT_RUNTIME_ROOT = path.join(ROUTING, 'runtime', 'bifrost');
const DEFAULT_BASE_URL = 'http://127.0.0.1:20100';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 20135;
const INTERNAL_HOP_HEADER = 'x-abuse-hub-internal';
const INTERNAL_HOP_MARKER = 'abuse-hub-bifrost-v1';
const PROVIDER = 'abuse-hub';

const PLATFORM_DIRS = Object.freeze({
    'win32-x64': 'windows-amd64',
    'linux-x64': 'linux-amd64',
    'linux-arm64': 'linux-arm64',
    'darwin-x64': 'darwin-amd64',
    'darwin-arm64': 'darwin-arm64',
});

class BifrostSidecarError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BifrostSidecarError';
        this.code = code;
    }
}

function readJson(file, label) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) {
        throw new BifrostSidecarError('bifrost_file_missing', `${label} is unavailable: ${error.code || 'read error'}`);
    }
    try {
        const value = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('expected object');
        return value;
    } catch (error) {
        throw new BifrostSidecarError('bifrost_json_invalid', `${label} is invalid JSON`);
    }
}

function readLock(lockPath = DEFAULT_LOCK_PATH) {
    const lock = readJson(lockPath, 'Bifrost lock');
    if (lock.schemaVersion !== 1 || lock.repo !== 'maximhq/bifrost'
        || typeof lock.version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(lock.version)
        || /latest/i.test(lock.version) || !lock.artifacts || Array.isArray(lock.artifacts)) {
        throw new BifrostSidecarError('bifrost_lock_invalid', 'Bifrost lock metadata is invalid');
    }
    for (const [key, artifact] of Object.entries(lock.artifacts)) {
        if (!Object.hasOwn(PLATFORM_DIRS, key) || !artifact || typeof artifact !== 'object'
            || typeof artifact.url !== 'string' || typeof artifact.filename !== 'string'
            || !/^[a-f0-9]{64}$/.test(String(artifact.sha256 || ''))) {
            throw new BifrostSidecarError('bifrost_lock_invalid', `Bifrost lock artifact ${key} is invalid`);
        }
        let url;
        try { url = new URL(artifact.url); } catch { url = null; }
        if (!url || url.protocol !== 'https:' || url.hostname !== 'downloads.getmaxim.ai'
            || /latest/i.test(url.pathname) || !url.pathname.includes(`/${lock.version}/`)
            || path.posix.basename(url.pathname) !== artifact.filename) {
            throw new BifrostSidecarError('bifrost_lock_invalid', `Bifrost lock URL ${key} is invalid`);
        }
    }
    return lock;
}

function selectArtifact(lock, platform = process.platform, arch = process.arch) {
    const key = `${platform}-${arch}`;
    const artifact = lock && lock.artifacts && lock.artifacts[key];
    if (!artifact || !PLATFORM_DIRS[key]) {
        throw new BifrostSidecarError(
            'bifrost_platform_unsupported',
            `Unsupported Bifrost platform: ${platform}/${arch}`,
        );
    }
    return { ...artifact, key, cacheDir: PLATFORM_DIRS[key] };
}

function hashFile(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        for (;;) {
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!bytes) break;
            hash.update(buffer.subarray(0, bytes));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function verifyFile(file, expectedSha256) {
    const expected = String(expectedSha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) {
        throw new BifrostSidecarError('bifrost_checksum_invalid', 'Pinned Bifrost checksum is invalid');
    }
    try {
        const actual = hashFile(file);
        return { ok: crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')), actual, expected };
    } catch (error) {
        if (error && error.code === 'ENOENT') return { ok: false, actual: null, expected };
        throw error;
    }
}

function cacheLocation(lock, artifact, cacheRoot = DEFAULT_CACHE_ROOT) {
    return path.join(cacheRoot, lock.version, artifact.cacheDir, artifact.filename);
}

function safeUnlink(file, unlink = fs.unlinkSync) {
    try { unlink(file); }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
}

function downloadToFile(url, target, { timeoutMs = 120000, redirects = 3 } = {}) {
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || parsed.hostname !== 'downloads.getmaxim.ai') {
        return Promise.reject(new BifrostSidecarError('bifrost_download_url_invalid', 'Bifrost download URL is not approved'));
    }
    return new Promise((resolve, reject) => {
        const request = https.get(parsed, { timeout: timeoutMs, headers: { 'user-agent': 'ABUSE-HUB-Bifrost-Installer/1' } }, response => {
            const status = Number(response.statusCode || 0);
            if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
                response.resume();
                let next;
                try { next = new URL(response.headers.location, parsed); } catch { next = null; }
                if (!next || next.protocol !== 'https:' || next.hostname !== 'downloads.getmaxim.ai') {
                    reject(new BifrostSidecarError('bifrost_download_redirect_invalid', 'Bifrost download redirected outside the approved host'));
                    return;
                }
                downloadToFile(next.toString(), target, { timeoutMs, redirects: redirects - 1 }).then(resolve, reject);
                return;
            }
            if (status !== 200) {
                response.resume();
                reject(new BifrostSidecarError('bifrost_download_failed', `Bifrost download returned HTTP ${status}`));
                return;
            }
            const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o755 });
            pipeline(response, out).then(resolve, error => {
                try { safeUnlink(target); } catch { /* preserve the network/write error */ }
                reject(error);
            });
        });
        request.on('timeout', () => request.destroy(new BifrostSidecarError('bifrost_download_timeout', 'Bifrost download timed out')));
        request.on('error', reject);
    });
}

async function ensureInstalled({
    lockPath = DEFAULT_LOCK_PATH,
    cacheRoot = DEFAULT_CACHE_ROOT,
    platform = process.platform,
    arch = process.arch,
    download = downloadToFile,
    rename = fs.renameSync,
    unlink = fs.unlinkSync,
} = {}) {
    const lock = readLock(lockPath);
    const artifact = selectArtifact(lock, platform, arch);
    const executable = cacheLocation(lock, artifact, cacheRoot);
    const cached = verifyFile(executable, artifact.sha256);
    if (cached.ok) {
        if (platform !== 'win32') fs.chmodSync(executable, 0o755);
        return { executable, artifact, lock, installed: true, cached: true, verified: true };
    }

    fs.mkdirSync(path.dirname(executable), { recursive: true });
    const temp = path.join(
        path.dirname(executable),
        `.${artifact.filename}.download-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
    );
    try {
        await download(artifact.url, temp);
        const downloaded = verifyFile(temp, artifact.sha256);
        if (!downloaded.ok) {
            throw new BifrostSidecarError('bifrost_checksum_mismatch', 'Downloaded Bifrost artifact failed checksum verification');
        }
        rename(temp, executable);
        if (platform !== 'win32') fs.chmodSync(executable, 0o755);
        const installed = verifyFile(executable, artifact.sha256);
        if (!installed.ok) {
            safeUnlink(executable, unlink);
            throw new BifrostSidecarError('bifrost_checksum_mismatch', 'Installed Bifrost artifact failed checksum verification');
        }
        return { executable, artifact, lock, installed: true, cached: false, verified: true };
    } catch (error) {
        try { safeUnlink(temp, unlink); } catch { /* preserve the installer error */ }
        throw error;
    }
}

function validateLoopbackBaseUrl(value) {
    let url;
    try { url = new URL(String(value || DEFAULT_BASE_URL)); } catch { url = null; }
    if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
        || url.username || url.password || url.search || url.hash) {
        throw new BifrostSidecarError('bifrost_base_url_invalid', 'Bifrost upstream must be an HTTP IPv4 loopback URL');
    }
    return url.toString().replace(/\/$/, '');
}

function exactKeys(value, expected, label) {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
        throw new BifrostSidecarError('bifrost_config_invalid', `Bifrost config ${label} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new BifrostSidecarError('bifrost_config_invalid', `Bifrost config ${label} is outside the fixed sidecar scope`);
    }
}

function validateRuntimeTemplate(config) {
    exactKeys(config, ['$schema', 'source_of_truth', 'disable_onboarding', 'client', 'providers', 'config_store', 'logs_store', 'framework'], 'root');
    exactKeys(config.client, ['enable_logging', 'disable_content_logging', 'enforce_auth_on_inference', 'allowed_origins', 'disable_db_pings_in_health'], 'client');
    exactKeys(config.providers, [PROVIDER], 'providers');
    const provider = config.providers[PROVIDER];
    exactKeys(provider, ['keys', 'network_config', 'custom_provider_config'], 'provider');
    exactKeys(provider.network_config, ['base_url', 'max_retries', 'default_request_timeout_in_seconds', 'stream_idle_timeout_in_seconds', 'extra_headers'], 'network');
    exactKeys(provider.network_config.extra_headers, [INTERNAL_HOP_HEADER], 'extra headers');
    exactKeys(provider.custom_provider_config, ['base_provider_type', 'is_key_less', 'allowed_requests'], 'custom provider');
    const allowed = provider.custom_provider_config.allowed_requests;
    exactKeys(allowed, ['chat_completion', 'chat_completion_stream'], 'allowed requests');
    exactKeys(config.config_store, ['enabled'], 'config store');
    exactKeys(config.logs_store, ['enabled'], 'logs store');
    exactKeys(config.framework, ['pricing'], 'framework');
    const pricing = config.framework.pricing;
    exactKeys(pricing, ['pricing_url', 'model_parameters_url', 'pricing_sync_interval', 'mcp_library_sync_interval', 'live_models_sync_interval'], 'pricing');
    if (config.source_of_truth !== 'config.json' || config.disable_onboarding !== true
        || config.client.enable_logging !== false || config.client.disable_content_logging !== true
        || config.client.enforce_auth_on_inference !== false
        || !Array.isArray(config.client.allowed_origins) || config.client.allowed_origins.length !== 1
        || config.client.allowed_origins[0] !== 'http://127.0.0.1:20100'
        || config.client.disable_db_pings_in_health !== true
        || config.config_store.enabled !== false || config.logs_store.enabled !== false
        || !Array.isArray(provider.keys) || provider.keys.length !== 0
        || provider.network_config.base_url !== DEFAULT_BASE_URL
        || provider.network_config.max_retries !== 0
        || provider.network_config.default_request_timeout_in_seconds !== 600
        || provider.network_config.stream_idle_timeout_in_seconds !== 120
        || provider.network_config.extra_headers[INTERNAL_HOP_HEADER] !== INTERNAL_HOP_MARKER
        || provider.custom_provider_config.base_provider_type !== 'anthropic'
        || provider.custom_provider_config.is_key_less !== true
        || allowed.chat_completion !== true || allowed.chat_completion_stream !== true
        || pricing.pricing_url !== 'bifrost-pricing.json'
        || pricing.model_parameters_url !== 'bifrost-model-parameters.json'
        || pricing.pricing_sync_interval !== 86400
        || pricing.mcp_library_sync_interval !== 0
        || pricing.live_models_sync_interval !== 0) {
        throw new BifrostSidecarError('bifrost_config_invalid', 'Bifrost config template violates the file-only sidecar contract');
    }
    return provider;
}

function fileUrl(file) {
    return `file:${path.resolve(file).split(path.sep).join('/')}`;
}

function readCatalogLock(lockPath = DEFAULT_LOCK_PATH) {
    const lock = readLock(lockPath);
    const catalogs = lock.catalogs;
    if (!catalogs || Array.isArray(catalogs)
        || !catalogs.pricing || !catalogs.modelParameters
        || catalogs.pricing.filename !== path.basename(DEFAULT_PRICING_PATH)
        || catalogs.modelParameters.filename !== path.basename(DEFAULT_MODEL_PARAMETERS_PATH)
        || !/^[a-f0-9]{64}$/.test(String(catalogs.pricing.sha256 || ''))
        || !/^[a-f0-9]{64}$/.test(String(catalogs.modelParameters.sha256 || ''))) {
        throw new BifrostSidecarError('bifrost_lock_invalid', 'Pinned Bifrost catalog metadata is invalid');
    }
    return { lock, catalogs };
}

function copyPinnedCatalog(source, target, expectedSha256) {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || !verifyFile(source, expectedSha256).ok) {
        throw new BifrostSidecarError('bifrost_catalog_invalid', 'Pinned Bifrost catalog failed identity verification');
    }
    writeAtomic(target, fs.readFileSync(source));
    if (!verifyFile(target, expectedSha256).ok) {
        throw new BifrostSidecarError('bifrost_catalog_invalid', 'Projected Bifrost catalog failed identity verification');
    }
}

function recoverRuntimeStages(appDir) {
    const exactStage = /^(?:config\.json|bifrost-pricing\.json|bifrost-model-parameters\.json)\.(?:tmp-\d+-\d+|stage-[A-Za-z0-9._-]+)$/;
    for (const name of fs.readdirSync(appDir)) {
        if (!exactStage.test(name)) continue;
        const stale = path.join(appDir, name);
        const stat = fs.lstatSync(stale);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new BifrostSidecarError('bifrost_runtime_not_file_only', 'Bifrost runtime app directory contains unsafe stage files');
        }
        fs.unlinkSync(stale);
    }
}

function writeRuntimeConfig({
    templatePath = DEFAULT_CONFIG_PATH,
    lockPath = DEFAULT_LOCK_PATH,
    pricingPath = DEFAULT_PRICING_PATH,
    modelParametersPath = DEFAULT_MODEL_PARAMETERS_PATH,
    appDir = DEFAULT_RUNTIME_ROOT,
    baseUrl = DEFAULT_BASE_URL,
    internalMarker = INTERNAL_HOP_MARKER,
} = {}) {
    const config = readJson(templatePath, 'Bifrost config template');
    const provider = validateRuntimeTemplate(config);
    const marker = String(internalMarker || '');
    if (!marker || /[\r\n]/.test(marker)) {
        throw new BifrostSidecarError('bifrost_marker_invalid', 'Bifrost internal marker is invalid');
    }
    provider.network_config.base_url = validateLoopbackBaseUrl(baseUrl);
    provider.network_config.extra_headers = { [INTERNAL_HOP_HEADER]: marker };
    fs.mkdirSync(appDir, { recursive: true });
    recoverRuntimeStages(appDir);
    const unexpected = fs.readdirSync(appDir).filter(name => !['config.json', 'bifrost-pricing.json', 'bifrost-model-parameters.json'].includes(name));
    if (unexpected.length) {
        throw new BifrostSidecarError('bifrost_runtime_not_file_only', 'Bifrost runtime app directory contains unexpected files');
    }
    const { catalogs } = readCatalogLock(lockPath);
    const catalogFiles = [
        [pricingPath, path.join(appDir, catalogs.pricing.filename), catalogs.pricing.sha256],
        [modelParametersPath, path.join(appDir, catalogs.modelParameters.filename), catalogs.modelParameters.sha256],
    ];
    for (const [source, target, sha256] of catalogFiles) copyPinnedCatalog(source, target, sha256);
    config.framework.pricing.pricing_url = fileUrl(catalogFiles[0][1]);
    config.framework.pricing.model_parameters_url = fileUrl(catalogFiles[1][1]);
    const configPath = path.join(appDir, 'config.json');
    writeAtomic(configPath, JSON.stringify(config, null, 2) + '\n');
    return configPath;
}

function expectedExecutable({
    lockPath = DEFAULT_LOCK_PATH,
    cacheRoot = DEFAULT_CACHE_ROOT,
    platform = process.platform,
    arch = process.arch,
} = {}) {
    const lock = readLock(lockPath);
    const artifact = selectArtifact(lock, platform, arch);
    return { executable: cacheLocation(lock, artifact, cacheRoot), lock, artifact };
}

async function prepareLaunch({
    lockPath = DEFAULT_LOCK_PATH,
    configTemplatePath = DEFAULT_CONFIG_PATH,
    cacheRoot = DEFAULT_CACHE_ROOT,
    runtimeRoot = DEFAULT_RUNTIME_ROOT,
    platform = process.platform,
    arch = process.arch,
    baseUrl = DEFAULT_BASE_URL,
    internalMarker = INTERNAL_HOP_MARKER,
    install = true,
    download = downloadToFile,
    afterVerify = () => {},
} = {}) {
    const installed = install
        ? await ensureInstalled({ lockPath, cacheRoot, platform, arch, download })
        : { ...expectedExecutable({ lockPath, cacheRoot, platform, arch }), installed: true };
    const before = verifyFile(installed.executable, installed.artifact.sha256);
    if (!before.ok) {
        throw new BifrostSidecarError('bifrost_cache_corrupt', 'Cached Bifrost artifact is missing or failed checksum verification');
    }
    const appDir = path.join(runtimeRoot, installed.lock.version);
    const configPath = writeRuntimeConfig({
        templatePath: configTemplatePath,
        lockPath,
        appDir,
        baseUrl,
        internalMarker,
    });
    await afterVerify(installed.executable);
    const launchCheck = verifyFile(installed.executable, installed.artifact.sha256);
    if (!launchCheck.ok) {
        throw new BifrostSidecarError('bifrost_cache_corrupt', 'Cached Bifrost artifact changed before launch');
    }
    return {
        ...installed,
        appDir,
        configPath,
        verified: true,
    };
}

function createServiceDescriptor({
    executable,
    appDir,
    configPath = path.join(appDir || '', 'config.json'),
    configSha256,
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    env = {},
    expectedSha256,
    version,
    prepare,
    platform = process.platform,
} = {}) {
    if (!executable || !appDir) throw new BifrostSidecarError('bifrost_descriptor_invalid', 'Bifrost executable and app dir are required');
    if (host !== DEFAULT_HOST || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
        throw new BifrostSidecarError('bifrost_descriptor_invalid', 'Bifrost must bind a valid IPv4 loopback port');
    }
    return {
        port: Number(port),
        name: 'Bifrost',
        executable,
        args: [
            '-app-dir', appDir,
            '-host', DEFAULT_HOST,
            '-port', String(Number(port)),
            '-log-level', 'error',
            '-log-style', 'json',
        ],
        envPolicy: 'allowlist',
        env: {
            BIFROST_BASE_PATH: '/',
            BIFROST_NO_UPDATE_CHECK: '1',
            ...env,
        },
        cwd: appDir,
        ready: '/health',
        optional: true,
        logName: 'bifrost',
        imageName: platform === 'win32' ? 'bifrost-http.exe' : 'bifrost-http',
        identity: {
            path: path.resolve(executable),
            sha256: expectedSha256 || null,
            version: version || null,
            appDir: path.resolve(appDir),
            configPath: path.resolve(configPath),
            configSha256: configSha256 || (fs.existsSync(configPath) ? hashFile(configPath) : null),
            healthPath: '/health',
            marker: INTERNAL_HOP_MARKER,
        },
        prepare,
    };
}

function defaultServiceDescriptor({
    lockPath = DEFAULT_LOCK_PATH,
    configTemplatePath = DEFAULT_CONFIG_PATH,
    cacheRoot = DEFAULT_CACHE_ROOT,
    runtimeRoot = DEFAULT_RUNTIME_ROOT,
    platform = process.platform,
    arch = process.arch,
    port = Number(process.env.BIFROST_PORT || DEFAULT_PORT),
    baseUrl = process.env.BIFROST_UPSTREAM_URL || DEFAULT_BASE_URL,
} = {}) {
    const requestedPort = Number(port);
    const portError = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
        ? null
        : new BifrostSidecarError('bifrost_descriptor_invalid', 'Bifrost port is invalid');
    const safePort = portError ? DEFAULT_PORT : requestedPort;
    let executable = path.join(
        cacheRoot,
        'unavailable',
        platform === 'win32' ? 'bifrost-http.exe' : 'bifrost-http',
    );
    let appDir = path.join(runtimeRoot, 'unavailable');
    let expectedSha256 = null;
    let expectedVersion = null;
    try {
        const expected = expectedExecutable({ lockPath, cacheRoot, platform, arch });
        executable = expected.executable;
        appDir = path.join(runtimeRoot, expected.lock.version);
        expectedSha256 = expected.artifact.sha256;
        expectedVersion = expected.lock.version;
    } catch {
        // Optional service registration must not make lifecycle.js unloadable. The same
        // lock error is surfaced by prepare() as a local sidecar degradation at start.
    }
    return createServiceDescriptor({
        executable,
        appDir,
        platform,
        port: safePort,
        expectedSha256,
        version: expectedVersion,
        prepare: async descriptor => {
            if (portError) throw portError;
            const ready = await prepareLaunch({
                lockPath,
                configTemplatePath,
                cacheRoot,
                runtimeRoot,
                platform,
                arch,
                baseUrl,
                install: false,
            });
            return createServiceDescriptor({
                executable: ready.executable,
                appDir: ready.appDir,
                platform,
                configPath: ready.configPath,
                configSha256: hashFile(ready.configPath),
                port: descriptor.port,
                env: descriptor.env,
                expectedSha256: ready.artifact.sha256,
                version: ready.lock.version,
                prepare: descriptor.prepare,
            });
        },
    });
}

function redactedStatus({ lockPath = DEFAULT_LOCK_PATH, installed = false, verified = false } = {}) {
    const lock = readLock(lockPath);
    return {
        repo: lock.repo,
        version: lock.version,
        installed: !!installed,
        verified: !!verified,
        provider: PROVIDER,
    };
}

async function cli() {
    const command = process.argv[2] || 'status';
    if (command === 'install') {
        const launch = await prepareLaunch();
        process.stdout.write(JSON.stringify(redactedStatus({ installed: true, verified: launch.verified })) + '\n');
        return;
    }
    if (command === 'status') {
        const expected = expectedExecutable();
        const check = verifyFile(expected.executable, expected.artifact.sha256);
        process.stdout.write(JSON.stringify(redactedStatus({ installed: fs.existsSync(expected.executable), verified: check.ok })) + '\n');
        return;
    }
    throw new BifrostSidecarError('bifrost_command_invalid', 'Usage: bifrost-sidecar.js [install|status]');
}

if (require.main === module) {
    cli().catch(error => {
        process.stderr.write(`Bifrost sidecar: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    BifrostSidecarError,
    ROUTING,
    DEFAULT_LOCK_PATH,
    DEFAULT_CONFIG_PATH,
    DEFAULT_PRICING_PATH,
    DEFAULT_MODEL_PARAMETERS_PATH,
    DEFAULT_CACHE_ROOT,
    DEFAULT_RUNTIME_ROOT,
    DEFAULT_BASE_URL,
    DEFAULT_HOST,
    DEFAULT_PORT,
    INTERNAL_HOP_HEADER,
    INTERNAL_HOP_MARKER,
    PROVIDER,
    readLock,
    selectArtifact,
    verifyFile,
    ensureInstalled,
    writeRuntimeConfig,
    expectedExecutable,
    prepareLaunch,
    createServiceDescriptor,
    defaultServiceDescriptor,
    redactedStatus,
    downloadToFile,
};
