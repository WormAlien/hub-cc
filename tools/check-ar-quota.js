#!/usr/bin/env node
'use strict';

// AgentRouter no longer has batch quota control. This legacy entrypoint now
// exercises the actual retired endpoints, zero-side-effect policy, catalog and
// statusline instead of requiring the removed clock/probe/fallback feature.
require('./check-ar-sol-control.js');
