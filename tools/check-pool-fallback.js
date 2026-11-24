#!/usr/bin/env node
'use strict';

// AgentRouter Sol must not fall back on a batch-quota error. Real subprocess
// coverage also preserves same-model retries, hedges and other-provider fallback.
require('./check-ar-sol-keepalive.js');
