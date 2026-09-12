'use strict';

// Offline/static CI guard for the AIKeysAPI integration.
// This file is intentionally dependency-free and reads only repository files.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (condition) console.log(`ok ${checks} - ${message}`);
  else {
    failures += 1;
    console.error(`not ok ${checks} - ${message}`);
  }
}

function read(rel) {
  const file = path.join(ROOT, rel);
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) {
    check(false, `${rel} is readable (${error.code || error.message})`);
    return '';
  }
}

function has(text, regex, message) { check(regex.test(text), message); }
function count(text, regex) { return [...text.matchAll(regex)].length; }

const proxy = read('routing/transparent-proxy.js');
const dashboard = read('routing/proxy-dashboard.html');
const lifecycle = read('routing/lifecycle.js');
const keepalive = read('routing/keepalive-proxy.js');
const restart = read('routing/keepalive-restart.ps1');
const account = read('routing/lib/newapi-account.js');
const refs = read('routing/lib/ref-codes.js');
const refDefaults = read('routing/ref-codes.default.json');
const balance = read('internal/hub-balance.js');
const modelmapText = read('routing/aikeysapi-modelmap.json');
const openSession = read('aikeysapi/open-session.js');
const autoAdd = read('aikeysapi/auto-add.js');

// 1. Provider identity and transport.
has(proxy, /aikeysapi:\s*\{[\s\S]*?label:\s*['"]AIKeysAPI['"][\s\S]*?base_url:\s*['"]http:\/\/localhost:20165['"]/,
  'transparent proxy defines AIKeysAPI on local port 20165');
has(restart, /20165\s*=\s*@\{\s*UPSTREAM\s*=\s*['"]https:\/\/www\.aikeysapi\.com['"][\s\S]*?aikeysapi-active-key\.txt[\s\S]*?aikeysapi-modelmap\.json/,
  'restart map pins AIKeysAPI host, key file, and modelmap');
has(refs, /aikeysapi:\s*\{\s*host:\s*['"]www\.aikeysapi\.com['"],\s*path:\s*['"]\/register\?aff=['"],\s*label:\s*['"]AIKeysAPI['"]\s*\}/,
  'ref-code route uses the fixed AIKeysAPI registration host');

// 2. HTTP autoreg is wired, while GitHub-pool coupling stays absent.
has(proxy, /handleAkAutoregStart[\s\S]*?aikeysapi['"], ['"]auto-add\.js['"][\s\S]*?AK_AUTOADD_RESULT/,
  'AIKeysAPI manager launches HTTP autoreg and consumes its result contract');
has(proxy, /handleAkAutoregStop[\s\S]*?taskkill\.exe[\s\S]*?\/T[\s\S]*?\/F/,
  'AIKeysAPI autoreg has a process-tree stop path');
has(autoAdd, /sessionCookie:\s*cookie[\s\S]*?api_key:\s*rawKey/,
  'autoreg writes both login cookie and API key into the shared pool record');
for (const match of proxy.matchAll(/const GH_POOL_(?:LOADERS|FILES|SAVERS|LABELS)\s*=\s*\{([^}]*)\}/g)) {
  check(!/\bak\s*:|aikeysapi/i.test(match[1]), `AIKeysAPI is absent from ${match[0].match(/GH_POOL_[A-Z]+/)[0]}`);
}

// 3. Manual account management, session opening, model map, keepalive, and PID tracking.
has(proxy, /function handleAkAdd\([\s\S]*?aikeysapi manual add/,
  'manual AIKeysAPI account-add handler exists');
has(proxy, /function handleAkSessionOpen\([\s\S]*?aikeysapi['"], ['"]open-session\.js['"]/,
  'AIKeysAPI session-open handler launches its provider script');
has(proxy, /AK_MODELMAP_FILE\s*=\s*path\.join\(__dirname, ['"]aikeysapi-modelmap\.json['"]\)/,
  'AIKeysAPI modelmap is wired into the proxy');
has(proxy, /makeKeepaliveHandlers\(Number\(process\.env\.AK_KEEPALIVE_PORT \|\| 20165\)\)/,
  'AIKeysAPI keepalive handlers use port 20165');
has(proxy, /const akLkPids\s*=\s*new Map\(\)/,
  'AIKeysAPI browser PIDs have a dedicated akLkPids map');
has(proxy, /\[arLkPids,[\s\S]*?akLkPids[\s\S]*?\]/,
  'akLkPids participates in shared browser-process checks');
has(lifecycle, /\{\s*port:\s*20165,\s*name:\s*['"]AIKeysAPI keepalive['"],\s*respawn:\s*false\s*\}/,
  'lifecycle tracks AIKeysAPI keepalive as on-demand');
has(keepalive, /FLAT_RATE_HOSTS\s*=\s*new Set\(\[[^\]]*['"]www\.aikeysapi\.com['"]/,
  'keepalive protects flat-rate AIKeysAPI from paid hedging');

// 4. Authentication and accounting integration.
has(account, /['"]www\.aikeysapi\.com['"]:\s*['"]classic['"]/,
  'newapi account helper uses classic auth for AIKeysAPI');
has(balance, /\{\s*id:\s*['"]ak['"],\s*file:\s*['"]aikeysapi-sessions\.json['"],\s*name:\s*['"]AIKeysAPI['"]\s*\}/,
  'hub balance includes the AIKeysAPI session pool');

// 5. Exactly one sidebar entry and one provider panel; every ak-* DOM id is unique.
check(count(dashboard, /data-tab="aikeysapi"/g) === 1,
  'dashboard has exactly one AIKeysAPI sidebar entry');
const panelMatches = [...dashboard.matchAll(/<div data-tab-content="aikeysapi">([\s\S]*?)<!-- ═+ TAB:/g)];
check(panelMatches.length === 1, 'dashboard has exactly one AIKeysAPI panel');
const ids = [...dashboard.matchAll(/\bid="(ak-[^"]+)"/g)].map(m => m[1]);
const duplicateIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
check(ids.length > 0 && duplicateIds.length === 0,
  `AIKeysAPI panel IDs are unique${duplicateIds.length ? ` (duplicates: ${duplicateIds.join(', ')})` : ''}`);

// 6. The panel has owner controls plus autoreg, but still no GitHub/Outlook machinery.
const panel = panelMatches[0] ? panelMatches[0][1] : '';
check(panel.length > 0 && !/GitHub|Outlook/i.test(panel),
  'AIKeysAPI panel contains no GitHub or Outlook controls');
has(panel, /id="ak-autoreg-start"[\s\S]*?id="ak-autoreg-stop"[\s\S]*?id="ak-autoreg-status"/,
  'AIKeysAPI panel has start, stop, and status controls for autoreg');
has(dashboard, /const AK_MODELS\s*=\s*\[['"]gpt-5\.6-terra['"],\s*['"]gpt-5\.6-sol['"],\s*['"]gpt-5\.6-luna['"]\]/,
  'dashboard allowlists terra, sol, and luna models');
has(modelmapText, /^\s*\{\s*"opus":\s*"gpt-5\.6-terra",\s*"sonnet":\s*"gpt-5\.6-terra",\s*"haiku":\s*"gpt-5\.6-terra"\s*\}\s*$/,
  'AIKeysAPI modelmap maps every claude tier to an allowed model');
let modelmap;
try { modelmap = JSON.parse(modelmapText); }
catch (error) { check(false, `aikeysapi-modelmap.json parses as JSON (${error.message})`); modelmap = {}; }
const allowedModels = new Set(['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna']);
check(Object.keys(modelmap).length > 0 && Object.values(modelmap).every(v => allowedModels.has(v)),
  'every AIKeysAPI modelmap target is terra, sol, or luna');

// 7. Referral code stays a static repo default; it is never used to create accounts.
has(refDefaults, /"aikeysapi":\s*"[A-Za-z0-9]+"/,
  'ref-codes default file carries a static AIKeysAPI code');

// 8. open-session.js takes credentials only from the environment and shows a real window.
has(openSession, /Email и пароль берутся только из AK_LK_EMAIL и AK_LK_PASS\. В argv они не передаются\./,
  'open-session documents env-only credential handling');
has(openSession, /process\.env\.AK_LK_EMAIL/, 'open-session reads AK_LK_EMAIL from the environment');
has(openSession, /process\.env\.AK_LK_PASS/, 'open-session reads AK_LK_PASS from the environment');
check(!/process\.argv\s*\[\s*[2-9]\s*\][^\n]*(?:EMAIL|PASS|email|pass)/.test(openSession),
  'open-session never accepts credentials via argv');
has(openSession, /headless:\s*false/, 'open-session runs a visible browser, not headless');
has(openSession, /viewport:\s*null/, 'open-session keeps the real window viewport');
has(openSession, /--window-size=\d+,\d+/, 'open-session sets an explicit window size');
has(openSession, /await page\.bringToFront\(\)/, 'open-session brings its page to the front');
has(openSession, /raiseBrowserWindow\(\)/, 'open-session raises the OS window for the owner');
has(proxy, /AK_LK_EMAIL:\s*String\(target\.email \|\| ['"]{2}\),\s*AK_LK_PASS:\s*String\(target\.password \|\| ['"]{2}\)/,
  'proxy passes AIKeysAPI credentials only through the child environment');

console.log(`\n${checks - failures}/${checks} assertions passed`);
if (failures > 0) {
  console.error(`FAIL: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('PASS: AIKeysAPI integration is wired safely');
process.exit(0);
