'use strict';

const fs = require('node:fs');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 2000;

function poolForModel(value) {
    const model = String(value || '').replace(/\s*\[[^\]]*\]\s*$/, '');
    if (/^claude[-_]opus[-_]5[-_.]5(?:$|[^0-9])/i.test(model)) return 'opus55';
    if (/^claude[-_]/i.test(model)) return 'opus';
    if (/^gpt[-_]/i.test(model)) return 'gpt';
    return null;
}

function recentLines(file) {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, MAX_BYTES);
    if (!size) return [];
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(size);
    try { fs.readSync(fd, buffer, 0, size, stat.size - size); }
    finally { fs.closeSync(fd); }
    let text = buffer.toString('utf8');
    if (stat.size > size) {
        const newline = text.indexOf('\n');
        text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-MAX_LINES);
}

function hasNewerPoolSuccess(file, pool, afterIso) {
    if (!pool || typeof afterIso !== 'string' || !afterIso) return false;
    for (const line of recentLines(file)) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || row.bk !== 'agentrouter' || typeof row.t !== 'string' || row.t <= afterIso) continue;
        if (poolForModel(row.am || row.m) === pool) return true;
    }
    return false;
}

if (require.main === module) {
    const [, , file, pool, afterIso] = process.argv;
    try { process.stdout.write(hasNewerPoolSuccess(file, pool, afterIso) ? '1\n' : '0\n'); }
    catch { process.stdout.write('0\n'); }
}

module.exports = { hasNewerPoolSuccess, poolForModel, recentLines };
