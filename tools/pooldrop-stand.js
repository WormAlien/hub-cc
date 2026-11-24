#!/usr/bin/env node
'use strict';

// Current end-to-end retirement contract: real keepalive plus production control
// handlers, isolated files and HTTP peers. Never start or modify the live hub.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
for (const script of ['check-ar-sol-keepalive.js', 'check-ar-sol-control.js']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
        env: process.env, stdio: 'inherit', windowsHide: true,
    });
    if (result.error) console.error(result.error.message);
    if (result.error || result.status !== 0) { process.exitCode = result.status || 1; break; }
}
