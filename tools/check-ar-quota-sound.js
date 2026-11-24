#!/usr/bin/env node
'use strict';

// Batch-quota notifications were retired together with the dial. This legacy
// entrypoint only exercises the isolated dashboard; it never watches a live hub.
if (process.argv.some(arg => ['--live', '--watch'].includes(arg))) {
    console.error('AgentRouter quota sound/live watch is retired. Run this check without live flags.');
    process.exitCode = 2;
} else {
    process.env.AR_UI_STAGE = 'retirement';
    require('./check-ar-sol-ui.js');
}
