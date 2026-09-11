#!/usr/bin/env node
/** Regression for the manual AgentRouter Opus quota probe. */
'use strict';

const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const HTML = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
const src = fs.readFileSync(DASH, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');
const { classifyArQuotaProbe, AR_QUOTA_BODY } = require('../routing/lib/ar-quota-probe');

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
check(html.includes('(toA + 120) % 360'), 'day pre-batch highlight is a third of the circle');
check(html.includes("'вечерняя'"), 'day caption names all three batches');
check(html.includes("x.id === 'day'"), 'default dial falls back to day');
check(html.includes('тремя партиями'), 'mini tooltip says three batches');
check(html.includes('Три партии в сутки'), 'big caption says three batches');

for (const msg of ok) console.log('OK  ' + msg);
for (const msg of fails) console.error('FAIL ' + msg);
console.log(`\n${ok.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
