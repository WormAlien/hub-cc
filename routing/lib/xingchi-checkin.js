'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PANEL_API = 'https://xingchiapi.com/api/v1';
const MAX_LOG_LINES = 300;

function safeAccount(accounts, id) {
  const account = (accounts() || []).find(item => String(item && item.id) === String(id));
  if (!account) throw Object.assign(new Error('аккаунт не найден'), { statusCode: 404 });
  if (!account.api_key || account.status === 'dead' || account.status === 'no_key') {
    throw Object.assign(new Error('для аккаунта нет действующего API-ключа'), { statusCode: 409 });
  }
  return account;
}


function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch { return {}; }
}
function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function unwrap(data) {
  let value = data;
  if (value && typeof value === 'object' && 'data' in value) value = value.data;
  if (value && typeof value === 'object' && 'data' in value && !('status' in value)) value = value.data;
  return value;
}

function createXingchiCheckin(options = {}) {
  const accounts = options.accounts || (() => []);
  const withSession = options.withSession || (async (account, use) => use({ token: await options.getToken?.(account) }));
  const request = options.request || (async ({ url, method, headers, signal }) => {
    const response = await fetch(url, { method, headers, signal, redirect: 'error' });
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const error = new Error(data && data.message ? String(data.message) : `HTTP ${response.status}`);
      error.status = response.status;
      error.reason = data && data.reason;
      throw error;
    }
    return { status: response.status, data };
  });
  const stateFile = options.stateFile || path.join(__dirname, '..', 'runtime', 'xingchi-checkin.json');
  const now = options.now || (() => new Date());
  const log = options.log || (() => {});
  let state = readState(stateFile);
  if (!Array.isArray(state.events)) state.events = [];
  if (!state.config || typeof state.config !== 'object') state.config = { enabled: false, time: '09:00', timezone: 'Asia/Shanghai' };
  if (!state.config.timezone) state.config.timezone = 'Asia/Shanghai';
  if (typeof state.config.enabled !== 'boolean') state.config.enabled = false;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(state.config.time || ''))) state.config.time = '09:00';

  function save() { writeState(stateFile, state); }
  function note(kind, text, id = null) {
    const event = { at: now().toISOString(), kind, text: String(text).slice(0, 400), id };
    state.events.push(event);
    if (state.events.length > MAX_LOG_LINES) state.events = state.events.slice(-MAX_LOG_LINES);
    save();
    log(event);
    return event;
  }
  async function call(token, method) {
    if (typeof token !== 'string' || token.length < 20) {
      throw Object.assign(new Error('Сессия панели Xingchi недоступна: открой аккаунт кнопкой 🌐 и войди'), { statusCode: 409, reason: 'XINGCHI_LOGIN_REQUIRED' });
    }
    const response = await request({
      method,
      url: `${PANEL_API}/user/checkin`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    return unwrap(response && Object.prototype.hasOwnProperty.call(response, 'data') ? response : { data: response });
  }
  async function statusWithSession(session) {
    let token = session.token;
    let status;
    if (!token && session.refresh) {
      token = await session.refresh();
      status = await call(token, 'GET');
    } else {
      try { status = await call(token, 'GET'); }
      catch (error) {
        if (error.status !== 401 || !session.refresh) throw error;
        token = await session.refresh();
        status = await call(token, 'GET');
      }
    }
    if (!status || typeof status !== 'object' || typeof status.enabled !== 'boolean') {
      throw Object.assign(new Error('Xingchi вернул неожиданный статус чек-ина'), { statusCode: 502 });
    }
    return { status, token };
  }
  async function getStatus(id) {
    return withSession(safeAccount(accounts, id), async session => (await statusWithSession(session)).status);
  }
  async function claim(id) {
    const account = safeAccount(accounts, id);
    return withSession(account, session => claimWithSession(account, id, session));
  }
  async function claimWithSession(account, id, session) {
    const { status: before, token } = await statusWithSession(session);
    if (!before.enabled) throw Object.assign(new Error('чек-ин сейчас выключен на площадке'), { statusCode: 409 });
    const currentAccounts = accounts() || [];
    const currentAccount = currentAccounts.find(item => String(item && item.id) === String(id));
    if (currentAccount) {
      currentAccount.checkinStatus = before;
      currentAccount.checkinCheckedAt = now().toISOString();
      if (before.claimed_today) {
        currentAccount.checkinAt = currentAccount.checkinAt || currentAccount.checkinCheckedAt;
        currentAccount.checkinFrom = currentAccount.checkinFrom || 'api';
      }
      options.saveAccounts?.(currentAccounts);
    }
    if (before.claimed_today) {
      const error = Object.assign(new Error('чек-ин уже получен сегодня'), { statusCode: 409, reason: 'CHECKIN_ALREADY_CLAIMED', status: before });
      note('already', `${account.name || account.email || id}: уже получен сегодня`, id);
      throw error;
    }
    // No retry: an interrupted POST may have succeeded upstream; retry only after a fresh status read.
    const result = await call(token, 'POST');
    if (!result || typeof result !== 'object' || !result.status) {
      throw Object.assign(new Error('Xingchi не подтвердил результат Claim'), { statusCode: 502 });
    }
    const claimedStatus = result.status;
    const at = now().toISOString();
    const amount = Number(result.amount);
    const accountsNow = accounts() || [];
    const target = accountsNow.find(item => String(item && item.id) === String(id));
    if (target) {
      target.checkinAt = at;
      target.checkinFrom = 'api';
      if (Number.isFinite(amount)) target.checkinAmount = amount;
      if (Number.isFinite(Number(claimedStatus.total_count))) target.checkinTotalCount = Number(claimedStatus.total_count);
      options.saveAccounts?.(accountsNow);
    }
    note('claimed', `${account.name || account.email || id}: Claim принят${Number.isFinite(amount) ? ` (+${amount})` : ''}`, id);
    return result;
  }
  function mark(id, on) {
    const account = safeAccount(accounts, id);
    const sessions = accounts() || [];
    const target = sessions.find(item => String(item && item.id) === String(id));
    if (!target) throw Object.assign(new Error('аккаунт не найден'), { statusCode: 404 });
    if (on) {
      target.checkinAt = now().toISOString();
      target.checkinFrom = 'manual';
    } else {
      delete target.checkinAt;
      delete target.checkinFrom;
      delete target.checkinAmount;
    }
    options.saveAccounts?.(sessions);
    note(on ? 'manual' : 'unmarked', `${account.name || account.email || id}: отметка ${on ? 'поставлена' : 'снята'} вручную`, id);
    return { checkinAt: target.checkinAt || null, checkinFrom: target.checkinFrom || null };
  }
  function configure(input) {
    const time = String(input && input.time || '').trim();
    const timezone = String(input && input.timezone || '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Object.assign(new Error('время должно быть в формате ЧЧ:ММ'), { statusCode: 400 });
    if (timezone !== 'Asia/Shanghai') throw Object.assign(new Error('для Xingchi используется часовой пояс Asia/Shanghai'), { statusCode: 400 });
    state.config = { enabled: input.enabled === true, time, timezone };
    save();
    note('config', `расписание ${state.config.enabled ? `включено на ${time} ${timezone}` : 'выключено'}`);
    return { ...state.config };
  }
  function snapshot() {
    return { config: { ...state.config }, events: state.events.slice(-100), scheduleLastRun: state.scheduleLastRun || null };
  }
  function setScheduleRun(at) {
    state.scheduleLastRun = at;
    save();
  }

  return Object.freeze({ getStatus, claim, mark, configure, snapshot, setScheduleRun, note });
}

module.exports = { PANEL_API, createXingchiCheckin };
