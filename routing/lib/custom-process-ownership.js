'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { DEFAULT_SECRET_FILE, createLocalHopAuth } = require('./local-hop-auth');

const IS_WIN = process.platform === 'win32';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizedPath(value) {
    const resolved = path.resolve(String(value || ''));
    return IS_WIN ? resolved.toLowerCase() : resolved;
}

function normalizedUrl(value) {
    return String(value || '').replace(/\/+$/, '');
}

function commandTokens(value) {
    if (Array.isArray(value)) return value.map(String);
    const text = String(value || '');
    const tokens = [];
    const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
    let match;
    while ((match = pattern.exec(text))) tokens.push(match[1] ?? match[2] ?? match[3]);
    return tokens;
}

function pidAlive(pid) {
    try { process.kill(Number(pid), 0); return true; } catch (error) { return error && error.code === 'EPERM'; }
}

function pidExecutable(pid) {
    try {
        if (IS_WIN) {
            const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').ExecutablePath`;
            const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
                encoding: 'utf8', windowsHide: true,
            });
            return result.status === 0 ? String(result.stdout || '').trim() : '';
        }
        const result = spawnSync('readlink', [`/proc/${Number(pid)}/exe`], { encoding: 'utf8' });
        return result.status === 0 ? String(result.stdout || '').trim() : '';
    } catch { return ''; }
}

function pidArguments(pid) {
    try {
        if (IS_WIN) {
            const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').CommandLine`;
            const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
                encoding: 'utf8', windowsHide: true,
            });
            return result.status === 0 ? String(result.stdout || '').trim() : '';
        }
        try {
            return fs.readFileSync(`/proc/${Number(pid)}/cmdline`).toString('utf8').split('\0').filter(Boolean);
        } catch {
            const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
            return String(result.stdout || '').trim();
        }
    } catch { return ''; }
}

function listenerPids(port) {
    const result = new Set();
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1) return result;
    if (IS_WIN) {
        const output = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
        for (const line of String(output.stdout || '').split(/\r?\n/)) {
            const fields = line.trim().split(/\s+/);
            if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') continue;
            if (!(fields[3] === 'LISTENING' || /:0$/.test(fields[2]))) continue;
            const foundPort = Number(fields[1].slice(fields[1].lastIndexOf(':') + 1));
            if (foundPort === number) result.add(Number(fields[4]));
        }
        return result;
    }
    const output = spawnSync('lsof', ['-nP', `-iTCP:${number}`, '-sTCP:LISTEN', '-F', 'pn'], {
        encoding: 'utf8', windowsHide: true,
    });
    let currentPid = 0;
    for (const line of String(output.stdout || '').split('\n')) {
        if (line[0] === 'p') currentPid = Number(line.slice(1));
        else if (line[0] === 'n' && Number(line.slice(line.lastIndexOf(':') + 1)) === number && currentPid) result.add(currentPid);
    }
    return result;
}

function sha256File(file) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
    catch { return ''; }
}

function buildCustomProcessDescriptors(provider, options = {}) {
    const routingDir = path.resolve(options.routingDir || path.join(__dirname, '..'));
    const id = String(provider && provider.id || '');
    const name = String(provider && (provider.name || provider.id) || '');
    const keepalivePort = Number(provider && provider.proxyPort) || 0;
    const keepalivePid = Number(provider && provider.proxyPid) || 0;
    const adapterPort = Number(provider && provider.adapterPort) || 0;
    const adapterPid = Number(provider && provider.adapterPid) || 0;
    const configFile = path.resolve(options.configFile
        || path.join(os.homedir(), '.claude', `custom-${id}-proxy.json`));
    const localHopSecretPath = path.resolve(options.localHopSecretPath
        || process.env.ABUSE_HUB_LOCAL_HOP_KEY_FILE
        || DEFAULT_SECRET_FILE);
    const script = adapterPort ? path.join(routingDir, 'keepalive-proxy.js') : path.join(routingDir, 'custom-openai-proxy.js');
    const descriptors = [];
    if (keepalivePort) {
        descriptors.push(adapterPort ? {
            role: 'keepalive', pid: keepalivePid, port: keepalivePort,
            providerId: id, providerName: name,
            expectedUpstream: `http://127.0.0.1:${adapterPort}`,
            adapterUrl: `http://127.0.0.1:${adapterPort}`,
            scriptPath: script,
            executablePath: process.execPath,
            statusPath: '/__keepalive/api/status',
            localHopSecretPath,
        } : {
            role: 'adapter', pid: keepalivePid, port: keepalivePort,
            providerId: id, providerName: name,
            expectedUpstream: normalizedUrl(provider && provider.baseUrl),
            scriptPath: script,
            configPath: configFile,
            configSha256: sha256File(configFile),
            executablePath: process.execPath,
            statusPath: '/__custom/api/status',
            localHopSecretPath,
        });
    }
    if (adapterPort) {
        descriptors.push({
            role: 'adapter', pid: adapterPid, port: adapterPort,
            providerId: id, providerName: name,
            expectedUpstream: normalizedUrl(provider && provider.baseUrl),
            scriptPath: path.join(routingDir, 'custom-openai-proxy.js'),
            configPath: configFile,
            configSha256: sha256File(configFile),
            executablePath: process.execPath,
            statusPath: '/__custom/api/status',
            localHopSecretPath,
        });
    }
    return descriptors.filter(item => item.port > 0);
}

