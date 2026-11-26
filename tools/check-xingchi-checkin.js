'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createXingchiCheckin } = require('../routing/lib/xingchi-checkin');

const SCRATCH = process.env.HERMES_TEST_SCRATCH;
if (!SCRATCH) throw new Error('Set HERMES_TEST_SCRATCH to an isolated scratch directory');
fs.mkdirSync(SCRATCH, { recursive: true });
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.stack || error}`); process.exitCode = 1; }
}

const jwt = 'eyJ' + 'fixture'.repeat(5) + '.eyJ' + 'signature'.repeat(3) + '.fixturedata';
const status = { enabled: true, claimed_today: false, amount: 1.25, total_count: 4, total_amount: 5 };
const accounts = [{ id: 'xc_fixture_1', api_key: 'fixture-api-key', status: 'live' }];

(async () => {
  await test('GET status uses the Xingchi panel JWT and returns provider status', async () => {
    const calls = [];
    const service = createXingchiCheckin({
      accounts: () => accounts,
      getToken: async account => account.id === accounts[0].id ? jwt : null,
      request: async request => { calls.push(request); return { status: 200, data: { data: status } }; },
      stateFile: path.join(SCRATCH, 'xc-status.json'),
    });
    const result = await service.getStatus(accounts[0].id);
    assert.deepEqual(result, status);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, 'https://xingchiapi.com/api/v1/user/checkin');
    assert.equal(calls[0].headers.Authorization, `Bearer ${jwt}`);
    assert.equal(JSON.stringify(result).includes(jwt), false);
  });

  await test('Claim is the exact Xingchi POST and preserves provider amount', async () => {
    const calls = [];
    const claimed = { status: { enabled: true, claimed_today: true, amount: 1.25, total_count: 5, total_amount: 6.25 }, amount: 1.25 };
    const service = createXingchiCheckin({
      accounts: () => accounts,
      getToken: async () => jwt,
      request: async request => {
        calls.push(request);
        return calls.length === 1
          ? { status: 200, data: { data: status } }
          : { status: 200, data: { data: claimed } };
      },
      stateFile: path.join(SCRATCH, 'xc-claim.json'),
    });
    const result = await service.claim(accounts[0].id);
    assert.deepEqual(result, claimed);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, 'https://xingchiapi.com/api/v1/user/checkin');
    assert.equal(calls[1].body, undefined);
  });

  await test('missing panel token fails closed without issuing a Claim', async () => {
    let calls = 0;
    const service = createXingchiCheckin({
      accounts: () => accounts,
      getToken: async () => null,
      request: async () => { calls++; return { status: 200, data: status }; },
      stateFile: path.join(SCRATCH, 'xc-no-token.json'),
    });
    await assert.rejects(service.claim(accounts[0].id), error => error.reason === 'XINGCHI_LOGIN_REQUIRED');
    assert.equal(calls, 0);
  });


  if (!process.exitCode) console.log(`PASS Xingchi check-in backend: ${passed} cases`);
})();
