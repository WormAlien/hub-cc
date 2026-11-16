'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const durableDefault = require('./durable-write.js');

const PROVIDER_NAME = 'abuse-hub';
const PROVIDER_BASE_URL = 'http://127.0.0.1:20100/openai/v1';
const JOURNAL_KIND = 'opencode_three_target';
const HASH_PATTERN = /^(?:[a-f0-9]{64}|absent)$/;
const EMPTY_HASH = 'absent';
const PHASES = new Set([
    'prepared',
    'staged',
    'committed_1',
    'committed_2',
    'committed_3',
]);

class OpenCodeServiceError extends Error {
    constructor(code) {
        const messages = {
            api_gateway_opencode_invalid_options: 'Invalid OpenCode service options.',
            api_gateway_opencode_invalid_manifest: 'Invalid API Gateway manifest.',
            api_gateway_opencode_target_invalid: 'OpenCode target is invalid.',
            api_gateway_opencode_source_conflict: 'OpenCode source changed during sync.',
            api_gateway_opencode_transaction_failed: 'OpenCode sync transaction failed.',
            api_gateway_opencode_recovery_conflict: 'OpenCode recovery found an external edit.',
            api_gateway_opencode_busy: 'OpenCode sync is busy.',
        };
        super(messages[code] || 'OpenCode service is unavailable.');
        this.name = 'OpenCodeServiceError';
        this.code = messages[code] ? code : 'api_gateway_opencode_transaction_failed';
    }
}

function fail(code) {
    throw new OpenCodeServiceError(code);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
    if (!isPlainObject(value)) return false;
    const actual = Reflect.ownKeys(value);
    return actual.length === keys.length
        && actual.every(key => typeof key === 'string' && keys.includes(key));
}

function cloneWithDescriptors(value) {
    const next = Object.create(Object.getPrototypeOf(value));
    Object.defineProperties(next, Object.getOwnPropertyDescriptors(value));
    return next;
}

