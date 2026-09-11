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

for (const msg of ok) console.log('OK  ' + msg);
for (const msg of fails) console.error('FAIL ' + msg);
console.log(`\n${ok.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
