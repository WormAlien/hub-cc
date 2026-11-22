#!/usr/bin/env node
'use strict';
// Real converter + pinned Bifrost, dynamic localhost fixtures only.
// Does not install binaries, read owner keys, or call production lifecycle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const sidecar = require('../routing/lib/bifrost-sidecar.js');
const { createLocalHopAuth } = require('../routing/lib/local-hop-auth.js');
const { createTap } = require('../routing/usage-tap.js');
const MODEL = 'deepseek-v4.1-flash-1017';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
async function freePort() {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}
function request(port, pathname, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1', port, path: pathname, method: data ? 'POST' : 'GET',
            headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
            timeout: 5000,
        }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.end(data);
    });
}
async function ready(port, child) {
    for (let i = 0; i < 200; i++) {
        if (child.exitCode !== null) throw new Error('fixture child exited before readiness');
        try { if ((await request(port, '/health')).status === 200) return; } catch {}
        await wait(100);
    }
    throw new Error('fixture health timeout');
}
async function stopChild(child) {
    if (child.exitCode !== null) return;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture child did not exit')), 8000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
    });
}
(async () => {
    const expected = sidecar.expectedExecutable();
    assert.equal(sidecar.verifyFile(expected.executable, expected.artifact.sha256).ok, true,
        'requires the existing checksum-verified pinned Bifrost binary; no auto-install');
    const scratch = process.env.HERMES_TEST_SCRATCH || os.tmpdir();
    const dir = fs.mkdtempSync(path.join(scratch, 'bifrost-converter-usage-'));
    const children = [], servers = [], records = [], starts = [];
    let fixtureUsage = null;
    const data = value => 'data: ' + JSON.stringify(value) + '\n\n';
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            if (req.url.endsWith('/models')) {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ data: [{ id: MODEL, object: 'model' }] }));
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(data({ choices: [{ delta: { content: 'OK' }, finish_reason: null }] }));
            res.write(data({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
            res.write(data({ choices: [], usage: fixtureUsage }));
            res.end('data: [DONE]\n\n');
        });
    });
    servers.push(upstream);
    try {
        const upstreamPort = await listen(upstream);
        const converterPort = await freePort();
        const secretFile = path.join(dir, 'local-hop.key');
        const auth = createLocalHopAuth({ secretFile });
        const keyFile = path.join(dir, 'fixture-key.txt');
        fs.writeFileSync(keyFile, 'localhost-fixture-key\n');
        const converterConfig = path.join(dir, 'converter.json');
        fs.writeFileSync(converterConfig, JSON.stringify({
            port: converterPort, upstream: `http://127.0.0.1:${upstreamPort}/v1`,
            keyFile, providerName: 'a6api', strictToolsVision: true, localHopSecretPath: secretFile,
        }));
        const env = {};
        for (const key of ['SYSTEMROOT', 'WINDIR', 'PATH', 'COMSPEC', 'PATHEXT']) {
            if (process.env[key] !== undefined) env[key] = process.env[key];
        }
        Object.assign(env, { HOME: dir, USERPROFILE: dir, TEMP: dir, TMP: dir, PROXY_LOG_INGEST_URL: 'disabled' });
        const converter = spawn(process.execPath, [path.join(ROOT, 'routing/custom-openai-proxy.js'), converterConfig], {
            cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
        });
        children.push(converter);
        converter.stderr.resume();
        await ready(converterPort, converter);
        const legacyPort = await freePort();
        const legacyConfig = path.join(dir, 'legacy-converter.json');
        fs.writeFileSync(legacyConfig, JSON.stringify({
            port: legacyPort, upstream: `http://127.0.0.1:${upstreamPort}/v1`,
            keyFile, providerName: 'fixture', localHopSecretPath: secretFile,
        }));
        const legacy = spawn(process.execPath, [path.join(ROOT, 'routing/custom-openai-proxy.js'), legacyConfig], {
            cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
        });
        children.push(legacy);
        legacy.stderr.resume();
        await ready(legacyPort, legacy);
        let targetPort = converterPort;
        // Transport-only bridge injects fixture auth; converter and Bifrost are real.
        const bridge = http.createServer((req, res) => {
            const forwarded = http.request({
                hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method,
                headers: { ...req.headers, connection: 'close', [auth.headerName]: auth.token('keepalive-to-adapter'),
                    ...(targetPort === legacyPort ? { 'x-abuse-hub-local-exact': '1' } : {}) },
                agent: false,
            }, upstreamRes => {
                res.writeHead(upstreamRes.statusCode, { ...upstreamRes.headers, connection: 'close' });
                const tap = createTap({ method: req.method, url: req.url, status: upstreamRes.statusCode,
                    headers: upstreamRes.headers, backend: 'fixture', ua: 'hermes-agent' }, rec => records.push(rec));
                let native = '';
                upstreamRes.on('data', chunk => { if (tap) tap.chunk(chunk); native += chunk; });
                upstreamRes.on('end', () => {
                    if (tap) tap.end();
                    const start = native.split('\n').filter(line => line.startsWith('data:'))
                        .map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } })
                        .find(event => event && event.type === 'message_start');
                    if (start) starts.push(start.message.usage);
                });
                upstreamRes.on('error', () => res.destroy());
                upstreamRes.pipe(res);
            });
            forwarded.on('error', () => res.destroy());
            req.pipe(forwarded);
        });
        servers.push(bridge);
        const bridgePort = await listen(bridge);
        const port = await freePort();
        const appDir = path.join(dir, 'bifrost-runtime');
        const configPath = sidecar.writeRuntimeConfig({ appDir, baseUrl: `http://127.0.0.1:${bridgePort}` });
        const descriptor = sidecar.createServiceDescriptor({ executable: expected.executable, appDir, configPath,
            port, expectedSha256: expected.artifact.sha256, version: expected.lock.version });
        const bifrost = spawn(descriptor.executable, descriptor.args, {
            cwd: descriptor.cwd, env: { ...env, ...descriptor.env }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
        });
        children.push(bifrost);
        bifrost.stderr.resume();
        await ready(port, bifrost);
        const cases = [
            { name: 'cache-read replaces preliminary estimate', prompt: 292860, output: 501, read: 291328, write: 0 },
            { name: 'cache-write preserves all final buckets', prompt: 1042, output: 7, read: 900, write: 100 },
            { name: 'zero uncached input is not an estimate', prompt: 1000, output: 7, read: 1000, write: 0 },
            { name: 'no-cache final input replaces preliminary estimate', prompt: 42, output: 7, read: 0, write: 0 },
            { name: 'explicit zero usage stays zero', prompt: 0, output: 0, read: 0, write: 0 },
            { name: 'generic exact converter replaces preliminary estimate', prompt: 292860, output: 501, read: 291328, write: 0, genericExact: true },
        ];
        const results = [];
        for (const item of cases) {
            targetPort = item.genericExact ? legacyPort : converterPort;
            fixtureUsage = { prompt_tokens: item.prompt, completion_tokens: item.output,
                prompt_tokens_details: { cached_tokens: item.read, cache_write_tokens: item.write } };
            const before = records.length;
            const response = await request(port, '/v1/chat/completions', {
                model: 'abuse-hub/' + MODEL, stream: true, stream_options: { include_usage: true },
                messages: [{ role: 'user', content: 'stable local prefix '.repeat(1000) }], max_tokens: 1024,
            });
            assert.equal(response.status, 200, item.name + ': ' + response.text);
            const events = response.text.split('\n').filter(line => line.startsWith('data:'))
                .map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } });
            const usage = events.filter(event => event && event.usage).at(-1)?.usage;
            assert.ok(usage, 'Bifrost must return final usage');
            const zeroUsage = item.prompt + item.output === 0;
            assert.equal(records.length, before + (zeroUsage ? 0 : 1),
                'one native accounting record for nonzero usage; zero usage is not journaled');
            const rec = zeroUsage ? null : records.at(-1);
            const gross = rec ? rec.in + rec.out + rec.cr + rec.cw : 0;
            assert.equal(gross, item.prompt + item.output, 'journal equals provider final total');
            assert.equal(usage.total_tokens, gross, item.name + ': Bifrost must agree with final provider/journal usage');
            // Bifrost omits zero-valued optional counters from its JSON envelope.
            assert.equal(usage.prompt_tokens ?? 0, item.prompt, item.name + ': prompt total');
            assert.equal(usage.completion_tokens ?? 0, item.output, item.name + ': output');
            assert.equal(usage.prompt_tokens_details?.cached_tokens || 0, item.read, item.name + ': cache read');
            assert.equal(usage.prompt_tokens_details?.cache_write_tokens || 0, item.write, item.name + ': cache write');
            assert.equal(starts.at(-1).input_tokens, 0, 'start event cannot publish an unconfirmed input estimate');
            assert.match(response.text, /data: \[DONE\]/, 'stream completes normally');
            results.push({ name: item.name, gross });
            console.log('PASS ' + item.name);
        }
        fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(results, null, 2) + '\n');
        console.log(`check-bifrost-converter-usage: ${results.length} passed; ${path.join(dir, 'result.json')}`);
    } finally {
        for (const child of children.reverse()) await stopChild(child);
        for (const server of servers.reverse()) await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
