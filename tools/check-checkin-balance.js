#!/usr/bin/env node
// Regression: browser relogin harvests cookies once, closes, then the parent forces the
// ordinary cookie/raw-auth balance path. Browser UI balance is never source of truth.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
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
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return '';
}

console.log('\n1. browser does not calculate or wait for balance');
const main = cutFn(sessionSrc, 'async function main(');
const checkinStart = main.indexOf("if (mode === 'checkin' || mode === 'autocheckin')");
const checkinEnd = main.indexOf('// Импортированная чужая сессия', checkinStart);
const checkinMain = checkinStart >= 0 && checkinEnd > checkinStart ? main.slice(checkinStart, checkinEnd) : '';
check(!/watchSelfResponses\(|readBaselineSelf\(|reloadForFreshSelf\(|captureSelfSnapshot\(/.test(checkinMain),
    'checkin main has no browser self watcher, baseline, reload wait, or snapshot capture');
check(!/marker\.self|self:\s*selfSnap/.test(sessionSrc), 'AUTOCHECKIN_RESULT carries no browser balance snapshot');
check(!/GIFT_RELOAD_ATTEMPTS|GIFT_TOTAL_BUDGET_MS|waitBalanceRendered/.test(sessionSrc),
    'browser balance wait machinery is removed');

console.log('\n2. successful relogin harvests cookies exactly once before closing');
const harvestCalls = (checkinMain.match(/await harvestCookiesToJar\(context\)/g) || []).length;
check(harvestCalls === 1, `exactly one cookie harvest in main (got ${harvestCalls})`);
const harvestAt = checkinMain.indexOf('await harvestCookiesToJar(context)');
const closeAt = checkinMain.indexOf('await context.close()', harvestAt);
const markerAt = checkinMain.indexOf('AUTOCHECKIN_RESULT', closeAt);
check(harvestAt >= 0 && closeAt > harvestAt, 'cookies harvested before Chromium closes');
check(markerAt > closeAt, 'success marker emitted after browser closes');

console.log('\n3. parent immediately forces ordinary balance after browser exit');
const finish = cutFn(dashSrc, 'async function arAutoCheckinFinish(');
check(!/marker\.self|selfSnapshot|\bsnap\b/.test(finish), 'finish ignores browser balance snapshots');
check(/await new Promise\(r => setTimeout\(r,\s*2000\)\)/.test(finish), 'short cookie flush delay remains');
check(/arBalanceOnce\(target\.api_key,\s*true\)/.test(finish), 'ordinary balance path is forced');
const delayAt = finish.indexOf('await new Promise');
const balanceAt = finish.indexOf('arBalanceOnce(target.api_key, true)');
check(delayAt >= 0 && balanceAt > delayAt, 'forced balance runs immediately after flush delay');
check(!/arBalanceOnce\(target\.api_key,\s*true,/.test(finish), 'no snapshot argument is passed');

console.log(fail ? `\n❌ ${fail} failed` : '\n✅ Browser relogs/harvests once; parent forces cookie/raw-auth balance.');
process.exit(fail ? 1 : 0);
