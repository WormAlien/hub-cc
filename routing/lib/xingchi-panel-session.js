'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PANEL_API, loginRequired } = require('./xingchi-checkin');

const STORAGE_URL = `${new URL(PANEL_API).origin}/__hub_xingchi_storage__`;
const TIMEOUT_MS = 15_000;


function refreshUnavailable(statusCode = 502) {
  return Object.assign(new Error('Не удалось обновить сессию Xingchi; попробуй позже'), {
    reason: 'XINGCHI_REFRESH_UNAVAILABLE', statusCode,
  });
}

function createXingchiPanelSession({ profileDir, refreshRequest = fetch } = {}) {
  const pending = new Map();

  async function open(dir, use) {
    let context;
    try {
      const { chromium } = require('playwright');
      context = await chromium.launchPersistentContext(dir, { headless: true, serviceWorkers: 'block', timeout: TIMEOUT_MS });
    } catch {
      // Do not close another process to take the profile or include browser diagnostics in the journal.
      throw Object.assign(new Error('Не удалось открыть профиль Xingchi: если окно 🌐 открыто, закрой его и повтори'), {
        reason: 'XINGCHI_PROFILE_UNAVAILABLE', statusCode: 409,
      });
    }
    try {
      // Use a blank document at the panel origin. The SPA must not rotate the same
      // refresh token in parallel, and no browser request should reach the provider.
      await context.route('**/*', route => route.request().url() === STORAGE_URL
        ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' })
        : route.abort());
      const page = await context.newPage();
      await page.goto(STORAGE_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
      const stored = await page.evaluate(() => ({
        access: localStorage.getItem('auth_token'),
        refresh: localStorage.getItem('refresh_token'),
      }));
      let refresh;
      if (stored.refresh) {
        let attempt;
        refresh = () => attempt ??= renew(page, stored.refresh);
      }
      return await use({ token: stored.access, refresh });
    } finally {
      await context.close();
    }
  }

  async function renew(page, previous) {
    let response;
    try {
      response = await refreshRequest(`${PANEL_API}/auth/refresh`, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: previous }), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { throw refreshUnavailable(); }
    if ([400, 401, 403].includes(response.status)) throw loginRequired();
    if (!response.ok) throw refreshUnavailable(response.status === 429 ? 429 : 502);
    const envelope = await response.json().catch(() => null);
    const pair = envelope?.data;
    if (envelope?.code !== 0 || typeof pair?.access_token !== 'string' || pair.access_token.length < 20 ||
        typeof pair.refresh_token !== 'string' || !pair.refresh_token || !Number.isFinite(pair.expires_in) || pair.expires_in <= 0) {
      throw refreshUnavailable();
    }
    await page.evaluate(({ access, refresh, expiresAt }) => {
      localStorage.setItem('auth_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('token_expires_at', String(expiresAt));
    }, { access: pair.access_token, refresh: pair.refresh_token, expiresAt: Date.now() + pair.expires_in * 1000 });
    return pair.access_token;
  }

  return async function withSession(account, use) {
    const dir = profileDir(account);
    if (!dir || !fs.existsSync(path.join(dir, 'Default', 'Local Storage', 'leveldb'))) throw loginRequired();
    const absolute = path.resolve(dir);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    const prev = pending.get(key) || Promise.resolve();
    const current = prev.catch(() => {}).then(() => open(absolute, use));
    pending.set(key, current);
    try { return await current; }
    finally { if (pending.get(key) === current) pending.delete(key); }
  };
}

module.exports = { createXingchiPanelSession };
