#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { defaultHermesInstallationProbes } = require('../routing/lib/api-gateway-integration.js');

const RPC_TIMEOUT_VARIABLE = 'HERMES_TUI_RPC_TIMEOUT_MS';
const DEFAULT_RPC_TIMEOUT_MS = '660000';

// Reuse HUB's public installation inventory. Never send user args through cmd.exe:
// Windows installers normally ship a native exe beside/instead of their cmd shim.
function resolveExecutable(options = {}) {
    const platform = options.platform || process.platform;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const { probes } = defaultHermesInstallationProbes(options);
    const candidates = probes.flatMap(file => {
        if (platform !== 'win32') return [file];
        if (/\.exe$/i.test(file)) return [file];
        if (/\.cmd$/i.test(file)) return [paths.join(paths.dirname(file), 'hermes.exe')];
        return [];
    });
    for (const file of new Set(candidates)) {
        try {
            if (!fs.statSync(file).isFile()) continue;
            fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
            return file;
        } catch { /* Missing/non-executable candidate; continue discovery. */ }
    }
    return null;
}

// The optional descriptor is for disposable process fixtures, not a new CLI/config.
function main(args = process.argv.slice(2), { executable, prefixArgs = [], installationOptions = {} } = {}) {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
        console.log([
            'Usage: node tools/launch-hermes.js [args]',
            'Launch stock hermes --tui with the original arguments and current directory.',
            'HERMES_TUI_RPC_TIMEOUT_MS defaults to 660000 only when unset.',
            'Explicit values, including empty/invalid ones, are left to stock Hermes.',
            'PowerShell / cmd.exe / Git Bash / POSIX shells: node tools/launch-hermes.js --profile NAME',
            'Use -- --help to forward --help to Hermes rather than show launcher help.',
            'No credentials, configuration files or gateway lifecycle are changed.',
        ].join('\n'));
        return null;
    }
    if (args[0] === '--') args = args.slice(1);
    executable = executable || resolveExecutable(installationOptions);
    if (!executable) {
        const { installCommand } = defaultHermesInstallationProbes(installationOptions);
        console.error('ABUSE HUB: Hermes executable not found. Install stock Hermes or add its native executable to PATH.');
        if ((installationOptions.platform || process.platform) === 'win32') {
            console.error('A cmd-only shim cannot safely preserve arbitrary args; a native hermes.exe is required.');
        }
        console.error(`Install: ${installCommand}`);
        process.exitCode = 127;
        return null;
    }
    const env = { ...process.env };
    if (env[RPC_TIMEOUT_VARIABLE] === undefined) env[RPC_TIMEOUT_VARIABLE] = DEFAULT_RPC_TIMEOUT_MS;
    const child = spawn(executable, [...prefixArgs, '--tui', ...args], {
        env, cwd: process.cwd(), stdio: 'inherit', shell: false, detached: false,
    });
    const handlers = new Map();
    const cleanup = () => {
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        const handler = () => {
            // Windows console Ctrl+C already reaches the attached child. Calling
            // kill(SIGINT) there force-terminates it and breaks stock interrupt UX.
            if (process.platform === 'win32' && signal === 'SIGINT' && process.stdin.isTTY) return;
            try { child.kill(signal); } catch { /* Child may already have exited. */ }
        };
        handlers.set(signal, handler);
        process.on(signal, handler);
    }
    let spawnFailed = false;
    child.once('error', () => {
        spawnFailed = true;
        cleanup();
        console.error('ABUSE HUB: unable to launch Hermes.');
        process.exitCode = 126;
    });
    child.once('close', (code, signal) => {
        cleanup();
        if (spawnFailed) return;
        if (signal) {
            if (process.platform !== 'win32') process.kill(process.pid, signal);
            else process.exitCode = 128 + (require('node:os').constants.signals[signal] || 1);
        } else if (code !== null) process.exitCode = code;
    });
    return child;
}

module.exports = { main, resolveExecutable, RPC_TIMEOUT_VARIABLE, DEFAULT_RPC_TIMEOUT_MS };
if (require.main === module) main();
