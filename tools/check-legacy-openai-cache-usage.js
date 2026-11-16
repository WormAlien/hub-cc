#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
    const server = http.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function start(script, env) {
    const child = spawn(process.execPath, [path.join(ROOT, 'routing', script)], {
        cwd: ROOT,
        env: { ...process.env, ...env, PROXY_LOG_INGEST_URL: 'disabled' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const port = Number(env.LISTEN_PORT);
    for (let attempt = 0; attempt < 80; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`${script} exited: ${output}`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(200) });
            if (response.ok) return child;
        } catch { /* wait for isolated child */ }
        await wait(25);
    }
    child.kill();
    throw new Error(`${script} did not start: ${output}`);
}

async function ask(port) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-key' },
        body: JSON.stringify({
            model: 'gpt-cache-fixture',
            max_tokens: 16,
            stream: false,
            messages: [{ role: 'user', content: 'cache fixture' }],
        }),
        signal: AbortSignal.timeout(3000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
}

(async () => {
    const scripts = [
        { file: 'freemodel-openai-proxy.js', baseEnv: 'FM_OPENAI_BASE_URL' },
        { file: 'vyceai-openai-proxy.js', baseEnv: 'VYCE_OPENAI_BASE_URL' },
    ];
    for (const item of scripts) {
        const source = fs.readFileSync(path.join(ROOT, 'routing', item.file), 'utf8');
        assert.match(source, /process\.env\.LISTEN_PORT/, `${item.file} cannot bind an isolated test port`);
        assert.ok(source.includes(`process.env.${item.baseEnv}`), `${item.file} cannot use an isolated upstream`);
    }

    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            assert.equal(body.stream, false);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'chatcmpl_cache_fixture',
                choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                usage: {
                    prompt_tokens: 1042,
                    completion_tokens: 7,
                    prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 },
                },
            }));
        });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const children = [];
    try {
        for (const item of scripts) {
            const port = await freePort();
            const env = {
                LISTEN_PORT: String(port),
                OPENAI_API_KEY: 'fixture-key',
                [item.baseEnv]: `http://127.0.0.1:${upstream.address().port}/v1`,
            };
            children.push(await start(item.file, env));
            const response = await ask(port);
            assert.deepEqual(response.usage, {
                input_tokens: 42,
                output_tokens: 7,
                cache_read_input_tokens: 900,
                cache_creation_input_tokens: 100,
            }, item.file);
        }
        console.log('legacy OpenAI cache usage: PASS');
    } finally {
        for (const child of children) {
            if (child.exitCode === null) {
                const stopped = once(child, 'exit');
                child.kill();
                await stopped;
            }
        }
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
    }
})().catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
});
