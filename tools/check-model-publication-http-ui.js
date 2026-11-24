#!/usr/bin/env node
'use strict';
// Whole-flow browser acceptance uses the real publication HTTP dispatcher,
// manifest/Claude transaction and OpenCode Sync in an isolated child preview.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const scratch = process.env.HERMES_TEST_SCRATCH || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch')
    : path.join(os.homedir(), '.cache/hermes/scratch'));
fs.mkdirSync(scratch, { recursive: true });
const evidence = fs.mkdtempSync(path.join(scratch, 'publication-http-ui-'));
const results = [];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
const withoutPicker = value => {
    const copy = structuredClone(value); delete copy.modelPicker; return copy;
};
async function startFixture() {
    const child = spawn(process.execPath, [path.join(root, 'tools/model-publication-preview.js')], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, PUBLICATION_PREVIEW_PORT: '0' },
    });
    let text = '', errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const receipt = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('preview boot deadline: ' + errors)), 10000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error('preview exited before ready: ' + code + ' ' + errors)); });
        child.stdout.on('data', chunk => {
            text += chunk;
            const line = text.split(/\r?\n/).find(value => value.startsWith('PUBLICATION_PREVIEW '));
            if (!line) return;
            try { const result = JSON.parse(line.slice('PUBLICATION_PREVIEW '.length)); clearTimeout(timer); resolve(result); }
            catch { /* a complete line has not arrived yet */ }
        });
    }).catch(async error => { child.kill(); throw error; });
    assert.equal(receipt.pid, child.pid, 'the readiness receipt must identify the child we launched');
    assert.ok(path.resolve(receipt.run).startsWith(path.resolve(scratch) + path.sep));
    const ready = await fetch(receipt.url + '/__publication-preview/ready').then(response => response.json());
    assert.equal(ready.scope, 'isolated-model-publication');
    return { child, receipt, errors: () => errors };
}
async function stopFixture(fixture) {
    const { child, receipt } = fixture;
    if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await assert.rejects(fetch(receipt.url + '/__publication-preview/ready', { signal: AbortSignal.timeout(1000) }),
        'the exact fixture listener must close');
}
async function scenario(browser, width) {
    const fixture = await startFixture();
    const { receipt } = fixture;
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const row = { width, ok: false, url: receipt.url, run: receipt.run, errors: [], blocked: [], snapshots: [] };
    results.push(row);
    const settingsBefore = read(receipt.paths.settingsPath);
    const backendsBefore = read(receipt.paths.backendsPath);
    const codeBefore = receipt.targets.map(target => read(target.path));
    await context.addInitScript(() => {
        localStorage.setItem('opencode_active_tab', 'agentrouter');
        window.__copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: async text => window.__copied.push(text) } });
    });
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === receipt.url) return route.continue();
        row.blocked.push(url.origin); return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => row.errors.push(error.message));
    const id = 'agentrouter/gpt-6.1-sol';
    const toggle = () => page.locator('#ar-models-list input[data-publication-id="' + id + '"]');
    const settled = async wanted => {
        await page.waitForFunction(([id, wanted]) => {
            const input = document.querySelector('#ar-models-list input[data-publication-id="' + id + '"]');
            return input && !input.disabled && input.checked === wanted;
        }, [id, wanted]);
    };
    const snapshot = async label => {
        const state = await fetch(receipt.url + '/__publication-preview/state').then(response => response.json());
        assert.deepEqual(state.guards, [], 'preview has no external writes or outbound sockets');
        assert.equal(state.requests.filter(request => request.pathname.endsWith('/set-model') || request.pathname.endsWith('/activate')).length, 0);
        assert.deepEqual(withoutPicker(read(receipt.paths.settingsPath)), withoutPicker(settingsBefore));
        assert.deepEqual(read(receipt.paths.backendsPath), backendsBefore);
        for (const [index, target] of receipt.targets.entries()) {
            const current = read(target.path), original = structuredClone(codeBefore[index]);
            const field = current.providers ? 'providers' : 'provider';
            delete current[field]['abuse-hub']; delete original[field]['abuse-hub'];
            assert.deepEqual(current, original, 'all unrelated OpenCode config and current models are preserved');
        }
        row.snapshots.push({ label, ...state });
        return state;
    };
    try {
        await page.goto(receipt.url, { waitUntil: 'load' });
        await page.locator('.nav-btn[data-tab="agentrouter"]').click();
        await settled(false);
        await page.locator('#ar-models').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, 'before-' + width + '.png') });
        const before = await snapshot('before');
        await toggle().click(); await settled(true);
        const published = await snapshot('published');
        assert.ok(Object.hasOwn(published.manifest.models, id));
        assert.equal(published.manifest.revision, before.manifest.revision + 1);
        assert.ok(published.claude.picker.options.some(option => option.model === id + '[1m]'));
        assert.ok(published.opencode.every(target => target.models.includes(id)));
        const discovery = await fetch(receipt.url + '/openai/v1/models').then(response => response.json());
        assert.ok(discovery.data.some(model => model.id === id && model.context_length === 1000000 && model.max_output_tokens === 32000));
        const chip = page.locator('#ar-models-list [data-publication-chip="' + id + '"]');
        await chip.locator('button[title^="Копировать"]').click();
        assert.deepEqual(await page.evaluate(() => window.__copied), ['/model ' + id + '[1m]']);
        await page.locator('.nav-btn[data-tab="api-gateway"]').click();
        const gatewayToggle = page.locator('#api-gateway-root input[data-publication-id="' + id + '"]');
        await gatewayToggle.waitFor(); assert.equal(await gatewayToggle.isChecked(), true);
        await page.locator('.nav-btn[data-tab="agentrouter"]').click();
        await page.reload({ waitUntil: 'load' });
        await page.locator('.nav-btn[data-tab="agentrouter"]').click();
        await settled(true);
        await page.locator('#ar-models').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, 'published-' + width + '.png') });
        await toggle().click(); await settled(false);
        const hidden = await snapshot('hidden');
        assert.equal(Object.hasOwn(hidden.manifest.models, id), false);
        assert.equal(hidden.manifest.revision, published.manifest.revision + 1);
        assert.ok(hidden.opencode.every(target => !target.models.includes(id)));
        assert.ok(hidden.claude.picker.options.every(option => option.model !== id + '[1m]'));
        const hiddenDiscovery = await fetch(receipt.url + '/openai/v1/models').then(response => response.json());
        assert.equal(hiddenDiscovery.data.some(model => model.id === id), false);
        assert.deepEqual(hidden.manifest.models['agentrouter/gpt-5.6-sol'], before.manifest.models['agentrouter/gpt-5.6-sol']);
        await page.locator('.nav-btn[data-tab="api-gateway"]').click();
        const metadataRow = page.locator('.ag-model[data-model-id="agentrouter/gpt-5.6-sol"]');
        await metadataRow.locator('.ag-edit').click();
        await metadataRow.locator('[data-field="displayName"]').fill('Owner fixture custom name');
        await page.evaluate(() => window.MODEL_PUBLICATION.refresh(true));
        assert.equal(await metadataRow.locator('[data-field="displayName"]').inputValue(), 'Owner fixture custom name',
            'publication refresh must preserve an open metadata draft');
        await metadataRow.locator('.ag-save').click();
        await page.waitForFunction(() => document.querySelector('.ag-model[data-model-id="agentrouter/gpt-5.6-sol"] .ag-row-message')?.textContent === 'Сохранено');
        await page.waitForFunction(async () => (await (await fetch('/__switch/api/api-gateway/clients')).json()).opencode?.status === 'synced');
        const edited = await snapshot('metadata-edited');
        assert.equal(edited.manifest.models['agentrouter/gpt-5.6-sol'].displayName, 'Owner fixture custom name');
        assert.equal(edited.manifest.models['agentrouter/gpt-5.6-sol'].contextTokens, before.manifest.models['agentrouter/gpt-5.6-sol'].contextTokens);
        assert.equal(edited.manifest.models['agentrouter/gpt-5.6-sol'].publishedAt, before.manifest.models['agentrouter/gpt-5.6-sol'].publishedAt);
        assert.equal(edited.manifest.revision, hidden.manifest.revision + 1);
        await metadataRow.locator('[data-field="displayName"]').fill('Unsaved owner draft');
        const concurrent = await page.evaluate(async id => {
            const state = await (await fetch('/__switch/api/api-gateway')).json();
            const result = await (await fetch('/__switch/api/api-gateway/publication', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expectedRevision: state.manifest.revision, id, published: true }),
            })).json();
            await window.MODEL_PUBLICATION.refresh(true);
            return result;
        }, id);
        assert.equal(concurrent.opencode.ok, true);
        assert.equal(await metadataRow.locator('[data-field="displayName"]').inputValue(), 'Unsaved owner draft');
        await metadataRow.locator('.ag-save').click();
        await page.waitForFunction(() => document.querySelector('.ag-model[data-model-id="agentrouter/gpt-5.6-sol"] .ag-row-message')?.dataset.kind === 'error');
        const conflicted = await snapshot('metadata-conflict');
        assert.equal(conflicted.manifest.revision, concurrent.manifest.revision);
        assert.equal(conflicted.manifest.models['agentrouter/gpt-5.6-sol'].displayName, 'Owner fixture custom name',
            'a stale metadata save cannot overwrite a concurrent publication');
        assert.ok(Object.hasOwn(conflicted.manifest.models, id));
        await metadataRow.locator('.ag-edit').click();
        await page.locator('.nav-btn[data-tab="agentrouter"]').click();
        await settled(true);
        await toggle().click(); await settled(false);
        await snapshot('final-hidden');
        await page.waitForFunction(() => document.querySelectorAll('#toasts > *').length === 0, null, { timeout: 25000 });
        await page.locator('#ar-models').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, 'after-' + width + '.png') });
        assert.deepEqual(row.errors, []);
        assert.equal(fixture.errors(), '');
        row.ok = true;
    } finally {
        await context.close(); await stopFixture(fixture); row.listenerClosed = true;
    }
}
(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const width of [1440, 390]) {
            try { await scenario(browser, width); console.log('PASS real HTTP + picker UI width=' + width); }
            catch (error) { console.error('FAIL real HTTP + picker UI width=' + width + '\n' + error.stack); }
        }
    } finally {
        await browser.close();
        fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({
            ok: results.length === 2 && results.every(row => row.ok && row.listenerClosed), results,
            scope: 'real publication/Claude/OpenCode filesystem+HTTP; provider account/catalog fixture only',
        }, null, 2) + '\n');
    }
    console.log('HTTP_UI_EVIDENCE ' + evidence);
    process.exitCode = results.length === 2 && results.every(row => row.ok && row.listenerClosed) ? 0 : 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
