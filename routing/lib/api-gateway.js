'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const durableDefault = require('./durable-write.js');

const ERROR_DETAILS = Object.freeze({
    api_gateway_invalid_model: { message: 'Invalid API Gateway model ID.', status: 400 },
    api_gateway_unknown_provider: { message: 'Unknown API Gateway provider.', status: 404 },
    api_gateway_manifest_invalid: { message: 'Invalid API Gateway manifest.', status: 400 },
    api_gateway_revision_conflict: { message: 'API Gateway manifest revision conflict.', status: 409 },
    api_gateway_disabled: { message: 'API Gateway is disabled.', status: 503 },
    api_gateway_unavailable: { message: 'API Gateway state is unavailable.', status: 503 },
    api_gateway_settings_invalid: { message: 'Claude settings are invalid.', status: 400 },
    api_gateway_source_conflict: { message: 'API Gateway source changed during save.', status: 409 },
    api_gateway_transaction_failed: { message: 'API Gateway save transaction failed.', status: 500 },
    api_gateway_recovery_conflict: { message: 'API Gateway recovery found an external edit.', status: 409 },
    api_gateway_busy: { message: 'API Gateway is busy.', status: 409 },
});

const TOP_LEVEL_FIELDS = Object.freeze(['version', 'revision', 'enabled', 'models']);
const MODEL_FIELDS = Object.freeze([
    'displayName',
    'claudeBehavesAs',
    'contextTokens',
    'outputTokens',
    'publishedAt',
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class ApiGatewayError extends Error {
    constructor(code) {
        const detail = ERROR_DETAILS[code] || ERROR_DETAILS.api_gateway_unavailable;
        super(detail.message);
        this.name = 'ApiGatewayError';
        this.code = ERROR_DETAILS[code] ? code : 'api_gateway_unavailable';
        this.status = detail.status;
    }
}

function fail(code) {
    throw new ApiGatewayError(code);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, expected) {
    if (!isPlainObject(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || keys.some(key => typeof key !== 'string')) return false;
    const actual = new Set(keys);
    return expected.every(key => actual.has(key));
}

function hasDangerousKey(value) {
    return Reflect.ownKeys(value).some(key => typeof key === 'string' && DANGEROUS_KEYS.has(key));
}

function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function isNonemptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isCanonicalIsoTimestamp(value) {
    if (typeof value !== 'string') return false;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return false;
    try { return new Date(time).toISOString() === value; } catch { return false; }
}

function parseJsonBytes(raw) {
    if (!Buffer.isBuffer(raw) || raw.length === 0 || raw[0] === 0) fail('api_gateway_unavailable');
    try { return JSON.parse(raw.toString('utf8')); }
    catch { fail('api_gateway_unavailable'); }
}

function readFileBytes(file) {
    try { return fs.readFileSync(file); }
    catch { fail('api_gateway_unavailable'); }
}

function readCanonicalProviders(backendsPath) {
    const doc = parseJsonBytes(readFileBytes(backendsPath));
    if (!isPlainObject(doc) || !isPlainObject(doc.providers) || hasDangerousKey(doc.providers)) {
        fail('api_gateway_unavailable');
    }
    const keys = Reflect.ownKeys(doc.providers);
    if (keys.some(key => typeof key !== 'string')) fail('api_gateway_unavailable');
    return new Set(keys);
}

function providerExists(providers, provider) {
    if (providers instanceof Set || providers instanceof Map) return providers.has(provider);
    if (Array.isArray(providers)) return providers.includes(provider);
    if (isPlainObject(providers)) return Object.prototype.hasOwnProperty.call(providers, provider);
    return false;
}

function parseCanonicalId(id, providers) {
    if (typeof id !== 'string' || id.length === 0 || id.trim() !== id || /\s|[\x00-\x1f\x7f]/u.test(id)) {
        fail('api_gateway_invalid_model');
    }
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1) fail('api_gateway_invalid_model');
    const provider = id.slice(0, slash);
    const model = id.slice(slash + 1);
    if (!providerExists(providers, provider)) fail('api_gateway_unknown_provider');
    return { id, provider, model };
}

function recognizeCallableModel(id, { backendsPath } = {}) {
    return parseCanonicalId(id, readCanonicalProviders(backendsPath));
}

function validateManifestInternal(doc, providers) {
    if (!hasExactFields(doc, TOP_LEVEL_FIELDS) || hasDangerousKey(doc)) return false;
    if (doc.version !== 1 || !isPositiveSafeInteger(doc.revision) || typeof doc.enabled !== 'boolean') return false;
    if (!isPlainObject(doc.models) || hasDangerousKey(doc.models)) return false;

    for (const id of Reflect.ownKeys(doc.models)) {
        if (typeof id !== 'string') return false;
        try { parseCanonicalId(id, providers); } catch { return false; }
        const metadata = doc.models[id];
        if (!hasExactFields(metadata, MODEL_FIELDS) || hasDangerousKey(metadata)) return false;
        if (!isNonemptyString(metadata.displayName) || !isNonemptyString(metadata.claudeBehavesAs)) return false;
        if (!isPositiveSafeInteger(metadata.contextTokens) || !isPositiveSafeInteger(metadata.outputTokens)) return false;
        if (!isCanonicalIsoTimestamp(metadata.publishedAt)) return false;
    }
    return true;
}

function validateManifest(doc, providers) {
    let valid = false;
    try { valid = validateManifestInternal(doc, providers); } catch { valid = false; }
    if (!valid) fail('api_gateway_manifest_invalid');
    return doc;
}

function cloneManifest(doc) {
    const models = {};
    for (const [id, metadata] of Object.entries(doc.models)) models[id] = { ...metadata };
    return {
        version: doc.version,
        revision: doc.revision,
        enabled: doc.enabled,
        models,
    };
}

function prepareManifestUpdate(current, draft, expectedRevision, providers) {
    validateManifest(current, providers);
    if (expectedRevision !== current.revision) fail('api_gateway_revision_conflict');
    if (current.revision === Number.MAX_SAFE_INTEGER) fail('api_gateway_manifest_invalid');
    validateManifest(draft, providers);
    const next = cloneManifest(draft);
    next.revision = current.revision + 1;
    validateManifest(next, providers);
    return next;
}

function parseManifestBytes(raw, providers) {
    let doc;
    try {
        doc = parseJsonBytes(raw);
        validateManifest(doc, providers);
    } catch {
        fail('api_gateway_unavailable');
    }
    return doc;
}

function readManifest({ manifestPath, backendsPath } = {}) {
    const providers = readCanonicalProviders(backendsPath);
    return parseManifestBytes(readFileBytes(manifestPath), providers);
}

function ensureLocalManifestUnlocked({ defaultManifestPath, manifestPath, backendsPath } = {}) {
    const providers = readCanonicalProviders(backendsPath);
    let localBytes;
    try {
        localBytes = fs.readFileSync(manifestPath);
    } catch (error) {
        if (!error || error.code !== 'ENOENT') fail('api_gateway_unavailable');
    }
    if (localBytes !== undefined) return parseManifestBytes(localBytes, providers);

    const defaultBytes = readFileBytes(defaultManifestPath);
    const seed = parseManifestBytes(defaultBytes, providers);
    try { durableDefault.writeAtomic(manifestPath, defaultBytes); }
    catch { fail('api_gateway_unavailable'); }
    return seed;
}

function ensureLocalManifest(options = {}) {
    const { manifestPath } = options;
    const lockPath = `${manifestPath}.lock`;
    let lockFd = null;
    try {
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        lockFd = acquireLock(lockPath);
        recoverManifestUpdateOverlayLocked({ manifestPath });
        return ensureLocalManifestUnlocked(options);
    } catch (error) {
        if (error instanceof ApiGatewayError) throw error;
        fail('api_gateway_unavailable');
    } finally {
        releaseLock(lockPath, lockFd);
    }
}

function readPublishedManifest(options = {}) {
    const { manifestPath, settingsPath } = options;
    const { journal: journalPath, lock: lockPath } = transactionPaths(manifestPath);
    let lockFd = null;
    try {
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        lockFd = acquireLock(lockPath);
        recoverManifestUpdateOverlayLocked({
            manifestPath,
            durableImpl: options.durableImpl || durableDefault,
        });
        if (fs.existsSync(journalPath)) {
            recoverManifestAndPickerUnlocked({
                manifestPath,
                settingsPath,
                durableImpl: options.durableImpl || durableDefault,
            });
        }
        return ensureLocalManifestUnlocked(options);
    } catch (error) {
        if (error instanceof ApiGatewayError) throw error;
        fail('api_gateway_unavailable');
    } finally {
        releaseLock(lockPath, lockFd);
    }
}

function toOpenAiModels(manifest) {
    if (!isPlainObject(manifest)) fail('api_gateway_manifest_invalid');
    if (manifest.enabled === false) fail('api_gateway_disabled');
    if (manifest.enabled !== true || !isPlainObject(manifest.models)) fail('api_gateway_manifest_invalid');

    const models = [];
    for (const [id, metadata] of Object.entries(manifest.models)) {
        if (!isPlainObject(metadata) || !isCanonicalIsoTimestamp(metadata.publishedAt)) {
            fail('api_gateway_manifest_invalid');
        }
        models.push({
            id,
            object: 'model',
            created: Math.floor(Date.parse(metadata.publishedAt) / 1000),
            owned_by: 'abuse-hub',
        });
    }
    models.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return models;
}

function sortedModelEntries(manifest) {
    return Object.entries(manifest.models || {})
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

// Окно клиента задаётся СУФФИКСОМ в выбранной модели: `[1m]` = 1M, без него Claude Code
// верит в 200k. Пикер — такой же путь выбора, как `/model`, и раньше он отдавал голый
// канонический ID: выбранная из пикера `a6api/deepseek-v4.1-flash-1017` давала 200k, хотя
// манифест объявляет 1M (регресс 12.11, заявка владельца). Суффикс управляет ТОЛЬКО окном
// клиента — шлюз срезает его перед маршрутизацией, канонический ID в манифесте остаётся
// прежним.
const PICKER_1M_SUFFIX = '[1m]';
const PICKER_1M_MIN_CONTEXT = 1000000;

function pickerModelId(id, metadata) {
    if (id.includes('[')) return id;
    const context = Number(metadata && metadata.contextTokens);
    return Number.isSafeInteger(context) && context >= PICKER_1M_MIN_CONTEXT
        ? `${id}${PICKER_1M_SUFFIX}`
        : id;
}

function buildModelPicker(manifest) {
    if (!isPlainObject(manifest) || typeof manifest.enabled !== 'boolean' || !isPlainObject(manifest.models)) {
        fail('api_gateway_manifest_invalid');
    }
    return {
        replaceBuiltInOptions: true,
        options: manifest.enabled ? sortedModelEntries(manifest).map(([id, metadata]) => ({
            model: pickerModelId(id, metadata),
            label: metadata.displayName,
            description: 'ABUSE HUB',
            behavesAs: metadata.claudeBehavesAs,
        })) : [],
    };
}

function patchModelPicker(settings, picker) {
    if (!isPlainObject(settings)) fail('api_gateway_settings_invalid');
    const next = Object.create(Object.getPrototypeOf(settings));
    Object.defineProperties(next, Object.getOwnPropertyDescriptors(settings));
    Object.defineProperty(next, 'modelPicker', {
        value: picker,
        writable: true,
        enumerable: true,
        configurable: true,
    });
    return next;
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function readSettings(raw) {
    if (!Buffer.isBuffer(raw) || raw.length === 0 || raw[0] === 0) fail('api_gateway_settings_invalid');
    let text = raw.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let value;
    try { value = JSON.parse(text); } catch { fail('api_gateway_settings_invalid'); }
    if (!isPlainObject(value)) fail('api_gateway_settings_invalid');
    return value;
}

function encodeSettings(value, original) {
    const rawText = original.toString('utf8');
    const bom = rawText.charCodeAt(0) === 0xfeff ? '﻿' : '';
    const withoutBom = bom ? rawText.slice(1) : rawText;
    const newline = withoutBom.includes('\r\n') ? '\r\n' : '\n';
    const indentMatch = withoutBom.match(/\n([ \t]+)\S/);
    const indent = indentMatch ? indentMatch[1] : '  ';
    const hasFinalNewline = /\r?\n$/.test(withoutBom);
    let text = JSON.stringify(value, null, indent).replace(/\n/g, newline);
    if (hasFinalNewline) text += newline;
    return Buffer.from(bom + text, 'utf8');
}

function transactionPaths(manifestPath) {
    return {
        journal: `${manifestPath}.txn`,
        lock: `${manifestPath}.lock`,
        updateJournal: `${manifestPath}.update-txn`,
    };
}

function beginManifestUpdateOverlayLocked({ manifestPath, durableImpl = durableDefault } = {}) {
    const { journal: pickerJournal, updateJournal } = transactionPaths(manifestPath);
    if (fs.existsSync(pickerJournal)) fail('api_gateway_busy');
    if (fs.existsSync(updateJournal)) recoverManifestUpdateOverlayLocked({ manifestPath, durableImpl });
    let before = null;
    try { before = fs.readFileSync(manifestPath); }
    catch (error) {
        if (!error || error.code !== 'ENOENT') fail('api_gateway_unavailable');
    }
    const transactionId = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const backup = before ? `${manifestPath}.bak-api-gateway-update-${transactionId}` : null;
    if (backup) durableImpl.writeAtomic(backup, before);
    const journal = {
        version: 1,
        kind: 'update_overlay',
        existed: before !== null,
        before: before ? sha256(before) : null,
        backup: backup ? path.basename(backup) : null,
    };
    writeJournal(updateJournal, journal, durableImpl);
    return { existed: journal.existed };
}

function recoverManifestUpdateOverlayLocked({
    manifestPath,
    durableImpl = durableDefault,
    allowCurrentReplacement = false,
} = {}) {
    const { updateJournal } = transactionPaths(manifestPath);
    const journal = readJournal(updateJournal);
    if (!journal) return { recovered: 'none' };
    if (journal.kind !== 'update_overlay' || typeof journal.existed !== 'boolean') {
        fail('api_gateway_recovery_conflict');
    }
    let current = null;
    try { current = fs.readFileSync(manifestPath); }
    catch (error) {
        if (!error || error.code !== 'ENOENT') fail('api_gateway_recovery_conflict');
    }
    let backup = null;
    let backupPathname = null;
    if (journal.existed) {
        if (typeof journal.before !== 'string' || typeof journal.backup !== 'string'
            || path.basename(journal.backup) !== journal.backup) {
            fail('api_gateway_recovery_conflict');
        }
        backupPathname = path.join(path.dirname(manifestPath), journal.backup);
        try { backup = fs.readFileSync(backupPathname); }
        catch (error) {
            if (error && error.code === 'ENOENT' && current && sha256(current) === journal.before) {
                safeUnlink(updateJournal);
                durableImpl.fsyncDir(path.dirname(manifestPath));
                return { recovered: 'restored' };
            }
            fail('api_gateway_recovery_conflict');
        }
        if (sha256(backup) !== journal.before) fail('api_gateway_recovery_conflict');
        if (current && sha256(current) !== journal.before && !allowCurrentReplacement) {
            fail('api_gateway_recovery_conflict');
        }
        if (!current || sha256(current) !== journal.before) durableImpl.writeAtomic(manifestPath, backup);
    } else if (current) {
        if (!allowCurrentReplacement) fail('api_gateway_recovery_conflict');
        safeUnlink(manifestPath);
        durableImpl.fsyncDir(path.dirname(manifestPath));
    }
    if (backupPathname) safeUnlink(backupPathname);
    safeUnlink(updateJournal);
    durableImpl.fsyncDir(path.dirname(manifestPath));
    return { recovered: journal.existed ? 'restored' : 'cleared' };
}

function writeJournal(file, value, durable) {
    durable.writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function readJournal(file) {
    let raw;
    try { raw = fs.readFileSync(file); }
    catch (error) {
        if (error && error.code === 'ENOENT') return null;
        fail('api_gateway_unavailable');
    }
    try {
        const value = JSON.parse(raw.toString('utf8'));
        if (!isPlainObject(value) || value.version !== 1) fail('api_gateway_recovery_conflict');
        return value;
    } catch (error) {
        if (error instanceof ApiGatewayError) throw error;
        fail('api_gateway_recovery_conflict');
    }
}

function safeUnlink(file) {
    try { fs.unlinkSync(file); } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
    }
}

function cleanupJournalArtifacts(journalPath, journal, durable, manifestPath, settingsPath) {
    const stageFiles = journal.stages || {};
    const targets = {
        manifest: manifestPath || path.join(path.dirname(journalPath), journal.manifestTarget || ''),
        settings: settingsPath,
    };
    for (const which of ['manifest', 'settings']) {
        const name = stageFiles[which];
        const target = targets[which];
        if (typeof name !== 'string' || path.basename(name) !== name || !target) continue;
        try { durable.discardAtomicSync({ tmp: path.join(path.dirname(target), name) }); }
        catch { /* cleanup is best effort; recovery remains hash guarded */ }
    }
    safeUnlink(journalPath);
}

function targetState(target, beforeHash, afterHash) {
    const current = fs.readFileSync(target);
    const currentHash = sha256(current);
    if (currentHash === beforeHash) return 'before';
    if (currentHash === afterHash) return 'after';
    return 'external';
}

function backupPath(target, transactionId) {
    return `${target}.bak-api-gateway-${transactionId}`;
}

function keepOnlyBackup(target, keep) {
    const dir = path.dirname(target);
    const prefix = `${path.basename(target)}.bak-api-gateway-`;
    let changed = false;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
        if (!name.startsWith(prefix) || path.join(dir, name) === keep) continue;
        try { fs.unlinkSync(path.join(dir, name)); changed = true; } catch { /* latest backup remains valid */ }
    }
    if (changed) durableDefault.fsyncDir(dir);
}

function basenameInSameDirectory(target, file) {
    if (path.dirname(target) !== path.dirname(file)) fail('api_gateway_recovery_conflict');
    return path.basename(file);
}

function journalTarget(target, journal, which) {
    const name = journal.backups && journal.backups[which];
    if (typeof name !== 'string' || path.basename(name) !== name) fail('api_gateway_recovery_conflict');
    return path.join(path.dirname(target), name);
}

function lockOwnerPid(lockPath) {
    let raw;
    try { raw = fs.readFileSync(lockPath, 'utf8').trim(); }
    catch (error) {
        if (error && error.code === 'ENOENT') return null;
        fail('api_gateway_busy');
    }
    const pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid <= 0) return NaN;
    return pid;
}

function processAlive(pid) {
    if (pid === process.pid) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error && error.code === 'ESRCH') return false;
        return true;
    }
}

