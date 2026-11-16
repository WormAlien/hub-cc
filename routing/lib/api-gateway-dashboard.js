'use strict';

const BLOCKED_DTO_KEYS = /^(?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|password|secret|cookie|authorization|headers?|credentials?|email|path|configPath|fullConfig|config|root|body|raw|content|diff|before|after)$/i;
const MODEL_INPUT_FIELDS = Object.freeze([
    'expectedRevision',
    'id',
    'published',
    'displayName',
    'claudeBehavesAs',
    'contextTokens',
    'outputTokens',
]);
const CATALOG_SOURCES = new Set(['live', 'accounts', 'pricing', 'snapshot', 'configured']);
const DEFAULT_FRESH_MS = 24 * 60 * 60 * 1000;
// Пока модель не опубликована, лимитов у неё нет: манифест хранит только опубликованные метаданные.
// Подставляем типовые значения, чтобы поле не было пустым. Дефолт - окно 1M и вывод 32K: это то,
// что владелец ставит всем своим моделям (решение 12.11: «дефолт лям везде»). Только для чтения:
// подстановка ничего не сохраняет и ничего не требует - Save принимает уже заполненные поля.
const DEFAULT_CONTEXT_TOKENS = 1000000;
const DEFAULT_OUTPUT_TOKENS = 32000;
// behaveAs без решения владельца: пикер Claude Code должен получить осмысленный «сорт» модели,
// иначе строка не отрисуется. Opus 5 - класс, под который у нас настроены лимиты и thinking.
const DEFAULT_CLAUDE_BEHAVES_AS = 'claude-opus-5';

class ApiGatewayDashboardError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'ApiGatewayDashboardError';
        this.code = code;
        this.status = status;
    }
}

function invalidInput() {
    throw new ApiGatewayDashboardError(
        'api_gateway_dashboard_invalid_input',
        'Invalid API Gateway dashboard input.',
        400,
    );
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function isNonemptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function cleanText(value, limit = 2000) {
    let text = String(value == null ? '' : value);
    text = text.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]');
    text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]');
    text = text.replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}\b/g, '[redacted-secret]');
    text = text.replace(/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, '[redacted-path]');
    text = text.replace(/(?:\/Users\/|\/home\/)[^\s"'<>]*/g, '[redacted-path]');
    return text.slice(0, Math.max(0, limit));
}

function safeDto(value, depth = 0) {
    if (depth > 12) return null;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return cleanText(value);
    if (Array.isArray(value)) return value.map(item => safeDto(item, depth + 1));
    if (!isPlainObject(value)) return null;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (BLOCKED_DTO_KEYS.test(key) || item === undefined || typeof item === 'function') continue;
        out[key] = safeDto(item, depth + 1);
    }
    return out;
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function splitCanonicalId(value) {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
        || /\s|[\x00-\x1f\x7f]/u.test(value)) return null;
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) return null;
    return {
        id: value,
        provider: value.slice(0, slash),
        model: value.slice(slash + 1),
    };
}

function validIso(value) {
    if (typeof value !== 'string') return null;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return null;
    try { return new Date(time).toISOString() === value ? value : null; }
    catch { return null; }
}

function timestamp(value) {
    const iso = validIso(value);
    return iso === null ? null : Date.parse(iso);
}

function evidenceId(value) {
    if (typeof value !== 'string') return null;
    const separator = value.indexOf('|');
    if (separator > 0 && separator < value.length - 1) {
        return `${value.slice(0, separator)}/${value.slice(separator + 1)}`;
    }
    return value.includes('/') ? value : null;
}

function normalizePassive(value) {
    const out = Object.create(null);
    const add = (rawId, row) => {
        const id = evidenceId(rawId);
        if (!id) return;
        const raw = typeof row === 'string' ? row : row && (
            row.lastSuccess ?? row.last_success ?? row.lastSeen ?? row.last_seen ?? row.at
        );
        out[id] = { lastSuccess: validIso(raw) };
    };
    const rows = Array.isArray(value) ? value : (value && Array.isArray(value.pairs) ? value.pairs : null);
    if (rows) {
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const rawId = row.id || (
                (row.provider || row.bk) && (row.model || row.m)
                    ? `${row.provider || row.bk}/${row.model || row.m}`
                    : null
            );
            add(rawId, row);
        }
        return out;
    }
    if (value instanceof Map) {
        for (const [id, row] of value) add(id, row);
        return out;
    }
    if (isPlainObject(value)) {
        for (const [id, row] of Object.entries(value)) add(id, row);
    }
    return out;
}

