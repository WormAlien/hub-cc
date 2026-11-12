#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OPENCODE = process.env.OPENCODE_EXE
    || path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
const MODEL = 'abuse-hub/agentrouter/gpt-5.6-sol';
const PUBLIC_MODEL = 'agentrouter/gpt-5.6-sol';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-opencode-real-'));
const HOME = path.join(TMP, 'home');
const XDG = path.join(TMP, 'xdg');
const WORK = path.join(TMP, 'work');
const CONFIG = path.join(XDG, 'opencode', 'opencode.json');
const requests = [];
const allHits = [];
const servers = [];

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise(resolve => server.close(() => resolve()));
}

function collect(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > 1024 * 1024) return reject(new Error('request body too large'));
            chunks.push(chunk);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch { reject(new Error('invalid request JSON')); }
        });
        req.on('error', reject);
    });
}

function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
}

function chatResponse(model, content, toolCalls, finishReason = 'stop') {
    return {
        id: `chatcmpl-${requests.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
            finish_reason: finishReason,
        }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    };
}

function streamResponse(res, model, content, toolCalls, finishReason = 'stop') {
    const id = `chatcmpl-${requests.length}`;
    const created = Math.floor(Date.now() / 1000);
    const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    send({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
    if (toolCalls) {
        send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }, finish_reason: null }],
        });
    } else if (content) {
        send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
        });
    }
    send({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    });
    send({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
    res.end('data: [DONE]\n\n');
}

function respondChat(res, body, content, toolCalls, finishReason = 'stop') {
    if (body.stream === true) return streamResponse(res, body.model, content, toolCalls, finishReason);
    return json(res, 200, chatResponse(body.model, content, toolCalls, finishReason));
}

function spawnOpenCode(message) {
    const args = [
        'run', message,
        '--pure',
        '--title', 'api-gateway-fixture',
        '--format', 'json',
        '--model', MODEL,
        '--dir', WORK,
    ];
    const child = spawn(OPENCODE, args, {
        cwd: WORK,
        env: {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            PATH: process.env.PATH,
            TEMP: TMP,
            TMP,
            HOME,
            USERPROFILE: HOME,
            XDG_CONFIG_HOME: XDG,
            XDG_DATA_HOME: path.join(TMP, 'data'),
            XDG_CACHE_HOME: path.join(TMP, 'cache'),
            XDG_STATE_HOME: path.join(TMP, 'state'),
            OPENCODE_CONFIG: CONFIG,
            OPENCODE_CONFIG_DIR: path.join(TMP, 'config-dir'),
            OPENCODE_DISABLE_AUTOUPDATE: 'true',
            OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
            OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
            OPENCODE_DISABLE_CLAUDE_CODE: 'true',
            OPENCODE_DISABLE_MODELS_FETCH: 'true',
            OPENCODE_DISABLE_TERMINAL_TITLE: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    return new Promise((resolve, reject) => {
        const terminateOwned = () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            if (process.platform === 'win32') {
                spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
            } else {
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
            }
        };
        const timer = setTimeout(() => {
            terminateOwned();
            const compact = requests.slice(-5).map(row => ({
                url: row.url,
                model: row.body.model,
                stream: row.body.stream,
                roles: (row.body.messages || []).map(message => message.role),
                lastContent: String((row.body.messages || []).at(-1)?.content || '').slice(0, 300),
                toolNames: (row.body.tools || []).map(tool => tool.function && tool.function.name).filter(Boolean),
            }));
            reject(new Error(`OpenCode timeout; hitCount=${allHits.length} requests=${JSON.stringify(compact)}\n${stderr.slice(-2000)}\n${stdout.slice(-2000)}`));
        }, 60000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

function events(result) {
    assert.equal(result.code, 0, `OpenCode exit ${result.code}/${result.signal}: ${result.stderr}\n${result.stdout}`);
    const rows = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert.ok(rows.length > 0, 'OpenCode emitted no JSONL events');
    return rows;
}

(async () => {
    let server;
    try {
        fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
        fs.mkdirSync(path.join(TMP, 'config-dir'), { recursive: true });
        fs.mkdirSync(WORK, { recursive: true });
        server = http.createServer(async (req, res) => {
            allHits.push({ method: req.method, url: req.url });
            if (req.method === 'GET' && req.url === '/v1/models') {
                return json(res, 200, { object: 'list', data: [{ id: PUBLIC_MODEL, object: 'model', owned_by: 'abuse-hub' }] });
            }
            if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
                return json(res, 404, { error: { message: 'fixture route not found' } });
            }
            let body;
            try { body = await collect(req); }
            catch (error) { return json(res, 400, { error: { message: error.message } }); }
            requests.push({ url: req.url, body });
            const toolResult = (body.messages || []).find(message => message.role === 'tool');
            if (toolResult) {
                const value = String(toolResult.content);
                return respondChat(res, body, value.includes('READ_ONLY_FIXTURE')
                    ? 'TOOL_LOOP_OK:READ_ONLY_FIXTURE'
                    : 'TOOL_LOOP_BAD_RESULT');
            }
            const userText = String((body.messages || []).filter(message => message.role === 'user').at(-1)?.content || '');
            const wantsTool = /use the read tool/i.test(userText)
                && Array.isArray(body.tools)
                && body.tools.some(tool => tool.function && tool.function.name === 'read');
            if (wantsTool) {
                return respondChat(res, body, null, [{
                    id: 'call_read_fixture',
                    type: 'function',
                    function: { name: 'read', arguments: JSON.stringify({ filePath: path.join(WORK, 'fixture.txt') }) },
                }], 'tool_calls');
            }
            return respondChat(res, body, 'TEXT_OK');
        });
        servers.push(server);
        const port = await listen(server);
        fs.writeFileSync(path.join(WORK, 'fixture.txt'), 'READ_ONLY_FIXTURE', 'utf8');
        fs.writeFileSync(CONFIG, JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            permission: { '*': 'deny', read: 'allow' },
            provider: {
                'abuse-hub': {
                    npm: '@ai-sdk/openai-compatible',
                    name: 'ABUSE HUB',
                    options: {
                        baseURL: `http://127.0.0.1:${port}/v1`,
                        apiKey: 'dummy',
                        timeout: 600000,
                    },
                    models: {
                        [PUBLIC_MODEL]: { name: 'AgentRouter / GPT 5.6 Sol' },
                    },
                },
            },
        }, null, 2) + '\n', 'utf8');

        const textEvents = events(await spawnOpenCode('Reply with exactly TEXT_OK and do not use tools.'));
        const textEventsJson = JSON.stringify(textEvents);
        assert.ok(textEventsJson.includes('TEXT_OK'), `text response did not reach OpenCode JSON events: ${textEventsJson}`);
        const afterText = requests.length;
        assert.equal(afterText, 1, `text run used ${afterText} chat requests`);

        const toolEvents = events(await spawnOpenCode('Use the read tool on fixture.txt, then reply exactly TOOL_LOOP_OK:READ_ONLY_FIXTURE.'));
        const toolJson = JSON.stringify(toolEvents);
        assert.ok(toolJson.includes('call_read_fixture') || toolJson.includes('read'), 'tool call event is missing');
        assert.ok(toolJson.includes('TOOL_LOOP_OK:READ_ONLY_FIXTURE'), 'tool-result response is missing');
        const toolRequests = requests.slice(afterText);
        assert.equal(toolRequests.length, 2, `tool loop used ${toolRequests.length} chat requests`);
        assert.ok(toolRequests[1].body.messages.some(message => message.role === 'tool'
            && String(message.content).includes('READ_ONLY_FIXTURE')), 'read-only tool result did not return to the endpoint');
        assert.ok(requests.every(row => row.url === '/v1/chat/completions'), 'more than one inference endpoint was used');
        assert.ok(requests.every(row => row.body.model === PUBLIC_MODEL), 'OpenCode sent a wrong model ID');
        assert.deepEqual([...new Set(allHits.map(row => row.url))], ['/v1/chat/completions'],
            `unexpected endpoint: ${JSON.stringify(allHits)}`);
        assert.equal(allHits.some(row => /title/i.test(row.url)), false, 'a title endpoint was called');
        console.log(`check-api-gateway-opencode-real: PASS (${requests.length} chat calls, one inference endpoint, text + tool-result loop)`);
    } finally {
        await Promise.all(servers.map(item => close(item)));
        let lastCleanupError = null;
        for (let attempt = 0; attempt < 80; attempt += 1) {
            try {
                fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
                lastCleanupError = null;
                break;
            } catch (error) {
                lastCleanupError = error;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        if (lastCleanupError) throw lastCleanupError;
    }
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
