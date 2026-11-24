#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(process.env.PUBLICATION_DASH || path.join(root, 'routing/proxy-dashboard.html'), 'utf8');
const renderers = [
    ['Ar', 'agentrouter', 'ar'], ['Go', 'gorouter', 'go'], ['Kk', 'kktoken', 'kk'], ['Xc', 'xingchi', 'xc'], ['Fg', 'freegg', 'fg'],
    ['Ax', 'apinex', 'ax'], ['Kv', 'kvotum', 'kv'], ['Tr', 'threerouter', 'tr'], ['Pm', 'premier', 'pm'], ['Vn', 'vani', 'vn'],
    ['Dc', 'dacall', 'dc'], ['Cp', 'cleanapis', 'cp'], ['Ab', 'artbloom', 'ab'], ['Fx', 'fxqidian', 'fx'], ['Ls', 'lsapi', 'ls'],
    ['Bd', 'budsin', 'bd'], ['Nv', 'nova', 'nv'], ['Od', 'odyssey', 'od'], ['Bai', 'bai', 'bai'], ['Uk', 'getunikey', 'uk'],
    ['Ap', 'aipm', 'ap'], ['Hn', 'hcnsec', 'hn'], ['Ak', 'aikeysapi', 'ak'], ['Rm', 'rumeng', 'rm'], ['Jw', 'justwoker', 'jw'],
    ['Sk', 'seekai', 'sk'], ['Ts', 'truesota', 'ts'], ['Tb', 'tabi', 'tb'], ['Xp', 'xpeach', 'xp'],
    ['Uc', 'uncensoredlabs', 'uc'],
];
function extract(name) {
    const start = new RegExp('^(?:async )?function ' + name + '\\([^\\n]*\\) \\{', 'm').exec(html);
    assert.ok(start, 'missing function ' + name);
    const tail = html.slice(start.index), end = tail.indexOf('\n}');
    assert.ok(end > 0, 'missing function end ' + name);
    return tail.slice(0, end + 2);
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

for (const [name, provider, pfx] of renderers) test(provider + ' model renderer exposes one exact publication per vendor ID', async () => {
    const modelId = name === 'Ar' ? 'gpt-6.1-sol' : 'free/nested/fixture-model';
    const holders = {}, state = { [pfx + 'Models']: [{ id: modelId, supported_endpoint_types: ['anthropic'] }] };
    const sandbox = { state, esc, JSON, Set, String, Number, Array, Object,
        $: id => holders[id] ||= { innerHTML: '' }, fetch: async () => ({ json: async () => ({ ok: true, model: 'fixture-active' }) }),
        withCtxSuffix: id => id + '[1m]', arModelCommand: id => '/model agentrouter/' + id + '[1m]',
        modelsCloudHtml: (key, list, active, map, chip) => list.map(chip).join(''),
        vnModelRank: () => 0, hnModelRank: () => 0, HN_MODEL_WARN: {}, HN_MODEL_BAD: {}, TS_BAD_MODELS: {}, XP_DEAD_MODELS: {},
        AK_MODELS: ['free/nested/fixture-model'], RM_MODELS_FALLBACK: [],
        // window.XingchiModelTest живёт во внешнем vendor/xingchi-model-test.js: песочница
        // собирает только renderXcModels через extract(), поэтому даём минимальную заглушку.
        XingchiModelTest: { button: () => '', attach: () => {} },
    };
    sandbox['render' + name + 'ModelMap'] = () => {};
    const arPolicy = name === 'Ar' ? (html.match(/^const AR_SOL_MODELS = [^\n]+/m)?.[0] || '') + '\n' : '';
    vm.runInNewContext(extract('modelPublicationChip') + '\n' + arPolicy + (name === 'Hn' ? extract('hnModelsSorted') + '\n' : '') + extract('render' + name + 'Models') + '\nthis.render = render' + name + 'Models;', sandbox);
    await sandbox.render(state[pfx + 'Models']);
    const result = holders[pfx + '-models-list']?.innerHTML || '';
    assert.equal((result.match(/data-publication-slot=/g) || []).length, 1, provider);
    assert.ok(result.includes('data-publication-chip="' + provider + '/' + modelId + '"'), result);
    assert.ok(result.includes('📋'), 'copy remains present');
});

test('publication wrapper rejects malformed inputs without repairing IDs', () => {
    const sandbox = { esc };
    vm.runInNewContext(extract('modelPublicationChip') + '\nthis.chip = modelPublicationChip;', sandbox);
    const original = '<span class="fixture">model</span>';
    for (const [provider, model] of [['agentrouter', ' /model'], ['agentrouter ', 'model'], ['ar/name', 'model'], ['agentrouter', '']]) {
        assert.equal(sandbox.chip(provider, model, original), original);
    }
    const xss = sandbox.chip('agentrouter', 'nested/<img>', original);
    assert.ok(xss.includes('nested/&lt;img&gt;'));
    assert.equal(xss.includes('<img>'), false);
});

test('every keepalive maxhedges placeholder starts at zero without changing other knobs', () => {
    const inputs = [...html.matchAll(/<input\b[^>]*id="[^"]+-keepalive-maxhedges"[^>]*>/g)].map(match => match[0]);
    assert.ok(inputs.length > 0, 'keepalive inputs exist');
    for (const input of inputs) assert.match(input, /placeholder="0"/, input);
    const attempts = [...html.matchAll(/<input\b[^>]*id="[^"]+-keepalive-attempts"[^>]*>/g)].map(match => match[0]);
    for (const input of attempts) assert.match(input, /placeholder="3"/, input);
    const precommits = [...html.matchAll(/<input\b[^>]*id="[^"]+-keepalive-precommit"[^>]*>/g)].map(match => match[0]);
    for (const input of precommits) assert.match(input, /placeholder="10"/, input);
});

test('dashboard registers publication assets before the Gateway client', () => {
    assert.match(html, /<link rel="stylesheet" href="\/vendor\/model-publication\.css">/);
    assert.match(html, /<script src="\/vendor\/model-publication\.js"><\/script>/);
    assert.ok(html.indexOf('<script src="/vendor/model-publication.js">') < html.indexOf('<script src="/vendor/api-gateway-tab.js">'));
});
