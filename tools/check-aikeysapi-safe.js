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

// Комментарии вырезаются перед негативными утверждениями. 🪤 Это не педантизм: пояснение
// к правке называет сломанный вызов текстом («здесь стояло `loadAkSessions()`»), и без
// зачистки проверка срабатывает на собственном объяснении, а не на коде. Поймано дважды
// подряд на разных файлах — поэтому вынесено в общий помощник.
function stripComments(text) { return String(text).replace(/\/\/[^\n]*/g, ''); }

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
const validatorCli = read('tools/proxy-validator/proxy_scraper/find_for_host.py');
const openSession = read('aikeysapi/open-session.js');
const autoAdd = read('aikeysapi/auto-add.js');
const refreshSessions = read('aikeysapi/refresh-sessions.js');

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
has(autoAdd, /api_key:\s*rawKey[\s\S]*?sessionCookie:\s*cookie/,
  'autoreg writes both login cookie and API key into the shared pool record');
// Every successful account must be persisted before the next loop iteration. Keep this
// static guard close to the record-shape checks so a future batch refactor is visible.
const akMain = (autoAdd.match(/async function main\(\)[\s\S]*?\n\}\n\nif \(require\.main === module\)/) || [''])[0];
check(akMain.length > 0, 'AIKeysAPI autoreg main() is found');
const successPos = akMain.indexOf('if (res.ok)');
const appendPos = akMain.indexOf('poolAppend([rec])', successPos);
const gapPos = akMain.indexOf('await sleep(GAP_MS)', appendPos);
check(successPos >= 0 && appendPos > successPos && gapPos > appendPos,
  'each successful AIKeysAPI account is persisted before the next account starts');
check(!/written\s*=\s*poolAppend\(created\)/.test(akMain),
  'AIKeysAPI autoreg does not defer pool persistence until the batch ends');
has(akMain, /const n = poolAppend\(\[rec\]\)[\s\S]{0,80}?written \+= n/,
  'AIKeysAPI written count uses each duplicate-aware poolAppend result');
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
has(panel, /id="ak-autoreg-proxy"[\s\S]*?id="ak-autoreg-proxy-label"/,
  'AIKeysAPI panel has a proxy/direct toggle for autoreg');
has(panel, /id="ak-autoreg-count"[\s\S]*?id="ak-autoreg-start"/,
  'AIKeysAPI panel has an inline account-count field left of the start button');
has(panel, /id="ak-autoreg-find"[\s\S]*?akAutoregFindProxy/,
  'AIKeysAPI panel has a live-proxy search button');
has(proxy, /function akFindProxyLaunch[\s\S]{0,1200}?find_for_host/,
  'proxy runs the validator CLI to refresh the proxy list for the target host');
check(!/prompt\(['"]Сколько AIKeysAPI/.test(dashboard),
  'dashboard no longer asks for the account count through a prompt');
has(dashboard, /body:\s*JSON\.stringify\(\{\s*count,\s*useProxy\s*\}\)/,
  'dashboard sends the proxy choice with the autoreg request');
has(proxy, /body\.useProxy\s*!==\s*false[\s\S]*?args\.push\(['"]--no-proxy['"]\)/,
  'proxy honours useProxy=false by passing --no-proxy to the autoreg script');
has(autoAdd, /const PANEL_BRAND_RE[\s\S]*?function isPanelMail\(from, subject/,
  'autoreg recognises panel mail by brand, not only by sender address');
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

// 9. Autoreg progress is machine-readable, and the UI actually renders the run log.
//
// The stage indicator must never be derived from the Russian log prose: those strings
// get reworded, and a regex over them would keep rendering a stale step without ever
// failing loudly. The marker below is the contract that keeps that honest.
has(autoAdd, /console\.log\('AK_STAGE ' \+ JSON\.stringify\(payload\)\)/,
  'autoreg emits a machine-readable AK_STAGE marker');
has(autoAdd, /const STAGES = \[[^\]]*'mail'[^\]]*'otp_wait'[^\]]*'register'[^\]]*'login'[^\]]*'token'[^\]]*'key'[^\]]*'self'[^\]]*\]/,
  'autoreg declares the full stage sequence');
check(/at\('mail'\)/.test(autoAdd) && /at\('otp_wait'\)/.test(autoAdd) && /at\('register'\)/.test(autoAdd)
  && /at\('login'\)/.test(autoAdd) && /at\('token'\)/.test(autoAdd) && /at\('key'\)/.test(autoAdd)
  && /at\('self'\)/.test(autoAdd),
  'autoreg marks every stage of the account lifecycle');
