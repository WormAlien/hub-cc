#!/usr/bin/env node
// Regression: AgentRouter relogin always uses a direct browser. Proxy fallback belongs
// only to the post-browser HTTP balance path in routing/lib/newapi-account.js.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SESSION = require(path.join(ROOT, 'agentrouter', 'open-session.js'));
const sessionSrc = fs.readFileSync(path.join(ROOT, 'agentrouter', 'open-session.js'), 'utf8').replace(/\r\n/g, '\n');
const dashSrc = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
function check(ok, what) {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
}
function cutFn(src, head) {
    const start = src.indexOf(head);
    if (start < 0) return '';
    const brace = src.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < src.length; i++) {
        if (src[i] === '{') depth++;
        if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return '';
}

console.log('\n1. open-session has no browser proxy machinery');
check(typeof SESSION.readProxySeed === 'undefined', 'readProxySeed is not exported');
check(typeof SESSION.proxyLaunchOptions === 'undefined', 'proxyLaunchOptions is not exported');
check(!/PROXY_SEED_DIR|readProxySeed|proxyLaunchOptions/.test(sessionSrc), 'seed reader and proxy option builder are absent');
check(!/process\.exit\(7\)/.test(sessionSrc), 'browser-proxy exit code 7 is absent');

console.log('\n2. Chromium launch is direct while sticky UA remains');
const main = cutFn(sessionSrc, 'async function main(');
const launchAt = main.indexOf('chromium.launchPersistentContext');
const launchEnd = main.indexOf('});', launchAt);
const launch = launchAt >= 0 && launchEnd >= 0 ? main.slice(launchAt, launchEnd + 3) : '';
check(launchAt >= 0, 'launchPersistentContext found');
check(!/\bproxy\s*:|launchProxy|proxySeed/.test(launch), 'launch options contain no proxy');
check(/accountUserAgent\(/.test(main) && /userAgent:\s*ua/.test(launch), 'sticky account UA remains wired');
check(/Network\.setUserAgentOverride/.test(main) && /userAgentMetadata:\s*uaMetadata\(ua\)/.test(main),
    'matching CDP userAgentMetadata remains wired');

console.log('\n3. parent spawns immediately without proxy resolution or seed files');
const spawn = cutFn(dashSrc, 'function arSpawnSession(') || cutFn(dashSrc, 'async function arSpawnSession(');
check(spawn.length > 0, 'arSpawnSession found');
check(/spawn\(process\.execPath/.test(spawn), 'open-session child is spawned');
check(!/arResolveCheckinProxy|accountProxy|arWriteProxySeed|arClearProxySeed|seedWritten/.test(spawn),
    'spawn path does not resolve, write, or clean browser proxy seed');
check(!/AR_CHECKIN_PROXY_DIR|ar-proxy/.test(dashSrc), 'browser proxy seed directory is absent');
check(!/\b7\s*:.*прокси|code\s*===\s*7/.test(dashSrc), 'dashboard has no browser-proxy code 7 handling');

console.log(fail ? `\n❌ ${fail} failed` : '\n✅ AgentRouter browser relogin is direct; sticky UA and CDP hints remain.');
process.exit(fail ? 1 : 0);
