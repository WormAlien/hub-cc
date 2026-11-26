'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createXingchiCheckin } = require('../routing/lib/xingchi-checkin');
const scratch = process.env.HERMES_TEST_SCRATCH;
if (!scratch) throw new Error('Set HERMES_TEST_SCRATCH to an isolated scratch directory');
fs.mkdirSync(scratch, { recursive: true });
const fakeJwt = 'eyJ' + 'fixture'.repeat(5) + '.eyJ' + 'signature'.repeat(3) + '.fixturedata';
const account = { id: 'xc_fixture', api_key: 'fixture-api-key', status: 'live' };
const available = { enabled: true, claimed_today: false, amount: 1.25, total_count: 4, total_amount: 5 };
const claimed = { status: { ...available, claimed_today: true, total_count: 5, total_amount: 6.25 }, amount: 1.25 };
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.stack || error}`); process.exitCode = 1; }
}
(async () => {
  await test('authenticated status GET returns the actual provider state', async () => {
    const calls = [];
    const service = createXingchiCheckin({ accounts: () => [account], getToken: async () => fakeJwt,
      request: async request => { calls.push(request); return { status: 200, data: { data: available } }; },
      stateFile: path.join(scratch, 'claim-status.json') });
    assert.deepEqual(await service.getStatus(account.id), available);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, 'https://xingchiapi.com/api/v1/user/checkin');
    assert.equal(calls[0].headers.Authorization, `Bearer ${fakeJwt}`);
  });
  await test('Claim sends one POST only after a fresh eligible-status GET', async () => {
    const calls = [];
    const service = createXingchiCheckin({ accounts: () => [account], getToken: async () => fakeJwt,
      request: async request => { calls.push(request); return { status: 200, data: { data: calls.length === 1 ? available : claimed } }; },
      stateFile: path.join(scratch, 'claim-success.json') });
    assert.deepEqual(await service.claim(account.id), claimed);
    assert.deepEqual(calls.map(call => call.method), ['GET', 'POST']);
    assert.equal(calls[1].url, 'https://xingchiapi.com/api/v1/user/checkin');
    assert.equal(calls[1].body, undefined);
  });
  await test('expired panel JWT refreshes once, then a new status GET precedes the only Claim POST', async () => {
    const renewed = `${fakeJwt}-renewed`;
    const calls = [];
    const service = createXingchiCheckin({ accounts: () => [account], getToken: async () => fakeJwt,
      withSession: async (_account, use) => use({ token: fakeJwt, refresh: async () => { calls.push('refresh'); return renewed; } }),
      request: async ({method, headers}) => {
        const isOld = headers.Authorization === `Bearer ${fakeJwt}`;
        calls.push(`${method}:${isOld ? 'old' : 'new'}`);
        if (isOld) throw Object.assign(new Error('Token has expired'), { status: 401 });
        return { status: 200, data: { data: method === 'GET' ? available : claimed } };
      }, stateFile: path.join(scratch, 'claim-expired.json') });
    assert.deepEqual(await service.claim(account.id), claimed);
    assert.deepEqual(calls, ['GET:old', 'refresh', 'GET:new', 'POST:new']);
  });
  await test('an unsuccessful refresh prevents Claim', async () => {
    const calls = [];
    const service = createXingchiCheckin({ accounts: () => [account],
      withSession: async (_account, use) => use({ token: fakeJwt, refresh: async () => { throw new Error('Войди заново'); } }),
      request: async ({method}) => { calls.push(method); throw Object.assign(new Error('Token has expired'), { status: 401 }); },
      stateFile: path.join(scratch, 'claim-expired-unrecoverable.json') });
    await assert.rejects(service.claim(account.id), /Войди заново/);
    assert.deepEqual(calls, ['GET']);
  });
  await test('a failed Claim POST is never automatically sent again', async () => {
    const calls = [];
    const service = createXingchiCheckin({ accounts: () => [account],
      withSession: async (_account, use) => use({ token: fakeJwt, refresh: async () => { calls.push('refresh'); return fakeJwt; } }),
      request: async ({method}) => {
        calls.push(method);
        if (method === 'POST') throw Object.assign(new Error('Token has expired'), { status: 401 });
        return { status: 200, data: { data: available } };
      }, stateFile: path.join(scratch, 'claim-no-post-retry.json') });
    await assert.rejects(service.claim(account.id), /Token has expired/);
    assert.deepEqual(calls, ['GET', 'POST']);
  });
  await test('already claimed skips POST and returns a duplicate-safe reason', async () => {
    let calls = 0;
    const service = createXingchiCheckin({ accounts: () => [account], getToken: async () => fakeJwt,
      request: async () => { calls++; return { status: 200, data: { data: { ...available, claimed_today: true } } }; },
      stateFile: path.join(scratch, 'claim-already.json') });
    await assert.rejects(service.claim(account.id), error => error.reason === 'CHECKIN_ALREADY_CLAIMED');
    assert.equal(calls, 1);
  });
  await test('missing token is fail-closed and sends no request', async () => {
    let calls = 0;
    const service = createXingchiCheckin({ accounts: () => [account], getToken: async () => null,
      request: async () => { calls++; }, stateFile: path.join(scratch, 'claim-no-token.json') });
    await assert.rejects(service.claim(account.id), error => error.reason === 'XINGCHI_LOGIN_REQUIRED');
    assert.equal(calls, 0);
  });

  if (!process.exitCode) console.log(`PASS Xingchi check-in backend: ${passed} cases`);
})();