has(autoAdd, /stage\('done',/, 'autoreg emits a terminal stage so the indicator does not stick');
has(proxy, /line\.startsWith\('AK_STAGE '\)[\s\S]{0,400}?akAutoreg\.stage = \{ \.\.\.s,/,
  'dashboard backend parses AK_STAGE the same way it parses AK_AUTOADD_RESULT');
// The marker is protocol, not prose: if the AK_STAGE branch stops short-circuiting, every
// marker lands in the log panel the owner reads, one noise line per step.
has(proxy, /line\.startsWith\('AK_STAGE '\)[\s\S]{0,500}?continue;\s*\n\s*\}/,
  'AK_STAGE markers are kept out of the human-facing log buffer');
has(proxy, /stage:\s*akAutoreg\.stage,/, 'autoreg status endpoint exposes the current stage');
has(dashboard, /d\.stdout.*join\('\\n'\)|out\.join\('\\n'\)/,
  'dashboard renders autoreg stdout instead of dropping it');
has(dashboard, /id="ak-autoreg-log"/, 'AIKeysAPI panel has a log element');
has(dashboard, /id="ak-autoreg-stage"/, 'AIKeysAPI panel has a stage indicator element');

// 10. Proxy counter reports what the pool will really hand out.
//
// Counting lines in the file would overstate the pool: unparseable entries are dropped
// into `bad`, and the number is read right before a batch run — exactly when a wrong
// count costs accounts.
has(proxy, /function handleAkProxyPool[\s\S]{0,600}?lib\.describe\(\)/,
  'proxy-pool endpoint reports describe(), not a file line count');
has(proxy, /enabledForHost:\s*lib\.enabledForHost\('www\.aikeysapi\.com'\)/,
  'proxy-pool endpoint reports whether the pool is armed for the panel host');
has(proxy, /'\/__switch\/api\/ak\/proxy-pool'\) return handleAkProxyPool/,
  'proxy-pool endpoint is routed');
has(dashboard, /id="ak-proxy-badge"/, 'AIKeysAPI panel shows a proxy counter badge');
has(dashboard, /n < want \? 'amber'/, 'proxy badge warns when the pool cannot cover the batch');

