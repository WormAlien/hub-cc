#!/usr/bin/env node
/**
 * check-frontdoor.js — регресс-тест чокпоинта front-door.
 *
 * Зачем файл существует: front-door — единая точка отказа. Лёг :20100 или
 * соврал active-backend.json — лёг Claude Code целиком. При этом всё правило
 * живёт в ОДНОМ месте (writeSettings → applyFrontdoor в transparent-proxy.js),
 * и проверить его дешевле, чем ловить последствия.
 *
 * Как: поднимает ИЗОЛИРОВАННУЮ копию дашборда — свой USERPROFILE (песочница в
 * %TEMP%), свой порт, свой frontdoor.json — и дёргает POST /api/settings/apply,
 * повторяя формы записи, которые делают реальные обработчики активации.
 * Живой ~/.claude/settings.json и рабочий дашборд :8200 не задеты.
 *
 * Запуск: node tools/check-frontdoor.js     (exit 1 = чокпоинт сломан)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const PROXY = path.join(REPO, 'routing', 'transparent-proxy.js');
let PORT = null;
let FD_PORT = null;
const SANDBOX = path.join(os.tmpdir(), 'fd-check-' + process.pid);
const CLAUDE = path.join(SANDBOX, '.claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const STATE = path.join(CLAUDE, 'active-backend.json');
const REGISTRY = path.join(CLAUDE, 'backends.json');
const FD_CFG = path.join(SANDBOX, 'frontdoor.json');

const fails = [];
const ok = [];
function check(cond, msg) { (cond ? ok : fails).push(msg); }

const HELPER = (f) => `node -e "process.stdout.write(require('fs').readFileSync(require('os').homedir()+'/.claude/${f}','utf8').trim())"`;

function req(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({
            host: '127.0.0.1', port: PORT, path: urlPath, method,
            headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
            timeout: 15000,
        }, (res) => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b || '{}') }); } catch { resolve({ status: res.statusCode, json: null, raw: b }); } });
        });
        r.on('error', reject);
        r.on('timeout', () => r.destroy(new Error('timeout')));
        if (data) r.write(data);
        r.end();
    });
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const apply = (patch) => req('POST', '/__switch/api/settings/apply', { settings: patch });

function reserveLoopbackPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function stopOwned(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already exited */ }
        }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
}

