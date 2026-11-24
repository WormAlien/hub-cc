#!/usr/bin/env node
'use strict';
// Real HTTP/browser acceptance; --smoke never performs final UI acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PREVIEW = path.join(ROOT, 'tools/a6api-models-preview.js');
const PREFIX = '/__a6api-preview';
const SCOPE = 'isolated-a6api-models';
const MAIN_ID = 'a6api/deepseek-v4.1-flash-1017';
const NESTED_ID = 'a6api/vendor/nested-model';
const OTHER_ID = 'agentrouter/gpt-5.6-sol';
const scratchRoot = () => path.resolve(process.env.HERMES_TEST_SCRATCH || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch') : path.join(os.homedir(), '.cache/hermes/scratch')));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
const within = (root, file) => {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function httpJson(receipt, pathname, body, expectedStatus = 200) {
    assert.equal(new URL(receipt.url).hostname, '127.0.0.1');
    const response = await fetch(receipt.url + pathname, {
        redirect: 'error', signal: AbortSignal.timeout(6000), ...(body === undefined ? {} : {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: receipt.url,
                'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(body),
        }),
    });
    const text = await response.text();
    assert.equal(response.status, expectedStatus, pathname + ': HTTP status; ' + text.slice(0, 240));
    return JSON.parse(text);
}
function childEnvironment(scratch) {
    const env = {};
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'Path']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return { ...env, HERMES_TEST_SCRATCH: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
        HOME: scratch, USERPROFILE: scratch, LOCALAPPDATA: path.join(scratch, 'local'),
        APPDATA: path.join(scratch, 'roaming'), XDG_CONFIG_HOME: path.join(scratch, 'xdg') };
}
async function waitExit(child, timeout = 6000) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { child.removeListener('exit', done); reject(new Error('owned fixture child exit deadline')); }, timeout);
        child.once('exit', done);
    });
}
async function startFixture(options = {}) {
    assert.ok(fs.existsSync(PREVIEW), 'missing isolated a6api whole-dashboard preview implementation');
    const scratch = scratchRoot();
    fs.mkdirSync(scratch, { recursive: true });
    const child = spawn(process.execPath, [PREVIEW, '--port', '0', '--lifetime-ms', String(options.lifetimeMs || 600000)], {
        cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment(scratch),
    });
    let stdout = '', stderr = '', receipt;
    child.stderr.on('data', chunk => { stderr += chunk; });
    try {
        receipt = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('fixture boot deadline: ' + stderr)), 15000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); reject(new Error('fixture exited before receipt: ' + code + ' ' + stderr)); });
            child.stdout.on('data', chunk => {
                stdout += chunk;
                for (const line of stdout.split(/\r?\n/)) {
                    if (!line.startsWith('A6API_MODELS_PREVIEW ')) continue;
                    try { const value = JSON.parse(line.slice('A6API_MODELS_PREVIEW '.length)); clearTimeout(timer); resolve(value); }
                    catch { /* Wait for the entire JSON line, never guess a URL. */ }
                }
            });
        });
        assert.equal(receipt.pid, child.pid, 'receipt identifies only the exact child launched here');
        assert.equal(receipt.scope, SCOPE);
        assert.ok(within(scratch, receipt.run), 'run belongs to configured Hermes scratch');
        assert.ok(typeof receipt.runId === 'string' && receipt.runId.length > 8);
        const url = new URL(receipt.url);
        assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
        assert.ok(Number(url.port) > 0); assert.equal(url.pathname, '/');
        assert.equal(receipt.readyUrl, receipt.url + PREFIX + '/ready');
        assert.equal(receipt.stateUrl, receipt.url + PREFIX + '/state');
        const ready = await httpJson(receipt, PREFIX + '/ready');
        assert.equal(ready.pid, child.pid); assert.equal(ready.runId, receipt.runId); assert.equal(ready.scope, SCOPE);
        assert.equal(ready.ok, true);
        assert.equal(readJson(receipt.receiptPath).pid, child.pid);
        for (const file of [...Object.values(receipt.paths), ...receipt.targets.map(target => target.path), receipt.receiptPath, receipt.initialPath, receipt.finalPath]) {
            assert.ok(within(receipt.run, file), 'all receipt paths/targets belong to the exact disposable run');
        }
        assert.equal(receipt.targets.length, 3); assert.equal(new Set(receipt.targets.map(target => target.label)).size, 3);
        return { child, receipt, errors: () => stderr, output: () => stdout };
    } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await waitExit(child).catch(() => {});
        throw error;
    }
}
async function stopFixture(fixture) {
    const { child, receipt } = fixture;
    if (child.exitCode === null && child.signalCode === null) {
        try { await httpJson(receipt, PREFIX + '/shutdown', { pid: child.pid, runId: receipt.runId }); }
        catch (error) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            fixture.cleanupFallback = error.message;
        }
        try { await waitExit(child); }
        catch (error) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            await waitExit(child); throw error;
        }
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'exact child stopped');
    await assert.rejects(fetch(receipt.readyUrl, { signal: AbortSignal.timeout(1500) }), 'exact child listener closed');
    fixture.listenerClosed = true;
    const final = readJson(receipt.finalPath);
    assert.equal(final.pid, child.pid); assert.equal(final.runId, receipt.runId); assert.equal(final.closing, true);
    assert.equal(final.guardViolationCount, final.guards.length);
    assert.equal(final.guardViolationCount, 0, 'no outbound sockets or outside fixture writes');
}
async function smoke() {
    const fixture = await startFixture();
    let report;
    try {
        const { receipt } = fixture;
        const response = await fetch(receipt.url, { signal: AbortSignal.timeout(6000) });
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.ok(html.includes('id="main-nav"') && html.includes('id="routes-box"') && html.includes('id="a6api-root"'),
            'serve the whole real dashboard, not substituted a6api markup');
        assert.ok(html.includes('Изолированный a6api preview'));
        for (const asset of ['a6api-tab.js', 'a6api-tab.css', 'model-publication.js', 'api-gateway-tab.js']) {
            const assetResponse = await fetch(receipt.url + '/vendor/' + asset, { signal: AbortSignal.timeout(6000) });
            assert.equal(assetResponse.status, 200, asset);
            assert.equal(await assetResponse.text(), fs.readFileSync(path.join(ROOT, 'routing/vendor', asset), 'utf8'));
        }
        const state = await httpJson(receipt, PREFIX + '/state');
        const a6 = await httpJson(receipt, '/__switch/api/a6api/state');
        assert.equal(a6.selectedTokenId, 9); assert.equal(a6.prepared, true); assert.equal(a6.active, false);
        assert.deepEqual(a6.models, ['deepseek-v4.1-flash-1017', 'deepseek-v4-pro', 'vendor/nested-model']);
        const candidate = await httpJson(receipt, '/__switch/api/a6api/models?tokenId=10');
        assert.deepEqual(candidate.models, ['other-only']);
        const routes = await httpJson(receipt, '/__switch/api/routes');
        const native = routes.providers.find(row => row.name === 'a6api');
        assert.deepEqual(native.tiers, state.native.routesMap); assert.deepEqual(native.gatewayTiers, state.native.modelMap);
        const discovery = await httpJson(receipt, '/openai/v1/models');
        assert.deepEqual(discovery.data.map(model => model.id).sort(), [MAIN_ID, OTHER_ID].sort());
        const after = await httpJson(receipt, PREFIX + '/state');
        assert.deepEqual(after.manifest, state.manifest);
        assert.deepEqual(after.claude.config, state.claude.config);
        assert.deepEqual(after.opencode.map(row => row.config), state.opencode.map(row => row.config));
        assert.deepEqual(after.native, state.native);
        assert.equal(after.requests.filter(row => row.method === 'POST').length, 0, 'boot and HTTP reads cannot save or activate');
        assert.equal(after.guardViolationCount, 0);
        assert.equal(fixture.errors(), '');
        report = { mode: 'boot-http-only', ok: true, receipt, guardWired: receipt.guardWired,
            checks: ['owned PID/readiness', 'real whole dashboard/assets', 'real gateway key/catalog', 'native maps routes readback',
                'real discovery', 'no mutation during inspection'], finalAcceptanceRun: false };
    } finally { await stopFixture(fixture); }
    report.listenerClosed = fixture.listenerClosed;
    fs.writeFileSync(path.join(fixture.receipt.run, 'smoke.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('A6API_MODELS_SMOKE ' + JSON.stringify(report));
    return report;
}
const withoutPicker = value => { const next = structuredClone(value); delete next.modelPicker; return next; };
const withoutHubProvider = value => {
    const next = structuredClone(value);
    for (const name of ['providers', 'provider']) if (next?.[name]) delete next[name]['abuse-hub'];
    return next;
};
async function browserContext(browser, fixture, width = 1440, theme = 'zen') {
    const row = { width, theme, run: fixture.receipt.run, errors: [], consoleErrors: [], blocked: [], screenshots: [], snapshots: [] };
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block',
        recordHar: { path: path.join(fixture.receipt.run, 'browser-' + width + '-' + theme + '.har'), content: 'omit', mode: 'minimal' } });
    await context.addInitScript(({ theme }) => {
        localStorage.setItem('opencode_active_tab', 'a6api'); localStorage.setItem('dashboard-theme', theme);
        window.__a6Copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: async value => window.__a6Copied.push(value) } });
    }, { theme });
    await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== fixture.receipt.url) { row.blocked.push({ origin: url.origin }); return route.abort('blockedbyclient'); }
        if (/\/(?:activate|restart|switch|kill|messages|responses|chat\/completions)(?:\/|$)/.test(url.pathname)) {
            row.blocked.push({ forbidden: url.pathname }); return route.abort('blockedbyclient');
        }
        return route.continue(); // Native key/maps and publication routes are NEVER intercepted successes.
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => row.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') row.consoleErrors.push(message.text()); });
    return { context, page, row };
}
async function openA6(page, receipt) {
    await page.goto(receipt.url, { waitUntil: 'load' });
    await page.locator('.nav-btn[data-tab="a6api"]').click();
    await page.waitForFunction(() => window.A6API && document.querySelector('#a6-model-search')
        && !document.querySelector('#a6-refresh')?.disabled && document.querySelector('#a6-publication-list input[data-publication-id]'));
    await page.locator('#a6-model-search').scrollIntoViewIfNeeded();
}
async function capture(page, row, label) {
    const directory = path.join(row.run, 'screenshots'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, label + '-' + row.width + '-' + row.theme + '.png');
    await page.screenshot({ path: file, fullPage: true }); row.screenshots.push({ label, path: file });
}
async function closeBrowserFixture(fixture, context, row) {
    try {
        await context.tracing.stop({ path: path.join(row.run, 'trace-' + row.width + '-' + row.theme + '.zip') });
        await context.close();
    } finally { await stopFixture(fixture); row.listenerClosed = fixture.listenerClosed; }
    fs.writeFileSync(path.join(row.run, 'browser-receipt.json'), JSON.stringify(row, null, 2) + '\n');
    console.log('A6API_MODELS_BROWSER_EVIDENCE ' + JSON.stringify({ run: row.run, pid: fixture.child.pid, listenerClosed: row.listenerClosed,
        mode: row.mode || 'single-criterion-red', ok: row.ok === true }));
}
async function redOrTrace(mode, options = {}) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    let fixture, bundle;
    try {
        fixture = await startFixture(); bundle = await browserContext(browser, fixture, options.mobile ? 390 : 1440);
        const { page, row } = bundle;
        row.mode = mode === 'red' ? 'single-criterion-red' : 'boot-browser-trace-only';
        await openA6(page, fixture.receipt); await capture(page, row, mode + '-boot');
        const before = await httpJson(fixture.receipt, PREFIX + '/state');
        row.snapshots.push({ label: 'boot', state: before });
        if (mode === 'red') {
            // A single vertical native-default criterion, NOT the final acceptance suite.
            // Stale tiers deliberately make the old all-tier validation fail here.
            await page.locator('#a6-compatibility > summary').click();
            await page.locator('#a6-model-default').selectOption('vendor/nested-model');
            const response = page.waitForResponse(response => response.url().endsWith('/__switch/api/a6api/modelmap') && response.request().method() === 'POST');
            await page.locator('#a6-save').click();
            const result = await response;
            const after = await httpJson(fixture.receipt, PREFIX + '/state');
            await capture(page, row, 'red-default-readback'); row.snapshots.push({ label: 'native-default', state: after, status: result.status() });
            assert.equal(result.status(), 200, 'default-only native save must not require stale Opus/Sonnet/Haiku targets to be permitted');
            assert.deepEqual(after.native.modelMap, { ...before.native.modelMap, default: 'vendor/nested-model' });
            assert.deepEqual(after.native.routesMap, before.native.routesMap);
            assert.deepEqual(after.manifest, before.manifest);
            row.ok = true;
        } else {
            assert.deepEqual(before.manifest, readJson(fixture.receipt.initialPath).manifest);
            assertPreservation(before, readJson(fixture.receipt.initialPath)); assertProjection(before);
            assert.equal(before.guardViolationCount, 0); assert.equal(before.requests.filter(r => r.method === 'POST').length, 0);
            assert.deepEqual(row.errors, []); assert.deepEqual(row.consoleErrors, []);
            assert.deepEqual(before.requests.filter(r => r.method === 'GET' && r.status >= 400), []);
            row.ok = true; row.finalAcceptanceRun = false; row.mode = 'boot-browser-trace-only';
        }
        console.log('A6API_MODELS_' + mode.toUpperCase() + ' ' + JSON.stringify({ run: row.run, ok: row.ok, url: fixture.receipt.url,
            screenshots: row.screenshots, errors: row.errors, finalAcceptanceRun: false }));
    } catch (error) {
        if (bundle) { bundle.row.ok = false; bundle.row.failure = error.message; }
        throw error;
    } finally {
        if (fixture && bundle) await closeBrowserFixture(fixture, bundle.context, bundle.row);
        else if (fixture) await stopFixture(fixture);
        await browser.close();
    }
}
// Owner-gated whole-flow suite: no final acceptance is invoked by --smoke/--trace.
function assertPreservation(state, initial, allowed = {}) {
    assert.equal(state.guardViolationCount, state.guards.length); assert.equal(state.guardViolationCount, 0);
    assert.deepEqual(withoutPicker(state.claude.config), withoutPicker(initial.claude.config), 'Claude current/env/agents/settings unchanged');
    assert.deepEqual(state.backends, initial.backends, 'active provider and registry unchanged');
    assert.deepEqual(state.hermes, initial.hermes, 'Hermes current/config unchanged');
    assert.deepEqual(state.native.modelMap, allowed.modelMap || initial.native.modelMap, 'whole native map including gpt preserved');
    assert.deepEqual(state.native.routesMap, initial.native.routesMap, 'independent Routes default/map/gpt preserved');
    assert.deepEqual(state.manifest.models[OTHER_ID], initial.manifest.models[OTHER_ID], 'unrelated manifest entry unchanged');
    for (let index = 0; index < state.opencode.length; index++) {
        const target = state.opencode[index];
        if (allowed.invalidTarget === index) { assert.equal(target.valid, false); continue; }
        assert.equal(target.valid, true);
        assert.deepEqual(withoutHubProvider(target.config), withoutHubProvider(initial.opencode[index].config),
            target.label + ': only abuse-hub block may change, not current/small/agent model or other provider');
    }
    assert.equal(state.requests.filter(row => /\/(?:activate|restart|switch|kill)(?:\/|$)/.test(row.pathname) || /\/(?:messages|responses|chat\/completions)(?:\/|$)/.test(row.pathname)).length, 0);
    assert.equal(state.native.calls.filter(row => ['activate', 'ensure', 'syncModel'].includes(row.action)).length, 0);
}
function assertProjection(state, sync = true) {
    const sorted = Object.entries(state.manifest.enabled ? state.manifest.models : {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const expectedPicker = { replaceBuiltInOptions: true, options: sorted.map(([id, metadata]) => ({
        model: id.includes('[') || metadata.contextTokens < 1000000 ? id : id + '[1m]',
        label: metadata.displayName, description: 'ABUSE HUB', behavesAs: metadata.claudeBehavesAs,
    })) };
    assert.deepEqual(state.claude.picker, expectedPicker, 'full exact Claude picker derived from durable manifest');
    if (!sync) return;
    assert.equal(state.opencode.length, 3);
    const expectedModels = Object.fromEntries(sorted.map(([id, metadata]) => [id, {
        name: metadata.displayName, limit: { context: metadata.contextTokens, output: metadata.outputTokens },
    }]));
    const options = { baseURL: 'http://127.0.0.1:20100/openai/v1', apiKey: 'dummy', timeout: 600000 };
    for (const target of state.opencode) {
        const expectedProvider = target.config.providers ? { package: 'aisdk:@ai-sdk/openai-compatible', name: 'ABUSE HUB', settings: options, models: expectedModels }
            : { npm: '@ai-sdk/openai-compatible', name: 'ABUSE HUB', options, models: expectedModels };
        assert.deepEqual(target.provider, expectedProvider, target.label + ': full native/legacy provider projection and exact limits');
        if (target.config.providers) assert.equal(target.config.provider?.['abuse-hub'], undefined, 'native schema must not get a duplicate legacy provider');
    }
}
async function assertDiscovery(receipt, manifest) {
    const response = await httpJson(receipt, '/openai/v1/models');
    assert.deepEqual(response.data.map(model => ({ id: model.id, context_length: model.context_length, max_output_tokens: model.max_output_tokens })),
        Object.entries(manifest.models).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, metadata]) => ({
            id, context_length: metadata.contextTokens, max_output_tokens: metadata.outputTokens,
        })), 'Hermes/OpenAI exact discovery and limits match entire manifest');
}
const a6Row = (page, id) => page.locator('#a6-publication-list [data-a6-model-id="' + id + '"]');
const a6Toggle = (page, id) => a6Row(page, id).locator('input[data-publication-id="' + id + '"]');
async function settled(page, id, checked, disabled = false) {
    await page.waitForFunction(({ id, checked, disabled }) => {
        const row = [...document.querySelectorAll('#a6-publication-list [data-a6-model-id]')].find(row => row.dataset.a6ModelId === id);
        const input = row?.querySelector('input[data-publication-id]');
        return input && input.checked === checked && input.disabled === disabled && input.getAttribute('aria-busy') === 'false';
    }, { id, checked, disabled });
}
async function reloadA6(page) {
    await page.locator('.nav-btn[data-tab="a6api"]').click();
    await page.locator('#a6-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#a6-refresh').disabled);
    await page.evaluate(() => window.MODEL_PUBLICATION.refresh(true));
}
async function browserPost(page, pathname, body, expected = 200) {
    const result = await page.evaluate(async ({ pathname, body }) => {
        const response = await fetch(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, dto: await response.json() };
    }, { pathname, body });
    assert.equal(result.status, expected, pathname + ': real HTTP status ' + JSON.stringify(result.dto));
    return result.dto;
}
async function publication(page, fixture, id, published) {
    const before = await httpJson(fixture.receipt, PREFIX + '/state');
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/__switch/api/api-gateway/publication') && response.request().method() === 'POST');
    await a6Toggle(page, id).click();
    const response = await responsePromise; assert.equal(response.status(), 200);
    const dto = await response.json(); assert.equal(dto.ok, true); assert.equal(dto.model.id, id); assert.equal(dto.model.published, published);
    await page.waitForFunction(({ id, published }) => {
        const input = [...document.querySelectorAll('#a6-publication-list input[data-publication-id]')].find(node => node.dataset.publicationId === id);
        return published ? input?.checked === true && input.getAttribute('aria-busy') === 'false'
            : !input || input.checked === false && input.getAttribute('aria-busy') === 'false';
    }, { id, published });
    const after = await httpJson(fixture.receipt, PREFIX + '/state');
    assert.equal(after.manifest.revision, before.manifest.revision + 1);
    assert.equal(Object.hasOwn(after.manifest.models, id), published);
    if (published && Object.hasOwn(before.manifest.models, id)) assert.deepEqual(after.manifest.models[id], before.manifest.models[id], 'retained publication metadata unchanged');
    return { before, after, dto };
}
async function snapshot(fixture, row, initial, label, options = {}) {
    const state = await httpJson(fixture.receipt, PREFIX + '/state');
    assertPreservation(state, initial, options); assertProjection(state, options.sync !== false);
    await assertDiscovery(fixture.receipt, state.manifest);
    row.snapshots.push({ label, state }); return state;
}
async function wholeFlow(browser, width, theme) {
    const fixture = await startFixture(); const { receipt } = fixture;
    let bundle;
    try {
        assert.equal(receipt.guardWired, true, 'final acceptance requires the actual backend a6api publication guard');
        bundle = await browserContext(browser, fixture, width, theme);
    } catch (error) { await stopFixture(fixture); throw error; }
    const { context, page, row } = bundle;
    const initial = readJson(receipt.initialPath);
    try {
        await openA6(page, receipt); await settled(page, MAIN_ID, true); await settled(page, NESTED_ID, false);
        assert.equal(await page.locator('#a6-compatibility').evaluate(node => node.open), false, 'native compatibility closed by default');
        assert.equal(await page.locator('#a6-model-opus,#a6-model-sonnet,#a6-model-haiku,#a6-cmd-tiers').count(), 0, 'no duplicated native tier editors');
        assert.equal(await page.locator('#a6-compatibility select').count(), 1, 'native default only');
        assert.equal(await a6Row(page, MAIN_ID).locator('[data-publication-chip]').count(), 1, 'real modelPublicationChip wrapper');
        const before = await snapshot(fixture, row, initial, 'initial');
        assert.deepEqual(before.manifest, initial.manifest); assert.equal(before.requests.filter(request => request.method === 'POST').length, 0);
        assert.equal(await page.locator('#a6-published-count').innerText(), 'В пикере: 1');
        await capture(page, row, 'initial-closed');
        await page.locator('#a6-key-note').scrollIntoViewIfNeeded(); await capture(page, row, 'initial-provider-key');
        await page.locator('#a6-model-search').scrollIntoViewIfNeeded();
        await page.locator('#a6-model-search').fill('custom deepseek');
        assert.deepEqual(await page.locator('#a6-publication-list [data-a6-model-id]').evaluateAll(nodes => nodes.map(n => n.dataset.a6ModelId)), [MAIN_ID]);
        await page.locator('#a6-model-search').fill('a6api/vendor/nested-model');
        assert.deepEqual(await page.locator('#a6-publication-list [data-a6-model-id]').evaluateAll(nodes => nodes.map(n => n.dataset.a6ModelId)), [NESTED_ID]);
        await page.locator('#a6-model-search').fill('no-such-exact-fixture-id');
        assert.equal(await page.locator('#a6-publication-list input').count(), 0); await capture(page, row, 'search-empty');
        await page.locator('#a6-model-search').fill('');
        for (const id of [MAIN_ID, NESTED_ID]) {
            await a6Row(page, id).locator('[data-a6="copy-cmd"]').filter({ hasText: /^ID$/ }).click();
            await a6Row(page, id).locator('[data-a6="copy-cmd"]').filter({ hasText: /^\/model$/ }).click();
        }
        assert.deepEqual(await page.evaluate(() => window.__a6Copied), [MAIN_ID, '/model ' + MAIN_ID, NESTED_ID, '/model ' + NESTED_ID],
            'exact ID vs command, unlisted/non1M models never claim [1m]');
        assert.deepEqual((await snapshot(fixture, row, initial, 'copied-searched')).manifest, initial.manifest, 'copy/search do not publish');
        const enabled = await publication(page, fixture, NESTED_ID, true); assert.equal(enabled.dto.opencode.ok, true);
        assert.equal(enabled.after.manifest.models[NESTED_ID].contextTokens, 1000000); assert.equal(enabled.after.manifest.models[NESTED_ID].outputTokens, 32000);
        assert.equal(enabled.after.manifest.models[NESTED_ID].claudeBehavesAs, 'claude-opus-5');
        assert.deepEqual(enabled.after.manifest.models[MAIN_ID], initial.manifest.models[MAIN_ID], 'existing custom label/context/output/publishedAt preserved');
        await snapshot(fixture, row, initial, 'nested-published'); await capture(page, row, 'nested-published');
        await a6Row(page, NESTED_ID).locator('[data-a6="copy-cmd"]').filter({ hasText: /^\/model$/ }).click();
        assert.equal((await page.evaluate(() => window.__a6Copied)).at(-1), '/model ' + NESTED_ID + '[1m]');
        await page.locator('[data-a6="gateway"]').click();
        await page.locator('#api-gateway-root input[data-publication-id="' + NESTED_ID + '"]').waitFor();
        assert.equal(await page.locator('#api-gateway-root input[data-publication-id="' + NESTED_ID + '"]').isChecked(), true);
        await page.locator('.nav-btn[data-tab="a6api"]').click(); await page.reload({ waitUntil: 'load' });
        await page.locator('.nav-btn[data-tab="a6api"]').click(); await settled(page, NESTED_ID, true);
        await snapshot(fixture, row, initial, 'f5-return'); await capture(page, row, 'f5-return');
        await publication(page, fixture, NESTED_ID, false); await snapshot(fixture, row, initial, 'nested-hidden');
        await publication(page, fixture, MAIN_ID, false); await snapshot(fixture, row, initial, 'main-hidden');
        assert.equal((await httpJson(receipt, PREFIX + '/state')).manifest.models[MAIN_ID], undefined);
        await publication(page, fixture, MAIN_ID, true); await snapshot(fixture, row, initial, 'main-readded-defaults');
        // Choosing candidate10 reads its permitted catalog, never reveals/applies a key.
        const candidateBefore = await httpJson(receipt, PREFIX + '/state');
        await page.locator('#a6-token').selectOption('10');
        await page.waitForFunction(() => document.querySelector('#a6-publication-list [data-a6-model-id="a6api/other-only"] input')?.disabled === true);
        const candidateAfter = await snapshot(fixture, row, initial, 'candidate-own-catalog');
        assert.equal(candidateAfter.native.selection.selectedTokenId, 9);
        assert.equal(candidateAfter.apiRequests.filter(call => call.action === 'reveal').length, candidateBefore.apiRequests.filter(call => call.action === 'reveal').length);
        assert.deepEqual(candidateAfter.manifest, candidateBefore.manifest);
        const candidateOwn = await httpJson(receipt, '/__switch/api/a6api/models?tokenId=10'); assert.deepEqual(candidateOwn.models, ['other-only']);
        await capture(page, row, 'candidate-key10-not-prepared');
        page.once('dialog', dialog => dialog.dismiss()); await page.locator('#a6-use-key').click();
        assert.equal((await httpJson(receipt, PREFIX + '/state')).native.selection.selectedTokenId, 9, 'cancel confirmation must leave prepared key unchanged');
        page.once('dialog', dialog => dialog.accept());
        const keyResponse = page.waitForResponse(response => response.url().endsWith('/__switch/api/a6api/key') && response.request().method() === 'POST');
        await page.locator('#a6-use-key').click(); assert.equal((await keyResponse).status(), 200);
        await page.waitForFunction(() => document.querySelector('#a6-use-key')?.disabled && document.querySelector('#a6-connection')?.textContent === 'Ключ подготовлен');
        await settled(page, MAIN_ID, true); await settled(page, 'a6api/other-only', false);
        const changed = await snapshot(fixture, row, initial, 'key10-confirmed'); assert.equal(changed.native.selection.selectedTokenId, 10);
        await capture(page, row, 'prepared-key10-restrictions');
        assert.deepEqual(changed.manifest, candidateAfter.manifest, 'key change never cleans publications');
        const denied = await browserPost(page, '/__switch/api/api-gateway/publication', { expectedRevision: changed.manifest.revision, id: NESTED_ID, published: true }, 409);
        assert.equal(denied.code, 'a6api_model_unavailable');
        assert.deepEqual((await snapshot(fixture, row, initial, 'selected-key-restriction')).manifest, changed.manifest);
        await publication(page, fixture, 'a6api/other-only', true); await publication(page, fixture, 'a6api/other-only', false);
        await page.locator('#a6-token').selectOption('9'); await settled(page, NESTED_ID, false, true);
        page.once('dialog', dialog => dialog.accept()); await page.locator('#a6-use-key').click(); await settled(page, NESTED_ID, false);
        // Required backend/UI unavailable states: publications remain inspectable and removable.
        for (const [label, control] of [
            ['disabled-key', { token9: 'disabled' }], ['expired-key', { token9: 'expired' }], ['missing-key-file', { key: 'missing' }], ['missing-selected-token', { token9: 'missing' }],
            ['catalog-empty', { catalog: 'empty' }], ['catalog-failed', { catalog: 'failed' }], ['account-disconnected', { account: 'disconnected' }],
        ]) {
            await browserPost(page, PREFIX + '/control', control); await reloadA6(page);
            await settled(page, MAIN_ID, true); // removal remains enabled even with unavailable selected key.
            const unavailable = await snapshot(fixture, row, initial, label + '-visible');
            assert.ok(await a6Row(page, MAIN_ID).locator('.a6-model-unavailable').count());
            await capture(page, row, label);
            const rejected = await page.evaluate(async ({ revision, id }) => {
                const response = await fetch('/__switch/api/api-gateway/publication', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ expectedRevision: revision, id, published: true }) });
                return { status: response.status, data: await response.json() };
            }, { revision: unavailable.manifest.revision, id: NESTED_ID });
            assert.ok(rejected.status >= 400, label + ': enable denied by actual guard');
            assert.deepEqual((await httpJson(receipt, PREFIX + '/state')).manifest, unavailable.manifest);
            await publication(page, fixture, MAIN_ID, false); await snapshot(fixture, row, initial, label + '-removal');
            await browserPost(page, PREFIX + '/control', { token9: 'ready', catalog: 'normal', account: 'ready' });
            await browserPost(page, '/__switch/api/a6api/key', { tokenId: 9 }); await reloadA6(page);
            await page.locator('#a6-token').selectOption('9');
            await settled(page, MAIN_ID, false); await publication(page, fixture, MAIN_ID, true);
        }
        // Native compatibility edits only default; Routes owns all tier inputs.
        await page.locator('#a6-compatibility > summary').click();
        await page.locator('[data-a6="routes"]').click(); await page.locator('#routes-row-a6api').waitFor();
        const maps = await httpJson(receipt, '/__switch/api/routes');
        const native = maps.providers.find(provider => provider.name === 'a6api');
        assert.deepEqual(native.tiers, initial.native.routesMap); assert.deepEqual(native.gatewayTiers, initial.native.modelMap);
        assert.equal(await page.locator('#routes-row-a6api select[data-tier="default"]').getAttribute('data-prev'), initial.native.routesMap.default);
        assert.equal(await page.locator('#routes-row-a6api select[data-tier="opus"]').getAttribute('data-prev'), initial.native.routesMap.opus);
        await capture(page, row, 'routes-native-map');
        await page.locator('.nav-btn[data-tab="a6api"]').click();
        if (!(await page.locator('#a6-compatibility').evaluate(node => node.open))) await page.locator('#a6-compatibility > summary').click();
        const nativeBefore = await httpJson(receipt, PREFIX + '/state');
        await page.locator('#a6-model-default').selectOption('vendor/nested-model');
        assert.deepEqual((await httpJson(receipt, PREFIX + '/state')).native.modelMap, nativeBefore.native.modelMap, 'default select is draft only');
        const defaultResponse = page.waitForResponse(response => response.url().endsWith('/__switch/api/a6api/modelmap') && response.request().method() === 'POST');
        await page.locator('#a6-save').click(); assert.equal((await defaultResponse).status(), 200);
        await page.waitForFunction(() => document.querySelector('#a6-save').disabled && document.querySelector('#a6-error').hidden);
        const expectedMap = { ...initial.native.modelMap, default: 'vendor/nested-model' };
        const nativeAfter = await snapshot(fixture, row, initial, 'native-default-only', { modelMap: expectedMap });
        await capture(page, row, 'native-default-only');
        assert.deepEqual(nativeAfter.manifest, nativeBefore.manifest);
        const defaultWrite = nativeAfter.requests.filter(request => request.pathname === '/__switch/api/a6api/modelmap' && request.method === 'POST').at(-1);
        assert.deepEqual(defaultWrite.body, { tokenId: 9, modelMap: { default: 'vendor/nested-model' } });
        await page.locator('#a6-compatibility > summary').click();
        // Advanced metadata is one manifest; draft survives refresh, original revision remains locked.
        await page.locator('[data-a6="gateway"]').click();
        const metadata = () => page.locator('.ag-model[data-model-id="' + MAIN_ID + '"]');
        await metadata().locator('.ag-edit').click();
        await metadata().locator('[data-field="displayName"]').fill('Owner metadata fixture label');
        await metadata().locator('[data-field="contextTokens"]').fill('222222');
        await page.evaluate(() => window.MODEL_PUBLICATION.refresh(true));
        assert.equal(await metadata().locator('[data-field="displayName"]').inputValue(), 'Owner metadata fixture label');
        const publicationAt = nativeAfter.manifest.models[MAIN_ID].publishedAt;
        await metadata().locator('.ag-save').click();
        await page.waitForFunction(id => document.querySelector('.ag-model[data-model-id="' + id + '"] .ag-row-message')?.dataset.kind === 'ok', MAIN_ID);
        await page.waitForFunction(async () => (await (await fetch('/__switch/api/api-gateway/clients')).json()).opencode?.status === 'synced');
        const edited = await snapshot(fixture, row, initial, 'metadata-edited', { modelMap: expectedMap });
        assert.equal(edited.manifest.models[MAIN_ID].displayName, 'Owner metadata fixture label');
        assert.equal(edited.manifest.models[MAIN_ID].contextTokens, 222222); assert.equal(edited.manifest.models[MAIN_ID].publishedAt, publicationAt);
        await metadata().locator('[data-field="displayName"]').fill('Unsaved fixture draft');
        const concurrent = await browserPost(page, '/__switch/api/api-gateway/publication', { expectedRevision: edited.manifest.revision, id: NESTED_ID, published: true });
        assert.equal(concurrent.opencode.ok, true); await page.evaluate(() => window.MODEL_PUBLICATION.refresh(true));
        assert.equal(await metadata().locator('[data-field="displayName"]').inputValue(), 'Unsaved fixture draft');
        const staleResponse = page.waitForResponse(response => response.url().endsWith('/__switch/api/api-gateway/model') && response.request().method() === 'POST');
        await metadata().locator('.ag-save').click(); assert.equal((await staleResponse).status(), 409);
        await page.waitForFunction(id => document.querySelector('.ag-model[data-model-id="' + id + '"] .ag-row-message')?.dataset.kind === 'error', MAIN_ID);
        const conflicted = await snapshot(fixture, row, initial, 'metadata-409-draft', { modelMap: expectedMap });
        assert.equal(conflicted.manifest.models[MAIN_ID].displayName, 'Owner metadata fixture label');
        assert.equal(conflicted.manifest.revision, concurrent.manifest.revision);
        await capture(page, row, 'metadata-conflict');
        await metadata().locator('.ag-edit').click(); await page.locator('.nav-btn[data-tab="a6api"]').click(); await settled(page, NESTED_ID, true);
        await publication(page, fixture, NESTED_ID, false);
        // Delay forwarding one genuine request so a real second writer wins its
        // expected revision; never fulfil a synthetic409 or alter the body.
        let arrived, resume;
        const arrivedPromise = new Promise(resolve => { arrived = resolve; });
        const resumePromise = new Promise(resolve => { resume = resolve; });
        const racingPath = '**/__switch/api/api-gateway/publication';
        const racingRoute = async route => { arrived(route.request().postDataJSON()); await resumePromise; await route.continue(); };
        await page.route(racingPath, racingRoute);
        const raceResponse = page.waitForResponse(response => response.url().endsWith('/__switch/api/api-gateway/publication') && response.request().method() === 'POST');
        try {
            await a6Toggle(page, NESTED_ID).click();
            const outgoing = await Promise.race([arrivedPromise, pause(10000).then(() => { throw new Error('actual publication race did not arrive'); })]);
            const winner = await httpJson(receipt, '/__switch/api/api-gateway/publication', { expectedRevision: outgoing.expectedRevision,
                id: 'a6api/deepseek-v4-pro', published: true });
            assert.equal(winner.opencode.ok, true);
            resume(); assert.equal((await raceResponse).status(), 409);
        } finally { resume(); await page.unroute(racingPath, racingRoute); }
        await settled(page, NESTED_ID, false);
        assert.equal(await a6Row(page, NESTED_ID).locator('.mp-message').getAttribute('data-kind'), 'error');
        const primaryConflict = await snapshot(fixture, row, initial, 'publication-real-409', { modelMap: expectedMap });
        assert.equal(Object.hasOwn(primaryConflict.manifest.models, NESTED_ID), false);
        assert.equal(Object.hasOwn(primaryConflict.manifest.models, 'a6api/deepseek-v4-pro'), true);
        await capture(page, row, 'publication-conflict');
        await publication(page, fixture, NESTED_ID, true); await publication(page, fixture, NESTED_ID, false);
        await publication(page, fixture, 'a6api/deepseek-v4-pro', false);
        // Real invalid OpenCode target: manifest/Claude commit, partial Sync warning, native retry/readback.
        await browserPost(page, PREFIX + '/control', { sync: 'invalid-target' });
        const partial = await publication(page, fixture, NESTED_ID, true); assert.equal(partial.dto.opencode.ok, false);
        await a6Row(page, NESTED_ID).locator('button[data-publication-retry]').waitFor();
        await snapshot(fixture, row, initial, 'real-sync-failed', { modelMap: expectedMap, invalidTarget: 1, sync: false });
        await capture(page, row, 'sync-failed');
        await browserPost(page, PREFIX + '/control', { sync: 'restore-target' });
        const retryResponse = page.waitForResponse(response => response.url().endsWith('/__switch/api/api-gateway/opencode/sync') && response.request().method() === 'POST');
        await a6Row(page, NESTED_ID).locator('button[data-publication-retry]').click(); assert.equal((await retryResponse).status(), 200);
        await settled(page, NESTED_ID, true);
        const synced = await snapshot(fixture, row, initial, 'sync-recovered', { modelMap: expectedMap });
        assert.equal(synced.manifest.revision, partial.after.manifest.revision, 'Sync retry must not republish');
        await publication(page, fixture, NESTED_ID, false);
        // Real durable writer EIO: transaction fails/rolls back, then switch can retry.
        const failureBefore = await httpJson(receipt, PREFIX + '/state');
        await browserPost(page, PREFIX + '/control', { failNextManifestWrite: true });
        const failureResponse = page.waitForResponse(response => response.url().endsWith('/__switch/api/api-gateway/publication') && response.request().method() === 'POST');
        await a6Toggle(page, NESTED_ID).click(); assert.ok((await failureResponse).status() >= 400);
        await settled(page, NESTED_ID, false);
        const failed = await snapshot(fixture, row, initial, 'manifest-write-failed', { modelMap: expectedMap });
        assert.deepEqual(failed.manifest, failureBefore.manifest); assert.equal(failed.faults.at(-1).code, 'EIO');
        assert.equal(await a6Row(page, NESTED_ID).locator('.mp-message').getAttribute('data-kind'), 'error');
        await capture(page, row, 'write-failed'); await publication(page, fixture, NESTED_ID, true);
        await snapshot(fixture, row, initial, 'write-retry-recovered', { modelMap: expectedMap }); await publication(page, fixture, NESTED_ID, false);
        // Corrupt local manifest GET cannot claim last cached rows are confirmed.
        const readable = await httpJson(receipt, PREFIX + '/state');
        await browserPost(page, PREFIX + '/control', { manifest: 'corrupt' }); await reloadA6(page);
        await page.waitForFunction(() => document.querySelector('#a6-published-count')?.textContent === 'Публикации не прочитаны');
        assert.equal(await a6Toggle(page, MAIN_ID).isDisabled(), true);
        assert.equal(await a6Row(page, MAIN_ID).locator('.a6-model-state').innerText(), 'Статус не проверен');
        await capture(page, row, 'manifest-read-unconfirmed');
        await browserPost(page, PREFIX + '/control', { manifest: 'restore' }); await reloadA6(page); await settled(page, MAIN_ID, true);
        assert.deepEqual((await snapshot(fixture, row, initial, 'manifest-read-restored', { modelMap: expectedMap })).manifest, readable.manifest);
        // Readonly is generated by production Host guards and proves actual403/no commit.
        await browserPost(page, PREFIX + '/control', { readonly: true }); await reloadA6(page); await settled(page, MAIN_ID, true, true);
        await page.locator('#a6-model-search').fill('deepseek'); assert.ok(await a6Row(page, MAIN_ID).count());
        const readonly = await snapshot(fixture, row, initial, 'readonly-inspection', { modelMap: expectedMap });
        await browserPost(page, '/__switch/api/api-gateway/publication', { expectedRevision: readonly.manifest.revision, id: MAIN_ID, published: false }, 403);
        await browserPost(page, '/__switch/api/a6api/key', { tokenId: 10 }, 403);
        assert.deepEqual((await httpJson(receipt, PREFIX + '/state')).manifest, readonly.manifest);
        await capture(page, row, 'readonly');
        await browserPost(page, PREFIX + '/control', { readonly: false }); await page.locator('#a6-model-search').fill(''); await reloadA6(page);
        // Long catalog pagination/search and empty unconfigured panel remain whole-flow states.
        await browserPost(page, PREFIX + '/control', { catalog: 'long' }); await reloadA6(page);
        assert.equal(await page.locator('#a6-publication-list [data-a6-model-id]').count(), 18);
        await page.locator('#a6-model-more').click(); assert.equal(await page.locator('#a6-publication-list [data-a6-model-id]').count(), 36);
        const longId = 'a6api/fixture-family/' + 'long-exact-model-'.repeat(8) + 'end';
        await page.locator('#a6-model-search').fill(longId);
        assert.deepEqual(await page.locator('#a6-publication-list [data-a6-model-id]').evaluateAll(nodes => nodes.map(node => node.dataset.a6ModelId)), [longId]);
        await capture(page, row, 'long-catalog-id'); await page.locator('#a6-model-search').fill('');
        await browserPost(page, PREFIX + '/control', { account: 'missing', catalog: 'empty' }); await reloadA6(page); await settled(page, MAIN_ID, true);
        await page.locator('#a6-connect-panel').waitFor(); assert.equal(await page.locator('#a6-panel-token').inputValue(), '');
        await capture(page, row, 'empty-unconfigured-retained');
        await publication(page, fixture, MAIN_ID, false); await snapshot(fixture, row, initial, 'final-empty', { modelMap: expectedMap });
        await capture(page, row, 'final-empty');
        assert.deepEqual(row.errors, [], 'no unhandled JS errors through the whole client flow');
        assert.equal(row.blocked.filter(row => row.forbidden).length, 0, 'no activation/inference attempt');
        assert.equal(fixture.errors(), ''); row.ok = true; row.finalAcceptanceRun = true;
    } catch (error) {
        row.ok = false; row.failure = error.stack;
        await capture(page, row, 'failure').catch(() => {}); throw Object.assign(error, { evidence: row });
    } finally {
        const observed = await httpJson(receipt, PREFIX + '/state').catch(() => null);
        if (observed?.manifest) fs.writeFileSync(path.join(row.run, 'observed-manifest.json'), JSON.stringify(observed.manifest, null, 2) + '\n');
        await closeBrowserFixture(fixture, context, row);
    }
    return row;
}
async function finalAcceptance(options = {}) {
    assert.equal(options.visualApproved, true, 'final suite is forbidden without explicit owner visual go');
    const { chromium } = require('playwright');
    const results = [], browser = await chromium.launch({ headless: true });
    const matrix = [1440, 390].flatMap(width => (options.daylight ? ['zen', 'daylight'] : ['zen']).map(theme => ({ width, theme })));
    try {
        for (const { width, theme } of matrix) {
            try { const row = await wholeFlow(browser, width, theme); results.push(row); console.log('PASS a6api real HTTP whole-flow ' + width + ' ' + theme); }
            catch (error) { results.push(error.evidence || { width, theme, ok: false, failure: error.stack }); console.error('FAIL a6api real HTTP whole-flow ' + width + ' ' + theme + '\n' + error.stack); }
        }
    } finally { await browser.close(); }
    assert.equal(results.length, matrix.length);
    const finalReadbacks = results.map(row => row.run && fs.existsSync(path.join(row.run, 'final.json'))
        ? readJson(path.join(row.run, 'final.json')) : null);
    const guardReadbacksComplete = finalReadbacks.every(value => value && Array.isArray(value.guards)
        && value.guardViolationCount === value.guards.length);
    const aggregate = { ok: results.length === matrix.length && results.every(row => row.ok && row.listenerClosed),
        passed: results.filter(row => row.ok && row.listenerClosed).length, failed: results.filter(row => !row.ok || !row.listenerClosed).length,
        results: results.map(row => ({ width: row.width, theme: row.theme, ok: row.ok, run: row.run, listenerClosed: row.listenerClosed,
            failure: row.failure || null, screenshots: row.screenshots || [] })),
        guardReadbacksComplete,
        guardViolationCount: guardReadbacksComplete ? finalReadbacks.reduce((count, value) => count + value.guardViolationCount, 0) : null,
        visualApprovalSupplied: true, scope: 'explicit panel fixtures; REAL whole dashboard native/publication HTTP+durable manifest/Claude/3OpenCode/discovery',
        paidProbes: 0, productionWrites: false };
    const directory = results.find(row => row.run)?.run;
    if (directory) fs.writeFileSync(path.join(directory, 'suite-receipt.json'), JSON.stringify(aggregate, null, 2) + '\n');
    console.log('A6API_MODELS_HTTP_UI ' + JSON.stringify(aggregate));
    process.exitCode = aggregate.ok && aggregate.guardViolationCount === 0 ? 0 : 1;
    return aggregate;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log('node tools/check-a6api-models-http-ui.js --smoke\n--trace [--mobile]: read-only whole-dashboard boot trace/screenshots\n--red: one native-default tracer criterion (not final acceptance)\nFinal acceptance is owner-gated: --accept --visual-approved [--daylight]'); return;
    }
    if (args.includes('--accept')) {
        assert.ok(args.every(arg => ['--accept', '--visual-approved', '--daylight'].includes(arg)), 'unknown acceptance option');
        assert.ok(args.includes('--visual-approved'), 'parent must supply owner visual go before final acceptance');
        return finalAcceptance({ visualApproved: true, daylight: args.includes('--daylight') });
    }
    if (args.includes('--trace')) {
        assert.ok(args.every(arg => ['--trace', '--mobile'].includes(arg)), 'unknown boot trace option');
        return redOrTrace('trace', { mobile: args.includes('--mobile') });
    }
    if (args.length === 1 && args[0] === '--red') return redOrTrace('red');
    assert.ok(args.length === 0 || args.length === 1 && args[0] === '--smoke', 'final acceptance requires --accept --visual-approved');
    await smoke();
}
module.exports = { startFixture, stopFixture, httpJson, smoke, readJson, within, assertPreservation, assertProjection, finalAcceptance, MAIN_ID, NESTED_ID, OTHER_ID };
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