function retireStaleLock(lockPath) {
    const pid = lockOwnerPid(lockPath);
    if (pid === null) return;
    if (Number.isNaN(pid)) {
        let age = 0;
        try { age = Date.now() - fs.statSync(lockPath).mtimeMs; }
        catch { fail('api_gateway_busy'); }
        if (age < 60000) fail('api_gateway_busy');
    } else if (processAlive(pid)) {
        fail('api_gateway_busy');
    }
    try { safeUnlink(lockPath); }
    catch { fail('api_gateway_busy'); }
}

function acquireLock(lockPath) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let fd = null;
        try {
            fd = fs.openSync(lockPath, 'wx');
            fs.writeFileSync(fd, String(process.pid), 'utf8');
            fs.fsyncSync(fd);
            durableDefault.fsyncDir(path.dirname(lockPath));
            return fd;
        } catch (error) {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch { /* already closed */ }
                try { safeUnlink(lockPath); } catch { /* original error wins */ }
            }
            if (!error || error.code !== 'EEXIST') throw error;
            retireStaleLock(lockPath);
        }
    }
    fail('api_gateway_busy');
}

function releaseLock(lockPath, fd) {
    if (fd === null) return;
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { safeUnlink(lockPath); } catch { /* a stale lock fails the next save closed */ }
}