async function main() {
    const dashboardReservation = await reserveLoopbackPort();
    const frontdoorReservation = await reserveLoopbackPort();
    PORT = dashboardReservation.address().port;
    FD_PORT = frontdoorReservation.address().port;
    await new Promise((resolve, reject) => dashboardReservation.close(error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => frontdoorReservation.close(error => error ? reject(error) : resolve()));
    fs.mkdirSync(CLAUDE, { recursive: true });
    const fixtureRepo = path.join(SANDBOX, 'routing');
    fs.mkdirSync(fixtureRepo, { recursive: true });
    fs.writeFileSync(path.join(fixtureRepo, 'api-gateway.default.json'), JSON.stringify({
        version: 1, revision: 1, enabled: true, models: {},
    }, null, 2) + '\n', 'utf8');
    for (const file of [
        path.join(SANDBOX, '.config', 'opencode', 'opencode.json'),
        path.join(SANDBOX, 'wiki', 'opencode.json'),
        path.join(SANDBOX, 'opencode.json'),
    ]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{\n  "provider": {}\n}\n', 'utf8');
    }
    fs.writeFileSync(SETTINGS, JSON.stringify({ model: 'claude-opus-5[1m]', env: {} }, null, 4), 'utf8');
    fs.writeFileSync(FD_CFG, JSON.stringify({ enabled: true, port: FD_PORT }), 'utf8');

    const child = spawn(process.execPath, [PROXY], {
        env: {
            ...process.env,
            USERPROFILE: SANDBOX, HOME: SANDBOX,      // os.homedir() → песочница
            SWITCHER_PORT: String(PORT),
            FRONTDOOR_CONFIG: FD_CFG,
            ABUSE_HUB_LOCAL_HOP_KEY_FILE: path.join(SANDBOX, '.secrets', 'local-hop.key'),
            API_GATEWAY_REPO_ROOT: SANDBOX,
            API_GATEWAY_WIKI_ROOT: path.join(SANDBOX, 'wiki'),
            API_GATEWAY_OPENCODE_JOURNAL: path.join(SANDBOX, 'runtime', 'opencode.txn'),
            XDG_CONFIG_HOME: path.join(SANDBOX, '.config'),
            LOG_FILE: path.join(SANDBOX, 'frontdoor.log'),        // не пишем в боевой лог прокси
            PROXY_LOG_INGEST_URL: 'http://127.0.0.1:1/none',   // не шумим в живой дашборд
            // Порты keepalive захардкожены, своих у песочницы нет. Все production
            // boot children отключены: тесту нужен только HTTP dashboard и owned front-door.
            SWITCHER_NO_BOOT_CHILDREN: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let boot = '';
    let frontdoorPid = null;
    child.stdout.on('data', d => {
        boot += d;
        const match = /front-door spawn: :\d+ \(pid (\d+)\)/.exec(d.toString());
        if (match) frontdoorPid = Number(match[1]);
    });
    child.stderr.on('data', d => boot += d);

    let ready = false;
    try {
        for (let i = 0; i < 40; i++) {
            if (child.exitCode !== null || child.signalCode !== null) break;
            try { await req('GET', '/__switch/api/status'); ready = true; break; }
            catch { await new Promise(r => setTimeout(r, 250)); }
        }
        if (!ready) throw new Error(`дашборд-песочница не поднялась: ${boot.slice(-1200)}`);

        // API Gateway routes are wired through the real dashboard server but every target is
        // inside this fixture. This proves startup recovery plus manifest/picker transaction
        // without reading or syncing the owner's client configs.
        const clientsBefore = await req('GET', '/__switch/api/api-gateway/clients');
        check(clientsBefore.status === 200 && clientsBefore.json && clientsBefore.json.claude
            && clientsBefore.json.claude.manifestRevision === 1,
            'API Gateway clients route reads the fixture manifest');
        const gatewaySave = await req('POST', '/__switch/api/api-gateway/model', {
            expectedRevision: 1,
            id: 'aipm/fixture-model',
            published: true,
            displayName: 'AIPM / Fixture Model',
            claudeBehavesAs: 'claude-opus-5',
            contextTokens: 1050000,
            outputTokens: 32000,
        });
        const savedManifest = readJson(path.join(fixtureRepo, 'api-gateway.json'));
        const savedSettings = readJson(SETTINGS);
        check(gatewaySave.status === 200 && gatewaySave.json && gatewaySave.json.revision === 2,
            'API Gateway model route commits a revision-aware fixture save');
        check(savedManifest && savedManifest.revision === 2 && savedManifest.models['aipm/fixture-model'],
            'API Gateway save writes only the fixture manifest');
        check(savedSettings && savedSettings.model === 'claude-opus-5[1m]'
            && savedSettings.modelPicker && savedSettings.modelPicker.options[0].model === 'aipm/fixture-model',
            'API Gateway save preserves current model and patches the fixture picker');
        const preview = await req('GET', '/__switch/api/api-gateway/opencode/preview');
        check(preview.status === 200 && preview.json && preview.json.targets
            && preview.json.targets.length === 3,
            'API Gateway OpenCode preview reports three fixture labels only');

        // 1. Helper-режим (conduit): ключ переезжает в состояние, helper исчезает.
        await apply({ apiKeyHelper: HELPER('cdt-active-key.txt'), env: { ANTHROPIC_BASE_URL: 'https://conduit.ozdoev.net/v1', CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '0' } });
        let s = readJson(SETTINGS), st = readJson(STATE);
        check(s.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${FD_PORT}`, 'helper-режим: base URL переписан на front-door');
        check(s.env.ANTHROPIC_AUTH_TOKEN === 'dummy', 'helper-режим: AUTH_TOKEN = dummy');
        check(!s.apiKeyHelper, 'helper-режим: apiKeyHelper снят');
        check(!s.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS, 'helper-режим: TTL снят');
        check(st && st.backend === 'conduit', `состояние: backend = conduit (было ${st && st.backend})`);
        check(st && st.upstream === 'https://conduit.ozdoev.net/v1', 'состояние: upstream = адрес шлюза как есть');
        check(st && st.keyFile === 'cdt-active-key.txt', 'состояние: ключ из helper-команды');
        check(st && st.modelmap === 'cdt-modelmap.json', 'состояние: карта тиров по префиксу ключа');

        // 1b. Реестр префиксного роутинга: активация обязана «выучить» провайдера.
        // Без этого `/model conduit/...` молча уедет на активный бэкенд, и окно будет
        // думать, что сидит на conduit, а жечь чужой баланс. Helper-режимов в BACKENDS
        // нет вовсе — они попадают в реестр ТОЛЬКО этим путём.
        const reg = readJson(REGISTRY);
        check(reg && reg.providers, 'реестр backends.json создан активацией');
        check(reg && reg.providers && reg.providers.conduit
            && reg.providers.conduit.upstream === 'https://conduit.ozdoev.net/v1',
            'реестр выучил conduit с его апстримом');
        check(reg && reg.providers && reg.providers.conduit
            && reg.providers.conduit.keyFile === 'cdt-active-key.txt',
            'реестр выучил файл ключа conduit');
        // Локальные шлюзы из BACKENDS должны быть в реестре с рождения, без активаций.
        check(reg && reg.providers && reg.providers.aipm && reg.providers.aipm.keyFile === null,
            'реестр: локальный aipm есть сразу и без keyFile (ключ инжектит keepalive)');
        check(reg && reg.aliases && reg.aliases.ap === 'aipm' && reg.aliases.ar === 'agentrouter',
            'реестр: короткие алиасы ap/ar разрешаются в полные имена');

        // 2. Повторная запись, когда base уже наш: состояние НЕ трогаем.
        const before = fs.readFileSync(STATE, 'utf8');
        await apply({ model: 'claude-opus-5[1m]' });
        check(fs.readFileSync(STATE, 'utf8') === before, 'запись не про бэкенд не затирает active-backend.json');

        // 3. Локальный апстрим (gorouter keepalive): ключ front-door НЕ инжектит.
        await apply({ env: { ANTHROPIC_BASE_URL: 'http://localhost:20156', ANTHROPIC_AUTH_TOKEN: 'dummy' } });
        st = readJson(STATE);
        check(st && st.backend === 'gorouter', `локальный: backend = gorouter (было ${st && st.backend})`);
        check(st && st.upstream === 'http://localhost:20156', 'локальный: upstream = порт keepalive');
        check(st && st.keyFile === null, 'локальный: keyFile null — ключ ставит keepalive');

        // 3b. Пятый шлюз (:20158, JustWoker). Детект локального апстрима идёт по таблице
        //     BACKENDS, поэтому забытая там запись даёт не ошибку, а `backend: unknown` —
        //     front-door принимает запрос и не знает, куда его вести: 502 на каждый вызов CC.
        await apply({ env: { ANTHROPIC_BASE_URL: 'http://localhost:20158', ANTHROPIC_AUTH_TOKEN: 'dummy' } });
        st = readJson(STATE);
        check(st && st.backend === 'justwoker', `локальный :20158: backend = justwoker (было ${st && st.backend})`);
        check(st && st.upstream === 'http://localhost:20158', 'локальный :20158: upstream = порт keepalive JustWoker');
        check(st && st.keyFile === null, 'локальный :20158: keyFile null — ключ инжектит keepalive из justwoker-active-key.txt');

        // 4. Удалённый шлюз с ключом литералом (freemodel_rotator): литерал уходит в файл.
        await apply({ apiKeyHelper: null, env: { ANTHROPIC_BASE_URL: 'https://cc.freemodel.dev', ANTHROPIC_API_KEY: 'sk-test-literal-key' } });
        st = readJson(STATE);
        s = readJson(SETTINGS);
        check(st && st.keyFile === 'fd-active-key.txt', `литерал: ключ переехал в файл (keyFile=${st && st.keyFile})`);
        check(fs.readFileSync(path.join(CLAUDE, 'fd-active-key.txt'), 'utf8') === 'sk-test-literal-key', 'литерал: файл содержит ключ');
        check(!s.env.ANTHROPIC_API_KEY, 'литерал: ANTHROPIC_API_KEY из settings.json убран');

        // 5. Официальный Claude (OAuth): не вмешиваемся вообще.
        const stBefore = fs.readFileSync(STATE, 'utf8');
        await apply({ env: { ANTHROPIC_BASE_URL: null, ANTHROPIC_AUTH_TOKEN: null, ANTHROPIC_API_KEY: null } });
        s = readJson(SETTINGS);
        check(!s.env.ANTHROPIC_BASE_URL, 'official: base URL остался пустым (front-door не навязывается)');
        check(fs.readFileSync(STATE, 'utf8') === stBefore, 'official: состояние не перезаписано');

        // 6. Детект режима: currentTarget читает состояние, пока base смотрит в :20100.
        await apply({ env: { ANTHROPIC_BASE_URL: 'http://localhost:20155', ANTHROPIC_AUTH_TOKEN: 'dummy' } });
        const status = await req('GET', '/__switch/api/status');
        check(status.json && status.json.current === 'tabi', `currentTarget по состоянию = tabi (было ${status.json && status.json.current})`);

        // 7. Инвариант [1m] не пострадал (writeSettings делает и то, и другое).
        check(readJson(SETTINGS).model === 'claude-opus-5[1m]', 'модель с суффиксом [1m] на месте');

        // 8. Выключённый тумблер = поведение как раньше.
        fs.writeFileSync(FD_CFG, JSON.stringify({ enabled: false, port: FD_PORT }), 'utf8');
        await new Promise(r => setTimeout(r, 50));
        await apply({ env: { ANTHROPIC_BASE_URL: 'http://localhost:20157', ANTHROPIC_AUTH_TOKEN: 'dummy' } });
        s = readJson(SETTINGS);
        check(s.env.ANTHROPIC_BASE_URL === 'http://localhost:20157', 'тумблер off: base URL пишется по-старому');
        const st8 = await req('GET', '/__switch/api/status');
        check(st8.json && st8.json.current === 'xpeach', `тумблер off: детект по settings.json (было ${st8.json && st8.json.current})`);
    } finally {
        await stopOwned(child);
        if (frontdoorPid) {
            try { process.kill(frontdoorPid, 'SIGTERM'); } catch { /* already exited */ }
            for (let i = 0; i < 30; i++) {
                try { process.kill(frontdoorPid, 0); }
                catch { break; }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            try { process.kill(frontdoorPid, 'SIGKILL'); } catch { /* already exited */ }
        }
        try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
    }

    if (!ok.length && !fails.length) fails.push(`дашборд-песочница не поднялась на :${PORT}`);
    for (const m of ok) console.log(`  ok   ${m}`);
    for (const m of fails) console.log(`  FAIL ${m}`);
    console.log(fails.length ? `\ncheck-frontdoor: ${fails.length} провал(ов) из ${ok.length + fails.length}` : `\ncheck-frontdoor OK (${ok.length} проверок)`);
    process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error('check-frontdoor упал:', e.message); process.exit(1); });
