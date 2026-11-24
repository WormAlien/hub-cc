#!/usr/bin/env node
'use strict';

// The AgentRouter quota schedule/dial was removed, not hidden. Run the real
// dashboard regression: no quota UI/requests, Sol selection and F5/mobile flows.
process.env.AR_UI_STAGE = 'all';
require('./check-ar-sol-ui.js');
