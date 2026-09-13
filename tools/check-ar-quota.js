#!/usr/bin/env node
/** Regression for the manual AgentRouter Opus quota probe. */
'use strict';

const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const HTML = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
const src = fs.readFileSync(DASH, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');
const { classifyArQuotaProbe, AR_QUOTA_BODY, AR_QUOTA_CYCLE_MS, AR_QUOTA_ANCHOR_MS,
        arQuotaDropAt, arQuotaKeyTail, buildArQuotaCache, isArQuotaCacheFresh,
        pickFresherArQuota } = require('../routing/lib/ar-quota-probe');

const fails = [];
const ok = [];
function check(cond, msg) { (cond ? ok : fails).push(msg); }

check(src.includes("'/__switch/api/ar/quota-check'"), 'POST quota-check route exists');
check(src.includes("require('./lib/ar-quota-probe')"), 'dashboard uses quota probe module');
check(AR_QUOTA_BODY.model === 'claude-opus-5', 'probe pins claude-opus-5');
check(AR_QUOTA_BODY.max_tokens === 1, 'probe limits output to one token');
check(AR_QUOTA_BODY.messages?.[0]?.content === '1', 'probe uses minimal input');
check(classifyArQuotaProbe(200, '{}').state === 'available', '2xx means quota available');
check(classifyArQuotaProbe(402, '{"error":{"message":"402 Budget pool quota has been exhausted."}}').state === 'exhausted', 'canonical 402 means quota exhausted');
check(classifyArQuotaProbe(402, '{"error":"account disabled"}').state === 'error', 'unrelated 402 stays an error');
check(classifyArQuotaProbe(500, 'oops').state === 'error', 'other failures stay errors');
check(src.includes('AR_ACTIVE_KEY_FILE'), 'probe reads active key server-side');
const uiHandler = html.slice(html.indexOf('window.arqCheckQuota'), html.indexOf('\nfunction init()', html.indexOf('window.arqCheckQuota')));
check(!/ar-active-key|api_key|x-api-key/i.test(uiHandler), 'browser handler never reads or sends the key');

check(html.includes('id="arq-check"'), 'manual check button is under quota clock');
check(html.includes('id="arq-check-result"'), 'inline result exists');
check(html.includes('async function arqCheckQuota('), 'manual click handler exists');
check(html.includes("fetch('/__switch/api/ar/quota-check'"), 'UI calls server route');
check(html.includes("arqState('burned')"), 'exhausted result marks clocks burned');
check(html.includes("arqState('fresh')"), 'available result marks clocks fresh');

// ── Quota dial schedule: three batches a day since 2026-09-10 (MSK 03/11/19, 8h step).
// Статика по HTML: сетку в браузере из регресса не прогонишь, но следы старой
// двухпартийной сетки ловятся точным вхождением строк.
check(html.includes('const CYCLE = 8 * 3600 * 1000'), 'dial cycle is 8 hours');
check(html.includes('Date.UTC(1970, 0, 1, 16, 0, 0)'), 'dial anchor is 16:00 UTC = 19:00 MSK');
check(!html.includes('const CYCLE = 12 * 3600 * 1000'), 'old 12h cycle is gone');
check(!html.includes('02:00 и 14:00'), 'old two-batch wording is gone');
check(!html.includes("[2,'02']") && !html.includes("[14,'14']"), 'old day marks 02/14 are gone');
check(html.includes("[3,'03']") && html.includes("[11,'11']") && html.includes("[19,'19']"), 'day dial marks 03/11/19');
check(html.includes('const n = m ? 8 : 32'), 'term dial draws 32 segments (8h × 15m), mini 8');
check(html.includes('(toA - 120 + 360) % 360'), 'day arc is the 120° sector ending on the batch');
check(!html.includes('(toA + 120) % 360'), 'old +120 arc (240°, wrong direction) is gone');
check(html.includes("'вечерняя'"), 'day caption names all three batches');
check(html.includes("x.id === 'day'"), 'default dial falls back to day');
check(html.includes("ar-quota-dial2"), 'dial choice key bumped to gen2 — day default reaches everyone');
check(html.includes('localStorage.removeItem(KEY_OLD)'), 'old dial choice key is cleaned up');
check(html.includes('тремя партиями'), 'mini tooltip says three batches');
check(html.includes('Три партии в сутки'), 'big caption says three batches');

// ── Кеш результата проверки (2026-09-12) ──────────────────────────────────
// Инвалидация по ПАРТИИ, а не по TTL. Точки взяты в UTC, чтобы регресс не зависел
// от таймзоны машины: 08:00 UTC = дневная партия 11:00 МСК.
const DROP = Date.UTC(2026, 8, 12, 8, 0, 0);          // партия 11:00 МСК
const NEXT_DROP = DROP + AR_QUOTA_CYCLE_MS;           // партия 19:00 МСК
check(AR_QUOTA_CYCLE_MS === 8 * 3600 * 1000, 'cache grid cycle is 8 hours');
check(AR_QUOTA_ANCHOR_MS === Date.UTC(1970, 0, 1, 16, 0, 0), 'cache grid anchor is 16:00 UTC');
// Обе копии сетки обязаны совпадать: у циферблата своя в HTML (самодостаточный IIFE).
check(html.includes('const dropAt = t => t - (((t - ANCHOR) % CYCLE + CYCLE) % CYCLE)'),
      'browser cache reuses the dial CYCLE/ANCHOR instead of duplicating numbers');
check(arQuotaDropAt(DROP + 3600_000) === DROP, 'dropAt snaps to the batch that already happened');
check(arQuotaDropAt(DROP - 1) === DROP - AR_QUOTA_CYCLE_MS, 'dropAt before a batch points at the previous one');
check(arQuotaDropAt('nope') === null, 'dropAt rejects garbage');

const AVAIL = buildArQuotaCache({ state: 'available' }, 'sk-abcdef1234', DROP + 60_000);
check(AVAIL.state === 'available' && AVAIL.keyTail === '1234', 'cache entry keeps state and key tail');
check(!JSON.stringify(AVAIL).includes('sk-abcdef'), 'cache never stores the full key');
check(Date.parse(AVAIL.dropAt) === DROP, 'cache entry records its batch');
check(buildArQuotaCache({ state: 'error', error: 'boom' }, 'sk-1', DROP) === null, 'errors are not cached');
check(buildArQuotaCache({ state: 'exhausted' }, 'sk-1', DROP).state === 'exhausted', 'exhausted is cached');
check(arQuotaKeyTail('sk-xyz9876') === '9876' && arQuotaKeyTail('ab') === 'ab', 'key tail is last four chars');

check(isArQuotaCacheFresh(AVAIL, DROP + 3600_000, '1234'), 'entry stays fresh inside the same batch');
check(isArQuotaCacheFresh(AVAIL, NEXT_DROP - 1000, '1234'), 'entry survives until the very next drop');
check(!isArQuotaCacheFresh(AVAIL, NEXT_DROP, '1234'), 'entry dies exactly at the next drop');
check(!isArQuotaCacheFresh(AVAIL, DROP + 60_000, '9999'), 'entry dies when the active key changed');
check(isArQuotaCacheFresh(AVAIL, DROP + 60_000, ''), 'unknown active key does not invalidate the entry');
check(!isArQuotaCacheFresh({ ...AVAIL, checkedAt: 'x' }, DROP + 60_000, '1234'), 'unparseable checkedAt is not fresh');
check(!isArQuotaCacheFresh({ ...AVAIL, state: 'error' }, DROP + 60_000, '1234'), 'error state is never fresh');
check(!isArQuotaCacheFresh(null, DROP, '1234'), 'missing entry is not fresh');

const OLDER = { ...AVAIL, checkedAt: new Date(DROP + 10_000).toISOString() };
const NEWER = { ...AVAIL, state: 'exhausted', checkedAt: new Date(DROP + 90_000).toISOString() };
check(pickFresherArQuota(OLDER, NEWER) === NEWER, 'fresher checkedAt wins regardless of layer');
check(pickFresherArQuota(NEWER, OLDER) === NEWER, 'layer order does not decide the winner');
check(pickFresherArQuota(null, OLDER) === OLDER, 'missing local falls back to remote');
check(pickFresherArQuota(OLDER, null) === OLDER, 'missing remote keeps local');
check(pickFresherArQuota(null, null) === null, 'nothing cached stays nothing');

check(src.includes("'/__switch/api/ar/quota-state'"), 'GET quota-state route exists');
check(src.includes('AR_QUOTA_STATE_FILE'), 'server caches the probe result to disk');
check(src.includes('buildArQuotaCache'), 'server builds the cache entry from the probe');
check(src.includes('isArQuotaCacheFresh'), 'server validates freshness before serving cache');
check(html.includes("const KEY_ST = 'ar-quota-state'"), 'browser cache has its own storage key');
check(html.includes("fetch('/__switch/api/ar/quota-state')"), 'browser reads the shared cache');
check(html.includes('stExpire(c.t)'), 'dial tick expires the cache when a batch lands');
check(html.includes('проверено в'), 'restored result says it is a past check');
const stHandler = html.slice(html.indexOf('function stApply'), html.indexOf('window.arqCheckQuota'));
check(!/api_key|x-api-key|sk-/i.test(stHandler), 'browser cache never touches keys');

for (const msg of ok) console.log('OK  ' + msg);
for (const msg of fails) console.error('FAIL ' + msg);
console.log(`\n${ok.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