function commandMatches(descriptor, value, executable) {
    if (!descriptor || !descriptor.scriptPath) return false;
    if (!executable || normalizedPath(executable) !== normalizedPath(descriptor.executablePath || process.execPath)) return false;
    const tokens = commandTokens(value);
    const normalized = tokens.map(normalizedPath);
    if (!normalized.includes(normalizedPath(descriptor.scriptPath))) return false;
    if (descriptor.configPath && !normalized.includes(normalizedPath(descriptor.configPath))) return false;
    return true;
}

function configMatches(descriptor) {
    if (!descriptor.configPath) return true;
    try {
        if (descriptor.configSha256 && sha256File(descriptor.configPath) !== descriptor.configSha256) return false;
        const raw = fs.readFileSync(descriptor.configPath, 'utf8');
        const config = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Number(config.port) === Number(descriptor.port)
            && String(config.providerName || '') === String(descriptor.providerName || '')
            && (!config.providerId || String(config.providerId) === String(descriptor.providerId || ''))
            && normalizedUrl(config.upstream) === normalizedUrl(descriptor.expectedUpstream);
    } catch { return false; }
}

function statusMatches(descriptor, status) {
    if (!status || status.ok !== true) return false;
    if (Number(status.pid) !== Number(descriptor.pid) || Number(status.port) !== Number(descriptor.port)) return false;
    if (String(status.role || '') !== String(descriptor.role || '')) return false;
    if (String(status.providerId || '') !== String(descriptor.providerId || '')) return false;
    const statusName = status.providerName === undefined ? status.provider : status.providerName;
    if (String(statusName || '') !== String(descriptor.providerName || '')) return false;
    if (normalizedUrl(status.upstream) !== normalizedUrl(descriptor.expectedUpstream)) return false;
    if (descriptor.role === 'keepalive') {
        if (status.localExactAdapter !== true) return false;
        if (normalizedUrl(status.adapterUrl) !== normalizedUrl(descriptor.adapterUrl)) return false;
    }
    if (descriptor.configSha256 && status.configSha256 !== descriptor.configSha256) return false;
    return true;
}

