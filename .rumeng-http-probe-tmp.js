// Полный путь регистрации rumeng по ЧИСТОМУ HTTP.
// Если проходит — авторега копипастится из aikeysapi (там тот же подход).
// Почту (gmail) даёт emailnator: у панели вайтлист @qq.com / @gmail.com / *.edu.cn.

const { chromium } = require('playwright');
const { createEmail, openInbox, pollInbox } = require('./freemodel/lib/emailnator');

const BASE = 'https://api.rumeng-ai.com/api/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const call = async (method, path, { body, token } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'User-Agent': UA, Origin: 'https://api.rumeng-ai.com', Referer: 'https://api.rumeng-ai.com/register',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text: text.slice(0, 400) };
};

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--window-size=1200,900'] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 }, locale: 'zh-CN', userAgent: UA });
  const mail = await ctx.newPage();

  try {
    await mail.bringToFront();
    const email = await createEmail(mail);
    await openInbox(mail, email);
    const password = 'Rm' + Math.random().toString(36).slice(2, 9) + '!7';
    console.log('ПОЧТА:', email, '| пароль:', password);

    console.log('\n1) POST /auth/send-verify-code');
    let r = await call('POST', '/auth/send-verify-code', { body: { email } });
    console.log('   HTTP', r.status, r.text.slice(0, 200));
    if (r.status >= 400) { console.log('   → дальше смысла нет'); return; }

    console.log('\n2) жду код в ящике');
    const code = await pollInbox(mail, email, { timeout: 3 });
    console.log('   код:', code);
    if (!code) { console.log('   → код не пришёл'); return; }

    console.log('\n3) POST /auth/register');
    r = await call('POST', '/auth/register', { body: { email, password, verify_code: code } });
    console.log('   HTTP', r.status, r.text.slice(0, 300));
    if (r.status >= 400) {
      console.log('   пробую поле verification_code');
      r = await call('POST', '/auth/register', { body: { email, password, verification_code: code } });
      console.log('   HTTP', r.status, r.text.slice(0, 300));
    }
    if (r.status >= 400) {
      console.log('   пробую поле code');
      r = await call('POST', '/auth/register', { body: { email, password, code } });
      console.log('   HTTP', r.status, r.text.slice(0, 300));
    }
    const token = r.json && (r.json.access_token || (r.json.data && r.json.data.access_token));
    if (token) console.log('   ✅ access_token, длина', token.length);

    console.log('\n4) POST /auth/login');
    const lg = await call('POST', '/auth/login', { body: { email, password } });
    console.log('   HTTP', lg.status, lg.text.slice(0, 200));
    const tok2 = lg.json && (lg.json.access_token || (lg.json.data && lg.json.data.access_token));

    const useTok = token || tok2;
    if (!useTok) { console.log('   → токена нет, ключ не создать'); return; }

    console.log('\n5) GET /auth/me');
    const me = await call('GET', '/auth/me', { token: useTok });
    console.log('   HTTP', me.status, me.text.slice(0, 220));

    console.log('\n6) ищу ручки ключей и групп');
    for (const p of ['/keys', '/user/keys', '/api-keys', '/groups', '/user/groups', '/keys/groups']) {
      const x = await call('GET', p, { token: useTok });
      console.log(`   ${p.padEnd(14)} HTTP ${x.status}  ${x.text.slice(0, 130)}`);
    }
  } catch (e) {
    console.log('ОШИБКА:', e.message);
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch(e => { console.log('ФАТАЛЬНО:', e.message); process.exit(1); });
