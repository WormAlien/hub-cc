'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MAX_EVENTS = 300;
const SHANGHAI = 'Asia/Shanghai';
function createXingchiCheckinRunner(options = {}) {
  const checkin = options.checkin;
  const accounts = options.accounts || (() => []);
  const gapMs = Math.max(0, Number(options.gapMs ?? 2500));
  const stateFile = options.stateFile || path.join(__dirname, '..', 'runtime', 'xingchi-checkin-runner.json');
  const now = options.now || (() => new Date());
  const getConfig = options.getConfig || (() => state.config);
  const log = options.log || (() => {});
  const onEnqueue = options.onEnqueue || (() => {});
  let timer = null, running = false, sequence = 0, nextStart = 0;
  let idleResolve = null;
  const idleWaiters = [];
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  if (!Array.isArray(state.events)) state.events = [];
  if (!Array.isArray(state.runs)) state.runs = [];
  if (!Array.isArray(state.queue)) state.queue = [];
  if (!state.config) state.config = { enabled: false, time: '09:00', timezone: SHANGHAI };
  function save() {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }
  function event(kind, text, id = null) {
    const row = { seq: ++sequence, at: now().toISOString(), kind, text: String(text).slice(0, 400), id };
    state.events.push(row); state.events = state.events.slice(-MAX_EVENTS); save(); log(row); return row;
  }
  const accountFor = id => (accounts() || []).find(a => String(a.id) === String(id));
  function schedulePump(delay = 0) {
    if (timer || running || !state.queue.length) return;
    timer = setTimeout(() => { timer = null; void pump(); }, delay);
    if (timer.unref) timer.unref();
  }
  async function pump() {
    if (running || !state.queue.length) { if (!running && !state.queue.length) idleWaiters.splice(0).forEach(resolve => resolve()); return; }
    const delay = Math.max(0, nextStart - Date.now());
    if (delay > 0) return schedulePump(delay);
    const job = state.queue.shift();
    const run = state.runs.find(item => item.id === job.id && item.state === 'queued');
    if (!run) { save(); return schedulePump(0); }
    running = true; run.state = 'running'; run.startedAt = now().toISOString(); run.message = 'Claim выполняется';
    nextStart = Date.now() + gapMs; save(); event('started', `${run.name}: запрос отправлен`, run.id);
    try {
      const result = await checkin.claim(run.id);
      run.state = 'done'; run.finishedAt = now().toISOString(); run.amount = Number(result.amount);
      run.status = result.status || null; run.message = `Claim принят${Number.isFinite(run.amount) ? ` (+${run.amount})` : ''}`;
      const account = accountFor(run.id);
      if (account) { account.checkinStatus = run.status; account.checkinCheckedAt = run.finishedAt; }
      event('claimed', `${run.name}: ${run.message}`, run.id);
    } catch (error) {
      run.state = 'error'; run.finishedAt = now().toISOString(); run.reason = error.reason || null;
      run.message = error.message || 'Claim failed'; event('failed', `${run.name}: ${run.message}`, run.id);
    } finally { running = false; save(); schedulePump(Math.max(0, nextStart - Date.now())); if (!state.queue.length) idleWaiters.splice(0).forEach(resolve => resolve()); }
  }
  function enqueue(ids, source = 'manual') {
    const selected = Array.isArray(ids) ? ids : (accounts() || []).map(a => a.id);
    const busy = new Set([...state.queue.map(job => String(job.id)), ...state.runs.filter(run => run.state === 'running').map(run => String(run.id))]);
    const eligible = [];
    const skipped = [];
    for (const id of selected) {
      const account = accountFor(id);
      if (!account) { skipped.push({ id, reason: 'аккаунт не найден' }); continue; }
      if (!account.api_key || account.status === 'dead' || account.status === 'no_key') { skipped.push({ id, reason: 'нет действующего ключа' }); continue; }
      if (busy.has(String(id))) { skipped.push({ id, reason: 'уже в очереди/выполняется' }); continue; }
      eligible.push(account); busy.add(String(id));
    }
    for (const account of eligible) {
      const run = { id: String(account.id), name: account.name || account.email || String(account.id), state: 'queued', source, queuedAt: now().toISOString(), message: 'в очереди' };
      state.runs.push(run); state.queue.push({ id: run.id, source });
    }
    state.runs = state.runs.slice(-MAX_EVENTS); save();
    if (eligible.length) { event('queued', `${eligible.length} аккаунтов добавлено в очередь`, null); onEnqueue({ source, ids: eligible.map(a => String(a.id)), queued: eligible.length }); schedulePump(Math.max(0, nextStart - Date.now())); }
    return { queued: eligible.length, ready: eligible.length, skipped };
  }
  function cancel() {
    const canceled = [];
    for (const job of state.queue.splice(0)) {
      const run = state.runs.find(item => item.id === job.id && item.state === 'queued');
      if (run) { run.state = 'cancelled'; run.finishedAt = now().toISOString(); run.message = 'снято с очереди'; canceled.push(run.id); }
    }
    save(); if (canceled.length) event('cancelled', `снято заданий: ${canceled.length}`);
    return { cancelled: canceled.length, killed: 0 };
  }
  function localDateTime(date) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: SHANGHAI, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
  }
  function configure(config) {
    const time = String(config && config.time || '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Object.assign(new Error('время должно быть в формате ЧЧ:ММ'), { statusCode: 400 });
    if (config.timezone !== SHANGHAI) throw Object.assign(new Error('Xingchi поддерживает Asia/Shanghai'), { statusCode: 400 });
    state.config = { enabled: config.enabled === true, time, timezone: SHANGHAI }; save(); event('config', state.config.enabled ? `расписание включено: ${time} ${SHANGHAI}` : 'расписание выключено'); return { ...state.config };
  }
  function scheduleTick() {
    const config = getConfig() || state.config || {};
    if (config.enabled !== true || config.timezone !== SHANGHAI) return { scheduled: false, reason: 'disabled' };
    const local = localDateTime(now());
    if (local.time !== config.time || state.scheduleLastRunDate === local.date) return { scheduled: false };
    const result = enqueue((accounts() || []).map(a => a.id), 'schedule');
    state.scheduleLastRunDate = local.date; state.scheduleLastRunAt = now().toISOString(); save();
    event('scheduled', `суточный запуск ${local.date}: ${result.queued} аккаунтов поставлено`);
    return { scheduled: true, ...result };
  }
  function snapshot() { return { config: { ...state.config }, runs: state.runs.slice(-100).map(run => ({ ...run })), events: state.events.slice(-100).map(row => ({ ...row })), batch: { queued: state.queue.length, running: running ? 1 : 0 }, scheduleLastRun: state.scheduleLastRunAt || null }; }
  async function waitForIdle(timeoutMs = 10000) { if (!running && !state.queue.length) return; await Promise.race([new Promise(resolve => idleWaiters.push(resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('check-in runner did not become idle')), timeoutMs))]); }
  return Object.freeze({ enqueue, cancel, configure, scheduleTick, snapshot, waitForIdle, note: event });
}
module.exports = { createXingchiCheckinRunner };
