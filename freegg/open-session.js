'use strict';
// Generated generic New API onboarding; no provider-specific browser code.
Promise.resolve().then(() => require('../routing/lib/newapi-onboarding').runProvider({
    provider: 'freegg', moduleDir: __dirname, label: process.argv[2], mode: process.argv[3] || 'auto',
})).catch(e => { console.error(String((e && (e.code || e.message)) || 'Onboarding failed; inspect the selected account locally.')); process.exitCode = 1; });
