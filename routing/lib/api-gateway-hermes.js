'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const INSTALL_COMMAND = 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)';
const START_COMMAND = 'hermes dashboard --no-open';
const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:9119';
const STATUS_PATH = '/api/status';
const CUSTOM_ENDPOINT_PATH = '/api/providers/custom-endpoints';
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_RESPONSE_BYTES = 256 * 1024;

class HermesServiceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'HermesServiceError';
        this.code = code;
    }
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function defaultInstallationProbes() {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return [];
    return [
        path.join(localAppData, 'hermes', 'bin', 'hermes.cmd'),
        path.join(localAppData, 'hermes', 'hermes-agent'),
    ];
}

function parseDashboardUrl(value) {
    let parsed;
    try { parsed = new URL(value); }
    catch {
        throw new HermesServiceError(
            'api_gateway_hermes_invalid_options',
            'Hermes dashboard URL must be an HTTP IPv4 loopback origin.',
        );
    }
    const octets = parsed.hostname.split('.').map(Number);
    const loopback = net.isIP(parsed.hostname) === 4
        && octets.length === 4
        && octets[0] === 127
        && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255);
    if (parsed.protocol !== 'http:' || !loopback || parsed.username || parsed.password
        || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new HermesServiceError(
            'api_gateway_hermes_invalid_options',
            'Hermes dashboard URL must be an HTTP IPv4 loopback origin.',
        );
    }
    return parsed.origin;
}

function validateProbes(value) {
    if (!Array.isArray(value) || value.some(probe => typeof probe !== 'string' || !path.isAbsolute(probe))) {
        throw new HermesServiceError(
            'api_gateway_hermes_invalid_options',
            'Hermes installation probes must be absolute paths.',
        );
    }
    return [...new Set(value)];
}

function validModel(value) {
    return typeof value === 'string'
        && value.trim() === value
        && value.indexOf('/') > 0
        && value.indexOf('/') < value.length - 1
        && !/[\s\x00-\x1f\x7f]/u.test(value);
}

function endpointBody(model) {
    return {
        id: 'abuse-hub',
        name: 'ABUSE HUB',
        base_url: 'http://127.0.0.1:20100/openai/v1',
        model,
        api_mode: 'chat_completions',
        discover_models: true,
        make_default: false,
    };
}

function yamlBlock(desired) {
    return [
        'providers:',
        '  abuse-hub:',
        '    name: ABUSE HUB',
        `    base_url: ${desired.base_url}`,
        `    model: ${desired.model}`,
        '    api_mode: chat_completions',
        '    discover_models: true',
        '',
    ].join('\n');
}

function endpointMatches(row, desired) {
    if (!isPlainObject(row)) return false;
    const models = Array.isArray(row.models)
        ? row.models
        : (isPlainObject(row.models) ? Object.keys(row.models) : []);
    const model = typeof row.model === 'string' && row.model
        ? row.model
        : (typeof row.default_model === 'string' ? row.default_model : '');
    return row.id === desired.id
        && row.name === desired.name
        && typeof row.base_url === 'string'
        && row.base_url.replace(/\/+$/, '') === desired.base_url
        && (model === desired.model || models.includes(desired.model))
        && (row.api_mode || row.transport) === desired.api_mode
        && row.discover_models === true;
}

function endpointFromPayload(payload, desired) {
    if (!isPlainObject(payload) || !Array.isArray(payload.endpoints)) return null;
    return payload.endpoints.find(row => isPlainObject(row) && row.id === desired.id) || null;
}

function cleanVersion(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : null;
}

function detectResult(installed) {
    return installed
        ? { status: 'installed', installed: true, startCommand: START_COMMAND }
        : {
            status: 'absent',
            installed: false,
            installCommand: INSTALL_COMMAND,
            startCommand: START_COMMAND,
        };
}

function absentStatus() {
    return {
        ok: true,
        status: 'absent',
        installed: false,
        backendRunning: false,
        apiCompatible: null,
        configured: false,
        synced: false,
        installCommand: INSTALL_COMMAND,
        startCommand: START_COMMAND,
    };
}

function downStatus(desired) {
    return {
        ok: false,
        status: 'down',
        installed: true,
        backendRunning: false,
        apiCompatible: null,
        configured: false,
        synced: false,
        startCommand: START_COMMAND,
        yaml: yamlBlock(desired),
    };
}

function blockedStatus() {
    return {
        ok: false,
        status: 'blocked',
        reason: 'no_published_model',
        installed: true,
        backendRunning: null,
        apiCompatible: null,
        configured: false,
        synced: false,
        startCommand: START_COMMAND,
        error: 'No published API Gateway model is available for Hermes.',
    };
}

function runningStatus({
    apiCompatible,
    configured = false,
    synced = false,
    changed,
    version,
    reason,
    error,
}) {
    const result = {
        ok: error === undefined,
        status: 'running',
        installed: true,
        backendRunning: true,
        apiCompatible,
        configured,
        synced,
    };
    if (changed !== undefined) result.changed = changed;
    if (version !== null && version !== undefined) result.version = version;
    if (reason !== undefined) result.reason = reason;
    if (error !== undefined) result.error = error;
    return result;
}

async function responseJson(response) {
    const length = Number(response.headers && response.headers.get
        ? response.headers.get('content-length')
        : NaN);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return null;
    let text;
    try { text = await response.text(); }
    catch { return null; }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return null;
    try { return JSON.parse(text); }
    catch { return null; }
}

function timeoutSignal(timeoutMs) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(timeoutMs);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    return controller.signal;
}