function normalizeProbes(value) {
    const out = Object.create(null);
    const add = (rawId, row) => {
        const id = evidenceId(rawId);
        if (!id || !row || typeof row !== 'object') return;
        const skipped = row.skipped == null ? null : cleanText(row.skipped, 160);
        out[id] = {
            ok: skipped ? null : (typeof row.ok === 'boolean' ? row.ok : null),
            at: skipped ? null : validIso(row.at ?? row.t),
            reason: skipped || (row.reason == null ? null : cleanText(row.reason, 160)),
        };
    };
    const rows = Array.isArray(value) ? value : (value && Array.isArray(value.results) ? value.results : null);
    if (rows) {
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const rawId = row.id || (
                (row.provider || row.bk) && (row.model || row.m)
                    ? `${row.provider || row.bk}/${row.model || row.m}`
                    : null
            );
            add(rawId, row);
        }
        return out;
    }
    if (value instanceof Map) {
        for (const [id, row] of value) add(id, row);
        return out;
    }
    if (isPlainObject(value)) {
        for (const [id, row] of Object.entries(value)) add(id, row);
    }
    return out;
}

function healthOf(passive, probe, now, freshMs) {
    const passiveAt = timestamp(passive.lastSuccess);
    const probeAt = timestamp(probe.at);
    const passiveFresh = passiveAt !== null && passiveAt <= now && now - passiveAt <= freshMs;
    const probeFresh = probeAt !== null && probeAt <= now && now - probeAt <= freshMs;
    const malformedProbe = probe.ok !== null && probeAt === null;
    const futureEvidence = (passiveAt !== null && passiveAt > now) || (probeAt !== null && probeAt > now);

    if (futureEvidence || malformedProbe) {
        return { state: 'warning', reason: 'invalid or future health timestamp' };
    }
    if (probe.ok === true && probeFresh) {
        return { state: 'healthy', reason: null };
    }
    if (passiveFresh && (probe.ok !== false || probeAt === null || passiveAt > probeAt)) {
        return { state: 'healthy', reason: probe.ok === false ? 'newer real traffic succeeded' : null };
    }
    if (probe.ok === false && probeFresh) {
        return { state: 'unhealthy', reason: probe.reason || 'probe failed' };
    }
    if (passiveAt !== null || probeAt !== null) {
        return { state: 'warning', reason: 'health evidence is stale or contradictory' };
    }
    return { state: 'unknown', reason: 'no health evidence' };
}

function normalizeCandidate(row) {
    if (!row || typeof row !== 'object') return null;
    const split = splitCanonicalId(row.id);
    if (!split) return null;
    return {
        ...split,
        catalogSource: CATALOG_SOURCES.has(row.catalogSource) ? row.catalogSource : null,
    };
}

function candidateMap(rows) {
    const result = new Map();
    for (const raw of Array.isArray(rows) ? rows : []) {
        const row = normalizeCandidate(raw);
        if (!row || result.has(row.id)) continue;
        result.set(row.id, row);
    }
    return result;
}

function normalizeNow(now) {
    const value = typeof now === 'function' ? now() : Date.now();
    if (value instanceof Date) return value.getTime();
    const number = Number(value);
    return Number.isFinite(number) ? number : Date.now();
}

function makeRow(id, metadata, candidate, passiveById, probesById, now, freshMs) {
    const split = splitCanonicalId(id) || {
        id,
        provider: '',
        model: id,
    };
    const published = !!metadata;
    const passive = passiveById[id] || { lastSuccess: null };
    const probe = probesById[id] || { ok: null, at: null, reason: null };
    const health = healthOf(passive, probe, now, freshMs);
    const publishedContext = published && isPositiveSafeInteger(metadata.contextTokens) ? metadata.contextTokens : null;
    const publishedOutput = published && isPositiveSafeInteger(metadata.outputTokens) ? metadata.outputTokens : null;
    return {
        id: cleanText(split.id),
        provider: cleanText(split.provider),
        model: cleanText(split.model),
        published,
        displayName: published
            ? cleanText(metadata.displayName)
            : `${cleanText(split.provider)} / ${cleanText(split.model)}`,
        claudeBehavesAs: published
            ? cleanText(metadata.claudeBehavesAs || DEFAULT_CLAUDE_BEHAVES_AS)
            : DEFAULT_CLAUDE_BEHAVES_AS,
        contextTokens: publishedContext === null ? DEFAULT_CONTEXT_TOKENS : publishedContext,
        outputTokens: publishedOutput === null ? DEFAULT_OUTPUT_TOKENS : publishedOutput,
        // Подставленные значения помечены отдельно: поле может быть заполнено, не будучи опубликованным.
        limitsDefaulted: {
            contextTokens: publishedContext === null,
            outputTokens: publishedOutput === null,
        },
        behavesAsDefaulted: !published || !metadata.claudeBehavesAs,
        publishedAt: published ? validIso(metadata.publishedAt) : null,
        catalog: {
            present: !!candidate,
            source: candidate ? candidate.catalogSource : null,
        },

        passive: { lastSuccess: passive.lastSuccess || null },
        probe: {
            ok: probe.ok,
            at: probe.at,
            reason: probe.reason,
        },
        health,
    };
}