// 11. The autoreg status poll must not recurse back into the full session loader.
//
// `loadAkSessions()` cascades into `akAutoregStatus()`, and `akAutoregStatus()` refreshes
// the table once a run that created accounts has finished. Pointing that refresh at the
// full loader closed the loop: twenty-odd renders per second, DOM replaced under the
// cursor, hover flickering and clicks landing on detached nodes. It only armed itself
// after a successful autoreg, which is why the tab looked fine until something was made.
const akStatusBody = (dashboard.match(/async function akAutoregStatus\([\s\S]*?\n\}/) || [''])[0];
// Комментарии вырезаем: в пояснении к этой же правке `loadAkSessions()` назван текстом,
// и без зачистки проверка срабатывала бы на собственном объяснении, а не на коде.
const akStatusCode = stripComments(akStatusBody);
check(akStatusBody.length > 0, 'akAutoregStatus() is found in the dashboard');
has(akStatusCode, /loadAkSessionsLight\(/,
  'autoreg status refreshes the table through the non-cascading loader');
check(!/loadAkSessions\(/.test(akStatusCode),
  'autoreg status never calls the cascading loadAkSessions() — that closes a render loop');

// 12. Mail providers are ordered by the cost of being wrong, not by best-case speed.
//
// makeInbox() returns the first provider that works, so a dead provider at the head is
// paid on EVERY account. guerrillamail's TLS handshake hangs; first in the list it burned
// 25 s of every run (48 s total for one account, 75 s for three).
const mailOrder = (autoAdd.match(/const MAIL_PROVIDERS = \[([\s\S]*?)\];/) || [, ''])[1];
check(!/guerrillamail'[\s\S]*?instanttempemail/.test(mailOrder),
  'guerrillamail is not first in MAIL_PROVIDERS — a dead provider there costs every account');
has(mailOrder, /instanttempemail'[\s\S]*?mail\.tm'[\s\S]*?guerrillamail'/,
  'mail providers run fastest-first with the hanging one kept as last-resort fallback');

// 13. The proxy endpoint exposes the addresses, not just their number.
has(proxy, /proxies:\s*list,/, 'proxy-pool endpoint returns the proxy addresses themselves');
has(dashboard, /shown\.map\(\(p, i\) =>/, 'proxy badge tooltip lists the addresses it counted');

// 14. The 🌐 snapshot must carry the SPA login state, not just the session cookie.
//
// ZhiFlow is a New API SPA: it keeps "I am logged in" in localStorage (`user`) and uses the
// cookie only as transport. A snapshot with the cookie alone opens the LOGIN form while
// /api/user/self still answers 200 — measured 12.09 headless: cookie only → login,
// cookie + localStorage.user → console. Every snapshot written before this fix was broken
// in exactly that way, and the button looked like "🌐 opens a login page".
has(autoAdd, /function sessionStateFromCookie\(cookieHeaderStr, user\)/,
  'session snapshot builder accepts the SPA user object');
has(autoAdd, /localStorage:\s*\[\{\s*name:\s*'user',\s*value:\s*JSON\.stringify\(user\)/,
  'snapshot stores the SPA user object in localStorage');
has(autoAdd, /writeProfileSession\(rec\.id, rec\.sessionCookie, rec\.spaUser\)/,
  'autoreg passes the SPA user state into the snapshot writer');
has(autoAdd, /delete rec\.spaUser/,
  'SPA user state is stripped before the record reaches the pool');has(refreshSessions, /function snapshotHasSpaUser\(file\)/,
  'snapshot refresher can tell a snapshot without SPA login state');
has(refreshSessions, /snapshotHasSpaUser\(snapFile\)/,
  'a snapshot lacking SPA login state is rebuilt, not skipped as "already there"');
has(refreshSessions, /writeProfileSession\(rec\.id, r\.cookie, spaUser\)/,
  'snapshot refresher backfills the SPA user state');

// 15. Opening the cabinet must apply the snapshot whenever the profile has no session.
//
// It used to be `fresh && shared`: on any existing profile directory the snapshot was
// silently ignored, the console opened, and the script printed "already logged in" without
// checking anything. The profile directory is created by the first window open, so
// "not fresh" is the normal case, not the rare one.
has(openSession, /needSnapshot = !!shared && \(fresh \|\| !hasSessionCookie\(existingCookies\)\)/,
  'open-session applies the snapshot whenever the profile lacks a live session');
has(openSession, /async function isLoginPage\(page\)/,
  'open-session can tell a login form from a logged-in console');
check(count(openSession, /if \(await isLoginPage\(page\)\)/g) === 2,
  'open-session verifies the login state in BOTH console branches instead of assuming it');
check(!/уже залогинен, если заходил раньше/.test(stripComments(openSession)),
  'open-session no longer claims "already logged in" without checking');

// 16. Protocol lines stay out of the panel the owner reads.
//
// AK_AUTOADD_RESULT is parsed into `result` and rendered as "готово N, в пул M, ошибок K".
// Left in the buffer it showed up as a raw JSON blob across the log panel.
has(proxy, /line\.startsWith\('AK_AUTOADD_RESULT '\)[\s\S]{0,160}?continue;/,
  'AK_AUTOADD_RESULT is kept out of the human-facing log buffer');

// 17. The proxy search must be interruptible and must show progress while it runs.
//
// It used to hold the HTTP response for the whole run (minutes) with a static "ищу…": no
// counter, and no way to stop it. Scraping + validating is long, so the start call now
// returns immediately and the frontend polls.
has(proxy, /'\/__switch\/api\/ak\/autoreg\/find-proxy\/stop'\) return handleAkFindProxyStop/,
  'proxy search has a stop endpoint');
has(proxy, /function handleAkFindProxyStop[\s\S]{0,700}?taskkill\.exe[\s\S]{0,200}?\/T[\s\S]{0,80}?\/F/,
  'proxy search stop kills the whole validator process tree');
has(proxy, /if \(req\.method === 'GET'\s*&& req\.url === '\/__switch\/api\/ak\/autoreg\/find-proxy'\)/,
  'proxy search exposes a progress endpoint');
has(proxy, /akFindProxy\.found\.push\(m\[1\]\)/,
  'validator output is parsed for live progress, not just the final JSON');
has(proxy, /akFindProxy\.checked = Number\(m\[1\]\)/,
  'the parse also tracks how many candidates were checked');
has(proxy, /akFindProxy\.stopRequested\) \{[\s\S]{0,700}?akCommitPartialProxyLines\([\s\S]{0,200}?akFindProxy\.found/,
  'a stopped search commits already verified proxies without replacing the live pool');
has(proxy, /'-u',\s*\/\/ без буферизации/,
  'validator runs unbuffered so progress lines arrive during the run, not all at the end');
has(dashboard, /id="ak-proxy-stop"/, 'AIKeysAPI panel has a stop button for the proxy search');
has(dashboard, /d\.total \? ` · проверено \$\{d\.checked\}\/\$\{d\.total\}`/,
  'proxy search shows how many candidates were checked');
has(dashboard, /const AK_FIND_FLOOR = \d+/,
  'proxy search targets a pool floor, not just "accounts + 2"');

// 18. The search target must refill the pool, not merely cover one batch.
check(
  (dashboard.match(/const AK_FIND_FLOOR = (\d+)/) || [, '0'])[1] >= 10,
  'the proxy pool floor is at least 10 — a pool of three dies within minutes');

// 19. Long runs must top the pool up in the background, and the pool file must be MERGED.
//
// A 50-account run is ~25 minutes; public proxies live minutes. A pool filled once up front
// is empty halfway through. The pool re-reads its file by mtime stamp, so a background
// refill lands without a restart.
//
// 🔴 Merging is not a preference. Assignment is sticky and forAccount() refuses a proxy
// that vanished from the pool ("I will not substitute another"), so OVERWRITING the file
// would orphan every account already assigned. Newest-first plus a cap keeps the file
// bounded — otherwise dead entries pile up and leastLoaded starts handing out corpses.
has(proxy, /const AK_REFILL_RESERVE = (\d+)/, 'background refill keeps a reserve ahead of the queue');
check((proxy.match(/const AK_REFILL_RESERVE = (\d+)/) || [, '0'])[1] >= 5,
  'the refill reserve is meaningful (at least 5 live proxies in front of the queue)');
has(proxy, /function akMergeProxyLines\(fresh, old, cap = AK_PROXY_CAP\)/,
  'the pool file is merged, not overwritten');
has(proxy, /akMergeProxyLines\(fresh, old\)[\s\S]{0,200}?writeFileSync\(AK_LIVE_PROXY_FILE/,
  'merged lines are what gets written back to the live pool file');
has(proxy, /'--out', AK_PROXY_TMP_FILE/, 'the validator writes to a temp file, never over the live pool');
has(proxy, /if \(useProxy\) akRefillStart\(\);/, 'the refill starts with the autoreg run, only in proxy mode');
// Считаем ОБА места: страж в тике и крючок на выходе прогона. Проверка «хотя бы одно»
// пропускала снятие одного из них — поймано саботажем.
check(count(proxy, /akRefillStop\('прогон завершён'\)/g) === 2,
  'the refill stops when the run ends — both on exit and in the tick guard');
has(proxy, /const done = Number\(\(akAutoreg\.stage && akAutoreg\.stage\.i\)/,
  'the refill budget is computed from real run progress, not a guess');

// 20. A dry pool must PAUSE the run, not burn the account (owner's decision 12.09).
//
// By the time a proxy is needed the account already cost a mailbox and often a registration,
// so waiting beats losing it. The background refill is what makes waiting finite.
has(autoAdd, /async function acquireProxyFor\(email, \{ noProxy, index, count \}\)/,
  'proxy acquisition knows which account it is working on');
has(autoAdd, /while \(!others\.length && Date\.now\(\) < deadline\)/,
  'a dry pool makes the run wait for the refill instead of failing the account');
// Два вхождения обязательны: одно — до цикла, второе — ВНУТРИ него. Без второго ожидание
// крутится по устаревшему снимку пула и никогда не увидит докормленных адресов.
check(count(autoAdd, /others = pp\.pool\(\)\.proxies\.filter\(x => !tried\.has\(x\.id\)\)/g) === 2,
  'the wait re-reads the pool on every poll so refilled proxies are seen');
has(autoAdd, /stage\('wait_proxy'/, 'waiting for a proxy is a visible stage, not a silent hang');
has(autoAdd, /'wait_proxy', 'register'/, 'wait_proxy is declared in the stage sequence');
has(dashboard, /wait_proxy: \['⏳', 'жду прокси'\]/, 'the dashboard labels the wait_proxy stage');

// 21. The owner asked for a search log — the run must not be a black box.
has(proxy, /log: \[\],\s*\/\/ строки валидатора как есть/, 'the search keeps a log buffer');
has(proxy, /akFindProxy\.log\.push\(s\)/, 'every validator line is captured before parsing');
has(dashboard, /id="ak-find-log"/, 'AIKeysAPI panel renders the proxy search log');
has(proxy, /'\/__switch\/api\/ak\/proxy-lines'\) return handleAkProxyPoolLines/,
  'the current pool contents are exposed, not just their count');
has(dashboard, /id="ak-find-pool-list"/, 'the panel lists the proxies actually in the pool');

// 22. The search log must have a SOURCE, and the stop button must actually kill.
//
// Both halves of this section exist because section 17 above passed on code that was
// dead: "validator output is parsed for live progress" only proved that a parser exists
// in JS, and "panel has a stop button" only proved that a button exists in HTML. Neither
// looked at the other end of the wire.
//
// Measured 13.09: the validator muted its own progress under `--json`
// (`log=(lambda *_a, **_k: None) if args.json else print`) — and `--json` is exactly how
// the backend launches it. The parser was fed nothing, so the panel showed "ищу…" for
// minutes with an empty log and zeroed counters. The fix redirects progress to stderr
// instead of dropping it, so both ends now have to stay honest about the stream split.
check(!/lambda[^\n]*:\s*None/.test(validatorCli),
  'the validator never swaps its progress logger for a no-op — that is what blinded the panel');
has(validatorCli, /file=sys\.stderr[^\n]*\bif args\.json\b|\bif args\.json\b[^\n]*file=sys\.stderr/,
  'under --json the validator sends progress to stderr instead of muting it');
has(validatorCli, /flush=True/,
  'progress lines are flushed, so they arrive during the run and not in one lump at the end');
// 🪤 Обратная сторона той же правки: увести в stderr ВСЁ — значит отобрать у бэкенда итог.
// Он берёт результат из строки, начинающейся с `{`, поэтому машинный JSON обязан остаться
// на stdout. Проверяем построчно: `file=` рядом с json.dumps — это уже перекос.
const jsonSummaryLines = validatorCli.split('\n')
  .filter(line => /json\.dumps\(|ensure_ascii=False\)\)/.test(line));
check(jsonSummaryLines.length > 0 && jsonSummaryLines.every(line => !/file=/.test(line)),
  'the machine-readable summary still goes to stdout — that is where the backend reads the result');
// Оба потока обязаны разбираться: прогресс приходит по stderr, итоговый JSON по stdout.
// Снять один листенер — снова ослепить панель, и снова молча.
const akLaunchBody = (proxy.match(/function akFindProxyLaunch\([\s\S]*?\n\}/) || [''])[0];
check(akLaunchBody.length > 0, 'akFindProxyLaunch() is found');
check(/proc\.stdout\.on\('data'/.test(akLaunchBody) && /proc\.stderr\.on\('data'/.test(akLaunchBody),
  'the launcher parses BOTH stdout and stderr — progress and the final JSON travel separately');

// 23. The stop handler must call a function that exists, and say so when the kill fails.
//
// Measured 13.09: `handleAkFindProxyStop` called a bare `execFile(...)`, which the module
// never imports — only `execFileSync` (line 17) and `execFileAsync` (line 27). The
// ReferenceError landed in the neighbouring `catch { }`, the handler answered
// `{ok: true, stopped: true}`, and the validator kept running. The correct shape was
// already three lines away in handleAkAutoregStop, which is why "a stop button exists"
// was never the assertion worth making.
const akStopBody = (proxy.match(/function handleAkFindProxyStop\([\s\S]*?\n\}/) || [''])[0];
const akStopCode = stripComments(akStopBody);
check(akStopBody.length > 0, 'handleAkFindProxyStop() is found');
has(akStopCode, /execFileAsync\('taskkill\.exe'/,
  'the search stop kills the validator through execFileAsync — the helper the module actually declares');
check(!/(^|[^A-Za-z])execFile\(/.test(stripComments(proxy)),
  'no handler calls a bare execFile() — it is not imported, and the ReferenceError died inside a catch');
has(akStopCode, /execFileAsync\([\s\S]{0,240}?\.catch\(\([^)]*\)\s*=>\s*logLine\(/,
  'a taskkill that fails to kill is reported through logLine, not swallowed');
check(!/catch\s*(\([^)]*\))?\s*\{\s*(\/\*[\s\S]*?\*\/)?\s*\}/.test(akStopBody),
  'the stop handler has no swallowing catch — a failed kill must not read as stopped: true');

console.log(`\n${checks - failures}/${checks} assertions passed`);
if (failures > 0) {
  console.error(`FAIL: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('PASS: AIKeysAPI integration is wired safely');
process.exit(0);
