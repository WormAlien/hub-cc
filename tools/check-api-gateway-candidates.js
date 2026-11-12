#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'routing', 'lib', 'routes-catalog.js');

function loadResolver() {
    const lib = require(LIB_PATH);
    assert.equal(typeof lib.resolveModelCandidates, 'function',
        'routes-catalog must export resolveModelCandidates');
    return lib.resolveModelCandidates;
}

function sourceFunctions(answers, calls) {
    const source = (name) => async (provider) => {
        calls[provider] = calls[provider] || [];
        calls[provider].push(name);
        const value = answers[provider] && answers[provider][name];
        if (value instanceof Error) throw value;
        return value;
    };
    return {
        getLiveModels: source('live'),
        getAccountModels: source('accounts'),
        getPricingModels: source('pricing'),
        getSnapshotModels: source('snapshot'),
        getConfiguredModels: source('configured'),
    };
}

test('exports an async candidate resolver', async () => {
    const resolveModelCandidates = loadResolver();
    const pending = resolveModelCandidates({
        providers: new Set(),
        getLiveModels: async () => [],
        getAccountModels: async () => [],
        getPricingModels: async () => [],
        getSnapshotModels: async () => [],
        getConfiguredModels: async () => [],
    });
    assert.ok(pending instanceof Promise);
    assert.deepEqual(await pending, []);
});

test('selects the first text-bearing source for every canonical provider', async () => {
    const resolveModelCandidates = loadResolver();
    const calls = {};
    const answers = {
        live: {
            live: [
                { id: 'vendor/family/model' },
                'alpha',
                'alpha',
                { id: 'gpt-image-2' },
                { id: 'voice', supported_endpoint_types: ['audio'] },
            ],
        },
        accounts: {
            live: [],
            accounts: [{ id: 'account-model' }],
        },
        pricing: {
            live: new Error('live unavailable'),
            accounts: [{ id: 'nano-banana-2' }],
            pricing: ['pricing-model'],
        },
        snapshot: {
            live: [],
            accounts: [],
            pricing: [],
            snapshot: ['snapshot-model'],
        },
        configured: {
            live: [],
            accounts: [],
            pricing: [],
            snapshot: [],
            configured: ['configured-model'],
        },
        broken: {
            live: new Error('live failed'),
            accounts: new Error('accounts failed'),
            pricing: new Error('pricing failed'),
            snapshot: new Error('snapshot failed'),
            configured: new Error('configured failed'),
        },
    };

    const rows = await resolveModelCandidates({
        providers: new Set(['snapshot', 'live', 'broken', 'pricing', 'configured', 'accounts']),
        ...sourceFunctions(answers, calls),
    });

    assert.deepEqual(rows, [
        { id: 'accounts/account-model', provider: 'accounts', model: 'account-model', catalogSource: 'accounts' },
        { id: 'configured/configured-model', provider: 'configured', model: 'configured-model', catalogSource: 'configured' },
        { id: 'live/alpha', provider: 'live', model: 'alpha', catalogSource: 'live' },
        { id: 'live/vendor/family/model', provider: 'live', model: 'vendor/family/model', catalogSource: 'live' },
        { id: 'pricing/pricing-model', provider: 'pricing', model: 'pricing-model', catalogSource: 'pricing' },
        { id: 'snapshot/snapshot-model', provider: 'snapshot', model: 'snapshot-model', catalogSource: 'snapshot' },
    ]);
    assert.deepEqual(calls, {
        accounts: ['live', 'accounts'],
        broken: ['live', 'accounts', 'pricing', 'snapshot', 'configured'],
        configured: ['live', 'accounts', 'pricing', 'snapshot', 'configured'],
        live: ['live'],
        pricing: ['live', 'accounts', 'pricing'],
        snapshot: ['live', 'accounts', 'pricing', 'snapshot'],
    });
});

test('deduplicates providers and rows and sorts without depending on input order', async () => {
    const resolveModelCandidates = loadResolver();
    const getLiveModels = async (provider) => provider === 'zeta'
        ? ['b/model', 'a', 'b/model']
        : ['z', 'a', 'z'];
    const never = async () => { throw new Error('lower source must not be called'); };
    const options = {
        providers: ['zeta', 'alpha', 'zeta', 'alpha'],
        getLiveModels,
        getAccountModels: never,
        getPricingModels: never,
        getSnapshotModels: never,
        getConfiguredModels: never,
    };

    assert.deepEqual(await resolveModelCandidates(options), [
        { id: 'alpha/a', provider: 'alpha', model: 'a', catalogSource: 'live' },
        { id: 'alpha/z', provider: 'alpha', model: 'z', catalogSource: 'live' },
        { id: 'zeta/a', provider: 'zeta', model: 'a', catalogSource: 'live' },
        { id: 'zeta/b/model', provider: 'zeta', model: 'b/model', catalogSource: 'live' },
    ]);
});

test('accepts canonical provider maps without treating aliases as providers', async () => {
    const resolveModelCandidates = loadResolver();
    const seen = [];
    const rows = await resolveModelCandidates({
        providers: new Map([['second', {}], ['first', {}]]),
        getLiveModels: async (provider) => { seen.push(provider); return [`${provider}-model`]; },
        getAccountModels: async () => [],
        getPricingModels: async () => [],
        getSnapshotModels: async () => [],
        getConfiguredModels: async () => [],
    });
    assert.deepEqual(seen, ['first', 'second']);
    assert.deepEqual(rows.map(row => row.id), ['first/first-model', 'second/second-model']);
});
