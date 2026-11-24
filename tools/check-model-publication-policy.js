#!/usr/bin/env node
'use strict';
// Real shared publication renderer; the manifest endpoint is an explicit fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

test('a provider enable prerequisite never traps an already published removal switch', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const state = { ok: true, canWrite: true, providers: ['a6api'], manifest: { revision: 7 }, models: [
            { id: 'a6api/existing', published: true },
        ] };
        await page.setContent('<span data-publication-slot="a6api/new" data-publication-blocked="Сначала используйте ключ"></span><span data-publication-slot="a6api/existing" data-publication-blocked="Ключ истёк"></span>');
        await page.evaluate(data => {
            window.__requests = [];
            window.fetch = async (url, options) => {
                window.__requests.push({ url, method: options?.method || 'GET' });
                return { ok: true, status: 200, json: async () => data };
            };
        }, state);
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'routing/vendor/model-publication.js'), 'utf8') });
        await page.waitForFunction(() => document.querySelector('input[data-publication-id="a6api/existing"]')?.checked);
        const newModel = page.locator('input[data-publication-id="a6api/new"]');
        const existing = page.locator('input[data-publication-id="a6api/existing"]');
        assert.equal(await newModel.isDisabled(), true, 'unprepared key blocks new publication');
        assert.match(await newModel.locator('..').getAttribute('title'), /Сначала используйте ключ/);
        assert.equal(await existing.isDisabled(), false, 'expired key does not block hiding a published model');
        await page.evaluate(() => window.MODEL_PUBLICATION.change('a6api/new', true));
        assert.equal((await page.evaluate(() => window.__requests)).some(request => request.method === 'POST'), false, 'programmatic change cannot bypass the visible provider prerequisite');
        await page.locator('[data-publication-slot="a6api/new"]').evaluate(slot => { slot.dataset.publicationBlocked = ''; });
        await page.evaluate(() => window.MODEL_PUBLICATION.enhance());
        assert.equal(await newModel.isDisabled(), false, 'preparing the key re-enables publication');
    } finally { await browser.close(); }
});

test('a candidate key prerequisite is local to its provider control, not the Gateway list', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<span id="provider" data-publication-slot="a6api/new" data-publication-blocked="Сначала используйте другой ключ"></span><span id="gateway" data-publication-slot="a6api/new"></span>');
        await page.evaluate(() => {
            window.__writes = 0; window.toast = () => {};
            window.fetch = async (url, options) => {
                if (options?.method === 'POST') window.__writes++;
                return { ok: true, status: 200, json: async () => ({ ok: true, canWrite: true, providers: ['a6api'], manifest: { revision: 7 }, models: [] }) };
            };
        });
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'routing/vendor/model-publication.js'), 'utf8') });
        await page.waitForFunction(() => document.querySelector('#gateway input')?.disabled === false);
        await page.locator('#gateway input').click();
        assert.equal(await page.evaluate(() => window.__writes), 1, 'Gateway action uses the saved provider key, not an unapplied candidate on another tab');
    } finally { await browser.close(); }
});

test('a6api key failures are not falsely described as manifest revision conflicts', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<span data-publication-slot="a6api/new"></span>');
        await page.evaluate(() => {
            window.fetch = async (url, options) => options?.method === 'POST'
                ? { ok: false, status: 409, json: async () => ({ ok: false, code: 'a6api_token_expired', error: 'provider prose must not be shown' }) }
                : { ok: true, status: 200, json: async () => ({ ok: true, canWrite: true, providers: ['a6api'], manifest: { revision: 7 }, models: [] }) };
        });
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'routing/vendor/model-publication.js'), 'utf8') });
        await page.waitForFunction(() => document.querySelector('input')?.disabled === false);
        await page.locator('input').click();
        await page.waitForFunction(() => document.querySelector('.mp-message')?.dataset.kind === 'error');
        const text = await page.locator('.mp-message').innerText();
        assert.match(text, /Срок.*ключа.*истёк/);
        assert.doesNotMatch(text, /Список уже изменился|provider prose/);
    } finally { await browser.close(); }
});
