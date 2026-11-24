'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

function createXingchiModelTest({ accounts, cacheFile, baseUrl = 'https://api.xingchiapi.com/v1',
    headers = { 'User-Agent': 'claude-cli/2.1.220 (external, cli)' },
    fetchImpl = fetch, now = Date.now, timeoutMs = 60000 }) {
    const pending = new Map();
    const ttlMs = 600000;
    const account = id => {
        const row = accounts().find(a => a.id === id);
        if (!row?.api_key) throw new Error('account with API key required');
        return row;
    };
    const identity = row => crypto.createHash('sha256').update(JSON.stringify([row.id, row.api_key])).digest('hex');
    function load() {
        try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); }
        catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    }
    function read(id) {
        const row = account(id), data = load()[identity(row)] || {};
        return { accountId: id, ttlMs, results: Object.fromEntries(Object.entries(data).map(([model, result]) =>
            [model, { ...result, stale: now() - result.checkedAt >= ttlMs }])) };
    }
    async function test(id, model) {
        if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,150}$/.test(model)) throw new Error('invalid model');
        if (model.startsWith('gpt-image-')) throw new Error('text models only');
        const row = { ...account(id) }, scope = identity(row), token = JSON.stringify([scope, model]);
        if (pending.has(token)) return pending.get(token);
        const run = (async () => {
            const start = now();
            let status = 'error', httpStatus = null, error = '';
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetchImpl(`${baseUrl}/responses`, {
                    method: 'POST', signal: controller.signal,
                    headers: { ...headers, 'Content-Type': 'application/json', Authorization: `Bearer ${row.api_key}` },
                    body: JSON.stringify({ model, input: 'Reply only OK.', max_output_tokens: 64, stream: false }),
                });
                httpStatus = response.status;
                const body = await response.json();
                const text = (body.output || []).filter(o => o.type === 'message')
                    .flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text || '').join('').trim();
                if (response.ok && body.status === 'completed' && text && !body.error) status = 'ok';
                else error = String(body.error?.message || (!response.ok ? `HTTP ${httpStatus}` : 'no completed text response'));
            } catch (e) { error = controller.signal.aborted ? 'timeout' : String(e.message); }
            finally { clearTimeout(timer); }
            // Do not persist upstream bodies, credentials or request headers.
            error = error.split(row.api_key).join('[redacted]').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 240);
            const result = { status, httpStatus, error, checkedAt: now(), latencyMs: Math.max(0, now() - start) };
            const data = load();
            data[scope] = { ...(data[scope] || {}), [model]: result };
            const temp = `${cacheFile}.${process.pid}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', 'utf8');
            fs.renameSync(temp, cacheFile);
            return { ...result, stale: false };
        })();
        pending.set(token, run);
        try { return await run; } finally { pending.delete(token); }
    }
    return { read, test };
}
module.exports = { createXingchiModelTest };
