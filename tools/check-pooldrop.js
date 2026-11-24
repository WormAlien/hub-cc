#!/usr/bin/env node
'use strict';

// AgentRouter pool-drop/restore is retired. Preserve the entrypoint with real
// tests of AR refusal/no writes plus unchanged non-AR drop/idempotence/restore.
require('./check-ar-sol-control.js');
