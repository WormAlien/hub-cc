'use strict';

// Persistent Chromium fixture: no real profile, credentials, or provider requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createXingchiPanelSession } = require('../routing/lib/xingchi-panel-session');

const scratch = process.env.HERMES_TEST_SCRATCH;
if (!scratch) throw new Error('Set HERMES_TEST_SCRATCH to an isolated scratch directory');
fs.mkdirSync(scratch, { recursive: true });
const profile = fs.mkdtempSync(path.join(scratch, 'xc-browser-'));
const origin = 'https://xingchiapi.com';
const oldToken = 'fixture-expired-access-token';
const oldRefresh = 'fixture-refresh-one';
const newToken = 'fixture-renewed-access-token';
const newRefresh = 'fixture-refresh-two';
const account = { id: 'xc_fixture' };

async function readOrSeed(seed) {
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, serviceWorkers: 'block' });
  try {
    await ctx.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }));
    const page = await ctx.newPage();
    await page.goto(`${origin}/`);
    return await page.evaluate(seed => {
      if (seed) {
        localStorage.setItem('auth_token', seed.oldToken);
        localStorage.setItem('refresh_token', seed.oldRefresh);
        localStorage.setItem('auth_user', '{"id":123}');
      }
      return [localStorage.getItem('auth_token'), localStorage.getItem('refresh_token'), localStorage.getItem('auth_user'), Number(localStorage.getItem('token_expires_at'))];
    }, seed);
  } finally { await ctx.close(); }
}

(async () => {
  await readOrSeed({ oldToken, oldRefresh });
  let refreshCalls = 0;
  const withSession = createXingchiPanelSession({
    profileDir: () => profile,
    refreshRequest: async (url, init) => {
      refreshCalls++;
      assert.equal(url, `${origin}/api/v1/auth/refresh`);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(JSON.parse(init.body), { refresh_token: oldRefresh });
      return Response.json({ code: 0, data: { access_token: newToken, refresh_token: newRefresh, expires_in: 3600 } });
    },
  });
  await Promise.all([
    withSession(account, async session => {
      assert.equal(session.token, oldToken);
      assert.equal(await session.refresh(), newToken);
    }),
    withSession(account, async session => { assert.equal(session.token, newToken); }),
  ]);
  assert.equal(refreshCalls, 1);
  const [access, refresh, identity, expiresAt] = await readOrSeed();
  assert.deepEqual([access, refresh, identity], [newToken, newRefresh, '{"id":123}']);
  assert.ok(expiresAt > Date.now());
  console.log('PASS persisted rotated Xingchi credentials in the same Chromium profile; concurrent access serialized');

  const invalid = createXingchiPanelSession({ profileDir: () => profile, refreshRequest: async () => Response.json({ message: 'fixture-sensitive-message' }, { status: 401 }) });
  await assert.rejects(invalid(account, session => session.refresh()), e => e.reason === 'XINGCHI_LOGIN_REQUIRED' && !e.message.includes('fixture-sensitive-message'));
  assert.deepEqual(await readOrSeed(), [newToken, newRefresh, '{"id":123}', expiresAt]);
  console.log('PASS rejected refresh did not modify the profile or expose the provider response');
})().catch(error => { console.error(error); process.exitCode = 1; });