function createHermesService(options = {}) {
    if (!isPlainObject(options)) {
        throw new HermesServiceError('api_gateway_hermes_invalid_options', 'Hermes service options are invalid.');
    }
    const probes = validateProbes(
        options.installationProbes === undefined ? defaultInstallationProbes() : options.installationProbes,
    );
    const dashboardUrl = parseDashboardUrl(
        options.dashboardBaseUrl || options.dashboardUrl || DEFAULT_DASHBOARD_URL,
    );
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const existsImpl = options.existsImpl || fs.existsSync;
    const getModel = options.getModel;
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
    if (typeof fetchImpl !== 'function' || typeof existsImpl !== 'function' || typeof getModel !== 'function'
        || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
        throw new HermesServiceError('api_gateway_hermes_invalid_options', 'Hermes service options are invalid.');
    }

    function installed() {
        return probes.some(probe => {
            try { return !!existsImpl(probe); }
            catch { return false; }
        });
    }

    function detect() {
        return detectResult(installed());
    }

    async function desiredEndpoint() {
        let model;
        try { model = await getModel(); }
        catch { return null; }
        return validModel(model) ? endpointBody(model) : null;
    }

    async function request(route, method = 'GET', body) {
        const init = {
            method,
            redirect: 'error',
            headers: { accept: 'application/json' },
            signal: timeoutSignal(timeoutMs),
        };
        if (body !== undefined) {
            init.headers['content-type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        let response;
        try { response = await fetchImpl(`${dashboardUrl}${route}`, init); }
        catch { return { reachable: false, ok: false, status: null, payload: null }; }
        return {
            reachable: true,
            ok: !!response.ok,
            status: Number.isInteger(response.status) ? response.status : null,
            payload: await responseJson(response),
        };
    }

    async function inspect(desired) {
        const dashboard = await request(STATUS_PATH);
        if (!dashboard.reachable) return { kind: 'down' };
        const version = cleanVersion(dashboard.payload && dashboard.payload.version);
        if (!dashboard.ok || !isPlainObject(dashboard.payload)) {
            return { kind: 'api-error', version };
        }

        const endpoints = await request(CUSTOM_ENDPOINT_PATH);
        if (!endpoints.reachable) return { kind: 'down' };
        if (endpoints.status === 404) return { kind: 'unsupported', version };
        if (!endpoints.ok || !isPlainObject(endpoints.payload) || !Array.isArray(endpoints.payload.endpoints)) {
            return { kind: 'api-error', version };
        }
        const endpoint = endpointFromPayload(endpoints.payload, desired);
        return {
            kind: 'running',
            version,
            configured: endpoint !== null,
            synced: endpointMatches(endpoint, desired),
        };
    }

    function inspectedStatus(state, desired) {
        if (state.kind === 'down') return downStatus(desired);
        if (state.kind === 'unsupported') {
            return runningStatus({
                apiCompatible: false,
                version: state.version,
                reason: 'unsupported_api',
                error: 'Installed Hermes dashboard does not support custom endpoint sync.',
            });
        }
        if (state.kind === 'api-error') {
            return runningStatus({
                apiCompatible: null,
                version: state.version,
                reason: 'api_error',
                error: 'Hermes dashboard API request failed.',
            });
        }
        return null;
    }

    async function status() {
        if (!installed()) return absentStatus();
        const desired = await desiredEndpoint();
        if (!desired) return blockedStatus();
        const state = await inspect(desired);
        const failure = inspectedStatus(state, desired);
        if (failure) return failure;
        return runningStatus({
            apiCompatible: true,
            version: state.version,
            configured: state.configured,
            synced: state.synced,
        });
    }

    async function sync() {
        if (!installed()) return absentStatus();
        const desired = await desiredEndpoint();
        if (!desired) return blockedStatus();
        const state = await inspect(desired);
        const failure = inspectedStatus(state, desired);
        if (failure) return failure;
        if (state.synced) {
            return runningStatus({
                apiCompatible: true,
                version: state.version,
                configured: true,
                synced: true,
                changed: false,
            });
        }

        const write = await request(CUSTOM_ENDPOINT_PATH, 'POST', desired);
        if (!write.reachable) return downStatus(desired);
        if (write.status === 404) {
            return runningStatus({
                apiCompatible: false,
                version: state.version,
                reason: 'unsupported_api',
                error: 'Installed Hermes dashboard does not support custom endpoint sync.',
            });
        }
        if (!write.ok) {
            return runningStatus({
                apiCompatible: null,
                version: state.version,
                reason: 'api_error',
                error: 'Hermes dashboard API request failed.',
            });
        }

        const verify = await request(CUSTOM_ENDPOINT_PATH);
        if (!verify.reachable) return downStatus(desired);
        if (!verify.ok || !isPlainObject(verify.payload) || !Array.isArray(verify.payload.endpoints)) {
            return runningStatus({
                apiCompatible: null,
                version: state.version,
                reason: 'api_error',
                error: 'Hermes dashboard API request failed.',
            });
        }
        const endpoint = endpointFromPayload(verify.payload, desired);
        if (!endpointMatches(endpoint, desired)) {
            return runningStatus({
                apiCompatible: true,
                version: state.version,
                configured: endpoint !== null,
                reason: 'sync_not_retained',
                error: 'Hermes dashboard did not retain the ABUSE HUB endpoint.',
            });
        }
        return runningStatus({
            apiCompatible: true,
            version: state.version,
            configured: true,
            synced: true,
            changed: true,
        });
    }

    return Object.freeze({ detect, status, sync });
}

module.exports = {
    HermesServiceError,
    createHermesService,
};
