#!/usr/bin/env node
'use strict';
// Offline contracts for the a6api panel client. No real keys or network.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const FILE = path.join(__dirname, '../routing/lib/a6api-api.js');
let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok ' + name); }
    catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}
function response(data, status = 200) {
    return new Response(JSON.stringify({ success: true, data }), { status, headers: { 'content-type': 'application/json' } });
}
const MODEL = 'deepseek-v4.1-flash-1017';
const listing = (id = 6038, model = MODEL) => ({ channel_id: id, listing_id: id + 100, supplier_id: id + 10,
    supplier_name: 'Seller <script>', channel_name: 'channel', model_name: model, input_price_micros: 1320,
    output_price_micros: 5280, cache_read_price_micros: 26, recent_success_rate: 10000,
    success_rate_24h: 9974, sample_count: 100, p50_ttft_ms: 6952, review_count: 2,
    review_rating_tenths: 50, listing_availability: 1 });
(async () => {
    await test('a6api client exists', () => assert.ok(fs.existsSync(FILE), 'a6api-api.js is missing'));
    if (!fs.existsSync(FILE)) return;
    const { createClient, normalizeListing, tokenView } = require(FILE);
    const make = fetchImpl => createClient({ token: 'panel-secret-for-test', userId: 42, fetchImpl });
    await test('default user ID comes from the private config instead of a hardcoded account', async () => {
        const os = require('node:os'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-user-config-'));
        let calls = 0;
        try {
            fs.writeFileSync(path.join(dir, 'a6api-config.json'), '﻿' + JSON.stringify({ userId: 314 }));
            const api = createClient({ token: 'fixture', secretDir: dir, fetchImpl: async (_, opts) => {
                calls++; assert.equal(opts.headers['New-Api-User'], '314'); return response([]);
            } });
            await api.models(); assert.equal(calls, 1);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    await test('missing private account config fails before transport', async () => {
        const os = require('node:os'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-user-missing-'));
        let calls = 0;
        try {
            const api = createClient({ token: 'fixture', secretDir: dir, fetchImpl: async () => { calls++; return response([]); } });
            await assert.rejects(api.models(), e => e.code === 'panel_config_missing' && e.status === 503);
            assert.equal(calls, 0);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    await test('micros and bps retain their actual units', () => {
        const x = normalizeListing(listing());
        assert.equal(x.inputUsd, 0.00132); assert.equal(x.outputUsd, 0.00528);
        assert.equal(x.success24h, 99.74); assert.equal(x.recentSuccess, 100);
        assert.equal(x.samples, 100); assert.equal(x.rating, 5); assert.equal(x.ttftMs, 6952);
    });
    await test('missing telemetry is not a zero success rate', () => {
        const x = normalizeListing({ channel_id: 1, model_name: MODEL });
        assert.equal(x.success24h, null); assert.equal(x.recentSuccess, null);
        assert.equal(x.rating, null); assert.equal(x.inputUsd, null); assert.equal(x.reviews, null);
        assert.equal(normalizeListing({ ...listing(), sample_count: '  ' }).samples, null);
        assert.equal(normalizeListing({ ...listing(), p50_ttft_ms: false }).ttftMs, null);
        assert.equal(normalizeListing({ ...listing(), recent_success_rate: 0 }).recentSuccess, 0);
    });
    await test('token list returns a mask, not the model key', () => {
        const view = tokenView({ id: 9, key: 'sk-private-1234567890', name: 'key', used_quota: 3,
            model_limits: MODEL + ',deepseek-v4-pro', model_limits_enabled: true }, 500000);
        assert.ok(!JSON.stringify(view).includes('sk-private-1234567890'));
        assert.equal(view.spentUsd, 0.000006);
        assert.deepEqual(view.models, [MODEL, 'deepseek-v4-pro']);
    });
    await test('catalog uses model, follows pages, rejects fuzzy matches and preserves stale', async () => {
        const calls = [];
        const api = make(async (url, opts) => {
            const u = new URL(url); calls.push(u);
            assert.equal(u.searchParams.get('model'), MODEL);
            assert.equal(u.searchParams.has('model_name'), false);
            assert.equal(opts.headers['New-Api-User'], '42');
            assert.equal(opts.headers.Authorization, 'Bearer panel-secret-for-test');
            return response({ total: 3, stale: true, snapshot_generated_at: 1792714000,
                items: calls.length === 1 ? [listing(1), listing(2, 'another-model')] : [listing(3)] });
        });
        const data = await api.listings(MODEL, 9, { pageSize: 2 });
        assert.equal(calls.length, 2); assert.equal(calls[1].searchParams.get('page'), '2');
        assert.deepEqual(data.items.map(x => x.channelId), [1, 3]); assert.equal(data.stale, true);
    });
    await test('normal model catalog fits a single supported 500-row page', async () => {
        let calls = 0;
        const api = make(async (url) => {
            calls++;
            const u = new URL(url);
            assert.equal(u.searchParams.get('page_size'), '500');
            return response({ total: 122, page_size: 500, snapshot_generated_at: 10,
                items: Array.from({ length: 122 }, (_, i) => listing(i + 1)) });
        });
        const data = await api.listings(MODEL, 9);
        assert.equal(data.items.length, 122); assert.equal(calls, 1);
    });
    await test('snapshot changes cannot silently merge different marketplace pages', async () => {
        let calls = 0;
        const api = make(async () => response({ total: 3, snapshot_generated_at: ++calls, items: calls === 1 ? [listing(1), listing(2)] : [listing(3)] }));
        await assert.rejects(api.listings(MODEL, 9, { pageSize: 2 }), e => e.code === 'upstream_pagination');
        assert.equal(calls, 2);
    });
    await test('short marketplace pages cannot be mistaken for a complete total', async () => {
        let calls = 0;
        const api = make(async () => response({ total: 3, items: ++calls === 1 ? [listing(1), listing(2)] : [] }));
        await assert.rejects(api.listings(MODEL, 9, { pageSize: 2 }), e => e.code === 'upstream_pagination');
    });
    await test('repeated marketplace rows cannot hide a missing channel', async () => {
        let calls = 0;
        const api = make(async () => response({ total: 3, items: ++calls === 1 ? [listing(1), listing(2)] : [listing(2)] }));
        await assert.rejects(api.listings(MODEL, 9, { pageSize: 2 }), e => e.code === 'upstream_pagination');
    });
    await test('catalog without a total follows full pages instead of reporting zero', async () => {
        let calls = 0;
        const api = make(async () => response({ items: ++calls === 1 ? [listing(1), listing(2)] : [listing(3)] }));
        const got = await api.listings(MODEL, 9, { pageSize: 2 });
        assert.equal(calls, 2); assert.equal(got.total, null); assert.equal(got.items.length, 3);
    });
    await test('known provider conflicts preserve status and code but never raw messages', async () => {
        const api = make(async () => new Response(JSON.stringify({ success: false, code: 'subscription_config_version_conflict', message: 'panel-secret-for-test' }), { status: 409 }));
        await assert.rejects(api.request('/api/subscriptions/77/config', { method: 'PUT', body: {} }), e => e.status === 409 && e.upstreamStatus === 409 && e.code === 'subscription_config_version_conflict' && !e.message.includes('secret'));
    });
    await test('HTTP 200 success:false is still a failure without secret leakage', async () => {
        const api = make(async () => new Response(JSON.stringify({ success: false, message: 'panel-secret-for-test sk-private-12345678' })));
        await assert.rejects(api.models(), e => !e.message.includes('secret') && !e.message.includes('sk-') && e.code === 'upstream_rejected');
    });
    for (const status of [401, 429, 500]) await test('HTTP ' + status + ' is not treated as data', async () => {
        let calls = 0;
        const api = make(async () => { calls++; return new Response('not JSON', { status }); });
        await assert.rejects(api.models(), e => e.upstreamStatus === status); assert.equal(calls, 1);
    });
    await test('transport timeout is explicit and never retried', async () => {
        let calls = 0;
        const api = make(async () => { calls++; throw new DOMException('timeout', 'TimeoutError'); });
        await assert.rejects(api.models(), e => e.code === 'upstream_timeout'); assert.equal(calls, 1);
    });
    await test('unexpected HTML is not an empty catalog', async () => {
        const api = make(async () => new Response('<html>login</html>'));
        await assert.rejects(api.models(), e => e.code === 'upstream_not_json');
    });
    await test('secret cannot be sent to an arbitrary host or path', async () => {
        let calls = 0;
        const api = make(async () => { calls++; return response({}); });
        await assert.rejects(api.request('https://evil.example/api/token/'), /path/i);
        await assert.rejects(api.request('/api/user/token'), /path/i);
        assert.equal(calls, 0);
    });
    await test('strategy names match the marketplace API', () => {
        assert.deepEqual(require(FILE).STRATEGIES, ['price_asc', 'success_desc', 'latency_asc', 'user_priority_desc']);
    });
    const probeFile = path.join(__dirname, '../routing/lib/a6api-probe.js');
    await test('capability probe exists', () => assert.ok(fs.existsSync(probeFile), 'a6api-probe.js is missing'));
    if (fs.existsSync(probeFile)) {
        const { imageFixture, parseStream, makeToolRound, toolFollowup } = require(probeFile);
        await test('vision fixtures are real PNGs, change with the answer, and keep it out of text', () => {
            const a = imageFixture('4273', 'red'), b = imageFixture('8195', 'blue');
            assert.equal(Buffer.from(a.base64, 'base64').subarray(1, 4).toString(), 'PNG');
            assert.notEqual(a.base64, b.base64);
            assert.ok(!a.prompt.includes('4273')); assert.ok(!a.prompt.includes('red'));
        });
        await test('stream parser assembles split arguments and reasoning, requires DONE', async () => {
            const events = [
                { model: MODEL, choices: [{ delta: { reasoning_content: 'reason' } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_marker', arguments: '{"tag":' } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a6"}' } }] }, finish_reason: 'tool_calls' }] },
                { choices: [], usage: { prompt_tokens: 12, completion_tokens: 9 } },
            ].map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n';
            const got = await parseStream(new Response(events));
            assert.equal(got.message.tool_calls[0].function.arguments, '{"tag":"a6"}');
            assert.equal(got.message.reasoning_content, 'reason'); assert.equal(got.usage.prompt_tokens, 12);
            await assert.rejects(parseStream(new Response(events.replace('data: [DONE]\n\n', ''))), /incomplete/i);
        });
        await test('second tool round preserves assistant reasoning and call ID', () => {
            const first = makeToolRound(MODEL);
            const msg = { role: 'assistant', content: null, reasoning_content: 'keep this', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_marker', arguments: '{"tag":"a6"}' } }] };
            const next = toolFollowup(first, msg, 'MARKER-728');
            assert.deepEqual(next.messages.at(-2), msg);
            assert.equal(next.messages.at(-1).tool_call_id, 'c1');
            assert.ok(JSON.stringify(next.messages.at(-1)).includes('MARKER-728'));
        });
    }
    function panel({ version = 3, readbackBroken = false, subOverrides = {}, afterWrite } = {}) {
        const token = { id: 9, name: 'existing', key: 'masked***', model_limits_enabled: true, model_limits: MODEL + ',old-model',
            expired_time: 1900000000, unlimited_quota: true, routing_allow_fallback: true, routing_enabled: true, group: 'personal' };
        let sub = { id: 77, config_version: version, token_id: 9, model_name: MODEL, channels: [{ channel_id: 6038 }],
            sort_strategy: 'price_asc', caps: {}, fallback_enabled: false, auto_pool_enabled: false, ...subOverrides };
        const calls = [];
        const fetchImpl = async (url, opts) => {
            const u = new URL(url), body = opts.body ? JSON.parse(opts.body) : null;
            calls.push({ path: u.pathname, method: opts.method, body });
            if (u.pathname === '/api/token/' && opts.method === 'GET') return response({ total: 1, items: [token] });
            if (u.pathname === '/api/token/' && opts.method === 'PUT') { Object.assign(token, body); return response({}); }
            if (u.pathname === '/api/pricing') return response([{ model_name: MODEL }, { model_name: 'added-model' }]);
            if (u.pathname === '/api/subscriptions' && opts.method === 'GET') return response({ total: 1, items: [sub] });
            if (u.pathname === '/api/marketplace/pins') return response([]);
            if (u.pathname === '/api/marketplace/channels/search') return response({ total: 2, items: [listing(), listing(4886)] });
            if (u.pathname === '/api/subscriptions/77/config') {
                sub = { ...sub, ...body, config_version: version + 1 };
                if (readbackBroken) sub.channels = [{ channel_id: 999 }];
                if (afterWrite) afterWrite(sub);
                return response(sub);
            }
            if (u.pathname === '/api/subscriptions/77') return response(sub);
            throw new Error('Unexpected test request ' + u.pathname);
        };
        return { api: make(fetchImpl), calls, token };
    }
    const draft = { tokenId: 9, model: MODEL, baselineId: 77, baselineVersion: 3,
        channels: [6038, 4886], strategy: 'price_asc', caps: { input_price_micros: 1320, output_price_micros: 5280 },
        confirmedPrices: { 6038: { input_price_micros: 1320, output_price_micros: 5280, cache_read_price_micros: 26 }, 4886: { input_price_micros: 1320, output_price_micros: 5280, cache_read_price_micros: 26 } } };
    await test('save route writes an optimistic config and checks readback', async () => {
        const p = panel(); assert.equal(typeof p.api.saveRoute, 'function');
        const r = await p.api.saveRoute(draft);
        assert.deepEqual(r.channels.map(x => x.channelId).sort(), [4886, 6038]);
        const write = p.calls.find(x => x.method === 'PUT');
        assert.equal(write.path, '/api/subscriptions/77/config'); assert.equal(write.body.expected_config_version, 3);
        assert.equal(write.body.auto_pool_enabled, false); assert.equal(write.body.fallback_enabled, false);
    });
    await test('stale route versions never overwrite newer settings', async () => {
        const p = panel({ version: 4 });
        await assert.rejects(p.api.saveRoute(draft), e => e.code === 'route_conflict');
        assert.equal(p.calls.filter(x => x.method !== 'GET').length, 0);
    });
    await test('existing routes without a valid version are not overwritten', async () => {
        const p = panel({ version: null });
        await assert.rejects(p.api.saveRoute({ ...draft, baselineVersion: null }), e => e.code === 'route_conflict');
        assert.equal(p.calls.filter(x => x.method !== 'GET').length, 0);
    });
    await test('empty pool cannot silently fall back to the entire market', async () => {
        const p = panel(); await assert.rejects(p.api.saveRoute({ ...draft, channels: [] }), e => e.code === 'empty_pool');
        assert.equal(p.calls.filter(x => x.method !== 'GET').length, 0);
    });
    await test('changed prices require fresh confirmation', async () => {
        const p = panel(); await assert.rejects(p.api.saveRoute({ ...draft, confirmedPrices: { ...draft.confirmedPrices, 6038: { input_price_micros: 1, output_price_micros: 2 } } }), e => e.code === 'price_changed');
        assert.equal(p.calls.filter(x => x.method !== 'GET').length, 0);
    });
    await test('successful write with wrong readback is not reported saved', async () => {
        const p = panel({ readbackBroken: true });
        await assert.rejects(p.api.saveRoute(draft), e => e.code === 'route_readback_mismatch' && e.writeAccepted === true);
    });
    await test('manual priorities must match the verified readback', async () => {
        const p = panel({ afterWrite: sub => { sub.user_priorities = { 6038: 1, 4886: 2 }; } });
        await assert.rejects(p.api.saveRoute({ ...draft, strategy: 'user_priority_desc' }), e => e.code === 'route_readback_mismatch' && e.writeAccepted === true);
    });
    await test('changed cache prices require fresh confirmation', async () => {
        const p = panel();
        await assert.rejects(p.api.saveRoute({ ...draft, confirmedPrices: { ...draft.confirmedPrices, 6038: { ...draft.confirmedPrices[6038], cache_read_price_micros: 1 } } }), e => e.code === 'price_changed');
        assert.equal(p.calls.filter(x => x.method !== 'GET').length, 0);
    });
    await test('configured cache price caps are enforced before writing', async () => {
        const p = panel();
        await assert.rejects(p.api.saveRoute({ ...draft, caps: { ...draft.caps, cache_read_price_micros: 25 } }), e => e.code === 'price_over_cap');
        assert.equal(p.calls.filter(x => x.method !== 'GET').length, 0);
    });
    await test('omitted unrelated price caps are preserved on an existing route', async () => {
        const p = panel({ subOverrides: { caps: { cache_read_price_micros: 30, per_request_price_micros: 200 } } });
        await p.api.saveRoute(draft);
        const write = p.calls.find(x => x.method === 'PUT');
        assert.equal(write.body.caps.cache_read_price_micros, 30); assert.equal(write.body.caps.per_request_price_micros, 200);
    });
    await test('an ambiguous route timeout checks state without retrying the mutation', async () => {
        const p = panel({ afterWrite: () => { throw new DOMException('timeout', 'TimeoutError'); } });
        const r = await p.api.saveRoute(draft);
        assert.equal(r.id, 77); assert.equal(p.calls.filter(x => x.method !== 'GET').length, 1);
        assert.equal(p.calls.at(-1).method, 'GET');
    });
    await test('null optional prices remain saveable with full input/output confirmations', async () => {
        const p = panel();
        const r = await p.api.saveRoute({ ...draft, confirmedPrices: Object.fromEntries(Object.entries(draft.confirmedPrices).map(([id, prices]) => [id, { ...prices, cache_write_price_micros: null, per_request_price_micros: null }])) });
        assert.equal(r.id, 77);
    });
    await test('unowned token IDs cannot reveal, add models, or save routes', async () => {
        const p = panel();
        await assert.rejects(p.api.reveal(10), e => e.code === 'token_not_owned');
        await assert.rejects(p.api.enableModel(10, 'added-model'), e => e.code === 'token_not_owned');
        await assert.rejects(p.api.saveRoute({ ...draft, tokenId: 10 }), e => e.code === 'token_not_owned');
        assert.equal(p.calls.filter(x => x.method !== 'GET').length, 0);
    });
    await test('adding one model preserves old whitelist, expiry and token defaults', async () => {
        const p = panel(); await p.api.enableModel(9, 'added-model');
        assert.equal(p.token.model_limits, MODEL + ',old-model,added-model');
        assert.equal(p.token.expired_time, 1900000000); assert.equal(p.token.routing_allow_fallback, true);
        assert.equal(p.token.group, 'personal');
    });
    if (fs.existsSync(probeFile)) {
        await test('vision requests reserve enough reasoning tokens and classify length honestly', async () => {
            const os = require('node:os'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-probe-'));
            const { createRunner } = require(probeFile); const bodies = [];
            try {
                const runner = createRunner({ secretDir: dir, fetchImpl: async (_, opts) => {
                    const body = JSON.parse(opts.body); bodies.push(body);
                    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'not complete' }, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n');
                } });
                await runner.suite({ key: 'fake', tokenId: 1, channelId: 2, model: MODEL, quick: true });
                const vision = bodies.filter(b => Array.isArray(b.messages[0].content));
                assert.ok(vision.length > 0); assert.ok(vision.every(b => b.max_tokens >= 2048));
                const records = fs.readFileSync(path.join(dir, 'a6api-probes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
                assert.ok(records.every(r => r.reason === 'output_limit'));
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        });
        await test('probe limit is durable and blocks network before a second request', async () => {
            const os = require('node:os'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-budget-'));
            const { createRunner } = require(probeFile); let calls = 0;
            const options = { secretDir: dir, maxRequests: 1, fetchImpl: async () => { calls++; throw new DOMException('abort', 'TimeoutError'); } };
            const input = { key: 'fake', tokenId: 1, channelId: 2, test: 'offline', body: { model: MODEL, max_tokens: 32 }, validate: () => false };
            try {
                await createRunner(options).call(input);
                await assert.rejects(createRunner(options).call(input), e => e.code === 'probe_budget');
                assert.equal(calls, 1);
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        });
    }
    console.log(`check-a6api: ${passed} passed`);
})();