function recoverManifestAndPickerUnlocked({ manifestPath, settingsPath, durableImpl = durableDefault } = {}) {
    const { journal: journalPath, lock: lockPath } = transactionPaths(manifestPath);
    const journal = readJournal(journalPath);
    if (!journal) return { recovered: 'none' };
    if (!settingsPath || journal.settingsTarget !== path.basename(settingsPath)
        || journal.manifestTarget !== path.basename(manifestPath)) {
        fail('api_gateway_recovery_conflict');
    }
    let manifestState;
    let settingsState;
    try {
        manifestState = targetState(manifestPath, journal.before.manifest, journal.after.manifest);
        settingsState = targetState(settingsPath, journal.before.settings, journal.after.settings);
    } catch { fail('api_gateway_recovery_conflict'); }
    if (manifestState === 'external' || settingsState === 'external') fail('api_gateway_recovery_conflict');

    if (manifestState === 'after' && settingsState === 'after') {
        cleanupJournalArtifacts(journalPath, journal, durableImpl, manifestPath, settingsPath);
        return { recovered: 'committed' };
    }

    const manifestBackup = journalTarget(manifestPath, journal, 'manifest');
    const settingsBackup = journalTarget(settingsPath, journal, 'settings');
    let manifestBefore;
    let settingsBefore;
    try {
        manifestBefore = fs.readFileSync(manifestBackup);
        settingsBefore = fs.readFileSync(settingsBackup);
    } catch { fail('api_gateway_recovery_conflict'); }
    if (sha256(manifestBefore) !== journal.before.manifest
        || sha256(settingsBefore) !== journal.before.settings) {
        fail('api_gateway_recovery_conflict');
    }
    try {
        durableImpl.writeAtomic(manifestPath, manifestBefore);
        durableImpl.writeAtomic(settingsPath, settingsBefore);
    } catch { fail('api_gateway_recovery_conflict'); }
    cleanupJournalArtifacts(journalPath, journal, durableImpl, manifestPath, settingsPath);
    return { recovered: 'rolled_back' };
}

