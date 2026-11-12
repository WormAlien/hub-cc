'use strict';

const path = require('node:path');

function text(value, name) {
    const result = String(value || '').trim();
    if (!result) throw new Error(`${name} is required`);
    return result;
}

function port(value, name) {
    const result = Number(value);
    if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error(`${name} is invalid`);
    return result;
}

function buildRuntimeConfig({ provider, keepalivePort, adapterPort, claudeDir, activeKeyFile, localHopSecretPath }) {
    const id = text(provider && provider.id, 'provider.id');
    const providerName = text(provider && provider.name, 'provider.name');
    const upstream = text(provider && provider.baseUrl, 'provider.baseUrl');
    const relayPort = port(keepalivePort, 'keepalivePort');
    const converterPort = port(adapterPort, 'adapterPort');
    if (relayPort === converterPort) throw new Error('custom keepalive and adapter ports must differ');
    const stateDir = path.resolve(text(claudeDir, 'claudeDir'));
    const keyFile = path.resolve(text(activeKeyFile, 'activeKeyFile'));
    const localHopKeyFile = localHopSecretPath
        ? path.resolve(String(localHopSecretPath))
        : path.join(path.dirname(stateDir), '.secrets', 'abuse-hub-local-hop.key');
    const prefix = `custom-${id}`;

    return {
        converter: {
            port: converterPort,
            upstream,
            keyFile,
            modelMap: { ...(provider.modelMap || {}) },
            providerId: id,
            providerName,
            localHopSecretPath: localHopKeyFile,
        },
        keepaliveEnv: {
            PORT: String(relayPort),
            UPSTREAM: `http://127.0.0.1:${converterPort}`,
            LOCAL_EXACT_ADAPTER: '1',
            CUSTOM_PROVIDER_ID: id,
            CUSTOM_PROVIDER_NAME: providerName,
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: localHopKeyFile,
            KEY_FILE: keyFile,
            MODELMAP_FILE: path.join(stateDir, `${prefix}-modelmap.json`),
            HAIKU_REMAP: '0',
            GPT_PROXY_FORCE: '0',
            PAID_SINGLE_KEY: '1',
            MAX_ATTEMPTS: '1',
            MAX_HEDGES: '0',
            HEDGE_MS: '0',
            PRE_COMMIT_MS: '0',
            HOLD_MS: '0',
            EMPTY_STREAM_MS: '0',
            COUNT_TOKENS_FALLBACK: '0',
            JSON_HOLD_MS: '0',
            STALL_MS: '0',
            CATALOG_TTL_MS: '0',
            POOL_FALLBACK_MODEL: '',
            VISION_BRIDGE: '0',
            MODEL_ECHO: '0',
            MODEL_ECHO_INJECT: '0',
            THINK_STRIP: '0',
            UPSTREAM_NOSTREAM: '0',
            EMPTY_TEXT_FIX: '0',
            AUTOROTATE: '0',
            ROTATE_PROVIDER: '',
            UPSTREAM_TIMEOUT_MS: '600000',
            CONFIG_FILE: path.join(stateDir, `${prefix}-keepalive.json`),
            KEEPALIVE_LOG_FILE: path.join(stateDir, `${prefix}-keepalive.log`),
            LATENCY_FILE: path.join(stateDir, `${prefix}-latency.json`),
            EVENTS_FILE: path.join(stateDir, `${prefix}-events.json`),
            FAILDUMP_DIR: path.join(stateDir, `${prefix}-faildump`),
        },
    };
}

module.exports = { buildRuntimeConfig };
