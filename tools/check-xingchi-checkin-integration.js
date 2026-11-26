'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const proxy = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'routing', 'proxy-dashboard.html'), 'utf8');
const requiredBackend = [
  '/__switch/api/xc/checkin-status', '/__switch/api/xc/checkin-claim',
  '/__switch/api/xc/checkin-all', '/__switch/api/xc/checkin-cancel',
  '/__switch/api/xc/checkin-config', '/__switch/api/xc/checkin-mark',
  '/__switch/api/xc/checkin-events',
  'createXingchiCheckin', 'createXingchiCheckinRunner', 'withSession: createXingchiPanelSession',
  'checkin-config',
];
const requiredUi = [
  'id="xc-checkin"', 'id="xc-checkin-journal"', 'xcCheckinClaim',
  'xcCheckinAll', 'xcCheckinCancel', 'xcCheckinSaveConfig',
  'Asia/Shanghai', 'Claim',
];
for (const marker of requiredBackend) assert.match(proxy, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `backend marker: ${marker}`);
for (const marker of requiredUi) assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `UI marker: ${marker}`);
assert.doesNotMatch(html, /lottery|blindbox|blind box/i, 'Xingchi daily feature must not expose lottery/blind-box actions');
console.log('PASS Xingchi check-in integration contract');