function recoverManifestAndPicker(options = {}) {
    const { manifestPath } = options;
    const { journal: journalPath, lock: lockPath } = transactionPaths(manifestPath);
    if (!fs.existsSync(journalPath)) return { recovered: 'none' };
    let lockFd = null;
    try {
        lockFd = acquireLock(lockPath);
        return recoverManifestAndPickerUnlocked(options);
    } finally {
        releaseLock(lockPath, lockFd);
    }
}

function saveManifestAndPicker({
    manifestPath,
    backendsPath,
    settingsPath,
    expectedRevision,
    draft,
    onStep = () => {},
    durableImpl = durableDefault,
} = {}) {
    const { journal: journalPath, lock: lockPath } = transactionPaths(manifestPath);
    let lockFd = null;
    let stages = [];
    let journal = null;
    let manifestBefore;
    let settingsBefore;
    let manifestCommitted = false;
    let settingsCommitted = false;
    let preserveJournal = false;
    try {
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        lockFd = acquireLock(lockPath);
        recoverManifestUpdateOverlayLocked({ manifestPath, durableImpl });
        const pending = readJournal(journalPath);
        if (pending) recoverManifestAndPickerUnlocked({ manifestPath, settingsPath, durableImpl });

        manifestBefore = fs.readFileSync(manifestPath);
        settingsBefore = fs.readFileSync(settingsPath);
        const providers = readCanonicalProviders(backendsPath);
        const current = parseManifestBytes(manifestBefore, providers);
        const draftManifest = {
            version: 1,
            revision: current.revision,
            enabled: draft && draft.enabled,
            models: draft && draft.models,
        };
        const next = prepareManifestUpdate(current, draftManifest, expectedRevision, providers);
        const settings = readSettings(settingsBefore);
        const nextSettings = patchModelPicker(settings, buildModelPicker(next));
        const manifestAfter = Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8');
        const settingsAfter = encodeSettings(nextSettings, settingsBefore);
        const transactionId = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
        const manifestBackup = backupPath(manifestPath, transactionId);
        const settingsBackup = backupPath(settingsPath, transactionId);
        durableImpl.writeAtomic(manifestBackup, manifestBefore);
        durableImpl.writeAtomic(settingsBackup, settingsBefore);
        journal = {
            version: 1,
            phase: 'prepared',
            manifestTarget: path.basename(manifestPath),
            settingsTarget: path.basename(settingsPath),
            before: { manifest: sha256(manifestBefore), settings: sha256(settingsBefore) },
            after: { manifest: sha256(manifestAfter), settings: sha256(settingsAfter) },
            backups: {
                manifest: basenameInSameDirectory(manifestPath, manifestBackup),
                settings: basenameInSameDirectory(settingsPath, settingsBackup),
            },
            stages: {
                manifest: path.basename(`${manifestPath}.stage-${transactionId}`),
                settings: path.basename(`${settingsPath}.stage-${transactionId}`),
            },
        };
        writeJournal(journalPath, journal, durableImpl);
        const manifestStage = durableImpl.stageAtomicSync(manifestPath, manifestAfter, transactionId);
        stages.push(manifestStage);
        onStep('afterManifestStage');
        const settingsStage = durableImpl.stageAtomicSync(settingsPath, settingsAfter, transactionId);
        stages.push(settingsStage);
        journal.phase = 'staged';
        writeJournal(journalPath, journal, durableImpl);
        onStep('beforeCommit');
        if (sha256(fs.readFileSync(manifestPath)) !== journal.before.manifest
            || sha256(fs.readFileSync(settingsPath)) !== journal.before.settings) {
            const error = new ApiGatewayError('api_gateway_source_conflict');
            error.rolledBack = true;
            throw error;
        }
        durableImpl.commitAtomicSync(manifestStage);
        manifestCommitted = true;
        journal.phase = 'manifest_committed';
        writeJournal(journalPath, journal, durableImpl);
        onStep('afterManifestCommit');
        if (sha256(fs.readFileSync(settingsPath)) !== journal.before.settings) {
            const error = new ApiGatewayError('api_gateway_source_conflict');
            error.rolledBack = true;
            throw error;
        }
        durableImpl.commitAtomicSync(settingsStage);
        settingsCommitted = true;
        journal.phase = 'settings_committed';
        writeJournal(journalPath, journal, durableImpl);
        onStep('afterSettingsCommit');
        if (sha256(fs.readFileSync(manifestPath)) !== journal.after.manifest
            || sha256(fs.readFileSync(settingsPath)) !== journal.after.settings) {
            throw new ApiGatewayError('api_gateway_transaction_failed');
        }
        cleanupJournalArtifacts(journalPath, journal, durableImpl, manifestPath, settingsPath);
        journal = null;
        keepOnlyBackup(manifestPath, manifestBackup);
        keepOnlyBackup(settingsPath, settingsBackup);
        return {
            ok: true,
            revision: next.revision,
            enabled: next.enabled,
            publishedModelCount: Object.keys(next.models).length,
        };
    } catch (caught) {
        const error = caught instanceof ApiGatewayError
            ? caught
            : new ApiGatewayError('api_gateway_transaction_failed');
        if (journal && (manifestCommitted || settingsCommitted)) {
            let canRollback = true;
            try {
                const manifestState = targetState(manifestPath, journal.before.manifest, journal.after.manifest);
                const settingsState = targetState(settingsPath, journal.before.settings, journal.after.settings);
                canRollback = manifestState !== 'external' && settingsState !== 'external';
                if (canRollback) {
                    durableImpl.writeAtomic(manifestPath, manifestBefore);
                    durableImpl.writeAtomic(settingsPath, settingsBefore);
                    cleanupJournalArtifacts(journalPath, journal, durableImpl, manifestPath, settingsPath);
                    journal = null;
                    error.rolledBack = true;
                }
            } catch { canRollback = false; }
            if (!canRollback) {
                preserveJournal = true;
                const conflict = new ApiGatewayError('api_gateway_recovery_conflict');
                conflict.rolledBack = false;
                throw conflict;
            }
        } else {
            for (const stage of stages) {
                try { durableImpl.discardAtomicSync(stage); } catch { /* best effort */ }
            }
            if (journal && !preserveJournal) {
                try { safeUnlink(journalPath); } catch { /* best effort */ }
                journal = null;
            }
            error.rolledBack = true;
        }
        throw error;
    } finally {
        releaseLock(lockPath, lockFd);
    }
}