function validateUpdateInput(input) {
    if (!isPlainObject(input)) invalidInput();
    const keys = Object.keys(input).sort();
    const expected = [...MODEL_INPUT_FIELDS].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalidInput();
    if (!isPositiveSafeInteger(input.expectedRevision)
        || !splitCanonicalId(input.id)
        || typeof input.published !== 'boolean'
        || !isNonemptyString(input.displayName)
        || !isNonemptyString(input.claudeBehavesAs)
        || !isPositiveSafeInteger(input.contextTokens)
        || !isPositiveSafeInteger(input.outputTokens)) invalidInput();
    return input;
}

function cloneModels(models) {
    const result = {};
    for (const [id, metadata] of Object.entries(isPlainObject(models) ? models : {})) {
        result[id] = isPlainObject(metadata) ? { ...metadata } : metadata;
    }
    return result;
}

function dependency(options, names, fallback = null) {
    for (const name of names) {
        if (typeof options[name] === 'function') return options[name];
    }
    return fallback;
}

function createApiGatewayDashboardService(options = {}) {
    if (!isPlainObject(options)) {
        throw new ApiGatewayDashboardError('api_gateway_dashboard_invalid_options', 'Dashboard options are required.', 500);
    }

    const manifestApi = isPlainObject(options.manifest) ? options.manifest : {};
    const readManifest = dependency(options, ['readPublishedManifest'], manifestApi.read);
    const saveManifest = dependency(options, ['saveManifestAndPicker'], manifestApi.save);
    if (typeof readManifest !== 'function' || typeof saveManifest !== 'function') {
        throw new ApiGatewayDashboardError(
            'api_gateway_dashboard_invalid_options',
            'Manifest reader and transaction are required.',
            500,
        );
    }

    const resolveCandidates = dependency(options, ['resolveModelCandidates'], async () => []);
    const readPassive = dependency(options, ['readPassive'], async () => ({}));
    const readProbes = dependency(options, ['readProbes'], async () => ({}));
    const sidecarReader = dependency(options, ['getSidecarStatus'], async () => ({ status: 'unavailable' }));
    const openCode = options.openCodeService || {};
    const hermes = options.hermesService || {};
    const filePaths = isPlainObject(options.paths) ? options.paths : {};
    const candidateOptions = options.candidateOptions || {};
    const publicUrls = isPlainObject(options.publicUrls) ? safeDto(options.publicUrls) : {
        anthropicBaseUrl: null,
        openaiBaseUrl: null,
    };
    const freshMs = Number.isFinite(Number(options.freshMs)) && Number(options.freshMs) > 0
        ? Number(options.freshMs)
        : DEFAULT_FRESH_MS;

    async function readCurrentManifest() {
        return await readManifest(filePaths);
    }

    async function unavailableStatus(call) {
        try {
            if (typeof call !== 'function') return { status: 'unavailable' };
            const value = await call();
            const safe = safeDto(value);
            return isPlainObject(safe) ? safe : { status: 'unavailable' };
        } catch {
            return { status: 'unavailable' };
        }
    }

    async function sidecarStatus() {
        return unavailableStatus(() => sidecarReader(filePaths));
    }

    async function clientsFromManifest(manifest) {
        const [openCodeStatus, hermesStatus] = await Promise.all([
            unavailableStatus(() => typeof openCode.status === 'function'
                ? openCode.status(manifest)
                : { status: 'unavailable' }),
            unavailableStatus(() => typeof hermes.status === 'function'
                ? hermes.status()
                : { status: 'unavailable' }),
        ]);
        return {
            claude: {
                status: 'managed-on-save',
                manifestRevision: isPositiveSafeInteger(manifest && manifest.revision) ? manifest.revision : null,
                publishedModelCount: Object.keys(manifest && isPlainObject(manifest.models) ? manifest.models : {}).length,
            },
            opencode: openCodeStatus,
            hermes: hermesStatus,
        };
    }

    async function clientsStatus() {
        return clientsFromManifest(await readCurrentManifest());
    }

    function manifestDto(manifest) {
        return {
            version: manifest.version,
            revision: manifest.revision,
            enabled: manifest.enabled,
        };
    }

    function publishedRows(manifest, candidates = new Map(), passive = {}, probes = {}) {
        const currentNow = normalizeNow(options.now);
        const publishedModels = isPlainObject(manifest.models) ? manifest.models : {};
        return Object.keys(publishedModels)
            .sort(compareText)
            .map(id => makeRow(
                id,
                publishedModels[id],
                candidates.get(id) || null,
                passive,
                probes,
                currentNow,
                freshMs,
            ));
    }

    // Первый экран читает только локальный манифест. Discovery, Hermes API, OpenCode status,
    // health-agg и checksum sidecar живут в отдельных запросах: один медленный шлюз не должен
    // держать всю вкладку на «Loading...». Это также делает /api-gateway дешёвым источником
    // опубликованных 1M-моделей для вкладки a6api.
    async function state() {
        const manifest = await readCurrentManifest();
        return {
            ok: true,
            public: publicUrls,
            manifest: manifestDto(manifest),
            models: publishedRows(manifest),
            candidatesLoaded: false,
        };
    }

    // Каталог - явная вторичная операция. UI вызывает её только после выбора провайдера.
    async function candidates({ providers } = {}) {
        const manifest = await readCurrentManifest();
        // Каталог собирается только по видимым вкладкам шлюзов: скрытый провайдер не должен стоить
        // ни сетевых запросов, ни строк в списке. Опубликованная строка остаётся всегда - прятать
        // её значило бы бросить точный ID без ручки.
        const visibleProviders = providers instanceof Set
            ? [...providers]
            : Array.isArray(providers) ? providers : null;
        const discoveryOptions = visibleProviders === null
            ? candidateOptions
            : { ...candidateOptions, providers: visibleProviders };
        const [candidatesRaw, passiveRaw, probesRaw] = await Promise.all([
            Promise.resolve().then(() => resolveCandidates(discoveryOptions)).catch(() => []),
            Promise.resolve().then(() => readPassive(filePaths)).catch(() => ({})),
            Promise.resolve().then(() => readProbes(filePaths)).catch(() => ({})),
        ]);
        const candidates = candidateMap(candidatesRaw);
        const passive = normalizePassive(passiveRaw);
        const probes = normalizeProbes(probesRaw);
        const currentNow = normalizeNow(options.now);
        const publishedModels = isPlainObject(manifest.models) ? manifest.models : {};
        const currentPublishedRows = publishedRows(manifest, candidates, passive, probes);
        const visibleSet = visibleProviders === null ? null : new Set(visibleProviders);
        const candidateRows = [...candidates.values()]
            .filter(row => !Object.prototype.hasOwnProperty.call(publishedModels, row.id))
            .filter(row => visibleSet === null || visibleSet.has(row.provider))
            .sort((left, right) => compareText(left.provider, right.provider)
                || compareText(left.model, right.model)
                || compareText(left.id, right.id))
            .map(row => makeRow(
                row.id,
                null,
                row,
                passive,
                probes,
                currentNow,
                freshMs,
            ));
        return {
            ok: true,
            public: publicUrls,
            manifest: manifestDto(manifest),
            models: currentPublishedRows.concat(candidateRows),
            candidatesLoaded: true,
        };
    }

    async function updateModel(rawInput) {
        const input = validateUpdateInput(rawInput);
        const current = await readCurrentManifest();
        const models = cloneModels(current.models);
        if (input.published) {
            const previous = isPlainObject(models[input.id]) ? models[input.id] : null;
            models[input.id] = {
                displayName: input.displayName,
                claudeBehavesAs: input.claudeBehavesAs,
                contextTokens: input.contextTokens,
                outputTokens: input.outputTokens,
                publishedAt: previous && validIso(previous.publishedAt)
                    ? previous.publishedAt
                    : new Date(normalizeNow(options.now)).toISOString(),
            };
        } else {
            delete models[input.id];
        }
        const result = await saveManifest({
            ...filePaths,
            expectedRevision: input.expectedRevision,
            draft: {
                enabled: current.enabled,
                models,
            },
        });
        return safeDto(result);
    }

    async function openCodePreview() {
        if (typeof openCode.preview !== 'function') {
            throw new ApiGatewayDashboardError('api_gateway_opencode_unavailable', 'OpenCode service is unavailable.', 503);
        }
        return safeDto(await openCode.preview(await readCurrentManifest()));
    }

    async function openCodeSync() {
        if (typeof openCode.sync !== 'function') {
            throw new ApiGatewayDashboardError('api_gateway_opencode_unavailable', 'OpenCode service is unavailable.', 503);
        }
        return safeDto(await openCode.sync(await readCurrentManifest()));
    }

    async function hermesSync() {
        if (typeof hermes.sync !== 'function') {
            throw new ApiGatewayDashboardError('api_gateway_hermes_unavailable', 'Hermes service is unavailable.', 503);
        }
        return safeDto(await hermes.sync());
    }

    return {
        state,
        candidates,
        updateModel,
        sidecarStatus,
        clientsStatus,
        openCodePreview,
        openCodeSync,
        hermesSync,
    };
}

module.exports = {
    ApiGatewayDashboardError,
    createApiGatewayDashboardService,
};
