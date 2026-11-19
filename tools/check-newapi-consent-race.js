'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { runProvider } = require('../routing/lib/newapi-onboarding');
const scratch = process.env.HERMES_TEST_SCRATCH || 'C:/Users/WormAlien/AppData/Local/hermes/cache/scratch';

test('OAuth consent click cannot rebind to a cross-origin same-selector button', async () => {
    const root = fs.mkdtempSync(path.join(scratch, 'newapi-consent-race-'));
    const moduleDir = path.join(root, 'fxqidian'); fs.mkdirSync(moduleDir, { recursive: true });
    const rows = [{ id: 'fx_fixture', ghId: 'gh_fixture', api_key: 'no-key-fixture' }];
    const contexts = [];
    const launch = async (dir, options) => {
        const context = await chromium.launchPersistentContext(dir, { ...options, headless: true, channel: undefined });
        contexts.push(context);
        await context.addCookies([{ name: 'dotcom_user', value: 'alice', domain: '.github.com', path: '/' },
            { name: 'user_session', value: 'fixture-session', domain: '.github.com', path: '/' }]);
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.hostname === 'fxqidian.de5.net' && url.pathname === '/sign-up') return route.fulfill({ contentType: 'text/html', body:
                '<script>localStorage.setItem("aff","9BEo")</script><button onclick="location.href=\'https://github.com/login/oauth/authorize\'">Continue with GitHub</button>' });
            if (url.hostname === 'github.com') return route.fulfill({ contentType: 'text/html', body:
                '<button name="authorize" value="1" disabled>Authorize</button><script>setTimeout(()=>location.href="https://evil.example/login/oauth/authorize",20)</script>' });
            if (url.hostname === 'evil.example') return route.fulfill({ contentType: 'text/html', body:
                '<button name="authorize" value="1" onclick="document.title=\'EVIL_CLICKED\'">Authorize</button>' });
            return route.abort();
        });
        return context;
    };
    try {
        await assert.rejects(runProvider({ provider: 'fxqidian', moduleDir, label: 'acct_fx_fixture', mode: 'provision',
            config: { full: 'fxqidian', p: 'fx', HOST: 'fxqidian.de5.net', github: true, ref: true,
                onboarding: { kind: 'newapi-github', consolePath: '/keys', callbackPath: '/api/oauth/github', tokenName: '1' } },
            readPool: () => rows, account: { login: 'alice' }, launch, timeoutMs: 5000, log: () => {},
        }), /github_origin_rejected|panel_login_unconfirmed|onboarding_failed/);
        const titles = await Promise.all(contexts.flatMap(context => context.pages()).map(page => page.title().catch(() => '')));
        assert.equal(titles.includes('EVIL_CLICKED'), false);
    } finally { for (const context of contexts) await context.close().catch(() => {}); }
});