function makeRedactedOpenAiError(status, code, publicModel) {
    const normalizedStatus = status === 400 ? 400 : status === 404 ? 404 : 503;
    const normalizedCode = normalizedStatus === 400
        ? 'invalid_request'
        : normalizedStatus === 404
            ? 'model_not_found'
            : (code === 'api_gateway_busy' ? 'api_gateway_busy' : 'upstream_unavailable');
    const message = normalizedStatus === 400
        ? 'Invalid request.'
        : normalizedStatus === 404
            ? 'Model not found.'
            : normalizedCode === 'api_gateway_busy'
                ? 'API Gateway is busy.'
                : 'Upstream request failed.';
    const result = {
        error: { message, type: 'api_error', code: normalizedCode },
    };
    if (typeof publicModel === 'string' && publicModel) result.model = publicModel;
    return result;
}

function restoreDelegatedOpenAiObject(value, publicModel, options = {}) {
    if (!isPlainObject(value)) throw new TypeError('Delegated response must be a plain JSON object.');
    if (value.error !== null && value.error !== undefined) {
        return makeRedactedOpenAiError(options.status, options.code, publicModel);
    }
    return { ...value, model: publicModel };
}

module.exports = {
    ApiGatewayError,
    readCanonicalProviders,
    parseCanonicalId,
    recognizeCallableModel,
    validateManifest,
    prepareManifestUpdate,
    ensureLocalManifest,
    readManifest,
    readPublishedManifest,
    toOpenAiModels,
    buildModelPicker,
    patchModelPicker,
    saveManifestAndPicker,
    recoverManifestAndPicker,
    recoverManifestAndPickerLocked: recoverManifestAndPickerUnlocked,
    beginManifestUpdateOverlayLocked,
    recoverManifestUpdateOverlayLocked,
    acquireManifestLock: acquireLock,
    releaseManifestLock: releaseLock,
    restoreDelegatedOpenAiObject,
    makeRedactedOpenAiError,
};