function sortedPublishedModels(manifest) {
    if (!isPlainObject(manifest) || manifest.version !== 1
        || !Number.isSafeInteger(manifest.revision) || manifest.revision <= 0
        || typeof manifest.enabled !== 'boolean' || !isPlainObject(manifest.models)) {
        fail('api_gateway_opencode_invalid_manifest');
    }
    if (!manifest.enabled) return [];
    return Object.entries(manifest.models)
        .map(([id, metadata]) => {
            if (typeof id !== 'string' || id.length === 0 || id.trim() !== id
                || id.indexOf('/') <= 0 || /[\x00-\x1f\x7f]/u.test(id)
                || !isPlainObject(metadata)
                || typeof metadata.displayName !== 'string'
                || metadata.displayName.length === 0
                || !Number.isSafeInteger(metadata.contextTokens) || metadata.contextTokens <= 0
                || !Number.isSafeInteger(metadata.outputTokens) || metadata.outputTokens <= 0) {
                fail('api_gateway_opencode_invalid_manifest');
            }
            return [id, metadata];
        })
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

function projectProvider(manifest) {
    const models = {};
    for (const [id, metadata] of sortedPublishedModels(manifest)) {
        // OpenCode reads per-model limits from config only; /v1/models carries no metadata.
        // Without `limit` it falls back to 200k/32k and a 1M model silently loses its window.
        models[id] = {
            name: metadata.displayName,
            limit: { context: metadata.contextTokens, output: metadata.outputTokens },
        };
    }
    return {
        npm: '@ai-sdk/openai-compatible',
        name: 'ABUSE HUB',
        options: {
            baseURL: PROVIDER_BASE_URL,
            apiKey: 'dummy',
            timeout: 600000,
        },
        models,
    };
}

function parseJsonBytes(raw) {
    if (!Buffer.isBuffer(raw) || raw.length === 0 || raw[0] === 0) {
        fail('api_gateway_opencode_target_invalid');
    }
    let text = raw.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let value;
    try { value = JSON.parse(text); }
    catch { fail('api_gateway_opencode_target_invalid'); }
    if (!isPlainObject(value)) fail('api_gateway_opencode_target_invalid');
    if (value.provider !== undefined && !isPlainObject(value.provider)) {
        fail('api_gateway_opencode_target_invalid');
    }
    if (value.providers !== undefined && !isPlainObject(value.providers)) {
        fail('api_gateway_opencode_target_invalid');
    }
    return value;
}

function patchProvider(config, provider) {
    const next = cloneWithDescriptors(config);
    const providers = config.provider === undefined ? {} : cloneWithDescriptors(config.provider);
    Object.defineProperty(providers, PROVIDER_NAME, {
        value: provider,
        writable: true,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(next, 'provider', {
        value: providers,
        writable: true,
        enumerable: true,
        configurable: true,
    });
    return next;
}

// OpenCode 2 native schema: `providers.<id>` with package/settings instead of the legacy
// `provider.<id>` with npm/options. Patching the wrong block would duplicate the provider.
function isNativeConfig(value) {
    return isPlainObject(value) && isPlainObject(value.providers);
}

function nativeProvider(provider) {
    return {
        package: 'aisdk:@ai-sdk/openai-compatible',
        name: provider.name,
        settings: provider.options,
        models: provider.models,
    };
}

function patchProviderNative(config, provider) {
    const next = cloneWithDescriptors(config);
    const providers = config.providers === undefined ? {} : cloneWithDescriptors(config.providers);
    Object.defineProperty(providers, PROVIDER_NAME, {
        value: nativeProvider(provider),
        writable: true,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(next, 'providers', {
        value: providers,
        writable: true,
        enumerable: true,
        configurable: true,
    });
    return next;
}

function currentProviderBlock(value) {
    if (isNativeConfig(value)) return value.providers[PROVIDER_NAME];
    return value.provider && value.provider[PROVIDER_NAME];
}

function patchProviderFor(value, provider) {
    return isNativeConfig(value) ? patchProviderNative(value, provider) : patchProvider(value, provider);
}

function encodeFresh(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function encodeLike(value, original) {
    const rawText = original.toString('utf8');
    const hasBom = rawText.charCodeAt(0) === 0xfeff;
    const withoutBom = hasBom ? rawText.slice(1) : rawText;
    const newline = withoutBom.includes('\r\n') ? '\r\n' : '\n';
    const indentMatch = withoutBom.match(/\r?\n([ \t]+)\S/);
    const indent = indentMatch ? indentMatch[1] : '  ';
    const hasFinalNewline = /\r?\n$/.test(withoutBom);
    let text = JSON.stringify(value, null, indent).replace(/\n/g, newline);
    if (hasFinalNewline) text += newline;
    if (hasBom) text = '﻿' + text;
    return Buffer.from(text, 'utf8');
}

function readTarget(target) {
    let raw;
    try { raw = fs.readFileSync(target.path); }
    catch (error) {
        if (error && error.code === 'ENOENT') return { state: 'missing' };
        return { state: 'invalid' };
    }
    try {
        return { state: 'valid', raw, value: parseJsonBytes(raw) };
    } catch {
        return { state: 'invalid' };
    }
}

function isDeepEqual(left, right) {
    try { return JSON.stringify(left) === JSON.stringify(right); }
    catch { return false; }
}

function structuralDiff(currentProvider, desiredProvider) {
    if (!isPlainObject(currentProvider)) {
        return {
            different: true,
            additions: Object.keys(desiredProvider.models).length,
            removals: 0,
            changes: 0,
        };
    }
    const currentModels = isPlainObject(currentProvider.models) ? currentProvider.models : {};
    const desiredModels = desiredProvider.models;
    const currentIds = Object.keys(currentModels);
    const desiredIds = Object.keys(desiredModels);
    return {
        different: !isDeepEqual(currentProvider, desiredProvider),
        additions: desiredIds.filter(id => !Object.prototype.hasOwnProperty.call(currentModels, id)).length,
        removals: currentIds.filter(id => !Object.prototype.hasOwnProperty.call(desiredModels, id)).length,
        changes: desiredIds.filter(id => Object.prototype.hasOwnProperty.call(currentModels, id)
            && !isDeepEqual(currentModels[id], desiredModels[id])).length,
    };
}

function isSafeLabel(label) {
    return typeof label === 'string' && label.length > 0 && label.length <= 80
        && label.trim() === label && !/[\x00-\x1f\x7f\\/:]/u.test(label);
}

function validateOptions(targets, journalPath, durableImpl) {
    if (!Array.isArray(targets) || targets.length !== 3
        || typeof journalPath !== 'string' || !path.isAbsolute(journalPath)) {
        fail('api_gateway_opencode_invalid_options');
    }
    const paths = new Set();
    const labels = new Set();
    for (const target of targets) {
        if (!isPlainObject(target) || !isSafeLabel(target.label)
            || typeof target.path !== 'string' || !path.isAbsolute(target.path)
            || paths.has(target.path) || labels.has(target.label)
            || target.path === journalPath || target.path === `${journalPath}.lock`) {
            fail('api_gateway_opencode_invalid_options');
        }
        paths.add(target.path);
        labels.add(target.label);
    }
    for (const method of ['writeAtomic', 'stageAtomicSync', 'commitAtomicSync', 'discardAtomicSync', 'fsyncDir']) {
        if (!durableImpl || typeof durableImpl[method] !== 'function') {
            fail('api_gateway_opencode_invalid_options');
        }
    }
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function safeUnlink(file) {
    try { fs.unlinkSync(file); }
    catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
    }
}

function readCurrent(target) {
    try { return fs.readFileSync(target.path); }
    catch { return null; }
}

function stateOfTarget(target, beforeHash, afterHash) {
    const current = readCurrent(target);
    if (!current) return beforeHash === EMPTY_HASH ? 'before' : 'external';
    const currentHash = sha256(current);
    if (currentHash === beforeHash) return 'before';
    if (currentHash === afterHash) return 'after';
    return 'external';
}

function stateMatches(state, expected, beforeHash, afterHash) {
    return state === expected || (beforeHash === afterHash && (state === 'before' || state === 'after'));
}

function backupPath(targetPath, transactionId) {
    return `${targetPath}.bak-api-gateway-opencode-${transactionId}`;
}

function keepOnlyBackup(targetPath, keepPath, durableImpl) {
    const directory = path.dirname(targetPath);
    const prefix = `${path.basename(targetPath)}.bak-api-gateway-opencode-`;
    let changed = false;
    let entries = [];
    try { entries = fs.readdirSync(directory); } catch { return; }
    for (const entry of entries) {
        const candidate = path.join(directory, entry);
        if (!entry.startsWith(prefix) || candidate === keepPath) continue;
        try { fs.unlinkSync(candidate); changed = true; } catch { /* keep the older backup */ }
    }
    if (changed) durableImpl.fsyncDir(directory);
}

function isSafeArtifactName(targetPath, name, marker) {
    return typeof name === 'string' && path.basename(name) === name
        && name.startsWith(`${path.basename(targetPath)}.${marker}-`);
}

function validateJournal(journal, targets) {
    if (!hasExactKeys(journal, ['version', 'kind', 'phase', 'targets'])
        || journal.version !== 1 || journal.kind !== JOURNAL_KIND
        || !PHASES.has(journal.phase) || !Array.isArray(journal.targets)
        || journal.targets.length !== 3) {
        fail('api_gateway_opencode_recovery_conflict');
    }
    for (let index = 0; index < targets.length; index += 1) {
        const row = journal.targets[index];
        if (!hasExactKeys(row, ['index', 'before', 'after', 'backup', 'stage'])
            || row.index !== index || !HASH_PATTERN.test(row.before)
            || !HASH_PATTERN.test(row.after)
            || !isSafeArtifactName(targets[index].path, row.backup, 'bak-api-gateway-opencode')
            || !isSafeArtifactName(targets[index].path, row.stage, 'stage')) {
            fail('api_gateway_opencode_recovery_conflict');
        }
    }
    return journal;
}

function writeJournal(journalPath, journal, durableImpl) {
    durableImpl.writeAtomic(journalPath, JSON.stringify(journal, null, 2) + '\n');
}

function readJournal(journalPath, targets) {
    let raw;
    try { raw = fs.readFileSync(journalPath); }
    catch (error) {
        if (error && error.code === 'ENOENT') return null;
        fail('api_gateway_opencode_recovery_conflict');
    }
    if (raw.length === 0 || raw.length > 65536 || raw[0] === 0) {
        fail('api_gateway_opencode_recovery_conflict');
    }
    let journal;
    try { journal = JSON.parse(raw.toString('utf8')); }
    catch { fail('api_gateway_opencode_recovery_conflict'); }
    return validateJournal(journal, targets);
}

function journalArtifact(target, row, field) {
    return path.join(path.dirname(target.path), row[field]);
}

function discardJournalStages(journal, targets, durableImpl) {
    for (let index = 0; index < targets.length; index += 1) {
        durableImpl.discardAtomicSync({
            target: targets[index].path,
            tmp: journalArtifact(targets[index], journal.targets[index], 'stage'),
        });
    }
}

function finishJournal(journalPath, journal, targets, durableImpl) {
    discardJournalStages(journal, targets, durableImpl);
    safeUnlink(journalPath);
    durableImpl.fsyncDir(path.dirname(journalPath));
    for (let index = 0; index < targets.length; index += 1) {
        if (journal.targets[index].before === journal.targets[index].after) continue;
        keepOnlyBackup(
            targets[index].path,
            journalArtifact(targets[index], journal.targets[index], 'backup'),
            durableImpl,
        );
    }
}

function readVerifiedBackup(target, row) {
    if (row.before === EMPTY_HASH) fail('api_gateway_opencode_recovery_conflict');
    let bytes;
    try { bytes = fs.readFileSync(journalArtifact(target, row, 'backup')); }
    catch { fail('api_gateway_opencode_recovery_conflict'); }
    if (sha256(bytes) !== row.before) fail('api_gateway_opencode_recovery_conflict');
    return bytes;
}

function restoreAfterTargets(states, journal, targets, durableImpl) {
    const backups = targets.map((target, index) => (
        states[index] !== 'after' || journal.targets[index].before === journal.targets[index].after
            || journal.targets[index].before === EMPTY_HASH
            ? null
            : readVerifiedBackup(target, journal.targets[index])
    ));
    for (let index = 0; index < targets.length; index += 1) {
        if (states[index] !== 'after') continue;
        if (backups[index]) durableImpl.writeAtomic(targets[index].path, backups[index]);
        else safeUnlink(targets[index].path);
    }
    for (let index = 0; index < targets.length; index += 1) {
        if (states[index] !== 'external'
            && !stateMatches(
                stateOfTarget(targets[index], journal.targets[index].before, journal.targets[index].after),
                'before',
                journal.targets[index].before,
                journal.targets[index].after,
            )) {
            fail('api_gateway_opencode_recovery_conflict');
        }
    }
}

function recoverUnlocked(journalPath, targets, durableImpl) {
    const journal = readJournal(journalPath, targets);
    if (!journal) return { recovered: 'none' };
    const states = targets.map((target, index) => stateOfTarget(
        target,
        journal.targets[index].before,
        journal.targets[index].after,
    ));
    if (states.includes('external')) fail('api_gateway_opencode_recovery_conflict');
    if (states.every((state, index) => stateMatches(
        state,
        'after',
        journal.targets[index].before,
        journal.targets[index].after,
    ))) {
        try { finishJournal(journalPath, journal, targets, durableImpl); }
        catch (error) {
            if (error instanceof OpenCodeServiceError) throw error;
            fail('api_gateway_opencode_recovery_conflict');
        }
        return { recovered: 'committed' };
    }
    try {
        restoreAfterTargets(states, journal, targets, durableImpl);
        finishJournal(journalPath, journal, targets, durableImpl);
    } catch (error) {
        if (error instanceof OpenCodeServiceError) throw error;
        fail('api_gateway_opencode_recovery_conflict');
    }
    return { recovered: 'rolled_back' };
}

function lockOwnerPid(lockPath) {
    let raw;
    try { raw = fs.readFileSync(lockPath, 'utf8').trim(); }
    catch (error) {
        if (error && error.code === 'ENOENT') return null;
        fail('api_gateway_opencode_busy');
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

function retireStaleLock(lockPath, durableImpl) {
    const pid = lockOwnerPid(lockPath);
    if (pid === null) return;
    if (Number.isNaN(pid)) {
        let age;
        try { age = Date.now() - fs.statSync(lockPath).mtimeMs; }
        catch { fail('api_gateway_opencode_busy'); }
        if (age < 60000) fail('api_gateway_opencode_busy');
    } else if (processAlive(pid)) {
        fail('api_gateway_opencode_busy');
    }
    try {
        safeUnlink(lockPath);
        durableImpl.fsyncDir(path.dirname(lockPath));
    } catch {
        fail('api_gateway_opencode_busy');
    }
}

function acquireLock(lockPath, durableImpl) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let fd = null;
        try {
            fd = fs.openSync(lockPath, 'wx');
            fs.writeFileSync(fd, String(process.pid), 'utf8');
            fs.fsyncSync(fd);
            durableImpl.fsyncDir(path.dirname(lockPath));
            return fd;
        } catch (error) {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch { /* already closed */ }
                try { safeUnlink(lockPath); } catch { /* original error wins */ }
            }
            if (!error || error.code !== 'EEXIST') throw error;
            retireStaleLock(lockPath, durableImpl);
        }
    }
    fail('api_gateway_opencode_busy');
}

function releaseLock(lockPath, fd, durableImpl) {
    if (fd === null) return;
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try {
        safeUnlink(lockPath);
        durableImpl.fsyncDir(path.dirname(lockPath));
    } catch { /* the next operation fails closed on a retained lock */ }
}

function transactionResult(targets, changed) {
    return {
        ok: true,
        status: 'synced',
        changed,
        targets: targets.map(target => ({ label: target.label, status: 'synced', synced: true })),
    };
}

function createOpenCodeService({
    targets,
    journalPath,
    durableImpl = durableDefault,
    onStep,
} = {}) {
    validateOptions(targets, journalPath, durableImpl, onStep);
    const fixedTargets = targets.map(target => Object.freeze({ label: target.label, path: target.path }));
    const fixedJournalPath = path.resolve(journalPath);
    const lockPath = `${fixedJournalPath}.lock`;
    const step = onStep || (() => {});

    function withLock(operation) {
        let lockFd = null;
        try {
            lockFd = acquireLock(lockPath, durableImpl);
            return operation();
        } finally {
            releaseLock(lockPath, lockFd, durableImpl);
        }
    }

    function previewUnlocked(manifest) {
        const desired = projectProvider(manifest);
        const rows = fixedTargets.map(target => {
            const read = readTarget(target);
            if (read.state === 'invalid') {
                return {
                    label: target.label,
                    status: read.state,
                    additions: 0,
                    removals: 0,
                    changes: 0,
                };
            }
            const current = read.state === 'missing' ? undefined : currentProviderBlock(read.value);
            const desiredForFile = read.state !== 'missing' && isNativeConfig(read.value)
                ? nativeProvider(desired)
                : desired;
            const diff = structuralDiff(current, desiredForFile);
            const different = read.state === 'missing' || diff.different;
            return {
                label: target.label,
                status: different ? 'changes' : 'synced',
                additions: diff.additions,
                removals: diff.removals,
                changes: diff.changes,
            };
        });
        const aggregate = rows.some(row => row.status === 'invalid')
            ? 'invalid'
            : rows.some(row => row.status === 'changes') ? 'changes' : 'synced';
        return { status: aggregate, targets: rows };
    }

    function recover() {
        return withLock(() => recoverUnlocked(fixedJournalPath, fixedTargets, durableImpl));
    }

    function preview(manifest) {
        return withLock(() => {
            recoverUnlocked(fixedJournalPath, fixedTargets, durableImpl);
            return previewUnlocked(manifest);
        });
    }

    function status(manifest) {
        return withLock(() => {
            recoverUnlocked(fixedJournalPath, fixedTargets, durableImpl);
            const result = previewUnlocked(manifest);
            return {
                status: result.status,
                targets: result.targets.map(row => ({
                    label: row.label,
                    status: row.status,
                    synced: row.status === 'synced',
                })),
            };
        });
    }

    function sync(manifest) {
        return withLock(() => {
            recoverUnlocked(fixedJournalPath, fixedTargets, durableImpl);
            const desired = projectProvider(manifest);
            const records = fixedTargets.map((target, index) => {
                const read = readTarget(target);
                if (read.state === 'invalid') fail('api_gateway_opencode_target_invalid');
                // Absent project configs (a fresh hub clone has no repo-level opencode.json) are created
                // with only the published provider. Without this Sync could never run on a clean install.
                const created = read.state === 'missing';
                const value = created ? {} : read.value;
                const patched = patchProviderFor(value, desired);
                const after = created ? encodeFresh(patched) : encodeLike(patched, read.raw);
                return {
                    index,
                    target,
                    created,
                    before: created ? null : read.raw,
                    after,
                    beforeHash: created ? EMPTY_HASH : sha256(read.raw),
                    afterHash: sha256(after),
                    committed: false,
                };
            });
            const changed = records.filter(record => record.beforeHash !== record.afterHash).length;
            if (changed === 0) return transactionResult(fixedTargets, 0);
            const changedRecords = records.filter(record => record.beforeHash !== record.afterHash);

            const transactionId = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
            let journal = null;
            try {
                for (const record of records) {
                    record.backup = backupPath(record.target.path, transactionId);
                    if (record.beforeHash !== record.afterHash && !record.created) {
                        durableImpl.writeAtomic(record.backup, record.before);
                    }
                }
                journal = {
                    version: 1,
                    kind: JOURNAL_KIND,
                    phase: 'prepared',
                    targets: records.map(record => ({
                        index: record.index,
                        before: record.beforeHash,
                        after: record.afterHash,
                        backup: path.basename(record.backup),
                        stage: path.basename(`${record.target.path}.stage-${transactionId}-${record.index}`),
                    })),
                };
                writeJournal(fixedJournalPath, journal, durableImpl);
                for (const record of changedRecords) {
                    record.stage = durableImpl.stageAtomicSync(
                        record.target.path,
                        record.after,
                        `${transactionId}-${record.index}`,
                    );
                    step(`afterStage${record.index + 1}`);
                }
                journal.phase = 'staged';
                writeJournal(fixedJournalPath, journal, durableImpl);
                step('beforeCommit');

                for (const record of changedRecords) {
                    const states = records.map(item => stateOfTarget(
                        item.target,
                        item.beforeHash,
                        item.afterHash,
                    ));
                    const expected = records.map(item => item.committed ? 'after' : 'before');
                    if (states.some((state, index) => !stateMatches(
                        state,
                        expected[index],
                        records[index].beforeHash,
                        records[index].afterHash,
                    ))) {
                        const error = new OpenCodeServiceError('api_gateway_opencode_source_conflict');
                        Object.defineProperty(error, 'conflictIndexes', {
                            value: states.map((state, index) => state === expected[index] ? -1 : index)
                                .filter(index => index >= 0),
                        });
                        throw error;
                    }
                    durableImpl.commitAtomicSync(record.stage);
                    record.committed = true;
                    journal.phase = `committed_${record.index + 1}`;
                    writeJournal(fixedJournalPath, journal, durableImpl);
                    step(`afterCommit${record.index + 1}`);
                }

                if (records.some(record => !stateMatches(
                    stateOfTarget(record.target, record.beforeHash, record.afterHash),
                    'after',
                    record.beforeHash,
                    record.afterHash,
                ))) {
                    fail('api_gateway_opencode_transaction_failed');
                }
                finishJournal(fixedJournalPath, journal, fixedTargets, durableImpl);
                return transactionResult(fixedTargets, changed);
            } catch (caught) {
                const original = caught instanceof OpenCodeServiceError
                    ? caught
                    : new OpenCodeServiceError('api_gateway_opencode_transaction_failed');
                if (!journal) {
                    original.rolledBack = true;
                    throw original;
                }
                const states = records.map(record => stateOfTarget(
                    record.target,
                    record.beforeHash,
                    record.afterHash,
                ));
                const externalIndexes = states.map((state, index) => state === 'external' ? index : -1)
                    .filter(index => index >= 0);
                const externalCommitted = externalIndexes.some(index => records[index].committed);
                if (externalCommitted) {
                    const conflict = new OpenCodeServiceError('api_gateway_opencode_recovery_conflict');
                    conflict.rolledBack = false;
                    throw conflict;
                }
                try {
                    restoreAfterTargets(states, journal, fixedTargets, durableImpl);
                    finishJournal(fixedJournalPath, journal, fixedTargets, durableImpl);
                } catch {
                    const conflict = new OpenCodeServiceError('api_gateway_opencode_recovery_conflict');
                    conflict.rolledBack = false;
                    throw conflict;
                }
                original.rolledBack = true;
                throw original;
            }
        });
    }

    return Object.freeze({ recover, status, preview, sync });
}

module.exports = {
    createOpenCodeService,
};
