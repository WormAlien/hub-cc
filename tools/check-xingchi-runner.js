'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createXingchiCheckinRunner } = require('../routing/lib/xingchi-checkin-runner');
const scratch = process.env.HERMES_TEST_SCRATCH;
if (!scratch) throw new Error('Set HERMES_TEST_SCRATCH to isolated scratch');
fs.mkdirSync(scratch, { recursive: true });
let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}: ${error.stack || error}`); process.exitCode = 1; } }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
 await test('batch is serialized and reports each provider result without stopping on account errors', async () => {
   const active = [], peak = { value: 0 }, done = [];
   const runner = createXingchiCheckinRunner({
     checkin: { claim: async id => { active.push(id); peak.value = Math.max(peak.value, active.length); await wait(8); active.pop(); if (id === 'b') throw new Error('fixture provider failure'); done.push(id); return { amount: 1 }; } },
     accounts: () => ['a','b','c'].map(id => ({ id, name: id, api_key: 'fixture-key', status: 'live' })), gapMs: 0,
     stateFile: path.join(scratch, 'runner-batch.json'), now: () => new Date('2026-11-25T00:00:00.000Z'),
   });
   const batch = runner.enqueue(['a','b','c']);
   assert.equal(batch.queued, 3);
   await runner.waitForIdle();
   assert.equal(peak.value, 1);
   assert.deepEqual(done, ['a','c']);
   const state = runner.snapshot();
   assert.equal(state.runs.length, 3);
   assert.equal(state.runs.filter(run => run.state === 'error').length, 1);
   assert.equal(state.runs.find(run => run.id === 'b').message, 'fixture provider failure');
 });
 await test('cancel removes only waiting claims while preserving a running claim', async () => {
   let release;
   const gate = new Promise(resolve => { release = resolve; });
   const called = [];
   const runner = createXingchiCheckinRunner({ checkin: { claim: async id => { called.push(id); if (id === 'a') await gate; return { amount: 1 }; } },
     accounts: () => ['a','b','c'].map(id => ({ id, api_key: 'fixture-key', status: 'live' })), gapMs: 0, stateFile: path.join(scratch, 'runner-cancel.json') });
   runner.enqueue(['a','b','c']);
   await wait(5);
   const canceled = runner.cancel();
   assert.equal(canceled.cancelled, 2);
   release(); await runner.waitForIdle();
   assert.deepEqual(called, ['a']);
   assert.equal(runner.snapshot().runs.filter(run => run.state === 'cancelled').length, 2);
 });
 await test('Asia/Shanghai daily schedule is opt-in and enqueues only once per local date', async () => {
   const jobs = [];
   let now = new Date('2026-11-24T01:59:00.000Z');
   const runner = createXingchiCheckinRunner({ checkin: { claim: async id => ({ id }) },
     accounts: () => [{ id: 'scheduled', api_key: 'fixture-key', status: 'live' }], gapMs: 0, stateFile: path.join(scratch, 'runner-schedule.json'),
     getConfig: () => ({ enabled: true, time: '10:00', timezone: 'Asia/Shanghai' }), now: () => now,
     onEnqueue: batch => jobs.push(batch.source) });
   assert.equal(runner.scheduleTick().scheduled, false);
   now = new Date('2026-11-24T02:00:00.000Z');
   const configured = runner.configure({ enabled: true, time: '10:00', timezone: 'Asia/Shanghai' });
   assert.equal(configured.enabled, true);
   assert.equal(runner.scheduleTick().scheduled, true);
   await runner.waitForIdle();
   assert.deepEqual(jobs, ['schedule']);
   assert.equal(runner.scheduleTick().scheduled, false);
   now = new Date('2026-11-25T02:00:00.000Z');
   assert.equal(runner.scheduleTick().scheduled, true);
   await runner.waitForIdle();
   assert.deepEqual(jobs, ['schedule','schedule']);
 });
 if (!process.exitCode) console.log(`PASS Xingchi check-in runner: ${passed} cases`);
})();
