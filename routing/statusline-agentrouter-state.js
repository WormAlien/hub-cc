'use strict';

const fs = require('node:fs');

const MAX_SESSIONS_BYTES = 4 * 1024 * 1024;
const MAX_KEY_BYTES = 4096;
const DEFAULT_RESET_HHMM_MSK = '20:30';
const STALE_WITHOUT_TIMESTAMP_SECONDS = 91;

function readSmallText(file, maxBytes) {
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) throw new Error('file_too_large');
    return fs.readFileSync(file, 'utf8');
}

function sessionRows(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value.sessions)) return value.sessions;
    if (Array.isArray(value.accounts)) return value.accounts;
    return Object.values(value).filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function activeKeyOf(row) {
    return typeof row.api_key === 'string' ? row.api_key
        : typeof row.apiKey === 'string' ? row.apiKey
            : typeof row.key === 'string' ? row.key
                : '';
}

function grantedFor(row) {
    const granted = finiteNumber(row.granted);
    if (granted > 0) return granted;
    const anchor = finiteNumber(row.balanceAnchor);
    if (anchor > 0) return anchor;
    return finiteNumber(row.grant) + finiteNumber(row.bonus) + finiteNumber(row.referral);
}

function resetHhmm(config) {
    const value = config && typeof config.resetHhmmMsk === 'string'
        ? config.resetHhmmMsk
        : DEFAULT_RESET_HHMM_MSK;
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (!match) return [20, 30];
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return [20, 30];
    return [hour, minute];
}

function currentResetBoundaryMs(nowMs, config) {
    const [hour, minute] = resetHhmm(config);
    const utcDay = Math.floor(nowMs / 86_400_000) * 86_400_000;
    let boundary = utcDay + (hour - 3) * 3_600_000 + minute * 60_000;
    if (boundary > nowMs) boundary -= 86_400_000;
    return boundary;
}

function summarize(rows, activeKey, config, nowMs = Date.now()) {
    const active = activeKey ? rows.find((row) => activeKeyOf(row) === activeKey) : null;
    let haveGauge = 0;
    let balance = 0;
    let percent = 0;
    let balanceAgeSeconds = -1;
    let balanceError = 0;

    if (active) {
        haveGauge = 1;
        balance = Math.max(0, finiteNumber(active.balance));
        const granted = grantedFor(active);
        percent = granted > 0 ? Math.trunc(Math.trunc(balance) * 100 / Math.trunc(granted)) : 0;
        const checkedAt = typeof active.balanceCheckedAt === 'string' ? Date.parse(active.balanceCheckedAt) : NaN;
        balanceAgeSeconds = Number.isFinite(checkedAt)
            ? Math.max(0, Math.trunc((nowMs - checkedAt) / 1000))
            : STALE_WITHOUT_TIMESTAMP_SECONDS;
        balanceError = active.balanceError ? 1 : 0;
    }

    const boundary = currentResetBoundaryMs(nowMs, config);
    let live = 0;
    let checkedIn = 0;
    for (const row of rows) {
        if (row.status === 'live') live += 1;
        const at = typeof row.checkinAt === 'string' ? Date.parse(row.checkinAt) : NaN;
        if (Number.isFinite(at) && at >= boundary) checkedIn += 1;
    }

    return {
        haveGauge,
        balance: balance.toFixed(2),
        percent,
        balanceAgeSeconds,
        balanceError,
        ready: Math.max(0, live - checkedIn),
    };
}

function readSummary(sessionsFile, activeKeyFile, configFile, nowMs = Date.now()) {
    const rows = sessionRows(JSON.parse(readSmallText(sessionsFile, MAX_SESSIONS_BYTES)));
    let activeKey = '';
    try { activeKey = readSmallText(activeKeyFile, MAX_KEY_BYTES).trim(); } catch { /* no active key */ }
    let config = {};
    try { config = JSON.parse(readSmallText(configFile, MAX_KEY_BYTES)); } catch { /* defaults */ }
    return summarize(rows, activeKey, config, nowMs);
}

function printSummary(summary) {
    process.stdout.write([
        'v1',
        summary.haveGauge,
        summary.balance,
        summary.percent,
        summary.balanceAgeSeconds,
        summary.balanceError,
        summary.ready,
    ].join('\t') + '\n');
}

if (require.main === module) {
    const [, , sessionsFile, activeKeyFile, configFile] = process.argv;
    try { printSummary(readSummary(sessionsFile, activeKeyFile, configFile)); }
    catch { process.exitCode = 1; }
}

module.exports = {
    currentResetBoundaryMs,
    readSummary,
    sessionRows,
    summarize,
};
