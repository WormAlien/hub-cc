#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'api-gateway-hermes-metadata-'));
const MODEL = 'agentrouter/gpt-6.1-sol';
const python = process.env.HERMES_METADATA_PYTHON;
const probe = `
import json, sys
from agent.model_metadata import get_model_context_length, fetch_endpoint_model_metadata
from agent.context_compressor import ContextCompressor
model, url, expected = sys.argv[1], sys.argv[2], int(sys.argv[3])
metadata = fetch_endpoint_model_metadata(url, force_refresh=True)[model]
assert metadata["context_length"] == expected, metadata
assert metadata["max_completion_tokens"] == 32000, metadata
resolved = get_model_context_length(model, base_url=url, provider="custom")
assert resolved == expected, (resolved, expected)
compressor = ContextCompressor(model=model, base_url=url, provider="custom", max_tokens=32000)
assert compressor.context_length == expected, compressor.context_length
assert compressor.threshold_tokens == (expected - 32000) // 2, compressor.threshold_tokens
print(json.dumps({"model": model, "context_length": resolved, "max_completion_tokens": metadata["max_completion_tokens"], "compression_threshold": compressor.threshold_tokens}))
`;

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function run(executable, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', data => { stderr += data; });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`probe exit ${code}: ${stdout}\n${stderr}`)));
    });
}

async function main() {
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const manifestPath = path.join(TMP, 'api-gateway.json');
    const backendsPath = path.join(TMP, 'backends.json');
    const metadata = { displayName: MODEL, claudeBehavesAs: 'claude-opus-5', contextTokens: 1000000, outputTokens: 32000, publishedAt: '2026-11-19T00:00:00.000Z' };
    const manifest = { version: 1, revision: 1, enabled: true, models: { [MODEL]: metadata, 'agentrouter/small-model': { ...metadata, contextTokens: 128000, outputTokens: 8192 } } };
    writeJson(manifestPath, manifest);
    writeJson(backendsPath, { version: 1, providers: { agentrouter: { backend: 'agentrouter', upstream: 'http://127.0.0.1:1', modelmap: null } } });
    const env = { ...process.env, HOME: TMP, USERPROFILE: TMP, PORT: String(port), API_GATEWAY_FILE: manifestPath, API_GATEWAY_DEFAULT_FILE: manifestPath, BACKENDS_FILE: backendsPath, ACTIVE_BACKEND_FILE: path.join(TMP, 'absent-active.json'), CLAUDE_SETTINGS_FILE: path.join(TMP, 'absent-settings.json'), ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(TMP, 'local-hop.key'), LOG_FILE: path.join(TMP, 'frontdoor.log'), TOKEN_USAGE_FILE: path.join(TMP, 'usage.jsonl') };
    const child = spawn(process.execPath, [path.join(ROOT, 'routing', 'frontdoor-proxy.js')], { cwd: path.join(ROOT, 'routing'), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const url = `http://127.0.0.1:${port}/openai/v1`;
    try {
        let response;
        for (let i = 0; i < 100; i += 1) {
            try { response = await fetch(`${url}/models`, { signal: AbortSignal.timeout(2000) }); if (response.ok) break; }
            catch { /* startup */ }
            await new Promise(resolve => setTimeout(resolve, 40));
        }
        assert.ok(response?.ok, `frontdoor startup: ${stderr}`);
        const catalog = await response.json();
        assert.equal(catalog.data.find(row => row.id === MODEL).context_length, 1000000);
        assert.equal(catalog.data.find(row => row.id === MODEL).max_output_tokens, 32000);
        assert.equal(catalog.data.find(row => row.id === 'agentrouter/small-model').context_length, 128000);
        assert.equal(catalog.data.find(row => row.id === 'agentrouter/small-model').max_output_tokens, 8192);
        console.log('PASS real frontdoor publishes exact per-model limits');
        if (python) {
            const home = path.join(TMP, 'hermes-home');
            fs.mkdirSync(home);
            fs.writeFileSync(path.join(home, 'context_length_cache.yaml'), `context_lengths:\n  "${MODEL}@${url}": 1050000\n`, 'utf8');
            console.log(await run(python, ['-c', probe, MODEL, url, '1000000'], { ...process.env, HERMES_HOME: home }));
            console.log('PASS installed Hermes resolver and compressor reconcile stale 1.05M cache to 1M');
        }
        metadata.contextTokens = 900000;
        manifest.revision += 1;
        writeJson(manifestPath, manifest);
        const changed = await (await fetch(`${url}/models`)).json();
        assert.equal(changed.data.find(row => row.id === MODEL).context_length, 900000);
        if (python) {
            console.log(await run(python, ['-c', probe, MODEL, url, '900000'], { ...process.env, HERMES_HOME: path.join(TMP, 'hermes-home') }));
            console.log('PASS fresh Hermes runtime follows changed manifest without a separate pin');
        }
        console.log('PASS catalog refresh reads owner manifest; no inference requests made');
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve));
            child.kill();
            await exited;
        }
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