function readProcessStatus(descriptor, { headers = null, timeoutMs = 1200 } = {}) {
    let requestHeaders = headers || descriptor.statusHeaders || null;
    if (!requestHeaders && descriptor.localHopSecretPath) {
        try {
            const auth = createLocalHopAuth({ secretFile: descriptor.localHopSecretPath });
            requestHeaders = { [auth.headerName]: auth.token('status-inspection') };
        } catch { requestHeaders = {}; }
    }
    return new Promise(resolve => {
        const req = http.get({
            hostname: '127.0.0.1', port: Number(descriptor.port), path: descriptor.statusPath,
            headers: requestHeaders || {}, timeout: timeoutMs,
        }, res => {
            const chunks = [];
            let bytes = 0;
            res.on('data', chunk => {
                bytes += chunk.length;
                if (bytes <= 64 * 1024) chunks.push(chunk);
            });
            res.on('end', () => {
                if (res.statusCode !== 200 || bytes > 64 * 1024) return resolve(null);
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

function inspectionFailure(descriptor, holders, reason) {
    const expected = Number(descriptor.pid);
    const foreign = holders.size > 0 || (expected > 0 && pidAlive(expected));
    return {
        ok: false, freed: holders.size === 0, stale: !foreign, foreign,
        pid: expected, port: Number(descriptor.port), role: descriptor.role,
        holding: [...holders], reason,
    };
}

async function inspectCustomProcess(descriptor, adapters = {}) {
    const isAlive = adapters.pidAlive || pidAlive;
    const currentListeners = adapters.listenerPids || listenerPids;
    const executableOf = adapters.pidExecutable || pidExecutable;
    const argumentsOf = adapters.pidArguments || pidArguments;
    const readStatus = adapters.readStatus || readProcessStatus;
    const pid = Number(descriptor && descriptor.pid);
    const port = Number(descriptor && descriptor.port);
    let holders = currentListeners(port);
    if (!(holders instanceof Set)) holders = new Set(holders || []);
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return inspectionFailure(descriptor, holders, 'recorded_pid_gone');
    if (holders.size !== 1 || !holders.has(pid)) return inspectionFailure(descriptor, holders, 'listener_pid_mismatch');
    if (!commandMatches(descriptor, argumentsOf(pid), executableOf(pid))) return inspectionFailure(descriptor, holders, 'process_identity_mismatch');
    if (!configMatches(descriptor)) return inspectionFailure(descriptor, holders, 'config_identity_mismatch');
    const status = await readStatus(descriptor);
    if (!statusMatches(descriptor, status)) return inspectionFailure(descriptor, holders, 'status_identity_mismatch');
    holders = currentListeners(port);
    if (!(holders instanceof Set)) holders = new Set(holders || []);
    if (holders.size !== 1 || !holders.has(pid) || !isAlive(pid)) return inspectionFailure(descriptor, holders, 'listener_changed_after_status');
    return { ok: true, pid, port, role: descriptor.role, holding: [pid], status };
}

async function stopExactPid(pid, { timeoutMs = 3000 } = {}) {
    const number = Number(pid);
    if (!pidAlive(number)) return { pid: number, freed: true, denied: false };
    if (IS_WIN) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(number)], { windowsHide: true });
    } else {
        try { process.kill(number, 'SIGTERM'); } catch (error) {
            if (error && error.code === 'EPERM') return { pid: number, freed: false, denied: true };
        }
    }
    const deadline = Date.now() + timeoutMs;
    while (pidAlive(number) && Date.now() < deadline) await sleep(25);
    if (pidAlive(number) && !IS_WIN) {
        try { process.kill(number, 'SIGKILL'); } catch (error) {
            if (error && error.code === 'EPERM') return { pid: number, freed: false, denied: true };
        }
        for (let i = 0; i < 40 && pidAlive(number); i += 1) await sleep(25);
    }
    return { pid: number, freed: !pidAlive(number), denied: pidAlive(number) };
}

async function cleanupCustomProcess(descriptor, adapters = {}) {
    const inspect = adapters.inspect || inspectCustomProcess;
    const stopPid = adapters.stopExactPid || stopExactPid;
    const first = await inspect(descriptor, adapters);
    if (!first.ok) return first;
    const second = await inspect(descriptor, adapters);
    if (!second.ok) return second;
    const stopped = await stopPid(Number(descriptor.pid));
    let holders = (adapters.listenerPids || listenerPids)(Number(descriptor.port));
    if (!(holders instanceof Set)) holders = new Set(holders || []);
    const foreign = [...holders].some(pid => pid !== Number(descriptor.pid));
    return {
        ok: stopped.freed !== false && !foreign,
        freed: stopped.freed !== false && holders.size === 0,
        denied: !!stopped.denied,
        foreign,
        stale: false,
        pid: Number(descriptor.pid), port: Number(descriptor.port), role: descriptor.role,
        holding: [...holders],
        reason: stopped.freed === false ? 'exact_pid_not_stopped' : (foreign ? 'listener_reused_after_stop' : null),
    };
}

async function cleanupCustomTopology(provider, options = {}) {
    const descriptors = (options.descriptorFactory || buildCustomProcessDescriptors)(provider, options);
    const results = [];
    for (const descriptor of descriptors) results.push(await cleanupCustomProcess(descriptor, options));
    const foreign = results.some(result => result.foreign);
    const denied = results.some(result => result.denied);
    return {
        ok: !foreign && !denied && results.every(result => result.ok || (result.stale && result.freed)),
        freed: results.every(result => result.freed),
        foreign, denied, results,
    };
}

async function sweepInactiveCustomTopologies(providers, activePort, options = {}) {
    const rows = [];
    for (const provider of providers || []) {
        if (Number(provider && provider.proxyPort) === Number(activePort)) continue;
        const result = await cleanupCustomTopology(provider, options);
        rows.push(...result.results.map(row => ({ ...row, providerId: provider && provider.id })));
    }
    return rows;
}

async function recreateActiveCustomTopology(provider, options = {}) {
    const cleanup = await cleanupCustomTopology(provider, options);
    if (!cleanup.ok || !cleanup.freed) return { ok: false, error: 'custom topology ownership mismatch', ...cleanup };
    if (typeof options.spawn !== 'function') return { ok: false, error: 'spawn is required', ...cleanup };
    return options.spawn(provider);
}

module.exports = {
    buildCustomProcessDescriptors,
    cleanupCustomProcess,
    cleanupCustomTopology,
    commandMatches,
    inspectCustomProcess,
    listenerPids,
    pidAlive,
    pidArguments,
    pidExecutable,
    readProcessStatus,
    recreateActiveCustomTopology,
    statusMatches,
    stopExactPid,
    sweepInactiveCustomTopologies,
};
