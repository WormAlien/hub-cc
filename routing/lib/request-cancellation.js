'use strict';

const crypto = require('node:crypto');

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_CLAIM_TTL_MS = 60000;
const DEFAULT_HARD_TTL_MS = 660000;
const DEFAULT_SWEEP_INTERVAL_MS = 30000;

function registryError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

function canonicalTokenBytes(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    let raw;
    try { raw = Buffer.from(token, 'base64url'); } catch { return null; }
    if (raw.length !== 32 || raw.toString('base64url') !== token) return null;
    return raw;
}

function hashBytes(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createRequestCancellationRegistry(options = {}) {
    const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    const claimTtlMs = positiveInteger(options.claimTtlMs, DEFAULT_CLAIM_TTL_MS);
    const hardTtlMs = positiveInteger(options.hardTtlMs, DEFAULT_HARD_TTL_MS);
    const sweepIntervalMs = options.sweepIntervalMs === 0
        ? 0
        : positiveInteger(options.sweepIntervalMs, DEFAULT_SWEEP_INTERVAL_MS);
    const records = new Map();
    let closed = false;

    function remove(handle) {
        if (!handle || records.get(handle.key) !== handle) return false;
        handle.state = 'closed';
        records.delete(handle.key);
        return true;
    }

    function invokeAbort(handle) {
        if (!handle || handle.abortInvoked || typeof handle.abortInner !== 'function') return;
        handle.abortInvoked = true;
        try { handle.abortInner(); } catch { /* cancellation must remain idempotent */ }
    }

    function maybeRemove(handle) {
        if (!handle || records.get(handle.key) !== handle) return;
        if (handle.state === 'cancelled' && handle.outerDone && handle.innerDone) {
            remove(handle);
            return;
        }
        if (handle.outerDone && handle.innerDone) remove(handle);
    }

    function sweep(at = now()) {
        for (const handle of records.values()) {
            if (handle.state === 'closed') {
                records.delete(handle.key);
                continue;
            }
            const hardExpired = at > handle.deadlineAt;
            const unclaimedExpired = handle.state === 'pending' && at > handle.claimBy;
            if (!hardExpired && !unclaimedExpired) continue;
            if (handle.state === 'claimed' || (handle.state === 'cancelled' && handle.abortInner)) {
                handle.state = 'cancelled';
                invokeAbort(handle);
            }
            remove(handle);
        }
        return records.size;
    }

    function begin(metadata = {}) {
        if (closed) throw registryError('api_gateway_busy');
        sweep(now());
        if (records.size >= maxEntries) throw registryError('api_gateway_busy');

        let raw;
        let token;
        let key;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            raw = randomBytes(32);
            if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
                throw registryError('api_gateway_busy');
            }
            raw = Buffer.from(raw);
            if (raw.length !== 32) throw registryError('api_gateway_busy');
            token = raw.toString('base64url');
            key = hashBytes(raw);
            if (!records.has(key)) break;
            token = null;
        }
        if (!token) throw registryError('api_gateway_busy');

        const createdAt = now();
        const handle = {
            key,
            state: 'pending',
            publicModel: metadata.publicModel,
            provider: metadata.provider,
            bareModel: metadata.bareModel,
            streamMode: metadata.streamMode === true,
            safeIdentity: metadata.safeIdentity && typeof metadata.safeIdentity === 'object'
                ? { ...metadata.safeIdentity }
                : {},
            createdAt,
            claimBy: createdAt + claimTtlMs,
            deadlineAt: createdAt + hardTtlMs,
            outerDone: false,
            innerDone: false,
            abortInner: null,
            abortInvoked: false,
        };
        records.set(key, handle);
        return { token, handle };
    }

    function claim(token) {
        const raw = canonicalTokenBytes(token);
        if (!raw) throw registryError('request_rejected');
        const key = hashBytes(raw);
        const handle = records.get(key);
        const at = now();
        if (!handle || handle.state !== 'pending' || handle.outerDone || at > handle.claimBy || at > handle.deadlineAt) {
            if (handle && handle.state === 'pending' && (at > handle.claimBy || at > handle.deadlineAt)) remove(handle);
            if (handle && handle.state === 'cancelled' && !handle.abortInner) {
                handle.innerDone = true;
                maybeRemove(handle);
            }
            throw registryError('request_rejected');
        }
        handle.state = 'claimed';
        return handle;
    }

    function bindInnerAbort(handle, abortFn) {
        if (!handle || records.get(handle.key) !== handle || typeof abortFn !== 'function') {
            throw registryError('request_rejected');
        }
        if (handle.abortInner) throw registryError('request_rejected');
        handle.abortInner = abortFn;
        if (handle.state === 'cancelled') {
            invokeAbort(handle);
            return 'already_cancelled';
        }
        if (handle.state !== 'claimed') throw registryError('request_rejected');
        return 'bound';
    }

    function isCancelled(handle) {
        return !handle || records.get(handle.key) !== handle || handle.state === 'cancelled' || handle.state === 'closed';
    }

    function cancel(handle, reason) {
        if (!handle || records.get(handle.key) !== handle) return false;
        if (handle.state === 'cancelled' || handle.state === 'closed') return false;
        if (handle.state !== 'pending' && handle.state !== 'claimed') return false;
        handle.state = 'cancelled';
        handle.cancelReason = typeof reason === 'string' ? reason : 'cancelled';
        invokeAbort(handle);
        maybeRemove(handle);
        return true;
    }

    function finishOuter(handle) {
        if (!handle || records.get(handle.key) !== handle) return false;
        handle.outerDone = true;
        maybeRemove(handle);
        return true;
    }

    function finishInner(handle) {
        if (!handle || records.get(handle.key) !== handle) return false;
        handle.innerDone = true;
        maybeRemove(handle);
        return true;
    }

    function size() {
        return records.size;
    }

    function close() {
        if (closed && records.size === 0) return;
        closed = true;
        if (timer) clearInterval(timer);
        for (const handle of records.values()) {
            if (handle.state === 'claimed' || (handle.state === 'cancelled' && handle.abortInner)) {
                handle.state = 'cancelled';
                invokeAbort(handle);
            }
            handle.state = 'closed';
        }
        records.clear();
    }

    const timer = sweepIntervalMs > 0 ? setInterval(() => sweep(now()), sweepIntervalMs) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();

    return {
        begin,
        claim,
        bindInnerAbort,
        isCancelled,
        cancel,
        finishOuter,
        finishInner,
        sweep,
        size,
        close,
    };
}

module.exports = {
    createRequestCancellationRegistry,
};
